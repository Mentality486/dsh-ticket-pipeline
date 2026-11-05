/**
 * `TicketStore` —— 持久状态、phase 转移、并发租约。
 *
 * 只依赖一个极小的 KV 端口（`Repo`），不直接碰 DSH 的 `storageDomain`。
 * 这样内核可以用内存 KV 跑离线自测，而插件里换成真正的 `storageDomain`。
 *
 * 为什么状态必须持久：进程重启后要能从 `phase` 接着走。这是恢复策略的全部依据。
 *
 * 多项目下的主键：一个平台里的 `record_id` 只在「那张表」内唯一，跨项目会撞。
 * 所以存储主键是 `ticketKey(projectId, recordId)`（`\u0000` 拼接），
 * `recordId` 字段保留平台原值、`projectId` 单独存，二者同时进 row。
 */

import { canTransition, priorityWeight, TERMINAL } from '../contracts/types.js'
import { PipelineError } from '../contracts/errors.js'

/** 表名：票据 / 水位 / 租约。 */
export const TABLES = Object.freeze({
  tickets: 'tickets',
  watermarks: 'watermarks',
  leases: 'leases',
})

/**
 * KV 端口。真实实现包 `ctx.storageDomain`；自测用内存实现。
 *
 * 所有写操作返回 Promise —— 真实后端的写入是「落盘后才 resolve」。
 *
 * @typedef {Object} Repo
 * @property {(table: string, key: string) => unknown} get
 * @property {(table: string) => Iterable<[string, unknown]>} entries
 * @property {(table: string, key: string, value: unknown) => Promise<void>} put
 * @property {(table: string, key: string) => Promise<boolean>} delete
 */

/**
 * @typedef {Object} TicketRecordRow
 * @property {string} key 存储主键 = `ticketKey(projectId, recordId)`
 * @property {string} projectId 所属项目（对应配置 `projects[].name`）
 * @property {string} recordId 平台侧原值
 * @property {string} fingerprint
 * @property {number} revisionCount
 * @property {import('../contracts/types.js').Phase} phase
 * @property {string} [worktreePath]
 * @property {string} [branch]
 * @property {string} [baseCommit]
 * @property {import('../contracts/types.js').Plan} [plan]
 * @property {string[]} [changedFiles]
 * @property {'passed'|'failed'|'skipped'} [testOutcome]
 * @property {string} [testDetail]
 * @property {{ iid: number, url: string, draft: boolean }} [mr]
 * @property {number} attempt
 * @property {number} [startedAt]
 * @property {number} [finishedAt]
 * @property {string} [lastError]
 * @property {string} [lastScanAt]
 * @property {string} [problemSummary]
 * @property {string} [description] 工单原文（执行器要用全文，摘不出来）
 * @property {import('../contracts/types.js').ScreenshotRef[]} [screenshots]
 * @property {string} [flow]
 * @property {string} [status] 「是否处理」原值，仅用于日志与人工重置判断
 * @property {'high'|'medium'|'low'} [priority]
 * @property {string} [foundAt]
 * @property {string} [module]
 * @property {string} [targetProject] 工单原文里的「待修改项目」列（只给模型参考，不参与主键）
 * @property {string} [department]
 * @property {string} [seq]
 * @property {number} [enqueuedAt]
 */

/**
 * @typedef {Object} LeaseRow
 * @property {string} key 票据复合主键
 * @property {string} ownerToken
 * @property {number} leaseExpiresAt
 */

/** 生成一个进程内唯一的 owner token。 */
export function makeOwnerToken () {
  const rand = Math.random().toString(36).slice(2, 10)
  return `${process.pid ?? 0}-${Date.now().toString(36)}-${rand}`
}

/**
 * 票据的存储主键：projectId 与 recordId 的复合。
 *
 * 用 `\u0000` 分隔（平台标识与 record_id 都不可能包含这个字符），
 * 既不会串票，也不依赖任何转义约定。
 *
 * @param {string} projectId
 * @param {string} recordId
 * @returns {string}
 */
