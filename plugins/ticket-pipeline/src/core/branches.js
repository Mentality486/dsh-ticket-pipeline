/**
 * `core/branches.js` —— 列出一个检出里有哪些分支，给设置面板的「选择分支」用。
 *
 * 为什么需要它：`repo.baseBranch` / `repo.targetBranch` 以前只能手打。手打的错法
 * 很难自查 —— 本机 pms 仓库主干叫 `v2.x`，人凭印象写成 `main`，`git fetch origin main`
 * 就报 `fatal: couldn't find remote ref main`，票全挂在第一步，错误里还看不出是
 * 「分支名打错了」，人会去查权限、查网络，查半天。让面板把存在的分支列出来，
 * 这类错从「运行时炸」变成「选项里根本没有」。
 *
 * 三条设计决定：
 *
 * 1. **本地和远端都列**。基准分支通常来自远端（新克隆的检出本地可能只有一条分支），
 *    目标分支则可能只是远端才有。只列其中一边会让另一边的输入框永远空着。
 * 2. **远端分支剥掉 remote 名**。人填 `repo.baseBranch` / `repo.targetBranch` 时写的是
 *    分支名（`v2.x`），不是 `origin/v2.x`。两边同名（本地也有 `v2.x`）时合成一个。
 * 3. **`origin/HEAD` 这类符号引用要丢掉**。它是「远端默认分支指向哪」的指针，
 *    不是可切的分支；列出来选了会变成 `git fetch origin HEAD`，看着像能用。
 *
 * 这里全是纯函数 + 一个 `gitRunner` 调用，不碰文件系统、不抛错 —— 面板拿不到分支时
 * 应该退化成一个空列表 + 一句原因，而不是让整张项目卡片炸掉。
 */

/**
 * 让 git 把「本地分支 + 远端分支」一次性列出来。
 *
 * 为什么用 `for-each-ref` 而不是 `git branch -a`：
 * - `git branch -a` 的输出带 `remotes/` 前缀、带 `*` 标记、还可能被 `column.ui` 排版成多列，
 *   解析起来全是边角情况。
 * - `for-each-ref --format=%(refname)` 一条一行、格式固定，不受任何别名/配置影响。
 */
export const BRANCH_REF_ARGS = Object.freeze([
  'for-each-ref',
  '--format=%(refname)',
  'refs/heads',
  'refs/remotes',
])

/**
 * 把 `for-each-ref` 的输出拆成 `{ local, remote }`。
 *
 * 输入形如：
 * ```
 * refs/heads/main
 * refs/heads/v2.x
 * refs/remotes/origin/HEAD
 * refs/remotes/origin/v2.x
 * ```
 *
 * @param {string} stdout
 * @returns {{ local: string[], remote: Array<{ branch: string, remote: string }> }}
 */
export function parseBranchRefs (stdout) {
  const local = []
  const seenLocal = new Set()
  const remote = []
  const seenRemote = new Set()

  const lines = String(stdout ?? '').split('\n')
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0) continue

    if (line.startsWith('refs/heads/')) {
      const name = line.slice('refs/heads/'.length)
      if (name.length === 0 || seenLocal.has(name)) continue
      seenLocal.add(name)
      local.push(name)
      continue
    }

    if (line.startsWith('refs/remotes/')) {
      const rest = line.slice('refs/remotes/'.length)
      // `<remote>/<branch>`；分支名自己可以带 `/`（`feature/x`），所以只切第一个。
      const slash = rest.indexOf('/')
      if (slash <= 0 || slash === rest.length - 1) continue
      const remoteName = rest.slice(0, slash)
      const branch = rest.slice(slash + 1)
      // `origin/HEAD` 是符号引用，不是可切的分支。
      if (branch === 'HEAD') continue
      const key = `${remoteName}/${branch}`
      if (seenRemote.has(key)) continue
      seenRemote.add(key)
      remote.push({ branch, remote: remoteName })
      continue
    }
  }

  return { local, remote }
}

