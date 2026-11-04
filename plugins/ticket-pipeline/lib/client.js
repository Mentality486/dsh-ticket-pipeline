/**
 * `lib/client.js` —— 插件在浏览器侧的 bundle（「设置 → 插件 → 工单流水线 → 配置」）。
 *
 * ## 为什么是手写的单文件 IIFE
 *
 * 本仓库零 npm 依赖、没有构建链（见 README「已知约束」），所以这里不用
 * tsdown/vite/esbuild，而是直接写浏览器能跑的产物：一个
 * `window.__ModuleLoader__.load()` 调用，内部自带一张 modules 表。
 *
 * ## 能 require 什么
 *
 * 只有宿主模块表里的 **seed 词**（react / react-dom / zod / cordis / 几个
 * dsh-client-* 包）能 require。而且官方规范（`dsh-agent-preset` 的
 * `cordis-plugin-development/references/practices.md`）明确禁止第三方 bundle
 * require 任何 Harness Client 包（包括 `dsh-client-ui-primitives`），要求自己写
 * 控件、只引用 `--dsw-alias-*` / `--dsw-radius-*` 这类设计 token。
 *
 * 所以：本文件只 require `react` 与 `react/jsx-runtime`，控件全部自己写。
 *
 * ## 数据从哪来
 *
 * 两件事都不需要自建通道：
 *
 * 1. **配置读写** 走宿主的 `settings` Remote（`dsh-api-settings-controller`
 *    提供的 namespace，启动时已由宿主 `$mount`，插件不用自己挂）：
 *    `remote.settings.describe()` / `remote.settings.mutate(ns, ops, revision)`。
 * 2. **凭据** 走宿主的 `credentials` Remote（同上）：
 *    `remote.credentials.describe([refs])` / `.set(ref, value)` / `.unset(ref)`。
 *    只回「配没配」，永不回传密文。
 *
 * 3. **体检** 走本插件自建的 `ticketPipeline` Remote（见
 *    `src/remote/descriptors.js` 与 `src/remote/host.js`）—— 宿主没有通用的
 *    doctor/health 通道，只能自己开一个。
 *
 * ## 为什么 `settings` 的 path 是数组
 *
 * `mutate` 的 op 是 `{ op: 'set', path, value }`，`path` 是**从根开始的一段路径**
 * （`['qqmail', 'user']`），不是扁平点号键。
 */

