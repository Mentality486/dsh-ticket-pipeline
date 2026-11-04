/**
 * 第 9 节自测：飞书适配器（离线打桩，不联网）。
 *
 * 为什么单独一个文件：这一节要造一个假的飞书服务端（认证、records/search、
 * 附件下载、云文档搜索），代码量比前八节加起来还多，塞进 dev-run.mjs 会把主流程埋掉。
 *
 * 打的桩覆盖票 #12 承诺的每一条硬约束：
 * - 认证与 token 缓存
 * - 只认「是否处理 = 处理中」
 * - 水位推进、内容指纹判变更、safePageRun 停止
 * - 退役（人把状态改走 / 连续多轮不见）
 * - 截图三形态取字节
 * - docNamePattern 命中 0 张或 >1 张 = 配置错误
 * - sort 被服务端拒时兜底重试
 * - 错误码分类
 * - **绝不写回表格**
 */

import assert from 'node:assert/strict'

import {
  createFeishuSource,
  FEISHU_COLUMNS,
  IN_PROGRESS_VALUE,
} from '../src/adapters/source-feishu/index.js'

const APP_TOKEN = 'app-token-1'
const TABLE_ID = 'tbl-1'

/** 一张 PNG 的头字节（够骗过类型嗅探）。 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
])

/**
 * 造一个假的飞书服务端。
 *
 * @param {Object} [options]
 * @returns {any}
 */
function createFakeServer (options = {}) {
  /** @type {Array<{ url: string, method: string, body: any, headers: any }>} */
  const requests = []
  const state = {
    authCalls: 0,
    rejectSort: false,
    /** @type {any[]} */
    rows: options.rows ? [...options.rows] : [],
    /** @type {any[]} */
    tables: options.tables ? [...options.tables] : [],
    /** @type {any[]} */
    files: options.files ? [...options.files] : [],
    /** @type {string | null} */
    failCode: options.failCode ?? null,
    /** @type {string} */
    token: options.token ?? 't-access-token',
  }

  const jsonResponse = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => (String(key).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => payload,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(payload)).buffer,
  })

  const binaryResponse = (bytes, contentType, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => (String(key).toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => { throw new Error('not json') },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })

  const fetchImpl = async (url, init = {}) => {
    const rawUrl = String(url)
    const parsed = new URL(rawUrl)
    const path = parsed.pathname
    const method = String(init.method ?? 'GET').toUpperCase()
    let body = null
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body) } catch { body = null }
    }
    requests.push({ url: rawUrl, method, body, headers: init.headers ?? {} })

    if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
      state.authCalls += 1
      return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: state.token, expire: 7200 })
    }

    if (state.failCode !== null) {
      return jsonResponse({ code: state.failCode, msg: 'injected failure' })
    }

    if (path === '/open-apis/drive/v1/files') {
      return jsonResponse({ code: 0, data: { files: state.files, has_more: false } })
    }

    if (path.endsWith('/records/search')) {
      if (state.rejectSort && body && Array.isArray(body.sort)) {
        return jsonResponse({ code: 1254005, msg: 'sort is not supported for this field' })
      }
      return jsonResponse({ code: 0, data: { items: state.rows, has_more: false } })
    }

    if (/\/tables$/.test(path)) {
      return jsonResponse({ code: 0, data: { items: state.tables } })
    }

    if (path.includes('/open-apis/drive/v1/medias/')) {
      return binaryResponse(PNG_BYTES, 'image/png')
    }

    if (path.endsWith('.png')) {
      return binaryResponse(PNG_BYTES, 'image/png')
    }

    return jsonResponse({ code: 0, data: {} })
  }

  return { fetchImpl, requests, state }
}

/**
 * 造一行工单记录。
 *
 * @param {string} recordId
 * @param {Object} [overrides]
 * @returns {any}
 */
function makeRow (recordId, overrides = {}) {
  const status = overrides.status ?? IN_PROGRESS_VALUE
  const mtime = overrides.mtime ?? 1_700_000_000_000
  return {
    record_id: recordId,
    last_modified_time: mtime,
    fields: {
      [FEISHU_COLUMNS.seq]: '1',
      [FEISHU_COLUMNS.department]: '工程部',
      [FEISHU_COLUMNS.description]: overrides.description ?? '登录页报 500',
      [FEISHU_COLUMNS.foundAt]: mtime,
      [FEISHU_COLUMNS.module]: '登录',
      [FEISHU_COLUMNS.flow]: '打开首页 → 点登录',
      [FEISHU_COLUMNS.screenshot]: overrides.screenshot,
      [FEISHU_COLUMNS.priority]: overrides.priority ?? '高',
      [FEISHU_COLUMNS.status]: status,
      [FEISHU_COLUMNS.handler]: '',
      [FEISHU_COLUMNS.result]: '',
      [FEISHU_COLUMNS.handledAt]: '',
    },
  }
}

