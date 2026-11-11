/**
 * `push-feishu` —— 用飞书自建应用直接给「你」发消息。
 *
 * ## 为什么要这个适配器
 *
 * 原来只有 PushPlus（推到微信）和 QQ 邮箱两条路。PushPlus 在 2026-11-11 被实测卡死在
 * `905 账户未进行实名认证`，而实名要付费；QQ 邮箱能用但通知是邮件，不是即时消息。
 *
 * 用户当时的原话是「为什么都是第三方 推荐使用第三方的吗 不能自己集成吗」—— 说得对：
 * 我们**已经有**一个飞书自建应用（和读工单表用的是同一个），它本来就带 IM 能力。
 * 真机实测（2026-11-11，`cli_aa6074a2dbbadc00`）：
 *
 * - `GET /open-apis/bot/v3/info` → `code:0`，机器人名「Mentality的工作流智能助手」
 * - `POST /open-apis/im/v1/messages?receive_id_type=open_id` → `code:0`、
 *   `message_id: om_…` ⇒ **消息真的发出去了，不经过任何第三方**
 *
 * ## 一个必须知道的坑：230013
 *
 * 第一次拿机器人**自己的** open_id 试发，飞书回 `230013 Bot has NO availability to this user`。
 * 这不是「没有发消息权限」（那样会回 `99991672` + 缺哪个 scope），而是**机器人的「可用范围」
 * 里没有这个人**。机器人只能发给「它所能服务的人」：
 *
 * - 应用后台「应用功能 → 机器人」页里，可用范围要包含目标用户（全员 / 指定部门 / 指定人）；
 * - 通过「添加应用」把机器人加进某个群，那个群的 `chat_id` 就一定可用。
 *
 * 所以本适配器把 `receiveId` 做成必填（面板可填 open_id / email / chat_id），
 * 而不是自作主张去通讯录里猜一个人。猜错会静默发给别人 —— 通知发错人比发不出去更糟。
 *
 * ## 送达语义
 *
 * 与 pushplus 同一条纪律：**HTTP 200 不等于人看到了**。`im/v1/messages` 的 `code:0`
 * 只表示飞书受理了这条消息（返回 `message_id`），已读与否不在这条链路上。
 * `accepted: true` 只严谨地表示「受理」，内核不得据此判断「人已经知道了」。
 */

import { PipelineError, toPipelineError } from '../../contracts/errors.js'
import { makeNotifyMessage } from '../../contracts/push-adapter.js'

/** 飞书开放平台网关。与 `source-feishu` 用的是同一个域名，但凭据走同一套 tenant token。 */
const API_BASE = 'https://open.feishu.cn'

/** 换 tenant_access_token 的路径。 */
const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal'

/** 发消息的路径（`receive_id_type` 是 query 参数，不在 body 里）。 */
const SEND_PATH = '/open-apis/im/v1/messages'

/** 单次请求超时。通知不是关键路径，卡住比失败更糟。 */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * 凭据键名 —— 与 `source-feishu` 复用同一对应用凭据。
 *
 * 为什么复用而不是新造一对：自建应用的 App ID / App Secret 是**应用级**的，
 * 读表和发消息用的是同一个应用（权限是分别开通的）。再让用户填一对「同值但不同名」的
 * 凭据，只会让人以为要建第二个应用。
 */
export const FEISHU_PUSH_APP_ID_REF = 'FEISHU_APP_ID'
export const FEISHU_PUSH_APP_SECRET_REF = 'FEISHU_APP_SECRET'

/**
 * 造一个飞书机器人通知适配器。
 *
 * @param {Object} options
 * @param {string} [options.appId] 直接给（自测用；生产走 getSecret）
 * @param {string} [options.appSecret] 同上
 * @param {(ref: string) => Promise<string | undefined>} [options.getSecret] 读凭据（组合根注入）
 * @param {string} [options.receiveId] 收件人：open_id / email / chat_id（依 receiveIdType）
 * @param {string} [options.receiveIdType] `open_id`（默认）/ `email` / `chat_id`
 * @param {typeof fetch} [options.fetch] 注入用（自测里换成假实现）
 * @param {{debug?: Function, info?: Function, warn?: Function, error?: Function}} [options.log]
 * @returns {import('../../contracts/push-adapter.js').PushAdapter}
 */
