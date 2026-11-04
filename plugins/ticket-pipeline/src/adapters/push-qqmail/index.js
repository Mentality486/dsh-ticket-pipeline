/**
 * push-qqmail —— 通过 QQ 邮箱 SMTP 把通知发到收件箱。
 *
 * 为什么是邮件而不是 webhook：这个插件跑在人的机器上，「通知」的兜底渠道必须是
 * 一个不依赖任何第三方 bot 授权的东西。PushPlus 那条路要绑 ClawBot、还要人
 * 定期主动发消息（见 push-pushplus 的注释）；邮件没有这些仪式，配一个授权码就能用。
 *
 * 零 npm 依赖是硬约束（本机装不了包）：整条协议用 node:net / node:tls 手写。
 * 手写 SMTP 的风险集中在三处，这里逐一收口：
 *
 * 1. 响应要按行读，不能按 chunk 读。TCP 一次 data 事件可能只给半行，
 *    也可能一次给三行（250- 多行响应的续行）。按 chunk 判「收到 250 了」
 *    会在真机上偶发地把一次响应切成两次，协议当场错位。
 * 2. 授权码绝不进错误文案。授权码是我方主动发出去的东西，出错时最容易被
 *    「把最近发的东西拼进报错」的写法带出去 —— 拼进日志就等于把密码写进磁盘。
 * 3. 每一步都受同一个信号控制。一轮通知卡住，拖的是整轮 tick，
 *    后面排队的票会跟着晚 —— 卡住比失败更糟。
 *
 * 关于 accepted：SMTP 的 250 OK 是「本机已把邮件交给收件方 MTA」，仍不等于
 * 「人看到了」。契约里那条「accepted 不代表送达」在这里同样成立。
 */

import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'

import { PipelineError, toPipelineError } from '../../contracts/errors.js'
import { assertPushAdapter, makeNotifyMessage } from '../../contracts/push-adapter.js'

/**
 * 单次发送的默认超时（毫秒）。
 *
 * 20 秒是「连上 + EHLO + 认证 + DATA + QUIT」整条握手的总预算，不是每一步各自的超时：
 * 每一步单独计时的话，被 abort 的那一刻很容易卡在半条命令上，留下的 socket 状态不可知。
 */
const DEFAULT_TIMEOUT_MS = 20000

/** 响应行的上界。超了说明对端不是 SMTP 或者被投毒了，别把内存耗光。 */
const MAX_RESPONSE_LINE_BYTES = 64 * 1024

/** base64 正文每行多少列。RFC 2045 要求不超过 76，超了对端有概率自动断行坏掉。 */
const BASE64_LINE_WIDTH = 76

/**
 * 允许「未加密就发」的端口白名单。
 *
 * 授权码是明文口令，走明文 SMTP 等于把它广播到链路上。只有本机回环上的
 * 测试端口（开发用的假服务器）可以例外；其它端口必须 TLS 或先 STARTTLS。
 */
const PLAINTEXT_ALLOWED_PORTS = new Set([25, 1025, 1026, 2525, 8025])

/** 读授权码用的凭据键名，与组合根共享，避免两边写歪。 */
export const QQMAIL_SECRET_REF = 'QQMAIL_AUTH_CODE'

/** SMTP 整条握手的超时；导出是为了让自测能拿真值兜底，别写死一个和实现不同的数。 */
export const QQMAIL_TIMEOUT_MS = DEFAULT_TIMEOUT_MS

/** 正文 base64 折行宽度，导出给自测断言用。 */
export const QQMAIL_BASE64_LINE_WIDTH = BASE64_LINE_WIDTH

