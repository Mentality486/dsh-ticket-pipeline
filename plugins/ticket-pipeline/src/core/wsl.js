/**
 * `core/wsl.js` —— 让「仓库路径」也能选 WSL 里的目录。
 *
 * ## 为什么插件自己算，不借 `dsh-wsl-folder`
 *
 * 那个插件的对话框是它自己画在 `shell.overlay` 里的，服务的是「添加工作区」，
 * 它对外只有 5 个私有 HTTP 路由（`/dsh-wsl-folder/*`）。借它的代价是：
 * 只在装了它、且版本对得上时才可用 —— 本插件的「仓库路径」不该有这种额外前提。
 * 所以这里只重写**纯函数那一层**（解析 UNC、拼 UNC、drvfs 反推盘符路径），
 * 不碰它的终端改造与写入补丁。
 *
 * ## 三条事实（2026-11-24 在本机实测，见 `.scratch/_probe-wsl-*.mjs`）
 *
 * 1. `\\wsl.localhost\` 这个**根列不出来**（`ENOENT`）：9P 不提供「有哪些发行版」
 *    这一层。必须先知道发行版名才能拼 UNC —— 所以发行版清单只能问 Windows
 *    （注册表 `HKCU\...\Lxss`，或 `wsl.exe -l -q`）。
 * 2. UNC 上**列目录只要 2 ms**、`git status` 约 1 s、`git stash create` / `worktree
 *    add` / `commit` 全部可用 ⇒ 「在 WSL 检出上跑票」在 git 这一侧没有障碍。
 * 3. `/mnt/<盘符>` 这类 **drvfs 挂载点在 UNC 上列不出来**（`EPERM`），
 *    但它们在 Windows 侧有真实路径（`/mnt/d/a` → `D:\a`）——而且走真实盘符
 *    比走 9P 快得多。所以遇到 drvfs 一律换算成 Windows 路径。
 *
 * ## 一条必须继承的边界
 *
 * `\\wsl.localhost` 上**硬链接不可用**（`ENOTSUP`）。DSH 的本地文件系统新建文件时
 * 走的就是硬链接，所以没装 `dsh-wsl-folder`（或它关了 `write`）时，agent 的写工具
 * 在 WSL 目录里会失败。这里不试图绕开它 —— 那是宿主文件系统层的事；面板会明说。
 */

import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'

/** 认得 `\\wsl.localhost\` 与 `\\wsl$\` 两种共享名。 */
const UNC_HOSTS = ['wsl.localhost', 'wsl$']

/**
 * 发行版名同时是「UNC 的一段路径」和「`wsl.exe` 的一个 argv」，
 * 所以 `.`/`..` 虽合法却永不可能是发行版名（放过去就是路径穿越）。
 */
const DISTRO_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/

/** 一次最多列多少个目录项。WSL 的 `/usr/lib` 之类动辄几千条，全发回去没人看。 */
export const MAX_WSL_ENTRIES = 1000

const DISTRO_TTL_MS = 30_000
const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'

/**
 * `wsl.exe` 的输出是 UTF-16LE，除非它认 `WSL_UTF8`。
 *
 * 判据顺序不能反：**先看 BOM**，再看有没有 NUL 字节。纯中文提示信息里一个
 * ASCII 字符都没有，靠「有没有 NUL」判不出来，但 BOM 一定在。
 *
 * @param {Buffer | undefined | null} buffer
 * @returns {string}
 */
export function decodeWslOutput (buffer) {
  if (!buffer || buffer.length === 0) return ''
  const text = buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE
    ? buffer.toString('utf16le')
    : buffer.includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8')
  return text.replace(/^\uFEFF/, '')
}

/**
 * `\\wsl.localhost\Ubuntu-24.04\home\me` → `{ distro: 'Ubuntu-24.04', path: '/home/me' }`。
 *
 * 认这几种写法：两种共享名、两种斜杠、以及 `\\?\UNC\` 命名空间形式
 * （资源管理器复制路径时会给后者）。
 *
 * @param {unknown} value
 * @returns {{ distro: string, path: string } | undefined}
 */