export function createFeishuPush (options = {}) {
  const staticAppId = typeof options.appId === 'string' ? options.appId.trim() : ''
  const staticAppSecret = typeof options.appSecret === 'string' ? options.appSecret.trim() : ''
  const getSecret = typeof options.getSecret === 'function' ? options.getSecret : null
  const receiveId = typeof options.receiveId === 'string' ? options.receiveId.trim() : ''
  const receiveIdType = normalizeIdType(options.receiveIdType)
  const doFetch = options.fetch ?? globalThis.fetch
  const log = options.log ?? {}
  const warn = log.warn ?? (() => {})
  const debug = log.debug ?? (() => {})

  /** 进程内缓存的 tenant_access_token，避免每封通知都换一次。 */
  let cachedToken = ''
  let cachedExpireAt = 0

  /**
   * 取应用凭据：先看构造期给的，再看凭据库。每次取都不缓存凭据本身（人可以随时换）。
   *
   * @returns {Promise<{ appId: string, appSecret: string }>}
   */
  async function resolveCreds () {
    let appId = staticAppId
    let appSecret = staticAppSecret
    if ((appId.length === 0 || appSecret.length === 0) && getSecret) {
      if (appId.length === 0) {
        const fetched = await getSecret(FEISHU_PUSH_APP_ID_REF).catch(() => undefined)
        if (typeof fetched === 'string') appId = fetched.trim()
      }
      if (appSecret.length === 0) {
        const fetched = await getSecret(FEISHU_PUSH_APP_SECRET_REF).catch(() => undefined)
        if (typeof fetched === 'string') appSecret = fetched.trim()
      }
    }
    return { appId, appSecret }
  }

  /**
   * 换 tenant_access_token（带进程内缓存）。
   *
   * 为什么缓存：票跑完时可能连续发几条（成功 / 失败 / 回填失败），
   * 每条都换一次 token 既慢又吃限流。飞书给的 `expire` 是秒，通常 7200。
   *
   * @param {AbortSignal} signal
   * @returns {Promise<string>}
   */
  async function getToken (signal) {
    const now = Date.now()
    if (cachedToken.length > 0 && now < cachedExpireAt) return cachedToken

    const { appId, appSecret } = await resolveCreds()
    if (appId.length === 0 || appSecret.length === 0) {
      throw new PipelineError(
        'auth',
        `push-feishu：没有飞书应用凭据，无法发通知（在「凭据」页填 ${FEISHU_PUSH_APP_ID_REF} 与 ${FEISHU_PUSH_APP_SECRET_REF}）`
      )
    }

    const response = await doFetch(`${API_BASE}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal,
    })
    if (!response.ok) {
      throw new PipelineError('network', `push-feishu：换 token 时 HTTP ${response.status} ${response.statusText}`)
    }
    /** @type {any} */
    let body = null
    try {
      body = await response.json()
    } catch (error) {
      throw new PipelineError('internal', 'push-feishu：换 token 的响应不是合法 JSON', error)
    }
    // 坑（与 source-feishu 同一个）：认证接口的响应体**没有 data 包装**，
    // tenant_access_token 在顶层。写成 `body.data.tenant_access_token` 会拿到 undefined。
    if (!body || body.code !== 0 || typeof body.tenant_access_token !== 'string') {
      const message = body && typeof body.msg === 'string' ? body.msg : '未知错误'
      throw new PipelineError('auth', `push-feishu：换 token 失败（${body?.code ?? '?'} ${message}）`)
    }

    cachedToken = body.tenant_access_token
    const expireSeconds = Number(body.expire ?? 7200)
    // 提前 60 秒过期，避开「刚好卡在边界上」的那一次。
    cachedExpireAt = now + Math.max(60, expireSeconds - 60) * 1000
    return cachedToken
  }

  // 收件人缺失不在构造时抛：插件装上时配置往往是空的，抛在这里会让整个插件挂载失败。
  // 改成第一次真正要发的时候报 invalid-input，票照常跑完、只是通知失败。
  if (receiveId.length === 0) warn('push-feishu：没有配置收件人（receiveId），通知会全部失败')

  return {
    id: 'feishu',

    /**
     * @param {import('../../contracts/types.js').NotifyMessage} input
     * @param {AbortSignal} signal
     * @returns {Promise<import('../../contracts/types.js').PushReceipt>}
     */
    async send (input, signal) {
      const msg = makeNotifyMessage(input)

      if (receiveId.length === 0) {
        throw new PipelineError(
          'invalid-input',
          'push-feishu：没有配置收件人 —— 在设置页「参数 → 通知」里填 receiveId（open_id 形如 ou_xxx，或你的邮箱，或群的 chat_id）'
        )
      }
      if (typeof doFetch !== 'function') {
        throw new PipelineError('internal', 'push-feishu：当前运行时没有 fetch')
      }

      // 外部 signal 与本地超时合成一个：超时也只是「这次没发出去」，不是票失败。
      const controller = new AbortController()
      const onOuterAbort = () => controller.abort(signal?.reason)
      if (signal) {
        if (signal.aborted) throw new PipelineError('aborted', 'push-feishu：发送前已取消')
        signal.addEventListener('abort', onOuterAbort, { once: true })
      }
      const timer = setTimeout(() => controller.abort(new Error('push-feishu 请求超时')), REQUEST_TIMEOUT_MS)

      try {
        const token = await getToken(controller.signal)

        const payload = {
          receive_id: receiveId,
          msg_type: 'text',
          // 飞书的文本消息 content 是**字符串化的 JSON**，不是对象。
          // 传对象会被回 `230001 invalid msg_type` 或参数错误。
          content: JSON.stringify({ text: renderText(msg) }),
        }

        const response = await doFetch(
          `${API_BASE}${SEND_PATH}?receive_id_type=${encodeURIComponent(receiveIdType)}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json; charset=utf-8',
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          }
        )

        if (!response.ok) {
          const kind = response.status >= 500 ? 'internal' : 'invalid-input'
          throw new PipelineError(kind, `push-feishu：HTTP ${response.status} ${response.statusText}`)
        }

        /** @type {any} */
        let body = null
        try {
          body = await response.json()
        } catch (error) {
          throw new PipelineError('internal', 'push-feishu：响应不是合法 JSON', error)
        }

        if (!body || body.code !== 0) {
          throw new PipelineError(mapSendErrorKind(body), `push-feishu：${describeSendError(body)}`)
        }

        const messageId = body.data && typeof body.data.message_id === 'string' ? body.data.message_id : undefined
        // 只记 debug：这条日志的意思是「受理了」，不是「人已经看到了」。
        debug(`push-feishu：已受理 ${messageId ?? '(无 message_id)'} —— 送达与否这套接口不回报`)
        /** @type {import('../../contracts/types.js').PushReceipt} */
        const receipt = { accepted: true }
        if (messageId !== undefined) receipt.traceId = messageId
        return receipt
      } catch (error) {
        if (signal?.aborted) throw new PipelineError('aborted', 'push-feishu：发送被取消', error)
        if (error instanceof PipelineError) throw error
        if (controller.signal.aborted) {
          throw new PipelineError('network', 'push-feishu：请求超时（15 秒）', error)
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
 * 归一 `receive_id_type`：只认飞书支持的三种，写错就退回 `open_id`。
 *
 * 为什么不报错：这个值来自配置面板的下拉，面板已经限定了取值；
 * 万一配置文件被手改成怪值，退回默认值比让所有通知全炸更有用。
 *
 * @param {unknown} value
 * @returns {'open_id' | 'email' | 'chat_id'}
 */
export function normalizeIdType (value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (text === 'email') return 'email'
  if (text === 'chat_id' || text === 'chatid') return 'chat_id'
  return 'open_id'
}

/**
 * 把通知消息压成飞书文本消息的正文。
 *
 * 为什么不发富文本卡片：卡片要过审核、要模板 id，且「改动了哪些文件」这类
 * 带缩进的正文在文本里最稳。链接单独提一行，保证人一眼能看到入口。
 *
 * @param {import('../../contracts/types.js').NotifyMessage} msg
 * @returns {string}
 */
function renderText (msg) {
  const head = `【${msg.title}】`
  const body = msg.body
  const link = typeof msg.link === 'string' && msg.link.length > 0 && !body.includes(msg.link) ? `\n\n${msg.link}` : ''
  return `${head}\n${body}${link}`
}

/**
 * 飞书发消息的错误码 → 我们的错误分类。
 *
 * 这张表是从真机和文档里核过的，每一项都注明「人该干什么」——
 * 因为通知失败的下一步永远是「人去改配置」，不是「我们再试一次」。
 *
 * @param {any} body
 * @returns {string}
 */
export function mapSendErrorKind (body) {
  const code = Number(body?.code ?? 0)
  // 凭据 / 应用状态问题：换 token 那一步就会失败，走到这里说明 token 有问题。
  if (code === 99991663 || code === 99991664) return 'auth'
  // 230013：机器人可用范围里没有这个人 —— 这是配置问题（人要去改可用范围），重试无意义。
  if (code === 230013) return 'invalid-input'
  // 230001 / 230002：msg_type / content 形状不对 —— 我们的 bug，但重试也不会好。
  if (code === 230001 || code === 230002) return 'invalid-input'
  // 限流：可以等一下再来。
  if (code === 99991400 || code === 230020) return 'rate-limit'
  // 其余按内部错误处理（可重试），但保留原始 code 供人排查。
  return 'internal'
}

/**
 * 把飞书发消息的错误翻成一句人话 + 一句该干什么。
 *
 * 为什么要拼这么多字：通知失败时人只看到票上一条「发通知失败」，
 * 而真正的原因是「机器人的可用范围没有你」，不去应用后台改就永远不会好。
 * 把错误码和动作写在一起，人不需要再去搜。
 *
 * @param {any} body
 * @returns {string}
 */
export function describeSendError (body) {
  const code = Number(body?.code ?? 0)
  const rawMsg = typeof body?.msg === 'string' ? body.msg : '未知错误'
  if (code === 230013) {
    return `${code} 机器人发不到这个人（${rawMsg}）—— 去飞书开放平台「应用功能 → 机器人」把「可用范围」设成包含你（全员或指定人）；或者把机器人拉进一个群，用群的 chat_id 当收件人`
  }
  if (code === 230001 || code === 230002) {
    return `${code} 消息格式不被接受（${rawMsg}）—— 这是插件侧的问题，请把这条错误报给维护者`
  }
  if (code === 99991663 || code === 99991664) {
    return `${code} 应用凭据无效（${rawMsg}）—— 检查「凭据」页的 FEISHU_APP_ID / FEISHU_APP_SECRET 是否和开放平台一致`
  }
  if (code === 99991400 || code === 230020) {
    return `${code} 发送太频繁被限流（${rawMsg}）—— 稍后会自动重试`
  }
  return `${code === 0 ? '?' : code} ${rawMsg}`
}

/**
 * 供 `src/index.js` 从配置里摘出本适配器需要的那几个值。
 *
 * **应用凭据不在这里**：它们是密钥，走 `ctx.credentials` 的 FEISHU_APP_ID /
 * FEISHU_APP_SECRET，由组合根用 getSecret 注入（与读工单表共用同一对）。
 *
 * @param {any} config
 * @returns {{ receiveId: string, receiveIdType: string }}
 */
export function feishuPushOptionsFromConfig (config) {
  const feishu = config?.feishuPush ?? {}
  return {
    receiveId: String(feishu.receiveId ?? '').trim(),
    receiveIdType: normalizeIdType(feishu.receiveIdType),
  }
}
