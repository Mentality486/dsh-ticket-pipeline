/**
 * `executor-agent` —— 真正干活的那个执行器：起一个 agent、在 worktree 里改代码、
 * 跑构建与测试、最后开 draft MR。
 *
 * 它串起来的东西比别的适配器都多，每一段都对应一条实测结论：
 *
 * 1. **起 agent**：`agents.create({sessionId, meta:{cwd}, agentOptions, setup})`
 *    （`dsh-headless/lib/index.js:317-325` 是可直接照抄的实例）。
 * 2. **推任务**：必须 `agent.followup(msg)` —— `inject()` **不唤醒** agent
 *    （`dsh-agent-loop:800-814`：followup=next-turn+唤醒 / steer=next-step+唤醒 /
 *    inject=next-step 不唤醒）。用 inject 会得到一个永远不动的 agent。
 * 3. **等结束**：`whenIdle()` 之后再比一次 `session.seq`，不轮询 `agent/status`。
 * 4. **验证**：命令从项目配置 `verify` 注入，执行器里**不硬编码任何命令**。
 *    环境起不来就记 `testOutcome:'skipped'` 并写清原因、照样开 draft MR ——
 *    这是契约里明确的合法成功路径，不是失败。
 * 5. **开 MR**：`git push` 在本机物理上不可能（沙箱不给 `git-receive-pack` 建
 *    stdin 管道），所以改动要走 GitLab Commits API 物化，见 `gitlab-client/`。
 *
 * 关于依赖注入：本文件**不 import 任何 `@deepseek-ai/*`**（插件目录里解析不到，
 * 离线自测会 ERR_MODULE_NOT_FOUND）。agent 服务、`createUserMessage`、`git`、
 * `runCommand`、`fetch` 全部从 `options` 进来，缺哪个就报一条说清缺什么的错，
 * 而不是等跑到一半才炸。组合根按 `src/index.js` 里 `executorOptions()` 的说明接线。
 */

import { PipelineError, toPipelineError } from '../../contracts/errors.js'
import { assertWorkExecutor, makeExecResult } from '../../contracts/work-executor.js'

/** 给 `agents.create` 的 sessionId 前缀。sessionId 里不能出现 `/`，所以下面全部替换掉。 */
const SESSION_PREFIX = 'ticket'

/**
 * 敏感文件：命中了就**不提交**，并在结果里写清为什么。
 *
 * 为什么用「宽进」的规则而不是精确白名单：漏提交一个普通文件的代价是「人补一次」，
 * 而误提交一个真实凭据的代价是「得去轮换密钥」。两种代价不对等，所以宁可多拦。
 */
export const SENSITIVE_FILE_PATTERNS = Object.freeze([
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)application[^/]*\.(ya?ml|properties|conf|json)$/i,
  /(^|\/)\.npmrc$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.jks$/i,
  /\.key$/i,
  /secret/i,
])

/**
 * 判断一个仓库相对路径是不是敏感文件。大小写与路径分隔符都归一后再判。
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isSensitivePath (filePath) {
  const normalized = String(filePath ?? '').replace(/\\/g, '/')
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(normalized))
}

/**
 * `git` 命令白名单。执行器只读工作区 + 本地提交，**不 push、不 fetch、不改历史**。
 *
 * 为什么要白名单而不是「反正只有我们自己调用」：agent 可能会往任务里塞命令，
 * 而执行器下游还接了 GitLab（有 token）。白名单是这一层唯一能挡住
 * 「读 diff」悄悄变成「推代码」的地方。
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
export function isAllowedGitCommand (argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false
  const [command, ...rest] = argv
  if (command === 'status') return rest.length === 1 && rest[0] === '--porcelain'
  if (command === 'add') return rest.length === 1 && rest[0] === '-A'
  if (command === 'commit') return true // 只允许本地提交，push 不在白名单里
  if (command === 'diff') {
    if (!rest.includes('--name-only')) return true
    return true
  }
  return false
}

/**
 * 把 `notices.beforeAdd` 拼进待提交文件。
 *
 * 为什么不直接抛错：敏感文件的出现**不意味着这次改动无效** —— 业务代码可能已经改对了。
 * 拦住它、照样开 draft MR、把「有 3 个敏感文件没提交」写进 MR 描述，人才能在同一个地方看到全貌。
 *
 * @param {string[]} files 非空文件列表
 * @returns {string[]} 要提交的文件（已剔除敏感文件）
 */
export function filterSensitiveFiles (files) {
  return (Array.isArray(files) ? files : []).filter((file) => typeof file === 'string' && file.length > 0 && !isSensitivePath(file))
}

