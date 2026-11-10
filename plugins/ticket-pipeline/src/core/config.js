/**
 * `config.js` —— 配置 schema 与默认值。
 *
 * 为什么不 `import z from '@deepseek-ai/schemastery'`：
 *
 * 1. `schemastery` 是 **profile 的依赖**，不在本插件包的 `dependencies` 里；
 *    从 `plugins/ticket-pipeline/` 顶层 `import` 会直接 `ERR_MODULE_NOT_FOUND`，
 *    连离线自测都跑不起来（本机 `npm install` 也不可用，见 README「已知约束」）。
 * 2. cordis 校验配置时只要一件事（`lib/index.js` 的 `resolveConfig`）：
 *    `runtime.Config['~standard'].validate(rawConfig)` **同步**返回
 *    `{ value }` 或 `{ issues: [...] }`。这就是 standard-schema 规范本身，
 *    手写一个等价实现即可，不依赖任何包。
 *
 * 但**设置面板要的不是「自造形状」，而是 schemastery 的线上格式**。宿主
 * `dsh-settings` 拿到 `Config` 后做 `new z(schema.toJSON())`；浏览器再对宿主
 * 重建出来的信封做一次 `new z(envelope)`。两处都要求 `toJSON()` 返回
 * `{ uid, refs }` 这种**信封**，且 `refs` 里 `dict` / `inner` / `list` 的值
 * 必须是 **uid 数字**（引用），不能是内联对象 —— 否则数组字段的 `inner`
 * 在浏览器里会变成 `undefined`，校验直接抛
 * `Cannot read properties of undefined (reading 'meta')`，被宿主客户端的
 * `catch` 静默吞掉 ⇒ **整块设置面板停在 loading，什么也不显示**。
 *
 * 所以这里手写「信封」而不是手写「树」：`descriptorNode` 造出的每个节点都带
 * `toJSON()`，产出以自己为根的 `{ uid, refs }`（uid 按遍历顺序确定性编号，
 * 保证 `describe()` 的 revision 哈希稳定）。
 *
 * 代价：loader 的 `isSchemastery()` 判定为 false，设置面板拿不到 schemastery
 * 的结构化 diff（退化成整体替换）。校验、默认值、持久化都不受影响。
 * 这一点写在 README 的「已知约束」里，等以后能装依赖了再换成 schemastery。
 */

import { resolveRecordIds } from '../contracts/record-filter.js'
import { parseBitableUrl } from '../contracts/types.js'
import { FEISHU_SEMANTIC_FIELD_NAMES } from '../contracts/feishu-columns.js'

/**
 * `match.columns` 的键白名单（工单 #21）。
 *
 * 必须是**适配器真正认识的那 13 个**：写错一个字段名就意味着「配了但没生效」，
 * 而这是静默的（那一列读不到 → 空值 → 票被过滤掉）。所以白名单必须与
 * `source-feishu` 用的是同一份常量，不能在这里另抄一遍。
 */
const BITABLE_COLUMN_FIELDS = FEISHU_SEMANTIC_FIELD_NAMES

/**
 * 一项配置的声明。
 *
 * @typedef {Object} ConfigField
 * @property {'string'|'number'|'integer'|'boolean'|'string-array'} type
 * @property {unknown} default
 * @property {number} [min]
 * @property {number} [max]
 * @property {string[]} [enum]
 * @property {string} description
 */

/**
 * 一个项目条目（`projects[]` 的成员）。
 *
 * 工单属于哪个项目由「表」决定：每个项目在飞书知识树里有一张自己的工单表，
 * 所以绑定关系是表级的，不是行级的。一个项目条目 = 一张（或多张）工单表 + 一个仓库。
 *
 * @typedef {Object} ProjectEntry
 * @property {string} name 项目唯一标识，工单里的 projectId 就是它
 * @property {string} [description] 项目描述，会进 agent 的定位提示
 * @property {ProjectMatch} match 工单表怎么定位（显式 appToken/tableId 或文件名模糊匹配）
 * @property {ProjectRepo} repo 这个项目对应哪个仓库、从哪切、MR 到哪
 * @property {ProjectVerify} [verify] 验证命令；缺省则跳过验证直接开 draft MR
 */

/**
 * @typedef {Object} ProjectMatch
 * @property {string} platform 工单表所在平台，取值见下面的 `PLATFORMS`
 * @property {string} [appToken] 飞书多维表格 app_token（显式绑定）
 * @property {string} [tableId] 飞书数据表 id（显式绑定，和 appToken 一起用）
 * @property {string} [viewId] 可选：只扫某个视图
 * @property {string} [docNamePattern] 文件名模糊匹配（兜底：没有显式 appToken/tableId 时用它搜文档）
 * @property {string[]|string} [statusValues] 状态列里哪些取值算「在处理中」（收票条件）。
 *   每张表的约定不一样（常见「处理中」「否」「待处理」），写死一个值会让插件一张票都收不到。
 *   缺省按平台自带值（飞书「处理中」、金山「处理中」）。
 * @property {string} [sheetUrl] 金山文档表格的分享链接（wps 平台：给了就自动用 fetch 下载导出文件）
 * @property {string} [sheetName] 金山文档里的工作表名（wps 平台）
 * @property {string} [statusColumn] 「是否处理」列名（wps 平台）
 * @property {string} [statusValue] 收票的状态值（wps 平台单值形态；飞书用 statusValues）
 * @property {string} [mediaPrefix] 截图 fileToken 的前缀（wps 平台）
 * @property {string[]|string} [recordIds] 只处理这几条工单（收窄开关）。
 *   写一个或一组 record_id，适配器只收名单里的行；名单外的行整轮跳过，
 *   连「连续几轮没出现」都不累加，所以不会把没打算动的旧票误判成已删除。
 *   不给 = 收整张表（既有行为）。空数组是配置错误（会被拦下），不是「不收窄」。
 */

/**
 * @typedef {Object} ProjectRepo
 * @property {string} path 本地 git 检出根目录（必填）
 * @property {string} [remote] GitLab remote URL（开 MR 用）
 * @property {string} [baseBranch] 切 worktree 的基准分支（默认 main）
 * @property {string} [targetBranch] draft MR 的目标分支（默认同 baseBranch）
 */

/**
 * @typedef {Object} ProjectVerify
 * @property {string} [build] 构建命令（如 `npm run build`），空串跳过
 * @property {string} [test] 测试命令（如 `mvn -o test`），空串跳过
 */

/**
 * 全量配置表（架构文档 §9）。
 *
 * 键的顺序 = 面板里出现的顺序，按业务分组排列。
 * `projects[]` 不在这里（数组元素校验复杂，单独在 `validateProjects` 处理）。
 *
 * @type {Record<string, ConfigField>}
 */
