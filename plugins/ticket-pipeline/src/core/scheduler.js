/**
 * `scheduler.js` —— 内核：扫描、入队、一轮跑一票、超时、清理。
 *
 * 这是唯一知道「整条链路怎么串」的地方，它只调四个接口：
 * `TicketSource` / `RepoLocator` / `WorkExecutor` / `PushAdapter`。
 * 它不知道飞书的 URL、不知道 GitLab 的 API、不知道该改哪个 `.vue`。
 *
 * 通用化之后它持有一组 `sources`（每个项目一个），按票据的 `projectId`
 * 找到对应的 source 与仓库，其余链路逻辑不变。
 */

import { PipelineError, isAbortError, linkSignal, retryPolicy, toPipelineError } from '../contracts/errors.js'
import { TERMINAL, canTransition, TIMELINE_NODES, phaseLabel } from '../contracts/types.js'
import { fingerprintChanged, summarize, ticketKey } from './store.js'
import { BUILTIN_LIMITS } from './config.js'
import { normalizeTestOutcome } from '../contracts/work-executor.js'
import { renderTicketContent, renderTicketPrompt } from './prompt.js'

/**
 * @typedef {import('../contracts/types.js').Ticket} Ticket
 * @typedef {import('./store.js').TicketStore} TicketStore
 * @typedef {import('./store.js').TicketRecordRow} TicketRecordRow
 * @typedef {import('../contracts/ticket-source.js').TicketSource} TicketSource
 * @typedef {import('../contracts/repo-locator.js').RepoLocator} RepoLocator
 * @typedef {import('../contracts/work-executor.js').WorkExecutor} WorkExecutor
 * @typedef {import('../contracts/push-adapter.js').PushAdapter} PushAdapter
 * @typedef {import('../contracts/types.js').Phase} Phase
 */

/** 重试退避：第一次等这么久，之后每次翻倍。 */
const RETRY_BASE_MS = 30_000
/** 退避上限：再久就不如直接判失败让人来处理了（一轮 40 分钟的票，等一小时毫无意义）。 */
const RETRY_MAX_MS = 30 * 60_000
/** 抖动幅度：±20%。 */
const RETRY_JITTER = 0.2

/**
 * 长站点心跳间隔（毫秒）。
 *
 * 时间线只在「进站」时打一条，跑验证那 13 分钟里一条记录都没有 ——
 * `pipeline_status` 只能说「已 13 分没动」，人会以为卡死然后取消整票。
 * 每 60 秒补一条心跳，`at` 一直往前推，「多久没动」就永远是个小数字。
 *
 * 60 秒是内置常量，不做成配置项：它只影响「看起来多久没动」的粒度，
 * 配大配小都没有业务含义，多一个旋钮只是多一处能配错的地方。
 */
const TIMELINE_HEARTBEAT_MS = 60_000
/**
 * 算第 `attempt` 次失败后该等多久再重试。
 *
 * 曲线是 `base * 2^(attempt-1)`，夹到 `RETRY_MAX_MS`；叠一层 ±20% 抖动。
 * 为什么必须抖动：几台机器同时被同一个服务端限流时，固定退避会让它们在
 * 同一毫秒一起重来，把刚缓过来的对方再打一遍 —— 抖动把这批请求摊开。
 *
 * 服务端给了 `retryAfterMs` 就改用它的值（同样夹到上限）：`429 + Retry-After`
 * 是对方明说的「什么时候再来」，我们算出来的曲线没有理由盖过它。
 *
 * 下限 1 毫秒：调用方可能传 0 或负数（退避配置写坏、服务端给了非法头），
 * 0 会让票在下一轮立刻被捞出，退避等于没做。
 *
 * @param {number} attempt 这是第几次尝试（从 1 开始）
 * @param {number | undefined} retryAfterMs 服务端给的等待时间
 * @param {() => number} random 随机源，注入定值可关掉抖动
 * @returns {number} 毫秒
 */
function backoffDelayMs (attempt, retryAfterMs, random) {
  const serverHint = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : undefined
  const exp = RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1)
  const capped = Math.min(serverHint ?? exp, RETRY_MAX_MS)
  // 抖动只往两头挪一点点，夹到上限之后再抖，免得抖动把上限顶穿。
  const jittered = Math.min(capped * (1 + (random() * 2 - 1) * RETRY_JITTER), RETRY_MAX_MS)
  return Math.max(1, Math.round(jittered))
}

/**
 * 票据上存的工作区坐标还作数吗？
 *
 * 两个独立的失效来源，任一成立就不能复用：
 *
 * 1. **目录没了**。`isolateWorktree` 时代每票一个 `.agents/worktrees/<branch>`，
 *    人手工删过、`worktree prune` 清过、磁盘搬过家都会留下一条指向空气的路径。
 *    复用它会一路传到 `executor-agent` 的 `workingDirectory.set`，在那里才炸。
 * 2. **换了仓库**。配置里的 `repo.path` 从 A 改成 B 之后，票据上的旧坐标仍然
 *    指向 A 的目录 —— 那个目录可能好好存在，只是**不是这次要改的仓库**。
 *    只看「文件系统里有没有」会漏掉这一类，所以还要比 repoPath。
 *
 * `worktreeExists` 没注入时（离线自测、或本机没有 git 链路）跳过存在性检查，
 * 只做 repoPath 比对：不能因为「问不到」就一律判失效，那会让每轮都重建。
 *
 * @param {Object} input
 * @param {string | undefined} input.worktreePath
 * @param {string | undefined} input.repoPath 票据上记的仓库根
 * @param {string} input.currentRepoPath 这次定位出来的仓库根
 * @param {((path: string) => Promise<boolean>) | undefined} input.worktreeExists
 * @returns {Promise<boolean>}
 */
async function isStaleWorkspaceCoords ({ worktreePath, repoPath, currentRepoPath, worktreeExists }) {
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) return false

  const normalize = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const ticketRepo = normalize(repoPath)
  const locatedRepo = normalize(currentRepoPath)
  if (ticketRepo.length > 0 && locatedRepo.length > 0 && ticketRepo !== locatedRepo) return true

  if (typeof worktreeExists !== 'function') return false
  try {
    const exists = await worktreeExists(worktreePath)
    return exists === false
  } catch {
    // 探测本身出错（git 不在、路径不可读）：不作为「失效」的理由。
    // 宁可复用旧坐标让人看见真实错误，也不要每轮把已有工作区推倒重来。
    return false
  }
}

/**
 * 扫描结果里「这一轮发生了什么」的摘要，给日志和 `pipeline_scan` 工具返回用。
 * @typedef {Object} TickResult
 * @property {'ok'|'scan-failed'|'already-running'|'disabled'} status
 * @property {{ created: number, updated: number, disappeared: number, revivals: number }} scan
 * @property {{ projectId: string, recordId: string, phase: Phase, ok: boolean } | null} ran
 * @property {boolean} cleaned
 * @property {string} [error]
 */

/**
 * @param {Object} options
 * @param {TicketStore} options.store
 * @param {TicketSource[]} options.sources
 * @param {RepoLocator} options.locator
 * @param {WorkExecutor} options.executor
 * @param {PushAdapter} options.push
 * @param {Record<string, any>} options.config
 * @param {(msg: string, detail?: unknown) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {() => number} [options.random] 重试退避抖动用的随机源（0 ≤ v < 1）。
 *   不注入就用 `Math.random`；离线自测注入定值才能断言退避是多少毫秒 ——
 *   抖动的存在就是为了让断言无法确定，除非把它按死。
 * @param {(opts: any) => Promise<{ path?: string, branch?: string, baseCommit?: string, repoPath?: string }>} [options.prepareWorkspace]
 * @param {(opts: { data: Uint8Array, mediaType: string, name?: string }) => Promise<unknown>} [options.saveImage]
 * @param {(opts: { path: string, branch: string, repoPath?: string }) => Promise<void>} [options.removeWorktree]
 * @param {(path: string) => Promise<boolean>} [options.worktreeExists]
 *   票据上记的工作区目录还在不在。启动恢复（core/recover.js）用的是同一个判定，
 *   但那只覆盖 pending 与中间态 —— failed 是终态，人工重开之后仍然会带着陈旧坐标
 *   回到调度器，所以这里必须再判一次。不注入时跳过存在性检查（只比 repoPath）。
 */
