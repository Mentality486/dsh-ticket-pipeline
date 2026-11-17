/**
 * 「倒在哪一站」「从哪一站续跑」的判据。
 *
 * ## 为什么单独一个模块
 *
 * 这两件事原先都**没有**：失败时票上只有一句 `lastError`（一串 shell 命令 + stderr），
 * 人看不出「是改代码失败、验证失败，还是提交失败」；重跑则一律走
 * `resetByHuman` 把票当新票跑一遍 —— 几十轮探索白费，而且上一轮那个会话还在，
 * 同一张票就出现了两个会话。
 *
 * 真机现场（2026-11-17，`pms|sh-row-82`）：⑦ 提交失败，面板上九站全绿 + 一句
 * 5 段 pathspec 的报错，`这一站已经待了 5751 分钟`。用户的原话是
 * 「这失败了也没告诉用户哪一步失败了 是工单处理问题失败了 还是测试失败了
 *  不要重新跑 应该是修复只针对失败的那一步进行修复然后接着跑后续的
 *  还在那个失败的会话中继续」。
 *
 * 判据放在 core 层、纯函数、不碰存储：调度器（落库）、`pipeline_status`（渲染）、
 * `pipeline_reset`（决定续跑还是重来）、执行器（决定跳过哪几段）都要用同一套，
 * 各写一份迟早出现「面板说倒在第 7 站、实际从第 5 站开始跑」。
 *
 * ## 两个概念要分开
 *
 * - `failedStation`：**上一轮死在哪**。事实，只在失败收尾时写，成功后清掉。
 * - `resumeFrom`：**这一次从哪跑**。决定，由人工重开时写入，可以比 `failedStation`
 *   更靠前（人选择从头再来）或更靠后（人认为前面几步不用重做）。
 *
 * 混成一个字段会丢掉一种情况：人决定从头重跑时，面板就再也说不出「上回是死在哪的」——
 * 而那句话恰恰是判断「这次能不能跑通」的唯一依据。
 */

import { TIMELINE_NODES } from '../contracts/types.js'

/**
 * 九个主站，顺序即 `TIMELINE_NODES` 里的 ①–⑨。
 *
 * 与 `pipeline-status.js` 里那份必须一致 —— 那边是渲染用的展示顺序，
 * 这边是「第几站」的序号来源，两者其实是一张表，所以这里导出、
 * 那边 import，不再各写一份。
 */
export const MAIN_STATIONS = Object.freeze([
  'discover',
  'locate',
  'workspace',
  'session',
  'editing',
  'testing',
  'mr-opening',
  'writeback',
  'notify',
])

/** 主站 → 1-based 序号（①=1 … ⑨=9）。非主站得到 0。 */
export const STATION_RANK = Object.freeze(
  Object.fromEntries(MAIN_STATIONS.map((node, index) => [node, index + 1])),
)

/** 这是一站主站吗（`worktree-ready`、`planning` 这类补充站不算）。 */
export function isMainStation (node) {
  return Object.hasOwn(STATION_RANK, node)
}

/** 第几站（1–9）；不是主站返回 0。 */
export function stationRankOf (node) {
  return STATION_RANK[node] ?? 0
}

/**
 * 一站的自描述：`{ node, no, label, short }`，不是主站返回 null。
 *
 * 渲染侧要 `no`（①）与 `short`（提交），逻辑侧要 `node`（mr-opening），
 * 所以一次给全，调用方别再各自查表。
 */
export function describeStation (node) {
  if (!isMainStation(node)) return null
  const meta = TIMELINE_NODES[node]
  return { node, no: meta.no, label: meta.label, short: meta.short ?? meta.label }
}

/**
 * 时间线里「最后一个做成了的主站」。
 *
 * 这是**倒在哪一站**的判据，不是「最后一个节点」：失败时最后一条通常是
 * `failed` 这个补充站（调度器收尾时补的），它只说明「失败了」，不说明
 * 「在哪失败」。往前找到的最后一个主站，才是它当时正在干的那件事 ——
 * `onPhase()` 在主站上写的是 `ok: true`（进站即记），所以主站条目
 * 一律是「做成过一次」，失败那次由调用方另行判断。
 *
 * 心跳（`heartbeat: true`）跳过：它只是「这一站还在跑」的证据，
 * 与站点身份无关，而且会和进站那条合并，算进来会让「最近一次主站」
 * 变成一堆重复。
 *
 * @param {import('../contracts/types.js').TimelineEntry[] | undefined} timeline
 * @returns {string | undefined} 主站 node id；时间线为空 / 一条主站都没有时 undefined
 */
export function lastMainStationOf (timeline) {
  if (!Array.isArray(timeline)) return undefined
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index]
    if (!entry || entry.heartbeat === true) continue
    if (isMainStation(entry.node)) return entry.node
  }
  return undefined
}

