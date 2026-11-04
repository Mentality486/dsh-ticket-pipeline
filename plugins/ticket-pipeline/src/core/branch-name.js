/**
 * `branch-name` —— 分支名清洗（纯函数，无依赖）。
 *
 * 为什么需要它：分支名是 `branchPrefix + projectId + recordId + '-r' + revisionCount`
 * 拼出来的，而 `recordId` 来自工单表的手填「序号」或外部系统的 ID —— 里面可能有空格、
 * 斜杠、中文。这些字符会让 `git worktree add <branch>` 直接失败：
 * - 空格、中文、`~`、`^`、`:`、`?`、`*`、`[`、`\\` 等会被 git 的 ref 命名规则拒绝；
 * - 超长名字会撞上文件系统路径上限。
 *
 * 与其在每个调用点各写一遍正则，不如只留这一个纯函数：输入任意字符串，
 * 输出一个 git 一定认、并且人还能认出来历的分支名片段。
 *
 * 边界说明：本函数**只清洗片段内部的字符**，不负责拼接前缀。
 * 斜杠是**有意保留**的：`branchPrefix` 和 `projectId` 里的 `/` 用来分层
 * （`feature/demo/...`），抹掉它反而把分支结构弄丢了。
 */

/** 分支名片段的最大长度。Git 本身限制宽松，但 Windows 路径上限和各远端更紧，取一个保守值。 */
export const MAX_BRANCH_SEGMENT_LENGTH = 200

/** 什么都不剩时的兜底名。 */
export const FALLBACK_BRANCH_SEGMENT = 'ticket'

/**
 * 把任意字符串清洗成一个 git 可用的分支名片段。
 *
 * 规则（顺序即语义，别调换）：
 * 1. 只保留 `[A-Za-z0-9._/-]`，其余字符一律替换成 `-`；
 * 2. 连续 `-` 合并成一个；
 * 3. 去掉**首尾的 `-`**（不动 `/`：那是调用方有意分层）；
 * 4. 截断到 {@link MAX_BRANCH_SEGMENT_LENGTH} 个字符；
 * 5. 结果为空（或只剩不能用的字符，比如全是 `/`）时回退成 `ticket`。
 *
 * 为什么是先合并再截断、最后才兜底：截断可能把尾部切出一个 `-`，
 * 也可能把一个非空结果切空，所以兜底必须放在最后一步。
 *
 * @param {unknown} raw 原始片段（通常含 recordId）
 * @returns {string} 可安全放进 `git worktree add` 的分支名片段
 */
export function sanitizeBranchName (raw) {
  const text = raw === null || raw === undefined ? '' : String(raw)

  // 1. 白名单替换。斜杠保留 —— 见文件头的边界说明。
  let cleaned = text.replace(/[^A-Za-z0-9._/-]/g, '-')

  // `..` 在 git ref 规则里非法（会被当成范围），折成单个点。
  cleaned = cleaned.replace(/\.\./g, '.')

  // 2. 连续 `-` 合并：`a---b` 看着像手滑，语义上和 `a-b` 没有区别。
  cleaned = cleaned.replace(/-{2,}/g, '-')

  // 3. 去掉首尾的 `-`。它们是替换残留，没有信息量，留着只会让名字难读。
  cleaned = cleaned.replace(/^-+|-+$/g, '')

  // 4. 截断。放在合并之后，免得切开合并结果又冒出新的一串 `-`。
  if (cleaned.length > MAX_BRANCH_SEGMENT_LENGTH) {
    cleaned = cleaned.slice(0, MAX_BRANCH_SEGMENT_LENGTH)
    // 截断后尾部可能又冒出 `-`，再修一次，别让分支名以 `-` 结尾。
    cleaned = cleaned.replace(/-+$/g, '')
  }

  // 5. 兜底：全是非法字符、或者只剩分隔符（如 `///`）时，给一个固定名字，
  //    让调用方至少能建出分支。只剩 `/` 时必须兜底，否则得到的是非法 ref。
  if (cleaned.length === 0 || /^\/+$/.test(cleaned)) return FALLBACK_BRANCH_SEGMENT
  return cleaned
}
