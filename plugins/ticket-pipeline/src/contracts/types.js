/**
 * 公共数据契约：`Ticket` / `ScreenshotRef` / `Phase` / `Plan` 等。
 *
 * 这里只有类型与纯数据工具，**不产生任何副作用**。契约层必须能随便被谁 import。
 * 唯一的外部依赖是 `work-executor.js` 的 `normalizeTestOutcome` —— 它同样是零依赖纯函数，
 * 放在这里是为了让「阶段标签」只有一份实现（调度器渲染通知标题、状态工具渲染票行
 * 用的是同一个函数，不会各说各话）。
 */

import { normalizeTestOutcome } from './work-executor.js'

// ── phase 状态机 ────────────────────────────────────────────

/**
 * @typedef {'pending'|'worktree-ready'|'planning'|'editing'|'testing'
 *   |'mr-opening'|'needs-info'|'done'|'skipped'|'failed'|'gone'} Phase
 */

/** 终态：到了就不再转会非终态。 */
export const TERMINAL = Object.freeze(['done', 'skipped', 'failed', 'gone'])

/** 非终态 = 后台任务可能还没做完，重启后要接着走。 */
export const ACTIVE = Object.freeze([
  'pending',
  'worktree-ready',
  'planning',
  'editing',
  'testing',
  'mr-opening',
  'needs-info',
])

/** phase → 中文短语，只用于通知与日志。 */
export const PHASE_LABEL = Object.freeze({
  'pending': '排队中',
  'worktree-ready': '工作区已就绪',
  'planning': '分析中',
  'editing': '修改中',
  'testing': '验证中',
  'mr-opening': '正在本地提交',
  'needs-info': '等你补充信息',
  'done': '已完成',
  'skipped': '已交付，待人工验证',
  'failed': '失败',
  'gone': '表格里已删除',
})

/**
 * 带行上下文的阶段标签：**done 要分「验过」和「没验过」**。
 *
 * 为什么不能只改 `PHASE_LABEL`：那张字典只认识 phase，看不到这一票的
 * `testOutcome`，而「已完成（已验证）」和「已完成（未跑验证）」是两个完全不同的
 * 收尾 —— 前者人可以直接合，后者必须自己验一遍。混成一个「已完成」，
 * 没配验证命令的项目会以为自己全绿。
 *
 * 只有一份实现（通知标题与状态工具都用它），否则同一个 phase 在两处会显示成两种说法。
 *
 * 老数据里 `testOutcome === 'skipped'` 与 `not-run` 同义，走 `normalizeTestOutcome` 归一。
 *
 * @param {{ phase?: string, testOutcome?: string }} [row]
 * @returns {string}
 */
export function phaseLabel (row) {
  const phase = row?.phase
  if (phase !== 'done') {
    if (phase === undefined) return '未知'
    return PHASE_LABEL[phase] ?? String(phase)
  }
  const outcome = normalizeTestOutcome(row?.testOutcome)
  if (outcome === 'passed') return '已完成（已验证）'
  if (outcome === 'not-run') return '已完成（未跑验证）'
  // 老数据可能没有 testOutcome（升级前收尾的票）：不猜，仍报「已完成」，
  // 但要能看出它是「不知道验没验」而不是「验过了」。
  return '已完成'
}

/**
 * 关键节点流程日志（时间线）的节点表。
 *
 * 用户原话（2026-11-06）：「从获取到工单-查找对应工单的项目-检查是否存在工作区-创建会话
 * 选择分支和模型-处理工单问题-处理完成后提交PR-并发送消息给我。完整的关键节点的流程日志
 * 不然我不知道哪里有问题了或者卡在哪里了」。
 *
 * 所以每张票的票据行上挂一条 `timeline` 数组：**每个节点一条记录，带写下时刻 + 成败 +
 * 一句中文补充**。`pipeline_status` 把它排成时间线，末尾直接写「现在停在第 N 站，
 * 已 X 分 Y 秒没动」—— 这就是「卡在哪里」的答案，不用再去翻宿主日志。
 *
 * 节点 id 的约定：**凡是 phase 名，节点 id 就等于 phase 名**（`editing`/`testing`/
 * `mr-opening` 以及所有终态）。`onPhase` 拿到 phase 直接查 `TIMELINE_NODES[phase]`
 * 就能打点，不用再维护一张反查表。其余节点（发现/定位/工作区/会话/回填/通知）不是
 * phase，由调度器与执行器在各自那一刻显式记。
 *
 * `no` 只用于展示（①…⑨ 是主链路，`·` 是补充站点），不参与任何判定；
 * `label` 写进记录里是**自包含**的 —— 渲染时不查这张表也看得懂。
 */
