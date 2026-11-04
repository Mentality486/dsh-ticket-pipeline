/**
 * push-qqmail 适配器的离线检查。
 *
 * 打桩思路：SMTP 是一条「问一句答一句」的协议，所以不需要真的端口 ——
 * 把 transport 换成一个假 socket，记录我们写进去的每一行，再按脚本吐出响应，
 * 就能在毫秒级把整条握手跑完，也不会碰到任何网络。
 *
 * 打桩要守一件事：假 socket 必须像真 socket 一样**分块**吐字节。
 * 一次性吐出完整响应会掩盖「按 chunk 判响应」的 bug —— 那恰好是真机上
 * 最容易出问题的地方（一次 data 事件只给半行）。
 */

import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'

import {
  createQqmailPush,
  buildMessage,
  encodeHeaderText,
  assertHeaderSafe,
  base64Lines,
  dotStuff,
  qqmailOptionsFromConfig,
  QQMAIL_SECRET_REF,
  QQMAIL_TIMEOUT_MS,
  QQMAIL_BASE64_LINE_WIDTH,
} from '../src/adapters/push-qqmail/index.js'
import { PipelineError } from '../src/contracts/errors.js'
import { makeNotifyMessage } from '../src/contracts/push-adapter.js'

/**
 * 把 check 包一层，让「被吞掉的失败」浮出来。
 *
 * 这个文件本身是给 dev-run 用的，而 dev-run 的 check(name, fn) 只是调用 fn，
 * 不看返回值；这里的用例却是 async 的 —— 不包的话，断言失败会变成一个
 * 没人 await 的 rejected promise，检查脚本一路绿着退出。那是比失败更糟的情况：
 * 看着测了，其实什么都没测。
 *
 * @param {(name: string, fn: () => any) => any} check
 * @returns {(name: string, fn: () => any) => Promise<void>}
 */
function observing (check) {
  return async (name, fn) => {
    const result = check(name, fn)
    if (result && typeof result.then === 'function') await result
  }
}

/** 打桩用的发件人、收件人与授权码，全是假值。 */
const FROM = 'someone@qq.com'
const TO = 'reader@example.com'
const AUTH_CODE = 'abcdefghijklmnop'

/**
 * 一个假的 SMTP socket。
 *
 * script 是「收到第 n 条命令就回什么」的函数表：默认按 SMTP 正常顺序应答，
 * 单个用例只覆盖自己关心的那一步，剩下的步骤不用重复写。
 */
class FakeSocket extends EventEmitter {
  constructor (respond) {
    super()
    this.written = ''
    this.destroyed = false
    this.chunks = []
    this._respond = respond
  }

  setEncoding () {}

  write (text) {
    this.written += text
    this.chunks.push(text)
    // 真正的 socket 从不保证在一次 write 后立刻同步回调 data，这里用 microtask 模拟。
    queueMicrotask(() => { if (this.destroyed) return; this._respond(text, this) })
    return true
  }

  /** 像真 socket 那样分段吐字节：默认切成两半，强迫被测方做行缓冲。 */
  emitResponse (text, { split = true } = {}) {
    if (this.destroyed) return
    if (!split || text.length < 2) {
      this.emit('data', text)
      return
    }
    const cut = Math.floor(text.length / 2)
    this.emit('data', text.slice(0, cut))
    this.emit('data', text.slice(cut))
  }

  /** 一次性把所有响应拼成一个字符串发出去。 */
  emitAll (text) { this.emitResponse(text) }

  destroy () {
    this.destroyed = true
  }

  /** 被测方写出去的每一行（去掉 CRLF 与空行）。 */
  lines () {
    return this.written.split('\r\n').filter((line) => line.length > 0)
  }
}

/**
 * 造一个「按脚本应答」的 SMTP 服务端。
 *
 * overrides 里按关键字覆盖某一步的响应，例如 { 'AUTH': '535 5.7.8 认证失败' }。
 * 关键字用命令的首个词，大小写不敏感。
 */
