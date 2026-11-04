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
 *
 * 为什么这些方法没有参数：体检与读配置都是「点一下就出结果」，不需要入参；
 * 少一个参数就少一条 `assertExactArguments` 能炸的路。
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
  return {
    mode: 'strict',
    typeSymbol: `ticket-pipeline#${name}`,
    create: () => ({ parse }),
  }
}

/** 体检报告：原样透传（结构由 `runDoctor()` 保证）。 */
const doctorReport = codec('DoctorReport', (value) => value)

/** 配置快照：原样透传（`describeConfig()` 已经打过码）。 */
const configSnapshot = codec('ConfigSnapshot', (value) => value)

/**
 * 一个无参 direct 方法。
 * @param {string} method
 */
function method (method) {
  return {
    id: `ticket-pipeline#${TICKET_PIPELINE_NAMESPACE}/${method}`,
    service: TICKET_PIPELINE_NAMESPACE,
    namespace: TICKET_PIPELINE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    result: method === 'doctor' ? doctorReport : configSnapshot,
    parameters: [],
  }
}

/** 宿主与浏览器共用的方法表。 */
export const TICKET_PIPELINE_DESCRIPTORS = Object.freeze([
  method('doctor'),
  method('config'),
])

/**
 * 浏览器侧 `ctx.remote.$mount()` 要的贡献物。
 * `package` 必须等于本插件包名（与 `typert.register` 的 `package` 一致）。
 */
export const TICKET_PIPELINE_REMOTE = Object.freeze({
  package: '@local/ticket-pipeline',
  descriptors: TICKET_PIPELINE_DESCRIPTORS,
})
