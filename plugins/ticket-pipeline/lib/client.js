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
    /**
     * ⚠️ 每个 result codec 都必须带 `create()`。
     *
     * `dsh-typert-registry` 的 `validateCodec` 连 result 也校验：
     * `if (typeof codec.create !== "function") throw new Error("typert: … result strict codec has no create() factory")`。
     * 只有 `mode` + `typeSymbol` 的 result codec 会让 `ctx.remote.$mount()` 整个被拒，
     * 表现是「体检按钮点了没反应，控制台只有一条 remote-mount-failed」。
     * 返回值的结构由宿主侧 `runDoctor()` / `describeConfig()` 保证，这里透传。
     * 写成字面量里的内联函数（不引用外层变量），这样整段能被脚本原样抠出来求值。
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
          result: { mode: 'strict', typeSymbol: 'ticket-pipeline#DoctorReport', create: function () { return { parse: function (value) { return value } } } },
          parameters: [],
        },
        {
          id: 'ticket-pipeline#ticketPipeline/config',
          service: 'ticketPipeline',
          namespace: 'ticketPipeline',
          method: 'config',
          invocation: { kind: 'direct' },
          result: { mode: 'strict', typeSymbol: 'ticket-pipeline#ConfigSnapshot', create: function () { return { parse: function (value) { return value } } } },
          parameters: [],
        },
        {
          id: 'ticket-pipeline#ticketPipeline/projects',
          service: 'ticketPipeline',
          namespace: 'ticketPipeline',
          method: 'projects',
          invocation: { kind: 'direct' },
          result: { mode: 'strict', typeSymbol: 'ticket-pipeline#ProjectList', create: function () { return { parse: function (value) { return value } } } },
          parameters: [],
        },
        {
          id: 'ticket-pipeline#ticketPipeline/branches',
          service: 'ticketPipeline',
          namespace: 'ticketPipeline',
          method: 'branches',
          invocation: { kind: 'direct' },
          result: { mode: 'strict', typeSymbol: 'ticket-pipeline#BranchList', create: function () { return { parse: function (value) { return value } } } },
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

    function hasKey (source, key) {
      return source !== null && source !== undefined && Object.prototype.hasOwnProperty.call(source, key)
    }

    // ── 字段约束 ────────────────────────────────────────────────
    // 约束文案完全由 descriptor 的 meta 推导（min/max/enum/default），不写死任何字段名：
    // 宿主加字段、改范围时面板自动跟上。

    /** 一句话约束提示，例如「1–60」「可选：feishu / wps / mock / webform」「缺省 30」。 */
    function constraintOf (leaf) {
      var meta = leaf.node.meta || {}
      var parts = []
      if (Array.isArray(meta.enum) && meta.enum.length > 0) {
        parts.push('可选：' + meta.enum.join(' / '))
      } else if (leaf.node.type === 'number') {
        var min = meta.min
        var max = meta.max
        if (min !== undefined && max !== undefined) parts.push(min + '–' + max)
        else if (min !== undefined) parts.push('不小于 ' + min)
        else if (max !== undefined) parts.push('不大于 ' + max)
      }
      if (!isBoolean(leaf) && meta.default !== undefined && meta.default !== null) {
        var text = isArrayField(leaf) && Array.isArray(meta.default) ? meta.default.join(', ') : String(meta.default)
        if (text.length > 0) parts.push('缺省 ' + text)
      }
      return parts.join(' · ')
    }

    /**
     * 单个字段的即时校验。
     *
     * 返回 `{ level, text }`：`level === 'error'` 会拦保存，`'soft'` 只是提醒。
     * 这里只做**能在浏览器侧确定**的检查（类型、范围、枚举）；跨字段/跨数组的规则
     * 由 `projectIssues` 与服务端 `~standard.validate` 兜。
     */
    function validateLeaf (leaf, draftValue) {
      var meta = leaf.node.meta || {}
      if (isBoolean(leaf)) return null
      if (isSecret(leaf)) return null

      if (Array.isArray(meta.enum) && meta.enum.length > 0) {
        var value = String(draftValue === undefined || draftValue === null ? '' : draftValue)
        // 空 = 「没设过，走缺省」：保存时会发 unset，不算错。
        if (value.length === 0) return null
        for (var i = 0; i < meta.enum.length; i += 1) {
          if (String(meta.enum[i]) === value) return null
        }
        return { level: 'error', text: '只能是 ' + meta.enum.join(' / ') }
      }

      if (leaf.node.type === 'number') {
        var raw = String(draftValue === undefined || draftValue === null ? '' : draftValue).trim()
        // 同上：空表示回落缺省，不是错误。
        if (raw.length === 0) return null
        var num = Number(raw)
        if (!Number.isFinite(num)) return { level: 'error', text: '必须是数字' }
        if (meta.min !== undefined && num < meta.min) return { level: 'error', text: '不能小于 ' + meta.min }
        if (meta.max !== undefined && num > meta.max) return { level: 'error', text: '不能大于 ' + meta.max }
        return null
      }

      return null
    }

    /** 全部配置叶子的校验结果，按草稿 key 索引。 */
    function configIssues (leaves, draft) {
      var byKey = {}
      var errorCount = 0
      for (var i = 0; i < leaves.length; i += 1) {
        var key = keyOf(leaves[i])
        var issue = validateLeaf(leaves[i], draft[key])
        if (issue === null) continue
        byKey[key] = issue
        if (issue.level === 'error') errorCount += 1
      }
      return { byKey: byKey, errorCount: errorCount }
    }

    /**
     * 把服务端 `invalid config:\n  - <message> (at <path>)` 拆成可挂到字段上的清单。
     *
     * 服务端返回的路径形如 `projects[0].repo.path` 或 `pollIntervalMinutes`；
     * 解析不出来就整段显示在顶部（宁可多显示，也不吞错误）。
     */
    function parseIssues (message) {
      var out = []
      if (typeof message !== 'string' || message.length === 0) return out
      var lines = message.split('\n')
      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i].replace(/^\s*-\s*/, '').trim()
        if (line.length === 0) continue
        var match = /^(.*?)\s*\(at ([^)]+)\)$/.exec(line)
        if (match === null) {
          out.push({ path: '', text: line })
          continue
        }
        out.push({ path: match[2].trim(), text: match[1].trim() })
      }
      return out
    }

    // ── 项目清单 ────────────────────────────────────────────────
    // 项目的 schema 是 `unknown`（宿主不往 schema 里放 projects 子树），所以字段表
    // 只能在这里手写一份。它对应 `src/core/config.js` 的 `validateProject`：
    // 改那边记得回来对一下。`from` 是 host `describeProject()` 的扁平字段名。

    var PLATFORMS = ['feishu', 'wps', 'mock', 'webform']

    // 每一组、每个字段都可以标 `advanced: true`（缺省视图下收起，勾「显示全部字段」才出现）。
    // 另有 `onlyFor: '<platform>'`：整组只在平台等于该值时出现 —— 金山那五个键对飞书项目
    // 毫无意义，画出来只会让「我该填哪些」变成猜谜。
    //
    // 判断「要不要隐藏」时有一条硬约束：**改过的字段永远显示**。否则一个只在高级里
    // 出现的字段被改过之后会从界面上消失，人看不见也就撤不回来，保存时却照样写进去。
    var PROJECT_SECTIONS = [
      {
        key: 'basic',
        label: '基本',
        fields: [
          { path: ['name'], from: 'name', label: '项目名', kind: 'text', required: true, hint: 'projectId，必须唯一；工单里的项目要靠它对上仓库。' },
          { path: ['description'], from: 'description', label: '说明', kind: 'text', advanced: true },
          { path: ['match', 'platform'], from: 'platform', label: '平台', kind: 'select', options: PLATFORMS, required: true, hint: '决定用哪个 ticket-source 适配器收票。' },
        ],
      },
      {
        key: 'match',
        label: '工单表',
        fields: [
          { path: ['match', 'tableId'], from: 'tableId', label: '工单表 tableId', kind: 'text', hint: '飞书多维表格的 table id；与 appToken 一起构成显式绑定。' },
          { path: ['match', 'docNamePattern'], from: 'docNamePattern', label: '表名匹配', kind: 'text', hint: '不给 tableId 时按文件名模糊匹配（例：PMS项目管理系统工单）。' },
          { path: ['match', 'statusValues'], from: 'statusValues', label: '在处理中的状态值', kind: 'list', hint: '逗号分隔；状态列取这些值时才算「在处理中」。' },
          { path: ['match', 'viewId'], from: 'viewId', label: '视图 viewId', kind: 'text', advanced: true },
          { path: ['match', 'recordIds'], from: 'recordIds', label: '只处理这些工单', kind: 'list', advanced: true, hint: '逗号分隔的 record id；留空表示整张表。' },
          { path: ['match', 'allowedImageHosts'], from: 'allowedImageHosts', label: '允许的截图主机', kind: 'list', advanced: true, hint: '逗号分隔的主机名白名单；截图链接来自外部输入，不放行的一律拒绝。' },
        ],
      },
      {
        key: 'wps',
        label: '金山文档',
        onlyFor: 'wps',
        fields: [
          { path: ['match', 'sheetUrl'], from: 'sheetUrl', label: '表格链接', kind: 'text' },
          { path: ['match', 'sheetName'], from: 'sheetName', label: '工作表名', kind: 'text' },
          { path: ['match', 'statusColumn'], from: 'statusColumn', label: '状态列名', kind: 'text' },
          { path: ['match', 'statusValue'], from: 'statusValue', label: '在处理中的取值', kind: 'text' },
          { path: ['match', 'mediaPrefix'], from: 'mediaPrefix', label: '附件前缀', kind: 'text', advanced: true },
        ],
      },
      {
        key: 'repo',
        label: '仓库',
        fields: [
          { path: ['repo', 'path'], from: 'repoPath', label: '仓库路径', kind: 'text', required: true, hint: '本地 git 检出根目录，绝对路径或相对 DSH 工作目录。' },
          { path: ['repo', 'baseBranch'], from: 'repoBaseBranch', label: '基准分支', kind: 'branch', hint: '从哪条分支切出工作分支。可从下拉里选，也可以直接手打。' },
          { path: ['repo', 'targetBranch'], from: 'repoTargetBranch', label: '目标分支', kind: 'branch', hint: 'MR 的目标分支。可从下拉里选，也可以直接手打。' },
          { path: ['repo', 'remote'], from: 'repoRemote', label: '远端名', kind: 'text', advanced: true, hint: '缺省 origin。' },
          { path: ['repo', 'gitlab', 'enabled'], from: 'remoteMrEnabled', label: '开 draft MR', kind: 'bool', advanced: true, hint: '关掉只做本地提交，不需要 GITLAB_TOKEN。' },
        ],
      },
      {
        key: 'verify',
        label: '验证命令',
        advanced: true,
        fields: [
          { path: ['verify', 'build'], from: 'verifyBuild', label: '构建命令', kind: 'text', hint: '留空跳过构建。' },
          { path: ['verify', 'test'], from: 'verifyTest', label: '验证命令', kind: 'text', hint: '留空跳过验证，直接开 draft MR。' },
        ],
      },
    ]

    function projectKey (index, path) {
      return 'p' + index + '.' + path.join('.')
    }

    /** 这个字段现在的草稿值算不算「改过」了（相对宿主下发的当前值）。 */
    function isFieldChanged (record, draft, index, field) {
      var key = projectKey(index, field.path)
      var value = hasKey(draft, key) ? draft[key] : projectDraftValue(record, field)
      return !sameDraft(value, projectDraftValue(record, field))
    }

    function fieldIssueOf (issues, index, field) {
      return issues === undefined || issues === null ? undefined : issues[projectKey(index, field.path)]
    }

    function isErrorIssue (issue) {
      return issue !== undefined && issue !== null && issue.level === 'error'
    }

    /**
     * 一组字段在当前视图下该不该露出来。
     *
     * 两个理由可以让它藏起来：整组标了 `advanced`（缺省视图只放常用的）或
     * `onlyFor` 指定的平台对不上（金山那五个键对飞书项目没有意义）。
     *
     * 但**改过的和有错的永远露出来**：一个只在高级里出现的字段被改过之后如果
     * 从界面上消失，人就看不见也撤不回来，保存时却照样写进去 —— 那是最糟的形态。
     */
    function sectionVisible (section, record, draft, issues, index, showAdvanced) {
      // 平台要以**草稿**里的为准：人刚把 mock 改成 wps，金山那组应该立刻出现，
      // 而不是等保存完再刷一次才看得见。
      var platformKey = projectKey(index, ['match', 'platform'])
      var platform = hasKey(draft, platformKey)
        ? String(draft[platformKey])
        : (record && record.platform ? record.platform : '')
      var exempt = false
      for (var f = 0; f < section.fields.length; f += 1) {
        var field = section.fields[f]
        if (isFieldChanged(record, draft, index, field) || isErrorIssue(fieldIssueOf(issues, index, field))) {
          exempt = true
          break
        }
      }
      if (exempt) return true
      if (section.advanced === true && !showAdvanced) return false
      if (section.onlyFor !== undefined && section.onlyFor !== platform) return false
      return true
    }

    function fieldVisible (field, record, draft, issues, index, showAdvanced) {
      if (field.advanced !== true || showAdvanced) return true
      return isFieldChanged(record, draft, index, field) || isErrorIssue(fieldIssueOf(issues, index, field))
    }

    /** 一个项目里当前视图下看不见的字段数（用来提示「还有 N 项没显示」）。 */
    function hiddenProjectFieldCount (record, draft, issues, index, showAdvanced) {
      var count = 0
      for (var s = 0; s < PROJECT_SECTIONS.length; s += 1) {
        var section = PROJECT_SECTIONS[s]
        if (!sectionVisible(section, record, draft, issues, index, showAdvanced)) {
          count += section.fields.length
          continue
        }
        for (var f = 0; f < section.fields.length; f += 1) {
          if (!fieldVisible(section.fields[f], record, draft, issues, index, showAdvanced)) count += 1
        }
      }
      return count
    }

    /** 扁平 describeProject 记录 → 某个字段的草稿值。 */
    function projectDraftValue (record, field) {
      var raw = record === null || record === undefined ? undefined : record[field.from]
      if (field.kind === 'bool') return Boolean(raw)
      if (field.kind === 'list') {
        if (Array.isArray(raw)) return raw.join(', ')
        return raw === undefined || raw === null ? '' : String(raw)
      }
      return raw === undefined || raw === null ? '' : String(raw)
    }

    /** 草稿值 → 真正要写进去的值（列表拆逗号、布尔转 bool）。 */
    function projectRawValue (field, draftValue) {
      if (field.kind === 'bool') return Boolean(draftValue)
      if (field.kind === 'list') {
        var parts = String(draftValue === undefined || draftValue === null ? '' : draftValue).split(',')
        var out = []
        for (var i = 0; i < parts.length; i += 1) {
          var item = parts[i].trim()
          if (item.length > 0 && out.indexOf(item) < 0) out.push(item)
        }
        return out
      }
      return String(draftValue === undefined || draftValue === null ? '' : draftValue)
    }

    /** 一个项目的全部草稿值（key 形如 `p0.repo.path`）。 */
    function projectDrafts (record, index) {
      var out = {}
      for (var s = 0; s < PROJECT_SECTIONS.length; s += 1) {
        var fields = PROJECT_SECTIONS[s].fields
        for (var f = 0; f < fields.length; f += 1) {
          out[projectKey(index, fields[f].path)] = projectDraftValue(record, fields[f])
        }
      }
      return out
    }

    /** 看起来像不像一个路径/命令（只用来给软提示，不拦保存）。 */
    function looksLikePath (text) {
      return /[\\/]/.test(text) || /^[A-Za-z]:/.test(text) || text === '.' || text === '~'
    }

    /** 把「来自 profile 的当前值」渲染成人能读的一行（空值要说清是空的）。 */
    function describeBase (value) {
      if (Array.isArray(value)) return value.length === 0 ? '（空）' : value.join(', ')
      if (typeof value === 'boolean') return value ? '是' : '否'
      if (value === undefined || value === null || String(value).length === 0) return '（空）'
      return String(value)
    }

    // ── 折叠状态 ────────────────────────────────────────────────
    // 33 个配置项一屏放不下，全展开时保存按钮要滚很久。折叠状态记在 localStorage，
    // key 带插件前缀避免和别的插件撞；存不下就退化成「每次都按默认展开」，不影响功能。

    var OPEN_KEY = 'ticket-pipeline:open-groups'
    var DEFAULT_OPEN_GROUP = '扫描与队列'

    function readOpenMap () {
      try {
        if (typeof localStorage === 'undefined') return {}
        var raw = localStorage.getItem(OPEN_KEY)
        if (typeof raw !== 'string' || raw.length === 0) return {}
        var parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch (error) {
        return {}
      }
    }

    function writeOpenMap (map) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(OPEN_KEY, JSON.stringify(map))
      } catch (error) {
        // 存不下就算了，折叠状态丢了不影响功能。
      }
    }

    /** 分组默认：只有「扫描与队列」展开，其余收起；用户点过就以记住的为准。 */
    function isGroupOpen (map, label) {
      if (hasKey(map, label)) return map[label] !== false
      return label === DEFAULT_OPEN_GROUP
    }

    // 项目卡片的折叠状态另存一份，key 形如 `p0`（整张卡）、`p0:repo`（卡内一组）。
    // 为什么不能复用上面那个 map：全局配置里有「仓库」「验证」这样的组名，项目卡
    // 里也有，同一条 key 会把两边带在一起 —— 收起项目里的仓库，配置那边的仓库
    // 也跟着收起来。
    var PROJ_OPEN_KEY = 'ticket-pipeline:open-projects'

    function readProjMap () {
      try {
        if (typeof localStorage === 'undefined') return {}
        var raw = localStorage.getItem(PROJ_OPEN_KEY)
        if (typeof raw !== 'string' || raw.length === 0) return {}
        var parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch (error) {
        return {}
      }
    }

    function writeProjMap (map) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(PROJ_OPEN_KEY, JSON.stringify(map))
      } catch (error) {
        // 存不下就算了，折叠状态丢了不影响功能。
      }
    }

    function projectOpenKey (index) {
      return 'p' + index
    }

    function projectSectionOpenKey (index, sectionKey) {
      return 'p' + index + ':' + sectionKey
    }

    /**
     * 一组在项目卡里默认展开还是收起。
     *
     * 缺省展开「基本 / 工单表 / 金山文档 / 仓库」，收起「验证命令」—— 后两个是
     * 「不填也能跑」的，摊在最上面只会让必填项被挤到看不见的地方。
     */
    function isProjectSectionOpen (map, index, sectionKey) {
      var key = projectSectionOpenKey(index, sectionKey)
      if (hasKey(map, key)) return map[key] !== false
      return sectionKey !== 'verify'
    }

    /**
     * 把服务端的 `invalid config:` 报文挂到具体字段上。
     *
     * 服务端路径有两种形态：配置项是点号路径（`pollIntervalMinutes`），项目是
     * `projects[0].repo.path`（也见过 `projects.0.repo.path` 形态）。认不出来的
     * 一律留到顶部整段显示 —— 宁可多显示一行，也不把错误吞掉。
     */
    function mapServerIssues (message, configKeys) {
      var entries = parseIssues(message)
      var byKey = {}
      var top = []
      for (var i = 0; i < entries.length; i += 1) {
        var entry = entries[i]
        var path = String(entry.path === undefined || entry.path === null ? '' : entry.path)
        var text = String(entry.text === undefined || entry.text === null ? '' : entry.text)
        var indexed = /^projects(?:\[(\d+)\]|\.(\d+))\.?(.*)$/.exec(path)
        if (indexed !== null) {
          var index = Number(indexed[1] !== undefined ? indexed[1] : indexed[2])
          var rest = indexed[3] === undefined ? '' : indexed[3]
          // 文案本身也带着 `projects[0].repo.path ` 前缀，剥掉，字段下面只留原因。
          var cleaned = text.replace(/^projects\[\d+\]\.[^\s]+\s+/, '')
          if (rest.length === 0) {
            // 整条项目级别的错误（例如「项目名重复」）挂不到具体字段，放顶部。
            top.push('项目 #' + (index + 1) + '：' + cleaned)
            continue
          }
          byKey[projectKey(index, rest.split('.'))] = { level: 'error', text: cleaned }
          continue
        }
        if (path.length > 0 && configKeys.indexOf(path) >= 0) {
          byKey[path] = { level: 'error', text: text }
          continue
        }
        if (text.length > 0) top.push(text)
      }
      return { byKey: byKey, top: top.join('\n') }
    }

    /** 两份问题表合并：本地即时校验优先，服务端拒绝覆盖同 key 的文案。 */
    function mergeIssues (local, remote) {
      var byKey = {}
      var errorCount = 0
      var key
      for (key in local) {
        if (!hasKey(local, key)) continue
        byKey[key] = local[key]
        if (local[key].level === 'error') errorCount += 1
      }
      for (key in remote) {
        if (!hasKey(remote, key)) continue
        if (byKey[key] !== undefined && byKey[key].level === 'error') errorCount -= 1
        byKey[key] = remote[key]
        if (remote[key].level === 'error') errorCount += 1
      }
      return { byKey: byKey, errorCount: errorCount }
    }


    /**
     * 单个项目的即时校验，返回按草稿 key 索引的问题表。
     *
     * 规则照 `src/core/config.js:validateProject` 抄，文案保持一致：
     * 人和 agent 在面板上看到的，应该和启动时校验报出来的是同一句话。
     */
    function projectIssues (record, index, draft, names) {
      var out = {}
      function add (path, level, text) {
        out[projectKey(index, path)] = { level: level, text: text }
      }
      function read (path) {
        var key = projectKey(index, path)
        return hasKey(draft, key) ? String(draft[key] === undefined || draft[key] === null ? '' : draft[key]) : ''
      }

      var name = read(['name']).trim()
      if (name.length === 0) {
        add(['name'], 'error', '必须是非空字符串')
      } else {
        var seen = 0
        for (var i = 0; i < names.length; i += 1) {
          if (names[i] === name) seen += 1
        }
        if (seen > 1) add(['name'], 'error', '项目名 "' + name + '" 重复，projectId 必须唯一')
      }

      var platform = read(['match', 'platform']).trim()
      if (platform.length === 0) {
        add(['match', 'platform'], 'error', '只能是 feishu / wps / mock / webform')
      } else if (PLATFORMS.indexOf(platform) < 0) {
        add(['match', 'platform'], 'error', '只能是 feishu / wps / mock / webform')
      }

      var repoPath = read(['repo', 'path']).trim()
      if (repoPath.length === 0) {
        add(['repo', 'path'], 'error', '必须是非空字符串（本地 git 检出根目录）')
      } else if (!looksLikePath(repoPath)) {
        add(['repo', 'path'], 'soft', '看起来不像路径（没有目录分隔符）。确认是相对 DSH 工作目录的路径？')
      }

      if (platform === 'feishu') {
        var pattern = read(['match', 'docNamePattern']).trim()
        var hasToken = Boolean(record && record.hasAppToken)
        if (!hasToken && pattern.length === 0) {
          add(['match', 'docNamePattern'], 'soft',
            'feishu 项目需要 appToken+tableId（显式绑定）或表名匹配（docNamePattern）二选一；appToken 只能在配置文件里写。')
        }
      }

      var statusText = read(['match', 'statusValues']).trim()
      var statusValues = projectRawValue({ kind: 'list' }, statusText)
      if (statusText.length > 0 && statusValues.length === 0) {
        add(['match', 'statusValues'], 'error', '必须是非空字符串或字符串数组（值是状态列里表示「在处理中」的取值）')
      } else {
        for (var s = 0; s < statusValues.length; s += 1) {
          if (/\s/.test(statusValues[s])) {
            add(['match', 'statusValues'], 'soft', '状态值里带空格：' + statusValues[s] + '。确认表里就是一字不差的这个值。')
            break
          }
        }
      }

      var recordText = read(['match', 'recordIds']).trim()
      if (recordText.length > 0 && projectRawValue({ kind: 'list' }, recordText).length === 0) {
        add(['match', 'recordIds'], 'error', '必须是非空字符串或字符串数组（record id）')
      }

      var hostText = read(['match', 'allowedImageHosts']).trim()
      if (hostText.length > 0 && projectRawValue({ kind: 'list' }, hostText).length === 0) {
        add(['match', 'allowedImageHosts'], 'error', '必须是非空字符串或字符串数组（截图链接允许的主机名，例如 cdn.example.com）')
      }

      var gitlabEnabled = Boolean(draft[projectKey(index, ['repo', 'gitlab', 'enabled'])])
      if (gitlabEnabled) {
        add(['repo', 'gitlab', 'enabled'], 'soft', '开 MR 需要 GITLAB_TOKEN 凭据，并且仓库要有可访问的远端。')
      }

      // verify 那两条填的是「命令」，只做软提示：真起进程去跑才知道对不对，
      // 但把路径填进命令位、或者命令里带占位符，几乎一定是填错了。
      softCommandHint(add, 'verifyBuild', ['verify', 'build'], read(['verify', 'build']))
      softCommandHint(add, 'verifyTest', ['verify', 'test'], read(['verify', 'test']))

      return out
    }

    /** 命令位的软提示：像路径、带尖括号占位符、或只有空白，都提醒一句但不拦。 */
    function softCommandHint (add, from, path, text) {
      var value = text.trim()
      if (value.length === 0) return
      if (/^[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value)) {
        add(path, 'soft', '这里填的是命令（例如 pnpm ' + (from === 'verifyBuild' ? 'build' : 'test') + '），不是路径；路径请填在上面「仓库路径」。')
        return
      }
      if (/[<>]/.test(value)) {
        add(path, 'soft', '命令里带尖括号占位符，真跑起来 shell 会当成重定向。确认已经换成实际参数。')
      }
    }

    /** 全部项目的校验结果汇总（含错误计数）。 */
    function allProjectIssues (list, draft) {
      var names = []
      for (var i = 0; i < list.length; i += 1) {
        var key = projectKey(i, ['name'])
        names.push(hasKey(draft, key) ? String(draft[key] === undefined ? '' : draft[key]).trim() : '')
      }
      var byKey = {}
      var errorCount = 0
      for (var j = 0; j < list.length; j += 1) {
        var one = projectIssues(list[j], j, draft, names)
        for (var field in one) {
          if (!hasKey(one, field)) continue
          byKey[field] = one[field]
          if (one[field].level === 'error') errorCount += 1
        }
      }
      return { byKey: byKey, errorCount: errorCount }
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

      // 顶部操作条：页面很长（33 个配置项 + N 个项目卡片），保存按钮必须一直够得着。
      '.tp-bar{position:sticky;top:0;z-index:3;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 0;background:var(--dsw-alias-bg-base,Canvas)}',
      '.tp-bar .tp-spacer{margin-left:auto}',
      '.tp-bar .tp-count{font-size:11px;color:var(--dsw-alias-label-secondary,inherit)}',

      // 可折叠分组：标题本身就是按钮，键盘也能操作。
      '.tp-group>h4{margin:0}',
      '.tp-toggle{font:inherit;display:flex;align-items:center;gap:6px;width:100%;padding:4px 0;cursor:pointer;background:transparent;border:0;color:var(--dsw-alias-label-secondary,inherit);text-align:left;font-size:12px;font-weight:600}',
      '.tp-toggle:hover{color:var(--dsw-alias-label-primary,inherit)}',
      '.tp-toggle .tp-caret{display:inline-block;width:10px;opacity:.7}',
      '.tp-toggle .tp-badge{margin-left:auto;font-weight:400}',

      // 字段级校验
      '.tp-field.tp-invalid .tp-input,.tp-field.tp-invalid .tp-select{border-color:var(--dsw-alias-label-error,#d33)}',
      '.tp-field .tp-field-err{margin:4px 0 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-error,#d33)}',
      '.tp-field .tp-constraint{margin:2px 0 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,inherit);opacity:.7}',
      '.tp-field .tp-soft{margin:4px 0 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,inherit)}',

      // 项目卡片
      '.tp-proj{border:1px solid var(--dsw-alias-border-l3,#8883);border-radius:var(--dsw-radius-sm,8px);padding:10px 12px;margin:10px 0 0}',
      // 收起时只留一行头：padding 不许把空卡片撑出半屏。
      '.tp-proj.tp-collapsed{padding:8px 12px}',
      '.tp-proj.tp-collapsed .tp-proj-head{margin:0}',
      '.tp-proj-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 4px}',
      // 头里的按钮是折叠开关，不要它自己那套 12px/toggle 的宽度，跟徽标排一行。
      '.tp-proj-head .tp-toggle{width:auto;flex:0 1 auto;padding:0;font-size:12px}',
      '.tp-proj-head strong{font-size:12px}',
      '.tp-proj-head .tp-spacer{margin-left:auto}',
      '.tp-proj-body{margin-top:4px}',
      // 卡内的组标题：比顶层的分组小一号，别和「配置」那边抢视觉层级。
      '.tp-proj-body .tp-group .tp-toggle{font-size:12px}',
      '.tp-proj .tp-field{padding:4px 0}',
      // 收起状态下标签用更淡的字，提示它可点。
      '.tp-proj-head .tp-toggle[aria-expanded="false"]{color:var(--dsw-alias-label-secondary,inherit)}',
      // 分支字段：输入框占满一行，候选提示跟在下面一行。
      '.tp-branch{display:flex;flex-direction:column;gap:2px}',
      '.tp-branch .tp-help{padding-left:2px}',
      // 有错的项目徽标：红底，收起时也看得见。
      '.tp-badge.tp-bad{color:var(--dsw-alias-label-error,#d33);border-color:var(--dsw-alias-label-error,#d33)}',
      '.tp-empty{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit)}',

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
      var issue = props.issue
      var invalid = issue !== undefined && issue !== null && issue.level === 'error'
      var constraint = constraintOf(leaf)
      var secret = isSecret(leaf)

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

      // 字段右侧的「已改 / 撤销」：只标记真正改过的字段，撤销只回退这一个。
      var changed = Boolean(props.changed)
      var mark = changed
        ? h('span', { style: { marginLeft: '8px', display: 'inline-flex', gap: '6px', alignItems: 'center' } },
          h('span', { className: 'tp-badge tp-on' }, '已改'),
          h('button', {
            type: 'button',
            className: 'tp-btn',
            style: { minHeight: '24px', padding: '0 8px', fontSize: '11px' },
            disabled: disabled,
            onClick: props.onRevert,
          }, '撤销'))
        : null

      var notes = []
      if (constraint.length > 0) notes.push(h('p', { key: 'constraint', className: 'tp-constraint' }, constraint))
      if (issue !== undefined && issue !== null) {
        notes.push(h('p', {
          key: 'issue',
          className: issue.level === 'error' ? 'tp-field-err' : 'tp-soft',
        }, issue.text))
      }

      return h('div', { className: 'tp-field' + (invalid ? ' tp-invalid' : '') },
        h('div', null,
          h('label', null, label, mark),
          help.length > 0 ? h('p', { className: 'tp-help' }, help) : null),
        h('div', null,
          control,
          notes.length > 0 ? notes : null))
    }

    /**
     * 一个可折叠的配置分组。
     *
     * 33 个字段一屏放不下，全展开时保存按钮要滚很久才够得着 —— 折叠状态记在
     * localStorage 里，下次打开还是上次的样子。key 带插件前缀，避免和别的插件撞。
     */
    function GroupSection (props) {
      var group = props.group
      var open = props.open
      var changedCount = props.changedCount
      return h('div', { className: 'tp-group' },
        h('h4', null,
          h('button', {
            type: 'button',
            // 三个类名各有分工：tp-toggle 只管样式；tp-group-toggle 标「这是配置分组
            // 的折叠」，自测按它数；tp-proj- 那套在项目卡片里，两套混着数就会互相
            // 干扰（项目一多，「每个分组都有折叠标题」那条断言就莫名地红）。
            className: 'tp-toggle tp-group-toggle',
            'aria-expanded': open ? 'true' : 'false',
            onClick: props.onToggle,
          },
          h('span', { className: 'tp-caret' }, open ? '▾' : '▸'),
          group.label,
          changedCount > 0 ? h('span', { className: 'tp-badge tp-on' }, '本组已改 ' + changedCount + ' 项') : null)),
        open ? props.children : null)
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
            '检查 git 链路、项目仓库与远端、凭据配置、执行器与通知适配器，以及正在跑的插件是不是比本地源码旧。只读，不改任何东西。')
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
        var changedCount = 0
        var fields = group.leaves.map(function (leaf) {
          var key = keyOf(leaf)
          var changed = !sameDraft(draft[key], props.initialDraft[key])
          if (changed) changedCount += 1
          return h(Field, {
            key: key,
            leaf: leaf,
            value: draft[key],
            disabled: disabled,
            secretSet: Boolean(props.secrets && props.secrets[key]),
            issue: props.issues ? props.issues[key] : undefined,
            changed: changed,
            onRevert: function () { props.onRevert(key) },
            onChange: function (next) { props.onEdit(key, next) },
          })
        })
        return h(GroupSection, {
          key: group.label,
          group: group,
          open: props.isOpen(group.label),
          changedCount: changedCount,
          onToggle: function () { props.onToggle(group.label) },
        }, fields)
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
            disabled: disabled || !props.dirty || props.saving || props.errorCount > 0,
            onClick: props.onSave,
          }, props.saving ? '保存中…' : '保存'),
          h('button', {
            type: 'button',
            className: 'tp-btn',
            disabled: disabled || props.saving,
            onClick: props.onReset,
          }, '放弃改动'),
          props.errorCount > 0
            ? h('span', { className: 'tp-err', style: { margin: 0 } }, props.errorCount + ' 项待修')
            : null,
          props.message.length > 0 ? h('span', { className: 'tp-ok' }, props.message) : null),
        props.error ? h('p', { className: 'tp-err' }, props.error) : null)
    }

    /**
     * 单个项目卡片。
     *
     * 字段表是手写的（`PROJECT_SECTIONS`），对应 `src/core/config.js:validateProject`。
     * 每张卡片只渲染存在差值的字段路径发 mutate —— 绝不整数组替换：`path:['projects']`
     * 会被宿主以「not volatile」拒掉，而且整替换会覆盖掉别人在同一份配置里改的其它项目。
     */
    function ProjectCard (props) {
      var index = props.index
      var record = props.record
      var draft = props.draft
      var issues = props.issues
      var disabled = props.disabled
      var changedCount = countProjectChanges(props)

      var title = record && record.name ? record.name : ('项目 #' + (index + 1))
      var open = props.open !== false
      var hiddenCount = hiddenProjectFieldCount(record, draft, issues, index, props.showAdvanced)

      // 收起时也得能看出「这里有东西要修」—— 否则折叠就成了遮蔽错误的工具。
      var errorCount = 0
      for (var s0 = 0; s0 < PROJECT_SECTIONS.length; s0 += 1) {
        for (var f0 = 0; f0 < PROJECT_SECTIONS[s0].fields.length; f0 += 1) {
          if (isErrorIssue(fieldIssueOf(issues, index, PROJECT_SECTIONS[s0].fields[f0]))) errorCount += 1
        }
      }

      var head = h('div', { className: 'tp-proj-head' },
        h('button', {
          type: 'button',
          // 两个类名：tp-toggle 给样式复用，tp-proj-toggle 让自测能把「项目卡片的
          // 折叠」和「配置分组的折叠」分开数 —— 混在一起数，加一张项目卡片就会
          // 让「每个分组都有折叠标题」那条断言莫名其妙地红。
          className: 'tp-toggle tp-proj-toggle',
          'aria-expanded': open ? 'true' : 'false',
          onClick: function () { props.onToggle(index) },
        },
          h('span', { className: 'tp-caret' }, open ? '▾' : '▸'),
          h('strong', null, title)),
        h('span', { className: 'tp-badge' }, record && record.platform ? record.platform : '未配置平台'),
        changedCount > 0 ? h('span', { className: 'tp-badge tp-on' }, '已改 ' + changedCount + ' 项') : null,
        errorCount > 0 ? h('span', { className: 'tp-badge tp-bad' }, errorCount + ' 项待修') : null,
        // 说「未显示」而不是「高级」：藏起来的原因不止一种（不给这个平台用的组、
        // 高级字段），把它们混称「高级设置」会让人以为是同一个开关能全放出来。
        hiddenCount > 0 && open ? h('span', { className: 'tp-badge' }, hiddenCount + ' 项未显示') : null,
        h('span', { className: 'tp-spacer' }),
        record && record.remoteMrEnabled ? h('span', { className: 'tp-badge' }, '开 MR') : null)

      var sections = PROJECT_SECTIONS.filter(function (section) {
        return sectionVisible(section, record, draft, issues, index, props.showAdvanced)
      }).map(function (section) {
        var fields = section.fields.filter(function (field) {
          return fieldVisible(field, record, draft, issues, index, props.showAdvanced)
        }).map(function (field) {
          var key = projectKey(index, field.path)
          var value = hasKey(draft, key) ? draft[key] : projectDraftValue(record, field)
          var issue = issues ? issues[key] : undefined
          var invalid = issue !== undefined && issue !== null && issue.level === 'error'
          var base = projectDraftValue(record, field)
          var changed = !sameDraft(value, base)

          var control
          if (field.kind === 'bool') {
            control = h('label', { className: 'tp-check' },
              h('input', {
                type: 'checkbox',
                checked: Boolean(value),
                disabled: disabled,
                onChange: function (event) { props.onEdit(key, event.target.checked) },
              }),
              '启用')
          } else if (field.kind === 'select') {
            var options = field.options.map(function (option) {
              return h('option', { key: option, value: option }, option)
            })
            control = h('select', {
              className: 'tp-select',
              value: String(value),
              disabled: disabled,
              onChange: function (event) { props.onEdit(key, event.target.value) },
            }, options)
          } else if (field.kind === 'branch') {
            // 分支：输入框 + datalist。
            //
            // 为什么不是纯 <select>：仓库里列不出分支时（新克隆、repo.path 还没填、
            // 宿主没给 git 执行链路）下拉会是空的，人就彻底没法填了。输入框 + 候选
            // 让「列不出来」退化成「手打」而不是「填不了」；列得出来时又等于下拉。
            var listId = 'tp-branches-' + index + '-' + field.path.join('-')
            var choices = Array.isArray(props.branchChoices) ? props.branchChoices : []
            var branchOptions = choices.map(function (name) {
              return h('option', { key: name, value: name }, name)
            })
            control = h('div', { className: 'tp-branch' },
              h('input', {
                className: 'tp-input',
                type: 'text',
                list: listId,
                value: String(value === undefined || value === null ? '' : value),
                disabled: disabled,
                placeholder: choices.length > 0 ? '从候选里选，或直接手打' : '仓库里没读到分支，直接手打',
                autoComplete: 'off',
                onChange: function (event) { props.onEdit(key, event.target.value) },
              }),
              h('datalist', { id: listId }, branchOptions),
              choices.length > 0
                ? h('span', { className: 'tp-help' }, '候选 ' + choices.length + ' 条（来自这个项目的检出）')
                : h('span', { className: 'tp-help' }, props.branchNote || '没读到分支清单；不影响保存，手打即可。'))
          } else {
            control = h('input', {
              className: 'tp-input',
              type: 'text',
              value: String(value === undefined || value === null ? '' : value),
              disabled: disabled,
              placeholder: field.kind === 'list' ? '逗号分隔' : undefined,
              autoComplete: 'off',
              onChange: function (event) { props.onEdit(key, event.target.value) },
            })
          }

          // 「来自 profile 的当前值」：改过的字段直接把这个原值摊开写出来，
          // 没改的挂在 title 上（21 个字段全摊开会把卡片撑爆）。
          var profileHint = '来自 profile 的当前值：' + describeBase(base)

          return h('div', {
            key: key,
            className: 'tp-field' + (invalid ? ' tp-invalid' : ''),
            title: profileHint,
          },
            h('div', null,
              h('label', null, field.label,
                changed
                  ? h('span', { style: { marginLeft: '8px', display: 'inline-flex', gap: '6px', alignItems: 'center' } },
                    h('span', { className: 'tp-badge tp-on' }, '已改'),
                    h('button', {
                      type: 'button',
                      className: 'tp-btn',
                      style: { minHeight: '24px', padding: '0 8px', fontSize: '11px' },
                      disabled: disabled,
                      onClick: function () { props.onRevert(key, base) },
                    }, '撤销'))
                  : null),
              changed
                ? h('p', { className: 'tp-help' }, '来自 profile 的当前值：' + describeBase(base))
                : null,
              field.hint ? h('p', { className: 'tp-help' }, field.hint) : null),
            h('div', null,
              control,
              issue !== undefined && issue !== null
                ? h('p', { className: issue.level === 'error' ? 'tp-field-err' : 'tp-soft' }, issue.text)
                : null))
        })
        // 组也能折：一个项目 5 组全摊开时，光一个项目就顶满一屏。
        // 组内必填项与平台专属组默认展开，其余（验证命令、高级）默认收起；
        // 用户点过就以记住的为准，和上面「配置」那堆分组同一套语义。
        var sectionOpen = props.isSectionOpen(index, section.key)
        var sectionChanged = 0
        for (var sf = 0; sf < section.fields.length; sf += 1) {
          if (isFieldChanged(record, draft, index, section.fields[sf])) sectionChanged += 1
        }
        return h('div', { key: section.key, className: 'tp-group' },
          h('h4', null,
            h('button', {
              type: 'button',
              className: 'tp-toggle',
              'aria-expanded': sectionOpen ? 'true' : 'false',
              onClick: function () { props.onToggleSection(index, section.key) },
            },
              h('span', { className: 'tp-caret' }, sectionOpen ? '▾' : '▸'),
              section.label,
              sectionChanged > 0 ? h('span', { className: 'tp-badge tp-on' }, '已改 ' + sectionChanged + ' 项') : null)),
          sectionOpen ? fields : null)
      })

      // appToken：宿主只下发 hasAppToken + 打码预览，明文永不出宿主。
      // 这里绝不提供输入框 —— 填了也没地方存，还会让人以为存进了凭据库。
      // 只在飞书项目上画：这是 feishu 专属的只读状态，别的平台显示它只会添乱。
      var platformKey = projectKey(index, ['match', 'platform'])
      var platformNow = hasKey(draft, platformKey)
        ? String(draft[platformKey])
        : (record && record.platform ? record.platform : '')
      var tokenText = record && record.hasAppToken
        ? '已配置' + (record.appTokenPreview ? '（' + record.appTokenPreview + '）' : '')
        : '未配置'
      var tokenRow = platformNow === 'feishu'
        ? h('div', { className: 'tp-field' },
          h('div', null,
            h('label', null, '飞书 appToken'),
            h('p', { className: 'tp-help' },
              '只读：appToken 里有明文密钥，宿主不会下发到浏览器。要改请改 profile 的 ',
              h('code', null, 'cordis.patch.yml'),
              '。')),
          h('div', null,
            h('span', { className: 'tp-badge' + (record && record.hasAppToken ? ' tp-on' : '') }, tokenText)))
        : null

      return h('div', { className: 'tp-proj' + (open ? '' : ' tp-collapsed') },
        head,
        open ? h('div', { className: 'tp-proj-body' }, sections, tokenRow) : null)
    }

    /** 这张卡片里有多少个字段改过（用于「已改 N 项」徽标）。 */
    function countProjectChanges (props) {
      var count = 0
      for (var s = 0; s < PROJECT_SECTIONS.length; s += 1) {
        var fields = PROJECT_SECTIONS[s].fields
        for (var f = 0; f < fields.length; f += 1) {
          var key = projectKey(props.index, fields[f].path)
          var value = hasKey(props.draft, key) ? props.draft[key] : projectDraftValue(props.record, fields[f])
          if (!sameDraft(value, projectDraftValue(props.record, fields[f]))) count += 1
        }
      }
      return count
    }

    /**
     * 「项目清单」整块。
     *
     * 数据来源是宿主的 `ticketPipeline.projects()`（只读投影）；改动走
     * `settings.mutate` 的深层路径。两者刻意分开：读用的是打了码的投影，
     * 写用的是设置通道，谁也不会把 appToken 明文带到浏览器里。
     */
    function ProjectListCard (props) {
      var list = props.list
      var draft = props.draft

      var body
      if (props.busy) {
        body = h('p', { className: 'tp-note' }, '正在读取项目清单…')
      } else if (props.error.length > 0) {
        body = h('p', { className: 'tp-err' }, props.error)
      } else if (list.length === 0) {
        body = h('div', { className: 'tp-empty' },
          h('p', null, '还没有配置任何项目。'),
          h('p', null,
            '项目（工单表 → 仓库的绑定）是结构化数组。上面已经可以编辑了；',
            '如果当前宿主还不支持通过设置通道写 ',
            h('code', null, 'projects'),
            '，保存时会把宿主原话显示出来 —— 那就改 profile 的 ',
            h('code', null, 'cordis.patch.yml'),
            ' 里本行的 ',
            h('code', null, 'config.projects'),
            '，改完重启 DSH 生效。'))
      } else {
        body = h('div', null, list.map(function (record, index) {
          // 分支候选按 index 对（宿主的 `branches()` 与 `projects()` 用的是同一次
          // `config.projects` 遍历，index 一定对得上；按 repoPath 对会在两个项目
          // 指向同一个检出时串味）。
          var entry = props.branchList && props.branchList[index] ? props.branchList[index] : null
          return h(ProjectCard, {
            key: 'p' + index,
            index: index,
            record: record,
            draft: draft,
            issues: props.issues,
            disabled: props.disabled,
            onEdit: props.onEdit,
            onRevert: props.onRevert,
            branchChoices: entry && Array.isArray(entry.branches) ? entry.branches : [],
            branchNote: entry && entry.ok === false && entry.reason ? entry.reason : '',
            open: props.isProjectOpen(index),
            showAdvanced: props.showAdvanced,
            onToggle: props.onToggleProject,
            isSectionOpen: props.isSectionOpen,
            onToggleSection: props.onToggleSection,
          })
        }))
      }

      return h('section', { className: 'tp-card' },
        h('h3', null, '项目清单',
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' } },
            list.length > 0 ? h('span', { className: 'tp-ok' }, list.length + ' 个项目') : null,
            // 高级字段开关：缺省视图只画日常要动的那些，想看全的点一下。
            // 这是一次性的「我现在要配细节」，所以不记进 localStorage。
            h('label', { className: 'tp-check', title: '勾上就显示「开 draft MR」「验证命令」「允许的截图主机」等不常改的字段' },
              h('input', {
                type: 'checkbox',
                checked: props.showAdvanced === true,
                disabled: props.disabled,
                onChange: function (event) { props.onToggleAdvanced(event.target.checked) },
              }),
              '显示全部字段'),
            h('button', {
              type: 'button',
              className: 'tp-btn',
              disabled: props.disabled || props.busy,
              onClick: props.onReload,
            }, props.busy ? '读取中…' : '重新读取'))),
        h('p', { className: 'tp-note' },
          '每个项目 = 一张工单表 + 一个仓库的绑定。点项目名可以收起它；',
          '改哪项就只写哪项（深层路径），不会整块覆盖。'),
        body,
        props.message.length > 0 ? h('p', { className: 'tp-note', style: { marginTop: '8px' } }, props.message) : null,
        props.saveError ? h('p', { className: 'tp-err' }, props.saveError) : null)
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
      // remote 不能在 apply 时抓一次：浏览器侧 gateway 的 `remote` 要等
      // typert / connection 就绪才出现，常常比我们晚。每次用时现取。
      var getRemote = props.getRemote
      var getNamespace = props.getNamespace
      var ensureRemoteMounted = props.ensureRemoteMounted
      var remote = getRemote()
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

      // 项目清单：数据来自宿主 `ticketPipeline.projects()`（只读投影，appToken 已打码），
      // 改动走 settings.mutate 的深层路径。两条通道刻意分开。
      var [projList, setProjList] = useState([])
      var [projBusy, setProjBusy] = useState(false)
      var [projError, setProjError] = useState('')
      var [projDraft, setProjDraft] = useState({})
      var [projInitial, setProjInitial] = useState({})

      // 分支候选：来自宿主 `ticketPipeline.branches()`（每个项目一份）。
      // 刻意与项目清单分开存 —— 分支取不到是常态（repo.path 还没填、路径不是
      // git 检出），不该让「项目清单」跟着报错。
      var [branchList, setBranchList] = useState([])
      var [branchBusy, setBranchBusy] = useState(false)

      // 折叠状态与「服务端拒绝后挂到字段上的错误」都按 key 存。
      var [openMap, setOpenMap] = useState(readOpenMap)
      var [serverIssues, setServerIssues] = useState({})

      // 项目卡片的折叠：整张卡的展开/收起、卡内每一组的展开/收起、以及
      // 「显示全部字段」开关。整卡与卡内的开合记在 localStorage（`projMap`），
      // 高级开关**不记** —— 它是「我现在要配细节」的一次性意图，下次进来
      // 还全摊开反而又变回一屏放不下。
      var [projMap, setProjMap] = useState(readProjMap)
      var [showAdvanced, setShowAdvanced] = useState(false)

      var isPage = props.view !== 'summary'

      var loadSettings = useCallback(function (target) {
        var ns = target !== undefined ? target : getNamespace('settings')
        if (!ns) {
          setLoading(false)
          setLoadError('settings 服务不可用（宿主 remote.settings 命名空间没挂上）。')
          return Promise.resolve()
        }
        return ns.describe().then(function (response) {
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
      }, [getNamespace])

      var loadCredentials = useCallback(function (target) {
        var ns = target !== undefined ? target : getNamespace('credentials')
        if (!ns) return Promise.resolve()
        var refs = CREDENTIAL_REFS.map(function (item) { return item.ref })
        return ns.describe(refs).then(function (response) {
          if (response && response.ok) setCreds(response.value || {})
        }, function () {})
      }, [getNamespace])

      // 分支候选走 `ticketPipeline.branches()`：宿主对每个项目的检出跑一次
      // `git for-each-ref`。失败是常态（repo.path 空、路径不是 git 检出），
      // 所以这里**从不设错误**：拿到什么算什么，拿不到就让下拉退化成手打。
      var loadBranches = useCallback(function (ns) {
        var target = ns || getNamespace('ticketPipeline')
        if (!target || typeof target.branches !== 'function') {
          setBranchList([])
          return Promise.resolve()
        }
        setBranchBusy(true)
        return target.branches().then(function (response) {
          setBranchBusy(false)
          if (!response || !response.ok) {
            setBranchList([])
            return
          }
          var value = response.value || {}
          setBranchList(Array.isArray(value.branches) ? value.branches : [])
        }, function () {
          setBranchBusy(false)
          setBranchList([])
        })
      }, [getNamespace])

      // 项目清单走 `ticketPipeline.projects()`：宿主的只读投影（appToken 已打码）。
      // 拿不到就当空数组 —— 界面照样做出来，只是提示「没有项目」，不挡配置编辑。
      var loadProjects = useCallback(function (target) {
        var ns = target !== undefined ? target : getNamespace('ticketPipeline')
        setProjError('')
        if (!ns || typeof ns.projects !== 'function') {
          setProjList([])
          setProjDraft({})
          setProjInitial({})
          setBranchList([])
          setProjError('宿主还没提供 ticketPipeline.projects()（Remote 版本比面板旧）。项目清单暂时显示为空；配置仍然可以编辑。')
          return Promise.resolve()
        }
        setProjBusy(true)
        return ns.projects().then(function (response) {
          setProjBusy(false)
          if (!response || !response.ok) {
            setProjList([])
            setBranchList([])
            setProjError('读取项目清单失败：' + ((response && response.error && response.error.message) || '未知错误'))
            return
          }
          var value = response.value || {}
          var list = Array.isArray(value.projects) ? value.projects : []
          var nextDraft = {}
          for (var i = 0; i < list.length; i += 1) {
            var perProject = projectDrafts(list[i], i)
            var keys = Object.keys(perProject)
            for (var k = 0; k < keys.length; k += 1) nextDraft[keys[k]] = perProject[keys[k]]
          }
          setProjList(list)
          setProjDraft(nextDraft)
          setProjInitial(nextDraft)
          // 项目清单到手后再补分支候选：分支要比项目清单慢（要真跑 git），
          // 分开发不至于让项目卡片等 git；拿不到就退化成手打，不算错误。
          loadBranches(ns)
        }, function (error) {
          setProjBusy(false)
          setProjList([])
          setBranchList([])
          setProjError('读取项目清单失败：' + (error && error.message ? error.message : String(error)))
        })
      }, [getNamespace])

      useEffect(function () {
        if (!isPage) return
        var cancelled = false
        var attempts = 0
        setLoading(true)

        // remote 通道可能比我们晚就绪（要等 typert + connection）。每 500ms 试一次，
        // 最多 40 次（20 秒）；期间面板显示「通道连接中」而不是直接报错。
        function attempt () {
          if (cancelled) return
          attempts += 1
          var r = getRemote()
          if (!r) {
            if (attempts < 40) { setTimeout(attempt, 500); return }
            setLoading(false)
            setLoadError('浏览器侧 remote 通道一直没就绪（等了 20 秒）。可以刷新页面重试。')
            setMounted(false)
            setDoctorError('挂载体检通道失败：remote 服务缺席（ctx.remote 拿不到）')
            return
          }
          // settings 命名空间是宿主挂的，可能比 remote 服务晚到位。等到它再读表单，
          // 否则会读到「命名空间缺席」的假错误。
          if (!getNamespace('settings')) {
            if (attempts < 40) { setTimeout(attempt, 500); return }
            setLoading(false)
            setLoadError('宿主没提供 remote.settings 命名空间（等了 20 秒）。可以刷新页面重试。')
            return
          }
          ensureRemoteMounted().then(function () {
            if (cancelled) return
            setMounted(true)
            setDoctorError('')
          }, function (error) {
            if (cancelled) return
            setMounted(false)
            setDoctorError('挂载体检通道失败：' + (error && error.message ? error.message : String(error)))
          })
          loadSettings().then(function () {
            if (cancelled) return
            loadCredentials()
            loadProjects()
          })
          diag('panel-remote', attempts)
        }

        attempt()
        return function () { cancelled = true }
      }, [])

      var leaves = useMemo(function () {
        var view = findNamespace(snapshot)
        if (!view) return []
        var envelope = view.schema || {}
        return collectLeaves(schemaRoot(envelope), envelope.refs || {}, [], [])
      }, [snapshot])

      var dirty = !sameDraft(draft, initialDraft)

      // 项目清单和配置是两条通道、两套 key，脏标记也必须分开算 —— 否则改了个项目
      // 却让「配置」卡片显示未保存，人会以为改错了地方。
      var projectDirty = !sameDraft(projDraft, projInitial)

      var configKeys = useMemo(function () {
        var out = []
        for (var i = 0; i < leaves.length; i += 1) out.push(keyOf(leaves[i]))
        return out
      }, [leaves])

      var localConfigIssues = useMemo(function () {
        return configIssues(leaves, draft)
      }, [leaves, draft])

      var localProjectIssues = useMemo(function () {
        return allProjectIssues(projList, projDraft)
      }, [projList, projDraft])

      // 本地即时校验 + 上次保存被服务端拒绝的字段，合成一张表；error 级别会拦保存。
      var issues = useMemo(function () {
        var merged = mergeIssues(localConfigIssues.byKey, serverIssues)
        var byKey = merged.byKey
        var errorCount = merged.errorCount
        var projectKeys = Object.keys(localProjectIssues.byKey)
        for (var i = 0; i < projectKeys.length; i += 1) {
          var one = projectKeys[i]
          if (byKey[one] !== undefined) continue
          byKey[one] = localProjectIssues.byKey[one]
          if (localProjectIssues.byKey[one].level === 'error') errorCount += 1
        }
        return { byKey: byKey, errorCount: errorCount }
      }, [localConfigIssues, localProjectIssues, serverIssues])

      var changedCount = useMemo(function () {
        var count = 0
        for (var i = 0; i < leaves.length; i += 1) {
          var key = keyOf(leaves[i])
          if (!sameDraft(draft[key], initialDraft[key])) count += 1
        }
        for (var p = 0; p < projList.length; p += 1) {
          for (var s = 0; s < PROJECT_SECTIONS.length; s += 1) {
            var fields = PROJECT_SECTIONS[s].fields
            for (var f = 0; f < fields.length; f += 1) {
              var pkey = projectKey(p, fields[f].path)
              if (!sameDraft(projDraft[pkey], projInitial[pkey])) count += 1
            }
          }
        }
        return count
      }, [leaves, draft, initialDraft, projList, projDraft, projInitial])

      /**
       * 清掉服务端挂在某个字段上的旧抱怨。
       *
       * 服务端拒绝过一次之后，那条 issue 会一直留在表里、把保存按钮锁死；
       * 人把值改对了却还被告知「N 项待修」，只能整页放弃改动才能再存 —— 太蠢。
       * 改这个字段本身就是「我重填了」，先撤掉旧抱怨，再让本地校验重新说话。
       */
      function clearServerIssue (key) {
        setServerIssues(function (previous) {
          if (!hasKey(previous, key)) return previous
          var copy = Object.assign({}, previous)
          delete copy[key]
          return copy
        })
      }

      function onEdit (key, next) {
        setDraft(function (previous) {
          var copy = Object.assign({}, previous)
          copy[key] = next
          return copy
        })
        clearServerIssue(key)
        setSaveMessage('')
        setSaveError('')
      }

      function onReset () {
        setDraft(Object.assign({}, initialDraft))
        setProjDraft(Object.assign({}, projInitial))
        setServerIssues({})
        setSaveMessage('')
        setSaveError('')
      }

      /** 单字段撤销：只回退这一个 key，别的改动留着。 */
      function onRevert (key) {
        setDraft(function (previous) {
          var copy = Object.assign({}, previous)
          copy[key] = initialDraft[key]
          return copy
        })
        clearServerIssue(key)
        setSaveMessage('')
        setSaveError('')
      }

      function onProjectEdit (key, next) {
        setProjDraft(function (previous) {
          var copy = Object.assign({}, previous)
          copy[key] = next
          return copy
        })
        clearServerIssue(key)
        setSaveMessage('')
        setSaveError('')
      }

      function onProjectRevert (key, base) {
        setProjDraft(function (previous) {
          var copy = Object.assign({}, previous)
          copy[key] = base
          return copy
        })
        clearServerIssue(key)
        setSaveMessage('')
        setSaveError('')
      }

      function onToggleGroup (label) {
        setOpenMap(function (previous) {
          var copy = Object.assign({}, previous)
          copy[label] = !isGroupOpen(previous, label)
          writeOpenMap(copy)
          return copy
        })
      }

      /**
       * 整张项目卡片的开合。**缺省展开** —— 用户是来看「我该填什么」的，
       * 一进来就全收起来等于让他先点两下才看得见路径输入框。收起来是工具，
       * 不是默认形态。
       */
      function isProjectOpenOf (map, index) {
        var key = projectOpenKey(index)
        if (hasKey(map, key)) return map[key] !== false
        return true
      }

      function onToggleProject (index) {
        setProjMap(function (previous) {
          var copy = Object.assign({}, previous)
          var key = projectOpenKey(index)
          copy[key] = !isProjectOpenOf(previous, index)
          writeProjMap(copy)
          return copy
        })
      }

      function onToggleProjectSection (index, sectionKey) {
        setProjMap(function (previous) {
          var copy = Object.assign({}, previous)
          var key = projectSectionOpenKey(index, sectionKey)
          copy[key] = !isProjectSectionOpen(previous, index, sectionKey)
          writeProjMap(copy)
          return copy
        })
      }

      /** 配置项 + 项目改动合成一笔 mutate：一次 revision 检查，失败不会只写一半（整笔拒）。 */
      function collectOps () {
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
        // 项目只发**改过的字段**，路径是 ['projects', '<i>', ...field.path]：
        // 绝不能发 ['projects'] —— 宿主会以「not volatile」整笔拒掉，而且整块替换
        // 会把别的项目、以及配置文件里手写的字段一起抹掉。
        for (var p = 0; p < projList.length; p += 1) {
          for (var s = 0; s < PROJECT_SECTIONS.length; s += 1) {
            var fields = PROJECT_SECTIONS[s].fields
            for (var f = 0; f < fields.length; f += 1) {
              var field = fields[f]
              var pkey = projectKey(p, field.path)
              if (sameDraft(projDraft[pkey], projInitial[pkey])) continue
              ops.push({
                op: 'set',
                path: ['projects', String(p)].concat(field.path),
                value: projectRawValue(field, projDraft[pkey]),
              })
            }
          }
        }
        return ops
      }

      function onSave () {
        var view = findNamespace(snapshot)
        var ns = getNamespace('settings')
        if (!view || !ns) return
        var ops = collectOps()
        if (ops.length === 0) {
          setDraft(Object.assign({}, initialDraft))
          setProjDraft(Object.assign({}, projInitial))
          setSaveMessage('没有需要保存的改动')
          return
        }
        setSaving(true)
        setSaveError('')
        setSaveMessage('')
        ns.mutate(NAMESPACE, ops, view.revision).then(function (response) {
          setSaving(false)
          if (!response || !response.ok) {
            var detail = response && response.error ? response.error : {}
            var message = detail.message || '未知错误'
            var mapped = mapServerIssues(message, configKeys)
            setServerIssues(mapped.byKey)
            var head = detail.code === 'SETTINGS_CONFLICT'
              ? '配置在别处被改过，已重新载入，请重试。'
              : '保存失败：' + message
            // 兜底：宿主如果把 projects 这段整体判成「不可写」，回来的就是
            // `Config field "projects" is not declared` / `is not volatile` 这类
            // 底层文案 —— 对用户没有意义，给一句能照着做的。
            // 正常的深层路径写入（`projects[0].repo.path`）不会走到这里。
            if (/projects["'\]\s]*(is not|is)/i.test(message) && /not (volatile|declared)/i.test(message)) {
              head += '\n项目配置这段被宿主拒了。先把上面这段错误原文发给我，或者临时改 profile 的 cordis.patch.yml 里本行的 config.projects 顶上。'
            }
            if (mapped.top.length > 0) head += '\n' + mapped.top
            setSaveError(head)
            return loadSettings()
          }
          setServerIssues({})
          setSaveMessage('已保存')
          return loadSettings().then(function () { return loadProjects() })
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
        var ns = getNamespace('credentials')
        if (!ns) return
        var value = String(credDraft[ref] || '').trim()
        if (value.length === 0) return
        setCredBusy(ref)
        ns.set(ref, value).then(function (response) {
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
        var ns = getNamespace('credentials')
        if (!ns) return
        setCredBusy(ref)
        ns.unset(ref).then(function (response) {
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
        var ns = getNamespace('ticketPipeline')
        if (!ns) {
          setDoctorError('体检通道没挂上（remote.ticketPipeline 命名空间缺席）。')
          return
        }
        setDoctorBusy(true)
        setDoctorError('')
        ns.doctor().then(function (response) {
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
        return h('div', { className: 'tp-panel' },
          h('header', { className: 'tp-head' },
            h('h2', null, '工单流水线'),
            h('p', null, '从工单表检测变化、定位代码、改动验证、开 draft MR 并推送通知。')),
          h('p', { className: 'tp-note' }, '正在等待宿主就绪…'),
          h('p', { className: 'tp-note', style: { marginTop: '6px' } },
            '浏览器侧的 remote 通道要等 typert / connection 启动，通常一两秒。最多等 20 秒，超时会告诉你卡在哪一步。'))
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

        // 顶部操作条：33 个配置项 + N 张项目卡片，页面很长，保存按钮得一直够得着。
        h('div', { className: 'tp-bar' },
          h('button', {
            type: 'button',
            className: 'tp-btn tp-primary',
            disabled: saving || issues.errorCount > 0 || changedCount === 0,
            onClick: onSave,
          }, saving ? '保存中…' : '保存'),
          h('button', {
            type: 'button',
            className: 'tp-btn',
            disabled: saving || changedCount === 0,
            onClick: onReset,
          }, '放弃改动'),
          h('button', {
            type: 'button',
            className: 'tp-btn',
            disabled: saving || projBusy,
            onClick: function () {
              loadSettings()
              loadProjects()
              loadCredentials()
            },
          }, '重新载入'),
          h('button', {
            type: 'button',
            className: 'tp-btn',
            disabled: doctorBusy || !mounted,
            onClick: onDoctor,
          }, doctorBusy ? '体检中…' : '体检'),
          h('span', { className: 'tp-spacer' }),
          issues.errorCount > 0
            ? h('span', { className: 'tp-count' }, issues.errorCount + ' 项待修')
            : null,
          changedCount > 0
            ? h('span', { className: 'tp-count' }, '未保存 ' + changedCount + ' 项')
            : null),

        // 保存失败（含服务端拒绝）贴着操作条显示：人点完保存眼睛还在这里。
        saveError.length > 0 ? h('p', { className: 'tp-err', style: { marginTop: '0', whiteSpace: 'pre-wrap' } }, saveError) : null,
        saveMessage.length > 0 ? h('p', { className: 'tp-note' }, saveMessage) : null,
        loadError.length > 0 ? h('p', { className: 'tp-err', style: { marginTop: '0' } }, loadError) : null,

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
          initialDraft: initialDraft,
          secrets: secretMap,
          disabled: saving,
          dirty: dirty,
          saving: saving,
          error: '',
          message: '',
          issues: issues.byKey,
          errorCount: issues.errorCount,
          isOpen: function (label) { return isGroupOpen(openMap, label) },
          onToggle: onToggleGroup,
          onEdit: onEdit,
          onRevert: onRevert,
          onSave: onSave,
          onReset: onReset,
        }),

        h(ProjectListCard, {
          list: projList,
          draft: projDraft,
          issues: issues.byKey,
          busy: projBusy,
          error: projError,
          disabled: saving,
          message: '',
          saveError: '',
          dirty: projectDirty,
          onReload: loadProjects,
          onEdit: onProjectEdit,
          onRevert: onProjectRevert,
          branchList: branchList,
          branchBusy: branchBusy,
          showAdvanced: showAdvanced,
          onToggleAdvanced: setShowAdvanced,
          isProjectOpen: function (index) { return isProjectOpenOf(projMap, index) },
          onToggleProject: onToggleProject,
          isSectionOpen: function (index, sectionKey) { return isProjectSectionOpen(projMap, index, sectionKey) },
          onToggleSection: onToggleProjectSection,
        }))
    }

    // 硬依赖只有 slots —— 它由 dsh-client-ui-renderer 启动时就 provide，不存在「等不到」。
    //
    // remote（dsh-api-gateway 提供）**不能**写进 inject：它自己还要等 typert / connection，
    // 只要它在某个部署里停在非 ACTIVE，我们的 fiber 就会永远挂在「waiting for
    // activation」，apply 一次都不执行 —— 表现就是设置页里静默地什么都没有。
    // 所以 remote 走 ctx.get('remote') 惰性取：拿得到就挂体检通道，拿不到就只禁用那个按钮。
    var inject = ['slots']

    /** 诊断面包屑：最近一次加载走到了哪一步，写进 localStorage 的 `ticket-pipeline:diag`。 */
    var DIAG_KEY = 'ticket-pipeline:diag'

    function diag (stage, extra) {
      try {
        if (typeof localStorage === 'undefined') return
        var previous = null
        try { previous = JSON.parse(localStorage.getItem(DIAG_KEY) || 'null') } catch (error) { previous = null }
        var next = previous !== null && typeof previous === 'object' ? previous : {}
        var stages = next.stages !== null && typeof next.stages === 'object' && next.stages !== undefined ? next.stages : {}
        stages[stage] = extra === undefined ? true : extra
        next.at = new Date().toISOString()
        next.stages = stages
        localStorage.setItem(DIAG_KEY, JSON.stringify(next))
      } catch (error) {
        // 取证失败无所谓，绝不影响 UI。
      }
    }

    /** 惰性取 remote：没声明进 inject 时属性访问会抛，所以先 ctx.get，再退到属性访问兜底。 */
    function remoteOf (ctx) {
      if (ctx !== undefined && ctx !== null && typeof ctx.get === 'function') {
        try {
          var found = ctx.get('remote')
          if (found !== undefined && found !== null) return found
        } catch (error) {
          // 落到下面的兜底
        }
      }
      try {
        return ctx === undefined || ctx === null ? undefined : ctx.remote
      } catch (error) {
        return undefined
      }
    }

    /**
     * 取一个 Remote 命名空间服务（`settings` / `credentials` / `ticketPipeline`）。
     *
     * ## 为什么不能写 `ctx.remote.settings`
     *
     * cordis 的属性访问走 ReflectService.handler.get（cordis/lib/index.js:1253+）：
     * 属性没命中时它沿 **fiber 链向上** 找 provide 过该名字的 fiber。
     * 而命名空间服务是 **兄弟 fiber** 提供的 —— dsh-api-gateway 在自己的 fiber 下
     * `ownerCtx.plugin({ name: 'remote.<ns>' })` 建了一根独立 fiber（见
     * dsh-api-gateway/lib/client.browser.js 的 createNamespace），它不是我们的祖先。
     * 属性访问沿链找不到 ⇒ 抛 `cannot get property "remote.<ns>" without inject`。
     *
     * ## 为什么也不能写进 inject
     *
     * `ticketPipeline` 命名空间是 **我们自己** 通过 `remote.$mount()` 建的。
     * 写进 inject 就等于「等自己把命名空间建出来」⇒ 我们的 fiber 永远不激活，
     * apply 一次都不执行（表现：设置页里静默什么都没有）。
     *
     * ## 正确做法
     *
     * `ctx.get(name)` 不查 inject、不沿 fiber 链找，只在全局服务 store 里按名字取
     *（cordis/lib/index.js:1347-1356）。兄弟 fiber provide 的服务照样取得到。
     */
    function namespaceOf (ctx, name) {
      if (ctx === undefined || ctx === null) return undefined
      var key = 'remote.' + name
      if (typeof ctx.get === 'function') {
        try {
          var found = ctx.get(key)
          if (found !== undefined && found !== null) return found
        } catch (error) {
          // 落到下面的兜底
        }
      }
      // 兜底：gateway 服务自己维护着 namespaces 表（namespace → { service }）。
      var gateway = remoteOf(ctx)
      if (gateway && gateway.namespaces && typeof gateway.namespaces.get === 'function') {
        try {
          var entry = gateway.namespaces.get(name)
          if (entry && entry.service) return entry.service
        } catch (error) {
          // 忽略
        }
      }
      return undefined
    }

    /**
     * 挂一个 slot。
     *
     * slot 是 plugin-manager / settings-general 在运行时用 register({children}) 声明出来的，
     * 加载顺序不可控：声明还没出现时直接 register 会抛 `slot is not declared`。
     * 正确做法是 slots.inject(name, cb)：声明已存在就立刻跑 cb，否则挂起等声明出现。
     * register 本身也包一层 try/catch —— 注册失败只该少一块 UI，不该炸掉整个 apply。
     */
    function serveSlot (ctx, options, component) {
      var name = options.name
      var label = options.key !== undefined ? options.key : (options.id === undefined ? '' : '#' + options.id)

      var contribute = function () {
        try {
          var dispose = ctx.slots.register(options, component)
          diag('slot:' + name + (label.length > 0 ? (options.key !== undefined ? ':' : '') + label : ''))
          return dispose
        } catch (error) {
          var message = error && error.message ? error.message : String(error)
          diag('slot-error:' + name + label, message)
          console.error('[ticket-pipeline] 无法注册 ' + name + '：' + message)
          return null
        }
      }

      try {
        if (ctx.slots !== undefined && typeof ctx.slots.inject === 'function') {
          return ctx.slots.inject(name, contribute)
        }
        // 老版本没有 slots.inject：只能直接注册。
        return contribute()
      } catch (error) {
        var message = error && error.message ? error.message : String(error)
        diag('slot-inject-error:' + name, message)
        console.error('[ticket-pipeline] 无法挂 ' + name + '：' + message)
        return null
      }
    }

    /**
     * 体检通道（`ticketPipeline` 命名空间）的挂载。
     *
     * 只挂一次：同一个 namespace 二次 `$mount` 会被客户端 gateway 拒绝，而
     * apply 在重载 / HMR 时可能再跑一遍。用模块级 Promise 去重。
     *
     * 放在 apply 里而不是组件里：面板一打开按钮就该能点，不该先闪一下
     * 「Remote 没挂上」再等组件 effect 跑完。
     */
    var mountedPromise = null

    function ensureMounted (ctx, remote) {
      if (remote === undefined || remote === null) {
        return Promise.reject(new Error('remote 服务缺席（ctx.remote 拿不到）'))
      }
      // 已经挂过了（同名命名空间二次 $mount 会被 gateway 拒绝）⇒ 不用再挂。
      if (namespaceOf(ctx, 'ticketPipeline')) return Promise.resolve(undefined)
      if (mountedPromise !== null) return mountedPromise
      if (typeof remote['$mount'] !== 'function') {
        return Promise.reject(new Error('remote.$mount 缺席'))
      }
      mountedPromise = Promise.resolve()
        .then(function () { return remote['$mount'](TICKET_PIPELINE_REMOTE) })
        .then(function () { return undefined }, function (error) {
          // 挂失败不能把 Promise 缓存成永久失败：下次点体检还得能重试。
          mountedPromise = null
          throw error
        })
      return mountedPromise
    }

    /** 插件卸载 / 重载时把挂载缓存清掉，下一次 apply 重新挂。 */
    function resetMounted () {
      mountedPromise = null
    }

    function apply (ctx) {
      diag('apply')

      // 样式表：挂在 document.head，插件卸载时由 ctx.effect 收回。
      ctx.effect(function () {
        var style = document.createElement('style')
        style.dataset.ticketPipeline = 'true'
        style.textContent = CSS
        document.head.append(style)
        return function () { style.remove() }
      }, 'ticket-pipeline: settings styles')

      // 卸载 / 重载（改配置会导致插件实例重建）时，$mount 的 disposer 会收回命名空间，
      // 但模块级 Promise 还在 —— 不清掉的话下一次打开面板会以为「已挂上」而实际没有。
      ctx.effect(function () { return resetMounted }, 'ticket-pipeline: reset remote mount')

      // remote 不在 apply 时抓成常量：浏览器侧 gateway 的 `remote` 要等
      // typert + connection 就绪才 provide，常常晚于我们；抓一次就等于永远拿不到。
      var getRemote = function () { return remoteOf(ctx) }

      // 取命名空间服务。属性式（ctx.remote.settings）在兄弟 fiber 提供的场景下会抛
      // "cannot get property ... without inject"，必须走 ctx.get。
      var getNamespace = function (name) { return namespaceOf(ctx, name) }

      // 挂体检通道（幂等）。
      var ensureRemoteMounted = function () { return ensureMounted(ctx, getRemote()) }

      var initialRemote = getRemote()
      diag('remote', initialRemote === undefined || initialRemote === null ? 'absent' : 'present')

      // 体检通道尽早挂上；失败只记日志，不能让设置表单跟着挂掉。
      // remote 缺席时轮询等待（每 500ms，最多 60 次 = 30 秒），拿到就挂。
      var attempts = 0
      function tryMount () {
        attempts += 1
        var remote = getRemote()
        if (remote === undefined || remote === null) {
          if (attempts < 60) { diag('remote-wait', attempts); setTimeout(tryMount, 500); return }
          diag('remote-absent')
          console.error('[ticket-pipeline] 挂载体检通道失败：remote 服务缺席（ctx.remote 拿不到）')
          return
        }
        if (attempts > 1) diag('remote-late', attempts)
        ensureRemoteMounted().then(function () {
          diag('remote-mounted')
        }, function (error) {
          var message = error && error.message ? error.message : String(error)
          diag('remote-mount-failed', message)
          console.error('[ticket-pipeline] 挂载体检通道失败：' + message)
        })
      }
      tryMount()

      var panel = function (props) {
        return h(TicketPipelinePanel, Object.assign({}, props, {
          getRemote: getRemote,
          getNamespace: getNamespace,
          ensureRemoteMounted: ensureRemoteMounted,
        }))
      }

      // ① 设置对话框里的一节（设置 → 左侧「工单流水线」）。
      //
      // settings.section 由 dsh-client-ui-settings-general 在注册 shell 时就声明好了，
      // 不依赖 plugin-manager 是否装载 —— 这是本版本里最稳的配置入口。
      // label 可以是函数（resolveSlotLabel 会调用它），所以这里不需要 locale 服务。
      serveSlot(ctx, {
        name: 'settings.section',
        id: 'ticket-pipeline',
        order: 60,
        label: function () { return '工单流水线' },
      }, panel)

      // ② 设置 → 插件 → 「工单流水线」页签（settings.plugins.tab 由 ui-settings-plugins 声明）。
      serveSlot(ctx, {
        name: 'settings.plugins.tab',
        id: 'ticket-pipeline',
        order: 20,
        label: function () { return '工单流水线' },
      }, panel)

      // ③ 插件页 → 本包详情页 → 该行的「配置」（key = 包名 + '#' + row id）。
      // row id 来自 cordis.patch.yml 的 insert 行 id，就是 ticket-pipeline。
      serveSlot(ctx, {
        name: 'plugins.row.config',
        key: PACKAGE + '#' + ROW_ID,
      }, panel)

      // 兜底拼写：不同版本的 plugin-manager 对 key 的构造方式不完全一样，
      // 对不上就静默不渲染（连报错都没有），所以多注册几种常见形态。
      serveSlot(ctx, {
        name: 'plugins.row.config',
        key: PACKAGE,
      }, panel)

      // ④ 插件页 → 本包详情页顶部那一块（key = 包名）。
      serveSlot(ctx, {
        name: 'plugins.bundle.config',
        key: PACKAGE,
      }, panel)
    }

    return {
      name: 'ticket-pipeline-settings',
      inject: inject,
      apply: apply,
    }
  },
})