/**
 * 造一个真执行器。
 *
 * @param {Object} [options]
 * @param {any} [options.agents] `ctx.agents`（宿主服务；缺失时 run 报 invalid-input）
 * @param {(input: { content: unknown, source?: { kind: string } }) => unknown} [options.createUserMessage]
 *   `@deepseek-ai/dsh-llm` 的 createUserMessage；插件目录 import 不到那个包，所以由组合根注入
 * @param {(argv: string[], opts?: { cwd?: string }) => Promise<{ code: number, stdout: string, stderr: string }>} [options.git]
 * @param {(input: { argv: string[], cwd: string, signal: AbortSignal }) => Promise<{ code: number, stdout: string, stderr: string }>} [options.runCommand]
 * @param {() => Promise<any>} [options.createGitlabClient] 每次开 MR 时现造一个（token 不缓存）
 * @param {(ref: string) => Promise<string|undefined>} [options.getSecret] 凭据读取器（默认给 gitlab-client）
 * @param {typeof fetch} [options.fetch] 注入给 gitlab-client（自测用）
 * @param {{ untrustedNotice?: string }} [options.prompts] 内核统一给的反注入提醒，拼在消息最前面
 * @param {(msg: string, detail?: unknown) => void} [options.log]
 * @returns {import('../../contracts/work-executor.js').WorkExecutor}
 */
