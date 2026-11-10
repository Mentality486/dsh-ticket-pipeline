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
        {
          // 唯一带参的方法：面板「粘贴工单表链接」。浏览器只把链接交出去，
          // 解析与落盘都在宿主做 —— appToken 明文永远不进浏览器（见 src/remote/host.js）。
          // 参数必须两件都给 codec 与 strictCodec，且 wire 显式写成同名：
          // 网关的 assertExactArguments 按 wire 集合精确比对，多一个少一个都拒。
          id: 'ticket-pipeline#ticketPipeline/setProjectTable',
          service: 'ticketPipeline',
          namespace: 'ticketPipeline',
          method: 'setProjectTable',
          invocation: { kind: 'direct' },
          result: { mode: 'strict', typeSymbol: 'ticket-pipeline#ProjectWriteResult', create: function () { return { parse: function (value) { return value } } } },
          parameters: [
            {
              name: 'index',
              wire: 'index',
              description: 'projects[] 里的下标（从 0 开始），面板按 projects() 的顺序给',
              source: 'json',
              codec: {
                mode: 'strict',
                typeSymbol: 'ticket-pipeline#ticketPipeline/setProjectTable:index',
                create: function () {
                  return {
                    parse: function (value) {
                      var number = typeof value === 'number' ? value : Number(String(value).trim())
                      if (!Number.isInteger(number) || number < 0) throw new TypeError('setProjectTable: index 必须是 ≥0 的整数')
                      return number
                    },
                  }
                },
                jsonSchema: {},
              },
              strictCodec: {
                mode: 'strict',
                typeSymbol: 'ticket-pipeline#ticketPipeline/setProjectTable:index',
                create: function () {
                  return {
                    parse: function (value) {
                      var number = typeof value === 'number' ? value : Number(String(value).trim())
                      if (!Number.isInteger(number) || number < 0) throw new TypeError('setProjectTable: index 必须是 ≥0 的整数')
                      return number
                    },
                  }
                },
                jsonSchema: {},
              },
            },
            {
              name: 'url',
              wire: 'url',
              description: '用户粘贴的整条飞书链接（多维表格 / wiki / 电子表格），或裸 token',
              source: 'json',
              codec: {
                mode: 'strict',
                typeSymbol: 'ticket-pipeline#ticketPipeline/setProjectTable:url',
                create: function () {
                  return {
                    parse: function (value) {
                      if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('setProjectTable: url 必须是非空字符串')
                      return value
                    },
                  }
                },
                jsonSchema: {},
              },
              strictCodec: {
                mode: 'strict',
                typeSymbol: 'ticket-pipeline#ticketPipeline/setProjectTable:url',
                create: function () {
                  return {
                    parse: function (value) {
                      if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('setProjectTable: url 必须是非空字符串')
                      return value
                    },
                  }
                },
                jsonSchema: {},
              },
            },
          ],
        },
        // ── 运行页签（工单 #16）──────────────────────────────────
        // 这四个方法的实现全在宿主侧，且**转调工具已经抽好的算结果层**
        // （collectStatus / collectScan / collectCancel / collectReset），
        // 面板与对话里的 pipeline_status / scan / cancel / reset 是同一份代码。
        // 结果 codec 的类型名必须与 src/remote/descriptors.js 逐一对应，
        // 否则 client-check 的「两端描述符一致」会红。
        {
          id: 'ticket-pipeline#ticketPipeline/status',
          service: 'ticketPipeline',
          namespace: 'ticketPipeline',
          method: 'status',
          invocation: { kind: 'direct' },
          result: { mode: 'strict', typeSymbol: 'ticket-pipeline#PipelineStatus', create: function () { return { parse: function (value) { return value } } } },
          parameters: [],
        },
        {
          id: 'ticket-pipeline#ticketPipeline/scan',
          service: 'ticketPipeline',
          namespace: 'ticketPipeline',
          method: 'scan',
          invocation: { kind: 'direct' },
          result: { mode: 'strict', typeSymbol: 'ticket-pipeline#ScanResult', create: function () { return { parse: function (value) { return value } } } },
          parameters: [],
        },
        {
          id: 'ticket-pipeline#ticketPipeline/cancel',
          service: 'ticketPipeline',
          namespace: 'ticketPipeline',
          method: 'cancel',
          invocation: { kind: 'direct' },
          result: { mode: 'strict', typeSymbol: 'ticket-pipeline#CancelResult', create: function () { return { parse: function (value) { return value } } } },
          parameters: [],
        },
        {
          // 失败票行尾的「重跑」。这是唯一允许带「可选参数」的方法：
          // projectId 只有在多项目撞同一个 record_id 时才需要补，不传时
          // 浏览器的 prepareInvocation 不会把该 wire 写进 args（undefined 不写），
          // 宿主侧 acceptsUndefined:true 正好接住。
          id: 'ticket-pipeline#ticketPipeline/reset',
          service: 'ticketPipeline',
          namespace: 'ticketPipeline',
          method: 'reset',
          invocation: { kind: 'direct' },
          result: { mode: 'strict', typeSymbol: 'ticket-pipeline#ResetResult', create: function () { return { parse: function (value) { return value } } } },
          parameters: [
            {
              name: 'recordId',
              wire: 'recordId',
              description: '要重开的工单标识（飞书 record_id）',
              source: 'json',
              codec: {
                mode: 'strict',
                typeSymbol: 'ticket-pipeline#ticketPipeline/reset:recordId',
                create: function () {
                  return {
                    parse: function (value) {
                      if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('reset: recordId 必须是非空字符串')
                      return value
                    },
                  }
                },
                jsonSchema: {},
              },
              strictCodec: {
                mode: 'strict',
                typeSymbol: 'ticket-pipeline#ticketPipeline/reset:recordId',
                create: function () {
                  return {
                    parse: function (value) {
                      if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('reset: recordId 必须是非空字符串')
                      return value
                    },
                  }
                },
                jsonSchema: {},
              },
            },
            {
              name: 'projectId',
              wire: 'projectId',
              description: '工单所属项目名；只有同名 recordId 会冲突时才需要传',
              source: 'json',
              acceptsUndefined: true,
              codec: {
                mode: 'strict',
                typeSymbol: 'ticket-pipeline#ticketPipeline/reset:projectId',
                create: function () {
                  return {
                    parse: function (value) {
                      if (value === undefined) return undefined
                      if (typeof value !== 'string') throw new TypeError('reset: projectId 必须是字符串')
                      return value
                    },
                  }
                },
                jsonSchema: {},
              },
              strictCodec: {
                mode: 'strict',
                typeSymbol: 'ticket-pipeline#ticketPipeline/reset:projectId',
                create: function () {
                  return {
                    parse: function (value) {
                      if (value === undefined) return undefined
                      if (typeof value !== 'string') throw new TypeError('reset: projectId 必须是字符串')
                      return value
                    },
                  }
                },
                jsonSchema: {},
              },
            },
          ],
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
      { ref: 'GITLAB_TOKEN', label: 'GitLab Token', hint: '只在项目打开了「远程 MR（实验性）」时才需要；缺省交付形态是本地提交，你多半不用填。' },
      { ref: 'PUSHPLUS_TOKEN', label: 'PushPlus token', hint: '填这里就行。通知适配器选 PushPlus 时用它，不写进配置文件。' },
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
      // `projects` 是「项目清单」——结构化数组，由 ProjectListCard 专门画成卡片。
      // 绝不能当普通叶子收进来：那样会被 draftValueOf 拼成 "[object Object],
      // [object Object]" 显示成一个只读文本框（真实 bug，见 feature-checklist §1.14）。
      if (path.length === 1 && path[0] === 'projects') return out
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

    /** 一句话约束提示，例如「1–60」「可选：feishu / wps / mock」「缺省 30」。 */
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
        // 报错要带上「该填什么」，不然人只知道错了、不知道下一步做什么。
        // 缺省值就写在 descriptor 里（meta.default），直接拿来当推荐值。
        var pick = meta.default !== undefined && meta.default !== null
          ? '；不确定就先用缺省 ' + String(meta.default)
          : ''
        return { level: 'error', text: '只能是 ' + meta.enum.join(' / ') + pick }
      }

      if (leaf.node.type === 'number') {
        var raw = String(draftValue === undefined || draftValue === null ? '' : draftValue).trim()
        // 同上：空表示回落缺省，不是错误。
        if (raw.length === 0) return null
        var num = Number(raw)
        var range = meta.min !== undefined && meta.max !== undefined
          ? '填 ' + meta.min + '–' + meta.max + ' 之间的整数'
          : meta.min !== undefined
            ? '填不小于 ' + meta.min + ' 的整数'
            : meta.max !== undefined ? '填不大于 ' + meta.max + ' 的整数' : '填一个数字'
        if (!Number.isFinite(num)) return { level: 'error', text: '必须是数字（' + range + '）' }
        if (meta.min !== undefined && num < meta.min) return { level: 'error', text: '不能小于 ' + meta.min + '（' + range + '）' }
        if (meta.max !== undefined && num > meta.max) return { level: 'error', text: '不能大于 ' + meta.max + '（' + range + '）' }
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

    // ── 高级配置项 ──────────────────────────────────────────────
    //
    // 判断标准只有一条：**用户在没有出故障的情况下不会想调它**。
    // 满足这条的收进每组自己的「高级设置」折叠区 —— **不是删掉**，点一下就露出来。
    //
    // 反例（上一版被错藏起来的）：`maxAttempts` 重试次数 —— 人一开始就会问「跑挂了
    // 重试几次」；已经移出。`branchPrefix` 留在高级里，因为 CI 按前缀触发的人才关心。
    //
    // 判断用**键名**而不是 meta 标记：schema 是宿主发下来的，宿主加字段时不会知道
    // 本插件想把谁归成高级；而且键名表改起来一眼看得出范围。
    var ADVANCED_CONFIG_KEYS = {
      // 高级组（config.js 里 CONFIG_GROUPS 的 advanced 组）：出事才调，平时别碰。
      leaseTtlMinutes: true,
      branchPrefix: true,
      worktreeRetentionHours: true,
      keepSession: true,
      // agent 与模型组：换模型/输出上限是偶发动作，缺省收着。
      maxTokens: true,
      agentPreset: true,
      // 通知：回执地址要自己搭一个 HTTP 端点才有意义，收着。
      'pushplus.callbackUrl': true,
    }

    function isAdvancedConfigKey (key) {
      return ADVANCED_CONFIG_KEYS[key] === true
    }

    // `enabled` 不归任何分组：它是整页的总开关，置顶单独画。
    //
    // 为什么从组里摘出来：它原来在「杂项」组最底下，而缺省只展开一组 —— 新人装完
    // 打开面板看不见「怎么开始」，这是评审里最刺眼的一条。总开关不属于任何一组，
    // 因为它管的是「这个插件要不要干活」，而不是某一类参数。
    var MASTER_KEY = 'enabled'

    // 通知组按 `pushAdapter` 条件显隐。返回「这一档要露哪些键 + 一句说明」。
    //
    // 以前是 `onlyFor: '<platform>'` 只管项目卡片里的平台段；这里把它推广成通用的
    // 「按某个字段的当前草稿值决定显隐」。**不要**再单独造第二张硬编码键名表 ——
    // 判断依据只有这一处，改判定就改这一个函数。
    var NOTIFY_GROUP_LABEL = '通知'

    function notifyVisibility (adapter) {
      if (adapter === 'qqmail') {
        return {
          keep: ['pushAdapter', 'notifyOn', 'qqmail.host', 'qqmail.encryption', 'qqmail.user', 'qqmail.to'],
          note: '当前走 QQ 邮箱。授权码不在这里填，去「凭据」页填 QQMAIL_AUTH_CODE。',
        }
      }
      if (adapter === 'pushplus') {
        return {
          keep: ['pushAdapter', 'notifyOn', 'pushplus.channel', 'pushplus.callbackUrl'],
          note: '当前走 PushPlus。token 不在这里填，去「凭据」页填 PUSHPLUS_TOKEN。',
        }
      }
      return {
        keep: ['pushAdapter', 'notifyOn'],
        note: '当前是 mock：不会真的发通知，只往插件日志里写一行。换成 qqmail / pushplus 才会出现对应字段。',
      }
    }

    // 枚举值的中文说法。**只影响显示**，写下去的还是左边那个原值 ——
    // 别在这里顺手「翻译」配置值，否则校验和适配器都会认不出来。
    var ENUM_LABELS = {
      workExecutor: {
        mock: 'mock（只走流程，不改代码）',
        agent: 'agent（真的改代码）',
      },
      pushAdapter: {
        mock: 'mock（不发真通知）',
        qqmail: 'QQ 邮箱',
        pushplus: 'PushPlus',
      },
      'qqmail.encryption': {
        tls: 'tls（465 端口直连加密，推荐）',
        starttls: 'starttls（587 端口先明文再升级）',
      },
    }

    // ── 项目清单 ────────────────────────────────────────────────
    // 项目的 schema 是 `unknown`（宿主不往 schema 里放 projects 子树），所以字段表
    // 只能在这里手写一份。它对应 `src/core/config.js` 的 `validateProject`：
    // 改那边记得回来对一下。`from` 是 host `describeProject()` 的扁平字段名。

    var PLATFORMS = ['feishu', 'wps', 'mock']

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
          { path: ['description'], from: 'description', label: '说明', kind: 'text', advanced: true, hint: '随便写给人看的备注，不参与任何判断；留空也行。' },
          { path: ['match', 'platform'], from: 'platform', label: '平台', kind: 'select', options: PLATFORMS, required: true,
            // 金山源没有内置取数通道（工单 #20）：下拉里必须先把这件事写出来，
            // 否则人选了它、配完、开开关，然后永远等不到票 —— 而且不知道该怪谁。
            optionLabels: { wps: 'wps 金山文档（实验性，需自行注入取数通道）' },
            hint: '决定用哪个 ticket-source 适配器收票。wps 是实验性的：当前版本没有内置取数通道，选它会拿不到票。' },
        ],
      },
      {
        key: 'match',
        label: '工单表',
        fields: [
          { path: ['match', 'tableId'], from: 'tableId', label: '工单表 tableId', kind: 'text', hint: '多维表格的表 id（形如 tblXXXX，地址里 ?table= 后面那段）。粘贴链接时宿主会自动填它；手上有链接就不用管这一格。' },
          { path: ['match', 'docNamePattern'], from: 'docNamePattern', label: '表名匹配', kind: 'text', hint: '不给 token 时的兜底：按云文档名的片段找表（例：PMS项目管理系统工单）。适合「表名固定、但表是别人新建的、token 会变」的场景；找不到或找到多张都会报错。' },
          // 工作表名两边都用：金山拿它挑工作表，飞书电子表格也一样（同一个键，
          // 所以只在这里画一次 —— 画两次会变成两个输入框绑同一个草稿键）。
          { path: ['match', 'sheetName'], from: 'sheetName', label: '工作表名', kind: 'text', hint: '表格底部那个标签页的名字（如「工单」）。金山文档与飞书电子表格都用这一项；留空则用第一张可见工作表。' },
          { path: ['match', 'statusValues'], from: 'statusValues', label: '在处理中的状态值', kind: 'list', hint: '逗号分隔；状态列取这些值时才算「在处理中」。' },
          { path: ['match', 'viewId'], from: 'viewId', label: '视图 viewId', kind: 'text', advanced: true, hint: '只扫某一个视图时填（多维表格地址里 ?view= 后面那段）；留空表示整张表。' },
          { path: ['match', 'recordIds'], from: 'recordIds', label: '只处理这些工单', kind: 'list', advanced: true, hint: '逗号分隔的 record id；留空表示整张表。' },
          { path: ['match', 'allowedImageHosts'], from: 'allowedImageHosts', label: '允许的截图主机', kind: 'list', advanced: true, hint: '逗号分隔的主机名白名单；截图链接来自外部输入，不放行的一律拒绝。' },
        ],
      },
      {
        key: 'wps',
        label: '金山文档',
        onlyFor: 'wps',
        fields: [
          { path: ['match', 'sheetUrl'], from: 'sheetUrl', label: '表格链接', kind: 'text', hint: '金山文档的分享链接；插件按链接直接下载整本 xlsx，需要「任何人可查看」级别的分享。' },
          { path: ['match', 'statusColumn'], from: 'statusColumn', label: '状态列名', kind: 'text', hint: '哪一列表示「处理到哪一步」，缺省「是否处理」。' },
          { path: ['match', 'statusValue'], from: 'statusValue', label: '在处理中的取值', kind: 'text', hint: '状态列等于这个值时才算待办，缺省「处理中」。' },
          { path: ['match', 'mediaPrefix'], from: 'mediaPrefix', label: '附件前缀', kind: 'text', advanced: true, hint: '截图落在工作区时用的文件名前缀，缺省 wps-media。' },
        ],
      },
      {
        key: 'sheet',
        label: '飞书电子表格',
        onlyFor: 'feishu',
        fields: [
          {
            path: ['match', 'spreadsheetToken'],
            from: 'spreadsheetToken',
            label: '电子表格链接或 token',
            kind: 'text',
            hint: '工单表如果是「电子表格」（不是多维表格），把浏览器地址栏那条链接整条贴进来就行，插件会自己认出 spreadsheetToken。填了这个就不用填上面的 appToken/tableId。',
          },
          {
            path: ['match', 'sheetId'],
            from: 'sheetId',
            label: '工作表 id',
            kind: 'text',
            hint: '可选。留空就按上面的「工作表名」找；两个都不填则取第一张可见工作表。表 id 形如 shXXXXXX，在表格里右键工作表标签能看到。',
          },
          {
            path: ['match', 'sheetHeaderRow'],
            from: 'sheetHeaderRow',
            label: '表头在第几行',
            kind: 'text',
            hint: '缺省 1（第一行就是表头）。表头上方还有标题、说明行时填实际行号；插件不会自己往下找。',
          },
          {
            path: ['match', 'sheetIdColumn'],
            from: 'sheetIdColumn',
            label: '序号列名',
            kind: 'text',
            hint: '缺省「序号」。插件拿这一列的值当工单身份（同一行被重复收票靠它去重）；留空的行退回用行号，插行后会当成新工单。',
          },
          {
            path: ['match', 'sheetIdentity'],
            from: 'sheetIdentity',
            label: '行身份怎么认',
            kind: 'select',
            options: ['', 'seq', 'row'],
            hint: 'seq（缺省）=按序号列，稳定但同序号重复会报错；row=按物理行号，插入/删除行会让旧工单串位。没特殊理由留空。',
          },
          {
            path: ['match', 'sheetRange'],
            from: 'sheetRange',
            label: '读取范围',
            kind: 'text',
            advanced: true,
            hint: '可选，如 A1:M500。留空则从表头行读到 Z 列、读到表尾。数据很多或想限定列时用。',
          },
          {
            path: ['match', 'sheetColumns'],
            from: 'sheetColumns',
            label: '列名覆盖（电子表格）',
            kind: 'columns',
            advanced: true,
            hint: '表头叫法跟插件不一样时用，写成 description=我的列名, status=我的状态列。左边只能是 description / status / seq / module / priority 等固定语义名。',
          },
          {
            path: ['match', 'columns'],
            from: 'columns',
            label: '列名覆盖（多维表格）',
            kind: 'columns',
            advanced: true,
            hint: '多维表格的字段叫法跟插件不一样时用（例如字段叫「缺陷描述」「处理状态」）。写法同上；多维表格本来就会自动认一批常见别名，这一格只用来兜底。',
          },
          {
            path: ['match', 'tableKind'],
            from: 'tableKind',
            label: '强制表型',
            kind: 'select',
            options: ['', 'bitable', 'sheet'],
            advanced: true,
            hint: '自动探测有时会多花一次请求。明确知道是哪种就选死，省掉探测；留空=自动。',
          },
        ],
      },
      {
        key: 'repo',
        label: '仓库',
        fields: [
          { path: ['repo', 'path'], from: 'repoPath', label: '仓库路径', kind: 'text', required: true, pick: 'directory', hint: '本地 git 检出根目录，绝对路径或相对 DSH 工作目录。点「选择目录」可以直接挑，也可以手打。' },
          { path: ['repo', 'baseBranch'], from: 'repoBaseBranch', label: '基准分支', kind: 'branch', hint: '从哪条分支切出工作分支。可从下拉里选，也可以直接手打。' },
          { path: ['repo', 'targetBranch'], from: 'repoTargetBranch', label: '目标分支', kind: 'branch', hint: 'MR 的目标分支。可从下拉里选，也可以直接手打。' },
          { path: ['repo', 'remote'], from: 'repoRemote', label: 'GitLab 仓库地址', kind: 'text', advanced: true, hint: '只有要开 draft MR 时才需要。填仓库地址（https://gitlab.x/group/repo.git 或 git@gitlab.x:group/repo.git），不是 git 远端名，别填 origin。' },
        ],
      },
      {
        // GitLab 出口整组是**实验性**能力（工单 #19）：本机 git push 被封死，只能走 Commits API，
        // 而且要自己申请 GITLAB_TOKEN。所以整组收进「高级设置」，缺省视图里一个字都不出现 ——
        // 99% 的人只用本地提交，把 MR 当主角介绍他们是错的。
        //
        // 但一旦打开 `enabled`，**四个字段都要能在面板上填全**：以前只有 enabled 画得出来，
        // 另外三个只能手改 YAML，等于「开得起来但配不出来」。
        key: 'gitlab',
        label: '远程 MR（实验性）',
        advanced: true,
        fields: [
          { path: ['repo', 'gitlab', 'enabled'], from: 'remoteMrEnabled', label: '开 draft MR', kind: 'bool', hint: '关掉只做本地提交，不需要 GITLAB_TOKEN（这也是缺省行为）。打开之后要在「凭据」页填 GITLAB_TOKEN，并填下面三项。' },
          { path: ['repo', 'gitlab', 'baseUrl'], from: 'gitlabBaseUrl', label: 'GitLab 站点', kind: 'text', hint: '站点根地址，如 https://gitlab.example.com。自建站点或子组路径必须填；不填时从上面的「GitLab 仓库地址」推。' },
          { path: ['repo', 'gitlab', 'remote'], from: 'gitlabRemote', label: 'GitLab remote', kind: 'text', hint: '仓库 remote 的 URL，用于推导 projectId。不填时同样从「GitLab 仓库地址」推。' },
          { path: ['repo', 'gitlab', 'projectId'], from: 'gitlabProjectId', label: 'GitLab projectId', kind: 'text', hint: '数字 id 或 group/project 路径，如 1234 或 platform/pms。这一项填不上，开 MR 会报「项目没有配置 GitLab」。' },
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
      if (field.kind === 'columns') {
        // 宿主已经摊平成 `a=b, c=d` 了；但万一拿到的是对象（比如换了宿主版本），
        // 这里也认，免得显示成 [object Object]。
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          var pieces = []
          var keys = Object.keys(raw)
          for (var k = 0; k < keys.length; k += 1) {
            var value = raw[keys[k]]
            pieces.push(keys[k] + '=' + (Array.isArray(value) ? value.join('|') : String(value)))
          }
          return pieces.join(', ')
        }
        return raw === undefined || raw === null ? '' : String(raw)
      }
      if (field.kind === 'list') {
        if (Array.isArray(raw)) return raw.join(', ')
        return raw === undefined || raw === null ? '' : String(raw)
      }
      return raw === undefined || raw === null ? '' : String(raw)
    }

    /**
     * `a=b, c=d` 这种一行写法 → `{a:'b', c:'d'}`。
     *
     * 为什么用一行文本而不是在面板里再长一个键值编辑器：`sheetColumns` 通常一个
     * 项目也就改一两项，为它单开一套嵌套编辑器不划算；而宿主下发的已经是摊平
     * 字符串（见 `src/remote/host.js` 的 `describeProject`），面板只做「原样显示、
     * 保存时解析回对象」，两边口径一致。
     *
     * 值里带 `|` 表示多个候选列名（`seq=序号|编号`），解析成数组 —— 与宿主那边
     * 用 `|` 连接数组的写法对称。
     */
    function parseColumnsDraft (text) {
      var out = {}
      var parts = String(text === undefined || text === null ? '' : text).split(',')
      for (var i = 0; i < parts.length; i += 1) {
        var part = parts[i].trim()
        if (part.length === 0) continue
        var eq = part.indexOf('=')
        // 没有等号的条目直接跳过：与其猜，不如不写进去（校验侧也不会因此报错）。
        if (eq <= 0) continue
        var key = part.slice(0, eq).trim()
        var value = part.slice(eq + 1).trim()
        if (key.length === 0 || value.length === 0) continue
        var candidates = value.split('|')
        if (candidates.length > 1) {
          var list = []
          for (var c = 0; c < candidates.length; c += 1) {
            var one = candidates[c].trim()
            if (one.length > 0) list.push(one)
          }
          out[key] = list
        } else {
          out[key] = value
        }
      }
      return out
    }

    /** 草稿值 → 真正要写进去的值（列表拆逗号、布尔转 bool、列名覆盖转对象）。 */
    function projectRawValue (field, draftValue) {
      if (field.kind === 'bool') return Boolean(draftValue)
      if (field.kind === 'columns') return parseColumnsDraft(draftValue)
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

    /**
     * 把「某个下标上的项目草稿」搬到「另一个下标」上。
     *
     * 删除一个还没保存的新增项目时，它后面的卡片全部前移一位 —— 草稿 key 里带着
     * 绝对下标，所以必须跟着重排，否则人会看到第 3 张卡显示第 4 张卡的值。
     *
     * 只搬 `copy[to*]`，不改 `from`；`from` 上不存在的键直接跳过。
     */
    function addProjectDraftKeys (copy, source, from, to) {
      for (var s = 0; s < PROJECT_SECTIONS.length; s += 1) {
        var fields = PROJECT_SECTIONS[s].fields
        for (var f = 0; f < fields.length; f += 1) {
          var oldKey = projectKey(from, fields[f].path)
          if (!hasKey(source, oldKey)) continue
          copy[projectKey(to, fields[f].path)] = source[oldKey]
        }
      }
    }

    /**
     * 新建项目时的空白记录（形状与宿主 `describeProject()` 的扁平字段一致）。
     *
     * 平台给 `mock`：这是唯一不需要任何凭据就能跑通收票/跑票的平台，
     * 新人加项目先看到一条能跑通的链路，比看到 `feishu` 然后被要求填 appToken 友好。
     */
    function blankProjectRecord (index) {
      var out = {}
      for (var s = 0; s < PROJECT_SECTIONS.length; s += 1) {
        var fields = PROJECT_SECTIONS[s].fields
        for (var f = 0; f < fields.length; f += 1) {
          var field = fields[f]
          var isPlatform = field.path.length === 2 && field.path[0] === 'match' && field.path[1] === 'platform'
          out[field.from] = isPlatform ? 'mock' : (field.kind === 'bool' ? false : '')
        }
      }
      out.name = '新项目' + (index + 1)
      // 标记「还没进宿主」：保存时它要发整对象、删除时只丢本地、徽标要写清。
      out.__pending = true
      return out
    }

    /**
     * 草稿 → 一个**完整**的项目配置对象（给新增项目用）。
     *
     * 为什么新增要发整对象、而改已有项目只发单字段：已有项目在宿主那边已经存在，
     * 按深层路径改一个叶子是最小改动；新增项目在宿主那边根本不存在，只能整对象
     * `set` 进去。
     *
     * 空串 / 空数组 / false 一律不写：配置里塞一堆空值会让 `validateProject`
     * 的「可选字段」分支误判（例如 `statusValues: []` 是配置错误，不是「没填」）。
     */
    function buildProjectValue (record, index, draft) {
      var value = {}
      function put (path, raw) {
        var node = value
        for (var i = 0; i < path.length - 1; i += 1) {
          if (!hasKey(node, path[i])) node[path[i]] = {}
          node = node[path[i]]
        }
        node[path[path.length - 1]] = raw
      }
      for (var s = 0; s < PROJECT_SECTIONS.length; s += 1) {
        var fields = PROJECT_SECTIONS[s].fields
        for (var f = 0; f < fields.length; f += 1) {
          var field = fields[f]
          var key = projectKey(index, field.path)
          var raw = hasKey(draft, key) ? draft[key] : projectDraftValue(record, field)
          var normalized = projectRawValue(field, raw)
          if (field.kind === 'bool') {
            if (normalized === true) put(field.path, true)
            continue
          }
          if (field.kind === 'list') {
            if (normalized.length > 0) put(field.path, normalized)
            continue
          }
          var text = String(normalized === undefined || normalized === null ? '' : normalized).trim()
          if (text.length > 0) put(field.path, text)
        }
      }
      // 平台与仓库路径是必填：即使人还没填，也要把键位留出来，
      // 这样宿主报错时指向的是 `projects[n].repo.path` 而不是「缺字段」。
      if (!hasKey(value, 'name')) value.name = ''
      if (!hasKey(value, 'match')) value.match = { platform: 'mock' }
      if (!hasKey(value.repo, 'path')) value.repo.path = ''
      return value
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
    var DEFAULT_OPEN_GROUP = '行为'

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
    var ADV_OPEN_KEY = 'ticket-pipeline:open-advanced'
    function readAdvMap () {
      try {
        var raw = localStorage.getItem(ADV_OPEN_KEY)
        return raw ? JSON.parse(raw) : {}
      } catch (error) { return {} }
    }
    function isAdvOpenOf (map, label) {
      return map && map[label] === true
    }

    // ── 页签 ────────────────────────────────────────────────────
    // 整页有五个互不相干的大块（运行 / 项目 / 参数 / 凭据 / 体检）。上一版把它们
    // 竖着排成一列，一屏 1300 多字、四个卡片首尾相接，谁也说不清该从哪儿看起 ——
    // 这就是「太复杂」。改成页签之后每次只摊开一块，其余收在标题里。
    //
    // 缺省停在「运行」（#16）：人打开设置页时的第一个问题几乎总是「现在跑得怎么样、
    // 有没有卡住 / 要我做点什么」。这个问题以前只能去对话里敲 pipeline_status，
    // 而不知情的人根本不知道有这个工具 —— 于是「插件跑没跑」变成了一个谜。
    // 配置类页签（项目/参数/凭据）与体检都是**一劳永逸**的事，排在后面不碍事。
    var TAB_KEY = 'ticket-pipeline:open-tab'

    var TABS = [
      { key: 'run', label: '运行' },
      { key: 'projects', label: '项目' },
      { key: 'params', label: '参数' },
      { key: 'creds', label: '凭据' },
      { key: 'doctor', label: '体检' },
    ]

    function readTab () {
      try {
        if (typeof localStorage === 'undefined') return 'run'
        var raw = localStorage.getItem(TAB_KEY)
        for (var i = 0; i < TABS.length; i += 1) {
          if (TABS[i].key === raw) return raw
        }
        return 'run'
      } catch (error) {
        return 'run'
      }
    }

    function writeTab (key) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(TAB_KEY, key)
      } catch (error) {
        // 存不下就算了，下次回到缺省页签不影响功能。
      }
    }

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

    /** 数一下问题表里某个等级有几条（保存失败时先说条数）。 */
    function countIssues (byKey, level) {
      var count = 0
      for (var key in byKey) {
        if (!hasKey(byKey, key)) continue
        if (byKey[key] !== undefined && byKey[key] !== null && byKey[key].level === level) count += 1
      }
      return count
    }

    /**
     * 滚到第一个标红的字段。
     *
     * 为什么需要：保存失败时错误集中在下面几十个字段里，而报错条在顶部 ——
     * 人看到「保存失败」之后得自己往下翻才能找到是哪一格红的，中间还会怀疑是不是
     * 网络问题。这里替他把视线送过去。
     */
    function scrollToFirstIssue () {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
      var target = null
      try {
        target = document.querySelector('.tp-invalid') || document.querySelector('.tp-field-err')
      } catch (error) {
        return
      }
      if (target === null || target === undefined) return
      if (typeof target.scrollIntoView === 'function') {
        try {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' })
        } catch (error) {
          // 老浏览器不认 options 对象，退回无参调用；再失败就算了，不影响保存本身。
          try { target.scrollIntoView() } catch (ignored) {}
        }
      }
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
      // webform 已移除：它曾经是「演示平台」，但水位只在内存里、重启就把同一批工单重收一遍。
      // 老配置里的 webform 要给一条能照做的迁移提示，而不是一句「只能是 …」。
      if (platform === 'webform') {
        add(['match', 'platform'], 'error', 'webform 源已移除；请改成 mock（离线演示）或 feishu（真实工单表）')
      } else if (platform.length === 0) {
        add(['match', 'platform'], 'error', '只能是 ' + PLATFORMS.join(' / '))
      } else if (PLATFORMS.indexOf(platform) < 0) {
        add(['match', 'platform'], 'error', '只能是 ' + PLATFORMS.join(' / '))
      }

      var repoPath = read(['repo', 'path']).trim()
      if (repoPath.length === 0) {
        add(['repo', 'path'], 'error', '必须是非空字符串（本地 git 检出根目录）')
      } else if (!looksLikePath(repoPath)) {
        add(['repo', 'path'], 'soft', '看起来不像路径（没有目录分隔符）。确认是相对 DSH 工作目录的路径？')
      }

      if (platform === 'feishu') {
        // 飞书能读两种表，绑定方式三选一（对应 `src/core/config.js:validateProject`）：
        //   ① 多维表格：appToken + tableId（appToken 由「粘贴链接」或手填 key 写入）
        //   ② 电子表格：spreadsheetToken（面板字段「电子表格链接或 token」）
        //   ③ 表名匹配：docNamePattern（按云文档名模糊找）
        // 三条都没有才是错误；有一条就放过，且**明说**走的是哪条 —— 上一版只认
        // 「有 appToken 或有表名匹配」，把电子表格这条完全漏掉，配对了也报红。
        var pattern = read(['match', 'docNamePattern']).trim()
        var hasToken = Boolean(record && record.hasAppToken)
        var tableId = read(['match', 'tableId']).trim()
        var sheetToken = read(['match', 'spreadsheetToken']).trim()
        var sheetName = read(['match', 'sheetName']).trim()
        var sheetId = read(['match', 'sheetId']).trim()
        var hasBitable = hasToken && tableId.length > 0
        var hasSheet = sheetToken.length > 0 && (sheetId.length > 0 || sheetName.length > 0)
        if (!hasBitable && !hasSheet && pattern.length === 0) {
          add(['match', 'docNamePattern'], 'soft',
            '这个飞书项目还没绑定任何工单表。三种方式选一种：'
            + '① 在上面的「工单表链接」里粘贴多维表格链接（推荐，宿主会解析并保存 token）；'
            + '② 填「电子表格链接或 token」+ 工作表名/id；'
            + '③ 在这里填表名匹配（按文件名模糊找）。')
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
        // 打开了却三个定位字段全空 —— 这不是「软提示」，是「跑到最后一步才失败」，
        // 所以要在开 MR 那一格上直接说清楚，别让人白等一整票。
        var repoRemote = read(['repo', 'remote']).trim()
        var glBaseUrl = read(['repo', 'gitlab', 'baseUrl']).trim()
        var glProjectId = read(['repo', 'gitlab', 'projectId']).trim()
        if (repoRemote.length === 0 && (glBaseUrl.length === 0 || glProjectId.length === 0)) {
          add(['repo', 'gitlab', 'projectId'], 'error',
            '打开了「开 draft MR」但既没填上面的「GitLab 仓库地址」，这里的站点 / projectId 也没填全 —— 票会跑到最后一步才失败。要么把这三格填上，要么把「开 draft MR」关掉只做本地提交。')
        }
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

    /**
     * 面板样式。
     *
     * 视觉基线照抄宿主设计系统（`dsh-web-frontend` 的 `--dsw-*` token）：宿主的
     * 宿主的 cordis-plugin-development/practices.md 禁止把 Harness 的客户端包当模块
     * 加载（ui-primitives 那一类），只能自己写控件、把宿主的 markup 与
     * CSS 抄过来、类名换成自己的前缀、只保留 `--dsw-alias-*` token 引用。所以这里
     * 的颜色/圆角/阴影全部走 token，只有 token 覆盖不到的地方才给兜底值。
     *
     * 三条硬要求（用户提的）：
     *   1. **Label 置顶**：字段名在上、输入框在中、说明在下 —— 视线自上而下一次过，
     *      不用在「左边一长串字 / 右边一个框」之间来回横跳。
     *   2. **卡片化**：浅灰大背景 + 纯白圆角卡片 + 轻阴影，分组层级一眼看得出。
     *   3. **克制**：标题 16px/600 深灰（不纯黑）、字段名 14px/500、说明 12px 浅灰。
     */
    var CSS = [
      // 这一段是照着宿主自己的设置页重写的，不是凭空调色。
      //
      // 上一版错在三处，三处叠起来就是「丑」：
      //   1. **面板铺了一层灰底**（bg-module-platform #f9fafb），于是整个插件面板
      //      在宿主的设置页里像一块贴上去的异色区域。宿主设置区自己是透明的，
      //      靠外部容器的留白跟别的内容分开。
      //   2. **三层盒子套娃**：灰面板 → 白卡 → 灰项目卡。每层都在描边、都在圆角，
      //      眼睛找不到边界。宿主只有「内容区 → 卡片」一层。
      //   3. **胶囊分段页签**。宿主设置页里的页签是下划线式的（border-bottom 细线
      //      + 选中项 2px 底条），胶囊只在少数工具条里出现。照它自己的写法，
      //      两边才像同一个产品。
      //
      // 参考：@deepseek-ai/dsh-client-ui-settings-plugins 的 PluginsSettingsSection
      //   .section{max-width:760px;flex-direction:column;gap:12px}
      //   .heading{font-size:18px;font-weight:600}
      //   .intro{font-size:13px;color:label-tertiary}
      //   .tabs{border-bottom:.5px solid border-l2;gap:22px}
      //   .tab{padding:7px 1px 9px;font-size:13px;color:label-tertiary}
      //   .tab[data-active=true]:after{height:2px;background:label-primary;bottom:-1px}
      //   .cards{gap:10px}

      // 面板本身不铺底色、不画边框 —— 宿主设置页就是这么做的。
      '.tp-panel{display:flex;flex-direction:column;gap:16px;box-sizing:border-box;',
      '  max-width:880px;padding:2px 0 24px;font-family:var(--dsw-font-family,inherit)}',

      // 标题区照宿主的 heading/intro 比例：18px 标题 + 13px 说明。
      '.tp-head{display:flex;flex-direction:column;gap:3px}',
      '.tp-head h2{margin:0;font-size:18px;font-weight:600;line-height:26px;',
      '  color:var(--dsw-alias-label-primary,#0f1115)}',
      '.tp-head p{margin:0;font-size:13px;line-height:20px;',
      '  color:var(--dsw-alias-label-tertiary,#81858c)}',

      // 工具条：吸顶，但**只有一条底线**，不做成一张卡片。
      // 做成卡片就得给圆角 + 描边 + 阴影，而它横跨内容区顶端，视觉上等于又加一层框。
      '.tp-toolbar{position:sticky;top:0;z-index:5;display:flex;align-items:flex-end;',
      '  gap:12px;flex-wrap:wrap;padding:2px 0 0;margin:0 0 -1px;',
      '  background:var(--dsw-alias-bg-base,#fff);',
      '  border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',

      // 页签：下划线式，抄宿主 .tab / .tab[data-active]:after。
      // 用 ::after 画底条而不是 border-bottom，这样底条能盖住工具条那根细线。
      '.tp-tabs{display:flex;align-items:flex-end;gap:20px;border:0;background:none;padding:0}',
      '.tp-tab{position:relative;font:inherit;font-size:13px;line-height:20px;',
      '  padding:7px 1px 9px;border:0;background:none;cursor:pointer;',
      '  color:var(--dsw-alias-label-tertiary,#81858c);',
      '  display:inline-flex;align-items:center;gap:5px;white-space:nowrap;',
      '  transition:color .15s ease}',
      '.tp-tab:hover{color:var(--dsw-alias-label-primary,#0f1115)}',
      '.tp-tab[aria-selected=true]{color:var(--dsw-alias-label-primary,#0f1115);font-weight:500}',
      '.tp-tab[aria-selected=true]::after{content:"";position:absolute;left:0;right:0;bottom:-1px;',
      '  height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary,#0f1115)}',
      '.tp-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);',
      '  outline-offset:2px;border-radius:3px}',
      // 页签上的小数字：只在真有事时出现，平时不占位（页签本来就窄）。
      '.tp-tab-badge{min-width:16px;height:16px;padding:0 4px;border-radius:999px;',
      '  font-size:11px;font-weight:600;line-height:16px;text-align:center;',
      '  background:var(--dsw-alias-state-warn-primary,#f59e0b);color:#fff}',
      '.tp-tab-badge.tp-badge-bad{background:var(--dsw-alias-state-error-primary,#ec1313)}',

      // 右侧动作贴底对齐，跟页签的基线齐平。
      '.tp-bar-actions{display:flex;align-items:center;gap:8px;margin-left:auto;',
      '  padding-bottom:6px;flex-wrap:wrap}',

      // 卡片：用宿主自己的 settings-card 两个 token（fill / stroke），圆角走 radius-lg。
      // **不加阴影** —— 白底 + 半像素描边已经是宿主卡片的标准做法，加阴影反而脏。
      '.tp-card{background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2,#fff));',
      '  border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,rgba(0,0,0,.1)));',
      '  border-radius:var(--dsw-radius-lg,16px);padding:16px 18px;box-sizing:border-box}',
      '.tp-card>h3{margin:0;display:flex;align-items:center;gap:8px;justify-content:space-between;',
      '  font-size:15px;font-weight:600;line-height:22px;',
      '  color:var(--dsw-alias-label-primary,#0f1115)}',
      '.tp-card>.tp-note{margin:6px 0 0}',
      '.tp-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:14px}',

      // 分组：标题行就是折叠按钮，整行可点。组与组之间用一条极淡的分隔线，
      // **不再给每组套一个框** —— 框套框正是上一版乱的主因。
      '.tp-group+.tp-group{border-top:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04))}',
      '.tp-group>h4{margin:0}',
      '.tp-toggle{font:inherit;display:flex;align-items:center;gap:6px;width:100%;',
      '  padding:10px 0 6px;cursor:pointer;background:none;border:0;text-align:left;',
      '  font-size:13px;font-weight:600;line-height:20px;',
      '  color:var(--dsw-alias-label-primary,#0f1115)}',
      '.tp-toggle .tp-caret{display:inline-block;width:10px;font-size:10px;opacity:.4}',
      '.tp-toggle[aria-expanded=false]{color:var(--dsw-alias-label-secondary,#61666b)}',
      '.tp-adv{border-top:.5px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.1));margin-top:6px}',
      '.tp-adv .tp-toggle{padding-top:8px;font-weight:400;',
      '  color:var(--dsw-alias-label-tertiary,#81858c)}',

      // 字段：上下结构（Label 置顶）。**不给每个字段画横线** ——
      // 双列网格里每格一条线会把整块画成表格，比不画线还乱。
      '.tp-fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));',
      '  gap:4px 24px;padding:2px 0 8px}',
      '.tp-field{display:flex;flex-direction:column;gap:5px;padding:5px 0;min-width:0}',
      '.tp-field-label{font-size:13px;font-weight:500;line-height:20px;',
      '  color:var(--dsw-alias-label-secondary,#61666b);',
      '  display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.tp-help{margin:0;font-size:12px;line-height:1.5;',
      '  color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.tp-constraint{margin:0;font-size:11px;line-height:1.5;',
      '  color:var(--dsw-alias-label-caption,#adb2b8)}',
      '.tp-field-err{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary,#ec1313)}',
      '.tp-soft{margin:0;font-size:12px;color:var(--dsw-alias-state-warn-primary,#f59e0b)}',
      '.tp-note{margin:0;font-size:12px;line-height:1.6;',
      '  color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.tp-err{margin:0;font-size:12px;line-height:1.6;',
      '  color:var(--dsw-alias-state-error-primary,#ec1313)}',
      '.tp-ok{margin:0;font-size:12px;color:var(--dsw-alias-state-success-primary,#22c55e)}',

      // 输入控件：32px 高、8px 圆角、半像素描边 —— 和宿主表单一致。
      '.tp-input,.tp-select{box-sizing:border-box;font:inherit;font-size:13px;line-height:1.5;',
      '  height:32px;padding:0 10px;width:100%;max-width:420px;',
      '  border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));',
      '  border-radius:var(--dsw-radius-sm,8px);',
      '  background:var(--dsw-alias-bg-layer-1,#fff);',
      '  color:var(--dsw-alias-label-primary,#0f1115);transition:border-color .12s ease}',
      '.tp-input::placeholder{color:var(--dsw-alias-label-caption,#adb2b8)}',
      '.tp-input:hover:not(:disabled),.tp-select:hover:not(:disabled){',
      '  border-color:var(--dsw-alias-border-l4,rgba(0,0,0,.16))}',
      '.tp-input:focus-visible,.tp-select:focus-visible{outline:none;',
      '  border-color:var(--dsw-alias-state-business-primary,#4176e6);',
      '  box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary,#4176e6) 15%, transparent)}',
      '.tp-input:disabled,.tp-select:disabled{color:var(--dsw-alias-label-tertiary,#81858c);',
      '  background:var(--dsw-alias-bg-layer-2,#f9fafb);cursor:default}',
      '.tp-field.tp-invalid .tp-input,.tp-field.tp-invalid .tp-select{',
      '  border-color:var(--dsw-alias-state-error-primary,#ec1313)}',
      'textarea.tp-input{height:auto;min-height:64px;padding:7px 10px;resize:vertical}',

      // Switch：照宿主开关的比例与品牌色。
      '.tp-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:34px;height:18px;',
      '  padding:2px;border:0;border-radius:999px;cursor:pointer;',
      '  background:var(--dsw-alias-border-l3,rgba(0,0,0,.2));',
      '  transition:background .14s ease}',
      '.tp-switch[aria-checked=true]{background:var(--dsw-alias-button-primary-fill,#0f1115)}',
      '.tp-switch:disabled{cursor:default;opacity:.45}',
      '.tp-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);',
      '  outline-offset:2px}',
      '.tp-switch-thumb{display:block;width:14px;height:14px;border-radius:50%;background:#fff;',
      '  box-shadow:0 1px 2px rgba(15,17,21,.2);transition:transform .14s ease}',
      '.tp-switch[aria-checked=true] .tp-switch-thumb{transform:translate(16px)}',
      '.tp-switch-row{display:flex;align-items:center;gap:8px}',
      '.tp-switch-state{font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c)}',

      // 总开关：整页最上面一条，比字段稍微重一点（底色 + 描边），
      // 因为它不是普通配置，是「这个插件要不要干活」的总闸。
      '.tp-master{display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px;',
      '  padding:12px 14px;margin:0 0 14px;border-radius:var(--dsw-radius-sm,8px);',
      '  border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));',
      '  background:var(--dsw-alias-bg-layer-2,#f9fafb)}',
      '.tp-master-main{display:flex;align-items:flex-start;gap:10px;flex:1 1 320px;min-width:0}',
      '.tp-master-text{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.tp-master-title{font-size:13px;font-weight:600;line-height:1.45}',
      '.tp-master-hint{font-size:12px;line-height:1.5;',
      '  color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.tp-master .tp-help,.tp-master .tp-err{flex:1 1 100%;margin:0}',

      // 徽标：比上一版更淡。之前每个徽标都有描边 + 底色，一排看下来像按钮。
      '.tp-badge{font-size:11px;font-weight:500;line-height:16px;padding:0 6px;',
      '  border-radius:var(--dsw-radius-xs,4px);white-space:nowrap;',
      '  border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));',
      '  color:var(--dsw-alias-label-tertiary,#81858c);',
      '  background:var(--dsw-alias-bg-layer-2,#f9fafb)}',
      '.tp-badge.tp-on{color:var(--dsw-alias-state-business-primary,#4176e6);',
      '  border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary,#4176e6) 26%, transparent);',
      '  background:color-mix(in srgb, var(--dsw-alias-state-business-primary,#4176e6) 8%, transparent)}',
      '.tp-badge.tp-ok{color:#12864a;border-color:rgba(34,197,94,.28);background:rgba(34,197,94,.09)}',
      '.tp-badge.tp-bad{color:var(--dsw-alias-state-error-primary,#ec1313);',
      '  border-color:rgba(236,19,19,.26);background:rgba(236,19,19,.07)}',

      // 按钮：30px 高、8px 圆角；主按钮用宿主近黑品牌色，不是蓝。
      '.tp-btn{font:inherit;font-size:13px;height:30px;padding:0 12px;cursor:pointer;',
      '  border-radius:var(--dsw-radius-sm,8px);white-space:nowrap;',
      '  border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));background:transparent;',
      '  color:var(--dsw-alias-label-primary,#0f1115);',
      '  display:inline-flex;align-items:center;gap:5px;transition:background .12s ease}',
      '.tp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}',
      '.tp-btn:disabled{opacity:.4;cursor:default}',
      '.tp-btn.tp-primary{color:#fff;background:var(--dsw-alias-button-primary-fill,#0f1115);',
      '  border-color:transparent;font-weight:500}',
      '.tp-btn.tp-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#43454a)}',
      '.tp-btn.tp-danger{color:var(--dsw-alias-state-error-primary,#ec1313);',
      '  border-color:transparent;background:rgba(236,19,19,.06)}',
      '.tp-btn.tp-danger:hover:not(:disabled){background:rgba(236,19,19,.12)}',
      '.tp-btn.tp-sm{height:24px;padding:0 8px;font-size:12px}',

      // 凭据行：靠分隔线分组，不给每行套框。
      '.tp-cred{display:flex;flex-direction:column;gap:6px;padding:12px 0;',
      '  border-top:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04))}',
      '.tp-cred:first-child{border-top:0;padding-top:4px}',
      '.tp-cred:last-child{padding-bottom:0}',
      '.tp-cred-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.tp-cred-title{font-size:13px;font-weight:500;line-height:20px;',
      '  color:var(--dsw-alias-label-primary,#0f1115)}',

      // 行内代码：极淡底纹，不抢视线。
      'code{font-family:var(--dsw-font-family,ui-monospace,monospace);font-size:11px;',
      '  padding:1px 5px;border-radius:var(--dsw-radius-xs,4px);',
      '  background:var(--dsw-alias-bg-layer-2,#f9fafb);',
      '  border:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));',
      '  color:var(--dsw-alias-label-secondary,#61666b);word-break:break-all}',

      // 项目卡：**去掉它自己那层灰底盒子**。上一版是 灰面板 → 白卡 → 灰项目卡，
      // 三层套娃是「乱」的最大来源。现在它只是白卡里的一段，靠分隔线分开。
      '.tp-proj{border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));',
      '  padding:10px 0 0;margin:10px 0 0}',
      '.tp-proj:first-child{border-top:0;padding-top:0;margin-top:8px}',
      '.tp-proj-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
      '.tp-proj-head .tp-toggle{width:auto;flex:0 1 auto;padding:3px 0;font-size:13px}',
      '.tp-proj-head .tp-toggle strong{font-size:14px;font-weight:600}',
      '.tp-proj-body{margin-top:2px}',
      '.tp-spacer{margin-left:auto}',
      // 卡片内的操作行：靠左是筛选开关，靠右是结构性动作。
      '.tp-list-bar{display:flex;align-items:center;gap:8px;margin-top:12px;',
      '  padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));flex-wrap:wrap}',
      '.tp-field-mark{display:inline-flex;gap:5px;align-items:center}',
      '.tp-count{font-size:12px;color:var(--dsw-alias-state-warn-primary,#f59e0b);white-space:nowrap}',
      '.tp-check{display:inline-flex;align-items:center;gap:5px;font-size:12px;',
      '  color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}',
      '.tp-check input{width:13px;height:13px;margin:0;',
      '  accent-color:var(--dsw-alias-button-primary-fill,#0f1115)}',
      '.tp-branch{display:flex;flex-direction:column;gap:3px}',
      // 路径 + 「选择目录」横排：按钮与输入框同高，窄屏折行但按钮不压缩。
      '.tp-pick{display:flex;gap:6px;align-items:center}',
      '.tp-pick .tp-input{flex:1 1 auto;min-width:0}',
      '.tp-pick-btn{flex:0 0 auto;white-space:nowrap}',
      // 「粘贴工单表链接」：输入框 + 按钮横排，与「选择目录」同一套手感。
      '.tp-link-row{grid-column:1/-1}',
      '.tp-link-input{display:flex;gap:6px;align-items:center}',
      '.tp-link-input .tp-input{flex:1 1 auto;min-width:0}',
      '.tp-link-input .tp-btn{flex:0 0 auto;white-space:nowrap}',
      // 实验性平台的醒目提示（工单 #20）：背景色 + 左边框，和普通说明文字区分开 ——
      // 这条提示的后果是「配完了什么都没发生」，混在灰字里没人会读。
      '.tp-wps-notice{margin:0 0 10px;padding:8px 10px;border-left:3px solid #d98600;',
      '  background:var(--dsw-alias-bg-layer-2,#f9fafb);border-radius:0 6px 6px 0;line-height:1.6}',
      '.tp-wps-notice code{font-size:11px;padding:1px 4px;border-radius:3px;',
      '  background:var(--dsw-alias-bg-layer-3,#eef0f3)}',

      // 「运行」页（#16）：状态行 + 票列表。刻意不用表格 —— 票是「一件件事」，
      // 一行一张、可展开，比表格更像清单。
      '.tp-run-line{font-size:13px;line-height:1.6;margin:0 0 6px;display:flex;',
      '  align-items:center;gap:8px;flex-wrap:wrap}',
      '.tp-run-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:#9ca3af}',
      '.tp-run-dot.tp-on{background:#22c55e}',
      '.tp-run-dot.tp-off{background:#9ca3af}',
      '.tp-run-tiers{font-size:12px;color:var(--dsw-alias-label-secondary,#61666b);',
      '  margin:0 0 6px;line-height:1.6}',
      '.tp-run-row{border-top:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));padding:8px 0}',
      '.tp-run-row:first-child{border-top:0}',
      '.tp-run-row-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.tp-run-toggle{display:flex;align-items:baseline;gap:8px;flex:1 1 auto;min-width:0;',
      '  font:inherit;font-size:13px;text-align:left;cursor:pointer;border:0;background:none;',
      '  padding:0;color:inherit}',
      '.tp-run-toggle:hover .tp-run-id{text-decoration:underline}',
      '.tp-run-id{font-family:var(--dsw-font-family,ui-monospace,monospace);font-size:12px;',
      '  color:var(--dsw-alias-label-secondary,#61666b);flex:0 0 auto}',
      '.tp-run-phase{font-size:12px;flex:0 0 auto;color:var(--dsw-alias-label-secondary,#61666b)}',
      '.tp-run-title{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      '  color:var(--dsw-alias-label-primary,#0f1115)}',
      '.tp-run-detail{margin:6px 0 0 16px;font-size:12px;line-height:1.7;',
      '  color:var(--dsw-alias-label-secondary,#61666b)}',
      '.tp-run-detail div{white-space:pre-wrap;word-break:break-word}',

      '.tp-empty{padding:16px 0;font-size:13px;line-height:1.6;',
      '  color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.tp-empty p{margin:0 0 4px}',
      '.tp-pre{max-height:220px;overflow:auto;font-size:11px;line-height:1.6;',
      '  padding:10px 12px;margin:10px 0 0;white-space:pre-wrap;word-break:break-word;',
      '  background:var(--dsw-alias-bg-layer-2,#f9fafb);',
      '  border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));',
      '  border-radius:var(--dsw-radius-sm,8px)}',

      // 窄屏：网格塌单列，页签允许横向滚。
      '@media(max-width:560px){',
      '  .tp-fields{grid-template-columns:1fr}',
      '  .tp-input,.tp-select{max-width:none}',
      '  .tp-tabs{overflow-x:auto}',
      '  .tp-bar-actions{margin-left:0;width:100%;padding-bottom:8px}',
      '  .tp-card{padding:12px}',
      '}',
    ].join('')


    // ── 组件 
    // ── 组件 ────────────────────────────────────────────────────

    /**
     * Switch 开关。
     *
     * 宿主的 cordis-plugin-development/practices.md 明确禁止把 Harness 客户端包当
     * 模块加载（ui-primitives 之类）；要求是
     * **自己写控件、把宿主的 markup / CSS / 行为抄过来、类名换成自己的前缀**，
     * 并且保留用户依赖的行为契约 —— 比如 `role="switch"` + `aria-checked`。
     * 这里就是照那条要求写的：按钮语义 + ARIA 开关 + 宿主 `_switch` 的尺寸与动效。
     */
    function Switch (props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'tp-switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        title: props.title,
        disabled: props.disabled,
        onClick: function () { props.onChange(!props.checked) },
      }, h('span', { className: 'tp-switch-thumb' }))
    }

    /**
     * 单个配置字段。
     *
     * **Label 置顶的上下结构**（不是左 label 右输入框）：第一行加粗字段名，第二行
     * 输入框，第三行浅灰说明（约束 + 错误）。理由是眼睛从上往下一次过，不用在
     * 「左边一长串字」和「右边一个框」之间来回横跳；字段一多、说明一长时左右结构
     * 会把输入框推到很远的位置，改一个数要点很远。
     *
     * 布尔字段用 Switch 而不是原生 checkbox：checkbox 只有「有/无」，Switch 还带
     * 得动「这是个开关」的语义，和宿主设置页一致。
     */
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
        control = h('div', { className: 'tp-switch-row' },
          h(Switch, {
            checked: Boolean(draftValue),
            disabled: disabled,
            label: label,
            onChange: props.onChange,
          }),
          h('span', { className: 'tp-switch-state' }, Boolean(draftValue) ? '已开启' : '已关闭'))
      } else if (Array.isArray(meta.enum) && meta.enum.length > 0) {
        // option 文本走 ENUM_LABELS 给中文，但 **value 仍是原值** ——
        // 写下去、跑校验、进适配器都用左边那个英文枚举，别在这一层做翻译。
        var enumLabels = ENUM_LABELS[keyOf(leaf)] || {}
        var options = meta.enum.map(function (value) {
          var text = typeof enumLabels[value] === 'string' ? enumLabels[value] : value
          return h('option', { key: value, value: value }, text)
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
          placeholder: secret ? (props.secretSet ? '已配置，留空即不修改' : '粘贴到这里') : undefined,
          autoComplete: secret ? 'new-password' : 'off',
          onChange: function (event) { props.onChange(event.target.value) },
        })
      }

      // 「已改 / 撤销」只标真正改过的字段，撤销只回退这一个。
      var changed = Boolean(props.changed)
      var mark = changed
        ? h('span', { className: 'tp-field-mark' },
          h('span', { className: 'tp-badge tp-on' }, '已改'),
          h('button', {
            type: 'button',
            className: 'tp-btn tp-sm',
            disabled: disabled,
            onClick: props.onRevert,
          }, '撤销'))
        : null

      var notes = []
      if (help.length > 0) notes.push(h('p', { key: 'help', className: 'tp-help' }, help))
      if (constraint.length > 0) notes.push(h('p', { key: 'constraint', className: 'tp-constraint' }, constraint))
      if (changed) {
        notes.push(h('p', { key: 'base', className: 'tp-constraint' },
          '来自 profile 的当前值：' + describeBase(props.base)))
      }
      if (issue !== undefined && issue !== null) {
        notes.push(h('p', {
          key: 'issue',
          className: issue.level === 'error' ? 'tp-field-err' : 'tp-soft',
        }, issue.text))
      }

      return h('div', { className: 'tp-field' + (invalid ? ' tp-invalid' : '') },
        h('div', { className: 'tp-field-label' }, label, mark),
        control,
        notes.length > 0 ? notes : null)
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

    /**
     * 一行凭据。
     *
     * **不再有每行的小「保存」按钮**：之前每行一个「保存」，页面上同时出现五六个
     * 「保存」+ 顶部一个主「保存」，谁也说不清到底点哪个会把什么写下去。现在只有
     * 顶部一个主「保存」，输入框里填的值会攒着、随「保存」一起提交（见
     * `onSave` 里的凭据提交段）。
     *
     * 「已配置」状态用绿色 Tag 而不是一个写着「已配置（留空表示不改）」的死文本框；
     * 输入框留空时 placeholder 提示「已配置，留空即不修改」—— 那句提示只在该出现
     * 的地方出现，而不是当成值显示出来。
     *
     * 「清除」是**删掉宿主里的凭据**，属于破坏性动作，和「保存」不是一回事，所以
     * 单独留一个按钮，并且要二次确认。
     */
    function CredentialRow (props) {
      var item = props.item
      var state = props.state || {}
      // 字段名跟宿主 `remote.credentials.describe()` 对齐：`configured`（配没配）、
      // `writable`（这条能不能写，宿主可以锁住某条）。以前叫什么也不能凭印象写。
      var configured = Boolean(state.configured)
      var writable = state.writable !== false
      var busy = props.busy === item.ref
      var value = props.value === undefined || props.value === null ? '' : String(props.value)

      return h('div', { className: 'tp-cred' },
        h('div', { className: 'tp-cred-head' },
          h('span', { className: 'tp-cred-title' }, item.label),
          h('span', { className: 'tp-badge ' + (configured ? 'tp-ok' : '') },
            configured ? '✓ 已配置' : '未配置'),
          h('span', { className: 'tp-spacer' }),
          configured
            ? h('button', {
              type: 'button',
              className: 'tp-btn tp-sm tp-danger',
              disabled: props.disabled || !writable || busy,
              title: '把宿主凭据库里这一条删掉（不可撤销）',
              onClick: function () {
                if (typeof window !== 'undefined' && window.confirm) {
                  if (!window.confirm('确定要清除「' + item.label + '」？清掉后要重新粘贴才能用。')) return
                }
                props.onClear(item.ref)
              },
            }, busy ? '处理中…' : '清除')
            : null),
        h('p', { className: 'tp-help' }, item.hint, h('code', null, item.ref)),
        h('input', {
          className: 'tp-input',
          type: 'password',
          value: value,
          disabled: props.disabled || !writable || busy,
          placeholder: configured ? '已配置，留空即不修改' : '粘贴到这里',
          autoComplete: 'new-password',
          onChange: function (event) { props.onEdit(item.ref, event.target.value) },
        }))
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
            '检查 git 链路、项目仓库与远端、凭据、飞书连通性（能不能读到表和数据）、通知通道、执行器，'
            + '以及正在跑的插件是不是比本地源码旧。只读，不改任何东西、不写表格。')
          : h('p', { className: 'tp-err' },
            '宿主 Remote 没挂上（typert 服务缺席）。命令行里仍然可以跑 pipeline_doctor 工具。'),
        report
          ? h(Fragment, null,
            // 三档分开说。把「跑不了」和「跑得不好」混成一句，人会去修不重要的那条。
            report.ok
              ? h('p', { className: 'tp-note', style: { marginTop: '8px' } },
                '✅ 通过' + (report.warnings.length > 0 ? '（有 ' + report.warnings.length + ' 条提醒）' : ''))
              : h('p', { className: 'tp-err' },
                (report.blockers && report.blockers.length > 0
                  ? '❌ ' + report.blockers.length + ' 个阻断（不修就跑不了票）'
                  : '')
                + (report.blockers && report.blockers.length > 0 && report.problems.length > 0 ? '，' : '')
                + (report.problems.length > 0 ? report.problems.length + ' 个必须修复' : '')),
            h('pre', { className: 'tp-pre' }, report.text))
          : null,
        props.error ? h('p', { className: 'tp-err' }, props.error) : null)
    }

    // 正在跑的那几个站点。用来判断「现在能不能取消」——
    // pending 不算：它只是排着队，取消它等于把票拨走，那是另一件事。
    var ACTIVE_PHASES = ['worktree-ready', 'planning', 'editing', 'testing', 'mr-opening']

    /**
     * 「运行」页签（工单 #16）。
     *
     * 为什么要把这个页签放在第一位：人打开设置面板时的第一个问题几乎总是
     * 「现在跑得怎么样、有没有卡住、要我做点什么」。以前这个答案只能靠
     * 去对话里敲 pipeline_status —— 而不知道有这个工具的人，永远看不到。
     * 于是「插件到底跑没跑」变成了一个谜，失败票也躺在那里没人知道要重开。
     *
     * 这一块**不重复算任何东西**：票列表、档位汇总、能不能重跑，全部来自
     * 宿主 `ticketPipeline.status()`（它内部调的是 pipeline_status 同一个
     * collectStatus）。面板只做渲染与三个动作（跑一轮 / 取消 / 重跑）。
     */
    function RunCard (props) {
      var data = props.data
      var tiers = data && Array.isArray(data.tiers) ? data.tiers : []
      var tickets = data && Array.isArray(data.tickets) ? data.tickets : []
      var enabled = data ? data.enabled === true : false
      var needYou = 0
      for (var i = 0; i < tiers.length; i += 1) {
        if (tiers[i].label === '需要你处理') needYou = tiers[i].count
      }
      var running = false
      for (var j = 0; j < tickets.length; j += 1) {
        if (ACTIVE_PHASES.indexOf(tickets[j].phase) >= 0) running = true
      }
      var tierText = tiers.map(function (t) { return t.label + ' ' + t.count }).join(' · ')
      var queue = data && data.queue ? data.queue : null
      var busyScan = props.busy && props.action === 'scan'
      var busyCancel = props.busy && props.action === 'cancel'

      var statusLine = data
        ? h('p', { className: 'tp-run-line' },
          h('span', { className: 'tp-run-dot ' + (enabled ? 'tp-on' : 'tp-off') }),
          enabled ? '流水线：已开启' : '流水线：关着（enabled=false），不会自动扫表')
        : null

      var rows = tickets.map(function (t) {
        var open = props.openOf(t.recordId)
        var rerunBusy = props.busy && props.action === t.recordId
        var detail = []
        if (t.lastError) detail.push('最近错误：' + t.lastError)
        if (t.testDetail) detail.push('验证：' + t.testDetail)
        if (t.commitSha) detail.push('提交：' + String(t.commitSha).slice(0, 8))
        if (t.commitSummary) detail.push('改动：' + t.commitSummary)
        if (t.mrUrl) detail.push('MR：' + t.mrUrl)
        if (t.writeBack && t.writeBack.written === false) {
          detail.push('回填表格：没写成 —— ' + (t.writeBack.note || '原因未记录'))
        }
        if (Array.isArray(t.deliveryIssues)) {
          for (var d = 0; d < t.deliveryIssues.length; d += 1) {
            var issue = t.deliveryIssues[d]
            detail.push('交付·' + issue.label + '：没做成 —— ' + (issue.error || '原因未记录'))
          }
        }
        if (t.stationElapsedMs && t.station) {
          detail.push('这一站已经待了 ' + Math.round(t.stationElapsedMs / 60000) + ' 分钟')
        }
        if (t.worktreePath) detail.push('改代码目录：' + t.worktreePath)
        if (t.sessionId) detail.push('处理会话：' + t.sessionId)
        if (detail.length === 0) detail.push('（这一票没有更多细节）')

        return h('div', { key: t.projectId + '/' + t.recordId, className: 'tp-run-row' },
          h('div', { className: 'tp-run-row-head' },
            h('button', {
              type: 'button',
              className: 'tp-run-toggle',
              title: open ? '收起详情' : '展开详情',
              onClick: function () { props.onToggle(t.recordId) },
            },
            h('span', { className: 'tp-run-id' }, t.recordId),
            h('span', { className: 'tp-run-phase' }, t.phaseLabel || t.phase),
            h('span', { className: 'tp-run-title' }, t.problemSummary || '（没有标题）')),
            // 「重跑」是本页签最大的价值：失败票以前只能回对话里敲 pipeline_reset，
            // 或者去表格里把「是否处理」拨走再拨回来（那样会连内容重做）。
            // canReset 由宿主按 RESETTABLE_PHASES 算好，面板不自己判断。
            t.canReset
              ? h('button', {
                type: 'button',
                className: 'tp-btn tp-sm',
                disabled: props.busy,
                title: t.cancelledByUser ? '这是你手动取消的，重跑会重新排进队列' : '把这张票放回队列，下一轮重新跑',
                onClick: function () { props.onRerun(t.recordId) },
              }, rerunBusy ? '重开中…' : '重跑')
              : null),
          open ? h('div', { className: 'tp-run-detail' }, detail.map(function (line, index) {
            return h('div', { key: index }, line)
          })) : null)
      })

      var emptyText = null
      if (data && !enabled) {
        emptyText = '总开关是关的，插件不会扫表、不会建工作区、不会提交。去「参数」页签把它打开。'
      } else if (data && tickets.length === 0) {
        emptyText = '当前没有未收尾的票。确认总开关已开、项目已配好，然后点「跑一轮」看看。'
      }

      return h('section', { className: 'tp-card' },
        h('h3', null,
          '运行',
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' } },
            props.polling ? h('span', { className: 'tp-note' }, '盯着…') : null,
            props.message.length > 0 ? h('span', { className: 'tp-ok' }, props.message) : null,
            h('button', {
              type: 'button',
              className: 'tp-btn tp-sm',
              disabled: props.busy || !props.available,
              title: '重新读一遍状态，不会触发扫表',
              onClick: props.onRefresh,
            }, '刷新状态'),
            h('button', {
              type: 'button',
              className: 'tp-btn tp-sm tp-danger',
              disabled: props.busy || !props.available || (data !== null && !running && !props.polling),
              title: running || props.polling ? '打断正在跑的那张票' : '当前没有票在跑',
              onClick: props.onCancel,
            }, busyCancel ? '取消中…' : '取消当前'),
            h('button', {
              type: 'button',
              className: 'tp-btn tp-primary',
              disabled: props.busy || !props.available,
              title: '立刻扫一轮表，最多跑一张票。这一轮不会等它跑完。',
              onClick: props.onScan,
            }, busyScan ? '触发中…' : '跑一轮'))),
        props.available
          ? h('p', { className: 'tp-note' },
            '这里看的是宿主里真实的队列状态，和 pipeline_status 工具同一份口径。'
            + '「跑一轮」不会等这一轮跑完（一张票可能几十分钟），想看进度就留着这一页。')
          : h('p', { className: 'tp-err' },
            '宿主 Remote 没挂上（typert 服务缺席）。命令行里仍然可以跑 pipeline_status 工具。'),
        statusLine,
        data && tierText.length > 0 ? h('p', { className: 'tp-run-tiers' }, '汇总：' + tierText) : null,
        data && queue && queue.nextRecordId
          ? h('p', { className: 'tp-run-tiers' },
            '下一个：' + queue.nextRecordId
            + (queue.backoff && queue.backoff.length > 0
              ? '（另有 ' + queue.backoff.length + ' 张在退避，暂时拣不出来）'
              : ''))
          : null,
        props.notice.length > 0 ? h('p', { className: 'tp-note' }, props.notice) : null,
        emptyText ? h('p', { className: 'tp-note' }, emptyText) : null,
        rows.length > 0 ? h('div', { style: { marginTop: '8px' } }, rows) : null,
        props.error ? h('p', { className: 'tp-err' }, props.error) : null)
    }

    /**
     * 页面顶部的总开关。
     *
     * 它管的是「这个插件要不要干活」—— 关着的时候不扫表、不建工作区、不提交，
     * 所以它不属于任何一组配置，而是整页的前提。放最上面并且单独画，是因为
     * 它原来埋在折叠组最底下，新人装完打开面板根本找不到「怎么开始」。
     */
    function renderMasterSwitch (leaf, props) {
      var meta = leaf.node.meta || {}
      var key = keyOf(leaf)
      var on = Boolean(props.draft[key])
      var changed = !sameDraft(props.draft[key], props.initialDraft[key])
      var issue = props.issues ? props.issues[key] : undefined
      return h('div', { className: 'tp-master' },
        h('div', { className: 'tp-master-main' },
          h(Switch, {
            checked: on,
            disabled: props.disabled,
            label: '总开关',
            onChange: function (next) { props.onEdit(key, next) },
          }),
          h('div', { className: 'tp-master-text' },
            h('span', { className: 'tp-master-title' },
              h('span', { className: 'tp-master-label' }, '总开关'),
              h('span', null, on ? '已开启：会按下面的间隔自动扫表跑票' : '已关闭：不会扫表、不会建工作区、不会提交'),
              changed ? h('span', { className: 'tp-badge tp-on', style: { marginLeft: '8px' } }, '已改') : null),
            h('span', { className: 'tp-master-hint' },
              on
                ? '想让它停下来就关掉这里；正在跑的那张票不会被打断，用「运行」里的取消才停得住。'
                : '配好项目与凭据之后再打开。用 mock 执行器 + mock 通知可以先空跑一遍看看流程。'))),
        changed
          ? h('button', {
            type: 'button',
            className: 'tp-btn tp-sm',
            disabled: props.disabled,
            onClick: function () { props.onRevert(key) },
          }, '撤销')
          : null,
        typeof meta.description === 'string' && meta.description.length > 0
          ? h('p', { className: 'tp-help' }, meta.description)
          : null,
        issue !== undefined && issue !== null
          ? h('p', { className: issue.level === 'error' ? 'tp-err' : 'tp-note' }, issue.message)
          : null)
    }

    /**
     * 「配置」卡片：把配置项按 meta.group 分组、每组可折叠。
     *
     * 三层信息层级（这就是「化繁为简」的全部做法，没有隐藏任何东西）：
     *   0. **总开关**单独置顶，不属于任何组。
     *   1. **组级折叠** —— 缺省只摊开「行为」一组，其余收起（见 `isGroupOpen`）。
     *   2. **组内「高级设置」折叠区** —— 不常动的旋钮再收一层，缺省不画。
     * 改过的或有错的字段无论在哪一层收起，都会自己露出来。
     *
     * 通知组还按 `pushAdapter` 的当前值条件显隐（见 `notifyVisibility`）：选了 QQ 邮箱
     * 就没必要看 PushPlus 的字段，反过来也一样。
     *
     * 卡片里**不再有第二套「保存 / 放弃改动」按钮**：之前顶部操作条一套、卡片里
     * 又一套，两套按钮长得几乎一样，点哪个会把什么写下去说不清。现在只有顶部那
     * 一套，卡片里只留状态提示。
     */
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

      // 总开关先摘出来：它不属于任何一组，画在卡片最上面。
      var masterLeaf = null
      var rest = []
      for (var m = 0; m < leaves.length; m += 1) {
        if (keyOf(leaves[m]) === MASTER_KEY) masterLeaf = leaves[m]
        else rest.push(leaves[m])
      }

      // 通知组按 pushAdapter 的**当前草稿值**显隐 —— 用草稿而不是保存值，
      // 这样换适配器不用先保存就能看见对应字段（不然还得猜「填完保存才出现」）。
      //
      // schema 里根本没有 pushAdapter 这个键时（宿主版本旧、或字段一时没下发），
      // **不做任何隐藏** —— 藏错方向会让用户以为字段丢了，比多看一眼糟糕得多。
      var hasAdapterLeaf = false
      for (var a = 0; a < rest.length; a += 1) {
        if (keyOf(rest[a]) === 'pushAdapter') { hasAdapterLeaf = true; break }
      }
      var adapter = typeof draft.pushAdapter === 'string' ? draft.pushAdapter : 'mock'
      var notifyRule = hasAdapterLeaf ? notifyVisibility(adapter) : null

      var groups = groupLeaves(rest)
      var sections = groups.map(function (group) {
        // 必须用 map 而不是 for + var：`var key` 是函数作用域，放进 for 里所有
        // 闭包（onRevert / onChange）会一起指向最后一项 —— 改第 1 个字段会写到
        // 第 N 个字段上。map 每次调用都是一个新的作用域，天然没这个问题。
        var changedCount = 0
        var isNotify = notifyRule !== null && group.label === NOTIFY_GROUP_LABEL
        var hiddenByAdapter = []
        var all = []
        for (var g = 0; g < group.leaves.length; g += 1) {
          var leafKey = keyOf(group.leaves[g])
          // 条件隐藏的键：**改过的或有错的永远露出来**（同高级折叠那条硬约束），
          // 否则换回适配器之前的旧值会变成看不见的暗配置。
          if (isNotify && notifyRule.keep.indexOf(leafKey) < 0) {
            var dirtyHidden = !sameDraft(draft[leafKey], props.initialDraft[leafKey])
            var badHidden = props.issues && props.issues[leafKey] !== undefined
            if (!dirtyHidden && !badHidden) { hiddenByAdapter.push(leafKey); continue }
          }
          var changed = !sameDraft(draft[leafKey], props.initialDraft[leafKey])
          if (changed) changedCount += 1
          all.push({ key: leafKey, changed: changed, leaf: group.leaves[g] })
        }
        var nodes = all.map(function (entry) {
          return {
            key: entry.key,
            changed: entry.changed,
            node: h(Field, {
              key: entry.key,
              leaf: entry.leaf,
              value: draft[entry.key],
              base: props.initialDraft[entry.key],
              disabled: disabled,
              secretSet: Boolean(props.secrets && props.secrets[entry.key]),
              issue: props.issues ? props.issues[entry.key] : undefined,
              changed: entry.changed,
              onRevert: function () { props.onRevert(entry.key) },
              onChange: function (next) { props.onEdit(entry.key, next) },
            }),
          }
        })
        var core = []
        var advanced = []
        for (var i = 0; i < nodes.length; i += 1) {
          // 改过的和有错的永远露出来，不跟着「高级」一起藏 —— 否则折叠就成了遮蔽。
          if (isAdvancedConfigKey(nodes[i].key) && !nodes[i].changed && !(props.issues && props.issues[nodes[i].key])) {
            advanced.push(nodes[i].node)
          } else {
            core.push(nodes[i].node)
          }
        }

        var children = []
        if (isNotify && notifyRule.note.length > 0) {
          children.push(h('p', { key: 'adapter-note', className: 'tp-constraint' }, notifyRule.note))
        }
        children.push(h('div', { key: 'core', className: 'tp-fields' }, core))
        if (advanced.length > 0) {
          var advOpen = props.isAdvOpen(group.label)
          children.push(h('div', { key: 'adv', className: 'tp-adv' },
            h('button', {
              type: 'button',
              // 类名刻意**不是** tp-group-toggle：自测按 tp-group-toggle 数「配置
              // 分组」的折叠标题，多一种折叠混进去就数不清了。
              className: 'tp-toggle tp-adv-toggle',
              'aria-expanded': advOpen ? 'true' : 'false',
              onClick: function () { props.onToggleAdv(group.label) },
            },
              h('span', { className: 'tp-caret' }, advOpen ? '▾' : '▸'),
              '高级设置',
              h('span', { className: 'tp-badge' }, advanced.length + ' 项')),
            advOpen ? h('div', { className: 'tp-fields' }, advanced) : null))
        }

        return h(GroupSection, {
          key: group.label,
          group: group,
          open: props.isOpen(group.label),
          changedCount: changedCount,
          onToggle: function () { props.onToggle(group.label) },
        }, children)
      })

      return h('section', { className: 'tp-card' },
        h('h3', null, '配置',
          h('span', { style: { marginLeft: 'auto' } },
            props.dirty
              ? h('span', { className: 'tp-ok' },
                '有 ' + (typeof props.changedCount === 'number' ? props.changedCount : 0) + ' 项改动未保存')
              : null)),
        masterLeaf ? renderMasterSwitch(masterLeaf, props) : null,
        h('p', { className: 'tp-note' },
          '点组名折叠整组；组里的「高级设置」再收一层不常动的旋钮。',
          '改过的和有错的字段无论收起与否都会露出来。'),
        h('div', null, sections),
        props.errorCount > 0
          ? h('p', { className: 'tp-err' }, props.errorCount + ' 项待修 —— 修好才能保存')
          : null,
        props.error ? h('p', { className: 'tp-err' }, props.error) : null)
    }

    /**
     * 「粘贴工单表链接」那一行（只在飞书项目上出现）。
     *
     * 为什么不是一个 appToken 输入框：appToken 能换出 access token，宿主从来不下发
     * 它的明文（只给 `hasAppToken` + 首尾几位），所以面板里「填一个明文 token」
     * 根本没有地方存 —— 上一版就是只读一行字，结果新增飞书项目只能手改 YAML。
     *
     * 现在改成让人粘**地址栏那条链接**：浏览器把整串交给宿主，
     * 宿主 `parseFeishuLink()` 解析出 appToken（或 spreadsheetToken）再落盘。
     * 明文只在宿主进程里出现一次，浏览器内存与请求体里都没有它。
     *
     * 三种绑定方式在这里并列写出来，是因为它们各有各的适用场景，人应该一眼能选：
     *   · 粘链接 —— 推荐，手上有表就有链接
     *   · 表名匹配（下面「工单表」组里的 `docNamePattern`）—— 表名固定、token 会变
     *   · 手填 token —— 别人只给了 token 时
     */
    function FeishuTableLinkRow (props) {
      var [text, setText] = useState('')
      var busy = props.busy === true
      var disabled = props.disabled === true || busy
      var canSubmit = !disabled && text.trim().length > 0

      return h('div', { className: 'tp-field tp-link-row' },
        h('div', { className: 'tp-field-label' }, '工单表链接',
          h('span', { className: 'tp-badge' + (props.hasToken ? ' tp-ok' : '') }, props.tokenText)),
        h('p', { className: 'tp-help' },
          '把浏览器地址栏那条**完整**链接贴进来（多维表格 /base/…?table=…、电子表格 /sheets/…、wiki /wiki/…），'
          + '点「用这条链接」由宿主解析并保存。'
          + '面板永远不会显示完整 token —— 宿主只回「已配置（前 4 位…后 4 位）」。'),
        h('div', { className: 'tp-link-input' },
          h('input', {
            className: 'tp-input',
            type: 'text',
            value: text,
            disabled: disabled,
            placeholder: 'https://xxx.feishu.cn/base/bascn…?table=tbl…',
            autoComplete: 'off',
            onChange: function (event) { setText(event.target.value) },
            onKeyDown: function (event) {
              if (event.key === 'Enter' && canSubmit) props.onPasteLink(props.index, text.trim())
            },
          }),
          h('button', {
            type: 'button',
            className: 'tp-btn tp-sm',
            disabled: !canSubmit,
            title: '交给宿主解析并写进配置（浏览器不接触明文 token）',
            onClick: function () { props.onPasteLink(props.index, text.trim()) },
          }, busy ? '写入中…' : '用这条链接')),
        h('p', { className: 'tp-help' },
          '没有链接也行：填下面的「表名匹配」让插件按文件名找表，或者把 app_token 直接贴进上面这个框（形如 bascn…）。'),
        props.message ? h('p', { className: 'tp-ok' }, props.message) : null,
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
      var pending = props.pending === true
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
        // 新增但还没保存的项目要显眼地说清楚：它现在只活在面板里，
        // 点一次「保存」才会真正写进配置。
        pending ? h('span', { className: 'tp-badge tp-on' }, '未保存（点顶部保存才写进配置）') : null,
        changedCount > 0 ? h('span', { className: 'tp-badge tp-on' }, '已改 ' + changedCount + ' 项') : null,
        errorCount > 0 ? h('span', { className: 'tp-badge tp-bad' }, errorCount + ' 项待修') : null,
        // 说「未显示」而不是「高级」：藏起来的原因不止一种（不给这个平台用的组、
        // 高级字段），把它们混称「高级设置」会让人以为是同一个开关能全放出来。
        hiddenCount > 0 && open ? h('span', { className: 'tp-badge' }, hiddenCount + ' 项未显示') : null,
        h('span', { className: 'tp-spacer' }),
        // 「开 MR」是实验性能力的徽标（工单 #19）：缺省关着，开了才出现，
        // 而且带「实验性」三个字 —— 不让人以为这是产品主推的交付形态。
        record && record.remoteMrEnabled ? h('span', { className: 'tp-badge' }, 'MR（实验性）') : null,
        // 删除已保存的项目是**结构性**动作（会 splice 掉数组里这一项，后面项目的
        // 下标跟着前移），所以有未保存的字段改动时禁用 —— 否则改了一半的字段会跟着
        // 换到别的项目上。删「还没保存的新增」不吃这层限制：它本来就不在宿主里，
        // 删掉只是把这张卡从面板上撤掉，谁的下标都不动。
        h('button', {
          type: 'button',
          className: 'tp-btn tp-sm tp-danger',
          disabled: disabled || (!pending && changedCount > 0),
          title: !pending && changedCount > 0
            ? '这个项目还有未保存的改动；先保存或放弃，再删它。'
            : '从项目清单里删掉这一项（不可撤销）',
          onClick: function () {
            if (typeof window !== 'undefined' && window.confirm) {
              if (!window.confirm('确定要删除项目「' + title + '」？删掉后配置里就没了。')) return
            }
            props.onRemove(index)
          },
        }, pending ? '撤掉' : '删除'))

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
            // 和配置区一致：布尔用 Switch，不用原生 checkbox。
            control = h('div', { className: 'tp-switch-row' },
              h(Switch, {
                checked: Boolean(value),
                disabled: disabled,
                label: field.label,
                onChange: function (next) { props.onEdit(key, next) },
              }),
              h('span', { className: 'tp-switch-state' }, Boolean(value) ? '已开启' : '已关闭'))
          } else if (field.kind === 'select') {
            // 选项默认用原值当文字；`optionLabels` 可以只给某几个值换说法（工单 #20：
            // 金山源是实验性的，光写「wps」没人知道它现在就拿到票）。**value 永远是原值**。
            var optionLabels = field.optionLabels || {}
            var options = field.options.map(function (option) {
              var text = typeof optionLabels[option] === 'string' ? optionLabels[option] : option
              return h('option', { key: option, value: option }, text)
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
          } else if (field.pick === 'directory') {
            // 文本 + 「选择目录」：路径这东西手打最容易错一个字符，然后整条流水线
            // 起不来，而宿主本来就有原生目录选择器（uiWorkspace.pickDirectory）。
            //
            // 选择器拿不到时（没装 uiWorkspace / 老版本宿主）就只画输入框 ——
            // 手打路径这条退路必须一直在，不能因为选择器缺席就填不了。
            var canPick = typeof props.onPickDirectory === 'function'
            control = h('div', { className: 'tp-pick' },
              h('input', {
                className: 'tp-input',
                type: 'text',
                value: String(value === undefined || value === null ? '' : value),
                disabled: disabled,
                autoComplete: 'off',
                onChange: function (event) { props.onEdit(key, event.target.value) },
              }),
              canPick
                ? h('button', {
                  type: 'button',
                  className: 'tp-btn tp-sm tp-pick-btn',
                  disabled: disabled || props.picking === true,
                  title: '打开系统的目录选择器',
                  onClick: function () {
                    props.onPickDirectory(key, String(value === undefined || value === null ? '' : value))
                  },
                }, '选择目录')
                : null)
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

          // Label 置顶的上下结构：字段名一行、输入框一行、说明一行。
          return h('div', {
            key: key,
            className: 'tp-field' + (invalid ? ' tp-invalid' : ''),
            title: profileHint,
          },
            h('div', { className: 'tp-field-label' }, field.label,
              changed
                ? h('span', { className: 'tp-field-mark' },
                  h('span', { className: 'tp-badge tp-on' }, '已改'),
                  h('button', {
                    type: 'button',
                    className: 'tp-btn tp-sm',
                    disabled: disabled,
                    onClick: function () { props.onRevert(key, base) },
                  }, '撤销'))
                : null),
            control,
            field.hint ? h('p', { className: 'tp-help' }, field.hint) : null,
            changed ? h('p', { className: 'tp-constraint' }, '来自 profile 的当前值：' + describeBase(base)) : null,
            issue !== undefined && issue !== null
              ? h('p', { className: issue.level === 'error' ? 'tp-field-err' : 'tp-soft' }, issue.text)
              : null)
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
              // 卡内分组用 tp-sec-toggle 标出来：配置分组是 tp-group-toggle，
              // 两者在改版后不同页签里，但自测要能分别数清。
              className: 'tp-toggle tp-sec-toggle',
              'aria-expanded': sectionOpen ? 'true' : 'false',
              onClick: function () { props.onToggleSection(index, section.key) },
            },
              h('span', { className: 'tp-caret' }, sectionOpen ? '▾' : '▸'),
              section.label,
              sectionChanged > 0 ? h('span', { className: 'tp-badge tp-on' }, '已改 ' + sectionChanged + ' 项') : null)),
          sectionOpen ? h('div', { className: 'tp-fields' }, fields) : null)
      })

      // appToken：宿主只下发 hasAppToken + 打码预览，明文永不出宿主。
      //
      // 所以这里**没有** appToken 输入框。但「没有输入框」不等于「没法配」：
      // 上一版就卡在这儿 —— 新增一个飞书项目只能去手改 cordis.patch.yml，
      // 文档也跟着把「改 appToken」写成必经步骤。
      //
      // 现在给的是另一条路：让人把浏览器地址栏那条链接**整条贴进来**，
      // 由宿主解析出 appToken 并落盘（`ticketPipeline.setProjectTable`）。
      // 明文从头到尾没进过浏览器，落盘的也只有 match.appToken 一个字段。
      // 只在飞书项目上画：这是 feishu 专属的东西，别的平台显示它只会添乱。
      var platformKey = projectKey(index, ['match', 'platform'])
      var platformNow = hasKey(draft, platformKey)
        ? String(draft[platformKey])
        : (record && record.platform ? record.platform : '')
      var tokenText = record && record.hasAppToken
        ? '已配置' + (record.appTokenPreview ? '（' + record.appTokenPreview + '）' : '')
        : '未配置'
      var tokenRow = platformNow === 'feishu'
        ? h(FeishuTableLinkRow, {
          key: 'feishu-link',
          index: index,
          tokenText: tokenText,
          hasToken: !!(record && record.hasAppToken),
          disabled: disabled,
          busy: props.linkBusy === true,
          message: props.linkMessage || '',
          error: props.linkError || '',
          onPasteLink: props.onPasteLink,
        })
        : null

      // 金山源是实验性的（工单 #20）：没有内置取数通道，选了它一张票都拿不到。
      // 这条提示必须出现在**卡片顶上**（不是折在高级里），因为后果是「等了半天什么都不发生」——
      // 不在这里说，人只会以为插件坏了。
      var wpsNotice = platformNow === 'wps'
        ? h('div', { key: 'wps-notice', className: 'tp-note tp-wps-notice' },
          h('strong', null, '实验性：金山文档源当前没有内置取数通道。'),
          ' 直接用它收不到任何工单（`pipeline_scan` 会报「取数通道缺失」）。',
          ' 要真的用，需要自行注入 ',
          h('code', null, 'fetchSheet()'),
          '（见 ',
          h('code', null, 'src/adapters/source-wps/index.js'),
          ' 模块注释）；不打算接的话，把平台改成 feishu 或 mock。')
        : null

      return h('div', { className: 'tp-proj' + (open ? '' : ' tp-collapsed') },
        head,
        open ? h('div', { className: 'tp-proj-body' }, [wpsNotice, ...sections, tokenRow]) : null)
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
      // `list` 的元素是 `{ record, pending }`：pending=true 表示「面板上新增、
      // 还没保存进宿主」。用同一个组件渲染两者，人看不出两套行为。
      var list = props.list
      var draft = props.draft
      var pendingCount = 0
      for (var pi = 0; pi < list.length; pi += 1) {
        if (list[pi].pending === true) pendingCount += 1
      }
      var body
      if (props.busy) {
        body = h('p', { className: 'tp-note' }, '正在读取项目清单…')
      } else if (list.length === 0) {
        body = h('div', { className: 'tp-empty' },
          h('p', null, '还没有配置任何项目。点上面的「+ 添加项目」加一个：先在面板上垫一张空卡片，填完右边这些必填项，再点顶部「保存」。'),
          h('p', null,
            '一个项目 = 一张工单表 + 一个本地 git 检出。最少要填 ',
            h('code', null, 'name'),
            '（项目名，唯一）、',
            h('code', null, 'match.platform'),
            '（工单来源）、',
            h('code', null, 'repo.path'),
            '（本地检出根目录）。',
            '飞书来源还有一条更省事的路：等项目卡片建好之后，把工单表的',
            '浏览器地址栏链接整条贴进卡片里的「工单表链接」，由宿主解析并保存 ——',
            '不需要手改配置文件，面板也不会显示完整 token。'))
      } else {
        body = h('div', null, list.map(function (item, index) {
          // 分支候选按 index 对（宿主的 `branches()` 与 `projects()` 用的是同一次
          // `config.projects` 遍历，index 一定对得上；按 repoPath 对会在两个项目
          // 指向同一个检出时串味）。pending 的项目不在宿主清单里，取不到候选。
          var entry = !item.pending && props.branchList && props.branchList[index] ? props.branchList[index] : null
          return h(ProjectCard, {
            key: 'p' + index,
            index: index,
            record: item.record,
            pending: item.pending === true,
            draft: draft,
            issues: props.issues,
            disabled: props.disabled,
            onEdit: props.onEdit,
            onRevert: props.onRevert,
            branchChoices: entry && Array.isArray(entry.branches) ? entry.branches : [],
            branchNote: entry && entry.ok === false && entry.reason ? entry.reason : '',
            onPickDirectory: props.onPickDirectory,
            picking: props.picking === true,
            onPasteLink: props.onPasteLink,
            linkBusy: props.linkBusy === index,
            linkMessage: props.linkMessage && props.linkMessage.index === index ? props.linkMessage.text : '',
            linkError: props.linkError && props.linkError.index === index ? props.linkError.text : '',
            open: props.isProjectOpen(index),
            showAdvanced: props.showAdvanced,
            onToggle: props.onToggleProject,
            isSectionOpen: props.isSectionOpen,
            onToggleSection: props.onToggleSection,
            onRemove: props.onRemove,
          })
        }))
      }

      // 标题行只放「是什么」和「有几个」；操作放到下面单独一行。
      // 上一版把这 5 个控件（计数 / 显示全部字段 / 添加 / 重新读取）全塞进 h3，
      // 一行挤了半屏宽，右半边还折行 —— 这是「乱」的典型来源。
      return h('section', { className: 'tp-card' },
        h('h3', null, '项目清单',
          list.length > 0 ? h('span', { className: 'tp-badge' }, list.length + ' 个项目') : null,
          pendingCount > 0 ? h('span', { className: 'tp-badge tp-on' }, pendingCount + ' 个未保存') : null),
        h('p', { className: 'tp-note' },
          '每个项目 = 一张工单表 + 一个仓库的绑定。点项目名可以收起它，卡内每个分区',
          '也能单独收起；改哪项就只写哪项（深层路径），不会整块覆盖。'),
        h('div', { className: 'tp-list-bar' },
          // 高级字段开关：缺省视图只画日常要动的那些，想看全的点一下。
          // 这是一次性的「我现在要配细节」，所以不记进 localStorage。
          h('label', { className: 'tp-check', title: '勾上就显示「远程 MR（实验性）」「验证命令」「允许的截图主机」等不常改的字段' },
            h('input', {
              type: 'checkbox',
              checked: props.showAdvanced === true,
              disabled: props.disabled,
              onChange: function (event) { props.onToggleAdvanced(event.target.checked) },
            }),
            '显示全部字段'),
          h('span', { className: 'tp-spacer' }),
          // 「添加项目」是纯本地动作：往面板上垫一张空卡片，点顶部「保存」才真正写进
          // 配置。因此**不再因为 dirty 而禁用** —— 上一版禁用是怕「追加进数组」把下标
          // 搞乱，现在追加根本不碰数组，垫几张都行。
          // 不用 tp-primary：全页只留一颗主按钮（顶部「保存」），新增是次级动作。
          h('button', {
            type: 'button',
            className: 'tp-btn',
            disabled: props.disabled || props.busy,
            title: '在面板上加一个空项目（填完点顶部「保存」才写进配置）',
            onClick: props.onAdd,
          }, '+ 添加项目'),
          h('button', {
            type: 'button',
            className: 'tp-btn',
            disabled: props.disabled || props.busy,
            onClick: props.onReload,
          }, props.busy ? '读取中…' : '重新读取')),
        body,
        // 错误单独一行放在清单下面，不替换 body：上一版一旦出错就把所有卡片
        // 换成一行红字，人连自己刚填的东西都看不见了。
        props.error && props.error.length > 0 ? h('p', { className: 'tp-err' }, props.error) : null,
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
      // 「点添加项目」加出来的、还没进宿主配置的条目。
      //
      // 为什么不在点下去的那一刻就 mutate：宿主对整份配置做校验，一条
      // `repo.path` 是空串就让整笔 mutate 回滚，于是「先加空壳、填完再存」
      // 这条路直接走不通（旧版就是这样，报 `projects[2].repo.path 必须是
      // 非空字符串`）。改成先进本地草稿、随「保存」一起提交：用户的动作
      // 顺序不变，但不会在半成品状态下撞校验。
      var [projPending, setProjPending] = useState([])

      // 分支候选：来自宿主 `ticketPipeline.branches()`（每个项目一份）。
      // 刻意与项目清单分开存 —— 分支取不到是常态（repo.path 还没填、路径不是
      // git 检出），不该让「项目清单」跟着报错。
      var [branchList, setBranchList] = useState([])
      var [branchBusy, setBranchBusy] = useState(false)
      // 「选择目录」正在挑（原生选择器是模态的，挡住按钮防连点）。
      var [picking, setPicking] = useState(false)

      // 「粘贴工单表链接」的进行中状态与回话，都按项目下标存。
      // 为什么按 index 而不是一个全局 busy：卡片是逐个渲染的，全局 busy 会让
      // 「第 2 个项目在写」把第 1 个项目的按钮也灰掉，看起来像卡住了。
      var [linkBusy, setLinkBusy] = useState(-1)
      var [linkMessage, setLinkMessage] = useState(null)
      var [linkError, setLinkError] = useState(null)

      // 折叠状态与「服务端拒绝后挂到字段上的错误」都按 key 存。
      // 当前页签：整页一次只摊开一块，其余收在页签标题里（见 TABS）。
      var [activeTab, setActiveTab] = useState(readTab)
      var [openMap, setOpenMap] = useState(readOpenMap)
      var [serverIssues, setServerIssues] = useState({})

      // 项目卡片的折叠：整张卡的展开/收起、卡内每一组的展开/收起、以及
      // 「显示全部字段」开关。整卡与卡内的开合记在 localStorage（`projMap`），
      // 高级开关**不记** —— 它是「我现在要配细节」的一次性意图，下次进来
      // 还全摊开反而又变回一屏放不下。
      var [projMap, setProjMap] = useState(readProjMap)
      // 「高级设置」折叠：缺省全收起（和分组折叠相反 —— 分组是「常看的摊开」，
      // 高级是「不常看的收起」，所以缺省取值正好相反）。
      var [advMap, setAdvMap] = useState(readAdvMap)
      var [showAdvanced, setShowAdvanced] = useState(false)

      // 「运行」页签（#16）的状态。数据全部来自宿主 ticketPipeline.status()，
      // 面板不自己算任何东西 —— 算两遍就迟早两边打脸。
      var [runData, setRunData] = useState(null)
      var [runError, setRunError] = useState('')
      var [runMessage, setRunMessage] = useState('')
      // 宿主返回的一句人话（「上一轮还没跑完，这次不叠加。」这类）。
      // 与 runMessage 分开：那个是「你做成了什么」，这个是「宿主怎么答的」，
      // 掺在一起会变成一句分不清谁说的话。
      var [runNotice, setRunNotice] = useState('')
      // runAction 记录「现在哪个动作在跑」：'scan' / 'cancel' / 某个 recordId。
      // 分开记而不是一个全局 busy，是为了只灰掉被点的那颗按钮 ——
      // 全局 busy 会让整排按钮同时变灰，看起来像卡死了。
      var [runAction, setRunAction] = useState('')
      var [runOpen, setRunOpen] = useState({})
      // 轮询开关。点「跑一轮」后打开，跑完 / 离开页签 / 10 分钟后关掉。
      var [runPolling, setRunPolling] = useState(false)

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
      // 面板上真正渲染的清单 = 宿主已有的 + 本地还没保存的新增。
      // 两者用一个 `pending` 标记区分：它决定保存时发「单字段深层路径」还是
      // 「整对象」、删除时发 `unset` 还是只丢本地。
      var renderedProjects = useMemo(function () {
        var out = []
        for (var i = 0; i < projList.length; i += 1) out.push({ record: projList[i], pending: false })
        for (var j = 0; j < projPending.length; j += 1) out.push({ record: projPending[j], pending: true })
        return out
      }, [projList, projPending])

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

      var loadRun = useCallback(function () {
        var ns = requireRunNamespace('读状态')
        if (!ns) return Promise.resolve()
        return ns.status().then(function (response) {
          if (!response || !response.ok) {
            setRunError('读状态失败：' + ((response && response.error && response.error.message) || '未知错误'))
            return
          }
          setRunData(response.value)
          setRunError('')
        }, function (error) {
          setRunError('读状态失败：' + (error && error.message ? error.message : String(error)))
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

      // 进「运行」页签时读一次状态（#16）。挂在这里而不是 init 里：
      // 开面板的人多半是来改配置的，不该让设置页一打开就去问队列。
      // 依赖里刻意**不放 loadRun**：它每次渲染都是新函数，放进去等于每渲染一次
      // 就重读一次队列（在真浏览器里是白打接口，在自测里是渲染停不下来）。
      useEffect(function () {
        if (!isPage || !mounted || activeTab !== 'run') return undefined
        loadRun()
        return undefined
      }, [isPage, mounted, activeTab])

      // 点过「跑一轮」之后每 3 秒再读一次，最多 10 分钟（200 次）。
      //
      // 为什么是自递归 setTimeout 而不是 setInterval：宿主侧只有 direct 调用，
      // 一次 status 读多久不知道；用 interval 会在慢的时候叠出并发读。
      // 也刻意**不用 useRef 存 timer id** —— 面板只允许用 useState/useEffect
      // （浏览器 bundle 与自测的假 React 都只有这四个 hook），timer id 放局部
      // 变量，cleanup 时清掉即可。
      useEffect(function () {
        if (!runPolling) return undefined
        var stopped = false
        var timer = null
        var rounds = 0
        // 定时器在 Node 里要 unref：自测（client-smoke）中这个 effect 的 cleanup
        // 永远不会被跑到（假 React 只执行 effect、不执行它的返回值），
        // 不 unref 的话一个 3 秒的轮询就能把测试进程吊死在那儿，看起来像「卡住了」。
        // 浏览器里 setTimeout 返回数字，没有 unref，问号调用自然跳过。
        function schedule () {
          timer = setTimeout(tick, 3000)
          if (timer && typeof timer.unref === 'function') timer.unref()
        }
        function tick () {
          if (stopped) return
          rounds += 1
          if (rounds > 200) {
            setRunPolling(false)
            setRunNotice('盯了 10 分钟还没跑完，先不盯了。想继续看就点「刷新状态」。')
            return
          }
          loadRun().then(function () {
            if (stopped) return
            schedule()
          })
        }
        schedule()
        return function () {
          stopped = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [runPolling])

      var leaves = useMemo(function () {
        var view = findNamespace(snapshot)
        if (!view) return []
        var envelope = view.schema || {}
        return collectLeaves(schemaRoot(envelope), envelope.refs || {}, [], [])
      }, [snapshot])

      var dirty = !sameDraft(draft, initialDraft)

      // 配置项自己的改动数（不含项目字段）。`changedCount` 是两边的总和，
      // 页签徽标要分开显示，所以从总数里减出项目那部分。
      var configChangedCount = useMemo(function () {
        var count = 0
        for (var i = 0; i < leaves.length; i += 1) {
          var key = keyOf(leaves[i])
          if (!sameDraft(draft[key], initialDraft[key])) count += 1
        }
        return count
      }, [leaves, draft, initialDraft])

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
        // 校验要覆盖「还没保存的新增」：否则一张空的待保存卡片不会报错，
        // 保存按钮也就不会拦，人点下去才收到宿主的整笔拒绝 —— 又回到原来的坑。
        return allProjectIssues(renderedProjects.map(function (one) { return one.record }), projDraft)
      }, [renderedProjects, projDraft])

      // 项目里 error 级的条数：只用来给「项目」页签挂个红点，不拦保存
      // （拦保存统一走 `issues.errorCount`）。
      var projectIssueCount = useMemo(function () {
        var keys = Object.keys(localProjectIssues.byKey)
        var count = 0
        for (var i = 0; i < keys.length; i += 1) {
          if (localProjectIssues.byKey[keys[i]].level === 'error') count += 1
        }
        return count
      }, [localProjectIssues])

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
        // 逐个**渲染出来的**项目数改动：包括还没保存的新增项目
        // （它们不在 projList 里，漏掉的话「未保存 N 项」不涨、保存按钮是灰的）。
        // 新增项目整张卡都是新的，按「1 个项目」计数，而不是按 21 个字段计数 ——
        // 否则刚点一下「+ 添加项目」就会显示「未保存 21 项」，看着像出错了。
        for (var p = 0; p < renderedProjects.length; p += 1) {
          if (renderedProjects[p].pending === true) { count += 1; continue }
          for (var s = 0; s < PROJECT_SECTIONS.length; s += 1) {
            var fields = PROJECT_SECTIONS[s].fields
            for (var f = 0; f < fields.length; f += 1) {
              var pkey = projectKey(p, fields[f].path)
              if (!sameDraft(projDraft[pkey], projInitial[pkey])) count += 1
            }
          }
        }
        return count
      }, [leaves, draft, initialDraft, renderedProjects, projDraft, projInitial])

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
        // 「放弃改动」连「还没保存的新增」一起放弃：否则点完像是什么都没发生。
        setProjPending([])
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

      /**
       * 「选择目录」：调宿主原生目录选择器，把结果写回这一格的草稿。
       *
       * 三条设计约束：
       * 1. 只是**改草稿**，不立刻 mutate —— 与「项目字段统一走保存」的语义一致，
       *    人还能反悔（撤销 / 放弃改动都照常有效）。
       * 2. 用户取消（picker 回 null）时什么都不做，不把已填路径清空。
       * 3. 选择器缺席 / 抛错，只往错误区写一句人话，绝不影响其它字段。
       *
       * 选择器本身由 apply() 通过 `props.pickDirectory` 注入 —— 面板组件不碰 ctx，
       * 那边才知道 uiWorkspace 有没有挂上（见 workspaceOf）。
       */
      function onPickDirectory (key, current) {
        if (typeof props.pickDirectory !== 'function') {
          setSaveError('这台机器的宿主没提供目录选择器，只能手打路径。')
          return
        }
        setPicking(true)
        setSaveError('')
        Promise.resolve()
          .then(function () { return props.pickDirectory(current) })
          .then(function (picked) {
            setPicking(false)
            if (picked === null || picked === undefined || String(picked).length === 0) return
            onProjectEdit(key, String(picked))
            // 换了路径，分支候选一定变了 —— 顺手重读一次。读失败无所谓
            //（分支取不到是常态），所以不 await、也不报错。
            try { setTimeout(function () { loadBranches() }, 0) } catch (error) {}
          }, function (error) {
            setPicking(false)
            var message = error && error.message ? error.message : String(error)
            setSaveError('打开目录选择器失败：' + message)
          })
      }

      /**
       * 「粘贴工单表链接」：把整条链接交给宿主解析并落盘。
       *
       * 关键点在**这里不解析链接**。`parseFeishuLink()` 是纯函数、浏览器里也有，
       * 但一旦在这边解析出 appToken，明文就进了浏览器内存（还会进请求体），
       * 这就破了「明文不出宿主」这条线。所以这里只做一件事：把原样的字符串发出去。
       *
       * 宿主 `setProjectTable(index, url)` 的失败会以 rejected promise 的形式回来
       * （网关的 `invokePrepared` 直接 rethrow 业务异常），message 就是我们要显示的那句。
       */
      function onPasteLink (index, url) {
        var ns = getNamespace('ticketPipeline')
        if (!ns || typeof ns.setProjectTable !== 'function') {
          setLinkError({ index: index, text: '宿主 Remote 没挂上「粘贴链接」通道（typert 缺席或插件版本旧）。可以手动填 app_token，或刷新页面重试。' })
          return
        }
        setLinkBusy(index)
        setLinkMessage(null)
        setLinkError(null)
        Promise.resolve()
          .then(function () { return ns.setProjectTable(index, url) })
          .then(function (response) {
            setLinkBusy(-1)
            if (!response || !response.ok) {
              var message = response && response.error && response.error.message
                ? response.error.message
                : '未知错误'
              setLinkError({ index: index, text: '没能写进去：' + message })
              return
            }
            var value = response.value || {}
            setLinkMessage({ index: index, text: value.note || '已保存。' })
            // 写完必须重读项目：`hasAppToken` / `appTokenPreview` 都变了，
            // 不重读就会一直显示「未配置」—— 人以为没成功，会再点一次。
            loadProjects()
          }, function (error) {
            setLinkBusy(-1)
            var message = error && error.message ? error.message : String(error)
            setLinkError({ index: index, text: '没能写进去：' + message })
          })
      }

      function onToggleAdv (label) {        setAdvMap(function (previous) {
          var copy = Object.assign({}, previous)
          copy[label] = !(copy[label] === true)
          try { localStorage.setItem(ADV_OPEN_KEY, JSON.stringify(copy)) } catch (error) {}
          return copy
        })
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
        // 新增项目整对象追加在末尾（宿主 applyPathOp 允许 index === length 时 set 一项）。
        // 整对象而不是逐字段：它在宿主那边还不存在，逐字段 set 会先造出一个
        // 缺 `repo.path` 的半成品，那一笔就会被校验整笔拒掉 —— 正是旧版的老毛病。
        for (var q = 0; q < projPending.length; q += 1) {
          var index = projList.length + q
          ops.push({
            op: 'set',
            path: ['projects', String(index)],
            value: buildProjectValue(projPending[q], index, projDraft),
          })
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
        // 凭据先写：它和配置 mutate 是两个独立通道，不互相阻塞 —— 凭据失败只报
        // 凭据那条，配置照样存；反过来也一样。这里刻意**不 await**，让 mutate 立刻
        // 发出去（自测按「点保存 → 同一拍里 mutate 数 +1」断言）。
        if (pendingCreds.length > 0) {
          var credNs = getNamespace('credentials')
          if (credNs) {
            for (var pc = 0; pc < pendingCreds.length; pc += 1) {
              (function (entry) {
                credNs.set(entry.ref, entry.value).then(function (response) {
                  if (!response || !response.ok) {
                    setCredMessage('保存 ' + entry.ref + ' 失败：' +
                      ((response && response.error && response.error.message) || '未知错误'))
                    return
                  }
                  setCredMessage(entry.ref + ' 已保存')
                  setCredDraft(function (previous) {
                    var copy = Object.assign({}, previous)
                    copy[entry.ref] = ''
                    return copy
                  })
                  loadCredentials()
                }, function (error) {
                  setCredMessage('保存 ' + entry.ref + ' 失败：' +
                    (error && error.message ? error.message : String(error)))
                })
              })(pendingCreds[pc])
            }
          }
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
            // 冲突时最重要的一句话是「你刚才那些改动没存进去」—— 原来只写「请重试」，
            // 用户会以为已经存了一半。所以这里必须报出具体条数。
            var lostCount = ops.length
            var head = detail.code === 'SETTINGS_CONFLICT'
              ? '配置在别处被改过，已重新载入。你刚才那 ' + lostCount +
                ' 项改动没有保存，请重新改一遍再点保存。'
              : '保存失败：' + message
            // 兜底：宿主如果把 projects 这段整体判成「不可写」，回来的就是
            // `Config field "projects" is not declared` / `is not volatile` 这类
            // 底层文案 —— 对用户没有意义，给一句能照着做的。
            // 正常的深层路径写入（`projects[0].repo.path`）不会走到这里。
            if (/projects["'\]\s]*(is not|is)/i.test(message) && /not (volatile|declared)/i.test(message)) {
              head += '\n项目配置这段被宿主拒了。先把上面这段错误原文发给我，或者临时改 profile 的 cordis.patch.yml 里本行的 config.projects 顶上。'
            }
            if (mapped.top.length > 0) head += '\n' + mapped.top
            // 把「有几项没通过校验」说在前面：原来只回一段 `invalid config: …` 原文，
            // 人得自己数哪几条、还得自己滚回去找。现在先给条数，再滚到第一个标红的地方。
            var errorCount = countIssues(mapped.byKey, 'error')
            if (errorCount > 0) {
              head = '有 ' + errorCount + ' 项没通过校验，已在下方标红。' + '\n' + head
              scrollToFirstIssue()
            }
            setSaveError(head)
            return loadSettings()
          }
          setServerIssues({})
          setSaveMessage('已保存')
          // 新增的项目已经落进宿主，本地那份「待保存」清单必须清掉，
          // 否则 `loadProjects()` 回来的真项目会和它们叠成两份卡片。
          setProjPending([])
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

      /**
       * 待提交的凭据改动（输入框里填了、还没存的）。
       *
       * 凭据不再有每行的「保存」按钮，改用顶部主「保存」一次提交 —— 所以「有没有
       * 未保存的东西」要把它们一起算进去，否则只填了凭据时保存按钮是灰的，点不动。
       */
      var pendingCreds = []
      for (var ci = 0; ci < CREDENTIAL_REFS.length; ci += 1) {
        var cRef = CREDENTIAL_REFS[ci].ref
        var cVal = String(credDraft[cRef] === undefined || credDraft[cRef] === null ? '' : credDraft[cRef]).trim()
        if (cVal.length > 0) pendingCreds.push({ ref: cRef, value: cVal })
      }
      var credDirty = pendingCreds.length > 0

      /**
       * 往项目清单末尾追加一个项目。
       *
       * **只进本地草稿，不发 mutate**。
       *
       * 旧版在这里直接发 `{op:'set', path:['projects', len], value:{…repo:{path:''}}}`
       * —— 宿主对整份配置做校验，`repo.path` 是空串就报
       * `projects[2].repo.path 必须是非空字符串（本地 git 检出根目录）` 并整笔回滚，
       * 于是「先加一个、再慢慢填」这条路根本走不通（用户就是这么撞上的）。
       *
       * 现在改成：点一下先在面板上多出一张空卡片，填完点顶部「保存」时，
       * 新增项目跟其它改动一起作为**一笔** mutate 提交。好处是
       * ①半成品不会去撞校验；②新增与其它改动同 revision、要么全成要么全不成。
       */
      function onAddProject () {
        var index = projList.length + projPending.length
        var record = blankProjectRecord(index)
        setProjPending(function (previous) { return previous.concat([record]) })
        // 新增项目的字段草稿挂到 projDraft 的对应下标上，和已有项目走同一套
        // 编辑/撤销/校验路径（ProjectCard 只认绝对下标，不区分新旧）。
        setProjDraft(function (previous) {
          var copy = Object.assign({}, previous)
          var seeded = projectDrafts(record, index)
          var keys = Object.keys(seeded)
          for (var i = 0; i < keys.length; i += 1) copy[keys[i]] = seeded[keys[i]]
          return copy
        })
        setProjError('')
        setSaveMessage('')
        setSaveError('')
      }

      /**
       * 删掉一个项目。
       *
       * 两种情形分开处理：
       * - 删**已保存**的项目（`index < projList.length`）：发 `unset`，宿主侧是
       *   `splice(i, 1)`，删掉后下标会前移，所以按钮在「有未保存字段改动」时禁用
       *   （改了一半的字段会跟到别的项目上）。
       * - 删**还没保存的新增**（`index >= projList.length`）：它本来就不在宿主里，
       *   只需要从 `projPending` 里摘掉、顺手清掉那一档的字段草稿，**不发 mutate**。
       */
      function onRemoveProject (index) {
        if (index >= projList.length) {
          var offset = index - projList.length
          setProjPending(function (previous) {
            if (offset < 0 || offset >= previous.length) return previous
            var copy = previous.slice()
            copy.splice(offset, 1)
            return copy
          })
          // 草稿是按绝对下标存的，删掉这一张之后，后面 pending 卡片的下标会前移，
          // 所以把它们整段重排一遍（已保存项目的键原样不动）。
          setProjDraft(function (previous) {
            var copy = {}
            // ① 已保存的项目：键完全不变，原样搬过去。
            for (var i = 0; i < projList.length; i += 1) {
              addProjectDraftKeys(copy, previous, i, i)
            }
            // ② 剩下的 pending：旧下标 → 新下标，逐个字段搬。
            var kept = projPending.slice()
            kept.splice(offset >= 0 ? offset : 0, 1)
            for (var q = 0; q < kept.length; q += 1) {
              var from = projList.length + (q < offset ? q : q + 1)
              addProjectDraftKeys(copy, previous, from, projList.length + q)
            }
            return copy
          })
          setProjError('')
          setSaveMessage('')
          setSaveError('')
          return
        }
        var ns = getNamespace('settings')
        var view = findNamespace(snapshot)
        if (!ns || !view) return
        setProjBusy(true)
        setProjError('')
        ns.mutate(NAMESPACE, [{ op: 'unset', path: ['projects', String(index)] }], view.revision)
          .then(function (response) {
            setProjBusy(false)
            if (!response || !response.ok) {
              setProjError('删除项目失败：' + ((response && response.error && response.error.message) || '未知错误'))
              return
            }
            loadProjects()
          }, function (error) {
            setProjBusy(false)
            setProjError('删除项目失败：' + (error && error.message ? error.message : String(error)))
          })
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

      // ── 运行页签（#16）─────────────────────────────────────────
      // 三件事都走同一个 ns：status 读、scan 跑一轮、cancel 打断、reset 重开。
      // 它们全是 direct 调用（不是 stream），所以「看进度」只能靠自己定时再读。
      // 注意：这里之后只能是普通函数 —— 下面已经有 `if (!isPage) return`
      // 之类的早退，再调 hook 会让 hook 顺序随状态变化，React 会直接报错。
      function requireRunNamespace (action) {
        var ns = getNamespace('ticketPipeline')
        if (!ns) {
          setRunError('运行通道没挂上（remote.ticketPipeline 命名空间缺席）。' + action + '没做成。')
          return null
        }
        return ns
      }

      function onRunScan () {
        var ns = requireRunNamespace('跑一轮')
        if (!ns) return
        setRunAction('scan')
        setRunError('')
        setRunMessage('')
        ns.scan().then(function (response) {
          setRunAction('')
          if (!response || !response.ok) {
            setRunError('跑一轮失败：' + ((response && response.error && response.error.message) || '未知错误'))
            return
          }
          var value = response.value || {}
          setRunMessage(value.status === 'triggered' ? '已触发这一轮' : '')
          // 只有真的起来了才盯着：disabled / already-running 盯着也没用，
          // 反而让人以为「已经在跑了」。宿主那句解释放 runNotice。
          if (value.status === 'triggered') setRunPolling(true)
          setRunNotice(value.text || '')
          loadRun()
        }, function (error) {
          setRunAction('')
          setRunError('跑一轮失败：' + (error && error.message ? error.message : String(error)))
        })
      }

      function onRunCancel () {
        var ns = requireRunNamespace('取消')
        if (!ns) return
        setRunAction('cancel')
        setRunError('')
        ns.cancel().then(function (response) {
          setRunAction('')
          if (!response || !response.ok) {
            setRunError('取消失败：' + ((response && response.error && response.error.message) || '未知错误'))
            return
          }
          var value = response.value || {}
          setRunPolling(false)
          setRunNotice(value.text || '')
          loadRun()
        }, function (error) {
          setRunAction('')
          setRunError('取消失败：' + (error && error.message ? error.message : String(error)))
        })
      }

      function onRunRerun (recordId) {
        var ns = requireRunNamespace('重跑')
        if (!ns) return
        setRunAction(recordId)
        setRunError('')
        // 只传 recordId：projectId 是可选的（acceptsUndefined），不传就是缺席，
        // 传 undefined 反而会让网关的参数个数校验对不上。
        ns.reset(recordId).then(function (response) {
          setRunAction('')
          if (!response || !response.ok) {
            setRunError('重跑失败：' + ((response && response.error && response.error.message) || '未知错误'))
            return
          }
          var value = response.value || {}
          // 没重开成（比如票已经不在可重开的 phase 里）也要把话说出来 ——
          // 静默失败比报错更让人抓狂。
          setRunNotice(value.text || '')
          if (value.reset === true) setRunMessage('已放回队列')
          loadRun()
        }, function (error) {
          setRunAction('')
          setRunError('重跑失败：' + (error && error.message ? error.message : String(error)))
        })
      }

      function onRunToggle (recordId) {
        setRunOpen(function (previous) {
          var next = {}
          for (var key in previous) {
            if (Object.prototype.hasOwnProperty.call(previous, key)) next[key] = previous[key]
          }
          if (next[recordId]) delete next[recordId]
          else next[recordId] = true
          return next
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
            h('p', null, '从工单表检测变化、定位代码、改动验证、在检出里做本地提交、回填表格并推送通知。')),
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
          disabled: saving,
          onEdit: function (ref, next) { onCredEdit(ref, next) },
          onClear: function (ref) { onCredClear(ref) },
        })
      })

      function showTab (key) {
        setActiveTab(key)
        writeTab(key)
      }

      // 页签上的小数字：只有这一块真的「有事」时才出现（未保存 / 待修），
      // 平时不占位 —— 页签本来就压得紧，不该再挂一排常驻徽标。
      function tabBadge (key) {
        var count = 0
        var bad = false
        if (key === 'params') {
          count = configChangedCount
          if (issues.errorCount > 0) { count = issues.errorCount; bad = true }
        } else if (key === 'creds') {
          count = pendingCreds.length
        } else if (key === 'projects') {
          count = changedCount - configChangedCount
          if (changedCount === 0 && projectDirty) count = -1
          var projectBad = projectIssueCount
          if (projectBad > 0) { count = projectBad; bad = true }
        } else if (key === 'doctor') {
          // 角标只数「挡跑票」的那些：把提醒也数进去，角标会常年挂着一个数字，
          // 人就会学会忽略它 —— 那这个角标就白做了。
          count = doctorReport && doctorReport.ok === false
            ? ((doctorReport.blockers ? doctorReport.blockers.length : 0) + doctorReport.problems.length)
            : 0
          bad = count > 0
        } else if (key === 'run') {
          // 只数「要人动手」的那一档：排队中的票不算事，正在跑的不算事。
          // 把「已交付」也数进来，角标就永远是 5 以上 —— 等于没有角标。
          if (runData && Array.isArray(runData.tiers)) {
            for (var t = 0; t < runData.tiers.length; t += 1) {
              if (runData.tiers[t].label === '需要你处理') count = runData.tiers[t].count
            }
          }
          bad = count > 0
        }
        if (count === 0) return null
        return h('span', { className: 'tp-tab-badge' + (bad ? ' tp-badge-bad' : '') },
          count > 0 ? String(count) : '·')
      }

      var tabs = h('div', { className: 'tp-tabs', role: 'tablist' },
        TABS.map(function (tab) {
          return h('button', {
            key: tab.key,
            type: 'button',
            role: 'tab',
            className: 'tp-tab',
            'aria-selected': activeTab === tab.key ? 'true' : 'false',
            onClick: function () { showTab(tab.key) },
          }, tab.label, tabBadge(tab.key))
        }))

      // 顶部工具条：左页签、右动作。整页只有这一条，滚到哪儿都够得着「保存」。
      // 刻意**不再**放「体检」按钮 —— 体检已是页签，那颗按钮在这儿是重复入口。
      var toolbar = h('div', { className: 'tp-toolbar' },
        tabs,
        h('div', { className: 'tp-bar-actions' },
          issues.errorCount > 0
            ? h('span', { className: 'tp-count' }, issues.errorCount + ' 项待修')
            : null,
          changedCount + pendingCreds.length > 0
            ? h('span', { className: 'tp-count' },
              '未保存 ' + (changedCount + pendingCreds.length) + ' 项')
            : null,
          h('button', {
            type: 'button',
            className: 'tp-btn',
            disabled: saving || (changedCount === 0 && !credDirty),
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
              loadBranches()
            },
          }, '重新载入'),
          h('button', {
            type: 'button',
            className: 'tp-btn tp-primary',
            disabled: saving || issues.errorCount > 0 || (changedCount === 0 && !credDirty),
            onClick: onSave,
          }, saving ? '保存中…' : '保存')))

      var panels = {
        run: function () {
          return h(RunCard, {
            data: runData,
            busy: runAction !== '',
            action: runAction,
            error: runError,
            message: runMessage,
            notice: runNotice,
            polling: runPolling,
            available: mounted,
            openOf: function (recordId) { return runOpen[recordId] === true },
            onToggle: onRunToggle,
            onScan: onRunScan,
            onCancel: onRunCancel,
            onRerun: onRunRerun,
            onRefresh: loadRun,
          })
        },
        projects: function () {
          return h(ProjectListCard, {
            list: renderedProjects,
            draft: projDraft,
            issues: issues.byKey,
            busy: projBusy,
            error: projError,
            disabled: saving,
            message: '',
            saveError: '',
            dirty: projectDirty,
            onReload: loadProjects,
            onAdd: onAddProject,
            onRemove: onRemoveProject,
            onEdit: onProjectEdit,
            onRevert: onProjectRevert,
            branchList: branchList,
            branchBusy: branchBusy,
            // 目录选择器：宿主真提供了才传（拿不到时字段里不画按钮，见 ProjectCard 的
            // pick 分支）。这里必须按「宿主有没有 picker」判断，不能无条件传：面板自己
            // 那个 onPickDirectory 永远存在，无条件传等于按钮永远画出来、点下去才报错。
            pickDirectory: props.pickDirectory,
            picking: picking,
            onPickDirectory: typeof props.pickDirectory === 'function' ? onPickDirectory : undefined,
            onPasteLink: onPasteLink,
            linkBusy: linkBusy,
            linkMessage: linkMessage,
            linkError: linkError,
            showAdvanced: showAdvanced,
            onToggleAdvanced: setShowAdvanced,
            isProjectOpen: function (index) { return isProjectOpenOf(projMap, index) },
            onToggleProject: onToggleProject,
            isSectionOpen: function (index, sectionKey) { return isProjectSectionOpen(projMap, index, sectionKey) },
            onToggleSection: onToggleProjectSection,
          })
        },
        params: function () {
          return h(SettingsCard, {
            view: findNamespace(snapshot),
            leaves: leaves,
            draft: draft,
            initialDraft: initialDraft,
            secrets: secretMap,
            disabled: saving,
            dirty: dirty,
            changedCount: configChangedCount,
            saving: saving,
            error: '',
            message: '',
            issues: issues.byKey,
            errorCount: issues.errorCount,
            isOpen: function (label) { return isGroupOpen(openMap, label) },
            onToggle: onToggleGroup,
            isAdvOpen: function (label) { return isAdvOpenOf(advMap, label) },
            onToggleAdv: onToggleAdv,
            onEdit: onEdit,
            onRevert: onRevert,
          })
        },
        creds: function () {
          return h('section', { className: 'tp-card' },
            h('h3', null, '凭据'),
            h('p', { className: 'tp-note' },
              '凭据存在宿主的凭据库里，不写进配置文件；这里只显示「配没配」，输入框是只写的。',
              '填好之后点右上角「保存」一起提交 —— 留空表示不改，「清除」才会删掉已存的。'),
            h('div', { style: { marginTop: '8px' } }, credRows),
            credMessage.length > 0
              ? h('p', { className: 'tp-note', style: { marginTop: '8px' } }, credMessage)
              : null)
        },
        doctor: function () {
          return h(DoctorCard, {
            report: doctorReport,
            busy: doctorBusy,
            error: doctorError,
            available: mounted,
            message: '',
            onRun: onDoctor,
          })
        },
      }

      var current = panels[activeTab] || panels.run

      return h('div', { className: 'tp-panel' },
        h('header', { className: 'tp-head' },
          h('h2', null, '工单流水线'),
          h('p', null, '从工单表检测变化，定位代码、改动验证、在检出里做本地提交、回填表格并推送通知。')),

        toolbar,

        // 保存的结果（含服务端整笔拒绝）贴着工具条：人点完保存眼睛还在这里。
        // 它**不随页签切换消失** —— 保存是针对整份配置的，错在哪一页都得看见。
        saveError.length > 0
          ? h('p', { className: 'tp-err', style: { whiteSpace: 'pre-wrap' } }, saveError)
          : null,
        saveMessage.length > 0 ? h('p', { className: 'tp-note' }, saveMessage) : null,
        loadError.length > 0 ? h('p', { className: 'tp-err' }, loadError) : null,

        current())
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
     * 惰性取 uiWorkspace：同上，不写进 inject。
     *
     * 它由 dsh-client-ui-workspace 提供，不是所有部署都装；写进 inject 会让我们的
     * fiber 在没装它的部署里永远不激活，整个设置页静默消失。拿不到就是「选择目录」
     * 按钮不出现，手打路径照样能存。
     */
    function workspaceOf (ctx) {
      if (ctx === undefined || ctx === null || typeof ctx.get !== 'function') return undefined
      try {
        var found = ctx.get('uiWorkspace')
        return found === undefined || found === null ? undefined : found
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

      /**
       * 原生目录选择器。同样不写进 inject（见 workspaceOf 的注释）。
       *
       * 返回的是**取值函数**而不是服务本身：这个服务可能比我们更晚挂上，
       * 在 apply 时读一次会把「本来有、只是晚到」变成永久没有。面板每次渲染
       * 现取一次，拿到才画按钮。
       */
      var getDirectoryPicker = function () {
        var workspace = workspaceOf(ctx)
        return workspace && typeof workspace.pickDirectory === 'function' ? workspace : undefined
      }

      /**
       * 真正打开选择器；调用时现取服务，晚挂上的情况也能用。
       *
       * `current`（格子里已经填着的路径）要透传下去：宿主的 selectDirectory 用它当
       * 对话框的初始目录，人从「现在配的那个检出」开始挑，而不是从盘符根目录开始翻。
       */
      var pickDirectory = function (current) {
        var workspace = getDirectoryPicker()
        if (!workspace) return Promise.reject(new Error('宿主没提供 uiWorkspace.pickDirectory，只能手打路径'))
        return Promise.resolve(workspace.pickDirectory(current))
      }

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
          // 每次都现算：uiWorkspace 可能比我们晚挂上，也可能在重载后消失。
          pickDirectory: getDirectoryPicker() === undefined ? undefined : pickDirectory,
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