/**
 * 造一个带水位存储的 source。
 *
 * @param {any} server
 * @param {Object} [options]
 * @returns {any}
 */
function makeSource (server, options = {}) {
  /** @type {any} */
  const watermark = options.watermark ?? { seen: {}, lastScanAt: 0 }
  const source = createFeishuSource({
    projectId: options.projectId ?? 'demo',
    appToken: options.appToken ?? APP_TOKEN,
    tableId: options.tableId ?? TABLE_ID,
    docNamePattern: options.docNamePattern ?? '',
    getSecret: options.getSecret ?? (async (ref) => (ref === 'FEISHU_APP_ID' ? 'cli_test' : 'secret_test')),
    fetch: server.fetchImpl,
    getWatermark: async () => watermark,
    saveWatermark: async (_sourceId, value) => {
      watermark.seen = value.seen
      watermark.lastScanAt = value.lastScanAt
    },
    readLocalFile: options.readLocalFile,
    safePageRun: options.safePageRun,
    goneAfterScans: options.goneAfterScans,
  })
  return { source, watermark }
}

/**
 * 跑第 9 节的全部断言。
 *
 * @param {(name: string, fn: () => Promise<void> | void) => Promise<void>} check
 */
export async function runFeishuChecks (check) {
  await check('认证后带 Bearer 头调接口，token 会缓存不重复认证', async () => {
    const server = createFakeServer({ rows: [makeRow('rec-1')] })
    const { source } = makeSource(server)
    const signal = new AbortController().signal

    const first = await source.scan(signal)
    assert.equal(first.created.length, 1)
    assert.equal(server.state.authCalls, 1)
    const authRequest = server.requests.find((r) => r.url.includes('/auth/v3/tenant_access_token/internal'))
    assert.ok(authRequest, '应该先调认证接口')
    const searchRequest = server.requests.find((r) => r.url.includes('/records/search'))
    assert.ok(searchRequest, '应该调 records/search')
    assert.equal(searchRequest.headers.Authorization, 'Bearer t-access-token')

    await source.scan(signal)
    assert.equal(server.state.authCalls, 1, 'token 未过期就不该重新认证')
  })

  await check('records/search 用 page_size 500 + automatic_fields + 按最后更新时间降序', async () => {
    const server = createFakeServer({ rows: [makeRow('rec-1')] })
    const { source } = makeSource(server)
    await source.scan(new AbortController().signal)
    const searchRequest = server.requests.find((r) => r.url.includes('/records/search'))
    assert.equal(searchRequest.method, 'POST')
    assert.equal(searchRequest.body.page_size, 500)
    assert.equal(searchRequest.body.automatic_fields, true)
    assert.deepEqual(searchRequest.body.sort, [{ field_name: FEISHU_COLUMNS.lastModified, desc: true }])
  })

  await check('只收「是否处理 = 处理中」，是/否 都不进流水线', async () => {
    const server = createFakeServer({
      rows: [
        makeRow('rec-progress'),
        makeRow('rec-no', { status: '否' }),
        makeRow('rec-yes', { status: '是' }),
      ],
    })
    const { source } = makeSource(server)
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1)
    assert.equal(result.created[0].recordId, 'rec-progress')
    assert.equal(result.updated.length, 0)
    assert.equal(result.disappeared.length, 0)
  })

  await check('下拉字段形状不固定也能判出「处理中」', async () => {
    const row = makeRow('rec-1')
    row.fields[FEISHU_COLUMNS.status] = [{ text: IN_PROGRESS_VALUE }]
    const server = createFakeServer({ rows: [row] })
    const { source } = makeSource(server)
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1)
  })

  await check('水位推进：没变不重复入队，变了才算修订', async () => {
    const server = createFakeServer({ rows: [makeRow('rec-1')] })
    const { source } = makeSource(server)
    const signal = new AbortController().signal

    const first = await source.scan(signal)
    assert.equal(first.created.length, 1)
    assert.equal(first.updated.length, 0)

    const second = await source.scan(signal)
    assert.equal(second.created.length, 0, '没变不能重复当新票')
    assert.equal(second.updated.length, 0, '没变不能算修订')

    server.state.rows = [makeRow('rec-1', { description: '登录页报 500，改完还是 500' })]
    const third = await source.scan(signal)
    assert.equal(third.updated.length, 1, '内容变了要算修订')
    assert.equal(third.updated[0].recordId, 'rec-1')
  })

  await check('连续 safePageRun 条已知未变就停，不再往后翻页', async () => {
    const rows = []
    for (let i = 1; i <= 6; i += 1) rows.push(makeRow(`rec-${i}`))
    const server = createFakeServer({ rows })
    const signal = new AbortController().signal
    // 两个 source 共用同一份水位 —— 测的是「同一个源换个停止条件」。
    const watermark = { seen: {}, lastScanAt: 0 }

    const limited = makeSource(server, { safePageRun: 5, watermark })
    await limited.source.scan(signal)

    // 第 6 行内容变了，但因为前 5 行未变已触发停止，它根本没被访问到。
    server.state.rows = rows.map((row, index) => (
      index === 5 ? makeRow('rec-6', { description: '改过的描述' }) : row
    ))
    const stopped = await limited.source.scan(signal)
    assert.equal(stopped.updated.length, 0, '停止条件之后的行不该被访问')

    const relaxed = makeSource(server, { safePageRun: 6, watermark })
    const reached = await relaxed.source.scan(signal)
    assert.equal(reached.updated.length, 1, '放宽停止条件后这一行应该被看到')
  })

  await check('人把「处理中」改成别的值 = 退役', async () => {
    const server = createFakeServer({ rows: [makeRow('rec-1')] })
    const { source } = makeSource(server)
    const signal = new AbortController().signal

    await source.scan(signal)
    server.state.rows = [makeRow('rec-1', { status: '是' })]
    const result = await source.scan(signal)
    assert.ok(result.disappeared.includes('rec-1'), '状态改走应进 disappeared')
    assert.equal(result.created.length, 0)
  })

  await check('人把状态拨回「处理中」= 重新入队', async () => {
    const server = createFakeServer({ rows: [makeRow('rec-1', { status: '否' })] })
    const { source } = makeSource(server)
    const signal = new AbortController().signal

    const first = await source.scan(signal)
    assert.equal(first.created.length, 0, '「否」不进流水线')

    server.state.rows = [makeRow('rec-1')]
    const second = await source.scan(signal)
    assert.equal(second.created.length, 1, '拨回「处理中」应重新收票')
  })

  await check('连续 goneAfterScans 轮不见了才退役', async () => {
    const server = createFakeServer({ rows: [makeRow('rec-1')] })
    const { source, watermark } = makeSource(server, { goneAfterScans: 3 })
    const signal = new AbortController().signal

    await source.scan(signal)
    assert.ok(watermark.seen['rec-1'], '见过的行要记进水位')

    server.state.rows = []
    const first = await source.scan(signal)
    assert.equal(first.disappeared.length, 0, '第 1 轮不见还不退役')
    const second = await source.scan(signal)
    assert.equal(second.disappeared.length, 0, '第 2 轮不见还不退役')
    const third = await source.scan(signal)
    assert.ok(third.disappeared.includes('rec-1'), '第 3 轮不见才退役')
    assert.equal(watermark.seen['rec-1'], undefined, '退役后要从水位里删掉')
  })

  await check('附件形态的截图能取到字节和图片类型', async () => {
    const server = createFakeServer({ rows: [] })
    const { source } = makeSource(server)
    const loaded = await source.loadScreenshot({ kind: 'attachment', fileToken: 'ft-1', name: 'a.png' })
    assert.equal(loaded.mediaType, 'image/png')
    assert.ok(loaded.data.length >= 8)
    const download = server.requests.find((r) => r.url.includes('/open-apis/drive/v1/medias/ft-1/download'))
    assert.ok(download, '应该走附件下载接口')
    assert.equal(download.headers.Authorization, 'Bearer t-access-token')
  })

  await check('路径形态的截图走本机文件读取', async () => {
    const server = createFakeServer({ rows: [] })
    const { source } = makeSource(server, {
      readLocalFile: async (path) => ({ data: PNG_BYTES, name: 'shot.png' }),
    })
    const loaded = await source.loadScreenshot({ kind: 'path', path: 'D:/WorkSpace/shot.png' })
    assert.equal(loaded.mediaType, 'image/png')
    assert.equal(loaded.name, 'shot.png')
  })

  await check('链接形态的截图裸取（不带凭据）', async () => {
    const server = createFakeServer({ rows: [] })
    const { source } = makeSource(server)
    const loaded = await source.loadScreenshot({ kind: 'url', url: 'https://example.com/a.png' })
    assert.equal(loaded.mediaType, 'image/png')
    const download = server.requests.find((r) => r.url === 'https://example.com/a.png')
    assert.ok(download, '应该直接取那个链接')
    assert.equal(download.headers.Authorization, undefined, '链接形态不能带凭据')
  })

  await check('认不出的截图形态报 needs-info 用的 invalid-input', async () => {
    const server = createFakeServer({ rows: [] })
    const { source } = makeSource(server)
    await assert.rejects(
      () => source.loadScreenshot({ kind: 'unknown', raw: '???' }),
      (error) => error.kind === 'invalid-input',
    )
  })

  await check('docNamePattern 命中多张表 = 配置错误，不瞎猜', async () => {
    const server = createFakeServer({
      tables: [
        { table_id: 'tbl-a', name: '工单表' },
        { table_id: 'tbl-b', name: '工单表 归档' },
      ],
    })
    const { source } = makeSource(server, { tableId: '', docNamePattern: '工单表' })
    await assert.rejects(
      () => source.scan(new AbortController().signal),
      (error) => error.kind === 'invalid-input' && /匹配到 2 张表/.test(error.message),
    )
  })

  await check('docNamePattern 命中 0 张表 = 配置错误', async () => {
    const server = createFakeServer({ tables: [{ table_id: 'tbl-a', name: '别的表' }] })
    const { source } = makeSource(server, { tableId: '', docNamePattern: '工单表' })
    await assert.rejects(
      () => source.scan(new AbortController().signal),
      (error) => error.kind === 'invalid-input' && /匹配到 0 张表/.test(error.message),
    )
  })

  await check('docNamePattern 恰好命中 1 张表就用它', async () => {
    const server = createFakeServer({
      tables: [
        { table_id: 'tbl-a', name: '别的表' },
        { table_id: 'tbl-b', name: 'PMS 工单表' },
      ],
      rows: [makeRow('rec-1')],
    })
    const { source } = makeSource(server, { tableId: '', docNamePattern: '工单表' })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1)
    const search = server.requests.find((r) => r.url.includes('/records/search'))
    assert.ok(search.url.includes('/apps/' + APP_TOKEN + '/tables/tbl-b/records/search'), '应该用匹配到的那张表')
  })

  await check('只有 docNamePattern 时先在云文档里找唯一一张多维表格', async () => {
    const server = createFakeServer({
      files: [
        { token: 'doc-1', name: 'PMS 工单表', type: 'bitable' },
        { token: 'doc-2', name: '别的东西', type: 'docx' },
      ],
      tables: [{ table_id: 'tbl-x', name: '工单' }],
      rows: [makeRow('rec-1')],
    })
    const { source } = makeSource(server, { appToken: '', tableId: '', docNamePattern: 'PMS 工单表' })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1)
    const search = server.requests.find((r) => r.url.includes('/records/search'))
    assert.ok(search.url.includes('/apps/doc-1/tables/tbl-x/records/search'))
  })

  await check('服务端不认 sort 时去掉 sort 重试一次', async () => {
    const server = createFakeServer({ rows: [makeRow('rec-1')] })
    server.state.rejectSort = true
    const { source } = makeSource(server)
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1, '兜底后应该还能扫到数据')
    const searches = server.requests.filter((r) => r.url.includes('/records/search'))
    assert.equal(searches.length, 2, '应该重试一次')
    assert.ok(searches[0].body.sort, '第一次带 sort')
    assert.equal(searches[1].body.sort, undefined, '重试时去掉 sort')
  })

  await check('飞书错误码会翻成我们的错误分类', async () => {
    const server = createFakeServer({ rows: [] })
    server.state.failCode = 99991663
    const { source } = makeSource(server)
    await assert.rejects(
      () => source.scan(new AbortController().signal),
      (error) => error.kind === 'auth',
    )
  })

  await check('凭据没配就报 auth，不静默跑', async () => {
    const server = createFakeServer({ rows: [] })
    const { source } = makeSource(server, { getSecret: async () => undefined })
    await assert.rejects(
      () => source.scan(new AbortController().signal),
      (error) => error.kind === 'auth' && /未配置/.test(error.message),
    )
  })

  await check('扫描被取消时抛 aborted', async () => {
    const server = createFakeServer({ rows: [makeRow('rec-1')] })
    const { source } = makeSource(server)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => source.scan(controller.signal),
      (error) => error.kind === 'aborted',
    )
  })

  await check('绝不写回表格：全程没有对记录的写操作', async () => {
    const server = createFakeServer({ rows: [makeRow('rec-1')] })
    const { source } = makeSource(server)
    await source.scan(new AbortController().signal)
    await source.loadScreenshot({ kind: 'attachment', fileToken: 'ft-1' })

    for (const request of server.requests) {
      assert.ok(
        request.method === 'GET' || request.method === 'POST',
        `出现了 ${request.method} 请求：${request.url}`,
      )
      if (request.method === 'POST') {
        assert.ok(
          request.url.includes('/auth/v3/tenant_access_token/internal')
          || request.url.includes('/records/search'),
          `出现了写操作：${request.method} ${request.url}`,
        )
      }
      assert.ok(
        !/records\/batch_update|records\/update|records\/delete|records\/create/.test(request.url),
        `出现了记录写接口：${request.url}`,
      )
    }
  })
}
