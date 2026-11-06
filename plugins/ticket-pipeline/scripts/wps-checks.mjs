/**
 * 第 11 节自测：金山文档（WPS）适配器 —— 现场造 xlsx，离线解析，不联网。
 *
 * 为什么自己**造**一份 xlsx 而不是放一个样例文件进仓库：
 * 1. 样例是二进制，人看不出它到底断言了什么；造出来的每一格都对应下面一条断言，读脚本就等于读规格。
 * 2. 零依赖约束下没有打包工具，改样例得靠外部工具，而改这里只要改几行 XML 字符串。
 * 3. 真实问题表会不断变，永远追不上；这里只固定**契约**：表头映射、锚点归属、坏文件报错。
 *
 * 覆盖的承诺：
 * - 零依赖解 xlsx（stored 与 deflate 两种压缩方式都要能读）
 * - 表头在前几行里自动定位，中文列名 → 工单字段
 * - 截图按 `drawing` 锚点挂到正确行，且同一行的多张图按出现顺序排
 * - 收票只认「是否处理 = 处理中」，水位语义与飞书源一致（指纹只在收进 updated 时推进）
 * - 取数通道没配时报清楚的错，而不是返回空表
 * - 取数通道的超时 / 取消 / 字节上限 / 重定向逐跳校验（假 fetch 注入，不联网）
 * - 坏文件（不是 zip / 缺工作表 / 没有描述列）报 invalid-input
 * - 绝不写回表格（这个适配器只有读，断言它连可选写接口都没挂）
 */

import assert from 'node:assert/strict'
import { crc32, deflateRawSync } from 'node:zlib'

import {
  createWpsSource,
  DEFAULT_SHEET_MAX_BYTES,
  DEFAULT_SHEET_TIMEOUT_MS,
  downloadSheetLimited,
  IN_PROGRESS_VALUE,
  MAX_SHEET_REDIRECTS,
  wpsOptionsFromMatch,
} from '../src/adapters/source-wps/index.js'
import {
  makeMediaToken,
  mediaTypeOf,
  normalizeDateCell,
  normalizePriority,
  parseWpsWorkbook,
} from '../src/adapters/source-wps/xlsx.js'
import { readZipEntries } from '../src/adapters/source-wps/zip.js'

/** 一张 8×8 PNG 的头 + 少量数据：够当图片字节，也够让`size`不为 0。 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
])

/** 第二张图用不同的内容，用来验证「同一行的两张图不会合并成一张」。 */
const PNG_BYTES_2 = new Uint8Array([...PNG_BYTES, 0x7f, 0x7f, 0x7f])

// ── 造 zip ──────────────────────────────────────────────────

/**
 * 造一个最小的 zip。
 *
 * `compress: true` 时用 deflate（method 8），否则 stored（method 0）：
 * 两种都要测 —— 真实 xlsx 里 XML 一律被压缩，而有些导出工具会把图片原样存。
 *
 * @param {Array<{ name: string, data: string | Uint8Array, compress?: boolean }>} files
 * @returns {Uint8Array}
 */
function makeZip (files) {
  const encoder = new TextEncoder()
  const locals = []
  const centrals = []
  let offset = 0

  for (const file of files) {
    const raw = typeof file.data === 'string' ? encoder.encode(file.data) : file.data
    const compressed = file.compress ? new Uint8Array(deflateRawSync(raw)) : raw
    const method = file.compress ? 8 : 0
    const nameBytes = encoder.encode(file.name)
    const checksum = crc32(raw) >>> 0
    const local = new Uint8Array(30 + nameBytes.length + compressed.length)
    const dv = new DataView(local.buffer)
    dv.setUint32(0, 0x04034b50, true)
    dv.setUint16(4, 20, true)
    dv.setUint16(6, 0, true)
    dv.setUint16(8, method, true)
    dv.setUint32(14, checksum, true)
    dv.setUint32(18, compressed.length, true)
    dv.setUint32(22, raw.length, true)
    dv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(compressed, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0, true)
    cv.setUint16(10, method, true)
    cv.setUint32(16, checksum, true)
    cv.setUint32(20, compressed.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    centrals.push(central)
    offset += local.length
  }

  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const total = offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let cursor = 0
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, cursor)
    cursor += part.length
  }
  return out
}

// ── 造一份「问题记录表」 ────────────────────────────────────

/** 表头（第 2 行）：故意在它上面留一行标题，验证「表头自动定位」。 */
const HEADER = ['序号', '待修改项目', '问题描述', '操作流程', '截图', '是否处理', '发现部门', '发现日期', '优先级']

/**
 * 造一份最小 xlsx。
 *
 * @param {Object} [options]
 * @param {Array<Record<string, string>>} [options.rows] 数据行（键是上面 HEADER 里的列名）
 * @param {Array<{ row: number, media: string }>} [options.anchors] 图片锚点：第 row 行（1 基）挂哪张图
 * @param {boolean} [options.compress] XML 是否 deflate
 * @param {boolean} [options.withDrawing] 是否带绘图部件
 * @returns {Uint8Array}
 */