export function ticketKey (projectId, recordId) {
  return `${projectId ?? ''}\u0000${recordId ?? ''}`
}

/**
 * 票据存储。
 */
export class TicketStore {
  /**
   * @param {Object} options
   * @param {Repo} options.repo
   * @param {(msg: string, detail?: unknown) => void} [options.log]
   * @param {() => number} [options.now]
   */
  constructor ({ repo, log, now }) {
    this.repo = repo
    this.log = log ?? (() => {})
    this.now = now ?? (() => Date.now())
    this.ownerToken = makeOwnerToken()
  }

  // ── 票据读写 ────────────────────────────────────────────

  /**
   * @param {string} key 票据复合主键（`ticketKey(projectId, recordId)`）
   * @returns {TicketRecordRow | undefined}
   */
  getTicket (key) {
    return /** @type {TicketRecordRow | undefined} */ (this.repo.get(TABLES.tickets, key))
  }

  /** @returns {TicketRecordRow[]} */
  listTickets () {
    /** @type {TicketRecordRow[]} */
    const rows = []
    for (const [, row] of this.repo.entries(TABLES.tickets)) {
      if (row && typeof row === 'object') rows.push(/** @type {TicketRecordRow} */ (row))
    }
    return rows
  }

  /**
   * @param {import('../contracts/types.js').Ticket} ticket
   * @param {{ phase?: import('../contracts/types.js').Phase, attempt?: number, enqueuedAt?: number }} [init]
   * @returns {Promise<TicketRecordRow>}
   */
  async enqueue (ticket, init = {}) {
    const key = ticketKey(ticket.projectId, ticket.recordId)
    const existing = this.getTicket(key)
    const now = this.now()
    /** @type {TicketRecordRow} */
    const row = {
      key,
      projectId: ticket.projectId ?? '',
      recordId: ticket.recordId,
      fingerprint: ticket.fingerprint,
      revisionCount: ticket.revisionCount,
      phase: init.phase ?? 'pending',
      attempt: init.attempt ?? 0,
      enqueuedAt: init.enqueuedAt ?? now,
      problemSummary: summarize(ticket.description),
      // 全文必须落库：执行器跑的时候要原文，光有摘要还原不出 `Ticket`。
      description: ticket.description,
      screenshots: ticket.screenshots,
    }
    if (ticket.flow) row.flow = ticket.flow
    if (ticket.status) row.status = ticket.status
    if (ticket.priority) row.priority = ticket.priority
    if (ticket.foundAt) row.foundAt = ticket.foundAt
    if (ticket.module) row.module = ticket.module
    if (ticket.targetProject) row.targetProject = ticket.targetProject
    if (ticket.department) row.department = ticket.department
    if (ticket.seq) row.seq = ticket.seq

    // 保留已有的工作区与结果：修订不应该把「工作区已经建好了」这个事实抹掉。
    if (existing) {
      row.worktreePath = existing.worktreePath
      row.branch = existing.branch
      row.baseCommit = existing.baseCommit
      row.plan = existing.plan
      row.changedFiles = existing.changedFiles
      row.testOutcome = existing.testOutcome
      row.testDetail = existing.testDetail
      row.mr = existing.mr
      row.startedAt = existing.startedAt
    }
    // 不继承 lastError：重新入队就是「从头再来一遍」，上一轮为什么没跑成
    // 与这一轮无关。留着它，一次偶发失败会永远挂在票上 —— 人看队列时
    // 以为还没修好，而这一轮的真实原因又被旧值盖着看不见。
    // 新行本来就没有 lastError 字段，覆盖写入时旧值随之消失，不需要显式写 undefined。
    

    await this.repo.put(TABLES.tickets, key, row)
    return row
  }