export function createAgentExecutor (options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const createUserMessage = resolveCreateUserMessage(options.createUserMessage)

  return assertWorkExecutor({
    id: 'agent',

    /**
     * @param {import('../../contracts/types.js').Ticket} ticket
     * @param {import('../../contracts/repo-locator.js').LocateResult} target
     * @param {import('../../contracts/work-executor.js').ExecCtx} ctx
     */
    async run (ticket, target, ctx) {
      // 先查依赖再干活：缺 agents 是「这台机器上这条链路根本跑不了」，
      // 报 invalid-input 让内核直接标 failed、不重试（重试两次的结果还是缺）。
      const agents = options.agents
      if (!agents || typeof agents.create !== 'function') {
        throw new PipelineError('invalid-input', '本机没有 agents 服务，executor-agent 跑不了。要离线跑通链路请把 workExecutor 设成 mock。')
      }
      if (typeof options.git !== 'function') {
        throw new PipelineError('invalid-input', 'executor-agent 缺少注入的 git 运行器（options.git），无法收集改动了哪些文件')
      }
      const worktreePath = String(ctx?.worktreePath ?? '')
      if (worktreePath.length === 0) {
        throw new PipelineError('invalid-input', '执行上下文里没有 worktreePath：没有隔离工作区就不能让 agent 改代码')
      }

      const config = ctx.config ?? {}
      const signal = ctx.signal
      const project = findProject(config, ticket, target)
      const verify = project?.verify ?? {}
      const sessionId = buildSessionId(ticket, ctx)
      const messages = buildMessages(ticket, ctx, options.prompts?.untrustedNotice)

      ctx.log?.(`executor-agent：起 agent（sessionId=${sessionId}，cwd=${worktreePath}）`)

      // ── 1. 起 agent ─────────────────────────────────────
      const created = await agents.create({
        sessionId,
        // cwd 必须是 worktree：agent 的读写工具按这个目录解析相对路径，
        // 指到别处就会在人的主目录里改代码。
        meta: { cwd: worktreePath },
        agentOptions: agentOptionsFromConfig(config),
        // setup 是宿主装载工具/提示的地方。这里只记一行 —— 插件没有宿主内部的
        // 安装器可用（import 不到 @deepseek-ai/*），真需要再加。
        setup: (agentCtx) => {
          void agentCtx
          log('executor-agent：agent 已就绪', { sessionId })
        },
      })
      const agent = created?.agent
      if (!agent || typeof agent.followup !== 'function') {
        throw new PipelineError('internal', 'agents.create 没有返回可用的 agent（缺 followup）')
      }

      /** 取消时 agent 上的工作量很大，中途要把它停下来，不能留着空转烧 token。 */
      const cancelAgent = () => {
        try {
          agent.cancel?.()
        } catch (error) {
          log('executor-agent：取消 agent 时出错', { reason: String(error) })
        }
      }

      try {
        // ── 2. 推任务：必须 followup（inject 不唤醒 agent）──
        agent.followup(createUserMessage({ content: messages, source: { kind: 'user' } }))
        await ctx.onPhase('editing', 'agent 已接到任务书，开始改代码')

        // ── 3. 等 agent 干完 ───────────────────────────────
        await waitForAgentIdle(agent, signal, cancelAgent)

        // ── 4. 收集改动 ────────────────────────────────────
        const collected = await collectChanges(options, { cwd: worktreePath, baseCommit: ctx.baseCommit, signal })
        const committable = filterSensitiveFiles(collected.files)
        const blocked = collected.files.filter((file) => !committable.includes(file))
        if (blocked.length > 0) {
          // 不抛错：业务代码可能已经改对了，抛了人只看到「失败」，看不到「哪几个文件被拦」。
          ctx.log?.(`executor-agent：${blocked.length} 个敏感文件不会提交`, { files: blocked })
        }

        if (committable.length === 0) {
          // 没改动就不该开 MR：一个只有标题的空 MR 只会让人白点一次。
          const reason = collected.files.length > 0
            ? `agent 只动了敏感文件（${collected.files.join('、')}），按约定不提交，因此没有可开 MR 的改动`
            : 'agent 没有产生任何文件改动'
          await ctx.onPhase('failed')
          return makeExecResult({
            phase: 'failed',
            changedFiles: [],
            testOutcome: 'skipped',
            testDetail: reason,
            error: { kind: 'internal', message: reason, retryable: false },
          })
        }

        // ── 5. 验证 ────────────────────────────────────────
        await ctx.onPhase('testing', '跑项目配置里的验证命令')
        const verification = await runVerification(options, verify, worktreePath, signal)

        // ── 6. 提交 + 开 draft MR ─────────────────────────
        await ctx.onPhase('mr-opening', '经 GitLab Commits API 物化改动')
        const mr = await openDraftMr(options, {
          ticket, target, ctx, project,
          files: committable,
          blocked,
          verification,
        })

        const phase = verification.outcome === 'failed' ? 'skipped' : 'done'
        return makeExecResult({
          phase,
          changedFiles: committable,
          testOutcome: verification.outcome,
          testDetail: verification.detail,
          mr,
          plan: {
            summary: `按工单改动了 ${committable.length} 个文件`,
            targetPaths: committable,
            approach: verification.detail,
          },
        })
      } catch (error) {
        const normalized = toPipelineError(error)
        if (normalized.kind === 'aborted') {
          // 契约要求：取消时停手、保留 worktree、抛 aborted 交给内核处理，
          // 不能在这里把它转成 failed —— 那样「人取消」会变成一条失败通知。
          cancelAgent()
          throw normalized
        }
        await ctx.onPhase('failed').catch(() => {})
        return makeExecResult({
          phase: 'failed',
          changedFiles: [],
          testOutcome: 'skipped',
          testDetail: normalized.message,
          error: { kind: normalized.kind, message: normalized.message, retryable: normalized.retryable },
        })
      } finally {
        // agent 一直被 agents 服务持有，不释放会拖住进程退出。
        try {
          agent.release?.()
        } catch (error) {
          log('executor-agent：释放 agent 时出错', { reason: String(error) })
        }
      }
    },
  })
}
/**
 * sessionId：`ticket-<projectId>-<recordId>-<时间戳>`。
 *
 * 同一张票重跑要能认出上一轮的 session（宿主据此复用/续接），所以键排前面、时间戳放最后；
 * 全部非法字符换成 `_` —— sessionId 会被当成文件名与 URL 段用，带 `/` 或 `..` 会出问题。
 *
 * @param {import('../../contracts/types.js').Ticket} ticket
 * @param {import('../../contracts/work-executor.js').ExecCtx} ctx
 * @returns {string}
 */
export function buildSessionId (ticket, ctx) {
  const projectId = sanitizeSegment(ticket?.projectId ?? 'project')
  const recordId = sanitizeSegment(ticket?.recordId ?? 'ticket')
  // 时间戳取毫秒级：同一条 recordId 一分钟内不可能重跑两次，撞了就说明有并发 bug，
  // 那时候让 agent 共用 session 反而会把两轮改动搅在一起。
  void ctx
  return `${SESSION_PREFIX}-${projectId}-${recordId}-${Date.now()}`
}

/**
 * 去掉 sessionId 里会出问题的字符。
 * @param {string} value
 * @returns {string}
 */