export function parseWslUnc (value) {
  if (typeof value !== 'string') return undefined
  const plain = value.trim().replace(/^[\\/]{2}[?.][\\/]UNC[\\/]/i, '\\\\')
  const hosts = UNC_HOSTS.map((host) => host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const match = new RegExp(`^[\\\\/]{2}(?:${hosts})[\\\\/]([^\\\\/]+)(?:[\\\\/](.*))?$`, 'i').exec(plain)
  if (match === null) return undefined
  const distro = match[1]
  if (!DISTRO_NAME.test(distro)) return undefined
  const rest = (match[2] ?? '').split(/[\\/]+/).filter(Boolean)
  return { distro, path: normalizeLinuxPath(rest.length === 0 ? '/' : `/${rest.join('/')}`) }
}

/**
 * `Ubuntu-24.04` + `/home/me` → `\\wsl.localhost\Ubuntu-24.04\home\me`。
 *
 * @param {string} distro
 * @param {string} linuxPath
 * @returns {string}
 */
export function toWslUnc (distro, linuxPath) {
  const normalized = normalizeLinuxPath(linuxPath)
  const rest = normalized === '/' ? '' : normalized.slice(1).split('/').join('\\')
  return `\\\\wsl.localhost\\${distro}\\${rest}`
}

/**
 * Linux 路径归一化：必须以 `/` 开头、去掉 `.`/`..`/重复分隔符、不留尾斜杠
 * （根目录除外 —— 它本身就是 `/`）。
 *
 * `..` 要被吃掉而不是保留：这个值最后会拼进 UNC 交给 Windows 文件 API，
 * 留着 `..` 等于让面板能把人带到发行版之外。
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeLinuxPath (value) {
  const raw = String(value ?? '').replace(/\\/g, '/').trim()
  if (raw.length === 0) return '/'
  const normalized = posix.normalize(raw.startsWith('/') ? raw : `/${raw}`)
  const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, '') : '/'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/** 把 Windows 路径统一成 `\\` 分隔、无尾斜杠（UNC 保留开头的两个反斜杠）。 */
function normalizeWindowsPath (value) {
  const raw = String(value ?? '').trim()
  if (raw.length === 0) return ''
  const unified = raw.replace(/\//g, '\\')
  const trimmed = unified.length > 3 ? unified.replace(/\\+$/, '') : unified
  return trimmed
}

/**
 * drvfs 挂载点反推真实 Windows 路径：`/mnt/d/a/b` → `D:\a\b`。
 *
 * 为什么必须换：UNC 视图**不服务** drvfs 挂载点（列 `/mnt/d` 直接 `EPERM`），
 * 而真实盘符路径既能读又能写，还比 9P 快一个数量级。
 *
 * @param {string} linuxPath
 * @param {string} [automountRoot] `/etc/wsl.conf` 的 `[automount] root=`，缺省 `/mnt/`
 * @returns {string | undefined}
 */
export function drvfsWindowsPath (linuxPath, automountRoot = '/mnt/') {
  const configured = String(automountRoot ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const root = `/${configured === '' ? 'mnt' : configured}/`
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped}([a-zA-Z])(?:/(.*))?$`).exec(normalizeLinuxPath(linuxPath))
  if (match === null) return undefined
  const rest = (match[2] ?? '').split('/').filter(Boolean).join('\\')
  return `${match[1].toUpperCase()}:\\${rest}`
}

/**
 * 从 `reg query <Lxss> /s` 的文本里抠出发行版清单。
 *
 * 为什么优先走注册表：**它不起子进程**。`wsl.exe` 每次启动 1–3 秒，
 * 而面板打开时人正等着下拉框出现。
 *
 * @param {string} text
 * @returns {Array<{ name: string, default: boolean, version: number }>}
 */
export function parseLxssRegistry (text) {
  const defaultGuid = /DefaultDistribution\s+REG_SZ\s+(\{[^}]+\})/i.exec(text)?.[1]?.toLowerCase()
  const distros = []
  for (const block of String(text ?? '').split(/\r?\n(?=HKEY_)/)) {
    const guid = /\\Lxss\\(\{[^}]+\})/i.exec(block)?.[1]?.toLowerCase()
    const distroName = /DistributionName\s+REG_SZ\s+([^\r\n]+)/i.exec(block)?.[1]?.trim()
    if (guid === undefined || distroName === undefined || !DISTRO_NAME.test(distroName)) continue
    const version = Number.parseInt(/\bVersion\s+REG_DWORD\s+(0x[0-9a-f]+)/i.exec(block)?.[1] ?? '0x2', 16)
    distros.push({ name: distroName, default: guid === defaultGuid, version })
  }
  return distros
}

/**
 * 从 `wsl.exe -l -v` 的文本里抠发行版清单（注册表读不到时的兜底）。
 *
 * 形如 `* Ubuntu-24.04    Running         2`。
 *
 * @param {string} text
 */
export function parseWslListVerbose (text) {
  const distros = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(\*)?\s*(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(raw)
    if (match === null) continue
    const name = match[2]
    // 表头 `NAME STATE VERSION` 会命中上面这条正则，靠发行版名规则滤掉它。
    if (!DISTRO_NAME.test(name)) continue
    distros.push({ name, default: match[1] === '*', version: Number(match[4]) })
  }
  return distros
}

/**
 * 读 `/etc/wsl.conf` 里的 `[automount] root=`；缺省 `/mnt/`。
 *
 * 只认这一节里的 `root`，其余节原样忽略 —— 这是给 drvfs 换算用的，
 * 不是通用的 INI 解析器。
 *
 * @param {string} text
 * @returns {string}
 */
export function wslAutomountRoot (text) {
  let section = ''
  let quoted = false
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    // 引号里的 `#`/`;` 不是注释（`command = "a; b"` 这种取值要留着）。
    let line = rawLine
    let cut = -1
    quoted = false
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      if (char === '"') quoted = !quoted
      else if (!quoted && (char === '#' || char === ';')) { cut = index; break }
    }
    if (cut >= 0) line = line.slice(0, cut)
    line = line.trim()
    const header = /^\[(.+)\]$/.exec(line)
    if (header !== null) { section = header[1].trim().toLowerCase(); continue }
    if (section !== 'automount') continue
    const pair = /^root\s*=\s*"?([^"]*?)"?\s*$/.exec(line)
    if (pair !== null) {
      const value = pair[1].trim()
      if (value === '') return '/mnt/'
      const trimmed = value.replace(/\/+$/, '')
      return `${trimmed.startsWith('/') ? '' : '/'}${trimmed}/`.replace(/\/+/g, '/')
    }
  }
  return '/mnt/'
}