export const TIMELINE_NODES = Object.freeze({
  'discover': { no: '①', label: '获取工单' },
  'locate': { no: '②', label: '查找对应工单的项目' },
  'workspace': { no: '③', label: '检查工作区' },
  'session': { no: '④', label: '创建会话（分支+模型）' },
  'editing': { no: '⑤', label: '处理工单问题' },
  'testing': { no: '⑥', label: '跑验证' },
  'mr-opening': { no: '⑦', label: '提交（本地提交 / PR）' },
  'writeback': { no: '⑧', label: '回填工单表' },
  'notify': { no: '⑨', label: '发送消息' },
  // 补充站点：不是用户点名的主链路，但卡在这些地方同样要看得见
  'worktree-ready': { no: '·', label: '工作区就绪' },
  'planning': { no: '·', label: '规划改动' },
  'pending': { no: '·', label: '排队中' },
  'needs-info': { no: '·', label: '等你补充信息' },
  'done': { no: '·', label: '已完成' },
  'skipped': { no: '·', label: '待人工验证' },
  'failed': { no: '·', label: '失败' },
  'gone': { no: '·', label: '表格里已删除' },
})

/**
 * 时间线里一条记录的形状。
 *
 * `at` 是**这条记录写下的时刻**（epoch 毫秒）。这么定是为了让 `pipeline_status`
 * 只靠一条公式就能回答「卡在哪里」：`现在 − 最后一条的 at` = 「距最后一次动静
 * 过了多久」；相邻两条 `at` 之差 = 「上一站花了多久」。两个数都要，取写下时刻
 * 最省事，也不用在每个节点上分别记开始/结束两次。
 *
 * `ok` 只表示这一站**做成了没有**：`true`=做成了，`false`=没做成（detail 里写原因）。
 * 没有「进行中」这个状态 —— 一条票最后一条记录落在哪个节点，人就停在哪个节点：
 * 票还没到终态却很久没有新记录，就说明卡在那儿了，这正是要暴露的东西。
 *
 * @typedef {Object} TimelineEntry
 * @property {string} node 节点 id（见 TIMELINE_NODES）
 * @property {string} label 节点中文名（自包含，渲染时不查表也看得懂）
 * @property {number} at 这条记录写下的时刻，epoch 毫秒
 * @property {boolean} ok true=做成了 / false=没做成
 * @property {boolean} [heartbeat] true=这是长站点的「还在跑」心跳，不是新站点。
 *   心跳只和上一条心跳合并（不占封顶额度、不吃掉进站那条），
 *   渲染时不单独占一行，只把「多久没动」的计时器往前推。
 * @property {string} [detail] 一句给人看的补充
 */

/**
 * 合法的 phase 转移。所有写入方（`TicketStore.setPhase`）都要过这张表。
 * 表外的转移一律拒绝并记日志 —— 这是「终态不可退回」的执行点。
 */
/**
 * 阶段转移表（架构文档 §7.2）。
 *
 * 除了「往前走」的边，还允许两类**恢复边**（架构文档 §7.6）：
 * - 自环：重新打点（恢复时把票留在原地再走一遍，不改变语义）
 * - 回到 `worktree-ready` / `planning`：工作区丢了重建，或上一轮改到一半要重做
 *
 * 没有这两类边，坏数据恢复就会被静默拒绝，票会永远卡在中间态。
 */
export const PHASE_TRANSITIONS = Object.freeze({
  // 首次入队与修订
  'pending': ['pending', 'worktree-ready', 'needs-info', 'gone', 'failed'],
  'needs-info': ['pending', 'gone', 'failed'],
  'worktree-ready': ['worktree-ready', 'planning', 'pending', 'failed'],
  'planning': ['planning', 'editing', 'worktree-ready', 'pending', 'failed'],
  'editing': ['editing', 'testing', 'planning', 'worktree-ready', 'pending', 'failed'],
  'testing': ['testing', 'mr-opening', 'done', 'skipped', 'planning', 'worktree-ready', 'pending', 'failed'],
  'mr-opening': ['mr-opening', 'done', 'skipped', 'planning', 'worktree-ready', 'pending', 'failed'],
  // 终态只能自转（幂等写入）
  'done': ['done'],
  'skipped': ['skipped'],
  'failed': ['failed', 'pending'], // failed → pending 只允许人工重置（见 §7.2）
  'gone': ['gone'],
})

/**
 * 判定一次转移是否合法。
 * @param {Phase} from
 * @param {Phase} to
 * @returns {boolean}
 */
