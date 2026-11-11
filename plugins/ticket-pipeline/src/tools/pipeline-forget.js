/**
 * `pipeline_forget` —— 把一张票**从本地存储里删掉**（不是重跑，是清掉记录）。
 *
 * ## 为什么要有这个工具
 *
 * 票据只增不删：`done` / `skipped` / `gone` 的票会永远躺在存储里。这在设计上是对的
 * —— `pipeline_status` 的历史、`pendingEffects` 的补偿、同票幂等都依赖那些行还在。
 * 但跑上几个月之后，运行页签一打开就是几百行早验收完的票，人看着一屏历史却
 * 没有任何清理手段。用户原话：「运行页面的历史 重试报错 **也删除不了**」。
 *
 * 所以补这个入口：**只删本地这条记录**。
 *
 * ## 它刻意不做什么
 *
 * - **不碰工单表**：那一行还在，回不回填、要不要留档是人自己的事。
 *   面板的确认框与这里的返回文案都必须把这一点说出来 —— 人点「删除」时
 *   脑子里想的常常是「连它做的事一起别要了」，那是另外三件事，这里一件都不做。
 * - **不回滚代码**：提交还在分支上，工作区还留着。真要撤销得自己 git revert。
 * - **不删工作区**：工作区由 `worktreeRetentionHours` 那套过期清理负责。
 * - **不动水位**：`seen` 里还留着这个 recordId，所以下一轮扫描不会把它当新票
 *   重新收进来（`created` 只在「第一次看见」时才推）。只有人去表格里把它拨离
 *   「处理中」再拨回来，才会重新入队 —— 那本来就是「我要重做一遍」的明确动作。
 *
 * ## 边界
 *
 * - **不删正在跑的票**：`phase` 不在终态、也不在「等人接手」的那几种时拒绝。
 *   删一张正在跑的票会让 `runOne` 的 finally 摸到一条不存在的记录，那条路径
 *   不值得为「清理历史」这个诉求去闯。
 * - **同名 recordId 冲突时不猜**：多项目可能撞同一个 record_id，此时要求补 `projectId`。
 * - 参数缺失、查不到、状态不对都返回 `forgotten:false` 而不是抛错 —— 这些都是正常问答。
 */

import { defineTool, textBlocks } from './define.js'
import { PHASE_LABEL, TERMINAL } from '../contracts/types.js'

/**
 * 可以被删掉记录的阶段：终态四种 + 「等人补信息」。
 *
 * 为什么放过 `needs-info`：那是「跑不下去、等人接手」的收尾态，与终态一样
 * 不会再自己动；想留着就留着，想清掉也不会有并发问题。
 * 反过来 `pending` / `planning` / `editing` … 都在队列或执行中，一律拒绝。
 *
 * 导出它是因为 `pipeline-status.js` 也要用同一份名单算 `canForget` ——
 * 面板只读那个布尔。两处各写一份名单，迟早出现「面板给了删除按钮、
 * 工具却说不让删」的分家。
 */
export const FORGETTABLE_PHASES = Object.freeze([...TERMINAL, 'needs-info'])

/**
 * @param {string} phase
 */
export function canForget (phase) {
  return FORGETTABLE_PHASES.includes(phase)
}

/**
 * @param {string} phase
 */
function phaseName (phase) {
  return PHASE_LABEL[phase] ?? phase
}

/**
 * @param {Object} options
 * @param {import('../core/store.js').TicketStore} options.store
 * @returns {Record<string, unknown>}
 */
