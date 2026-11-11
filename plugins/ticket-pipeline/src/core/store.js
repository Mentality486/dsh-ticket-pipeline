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

import { canTransition, priorityWeight, TERMINAL, TIMELINE_NODES } from '../contracts/types.js'
import { PipelineError } from '../contracts/errors.js'
import { isIsolatedWorktreePath } from './worktree-path.js'

/**
 * 一张票的时间线最多留多少条记录。
 *
 * 跑完一张票约产生 10–15 条，人工重置 30 次就 400 条。无限长的时间线
 * 既撑大存储，又让人在 `pipeline_status` 里翻不到当前这一轮的重点 ——
 * 所以只留最近 80 条，最旧的丢掉。丢了什么不重要：卡在哪儿只看最后几条。
 */
const TIMELINE_LIMIT = 80

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
 * 一项交付的状态。三项（commit / writeBack / notify）各自独立，互不牵连。
 *
 * 「交付」是 #08 引入的概念：`phase` 答「走到哪一站」，`delivery` 答「该交出去的
 * 东西交齐了没有」。一票到了 `done` 之后才真正开始往外交东西 —— 本地提交、
 * 回填表格、发通知 —— 每一件都可能单独失败，而且失败之后票面状态照样是 done。
 *
 * @typedef {Object} DeliveryState
 * @property {boolean} ok 这一项交出去了没有
 * @property {number} [at] 最后一次尝试的时刻（epoch ms）
 * @property {string} [error] 没交出去的原因（人话，**不带 `kind:` 前缀** —— kind 放 errorKind）
 * @property {string} [errorKind] 原因的分类，给程序看，不给用户看
 * @property {number} [attempts] 试了几次
 * @property {boolean} [giveUp] 已经放弃（不可重试，或重试用尽）—— 人必须自己动手
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
 * @property {string} [workspacePath] 项目工作区目录（宿主 Workspace 的路径；会话 cwd 挂这里）
 * @property {string} [workspaceId] 宿主的 WorkspaceId（用于把会话归属到工作区；headless 下为空）
 * @property {import('../contracts/types.js').Plan} [plan]
 * @property {string[]} [changedFiles]
 * @property {'passed'|'failed'|'not-run'} [testOutcome] 验证结论。老数据里的 'skipped' 与 'not-run' 同义，读时用 `normalizeTestOutcome()` 归一。
 * @property {string} [testDetail]
 * @property {{ sha: string, branch: string, files: string[] }} [commit] 工作区检出里的本地提交（本阶段的交付形态）
 * @property {{ iid: number, url: string, draft: boolean }} [mr] 远程 GitLab 开出来的 draft MR（可选出口）
 * @property {string} [sessionId] 这次执行用的会话 id（会话默认保留在项目工作区名下，可在 GUI 里点回去继续问）
 * @property {{ written: boolean, fields?: string[], at?: number, note?: string }} [writeBack] 回填工单表的结果。**只看这一项判断不了「交付没交付」**——它是某一次尝试的回执；整体交付状态看 `delivery`。
 * @property {{ commit?: DeliveryState, writeBack?: DeliveryState, notify?: DeliveryState }} [delivery] 交付维度：与 `phase` 正交。phase 答「走到哪一站」，delivery 答「该交出去的东西交齐了没有」（#08）。三项各自独立成败，`attempts` 记试了几次。
 * @property {import('../contracts/types.js').TimelineEntry[]} [timeline] 关键节点流程日志：每个节点一条，带完成时刻与成败。**不是**工单原文里那个「流程」列（那是 `flow`，字符串），别搞混。由 `appendTimeline` 追加，只有人工重置才会清空。
 * @property {{ writeBack?: { phase: string, plan?: unknown, commit?: { sha: string, branch: string, files: string[] }, mr?: { iid: number, url: string, draft: boolean }, changedFiles?: string[], worktreePath?: string, sessionId?: string, verification?: { outcome?: string, detail?: string }, attempts?: number }, notify?: boolean }} [pendingEffects]
 *   终态票还没做完的「事后动作」。done/skipped 落库时先记上，回填/通知各自成功后再把子项清掉；
 *   进程在两者之间崩掉时，下次启动由 `replayPendingEffects()` 补做（回填幂等，通知会补发）。
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
 * 判断一个字段名是不是「字符串被 `Object.entries` 展开」留下的数字键。
 *
 * 票据行里没有任何字段是以数字命名的，所以 `"0".."17"` 这种键只可能是脏数据。
 */
