/**
 * `pipeline_status` —— 只读查询：现在队列里有什么、卡在哪、为什么卡。
 *
 * 这个工具**不写任何东西、不跑任何票**。它的唯一用途是回答人的三个问题：
 * 1. 我的工单进去了吗？→ 看队列里有没有那条 `recordId`
 * 2. 为什么不动了？→ 看 `phase` 与 `lastError`
 * 3. 该怎么让它动？→ `needs-info` 要补图、`failed` 用 `pipeline_reset` 放回队列
 *    （「拨走再拨回」在生产里其实点不到：重置入口只有工具这一条）
 *
 * 输出刻意用中文短句而不是 JSON dump：这是给人在对话里看的东西。
 * 需要机器可读的字段也一并放在返回值里（`tickets` 数组），不牺牲程序可用性。
 */

import { defineTool, textBlocks } from './define.js'
import { PHASE_LABEL, TERMINAL, TIMELINE_NODES, phaseLabel, priorityWeight } from '../contracts/types.js'
import { normalizeTestOutcome } from '../contracts/work-executor.js'
import { describeConfig } from '../core/config.js'
import { describeCommit, renderCommitSummary } from '../core/commit-summary.js'
import { foundAtSortKey, summarize, ticketKey } from '../core/store.js'
// 「能不能重跑」的口径只在 pipeline-reset.js 里定（RESETTABLE_PHASES）。
// 运行页签（#16）要按它决定给不给按钮，所以这里把它转成一个布尔随票下发 ——
// 浏览器 bundle 里 import 不到 src 里的常量，面板自己再抄一份判定就会两边不一致。
import { RESETTABLE_PHASES } from './pipeline-reset.js'

// 9 个主站的编号。补充站的 no 是 '·'，不参与「第 N 站」的说法。
const MAIN_STATION_NO = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨']
// Asia/Shanghai 固定 UTC+8，1991 年后不再有夏令时。
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * 每个阶段一句人话建议。**全都是函数**，入参是同一个 `AdviceContext`。
 *
 * 为什么统一成函数而不是「能静态就静态」：一条建议要对不对，取决于这一票自己的
 * 处境（`pending` 要看前面排着几张、是不是在退避；`done` 要看验证跑没跑、
 * 表格回填成没成；`failed` 要看是超时还是被取消）。静态字符串只能照顾
 * 「最典型的那一种」，其余情形就会说错话 —— 而错误建议比没有建议更糟。
 *
 * @typedef {object} AdviceContext
 * @property {number} now 本次查询的「现在」（epoch ms），整次查询共用一个
 * @property {object} row 这一票的票据行（`phase`/`testOutcome`/`writeBack`/`lastError` 等）
 * @property {number} pendingAhead 这一张前面还排着几张 pending（0 = 下一张就是它）
 * @property {number} pendingTotal 队列里一共有几张 pending
 * @property {number} backoffMs 这一张的退避还剩多久（0 = 不在退避）
 * @property {string} [backoffReason] 退避前那次失败的 `lastError`（有就带一句）
 * @property {number} pollIntervalMinutes 轮询间隔（说「下一轮大约几分钟后」用）
 */
const PHASE_ADVICE = {
  /**
   * 排队是这个插件的常态（并发恒 1），所以这句话最常被人看到，必须能区分三种处境：
   * 就快轮到了 / 前面还压着几张 / 自己在退避（这时「等」和「卡住」长得一样）。
   * @param {AdviceContext} ctx
   */
  pending (ctx) {
    if (ctx.backoffMs > 0) {
      const reason = ctx.backoffReason ? `上次失败：${ctx.backoffReason}。` : ''
      return `排队中，但正在退避：还要等 ${formatDuration(ctx.backoffMs)} 才会被重新捞起来。`
        + `${reason}退避是自动的，不用你做什么。`
    }
    if (ctx.pendingAhead <= 0) {
      return `队列里的下一张就是它，下一轮（约 ${ctx.pollIntervalMinutes} 分钟内）会开始。`
    }
    return `排队中，前面还有 ${ctx.pendingAhead} 张（共 ${ctx.pendingTotal} 张在等）。`
      + '同一时刻只跑一张，所以它要等前面的跑完。'
  },
  'worktree-ready': () => '已经确定改代码落在哪个目录上，下一步开始规划改动。',
  planning: () => '正在确认要改哪些文件。卡在这里超过一票超时时间就会被判超时。',
  editing: () => '正在改代码。',
  testing: () => '正在跑构建与测试。',
  'mr-opening': () => '改动已经完成，正在工作区检出里做本地提交。',
  'needs-info': () => '在等人：通常是截图取不到。补一张图或改「截图」列，再让它重来。',
  /**
   * done 有两种完全不同的收尾，必须分开说：
   * 验过了 = 人可以直接合；没跑验证 = 人必须自己验一遍再看。
   * 说成同一句「已完成」，没配验证命令的项目会以为自己全绿。
   * @param {AdviceContext} ctx
   */
  done (ctx) {
    const outcome = normalizeTestOutcome(ctx.row?.testOutcome)
    const backend = '改动已提交到项目工作区的检出里（本地提交，不是远端 MR）。去检出里 git show 就能 review。'
    if (outcome === 'not-run') {
      return `改动已提交，但验证命令没跑成（原因见下），请人工验一遍再用。${backend}`
    }
    if (outcome === 'passed') return `已完成，构建与测试都过了。${backend}`
    return `已完成（没有验证结论，不知道验没验过，建议自己看一眼）。${backend}`
  },
  skipped: () => '改动已提交到项目工作区的检出里（本地提交）。验证命令没通过，请人工确认这份改动是否可用 —— 不需要重跑，改了也不一定更好。',
  /**
   * failed 的原因差别很大：超时、被取消、真的报错。一句「失败了」等于什么都没说。
   * @param {AdviceContext} ctx
   */
  failed (ctx) {
    const lastError = String(ctx.row?.lastError ?? '')
    if (lastError === CANCELLED_BY_USER) {
      return '这张票是你取消的。要重跑就用 pipeline_reset（传它的 recordId）；工作区还留着，可以先去看看改到哪了。'
    }
    if (/^超时/.test(lastError)) {
      return `跑超时了（${lastError}）。可能是验证命令本来就很慢，也可能是卡在等模型；`
        + '要用 pipeline_reset 重跑的话，先把超时时间调大一点（配置项 ticketTimeoutMinutes）。'
    }
    return '失败了。要重跑就用 pipeline_reset（传它的 recordId）；失败不会自动重试，超时也一样。'
      + '「最近错误」那一行是原因，先看它。'
  },
  gone: () => '表格里这一行已经删掉了，静默退役。',
}

/**
 * 全库分布的**档位**，按「需要人干预的程度」从重到轻排。
 *
 * 为什么不用 `PHASE_LABEL` 直接按枚举顺序列：`skipped` 的中文标签本身就是
 * 「已交付，待人工验证」，而它属于「待人工验证」这一档 —— 直接拼会出现
 * 「待人工验证：已交付，待人工验证 2」这种同义重复。所以档位行用**短名**。
 *
 * `keepEmpty`：这一档即使为 0 也要留一行。只给最重的「需要你处理」用：
 * 人打开 status 第一眼要能确认「现在没有要我动手的」，而空白不等于零。
 */
const PHASE_TIERS = [
  {
    label: '需要你处理',
    keepEmpty: true,
    phases: [['failed', '失败'], ['needs-info', '等你补信息']],
  },
  {
    label: '待人工验证',
    phases: [['skipped', '']],
  },
  {
    label: '正在跑',
    phases: [
      ['pending', '排队'],
      ['worktree-ready', '备工作区'],
      ['planning', '分析'],
      ['editing', '改代码'],
      ['testing', '跑验证'],
      ['mr-opening', '本地提交'],
    ],
  },
  {
    label: '已交付',
    phases: [['done', '']],
  },
  {
    label: '已退役',
    phases: [['gone', '']],
  },
]

/**
 * 人工取消落 next 的 `lastError` 字面量（`scheduler.cancelActive()` 写的）。
 * 取消与真失败共用 `phase = 'failed'`，只能靠这句话区分 —— 所以它是一份契约，
 * 改这里必须同步改 `src/core/scheduler.js` 里写它的那一处。
 */
