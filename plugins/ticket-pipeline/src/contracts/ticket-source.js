/**
 * `TicketSource` —— 工单从哪来。
 *
 * 四种平台（飞书 / 金山 / xlsx / mock）的取法完全不同，所以这一层必须可替换。
 * 内核只调 `scan` 与 `loadScreenshot`，不知道任何平台的 URL 与认证方式。
 */

// 契约层内部单向依赖：`types.js` 不 import 本文件，所以无环。
import { fingerprintOf } from './types.js'

/**
 * @typedef {import('./types.js').Ticket} Ticket
 * @typedef {import('./types.js').ScreenshotRef} ScreenshotRef
 * @typedef {import('./types.js').ImageMediaType} ImageMediaType
 */

/**
 * @typedef {Object} ScanResult
 * @property {Ticket[]} created 首次出现的行（无论 mtime 多早）。内核动作：入队。
 * @property {Ticket[]} updated 见过且内容指纹变了。内核动作：revisionCount++，排队尾，不打断当前运行。
 * @property {string[]} disappeared 连续 `goneAfterScans` 轮没扫到的 recordId。内核动作：退役。
 */

/**
 * @typedef {Object} LoadedScreenshot
 * @property {Uint8Array} data
 * @property {ImageMediaType} mediaType
 * @property {string} [name]
 */

/**
 * 回填一张工单的处理结果（用户 2026-11-06 拍板）。
 *
 * 分工写死在这里，适配器不要自作主张：
 * - `是否处理` → `status`（默认 `是`，可被配置覆盖）
 * - `处理结果` → 一段「怎么处理的」人话
 * - `处理日期` → `handledAt`（毫秒时间戳，适配器自己按平台格式落格）
 *
 * @typedef {Object} WriteBackResult
 * @property {string} [status] `是否处理` 列要写的值，缺省 `是`
 * @property {string} result `处理结果` 列要写的内容
 * @property {number} [handledAt] `处理日期` 的时间戳（毫秒），缺省取当前时间
 * @property {boolean} [onlyResult] 只写 `处理结果` 列，**不碰 `是否处理` 与 `处理日期`**
 *   （工单 #14：失败的票也要能在表里留一句「卡在哪」，但不能把「是否处理」改成「是」
 *   —— 那会让人以为处理完了。日期是「处理完成日」，没完成就不该有。）
 */

/**
 * 回填结果。
 *
 * `written:false` 有两种完全不同的处境，适配器**必须**用 `retryable` 分开说 ——
 * 内核据此决定「留着待办下次启动再试」还是「当场放弃、让人去改配置」：
 * - `retryable: false`（配置/结构问题，例如往飞书同步表里写、表里少一列、
 *   电子表格只有读权限、要回填的那一行已经被删）：再试一百次也是同一个结果，
 *   只会让每次启动都撞一遍。
 * - `retryable: true`（网络、限流、鉴权过期这类临时问题）：值得再试。
 *
 * 不标 `retryable` 时内核按「不可重试」处理 —— 宁可少试一次，
 * 也不要对着同一张结构上写不进去的表反复报错。
 *
 * @typedef {Object} WriteBackReceipt
 * @property {boolean} written 是否真的写成功了（平台不支持/没开开关时 false）
 * @property {string[]} [fields] 实际写了哪几列（排障时看）
 * @property {string} [note] 没写的原因，或写成功时的补充说明。**这段文字会进表格、进通知、
 *   进状态页，是给人看的**：不要拼 `kind: ` 之类内部前缀，分类放 `errorKind`。
 * @property {boolean} [retryable] 没写成时：再试一次有没有意义
 * @property {import('./errors.js').ErrorKind} [errorKind] 没写成时的错误分类（程序用，不给人看）
 */

