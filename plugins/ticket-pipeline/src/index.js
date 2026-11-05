/**
 * `index.js` —— 组合根，也是这个插件唯一的「知道所有具体实现」的地方。
 *
 * 分层（见 `docs/ticket-pipeline/architecture.md` §10）：
 *
 *   contracts/  纯接口与数据，彼此单向依赖，不 import 任何具体适配器
 *   core/       内核：scheduler / store / recover / prompt / config / domain
 *   adapters/   每个平台一个目录，各自实现一个接口
 *   tools/      对用户可见的四个工具
 *   index.js    把上面这些用静态注册表拼起来，注册轮询与工具
 *
 * 可替换点的唯一依据是 `SOURCES` / `EXECUTORS` / `PUSHES` 三张静态表。
 * 换平台 = 在对应目录写一个实现 + 在表里加一行，**内核一行都不用改**。
 * 平台专属的依赖（水位、凭据、本地文件、扫描节流）不在组合根里按平台名 if 判断，
 * 而是由适配器在 `SOURCES` 里**声明能力**，`CAPABILITY_ASSEMBLERS` 统一装配 ——
 * 所以「新增平台」连本文件的 `apply()` 也不用动。
 * 仓库定位器（`RepoLocator`）通用化后只有 `table` 一种实现（查 `projects[]`），
 * 不再是一张可替换表，而是直接由配置驱动。
 *
 * 所有依赖的宿主服务都通过 `inject` 声明，由 `ctx` 注入，本文件不 import
 * 任何 `@deepseek-ai/*` 包（它们在插件目录里解析不到，见 `core/config.js`
 * 与 `core/domain.js` 的说明）。宿主服务名核对自 base composition：
 * `tools` / `storageDomain` / `subprocess` / `attachments` / `agents` /
 * `worktrees`（desktop profile bundle 提供）—— 按需 inject。
 */

import { Config } from './core/config.js'
import { makeDomainSpec } from './core/domain.js'
import { TicketStore, makeDomainRepo } from './core/store.js'
import { createScheduler } from './core/scheduler.js'
import { recoverPending, checkWorktreeByGit } from './core/recover.js'
import { UNTRUSTED_TICKET_NOTICE } from './core/prompts.js'
import { sanitizeBranchName } from './core/branch-name.js'
import { PipelineError } from './contracts/errors.js'

import { createMockSource } from './adapters/source-mock/index.js'
import { createFeishuSource, feishuOptionsFromMatch } from './adapters/source-feishu/index.js'
import { createWpsSource } from './adapters/source-wps/index.js'
import { createWebformSource } from './adapters/source-webform/index.js'
import { createTableLocator } from './adapters/locator-table/index.js'
import { createMockExecutor } from './adapters/executor-mock/index.js'
import { createAgentExecutor } from './adapters/executor-agent/index.js'
import { createMockPush } from './adapters/push-mock/index.js'
import { createPushplusPush, pushplusOptionsFromConfig } from './adapters/push-pushplus/index.js'
import { createQqmailPush, qqmailOptionsFromConfig, QQMAIL_SECRET_REF } from './adapters/push-qqmail/index.js'
import { createGitlabClient } from './adapters/gitlab-client/index.js'

import { createPipelineScanTool } from './tools/pipeline-scan.js'
import { createPipelineStatusTool } from './tools/pipeline-status.js'
import { createPipelineCancelTool } from './tools/pipeline-cancel.js'
import { createPipelineResetTool } from './tools/pipeline-reset.js'
import { createPipelineDoctorTool } from './tools/pipeline-doctor.js'
import { TicketPipelineRemote, mountTicketPipelineRemote } from './remote/host.js'

export const name = 'ticket-pipeline'

/**
 * 依赖的宿主服务。
 *
 * `tools` 与 `storageDomain` 是硬依赖（没有它们插件没意义）；`subprocess` 用于
 * git 命令与清理 worktree；`attachments` 用于把截图存成图片块；`agents` 与
 * `worktrees` 是 executor-agent 与 prepareWorkspace 需要的，但因为那两个还是
 * 占位，这里不强依赖 —— 用 `ctx.get(...)` 惰性取，取不到就优雅降级。
 *
 * `credentials`（base composition 已挂 `@deepseek-ai/dsh-credentials-local`）与
 * `fs`（`fs-sandbox` 提供）同理：惰性取。飞书适配器要用它们换 token、读本地
 * 截图；缺了就让飞书那一路报错，不影响其它平台。
 *
 * 不写 `webhookRuntime`：这个 build 里它没有 provider（见 research/dsh-capabilities）。
 */
export const inject = ['tools', 'storageDomain', 'timer']

/**
 * 配置 schema（standard-schema 形状，见 `core/config.js`）。
 * cordis 的 `resolveConfig` 只调 `Config['~standard'].validate`，同步返回
 * `{ value }` 或 `{ issues }`。
 */
export { Config }