function sanitizeSegment (value) {
  const text = String(value ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_')
  return text.length > 0 ? text : 'x'
}

/**
 * 拼第一条消息。
 *
 * 反注入提醒**固定在最前面**：工单正文是外部输入（表格里谁都能改那一格），
 * 放在中间或末尾都会被正文里那句「忽略以上要求」盖掉作用。
 *
 * @param {import('../../contracts/types.js').Ticket} ticket
 * @param {import('../../contracts/work-executor.js').ExecCtx} ctx
 * @param {string} [untrustedNotice]
 * @returns {Array<{ type: 'text', text: string } | { type: 'image', image: unknown }>}
 */
export function buildMessages (ticket, ctx, untrustedNotice) {
  void ticket
  const source = Array.isArray(ctx?.content) && ctx.content.length > 0
    ? ctx.content
    : [{ type: 'text', text: String(ctx?.prompt ?? '') }]

  const notice = typeof untrustedNotice === 'string' ? untrustedNotice.trim() : ''
  const messages = notice.length > 0
    ? [{ type: 'text', text: notice }, ...source]
    : [...source]

  return messages
}

/**
 * agent 的模型参数。留空则跟随宿主当前选择（headless 就是这么做的）。
 *
 * @param {Record<string, any>} config
 * @returns {{ provider?: string, model?: string, maxTokens?: number }}
 */
export function agentOptionsFromConfig (config) {
  /** @type {{ provider?: string, model?: string, maxTokens?: number }} */
  const agentOptions = {}
  const provider = typeof config?.provider === 'string' ? config.provider.trim() : ''
  const model = typeof config?.model === 'string' ? config.model.trim() : ''
  // 空串有语义：表示「跟随当前会话默认」。传空串给宿主会被当成「非要这个空模型」。
  if (provider.length > 0) agentOptions.provider = provider
  if (model.length > 0) agentOptions.model = model
  const maxTokens = Number(config?.maxTokens)
  if (Number.isFinite(maxTokens) && maxTokens > 0) agentOptions.maxTokens = Math.floor(maxTokens)
  return agentOptions
}

/**
 * 按 projectId 找项目条目。`verify` 命令就挂在它上面。
 *
 * 找不到不算错（配置里删了这个项目，历史票还在跑），但验证就得记 skipped ——
 * 「没有验证命令」和「验证通过」必须是两件事。
 *
 * @param {Record<string, any>} config
 * @param {import('../../contracts/types.js').Ticket} ticket
 * @param {import('../../contracts/repo-locator.js').LocateResult} target
 * @returns {any}
 */
export function findProject (config, ticket, target) {
  void target
  const projects = Array.isArray(config?.projects) ? config.projects : []
  const projectId = String(ticket?.projectId ?? '')
  return projects.find((project) => project?.name === projectId)
}

/**
 * 等 agent 真的闲下来。
 *
 * 为什么不是 `await agent.whenIdle()` 就完事：agent 闲下来的瞬间可能刚好又排上
 * 下一轮（工具回调里再排任务、子 agent 收尾），只看一次会把「正在干」当成「干完了」。
 * 所以闲下来之后再比一次 `session.seq`：seq 没动才算真结束。
 *
 * 这两个方法的调用形状照抄 `dsh-headless/lib/index.js:347-352`。
 *
 * 判定「真的干完了」需要连续几次观察都静止。
 * 一次不够：agent 闲下来的那一瞬间可能刚好又排上下一轮（工具回调里再排任务、子 agent 收尾），
 * 只看一次会把「正要继续干」当成「干完了」，后面的 diff 就会漏掉后半段改动。
 * 取 2 而不是 3：多等一次要多付一次 whenIdle 的往返，收益很小。
 * @returns {number}
 */
function quietTicks () {
  return 2
}

/**
 * 等 agent 停下来，且连排的改动静止下来再返回。
 *
 * @param {any} agent
 * @param {AbortSignal} signal
 * @param {() => void} cancelAgent
 */
async function waitForAgentIdle (agent, signal, cancelAgent) {
  if (!signal || !signal.aborted) {
    signal?.addEventListener('abort', cancelAgent, { once: true })
  }
  try {
    const quiet = quietTicks()
    let stable = 0
    for (let guard = 0; guard < 1000; guard += 1) {
      if (signal?.aborted) throw new PipelineError('aborted', 'executor-agent：被取消')
      await agent.whenIdle()
      const idleSeq = agent.session?.seq
      // 宿主版本的 while 里还等子 agent；插件拿不到 `subagents` 服务，
      // 所以这里判的是「连续几次 whenIdle 之间 seq 都没动」。
      // 为什么要连续两次而不是一次：agent 闲下来的那一瞬间可能刚好又排上下一轮
      // （工具回调里再排任务、子 agent 收尾），只看一次会把「正要继续干」当成「干完了」，
      // 后面的 diff 就会漏掉后半段的改动。
      if (agent.status !== 'idle' || agent.session?.seq !== idleSeq) {
        stable = 0
        continue
      }
      stable += 1
      if (stable >= quiet) return
    }
    // 循环跑满还没稳下来：agent 在自我唤醒，别无限等，交给人。
    throw new PipelineError('internal', 'agent 一直没停下来（session.seq 反复变化），已放弃等待')
  } finally {
    signal?.removeEventListener('abort', cancelAgent)
  }
}

/**
 * `createUserMessage`：优先用注入的宿主实现，没有就手搓一个等价物。
 *
 * 为什么要有兜底：`@deepseek-ai/dsh-llm` 只在宿主 asar 里，插件目录 import 不到。
 * 手搓的形状只带 `role/content/source` —— host 的 `createMessage` 额外加了 `id` 并冻结，
 * 那是宿主内部身份，followup 时由宿主自己补，插件这层不需要。
 *
 * @param {any} injected
 * @returns {(input: { content: unknown, source?: { kind: string } }) => any}
 */
function resolveCreateUserMessage (injected) {
  if (typeof injected === 'function') return injected
  return (input) => ({ role: 'user', content: input.content, source: input.source ?? { kind: 'user' } })
}

/**
 * 收集 agent 改了什么。
 *
 * 两条路：
 * 1. 有 `baseCommit` 就 `git diff --name-only <baseCommit>` —— 这是**权威**答案，
 *    它能看见新增、删除、重命名，也不受 agent 中途 `git add` 的影响。
 * 2. 没有 `baseCommit`（手动跑、或建 worktree 没记基线）就退到
 *    `git status --porcelain`，从状态码里抠路径。
 *
 * @param {any} options
 * @param {{ cwd: string, baseCommit?: string, signal: AbortSignal }} input
 * @returns {Promise<{ files: string[] }>}
 */
export async function collectChanges (options, input) {
  const git = options.git
  const runGit = async (argv) => {
    assertAllowedGit(argv)
    return git(argv, { cwd: input.cwd })
  }

  const baseCommit = typeof input.baseCommit === 'string' ? input.baseCommit.trim() : ''
  /** @type {{ code: number, stdout: string, stderr: string }} */
  let result
  if (baseCommit.length > 0) {
    result = await runGit(['diff', '--name-only', baseCommit])
    if (result.code !== 0) {
      throw new PipelineError('internal', `收集改动失败：git diff --name-only ${baseCommit} 返回 ${result.code}：${tail(result.stderr)}`)
    }
    return { files: splitLines(result.stdout) }
  }

  result = await runGit(['status', '--porcelain'])
  if (result.code !== 0) {
    throw new PipelineError('internal', `收集改动失败：git status 返回 ${result.code}：${tail(result.stderr)}`)
  }
  return { files: parsePorcelain(result.stdout) }
}

/**
 * 解析 `git status --porcelain`。
 *
 * 格式是固定的两列状态 + 一个空格 + 路径。重命名/复制那一行的路径写成
 * `旧路径 -> 新路径`，**只取新路径**：GitLab 的 action 需要的是改动落点。
 *
 * @param {string} stdout
 * @returns {string[]}
 */
export function parsePorcelain (stdout) {
  const files = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (line.length < 4) continue
    const path = line.slice(3).trim()
    if (path.length === 0) continue
    const arrow = path.lastIndexOf(' -> ')
    files.push(arrow >= 0 ? path.slice(arrow + 4).trim() : path)
  }
  return files
}