export function createScheduler ({ store, sources, locator, executor, push, config, log, now, random, prepareWorkspace, saveImage, removeWorktree, worktreeExists, leaseHeartbeatMsOverride, timelineHeartbeatMsOverride }) {
  const logInfo = log ?? (() => {})
  const nowFn = now ?? (() => Date.now())
  const randomFn = random ?? (() => Math.random())

  /** 单飞：防同进程内定时器重入。跨进程靠存储租约。 */
  let running = false

  /** 当前这票的取消句柄，供「人工取消」与卸载时使用。 */
  /** @type {{ abort: (reason?: unknown) => void } | null} */
  let activeHandle = null

  const leaseTtlMs = Math.max(1, Number(config.leaseTtlMinutes ?? 10)) * 60_000

  /**
   * 单条通知的超时（毫秒）。
   *
   * 通知是「活干完之后」的最后一步，它挂了不该拖住整轮 tick —— 票的状态已经落库，
   * 人在队列里看得到。20 秒够任何一个推送服务端回应；超过就是它出问题了，放弃这一条。
   * 不做成配置项：目前没有哪个项目需要「等我十分钟」的通知语义，多一个旋钮只是多一处配错。
   */
  const notifyTimeoutMs = 20_000

  /**
   * 租约心跳间隔（毫秒）。
   *
   * 架构文档 §6.5 租约协议第 3 步：「跑的过程中每 60 秒续一次租」。
   * 没有心跳，一张跑 40 分钟的票（租约 TTL 只有 10 分钟）会被别的进程抢走，
   * 两边在同一个 worktree 上同时改代码 —— 这是最难查的一类事故。
   *
   * 60 秒是内置常量（`BUILTIN_LIMITS.leaseHeartbeatSeconds`），不再暴露成配置项：
   * 它必须显著小于 leaseTtlMinutes，配大只会制造上面那种事故，用户没有判断依据。
   * `leaseHeartbeatMsOverride` 仅供自测把间隔压到毫秒级。
   */
  const leaseHeartbeatMs = Number.isFinite(leaseHeartbeatMsOverride) && leaseHeartbeatMsOverride > 0
    ? leaseHeartbeatMsOverride
    : BUILTIN_LIMITS.leaseHeartbeatSeconds * 1000

  /** projectId → source，供按票定位截图源与扫描源。 */
  const sourceByProject = new Map()
  for (const source of sources) {
    sourceByProject.set(source.projectId, source)
  }

  /**
   * 往一张票的「关键节点流程日志」（时间线）上记一笔。
   *
   * 记日志绝不能反过来把票带崩：写失败只留一条插件日志，跑票照旧。
   * `node` 是稳定 id（见 contracts/types.js 的 TIMELINE_NODES），`label` 可选，
   * 省略时 `store.appendTimeline` 会自己查表；`ok` 缺省 true（这一站做成了）。
   *
   * @param {string} key 票据复合主键
   * @param {string} node 节点 id
   * @param {string} detail 一句给人看的中文补充
   * @param {boolean} [ok] 这一站做成了没有
   * @param {string} [label] 节点中文名（onFlow 会带过来）
   */
  async function markNode (key, node, detail, ok = true, label) {
    try {
      await store.appendTimeline(key, node, detail, ok, label)
    } catch (error) {
      logInfo('流程日志写入失败（不影响跑票）', {
        node,
        reason: String(error?.message ?? error),
      })
    }
  }

  // ── 扫描与入队 ──────────────────────────────────────────

  /**
   * 记一个「补充站点」：不是用户点名的 ①–⑨，但卡在这些地方同样要看得见。
   * 标签一律从 `TIMELINE_NODES` 查表（存进记录里是自包含的），调用方只给一句 detail。
   * @param {string} key
   * @param {string} node
   * @param {string} detail
   * @param {boolean} [ok]
   */
  async function markExtra (key, node, detail, ok = true) {
    const meta = TIMELINE_NODES[node]
    await markNode(key, node, detail, ok, meta?.label ?? node)
  }

  /**
   * 扫一轮，把变化落进存储。
   *
   * 扫失败**不吞**：返回 `scan-failed`，让 `pipeline_scan` 的调用方看见 ——
   * 「没变化」和「扫失败了」是两件事，混在一起会让人以为流水线是健康的。
   *
   * @param {AbortSignal} signal
   * @returns {Promise<{ created: number, updated: number, disappeared: number, revivals: number }>}
   */
  async function scanAndEnqueue (signal) {
    const counters = { created: 0, updated: 0, disappeared: 0, revivals: 0 }

    for (const source of sources) {
      const projectId = source.projectId
      const result = await source.scan(signal)

      for (const ticket of result.created ?? []) {
        const key = ticketKey(ticket.projectId ?? projectId, ticket.recordId)
        const existing = store.getTicket(key)
        if (existing && !TERMINAL.includes(existing.phase)) {
          // 见过但还活着（比如重启后水位丢了）—— 不当新票，按修订处理。
          continue
        }
        await store.enqueue(ticket, { phase: 'pending', attempt: 0, enqueuedAt: nowFn() })
        counters.created += 1
        logInfo('新票入队', { projectId: ticket.projectId ?? projectId, recordId: ticket.recordId, priority: ticket.priority, summary: summarize(ticket.description) })
        // ① 获取工单：这一刻就是「从表格里拿到这张票」的时刻。
        await markNode(key, 'discover',
          `扫到「处理中」一行，入队（项目 ${ticket.projectId ?? projectId}、优先级 ${ticket.priority ?? '未标'}、${summarize(ticket.description)}）`)
      }

      for (const ticket of result.updated ?? []) {
        const key = ticketKey(ticket.projectId ?? projectId, ticket.recordId)
        const existing = store.getTicket(key)
        if (!existing) {
          await store.enqueue(ticket, { phase: 'pending', attempt: 0, enqueuedAt: nowFn() })
          counters.created += 1
          await markNode(key, 'discover', '这一轮扫描里第一次见到这张票，入队')
          continue
        }
        if (!fingerprintChanged(existing, ticket.fingerprint)) continue
        if (TERMINAL.includes(existing.phase) && existing.phase !== 'failed') {
          // done / skipped / gone 收到修订：表格里人改了什么，说明还想再处理一次。
          //
          // 这条 revivals 通道与 `pipeline_reset` 的分工（#02）：
          // - revivals（这里）是「用户主动重做」：连内容一起重来一遍，**会覆盖旧回填结果**，
          //   revisionCount 不涨，因为没有「同一份需求的第 N 版」可言；
          // - pipeline_reset 是「重试失败的票」：只把失败/等信息的票放回队列，不改内容。
          // 两条都保留，但用户文案只教 reset（拨表格那条在生产里通常点不到，
          // 且它会重做一遍 —— 见 tools/pipeline-status.js 头注释）。
          await store.enqueue(ticket, { phase: 'pending', attempt: 0, enqueuedAt: nowFn() })
          counters.revivals += 1
          logInfo('终态票收到修订，重新入队', { projectId: ticket.projectId ?? projectId, recordId: ticket.recordId, was: existing.phase })
          await markNode(key, 'discover', `表格里这行从 ${existing.phase} 又被改成「处理中」，重新入队（上一轮的流程日志保留在下面，方便对照）`)
          continue
        }
        const { row, restarted } = await store.revise(ticket)
        counters.updated += 1
        logInfo('票有修订，排到队尾', { projectId: ticket.projectId ?? projectId, recordId: ticket.recordId, revisionCount: row.revisionCount, restarted })
        // 修订不打断当前运行、也不是一次新的「获取工单」，不另记 ① —— 下一轮
        // runOne 会重新记 ②③④…，时间线上自然能看出「这票又跑了一遍」。
      }

      for (const recordId of result.disappeared ?? []) {
        const key = ticketKey(projectId, recordId)
        const existing = store.getTicket(key)
        if (!existing) continue
        if (TERMINAL.includes(existing.phase)) continue
        await store.setPhase(key, 'gone', { lastError: undefined })
        counters.disappeared += 1
        logInfo('表格里这行消失了，退役', { projectId, recordId })
        await markNode(key, 'gone', '表格里这一行被删掉了，静默退役')
        // 工单 #14：`gone` 也在「没跑成」之列。但这一行的记录已经被删了，
        // 再往里写必然 404 —— 所以打开 writeBackOnFailure 时这里**故意不写**，
        // 写一次只会留下一条「记录不存在」的交付失败，对谁都没用。
        // 保留 willWriteBack('gone') 为真的判断是为了让调用方一眼看出这是刻意的（不是漏掉）。
      }
    }

    return counters
  }

  // ── 单票执行 ────────────────────────────────────────────

  /**
   * 跑一张票。返回 true 表示这一轮用掉了（无论成败）。
   *
   * 这里的错误处理分三档（对应架构文档 §8）：
   * - `aborted` → failed，不通知（人自己取消的）
   * - 不可重试（auth/not-found/invalid-input）→ 立刻 failed + 通知
   * - 可重试且 attempt < maxAttempts → 回 pending，**保留工作区**，下轮再来
   *
   * @param {TicketRecordRow} row
   * @returns {Promise<boolean>}
   */
  async function runOne (row) {
    const key = row.key
    const projectId = row.projectId ?? ''
    const recordId = row.recordId
    const maxAttempts = Math.max(1, Number(config.maxAttempts ?? 2))
    const ticket = rowToTicket(row)
    // 没有 `projectId` 的源（比如单平台的离线冒烟）挂不进 sourceByProject，
    // 但它依然可能是这张票的来源 —— 只有一个源时不存在歧义，直接用它。
    // 不补救的话，截图会静默变成「这轮没有图可带」：票照跑，图丢了。
    const source = sourceByProject.get(projectId) ?? (sources.length === 1 ? sources[0] : undefined)

    const handle = linkSignal(undefined)
    activeHandle = handle

    /** 超时定时器：包整票。 */
    // `ticketTimeoutMinutes` 允许小数 —— 自测里用 0.005 分钟(300ms) 验证超时链路，
    // 生产配置仍是整数分钟（Config 里 min 5）。
    const timeoutMinutes = Math.max(0.001, Number(config.ticketTimeoutMinutes ?? 40))
    // 用一个布尔记住「这次 abort 是超时引起的」。不能靠 catch 里比对错误消息：
    // abort 之后适配器抛的是它自己的取消错误，原始 abort reason 早就丢了。
    let timedOut = false
    // 执行器起会话时把 sessionId 交上来（见 contracts/work-executor.js 的
    // `ExecCtx.onSessionId`）。为什么要记在局部变量里：票在**执行器返回结果之前**
    // 就抛异常/超时/被取消时，result 根本不存在，而 sessionId 只有执行器自己知道。
    // 不记下来的话，失败的票上永远没有「处理会话」，人没法点进那一轮看它做了什么。
    let runSessionId = ''
    const timeoutId = setTimeout(() => {
      timedOut = true
      handle.abort(new Error('ticket-timeout'))
    }, timeoutMinutes * 60_000)

    /**
     * 租约心跳：跑票期间定期续租。
     *
     * 续租失败 = 租约已经被别的进程抢走 ⇒ 这张票不再归我们管，必须**让出**：
     * 中止本次执行、把票放回队列、**不通知人**。
     *
     * 为什么不让它跑完：两个进程在同一个 worktree 上同时改代码，合并时才发现就晚了。
     * 让出是唯一安全的选择 —— 另一进程抢到它就会从头跑一遍。
     */
    let leaseLost = false
    let heartbeatStopped = false
    /** @type {Promise<unknown> | null} */
    let heartbeatPending = null

    const heartbeatId = setInterval(() => {
      if (heartbeatStopped || leaseLost) return
      heartbeatPending = (async () => {
        try {
          const renewed = await store.renewLease(key, leaseTtlMs)
          if (!renewed) {
            leaseLost = true
            handle.abort(new Error('lease-lost'))
            logInfo('续租失败：租约已被别人抢走，让出这张票', { projectId, recordId })
          }
        } catch (error) {
          leaseLost = true
          handle.abort(new Error('lease-lost'))
          logInfo('续租出错，让出这张票', { projectId, recordId, reason: toPipelineError(error).message })
        }
      })()
    }, leaseHeartbeatMs)

    /**
     * 站点心跳：和租约心跳是**两个定时器**，不能合。
     *
     * 租约心跳必须跟着 `leaseHeartbeatMs` 走（自测会把它压到毫秒级），
     * 站点心跳固定在 60 秒 —— 合在一起的话，一次自测跑下来会往时间线里塞
     * 几百条心跳。`timelineHeartbeatMs` 同样只给自测用。
     */
    const timelineHeartbeatMs = Number.isFinite(timelineHeartbeatMsOverride) && timelineHeartbeatMsOverride > 0
      ? timelineHeartbeatMsOverride
      : TIMELINE_HEARTBEAT_MS
    const stationHeartbeatId = setInterval(() => {
      if (heartbeatStopped || leaseLost) return
      heartbeatPending = Promise.all([heartbeatPending, heartbeatLongStation()]).then(() => undefined)
    }, timelineHeartbeatMs)

    // 工作区坐标单独放一个可变对象 ws：row 是进 runOne 时的快照，
    // prepareWorkspace 的结果只写进了存储，不回填的话执行器收到的是空路径
    // —— 它会在一个不存在的目录里改代码。所以先建 ws、用 ws 调阶段回调、
    // 也用 ws 调执行器、失败的票也靠它告诉人工作区在哪，四处永远读同一份值。
    // 放在 try 之外：截图取不到、定位失败这些早期分支也要能读到它。
    const ws = {
      worktreePath: row.worktreePath,
      branch: row.branch,
      baseCommit: row.baseCommit,
      repoPath: row.repoPath,
      // 项目工作区（宿主 Workspace 的落点）：会话要挂它名下，见 core/workspace.js。
      // 老票据上没有这两个字段，undefined 就是「还没查过」，下一轮会补。
      workspacePath: row.workspacePath,
      workspaceId: row.workspaceId,
    }

    /**
     * 长站点心跳：跑验证可能十几分钟，时间线只在进站时打一条，中间全静默。
     *
     * 这不是新站点，是「这一站还在跑」的证据：`appendTimeline` 带
     * `heartbeat: true`，只和上一条心跳合并，绝不吃掉进站那条 ——
     * 所以「这一站什么时候开始的」永远留着，`pipeline_status` 才能把
     * 「已跑 13 分钟」和「3 分钟前还有心跳」分开说。
     *
     * 只在三个可能很慢的站上打：planning / editing / testing。
     * 其余站都是秒级，打心跳只会制造噪音。
     */
    const LONG_STATIONS = new Set(['planning', 'editing', 'testing'])
    /** 当前所在的长站点（不在长站点上时是 null）。 */
    let longStation = null
    /** 当前长站点的进入时刻，用来算「这一站已经跑了多久」。 */
    let longStationSince = 0

    async function heartbeatLongStation () {
      if (!longStation) return
      const elapsedMs = Math.max(0, nowFn() - longStationSince)
      const minutes = Math.floor(elapsedMs / 60_000)
      const detail = minutes >= 1
        ? `还在跑，这一站已经 ${minutes} 分钟（心跳，不是新站点）`
        : '还在跑（心跳，不是新站点）'
      try {
        await store.appendTimeline(key, longStation, detail, true, undefined, { heartbeat: true })
      } catch (error) {
        // 心跳写不进去不是事故：票本身还在跑，只是这一段时间「看起来没动」。
        logInfo('站点心跳写入失败（不影响跑票）', {
          node: longStation,
          reason: String(error?.message ?? error),
        })
      }
    }

    /**
     * 阶段回调：写存储 + 记日志。非法转移由 `setPhase` 拒绝，不抛。
     *
     * 第二参在契约（`contracts/work-executor.js` 的 `ExecCtx.onPhase`）里是
     * **(phase, detail?: string)** —— 一句给人看的阶段说明，不是字段补丁。
     * 但内核自己也要能用它补字段（例如 planning 落 plan），所以这里两种都收：
     * 字符串 = 只记日志的说明；对象 = 落库补丁。
     *
     * 不区分会导致一个很难看的真实事故：字符串被当成补丁传给 `setPhase`，
     * 而 `setPhase` 用 `Object.entries(patch)` 展开它，于是「跑项目配置里的验证命令」
     * 这十四个字变成 `{0:'跑',1:'项',…,13:'令'}` 写进票据行，存储里多出十几个垃圾字段。
     */
    const onPhase = async (phase, detailOrPatch = {}) => {
      const isDetail = typeof detailOrPatch === 'string'
      const patch = isDetail ? {} : detailOrPatch
      await store.setPhase(key, phase, patch)
      logInfo(`阶段 → ${phase}`, isDetail
        ? { projectId, recordId, detail: detailOrPatch }
        : { projectId, recordId })
      // 关键节点流程日志：节点 id 就等于 phase 名。执行器进到 editing/testing/
      // mr-opening 时调的就是这里，正好把「走到这一站」记进时间线 —— 这条就是
      // 回答「现在停在哪」的依据。只记 ①–⑨ 主站（no !== '·'）：worktree-ready、
      // planning、终态这些补充站由调度器自己在落库处显式记，顺序才不会乱。
      const meta = TIMELINE_NODES[phase]
      if (meta && meta.no !== '·') {
        await markNode(key, phase, isDetail ? String(detailOrPatch) : '', true, meta.label)
      }
      // 换站就换心跳目标：长站点开表，其余站关表。
      if (LONG_STATIONS.has(phase)) {
        if (longStation !== phase) {
          longStation = phase
          longStationSince = nowFn()
        }
      } else {
        longStation = null
      }
    }

    try {
      // 传 signal：定位器可能碰磁盘（isGitRepo 校验）或网络，这票被取消/超时之后
      // 还接着查下去毫无意义；不传的话它只是白干，而我们多等一份没有意义的耗时。
      const located = await locator.locate(ticket, handle.signal)
      await markNode(key, 'locate', `定位到项目 ${projectId}：仓库 ${located.repoPath ?? '（未给出）'}${located.baseBranch ? `，基准分支 ${located.baseBranch}` : ''}${located.module ? `，模块 ${located.module}` : ''}${located.remote ? `，remote ${located.remote}` : ''}`)

      // 截图是**输入**，不是阶段。必须在任何「开工」阶段之前处理掉：
      // 取不到就直接 needs-info，此时票还停在 pending，转移合法，
      // 也不会白建一个工作区。
      const shots = await showScreenshots(source, ticket, handle.signal)
      if (shots === false) {
        await markExtra(key, 'needs-info', '截图取不到，等你补图（票停在 needs-info，不会往下跑）', false)
        await store.releaseLease(key)
        return true
      }

      // 工作区是「能开工」的前提，阶段机不允许 pending → planning 直接跳。
      // 没有注入 `prepareWorkspace`（离线 mock 跑）时也照样走这一步，
      // 只是 worktreePath 留空 —— 阶段语义比「有没有目录」更基础。
      //
      // 判断条件里带上 workspacePath：老票据（升级前入队的）只有 worktreePath、
      // 没有工作区坐标，重启恢复后如果只看 worktreePath 就永远不会补登记，
      // 那张票的会话在 GUI 里始终挂不上项目 —— 所以缺工作区坐标时也要跑一次，
      // 由 prepareWorkspace 自己判断该复用已有 worktree 还是新建。
      //
      // 光看「字段有没有值」不够，必须再验一次它**现在还算不算数**。真实事故
      // （pms|reczz28VWNWVbpgL，2026-11-06）：票据上 worktreePath 还是旧配置时代
      // `.repos/mgiot-pms/.agents/worktrees/…` 下的隔离 worktree，那个目录早被删了，
      // 而 repoPath 已经改成 `D:\WorkSpace\mgiot-pms`。两个字段都「有值」，旧守卫
      // 整段跳过 prepareWorkspace，陈旧路径原样传给执行器 → executor-agent 的
      // `workingDirectory.set` 对着不存在的目录报错 → 票 failed；更糟的是
      // `resetByHuman` 不清工作区坐标，人工重开之后还会原样再失败一次。
      //
      // 所以复用前过两道闸：路径还在不在、是不是同一个仓库。任一不成立就当
      // 「没有工作区」重建，并把旧坐标从传给 prepareWorkspace 的入参里摘掉
      // —— 否则它会走「已有 worktree，只补登记」那条分支，把死路径原样回传。
      const currentRepoPath = typeof located?.repoPath === 'string' ? located.repoPath : ''
      const staleCoords = await isStaleWorkspaceCoords({
        worktreePath: ws.worktreePath,
        repoPath: ws.repoPath,
        currentRepoPath,
        worktreeExists,
      })
      if (staleCoords && typeof logInfo === 'function') {
        logInfo('票据上的工作区坐标已失效，这次重新准备', {
          projectId,
          recordId,
          worktreePath: ws.worktreePath,
          ticketRepoPath: ws.repoPath,
          currentRepoPath,
        })
      }

      const workspaceAction = staleCoords
        ? '票据上的工作区坐标已失效，重新准备'
        : (!row.worktreePath || !ws.workspacePath)
          ? '票据上还没有工作区，新建/登记一个'
          : '票据上的工作区坐标仍然有效，直接复用'
      if ((!row.worktreePath || !ws.workspacePath || staleCoords) && typeof prepareWorkspace === 'function') {
        const prepared = await prepareWorkspace({
          ticket,
          located,
          recordId,
          projectId,
          revisionCount: row.revisionCount,
          signal: handle.signal,
          fetch: BUILTIN_LIMITS.fetchBeforeCreate,
          // 已有 worktree **且坐标还有效**时把它传下去：工作区要补登，
          // 但分支与检出不该重建。坐标失效时一律不传，让实现重新建。
          worktreePath: staleCoords ? undefined : row.worktreePath,
          branch: staleCoords ? undefined : row.branch,
          baseCommit: staleCoords ? undefined : row.baseCommit,
          // 宿主工作区在 GUI 里显示的名字就是项目名。
          title: projectId,
        })
        if (prepared?.path) {
          ws.worktreePath = prepared.path
          ws.branch = prepared.branch
          ws.baseCommit = prepared.baseCommit
          ws.repoPath = prepared.repoPath ?? located.repoPath
          await onPhase('worktree-ready', {
            worktreePath: ws.worktreePath,
            branch: ws.branch,
            baseCommit: ws.baseCommit,
            repoPath: ws.repoPath,
            ...(prepared.workspacePath ? { workspacePath: prepared.workspacePath } : {}),
            ...(prepared.workspaceId ? { workspaceId: prepared.workspaceId } : {}),
          })
        }
        if (prepared?.workspacePath) {
          ws.workspacePath = prepared.workspacePath
          ws.workspaceId = prepared.workspaceId
        }
      }
      if (store.getTicket(key)?.phase === 'pending') {
        await onPhase('worktree-ready', {})
      }
      await markExtra(key, 'worktree-ready', `工作目录 ${ws.worktreePath || '（未建，离线跑）'}${ws.branch ? `，分支 ${ws.branch}` : ''}${ws.workspacePath ? `，项目工作区 ${ws.workspacePath}` : '，未归属到项目工作区'}`)
      await markNode(key, 'workspace', `${workspaceAction}${ws.repoPath ? `；检出 ${ws.repoPath}` : ''}`)

      await onPhase('planning', {
        module: located.module ?? row.module,
        startedAt: row.startedAt ?? nowFn(),
      })
      await markExtra(key, 'planning', `模块 ${located.module ?? row.module ?? '未标'}，改代码前先整理任务书与基线`)

      const result = await executor.run(ticket, located, {
        signal: handle.signal,
        worktreePath: ws.worktreePath,
        branch: ws.branch,
        baseCommit: ws.baseCommit,
        repoPath: ws.repoPath,
        // 项目工作区：执行器用它决定会话的 cwd 与归属（见 core/workspace.js 的说明）。
        workspacePath: ws.workspacePath,
        workspaceId: ws.workspaceId,
        // prompt 是纯文本，content 是同一份任务书外加截图块。
        // 两个都传：老适配器只认 prompt，新适配器按 content 才能看见图。
        prompt: renderTicketPrompt(ticket, located),
        content: renderTicketContent(ticket, located, shots),
        images: shots,
        config,
        log: (msg, detail) => logInfo(msg, detail),
        onPhase,
        // 执行器内部才知道的那几站（主要是 ④ 创建会话：分支 + 模型）由它自己
        // 调 onFlow 报上来；这里只负责把它落到票据的时间线上，不让日志写失败炸整票。
        onFlow: (node, label, detail, ok) => markNode(key, node, detail, ok, label),
        // 会话 id 先存着：执行器后面抛异常/超时/被取消时，返回值根本不存在，
        // 只有这里能拿到「哪一次会话没干成活」。见上面的 runSessionId。
        onSessionId: (sessionId) => {
          if (typeof sessionId === 'string' && sessionId.length > 0) runSessionId = sessionId
        },
      })

      // `WorkExecutor` 已经把 phase 走到 done/skipped/failed 之一，这里只落结果并通知。
      const finalPhase = result.phase
      // 先把 error 对象压成字符串，落库与通知共用同一个值：
      // 通知模板里 lastError 是直接拼进正文的，塞对象进去人只会看到 [object Object]。
      // 另外执行器返回成功时不带 error，此时必须显式写 undefined，
      // 否则上一次失败的原因会一直挂在票上骗人。
      //
      // **不拼 `kind: ` 前缀**（#08）：`internal:` 是分类枚举，不是人话。
      // 真机上人看到「internal: agent 没有产生任何文件改动」的第一反应是
      // 「internal 是什么？我该改哪里？」。分类仍然有用，但它属于程序，
      // 所以单独存进 `lastErrorKind`，正文只给 message。
      const finalLastError = result.error ? result.error.message : undefined
      const finalLastErrorKind = result.error ? result.error.kind : undefined
      // 终态先落库，回填/通知后做 —— 这两步之间进程崩掉的话，票已经是 done 了，
      // 而表格没回填、通知也没发。谁都发现不了：票在队列里看起来一切正常。
      //
      // 所以把「还没做完的事后动作」和终态**同一次写入**落库（pendingEffects），
      // 各自成功后再逐个清掉。崩在中间时，下次启动 `replayPendingEffects()` 会补做。
      // 只登记真的会去做的动作：writeBack 被配置关掉、或源没有 writeResult 时不算。
      /** @type {any} */
      const pendingEffects = {}
      let writeBackPlanned = false
      if (willWriteBack(source, finalPhase)) {
        writeBackPlanned = true
        pendingEffects.writeBack = {
          phase: finalPhase,
          plan: result.plan ?? row.plan,
          commit: result.commit,
          mr: result.mr,
          changedFiles: result.changedFiles ?? row.changedFiles,
          worktreePath: ws.worktreePath,
          sessionId: result.sessionId,
          verification: { outcome: result.testOutcome, detail: result.testDetail },
        }
      }
      if (willNotify(finalPhase)) pendingEffects.notify = true

      await store.setPhase(key, finalPhase, {
        changedFiles: result.changedFiles ?? row.changedFiles,
        testOutcome: result.testOutcome,
        testDetail: result.testDetail,
        commit: result.commit,
        mr: result.mr,
        sessionId: result.sessionId,
        plan: result.plan ?? row.plan,
        lastError: finalLastError,
        lastErrorKind: finalLastErrorKind,
        pendingEffects: Object.keys(pendingEffects).length > 0 ? pendingEffects : undefined,
      })
      await markExtra(key, finalPhase, finalLastError ? `执行器收尾：${finalLastError}` : (result.commit?.sha ? `本地提交 ${String(result.commit.sha).slice(0, 12)}` : '执行器收尾，无本地提交'), finalPhase !== 'failed')

      // ── 交付维度（#08）────────────────────────────────────────
      // 改动提交是这里的第一项交付。done/skipped 却没有提交等于没东西可 review，
      // 得记成「没交出去」，不能因为票面写着「已完成」就当它成了。
      if (finalPhase === 'done' || finalPhase === 'skipped') {
        if (result.commit?.sha) {
          await store.setDelivery(key, 'commit', { ok: true, attempts: 1, error: undefined, giveUp: undefined })
        } else if (result.mr?.url) {
          // 只有 MR 没有本地提交也是合法交付（远程出口），不记失败。
          await store.setDelivery(key, 'commit', { ok: true, attempts: 1, error: undefined, giveUp: undefined })
        } else {
          await store.setDelivery(key, 'commit', {
            ok: false,
            attempts: 1,
            error: '执行器说做完了，但既没有本地提交也没有 MR —— 没有可 review 的改动',
            errorKind: 'internal',
          })
        }
      }

      // 回填工单表：只在「真的改完了」的时候写。failed 不写 —— 表里那一行还是
      // 「处理中」，人一眼就能看出这票没成，等着重新拨进队列。
      const writeBackReceipt = await writeBackFor(source, ticket, {
        phase: finalPhase,
        result,
        plan: result.plan ?? row.plan,
        commit: result.commit,
        mr: result.mr,
        changedFiles: result.changedFiles ?? row.changedFiles,
        worktreePath: ws.worktreePath,
        sessionId: result.sessionId,
        verification: { outcome: result.testOutcome, detail: result.testDetail },
      }, handle.signal)
      if (writeBackReceipt !== undefined) {
        // 回填结果落库：面板与状态工具能显示「表格写没写成功」，
        // 写失败时人不用去表格里一行行找。
        await store.setPhase(key, finalPhase, { writeBack: writeBackReceipt })
      }
      // 待办清不清，**只看写成了没有**（#08）。以前无论成败都清，
      // 于是「写失败」这件事在存储里彻底消失 —— 启动补偿永远捞不到它，
      // 表格里那一行就永远停在「处理中」，而没有任何地方会说这件事。
      // 不清也有代价：每次启动都会再试一次。所以只有「值得再试」的才留着，
      // 不可重试的（同步表、缺列、没权限）当场放弃并记成人话。
      await settleWriteBack(key, writeBackReceipt, writeBackPlanned)
      if (writeBackReceipt === undefined) {
        await markNode(key, 'writeback', '按配置跳过（writeBack=false、源没有 writeResult，或这一站不是 done/skipped）')
      } else if (writeBackReceipt.written) {
        await markNode(key, 'writeback', `已写回工单表（${(writeBackReceipt.fields ?? []).join('、') || '状态/结果/处理时间'}）`)
      } else {
        await markNode(key, 'writeback', `回填没写成：${writeBackReceipt.note ?? '原因未记录'}`, false)
      }

      // 不铺 ...result：ExecResult 里的 error 是对象，铺进来会污染整个通知载荷。
      // 逐字段显式搬运，通知里读到的就是这次执行的结果而不是运行前的快照。
      // 工作区坐标同样取自 ws：执行器返回 failed 时也要告诉人「工作区保留在」哪里，
      // 只铺 ...row 的话首次运行（row 里还没有 worktreePath）就漏了这一行。
      await notifyFor(ticket, {
        ...row,
        worktreePath: ws.worktreePath,
        branch: ws.branch,
        baseCommit: ws.baseCommit,
        phase: finalPhase,
        changedFiles: result.changedFiles ?? row.changedFiles,
        testOutcome: result.testOutcome,
        testDetail: result.testDetail,
        commit: result.commit,
        mr: result.mr,
        // 会话 id 也要传：通知是用户最常看的界面，想追问「它当时怎么想的」得能
        // 直接找到那个会话，而不是回 GUI 翻列表（断点 B3）。
        sessionId: result.sessionId ?? row.sessionId,
        plan: result.plan ?? row.plan,
        lastError: finalLastError,
        // 回填结果要传给通知：表格没写成时通知正文里要如实写出来，
        // 否则人只看通知会以为这票整条链路都成了。
        writeBack: writeBackReceipt,
        // 交付维度也带过去：通知正文要靠 `delivery.writeBack.giveUp` 决定
        // 是说「会再自动试一次」还是「这不是再试一次能好的」（#08）。
        delivery: store.getTicket(key)?.delivery,
      }, handle.signal)
      // 待办只在通知**真的发出去了**的时候清（#08）。以前无条件清，于是
      // 「通知发不出去」这件事在存储里消失，状态页一切正常而人什么都没收到。
      // notifyFor 自己会把 delivery.notify 记成成功/失败，这里只读结果。
      if (pendingEffects.notify && store.getTicket(key)?.delivery?.notify?.ok === true) {
        await clearPendingEffect(key, 'notify')
      }
      await markNode(key, 'notify', willNotify(finalPhase)
        ? `已按配置给 ${(config.notifyOn ?? ['done', 'skipped', 'failed', 'needs-info']).join('、')} 发消息`
        : `按配置不发（notifyOn 不含 ${finalPhase}）`)
      await store.releaseLease(key)
      return true
    } catch (error) {
      const normalized = toPipelineError(error)

      // 租约丢了：这票归别人管了。让出，不算失败，也不打扰人。
      // 必须排在 abort 判断之前 —— abort 之后适配器抛的是它自己的取消错误。
      if (leaseLost) {
        await store.setPhase(key, 'pending', {
          lastError: '租约丢失（被其他进程抢走），已让出这张票',
          enqueuedAt: nowFn(),
        })
        await markExtra(key, 'failed', '租约被别的进程抢走，本轮让出、重新排队（不是这一轮跑挂了）', false)
        logInfo('已让出这张票', { projectId, recordId })
        await store.releaseLease(key)
        return true
      }

      // `timedOut` 必须并进这个判断：执行器被 abort 之后抛的往往是它自己包装过的错误
      // （`PipelineError('internal', '挂住后被取消')`），归一化之后 kind 不是 aborted ——
      // 只认 isAbortError 会把它当成「可重试的 internal」退回队列，于是超时的票
      // 既不标 failed 也不通知人，只是安静地再跑一遍，再超时一遍。
      if (isAbortError(normalized) || timedOut) {
        // 人工取消不通知；超时要通知（人不在电脑前，得知道卡住了）。
        // 超时同样是「落库了但通知没发」的窗口，登记待办（取消路径不通知，不登记）。
        // 超时也算 failed，所以 writeBackOnFailure 打开时也要回填失败原因（#14）；
        // 人工取消不回填 —— 人按了取消就是不想让这条链路再动任何远端状态。
        const writeBackTimeout = timedOut && willWriteBack(source, 'failed')
        /** @type {Record<string, any>} */
        const timeoutEffects = {}
        if (writeBackTimeout) {
          timeoutEffects.writeBack = {
            phase: 'failed',
            lastError: `超时 ${timeoutMinutes} 分钟`,
            worktreePath: ws.worktreePath,
            sessionId: runSessionId,
          }
        }
        if (timedOut && willNotify('failed')) timeoutEffects.notify = true
        await store.setPhase(key, 'failed', {
          // 失败也要把会话 id 落下：人看到「失败了」之后第一件想做的事就是
          // 「它当时在干什么」，没有 id 就只能去会话列表里翻。
          sessionId: runSessionId.length > 0 ? runSessionId : undefined,
          lastError: timedOut ? `超时 ${timeoutMinutes} 分钟` : 'cancelled by user',
          pendingEffects: Object.keys(timeoutEffects).length > 0 ? timeoutEffects : undefined,
        })
        await markExtra(key, 'failed', timedOut ? `整票超时 ${timeoutMinutes} 分钟，已标 failed` : '被人工取消，已标 failed', false)
        if (writeBackTimeout) {
          // 和通知一样**故意不传 handle.signal**：走到这里它必然已 aborted，
          // 传下去回填适配器第一行就会抛 aborted，等于永远写不进去。
          const timeoutReceipt = await writeBackFor(source, ticket, timeoutEffects.writeBack, undefined)
          if (timeoutReceipt !== undefined) {
            await store.setPhase(key, 'failed', { writeBack: timeoutReceipt })
          }
          await settleWriteBack(key, timeoutReceipt, true)
          await markNode(key, 'writeback', timeoutReceipt?.written === false ? '超时后回填没写成（见交付·回填表格）' : '已把超时原因写回「处理结果」列', timeoutReceipt?.written !== false)
        }
        if (timedOut) {
          // 这里**故意不传 handle.signal**：走到这一行时它必然已经 aborted，
          // 而推送适配器（push-mock 第一行就是这么写的）见 aborted 会把消息原样推回 ——
          // 结果是「超时的票，人永远收不到它失败了」这一条最该送达的通知被自己吞掉。
          // 取消不通知在这里之上就 return 了，能走到这里的就是超时，必须送达；
          // 不传 signal 也不会把 tick 卡死 —— notifyFor 内部自带 notifyTimeoutMs 上限。
          await notifyFor(ticket, {
            ...row,
            worktreePath: ws.worktreePath,
            branch: ws.branch,
            baseCommit: ws.baseCommit,
            phase: 'failed',
            lastError: `超时 ${timeoutMinutes} 分钟`,
            sessionId: runSessionId.length > 0 ? runSessionId : row.sessionId,
          })
          if (willNotify('failed') && store.getTicket(key)?.delivery?.notify?.ok === true) {
            await clearPendingEffect(key, 'notify')
          }
          await markNode(key, 'notify', '超时通知已发出（不传已 aborted 的 signal，免得被推送适配器吞掉）')
        }
        logInfo(timedOut ? '超时，已标 failed' : '被取消，已标 failed', { projectId, recordId, worktreePath: row.worktreePath })
        await store.releaseLease(key)
        return true
      }

      const attempt = (row.attempt ?? 0) + 1
      const retryable = normalized.retryable && attempt < maxAttempts

      if (retryable) {
        // 退避：第 1 次失败等 30 秒，之后翻倍（30s → 1m → 2m → …），封顶 30 分钟。
        // 不退避的话，一张「服务端正 503」的票会被 tick 一轮一轮地立刻捞回来空转，
        // 把对方打得更狠，也让真正能跑的票一直排在这张后面。
        // 服务端给了 retryAfterMs（rate-limit 的 429 头）就听它的 —— 那是它自己说的
        // 「你什么时候再来」，比我们猜的曲线准；但没有理由超过封顶值，所以照样夹住。
        const waitMs = backoffDelayMs(attempt, normalized.retryAfterMs, randomFn)
        const dueAt = nowFn() + waitMs
        await store.setPhase(key, 'pending', {
          attempt,
          // 与前一处同理：不写 `kind: ` 前缀（#08）。分类进 lastErrorKind。
          lastError: normalized.message,
          lastErrorKind: normalized.kind,
          enqueuedAt: dueAt,
        })
        await markExtra(key, 'failed', `第 ${attempt} 次没跑成（${normalized.message}），可重试，${Math.round(waitMs / 1000)} 秒后再来`, false)
        logInfo('可重试错误，退避后再来', { projectId, recordId, attempt, kind: normalized.kind, retryInMs: waitMs })
      } else {
        // 失败也是终态，同样有「落库了但通知没发」的窗口：DSH 重启一次，
        // 人就永远不知道这票失败了。所以和 done/skipped 一样先登记待办。
        // 「失败不回填」现在是可配的（工单 #14）：writeBackOnFailure 打开时，
        // 只往「处理结果」列写一段说明，不碰「是否处理」—— 那列填上就等于说「处理完了」。
        const writeBackFailure = willWriteBack(source, 'failed')
        /** @type {Record<string, any>} */
        const failedEffects = {}
        if (writeBackFailure) failedEffects.writeBack = { phase: 'failed', lastError: normalized.message, worktreePath: ws.worktreePath, sessionId: runSessionId, attempt }
        if (willNotify('failed')) failedEffects.notify = true
        await store.setPhase(key, 'failed', {
          attempt,
          // 同上：失败终态也要留住会话 id，否则通知与状态里都没有可追问的入口。
          sessionId: runSessionId.length > 0 ? runSessionId : undefined,
          lastError: normalized.message,
          lastErrorKind: normalized.kind,
          pendingEffects: Object.keys(failedEffects).length > 0 ? failedEffects : undefined,
        })
        await markExtra(key, 'failed', `第 ${attempt} 次没跑成，已用尽重试：${normalized.message}`, false)
        if (writeBackFailure) {
          const failedReceipt = await writeBackFor(source, ticket, failedEffects.writeBack, handle.signal)
          if (failedReceipt !== undefined) {
            await store.setPhase(key, 'failed', { writeBack: failedReceipt })
          }
          await settleWriteBack(key, failedReceipt, true)
          await markNode(key, 'writeback', failedReceipt?.written === false ? '失败的回填没写成（见交付·回填表格）' : '已把失败原因写回「处理结果」列', failedReceipt?.written !== false)
        }
        // 工作区坐标要带 ws 的值，不能用 ...row：row 是进 runOne 时的快照，
        // 首次运行时里面根本没有 worktreePath，失败的票明明留着工作区，
        // 通知正文却会缺掉「工作区保留在」那一行 —— 人照着去修时找不到目录。
        await notifyFor(ticket, {
          ...row,
          worktreePath: ws.worktreePath,
          branch: ws.branch,
          baseCommit: ws.baseCommit,
          phase: 'failed',
          sessionId: runSessionId.length > 0 ? runSessionId : row.sessionId,
          lastError: normalized.message,
        }, handle.signal)
        if (willNotify('failed') && store.getTicket(key)?.delivery?.notify?.ok === true) {
          await clearPendingEffect(key, 'notify')
        }
        await markNode(key, 'notify', '失败通知已发出')
        logInfo('失败，已通知', { projectId, recordId, kind: normalized.kind, worktreePath: ws.worktreePath })
      }
      await store.releaseLease(key)
      return true
    } finally {
      clearTimeout(timeoutId)
      heartbeatStopped = true
      clearInterval(heartbeatId)
      clearInterval(stationHeartbeatId)
      // 心跳与收尾可能撞上（续租写回租约行、释放租约删掉它）。等它跑完再兜底释放一次，
      // 免得留下一条自己还占着的租约，把这张票挡住 10 分钟。
      if (heartbeatPending) {
        try {
          await heartbeatPending
        } catch {
          // 心跳自己的错误已经在回调里处理过了，这里不重复上报。
        }
      }
      await store.releaseLease(key)
      activeHandle = null
    }
  }

  /**
   * 截图通路 C（混合）：先把字节存进附件库，再作为 `ImageBlock` 塞进消息。
   *
   * 这一层只做「取字节 → saveImage」，**取不到不 fail 整票**：
   * 标 `needs-info`、通知人补图，票留在队列外等人。少一张图不该让一条能修的工单卡死。
   *
   * 返回值是**存下来的图片引用数组**（saveImage 返回什么就收集什么），
   * 由 runOne 原样交给执行器：图存在附件库里、这里只有句柄，
   * 丢掉它等于把截图白存了一遍，执行器根本看不见图。
   * saveImage 可能什么都不返回（离线 mock 就是），那就收集到 undefined —— 调用方自己过滤。
   *
   * @param {TicketSource | undefined} source
   * @param {Ticket} ticket
   * @param {AbortSignal} signal
   * @returns {Promise<false | unknown[]>} false = 已转 needs-info，整票本轮到此为止；否则是图片引用数组（可能是空数组）
   */
  async function showScreenshots (source, ticket, signal) {
    // 没截图 / 没存图能力 / 没有对应的 source：都不是错误，只是这轮没有图可带。
    if (!Array.isArray(ticket.screenshots) || ticket.screenshots.length === 0) return []
    if (typeof saveImage !== 'function') return []
    if (!source) return []

    const key = ticketKey(ticket.projectId, ticket.recordId)
    /** @type {unknown[]} */
    const images = []
    let saved = 0
    for (const ref of ticket.screenshots) {
      if (signal.aborted) return images
      try {
        const loaded = await source.loadScreenshot(ref, signal)
        const image = await saveImage({
          data: loaded.data,
          mediaType: loaded.mediaType,
          name: loaded.name ?? `${ticket.recordId}-${saved + 1}`,
        })
        images.push(image)
        saved += 1
      } catch (error) {
        const reason = toPipelineError(error)
        if (isAbortError(reason)) return images
        logInfo('截图取不到，标 needs-info', {
          projectId: ticket.projectId,
          recordId: ticket.recordId,
          ref: ref.kind,
          reason: reason.message,
        })
        await store.setPhase(key, 'needs-info', {
          lastError: '截图取不到，需要人补图',
        })
        // 工单 #14：needs-info 也是「没跑成」，writeBackOnFailure 打开时同样只写「处理结果」一列。
        // 这一步在取图阶段就走完了，所以拿不到提交/会话上下文，只有一句原因 —— 够用：
        // 人打开表格看到的就是「等你补图」，下一步动作唯一。
        if (willWriteBack(source, 'needs-info')) {
          const infoReceipt = await writeBackFor(source, ticket, {
            phase: 'needs-info',
            lastError: '截图取不到，需要人补图',
          }, signal)
          if (infoReceipt !== undefined) {
            await store.setPhase(key, 'needs-info', { writeBack: infoReceipt })
          }
          await settleWriteBack(key, infoReceipt, true)
        }
        await notifyFor(ticket, {
          ...(store.getTicket(key) ?? {}),
          phase: 'needs-info',
        }, signal)
        return false
      }
    }
    if (saved > 0) logInfo(`已存 ${saved} 张截图`, { projectId: ticket.projectId, recordId: ticket.recordId })
    return images
  }

  // ── 事后动作（回填 / 通知）的登记与补偿 ────────────────

  /**
   * 这个终态会不会真的去回填工单表。
   *
   * 只登记**真的会执行**的动作：`writeBack: false` 或源没实现 `writeResult` 时
   * 不写 pendingEffects —— 否则每次启动都会捞到一批永远做不完的票。
   *
   * @param {TicketSource | undefined} source
   * @param {Phase} phase
   * @returns {boolean}
   */
  function willWriteBack (source, phase) {
    if (config.writeBack === false) return false
    if (typeof source?.writeResult !== 'function') return false
    if (phase === 'done' || phase === 'skipped') return true
    // 失败三种终态：只有显式打开 writeBackOnFailure 才回填，而且只写「处理结果」一列（工单 #14）。
    // 缺省关的原因是「是否处理」这三列在飞书里是给人看进度的，把一张失败的票写进去
    // 会让看板显示成「处理完了」，比不写更糟。
    if (config.writeBackOnFailure !== true) return false
    return phase === 'failed' || phase === 'needs-info' || phase === 'gone'
  }

  /**
   * 这个阶段会不会真的发通知（同一份 notifyOn 判定，登记与执行必须一致）。
   * @param {Phase | undefined} phase
   * @returns {boolean}
   */
  function willNotify (phase) {
    if (!phase) return false
    const notifyOn = Array.isArray(config.notifyOn) ? config.notifyOn : ['done', 'skipped', 'failed', 'needs-info']
    return notifyOn.includes(phase)
  }

  /**
   * 清掉一个事后动作标记（不动 finishedAt —— 那是「何时到终态」，补做动作不该改它）。
   * @param {string} key
   * @param {'writeBack'|'notify'} name
   */
  async function clearPendingEffect (key, name) {
    await store.clearPendingEffect(key, name)
  }

  /**
   * 回填之后收尾：决定待办留不留、交付状态怎么写（工单 #08 / #14）。
   *
   * 三条规则（每条都对应一个真出现过的错）：
   * 1. **回执为空**（这次压根不该回填，比如 writeBack=false）⇒ 清待办。
   * 2. **写成了** ⇒ 清待办 + 交付记成功，并把上一次的失败原因清掉
   *    （`setDelivery` 合并写，`error: undefined` 是「明确清掉」不是「没提到」）。
   * 3. **没写成** ⇒ 分两档：还能救的留着待办等下次补做，救不了的当场放弃并置 `giveUp`,
   *    让界面能说「这不是再试一次能好的，得你改表格设置」。
   *    「救不了」的判断权在适配器（`retryable`），这里只负责尊重它。
   *
   * @param {string} key
   * @param {{ written?: boolean, note?: string, retryable?: boolean, errorKind?: string } | undefined} receipt
   * @param {boolean} planned 这一次是否本来就打算回填（决定「没回执」该不该清待办）
   */
  async function settleWriteBack (key, receipt, planned) {
    if (!planned) return
    // 这里必须自己算一次：`maxAttempts` 是 runOne 的局部量（它对单票重试口径负责），
    // 而这里是补做路径也要用的收尾逻辑 —— 借用局部量会 ReferenceError。
    const attemptLimit = Math.max(1, Number(config.maxAttempts ?? 2))
    if (receipt === undefined || receipt.written !== false) {
      await clearPendingEffect(key, 'writeBack')
      await store.setDelivery(key, 'writeBack', {
        ok: true,
        attempts: 1,
        error: undefined,
        errorKind: undefined,
        giveUp: undefined,
      })
      return
    }

    const pendingBefore = store.getTicket(key)?.pendingEffects?.writeBack
    const attempts = Number(pendingBefore?.attempts ?? 0) + 1
    const retryable = receipt.retryable === true
    const willRetry = retryable && attempts < attemptLimit
    const error = receipt.note ?? '回填失败'

    if (willRetry) {
      // 留着待办，下次启动（或人工重开）再试。attempts 记在待办里，
      // 因为「试过几次」是待办自己的属性，票面下一次可能就成功了。
      await store.retryPendingEffect(key, 'writeBack', { error, errorKind: receipt.errorKind })
    } else {
      await clearPendingEffect(key, 'writeBack')
    }
    await store.setDelivery(key, 'writeBack', {
      ok: false,
      attempts,
      error,
      errorKind: receipt.errorKind,
      giveUp: !willRetry,
    })
  }

  /**
   * 启动补偿：把「已经到了终态、但事后动作没做完」的票补做一遍（用户 2026-11-06 要求）。
   *
   * 场景是真会发生的：终态 `setPhase` 落库之后、回填/通知之前，进程被关掉（DSH 重启、
   * 崩溃、机器休眠后被杀）。没有这一步的话，票在队列里看起来一切正常，表格却永远停在
   * 「处理中」，人也从来没收到通知 —— 而且没有任何地方会提示这一点。
   *
   * 两条纪律：
   * 1. **回填幂等**：写的是同样的「是否处理 / 处理结果 / 处理日期」三列，补做只是再写一次；
   * 2. **通知补发要在日志里说清楚**：人可能已经看过一次通知，重发时必须能看出这是补发，
   *    否则会以为是新的一轮。
   *
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<number>} 补做了几个动作（给日志/自测用）
   */
  async function replayPendingEffects (options = {}) {
    const signal = options.signal
    const pending = store.listTickets().filter((row) => (
      row.pendingEffects && TERMINAL.includes(row.phase)
    ))
    if (pending.length === 0) return 0

    logInfo(`启动补偿：有 ${pending.length} 张票的事后动作没做完，开始补做`, {
      keys: pending.map((row) => `${row.projectId}/${row.recordId}`),
    })

    let replayed = 0
    for (const row of pending) {
      if (signal?.aborted) break
      const ticket = rowToTicket(row)
      const source = sourceByProject.get(row.projectId) ?? (sources.length === 1 ? sources[0] : undefined)
      const effects = row.pendingEffects ?? {}

      if (effects.writeBack) {
        const receipt = await writeBackFor(source, ticket, effects.writeBack, signal)
        if (receipt !== undefined) {
          await store.setPhase(row.key, row.phase, { writeBack: receipt })
        }
        // 补做也失败了怎么办（#08）：和第一次走同一条分档规则 ——
        // 分成两处写会漂移（曾经一处清了待办、另一处没清），所以收敛到 settleWriteBack。
        await settleWriteBack(row.key, receipt, true)
        await markNode(row.key, 'writeback', '启动补偿：上次进程在回填前退出了，这一站是补做', receipt?.written !== false)
        replayed += 1
      }

      if (effects.notify) {
        const current = store.getTicket(row.key) ?? row
        logInfo('补发通知（上次进程在回填/通知之间退出了，这条是补发不是新一轮）', {
          projectId: row.projectId,
          recordId: row.recordId,
          phase: current.phase,
        })
        await notifyFor(ticket, { ...current, phase: current.phase }, signal)
        // notifyFor 自己会把 delivery.notify 写成成功/失败；待办只在**成功**时清，
        // 否则「通知发不出去」这件事会被一次补做失败彻底抹掉。
        if (store.getTicket(row.key)?.delivery?.notify?.ok === true) {
          await clearPendingEffect(row.key, 'notify')
        }
        await markNode(row.key, 'notify', '启动补偿：上次进程在通知前退出了，这条是补发不是新一轮')
        replayed += 1
      }
    }
    return replayed
  }

  // ── 回填工单表 ──────────────────────────────────────────

  /**
   * 票跑成之后把结果写回工单表（用户 2026-11-06 要求）。
   *
   * 三条设计约束，每条都对应一个真实坑：
   *
   * 1. **只写 done / skipped**。failed 不写：表里那行还留着「处理中」，人一眼看出
   *    这票没成、等着重新拨进队列。写回去反而让人以为处理完了。
   * 2. **回填失败绝不影响票态**。表格写不进去是我们的网络/权限问题，不是这票白干了；
   *    票该是 done 还是 done，只在 `writeBack.note` 里记一句为什么没写成。
   * 3. **不传 handle.signal 之外的信号，且被取消就不写**。人按了取消，说明他不想
   *    这条链路再动任何远端状态。
   *
   * 源没实现 `writeResult`（比如 mock 源 / 老适配器）或配置里 `writeBack: false`
   * 时直接返回 undefined —— 调用方据此知道「什么都没发生」，不必落库。
   *
   * @param {TicketSource | undefined} source
   * @param {Ticket} ticket
   * @param {{
   *   phase: Phase,
   *   result: import('../contracts/work-executor.js').ExecResult,
   *   plan?: any,
   *   commit?: { sha: string, branch: string, files: string[] },
   *   mr?: { iid: number, url: string, draft: boolean },
   *   changedFiles?: string[],
   *   worktreePath?: string,
   *   sessionId?: string,
   *   verification?: { outcome?: string, detail?: string },
   * }} input
   * @param {AbortSignal} [signal]
   * @returns {Promise<import('../contracts/ticket-source.js').WriteBackReceipt | undefined>}
   */
  async function writeBackFor (source, ticket, input, signal) {
    // 关掉就完全不碰表格 —— 有人就是要「表格只读」，这个开关是他们唯一的出口。
    if (config.writeBack === false) return undefined
    if (typeof source?.writeResult !== 'function') return undefined
    const successPhase = input.phase === 'done' || input.phase === 'skipped'
    // 失败终态回填（工单 #14）：只有 writeBackOnFailure 打开时才写，而且**只写「处理结果」一列**。
    // 不写「是否处理」是因为它在这张表里的语义是「处理完了」：把一张失败的票写进去，
    // 看板上那一行立刻变成「已处理」，比什么都不写更误导人。
    const failurePhase = input.phase === 'failed' || input.phase === 'needs-info' || input.phase === 'gone'
    const onlyResult = !successPhase
    if (!successPhase && !(failurePhase && config.writeBackOnFailure === true)) return undefined
    if (signal?.aborted) {
      return { written: false, note: '这张票被取消了，按约定不回填表格' }
    }

    const status = typeof config.writeBackStatus === 'string' && config.writeBackStatus.trim().length > 0
      ? config.writeBackStatus.trim()
      : '是'
    const result = onlyResult
      ? renderFailureWriteBack(ticket, input)
      : renderWriteBackResult(ticket, { ...input, status })
    const handledAt = nowFn()

    try {
      const receipt = await source.writeResult(
        ticket.recordId,
        onlyResult ? { result, onlyResult: true } : { status, result, handledAt },
        signal,
      )
      const written = receipt?.written === true
      const normalized = {
        written,
        fields: Array.isArray(receipt?.fields) ? receipt.fields.map(String) : [],
        at: handledAt,
      }
      if (typeof receipt?.note === 'string' && receipt.note.length > 0) normalized.note = receipt.note
      // 「没写成」是哪种没写成，决定了还能不能救（#08）：
      //   - 源显式说「结构上不行」（同步表、缺列、电子表格不分回填）⇒ 不可重试，
      //     再试一百次也是同一个错误，只会让启动补偿每次都撞一遍；
      //   - 其它（网络、限流、鉴权过期）⇒ 值得再试一次。
      // 适配器可以自己在回执上标 `retryable`；没标时按「有 note = 配置问题」推断，
      // 因为适配器写 note 的地方全都是「这张表不能这么写」这一类。
      if (!written) {
        normalized.retryable = receipt?.retryable === true
        if (typeof receipt?.errorKind === 'string') normalized.errorKind = receipt.errorKind
      }
      logInfo(written ? '已回填工单表' : '工单表没写成', {
        projectId: ticket.projectId,
        recordId: ticket.recordId,
        status,
        fields: normalized.fields,
        note: normalized.note,
      })
      return normalized
    } catch (error) {
      // 回填是「顺手做的事」：它挂了不能反过来把一张已经干完的票判失败。
      const reason = toPipelineError(error)
      logInfo('回填工单表失败（不影响票据状态）', {
        projectId: ticket.projectId,
        recordId: ticket.recordId,
        kind: reason.kind,
        reason: reason.message,
      })
      // note 里**不写 `kind: ` 前缀**（#08）：这段文字会进表格、进通知、进状态页，
      // 都是给人看的。分类放 errorKind，程序自己用。
      return {
        written: false,
        note: reason.message,
        errorKind: reason.kind,
        retryable: retryPolicy(reason.kind) === 'retry',
      }
    }
  }

  // ── 通知 ────────────────────────────────────────────────

  /**
   * 按配置决定要不要通知，并把结果摘要写好。
   *
   * `accepted` 只代表受理 —— 这里绝不因 `accepted:true` 就认定「人已经知道了」。
   *
   * @param {Ticket} ticket
   * @param {Partial<TicketRecordRow>} row
   * @param {AbortSignal} [signal] 这张票的取消信号。人取消或超时之后，
   *   一条还在路上等着的通知（推送服务端不响应）不该继续挡着 runOne 收尾 ——
   *   它挡的是整轮 tick，也会把这张票的租约续期拖到超时。
   */
  async function notifyFor (ticket, row, signal) {
    const phase = row.phase
    if (!phase) return
    const notifyOn = Array.isArray(config.notifyOn) ? config.notifyOn : ['done', 'skipped', 'failed', 'needs-info']
    if (!notifyOn.includes(phase)) return

    const level = phase === 'done' ? 'info' : phase === 'skipped' ? 'info' : phase === 'needs-info' ? 'warn' : 'error'
    const projectTag = ticket.projectId ? `【${ticket.projectId}】` : ''
    // 标题里的阶段名走 phaseLabel(row)：done 要能分出「已验证 / 未跑验证」，
    // 邮件列表里那半行标题就是人判断「要不要点进去」的依据。
    const title = `${projectTag}${phaseLabel({ phase, testOutcome: row.testOutcome })}｜${summarize(ticket.description) || ticket.recordId}`
    const body = renderNotifyBody(ticket, row, phase)

    /** @type {{ title: string, body: string, link?: string, level: 'info'|'warn'|'error' }} */
    const message = { title, body, level }
    if (row.mr?.url) message.link = row.mr.url

    // 通知既挂在本票的取消信号上，又自带一个超时。两个都要：
    // - 挂本票信号：人取消/超时之后，这条通知已经没有意义，别让它继续等；
    // - 自带超时：推送服务端挂住时，`send` 可能既不返回也不抛，没有超时的话
    //   整轮 tick 就卡在最后一步 —— 活已经干完了，卡在这里只是白白占着租约。
    // 超时只管自己这一条，不影响本票的状态：票怎么写已经在前面落库了。
    const sendHandle = linkSignal(signal)
    const timeoutId = setTimeout(() => {
      sendHandle.abort(new Error('notify-timeout'))
    }, notifyTimeoutMs)
    try {
      const receipt = await push.send(message, sendHandle.signal)
      logInfo('通知已发出', { projectId: ticket.projectId, recordId: ticket.recordId, accepted: receipt.accepted, traceId: receipt.traceId })
      // 交付维度第三项（#08）：通知是「人知道了没有」的唯一证据。
      // 只认**真的发出去了**（适配器没抛错）；`accepted` 只代表服务端受理，
      // 契约里写得很清楚不能当送达，但对我们来说「没抛错 = 这条交付做成了」。
      await store.setDelivery(row.key ?? ticketKey(ticket.projectId, ticket.recordId), 'notify', {
        ok: true,
        attempts: 1,
        error: undefined,
        errorKind: undefined,
        giveUp: undefined,
      })
    } catch (error) {
      // 通知失败不能反过来把票判失败 —— 活已经干完了，人可以在队列里看到。
      const reason = toPipelineError(error)
      logInfo('通知失败（不影响票据状态）', { projectId: ticket.projectId, recordId: ticket.recordId, reason: reason.message })
      // 但「人不知道」这件事必须留下来：否则状态页显示一切正常，
      // 而人根本没收到过任何消息，只能靠自己想起来回来看票。
      const retryable = retryPolicy(reason.kind) === 'retry'
      await store.setDelivery(row.key ?? ticketKey(ticket.projectId, ticket.recordId), 'notify', {
        ok: false,
        attempts: 1,
        error: reason.message,
        errorKind: reason.kind,
        giveUp: !retryable,
      })
    } finally {
      clearTimeout(timeoutId)
      sendHandle.dispose()
    }
  }

  // ── 清理 ────────────────────────────────────────────────

  /**
   * 清过期工作区：**一轮最多清一个**，避免一次删一堆拖住 tick。
   *
   * `failed` 的永不自动删（那是排查线索），这条在 `listExpiredWorktrees` 里已经保证。
   *
   * @returns {Promise<boolean>} 这轮是否清了东西
   */
  async function cleanupExpiredWorktrees () {
    const retentionHours = Number(config.worktreeRetentionHours ?? 24)
    if (!(retentionHours > 0)) return false
    if (typeof removeWorktree !== 'function') return false

    const expired = store.listExpiredWorktrees(retentionHours * 3_600_000)
    if (expired.length === 0) return false

    const target = expired[0]
    try {
      await removeWorktree({ path: target.worktreePath, branch: target.branch, repoPath: target.repoPath })
      await store.setPhase(target.key, target.phase, { worktreePath: undefined, branch: undefined })
      logInfo('已清理过期工作区', { projectId: target.projectId, recordId: target.recordId, path: target.worktreePath })
      return true
    } catch (error) {
      logInfo('清理工作区失败', { projectId: target.projectId, recordId: target.recordId, reason: toPipelineError(error).message })
      return false
    }
  }

  // ── 一轮 ────────────────────────────────────────────────

  /**
   * 跑一轮。**一轮最多跑一票、最多清一个工作区**。
   *
   * @param {{ skipScan?: boolean, signal?: AbortSignal }} [options]
  *   `signal`：调用方（`pipeline_scan` 工具）的取消信号。取消 = 别再扫、别再动票，
  *   而不是「只让调用方收不到结果」。
   * @returns {Promise<TickResult>}
   */
  async function tick (options = {}) {
    if (config.enabled === false) {
      return { status: 'disabled', scan: emptyScan(), ran: null, cleaned: false }
    }
    if (running) {
      return { status: 'already-running', scan: emptyScan(), ran: null, cleaned: false }
    }

    running = true
    /** @type {TickResult} */
    const result = { status: 'ok', scan: emptyScan(), ran: null, cleaned: false }

    // 以前这里是 linkSignal(undefined)：工具层的 exec.signal 接不上内核，
    // 人按下取消之后这一轮还在照跑（照样扫表、照样改票），只是结果没人收。
    const handle = linkSignal(options.signal)
    /** 是否被调用方取消（扫描中途取消与「进来时就已经取消」都算）。 */
    let aborted = false
    try {
      if (!options.skipScan) {
        try {
          result.scan = await scanAndEnqueue(handle.signal)
        } catch (error) {
          const normalized = toPipelineError(error)
          if (isAbortError(normalized)) {
            // 被取消不是「扫失败」：不报错、不重试，直接收摊。
            aborted = true
            logInfo('扫描被取消', { reason: normalized.message })
          } else {
            result.status = 'scan-failed'
            result.error = `${normalized.kind}: ${normalized.message}`
            logInfo('扫描失败', { kind: normalized.kind, reason: normalized.message })
          }
        }
      }

      // 已经取消了就别再开新票：取消了还去跑一张，等于「取消」形同虚设。
      if (!aborted && handle.signal.aborted) aborted = true
      if (aborted && result.status === 'ok') result.status = 'aborted'

      if (config.enabled !== false && result.status === 'ok') {
        const next = store.pickNext()
        if (next) {
          const leased = await store.acquireLease(next.key, leaseTtlMs)
          if (leased) {
            const fresh = store.getTicket(next.key) ?? next
            await runOne(fresh)
            const after = store.getTicket(next.key)
            result.ran = {
              projectId: next.projectId ?? '',
              recordId: next.recordId,
              phase: after?.phase ?? fresh.phase,
              ok: after ? TERMINAL.includes(after.phase) : false,
            }
          } else {
            logInfo('租约被别的进程占着，本轮跳过', { projectId: next.projectId, recordId: next.recordId })
          }
        }
      }

      // 清理本地产物（删过期 worktree）不受取消影响：它不联网、不改票面状态，
      // 而且中途停手会留下半删的目录，比跑完更麻烦。
      result.cleaned = await cleanupExpiredWorktrees()
      return result
    } finally {
      handle.dispose()
      running = false
    }
  }

  /**
   * 人工取消当前这票。
   * @returns {boolean} 是否真的取消了什么
   */
  function cancelActive () {
    if (!activeHandle) return false
    activeHandle.abort(new Error('cancelled by user'))
    return true
  }

  return {
    tick,
    scanAndEnqueue,
    cleanupExpiredWorktrees,
    cancelActive,
    replayPendingEffects,
    get isRunning () {
      return running
    },
  }
}