export function createPipelineForgetTool (options) {
  return defineTool({
    name: 'pipeline_forget',
    description:
      '把一张工单的**本地记录**删掉（清理历史用）。不碰工单表里那一行、不回滚代码、不删工作区。'
      + '只对已收尾的票生效（done / skipped / failed / gone / needs-info）；排队中或正在跑的票拒绝删除。'
      + '删掉之后下一轮扫描**不会**把它当新票收进来（水位还记着它），'
      + '只有在表格里把它拨离「处理中」再拨回来才会重新入队。'
      + '想让它再跑一遍请用 pipeline_reset，不要用这个。',
    parameters: {
      recordId: {
        type: 'string',
        description: '要删掉本地记录的那张工单标识（飞书 record_id）。必填。',
        required: true,
      },
      projectId: {
        type: 'string',
        description: '工单所属项目名（projects[].name）。只有同名 recordId 会冲突时才需要传。',
      },
    },
    outputSchema: { type: 'object' },
    render: (value) => textBlocks(value.text),
    async execute (args, exec) {
      void exec
      // 算结果的部分抽到 collectForget：面板的「删除记录」按钮走 Remote →
      // 同一个函数，避免面板与工具两套判定。
      return collectForget(options, args)
    },
  })
}

/**
 * `pipeline_forget` 的算结果层：不碰 defineTool、不碰渲染，纯逻辑 + 返回对象。
 *
 * @param {{ store: import('../core/store.js').TicketStore }} options
 * @param {{ recordId?: unknown, projectId?: unknown }} args
 * @returns {Promise<Record<string, unknown>>}
 */
export async function collectForget (options, args) {
  const safeArgs = args && typeof args === 'object' ? args : {}
  const recordId = typeof safeArgs.recordId === 'string' ? safeArgs.recordId.trim() : ''
  const projectId = typeof safeArgs.projectId === 'string' ? safeArgs.projectId.trim() : ''

  if (recordId.length === 0) {
    return {
      forgotten: false,
      reason: 'missing-recordId',
      text: '请告诉我 recordId（飞书工单的 record_id），我才知道要删哪一条记录。',
    }
  }

  let rows = options.store.listTickets().filter((row) => row.recordId === recordId)
  if (projectId.length > 0) rows = rows.filter((row) => row.projectId === projectId)

  if (rows.length === 0) {
    const where = projectId.length > 0 ? `项目 ${projectId} 下` : ''
    return {
      forgotten: false,
      reason: 'not-found',
      recordId,
      text: `${where}没有 recordId 为 ${recordId} 的记录（可能已经被删掉了）。`,
    }
  }

  if (rows.length > 1) {
    const candidates = rows.map((row) => `· 项目 ${row.projectId ?? '(空)'}｜${phaseName(row.phase)}`)
    return {
      forgotten: false,
      reason: 'ambiguous',
      recordId,
      candidates: rows.map((row) => ({ projectId: row.projectId, phase: row.phase })),
      text: `recordId ${recordId} 在多个项目里都存在，我不猜是哪一个：\n`
        + candidates.join('\n') + '\n'
        + '请带上 projectId（项目名）再调一次。',
    }
  }

  const row = rows[0]
  if (!canForget(row.phase)) {
    return {
      forgotten: false,
      reason: 'not-forgettable',
      recordId,
      projectId: row.projectId,
      phase: row.phase,
      text: `这张工单现在是「${phaseName(row.phase)}」，还在队列里或正在跑，不能删记录。\n`
        + '要停掉正在跑的那张用 pipeline_cancel；想让它别再自动跑，把总开关关掉。\n'
        + '等它收尾之后再回来删。',
    }
  }

  const removed = await options.store.forgetTicket(row.key)
  if (!removed) {
    return {
      forgotten: false,
      reason: 'rejected',
      recordId,
      projectId: row.projectId,
      phase: row.phase,
      text: `存储拒绝删除（recordId ${recordId}）。可能是这一行刚好被别处改动或删掉了。`,
    }
  }

  return {
    forgotten: true,
    reason: 'ok',
    recordId,
    projectId: row.projectId,
    phase: row.phase,
    text: `已删除：${row.projectId ? `[${row.projectId}] ` : ''}${recordId}（原来是「${phaseName(row.phase)}」）的本地记录。\n`
      + '工单表里那一行还在、代码提交与工作区都没动 —— 这里删的只是插件自己的记录。\n'
      + '下一轮扫描不会把它重新收进来（水位还记着它）。',
  }
}
