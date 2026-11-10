/**
 * `source-feishu` —— 飞书多维表格工单源（真实实现，地图票 #12）。
 *
 * 它做五件事，其余全在别处：
 * 1. **认证**：用 `app_id` + `app_secret` 换 `tenant_access_token`，过期前自动刷新。
 * 2. **扫描**：`records/search` 按「最后更新时间」降序翻页，客户端比水位 + 内容指纹。
 * 3. **取字节**：截图三种形态（附件 / 本地路径 / http 链接）都归一成 `Uint8Array`。
 * 4. **绑定表**：`appToken` + `tableId` 直接给，或用 `docNamePattern` 猜（猜不准就报错）。
 * 5. **回填**：票跑完后把「是否处理 / 处理结果 / 处理日期」写回那一行（`writeResult`）。
 *
 * 硬约束：
 * - **扫描绝不写表格**（用户 2026-11-03 拍板）：`scan` 里没有任何 PUT / POST 到记录接口的调用。
 * - **唯一的写入口是 `writeResult`**（用户 2026-11-06 拍板：处理完要回填结果）。
 *   它只在票跑完 done / skipped 之后被调用一次，绝不在扫描或重试中间被调用。
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
import { IMAGE_MEDIA_TYPES, parseBitableUrl } from '../../contracts/types.js'
import {
  BITABLE_CANONICAL_COLUMNS,
  BITABLE_COLUMN_ALIASES,
  DEFAULT_SHEET_HEADER_ROW,
  DEFAULT_SHEET_ID_COLUMN,
  buildValueRange,
  columnLetter,
  locateSheetHeader,
  mapColumns,
  normalizeSheetDate,
  parseSheetRange,
  parseSheetRows,
  resolveSheetColumns,
  resolveWorksheet,
  sheetPriorityOf,
} from './sheets.js'

const FEISHU_API_BASE = 'https://open.feishu.cn'
const AUTH_PATH = '/open-apis/auth/v3/tenant_access_token/internal'

/** `records/search` 单页上限（飞书文档写死 500）。 */
const RECORD_PAGE_SIZE = 500

/** 凭据引用名（`ctx.credentials` 的 ref 名）。 */
const DEFAULT_APP_ID_REF = 'FEISHU_APP_ID'
const DEFAULT_APP_SECRET_REF = 'FEISHU_APP_SECRET'

/**
 * 工单表的列名（**规范名**）。
 *
 * 为什么要显式写死一份：多维表格的字段名是**表级**的约定，不是飞书的通用概念。
 * 这张表的结构来自用户贴出的《PMS系统问题Bug记录表》使用说明（12 列）。
 *
 * 但它已经**不再是唯一的认定口径**（工单 #21）：真实扫描前会先读一遍表的字段列表，
 * 用 `BITABLE_COLUMN_ALIASES`（规范名 + 电子表格那套别名）把语义字段映到表里的真实名字。
 * 名字一模一样时这份常量就是映射结果，所以它同时充当「缺省映射」。
 * 保留这个导出是因为自测与外部脚本仍在按规范名造数据 —— 别在业务代码里新引它。
 */
export const FEISHU_COLUMNS = BITABLE_CANONICAL_COLUMNS

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
 * 「字段不存在」的业务码（回填专用）。
 *
 * 为什么单独列出来：回填是我们**主动写**一个表，表里没有「处理结果」列是
 * **配置问题而不是故障** —— 人把插件接到一张不含这三列的表上时，应该退回只读并
 * 在回执里说清楚，而不是让这张票判失败（票其实已经处理完了）。
 *
 * 飞书这一族错误码的写法在不同接口版本里不一致（1254045 是 FieldNameNotFound 的
 * 常见取值，部分版本把同类问题报成 1254040），所以除了码表还看 msg 里的关键词，
 * 见 `isFieldMissingError`。宁可多认，也不要因为一个码没对上就把整票写失败。
 */
const FIELD_MISSING_ERROR_CODES = new Set([1254040, 1254045])

/**
 * 「这是一张同步表（sync table），不接受直接写记录」的业务码。
 *
 * 真发现（2026-11-09，pms 项目真链路）：回填发出 `data.setRecord` 之后飞书回
 * `800074911：ConnectorSyncTableActionForbidden, [status_code: 800004105 msg: syncTable
 * can not apply action:action=data.setRecord, tabID=tbl…, fldID=fld…]`。
 *
 * 和「字段不存在」是同一类事——**配置/权限问题，不是故障**：飞书的多维表格
 * 如果是从一个「同步表」接出来的（数据由连接器同步进来），行是被同步源拥有的，
 * 直接改字段会被拒。换句话说这张票本身处理完了，只是**这张表结构上写不进去**。
 * 归成 `internal` 会让票据上挂一句看起来像插件坏了的话，还会被当成可重试错误
 * 反复重试；其实重试一万次也一样。所以要单独识别，退化成只读回执并说清怎么办。
 *
 * 两个码都认：外层是 800074911，内层 status_code 800004105。
 * 除了码表还看 msg 关键词兜底，理由同 `isFieldMissingError`。
 */
const SYNC_TABLE_FORBIDDEN_ERROR_CODES = new Set([800074911, 800004105])

/**
 * 判断一个错误是不是「这张表是同步表，不允许写」。
 *
 * 导出是为了让自测能直接喂一段真实的飞书报错文本进来验证，
 * 而不是去构造一个完整的多维表格。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isSyncTableForbiddenError (error) {
  if (!error || typeof error !== 'object') return false
  const message = String(/** @type {any} */ (error).message ?? '')
  const codeMatch = message.match(/(?:报错|错误码)\s*(\d+)/)
  if (codeMatch && SYNC_TABLE_FORBIDDEN_ERROR_CODES.has(Number(codeMatch[1]))) return true
  if (/ConnectorSyncTableActionForbidden/i.test(message)) return true
  if (/syncTable/i.test(message) && /(can not|cannot)/i.test(message)) return true
  // 内层 status_code 也可能被抓进同一段文本里。
  return /\b800004105\b|\b800074911\b/.test(message)
}