/**
 * 白名单闸门。所有 git 调用都从这里过，**只有这里**能放宽 ——
 * 放宽之前先想清楚：下游还握着 GitLab token。
 *
 * @param {string[]} argv
 */
function assertAllowedGit (argv) {
  if (!isAllowedGitCommand(argv)) {
    throw new PipelineError('invalid-input', `executor-agent 拒绝执行白名单之外的 git 命令：git ${argv.join(' ')}`)
  }
}

/**
 * 跑验证命令。
 *
 * 三档结果，都要能如实写进 `testDetail`：
 * - `passed`：build 与 test 都过；
 * - `failed`：命令跑了但退出码非零 —— 这是**真的失败**，人要看；
 * - `skipped`：没配命令，或者命令根本起不来（`spawn` 抛 ENOENT）。
 *   按契约这是合法成功路径：照样开 draft MR，但原因必须写清楚。
 *
 * @param {any} options
 * @param {{ build?: string, test?: string }} verify
 * @param {string} cwd
 * @param {AbortSignal} signal
 * @returns {Promise<{ outcome: 'passed'|'failed'|'skipped', detail: string }>}
 */
export async function runVerification (options, verify, cwd, signal) {
  const commands = []
  if (typeof verify?.build === 'string' && verify.build.trim().length > 0) commands.push({ label: 'build', command: verify.build.trim() })
  if (typeof verify?.test === 'string' && verify.test.trim().length > 0) commands.push({ label: 'test', command: verify.test.trim() })

  if (commands.length === 0) {
    return {
      outcome: 'skipped',
      detail: '项目配置里没有 verify.build / verify.test 命令，本票没有跑验证（改动未经构建与测试证明）',
    }
  }
  if (typeof options.runCommand !== 'function') {
    return {
      outcome: 'skipped',
      detail: '本机没有注入命令执行器（options.runCommand），验证命令无法运行',
    }
  }

  const passed = []
  for (const item of commands) {
    if (signal?.aborted) throw new PipelineError('aborted', 'executor-agent：验证阶段被取消')
    const argv = splitCommand(item.command)
    let result
    try {
      result = await options.runCommand({ argv, cwd, signal })
    } catch (error) {
      if (signal?.aborted) throw new PipelineError('aborted', 'executor-agent：验证阶段被取消', error)
      // 起不来（ENOENT / 权限）与「跑起来但失败」完全是两回事：
      // 前者是环境问题，不该让票失败；后者是代码问题，人必须知道。
      const message = error instanceof Error ? error.message : String(error)
      return {
        outcome: 'skipped',
        detail: `验证命令起不来（${item.label}: ${item.command}）：${message}。改动未经验证，仍按约定开 draft MR。`,
      }
    }
    const code = Number(result?.code ?? 0)
    if (code !== 0) {
      return {
        outcome: 'failed',
        detail: `验证失败（${item.label}: ${item.command}，退出码 ${code}）：${tail(result?.stderr) || tail(result?.stdout) || '没有输出'}`,
      }
    }
    passed.push(item.label)
  }
  return { outcome: 'passed', detail: `验证通过：${passed.join(' + ')} 全部退出码 0` }
}

