/**
 * `remote/descriptors.js` —— 自建 typert Remote 的纯 JSON 描述符。
 *
 * 这个文件**不 import 任何宿主包**，所以宿主侧（注册）和浏览器侧（`$mount`）
 * 可以共用同一份描述符，不需要 codegen。
 *
 * 形状对着 `dsh-typert-registry` 的校验规则写（`validateInvocation`）：
 *
 * - `id` = `<包名>#<namespace>/<method>`
 * - `service` 与 `namespace` 同名，且必须是 `ctx.provide()` 的键
 * - 每个 codec 必须 `mode: 'strict'` 且带 `typeSymbol` + `create()`
 * - 只有 `{ kind: 'direct' }` 这一种 invocation（另一种是 stream）
 * - 每个参数也要有 `codec`（strict + `typeSymbol` + `create()`），
 *   `source: 'json'` 表示走 JSON 线；可选参数加 `acceptsUndefined: true`
 *
 * 为什么大多数方法没有参数：体检、读配置、读项目清单、读分支清单都是「点一下就出结果」，
 * 不需要入参；少一个参数就少一条 `assertExactArguments` 能炸的路。
 *
 * `branches()` 也刻意不带 `repoPath` 入参：面板按下拉框时手上正好有一整份项目清单，
 * 一次取回全部项目的分支比「每个项目各发一次」少一整类竞态（面板重绘时会重复发）。
 *
 * ## 唯一带参的方法：`setProjectTable(index, url)`
 *
 * 为什么它必须带参、且**必须由宿主解析**：
 * `match.appToken` 是「能换出 access token 的串」，所以宿主从来不下发明文
 * （`describeProject()` 只给 `hasAppToken` + 首尾几位）。但这也让面板无法新增
 * 一个飞书项目 —— 以前只能手改 `cordis.patch.yml`。
 *
 * 解法不是把 appToken 变成明文输入框，而是让浏览器只交出**用户粘贴的那条链接**：
 * 解析在宿主进程里做，明文从头到尾没进过浏览器，落盘的也只有一个字段。
 * 这条边界写在 `lib/client.js` 的 appToken 只读行与 `host.js` 的 `setProjectTable()` 里，
 * 三处口径必须一致 —— 改一处就回来对另外两处。
 */

/** 远程命名空间名 = `ctx.provide()` 的键 = descriptor 里的 namespace。 */
export const TICKET_PIPELINE_NAMESPACE = 'ticketPipeline'

/**
 * 造一个 strict codec。`parse` 在边界上做一次校验，抛错会被网关包成
 * `gateway/input-invalid`（入参）或原样透传（返回值）。
 *
 * @param {string} name 类型名（同一命名空间内唯一即可）
 * @param {(value: unknown) => unknown} parse
 */
function codec (name, parse) {
  const strict = {
    mode: 'strict',
    typeSymbol: `ticket-pipeline#${name}`,
    create: () => ({ parse }),
    jsonSchema: {},
  }
  return strict
}

/**
 * 造一个参数描述符。
 *
 * 为什么 `codec` 与 `strictCodec` 都给：宿主生成的贡献物里两个字段都在
 * （见 `dsh-api-settings-controller` 的 `typert.remote-client.js`），
 * 网关只读 `codec`，但 `client-check` 与将来的校验可能读另一个 —— 给两份不会错。
 *
 * @param {string} method 所属方法名（用于 typeSymbol 前缀，便于定位）
 * @param {string} name 参数名（同时也是 wire 名）
 * @param {string} description
 * @param {(value: unknown) => unknown} parse
 * @param {boolean} [optional]
 */
function parameter (method, name, description, parse, optional = false) {
  const symbol = `ticket-pipeline#${TICKET_PIPELINE_NAMESPACE}/${method}:${name}`
  const strict = {
    mode: 'strict',
    typeSymbol: symbol,
    create: () => ({ parse }),
    jsonSchema: {},
  }
  return {
    name,
    wire: name,
    description,
    source: 'json',
    ...(optional ? { acceptsUndefined: true } : {}),
    codec: strict,
    strictCodec: strict,
  }
}

