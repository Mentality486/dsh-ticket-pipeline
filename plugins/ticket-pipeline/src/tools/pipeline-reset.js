/**
 * `pipeline_reset` —— 人工把一张卡住的票放回队列，让它重新跑一遍。
 *
 * ## 为什么要有这个工具
 *
 * `store.resetByHuman(key)` 早就实现了（见 `core/store.js` 的 resetByHuman），
 * 它承担一个很重的位置：**这是 failed 票唯一的重开路径**（用户拍板：超时不自动重试）。
 * 但在此之前没有任何工具能调到它 —— 架构文档、`pipeline_status` 的文案、
 * 取消后的提示都在说「把『是否处理』拨走再拨回『处理中』」，而那条路要人去表格里手工操作，
 * 生产里根本点不到。缺的入口就是这个工具：不碰表格，直接按 recordId 重开。
 *
 * ## 它会改什么
 *
 * 只改存储里那一行的几个字段（`phase` → `pending`，`attempt` 归零，
 * 清掉 `lastError` / `finishedAt`，`enqueuedAt` 重置成现在）。
 * 因此下一轮 `pickNext` 会重新选中它，和一张新票完全一样地排队。
 *
 * ## 边界
 *
 * - **只对 `failed` / `needs-info` / `gone` 三种状态生效**：这三种是「跑不下去、等人接手」的收尾态。
 *   `pending` 已经在队列里，`done` / `skipped` 是验收过的成果，`planning` 之类是正在跑 —— 一律拒绝，
 *   否则这个工具就成了「重做已完成工作」的按钮。
 * - **不新建工作区、不取消正在跑的票**：它是把一张停下来的票排回队尾，
 *   不是加速器。想马上跑一轮用 `pipeline_scan`；想掐掉在跑的那张用 `pipeline_cancel`。
 * - **同名 recordId 冲突时不猜**：多项目可能撞同一个 record_id，此时要求补 `projectId`。
 * - 参数缺失、查不到、状态不对都返回 `reset:false` 而不是抛错 —— 这些都是正常问答，不是故障。
 */

import { defineTool, textBlocks } from './define.js'
import { PHASE_LABEL } from '../contracts/types.js'
import { describeResumeFrom, failureCategoryOf, isMainStation } from '../core/station.js'

/** 可以被人工重开的阶段。与 `store.resetByHuman` 的判定必须保持一致。 */
export const RESETTABLE_PHASES = ['failed', 'needs-info', 'gone']

/**
 * @param {import('../core/store.js').TicketStore} store
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
export function createPipelineResetTool (options) {
  return defineTool({
    name: 'pipeline_reset',
    description:
      '把一张卡住的工单（failed / needs-info / gone）放回队列，让它重新跑一遍。'
      + '只对这三种状态生效；done / skipped 这类验收结果和正在跑的票都不动。'
      + '跑之前建议先用 pipeline_status 确认 recordId 与当前阶段。'
      + '这是重开入口里**推荐**的那一条：'
      + 'failed 票不会自动重试，没有这个工具就只能去表格里手工拨（而拨表格会整票重做一遍、覆盖旧回填）。',
    parameters: {
      recordId: {
        type: 'string',
        description: '要重开的工单标识（飞书 record_id）。必填。',
        required: true,
      },
      projectId: {
        type: 'string',
        description: '工单所属项目名（projects[].name）。只有同名 recordId 会冲突时才需要传。',
      },
      from: {
        type: 'string',
        description: '从哪一站开始。缺省（推荐）是「从失败的那一站接着跑」，只重做没做成的那一步；'
          + '填 begin 才是整票从头跑一遍。',
      },
    },
    // 机器可读字段放在返回值里，给人看的文本在 `text` 字段。
    // schema 只声明 object 根：DSH 工具的 JSON Schema 子集不支持 `type` 数组、
    // 也不支持 `minimum`/`maximum`，所以这里不细抠字段类型。
    outputSchema: { type: 'object' },
    render: (value) => textBlocks(value.text),
    async execute (args, exec) {
      void exec
      // 算结果的部分抽到 collectReset，Remote（ticketPipeline.reset()）必须调同一份，
      // 否则面板上的「重跑」和对话里 / 工具里的 pipeline_reset 会出现两套判定。
      return collectReset(options, args)
    },
  })
}

/**
 * `pipeline_reset` 的算结果层：不碰 defineTool、不碰渲染，纯逻辑 + 返回对象。
 *
 * 面板「运行」页签的「重跑」按钮走 `ticketPipeline.reset()` → 这里，
 * 与工具调用是同一条实现（工单 #16 的硬约束：绝不复制工具实现）。
 *
 * @param {{ store: import('../core/store.js').TicketStore }} options
 * @param {{ recordId?: unknown, projectId?: unknown }} args
 * @returns {Promise<Record<string, unknown>>}
 */