/** @returns {{ created: number, updated: number, disappeared: number, revivals: number }} */
function emptyScan () {
  return { created: 0, updated: 0, disappeared: 0, revivals: 0 }
}

/**
 * 把存储行还原成 `Ticket`（跑执行器时要原文）。
 * @param {TicketRecordRow} row
 * @returns {Ticket}
 */
function rowToTicket (row) {
  return {
    recordId: row.recordId,
    projectId: row.projectId,
    fingerprint: row.fingerprint,
    revisionCount: row.revisionCount,
    description: row.description ?? row.problemSummary ?? '',
    screenshots: row.screenshots ?? [],
    seq: row.seq,
    department: row.department,
    foundAt: row.foundAt,
    module: row.module,
    targetProject: row.targetProject,
    flow: row.flow,
    priority: row.priority,
    status: row.status,
    raw: undefined,
  }
}

/**
 * 带行上下文的阶段标签：**done 要分「验过」和「没验过」**。
 *
 * 实现放在 `contracts/types.js` 的 `phaseLabel()` 里 —— 状态工具渲染票行用的是
 * 同一个函数，两处各写一份就会各说各话。这里 re-export 只是让本文件内的
 * 调用点（通知标题）读起来短一点。
 */
export { phaseLabel } from '../contracts/types.js'