/** 体检报告：原样透传（结构由 `runDoctor()` 保证）。 */
const doctorReport = codec('DoctorReport', (value) => value)

/** 配置快照：原样透传（`describeConfig()` 已经打过码）。 */
const configSnapshot = codec('ConfigSnapshot', (value) => value)

/** 项目清单：原样透传（`describeProject()` 已经把 appToken 收成摘要）。 */
const projectList = codec('ProjectList', (value) => value)

/** 分支清单：原样透传（`listBranches()` 已经把 git 输出解析成纯字符串数组）。 */
const branchList = codec('BranchList', (value) => value)

/** 「粘贴链接」的结果：写完之后的那条项目记录（已打码）+ 一句人话。 */
const projectWriteResult = codec('ProjectWriteResult', (value) => value)

/**
 * 运行页签读的状态快照（工单 #16）：与 `pipeline_status` 的返回体**同一份**，
 * 因为宿主那边调的就是 `collectStatus()`，不是另写一遍。
 */
const pipelineStatusSnapshot = codec('PipelineStatus', (value) => value)

/** 跑一轮的结果：与 `pipeline_scan` 返回体同形（`status` 只有 triggered / disabled / already-running）。 */
const scanResult = codec('ScanResult', (value) => value)

/** 取消的结果：`{ cancelled, text }`，空闲时 `cancelled:false` 不是错误。 */
const cancelResult = codec('CancelResult', (value) => value)

/** 重开的结果：与 `pipeline_reset` 同形（`reset` + `reason` + `text`）。 */
const resetResult = codec('ResetResult', (value) => value)

/** 一个非空字符串参数。 */
function requiredString (method, name, description) {
  return parameter(method, name, description, (value) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TypeError(`${method}: ${name} 必须是非空字符串`)
    }
    return value
  })
}

/**
 * 一个非负整数参数。
 *
 * 收字符串也收数字：面板里传的是数字，但人手动在别处调这个方法时给 `'0'` 也该能用。
 * 归一成数字再往下走，免得宿主里出现 `'0'` 与 `0` 两种下标。
 */
function requiredIndex (method, name, description) {
  return parameter(method, name, description, (value) => {
    const number = typeof value === 'number' ? value : Number(String(value).trim())
    if (!Number.isInteger(number) || number < 0) {
      throw new TypeError(`${method}: ${name} 必须是 ≥0 的整数`)
    }
    return number
  })
}

/**
 * 一个无参 direct 方法。
 * @param {string} method
 */
function method (method) {
  /** @type {any} */
  let result = configSnapshot
  if (method === 'doctor') result = doctorReport
  if (method === 'projects') result = projectList
  if (method === 'branches') result = branchList
  // 运行页签（#16）的三个动作。result 必须按名字分派，否则它们会全部拿到
  // ConfigSnapshot 的 typeSymbol —— 网关按 codec 校验返回值，类型名不对就白挂。
  if (method === 'status') result = pipelineStatusSnapshot
  if (method === 'scan') result = scanResult
  if (method === 'cancel') result = cancelResult
  return {
    id: `ticket-pipeline#${TICKET_PIPELINE_NAMESPACE}/${method}`,
    service: TICKET_PIPELINE_NAMESPACE,
    namespace: TICKET_PIPELINE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    result,
    parameters: [],
  }
}

/**
 * 面板「粘贴工单表链接」：`setProjectTable(index, url)`。
 *
 * 两个参数都是必填：`index` 是要写哪一个项目（面板按 `projects()` 的返回顺序），
 * `url` 是用户粘的那条链接（也接受裸 token）。解析在宿主做，见 `host.js`。
 */
