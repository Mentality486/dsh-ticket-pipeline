/**
 * `locator-table` —— 通用化的仓库定位器：拿工单的 `projectId` 查配置里的 `projects[]`。
 *
 * 这是「工单 → 项目 → 仓库」那一环的唯一实现。它不做任何「模块名 → 代码路径」的推断：
 * 那类知识是某个具体项目专属的，通用插件装不下。代码定位交给 executor-agent 现场读仓库。
 *
 * 它只回答一个结构化问题：这张票对应哪个本地仓库、从哪个分支切、开 MR 到哪个分支、
 * remote 是什么。这些事实全部来自配置里的项目条目，不猜、不默认。
 */

import { makeLocateResult } from '../../contracts/repo-locator.js'
import { PipelineError } from '../../contracts/errors.js'

/**
 * 校验并索引一份 `projects[]` 配置。
 *
 * 为什么在构造时校验而不是等到 `locate` 再查：项目清单写错（缺 repoPath、重名）是配置错误，
 * 插件挂载那一刻就该报清楚，而不是等某张票跑起来才发现「这个项目没有仓库」。
 *
 * @param {unknown} projects
 * @returns {Map<string, any>} projectId(name) → 项目条目
 */
function indexProjects (projects) {
  /** @type {Map<string, any>} */
  const index = new Map()
  if (!Array.isArray(projects)) {
    throw new Error('locator-table: 配置里必须有 projects[] 数组')
  }
  for (const [i, project] of projects.entries()) {
    if (!project || typeof project !== 'object') {
      throw new Error(`locator-table: projects[${i}] 必须是对象`)
    }
    const name = typeof project.name === 'string' ? project.name.trim() : ''
    if (name.length === 0) {
      throw new Error(`locator-table: projects[${i}] 缺少 name`)
    }
    if (index.has(name)) {
      throw new Error(`locator-table: 项目名重复 "${name}"，projectId 必须唯一`)
    }
    index.set(name, project)
  }
  return index
}

/**
 * 造一个通用定位器。
 *
 * @param {Object} options
 * @param {unknown[]} options.projects 校验后的 `projects[]`（每项含 name + repo）
 * @returns {import('../../contracts/repo-locator.js').RepoLocator}
 */
export function createTableLocator (options = {}) {
  const index = indexProjects(options.projects)

  return {
    id: 'table',

    /**
     * @param {import('../../contracts/types.js').Ticket} ticket
     * @returns {Promise<import('../../contracts/repo-locator.js').LocateResult>}
     */
    async locate (ticket) {
      const projectId = ticket?.projectId
      if (typeof projectId !== 'string' || projectId.length === 0) {
        throw new PipelineError('invalid-input', 'locator-table: 工单缺少 projectId，无法定位仓库')
      }

      const project = index.get(projectId)
      if (!project) {
        throw new PipelineError(
          'invalid-input',
          `locator-table: 配置里没有项目 "${projectId}"。请检查 plugins 配置的 projects[] 是否包含它`,
        )
      }

      const repo = project.repo ?? {}
      const repoPath = typeof repo.path === 'string' ? repo.path.trim() : ''
      if (repoPath.length === 0) {
        throw new PipelineError('invalid-input', `locator-table: 项目 "${projectId}" 没有配置 repo.path`)
      }

      return makeLocateResult({
        repoPath,
        remote: typeof repo.remote === 'string' ? repo.remote : undefined,
        baseBranch: typeof repo.baseBranch === 'string' ? repo.baseBranch : undefined,
        targetBranch: typeof repo.targetBranch === 'string' ? repo.targetBranch : undefined,
        candidatePaths: [],
        ambiguous: false,
        notes: typeof project.description === 'string' && project.description.length > 0
          ? `项目「${project.name}」：${project.description}`
          : undefined,
      })
    },
  }
}
