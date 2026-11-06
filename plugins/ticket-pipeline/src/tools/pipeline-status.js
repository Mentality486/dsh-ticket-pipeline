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
import { PHASE_LABEL, TERMINAL } from '../contracts/types.js'
import { describeConfig } from '../core/config.js'
import { foundAtSortKey, summarize } from '../core/store.js'

const PHASE_ADVICE = {
  pending: '排队中，下一轮会轮到它。',
  'worktree-ready': '已经确定改代码落在哪个目录上，下一步开始规划改动。',
  planning: '正在确认要改哪些文件。卡在这里超过一票超时时间就会被判超时。',
  editing: '正在改代码。',
  testing: '正在跑构建与测试。',
  'mr-opening': '改动已经完成，正在工作区检出里做本地提交。',
  'needs-info': '在等人：通常是截图取不到。补一张图或改「截图」列，再让它重来。',
  done: '已完成，改动已提交到项目工作区的检出里（本地提交，不是远端 MR）。去检出里 git show 就能 review。',
  skipped: '代码改完、也提交了，但构建/测试没跑成（原因见下）。这是合法的成功路径，仍需人工验证。',
  failed: '失败了。要重跑就用 pipeline_reset（传它的 recordId）；失败不会自动重试，超时也一样。',
  gone: '表格里这一行已经删掉了，静默退役。',
}

/**
 * @param {Object} options
 * @param {import('../core/store.js').TicketStore} options.store
 * @param {() => Record<string, unknown>} options.getConfig 取当前生效的配置
 * @returns {Record<string, unknown>}
 */
