/**
 * xlsx 解析：把一份「问题记录表」解成行数据，并把浮动图片按锚点挂到对应行。
 *
 * ## 为什么必须自己解 OOXML
 *
 * 金山文档的开放接口拿不到单元格图片的字节（`range_data` 只说 `is_cell_pic: true`），
 * 唯一可靠的办法是下载原始 `.xlsx` 再自己拆开：图片在 `xl/media/*`，
 * 它在表里的位置写在 `xl/drawings/drawing*.xml` 的 `<xdr:from><xdr:col/row>` 里。
 * 这条结论见本目录 `index.js` 的抬头说明，不要改成「调接口取图」。
 *
 * ## 报错的口径
 *
 * 这个文件只抛普通 `Error`，「哪个 kind」由上层（`index.js`）统一译成
 * `invalid-input`。理由：解析器的错误**永远**是「人给的这份文件不对」，
 * 在两层各判一次只会让两处文案打架；而 zip 层直接抛 PipelineError，是因为
 * 「这不是一个 zip」本身就是调用方要转述给用户的最终结论。
 *
 * ## 边界
 *
 * - 只认 ECMA-376 的两种字符串：sharedStrings 与内联字符串。富文本按 `<r>` 段拼原文。
 * - 日期按序列号算（1899-12-30 基准），能一并抹平 Excel 那个著名的 1900 闰年 bug。
 * - 对图片/进度条这类「浮动对象」，只认表格里的**浮动**图片（drawing），
 *   单元格内嵌图片（`cellimages.xml`）目前在导出件里没遇到过，不实现。
 */

import { decodeUtf8, readZipEntries, readZipEntry } from './zip.js'

/** 图片 fileToken 的默认前缀。同一个前缀下的 token 才能被 `loadScreenshot` 认出来。 */
export const DEFAULT_MEDIA_PREFIX = 'wps-media'

/** 表头认这些列名（同一个字段的几种叫法）。顺序即优先级。 */
export const DEFAULT_COLUMN_ALIASES = Object.freeze({
  seq: ['序号', '编号', 'No', 'No.'],
  projectId: ['待修改项目', '所属项目', '项目', '系统'],
  description: ['问题描述', '问题', '缺陷描述', 'Bug 描述'],
  flow: ['操作流程', '复现步骤', '操作步骤', '复现流程'],
  status: ['是否处理', '处理状态', '状态'],
  department: ['发现部门', '提出部门', '部门'],
  foundAt: ['发现日期', '提出日期', '日期'],
  priority: ['优先级', '严重程度', '等级'],
  module: ['模块', '所属模块', '功能模块'],
  screenshot: ['截图', '图片', '问题截图', '截图/录屏'],
})

/** 优先级字面量 → 内部档位。与飞书适配器同一套口径，否则两个源对同一张票会给出不同档位。 */
const PRIORITY_MAP = new Map([
  ['高', 'high'], ['高优先级', 'high'], ['紧急', 'high'], ['严重', 'high'], ['urgent', 'high'], ['critical', 'high'], ['p0', 'high'], ['p1', 'high'],
  ['中', 'medium'], ['中优先级', 'medium'], ['一般', 'medium'], ['普通', 'medium'], ['medium', 'medium'], ['p2', 'medium'],
  ['低', 'low'], ['低优先级', 'low'], ['轻微', 'low'], ['minor', 'low'], ['low', 'low'], ['p3', 'low'],
])

/** 表头最多往下找几行。抬头说明占三五行的表很常见，别一碰到空行就放弃。 */
const HEADER_SCAN_ROWS = 10

/** 超过这个列号（XFD = 16383）就认为坐标不合法 —— 防止坏文件把循环拖死。 */
const MAX_COLUMN_INDEX = 16383