export const CONFIG_FIELDS = Object.freeze({
  // ── 行为 ────────────────────────────────────────────
  enabled: {
    type: 'boolean',
    default: false,
    description: '总开关。默认关：装上不会自动扫表、建工作区、提交。配好之后要手动打开。',
  },
  pollIntervalMinutes: {
    type: 'number',
    default: 3,
    min: 1,
    max: 60,
    description: '轮询间隔（分钟）。飞书没有可靠的单元格变更事件，只能轮询',
  },
  ticketTimeoutMinutes: {
    type: 'number',
    default: 40,
    min: 5,
    max: 180,
    description: '单票墙钟超时（分钟）',
  },
  maxAttempts: {
    type: 'integer',
    default: 2,
    min: 1,
    max: 5,
    description: '可重试错误最多重试几次',
  },
  workExecutor: {
    type: 'string',
    default: 'mock',
    // 必须是 `src/index.js` 里 `EXECUTORS` 的键，一个不多一个不少。
    // 这里写字面量而不是从 index.js 反推：config.js 不能 import index.js
    // （index.js → config.js 取 `Config`，反过来就成环），而「配错一个字母」
    // 在上线事故里排第一 —— 以前没有这份名单时，`Agent` / `agents` / `agent `
    // 都能过校验，然后被静默换成 mock 执行器：票跑完全绿、回填「已完成」，
    // 实际一行代码没改。改 EXECUTORS 的键时，这里要同步改（自测脚本会盯着）。
    enum: Object.freeze(['agent', 'mock']),
    description: '执行器 id（mock / agent）。mock 只跑通链路、不改代码；agent 会真的起一个 agent 改代码并开 draft MR',
  },
  provider: {
    type: 'string',
    default: '',
    description: '跑任务书的模型 provider。留空 = 跟随当前会话默认（推荐：钉死一个 provider 换台宿主就跑不起来）',
  },
  isolateWorktree: {
    type: 'boolean',
    default: false,
    description: '每票再开一个隔离 worktree（缺省关：直接在项目工作区的检出里改代码，与「在工作区新增会话」一致）。打开前想清楚：工作区必须干净，改动会落在隔离分支上',
  },
  writeBack: {
    type: 'boolean',
    default: true,
    description: '跑完后回填工单表：「是否处理」改成 writeBackStatus 的值，「处理结果」写怎么处理的，「处理日期」写今天。关掉就完全不写表格（退化成只读）',
  },
  writeBackStatus: {
    type: 'string',
    default: '是',
    description: '回填时「是否处理」列要写的值（有的表用「是」，有的用「已完成」「已处理」）',
  },
  writeBackOnFailure: {
    type: 'boolean',
    default: false,
    description: '失败的票也往「处理结果」列写一段说明（写它卡在哪、工作区在哪、怎么重跑）。'
      + '**不动「是否处理」列** —— 那一行继续停在「处理中」，让人一眼看出这票没成。'
      + '缺省关：老用户升级后表格不会突然多出内容。表格里那行不再「躺三天没人知道」时才值得打开',
  },

  // ── agent 与模型 ────────────────────────────────────
  model: {
    type: 'string',
    default: '',
    description: '跑任务书的模型名，留空则跟随当前会话默认（推荐留空：钉死某个模型会在它被限流时让整条流水线全灭）',
  },
  maxTokens: {
    type: 'integer',
    default: 32000,
    min: 1024,
    max: 200000,
    description: '单次模型调用的最大输出 token',
  },
  agentPreset: {
    type: 'string',
    default: 'ptc',
    description: 'agent 执行器给子 agent 挂的 preset id（决定它有哪些工具）。留空 = 不挂，适合宿主已自带工具的场合',
  },

  // ── 通知 ────────────────────────────────────────────
  pushAdapter: {
    type: 'string',
    default: 'mock',
    // 与 `src/index.js` 的 `PUSHES` 键保持一致（理由同上面的 workExecutor）。
    // 以前写错只会静默退回 mock 推送：人一封真通知都收不到，插件日志里也看不出来。
    enum: Object.freeze(['mock', 'pushplus', 'qqmail']),
    description: '通知适配器 id（mock / pushplus / qqmail）。缺省 mock = 不发真消息，先这么跑通再换',
  },
  'pushplus.channel': {
    type: 'string',
    default: 'clawbot',
    description: 'PushPlus 推送渠道，ClawBot 用 clawbot',
  },
  'pushplus.callbackUrl': {
    type: 'string',
    default: '',
    description:
      '送达回执地址（可选）。PushPlus 把 sendStatus 回吐到这个地址：'
      + '0=未发 / 1=发送中 / 2=成功 / 3=失败。'
      + 'HTTP 200 只代表受理，不代表送达 —— 想知道「人真收到了」要配这个。',
  },
  // ── QQ 邮箱（SMTP）──
  // 授权码是「授权码」，不是登录密码；不写进配置，走 ctx.credentials 的 QQMAIL_AUTH_CODE。
  'qqmail.host': {
    type: 'string',
    default: 'smtp.qq.com',
    description: 'QQ 邮箱 SMTP 主机（企业邮箱换成自己的）',
  },
  'qqmail.encryption': {
    type: 'string',
    default: 'tls',
    enum: Object.freeze(['tls', 'starttls']),
    description: '连接加密方式：tls = 465 端口直连加密（推荐）；starttls = 587 端口先明文再升级。'
      + '这两件事必须配套，所以合成一个选择，而不是让你分别填端口和开关',
  },
  'qqmail.user': {
    type: 'string',
    default: '',
    description: '发件邮箱地址，例如 someone@qq.com',
  },
  'qqmail.to': {
    type: 'string',
    default: '',
    description: '收件邮箱；多个用逗号分隔',
  },
  notifyOn: {
    type: 'string-array',
    default: ['done', 'skipped', 'failed', 'needs-info'],
    description: '哪些 phase 要给发通知',
  },

  // ── 高级（面板里默认收起）───────────────────────────
  leaseTtlMinutes: {
    type: 'number',
    default: 10,
    min: 1,
    max: 60,
    description: '票级租约的存活时间（分钟），防止多进程抢同一张票',
  },
  branchPrefix: {
    type: 'string',
    default: 'ticket-',
    description: '隔离 worktree 的票分支名前缀；后接 <projectId>-<recordId>-r<修订号>（只在 isolateWorktree 打开时用得上）',
  },
  worktreeRetentionHours: {
    type: 'number',
    default: 24,
    min: 0,
    max: 720,
    description: '终态票的 worktree 保留小时数；0 = 不自动清理（只有开了 isolateWorktree 才有 worktree 可清）',
  },
  keepSession: {
    type: 'boolean',
    default: true,
    description: '处理完保留项目工作区里的那次会话（agent 释放，会话留在工作区名下，可以在 GUI 里点进去继续追问）。关掉就处理完把会话一起收掉',
  },
})

/**
 * 已经不给用户配的旋钮，只剩内置常量。
 *
 * 为什么收走这 4 个（原先是配置项）：它们全都属于「改错会出事、改对没收益」的
 * 一类 —— 调大 `safePageRun` 只是省请求、调小 `goneAfterScans` 会把还在改的票
 * 误判成已删除、心跳配错会让两个进程同时改同一个 worktree、`fetchBeforeCreate`
 * 关掉只会让基线变旧。用户没有判断依据，配了也只能配错。真需要调的人改这里。
 *
 * `concurrency` 不在这里：并发 1 是结构性的（`scheduler` 用 `running` 标志单飞，
 * `store.pickNext` 本来也只取一张），没有一个「数」需要表达。
 */
export const BUILTIN_LIMITS = Object.freeze({
  /** 连续扫到多少条已知且未变的记录后停止翻页。 */
  safePageRun: 20,
  /** 连续几轮扫不到就认定该行已被删除。 */
  goneAfterScans: 3,
  /** 租约心跳间隔（秒）：跑票期间每这么多秒续一次租。必须显著小于 leaseTtlMinutes。 */
  leaseHeartbeatSeconds: 60,
  /** 建隔离 worktree / 打开工作区前先 fetch 一次基准分支。 */
  fetchBeforeCreate: true,
})

/**
 * 设置面板的分组与字段标签。
 *
 * 分组只列键名（不重复字段声明本身），顺序即面板顺序；组内顺序也按这里的顺序走。
 * 键名必须与 `CONFIG_FIELDS` 一一对应 —— 漏写会让字段在面板里落到「其他」组，
 * `assertGroupCoverage()` 在离线自测里会把漏写直接报出来。
 *
 * @type {ReadonlyArray<{ id: string, label: string, fields: ReadonlyArray<readonly [string, string]> }>}
 */
export const CONFIG_GROUPS = Object.freeze([
  Object.freeze({
    id: 'behavior',
    label: '行为',
    fields: Object.freeze([
      Object.freeze(['enabled', '总开关']),
      Object.freeze(['pollIntervalMinutes', '轮询间隔（分钟）']),
      Object.freeze(['ticketTimeoutMinutes', '单票超时（分钟）']),
      Object.freeze(['maxAttempts', '最大重试次数']),
      Object.freeze(['workExecutor', '执行器']),
      Object.freeze(['provider', '模型 provider']),
      Object.freeze(['isolateWorktree', '每票开隔离 worktree']),
      Object.freeze(['writeBack', '处理完回填表格']),
      Object.freeze(['writeBackStatus', '回填的「是否处理」值']),
      Object.freeze(['writeBackOnFailure', '失败也写「处理结果」']),
    ]),
  }),
  Object.freeze({
    id: 'model',
    label: 'agent 与模型',
    fields: Object.freeze([
      Object.freeze(['model', '模型名']),
      Object.freeze(['maxTokens', '最大输出 token']),
      Object.freeze(['agentPreset', 'agent preset']),
    ]),
  }),
  Object.freeze({
    id: 'notify',
    label: '通知',
    fields: Object.freeze([
      Object.freeze(['pushAdapter', '通知适配器']),
      Object.freeze(['notifyOn', '发通知的 phase']),
      Object.freeze(['pushplus.channel', 'PushPlus 渠道']),
      Object.freeze(['pushplus.callbackUrl', '送达回执地址']),
      Object.freeze(['qqmail.host', 'SMTP 主机']),
      Object.freeze(['qqmail.encryption', 'SMTP 加密方式']),
      Object.freeze(['qqmail.user', '发件邮箱']),
      Object.freeze(['qqmail.to', '收件邮箱']),
    ]),
  }),
  Object.freeze({
    id: 'advanced',
    label: '高级',
    fields: Object.freeze([
      Object.freeze(['leaseTtlMinutes', '租约存活（分钟）']),
      Object.freeze(['branchPrefix', '分支名前缀']),
      Object.freeze(['worktreeRetentionHours', 'worktree 保留（小时）']),
      Object.freeze(['keepSession', '保留处理完的会话']),
    ]),
  }),
])

/** 分组缺失时的兜底组名（正常不该出现，出现了说明 `CONFIG_GROUPS` 漏写）。 */
export const FALLBACK_GROUP_LABEL = '其他'

/** 每个字段的分组 / 标签 / 面板顺序，全部由 `CONFIG_GROUPS` 派生。 */
const FIELD_PRESENTATION = (() => {
  /** @type {Record<string, { label: string, group: string, order: number }>} */
  const table = {}
  let order = 0
  for (const group of CONFIG_GROUPS) {
    for (const [key, label] of group.fields) {
      table[key] = { label, group: group.label, order: order++ }
    }
  }
  return Object.freeze(table)
})()

/**
 * 项目字段路径 → 中文 label（`match.appToken` 这种）。
 *
 * 为什么不在这里手写一份表：`buildProjectsDescriptor()` 里已经有全部项目字段的
 * `meta.label`，再抄一份就是两处定义迟早漂移。这里只是把 descriptor 树走一遍
 * 把 label 收集出来（懒算，且只算一次）。
 *
 * @returns {Record<string, string>}
 */
let projectLabelTable = null
function projectFieldLabels () {
  if (projectLabelTable !== null) return projectLabelTable
  /** @type {Record<string, string>} */
  const table = {}
  /** @param {any} node @param {string} prefix */
  const walk = (node, prefix) => {
    if (node === null || node === undefined) return
    // 先记自己：`string-array` 叶子也有 `inner`（元素节点），不能因为往下走就漏掉它。
    if (prefix.length > 0 && typeof node.meta?.label === 'string') table[prefix] = node.meta.label
    // `projects` 是数组节点：字段全挂在 `inner` 上（同一个前缀，不额外加段）。
    if (node.inner) {
      walk(node.inner, prefix)
      return
    }
    if (node.dict) {
      for (const [key, child] of Object.entries(node.dict)) walk(child, prefix.length > 0 ? `${prefix}.${key}` : key)
    }
  }
  walk(buildProjectsDescriptor(), '')
  projectLabelTable = Object.freeze(table)
  return projectLabelTable
}