const CANCELLED_BY_USER = 'cancelled by user'

/**
 * 取消票的建议：不要说「去修好它重跑」，那是真失败的语境。
 * 人自己按的取消，只需要知道「现在什么都没坏，要重来就 reset」。
 */
const CANCEL_ADVICE = '这张票是你取消的，不是自己挂掉的 —— 改动可能只做了一半。'
  + '要重来就用 pipeline_reset（传它的 recordId）；工作区还留着，可以先去看看改到哪了。'

/**
 * 交付项的人话名字。顺序就是「人最关心哪一项」的顺序：
 * 改动没交出去 = 没有可 review 的东西；表格没回写 = 表里那行还停在处理中；
 * 通知没发出 = 你根本不知道这票干完了。
 */
const DELIVERY_ORDER = [
  ['commit', '改动提交'],
  ['writeBack', '回填表格'],
  ['notify', '发通知'],
]

/**
 * 这一票有哪些交付项没做成（#08）。
 *
 * 为什么不能只看 `phase`：phase 答的是「流程走到哪一站」，`done` 只说明执行器
 * 认为活干完了。回填失败、通知失败、甚至是「做完了但没有任何提交」都不会改变
 * phase —— 真机上就有一张票，改动/验证/通知都成了，只有回填被飞书同步表挡住，
 * 而插件把它当成成功。`delivery` 就是专门回答「该交给人的东西交到了没有」。
 *
 * @param {any} row
 * @returns {Array<{ name: string, label: string, state: any }>}
 */
function deliveryIssues (row) {
  const delivery = row?.delivery
  if (!delivery || typeof delivery !== 'object') return []
  const issues = []
  for (const [name, label] of DELIVERY_ORDER) {
    const state = delivery[name]
    if (state && state.ok === false) issues.push({ name, label, state })
  }
  return issues
}

/**
 * 一张票「最后一次动静」的时刻。用来回答「这个项目是不是很久没人动过」。
 *
 * 取法按可信度从高到低：终态有 `finishedAt`；否则时间线最后一条（心跳也算，
 * 它正是「还在跑」的证据）；再退到 `startedAt` / `enqueuedAt`。
 * 取**最大**而不是取第一个命中的：一张票可能刚被 reset 过（`startedAt` 比
 * 时间线更早），也可能老数据只有 `enqueuedAt`。
 *
 * @param {any} row
 * @returns {number | undefined}
 */
function lastActivityAt (row) {
  const candidates = []
  if (typeof row.finishedAt === 'number') candidates.push(row.finishedAt)
  const timeline = timelineOf(row)
  const last = timeline[timeline.length - 1]
  if (last && typeof last.at === 'number') candidates.push(last.at)
  if (typeof row.startedAt === 'number') candidates.push(row.startedAt)
  if (typeof row.enqueuedAt === 'number') candidates.push(row.enqueuedAt)
  const valid = candidates.filter((at) => Number.isFinite(at))
  return valid.length > 0 ? Math.max(...valid) : undefined
}

/**
 * `{ phase: count }` → 按 `PHASE_TIERS` 归档后的计数（顺序与档位一致）。
 *
 * 与 `formatDistribution` 共用 `PHASE_TIERS`，但那边输出的是给人看的一行字，
 * 这边要的是数字（按项目算「需你处理几张」）。两处若各写一份档位表，
 * 迟早会出现「汇总说 1 张需处理，明细里却找不到」这种互相打脸。
 *
 * 不认识的 phase 归到「其它」而不是丢掉 —— 丢掉就是「票不见了」。
 *
 * @param {Record<string, number>} counts
 * @returns {Array<{ label: string, count: number }>}
 */
function tierCounts (counts) {
  const out = []
  const seen = new Set()
  for (const tier of PHASE_TIERS) {
    let n = 0
    for (const [phase] of tier.phases) {
      seen.add(phase)
      n += Number(counts[phase] ?? 0)
    }
    out.push({ label: tier.label, count: n })
  }
  let other = 0
  for (const [phase, count] of Object.entries(counts)) {
    if (!seen.has(phase)) other += Number(count)
  }
  if (other > 0) out.push({ label: '其它', count: other })
  return out
}

/**
 * 按项目把全库票聚合成一句能一眼看完的战报。
 *
 * 为什么要有这一层：`pipeline_status` 以前只有「一张票一段十几行」的明细。
 * 票一多、项目一多，人想回答的其实只有一个问题 —— **「每个项目现在什么状态、
 * 有没有要我动手的」**。翻六张票的流程图才能拼出这个答案，等于没有答案。
 *
 * 口径是**全库**，不受 `recordId` / `includeDone` / `limit` 影响：
 * 汇总面板说「pms 3 张」就一定是 3 张，不跟着这次筛选抖动。
 *
 * @param {any[]} rows 全库票据行
 * @returns {Array<object>} 每个项目一条，已按「需你处理多 → 在跑多 → 名字」排好
 */
function summarizeProjects (rows) {
  /** @type {Map<string, any[]>} */
  const groups = new Map()
  for (const row of rows) {
    const id = typeof row.projectId === 'string' && row.projectId.length > 0 ? row.projectId : ''
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(row)
  }
  const out = []
  for (const [projectId, list] of groups) {
    /** @type {Record<string, number>} */
    const counts = {}
    for (const row of list) counts[row.phase] = (counts[row.phase] ?? 0) + 1
    const tiers = tierCounts(counts)
    const tierOf = (label) => tiers.find((t) => t.label === label)?.count ?? 0
    // 待你动手的：失败与等你补信息，带上原因 —— 只报数字不报是谁，等于让人自己去翻。
    const needsYou = list
      .filter((row) => row.phase === 'failed' || row.phase === 'needs-info')
      .sort((a, b) => (lastActivityAt(b) ?? 0) - (lastActivityAt(a) ?? 0))
    const awaiting = list.filter((row) => row.phase === 'skipped')
    const running = list.filter((row) => !TERMINAL.includes(row.phase) && row.phase !== 'pending' && row.phase !== 'needs-info')
    const queued = list.filter((row) => row.phase === 'pending')
    let latest
    for (const row of list) {
      const at = lastActivityAt(row)
      if (typeof at === 'number' && (latest === undefined || at > latest)) latest = at
    }
    out.push({
      projectId: projectId.length > 0 ? projectId : null,
      total: list.length,
      counts,
      tiers,
      needsYouCount: tierOf('需要你处理'),
      // 明细只带前 3 条：汇总面板的用途是「指路」，不是把所有票再抄一遍。
      needsYou: needsYou.slice(0, 3).map((row) => ({
        recordId: row.recordId,
        phase: row.phase,
        label: phaseLabel(row),
        lastError: row.lastError ?? null,
      })),
      awaitingReview: awaiting.slice(0, 3).map((row) => row.recordId),
      awaitingReviewCount: awaiting.length,
      running: running.slice(0, 3).map((row) => ({ recordId: row.recordId, phase: row.phase, label: phaseLabel(row) })),
      runningCount: running.length,
      queuedCount: queued.length,
      latestActivityAt: latest ?? null,
    })
  }
  out.sort((a, b) => {
    if (a.needsYouCount !== b.needsYouCount) return b.needsYouCount - a.needsYouCount
    if (a.runningCount !== b.runningCount) return b.runningCount - a.runningCount
    if (a.awaitingReviewCount !== b.awaitingReviewCount) return b.awaitingReviewCount - a.awaitingReviewCount
    return String(a.projectId ?? '').localeCompare(String(b.projectId ?? ''))
  })
  return out
}

/**
 * 每个项目最多在总览里列几张票。超出的折成一句「还有 N 张」——
 * 总览的用途是「一眼看完」，不是把所有明细再抄一遍。
 */
const OVERVIEW_ROWS_PER_PROJECT = 8

/**
 * 渲染「按项目」的总览：每个项目一行战报 + 每张票一行状态。
 *
 * 这一段回答的是**另一个问题**：明细回答「这一票怎么了」，总览回答
 * 「我这些项目现在什么情况、有没有要动手的」。后者以前只能靠人翻完所有票
 * 自己拼 —— 票一多就等于没有答案。
 *
 * @param {Array<object>} projects `summarizeProjects()` 的产出
 * @param {any[]} rowsByProject 用来取每张票的状态行（同一份全库快照）
 * @param {number} now 本次查询的「现在」
 * @returns {string[]}
 */