/**
 * 一行原始记录 → 工单字段（还没经过 `makeTicket`）。
 *
 * @typedef {Object} WpsRecord
 * @property {string} recordId
 * @property {number} rowIndex
 * @property {string} [seq]
 * @property {string} [projectId]
 * @property {string} description
 * @property {string} [flow]
 * @property {string} [status]
 * @property {string} [department]
 * @property {string} [foundAt]
 * @property {string} [module]
 * @property {'high'|'medium'|'low'} [priority]
 * @property {string[]} screenshotTokens 附件形态的 fileToken（在 `media` 里取字节）
 * @property {string[]} screenshotRefs 人填在「截图」列里的共享路径 / 链接（不是附件）
 * @property {Record<string, string>} raw 原始单元格文本
 */

/**
 * 解一份 xlsx。
 *
 * @param {Object} input
 * @param {Uint8Array | ArrayBuffer} input.bytes xlsx 文件字节
 * @param {string} [input.sheetName] 指定工作表名（不给就用 workbook 里的第一张）
 * @param {string} [input.mediaPrefix] 图片 fileToken 的前缀，默认 `wps-media`
 * @param {Record<string, string[]>} [input.columnAliases] 覆盖表头别名（只覆盖点名的字段，其余保持默认）
 * @returns {{ records: WpsRecord[], sheetName: string, headerRowIndex: number, media: Map<string, { data: Uint8Array, mediaType: string, name: string }> }}
 */
export function parseWpsWorkbook (input) {
  const bytes = normalizeBytes(input?.bytes)
  const entries = readZipEntries(bytes)

  const sheetPath = resolveSheetPath(bytes, entries, String(input?.sheetName ?? ''))
  // 找不到工作表 XML 立刻报错：空的 `records` 会被上层读成「表里没工单」，
  // 于是所有在跑的票集体退役 —— 那是比一句清楚的报错难查得多的故障。
  const sheetXml = decodeUtf8(mustRead(bytes, entries, sheetPath, '缺少工作表 XML，文件不是完整的 xlsx'))
  const sharedStrings = readSharedStrings(bytes, entries)
  const grid = parseSheetRows(sheetXml, sharedStrings)
  const { headerRowIndex, columns } = locateHeader(grid, input?.columnAliases)

  const mediaPrefix = String(input?.mediaPrefix ?? DEFAULT_MEDIA_PREFIX)
  const { byRow, media } = collectMedia(bytes, entries, sheetPath, mediaPrefix)

  /** @type {WpsRecord[]} */
  const records = []
  for (const row of grid) {
    if (row.rowIndex <= headerRowIndex) continue
    /** @type {Record<string, string>} */
    const cells = {}
    for (const [field, columnIndex] of Object.entries(columns)) {
      const text = row.cells.get(columnIndex)
      if (text !== undefined && text !== '') cells[field] = text
    }

    /** @type {string[]} */
    const screenshotTokens = []
    for (const item of byRow.get(row.rowIndex) ?? []) screenshotTokens.push(item.fileToken)
    const screenshotRefs = extractRefsFromText(cells.screenshot)

    // 「只有日期没有描述」的行不是工单（先贴图后补字的情况要留着，见下一条）；
    // 图和描述都没有的行一律跳过，否则表格末尾的汇总行、分隔行会变成一堆空票。
    if (!cells.description && screenshotTokens.length === 0 && screenshotRefs.length === 0) continue

    const description = cells.description ?? (screenshotRefs.length > 0
      ? screenshotRefs.join(' ')
      : `（第 ${row.rowIndex} 行贴了截图，但没写问题描述）`)

    /** @type {WpsRecord} */
    const record = {
      recordId: buildRecordId(row.rowIndex),
      rowIndex: row.rowIndex,
      description: description.replace(/\r\n?/g, '\n').trim(),
      screenshotTokens,
      screenshotRefs,
      raw: cells,
    }
    if (cells.seq) record.seq = cells.seq
    if (cells.projectId) record.projectId = cells.projectId
    if (cells.flow) record.flow = cells.flow
    if (cells.status) record.status = cells.status
    if (cells.department) record.department = cells.department
    if (cells.module) record.module = cells.module
    if (cells.foundAt) record.foundAt = normalizeDateCell(cells.foundAt)
    const priority = normalizePriority(cells.priority)
    if (priority) record.priority = priority
    records.push(record)
  }

  return { records, sheetName: sheetDisplayName(bytes, entries, sheetPath), headerRowIndex, media }
}

