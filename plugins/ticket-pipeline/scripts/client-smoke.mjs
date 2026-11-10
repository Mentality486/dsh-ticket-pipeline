#!/usr/bin/env node
/**
 * 冒烟测试：把 `lib/client.js` 放进一个假的浏览器环境里真跑一遍。
 *
 * 检查的是**行为**（能不能拿到设置、能不能生成正确的 mutate ops、体检按钮有没有
 * 调对 Remote），不是语法。真正端到端的验证只能在 DSH 里点（见 README「验证」），
 * 但那个回路太长、太贵，这里先把能自动化的部分钉死。
 *
 *   node scripts/client-smoke.mjs
 *
 * 退出码 0 = 全过；1 = 有断言失败。
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

function check (name, condition, detail) {
  if (condition) return
  failures.push(name + (detail === undefined ? '' : '：' + detail))
}

// ── 假 React ──────────────────────────────────────────────────
// 只需要够渲染出 element 树 + 把 hook 的读写接回一个可重入的渲染循环。
// 不实现 diff / 生命周期，只按「渲染 → 跑 effect → setState 再渲染」推。

function createElement (type, props, ...children) {
  const flat = []
  const push = (value) => {
    if (value === null || value === undefined || typeof value === 'boolean') return
    if (Array.isArray(value)) { value.forEach(push); return }
    flat.push(value)
  }
  push(children)
  return { type, props: Object.assign({}, props, { children: flat }) }
}

const RENDER = {
  hooks: [],
  cursor: 0,
  dirty: false,
  effects: [],
}

function makeReact () {
  return {
    createElement,
    Fragment: Symbol('Fragment'),
    useState (initial) {
      const index = RENDER.cursor
      RENDER.cursor += 1
      if (RENDER.hooks.length <= index) RENDER.hooks[index] = typeof initial === 'function' ? initial() : initial
      const setter = (next) => {
        const previous = RENDER.hooks[index]
        const value = typeof next === 'function' ? next(previous) : next
        if (Object.is(value, previous)) return
        RENDER.hooks[index] = value
        RENDER.dirty = true
      }
      return [RENDER.hooks[index], setter]
    },
    useEffect (fn, deps) {
      const index = RENDER.cursor
      RENDER.cursor += 1
      const previous = RENDER.hooks[index]
      const changed = previous === undefined || deps === undefined ||
        deps.length !== previous.length || deps.some((value, i) => !Object.is(value, previous[i]))
      if (changed) RENDER.effects.push(fn)
      RENDER.hooks[index] = deps
    },
    useCallback (fn) { RENDER.cursor += 1; return fn },
    useMemo (fn) { RENDER.cursor += 1; return fn() },
  }
}

// ── 测试数据 ──────────────────────────────────────────────────
// 模拟 dsh-settings 的 plainSchema 输出：schemastery 信封（{uid, refs}），
// 根在 refs[uid]，节点 meta 里已经删掉 volatile，只留 label/description/default/enum。

function makeSchemaEnvelope () {
  // 树形就照真实的 24 键来（组名 / 默认值 / 先后顺序都一致），只是字段少几个：
  // 「行为」组要够满，才能验「缺省第一屏就能看见主要旋钮」这条验收。
  const refs = {
    0: {
      type: 'object',
      meta: {},
      dict: {
        enabled: 1,
        pollIntervalMinutes: 2,
        ticketTimeoutMinutes: 14,
        maxAttempts: 15,
        workExecutor: 6,
        provider: 16,
        isolateWorktree: 17,
        writeBack: 18,
        writeBackStatus: 19,
        writeBackOnFailure: 21,
        pushAdapter: 13,
        qqmail: 4,
        pushplus: 3,
        notifyOn: 5,
        leaseTtlMinutes: 11,
        branchPrefix: 20,
      },
    },
    1: { type: 'boolean', meta: { label: '总开关', description: '装上不会自动开始扫表。', default: false, group: '行为' } },
    2: { type: 'number', meta: { label: '轮询间隔（分钟）', description: '飞书只能轮询。', default: 3, min: 1, max: 60, group: '行为' } },
    3: {
      type: 'object',
      meta: {},
      dict: {
        channel: 7,
        callbackUrl: 8,
      },
    },
    4: {
      type: 'object',
      meta: {},
      dict: {
        host: 9,
        encryption: 10,
        user: 12,
      },
    },
    5: { type: 'array', meta: { label: '发通知的 phase', default: ['done', 'failed'], group: '通知' }, inner: { type: 'string', meta: {} } },
    6: {
      type: 'string',
      meta: { label: '执行器', enum: ['agent', 'mock'], default: 'mock', group: '行为' },
    },
    7: { type: 'string', meta: { label: 'PushPlus 渠道', default: 'clawbot', group: '通知' } },
    8: { type: 'string', meta: { label: '送达回执地址', default: '', group: '通知' } },
    9: { type: 'string', meta: { label: 'SMTP 主机', default: 'smtp.qq.com', group: '通知' } },
    10: { type: 'string', meta: { label: 'SMTP 加密方式', enum: ['tls', 'starttls'], default: 'tls', group: '通知' } },
    11: { type: 'number', meta: { label: '租约存活（分钟）', default: 10, min: 1, max: 60, group: '高级' } },
    12: { type: 'string', meta: { label: '发件邮箱', default: '', group: '通知' } },
    13: {
      type: 'string',
      meta: {
        label: '通知适配器',
        enum: ['mock', 'pushplus', 'qqmail'],
        default: 'mock',
        group: '通知',
      },
    },
    14: { type: 'number', meta: { label: '单票超时（分钟）', default: 40, min: 1, max: 600, group: '行为' } },
    15: { type: 'number', meta: { label: '最大重试次数', default: 2, min: 1, max: 10, group: '行为' } },
    16: { type: 'string', meta: { label: '模型 provider', default: '', group: '行为' } },
    17: { type: 'boolean', meta: { label: '隔离工作区', default: false, group: '行为' } },
    18: { type: 'boolean', meta: { label: '回填表格', default: true, group: '行为' } },
    19: { type: 'string', meta: { label: '回填的状态值', default: '是', group: '行为' } },
    20: { type: 'string', meta: { label: '分支前缀', default: 'ticket-', group: '高级' } },
    21: { type: 'boolean', meta: { label: '失败也写「处理结果」', default: false, group: '行为' } },
  }
  return { uid: 0, refs }
}

/**
 * 宿主的 `ticketPipeline.projects()` 只读投影（`describeProject` 的扁平记录）。
 *
 * 注意它**没有** appToken 明文，只有 hasAppToken / appTokenPreview —— 面板绝不能
 * 因此提供明文输入框。
 */
function makeProjectRecord (index) {
  return {
    index,
    name: 'pms',
    description: 'PMS 工单',
    platform: 'feishu',
    tableId: 'tbl123',
    viewId: '',
    docNamePattern: 'PMS项目管理系统工单',
    hasAppToken: true,
    appTokenPreview: 'basc…Cnhh',
    sheetUrl: '',
    sheetName: '',
    statusColumn: '',
    statusValue: '',
    mediaPrefix: '',
    statusValues: ['否'],
    recordIds: ['rec1'],
    allowedImageHosts: ['cdn.example.com'],
    // 飞书电子表格（ADR-0005：与多维表格同一个 platform，靠表型分派）。
    // 形状与 src/remote/host.js 的 describeProject 一致 —— 那边已经把
    // `sheetColumns` 从一个对象摊成 `a=b, c=d` 一行文本了。
    spreadsheetToken: 'shtcnAbcd1234',
    sheetId: '',
    sheetHeaderRow: 1,
    sheetIdentity: 'seq',
    sheetIdColumn: '序号',
    sheetRange: '',
    sheetColumns: 'description=问题描述, status=是否处理',
    tableKind: '',
    repoPath: 'D:/WorkSpace/.repos/mgiot-pms',
    repoRemote: 'origin',
    repoBaseBranch: 'v2.x',
    repoTargetBranch: 'v2.x',
    remoteMrEnabled: true,
    // 工单 #19：GitLab 出口的三个定位字段现在也是可填字段（不是密钥，原样下发）。
    gitlabBaseUrl: 'https://gitlab.example.com',
    gitlabRemote: 'https://gitlab.example.com/platform/pms.git',
    gitlabProjectId: 'platform/pms',
    verifyBuild: 'pnpm build',
    verifyTest: 'pnpm test',
  }
}

function makeSettingsResponse () {
  return {
    ok: true,
    value: {
      writable: true,
      hasDocument: true,
      namespaces: [
        {
          ns: 'ticket-pipeline',
          autoGenerate: false,
          applies: 'live',
          revision: 7,
          schema: makeSchemaEnvelope(),
          value: {
            enabled: true,
            pollIntervalMinutes: 3,
            ticketTimeoutMinutes: 40,
            maxAttempts: 2,
            workExecutor: 'agent',
            provider: '',
            isolateWorktree: false,
            writeBack: true,
            writeBackStatus: '是',
            writeBackOnFailure: false,
            pushAdapter: 'qqmail',
            qqmail: { host: 'smtp.qq.com', encryption: 'tls', user: 'someone@qq.com' },
            pushplus: { channel: 'clawbot', callbackUrl: '' },
            notifyOn: ['done', 'skipped', 'failed', 'needs-info'],
            leaseTtlMinutes: 10,
            branchPrefix: 'ticket-',
          },
          // token 走凭据（PUSHPLUS_TOKEN / QQMAIL_AUTH_CODE），配置面里没有 secret 叶子了。
          secrets: [],
        },
      ],
    },
  }
}

// ── 假宿主 ────────────────────────────────────────────────────

/**
 * 假宿主。
 *
 * 关键点：**照抄真实 cordis 的服务模型**，不能想当然。
 *
 * - 命名空间服务（settings / credentials / ticketPipeline）在真实宿主里不是
 *   `remote` 对象的属性，而是**兄弟 fiber** 上 provide 的独立服务，服务名叫
 *   `remote.<ns>`（dsh-api-gateway 的 createNamespace）。
 * - cordis 的属性访问沿 fiber 链**向上**找 provide 过该名字的 fiber，找不到兄弟 ⇒
 *   抛 `cannot get property "remote.<ns>" without inject`。真实宿主里官方 bundle
 *   之所以能写 `ctx.remote.settings`，是因为它们在 inject 里声明了那个名字，
 *   让 reflect.props 登记过，属性访问才会被转发。
 * - 插件走的是 `ctx.get('remote.<ns>')`：ctx.get 查全局服务 store，不查 inject、
 *   不沿 fiber 链 ⇒ 兄弟 fiber provide 的服务照样取得到。
 *
 * 所以这里的假宿主必须用 `ctx.get(name)` 能按 'remote.<ns>' 取到服务，
 * 属性式 `ctx.remote.settings` 反而要**取不到**（取到就说明插件又退回了坏写法）。
 */