function makeServer (overrides = {}, options = {}) {
  const socketRef = { current: null }
  const sequence = [
    ['GREETING', '220 smtp.qq.com QQ Mail SMTP\r\n'],
    ['EHLO', '250-smtp.qq.com\r\n250-AUTH LOGIN PLAIN\r\n250 STARTTLS\r\n'],
    ['STARTTLS', '220 Ready to start TLS\r\n'],
    ['AUTH', '334 VXNlcm5hbWU6\r\n'],
    ['USER', '334 UGFzc3dvcmQ6\r\n'],
    ['PASS', '235 2.7.0 Authentication successful\r\n'],
    ['MAIL', '250 2.1.0 Ok\r\n'],
    ['RCPT', '250 2.1.5 Ok\r\n'],
    ['DATA', '354 End data with <CR><LF>.<CR><LF>\r\n'],
    ['BODY', '250 2.0.0 Ok: queued as 1234\r\n'],
    ['QUIT', '221 2.0.0 Bye\r\n'],
  ]
  const lookup = new Map(sequence)
  for (const [key, value] of Object.entries(overrides)) lookup.set(key.toUpperCase(), value)

  /** 当前走到哪一步：AUTH LOGIN 之后的三条命令分别是 USER / PASS。 */
  let stage = 'GREETING'
  let authStep = 0
  // 打完招呼之后，下一条命令该配哪一段应答。DATA 之后的整封信单独算一步。
  let dataBody = false

  // 双方各自排队的收发模型：
  //   clientQueue —— 客户端 write() 出来的命令，按顺序排着；
  //   serverQueue —— 服务端要吐的字节，按顺序排着。
  // 每一步都开一个新「回合」再一起结算：先让客户端把命令排上，再让服务端决定回什么，
  // 这样 DATA 之后整封信（几千字节，会写多次）不会被当成好几条命令。
  // 直接在每个 write() 里同步应答是不行的 —— 客户端是边写边等回复的，
  // 同步应答会让它在同一条命令里接着发下一条，回合就错位了。
  const clientQueue = []
  const serverQueue = []
  let pumping = false
  const pump = async () => {
    if (pumping) return
    pumping = true
    try {
      while (clientQueue.length > 0 || serverQueue.length > 0) {
        await Promise.resolve()
        while (serverQueue.length > 0) {
          const chunk = serverQueue.shift()
          socket.emitResponse(chunk, { split: options.split !== false })
        }
        const written = clientQueue.shift()
        if (written === undefined) continue
        await Promise.resolve()
        respond(written)
      }
    } finally {
      pumping = false
      // respond 里可能又排了东西（比如超时用例故意不回），再跑一轮。
      if (clientQueue.length > 0 || serverQueue.length > 0) void pump()
    }
  }

  const respond = (text) => {
    if (dataBody) {
      // 整封信连同结束符是一段：写到 .CRLF 才算 DATA 收尾。
      if (!String(text).endsWith('\r\n.\r\n')) return
      dataBody = false
      replyFor('BODY')
      return
    }
    const command = String(text).split(/[\s:]/)[0].toUpperCase()
    let key
    if (stage === 'AUTH' && authStep === 0 && command !== 'AUTH') { key = 'USER'; authStep = 1 }
    else if (stage === 'AUTH' && authStep === 1 && command !== 'AUTH') { key = 'PASS'; authStep = 2 }
    else if (command === 'EHLO' || command === 'HELO') key = 'EHLO'
    else if (command === 'STARTTLS') key = 'STARTTLS'
    else if (command === 'MAIL') key = 'MAIL'
    else if (command === 'RCPT') key = 'RCPT'
    else if (command === 'DATA') key = 'DATA'
    else if (command === 'QUIT') key = 'QUIT'
    else if (command === 'AUTH') key = 'AUTH'
    else key = 'BODY'
    if (key === 'AUTH') { stage = 'AUTH'; authStep = 0 }
    else if (key === 'PASS') stage = 'PASS'
    else if (key !== 'USER') stage = key
    // DATA 的 354 之后，下一条写进来的就是邮件正文。
    if (key === 'DATA') dataBody = true
    replyFor(key)
  }

  const replyFor = (key) => {
    const reply = lookup.get(key)
    if (typeof reply === 'function') reply(socket, key)
    else if (typeof reply === 'string') serverQueue.push(reply)
    // undefined = 这一步故意不回，用来测超时
  }

  const socket = new FakeSocket((text) => {
    clientQueue.push(text)
    void pump()
  })

  socketRef.current = socket
  const transport = {
    connect () { return socket },
    upgrade () {
      stage = 'GREETING'
      authStep = 0
      dataBody = false
      const upgraded = new FakeSocket(() => {})
      socketRef.current = upgraded
      // 升级后的连接要重新 EHLO：这里预置一条应答，相当于「加密通道已就绪」。
      queueMicrotask(() => {})
      return upgraded
    },
  }

  // 问候语要在 attach 之后才发：真服务器是连上才说话。
  queueMicrotask(() => { replyFor('GREETING'); void pump() })
  return { socket, transport, socketRef }
}

