/**
 * 公共数据契约：`Ticket` / `ScreenshotRef` / `Phase` / `Plan` 等。
 *
 * 这里只有类型与纯数据工具，**不 import 任何东西**（`crypto` 除外，用同步版本）。
 * 契约层必须能随便被谁 import 而不产生副作用。
 */

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
  'skipped': '已本地提交，但未跑通验证',
  'failed': '失败',
  'gone': '表格里已删除',
})

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