/**
 * 给一个配置路径找中文说话方式。
 *
 * 三档：`CONFIG_FIELDS` 里的标量键走 `FIELD_PRESENTATION`；项目字段走
 * `buildProjectsDescriptor()` 的 label；都没有就返回空串（调用方退回裸路径）。
 *
 * @param {string} path 形如 `pollIntervalMinutes` / `match.appToken` / `projects[0].repo.path`
 * @returns {string}
 */
export function configFieldLabel (path) {
  const direct = FIELD_PRESENTATION[path]
  if (direct !== undefined) return direct.label
  // projects[i].<rest> 或 projects[].<rest> → 取 <rest> 去项目字段表里查
  const projectMatch = /^projects(?:\[(?:\d+)?\])?\.(.+)$/.exec(path)
  if (projectMatch !== null) {
    const rest = projectMatch[1]
    const table = projectFieldLabels()
    if (table[rest] !== undefined) return table[rest]
  }
  return ''
}

/**
 * 自测用：确认 `CONFIG_GROUPS` 与 `CONFIG_FIELDS` 完全对齐。
 * @returns {string[]} 问题清单，空数组表示对齐
 */
export function assertGroupCoverage () {
  const problems = []
  for (const key of Object.keys(CONFIG_FIELDS)) {
    if (FIELD_PRESENTATION[key] === undefined) problems.push(`CONFIG_GROUPS 缺少字段 ${key}`)
  }
  for (const key of Object.keys(FIELD_PRESENTATION)) {
    if (CONFIG_FIELDS[key] === undefined) problems.push(`CONFIG_GROUPS 多出字段 ${key}`)
  }
  return problems
}

/** 扁平键名 → `{ pushplus: { token } }` 这种嵌套形状。 */
function assignPath (target, path, value) {
  const parts = path.split('.')
  let cursor = target
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {}
    cursor = cursor[key]
  }
  cursor[parts[parts.length - 1]] = value
}

/** 嵌套形状 → 扁平键名。用户可以在配置里两种写法混着写（但 `projects` 不参与扁平）。 */
function flatten (source, prefix, out) {
  for (const [key, value] of Object.entries(source)) {
    if (key === 'projects') continue // projects 单独校验，不走扁平
    const full = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value) && CONFIG_FIELDS[full] === undefined) {
      flatten(value, full, out)
    } else {
      out[full] = value
    }
  }
  return out
}

/**
 * 本插件认识的平台，顺序就是报错文案里的展示顺序。
 *
 * 为什么这份名单放在 config.js 而不是从 `index.js` 的 `SOURCES` 反推：配置校验是
 * 纯函数，不该依赖「所有适配器都 import 成功」（离线自测时任何一个适配器炸掉，
 * 连配置都校验不了）。反向由组合根负责对齐：`index.js` 的 `SOURCES` 键必须落在
 * `PLATFORMS` 里，两边对不上由自测脚本报出来。
 *
 * 这份名单只用来「拒绝错字」：新增平台要同时改这里和 `SOURCES`（各加一行）。
 *
 * `webform` 已于 2026-11-09 移除（工单 #18）：它的水位只在内存里，重启一次就把同一批
 * 工单当新票重收一遍，留着等于留一条「看起来能用、实际会重跑」的路。老配置里写着
 * `webform` 的项目会在 `validateProject` 里拿到一条专门的迁移提示（见 `REMOVED_PLATFORMS`）。
 *
 * @type {readonly string[]}
 */
export const PLATFORMS = Object.freeze(['feishu', 'wps', 'mock'])

/**
 * 已移除的平台 → 迁移提示。
 *
 * 为什么不是简单地从 `PLATFORMS` 里删掉就完事：那样老配置会收到「只能是 feishu / wps / mock」，
 * 看得懂但不知道该怎么办。这里给一条能直接照做的替换建议。
 *
 * @type {Readonly<Record<string, string>>}
 */
export const REMOVED_PLATFORMS = Object.freeze({
  webform: 'webform 源已移除（它的水位只在内存里，重启一次会把同一批工单重收一遍）；'
    + '请改成 mock（离线演示/自测）或 feishu（真实工单表）',
})

/** 报错文案用的平台清单（「只能是 a / b / c」），从表里拼出来，免得两处各写一遍。 */
const PLATFORM_HINT = PLATFORMS.join(' / ')

/**
 * 校验平台，返回规范后的平台名，或者一条「为什么不认」的说明。
 *
 * 不传时退到 `mock`：老配置里没有 `match.platform`，以前一律按 mock 跑；
 * 现在照样能跑，但不给默认值的话「漏写平台」会被当成「写错平台」而拒绝启动。
 *
 * @param {unknown} platform
 * @returns {{ value: string } | { error: string }}
 */
function normalizePlatform (platform) {
  const value = platform === undefined || platform === null || platform === '' ? 'mock' : platform
  const raw = String(value)
  const removed = REMOVED_PLATFORMS[raw]
  // 先查「已移除」：这类要给可照做的迁移提示，而不是一句「只能是 …」。
  if (removed !== undefined) return { error: removed }
  if (PLATFORMS.includes(raw)) return { value: raw }
  return { error: `只能是 ${PLATFORM_HINT}（收到 ${JSON.stringify(raw)}）` }
}

/**
 * 校验一个项目条目。
 *
 * @param {unknown} raw
 * @param {number} index
 * @returns {{ value?: object, issues: Array<{ message: string, path: string[] }> }}
 */