function renderProjectOverview (projects, rowsByProject, now) {
  /** @type {Map<string, any[]>} */
  const byId = new Map()
  for (const row of rowsByProject) {
    const id = typeof row.projectId === 'string' && row.projectId.length > 0 ? row.projectId : ''
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id).push(row)
  }
  const total = rowsByProject.length
  const lines = [`━━ 项目总览：${total} 张票 / ${projects.length} 个项目 ━━`]
  // 图例只打一次：九次解释会把总览撑成第二个明细视图。
  lines.push(`  ${FLOW_LEGEND}`)
  for (const project of projects) {
    const id = project.projectId
    const rows = (byId.get(id === null ? '' : id) ?? []).slice()
    // 项目内排序：需要动手的最前，然后正在跑的，再按最近动静倒序。
    const rank = (row) => {
      if (row.phase === 'failed' || row.phase === 'needs-info') return 0
      if (row.phase === 'pending') return 1
      if (!TERMINAL.includes(row.phase)) return 2
      if (row.phase === 'skipped') return 3
      return 4
    }
    rows.sort((a, b) => {
      const ra = rank(a)
      const rb = rank(b)
      if (ra !== rb) return ra - rb
      return (lastActivityAt(b) ?? 0) - (lastActivityAt(a) ?? 0)
    })
    const tierText = project.tiers
      .filter((tier) => tier.count > 0)
      .map((tier) => `${tier.label} ${tier.count}`)
      .join('｜')
    const latestText = typeof project.latestActivityAt === 'number'
      ? `｜最近动静 ${formatDuration(now - project.latestActivityAt)}前`
      : '｜还没有任何动静'
    lines.push(`【${id === null ? '未标项目' : id}】共 ${project.total} 张${tierText ? `｜${tierText}` : ''}${latestText}`)
    const shown = rows.slice(0, OVERVIEW_ROWS_PER_PROJECT)
    for (const row of shown) {
      lines.push(`    ${compactTicketLine(row, now)}`)
      // 每票第二行是流程带：一行摘要回答「现在怎么样」，流程带回答
      // 「这一票整条路走得顺不顺、在哪一站慢了或挂了」。
      lines.push(renderFlowLine(row, now))
    }
    if (rows.length > shown.length) {
      lines.push(`    ……还有 ${rows.length - shown.length} 张没列出（明细用 view="tickets" 看全）`)
    }
  }
  return lines
}

/**
 * 总览里的一张票：`✗ rec-1｜失败｜最近动静 3 时才动` 这种一行。
 *
 * 站点只在「没跑完」时有意义：终态票说「还停在第几站」会让人以为它还在走。
 * @param {any} row
 * @param {number} now
 */
function compactTicketLine (row, now) {
  const at = lastActivityAt(row)
  const idle = typeof at === 'number' ? `最近动静 ${formatDuration(now - at)}前` : '还没有任何动静'
  const good = !(row.phase === 'failed' || row.phase === 'needs-info')
  const mark = good ? '·' : '✗'
  const isTerminal = TERMINAL.includes(row.phase)
  let station = ''
  if (!isTerminal) {
    const flow = describeFlow(row, now)
    if (flow.station) {
      station = `｜站${flow.station.no}`
      // 长站点要带「这一站已经跑了多久」，否则「最近动静」只有几十秒（有心跳）
      // 会让人以为刚卡住 —— 这正是明细里踩过的坑，总览里同样要避开。
      if (typeof flow.stationElapsedMs === 'number') {
        station += `（已跑 ${formatDuration(flow.stationElapsedMs)}）`
      }
    } else {
      station = '｜未进站'
    }
  }
  const parts = [`${mark} ${row.recordId}`, phaseLabel(row)]
  const module = row.module ? `模块 ${row.module}` : ''
  if (module) parts.push(module)
  const head = parts.join('｜')
  const error = row.lastError ? `｜${String(row.lastError)}` : ''
  return `${head}${station}｜${idle}${error}`
}

/**
 * 9 个主站的节点 id，按流程顺序。与 `TIMELINE_NODES` 里的 `no` 一一对应。
 *
 * 总览里的「流程带」按这个顺序画，所以这里的顺序就是人对流程的直觉顺序 ——
 * 改它等于改「①是什么」，别为了排版动它。
 */
const MAIN_STATIONS = Object.freeze(['discover', 'locate', 'workspace', 'session', 'editing', 'testing', 'mr-opening', 'writeback', 'notify'])

/**
 * 流程带上的状态符号。
 *
 * `now`（▶）必须与 `ok`（✓）分开：一张票正停在⑥跑验证时，⑥标 ✓ 会让人
 * 以为它在等下一站 —— 而它其实还在这一站里。
 */
const STATION_MARK = Object.freeze({ ok: '✓', failed: '✗', now: '▶', unreached: '–' })

/**
 * 总览里「流程带」的一次性图例。只打一次，不逐票重复 ——
 * 九次解释会把总览撑成第二个明细视图。
 */
const FLOW_LEGEND = '（①–⑨ 是 9 个主站：①获取工单 ②查找项目 ③检查工作区 ④创建会话 ⑤处理问题 '
  + '⑥跑验证 ⑦提交 ⑧回填表格 ⑨发送消息；✓ 做成 / ✗ 没做成 / ▶ 正停在这一站 / – 没走过或没有记录；'
  + '只有超过 1 分钟的站才标耗时）'

/**
 * 只给 1 分钟以上的站标耗时。
 *
 * 秒级的站标出来全是噪音（①②③④ 常常都在 1 秒内），九个都标反而看不出
 * 「哪里慢」—— 而「哪里慢」正是这条流程带要回答的问题。
 * @param {number} ms
 * @returns {string} 空串 = 不标
 */
function formatShortDuration (ms) {
  if (!Number.isFinite(ms) || ms < 60_000) return ''
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  if (m < 60) return `${m} 分 ${total % 60} 秒`
  const h = Math.floor(m / 60)
  return `${h} 时 ${pad2(m % 60)} 分`
}

/**
 * 把一张票的时间线压成「9 个主站各自走没走过、成没成、花了多久」。
 *
 * 为什么要单独一层：`describeFlow` 只回答「现在停在哪一站」，而人看完总览
 * 之后紧接着想知道的是「这一票的整条路走得顺不顺、在哪一站慢了/挂了」——
 * 那正是流程带要说的事。明细视图里它是九行日志，这里是一行符号。
 *
 * 同一节点被打点多次（重跑、补做）时按**最后一次**算：人要看的是最终结果。
 *
 * @param {any} row
 * @param {number} now
 */
