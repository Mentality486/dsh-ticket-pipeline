/**
 * `index.js` —— 组合根，也是这个插件唯一的「知道所有具体实现」的地方。
 *
 * 分层（见 `docs/ticket-pipeline/architecture.md` §10）：
 *
 *   contracts/  纯接口与数据，彼此单向依赖，不 import 任何具体适配器
 *   core/       内核：scheduler / store / recover / prompt / config / domain
 *   adapters/   每个平台一个目录，各自实现一个接口
 *   tools/      对用户可见的两个工具
 *   index.js    把上面这些用静态注册表拼起来，注册轮询与工具
 *
 * 可替换点的唯一依据是 `SOURCES` / `EXECUTORS` / `PUSHES` 三张静态表。
 * 换平台 = 在对应目录写一个实现 + 在表里加一行，**内核一行都不用改**。
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

import { createMockSource } from './adapters/source-mock/index.js'
import { createFeishuSource, feishuOptionsFromMatch } from './adapters/source-feishu/index.js'
import { createWpsSource } from './adapters/source-wps/index.js'
import { createTableLocator } from './adapters/locator-table/index.js'
import { createMockExecutor } from './adapters/executor-mock/index.js'
import { createAgentExecutor } from './adapters/executor-agent/index.js'
import { createMockPush } from './adapters/push-mock/index.js'
import { createPushplusPush, pushplusOptionsFromConfig } from './adapters/push-pushplus/index.js'

import { createPipelineScanTool } from './tools/pipeline-scan.js'
import { createPipelineStatusTool } from './tools/pipeline-status.js'

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
export const inject = ['tools', 'storageDomain']

/**
 * 配置 schema（standard-schema 形状，见 `core/config.js`）。
 * cordis 的 `resolveConfig` 只调 `Config['~standard'].validate`，同步返回
 * `{ value }` 或 `{ issues }`。
 */
export { Config }

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
 * @type {Record<string, (opts: any) => import('./contracts/ticket-source.js').TicketSource>}
 */
export const SOURCES = {
  mock: (opts) => createMockSource(opts),
  feishu: (opts) => createFeishuSource(opts),
  wps: (opts) => createWpsSource(opts),
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
}

/**
 * 从 ctx 造一个「能跑 git 命令」的函数，供 `prepareWorkspace` / `removeWorktree` /
 * `checkWorktreeByGit` 用。`subprocess` 服务若不存在则返回 null。
 *
 * @param {any} ctx
 * @returns {(argv: string[], opts?: { cwd?: string }) => Promise<{ code: number, stdout: string, stderr: string }> | null}
 */
function makeGitRunner (ctx) {
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
 * 组合根入口。
 *
 * 启动顺序：
 * 1. 打开 storage-domain、包成 `TicketStore`
 * 2. 遍历 `config.projects[]` 按平台造每个项目的工单源；仓库定位器查表化
 * 3. 造 scheduler，注入 `prepareWorkspace` / `saveImage` / `removeWorktree`
 * 4. 注册两个工具（`pipeline_scan` / `pipeline_status`）
 * 5. 启动恢复：把跑到一半的票从当前 phase 往后接着走
 * 6. 起轮询定时器（`ctx.interval`），`enabled` 关着时 tick 会直接 `disabled`
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} config 已经过 `Config` 校验（含默认值）
 */
export async function apply (ctx, config) {
  const logger = ctx.logger?.() ?? ctx.logger ?? {
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
    const factory = SOURCES[platform]
    if (!factory) {
      log('项目配置了未知平台，跳过', { project: project.name, platform })
      continue
    }
    /** @type {Record<string, unknown>} */
    const sourceOpts = { projectId: project.name }
    if (platform === 'feishu') {
      Object.assign(sourceOpts, feishuOptionsFromMatch(project.match))
      // 适配器自己维护「见过什么」的水位，但水位要落到持久化存储里 ——
      // 否则重启后它会以为所有行都是新票。内核不参与比对（见 contracts/ticket-source.js）。
      sourceOpts.getWatermark = (sourceId) => store.getWatermark(sourceId)
      sourceOpts.saveWatermark = (sourceId, value) => store.saveWatermark(sourceId, value)
      sourceOpts.getSecret = readSecret
      sourceOpts.readLocalFile = readLocalFile
      sourceOpts.safePageRun = Number(config.safePageRun) || 20
      sourceOpts.goneAfterScans = Number(config.goneAfterScans) || 3
    }
    const source = factory(sourceOpts)
    source.projectId = project.name
    sources.push(source)
    log('已挂载工单源', { project: project.name, platform, sourceId: source.id })
  }

  const locator = createTableLocator({ projects })
  const executor = executorFactory({})
  const push = pushFactory(pushAdapterOptions(config, logger))

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
    const baseRef = located?.baseBranch ?? 'main'
    if (!repoPath) {
      throw new Error('定位结果缺少 repoPath，无法建 worktree')
    }

    const branch = `${config.branchPrefix ?? 'ticket-'}${projectId}-${recordId}-r${revisionCount}`

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

  // ── 5. 启动恢复 ───────────────────────────────────────
  try {
    const worktreeExists = async (path) => {
      if (!gitRunner) return true
      return checkWorktreeByGit(gitRunner, path)
    }
    await recoverPending({ store, worktreeExists, log })
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
function pushAdapterOptions (config, logger) {
  if (config.pushAdapter === 'pushplus') {
    return { ...pushplusOptionsFromConfig(config), log: logger }
  }
  return {}
}
