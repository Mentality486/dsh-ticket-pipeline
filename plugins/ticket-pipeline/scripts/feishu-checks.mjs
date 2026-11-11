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
 * - **扫描绝不写回表格；回填只能走 writeResult，且只碰那三列**
 */

import assert from 'node:assert/strict'

import {
  createFeishuSource,
  feishuOptionsFromMatch,
  isSyncTableForbiddenError,
  parseBitableUrl,
  FEISHU_COLUMNS,
  IN_PROGRESS_VALUE,
} from '../src/adapters/source-feishu/index.js'
// 分支名清洗是纯函数，顺带在这里一起测：它虽然住在 core/，但唯一的调用方是拼分支名的上层，
// 而 recordId 正是从飞书适配器里出来的 —— 放在这一节能顺手验证「飞书的脏 recordId 不会炸 git」。
import { sanitizeBranchName } from '../src/core/branch-name.js'
// mock 源放在这一节测：它要跟飞书适配器**同形状**，两个实现放一起对比才看得见偏差。
import { createMockSource } from '../src/adapters/source-mock/index.js'
// 电子表格那套纯函数（表型分派的另一半）：解析配置、认列名、造行身份都在里面。
import {
  buildRowIdentity,
  buildValueRange,
  columnIndex,
  columnLetter,
  locateSheetHeader,
  normalizeSheetDate,
  parseSheetRange,
  parseSheetRows,
  resolveSheetColumns,
  resolveWorksheet,
  sheetPriorityOf,
  SHEET_COLUMN_ALIASES,
} from '../src/adapters/source-feishu/sheets.js'

const APP_TOKEN = 'app-token-1'
const TABLE_ID = 'tbl-1'

/** 一张 PNG 的头字节（够骗过类型嗅探）。 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
])

// 响应头不再只认 content-type：SSRF / 字节上限的用例要看 location 与 content-length，
// 用一个通用的小 map 让每条用例自己给需要的头。
const headerBag = (map) => ({
  get: (key) => {
    const wanted = String(key).toLowerCase()
    for (const [name, value] of Object.entries(map ?? {})) {
      if (name.toLowerCase() === wanted) return value
    }
    return null
  },
})

const jsonResponse = (payload, status = 200, extraHeaders = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: headerBag({ 'content-type': 'application/json', ...extraHeaders }),
  json: async () => payload,
  arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(payload)).buffer,
})

/**
 * 造一个二进制响应。
 *
 * @param {Uint8Array} bytes
 * @param {string} contentType
 * @param {number} [status]
 * @param {{ streaming?: boolean, extraHeaders?: Object }} [options]
 *   streaming：带上 `body.getReader()` —— 只有走这条路径才能验证「边读边累加、超限立刻断」；
 *   extraHeaders：重定向要 location，预声明大小要 content-length。
 */