/**
 * 把 `parseBranchRefs` 的结果摊成一份给下拉框用的去重清单。
 *
 * 顺序有讲究：当前分支 → 远端默认分支 → 本地分支 → 其余远端分支。
 * 下拉框第一项就是「最可能对的那一个」，人不用翻。
 *
 * @param {{ local: string[], remote: Array<{ branch: string, remote: string }> }} refs
 * @param {{ current?: string, defaultBranch?: string }} [prefer]
 * @returns {string[]}
 */
export function mergeBranchChoices (refs, prefer = {}) {
  const out = []
  const seen = new Set()
  const push = (name) => {
    const text = String(name ?? '').trim()
    if (text.length === 0 || text === 'HEAD' || seen.has(text)) return
    seen.add(text)
    out.push(text)
  }

  push(prefer.current)
  push(prefer.defaultBranch)
  for (const name of refs.local) push(name)
  for (const item of refs.remote) push(item.branch)
  return out
}

/**
 * 列出某个检出里的分支。**不抛错**：拿不到就 `ok: false` + 一句人话原因。
 *
 * @param {(argv: string[], opts?: { cwd?: string }) => Promise<{ code: number, stdout: string, stderr: string }>} gitRunner
 * @param {string} repoPath
 * @param {{ detectDefaultBranch?: (repoPath: string) => Promise<string> }} [options]
 *   `detectDefaultBranch` 注入口：体检那边已经有「猜基准分支」的逻辑，面板复用同一份，
 *   不在这里再写一套（否则两处对「主干叫什么」的判断会漂移）。
 * @returns {Promise<{
 *   ok: boolean, reason?: string, repoPath: string,
 *   current: string, defaultBranch: string,
 *   local: string[], remote: string[], branches: string[],
 * }>}
 */
export async function listBranches (gitRunner, repoPath, options = {}) {
  const empty = {
    ok: false,
    repoPath: String(repoPath ?? ''),
    current: '',
    defaultBranch: '',
    local: [],
    remote: [],
    branches: [],
  }

  const path = String(repoPath ?? '').trim()
  if (path.length === 0) return { ...empty, reason: '这个项目还没配 repo.path，没有仓库可查分支' }
  if (typeof gitRunner !== 'function') return { ...empty, reason: '宿主没提供 git 执行链路（gitRunner 缺席）' }

  let listed
  try {
    listed = await gitRunner(BRANCH_REF_ARGS, { cwd: path })
  } catch (error) {
    return { ...empty, reason: `跑 git 时出错：${String(error?.message ?? error).slice(0, 200)}` }
  }
  if (!listed || listed.code !== 0) {
    const firstLine = String(listed?.stderr ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? ''
    return {
      ...empty,
      reason: firstLine.slice(0, 200)
        || `git for-each-ref 退出码 ${listed?.code ?? '未知'}（这个路径是 git 检出吗？）`,
    }
  }

  const refs = parseBranchRefs(listed.stdout)

  // 当前分支：`rev-parse --abbrev-ref HEAD` 在游离 HEAD 上返回 `HEAD`，那不算分支名。
  let current = ''
  try {
    const head = await gitRunner(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path })
    if (head && head.code === 0) {
      const name = String(head.stdout ?? '').trim()
      if (name.length > 0 && name !== 'HEAD') current = name
    }
  } catch {
    // 取不到当前分支不影响列清单，往下走。
  }

  let defaultBranch = ''
  if (typeof options.detectDefaultBranch === 'function') {
    try {
      defaultBranch = String(await options.detectDefaultBranch(path) ?? '').trim()
    } catch {
      defaultBranch = ''
    }
  }

  const branches = mergeBranchChoices(refs, { current, defaultBranch })
  return {
    ok: true,
    repoPath: path,
    current,
    defaultBranch,
    local: refs.local,
    remote: refs.remote.map((item) => item.branch),
    branches,
  }
}