/**
 * 通知正文第一行的「判定行」：**这封通知需要你做什么**。
 *
 * 为什么必须有：通知是这个插件最频繁的界面（一张票一封），但原来它只是一份
 * 「事实清单」——有项目、序号、sha、改动文件数，唯独没有一句「关我什么事」。
 * 手机上邮件列表的预览只取前 1–2 行，所以这句话必须在**第一行**，而且要用
 * 固定的句式，让人扫一眼就知道要不要停下来读。
 *
 * 句式只有两种：【不用你做，…】和【要你做：…】。这样「需要我动手吗」是
 * 一个前两字就能答的问题。
 *
 * @param {Phase} phase
 * @param {Partial<TicketRecordRow>} row
 * @returns {string}
 */
function renderNotifyVerdict (phase, row) {
  if (phase === 'done') {
    // done 只有一个分支需要人动手：回填写失败了。表格里那行还停在「处理中」，
    // 除了人没人能改。
    if (row.writeBack && row.writeBack.written === false) {
      return '【要你做：去表格里手工回填这一行的「处理结果」】'
    }
    // 「没跑过验证」和「验证通过」都是 done —— 前者人必须自己看一眼，
    // 后者知道一下就行。两者在通知里必须能分开，否则「没有验证命令」的
    // 场景会被误当成「验过了」。
    if (normalizeTestOutcome(row.testOutcome) === 'not-run') {
      return '【要你做：这票没跑过验证，请人工验一遍】'
    }
    return '【不用你做，知道一下就行】'
  }
  if (phase === 'skipped') return '【要你做：改动已交付但验证没过，请人工确认】'
  if (phase === 'failed') return '【要你做：这票失败了】'
  if (phase === 'needs-info') return '【要你做：补一张截图】'
  return '【不用你做，知道一下就行】'
}