/**
 * 能力装配器：每种「内核能替适配器办到的事」对应一个函数，产出的键合进工单源
 * 的构造参数。
 *
 * 为什么要有这层：平台专属注入以前是组合根里一串 `if (platform === 'feishu')`，
 * 新增平台就得回头改组合根，而组合根是最不该常改的地方。现在适配器只在
 * `SOURCES` 里**声明**自己要什么能力，怎么装配由这张表统一负责 ——
 * 新增一种能力 = 这里加一个装配器，新增一个平台 = `SOURCES` 里加一行。
 *
 * 每个装配器签名都是 `(deps) => Record<string, unknown>`，`deps` 见
 * `buildSourceOptions` 的第二个参数。
 *
 * @type {Record<string, (deps: CapabilityDeps) => Record<string, unknown>>}
 */
export const CAPABILITY_ASSEMBLERS = {
  /** 水位：适配器自己判断「见过什么」，但水位必须落到持久化存储里，否则重启后满屏都是新票。 */
  watermark: (deps) => ({
    getWatermark: (sourceId) => deps.store.getWatermark(sourceId),
    saveWatermark: (sourceId, value) => deps.store.saveWatermark(sourceId, value),
  }),
  /** 凭据：密钥不能落进明文配置，只能现取。 */
  secret: (deps) => ({
    getSecret: deps.readSecret,
  }),
  /** 本地文件：路径形态的截图要读本机字节（走文件系统服务，沙箱策略照旧生效）。 */
  localFile: (deps) => ({
    readLocalFile: deps.readLocalFile,
  }),
  /** 扫描节流：连续 N 条已知未变就停、连续 N 轮扫不到就退役，两个数都来自全局配置。 */
  scanTuning: (deps) => ({
    safePageRun: Number(deps.config.safePageRun) || 20,
    goneAfterScans: Number(deps.config.goneAfterScans) || 3,
  }),
}

/**
 * @typedef {Object} CapabilityDeps
 * @property {any} project 项目条目（含 match / repo）
 * @property {any} store `TicketStore`
 * @property {(ref: string) => Promise<string | undefined>} readSecret 凭据读取器
 * @property {(path: string, signal?: AbortSignal) => Promise<{ data: Uint8Array, name?: string }>} readLocalFile
 * @property {Record<string, unknown>} config 已校验的插件配置
 * @property {(msg: string, detail?: unknown) => void} log
 */

/**
 * 按 `SOURCES` 里的能力声明，把一个项目的工单源构造参数装配出来。
 *
 * **没声明的能力一律不注入**：注入多余的东西不会让适配器变强，只会让「这平台
 * 到底依赖什么」越来越说不清，也会把不该给的宿主能力（读本地文件、读密钥）
 * 顺手递给一个根本没这个需求的适配器。
 *
 * 能力名写错（装配器表里没有）时只记日志、跳过 —— 一个平台拼错能力名不该把
 * 整个插件拖垮，但必须在启动日志里看得见。
 *
 * @param {{ capabilities?: string[], factory: (opts: any) => any }} entry `SOURCES` 表里的一行
 * @param {CapabilityDeps} deps
 * @returns {Record<string, unknown>} 交给适配器工厂的构造参数
 */
export function buildSourceOptions (entry, deps) {
  const capabilities = Array.isArray(entry?.capabilities) ? entry.capabilities : []
  const platform = deps.project?.match?.platform ?? ''

  /** @type {Record<string, unknown>} */
  const opts = { projectId: deps.project?.name }

  // 绑定参数先合：能力装配器产出的键优先级更高，不会被 match 里的同名字段盖掉。
  const matchAssembler = entry?.match ?? DEFAULT_MATCH_OPTIONS
  Object.assign(opts, matchAssembler.build(deps.project?.match))

  for (const capability of capabilities) {
    const assembler = CAPABILITY_ASSEMBLERS[capability]
    if (!assembler) {
      deps.log('能力未注册，跳过', { platform, capability })
      continue
    }
    Object.assign(opts, assembler(deps))
  }

  // 记一行已经装配好的能力：排障时能一眼看出这个平台到底拿到了什么，
  // 而不是去翻装配器表反推。
  deps.log('已注入能力', { project: deps.project?.name, platform, capabilities })
  return opts
}

/**
 * 绑定参数装配器：把 `projects[].match` 里属于「这个平台怎么定位那张表」的字段
 * 摘进构造参数。
 *
 * 为什么不放进 `capabilities`：能力是「内核能代办的事」（水位、凭据……），绑定
 * 参数是「平台自己的定位字段」。混在一起，装配器就得认识某个平台的字段名，
 * 以后新平台字段不一样时又得回头改内核。
 *
 * 默认认领 `appToken / tableId / viewId / docNamePattern`，也就是飞书表定位的
 * 那几个键；mock 用不到它们，多给四个空串无副作用。新平台字段不一样时，在
 * `SOURCES` 那一行写 `match` 覆盖即可。
 */
export const DEFAULT_MATCH_OPTIONS = {
  build: (match) => feishuOptionsFromMatch(match),
}

