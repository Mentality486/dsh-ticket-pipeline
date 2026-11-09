/**
 * `recover.js` —— 启动恢复。
 *
 * 插件随 Harness 进程进出。上一次进程被杀在「改到一半」时，存储里的票还停在
 * `planning` / `editing` / `testing` 这类中间态。恢复**不从头重跑**：
 * 已经建好的工作区接着用，已经开过的 MR 先查一遍再决定要不要开。
 *
 * 三条规则（架构文档 §7.6）：
 * 1. `worktreePath` 还在、`git rev-parse` 通过 → 保留坐标，放回队列接着用
 * 2. `worktreePath` 没了 → 清掉坐标，放回队列让执行器重建
 * 3. 分支被删 / 被改 → 不重用，同样清坐标
 *
 * ## 为什么最终状态是 `pending` 而不是「停在原来的中间态」
 *
 * 这里踩过一次真坑（2026-11-09，真机上 3 张 sandbox 票永久卡死）：
 * 旧实现把票恢复成 `planning` / `testing` 这类中间态，用意是「停在本步重做」。
 * 但 `TicketStore.pickNext()` **只挑 `pending`** —— 中间态是留给启动恢复处理的，
 * 而恢复做完之后**没有任何代码路径会再把它们交给执行器**：`tick()` 的唯一入口
 * 就是 `pickNext()`。结果就是恢复日志说「resumed: 1」，票却一步也不再动。
 * 更糟的是 `pipeline_reset` 只认 failed / needs-info / gone，救不回中间态。
 *
 * 所以恢复的终态统一成 `pending`，把「上次停在哪一步」写进 `lastError` 供人看。
 * 工作区坐标保留下来，`runOne` 会先问 `isStaleWorkspaceCoords`：坐标还有效就
 * **直接复用**那个工作区（不会重新 clone / 重新建 worktree），语义上仍是「接着用」。
 */

import { TERMINAL } from '../contracts/types.js'
import { toPipelineError } from '../contracts/errors.js'

/**
 * @typedef {import('./store.js').TicketStore} TicketStore
 * @typedef {import('./store.js').TicketRecordRow} TicketRecordRow
 * @typedef {import('../contracts/types.js').Phase} Phase
 */

/**
 * 中间态票恢复后统一回到 `pending`（理由见文件头）。
 *
 * 这张表只用来生成给人看的一句话，说明「上次停在哪儿」——
 * 它不再决定恢复后写入哪个 phase。
 */
const RESUME_LABEL = Object.freeze({
  'worktree-ready': '上次停在「工作区就绪」',
  'planning': '上次停在「规划改动」',
  'editing': '上次停在「改代码」',
  'testing': '上次停在「跑验证」',
  'mr-opening': '上次停在「提交 / 开 MR」',
})

/** 需要「回到队列重跑」的中间态（`pending` 与终态都不在这里）。 */
const RESUMABLE_PHASES = Object.freeze(Object.keys(RESUME_LABEL))

/**
 * 扫一遍存储，把中间态的票安排回队列。
 *
 * @param {Object} options
 * @param {TicketStore} options.store
 * @param {(path: string) => Promise<boolean>} [options.worktreeExists] 判定工作区是否有效
 * @param {(msg: string, detail?: unknown) => void} [options.log]
 * @param {() => number} [options.now] 注入时钟。恢复时要把 `enqueuedAt` 写成「现在」，
 *   用 `Date.now()` 会让离线自测无法断言（假时钟与真时钟对不上）。
 * @returns {Promise<{ resumed: number, reset: number, skipped: number }>}
 */
export async function recoverPending ({ store, worktreeExists, log, now }) {
  const logInfo = log ?? (() => {})
  const nowFn = now ?? (() => Date.now())
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

      // 认识不了的中间态（以后加了新 phase 但忘了更新这张表）就原样留着，
      // 别硬改成 pending —— 那等于悄悄替人做了决定。
      if (!RESUMABLE_PHASES.includes(row.phase)) {
        skipped += 1
        logInfo('启动恢复：不认识的中间态，先不动', { projectId: row.projectId, recordId: row.recordId, phase: row.phase })
        continue
      }

      const pathOk = row.worktreePath
        ? await (worktreeExists ? worktreeExists(row.worktreePath) : Promise.resolve(true))
        : false

      // 无论工作区还在不在，终态都是 `pending`（理由见文件头）：
      // 只有 `pending` 才会被 `pickNext()` 捡起来跑。区别只在**保不保坐标**。
      if (!pathOk) {
        // 工作区没了：坐标全清，让执行器下一轮重新准备。
        // 尤其是 `mr` / `commit`：新工作区是新检出、新分支（分支名带 revisionCount），
        // 旧 MR 指向的分支已经不存在、旧 sha 在新历史里也找不到。不清掉的话，
        // 通知里会挂着一条作废链接，人点进去以为活还在。
        const reason = row.worktreePath ? '工作区丢失，启动恢复时重新排队' : '上次没来得及建工作区，启动恢复时重新排队'
        await store.setPhase(row.key, 'pending', {
          worktreePath: undefined,
          branch: undefined,
          baseCommit: undefined,
          mr: undefined,
          commit: undefined,
          lastError: reason,
          enqueuedAt: nowFn(),
        })
        reset += 1
        logInfo('启动恢复：工作区不在，清坐标回队列', {
          projectId: row.projectId,
          recordId: row.recordId,
          was: row.phase,
          hadWorktreePath: Boolean(row.worktreePath),
        })
        continue
      }

      // 工作区还在：坐标留着，让 `runOne` 直接复用（`isStaleWorkspaceCoords` 会再确认一遍）。
      // 恢复完 phase 是 pending，所以「上次停在哪」只能写进 lastError 让人看见。
      const was = RESUME_LABEL[row.phase] ?? `上次停在「${row.phase}」`
      await store.setPhase(row.key, 'pending', {
        lastError: `${was}，启动恢复后重新排队（工作区沿用，不会重新 clone）`,
        enqueuedAt: nowFn(),
      })
      resumed += 1
      logInfo('启动恢复：放回队列，工作区沿用', {
        projectId: row.projectId,
        recordId: row.recordId,
        was: row.phase,
        to: 'pending',
      })
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