/**
 * 判断一个错误是不是「表里没有这个字段」。
 *
 * 两种证据任一成立就算：业务码在白名单里，或 msg 里同时出现字段与「不存在」的意思。
 * 第二条是兜底：错误码表是飞书侧的闭源约定，写死一套总有对不上的时候。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isFieldMissingError (error) {
  if (!error || typeof error !== 'object') return false
  const message = String(/** @type {any} */ (error).message ?? '')
  const codeMatch = message.match(/(?:报错|错误码)\s*(\d+)/)
  if (codeMatch && FIELD_MISSING_ERROR_CODES.has(Number(codeMatch[1]))) return true
  if (/FieldNameNotFound/i.test(message)) return true
  return /字段/.test(message) && /(不存在|找不到|未找到|not found)/i.test(message)
}

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

  // ── 电子表格（Sheets）分支的配置 ────────────────────────────────
  //
  // 这些键只对电子表格有意义。配了但实际探测出的是多维表格 → 全部忽略，不报错
  // （设计 §4.2 最后一条：同一份配置可能在两种表型之间搬来搬去，不该因此启动失败）。
  const spreadsheetToken = String(options.spreadsheetToken ?? '')
  const sheetId = String(options.sheetId ?? '')
  const sheetName = String(options.sheetName ?? '')
  const sheetHeaderRow = Number(options.sheetHeaderRow ?? DEFAULT_SHEET_HEADER_ROW) || DEFAULT_SHEET_HEADER_ROW
  const sheetIdentity = options.sheetIdentity === 'row' ? 'row' : 'seq'
  const sheetIdColumn = String(options.sheetIdColumn ?? DEFAULT_SHEET_ID_COLUMN)
  // 逃生阀：显式指定表型时**跳过探测**（省两次请求，也给人一条「我知道这是什么」的路）。
  const tableKindOption = options.tableKind === 'bitable' || options.tableKind === 'sheet' ? options.tableKind : ''
  // 解析期的配置错误必须**当场抛**（而不是等第一次扫描才发现）：这两个函数会校验
  // 写法是否合法，写错了现在就该告诉人，而不是等到半夜轮询才报错。
  const sheetRange = parseSheetRange(options.sheetRange)
  const sheetColumns = resolveSheetColumns(options.sheetColumns)
  // 多维表格的列名覆盖（工单 #21）：与 `sheetColumns` **同一个键、同一套校验**，
  // 只是字段白名单换成多维表格那份（规范名 + 电子表格别名，两边都收）。
  // 人只有一张表要配，不该为了「这张是哪种表型」去改键名。
  const bitableColumns = resolveSheetColumns(options.columns, {
    aliases: BITABLE_COLUMN_ALIASES,
    optionName: 'match.columns',
  })
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
   * 多维表格的列名映射缓存（工单 #21）。
   *
   * 为什么按 `appToken/tableId` 缓存而不是一次算死：`resolveTable()` 的结果本身是缓存的，
   * 但 `writeResult()` 也会独立走一遍（回填时要拼字段名），两处必须拿到**同一份**映射，
   * 否则扫描按「缺陷描述」读、回填按「问题描述」写，看起来都对，实际错位。
   *
   * `null` = 还没读过字段列表；`{ columns, names }` = 已解析（可能带 warning）。
   * @type {{ columns: Record<string, string>, names: Record<string, string>, missing: string[] } | null}
   */
  let columnCache = null
  /** @type {Promise<any> | null} */
  let columnInflight = null
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
   * 在云文档里按名字找工单表。
   *
   * 以前这里只认 `type === 'bitable'`，于是电子表格永远搜不到。现在两种都收，
   * 由调用方按表型决定怎么用（设计 §3.1 第 4 条：`docNamePattern` 要能命中
   * 电子表格；两种合计恰好命中 1 张才用）。
   *
   * @param {string} pattern
   * @param {AbortSignal} [signal] 调用方的取消信号（B5 透传：整轮扫描被取消时这里也得停）
   * @returns {Promise<Array<{ token: string, name: string, type: string }>>}
   */
  async function searchCloudDocs (pattern, signal) {
    /** @type {Array<{ token: string, name: string, type: string }>} */
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
        // 只认工单表可能的那两种。docx / mindnote 之类一律不看。
        if (type !== 'bitable' && type !== 'sheet') continue
        const name = String(file?.name ?? '')
        if (!matchesPattern(name, pattern)) continue
        hits.push({ token: String(file?.token ?? ''), name, type })
      }
      if (!data.has_more || !data.page_token) break
      pageToken = String(data.page_token)
    }
    return hits.filter((hit) => hit.token)
  }

  /**
   * 从用户填的值里抠出 `spreadsheetToken`。
   *
   * 三种写法都要认：整条表格链接（`…/sheets/shtcnXXX?sheet=YYY`）、裸 token、wiki 换算出来的 obj_token。
   * 电子表格的行身份、工作表定位都基于这个 token，抠错了整条链路都读不到东西。
   *
   * @param {unknown} raw
   * @returns {string}
   */
  function extractSheetToken (raw) {
    const text = String(raw ?? '').trim()
    if (text.length === 0) return ''
    const urlMatch = text.match(/\/sheets\/([A-Za-z0-9]+)/)
    if (urlMatch) return urlMatch[1]
    const bare = text.match(/^([A-Za-z0-9]+)$/)
    if (bare) return bare[1]
    return text
  }

  /**
   * 这个 token 是不是 wiki 形态（wiki 链接或 `wiki` 开头的 token）。
   * @param {string} raw
   * @returns {boolean}
   */
  function isWikiToken (raw) {
    const text = String(raw ?? '').trim()
    if (/\/wiki\//.test(text)) return true
    return /^wiki/i.test(text)
  }

  /**
   * 从 wiki 链接 / wiki token 里抠出裸 token（去掉 URL 外壳）。
   *
   * 为什么单独一个函数：`probeWikiNode` 里也会做同样的剥离，但那里剥完就只用于
   * `get_node` 请求。而 resolveTable 在「obj_token 试不通、回退 wiki token」时
   * 需要的是**裸 token** 拼 bitable 接口 —— 把整条 URL 塞进 path 会拼出错误地址。
   *
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
   * 用 `get_node` 问出 wiki 节点到底是什么文档。
   *
   * **这里以前硬写了 `obj_type: 'bitable'`** —— 请求里指定类型，飞书就只回答「是不是
   * 多维表格」，电子表格 100% 进不来（这是用户「电子表格用不了」的直接原因）。
   * 现在不带 `obj_type`，让服务端回答真实类型，再自己判定。
   *
   * `obj_type` 为空时按多维表格兜底：老版本服务端可能不返回这个字段，
   * 而多维表格是本插件最早支持的形态，兜底它最不容易把现有用户弄挂。
   *
   * @param {string} raw
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ kind: 'bitable'|'sheet', token: string, note?: string }>}
   */
  async function probeWikiNode (raw, signal) {
    let token = String(raw ?? '').trim()
    const wikiUrlMatch = token.match(/\/wiki\/([A-Za-z0-9]+)/)
    if (wikiUrlMatch) token = wikiUrlMatch[1]
    else {
      const bare = token.match(/^([A-Za-z0-9]+)$/)
      if (bare) token = bare[1]
    }
    const payload = await apiCall('/open-apis/wiki/v2/spaces/get_node', { query: { token }, signal })
    const node = payload?.data?.node
    const objType = String(node?.obj_type ?? '')
    const objToken = String(node?.obj_token ?? '')
    if (objType.length === 0) {
      return { kind: 'bitable', token: objToken || token, note: `wiki 节点 ${token} 没返回 obj_type，按多维表格试` }
    }
    if (objType === 'bitable') return { kind: 'bitable', token: objToken || token }
    if (objType === 'sheet') {
      // 知识库里的电子表格，obj_token 本身就是 spreadsheetToken（设计 §3.2 已核实），
      // 不需要再换算一次。
      return { kind: 'sheet', token: objToken || token }
    }
    throw new PipelineError(
      'invalid-input',
      `wiki 节点 ${token} 既不是多维表格也不是电子表格，实际类型是 ${objType}（docx=文档、mindnote=思维笔记）。`
        + '请在飞书里确认工单表是多维表格或电子表格，把那张表的链接填进 match.appToken（或 match.spreadsheetToken）。',
    )
  }

  /**
   * 定位一张电子表格里的工作表。
   *
   * @param {unknown} rawToken spreadsheetToken / 表格链接 / wiki 换算结果
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ kind: 'sheet', spreadsheetToken: string, sheetId: string, sheetTitle: string }>}
   */
  async function resolveSheetTarget (rawToken, signal) {
    const token = extractSheetToken(rawToken)
    if (token.length === 0) {
      throw new PipelineError('invalid-input', '飞书电子表格需要 spreadsheetToken（shtcn… 或整条表格链接），当前是空的')
    }
    const payload = await apiCall(`/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(token)}/sheets/query`, { signal })
    const sheets = Array.isArray(payload?.data?.sheets) ? payload.data.sheets : []
    const sheet = resolveWorksheet(sheets, { sheetId, sheetName })
    if (sheet.note && typeof options.log === 'function') {
      // 没指定工作表时取第一张可见的 —— 这不算错，但必须留下一行日志说明「取了哪张」，
      // 否则人看到扫出票却不知道是从哪个页签读的。
      options.log('feishu 电子表格工作表定位', { sourceId, spreadsheetToken: token, sheetId: sheet.sheetId, title: sheet.title, note: sheet.note })
    }
    return { kind: 'sheet', spreadsheetToken: token, sheetId: sheet.sheetId, sheetTitle: sheet.title }
  }

  /**
   * 这个错误值不值得再拿同一个 token 试电子表格。
   *
   * 设计 §3.3：`auth` / `rate-limit` / `network` / `internal` 是**真故障**，
   * 直接抛出去别埋掉（否则人会看到一句「两个都不是」，而真因是凭据错了）；
   * `not-found` / `invalid-input` 之类才说明「这个 token 不是多维表格，试试 sheet」。
   *
   * @param {unknown} error
   * @returns {boolean}
   */
  function shouldTrySheet (error) {
    if (!(error instanceof PipelineError)) return false
    // 已经确认这个 token 是多维表格（能列出数据表）时不要再试电子表格：
    // 后面那句「既当不了多维表格也当不了电子表格」会把真正的错（表名写错）埋掉。
    if (/** @type {any} */ (error).confirmedBitable === true) return false
    return !['auth', 'rate-limit', 'network', 'internal', 'aborted'].includes(error.kind)
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
   * 把配置里的 appToken 归一成 bitable 的 app_token 候选。
   *
   * 用户常把 wiki 链接（或 wiki token）直接贴进来 —— wiki 里的多维表格有两种形态：
   * 旧版要换成 get_node 的 obj_token，新版 bitable API 直接吃 wiki token 本身。
   * 所以这里不做单一换算，而是返回候选列表（obj_token 优先，wiki token 兜底），
   * 由调用方逐个试，哪个能列出表就用哪个。
   * 支持：完整 wiki/base URL、wiki token、原生 app_token（原样返回）。
   *
   * 注意：**这个函数只负责「看起来像多维表格」的归一**。wiki 节点到底是不是多维表格，
   * 由 `resolveTable` 里的 `probeWikiNode` 统一问（那里不再硬写 `obj_type`，
   * 所以电子表格的 wiki 链接也不会被它错误地否掉）。
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
    // wiki 形态：交给 probeWikiNode 问真实类型（它才决定这是不是多维表格）。
    const node = await probeWikiNode(token, signal)
    if (node.kind !== 'bitable') {
      throw new PipelineError(
        'invalid-input',
        `wiki 节点 ${token} 是电子表格，不是多维表格（多维表格用 match.appToken，电子表格用 match.spreadsheetToken）。`,
      )
    }
    if (!node.token) {
      throw new PipelineError(
        'invalid-input',
        `wiki 节点 ${token} 换算不出多维表格 token（obj_token 为空）。请确认这个链接指向的是一张多维表格，且应用有该知识库的阅读权限。`,
      )
    }
    // 新版 wiki base 直接用 wiki token；旧版用换算出的 obj_token。两个都试。
    const candidates = [node.token]
    if (token !== node.token) candidates.push(token)
    return candidates
  }

  /**
   * 定位到底读哪张表 —— **表型分派的总闸**。
   *
   * 三条输入形态（设计 §3.1）：
   * 1. 显式给了 `spreadsheetToken` → 一定是电子表格，不用探测。
   * 2. 给了 `appToken` → 可能是多维表格，也可能是 electronic 表格的 wiki 链接。
   *    wiki 形态走 `get_node` 问真实类型；原生 token 先当多维表格试，
   *    失败且是「不是这个类型」那类错就再试一次电子表格（双试，见 §3.3）。
   * 3. 只有 `docNamePattern` → 在云文档里按名字找，两种表型合计恰好 1 张才用。
   *
   * `match.tableKind` 显式配置时**跳过探测**（省请求，也给人一条确定性路径）。
   *
   * 探测结果缓存在 `tableCache` 里，整轮扫描复用；探测失败**不重试**
   * （配置写错了，同一轮里再试一百次也是同样的错）。
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ kind: 'bitable', appToken: string, tableId: string } | { kind: 'sheet', spreadsheetToken: string, sheetId: string, sheetTitle: string }>}
   */
  async function resolveTable (signal) {
    if (tableCache) return tableCache

    // ① 显式指定表型 = 跳过探测。
    if (tableKindOption === 'sheet') {
      tableCache = await resolveSheetTarget(spreadsheetToken || appToken, signal)
      return tableCache
    }
    if (tableKindOption === 'bitable') {
      if (!appToken) {
        throw new PipelineError('invalid-input', 'match.tableKind="bitable" 要求同时给 match.appToken（多维表格的 token 或链接）')
      }
      tableCache = await resolveBitableTarget(signal)
      return tableCache
    }

    // ② 显式给了 spreadsheetToken → 电子表格，不探测。
    if (spreadsheetToken) {
      tableCache = await resolveSheetTarget(spreadsheetToken, signal)
      return tableCache
    }

    // ③ 有 appToken：先看是不是 wiki 链接（能问出真实类型），再按类型分派。
    if (appToken && String(appToken).trim().length > 0) {
      if (isWikiToken(appToken)) {
        const node = await probeWikiNode(appToken, signal)
        if (node.note && typeof options.log === 'function') {
          options.log('feishu 表型探测', { sourceId, note: node.note })
        }
        if (node.kind === 'sheet') {
          tableCache = await resolveSheetTarget(node.token, signal)
          return tableCache
        }
        // 多维表格：obj_token 与 wiki token 两个都试 —— 新版 wiki base 的 bitable API
        // 直接吃 wiki token 本身，旧版要 obj_token，从形状上看不出是哪一种。
        // 注意第二个候选要给**裸 token**（从 /wiki/<token> 里抠出来的），
        // 整条 URL 塞进 path 是另一回事，拼出来的接口地址不对。
        const wikiBare = extractWikiToken(appToken)
        const candidates = [node.token]
        if (wikiBare && wikiBare !== node.token) candidates.push(wikiBare)
        tableCache = await resolveBitableFromCandidates(candidates, signal)
        return tableCache
      }

      // 原生 token：先按多维表格试。失败时**只有**「不是这个类型」那类错才值得再试电子表格
      // —— 凭据错 / 限流 / 网络错都是真故障，改成试 sheet 只会把真因埋掉。
      let bitableError = null
      try {
        tableCache = await resolveBitableTarget(signal)
        return tableCache
      } catch (error) {
        bitableError = error
        if (!shouldTrySheet(error)) throw error
      }
      try {
        tableCache = await resolveSheetTarget(appToken, signal)
        return tableCache
      } catch (sheetError) {
        throw new PipelineError(
          'invalid-input',
          `这个 token 既当不了多维表格，也当不了电子表格。\n`
            + `- 按多维表格读：${bitableError instanceof Error ? bitableError.message : String(bitableError)}\n`
            + `- 按电子表格读：${sheetError instanceof Error ? sheetError.message : String(sheetError)}\n`
            + '请在飞书里确认这张表的类型，并把链接填到对应的配置项（多维表格 → match.appToken，电子表格 → match.spreadsheetToken）。',
        )
      }
    }

    // ④ 只有 docNamePattern：按名字在云文档里找，两种表型合计恰好 1 张。
    if (!docNamePattern) {
      throw new PipelineError(
        'invalid-input',
        '飞书项目没法定位工单表：至少要给 match.appToken（多维表格）、match.spreadsheetToken（电子表格）或 match.docNamePattern（按文件名匹配）之一',
      )
    }

    const docs = await searchCloudDocs(docNamePattern, signal)
    if (docs.length !== 1) {
      throw new PipelineError(
        'invalid-input',
        `按 "${docNamePattern}" 匹配到 ${docs.length} 张工单表（多维表格 + 电子表格合计），需要恰好 1 张。`
          + `候选：${docs.map((doc) => `${doc.name}（${doc.type}）`).join('、') || '（无）'}`,
      )
    }
    const doc = docs[0]
    if (doc.type === 'sheet') {
      tableCache = await resolveSheetTarget(doc.token, signal)
      return tableCache
    }
    // pattern 已经用来挑文档了，别再拿它过滤数据表名。
    tableCache = await resolveBitableTableByIdentity(doc.token, signal, false)
    return tableCache
  }

  /**
   * 逐个候选 token 试「列出数据表」：第一个能列出来的胜出。
   *
   * 为什么要多候选：wiki 里的多维表格有两种形态 —— 旧版要换算成 `obj_token`，
   * 新版 bitable API 直接吃 wiki token 本身。我们没法从 token 形状判断是哪一种，
   * 所以两个都试（`normalizeAppToken` 负责排优先级）。
   *
   * @param {string[]} candidates
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ kind: 'bitable', appToken: string, tableId: string }>}
   */
  async function resolveBitableFromCandidates (candidates, signal) {
    let lastError = null
    const attempts = []
    for (const candidate of candidates) {
      try {
        return await resolveBitableTableByIdentity(candidate, signal)
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

  /**
   * 走多维表格的定位路径（appToken 可能是 wiki 链接）。
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ kind: 'bitable', appToken: string, tableId: string }>}
   */
  async function resolveBitableTarget (signal) {
    const candidates = await normalizeAppToken(signal)
    return resolveBitableFromCandidates(candidates, signal)
  }

  /**
   * 已知这是一个多维表格的确定 token：有 tableId 直接绑定，否则在多张数据表里挑唯一一张。
   *
   * `usePattern` 区分两种来源（这个区别是历史行为，别随手统一）：
   * - 由 `appToken` 进来时（true）：`docNamePattern` 是拿来**过滤数据表名**的 ——
   *   用户可能一张多维表格里放了好几张数据表，按表名挑。
   * - 由 `docNamePattern` 搜云文档进来时（false）：那个 pattern 已经用来挑**文档**了，
   *   再拿它过滤数据表名等于要求文档名和表名同时匹配，会挑不到（历史上就是这样）。
   *
   * @param {string} resolvedAppToken
   * @param {AbortSignal} [signal]
   * @param {boolean} [usePattern]
   * @returns {Promise<{ kind: 'bitable', appToken: string, tableId: string }>}
   */
  async function resolveBitableTableByIdentity (resolvedAppToken, signal, usePattern = true) {
    if (tableId) return { kind: 'bitable', appToken: resolvedAppToken, tableId }
    const payload = await apiCall(`/open-apis/bitable/v1/apps/${resolvedAppToken}/tables`, { query: { page_size: 100 }, signal })
    const items = Array.isArray(payload?.data?.items) ? payload.data.items : []
    const matched = usePattern && docNamePattern
      ? items.filter((item) => matchesPattern(String(item?.name ?? ''), docNamePattern))
      : items
    if (matched.length !== 1) {
      const error = /** @type {any} */ (new PipelineError(
        'invalid-input',
        `多维表格 ${resolvedAppToken} 里按 "${docNamePattern || '（未指定表名）'}" 匹配到 ${matched.length} 张表，需要恰好 1 张（或者在 match.tableId 里指定）。`
          + `现有表：${items.map((item) => String(item?.name ?? '?')).join('、') || '（空）'}`,
      ))
      // 关键：这里**已经成功列出数据表了**，说明这个 token 就是一个多维表格，
      // 只是表名没对上。给错误打个标记，让 resolveTable 不要去试电子表格 ——
      // 否则人写错表名时会收到「既当不了多维表格也当不了电子表格」这种把真因埋掉的文案。
      //
      // 注意赋值写成单独一行、且别用 `/** @type {any} */ (error).x = y` 那种写法：
      // 那样这一行以 `(` 开头，会被 ASI 当成上一行表达式的延续
      // （`new PipelineError(...)(error)`），于是 `error` 在 TDZ 里被读 → ReferenceError。
      error.confirmedBitable = true
      throw error
    }
    return { kind: 'bitable', appToken: resolvedAppToken, tableId: String(matched[0].table_id) }
  }
  // 保留旧名字给上面 resolveBitableTarget 用（同一实现，避免两处逻辑漂移）。
  const resolveTableWithAppToken = resolveBitableTableByIdentity

  /**
   * 读这张多维表格的**真实字段名**，把语义字段映到表里那个名字上（工单 #21）。
   *
   * 为什么非要多打一次 `fields` 接口：
   * 以前列名是硬编码常量，表里叫「缺陷描述」「处理状态」时 `fields['问题描述']`
   * 取不到值 ⇒ 描述为空 ⇒ 整张表**静默扫出 0 张票**，既不报错也不提示。
   * 猜名字是不可能的（字段名是表级的、用户随便起），所以只能问一次平台。
   *
   * 一次扫描打一次，缓存整轮复用；回填走同一份缓存，保证「读哪列」与「写哪列」一致。
   *
   * @param {{ kind: string, appToken: string, tableId: string }} table
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ columns: Record<string, string>, names: Record<string, string>, missing: string[] }>}
   */
  async function resolveBitableColumns (table, signal) {
    if (columnCache) return columnCache
    if (columnInflight) return columnInflight

    columnInflight = (async () => {
      /** @type {string[]} */
      const names = []
      let pageToken = ''
      // 翻页上限 50 页（每页 100 个字段 = 5000 列）。防坏数据把循环拖死，
      // 也和 `records/search` 那个 200 页的守卫保持同一种写法。
      for (let guard = 0; guard < 50; guard += 1) {
        if (signal?.aborted) throw new PipelineError('aborted', '扫描被取消')
        const payload = await apiCall(
          `/open-apis/bitable/v1/apps/${table.appToken}/tables/${table.tableId}/fields`,
          { query: { page_size: 100, page_token: pageToken || undefined }, signal },
        )
        const data = payload?.data ?? {}
        for (const item of Array.isArray(data.items) ? data.items : []) {
          const name = String(item?.field_name ?? '').trim()
          if (name.length > 0) names.push(name)
        }
        if (data.has_more !== true) break
        pageToken = String(data.page_token ?? '')
        if (pageToken === '') break
      }

      const mapped = mapColumns({ actualNames: names, overrides: bitableColumns, aliases: BITABLE_COLUMN_ALIASES })

      if (mapped.missing.length > 0) {
        // 必需列对不上**必须当场报错**：继续扫下去只会得到「0 张票」，而人会以为
        // 是没配置好开关或者表里没数据 —— 最费时间的一种失败（工单 #21）。
        const wanted = mapped.missing
          .map((field) => `${field === 'description' ? '描述' : '状态'}（${(BITABLE_COLUMN_ALIASES[field] ?? []).slice(0, 3).join(' / ')}）`)
          .join('、')
        throw new PipelineError(
          'invalid-input',
          `这张多维表格里找不到 ${wanted} 这两列中的某一列，收不了票。`
            + `表里实际的字段名：${names.join(' / ') || '（一个都没有）'}。`
            + '两种改法：① 把字段名改成上面括号里的任一种；'
            + '② 在配置 match.columns 里写明实际叫法，例如 {"description":"我的描述列"}（不用改表）。',
        )
      }

      // 非必需列缺失只记一条日志：少了「优先级」「截图」不该让整轮扫描失败，
      // 那些字段本来就有缺省处理（优先级空 = 不排优先级）。
      const optionalMissing = Object.keys(BITABLE_COLUMN_ALIASES)
        .filter((field) => mapped.columns[field] === undefined && field !== 'description' && field !== 'status')
      if (optionalMissing.length > 0 && typeof options.log === 'function') {
        options.log('多维表格列名映射：这些列没找到，按空值处理', {
          sourceId,
          missing: optionalMissing,
          actual: names,
        })
      }

      const mappedNames = mapped.names
      // `columns` 对外用**表里的真实名字**：所有拼 `fields[...]` 的地方都读它。
      // 没映射上的字段退回规范名 —— 让「读不到」表现为空值，而不是 `undefined` 键名。
      /** @type {Record<string, string>} */
      const columns = { ...BITABLE_CANONICAL_COLUMNS }
      for (const [field, name] of Object.entries(mappedNames)) columns[field] = name

      columnCache = { columns, names: mappedNames, missing: mapped.missing }
      return columnCache
    })()

    try {
      return await columnInflight
    } finally {
      columnInflight = null
    }
  }

  /**
   * 当前生效的列名：还没解析过时就是规范名。
   *
   * 为什么要有这个函数而不是直接用 `columnCache`：`pickMtime` 这类工具在
   * 「拿到字段列表之前」也可能被调用（比如自测直接调 buildTicket），
   * 那时候用规范名是唯一安全的猜测，且与缺省表结构完全一致。
   *
   * @returns {Record<string, string>}
   */
  function activeColumns () {
    return columnCache?.columns ?? BITABLE_CANONICAL_COLUMNS
  }

  /**
   * 把一行记录组装成内部 Ticket。
   * @param {any} item
   * @param {string} recordId
   * @returns {import('../../contracts/types.js').Ticket}
   */
  function buildTicket (item, recordId) {
    const fields = item?.fields ?? {}
    // 一律走 `cols`（= 映射后的真实字段名），不要再直接读 `FEISHU_COLUMNS`：
    // 那是**规范名**，只在表结构完全按文档建的时候才对得上（工单 #21）。
    const cols = activeColumns()
    const priorityText = normalizeCellText(fields[cols.priority]).toLowerCase()
    const priority = PRIORITY_MAP.get(priorityText)
    return makeTicket({
      recordId,
      projectId,
      description: normalizeCellText(fields[cols.description]),
      module: normalizeCellText(fields[cols.module]),
      flow: normalizeCellText(fields[cols.flow]),
      priority: priority === 'high' || priority === 'medium' || priority === 'low' ? priority : undefined,
      department: normalizeCellText(fields[cols.department]),
      foundAt: normalizeDateCell(fields[cols.foundAt]),
      seq: normalizeCellText(fields[cols.seq]),
      status: normalizeCellText(fields[cols.status]),
      screenshots: extractScreenshots(fields[cols.screenshot]),
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
      fields[activeColumns().lastModified],
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
   * 表型分派在这里收口：`resolveTable()` 告诉我们这是一张多维表格还是电子表格，
   * 两种表型各自把「这一轮看到了哪些行、哪些是新的、哪些变了」填进同一个账本，
   * 退役/水位这些跟表型无关的逻辑留在下面统一做 —— 免得两边各写一份再慢慢漂移。
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

    /** @type {{ seen: typeof seen, live: typeof live, created: typeof created, updated: typeof updated, disappeared: typeof disappeared }} */
    const book = { seen, live, created, updated, disappeared }

    // 电子表格没有行级 mtime，也没有分页，一次读全表 —— 所以它不存在「早停」。
    // stopped 只有多维表格那条路会置 true（连续 N 行没变化就停），下面据此决定要不要推进 missingScans。
    let stopped = false
    if (table.kind === 'sheet') {
      await scanSheet(table, book, signal)
    } else {
      stopped = await scanBitable(table, book, signal)
    }

    // 没出现在这一轮里的行：连续 goneAfterScans 轮才算删了。
    //
    // 但只有**完整扫完**这一轮才允许推进 missingScans：多维表格的翻页循环会因连续 safePageRun 条
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
   * 多维表格这条路：翻页 + 按 mtime 早停。
   *
   * @param {{ kind: 'bitable', appToken: string, tableId: string }} table
   * @param {{ seen: any, live: Set<string>, created: any[], updated: any[] }} book
   * @param {AbortSignal} [signal]
   * @returns {Promise<boolean>} 是否因为早停而中断（true = 后面还有页没看，别判定退役）
   */
  async function scanBitable (table, book, signal) {
    const { seen, live, created, updated, disappeared } = book
    let safePageRun = 0
    let pageToken = ''
    let stopped = false

    // 先问一次平台「这张表里的字段到底叫什么」（工单 #21）。
    // 放在循环外：一整轮只打一次；放在这里而不是 resolveTable：只有多维表格才需要，
    // 电子表格走的是表头行探测（`locateSheetHeader`），不该被这条多打一次。
    await resolveBitableColumns(table, signal)

    for (let guard = 0; guard < 200 && !stopped; guard += 1) {
      if (signal?.aborted) throw new PipelineError('aborted', '扫描被取消')

      /** @type {Record<string, unknown>} */
      const body = {
        page_size: RECORD_PAGE_SIZE,
        automatic_fields: true,
        sort: [{ field_name: activeColumns().lastModified, desc: true }],
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
        const status = normalizeCellText(fields[activeColumns().status])
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

    return stopped
  }

  /**
   * 电子表格这条路：一次读全表，逐行比对指纹。
   *
   * 与多维表格的三处关键差异（设计 §5.5）：
   * 1. **没有行级 mtime** —— 水位里 mtime 恒 0，变更判定完全靠内容指纹。
   * 2. **没有分页** —— 读值接口不给 has_more/page_token，一次拿回来就是全部。
   * 3. **不早停** —— 既然本来就是整表读回来，早停省不到请求，反而会让「后面那批行」漏判。
   *
   * 已知代价（写进设计 §5.5）：变更判定只看指纹，所以「被人动过但内容没变」察觉不到。
   *
   * @param {{ kind: 'sheet', spreadsheetToken: string, sheetId: string, sheetTitle?: string }} table
   * @param {{ seen: any, live: Set<string>, created: any[], updated: any[] }} book
   * @param {AbortSignal} [signal]
   */
  /**
   * 读一遍电子表格的裸值 + 表头 + 行。
   *
   * 扫描（`scanSheet`）和回填（`writeSheetResult`，工单 #22）都必须走这一个函数：
   * 两处各读一份、各认一次列，就会出现「按 A 列认、往 B 列写」这种对不上却看起来
   * 都对的错位 —— 而电子表格回填正是靠「列位置」写值的，错一列就是写到别人格子里。
   *
   * @param {{ kind: 'sheet', spreadsheetToken: string, sheetId: string }} table
   * @param {AbortSignal} [signal]
   */
  async function readSheetValues (table, signal) {
    // 读值接口的 range 是 **URL path 的一段**，形状 `{sheetId}!A1:M500`。
    // `!` 与 `:` 必须保持原样（整段编码了飞书不认），只有 sheetId 自身需要编码 ——
    // sheetId 里绝不会出现 `!` 或 `:`，所以分开拼是安全的。
    // 不给 sheetRange 时从表头行读到 Z 列末尾（开放式写法，行号省略 = 到表尾）。
    const range = sheetRange ?? { startColumn: 0, startRow: sheetHeaderRow }
    const valuesPath = `${encodeURIComponent(table.sheetId)}!${buildValueRange({ range, endColumn: 25 })}`
    const payload = await apiCall(
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(table.spreadsheetToken)}/values/${valuesPath}`,
      { method: 'GET', signal },
    )

    const values = Array.isArray(payload?.data?.valueRange?.values) ? payload.data.valueRange.values : []
    const header = locateSheetHeader(values, { headerRow: sheetHeaderRow, columns: sheetColumns })
    const rows = parseSheetRows({
      values,
      header,
      identity: sheetIdentity,
      idColumn: sheetIdColumn,
      extractScreenshots,
    })
    return { values, header, rows }
  }

  /**
   * 电子表格回填（工单 #22）：把「是否处理 / 处理结果 / 处理日期」写回那一行。
   *
   * 与多维表格的差别只有一条，但它决定了整个写法：电子表格**没有 record_id**，
   * 只有「第几行」。而行号会漂移 —— 人在上面插一行，所有票都往下挪一格。
   * 所以：
   *
   * 1. **每次都重新读表定位，缓存任何行号都是错的**（这一票能花几十分钟，
   *    期间人插一行的概率不低）。
   * 2. 定位靠**身份列的值**（`sh-seq-<序号>` / `sh-row-<行号>`），
   *    和扫描用的是同一套 `parseSheetRows`，不会算两遍。
   * 3. 认列靠 `locateSheetHeader`，和扫描共用同一份别名映射（工单 #21 收口的那份）。
   *
   * 写值用 `values_batch_update` 一次提交三格：三列在表里未必相邻，
   * 逐格 PUT 会变成三个请求、且中间失败会留下「写了一半」的表。
   *
   * @param {{ kind: 'sheet', spreadsheetToken: string, sheetId: string }} table
   * @param {string} recordId
   * @param {{ onlyResult: boolean, status: string, handledAt: number, result: object }} input
   * @param {AbortSignal} [signal]
   * @returns {Promise<import('../../contracts/ticket-source.js').WriteBackReceipt>}
   */
  async function writeSheetResult (table, recordId, input, signal) {
    const { onlyResult, status, handledAt, result } = input

    const { header, rows } = await readSheetValues(table, signal)
    const target = rows.find((row) => row.recordId === recordId)
    if (!target) {
      // 行被删了 / 序号被改了。这不是「再试一次就好」：not-found 在 errors.js 里
      // 属于不可重试，标对分档，免得调度器每次启动都对着同一张表再撞一遍（#08）。
      return {
        written: false,
        retryable: false,
        errorKind: 'not-found',
        note: `这张电子表格里已经找不到「${recordId}」那一行了（可能被删掉，或序号列被改过）。`
          + '本次不回填，票本身已处理完。要留痕就手工在表里补一行，或者把这张票 recordId 记下来另存。',
      }
    }

    // 要写哪几列：失败票只写「处理结果」（工单 #14），成功票写三列。
    const fields = onlyResult ? ['result'] : ['status', 'result', 'handledAt']
    const missing = fields.filter((field) => header.columns[field] === undefined)
    if (missing.length > 0) {
      const names = missing
        .map((field) => (field === 'status' ? '“是否处理”' : field === 'result' ? '“处理结果”' : '“处理日期”'))
        .join('、')
      return {
        written: false,
        retryable: false,
        errorKind: 'unsupported',
        note: `这张电子表格的表头里没有${names}列，本次不回填（票本身已处理完）。`
          + `表里实际的列名：${header.headers.join(' / ') || '（空）'}。请把列名改成上面这些，`
          + '或用 match.sheetColumns 指明实际叫法，或把 writeBack 关掉退化成只读。',
      }
    }

    // 处理日期写成人能读的日期文本，而不是毫秒时间戳：
    // 日期格式的单元格，飞书两种都收；文本格式的单元格只会把 1735689600000
    // 原样显示成一串数字。写文本在任何一种情况下都不难看。
    const cellOf = {
      status,
      result: result.result,
      handledAt: normalizeSheetDate(handledAt),
    }

    const valueRanges = fields.map((field) => {
      const letter = columnLetter(header.columns[field])
      const rowNumber = target.rowNumber
      return {
        range: `${table.sheetId}!${letter}${rowNumber}:${letter}${rowNumber}`,
        values: [[cellOf[field]]],
      }
    })

    try {
      await apiCall(
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(table.spreadsheetToken)}/values_batch_update`,
        { method: 'POST', body: { valueRanges }, signal },
      )
    } catch (error) {
      // 只读权限是最容易踩的一脚：读票只要 `sheets:spreadsheet:readonly`，
      // 写值要 `sheets:spreadsheet`（读写）。少这一档时读得好好的、一到回填就报错，
      // 而且报错码跟「没权限」混在一起，不说清楚没人能想到是权限档位的问题。
      if (error instanceof PipelineError && error.kind === 'auth') {
        return {
          written: false,
          retryable: false,
          errorKind: 'auth',
          note: '写入被飞书拒绝了：应用对这张电子表格只有读权限。'
            + '去开放平台 →「权限管理」→ 把「电子表格」的权限从只读（sheets:spreadsheet:readonly）'
            + '改成读写（sheets:spreadsheet）→ **创建版本并发布**（不发布版本，权限不生效）→ '
            + '再确认表里把应用加成了「可编辑」协作者。'
            + `飞书原话：${error.message}`,
        }
      }
      throw error
    }

    return { written: true, fields: fields.map((field) => header.headers[header.columns[field]] ?? field) }
  }

  async function scanSheet (table, book, signal) {
    const { seen, live, created, updated, disappeared } = book

    const { values, header, rows } = await readSheetValues(table, signal)
    if (values.length === 0 && typeof options.log === 'function') {
      options.log('feishu 电子表格读回空表', { sourceId, sheetId: table.sheetId })
    }

    for (const row of rows) {
      const recordId = row.recordId
      if (!recordId) continue
      if (!recordFilter.allows(recordId)) continue
      live.add(recordId)

      const cells = row.cells
      const status = normalizeCellText(cells.status)
      const inProgress = statusValues.includes(status)
      const ticket = makeTicket({
        recordId,
        projectId,
        description: normalizeCellText(cells.description),
        module: normalizeCellText(cells.module),
        flow: normalizeCellText(cells.flow),
        priority: sheetPriorityOf(cells.priority),
        department: normalizeCellText(cells.department),
        foundAt: normalizeSheetDate(cells.foundAt),
        seq: normalizeCellText(cells.seq),
        status,
        screenshots: row.screenshots,
        // mtime 恒 0：电子表格没有行级最后修改时间。写 0 而不是 now()，
        // 免得每轮都像是「刚改过」，把水位里的时间戳变成噪音。
        raw: { sheetId: table.sheetId, rowNumber: row.rowNumber, identitySource: row.identitySource, mtime: 0 },
      })
      const prev = seen[recordId]

      if (!prev) {
        seen[recordId] = { mtime: 0, fingerprint: ticket.fingerprint, missingScans: 0, tracked: inProgress }
        if (inProgress) created.push(ticket)
        continue
      }

      prev.missingScans = 0
      const contentChanged = ticket.fingerprint !== prev.fingerprint

      if (!inProgress) {
        if (prev.tracked) {
          prev.tracked = false
          if (!disappeared.includes(recordId)) disappeared.push(recordId)
        }
        continue
      }

      if (!prev.tracked) {
        // 手动重置：把「是否处理」从别的值拨回「处理中」，要重新处理。
        prev.tracked = true
        created.push(ticket)
        continue
      }

      if (contentChanged) {
        updated.push(ticket)
        prev.fingerprint = ticket.fingerprint
      }
    }
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

  /**
   * 把一张工单的处理结果回填到表格里（**本文件唯一的写操作**）。
   *
   * 分工写死在契约里（`contracts/ticket-source.js` 的 `WriteBackResult`）：
   * - `是否处理` ← `status`（缺省 `是`；有的表用「已完成」，由调用方传，适配器不改词）
   * - `处理结果` ← `result`（「怎么处理的」一段人话）
   * - `处理日期` ← `handledAt`（毫秒时间戳；飞书的日期字段就吃这个数字，不用格式化成字符串）
   *
   * 为什么用 PUT `records/{recordId}` 而不是 `records/batch_update`：一次只回填一张票，
   * 批量接口要额外拼 record_id 数组和权限，反而更容易错；单条 PUT 也是飞书文档里
   * 语义最直白的那一个（整条记录按字段名合并更新）。
   *
   * 错误处理的边界（重要）：
   * - **网络 / 鉴权 / 限流等真故障一律抛出**，让 `apiCall` 的 `PipelineError` 一路上去。
   *   调度器会兜住它并只记日志 —— 票态已经定了（done / skipped），回填失败不该反悔。
   *   吞掉异常会让「表格压根没更新」这件事无声无息，人对着没回填的表以为插件没跑。
   * - **表里没有那几列**不是故障，是配置不匹配：返回 `{ written: false }` 并在 `note`
   *   里说清楚缺哪一列。让一张已经处理完的票因为「表少一列」判失败，是本末倒置。
   *
   * @param {string} recordId
   * @param {import('../../contracts/ticket-source.js').WriteBackResult} result
   * @param {AbortSignal} [signal]
   * @returns {Promise<import('../../contracts/ticket-source.js').WriteBackReceipt>}
   */
  async function writeResult (recordId, result, signal) {
    if (signal?.aborted) throw new PipelineError('aborted', '回填被取消')

    const id = String(recordId ?? '').trim()
    if (!id) throw new PipelineError('invalid-input', '回填缺 recordId，无法定位要写哪一行')

    if (!result || typeof result !== 'object') {
      throw new PipelineError('invalid-input', '回填内容必须是对象 { status?, result, handledAt? }')
    }
    if (typeof result.result !== 'string') {
      throw new PipelineError('invalid-input', '回填内容缺 result（「处理结果」要写什么）')
    }

    // 缺省值在这里落一次，别让调用方各自拼：契约说「status 缺省 是、handledAt 缺省当前时间」。
    const onlyResult = result.onlyResult === true
    const status = typeof result.status === 'string' && result.status.trim().length > 0
      ? result.status.trim()
      : '是'
    // 处理日期：飞书日期字段接受毫秒时间戳数字，直接传数字，传格式化字符串反而要按表时区猜。
    const handledAt = result.handledAt === undefined ? now() : Number(result.handledAt)
    // onlyResult 时**不校验日期**：失败票本来就不写日期那一列，调用方也不必给。
    if (!onlyResult && (!Number.isFinite(handledAt) || handledAt <= 0)) {
      throw new PipelineError('invalid-input', `回填的处理日期不是合法毫秒时间戳：${String(result.handledAt)}`)
    }

    const table = await resolveTable(signal)

    // 电子表格回填（工单 #22）：走自己的那一套。
    // 多维表格是按 `record_id` PUT 一条记录，电子表格没有 record_id 这层概念 ——
    // 它只有「第几行第几列」，而**行号会漂移**（人在上面插一行，所有票都往下挪一格）。
    // 所以这里不复用多维表格那段代码，而是重新读一遍表、按身份列重新定位目标行。
    if (table.kind === 'sheet') {
      return writeSheetResult(table, id, { onlyResult, status, handledAt, result }, signal)
    }

    // 失败票回填（工单 #14）：只写「处理结果」这一列。
    // 为什么不写另外两列：「是否处理」写成「是」会让人以为处理完了，可这票根本没成；
    // 「处理日期」在飞书里叫「处理日期」，语义是「处理完的那天」，没完就不该有值。
    //
    // 列名走 `activeColumns()`（工单 #21）：**必须与扫描时那份映射是同一份**，
    // 否则读「缺陷描述」、写「问题描述」，看起来都对，实际错位。
    // 这里不依赖 scan 先跑过 —— 直接 `resolveBitableColumns` 拿缓存（同一轮只会打一次接口）。
    await resolveBitableColumns(table, signal)
    const cols = activeColumns()
    const fields = onlyResult
      ? { [cols.result]: result.result }
      : {
          [cols.status]: status,
          [cols.result]: result.result,
          [cols.handledAt]: handledAt,
        }
    const written = Object.keys(fields)

    try {
      await apiCall(
        `/open-apis/bitable/v1/apps/${table.appToken}/tables/${table.tableId}/records/${encodeURIComponent(id)}`,
        { method: 'PUT', body: { fields }, signal },
      )
    } catch (error) {
      // 只有「表里没这几列」退化成只读回执；其余（网络 / 鉴权 / 限流 / 参数）照样抛。
      if (isFieldMissingError(error)) {
        const wanted = onlyResult
          ? `「${cols.result}」这一列`
          : `「${cols.status} / ${cols.result} / ${cols.handledAt}」这几列`
        return {
          written: false,
          retryable: false,
          errorKind: 'unsupported',
          note: `工单表里没有${wanted}，本次不回填（票本身已处理完）。`
            + `请确认表结构，或关掉 writeBack 退化成只读：${error instanceof Error ? error.message : String(error)}`,
        }
      }
      // 同步表（数据由连接器同步进来的多维表格）结构上不接受直接写记录：
      // 这和「少一列」一样是配置问题，不是故障，也不该被当成可重试错误反复重试。
      if (isSyncTableForbiddenError(error)) {
        return {
          written: false,
          retryable: false,
          errorKind: 'unsupported',
          note: '这张多维表格是「同步表」，数据由连接器（飞书集成/其他系统）同步进来，'
            + '飞书不允许直接改里面的行，所以处理结果回填不进去（票本身已处理完）。'
            + '要么在原系统里看结果，要么把 writeBack 关掉（设置页「回填工单表」→ writeBack=false），'
            + '要么换成一张自己建的、非同步的多维表格来收工单。'
            + `飞书原话：${error instanceof Error ? error.message : String(error)}`,
        }
      }
      throw error
    }

    return { written: true, fields: written }
  }

  return assertTicketSource({
    id: sourceId,
    projectId,
    scan,
    loadScreenshot,
    writeResult,
  })
}

/**
 * 从一条飞书多维表格 URL 里啃出 `table` / `view` 两个问号参数。
 *
 * 实现在 `contracts/types.js` —— 配置校验（`validateConfig`）和本适配器必须用
 * 同一套判断，否则用户在配置里只贴一条链接会被校验器拦下，而文档却写着「贴链接就够」。
 * 这里重新导出，是为了让「啃 URL」这件事在适配器侧读起来是本地能力。
 *
 * @param {unknown} raw 用户填的 `match.appToken` 原值
 * @returns {{ tableId: string, viewId: string }}
 */
export { parseBitableUrl }

/**
 * 从项目条目的 `match` 里摘出本适配器用得到的值。
 * @param {any} match 项目条目的 `match` 字段
 * @returns {{ appToken: string, tableId: string, viewId: string, docNamePattern: string, statusValues?: string[], recordIds?: string[] }}
 */
export function feishuOptionsFromMatch (match) {
  const m = match ?? {}
  const rawAppToken = String(m.appToken ?? '')
  // appToken 写成整条表格 URL 时，把 URL 里的 table / view 也一并啃出来。
  // 用户从浏览器地址栏直接复制粘贴是最自然的动作，而那条 URL 里本来就带着
  // `?table=tblXXX&view=vewYYY` —— 只要这两个问号参数，就能省掉「再去哪儿找 table_id」
  // 这一步。显式写了 tableId / viewId 的，以显式值为准（别让 URL 覆盖人的明确意图）。
  const fromUrl = parseBitableUrl(rawAppToken)
  /** @type {Record<string, unknown>} */
  const options = {
    appToken: rawAppToken,
    tableId: String(m.tableId ?? '') || fromUrl.tableId,
    viewId: String(m.viewId ?? '') || fromUrl.viewId,
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

  // 电子表格那一套（设计 §4.2）：同样按「写了才透传」的规矩来。
  // 一条原则：**配置层校验过的值，适配器层不再重复判**，这里只做形状归一。
  const spreadsheetToken = String(m.spreadsheetToken ?? '').trim()
  if (spreadsheetToken.length > 0) options.spreadsheetToken = spreadsheetToken
  if (typeof m.sheetId === 'string' && m.sheetId.trim().length > 0) options.sheetId = m.sheetId.trim()
  // sheetName 与金山源同名同义，配置层已经透传过一次；这里再显式取一遍，
  // 是因为 `createFeishuSource` 的 options 与 `match` 是两套字段名，不能靠「恰好同名」蒙。
  if (typeof m.sheetName === 'string' && m.sheetName.trim().length > 0) options.sheetName = m.sheetName.trim()
  if (typeof m.sheetIdColumn === 'string' && m.sheetIdColumn.trim().length > 0) options.sheetIdColumn = m.sheetIdColumn.trim()
  if (typeof m.sheetRange === 'string' && m.sheetRange.trim().length > 0) options.sheetRange = m.sheetRange.trim()
  if (typeof m.tableKind === 'string' && m.tableKind.trim().length > 0) options.tableKind = m.tableKind.trim()
  if (m.sheetHeaderRow !== undefined && m.sheetHeaderRow !== null && m.sheetHeaderRow !== '') {
    const row = Number(m.sheetHeaderRow)
    if (Number.isInteger(row) && row >= 1) options.sheetHeaderRow = row
  }
  if (typeof m.sheetIdentity === 'string' && (m.sheetIdentity === 'seq' || m.sheetIdentity === 'row')) {
    options.sheetIdentity = m.sheetIdentity
  }
  if (m.sheetColumns && typeof m.sheetColumns === 'object' && !Array.isArray(m.sheetColumns)) {
    options.sheetColumns = m.sheetColumns
  }
  // 多维表格的列名覆盖（工单 #21）。和 `sheetColumns` 分成两个键只是为了让校验能给出
  // 不同的字段白名单提示，实际用法一模一样：写「语义字段 → 表里那个名字」。
  if (m.columns && typeof m.columns === 'object' && !Array.isArray(m.columns)) {
    options.columns = m.columns
  }

  return /** @type {any} */ (options)
}
