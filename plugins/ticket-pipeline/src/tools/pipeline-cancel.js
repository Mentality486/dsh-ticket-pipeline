/**
 * `pipeline_cancel` —— 人工取消当前正在跑的那张票。
 *
 * ## 为什么要有这个工具
 *
 * 架构文档 §7.5 承诺「人工中断 → 票落 failed、不发通知、工作区保留」。
 * 内核里 `scheduler.cancelActive()` 早就实现了，但**没有任何入口能调到它** ——
 * 人只能等 40 分钟超时。这就是「cancelActive 零调用方」这条缺陷的由来。
 *
 * ## 取消之后会怎样
 *
 * - 执行器收到 abort 信号后自行抛取消错误；
 * - 内核把票落成 `failed`，`lastError = 'cancelled by user'`；
 * - **不发通知**：人是自己取消的，不需要再被提醒一遍；
 * - 工作区保留（`worktreePath` 不清），方便人直接进去看改到哪了；
 * - 票不会自动重跑。要重跑用 `pipeline_reset`（传它的 recordId），不要去动表格。
 *
 * ## 边界
 *
 * 一次只取消**一张**票（并发恒 1，一轮只有一票在跑）。
 * 空闲时调用返回 `cancelled: false`，不是错误 —— 「没东西可取消」是正常答案。
 */

import { defineTool, textBlocks } from './define.js'

/**
 * @param {Object} options
 * @param {() => boolean} options.cancelActive 内核的人工取消入口
 * @returns {Record<string, unknown>}
 */
export function createPipelineCancelTool (options) {
  return defineTool({
    name: 'pipeline_cancel',
    description:
      '人工取消当前正在跑的那一张工单（并发恒 1，一轮只有一票在跑）。'
      + '取消后该票落成 failed、不发通知、工作区保留，'
      + '要重跑用 pipeline_reset（传它的 recordId）。'
      + '当前没有票在跑时返回 cancelled=false（不是错误）。',
    parameters: {},
    // 机器可读字段放在返回值里，给人看的文本在 `text` 字段。
    // schema 只声明 object 根：DSH 工具的 JSON Schema 子集不支持 `type` 数组、
    // 也不支持 `minimum`/`maximum`，所以这里不细抠字段类型。
    outputSchema: { type: 'object' },
    render: (value) => textBlocks(value.text),
    async execute (_args, exec) {
      void exec

      const cancelled = options.cancelActive() === true

      const lines = []
      if (cancelled) {
        lines.push('已发出取消信号：正在跑的那张票会中止。')
        lines.push('它会落成 failed（原因：你取消的），不给你发通知，工作区保留。')
        lines.push('要让它重跑：用 pipeline_reset 带上这张票的 recordId。')
        lines.push('（另一条路是去表格里把「是否处理」拨走再拨回「处理中」，但那条路会重做一遍并覆盖旧回填，一般不推荐。）')
      } else {
        lines.push('当前没有票在跑，没有可取消的东西。')
        lines.push('想马上推进一轮，用 pipeline_scan。')
      }

      return {
        cancelled,
        text: lines.join('\n'),
      }
    },
  })
}
