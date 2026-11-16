/**
 * `explore-budget` —— 数一数 agent 到底「读了几次、搜了几次」。
 *
 * ## 为什么需要它
 *
 * 任务书里写着「探索预算 12 次（读文件 + 搜索合计）」，但 2026-11-11 那张跑通的票
 * 实测用了 **109 次 read + 50 次 grep + 10 次 glob = 169 次**。预算是**纯文本劝告**：
 * 模型看见了，但没有任何东西在数、也没有任何东西在它超支时说话。写「12」和写
 * 「多读几次也没关系」在效果上没有区别。
 *
 * 所以要把这个数**真的数出来**，交给看门狗在超支时催它一句。本模块只负责「数」，
 * 不负责「催」——催的时机、话术、以及「已经在改文件了就别再管预算」这些判断
 * 都留在 `index.js` 的 `waitForAgentIdle` 里，那样它们能和停滞监控共用同一个
 * 观察点，也不会出现两套计时器互相打架。
 *
 * ## 为什么从会话事件里数，而不是包一层工具
 *
 * 插件拿不到 agent 的工具调用入口。`run_code` 里的每一次读写都以
 * `tool/ptc-dispatch` 事件落到 `agent.session.log` 上（`data.name` 是真工具名，
 * `data.subCallId` 形如 `call_00_xxx:ptc:1`）。这是**唯一**一个既能看见
 * 「它调了什么工具」、又不需要改宿主的地方。
 *
 * 注意别去数 `tool/call`：那里 `data.name` 恒为 `run_code`，一次 `run_code`
 * 里可以塞十几个 read/grep —— 按它数永远是「调用了 8 次工具」，而实际读了 100 个文件。
 * 2026-11-11 我第一次做性能分析时就踩了这个坑，得出「工具调用不多」的错误结论。
 */

/**
 * 算作「探索」的工具名。
 *
 * 判据是**这次调用是否只为了获取信息**：
 * - `read` / `grep` / `glob` / `search_context` 是标准的三件套加一个检索；
 * - 故意**不包括** `edit` / `write`（那是产出，不是探索）；
 * - 也不包括 `pwsh`：它既可能是 `git status`（信息）、也可能是 `mvn test`（验证），
 *   从事件形状上分不开。宁可少算 —— 少算只让预算松一点，多算会把正经跑验证的
 *   那几轮误判成「还在读」。
 *
 * @type {ReadonlySet<string>}
 */
export const EXPLORATION_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'search_context',
  'list_files',
])

/**
 * 任务书里承诺的预算（次）。
 *
 * 与 `core/prompt.js` 里那段文案是**同一个数**：文案说「25 次」，这里也必须数到 25
 * 就说话，否则又是一份「写着玩的规范」。改这里要同时改文案，自测会盯着。
 *
 * ## 为什么从 12 改到 25（2026-11-16）
 *
 * 12 是一次**猜**出来的数字，装上真机后实测：8 个会话里 8 个都超了 —— 包括那个
 * 只读了 23 次就动手、一把成功的。也就是说这条催办在 100% 的票上都会响，
 * 它已经从「信号」退化成「背景噪音」，而噪音说过一次就没人再听了。
 *
 * 定 25 的依据是「不同目标数」的分布（见下 `countExploration` 为什么不再数调用次数）：
 * 6 个跑到动手的会话，不同目标数是 13 / 20 / 22 / 24 / 26 / 43，中位数 24。
 * 取 25 意味着**约一半的票会被提醒一次**，而不是全部。
 *
 * 「按需求难度分级」是个很自然但**数据不支持**的想法，这里记下来免得再被提一次：
 * 拿票的静态特征（flow 长度、flow 段数、描述长度、截图数）去拟合「首写前探索量」，
 * 相关系数是 0.038 / 0.019 / −0.490 / 无区分度 —— 没有任何预测力。最硬的反证是
 * 同一张票跑两次：`sh-row-82` 84 次 vs 57 次，`sh-row-85` 11 次 vs 39 次，
 * 差 3–4 倍。差异来自模型当轮的状态，不来自需求本身。所以预算只能按**项目**配
 * （仓库大小、技术栈是稳定因素），不能按票配。
 *
 * 项目级覆盖见 `ProjectEntry.exploreBudget`。
 */
export const EXPLORE_BUDGET = 25