/**
 * 从某一站续跑时，哪几段要重做、哪几段可以跳过。
 *
 * 判断依据是「那一站之后的工作还在不在」：
 *
 * - ⑤ 改代码 / ⑥ 验证倒下：活还没干完（或干完了但没过），**要接着让 agent 干**，
 *   然后重新收集改动、重新验证、再提交。验证必须重跑 —— 上一轮的验证结论
 *   对应的是上一轮的代码，现在代码变了，旧结论不作数。
 * - ⑦ 提交倒下：代码改完、验证也过了，倒的是「打包」这一步。
 *   **不用叫 agent**，收集改动 → 提交即可。此时重跑验证纯属浪费
 *   （真机 `pms` 的验证命令要跑几分钟，而它检查的东西这一刻根本没变）。
 * - ⑧ 回填 / ⑨ 通知倒下：代码早就交付了，只是没交到人手上。
 *   不碰工作区、不跑验证、不叫 agent，交给调度器的 `pendingEffects` 补做。
 *
 * @param {string | undefined} station 主站 node id
 * @returns {{ station: string, rank: number, agent: boolean, verify: boolean, collect: boolean } | null}
 */export function resumePlanOf (station) {
  const rank = stationRankOf(station)
  if (rank === 0) return null
  // ①–④ 没有「进度」可续：读表格、定位仓库、建工作区、建会话都是秒级的准备动作，
  // 重做一遍比「续」还便宜，而且那些站倒下时工作区/会话根本没建起来。
  // 和 `canResumeFrom` 用同一条下界 —— 两处判据不一致时，
  // 会出现「面板说会从 ④ 接着跑、执行器其实从头开始」这种都说不上错但都在骗人的状态。
  if (rank < STATION_RANK.editing) return null
  const RANK_OF_TESTING = STATION_RANK.testing
  const RANK_OF_WRITEBACK = STATION_RANK.writeback
  // ⑧⑨ 不归执行器管：那两站倒下时票已经交付了，补做走调度器的 `pendingEffects`。
  // 这里给一个「全都 false」的计划会让执行器「什么都不做地跑完一轮」，
  // 然后返回一个没有 commit 的结果 —— 比报错还难查。宁可当作「没有续跑计划」。
  if (rank >= RANK_OF_WRITEBACK) return null
  return {
    station,
    rank,
    // 还要 agent 动手：改代码与验证这两站。验证倒下通常意味着测试报错，
    // 修它要改代码 —— 那时人最想要的就是「接着上一轮那个会话继续」，
    // 而不是重开一个从头读仓库的会话。
    agent: rank <= RANK_OF_TESTING,
    // 只有前两段需要重跑验证：⑦ 之后验证已经通过了，重跑只是再花几分钟。
    verify: rank <= RANK_OF_TESTING,
    // ⑦ 及以前都要重新收集改动（提交要有东西可提交）。
    collect: true,
  }
}

/**
 * 可以「从这一站续跑」吗。
 *
 * 只覆盖 ⑤ 改代码 / ⑥ 验证 / ⑦ 提交这三站，理由分别是：
 * - ①–④ 没有「进度」可续：读表格、定位仓库、建工作区、建会话都是秒级的准备动作，
 *   重做一遍比「续」还便宜，而工作区/会话没建起来时根本没有可续的东西；
 * - ⑧ 回填 / ⑨ 通知**走不到这条路**：那两站倒下时票已经是 `done`，
 *   由 `pendingEffects` 在下次启动时补做，`resetByHuman` 根本不接受 `done`
 *   （只接受 failed / needs-info / gone）。真要从那里续，得先有一份
 *   「已经提交了什么」的记录，而那条记录在 `pendingEffects.writeBack` 里、
 *   不在执行器的入参里 —— 硬塞会变成「续跑时重新提交一次」。
 *
 * @param {string | undefined} station
 * @returns {boolean}
 */
export function canResumeFrom (station) {
  // 直接复用 resumePlanOf 的判据，不另写一遍比较式：
  // 两处各写一份时，「能不能续」与「续起来做什么」会各自漂移，
  // 面板说「会从 ④ 接着跑」而执行器其实从头开始 —— 两边都不算错，但都在骗人。
  return resumePlanOf(station) !== null
}

/**
 * 一句人话：`⑦ 提交`。
 *
 * 给日志、时间线、通知正文用。`pipeline_status` 的流程带另有自己的排版，
 * 别拿这个去拼带子（会把九个站拉成一长串）。
 */
export function describeResumeFrom (station) {
  const meta = describeStation(station)
  if (!meta) return ''
  return `${meta.no} ${meta.label}`
}

/**
 * 失败属于哪一类 —— 直接回答用户那句「是工单处理问题失败了，还是测试失败了」。
 *
 * 刻意按**人要做的事**分类，不按代码里的阶段名：
 * 人看到「改代码失败」知道要去看 diff，看到「验证失败」知道去看测试输出，
 * 看到「提交失败」知道去查 git 状态 —— 三者要做的动作完全不同。
 *
 * @param {string | undefined} station
 * @returns {string} 六类之一；判不出来时 `'未知'`
 */
export function failureCategoryOf (station) {
  switch (station) {
    case 'discover':
    case 'locate':
    case 'workspace':
    case 'session':
      return '准备阶段'
    case 'editing':
      return '改代码'
    case 'testing':
      return '跑验证'
    case 'mr-opening':
      return '提交'
    case 'writeback':
      return '回填表格'
    case 'notify':
      return '发通知'
    default:
      // 判不出站（老数据，或者失败发生在还没进任何主站之前）。
      // 不能返回空串：面板上会渲染成「卡在哪一步：**」「」。
      return '未知'
  }
}