/**
 * 造一个 QQ 邮箱 SMTP 通知适配器。
 *
 * 缺凭据不在构造期抛：插件装上时配置往往还是空的，抛在这里会让整个插件挂载失败。
 * 改成第一次真要发的时候报 auth —— 票照常跑完，只是这一次通知没出去。
 *
 * options:
 *   host         SMTP 主机，默认 smtp.qq.com
 *   port         端口，默认 465
 *   secure       true = 连上即 TLS（465）；false = 明文连上后 STARTTLS（587）
 *   user         发件邮箱（也是 AUTH LOGIN 的用户名）
 *   to           收件人，多个用逗号分隔
 *   getSecret    (ref) => string|undefined，读授权码（组合根注入，键名 QQMAIL_AUTH_CODE）
 *   authCode     直接给授权码（自测用；生产走 getSecret，免得授权码落进配置文件）
 *   timeoutMs    默认 20000
 *   hostname     EHLO 里自报的主机名，默认取 user 的域名部分
 *   log          { debug, info, warn, error }
 *   transport    注入用（自测里换成假 socket）：connect(cfg) / upgrade(socket, cfg)
 *
 * @param {Object} [options]
 * @returns {import('../../contracts/push-adapter.js').PushAdapter}
 */
export function createQqmailPush (options = {}) {
  const log = options.log ?? {}
  const warn = log.warn ?? (() => {})
  const debug = log.debug ?? (() => {})

  const host = String(options.host ?? 'smtp.qq.com').trim() || 'smtp.qq.com'
  const port = Number(options.port ?? 465) || 465
  const secure = options.secure === undefined ? true : Boolean(options.secure)
  const user = String(options.user ?? '').trim()
  const recipients = splitRecipients(options.to)
  const authCode = typeof options.authCode === 'string' ? options.authCode.trim() : ''
  const getSecret = typeof options.getSecret === 'function' ? options.getSecret : null
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const ehloHostname = sanitizeHostname(options.hostname) || hostnameOf(user) || 'localhost'
  const transport = options.transport ?? defaultTransport

  // 缺什么就在第一次 send 时报什么，构造期只提示一次 —— 提示里不带值，只说不存在。
  if (user.length === 0) warn('qqmail：没有配置发件邮箱（qqmail.user），通知会全部失败')
  else if (recipients.length === 0) warn('qqmail：没有配置收件人（qqmail.to），通知会全部失败')
  else if (authCode.length === 0 && !getSecret) warn('qqmail：没有注入授权码读取器（QQMAIL_AUTH_CODE），通知会全部失败')

  return assertPushAdapter({
    id: 'qqmail',

    async send (input, signal) {
      const msg = makeNotifyMessage(input)

      if (user.length === 0) {
        throw new PipelineError('auth', 'qqmail：没有配置发件邮箱（qqmail.user），无法发信')
      }
      if (recipients.length === 0) {
        throw new PipelineError('auth', 'qqmail：没有配置收件人（qqmail.to），无法发信')
      }
      // 主题直接进头部：换行意味着有人在往头部里塞额外字段（Bcc 之类），必须在发之前拦住。
      assertHeaderSafe(msg.title, '主题')
      if (signal?.aborted) throw new PipelineError('aborted', 'qqmail：发送前已取消')

      // 授权码只在一次发送内存在这个局部变量里，不进任何对外可见的结构。
      let secret = authCode
      if (secret.length === 0) {
        let fetched
        try {
          fetched = await getSecret(QQMAIL_SECRET_REF)
        } catch (error) {
          throw new PipelineError('auth', 'qqmail：读取授权码（QQMAIL_AUTH_CODE）失败', error)
        }
        secret = typeof fetched === 'string' ? fetched.trim() : ''
        if (secret.length === 0) {
          throw new PipelineError('auth', 'qqmail：没有配置授权码（QQMAIL_AUTH_CODE），无法发信')
        }
      }

      const messageId = buildMessageId(user)
      const raw = buildMessage({ from: user, to: recipients, msg, messageId })
      return await deliver({ raw, messageId, signal, secret })
    },
  })

  /**
   * 走一遍 SMTP 会话并把邮件交出去。
   *
   * 这里不做「重连重试」：重试是内核按 kind 决定的（network 可重试、auth 不可），
   * 适配器自己再试一遍会让一次 tick 里同一封信发两次。
   */
  async function deliver ({ raw, messageId, signal, secret }) {
    // 外部 signal 与本地超时合成一个：超时是「这次没发出去」，取消是「不要了」，两者都要断连接。
    const controller = new AbortController()
    const onOuterAbort = () => controller.abort()
    if (signal) signal.addEventListener('abort', onOuterAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onOuterAbort)
    }

    return await new Promise((resolve, reject) => {
      let socket = null
      let settled = false
      // 上一次往对端写出去的是哪条命令，报错时只说命令名，绝不复述内容。
      let lastCommand = '连接'
      let buffer = ''
      let pending = null
      const waiters = []

      const finish = (error, receipt) => {
        if (settled) return
        settled = true
        cleanup()
        controller.signal.removeEventListener('abort', onAbort)
        try { socket?.destroy() } catch { /* 已经关了就算了 */ }
        if (error) reject(error)
        else resolve(receipt)
      }

      // finish 自己出异常时的兜底：异常绝不能从 abort/socket 事件里逃出去，
      // 那会变成 uncaught exception 直接结束进程 —— 一轮通知没发出去不该杀掉整个插件。
      const finishSafely = (error) => {
        if (settled) return
        settled = true
        try { cleanup() } catch {}
        try { socket?.destroy() } catch {}
        try { reject(error) } catch {}
      }

      const onAbort = () => {
        // 外部取消与本地超时要分清：前者是 aborted，后者是 network（可重试）。
        try {
          if (signal?.aborted) finish(new PipelineError('aborted', 'qqmail：发送被取消'))
          else finish(new PipelineError('network', 'qqmail：SMTP 会话超时（' + Math.round(timeoutMs / 1000) + ' 秒）'))
        } catch (error) {
          // finish 只做「藏起来」的动作（reject / destroy），不该往外炸；
          // 但万一它炸了，也不能让异常从 abort 事件里逃出去 —— 那会变成 uncaught 把进程带走。
          finishSafely(error)
        }
      }
      controller.signal.addEventListener('abort', onAbort, { once: true })

      const nextResponse = () => new Promise((resolveStep) => waiters.push(resolveStep))

      const handleResponse = (resp) => {
        const waiter = waiters.shift()
        if (waiter) waiter(resp)
        else finish(new PipelineError('internal', 'qqmail：收到意料之外的响应 ' + resp.code + '（' + lastCommand + '）'))
      }

      const pump = (chunk) => {
        buffer += chunk
        if (buffer.length > MAX_RESPONSE_LINE_BYTES) {
          finish(new PipelineError('network', 'qqmail：' + lastCommand + ' 的响应太长了，对端可能不是 SMTP'))
          return
        }
        let index
        while ((index = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          // 250-xxx 是续行，250 xxx 才是终点；单独一行 250 也算终点。
          const match = /^(\d{3})([ -]?)([\s\S]*)$/.exec(line)
          if (!match) {
            finish(new PipelineError('network', 'qqmail：' + lastCommand + ' 的响应不是 SMTP 状态行'))
            return
          }
          const code = Number(match[1])
          if (match[2] === '-') {
            if (!pending) pending = { code, lines: [] }
            pending.lines.push(match[3])
            continue
          }
          const lines = pending ? [...pending.lines, match[3]] : [match[3]]
          pending = null
          handleResponse({ code, lines })
          if (settled) return
        }
      }

      const send = async (text) => {
        const response = nextResponse()
        lastCommand = commandName(text)
        socket.write(text)
        return await response
      }

      const onError = (error) => finish(toPipelineError(error, 'network'))

      const attach = (target) => {
        target.setEncoding?.('utf8')
        target.on('data', (chunk) => { if (!settled) pump(String(chunk)) })
        target.on('error', onError)
        target.on('close', () => {
          // 对端主动断开也要落成 network，而不是让 Promise 永远挂着。
          if (!settled) finish(new PipelineError('network', 'qqmail：连接在 ' + lastCommand + ' 之后被对端关闭'))
        })
      }

      const detach = (target) => {
        target.removeAllListeners?.('data')
        target.removeAllListeners?.('error')
        target.removeAllListeners?.('close')
      }

      const run = async () => {
        const greeting = await nextResponse()
        if (greeting.code !== 220) throw responseError(greeting)

        let ehlo = await send('EHLO ' + ehloHostname + '\r\n')
        if (ehlo.code !== 250) {
          // EHLO 失败退回 HELO：老服务器只认这个。但那样就没有 AUTH 与 STARTTLS 了。
          const helo = await send('HELO ' + ehloHostname + '\r\n')
          if (helo.code !== 250) throw responseError(helo)
          ehlo = helo
        }

        if (!secure) {
          if (!supportsExtension(ehlo, 'STARTTLS')) {
            if (!PLAINTEXT_ALLOWED_PORTS.has(port)) {
              throw new PipelineError(
                'auth',
                'qqmail：' + host + ':' + port + ' 不支持 STARTTLS，拒绝在明文连接上发送授权码'
                + '（465 = TLS 直连，587 = STARTTLS，请核对 qqmail.port / qqmail.secure）',
              )
            }
            warn('qqmail：本机测试端口 ' + port + ' 不加密直发，生产环境不要这么配')
          } else {
            const start = await send('STARTTLS\r\n')
            if (start.code !== 220) throw responseError(start)
            detach(socket)
            socket = transport.upgrade(socket, { host, rejectUnauthorized: true })
            attach(socket)
            // STARTTLS 之后旧 buffer 必须清空：那段字节属于加密前的通道，
            // 留着会让状态机把加密前残留的内容当成加密后的响应。
            buffer = ''
            pending = null
            ehlo = await send('EHLO ' + ehloHostname + '\r\n')
            if (ehlo.code !== 250) throw responseError(ehlo)
          }
        }

        if (!supportsExtension(ehlo, 'AUTH')) {
          throw new PipelineError('auth', 'qqmail：服务器没有提供 AUTH，无法登录（QQ 邮箱需要开启 SMTP 服务并配置授权码）')
        }

        const auth = await send('AUTH LOGIN\r\n')
        if (auth.code !== 334) throw responseError(auth)
        // 用户名的挑战不校验内容：服务器可能在提示里回显提示语，按顺序应答就够了。
        const userStep = await send(base64Token(user) + '\r\n')
        if (userStep.code !== 334) throw responseError(userStep)
        // 授权码这一步的响应里绝不能带原文；responseError 只带状态码与对端文案。
        const passStep = await send(base64Token(secret) + '\r\n')
        if (passStep.code !== 235) throw responseError(passStep)

        const mailFrom = await send('MAIL FROM:<' + user + '>\r\n')
        if (mailFrom.code !== 250) throw responseError(mailFrom)

        for (const rcpt of recipients) {
          const accepted = await send('RCPT TO:<' + rcpt + '>\r\n')
          // 251 = 收件人不在本地但会转发，同样算收下。
          if (accepted.code !== 250 && accepted.code !== 251) throw responseError(accepted)
        }

        const data = await send('DATA\r\n')
        if (data.code !== 354) throw responseError(data)

        // 正文整封发出：dotStuff 已经把以 . 开头的行转义成 ..，结束符才是唯一的一行 .。
        const body = await send(raw + '\r\n.\r\n')
        if (body.code !== 250) throw responseError(body)

        // QUIT 失败不影响「信已交出去」这个事实，所以只记 debug，不抛。
        try {
          const quit = await send('QUIT\r\n')
          if (quit.code !== 221) debug('qqmail：QUIT 收到 ' + quit.code + '，信已经交出去了')
        } catch (error) {
          debug('qqmail：QUIT 没等到回复，信已经交出去了', error)
        }
        return { accepted: true, traceId: messageId }
      }

      try {
        socket = transport.connect({ host, port, secure })
      } catch (error) {
        finish(toPipelineError(error, 'network'))
        return
      }
      attach(socket)

      run().then(
        (receipt) => finish(null, receipt),
        (error) => finish(error instanceof PipelineError ? error : toPipelineError(error, 'network')),
      )
    })
  }
}

