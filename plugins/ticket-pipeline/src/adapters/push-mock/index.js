/**
 * `push-mock` —— 把通知记在内存里，不发出去。
 *
 * 自测断言用：某张票到了 `done` 时，应该恰好有一条对应通知。
 *
 * ## 为什么也要走 `assertPushAdapter`
 *
 * mock 是「换适配器只需一个目录」这条承诺的样板：别人照着它写真实适配器。
 * 样板自己都不满足契约，等于把人教错。所以它和其它适配器一样在构造期过一遍契约校验。
 *
 * ## 为什么失败抛 `PipelineError('internal')` 而不是裸 Error
 *
 * 内核只按 `kind` 决策，不解析 message（见 `contracts/errors.js` 开头）。
 * 裸 Error 会被 `toPipelineError` 兜到默认的 `internal`，看似殊途同归，
 * 但那层兜底是「给不规矩的第三方错误用的」，本仓库自己的适配器不该依赖它 ——
 * 分类明确写出来，读代码的人才知道「通知失败是可重试的，不该改票据状态」。
 */

import { assertPushAdapter } from '../../contracts/push-adapter.js'
import { PipelineError } from '../../contracts/errors.js'

/**
 * @param {Object} [options]
 * @param {boolean} [options.fail] 强制发送失败（验证「通知失败不改变票据状态」）
 * @returns {import('../../contracts/push-adapter.js').PushAdapter & {
 *   messages: Array<import('../../contracts/types.js').NotifyMessage>,
 *   setFail: (v: boolean) => void,
 *   clear: () => void,
 * }}
 */
export function createMockPush (options = {}) {
  /** @type {Array<import('../../contracts/types.js').NotifyMessage>} */
  const messages = []
  let fail = Boolean(options.fail)
  let seq = 0

  return assertPushAdapter({
    id: 'mock',
    messages,

    /**
     * @param {import('../../contracts/types.js').NotifyMessage} msg
     * @param {AbortSignal} [signal]
     */
    async send (msg, signal) {
      // 取消语义与真实适配器一致：取消了就别再往外发，也别记进 messages ——
      // 否则「本轮应该有几条通知」这类断言会被一条根本不存在的发送污染。
      if (signal?.aborted) throw new PipelineError('aborted', 'mock：通知发送被取消')
      if (fail) throw new PipelineError('internal', 'mock：通知发送失败')
      messages.push(msg)
      seq += 1
      // `accepted: true` 只代表受理。mock 里也没有真实送达概念，所以 traceId 只是序号。
      return { accepted: true, traceId: `mock-${seq}` }
    },

    setFail (value) {
      fail = Boolean(value)
    },

    clear () {
      messages.length = 0
      seq = 0
    },
  })
}
