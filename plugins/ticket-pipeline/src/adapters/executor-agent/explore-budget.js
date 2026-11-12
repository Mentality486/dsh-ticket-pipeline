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
 * 与 `core/prompt.js` 里那段文案是**同一个数**：文案说「12 次」，这里也必须数到 12
 * 就说话，否则又是一份「写着玩的规范」。改这里要同时改文案，自测会盯着。
 */
export const EXPLORE_BUDGET = 12

/**
 * 数出会话事件里有多少次探索调用。
 *
 * 按 `subCallId` 去重：同一次子调用在日志里可能出现多条（`-start` 与完成的
 * `tool/ptc-dispatch`），重复计会让预算提早触发。拿不到 id 的就不去重 ——
 * 那种事件形状没见过，宁可多算一次也别漏掉一条。
 *
 * @param {any[]} events `agent.session.log`（宿主的事件数组）
 * @returns {{ total: number, byTool: Record<string, number> }}
 */
export function countExploration (events) {
  /** @type {Record<string, number>} */
  const byTool = {}
  if (!Array.isArray(events)) return { total: 0, byTool }
  /** @type {Set<string>} */
  const seen = new Set()
  let total = 0
  for (const event of events) {
    if (event?.type !== 'tool/ptc-dispatch') continue
    const name = String(event?.data?.name ?? '')
    if (!EXPLORATION_TOOLS.has(name)) continue
    const id = event?.data?.subCallId
    if (typeof id === 'string' && id.length > 0) {
      if (seen.has(id)) continue
      seen.add(id)
    }
    byTool[name] = (byTool[name] ?? 0) + 1
    total += 1
  }
  return { total, byTool }
}

/**
 * 把 `{ total, byTool }` 说成一句人话，用在时间线与日志里。
 *
 * 只列真的出现过的工具：写「读 0 次、搜 3 次」纯属噪音。
 *
 * @param {{ total: number, byTool: Record<string, number> }} counted
 * @returns {string}
 */
export function describeExploration (counted) {
  const parts = Object.entries(counted.byTool ?? {})
    .filter(([, count]) => Number(count) > 0)
    .map(([name, count]) => `${name} ${count} 次`)
  if (parts.length === 0) return `探索 ${counted.total} 次`
  return `探索 ${counted.total} 次（${parts.join('、')}）`
}
