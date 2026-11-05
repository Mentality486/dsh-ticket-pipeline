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
import { createRecordFilter, resolveRecordIds } from '../../contracts/record-filter.js'
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

/** 收票只看这一列的这一值（缺省值，可被 options.statusValues 覆盖）。 */
export const IN_PROGRESS_VALUE = '处理中'

/**
 * 把「哪些状态值算在处理中」归一成字符串数组。
 *
 * 形态有三种，都得认：
 * - 不给 / 给空 → 退回 IN_PROGRESS_VALUE（保持既有行为）；
 * - 给一个字符串 → 当成单值集合（人写 statusValue: '否' 这种直觉写法别报错）；
 * - 给数组 → 取每个非空字符串，**去重**（同一个值写两遍不算两个状态）。
 *
 * 空串永远不算状态：表里状态列为空的行不是「处理中」，否则会把整张空表收成满屏票。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function resolveStatusValues (value) {
  if (value === undefined || value === null || value === '') return [IN_PROGRESS_VALUE]
  const list = Array.isArray(value) ? value : [value]
  /** @type {string[]} */
  const out = []
  for (const item of list) {
    if (item === undefined || item === null) continue
    const text = String(item).trim()
    if (text.length === 0) continue
    if (!out.includes(text)) out.push(text)
  }
  return out.length > 0 ? out : [IN_PROGRESS_VALUE]
}

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
 * @param {string[]|string} [options.recordIds] 只处理这几条工单（收窄开关；不给 = 整张表）
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
  // 「这一行算不算待处理的工单」由状态列的取值决定，而这个取值**每张表不一样**：
  // 常见有「处理中」「否」「待处理」「未处理」……写死一个值，配置写得再对也一张票都收不到。
  // 这里接受一组值（命中任意一个即算「在处理中」），缺省仍是老的那一个，保持既有行为。
  const statusValues = resolveStatusValues(options.statusValues)
  // 收窄开关：新接一个平台时先挑一单试点，不必一次吃掉整张表。
  // 名单外的行整行跳过（不收票、不算这轮还在、也不累加「连续没出现」），
  // 免得把没打算动的旧票误判成已删除。语义见 contracts/record-filter.js。
  const recordFilter = createRecordFilter(options.recordIds, '飞书工单源 recordIds')
  const getSecret = typeof options.getSecret === 'function' ? options.getSecret : null
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch
  const getWatermark = typeof options.getWatermark === 'function' ? options.getWatermark : null
  const saveWatermark = typeof options.saveWatermark === 'function' ? options.saveWatermark : null
  const readLocalFile = typeof options.readLocalFile === 'function' ? options.readLocalFile : null
  const appIdRef = String(options.appIdRef ?? DEFAULT_APP_ID_REF)
  const appSecretRef = String(options.appSecretRef ?? DEFAULT_APP_SECRET_REF)
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  // B21：以前这里用 Math.max(5, ...) 把 safePageRun 往上钳到 5，配置里写 2 会被悄悄改成 5。
  // 配置层（core/config.js）已经有 min 校验，这里再钳一次只会让「配置写多少、实际跑多少」
  // 对不上，出问题很难查。改成直接用配置值，并在底下 log 一次实际生效值。
  const safePageRunLimit = Number(options.safePageRun ?? 20)
  const goneAfterScans = Math.max(1, Math.min(20, Number(options.goneAfterScans ?? 3) || 3))

  // 请求级超时（B8）。默认 15 秒：飞书接口的正常响应在毫秒级，15 秒足够宽松，
  // 又不至于让一个卡死的连接把整轮扫描拖到天荒地老。
  const requestTimeoutMs = Math.max(1000, Number(options.requestTimeoutMs ?? 15_000) || 15_000)
  // 截图 url 形态的总超时（C-B6）。比普通请求短：人贴的外链随时可能挂，
  // 10 秒够 CDN 出图，超了就当这张图取不到，转 needs-info 让人补附件。
  const imageTimeoutMs = Math.max(1000, Number(options.imageTimeoutMs ?? 10_000) || 10_000)
  // 二进制上限 10MB（C-B6 / C-B7）。截图是给人看的问题现场，合理的 PNG 远小于这个数；
  // 加上限是为了不让一个超大文件或者恶意的无限流把内存吃光。
  const maxBytes = Math.max(1024, Number(options.maxBytes ?? 10 * 1024 * 1024) || 10 * 1024 * 1024)
  // url 形态截图的主机白名单（C-B6）。**缺省为空 = 一律拒绝**：
  // 截图地址来自工单表，是**外部输入**，不设白名单就等于让填表的人替服务器发任意请求
  // （内网探测 / 云元数据 169.254.169.254 / 打穿本地服务）。默认拒绝、要人显式放行，
  // 出问题时报 invalid-input 提示补附件，而不是偷偷发出去。
  const allowedImageHosts = Array.isArray(options.allowedImageHosts)
    ? options.allowedImageHosts.map((host) => String(host).toLowerCase()).filter(Boolean)
    : []

  const sourceId = `feishu:${projectId || 'unnamed'}`

  // B21：把实际生效的早停阈值 log 一次。钳制去掉之后「配置写什么就跑什么」，
  // 但页面数量异常时人还是会怀疑参数没生效，因此在建实例时留一行可对账的日志。
  if (typeof options.log === 'function') {
    options.log('feishu 早停阈值生效值', { sourceId, safePageRun: safePageRunLimit })
  }
  if (recordFilter.enabled && typeof options.log === 'function') {
    options.log('飞书 工单收窄生效', { sourceId, recordIds: recordFilter.ids })
  }

  if (typeof fetchImpl !== 'function') {
    throw new PipelineError('internal', '飞书适配器需要一个 fetch 实现')
  }

  /**
   * 给一次请求挂上超时，同时保留调用方的取消信号（B8 + B5）。
   *
   * 为什么要自己建 controller 而不是直接用 `AbortSignal.timeout()`：
   * 需要把**调用方的 signal**也接进来 —— 内核取消整轮扫描时，正在飞的请求必须立刻断，
   * 不能等它自己超时。两个信号里任何一个触发都要中断，所以用 `AbortSignal.any`。
   *
   * 返回的 signal 在超时时 abort，原因带 `name === 'TimeoutError'`，
   * 调用方据此区分「超时」和「被人取消」。
   *
   * @param {AbortSignal | undefined} signal 调用方信号
   * @param {number} timeoutMs 超时毫秒
   * @returns {AbortSignal}
   */
  function withTimeout (signal, timeoutMs) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    if (!signal) return timeoutSignal
    // `AbortSignal.any` 在 Node 20.3+ / 浏览器里都有，零依赖。
    return AbortSignal.any([signal, timeoutSignal])
  }

  /**
   * 判断一个错误是不是「超时」而不是「被调用方取消」。
   * @param {unknown} error
   * @returns {boolean}
   */
  function isTimeoutError (error) {
    if (!error || typeof error !== 'object') return false
    const name = String(/** @type {any} */ (error).name ?? '')
    return name === 'TimeoutError' || /timed? ?out/i.test(String(/** @type {any} */ (error).message ?? ''))
  }

  /** @type {{ token: string, expiresAt: number } | null} */
  let tokenCache = null
  /** @type {{ appToken: string, tableId: string } | null} */
  let tableCache = null
  /**
   * 正在进行的 token 获取（single-flight，B4）。
   *
   * 为什么需要它：scan 和 loadScreenshot 是并发调用的，缓存未命中时它们会同时
   * 走到认证接口 —— 一次冷启动能打出好几次认证请求，飞书对认证接口有频率限制，
   * 并发一高就可能被限流。这里存住「在途 Promise」，后来者直接复用它。
   */
  /** @type {Promise<string> | null} */
  let tokenInflight = null

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
   *
   * single-flight（B4）：并发的调用方共用同一个在途 Promise，冷启动只换一次 token。
   * 注意 finally 里清掉 `tokenInflight` —— 不清的话认证失败后失败结果会被永久缓存，
   * 后面每次调用都直接拿到同一个错误，永远好不了。
   *
   * @param {AbortSignal} [signal] 调用方的取消信号（B5 透传）
   * @returns {Promise<string>}
   */
  function getToken (signal) {
    if (tokenCache && now() < tokenCache.expiresAt - 60_000) return Promise.resolve(tokenCache.token)
    if (tokenInflight) return tokenInflight

    tokenInflight = (async () => {
      const appId = await readSecret(appIdRef)
      const appSecret = await readSecret(appSecretRef)

      const data = await apiCall(AUTH_PATH, {
        method: 'POST',
        body: { app_id: appId, app_secret: appSecret },
        auth: false,
        signal,
      })

      const token = String(data.tenant_access_token ?? '')
      if (!token) {
        throw new PipelineError('auth', '飞书认证接口没有返回 tenant_access_token')
      }
      const expire = Number(data.expire ?? 7200)
      tokenCache = { token, expiresAt: now() + Math.max(60, expire) * 1000 }
      return token
    })()

    // 无论成败都要放开在途标记：失败后必须允许下一次重新尝试。
    return tokenInflight.finally(() => { tokenInflight = null })
  }

  /**
   * 主动作废当前 token（B3）。
   *
   * 为什么不能只清 `tokenCache`：缓存里那份 token 在服务端已经失效了，
   * 但如果此刻正好有一次在途的认证（别人刚发起），复用它只会拿到同一份坏结果。
   * 这里把在途标记一起清掉，保证下一次 getToken 真的去换。
   * @param {string} deadToken 已经确认失效的那个 token
   */
  function invalidateToken (deadToken) {
    if (tokenCache && tokenCache.token === deadToken) tokenCache = null
    tokenInflight = null
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
    // 401/403 只重试一次（B3）：重取 token 之后仍然被拒，说明是真的没权限，
    // 再试下去就是无限重试。用 attempt 计数而不是 while(true)，把「最多一次」写死在结构里。
    let attempt = 0
    for (;;) {
      try {
        return await apiCallOnce(path, init)
      } catch (error) {
        const isAuthFailure = error instanceof PipelineError && error.kind === 'auth' && attempt === 0
        if (!isAuthFailure) throw error
        attempt += 1
        // 缓存里的 token 已经死了：清掉它，下一次 getToken 会重新换一份。
        invalidateToken(/** @type {any} */ (error).deadToken ?? '')
        if (init.auth === false) throw error
      }
    }
  }

  /**
   * 调一次飞书接口（不含 401 重试逻辑，重试由外面的 apiCall 管）。
   *
   * @param {string} path
   * @param {{ method?: string, body?: unknown, query?: Record<string, string | number | undefined>, auth?: boolean, signal?: AbortSignal }} [init]
   * @returns {Promise<any>}
   */
  async function apiCallOnce (path, init = {}) {
    const url = new URL(FEISHU_API_BASE + path)
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    }
    const headers = { 'Content-Type': 'application/json; charset=utf-8' }
    const token = init.auth === false ? null : await getToken(init.signal)
    if (token) headers.Authorization = `Bearer ${token}`

    let response
    try {
      response = await fetchImpl(url.toString(), {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        // B8：每个请求都挂超时，同时把调用方的 signal 透传进去（B5）。
        signal: withTimeout(init.signal, requestTimeoutMs),
      })
    } catch (error) {
      if (error instanceof PipelineError) throw error
      throw new PipelineError('network', `调用飞书接口失败：${error instanceof Error ? error.message : String(error)}`)
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        // 把失效的 token 带出去，让 apiCall 精确作废**这一个**，
        // 而不是把缓存一刀切（并发场景下别人可能刚换到一份好的）。
        const authError = new PipelineError('auth', `飞书接口拒绝访问（HTTP ${response.status}）`)
        const tagged = /** @type {any} */ (authError)
        tagged.deadToken = token ?? ''
        tagged.status = response.status
        throw authError
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers?.get?.('retry-after') ?? 5)
        throw new PipelineError('rate-limit', `飞书接口限流（HTTP 429）`, undefined, Math.max(1000, retryAfter * 1000))
      }
      // 把飞书返回的错误片段带出来 —— HTTP 状态码本身不带原因，
      // 没这段就排不了「400 到底是 token 错还是权限错」。
      let bodyHint = ''
      try {
        const raw = await response.text()
        bodyHint = `：${raw.slice(0, 200)}`
      } catch { /* 读不到 body 就只报状态码 */ }
      throw new PipelineError('internal', `飞书接口返回 HTTP ${response.status}${bodyHint}`)
    }

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      throw new PipelineError('internal', `飞书接口返回的不是 JSON：${error instanceof Error ? error.message : String(error)}`)
    }
    const code = Number(payload?.code ?? 0)
    if (code !== 0) {
      const mapped = mapApiError(code, String(payload?.msg ?? '未知错误'))
      // 业务码层面的鉴权失效（比如 token 过期但 HTTP 是 200）也要能触发重取。
      if (mapped.kind === 'auth') { /** @type {any} */ (mapped).deadToken = token ?? '' }
      throw mapped
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
    // 与 apiCall 相同的 401 重试策略：附件下载也会因为 token 过期被拒，
    // 只重试一次，第二次还拒就是真没权限。
    let attempt = 0
    for (;;) {
      const token = await getToken(signal)
      let response
      try {
        response = await fetchImpl(url.toString(), {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          signal: withTimeout(signal, requestTimeoutMs),
        })
      } catch (error) {
        if (isTimeoutError(error)) {
          throw new PipelineError('network', `下载飞书附件超时（${requestTimeoutMs}ms）`)
        }
        throw new PipelineError('network', `下载飞书附件失败：${error instanceof Error ? error.message : String(error)}`)
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          if (attempt === 0) {
            attempt += 1
            invalidateToken(token)
            continue
          }
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
      // C-B7：改成有上限读取。原来的 arrayBuffer() 会把整个文件先吞进内存，
      // 一个几百 MB 的附件足以把进程打爆；这里边读边累加，超限立刻断开。
      const bytes = await readBodyWithLimit(response, maxBytes, `飞书附件 ${path}`)
      return {
        bytes,
        contentType: response.headers?.get?.('content-type') ?? undefined,
      }
    }
  }

  /**
   * 边读边累加响应体，超过上限就中断（C-B6 / C-B7）。
   *
   * 为什么不能用 `arrayBuffer()`：它先把整段读进内存再交给你，
   * 等你能判断大小时，内存已经被占满了 —— 上限必须在**读的过程中**生效。
   *
   * 两条路都走得上：
   * - 响应带 `body.getReader()`（真实 fetch）→ 按 chunk 累加，超限 `cancel()` 后抛错；
   * - 只有 `arrayBuffer()`（测试桩 / 老实现）→ 先看 `content-length`，读回来再量一次。
   *
   * @param {any} response
   * @param {number} limit 字节上限
   * @param {string} what 出错时的对象描述（写清是哪个资源）
   * @returns {Promise<Uint8Array>}
   */
  async function readBodyWithLimit (response, limit, what) {
    const declared = Number(response.headers?.get?.('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > limit) {
      // 服务端自己报了大小，连读都不用读。
      throw new PipelineError('invalid-input', `${what} 太大：${declared} 字节，超过上限 ${limit} 字节`)
    }

    const reader = response.body?.getReader?.()
    if (!reader) {
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > limit) {
        throw new PipelineError('invalid-input', `${what} 太大：${buffer.byteLength} 字节，超过上限 ${limit} 字节`)
      }
      return new Uint8Array(buffer)
    }

    /** @type {Uint8Array[]} */
    const chunks = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > limit) {
          throw new PipelineError('invalid-input', `${what} 太大：已读超过上限 ${limit} 字节，已中止下载`)
        }
        chunks.push(value)
      }
    } catch (error) {
      // 超限时要把底层连接断掉，否则对方还在往里灌数据，读端已经没人要了。
      try { await reader.cancel() } catch { /* 断连失败不影响结论 */ }
      throw error
    }

    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out
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
   * @param {AbortSignal} [signal] 调用方的取消信号（B5 透传：整轮扫描被取消时这里也得停）
   * @returns {Promise<Array<{ token: string, name: string }>>}
   */
  async function searchBitableDocs (pattern, signal) {
    /** @type {Array<{ token: string, name: string }>} */
    const hits = []
    let pageToken = ''
    for (let guard = 0; guard < 20; guard += 1) {
      const payload = await apiCall('/open-apis/drive/v1/files', {
        query: { page_size: 200, page_token: pageToken },
        signal,
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
   * @param {AbortSignal} [signal] 调用方的取消信号（B5）
   * @returns {Promise<{ appToken: string, tableId: string }>}
   */
  /**
   * 把配置里的 appToken 归一成 bitable 的 app_token。
   *
   * 用户常把 wiki 链接（或 wiki token）直接贴进来 —— wiki 里的多维表格有两种形态：
   * 旧版要换成 get_node 的 obj_token，新版 bitable API 直接吃 wiki token 本身。
   * 所以这里不做单一换算，而是返回候选列表（obj_token 优先，wiki token 兜底），
   * 由 resolveTable 逐个试，哪个能列出表就用哪个。
   * 支持：完整 wiki/base URL、wiki token、原生 app_token（原样返回）。
   *
   * @returns {Promise<string[]>} 按优先级排的候选 app_token 列表
   */
  async function normalizeAppToken (signal) {
    let token = String(appToken ?? '').trim()
    // 完整 URL：/wiki/<token> 或 /base/<token> —— 直接抠出 token，并记住来源形态。
    // 注意：wiki 节点的 token 不一定以 wiki 开头（如 RXEP…），所以不能只看前缀判断，
    // 必须看它是不是从 /wiki/ URL 里抠出来的。
    const wikiUrlMatch = token.match(/\/wiki\/([A-Za-z0-9]+)/)
    const baseToken = token.match(/\/base\/([A-Za-z0-9]+)/)
    if (baseToken) return [baseToken[1]] // /base/ URL → 原生 app_token，直接用
    if (wikiUrlMatch) token = wikiUrlMatch[1]
    else {
      const bareMatch = token.match(/^([A-Za-z0-9]+)$/)
      token = bareMatch ? bareMatch[1] : token
    }
    const fromWiki = Boolean(wikiUrlMatch) || /^wiki/i.test(token)
    if (!fromWiki) return [token] // 原生 app_token（含 /base/ 抠出的），原样返回
    const payload = await apiCall('/open-apis/wiki/v2/spaces/get_node', {
      query: { token, obj_type: 'bitable' },
      signal,
    })
    const node = payload?.data?.node
    const objType = String(node?.obj_type ?? '')
    const objToken = String(node?.obj_token ?? '')
    if (objType && objType !== 'bitable') {
      throw new PipelineError(
        'invalid-input',
        `wiki 节点 ${token} 不是多维表格，实际类型是 ${objType}（docx=文档、sheet=电子表格、mindnote=思维笔记）。请在飞书里确认工单表是一张「多维表格」，把那张表的链接填进 appToken。`,
      )
    }
    if (!objToken) {
      throw new PipelineError(
        'invalid-input',
        `wiki 节点 ${token} 换算不出多维表格（obj_token 为空）。请确认这个链接指向的是一张多维表格，且应用有该知识库的阅读权限。`,
      )
    }
    // 新版 wiki base 直接用 wiki token；旧版用换算出的 obj_token。两个都试。
    const candidates = [objToken]
    if (token !== objToken) candidates.push(token)
    return candidates
  }

  async function resolveTable (signal) {
    if (tableCache) return tableCache

    if (appToken && String(appToken).trim().length > 0) {
      const candidates = await normalizeAppToken(signal)
      // 逐个候选试列表层：第一个能列出表的胜出（旧版 wiki base 用 obj_token，新版直接吃 wiki token）。
      let lastError = null
      const attempts = []
      for (const candidate of candidates) {
        try {
          const found = await resolveTableWithAppToken(candidate, signal)
          tableCache = found
          return tableCache
        } catch (error) {
          attempts.push(`${candidate.slice(0, 12)}…: ${error instanceof Error ? error.message : String(error)}`)
          lastError = error
        }
      }
      if (attempts.length > 1) {
        // 多候选都失败时把每次尝试列出来，别只报最后一个 —— 用户能看出两个 token 都试过。
        throw new PipelineError(lastError?.kind ?? 'internal', `飞书读表失败，共试了 ${attempts.length} 个 app_token 候选。`
          + attempts.map((a) => `\n- ${a}`).join(''))
      }
      throw lastError ?? new PipelineError('invalid-input', `appToken ${String(appToken)} 无法定位多维表格`)
    }

    if (!docNamePattern) {
      throw new PipelineError('invalid-input', '飞书项目既没给 appToken/tableId，也没给 docNamePattern，无法定位工单表')
    }

    const docs = await searchBitableDocs(docNamePattern, signal)
    if (docs.length !== 1) {
      throw new PipelineError(
        'invalid-input',
        `按 "${docNamePattern}" 匹配到 ${docs.length} 张多维表格，需要恰好 1 张。`
          + `候选：${docs.map((doc) => doc.name).join('、') || '（无）'}`,
      )
    }
    const doc = docs[0]
    const payload = await apiCall(`/open-apis/bitable/v1/apps/${doc.token}/tables`, { query: { page_size: 100 }, signal })
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
   * 用确定的 app_token 走原来的两条路：有 tableId 直接绑定，没 tableId 按 pattern 在表清单里挑唯一一张。
   */
  async function resolveTableWithAppToken (resolvedAppToken, signal) {
    if (tableId) {
      return { appToken: resolvedAppToken, tableId }
    }

    const payload = await apiCall(`/open-apis/bitable/v1/apps/${resolvedAppToken}/tables`, { query: { page_size: 100 }, signal })
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
    return { appToken: resolvedAppToken, tableId: String(matched[0].table_id) }
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

    const table = await resolveTable(signal)
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
        if (error instanceof PipelineError && /sort/i.test(message)) {
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
        // 收窄开关：名单外的行整行跳过。必须在 live.add 之前 ——
        // 名单外的行这一轮「没出现」，但它不是被删了，只是这轮不收它。
        if (!recordFilter.allows(recordId)) continue
        live.add(recordId)

        const fields = item?.fields ?? {}
        const status = normalizeCellText(fields[FEISHU_COLUMNS.status])
        const inProgress = statusValues.includes(status)
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
        // 指纹不能在这里就更新：非「处理中」的行（待认领 / 已闭环）改了内容再拨回「处理中」时，
        // 若指纹已被提前换成新值，下面判出的 contentChanged 恒为 false，这条修订就永远收不到。
        // 所以指纹只在真正把这条修订收进 updated 的时候才更新（见下面的 updated 分支）。
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

        if (contentChanged) {
          // 判定收票之后再更新指纹：这一步才是「这条内容已经入过队」，
          // 提前更新会让上面说的漏修订成立。tracked 从 false→true 那个分支走 created，不在那里更新指纹。
          updated.push(ticket)
          prev.fingerprint = ticket.fingerprint
        }

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
    //
    // 但只有**完整扫完**这一轮才允许推进 missingScans：翻页循环会因连续 safePageRun 条
    // 已知未变而早停（stopped），这时后面没请求过的页里的行根本没进 live。「早停时未访问 ≠ 不存在」，
    // 若照样给它们累加 missingScans，静止的表扫几轮就会把后面那批行全当成已删除地误退役。
    // 被早停打断的这一轮，对没见到的行一律不下判断（missingScans 保持原值，seen 里的记录都留着）。
    //
    // 代价要写在明处：表回到「前 safePageRun 条（默认 20）稳定不变、后面还有行」的形状时，
    // 排在停点之后的行整轮都不会被访问，它们若真被删了，missingScans 永远不涨，
    // 于是会一直挂在水位里（不会误退役，但也永不消失）。这是拿「漏删」换「不误杀」。
    // 真遇到要靠人工核对：把它当已知代价，别指望晚到的重扫能自愈。
    if (!stopped) {
      for (const [recordId, state] of Object.entries(seen)) {
        if (live.has(recordId)) continue
        // 收窄名单外的行不参与退役判定：收窄期间它们只是「没被看」，
        // 累加「连续没出现」会把它们误判成已删除（票被收尾）。
        if (!recordFilter.allows(recordId)) continue
        state.missingScans = (state.missingScans ?? 0) + 1
        if (state.missingScans >= goneAfterScans) {
          if (!disappeared.includes(recordId)) disappeared.push(recordId)
          delete seen[recordId]
        }
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
      // C-B6：url 形态的截图地址来自**工单表**，是外部输入。不设防就等于让填表的人
      // 替服务器发任意请求（打内网、读云元数据 169.254.169.254、探测本地端口）。
      // 三道闸：协议白名单 → 主机白名单 → 重定向逐跳重新校验，外加总超时和字节上限。
      const fetched = await fetchImageUrl(String(ref.url ?? ''), signal)
      const mediaType = pickMediaType(fetched.contentType, ref.url)
      if (!mediaType) {
        throw new PipelineError('invalid-input', `链接 ${ref.url} 不是受支持的图片类型（${fetched.contentType ?? '未知'}）`)
      }
      return { data: fetched.bytes, mediaType, name: ref.url }
    }

    throw new PipelineError('invalid-input', '认不出这张截图的形态，需要人补图')
  }

  /**
   * 校验一个截图 url 是否允许请求（C-B6）。
   *
   * @param {string} rawUrl
   * @returns {URL}
   */
  function assertImageUrlAllowed (rawUrl) {
    let parsed
    try {
      parsed = new URL(rawUrl)
    } catch {
      throw new PipelineError('invalid-input', `截图链接不是合法 URL：${rawUrl}`)
    }
    // 只认 http/https。file: / ftp: / data: 之类全部拒掉 —— 尤其 file:
    // 能直接读服务器本地文件，是最典型的 SSRF 升级路径。
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new PipelineError('invalid-input', `截图链接只允许 http / https，收到 ${parsed.protocol}`)
    }
    // 主机白名单缺省为空 = 一律拒绝。错误信息要说清怎么办：
    // 人看到的是「补附件」，而不是一个看不懂的安全错误。
    if (allowedImageHosts.length === 0) {
      throw new PipelineError(
        'invalid-input',
        `截图链接 ${parsed.host} 被拒绝：未配置 allowedImageHosts（缺省一律拒绝 url 形态截图）。请把截图改成附件上传，或在配置里放行该域名。`,
      )
    }
    const host = parsed.hostname.toLowerCase()
    const allowed = allowedImageHosts.some((entry) => {
      // 支持两种写法：精确主机名（`cdn.example.com`）与通配子域（`*.example.com`）。
      if (entry.startsWith('*.')) {
        const suffix = entry.slice(1) // '.example.com'
        return host.endsWith(suffix)
      }
      return host === entry
    })
    if (!allowed) {
      throw new PipelineError(
        'invalid-input',
        `截图链接 ${host} 不在 allowedImageHosts 白名单里。请把截图改成附件上传，或把该域名加进白名单。`,
      )
    }
    return parsed
  }

  /**
   * 取 url 形态截图的字节（C-B6）。
   *
   * 为什么手动跟重定向而不是让 fetch 自己跟：`redirect: 'follow'` 会在**不通知我们**的
   * 情况下跳到任意主机 —— 白名单就形同虚设（放行 cdn.example.com，它 302 到 127.0.0.1）。
   * 必须每跳都重新过一遍白名单。最多 3 跳，再多就当循环/钓鱼链接。
   *
   * @param {string} rawUrl
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ bytes: Uint8Array, contentType?: string }>}
   */
  async function fetchImageUrl (rawUrl, signal) {
    const MAX_REDIRECTS = 3
    // 总超时按整条重定向链算，不是每跳各算一次：否则 3 跳 × 10 秒能拖 30 秒。
    const deadline = Date.now() + imageTimeoutMs
    let currentUrl = assertImageUrlAllowed(rawUrl).toString()

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new PipelineError('network', `下载截图链接超时（${imageTimeoutMs}ms）：${rawUrl}`)
      }

      let response
      try {
        response = await fetchImpl(currentUrl, {
          method: 'GET',
          // 手动跟跳：这一层由我们逐跳校验，不能让 fetch 自己跳过去。
          redirect: 'manual',
          signal: withTimeout(signal, remaining),
        })
      } catch (error) {
        if (isTimeoutError(error)) {
          throw new PipelineError('network', `下载截图链接超时（${imageTimeoutMs}ms）：${currentUrl}`)
        }
        throw new PipelineError('network', `下载截图链接失败：${error instanceof Error ? error.message : String(error)}`)
      }

      const status = Number(response.status ?? 0)
      const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308
      if (isRedirect) {
        if (hop === MAX_REDIRECTS) {
          throw new PipelineError('invalid-input', `截图链接重定向超过 ${MAX_REDIRECTS} 跳，当作可疑链接拒绝：${rawUrl}`)
        }
        const location = response.headers?.get?.('location') ?? ''
        if (!location) {
          throw new PipelineError('invalid-input', `截图链接返回 ${status} 但没有 Location：${currentUrl}`)
        }
        // 相对跳转要按当前地址解析，再重新校验 —— 每一跳都过白名单。
        currentUrl = assertImageUrlAllowed(new URL(location, currentUrl).toString()).toString()
        continue
      }

      if (!response.ok) {
        throw new PipelineError('not-found', `截图链接返回 HTTP ${status}`)
      }
      // C-B6：字节上限。边读边累加，超限立刻断开，别把内存吃光。
      const bytes = await readBodyWithLimit(response, maxBytes, `截图链接 ${currentUrl}`)
      return { bytes, contentType: response.headers?.get?.('content-type') ?? undefined }
    }

    // 理论上到不了这里（循环里有 return/throw），留个兜底免得返回 undefined。
    throw new PipelineError('invalid-input', `截图链接重定向过多：${rawUrl}`)
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
 * @returns {{ appToken: string, tableId: string, viewId: string, docNamePattern: string, statusValues?: string[], recordIds?: string[] }}
 */
export function feishuOptionsFromMatch (match) {
  const m = match ?? {}
  /** @type {Record<string, unknown>} */
  const options = {
    appToken: String(m.appToken ?? ''),
    tableId: String(m.tableId ?? ''),
    viewId: String(m.viewId ?? ''),
    docNamePattern: String(m.docNamePattern ?? ''),
  }
  // 只在配置里真的写了状态值时才透传：没写就用适配器自己的缺省值，
  // 免得「空数组」这种空配置反过来把缺省也顶掉。
  if (m.statusValues !== undefined && m.statusValues !== null && m.statusValues !== '') {
    options.statusValues = resolveStatusValues(m.statusValues)
  }
  // 收窄开关同理：不写就不透传（空数组是配置错误，由配置层先拦下）。
  if (m.recordIds !== undefined && m.recordIds !== null && m.recordIds !== '') {
    options.recordIds = resolveRecordIds(m.recordIds)
  }
  // 截图链接白名单：**不写就保持空**（适配器对 url 形态截图缺省一律拒绝）。
  // 这里不能给缺省值：白名单是安全闸门，只有人能打开它。
  if (m.allowedImageHosts !== undefined && m.allowedImageHosts !== null && m.allowedImageHosts !== '') {
    const list = Array.isArray(m.allowedImageHosts) ? m.allowedImageHosts : [m.allowedImageHosts]
    const hosts = list
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0)
    if (hosts.length > 0) options.allowedImageHosts = Array.from(new Set(hosts))
  }
  return /** @type {any} */ (options)
}