/**
 * 图片 fileToken 的形状：`<prefix>:<zip 里的完整路径>`。
 *
 * 为什么 token 里带完整路径而不是只带文件名：`xl/media/` 下重名是可能的
 * （不同工具导出时会把图放进子目录），只认文件名会在真实文件上挂错图。
 *
 * @param {string} mediaPrefix
 * @param {string} mediaPath zip 里的条目名
 * @returns {string}
 */
export function makeMediaToken (mediaPrefix, mediaPath) {
  return mediaPrefix + ':' + mediaPath
}

/**
 * 从 fileToken 里解析出 zip 条目名。token 不属于本前缀或条目不存在时返回 undefined。
 *
 * @param {Array<{ name: string }>} entries
 * @param {string} token
 * @param {string} [mediaPrefix]
 * @returns {string | undefined}
 */
export function resolveMediaToken (entries, token, mediaPrefix = DEFAULT_MEDIA_PREFIX) {
  const expectedPrefix = mediaPrefix + ':'
  if (typeof token !== 'string' || token.indexOf(expectedPrefix) !== 0) return undefined
  const mediaPath = token.slice(expectedPrefix.length)
  const matched = entries.find((entry) => entry.name === mediaPath)
  return matched ? matched.name : undefined
}

// ── 工作表定位 ──────────────────────────────────────────────

/**
 * 找到工作表 XML 的条目名。
 *
 * 不写死 `xl/worksheets/sheet1.xml`：文件被 WPS / Excel 反复另存后，第一张表未必叫 sheet1。
 * 所以先读 `xl/workbook.xml` 的 `<sheet name r:id>`，再经 `xl/_rels/workbook.xml.rels`
 * 换成真实路径；任何一步缺失才退回「取第一个 worksheets/*.xml」。
 *
 * @param {Uint8Array} bytes
 * @param {import('./zip.js').ZipEntry[]} entries
 * @param {string} sheetName
 * @returns {string}
 */
function resolveSheetPath (bytes, entries, sheetName) {
  const workbookXml = readOptionalText(bytes, entries, 'xl/workbook.xml')
  const relsXml = readOptionalText(bytes, entries, 'xl/_rels/workbook.xml.rels')

  const sheets = workbookXml
    ? [...workbookXml.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: attr(m[0], 'name') ?? '', rid: attr(m[0], 'r:id') ?? '' }))
    : []

  const picked = sheetName ? sheets.find((sheet) => sheet.name === sheetName) : sheets[0]
  if (sheetName && !picked) {
    const names = sheets.map((sheet) => sheet.name).filter(Boolean).join(' / ')
    throw new Error('工作表「' + sheetName + '」不存在，这份文件里只有：' + (names || '（读不出表名）'))
  }

  if (relsXml && picked) {
    const target = relationshipTargets(relsXml, 'xl/').get(picked.rid)
    if (target && entries.some((entry) => entry.name === target)) return target
  }

  const first = entries.find((entry) => /^xl\/worksheets\/[^/]+\.xml$/.test(entry.name))
  if (!first) throw new Error('这份 xlsx 里没有工作表 XML（xl/worksheets/*.xml），读不出任何数据')
  return first.name
}

/**
 * 把 .rels 里的 `<Relationship Id Target>` 收成 Id → 条目名。
 *
 * `base` 是「相对的 Target 该以谁为根」：workbook 的 rels 以 `xl/` 为根，
 * 而 sheet 的 rels 要相对 sheet 自己的目录算（见 `resolveRelative`）。
 *
 * @param {string} relsXml
 * @param {string} base 相对 Target 的前缀
 * @returns {Map<string, string>}
 */
function relationshipTargets (relsXml, base) {
  /** @type {Map<string, string>} */
  const map = new Map()
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(match[0], 'Id')
    const target = attr(match[0], 'Target')
    if (!id || !target) continue
    map.set(id, target.charAt(0) === '/' ? target.slice(1) : base + target)
  }
  return map
}