/**
 * `TicketSource` 契约。
 *
 * 实现必须满足：
 * - `scan` **不得**写任何远端状态。表格只读是扫描的硬约束 —— 扫描期间任何一次写
 *   都会把「人在改表」和「插件在读表」搅在一起，指纹也会跟着抖。
 * - **唯一的写入口是 `writeResult`**（用户 2026-11-06 明确要求处理完回填）。
 *   它只在票跑完 done/skipped 之后被调用一次，绝不在扫描/重试中间调用。
 * - `scan` 抛错 = 本轮扫描失败。**不要返回空数组假装成功** —— 内核要区分「没变化」与「扫失败了」。
 * - `signal.aborted` 时必须尽快抛 `PipelineError('aborted')`，分页循环里每页检查一次。
 * - 适配器自己维护「见过什么」的水位，内核不参与比对。
 * - `loadScreenshot` 只负责拿字节，不负责 `saveImage` / 构造消息 —— 那是内核的事。
 *
 * @typedef {Object} TicketSource
 * @property {string} id 稳定标识：'feishu' | 'wps' | 'xlsx' | 'mock'。用于存储分区与日志前缀。
 * @property {(signal: AbortSignal) => Promise<ScanResult>} scan
 * @property {(ref: ScreenshotRef, signal: AbortSignal) => Promise<LoadedScreenshot>} loadScreenshot
 * @property {(recordId: string, result: WriteBackResult, signal: AbortSignal) => Promise<WriteBackReceipt>} [writeResult]
 * @property {((cb: (hint: { recordIds?: string[] }) => void) => () => void)} [onExternalChange]
 */

/**
 * 校验一个对象是否满足 `TicketSource` 的最小形状。
 *
 * 为什么运行时校验：适配器是「换平台时唯一要写的东西」，写错了（比如忘了 `loadScreenshot`）
 * 应该在注册那一刻就报错，而不是跑到第三张工单才炸。
 *
 * @param {unknown} candidate
 * @param {string} [label]
 * @returns {TicketSource}
 */
export function assertTicketSource (candidate, label = 'TicketSource') {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`${label}: 必须是对象，实际是 ${typeof candidate}`)
  }
  const source = /** @type {any} */ (candidate)
  if (typeof source.id !== 'string' || source.id.length === 0) {
    throw new Error(`${label}: 缺少 id`)
  }
  if (typeof source.scan !== 'function') {
    throw new Error(`${label}("${source.id}"): 缺少 scan(signal)`)
  }
  if (typeof source.loadScreenshot !== 'function') {
    throw new Error(`${label}("${source.id}"): 缺少 loadScreenshot(ref, signal)`)
  }
  if (source.onExternalChange !== undefined && typeof source.onExternalChange !== 'function') {
    throw new Error(`${label}("${source.id}"): onExternalChange 必须是函数或不存在`)
  }
  if (source.writeResult !== undefined && typeof source.writeResult !== 'function') {
    throw new Error(`${label}("${source.id}"): writeResult 必须是函数或不存在`)
  }
  return /** @type {TicketSource} */ (source)
}

/**
 * 把「原始行」组装成内部 `Ticket` 并算出指纹。
 *
 * 这是各平台适配器共用的最后一步：不同平台解析出字段后都走这里，
 * 保证指纹算法只有一份实现（否则两个适配器的同一张工单会算出不同指纹）。
 *
 * @param {Partial<Ticket> & { recordId: string, description: string, screenshots?: ScreenshotRef[] }} input
 * @param {{ revisionCount?: number }} [options]
 * @returns {Ticket}
 */
export function makeTicket (input, options = {}) {
  if (!input || typeof input.recordId !== 'string' || input.recordId.length === 0) {
    throw new Error('makeTicket: recordId 必须是非空字符串')
  }
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const screenshots = Array.isArray(input.screenshots) ? input.screenshots : []

  /** @type {Ticket} */
  const ticket = {
    recordId: input.recordId,
    fingerprint: '',
    revisionCount: Number.isInteger(options.revisionCount) && /** @type {number} */ (options.revisionCount) >= 1
      ? /** @type {number} */ (options.revisionCount)
      : 1,
    description,
    screenshots,
    raw: input.raw,
  }

  if (input.projectId !== undefined && input.projectId !== '') ticket.projectId = String(input.projectId)
  if (input.seq !== undefined && input.seq !== '') ticket.seq = String(input.seq)
  if (input.department !== undefined && input.department !== '') ticket.department = String(input.department)
  if (input.foundAt !== undefined && input.foundAt !== '') ticket.foundAt = String(input.foundAt)
  if (input.module !== undefined && input.module !== '') ticket.module = String(input.module)
  if (input.targetProject !== undefined && input.targetProject !== '') ticket.targetProject = String(input.targetProject)
  if (input.flow !== undefined && input.flow !== '') ticket.flow = String(input.flow)
  if (input.status !== undefined && input.status !== '') ticket.status = String(input.status)
  if (input.priority === 'high' || input.priority === 'medium' || input.priority === 'low') {
    ticket.priority = input.priority
  }

  ticket.fingerprint = fingerprintOf(ticket)
  return ticket
}