// ── 纯函数（导出给自测直接用）─────────────────────────────

/**
 * 造一封完整的 RFC 5322 邮件：头部 + base64 正文。
 *
 * 头部几件事都不是可选的：
 * - Subject 必须是纯 ASCII（=?UTF-8?B?...?=），否则收件端的网关会按单字节乱码；
 * - Date 少了会被不少反垃圾网关直接判可疑；
 * - Message-ID 是我们唯一能拿来做回执线索的东西，traceId 就返回它。
 *
 * 返回的是已按 CRLF 折行、点转义过的整封信，不含结尾的 . 行。
 *
 * @param {{ from: string, to: string[], msg: import('../../contracts/types.js').NotifyMessage, messageId: string, now?: Date }} input
 * @returns {string}
 */
export function buildMessage ({ from, to, msg, messageId, now = new Date() }) {
  const body = typeof msg.link === 'string' && msg.link.length > 0 && !msg.body.includes(msg.link)
    ? msg.body + '\n\n' + msg.link
    : msg.body

  const headers = [
    'From: ' + encodeAddress(from),
    'To: ' + to.map(encodeAddress).join(', '),
    'Subject: ' + encodeHeaderText(msg.title),
    'Date: ' + formatDate(now),
    'Message-ID: ' + messageId,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ]

  return dotStuff(headers.join('\r\n') + '\r\n\r\n' + base64Lines(body))
}

