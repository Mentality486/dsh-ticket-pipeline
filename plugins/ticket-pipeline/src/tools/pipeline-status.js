/**
 * `pipeline_status` —— 只读查询：现在队列里有什么、卡在哪、为什么卡。
 *
 * 这个工具**不写任何东西、不跑任何票**。它的唯一用途是回答人的三个问题：
 * 1. 我的工单进去了吗？→ 看队列里有没有那条 `recordId`
 * 2. 为什么不动了？→ 看 `phase` 与 `lastError`
 * 3. 该怎么让它动？→ `needs-info` 要补图、`failed` 要把「是否处理」拨走再拨回「处理中」
 *
 * 输出刻意用中文短句而不是 JSON dump：这是给人在对话里看的东西。
 * 需要机器可读的字段也一并放在返回值里（`tickets` 数组），不牺牲程序可用性。
 */

import { defineTool, textBlocks } from './define.js'
import { PHASE_LABEL, TERMINAL } from '../contracts/types.js'
import { describeConfig } from '../core/config.js'
import { summarize } from '../core/store.js'

const PHASE_ADVICE = {
  pending: '排队中，下一轮会轮到它。',
  'worktree-ready': '已经从基准分支切出工作区，下一步开始规划改动。',
  planning: '正在确认要改哪些文件。卡在这里超过一票超时时间就会被判超时。',
  editing: '正在改代码。',
  testing: '正在跑构建与测试。',
  'mr-opening': '改动已经完成，正在开 draft MR。',
  'needs-info': '在等人：通常是截图取不到。补一张图或改「截图」列，再让它重来。',
  done: '已完成，draft MR 已开。等人去看、本地验证后自己提交。',
  skipped: '代码改完、MR 也开了，但构建/测试没跑成（原因见下）。这是合法的成功路径，仍需人工验证。',
  failed: '失败了。要重跑：把「是否处理」先改成别的值、再改回「处理中」，下一轮就会重新入队。',
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
          return {
            enabled: config?.enabled === true,
            counts: {},
            tickets: [],
            config: describeConfig(config),
            text: `没有这条工单的记录：${args.recordId}\n`
              + '（插件从没见过它。可能是「是否处理」还不是「处理中」，或者还没扫到。）',
          }
        }
      } else if (!includeDone) {
        rows = rows.filter((row) => !TERMINAL.includes(row.phase))
      }

      /** @type {Record<string, number>} */
      const counts = {}
      for (const row of options.store.listTickets()) {
        counts[row.phase] = (counts[row.phase] ?? 0) + 1
      }

      // 排队顺序 = pickNext 的顺序：优先级降序 → 发现日期升序 → 入队时间升序。
      const priorityOrder = { high: 3, medium: 2, low: 1 }
      rows = [...rows].sort((a, b) => {
        const pa = priorityOrder[a.priority ?? ''] ?? 0
        const pb = priorityOrder[b.priority ?? ''] ?? 0
        if (pa !== pb) return pb - pa
        const fa = a.foundAt ?? ''
        const fb = b.foundAt ?? ''
        if (fa !== fb) return fa < fb ? -1 : 1
        return (a.enqueuedAt ?? 0) - (b.enqueuedAt ?? 0)
      })

      const shown = rows.slice(0, limit)
      const enabled = config?.enabled === true

      const lines = []
      lines.push(enabled ? '流水线：已开启' : '流水线：总开关是关的（enabled=false），不会自动扫表')
      if (rows.length === 0) {
        lines.push(includeDone ? '库里还没有任何票。' : '没有未收尾的票。')
      } else {
        const summary = Object.entries(counts)
          .map(([phase, count]) => `${PHASE_LABEL[phase] ?? phase} ${count}`)
          .join(' / ')
        lines.push(`全库分布：${summary}`)
        lines.push('')

        for (const row of shown) {
          const title = row.problemSummary ?? summarize(row.description ?? '')
          const projectTag = row.projectId ? `[${row.projectId}] ` : ''
          lines.push(`· ${projectTag}${row.recordId}｜${PHASE_LABEL[row.phase] ?? row.phase}｜${title}`)
          const advice = PHASE_ADVICE[row.phase]
          if (advice) lines.push(`  ${advice}`)
          if (row.module) lines.push(`  模块：${row.module}${row.priority ? `｜优先级：${row.priority}` : ''}`)
          if (row.worktreePath) lines.push(`  工作区：${row.worktreePath}`)
          if (row.mr?.url) lines.push(`  MR：${row.mr.url}${row.mr.draft ? '（draft）' : ''}`)
          if (row.lastError) lines.push(`  最近错误：${row.lastError}`)
          if (row.testDetail) lines.push(`  测试说明：${row.testDetail}`)
          if (row.revisionCount > 1) lines.push(`  这是第 ${row.revisionCount} 版（工单被改过 ${row.revisionCount - 1} 次）`)
        }

        if (rows.length > shown.length) {
          lines.push('')
          lines.push(`还有 ${rows.length - shown.length} 条没列出（用 limit 调大）。`)
        }
      }

      return {
        enabled,
        counts,
        tickets: shown.map((row) => ({
          projectId: row.projectId,
          recordId: row.recordId,
          phase: row.phase,
          problemSummary: row.problemSummary,
          module: row.module,
          priority: row.priority,
          worktreePath: row.worktreePath,
          branch: row.branch,
          mrUrl: row.mr?.url,
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
