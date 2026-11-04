/**
 * `source-feishu` —— 飞书多维表格工单源（真实实现，地图票 #12）。
 *
 * 它做四件事，其余全在别处：
 * 1. **认证**：用 `app_id` + `app_secret` 换 `tenant_access_token`，过期前自动刷新。
 * 2. **扫描**：`records/search` 按「最后更新时间」降序翻页，客户端比水位 + 内容指纹。
 * 3. **取字节**：截图三种形态（附件 / 本地路径 / http 链接）都归一成 `Uint8Array`。
 * 4. **绑定表**：`appToken` + `tableId` 直接给，或用 `docNamePattern` 猜（猜不准就报错）。
 *
 * 硬约束（用户 2026-11-03 拍板）：
 * - **绝不写回表格**。本文件里没有任何 PUT / POST 到记录接口的调用。
 * - **只认 `是否处理 = 处理中`** 的行进入流水线；不叠加任何别的条件。
 * - 表格是触发器，流水线状态只存在插件自己的存储里。
 *
 * 实现依据全部在票 #01 的 Resolution 里定死，摘要：
 * - 身份用 `record_id`（不用「序号」列 —— 人手填，会因插删行重排）。
 * - 停止条件是**连续 `safePageRun` 条已知且未变**，不是「见到第一条 ≤ 水位就停」——
 *   `last_modified_time` 会因批量操作 / 导入乱序，单点水位会漏票。
 * - `ExactDate` 过滤不能用（会被截断到天）。
 * - 删行要连续 `goneAfterScans` 轮没出现才算。
 * - 指纹只含工单内容（问题描述 / 模块 / 操作流程 / 截图 / 优先级 / 发现部门），
 *   不含 `是否处理` 等管理字段 —— 否则人改一次处理人就触发一次修订。
 */

import { PipelineError } from '../../contracts/errors.js'
import { assertTicketSource, makeTicket } from '../../contracts/ticket-source.js'
import { IMAGE_MEDIA_TYPES } from '../../contracts/types.js'

const FEISHU_API_BASE = 'https://open.feishu.cn'
const AUTH_PATH = '/open-apis/auth/v3/tenant_access_token/internal'

/** `records/search` 单页上限（飞书文档写死 500）。 */
const RECORD_PAGE_SIZE = 500

/** 凭据引用名（`ctx.credentials` 的 ref 名）。 */
const DEFAULT_APP_ID_REF = 'FEISHU_APP_ID'
const DEFAULT_APP_SECRET_REF = 'FEISHU_APP_SECRET'

/**
 * 工单表的列名。
 *
 * 为什么要显式写死：多维表格的字段名是**表级**的约定，不是飞书的通用概念。
 * 换一张表如果列名不同，改这里的常量即可 —— 不用动内核。
 * 这张表的结构来自用户贴出的《PMS系统问题Bug记录表》使用说明（12 列）。
 */
export const FEISHU_COLUMNS = Object.freeze({
  seq: '序号',
  department: '发现部门',
  description: '问题描述',
  foundAt: '发现日期',
  module: '模块',
  flow: '操作流程',
  screenshot: '截图',
  priority: '优先级',
  status: '是否处理',
  handler: '处理人',
  result: '处理结果',
  handledAt: '处理日期',
  lastModified: '最后更新时间',
})

/** 收票只看这一列的这一值。 */
export const IN_PROGRESS_VALUE = '处理中'

/** 优先级字面量 → 内部权重档位。 */
const PRIORITY_MAP = new Map([
  ['高', 'high'], ['高优先级', 'high'], ['紧急', 'high'], ['urgent', 'high'], ['critical', 'high'], ['p0', 'high'], ['p1', 'high'],
  ['中', 'medium'], ['中优先级', 'medium'], ['一般', 'medium'], ['普通', 'medium'], ['medium', 'medium'], ['p2', 'medium'],
  ['低', 'low'], ['低优先级', 'low'], ['minor', 'low'], ['low', 'low'], ['p3', 'low'],
])

/** 飞书错误码 → 我们的错误分类。 */
const AUTH_ERROR_CODES = new Set([99991663, 99991664, 99991665, 99991668, 99991672, 1254301])
const NOT_FOUND_ERROR_CODES = new Set([1254043, 1254045, 1254290])
const INVALID_INPUT_ERROR_CODES = new Set([1254005, 1254006, 1254007])
const RATE_LIMIT_ERROR_CODES = new Set([99991400, 99991403])

