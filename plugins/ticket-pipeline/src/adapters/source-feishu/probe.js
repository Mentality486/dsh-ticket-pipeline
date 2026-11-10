/**
 * 飞书连通性探测 —— 给 `pipeline_doctor` 用。
 *
 * ## 为什么单独一个文件，而不是塞进 `createFeishuSource`
 *
 * 体检和扫票是两件事：
 *
 * - 扫票**假设**一切配好了，开始就调 `getToken()`，出错就是一张票挂了。
 * - 体检要的是**分层定位**：是 App ID/Secret 错？还是权限没开？还是版本没发布？
 *   还是表格没把应用加成协作者？这四件事在飞书那边报的错码不同、修法也完全不同，
 *   而用户此时手里没有任何线索。所以这里按「认证 → 表元数据 → 第一页数据」
 *   三级逐层试，**每层都单独给出人话与修复动作**，让第一处失败就足够定位。
 *
 * 另一个好处是可以完全离线自测：所有网络访问都走注入的 `fetch`。
 *
 * ## 边界
 *
 * - **只读**：只发 GET 与 `records/search`（POST 但语义是查询），不写任何表格。
 * - **绝不抛错**：每一项都用 try/catch 包起来，失败变成一条结论（含 code 与修法）。
 *   体检本身就是排查工具，它自己炸掉没有任何价值。
 * - **每项都有超时**：缺省 10 秒。超时按「可能是网络问题」处理，不算权限问题。
 */

import { PipelineError } from '../../contracts/errors.js'
import { normalizeCellText, resolveStatusValues } from './index.js'
import {
  BITABLE_COLUMN_ALIASES,
  mapColumns,
  normalizeHeaderKey,
} from './sheets.js'

const FEISHU_API_BASE = 'https://open.feishu.cn'
const AUTH_PATH = '/open-apis/auth/v3/tenant_access_token/internal'

/** 体检里每个网络请求的超时（毫秒）。10 秒：够慢网出结果，又不至于让体检拖成分钟级。 */
export const PROBE_TIMEOUT_MS = 10_000

/**
 * 这些错误码的意思是「你拿错类型来问我了」，不是故障 —— 值得换另一种表型再试。
 *
 * `1254003 WrongBaseToken` 是最常见的那个：拿电子表格的 token 去问
 * `/bitable/v1/apps/<token>/tables`，飞书回的就是它。归成「真故障」会让
 * 「只贴了一个 wiki token 的电子表格」永远走不到电子表格分支（实测 2026-11-10）。
 */
const TYPE_MISMATCH_CODES = new Set([1254003, 1254005, 1254006, 1254007, 1254043, 1254045])

/**
 * 这个错误值不值得「再按电子表格试一次」。
 *
 * 与适配器 `resolveTable()` 里的 `shouldTrySheet()` 同一口径（2026-11-10 对齐）：
 * 只有「不是这个类型」那类错才该换条路 —— `1254003 WrongBaseToken`（拿电子表格
 * token 问多维表格）、`1254005/1254006/1254007`、表不存在（`1254043/1254045`）、
 * 以及非 2xx 的 400/404。凭据错、限流、网络错都是真故障，换条路只会把真因埋掉。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function shouldFallbackToSheet (error) {
  if (error instanceof ProbeHttpError) {
    if (error.code !== undefined && TYPE_MISMATCH_CODES.has(error.code)) return true
    return error.status === 400 || error.status === 404
  }
  if (error instanceof PipelineError && error.kind === 'invalid-input') return true
  return false
}

/**
 * 飞书错误码 → 人话 + 修法。
 *
 * 只收**体检语境下能给出可执行指引**的码。没列到的码不猜，原样带出
 * `飞书返回 <code>：<msg>`，让人能把原文贴给会看的人。
 */