/**
 * 运行页签（#16）要用的队列快照夹具。
 *
 * 刻意放一张「要人处理的失败票」+ 一张「正在跑的票」：
 * 前者验「重跑」按钮挂没挂对地方，后者验「取消当前」可不可点。
 * tiers 由宿主算，这里照真实形状给 —— 面板不该自己数 phase。
 *
 * `withHistory` 为真时再补一张**终态票**，对应「勾上显示历史」那一屏：
 * 宿主 collectStatus 在 includeDone 时才把终态票放进来，面板只负责画。
 */
function makeRunSnapshot (withHistory) {
  return {
    enabled: true,
    view: 'tickets',
    projects: [],
    counts: withHistory === true ? { failed: 1, pending: 1, done: 1 } : { failed: 1, pending: 1 },
    filteredCounts: withHistory === true ? { failed: 1, pending: 1, done: 1 } : { failed: 1, pending: 1 },
    tiers: [
      { label: '需要你处理', count: 1 },
      { label: '待人工验证', count: 0 },
      { label: '正在跑', count: 1 },
      { label: '已交付', count: withHistory === true ? 1 : 0 },
      { label: '已退役', count: 0 },
    ],
    queue: { pendingCount: 1, runnableCount: 1, nextRecordId: 'recRunning001', orderRule: 'priority-desc', backoff: [] },
    tickets: (withHistory === true
      ? [
          {
            projectId: 'pms',
            recordId: 'recDoneOld',
            phase: 'done',
            phaseLabel: '已完成（已验证）',
            problemSummary: '上个月那张已经跑完的票',
            canReset: false,
            cancelledByUser: false,
            deliveryIssues: [],
          },
        ]
      : []).concat([
      {
        projectId: 'pms',
        recordId: 'recFailed001',
        phase: 'failed',
        phaseLabel: '失败',
        problemSummary: '登录页报 500',
        canReset: true,
        cancelledByUser: false,
        lastError: '模型说它不想干',
        deliveryIssues: [],
      },
      {
        projectId: 'pms',
        recordId: 'recRunning001',
        phase: 'editing',
        phaseLabel: '改代码',
        problemSummary: '列表翻页丢数据',
        canReset: false,
        cancelledByUser: false,
        deliveryIssues: [],
      },
    ]),
    config: {},
    text: '【流水线状态】',
  }
}

function makeHost () {
  const calls = {
    mutate: [], credentialSet: [], credentialUnset: [], doctor: 0, mounted: 0, projects: 0,
    pickDirectory: [], setProjectTable: [],
    // 运行页签（#16）四个新方法各记一份，断言要验「点了按钮有没有真的发出去」。
    status: 0, statusArgs: [], scan: 0, cancel: 0, reset: [],
  }
  // ctx.get(name) 查的「全局服务 store」。
  const services = Object.create(null)
  // gateway 服务自己维护的命名空间表（namespace → { service }）。
  const namespaces = new Map()

  // 宿主的 dsh-client-ui-workspace 服务：面板的「选择目录」按钮靠它。
  // 真实宿主里它挂在全局服务 store 上（ctx.get('uiWorkspace')），不是命名空间服务。
  // 缺省回一个固定路径；calls.pickDirectory 记下每次传进来的「当前值」，
  // 断言据此验证「选择器拿到的是人已经填在格子里的路径」。
  services.uiWorkspace = {
    pickDirectory: async (current) => {
      calls.pickDirectory.push({ current })
      return 'D:/picked/from/dialog'
    },
    listDirectory: async () => ({ entries: [] }),
    createDirectory: async (parent, name) => parent.replace(/[\\/]+$/, '') + '/' + name,
  }

  const settingsNamespace = {
    describe: async () => makeSettingsResponse(),
    mutate: async (ns, ops, revision) => {
      calls.mutate.push({ ns, ops, revision })
      // 一次性脚本化的拒绝：用来验证「宿主原话 + 指路 profile」这条文案。
      if (typeof calls.rejectNext === 'string') {
        const message = calls.rejectNext
        const code = calls.rejectNextCode || 'SETTINGS_REJECTED'
        calls.rejectNext = undefined
        calls.rejectNextCode = undefined
        return { ok: false, error: { code, message } }
      }
      return { ok: true, value: undefined }
    },
  }
  const credentialsNamespace = {
    describe: async (refs) => ({
      ok: true,
      value: Object.fromEntries(refs.map((ref) => [ref, { configured: ref === 'FEISHU_APP_ID', writable: true }])),
    }),
    set: async (ref, value) => { calls.credentialSet.push({ ref, value }); return { ok: true } },
    unset: async (ref) => { calls.credentialUnset.push(ref); return { ok: true } },
  }

  // 宿主 dsh-settings-controller 提供的两个命名空间（与插件无关，先就在那儿）。
  services['remote.settings'] = settingsNamespace
  services['remote.credentials'] = credentialsNamespace

  const remote = {
    namespaces,
    $mount: async (contribution) => {
      calls.mounted += 1
      check('$mount 收到的包名', contribution.package === '@local/ticket-pipeline', contribution.package)
      check('$mount 收到九个描述符', contribution.descriptors.length === 9, String(contribution.descriptors.length))
      check('第三个描述符是 projects',
        contribution.descriptors.some((item) => item.method === 'projects' &&
          item.result.typeSymbol === 'ticket-pipeline#ProjectList'),
        contribution.descriptors.map((item) => item.method).join(' | '))
      check('第四个描述符是 branches',
        contribution.descriptors.some((item) => item.method === 'branches' &&
          item.result.typeSymbol === 'ticket-pipeline#BranchList'),
        contribution.descriptors.map((item) => item.method).join(' | '))
      // 第五个是「粘贴工单表链接」（setProjectTable）：两个必填参数，宿主侧解析明文。
      check('第五个描述符是 setProjectTable（两个必填参数）',
        contribution.descriptors.some((item) => item.method === 'setProjectTable' &&
          item.result.typeSymbol === 'ticket-pipeline#ProjectWriteResult' &&
          item.parameters.length === 2 &&
          item.parameters.every((param) => param.codec?.mode === 'strict')),
        contribution.descriptors.map((item) => item.method).join(' | '))
      // 运行页签（#16）依赖的四个方法：scan / cancel 两个无参，status 一个可选参
      // （includeDone，就是面板上的「显示历史」），reset 一个必填一个可选。
      // 这里按 method 名字查，不按位置 —— 位置一挪，按位置写的断言会静默失效。
      check('描述符里有 scan / cancel 两个无参方法',
        ['scan', 'cancel'].every((name) => contribution.descriptors.some((item) =>
          item.method === name && item.parameters.length === 0 && item.invocation.kind === 'direct')),
        contribution.descriptors.map((item) => item.method).join(' | '))
      check('status 带一个可选参数 includeDone（面板「显示历史」开关）',
        contribution.descriptors.some((item) => {
          if (item.method !== 'status') return false
          if (item.parameters.length !== 1) return false
          const [includeDone] = item.parameters
          return includeDone.wire === 'includeDone' &&
            includeDone.acceptsUndefined === true &&
            includeDone.codec?.mode === 'strict'
        }),
        contribution.descriptors.map((item) => item.method).join(' | '))
      check('描述符里有 reset：recordId 必填、projectId 可选',
        contribution.descriptors.some((item) => {
          if (item.method !== 'reset') return false
          if (item.parameters.length !== 2) return false
          const [recordId, projectId] = item.parameters
          return recordId.wire === 'recordId' &&
            recordId.acceptsUndefined !== true &&
            projectId.wire === 'projectId' &&
            projectId.acceptsUndefined === true
        }),
        contribution.descriptors.map((item) => item.method).join(' | '))
      // 真实 gateway：$mount 会按 namespace 建一根兄弟 fiber，把命名空间服务
      // provide 成 'remote.ticketPipeline'，并记进自己的 namespaces 表。
      const service = {
        doctor: async () => {
          calls.doctor += 1
          return { ok: true, value: { ok: true, problems: [], warnings: ['mock 执行器'], text: '【环境体检】通过\n✅ git：可用' } }
        },
        config: async () => ({ ok: true, value: { config: {}, projects: 1 } }),
        projects: async () => {
          calls.projects += 1
          return { ok: true, value: { count: 1, projects: [makeProjectRecord(0)] } }
        },
        // 「粘贴工单表链接」：宿主解析并落盘。缺省成功，`calls.setProjectTable`
        // 记下每次的 (index, url) —— 断言要验的是「面板有没有把原样字符串发出去」，
        // 而不是「面板自己解析对了没有」（解析是宿主的事，见 host.js）。
        setProjectTable: async (index, url) => {
          calls.setProjectTable.push({ index, url })
          return { ok: true, value: { kind: 'bitable', note: '已记下这条多维表格的定位信息。' } }
        },
        // ── 运行页签（#16）─────────────────────────────────────────
        // status：缺省回一份「有一张要人处理的失败票」的队列快照 ——
        // 断言要验的是「票列表画出来没有、重跑按钮挂在哪一行」，
        // 所以夹具里必须有一张 canReset 为真的票。
        //
        // `includeDone` 会被原样记进 calls.statusArgs（断言验的是「开关有没有
        // 真的传到宿主」，不是「面板自己筛了没有」——筛选是宿主 collectStatus 的事）。
        // 传 true 时多回一张终态票，模拟「勾上显示历史后历史票出现」。
        status: async (includeDone) => {
          calls.status += 1
          calls.statusArgs.push(includeDone)
          return { ok: true, value: makeRunSnapshot(includeDone === true) }
        },
        scan: async () => {
          calls.scan += 1
          return { ok: true, value: { status: 'triggered', scan: null, ran: null, cleaned: false, text: '已触发这一轮（不等它跑完）。' } }
        },
        cancel: async () => {
          calls.cancel += 1
          return { ok: true, value: { cancelled: true, text: '已让当前这张票停下。' } }
        },
        reset: async (recordId) => {
          calls.reset.push(recordId)
          return { ok: true, value: { reset: true, reason: 'ok', recordId, projectId: 'pms', phase: 'pending', text: '已重开：下一轮轮询会把它当成一张新票重新跑。' } }
        },
      }
      namespaces.set('ticketPipeline', { service })
      services['remote.ticketPipeline'] = service
      return async () => {
        namespaces.delete('ticketPipeline')
        delete services['remote.ticketPipeline']
      }
    },
  }
  services.remote = remote

  return { remote, calls, services }
}

/**
 * 假 localStorage：面板用它记住分组折叠状态。
 *
 * 真实浏览器里有；沙箱里给一个内存版，顺便让断言能看到「有没有真的写进去」。
 */
let STORAGE = null

