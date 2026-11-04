/**
 * `recover.js` —— 启动恢复。
 *
 * 插件随 Harness 进程进出。上一次进程被杀在「改到一半」时，存储里的票还停在
 * `planning` / `editing` / `testing` 这类中间态。恢复**不从头重跑**：
 * 已经建好的工作区接着用，已经开过的 MR 先查一遍再决定要不要开。
 *
 * 三条规则（架构文档 §7.6）：
 * 1. `worktreePath` 还在、`git rev-parse` 通过 → 从当前 phase 接着走
 * 2. `worktreePath` 没了 → 回退到 `worktree-ready` 之前，让执行器重建
 * 3. 分支被删 / 被改 → 不重用，同样回退
 */

import { TERMINAL, canTransition } from '../contracts/types.js'
import { toPipelineError } from '../contracts/errors.js'

/**
 * @typedef {import('./store.js').TicketStore} TicketStore
 * @typedef {import('./store.js').TicketRecordRow} TicketRecordRow
 * @typedef {import('../contracts/types.js').Phase} Phase
 */

/**
 * 每种中间态在「工作区还在」时应该从哪继续。
 *
 * 注意这里不是「跳到下一步」而是「停在本步重做」：
 * agent 上一轮可能一行没改，直接当成改完了会漏活。
 * 让它从当前阶段重新报一遍，比猜「它到底做完了没有」安全。
 */
const RESUME_PHASE = Object.freeze({
  'worktree-ready': 'planning',
  'planning': 'planning',
  'editing': 'planning', // 回到规划：让它重新确认要改什么，避免改一半的残留被当成完成
  'testing': 'testing',
  'mr-opening': 'mr-opening',
})

/**
 * 扫一遍存储，把中间态的票安排回队列。
 *
 * @param {Object} options
 * @param {TicketStore} options.store
 * @param {(path: string) => Promise<boolean>} [options.worktreeExists] 判定工作区是否有效
 * @param {(msg: string, detail?: unknown) => void} [options.log]
 * @returns {Promise<{ resumed: number, reset: number, skipped: number }>}
 */
export async function recoverPending ({ store, worktreeExists, log }) {
  const logInfo = log ?? (() => {})
  let resumed = 0
  let reset = 0
  let skipped = 0

  const active = store.listActive()
  if (active.length === 0) {
    logInfo('启动恢复：没有未完成的票')
    return { resumed, reset, skipped }
  }

  for (const row of active) {
    try {
      // needs-info 不是「跑到一半」，是在等人。别动它。
      if (row.phase === 'needs-info') {
        skipped += 1
        continue
      }

      // pending 已经排着队，不需要恢复逻辑，pickNext 会拿到。
      if (row.phase === 'pending') {
        skipped += 1
        continue
      }

      const pathOk = row.worktreePath
        ? await (worktreeExists ? worktreeExists(row.worktreePath) : Promise.resolve(true))
        : false

      if (!pathOk) {
        // 工作区没了：退回 worktree-ready 之前，让执行器下一轮重建。
        // 不直接回 pending —— 那样会连「上一轮已经定位到哪个文件」都丢掉，
        // 而 worktree-ready 恰好是「建工作区」的入口。
        const target = 'worktree-ready'
        if (canTransition(row.phase, target) || row.phase === 'worktree-ready') {
          await store.setPhase(row.key, target, {
            worktreePath: undefined,
            branch: undefined,
            baseCommit: undefined,
            lastError: '工作区丢失，启动恢复时重建',
          })
          reset += 1
          logInfo('启动恢复：工作区不在，重建', { projectId: row.projectId, recordId: row.recordId, was: row.phase })
        } else {
          // 状态机不允许直接从当前 phase 回到 worktree-ready（比如 mr-opening），
          // 那就往前推一步到 pending，保留已完成的 MR 信息由执行器自己去查重。
          await store.setPhase(row.key, 'pending', {
            worktreePath: undefined,
            branch: undefined,
            baseCommit: undefined,
            lastError: '工作区丢失，启动恢复时重新排队',
          })
          reset += 1
          logInfo('启动恢复：工作区不在，回队列', { projectId: row.projectId, recordId: row.recordId, was: row.phase })
        }
        continue
      }

      const target = RESUME_PHASE[row.phase]
      if (target && canTransition(row.phase, target)) {
        await store.setPhase(row.key, target, {
          lastError: undefined,
          enqueuedAt: Date.now(),
        })
        resumed += 1
        logInfo('启动恢复：从当前阶段继续', { projectId: row.projectId, recordId: row.recordId, from: row.phase, to: target })
      } else {
        skipped += 1
      }
    } catch (error) {
      logInfo('启动恢复：这一条处理失败，跳过', {
        projectId: row.projectId,
        recordId: row.recordId,
        reason: toPipelineError(error).message,
      })
      skipped += 1
    }
  }

  logInfo('启动恢复完成', { resumed, reset, skipped })
  return { resumed, reset, skipped }
}

/**
 * 用 `git rev-parse --is-inside-work-tree` 判断一个目录是不是有效工作区。
 *
 * 单独抽出来是为了让测试可以注入假实现（不真去 spawn git）。
 *
 * @param {(args: string[], options: { cwd?: string }) => Promise<{ code: number, stdout: string }>} run
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function checkWorktreeByGit (run, path) {
  try {
    const result = await run(['rev-parse', '--is-inside-work-tree'], { cwd: path })
    return result.code === 0 && result.stdout.trim() === 'true'
  } catch {
    return false
  }
}

export { TERMINAL }