/**
 * 通知正文。用 Markdown —— PushPlus 的 `txt` 模板在微信里也按纯文本显示，
 * 但保留结构对人仍然更可读。
 *
 * 结构固定为：判定行 → 工单信息 → 交付事实 → 需要人做的事。
 * 判定行永远在第一行，因为邮件列表预览只显示开头那一两行。
 *
 * @param {Ticket} ticket
 * @param {Partial<TicketRecordRow>} row
 * @param {Phase} phase
 * @returns {string}
 */
function renderNotifyBody (ticket, row, phase) {
  const lines = []
  lines.push(renderNotifyVerdict(phase, row))
  lines.push('')
  if (ticket.projectId) lines.push(`项目：${ticket.projectId}`)
  if (ticket.seq) lines.push(`工单序号：${ticket.seq}`)
  if (ticket.module) lines.push(`模块：${ticket.module}`)
  if (ticket.priority) lines.push(`优先级：${ticket.priority}`)
  lines.push('')
  lines.push(ticket.description.split(/\r?\n/).slice(0, 3).join('\n'))
  lines.push('')

  if (phase === 'done' || phase === 'skipped') {
    // 交付形态是「工作区检出里的本地提交」：给出 sha 与分支，人就能在检出里
    // `git show <sha>` 直接 review，跟看一个 PR 一样。配了远程出口的部署才多一行 MR。
    if (row.commit?.sha) {
      const where = row.worktreePath ? `（${row.worktreePath}）` : ''
      lines.push(`本地提交：${String(row.commit.sha).slice(0, 12)}${row.commit.branch ? ` @ ${row.commit.branch}` : ''}${where}`)
    }
    if (row.mr) lines.push(`draft MR：${row.mr.url}`)
    if (Array.isArray(row.changedFiles) && row.changedFiles.length > 0) {
      lines.push(`改动文件：${row.changedFiles.length} 个`)
      for (const f of row.changedFiles.slice(0, 5)) lines.push(`- ${f}`)
      if (row.changedFiles.length > 5) lines.push(`- …还有 ${row.changedFiles.length - 5} 个`)
    }
    // 验证结论三档：用 normalizeTestOutcome 归一，老数据里的 'skipped'
    // 与现在的 'not-run' 是同一件事（都是「验证没跑成」）——
    // 不归一会让升级前收尾的票掉进「三档都不匹配」的黑洞，正文里一句验证结论都没有。
    const outcome = normalizeTestOutcome(row.testOutcome)
    if (outcome === 'passed') lines.push('验证：通过')
    else if (outcome === 'not-run') lines.push(`验证：未跑成 —— ${row.testDetail ?? '原因未记录'}`)
    else if (outcome === 'failed') lines.push('验证：未通过')
    // testDetail 是验证命令 stdout/stderr 的完整尾部（末 8 行），**不按本票改动过滤**。
    // 真机上出现过「别的票的用例挂了、被写进这封通知」的情况，人第一反应是
    // 「我的票把别人的用例弄挂了」。加一句免责，消掉大半误判。
    if (row.testDetail && outcome !== 'not-run') {
      lines.push('', '以下是验证命令的完整尾部输出，可能包含与本工单无关的用例失败：')
      lines.push(row.testDetail)
    }
    // 处理会话：收到邮件想追问「它当时怎么想的」，得能直接找到那个会话。
    // 说法与 renderWriteBackResult 一致（都是「处理会话：」），不造第二种叫法。
    if (row.sessionId) lines.push(`处理会话：${row.sessionId}`)
    // 回填失败必须在通知里说：代码改完了，但表格里那一行还是「处理中」——
    // 不说的话人以为流程全绿，回去看表格又发现没回填，只能翻日志猜。
    // 只报失败：成功回填是预期行为，多写一行只是噪音。
    if (row.writeBack && row.writeBack.written === false) {
      const state = row.delivery?.writeBack
      // 已放弃的要多说一句：人看到「没写成」会等它自己好，而这一类永远不会好（#08）。
      const giveUp = state?.giveUp === true
      const tail = giveUp
        ? '（表格里那一行可能还停在「处理中」，请手工改一下。这不是再试一次能好的 —— 得你改表格设置。）'
        : '（表格里那一行可能还停在「处理中」，可以先手工改一下；插件之后也会再自动试一次。）'
      lines.push(`回填表格：没写成 —— ${row.writeBack.note ?? '原因未记录'}${tail}`)
    }
  } else if (phase === 'failed') {
    lines.push(`失败原因：${row.lastError ?? '未记录'}`)
    if (row.worktreePath) lines.push(`工作区保留在：${row.worktreePath}`)
    // 失败的票最需要「能点回去看它当时在干什么」，所以这里的处理会话行不是可选项。
    // 执行器在跑之前就用 ctx.onSessionId 把 id 交出来了（见 runOne 里的 runSessionId），
    // 所以哪怕它抛异常、连结果都没返回，这一行照样有。
    if (row.sessionId) lines.push(`处理会话：${row.sessionId}`)
    lines.push('', '要重跑就用 pipeline_reset 带上这张票的 recordId；失败不会自动重试，超时也一样。')
  } else if (phase === 'needs-info') {
    lines.push(`需要补充：${row.lastError ?? '截图取不到'}`)
    lines.push('', '把截图重新贴一次（或填可访问的路径/链接），下一轮会自动继续。')
  }

  return lines.join('\n')
}