/**
 * 从 `/etc/passwd` 里找某个用户（或某个 uid）的 home。
 *
 * @param {string} text
 * @param {string | number} [user] 用户名或 uid；都缺省时返回 undefined
 * @returns {string | undefined}
 */
export function passwdHome (text, user) {
  if (user === undefined || user === null) return undefined
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const fields = line.split(':')
    if (fields.length < 7) continue
    if (typeof user === 'string' ? fields[0] === user : Number(fields[2]) === user) {
      const home = fields[5]
      if (typeof home === 'string' && home.startsWith('/')) return normalizeLinuxPath(home)
      return undefined
    }
  }
  return undefined
}

/** 从 `/etc/wsl.conf` 的 `[user] default=` 拿默认用户（WSL 的「不用 root 登录」就靠它）。 */
export function wslDefaultUser (text) {
  let section = ''
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.split('#')[0].split(';')[0].trim()
    const header = /^\[(.+)\]$/.exec(line)
    if (header !== null) { section = header[1].trim().toLowerCase(); continue }
    if (section !== 'user') continue
    const pair = /^default\s*=\s*"?([^"]*?)"?\s*$/.exec(line)
    if (pair !== null && pair[1].trim().length > 0) return pair[1].trim()
  }
  return undefined
}

// ── 起子进程的两处（都可被注入替身，测试里不进真 WSL） ──────────────────────

/**
 * 跑一个命令拿 stdout。**总是拿 Buffer** —— `wsl.exe` 的输出是 UTF-16LE，
 * 让它先按 utf8 解码就是一堆 `\u0000`，事后再也修不回来。
 *
 * @param {string} file
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<Buffer>}
 */
function defaultRun (file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: 'buffer',
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, WSL_UTF8: '1' },
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const message = decodeWslOutput(stderr) || decodeWslOutput(stdout) || error.message
        const failure = new Error(String(message).trim())
        failure.exitCode = typeof error.code === 'number' ? error.code : undefined
        reject(failure)
        return
      }
      resolve(stdout)
    })
  })
}