  /**
   * 落一次修订：`revisionCount++`、指纹更新、排到队尾、**不打断当前运行**。
   *
   * 「不打断」的意思是：只改记录里的排队信息，不动 `phase`。
   * 当前版本的执行继续跑完，新版本在下一轮被取出。
   *
   * @param {import('../contracts/types.js').Ticket} ticket
   * @returns {Promise<{ row: TicketRecordRow, restarted: boolean }>}
   */
  async revise (ticket) {
    const key = ticketKey(ticket.projectId, ticket.recordId)
    const existing = this.getTicket(key)
    if (!existing) {
      const row = await this.enqueue(ticket)
      return { row, restarted: true }
    }
    const nextRevision = Math.max(existing.revisionCount ?? 1, ticket.revisionCount ?? 1) + 1
    /** @type {TicketRecordRow} */
    const row = {
      ...existing,
      fingerprint: ticket.fingerprint,
      revisionCount: nextRevision,
      problemSummary: summarize(ticket.description),
      description: ticket.description,
      screenshots: ticket.screenshots,
      // 排到队尾 = 最新入队时间
      enqueuedAt: this.now(),
      attempt: 0,
    }
    if (ticket.flow !== undefined) row.flow = ticket.flow
    if (ticket.status !== undefined) row.status = ticket.status
    if (ticket.priority) row.priority = ticket.priority
    if (ticket.foundAt) row.foundAt = ticket.foundAt
    if (ticket.module) row.module = ticket.module
    if (ticket.targetProject) row.targetProject = ticket.targetProject
    if (ticket.department) row.department = ticket.department
    if (ticket.seq) row.seq = ticket.seq

    // needs-info 的票收到修订后回到队里；其它状态保持不动。
    const restarted = row.phase === 'needs-info'
    if (restarted) row.phase = 'pending'

    await this.repo.put(TABLES.tickets, key, row)
    return { row, restarted }
  }

  /**
   * 改 phase，带合法性校验。
   *
   * 非法转移不抛（否则一次坏数据会让整轮 tick 崩掉），而是**记日志并放弃这次转移**。
   * 这是「终态不可退回」的执行点。
   *
   * @param {string} key 票据复合主键
   * @param {import('../contracts/types.js').Phase} to
   * @param {Partial<TicketRecordRow>} [patch]
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<TicketRecordRow | undefined>} 返回更新后的行；非法转移返回 undefined
   */
  async setPhase (key, to, patch = {}, options = {}) {
    // 补丁必须是普通对象：字符串会被 `Object.entries` 展开成 {0:..,1:..} 写进票据行。
    // 这种脏数据一旦落库，`{...row, ...defined}` 会把十几个垃圾字段永久带下去，
    // 而且看存储根本猜不到它从哪来。契约里 onPhase 的第二参是字符串说明，
    // 调用方一旦把说明直接透传到这里就会踩中，所以这道闸设在这里比设在调用点更可靠。
    if (patch !== undefined && patch !== null && typeof patch !== 'object') {
      throw new TypeError(`setPhase: patch 必须是对象，实际是 ${typeof patch}（字符串会被展开成数字键写进票据）`)
    }
    const row = this.getTicket(key)
    if (!row) {
      this.log(`setPhase: 记录不存在，忽略`, { key, to })
      return undefined
    }
    if (!options.force && !canTransition(row.phase, to)) {
      this.log(`setPhase: 非法转移 ${row.phase} → ${to}，已拒绝`, { key })
      return undefined
    }

    const now = this.now()
    // 过滤掉值为 undefined 的键：{...row, ...patch} 遇到 undefined 会**覆盖**旧值，
    // 而「patch 里没提」与「patch 里显式写了 undefined」在对象展开下区分不出来。
    // 偏偏调用方大量用 undefined 表达「清掉它」（recover 清 mr、清理工作区清 branch），
    // 那些地方靠显式写；这里再兜一道，是为了让「顺手多传一个 undefined」不至于
    // 悄悄抹掉存储里的真实字段（例如把 mr 抹掉却以为只是更新了 lastError）。
    const defined = {}
    for (const [field, value] of Object.entries(patch ?? {})) {
      if (value !== undefined) defined[field] = value
    }
    /** @type {TicketRecordRow} */
    const next = { ...row, ...defined, phase: to }
    if (row.phase !== to && !TERMINAL.includes(to)) {
      // 「已经开始跑了」的标记：第一次离开 pending 时打点
      if (next.startedAt === undefined && to !== 'pending') next.startedAt = now
    }
    if (TERMINAL.includes(to)) {
      next.finishedAt = now
    }
    await this.repo.put(TABLES.tickets, key, next)
    return next
  }

