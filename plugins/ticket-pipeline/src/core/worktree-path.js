/**
 * 「这个路径是不是插件自己开的隔离 worktree？」
 *
 * 为什么需要单独判一下：缺省（`isolateWorktree` 关）时票据的 `worktreePath`
 * 就是**项目工作区本身** —— 那是人在用的主检出。`git worktree remove --force`
 * 对着主检出去执行，等于把人的整个工作目录连未提交改动一起删掉。
 * 过期清理、启动恢复清理这两条路都会拿到这个字段，所以判定必须收在一处。
 *
 * 判定只看路径形状（`<repo>/.agents/worktrees/<name>`），不改文件系统、
 * 不调 git：清理路径本身必须在「不知道仓库长什么样」的时候也能安全拒绝。
 *
 * 反例（必须返回 false）：
 *   - `D:/WorkSpace/mgiot-pms`                  ← 人的主检出
 *   - `/repo/.agents`                            ← 只是配置目录
 *   - `/repo/.agents/worktrees`                  ← 目录本身，不是某一票
 *   - `/repo/src/.agents/worktrees/x`            ← 前缀对了但不在仓库根下
 */

/** 插件开隔离 worktree 用的固定相对路径（与 index.js 的 `git worktree add` 一致）。 */
export const ISOLATED_WORKTREE_SEGMENT = '.agents/worktrees'

/**
 * @param {unknown} filePath
 * @returns {boolean}
 */
export function isIsolatedWorktreePath (filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false
  // 统一分隔符：Windows 上 git 回的是反斜杠，配置里人写的是正斜杠。
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const marker = `/${ISOLATED_WORKTREE_SEGMENT}/`
  const index = normalized.indexOf(marker)
  if (index < 0) return false
  // `.agents/worktrees/` 后面必须还有一段名字，否则是目录本身。
  const name = normalized.slice(index + marker.length)
  if (name.length === 0) return false
  // 名字里不能再有分隔符之外的路径穿越。
  if (name.includes('..')) return false
  return true
}
