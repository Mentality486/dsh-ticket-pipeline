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
import { renderTicketPrompt } from './prompt.js'

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
 * @param {(opts: any) => Promise<{ path?: string, branch?: string, baseCommit?: string, repoPath?: string }>} [options.prepareWorkspace]
 * @param {(opts: { data: Uint8Array, mediaType: string, name?: string }) => Promise<unknown>} [options.saveImage]
 * @param {(opts: { path: string, branch: string, repoPath?: string }) => Promise<void>} [options.removeWorktree]
 */
export function createScheduler ({ store, sources, locator, executor, push, config, log, now, prepareWorkspace, saveImage, removeWorktree }) {
  const logInfo = log ?? (() => {})
  const nowFn = now ?? (() => Date.now())

  /** 单飞：防同进程内定时器重入。跨进程靠存储租约。 */
  let running = false

  /** 当前这票的取消句柄，供「人工取消」与卸载时使用。 */
  /** @type {{ abort: (reason?: unknown) => void } | null} */
  let activeHandle = null

  const leaseTtlMs = Math.max(1, Number(config.leaseTtlMinutes ?? 10)) * 60_000

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
    const source = sourceByProject.get(projectId)

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

    /** 阶段回调：写存储 + 记日志。非法转移由 `setPhase` 拒绝，不抛。 */
    /** @type {(phase: Phase, patch?: Partial<TicketRecordRow>) => Promise<void>} */
    const onPhase = async (phase, patch = {}) => {
      await store.setPhase(key, phase, patch)
      logInfo(`阶段 → ${phase}`, { projectId, recordId })
    }

    try {
      const located = await locator.locate(ticket)

      // 截图是**输入**，不是阶段。必须在任何「开工」阶段之前处理掉：
      // 取不到就直接 needs-info，此时票还停在 pending，转移合法，
      // 也不会白建一个工作区。
      const shotsOk = await showScreenshots(source, ticket, handle.signal)
      if (!shotsOk) {
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
          await onPhase('worktree-ready', {
            worktreePath: prepared.path,
            branch: prepared.branch,
            baseCommit: prepared.baseCommit,
            repoPath: prepared.repoPath ?? located.repoPath,
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
        worktreePath: row.worktreePath,
        branch: row.branch,
        baseCommit: row.baseCommit,
        prompt: renderTicketPrompt(ticket, located),
        config,
        log: (msg, detail) => logInfo(msg, detail),
        onPhase,
      })

      // `WorkExecutor` 已经把 phase 走到 done/skipped/failed 之一，这里只落结果并通知。
      const finalPhase = result.phase
      await store.setPhase(key, finalPhase, {
        changedFiles: result.changedFiles ?? row.changedFiles,
        testOutcome: result.testOutcome,
        testDetail: result.testDetail,
        mr: result.mr,
        plan: result.plan ?? row.plan,
        lastError: result.error ? `${result.error.kind}: ${result.error.message}` : undefined,
      })

      await notifyFor(ticket, { ...row, ...result, phase: finalPhase })
      await store.releaseLease(key)
      return true
    } catch (error) {
      const normalized = toPipelineError(error)

      if (isAbortError(normalized)) {
        // 人工取消不通知；超时要通知（人不在电脑前，得知道卡住了）。
        await store.setPhase(key, 'failed', {
          lastError: timedOut ? `超时 ${timeoutMinutes} 分钟` : 'cancelled by user',
        })
        if (timedOut) {
          await notifyFor(ticket, {
            ...row,
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
        await store.setPhase(key, 'pending', {
          attempt,
          lastError: `${normalized.kind}: ${normalized.message}`,
          enqueuedAt: nowFn(),
        })
        logInfo('可重试错误，下轮再来', { projectId, recordId, attempt, kind: normalized.kind })
      } else {
        await store.setPhase(key, 'failed', {
          attempt,
          lastError: `${normalized.kind}: ${normalized.message}`,
        })
        await notifyFor(ticket, {
          ...row,
          phase: 'failed',
          lastError: `${normalized.kind}: ${normalized.message}`,
        })
        logInfo('失败，已通知', { projectId, recordId, kind: normalized.kind })
      }
      await store.releaseLease(key)
      return true
    } finally {
      clearTimeout(timeoutId)
      activeHandle = null
    }
  }

  /**
   * 截图通路 C（混合）：先把字节存进附件库，再作为 `ImageBlock` 塞进消息。
   *
   * 这一层只做「取字节 → saveImage」，**取不到不 fail 整票**：
   * 标 `needs-info`、通知人补图，票留在队列外等人。少一张图不该让一条能修的工单卡死。
   *
   * @param {TicketSource | undefined} source
   * @param {Ticket} ticket
   * @param {AbortSignal} signal
   * @returns {Promise<boolean>} false = 已转 needs-info，整票本轮到此为止
   */
  async function showScreenshots (source, ticket, signal) {
    if (!Array.isArray(ticket.screenshots) || ticket.screenshots.length === 0) return true
    if (typeof saveImage !== 'function') return true
    if (!source) return true

    const key = ticketKey(ticket.projectId, ticket.recordId)
    let saved = 0
    for (const ref of ticket.screenshots) {
      if (signal.aborted) return true
      try {
        const loaded = await source.loadScreenshot(ref, signal)
        await saveImage({
          data: loaded.data,
          mediaType: loaded.mediaType,
          name: loaded.name ?? `${ticket.recordId}-${saved + 1}`,
        })
        saved += 1
      } catch (error) {
        const reason = toPipelineError(error)
        if (isAbortError(reason)) return true
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
        })
        return false
      }
    }
    if (saved > 0) logInfo(`已存 ${saved} 张截图`, { projectId: ticket.projectId, recordId: ticket.recordId })
    return true
  }

  // ── 通知 ────────────────────────────────────────────────

  /**
   * 按配置决定要不要通知，并把结果摘要写好。
   *
   * `accepted` 只代表受理 —— 这里绝不因 `accepted:true` 就认定「人已经知道了」。
   *
   * @param {Ticket} ticket
   * @param {Partial<TicketRecordRow>} row
   */
  async function notifyFor (ticket, row) {
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

    try {
      const receipt = await push.send(message, new AbortController().signal)
      logInfo('通知已发出', { projectId: ticket.projectId, recordId: ticket.recordId, accepted: receipt.accepted, traceId: receipt.traceId })
    } catch (error) {
      // 通知失败不能反过来把票判失败 —— 活已经干完了，人可以在队列里看到。
      logInfo('通知失败（不影响票据状态）', { projectId: ticket.projectId, recordId: ticket.recordId, reason: toPipelineError(error).message })
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
   * @param {{ skipScan?: boolean }} [options]
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

    const handle = linkSignal(undefined)
    try {
      if (!options.skipScan) {
        try {
          result.scan = await scanAndEnqueue(handle.signal)
        } catch (error) {
          const normalized = toPipelineError(error)
          if (!isAbortError(normalized)) {
            result.status = 'scan-failed'
            result.error = `${normalized.kind}: ${normalized.message}`
            logInfo('扫描失败', { kind: normalized.kind, reason: normalized.message })
          }
        }
      }

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