const CODE_HINTS = Object.freeze({
  // ── 认证层 ────────────────────────────────────────────────
  10014: {
    message: 'App ID / App Secret 不匹配',
    fix: '去飞书开放平台的「凭证与基础信息」页，把 App ID 与 App Secret 重新复制一遍 ——'
      + '注意 App Secret 只能看一次，点了「重置」之后旧的立刻失效。',
  },
  10013: {
    message: 'App ID / App Secret 不匹配',
    fix: '去飞书开放平台的「凭证与基础信息」页核对 App ID 与 App Secret（App Secret 重置后旧值立刻失效）。',
  },
  // ── 权限层 ────────────────────────────────────────────────
  91403: {
    message: '没权限（应用没开通这个接口的权限）',
    fix: '开放平台 →「权限管理」→ 添加「多维表格」的读取权限 → 然后**创建版本并发布**'
      + '（不发布版本，权限不生效，这是最容易漏的一步）。',
  },
  99991672: {
    message: '没权限（应用没开通这个接口的权限）',
    fix: '开放平台 →「权限管理」→ 补上对应权限 → **创建版本并发布**。',
  },
  99991663: {
    message: 'tenant_access_token 无效或已过期',
    fix: '先确认 App ID / App Secret 是对的；如果刚重置过 Secret，重装插件后重启宿主。',
  },
  // ── 文档授权层 ────────────────────────────────────────────
  1254043: {
    message: '表不存在，或者应用不是这张表的协作者',
    fix: '打开那张表 → 右上角「…」→「更多」→「添加文档应用」→ 把这个应用加为**可编辑**协作者。',
  },
  1254045: {
    message: '表不存在，或者应用不是这张表的协作者',
    fix: '打开那张表 → 右上角「…」→「更多」→「添加文档应用」→ 把这个应用加为**可编辑**协作者。',
  },
  1254301: {
    message: '应用没有访问这张多维表格的权限',
    fix: '表格 →「…」→「更多」→「添加文档应用」，把应用加为可编辑协作者。',
  },
})

/**
 * 把一次失败归一成 `{ message, fix, code }`。
 *
 * @param {unknown} error
 * @returns {{ message: string, fix?: string, code?: number }}
 */
export function describeProbeFailure (error) {
  if (error instanceof ProbeHttpError) {
    const hint = error.code !== undefined ? CODE_HINTS[error.code] : undefined
    if (hint) return { code: error.code, message: hint.message, fix: hint.fix }
    if (error.status === 401 || error.status === 403) {
      return {
        message: `飞书拒绝了请求（HTTP ${error.status}）`,
        fix: '多半是应用没被加为这张表的协作者：表格 →「…」→「更多」→「添加文档应用」，加为可编辑协作者。',
      }
    }
    const detail = error.code !== undefined ? `飞书返回 ${error.code}：${error.msg}` : `HTTP ${error.status}`
    return { code: error.code, message: detail }
  }
  if (error instanceof PipelineError) {
    if (error.kind === 'network') {
      return { message: '连不上飞书（网络问题，不是配置问题）', fix: '检查这台机器能不能访问 open.feishu.cn，或在有网的机器上再跑一次体检。' }
    }
    return { message: error.message }
  }
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return { message: '检查超时，可能是网络问题', fix: '这一项 10 秒内没回来。网络慢或飞书侧慢，重跑一次体检；一直超时就先确认机器能不能访问 open.feishu.cn。' }
  }
  return { message: String(error?.message ?? error) }
}

/** 飞书返回了业务错误码或非 2xx。 */
class ProbeHttpError extends Error {
  /**
   * @param {number} status
   * @param {number | undefined} code
   * @param {string} msg
   */
  constructor (status, code, msg) {
    super(code !== undefined ? `飞书 ${code}：${msg}` : `HTTP ${status}${msg ? `：${msg}` : ''}`)
    this.name = 'ProbeHttpError'
    this.status = status
    this.code = code
    this.msg = msg
  }
}

/**
 * 走一次飞书 REST 接口，返回 `data`（没有 `data` 层时返回整个 payload）。
 *
 * 不复用 `createFeishuSource` 内部的 `apiCall`：那一份要「失败就抛、让上层决定重试」，
 * 体检要「失败就记录、继续查下一项」，两套控制流硬合会变成一堆 try/catch 互相让路。
 *
 * @param {object} input
 * @param {(url: string, init?: any) => Promise<any>} input.fetchImpl
 * @param {string} input.path
 * @param {{ method?: string, body?: unknown, query?: Record<string, string | number | undefined>, token?: string | null }} [input.init]
 * @param {number} input.timeoutMs
 * @returns {Promise<any>}
 */