/**
 * 主题按 RFC 2047 编码。
 *
 * 纯 ASCII 且不含可疑字符时原样发，可读性更好；其余一律转成
 * =?UTF-8?B?...?= —— 中文主题不转码的话，不少邮件网关会把它当单字节重排成乱码。
 *
 * @param {string} text
 * @returns {string}
 */
export function encodeHeaderText (text) {
  assertHeaderSafe(text, '主题')
  if (/^[\x20-\x7e]*$/.test(text)) return text
  // 单段 encoded-word 解码后不超过 45 字节（base64 后 60 字符，留在 RFC 2047 的 75 以内）；
  // 超了拆成多段用空白续接，收件端会把相邻的 encoded-word 拼回去。
  const chunks = []
  const bytes = Buffer.from(text, 'utf8')
  for (let offset = 0; offset < bytes.length; offset += 45) {
    chunks.push('=?UTF-8?B?' + bytes.subarray(offset, offset + 45).toString('base64') + '?=')
  }
  return chunks.join('\r\n ')
}

/**
 * 头部值里不允许出现的字符：CR/LF 是头部注入，NUL 没有合法语义。
 *
 * 单独导出是为了让自测能直接打这个点，而不是等到整条 SMTP 会话里才发现。
 *
 * @param {string} value
 * @param {string} label
 */