function makeStorage () {
  const data = Object.create(null)
  return {
    data,
    getItem (key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null },
    setItem (key, value) { data[key] = String(value) },
    removeItem (key) { delete data[key] },
  }
}

/** 把 bundle 加载进一个受限的 vm 上下文，返回它注册的模块出口。 */
async function loadBundle () {
  const source = await readFile(join(root, 'lib/client.js'), 'utf8')
  let registered
  STORAGE = makeStorage()
  const context = {
    window: {
      __ModuleLoader__: {
        load (registration) { registered = registration },
      },
    },
    document: {
      createElement: () => ({ dataset: {}, textContent: '', remove () {} }),
      head: { append () {} },
    },
    localStorage: STORAGE,
    console,
    // 插件会等宿主通道就绪（每 500ms 轮询一次），沙箱里没有定时器会直接 ReferenceError。
    setTimeout,
    clearTimeout,
  }
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'lib/client.js' })
  check('bundle 调用了 __ModuleLoader__.load', registered !== undefined)
  if (registered === undefined) return undefined
  check('模块 id 等于包名', registered.id === '@local/ticket-pipeline', registered.id)
  const React = makeReact()
  const exports = registered.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error('bundle 想 require 未提供的模块：' + specifier)
  })
  return exports
}

/**
 * 卸载：清掉 hook 表，下一次 render 就是一次全新挂载。
 * （hook 表在 render 之间是**保留**的，这样「点了保存 → 再渲染」能看见新状态。）
 */
function resetRender () {
  RENDER.hooks = []
  RENDER.effects = []
  RENDER.dirty = true
}