function wslExe () {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe')
}

let distroCache // { at: number, value: Promise<Array<{name,default,version}>> }

/**
 * 有哪些发行版。注册表优先（不起进程），失败才退 `wsl.exe -l -v`。
 *
 * 失败**不抛**：没装 WSL 是正常情况（大多数人没有），面板只需要知道
 * 「这里没有 WSL」而不是收到一条异常。
 *
 * @param {{ run?: (file: string, args: string[], timeoutMs: number) => Promise<Buffer> }} [options]
 * @returns {Promise<{ available: boolean, distros: Array<{ name: string, default: boolean, version: number }>, note?: string }>}
 */
export async function listWslDistros (options = {}) {
  const run = typeof options.run === 'function' ? options.run : defaultRun
  const now = Date.now()
  if (distroCache !== undefined && now - distroCache.at < DISTRO_TTL_MS) return distroCache.value

  const value = (async () => {
    let registryText = ''
    try {
      registryText = decodeWslOutput(await run('reg.exe', ['query', LXSS_KEY, '/s'], 10_000))
    } catch {
      registryText = ''
    }
    const fromRegistry = parseLxssRegistry(registryText)
    if (fromRegistry.length > 0) return { available: true, distros: fromRegistry }
    try {
      const text = decodeWslOutput(await run(wslExe(), ['-l', '-v'], 20_000))
      const distros = parseWslListVerbose(text)
      if (distros.length > 0) return { available: true, distros }
      return { available: false, distros: [], note: '这台机器的 WSL 里没有任何发行版（`wsl -l -v` 是空的）。' }
    } catch (error) {
      const message = error && error.message ? String(error.message) : String(error)
      return {
        available: false,
        distros: [],
        note: '没读到 WSL 发行版清单（' + message + '）。这台机器可能没装 WSL，或者 `reg.exe` / `wsl.exe` 被策略挡了。',
      }
    }
  })()

  distroCache = { at: now, value }
  // 失败结果不缓存：装好 WSL 之后不必重启插件就能用。
  value.then((result) => { if (result.available !== true) distroCache = undefined }, () => { distroCache = undefined })
  return value
}

/** 测试用：清掉发行版缓存。 */
export function resetWslDistroCache () {
  distroCache = undefined
}

/**
 * 读一个文件，读不到回空串（在 UNC 上探 `/etc/wsl.conf` 这类文件不该抛）。
 * @param {string} path
 */