/**
 * 表的显示名。取不到就用条目名最后一段。
 * @param {Uint8Array} bytes
 * @param {import('./zip.js').ZipEntry[]} entries
 * @param {string} sheetPath
 * @returns {string}
 */
function sheetDisplayName (bytes, entries, sheetPath) {
  const workbookXml = readOptionalText(bytes, entries, 'xl/workbook.xml')
  if (workbookXml) {
    const first = workbookXml.match(/<sheet\b[^>]*>/g)
    const name = first ? attr(first[0], 'name') : undefined
    if (name) return name
  }
  return sheetPath.slice(sheetPath.lastIndexOf('/') + 1)
}

// ── sharedStrings / 单元格 ──────────────────────────────────

/**
 * 读共享字符串表。
 *
 * 必须按 `<si>` 配对而不是按 `<t>` 全局收集：一个富文本单元格里可以有多个 `<r><t>`，
 * 逐个 `<t>` 收集会让下标整体错位，于是所有文字都串了一格。
 *
 * @param {Uint8Array} bytes
 * @param {import('./zip.js').ZipEntry[]} entries
 * @returns {string[]}
 */
function readSharedStrings (bytes, entries) {
  const xml = readOptionalText(bytes, entries, 'xl/sharedStrings.xml')
  if (!xml) return []
  return splitBlocks(xml, 'si').map(siToText)
}

/**
 * 把 `<si>` 块转成纯文本：直排文本 + 所有富文本段的文本。
 * 跳过 `<rPh>`（日文注音）—— 它不是正文，拼进去会污染指纹。
 *
 * @param {string} block
 * @returns {string}
 */
function siToText (block) {
  const withoutPhonetic = block.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
  const parts = [...withoutPhonetic.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlText(m[1]))
  return parts.join('')
}

/**
 * 把 sheet XML 解成「每行 → 每列文本」。
 *
 * 单元格的值有三种来源，按顺序认：
 * 1. `t="s"` → `<v>` 是 sharedStrings 的下标；
 * 2. `t="inlineStr"` → `<is>` 里就是文本；
 * 3. `t="str"` / 无 t（数字、公式结果）→ `<v>` 直接用。
 * 公式单元格没有缓存值（缺 `<v>`）时留空 —— 猜不出来，留空比乱填安全。
 *
 * @param {string} sheetXml
 * @param {string[]} sharedStrings
 * @returns {Array<{ rowIndex: number, cells: Map<number, string> }>}
 */
function parseSheetRows (sheetXml, sharedStrings) {
  /** @type {Array<{ rowIndex: number, cells: Map<number, string> }>} */
  const rows = []
  let autoRowIndex = 0

  for (const rowBlock of splitBlocksWithAttrs(sheetXml, 'row')) {
    const explicit = Number(attr(rowBlock.attrs, 'r'))
    autoRowIndex = Number.isInteger(explicit) && explicit > 0 ? explicit : autoRowIndex + 1

    /** @type {Map<number, string>} */
    const cells = new Map()
    let autoColIndex = -1
    for (const cell of splitBlocksWithAttrs(rowBlock.inner, 'c')) {
      const reference = attr(cell.attrs, 'r') ?? ''
      const parsed = reference ? columnIndexOf(reference) : undefined
      autoColIndex = parsed !== undefined ? parsed : autoColIndex + 1
      if (autoColIndex < 0 || autoColIndex > MAX_COLUMN_INDEX) continue

      const text = readCellValue(cell.inner, attr(cell.attrs, 't') ?? '', sharedStrings)
      if (text !== '') cells.set(autoColIndex, text)
    }
    rows.push({ rowIndex: autoRowIndex, cells })
  }
  return rows
}

/**
 * 取一个 `<c>` 块的文本。
 * @param {string} inner
 * @param {string} type
 * @param {string[]} sharedStrings
 * @returns {string}
 */