export function assertHeaderSafe (value, label) {
  if (/[\r\n\u0000]/.test(String(value))) {
    throw new PipelineError('invalid-input', 'qqmail：' + label + '里不能有换行（会把额外的头部字段注入进去）')
  }
}

/**
 * UTF-8 → base64，并按 76 列折行。
 * @param {string} text
 * @returns {string}
 */
export function base64Lines (text) {
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  const lines = []
  for (let offset = 0; offset < encoded.length; offset += BASE64_LINE_WIDTH) {
    lines.push(encoded.slice(offset, offset + BASE64_LINE_WIDTH))
  }
  return lines.join('\r\n')
}

/**
 * SMTP 的点转义：以 . 开头的行要再加一个 .，
 * 否则正文里恰好有一行等于 . 时会提前结束 DATA，剩下的内容变成命令注入。
 * @param {string} text
 * @returns {string}
 */
export function dotStuff (text) {
  return text.replace(/^\./gm, '..')
}

/**
 * 供 src/index.js 从配置里摘出本适配器需要的那几个值。
 *
 * 授权码不在这里：它在 ctx.credentials 的 QQMAIL_AUTH_CODE 下，
 * 由组合根用 getSecret 注入 —— 密钥不落进明文配置（那份配置会被设置面板显示出来）。
 *
 * @param {any} config
 * @returns {{ host: string, port: number, secure: boolean, user: string, to: string }}
 */