  /**
   * 人工重置：表格里「是否处理」从别的值拨回 `处理中`。
   *
   * 这是 `failed` 票**唯一**的重开路径（用户拍板：超时不自动重试）。
   *
   * @param {string} key 票据复合主键
   * @returns {Promise<boolean>}
   */
  async resetByHuman (key) {
    const row = this.getTicket(key)
    if (!row) return false
    if (row.phase !== 'failed' && row.phase !== 'needs-info' && row.phase !== 'gone') return false
    await this.repo.put(TABLES.tickets, key, {
      ...row,
      phase: 'pending',
      attempt: 0,
      lastError: undefined,
      finishedAt: undefined,
      enqueuedAt: this.now(),
    })
    this.log('人工重置成功，重新入队', { key, projectId: row.projectId, recordId: row.recordId })
    return true
  }

  // ── 水位 ────────────────────────────────────────────────

  /**
   * @param {string} sourceId
   * @returns {{ seen: Record<string, { mtime: number, fingerprint: string, missingScans: number }>, lastScanAt: number } | undefined}
   */
  getWatermark (sourceId) {
    return /** @type {any} */ (this.repo.get(TABLES.watermarks, sourceId))
  }

  /**
   * @param {string} sourceId
   * @param {{ seen: Record<string, { mtime: number, fingerprint: string, missingScans: number }>, lastScanAt: number }} value
   * @returns {Promise<void>}
   */
  async saveWatermark (sourceId, value) {
    await this.repo.put(TABLES.watermarks, sourceId, value)
  }

  // ── 租约 ────────────────────────────────────────────────

  /**
   * 抢租约：写 → 回读校验 → 成功或退让。
   *
   * 为什么不用文件锁：跨平台不可靠，且在沙箱里可能直接被拒。
   * 存储 CAS 用的还是同一个后端，天然跟着「写后落盘」的语义走。
   *
   * @param {string} key 票据复合主键
   * @param {number} ttlMs
   * @returns {Promise<boolean>}
   */
  async acquireLease (key, ttlMs) {
    const now = this.now()
    const current = /** @type {LeaseRow | undefined} */ (this.repo.get(TABLES.leases, key))
    if (current && current.ownerToken !== this.ownerToken && current.leaseExpiresAt > now) {
      return false
    }
    /** @type {LeaseRow} */
    const lease = { key, ownerToken: this.ownerToken, leaseExpiresAt: now + ttlMs }
    await this.repo.put(TABLES.leases, key, lease)

    // 回读校验：被别人同时覆盖了就让出去，本轮跳过这票。
    const readBack = /** @type {LeaseRow | undefined} */ (this.repo.get(TABLES.leases, key))
    return Boolean(readBack && readBack.ownerToken === this.ownerToken)
  }

  /**
   * 续租。续租失败说明租约被别人抢走了 → 调用方必须让出这张票。
   * @param {string} key 票据复合主键
   * @param {number} ttlMs
   * @returns {Promise<boolean>}
   */
  async renewLease (key, ttlMs) {
    const current = /** @type {LeaseRow | undefined} */ (this.repo.get(TABLES.leases, key))
    if (!current || current.ownerToken !== this.ownerToken) return false
    await this.repo.put(TABLES.leases, key, {
      key,
      ownerToken: this.ownerToken,
      leaseExpiresAt: this.now() + ttlMs,
    })
    const readBack = /** @type {LeaseRow | undefined} */ (this.repo.get(TABLES.leases, key))
    return Boolean(readBack && readBack.ownerToken === this.ownerToken)
  }

