/**
 * `locator-table` —— 通用化的仓库定位器：拿工单的 `projectId` 查配置里的 `projects[]`。
 *
 * 这是「工单 → 项目 → 仓库」那一环的唯一实现。它不做任何「模块名 → 代码路径」的推断：
 * 那类知识是某个具体项目专属的，通用插件装不下。代码定位交给 executor-agent 现场读仓库。
 *
 * 它只回答一个结构化问题：这张票对应哪个本地仓库、从哪个分支切、开 MR 到哪个分支、
 * remote 是什么。这些事实全部来自配置里的项目条目，不猜、不默认。
 *
 * ## 为什么构造期只记录错误、不抛
 *
 * 以前构造时校验 `projects[]`，一个条目写错就抛裸 Error —— 而构造发生在插件挂载那一刻，
 * 于是**一个项目配错，整条流水线起不来**：其它写得没问题的项目也一起停摆。
 * 越糟的是错误在挂载点被包成「插件加载失败」，人看到的是一句与具体项目无关的话。
 *
 * 现在改成：坏条目记进 `brokenProjects`，构造照样成功；只有 `locate()` 碰到那个项目时才抛
 * `PipelineError('invalid-input')`，指名道姓说哪个字段错了。健康项目完全不受影响。
 *
 * 构造期**不**校验 git 仓库：那要碰磁盘，而构造是同步的、挂载链路也不该被 IO 拖住。
 * 需要的话由调用方注入 `options.isGitRepo`（一个 `(path) => Promise<boolean>` 检查器），
 * `locate()` 里查一次 —— 查出来不是 git 仓库就报 invalid-input，别让执行器在计划阶段才发现。
 */

import { assertRepoLocator, makeLocateResult } from '../../contracts/repo-locator.js'
import { PipelineError } from '../../contracts/errors.js'

/**
 * 校验单个项目条目。返回问题描述，`null` 表示这一条没问题。
 *
 * 只做纯形状校验（不碰磁盘、不连网），因为它跑在构造期。
 *
 * @param {unknown} project
 * @param {number} i
 * @returns {string | null}
 */
function describeProjectProblem (project, i) {
  if (!project || typeof project !== 'object') return `projects[${i}] 必须是对象`
  const entry = /** @type {any} */ (project)
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (name.length === 0) return `projects[${i}] 缺少 name`
  const repo = entry.repo
  if (repo === undefined || repo === null) return `项目「${name}」缺少 repo 配置`
  if (typeof repo !== 'object' || Array.isArray(repo)) return `项目「${name}」的 repo 必须是对象`
  const path = typeof repo.path === 'string' ? repo.path.trim() : ''
  if (path.length === 0) return `项目「${name}」的 repo.path 无效：必须是非空字符串，实际是 ${JSON.stringify(repo.path)}`
  return null
}

/**
 * 索引一份 `projects[]` 配置。坏条目只记录、不抛出。
 *
 * 重名两侧都算坏：两个条目抢同一个 projectId 时，无论挑哪个都可能把票送进错的仓库，
 * 所以两个都进坏名单，等人去改配置。
 *
 * @param {unknown} projects
 * @returns {{ index: Map<string, any>, broken: Map<string, string>, projectCount: number }}
 */