function validateProject (raw, index) {
  const issues = []
  // 文案用「第 N 个项目 · 中文 label（原始路径）」：项目卡片上看到的是「飞书 appToken」
  // 这种中文名，而配置文件里能搜到的是 `match.appToken` —— 两个都得给，人才连得上。
  const fail = (path, message, fix) => {
    const label = configFieldLabel(`projects[].${path}`)
    const heading = label.length > 0
      ? `projects[${index}] ${label}（${path}）`
      : `projects[${index}].${path}`
    issues.push({ message: `${heading} ${message}`, path: ['projects', String(index), ...path.split('.')], ...(fix ? { fix } : {}) })
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ message: `projects[${index}] 必须是对象`, path: ['projects', String(index)], fix: '每个项目写成一块键值对（name / match / repo 三样都要有）' }] }
  }
  /** @type {any} */
  const p = raw

  const name = typeof p.name === 'string' ? p.name.trim() : ''
  if (name.length === 0) fail('name', '必须是非空字符串', '给项目起个名字（例如 PMS），它同时是 projectId，必须唯一')

  const match = p.match && typeof p.match === 'object' && !Array.isArray(p.match) ? p.match : {}
  const platformResult = normalizePlatform(match.platform)
  // 已移除平台给迁移提示、未知平台给「只能是 …」：两条都要能照着做。
  if (platformResult.error !== undefined) fail('match.platform', platformResult.error, '写成 platform: feishu（飞书）/ wps（金山文档）/ mock（离线自测）')
  const platform = platformResult.value

  const repo = p.repo && typeof p.repo === 'object' && !Array.isArray(p.repo) ? p.repo : {}
  const repoPath = typeof repo.path === 'string' ? repo.path.trim() : ''
  if (repoPath.length === 0) fail('repo.path', '必须是非空字符串（本地 git 检出根目录）', '填这个项目对应的仓库在你本机的路径，例如 D:/WorkSpace/pms')

  // feishu 能读两种表：多维表格（appToken+tableId）和电子表格（spreadsheetToken+sheetId/sheetName）。
  // 四选一即可 —— 少给一格就在启动时拦住，别等到扫描时才发现定位不到表：
  //   ① appToken + tableId（多维表格显式绑定）
  //   ② appToken 是一条带 ?table= 的链接（同上，table_id 从链接里啃）
  //   ③ spreadsheetToken +（sheetId 或 sheetName）（电子表格显式绑定）
  //   ④ docNamePattern（按云文档名模糊匹配，两种表型都认）
  // 另外 tableKind 是逃生阀：显式写 bitable / sheet 就跳过表型探测。
  if (platform === 'feishu') {
    const rawAppToken = typeof match.appToken === 'string' ? match.appToken : ''
    const fromUrl = parseBitableUrl(rawAppToken)
    const explicitTableId = typeof match.tableId === 'string' && match.tableId.length > 0 ? match.tableId : fromUrl.tableId
    const hasBitable = rawAppToken.trim().length > 0 && explicitTableId.length > 0
    const rawSpreadsheetToken = typeof match.spreadsheetToken === 'string' ? match.spreadsheetToken.trim() : ''
    const sheetTarget = typeof match.sheetId === 'string' ? match.sheetId.trim() : ''
    const sheetTargetName = typeof match.sheetName === 'string' ? match.sheetName.trim() : ''
    const hasSheet = rawSpreadsheetToken.length > 0 && (sheetTarget.length > 0 || sheetTargetName.length > 0)
    const hasPattern = typeof match.docNamePattern === 'string' && match.docNamePattern.length > 0
    const tableKind = typeof match.tableKind === 'string' ? match.tableKind.trim() : ''

    if (tableKind.length > 0 && tableKind !== 'bitable' && tableKind !== 'sheet') {
      fail('match.tableKind', '只能写 bitable 或 sheet（留空表示让它自己探测）', '这一格一般不用填：留空，插件会按 token 自动认出表型')
    }
    if (!hasBitable && !hasSheet && !hasPattern) {
      fail('match', 'feishu 项目必须给①appToken+tableId（或多维表格链接里的 ?table=）②spreadsheetToken + sheetId/sheetName（电子表格）③docNamePattern（按文件名匹配）之一',
        '最省事的做法：在面板的项目卡片里把工单表链接整条贴进「工单表链接」；不想用链接就填「表名匹配」（例如 PMS项目管理系统工单）')
    }
    if (rawSpreadsheetToken.length > 0 && !hasSheet) {
      fail('match.spreadsheetToken', '给了电子表格 token 就得同时给 sheetId（工作表 id）或 sheetName（工作表名），否则不知道该读哪一张',
        '补上「工作表名」（给人看的名字，例如 Sheet1）或「工作表 id」（sh 开头那串）')
    }
  }

  if (issues.length > 0) return { issues }

  /** @type {any} */
  const value = {
    name,
    match: { platform },
    repo: { path: repoPath },
  }
  if (typeof p.description === 'string' && p.description.length > 0) value.description = p.description
  if (typeof match.appToken === 'string' && match.appToken.length > 0) value.match.appToken = match.appToken
  if (typeof match.tableId === 'string' && match.tableId.length > 0) value.match.tableId = match.tableId
  if (typeof match.viewId === 'string' && match.viewId.length > 0) value.match.viewId = match.viewId
  if (typeof match.docNamePattern === 'string' && match.docNamePattern.length > 0) value.match.docNamePattern = match.docNamePattern

  // 状态值：收票与否全看它。必须在这里校验 —— 配错一个空串就等于整张表收不到票，
  // 而这种错在启动时看不出来（源照样扫得动，只是空转）。
  if (match.statusValues !== undefined && match.statusValues !== null) {
    const raw = Array.isArray(match.statusValues) ? match.statusValues : [match.statusValues]
    const list = raw
      .filter((item) => typeof item === 'string' || typeof item === 'number')
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0)
    if (list.length === 0) {
      fail('match.statusValues', '必须是非空字符串或字符串数组（值是状态列里表示「在处理中」的取值）', '照抄状态列里实际写的字，例如 ["处理中"] 或 ["否", "待处理"]')
    } else {
      value.match.statusValues = Array.from(new Set(list))
    }
  }

  // 收窄开关：只处理指定几张工单。空数组必须报错 —— 它字面意思是「挑零张」，
  // 若当成「不收窄」等于把闸门反锁（收下整张表）。
  if (match.recordIds !== undefined && match.recordIds !== null) {
    try {
      const ids = resolveRecordIds(match.recordIds)
      if (Array.isArray(ids) && ids.length > 0) value.match.recordIds = ids
    } catch (error) {
      fail('match.recordIds', error instanceof Error ? error.message : String(error),
        '这个键是「只处理这几张票」的收窄开关；不想收窄就整个删掉，不要留空列表（空列表的意思是「一张都不收」）')
    }
  }

  // 截图链接的主机白名单。截图地址来自工单表，是**外部输入**：不设白名单就等于让填表的人
  // 替服务器发任意请求（内网探测 / 云元数据 / 打穿本地服务）。适配器缺省一律拒绝，
  // 所以这里必须能把人写的域名原样送到适配器手里 —— 少这一处，配了也等于没配。
  // 空数组按配置错误处理：写了这个键却一个域名都不给，字面意思就是「什么都别放行」，
  // 那和默认行为一样，人写它必然是想放行某几个，写错才是原因。
  if (match.allowedImageHosts !== undefined && match.allowedImageHosts !== null) {
    const rawHosts = Array.isArray(match.allowedImageHosts) ? match.allowedImageHosts : [match.allowedImageHosts]
    const hosts = rawHosts
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0)
    if (hosts.length === 0) {
      fail('match.allowedImageHosts', '必须是非空字符串或字符串数组（截图链接允许的主机名，例如 cdn.example.com）', '写域名，不带协议和路径（cdn.example.com 可以，https://cdn.example.com/b.png 不行）；不想放行任何外部截图就整个删掉这个键')
    } else {
      value.match.allowedImageHosts = Array.from(new Set(hosts))
    }
  }

  // 金山文档（wps）专属的定位字段：组合根不认识它们，由适配器自己翻译（ADR-0001）。
  for (const key of ['sheetUrl', 'sheetName', 'statusColumn', 'statusValue', 'mediaPrefix']) {
    const item = match[key]
    if (typeof item === 'string' && item.length > 0) value.match[key] = item
  }

  // 飞书电子表格的定位与切表参数（设计 §4.2）。只有电子表格分支会用到；
  // 配在多维表格项目上不报错，只是没人读 —— 这样一个人把项目从多维表格换成
  // 电子表格时不用先删干净旧键，换个 token 就行。
  //
  // `sheetName` 与金山源同名同义（都是「工作表名」），所以它在上面的循环里已经透传过了，
  // 这里**不要**再写一遍 —— 两份定义迟早会漂移。`sheetIdColumn` 缺省「序号」,
  // 只在 `sheetIdentity: 'seq'` 时有意义。
  if (typeof match.spreadsheetToken === 'string' && match.spreadsheetToken.trim().length > 0) value.match.spreadsheetToken = match.spreadsheetToken.trim()
  if (typeof match.sheetId === 'string' && match.sheetId.trim().length > 0) value.match.sheetId = match.sheetId.trim()
  if (typeof match.sheetIdColumn === 'string' && match.sheetIdColumn.trim().length > 0) value.match.sheetIdColumn = match.sheetIdColumn.trim()
  if (typeof match.sheetRange === 'string' && match.sheetRange.trim().length > 0) value.match.sheetRange = match.sheetRange.trim()
  if (typeof match.tableKind === 'string' && match.tableKind.trim().length > 0) value.match.tableKind = match.tableKind.trim()

  // 表头行：必须是 ≥1 的整数。写字符串 "2" 也认（面板上的数字输入框回来的是字符串），
  // 但写 "0" / "-1" / "abc" 必须报错 —— 静默当 1 会让「表头在第 2 行」的表整表错位。
  if (match.sheetHeaderRow !== undefined && match.sheetHeaderRow !== null && match.sheetHeaderRow !== '') {
    const row = Number(match.sheetHeaderRow)
    if (!Number.isInteger(row) || row < 1) {
      fail('match.sheetHeaderRow', `必须是 ≥1 的整数（表头在第几行），实际是 ${JSON.stringify(match.sheetHeaderRow)}`, '数一下表头在表格里的行号（最上面有标题行就往后数），缺省 1')
    } else {
      value.match.sheetHeaderRow = row
    }
  }

  // 行身份策略：默认按「序号」列，兜底按物理行号。
  // 这两个值差一个字就会让整表身份全变（旧票全退役、新票全涌入），所以严格白名单。
  if (typeof match.sheetIdentity === 'string' && match.sheetIdentity.trim().length > 0) {
    const identity = match.sheetIdentity.trim()
    if (identity !== 'seq' && identity !== 'row') {
      fail('match.sheetIdentity', '只能写 seq（按序号列，缺省）或 row（按物理行号）', '一般不用填。填 seq = 按「序号」列认票（推荐，插行不换身份）；填 row = 按物理行号认票（插行会让票换身份）')
    } else {
      value.match.sheetIdentity = identity
    }
  }

  // 列名覆盖：`{ 语义字段: 表头里实际写的字 }`。字段名必须是适配器认识的那 13 个，
  // 写错一个就等于「配了但没生效」，所以这里先按白名单校验一遍。
  if (match.sheetColumns !== undefined && match.sheetColumns !== null) {
    if (typeof match.sheetColumns !== 'object' || Array.isArray(match.sheetColumns)) {
      fail('match.sheetColumns', '必须是对象，形如 { "description": "问题描述", "status": "是否处理" }', '左边是插件认识的 13 个字段名，右边是表头里实际写的列名；表头叫法本来就对的话删掉这个键')
    } else {
      /** @type {Record<string, string | string[]>} */
      const columns = {}
      for (const [field, actual] of Object.entries(match.sheetColumns)) {
        const names = Array.isArray(actual) ? actual : [actual]
        const cleaned = names
          .filter((item) => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
        if (cleaned.length === 0) {
          fail(`match.sheetColumns.${field}`, '必须是非空字符串或字符串数组（表头里实际写的列名）', `填表头里那一格的实际文字，例如 "${field}": "问题描述"`)
          continue
        }
        columns[field] = Array.isArray(actual) ? cleaned : cleaned[0]
      }
      if (Object.keys(columns).length > 0) value.match.sheetColumns = columns
    }
  }

  // 多维表格的列名覆盖（工单 #21）：与 `match.sheetColumns` **同形、同一套校验**，
  // 只是字段白名单来自多维表格那份别名表。
  // 为什么要两个键而不是复用 sheetColumns：两种表型的「认识哪些字段名」不完全一样
  // （多维表格额外认规范名本身），而且报错时要说清「你配的是哪种表」。
  if (match.columns !== undefined && match.columns !== null) {
    if (typeof match.columns !== 'object' || Array.isArray(match.columns)) {
      fail('match.columns', '必须是对象，形如 { "description": "缺陷描述", "status": "处理状态" }', '左边是插件认识的字段名（与 match.sheetColumns 相同），右边是这张多维表格里字段实际叫的名字；字段名本来就对的话删掉这个键')
    } else {
      /** @type {Record<string, string | string[]>} */
      const columns = {}
      for (const [field, actual] of Object.entries(match.columns)) {
        if (!BITABLE_COLUMN_FIELDS.includes(field)) {
          // 白名单外的键**必须报错**：它会静默不生效，而人以为自己已经配好了
          // —— 那正是这个键要解决的病（列名对不上导致扫出 0 张票）。
          fail(`match.columns.${field}`, `不认识的字段名（只认 ${BITABLE_COLUMN_FIELDS.join(' / ')}）`, '左边必须用插件认识的字段名，不是表里的中文列名：想表达「描述列叫缺陷描述」要写成 { "description": "缺陷描述" }')
          continue
        }
        const names = Array.isArray(actual) ? actual : [actual]
        const cleaned = names
          .filter((item) => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
        if (cleaned.length === 0) {
          fail(`match.columns.${field}`, '必须是非空字符串或字符串数组（字段在表里的实际名字）', `填这张表里那个字段的真实文字，例如 "${field}": "问题描述"`)
          continue
        }
        columns[field] = Array.isArray(actual) ? cleaned : cleaned[0]
      }
      if (Object.keys(columns).length > 0) value.match.columns = columns
    }
  }

  if (typeof repo.remote === 'string' && repo.remote.length > 0) value.repo.remote = repo.remote
  if (typeof repo.baseBranch === 'string' && repo.baseBranch.length > 0) value.repo.baseBranch = repo.baseBranch
  if (typeof repo.targetBranch === 'string' && repo.targetBranch.length > 0) value.repo.targetBranch = repo.targetBranch

  // repo.gitlab 是自建站点 / 子组路径的唯一表达方式（执行器 resolveGitlab 会以它为准）。
  // 不在这里透传就等于把人的配置吞掉：URL 解析不出来时只会得到一句
  // 「项目没有配置 GitLab」，而配置里明明写着。
  //
  // enabled 是**远程 MR 出口的总开关**，缺省 false：本阶段处理完工单只做
  // 「工作区检出里的本地提交」，不连远程、不要 GITLAB_TOKEN。要开 draft MR 才显式写 true。
  if (repo.gitlab && typeof repo.gitlab === 'object' && !Array.isArray(repo.gitlab)) {
    /** @type {any} */
    const gitlab = {}
    if (typeof repo.gitlab.baseUrl === 'string' && repo.gitlab.baseUrl.trim().length > 0) gitlab.baseUrl = repo.gitlab.baseUrl.trim()
    if (typeof repo.gitlab.remote === 'string' && repo.gitlab.remote.trim().length > 0) gitlab.remote = repo.gitlab.remote.trim()
    const gid = repo.gitlab.projectId
    if (typeof gid === 'number' && Number.isFinite(gid)) gitlab.projectId = gid
    else if (typeof gid === 'string' && gid.trim().length > 0) gitlab.projectId = gid.trim()
    if (repo.gitlab.enabled === true) gitlab.enabled = true
    if (Object.keys(gitlab).length > 0) value.repo.gitlab = gitlab
  }

  if (p.verify && typeof p.verify === 'object' && !Array.isArray(p.verify)) {
    const verify = {}
    if (typeof p.verify.build === 'string' && p.verify.build.length > 0) verify.build = p.verify.build
    if (typeof p.verify.test === 'string' && p.verify.test.length > 0) verify.test = p.verify.test
    if (Object.keys(verify).length > 0) value.verify = verify
  }

  return { value, issues }
}

/**
 * 校验 `projects[]`。
 *
 * @param {unknown} raw
 * @returns {{ value?: object[], issues?: Array<{ message: string, path?: string[] }> }}
 */
function validateProjects (raw) {
  if (raw === undefined || raw === null) {
    return { value: [] }
  }
  if (!Array.isArray(raw)) {
    return { issues: [{ message: 'projects 必须是数组', path: ['projects'] }] }
  }
  /** @type {object[]} */
  const value = []
  /** @type {Array<{ message: string, path?: string[] }>} */
  const issues = []
  const seen = new Set()
  for (const [i, entry] of raw.entries()) {
    const result = validateProject(entry, i)
    if (result.issues && result.issues.length > 0) {
      issues.push(...result.issues)
      continue
    }
    const name = /** @type {any} */ (result.value).name
    if (seen.has(name)) {
      issues.push({ message: `projects[${i}].name 项目名 "${name}" 重复，projectId 必须唯一`, path: ['projects', String(i), 'name'] })
      continue
    }
    seen.add(name)
    value.push(/** @type {any} */ (result.value))
  }
  if (issues.length > 0) return { issues }
  return { value }
}

/**
 * 已从配置里删掉的键 → 「它去哪了」。
 *
 * 为什么单独一张表、而且只是**警告**：#03 删了 10 个键（收成内置常量、挪去凭据、
 * 合并成枚举）。老配置里还留着它们，删键时已经确认过「留下不报错也不生效」
 * （`flatten()` 收进 map、`validateConfig` 只遍历 `CONFIG_FIELDS`）。
 * 但「静默忽略」对人不友好 —— 人照着老文档填了 `qqmail.port`，以为生效了。
 * 所以这里给一条「这个键已经没用了，该换成什么」，而**不是**报成错误（那会让
 * 老配置拒绝启动，等于给升级加了一道人工卡口）。
 *
 * @type {Readonly<Record<string, string>>}
 */
export const REMOVED_CONFIG_KEYS = Object.freeze({
  safePageRun: '已收成内置常量 20，不再给配',
  goneAfterScans: '已收成内置常量 3，不再给配',
  concurrency: '并发恒为 1（结构决定），不再给配',
  leaseHeartbeatSeconds: '已收成内置常量 60 秒，不再给配',
  fetchBeforeCreate: '已收成内置常量 true，不再给配',
  logLevel: '这个键从来没被消费过，已删掉',
  'pushplus.token': 'token 是密钥，改到「凭据」页填 PUSHPLUS_TOKEN',
  'pushplus.template': '模板恒为 txt（富模板只显示前 50 字），已删掉',
  'qqmail.port': '改用 qqmail.encryption：tls = 465、starttls = 587',
  'qqmail.secure': '改用 qqmail.encryption：tls = 465、starttls = 587',
})

/**
 * 几个「通用的修法句式说不清」的键，单独给一句能照着做的。
 *
 * 为什么需要单独一张表：`从这几个里挑一个：mock / pushplus / qqmail` 只是复述了选项，
 * 人真正想知道的是「我这次该挑哪个」。这类建议必须结合这个键的用途，从 descriptor
 * 推不出来。表里没有的键继续走通用句式（默认值 + 范围），不硬写。
 */
const FIELD_FIX_HINTS = Object.freeze({
  pushAdapter: '第一次配先填 mock（只记日志、不发真消息），等整条链路跑通了再换 pushplus / qqmail。'
    + '选 qqmail 还要在「通知」组填 qqmail.user 与 qqmail.to；选 pushplus 要去「凭据」页填 PUSHPLUS_TOKEN。',
  workExecutor: '第一次先填 mock（只走流程、不改代码），确认工单表与仓库都配对了再换 agent。',
  'qqmail.encryption': '不确定就填 tls（465 端口直连加密）。只有服务器不接受 465 时才用 starttls（587，先明文再升级）。',
  provider: '留空（写 ""）表示跟随当前会话默认 —— 推荐留空。钉死某个 provider 换台机器就跑不起来。',
  model: '留空（写 ""）表示跟随会话默认模型。钉死模型会在它被限流时让整条流水线全灭。',
})

/**
 * 编辑距离（只用来给「你是不是想写 X」找最近的那个键）。
 *
 * 不引依赖：这里只需要一个小函数，为它拉一个库（levenshtein 之类）不值得。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance (a, b) {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let previous = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) previous[j] = j
  for (let i = 1; i <= a.length; i += 1) {
    /** @type {number[]} */
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[b.length]
}