async function readTextQuietly (path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 解析某个发行版的默认用户 home。
 *
 * 两条路，按「要不要起进程」排序：
 * 1. `/etc/wsl.conf` 的 `[user] default=` → `/etc/passwd` 里查它（两次文件读，几毫秒）；
 * 2. 都没有就问发行版自己要 `$HOME`（起一次 `wsl.exe`，1–3 秒）。
 *
 * @param {string} distro
 * @param {{ run?: (file: string, args: string[], timeoutMs: number) => Promise<Buffer> }} [options]
 */
export async function resolveWslHome (distro, options = {}) {
  const run = typeof options.run === 'function' ? options.run : defaultRun
  const root = `${toWslUnc(distro, '/')}\\`
  const conf = await readTextQuietly(`${root}etc\\wsl.conf`)
  const user = wslDefaultUser(conf)
  if (user !== undefined) {
    const home = passwdHome(await readTextQuietly(`${root}etc\\passwd`), user)
    if (home !== undefined) return home
  }
  try {
    const out = decodeWslOutput(await run(wslExe(), ['-d', distro, '-e', 'sh', '-c', 'printf %s "$HOME"'], 20_000)).trim()
    if (out.startsWith('/')) return normalizeLinuxPath(out)
  } catch {}
  return '/'
}

/**
 * 列一个 WSL 目录里的**子目录**（只列目录：这个面板是拿来挑 git 检出的）。
 *
 * 返回的 `target` 是「应当写进 `repo.path` 的那个路径」：
 * drvfs 挂载点算成真实盘符路径，其余算 UNC。面板不需要自己判断。
 *
 * @param {object} input
 * @param {string} input.distro
 * @param {string} [input.path] 缺省 = 这个发行版的 home
 * @param {{ run?: Function }} [options]
 * @returns {Promise<{ distro: string, path: string, parent: string | null, target: string, entries: Array<{ name: string, path: string, hidden: boolean }>, truncated: boolean, note?: string }>}
 */
export async function listWslDirectory (input, options = {}) {
  const distro = requireDistro(input?.distro)
  const requested = typeof input?.path === 'string' && input.path.trim().length > 0
    ? normalizeLinuxPath(input.path)
    : undefined
  const path = requested ?? await resolveWslHome(distro, options)

  const root = `${toWslUnc(distro, '/')}\\`
  const automountRoot = wslAutomountRoot(await readTextQuietly(`${root}etc\\wsl.conf`))
  const windowsDrive = drvfsWindowsPath(path, automountRoot)
  const source = windowsDrive ?? toWslUnc(distro, path)

  let dirents
  try {
    dirents = await readdir(source, { withFileTypes: true })
  } catch (error) {
    const code = error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'not-found'
      : error?.code === 'EACCES' || error?.code === 'EPERM' ? 'denied'
        : 'unreadable'
    const human = code === 'not-found' ? '这个目录不存在'
      : code === 'denied' ? '没有权限读这个目录'
        : '读不了这个目录'
    return {
      distro,
      path,
      parent: path === '/' ? null : posix.dirname(path),
      target: source,
      entries: [],
      truncated: false,
      note: `${human}（${String(error?.code ?? error?.message ?? error)}）。路径：${path}`,
    }
  }

  const names = []
  const links = []
  for (const dirent of dirents) {
    if (dirent.name === '.' || dirent.name === '..') continue
    if (dirent.isDirectory()) names.push(dirent.name)
    else if (dirent.isSymbolicLink()) links.push(dirent.name)
  }
  // 软链目录要 `stat` 一次才知道能不能进去（`/bin` → `usr/bin` 这种在 Linux 上到处都是）。
  // 只探前 200 个：`/usr/bin` 里几千个软链全探一遍，面板就要等好几秒。
  const base = source.endsWith('\\') ? source : `${source}\\`
  const resolved = await Promise.all(links.slice(0, 200).map(async (name) => {
    try {
      return (await stat(`${base}${name}`)).isDirectory() ? name : null
    } catch {
      return null
    }
  }))
  for (const name of resolved) if (name !== null) names.push(name)

  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))
  const entries = names.slice(0, MAX_WSL_ENTRIES).map((name) => ({
    name,
    path: path === '/' ? `/${name}` : `${path}/${name}`,
    hidden: name.startsWith('.'),
  }))
  const out = {
    distro,
    path,
    parent: path === '/' ? null : posix.dirname(path),
    target: source,
    entries,
    truncated: names.length > MAX_WSL_ENTRIES,
  }
  return out
}

/**
 * 校验并归一发版名。它是 UNC 的一段、也是 `wsl.exe` 的一个 argv，
 * 所以只认 `A-Za-z0-9._-`，且不能是 `.`/`..`。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function requireDistro (value) {
  const name = String(value ?? '').trim()
  if (!DISTRO_NAME.test(name)) {
    throw new Error(`发行版名不合法：${JSON.stringify(String(value))}。只接受字母、数字和 . _ -。`)
  }
  return name
}

/**
 * 这个 `repo.path` 是不是 WSL 目录（UNC 形态）。
 *
 * 用途只有一个：面板与体检要能说清「你这个仓库在 WSL 里」——因为它在
 * 9P 共享上，新建文件走硬链接会 `ENOTSUP`（没装 `dsh-wsl-folder` 时）。
 * `/mnt/d/...` 换算出来的真实盘符路径**不算** WSL 目录：它就在 Windows 盘上。
 *
 * @param {unknown} value
 * @returns {{ distro: string, path: string } | undefined}
 */
export function wslDirectoryOf (value) {
  return parseWslUnc(value)
}

/** 给日志/提示用的一行说明（Windows 路径分隔符统一，方便贴进配置）。 */
export function describeWslTarget (distro, linuxPath) {
  const target = drvfsWindowsPath(linuxPath)
  return target === undefined ? toWslUnc(distro, linuxPath) : normalizeWindowsPath(target)
}
