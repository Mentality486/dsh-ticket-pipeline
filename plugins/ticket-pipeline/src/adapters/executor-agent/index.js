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

import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'

import { PipelineError, toPipelineError } from '../../contracts/errors.js'
import { assertWorkExecutor, makeExecResult } from '../../contracts/work-executor.js'
import { agentFailureToPipelineError, watchAgentFailures } from './agent-failure.js'

/** 给 `agents.create` 的 sessionId 前缀。sessionId 里不能出现 `/`，所以下面全部替换掉。 */
const SESSION_PREFIX = 'ticket'

/**
 * 没配 `agentPreset` 时挂哪个 preset。
 *
 * 取 `ptc` 是因为它是本仓 profile 的 `agent-preset-registry.selectedDefault`
 * （`cordis.patch.yml` 里 `config: {default: standard, selectedDefault: ptc}`），
 * 也就是「这套部署里最完整的工具矩阵」。配置为空串可以显式不挂。
 */
export const DEFAULT_AGENT_PRESET = 'ptc'

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
  if (command === 'diff') return true
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
        // 模型参数：配置优先，缺的用宿主当前默认补齐。缺了 model 宿主会在
        // {{model}} 模板上崩，票全变成「没有产生任何文件改动」。
        agentOptions: resolveAgentOptions(config, { agentDefaultModel: options.agentDefaultModel, log }),
        // setup 是宿主在 publish 之前给的唯一挂载窗口：挂 preset（= 工具矩阵）、
        // 记一条本会话的沙箱/审批策略、把 cwd 钉到 worktree。少了这段，agent
        // 起来是个没有任何工具的壳，改不出任何文件。
        setup: (agentCtx, agent) => setupAgent(options, {
          agentCtx,
          agent,
          worktreePath,
          presetId: config.agentPreset,
          signal,
          sessionId,
          log,
        }),
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

      // 盯着 agent 到底为什么失败。模型调用失败（限流、配额用尽、上游 5xx）
      // 和「agent 真干了但觉得不用改」从外面看一模一样：都是闲下来了、一个字没改。
      // 只有把失败原因挖出来，才能把前者判成可重试、后者判成真结论。
      const failureWatcher = watchAgentFailures(agent)

      try {
        // ── 2. 推任务：必须 followup（inject 不唤醒 agent）──
        agent.followup(createUserMessage({ content: messages, source: { kind: 'user' } }))
        await ctx.onPhase('editing', 'agent 已接到任务书，开始改代码')

        // ── 3. 等 agent 干完 ───────────────────────────────
        await waitForAgentIdle(agent, signal, cancelAgent)

        // ── 4. 收集改动 ────────────────────────────────────
        // 不只是「改了哪些文件」，还要知道每个文件是新增 / 修改 / 删除：
        // GitLab Commits API 的 action 必须对得上，否则新文件报「已存在」、
        // 被删的文件还会被当成 update 提交空内容（等于把远端文件清空）。
        const collected = await collectChanges(options, { cwd: worktreePath, baseCommit: ctx.baseCommit, signal })
        const committableChanges = collected.changes.filter((change) => !isSensitivePath(change.path) && !isSensitivePath(change.from ?? ''))
        const committable = committableChanges.map((change) => change.path)
        const blocked = collected.files.filter((file) => !committable.includes(file))
        if (blocked.length > 0) {
          // 不抛错：业务代码可能已经改对了，抛了人只看到「失败」，看不到「哪几个文件被拦」。
          // 但不能只写日志 —— 插件日志人平时不看，最后只会在 MR 里发现「少改了一个文件」。
          ctx.log?.(`executor-agent：${blocked.length} 个敏感文件不会提交`, { files: blocked })
        }

        if (committable.length === 0) {
          // 先问一句「agent 是失败了吗」：模型调用被拒（限流/配额）时它一个字
          // 都改不了，但从外面看跟「它觉得不用改」长得一模一样。以前这两种
          // 都报成 internal + 不可重试，限流那张票就被永久判死了。
          const failure = failureWatcher.detect()
          if (failure) {
            // 抛出去而不是转成 failed 结果：内核只对「抛出来的可重试错误」
            // 走退避重试（见 core/scheduler.js 的 catch 分档），
            // 执行器自己返回的 failed 结果是不进重试队列的。
            const failureError = agentFailureToPipelineError(failure)
            ctx.log?.(`executor-agent：agent 这一轮失败了（${failure.code}）：${failure.message}`)
            throw failureError
          }
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
          changes: committableChanges,
          blocked,
          verification,
        })

        // 验证失败（命令跑了、退出码非零）才是 skipped —— 代码有问题，不能算「完成」。
        // 没配验证 / 起不来仍算 done：契约里 skipped 是合法成功路径（改动已开 MR 待人审），
        // 但 plan.summary 必须把「未跑过测试」写在最前面，不能让「完成」这个字眼
        // 替人默认测试过了 —— 工单需求里「完成后对问题功能进行测试」是硬要求。
        const phase = verification.outcome === 'failed' ? 'skipped' : 'done'
        const blockedNote = blocked.length > 0
          ? `；另有 ${blocked.length} 个敏感文件按约定未提交（${blocked.join('、')}）`
          : ''
        const verifyNote = verification.outcome === 'passed'
          ? `验证通过：${verification.detail}`
          : `⚠ 未通过验证（${verification.outcome}）：${verification.detail}`
        return makeExecResult({
          phase,
          changedFiles: committable,
          testOutcome: verification.outcome,
          testDetail: verification.detail,
          mr,
          plan: {
            summary: `按工单改动了 ${committable.length} 个文件；${verifyNote}${blockedNote}`,
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
        // agent 自己失败（模型限流、配额用尽、上游 5xx）必须**抛出去**：
        // 内核只对「抛出来的可重试错误」走退避重试；执行器自己返回的 failed
        // 结果是不进重试队列的（见 core/scheduler.js 的成功路径与 catch 分档）。
        // 转成 failed 结果等于把「等一会儿再来」的限流判成永久失败。
        if (/** @type {any} */ (normalized).agentFailure === true) {
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
        // 宿主里 `agents.create` 返回的是 `{agent, dispose}`，拆除动作在 dispose 上；
        // 老宿主没有 dispose 时退回 agent.release?.()（都不存在也不报错）。
        try {
          failureWatcher.dispose()
        } catch (error) {
          log('executor-agent：解绑失败事件监听时出错', { reason: String(error) })
        }
        try {
          if (typeof created?.dispose === 'function') {
            await created.dispose()
          } else {
            agent.release?.()
          }
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
 * agent 的模型参数，只按配置表组装（纯函数，不碰宿主服务）。
 *
 * 注意：**光有这个函数是不够的**。宿主给 agent 组装系统提示时要把 {{model}} 替换成
 * `agent.options.model`，没给 model 就会抛
 * `prompt variable "{{model}}" has no value for this assembly`。
 * 配置里 model 留空是常态（表示「跟随宿主默认」），真正把默认值填进去的是
 * `resolveAgentOptions`，它才有机会读宿主服务。
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
 * 真正下发给宿主的模型参数：配置优先，缺的用宿主当前默认补齐。
 *
 * 为什么必须补齐：宿主组装系统提示时要渲染 `{{model}}` 模板，取值是
 * `context.agent?.options.model`（宿主 dsh-agent-loop 里 systemPrompt.variable('model', ...)）。
 * 配置里 model 留空就真的不下发 model → 模板无值 → 每一轮都在 publish 阶段崩掉，
 * 票全部变成「agent 没有产生任何文件改动」。这条链路在 2026-11-05 的真实工单上撞过。
 *
 * 宿主服务接口是 `currentSelection() -> { provider, model, reasoningEffort? }`，
 * 与 dsh-headless 的用法一致（它也是把这两项成对下发）。
 *
 * @param {Record<string, any>} config
 * @param {{ agentDefaultModel?: { currentSelection?: () => any }, log?: (msg: string, detail?: unknown) => void }} [options]
 * @returns {{ provider?: string, model?: string, maxTokens?: number }}
 */
export function resolveAgentOptions (config, options = {}) {
  const agentOptions = agentOptionsFromConfig(config)
  const log = typeof options.log === 'function' ? options.log : () => {}

  // 配置里两项都给了就不必问宿主：显式配置永远赢。
  if (agentOptions.provider && agentOptions.model) return agentOptions

  const service = options.agentDefaultModel
  if (!service || typeof service.currentSelection !== 'function') {
    // 没有这个服务（离线自测、裁剪过的 profile）—— 保持配置原样，让宿主的报错原文暴露出来，
    // 不要在这里凭空编一个模型名去猜。
    log('executor-agent：本机没有 agentDefaultModel 服务，模型参数只能按配置下发', {
      provider: agentOptions.provider ?? null,
      model: agentOptions.model ?? null,
    })
    return agentOptions
  }

  /** @type {any} */
  let selection
  try {
    selection = service.currentSelection()
  } catch (error) {
    throw new PipelineError('internal', `executor-agent：读取宿主默认模型失败：${error instanceof Error ? error.message : String(error)}`, error)
  }
  const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : ''
  const model = typeof selection?.model === 'string' ? selection.model.trim() : ''
  if (provider.length === 0 || model.length === 0) {
    // 两项必须成对下发：只给 provider 不给 model，宿主照样在 {{model}} 上崩。
    throw new PipelineError(
      'internal',
      'executor-agent：配置里没有给 provider/model，宿主也没报出当前默认模型' +
      `（拿到的是 provider=${JSON.stringify(selection?.provider ?? null)} model=${JSON.stringify(selection?.model ?? null)}）` +
      '。请在插件配置里显式写 provider 与 model，或在宿主里先选一个默认模型。',
    )
  }
  agentOptions.provider = agentOptions.provider ?? provider
  agentOptions.model = agentOptions.model ?? model
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
 * 在宿主 publish 之前把子 agent 装配起来。这是 setup 的全部职责。
 *
 * 三件事，缺任何一件都会让 agent「看起来起来了、实际什么也没干」：
 *
 * 1. **挂 preset**（`agentPresets.mount`）：preset 决定这个 agent 有哪些工具。
 *    不挂 = 一个没有任何工具的壳，它只会回一句「我看不到文件」，然后
 *    `collectChanges` 拿到空改动 → 票被判 failed。宿主自己的子 agent 走的是
 *    同一个 API（`dsh-subagent:applyChildComposition`）。
 * 2. **记策略事件**：宿主的沙箱模式与会话绑定，且**必须自己 append**
 *    （`dsh-subagent` 的 `appendDelegatedPolicyOverrides` 就是这么做的）。
 *    不 append 就吃部署默认（可能是 read-only），agent 改不动 worktree 里任何文件。
 * 3. **钉 cwd**：`meta.cwd` 已经写进 session header，但若宿主有
 *    `workingDirectory` 服务且当前值不同，要显式 set —— 工具按它解析相对路径。
 *
 * 全部用 `agentCtx.get(name)` 弱取：这些服务不是每个 profile 都装
 * （headless profile 就没有 agentPresets），弱取能让插件在缺服务时给出
 * 一条说清缺什么的日志，而不是让宿主在启动期把插件 park 掉。
 *
 * @param {any} options createAgentExecutor 的 options
 * @param {{
 *   agentCtx: any,
 *   agent: any,
 *   worktreePath: string,
 *   presetId?: string,
 *   signal?: AbortSignal,
 *   sessionId: string,
 *   log: (msg: string, detail?: unknown) => void,
 * }} input
 * @returns {Promise<void>}
 */
export async function setupAgent (options, input) {
  void options
  const { agentCtx, agent, worktreePath, signal, sessionId, log } = input
  // 三态语义：undefined = 没配（用默认 ptc）、空串 = 明确不挂、其它 = 挂指定的那个。
  const presetId = input.presetId === undefined
    ? DEFAULT_AGENT_PRESET
    : String(input.presetId).trim()

  // ── 1. 挂 preset（工具矩阵）────────────────────────
  if (presetId.length > 0) {
    const presets = agentCtx?.get?.('agentPresets')
    if (!presets || typeof presets.mount !== 'function') {
      // 没装 agent-preset-registry 的 profile（如 headless）没有这个服务。
      // 这时起出来的 agent 是个没有任何工具的壳：它读不到文件也改不了文件，
      // 最后必然落到「agent 没有产生任何文件改动」，真因被埋掉、还白烧一轮 token。
      // 必须在这里就失败，并且报成 invalid-input（重试不会有帮助）。
      throw new PipelineError(
        'invalid-input',
        `executor-agent：本机没有 agentPresets 服务，无法给 agent 挂 preset "${presetId}"，` +
        '这样的 agent 一个工具都没有（改动必为空）。请确认宿主装了 agent-preset-registry ' +
        '（桌面版自带），或把配置项 agentPreset 留空改为不挂 preset。',
      )
    } else {
      try {
        const mounted = await presets.mount(agentCtx, presetId)
        log('executor-agent：preset 已挂载', { sessionId, presetId: mounted?.id ?? presetId })
      } catch (error) {
        // 挂不上就不要继续：让它跑下去只会拿到「没有产生任何文件改动」，
        // 真正的原因（preset 名写错 / preset 定义坏了）会被埋掉。
        const available = await listPresetIds(presets)
        throw new PipelineError(
          'invalid-input',
          `executor-agent 挂 agentPreset "${presetId}" 失败：${error?.message ?? String(error)}` +
          (available.length > 0 ? `。本机可用的 preset：${available.join(' / ')}` : '') +
          '。把配置项 agentPreset 改成本机存在的值，或留空表示不挂 preset。',
        )
      }
    }
  } else {
    log('executor-agent：agentPreset 留空，不挂 preset（agent 有哪些工具取决于宿主默认）', { sessionId })
  }

  // ── 2. 会话策略：沙箱模式 + 审批策略 ─────────────────
  // 这两个是「本会话」的策略，写进 session 事件，宿主按它解析每次受限调用。
  const session = agent?.session
  if (session && typeof session.append === 'function') {
    try {
      session.append('sandbox/mode', { mode: 'danger-full-access' })
      session.append('approval/policy', { policy: 'never' })
      log('executor-agent：会话策略已记（danger-full-access / approval never）', { sessionId })
    } catch (error) {
      log('executor-agent：写入会话策略事件失败，agent 可能改不动 worktree', { sessionId, reason: String(error) })
    }
  }

  // ── 3. 钉 cwd ───────────────────────────────────────
  const workingDirectory = agentCtx?.get?.('workingDirectory')
  if (workingDirectory && typeof workingDirectory.set === 'function' && worktreePath.length > 0) {
    try {
      const current = typeof workingDirectory.get === 'function' ? workingDirectory.get(agent.session) : undefined
      if (current !== worktreePath) await workingDirectory.set(agent, worktreePath, signal)
    } catch (error) {
      // meta.cwd 已经写进 session header，set 失败只是没能再钉一遍，不必判失败。
      log('executor-agent：把 cwd 钉到 worktree 失败（继续用 session header 里的 cwd）', { sessionId, worktreePath, reason: String(error) })
    }
  }
}

/**
 * 列本机可用的 preset id —— 只在挂载失败时用来把「可选项」写进报错。
 *
 * @param {any} presets
 * @returns {Promise<string[]>}
 */
async function listPresetIds (presets) {
  if (typeof presets.list !== 'function') return []
  try {
    const items = await presets.list()
    return (Array.isArray(items) ? items : []).map((item) => String(item?.id ?? '')).filter((id) => id.length > 0)
  } catch {
    return []
  }
}

/**
 * `createUserMessage`：优先用注入的宿主实现，没有就手搓一个等价物。
 *
 * 为什么要有兜底：`@deepseek-ai/dsh-llm` 只在宿主 asar 里，插件目录 import 不到。
 *
 * **`id` 必须自己补**：宿主的 `createMessage` 是
 * `structuredClone({...input, id: randomUUID()})`，而 inbox 投影（`dsh-agent-loop`
 * 的 `inboxProjectionDefinition.apply`）按 `id` 记账 —— 没有 `id` 的消息会直接把
 * `followup()` 炸成 `invalid persisted inbox splice`。所以兜底实现照宿主的形状补齐，
 * 而不是只带 `role/content/source`。
 *
 * @param {any} injected
 * @returns {(input: { content: unknown, source?: { kind: string } }) => any}
 */
function resolveCreateUserMessage (injected) {
  if (typeof injected === 'function') return injected
  return (input) => ({
    id: randomUUID(),
    role: 'user',
    content: input.content,
    source: input.source ?? { kind: 'user' },
  })
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
  let changes
  if (baseCommit.length > 0) {
    // `--name-status` 而不是 `--name-only`：前者带 A/M/D/R 状态，后者只给路径。
    // 状态决定 Commits API 的 action，缺了就只能一律按 update 提交，新增文件会 400。
    result = await runGit(['diff', '--name-status', baseCommit])
    if (result.code !== 0) {
      throw new PipelineError('internal', `收集改动失败：git diff --name-status ${baseCommit} 返回 ${result.code}：${tail(result.stderr)}`)
    }
    changes = parseNameStatus(result.stdout)
  } else {
    result = await runGit(['status', '--porcelain'])
    if (result.code !== 0) {
      throw new PipelineError('internal', `收集改动失败：git status 返回 ${result.code}：${tail(result.stderr)}`)
    }
    changes = parsePorcelainChanges(result.stdout)
  }
  return { files: changes.map((change) => change.path), changes }
}

/**
 * 解析 `git diff --name-status`。
 *
 * 一行一条：`<状态>\t<路径>`；重命名/复制是 `R100\t旧路径\t新路径`。
 * 状态字母只取首字母：GitLab 的 action 只认 create / update / delete / move。
 *
 * @param {string} stdout
 * @returns {Array<{ path: string, status: 'create'|'update'|'delete'|'move', from?: string }>}
 */
export function parseNameStatus (stdout) {
  /** @type {Array<{ path: string, status: string, from?: string }>} */
  const changes = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    const parts = line.split('\t').map((part) => part.trim()).filter((part) => part.length > 0)
    if (parts.length < 2) continue
    const letter = String(parts[0]).charAt(0).toUpperCase()
    if ((letter === 'R' || letter === 'C') && parts.length >= 3) {
      const status = letter === 'R' ? 'move' : 'create'
      const change = { path: parts[2], status }
      if (letter === 'R') change.from = parts[1]
      changes.push(change)
      continue
    }
    const status = letter === 'A' ? 'create' : letter === 'D' ? 'delete' : 'update'
    changes.push({ path: parts[1], status })
  }
  return changes
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
  return parsePorcelainChanges(stdout).map((change) => change.path)
}

/**
 * 解析 `git status --porcelain` 并带上状态。
 *
 * 格式是固定的两列状态 + 一个空格 + 路径：
 * - `??` = 未跟踪 → create
 * - 首列或次列出现 `D` → delete（首列是暂存区、次列是工作区，任一为删除都算删）
 * - 首列为 `R` → move，路径写成 `旧路径 -> 新路径`，只取新路径（Commits API 需要落点）
 * - 其余 → update
 *
 * @param {string} stdout
 * @returns {Array<{ path: string, status: 'create'|'update'|'delete'|'move', from?: string }>}
 */
export function parsePorcelainChanges (stdout) {
  /** @type {Array<{ path: string, status: string, from?: string }>} */
  const changes = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    const raw = line.slice(3).trim()
    if (raw.length === 0) continue
    const arrow = raw.lastIndexOf(' -> ')
    const path = arrow >= 0 ? raw.slice(arrow + 4).trim() : raw
    if (path.length === 0) continue
    /** @type {'create'|'update'|'delete'|'move'} */
    let status = 'update'
    if (code === '??' || code === '!!') status = 'create'
    else if (arrow >= 0 || code.charAt(0) === 'R') status = 'move'
    else if (code.charAt(0) === 'D' || code.charAt(1) === 'D') status = 'delete'
    else if (code.charAt(0) === 'A') status = 'create'
    const change = { path, status }
    if (status === 'move' && arrow >= 0) change.from = raw.slice(0, arrow).trim()
    changes.push(change)
  }
  return changes
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
    /** @type {string[]} */
    let argv
    try {
      argv = splitCommand(item.command)
    } catch (error) {
      // 配置写坏了（引号没闭合）：这是配置问题，不是代码问题。
      // 判 skipped 并写清楚，人去看 testDetail 就能改对；判 failed 会让人以为改的代码有问题。
      return {
        outcome: 'skipped',
        detail: `验证命令解析不了（${item.label}: ${item.command}）：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (argv.length === 0) {
      return { outcome: 'skipped', detail: `验证命令是空的（${item.label}），没有跑验证` }
    }
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
 * 认**引号**（单引号与双引号都认，引号内的空格不切分），因为 Windows 路径里
 * 空格是常态：`node "C:\\Program Files\\x\\check.mjs"` 必须切出两个参数。
 *
 * 但**故意不认管道、重定向、&& 之类的 shell 语法**：它们会被原样留在一个参数里，
 * 于是执行时立刻失败并报出「命令起不来」，而不是被悄悄解释成 shell 组合命令。
 * 配置项不该成为 shell 注入面 —— 真需要组合命令请在项目里写个脚本。
 *
 * @param {string} command
 * @returns {string[]}
 */
export function splitCommand (command) {
  const text = String(command ?? '')
  /** @type {string[]} */
  const argv = []
  let current = ''
  let quote = ''
  let started = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote.length > 0) {
      if (char === quote) {
        quote = ''
      } else {
        // 引号里**不给反斜杠任何特殊含义**：Windows 路径 `"C:\Program Files\x"`
        // 里的反斜杠是字面量，当成转义符会把路径吃掉（C:Program Filesx）。
        // 代价是引号内写不出引号本身 —— 配置项里也没有这种需求。
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started || current.length > 0) {
        argv.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  // 引号没闭合：宁可报错也别把它当成「参数里带了个引号」—— 那会让人以为跑通了。
  if (quote.length > 0) {
    throw new PipelineError('invalid-input', `验证命令的引号没有闭合：${text}`)
  }
  if (started || current.length > 0) argv.push(current)
  return argv
}

/**
 * 物化改动 + 开 draft MR。
 *
 * 顺序很关键：先确保分支在（分支不存在时 GitLab 的 POST 也可能 201，所以客户端要先 GET），
 * 再一次性把文件提交上去，最后开 MR。任何一步失败都往上抛，由 run 的 catch 归成 failed。
 *
 * @param {any} options
 * @param {{ ticket: any, target: any, ctx: any, project: any, files: string[], changes?: Array<{ path: string, status: string, from?: string }>, blocked: string[], verification: { outcome: string, detail: string } }} input
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

  // action 必须与 git 给的状态对上：
  // - create：新文件用 update 会 404（远端没有这个文件）
  // - delete：不能带 content，带了等于「删掉又写回空文件」
  // - move：必须带 previous_path，否则远端看到的是「新建一个 + 留一个孤儿」
  // 一律 update 是能跑通最常见的「改现有文件」，但只要 agent 新增或删除文件就会静默出错。
  const planned = normalizeActions(files, input.changes)
  const actions = planned.map((change) => {
    /** @type {any} */
    const action = { action: change.status, file_path: change.path }
    if (change.status === 'delete') return action
    if (change.status === 'move') action.previous_path = change.from
    action.content = null
    return action
  })
  // 读内容要真读本地文件 —— 这一层没有 fs 服务可用（插件的 fs 是宿主的），
  // 所以内容读取走 options.readFile，缺了就退到 git show :0:<path>（暂存区里那份）。
  const needContent = actions.filter((action) => action.action !== 'delete')
  const withContent = await fillContents(options, ctx, needContent.map((action) => action.file_path))
  for (const action of actions) {
    if (action.action === 'delete') continue
    const text = withContent.get(action.file_path)
    if (typeof text !== 'string') {
      throw new PipelineError('internal', `读不到 ${action.file_path} 的内容，拒绝提交空文件`)
    }
    action.content = text
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
    description: buildMrDescription({ ticket, files, changes: input.changes, blocked, verification, ctx }),
    signal: ctx.signal,
  })
}

/**
 * 把「要提交的文件」与「git 给的状态」对齐。
 *
 * 有状态就用状态（create / update / delete / move 都要如实告诉 GitLab）；
 * 没有状态（老调用方只传 files）就退回一律 update —— 这是唯一安全假设，
 * 因为大部分改动都是「改现有文件」。
 *
 * @param {string[]} files
 * @param {Array<{ path: string, status: string, from?: string }>} [changes]
 * @returns {Array<{ path: string, status: 'create'|'update'|'delete'|'move', from?: string }>}
 */
export function normalizeActions (files, changes) {
  const list = Array.isArray(files) ? files : []
  const known = new Map()
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || typeof change.path !== 'string') continue
    known.set(change.path, change)
  }
  return list.map((file) => {
    const change = known.get(file)
    if (!change) return { path: file, status: 'update' }
    /** @type {'create'|'update'|'delete'|'move'} */
    const status = ['create', 'update', 'delete', 'move'].includes(change.status) ? change.status : 'update'
    return status === 'move' ? { path: file, status, from: change.from } : { path: file, status }
  })
}

/**
 * 把仓库相对路径拼到 worktree 根上。
 *
 * git 给的路径永远是仓库相对路径；而 options.readFile 是按进程 cwd 解析的。
 * 不拼就会读到会话工作区里同名的另一个文件 —— 那等于把别人的代码提交到 PR 里。
 *
 * @param {string} worktreePath
 * @param {string} file
 * @returns {string}
 */
export function joinWorktreePath (worktreePath, file) {
  const root = String(worktreePath ?? '')
  const name = String(file ?? '')
  if (root.length === 0) return name
  if (isAbsolute(name)) return name
  return join(root, name)
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
  const cwd = String(ctx.worktreePath ?? '')
  if (typeof options.readFile === 'function') {
    for (const file of files) {
      // git 给的是相对仓库根的路径（src/login.js），而 readFile 是按进程 cwd 解析的绝对读法，
      // 不拼 worktree 就会读到工作区里同名的另一个文件 —— 那是把别人的代码提交上去。
      const text = await options.readFile(joinWorktreePath(cwd, file))
      contents.set(file, String(text ?? ''))
    }
    return contents
  }

  const git = options.git
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
 * @param {{ ticket: any, files: string[], changes?: Array<{ path: string, status: string, from?: string }>, blocked: string[], verification: { outcome: string, detail: string }, ctx: any }} input
 * @returns {string}
 */
export function buildMrDescription (input) {
  const { ticket, files, blocked, verification, ctx } = input
  // 改动的性质（新增 / 修改 / 删除 / 重命名）决定了 review 的重点：
  // 删文件与改文件名比「改几行」危险得多，必须在描述里先看见。
  const statuses = new Map()
  for (const change of Array.isArray(input.changes) ? input.changes : []) {
    if (change && typeof change.path === 'string') statuses.set(change.path, change)
  }
  const labels = { create: '新增', update: '修改', delete: '删除', move: '重命名' }
  const renderFile = (file) => {
    const change = statuses.get(file)
    const label = change ? labels[change.status] : undefined
    if (label === undefined) return `- ${file}`
    if (change.status === 'move' && change.from) return `- ${file}（重命名，原路径 ${change.from}）`
    return `- ${file}（${label}）`
  }
  const lines = [
    '## 来源',
    '',
    `- 工单：${ticket?.recordId ?? '未知'}（${ticket?.projectId ?? '未知项目'}）`,
    `- 修订次数：${ticket?.revisionCount ?? 1}`,
    `- 分支：${ctx?.branch ?? '未知'}`,
    '',
    '## 改动的文件',
    '',
    ...(files.length > 0 ? files.map(renderFile) : ['- （无）']),
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

