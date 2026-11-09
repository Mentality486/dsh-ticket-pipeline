/**
 * `remote/host.js` —— 把体检与配置快照挂成宿主 Remote。
 *
 * 只在**宿主**跑；浏览器侧拿 `remote/descriptors.js` 里的描述符去 `$mount`。
 *
 * 为什么不用 `@deepseek-ai/dsh-typert-protocol` 的 `@Remote` 装饰器：
 * 那个包从插件目录解析不到（不在本包 dependencies 里，见 `core/config.js` 的说明）。
 * 换成「`ctx.provide` + `ctx.typert.register`」的 strict 注册就够了 ——
 * 网关既认 strict 注册，也认反射出来的 `typertRemote` 绑定，两条路都通。
 *
 * `typertRemote` 字段是网关的**绑定校验**要的，不是注册要的：
 * `validateBinding()` 会检查 `binding.service === 实例本身`、
 * `binding.serviceKey === ctx.provide 的键`、`binding.namespace` 与描述符一致。
 * 三者对不上会抛 `gateway/binding-invalid`。
 */

import { runDoctor } from '../tools/pipeline-doctor.js'
import { TICKET_PIPELINE_DESCRIPTORS, TICKET_PIPELINE_NAMESPACE } from './descriptors.js'

/**
 * 服务本体。方法就是普通方法（网关按名字 `Reflect.get` 调用）。
 */
export class TicketPipelineRemote {
  /**
   * @param {Object} options
   * @param {() => unknown} options.getConfig
   * @param {import('../tools/pipeline-doctor.js').DoctorOptions} options.doctorOptions
   */
  constructor (options) {
    this.getConfig = options.getConfig
    this.doctorOptions = options.doctorOptions

    // 网关的绑定校验读这个字段（见文件头注释）。
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: TICKET_PIPELINE_NAMESPACE,
      namespace: TICKET_PIPELINE_NAMESPACE,
    })
  }

  /** 跑一次环境体检（与 `pipeline_doctor` 工具同一份逻辑）。 */
  async doctor () {
    return runDoctor({ ...this.doctorOptions, getConfig: this.getConfig })
  }

  /** 当前生效的配置快照（敏感项已打码，见 `describeConfig()`）。 */
  async config () {
    const { describeConfig } = await import('../core/config.js')
    const config = this.getConfig() ?? {}
    return {
      config: describeConfig(config),
      projects: Array.isArray(config.projects) ? config.projects.length : 0,
    }
  }

  /**
   * 项目清单（给设置面板的「项目清单」编辑器用）。
   *
   * `describeConfig()` 里的 `projects` 是为了排障打的快照（有 repo/verify 全量），
   * 但它是「扁平到只剩几项」的形状，面板要逐字段编辑，需要**每一格都明确存在**
   * 的扁平记录 —— 缺的字段给空串，面板才好画输入框、好判断「这一格改没改」。
   *
   * 安全：`appToken` 这类能换出 access token 的串只透出「有没有配 + 首尾几位」，
   * 明文绝不下发到浏览器。面板要改它就走 profile，不在这里开输入框。
   */
  async projects () {
    const config = this.getConfig() ?? {}
    const list = Array.isArray(config.projects) ? config.projects : []
    return {
      count: list.length,
      projects: list.map((project, index) => describeProject(project, index)),
    }
  }

  /**
   * 每个项目检出里有哪些分支（给设置面板的「选择分支」下拉用）。
   *
   * 为什么一次返回全部项目：面板是按项目卡片渲染的，若做成 `branches(repoPath)`，
   * 每次重绘都会对每个项目各发一次请求，卡片一多就是几十个并发 git 进程。
   * 一次拿全量，面板按 `repoPath` 查表 —— 单次调用、单次失败、只有一个错误位可显示。
   *
   * 不抛错：某个项目的 `repo.path` 配错只应让那个项目的下拉空着并附一句原因，
   * 不能连累其他项目（更不能让「刷新分支」按钮把整张卡片炸掉）。
   */
  async branches () {
    const { listBranches } = await import('../core/branches.js')
    const config = this.getConfig() ?? {}
    const list = Array.isArray(config.projects) ? config.projects : []
    const gitRunner = this.doctorOptions?.gitRunner
    const detectDefaultBranch = this.doctorOptions?.detectBaseBranch

    const entries = await Promise.all(list.map(async (project, index) => {
      const repoPath = String(project?.repo?.path ?? '')
      const result = await listBranches(gitRunner, repoPath, {
        // 体检那边已经有「猜主干分支」的逻辑（远端 HEAD → 当前分支 → main），
        // 复用它，免得两处对「主干叫什么」的判断漂移。
        detectDefaultBranch: typeof detectDefaultBranch === 'function'
          ? (path) => detectDefaultBranch(gitRunner, path)
          : undefined,
      })
      return { index, name: String(project?.name ?? ''), ...result }
    }))

    return { count: entries.length, branches: entries }
  }
}