/**
 * 一次探索调用的「目标」是什么 —— 决定两次调用算不算在查同一件事。
 *
 * 这是本模块 2026-11-16 改法的核心：**同样的文件读第二遍不该消耗预算**。
 * 实测重复率 55–82%（`sh-row-81` 探索 82 次、真实目标只有 22 个），而这些
 * 重复恰恰是最该被催的那部分。按调用次数计，等于把「读 82 个不同文件」
 * 和「把同一个文件读 4 遍」当成同一件事。
 *
 * 只读参数对象里那几个定位字段，不碰参数里的其它键：`grep` 的 pattern 加不加
 * `-i`、`glob` 的 path 是相对还是绝对，都可能让同一次搜索看起来不同 —— 所以
 * 目标只取「查的是什么」，不取「怎么查的」。
 *
 * @param {string} name 工具名
 * @param {any} args 该次调用的参数（`tool/ptc-dispatch` 的 `data.arguments`）
 * @returns {string} 空串表示认不出目标（调用方会退回按调用计）
 */
export function explorationTarget (name, args) {
  const a = args && typeof args === 'object' ? args : {}
  const pick = (...keys) => {
    for (const key of keys) {
      const value = a[key]
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
    return ''
  }
  if (name === 'read') return pick('file_path', 'path')
  if (name === 'grep') return pick('pattern', 'query')
  if (name === 'glob') return pick('pattern')
  if (name === 'search_context') return pick('query')
  if (name === 'list_files') return pick('path', 'dir')
  return pick('file_path', 'path', 'pattern', 'query')
}

/**
 * 数出会话事件里有多少次探索调用。
 *
 * ## 两个去重层次，别混在一起
 *
 * 1. **同一次调用的多条事件**（按 `subCallId`）：日志里 `-start` 与完成的
 *    `tool/ptc-dispatch` 都会落一条，重复计会让预算提早触发。
 * 2. **不同调用查了同一个目标**（按 `explorationTarget`）：这才是 2026-11-16
 *    加的那层 —— 见上面的实测。
 *
 * 返回的 `total` 是**不同目标的数量**，`calls` 是原始调用次数。两者之差就是
 * 「原地打转」的量，`describeExploration` 会把它说出来。
 *
 * 认不出目标时（参数里没有可用的定位字段）退回按调用计 —— 宁可多算一次，
 * 也别让一条看不见的调用漏掉。
 *
 * @param {any[]} events `agent.session.log`（宿主的事件数组）
 * @returns {{ total: number, calls: number, distinct: number, repeated: number, byTool: Record<string, number> }}
 */
export function countExploration (events) {
  /** @type {Record<string, number>} */
  const byTool = {}
  if (!Array.isArray(events)) return { total: 0, calls: 0, distinct: 0, repeated: 0, byTool }
  /** @type {Set<string>} */
  const seenIds = new Set()
  /** @type {Set<string>} */
  const seenTargets = new Set()
  let calls = 0
  let distinct = 0
  for (const event of events) {
    if (event?.type !== 'tool/ptc-dispatch') continue
    const name = String(event?.data?.name ?? '')
    if (!EXPLORATION_TOOLS.has(name)) continue
    const id = event?.data?.subCallId
    if (typeof id === 'string' && id.length > 0) {
      if (seenIds.has(id)) continue
      seenIds.add(id)
    }
    calls += 1
    byTool[name] = (byTool[name] ?? 0) + 1
    const target = explorationTarget(name, event?.data?.arguments)
    if (target.length === 0) {
      // 认不出目标：当成一次「独立目标」，用调用序号占位，避免被误当成重复。
      distinct += 1
      continue
    }
    const key = `${name}\u0000${target}`
    if (seenTargets.has(key)) continue
    seenTargets.add(key)
    distinct += 1
  }
  return { total: distinct, calls, distinct, repeated: calls - distinct, byTool }
}

/**
 * 把 `{ total, byTool }` 说成一句人话，用在时间线与日志里。
 *
 * 只列真的出现过的工具：写「读 0 次、搜 3 次」纯属噪音。
 *
 * 有重复时说清「总共调了几次、其中多少是不同的目标」——「探索 82 次」和
 * 「探索 82 次（只有 22 个不同目标）」给人的判断完全不同，后者直接指出问题在哪。
 *
 * @param {{ total: number, calls?: number, repeated?: number, byTool: Record<string, number> }} counted
 * @returns {string}
 */
export function describeExploration (counted) {
  const parts = Object.entries(counted.byTool ?? {})
    .filter(([, count]) => Number(count) > 0)
    .map(([name, count]) => `${name} ${count} 次`)
  const detail = parts.length > 0 ? `（${parts.join('、')}）` : ''
  const repeated = Number(counted.repeated ?? 0)
  if (repeated > 0) {
    return `探索 ${counted.total} 次${detail}，其中 ${repeated} 次是在重看同一处`
  }
  return `探索 ${counted.total} 次${detail}`
}
