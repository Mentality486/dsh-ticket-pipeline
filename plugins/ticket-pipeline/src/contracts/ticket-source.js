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
 * `TicketSource` 契约。
 *
 * 实现必须满足：
 * - `scan` **不得**写任何远端状态（表格只读，这是用户拍板的硬约束）。
 * - `scan` 抛错 = 本轮扫描失败。**不要返回空数组假装成功** —— 内核要区分「没变化」与「扫失败了」。
 * - `signal.aborted` 时必须尽快抛 `PipelineError('aborted')`，分页循环里每页检查一次。
 * - 适配器自己维护「见过什么」的水位，内核不参与比对。
 * - `loadScreenshot` 只负责拿字节，不负责 `saveImage` / 构造消息 —— 那是内核的事。
 *
 * @typedef {Object} TicketSource
 * @property {string} id 稳定标识：'feishu' | 'wps' | 'xlsx' | 'mock'。用于存储分区与日志前缀。
 * @property {(signal: AbortSignal) => Promise<ScanResult>} scan
 * @property {(ref: ScreenshotRef, signal: AbortSignal) => Promise<LoadedScreenshot>} loadScreenshot
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