function indexProjects (projects) {
  /** @type {Map<string, any>} */
  const index = new Map()
  /** @type {Map<string, string>} */
  const broken = new Map()

  if (!Array.isArray(projects)) {
    // 连 projects 都不是数组 = 整个配置坏了，没有「健康项目」可言。记在空名下，
    // 让 locate() 对任何 projectId 都给出同一句可操作的说明，而不是让插件挂载失败。
    return {
      index,
      broken: new Map([['', '配置里必须有 projects[] 数组']]),
      projectCount: 0,
    }
  }

  for (const [i, project] of projects.entries()) {
    const problem = describeProjectProblem(project, i)
    const name = project && typeof project === 'object' && typeof (/** @type {any} */ (project).name) === 'string'
      ? (/** @type {any} */ (project).name).trim()
      : ''

    if (problem !== null) {
      const key = name.length > 0 ? name : `#${i}`
      broken.set(key, problem)
      continue
    }

    if (index.has(name)) {
      const reason = `项目名重复 "${name}"，projectId 必须唯一`
      index.delete(name)
      broken.set(name, reason)
      continue
    }
    if (broken.has(name)) {
      // 前一条已经坏在同名上：这一条也不能用，保持两侧都不可用。
      continue
    }

    index.set(name, project)
  }

  return { index, broken, projectCount: Array.isArray(projects) ? projects.length : 0 }
}

/**
 * 造一个通用定位器。
 *
 * @param {Object} options
 * @param {unknown[]} options.projects 校验后的 `projects[]`（每项含 name + repo）
 * @param {(repoPath: string) => Promise<boolean>} [options.isGitRepo] 可选的 git 仓库检查器
 * @returns {import('../../contracts/repo-locator.js').RepoLocator}
 */
export function createTableLocator (options = {}) {
  const { index, broken, projectCount } = indexProjects(options.projects)
  const isGitRepo = typeof options.isGitRepo === 'function' ? options.isGitRepo : undefined

  /** 给「配置整体坏掉」那条笼统原因补一句上下文。 */
  const missingAllReason = projectCount === 0
    ? '\n（当前没有任何可用项目：配置里的 projects[] 是空的或不是数组，请先补 projects[]。）'
    : ''

  return assertRepoLocator({
    id: 'table',

    /**
     * 坏项目清单：`projectId → 原因`。给组合根/自测看，不影响 locate 的返回值。
     * @type {Array<{ projectId: string, reason: string }>}
     */
    brokenProjects: [...broken.entries()].map(([projectId, reason]) => ({ projectId, reason })),

    /**
     * @param {import('../../contracts/types.js').Ticket} ticket
     * @param {AbortSignal} [_signal] 契约要求接住取消信号（见 contracts/repo-locator.js）。
     *   查表是纯内存操作，没有可取消的等待；这里收下并忽略，是为了让调用方能
     *   统一把 signal 传下去 —— 哪天加了 isGitRepo 之类的 IO 校验，信号不会因为
     *   签名对不上而被丢在调用方。
     * @returns {Promise<import('../../contracts/repo-locator.js').LocateResult>}
     */
    async locate (ticket, _signal) {
      const projectId = ticket?.projectId
      if (typeof projectId !== 'string' || projectId.length === 0) {
        throw new PipelineError('invalid-input', 'locator-table: 工单缺少 projectId，无法定位仓库')
      }

      const project = index.get(projectId)
      if (!project) {
        const reason = broken.get(projectId)
        const detail = reason
          ? `项目「${projectId}」的配置有问题：${reason}`
          : `配置里没有项目 "${projectId}"。请检查 plugins 配置的 projects[] 是否包含它`
        throw new PipelineError(
          'invalid-input',
          `locator-table: ${detail}${missingAllReason}`,
        )
      }

      const repo = project.repo ?? {}
      const repoPath = typeof repo.path === 'string' ? repo.path.trim() : ''
      // 走到这里 repoPath 已经过构造期校验，理论上不可能为空；留一条防御分支，
      // 因为 repo 对象是调用方的引用，构造之后还可能被改。
      if (repoPath.length === 0) {
        throw new PipelineError('invalid-input', `locator-table: 项目 "${projectId}" 没有配置 repo.path`)
      }

      if (isGitRepo) {
        const ok = await isGitRepo(repoPath)
        if (!ok) {
          throw new PipelineError(
            'invalid-input',
            `locator-table: 项目 "${projectId}" 的 repo.path 不是 git 仓库：${repoPath}。`
            + '请把它改成该仓库本地检出的根目录（里面有 .git）。',
          )
        }
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
  })
}
