/**
 * `push-pushplus` —— 通过 PushPlus 把通知推到微信 ClawBot。
 *
 * 为什么是 PushPlus 而不是 WorkBuddy 自带的微信助理：`research/wechat-push.md`
 * 用 784 行实测证明了 WorkBuddy 根本没有供外部进程调用的发消息接口
 * （被动回复语义、`context_token` 从未产生过、botToken 的密钥根在 asar 里找不到）。
 *
 * ⚠️ 这个适配器最重要的一条纪律：**HTTP 200 不等于送达**。
 * PushPlus 的 `code:200` 只代表「服务端受理了这次请求」，真正有没有到人手机上
 * 要看 `callbackUrl` 收到的 `sendStatus`（0 未发 / 1 发送中 / 2 成功 / 3 失败）。
 * 所以 `send()` 返回的 `accepted` 只严谨地表示「受理」，内核不得据此判断
 * 「人已经知道了」，也不得据此跳过重试。
 *
 * 微信侧的四个硬限制（PushPlus 官方文档）：
 * 1. 一个微信号只能绑一个 ClawBot；
 * 2. 绑定后必须主动发起一次对话，否则推送不出去；
 * 3. 每 10 条消息后需要主动发一次消息（否则通道会被挂起）；
 * 4. 每 24 小时至少要有一次主动对话。
 * 这四条都是**人**要做的事，插件能做的只有在失败时把原因如实回报。
 */

import { PipelineError, toPipelineError } from '../../contracts/errors.js'
import { makeNotifyMessage } from '../../contracts/push-adapter.js'

/** PushPlus 的公开网关地址（文档里给的 HTTP 入口也是这个 HTTPS 域名）。 */
const ENDPOINT = 'https://www.pushplus.plus/send'

/** 单次请求的超时。推送不是关键路径，卡住比失败更糟。 */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * PushPlus token 在 `ctx.credentials` 里的键名。
 *
 * 与 `QQMAIL_AUTH_CODE` 同一套机制：token 是密钥，不写进明文配置
 * （那份配置会被设置面板渲染出来，也会落进 cordis.patch.yml）。
 */
export const PUSHPLUS_SECRET_REF = 'PUSHPLUS_TOKEN'

/**
 * 造一个 PushPlus 通知适配器。
 *
 * @param {Object} options
 * @param {string} [options.token] PushPlus token（直接给，自测用；生产走 getSecret）
 * @param {(ref: string) => Promise<string | undefined>} [options.getSecret] 读凭据（组合根注入）
 * @param {string} [options.channel] 默认 `clawbot`
 * @param {string} [options.template] 默认 `txt`（富模板在 ClawBot 里只显示前 50 字）
 * @param {string} [options.callbackUrl] 送达回执地址
 * @param {typeof fetch} [options.fetch] 注入用（自测里换成假实现）
 * @param {{debug?: Function, info?: Function, warn?: Function, error?: Function}} [options.log]
 * @returns {import('../../contracts/push-adapter.js').PushAdapter}
 */
