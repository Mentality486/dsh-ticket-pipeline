/**
 * `RepoLocator` —— 工单到「要改哪个仓库」的定位。
 *
 * 通用化之后，这一层**退化成查表**：每个项目在配置里已经声明了自己的仓库
 * （本地路径 / GitLab remote / 基准分支 / 目标分支），工单又带着 `projectId`，
 * 所以「定位」就是拿 `projectId` 查 `projects[]`，把仓库信息原样返回。
 *
 * 为什么不再做「模块名 → 代码路径」：那是某个具体项目的专属知识，换一个项目就失效。
 * 通用插件的代码定位交给 executor-agent 现场读仓库做，内核只负责把「哪个仓库、
 * 从哪个分支切、开 MR 到哪个分支」这些**结构事实**给它。
 */

/**
 * @typedef {import('./types.js').Ticket} Ticket
 */

/**
 * @typedef {Object} LocateResult
 * @property {string} repoPath 绝对路径（本地 git 检出）
 * @property {string} [remote] GitLab remote URL（开 MR 用）
 * @property {string} [baseBranch] 切 worktree 的基准分支（如 `main`）
 * @property {string} [targetBranch] draft MR 的目标分支
 * @property {string} [module] 规范化后的模块名
 * @property {string[]} candidatePaths 建议 agent 先看的文件/目录（相对 repoPath）；通用化后恒为空
 * @property {boolean} ambiguous true = 需要人在环里定夺；通用化后恒为 false
 * @property {string} [notes] 给 agent 的额外提示，会原样进 prompt
 */

/**
 * `RepoLocator` 契约。
 *
 * 实现必须满足：
 * - 纯函数语义：不做 IO 到目标仓库之外、不建 worktree、不改任何文件。
 * - `projectId` 缺失或查不到时抛 `PipelineError('invalid-input')` —— 这是配置错误，
 *   不是运行时错误，应当立刻失败并通知人，而不是静默挑一个仓库。
 *
 * @typedef {Object} RepoLocator
 * @property {string} id
 * @property {(ticket: Ticket, signal: AbortSignal) => Promise<LocateResult>} locate
 */

/**
 * @param {unknown} candidate
 * @param {string} [label]
 * @returns {RepoLocator}
 */
export function assertRepoLocator (candidate, label = 'RepoLocator') {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`${label}: 必须是对象，实际是 ${typeof candidate}`)
  }
  const locator = /** @type {any} */ (candidate)
  if (typeof locator.id !== 'string' || locator.id.length === 0) {
    throw new Error(`${label}: 缺少 id`)
  }
  if (typeof locator.locate !== 'function') {
    throw new Error(`${label}("${locator.id}"): 缺少 locate(ticket, signal)`)
  }
  return /** @type {RepoLocator} */ (locator)
}

/**
 * 结果归一：补默认值、去重、拒绝非法形状。
 * @param {Partial<LocateResult> & { repoPath: string }} input
 * @returns {LocateResult}
 */
export function makeLocateResult (input) {
  if (!input || typeof input.repoPath !== 'string' || input.repoPath.length === 0) {
    throw new Error('makeLocateResult: repoPath 必须是非空字符串')
  }
  const seen = new Set()
  const candidatePaths = []
  for (const p of Array.isArray(input.candidatePaths) ? input.candidatePaths : []) {
    if (typeof p !== 'string' || p.length === 0) continue
    const norm = p.replace(/\\/g, '/').replace(/^\.\//, '')
    if (seen.has(norm)) continue
    seen.add(norm)
    candidatePaths.push(norm)
  }

  /** @type {LocateResult} */
  const result = {
    repoPath: input.repoPath,
    candidatePaths,
    ambiguous: input.ambiguous === true,
  }
  if (typeof input.remote === 'string' && input.remote.length > 0) result.remote = input.remote
  if (typeof input.baseBranch === 'string' && input.baseBranch.length > 0) result.baseBranch = input.baseBranch
  if (typeof input.targetBranch === 'string' && input.targetBranch.length > 0) result.targetBranch = input.targetBranch
  if (typeof input.module === 'string' && input.module.length > 0) result.module = input.module
  if (typeof input.notes === 'string' && input.notes.length > 0) result.notes = input.notes
  return result
}
