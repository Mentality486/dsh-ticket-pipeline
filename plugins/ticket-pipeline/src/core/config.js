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
 * 代价：loader 的 `isSchemastery()` 判定为 false，设置面板拿不到 schemastery
 * 的结构化 diff（退化成整体替换）。校验、默认值、持久化都不受影响。
 * 这一点写在 README 的「已知约束」里，等以后能装依赖了再换成 schemastery。
 */

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
  // ── 扫描与队列 ──────────────────────────────────────
  pollIntervalMinutes: {
    type: 'number',
    default: 3,
    min: 1,
    max: 60,
    description: '轮询间隔（分钟）。飞书没有可靠的单元格变更事件，只能轮询',
  },
  safePageRun: {
    type: 'integer',
    default: 20,
    min: 5,
    max: 100,
    description: '连续扫到多少条已知且未变的记录后停止翻页',
  },
  goneAfterScans: {
    type: 'integer',
    default: 3,
    min: 1,
    max: 20,
    description: '连续几轮扫不到就认定该行已被删除',
  },
  concurrency: {
    type: 'integer',
    default: 1,
    min: 1,
    max: 1,
    description: '并发数。当前只支持 1：一轮最多跑一票',
  },

  // ── 租约与重试 ──────────────────────────────────────
  leaseTtlMinutes: {
    type: 'number',
    default: 10,
    min: 1,
    max: 60,
    description: '票级租约的存活时间（分钟），防止多进程抢同一张票',
  },
  leaseHeartbeatSeconds: {
    type: 'number',
    default: 60,
    min: 1,
    max: 1800,
    description:
      '租约心跳间隔（秒）：跑票期间每这么多秒续一次租。'
      + '必须显著小于 leaseTtlMinutes，否则长票会被别的进程抢走，'
      + '两边在同一个 worktree 上同时改代码。',
  },
  maxAttempts: {
    type: 'integer',
    default: 2,
    min: 1,
    max: 5,
    description: '可重试错误最多重试几次',
  },

  // ── 执行 ────────────────────────────────────────────
  workExecutor: {
    type: 'string',
    default: 'mock',
    description: '执行器 id（mock / agent）。agent 还没实现，先用 mock 跑通链路',
  },
  ticketTimeoutMinutes: {
    type: 'number',
    default: 40,
    min: 5,
    max: 180,
    description: '单票墙钟超时（分钟）',
  },
  fetchBeforeCreate: {
    type: 'boolean',
    default: true,
    description: '切 worktree 前先 git fetch 一次基准分支',
  },
  branchPrefix: {
    type: 'string',
    default: 'ticket-',
    description: '票分支名前缀；后接 <projectId>-<recordId>-r<修订号>',
  },
  worktreeRetentionHours: {
    type: 'number',
    default: 24,
    min: 0,
    max: 720,
    description: '终态票的 worktree 保留小时数；0 = 不自动清理',
  },

  // ── agent 与模型 ────────────────────────────────────
  provider: {
    type: 'string',
    default: 'workbuddy',
    description: '跑任务书的模型 provider，留空则跟随当前会话默认',
  },
  model: {
    type: 'string',
    default: 'deepseek-v4.1-flash',
    description: '跑任务书的模型名，留空则跟随当前会话默认',
  },
  maxTokens: {
    type: 'integer',
    default: 32000,
    min: 1024,
    max: 200000,
    description: '单次模型调用的最大输出 token',
  },

  // ── 通知 ────────────────────────────────────────────
  pushAdapter: {
    type: 'string',
    default: 'pushplus',
    description: '通知适配器 id（mock / pushplus / qqmail）',
  },
  'pushplus.token': {
    type: 'string',
    default: '',
    description: 'PushPlus token（建议走 ctx.credentials）',
  },
  'pushplus.channel': {
    type: 'string',
    default: 'clawbot',
    description: 'PushPlus 推送渠道，ClawBot 用 clawbot',
  },
  'pushplus.template': {
    type: 'string',
    default: 'txt',
    enum: ['txt'],
    description: '必须用 txt：富模板在 ClawBot 里只显示前 50 字',
  },
  // ── QQ 邮箱（SMTP）──
  // 密码是「授权码」，不是登录密码；不写进配置，走 ctx.credentials 的 QQMAIL_AUTH_CODE。
  'qqmail.host': {
    type: 'string',
    default: 'smtp.qq.com',
    description: 'QQ 邮箱 SMTP 主机（企业邮箱换成自己的）',
  },
  'qqmail.port': {
    type: 'number',
    default: 465,
    min: 1,
    max: 65535,
    description: 'SMTP 端口：465 = TLS 直连（推荐），587 = STARTTLS',
  },
  'qqmail.secure': {
    type: 'boolean',
    default: true,
    description: 'true = 连上就是 TLS（465）；false = 先明文 EHLO 再 STARTTLS（587）',
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

  'pushplus.callbackUrl': {
    type: 'string',
    default: '',
    description:
      '送达回执地址（可选）。PushPlus 把 sendStatus 回吐到这个地址：'
      + '0=未发 / 1=发送中 / 2=成功 / 3=失败。'
      + 'HTTP 200 只代表受理，不代表送达 —— 想知道「人真收到了」要配这个。',
  },
  notifyOn: {
    type: 'string-array',
    default: ['done', 'skipped', 'failed', 'needs-info'],
    description: '哪些 phase 要给发通知',
  },

  // ── 杂项 ────────────────────────────────────────────
  enabled: {
    type: 'boolean',
    default: false,
    description: '总开关。默认关：插件装上不会自动开始扫表、建工作区、开 MR',
  },
  logLevel: {
    type: 'string',
    default: 'info',
    enum: ['debug', 'info', 'warn', 'error'],
    description: '日志级别',
  },
})

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
 * @type {readonly string[]}
 */