  /**
   * 释放租约（终态立刻释放）。
   * @param {string} key 票据复合主键
   * @returns {Promise<void>}
   */
  async releaseLease (key) {
    const current = /** @type {LeaseRow | undefined} */ (this.repo.get(TABLES.leases, key))
    if (current && current.ownerToken === this.ownerToken) {
      await this.repo.delete(TABLES.leases, key)
    }
  }

  /**
   * @param {string} key 票据复合主键
   * @returns {boolean}
   */
  isLeasedByOther (key) {
    const current = /** @type {LeaseRow | undefined} */ (this.repo.get(TABLES.leases, key))
    return Boolean(current && current.ownerToken !== this.ownerToken && current.leaseExpiresAt > this.now())
  }

  // ── 队列 ────────────────────────────────────────────────

  /**
   * 选出下一张该跑的票。
   *
   * 排序：优先级降序 → 发现日期升序 → 入队时间升序。
   * 跳过：终态、`needs-info`（等人补信息）、`failed`（不自动重试）、被别的进程租住的、
   * **还没到点**的（重试退避，见 `enqueuedAt`）。
   *
   * 只挑 `pending`：其它非终态都是「上一轮跑到一半」的中间态（planning/editing/testing…），
   * 该不该继续由启动恢复（`recover.js`）说了算 —— 它知道工作区还在不在、MR 开没开过。
   * 内核在这里擅自接手，等于绕开那套判定，会在别的进程还捧着这票时把它抢过来跑。
   *
   * `enqueuedAt` 早于「现在」才可跑：重试路径把 enqueuedAt 写成「现在 + 退避」，
   * 于是同一张票在退避期内不会被立刻再捞回来空转。
   *
   * 并发恒为 1，所以一次只返回一张。
   *
   * @returns {TicketRecordRow | undefined}
   */
  pickNext () {
    const now = this.now()
    const candidates = this.listTickets().filter((row) => {
      if (TERMINAL.includes(row.phase)) return false
      if (row.phase === 'needs-info') return false
      // 只跑排队中的票；中间态留给启动恢复。
      if (row.phase !== 'pending') return false
      if (this.isLeasedByOther(row.key)) return false
      // 退避未到期：当作还排在队尾后面。
      if ((row.enqueuedAt ?? 0) > now) return false
      return true
    })

    if (candidates.length === 0) return undefined

    candidates.sort((a, b) => {
      const pa = priorityWeight(a.priority)
      const pb = priorityWeight(b.priority)
      if (pa !== pb) return pb - pa
      const fa = foundAtSortKey(a)
      const fb = foundAtSortKey(b)
      if (fa !== fb) return fa < fb ? -1 : 1
      return (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0)
    })

    return candidates[0]
  }

  /**
   * 重启恢复：所有非终态的票。
   * @returns {TicketRecordRow[]}
   */
  listActive () {
    return this.listTickets().filter((row) => !TERMINAL.includes(row.phase))
  }

  /**
   * 需要清理 worktree 的行：终态、非 failed、超保留期。
   * @param {number} retentionMs
   * @returns {TicketRecordRow[]}
   */
  listExpiredWorktrees (retentionMs) {
    if (retentionMs <= 0) return []
    const now = this.now()
    return this.listTickets().filter((row) => {
      if (!row.worktreePath) return false
      // failed 的 worktree 永不自动删 —— 那是排查线索。
      if (row.phase === 'failed') return false
      if (!TERMINAL.includes(row.phase)) return false
      const finished = row.finishedAt ?? row.lastScanAt ?? 0
      return now - finished >= retentionMs
    })
  }
}

