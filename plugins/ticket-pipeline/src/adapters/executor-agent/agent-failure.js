/**
 * `agent-failure` —— 弄清 agent 这一轮到底为什么没干活。
 *
 * 为什么需要它：宿主里 agent 干不成活有两种完全不同的原因，
 * 但从外面看长得一模一样 —— 都是「闲下来了、一个字没改」：
 *
 * 1. **模型调用失败**（限流、配额用尽、上游 5xx）：agent 根本没拿到模型回复，
 *    所以它没有改任何文件。这种失败是**可重试**的，等一会儿再来就行。
 * 2. **agent 真的干了但没改东西**：它读了代码、想了想、觉得不用改。
 *    这是**结论**，不是错误，重试一百次还是一样。
 *
 * 旧实现把这两种都报成「agent 没有产生任何文件改动」（internal、不可重试），
 * 于是第 1 种被永久判死，人看到的是一句完全指错方向的报错。
 *
 * 本模块提供两条互补的取因路径：
 *
 * - **主路径**：订阅 agent 自带 ctx 上的 `agent/error` 事件
 *   （宿主 `dsh-subagent` 用的就是这一条：`child.ctx.on("agent/error", ...)`）。
 * - **兜底路径**：直接读 `agent.session.log` 里最后一个 `turn/end` 事件，
 *   看 `reason.kind === 'error'` 时它带的 `error.code`（宿主在 turn 收尾时
 *   一定会 append 这条事件，见 `dsh-agent-loop` 的 `session.append('turn/end', ...)`）。
 *
 * 两条路径都拿不到时返回 null —— 调用方据此认为「agent 没失败，只是没改东西」，
 * 不会因为探测失败而误伤正常工单。
 */

import { PipelineError } from '../../contracts/errors.js'

/** 上游给的失败码：这些表示「等一会儿再来」，不是「这活干不了」。 */
const RATE_LIMIT_CODES = new Set([
  'RATE_LIMIT',
  'QUOTA',
  'RATE_LIMITED',
  'TOO_MANY_REQUESTS',
  'SOFT_RATE',
])

/**
 * 文案里的限流痕迹。
 *
 * 不同上游措辞不一样（`rate_limit_error` / `quota_exceeded` / 「被限流」），
 * 只能兜底匹配 —— 但只用来**收紧**判断：code 命中才算数，文案命中是补充。
 */
const RATE_LIMIT_HINTS = /被限流|限流|rate[\s_-]?limit|quota[\s_-]?exceeded|too many requests|\b429\b/i

/**
 * 这算不算「限流 / 配额用尽」。
 *
 * @param {{ code?: string, message?: string } | null | undefined} failure
 * @returns {boolean}
 */
export function isRateLimitFailure (failure) {
  if (!failure) return false
  const code = String(failure.code ?? '').trim().toUpperCase().replace(/[-\s]+/g, '_')
  if (RATE_LIMIT_CODES.has(code)) return true
  return RATE_LIMIT_HINTS.test(String(failure.message ?? ''))
}

/**
 * 从会话日志里读最后一次 turn 的结束原因。
 *
 * 只看**最后一个** `turn/end`：前面的轮次失败过、后面又成功了的，
 * 不该算作这一轮失败。
 *
 * @param {any} agent
 * @returns {{ code: string, message: string } | null}
 */
export function readLastTurnEnd (agent) {
  const log = agent?.session?.log
  if (!Array.isArray(log)) return null
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index]
    if (event?.type !== 'turn/end') continue
    const reason = event?.data?.reason
    return reason && typeof reason === 'object' ? reason : { kind: 'unknown' }
  }
  return null
}

export function readTurnEndFailure (agent) {
  const reason = readLastTurnEnd(agent)
  if (!reason || reason.kind !== 'error') return null
  const error = reason.error ?? {}
  return {
    code: String(error.code ?? 'UNKNOWN'),
    message: String(error.message ?? 'agent 这一轮以错误结束'),
  }
}

/**
 * 把宿主抛出的错误对象压成 `{code, message}`。
 *
 * LLM 失败在宿主里有三层可能的落点：`error.code`、`error.failure.code`、
 * `error.reason.code`，逐个认一遍。
 *
 * @param {unknown} error
 * @returns {{ code: string, message: string } | null}
 */
function normalizeFailure (error) {
  if (!error) return null
  if (typeof error === 'string') return { code: 'UNKNOWN', message: error }
  const anyError = /** @type {any} */ (error)
  const message = String(anyError.message ?? anyError.reason?.message ?? 'agent 这一轮以错误结束')
  const code = String(anyError.code ?? anyError.failure?.code ?? anyError.reason?.code ?? 'UNKNOWN')
  return { code, message }
}

/**
 * 盯着 agent 的失败事件。
 *
 * `agent/error` 的载荷形状是 `{agent, error, turn, step}`（宿主把 agent 本身
 * 塞进载荷里，见 `dsh-agent` 的 `agentEvents`）。别的 agent 的事件要忽略掉。
 *
 * @param {any} agent
 * @returns {{ captured: { code: string, message: string } | null, detect: () => { code: string, message: string } | null, dispose: () => void }}
 */