function readCellValue (inner, type, sharedStrings) {
  if (type === 'inlineStr') {
    const isBlock = inner.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)
    return isBlock ? siToText(isBlock[1]).trim() : ''
  }
  const v = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)
  if (!v) return ''
  const raw = decodeXmlText(v[1]).trim()
  if (type === 's') {
    const index = Number(raw)
    if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) return ''
    return sharedStrings[index].trim()
  }
  return raw
}

/**
 * `C12` → 2（0 基列号）。认不出返回 undefined。
 * @param {string} reference
 * @returns {number | undefined}
 */
function columnIndexOf (reference) {
  const matched = /^([A-Za-z]+)/.exec(reference)
  if (!matched) return undefined
  let index = 0
  for (const ch of matched[1].toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64)
  return index - 1
}

// ── 表头 ────────────────────────────────────────────────────

/**
 * 在前几行里找表头，返回表头行号与「字段 → 列号」。
 *
 * 命中越多别名越好，但**至少要认出「问题描述」** —— 没有描述列的表，
 * 后面每一行都判不出内容，等于静默返回 0 张工单。宁可在这里报错，
 * 让人去改 `columnAliases`，也不要让流水线以为表是空的。
 *
 * @param {Array<{ rowIndex: number, cells: Map<number, string> }>} grid
 * @param {Record<string, string[]>} [overrides]
 * @returns {{ headerRowIndex: number, columns: Record<string, number> }}
 */
function locateHeader (grid, overrides) {
  const aliases = mergeAliases(overrides)
  /** @type {Map<string, string>} */
  const normalized = new Map()
  for (const [field, names] of Object.entries(aliases)) {
    for (const name of names) normalized.set(normalizeHeaderKey(name), field)
  }

  let best = { headerRowIndex: 0, columns: {}, hits: 0 }
  for (const row of grid.slice(0, HEADER_SCAN_ROWS)) {
    /** @type {Record<string, number>} */
    const columns = {}
    let hits = 0
    for (const [columnIndex, text] of row.cells) {
      const field = normalized.get(normalizeHeaderKey(text))
      if (!field || columns[field] !== undefined) continue
      columns[field] = columnIndex
      hits += 1
    }
    if (hits > best.hits) best = { headerRowIndex: row.rowIndex, columns, hits }
  }

  if (best.columns.description === undefined) {
    throw new Error('前 ' + HEADER_SCAN_ROWS + ' 行里找不到「问题描述」列（可用列名：' + aliases.description.join(' / ') + '）。如果表头被改了名，请在项目配置里补 columnAliases')
  }
  return { headerRowIndex: best.headerRowIndex, columns: best.columns }
}

/**
 * 覆盖别名时**合并而不是替换**：配置里只想把「是否处理」改成「处理情况」时，
 * 其余列不该因此全都不认识。
 *
 * @param {Record<string, string[]>} [overrides]
 * @returns {Record<string, string[]>}
 */
function mergeAliases (overrides) {
  if (!overrides || Object.keys(overrides).length === 0) return DEFAULT_COLUMN_ALIASES
  /** @type {Record<string, string[]>} */
  const merged = { ...DEFAULT_COLUMN_ALIASES }
  for (const [field, names] of Object.entries(overrides)) {
    if (!Array.isArray(names) || names.length === 0) continue
    merged[field] = [...names.map(String), ...(DEFAULT_COLUMN_ALIASES[field] ?? [])]
  }
  return merged
}

/**
 * 表头比对前统一口径：去空白、去全角空格、去末尾冒号、小写。
 * 真实表里「是否处理：」「 是否处理 」这种写法到处都有。
 * @param {string} text
 * @returns {string}
 */
function normalizeHeaderKey (text) {
  return String(text ?? '').replace(/[\s\u3000]+/g, '').replace(/[:：]+$/, '').toLowerCase()
}

// ── 图片 ────────────────────────────────────────────────────