/**
 * 给一个不认识的键找最像的合法键。
 *
 * 两档判据：①编辑距离 ≤2（`pollInvervalMinutes` 这种拼错）；②一方是另一方的前缀
 * 或包含（`pollInterval` / `pollintervalminutes` 这类少写/大小写写歪）。
 * 都对不上就返回空串 —— **不要硬猜**，猜错的建议比没有建议更浪费时间。
 *
 * @param {string} key
 * @returns {string}
 */
export function suggestConfigKey (key) {
  const candidates = Object.keys(CONFIG_FIELDS)
  let best = ''
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const distance = editDistance(key, candidate)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  if (bestDistance <= 2) return best
  const lower = key.toLowerCase()
  for (const candidate of candidates) {
    const lowered = candidate.toLowerCase()
    if (lowered.startsWith(lower) || lower.startsWith(lowered)) return candidate
    if (lower.length >= 6 && lowered.includes(lower)) return candidate
  }
  return ''
}

/**
 * 校验并补默认值。
 *
 * 每条 issue 都带 `fix`（「该怎么改」），因为绝大多数人看到
 * `pollIntervalMinutes 不能大于 60` 之后还要再查一遍文档才知道该填什么。
 * `fix` 是给人看的一句话，不是给程序解析的。
 *
 * `warnings` 是**不挡启动**的提醒（目前只有「配置里有不认识的键」这一类）。
 * 它不进 `issues` —— 报成错误等于让老配置拒绝启动（见 `REMOVED_CONFIG_KEYS`）。
 *
 * @param {unknown} raw
 * @returns {{ value?: Record<string, unknown>, issues?: Array<{ message: string, path?: string[], fix?: string }>, warnings?: string[] }}
 */