export function watchAgentFailures (agent) {
  /** @type {{ code: string, message: string } | null} */
  let captured = null
  /** @type {(() => void) | null} */
  let stop = null

  const ctx = agent?.ctx
  if (ctx && typeof ctx.on === 'function') {
    try {
      const result = ctx.on('agent/error', (payload) => {
        const subject = payload?.agent
        if (subject && agent && subject !== agent) return
        captured = normalizeFailure(payload?.error)
      })
      if (typeof result === 'function') stop = result
    } catch {
      // 订阅不上不算失败：还有日志兜底路径。
      stop = null
    }
  }

  return {
    get captured () { return captured },
    detect () {
      // 最后一轮 turn/end 是权威判据：它说这一轮成功了，就说明 agent 缓过来了，
      // 不能拿更早那一轮的失败去冤枉这次执行。
      const reason = readLastTurnEnd(agent)
      if (reason) {
        if (reason.kind !== 'error') return null
        const error = reason.error ?? {}
        return {
          code: String(error.code ?? 'UNKNOWN'),
          message: String(error.message ?? 'agent 这一轮以错误结束'),
        }
      }
      // 读不到会话日志（例如老宿主不暴露 log）时退回事件订阅捕获的那一条。
      return captured
    },
    dispose () {
      try { stop?.() } catch { /* 解绑失败不影响主流程 */ }
    },
  }
}

/**
 * 从限流文案里解析「多久之后再试」。
 *
 * 上游常把重置时刻写在报错里（「将在 2026-11-05 17:09:35 UTC+8 重置」），
 * 那比内核猜的指数退避准得多 —— 内核会拿它当 retryAfterMs，
 * 但仍会夹在自己的上限内（见 `contracts/errors.js`）。
 *
 * 解析不出来就返回 undefined，让内核按自己的曲线退避。
 *
 * @param {string} message
 * @returns {number | undefined}
 */
export function parseRetryAfterMs (message) {
  const text = String(message ?? '')

  // 「将在 2026-11-05 17:09:35 UTC+8 重置」/「reset at 2026-11-05T17:09:35.000Z」
  const stamp = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\s*(UTC|Z))?\s*([+-]\d{1,2}(?::?\d{2})?)?/i.exec(text)
  if (stamp) {
    const [, date, time, utc, offset] = stamp
    // 「2026-11-05 17:09:35 UTC+8」这种写法里 UTC 只是前缀，真正生效的是 +8；
    // 偏移量优先于 UTC/Z 标记，否则会算错时差、把重置时刻算到 8 小时前。
    let zone = 'Z'
    if (offset) {
      // ISO 8601 的偏移必须是两位小时：「+8」要补成「+08:00」，
      // 否则 Date.parse 直接给 NaN，重置时刻就白解析了。
      const digits = offset.replace(':', '')
      const sign = digits.startsWith('-') ? '-' : '+'
      const body = digits.replace(/^[+-]/, '')
      const hours = body.slice(0, 2).padStart(2, '0')
      const minutes = body.length > 2 ? body.slice(2, 4) : '00'
      zone = sign + hours + ':' + minutes
    } else if (utc) {
      zone = 'Z'
    }
    const iso = date + 'T' + (time.length === 5 ? time + ':00' : time) + zone
    const at = Date.parse(iso)
    if (Number.isFinite(at)) {
      const waitMs = at - Date.now()
      if (waitMs > 0) return Math.floor(waitMs)
    }
  }

  // 「retry after 30 seconds」/「30 秒后」
  const seconds = /(\d+)\s*(?:秒|seconds?|secs?|s\b)/i.exec(text)
  if (seconds) {
    const waitMs = Number(seconds[1]) * 1000
    if (Number.isFinite(waitMs) && waitMs > 0) return Math.floor(waitMs)
  }

  return undefined
}

/**
 * 把 agent 的失败翻译成流水线错误。
 *
 * 限流/配额 → `rate-limit`（内核可重试，会退避后再来）；
 * 其它错误 → `internal`（也是可重试，但文案里带真实原因，人看得懂）。
 *
 * @param {{ code?: string, message?: string } | null | undefined} failure
 * @returns {PipelineError}
 */
export function agentFailureToPipelineError (failure) {
  const detail = String(failure?.message ?? 'agent 这一轮以错误结束')
  if (isRateLimitFailure(failure)) {
    const retryAfterMs = parseRetryAfterMs(detail)
    const suffix = retryAfterMs === undefined
      ? ''
      : '（上游说约 ' + Math.ceil(retryAfterMs / 1000) + ' 秒后恢复）'
    return markAgentFailure(new PipelineError(
      'rate-limit',
      'agent 这一轮被上游限流了：' + detail + suffix,
      undefined,
      retryAfterMs,
    ))
  }
  return markAgentFailure(new PipelineError('internal', 'agent 这一轮以错误结束：' + detail))
}

/**
 * 给「agent 自己失败」这类错误打一个标记。
 *
 * 内核的重试分档看的是 kind 与 retryable，但执行器内部还有一层区分：
 * 「agent 失败」要抛给内核退避重试，「agent 干完了但觉得不用改」要留在票上
 * 当成一个结论。kind 表达不了这层意思，所以额外挂一个标记。
 *
 * @param {PipelineError} error
 * @returns {PipelineError}
 */
function markAgentFailure (error) {
  /** @type {any} */ (error).agentFailure = true
  return error
}