export function canTransition (from, to) {
  const allowed = PHASE_TRANSITIONS[from]
  return Array.isArray(allowed) && allowed.includes(to)
}

/** @returns {boolean} */
export function isTerminal (phase) {
  return TERMINAL.includes(phase)
}

// ── 截图引用 ────────────────────────────────────────────────

/**
 * @typedef {{ kind: 'attachment', fileToken: string, name?: string, size?: number }
 *   | { kind: 'path', path: string }
 *   | { kind: 'url', url: string }
 *   | { kind: 'unknown', raw: string }} ScreenshotRef
 */

/** DSH 附件层只收这四种。 */
export const IMAGE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * 把一条截图引用规范化成**可复现**的字符串，用于内容指纹。
 *
 * 「可复现」是硬要求：同一张工单任何时候算出来必须一样，否则会凭空产生「修订」。
 * 所以路径要归一（斜杠方向、大小写盘符、去掉尾随分隔符），URL 要去掉片段。
 *
 * @param {ScreenshotRef} ref
 * @returns {string}
 */
export function normalizeScreenshotRef (ref) {
  if (!ref || typeof ref !== 'object') return 'unknown:'
  switch (ref.kind) {
    case 'attachment':
      return `attachment:${ref.fileToken ?? ''}`
    case 'path':
      return `path:${normalizePath(ref.path)}`
    case 'url':
      return `url:${normalizeUrl(ref.url)}`
    default:
      return `unknown:${String(/** @type {any} */ (ref).raw ?? '')}`
  }
}

/**
 * 从一条飞书多维表格 URL 里啃出 `table` / `view` 两个问号参数。
 *
 * 为什么住在 contracts 而不是飞书适配器里：**配置校验也要用同一套判断**。
 * `match.appToken` 允许直接写整条表格链接（从浏览器地址栏复制粘贴最自然），
 * 而那条链接本来就长这样
 * `https://<域>.feishu.cn/base/<appToken>?table=tblXXX&view=vewYYY`。
 * 如果只有适配器认得这个写法、`validateConfig` 不认，用户在配置里只贴一条链接
 * 就会被「feishu 项目必须给 appToken+tableId 或 docNamePattern」拦下 ——
 * 文档说的「贴一条链接就够」也就成了空话。所以两边共用这一个解析。
 *
 * 只认 `table=` 和 `view=` 两个参数；不是 URL（纯 app_token）或解析失败时返回空串，
 * 由调用方回退到原有的「显式 tableId / docNamePattern」路径 —— 这条兜底路径不能坏。
 *
 * @param {unknown} raw 用户填的 `match.appToken` 原值
 * @returns {{ tableId: string, viewId: string }}
 */
export function parseBitableUrl (raw) {
  const empty = { tableId: '', viewId: '' }
  const text = typeof raw === 'string' ? raw.trim() : ''
  // 先挡掉纯 token：没有协议和斜杠就不必进 URL 解析器（也避免 `new URL('Abc123')` 抛错）
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return empty
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return empty
  }
  return {
    tableId: (parsed.searchParams.get('table') ?? '').trim(),
    viewId: (parsed.searchParams.get('view') ?? '').trim(),
  }
}

/** 一条飞书链接能被认成什么。`unknown` 表示「看着像 URL，但认不出是哪张表」。 */
export const FEISHU_LINK_KINDS = Object.freeze(['bitable', 'wiki', 'sheet', 'unknown'])

/**
 * 从浏览器地址栏那条链接里认出「这是哪张表、怎么定位它」。
 *
 * 为什么要有这个函数（而不是复用 `parseBitableUrl`）：`parseBitableUrl` 只啃
 * `?table=` / `?view=` 两个问号参数，**不取路径里那段 token** —— 它的用途是
 * 「用户把整条链接写进 `match.appToken` 时，tableId 从链接里补出来」。而这里要做的
 * 是反过来的事：从链接里取出 **app_token 本身**，好让面板「粘贴链接」这条路不用
 * 让人去找这个只能手改 YAML 的键。
 *
 * 认得四种形态（`feishu.cn` / `larksuite.com` 都算，域名不校验 —— 自建代理很常见）：
 *
 * - `/base/<appToken>?table=tblX&view=vewY` → 多维表格（`kind: 'bitable'`）
 * - `/wiki/<nodeToken>?table=...`          → wiki 节点，表型要到运行时问接口（`kind: 'wiki'`）
 * - `/sheets/<spreadsheetToken>?sheet=shX` → 电子表格（`kind: 'sheet'`）
 * - 其它                                    → `kind: 'unknown'`，调用方必须报错而不是静默放过
 *
 * 也接受**裸 token**：形如 `bascnXXXX` / `shtcnXXXX` 这种没有协议头的串，按前缀猜表型。
 * 这条不是便利，是安全阀：很多人手上只有 token（从别人那儿贴过来的），
 * 让他必须先拼一条假链接才能用面板，等于把人推回手改 YAML。
 *
 * 纯函数、零依赖 —— 宿主与浏览器两侧共用同一份判断，免得出现
 * 「面板说这是多维表格、宿主说是电子表格」这种事。
 *
 * @param {unknown} raw 用户粘贴的整条链接，或裸 token
 * @returns {{ kind: 'bitable'|'wiki'|'sheet'|'unknown', appToken: string, spreadsheetToken: string, tableId: string, viewId: string, sheetId: string, path: string }}
 */