function describeStations (row, now) {
  const timeline = timelineOf(row)
  // 老票没有时间线：明确区分「没记录」与「九个站都没走到」，别把前者画成九个 –。
  if (timeline.length === 0) {
    return {
      stations: MAIN_STATIONS.map((node) => ({
        no: TIMELINE_NODES[node].no,
        node,
        label: TIMELINE_NODES[node].label,
        state: 'unreached',
        at: null,
        elapsedMs: null,
      })),
      reachedCount: 0,
      total: MAIN_STATIONS.length,
      failedStation: null,
      currentStation: null,
      totalMs: null,
      strip: '',
      noRecord: true,
    }
  }
  const terminal = TERMINAL.includes(row.phase)
  /** @type {Map<string, { entry: any, elapsedMs: number | undefined }>} */
  const seen = new Map()
  let firstAt
  for (let i = 0; i < timeline.length; i += 1) {
    const entry = timeline[i]
    if (entry.heartbeat === true) continue
    const next = timeline[i + 1]
    // 一站花了多久 = 下一条打点 - 这一条打点。
    //
    // 只有**还在跑**的票才用「现在」兜底最后一条：跑着的最后一站正是「已经跑了多久」。
    // 终态票不能这么算 —— 一张跑完的票如果再被 reset / 面板碰过，finishedAt 会被
    // 重写，于是「⑨发送消息（24 时 32 分）」这种数字会出现，看着像它卡在发消息上。
    // 终态就是「没有下一站」，不标耗时才是诚实的。
    let elapsedMs
    if (typeof entry.at === 'number') {
      if (next && typeof next.at === 'number') elapsedMs = Math.max(0, next.at - entry.at)
      else if (!terminal) elapsedMs = Math.max(0, now - entry.at)
    }
    seen.set(entry.node, { entry, elapsedMs })
    if (firstAt === undefined && typeof entry.at === 'number') firstAt = entry.at
  }
  // 「现在停在哪一站」与 describeFlow 同一口径：两处各判一次，
  // 迟早出现「带子上说停在⑥、结论说停在第⑤站」。
  const flow = describeFlow(row, now)
  const currentNo = !terminal && flow.station ? flow.station.no : undefined
  const stations = []
  let reachedCount = 0
  let failedStation
  let currentStation
  let lastAt
  for (const node of MAIN_STATIONS) {
    const meta = TIMELINE_NODES[node]
    const hit = seen.get(node)
    let state
    if (!hit) state = 'unreached'
    else if (hit.entry.ok === false) state = 'failed'
    else if (meta.no === currentNo) state = 'now'
    else state = 'ok'
    if (state !== 'unreached') reachedCount += 1
    if (state === 'failed' && failedStation === undefined) failedStation = meta.no
    if (state === 'now') currentStation = meta.no
    if (hit && typeof hit.entry.at === 'number') lastAt = hit.entry.at
    stations.push({
      no: meta.no,
      node,
      label: hit?.entry.label ?? meta.label,
      state,
      at: hit && typeof hit.entry.at === 'number' ? hit.entry.at : null,
      elapsedMs: hit && typeof hit.elapsedMs === 'number' ? hit.elapsedMs : null,
    })
  }
  let totalMs
  if (typeof firstAt === 'number') {
    totalMs = terminal
      ? (typeof lastAt === 'number' ? Math.max(0, lastAt - firstAt) : undefined)
      : Math.max(0, now - firstAt)
  }
  return {
    stations,
    reachedCount,
    total: MAIN_STATIONS.length,
    failedStation: failedStation ?? null,
    currentStation: currentStation ?? null,
    totalMs: typeof totalMs === 'number' ? totalMs : null,
    strip: stations.map((s) => `${s.no}${STATION_MARK[s.state]}`).join(' '),
    // 老票（2026-11-09 之前跑过的）没有时间线：必须说清是「没有记录」而不是
    // 「九个站一个都没走到」—— 后者会让人以为插件当时什么都没做。
    noRecord: timeline.length === 0,
  }
}

/**
 * 总览里跟着每张票的第二行：流程带 + 全程耗时。
 * @param {any} row
 * @param {number} now
 */
function renderFlowLine (row, now) {
  const flow = describeStations(row, now)
  if (flow.noRecord) return '        （没有流程记录 —— 这张票的处理早于流程日志功能，或刚入队还没开始打点）'
  const parts = flow.stations.map((station) => {
    const duration = formatShortDuration(station.elapsedMs)
    return `${station.no}${STATION_MARK[station.state]}${duration ? `（${duration}）` : ''}`
  })
  const total = typeof flow.totalMs === 'number' ? `｜全程 ${formatDuration(flow.totalMs)}` : ''
  return `        ${parts.join(' ')}${total}`
}

function pad2 (n) {
  return String(n).padStart(2, '0')
}

/**
 * epoch ms → Asia/Shanghai 的墙上时间。用固定 UTC+8 而不是 `toLocaleString`：
 * 1991 年后这里不再有夏令时，纯算术就能得到确定结果，自测不用赌机器的时区设置。
 * @param {number} at
 * @returns {string} `MM-DD HH:MM:SS`
 */
function formatClock (at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '时间未知  '
  const iso = new Date(at + SHANGHAI_OFFSET_MS).toISOString()
  return `${iso.slice(5, 10)} ${iso.slice(11, 19)}`
}