/**
 * 把图片按锚点行列挂到行上。
 *
 * 数据流：`sheet.xml → sheet.xml.rels → drawing*.xml → <xdr:blip r:embed> → drawing rels → media`。
 * 为了兼容「同一个 drawing 挂在多张表上」和「多张表共用一份 rels」的情况，这里
 * 只从**当前这张表**的 rels 出发（上一条链路），不扫全包 —— 否则两张表共用的图会被挂两遍。
 *
 * 任何一环缺失就跳过这张图（不报错）：缺一张图比整轮扫描失败代价小，
 * 而且「有没有图」进了指纹，真正的空缺会被当成一次修订暴露出来。
 *
 * @param {Uint8Array} bytes
 * @param {import('./zip.js').ZipEntry[]} entries
 * @param {string} sheetPath
 * @param {string} mediaPrefix
 * @returns {{ byRow: Map<number, Array<{ fileToken: string, name: string, mediaType: string }>>, media: Map<string, { data: Uint8Array, mediaType: string, name: string }> }}
 */
function collectMedia (bytes, entries, sheetPath, mediaPrefix) {
  /** @type {Map<number, Array<{ fileToken: string, name: string, mediaType: string }>>} */
  const byRow = new Map()
  /** @type {Map<string, { data: Uint8Array, mediaType: string, name: string }>} */
  const media = new Map()

  const sheetRels = readOptionalText(bytes, entries, relsPathOf(sheetPath))
  if (!sheetRels) return { byRow, media }

  const drawingPaths = []
  for (const match of sheetRels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (!/drawing/i.test(attr(match[0], 'Type') ?? '')) continue
    const target = attr(match[0], 'Target')
    if (target) drawingPaths.push(resolveRelative(sheetPath, target))
  }

  for (const drawingPath of drawingPaths) {
    const drawingXml = readOptionalText(bytes, entries, drawingPath)
    if (!drawingXml) continue
    const drawingRels = readOptionalText(bytes, entries, relsPathOf(drawingPath))
    if (!drawingRels) continue
    /** @type {Map<string, string>} */
    const relTargets = new Map()
    for (const [id, target] of relationshipTargets(drawingRels, '')) {
      relTargets.set(id, resolveRelative(drawingPath, target))
    }

    for (const anchorXml of splitAnchors(drawingXml)) {
      const rowIndex = anchorRow(anchorXml)
      if (rowIndex === undefined) continue
      const embed = anchorXml.match(/<a:blip\b[^>]*r:embed="([^"]+)"/)
      if (!embed) continue
      const mediaPath = relTargets.get(embed[1])
      if (!mediaPath) continue
      const mediaType = mediaTypeOf(mediaPath)
      if (!mediaType) continue
      const data = readZipEntry(bytes, entries, mediaPath)
      if (!data || data.length === 0) continue

      const name = mediaPath.slice(mediaPath.lastIndexOf('/') + 1)
      const fileToken = makeMediaToken(mediaPrefix, mediaPath)
      if (!media.has(fileToken)) media.set(fileToken, { data, mediaType, name })
      const list = byRow.get(rowIndex) ?? []
      // 同一行贴了同一张图两次：只留一份，否则同一张图会被上传两次、指纹也白变一次。
      if (!list.some((item) => item.fileToken === fileToken)) list.push({ fileToken, name, mediaType })
      byRow.set(rowIndex, list)
    }
  }
  return { byRow, media }
}

/**
 * 拆出绘图里的各个 anchor 内容。
 *
 * `twoCellAnchor` 与 `oneCellAnchor` 的语义相同（图钉在某个格子上），一起收；
 * `absoluteAnchor` 没有锚点行列，人也就没法通过移动它来表达「这张图属于哪一行」，直接丢掉。
 *
 * @param {string} drawingXml
 * @returns {string[]}
 */
function splitAnchors (drawingXml) {
  const pattern = /<xdr:(twoCellAnchor|oneCellAnchor)\b[^>]*>([\s\S]*?)<\/xdr:\1>/g
  return [...drawingXml.matchAll(pattern)].map((match) => match[2])
}

/**
 * anchor 里的 `<xdr:from><xdr:row>`（0 基）→ xlsx 的 1 基行号。
 *
 * 只认 `<xdr:from>` 不认 `to`：`from` 是图片左上角所在格，
 * 人把图拖到哪一行的左边，就从哪一行开始 —— 这和眼睛看到的一致。
 * @param {string} xml
 * @returns {number | undefined}
 */