export function qqmailOptionsFromConfig (config) {
  const qqmail = config?.qqmail ?? {}
  const port = Number(qqmail.port ?? 465)
  return {
    host: String(qqmail.host ?? 'smtp.qq.com'),
    port: Number.isFinite(port) && port > 0 ? port : 465,
    // secure 默认 true：漏配时宁可连 465 失败，也不要静默默认走明文。
    secure: qqmail.secure === undefined ? true : Boolean(qqmail.secure),
    user: String(qqmail.user ?? '').trim(),
    to: String(qqmail.to ?? '').trim(),
  }
}

// ── 内部工具 ───────────────────────────────────────────────

/** 默认传输层。自测里换成假 socket，所以连接细节都收在这一个对象里。 */
const defaultTransport = {
  connect ({ host, port, secure }) {
    return secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
      : net.connect({ host, port })
  },
  upgrade (socket, { host }) {
    return tls.connect({ socket, servername: host, rejectUnauthorized: true })
  },
}

/**
 * AUTH LOGIN 的一行应答：整段 base64，不带折行。
 *
 * 不能复用 base64Lines —— 那个会折行，折了之后用户名/授权码被拆成两行，
 * 服务器拿到的是半截口令，表现成「授权码明明是对的却一直 535」。
 *
 * @param {string} text
 */
function base64Token (text) {
  return Buffer.from(String(text), 'utf8').toString('base64')
}

/** 报错时只露命令名（MAIL/RCPT/AUTH 之类）。 */
function commandName (text) {
  const head = String(text).split(/[\s:]/)[0].toUpperCase()
  return head === '' ? '发送' : head
}

/**
 * 把对端的错误状态码翻成可决策的 kind。
 *
 * - 530/534/535/538 = 认证没通过：授权码错或 SMTP 服务没开，重试没用
 * - 421/450/451/452 = 临时失败：交给内核按 network 重试
 * - 550/551/553/554 = 收件人被拒 / 不给发信：配置问题，重试也没用
 *
 * @param {{ code: number, lines: string[] }} response
 */
function responseError (response) {
  const code = response.code
  const detail = cleanServerText(response.lines)
  if (code >= 500) {
    const authFailed = code === 530 || code === 534 || code === 535 || code === 538
    const hint = authFailed ? '（授权码不对，或 QQ 邮箱没有开启 SMTP 服务）' : ''
    const kind = authFailed ? 'auth' : 'invalid-input'
    return new PipelineError(kind, ('qqmail：服务器拒绝 ' + code + ' ' + detail + hint).trim())
  }
  return new PipelineError('network', ('qqmail：服务器返回 ' + code + ' ' + detail).trim())
}

/** 对端文案可能很长（多行），截断给人类看就够了。 */
function cleanServerText (lines) {
  return lines.filter(Boolean).join(' ').replace(/[\r\n]+/g, ' ').slice(0, 200)
}

/** 250-AUTH LOGIN PLAIN → 有没有这个扩展。 */
function supportsExtension (response, name) {
  const upper = String(name).toUpperCase()
  return response.lines.some((line) => {
    const head = String(line).trim().split(/\s+/)[0].toUpperCase()
    return head === upper
  })
}

function splitRecipients (raw) {
  return String(raw ?? '')
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/**
 * EHLO 里自报的主机名必须是纯域名：对端拿它做反向解析，中文或带空格会被直接拒绝。
 * @param {string} user
 */
function hostnameOf (user) {
  const at = user.lastIndexOf('@')
  return at >= 0 ? user.slice(at + 1).toLowerCase() : ''
}

function sanitizeHostname (value) {
  const text = String(value ?? '').trim()
  return /^[A-Za-z0-9.-]+$/.test(text) ? text : ''
}

/** 地址直接进头部，同样要过注入检查。 */
function encodeAddress (address) {
  const text = String(address).trim()
  assertHeaderSafe(text, '地址')
  return text
}

/** RFC 5322 的 Date 是 IMF-fixdate，toUTCString 正好是那个形状。 */
function formatDate (date) {
  return date.toUTCString()
}

/** Message-ID 的域名部分用发件地址的域，免得被收件端当成伪造。 */
function buildMessageId (user) {
  const domain = hostnameOf(user) || 'qq.com'
  return '<' + Date.now().toString(36) + '.' + crypto.randomBytes(8).toString('hex') + '@' + domain + '>'
}
