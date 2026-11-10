/**
 * `pipeline_scan` —— 手动推一轮。
 *
 * 轮询是主入口（`Config.pollIntervalMinutes`），但自动化系统必须有一个「我现在就想跑一次」
 * 的开关：第一次配置完要验证、出问题了要知道卡在哪、不想等三分钟的时候要能催。
 *
 * 这个工具**不绕过单飞**：内核正在跑时就返回 `already-running`，不会叠第二轮。
 * 它也不改 `enabled` —— 总开关关着的时候返回 `disabled`，要开就改配置。
 *
 * ⚠️ 为什么返回前要先自己查一次，而不是等 `tick()` 告诉答案：
 * `tick()` 里「跑一张票」可能要几十秒到 40 分钟，同步等它会让宿主工具通道超时、
 * 报 not lossless JSON（生产实锤过，见下方注释）。所以执行必须 fire-and-forget。
 * 但 fire-and-forget 拿不到 `tick()` 的返回值 —— 于是「正在跑」「总开关关着」这两种
 * **在按下那一刻就能知道**的结果，改成触发前直接查（`isRunning` / `getConfig().enabled`），
 * 不启动任何后台工作就如实回报。以前只在文案里承诺 already-running、代码永远返回
 * `triggered`，是文案说了一件代码不会做的事。
 */

import { defineTool, textBlocks } from './define.js'

/**
 * @param {Object} options
 * @param {(opts?: { skipScan?: boolean, signal?: AbortSignal }) => Promise<import('../core/scheduler.js').TickResult>} options.tick 内核的一轮
 * @param {() => boolean} [options.isRunning] 内核是否正在跑一轮（`scheduler.isRunning`）
 * @param {() => { enabled?: boolean }} [options.getConfig] 读当前配置（只用到 `enabled`）
 * @param {(message: string, detail?: unknown) => void} [options.log] 后台失败留痕
 * @returns {Record<string, unknown>}
 */
export function createPipelineScanTool (options) {
  /**
   * 触发前能确定的结果。返回 null 表示「可以真的跑一轮」。
   *
   * @returns {{ status: string, text: string } | null}
   */
  function preflight () {
    // 总开关关着时连后台都不用起：`tick()` 会立刻返回 disabled，白起一个 Promise。
    const enabled = options.getConfig?.()?.enabled
    if (enabled === false) {
      return {
        status: 'disabled',
        text: '总开关 enabled 是关的，这一轮什么都没干，也不会替你把开关打开。\n'
          + '要开始跑，把配置里的 enabled 改成 true（在设置面板「行为」组最上面，或改配置文件后重启宿主）。',
      }
    }
    if (options.isRunning?.() === true) {
      return {
        status: 'already-running',
        text: '上一轮还没跑完，这次不叠加。\n'
          + '一轮最多跑一票，连点不会加速；等它结束后再触发，或用 pipeline_status 看它现在停在第几站。',
      }
    }
    return null
  }

  return defineTool({
    name: 'pipeline_scan',
    description:
      '立刻让工单流水线扫一轮：拉取工单源的新变化、把新票入队、最多跑一张票、清理过期工作区。'
      + '注意一轮最多跑一票（并发恒 1），所以连点两次不会加速；正在跑时返回 already-running。'
      + '总开关 enabled 关着时返回 disabled，本工具不会替你打开它。'
      + '本工具不等待这一轮结束（跑一张票可能几十分钟）：触发后立刻返回，结果用 pipeline_status 查。',
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
      // 先查「已经能确定的那两种结果」：不发后台任务、如实回报。
      const blocked = preflight()
      if (blocked !== null) {
        return {
          status: blocked.status,
          scan: null,
          ran: null,
          cleaned: false,
          text: blocked.text,
        }
      }

      // 把工具的取消信号一路递进内核：取消 = 「别再扫了、别再动票了」，
      // 而不是「只让调用方收不到结果」。内核在扫描阶段把它转给每个 source.scan。
      //
      // fire-and-forget：tick 里「跑一张票」可能要几十秒到 40 分钟（超时上限），
      // 同步等它会让宿主工具通道超时、报 not lossless JSON（生产实锤过）。
      // 所以这里只触发一轮、立刻返回；跑完的结果用 pipeline_status 查。
      void options.tick({ skipScan: args.skipScan === true, signal: exec?.signal }).catch((error) => {
        // 后台失败没人接：只静默吞掉等于「点了没反应」，人永远查不出为什么。
        // 工具通道已经返回了，所以这里只能靠日志留痕（不打断调用方）。
        options.log?.('后台一轮流水线失败', { reason: error instanceof Error ? error.message : String(error) })
      })

      return {
        status: 'triggered',
        scan: null,
        ran: null,
        cleaned: false,
        text: '已触发一轮流水线，后台执行中。\n'
          + '扫描工单源几秒，跑一张票可能几十秒到几十分钟。\n'
          + '稍等片刻用 pipeline_status 查看进度与结果；正在跑时再触发会返回 already-running。',
      }
    },
  })
}

// ── 原同步等待实现保留为注释备查 ──
// 不要改回同步：宿主工具通道会超时。真需要「等这一轮跑完再说话」的，
// 让调用方触发后自己轮询 pipeline_status（它有 status 的机器可读字段）。
/*
  const result = await options.tick({ skipScan: args.skipScan === true, signal: exec?.signal })

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
    case 'aborted':
      lines.push('这一轮被取消了：扫描中途停下，没跑票，票面状态没有被动过。')
      lines.push(`取消前已处理：新票 ${result.scan.created}，修订 ${result.scan.updated}，退役 ${result.scan.disappeared}，复活 ${result.scan.revivals}。`)
      if (result.ran) {
        lines.push(`本轮在取消前已经跑完了 ${result.ran.recordId}，现在停在 ${result.ran.phase}。`)
      }
      if (result.cleaned) lines.push('另外清掉了一个过期的工作区（清理不受取消影响）。')
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
*/
// ── 原同步实现结束 ──