export function parseFeishuLink (raw) {
  /** @type {{ kind: 'bitable'|'wiki'|'sheet'|'unknown', appToken: string, spreadsheetToken: string, tableId: string, viewId: string, sheetId: string, path: string }} */
  const empty = { kind: 'unknown', appToken: '', spreadsheetToken: '', tableId: '', viewId: '', sheetId: '', path: '' }
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text.length === 0) return empty

  // 裸 token：没有 `://` 就按前缀猜（`shtcn` 是电子表格，其余当多维表格/wiki）。
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    if (/^shtcn/i.test(text)) return { ...empty, kind: 'sheet', spreadsheetToken: text, path: text }
    if (/^[A-Za-z0-9_-]{8,}$/.test(text)) return { ...empty, kind: 'bitable', appToken: text, path: text }
    return empty
  }

  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return empty
  }

  const tableId = (parsed.searchParams.get('table') ?? '').trim()
  const viewId = (parsed.searchParams.get('view') ?? '').trim()
  const sheetId = (parsed.searchParams.get('sheet') ?? '').trim()

  // 路径段：/base/<token>、/wiki/<token>、/sheets/<token>。第一段可能是语言前缀（/zh-CN/…），
  // 所以按「找关键字那一段、取它的下一段」来读，而不是写死下标。
  const segments = parsed.pathname.split('/').filter((part) => part.length > 0)
  const at = (keyword) => {
    const index = segments.indexOf(keyword)
    if (index < 0) return ''
    return (segments[index + 1] ?? '').trim()
  }

  const baseToken = at('base')
  if (baseToken.length > 0) return { kind: 'bitable', appToken: baseToken, spreadsheetToken: '', tableId, viewId, sheetId: '', path: segments.join('/') }

  const wikiToken = at('wiki')
  if (wikiToken.length > 0) return { kind: 'wiki', appToken: wikiToken, spreadsheetToken: '', tableId, viewId, sheetId: '', path: segments.join('/') }

  const sheetToken = at('sheets') || at('sheet')
  if (sheetToken.length > 0) return { kind: 'sheet', appToken: '', spreadsheetToken: sheetToken, tableId: '', viewId: '', sheetId, path: segments.join('/') }

  return { ...empty, tableId, viewId, sheetId, path: segments.join('/') }
}

/**
 * 路径归一：统一 `/`、盘符大写、折叠重复分隔符、去掉尾随分隔符。
 * @param {string} p
 * @returns {string}
 */
