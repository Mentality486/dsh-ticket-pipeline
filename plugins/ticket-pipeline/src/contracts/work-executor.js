/**
 * `WorkExecutor` —— 怎么改代码、怎么验证、怎么开 MR。
 *
 * 执行器内部按阶段推进，每进入一个阶段必须 `await onPhase(...)` 落库 ——
 * 那是崩溃恢复的唯一依据，只在自己的内存里更新是不够的。
 */

/**
 * @typedef {import('./types.js').Ticket} Ticket
 * @typedef {import('./types.js').Phase} Phase
 * @typedef {import('./types.js').Plan} Plan
 * @typedef {import('./types.js').ErrorKind} ErrorKind
 * @typedef {import('./repo-locator.js').LocateResult} LocateResult
 */

/**
 * @typedef {Object} ExecCtx
 * @property {AbortSignal} signal
 * @property {string} worktreePath 已建好的隔离工作区绝对路径
 * @property {string} branch 已创建的分支名
 * @property {(phase: Phase, detail?: string) => Promise<void>} onPhase
 * @property {(msg: string) => void} log 写进插件日志，带 recordId 前缀
 * @property {string} [baseCommit]
 * @property {string} [repoPath]
 * @property {string} [workspacePath] 项目工作区目录（宿主 Workspace 的路径）。会话的 cwd 必须挂在这个目录上，
 *   否则 `Workspace.attachSession` 会拒绝（它要求会话 header 的规范 cwd 等于工作区路径），
 *   人在 GUI 里也就看不到这张票的会话属于哪个项目。缺省时退化成用 `worktreePath` 当 cwd。
 * @property {string} [workspaceId] 宿主的 WorkspaceId，用于把会话显式归属到工作区（headless 下为空）
 * @property {string} prompt 已经渲染好的任务书（纯文本）
 * @property {Array<{ type: 'text', text: string } | { type: 'image', image: unknown }>} content 含截图的内容块数组：text 块是任务书，image 块是已存进附件库的截图
 * @property {unknown[]} images 截图引用数组（saveImage 的返回值），content 里只用到了非空项
 * @property {Record<string, any>} config 生效中的插件配置
 */

/**
 * @typedef {Object} ExecResult
 * @property {Phase} phase 终态：done / skipped / failed
 * @property {Plan} [plan] 执行器产出的方案（进 MR 描述）
 * @property {string[]} changedFiles
 * @property {'passed'|'failed'|'skipped'} testOutcome
 * @property {string} [testDetail] skipped 时必须写原因
 * @property {{ iid: number, url: string, draft: boolean }} [mr] 走远程 GitLab 开出来的 MR
 * @property {{ sha: string, branch: string, files: string[] }} [commit] 在工作区检出里做出来的本地提交
 * @property {{ kind: ErrorKind, message: string, retryable: boolean }} [error]
 */

/**
 * `WorkExecutor` 契约。
 *
 * 实现必须满足：
 * - 必须尊重 `signal`：aborted 时停手、保留 worktree、抛 `PipelineError('aborted')`。
 * - 每进入新阶段必须 `await onPhase(...)`，不能只在自己的内存里更新。
 * - 不改 worktree 之外的文件；不 push（沙箱封死，见架构文档 §12.2）。
 * - 返回前必须已经把改动落成**可交付的东西**：默认是在工作区检出里做一次本地提交
 *   （`commit`，写清工单溯源）；配了 GitLab 的部署还会同时开 draft MR（`mr`）。
 *   两样都没有时必须在 `error` 里说明为什么没有。
 * - `testOutcome: 'skipped'` 是**合法成功路径**：环境起不来就记 skipped，
 *   但必须把原因写进 `testDetail`（进而进提交说明/通知），不能默默略过。
 *
 * @typedef {Object} WorkExecutor
 * @property {string} id
 * @property {(ticket: Ticket, target: LocateResult, ctx: ExecCtx) => Promise<ExecResult>} run
 */

/**
 * @param {unknown} candidate
 * @param {string} [label]
 * @returns {WorkExecutor}
 */
export function assertWorkExecutor (candidate, label = 'WorkExecutor') {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`${label}: 必须是对象，实际是 ${typeof candidate}`)
  }
  const executor = /** @type {any} */ (candidate)
  if (typeof executor.id !== 'string' || executor.id.length === 0) {
    throw new Error(`${label}: 缺少 id`)
  }
  if (typeof executor.run !== 'function') {
    throw new Error(`${label}("${executor.id}"): 缺少 run(ticket, target, ctx)`)
  }
  return /** @type {WorkExecutor} */ (executor)
}

/**
 * 结果归一 + 一致性校验。
 *
 * 这里拦住两类最常见的执行器 bug：
 * 1. 返回 `skipped` 却没写 `testDetail` —— 人看到结果不知道没被真跑过。
 * 2. 返回 `done`/`skipped` 却既没 `commit` 也没 `mr` —— 流程承诺「返回前必须已把改动落成可交付的东西」。
 *
 * @param {Partial<ExecResult>} input
 * @returns {ExecResult}
 */
export function makeExecResult (input) {
  const phase = input?.phase
  if (phase !== 'done' && phase !== 'skipped' && phase !== 'failed') {
    throw new Error(`makeExecResult: phase 必须是 done / skipped / failed，实际是 ${String(phase)}`)
  }
  const testOutcome = input.testOutcome ?? 'skipped'
  if (testOutcome !== 'passed' && testOutcome !== 'failed' && testOutcome !== 'skipped') {
    throw new Error(`makeExecResult: testOutcome 非法：${String(testOutcome)}`)
  }

  const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles.filter((f) => typeof f === 'string') : []

  if ((phase === 'done' || phase === 'skipped') && !input.mr && !input.commit) {
    throw new Error(`makeExecResult: phase=${phase} 时必须给出 commit 或 mr（流程承诺返回前已把改动落成可交付的东西）`)
  }
  if (testOutcome === 'skipped' && (phase === 'done' || phase === 'skipped')) {
    const detail = typeof input.testDetail === 'string' ? input.testDetail.trim() : ''
    if (detail.length === 0) {
      throw new Error('makeExecResult: testOutcome=skipped 时必须写 testDetail（说明为什么没跑）')
    }
  }
  if (phase === 'failed' && !input.error) {
    throw new Error('makeExecResult: phase=failed 时必须给出 error')
  }

  /** @type {ExecResult} */
  const result = { phase, changedFiles, testOutcome }
  if (input.plan) result.plan = input.plan
  if (typeof input.testDetail === 'string' && input.testDetail.length > 0) result.testDetail = input.testDetail
  if (input.mr) {
    if (typeof input.mr.iid !== 'number' || typeof input.mr.url !== 'string') {
      throw new Error('makeExecResult: mr 必须包含 iid(number) 与 url(string)')
    }
    result.mr = { iid: input.mr.iid, url: input.mr.url, draft: input.mr.draft === true }
  }
  if (input.commit) {
    if (typeof input.commit.sha !== 'string' || input.commit.sha.length === 0) {
      throw new Error('makeExecResult: commit 必须包含 sha(string)')
    }
    result.commit = {
      sha: input.commit.sha,
      branch: typeof input.commit.branch === 'string' ? input.commit.branch : '',
      files: Array.isArray(input.commit.files) ? input.commit.files.filter((f) => typeof f === 'string') : [],
    }
  }
  if (input.error) {
    result.error = {
      kind: input.error.kind,
      message: String(input.error.message ?? ''),
      retryable: input.error.retryable === true,
    }
  }
  return result
}