/**
 * 把一条 `projects[]` 摊成面板要的扁平记录。
 *
 * 为什么要摊平：面板的输入框要一个一个绑值，嵌套形状每层都得判 undefined，
 * 判断「这格改没改」也要能把路径直接算出来（`['projects', '0', 'repo', 'path']`）。
 *
 * @param {any} project
 * @param {number} index
 */
function describeProject (project, index) {
  const match = project?.match ?? {}
  const repo = project?.repo ?? {}
  const verify = project?.verify ?? {}
  const appToken = typeof match.appToken === 'string' ? match.appToken : ''

  /** @type {Record<string, any>} */
  const out = {
    index,
    name: String(project?.name ?? ''),
    description: String(project?.description ?? ''),
    platform: String(match.platform ?? ''),
    // feishu
    tableId: String(match.tableId ?? ''),
    viewId: String(match.viewId ?? ''),
    docNamePattern: String(match.docNamePattern ?? ''),
    // 只透出「配没配」和首尾摘要：appToken 能换 access token，不能下发明文。
    hasAppToken: appToken.length > 0,
    appTokenPreview: appToken.length > 0 ? `${appToken.slice(0, 4)}…${appToken.slice(-4)}` : '',
    // 金山
    sheetUrl: String(match.sheetUrl ?? ''),
    sheetName: String(match.sheetName ?? ''),
    statusColumn: String(match.statusColumn ?? ''),
    statusValue: String(match.statusValue ?? ''),
    mediaPrefix: String(match.mediaPrefix ?? ''),
    // 飞书电子表格（ADR-0005：与多维表格同一个 platform，靠表型分派）
    spreadsheetToken: String(match.spreadsheetToken ?? ''),
    sheetId: String(match.sheetId ?? ''),
    sheetHeaderRow: Number.isFinite(Number(match.sheetHeaderRow)) && Number(match.sheetHeaderRow) >= 1
      ? Number(match.sheetHeaderRow)
      : '',
    sheetIdentity: String(match.sheetIdentity ?? ''),
    sheetIdColumn: String(match.sheetIdColumn ?? ''),
    sheetRange: String(match.sheetRange ?? ''),
    // sheetColumns 是「语义 → 实际表头」的对象。面板只有一个文本框，
    // 这里摊成 `description=问题描述, status=是否处理` 这种一行写法，
    // 改回去时由面板解析成对象（见 lib/client.js 的 projectRawValue）。
    sheetColumns: match.sheetColumns && typeof match.sheetColumns === 'object' && !Array.isArray(match.sheetColumns)
      ? Object.keys(match.sheetColumns).map((key) => {
        const value = match.sheetColumns[key]
        const text = Array.isArray(value) ? value.map(String).join('|') : String(value ?? '')
        return `${key}=${text}`
      }).join(', ')
      : '',
    tableKind: String(match.tableKind ?? ''),
    // 通用收窄
    statusValues: Array.isArray(match.statusValues) ? match.statusValues.map(String) : [],
    recordIds: Array.isArray(match.recordIds) ? match.recordIds.map(String) : [],
    allowedImageHosts: Array.isArray(match.allowedImageHosts) ? match.allowedImageHosts.map(String) : [],
    // 仓库
    repoPath: String(repo.path ?? ''),
    repoRemote: String(repo.remote ?? ''),
    repoBaseBranch: String(repo.baseBranch ?? ''),
    repoTargetBranch: String(repo.targetBranch ?? ''),
    remoteMrEnabled: repo?.gitlab?.enabled === true,
    // 验证
    verifyBuild: String(verify.build ?? ''),
    verifyTest: String(verify.test ?? ''),
  }
  return out
}

/**
 * 在插件 context 里挂载 Remote。
 *
 * `typert` 不是所有 profile 都一定有的服务，所以用 `ctx.inject` 做**可选**装配：
 * 服务缺席时这段整体跳过，插件其余部分照常工作（体检工具仍然能用）。
 *
 * @param {any} ctx 插件 context
 * @param {TicketPipelineRemote} service
 * @returns {boolean} 是否挂上
 */
export function mountTicketPipelineRemote (ctx, service) {
  const typert = ctx.get('typert')
  if (typert === undefined || typeof typert.register !== 'function') return false

  ctx.provide(TICKET_PIPELINE_NAMESPACE, service)
  typert.register({
    package: '@local/ticket-pipeline',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: TICKET_PIPELINE_DESCRIPTORS,
  })
  return true
}