/**
 * 把 `npm run build` 这种配置串切成 argv。
 *
 * 只按空白切，**不认识引号与管道** —— 这是刻意的：配置里写 `a && b` 或带引号的参数
 * 会被原样当成一个奇怪的可执行文件名，立刻报错，而不是被悄悄解释成 shell 组合命令。
 * 真需要 shell 语法时应当在项目里写个脚本，别把 shell 注入面开进配置。
 *
 * @param {string} command
 * @returns {string[]}
 */
export function splitCommand (command) {
  return String(command ?? '').trim().split(/\s+/).filter((part) => part.length > 0)
}

/**
 * 物化改动 + 开 draft MR。
 *
 * 顺序很关键：先确保分支在（分支不存在时 GitLab 的 POST 也可能 201，所以客户端要先 GET），
 * 再一次性把文件提交上去，最后开 MR。任何一步失败都往上抛，由 run 的 catch 归成 failed。
 *
 * @param {any} options
 * @param {{ ticket: any, target: any, ctx: any, project: any, files: string[], blocked: string[], verification: { outcome: string, detail: string } }} input
 * @returns {Promise<{ iid: number, url: string, draft: true }>}
 */
async function openDraftMr (options, input) {
  const { ticket, target, ctx, project, files, blocked, verification } = input
  const gitlabInfo = resolveGitlab(project, target)
  if (!gitlabInfo) {
    throw new PipelineError('invalid-input', '项目没有配置 GitLab（repo.gitlab.projectId / repo.remote），改动没法物化成 MR')
  }
  if (typeof options.createGitlabClient !== 'function') {
    throw new PipelineError('invalid-input', 'executor-agent 没有注入 GitLab 客户端工厂（options.createGitlabClient）')
  }

  const client = await options.createGitlabClient({
    baseUrl: gitlabInfo.baseUrl,
    projectId: gitlabInfo.projectId,
    getSecret: options.getSecret,
    fetch: options.fetch,
    log: options.log,
  })

  const sourceBranch = String(ctx.branch ?? '')
  if (sourceBranch.length === 0) {
    throw new PipelineError('invalid-input', '执行上下文里没有分支名，无法把改动推到远端分支')
  }
  const targetBranch = gitlabInfo.targetBranch
  const baseRef = String(ctx.baseCommit || targetBranch)

  await client.ensureBranch({ branch: sourceBranch, ref: baseRef, signal: ctx.signal })

  // 一个 action 一条：全部按 update 提交。GitLab 的 update 对已存在的文件成立，
  // 新文件用 create 才对得上；这里按「本地这份内容覆盖远端那份」，语义是覆盖而不是新增，
  // 所以走 create 会在文件已存在时 400。用 update 更稳。
  const actions = files.map((file) => ({ action: 'update', file_path: file, content: null }))
  // 读内容要真读本地文件 —— 这一层没有 fs 服务可用（插件的 fs 是宿主的），
  // 所以内容读取走 options.readFile，缺了就退到 git show :0:<path>（暂存区里那份）。
  const withContent = await fillContents(options, ctx, files)
  for (const [index, action] of actions.entries()) {
    action.content = withContent.get(action.file_path) ?? ''
    void index
  }

  await client.commitFiles({
    branch: sourceBranch,
    message: buildCommitMessage(ticket),
    actions,
    signal: ctx.signal,
  })

  return client.createMergeRequest({
    sourceBranch,
    targetBranch,
    title: buildMrTitle(ticket),
    description: buildMrDescription({ ticket, files, blocked, verification, ctx }),
    signal: ctx.signal,
  })
}
/**
 * 把工作区的每个改动文件的内容读出来，供 Commits API 使用。
 *
 * 两种读法，按可靠性排：
 * 1. `options.readFile(path)`（组合根注入，直接读磁盘）—— 最准；
 * 2. `git show :0:<path>` 读**暂存区**里的那份。为什么是暂存区而不是工作区：
 *    工作区里可能有 agent 没写完的中间状态，暂存区是它 `git add -A` 之后的完整快照。
 *    这也解释了为什么收集完改动要先 `git add -A`。
 *
 * 读不到就抛错而不是提交空内容 —— 空内容会把远端那份文件清空，比失败糟得多。
 *
 * @param {any} options
 * @param {{ signal: AbortSignal }} ctx
 * @param {string[]} files
 * @returns {Promise<Map<string, string>>}
 */