/**
 * 回填进「处理结果」列的那段话。
 *
 * 写给人看的，不是写日志的：人打开表格只想知道「这票到底动了什么、能不能合」。
 * 所以顺序按人的关心程度排：改了什么 → 验证过没有 → 提交在哪 → 怎么继续追问。
 *
 * 长度控制在一屏内（飞书单元格塞几千字会很难读），最多列 8 个文件。
 *
 * @param {Ticket} ticket
 * @param {{
 *   phase: Phase,
 *   status?: string,
 *   result: import('../contracts/work-executor.js').ExecResult,
 *   commit?: { sha: string, branch: string, files: string[] },
 *   mr?: { iid: number, url: string, draft: boolean },
 *   changedFiles?: string[],
 *   worktreePath?: string,
 *   sessionId?: string,
 *   verification?: { outcome?: string, detail?: string },
 * }} input
 * @returns {string}
 */
function renderWriteBackResult (ticket, input) {
  const lines = []
  const files = Array.isArray(input.changedFiles) ? input.changedFiles : []
  const where = input.worktreePath ? `（${input.worktreePath}）` : ''

  if (input.phase === 'skipped') {
    lines.push('已按工单改完并提交到工作区检出，待人工验证（验证命令没通过）。')
  } else {
    lines.push('已按工单改完并提交。')
  }

  if (files.length > 0) {
    lines.push(`改动 ${files.length} 个文件：`)
    for (const file of files.slice(0, 8)) lines.push(`- ${file}`)
    if (files.length > 8) lines.push(`- …还有 ${files.length - 8} 个`)
  } else {
    lines.push('改动文件：无（见下方提交说明）')
  }

  const outcome = normalizeTestOutcome(input.verification?.outcome)
  if (outcome === 'passed') lines.push('验证：通过（build/test 退出码 0）')
  else if (outcome === 'failed') lines.push('验证：未通过')
  else if (outcome === 'not-run') lines.push(`验证：未跑成 —— ${input.verification?.detail ?? '原因未记录'}`)

  if (input.commit?.sha) {
    lines.push(`本地提交：${String(input.commit.sha).slice(0, 12)}${input.commit.branch ? ` @ ${input.commit.branch}` : ''}${where}`)
  }
  if (input.mr?.url) lines.push(`draft MR：${input.mr.url}`)
  if (input.sessionId) {
    lines.push(`处理会话：${input.sessionId}（保留在项目工作区名下，可在 GUI 里点进去继续追问）`)
  }
  lines.push('', '要进一步修改，先把这个单元格清空，再用 pipeline_reset 带上这张票的 recordId 重跑。'
    + '（也可以把「是否处理」拨回「处理中」，但那会整票重做一遍并覆盖这次的回填。）')

  return lines.join('\n')
}