/**
 * 通知里用的短摘要：第一行、裁到 60 字。
 * @param {string} description
 * @returns {string}
 */
/**
 * 「发现日期」的排序键。缺省值必须是**最大值**：没有发现日期的票排在最后。
 *
 * 为什么单独抽一个函数：内核选票（pickNext）与工具层排序（pipeline_status 的列表）
 * 都按这一条规则排，两处各写一份「缺省到底当什么」就是对不上——曾经内核用
 * `'9999-99-99'`、工具层用 `''`，同一个队列在两处显示的先后顺序不一样，
 * 人照着 pipeline_status 的列表判断「下一个该轮到谁」会判断错。
 * 日期的格式是 ISO 串（`YYYY-MM-DD`），字典序即时间序，所以可以直接比字符串。
 *
 * @param {{ foundAt?: string }} row
 * @returns {string}
 */
export function foundAtSortKey (row) {
  const value = row?.foundAt
  return typeof value === 'string' && value !== '' ? value : '9999-99-99'
}

export function summarize (description) {
  const firstLine = String(description ?? '').split(/\r?\n/).find((line) => line.trim().length > 0) ?? ''
  const trimmed = firstLine.trim()
  return trimmed.length > 60 ? `${trimmed.slice(0, 59)}…` : trimmed
}

/**
 * 用 `ctx.storageDomain` 打开的表构造 `Repo`。
 *
 * @param {{ table: (name: string) => { get: (k: string) => unknown, entries: () => Iterable<[string, unknown]>, put: (k: string, v: unknown) => Promise<void>, delete: (k: string) => Promise<boolean> } }} domain
 * @returns {Repo}
 */
export function makeDomainRepo (domain) {
  return {
    get: (table, key) => domain.table(table).get(key),
    entries: (table) => domain.table(table).entries(),
    put: (table, key, value) => domain.table(table).put(key, value),
    delete: (table, key) => domain.table(table).delete(key),
  }
}

/**
 * 内存 `Repo`：离线自测用，也用于 `dev` 脚本。
 * @returns {Repo & { snapshot: () => Record<string, Record<string, unknown>> }}
 */
export function makeMemoryRepo () {
  /** @type {Map<string, Map<string, unknown>>} */
  const tables = new Map()

  /** @param {string} name */
  const tableOf = (name) => {
    let t = tables.get(name)
    if (!t) {
      t = new Map()
      tables.set(name, t)
    }
    return t
  }

  return {
    get: (table, key) => tableOf(table).get(key),
    entries: (table) => [...tableOf(table).entries()][Symbol.iterator](),
    put: async (table, key, value) => {
      tableOf(table).set(key, value)
    },
    delete: async (table, key) => tableOf(table).delete(key),
    snapshot: () => {
      /** @type {Record<string, Record<string, unknown>>} */
      const out = {}
      for (const [name, table] of tables) out[name] = Object.fromEntries(table)
      return out
    },
  }
}

/**
 * 校验一张票据是否可开工。返回原因字符串，null 表示可以。
 * @param {TicketRecordRow} row
 * @returns {string | null}
 */
export function describeBlocked (row) {
  if (TERMINAL.includes(row.phase)) return `终态 ${row.phase}`
  if (row.phase === 'needs-info') return '等人补信息'
  return null
}

/**
 * 包一层，把适配器抛的裸错误归一。
 * 内核里所有跨适配器边界都走它。
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function guardAdapter (fn) {
  try {
    return await fn()
  } catch (error) {
    throw error instanceof PipelineError ? error : new PipelineError('internal', error instanceof Error ? error.message : String(error), error)
  }
}

/**
 * 计算某张票的「内容指纹是否变了」。
 * @param {TicketRecordRow} row
 * @param {string} fingerprint
 * @returns {boolean}
 */
export function fingerprintChanged (row, fingerprint) {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) return false
  return row.fingerprint !== fingerprint
}
