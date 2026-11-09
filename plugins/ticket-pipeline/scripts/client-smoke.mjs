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
  const refs = {
    0: {
      type: 'object',
      meta: {},
      dict: {
        enabled: 1,
        pollIntervalMinutes: 2,
        pushplus: 3,
        qqmail: 4,
        notifyOn: 5,
        logLevel: 6,
      },
    },
    1: { type: 'boolean', meta: { label: '总开关', description: '装上不会自动开始扫表。', default: false, group: '杂项' } },
    2: { type: 'number', meta: { label: '轮询间隔（分钟）', description: '飞书只能轮询。', default: 3, min: 1, max: 60, group: '扫描与队列' } },
    3: {
      type: 'object',
      meta: {},
      dict: {
        token: 7,
        template: 8,
      },
    },
    4: {
      type: 'object',
      meta: {},
      dict: {
        host: 9,
        user: 10,
      },
    },
    5: { type: 'array', meta: { label: '发通知的 phase', default: ['done', 'failed'], group: '通知' }, inner: { type: 'string', meta: {} } },
    6: { type: 'string', meta: { label: '日志级别', enum: ['debug', 'info', 'warn', 'error'], default: 'info', group: '杂项' } },
    7: { type: 'string', meta: { label: 'PushPlus token', description: '建议走凭据。', role: 'secret', group: '通知' } },
    8: { type: 'string', meta: { label: 'PushPlus 模板', enum: ['txt'], default: 'txt', group: '通知' } },
    9: { type: 'string', meta: { label: 'SMTP 主机', default: 'smtp.qq.com', group: '通知' } },
    10: { type: 'string', meta: { label: '发件邮箱', default: '', group: '通知' } },
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
    repoPath: 'D:/WorkSpace/.repos/mgiot-pms',
    repoRemote: 'origin',
    repoBaseBranch: 'v2.x',
    repoTargetBranch: 'v2.x',
    remoteMrEnabled: true,
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
            pushplus: { token: '', template: 'txt' },
            qqmail: { host: 'smtp.qq.com', user: 'someone@qq.com' },
            notifyOn: ['done', 'skipped', 'failed', 'needs-info'],
            logLevel: 'info',
          },
          secrets: [{ path: ['pushplus', 'token'], set: false }],
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
function makeHost () {
  const calls = { mutate: [], credentialSet: [], credentialUnset: [], doctor: 0, mounted: 0, projects: 0 }
  // ctx.get(name) 查的「全局服务 store」。
  const services = Object.create(null)
  // gateway 服务自己维护的命名空间表（namespace → { service }）。
  const namespaces = new Map()

  const settingsNamespace = {
    describe: async () => makeSettingsResponse(),
    mutate: async (ns, ops, revision) => {
      calls.mutate.push({ ns, ops, revision })
      // 一次性脚本化的拒绝：用来验证「宿主原话 + 指路 profile」这条文案。
      if (typeof calls.rejectNext === 'string') {
        const message = calls.rejectNext
        calls.rejectNext = undefined
        return { ok: false, error: { code: 'SETTINGS_REJECTED', message } }
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
      check('$mount 收到四个描述符', contribution.descriptors.length === 4, String(contribution.descriptors.length))
      check('第三个描述符是 projects',
        contribution.descriptors.some((item) => item.method === 'projects' &&
          item.result.typeSymbol === 'ticket-pipeline#ProjectList'),
        contribution.descriptors.map((item) => item.method).join(' | '))
      check('第四个描述符是 branches',
        contribution.descriptors.some((item) => item.method === 'branches' &&
          item.result.typeSymbol === 'ticket-pipeline#BranchList'),
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

  // 整页拆成四个页签 —— 这是「太复杂」的解法：一次只摊开一块，其余收在标题里。
  const tabs = findTabs(tree)
  check('顶部有四个页签', tabs.length === 4, tabs.map(textOf).join(' | '))
  check('页签是 项目 / 参数 / 凭据 / 体检',
    tabs.map(textOf).join('|') === '项目|参数|凭据|体检', tabs.map(textOf).join('|'))
  check('页签带 tablist 语义',
    findAll(tree, (node) => node.props && node.props.role === 'tablist').length === 1)
  check('缺省停在「项目」页签',
    tabs[0].props['aria-selected'] === 'true' && tabs.filter((node) => node.props['aria-selected'] === 'true').length === 1,
    tabs.map((node) => node.props['aria-selected']).join(','))

  // 一次只渲染一块：停在「项目」时参数区的字段不该在树上。
  check('非当前页签的内容不渲染', textOf(tree).indexOf('日志级别') < 0, textOf(tree).slice(0, 120))

  check('渲染了保存按钮', findButton(tree, '保存', 'tp-primary') !== undefined)
  check('工具条上的「放弃改动」在', findButton(tree, '放弃改动') !== undefined)
  check('工具条上的「重新载入」在', findButton(tree, '重新载入') !== undefined)

  // ② 参数页：33 个配置项一屏放不下，默认只展开「扫描与队列」，其余收着。
  tree = await switchTab(Panel, '参数')
  const toggles = findToggles(tree)
  check('每个分组都有折叠标题', toggles.length === 3, String(toggles.length))
  const toggleOf = (label) => toggles.find((node) => textOf(node).indexOf(label) >= 0)
  check('默认展开「扫描与队列」', toggleOf('扫描与队列') !== undefined &&
    toggleOf('扫描与队列').props['aria-expanded'] === 'true')
  check('默认收起「通知」', toggleOf('通知') !== undefined &&
    toggleOf('通知').props['aria-expanded'] === 'false')

  // 收着的分组不该把字段渲染出来（否则折叠只是视觉假象）。
  check('收起的分组不渲染字段', textOf(tree).indexOf('日志级别') < 0)

  tree = await openAllGroups(Panel, tree)
  const inputs = findAll(tree, (node) => node.type === 'input' || node.type === 'select')
  // 「参数」页签只有配置项，凭据的 5 个密码框不再混进来 —— 拆页签之前这条断言
  // 之所以能过，是因为凭据区也画在同一页上（≥7 里有一半是密码框）。
  check('展开后渲染出输入控件', inputs.length >= 6, '只有 ' + inputs.length + ' 个')
  const bodyText = textOf(tree)
  check('显示分组标题「通知」', bodyText.indexOf('通知') >= 0)
  check('显示布尔字段', bodyText.indexOf('总开关') >= 0)
  check('显示 enum 字段', bodyText.indexOf('日志级别') >= 0)
  check('显示点号键的嵌套叶子', bodyText.indexOf('SMTP 主机') >= 0)

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
  check('项目卡片标注了 MR 开关', textOf(tree).indexOf('开 MR') >= 0)
  check('appToken 只显示打码预览', textOf(tree).indexOf('basc…Cnhh') >= 0)
  check('appToken 没有明文输入框',
    findAll(tree, (node) => node.type === 'input' &&
      typeof node.props.value === 'string' && node.props.value.indexOf('basc') >= 0).length === 0)
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
  const platformSelect = findAll(tree, (node) => node.type === 'select' &&
    Array.isArray(node.props.children)).map((node) => node.props.children.length)
  check('平台字段渲染成下拉框', platformSelect.length >= 1, JSON.stringify(platformSelect))

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