export const PLATFORMS = Object.freeze(['feishu', 'wps', 'mock'])

/** 报错文案用的平台清单（「只能是 a / b / c」），从表里拼出来，免得两处各写一遍。 */
const PLATFORM_HINT = PLATFORMS.join(' / ')

/**
 * 校验平台，返回规范后的平台名或 undefined。
 *
 * 不传时退到 `mock`：老配置里没有 `match.platform`，以前一律按 mock 跑；
 * 现在照样能跑，但不给默认值的话「漏写平台」会被当成「写错平台」而拒绝启动。
 *
 * @param {unknown} platform
 * @returns {string | undefined}
 */
function normalizePlatform (platform) {
  const value = platform === undefined || platform === null || platform === '' ? 'mock' : platform
  return PLATFORMS.includes(/** @type {string} */ (value)) ? /** @type {string} */ (value) : undefined
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
  const fail = (path, message) => issues.push({ message: `projects[${index}].${path} ${message}`, path: ['projects', String(index), ...path.split('.')] })

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ message: `projects[${index}] 必须是对象`, path: ['projects', String(index)] }] }
  }
  /** @type {any} */
  const p = raw

  const name = typeof p.name === 'string' ? p.name.trim() : ''
  if (name.length === 0) fail('name', '必须是非空字符串')

  const match = p.match && typeof p.match === 'object' && !Array.isArray(p.match) ? p.match : {}
  const platform = normalizePlatform(match.platform)
  if (!platform) fail('match.platform', `只能是 ${PLATFORM_HINT}`)

  const repo = p.repo && typeof p.repo === 'object' && !Array.isArray(p.repo) ? p.repo : {}
  const repoPath = typeof repo.path === 'string' ? repo.path.trim() : ''
  if (repoPath.length === 0) fail('repo.path', '必须是非空字符串（本地 git 检出根目录）')

  // feishu 要么显式绑定（appToken+tableId），要么用文件名模糊匹配
  if (platform === 'feishu') {
    const hasExplicit = typeof match.appToken === 'string' && match.appToken.length > 0 &&
      typeof match.tableId === 'string' && match.tableId.length > 0
    const hasPattern = typeof match.docNamePattern === 'string' && match.docNamePattern.length > 0
    if (!hasExplicit && !hasPattern) {
      fail('match', 'feishu 项目必须给 appToken+tableId（显式绑定）或 docNamePattern（文件名模糊匹配）二选一')
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

  if (typeof repo.remote === 'string' && repo.remote.length > 0) value.repo.remote = repo.remote
  if (typeof repo.baseBranch === 'string' && repo.baseBranch.length > 0) value.repo.baseBranch = repo.baseBranch
  if (typeof repo.targetBranch === 'string' && repo.targetBranch.length > 0) value.repo.targetBranch = repo.targetBranch

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
 * 校验并补默认值。
 *
 * @param {unknown} raw
 * @returns {{ value?: Record<string, unknown>, issues?: Array<{ message: string, path?: string[] }> }}
 */
export function validateConfig (raw) {
  const input = raw === undefined || raw === null ? {} : raw
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { issues: [{ message: '配置必须是一个对象', path: [] }] }
  }

  /** @type {Record<string, unknown>} */
  const flat = {}
  flatten(input, '', flat)

  /** @type {Array<{ message: string, path?: string[] }>} */
  const issues = []
  /** @type {Record<string, unknown>} */
  const nested = {}

  for (const [path, field] of Object.entries(CONFIG_FIELDS)) {
    const present = Object.prototype.hasOwnProperty.call(flat, path)
    const value = present ? flat[path] : field.default
    const fail = (message) => issues.push({ message: `${path} ${message}`, path: path.split('.') })

    switch (field.type) {
      case 'string': {
        if (typeof value !== 'string') { fail('必须是字符串'); break }
        if (field.enum && !field.enum.includes(value)) { fail(`只能是 ${field.enum.join(' / ')}`); break }
        assignPath(nested, path, value)
        break
      }
      case 'number':
      case 'integer': {
        if (typeof value !== 'number' || Number.isNaN(value)) { fail('必须是数字'); break }
        if (field.type === 'integer' && !Number.isInteger(value)) { fail('必须是整数'); break }
        if (field.min !== undefined && value < field.min) { fail(`不能小于 ${field.min}`); break }
        if (field.max !== undefined && value > field.max) { fail(`不能大于 ${field.max}`); break }
        assignPath(nested, path, value)
        break
      }
      case 'boolean': {
        if (typeof value !== 'boolean') { fail('必须是布尔值'); break }
        assignPath(nested, path, value)
        break
      }
      case 'string-array': {
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
          fail('必须是字符串数组')
          break
        }
        assignPath(nested, path, [...value])
        break
      }
      default:
        fail(`未知的配置类型 ${field.type}`)
    }
  }

  // projects[] 单独校验
  const projects = validateProjects(input.projects)
  if (projects.issues && projects.issues.length > 0) {
    issues.push(...projects.issues)
  } else {
    nested.projects = projects.value
  }

  if (issues.length > 0) return { issues }
  return { value: nested }
}

/**
 * standard-schema 形状的 `Config`，直接给 cordis 的 `resolveConfig` 用。
 *
 * `version: 1` 与 `vendor` 是规范要求的标识；`vendor` 故意写本插件名而不是
 * `schemastery`，免得 loader 误判成 schemastery 后去取它没有的元数据。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'ticket-pipeline',
    validate: (value) => validateConfig(value),
  },
}

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
    out.repo = p?.repo ?? {}
    out.verify = p?.verify ?? {}
    return out
  })

  return describe
}
