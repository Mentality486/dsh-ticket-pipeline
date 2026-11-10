/**
 * `core/commit-summary.js` —— 读「某张票的这次本地提交到底改了什么」。
 *
 * ## 为什么要做这个（产品动机）
 *
 * 插件把改动提交到项目工作区的检出里，然后通知人「去 review」。可 review 之前
 * 人得先知道**改了什么**：哪几个文件、各几百行。以前 `pipeline_status` 只给一个
 * `本地提交：3433b3a93e82 @ v2.x`，人还得离开 GUI 开终端敲 `git show` —— 这一步
 * 直接劝退了「人只做三件事」里的第三件。
 *
 * ## 三条边界
 *
 * 1. **只读**：只用 `git show`，不 checkout、不 stash、不动任何分支引用。
 *    `git show` 对工作区无副作用，脏检出也照读。
 * 2. **一次进程调用**：一次 `git show --raw --numstat -z` 拿全（含逐文件行数）。
 *    不要每文件 fork 一次 —— 一张票动几十个文件时那是几十次进程。
 * 3. **绝不让主流程炸**：取不到（提交不存在、目录没了、git 链路缺席）时返回
 *    `{ ok: false, reason }`，由调用方决定怎么降级。读提交摘要失败不该让
 *    `pipeline_status` 整条查不出来。
 *
 * 解析格式的知识放在 `contracts/git-status.js`（`SHOW_SUMMARY_ARGS` /
 * `parseShowSummaryZ`）：那是「git 输出长什么样」的公共知识，适配器也要用同一套。
 */

import { SHOW_SUMMARY_ARGS, parseShowSummaryZ } from '../contracts/git-status.js'

/**
 * 逐文件明细最多列多少个。超出的只报个数。
 *
 * 20 是个折中：真机上 agent 一般改 1–8 个文件，20 之后人也不会逐个看；
 * 但「还有 N 个」保留了「这票动得很大」这个信号。
 */
export const COMMIT_SUMMARY_FILE_LIMIT = 20

/**
 * 状态 → 中文标签。与 `adapters/executor-agent` 里 MR 描述用的是同一套说法：
 * 同一个改动在两个地方叫两个名字，人会以为不是一回事。
 * @type {Readonly<Record<string, string>>}
 */
const STATUS_LABELS = Object.freeze({ create: '新增', update: '修改', delete: '删除', move: '重命名' })

/**
 * 读一次提交的改动摘要。
 *
 * @param {Object} input
 * @param {(argv: string[], opts?: { cwd?: string, timeoutMs?: number }) => Promise<{ code: number, stdout: string, stderr: string }> | null} input.gitRunner
 *   `makeGitRunner` 造出来的执行器；为 null 表示宿主没有 git 链路。
 * @param {string} input.worktreePath 改代码目录（`git show` 在这里执行）
 * @param {string} input.sha 要读的提交（完整 sha 或前缀都行，git 自己解析）
 * @param {number} [input.limit] 逐文件最多列几个，缺省 `COMMIT_SUMMARY_FILE_LIMIT`
 * @returns {Promise<
 *   | { ok: true, sha: string, files: Array<{ path: string, status: string, statusLabel: string, from?: string, insertions?: number, deletions?: number, binary?: boolean }>, fileCount: number, insertions: number, deletions: number, hasBinary: boolean, truncated: boolean, hiddenCount: number }
 *   | { ok: false, reason: string }
 * >}
 */
export async function describeCommit (input) {
  const gitRunner = input?.gitRunner
  const worktreePath = typeof input?.worktreePath === 'string' ? input.worktreePath : ''
  const sha = typeof input?.sha === 'string' ? input.sha.trim() : ''
  const limit = Number.isInteger(input?.limit) && input.limit > 0 ? input.limit : COMMIT_SUMMARY_FILE_LIMIT
  if (sha.length === 0) return { ok: false, reason: '这张票没有记录本地提交' }
  if (worktreePath.length === 0) return { ok: false, reason: '这张票没有记录改代码目录' }
  if (typeof gitRunner !== 'function') return { ok: false, reason: '宿主没有可用的 git 执行链路' }

  let result
  try {
    // 15 秒：读一次提交摘要不该慢过这个数；超时多半是目录在网络盘上，
    // 与其让 status 卡住，不如降级成「取不到」。
    result = await gitRunner([...SHOW_SUMMARY_ARGS, sha], { cwd: worktreePath, timeoutMs: 15000 })
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 200) }
  }
  if (!result) return { ok: false, reason: '宿主没有可用的 git 执行链路' }
  if (result.code !== 0) {
    const firstLine = String(result.stderr ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? ''
    // 目录被删、提交被清、已经不是 git 仓库 —— 三种都落到这里，说法要能区分。
    return { ok: false, reason: firstLine.slice(0, 200) || `git show 退出码 ${result.code}` }
  }

  const files = parseShowSummaryZ(result.stdout)
  if (files.length === 0) {
    // 空提交（`--allow-empty`）或全是没被记录的改动：不是错，但不该说「0 个文件」就完事。
    return {
      ok: true, sha, files: [], fileCount: 0, insertions: 0, deletions: 0,
      hasBinary: false, truncated: false, hiddenCount: 0,
    }
  }

  let insertions = 0
  let deletions = 0
  let hasBinary = false
  const detailed = files.map((file) => {
    if (file.binary) {
      hasBinary = true
    } else {
      insertions += file.insertions ?? 0
      deletions += file.deletions ?? 0
    }
    return { ...file, statusLabel: STATUS_LABELS[file.status] ?? file.status }
  })

  const hiddenCount = Math.max(0, detailed.length - limit)
  return {
    ok: true,
    sha,
    files: hiddenCount > 0 ? detailed.slice(0, limit) : detailed,
    fileCount: detailed.length,
    insertions,
    deletions,
    hasBinary,
    truncated: hiddenCount > 0,
    hiddenCount,
  }
}

/**
 * 把一份摘要渲成给人看的几行。`pipeline_status` 与（将来的）运行页签共用这一份，
 * 否则两处会说不同的话。
 *
 * 形状刻意做成「空数组 = 不渲染」：failed 票没有提交，多一行空行就是噪音。
 *
 * @param {Awaited<ReturnType<typeof describeCommit>> | undefined} summary
 * @param {(text: string) => void} push
 * @returns {void}
 */
export function renderCommitSummary (summary, push) {
  if (!summary) return
  if (summary.ok !== true) {
    push(`  改动摘要：取不到（${summary.reason}）`)
    return
  }
  if (summary.fileCount === 0) {
    push('  改动摘要：这次提交没有改动文件')
    return
  }
  // 行数用「+X / −Y」而不是「新增 X 行、删除 Y 行」：一屏里要能横向扫。
  const size = summary.hasBinary
    ? `${summary.fileCount} 个文件，+${summary.insertions} / −${summary.deletions}（含二进制文件）`
    : `${summary.fileCount} 个文件，+${summary.insertions} / −${summary.deletions}`
  push(`  改动摘要：${size}`)
  for (const file of summary.files) {
    const label = file.statusLabel ? `（${file.statusLabel}${file.status === 'move' && file.from ? `，原路径 ${file.from}` : ''}）` : ''
    const lines = file.binary ? '二进制' : `+${file.insertions ?? 0} / −${file.deletions ?? 0}`
    push(`    ${lines}  ${file.path}${label}`)
  }
  if (summary.truncated) push(`    …还有 ${summary.hiddenCount} 个文件没列出`)
}
