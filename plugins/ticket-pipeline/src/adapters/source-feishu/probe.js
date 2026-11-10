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

const FEISHU_API_BASE = 'https://open.feishu.cn'
const AUTH_PATH = '/open-apis/auth/v3/tenant_access_token/internal'

/** 体检里每个网络请求的超时（毫秒）。10 秒：够慢网出结果，又不至于让体检拖成分钟级。 */
export const PROBE_TIMEOUT_MS = 10_000

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

  // 表型判定：先看显式配的是哪一种。两者都空说明这个项目根本没配表 ——
  // 那不用发任何请求，直接告诉人「项目没绑表」。
  /** @type {'bitable' | 'sheet' | 'unknown'} */
  let kind = 'unknown'
  if (spreadsheetToken.length > 0) kind = 'sheet'
  else if (appToken.length > 0) kind = 'bitable'

  const base = {
    name: input.projectName,
    kind,
    table: kind === 'sheet'
      ? spreadsheetToken
      : appToken.length > 0
        ? (tableId.length > 0 ? `${appToken}/${tableId}` : appToken)
        : '',
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

  // ── 表元数据 ──────────────────────────────────────────────
  let resolvedTableId = tableId
  let resolvedSheetId = String(match.sheetId ?? '').trim()
  const resolvedSheetName = String(match.sheetName ?? '').trim()
  try {
    if (kind === 'sheet') {
      // 表型是电子表格：能列出它的 sheet 就算元数据通。
      const data = await call(`/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(base.table)}/sheets/query`, {})
      const sheets = Array.isArray(data?.sheets) ? data.sheets : []
      base.metadata = { ok: true, message: `能读到电子表格元数据（${sheets.length} 个工作表）` }
      if (resolvedSheetId.length === 0) {
        // 没指定 sheet 时挑第一个：体检只需要「能不能读到数据」，不需要挑对表。
        const first = sheets[0]
        if (first?.sheet_id) resolvedSheetId = String(first.sheet_id)
        else if (first?.title) resolvedSheetId = String(first.title)
      }
    } else {
      const data = await call(`/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`, { query: { page_size: 100 } })
      const tables = Array.isArray(data?.items) ? data.items : []
      base.metadata = { ok: true, message: `能读到多维表格元数据（${tables.length} 张数据表）` }
      if (resolvedTableId.length === 0 && tables.length > 0) {
        // 没写 tableId 时配置层靠 docNamePattern 猜；体检没有那个上下文，
        // 就退一步用第一张表 —— 只为了验证「能不能读数据」，不承诺挑对表。
        const first = tables[0]
        if (first?.table_id) resolvedTableId = String(first.table_id)
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
      const range = `${anchor}!A1:Z2`
      const data = await call(
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(base.table)}/values/${encodeURIComponent(range)}`,
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
    } else {
      if (resolvedTableId.length === 0) {
        base.records = { ok: false, message: '配置里没写 tableId，也没能自动猜出是哪张数据表' }
        return base
      }
      const data = await call(
        `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(resolvedTableId)}/records/search`,
        { method: 'POST', body: { page_size: 1, automatic_fields: true } },
      )
      const items = Array.isArray(data?.items) ? data.items : []
      base.records = {
        ok: true,
        message: items.length > 0
          ? `能读到第一页数据（这张表里有记录）`
          : '表是空的（能连上，但一条记录都没有 —— 先确认填的是不是同一张表）',
      }
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