/**
 * 静态注册表。表里的「键」就是 `Config` 里 `workExecutor` / `pushAdapter`
 * 等字段能写的值；「值」是工厂函数（造出对应适配器）。
 *
 * 为什么静态表而不是目录自动发现：打包 `files` 容易漏动态 import 的目录、
 * 构建期静态分析失效、运行时只剩 `MODULE_NOT_FOUND`（架构文档 §10 已论证）。
 *
 * 注意：`SOURCES` 的工厂签名是「按项目条目造实例」，与 `EXECUTORS` / `PUSHES`
 * 的「全局单实例」不同 —— 一个项目一个工单源，但执行器与通知器全局共享。
 *
 * 每行三件事：`capabilities`（要内核提供哪些能力，由 `CAPABILITY_ASSEMBLERS`
 * 装配）、`factory`、可选的 `match`（怎么从 `match` 摘绑定参数）。
 * 新增平台 = 加一个目录 + 这里加一行，组合根其余部分一行都不用改。
 *
 * @type {Record<string, {
 *   capabilities: string[],
 *   factory: (opts: any) => import('./contracts/ticket-source.js').TicketSource,
 *   match?: { build: (match: any) => Record<string, unknown> },
 * }>}
 */
export const SOURCES = {
  // mock 零依赖，只给基本信息就能跑。
  mock: { capabilities: [], factory: (opts) => createMockSource(opts) },
  // 飞书：水位要落盘、密钥现取、截图可能给本地路径、扫描要按全局配置节流。
  feishu: {
    capabilities: ['watermark', 'secret', 'localFile', 'scanTuning'],
    factory: (opts) => createFeishuSource(opts),
  },
  // wps 还没实现，先不声明能力：真接上时按需往里加。
  wps: { capabilities: [], factory: (opts) => createWpsSource(opts) },
  // webform：演示平台（内存表单源），验证「加平台只加目录 + 两行表」。
  webform: { capabilities: [], factory: (opts) => createWebformSource(opts) },
}

/** @type {Record<string, (opts: any) => import('./contracts/work-executor.js').WorkExecutor>} */
export const EXECUTORS = {
  mock: (opts) => createMockExecutor(opts),
  agent: (opts) => createAgentExecutor(opts),
}

/** @type {Record<string, (opts: any) => import('./contracts/push-adapter.js').PushAdapter>} */
export const PUSHES = {
  mock: (opts) => createMockPush(opts),
  pushplus: (opts) => createPushplusPush(opts),
  qqmail: (opts) => createQqmailPush(opts),
}

/**
 * 造一份「不套沙箱」的执行策略，交给宿主 shell。
 *
 * 为什么必须显式给：
 * 宿主的 `SandboxBashExecutor.resolve(request)` 在调用方没有传 `sandboxPolicy` 时，
 * 退回 `ctx.sandboxPolicy.resolve()`（无 session 的调用就落到部署级默认策略）。这种
 * 策略里没有 `sessionId`，而 Windows 的 `windows-acl` 运行器在 sessionId 缺失时
 * **一个写授权 SID 都不发**（源码：`windowsAclRunnerArgv(policy)` 里
 * `if (sessionId === void 0 || policy.mode === "read-only")` 那条分支只传
 * `--workspace/--temp/--mode`）。结果就是子进程只有只读权：git 写
 * `.git/FETCH_HEAD`（lockfile + rename）一律 Permission denied。
 *
 * 传 `danger-full-access` 则是宿主明确支持的旁路：`execute()` 见到这个 mode 直接
 * `super.execute(spec)`，完全跳过 confinement，不需要 sessionId。
 *
 * 安全边界（写进文档的那条）：插件跑的是**用户自己配置的仓库**里的 git 命令，
 * 参数由适配器白名单/转义拼装，命令本身不含工单正文 —— 但这条旁路确实绕过了
 * 按会话的写入准入，所以插件只把它用在 git / verify 命令上，不用于执行模型生成的
 * 任意 shell（执行器侧的命令仍走它自己的策略）。
 *
 * @param {string | undefined} cwd 用作 workspaceRoot；缺省取进程工作目录
 * @returns {{ mode: 'danger-full-access', workspaceRoot: string }}
 */
export function fullAccessSandboxPolicy (cwd) {
  let workspaceRoot = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  // 宿主的 workspaceRoot 只认绝对路径（相对路径会让策略解析直接抛）。
  // 配错的 cwd 不该在策略层炸成看不懂的错——回退到进程目录，真正的路径错误
  // 会由 git -C 自己报出来，那才是用户能看懂的信息。
  const isAbsolutePath = workspaceRoot.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(workspaceRoot) ||
    workspaceRoot.startsWith('\\\\')
  if (!isAbsolutePath) workspaceRoot = process.cwd()
  return { mode: 'danger-full-access', workspaceRoot }
}

/**
 * 猜一个基准分支：配置没写 `repo.baseBranch` 时用。
 *
 * 以前这里硬编码 `'main'`，而实际项目主干常叫别的名字（本机 pms 仓库是 `v2.x`）——
 * 猜错一个名字就让 `git fetch origin main` 直接失败
 * （`fatal: couldn't find remote ref main`），票全挂在第一步，错误里还看不出
 * 是「分支名猜错了」，人会去查权限、查网络，查半天。
 *
 * 顺序：① remote 的 HEAD 指向哪个分支（`git symbolic-ref --short refs/remotes/origin/HEAD`，
 * 克隆时自动带上，最权威）；② 本地当前分支；③ 都拿不到才退回 `main` 并留一条日志。
 *
 * @param {(argv: string[], opts?: { cwd?: string }) => Promise<{ code: number, stdout: string, stderr: string }>} gitRunner
 * @param {string} repoPath
 * @param {(msg: string, detail?: unknown) => void} [log]
 * @returns {Promise<string>}
 */