function makeOptions (transport, extra = {}) {
  return {
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    user: FROM,
    to: TO,
    getSecret: async (ref) => { if (ref !== QQMAIL_SECRET_REF) throw new Error('凭据键名错了：' + ref); return AUTH_CODE },
    transport,
    timeoutMs: 2000,
    ...extra,
  }
}

const MESSAGE = makeNotifyMessage({ title: '工单 T-1 已完成', body: '改动了 3 个文件。', level: 'info', link: 'https://example.com/t/1' })

/** 把 PipelineError 的 kind 取出来，失败了也要给出可读断言。 */
function kindOf (error) {
  if (error instanceof PipelineError) return error.kind
  return '非 PipelineError：' + (error?.message ?? String(error))
}

async function expectKind (promise, kind, label) {
  try {
    await promise
  } catch (error) {
    const actual = kindOf(error)
    if (actual !== kind) throw new Error(label + '：期望 kind=' + kind + '，实际 ' + actual)
    return error
  }
  throw new Error(label + '：期望抛 ' + kind + '，实际成功返回了')
}

// ── 纯函数部分 ─────────────────────────────────────────────

function checkPureFunctions () {
  const tasks = []
  tasks.push(['qqmail：主题里的换行会被拒（防头部注入）', () => {
    let thrown = null
    try { assertHeaderSafe('正常\r\nBcc: evil@example.com', '主题') } catch (error) { thrown = error }
    if (!thrown) throw new Error('带换行的主题没有被拒绝')
    if (kindOf(thrown) !== 'invalid-input') throw new Error('拒收主题的 kind 应为 invalid-input，实际 ' + kindOf(thrown))
    // 报错信息本身也不能把那行注入内容复述出去。
    if (thrown.message.includes('evil@example.com')) throw new Error('报错复述了注入内容')
  }])

  tasks.push(['qqmail：中文主题编成 =?UTF-8?B?...?=，纯 ASCII 保持原样', () => {
    const ascii = encodeHeaderText('Deploy finished')
    if (ascii !== 'Deploy finished') throw new Error('纯 ASCII 主题被多余编码：' + ascii)
    const encoded = encodeHeaderText('工单 T-1 已完成')
    if (!encoded.startsWith('=?UTF-8?B?')) throw new Error('中文主题没有按 RFC 2047 编码：' + encoded)
    // 解码回来必须和原文完全一致，否则收件人看到的就是乱码。
    const decoded = encoded
      .split('\r\n ')
      .map((word) => word.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''))
      .map((chunk) => Buffer.from(chunk, 'base64').toString('utf8'))
      .join('')
    if (decoded !== '工单 T-1 已完成') throw new Error('主题编码后解码不一致：' + decoded)
    // 每一段的字面长度都不能超过 RFC 2047 的 75 字符上限。
    for (const word of encoded.split('\r\n ')) {
      if (word.length > 75) throw new Error('encoded-word 超过 75 字符：' + word.length)
    }
  }])

  tasks.push(['qqmail：正文 base64 按 76 列折行', () => {
    const text = '通知正文'.repeat(200)
    const encoded = base64Lines(text)
    for (const line of encoded.split('\r\n')) {
      if (line.length > QQMAIL_BASE64_LINE_WIDTH) throw new Error('有行超过 76 列：' + line.length)
    }
    const decoded = Buffer.from(encoded.replace(/\r\n/g, ''), 'base64').toString('utf8')
    if (decoded !== text) throw new Error('base64 折行后解码不一致')
  }])

  tasks.push(['qqmail：以点开头的行会被点转义，防止提前结束 DATA', () => {
    const stuffed = dotStuff('.这是正文第一行\r\n..已经是两个点\r\n普通行')
    if (!stuffed.startsWith('..这是正文第一行')) throw new Error('点转义没生效：' + stuffed)
    if (!stuffed.includes('\r\n...已经是两个点')) throw new Error('以 .. 开头的行没有被再转义')
    if (!stuffed.includes('\r\n普通行')) throw new Error('普通行被误改')
  }])

  tasks.push(['qqmail：整封信的头部齐全且不含裸 LF', () => {
    const raw = buildMessage({ from: FROM, to: [TO], msg: MESSAGE, messageId: '<abc@qq.com>' })
    for (const header of ['From: ', 'To: ', 'Subject: ', 'Date: ', 'Message-ID: <abc@qq.com>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64']) {
      if (!raw.includes(header)) throw new Error('缺少头部：' + header)
    }
    const [head, body] = raw.split('\r\n\r\n')
    if (body === undefined) throw new Error('头部和正文之间没有空行')
    // 正文里不能有裸 \n：SMTP 只认 CRLF，裸 LF 会被某些服务器当成一行内空白。
    if (/[^\r]\n/.test(raw)) throw new Error('邮件里出现了裸 LF')
    if (!body.includes('https://example.com/t/1')) {
      const decoded = Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')
      if (!decoded.includes('https://example.com/t/1')) throw new Error('链接没有进正文')
    }
  }])

  tasks.push(['qqmail：qqmailOptionsFromConfig 缺省安全（secure 默认 true）且不缺键', () => {
    const empty = qqmailOptionsFromConfig(undefined)
    if (empty.host !== 'smtp.qq.com') throw new Error('默认 host 不对：' + empty.host)
    if (empty.port !== 465) throw new Error('默认 port 不对：' + empty.port)
    if (empty.secure !== true) throw new Error('secure 缺省必须是 true，不能静默走明文')
    if (empty.user !== '' || empty.to !== '') throw new Error('缺省 user/to 应为空串')
    if ('authCode' in empty) throw new Error('配置里不能带授权码，那是凭据不是配置')
    const filled = qqmailOptionsFromConfig({ qqmail: { host: 'smtp.qq.com', port: '587', secure: false, user: ' a@qq.com ', to: 'b@example.com' } })
    if (filled.port !== 587) throw new Error('端口字符串没转成数字')
    if (filled.secure !== false) throw new Error('secure=false 没被尊重')
    if (filled.user !== 'a@qq.com') throw new Error('user 没有 trim：' + JSON.stringify(filled.user))
  }])
  return tasks
}