async function feishuCall (input) {
  const url = new URL(FEISHU_API_BASE + input.path)
  for (const [key, value] of Object.entries(input.init?.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
  }
  const headers = { 'Content-Type': 'application/json; charset=utf-8' }
  if (input.init?.token) headers.Authorization = `Bearer ${input.init.token}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  let response
  try {
    response = await input.fetchImpl(url.toString(), {
      method: input.init?.method ?? 'GET',
      headers,
      body: input.init?.body === undefined ? undefined : JSON.stringify(input.init.body),
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) {
      const timeout = new Error('检查超时，可能是网络问题')
      timeout.name = 'TimeoutError'
      throw timeout
    }
    throw new PipelineError('network', `调用飞书接口失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    // 401/403 的响应体里也带飞书 code，能读就读出来（便于拼出有意义的提示）。
    let bodyCode
    let bodyMsg = ''
    try {
      const raw = await response.text()
      const parsed = JSON.parse(raw)
      bodyCode = Number(parsed?.code) || undefined
      bodyMsg = String(parsed?.msg ?? '')
    } catch { /* 读不到就只报 HTTP 状态 */ }
    throw new ProbeHttpError(response.status, bodyCode, bodyMsg)
  }

  let payload
  try {
    payload = await response.json()
  } catch (error) {
    throw new PipelineError('internal', `飞书接口返回的不是 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const code = Number(payload?.code ?? 0)
  if (code !== 0) throw new ProbeHttpError(200, code, String(payload?.msg ?? '未知错误'))
  return payload?.data === undefined ? (payload ?? {}) : payload.data
}

/**
 * 这个值是不是 wiki 形态（wiki 链接或 `wiki` 开头的 token）。
 *
 * 体检必须与适配器认同一组输入形态：用户在面板上贴的常常是知识库里的
 * 一条 `/wiki/<node_token>?sheet=xxxx` 链接，而不是裸的 spreadsheetToken。
 *
 * @param {string} raw
 * @returns {boolean}
 */
function isWikiToken (raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return false
  if (/\/wiki\//.test(text)) return true
  return /^wiki/i.test(text)
}

/**
 * 从 wiki 链接 / wiki token 里抠出裸 node token。
 * @param {unknown} raw
 * @returns {string}
 */
function extractWikiToken (raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return ''
  const urlMatch = text.match(/\/wiki\/([A-Za-z0-9]+)/)
  if (urlMatch) return urlMatch[1]
  const bare = text.match(/^([A-Za-z0-9]+)$/)
  if (bare) return bare[1]
  return text
}

/**
 * 从用户填的值里抠出裸 spreadsheetToken（整条表格链接 / 裸 token / wiki 链接都认）。
 *
 * **这是补 Bug 的一层**：探针以前把 `match.spreadsheetToken` 原样塞进请求路径，
 * 于是「面板上贴整条链接」这个被文档推荐的做法，在体检里必然 404 —— 而适配器本体
 * （`index.js` 的 `extractSheetToken`）一直是会归一化的。两边认的输入形态不一致，
 * 体检就会把「探针自己拼错了地址」报成「你读不到表元数据」，这是最坏的一种误导。
 *
 * @param {unknown} raw
 * @returns {string}
 */
function extractSheetToken (raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return ''
  const urlMatch = text.match(/\/sheets\/([A-Za-z0-9]+)/)
  if (urlMatch) return urlMatch[1]
  // 知识库里的电子表格从地址栏复制出来是 `/wiki/<node_token>`：node token 本身就能
  // 当 spreadsheetToken 用（实测 2026-11-10），抠出来即可，不必先换成 obj_token。
  const wikiMatch = text.match(/\/wiki\/([A-Za-z0-9]+)/)
  if (wikiMatch) return wikiMatch[1]
  const bare = text.match(/^([A-Za-z0-9]+)$/)
  if (bare) return bare[1]
  return text
}

/**
 * 探测一个飞书项目的可达性：认证 → 表元数据 → 第一页数据。
 *
 * @param {object} input
 * @param {string} input.appId
 * @param {string} input.appSecret
 * @param {string} input.projectName
 * @param {any} input.match 项目条目的 `match`
 * @param {string} input.accessToken 已经换到的 tenant_access_token（本函数不自己认证）
 * @param {(url: string, init?: any) => Promise<any>} input.fetchImpl
 * @param {number} [input.timeoutMs]
 * @returns {Promise<{ token: ProbeStep, project: null | { name: string, kind: 'bitable' | 'sheet' | 'unknown', table: string, metadata: ProbeStep, records: ProbeStep } }>}
 */
async function probeOneProject (input) {
  const match = input.match ?? {}
  const appToken = String(match.appToken ?? '').trim()
  const tableId = String(match.tableId ?? '').trim()
  const spreadsheetToken = String(match.spreadsheetToken ?? '').trim()
  const tableKindOption = String(match.tableKind ?? '').trim()
  const resolvedSheetName = String(match.sheetName ?? '').trim()
  let resolvedSheetId = String(match.sheetId ?? '').trim()

  // 表型判定：`spreadsheetToken` 与 `appToken` 谁非空只决定**先试哪条路**，
  // 真正的类型以下面的探测结果为准。
  //
  // 为什么不能只看「哪个字段非空」就说结论（2026-11-10 的真实事故）：
  // 面板上「工单表链接」贴一条 `/wiki/<token>` 链接时，宿主把**裸 wiki token**
  // 写进 `appToken`（那个节点背后既可能是多维表格，也可能是电子表格）。
  // 以前的体检看到 `appToken` 非空就直接按多维表格去问 `bitable/v1/apps/<token>`，
  // 电子表格必然回 `1254003 WrongBaseToken` —— 于是**扫票明明是好的，体检却报红**，
  // 人就被引去改配置。体检与适配器必须认同一套输入形态。
  /** @type {'bitable' | 'sheet' | 'unknown'} */
  let kind = 'unknown'
  if (tableKindOption === 'sheet' && (spreadsheetToken.length > 0 || appToken.length > 0)) kind = 'sheet'
  else if (tableKindOption === 'bitable' && appToken.length > 0) kind = 'bitable'
  else if (spreadsheetToken.length > 0) kind = 'sheet'
  else if (appToken.length > 0) kind = 'bitable'

  // 电子表格的 token 先归一一次（整条链接 → 裸 token），呈现给人看的 table 才不是一坨 URL。
  let sheetToken = extractSheetToken(spreadsheetToken.length > 0 ? spreadsheetToken : (kind === 'sheet' ? appToken : ''))
  let bitableToken = appToken
  let resolvedTableId = tableId

  const base = {
    name: input.projectName,
    kind,
    table: kind === 'sheet'
      ? (sheetToken || spreadsheetToken || appToken)
      : (tableId.length > 0 ? `${appToken}/${tableId}` : appToken),
    metadata: { ok: false },
    records: { ok: false },
  }
  if (kind === 'unknown') {
    base.metadata = { ok: false, message: '项目没绑表（既没有 appToken 也没有 spreadsheetToken）' }
    base.records = { ok: false, message: '没有表可读' }
    return base
  }

  // 每个项目级请求都带着上面换到的 token：一次体检只换一次 token，
  // 不在每一层重新认证（飞书对认证接口有频率限制，体检不该消耗它）。
  const call = (path, init) => feishuCall({
    fetchImpl: input.fetchImpl,
    path,
    init: { ...(init ?? {}), token: input.accessToken },
    timeoutMs: input.timeoutMs ?? PROBE_TIMEOUT_MS,
  })

  // ── 表型探测 + 表元数据 ────────────────────────────────────
  //
  // `appToken` 不一定真是多维表格：面板「工单表链接」贴 `/wiki/<token>` 时，宿主
  // 写进去的是**裸 wiki token**，而那个节点背后可能是多维表格、也可能是电子表格。
  // 所以这里不能「看到 appToken 就按多维表格问」，要照适配器 `resolveTable()` 的
  // 同一套顺序探测；否则扫票明明是好的，体检却报 `1254003 WrongBaseToken` 把人引偏。
  /** 多维表格侧要试的 app_token 候选（wiki 节点会带两个）。 */
  const bitableCandidates = appToken.length > 0 ? [appToken] : []

  /** 读电子表格元数据（同时定下要读第一页数据的 sheet 锚点）。 */
  const readSheetMetadata = async () => {
    // wiki 形态（知识库里存着的电子表格）要先用 `get_node` 换出 obj_token ——
    // 直接拿 `/wiki/<node_token>` 的 node token 去查 sheets 接口同样会 404。
    if (isWikiToken(spreadsheetToken) || isWikiToken(sheetToken)) {
      const nodeToken = extractWikiToken(spreadsheetToken.length > 0 ? spreadsheetToken : appToken)
      const node = await call('/open-apis/wiki/v2/spaces/get_node', { query: { token: nodeToken } })
      const objToken = String(node?.node?.obj_token ?? '')
      // 注意：wiki token 与 obj_token **两者都能当 spreadsheetToken 用**（实测 2026-11-10），
      // 所以 obj_token 读不到时退回 nodeToken 也是一条能跑的路，不必当成错误。
      if (objToken.length > 0) sheetToken = objToken
      else if (sheetToken.length === 0) sheetToken = nodeToken
      base.table = sheetToken
    }
    const data = await call(`/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(sheetToken)}/sheets/query`, {})
    const sheets = Array.isArray(data?.sheets) ? data.sheets : []
    base.metadata = { ok: true, message: `能读到电子表格元数据（${sheets.length} 个工作表）` }
    if (resolvedSheetId.length === 0) {
      // 没指定 sheet 时挑第一个：体检只需要「能不能读到数据」，不需要挑对表。
      const first = sheets[0]
      if (first?.sheet_id) resolvedSheetId = String(first.sheet_id)
      else if (first?.title) resolvedSheetId = String(first.title)
    }
  }

  /** 读多维表格元数据；wiki 节点先问 `get_node` 定真实类型。 */
  const readBitableMetadata = async () => {
    if (isWikiToken(appToken)) {
      const nodeToken = extractWikiToken(appToken)
      const node = await call('/open-apis/wiki/v2/spaces/get_node', { query: { token: nodeToken } })
      const objType = String(node?.node?.obj_type ?? '')
      const objToken = String(node?.node?.obj_token ?? '')
      if (objType.length > 0 && objType !== 'bitable' && objType !== 'sheet') {
        const error = new PipelineError('invalid-input', `wiki 节点 ${nodeToken} 是「${objType}」，既不是多维表格也不是电子表格`)
        error.probeKind = objType
        throw error
      }
      // 多维表格：obj_token 与 wiki token 都可能被 bitable API 接受（新版吃 wiki token，
      // 旧版要 obj_token），两个都试。裸 wiki token 要抠出来，整条 URL 拼进 path 是另一回事。
      if (objToken.length > 0 && !bitableCandidates.includes(objToken)) bitableCandidates.unshift(objToken)
      if (!bitableCandidates.includes(nodeToken)) bitableCandidates.push(nodeToken)
    }
    let lastError = null
    const attempts = []
    for (const candidate of bitableCandidates) {
      try {
        const data = await call(`/open-apis/bitable/v1/apps/${encodeURIComponent(candidate)}/tables`, { query: { page_size: 100 } })
        const tables = Array.isArray(data?.items) ? data.items : []
        base.kind = 'bitable'
        base.table = resolvedTableId.length > 0 ? `${candidate}/${resolvedTableId}` : candidate
        base.metadata = { ok: true, message: `能读到多维表格元数据（${tables.length} 张数据表）` }
        if (resolvedTableId.length === 0 && tables.length > 0) {
          // 没写 tableId 时配置层靠 docNamePattern 猜；体检没有那个上下文，
          // 就退一步用第一张表 —— 只为了验证「能不能读数据」，不承诺挑对表。
          const first = tables[0]
          if (first?.table_id) resolvedTableId = String(first.table_id)
          bitableToken = candidate
        } else {
          bitableToken = candidate
        }
        return
      } catch (error) {
        attempts.push(error)
        lastError = error
      }
    }
    throw lastError ?? new PipelineError('internal', '多维表格读表失败')
  }

  // ── 状态值口径采样 ────────────────────────────────────────
  //
  // 「环境体检全绿、却一张票都收不到」最常见的原因不是权限，是**状态列的取值对不上**：
  // 插件缺省只认「处理中」（`IN_PROGRESS_VALUE`），而这批表的实际取值是「是 / 否」或
  // 空 —— 实测（2026-11-10）同一张表 `statusValues: ['处理中']` 收 0 张、`['是']` 收 73 张。
  //
  // 这件事**体检原来查不出来**：它只看「读不读得到数据」，不看「读到的状态值是不是你要的」。
  // 于是人看到一片绿却收不到票，只能去翻文档猜字段名。这里把采样结果摆出来，
  // 对不上时直接说「表里实际是这些值，你的配置是那些」。
  //
  // 只报「一个都对不上」，不报「少了一个」：真实表里常有历史脏值（空、错别字），
  // 只要有一个能对上就说明配置没错，剩下的交给 `sheetIdentity` / 过滤逻辑处理。

  /** 采样里最多看多少行。100 行足够看出取值分布，又不会让体检读整张表。 */
  const STATUS_SAMPLE_ROWS = 100

  /** 把一组「表里真实出现的状态值」与「配置里认的状态值」放一起比。 */
  const compareStatusValues = (values) => {
    const actual = [...new Set(values.map((text) => String(text ?? '').trim()).filter((text) => text.length > 0))]
    const expected = resolveStatusValues(match.statusValues)
    if (actual.length === 0) {
      // 采样里一个非空值都没有：表可能真没填，或状态列认错了。不猜，交给列映射那层报错。
      base.statusValues = { ok: true, values: [], expected, message: '这一批采样里状态列没有非空值（表可能是空的）' }
      return
    }
    const hit = actual.filter((text) => expected.includes(text))
    if (hit.length > 0) {
      base.statusValues = {
        ok: true,
        values: actual,
        expected,
        message: `状态值对得上（表里出现 ${actual.slice(0, 6).map((t) => `「${t}」`).join(' ')}${actual.length > 6 ? ' …' : ''}）`,
      }
      return
    }
    const shown = actual.slice(0, 6).map((text) => `「${text}」`).join(' ')
    base.statusValues = {
      ok: false,
      values: actual,
      expected,
      message: `状态列里没有一个是配置认的值（表里实际是 ${shown}${actual.length > 6 ? ' …' : ''}，配置认 ${expected.map((t) => `「${t}」`).join(' ')}）—— 这样一张票都收不到`,
      fix: `把「在处理中的状态值」改成表里真实出现的那个，比如 ${actual.slice(0, 2).map((t) => `「${t}」`).join(' 或 ')}。`,
    }
  }

  /** 电子表格：读表头 → 认状态列 → 采样这一列的值。 */
  const sampleSheetStatus = (rows) => {
    const matrix = Array.isArray(rows) ? rows : []
    const headerRow = Number(match.sheetHeaderRow ?? 1)
    const header = matrix[Number.isInteger(headerRow) && headerRow >= 1 ? headerRow - 1 : 0]
    if (!Array.isArray(header)) return
    let columns
    try {
      columns = mapColumns({ actualNames: header, overrides: match.sheetColumns }).columns
    } catch {
      return // 列名覆盖写坏了不在这里报 —— 真正扫票时会报得更清楚
    }
    if (columns.status === undefined) return // 认不出状态列，交给列映射那层的报错
    const values = []
    for (let index = (Number.isInteger(headerRow) && headerRow >= 1 ? headerRow : 1); index < matrix.length; index += 1) {
      const row = matrix[index]
      if (!Array.isArray(row)) continue
      const cell = row[columns.status]
      if (cell === null || cell === undefined || cell === '') continue
      values.push(String(cell).trim())
    }
    compareStatusValues(values)
  }

  /** 多维表格：用同一张别名表认字段名 → 采样该字段的值。 */
  const sampleBitableStatus = (items) => {
    const list = Array.isArray(items) ? items : []
    const values = []
    for (const item of list) {
      const fields = item?.fields ?? {}
      const key = Object.keys(fields).find((name) => {
        const normalized = normalizeHeaderKey(name)
        return (BITABLE_COLUMN_ALIASES.status ?? []).some((alias) => normalizeHeaderKey(alias) === normalized)
      })
      if (key === undefined) return // 认不出状态字段，交给别处报
      const text = normalizeCellText(fields[key])
      if (text.length > 0) values.push(text)
    }
    if (values.length === 0) return
    compareStatusValues(values)
  }

  try {
    if (kind === 'sheet') {
      await readSheetMetadata()
    } else {
      try {
        await readBitableMetadata()
      } catch (error) {
        // 「不是这个类型」才值得再试电子表格 —— 与适配器 `shouldTrySheet()` 同一口径。
        // 凭据错 / 限流 / 网络错都是真故障，改成试 sheet 只会把真因埋掉。
        if (!shouldFallbackToSheet(error)) throw error
        kind = 'sheet'
        sheetToken = extractSheetToken(appToken)
        base.kind = 'sheet'
        base.table = sheetToken || appToken
        await readSheetMetadata()
      }
    }
  } catch (error) {
    const failure = describeProbeFailure(error)
    base.metadata = { ok: false, ...failure }
    // 元数据都读不到，数据一定读不到，不再发第二个请求浪费配额。
    base.records = { ok: false, message: '上一步没通，这一步没查' }
    return base
  }

  // ── 第一页数据 ────────────────────────────────────────────
  try {
    if (kind === 'sheet') {
      const anchor = resolvedSheetId.length > 0 ? resolvedSheetId : (resolvedSheetName.length > 0 ? resolvedSheetName : '')
      if (anchor.length === 0) {
        base.records = { ok: false, message: '这张电子表格里没找到任何工作表，读不到数据' }
        return base
      }
      const range = `${anchor}!A1:Z${STATUS_SAMPLE_ROWS}`
      const data = await call(
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(sheetToken)}/values/${encodeURIComponent(range)}`,
        {},
      )
      const rows = Array.isArray(data?.valueRange?.values) ? data.valueRange.values : []
      base.metadata.table = range
      base.records = {
        ok: rows.length > 0,
        message: rows.length > 0
          ? `能读到第一页数据（${rows.length} 行）`
          : '表是空的（能连上，但一行数据都没有 —— 先确认填的是不是同一张表）',
      }
      sampleSheetStatus(rows)
    } else {
      if (resolvedTableId.length === 0) {
        base.records = { ok: false, message: '配置里没写 tableId，也没能自动猜出是哪张数据表' }
        return base
      }
      const data = await call(
        `/open-apis/bitable/v1/apps/${encodeURIComponent(bitableToken || appToken)}/tables/${encodeURIComponent(resolvedTableId)}/records/search`,
        { method: 'POST', body: { page_size: STATUS_SAMPLE_ROWS, automatic_fields: true } },
      )
      const items = Array.isArray(data?.items) ? data.items : []
      base.records = {
        ok: true,
        message: items.length > 0
          ? `能读到第一页数据（这张表里有记录）`
          : '表是空的（能连上，但一条记录都没有 —— 先确认填的是不是同一张表）',
      }
      sampleBitableStatus(items)
    }
  } catch (error) {
    base.records = { ok: false, ...describeProbeFailure(error) }
  }
  return base
}

