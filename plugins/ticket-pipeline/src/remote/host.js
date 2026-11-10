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
import { parseFeishuLink } from '../contracts/types.js'
import { collectStatus } from '../tools/pipeline-status.js'
import { collectScan } from '../tools/pipeline-scan.js'
import { collectCancel } from '../tools/pipeline-cancel.js'
import { collectReset } from '../tools/pipeline-reset.js'
import { TICKET_PIPELINE_DESCRIPTORS, TICKET_PIPELINE_NAMESPACE } from './descriptors.js'

/**
 * 服务本体。方法就是普通方法（网关按名字 `Reflect.get` 调用）。
 */
export class TicketPipelineRemote {
  /**
   * @param {Object} options
   * @param {() => unknown} options.getConfig
   * @param {import('../tools/pipeline-doctor.js').DoctorOptions} options.doctorOptions
   * @param {() => any} [options.getSettings] 宿主 `settings` 服务（写 profile 用；缺席时「粘贴链接」不可用）
   * @param {import('../core/store.js').TicketStore} [options.store] 运行页签读票、重开票要用
   * @param {{ isRunning: () => boolean, tick: (opts?: any) => Promise<any>, cancelActive: () => boolean }} [options.scheduler]
   * @param {(args: string[], opts?: any) => Promise<any>} [options.gitRunner] 改动摘要要用
   * @param {(message: string, detail?: unknown) => void} [options.log] 后台一轮失败留痕
   */
  constructor (options) {
    this.getConfig = options.getConfig
    this.doctorOptions = options.doctorOptions
    this.getSettings = options.getSettings
    // 运行页签（#16）的四件东西。全部可选：`dev-run.mjs` 里有只测 branches 的用例
    // 只传 getConfig + doctorOptions，缺依赖时对应方法给一条人话错误，不是崩。
    this.store = options.store
    this.scheduler = options.scheduler
    this.gitRunner = options.gitRunner ?? options.doctorOptions?.gitRunner
    // 后台一轮失败时的留痕口（与工具那条 `options.log` 同一个）。缺席就静默 ——
    // 但「点了没反应」正是本票要治的病，所以宿主装配必须把它传进来。
    this.log = options.log

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

  /**
   * 面板「粘贴工单表链接」：把用户粘的链接变成 `match` 上的定位字段。
   *
   * 为什么这个方法必须存在、且必须由**宿主**解析：
   * `match.appToken` 能换出 access token，所以 `projects()` 从来只给
   * `hasAppToken` + 首尾几位，明文不下发浏览器。可面板又不能只有只读 —— 那样新增
   * 一个飞书项目就只能手改 `cordis.patch.yml`，「贴一条链接就能用」变成空话。
   *
   * 解法是让浏览器只交出**用户粘贴的那条链接**：解析发生在宿主进程里，
   * 明文从头到尾没进过浏览器，落盘的也只有 `match.appToken` 这一个字段。
   *
   * 失败一律抛错（网关会把 message 原样带到面板），不静默返回 `{ok:false}` ——
   * 「粘错链接」是用户能立刻改的事，必须当场说清是哪里不对。
   *
   * @param {number} index `projects[]` 下标（面板按 `projects()` 的顺序给）
   * @param {string} url 用户粘贴的整条飞书链接，或裸 token
   */
  async setProjectTable (index, url) {
    const config = this.getConfig() ?? {}
    const list = Array.isArray(config.projects) ? config.projects : []
    const position = Number(index)
    if (!Number.isInteger(position) || position < 0 || position >= list.length) {
      throw new Error(`没有第 ${String(index)} 个项目（当前共 ${list.length} 个）`)
    }

    const parsed = parseFeishuLink(url)
    if (parsed.kind === 'unknown') {
      throw new Error(
        '这不是多维表格 / 电子表格链接，也不是 app_token。\n' +
        '要粘的是浏览器地址栏里那条完整地址，形如：\n' +
        '· 多维表格 https://xxx.feishu.cn/base/bascnXXXX?table=tblXXXX\n' +
        '· 电子表格 https://xxx.feishu.cn/sheets/shtcnXXXX?sheet=XXXX\n' +
        '· wiki 里的表 https://xxx.feishu.cn/wiki/wikcnXXXX',
      )
    }

    const settings = typeof this.getSettings === 'function' ? this.getSettings() : undefined
    if (settings === undefined || typeof settings.mutate !== 'function') {
      throw new Error('宿主的 settings 服务不可用，没法写配置。可以去 profile 里手填 match.appToken。')
    }

    // 走 `settings.mutate`（不是直接写文件）：revision 冲突、volatile 校验都由它统一处理，
    // 也不会和我们自己的 `describeConfig()` 口径漂移。path 段用字符串（数组下标也是字符串）。
    const base = ['projects', String(position), 'match']
    /** @type {Array<{ op: string, path: string[], value?: unknown }>} */
    const ops = []
    if (parsed.kind === 'sheet') {
      ops.push({ op: 'set', path: [...base, 'spreadsheetToken'], value: parsed.spreadsheetToken })
      // 换表型时把多维表格侧的定位字段清掉，否则 `validateProject` 会看到两组互相矛盾的
      // token（它的判定是「有 appToken+tableId 就按多维表格」），表型判断和用户意图不一致。
      ops.push({ op: 'unset', path: [...base, 'appToken'] })
      ops.push({ op: 'unset', path: [...base, 'tableId'] })
      if (parsed.sheetId.length > 0) ops.push({ op: 'set', path: [...base, 'sheetId'], value: parsed.sheetId })
    } else {
      ops.push({ op: 'set', path: [...base, 'appToken'], value: parsed.appToken })
      ops.push({ op: 'unset', path: [...base, 'spreadsheetToken'] })
      if (parsed.tableId.length > 0) ops.push({ op: 'set', path: [...base, 'tableId'], value: parsed.tableId })
      if (parsed.viewId.length > 0) ops.push({ op: 'set', path: [...base, 'viewId'], value: parsed.viewId })
      // wiki 链接里的表可能是电子表格：`?sheet=` 就是那张工作表的 id。留着它，
      // 探测出表型之后 `resolveWorksheet` 才能挑对工作表，而不是退回「取第一张」。
      // 反过来，不带 `?sheet=` 的 wiki 链接说明它要么是多维表格、要么只有一张表 ——
      // 这时把旧的 sheetId 清掉才对，否则会拿别的表的 id 去查。
      if (parsed.sheetId.length > 0) ops.push({ op: 'set', path: [...base, 'sheetId'], value: parsed.sheetId })
      else ops.push({ op: 'unset', path: [...base, 'sheetId'] })
      // `tableKind` 是逃生阀：wiki 链接表型要到运行时问接口，这里不写死，
      // 免得把「探测」换成「猜对了没事、猜错了静默读错表」。
      ops.push({ op: 'unset', path: [...base, 'tableKind'] })
    }

    await settings.mutate('ticket-pipeline', ops, undefined)

    // 写完回读：调用方拿到的必须是**落盘后**的投影，不是我们以为写进去的东西。
    const next = this.getConfig() ?? {}
    const nextList = Array.isArray(next.projects) ? next.projects : []
    const saved = nextList[position]
    if (saved === undefined) {
      throw new Error('写完了，但读回来的配置里没有这个项目了（可能被别处改过）。请刷新设置页再看。')
    }

    const shape = parsed.kind === 'sheet' ? '电子表格' : parsed.kind === 'wiki' ? 'wiki 里的表（表型待探测）' : '多维表格'
    return {
      project: describeProject(saved, position),
      kind: parsed.kind,
      note: `已记下这条${shape}的定位信息。${parsed.kind === 'wiki' ? '表型会在第一次扫描时探测。' : ''}` +
        '面板只存 token，明文不会回到浏览器。项目改动生效需要插件重载（保存后重启宿主）。',
    }
  }

  // ── 运行页签（工单 #16）──────────────────────────────────────
  //
  // 这四个方法是面板上「运行」页的一整屏动作。硬约束：**不许复制工具实现** ——
  // 它们全部转调 tools/ 里已经抽好的算结果层（collectStatus / collectScan /
  // collectCancel / collectReset），与对话里的同名工具是同一份代码。
  // 复制一份的后果不是代码丑，而是两处判定迟早分道扬镳：工具说 already-running、
  // 按钮说 triggered，人就再也信不过任何一边。

  /**
   * 运行页签的一屏快照 —— 与 `pipeline_status` 工具同一个 `collectStatus()`。
   *
   * 固定取 `view: 'tickets'`：面板要的是「一张票一行、能挂按钮」的明细，
   * 不是按项目聚合的战报。
   *
   * `includeDone` 由面板的「显示历史」开关决定（缺省 false）：进去先看
   * 「还要我做什么」。以前这里写死 false，于是票一旦全部收尾，那一屏就是空的 ——
   * 「历史在哪查」因此变成一句只能靠对话工具回答的问题。票据只增不删，
   * 所以反过来的缺省（一律带全部）也不合适：跑上一个月开屏就要渲染几百行。
   *
   * @param {boolean} [includeDone] 连已收尾的票一起给（看历史）；不传等于 false
   */
  async status (includeDone) {
    requireStore(this.store, 'status')
    return collectStatus({
      store: this.store,
      getConfig: this.getConfig,
      gitRunner: this.gitRunner ?? null,
    }, { view: 'tickets', includeDone: includeDone === true })
  }

  /**
   * 「跑一轮」按钮 —— 与 `pipeline_scan` 工具同一个 `collectScan()`。
   *
   * 同样 fire-and-forget：这里**不等**这一轮跑完（跑一张票可能几十分钟，
   * 而网关的 direct 调用也有超时）。触发完立刻返回，进度靠 status() 轮询。
   * `disabled` / `already-running` 这两个「按下那一刻就知道」的结果由
   * collectScan 的 preflight 直接给出，不会白起一个后台任务。
   */
  async scan () {
    if (!this.scheduler) throw new Error('运行页签没接上调度器（scheduler 缺席），点不了「跑一轮」。')
    return collectScan({
      tick: (opts) => this.scheduler.tick(opts),
      isRunning: () => this.scheduler.isRunning,
      getConfig: this.getConfig,
      log: this.log,
    }, {}, undefined)
  }

  /** 「取消当前」按钮 —— 与 `pipeline_cancel` 工具同一个 `collectCancel()`。 */
  async cancel () {
    if (!this.scheduler) throw new Error('运行页签没接上调度器（scheduler 缺席），点不了「取消」。')
    return collectCancel({ cancelActive: () => this.scheduler.cancelActive() })
  }

  /**
   * 失败票行尾的「重跑」按钮 —— 与 `pipeline_reset` 工具同一个 `collectReset()`。
   *
   * 这是本票最大的一块价值：failed 票不会自动重试，以前只能去表格里拨
   * 「是否处理」，而那条路会整票重做一遍并覆盖旧回填。
   *
   * `projectId` 可选：只有多项目撞同一个 record_id 时才需要补。
   *
   * @param {string} recordId
   * @param {string} [projectId]
   */
  async reset (recordId, projectId) {
    requireStore(this.store, 'reset')
    return collectReset({ store: this.store }, { recordId, projectId })
  }
}

/**
 * 缺依赖时给一条能照着做的错，而不是 `undefined.listTickets is not a function`。
 *
 * @param {unknown} store
 * @param {string} action
 */
function requireStore (store, action) {
  if (!store) {
    throw new Error(`运行页签没接上存储（store 缺席），${action} 不可用。这通常是宿主装配没把 store 传进来。`)
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
    // 多维表格的列名覆盖（工单 #21）。和上面 `sheetColumns` 完全同形的摊平方式 ——
    // 面板那一个文本框同时服务两种表型，只是键名不同（见 lib/client.js 的 projectRawValue）。
    columns: match.columns && typeof match.columns === 'object' && !Array.isArray(match.columns)
      ? Object.keys(match.columns).map((key) => {
        const value = match.columns[key]
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
    // GitLab 出口（工单 #19）：这三个不是密钥，可以原样下发 —— 以前它们在面板上
    // 根本画不出来，导致「想开 draft MR 的人只能去手改 YAML」，这是这个能力最荒谬的地方。
    remoteMrEnabled: repo?.gitlab?.enabled === true,
    gitlabBaseUrl: String(repo?.gitlab?.baseUrl ?? ''),
    gitlabRemote: String(repo?.gitlab?.remote ?? ''),
    gitlabProjectId: repo?.gitlab?.projectId === undefined || repo?.gitlab?.projectId === null
      ? ''
      : String(repo.gitlab.projectId),
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