/**
 * 失败票回填进「处理结果」列的那段话（工单 #14，需 writeBackOnFailure=true）。
 *
 * 和成功回填的区别不是措辞，是**信息缺口**：成功的票人看重「改了什么」，
 * 失败的票人看重「为什么没成、还能不能救、下一步做什么」。所以这里只写这几件事，
 * 多一句都是噪音。
 *
 * 不写「是否处理」与「处理日期」：那两列在飞书表里是「处理完了」的信号，
 * 一张没成的票填上它们，看板会说谎。
 *
 * @param {Ticket} ticket
 * @param {{
 *   phase: Phase,
 *   lastError?: string,
 *   worktreePath?: string,
 *   sessionId?: string,
 *   attempt?: number,
 * }} input
 * @returns {string}
 */
function renderFailureWriteBack (ticket, input) {
  const lines = []
  const label = phaseLabel({ phase: input.phase })
  lines.push(`[流水线] ${label}：${input.lastError ?? '原因未记录'}`)
  if (input.attempt && input.attempt > 1) lines.push(`已尝试 ${input.attempt} 次。`)
  if (input.worktreePath) lines.push(`改代码目录：${input.worktreePath}（工作区还留着，可以去看看改到哪了）`)
  if (input.sessionId) lines.push(`处理会话：${input.sessionId}（点进去能看它那一轮到底做了什么）`)
  lines.push('', `要重来：用 pipeline_reset 带上这张票的 recordId（${ticket.recordId}）。`)

  return lines.join('\n')
}

/**
 * 校验转移表与实现一致（给自测用）。
 * @param {Phase} from
 * @param {Phase} to
 */
export function assertTransitionAllowed (from, to) {
  if (!canTransition(from, to)) {
    throw new PipelineError('invalid-input', `非法转移 ${from} → ${to}`)
  }
}
