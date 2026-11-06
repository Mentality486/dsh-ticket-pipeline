/**
 * `git-status` —— 读 git 状态的格式与解析，纯函数，契约层。
 *
 * ## 为什么放在契约层
 *
 * 「读检出状态」这件事现在有三个人要做，需求各不相同但**格式必须一致**：
 * - `core` 侧的 `inspectCheckout`（判定检出干不干净）
 * - `tools` 侧的 `pipeline_doctor`（体检时告诉人检出会不会把票全拒掉）
 * - `adapters` 侧的 `collectChanges`（收集 agent 改了哪些文件）
 *
 * 适配器不能 import core（架构 §3：adapters 只 import contracts），
 * core 也不该认识某个适配器，所以这份「git 输出格式的知识」放契约层最合适。
 *
 * ## 为什么只认 `-z`
 *
 * 三个真实坑（都是在本机仓库里复现过的）：
 *
 * 1. **未跟踪目录会被折叠**：`git status --porcelain` 遇到一个全是新文件的目录
 *    只输出 `?? newdir/`，里面每个文件路径都拿不到 —— 于是「某个新文件是不是
 *    敏感文件」判断不出来，敏感文件就能绕过拦截。必须加 `-uall` 展开到文件级。
 * 2. **路径会被 git 引号转义**：中文名输出成 `?? "\346\226\260..."`（八进制），
 *    含空格的名字输出成 `?? "space name.txt"`（即便 `core.quotePath=false` 也加引号）。
 *    拿着这种字符串去提交，git 找不到那个文件。`-z` 下路径不带引号、不转义。
 * 3. **`--name-status` 与 `--porcelain` 的 rename 字段顺序相反**：
 *    前者是「状态 / 旧路径 / 新路径」，后者是「状态+新路径 / 旧路径」。
 *
 * 所以统一用 `-z`，并且两个格式各写一个解析器。
 *
 * ## 插件自己的隔离目录
 *
 * `.agents/worktrees/` 是插件开的隔离 worktree 目录，它在检出里表现为未跟踪内容。
 * 它不是「人的东西」，不该让检出看起来不干净，也不该被当成工单改动收集进来。
 * 用 pathspec 把它排掉，而不是靠字符串过滤 —— pathspec 是 git 自己的语义。
 */

/**
 * 排除插件自有目录的 pathspec。
 *
 * 放在这里而不是各调用点各写一份：三个调用点必须用**同一套**排除规则，
 * 否则「体检说不干净、跑票却不收」这类前后不一致会很难查。
 *
 * `:(exclude).agents/worktrees` 与 `:(exclude).agents/worktrees/**` 都要给：
 * 前者排掉目录本身，后者排掉目录下的内容（只给前者时目录里的文件仍会被列出）。
 *
 * @type {readonly string[]}
 */
export const PLUGIN_WORKTREE_PATHSPEC_EXCLUDES = Object.freeze([
  ':(exclude).agents/worktrees',
  ':(exclude).agents/worktrees/**',
])

/**
 * 收集改动 / 看检出状态时统一用的 status 参数。
 *
 * `-uall` 展开未跟踪目录；`-z` 免掉引号与转义。
 *
 * @type {readonly string[]}
 */
export const PORCELAIN_STATUS_ARGS = Object.freeze(['--porcelain', '-z', '-uall'])

/**
 * 把 `git status --porcelain -z` 的输出拆成记录。
 *
 * `-z` 格式：记录之间用 NUL 分隔，每条记录是「两字符状态码 + 空格 + 路径」；
 * 重命名/复制多带一条记录（紧跟其后，内容是**旧路径**）。
 *
 * 例：`" M a.txt\0R  new.txt\0old.txt\0?? b.txt\0"`
 * → `{code:' M', path:'a.txt'}`、`{code:'R ', path:'new.txt', from:'old.txt'}`、`{code:'??', path:'b.txt'}`
 *
 * @param {string} stdout
 * @returns {Array<{ code: string, path: string, from?: string }>}
 */
export function parseStatusZ (stdout) {
  /** @type {Array<{ code: string, path: string, from?: string }>} */
  const records = []
  const parts = String(stdout ?? '').split('\0')
  for (let index = 0; index < parts.length; index += 1) {
    const raw = parts[index]
    if (typeof raw !== 'string' || raw.length === 0) continue
    if (raw.length < 4) continue
    const code = raw.slice(0, 2)
    const path = raw.slice(3)
    if (path.length === 0) continue
    /** @type {{ code: string, path: string, from?: string }} */
    const record = { code, path }
    if (code.charAt(0) === 'R' || code.charAt(0) === 'C' || code.charAt(1) === 'R' || code.charAt(1) === 'C') {
      const from = parts[index + 1]
      if (typeof from === 'string' && from.length > 0) {
        record.from = from
        index += 1
      }
    }
    records.push(record)
  }
  return records
}

/**
 * 把 `git diff --name-status -z` 的输出拆成记录。
 *
 * `-z` 格式：状态与路径之间用 NUL 分隔；重命名/复制是「状态 / 旧路径 / 新路径」
 * （**旧路径在前**，与 `status -z` 相反）。
 *
 * 例：`"M\0a.txt\0D\0b.txt\0R100\0old.txt\0new.txt\0"`
 *
 * @param {string} stdout
 * @returns {Array<{ status: string, path: string, from?: string }>}
 */
export function parseNameStatusZ (stdout) {
  /** @type {Array<{ status: string, path: string, from?: string }>} */
  const records = []
  const parts = String(stdout ?? '').split('\0')
  for (let index = 0; index < parts.length; index += 1) {
    const status = parts[index]
    if (typeof status !== 'string' || status.length === 0) continue
    const letter = status.charAt(0).toUpperCase()
    if (letter === 'R' || letter === 'C') {
      const from = parts[index + 1]
      const to = parts[index + 2]
      if (typeof from !== 'string' || typeof to !== 'string') break
      index += 2
      /** @type {{ status: string, path: string, from?: string }} */
      const record = { status: letter === 'R' ? 'move' : 'create', path: to }
      if (letter === 'R') record.from = from
      records.push(record)
      continue
    }
    const path = parts[index + 1]
    if (typeof path !== 'string' || path.length === 0) continue
    index += 1
    const kind = letter === 'A' ? 'create' : letter === 'D' ? 'delete' : 'update'
    records.push({ status: kind, path })
  }
  return records
}

/**
 * 把 status 的两字符状态码翻成动作。
 *
 * - `??` = 未跟踪 → create
 * - `!!` = 被忽略 → 跳过（不进收集范围）
 * - 首列或次列是 `R`/`C` → move（路径取新路径，旧路径在 `from`）
 * - 首列或次列是 `D` → delete
 * - 首列是 `A` → create
 * - 其余 → update
 *
 * @param {string} code
 * @returns {'create'|'update'|'delete'|'move'|'ignored'}
 */
export function statusCodeToAction (code) {
  const text = String(code ?? '')
  if (text === '!!') return 'ignored'
  if (text === '??') return 'create'
  const index = text.charAt(0)
  const worktree = text.charAt(1)
  if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') return 'move'
  if (index === 'D' || worktree === 'D') return 'delete'
  if (index === 'A') return 'create'
  return 'update'
}