export function validateConfig (raw) {
  const input = raw === undefined || raw === null ? {} : raw
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { issues: [{ message: '配置必须是一个对象', path: [], fix: '整体写成 { ... } 形状（YAML 顶格缩进的键值对）' }] }
  }

  /** @type {Record<string, unknown>} */
  const flat = {}
  flatten(input, '', flat)

  /** @type {Array<{ message: string, path?: string[], fix?: string }>} */
  const issues = []
  /** @type {Record<string, unknown>} */
  const nested = {}

  for (const [path, field] of Object.entries(CONFIG_FIELDS)) {
    const present = Object.prototype.hasOwnProperty.call(flat, path)
    const value = present ? flat[path] : field.default
    // 报错文案用「中文 label + 原始路径」，两个都留着：
    // label 让人一眼知道说的是哪个设置，路径让人能在文件里搜到。
    // label 自己可能带括号（`轮询间隔（分钟）`），所以路径并进同一对括号里，
    // 不写成 `轮询间隔（分钟）（pollIntervalMinutes）` 这种两层括号。
    const label = configFieldLabel(path)
    const heading = label.length > 0 ? `${label.replace(/）$/, `，${path}）`)}` : path
    const fail = (message, fix) => issues.push({ message: `${heading} ${message}`, path: path.split('.'), ...(fix ? { fix } : {}) })
    const example = field.default !== undefined ? JSON.stringify(field.default) : ''
    // 几个键的修法没法从 descriptor 推出来（要结合上下文），在这里写死。
    // 只要「怎么改」比「带默认值的通用句式」更具体，就值得单独写一句。
    const customFix = FIELD_FIX_HINTS[path]

    switch (field.type) {
      case 'string': {
        if (typeof value !== 'string') { fail('必须是字符串', customFix ?? `写成文本（不要写成数字或列表）${example ? `，缺省是 ${example}` : ''}`); break }
        if (field.enum && !field.enum.includes(value)) {
          fail(`只能是 ${field.enum.join(' / ')}`, customFix ?? `从这几个里挑一个：${field.enum.join(' / ')}${example ? `；不确定就先用缺省 ${example}` : ''}`)
          break
        }
        assignPath(nested, path, value)
        break
      }
      case 'number':
      case 'integer': {
        const unit = field.type === 'integer' ? '整数' : '数字'
        const range = field.min !== undefined && field.max !== undefined
          ? `${field.min}–${field.max}`
          : field.min !== undefined
            ? `不小于 ${field.min}`
            : field.max !== undefined ? `不大于 ${field.max}` : ''
        if (typeof value !== 'number' || Number.isNaN(value)) {
          fail('必须是数字', `填阿拉伯数字，不要加引号、不要写单位${range ? `（范围 ${range}）` : ''}${example ? `；缺省是 ${example}` : ''}`)
          break
        }
        if (field.type === 'integer' && !Number.isInteger(value)) {
          fail('必须是整数', `填整数（不能带小数点）${example ? `；缺省是 ${example}` : ''}`)
          break
        }
        if (field.min !== undefined && value < field.min) {
          fail(`不能小于 ${field.min}`, `填 ${field.min}–${field.max ?? '不限'} 之间的${unit}${example ? `，常用 ${example}` : ''}`)
          break
        }
        if (field.max !== undefined && value > field.max) {
          fail(`不能大于 ${field.max}`, `填 ${field.min ?? '不限'}–${field.max} 之间的${unit}${example ? `，常用 ${example}` : ''}`)
          break
        }
        assignPath(nested, path, value)
        break
      }
      case 'boolean': {
        if (typeof value !== 'boolean') { fail('必须是布尔值', '只能是 true 或 false（不要写「是 / 否」「开 / 关」）'); break }
        assignPath(nested, path, value)
        break
      }
      case 'string-array': {
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
          fail('必须是字符串数组', '写成列表，例如 ["done", "failed"]；只有一个值时也要写成列表')
          break
        }
        assignPath(nested, path, [...value])
        break
      }
      default:
        fail(`未知的配置类型 ${field.type}`, '这是插件自身的 bug，请把这条报错贴给维护者')
    }
  }

  // projects[] 单独校验
  const projects = validateProjects(input.projects)
  if (projects.issues && projects.issues.length > 0) {
    issues.push(...projects.issues)
  } else {
    nested.projects = projects.value
  }

  // 不认识的键：只警告，不挡启动。
  //
  // 为什么值得做：`pollInvervalMinutes`（少一个字母）在过去是完全静默的 ——
  // 插件照常启动、照常按 3 分钟轮询，人以为自己配的是 30 分钟，查半天查不出原因。
  // 而 `flatten()` 早就把这些键收进 map 了，检查一次几乎没有成本。
  const warnings = collectUnknownKeyWarnings(flat)

  if (issues.length > 0) return { issues, warnings }
  return { value: attachWarnings(nested, warnings), warnings }
}

/**
 * 找出 `flat` 里不属于 `CONFIG_FIELDS` 的键，翻成人话。
 *
 * @param {Record<string, unknown>} flat
 * @returns {string[]}
 */
function collectUnknownKeyWarnings (flat) {
  /** @type {string[]} */
  const warnings = []
  for (const key of Object.keys(flat)) {
    if (CONFIG_FIELDS[key] !== undefined) continue
    const removed = REMOVED_CONFIG_KEYS[key]
    if (removed !== undefined) {
      warnings.push(`配置里还留着 \`${key}\`（${removed}）。留着不影响启动，删掉更清爽。`)
      continue
    }
    const suggestion = suggestConfigKey(key)
    warnings.push(suggestion.length > 0
      ? `配置里有 \`${key}\`，这个键不存在；你要找的是 \`${suggestion}\` 吗？（写成 \`${key}\` 完全不会生效，插件会当作没配）`
      : `配置里有 \`${key}\`，这个键不存在，也不会生效。检查一下拼写，或看看 user-guide 的「配置项速查」。`)
  }
  return warnings
}

/**
 * 校验结果的警告挂在配置对象上的键。
 *
 * 用 `Symbol.for` 而不是模块内私有 Symbol：读的一方在别的模块（`pipeline_doctor`），
 * 两边必须是同一个键。
 */
export const CONFIG_WARNINGS = Symbol.for('ticket-pipeline.configWarnings')

/**
 * 把警告挂到校验后的配置对象上（**不可枚举**）。
 *
 * 为什么挂在这里而不是让 `apply()` 再解析一遍配置：cordis 只把**校验后的值**
 * 传给 `apply()`，原始（带拼错键的）配置在那一步已经拿不到了。而
 * `pipeline_doctor` 只拿得到 `getConfig()` 的结果 —— 不挂上去，警告就只有
 * `validateConfig()` 的直接调用者才看得见，等于没做。
 *
 * 不可枚举是硬要求：它不能被 `describeConfig()`、`JSON.stringify()` 或面板的
 * 值序列化看见（那是用户数据，不该混进内部字段）。
 *
 * @param {Record<string, unknown>} value
 * @param {string[]} warnings
 * @returns {Record<string, unknown>}
 */
function attachWarnings (value, warnings) {
  if (warnings.length === 0) return value
  Object.defineProperty(value, CONFIG_WARNINGS, { value: [...warnings], enumerable: false, configurable: true })
  return value
}

/**
 * 读回 `validateConfig()` 留下的警告（没有就是空数组）。
 *
 * @param {unknown} config
 * @returns {string[]}
 */
export function readConfigWarnings (config) {
  const value = /** @type {any} */ (config)
  const warnings = value?.[CONFIG_WARNINGS]
  return Array.isArray(warnings) ? warnings : []
}

// ── 设置面板的 schema 形状（descriptor）────────────────────────
//
// `dsh-settings` 暴露设置项的唯一门槛是「`Config` 上有 `toJSON()`，且至少一处
// `meta.volatile === true`」。它不看 `instanceof`（鸭子类型），所以下面手写的
// 纯 JSON 形状完全够用 —— 不需要 `schemastery` 依赖。
//
// 几个必须遵守的细节（对着 `dsh-settings/lib/index.js` 抄的）：
//
// 1. **每一个节点**都要带 `toJSON()`，不只是根节点：`plainSchema()` 第一步就是
//    `new z(schema.toJSON())`，对子节点也会调用。
// 2. `toJSON()` 必须返回**纯 JSON**（不能带函数），因为结果会被再序列化一次。
// 3. 叶子要标 `meta.volatile = true`，否则 `volatileForm()` 会把整条设置项吞掉
//    （静默消失、不报错，最难查）。
// 4. 普通标量字段**只标叶子、不标中间对象**：中间对象保持 `meta: {}`，
//    `volatileForm()` 会逐键筛。唯一的例外是 `projects`（见 `buildProjectsDescriptor`）：
//    它是一个整体可写的结构，所以那一个节点自己标 volatile。
// 5. 面板需要的元信息全放 `meta` 里（`label` / `description` / `default` /
//    `min` / `max` / `enum`）——实测这些自定义键能原样穿过 schemastery 重建。
// 6. `toJSON()` 返回的必须是 **schemastery 信封** `{ uid, refs }`：`refs` 里
//    `dict` / `inner` / `list` 的值是 **uid 数字**（引用），不是内联对象。
//    宿主和浏览器都做 `new z(...)` 重建；内联的 `inner` 在重建后会变成
//    `undefined`，数组字段一校验就抛
//    `Cannot read properties of undefined (reading 'meta')`，
//    再被浏览器端 `catch` 静默吞掉 ⇒ 面板永远停在 loading。

