/**
 * `pipeline_scan` —— 手动推一轮。
 *
 * 轮询是主入口（`Config.pollIntervalMinutes`），但自动化系统必须有一个「我现在就想跑一次」
 * 的开关：第一次配置完要验证、出问题了要知道卡在哪、不想等三分钟的时候要能催。
 *
 * 这个工具**不绕过单飞**：内核正在跑时就返回 `already-running`，不会叠第二轮。
 * 它也不改 `enabled` —— 总开关关着的时候返回 `disabled`，要开就改配置。
 */

import { defineTool, textBlocks } from './define.js'

/**
 * @param {Object} options
 * @param {() => Promise<import('../core/scheduler.js').TickResult>} options.tick 内核的一轮
 * @returns {Record<string, unknown>}
 */
export function createPipelineScanTool (options) {
  return defineTool({
    name: 'pipeline_scan',
    description:
      '立刻让工单流水线扫一轮：拉取工单源的新变化、把新票入队、最多跑一张票、清理过期工作区。'
      + '注意一轮最多跑一票（并发恒 1），所以连点两次不会加速；正在跑时返回 already-running。'
      + '总开关 enabled 关着时返回 disabled，本工具不会替你打开它。',
    parameters: {
      skipScan: {
        type: 'boolean',
        description: '只处理已在队列里的票，不去拉工单源。排查执行侧问题时可省掉一次远端请求。',
        default: false,
      },
    },
    // 机器可读字段放在返回值里，给人看的文本在 `text` 字段。
    // schema 只声明 object 根：DSH 工具的 JSON Schema 子集不支持 `type` 数组、
    // 也不支持 `minimum`/`maximum`，所以这里不细抠字段类型。
    outputSchema: { type: 'object' },
    render: (value) => textBlocks(value.text),
    async execute (args, exec) {
      const result = await options.tick({ skipScan: args.skipScan === true })
      void exec

      const lines = []
      switch (result.status) {
        case 'disabled':
          lines.push('总开关 enabled 是关的，这一轮什么都没干。')
          lines.push('要开始跑，把配置里的 enabled 改成 true（或在设置面板里打开）。')
          break
        case 'already-running':
          lines.push('上一轮还没跑完，这次不叠加，等它结束。')
          break
        case 'scan-failed':
          lines.push('扫描工单源失败了，本轮不跑票。')
          lines.push(`原因：${result.error ?? '(未提供)'}`)
          lines.push('这是「本轮失败」，不是「没变化」——队列里已有的票不受影响，下一轮会重试。')
          break
        default:
          lines.push('扫描完成。')
          lines.push(`新票 ${result.scan.created}，修订 ${result.scan.updated}，退役 ${result.scan.disappeared}，复活 ${result.scan.revivals}。`)
          if (result.ran) {
            lines.push(`本轮跑了 ${result.ran.recordId}，现在停在 ${result.ran.phase}${result.ran.ok ? '（已收尾）' : '（未收尾）'}。`)
          } else {
            lines.push('本轮没有可跑的票（队列空、或被别的进程租着、或都在等人）。')
          }
          if (result.cleaned) lines.push('顺手清掉了一个过期的工作区。')
          break
      }

      const text = lines.join('\n')
      return {
        status: result.status,
        scan: result.scan,
        ran: result.ran ?? null,
        cleaned: result.cleaned,
        error: result.error,
        text,
      }
    },
  })
}
