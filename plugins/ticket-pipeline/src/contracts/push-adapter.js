/**
 * `PushAdapter` —— 消息怎么送出去。
 *
 * 只有 `send` 一个方法：通知是单向的。人在微信里回复「这个不对」属于**双向通道**，
 * 明确在地图 `Out of scope` 之外。
 */

/**
 * @typedef {import('./types.js').NotifyMessage} NotifyMessage
 * @typedef {import('./types.js').PushReceipt} PushReceipt
 */

/**
 * `PushAdapter` 契约。
 *
 * ⚠️ 契约里最重要的一条：`accepted` 只代表「服务端受理」，**不代表送达**。
 * PushPlus 的 `code:200` 只是收了请求，真送达要看 `callbackUrl` 里的 `sendStatus`
 * （0 未发 / 1 发送中 / 2 成功 / 3 失败）。内核不得把 `accepted:true` 当成
 * 「人已经知道了」，更不得据此决定跳过重试。
 *
 * @typedef {Object} PushAdapter
 * @property {string} id
 * @property {(msg: NotifyMessage, signal: AbortSignal) => Promise<PushReceipt>} send
 */

/**
 * @param {unknown} candidate
 * @param {string} [label]
 * @returns {PushAdapter}
 */
export function assertPushAdapter (candidate, label = 'PushAdapter') {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`${label}: 必须是对象，实际是 ${typeof candidate}`)
  }
  const push = /** @type {any} */ (candidate)
  if (typeof push.id !== 'string' || push.id.length === 0) {
    throw new Error(`${label}: 缺少 id`)
  }
  if (typeof push.send !== 'function') {
    throw new Error(`${label}("${push.id}"): 缺少 send(msg, signal)`)
  }
  return /** @type {PushAdapter} */ (push)
}

/**
 * 归一通知消息：裁剪标题、补默认 level。
 * @param {Partial<NotifyMessage>} input
 * @returns {NotifyMessage}
 */
export function makeNotifyMessage (input) {
  const title = String(input?.title ?? '').trim()
  const body = String(input?.body ?? '').trim()
  if (title.length === 0) throw new Error('makeNotifyMessage: title 不能为空')
  if (body.length === 0) throw new Error('makeNotifyMessage: body 不能为空')

  // PushPlus 的 txt 模板在微信里一行显示不了太长，标题必须短。
  const shortTitle = title.length > 48 ? `${title.slice(0, 47)}…` : title

  /** @type {NotifyMessage} */
  const message = { title: shortTitle, body, level: input.level ?? 'info' }
  if (typeof input.link === 'string' && input.link.length > 0) message.link = input.link
  return message
}