export async function collectReset (options, args) {
  const safeArgs = args && typeof args === 'object' ? args : {}
  const recordId = typeof safeArgs.recordId === 'string' ? safeArgs.recordId.trim() : ''
  const projectId = typeof safeArgs.projectId === 'string' ? safeArgs.projectId.trim() : ''

  if (recordId.length === 0) {
    return {
      reset: false,
      reason: 'missing-recordId',
      text: '请告诉我 recordId（飞书工单的 record_id），我才知道要重开哪一张。\n'
        + '不知道是哪一张的话，先用 pipeline_status 看看队列里都有什么。',
    }
  }

  let rows = options.store.listTickets().filter((row) => row.recordId === recordId)
  if (projectId.length > 0) rows = rows.filter((row) => row.projectId === projectId)

  if (rows.length === 0) {
    const where = projectId.length > 0 ? `项目 ${projectId} 下` : ''
    return {
      reset: false,
      reason: 'not-found',
      recordId,
      text: `${where}没有 recordId 为 ${recordId} 的工单记录。\n`
        + '（插件从没见过它：可能「是否处理」还不是「处理中」，或者还没扫到。'
        + '用 pipeline_status 确认一下。想马上扫一轮就用 pipeline_scan。）',
    }
  }

  if (rows.length > 1) {
    // 多项目撞了同一个 record_id。猜一个就可能把 A 项目的票当成 B 项目的重开，
    // 所以这里只摆事实，让人补 projectId。
    const candidates = rows.map((row) => `· 项目 ${row.projectId ?? '(空)'}｜${phaseName(row.phase)}`)
    return {
      reset: false,
      reason: 'ambiguous',
      recordId,
      candidates: rows.map((row) => ({ projectId: row.projectId, phase: row.phase })),
      text: `recordId ${recordId} 在多个项目里都存在，我不猜是哪一个：\n`
        + candidates.join('\n') + '\n'
        + '请带上 projectId（项目名）再调一次。',
    }
  }

  const row = rows[0]
  if (!RESETTABLE_PHASES.includes(row.phase)) {
    return {
      reset: false,
      reason: 'not-resettable',
      recordId,
      projectId: row.projectId,
      phase: row.phase,
      text: `这张工单现在是「${phaseName(row.phase)}」，不在可重开的范围内。\n`
        + '这个工具只对 failed（失败）、needs-info（等人补信息）、gone（表格行已删）三种生效：'
        + '它们是「跑不下去、等人接手」的收尾态。\n'
        + '排队中或正在跑的票本来就会接着走；done / skipped 是已经验收过的结果，重开等于重做一遍。\n'
        + '真要重做（连内容一起）：直接改表格里这一行，把「是否处理」拨回「处理中」——那条路会覆盖旧的回填结果。\n'
        + '想确认它到底停在哪、为什么停，用 pipeline_status。',
    }
  }

  // 从哪一站接着跑。默认「从失败那一站续」，`from: 'begin'` 才整票重来。
  //
  // 为什么默认改成续跑（2026-11-17 用户要求）：「不要重新跑 应该是修复只针对失败的
  // 那一步进行修复然后接着跑后续的 还在那个失败的会话中继续」。整票从头跑一次要几十分钟
  // （⑤ 让 agent 把几十个文件重新读一遍），而失败在 ⑦ 提交时那些活早就干完了。
  //
  // 判据只看「认不认得上一轮倒在哪」，不看用户的措辞：认不出（老数据）就老实从头跑 ——
  // 猜错方向（从中间续）比慢更糟，它会把上一轮的半成品当成已完成。
  const fromRaw = typeof safeArgs.from === 'string' ? safeArgs.from.trim().toLowerCase() : ''
  const restartFromBegin = fromRaw === 'begin' || fromRaw === 'start' || fromRaw === 'scratch'
  if (fromRaw.length > 0 && !restartFromBegin && !isMainStation(fromRaw)) {
    return {
      reset: false,
      reason: 'bad-from',
      recordId,
      text: `from 只认主站的 node id（discover / locate / workspace / session / editing / testing / mr-opening），`
        + `或者 begin（整票重来），不认「${fromRaw}」。\n`
        + '一般不填就好：缺省就是从失败的那一站接着跑。',
    }
  }
  const resumeTarget = restartFromBegin
    ? null
    : (row.failedStation ?? undefined)
  // 上一轮卡在哪一类事上（改代码 / 跑验证 / 提交 …）。只用于文案，
  // 但它是用户那句「是工单处理问题失败了 还是测试失败了」的直接回答。
  // 只认真正的主站：`failedStation` 可能是老数据里留下的怪值，那时宁可不提这一句。
  const failCategory = isMainStation(resumeTarget) ? failureCategoryOf(resumeTarget) : ''
  const ok = await options.store.resetByHuman(row.key, restartFromBegin ? { resumeFrom: null } : {})
  if (!ok) {
    // resetByHuman 只有「记录不见了」或「状态在读到与写入之间变了」才会返回 false。
    return {
      reset: false,
      reason: 'rejected',
      recordId,
      projectId: row.projectId,
      phase: row.phase,
      text: `存储拒绝了这次重置（recordId ${recordId}，当前「${phaseName(row.phase)}」）。\n`
        + '可能是这一行刚好被别处改动或删掉了。用 pipeline_status 再看一眼现在的状态。',
    }
  }

  // `resumeTarget` 是「这次真正会从哪跑」：`resetByHuman` 内部对「不传 resumeFrom」
  // 的处理是「按票上记的失败站走」，所以这里的值要和它算的一致，文案才不会骗人。
  const willResume = !restartFromBegin && typeof resumeTarget === 'string' && resumeTarget.length > 0
  const resumeNote = willResume
    ? `下一轮轮询会从「${describeResumeFrom(resumeTarget)}」接着跑，不重做前面已经做完的步骤`
      + (failCategory.length > 0 ? `（上一轮卡在「${failCategory}」）。\n` : '。\n')
      + '它用的还是上一轮那个会话，前面读过的代码、改好的文件都还在。\n'
    : '下一轮轮询会把它当成一张新票重新跑（从头开始）。\n'

  return {
    reset: true,
    reason: 'ok',
    recordId,
    projectId: row.projectId,
    phase: 'pending',
    // 机器可读：面板与 Remote 的调用方靠这两个字段决定要不要提示「这是续跑」
    resumeFrom: willResume ? resumeTarget : null,
    failedStation: typeof row.failedStation === 'string' ? row.failedStation : null,
    text: `已重开：${row.projectId ? `[${row.projectId}] ` : ''}${recordId} 回到队列（阶段改回排队中，重试次数与最近错误已清空）。\n`
      + resumeNote
      + '想立刻推进一轮，用 pipeline_scan。',
  }
}