/**
 * 把飞书单元格的值归一成字符串。
 *
 * 为什么必须规范化：多维表格的单元格形状**不稳定** —— 文本字段可能是
 * 裸字符串、`{ text }`、或 `[{ text }]`；人自己填的列可能是数组。
 * 不先规范化就没法判等（「是否处理 = 处理中」会判不中）。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeCellText (value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value.map((item) => normalizeCellText(item)).filter(Boolean).join(' ')
  }
  if (typeof value === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value)
    if ('text' in obj) return normalizeCellText(obj.text)
    if ('name' in obj) return normalizeCellText(obj.name)
    if ('value' in obj) return normalizeCellText(obj.value)
    if ('link' in obj) return normalizeCellText(obj.link)
  }
  return ''
}

/**
 * 单元格是日期时通常返回毫秒时间戳；统一成 `YYYY-MM-DD` 便于人读。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeDateCell (value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e11 ? value : value * 1000
    const date = new Date(ms)
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10)
    return ''
  }
  return normalizeCellText(value)
}

/**
 * 从「截图」列里抽出截图引用。
 *
 * 三个形态（票 #01 定死）：
 * - `attachment{fileToken,name,size?}`：单元格里粘的图片附件。
 * - `path{path}`：人填的共享路径（`D:\...` 或 `\\host\share\...`）。
 * - `url{url}`：人填的 http(s) 链接。
 * - `unknown{raw}`：认不出来 —— 内核会标 needs-info 让人补图。
 *
 * @param {unknown} cell
 * @returns {import('../../contracts/types.js').ScreenshotRef[]}
 */
export function extractScreenshots (cell) {
  /** @type {import('../../contracts/types.js').ScreenshotRef[]} */
  const refs = []
  if (cell === null || cell === undefined || cell === '') return refs

  const push = (item) => {
    if (item === null || item === undefined || item === '') return
    if (typeof item === 'string') {
      const text = item.trim()
      if (!text) return
      if (/^https?:\/\//i.test(text)) {
        refs.push({ kind: 'url', url: text })
      } else if (/[\\/]/.test(text)) {
        refs.push({ kind: 'path', path: text })
      } else {
        refs.push({ kind: 'unknown', raw: text })
      }
      return
    }
    if (typeof item === 'object') {
      const obj = /** @type {Record<string, any>} */ (item)
      const fileToken = obj.file_token ?? obj.fileToken ?? obj.token
      if (typeof fileToken === 'string' && fileToken) {
        /** @type {import('../../contracts/types.js').ScreenshotRef} */
        const ref = { kind: 'attachment', fileToken }
        if (typeof obj.name === 'string' && obj.name) ref.name = obj.name
        if (typeof obj.size === 'number' && Number.isFinite(obj.size)) ref.size = obj.size
        refs.push(ref)
        return
      }
      if (typeof obj.url === 'string' && obj.url) {
        push(obj.url)
        return
      }
      if (typeof obj.text === 'string' && obj.text) {
        push(obj.text)
        return
      }
      const raw = JSON.stringify(obj)
      refs.push({ kind: 'unknown', raw })
    }
  }

  if (Array.isArray(cell)) {
    for (const item of cell) push(item)
  } else {
    push(cell)
  }
  return refs
}

/**
 * 从文件名或 content-type 猜图片类型。
 * @param {string | undefined} contentType
 * @param {string | undefined} name
 * @returns {string | undefined}
 */
function pickMediaType (contentType, name) {
  const ct = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  if (IMAGE_MEDIA_TYPES.includes(ct)) return ct
  const lower = String(name ?? '').toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return undefined
}

/**
 * @param {unknown} value
 * @returns {number} 0 表示拿不到
 */
