/**
 * 错误分类。内核只按 `kind` 决策，绝不解析 `message`。
 *
 * 为什么要有这一层：适配器的错误文案会变、会被翻译、会被用户改成别的措辞。
 * 把「能不能重试 / 要不要通知人」压在一个枚举上，内核才能稳定。
 */

/** @typedef {'auth'|'network'|'rate-limit'|'not-found'|'invalid-input'|'unsupported'|'aborted'|'internal'} ErrorKind */

/** 所有 kind 的运行时集合，用于校验。 */
export const ERROR_KINDS = Object.freeze([
  'auth',
  'network',
  'rate-limit',
  'not-found',
  'invalid-input',
  'unsupported',
  'aborted',
  'internal',
])

/**
 * 可重试的 kind。
 *
 * 判据只有一条：**再试一次可能就好了**吗。网络抖、服务端限流、对面 5xx 属于这一类。
 */
export const RETRYABLE_KINDS = Object.freeze(new Set(['network', 'rate-limit', 'internal']))

/**
 * 直接判定失败、必须通知人的 kind。
 *
 * 判据：**再试一百次也一样**，得有人去改配置或改权限。`unsupported` 也在这里 ——
 * 它表示「平台结构上不接受这个操作」（例如往飞书同步表里写记录），
 * 重试只会把同一个错误再撞一遍。
 */
export const FATAL_KINDS = Object.freeze(new Set(['auth', 'not-found', 'invalid-input', 'unsupported']))

/**
 * 取消。既不可重试也不是「失败」：人自己按的取消，重试等于违背他的意思。
 *
 * 单独一张表的存在意义：**每个 kind 必须恰好落在这三张表之一**（自测里有一条断言
 * 遍历 `ERROR_KINDS` 检查这件事）。早先 `aborted` 两张表都不在，于是「落库当失败、
 * 却又不通知人」这种半截行为没人发现。
 */
export const CANCELLED_KINDS = Object.freeze(new Set(['aborted']))

/**
 * 适配器必须抛这个，不许抛裸 `Error('出错了')`。
 */
export class PipelineError extends Error {
  /**
   * @param {ErrorKind} kind
   * @param {string} message
   * @param {unknown} [cause]
   * @param {number} [retryAfterMs] `kind='rate-limit'` 时服务端给的等待时间（来自 `Retry-After`）。
   *   内核的重试退避会读它：服务端自己说的「什么时候再来」比我们猜的指数曲线准。
   *   不传就按内核的退避曲线走；传了也仍会被夹到退避上限内。
   */
  constructor (kind, message, cause, retryAfterMs) {
    super(message)
    this.name = 'PipelineError'
    if (!ERROR_KINDS.includes(kind)) {
      throw new Error(`PipelineError: 未知的 kind "${kind}"，必须是 ${ERROR_KINDS.join(' / ')}`)
    }
    this.kind = kind
    if (cause !== undefined) this.cause = cause
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }

  get retryable () {
    return RETRYABLE_KINDS.has(this.kind)
  }
}

/**
 * 一个 kind 的重试政策，三选一。
 *
 * 为什么要有这个函数而不是让调用方自己查两张表：查表很容易只查一张。
 * `aborted` 当初就漏在两张表之外 —— 于是「被取消」既不被当成可重试，
 * 也不被当成致命，两条分支都不接，票的行为取决于写的人碰巧先写了哪个 if。
 *
 * @param {ErrorKind} kind
 * @returns {'retry'|'fatal'|'cancelled'}
 */
export function retryPolicy (kind) {
  if (CANCELLED_KINDS.has(kind)) return 'cancelled'
  if (RETRYABLE_KINDS.has(kind)) return 'retry'
  return 'fatal'
}

/**
 * 把任意异常归一成 `PipelineError`。
 *
 * 适配器内部的第三方错误（fetch 失败、JSON 解析失败）不必逐层包装，
 * 在内核边界统一归一即可；但**已经**是 `PipelineError` 的原样返回 —— 分类信息比外层猜测更准。
 *
 * @param {unknown} error
 * @param {ErrorKind} [fallback]
 * @returns {PipelineError}
 */
export function toPipelineError (error, fallback = 'internal') {
  if (error instanceof PipelineError) return error
  if (isAbortError(error)) return new PipelineError('aborted', '被取消', error)
  const message = error instanceof Error ? error.message : String(error)
  return new PipelineError(fallback, message, error)
}

/**
 * 识别取消。`AbortSignal.reason` 在不同实现里形状不一，这里三种都认。
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAbortError (error) {
  if (!error) return false
  if (error instanceof PipelineError) return error.kind === 'aborted'
  if (typeof error === 'object' && /** @type {any} */ (error).name === 'AbortError') return true
  if (error instanceof Error && error.message === 'ticket-timeout') return true
  return false
}

/**
 * 组合外部 signal 与本地 controller，返回一个会在任一方触发时 abort 的句柄。
 *
 * 为什么要组合：适配器拿到的是自己的 signal，而超时/人工取消来自外部。
 * 直接把外部 signal 传下去会让适配器无法区分「我这层超时」与「整票被取消」。
 *
 * @param {AbortSignal} [outer]
 * @returns {{ signal: AbortSignal, abort: (reason?: unknown) => void, dispose: () => void }}
 */
export function linkSignal (outer) {
  const controller = new AbortController()
  /** @type {undefined | (() => void)} */
  let unlink

  if (outer) {
    if (outer.aborted) controller.abort(outer.reason)
    else {
      const onAbort = () => controller.abort(outer.reason)
      outer.addEventListener('abort', onAbort, { once: true })
      unlink = () => outer.removeEventListener('abort', onAbort)
    }
  }

  return {
    signal: controller.signal,
    abort: (reason) => {
      if (!controller.signal.aborted) controller.abort(reason)
    },
    dispose: () => {
      if (unlink) unlink()
      unlink = undefined
    },
  }
}