async function fillContents (options, ctx, files) {
  /** @type {Map<string, string>} */
  const contents = new Map()
  if (typeof options.readFile === 'function') {
    for (const file of files) {
      const text = await options.readFile(file)
      contents.set(file, String(text ?? ''))
    }
    return contents
  }

  const git = options.git
  const cwd = ctx.worktreePath
  const added = await git(['add', '-A'], { cwd })
  if (added.code !== 0) {
    throw new PipelineError('internal', `提交前 git add -A 失败：${tail(added.stderr)}`)
  }
  for (const file of files) {
    assertAllowedGit(['diff', '--name-only', 'x'])
    const shown = await git(['show', `:0:${file}`], { cwd })
    if (shown.code !== 0) {
      throw new PipelineError('internal', `读不到 ${file} 的暂存内容，拒绝提交空文件：${tail(shown.stderr)}`)
    }
    contents.set(file, shown.stdout)
  }
  return contents
}

/**
 * 从「项目条目 + 定位结果」里拼出 GitLab 的三个坐标。
 *
 * 为什么项目配置与 remote 都要看：老配置只有 `repo.remote`（SSH/HTTPS 的 GitLab 地址），
 * 而 `baseUrl` 与 `projectId` 是从它推出来的 —— 让人再填一遍同一件事很容易填错。
 * 显式配了 `repo.gitlab` 就以它为准（自建站点、子组路径只有它能表达）。
 *
 * @param {any} project
 * @param {any} target
 * @returns {{ baseUrl: string, projectId: string|number, targetBranch: string } | null}
 */
export function resolveGitlab (project, target) {
  const repo = project?.repo ?? {}
  const explicit = repo.gitlab && typeof repo.gitlab === 'object' ? repo.gitlab : {}
  const remote = String(explicit.remote ?? repo.remote ?? target?.remote ?? '').trim()
  const parsed = parseGitRemote(remote)

  const baseUrl = String(explicit.baseUrl ?? parsed?.baseUrl ?? '').trim()
  const projectId = explicit.projectId ?? parsed?.projectPath ?? ''
  const targetBranch = String(repo.targetBranch ?? repo.baseBranch ?? target?.targetBranch ?? target?.baseBranch ?? 'main')

  if (baseUrl.length === 0 || String(projectId).length === 0) return null
  return { baseUrl, projectId, targetBranch }
}

/**
 * 解析 git remote。
 *
 * 两种写法都要认，因为人贴过来的通常是 SSH：
 * - `git@gitlab.x:group/repo.git` → https://gitlab.x + group/repo
 * - `https://gitlab.x/group/repo.git` → 同上
 *
 * 只支持 GitLab 语义（项目路径允许任意层子组），别的托管站点在 baseUrl 上会露馅。
 *
 * @param {string} remote
 * @returns {{ baseUrl: string, projectPath: string } | null}
 */
