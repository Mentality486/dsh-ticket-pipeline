/**
 * `workspace.js` —— 把「这张工单属于哪个项目」落到宿主的 Workspace 登记上。
 *
 * 为什么需要这一层：工单表里没有「待修改项目」这一列（飞书那 13 列是固定的），
 * 归属只能由 `projects[].match` 决定 —— 表就是项目。项目一旦确定，它的
 * `repo.path` 就是**这个项目的工作区目录**。宿主侧对应的是
 * `workspaceRegistry` 里的一条登记记录（`~/.dsh/storages/workspace.json`）。
 *
 * 宿主的规则（都是硬约束，踩过一次就得重来）：
 * - `create(path, title)` 要求目录**已经存在且是目录**，不会替你 mkdir；
 * - `create` 对同一个规范路径是幂等的（重复调用返回同一实体、不改标题）；
 * - `resolveByPath(path)` 在目录不存在时 **reject**（不是返回 undefined），
 *   目录存在但没登记才返回 undefined；
 * - `Workspace.attachSession(sessionId)` 要求会话 header 的规范 cwd **等于**
 *   工作区路径 —— 所以会话的 `meta.cwd` 必须是工作区根，不能是 worktree 子目录。
 *
 * 这个模块只做一件事：给定目录，返回「这个项目的工作区坐标」，必要时补登记。
 * 它不碰 git、不起 agent —— 那些在组合根与执行器里。
 */

import { PipelineError } from '../contracts/errors.js'

/**
 * @typedef {Object} ProjectWorkspace
 * @property {string} workspacePath 工作区目录（宿主的规范绝对路径；拿不到规范路径时是原样路径）
 * @property {string} [workspaceId] 宿主的 WorkspaceId；没有 registry 时为空
 * @property {boolean} created 这次是否**新登记**的（false = 之前就有）
 * @property {boolean} registered 是否真的登记/查到了宿主工作区（false = 降级）
 */

/**
 * 造一个「项目工作区」管理器。
 *
 * `workspaceRegistry` 与 `fs` 都是宿主服务，可能不存在（headless profile、
 * 老宿主、离线自测）。缺了不报错，退回「只有路径、没有登记」的降级形态 ——
 * 工单该修的还得修，不能因为 GUI 里少一个分组就整条流水线停摆。
 *
 * @param {{
 *   workspaceRegistry?: any,
 *   fs?: any,
 *   log?: (msg: string, detail?: unknown) => void,
 * }} [options]
 */
export function createProjectWorkspaceManager (options = {}) {
  const workspaceRegistry = options.workspaceRegistry
  const fs = options.fs
  const logInfo = typeof options.log === 'function' ? options.log : () => {}

  const hasFs = fs && typeof fs.resolve === 'function'
  const hasRegistry = workspaceRegistry && typeof workspaceRegistry.create === 'function'

  /**
   * 用宿主 `fs` 服务把路径「规范化 + 判存在」。
   *
   * 为什么不直接用 node 的 `fs.statSync`：插件跑在宿主里，一切文件访问都该走
   * 宿主的 fs 服务，否则沙箱策略与远程/虚拟文件系统会被绕过。
   *
   * @param {string} path
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ absolutePath: string, exists: boolean | undefined }>}
   */
  async function inspectDirectory (path, signal) {
    if (!hasFs) return { absolutePath: path, exists: undefined }
    try {
      const target = await fs.resolve(path, { signal })
      const absolutePath = typeof fs.processPath === 'function' ? fs.processPath(target) : path
      if (typeof fs.stat !== 'function') return { absolutePath, exists: undefined }
      const info = await fs.stat(target, signal)
      return { absolutePath, exists: info ? info.type === 'directory' : false }
    } catch {
      // `resolve` 在路径不存在时会 reject（realpath 失败），这里就是「没有这个目录」。
      return { absolutePath: path, exists: false }
    }
  }

  /**
   * 确保这个项目目录在宿主里有一份工作区登记。
   *
   * 顺序是有讲究的：**先 resolveByPath 再 create**。
   * - 先查：每张票都会走这条路，已登记过就不该再写一次登记表；
   * - 后建：`create` 本身幂等，但会改登记的持久顺序（新登记置顶），
   *   每张票都置顶一次等于把人的工作区列表搅乱。
   *
   * @param {{ path?: string, title?: string, signal?: AbortSignal }} input
   * @returns {Promise<ProjectWorkspace>}
   */
  async function ensureProjectWorkspace (input = {}) {
    const rawPath = String(input.path ?? '').trim()
    const signal = input.signal
    if (rawPath.length === 0) {
      // 没有 repo.path 就没有项目目录，后面建 worktree 也无从谈起 ——
      // 这是配置问题，重试一百次也一样，必须是 invalid-input（不可重试）。
      throw new PipelineError(
        'invalid-input',
        '项目没有配置 repo.path，无法确定这张工单属于哪个项目的工作区。' +
        '请在 projects[] 里给这个项目配上仓库本地检出的根目录。',
      )
    }

    const { absolutePath, exists } = await inspectDirectory(rawPath, signal)
    if (exists === false) {
      throw new PipelineError(
        'invalid-input',
        `项目工作区目录不存在：${absolutePath}。` +
        '插件不会替你克隆或创建目录（宿主的工作区登记也要求目录已存在）。' +
        '请先把仓库检出到 projects[].repo.path 指定的位置，或把该配置改成一个真实存在的检出目录。',
      )
    }

    // 降级：没有 workspaceRegistry 的 profile 里照样跑票，只是不登记工作区。
    if (!hasRegistry) {
      logInfo('本机没有 workspaceRegistry 服务，跳过工作区登记（只用目录跑票）', { workspacePath: absolutePath })
      return { workspacePath: absolutePath, workspaceId: undefined, created: false, registered: false }
    }

    if (typeof workspaceRegistry.resolveByPath === 'function') {
      try {
        const existing = await workspaceRegistry.resolveByPath(absolutePath)
        if (existing) {
          return {
            workspacePath: existing.path ?? absolutePath,
            workspaceId: existing.id,
            created: false,
            registered: true,
          }
        }
      } catch {
        // 目录不存在时 resolveByPath 会 reject。上面刚查过存在性，走到这里说明
        // 判定不一致（或者 fs 服务没装、exists 是 undefined）—— 交给 create 去给结论。
      }
    }

    const title = typeof input.title === 'string' && input.title.trim().length > 0
      ? input.title.trim()
      : undefined

    let workspace
    try {
      workspace = await workspaceRegistry.create(absolutePath, title)
    } catch (error) {
      // 登记失败不该让整张票死掉：目录还在、git 还能跑、代码还能改，
      // 只是 GUI 里不会多一个工作区分组。记下来，继续跑。
      logInfo('项目工作区登记失败，继续用目录跑票（GUI 里不会有这个工作区分组）', {
        workspacePath: absolutePath,
        reason: error?.message ?? String(error),
      })
      return { workspacePath: absolutePath, workspaceId: undefined, created: false, registered: false }
    }

    if (!workspace) {
      logInfo('项目工作区登记没有返回结果，继续用目录跑票', { workspacePath: absolutePath })
      return { workspacePath: absolutePath, workspaceId: undefined, created: false, registered: false }
    }

    logInfo('项目工作区已登记', { workspaceId: workspace.id, workspacePath: workspace.path, title: workspace.title })
    return {
      workspacePath: workspace.path ?? absolutePath,
      workspaceId: workspace.id,
      created: true,
      registered: true,
    }
  }

  return { ensureProjectWorkspace }
}