function makeProblemWorkbook (options = {}) {
  const rows = options.rows ?? DEFAULT_ROWS
  const anchors = options.anchors ?? [{ row: 3, media: 'xl/media/image1.png' }]
  const compress = options.compress ?? true
  const withDrawing = options.withDrawing ?? true

  const files = [
    {
      name: 'xl/workbook.xml',
      compress,
      data: '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="问题记录表" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      compress,
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships>' +
        '<Relationship Id="rId1" Type=".../worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    { name: 'xl/worksheets/sheet1.xml', compress, data: makeSheetXml(rows, withDrawing ? anchors.length > 0 : false) },
    { name: 'xl/sharedStrings.xml', compress, data: makeSharedStrings(rows) },
  ]

  if (withDrawing) {
    files.push({
      name: 'xl/worksheets/_rels/sheet1.xml.rels',
      compress,
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships>' +
        '<Relationship Id="rId1" Type=".../drawing" Target="../drawings/drawing1.xml"/></Relationships>',
    })
    files.push({ name: 'xl/drawings/drawing1.xml', compress, data: makeDrawingXml(anchors) })
    files.push({
      name: 'xl/drawings/_rels/drawing1.xml.rels',
      compress,
      data: '<?xml version="1.0" encoding="UTF-8"?><Relationships>' +
        anchors.map((anchor, index) => '<Relationship Id="rId' + (index + 1) + '" Type=".../image" Target="../media/' +
          anchor.media.slice(anchor.media.lastIndexOf('/') + 1) + '"/>').join('') +
        '</Relationships>',
    })
    const seen = new Set()
    for (const anchor of anchors) {
      if (seen.has(anchor.media)) continue
      seen.add(anchor.media)
      files.push({ name: anchor.media, data: anchor.media.endsWith('image2.png') ? PNG_BYTES_2 : PNG_BYTES });
    }
  }

  return makeZip(files)
}

/** 默认的三行数据：两行处理中（要收，r3/r4）、一行「是」（已闭环，不收，r5）。 */
const DEFAULT_ROWS = [
  { 序号: '1', 待修改项目: '日报系统', 问题描述: '导出报表时表头错位', 操作流程: '首页 → 导出 → 选 Excel', 是否处理: '处理中', 发现部门: '运营部', 发现日期: '2026/11/1', 优先级: '高' },
  { 序号: '2', 待修改项目: '日报系统', 问题描述: '登录页文案有错别字', 操作流程: '打开登录页', 是否处理: '处理中', 发现部门: '客服部', 发现日期: '2026/11/2', 优先级: '低' },
  { 序号: '3', 待修改项目: '日报系统', 问题描述: '头像上传后不刷新', 操作流程: '个人中心 → 换头像', 是否处理: '是', 发现部门: '产品部', 发现日期: '2026/10/30', 优先级: '中' },
]

/**
 * 造工作表 XML。
 *
 * 布局：第 1 行是标题（合并单元格那种），第 2 行才是表头，数据从第 3 行开始 ——
 * 真实问题表几乎都长这样，也是「表头自动定位」必须存在的理由。
 *
 * @param {Array<Record<string, string>>} rows
 * @param {boolean} withDrawing
 * @returns {string}
 */
function makeSheetXml (rows, withDrawing) {
  const strings = []
  const cells = []

  cells.push('<row r="1">' + inlineCell('A1', '问题记录表（内部）') + '</row>')
  cells.push('<row r="2">' + HEADER.map((title, index) => shareCell(columnName(index) + '2', strings, title)).join('') + '</row>')
  rows.forEach((row, index) => {
    const rowNumber = index + 3
    cells.push('<row r="' + rowNumber + '">' + HEADER.map((title, column) => {
      const value = row[title]
      // 「发现日期」故意写成数字序列号：真实表里日期是数字格式，不是文本。
      if (title === '发现日期' && value === '2026/11/1') return numberCell(columnName(column) + rowNumber, 46327)
      if (value === undefined) return ''
      return shareCell(columnName(column) + rowNumber, strings, value)
    }).join('') + '</row>')
  })

  const drawing = withDrawing ? '<drawing r:id="rId1"/>' : ''
  return '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData>' + cells.join('') + '</sheetData>' + drawing + '</worksheet>'
}

/**
 * 造共用的字符串表。
 *
 * 为什么这里和 `makeSheetXml` 各维护一份数组：sheet 的单元格要按「第几号字符串」引用，
 * 而字符串表的顺序必须和引用顺序一致。两边都按`HEADER`的出现顺序追加，所以对得上。
 *
 * @param {Array<Record<string, string>>} rows
 * @returns {string}
 */
function makeSharedStrings (rows) {
  const all = []
  for (const title of HEADER) all.push(title)
  for (const row of rows) {
    for (const title of HEADER) {
      const value = row[title]
      if (value === undefined) continue
      if (title === '发现日期' && value === '2026/11/1') continue
      // 与 shareCell 同构：shareCell 用 indexOf 去重后按下标引用，这里也必须去重，
      // 否则两半算出的下标对不上，读出来的列整体错位（真发生过：r4 的「是否处理」读成了「打开登录页」）。
      if (!all.includes(value)) all.push(value)
    }
  }
  return '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + all.length + '" uniqueCount="' + all.length + '">' +
    all.map((text) => '<si><t>' + escapeXml(text) + '</t></si>').join('') + '</sst>'
}

/**
 * 造绘图 XML：每个锚点一张图。
 *
 * 故意混用 `twoCellAnchor` 与 `oneCellAnchor`：两者在真实文件里都会出现
 * （WPS 贴图默认 twoCell，从别处拖进来常是 oneCell），归属规则必须一样。
 *
 * @param {Array<{ row: number, media: string }>} anchors row 是 1 基行号
 * @returns {string}
 */
function makeDrawingXml (anchors) {
  const body = anchors.map((anchor, index) => {
    const tag = index % 2 === 0 ? 'twoCellAnchor' : 'oneCellAnchor'
    return '<xdr:' + tag + '><xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff>' +
      '<xdr:row>' + (anchor.row - 1) + '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
      '<xdr:to><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>' + anchor.row + '</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>' +
      '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="' + (index + 1) + '" name="图片 ' + (index + 1) + '"/></xdr:nvPicPr>' +
      '<xdr:blipFill><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId' + (index + 1) + '"/></xdr:blipFill>' +
      '</xdr:pic><xdr:clientData/></xdr:' + tag + '>'
  }).join('')
  return '<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing">' + body + '</xdr:wsDr>'
}

/** `0` → `A`，26 → `AA`。 */
function columnName (index) {
  let name = ''
  let n = index + 1
  while (n > 0) {
    const rest = (n - 1) % 26
    name = String.fromCharCode(65 + rest) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

/** 共享字符串单元格：先登记进 strings，再写下标。 */
function shareCell (reference, strings, text) {
  let index = strings.indexOf(text)
  if (index < 0) {
    index = strings.length
    strings.push(text)
  }
  return '<c r="' + reference + '" t="s"><v>' + index + '</v></c>'
}

/** 内联字符串单元格（不经过 sharedStrings 的那条路）。 */
function inlineCell (reference, text) {
  return '<c r="' + reference + '" t="inlineStr"><is><t>' + escapeXml(text) + '</t></is></c>'
}

/** 数字单元格。 */
function numberCell (reference, value) {
  return '<c r="' + reference + '"><v>' + value + '</v></c>'
}

function escapeXml (text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── 假 fetch：不联网地验证取数通道的坏情况 ────────────────────────

/**
 * 假响应体。返回的 `state` 记录「实际被读走几块 / 有没有被取消」。
 *
 * 为什么要记这两件事：只断言「抛了错」太便宜了 —— 一句 `throw` 就能让断言通过，
 * 而这次要修的是「超限之后还在继续读」。`reads` 与 `cancelled` 才是真正的证据。
 */
function fakeBody (chunks) {
  const state = { reads: 0, cancelled: false, finished: false }
  return {
    state,
    body: {
      getReader () {
        let index = 0
        return {
          async read () {
            if (index >= chunks.length) {
              state.finished = true
              return { done: true, value: undefined }
            }
            const value = chunks[index]
            index += 1
            state.reads += 1
            return { done: false, value }
          },
          async cancel () {
            state.cancelled = true
          },
        }
      },
    },
  }
}

/**
 * 假响应：状态码 + 响应头 + 分块响应体。`arrayBuffer()` 也实现了，
 * 免得断言「没有流式 body 的老实现」时还要另写一份桩。
 */
function fakeResponse ({ status = 200, headers = {}, chunks } = {}) {
  const fake = chunks === undefined ? null : fakeBody(chunks)
  return {
    state: fake ? fake.state : null,
    response: {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
      body: fake ? fake.body : undefined,
      async arrayBuffer () {
        const list = chunks ?? []
        const out = new Uint8Array(list.reduce((total, chunk) => total + chunk.byteLength, 0))
        let offset = 0
        for (const chunk of list) {
          out.set(chunk, offset)
          offset += chunk.byteLength
        }
        return out.buffer
      },
    },
  }
}

/**
 * 造一个「永远不 settle，直到 signal 被中止」的假 fetch —— 真 fetch 就是这么表现的。
 *
 * 里面那个 `keepAlive` 定时器不是装饰：`AbortSignal.timeout()` 用的定时器是 **unref'd**
 * 的（Node 特意这样设计，免得一个超时信号拖住进程退出）。假 fetch 又没有真 socket
 * 可挂，于是「一个永不 settle 的 Promise + 一个不吊住事件循环的定时器」= 事件循环提前
 * 变空 = node 直接 exit 0 **静默退出**，断言根本没跑完，dev-run 看起来还是「全绿」。
 * 真 fetch 有 socket 句柄吊着循环，所以生产代码里没这个坑 —— 只会在测试桩上踩到。
 */
function hangingFetch () {
  return (url, init) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 60_000)
    init.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive)
      reject(init.signal.reason)
    }, { once: true })
  })
}