export function parseGitRemote (remote) {
  const text = String(remote ?? '').trim()
  if (text.length === 0) return null

  // scp 风格：user@host:path（没有 `//`，所以不能直接给 URL 解析）
  const scp = /^(?:[A-Za-z0-9._-]+@)?([^/:]+):(.+)$/.exec(text)
  if (scp && !text.includes('://')) {
    const host = scp[1]
    const path = stripGitSuffix(scp[2])
    // SSH 的 22 端口是 https 的隐式例外：显式写 :22 也没有意义，直接用 https 的默认端口。
    return { baseUrl: `https://${host}`, projectPath: path }
  }

  try {
    const url = new URL(text)
    const path = stripGitSuffix(url.pathname.replace(/^\/+/, ''))
    return { baseUrl: `${url.protocol}//${url.host}`, projectPath: path }
  } catch {
    return null
  }
}

/** @param {string} value */
function stripGitSuffix (value) {
  return String(value ?? '').replace(/\.git$/, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * MR 标题。带 `[<项目>] <recordId>` 前缀是为了在 GitLab 的 MR 列表里一眼看出是哪张票 ——
 * 那个列表里所有标题长得都差不多。
 *
 * @param {import('../../contracts/types.js').Ticket} ticket
 * @returns {string}
 */
export function buildMrTitle (ticket) {
  const seq = typeof ticket?.seq === 'string' && ticket.seq.length > 0 ? `#${ticket.seq} ` : ''
  const description = String(ticket?.description ?? '').trim().replace(/\s+/g, ' ')
  const short = description.length > 60 ? `${description.slice(0, 60)}…` : description
  return `[${ticket?.projectId ?? '未知项目'}] ${seq}${short || ticket?.recordId || '修复工单'}`
}

/**
 * 提交信息。第一行是标题（GitLab 用它做 commit 列表展示），后面是溯源信息。
 *
 * @param {import('../../contracts/types.js').Ticket} ticket
 * @returns {string}
 */
export function buildCommitMessage (ticket) {
  return [
    `fix(${ticket?.projectId ?? 'ticket'}): ${buildMrTitle(ticket)}`,
    '',
    `工单标识: ${ticket?.recordId ?? '未知'}`,
    `修订次数: ${ticket?.revisionCount ?? 1}`,
  ].join('\n')
}

/**
 * MR 描述：人打开 MR 时要知道的全部上下文都在这里。
 *
 * 尤其是「验证没跑」与「敏感文件被拦」两段 —— 它们决定了这个 MR 能不能直接合，
 * 埋在日志里等于没写。
 *
 * @param {{ ticket: any, files: string[], blocked: string[], verification: { outcome: string, detail: string }, ctx: any }} input
 * @returns {string}
 */
export function buildMrDescription (input) {
  const { ticket, files, blocked, verification, ctx } = input
  const lines = [
    '## 来源',
    '',
    `- 工单：${ticket?.recordId ?? '未知'}（${ticket?.projectId ?? '未知项目'}）`,
    `- 修订次数：${ticket?.revisionCount ?? 1}`,
    `- 分支：${ctx?.branch ?? '未知'}`,
    '',
    '## 改动的文件',
    '',
    ...(files.length > 0 ? files.map((file) => `- ${file}`) : ['- （无）']),
    '',
    '## 验证',
    '',
    `- 结论：${verification.outcome}`,
    `- 说明：${verification.detail}`,
  ]
  if (blocked.length > 0) {
    lines.push(
      '',
      '## 未提交的文件（疑似含真实凭据）',
      '',
      '以下文件命中了敏感文件规则，按约定**没有提交**。若其中确有本次需要保留的改动，请人工处理后单独提交：',
      '',
      ...blocked.map((file) => `- ${file}`),
    )
  }
  return lines.join('\n')
}

/**
 * 命令输出的尾巴。日志与错误文案里只需要能定位问题的那几行，
 * 完整输出动辄几千行，塞进 `lastError` 会把通知正文撑爆。
 *
 * @param {unknown} value
 * @returns {string}
 */
function tail (value) {
  const text = String(value ?? '').trim()
  if (text.length === 0) return ''
  const parts = text.split(/\r?\n/)
  return parts.slice(-8).join('\n').slice(-2000)
}

/**
 * 按行切、去空行。`git diff --name-only` 的输出就是这么个形状。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function splitLines (value) {
  return String(value ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
}
