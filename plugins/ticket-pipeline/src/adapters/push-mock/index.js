/**
 * `push-mock` —— 把通知记在内存里，不发出去。
 *
 * 自测断言用：某张票到了 `done` 时，应该恰好有一条对应通知。
 */

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

  return {
    id: 'mock',
    messages,

    async send (msg) {
      if (fail) throw new Error('mock：通知发送失败')
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
  }
}