const binaryResponse = (bytes, contentType, status = 200, options = {}) => {
  /** @type {any} */
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: headerBag({ 'content-type': contentType, ...(options.extraHeaders ?? {}) }),
    json: async () => { throw new Error('not json') },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
  if (options.streaming) {
    let offset = 0
    response.body = {
      getReader: () => ({
        read: async () => {
          if (offset >= bytes.byteLength) return { done: true, value: undefined }
          // 每次只吐 64 字节，模拟真实网络分块 —— 一次性吐完就测不出「边读边累加」了。
          const end = Math.min(offset + 64, bytes.byteLength)
          const value = bytes.slice(offset, end)
          offset = end
          return { done: false, value }
        },
        cancel: async () => {},
      }),
    }
  }
  return response
}

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
    /** 这些 app_token 调 tables 时报 1254003 WrongBaseToken（测 wiki 双探测回退用） */
    failAppTokens: options.failAppTokens ?? [],
    /**
     * 调 tables 接口时固定回这个错误码（测「不是多维表格就去试电子表格」用）。
     * 不设则正常回 `state.tables`。
     * @type {number | null}
     */
    tablesFailCode: options.tablesFailCode ?? null,
    /** @type {string | null} */
    failCode: options.failCode ?? null,
    /** @type {string} */
    token: options.token ?? 't-access-token',
    /**
     * 用旧 token 打业务接口时回什么（B3 用例用）。
     * 每次认证都会把 {@code token} 换成 `t-<n>`，所以旧 token 自然就"过期"了。
     * @type {number | null}
     */
    rejectStale: options.rejectStale ?? null,
    /**
     * 从第几次业务请求之后才开始吊销旧 token（B3 用例用）。
     * 冷启动第一次认证一定是好的 —— 不设这个阈值，401 根本不会发生，重取逻辑也就不被测到。
     * @type {number}
     */
    rejectAfterRequests: Number(options.rejectAfterRequests ?? 0),
    /** 认证接口被调了几次（single-flight / 重取的证据） */
    authCallsByReason: 0,
    /**
     * wiki 节点探测回什么 `obj_type`。多维表格用例用缺省 `'bitable'`；
     * 电子表格用例把它设成 `'sheet'`（或 `''` 测「老服务端不返回类型」的兜底）。
     * @type {string}
     */
    wikiNodeType: options.wikiNodeType ?? 'bitable',
    /**
     * wiki 节点探测回什么 `obj_token`。缺省沿用老行为 `btplNormal-<token>`；
     * 电子表格用例要让它等于「那张表的 spreadsheetToken」，因为飞书对知识库里的
     * 电子表格就是「obj_token 直接当 spreadsheetToken 用」。
     * @type {((token: string) => string) | null}
     */
    wikiNodeToken: options.wikiNodeToken ?? null,
    /** 云「电子表格」工作表清单（`sheets/v3/.../sheets/query` 回它） */
    /** @type {any[]} */
    sheets: options.sheets ? [...options.sheets] : [],
    /**
     * 电子表格读值回什么二维数组（`sheets/v2/.../values/{range}` 回它）。
     * @type {any[][]}
     */
    sheetValues: options.sheetValues ? options.sheetValues.map((row) => [...row]) : [],
    /**
     * 多维表格的字段名清单（工单 #21）。`null` = 回规范名那 13 个；
     * 要测「列名叫法不一样」就传一串别的名字。
     * @type {string[] | null}
     */
    fields: Array.isArray(options.fields) ? [...options.fields] : null,
    /**
     * 电子表格回填写值（`values_batch_update`）收到的请求体，一条一条攒下来。
     * 测「写到了哪一格、写的是什么」全靠它 —— 断言得看真发出去的东西，
     * 不能只看适配器返回的那句 `written: true`。
     * @type {any[]}
     */
    sheetWrites: [],
    /** 让 `values_batch_update` 回一个业务错误码（测「列少一列」之外的失败）。 */
    sheetWriteFailCode: options.sheetWriteFailCode ?? null,
    /** 让 `values_batch_update` 回一个 HTTP 错误状态（401/403 走鉴权分档）。 */
    sheetWriteHttpStatus: options.sheetWriteHttpStatus ?? null,
  }

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
      state.authCallsByReason += 1
      // 每次重新认证都换一个新 token —— 这样测试里"旧 token 已失效"是可观察的。
      if (state.rejectStale !== null) state.token = `t-${state.authCalls}`
      return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: state.token, expire: 7200 })
    }

    // B3：模拟「token 在拿到之后、用之前被服务端提前吊销」——
    // 第一次认证（authCalls === 1）之后、第二次认证之前，所有业务请求一律 401；
    // 重取（authCalls >= 2）之后带新 token 就正常。
    // 注意不能用「token 是否等于最新值」判断：业务请求永远带的就是最新 token，
    // 那样 401 永远不触发，重取逻辑根本测不到（这正是旧写法的缺陷）。
    if (state.rejectStale !== null && state.authCalls < 2 && !path.includes('/auth/v3/')) {
      return jsonResponse({ code: 99991663, msg: 'token invalid' }, state.rejectStale)
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
      const m = path.match(/\/apps\/([^/]+)\/tables/)
      const reqToken = m ? decodeURIComponent(m[1]) : ''
      if (state.tablesFailCode !== null) {
        return jsonResponse({ code: state.tablesFailCode, msg: 'injected tables failure' })
      }
      if (Array.isArray(state.failAppTokens) && state.failAppTokens.includes(reqToken)) {
        return jsonResponse({ code: 1254003, msg: 'WrongBaseToken' }, 400)
      }
      return jsonResponse({ code: 0, data: { items: state.tables } })
    }

    // —— 多维表格：字段列表（工单 #21）——
    // 适配器现在每轮扫描先问一次「这张表里的字段到底叫什么」，再按别名表映射。
    // 不 stub 这条路由的话会掉进末尾的 `{ code: 0, data: {} }` ⇒ items 为空
    // ⇒ 必需列（描述 / 状态）映射不上 ⇒ **所有老用例一起红**。
    // 缺省回规范名 13 个（`state.fields === null` 时），测「列名不一样」的用例
    // 自己把 `state.fields` 设成一串别的名字。
    if (/\/fields$/.test(path)) {
      const names = Array.isArray(state.fields)
        ? state.fields
        : Object.values(FEISHU_COLUMNS)
      return jsonResponse({
        code: 0,
        data: { items: names.map((field_name) => ({ field_name })), has_more: false },
      })
    }

    if (path.includes('/wiki/v2/spaces/get_node')) {
      const token = new URL(url, 'http://x').searchParams.get('token') ?? ''
      const objToken = state.wikiNodeToken ? state.wikiNodeToken(token) : `btplNormal-${token}`
      return jsonResponse({
        code: 0,
        data: { node: { obj_type: state.wikiNodeType, obj_token: objToken } },
      })
    }

    // —— 电子表格：工作表清单（v3、snake_case）——
    // 注意请求里 path 是 `/sheets/v3/spreadsheets/{token}/sheets/query`，
    // token 那一段可能被 encodeURIComponent 过，所以先解码再比。
    if (/\/sheets\/v3\/spreadsheets\/[^/]+\/sheets\/query$/.test(path)) {
      return jsonResponse({ code: 0, data: { sheets: state.sheets } })
    }

    // —— 电子表格：读值（v2、camelCase）与回填写值（工单 #22）——
    // path 形如 `/sheets/v2/spreadsheets/{token}/values/{sheetId}!A1:M500`，
    // `!` 与 `:` 是**不编码**的（飞书要求原样），所以这里直接截 `values/` 之后那一段。
    //
    // 回填走的是 `values_batch_update`（POST），必须和读值分开分支：混在一个分支里
    // 写请求会被当成读、回一份「成功读到数据」，于是「回填失败」这个场景永远测不出来。
    if (path.includes('/values_batch_update')) {
      if (state.sheetWriteFailCode !== null) {
        return jsonResponse({ code: state.sheetWriteFailCode, msg: 'injected sheet write failure' })
      }
      if (state.sheetWriteHttpStatus !== null) {
        return jsonResponse({ code: 0, msg: 'forbidden' }, state.sheetWriteHttpStatus)
      }
      state.sheetWrites.push(body)
      return jsonResponse({ code: 0, data: { responses: [] } })
    }

    if (path.includes('/sheets/v2/spreadsheets/') && path.includes('/values/')) {
      return jsonResponse({
        code: 0,
        data: { valueRange: { values: state.sheetValues } },
      })
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
    // 状态值集合：不同表的约定不一样（「处理中」「否」「待处理」都有），
    // 所以它是可配的；不传就走适配器缺省（IN_PROGRESS_VALUE）。
    statusValues: options.statusValues,
    // 收窄开关：只收名单里的行。
    recordIds: options.recordIds,
    getSecret: options.getSecret ?? (async (ref) => (ref === 'FEISHU_APP_ID' ? 'cli_test' : 'secret_test')),
    // 允许用例在 createFakeServer 之外再包一层（比如注入挂起不返回的 fetch 来测超时）。
    fetch: options.fetch ?? server.fetchImpl,
    getWatermark: async () => watermark,
    saveWatermark: async (_sourceId, value) => {
      watermark.seen = value.seen
      watermark.lastScanAt = value.lastScanAt
    },
    readLocalFile: options.readLocalFile,
    // url 形态截图默认一律拒绝（SSRF 防线），用例要测它就必须显式放行主机。
    // 注意 `in` 而不是 `??`：SSRF 用例要验证「白名单为空 = 一律拒绝」，
    // 写成 ?? 就没法用 [] 显式覆盖默认值了。
    allowedImageHosts: 'allowedImageHosts' in options ? options.allowedImageHosts : ['example.com'],
    safePageRun: options.safePageRun,
    goneAfterScans: options.goneAfterScans,
    // —— 飞书电子表格（表型分派）——
    // 这些键原样透传，让用例能分别构造「电子表格」「显式表型」「表头行在第 2 行」等场景。
    spreadsheetToken: options.spreadsheetToken,
    sheetId: options.sheetId,
    sheetName: options.sheetName,
    sheetHeaderRow: options.sheetHeaderRow,
    sheetIdentity: options.sheetIdentity,
    sheetIdColumn: options.sheetIdColumn,
    sheetColumns: options.sheetColumns,
    // 多维表格的列名覆盖（工单 #21）。和 sheetColumns 分开透传，两种表型各用各的键。
    columns: options.columns,
    sheetRange: options.sheetRange,
    tableKind: options.tableKind,
    // —— task-9 新增：这些参数不透传，离线打桩就测不到超时 / 字节上限 / 日志 ——
    requestTimeoutMs: options.requestTimeoutMs,
    imageTimeoutMs: options.imageTimeoutMs,
    maxBytes: options.maxBytes,
    log: options.log,
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

  await check('状态值集合可配：配成「否」就只收「否」，不收「处理中」', async () => {
    const server = createFakeServer({
      rows: [
        makeRow('rec-no', { status: '否' }),
        makeRow('rec-progress', { status: IN_PROGRESS_VALUE }),
        makeRow('rec-yes', { status: '是' }),
      ],
    })
    const { source } = makeSource(server, { statusValues: ['否'] })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1, '只有「否」那一行该进来')
    assert.equal(result.created[0].recordId, 'rec-no')
  })

  await check('状态值集合可配：单值形态（写一个字符串）也认', async () => {
    const server = createFakeServer({
      rows: [makeRow('rec-no', { status: '否' }), makeRow('rec-progress', { status: IN_PROGRESS_VALUE })],
    })
    const { source } = makeSource(server, { statusValues: '否' })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1)
    assert.equal(result.created[0].recordId, 'rec-no')
  })

  await check('状态值集合可配：多个值都算「在处理中」', async () => {
    const server = createFakeServer({
      rows: [
        makeRow('rec-a', { status: '否' }),
        makeRow('rec-b', { status: '待处理' }),
        makeRow('rec-c', { status: '是' }),
      ],
    })
    const { source } = makeSource(server, { statusValues: ['否', '待处理'] })
    const result = await source.scan(new AbortController().signal)
    assert.deepEqual(result.created.map((t) => t.recordId).sort(), ['rec-a', 'rec-b'])
  })

  await check('状态值集合可配：配了空集合就退回缺省，不会把整张空表收成满屏票', async () => {
    const server = createFakeServer({ rows: [makeRow('rec-progress'), makeRow('rec-blank', { status: '' })] })
    const { source } = makeSource(server, { statusValues: [] })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1, '只该收默认的「处理中」那一行')
    assert.equal(result.created[0].recordId, 'rec-progress')
  })

  await check('收窄开关：只收名单里的行，名单外的整行不进来', async () => {
    const server = createFakeServer({
      rows: [
        makeRow('rec-a'),
        makeRow('rec-b'),
        makeRow('rec-c'),
      ],
    })
    const { source } = makeSource(server, { recordIds: ['rec-b'] })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1, '只有名单里那一行该进来')
    assert.equal(result.created[0].recordId, 'rec-b')
  })

  await check('收窄开关：单值形态（写一个字符串）也认', async () => {
    const server = createFakeServer({ rows: [makeRow('rec-a'), makeRow('rec-b')] })
    const { source } = makeSource(server, { recordIds: 'rec-a' })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1)
    assert.equal(result.created[0].recordId, 'rec-a')
  })

  await check('收窄开关：不给就等于不收窄（整张表照收，不回归旧行为）', async () => {
    const server = createFakeServer({ rows: [makeRow('rec-a'), makeRow('rec-b')] })
    const { source } = makeSource(server)
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 2, '没配收窄就该收下整张表')
  })

  await check('收窄开关：名单外的行不进水位，也不会被误判成「已删除」', async () => {
    // 为什么：收窄期间名单外的行这一轮「没出现」，但它不是被删了。
    // 若照样累加 missingScans，扫过 goneAfterScans 轮后它会被标成 gone（票被收尾），
    // 而人根本没打算动它。
    const server = createFakeServer({ rows: [makeRow('rec-keep'), makeRow('rec-other')] })
    const { source, watermark } = makeSource(server, { recordIds: ['rec-keep'], goneAfterScans: 2 })
    const signal = new AbortController().signal
    const first = await source.scan(signal)
    assert.equal(first.created.length, 1)
    assert.equal(first.disappeared.length, 0)
    assert.equal(watermark.seen['rec-other'], undefined, '名单外的行整轮跳过，不进水位')

    // 第二轮起：名单外的行不再返回（模拟它在表里被移走），但名单里的还在。
    server.state.rows = server.state.rows.filter((row) => row.record_id === 'rec-keep')
    const second = await source.scan(signal)
    assert.equal(second.disappeared.length, 0, '名单外的行不该被退役')
    const third = await source.scan(signal)
    assert.equal(third.disappeared.length, 0, '连续多轮也不该退役')
  })

  await check('收窄开关：先不收窄建好水位、再打开收窄，旧的名单外票不会被收尾', async () => {
    // 为什么：收窄通常是「先跑一阵子，再挑一单试点」时才打开的。
    // 这时水位里已经有别的票了；若收窄让它们开始累积「连续没出现」，
    // 几轮之后那些根本没打算动的票会被标成 gone（票被收尾，等于被人悄悄处理掉了）。
    const server = createFakeServer({ rows: [makeRow('rec-keep'), makeRow('rec-other')] })
    const watermark = { seen: {}, lastScanAt: 0 }
    const signal = new AbortController().signal

    const wide = makeSource(server, { watermark, goneAfterScans: 2 })
    await wide.source.scan(signal)
    assert.ok(watermark.seen['rec-other'], '不收窄时，别的行也要记进水位')

    server.state.rows = server.state.rows.filter((row) => row.record_id === 'rec-keep')
    const narrow = makeSource(server, { watermark, recordIds: ['rec-keep'], goneAfterScans: 2 })
    const second = await narrow.source.scan(signal)
    assert.equal(second.disappeared.length, 0, '收窄期间，名单外的旧票不该被退役')
    const third = await narrow.source.scan(signal)
    assert.equal(third.disappeared.length, 0, '连续多轮也不该退役')
    assert.ok(watermark.seen['rec-other'], '名单外的旧票还留在水位里，没被收尾')
  })

  await check('收窄开关：名单里的行真被删了，照样会退役', async () => {
    const server = createFakeServer({ rows: [makeRow('rec-keep')] })
    const { source } = makeSource(server, { recordIds: ['rec-keep'], goneAfterScans: 2 })
    const signal = new AbortController().signal
    await source.scan(signal)
    server.state.rows = []
    const second = await source.scan(signal)
    assert.equal(second.disappeared.length, 0, '第一轮只算一次')
    const third = await source.scan(signal)
    assert.deepEqual(third.disappeared, ['rec-keep'], '连续两轮不见就该退役')
  })

  await check('收窄开关：空数组是配置错误，不能当成「不收窄」把整张表收下', async () => {
    const server = createFakeServer({ rows: [makeRow('rec-a')] })
    assert.throws(
      () => makeSource(server, { recordIds: [] }),
      (error) => error.kind === 'invalid-input' && /recordIds/.test(error.message),
    )
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

  await check('wiki URL 的 token 不以 wiki 开头（如 RXEP…）也必须走换算 —— 真实用户场景回归', async () => {
    const server = createFakeServer({
      tables: [{ table_id: 'tbl-a', name: '工单表' }],
      rows: [makeRow('rec-1')],
    })
    const { source } = makeSource(server, {
      appToken: 'https://vcn6ijgss3oy.feishu.cn/wiki/RXEPwwUePiyV7zkeo6hc5nQinfh?fromScene=spaceOverview',
      tableId: '',
      docNamePattern: '工单表',
    })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1)
    const nodeRequest = server.requests.find((r) => r.url.includes('/wiki/v2/spaces/get_node'))
    assert.ok(nodeRequest, '非 wiki 前缀的 wiki URL token 也要调 get_node')
    assert.ok(nodeRequest.url.includes('token=RXEPwwUePiyV7zkeo6hc5nQinfh'), '应该把 RXEP… token 传给 get_node')
    const tablesRequest = server.requests.find((r) => /\/bitable\/v1\/apps\/[^/]+\/tables\?/.test(r.url))
    assert.ok(tablesRequest?.url.includes('btplNormal-RXEPwwUePiyV7zkeo6hc5nQinfh'), '应该用 obj_token 访问表')
  })

  await check('wiki 链接形式的 appToken 会先换算成 obj_token 再访问表', async () => {
    const server = createFakeServer({
      tables: [{ table_id: 'tbl-a', name: '工单表' }],
      rows: [makeRow('rec-1')],
    })
    const { source } = makeSource(server, {
      appToken: 'https://vcn6ijgss3oy.feishu.cn/wiki/WIKITOKEN123?fromScene=spaceOverview',
      tableId: '',
      docNamePattern: '工单表',
    })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1)
    const nodeRequest = server.requests.find((r) => r.url.includes('/wiki/v2/spaces/get_node'))
    assert.ok(nodeRequest, '应该调 wiki get_node 换算')
    assert.ok(nodeRequest.url.includes('token=WIKITOKEN123'), '应该把 URL 里抠出的 wiki token 传给 get_node')
    const tablesRequest = server.requests.find((r) => /\/bitable\/v1\/apps\/[^/]+\/tables/.test(r.url))
    assert.ok(tablesRequest, '应该调 tables')
    assert.ok(tablesRequest.url.includes('btplNormal-WIKITOKEN123'), '应该用换算出的 obj_token 访问表')
  })

  await check('wiki token（非 URL）也能换算', async () => {
    const server = createFakeServer({
      tables: [{ table_id: 'tbl-a', name: '工单表' }],
      rows: [makeRow('rec-1')],
    })
    const { source } = makeSource(server, {
      appToken: 'wikiWIKITOKEN456',
      tableId: '',
      docNamePattern: '工单表',
    })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1)
    const tablesRequest = server.requests.find((r) => /\/bitable\/v1\/apps\/[^/]+\/tables/.test(r.url))
    assert.ok(tablesRequest?.url.includes('btplNormal-wikiWIKITOKEN456'), 'wiki token 应换算成 obj_token')
  })

  await check('obj_token 无效时回退用原 wiki token（新版 wiki base）', async () => {
    const server = createFakeServer({
      tables: [{ table_id: 'tbl-a', name: '工单表' }],
      rows: [makeRow('rec-1')],
      failAppTokens: ['btplNormal-WIKITOKEN789'],
    })
    const { source } = makeSource(server, {
      appToken: 'https://x.feishu.cn/wiki/WIKITOKEN789',
      tableId: '',
      docNamePattern: '工单表',
    })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1)
    const tablesCalls = server.requests.filter((r) => /\/bitable\/v1\/apps\/[^/]+\/tables\?/.test(r.url))
    assert.equal(tablesCalls.length, 2, '应该先试 obj_token 失败，再回退试 wiki token')
    assert.ok(tablesCalls[0].url.includes('btplNormal-WIKITOKEN789'), '第一次用 obj_token')
    assert.ok(tablesCalls[1].url.includes('/apps/WIKITOKEN789/'), '第二次回退用原 wiki token')
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

  await check('早停时没访问到的行不算「不见了」，不许进阶退役', async () => {
    // 回归 B1：翻页循环早停（连续 safePageRun 条已知未变）后，后面没请求过的行不进 live。
    // 若照样给它们累加 missingScans，一张静止的表扫几轮就会把后半批行全当删除地误退役。
    const rows = []
    for (let i = 1; i <= 12; i += 1) rows.push(makeRow(`rec-${i}`))
    const server = createFakeServer({ rows })
    const { source, watermark } = makeSource(server, { safePageRun: 5, goneAfterScans: 2 })
    const signal = new AbortController().signal

    // 第一轮全新建水位，12 行都算新票。
    const first = await source.scan(signal)
    assert.equal(first.created.length, 12, '第一轮应该收下全部 12 行')
    assert.equal(first.disappeared.length, 0)

    // 第二、三轮内容完全不变：第 5 行之后就会早停，rec-7..rec-12 根本没被请求到。
    // goneAfterScans = 2，若早停后仍累加 missingScans，这两轮就足以把它们误退役。
    for (let round = 2; round <= 3; round += 1) {
      const result = await source.scan(signal)
      assert.equal(result.disappeared.length, 0, `第 ${round} 轮是早停，没访问到的行不是删除，不该退役任何一行`)
      assert.equal(result.created.length, 0, `第 ${round} 轮内容没变，不该重复收票`)
      assert.equal(result.updated.length, 0, `第 ${round} 轮内容没变，不该算修订`)
    }
    for (let i = 7; i <= 12; i += 1) {
      assert.ok(watermark.seen[`rec-${i}`], `rec-${i} 在早停轮里没被访问到，必须留在水位里（否则下一轮会被当成新票或已删除）`)
    }
    assert.equal(watermark.seen['rec-6'].missingScans, 0, '被早停截断的轮次不能推进 missingScans')
  })

  await check('真删的行在完整扫完的轮次里照旧退役', async () => {
    // 回归 B1 的反面：只允许「没早停的轮次」判删除，但真删了必须照样退役，不能因为加了守卫就不再收尸。
    // safePageRun 调到上限 99，保证只剩 3 行时不会早停，走的是完整扫完整条表的路径。
    const allRows = []
    for (let i = 1; i <= 6; i += 1) allRows.push(makeRow(`rec-${i}`))
    const server = createFakeServer({ rows: allRows })
    const { source, watermark } = makeSource(server, { safePageRun: 99, goneAfterScans: 2 })
    const signal = new AbortController().signal

    const first = await source.scan(signal)
    assert.equal(first.created.length, 6, '第一轮应该收下 6 行')

    // 只剩 rec-1..rec-3，且内容与之前完全一致 —— 既不会早停，miss 的只有真正的删除。
    server.state.rows = [makeRow('rec-1'), makeRow('rec-2'), makeRow('rec-3')]
    const second = await source.scan(signal)
    assert.equal(second.disappeared.length, 0, '第 1 轮不见还不退役（goneAfterScans = 2）')

    const third = await source.scan(signal)
    assert.ok(third.disappeared.includes('rec-6'), '第 2 轮完整扫完仍不见，rec-6 必须退役')
    assert.equal(third.disappeared.length, 3, 'rec-4 / rec-5 / rec-6 应该一起退役')
    assert.equal(watermark.seen['rec-6'], undefined, '退役后要从水位里删掉')
    assert.ok(watermark.seen['rec-1'], '仍在表里的行不能被误删')
  })

  await check('处理中的行内容变了要报修订；在「否」期间改的内容不算丢', async () => {
    // 回归 B2 的正反两面：
    // 正面（本用例）：同一行始终「处理中」，内容变了必须真的报 updated —— 指纹只能在收下修订之后才更新，
    //   否则第一次修订之后指纹就和内容对齐了，人再改一次就永远收不到。
    // 反面（下一个用例）：非「处理中」的行在「否」期间改的内容，拨回「处理中」时要按「新票」收下来
    //   （见 P0 语义：拨回处理中 = 人工重置 = 重新收票），不能被旧的「已更新指纹」吞掉。
    const server = createFakeServer({ rows: [makeRow('rec-1')] })
    const { source } = makeSource(server)
    const signal = new AbortController().signal

    const first = await source.scan(signal)
    assert.equal(first.created.length, 1, '首轮收票')
    assert.equal(first.updated.length, 0)

    server.state.rows = [makeRow('rec-1', { description: '登录页报 500，还多了个 502' })]
    const second = await source.scan(signal)
    assert.equal(second.updated.length, 1, '内容变了要算修订')
    assert.equal(second.updated[0].recordId, 'rec-1')
    assert.equal(second.updated[0].description, '登录页报 500，还多了个 502')

    server.state.rows = [makeRow('rec-1', { description: '登录页报 500，还多了个 502 和 503' })]
    const third = await source.scan(signal)
    assert.equal(third.updated.length, 1, '第二次修订也必须收得到（指纹没被提前消耗掉）')
    assert.equal(third.updated[0].description, '登录页报 500，还多了个 502 和 503')
  })

  await check('「否」期间改过的内容，拨回「处理中」时按新票收下来', async () => {
    // 回归 B2：以前 prev.fingerprint 在「是否处理」判定之前就更新了，
    // 「否」期间改过的内容会被永久吞掉 —— 拨回「处理中」时指纹已与内容对齐，
    // 既收不到 updated 也收不到 created，这张票就再也回不来了。
    const server = createFakeServer({ rows: [makeRow('rec-1', { status: '否' })] })
    const { source } = makeSource(server)
    const signal = new AbortController().signal

    const first = await source.scan(signal)
    assert.equal(first.created.length, 0, '「否」= 待认领，不进流水线')

    server.state.rows = [makeRow('rec-1', { status: '否', description: '登录页报 500，还多了个 502' })]
    const second = await source.scan(signal)
    assert.equal(second.created.length, 0, '还是「否」，不该收票')
    assert.equal(second.updated.length, 0, '不是「处理中」的行不产生修订')

    server.state.rows = [makeRow('rec-1', { status: IN_PROGRESS_VALUE, description: '登录页报 500，还多了个 502' })]
    const third = await source.scan(signal)
    const collected = third.created.length + third.updated.length
    assert.equal(collected, 1, '拨回「处理中」必须把这张票收回来，不能因为「否」期间改过内容就丢掉')
    assert.equal(third.created[0].recordId, 'rec-1')
    assert.equal(third.created[0].description, '登录页报 500，还多了个 502', '收下来的应该是改过的新内容')
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

  await check('恶意截图链接不许让服务器去请求内网（SSRF 白名单）', async () => {
    // 为什么这么重要：截图地址是**填表的人**写的，等于外部输入。
    // 不加白名单，一条 `http://169.254.169.254/latest/meta-data/` 就能让插件替人读云元数据。
    const server = createFakeServer({ rows: [] })

    // 用例 1：白名单为空（默认）时，任何 url 形态都拒绝，并提示改用附件。
    const { source: closed } = makeSource(server, { allowedImageHosts: [] })
    await assert.rejects(
      () => closed.loadScreenshot({ kind: 'url', url: 'https://example.com/a.png' }),
      (error) => error.kind === 'invalid-input' && /allowedImageHosts/.test(error.message),
      '白名单为空时必须直接拒绝，而且错误信息要说清是配置没放行（不是网络问题）',
    )

    // 用例 2：白名单放行 example.com 后，打内网地址必须被拒，而且**一个请求都不能发出去**。
    const { source: opened } = makeSource(server, { allowedImageHosts: ['example.com'] })
    const before = server.requests.length
    await assert.rejects(
      () => opened.loadScreenshot({ kind: 'url', url: 'http://169.254.169.254/latest/meta-data/' }),
      (error) => error.kind === 'invalid-input' && /白名单/.test(error.message),
      '内网地址必须在发请求之前就被拦下',
    )
    assert.equal(server.requests.length, before, '被拦下的地址不能真的发出请求（否则白名单形同虚设）')

    // 用例 3：非 http/https 协议（file: 能读本地文件）一律拒。
    await assert.rejects(
      () => opened.loadScreenshot({ kind: 'url', url: 'file:///etc/passwd' }),
      (error) => error.kind === 'invalid-input' && /http/.test(error.message),
      'file: 协议必须在协议层就被拒，不能走到 fetch',
    )

    // 用例 4：放行的主机照常能取到图，证明白名单不是「一律拒绝」。
    const loaded = await opened.loadScreenshot({ kind: 'url', url: 'https://example.com/a.png' })
    assert.equal(loaded.mediaType, 'image/png')
  })

  await check('重定向每一跳都重新校验主机，跳满 3 次就拒', async () => {
    // 为什么不能交给 fetch 自己 follow：放行 cdn.example.com 之后，它 302 到 127.0.0.1，
    // 白名单就白设了。必须手动跟跳、每跳重新过白名单。
    const server = createFakeServer({ rows: [] })
    const realFetch = server.fetchImpl
    const hops = []
    const fetchImpl = async (url, init) => {
      const raw = String(url)
      hops.push(raw)
      if (raw === 'https://cdn.example.com/a.png') {
        return {
          ok: false,
          status: 302,
          headers: { get: (key) => (String(key).toLowerCase() === 'location' ? 'http://127.0.0.1/admin' : null) },
          json: async () => ({}),
        }
      }
      return realFetch(raw, init)
    }
    const { source } = makeSource(server, {
      allowedImageHosts: ['cdn.example.com', 'example.com'],
      fetch: fetchImpl,
    })

    await assert.rejects(
      () => source.loadScreenshot({ kind: 'url', url: 'https://cdn.example.com/a.png' }),
      (error) => error.kind === 'invalid-input' && /白名单/.test(error.message),
      '第一跳在白名单里，但跳到 127.0.0.1 的**第二跳**必须被拒',
    )
    assert.ok(
      !hops.includes('http://127.0.0.1/admin'),
      '内网跳转目标绝不能被真的请求（说明校验发生在发请求之前）',
    )

    // 无限重定向：每一跳都在白名单里但一直跳，最多 3 跳后必须放弃。
    let redirectCount = 0
    const loopingFetch = async () => {
      redirectCount += 1
      return {
        ok: false,
        status: 302,
        headers: { get: () => 'https://cdn.example.com/loop' },
        json: async () => ({}),
      }
    }
    const { source: looping } = makeSource(server, {
      allowedImageHosts: ['cdn.example.com'],
      fetch: loopingFetch,
    })
    await assert.rejects(
      () => looping.loadScreenshot({ kind: 'url', url: 'https://cdn.example.com/loop' }),
      (error) => error.kind === 'invalid-input' && /重定向/.test(error.message),
      '一直重定向必须被判成可疑链接，不能无限跟',
    )
    // 首次请求 + 最多 3 跳 = 4 次；再多就是没拦住。
    assert.ok(redirectCount <= 4, `最多跟 3 跳，实际请求了 ${redirectCount} 次`)
  })

  await check('附件下载有字节上限，超了不吞内存直接报错', async () => {
    // 为什么：原来的 arrayBuffer() 会先把整个附件读进内存再判断大小，
    // 一个几百 MB 的附件足以把进程打爆 —— 上限必须在**读的过程中**生效。
    const server = createFakeServer({ rows: [] })
    const big = new Uint8Array(4096)
    // 注意只能拦**下载**这一条：把整个 fetch 换掉会把认证请求也一起吞了，
    // 那样报出来的是「认证响应不是 JSON」，测不到字节上限本身。
    const fakeFetch = async (url, init) => (
      String(url).includes('/medias/')
        ? binaryResponse(big, 'image/png', 200, { streaming: true })
        : server.fetchImpl(url, init)
    )
    const { source } = makeSource(server, { maxBytes: 1024, fetch: fakeFetch })

    await assert.rejects(
      () => source.loadScreenshot({ kind: 'attachment', fileToken: 'ft-big' }),
      (error) => error.kind === 'invalid-input' && /太大/.test(error.message) && /上限 1024 字节/.test(error.message),
      '超过上限要报 invalid-input 并写清是哪个资源超了多少',
    )
  })

  await check('url 截图同样受字节上限约束（流式边读边累加）', async () => {
    const server = createFakeServer({ rows: [] })
    const big = new Uint8Array(4096)
    const target = 'https://example.com/a.png'
    const fakeFetch = async (url, init) => (
      String(url) === target
        ? binaryResponse(big, 'image/png', 200, { streaming: true })
        : server.fetchImpl(url, init)
    )
    const { source } = makeSource(server, { maxBytes: 1024, fetch: fakeFetch, allowedImageHosts: ['example.com'] })

    await assert.rejects(
      () => source.loadScreenshot({ kind: 'url', url: target }),
      (error) => error.kind === 'invalid-input' && /太大/.test(error.message) && /上限 1024 字节/.test(error.message),
      'url 形态也是外部输入，必须有同样的上限',
    )
  })

  await check('token 失效（401）会清缓存、重取一次再重试，且只重取一次', async () => {
    // 为什么：token 在有效期边缘被服务端提前吊销时，整轮扫描会直接 auth 失败；
    // 正确做法是重取一次再试，而不是把整轮扫描判死。但也不能无限重试。
    // rejectAfterRequests: 1 —— 第一次认证是好的，从第二个请求（第一次 records/search）起才 401。
    const server = createFakeServer({ rows: [makeRow('rec-1')], rejectStale: 401, rejectAfterRequests: 1 })
    const { source } = makeSource(server)

    const result = await source.scan()
    assert.equal(result.created.length, 1, '重取 token 之后应该照常扫到票')
    assert.ok(server.state.authCalls >= 2, `至少要重新认证一次，实际 ${server.state.authCalls} 次`)

    // 再扫一轮：token 现在是对的，不该再为了一次 401 反复认证。
    const callsBefore = server.state.authCalls
    await source.scan()
    assert.equal(server.state.authCalls, callsBefore, 'token 仍然有效时不该平白认证')
  })

  await check('重取之后仍被拒就报 auth，不会无限重试', async () => {
    const server = createFakeServer({ rows: [] })
    // 无论拿什么 token 都 403：模拟「真的没权限」。
    const alwaysForbidden = async () => ({
      ok: false,
      status: 403,
      headers: { get: () => null },
      json: async () => ({ code: 0 }),
    })
    const { source } = makeSource(server, { fetch: alwaysForbidden })
    await assert.rejects(
      () => source.scan(),
      (error) => error.kind === 'auth',
      '重试一次后仍拒绝，必须收敛成 auth 错误，而不是死循环',
    )
  })

  await check('并发拿 token 只换一次（single-flight）', async () => {
    // 为什么：scan 与 loadScreenshot 是并发调用的，冷启动时它们会同时打认证接口，
    // 飞书对这个接口有频率限制。在途 Promise 必须复用。
    const server = createFakeServer({ rows: [makeRow('rec-1')] })
    const { source } = makeSource(server)
    await Promise.all([
      source.scan(),
      source.loadScreenshot({ kind: 'attachment', fileToken: 'ft-1' }),
      source.loadScreenshot({ kind: 'attachment', fileToken: 'ft-2' }),
    ])
    assert.equal(server.state.authCalls, 1, `并发的三次调用只该认证一次，实际 ${server.state.authCalls} 次`)
  })

  await check('请求超时会收敛成 network 错误，而不是永远挂着', async () => {
    // 为什么：fetch 本身没有超时，服务端不回包时整轮扫描会挂着不走，
    // 上层既看不到失败也等不到结果。必须自己带头。
    const server = createFakeServer({ rows: [] })
    // 一个永不 resolve、但尊重 abort 信号的 fetch —— 模拟卡死的连接。
    // 注意：Promise 里要放一个 ref'ed 的 keepAlive 定时器撑住事件循环 ——
    // AbortSignal.timeout 的定时器是不撑循环的，循环一空进程就静默退出，
    // 超时永远等不到，用例会以「unsettled top-level await」挂死（dev-run 65 ✓ 后 exit 0 的元凶）。
    const hangingFetch = (_url, init = {}) => new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => {}, 10_000)
      const signal = init.signal
      const bail = (reason) => { clearTimeout(keepAlive); reject(signal.reason ?? reason) }
      if (signal?.aborted) return bail(new Error('aborted'))
      signal?.addEventListener?.('abort', () => bail(new Error('aborted')), { once: true })
    })
    const { source } = makeSource(server, { fetch: hangingFetch, requestTimeoutMs: 20 })
    await assert.rejects(
      () => source.scan(),
      (error) => error.kind === 'network' || error.kind === 'aborted',
      '卡死的请求必须在超时后以错误结束，不能永远 pending',
    )
  })

  await check('调用方的 signal 会透传到请求层，取消能立刻生效', async () => {
    // 为什么：内核取消整轮扫描时，正在飞的请求必须立刻断，不能等它自己超时。
    const server = createFakeServer({ rows: [] })
    const seenSignals = []
    const hangingFetch = (_url, init = {}) => new Promise((resolve, reject) => {
      seenSignals.push(init.signal)
      const signal = init.signal
      if (signal?.aborted) return reject(new Error('aborted'))
      signal?.addEventListener?.('abort', () => reject(new Error('aborted')), { once: true })
    })
    const { source } = makeSource(server, { fetch: hangingFetch, requestTimeoutMs: 60_000 })
    const controller = new AbortController()
    const pending = source.scan(controller.signal)
    // 让请求先飞出去，再取消。
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    await assert.rejects(() => pending, (error) => error.kind === 'aborted' || error.kind === 'network')
    assert.ok(seenSignals.length > 0, '请求层应该收到 signal')
    assert.ok(seenSignals.every((signal) => signal && typeof signal === 'object'), '传下去的必须是真正的 AbortSignal')
  })

  await check('safePageRun 不再被偷偷钳到 5（配置写多少就跑多少）', async () => {
    // 为什么：以前 Math.max(5, ...) 会把配置里的 2 改成 5，人按 2 排的页数预期全都对不上，
    // 出问题很难查。现在直接用配置值，并 log 一次生效值方便对账。
    const logs = []
    const server = createFakeServer({ rows: [] })
    makeSource(server, { safePageRun: 2, log: (...args) => logs.push(args) })
    assert.ok(
      logs.some((args) => args[1] && args[1].safePageRun === 2),
      `应该 log 出实际生效的 safePageRun=2，实际日志：${JSON.stringify(logs)}`,
    )
  })

  await check('分支名清洗：空格 / 中文 / 斜杠 / 超长都不会让 git worktree add 失败', async () => {
    // 为什么：分支名由 recordId 拼出来，recordId 是手填的，含空格或中文会让 git 直接拒绝。
    assert.equal(sanitizeBranchName('rec-1'), 'rec-1', '本来就合法的名字不该被改')
    assert.equal(sanitizeBranchName('rec 1 bug'), 'rec-1-bug', '空格要变成 -')
    assert.equal(sanitizeBranchName('工单-登录故障'), 'ticket', '全是中文时没有可用字符，回退成 ticket')
    assert.equal(
      sanitizeBranchName('feature/login/rec-1'),
      'feature/login/rec-1',
      '斜杠是有意分层（branchPrefix 会用到），必须原样保留',
    )
    assert.equal(sanitizeBranchName('--abc--'), 'abc', '首尾的 - 是替换残留，要去掉')
    assert.equal(sanitizeBranchName('a---b'), 'a-b', '连续 - 要合并')
    assert.equal(sanitizeBranchName('a..b'), 'a.b', '.. 在 git ref 里非法，要折成 .')
    assert.equal(sanitizeBranchName(''), 'ticket', '空串要兜底')
    assert.equal(sanitizeBranchName(null), 'ticket', 'null 也要兜底，不能抛')
    assert.equal(sanitizeBranchName('///'), 'ticket', '只剩分隔符仍然是非法 ref，必须兜底')
    const long = sanitizeBranchName('a'.repeat(500))
    assert.equal(long.length, 200, '超长的要截到 200，别撞路径上限')
    assert.ok(!/-$/.test(long), '截断后不能以 - 结尾')
    const dirty = sanitizeBranchName('rec 9 / 登录 * 故障')
    assert.ok(!/[^A-Za-z0-9._/-]/.test(dirty), `清洗后不能残留非法字符：${dirty}`)
  })

  // ——————————————————————————————————————————————————————————————
  // 回填（writeResult）：本文件里**唯一**允许的写操作，所以断言要盯死三件事 ——
  // 打的是哪条接口、写的是哪三列、失败时吐的是回执还是异常。
  // 上面那条「绝不写回表格」的用例只覆盖 scan / loadScreenshot，
  // 这里补的是另一个方向：scan 一步不动表，回填只动那三列。
  // ——————————————————————————————————————————————————————————————

  await check('回填：PUT 打 records/{recordId}，只写「是否处理 / 处理结果 / 处理日期」三列', async () => {
    // 为什么盯 method 和 path：飞书回填记录的写法有好几种（batch_update、update、PUT records/{id}），
    // 选错一个就会在真环境里写错行或写错表。契约只承诺「把结果落到这张票上」，
    // 具体接口是适配器的实现细节 —— 而实现细节错了，在离线用例里就该先炸。
    const server = createFakeServer({ rows: [makeRow('rec-1')] })
    const { source } = makeSource(server)

    assert.equal(typeof source.writeResult, 'function', 'writeResult 是契约里的可选能力，飞书源必须提供')

    const receipt = await source.writeResult('rec-1', { result: '已修好，加了空值保护' })
    assert.equal(receipt.written, true, '写成功要回 written:true')
    assert.deepEqual(
      [...receipt.fields].sort(),
      [FEISHU_COLUMNS.status, FEISHU_COLUMNS.result, FEISHU_COLUMNS.handledAt].sort(),
      '回执里的字段名必须是这三个中文列名（人对着表格能直接对上）',
    )

    const put = server.requests.find((request) => request.method === 'PUT')
    assert.ok(put, `回填没发出 PUT 请求，实际请求：${server.requests.map((r) => `${r.method} ${r.url}`).join(', ')}`)
    assert.ok(
      put.url.endsWith(`/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/rec-1`),
      `回填要打到这张表的具体那一行，实际 ${put.url}`,
    )

    const fields = put.body?.fields
    assert.ok(fields && typeof fields === 'object', `PUT 的 body 必须是 { fields }，实际 ${JSON.stringify(put.body)}`)
    assert.equal(fields[FEISHU_COLUMNS.result], '已修好，加了空值保护', '「处理结果」要原样写进去')
    assert.equal(fields[FEISHU_COLUMNS.status], '是', 'status 缺省就是「是」—— 票处理完了就是处理了')
    assert.equal(typeof fields[FEISHU_COLUMNS.handledAt], 'number', '「处理日期」传毫秒时间戳数字，别传格式化字符串')
    assert.ok(
      Math.abs(Number(fields[FEISHU_COLUMNS.handledAt]) - Date.now()) < 60_000,
      `handledAt 缺省应该是「现在」，实际 ${String(fields[FEISHU_COLUMNS.handledAt])}`,
    )
    // 只准碰这三列：顺手写了「处理人」「最后更新时间」之类，等于替人改了别的列。
    assert.deepEqual(
      Object.keys(fields).sort(),
      [FEISHU_COLUMNS.status, FEISHU_COLUMNS.result, FEISHU_COLUMNS.handledAt].sort(),
      `回填只能写这三个字段，实际写了：${Object.keys(fields).join('、')}`,
    )
  })

  await check('回填：status / handledAt 可显式覆盖，空 status 回落到「是」', async () => {
    // 为什么允许覆盖 status：不同团队的表用「已完成」「已处理」而不是「是」，
    // 这是**表**的约定，适配器不该替人改词。
    const server = createFakeServer({ rows: [] })
    const { source } = makeSource(server)

    await source.writeResult('rec-2', { status: '已完成', result: '已修复', handledAt: 1_700_000_123_456 })
    const put = server.requests.find((request) => request.method === 'PUT')
    assert.equal(put.body.fields[FEISHU_COLUMNS.status], '已完成', '调用方给了 status 就用它')
    assert.equal(put.body.fields[FEISHU_COLUMNS.handledAt], 1_700_000_123_456, '调用方给了 handledAt 就用它，别改写')

    await source.writeResult('rec-3', { status: '   ', result: '只有空格的状态值等于没给' })
    const last = server.requests.filter((request) => request.method === 'PUT').at(-1)
    assert.equal(last.body.fields[FEISHU_COLUMNS.status], '是', '空白 status 要回落成缺省值，不能往表里写一串空格')
  })

  await check('回填：表里没有那几列时退回只读回执，不把整票判失败', async () => {
    // 为什么这条重要：回填是**附加动作**。人把插件接到一张没有「处理结果」列的表上时，
    // 票其实已经处理完了 —— 因为「表少一列」把它判失败，是本末倒置。
    // 正确做法是回 { written:false } 并在 note 里说清缺什么，让人去补表结构。
    const server = createFakeServer({ rows: [] })

    // 形态一：业务码（FieldNameNotFound 是飞书这一族的常见写法）。
    const codeFetch = async (url, init = {}) => (
      String(init.method ?? 'GET').toUpperCase() === 'PUT'
        ? jsonResponse({ code: 1254045, msg: 'FieldNameNotFound' })
        : server.fetchImpl(url, init)
    )
    const { source } = makeSource(server, { fetch: codeFetch })
    const byCode = await source.writeResult('rec-1', { result: '已修复' })
    assert.equal(byCode.written, false, '字段缺失不是故障，应该回 written:false 而不是抛')
    assert.ok(/没有「/.test(byCode.note ?? '') || /列/.test(byCode.note ?? ''), `note 要说清缺的是列：${byCode.note}`)
    assert.ok(/是否处理/.test(byCode.note ?? ''), `note 要点出具体列名，实际：${byCode.note}`)

    // 形态二：码没对上、但 msg 里明说「字段不存在」—— 错误码表是飞书侧的闭源约定，
    // 只认码迟早会漏，所以还要认关键词。
    const msgFetch = async (url, init = {}) => (
      String(init.method ?? 'GET').toUpperCase() === 'PUT'
        ? jsonResponse({ code: 1254006, msg: '字段「处理结果」不存在' })
        : server.fetchImpl(url, init)
    )
    const { source: byMsg } = makeSource(server, { fetch: msgFetch })
    const byMessage = await byMsg.writeResult('rec-1', { result: '已修复' })
    assert.equal(byMessage.written, false, 'msg 里明说字段不存在时也要退化成只读回执')
  })

  await check('回填：同步表拒绝写入要退化成只读回执，不能当成故障反复重试', async () => {
    // 真发现（2026-11-09，pms 真链路）：回填发出 data.setRecord 之后飞书回
    //   800074911：ConnectorSyncTableActionForbidden,
    //   [status_code: 800004105 msg: syncTable can not apply action:action=data.setRecord...]
    // 这是「表是同步表、行不归你改」，属于配置问题：票已经处理完了，
    // 重试一万次也一样。以前归成 internal，票据上挂着看起来像插件坏了的话，
    // 还会被当成可重试错误。
    const realMessage = '飞书接口报错 800074911：ConnectorSyncTableActionForbidden, '
      + '[status_code: 800004105 msg: syncTable can not apply action:action=data.setRecord, '
      + 'tabID=tblWhRSGf0osJqrE, fldID=fldfZLT0D6]'
    assert.equal(isSyncTableForbiddenError(new Error(realMessage)), true, '真实报错文本必须认出来')
    // 内层 status_code 单独出现也要认（不同接口版本包装方式不一样）。
    assert.equal(isSyncTableForbiddenError(new Error('syncTable can not apply action:action=data.setRecord')), true)
    assert.equal(isSyncTableForbiddenError(new Error('[status_code: 800004105]')), true)
    // 反例：真正的故障不能被误判成「同步表」。
    assert.equal(isSyncTableForbiddenError(new Error('飞书接口报错 1254045：FieldNameNotFound')), false)
    assert.equal(isSyncTableForbiddenError(new Error('调用飞书接口失败：socket hang up')), false)
    assert.equal(isSyncTableForbiddenError(null), false)
    assert.equal(isSyncTableForbiddenError(undefined), false)

    // 端到端：写回时拿到这个码，要回 written:false + 说清怎么办，而不是抛。
    const server = createFakeServer({ rows: [] })
    const syncFetch = async (url, init = {}) => (
      String(init.method ?? 'GET').toUpperCase() === 'PUT'
        ? jsonResponse({ code: 800074911, msg: 'ConnectorSyncTableActionForbidden' })
        : server.fetchImpl(url, init)
    )
    const { source } = makeSource(server, { fetch: syncFetch })
    const receipt = await source.writeResult('rec-1', { result: '已修复' })
    assert.equal(receipt.written, false, '同步表写不进去要如实回 written:false')
    assert.ok(/同步表/.test(receipt.note ?? ''), `note 要说清是同步表：${receipt.note}`)
    assert.ok(/writeBack/.test(receipt.note ?? ''), `note 要给出关掉回填这条退路：${receipt.note}`)
    assert.ok(/ConnectorSyncTableActionForbidden/.test(receipt.note ?? ''), '要把飞书原话带上，便于排查')
  })

  await check('回填：真故障（鉴权 / 网络）必须抛出来，不能吞掉假装写成功', async () => {
    // 为什么不能一律吞：吞掉异常会让「表格压根没更新」这件事无声无息，
    // 人对着没回填的表会以为插件没跑。上层会兜住并记日志，但适配器必须如实抛。
    const server = createFakeServer({ rows: [] })
    const forbiddenFetch = async (url, init = {}) => (
      String(init.method ?? 'GET').toUpperCase() === 'PUT'
        ? { ok: false, status: 403, headers: headerBag({}), json: async () => ({ code: 0 }), text: async () => 'forbidden' }
        : server.fetchImpl(url, init)
    )
    const { source } = makeSource(server, { fetch: forbiddenFetch })
    await assert.rejects(
      () => source.writeResult('rec-1', { result: '已修复' }),
      (error) => error.kind === 'auth',
      '403 重试一次后仍然是 auth 错误，必须抛出去，而不是回 written:true',
    )
    const puts = server.requests.filter((request) => request.method === 'PUT')
    assert.equal(puts.length, 0, '403 是被包装的 fetch 拦下的，不该落到真实桩上')
  })

  await check('回填：recordId / result / handledAt 不合法时当场报错，一个请求都不发', async () => {
    // 为什么先校验再发请求：飞书的 PUT 一旦发出去就可能改错行，
    // 参数层面的错必须在校验阶段就拦住（也省一次网络往返）。
    const server = createFakeServer({ rows: [] })
    const { source } = makeSource(server)
    const before = server.requests.length

    await assert.rejects(
      () => source.writeResult('', { result: '已修复' }),
      (error) => error.kind === 'invalid-input',
      '空 recordId 定位不到行，必须报 invalid-input',
    )
    await assert.rejects(
      () => source.writeResult('rec-1', null),
      (error) => error.kind === 'invalid-input',
      '回填内容不是对象时要报错，而不是写一堆 undefined 上去',
    )
    await assert.rejects(
      () => source.writeResult('rec-1', { status: '是' }),
      (error) => error.kind === 'invalid-input',
      '缺 result（「处理结果」写什么）必须报错 —— 空着回填等于没回填',
    )
    await assert.rejects(
      () => source.writeResult('rec-1', { result: '已修复', handledAt: -1 }),
      (error) => error.kind === 'invalid-input',
      '负数时间戳写进日期字段会让飞书报错，提前拦住',
    )
    assert.equal(server.requests.length, before, `校验失败不该发出任何请求，实际发了 ${server.requests.length - before} 个`)

    // 取消信号同样要在发请求之前生效。
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => source.writeResult('rec-1', { result: '已修复' }, controller.signal),
      (error) => error.kind === 'aborted',
      '已经取消的调用不该再发请求',
    )
  })

  await check('mock 源也有同形状的 writeResult：记在内存里，failWrite 时抛错', async () => {
    // 为什么 mock 也要测：自测/离线试跑全走 mock，这条链路（唯一会写远端的动作）
    // 在 mock 上不成立的话，dev-run 里所有「跑完一张票」的用例都验证不到回填。
    // 两条适配器必须同形状 —— 上层调度器不该为「是真表还是假表」分叉。
    const source = createMockSource({ seeds: [{ recordId: 'rec-m1', status: '处理中', description: '登录页报 500' }] })
    assert.equal(typeof source.writeResult, 'function', 'mock 源同样要实现契约里的 writeResult')

    const receipt = await source.writeResult('rec-m1', { result: '已修好' })
    assert.equal(receipt.written, true)
    assert.equal(source.writes.length, 1, '回填要能在内存里被数出来，否则用例断言不到')
    assert.deepEqual(
      { recordId: source.writes[0].recordId, status: source.writes[0].status, result: source.writes[0].result },
      { recordId: 'rec-m1', status: '是', result: '已修好' },
      `mock 记下来的内容要和真适配器写出去的一致，实际 ${JSON.stringify(source.writes[0])}`,
    )
    assert.equal(typeof source.writes[0].handledAt, 'number', 'handledAt 缺省也必须是毫秒时间戳')

    source.setFailWrite(true)
    await assert.rejects(
      () => source.writeResult('rec-m1', { result: '再修一次' }),
      (error) => error.kind === 'network',
      'setFailWrite 打开的开关必须真的让回填失败（用来验证「回填失败不回退票态」）',
    )
    assert.equal(source.writes.length, 1, '失败的这次不该记进 writes')
  })

  // ——————————————————————————————————————————————————————————————
  // 多维表格的列名别名（工单 #21）。
  //
  // 病根：以前多维表格走的是硬编码的 13 个中文列名。表里的人把「问题描述」写成
  // 「缺陷描述」时，`fields['问题描述']` 取到 undefined ⇒ 描述为空 ⇒ **静默扫出 0 张票**，
  // 既不报错也不提示。这比直接报错难查得多，所以这里既测「别名能认」，
  // 也测「实在认不出时必须报错并列出实际字段名」。
  // ——————————————————————————————————————————————————————————————

  /** 造一行，字段名完全由调用方给（测别名映射用）。 */
  const makeRowWithColumns = (recordId, names, values) => ({
    record_id: recordId,
    last_modified_time: values.mtime ?? 1_700_000_000_000,
    fields: {
      [names.seq]: '1',
      [names.department]: '工程部',
      [names.description]: values.description,
      [names.foundAt]: values.mtime ?? 1_700_000_000_000,
      [names.module]: '登录',
      [names.flow]: '打开首页 → 点登录',
      [names.screenshot]: undefined,
      [names.priority]: '高',
      [names.status]: values.status,
      [names.handler]: '',
      [names.result]: '',
      [names.handledAt]: '',
    },
  })

  await check('多维表格：字段叫「缺陷描述」「处理状态」也能扫出票（别名映射）', async () => {
    // 一张被人改成自家叫法的表 —— 这正是搬表进多维表格后最常见的形状。
    const altNames = {
      ...FEISHU_COLUMNS,
      description: '缺陷描述',
      status: '处理状态',
      priority: '严重程度',
      module: '所属模块',
    }
    const server = createFakeServer({
      fields: Object.values(altNames),
      rows: [makeRowWithColumns('rec-alt', altNames, { description: '登录页报 500', status: IN_PROGRESS_VALUE })],
    })
    const { source } = makeSource(server)

    const result = await source.scan()
    assert.equal(result.created.length, 1, `列名换成别名后必须照样能收票，实际收了 ${result.created.length} 张（0 张就是那个静默 bug 回来了）`)
    assert.equal(result.created[0].recordId, 'rec-alt')
    assert.equal(result.created[0].description, '登录页报 500', '描述要真的读到，不能是空串')
    assert.equal(result.created[0].priority, 'high', '别名字段（严重程度）也要能读出优先级')

    // 字段列表只该问一次：一轮扫描无论翻几页，都复用同一份映射。
    const fieldCalls = server.requests.filter((request) => /\/fields$/.test(new URL(request.url).pathname))
    assert.equal(fieldCalls.length, 1, `字段列表一轮只该问一次，实际问了 ${fieldCalls.length} 次`)
  })

  await check('多维表格：实在找不到描述列时当场报错，并列出表里实际的字段名', async () => {
    // 为什么必须报错而不是「扫出 0 张票」：0 张票有太多合理解释
    //（开关没开、表里真没数据、状态值配错），人会把时间全花在别处。
    const server = createFakeServer({
      fields: ['标题', '严重程度', '处理状态'],
      rows: [],
    })
    const { source } = makeSource(server)

    await assert.rejects(
      () => source.scan(),
      (error) => {
        assert.equal(error.kind, 'invalid-input', `列名对不上是配置问题，实际 kind=${error.kind}`)
        const message = String(error.message)
        assert.match(message, /收不了票/, `要明说收不了票，实际：${message}`)
        assert.match(message, /标题 \/ 严重程度 \/ 处理状态/, `要列出表里实际的字段名，实际：${message}`)
        assert.match(message, /match\.columns/, `要给出「用 match.columns 覆盖」这条路，实际：${message}`)
        return true
      },
    )
  })

  await check('多维表格：match.columns 能覆盖插件不认识的字段叫法', async () => {
    // 表里那列叫「现象」，别名表里没有 —— 只能靠人显式写 match.columns。
    const names = { ...FEISHU_COLUMNS, description: '现象' }
    const server = createFakeServer({
      fields: Object.values(names),
      rows: [makeRowWithColumns('rec-override', names, { description: '列表翻页丢数据', status: IN_PROGRESS_VALUE })],
    })
    const { source } = makeSource(server, { columns: { description: '现象' } })

    const result = await source.scan()
    assert.equal(result.created.length, 1, 'match.columns 覆盖之后必须能收票')
    assert.equal(result.created[0].description, '列表翻页丢数据')
  })

  await check('多维表格：回填用映射后的列名，读哪列就写哪列', async () => {
    // 最容易漏的一处：扫描读了「缺陷描述」，回填却按规范名写「处理结果」「是否处理」，
    // 两边都对不上，看起来请求成功、实际全错位。
    const altNames = {
      ...FEISHU_COLUMNS,
      status: '处理状态',
      result: '修复说明',
      handledAt: '闭环时间',
    }
    const server = createFakeServer({ fields: Object.values(altNames), rows: [] })
    // 「修复说明」「闭环时间」不在内置别名表里 —— 这类完全自造的叫法只能靠
    // `match.columns` 显式说明（别名表只覆盖常见同义写法，不能瞎猜）。
    const { source } = makeSource(server, {
      columns: { status: '处理状态', result: '修复说明', handledAt: '闭环时间' },
    })

    const receipt = await source.writeResult('rec-w', { result: '已修好' })
    assert.equal(receipt.written, true)
    assert.deepEqual(
      [...receipt.fields].sort(),
      ['处理状态', '修复说明', '闭环时间'].sort(),
      `回执要报表里真实的列名（人对着表能直接找到），实际 ${JSON.stringify(receipt.fields)}`,
    )

    const put = server.requests.find((request) => request.method === 'PUT')
    assert.ok(put, '回填要真的发出 PUT')
    assert.deepEqual(
      Object.keys(put.body.fields).sort(),
      ['处理状态', '修复说明', '闭环时间'].sort(),
      `PUT 的字段名必须是表里真实列名，实际写了：${Object.keys(put.body.fields).join('、')}`,
    )
    assert.equal(put.body.fields['修复说明'], '已修好')
    assert.equal(put.body.fields['处理状态'], '是')
  })

  await check('两套表型喂同一组列名时，扫出来的票长得一样', async () => {
    // 工单 #21 把「认列名」抽成一套共用逻辑（mapColumns）就是为了这个：
    // 同一张表换个表型不该换一套认法，否则「多维表格能收、电子表格收不到」这种
    // 只在某一种表型上出现的 bug 会一直长回来。
    const header = ['序号', '缺陷描述', '处理状态', '优先级']
    const sheetServer = createFakeServer({
      sheets: [{ sheet_id: 'sh1', title: '工单', index: 0 }],
      sheetValues: [header, ['S-1', '列表翻页丢数据', IN_PROGRESS_VALUE, '高']],
    })
    const sheetSource = makeSource(sheetServer, { spreadsheetToken: 'sht-test', sheetId: 'sh1' }).source
    const sheetResult = await sheetSource.scan()

    const altNames = { ...FEISHU_COLUMNS, description: '缺陷描述', status: '处理状态' }
    const bitableServer = createFakeServer({
      fields: Object.values(altNames),
      rows: [makeRowWithColumns('rec-same', altNames, { description: '列表翻页丢数据', status: IN_PROGRESS_VALUE })],
    })
    const bitableResult = await makeSource(bitableServer).source.scan()

    assert.equal(sheetResult.created.length, 1, '电子表格侧应该收到 1 张')
    assert.equal(bitableResult.created.length, 1, '多维表格侧应该收到 1 张')
    assert.equal(
      sheetResult.created[0].description,
      bitableResult.created[0].description,
      '同一组列名在两种表型下要读出同一段描述',
    )
    assert.equal(sheetResult.created[0].priority, bitableResult.created[0].priority, '优先级也要一致')
  })


  await check('多维表格：单选 / 附件 / 数字这些字段类型也能读（记下验证过的类型）', async () => {
    // 工单 #21 的风险提示要求「记录验证过的字段类型」：列名能映射上只是第一步，
    // 字段的**类型**决定 `normalizeCellText` 拿到的形状。真实多维表格里
    // 「是否处理」多半是单选、「优先级」是单选、「截图」是附件、「发现日期」是日期(数字)。
    const names = { ...FEISHU_COLUMNS }
    const server = createFakeServer({
      fields: Object.values(names),
      rows: [{
        record_id: 'rec-types',
        last_modified_time: 1_700_000_000_000,
        fields: {
          [names.seq]: '7',                                  // 文本
          [names.department]: ['工程部', '平台组'],            // 多选 → 空格连接
          [names.description]: '导出报表时缺最后一行',          // 文本
          [names.foundAt]: 1_735_689_600_000,                // 日期 → 毫秒时间戳
          [names.module]: '报表',                             // 单选
          [names.flow]: '',                                   // 空字符串
          [names.screenshot]: [                               // 附件
            { file_token: 'boxcnTypeShot', name: 'shot.png', size: 2048, type: 'image/png' },
          ],
          [names.priority]: '高',                             // 单选
          [names.status]: IN_PROGRESS_VALUE,                  // 单选
          [names.handler]: [{ id: 'ou_1', name: '张三' }],     // 人员 → 取 name
          [names.result]: '',
          [names.handledAt]: '',
        },
      }],
    })

    const result = await makeSource(server).source.scan()
    assert.equal(result.created.length, 1, '字段类型不同不该影响收票')
    const ticket = result.created[0]
    assert.equal(ticket.description, '导出报表时缺最后一行')
    assert.equal(ticket.department, '工程部 平台组', '多选要用空格连起来')
    assert.equal(ticket.priority, 'high', '单选「高」也要归一到 high')
    assert.equal(ticket.foundAt, '2025-01-01', '日期字段是毫秒时间戳，要归成 YYYY-MM-DD')
    assert.equal(ticket.screenshots.length, 1, '附件形态的截图要抽出来')
    assert.equal(ticket.screenshots[0].kind, 'attachment')
    assert.equal(ticket.screenshots[0].fileToken, 'boxcnTypeShot')
  })

  await check('配置：appToken 贴整条表格 URL 时，table / view 要从链接里啃出来', async () => {
    // 为什么测这个：文档一直写着「appToken 可以直接贴整条链接」，但代码先前只从
    // `/base/<token>` 里抠 app_token，`?table=tblXXX` 被白白扔掉 —— 用户还得另外
    // 去找 table_id 填进 match.tableId。这条用例把「贴一条链接就够」钉死。
    const url = 'https://vcn6ijgss3oy.feishu.cn/base/RZZQbY4SkaY6z0shZaBcVpQCnhh?table=tblWhRSGf0osJqrE&view=vewsyZldQC'
    const parsed = parseBitableUrl(url)
    assert.deepEqual(parsed, { tableId: 'tblWhRSGf0osJqrE', viewId: 'vewsyZldQC' }, `URL 里的 table / view 要能读出来，实际 ${JSON.stringify(parsed)}`)

    const options = feishuOptionsFromMatch({ appToken: url })
    assert.equal(options.tableId, 'tblWhRSGf0osJqrE', 'tableId 没从链接里透传出来，用户就还得手工找 table_id')
    assert.equal(options.viewId, 'vewsyZldQC', 'viewId 同理')
    assert.equal(options.appToken, url, 'appToken 原值要原样保留 —— 适配器自己还要从里面啃 app_token')

    // 显式写了 tableId 的，以显式值为准：别让 URL 覆盖人的明确意图。
    const explicit = feishuOptionsFromMatch({ appToken: url, tableId: 'tblExplicit', viewId: 'vewExplicit' })
    assert.equal(explicit.tableId, 'tblExplicit', '显式 tableId 优先级必须高于链接里的')
    assert.equal(explicit.viewId, 'vewExplicit', '显式 viewId 同理')

    // 纯 token（不是 URL）什么都啃不出来，必须回空串，把兜底让给 docNamePattern。
    for (const plain of ['RZZQbY4SkaY6z0shZaBcVpQCnhh', '  ', 'not a url', '', undefined, null]) {
      assert.deepEqual(parseBitableUrl(plain), { tableId: '', viewId: '' }, `纯 token / 空值不该啃出东西：${JSON.stringify(plain)}`)
    }
    // 只有 table 没有 view 的链接也得能读出一半。
    const onlyTable = parseBitableUrl('https://x.feishu.cn/base/abcdef?table=tblOnly')
    assert.deepEqual(onlyTable, { tableId: 'tblOnly', viewId: '' }, '只带 table 的链接要读出 table，view 回空串')
    assert.equal(feishuOptionsFromMatch({ appToken: 'RZZQbY4SkaY6z0shZaBcVpQCnhh' }).tableId, '', '纯 token 时 tableId 保持空，走 docNamePattern 兜底')
  })

  // ============================================================
  // 飞书**电子表格**（ADR-0005 / feishu-sheet-source.md）
  //
  // 二十条放在一起，因为它们共享同一套桩（假服务端 + 假工作表 + 假二维值）。
  // 这些用例是「电子表格到底能不能用」的唯一证据 —— 真机验证要飞书开放平台的
  // sheets scope + 文档级授权，离线跑不了。
  // ============================================================

  /** 造一张电子表格的工作表清单。 */
  const makeSheets = () => [
    { sheet_id: 'sh1', title: '工单', index: 0, hidden: false },
    { sheet_id: 'sh2', title: '归档', index: 1, hidden: true },
  ]

  /** 造一份二维值：表头 + 两行数据。 */
  const makeSheetValues = () => [
    ['序号', '发现部门', '问题描述', '是否处理', '优先级', '模块'],
    ['A-1', '客服', '列表翻页丢数据', '处理中', '高', '订单'],
    ['A-2', '运营', '导出少一行', '否', '中', '报表'],
  ]

  /** 造一个「表型是电子表格」的假服务端。 */
  const makeSheetServer = (overrides = {}) => createFakeServer({
    sheets: makeSheets(),
    sheetValues: makeSheetValues(),
    ...overrides,
  })

  await check('电子表格：裸 token 探多维表格报 1254003 WrongBaseToken 时要降级去试电子表格', async () => {
    // 真实事故（2026-11-10）：wiki 里的电子表格，用户只贴了一个裸 token（没带 /wiki/）。
    // 适配器的分派逻辑是「先按多维表格试、类型不对再试电子表格」，而 1254003
    // 当时不在 INVALID_INPUT_ERROR_CODES 里，被归成 `internal` ⇒ shouldTrySheet()
    // 返回 false ⇒ 直接抛「飞书接口报错 1254003」，一张票都收不到。
    // 这条用例把「1254003 属于类型不对、值得再试」钉死。
    // 假服务端要真的对那个 token 报 1254003，**而且要走 HTTP 200 + 业务码**那条路：
    // 真机实测（2026-11-10）飞书就是回 200 在 body 里给 code:1254003。用
    // `failAppTokens` 会回 HTTP 400，适配器在 `!response.ok` 那层就抛了，
    // 走不到错误码映射 —— 那样测的就不是这条 bug。
    const server = makeSheetServer({
      tablesFailCode: 1254003,
    })
    const { source } = makeSource(server, {
      appToken: 'MuVEsnmEbhnYH8tDUyvc0c6Wnch',
      tableId: '',
      sheetId: 'sh1',
    })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1, '1254003 之后必须降级到电子表格并读出票')
    assert.ok(
      server.requests.some((r) => r.url.includes('/sheets/v3/spreadsheets/')),
      '降级之后必须真的去查工作表清单',
    )
  })

  await check('电子表格：appToken 是 wiki 电子表格 token、同时还留着多维表格的 tableId 时，不能被 tableId 抢走分派', async () => {
    // 真实事故（2026-11-11，pms 项目）。现场配置同时有：
    //   appToken: It5gwQ9sMizJh0kdbDhc2rBfnug    ← 裸 wiki token，背后是一张**电子表格**
    //   tableId:  tblWhRSGf0osJqrE                ← 上一轮用多维表格时留下的 tableId
    // 裸 token 不以 `wiki` 开头、也不含 `/wiki/`，所以 `isWikiToken()` 认不出来
    // ⇒ 走「原生 token：先按多维表格试」这条路。
    // 而旧版 `resolveBitableTableByIdentity` 开头有一句
    //   `if (tableId) return { kind:'bitable', appToken, tableId }`
    // —— 一个请求都不打就「定位成功」，于是：
    //   ① 表型分派被 tableId 直接抢走，永远走不到电子表格分支；
    //   ② `shouldTrySheet()` 的降级路也堵死了（降级只在**定位失败**时发生，这里没失败）；
    //   ③ 直到 `resolveBitableColumns` 去问 fields 才炸，报 `WrongBaseToken`（1254003）。
    // 症状是「体检说能读（探针认表型），scan 却抛一句后端黑话，用户以为电子表格不能用」。
    // 修法：配了 tableId 也先问一次 `tables` —— token 真是多维表格只是多一个请求，
    // 是电子表格就在这里失败成 invalid-input，降级照常发生。
    const server = makeSheetServer({
      // 拿电子表格 token 问多维表格，飞书回 HTTP 200 + 业务码 1254003（真机实测）。
      tablesFailCode: 1254003,
      // 探针也要能认出这是电子表格：get_node 回 obj_type=sheet。
      wikiNodeType: 'sheet',
    })
    const { source } = makeSource(server, {
      appToken: 'It5gwQ9sMizJh0kdbDhc2rBfnug',
      tableId: 'tblWhRSGf0osJqrE',
      sheetId: 'sh1',
    })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1, 'tableId 不该让这张电子表格扫不出票')
    assert.equal(result.created[0].recordId, 'sh-seq-A-1', '走的必须是电子表格那条路（行身份是 sh- 前缀）')
    assert.ok(
      server.requests.some((r) => r.url.includes('/sheets/v3/spreadsheets/')),
      '必须降级到电子表格：分明是电子表格，不能因为 tableId 就只按多维表格读',
    )
    assert.ok(
      !server.requests.some((r) => r.url.includes('/fields')),
      '既然不是多维表格，就不该去问 fields（那正是旧写法炸出 WrongBaseToken 的地方）',
    )
  })

  await check('电子表格：spreadsheetToken 填的是整条 wiki 链接时，要抠出 token 再请求（不能把 URL 原样拼进接口）', async () => {
    // 真实事故（2026-11-10）：用户在面板里把 `https://x.feishu.cn/wiki/It5g…?sheet=3a5d28`
    // 整条贴进 spreadsheetToken，适配器 `extractSheetToken` 只认 `/sheets/<token>` 和裸 token，
    // 两处都不匹配就「原样返回整串」，于是整条 URL 被 encodeURIComponent 拼进
    // `/sheets/v3/spreadsheets/<整条URL>/sheets/query`，飞书回 `404 page not found`
    // —— 表现就是「电子表格一张票都收不到」。
    // 这条用例盯两件事：① 请求路径里的 token 段是裸 token，不含 `://` 与 `/`；
    // ② 真的能读出票来。
    const server = makeSheetServer()
    const { source } = makeSource(server, {
      appToken: '',
      tableId: '',
      spreadsheetToken: 'https://x.feishu.cn/wiki/WIKISHEETTOKEN?sheet=sh1',
      sheetId: 'sh1',
    })
    const result = await source.scan(new AbortController().signal)
    const queryRequest = server.requests.find((r) => r.url.includes('/sheets/v3/spreadsheets/'))
    assert.ok(queryRequest, '必须真的去查工作表清单')
    assert.ok(
      queryRequest.url.includes('/sheets/v3/spreadsheets/WIKISHEETTOKEN/sheets/query'),
      `token 段必须是抠出来的裸 token，实际 ${queryRequest.url}`,
    )
    assert.ok(
      !/spreadsheets\/[^/]*(%|:\/\/)/.test(queryRequest.url),
      `token 段不许出现编码字符或协议头，实际 ${queryRequest.url}`,
    )
    assert.equal(result.created.length, 1, '整条 wiki 链接也要能读出票')
  })

  await check('电子表格：spreadsheetToken 填了认不出的链接时要报错，不能静默拼 404', async () => {
    // 「静默失败比报错更误导」：认不出的链接以前会原样拼进接口，404 之后
    // 人只能猜是 token 错、表错还是权限错。现在带协议头却认不出就直接说清楚。
    const server = makeSheetServer()
    const { source } = makeSource(server, {
      appToken: '',
      tableId: '',
      spreadsheetToken: 'https://x.feishu.cn/docx/SOMEDOCID',
      sheetId: 'sh1',
    })
    await assert.rejects(
      () => source.scan(new AbortController().signal),
      (error) => error.kind === 'invalid-input' && error.message.includes('/wiki/'),
      '认不出的链接要报 invalid-input 并说清支持哪两种形态',
    )
  })

  await check('电子表格：wiki 节点 obj_type=sheet 时走电子表格分支，不再报「不是多维表格」', async () => {
    // 这就是用户「贴电子表格链接进来直接报错」的那条路：以前 get_node 硬写了
    // obj_type='bitable'，服务端只回答「是不是多维表格」，sheet 一律被拒。
    const server = makeSheetServer({ wikiNodeType: 'sheet', wikiNodeToken: (token) => `shtcn-${token}` })
    const { source } = makeSource(server, {
      appToken: 'https://x.feishu.cn/wiki/SHEETWIKI1',
      tableId: '',
      sheetId: 'sh1',
    })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1, '电子表格里「处理中」那行要变成新票')
    assert.equal(result.created[0].recordId, 'sh-seq-A-1', '序号列优先做身份')
    // 只读铁律：一条写请求都不许出现。
    const writes = server.requests.filter((r) => r.method !== 'GET' && !r.url.includes('/auth/v3/'))
    assert.deepEqual(writes, [], `扫描绝不允许写表格，实际发了 ${JSON.stringify(writes.map((r) => r.url))}`)
  })

  await check('电子表格：wiki 节点是 bitable 时不回归（照样走多维表格）', async () => {
    const server = createFakeServer({
      tables: [{ table_id: 'tbl-a', name: '工单表' }],
      rows: [makeRow('rec-1')],
    })
    const { source } = makeSource(server, {
      appToken: 'https://x.feishu.cn/wiki/WIKIBITABLE1',
      tableId: '',
      docNamePattern: '工单表',
    })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1, '多维表格这条路不能被表型分派改坏')
    assert.ok(
      server.requests.some((r) => r.url.includes('/bitable/v1/apps/')),
      '多维表格必须走 bitable 接口',
    )
    assert.ok(
      !server.requests.some((r) => r.url.includes('/sheets/')),
      '不能顺手去读电子表格接口',
    )
  })

  await check('电子表格：get_node 不返回 obj_type 时按多维表格兜底（老服务端兼容）', async () => {
    const server = createFakeServer({
      wikiNodeType: '',
      tables: [{ table_id: 'tbl-a', name: '工单表' }],
      rows: [makeRow('rec-1')],
    })
    const { source } = makeSource(server, {
      appToken: 'https://x.feishu.cn/wiki/OLDNODETYPE1',
      tableId: '',
      docNamePattern: '工单表',
    })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1, 'obj_type 缺失时要当成多维表格继续跑，不能拒服务')
  })

  await check('电子表格：裸 token 探不出多维表格时报错文案要列出两种尝试', async () => {
    // bitable 说「这 token 不认识」，sheet 也说「这表没有工作表」——人得同时看到两边，
    // 否则只能猜是 token 错还是表错。
    const server = createFakeServer({
      // 1254005 = INVALID_INPUT_ERROR_CODES：代表「这 token 不是多维表格」这类
      // 「类型不对」的错，才值得再试一次电子表格（凭据错/限流错另有用例）。
      tablesFailCode: 1254005,
      sheets: [],
    })
    const { source } = makeSource(server, {
      appToken: 'UNKNOWNDOC1',
      tableId: '',
    })
    await assert.rejects(
      () => source.scan(new AbortController().signal),
      (error) => error.kind === 'invalid-input'
        && error.message.includes('既当不了多维表格')
        && error.message.includes('按多维表格读')
        && error.message.includes('按电子表格读')
        && error.message.includes('match.appToken')
        && error.message.includes('match.spreadsheetToken'),
      '两种表型都失败时必须把两次尝试都写出来',
    )
  })

  await check('电子表格：探测时遇到凭据错（auth）不偷偷去试电子表格，真因不许被埋', async () => {
    // 凭据错 / 限流 / 网络错都是真故障。若这时还去试 sheet，最后抛的会是
    // 「既当不了多维表格也当不了电子表格」，人 forever 找不到「凭据没配」这个真因。
    const server = createFakeServer({
      wikiNodeType: 'bitable',
      tablesFailCode: 99991663, // AUTH_ERROR_CODES 里的一员
      sheets: makeSheets(),
      sheetValues: makeSheetValues(),
    })
    const { source } = makeSource(server, {
      appToken: 'https://x.feishu.cn/wiki/AUTHFAIL1',
      tableId: '',
    })
    await assert.rejects(
      () => source.scan(new AbortController().signal),
      (error) => error.kind === 'auth',
      '凭据错必须原样抛出，不能被「再试一次电子表格」盖掉',
    )
    assert.ok(
      !server.requests.some((r) => r.url.includes('/sheets/v3/') || r.url.includes('/values/')),
      '凭据错之后不该再打电子表格接口',
    )
  })

  await check('电子表格：只给 spreadsheetToken + sheetId 时能定位并读值', async () => {
    const server = makeSheetServer()
    const { source } = makeSource(server, {
      appToken: '',
      tableId: '',
      spreadsheetToken: 'shtcnABCDEF',
      sheetId: 'sh1',
    })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1)
    const valuesRequest = server.requests.find((r) => r.url.includes('/values/'))
    assert.ok(valuesRequest, '必须真的去读值')
    assert.ok(
      valuesRequest.url.includes('shtcnABCDEF'),
      `读值要打对 spreadsheetToken，实际 ${valuesRequest.url}`,
    )
    // range 在 path 里：`!` 与 `:` 必须原样保留（编码了飞书不认）。
    assert.ok(
      /\/values\/sh1!A1:[A-Z]+$/.test(valuesRequest.url),
      `range 形状应是 {sheetId}!A1:<列>，实际 ${valuesRequest.url}`,
    )
  })

  // ── 电子表格回填（工单 #22）─────────────────────────────────────
  // 这一组测的是「写回三格」这件事本身：写到了哪一格、写的内容对不对、
  // 行号漂移之后还找不找得到、以及失败了能不能说清为什么。
  // 断言必须看 `server.state.sheetWrites`（真发出去的请求体），
  // 不能只看适配器返回的 `written:true` —— 回执说成功但写到别人格子里，
  // 正是这一块最容易犯的错。

  /** 带「处理结果 / 处理日期」两列的表，回填才有地方可写。 */
  const makeWriteBackSheetValues = () => [
    ['序号', '问题描述', '是否处理', '处理结果', '处理日期'],
    ['A-1', '列表翻页丢数据', '处理中', '', ''],
    ['A-2', '导出少一行', '处理中', '', ''],
  ]

  const makeWriteBackSheetServer = (overrides = {}) => createFakeServer({
    sheets: makeSheets(),
    sheetValues: makeWriteBackSheetValues(),
    ...overrides,
  })

  const makeWriteBackSource = (server, options = {}) => makeSource(server, {
    appToken: '',
    tableId: '',
    spreadsheetToken: 'shtcnABCDEF',
    sheetId: 'sh1',
    ...options,
  })

  await check('电子表格：回填写到「那一行的三格」上，不是别的格子', async () => {
    const server = makeWriteBackSheetServer()
    const { source } = makeWriteBackSource(server)

    const receipt = await source.writeResult('sh-seq-A-1', {
      status: '是',
      result: '已修复，加了空值保护',
      handledAt: Date.UTC(2026, 10, 9),
    })

    assert.equal(receipt.written, true, `要真写成，实际 ${JSON.stringify(receipt)}`)
    assert.equal(server.state.sheetWrites.length, 1, '一次批量写，不是三次单格写')
    const ranges = server.state.sheetWrites[0].valueRanges
    // A-1 是数据第一行，表头在第 1 行 ⇒ 序号在第 2 行；四列分别是 C/D/E（1-based 列号）。
    assert.deepEqual(
      ranges.map((item) => item.range),
      ['sh1!C2:C2', 'sh1!D2:D2', 'sh1!E2:E2'],
      `要写 C/D/E 三列的第 2 行，实际 ${JSON.stringify(ranges.map((item) => item.range))}`,
    )
    assert.deepEqual(
      ranges.map((item) => item.values[0][0]),
      ['是', '已修复，加了空值保护', '2026-11-09'],
      '三格内容：状态 / 结果 / 日期文本',
    )
    // 回执里报的是「表里真实列名」，排障时人对着表能一眼对上。
    assert.deepEqual(receipt.fields, ['是否处理', '处理结果', '处理日期'])
  })

  await check('电子表格：行被插过之后按序号重新定位，写到的还是那一行', async () => {
    // 这张票能跑几十分钟，期间人在中间插一行是常事。缓存行号 = 写到别人格子里，
    // 所以回填必须自己重读一遍表、按身份列定位。
    const server = makeWriteBackSheetServer()
    const { source } = makeWriteBackSource(server)
    await source.scan(new AbortController().signal)

    // 模拟「A-1 上面被插了一行」：A-1 从第 2 行挪到第 3 行。
    server.state.sheetValues = [
      ['序号', '问题描述', '是否处理', '处理结果', '处理日期'],
      ['A-0', '新插进来的一行', '否', '', ''],
      ['A-1', '列表翻页丢数据', '处理中', '', ''],
      ['A-2', '导出少一行', '处理中', '', ''],
    ]

    await source.writeResult('sh-seq-A-1', { result: '已修好' })
    const ranges = server.state.sheetWrites[0].valueRanges
    assert.ok(
      ranges.every((item) => /[A-Z]3:[A-Z]3$/.test(item.range)),
      `插行之后 A-1 在第 3 行，实际写到 ${JSON.stringify(ranges.map((item) => item.range))}`,
    )
    assert.ok(
      ranges.every((item) => !item.range.includes('2:2')),
      '绝不能还按旧行号写到第 2 行（那是别人）',
    )
  })

  await check('电子表格：那一行被删了就直说「找不到」，不发写请求', async () => {
    const server = makeWriteBackSheetServer()
    const { source } = makeWriteBackSource(server)
    await source.scan(new AbortController().signal)

    server.state.sheetValues = [
      ['序号', '问题描述', '是否处理', '处理结果', '处理日期'],
      ['A-2', '导出少一行', '处理中', '', ''],
    ]
    const receipt = await source.writeResult('sh-seq-A-1', { result: '已修好' })

    assert.equal(receipt.written, false)
    assert.equal(receipt.retryable, false, '行都没了，再试一万次也一样')
    assert.equal(receipt.errorKind, 'not-found')
    assert.ok(String(receipt.note).includes('找不到'), `note 要说清「找不到那一行」，实际 ${receipt.note}`)
    assert.equal(server.state.sheetWrites.length, 0, '定位不到就不许瞎写')
  })

  await check('电子表格：表里没有「处理结果」列时退回只读回执，并列出现有列名', async () => {
    const server = createFakeServer({
      sheets: makeSheets(),
      sheetValues: makeSheetValues(),
    })
    const { source } = makeWriteBackSource(server)
    await source.scan(new AbortController().signal)

    const receipt = await source.writeResult('sh-seq-A-1', { result: '已修好' })
    assert.equal(receipt.written, false)
    assert.equal(receipt.errorKind, 'unsupported')
    assert.ok(String(receipt.note).includes('处理结果'), '要指名缺哪一列')
    assert.ok(String(receipt.note).includes('问题描述'), '要列出表里实际的列名，人才能对照')
    assert.equal(server.state.sheetWrites.length, 0)
  })

  await check('电子表格：只有读权限时把「改成读写并重新发布版本」写进 note', async () => {
    // 读票只要 readonly，写值要读写 —— 少这一档时读得好好的、一到回填就 403，
    // 报错码和「表没加协作者」混在一起，不说清楚没人能想到是权限档位。
    const server = makeWriteBackSheetServer({ sheetWriteHttpStatus: 403 })
    const { source } = makeWriteBackSource(server)

    const receipt = await source.writeResult('sh-seq-A-1', { result: '已修好' })
    assert.equal(receipt.written, false)
    assert.equal(receipt.errorKind, 'auth')
    assert.equal(receipt.retryable, false)
    assert.ok(String(receipt.note).includes('sheets:spreadsheet'), `note 要点名权限名，实际 ${receipt.note}`)
    assert.ok(String(receipt.note).includes('发布'), '不发布版本权限不生效，这一步必须写出来')
    assert.ok(String(receipt.note).includes('可编辑'), '还要确认表里把应用加成可编辑协作者')
  })

  await check('电子表格：失败票回填只写「处理结果」那一格', async () => {
    const server = makeWriteBackSheetServer()
    const { source } = makeWriteBackSource(server)

    await source.writeResult('sh-seq-A-2', {
      result: '[流水线] 失败：模型说它不想干',
      onlyResult: true,
    })
    const ranges = server.state.sheetWrites[0].valueRanges
    assert.equal(ranges.length, 1, '失败票只写一格')
    assert.equal(ranges[0].range, 'sh1!D3:D3', `只写「处理结果」那一列，实际 ${ranges[0].range}`)
    assert.deepEqual(ranges[0].values, [['[流水线] 失败：模型说它不想干']])
  })

  await check('电子表格：回填过的那一行下一轮不会被重复收票', async () => {
    // 这是本票最重要的一条：回填写「是否处理 = 是」→ 下一轮扫描看到「是」不再算处理中。
    // 如果回填写错了列（比如把结果写进状态列），这一行会永远停在「处理中」，
    // 每一轮都重收一遍 —— 票会无限循环。
    const server = makeWriteBackSheetServer()
    const { source } = makeWriteBackSource(server)
    const first = await source.scan(new AbortController().signal)
    assert.equal(first.created.length, 2, '一开始两行都在处理中')

    await source.writeResult('sh-seq-A-1', { status: '是', result: '已修好' })
    // 按回填的请求体把假表改掉 —— 这一步必须用**适配器真发出去的 range 与值**，
    // 否则测的是「我们以为它写了什么」。
    for (const item of server.state.sheetWrites[0].valueRanges) {
      const m = item.range.match(/^([^!]+)!([A-Z]+)(\d+):/)
      const columnIndex = m[2].charCodeAt(0) - 'A'.charCodeAt(0)
      const rowIndex = Number(m[3]) - 1
      server.state.sheetValues[rowIndex][columnIndex] = item.values[0][0]
    }
    assert.equal(server.state.sheetValues[1][2], '是', '状态列的格子要被改成「是」')

    const second = await source.scan(new AbortController().signal)
    assert.equal(second.created.length, 0, '已回填的那行不许被再收一遍')
    assert.equal(second.updated.length, 0, '内容没改，也不该算修订')
  })

  await check('电子表格：回填要打对 spreadsheetToken 与工作表 id', async () => {
    const server = makeWriteBackSheetServer()
    const { source } = makeWriteBackSource(server)
    await source.writeResult('sh-seq-A-1', { result: '已修好' })
    const write = server.requests.find((r) => r.url.includes('/values_batch_update'))
    assert.ok(write, '要走 values_batch_update')
    assert.ok(write.url.includes('shtcnABCDEF'), `要打对 token，实际 ${write.url}`)
    assert.ok(write.url.includes('/sheets/v2/spreadsheets/'), 'v2 接口')
  })

  await check('电子表格：sheetId 不在清单里就报错并列出所有工作表', async () => {
    const server = makeSheetServer()
    const { source } = makeSource(server, {
      appToken: '',
      tableId: '',
      spreadsheetToken: 'shtcnABCDEF',
      sheetId: 'shNOPE',
    })
    await assert.rejects(
      () => source.scan(new AbortController().signal),
      (error) => error.kind === 'invalid-input'
        && error.message.includes('shNOPE')
        && error.message.includes('工单')
        && error.message.includes('归档'),
      'sheetId 拼错时要让人看到现有工作表清单',
    )
  })

  await check('电子表格：sheetName 命中 2 张同名时报错让人改用 sheetId', async () => {
    const server = createFakeServer({
      sheets: [
        { sheet_id: 'sh1', title: '同名', index: 0, hidden: false },
        { sheet_id: 'sh2', title: '同名', index: 1, hidden: false },
      ],
      sheetValues: makeSheetValues(),
    })
    const { source } = makeSource(server, {
      appToken: '',
      tableId: '',
      spreadsheetToken: 'shtcnABCDEF',
      sheetName: '同名',
    })
    await assert.rejects(
      () => source.scan(new AbortController().signal),
      (error) => error.kind === 'invalid-input' && error.message.includes('sheetId'),
      '同名工作表不能瞎挑一张',
    )
  })

  await check('电子表格：sheetHeaderRow=2 时在第 2 行的表头里认列名', async () => {
    const server = makeSheetServer({
      sheetValues: [
        ['PMS 工单导出（自动生成，勿手改）', '', '', '', '', ''],
        ['序号', '发现部门', '问题描述', '是否处理', '优先级', '模块'],
        ['B-1', '客服', '第二行才是表头时的票', '处理中', '低', '订单'],
      ],
    })
    const { source } = makeSource(server, {
      appToken: '',
      tableId: '',
      spreadsheetToken: 'shtcnABCDEF',
      sheetId: 'sh1',
      sheetHeaderRow: 2,
    })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1)
    assert.equal(result.created[0].recordId, 'sh-seq-B-1', '第 2 行做表头时数据从第 3 行开始')
    assert.equal(result.created[0].description, '第二行才是表头时的票')
  })

  await check('电子表格：表头缺「问题描述」时报错并列出读到的列名', async () => {
    const server = makeSheetServer({
      sheetValues: [
        ['序号', '发现部门', '是否处理'],
        ['C-1', '客服', '处理中'],
      ],
    })
    const { source } = makeSource(server, {
      appToken: '',
      tableId: '',
      spreadsheetToken: 'shtcnABCDEF',
      sheetId: 'sh1',
    })
    await assert.rejects(
      () => source.scan(new AbortController().signal),
      (error) => error.kind === 'invalid-input'
        && error.message.includes('问题描述')
        && error.message.includes('序号'),
      '必需列缺失要把「你表里到底有什么列」告诉人',
    )
  })

  await check('电子表格：数到别名「缺陷描述」也算问题描述列', async () => {
    const server = makeSheetServer({
      sheetValues: [
        ['序号', '缺陷描述', '是否处理'],
        ['D-1', '别名表头也能认', '处理中'],
      ],
    })
    const { source } = makeSource(server, {
      appToken: '',
      tableId: '',
      spreadsheetToken: 'shtcnABCDEF',
      sheetId: 'sh1',
    })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1)
    assert.equal(result.created[0].description, '别名表头也能认')
  })

  await check('电子表格：序号为空时用行号兜底，并标 fallback-row', async () => {
    const server = makeSheetServer({
      sheetValues: [
        ['序号', '问题描述', '是否处理'],
        ['', '序号没填的行也要收', '处理中'],
      ],
    })
    const { source } = makeSource(server, {
      appToken: '',
      tableId: '',
      spreadsheetToken: 'shtcnABCDEF',
      sheetId: 'sh1',
    })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1)
    assert.equal(result.created[0].recordId, 'sh-row-2', '序号空 → 用物理行号当身份')
    assert.equal(result.created[0].raw.identitySource, 'fallback-row', '要标出来这是兜底身份，方便排查')
  })

  await check('电子表格：同一轮序号重复直接报错，不许来回刷票', async () => {
    const server = makeSheetServer({
      sheetValues: [
        ['序号', '问题描述', '是否处理'],
        ['X-1', '第一张', '处理中'],
        ['X-1', '第二张用了同一个序号', '处理中'],
      ],
    })
    const { source } = makeSource(server, {
      appToken: '',
      tableId: '',
      spreadsheetToken: 'shtcnABCDEF',
      sheetId: 'sh1',
    })
    await assert.rejects(
      () => source.scan(new AbortController().signal),
      (error) => error.kind === 'invalid-input'
        && error.message.includes('X-1')
        && error.message.includes('sheetIdentity'),
      '序号重复必须报错并给出逃生阀（改用 row 身份）',
    )
  })

  await check('电子表格：水位——连扫两轮不重复推、改描述算 updated、只改「是否处理」不算变更', async () => {
    const server = makeSheetServer()
    const { source } = makeSource(server, {
      appToken: '',
      tableId: '',
      spreadsheetToken: 'shtcnABCDEF',
      sheetId: 'sh1',
    })
    const signal = new AbortController().signal

    const first = await source.scan(signal)
    assert.equal(first.created.length, 1, '首轮把「处理中」那行收进来')

    const second = await source.scan(signal)
    assert.equal(second.created.length, 0, '内容没变不能重复推新票')
    assert.equal(second.updated.length, 0, '内容没变也不能算修订')

    // 只改状态（处理中 → 否）不算内容变更，只是退役。
    server.state.sheetValues[1] = ['A-1', '客服', '列表翻页丢数据', '否', '高', '订单']
    const third = await source.scan(signal)
    assert.deepEqual(third.disappeared, ['sh-seq-A-1'], '拨出「处理中」= 退役，不是修订')
    assert.equal(third.updated.length, 0, '状态列不算内容变更')

    // 拨回「处理中」= 手动重置，要重新收。
    server.state.sheetValues[1] = ['A-1', '客服', '列表翻页丢数据', '处理中', '高', '订单']
    const fourth = await source.scan(signal)
    assert.equal(fourth.created.length, 1, '从「否」拨回「处理中」应重新入队')
    assert.equal(fourth.created[0].recordId, 'sh-seq-A-1')

    // 改描述 = 内容变更 = updated。
    server.state.sheetValues[1] = ['A-1', '客服', '列表翻页丢数据（补充：只在第 2 页）', '处理中', '高', '订单']
    const fifth = await source.scan(signal)
    assert.equal(fifth.updated.length, 1, '描述变了要当修订推一遍')
    assert.equal(fifth.created.length, 0)
  })

  await check('电子表格：被删的行要连续 goneAfterScans 轮不见才退役', async () => {
    const server = makeSheetServer()
    const { source } = makeSource(server, {
      appToken: '',
      tableId: '',
      spreadsheetToken: 'shtcnABCDEF',
      sheetId: 'sh1',
      goneAfterScans: 2,
    })
    const signal = new AbortController().signal
    await source.scan(signal)

    // 把「处理中」那行删掉（只剩表头 + 另一行）。
    server.state.sheetValues = [
      ['序号', '发现部门', '问题描述', '是否处理', '优先级', '模块'],
      ['A-2', '运营', '导出少一行', '否', '中', '报表'],
    ]
    const second = await source.scan(signal)
    assert.deepEqual(second.disappeared, [], '第一轮不见还不能退役（可能是临时取数不全）')
    const third = await source.scan(signal)
    assert.deepEqual(third.disappeared, ['sh-seq-A-1'], '连续两轮不见才退役')
  })

  await check('电子表格：截图 url 不在白名单一律拒绝（SSRF 防线不能因为换表型就松）', async () => {
    const server = makeSheetServer({
      sheetValues: [
        ['序号', '问题描述', '是否处理', '截图'],
        ['E-1', '带外链截图的行', '处理中', 'https://evil.test/a.png'],
      ],
    })
    const { source } = makeSource(server, {
      appToken: '',
      tableId: '',
      spreadsheetToken: 'shtcnABCDEF',
      sheetId: 'sh1',
      allowedImageHosts: [],
    })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1, '截图取不到不该阻塞收票')
    const shot = result.created[0].screenshots[0]
    assert.equal(shot.kind, 'url')
    await assert.rejects(
      () => source.loadScreenshot(shot),
      (error) => error.kind === 'invalid-input' && error.message.includes('evil.test'),
      '不在白名单的主机必须拒绝',
    )
  })

  await check('电子表格：截图 path 形态能读出本地字节', async () => {
    const server = makeSheetServer({
      sheetValues: [
        ['序号', '问题描述', '是否处理', '截图'],
        ['F-1', '带本地路径截图', '处理中', 'D:/shots/f1.png'],
      ],
    })
    const { source } = makeSource(server, {
      appToken: '',
      tableId: '',
      spreadsheetToken: 'shtcnABCDEF',
      sheetId: 'sh1',
      readLocalFile: async (path) => {
        assert.equal(path, 'D:/shots/f1.png')
        // 宿主注入的读文件服务回的是 `{ data, mediaType, name }`（不是裸字节），
        // 媒体类型要由它给，适配器只做「是不是图片」这道判断。
        return { data: PNG_BYTES, mediaType: 'image/png', name: 'f1.png' }
      },
    })
    const result = await source.scan(new AbortController().signal)
    const shot = result.created[0].screenshots[0]
    assert.equal(shot.kind, 'path')
    const loaded = await source.loadScreenshot(shot)
    assert.deepEqual(loaded.data, PNG_BYTES)
    assert.equal(loaded.mediaType, 'image/png')
  })

  await check('电子表格：tableKind 显式写了就跳过探测（一次 tables 请求都不发）', async () => {
    const server = makeSheetServer()
    const { source } = makeSource(server, {
      appToken: 'SOMEAPPTOKEN',
      tableId: '',
      spreadsheetToken: 'shtcnABCDEF',
      sheetId: 'sh1',
      tableKind: 'sheet',
    })
    const result = await source.scan(new AbortController().signal)
    assert.equal(result.created.length, 1)
    assert.ok(
      !server.requests.some((r) => r.url.includes('/bitable/')),
      '显式指定表型后不该再去试多维表格接口',
    )
  })

  await check('电子表格：纯函数——列字母、range、日期、优先级、列名覆盖', async () => {
    // 这些是表型分派的算术地基，写错了上层全部歪，所以单独钉死。
    assert.equal(columnLetter(0), 'A')
    assert.equal(columnLetter(25), 'Z')
    assert.equal(columnLetter(26), 'AA')
    assert.equal(columnIndex('A'), 0)
    assert.equal(columnIndex('AA'), 26)
    assert.throws(() => columnLetter(-1), /列号不合法/)
    assert.throws(() => columnIndex('A1'), /列字母不合法/)

    assert.deepEqual(parseSheetRange('A1:M500'), { startColumn: 0, startRow: 1, endColumn: 12, endRow: 500 })
    assert.deepEqual(parseSheetRange('B2:K'), { startColumn: 1, startRow: 2, endColumn: 10, endRow: undefined })
    assert.equal(parseSheetRange(''), undefined)
    assert.throws(() => parseSheetRange('M1:A5'), /结束列在起始列左边/)
    assert.throws(() => parseSheetRange('A5:M1'), /结束行在起始行上边/)
    assert.throws(() => parseSheetRange('A1:M500,N1:P600'), /只支持单段/)

    assert.equal(
      buildValueRange({ range: { startColumn: 0, startRow: 1 }, endColumn: 7 }),
      'A1:H',
      '不给 sheetRange 时读到表头宽度',
    )
    assert.equal(
      buildValueRange({ range: { startColumn: 0, startRow: 2, endColumn: 12, endRow: 500 } }),
      'A2:M500',
    )

    // 日期归一成 `YYYY-MM-DD` 字符串（不是时间戳）：下游 fingerprint 要稳定，
    // 而时区无关的字符串最稳。中文日期 / 斜杠 / 点号写法都要认。
    assert.equal(normalizeSheetDate('2026年11月9日'), '2026-11-09')
    assert.equal(normalizeSheetDate('2026/11/9'), '2026-11-09')
    assert.equal(normalizeSheetDate('2026.11.9'), '2026-11-09')
    assert.equal(normalizeSheetDate(''), '')
    // Excel 序列号换算：46000 天对应 20 世纪末的某天，只验证换算不抛且是合法日期。
    assert.match(normalizeSheetDate(46000), /^\d{4}-\d{2}-\d{2}$/, 'Excel 序列号也要能换算成日期')
    assert.equal(sheetPriorityOf('严重'), 'high', '金山表里的「严重」要并进来')
    assert.equal(sheetPriorityOf('轻微'), 'low')
    assert.equal(sheetPriorityOf('高'), 'high')
    assert.equal(sheetPriorityOf('看不懂'), undefined)

    // 列名覆盖：把「问题描述」改成自家叫法，覆盖后仍认得必需列。
    const header = locateSheetHeader(
      [['序号', '我的问题描述列', '是否处理'], ['G-1', '自家列名也能认', '处理中']],
      { headerRow: 1, columns: resolveSheetColumns({ description: '我的问题描述列' }) },
    )
    assert.equal(header.columns.description, 1, 'sheetColumns 覆盖要生效')
    assert.ok(SHEET_COLUMN_ALIASES.description.includes('问题描述'))

    // 行身份三形态
    assert.deepEqual(buildRowIdentity({ mode: 'seq', seqValue: '1.0', rowNumber: 5 }), { recordId: 'sh-seq-1', identitySource: 'seq' })
    assert.deepEqual(buildRowIdentity({ mode: 'seq', seqValue: '', rowNumber: 5 }), { recordId: 'sh-row-5', identitySource: 'fallback-row' })
    assert.deepEqual(buildRowIdentity({ mode: 'row', seqValue: 'X', rowNumber: 5 }), { recordId: 'sh-row-5', identitySource: 'row' })

    // 整行空白 / 问题描述为空的行不产票
    const parsed = parseSheetRows({
      values: [
        ['序号', '问题描述', '是否处理'],
        ['', '', ''],
        ['H-1', '真的有问题', '处理中'],
      ],
      header: { headerRow: 1, columns: { seq: 0, description: 1, status: 2 }, headers: [] },
      identity: 'seq',
      idColumn: '序号',
      extractScreenshots: () => [],
    })
    assert.equal(parsed.length, 1, '空白行必须跳过')
    assert.equal(parsed[0].recordId, 'sh-seq-H-1')
  })
}