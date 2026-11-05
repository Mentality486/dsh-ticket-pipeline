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

import { PipelineError, isAbortError, linkSignal, toPipelineError } from '../contracts/errors.js'
import { TERMINAL, canTransition } from '../contracts/types.js'
import { fingerprintChanged, summarize, ticketKey } from './store.js'
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
 */
export function createScheduler ({ store, sources, locator, executor, push, config, log, now, random, prepareWorkspace, saveImage, removeWorktree }) {
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
   * 单位是**秒**（配置项 `leaseHeartbeatSeconds`），这里换算成毫秒。
   */
  const leaseHeartbeatMs = Math.max(0.001, Number(config.leaseHeartbeatSeconds ?? 60)) * 1000

  /** projectId → source，供按票定位截图源与扫描源。 */
  const sourceByProject = new Map()
  for (const source of sources) {
    sourceByProject.set(source.projectId, source)
  }

  // ── 扫描与入队 ──────────────────────────────────────────

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
      }

      for (const ticket of result.updated ?? []) {
        const key = ticketKey(ticket.projectId ?? projectId, ticket.recordId)
        const existing = store.getTicket(key)
        if (!existing) {
          await store.enqueue(ticket, { phase: 'pending', attempt: 0, enqueuedAt: nowFn() })
          counters.created += 1
          continue
        }
        if (!fingerprintChanged(existing, ticket.fingerprint)) continue
        if (TERMINAL.includes(existing.phase) && existing.phase !== 'failed') {
          // done / skipped / gone 收到修订：表格里人改了什么，说明还想再处理一次。
          await store.enqueue(ticket, { phase: 'pending', attempt: 0, enqueuedAt: nowFn() })
          counters.revivals += 1
          logInfo('终态票收到修订，重新入队', { projectId: ticket.projectId ?? projectId, recordId: ticket.recordId, was: existing.phase })
          continue
        }
        const { row, restarted } = await store.revise(ticket)
        counters.updated += 1
        logInfo('票有修订，排到队尾', { projectId: ticket.projectId ?? projectId, recordId: ticket.recordId, revisionCount: row.revisionCount, restarted })
      }

      for (const recordId of result.disappeared ?? []) {
        const key = ticketKey(projectId, recordId)
        const existing = store.getTicket(key)
        if (!existing) continue
        if (TERMINAL.includes(existing.phase)) continue
        await store.setPhase(key, 'gone', { lastError: undefined })
        counters.disappeared += 1
        logInfo('表格里这行消失了，退役', { projectId, recordId })
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
    /** @type {(phase: Phase, detailOrPatch?: string | Partial<TicketRecordRow>) => Promise<void>} */
    const onPhase = async (phase, detailOrPatch = {}) => {
      const isDetail = typeof detailOrPatch === 'string'
      const patch = isDetail ? {} : detailOrPatch
      await store.setPhase(key, phase, patch)
      logInfo(`阶段 → ${phase}`, isDetail
        ? { projectId, recordId, detail: detailOrPatch }
        : { projectId, recordId })
    }

    try {
      // 传 signal：定位器可能碰磁盘（isGitRepo 校验）或网络，这票被取消/超时之后
      // 还接着查下去毫无意义；不传的话它只是白干，而我们多等一份没有意义的耗时。
      const located = await locator.locate(ticket, handle.signal)

      // 截图是**输入**，不是阶段。必须在任何「开工」阶段之前处理掉：
      // 取不到就直接 needs-info，此时票还停在 pending，转移合法，
      // 也不会白建一个工作区。
      const shots = await showScreenshots(source, ticket, handle.signal)
      if (shots === false) {
        await store.releaseLease(key)
        return true
      }

      // 工作区是「能开工」的前提，阶段机不允许 pending → planning 直接跳。
      // 没有注入 `prepareWorkspace`（离线 mock 跑）时也照样走这一步，
      // 只是 worktreePath 留空 —— 阶段语义比「有没有目录」更基础。
      if (!row.worktreePath && typeof prepareWorkspace === 'function') {
        const prepared = await prepareWorkspace({
          ticket,
          located,
          recordId,
          projectId,
          revisionCount: row.revisionCount,
          signal: handle.signal,
          fetch: config.fetchBeforeCreate !== false,
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
          })
        }
      }
      if (store.getTicket(key)?.phase === 'pending') {
        await onPhase('worktree-ready', {})
      }

      await onPhase('planning', {
        module: located.module ?? row.module,
        startedAt: row.startedAt ?? nowFn(),
      })

      const result = await executor.run(ticket, located, {
        signal: handle.signal,
        worktreePath: ws.worktreePath,
        branch: ws.branch,
        baseCommit: ws.baseCommit,
        repoPath: ws.repoPath,
        // prompt 是纯文本，content 是同一份任务书外加截图块。
        // 两个都传：老适配器只认 prompt，新适配器按 content 才能看见图。
        prompt: renderTicketPrompt(ticket, located),
        content: renderTicketContent(ticket, located, shots),
        images: shots,
        config,
        log: (msg, detail) => logInfo(msg, detail),
        onPhase,
      })

      // `WorkExecutor` 已经把 phase 走到 done/skipped/failed 之一，这里只落结果并通知。
      const finalPhase = result.phase
      // 先把 error 对象压成字符串，落库与通知共用同一个值：
      // 通知模板里 lastError 是直接拼进正文的，塞对象进去人只会看到 [object Object]。
      // 另外执行器返回成功时不带 error，此时必须显式写 undefined，
      // 否则上一次失败的原因会一直挂在票上骗人。
      const finalLastError = result.error ? `${result.error.kind}: ${result.error.message}` : undefined
      await store.setPhase(key, finalPhase, {
        changedFiles: result.changedFiles ?? row.changedFiles,
        testOutcome: result.testOutcome,
        testDetail: result.testDetail,
        mr: result.mr,
        plan: result.plan ?? row.plan,
        lastError: finalLastError,
      })

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
        mr: result.mr,
        plan: result.plan ?? row.plan,
        lastError: finalLastError,
      }, handle.signal)
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
        await store.setPhase(key, 'failed', {
          lastError: timedOut ? `超时 ${timeoutMinutes} 分钟` : 'cancelled by user',
        })
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
          })
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
          lastError: `${normalized.kind}: ${normalized.message}`,
          enqueuedAt: dueAt,
        })
        logInfo('可重试错误，退避后再来', { projectId, recordId, attempt, kind: normalized.kind, retryInMs: waitMs })
      } else {
        await store.setPhase(key, 'failed', {
          attempt,
          lastError: `${normalized.kind}: ${normalized.message}`,
        })
        // 工作区坐标要带 ws 的值，不能用 ...row：row 是进 runOne 时的快照，
        // 首次运行时里面根本没有 worktreePath，失败的票明明留着工作区，
        // 通知正文却会缺掉「工作区保留在」那一行 —— 人照着去修时找不到目录。
        await notifyFor(ticket, {
          ...row,
          worktreePath: ws.worktreePath,
          branch: ws.branch,
          baseCommit: ws.baseCommit,
          phase: 'failed',
          lastError: `${normalized.kind}: ${normalized.message}`,
        }, handle.signal)
        logInfo('失败，已通知', { projectId, recordId, kind: normalized.kind, worktreePath: ws.worktreePath })
      }
      await store.releaseLease(key)
      return true
    } finally {
      clearTimeout(timeoutId)
      heartbeatStopped = true
      clearInterval(heartbeatId)
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

    const level = phase === 'done' ? 'info' : phase === 'skipped' ? 'warn' : phase === 'needs-info' ? 'warn' : 'error'
    const projectTag = ticket.projectId ? `【${ticket.projectId}】` : ''
    const title = `${projectTag}${phaseLabelOf(phase)}｜${summarize(ticket.description) || ticket.recordId}`
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
    } catch (error) {
      // 通知失败不能反过来把票判失败 —— 活已经干完了，人可以在队列里看到。
      logInfo('通知失败（不影响票据状态）', { projectId: ticket.projectId, recordId: ticket.recordId, reason: toPipelineError(error).message })
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
    flow: row.flow,
    priority: row.priority,
    status: row.status,
    raw: undefined,
  }
}