export async function detectBaseBranch (gitRunner, repoPath, log) {
  const fromRemote = await gitRunner(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoPath })
  if (fromRemote.code === 0) {
    const name = String(fromRemote.stdout ?? '').trim().replace(/^origin\//, '')
    if (name.length > 0) return name
  }
  const fromLocal = await gitRunner(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath })
  if (fromLocal.code === 0) {
    const name = String(fromLocal.stdout ?? '').trim()
    if (name.length > 0 && name !== 'HEAD') return name
  }
  log?.('无法自动判断基准分支，退回 main；建议在项目配置里显式写 repo.baseBranch', { repoPath })
  return 'main'
}

/**
 * 从 ctx 造一个「能跑 git 命令」的函数，供 `prepareWorkspace` / `removeWorktree` /
 * `checkWorktreeByGit` 用。`subprocess` 服务若不存在则返回 null。
 *
 * @param {any} ctx
 * @returns {(argv: string[], opts?: { cwd?: string }) => Promise<{ code: number, stdout: string, stderr: string }> | null}
 */
export function makeGitRunner (ctx) {
  // 首选 `ctx.shell`（宿主 bash 执行器）：它走 bash -c 链路，是 Windows 沙箱下唯一
  // 实际能落地的执行路径；直接 subprocess.spawn 裸 exe 会被本机策略拒（EPERM/ENOENT）。
  let shell = null
  try {
    shell = ctx.get('shell') ?? null
  } catch {
    shell = null
  }
  if (shell && typeof shell.execute === 'function' && typeof shell.resolve === 'function') {
    return async (argv, opts = {}) => {
      // 工作目录用 `git -C <path>` 表达，不用 cd：
      // ①宿主 shell.resolve 会忽略 cwd 字段（git 落在错误目录 → not a git repository）；
      // ②宿主 shell 可能是 PowerShell（不支持 && 语法 → ParserError: InvalidEndOfLine）。
      // git -C 在 bash / PowerShell 下语义一致；路径按单引号转义防注入。
      const cwdArgs = opts.cwd ? ['-C', String(opts.cwd)] : []
      const quoted = ['git', ...cwdArgs, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...argv]
        .map(a => /^[A-Za-z0-9@%+=:,./_-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\''`)}'`)
        .join(' ')
      const command = quoted
      const execution = await shell.execute(shell.resolve({
        command,
        // 体检探 remote 这类网络命令不能等两分钟：调用方可以显式缩短。
        timeoutMs: Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 120000,
        sandboxPolicy: fullAccessSandboxPolicy(opts.cwd),
      }))
      const result = await execution.result()
      return {
        code: result.exitCode ?? 1,
        stdout: result.stdout?.text ?? '',
        stderr: result.stderr?.text ?? '',
      }
    }
  }

  // 兜底：老宿主没有 shell 能力时退回 subprocess.spawn（需要 graceMs 必填）。
  let subprocess = null
  try {
    subprocess = ctx.get('subprocess')
  } catch {
    subprocess = null
  }
  if (!subprocess) return null

  return async (argv, opts = {}) => {
    const git = await subprocess.resolveExecutable('git')
    const child = subprocess.spawn({
      argv: [git, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...argv],
      cwd: opts.cwd,
      env: { GIT_TERMINAL_PROMPT: '0' },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      // 宿主 validateSubprocessSpec 要求 graceMs 必须是正有限数（无默认兜底），缺了直接抛。
      graceMs: 3000,
    })
    const result = await child.done
    const stdout = child.collected?.stdout?.readFrom(0)?.toString?.() ?? ''
    const stderr = child.collected?.stderr?.readFrom(0)?.toString?.() ?? ''
    return { code: result.exitCode ?? 0, stdout, stderr }
  }
}

/**
 * 造一个「从凭据服务读一个值」的函数。
 *
 * 为什么用 `ctx.credentials` 而不是配置文件：飞书 `app_secret` 是密钥，
 * 不能落进 `cordis.patch.yml`（那是明文配置，还会被设置面板显示出来）。
 * 凭据服务提供 `resolve(ref)`（返回 `{ value, source }` 或 `undefined`）与
 * `describe(ref)`（只说配没配，**绝不返回值**）。
 *
 * 注意：`@deepseek-ai/dsh-credentials` 包只在宿主 asar 里，插件目录 import 不到
 * （离线自测会 ERR_MODULE_NOT_FOUND），所以这里只用**普通字符串**当 ref 名 ——
 * `ctx.credentials.resolve('FEISHU_APP_SECRET')` 按字符串键取值，完全可用。
 *
 * @param {any} ctx
 * @returns {(ref: string) => Promise<string | undefined>}
 */
function makeSecretReader (ctx) {
  return async (ref) => {
    let credentials = null
    try {
      credentials = ctx.get('credentials')
    } catch {
      credentials = null
    }
    if (!credentials) return undefined
    const hit = await credentials.resolve(ref)
    if (!hit) return undefined
    const value = typeof hit === 'string' ? hit : hit.value
    return value ? String(value) : undefined
  }
}

/**
 * 造一个「只说配没配、绝不返回值」的凭据描述器，供 pipeline_doctor 用。
 * 宿主 credentials 服务有 describe(ref) 就直接用；没有就用 resolve() 结果映射成布尔。
 *
 * @param {any} ctx
 * @returns {{ describe: (ref: string) => Promise<{ configured: boolean } | undefined> } | null}
 */
function makeCredentialsDescriber (ctx) {
  let credentials = null
  try {
    credentials = ctx.get('credentials')
  } catch {
    credentials = null
  }
  if (!credentials) return null
  return {
    async describe (ref) {
      if (typeof credentials.describe === 'function') {
        const hit = await credentials.describe(ref)
        if (hit) return { configured: Boolean(hit.configured) }
        return { configured: false }
      }
      const hit = await credentials.resolve(ref)
      const value = hit ? (typeof hit === 'string' ? hit : hit.value) : undefined
      return { configured: Boolean(value) }
    },
  }
}

/**
 * 造一个「读本地文件字节」的函数，供路径形态的截图用。
 *
 * 走 `ctx.fs.resolve(path)` → `ctx.fs.readBytes(target, signal, maxBytes)`，
 * 与宿主 `read_image` 工具同一套路径准入（沙箱策略照旧生效）。
 *
 * @param {any} ctx
 * @param {any} logger
 * @returns {(path: string, signal?: AbortSignal) => Promise<{ data: Uint8Array, name?: string }>}
 */
function makeLocalFileReader (ctx, logger) {
  return async (path, signal) => {
    let fs = null
    try {
      fs = ctx.get('fs')
    } catch {
      fs = null
    }
    if (!fs) {
      throw new Error('本机没有挂载文件系统服务，读不了本地截图')
    }
    const target = await fs.resolve(path)
    const data = await fs.readBytes(target, signal, 20 * 1024 * 1024)
    logger.debug?.(`[ticket-pipeline] 读到本地截图 ${target.displayPath ?? path}`)
    return { data, name: target.displayPath ?? path }
  }
}

/**
 * 弱取一个宿主服务：取不到返回 undefined，不抛。
 *
 * 用 `ctx.get(name)` 而不是属性访问 —— 属性访问在未声明 inject 时会抛，
 * 而这些服务（agents / shell / fs）在部分 profile 里本来就可能缺席。
 *
 * @param {any} ctx
 * @param {string} name
 * @returns {any}
 */
function getService (ctx, name) {
  try {
    return ctx.get(name) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * 造一个「跑一条命令」的函数，供 executor-agent 的 verify 用。
 *
 * 与 gitRunner 同一条纪律：走宿主 shell 执行链路（Windows 下裸 spawn 会被拒），
 * 工作目录用各命令自己表达（这里只能给 shell 拼前置 cd 不安全，所以单独提供
 * `cwd` 到 shell 的方式也不可靠）—— 因此改用 shell.execute 前先 resolve。
 *
 * 实现上把命令拼成单行交给宿主 shell，路径与参数统一单引号转义：
 * 这是唯一能在 PowerShell / bash 两种宿主 shell 下都成立的写法。
 *
 * @param {any} ctx
 * @returns {((input: { argv: string[], cwd: string, signal?: AbortSignal }) => Promise<{ code: number, stdout: string, stderr: string }>) | undefined}
 */
export function makeCommandRunner (ctx) {
  const shell = getService(ctx, 'shell')
  if (!shell || typeof shell.execute !== 'function' || typeof shell.resolve !== 'function') {
    return undefined
  }
  return async ({ argv, cwd }) => {
    const [program, ...rest] = argv.map((part) => String(part ?? ''))
    if (!program) {
      throw new PipelineError('invalid-input', '验证命令为空：项目配置里的 verify.build / verify.test 需要写成「命令 参数」的形式。')
    }
    // 命令名（argv[0]）不能加引号：
    // PowerShell 里 'node' 是一段字符串字面量，不是可执行命令，
    // 写成 cd 'x'; 'node' 'y.mjs' 会直接 ParserError（UnexpectedToken）——
    // 这正是上一张票「验证失败（退出码 1）」的真实原因：代码改对了，命令根本没跑起来。
    if (!isPlainShellToken(program)) {
      throw new PipelineError('invalid-input', `验证命令的程序名「${program}」含空格或特殊字符，跨 shell（PowerShell / bash）无法安全转义。请改成 PATH 里可直接调用的命令名（如 node、npm、npx、mvn）。`)
    }
    // 参数也只在必要时加引号：安全 token 原样传，跨 shell 语义一致；
    // 带空格/特殊字符的才单引号包起来（PowerShell 与 bash 都把单引号里的内容当字面量）。
    const quoted = [program, ...rest.map((part) => (isPlainShellToken(part) ? part : quoteShellArg(part)))].join(' ')
    // 用 pushd/popd 不可靠（PowerShell 与 bash 语义不同），统一在子 shell 里换目录：
    // bash 与 PowerShell 都支持 '(' ... ')' 分组吗？—— 不。所以沿用 gitRunner 的做法：
    // 命令本身带 -C 语义做不到（verify 是 npm/npx），改为显式拼 cd 且用 ';' 分隔，
    // PowerShell 支持 ';'，bash 也支持 ';'。
    const command = cwd ? `cd ${quoteShellArg(cwd)}; ${quoted}` : quoted
    // 与 gitRunner 同一条纪律：不带显式策略就会被宿主当成「无 session 的调用」，
    // 拿不到任何写授权，verify 跑 npm test 连 node_modules 缓存都写不进去。
    const execution = await shell.execute(shell.resolve({
      command,
      sandboxPolicy: fullAccessSandboxPolicy(cwd),
    }))
    const result = await execution.result()
    return {
      code: Number(result?.exitCode ?? 0),
      stdout: String(result?.stdout?.text ?? ''),
      stderr: String(result?.stderr?.text ?? ''),
    }
  }
}

/**
 * 单引号转义一个 shell 参数。
 *
 * PowerShell 与 bash 都认单引号字面量；PowerShell 里单引号内的单引号要写成两个。
 *
 * @param {string} value
 * @returns {string}
 */
function quoteShellArg (value) {
  const text = String(value ?? '')
  if (text.length === 0) return "''"
  return `'${text.replace(/'/g, "''")}'`
}

/**
 * 判断一个 token 能否原样交给 shell（不加引号）。
 *
 * 只放行「字母数字与少量安全符号」，这类 token 在 PowerShell 与 bash 下语义一致。
 * 命令名必须走这条路径：PowerShell 里 'node' 是字符串字面量，不是可执行命令。
 *
 * @param {string} value
 * @returns {boolean}
 */
function isPlainShellToken (value) {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(String(value ?? ''))
}

/**
 * 造一个「读文本文件」的函数，供 executor-agent 取要提交的文件内容。
 *
 * 优先走宿主 fs 服务（同一套沙箱准入）；没有 fs 时退到 node:fs。
 *
 * @param {any} ctx
 * @param {any} logger
 * @returns {(path: string) => Promise<string>}
 */
function makeTextFileReader (ctx, logger) {
  return async (path) => {
    const fsService = getService(ctx, 'fs')
    if (fsService && typeof fsService.readBytes === 'function') {
      const target = await fsService.resolve(path)
      const bytes = await fsService.readBytes(target, undefined, 8 * 1024 * 1024)
      return Buffer.from(bytes).toString('utf8')
    }
    const { readFile } = await import('node:fs/promises')
    logger.debug?.(`[ticket-pipeline] 用 node:fs 读文件 ${path}`)
    return readFile(path, 'utf8')
  }
}

/**
 * 组合根入口。
 *
 * 启动顺序：
 * 1. 打开 storage-domain、包成 `TicketStore`
 * 2. 遍历 `config.projects[]` 按平台造每个项目的工单源；仓库定位器查表化
 * 3. 造 scheduler，注入 `prepareWorkspace` / `saveImage` / `removeWorktree`
 * 4. 注册四个工具（`pipeline_scan` / `pipeline_status` / `pipeline_cancel` / `pipeline_reset`）
 * 5. 启动恢复：把跑到一半的票从当前 phase 往后接着走
 * 6. 起轮询定时器（`ctx.interval`），`enabled` 关着时 tick 会直接 `disabled`
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} config 已经过 `Config` 校验（含默认值）
 */
export async function apply (ctx, config) {
  // logger 走 ctx.get 弱取（不声明进 inject）：desktop profile 不一定 provide "logger" 服务，
  // 声明了反而会在 provider 缺席时被 cordis park。sandbox proxy 的 get() 不要求声明，取不到就降级静默。
  const logger = ctx.get('logger') ?? {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
  const log = (msg, detail) => logger.info?.(`[ticket-pipeline] ${msg}`, detail)

  // ── 1. 持久化 ─────────────────────────────────────────
  const domain = await ctx.storageDomain.open(makeDomainSpec())
  // 关闭由调用方负责：插件卸载时把 domain 关上（dsh-mcp-connector 的写法）。
  ctx.effect(() => () => {
    domain.close().catch((error) => logger.error?.(`[ticket-pipeline] 关闭 domain 失败`, error))
  })
  const repo = makeDomainRepo(domain)
  const store = new TicketStore({ repo, log })

  // ── 2. 适配器 ─────────────────────────────────────────
  const executorFactory = EXECUTORS[config.workExecutor ?? 'mock'] ?? EXECUTORS.mock
  const pushFactory = PUSHES[config.pushAdapter] ?? PUSHES.mock

  /** 项目清单（校验后已含 name + match + repo + verify）。 */
  const projects = Array.isArray(config.projects) ? config.projects : []

  /** 每个项目一个工单源。 */
  /** @type {Array<import('./contracts/ticket-source.js').TicketSource & { projectId: string }>} */
  const sources = []

  // 凭据读取器（飞书 app_id / app_secret 走这里）与本地文件读取器（路径形态截图）。
  const readSecret = makeSecretReader(ctx)
  const readLocalFile = makeLocalFileReader(ctx, logger)

  for (const project of projects) {
    const platform = project.match?.platform ?? 'mock'
    const entry = SOURCES[platform]
    if (!entry) {
      // 配置校验已经按 `PLATFORMS` 卡过一道，走到这里说明表与名单不同步。
      // 只记日志跳过、不抛：一个项目配错不该让其它项目的轮询停摆。
      log('项目配置了未知平台，跳过', { project: project.name, platform })
      continue
    }
    // 平台专属的东西（绑定参数 + 声明的能力）全在这里装配，组合根不再认平台名。
    const sourceOpts = buildSourceOptions(entry, { project, store, readSecret, readLocalFile, config, log })
    const source = entry.factory(sourceOpts)
    source.projectId = project.name
    sources.push(source)
    log('已挂载工单源', { project: project.name, platform, sourceId: source.id })
  }

  const locator = createTableLocator({ projects })
  // 执行器选项只传它真正用得上的东西。
  // `prompts` 是内核渲染好的反注入提醒：工单正文本身来自外部（表格里谁都能改），
  // 混进任务书里就成了不可信输入，所以措辞由内核统一给，适配器只管拼在什么位置。
  // 现在还没有执行器真读它，留着是为了让 executor-agent 落地时不必再动组合根。
  const executor = executorFactory({
    prompts: {
      untrustedNotice: UNTRUSTED_TICKET_NOTICE,
    },
    // executor-agent 的宿主依赖：全部惰性/弱取，缺了就由适配器自己优雅降级或报错，
    // 组合根不在这里按平台或执行器名做 if 分支。
    agents: getService(ctx, 'agents'),
    git: makeGitRunner(ctx),
    runCommand: makeCommandRunner(ctx),
    createGitlabClient,
    getSecret: readSecret,
    readFile: makeTextFileReader(ctx, logger),
    log: (message, detail) => logger.info?.(`[ticket-pipeline] ${message}`, detail),
  })
  const push = pushFactory(pushAdapterOptions(config, logger, readSecret))

  // ── 3. scheduler 的宿主钩子 ───────────────────────────
  const gitRunner = makeGitRunner(ctx)

  /**
   * 建 worktree：切新分支并 checkout 到隔离目录。
   *
   * 优先走 `ctx.worktrees.create`（它还会把「调用方 agent」的 cwd 切进去）。
   * 这个插件的 executor-agent 还没实现，所以这里只做「能跑 git」的降级实现；
   * 等 executor-agent 落地时，应当改成：新建 agent → 用该 agent 调
   * `ctx.worktrees.create(agent, { name, from })`，避免把人主会话的 cwd 拽走。
   *
   * 通用化后，仓库路径与基准分支都来自 `located`（按 projectId 查 `projects[]`），
   * 不再读全局 `config.repoPath` / `config.baseRef`。
   *
   * @type {(opts: any) => Promise<{ path?: string, branch?: string, baseCommit?: string, repoPath?: string }>}
   */
  async function prepareWorkspace (opts) {
    if (!gitRunner) {
      log('没有 subprocess，无法建 worktree，本轮只推进阶段不落盘工作区')
      return {}
    }

    const { located, projectId, recordId, revisionCount, fetch } = opts
    const repoPath = located?.repoPath
    if (!repoPath) {
      throw new Error('定位结果缺少 repoPath，无法建 worktree')
    }
    const baseRef = located?.baseBranch ?? await detectBaseBranch(gitRunner, repoPath, log)

    // recordId 来自工单表（外部输入），可能带空格/中文/git 拒绝的字符 —— 统一过清洗器（A5）。
    const branch = `${config.branchPrefix ?? 'ticket-'}${sanitizeBranchName(`${projectId}-${recordId}-r${revisionCount}`)}`

    if (fetch) {
      const fetched = await gitRunner(['fetch', 'origin', baseRef], { cwd: repoPath })
      if (fetched.code !== 0) {
        throw new Error(`git fetch 失败：${fetched.stderr}`)
      }
    }

    // `git worktree add` 等价于 worktree 服务做的事：新分支 + 隔离 checkout。
    const created = await gitRunner(
      ['worktree', 'add', '-b', branch, `.agents/worktrees/${branch}`, baseRef],
      { cwd: repoPath },
    )
    if (created.code !== 0) {
      throw new Error(`git worktree add 失败：${created.stderr}`)
    }

    const revParse = await gitRunner(['rev-parse', 'HEAD'], { cwd: `${repoPath}/.agents/worktrees/${branch}` })
    return {
      path: `${repoPath}/.agents/worktrees/${branch}`,
      branch,
      baseCommit: revParse.stdout.trim(),
      repoPath,
    }
  }

  /**
   * 把截图字节存成图片块。`attachments` 服务不存在时放行（离线跑）。
   * @type {(opts: { data: Uint8Array, mediaType: string, name?: string }) => Promise<unknown>}
   */
  async function saveImage (opts) {
    let attachments = null
    try {
      attachments = ctx.get('attachments')
    } catch {
      attachments = null
    }
    if (!attachments) return undefined
    return attachments.saveImage({ data: opts.data, mediaType: opts.mediaType, name: opts.name })
  }

  /**
   * 清理过期 worktree：`git worktree remove` + `git worktree prune`。
   * @type {(opts: { path: string, branch: string, repoPath?: string }) => Promise<void>}
   */
  async function removeWorktree (opts) {
    if (!gitRunner) return
    const repoPath = opts.repoPath ?? opts.path
    const removed = await gitRunner(['worktree', 'remove', '--force', opts.path], { cwd: repoPath })
    if (removed.code !== 0) {
      log('清理 worktree 失败（下一轮会再试）', { path: opts.path, stderr: removed.stderr })
      return
    }
    await gitRunner(['worktree', 'prune'], { cwd: repoPath })
  }

  const scheduler = createScheduler({
    store,
    sources,
    locator,
    executor,
    push,
    config,
    log,
    prepareWorkspace: gitRunner ? prepareWorkspace : undefined,
    saveImage,
    removeWorktree: gitRunner ? removeWorktree : undefined,
  })

  // ── 4. 工具 ───────────────────────────────────────────
  ctx.tools.register(createPipelineScanTool({ tick: (opts) => scheduler.tick(opts) }))
  ctx.tools.register(createPipelineStatusTool({
    store,
    getConfig: () => config,
  }))
  // 人工取消：内核的 cancelActive 此前没有调用方，人只能干等超时。
  ctx.tools.register(createPipelineCancelTool({
    cancelActive: () => scheduler.cancelActive(),
  }))
  // 人工重开：store.resetByHuman 早就实现了却没有入口，文档承诺的「再跑一次」在生产里走不通。
  ctx.tools.register(createPipelineResetTool({ store }))
  // 环境体检：把「跑票时才炸」的环境问题（git 链路、仓库、凭据、mock 状态）提前到装完就能看到。
  //
  // 同一份 `doctorOptions` 给两个调用方：agent 侧的 `pipeline_doctor` 工具，和
  // GUI 侧（设置页「立即体检」按钮）的宿主 Remote。两边必须看到同一份结论，
  // 所以这里只构造一次、不各写一份。
  const doctorOptions = {
    gitRunner,
    getConfig: () => config,
    credentials: makeCredentialsDescriber(ctx),
    // 「remote 是不是占位符」不能靠域名猜：`gitlab.example.com` 在有些部署里就是真服务器，
    // 猜错会把健康的配置报成问题，也会漏掉真正连不上的地址。这里改成真的去握一次手
    // （`git ls-remote`，只读、不改仓库），连不上才提醒，并把 git 的原话带出来。
    probeRemote: async (remote) => {
      if (!gitRunner) return { ok: false, reason: 'git 执行链路不可用' }
      try {
        const r = await gitRunner(['ls-remote', '--heads', remote], { timeoutMs: 20000 })
        if (r.code === 0) return { ok: true }
        const firstLine = String(r.stderr ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? ''
        return { ok: false, reason: firstLine.slice(0, 200) || ('git ls-remote 退出码 ' + r.code) }
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? error).slice(0, 200) }
      }
    },
    // 基准分支猜错 = fetch 直接失败（fatal: couldn't find remote ref main），
    // 所以体检时就把「实际会用的分支」显出来，而不是等第一张票跑挂。
    detectBaseBranch: (runner, repoPath) => detectBaseBranch(runner, repoPath, log),
  }
  ctx.tools.register(createPipelineDoctorTool(doctorOptions))

  // 宿主 Remote：让插件的设置页能自己触发体检、读配置快照。
  // `typert` 服务缺席时静默跳过（插件其余部分照常工作，工具侧体检不受影响）。
  try {
    const mounted = mountTicketPipelineRemote(ctx, new TicketPipelineRemote({
      getConfig: () => config,
      doctorOptions,
    }))
    if (mounted) log('已挂载 ticketPipeline Remote（设置页可用）')
  } catch (error) {
    log('挂载 Remote 失败（设置页的体检按钮将不可用）', error)
  }

  // ── 5. 启动恢复 ───────────────────────────────────────
  try {
    const worktreeExists = async (path) => {
      if (!gitRunner) return true
      return checkWorktreeByGit(gitRunner, path)
    }
    await recoverPending({ store, worktreeExists, log, now: () => Date.now() })
  } catch (error) {
    log('启动恢复失败（不影响后续轮询）', error)
  }

  // ── 6. 轮询 ───────────────────────────────────────────
  // 一直注册定时器，但 `enabled:false` 时 tick 直接返回 disabled（零副作用）。
  // 回调里必须自己 try/catch：setInterval 抛错会直接炸到 uncaught。
  const intervalMs = Math.max(1, Math.min(60, Number(config.pollIntervalMinutes) || 3)) * 60 * 1000
  ctx.interval(() => {
    scheduler.tick({}).catch((error) => log('轮询这一轮出错了', error))
  }, intervalMs)

  log('ticket-pipeline 已挂载', {
    projects: projects.map((p) => p.name),
    sources: sources.map((s) => s.id),
    executor: executor.id,
    push: push.id,
    enabled: config.enabled,
    pollIntervalMinutes: config.pollIntervalMinutes,
  })
}

/**
 * 按配置拼出 push 适配器的构造参数。
 * @param {Record<string, unknown>} config
 * @param {any} logger
 * @returns {Record<string, unknown>}
 */
function pushAdapterOptions (config, logger, getSecret) {
  if (config.pushAdapter === 'pushplus') {
    return { ...pushplusOptionsFromConfig(config), log: logger }
  }
  if (config.pushAdapter === 'qqmail') {
    // 授权码不进配置文件：构造期只给读凭据的函数，第一次真要发时才去取。
    return {
      ...qqmailOptionsFromConfig(config),
      getSecret: (ref) => getSecret(ref ?? QQMAIL_SECRET_REF),
      log: logger,
    }
  }
  return {}
}