// ── 协议会话 ───────────────────────────────────────────────

function checkHandshake () {
  const tasks = []
  tasks.push(['qqmail：465 直连走完 EHLO→AUTH LOGIN→MAIL→RCPT→DATA→QUIT 且顺序正确', async () => {
    const { socket, transport } = makeServer()
    const push = createQqmailPush(makeOptions(transport))
    const receipt = await push.send(MESSAGE)
    if (receipt.accepted !== true) throw new Error('receipt.accepted 应为 true')
    if (typeof receipt.traceId !== 'string' || !receipt.traceId.startsWith('<')) throw new Error('traceId 应是 Message-ID：' + receipt.traceId)

    const lines = socket.lines()
    const greeting = lines[0]
    if (!greeting.startsWith('EHLO ')) throw new Error('第一条命令应是 EHLO，实际：' + greeting)
    if (lines[1] !== 'AUTH LOGIN') throw new Error('AUTH 之前必须是 AUTH LOGIN，实际：' + lines[1])
    // AUTH LOGIN 之后先用户名、后授权码，顺序反了会一直 535。
    if (lines[2] !== Buffer.from(FROM, 'utf8').toString('base64')) throw new Error('第二条应是 base64 用户名')
    if (lines[3] !== Buffer.from(AUTH_CODE, 'utf8').toString('base64')) throw new Error('第三条应是 base64 授权码')
    if (lines[4] !== 'MAIL FROM:<' + FROM + '>') throw new Error('MAIL FROM 不对：' + lines[4])
    if (lines[5] !== 'RCPT TO:<' + TO + '>') throw new Error('RCPT TO 不对：' + lines[5])
    if (lines[6] !== 'DATA') throw new Error('DATA 不对：' + lines[6])
    if (lines[lines.length - 1] !== 'QUIT') throw new Error('最后一条应是 QUIT，实际：' + lines[lines.length - 1])
    // 整封信必须原样送到，且以单独一行的 . 收尾。后面还有一条 QUIT，所以看的是写信那一段的尾巴。
    // 注意 QUIT 走的是 send()，会先写 'QUIT\r\n'、超时了才补写 '\r\n'，所以不能按 '\r\nQUIT\r\n' 去找。
    const beforeQuit = socket.written.slice(0, socket.written.lastIndexOf('QUIT\r\n'))
    if (!beforeQuit.endsWith('\r\n.\r\n')) throw new Error('DATA 的结束符不对：' + JSON.stringify(beforeQuit.slice(-20)))
    if (!socket.written.includes('Content-Transfer-Encoding: base64')) throw new Error('正文没有按 base64 编码')
  }])

  tasks.push(['qqmail：多行 EHLO 响应（250- 续行）被正确拼成一条', async () => {
    const { socket, transport } = makeServer({
      EHLO: '250-smtp.qq.com\r\n250-SIZE 73400320\r\n250-8BITMIME\r\n250 AUTH LOGIN PLAIN\r\n',
    })
    const push = createQqmailPush(makeOptions(transport))
    const receipt = await push.send(MESSAGE)
    if (receipt.accepted !== true) throw new Error('多行响应把状态机带偏了')
    // 只发一次 EHLO 就够：被切成多条响应的话会再发一条 HELO。
    const helos = socket.lines().filter((line) => line.startsWith('HELO'))
    if (helos.length > 0) throw new Error('多行响应被当成失败，回退到了 HELO')
  }])

  tasks.push(['qqmail：587 明文连接先 STARTTLS，再在新连接上重新 EHLO', async () => {
    // 这条用例考验的是升级那一刀的交接：
    // 旧 socket 上的监听必须摘干净（否则旧连接的响应会喂给新会话），
    // 新 socket 也得在客户端发第一条命令之前就接好监听（否则回复丢了，整条会话卡到超时）。
    // 两条都翻过车的写法就是「升级后第一条 EHLO 收不到应答」。
    const plain = makeServer()
    const secureSockets = []
    const patched = {
      connect: (cfg) => plain.transport.connect(cfg),
      upgrade: () => {
        // 升级后的加密通道要跑完整条会话（EHLO → AUTH → … → QUIT）。
        // 注意应答必须写在 FakeSocket 的 _respond（write 的回调）里：
        // 只挂 data 监听没人触发 emitResponse，会话必然卡到超时。
        // 这里按关键字给最小应答：AUTH LOGIN 的两步挑战按顺序回 334/334/235。
        let authStep = 0
        let inData = false
        let buf = ''
        const secure = new FakeSocket((text) => {
          buf += String(text)
          // DATA 之后整封信可能分多次 write，攒到 .CRLF 才算收尾。
          if (inData) {
            if (!buf.endsWith('\r\n.\r\n')) return
            inData = false
            secure.emitResponse('250 2.0.0 Ok: queued as 5678\r\n')
            buf = ''
            return
          }
          const command = buf.split(/[\s:]/)[0].toUpperCase()
          buf = ''
          const reply = (line) => secure.emitResponse(line)
          if (command === 'EHLO' || command === 'HELO') reply('250-smtp.qq.com\r\n250 AUTH LOGIN PLAIN\r\n')
          else if (command === 'AUTH') { authStep = 0; reply('334 VXNlcm5hbWU6\r\n') }
          else if (command === 'QUIT') reply('221 2.0.0 Bye\r\n')
          else if (command === 'MAIL' || command === 'RCPT') reply('250 2.1.0 Ok\r\n')
          else if (command === 'DATA') { inData = true; reply('354 End data with <CR><LF>.<CR><LF>\r\n') }
          else if (authStep === 0) { authStep = 1; reply('334 UGFzc3dvcmQ6\r\n') }
          else { authStep = 0; reply('235 2.7.0 Authentication successful\r\n') }
        })
        secureSockets.push(secure)
        return secure
      },
    }
    const push = createQqmailPush(makeOptions(patched, { port: 587, secure: false }))
    const receipt = await push.send(MESSAGE)
    if (receipt.accepted !== true) throw new Error('STARTTLS 流程没走通')
    if (secureSockets.length !== 1) throw new Error('明文端口没有触发 STARTTLS 升级')
    // 加密之后的所有命令都必须走新 socket：旧 socket 上再出现命令说明监听没摘干净。
    const plainCommands = plain.socket.lines()
    const lastPlain = plainCommands[plainCommands.length - 1]
    if (lastPlain !== 'STARTTLS') throw new Error('升级之后还有命令发在明文连接上：' + lastPlain)
  }])

  tasks.push(['qqmail：非白名单端口又不支持 STARTTLS 时拒绝发送授权码', async () => {
    const { transport } = makeServer({ EHLO: '250-smtp.qq.com\r\n250 SIZE 100\r\n' })
    const push = createQqmailPush(makeOptions(transport, { port: 587, secure: false }))
    const error = await expectKind(push.send(MESSAGE), 'auth', '明文无 STARTTLS')
    if (!error.message.includes('STARTTLS')) throw new Error('报错没说明原因：' + error.message)
  }])
  return tasks
}