function anchorRow (xml) {
  const from = xml.match(/<xdr:from\b[^>]*>([\s\S]*?)<\/xdr:from>/)
  if (!from) return undefined
  const row = from[1].match(/<xdr:row>(\d+)<\/xdr:row>/)
  if (!row) return undefined
  const index = Number(row[1])
  return Number.isInteger(index) && index >= 0 ? index + 1 : undefined
}

/**
 * rels 里的 `Target="../media/image1.png"` 这种相对路径 → zip 条目名。
 *
 * `basePath` 是**引用方**（owner part）的条目路径，相对路径要从它的目录开始算；
 * 直接拿 zip 根去拼会得到 `../media/image1.png` 这种永远找不到的条目名。
 *
 * @param {string} basePath
 * @param {string} target
 * @returns {string}
 */
function resolveRelative (basePath, target) {
  if (target.charAt(0) === '/') return target.slice(1)
  const baseDir = basePath.slice(0, basePath.lastIndexOf('/'))
  /** @type {string[]} */
  const stack = baseDir.split('/').filter(Boolean)
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') stack.pop()
    else stack.push(segment)
  }
  return stack.join('/')
}

/** `xl/worksheets/sheet1.xml` → `xl/worksheets/_rels/sheet1.xml.rels` */
function relsPathOf (partPath) {
  const slash = partPath.lastIndexOf('/')
  return partPath.slice(0, slash) + '/_rels/' + partPath.slice(slash + 1) + '.rels'
}

/**
 * 图片类型只认 DSH 附件层支持的四类。`emf` / `wmf` 是 Windows 矢量图，
 * 拿去做视觉输入只会让模型报错，所以在解析这一层就挡掉。
 * @param {string} path
 * @returns {string | undefined}
 */
export function mediaTypeOf (path) {
  const lower = String(path ?? '').toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return undefined
}

// ── 小工具 ──────────────────────────────────────────────────

/**
 * 「截图」列里人写的共享路径 / 链接：它们不是附件，原样交给上层当 `path` / `url` 引用。
 *
 * 判据是「带斜杠或反斜杠」或「http(s) 开头」—— 光靠「有没有空格」分不出来，
 * 但人往这一列里写纯文字说明本来也没意义，所以宁可把含路径分隔符的整段都当引用。
 *
 * @param {string | undefined} text
 * @returns {string[]}
 */
function extractRefsFromText (text) {
  if (!text) return []
  /** @type {string[]} */
  const refs = []
  for (const piece of String(text).split(/[\s,;；，]+/)) {
    const value = piece.trim()
    if (!value) continue
    if (/^https?:\/\//i.test(value) || /[\\/]/.test(value)) refs.push(value)
  }
  return refs
}

/**
 * 记录 id 就是工单身份，必须跨轮次稳定，所以**只看行号**，不看任何可能被人编辑的内容。
 *
 * 为什么不用「序号」列：那一列是人手填的，插行删行会重排，用它当主键会让同一张票
 * 被当成两张（或者两张被当成一张）。行号也会因为插行而变 —— 这是 xlsx 这套源与生俱来
 * 的代价：行一变，水位里那条记录就变成「消失了」，连续 goneAfterScans 轮后退役，
 * 然后新行号作为一张新票进来。这个取舍写在 `index.js` 的抬头里，别在这里偷偷改名。
 *
 * @param {number} rowIndex
 * @returns {string}
 */
function buildRecordId (rowIndex) {
  return 'r' + rowIndex
}

/**
 * 日期归一成 `YYYY-MM-DD`。人填的文本原样保留（可能是「2026/11/1」或「待定」），
 * 只在能认出序列号时换算 —— 认不出就不猜。
 * @param {string} text
 * @returns {string}
 */
export function normalizeDateCell (text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return ''
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const serial = Number(trimmed)
    if (serial > 0 && serial < 2958466) {
      // 1899-12-30 基准：它能一并抵消 Excel 把 1900 当闰年造成的 1 天偏差
      const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000
      return new Date(ms).toISOString().slice(0, 10)
    }
  }
  return trimmed
}