/**
 * 体检用：探测飞书连通性（认证 + 每个配好的飞书项目）。
 *
 * @param {object} options
 * @param {string} [options.appId] 已解析出的 App ID（空 = 没配）
 * @param {string} [options.appSecret] 已解析出的 App Secret（空 = 没配）
 * @param {Array<{ name?: string, match?: any }>} [options.projects] 全部项目（内部只挑 feishu 的）
 * @param {(url: string, init?: any) => Promise<any>} [options.fetch] 注入的 fetch（自测用）
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{
 *   skipped: boolean,
 *   skipReason?: string,
 *   token: { ok: boolean, message: string, fix?: string, code?: number },
 *   projects: Array<{ name: string, kind: 'bitable' | 'sheet' | 'unknown', table: string, metadata: { ok: boolean, message?: string, fix?: string, code?: number }, records: { ok: boolean, message?: string, fix?: string, code?: number } }>
 * }>}
 */
export async function probeFeishuConnectivity (options = {}) {
  const appId = String(options.appId ?? '').trim()
  const appSecret = String(options.appSecret ?? '').trim()
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch
  const timeoutMs = Number(options.timeoutMs ?? PROBE_TIMEOUT_MS) > 0 ? Number(options.timeoutMs ?? PROBE_TIMEOUT_MS) : PROBE_TIMEOUT_MS

  /** @type {any[]} */
  const allProjects = Array.isArray(options.projects) ? options.projects : []
  const feishuProjects = allProjects
    .filter((project) => String(project?.match?.platform ?? '') === 'feishu')
    .map((project) => ({ name: String(project?.name ?? '(未命名)'), match: project?.match ?? {} }))

  if (feishuProjects.length === 0) {
    return {
      skipped: true,
      skipReason: '没有平台为 feishu 的项目，跳过飞书连通性检查',
      token: { ok: false, message: '没查（没有飞书项目）' },
      projects: [],
    }
  }
  if (!appId || !appSecret) {
    return {
      skipped: false,
      token: {
        ok: false,
        message: `凭据 ${!appId ? 'FEISHU_APP_ID' : 'FEISHU_APP_SECRET'} 没配，连不上飞书`,
        fix: '在设置页「凭据」页签填上飞书应用的 App ID 与 App Secret（开放平台 →「凭证与基础信息」）。',
      },
      projects: feishuProjects.map((project) => ({
        name: project.name,
        kind: 'unknown',
        table: '',
        metadata: { ok: false, message: '认证没通过，没法往下查' },
        records: { ok: false, message: '认证没通过，没法往下查' },
      })),
    }
  }

  // ── 1. 认证 ────────────────────────────────────────────────
  /** @type {{ ok: boolean, message: string, fix?: string, code?: number }} */
  let token = { ok: false, message: '没查' }
  let accessToken = ''
  try {
    const data = await feishuCall({
      fetchImpl,
      path: AUTH_PATH,
      init: { method: 'POST', body: { app_id: appId, app_secret: appSecret } },
      timeoutMs,
    })
    accessToken = String(data?.tenant_access_token ?? '')
    token = accessToken.length > 0
      ? { ok: true, message: '能换到 tenant_access_token（App ID / App Secret 是对的）' }
      : { ok: false, message: '飞书认证接口没返回 tenant_access_token' }
  } catch (error) {
    token = { ok: false, ...describeProbeFailure(error) }
  }

  if (!token.ok) {
    // 认证不过，后面每项都注定失败 —— 不再逐个发请求。
    return {
      skipped: false,
      token,
      projects: feishuProjects.map((project) => ({
        name: project.name,
        kind: 'unknown',
        table: '',
        metadata: { ok: false, message: '认证没通过，没法往下查' },
        records: { ok: false, message: '认证没通过，没法往下查' },
      })),
    }
  }

  // ── 2. 每个飞书项目各查一遍 ────────────────────────────────
  /** @type {any[]} */
  const projects = []
  for (const project of feishuProjects) {
    const result = await probeOneProject({
      appId,
      appSecret,
      accessToken,
      projectName: project.name,
      match: project.match,
      fetchImpl,
      timeoutMs,
    })
    // 每一步都要带上 token：这里不重取，一次体检只换一次 token。
    projects.push(result)
  }
  // 内部第一层用的是 `token` 字段名，与这里的认证结果同名，换成 `accessToken` 表述更清楚。
  return { skipped: false, token, projects }
}