function setProjectTable () {
  return {
    id: `ticket-pipeline#${TICKET_PIPELINE_NAMESPACE}/setProjectTable`,
    service: TICKET_PIPELINE_NAMESPACE,
    namespace: TICKET_PIPELINE_NAMESPACE,
    method: 'setProjectTable',
    invocation: { kind: 'direct' },
    result: projectWriteResult,
    parameters: [
      requiredIndex('setProjectTable', 'index', 'projects[] 里的下标（从 0 开始），面板按 projects() 的顺序给'),
      requiredString('setProjectTable', 'url', '用户粘贴的整条飞书链接（多维表格 / wiki / 电子表格），或裸 token'),
    ],
  }
}

/**
 * 运行页签的 `status(includeDone?)`。
 *
 * 为什么要带一个参数：缺省只给「还要我做什么」（`includeDone: false`），
 * 票全跑完之后那一屏就是空的 —— 用户原话是「在哪里能查到历史的工单处理流程」。
 * 但也不能反过来缺省就带全部：票只增不删，跑上一个月以后开屏就要渲染几百行。
 * 所以做成面板上的一个「显示历史」开关，由人决定这一屏看哪一段。
 *
 * 参数可选：不传等于 `false`（与工具 `pipeline_status` 的 `includeDone` 同名同义）。
 */
function status () {
  return {
    id: `ticket-pipeline#${TICKET_PIPELINE_NAMESPACE}/status`,
    service: TICKET_PIPELINE_NAMESPACE,
    namespace: TICKET_PIPELINE_NAMESPACE,
    method: 'status',
    invocation: { kind: 'direct' },
    result: pipelineStatusSnapshot,
    parameters: [
      parameter('status', 'includeDone', '要不要连已收尾的票一起给（看历史用）；不传等于 false', (value) => {
        if (value === undefined) return undefined
        if (typeof value !== 'boolean') throw new TypeError('status: includeDone 必须是布尔值')
        return value
      }, true),
    ],
  }
}

/**
 * 面板「运行」页签的「重跑」按钮：`reset(recordId, projectId?)`。
 *
 * 与工具 `pipeline_reset` 的参数表一字不差 —— 少一个可选参数，
 * 「同名 recordId 撞车」时面板就没法从两条里挑一条（工具里那条 `ambiguous` 分支会永远触发）。
 * `projectId` 是可选的：只有多项目撞同一个 record_id 时才需要补。
 */
function reset () {
  return {
    id: `ticket-pipeline#${TICKET_PIPELINE_NAMESPACE}/reset`,
    service: TICKET_PIPELINE_NAMESPACE,
    namespace: TICKET_PIPELINE_NAMESPACE,
    method: 'reset',
    invocation: { kind: 'direct' },
    result: resetResult,
    parameters: [
      requiredString('reset', 'recordId', '要重开的工单标识（飞书 record_id）'),
      parameter('reset', 'projectId', '工单所属项目名；只有同名 recordId 会冲突时才需要传', (value) => {
        if (value === undefined) return undefined
        if (typeof value !== 'string') throw new TypeError('reset: projectId 必须是字符串')
        return value
      }, true),
    ],
  }
}

/** 宿主与浏览器共用的方法表。 */
export const TICKET_PIPELINE_DESCRIPTORS = Object.freeze([
  method('doctor'),
  method('config'),
  method('projects'),
  method('branches'),
  setProjectTable(),
  // 运行页签（#16）：先 status 拉一屏，再 scan / cancel / reset 三个动作。
  status(),
  method('scan'),
  method('cancel'),
  reset(),
])

/**
 * 浏览器侧 `ctx.remote.$mount()` 要的贡献物。
 * `package` 必须等于本插件包名（与 `typert.register` 的 `package` 一致）。
 */
export const TICKET_PIPELINE_REMOTE = Object.freeze({
  package: '@local/ticket-pipeline',
  descriptors: TICKET_PIPELINE_DESCRIPTORS,
})