/**
 * @param {string} text
 * @returns {'high'|'medium'|'low'|undefined}
 */
export function normalizePriority (text) {
  const key = String(text ?? '').trim().toLowerCase()
  if (!key) return undefined
  return /** @type {any} */ (PRIORITY_MAP.get(key))
}

/**
 * 切出 `<name ...>inner</name>` 的 inner 文本列表（不处理嵌套同名标签）。
 * @param {string} xml
 * @param {string} name
 * @returns {string[]}
 */
function splitBlocks (xml, name) {
  const pattern = new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'g')
  return [...xml.matchAll(pattern)].map((m) => m[1])
}

/**
 * 切出 `<name ...>inner</name>` 的「属性串 + inner」。自闭合标签也给一条空 inner，
 * 因为 `<c r="A1" s="3"/>` 这种空单元格同样占一个列号，漏了它后续列号会整体左移。
 *
 * @param {string} xml
 * @param {string} name
 * @returns {Array<{ attrs: string, inner: string }>}
 */
function splitBlocksWithAttrs (xml, name) {
  const pattern = new RegExp(
    '<' + name + '\\b([^>]*?)\\/?>([\\s\\S]*?)<\\/' + name + '>|<' + name + '\\b([^>]*?)\\/>',
    'g',
  )
  /** @type {Array<{ attrs: string, inner: string }>} */
  const out = []
  for (const match of xml.matchAll(pattern)) {
    if (match[3] !== undefined) {
      out.push({ attrs: match[3], inner: '' })
      continue
    }
    // 平衡组可能吃到 `/>` 前的斜杠，去掉它，属性解析才认得出最后一个属性
    out.push({ attrs: match[1].replace(/\/$/, ''), inner: match[2] })
  }
  return out
}

/**
 * 取标签属性值。
 * @param {string} attrsOrTag 属性串或整段标签
 * @param {string} name 属性名（含冒号的也算，如 `r:id`）
 * @returns {string | undefined}
 */
function attr (attrsOrTag, name) {
  const escaped = name.replace(/[:.]/g, (c) => '\\' + c)
  const matched = new RegExp('(?:^|\\s)' + escaped + '="([^"]*)"').exec(attrsOrTag)
  return matched ? matched[1] : undefined
}

/**
 * XML 文本反转义。`_x000D_` 是 Excel 对回车符的转义写法，一并还原，
 * 否则同一段文字在不同工具存出来的文件里算出的指纹不一样。
 * @param {string} text
 * @returns {string}
 */
export function decodeXmlText (text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/_x000D_/g, '\r')
}

/**
 * @param {Uint8Array} bytes
 * @param {import('./zip.js').ZipEntry[]} entries
 * @param {string} name
 * @returns {string | undefined}
 */
function readOptionalText (bytes, entries, name) {
  const data = readZipEntry(bytes, entries, name)
  return data ? decodeUtf8(data) : undefined
}

/**
 * @param {Uint8Array} bytes
 * @param {import('./zip.js').ZipEntry[]} entries
 * @param {string} name
 * @param {string} message
 * @returns {Uint8Array}
 */
function mustRead (bytes, entries, name, message) {
  const data = readZipEntry(bytes, entries, name)
  if (!data) throw new Error(message + '（缺条目 ' + name + '）')
  return data
}

/**
 * 宽松地接受各种「字节」输入。
 *
 * 为什么要收这么多形状：调用方可能给 `Uint8Array`（fetch 转来）、`ArrayBuffer`（fetch 直出）、
 * 或 `Buffer`（读本地文件）。多写四行，换掉一整类「明明有字节却报不是 zip」的排查。
 *
 * @param {unknown} value
 * @returns {Uint8Array}
 */
export function normalizeBytes (value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new Error('parseWpsWorkbook: bytes 必须是 Uint8Array / ArrayBuffer（xlsx 文件内容）')
}