/** 把微任务队列抽干，让 effect 里发的 promise 有机会落回 setState。 */
async function settle () {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

/** 渲染一整棵树，跑到「没有新的 setState、也没有待跑的 effect」为止。 */
async function render (component, props) {
  RENDER.dirty = true
  let tree
  for (let round = 0; round < 40; round += 1) {
    RENDER.dirty = false
    RENDER.cursor = 0
    // 组件本身是函数 → 先调它（hook 在这里跑），再把返回的 element 树展开成
    // { type, props, children } 的普通对象，好让 findAll / textOf 直接遍历。
    tree = resolve(component(props))
    // 本轮渲染里新登记的 effect 在渲染之后跑（React 的时序也是这样）。
    const pending = RENDER.effects
    RENDER.effects = []
    for (const effect of pending) effect()
    await settle()
    if (!RENDER.dirty && RENDER.effects.length === 0) break
  }
  return tree
}

/** 递归渲染函数组件 / 展开 element 树。 */
function resolve (element) {
  if (element === null || element === undefined) return null
  if (typeof element === 'string' || typeof element === 'number') return element
  if (Array.isArray(element)) return element.map(resolve)
  if (typeof element.type === 'function') return resolve(element.type(element.props))
  return {
    type: element.type,
    props: element.props,
    children: (element.props.children || []).map(resolve),
  }
}

/** 深度遍历找元素。 */
function findAll (tree, predicate, out = []) {
  if (tree === null || tree === undefined) return out
  if (Array.isArray(tree)) { tree.forEach((node) => findAll(node, predicate, out)); return out }
  if (typeof tree !== 'object') return out
  if (predicate(tree)) out.push(tree)
  ;(tree.children || []).forEach((node) => findAll(node, predicate, out))
  return out
}

function textOf (node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}

function findButton (tree, label, className) {
  const buttons = findAll(tree, (node) => node.type === 'button')
  return buttons.find((button) => textOf(button).indexOf(label) >= 0 &&
    (className === undefined || String(button.props.className || '').indexOf(className) >= 0))
}

function findInput (tree, predicate) {
  const inputs = findAll(tree, (node) => node.type === 'input' || node.type === 'select')
  return inputs.find(predicate)
}

/**
 * 所有**配置分组**的折叠按钮（`.tp-group-toggle`）。
 *
 * 刻意只认这一种：项目卡片里的折叠（`.tp-proj-toggle`）与卡内分组在同一个页面上
 * 共存，用 `.tp-toggle` 一把捞的话，项目一多这个数就跟着变，「每个分组都有折叠
 * 标题」那条断言会莫名其妙地红，而且红得看不出是哪儿错了。
 */
function findToggles (tree) {
  return findAll(tree, (node) => node.type === 'button' &&
    String(node.props.className || '').indexOf('tp-group-toggle') >= 0)
}

/** 所有项目卡片的折叠按钮（`.tp-proj-toggle`）。 */
function findProjectToggles (tree) {
  return findAll(tree, (node) => node.type === 'button' &&
    String(node.props.className || '').indexOf('tp-proj-toggle') >= 0)
}

/** 把还收着的分组一一点开，返回展开后的树。 */
async function openAllGroups (Panel, tree) {
  let current = tree
  for (let round = 0; round < 12; round += 1) {
    const collapsed = findToggles(current).filter((node) => node.props['aria-expanded'] === 'false')
    if (collapsed.length === 0) break
    collapsed[0].props.onClick()
    current = await render(Panel, { view: 'page' })
  }
  return current
}

/** 顶部的分段页签（`.tp-tab`）。 */
function findTabs (tree) {
  return findAll(tree, (node) => node.type === 'button' &&
    String(node.props.className || '').indexOf('tp-tab') >= 0)
}

/**
 * 切到某个页签并重新渲染。
 *
 * 整页拆成四个页签之后，**只有当前页签的区块在树上** —— 断言「凭据区显示已配置」
 * 之前必须先切到「凭据」，否则找到的是一张项目卡片。这个 helper 就是为了让
 * 每条断言都明确说出「我在看哪一页」，而不是靠缺省页签碰运气。
 */
async function switchTab (Panel, label) {
  const current = await render(Panel, { view: 'page' })
  const tab = findTabs(current).find((node) => textOf(node).indexOf(label) >= 0)
  if (tab === undefined) throw new Error('找不到页签「' + label + '」：' + findTabs(current).map(textOf).join(' | '))
  tab.props.onClick()
  return render(Panel, { view: 'page' })
}

// ── 断言 ──────────────────────────────────────────────────────

async function main () {
  const exports = await loadBundle()
  if (exports === undefined) return finish()

  check('导出 name', exports.name === 'ticket-pipeline-settings', exports.name)
  // 硬依赖只留 slots：remote 由 dsh-api-gateway 提供，它自己还要等 typert / connection，
  // 写进 inject 会让本 fiber 停在 waiting for activation，apply 一次都不执行。
  check('inject 只硬依赖 slots', Array.isArray(exports.inject) &&
    exports.inject.indexOf('slots') >= 0 && exports.inject.indexOf('remote') < 0, JSON.stringify(exports.inject))

  // 收集 apply 注册的 slot。真宿主里 slot 是 plugin-manager 运行时声明的，
  // 声明没出现时 register 会抛错，所以插件必须走 slots.inject（声明出现才注册）。
  const registrations = []
  const injects = []
  const dispose = []
  const ctx = {
    // 真宿主里 ctx.get(name) 查的是全局服务 store：命名空间服务挂在 'remote.<ns>' 下，
    // 由兄弟 fiber provide。属性式 ctx.remote.settings 在真实宿主里取不到
    // （兄弟 fiber 不在祖先链上），这里也不提供，避免插件退回坏写法。
    get (name) { return services[name] },
    effect (fn) { dispose.push(fn()); return () => {} },
    slots: {
      inject (name, callback) {
        injects.push(name)
        callback()
        return () => {}
      },
      register (options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  const host = makeHost()
  const services = host.services
  ctx.calls = host.calls
  await exports.apply(ctx)

  // 5 个入口：settings.section / settings.plugins.tab / plugins.row.config ×2 / plugins.bundle.config
  check('apply 走 slots.inject 而不是裸 register（5 次）', injects.length === 5, injects.join(' | '))
  check('注册了 5 个 slot', registrations.length === 5, String(registrations.length))
  const slotId = registrations.map((r) => r.options.name + ':' + (r.options.key !== undefined ? r.options.key : '#' + r.options.id))
  check('注册了 plugins.row.config#包名#rowId',
    slotId.indexOf('plugins.row.config:@local/ticket-pipeline#ticket-pipeline') >= 0, slotId.join(' | '))
  check('注册了 plugins.bundle.config#包名',
    slotId.indexOf('plugins.bundle.config:@local/ticket-pipeline') >= 0, slotId.join(' | '))
  check('注册了 settings.section', slotId.indexOf('settings.section:#ticket-pipeline') >= 0, slotId.join(' | '))
  check('注册了 settings.plugins.tab', slotId.indexOf('settings.plugins.tab:#ticket-pipeline') >= 0, slotId.join(' | '))
  check('所有 slot 都有 key 或 id', registrations.every((r) => {
    const keyed = typeof r.options.key === 'string' && r.options.key.length > 0
    const listed = typeof r.options.id === 'string' && r.options.id.length > 0
    return keyed || listed
  }))

  const Panel = registrations.find((r) => r.options.name === 'plugins.row.config').component

  // ① 整页渲染：先看外壳（页签 + 工具条），再逐页看内容。
  resetRender()
  let tree = await render(Panel, { view: 'page' })

  // 整页拆成五个页签 —— 这是「太复杂」的解法：一次只摊开一块，其余收在标题里。
  // 「运行」排第一且是缺省页签（#16）：人打开设置页时的第一个问题几乎总是
  // 「现在跑得怎么样、要我做什么」。
  const tabs = findTabs(tree)
  check('顶部有五个页签', tabs.length === 5, tabs.map(textOf).join(' | '))
  // 页签文字可能带角标数字（运行页有「需要你处理」时挂 1），所以比对时
  // 只看标签本身：把 aria 与 badge 拆开，别让角标把文案断言带崩。
  const tabLabels = tabs.map((node) => String(node.props.children[0] ?? ''))
  check('页签是 运行 / 项目 / 参数 / 凭据 / 体检',
    tabLabels.join('|') === '运行|项目|参数|凭据|体检', tabLabels.join('|'))
  check('页签带 tablist 语义',
    findAll(tree, (node) => node.props && node.props.role === 'tablist').length === 1)
  check('缺省停在「运行」页签',
    tabs[0].props['aria-selected'] === 'true' && tabs.filter((node) => node.props['aria-selected'] === 'true').length === 1,
    tabs.map((node) => node.props['aria-selected']).join(','))

  // 一次只渲染一块：停在「运行」时参数区的字段不该在树上。
  check('非当前页签的内容不渲染', textOf(tree).indexOf('执行器') < 0, textOf(tree).slice(0, 120))

  // ── 运行页签（#16）─────────────────────────────────────────────
  //
  // 这一页的存在理由：人打开设置面板时的第一个问题是「现在跑得怎么样、
  // 要我做点什么」，以前这个答案只存在于对话里的 pipeline_status。
  // 断言只验「面板有没有把宿主给的东西画出来、按钮有没有真的发出去」——
  // 票列表、档位汇总、canReset 全是宿主办的，面板不重算。
  const runText = textOf(tree)
  check('运行页签画出流水线开关状态', runText.indexOf('流水线：已开启') >= 0, runText.slice(0, 240))
  check('运行页签画出档位汇总', runText.indexOf('需要你处理 1') >= 0, runText.slice(0, 240))
  check('运行页签按宿主的 tiers 画汇总（不自己数 phase）',
    runText.indexOf('汇总：需要你处理 1 · 待人工验证 0') >= 0, runText.slice(0, 240))
  check('运行页签列出票（recordId + 标题）',
    runText.indexOf('recFailed001') >= 0 && runText.indexOf('登录页报 500') >= 0, runText.slice(0, 400))
  check('运行页签显示队列里的下一个',
    runText.indexOf('下一个：recRunning001') >= 0, runText.slice(0, 400))
  check('运行页签的页签角标只数「需要你处理」', (() => {
    const badge = tabs[0].props.children[1]
    // 原生标签的 children 留在 props 里、不进 node.children（textOf 读不到），
    // 所以这里直接读 props.children —— 和「平台下拉里 wps 标了实验性」同一个坑。
    if (!badge || !badge.props) return false
    const label = Array.isArray(badge.props.children) ? badge.props.children.join('') : badge.props.children
    return String(label) === '1'
  })(), JSON.stringify(String(textOf(tabs[0]))))

  // 「重跑」只挂在 canReset 的票上：这张失败票有，那张正在跑的不该有。
  const rerunButton = findButton(tree, '重跑')
  check('失败票行尾有「重跑」按钮', rerunButton !== undefined)
  check('只有 canReset 的票才有「重跑」（正在跑的那张没有）',
    findAll(tree, (node) => node.type === 'button' && textOf(node).indexOf('重跑') >= 0).length === 1,
    String(findAll(tree, (node) => node.type === 'button' && textOf(node).indexOf('重跑') >= 0).length))

  // 展开详情：详情里的字段全部来自宿主返回体，面板只负责排版。
  const toggleRow = findAll(tree, (node) => node.type === 'button' &&
    String(node.props.className || '').indexOf('tp-run-toggle') >= 0)[0]
  check('找到票行（可展开的按钮）', toggleRow !== undefined)
  if (toggleRow !== undefined) {
    toggleRow.props.onClick()
    tree = await render(Panel, { view: 'page' })
    check('展开后能看到最近错误', textOf(tree).indexOf('模型说它不想干') >= 0, textOf(tree).slice(0, 400))
  }

  // 三个动作：跑一轮 / 取消当前 / 重跑。
  const scanButton = findButton(tree, '跑一轮')
  check('运行页签有「跑一轮」按钮', scanButton !== undefined)
  check('「跑一轮」按钮可用', scanButton !== undefined && scanButton.props.disabled === false,
    scanButton === undefined ? '没找到' : String(scanButton.props.disabled))
  if (scanButton !== undefined) {
    scanButton.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    tree = await render(Panel, { view: 'page' })
    check('点「跑一轮」调的是宿主 scan()', ctx.calls.scan === 1, String(ctx.calls.scan))
  }

  const cancelButton = findButton(tree, '取消当前')
  check('运行页签有「取消当前」按钮', cancelButton !== undefined)
  // 有票正在 editing，所以这时候该是能点的。
  check('有票在跑时「取消当前」可点',
    cancelButton !== undefined && cancelButton.props.disabled === false,
    cancelButton === undefined ? '没找到' : String(cancelButton.props.disabled))
  if (cancelButton !== undefined) {
    cancelButton.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    tree = await render(Panel, { view: 'page' })
    check('点「取消当前」调的是宿主 cancel()', ctx.calls.cancel === 1, String(ctx.calls.cancel))
  }

  const rerunAfter = findButton(tree, '重跑')
  if (rerunAfter !== undefined) {
    rerunAfter.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    tree = await render(Panel, { view: 'page' })
    check('点「重跑」调的是宿主 reset(recordId)，只传一个参数',
      ctx.calls.reset.length === 1 && ctx.calls.reset[0] === 'recFailed001',
      JSON.stringify(ctx.calls.reset))
  }

  // 「显示历史」开关：缺省关着（这一屏先回答「还要我做什么」），
  // 勾上要把 includeDone=true 传给宿主，并且历史票出现在列表里。
  // 断言验的是「开关有没有真的传到宿主」—— 筛选是 collectStatus 的事，面板不重算。
  check('运行页签有「显示历史」开关，且缺省是关的',
    (() => {
      const box = findInput(tree, (node) => node.props.type === 'checkbox')
      return box !== undefined && box.props.checked === false
    })(),
    JSON.stringify(findAll(tree, (node) => node.props && node.props.type === 'checkbox').map((node) => node.props.checked)))
  check('缺省（没勾历史）传给宿主的是 includeDone=false',
    ctx.calls.statusArgs.length > 0 && ctx.calls.statusArgs[ctx.calls.statusArgs.length - 1] === false,
    JSON.stringify(ctx.calls.statusArgs))
  check('缺省那一屏不含已收尾的老票', textOf(tree).indexOf('recDoneOld') < 0, textOf(tree).slice(0, 200))

  const historyBox = findInput(tree, (node) => node.props.type === 'checkbox')
  if (historyBox !== undefined) {
    historyBox.props.onChange({ target: { checked: true } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    tree = await render(Panel, { view: 'page' })
    check('勾上「显示历史」后传给宿主 includeDone=true',
      ctx.calls.statusArgs[ctx.calls.statusArgs.length - 1] === true,
      JSON.stringify(ctx.calls.statusArgs))
    check('勾上「显示历史」后终态票出现在列表里',
      textOf(tree).indexOf('recDoneOld') >= 0, textOf(tree).slice(0, 400))
    // 再点掉：状态要回到 false，且立刻按新口径重读一次。
    const again = findInput(tree, (node) => node.props.type === 'checkbox')
    if (again !== undefined) {
      again.props.onChange({ target: { checked: false } })
      await new Promise((resolve) => setTimeout(resolve, 0))
      tree = await render(Panel, { view: 'page' })
      check('再点掉「显示历史」后回到 includeDone=false',
        ctx.calls.statusArgs[ctx.calls.statusArgs.length - 1] === false,
        JSON.stringify(ctx.calls.statusArgs))
    }
  }

  check('渲染了保存按钮', findButton(tree, '保存', 'tp-primary') !== undefined)
  check('工具条上的「放弃改动」在', findButton(tree, '放弃改动') !== undefined)
  check('工具条上的「重新载入」在', findButton(tree, '重新载入') !== undefined)

  // ② 参数页：24 个配置项一屏放不下，默认只展开「行为」，其余收着。
  tree = await switchTab(Panel, '参数')
  const toggles = findToggles(tree)
  check('每个分组都有折叠标题', toggles.length === 3, String(toggles.length))
  const toggleOf = (label) => toggles.find((node) => textOf(node).indexOf(label) >= 0)
  check('默认展开「行为」', toggleOf('行为') !== undefined &&
    toggleOf('行为').props['aria-expanded'] === 'true')
  check('默认收起「通知」', toggleOf('通知') !== undefined &&
    toggleOf('通知').props['aria-expanded'] === 'false')

  // 收着的分组不该把字段渲染出来（否则折叠只是视觉假象）。
  check('收起的分组不渲染字段', textOf(tree).indexOf('租约存活') < 0)

  tree = await openAllGroups(Panel, tree)
  const inputs = findAll(tree, (node) => node.type === 'input' || node.type === 'select')
  // 「参数」页签只有配置项，凭据的 5 个密码框不再混进来 —— 拆页签之前这条断言
  // 之所以能过，是因为凭据区也画在同一页上（≥7 里有一半是密码框）。
  check('展开后渲染出输入控件', inputs.length >= 6, '只有 ' + inputs.length + ' 个')
  const bodyText = textOf(tree)
  check('显示分组标题「通知」', bodyText.indexOf('通知') >= 0)
  check('显示布尔字段', bodyText.indexOf('总开关') >= 0)
  check('显示 enum 字段', bodyText.indexOf('执行器') >= 0)
  check('显示点号键的嵌套叶子', bodyText.indexOf('SMTP 主机') >= 0)

  // ── 总开关置顶 ────────────────────────────────────────────────
  //
  // 它原来埋在「杂项」组最底下，而缺省只展开一组 —— 新人装完打开面板找不到
  // 「怎么开始」。现在它不属于任何组，画在卡片最上面。
  tree = await switchTab(Panel, '参数')
  const masterSwitch = findAll(tree, (node) => node.props && node.props.role === 'switch' &&
    node.props['aria-label'] === '总开关')[0]
  check('总开关是一个独立的开关（不在任何分组里）', masterSwitch !== undefined)
  check('总开关带「已开启/已关闭」的人话状态',
    textOf(tree).indexOf('已开启：会按下面的间隔自动扫表跑票') >= 0, textOf(tree).slice(0, 200))
  // 「在分组上面」= 文档顺序里它出现在第一个分组标题之前。
  const firstGroupIdx = textOf(tree).indexOf('行为')
  const masterIdx = textOf(tree).indexOf('总开关')
  check('总开关画在第一个分组之前（置顶）', masterIdx >= 0 && firstGroupIdx > masterIdx,
    'master@' + masterIdx + ' group@' + firstGroupIdx)

  // 缺省第一屏（只展开「行为」）就该有足够多的控件，且包含主要旋钮。
  const firstScreenInputs = findAll(tree, (node) => node.type === 'input' || node.type === 'select')
  check('缺省第一屏可见控件 ≥9', firstScreenInputs.length >= 9, '只有 ' + firstScreenInputs.length + ' 个')
  const firstScreenText = textOf(tree)
  check('第一屏能看到执行器', firstScreenText.indexOf('执行器') >= 0)
  check('第一屏能看到轮询间隔', firstScreenText.indexOf('轮询间隔') >= 0)
  check('第一屏能看到单票超时', firstScreenText.indexOf('单票超时') >= 0)
  check('第一屏能看到最大重试次数（不再藏在高级里）',
    firstScreenText.indexOf('最大重试次数') >= 0)

  // ── 枚举字段用中文标签，值仍是原值 ──────────────────────────
  const executorSelect = findAll(tree, (node) => node.type === 'select').find(
    (node) => textOf(node).indexOf('agent（真的改代码）') >= 0)
  check('执行器下拉用中文说法', executorSelect !== undefined)
  if (executorSelect !== undefined) {
    const optionValues = executorSelect.children.map((opt) => opt.props.value)
    check('中文标签不影响写下去的值', optionValues.join(',') === 'agent,mock', optionValues.join(','))
  }

  // ── 通知组按 pushAdapter 条件显隐 ────────────────────────────
  //
  // 假数据里 pushAdapter = qqmail：看得见 SMTP，看不见 PushPlus 的字段。
  tree = await openAllGroups(Panel, tree)
  const qqText = textOf(tree)
  check('选 qqmail 时露出 SMTP 字段', qqText.indexOf('SMTP 主机') >= 0)
  check('选 qqmail 时不显示 PushPlus 的字段', qqText.indexOf('PushPlus 渠道') < 0, qqText.slice(0, 200))
  check('通知组顶部有一句当前通道说明',
    qqText.indexOf('当前走 QQ 邮箱') >= 0, qqText.slice(0, 200))

  // 换成 mock：两个真实通道的字段都收起来，只留一句「不会真发」。
  const adapterSelect = findAll(tree, (node) => node.type === 'select').find(
    (node) => textOf(node).indexOf('QQ 邮箱') >= 0)
  check('找到通知适配器下拉', adapterSelect !== undefined)
  if (adapterSelect !== undefined) {
    adapterSelect.props.onChange({ target: { value: 'mock' } })
    tree = await render(Panel, { view: 'page' })
    tree = await openAllGroups(Panel, tree)
    const mockText = textOf(tree)
    check('换成 mock 后不显示 SMTP 字段', mockText.indexOf('SMTP 主机') < 0)
    check('换成 mock 后不显示 PushPlus 字段', mockText.indexOf('PushPlus 渠道') < 0)
    check('换成 mock 后明说「不会真的发通知」',
      mockText.indexOf('不会真的发通知') >= 0, mockText.slice(0, 200))
  }

  // 抽屉式的高级区不该被当成配置分组数进 `findToggles` 里。
  check('「高级设置」不是配置分组',
    findAll(tree, (node) => node.type === 'button' &&
      String(node.props.className || '').indexOf('tp-adv-toggle') >= 0).length >= 1)

  // ── 高级键「改过或有错」必须自动露出来 ────────────────────────
  //
  // 否则折叠就成了遮蔽：用户改了 `租约存活`（高级键），收起高级区之后
  // 看不见这一改动，却能在保存时把一项自己都不记得的改动写下去。
  {
    const advBefore = textOf(tree)
    check('高级键缺省收在「高级设置」里（租约存活默认看不见）',
      advBefore.indexOf('高级设置') >= 0)
    // 打开所有「高级设置」抽屉（通知组里也有一个：pushplus.callbackUrl）。
    const advToggles = () => findAll(tree, (node) => node.type === 'button' &&
      String(node.props.className || '').indexOf('tp-adv-toggle') >= 0)
    for (const toggle of advToggles()) {
      toggle.props.onClick()
      tree = await render(Panel, { view: 'page' })
    }
    tree = await openAllGroups(Panel, tree)
    for (const toggle of advToggles()) {
      if (toggle.props['aria-expanded'] !== 'true') {
        toggle.props.onClick()
        tree = await render(Panel, { view: 'page' })
      }
    }
    const leaseInput = findInput(tree, (node) => node.props.type === 'number' && node.props.value === '10')
    check('展开高级区后能看到「租约存活」', leaseInput !== undefined)
    if (leaseInput !== undefined) {
      leaseInput.props.onChange({ target: { value: '20' } })
      tree = await render(Panel, { view: 'page' })
      // 再把所有抽屉收起来 —— 改过的那一项必须还露在外面。
      for (const toggle of advToggles()) {
        if (toggle.props['aria-expanded'] === 'true') {
          toggle.props.onClick()
          tree = await render(Panel, { view: 'page' })
        }
      }
      const advAfter = textOf(tree)
      check('改过的高级键收起高级区后仍然露出来',
        advAfter.indexOf('租约存活') >= 0, advAfter.slice(0, 300))
      check('改过的高级键带「已改」标记', advAfter.indexOf('已改') >= 0)
    }
  }

  // 折叠状态记进 localStorage，下次打开还是上次的样子。
  const openRaw = STORAGE.getItem('ticket-pipeline:open-groups')
  check('折叠状态写进了 localStorage', typeof openRaw === 'string' && openRaw.indexOf('通知') >= 0, String(openRaw))

  // 页签选择也记下来 —— 下次进来还停在刚才那一页。
  check('页签选择写进了 localStorage',
    STORAGE.getItem('ticket-pipeline:open-tab') === 'params',
    String(STORAGE.getItem('ticket-pipeline:open-tab')))

  // ② 改一个数字字段再保存 → 生成一条 path 是数组的 set op。
  const interval = findInput(tree, (node) => node.props.type === 'number')
  check('找到数字输入框', interval !== undefined)
  check('数字字段带 min/max 约束', interval.props.min === 1 && interval.props.max === 60,
    String(interval.props.min) + '–' + String(interval.props.max))
  check('数字字段渲染出约束提示', bodyText.indexOf('1–60') >= 0, bodyText.slice(0, 200))

  // 越界 → 即时标红 + 禁用保存，而不是等宿主拒绝。
  interval.props.onChange({ target: { value: '99' } })
  tree = await render(Panel, { view: 'page' })
  check('数字越界时给出「不能大于 60」', textOf(tree).indexOf('不能大于 60') >= 0, textOf(tree).slice(0, 300))
  const outOfRange = findButton(tree, '保存', 'tp-primary')
  check('数字越界时保存被禁用', outOfRange !== undefined && outOfRange.props.disabled === true,
    outOfRange === undefined ? '没找到保存按钮' : String(outOfRange.props.disabled))

  tree = await render(Panel, { view: 'page' })
  // 控件是真实 DOM 元素，onChange 收的是事件对象而不是裸值。
  findInput(tree, (node) => node.props.type === 'number').props.onChange({ target: { value: '9' } })
  tree = await render(Panel, { view: 'page' })
  // 凭据行也有「保存」按钮，这里要的是配置区那个主按钮（tp-primary）。
  const save = findButton(tree, '保存', 'tp-primary')
  check('找到保存主按钮', save !== undefined)
  save.props.onClick()
  tree = await render(Panel, { view: 'page' })
  check('保存调用了 settings.mutate', ctx.calls.mutate.length === 1, String(ctx.calls.mutate.length))
  if (ctx.calls.mutate.length > 0) {
    const call = ctx.calls.mutate[0]
    check('mutate 的 ns 是 ticket-pipeline', call.ns === 'ticket-pipeline', call.ns)
    check('mutate 带上了读到的 revision', call.revision === 7, String(call.revision))
    const op = call.ops.find((item) => item.path.join('.') === 'pollIntervalMinutes')
    check('生成了 pollIntervalMinutes 的 set op', op !== undefined, JSON.stringify(call.ops))
    if (op !== undefined) {
      check('op 是 set', op.op === 'set', op.op)
      check('path 是数组而不是点号键', Array.isArray(op.path) && op.path.length === 1, JSON.stringify(op.path))
      check('值被转成 number', op.value === 9, JSON.stringify(op.value))
    }
  }

  // ③ 点「立即体检」→ 调自建 Remote。体检已经是一个页签，按钮在页签里。
  // apply 里就该把命名空间挂好（面板一打开按钮就能点），不该靠组件 effect 兜底。
  check('apply 里挂载了 ticketPipeline 命名空间（只挂一次）', ctx.calls.mounted === 1, String(ctx.calls.mounted))
  check('apply 之后命名空间已就绪', services['remote.ticketPipeline'] !== undefined)
  tree = await switchTab(Panel, '体检')
  const doctor = findButton(tree, '立即体检')
  check('体检页签里有「立即体检」按钮', doctor !== undefined)
  check('体检按钮可用', doctor !== undefined && doctor.props.disabled === false,
    doctor === undefined ? '没找到' : String(doctor.props.disabled))
  doctor.props.onClick()
  tree = await render(Panel, { view: 'page' })
  check('调用了 ticketPipeline.doctor', ctx.calls.doctor === 1, String(ctx.calls.doctor))
  check('渲染出体检报告', textOf(tree).indexOf('【环境体检】') >= 0)

  // ④ 凭据区：已配置项显示「已配置」，写一个值再保存 → credentials.set。
  tree = await switchTab(Panel, '凭据')
  check('凭据区显示已配置', textOf(tree).indexOf('已配置') >= 0)
  const secretInputs = findAll(tree, (node) => node.type === 'input' && node.props.type === 'password')
  check('凭据输入框是只写密码框', secretInputs.length >= 5, String(secretInputs.length))
  // 凭据不再有每行的「保存」按钮（统一走顶部主保存）——全树只能剩一个「保存」，
  // 多出来的就是漏删的行内按钮。
  const saveButtons = findAll(tree, (node) => node.type === 'button' &&
    (node.props.children === '保存' || textOf(node) === '保存'))
  check('凭据每行不再有「保存」按钮', saveButtons.length === 1, String(saveButtons.length))
  check('凭据行的「清除」带二次确认',
    findAll(tree, (node) => node.type === 'button' && textOf(node) === '清除').length >= 1)

  // ⑤ 项目清单：读的是 remote.projects() 的只读投影，写的是深层路径 mutate。
  tree = await switchTab(Panel, '项目')
  check('渲染出「项目清单」', textOf(tree).indexOf('项目清单') >= 0)
  check('项目卡片显示项目名', textOf(tree).indexOf('pms') >= 0)
  // 工单 #19：MR 是实验性能力，徽标必须带「实验性」三个字，不能让人以为这是主推的交付形态。
  check('项目卡片标注了 MR 开关（且明说是实验性）', textOf(tree).indexOf('MR（实验性）') >= 0)
  check('appToken 只显示打码预览', textOf(tree).indexOf('basc…Cnhh') >= 0)
  check('appToken 没有明文输入框',
    findAll(tree, (node) => node.type === 'input' &&
      typeof node.props.value === 'string' && node.props.value.indexOf('basc') >= 0).length === 0)
  // 「粘贴工单表链接」：唯一能把 appToken 写进配置的入口。面板只把原样字符串
  // 交给宿主（`setProjectTable`），自己不做任何解析 —— 一旦在浏览器里解析出
  // appToken，明文就进了浏览器内存与请求体，那条安全边界就破了。
  check('项目卡片里有「工单表链接」输入框',
    textOf(tree).indexOf('工单表链接') >= 0)
  const linkInput = findInput(tree, (node) => typeof node.props.placeholder === 'string' &&
    node.props.placeholder.indexOf('feishu.cn') >= 0)
  check('工单表链接是一个可以直接贴链接的输入框', linkInput !== undefined)
  check('工单表链接有「用这条链接」按钮', findButton(tree, '用这条链接') !== undefined)
  const pastedUrl = 'https://pms.feishu.cn/base/bascnABCDEFGH?table=tblXYZ&view=vew1'
  if (linkInput !== undefined) {
    linkInput.props.onChange({ target: { value: pastedUrl } })
    tree = await render(Panel, { view: 'page' })
    const submitLink = findButton(tree, '用这条链接')
    check('贴了链接之后按钮变成可点', submitLink !== undefined && submitLink.props.disabled !== true)
    if (submitLink !== undefined) submitLink.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    tree = await render(Panel, { view: 'page' })
    check('粘链接调的是宿主 setProjectTable(0, 原样 URL)',
      ctx.calls.setProjectTable.length === 1 &&
      ctx.calls.setProjectTable[0].index === 0 &&
      ctx.calls.setProjectTable[0].url === pastedUrl,
      JSON.stringify(ctx.calls.setProjectTable))
    check('粘链接不经过 settings.mutate（明文不走浏览器写配置那条路）',
      ctx.calls.mutate.every((call) => JSON.stringify(call.ops).indexOf('bascnABCDEFGH') < 0),
      JSON.stringify(ctx.calls.mutate.map((call) => call.ops)))
    check('宿主回话显示在卡片里', textOf(tree).indexOf('已记下这条多维表格的定位信息') >= 0)
  }
  check('调用了 ticketPipeline.projects', ctx.calls.projects >= 1, String(ctx.calls.projects))
  // projects 是结构化数组，必须由 ProjectListCard 画成卡片 —— 要是漏成普通字段，
  // draftValueOf 会把对象数组 join 成 '[object Object], [object Object]'。
  check('项目清单没有被渲染成字符串',
    textOf(tree).indexOf('[object Object]') < 0, textOf(tree).slice(0, 60))
  check('项目清单是卡片列表而不是文本框',
    findAll(tree, (node) => node.type === 'input' &&
      typeof node.props.value === 'string' &&
      node.props.value.indexOf('[object Object]') >= 0).length === 0)
  // 21 个字段分 5 节，节标题得真的渲染出来，否则一屏全是输入框没法看。
  // 「验证命令」整组是高级项（`advanced: true`），缺省不画 —— 要看全得勾
  // 「显示全部字段」，所以这里连那条路径一起验。
  check('项目清单有「添加项目」按钮', findButton(tree, '+ 添加项目') !== undefined)
  check('项目卡片有「删除」按钮', findButton(tree, '删除') !== undefined)
  check('项目卡片分了「仓库」一节', textOf(tree).indexOf('仓库') >= 0)
  check('缺省不显示高级组「验证命令」', textOf(tree).indexOf('验证命令') < 0)
  // 工单 #19：GitLab 出口整组是实验性能力，缺省一个字都不出现 ——
  // 99% 的人只用本地提交，把这个能力摆到第一屏就是把错的东西当主角。
  check('缺省不显示「远程 MR（实验性）」整组', textOf(tree).indexOf('远程 MR') < 0)
  check('缺省不出现 GitLab 站点 / projectId 的输入框',
    textOf(tree).indexOf('GitLab 站点') < 0 && textOf(tree).indexOf('GitLab projectId') < 0)
  const advLabel = findAll(tree, (node) => node.type === 'label' &&
    textOf(node).indexOf('显示全部字段') >= 0)[0]
  const advToggle = advLabel === undefined
    ? undefined
    : findAll(advLabel, (node) => node.type === 'input')[0]
  check('有「显示全部字段」开关', advToggle !== undefined)
  if (advToggle !== undefined) {
    advToggle.props.onChange({ target: { checked: true } })
    tree = await render(Panel, { view: 'page' })
    check('勾上后显示高级组「验证命令」', textOf(tree).indexOf('验证命令') >= 0)
    // 三个定位字段必须真能填：以前只有 enabled 画得出来，另外三个只能手改 YAML，
    // 结果就是「这个能力开得起来但配不出来」——那才叫荒谬。
    check('勾上后显示「远程 MR（实验性）」整组', textOf(tree).indexOf('远程 MR') >= 0)
    check('勾上后能填 GitLab 站点', textOf(tree).indexOf('GitLab 站点') >= 0)
    check('勾上后能填 GitLab projectId', textOf(tree).indexOf('GitLab projectId') >= 0)
    const glBase = findAll(tree, (node) => node.type === 'input' &&
      node.props.value === 'https://gitlab.example.com')[0]
    check('GitLab 站点能带出宿主下发的当前值（不是空框）', glBase !== undefined)
  }

  // 工单 #20：金山源是实验性的。下拉里就得写出来，切过去还要在卡片顶部给一条醒目提示 ——
  // 这条提示的后果是「配完了什么都没发生」，不在这里说，人只会以为插件坏了。
  const platformSelect = findAll(tree, (node) => node.type === 'select').find(
    (node) => Array.isArray(node.props.children) &&
      node.props.children.some((option) => option.props && option.props.value === 'wps'))
  check('找到平台下拉', platformSelect !== undefined)
  if (platformSelect !== undefined) {
    const wpsOption = platformSelect.props.children.find(
      (option) => option.props && option.props.value === 'wps')
    // ⚠️ 这里读的是 `props.children` 而不是 `textOf()`：`props` 保留的是 createElement
    // 收到的原始 element，`option` 的文本挂在它自己的 props.children 上，顶层没有 `children`。
    const wpsLabel = String((wpsOption.props.children || []).join(''))
    check('平台下拉里 wps 标了「实验性」（值仍是裸 wps）',
      wpsOption !== undefined && wpsOption.props.value === 'wps' && wpsLabel.indexOf('实验性') >= 0,
      wpsOption === undefined ? 'no option' : wpsLabel)
    platformSelect.props.onChange({ target: { value: 'wps' } })
    tree = await render(Panel, { view: 'page' })
    const wpsText = textOf(tree)
    check('切到 wps 后卡片顶部有「没有内置取数通道」的醒目提示',
      wpsText.indexOf('没有内置取数通道') >= 0, wpsText.slice(0, 300))
    check('提示里明说「拿不到票」+ 该改用飞书',
      wpsText.indexOf('拿不到') >= 0 && wpsText.indexOf('feishu') >= 0)
    // 切回 feishu：提示必须消失（它不是常驻噪音）。
    // 注意不能拿「没有内置取数通道」当判据 —— 平台字段的 hint 里也有这半句，永远命中。
    platformSelect.props.onChange({ target: { value: 'feishu' } })
    tree = await render(Panel, { view: 'page' })
    check('切回 feishu 后那条实验性提示消失',
      textOf(tree).indexOf('直接用它收不到任何工单') < 0)
  }

  // 布尔字段统一换成 role="switch" 的开关（宿主 practices.md 要求保留 aria-checked 语义）。
  const switches = findAll(tree, (node) => node.props && node.props.role === 'switch')
  check('布尔字段渲染成 Switch 开关', switches.length >= 1, String(switches.length))
  check('Switch 带 aria-checked 语义',
    switches.every((node) => node.props['aria-checked'] === 'true' || node.props['aria-checked'] === 'false'))
  // 页面上唯一剩下的原生 checkbox 只能是项目清单的「显示全部字段」筛选 —— 布尔
  // 配置项一律走 Switch，不能有一条漏回原生勾选框。
  const plainChecks = findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox')
  check('布尔配置项不落回原生 checkbox', plainChecks.length <= 1, String(plainChecks.length))
  // 顶部只留一颗主按钮（「保存」）—— 卡片里那套「保存/放弃改动」必须删干净。
  const primaryButtons = findAll(tree, (node) => node.type === 'button' &&
    typeof node.props.className === 'string' && node.props.className.indexOf('tp-primary') >= 0)
  check('全页只有一颗主按钮', primaryButtons.length === 1, String(primaryButtons.length))
  check('主按钮在操作条最右（主操作落在视线终点）',
    primaryButtons.length === 1 && textOf(primaryButtons[0]) === '保存')

  const repoInput = findInput(tree, (node) => node.props.value === 'D:/WorkSpace/.repos/mgiot-pms')
  check('找到项目仓库路径输入框', repoInput !== undefined)
  repoInput.props.onChange({ target: { value: 'D:/WorkSpace/.repos/mgiot-pms2' } })
  tree = await render(Panel, { view: 'page' })
  check('改过的项目字段标「已改」', textOf(tree).indexOf('已改') >= 0)
  check('改过的项目字段有单字段撤销', findButton(tree, '撤销') !== undefined)

  // 撤销只回退这一个字段，别的改动不受影响。
  findButton(tree, '撤销').props.onClick()
  tree = await render(Panel, { view: 'page' })
  check('单字段撤销把值还原成 profile 里的值',
    findInput(tree, (node) => node.props.value === 'D:/WorkSpace/.repos/mgiot-pms') !== undefined,
    '撤销后没回到原值')
  findInput(tree, (node) => node.props.value === 'D:/WorkSpace/.repos/mgiot-pms')
    .props.onChange({ target: { value: 'D:/WorkSpace/.repos/mgiot-pms2' } })
  tree = await render(Panel, { view: 'page' })

  const saveProject = findButton(tree, '保存', 'tp-primary')
  saveProject.props.onClick()
  tree = await render(Panel, { view: 'page' })
  check('保存项目改动也走 settings.mutate', ctx.calls.mutate.length === 2, String(ctx.calls.mutate.length))
  const projectCall = ctx.calls.mutate[1]
  if (projectCall !== undefined) {
    check('项目改动只发一条 op（只写改过的字段）', projectCall.ops.length === 1, JSON.stringify(projectCall.ops))
    const op = projectCall.ops[0]
    check('项目 op 是 set', op.op === 'set', op.op)
    check('项目 op 走深层路径而不是整数组替换',
      JSON.stringify(op.path) === JSON.stringify(['projects', '0', 'repo', 'path']), JSON.stringify(op.path))
    check('项目 op 的值是改后的路径', op.value === 'D:/WorkSpace/.repos/mgiot-pms2', JSON.stringify(op.value))
    check('项目 op 复用了读到的 revision', projectCall.revision === 7, String(projectCall.revision))
    // 整笔 op 的共性约束：每条都是 projects 的深层路径，没有整数组替换。
    // `['projects']` 会被宿主判成 not volatile 整笔拒掉；`['projects','0']` 则会抹掉
    // 这个项目里没画出来的字段（appToken、repo.gitlab.* 这些）。
    check('每条项目 op 都带 projects 前缀', projectCall.ops.every((item) => item.path[0] === 'projects'),
      JSON.stringify(projectCall.ops.map((item) => item.path)))
    check('每条项目 op 至少三段路径（项目下标 + 字段）', projectCall.ops.every((item) => item.path.length >= 3),
      JSON.stringify(projectCall.ops.map((item) => item.path)))
    check('没有整数组替换的浅路径 op',
      projectCall.ops.every((item) => !(item.path.length === 1 && item.path[0] === 'projects') &&
        !(item.path.length === 2 && item.path[0] === 'projects')),
      JSON.stringify(projectCall.ops.map((item) => item.path)))
  }

  // 保存成功后草稿回到宿主刚读到的值（不是还留着刚才那笔改动）。
  check('保存成功后不再显示「已改」',
    findInput(tree, (node) => node.props.value === 'D:/WorkSpace/.repos/mgiot-pms2') === undefined,
    '草稿没被刷新')

  // 兜底路径：宿主把 projects 整段判成不可写时，回的是 `Config field "projects"
  // is not declared` 这种底层文案。原文要照贴（不然人不知道发生了什么），
  // 还要补一句能照着做的。正常深层路径写入不会走到这里，这条是防回归。
  findInput(tree, (node) => node.props.value === 'D:/WorkSpace/.repos/mgiot-pms')
    .props.onChange({ target: { value: 'D:/WorkSpace/.repos/mgiot-pms3' } })
  tree = await render(Panel, { view: 'page' })
  ctx.calls.rejectNext = 'Config field "projects" is not declared'
  findButton(tree, '保存', 'tp-primary').props.onClick()
  tree = await render(Panel, { view: 'page' })
  const rejectedText = textOf(tree)
  check('保存被拒时原样显示宿主文案', rejectedText.indexOf('Config field "projects" is not declared') >= 0,
    rejectedText.slice(0, 300))
  check('保存被拒时给一句能照着做的', rejectedText.indexOf('cordis.patch.yml') >= 0)

  // 版本冲突：最关键的不是「请重试」，而是**你刚才改的那几项没存进去**。
  // 说清条数，人才知道要不要重新一项项改回去。
  ctx.calls.rejectNext = 'settings revision mismatch'
  ctx.calls.rejectNextCode = 'SETTINGS_CONFLICT'
  findButton(tree, '保存', 'tp-primary').props.onClick()
  tree = await render(Panel, { view: 'page' })
  const conflictText = textOf(tree)
  check('冲突文案说「已重新载入」', conflictText.indexOf('已重新载入') >= 0, conflictText.slice(0, 300))
  check('冲突文案报出「没保存的项数」', /你刚才那 \d+ 项改动没有保存/.test(conflictText),
    conflictText.slice(0, 300))

  // 服务端的「字段级」拒绝：挂到具体字段下面，并且把保存锁住；
  // 人重填这个字段之后旧抱怨必须消失，否则改对了也还是存不了。
  findInput(tree, (node) => node.props.value === 'D:/WorkSpace/.repos/mgiot-pms3')
    .props.onChange({ target: { value: 'D:/WorkSpace/.repos/mgiot-pms4' } })
  tree = await render(Panel, { view: 'page' })
  ctx.calls.rejectNext = 'invalid config:\n'
    + '  - projects[0].repo.path 必须是非空字符串（本地 git 检出根目录） (at projects.0.repo.path)'
  findButton(tree, '保存', 'tp-primary').props.onClick()
  tree = await render(Panel, { view: 'page' })
  const fieldRejected = textOf(tree)
  check('字段级拒绝挂到字段下方', fieldRejected.indexOf('必须是非空字符串（本地 git 检出根目录）') >= 0,
    fieldRejected.slice(0, 300))
  // 光说「保存失败」不够：下面几十个字段里哪一个是红的、有几项，得先说出来。
  check('保存被拒时先说有几项没通过校验', /有 \d+ 项没通过校验，已在下方标红/.test(fieldRejected),
    fieldRejected.slice(0, 300))
  check('被服务端拒绝后保存被锁住',
    findButton(tree, '保存', 'tp-primary').props.disabled === true)
  findInput(tree, (node) => node.props.value === 'D:/WorkSpace/.repos/mgiot-pms4')
    .props.onChange({ target: { value: 'D:/WorkSpace/.repos/mgiot-pms5' } })
  tree = await render(Panel, { view: 'page' })
  check('重填字段后服务端旧抱怨被清掉',
    textOf(tree).indexOf('必须是非空字符串（本地 git 检出根目录）') < 0, textOf(tree).slice(0, 300))
  check('重填字段后保存重新可用',
    findButton(tree, '保存', 'tp-primary').props.disabled === false)

  // 列表字段（statusValues / recordIds / allowedImageHosts）界面上是逗号分隔的一行文本，
  // 发出去的必须是数组 —— 宿主那边这两种形态都收，但数组才是它写的形状。
  const listInput = findInput(tree, (node) => node.props.value === '否')
  check('找到逗号分隔的列表字段', listInput !== undefined)
  listInput.props.onChange({ target: { value: '否, 在处理 , 否' } })
  tree = await render(Panel, { view: 'page' })
  findButton(tree, '保存', 'tp-primary').props.onClick()
  tree = await render(Panel, { view: 'page' })
  const listCall = ctx.calls.mutate[ctx.calls.mutate.length - 1]
  const listOp = listCall === undefined
    ? undefined
    : listCall.ops.find((item) => item.path.join('.') === 'projects.0.match.statusValues')
  check('列表字段发出去的是数组', listOp !== undefined && Array.isArray(listOp.value),
    JSON.stringify(listOp))
  check('列表字段按逗号切分并去掉空白与重复项',
    listOp !== undefined && JSON.stringify(listOp.value) === JSON.stringify(['否', '在处理']),
    JSON.stringify(listOp && listOp.value))

  // 平台是固定集合，界面上必须给下拉而不是自由文本 —— 手打错一个字母就要等宿主拒。
  const selectSizes = findAll(tree, (node) => node.type === 'select' &&
    Array.isArray(node.props.children)).map((node) => node.props.children.length)
  check('平台字段渲染成下拉框', selectSizes.length >= 1, JSON.stringify(selectSizes))

  // 项目卡片可收起：收起后字段不该还渲染在树上（否则折叠只是视觉假象），
  // 而头部的徽标（已改 / 待修）必须还在 —— 收起不能顺手把「有错」也藏了。
  const projToggles = findProjectToggles(tree)
  check('项目卡片有折叠开关', projToggles.length >= 1, String(projToggles.length))
  const projToggle = projToggles[0]
  check('项目卡片默认展开', projToggle !== undefined && projToggle.props['aria-expanded'] === 'true',
    projToggle === undefined ? '没找到' : String(projToggle.props['aria-expanded']))
  if (projToggle !== undefined) {
    projToggle.props.onClick()
    tree = await render(Panel, { view: 'page' })
    check('收起项目卡片后不再渲染它的字段',
      findInput(tree, (node) => node.props.value === 'D:/WorkSpace/.repos/mgiot-pms') === undefined)
    check('收起项目卡片后仍然显示项目名', textOf(tree).indexOf('pms') >= 0)
    check('收起后头像 aria-expanded 变 false',
      findProjectToggles(tree)[0].props['aria-expanded'] === 'false',
      String(findProjectToggles(tree)[0].props['aria-expanded']))
    findProjectToggles(tree)[0].props.onClick()
    tree = await render(Panel, { view: 'page' })
    check('再点一次能展开回来',
      findInput(tree, (node) => node.props.value === 'D:/WorkSpace/.repos/mgiot-pms') !== undefined)
  }

  // 卡内分组也能收：默认「验证命令」是收着的（高级组），必填组是展开的。
  // 项目卡的卡内分组用 `.tp-sec-toggle` 标（配置分组是 `.tp-group-toggle`，
  // 两者现在分属不同页签，但类名必须能分开数）。
  const sectionToggles = findAll(tree, (node) => node.type === 'button' &&
    String(node.props.className || '').indexOf('tp-sec-toggle') >= 0)
  check('项目卡内有可折叠的分组', sectionToggles.length >= 1, String(sectionToggles.length))

  // 必填项清空 → 即时校验标红 + 禁用保存 + 顶部「N 项待修」。
  const nameInput = findInput(tree, (node) => node.props.value === 'pms')
  check('找到项目名输入框', nameInput !== undefined)
  nameInput.props.onChange({ target: { value: '' } })
  tree = await render(Panel, { view: 'page' })
  check('必填项为空时提示「项待修」', textOf(tree).indexOf('项待修') >= 0, textOf(tree).slice(0, 200))
  const blocked = findButton(tree, '保存', 'tp-primary')
  check('有必填项为空时保存被禁用', blocked !== undefined && blocked.props.disabled === true,
    blocked === undefined ? '没找到保存按钮' : String(blocked.props.disabled))
  check('必填项为空时字段标红',
    findAll(tree, (node) => typeof node.props.className === 'string' &&
      node.props.className.indexOf('tp-invalid') >= 0).length >= 1)

  // ⑦ 「+ 添加项目」必须是**纯本地**动作。
  //
  // 旧版在这里直接发 mutate，新项目带 `repo: { path: '' }`，宿主对整份配置做校验，
  // 于是每一笔都被 `projects[2].repo.path 必须是非空字符串` 整笔回滚 —— 人根本没法
  // 「先加一个、再慢慢填」。这条断言就是钉死那个回归：点下去不许碰宿主。
  resetRender()
  tree = await render(Panel, { view: 'page' })
  const mutateBeforeAdd = ctx.calls.mutate.length
  const addButton = findButton(tree, '+ 添加项目')
  check('「+ 添加项目」按钮可点（不因为 dirty 被锁死）',
    addButton !== undefined && addButton.props.disabled === false,
    addButton === undefined ? '没找到' : String(addButton.props.disabled))
  addButton.props.onClick()
  tree = await render(Panel, { view: 'page' })
  check('点「+ 添加项目」不写宿主（本地垫一张卡）',
    ctx.calls.mutate.length === mutateBeforeAdd, String(ctx.calls.mutate.length))
  check('新增的项目标着「未保存」', textOf(tree).indexOf('未保存') >= 0, textOf(tree).slice(0, 240))
  check('清单里多出一张卡片', findProjectToggles(tree).length === 2,
    String(findProjectToggles(tree).length))
  // 半成品不许发出去：repo.path 还空着时，本地校验就该把保存按住，
  // 而不是让人点下去再看宿主把它整笔拒掉。
  const saveWithBlank = findButton(tree, '保存', 'tp-primary')
  check('新增项目还没填必填项时保存被拦住',
    saveWithBlank !== undefined && saveWithBlank.props.disabled === true,
    saveWithBlank === undefined ? '没找到' : String(saveWithBlank.props.disabled))

  // 把新卡片的仓库路径填上，再保存 → 一整笔 set(['projects','1'], 完整对象)。
  const cards = findAll(tree, (node) => node.type === 'div' &&
    /^tp-proj( tp-collapsed)?$/.test(String(node.props.className || '')))
  // 找新卡片「仓库」那一组：组的标题文字必须以「仓库」开头
  // （不能用 indexOf ——「基本」组的提示里也出现「仓库」两个字，会选错组）。
  const groupsOfCard = cards.length >= 2
    ? findAll(cards[1], (node) => node.type === 'div' &&
      typeof node.props.className === 'string' && node.props.className.indexOf('tp-group') >= 0)
    : []
  const newRepoSection = groupsOfCard.find((node) => textOf(node).indexOf('仓库仓库路径') >= 0)
  const newRepoInput = newRepoSection === undefined
    ? undefined
    : findInput(newRepoSection, (node) => node.type === 'input' && node.props.value === '')
  check('找到新增卡片的仓库路径输入框', newRepoInput !== undefined,
    JSON.stringify(findAll(newRepoSection, (node) => node.type === 'input')
      .map((node) => [node.props.type, node.props.value])))
  if (newRepoInput !== undefined) {
    newRepoInput.props.onChange({ target: { value: 'D:/WorkSpace/.repos/new-proj' } })
    tree = await render(Panel, { view: 'page' })
    findButton(tree, '保存', 'tp-primary').props.onClick()
    tree = await render(Panel, { view: 'page' })
    const addCall = ctx.calls.mutate[ctx.calls.mutate.length - 1]
    const addOp = addCall === undefined
      ? undefined
      : addCall.ops.find((item) => JSON.stringify(item.path) === JSON.stringify(['projects', '1']))
    check('新增项目保存成一条整对象 op',
      addOp !== undefined, JSON.stringify(addCall && addCall.ops))
    check('新增项目发的是完整对象（不是逐字段半成品）',
      addOp !== undefined && addOp.value !== null && typeof addOp.value === 'object' &&
      addOp.value.repo !== undefined && addOp.value.repo.path === 'D:/WorkSpace/.repos/new-proj',
      JSON.stringify(addOp && addOp.value))
    check('新增项目带上了必填的 match.platform',
      addOp !== undefined && addOp.value.match !== undefined && typeof addOp.value.match.platform === 'string',
      JSON.stringify(addOp && addOp.value && addOp.value.match))
    check('保存成功后「未保存」徽标消失', textOf(tree).indexOf('未保存') < 0, textOf(tree).slice(0, 240))
  }

  // ⑦ 飞书表格读取参数（ADR-0005）与「选择目录」。
  //
  // 这一组断言钉的是两件很容易「看着有、其实没接上」的事：
  // 1. 表格读取参数那组字段真的画出来了，而且三个特殊 kind 都画对了控件
  //    （select 有选项、columns 显示成一行文本、保存时要变回对象）；
  // 2. 「选择目录」按钮真的调到了宿主的 uiWorkspace.pickDirectory，
  //    而且**只改草稿不写宿主** —— 否则「撤销」就撤销不回来了。
  //
  // 另外还钉一条**反向**断言：定位工单表只剩「工单表链接」一个入口，
  // 面板里不许再出现 spreadsheetToken / tableId 的输入框 —— 三个入口并存时
  // 用户填了两处却不知道哪处生效，这正是要根治的问题。
  resetRender()
  tree = await render(Panel, { view: 'page' })
  // tableKind / sheetRange / sheetColumns 是高级项，缺省收起 —— 先勾「显示全部字段」。
  const advForSheet = findAll(tree, (node) => node.type === 'label' &&
    textOf(node).indexOf('显示全部字段') >= 0)[0]
  if (advForSheet !== undefined) {
    const advBox = findAll(advForSheet, (node) => node.type === 'input')[0]
    if (advBox !== undefined) advBox.props.onChange({ target: { checked: true } })
    tree = await render(Panel, { view: 'page' })
  }
  check('飞书项目渲染出「表格读取参数」一组',
    textOf(tree).indexOf('表格读取参数') >= 0, textOf(tree).slice(0, 400))
  check('定位工单表只剩「工单表链接」一个入口',
    textOf(tree).indexOf('工单表链接') >= 0)
  check('面板里不再有电子表格 token 输入框（收进「工单表链接」）',
    findInput(tree, (node) => node.props.value === 'shtcnAbcd1234') === undefined)
  check('面板里不再有多维表格 tableId 输入框（收进「工单表链接」）',
    findInput(tree, (node) => node.props.value === 'tbl123') === undefined)
  check('表头行号渲染成输入框而不是下拉',
    findInput(tree, (node) => node.props.value === '1') !== undefined)

  // sheetIdentity / tableKind 是固定集合，必须是下拉；给成自由文本等于让人手打错值。
  const sheetSelects = findAll(tree, (node) => node.type === 'select' &&
    Array.isArray(node.props.children))
  const identitySelect = sheetSelects.find((node) =>
    node.props.children.some((option) => option.props && option.props.value === 'seq'))
  check('「行身份怎么认」渲染成下拉', identitySelect !== undefined,
    JSON.stringify(sheetSelects.map((node) => node.props.value)))
  check('「行身份怎么认」的选项是 seq / row',
    identitySelect !== undefined &&
    identitySelect.props.children.map((option) => option.props.value).join(',') === ',seq,row',
    identitySelect === undefined ? '没找到' :
      identitySelect.props.children.map((option) => option.props.value).join(','))
  check('「行身份怎么认」当前选中宿主下发的值',
    identitySelect !== undefined && identitySelect.props.value === 'seq',
    identitySelect === undefined ? '没找到' : String(identitySelect.props.value))
  const kindSelect = sheetSelects.find((node) =>
    node.props.children.some((option) => option.props && option.props.value === 'sheet'))
  check('「强制表型」渲染成下拉（含 bitable/sheet）', kindSelect !== undefined,
    JSON.stringify(sheetSelects.map((node) => node.props.value)))

  // 列名覆盖：宿主把对象摊成 `a=b, c=d` 一行文本，面板原样显示。
  const columnsInput = findInput(tree, (node) => node.props.value === 'description=问题描述, status=是否处理')
  check('列名覆盖渲染成一行文本（不是 [object Object]）', columnsInput !== undefined,
    JSON.stringify(findAll(tree, (node) => node.type === 'input')
      .map((node) => node.props.value).filter((value) => typeof value === 'string' && value.indexOf('=') >= 0)))
  if (columnsInput !== undefined) {
    // 改一项再保存：发出去的必须是**对象**，不是那行文本 ——
    // 宿主那边的 `match.sheetColumns` 是 `{语义: 实际表头}`。
    columnsInput.props.onChange({ target: { value: 'description=我的问题描述, status=我的状态' } })
    tree = await render(Panel, { view: 'page' })
    findButton(tree, '保存', 'tp-primary').props.onClick()
    tree = await render(Panel, { view: 'page' })
    const columnsCall = ctx.calls.mutate[ctx.calls.mutate.length - 1]
    const columnsOp = columnsCall === undefined
      ? undefined
      : columnsCall.ops.find((item) => item.path.join('.') === 'projects.0.match.sheetColumns')
    check('列名覆盖保存时发的是对象', columnsOp !== undefined && columnsOp.value !== null &&
      typeof columnsOp.value === 'object' && !Array.isArray(columnsOp.value),
      JSON.stringify(columnsOp))
    check('列名覆盖按 `=` 解析成 {语义: 列名}',
      columnsOp !== undefined && columnsOp.value.description === '我的问题描述' &&
      columnsOp.value.status === '我的状态',
      JSON.stringify(columnsOp && columnsOp.value))
  }

  // 「选择目录」：按钮必须在仓库路径那一格旁边，点了改草稿、不写宿主。
  resetRender()
  tree = await render(Panel, { view: 'page' })
  const pickButton = findButton(tree, '选择目录')
  check('仓库路径旁边有「选择目录」按钮', pickButton !== undefined)
  check('「选择目录」按钮可用', pickButton !== undefined && pickButton.props.disabled === false,
    pickButton === undefined ? '没找到' : String(pickButton.props.disabled))
  if (pickButton !== undefined) {
    const mutateBeforePick = ctx.calls.mutate.length
    const projectsBeforePick = ctx.calls.projects
    pickButton.props.onClick()
    tree = await render(Panel, { view: 'page' })
    check('点了「选择目录」会调宿主的 uiWorkspace.pickDirectory',
      ctx.calls.pickDirectory.length >= 1, String(ctx.calls.pickDirectory.length))
    check('选择器拿到的是格子里已经填着的路径',
      ctx.calls.pickDirectory.length >= 1 &&
      ctx.calls.pickDirectory[ctx.calls.pickDirectory.length - 1].current === 'D:/WorkSpace/.repos/mgiot-pms',
      JSON.stringify(ctx.calls.pickDirectory))
    check('选完的路径落进了输入框',
      findInput(tree, (node) => node.props.value === 'D:/picked/from/dialog') !== undefined,
      JSON.stringify(findAll(tree, (node) => node.type === 'input')
        .map((node) => node.props.value).filter((value) => typeof value === 'string' && value.indexOf('D:') >= 0)))
    check('选完目录不写宿主（只改草稿，撤销还能用）',
      ctx.calls.mutate.length === mutateBeforePick, String(ctx.calls.mutate.length))
    check('选完目录不重新读项目清单（没必要刷整份）',
      ctx.calls.projects === projectsBeforePick, String(ctx.calls.projects))
    check('选完目录后该字段标成「已改」', textOf(tree).indexOf('已改') >= 0)
  }

  // 宿主没有 uiWorkspace（老版本 / 没装 dsh-client-ui-workspace）时：
  // 按钮不出现，但输入框照常在 —— 手打路径这条退路不能断。
  delete services.uiWorkspace
  RENDER.hooks = []
  RENDER.effects = []
  RENDER.dirty = true
  dispose.length = 0
  registrations.length = 0
  injects.length = 0
  await exports.apply(ctx)
  const PanelWithoutPicker = registrations.find((r) => r.options.name === 'plugins.row.config').component
  tree = await render(PanelWithoutPicker, { view: 'page' })
  check('宿主没提供 uiWorkspace 时不画「选择目录」按钮', findButton(tree, '选择目录') === undefined)
  check('宿主没提供 uiWorkspace 时仓库路径输入框照常可填',
    findInput(tree, (node) => node.props.value === 'D:/WorkSpace/.repos/mgiot-pms') !== undefined)

  // ⑥ summary 视图只给一句话，不渲染整页。
  resetRender()
  tree = await render(Panel, { view: 'summary' })
  check('summary 视图简短', textOf(tree).length < 40, textOf(tree).slice(0, 40))
  check('summary 视图没有输入框', findAll(tree, (node) => node.type === 'input').length === 0)

  finish()
}

function finish () {
  if (failures.length === 0) {
    console.log('✅ client-smoke 通过')
    return
  }
  console.error('❌ client-smoke 发现 ' + failures.length + ' 个问题：')
  for (const failure of failures) console.error('  - ' + failure)
  process.exitCode = 1
}

await main()