/** @param {number} ms @returns {string} `X 秒` / `X 分 Y 秒` / `X 时 Y 分` */
function formatDuration (ms) {
  if (!Number.isFinite(ms) || ms < 0) return '时间未知'
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total} 秒`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return `${m} 分 ${s} 秒`
  const h = Math.floor(m / 60)
  return `${h} 时 ${pad2(m % 60)} 分`
}

/** @param {import('../core/store.js').TicketRecordRow} row */
function timelineOf (row) {
  return Array.isArray(row.timeline) ? row.timeline : []
}

/**
 * 各站「通常要多久」的经验区间（分钟）。
 *
 * 只有这三个站可能很久：规划要模型想，改代码要模型写，跑验证要等构建/测试。
 * 区间来自真机基线（rec-mock-001/002/003：验证站 4:32 / 5:18 / 13:42），
 * 上下界取整到「足够宽、但超了确实不正常」的位置。
 *
 * 不给每个站都配区间：其余站都是秒级，写个「通常 0–1 分钟」只是噪音。
 * 更不写「预计还要 X 分钟」—— LLM 和任意构建脚本的剩余时间不可知，
 * 假精确比不精确更让人焦虑（票 #07 明确不做进度百分比）。
 */
const STATION_RANGE_MINUTES = Object.freeze({
  testing: [3, 15],
})

/**
 * 站点标签 + 经验区间后缀，例如 `跑验证（通常 3–15 分钟）`。
 * 只给有区间的长站点加后缀。
 * @param {string} node
 * @param {string} label
 */
function stationLabelWithRange (node, label) {
  const range = STATION_RANGE_MINUTES[node]
  if (!range) return label
  return `${label}（通常 ${range[0]}–${range[1]} 分钟）`
}

/**
 * 把一条票的流程日志压成「现在停在哪、停了多久」的机器可读结论。
 * 文字渲染与返回体共用这一份，免得两处对「第几站」的理解分家。
 *
 * **心跳条目**（`heartbeat: true`）不是站点：它们是「这一站还在跑」的证据，
 * 只参与「多久没动静」的计算，不参与「第几站」「这一站跑了多久」的定位 ——
 * 否则每 60 秒一条会被人当成走了一站又一站。
 *
 * @param {import('../core/store.js').TicketRecordRow} row
 * @param {number} now
 */
function describeFlow (row, now) {
  const timeline = timelineOf(row)
  if (timeline.length === 0) {
    return {
      timeline: [],
      stations: [],
      stalledForMs: undefined,
      station: undefined,
      stationElapsedMs: undefined,
      stationRange: undefined,
      lastNodeOk: undefined,
      heartbeatCount: 0,
      terminal: TERMINAL.includes(row.phase),
    }
  }
  const last = timeline[timeline.length - 1]
  // 「第 N 站」取最后到达过的主站（①–⑨），补充站与心跳的 no 不算站号。
  let stationIndex = -1
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    if (timeline[i].heartbeat === true) continue
    const meta = TIMELINE_NODES[timeline[i].node]
    if (meta && MAIN_STATION_NO.includes(meta.no)) {
      stationIndex = i
      break
    }
  }
  let station
  let stationElapsedMs
  let stationRange
  if (stationIndex >= 0) {
    const entry = timeline[stationIndex]
    const meta = TIMELINE_NODES[entry.node]
    station = { no: meta.no, label: entry.label ?? meta.label, node: entry.node }
    stationElapsedMs = typeof entry.at === 'number' ? Math.max(0, now - entry.at) : undefined
    stationRange = STATION_RANGE_MINUTES[entry.node]
  }
  let heartbeatCount = 0
  for (const entry of timeline) {
    if (entry.heartbeat === true) heartbeatCount += 1
  }
  return {
    timeline,
    stations: timeline.filter((entry) => entry.heartbeat !== true),
    stalledForMs: Math.max(0, now - (typeof last.at === 'number' ? last.at : now)),
    station,
    stationElapsedMs,
    stationRange,
    lastNodeOk: last.ok !== false,
    heartbeatCount,
    terminal: TERMINAL.includes(row.phase),
  }
}

/**
 * 渲染一张票的时间线。这一段是这次需求的核心：人扫一眼就知道「走到哪、
 * 哪一站没做成、卡了多久」，不用去翻插件日志。
 * @param {import('../core/store.js').TicketRecordRow} row
 * @param {number} now
 * @returns {string[]}
 */
function renderTimeline (row, now) {
  const flow = describeFlow(row, now)
  if (flow.timeline.length === 0) {
    return ['  流程日志：还没有记录（这张票可能是老数据，或刚入队还没开始打点）']
  }
  const lines = []
  lines.push('  流程日志（关键节点，✓ 做成 / ✗ 没做成；括号里是上一站耗时）：')
  let lastStationAt
  for (let i = 0; i < flow.timeline.length; i += 1) {
    const e = flow.timeline[i]
    const meta = TIMELINE_NODES[e.node]
    const no = meta?.no ?? '·'
    const label = e.label ?? meta?.label ?? e.node
    const mark = e.ok === false ? '✗' : '✓'
    // 心跳不单独占一行 —— 它只是把「多久没动」的计时器往前推，
    // 每 60 秒打一行会把时间线淹掉，也让人误以为又走了一站。
    if (e.heartbeat === true) {
      const hbCost = lastStationAt === undefined ? '' : `  · 最近一次心跳 ${formatClock(e.at)}`
      if (hbCost) lines[lines.length - 1] = `${lines[lines.length - 1]}${hbCost}`
      continue
    }
    const cost = lastStationAt === undefined ? '' : `（上一站 ${formatDuration(e.at - lastStationAt)}）`
    const detail = e.detail ? ` —— ${e.detail}` : ''
    lines.push(`    ${formatClock(e.at)}  ${no} ${mark} ${label}${detail}${cost}`)
    lastStationAt = e.at
  }
  const idle = formatDuration(flow.stalledForMs ?? 0)
  if (flow.terminal) {
    lines.push(`  ▶ 已经收尾（${phaseLabel(row)}），最后一次动静在 ${idle} 前。`)
  } else if (row.phase === 'needs-info') {
    lines.push(`  ▶ 现在停在「等你补充信息」，已 ${idle}没动（这一站在等人，不是插件卡死）。`)
  } else if (flow.station) {
    // 长站点用「这一站已经跑了多久」说，而不是「多久没动」：
    // 有心跳之后 stalledForMs 永远只有几十秒，单看它反而会让人以为快好了。
    // 再叠一个经验区间，超了才升级措辞 —— 只说「还在跑」等于什么都没说。
    // 短站点（没有经验区间）保持原来的「已 X 没动」，语义不变。
    const elapsed = flow.stationElapsedMs ?? 0
    const elapsedText = formatDuration(elapsed)
    const range = flow.stationRange
    const stationText = stationLabelWithRange(flow.station.node, flow.station.label)
    if (flow.lastNodeOk === false) {
      lines.push(`  ▶ 现在停在第 ${flow.station.no} 站「${stationText}」，已 ${formatDuration(flow.stalledForMs ?? 0)}没动。`
        + '最后这一站没做成，往上看 ✗ 那行的原因。')
    } else if (!range) {
      lines.push(`  ▶ 现在停在第 ${flow.station.no} 站「${stationText}」，已 ${formatDuration(flow.stalledForMs ?? 0)}没动。`
        + '时间一直不涨就是卡在这一站里（日志只在站点切换时打点）。')
    } else if (elapsed <= range[1] * 60_000) {
      lines.push(`  ▶ 现在停在第 ${flow.station.no} 站「${stationText}」，这一站已经跑了 ${elapsedText}。`
        + '还在跑，没超常见范围，接着等就行。')
    } else {
      lines.push(`  ▶ 现在停在第 ${flow.station.no} 站「${stationText}」，已经跑了 ${elapsedText}，`
        + `超过常见范围（${range[0]}–${range[1]} 分钟），可能卡住了；可以再等等，也可以取消后重跑。`)
    }
  } else {
    lines.push(`  ▶ 还没走到第一个主站，已 ${idle}没动。`)
  }
  return lines
}

/**
 * @param {Object} options
 * @param {import('../core/store.js').TicketStore} options.store
 * @param {() => Record<string, unknown>} options.getConfig 取当前生效的配置
 * @param {() => number} [options.now] 当前时刻（epoch ms），可注入以便自测；缺省 Date.now
 * @param {(argv: string[], opts?: { cwd?: string, timeoutMs?: number }) => Promise<{ code: number, stdout: string, stderr: string }> | null} [options.gitRunner]
 *   读「这次提交改了什么」用。为 null / 不注入时逐票只说「取不到」——
 *   一个可读的降级，而不是让整条查询失败。
 * @returns {Record<string, unknown>}
 */
export function createPipelineStatusTool (options) {
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now()
  const gitRunner = options.gitRunner ?? null
  return defineTool({
    name: 'pipeline_status',
    description:
      '只读查看工单流水线的状态。缺省给「按项目聚合的总览」：每个项目一行战报（共几张、'
      + '几张要你动手、最近动静），每张票一行状态 —— 一眼看完所有项目。'
      + '要看某一票的完整流程日志用 view="tickets" 或直接传 recordId。'
      + '不触发任何动作，不影响任何票。要推进就改用 pipeline_scan。',
    parameters: {
      recordId: {
        type: 'string',
        description: '只看这一条工单（飞书 record_id）。传了就一定按明细给，不受 view 影响。',
      },
      // 新增视图参数而不是改 includeDone 的缺省语义：includeDone 已被几十条自测
      // 断言依赖，把它的缺省翻面等于让所有老调用方一夜之间换输出。
      view: {
        type: 'string',
        enum: ['overview', 'tickets'],
        description: '怎么看。overview（缺省）= 按项目聚合的总览，一眼看完所有项目；tickets = 以前那种一张票一段的明细。传了 recordId 时一律按明细。',
        default: 'overview',
      },
      includeDone: {
        type: 'boolean',
        description: '明细视图里是否把已收尾（done / skipped / failed / gone）的票也列出来。默认只看没跑完的。总览视图不受它影响 —— 总览永远按全库算。',
        default: false,
      },
      limit: {
        type: 'integer',
        description: '明细视图里最多列多少条票。默认 20。总览视图不受它影响（每个项目自己限制在 8 行内并折叠）。',
        min: 1,
        max: 100,
        default: 20,
      },
    },
    // 机器可读字段放在返回值里，给人看的文本在 `text` 字段。
    // schema 只声明 object 根（DSH 工具的 JSON Schema 子集不支持 `type` 数组）。
    outputSchema: { type: 'object' },
    render: (value) => textBlocks(value.text),
    async execute (args, exec) {
      void exec
      // 算结果与渲染分层在这里落地：Remote（ticketPipeline.status()）也必须调
      // 同一个 collectStatus，否则面板上的票列表会和工具输出两套口径。
      return collectStatus(options, args)
    },
  })
}

/**
 * 算一份状态快照（工单 #16 抽出来的）。
 *
 * ## 为什么必须是模块级导出，而不是工具内部的一段
 *
 * 设置面板的「运行」页签也要看同一份状态：票有多少张、谁在跑、失败票是哪几条。
 * 如果面板那条路（TicketPipelineRemote.status()）自己重算一遍，就会出现
 * 「工具说 3 张要你处理、面板显示 2 张」——两个数字各自都对，人却不知道信谁。
 * 所以这里把「算」抽出来共用，面板只负责画。
 *
 * ## 参数
 *
 * @param {Object} options 与 createPipelineStatusTool 同一个 options
 * @param {Object} [args] 与工具入参同形状（recordId / view / includeDone / limit）
 */
export async function collectStatus (options, args) {
  const safeArgs = args && typeof args === "object" ? args : {}
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now()
  const gitRunner = options.gitRunner ?? null
  const config = options.getConfig()
  const limit = typeof safeArgs.limit === 'number' ? safeArgs.limit : 20
  const includeDone = safeArgs.includeDone === true
  // 两个视图回答两个不同的问题：
  //   overview —— 「我这些项目现在什么情况、有没有要我动手的」（缺省）
  //   tickets  —— 「这一票走到哪一站、卡了多久」（以前唯一的形态）
  // 缺省改成 overview 是因为按明细输出时，全在终态的库里默认一条都不显示
  // （只筛非终态），而人真正想知道的往往正是「全都跑完了没有」。
  const view = safeArgs.view === 'tickets' ? 'tickets' : 'overview'
  const hasRecordId = typeof safeArgs.recordId === 'string' && safeArgs.recordId.length > 0
  // 传了 recordId 一定是看某一张的明细：总览里没有「只看一张」这回事。
  const overview = view === 'overview' && !hasRecordId
  // 整次查询用同一个「现在」：否则逐票算时间线时，前一张票与后一张票的
  // 「已多久没动」会差几毫秒，自测也没法写确定值。
  const now = nowFn()

  let rows = options.store.listTickets()
  // 交付口径要按全库算，不受 recordId / includeDone 影响（#08）：
  // 「交付未完成：2 张」说的是整个流水线，不是这一次筛出来的。
  const allTicketsInitial = rows

  if (hasRecordId) {
    rows = rows.filter((row) => row.recordId === safeArgs.recordId)
    if (rows.length === 0) {
      // 早退分支的口径要和正常分支一致：counts 是全库，filteredCounts 是筛选后（这里是 0）。
      /** @type {Record<string, number>} */
      const allCounts = {}
      for (const row of options.store.listTickets()) {
        allCounts[row.phase] = (allCounts[row.phase] ?? 0) + 1
      }
      return {
        enabled: config?.enabled === true,
        counts: allCounts,
        filteredCounts: {},
        // 档位口径与正常分支一致：运行页签拿到早退结果时也要能画出汇总行。
        tiers: tierCounts(allCounts),
        view,
        projects: [],
        tickets: [],
        config: describeConfig(config),
        text: `没有这条工单的记录：${safeArgs.recordId}\n`
          + '（插件从没见过它。可能是「是否处理」还不是「处理中」，或者还没扫到。）',
      }
    }
  } else if (!overview && !includeDone) {
    rows = rows.filter((row) => !TERMINAL.includes(row.phase))
  }

  // 「本次筛选」这个口径只在真的筛过的时候才显示，否则它就等于全库，白占一行。
  // 总览永远按全库算，所以它不算「筛过」。
  const filteredScope = hasRecordId || (!overview && !includeDone)

  // 两个口径必须分开算、分开写明，否则会互相冒充：
  //   total    —— 全库（不受 recordId / includeDone 影响），回答「整个流水线大概什么样」
  //   filtered —— 这次请求筛完之后、尚未被 limit 截断（回答「我这次问到的这批有多少」）
  // 以前只有一组 counts 却用全库算，列表却按过滤后显示：传了 recordId 时
  // 上面写着「失败 7」，下面只有 1 条，人会以为列表漏了。
  /** @type {Record<string, number>} */
  const total = {}
  for (const row of options.store.listTickets()) {
    total[row.phase] = (total[row.phase] ?? 0) + 1
  }
  /** @type {Record<string, number>} */
  const filtered = {}
  for (const row of rows) {
    filtered[row.phase] = (filtered[row.phase] ?? 0) + 1
  }

  // 排队顺序 = pickNext 的顺序：优先级降序 → 发现日期升序 → 入队时间升序。
  // 比较逻辑直接复用 store / types 里的那几个函数，不在这里再写一份：
  // 写两份就会在「没有发现日期时排哪儿」这种细节上分道扬镳。
  const priorityText = { high: '高', medium: '中', low: '低' }
  const compareQueue = (a, b) => {
    const pa = priorityWeight(a.priority)
    const pb = priorityWeight(b.priority)
    if (pa !== pb) return pb - pa
    const fa = foundAtSortKey(a)
    const fb = foundAtSortKey(b)
    if (fa !== fb) return fa < fb ? -1 : 1
    return (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0)
  }
  rows = [...rows].sort(compareQueue)

  const shown = rows.slice(0, limit)
  const enabled = config?.enabled === true

  const lines = []
  lines.push(enabled ? '流水线：已开启' : '流水线：总开关是关的（enabled=false），不会自动扫表')

  /**
   * 把 `{ phase: count }` 按档位渲染成几行人话。
   *
   * 改这里的动机（#01）：原来是按 phase 枚举顺序拼成一行，
   * 于是「已本地提交，但未跑通验证 2」和「失败 1」并列，读的人分不清
   * 哪一类要自己动手。现在按干预程度分档，最重的一档永远有行。
   *
   * @param {Record<string, number>} source
   * @param {string} [emptyText] 一条都没有时改说这句话（只给「本次筛选」用；
   *   全库口径不用它 —— 空库时「需要你处理：0」本身就是有用的答案）
   * @returns {string[]}
   */
  const formatDistribution = (source, emptyText) => {
    const entries = Object.entries(source).filter(([, count]) => Number(count) > 0)
    if (entries.length === 0 && emptyText) return [emptyText]
    const out = []
    const seen = new Set()
    for (const tier of PHASE_TIERS) {
      const parts = []
      for (const [phase, shortName] of tier.phases) {
        seen.add(phase)
        const count = Number(source[phase] ?? 0)
        if (count <= 0) continue
        parts.push(shortName ? `${shortName} ${count}` : String(count))
      }
      if (parts.length > 0) out.push(`${tier.label}：${parts.join(' / ')}`)
      else if (tier.keepEmpty) out.push(`${tier.label}：0`)
    }
    // 不认识的新 phase 不能被吞掉 —— 吞掉就是「票不见了」。
    const leftovers = entries.filter(([phase]) => !seen.has(phase))
    if (leftovers.length > 0) {
      out.push(`其它：${leftovers.map(([phase, count]) => `${PHASE_LABEL[phase] ?? phase} ${count}`).join(' / ')}`)
    }
    return out
  }
  // 先把两个口径都写上，再决定列不列票：这样「筛选结果为空」时，
  // 人也还能看到全库其实有多少票 —— 否则只剩一句「没有未收尾的票」，看不出是全空了还是筛空了。
  lines.push(...formatDistribution(total).map((line, i) => `${i === 0 ? '全库分布：' : '        '}${line}`))
  if (filteredScope) {
    lines.push(...formatDistribution(filtered, '（无）').map((line, i) => `${i === 0 ? '本次筛选：' : '        '}${line}`))
  }
  // 交付未完成单独一行（#08）：这类票回填/通知/提交有一项没交到你手里 ——
  // 只看 phase 分布会漏掉它们（phase=done 但表格没回写的那张最典型）。
  //
  // 但**不能一律说成「票态已经是完成」**：2026-11-11 真机上 4 张交付未完成的票
  // 全都是 phase=failed，banner 却写「票态已经是完成」，人一看就觉得文案在胡说。
  // 两种票要处理的动作完全不同（failed 要 reset 重跑，done 只要补回填），
  // 所以分开数、分开说。
  const deliveryIncompleteRows = allTicketsInitial.filter((row) => deliveryIssues(row).length > 0)
  const deliveryDoneButIncomplete = deliveryIncompleteRows.filter((row) => row.phase === 'done').length
  const deliveryFailedToo = deliveryIncompleteRows.filter((row) => row.phase === 'failed').length
  if (deliveryIncompleteRows.length > 0) {
    const parts = []
    if (deliveryDoneButIncomplete > 0) parts.push(`${deliveryDoneButIncomplete} 张票态已完成却漏了交付`)
    if (deliveryFailedToo > 0) parts.push(`${deliveryFailedToo} 张本身就跑失败了、交付也没做成`)
    const rest = deliveryIncompleteRows.length - deliveryDoneButIncomplete - deliveryFailedToo
    if (rest > 0) parts.push(`${rest} 张其它状态`)
    lines.push(`交付未完成：${deliveryIncompleteRows.length} 张（${parts.join('；')} —— 见下面带「（表格未回写）」或「（交付未完成：…）」的票）`)
  }
  lines.push('')

  // ── 队列说明（#17）─────────────────────────────────────────
  // 并发恒 1，所以「排队」是这个插件的常态而不是边界情况。以前这里
  // 一个字都不说，人看到「排队中 3 张」等十分钟，分不清是「前面那张在跑」
  // 「我在退避」还是「根本不会跑了」。
  //
  // 「下一个」直接问 store.pickNext()，不在这里再排一遍 —— 排序规则写两份
  // 就会在「没有发现日期时排哪儿」这类细节上分道扬镳（本文件上面的注释同理）。
  const allRows = options.store.listTickets()
  const pendingRows = allRows.filter((row) => row.phase === 'pending')
  const pendingTotal = pendingRows.length
  // 退避中的票：enqueuedAt 被写成「现在 + 退避」，store.pickNext 会跳过它。
  // 判定口径必须与 store.js 的 `(row.enqueuedAt ?? 0) > now` 完全一致，
  // 否则会出现「status 说下一张是它，实际 pickNext 跳过了」这种自相矛盾。
  const backoffRemainingMs = (row) => {
    const enqueuedAt = Number(row.enqueuedAt ?? 0)
    return enqueuedAt > now ? enqueuedAt - now : 0
  }
  // 队列顺序按 pickNext 的口径排一遍，用来算「这张前面还有几张」。
  // 退避中的票不算在前面 —— pickNext 根本不会挑它，说「前面还有 1 张」
  // 会让人误以为那张跑完就轮到它。
  const runnablePending = pendingRows
    .filter((row) => backoffRemainingMs(row) === 0)
    .sort(compareQueue)
  // 行的身份：真库有 `key`；自测/老数据可能只有 projectId + recordId。
  const rowIdentity = (row) => row.key ?? ticketKey(row.projectId ?? '', row.recordId ?? '')
  const pollIntervalMinutes = Number(config?.pollIntervalMinutes ?? 3)
  if (pendingTotal > 0) {
    const nextRow = typeof options.store.pickNext === 'function'
      ? options.store.pickNext()
      : runnablePending[0]
    const queueLines = [`队列：${pendingTotal} 张在等（同一时刻只跑一张）`]
    if (nextRow) {
      const nextTitle = nextRow.problemSummary ?? summarize(nextRow.description ?? '')
      const priorityLabel = priorityText[nextRow.priority ?? ''] ?? nextRow.priority ?? '未标'
      queueLines.push(`下一个：${nextRow.projectId ? `[${nextRow.projectId}] ` : ''}${nextRow.recordId}（优先级 ${priorityLabel}）｜${nextTitle}`)
    } else {
      // 全是退避中的票：这时候「下一个」没有答案，必须说清为什么，
      // 否则这句话看起来像是工具坏了。
      queueLines.push('下一个：暂时没有（都在退避中，等退避结束会自动重新排队）')
    }
    queueLines.push('排法：优先级高的先跑 → 发现日期早的先跑 → 入队早的先跑')
    // 这句是顺手回答「为什么这么慢 / 能不能并发」——必然会被问一次。
    queueLines.push('为什么一次只跑一张：多张票同时改同一个代码检出会互相踩，串行是设计不是缺陷。')
    lines.push(...queueLines)
    lines.push('')
  }

  /**
   * recordId → 改动摘要。渲染与返回体共用同一份结果，免得为了
   * `tickets[].commitSummary` 再跑一遍 git（那就是每票两次进程）。
   * @type {Map<string, Awaited<ReturnType<typeof describeCommit>>>}
   */
  const summaries = new Map()

  // 按项目聚合永远按**全库**算：它是「我这几个项目现在什么情况」的答案，
  // 不该跟着 recordId / includeDone / limit 抖动。
  const projectSummaries = summarizeProjects(allTicketsInitial)

  if (overview) {
    if (allTicketsInitial.length === 0) {
      lines.push('库里还没有任何票。')
    } else {
      lines.push(...renderProjectOverview(projectSummaries, allTicketsInitial, now))
      lines.push('')
      lines.push('（这是按项目聚合的总览。看某一票的完整流程日志用 view="tickets"，或直接传 recordId。）')
    }
  } else if (rows.length === 0) {
    lines.push(filteredScope
      ? '这次筛选一条都没命中（全库分布见上）。'
      : (includeDone ? '库里还没有任何票。' : '没有未收尾的票。'))
  } else {
    for (const row of shown) {
      const title = row.problemSummary ?? summarize(row.description ?? '')
      const projectTag = row.projectId ? `[${row.projectId}] ` : ''
      // 取消与真失败共用 phase=failed（#02）：不区分的话，人分不清「我取消的」
      // 和「它自己挂了的」—— 前者不用管，后者要修。
      const cancelledByUser = row.phase === 'failed' && row.lastError === CANCELLED_BY_USER
      // 退避中的 pending 与普通 pending 的 phase 完全一样（#17）。不把退避
      // 写进状态行，两行文字就一模一样 —— 人无法判断是在等还是卡住。
      const backoffMs = row.phase === 'pending' ? backoffRemainingMs(row) : 0
      const backoffSuffix = backoffMs > 0 ? `（退避中，还要等 ${formatDuration(backoffMs)}）` : ''
      // 阶段名走 phaseLabel(row)：done 要能分出「已验证 / 未跑验证」，
      // 混成一个「已完成」会让没配验证命令的项目以为自己全绿。
      // 交付没做成时再加个后缀（#08）：票面写着「已完成」但回填/通知/提交
      // 有一项没落地 —— 不加后缀，人只看标题会以为一切正常。
      const issues = deliveryIssues(row)
      const deliverySuffix = issues.length === 0
        ? ''
        : (issues.length === 1 && issues[0].name === 'writeBack'
            ? '（表格未回写）'
            : `（交付未完成：${issues.map((it) => it.label).join('、')}）`)
      const phaseText = `${phaseLabel(row)}${cancelledByUser ? '（你取消的）' : ''}${backoffSuffix}${deliverySuffix}`
      lines.push(`· ${projectTag}${row.recordId}｜${phaseText}｜${title}`)
      // 建议现在**一律**是函数（见 PHASE_ADVICE 的说明）：一条建议对不对取决于
      // 这一票自己的处境，静态字符串只能照顾最典型的那一种。取消票有自己的话术。
      const adviceDef = cancelledByUser ? CANCEL_ADVICE : PHASE_ADVICE[row.phase]
      const advice = typeof adviceDef === 'function'
        ? adviceDef({
            now,
            row,
            // 「前面还有几张」按 pickNext 的可跑口径算：退避中的不算前面，
            // 否则会出现「前面还有 1 张」但那张根本没在跑的错觉。
            pendingAhead: Math.max(0, runnablePending.findIndex((p) => rowIdentity(p) === rowIdentity(row))),
            pendingTotal,
            backoffMs,
            backoffReason: backoffMs > 0 ? row.lastError : undefined,
            pollIntervalMinutes,
          })
        : adviceDef
      if (advice) lines.push(`  ${advice}`)
      if (row.module) lines.push(`  模块：${row.module}${row.priority ? `｜优先级：${row.priority}` : ''}`)
      if (row.worktreePath) lines.push(`  改代码目录：${row.worktreePath}`)
      if (row.commit?.sha) {
        lines.push(`  本地提交：${String(row.commit.sha).slice(0, 12)}${row.commit.branch ? ` @ ${row.commit.branch}` : ''}`)
        // 「改了什么」是这个工具以前最缺的一段：只给 sha，人还得离开 GUI 去敲 git show。
        // 只读、一次进程调用、读不到就降级，绝不影响这条查询本身。
        summaries.set(row.recordId, await describeCommit({
          gitRunner,
          worktreePath: row.worktreePath,
          sha: row.commit.sha,
        }))
        renderCommitSummary(summaries.get(row.recordId), (line) => lines.push(line))
      }
      if (row.mr?.url) lines.push(`  MR：${row.mr.url}${row.mr.draft ? '（draft）' : ''}`)
      if (row.sessionId) lines.push(`  处理会话：${row.sessionId}（保留在工作区名下，可在会话列表里点进去继续问）`)
      // 回填只在 done/skipped 后发生，写没写成是「表格里那行现在长什么样」的唯一线索。
      if (row.writeBack) {
        lines.push(row.writeBack.written
          ? `  回填表格：成功${Array.isArray(row.writeBack.fields) && row.writeBack.fields.length > 0 ? `（${row.writeBack.fields.join('、')}）` : ''}`
          : `  回填表格：没写成 —— ${row.writeBack.note ?? '原因未记录'}`)
      }
      // 交付维度逐项（#08）：只写在「没做成」的那几项上，成功的不用重复。
      // 已放弃（giveUp）的项要多说一句「别再等了」—— 否则人会一直等它自己好。
      for (const issue of issues) {
        const state = issue.state
        const attempts = Number(state.attempts ?? 0)
        const tried = attempts > 1 ? `（已试过 ${attempts} 次）` : ''
        const tail = state.giveUp === true
          ? '这不是再试一次能好的，得你去改配置/表格设置。'
          : '会再自动试一次（下次启动补做）。'
        lines.push(`  交付·${issue.label}：没做成${tried} —— ${state.error ?? '原因未记录'}。${tail}`)
      }
      if (cancelledByUser) {
        // 原文是 'cancelled by user' —— 内部标识符，读的人不需要看见它。
        lines.push('  最近错误：（无。这张票是你取消的，不是报错）')
      } else if (row.lastError) lines.push(`  最近错误：${row.lastError}`)
      if (row.testDetail) lines.push(`  测试说明：${row.testDetail}`)
      // 待补做的事后动作：票已经是终态，但回填/通知还没做成（进程在中间退出了）。
      // 不写出来，「表里那行还停在处理中」就永远没人知道该去看一眼。
      if (row.pendingEffects) {
        const todo = []
        if (row.pendingEffects.writeBack) todo.push('回填表格')
        if (row.pendingEffects.notify) todo.push('发通知')
        if (todo.length > 0) {
          lines.push(`  待补做：${todo.join('、')}（进程在到终态之后、动作完成之前退出了；下次启动会自动补做一次）`)
        }
      }
      if (row.revisionCount > 1) lines.push(`  这是第 ${row.revisionCount} 版（工单被改过 ${row.revisionCount - 1} 次）`)
      // 时间线放在最后：前面的「最近错误 / 待补做」先给结论，这里给完整过程。
      lines.push(...renderTimeline(row, now))
    }

    if (rows.length > shown.length) {
      lines.push('')
      lines.push(`还有 ${rows.length - shown.length} 条没列出（用 limit 调大）。`)
    }
  }

  return {
    enabled,
    // 这次给的是哪一屏：overview = 按项目聚合的总览，tickets = 一张票一段的明细。
    // 调用方要靠它判断下面 `projects` / `tickets` 两份数据哪一份才是主体。
    view,
    // 按项目聚合的战报：口径恒为全库，不受 recordId / includeDone / limit 影响。
    // 「每个项目多少张、几张要你动手」以前只能靠人翻完所有票自己数。
    projects: projectSummaries,
    // counts = 全库口径（老字段名不变，避免调用方炸）；filteredCounts = 本次筛选口径。
    counts: total,
    filteredCounts: filtered,
    // 全库按「干预程度」归档后的计数（#16）：设置面板「运行」页签的汇总行直接画
    // 这一份，不再自己数 phase —— 浏览器里没有 PHASE_TIERS，抄一份必然两处打脸。
    tiers: tierCounts(total),
    // 队列快照（#17）：运行页签（#16）与告警要看「谁是下一个」，不该自己再排一遍。
    // backoff：这一轮拣不出来的票（退避没到期），带还剩多久 —— 它们看着像
    // 普通 pending，但实际不会跑，只靠 phase 分辨不出来。
    queue: {
      pendingCount: pendingTotal,
      runnableCount: runnablePending.length,
      nextRecordId: (() => {
        const nextRow = typeof options.store.pickNext === 'function'
          ? options.store.pickNext()
          : runnablePending[0]
        return nextRow ? nextRow.recordId : null
      })(),
      orderRule: 'priority-desc → foundAt-asc → enqueuedAt-asc',
      backoff: pendingRows
        .filter((row) => backoffRemainingMs(row) > 0)
        .map((row) => ({
          recordId: row.recordId,
          remainingMs: backoffRemainingMs(row),
          reason: row.lastError ?? null,
        })),
    },
    tickets: shown.map((row) => {
      // 机器可读的时间线在这里给全量（node/label/at/ok/detail 原样），
      // 不截断成布尔：调用方拿它自己画图或做告警都要原始条目。
      const flow = describeFlow(row, now)
      // 交付没做成的项（#08）：渲染循环里也算一次，这里重新算而不是捕获 ——
      // 两个循环的 row 不是同一个作用域，捕获会拿到最后一张票的。
      const ticketsIssues = deliveryIssues(row)
      return {
        projectId: row.projectId,
        recordId: row.recordId,
        phase: row.phase,
        // 人话阶段名（#16）：设置面板的「运行」页签要用它画票列表。
        // 浏览器 bundle 里没有 PHASE_LABEL / phaseLabel，若让面板自己拼一份，
        // 「已完成（未跑验证）」这种判定就会两处各写一遍、迟早说法不一致。
        phaseLabel: phaseLabel(row),
        // 是不是人自己按的取消（#16）：面板要决定给不给「重跑」按钮，
        // 而「取消」与「真失败」共用 phase=failed，只能靠这个布尔区分。
        // 判定口径只有 CANCELLED_BY_USER 一处，面板不该自己比对那个字面量。
        cancelledByUser: row.phase === 'failed' && row.lastError === CANCELLED_BY_USER,
        // 能不能用 pipeline_reset 重开（#16）：口径来自 RESETTABLE_PHASES，
        // 面板只读这个布尔，不自己判断 phase 名单（名单在 src 里，浏览器取不到）。
        canReset: RESETTABLE_PHASES.includes(row.phase),
        problemSummary: row.problemSummary,
        module: row.module,
        priority: row.priority,
        worktreePath: row.worktreePath,
        branch: row.branch,
        commitSha: row.commit?.sha,
        // 机器可读的改动摘要：调用方（运行页签/告警）不必自己再跑一次 git。
        // 取不到时是 `{ ok:false, reason }`；这票压根没有提交时是 null ——
        // 绝不漏成 undefined（工具通道要求 lossless JSON，undefined 会直接报错）。
        commitSummary: summaries.get(row.recordId) ?? null,
        mrUrl: row.mr?.url,
        sessionId: row.sessionId,
        writeBack: row.writeBack,
        // 交付维度（#08）：`commit`/`writeBack`/`notify` 各自成没成。
        // 与 phase 正交 —— phase 是「走到哪」，这是「该交的交给去了没有」。
        // 没记录时是 null（绝不留 undefined，工具通道要求 lossless JSON）。
        delivery: row.delivery ?? null,
        deliveryIssues: ticketsIssues.map((it) => ({ name: it.name, label: it.label, error: it.state.error ?? null, attempts: it.state.attempts ?? null, giveUp: it.state.giveUp === true })),
        // 只暴露「还有没有待补做」，不把整份 writeBack 输入摊给调用方：
        // 那是内部载荷，对调用方没有意义，还会把工具输出撑大。
        pendingEffects: row.pendingEffects
          ? { writeBack: Boolean(row.pendingEffects.writeBack), notify: Boolean(row.pendingEffects.notify) }
          : undefined,
        lastError: row.lastError,
        testDetail: row.testDetail,
        revisionCount: row.revisionCount,
        attempt: row.attempt,
        timeline: flow.timeline,
        // 压成 9 个主站的流程带（#20）：时间线是「原始日志」，这是「一眼看走顺不顺」。
        // 总览的第二行、以及将来面板画进度条，都用这一份，不各自再压一遍。
        flow: describeStations(row, now),
        // 只留真正的站点（心跳条目是「还在跑」的证据，不算站点）——
        // 调用方按站点数做判断时不该被每 60 秒一条的心跳带偏。
        stations: flow.stations,
        stalledForMs: flow.stalledForMs,
        station: flow.station,
        // 这一站已经跑了多久 + 经验区间（分钟，只有长站点有）。
        // 与 stalledForMs 是两个数：有站点心跳之后，后者永远只有几十秒。
        stationElapsedMs: flow.stationElapsedMs,
        stationRange: flow.stationRange,
        heartbeatCount: flow.heartbeatCount,
        lastNodeOk: flow.lastNodeOk,
      }
    }),
    config: describeConfig(config),
    text: lines.join('\n'),
  }
}
