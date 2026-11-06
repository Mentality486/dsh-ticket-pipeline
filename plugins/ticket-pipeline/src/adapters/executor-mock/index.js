/**
 * `executor-mock` —— 假装干完活的执行器。
 *
 * 存在的理由：`source-mock` 让**扫描**这一端不碰真实系统，`executor-mock` 让
 * **执行**这一端也不碰。两者一组合，整条内核链路（扫描 → 入队 → 租约 → 阶段 →
 * 结果 → 通知 → 清理）都能离线跑通。
 *
 * 它**不建 worktree、不改代码、不真提交**（返回的 commit 是假的，sha 以 `mock` 开头）
 * —— 所以不要把它当成「流水线验证过了」的证据。真执行器见
 * `executor-agent/`。
 */

import { makeExecResult } from '../../contracts/work-executor.js'
import { PipelineError } from '../../contracts/errors.js'

/**
 * @param {Object} [options]
 * @param {'done'|'skipped'|'failed'} [options.outcome] 想让它怎么收尾
 * @param {number} [options.stepsDelayMs] 每个阶段之间停多久（验证超时与取消）
 * @param {boolean} [options.hang] 永不返回（验证超时链路）
 * @param {string} [options.failMessage]
 * @returns {import('../../contracts/work-executor.js').WorkExecutor & {
 *   setOutcome: (v: 'done'|'skipped'|'failed') => void,
 *   setHang: (v: boolean) => void,
 * }}
 */
export function createMockExecutor (options = {}) {
  let outcome = options.outcome ?? 'done'
  let hang = Boolean(options.hang)
  const stepsDelayMs = Number(options.stepsDelayMs ?? 0)

  /**
   * @param {AbortSignal} signal
   */
  const sleep = (signal) => {
    if (stepsDelayMs <= 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const id = setTimeout(() => {
        cleanup()
        resolve(undefined)
      }, stepsDelayMs)
      const onAbort = () => {
        cleanup()
        reject(new PipelineError('aborted', 'mock：被取消'))
      }
      const cleanup = () => {
        clearTimeout(id)
        signal.removeEventListener('abort', onAbort)
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  return {
    id: 'mock',

    /**
     * @param {import('../../contracts/types.js').Ticket} ticket
     * @param {import('../../contracts/repo-locator.js').LocateResult} target
     * @param {import('../../contracts/work-executor.js').ExecCtx} ctx
     */
    async run (ticket, target, ctx) {
      if (hang) {
        // 真的挂住，等待被取消 —— 超时链路就是靠这个被测出来的。
        await new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new PipelineError('aborted', 'mock：挂住后被取消')), { once: true })
          if (ctx.signal.aborted) reject(new PipelineError('aborted', 'mock：挂住后被取消'))
        })
      }

      const mockChanged = target.candidatePaths.slice(0, 2).map((p) => `${p}（mock 未真改）`)

      await ctx.onPhase('editing')
      await sleep(ctx.signal)
      ctx.log(`mock 执行器：${ticket.recordId}`)

      await ctx.onPhase('testing')
      await sleep(ctx.signal)

      if (outcome === 'failed') {
        await ctx.onPhase('failed')
        return makeExecResult({
          phase: 'failed',
          changedFiles: mockChanged,
          testOutcome: 'failed',
          error: {
            kind: 'internal',
            message: options.failMessage ?? 'mock：模拟执行失败',
            retryable: false,
          },
        })
      }

      await ctx.onPhase('mr-opening')
      await sleep(ctx.signal)

      // 本阶段的交付形态是「工作区检出里的本地提交」，mock 也照这个形状返回：
      // sha 是假的，但字段形状与真执行器一致，内核与通知模板才能一起被验到。
      const commit = {
        sha: `mock${String(ticket.recordId ?? '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 8).padEnd(8, '0')}`,
        branch: ctx.branch ?? '',
        files: mockChanged,
      }

      if (outcome === 'skipped') {
        // 合法的成功路径：提交做了，但验证没跑成 —— 但必须写清楚为什么。
        return makeExecResult({
          phase: 'skipped',
          changedFiles: mockChanged,
          testOutcome: 'skipped',
          testDetail: 'mock 执行器不跑真实构建与测试',
          commit,
          plan: {
            summary: 'mock 计划',
            targetPaths: target.candidatePaths.slice(0, 2),
            approach: '不真改代码，仅用于验证内核链路。',
          },
        })
      }

      return makeExecResult({
        phase: 'done',
        changedFiles: mockChanged,
        testOutcome: 'passed',
        commit,
        plan: {
          summary: 'mock 计划',
          targetPaths: target.candidatePaths.slice(0, 2),
          approach: '不真改代码，仅用于验证内核链路。',
        },
      })
    },

    setOutcome (value) {
      outcome = value
    },

    setHang (value) {
      hang = Boolean(value)
    },
  }
}