export function createPipelineStatusTool (options) {
  return defineTool({
    name: 'pipeline_status',
    description:
      '只读查看工单流水线的状态：有哪些票在队列里、各自停在哪个阶段、最近一次错误是什么。'
      + '不触发任何动作，不影响任何票。要推进就改用 pipeline_scan。',
    parameters: {
      recordId: {
        type: 'string',
        description: '只看这一条工单（飞书 record_id）。不填则列出全部非终态票。',
      },
      includeDone: {
        type: 'boolean',
        description: '是否把已收尾（done / skipped / failed / gone）的票也列出来。默认只看没跑完的。',
        default: false,
      },
      limit: {
        type: 'integer',
        description: '最多列多少条。默认 20。',
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
      const config = options.getConfig()
      const limit = typeof args.limit === 'number' ? args.limit : 20
      const includeDone = args.includeDone === true

      let rows = options.store.listTickets()

      if (typeof args.recordId === 'string' && args.recordId.length > 0) {
        rows = rows.filter((row) => row.recordId === args.recordId)
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
            tickets: [],
            config: describeConfig(config),
            text: `没有这条工单的记录：${args.recordId}\n`
              + '（插件从没见过它。可能是「是否处理」还不是「处理中」，或者还没扫到。）',
          }
        }
      } else if (!includeDone) {
        rows = rows.filter((row) => !TERMINAL.includes(row.phase))
      }

      // 「本次筛选」这个口径只在真的筛过的时候才显示，否则它就等于全库，白占一行。
      const filteredScope = (typeof args.recordId === 'string' && args.recordId.length > 0) || !includeDone

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
      // 比较逻辑直接复用 store 的那两个函数，不在这里再写一份：
      // 写两份就会在「没有发现日期时排哪儿」这种细节上分道扬镳。
      const priorityOrder = { high: 3, medium: 2, low: 1 }
      rows = [...rows].sort((a, b) => {
        const pa = priorityOrder[a.priority ?? ''] ?? 0
        const pb = priorityOrder[b.priority ?? ''] ?? 0
        if (pa !== pb) return pb - pa
        const fa = foundAtSortKey(a)
        const fb = foundAtSortKey(b)
        if (fa !== fb) return fa < fb ? -1 : 1
        return (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0)
      })

      const shown = rows.slice(0, limit)
      const enabled = config?.enabled === true

      const lines = []
      lines.push(enabled ? '流水线：已开启' : '流水线：总开关是关的（enabled=false），不会自动扫表')
      const formatDistribution = (source) => {
        const entries = Object.entries(source)
        if (entries.length === 0) return '（无）'
        return entries.map(([phase, count]) => `${PHASE_LABEL[phase] ?? phase} ${count}`).join(' / ')
      }
      // 先把两个口径都写上，再决定列不列票：这样「筛选结果为空」时，
      // 人也还能看到全库其实有多少票 —— 否则只剩一句「没有未收尾的票」，看不出是全空了还是筛空了。
      lines.push(`全库分布：${formatDistribution(total)}`)
      if (filteredScope) lines.push(`本次筛选：${formatDistribution(filtered)}`)
      lines.push('')

      if (rows.length === 0) {
        lines.push(filteredScope
          ? '这次筛选一条都没命中（全库分布见上）。'
          : (includeDone ? '库里还没有任何票。' : '没有未收尾的票。'))
      } else {
        for (const row of shown) {
          const title = row.problemSummary ?? summarize(row.description ?? '')
          const projectTag = row.projectId ? `[${row.projectId}] ` : ''
          lines.push(`· ${projectTag}${row.recordId}｜${PHASE_LABEL[row.phase] ?? row.phase}｜${title}`)
          const advice = PHASE_ADVICE[row.phase]
          if (advice) lines.push(`  ${advice}`)
          if (row.module) lines.push(`  模块：${row.module}${row.priority ? `｜优先级：${row.priority}` : ''}`)
          if (row.worktreePath) lines.push(`  改代码目录：${row.worktreePath}`)
          if (row.commit?.sha) {
            lines.push(`  本地提交：${String(row.commit.sha).slice(0, 12)}${row.commit.branch ? ` @ ${row.commit.branch}` : ''}`)
          }
          if (row.mr?.url) lines.push(`  MR：${row.mr.url}${row.mr.draft ? '（draft）' : ''}`)
          if (row.sessionId) lines.push(`  处理会话：${row.sessionId}（保留在工作区名下，可在会话列表里点进去继续问）`)
          // 回填只在 done/skipped 后发生，写没写成是「表格里那行现在长什么样」的唯一线索。
          if (row.writeBack) {
            lines.push(row.writeBack.written
              ? `  回填表格：成功${Array.isArray(row.writeBack.fields) && row.writeBack.fields.length > 0 ? `（${row.writeBack.fields.join('、')}）` : ''}`
              : `  回填表格：没写成 —— ${row.writeBack.note ?? '原因未记录'}`)
          }
          if (row.lastError) lines.push(`  最近错误：${row.lastError}`)
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
        }

        if (rows.length > shown.length) {
          lines.push('')
          lines.push(`还有 ${rows.length - shown.length} 条没列出（用 limit 调大）。`)
        }
      }

      return {
        enabled,
        // counts = 全库口径（老字段名不变，避免调用方炸）；filteredCounts = 本次筛选口径。
        counts: total,
        filteredCounts: filtered,
        tickets: shown.map((row) => ({
          projectId: row.projectId,
          recordId: row.recordId,
          phase: row.phase,
          problemSummary: row.problemSummary,
          module: row.module,
          priority: row.priority,
          worktreePath: row.worktreePath,
          branch: row.branch,
          commitSha: row.commit?.sha,
          mrUrl: row.mr?.url,
          sessionId: row.sessionId,
          writeBack: row.writeBack,
          // 只暴露「还有没有待补做」，不把整份 writeBack 输入摊给调用方：
          // 那是内部载荷，对调用方没有意义，还会把工具输出撑大。
          pendingEffects: row.pendingEffects
            ? { writeBack: Boolean(row.pendingEffects.writeBack), notify: Boolean(row.pendingEffects.notify) }
            : undefined,
          lastError: row.lastError,
          testDetail: row.testDetail,
          revisionCount: row.revisionCount,
          attempt: row.attempt,
        })),
        config: describeConfig(config),
        text: lines.join('\n'),
      }
    },
  })
}