window.__ModuleLoader__.load({
  id: '@local/ticket-pipeline',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var Fragment = React.Fragment
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback
    var useMemo = React.useMemo

    /**
     * 本插件的 Remote 贡献物。
     *
     * ⚠️ 与 `src/remote/descriptors.js` 是**同一份内容的手抄**：浏览器 bundle
     * 不能 import 宿主侧文件（模块表里没有它），仓库又没有构建步骤。
     * `scripts/client-check.mjs` 会比对两边是否一致，改一处必须改两处。
     */
    var TICKET_PIPELINE_REMOTE = {
      package: '@local/ticket-pipeline',
      descriptors: [
        {
          id: 'ticket-pipeline#ticketPipeline/doctor',
          service: 'ticketPipeline',
          namespace: 'ticketPipeline',
          method: 'doctor',
          invocation: { kind: 'direct' },
          result: { mode: 'strict', typeSymbol: 'ticket-pipeline#DoctorReport' },
          parameters: [],
        },
        {
          id: 'ticket-pipeline#ticketPipeline/config',
          service: 'ticketPipeline',
          namespace: 'ticketPipeline',
          method: 'config',
          invocation: { kind: 'direct' },
          result: { mode: 'strict', typeSymbol: 'ticket-pipeline#ConfigSnapshot' },
          parameters: [],
        },
      ],
    }

    /** 设置命名空间（= profile 里 loader entry 的 id，见 cordis.patch.yml）。 */
    var NAMESPACE = 'ticket-pipeline'

    /** 插件在 profile 里的行 id（= cordis.patch.yml 里 insert 的 id）。 */
    var ROW_ID = 'ticket-pipeline'

    /** 插件包名（= package.json 的 name，Slot 的 key 用它拼）。 */
    var PACKAGE = '@local/ticket-pipeline'

    /**
     * 插件要用到的凭据。
     *
     * 这些**不进配置文件**：`src/adapters/*` 都是运行时 `credentials.resolve(ref)`
     * 去取，配置文件里只留非敏感参数。GUI 里也只显示「已配置 / 未配置」，
     * 输入框是只写的（填了就发走，不回显）。
     */
    var CREDENTIAL_REFS = [
      { ref: 'FEISHU_APP_ID', label: '飞书 App ID', hint: '飞书开放平台 → 开发者后台 → 应用详情 → 凭证与基础信息。' },
      { ref: 'FEISHU_APP_SECRET', label: '飞书 App Secret', hint: '同上，App Secret。只读工单表需要 bitable:app:readonly 权限。' },
      { ref: 'QQMAIL_AUTH_CODE', label: 'QQ 邮箱授权码', hint: 'QQ 邮箱 → 设置 → 账户 → 开启 SMTP 服务后拿到的授权码，不是登录密码。' },
      { ref: 'GITLAB_TOKEN', label: 'GitLab Token', hint: '真实执行器开 MR 时才需要；mock 模式不影响。' },
      { ref: 'PUSHPLUS_TOKEN', label: 'PushPlus token', hint: '也可以用下面的配置项 pushplus.token；两者取其一即可。' },
    ]

    /** 读 a.b.c 这种路径。 */
    function getPath (source, path) {
      var cursor = source
      for (var i = 0; i < path.length; i += 1) {
        if (cursor === null || cursor === undefined) return undefined
        cursor = cursor[path[i]]
      }
      return cursor
    }

    /** `dsh-settings` 的 schema 是 schemastery 的信封：`{ uid, refs }`，根在 refs[uid]。 */
    function schemaRoot (envelope) {
      if (!envelope || typeof envelope !== 'object') return undefined
      var refs = envelope.refs || {}
      return refs[String(envelope.uid)]
    }

    function deref (node, refs) {
      return typeof node === 'number' ? refs[String(node)] : node
    }

    /**
     * 把 schema 树摊平成叶子清单（每片叶子 = 一个可编辑字段）。
     *
     * 只认 `dict` 是分支、其余是叶子：`pushplus.token` 这种点号键在服务端已经
     * 拆成了嵌套 object（`{ pushplus: { token } }`），所以这里走的是树，不是扁平表。
     */
    function collectLeaves (schema, refs, path, out) {
      if (!schema || typeof schema !== 'object') return out
      var dict = schema.dict
      if (dict && typeof dict === 'object') {
        var keys = Object.keys(dict)
        for (var i = 0; i < keys.length; i += 1) {
          var key = keys[i]
          collectLeaves(deref(dict[key], refs), refs, path.concat([key]), out)
        }
        return out
      }
      out.push({ path: path, node: schema })
      return out
    }

    /** `meta.group` 的分组顺序 = 首次出现的顺序。 */
    function groupLeaves (leaves) {
      var groups = []
      var index = {}
      for (var i = 0; i < leaves.length; i += 1) {
        var leaf = leaves[i]
        var meta = leaf.node.meta || {}
        var name = typeof meta.group === 'string' && meta.group.length > 0 ? meta.group : '其他'
        if (index[name] === undefined) {
          index[name] = groups.length
          groups.push({ label: name, leaves: [] })
        }
        groups[index[name]].leaves.push(leaf)
      }
      return groups
    }

    function keyOf (leaf) {
      return leaf.path.join('.')
    }

    function isSecret (leaf) {
      return leaf.node.meta && leaf.node.meta.role === 'secret'
    }

    function isBoolean (leaf) {
      return leaf.node.type === 'boolean'
    }

    function isArrayField (leaf) {
      return leaf.node.type === 'array'
    }

    /** 把 `value` 里这个叶子的值转成编辑框能直接用的字符串/布尔。 */
    function draftValueOf (leaf, value) {
      var raw = getPath(value, leaf.path)
      var meta = leaf.node.meta || {}
      if (isBoolean(leaf)) return Boolean(raw === undefined ? meta.default : raw)
      if (isArrayField(leaf)) {
        if (Array.isArray(raw)) return raw.join(', ')
        if (Array.isArray(meta.default)) return meta.default.join(', ')
        return ''
      }
      if (raw === undefined || raw === null) {
        return meta.default === undefined ? '' : String(meta.default)
      }
      return String(raw)
    }

    function buildDraft (leaves, value) {
      var draft = {}
      for (var i = 0; i < leaves.length; i += 1) {
        draft[keyOf(leaves[i])] = draftValueOf(leaves[i], value)
      }
      return draft
    }

    /** 草稿 → 真正要写进去的 JS 值（数字转 number、数组拆逗号）。 */
    function rawValueOf (leaf, draftValue) {
      if (isBoolean(leaf)) return Boolean(draftValue)
      if (isArrayField(leaf)) {
        if (typeof draftValue !== 'string') return draftValue
        var parts = draftValue.split(',')
        var out = []
        for (var i = 0; i < parts.length; i += 1) {
          var item = parts[i].trim()
          if (item.length > 0) out.push(item)
        }
        return out
      }
      if (leaf.node.type === 'number') {
        var text = String(draftValue).trim()
        if (text.length === 0) return undefined
        var num = Number(text)
        return Number.isFinite(num) ? num : undefined
      }
      return String(draftValue)
    }

    function sameDraft (a, b) {
      return JSON.stringify(a) === JSON.stringify(b)
    }

    /** 从 `namespaces` 里挑出本插件的那个。 */
    function findNamespace (described) {
      var list = described && Array.isArray(described.namespaces) ? described.namespaces : []
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].ns === NAMESPACE) return list[i]
      }
      return undefined
    }

    // ── 样式 ────────────────────────────────────────────────────
    // 只用带 fallback 的 DSH 设计 token：宿主换主题时自动跟着变，宿主没定义也有兜底。

    var CSS = [
      '.tp-panel{display:flex;flex-direction:column;gap:16px;padding:4px 0 24px}',
      '.tp-head h2{margin:0 0 4px;font-size:15px}',
      '.tp-head p{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit);opacity:.85}',
      '.tp-card{border:1px solid var(--dsw-alias-border-l3,#8883);border-radius:var(--dsw-radius-md,12px);padding:14px 16px}',
      '.tp-card>h3{margin:0 0 10px;font-size:13px;display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.tp-group{margin:14px 0 0}',
      '.tp-group:first-of-type{margin-top:0}',
      '.tp-group>h4{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,inherit)}',
      '.tp-field{display:grid;grid-template-columns:minmax(140px,220px) 1fr;gap:6px 12px;align-items:start;padding:6px 0;border-bottom:1px dashed var(--dsw-alias-border-l3,#8882)}',
      '.tp-field:last-child{border-bottom:0}',
      '.tp-field label{font-size:12px;line-height:1.5;padding-top:6px}',
      '.tp-field .tp-help{margin:2px 0 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,inherit);opacity:.8}',
      '.tp-input,.tp-select{font:inherit;min-height:32px;padding:4px 8px;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary,inherit);background:transparent;border:1px solid var(--dsw-alias-border-l3,#8886);border-radius:var(--dsw-radius-sm,8px)}',
      '.tp-input:focus-visible,.tp-select:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#356be8);outline-offset:2px}',
      '.tp-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding-top:6px}',
      '.tp-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed var(--dsw-alias-border-l3,#8882);flex-wrap:wrap}',
      '.tp-row:last-child{border-bottom:0}',
      '.tp-row .tp-row-main{flex:1 1 220px;min-width:180px}',
      '.tp-row .tp-row-title{font-size:12px}',
      '.tp-row .tp-row-hint{margin:2px 0 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,inherit);opacity:.8}',
      '.tp-row .tp-row-input{flex:1 1 200px;min-width:160px}',
      '.tp-badge{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3,#8886);white-space:nowrap}',
      '.tp-badge.tp-on{color:var(--dsw-alias-button-primary-fill,#356be8);border-color:var(--dsw-alias-button-primary-fill,#356be8)}',
      '.tp-btn{font:inherit;min-height:32px;padding:4px 14px;cursor:pointer;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l3,#8886);background:transparent;color:var(--dsw-alias-label-primary,inherit)}',
      '.tp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8882)}',
      '.tp-btn:disabled{opacity:.5;cursor:default}',
      '.tp-btn.tp-primary{color:var(--dsw-alias-label-primary-foreground,#fff);background:var(--dsw-alias-button-primary-fill,#356be8);border-color:transparent}',
      '.tp-btn:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#356be8);outline-offset:2px}',
      '.tp-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:14px}',
      '.tp-note{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit);opacity:.85;margin:0}',
      '.tp-note code{font-size:11px;padding:0 3px}',
      '.tp-pre{margin:8px 0 0;padding:10px 12px;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-interactive-bg-hover,#8881);max-height:320px;overflow:auto}',
      '.tp-err{margin:8px 0 0;font-size:12px;color:var(--dsw-alias-label-error,#d33)}',
      '.tp-ok{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary,inherit)}',
      '@media(max-width:520px){.tp-field{grid-template-columns:1fr}.tp-field label{padding-top:0}}',
    ].join('')

    // ── 组件 ────────────────────────────────────────────────────

    function Field (props) {
      var leaf = props.leaf
      var draftValue = props.value
      var meta = leaf.node.meta || {}
      var label = typeof meta.label === 'string' && meta.label.length > 0 ? meta.label : keyOf(leaf)
      var help = typeof meta.description === 'string' ? meta.description : ''
      var disabled = props.disabled

      var control
      if (isBoolean(leaf)) {
        control = h('label', { className: 'tp-check' },
          h('input', {
            type: 'checkbox',
            checked: Boolean(draftValue),
            disabled: disabled,
            onChange: function (event) { props.onChange(event.target.checked) },
          }),
          '启用')
      } else if (Array.isArray(meta.enum) && meta.enum.length > 0) {
        var options = meta.enum.map(function (value) {
          return h('option', { key: value, value: value }, value)
        })
        control = h('select', {
          className: 'tp-select',
          value: String(draftValue),
          disabled: disabled,
          onChange: function (event) { props.onChange(event.target.value) },
        }, options)
      } else {
        var secret = isSecret(leaf)
        control = h('input', {
          className: 'tp-input',
          type: secret ? 'password' : (leaf.node.type === 'number' ? 'number' : 'text'),
          value: String(draftValue === undefined || draftValue === null ? '' : draftValue),
          disabled: disabled,
          min: meta.min === undefined ? undefined : meta.min,
          max: meta.max === undefined ? undefined : meta.max,
          placeholder: secret ? (props.secretSet ? '已配置（留空表示不改）' : '未配置') : undefined,
          autoComplete: secret ? 'new-password' : 'off',
          onChange: function (event) { props.onChange(event.target.value) },
        })
      }

      return h('div', { className: 'tp-field' },
        h('div', null,
          h('label', null, label),
          help.length > 0 ? h('p', { className: 'tp-help' }, help) : null),
        h('div', null, control))
    }

    function CredentialRow (props) {
      var item = props.item
      var state = props.state || {}
      var configured = Boolean(state.configured)
      var writable = state.writable !== false
      var value = props.value || ''
      var busy = props.busy

      return h('div', { className: 'tp-row' },
        h('div', { className: 'tp-row-main' },
          h('div', { className: 'tp-row-title' }, item.label,
            h('span', { className: 'tp-badge' + (configured ? ' tp-on' : ''), style: { marginLeft: '8px' } },
              configured ? '已配置' : '未配置')),
          h('p', { className: 'tp-row-hint' }, item.hint,
            h('code', { style: { marginLeft: '6px' } }, item.ref))),
        h('input', {
          className: 'tp-input tp-row-input',
          type: 'password',
          value: value,
          disabled: !writable || busy,
          placeholder: configured ? '已配置（留空表示不改）' : '粘贴到这里',
          autoComplete: 'new-password',
          onChange: function (event) { props.onChange(event.target.value) },
        }),
        h('button', {
          type: 'button',
          className: 'tp-btn',
          disabled: !writable || busy || value.trim().length === 0,
          onClick: props.onSave,
        }, '保存'),
        configured
          ? h('button', {
            type: 'button',
            className: 'tp-btn',
            disabled: !writable || busy,
            onClick: props.onClear,
          }, '清除')
          : null)
    }

    function DoctorCard (props) {
      var report = props.report
      return h('section', { className: 'tp-card' },
        h('h3', null,
          '环境体检',
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' } },
            props.message.length > 0 ? h('span', { className: 'tp-ok' }, props.message) : null,
            h('button', {
              type: 'button',
              className: 'tp-btn',
              disabled: props.busy || !props.available,
              onClick: props.onRun,
            }, props.busy ? '体检中…' : '立即体检'))),
        props.available
          ? h('p', { className: 'tp-note' },
            '检查 git 链路、项目仓库与远端、凭据配置、执行器与通知适配器。只读，不改任何东西。')
          : h('p', { className: 'tp-err' },
            '宿主 Remote 没挂上（typert 服务缺席）。命令行里仍然可以跑 pipeline_doctor 工具。'),
        report
          ? h(Fragment, null,
            report.ok
              ? h('p', { className: 'tp-note', style: { marginTop: '8px' } }, '✅ 通过' + (report.warnings.length > 0 ? '（有 ' + report.warnings.length + ' 条提醒）' : ''))
              : h('p', { className: 'tp-err' }, '❌ 发现 ' + report.problems.length + ' 个必须修复的问题'),
            h('pre', { className: 'tp-pre' }, report.text))
          : null,
        props.error ? h('p', { className: 'tp-err' }, props.error) : null)
    }

    function SettingsCard (props) {
      var view = props.view
      var leaves = props.leaves
      var draft = props.draft
      var disabled = props.disabled

      if (!view) {
        return h('section', { className: 'tp-card' },
          h('h3', null, '配置'),
          h('p', { className: 'tp-err' },
            '设置镜像里找不到命名空间 "' + NAMESPACE + '"。插件可能没启用，或 loader entry 的 id 不是这个值。'))
      }

      var groups = groupLeaves(leaves)
      var sections = groups.map(function (group) {
        var fields = group.leaves.map(function (leaf) {
          var key = keyOf(leaf)
          return h(Field, {
            key: key,
            leaf: leaf,
            value: draft[key],
            disabled: disabled,
            secretSet: Boolean(props.secrets && props.secrets[key]),
            onChange: function (next) { props.onEdit(key, next) },
          })
        })
        return h('div', { key: group.label, className: 'tp-group' },
          h('h4', null, group.label),
          fields)
      })

      return h('section', { className: 'tp-card' },
        h('h3', null, '配置',
          h('span', { style: { marginLeft: 'auto' } },
            props.dirty
              ? h('span', { className: 'tp-ok' }, '有未保存的改动')
              : null)),
        h('div', null, sections),
        h('div', { className: 'tp-actions' },
          h('button', {
            type: 'button',
            className: 'tp-btn tp-primary',
            disabled: disabled || !props.dirty || props.saving,
            onClick: props.onSave,
          }, props.saving ? '保存中…' : '保存'),
          h('button', {
            type: 'button',
            className: 'tp-btn',
            disabled: disabled || props.saving,
            onClick: props.onReset,
          }, '放弃改动'),
          props.message.length > 0 ? h('span', { className: 'tp-ok' }, props.message) : null),
        props.error ? h('p', { className: 'tp-err' }, props.error) : null)
    }

    /**
     * 整页组件。
     *
     * `props` 来自插件管理器：`{ view: 'summary' | 'page', form?, t?, ... }`。
     * 我们**不用** `props.form`：那是 `configForms` 的控制器，只有当宿主把本插件
     * 的命名空间当成「volatile schema 表单」时才非空，行为随版本漂移。这里直接
     * 调 `settings` Remote，语义稳定、错在哪一眼看得出。
     */
    function TicketPipelinePanel (props) {
      var remote = props.remote
      var [snapshot, setSnapshot] = useState(null)
      var [loading, setLoading] = useState(true)
      var [loadError, setLoadError] = useState('')
      var [draft, setDraft] = useState({})
      var [initialDraft, setInitialDraft] = useState({})
      var [saving, setSaving] = useState(false)
      var [saveError, setSaveError] = useState('')
      var [saveMessage, setSaveMessage] = useState('')

      var [creds, setCreds] = useState({})
      var [credDraft, setCredDraft] = useState({})
      var [credBusy, setCredBusy] = useState('')
      var [credMessage, setCredMessage] = useState('')

      var [doctorReport, setDoctorReport] = useState(null)
      var [doctorBusy, setDoctorBusy] = useState(false)
      var [doctorError, setDoctorError] = useState('')
      var [mounted, setMounted] = useState(false)
      var [secretMap, setSecretMap] = useState({})

      var isPage = props.view !== 'summary'

      var loadSettings = useCallback(function () {
        if (!remote || !remote.settings) {
          setLoading(false)
          setLoadError('settings 服务不可用（ctx.remote.settings 缺席）。')
          return Promise.resolve()
        }
        return remote.settings.describe().then(function (response) {
          if (!response || !response.ok) {
            setLoading(false)
            setLoadError('读取设置失败：' + ((response && response.error && response.error.message) || '未知错误'))
            return
          }
          setSnapshot(response.value)
          var view = findNamespace(response.value)
          if (!view) {
            setLoading(false)
            return
          }
          var envelope = view.schema || {}
          var refs = envelope.refs || {}
          var root = schemaRoot(envelope)
          var leaves = collectLeaves(root, refs, [], [])
          var nextDraft = buildDraft(leaves, view.value)
          var secrets = {}
          var secretList = Array.isArray(view.secrets) ? view.secrets : []
          for (var i = 0; i < secretList.length; i += 1) {
            var path = secretList[i] && secretList[i].path
            if (Array.isArray(path)) secrets[path.join('.')] = Boolean(secretList[i].set)
          }
          setSecretMap(secrets)
          setDraft(nextDraft)
          setInitialDraft(nextDraft)
          setLoading(false)
          setLoadError('')
        }, function (error) {
          setLoading(false)
          setLoadError('读取设置失败：' + (error && error.message ? error.message : String(error)))
        })
      }, [remote])

      var loadCredentials = useCallback(function () {
        if (!remote || !remote.credentials) return Promise.resolve()
        var refs = CREDENTIAL_REFS.map(function (item) { return item.ref })
        return remote.credentials.describe(refs).then(function (response) {
          if (response && response.ok) setCreds(response.value || {})
        }, function () {})
      }, [remote])

      useEffect(function () {
        if (!isPage) return
        setLoading(true)
        loadSettings()
        loadCredentials()
        if (remote && typeof remote['$mount'] === 'function') {
          remote['$mount'](TICKET_PIPELINE_REMOTE).then(function () {
            setMounted(true)
            setDoctorError('')
          }, function (error) {
            setMounted(false)
            setDoctorError('挂载体检通道失败：' + (error && error.message ? error.message : String(error)))
          })
        }
      }, [])

      var leaves = useMemo(function () {
        var view = findNamespace(snapshot)
        if (!view) return []
        var envelope = view.schema || {}
        return collectLeaves(schemaRoot(envelope), envelope.refs || {}, [], [])
      }, [snapshot])

      var dirty = !sameDraft(draft, initialDraft)

      function onEdit (key, next) {
        setDraft(function (previous) {
          var copy = Object.assign({}, previous)
          copy[key] = next
          return copy
        })
        setSaveMessage('')
        setSaveError('')
      }

      function onReset () {
        setDraft(Object.assign({}, initialDraft))
        setSaveMessage('')
        setSaveError('')
      }

      function onSave () {
        var view = findNamespace(snapshot)
        if (!view || !remote || !remote.settings) return
        var ops = []
        for (var i = 0; i < leaves.length; i += 1) {
          var leaf = leaves[i]
          var key = keyOf(leaf)
          if (isSecret(leaf) && String(draft[key] === undefined ? '' : draft[key]).length === 0) continue
          if (sameDraft(draft[key], initialDraft[key])) continue
          var raw = rawValueOf(leaf, draft[key])
          if (raw === undefined) {
            ops.push({ op: 'unset', path: leaf.path })
          } else {
            ops.push({ op: 'set', path: leaf.path, value: raw })
          }
        }
        if (ops.length === 0) {
          setDraft(Object.assign({}, initialDraft))
          setSaveMessage('没有需要保存的改动')
          return
        }
        setSaving(true)
        setSaveError('')
        setSaveMessage('')
        remote.settings.mutate(NAMESPACE, ops, view.revision).then(function (response) {
          setSaving(false)
          if (!response || !response.ok) {
            var detail = response && response.error ? response.error : {}
            setSaveError(detail.code === 'SETTINGS_CONFLICT'
              ? '配置在别处被改过，已重新载入，请重试。'
              : '保存失败：' + (detail.message || '未知错误'))
            return loadSettings()
          }
          setSaveMessage('已保存')
          return loadSettings()
        }, function (error) {
          setSaving(false)
          setSaveError('保存失败：' + (error && error.message ? error.message : String(error)))
        })
      }

      function onCredEdit (ref, value) {
        setCredDraft(function (previous) {
          var copy = Object.assign({}, previous)
          copy[ref] = value
          return copy
        })
        setCredMessage('')
      }

      function onCredSave (ref) {
        if (!remote || !remote.credentials) return
        var value = String(credDraft[ref] || '').trim()
        if (value.length === 0) return
        setCredBusy(ref)
        remote.credentials.set(ref, value).then(function (response) {
          setCredBusy('')
          if (!response || !response.ok) {
            setCredMessage('保存 ' + ref + ' 失败：' + ((response && response.error && response.error.message) || '未知错误'))
            return
          }
          setCredMessage(ref + ' 已保存')
          setCredDraft(function (previous) {
            var copy = Object.assign({}, previous)
            copy[ref] = ''
            return copy
          })
          loadCredentials()
        }, function (error) {
          setCredBusy('')
          setCredMessage('保存 ' + ref + ' 失败：' + (error && error.message ? error.message : String(error)))
        })
      }

      function onCredClear (ref) {
        if (!remote || !remote.credentials) return
        setCredBusy(ref)
        remote.credentials.unset(ref).then(function (response) {
          setCredBusy('')
          if (!response || !response.ok) {
            setCredMessage('清除 ' + ref + ' 失败：' + ((response && response.error && response.error.message) || '未知错误'))
            return
          }
          setCredMessage(ref + ' 已清除')
          loadCredentials()
        }, function (error) {
          setCredBusy('')
          setCredMessage('清除 ' + ref + ' 失败：' + (error && error.message ? error.message : String(error)))
        })
      }

      function onDoctor () {
        if (!remote || !remote.ticketPipeline) return
        setDoctorBusy(true)
        setDoctorError('')
        remote.ticketPipeline.doctor().then(function (response) {
          setDoctorBusy(false)
          if (!response || !response.ok) {
            setDoctorError('体检失败：' + ((response && response.error && response.error.message) || '未知错误'))
            return
          }
          setDoctorReport(response.value)
        }, function (error) {
          setDoctorBusy(false)
          setDoctorError('体检失败：' + (error && error.message ? error.message : String(error)))
        })
      }

      if (!isPage) {
        return h('span', null, '填配置、存凭据、一键体检。')
      }

      if (loading) {
        return h('div', { className: 'tp-panel' }, h('p', { className: 'tp-note' }, '载入中…'))
      }

      var credRows = CREDENTIAL_REFS.map(function (item) {
        return h(CredentialRow, {
          key: item.ref,
          item: item,
          state: creds[item.ref],
          value: credDraft[item.ref] || '',
          busy: credBusy === item.ref,
          onChange: function (next) { onCredEdit(item.ref, next) },
          onSave: function () { onCredSave(item.ref) },
          onClear: function () { onCredClear(item.ref) },
        })
      })

      return h('div', { className: 'tp-panel' },
        h('header', { className: 'tp-head' },
          h('h2', null, '工单流水线'),
          h('p', null, '从工单表检测变化，定位代码、改动验证、开 draft MR 并推送通知。')),

        h(DoctorCard, {
          report: doctorReport,
          busy: doctorBusy,
          error: doctorError,
          available: mounted,
          message: '',
          onRun: onDoctor,
        }),

        h('section', { className: 'tp-card' },
          h('h3', null, '凭据'),
          h('p', { className: 'tp-note' },
            '凭据存在宿主的凭据库里，不写进配置文件；这里只显示「配没配」，输入框是只写的。'),
          h('div', { style: { marginTop: '8px' } }, credRows),
          credMessage.length > 0 ? h('p', { className: 'tp-note', style: { marginTop: '8px' } }, credMessage) : null),

        h(SettingsCard, {
          view: findNamespace(snapshot),
          leaves: leaves,
          draft: draft,
          secrets: secretMap,
          disabled: saving,
          dirty: dirty,
          saving: saving,
          error: saveError + (loadError ? ' ' + loadError : ''),
          message: saveMessage,
          onEdit: onEdit,
          onSave: onSave,
          onReset: onReset,
        }),

        h('section', { className: 'tp-card' },
          h('h3', null, '项目清单'),
          h('p', { className: 'tp-note' },
            '项目（工单表 → 仓库的绑定）是结构化数组，形态复杂、校验严格，这里不放编辑框。',
            '请直接改 profile 的 ',
            h('code', null, 'cordis.patch.yml'),
            ' 里本行的 ',
            h('code', null, 'config.projects'),
            '，或让 agent 帮你改。改完重启 DSH 生效。')))
    }

    var inject = ['slots', 'remote']

    // slot 是 plugin-manager 在运行时用 register({children}) 声明出来的，加载顺序不可控：
    // 声明还没出现时直接 register 会抛 slot is not declared，整块 apply 就炸了。
    // 正确做法是 slots.inject(name, cb)：声明存在时立刻跑 cb，不存在就挂起等声明
    // （官方 dsh-ops 就是这么写的）。cb 里再 register，返回值是 disposer，由调用方 fiber 回收。
    function serveSlot (ctx, name, key, component) {
      var options = { name: name }
      if (key !== undefined) options.key = key

      var contribute = function () {
        return ctx.slots.register(options, component)
      }

      if (ctx.slots !== undefined && typeof ctx.slots.inject === 'function') {
        return ctx.slots.inject(name, contribute)
      }

      // 老版本没有 slots.inject：只能直接注册；失败只记一笔，不影响别处。
      try {
        return contribute()
      } catch (error) {
        console.error('[ticket-pipeline] 无法注册 ' + name + '：' + (error && error.message ? error.message : String(error)))
        return null
      }
    }

    function apply (ctx) {
      // 样式表：挂在 document.head，插件卸载时由 ctx.effect 收回。
      ctx.effect(function () {
        var style = document.createElement('style')
        style.dataset.ticketPipeline = 'true'
        style.textContent = CSS
        document.head.append(style)
        return function () { style.remove() }
      }, 'ticket-pipeline: settings styles')

      var panel = function (props) {
        return h(TicketPipelinePanel, Object.assign({}, props, { remote: ctx.remote }))
      }

      // 行级卡片：key = 包名 + '#' + row id（plugin-manager 的 rowConfigKey）。
      // row id 来自 cordis.patch.yml 的 insert 行 id，就是 ticket-pipeline。
      serveSlot(ctx, 'plugins.row.config', PACKAGE + '#' + ROW_ID, panel)

      // 兜底拼写：不同版本的 plugin-manager 对 key 的构造方式不完全一样，
      // 对不上就静默不渲染（连报错都没有），所以多注册几种常见形态。
      serveSlot(ctx, 'plugins.row.config', PACKAGE, panel)

      // bundle 级卡片：包名作 key。
      serveSlot(ctx, 'plugins.bundle.config', PACKAGE, panel)
    }

    return {
      name: 'ticket-pipeline-settings',
      inject: inject,
      apply: apply,
    }
  },
})