/**
 * 给 descriptor 树造一个 **schemastery 线上格式的信封**。
 *
 * 宿主 `dsh-settings` 和浏览器读 schema 用的是同一套格式：`{ uid, refs }`，
 * `refs` 里每个节点一条记录，`dict` / `inner` / `list` 的值是 **uid 数字**
 * （指向别的记录），不是内联对象。重建方（`new z(envelope)`）靠这些引用把
 * `inner` 换成真正的子 schema；引用断了，数组字段就会在
 * `inner.meta` 上炸掉。
 *
 * uid 按 **先序遍历** 确定性编号：同一棵树每次都得到同一个信封。宿主
 * `describe()` 用 `JSON.stringify(schema.toJSON())` 算 revision，uid 抖动
 * 会让 revision 一直涨（写设置时每回都撞上 `SETTINGS_CONFLICT`）。
 *
 * @param {any} root 子树根节点
 * @returns {{ uid: number, refs: Record<string, any> }}
 */
function descriptorEnvelope (root) {
  /** @type {Record<string, any>} */
  const refs = {}
  /** @type {Map<any, number>} */
  const uids = new Map()
  let next = 0

  const visit = (node) => {
    const known = uids.get(node)
    if (known !== undefined) return known
    const uid = ++next
    uids.set(node, uid)
    /** @type {any} */
    const entry = { type: node.type, meta: { ...(node.meta ?? {}) } }
    refs[String(uid)] = entry
    if (node.dict) {
      /** @type {Record<string, number>} */
      const dict = {}
      for (const [key, child] of Object.entries(node.dict)) dict[key] = visit(child)
      entry.dict = dict
    }
    if (node.inner) entry.inner = visit(node.inner)
    return uid
  }

  const uid = visit(root)
  return { uid, refs }
}

/**
 * 把 descriptor 节点转成可递归 `toJSON()` 的普通对象。
 *
 * `toJSON()` 产出的是**信封**（见 `descriptorEnvelope`），不是节点自己的
 * 形状 —— 宿主和浏览器都按信封重建，内联的子节点会被丢掉。
 *
 * @param {any} node
 * @returns {any}
 */
function descriptorNode (node) {
  /** @type {any} */
  const out = { type: node.type, meta: { ...(node.meta ?? {}) } }
  if (node.inner) out.inner = descriptorNode(node.inner)
  if (node.dict) out.dict = Object.fromEntries(Object.entries(node.dict).map(([key, child]) => [key, descriptorNode(child)]))
  out.toJSON = function toJSON () {
    return descriptorEnvelope(out)
  }
  return out
}

/**
 * 把一项 `CONFIG_FIELDS` 声明变成 descriptor 叶子。
 *
 * `label` / `group` 不进 `CONFIG_FIELDS`（那是校验用的表，改动它会影响
 * `validateConfig` 与 `describeConfig`），而是由 `CONFIG_GROUPS` 派生后塞进
 * `meta` —— 浏览器 bundle 只拿得到 schema 树，分组信息只能从 meta 走。
 *
 * @param {ConfigField} field
 * @param {string} label
 * @param {string} group
 */
function descriptorLeaf (field, label, group) {
  /** @type {Record<string, unknown>} */
  const meta = {
    volatile: true,
    label,
    group,
    description: field.description,
  }
  if (field.default !== undefined) meta.default = field.default
  if (field.min !== undefined) meta.min = field.min
  if (field.max !== undefined) meta.max = field.max
  if (field.enum !== undefined) meta.enum = [...field.enum]

  if (field.type === 'string-array') {
    return descriptorNode({ type: 'array', meta, inner: { type: 'string', meta: {} } })
  }
  if (field.type === 'boolean') return descriptorNode({ type: 'boolean', meta })
  if (field.type === 'number' || field.type === 'integer') return descriptorNode({ type: 'number', meta })
  return descriptorNode({ type: 'string', meta })
}

/**
 * `projects[]` 的字段在面板上归到这一组。
 *
 * 它不在 `CONFIG_GROUPS` 里 —— 那张表只描述 `CONFIG_FIELDS` 的 33 个标量键，
 * 硬塞进去会让 `assertGroupCoverage()` 与「三方向一致」的断言都失准。面板
 * 自己按 `PROJECT_SECTIONS` 分区渲染项目卡片，这个 label 只是给
 * descriptor 的叶子一个说得清来源的 group 名。
 */
const PROJECT_GROUP_LABEL = '项目清单'

/**
 * 造一个项目字段叶子（`projects[]` 内部用）。
 *
 * 与 `descriptorLeaf` 分开是因为这里没有 `CONFIG_FIELDS` 声明可查：
 * `projects` 是结构化数组，字段形状由 `validateProject()` 决定。
 *
 * @param {'string'|'boolean'|'string-array'} type
 * @param {string} label
 * @param {string} description
 * @param {Record<string, unknown>} [extra]
 * @returns {any}
 */
function projectLeaf (type, label, description, extra = {}) {
  /** @type {Record<string, unknown>} */
  const meta = { volatile: true, label, group: PROJECT_GROUP_LABEL, description, ...extra }
  if (type === 'string-array') return descriptorNode({ type: 'array', meta, inner: { type: 'string', meta: {} } })
  if (type === 'boolean') return descriptorNode({ type: 'boolean', meta })
  return descriptorNode({ type: 'string', meta })
}

/**
 * 造 `projects` 节点后面的那个元素节点（object）。
 *
 * `dict` 必须覆盖 `validateProject()` 能接受的全部键：宿主写的是**深层路径**
 * （`['projects','0','repo','path']`），`applyPathOp()` 中途靠
 * `node.dict[head]` 往下找节点，少一个键就在那一段丢类型信息（更糟的是
 * 面板那边会显示「这个字段改不了」）。
 *
 * @param {Record<string, any>} dict
 * @param {Record<string, unknown>} [meta]
 * @returns {any}
 */
function projectObject (dict, meta = {}) {
  return descriptorNode({ type: 'object', meta, dict })
}

/**
 * 由 `validateProject()` 接受的形状造出 `projects` 的 descriptor 节点。
 *
 * ## 为什么这个节点必须自己标 `meta.volatile`
 *
 * 宿主的 `isVolatilePath(schema, path)` 只沿 `schema.dict` 下钻，**完全不认
 * `inner`**：
 *
 * ```js
 * function isVolatilePath(schema, path) {
 *   if (schema.meta.volatile) return true
 *   const [key, ...rest] = path
 *   const child = key === void 0 ? void 0 : schema.dict?.[key]
 *   return child !== void 0 && isVolatilePath(child, rest)
 * }
 * ```
 *
 * 而 `projects` 是数组：`['projects','0','repo','path']` 的 `'0'` 那一段只能
 * 从 `inner` 走。所以把 volatile 标在**数组节点自己**身上 —— `isVolatilePath`
 * 在第一步就短路返回 true，`write()` 的路径校验与 `validatePaths()` 都放行。
 *
 * ## 为什么子节点也标 volatile
 *
 * 宿主当前版本不检查（上游一个 volatile 就短路了），但 `scripts/client-check.mjs`
 * 的 `auditProjectsNode()` 会逐层查：将来宿主如果改成「沿途每段都要声明」，
 * 这里已经是对的，不用回头再补一遍。多标不改变 `volatileForm()` 的行为
 * （它遇到 volatile 就直接 `plainSchema` 整棵子树）。
 *
 * ## 为什么整数组替换是被禁止的
 *
 * `mutate` 只发改动字段的深层路径，绝不发 `path: ['projects']` —— 整块替换会把
 * 别的项目条目、以及配置文件里手写的 `appToken` 一起抹掉。这条约束写在
 * `lib/client.js` 的 `collectOps()` 里，这里只保证深层路径写得进去。
 *
 * @returns {any}
 */