function toMillis (value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e11 ? value : value * 1000
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

/**
 * 造一个飞书工单源（每个项目一个实例）。
 *
 * @param {Object} [options]
 * @param {string} [options.projectId] 所属项目名
 * @param {string} [options.appToken] 多维表格的 app_token
 * @param {string} [options.tableId] 数据表 table_id
 * @param {string} [options.viewId] 指定视图（可选）
 * @param {string} [options.docNamePattern] 文件名模糊匹配（兜底绑定）
 * @param {(ref: string) => Promise<string | { value?: string } | undefined>} [options.getSecret] 从 `ctx.credentials` 取值
 * @param {typeof fetch} [options.fetch]
 * @param {(sourceId: string) => Promise<any>} [options.getWatermark] 读水位
 * @param {(sourceId: string, value: any) => Promise<void>} [options.saveWatermark] 写水位
 * @param {(path: string, signal?: AbortSignal) => Promise<{ data: Uint8Array, name?: string }>} [options.readLocalFile] 读本地文件（路径形态截图用）
 * @param {number} [options.safePageRun] 连续多少条已知未变就停（默认 20）
 * @param {number} [options.goneAfterScans] 连续多少轮没出现就退役（默认 3）
 * @param {() => number} [options.now]
 * @param {string} [options.appIdRef]
 * @param {string} [options.appSecretRef]
 * @returns {import('../../contracts/ticket-source.js').TicketSource & { projectId: string }}
 */
export function createFeishuSource (options = {}) {
  const projectId = typeof options.projectId === 'string' && options.projectId.length > 0 ? options.projectId : ''
  const appToken = String(options.appToken ?? '')
  const tableId = String(options.tableId ?? '')
  const viewId = String(options.viewId ?? '')
  const docNamePattern = String(options.docNamePattern ?? '')
  const getSecret = typeof options.getSecret === 'function' ? options.getSecret : null
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch
  const getWatermark = typeof options.getWatermark === 'function' ? options.getWatermark : null
  const saveWatermark = typeof options.saveWatermark === 'function' ? options.saveWatermark : null
  const readLocalFile = typeof options.readLocalFile === 'function' ? options.readLocalFile : null
  const appIdRef = String(options.appIdRef ?? DEFAULT_APP_ID_REF)
  const appSecretRef = String(options.appSecretRef ?? DEFAULT_APP_SECRET_REF)
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const safePageRunLimit = Math.max(5, Math.min(100, Number(options.safePageRun ?? 20) || 20))
  const goneAfterScans = Math.max(1, Math.min(20, Number(options.goneAfterScans ?? 3) || 3))

  const sourceId = `feishu:${projectId || 'unnamed'}`

  if (typeof fetchImpl !== 'function') {
    throw new PipelineError('internal', '飞书适配器需要一个 fetch 实现')
  }

  /** @type {{ token: string, expiresAt: number } | null} */
  let tokenCache = null
  /** @type {{ appToken: string, tableId: string } | null} */
  let tableCache = null

  /**
   * 读一个凭据。
   * @param {string} ref
   * @returns {Promise<string>}
   */
  async function readSecret (ref) {
    if (!getSecret) {
      throw new PipelineError('auth', `没有接入凭据服务，读不到 ${ref}`)
    }
    let hit
    try {
      hit = await getSecret(ref)
    } catch (error) {
      throw new PipelineError('auth', `读取凭据 ${ref} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const value = typeof hit === 'string' ? hit : (hit && typeof hit === 'object' ? (/** @type {any} */ (hit)).value : undefined)
    if (!value) {
      throw new PipelineError('auth', `凭据 ${ref} 未配置。请在 DSH 的凭据服务里写入它。`)
    }
    return String(value)
  }

  /**
   * 拿 `tenant_access_token`，过期前 60 秒自动刷新。
   * @returns {Promise<string>}
   */
  async function getToken () {
    if (tokenCache && now() < tokenCache.expiresAt - 60_000) return tokenCache.token

    const appId = await readSecret(appIdRef)
    const appSecret = await readSecret(appSecretRef)

    const data = await apiCall(AUTH_PATH, {
      method: 'POST',
      body: { app_id: appId, app_secret: appSecret },
      auth: false,
    })

    const token = String(data.tenant_access_token ?? '')
    if (!token) {
      throw new PipelineError('auth', '飞书认证接口没有返回 tenant_access_token')
    }
    const expire = Number(data.expire ?? 7200)
    tokenCache = { token, expiresAt: now() + Math.max(60, expire) * 1000 }
    return token
  }

  /**
   * 把飞书错误码翻成我们的错误分类。
   * @param {number} code
   * @param {string} msg
   * @returns {PipelineError}
   */
  function mapApiError (code, msg) {
    if (RATE_LIMIT_ERROR_CODES.has(code)) {
      return new PipelineError('rate-limit', `飞书接口限流：${msg}`, undefined, 5000)
    }
    if (AUTH_ERROR_CODES.has(code)) {
      return new PipelineError('auth', `飞书凭据或权限无效：${msg}`)
    }
    if (NOT_FOUND_ERROR_CODES.has(code)) {
      return new PipelineError('not-found', `找不到对象或没有权限：${msg}`)
    }
    if (INVALID_INPUT_ERROR_CODES.has(code)) {
      return new PipelineError('invalid-input', `飞书参数错误：${msg}`)
    }
    return new PipelineError('internal', `飞书接口报错 ${code}：${msg}`)
  }

  /**
   * 调一次飞书 REST 接口，返回**整个响应体**。
   *
   * 为什么返回整个而不是 `data`：认证接口（`tenant_access_token`）的响应体
   * 没有 `data` 这层包装 —— `tenant_access_token` 就在顶层。其它接口的
   * 业务数据在 `data` 里，调用方自己取 `payload.data`。
   *
   * @param {string} path
   * @param {{ method?: string, body?: unknown, query?: Record<string, string | number | undefined>, auth?: boolean, signal?: AbortSignal }} [init]
   * @returns {Promise<any>}
   */
  async function apiCall (path, init = {}) {
    const url = new URL(FEISHU_API_BASE + path)
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    }
    const headers = { 'Content-Type': 'application/json; charset=utf-8' }
    if (init.auth !== false) {
      headers.Authorization = `Bearer ${await getToken()}`
    }

    let response
    try {
      response = await fetchImpl(url.toString(), {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal,
      })
    } catch (error) {
      if (error instanceof PipelineError) throw error
      throw new PipelineError('network', `调用飞书接口失败：${error instanceof Error ? error.message : String(error)}`)
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new PipelineError('auth', `飞书接口拒绝访问（HTTP ${response.status}）`)
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers?.get?.('retry-after') ?? 5)
        throw new PipelineError('rate-limit', `飞书接口限流（HTTP 429）`, undefined, Math.max(1000, retryAfter * 1000))
      }
      throw new PipelineError('internal', `飞书接口返回 HTTP ${response.status}`)
    }

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      throw new PipelineError('internal', `飞书接口返回的不是 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
    const code = Number(payload?.code ?? 0)
    if (code !== 0) {
      throw mapApiError(code, String(payload?.msg ?? '未知错误'))
    }
    return payload ?? {}
  }

  /**
   * 下载二进制（附件形态的截图）。
   * @param {string} path
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ bytes: Uint8Array, contentType?: string }>}
   */
  async function apiDownload (path, signal) {
    const url = new URL(FEISHU_API_BASE + path)
    let response
    try {
      response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${await getToken()}` },
        signal,
      })
    } catch (error) {
      throw new PipelineError('network', `下载飞书附件失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new PipelineError('auth', `下载飞书附件被拒（HTTP ${response.status}）`)
      }
      if (response.status === 404) {
        throw new PipelineError('not-found', '飞书附件不存在或已被删除')
      }
      if (response.status === 429) {
        throw new PipelineError('rate-limit', '飞书附件下载限流', undefined, 5000)
      }
      throw new PipelineError('internal', `下载飞书附件返回 HTTP ${response.status}`)
    }
    const buffer = await response.arrayBuffer()
    return {
      bytes: new Uint8Array(buffer),
      contentType: response.headers?.get?.('content-type') ?? undefined,
    }
  }

  /**
   * 文件名匹配：`docNamePattern` 当正则用，不合法就退回「包含」。
   * @param {string} name
   * @param {string} pattern
   * @returns {boolean}
   */
  function matchesPattern (name, pattern) {
    if (!pattern) return true
    try {
      return new RegExp(pattern, 'i').test(name)
    } catch {
      return name.toLowerCase().includes(pattern.toLowerCase())
    }
  }

  /**
   * 在云文档里按名字找多维表格。
   * @param {string} pattern
   * @returns {Promise<Array<{ token: string, name: string }>>}
   */
  async function searchBitableDocs (pattern) {
    /** @type {Array<{ token: string, name: string }>} */
    const hits = []
    let pageToken = ''
    for (let guard = 0; guard < 20; guard += 1) {
      const payload = await apiCall('/open-apis/drive/v1/files', {
        query: { page_size: 200, page_token: pageToken },
      })
      const data = payload?.data ?? {}
      const files = Array.isArray(data.files) ? data.files : []
      for (const file of files) {
        const type = String(file?.type ?? '')
        const name = String(file?.name ?? '')
        if (type !== 'bitable') continue
        if (!matchesPattern(name, pattern)) continue
        hits.push({ token: String(file?.token ?? ''), name })
      }
      if (!data.has_more || !data.page_token) break
      pageToken = String(data.page_token)
    }
    return hits.filter((hit) => hit.token)
  }

  /**
   * 定位到底用哪张表。
   *
   * 三条路：
   * 1. `appToken` + `tableId` 都给了 —— 直接用。
   * 2. 有 `appToken` 没 `tableId` —— 在这个多维表格的表清单里按 `docNamePattern` 找。
   * 3. 只有 `docNamePattern` —— 先在云文档里找到唯一一张多维表格，再取它唯一的表。
   *
   * 任何一步命中 0 张或 >1 张都当**配置错误**（不瞎猜）：宁可报错让人改配置，
   * 也不要扫错表把别人的表当工单表。
   *
   * @returns {Promise<{ appToken: string, tableId: string }>}
   */
  async function resolveTable () {
    if (tableCache) return tableCache

    if (appToken && tableId) {
      tableCache = { appToken, tableId }
      return tableCache
    }

    if (appToken) {
      const payload = await apiCall(`/open-apis/bitable/v1/apps/${appToken}/tables`, { query: { page_size: 100 } })
      const items = Array.isArray(payload?.data?.items) ? payload.data.items : []
      const matched = docNamePattern
        ? items.filter((item) => matchesPattern(String(item?.name ?? ''), docNamePattern))
        : items
      if (matched.length !== 1) {
        throw new PipelineError(
          'invalid-input',
          `多维表格 ${appToken} 里按 "${docNamePattern || '（未指定表名）'}" 匹配到 ${matched.length} 张表，需要恰好 1 张。`
            + `现有表：${items.map((item) => String(item?.name ?? '?')).join('、') || '（空）'}`,
        )
      }
      tableCache = { appToken, tableId: String(matched[0].table_id) }
      return tableCache
    }

    if (!docNamePattern) {
      throw new PipelineError('invalid-input', '飞书项目既没给 appToken/tableId，也没给 docNamePattern，无法定位工单表')
    }

    const docs = await searchBitableDocs(docNamePattern)
    if (docs.length !== 1) {
      throw new PipelineError(
        'invalid-input',
        `按 "${docNamePattern}" 匹配到 ${docs.length} 张多维表格，需要恰好 1 张。`
          + `候选：${docs.map((doc) => doc.name).join('、') || '（无）'}`,
      )
    }
    const doc = docs[0]
    const payload = await apiCall(`/open-apis/bitable/v1/apps/${doc.token}/tables`, { query: { page_size: 100 } })
    const items = Array.isArray(payload?.data?.items) ? payload.data.items : []
    if (items.length !== 1) {
      throw new PipelineError(
        'invalid-input',
        `多维表格「${doc.name}」里有 ${items.length} 张数据表，需要恰好 1 张。`
          + `现有表：${items.map((item) => String(item?.name ?? '?')).join('、') || '（空）'}`,
      )
    }
    tableCache = { appToken: doc.token, tableId: String(items[0].table_id) }
    return tableCache
  }

  /**
   * 把一行记录组装成内部 Ticket。
   * @param {any} item
   * @param {string} recordId
   * @returns {import('../../contracts/types.js').Ticket}
   */
  function buildTicket (item, recordId) {
    const fields = item?.fields ?? {}
    const priorityText = normalizeCellText(fields[FEISHU_COLUMNS.priority]).toLowerCase()
    const priority = PRIORITY_MAP.get(priorityText)
    return makeTicket({
      recordId,
      projectId,
      description: normalizeCellText(fields[FEISHU_COLUMNS.description]),
      module: normalizeCellText(fields[FEISHU_COLUMNS.module]),
      flow: normalizeCellText(fields[FEISHU_COLUMNS.flow]),
      priority: priority === 'high' || priority === 'medium' || priority === 'low' ? priority : undefined,
      department: normalizeCellText(fields[FEISHU_COLUMNS.department]),
      foundAt: normalizeDateCell(fields[FEISHU_COLUMNS.foundAt]),
      seq: normalizeCellText(fields[FEISHU_COLUMNS.seq]),
      status: normalizeCellText(fields[FEISHU_COLUMNS.status]),
      screenshots: extractScreenshots(fields[FEISHU_COLUMNS.screenshot]),
      raw: { recordId, mtime: pickMtime(item) },
    })
  }

  /**
   * 取这一行的最后修改时间（毫秒）。取不到就返回 0 —— 宁可当作「变了」也不漏票。
   * @param {any} item
   * @returns {number}
   */
  function pickMtime (item) {
    const fields = item?.fields ?? {}
    const candidates = [
      fields[FEISHU_COLUMNS.lastModified],
      item?.last_modified_time,
      item?.lastModifiedTime,
    ]
    for (const candidate of candidates) {
      const ms = toMillis(candidate)
      if (ms > 0) return ms
    }
    return 0
  }

  /**
   * 扫一轮飞书工单表。
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<import('../../contracts/ticket-source.js').ScanResult>}
   */
  async function scan (signal) {
    if (signal?.aborted) throw new PipelineError('aborted', '扫描被取消')

    const table = await resolveTable()
    const watermark = (await getWatermark?.(sourceId)) ?? {}
    /** @type {Record<string, { mtime: number, fingerprint: string, missingScans: number, tracked?: boolean }>} */
    const seen = { ...(watermark.seen ?? {}) }

    /** @type {import('../../contracts/types.js').Ticket[]} */
    const created = []
    /** @type {import('../../contracts/types.js').Ticket[]} */
    const updated = []
    /** @type {string[]} */
    const disappeared = []
    /** @type {Set<string>} */
    const live = new Set()

    let safePageRun = 0
    let pageToken = ''
    let stopped = false

    for (let guard = 0; guard < 200 && !stopped; guard += 1) {
      if (signal?.aborted) throw new PipelineError('aborted', '扫描被取消')

      /** @type {Record<string, unknown>} */
      const body = {
        page_size: RECORD_PAGE_SIZE,
        automatic_fields: true,
        sort: [{ field_name: FEISHU_COLUMNS.lastModified, desc: true }],
      }
      if (viewId) body.view_id = viewId
      if (pageToken) body.page_token = pageToken

      /** @type {any} */
      let payload
      try {
        payload = await apiCall(
          `/open-apis/bitable/v1/apps/${table.appToken}/tables/${table.tableId}/records/search`,
          { method: 'POST', body, signal },
        )
      } catch (error) {
        // 有些表不允许按自动字段排序。去掉 sort 重试一次，宁可多翻几页也别整轮失败。
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof PipelineError && error.kind === 'invalid-input' && /sort/i.test(message)) {
          delete body.sort
          payload = await apiCall(
            `/open-apis/bitable/v1/apps/${table.appToken}/tables/${table.tableId}/records/search`,
            { method: 'POST', body, signal },
          )
        } else {
          throw error
        }
      }

      const data = payload?.data ?? {}
      const items = Array.isArray(data.items) ? data.items : []
      for (const item of items) {
        const recordId = String(item?.record_id ?? '')
        if (!recordId) continue
        live.add(recordId)

        const fields = item?.fields ?? {}
        const status = normalizeCellText(fields[FEISHU_COLUMNS.status])
        const inProgress = status === IN_PROGRESS_VALUE
        const mtime = pickMtime(item)
        const ticket = buildTicket(item, recordId)
        const prev = seen[recordId]

        if (!prev) {
          // 第一次看见。管理字段是「否 / 是」的行也记进水位（但不跟踪），
          // 免得下一轮它变成「处理中」时又被当成新票。
          seen[recordId] = { mtime, fingerprint: ticket.fingerprint, missingScans: 0, tracked: inProgress }
          safePageRun = 0
          if (inProgress) created.push(ticket)
          continue
        }

        prev.missingScans = 0

        // 变更判定用**内容指纹**，不用 mtime：批量导入 / 跨时区写入会让 mtime 乱序，
        // 只看 mtime 会漏掉「内容变了但时间戳反而更早」的行。
        const contentChanged = ticket.fingerprint !== prev.fingerprint
        if (contentChanged) prev.fingerprint = ticket.fingerprint
        if (mtime > prev.mtime) prev.mtime = mtime

        if (mtime === prev.mtime) safePageRun += 1
        else safePageRun = 0

        if (!inProgress) {
          // 「否」= 待认领，「是」= 已闭环 —— 都不进流水线。
          // 之前跟踪过的就退役（内核把它标成 gone）。
          if (prev.tracked) {
            prev.tracked = false
            if (!disappeared.includes(recordId)) disappeared.push(recordId)
          }
          continue
        }

        if (!prev.tracked) {
          // 人把「是否处理」从「否 / 是」拨回「处理中」= 手动重置，要重新处理。
          prev.tracked = true
          created.push(ticket)
          continue
        }

        if (contentChanged) updated.push(ticket)

        if (safePageRun >= safePageRunLimit) {
          stopped = true
          break
        }
      }

      if (stopped) break
      if (!data.has_more || !data.page_token) break
      pageToken = String(data.page_token)
    }

    // 没出现在这一轮里的行：连续 goneAfterScans 轮才算删了。
    for (const [recordId, state] of Object.entries(seen)) {
      if (live.has(recordId)) continue
      state.missingScans = (state.missingScans ?? 0) + 1
      if (state.missingScans >= goneAfterScans) {
        if (!disappeared.includes(recordId)) disappeared.push(recordId)
        delete seen[recordId]
      }
    }

    await saveWatermark?.(sourceId, { seen, lastScanAt: now() })

    return { created, updated, disappeared }
  }

  /**
   * 取截图字节。三种形态都归一成 `Uint8Array` + 图片类型。
   *
   * @param {import('../../contracts/types.js').ScreenshotRef} ref
   * @param {AbortSignal} [signal]
   * @returns {Promise<import('../../contracts/ticket-source.js').LoadedScreenshot>}
   */
  async function loadScreenshot (ref, signal) {
    if (signal?.aborted) throw new PipelineError('aborted', '取图被取消')
    if (!ref || typeof ref !== 'object') {
      throw new PipelineError('invalid-input', '截图引用不是对象')
    }

    if (ref.kind === 'attachment') {
      const fileToken = String(ref.fileToken ?? '')
      if (!fileToken) throw new PipelineError('invalid-input', '附件引用缺 fileToken')
      const { bytes, contentType } = await apiDownload(`/open-apis/drive/v1/medias/${fileToken}/download`, signal)
      const mediaType = pickMediaType(contentType, ref.name)
      if (!mediaType) {
        throw new PipelineError('invalid-input', `附件 ${fileToken} 不是受支持的图片类型（${contentType ?? '未知'}）`)
      }
      return { data: bytes, mediaType, name: ref.name ?? `${fileToken}.png` }
    }

    if (ref.kind === 'path') {
      if (!readLocalFile) {
        throw new PipelineError('not-found', '本机没接入文件读取，路径形态的截图取不到')
      }
      const loaded = await readLocalFile(ref.path, signal)
      const mediaType = pickMediaType(loaded.mediaType, loaded.name ?? ref.path)
      if (!mediaType) {
        throw new PipelineError('invalid-input', `路径 ${ref.path} 指向的不是受支持的图片类型`)
      }
      return { data: loaded.data, mediaType, name: loaded.name ?? ref.path }
    }

    if (ref.kind === 'url') {
      let response
      try {
        response = await fetchImpl(ref.url, { signal })
      } catch (error) {
        throw new PipelineError('network', `下载截图链接失败：${error instanceof Error ? error.message : String(error)}`)
      }
      if (!response.ok) {
        throw new PipelineError('not-found', `截图链接返回 HTTP ${response.status}`)
      }
      const buffer = await response.arrayBuffer()
      const mediaType = pickMediaType(response.headers?.get?.('content-type'), ref.url)
      if (!mediaType) {
        throw new PipelineError('invalid-input', `链接 ${ref.url} 不是受支持的图片类型`)
      }
      return { data: new Uint8Array(buffer), mediaType, name: ref.url }
    }

    throw new PipelineError('invalid-input', '认不出这张截图的形态，需要人补图')
  }

  return assertTicketSource({
    id: sourceId,
    projectId,
    scan,
    loadScreenshot,
  })
}

/**
 * 从项目条目的 `match` 里摘出本适配器用得到的值。
 * @param {any} match 项目条目的 `match` 字段
 * @returns {{ appToken: string, tableId: string, viewId: string, docNamePattern: string }}
 */
export function feishuOptionsFromMatch (match) {
  const m = match ?? {}
  return {
    appToken: String(m.appToken ?? ''),
    tableId: String(m.tableId ?? ''),
    viewId: String(m.viewId ?? ''),
    docNamePattern: String(m.docNamePattern ?? ''),
  }
}