/**
 * @param {Phase} phase
 * @returns {string}
 */
function phaseLabelOf (phase) {
  switch (phase) {
    case 'done': return '已完成'
    case 'skipped': return '已开 MR 但未验证'
    case 'failed': return '失败'
    case 'needs-info': return '等你补信息'
    case 'gone': return '已删除'
    default: return phase
  }
}

/**
 * 通知正文。用 Markdown —— PushPlus 的 `txt` 模板在微信里也按纯文本显示，
 * 但保留结构对人仍然更可读。
 *
 * @param {Ticket} ticket
 * @param {Partial<TicketRecordRow>} row
 * @param {Phase} phase
 * @returns {string}
 */
function renderNotifyBody (ticket, row, phase) {
  const lines = []
  if (ticket.projectId) lines.push(`项目：${ticket.projectId}`)
  if (ticket.seq) lines.push(`工单序号：${ticket.seq}`)
  if (ticket.module) lines.push(`模块：${ticket.module}`)
  if (ticket.priority) lines.push(`优先级：${ticket.priority}`)
  lines.push('')
  lines.push(ticket.description.split(/\r?\n/).slice(0, 3).join('\n'))
  lines.push('')

  if (phase === 'done' || phase === 'skipped') {
    if (row.mr) lines.push(`draft MR：${row.mr.url}`)
    if (Array.isArray(row.changedFiles) && row.changedFiles.length > 0) {
      lines.push(`改动文件：${row.changedFiles.length} 个`)
      for (const f of row.changedFiles.slice(0, 5)) lines.push(`- ${f}`)
      if (row.changedFiles.length > 5) lines.push(`- …还有 ${row.changedFiles.length - 5} 个`)
    }
    if (row.testOutcome === 'passed') lines.push('验证：通过')
    else if (row.testOutcome === 'skipped') lines.push(`验证：未跑成 —— ${row.testDetail ?? '原因未记录'}`)
    else if (row.testOutcome === 'failed') lines.push('验证：未通过')
    if (phase === 'skipped') lines.push('', '（MR 已开成 draft，但验证没跑通，请人工确认）')
  } else if (phase === 'failed') {
    lines.push(`失败原因：${row.lastError ?? '未记录'}`)
    if (row.worktreePath) lines.push(`工作区保留在：${row.worktreePath}`)
    lines.push('', '修好之后把表格里「是否处理」拨走再拨回「处理中」即可重跑。')
  } else if (phase === 'needs-info') {
    lines.push(`需要补充：${row.lastError ?? '截图取不到'}`)
    lines.push('', '把截图重新贴一次（或填可访问的路径/链接），下一轮会自动继续。')
  }

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
