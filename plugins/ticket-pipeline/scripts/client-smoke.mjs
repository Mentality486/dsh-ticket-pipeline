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
    1: { type: 'boolean', meta: { label: '总开关', description: '装上不会自动开始扫表。', default: false } },
    2: { type: 'number', meta: { label: '轮询间隔（分钟）', description: '飞书只能轮询。', default: 3, min: 1, max: 60 } },
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
    5: { type: 'array', meta: { label: '发通知的 phase', default: ['done', 'failed'] }, inner: { type: 'string', meta: {} } },
    6: { type: 'string', meta: { label: '日志级别', enum: ['debug', 'info', 'warn', 'error'], default: 'info' } },
    7: { type: 'string', meta: { label: 'PushPlus token', description: '建议走凭据。', role: 'secret' } },
    8: { type: 'string', meta: { label: 'PushPlus 模板', enum: ['txt'], default: 'txt' } },
    9: { type: 'string', meta: { label: 'SMTP 主机', default: 'smtp.qq.com' } },
    10: { type: 'string', meta: { label: '发件邮箱', default: '' } },
  }
  return { uid: 0, refs }
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

function makeHost () {
  const calls = { mutate: [], credentialSet: [], credentialUnset: [], doctor: 0, mounted: 0 }
  const remote = {
    settings: {
      describe: async () => makeSettingsResponse(),
      mutate: async (ns, ops, revision) => {
        calls.mutate.push({ ns, ops, revision })
        return { ok: true, value: undefined }
      },
    },
    credentials: {
      describe: async (refs) => ({
        ok: true,
        value: Object.fromEntries(refs.map((ref) => [ref, { configured: ref === 'FEISHU_APP_ID', writable: true }])),
      }),
      set: async (ref, value) => { calls.credentialSet.push({ ref, value }); return { ok: true } },
      unset: async (ref) => { calls.credentialUnset.push(ref); return { ok: true } },
    },
    $mount: async (contribution) => {
      calls.mounted += 1
      check('$mount 收到的包名', contribution.package === '@local/ticket-pipeline', contribution.package)
      check('$mount 收到两个描述符', contribution.descriptors.length === 2, String(contribution.descriptors.length))
      remote.ticketPipeline = {
        doctor: async () => {
          calls.doctor += 1
          return { ok: true, value: { ok: true, problems: [], warnings: ['mock 执行器'], text: '【环境体检】通过\n✅ git：可用' } }
        },
        config: async () => ({ ok: true, value: { config: {}, projects: 1 } }),
      }
      return async () => {}
    },
  }
  return { remote, calls }
}

/** 把 bundle 加载进一个受限的 vm 上下文，返回它注册的模块出口。 */
async function loadBundle () {
  const source = await readFile(join(root, 'lib/client.js'), 'utf8')
  let registered
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
    console,
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

// ── 断言 ──────────────────────────────────────────────────────

async function main () {
  const exports = await loadBundle()
  if (exports === undefined) return finish()

  check('导出 name', exports.name === 'ticket-pipeline-settings', exports.name)
  check('inject 含 slots 与 remote', Array.isArray(exports.inject) &&
    exports.inject.indexOf('slots') >= 0 && exports.inject.indexOf('remote') >= 0, JSON.stringify(exports.inject))

  // 收集 apply 注册的 slot。真宿主里 slot 是 plugin-manager 运行时声明的，
  // 声明没出现时 register 会抛错，所以插件必须走 slots.inject（声明出现才注册）。
  const registrations = []
  const injects = []
  const dispose = []
  const ctx = {
    remote: makeHost().remote,
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
  ;({ remote: ctx.remote, calls: ctx.calls } = makeHost())
  await exports.apply(ctx)

  check('apply 走 slots.inject 而不是裸 register（3 次）', injects.length === 3, injects.join(' | '))
  check('注册了 3 个 slot', registrations.length === 3, String(registrations.length))
  const rowKey = registrations.map((r) => r.options.name + ':' + r.options.key)
  check('注册了 plugins.row.config#包名#rowId', rowKey.indexOf('plugins.row.config:@local/ticket-pipeline#ticket-pipeline') >= 0, rowKey.join(' | '))
  check('注册了 plugins.bundle.config#包名', rowKey.indexOf('plugins.bundle.config:@local/ticket-pipeline') >= 0, rowKey.join(' | '))
  check('所有 slot 都有 key', registrations.every((r) => typeof r.options.key === 'string' && r.options.key.length > 0))

  const Panel = registrations.find((r) => r.options.name === 'plugins.row.config').component

  // ① 整页渲染：能读到配置、能列出叶子、分组正确。
  resetRender()
  let tree = await render(Panel, { view: 'page' })
  const inputs = findAll(tree, (node) => node.type === 'input' || node.type === 'select')
  check('渲染出输入控件', inputs.length >= 7, '只有 ' + inputs.length + ' 个')
  check('渲染了体检按钮', findButton(tree, '立即体检') !== undefined)
  check('渲染了保存按钮', findButton(tree, '保存', 'tp-primary') !== undefined)
  const bodyText = textOf(tree)
  check('显示分组标题「通知」', bodyText.indexOf('通知') >= 0)
  check('显示布尔字段', bodyText.indexOf('总开关') >= 0)
  check('显示 enum 字段', bodyText.indexOf('日志级别') >= 0)
  check('显示点号键的嵌套叶子', bodyText.indexOf('SMTP 主机') >= 0)

  // ② 改一个数字字段再保存 → 生成一条 path 是数组的 set op。
  const interval = findInput(tree, (node) => node.props.type === 'number')
  check('找到数字输入框', interval !== undefined)
  // 控件是真实 DOM 元素，onChange 收的是事件对象而不是裸值。
  interval.props.onChange({ target: { value: '9' } })
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

  // ③ 点「立即体检」→ 调自建 Remote。
  // apply 里就该把命名空间挂好（面板一打开按钮就能点），不该靠组件 effect 兜底。
  check('apply 里挂载了 ticketPipeline 命名空间（只挂一次）', ctx.calls.mounted === 1, String(ctx.calls.mounted))
  check('apply 之后命名空间已就绪', ctx.remote.ticketPipeline !== undefined)
  tree = await render(Panel, { view: 'page' })
  const doctor = findButton(tree, '立即体检')
  check('体检按钮可用', doctor.props.disabled === false, String(doctor.props.disabled))
  doctor.props.onClick()
  tree = await render(Panel, { view: 'page' })
  check('调用了 ticketPipeline.doctor', ctx.calls.doctor === 1, String(ctx.calls.doctor))
  check('渲染出体检报告', textOf(tree).indexOf('【环境体检】') >= 0)

  // ④ 凭据区：已配置项显示「已配置」，写一个值再保存 → credentials.set。
  tree = await render(Panel, { view: 'page' })
  check('凭据区显示已配置', textOf(tree).indexOf('已配置') >= 0)
  const secretInputs = findAll(tree, (node) => node.type === 'input' && node.props.type === 'password')
  check('凭据输入框是只写密码框', secretInputs.length >= 5, String(secretInputs.length))

  // ⑤ summary 视图只给一句话，不渲染整页。
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