function buildProjectsDescriptor () {
  const matchNode = projectObject({
    platform: projectLeaf('string', '平台', '决定用哪个 ticket-source 适配器收票', { enum: [...PLATFORMS] }),
    appToken: projectLeaf('string', '飞书 appToken', '飞书多维表格的 app_token（显式绑定）。面板不显示明文，改用「粘贴工单表链接」写入（宿主解析、明文不回浏览器）'),
    tableId: projectLeaf('string', '工单表 tableId', '飞书多维表格的 table id；与 appToken 一起构成显式绑定'),
    viewId: projectLeaf('string', '视图 viewId', '可选：只扫某个视图'),
    docNamePattern: projectLeaf('string', '表名匹配', '没有显式 appToken/tableId 时，按文件名模糊匹配工单表'),
    statusValues: projectLeaf('string-array', '在处理中的状态值', '状态列取这些值时才算「在处理中」，是收票条件'),
    recordIds: projectLeaf('string-array', '只处理这些工单', '收窄到指定 record id；留空表示整张表'),
    allowedImageHosts: projectLeaf('string-array', '允许的截图主机', '截图链接来自工单表（外部输入），不在白名单里的一律拒绝'),
    sheetUrl: projectLeaf('string', '表格链接', '金山文档表格的分享链接（wps 平台）'),
    sheetName: projectLeaf('string', '工作表名', '金山文档里的工作表名（wps 平台）；飞书电子表格也用它指定工作表'),
    statusColumn: projectLeaf('string', '状态列名', '「是否处理」列名（wps 平台）'),
    statusValue: projectLeaf('string', '在处理中的取值', 'wps 平台单值形态；飞书用 statusValues'),
    mediaPrefix: projectLeaf('string', '附件前缀', '截图 fileToken 的前缀（wps 平台）'),
    // —— 飞书电子表格（ADR-0005：不新增 platform，表型在适配器内部判定）——
    // 这几个键只在「表是电子表格」时有意义；配了但表是多维表格会被忽略，不报错。
    spreadsheetToken: projectLeaf('string', '飞书电子表格 token', '飞书电子表格的链接或 token（shtcn…）；面板不画凭据但画它，贴整条链接就行'),
    sheetId: projectLeaf('string', '工作表 id', '电子表格里的工作表 id（sh…）；不知道就留空并填工作表名'),
    sheetHeaderRow: projectLeaf('number', '表头在第几行', '缺省 1。表头上方还有标题行时改成实际行号（不会自动往下找）'),
    sheetIdentity: projectLeaf('string', '行身份', '缺省 seq（按序号列，序号重复会报错）；row（按物理行号，插行会换身份）', { enum: ['seq', 'row'] }),
    sheetIdColumn: projectLeaf('string', '序号列名', '缺省「序号」。取这一列的值当工单身份，空值退回行号'),
    sheetRange: projectLeaf('string', '读取范围', '可选，如 A1:M500；不填则从表头读到 Z 列末尾'),
    sheetColumns: projectLeaf('string', '列名覆盖', '可选，JSON 形态 {"description":"你的列名"}；表头叫法不一样时用它'),
    columns: projectLeaf('string', '列名覆盖（多维表格）', '可选，JSON 形态 {"description":"你的字段名"}；多维表格字段叫法不一样时用它（电子表格用上面那个键）'),
    tableKind: projectLeaf('string', '强制表型', '可选，bitable/sheet；不填则按 token 自动探测', { enum: ['', 'bitable', 'sheet'] }),
  }, { label: '工单表绑定' })

  const gitlabNode = projectObject({
    enabled: projectLeaf('boolean', '开 draft MR', '关掉只做本地提交，不需要 GITLAB_TOKEN'),
    baseUrl: projectLeaf('string', 'GitLab 站点', '自建站点或子组路径时用它'),
    remote: projectLeaf('string', 'GitLab remote', '仓库 remote 的 URL，用于推导 projectId'),
    projectId: projectLeaf('string', 'GitLab projectId', '数字 id 或 group/project 路径'),
  }, { label: 'GitLab 出口' })

  const repoNode = projectObject({
    path: projectLeaf('string', '仓库路径', '本地 git 检出根目录，绝对路径或相对 DSH 工作目录'),
    remote: projectLeaf('string', 'GitLab 仓库地址', '仓库 URL，用于推导 baseUrl 与 projectId；不是 git 远端名'),
    baseBranch: projectLeaf('string', '基准分支', '从哪条分支切出工作分支'),
    targetBranch: projectLeaf('string', '目标分支', 'MR 的目标分支'),
    gitlab: gitlabNode,
  }, { label: '仓库' })

  const verifyNode = projectObject({
    build: projectLeaf('string', '构建命令', '留空跳过构建'),
    test: projectLeaf('string', '验证命令', '留空跳过验证'),
  }, { label: '验证命令' })

  const entry = projectObject({
    name: projectLeaf('string', '项目名', 'projectId，必须唯一；工单里的项目要靠它对上仓库'),
    description: projectLeaf('string', '说明', '会进 agent 的定位提示'),
    match: matchNode,
    repo: repoNode,
    verify: verifyNode,
  }, { volatile: true, label: '项目条目', group: PROJECT_GROUP_LABEL })

  return descriptorNode({
    type: 'array',
    meta: {
      volatile: true,
      label: '项目清单',
      group: PROJECT_GROUP_LABEL,
      description: '一个项目 = 一张工单表 + 一个仓库。面板只发改过字段的深层路径，不会整块替换。',
    },
    inner: entry,
  })
}

/**
 * 由 `CONFIG_FIELDS` 造出给设置面板用的 schema 树。
 *
 * 点号键（`pushplus.token`）按 `.` 逐层拆成嵌套 object，和配置的真实形状一致：
 * `{ pushplus: { token } }`。
 *
 * `projects` 单独造（`buildProjectsDescriptor`）：它不在 `CONFIG_FIELDS` 里
 * —— 那张表是**标量配置**的声明，`projects` 是结构化数组，由
 * `validateProjects()` 单独校验。但设置面板要能编辑它，就得进 descriptor，
 * 所以这里挂上去。
 */
function buildConfigDescriptor () {
  /** @type {any} */
  const root = descriptorNode({ type: 'object', meta: {}, dict: {} })

  for (const [key, field] of Object.entries(CONFIG_FIELDS)) {
    const presentation = FIELD_PRESENTATION[key]
    const label = presentation?.label ?? key
    const group = presentation?.group ?? FALLBACK_GROUP_LABEL
    /** @type {any} */
    const leaf = descriptorLeaf(field, label, group)

    const parts = key.split('.')
    let cursor = root
    for (const part of parts.slice(0, -1)) {
      cursor.dict[part] ??= descriptorNode({ type: 'object', meta: {}, dict: {} })
      cursor = cursor.dict[part]
    }
    const last = parts[parts.length - 1]
    if (last !== undefined) cursor.dict[last] = leaf
  }

  root.dict.projects = buildProjectsDescriptor()

  return root
}

/**
 * `projects` 子树的字段路径清单（去掉 `projects[i].` 前缀）。
 *
 * 给自测与面板对账用：面板手抄的字段表必须能在这个集合里逐项找到，缺一项
 * 的后果是「那个字段在界面上根本改不了」或者「保存被宿主拒」。
 *
 * @returns {string[]}
 */
export function listProjectDescriptorPaths () {
  /** @type {any} */
  const projects = getConfigDescriptor().dict.projects
  /** @type {string[]} */
  const out = []
  /** @param {any} node @param {string[]} path */
  const visit = (node, path) => {
    if (node === undefined || node === null) return
    if (node.dict) {
      for (const [key, child] of Object.entries(node.dict)) visit(child, path.concat([key]))
      return
    }
    out.push(path.join('.'))
  }
  visit(projects?.inner, [])
  return out
}

/** 设置面板用的 schema 树（惰性造一次，被 `Config` 与自测共用）。 */
let configDescriptor = null

/** @returns {any} */
export function getConfigDescriptor () {
  if (configDescriptor === null) configDescriptor = buildConfigDescriptor()
  return configDescriptor
}

/**
 * `Config`：既是 cordis 校验用的 standard-schema，又是设置面板用的 descriptor 树。
 *
 * 两件事必须同时成立：
 *
 * 1. `'~standard'.validate` **同步**返回 `{ value } | { issues }` —— cordis 的
 *    `resolveConfig` 只认这个（异步会抛 `Async config validation is not supported`）。
 * 2. `type` / `meta` / `dict` / `toJSON()` 都在**根节点上** —— `dsh-settings` 是把
 *    `Config` 本身当 schema 传给 `volatileForm()` 的，只挂 `toJSON` 不够。
 *
 * `vendor` 故意写本插件名而不是 `schemastery`：`isSchemastery()` 严格比较 vendor
 * 字符串，冒充 schemastery 会让 loader 去取它没有的元数据，然后设置面板静默变空。
 * 代价是 loader 不认「volatile 字段热更新」，改配置会重启插件实例 —— 对这个插件
 * 无所谓（改的本来就是轮询间隔、凭据这类启动期参数）。
 */
export const Config = Object.assign(getConfigDescriptor(), {
  '~standard': {
    version: 1,
    vendor: 'ticket-pipeline',
    validate: (value) => validateConfig(value),
  },
})

/** 给离线自测与工具输出用：把校验后的配置里的敏感项打码。 */
export function describeConfig (config) {
  const describe = {}
  for (const path of Object.keys(CONFIG_FIELDS)) {
    const parts = path.split('.')
    let cursor = config
    for (const part of parts) cursor = cursor?.[part]
    const secret = /token|secret|password/i.test(path)
    describe[path] = secret && typeof cursor === 'string' && cursor.length > 0 ? '***(已配置)' : cursor
  }

  // projects[] 打码：match 里的 token 类字段遮住，其余保留
  describe.projects = (Array.isArray(config?.projects) ? config.projects : []).map((p) => {
    /** @type {any} */
    const out = { name: p?.name, match: { platform: p?.match?.platform } }
    if (p?.description) out.description = p.description
    const match = p?.match ?? {}
    if (typeof match.appToken === 'string' && match.appToken.length > 0) out.match.appToken = '***(已配置)'
    if (typeof match.tableId === 'string' && match.tableId.length > 0) out.match.tableId = match.tableId
    if (typeof match.viewId === 'string' && match.viewId.length > 0) out.match.viewId = match.viewId
    if (typeof match.docNamePattern === 'string' && match.docNamePattern.length > 0) out.match.docNamePattern = match.docNamePattern
    // 状态值集合要透出来：排障时先看「到底按哪些值收票」，再看别的。
    if (Array.isArray(match.statusValues) && match.statusValues.length > 0) out.match.statusValues = match.statusValues
    // 收窄名单同样要透出来：排障时先确认「这一轮到底在处理哪几张票」。
    if (Array.isArray(match.recordIds) && match.recordIds.length > 0) out.match.recordIds = match.recordIds
    // 白名单必须透出来：截图取不到时，第一个要确认的就是「这个域名到底放行了没有」。
    if (Array.isArray(match.allowedImageHosts) && match.allowedImageHosts.length > 0) out.match.allowedImageHosts = match.allowedImageHosts
    // 金山文档的定位字段（非敏感，直接给）
    for (const key of ['sheetUrl', 'sheetName', 'statusColumn', 'statusValue', 'mediaPrefix']) {
      if (typeof match[key] === 'string' && match[key].length > 0) out.match[key] = match[key]
    }
    out.repo = p?.repo ?? {}
    out.verify = p?.verify ?? {}
    return out
  })

  return describe
}