// ── 错误分支 ───────────────────────────────────────────────

function checkErrorBranches () {
  const tasks = []
  tasks.push(['qqmail：535 认证失败 → auth，且报错里不含授权码', async () => {
    const { transport } = makeServer({ PASS: '535 5.7.8 Error: authentication failed\r\n' })
    const push = createQqmailPush(makeOptions(transport))
    const error = await expectKind(push.send(MESSAGE), 'auth', '535 认证失败')
    if (error.message.includes(AUTH_CODE)) throw new Error('报错里出现了授权码（泄漏）')
    if (error.retryable) throw new Error('auth 不该标记为可重试')
  }])

  tasks.push(['qqmail：没有授权码时构造不抛、send 报 auth', async () => {
    const { transport } = makeServer()
    const push = createQqmailPush(makeOptions(transport, { getSecret: undefined }))
    const error = await expectKind(push.send(MESSAGE), 'auth', '缺授权码')
    if (!error.message.includes('QQMAIL_AUTH_CODE')) throw new Error('报错没指出该配哪个凭据：' + error.message)
  }])

  tasks.push(['qqmail：收件人被拒（550）→ invalid-input，不可重试', async () => {
    const { transport } = makeServer({ RCPT: '550 5.1.1 Mailbox unavailable\r\n' })
    const push = createQqmailPush(makeOptions(transport))
    const error = await expectKind(push.send(MESSAGE), 'invalid-input', 'RCPT 550')
    if (error.retryable) throw new Error('invalid-input 不该标记为可重试')
  }])

  tasks.push(['qqmail：临时失败（451）→ network，可重试', async () => {
    const { transport } = makeServer({ MAIL: '451 4.3.0 Try again later\r\n' })
    const push = createQqmailPush(makeOptions(transport))
    const error = await expectKind(push.send(MESSAGE), 'network', 'MAIL 451')
    if (!error.retryable) throw new Error('network 应标记为可重试')
  }])

  tasks.push(['qqmail：服务器不回话 → 超时 network，且 socket 被销毁', async () => {
    const { transport } = makeServer({ DATA: undefined })
    const push = createQqmailPush(makeOptions(transport, { timeoutMs: 120 }))
    const started = Date.now()
    const error = await expectKind(push.send(MESSAGE), 'network', '超时')
    if (Date.now() - started > 3000) throw new Error('超时没有生效，等太久了')
    if (!error.message.includes('超时')) throw new Error('超时报错没说明原因：' + error.message)
  }])

  tasks.push(['qqmail：外部 signal 取消 → aborted，且不会退化成 network', async () => {
    const { transport } = makeServer({ DATA: undefined })
    const push = createQqmailPush(makeOptions(transport, { timeoutMs: 5000 }))
    const controller = new AbortController()
    const pending = push.send(MESSAGE, controller.signal)
    setTimeout(() => controller.abort(), 30)
    await expectKind(pending, 'aborted', '外部取消')
  }])

  tasks.push(['qqmail：主题含换行 → invalid-input，且一条命令都没发出去', async () => {
    const { socket, transport } = makeServer()
    const push = createQqmailPush(makeOptions(transport))
    const evil = makeNotifyMessage({ title: '正常标题\r\nBcc: evil@example.com', body: '正文' })
    // makeNotifyMessage 可能已经把换行 trim 掉了，这里直接验证适配器自己的闸门。
    await expectKind(push.send({ title: '正常标题\r\nBcc: evil@example.com', body: '正文' }), 'invalid-input', '头部注入')
    const sentAfter = socket.lines().filter((line) => line.startsWith('EHLO') || line.startsWith('AUTH'))
    if (sentAfter.length > 0) throw new Error('被拒的主题怎么已经发到网络上了')
    void evil
  }])

  tasks.push(['qqmail：对端直接断开 → network，不会一直挂着', async () => {
    const { socket, transport } = makeServer({ DATA: (self) => { self.emit('close') } })
    const push = createQqmailPush(makeOptions(transport, { timeoutMs: 5000 }))
    await expectKind(push.send(MESSAGE), 'network', '对端断开')
  }])
  return tasks
}