function isNumericKey (name) {
  return /^\d+$/.test(name)
}

/**
 * 把一行票据里「数字键」脏字段剔掉。
 *
 * 这些键来自一个已经修掉的老 bug：`onPhase('editing', '说明文字')` 的字符串说明
 * 被当成字段补丁交给 `setPhase`，`Object.entries('agent 已接到任务书')` 于是把它
 * 拆成 `{0:'a',1:'g',…}` 写进票据行。`setPhase` 现在有闸（patch 必须是对象），
 * 新数据不会再脏；但**已经落库的行不会自己好**，而 `{ ...row }` 会把它们一路带下去
 * （`setPhase`/`appendTimeline`/`clearPendingEffect` 全是展开后整体写回）。
 *
 * 所以在读的出口剔一次：下次任何一次写入都会顺手把存储里的脏键清掉，
 * 而且不改变任何正常字段的语义。之所以按「数字键」而不是按白名单剔：
 * 白名单要跟着 `TicketRecordRow` 一直维护，漏一个字段就会把它悄悄删掉。
 *
 * @param {TicketRecordRow} row
 * @returns {TicketRecordRow}
 */
function sanitizeRow (row) {
  let dirty = null
  for (const name of Object.keys(row)) {
    if (!isNumericKey(name)) continue
    ;(dirty ?? (dirty = [])).push(name)
  }
  if (!dirty) return row
  /** @type {any} */
  const clean = { ...row }
  for (const name of dirty) delete clean[name]
  return clean
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
    const row = /** @type {TicketRecordRow | undefined} */ (this.repo.get(TABLES.tickets, key))
    return row && typeof row === 'object' ? sanitizeRow(row) : row
  }

  /** @returns {TicketRecordRow[]} */
  listTickets () {
    /** @type {TicketRecordRow[]} */
    const rows = []
    for (const [, row] of this.repo.entries(TABLES.tickets)) {
      if (row && typeof row === 'object') rows.push(sanitizeRow(/** @type {TicketRecordRow} */ (row)))
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
      // 项目工作区坐标（宿主 Workspace）：不继承就会每轮重新查/登记一遍，
      // 而且执行器拿不到它，会话就挂不上项目。
      row.workspacePath = existing.workspacePath
      row.workspaceId = existing.workspaceId
      row.plan = existing.plan
      row.changedFiles = existing.changedFiles
      row.testOutcome = existing.testOutcome
      row.testDetail = existing.testDetail
      row.mr = existing.mr
      row.startedAt = existing.startedAt
      // 关键节点流程日志是**历史**，不是「这一轮的结果」：重新入队（修订后重跑、
      // 终态票复活）不能把上一轮走到哪儿抹掉 —— 人要靠它对照「这次和上次是不是
      // 卡在同一个地方」。和 lastError / pendingEffects 不同：那两个是「这一轮」的
      // 状态，带过来只会骗人（一次偶发失败会永远挂在票上、启动补偿会在新 pending 票
      // 上做上一轮的终态动作）。
      if (existing.timeline) row.timeline = existing.timeline
    }
    // 不继承 lastError：重新入队就是「从头再来一遍」，上一轮为什么没跑成
    // 与这一轮无关。留着它，一次偶发失败会永远挂在票上 —— 人看队列时
    // 以为还没修好，而这一轮的真实原因又被旧值盖着看不见。
    // 新行本来就没有 lastError 字段，覆盖写入时旧值随之消失，不需要显式写 undefined。
    //
    // 同理**不继承 `pendingEffects`**：那是「上一轮已经到终态、但事后动作还没补完」的标记。
    // 重新入队意味着这票要重新跑一遍，跑完会重新登记自己该做的回填/通知；
    // 把旧标记带过来会让启动补偿在一张 pending 票上做终态动作，写出「已完成」的通知。


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

    // 和 `enqueue` 一样不继承上一轮的 `pendingEffects`：修订意味着这票要按新内容
    // 再跑一遍，跑完会重新登记自己的待办。留着旧的，启动补偿会在新一轮的中间态上
    // 做上一轮的终态动作 —— 补发一条说「已完成」的通知，而这次其实还没跑。
    delete row.pendingEffects

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
    // 逐个字段应用补丁：**「键不存在」与「键在、值为 undefined」是两件事**。
    //   · 键不存在       → 这轮没提到这个字段，保留存储里的旧值；
    //   · 键在、值 undefined → 调用方明确要求「清掉它」，必须真的删掉。
    // 早先这里把所有 undefined 一概过滤掉，于是调用方写下的每一种「清掉」
    // 都是静默失效的：`lastError: undefined` 清不掉上一轮的失败原因（成功票上
    // 还挂着「agent 这一轮以错误结束」），`worktreePath: undefined` 清不掉
    // 已失效的工作区坐标（启动恢复以为重建了，其实还抱着死路径）。
    // 用 hasOwnProperty 区分这两种意图，比在调用点各自写一遍 `delete` 更可靠。
    /** @type {TicketRecordRow} */
    const next = { ...row }
    for (const [field, value] of Object.entries(patch ?? {})) {
      if (value === undefined) {
        delete next[field]
      } else {
        next[field] = value
      }
    }
    next.phase = to
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
   * 记一项「交付」的结果（改动有没有落盘 / 表格有没有写回 / 人有没有收到通知）。
   *
   * 为什么要和 `phase` 分开：`phase` 答的是「走到哪一站了」，一票到了 `done` 之后
   * 才真正开始往外交东西（本地提交 → 回填表格 → 发通知），这三件事每一件都可能单独失败。
   * 真机撞过一次：票是 done、改动提交了、通知也发了，**表格没写进去** ——
   * 但票面上一切正常，人打开表格发现那行还停在「处理中」，只能去翻日志猜。
   * 用一个正交的维度记，状态页才答得出「这票该交出去的东西交齐了没有」。
   *
   * 为什么不用 `setPhase` 写：`setPhase` 每次把 `finishedAt` 重写成「现在」，
   * 而交付发生在终态**之后**，拿交付时刻当完成时刻会让「这票跑了多久」失真。
   *
   * 合并语义（不是覆盖）：调用方只传这次要变的那几个键，其余保留 —— 否则
   * 「重试回填成功」会把上一次失败时记下的 `error` 与 `attempts` 一起抹掉，
   * 而人恰恰需要知道「它重试过两次才成」。
   *
   * @param {string} key 票据复合主键
   * @param {'commit'|'writeBack'|'notify'} name 哪一项交付
   * @param {{ ok?: boolean, error?: string, errorKind?: string, attempts?: number, giveUp?: boolean, at?: number }} patch
   * @returns {Promise<TicketRecordRow | undefined>} 更新后的行；票不存在时 undefined
   */
  async setDelivery (key, name, patch = {}) {
    const row = this.getTicket(key)
    if (!row) return undefined
    const previous = row.delivery?.[name] ?? {}
    /** @type {any} */
    const next = { ...row, delivery: { ...(row.delivery ?? {}) } }
    const merged = { ...previous, ...patch }
    if (merged.at === undefined) merged.at = this.now()
    // `error` 被显式写成 undefined 才能清掉上一次的失败原因（成功后不留旧债）。
    for (const field of Object.keys(merged)) {
      if (merged[field] === undefined) delete merged[field]
    }
    next.delivery[name] = merged
    await this.repo.put(TABLES.tickets, key, next)
    return next
  }

  /**
   * 记一项「交付」的重试次数并保留待办（回填失败但还值得再试）。
   *
   * @param {string} key
   * @param {'writeBack'} name
   * @param {{ payload?: object, error: string, errorKind?: string }} input
   * @returns {Promise<TicketRecordRow | undefined>}
   */
  async retryPendingEffect (key, name, input) {
    const row = this.getTicket(key)
    if (!row) return undefined
    const previous = row.pendingEffects?.[name]
    const previousAttempts = Number(previous?.attempts ?? 0)
    const attempts = previousAttempts + 1
    /** @type {any} */
    const next = { ...row, pendingEffects: { ...(row.pendingEffects ?? {}) } }
    next.pendingEffects[name] = {
      ...(previous ?? input.payload ?? {}),
      attempts,
    }
    await this.repo.put(TABLES.tickets, key, next)
    return next
  }

  /**
   * 清掉终态票的一个「事后动作」标记（`pendingEffects.writeBack` / `.notify`）。
   *
   * 为什么不用 `setPhase`：`setPhase` 每次都把 `finishedAt` 重写成「现在」，
   * 而补做回填/通知发生在票到终态**之后**，拿补做时刻当完成时刻会让「这票跑了多久」失真。
   * 这里只动 `pendingEffects` 一个字段。
   *
   * 两个子项都清空时把整个 `pendingEffects` 删掉（而不是留一个 `{}`）：
   * 队列里每张终态票都挂个空对象，是给未来的自己埋一个「这到底算不算待办」的疑问。
   *
   * @param {string} key 票据复合主键
   * @param {'writeBack'|'notify'} name 子项名
   * @returns {Promise<TicketRecordRow | undefined>} 更新后的行；票不存在时 undefined
   */
  async clearPendingEffect (key, name) {
    const row = this.getTicket(key)
    if (!row) return undefined
    if (!row.pendingEffects) return row
    /** @type {any} */
    const next = { ...row, pendingEffects: { ...row.pendingEffects } }
    delete next.pendingEffects[name]
    if (Object.keys(next.pendingEffects).length === 0) delete next.pendingEffects
    await this.repo.put(TABLES.tickets, key, next)
    return next
  }

  /**
   * 往票据的**关键节点流程日志**（时间线）上追加一条记录。
   *
   * 为什么单独开一个方法而不走 `setPhase`：`setPhase` 每次都把 `finishedAt` 重写成
   * 「现在」，而时间线是跑的过程中打的点，拿它当完成时刻会让「这票跑了多久」失真；
   * 而且 `setPhase` 会校验阶段转移，「记一笔日志」不该被阶段机拦住
   *（记日志时可能正处于任何阶段，包括终态）。
   *
   * 连续同节点同结果的两条**合并成一条**（保留最新的 `at` 与 `detail`）：
   * `worktree-ready` 在调度器里会被连续触发两次（新建工作区之后 + 兜底补一次），
   * 各记一条会让时间线里出现两个一模一样的站，看不出到底走到哪儿了。
   * 合并保留最新 `at` 是有意的：`pipeline_status` 用「现在 − 最后一条的 at」回答
   * 「卡了多久没动」，旧的 `at` 会把这个数说大。
   *
   * 封顶 `TIMELINE_LIMIT` 条，超出丢最旧的。`ok` 缺省 true。
   *
   * **心跳条目**（`options.heartbeat === true`）是「这一站还在跑」的证据，不是新站点：
   * 长站点（跑验证可能十几分钟）里调度器每 60 秒补一条，`at` 一直往前推，
   * `pipeline_status` 才能把「已跑 13 分钟」和「3 分钟前还有心跳」分开说。
   * 合并规则上心跳只和心跳合并（绝不吃掉进站那一条），所以一站最多两条，
   * 不会把 `TIMELINE_LIMIT` 吃光。
   *
   * @param {string} key 票据复合主键
   * @param {string} node 节点 id（见 TIMELINE_NODES）
   * @param {string} detail 一句给人看的中文补充
   * @param {boolean} [ok] 这一站做成了没有，缺省 true
   * @param {string} [label] 节点中文名；省略时按 node 查表
   * @param {{ heartbeat?: boolean }} [options] `heartbeat: true` = 这是心跳，不是新站点
   * @returns {Promise<TicketRecordRow | undefined>} 更新后的行；票不存在时 undefined
   */
  async appendTimeline (key, node, detail, ok = true, label, options) {
    const row = this.getTicket(key)
    if (!row) return undefined
    const meta = TIMELINE_NODES[node]
    const heartbeat = options?.heartbeat === true
    /** @type {import('../contracts/types.js').TimelineEntry} */
    const entry = {
      node,
      label: label ?? meta?.label ?? node,
      at: this.now(),
      ok: ok !== false,
      ...(heartbeat ? { heartbeat: true } : {}),
      ...(detail ? { detail: String(detail) } : {}),
    }
    const list = Array.isArray(row.timeline) ? [...row.timeline] : []
    const last = list[list.length - 1]
    // 「同类」才合并：心跳不能把进站那条吃掉（否则这一站什么时候开始的就丢了，
    // 「已跑多久」会永远算成 0），普通记录也不能吃掉心跳。
    const sameKind = last && last.node === entry.node && last.ok === entry.ok
      && (last.heartbeat === true) === heartbeat
    if (sameKind) {
      list[list.length - 1] = entry
    } else {
      list.push(entry)
    }
    const trimmed = list.length > TIMELINE_LIMIT ? list.slice(list.length - TIMELINE_LIMIT) : list
    /** @type {TicketRecordRow} */
    const next = { ...row, timeline: trimmed }
    await this.repo.put(TABLES.tickets, key, next)
    return next
  }

  /**
   * 人工重置：表格里「是否处理」从别的值拨回 `处理中`。
   *
   * 这是 `failed` 票**唯一**的重开路径（用户拍板：超时不自动重试）。
   *
   * 重置会 `delete` 掉 `pendingEffects`：那是上一轮终态还没来得及补做的事后动作
   * （回填/通知）。让这张票重新进队意味着它会被重新跑一遍，重新跑完会给出新的
   * `pendingEffects`；旧的那份如果留着，启动补偿会在新结果上再补发一次旧通知，
   * 说出跟当前状态对不上的话。
   *
   * @param {string} key 票据复合主键
   * @returns {Promise<boolean>}
   */
  async resetByHuman (key) {
    const row = this.getTicket(key)
    if (!row) return false
    if (row.phase !== 'failed' && row.phase !== 'needs-info' && row.phase !== 'gone') return false
    const next = {
      ...row,
      phase: 'pending',
      attempt: 0,
      lastError: undefined,
      finishedAt: undefined,
      enqueuedAt: this.now(),
    }
    // undefined 会被 repo 原样写进去，这里显式删字段（和 setPhase 的 undefined=删 语义一致）。
    delete next.pendingEffects
    // 时间线**不清空**：上一轮走到哪儿、卡在哪儿，正是重开之后最想对照着看的东西。
    // 只在末尾补一条「人工重置」，把上一轮的故事和这一轮分开 —— 否则两轮的节点
    // 挤在一起，看起来像是同一轮里又跑了一次「获取工单」。
    const timeline = Array.isArray(row.timeline) ? [...row.timeline] : []
    timeline.push({
      node: 'pending',
      label: '排队中',
      at: next.enqueuedAt,
      ok: true,
      detail: `人工重置，重新入队（第 ${(row.attempt ?? 0) + 1} 次尝试作废，从头再跑一遍）`,
    })
    next.timeline = timeline.length > TIMELINE_LIMIT ? timeline.slice(timeline.length - TIMELINE_LIMIT) : timeline
    await this.repo.put(TABLES.tickets, key, next)
    this.log('人工重置成功，重新入队', { key, projectId: row.projectId, recordId: row.recordId })
    return true
  }

  /**
   * 忘掉一张票：把它从存储里删掉。
   *
   * 为什么需要这个：票据只增不删，跑上几个月以后运行页签里堆满早就验收完的
   * 历史票 —— 人看着一屏「已完成」却没法清理，会以为插件没有收拾的能力。
   *
   * **只删本地记录**，三件事刻意不做：
   * - 不碰工单表（那一行还在，人自己决定要不要留）；
   * - 不动工作区与提交（代码已经在那儿了，删记录不等于回滚）；
   * - 不碰水位 `seen`（下面说）。
   *
   * 水位不动的后果是可控的：`seen` 里还留着它，所以下一轮扫描**不会**把它
   * 当成新票重新收进来（`created` 只在 `!prev` 时才推）。只有人去表格里把它
   * 拨离「处理中」再拨回来 —— 那本来就是「我要重做一遍」的明确动作。
   *
   * @param {string} key 票据复合主键
   * @returns {Promise<boolean>} 删掉了没有（本来就不在时 false）
   */
  async forgetTicket (key) {
    const row = this.getTicket(key)
    if (!row) return false
    const removed = await this.repo.delete(TABLES.tickets, key)
    if (removed) this.log('票据记录已删除', { key, projectId: row.projectId, recordId: row.recordId, phase: row.phase })
    return removed
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
   * 抢租约：read → 判断 → put → 回读校验 → 成功或退让。
   *
   * **这不是原子 CAS**，别当它是：`read` 和 `put` 之间没有任何互斥，两个进程可以同时读到
   * 「没人租」然后都 `put` 自己的 token，最后谁赢完全看回读那一刻谁的数据先落盘。
   * 之所以可以接受：
   * - 同进程内不会并发 —— `scheduler.js` 用 `running` 单飞，一个进程同时只跑一张票；
   * - 跨进程时赢家之外的进程「回读」会看到别人的 token，当场退让，损失只是白跑一轮 `pickNext`；
   * - 真出事（两个进程都在写同一张票）由票级的 `setPhase` 非法转移拒绝 + 工作区隔离兜底，
   *   不会静默把两张票的改动搅在一起。
   *
   * 为什么不用文件锁：跨平台不可靠，且在沙箱里可能直接被拒。
   * 要真正的原子性只能换后端（存储层提供 compare-and-swap），那是另一个量级的改动，
   * 当前单进程 + TTL + 回读的组合已经把风险压到可接受范围。
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

    // 二次读确认：read 和 put 之间可能有别的进程插队写了自己的 token，
    // 只有回读到的仍是自己的 token 才算抢到；否则让出去，本轮跳过这票。
    const readBack = /** @type {LeaseRow | undefined} */ (this.repo.get(TABLES.leases, key))
    const won = Boolean(readBack && readBack.ownerToken === this.ownerToken)
    if (!won) {
      this.log('抢租约时被别人抢先写入（read→put 之间无互斥），本轮让出', {
        key,
        ownerToken: this.ownerToken,
        holder: readBack?.ownerToken,
      })
    }
    return won
  }

  /**
   * 续租。续租失败说明租约被别人抢走了 → 调用方必须让出这张票。
   *
   * 和 `acquireLease` 一样**不是原子操作**（read→判断→put→回读）。这里的 token 校验能挡住
   * 「租约已经被别人接管」的绝大多数情况：别人的 token 一旦落到存储里，自己这轮的
   * `current.ownerToken !== this.ownerToken` 立刻为 false，当场让出。
   *
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
   *
   * **只认真隔离 worktree**（`<repo>/.agents/worktrees/<name>`）。缺省模式下
   * 票据的 `worktreePath` 就是项目工作区本身，那是人的主检出 —— 把它交给
   * `git worktree remove --force` 等于删掉人的整个工作目录。
   *
   * @param {number} retentionMs
   * @returns {TicketRecordRow[]}
   */
  listExpiredWorktrees (retentionMs) {
    if (retentionMs <= 0) return []
    const now = this.now()
    return this.listTickets().filter((row) => {
      if (!row.worktreePath) return false
      // 主检出永远不进清理候选：不管它多老。
      if (!isIsolatedWorktreePath(row.worktreePath)) return false
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