export function createPushplusPush (options = {}) {
  const staticToken = typeof options.token === 'string' ? options.token.trim() : ''
  const getSecret = typeof options.getSecret === 'function' ? options.getSecret : null
  const channel = typeof options.channel === 'string' && options.channel.length > 0 ? options.channel : 'clawbot'
  const template = typeof options.template === 'string' && options.template.length > 0 ? options.template : 'txt'
  const callbackUrl = typeof options.callbackUrl === 'string' ? options.callbackUrl.trim() : ''
  const doFetch = options.fetch ?? globalThis.fetch
  const log = options.log ?? {}
  const warn = log.warn ?? (() => {})
  const debug = log.debug ?? (() => {})

  /**
   * 取 token：先看构造期给的，再看凭据。
   *
   * 每次发都重新取，不缓存：人在面板里补填凭据之后，下一封通知就该能用上，
   * 不必重启宿主。凭据读取失败不当成致命错误（和 qqmail 一样），只是这一封发不出去。
   *
   * @returns {Promise<string>} 空串表示没有 token
   */
  async function resolveToken () {
    if (staticToken.length > 0) return staticToken
    if (!getSecret) return ''
    try {
      const fetched = await getSecret(PUSHPLUS_SECRET_REF)
      return typeof fetched === 'string' ? fetched.trim() : ''
    } catch (error) {
      warn('pushplus：读凭据失败（' + PUSHPLUS_SECRET_REF + '）：' + String(error?.message ?? error))
      return ''
    }
  }

  // token 缺失不在构造时抛：插件装上时配置往往是空的，抛在这里会让整个插件挂载失败。
  // 改成第一次真正要发的时候报 auth 错误，票照常跑完、只是通知失败（内核不回滚状态）。
  if (staticToken.length === 0 && !getSecret) warn('pushplus：没有配置 token（也没有注入凭据读取器），通知会全部失败')

  return {
    id: 'pushplus',

    async send (input, signal) {
      const msg = makeNotifyMessage(input)

      const token = await resolveToken()
      if (token.length === 0) {
        throw new PipelineError('auth', `pushplus：没有配置 token，无法推送（在「凭据」页填 ${PUSHPLUS_SECRET_REF}）`)
      }
      if (typeof doFetch !== 'function') {
        throw new PipelineError('internal', 'pushplus：当前运行时没有 fetch')
      }

      const payload = {
        token,
        title: msg.title,
        content: renderContent(msg),
        channel,
        template,
      }
      if (callbackUrl.length > 0) payload.callbackUrl = callbackUrl

      // 外部 signal 与本地超时合成一个，超时也只是「这次没发出去」，不是票失败。
      const controller = new AbortController()
      const onOuterAbort = () => controller.abort(signal?.reason)
      if (signal) {
        if (signal.aborted) throw new PipelineError('aborted', 'pushplus：发送前已取消')
        signal.addEventListener('abort', onOuterAbort, { once: true })
      }
      const timer = setTimeout(() => controller.abort(new Error('pushplus 请求超时')), REQUEST_TIMEOUT_MS)

      try {
        const response = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })

        if (!response.ok) {
          // 5xx 算可重试的内部错误，4xx 算输入有问题（token/参数），不该反复打。
          const kind = response.status >= 500 ? 'internal' : 'invalid-input'
          throw new PipelineError(kind, `pushplus：HTTP ${response.status} ${response.statusText}`)
        }

        /** @type {any} */ let body = null
        try {
          body = await response.json()
        } catch (error) {
          throw new PipelineError('internal', 'pushplus：响应不是合法 JSON', error)
        }

        // 文档：{"code":200,"msg":"请求成功","data":"<流水号>"}
        if (!body || body.code !== 200) {
          const message = body && typeof body.msg === 'string' ? body.msg : '未知错误'
          const kind = body && (body.code === 903 || body.code === 907) ? 'auth' : 'internal'
          throw new PipelineError(kind, `pushplus：${body?.code ?? '?'} ${message}`)
        }

        const traceId = typeof body.data === 'string' ? body.data : undefined
        // 只记 debug：这条日志的意思是「受理了」，不是「送到了」。
        debug(`pushplus：已受理 ${traceId ?? '(无流水号)'} —— 送达与否看 callbackUrl 的 sendStatus`)
        /** @type {import('../../contracts/types.js').PushReceipt} */
        const receipt = { accepted: true }
        if (traceId !== undefined) receipt.traceId = traceId
        return receipt
      } catch (error) {
        // 外层 signal 的 abort 优先按 aborted 报，不要把取消混成网络错误。
        if (signal?.aborted) throw new PipelineError('aborted', 'pushplus：发送被取消', error)
        if (error instanceof PipelineError) throw error
        if (controller.signal.aborted) {
          throw new PipelineError('network', 'pushplus：请求超时（15 秒）', error)
        }
        throw toPipelineError(error, 'network')
      } finally {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onOuterAbort)
      }
    },
  }
}

/**
 * ClawBot 的 `txt` 模板不会渲染 Markdown，链接要原样拼进去才有用。
 *
 * 内核给的正文本身是 Markdown（标题层级、列表、围栏代码块都有），
 * 在 `txt` 模板里这些符号不会消失 —— 它们会以字面形式显示。
 * 这里不试图把 Markdown 转成纯文本（那会丢掉「改动了哪些文件」的缩进结构），
 * 只把最重要的链接提最后一行，保证人一眼能看到 MR 地址。
 *
 * @param {import('../../contracts/types.js').NotifyMessage} msg
 * @returns {string}
 */
function renderContent (msg) {
  if (typeof msg.link === 'string' && msg.link.length > 0 && !msg.body.includes(msg.link)) {
    return `${msg.body}\n\n${msg.link}`
  }
  return msg.body
}

/**
 * 供 `src/index.js` 从配置里摘出本适配器需要的那几个值。
 *
 * **token 不在这里**：它是密钥，走 `ctx.credentials` 的 PUSHPLUS_TOKEN，
 * 由组合根用 getSecret 注入（与 qqmail 的授权码同一套）。
 *
 * @param {import('../core/config.js').validateConfig extends never ? never : any} config
 * @returns {{ channel: string, template: string, callbackUrl: string }}
 */
export function pushplusOptionsFromConfig (config) {
  const pushplus = config?.pushplus ?? {}
  return {
    channel: String(pushplus.channel ?? 'clawbot'),
    // ClawBot 的富模板只显示前 50 字，所以模板恒为 txt —— 不再给用户配。
    template: 'txt',
    callbackUrl: String(pushplus.callbackUrl ?? ''),
  }
}