// ── 对外入口 ───────────────────────────────────────────────

/**
 * 逐个跑一组用例：收集阶段是同步的，断言阶段才 await。
 *
 * 为什么不直接在 section 里调 check()：这些用例都是 async 的，而 check(name, fn)
 * 是否 await fn 的返回值不由我们决定（dev-run 的 check 就不 await）。只要有一个 harness
 * 丢掉那个 promise，断言失败就变成没人管的 rejected promise —— 检查脚本照样绿着退出。
 * 收集-再-执行把控制权收回自己手里，不管外面怎么实现 check 都不会漏。
 *
 * @param {(name: string, fn: () => any) => any} check
 * @param {Array<[string, () => any]>} tasks
 */
async function run (check, tasks) {
  for (const [name, fn] of tasks) await check(name, fn)
}

/**
 * 挂到 dev-run 的用法：runQqmailChecks(check)，与 runFeishuChecks 同形。
 * @param {(name: string, fn: () => any) => any} check
 * @returns {Promise<void>}
 */
export async function runQqmailChecks (check) {
  await run(check, checkPureFunctions())
  await run(check, checkHandshake())
  await run(check, checkErrorBranches())
}

// 直接 node 跑时自带计数与退出码，方便单独验证这一个适配器。
// 用 pathToFileURL 比较而不是拼 'file://' 字符串：Windows 盘符和空格会让手拼的 URL 对不上，
// 对不上就等于整个脚本静默什么都不跑 —— 那种「绿着但没测」最误导人。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let passed = 0
  let failed = 0
  const check = async (name, fn) => {
    try {
      await fn()
      passed += 1
      console.log('  ✓ ' + name)
    } catch (error) {
      failed += 1
      console.log('  ✗ ' + name)
      console.log('    ' + (error?.stack ?? error))
    }
  }
  console.log('纯函数')
  await run(check, checkPureFunctions())
  console.log('')
  console.log('协议会话')
  await run(check, checkHandshake())
  console.log('')
  console.log('错误分支')
  await run(check, checkErrorBranches())
  console.log('')
  console.log('qqmail 检查：通过 ' + passed + ' 项，失败 ' + failed + ' 项')
  process.exit(failed === 0 ? 0 : 1)
}