// ── 断言 ────────────────────────────────────────────────────

/**
 * 跑第 11 节的全部断言。
 *
 * @param {(name: string, fn: () => Promise<void> | void) => Promise<void>} check dev-run 传进来的 check
 */
export async function runWpsChecks (check) {
  const bytes = makeProblemWorkbook()

  await check('xlsx 是 zip：能读出目录表，deflate 与 stored 两种条目都能解', async () => {
    const entries = readZipEntries(bytes)
    const names = entries.map((entry) => entry.name)
    for (const expected of ['xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml', 'xl/drawings/drawing1.xml']) {
      assert.ok(names.includes(expected), '目录里应该有 ' + expected + '，实际：' + names.join(' / '))
    }
    // 图片是 stored，XML 是 deflate —— 两种方法都要真的解开，否则后面全是空字符串
    const stored = makeProblemWorkbook({ compress: false })
    const parsed = parseWpsWorkbook({ bytes: stored })
    // 解析器回**全表**记录（收「处理中」的过滤在适配器 scan，不在解析器）——
    // 所以这里断言 stored 与 deflate 的解析结果完全一致（默认数据 3 行：r3/r4 处理中 + r5 是）。
    const deflated = parseWpsWorkbook({ bytes })
    assert.deepEqual(
      parsed.records.map((r) => [r.recordId, r.status, r.description]),
      deflated.records.map((r) => [r.recordId, r.status, r.description]),
      'stored 版本的解析结果必须和 deflate 版一致')
    assert.equal(parsed.records.length, 3)
  })

  await check('表头自动定位：标题行在上、表头在第 2 行，仍能认出中文列名', async () => {
    const parsed = parseWpsWorkbook({ bytes })
    assert.equal(parsed.headerRowIndex, 2, '表头在第 2 行，实际' + parsed.headerRowIndex)
    assert.equal(parsed.sheetName, '问题记录表', '表名应该来自 workbook.xml')
  })

  await check('字段映射：中文表头 → 内部字段，日期序列号与优先级都要归一', async () => {
    const parsed = parseWpsWorkbook({ bytes })
    const row = parsed.records.find((item) => item.description === '导出报表时表头错位')
    assert.ok(row, '应该解析出第一行工单，实际：' + parsed.records.map((r) => r.description).join(' / '))
    assert.equal(row.seq, '1')
    assert.equal(row.projectId, '日报系统', '「待修改项目」→ projectId')
    assert.equal(row.flow, '首页 → 导出 → 选 Excel', '「操作流程」→ flow')
    assert.equal(row.status, '处理中', '「是否处理」→ status')
    assert.equal(row.department, '运营部', '「发现部门」→ department')
    assert.equal(row.module, undefined, '表里没有「模块」列，不该凭空造字段')
    assert.equal(row.foundAt, '2026-11-01', '46327 是 Excel 序列号，要换算成日期而不是原样保留')
    assert.equal(row.priority, 'high', '「高」→ high')
  })

  await check('只收有内容的行：空行与标题行不会变成空工单', async () => {
    const parsed = parseWpsWorkbook({ bytes })
    assert.equal(parsed.records.length, 3, '三行数据就三条记录（标题行不算），实际 ' + parsed.records.length)
    assert.ok(parsed.records.every((item) => item.description.length > 0), '每条记录都得有描述')
  })

  await check('截图按锚点挂到正确行：第 3 行的图不会跑到第 4 行', async () => {
    const withShots = makeProblemWorkbook({
      anchors: [
        { row: 3, media: 'xl/media/image1.png' },
        { row: 4, media: 'xl/media/image2.png' },
      ],
    })
    const parsed = parseWpsWorkbook({ bytes: withShots })
    const third = parsed.records.find((item) => item.rowIndex === 3)
    const fourth = parsed.records.find((item) => item.rowIndex === 4)
    assert.deepEqual(third.screenshotTokens, [makeMediaToken('wps-media', 'xl/media/image1.png')], '第 3 行应该只挂 image1')
    assert.deepEqual(fourth.screenshotTokens, [makeMediaToken('wps-media', 'xl/media/image2.png')], '第 4 行应该只挂 image2')
    assert.equal(parsed.media.size, 2, '两张不同的图必须各占一个 token —— 只按文件名去重会把它们合并')
    const first = parsed.media.get(makeMediaToken('wps-media', 'xl/media/image1.png'))
    assert.equal(first.mediaType, 'image/png')
    assert.equal(first.name, 'image1.png')
    assert.equal(first.data.length, PNG_BYTES.length, '取出来的字节必须是原图，不能是解压后的变形')
  })

  await check('同一行贴两张图：按出现顺序全留下，且不会互相覆盖', async () => {
    const withShots = makeProblemWorkbook({
      anchors: [
        { row: 3, media: 'xl/media/image1.png' },
        { row: 3, media: 'xl/media/image2.png' },
      ],
    })
    const parsed = parseWpsWorkbook({ bytes: withShots })
    const third = parsed.records.find((item) => item.rowIndex === 3)
    assert.deepEqual(third.screenshotTokens, [
      makeMediaToken('wps-media', 'xl/media/image1.png'),
      makeMediaToken('wps-media', 'xl/media/image2.png'),
    ])
  })

  await check('「截图」列里的人填链接 / 路径不当作附件，原样交给上层', async () => {
    const rows = [{ ...DEFAULT_ROWS[0], 截图: 'https://example.com/a.png' }]
    const parsed = parseWpsWorkbook({ bytes: makeProblemWorkbook({ rows, anchors: [] }) })
    assert.deepEqual(parsed.records[0].screenshotRefs, ['https://example.com/a.png'], '链接要单独收在 screenshotRefs 里')
    assert.deepEqual(parsed.records[0].screenshotTokens, [], '它不是附件，不能出现在 tokens 里')
  })

  await check('有图没描述的行要留着（人常先贴图后补字），描述自动占位', async () => {
    const rows = [{ ...DEFAULT_ROWS[0], 问题描述: '' }]
    const parsed = parseWpsWorkbook({ bytes: makeProblemWorkbook({ rows, anchors: [{ row: 3, media: 'xl/media/image1.png' }] }) })
    assert.equal(parsed.records.length, 1, '只有图的行也必须进流水线，否则图就被静默丢了')
    assert.ok(parsed.records[0].description.includes('第 3 行'), '占位描述要指出是哪一行：' + parsed.records[0].description)
  })

  await check('坏文件：不是 zip / 缺工作表 / 没有描述列，都报 invalid-input 而不是静默返回空', async () => {
    assert.throws(
      () => parseWpsWorkbook({ bytes: new TextEncoder().encode('<html>这是网页，不是 xlsx</html>') }),
      (error) => error.kind === 'invalid-input',
      '网页 / 快捷方式当成 xlsx 下载下来时，要一眼看出是文件不对'
    )
    assert.throws(
      () => parseWpsWorkbook({ bytes: new Uint8Array(0) }),
      (error) => error.kind === 'invalid-input',
      '空文件也要报 invalid-input'
    )
    // 没有 worksheet 部件的 zip：读不出数据，不能返回空数组
    const noSheet = makeZip([{ name: 'xl/workbook.xml', data: '<workbook/>' }])
    assert.throws(() => parseWpsWorkbook({ bytes: noSheet }), /工作表 XML/, '缺工作表要说清缺的是工作表');

    // 表头里没有「问题描述」：这张表根本不是问题记录表，必须报错让人去配 columnAliases
    const wrongHeader = makeZip([
      { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>姓名</t></is></c><c r="B1" t="inlineStr"><is><t>年龄</t></is></c></row></sheetData></worksheet>' },
    ])
    assert.throws(() => parseWpsWorkbook({ bytes: wrongHeader }), /问题描述/, '缺描述列时要指名道姓地说缺哪一列');
  })

  await check('指定 sheetName：给了不存在的表名要说清文件里有哪些表', async () => {
    assert.throws(
      () => parseWpsWorkbook({ bytes, sheetName: '不存在的表' }),
      /不存在的表/,
      '表名对不上时，报错里要带上实际表名，人才知道该改哪个配置'
    )
    const parsed = parseWpsWorkbook({ bytes, sheetName: '问题记录表' });
    assert.equal(parsed.records.length, 3)
  })

  await check('纯函数小件：日期序列号 / 优先级 / 图片类型边界', async () => {
    assert.equal(normalizeDateCell('46327'), '2026-11-01')
    assert.equal(normalizeDateCell('2026/11/1'), '2026/11/1', '认不出的格式原样保留，不要瞎猜')
    assert.equal(normalizeDateCell(''), '')
    assert.equal(normalizePriority('中'), 'medium')
    assert.equal(normalizePriority('P0'), 'high', '英文大小写不该影响判档')
    assert.equal(normalizePriority('待定'), undefined, '认不出的优先级宁可不给')
    assert.equal(mediaTypeOf('xl/media/image1.JPG'), 'image/jpeg', '扩展名大小写不该影响判类型')
    assert.equal(mediaTypeOf('xl/media/image1.emf'), undefined, 'emf 是矢量图，附件层不支持，要在解析期挡掉')
  })

  // ── 适配器层：createWpsSource 的取数与水位 ──────────────────

  await check('没配取数通道：报 invalid-input 并说清该配什么', async () => {
    const source = createWpsSource({ sourceId: 'wps-1' })
    assert.equal(source.capabilities.includes('watermark'), true, '水位是适配器自己算的，这条能力必须声明')
    await assert.rejects(
      () => source.scan({}),
      (error) => error.kind === 'invalid-input' && /取数通道/.test(error.message),
      '缺 fetchSheet 时不能返回空列表 —— 那会被上层当成「这一轮没有新工单」，问题全被捂住'
    )
  })

  await check('capabilities 只有 watermark 与 scanTuning，不多报能力', async () => {
    const source = createWpsSource({ sourceId: 'wps-1', fetchSheet: async () => ({ bytes }) })
    assert.deepEqual(source.capabilities, ['watermark', 'scanTuning'])
  })

  await check('scan 只收「处理中」的行，认领 / 已完成的都不进流水线', async () => {
    const source = createWpsSource({
      sourceId: 'wps-1',
      projectId: 'p-1',
      fetchSheet: async () => ({ bytes }),
    })
    const round = await source.scan({});
    const created = round.created.map((ticket) => ticket.recordId).sort();
    assert.deepEqual(created, ['r3', 'r4'], '第 5 行是「是」，不该出现：' + created.join(','))
    assert.equal(round.created[0].projectId, 'p-1', '固定的 projectId 优先于表格里填的');
    assert.equal(round.disappeared.length, 0)
  })

  await check('「待修改项目」列进 targetProject，不顶掉 projectId（那是存储主键）', async () => {
    const source = createWpsSource({
      sourceId: 'wps-1',
      projectId: 'p-1',
      fetchSheet: async () => ({ bytes }),
    })
    const round = await source.scan({})
    const ticket = round.created.find((item) => item.recordId === 'r3')
    assert.equal(ticket.projectId, 'p-1', 'projectId 必须是配置里的项目名')
    // 表格这一列是人手填的自由文本。要是拿它顶 projectId，同一张表的票会散到不同主键下，
    // 「项目 → 本地仓库」的对应关系当场失效。
    assert.equal(ticket.targetProject, '日报系统', '「待修改项目」要单独留着给模型参考')
  })

  await check('recordIds：只处理点名的行，名单外整行跳过（不收票、也不进水位）', async () => {
    const source = createWpsSource({
      sourceId: 'wps-1',
      projectId: 'p-1',
      recordIds: ['r4'],
      fetchSheet: async () => ({ bytes }),
    })
    const round = await source.scan({})
    assert.deepEqual(round.created.map((item) => item.recordId), ['r4'], '只该收 r4')
    const second = await source.scan({})
    assert.deepEqual(second.disappeared, [], '名单外的 r3 不能被算成「已删除」')
  })

  await check('recordIds 写成单字符串也认（配置里手写一个 id 是最常见的用法）', async () => {
    const source = createWpsSource({
      sourceId: 'wps-1',
      projectId: 'p-1',
      recordIds: 'r3',
      fetchSheet: async () => ({ bytes }),
    })
    const round = await source.scan({})
    assert.deepEqual(round.created.map((item) => item.recordId), ['r3'])
  })

  await check('水位：同一份表连扫两轮，第二轮一条都不重复推', async () => {
    const source = createWpsSource({ sourceId: 'wps-1', fetchSheet: async () => ({ bytes }) });
    const first = await source.scan({});
    assert.equal(first.created.length, 2)
    const second = await source.scan({});
    assert.equal(second.created.length, 0, '内容没变的行不该重复进 created');
    assert.equal(second.updated.length, 0, '内容没变也不该进 updated');
    assert.equal(second.disappeared.length, 0)
  })

  await check('水位：改了描述算更新，只改「是否处理」不算（指纹不含状态）', async () => {
    const source = createWpsSource({ sourceId: 'wps-1', fetchSheet: async () => ({ bytes }) });
    await source.scan({});

    const statusOnly = makeProblemWorkbook({
      rows: DEFAULT_ROWS.map((row, index) => (index === 0 ? { ...row, 是否处理: '否' } : row)),
    });
    const roundA = await source.scan({});
    // 第 3 行原本就是「处理中」，改成「否」它就掉出处理中集合 —— 那是 disappeared 而不是更新。
    assert.equal(roundA.updated.length, 0, '状态不进指纹，不该算内容更新');

    const edited = makeProblemWorkbook({
      rows: DEFAULT_ROWS.map((row, index) => (index === 1 ? { ...row, 问题描述: '导出报表时表头整体右移一列' } : row)),
    });
    const source2 = createWpsSource({ sourceId: 'wps-2', fetchSheet: async () => ({ bytes: edited }) });
    await source2.scan({});
    const roundB = await source2.scan({});
    assert.equal(roundB.created.length, 0)
  })

  await check('水位：行的描述变了 → 进 updated，并带上新内容', async () => {
    let current = bytes;
    const source = createWpsSource({ sourceId: 'wps-1', fetchSheet: async () => ({ bytes: current }) });
    await source.scan({});
    current = makeProblemWorkbook({
      rows: DEFAULT_ROWS.map((row, index) => (index === 0 ? { ...row, 问题描述: '导出报表时表头整体右移一列', 操作流程: '首页 → 导出 → 选 Excel' } : row)),
    });
    const round = await source.scan({});
    assert.equal(round.updated.length, 1, '描述改了要算更新，否则人补的字永远传不到工单上');
    // 契约里 updated 是 Ticket[]（无 {ticket} 包裹），内核直接消费这些字段。
    assert.equal(round.updated[0].recordId, 'r3')
    assert.ok(round.updated[0].description.includes('整体右移'));
  })

  await check('刚掉出处理中的行先按 disappeared 报，连续 ' + 'goneAfterScans 轮才真的删', async () => {
    let current = bytes;
    const source = createWpsSource({
      sourceId: 'wps-1',
      goneAfterScans: 2,
      fetchSheet: async () => ({ bytes: current }),
    });
    await source.scan({});

    // 第 3 行被改成「是」（处理完）—— 它可能是误勾，下一轮又改回来，不该立刻删票
    current = makeProblemWorkbook({
      rows: DEFAULT_ROWS.map((row, index) => (index === 0 ? { ...row, 是否处理: '是' } : row)),
    });
    // 退役语义与内核契约一致（disappeared: string[]）：连续 goneAfterScans 轮没出现才报，
    // 「第一轮只是提醒、第二轮才真删」由适配器内部的 missingScans 计数实现，不在返回值上暴露 final 标记。
    const firstGone = await source.scan({});
    assert.deepEqual(firstGone.disappeared, [], '第一轮只是提醒，不是删（观察期未满）');

    const secondGone = await source.scan({});
    assert.deepEqual(secondGone.disappeared, ['r3'], '连续两轮都不见了，才真的删');

    const thirdGone = await source.scan({});
    assert.equal(thirdGone.disappeared.length, 0, '删过之后不能再报第二次');
  })

  await check('loadScreenshot：attachment 能取回原图字节与类型', async () => {
    const source = createWpsSource({ sourceId: 'wps-1', fetchSheet: async () => ({ bytes }) });
    const token = makeMediaToken('wps-media', 'xl/media/image1.png');
    const shot = await source.loadScreenshot({ kind: 'attachment', fileToken: token, name: 'image1.png' });
    // 契约字段是 data（contracts/ticket-source.js 的 LoadedScreenshot），内核按 loaded.data 取字节。
    assert.deepEqual(Array.from(shot.data.slice(0, 8)), Array.from(PNG_BYTES.slice(0, 8)), '拿回的必须是原图字节');
    assert.equal(shot.mediaType, 'image/png')
    assert.equal(shot.name, 'image1.png')
  })

  await check('loadScreenshot：token 失效 / 表里已删图 / path 与 url 形态都说清为什么不读', async () => {
    const source = createWpsSource({ sourceId: 'wps-1', fetchSheet: async () => ({ bytes }) });
    await assert.rejects(
      () => source.loadScreenshot({ kind: 'attachment', fileToken: makeMediaToken('wps-media', 'xl/media/image9.png') }),
      (error) => error.kind === 'invalid-input' && /找不到/.test(error.message),
      '表格改版后被删掉的图，要说清是「最新一版里找不到」而不是网络错误'
    )
    await assert.rejects(
      () => source.loadScreenshot({ kind: 'path', path: 'D:/shot.png' }),
      (error) => error.kind === 'invalid-input',
      '金山源不该偷偷读本机磁盘'
    )
    await assert.rejects(
      () => source.loadScreenshot({ kind: 'url', url: 'https://example.com/a.png' }),
      (error) => error.kind === 'invalid-input',
      '金山源不该代替内核去下载外链'
    )
  })

  // ── 取数通道：超时 / 取消 / 字节上限 / 跳转逐跳校验 ──────────────
  //
  // 这一组全部用假 fetch 注入：不联网、不依赖真实响应时间、不拖慢 dev-run。
  // 超时那一拨把 timeoutMs 传成 20ms —— 断言的是「超时会中断并分类成 network」，
  // 不是「等 30 秒看它会不会超时」，所以不需要真等。

  await check('downloadSheetLimited：正常一次 200 就把字节原样交回来，且强制 manual 跳转', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const fake = fakeResponse({ status: 200, chunks: [payload] })
    /** @type {any[]} */
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      return fake.response
    }

    const bytes = await downloadSheetLimited(fetchImpl, 'https://www.kdocs.cn/l/abc', { timeoutMs: 5000 })
    assert.deepEqual(Array.from(bytes), [1, 2, 3, 4, 5], '下载回来的字节必须和响应体一致')
    assert.equal(calls.length, 1, '没有跳转就只该发一次请求')
    assert.equal(calls[0].init.redirect, 'manual',
      '必须自己跟跳：交给 fetch 跟就等于放弃了逐跳校验，远端能把我们导去任意主机/协议')
    assert.ok(calls[0].init.signal, '每次请求都得挂超时信号，否则连不上时 Promise 永不 settle')
  })

  await check('downloadSheetLimited：连接卡住会按超时中断，报 network（可重试）而不是永远挂着', async () => {
    // 真 fetch 在连接卡住时就是「不 resolve 也不 reject」，直到 signal 触发 —— 用假 fetch 复现。
    const startedAt = Date.now()
    await assert.rejects(
      () => downloadSheetLimited(hangingFetch(), 'https://www.kdocs.cn/l/abc', { timeoutMs: 20 }),
      (error) => error.kind === 'network' && /超时/.test(error.message),
      '卡死的连接必须变成一条可重试的 network 错误；挂在这儿的话 scan 永不返回 → running 恒真 → 整条流水线停摆'
    )
    assert.ok(Date.now() - startedAt < 5000, '注入 20ms 超时就不该真的等几十秒')
  })

  await check('downloadSheetLimited：调用方取消算 aborted（不是可重试超时），且能立刻断', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    await assert.rejects(
      () => downloadSheetLimited(hangingFetch(), 'https://www.kdocs.cn/l/abc',
        { timeoutMs: 60_000, signal: controller.signal }),
      (error) => error.kind === 'aborted',
      '内核要求停就停下：判成 network 会被当成可重试，白等一轮还会拖着收尾'
    )
  })

  await check('downloadSheetLimited：content-length 谎报超大就当场拒绝，一个字节都不用读', async () => {
    const fake = fakeResponse({
      status: 200,
      headers: { 'content-length': String(DEFAULT_SHEET_MAX_BYTES + 1) },
      chunks: [new Uint8Array(10)],
    })
    await assert.rejects(
      () => downloadSheetLimited(async () => fake.response, 'https://www.kdocs.cn/l/abc'),
      (error) => error.kind === 'invalid-input' && /超过上限/.test(error.message),
      '头里报了大小就先用上，省一次把几十 MB 拉进内存'
    )
    assert.equal(fake.state.reads, 0, '预检拦下的就不该再读响应体')
  })

  await check('downloadSheetLimited：没 content-length 时边读边计数，超限立刻断连', async () => {
    // 40 块 × 1KiB = 40KiB，上限给 4KiB：第 5 块就该炸，后面的块不该被读走。
    /** @type {Uint8Array[]} */
    const chunks = []
    for (let i = 0; i < 40; i += 1) chunks.push(new Uint8Array(1024))
    const fake = fakeResponse({ status: 200, chunks })

    await assert.rejects(
      () => downloadSheetLimited(async () => fake.response, 'https://www.kdocs.cn/l/abc',
        { maxBytes: 4096 }),
      (error) => error.kind === 'invalid-input' && /已读超过上限/.test(error.message),
      'chunked / 无 content-length 的响应只能靠边读边计数挡住'
    )
    assert.equal(fake.state.cancelled, true, '超限后必须 cancel 掉 reader，否则对方还在往这条流里灌数据')
    assert.ok(fake.state.reads <= 6, '超限就该停，不该把 40 块全读完（实际读了 ' + fake.state.reads + ' 块）')
    assert.equal(fake.state.finished, false, '流没被读完 —— 这才叫「中止下载」')
  })

  await check('downloadSheetLimited：跳转最多跟 ' + MAX_SHEET_REDIRECTS + ' 跳，第 ' + (MAX_SHEET_REDIRECTS + 1) + ' 跳就当作可疑链接拒绝', async () => {
    let count = 0
    const fetchImpl = async () => {
      count += 1
      // 永远回同一个相对跳转 → 无限循环。适配器必须自己数着跳。
      const fake = fakeResponse({ status: 302, headers: { location: '/l/next' } })
      return fake.response
    }
    await assert.rejects(
      () => downloadSheetLimited(fetchImpl, 'https://www.kdocs.cn/l/abc'),
      (error) => error.kind === 'invalid-input' && /重定向超过/.test(error.message),
      '登录墙一般一两跳就到位；再多就是循环或钓鱼链路，重试没用，要人看'
    )
    assert.equal(count, MAX_SHEET_REDIRECTS + 1, '请求次数应该是「起点 + 跟 ' + MAX_SHEET_REDIRECTS + ' 跳」')
  })

  await check('downloadSheetLimited：跳转目标逐跳校验协议与主机（file: / 未放行主机都拒）', async () => {
    const toFile = async () => fakeResponse({ status: 302, headers: { location: 'file:///C:/Windows/win.ini' } }).response
    await assert.rejects(
      () => downloadSheetLimited(toFile, 'https://www.kdocs.cn/l/abc'),
      (error) => error.kind === 'invalid-input' && /只允许 http \/ https/.test(error.message),
      '跟着共享链接跳到 file: 就等于让一段配置去读服务器本地文件'
    )

    const toOtherHost = async () => fakeResponse({ status: 302, headers: { location: 'https://evil.example.com/x.xlsx' } }).response
    await assert.rejects(
      () => downloadSheetLimited(toOtherHost, 'https://www.kdocs.cn/l/abc'),
      (error) => error.kind === 'invalid-input' && /未放行的主机/.test(error.message),
      '缺省只放行起点链接自己的主机：跳转目标是远端返回的，不是人写进配置的'
    )

    // 显式放行之后就允许跨主机 —— 有正当需求时不该被彻底堵死。
    const payload = new Uint8Array([7, 7, 7])
    const crossHost = async (url) => (url.includes('evil.example.com')
      ? fakeResponse({ status: 200, chunks: [payload] }).response
      : fakeResponse({ status: 302, headers: { location: 'https://evil.example.com/x.xlsx' } }).response)
    const bytes = await downloadSheetLimited(crossHost, 'https://www.kdocs.cn/l/abc',
      { allowedHosts: ['www.kdocs.cn', 'evil.example.com'] })
    assert.deepEqual(Array.from(bytes), [7, 7, 7], '显式放行后跨主机跳转应该能走通')
  })

  await check('scan：取数通道会收到 signal（内核取消时下载要能立刻断，不是等它自己超时）', async () => {
    /** @type {any[]} */
    const seen = []
    const source = createWpsSource({
      sourceId: 'wps-1',
      fetchSheet: async (signal) => {
        seen.push(signal)
        return { bytes }
      },
    })
    const controller = new AbortController()
    await source.scan(controller.signal)
    assert.equal(seen.length, 1)
    assert.ok(seen[0] instanceof AbortSignal, '注入了 signal 就必须传下去，否则取数通道无从得知「别取了」')

    // 取数通道真的照信号停了，这一轮就该以 aborted 收场，而不是把半截数据当成功。
    // 这里的 keepAlive 与 hangingFetch 里的是同一个理由：不吊住事件循环的话，
    // 「永不 settle 的 Promise」会让 node 提前静默退出。
    const hanging = createWpsSource({
      sourceId: 'wps-2',
      fetchSheet: (signal) => new Promise((resolve, reject) => {
        const keepAlive = setTimeout(() => {}, 60_000)
        signal.addEventListener('abort', () => {
          clearTimeout(keepAlive)
          reject(signal.reason)
        }, { once: true })
      }),
    })
    const cancel = new AbortController()
    setTimeout(() => cancel.abort(), 20)
    await assert.rejects(
      () => hanging.scan(cancel.signal),
      (error) => error.kind === 'aborted' || error.kind === 'network',
      '取消后这一轮必须结束，而不是让 scan 永不返回'
    )
  })

  await check('wpsOptionsFromMatch：翻译出的取数通道带超时与字节上限（不是裸 fetch）', async () => {
    const options = wpsOptionsFromMatch({ sheetUrl: 'https://www.kdocs.cn/l/abcdef' })
    assert.equal(typeof options.fetchSheet, 'function')

    // **不联网**地用已取消的信号探一下：受限下载器在发请求之前就会先看 signal，
    // 所以它会立刻以 PipelineError('aborted') 收场；而原来那句
    // `fetch(sheetUrl, { redirect: 'follow' })` 根本没有 signal 参数，会真发一次请求
    // （然后挂到 DNS / 登录墙上）。这条断言因此同时验了两件事：走的是新实现，且真的收 signal。
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(
      () => options.fetchSheet(aborted.signal),
      (error) => error.name === 'PipelineError' && error.kind === 'aborted',
      '默认取数通道必须走 downloadSheetLimited（并且接住调用方的 signal）'
    )

    assert.ok(DEFAULT_SHEET_TIMEOUT_MS >= 1000 && DEFAULT_SHEET_MAX_BYTES >= 1024 * 1024,
      '缺省值得是「30 秒量级 / 十 MB 量级」，别有人手滑改成 1ms 或 1 字节')
  })

  await check('wpsOptionsFromMatch：把规则里的一段链接翻译成适配器配置', async () => {
    const options = wpsOptionsFromMatch({
      sheetUrl: 'https://www.kdocs.cn/l/abcdef',
      sheetName: '问题记录表',
      projectId: 'p-1',
      goneAfterScans: 3,
    });
    assert.equal(options.sheetName, '问题记录表')
    assert.equal(options.projectId, 'p-1')
    assert.equal(options.goneAfterScans, 3)
    assert.equal(typeof options.fetchSheet, 'function', '翻译结果里必须带取数通道，否则 createWpsSource 直接报错');
  })

  await check('wpsOptionsFromMatch：recordIds 也翻译过去（试点单票不该只在飞书上好使）', async () => {
    const options = wpsOptionsFromMatch({ recordIds: ['r4'] })
    assert.deepEqual(options.recordIds, ['r4'])
    // 没配就别塞进去，否则适配器会以为是「挑零张」
    assert.equal('recordIds' in wpsOptionsFromMatch({}), false)
  })
}