export function normalizePath (p) {
  if (typeof p !== 'string' || p.length === 0) return ''
  let out = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').trim()
  out = out.replace(/^\/?([a-zA-Z]):\//, (_, d) => `${d.toUpperCase()}:/`)
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/**
 * URL 归一：去掉 `#fragment`、去掉默认端口、小写协议与主机。
 * @param {string} u
 * @returns {string}
 */
export function normalizeUrl (u) {
  if (typeof u !== 'string' || u.length === 0) return ''
  try {
    const parsed = new URL(u.trim())
    parsed.hash = ''
    if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = ''
    }
    return parsed.toString()
  } catch {
    return u.trim()
  }
}

// ── Ticket ─────────────────────────────────────────────────

/**
 * @typedef {Object} Ticket
 * @property {string} recordId 平台侧稳定标识，**唯一身份**
 * @property {string} projectId 所属项目（对应配置 `projects[].name`），存储复合主键的一部分
 * @property {string} fingerprint 内容指纹
 * @property {number} revisionCount 第几次修订，从 1 开始
 * @property {string} [seq] 「序号」列，仅用于显示
 * @property {string} [department] 发现部门
 * @property {string} description 问题描述
 * @property {string} [foundAt] 发现日期（ISO 日期串）
 * @property {string} [module] 模块（可能是旧称）
 * @property {string} [targetProject] 工单正文里写的「待修改项目」原值（表格列），**仅供模型参考**：
 *   它和 `projectId` 很可能不是一回事 —— `projectId` 是配置里的项目名（存储主键的一部分），
 *   而这一列是人手填的自由文本。硬拿它去顶 `projectId` 会让同一张表里的票散到不同主键下。
 * @property {string} [flow] 操作流程
 * @property {ScreenshotRef[]} screenshots
 * @property {'high'|'medium'|'low'} [priority]
 * @property {string} [status] 「是否处理」原值，仅用于日志
 * @property {unknown} raw 平台原始 record，内核不解释
 */

/** 工单内容字段，指纹按这个顺序拼。 */
export const FINGERPRINT_FIELDS = Object.freeze([
  'description',
  'module',
  'flow',
  'screenshots',
  'priority',
  'department',
])

/**
 * 算内容指纹。
 *
 * 刻意**不包含** `status`（是否处理）/ 处理人 / 处理结果 / 处理日期 ——
 * 那是人管理工单的过程，不是工单内容。算进去会导致人每改一次处理人就触发一次「修订」。
 *
 * @param {Partial<Ticket> & { screenshots?: ScreenshotRef[] }} ticket
 * @returns {string} 16 位十六进制
 */
export function fingerprintOf (ticket) {
  const screenshots = Array.isArray(ticket.screenshots) ? ticket.screenshots : []
  const parts = [
    String(ticket.description ?? '').trim(),
    String(ticket.module ?? '').trim(),
    String(ticket.flow ?? '').trim(),
    screenshots.map(normalizeScreenshotRef).join('|'),
    String(ticket.priority ?? '').trim(),
    String(ticket.department ?? '').trim(),
  ]
  return sha256Hex(parts.join('\u0000')).slice(0, 16)
}

/**
 * 同步 sha256（不引 node:crypto 的异步版本，便于在纯数据层使用）。
 *
 * 这是一个精简实现：只在指纹场景用，不用于安全目的。
 * @param {string} text
 * @returns {string}
 */
function sha256Hex (text) {
  const bytes = utf8Bytes(text)
  const hash = sha256(bytes)
  let out = ''
  for (let i = 0; i < hash.length; i++) out += hash[i].toString(16).padStart(2, '0')
  return out
}

/** @param {string} s @returns {Uint8Array} */
function utf8Bytes (s) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s)
  // 极老环境兜底：只处理 ASCII（本项目的指纹输入基本是中文，实际不会走到）
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/**
 * 标准 SHA-256，返回 32 字节。
 * @param {Uint8Array} msg
 * @returns {Uint8Array}
 */
function sha256 (msg) {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])

  const bitLen = msg.length * 8
  const padLen = (msg.length % 64 < 56 ? 56 : 120) - (msg.length % 64)
  const total = msg.length + padLen + 8
  const buf = new Uint8Array(total)
  buf.set(msg)
  buf[msg.length] = 0x80
  // 末尾 8 字节放大端 64 位长度（本场景远小于 2^32 位，高 4 字节写 0）
  const view = new DataView(buf.buffer)
  view.setUint32(total - 4, bitLen >>> 0, false)
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false)

  const w = new Uint32Array(64)
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    H[0] = (H[0] + a) >>> 0
    H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0
    H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0
    H[5] = (H[5] + f) >>> 0
    H[6] = (H[6] + g) >>> 0
    H[7] = (H[7] + h) >>> 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i], false)
  return out
}

/** @param {number} x @param {number} n */
function rotr (x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

// ── 其它数据契约 ────────────────────────────────────────────

/**
 * @typedef {Object} Plan
 * @property {string} summary 一句话：打算改什么
 * @property {string[]} targetPaths 计划改哪些文件（相对 repoPath）
 * @property {string} approach 怎么做（Markdown）
 * @property {string} [risks] 担心的点 / 不确定的地方
 */

/**
 * @typedef {Object} NotifyMessage
 * @property {string} title
 * @property {string} body Markdown
 * @property {string} [link] 通常是 MR URL
 * @property {'info'|'warn'|'error'} level
 */

/**
 * @typedef {Object} PushReceipt
 * @property {boolean} accepted
 * @property {string} [traceId]
 */

/**
 * 优先级排序权重：高 > 中 > 低，未知排最后。
 * @param {Ticket['priority']} priority
 * @returns {number}
 */
export function priorityWeight (priority) {
  if (priority === 'high') return 3
  if (priority === 'medium') return 2
  if (priority === 'low') return 1
  return 0
}
