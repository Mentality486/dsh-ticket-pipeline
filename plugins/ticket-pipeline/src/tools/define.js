/**
 * `define.js` —— 本地的 `defineTool` 等价物。
 *
 * ## 为什么不 `import { defineTool } from '@deepseek-ai/dsh-tools'`
 *
 * `@deepseek-ai/dsh-tools` 是 DSH 自己的包，只存在于 profile 的
 * `node_modules` 里。本插件包没有（也不能）把它写进 `dependencies`：
 * 它是宿主提供的 peer 依赖，版本随 harness 走。
 *
 * 结果是：从 `plugins/ticket-pipeline/` 里顶层 `import` 它会
 * `ERR_MODULE_NOT_FOUND`，连 `node scripts/dev-run.mjs` 这种离线自测都跑不起来
 * （本机 `npm install` 也不可用，见 README「已知约束」）。
 *
 * ## 自己实现会不会少东西
 *
 * `defineTool` 做的三件事：
 * 1. 把 `parameters` 的简写 DSL 编译成 JSON Schema（`type:'object'` + `properties` + `required`）；
 * 2. 把 `output.schema` 也编译成 JSON Schema；
 * 3. 在 `execute` 外面包一层入参校验。
 *
 * `ctx.tools.register()` 只看编译后的结果（`output` 是不是对象、`render` 是不是函数、
 * `output.schema` 是不是支持的 JSON Schema、名字不能是保留的 `run_code`），
 * 它**不要求**对象必须由 `defineTool` 造出来。
 *
 * 所以这里实现同样三件事。支持的类型是 DSL 里常用那几种，
 * 够本插件的两个工具用；以后要加类型在这里加，别在工具文件里各写各的。
 */

/**
 * 一种参数声明。
 *
 * @typedef {Object} ParamSpec
 * @property {'string'|'number'|'integer'|'boolean'|'array'|'object'} type
 * @property {string} [description]
 * @property {boolean} [required]
 * @property {ParamSpec} [items] `type:'array'` 时的元素
 * @property {number} [min]
 * @property {number} [max]
 * @property {string[]} [enum]
 * @property {unknown} [default]
 * @property {Record<string, ParamSpec>} [properties] `type:'object'` 时的字段
 */

/**
 * 把参数 DSL 编译成 JSON Schema。
 *
 * `default` 只作为文档写进 schema，**不在校验期补值** —— 工具自己要有默认值逻辑，
 * 因为 JSON Schema 的 `default` 本来就不产生副作用。
 *
 * @param {ParamSpec} spec
 * @returns {Record<string, unknown>}
 */
function compileParam (spec) {
  /** @type {Record<string, unknown>} */
  const schema = { type: spec.type }

  if (spec.description) schema.description = spec.description
  if (spec.enum) schema.enum = [...spec.enum]
  // 注意：DSH 工具的 JSON Schema 子集**不支持** `minimum`/`maximum` 关键字
  // （tools.js 的 CONSTRAINT_KEYWORDS 只有 type/oneOf/properties/required/
  // additionalProperties/items/enum/const）。范围校验由下面 `assertArgs` 手工做。
  if (spec.type === 'array') {
    schema.items = spec.items ? compileParam(spec.items) : { type: 'string' }
  }
  if (spec.type === 'object' && spec.properties) {
    const properties = {}
    const required = []
    for (const [key, child] of Object.entries(spec.properties)) {
      properties[key] = compileParam(child)
      if (child.required) required.push(key)
    }
    schema.properties = properties
    if (required.length > 0) schema.required = required
    schema.additionalProperties = false
  }
  if (spec.default !== undefined) schema.default = spec.default

  return schema
}

/**
 * 把整个参数表编译成 JSON Schema。
 *
 * @param {Record<string, ParamSpec>} parameters
 * @returns {Record<string, unknown>}
 */
function compileParameters (parameters) {
  /** @type {Record<string, unknown>} */
  const properties = {}
  /** @type {string[]} */
  const required = []

  for (const [key, spec] of Object.entries(parameters ?? {})) {
    properties[key] = compileParam(spec)
    if (spec.required) required.push(key)
  }

  /** @type {Record<string, unknown>} */
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  schema.additionalProperties = false
  return schema
}

/**
 * 把收到的值写进错误文案。
 *
 * 只说「必须是数字」而不说收到的是什么，调用方（通常是模型）就不知道是自己传错了类型，
 * 还是参数名拼错了 —— 前者改类型，后者改名字，动作完全不同。
 *
 * @param {unknown} value
 */
function describeValue (value) {
  if (typeof value === 'string') return `字符串 "${value}"`
  if (Array.isArray(value)) return '数组'
  if (value === null) return 'null'
  return `${typeof value} ${String(value)}`
}

/**
 * 校验入参。抛出的错误会被 `ctx.tools` 的调用链当成工具参数错误处理。
 *
 * 只做「明显不对」的检查：必填缺失、类型不符、数字越界、枚举越界。
 * 不做嵌套深校验 —— 两个工具的参数都是一层。
 *
 * @param {string} toolName
 * @param {Record<string, ParamSpec>} parameters
 * @param {Record<string, unknown>} args
 */
function assertArgs (toolName, parameters, args) {
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    const value = args?.[key]
    const missing = value === undefined || value === null

    if (missing) {
      if (spec.required) throw new Error(`${toolName}: 缺少必填参数 ${key}`)
      continue
    }

    switch (spec.type) {
      case 'string':
        if (typeof value !== 'string') throw new Error(`${toolName}: ${key} 必须是字符串`)
        if (spec.enum && !spec.enum.includes(value)) throw new Error(`${toolName}: ${key} 只能是 ${spec.enum.join(' / ')}`)
        break
      case 'number':
        if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`${toolName}: ${key} 必须是数字（收到 ${describeValue(value)}）`)
        // 同样的越界文案在 integer 分支也要出现 —— 两个分支错开写，读的人就会以为是两套规则。
        if (spec.min !== undefined && value < spec.min) throw new Error(`${toolName}: ${key} 不能小于 ${spec.min}（收到 ${value}）`)
        if (spec.max !== undefined && value > spec.max) throw new Error(`${toolName}: ${key} 不能大于 ${spec.max}（收到 ${value}）`)
        break
      case 'integer':
        // 整数分支一开始只查了「是不是整数」，`min`/`max` 写了等于没写：
        // pipeline_status 把 limit 声明成 min 1 / max 100，传 1000 照样被放行，
        // 于是一个「只回 100 条」的承诺在工具层没有兑现，要到几十万行之后才被记住。
        // 下界必须和 number 分支一样严，不能只把「写错类型」拦住。
        if (!Number.isInteger(value)) throw new Error(`${toolName}: ${key} 必须是整数（收到 ${describeValue(value)}）`)
        if (spec.min !== undefined && value < spec.min) {
          throw new Error(`${toolName}: ${key} 不能小于 ${spec.min}（收到 ${value}）`)
        }
        if (spec.max !== undefined && value > spec.max) {
          throw new Error(`${toolName}: ${key} 不能大于 ${spec.max}（收到 ${value}）`)
        }
        break
      case 'boolean':
        if (typeof value !== 'boolean') throw new Error(`${toolName}: ${key} 必须是布尔值`)
        break
      case 'array':
        if (!Array.isArray(value)) throw new Error(`${toolName}: ${key} 必须是数组`)
        break
      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${toolName}: ${key} 必须是对象`)
        break
      default:
        break
    }
  }
}

/**
 * 深拷贝并丢掉值为 `undefined` 的键。
 *
 * 为什么必需：宿主的工具通道要求返回值是 **lossless JSON**。`undefined` 不是合法 JSON 值，
 * 只要返回值里任何一层藏着 `undefined`，整次工具调用在宿主那边直接失败，报
 * `tool "xxx" returned invalid output: value is not lossless JSON` ——
 * **人看到的是「工具坏了」，而工具本身跑得好好的**。
 *
 * 这不是假想问题：`pipeline_status` 的票行是手写投影（`lastError`/`testDetail` 这类
 * 可选字段在没失败、没跑测试时天然不存在），于是它长期在「有失败票」时报错、
 * 在「全是干净票」时又正常 —— 表现成随机坏。
 *
 * 修在这一层而不是每个工具里：任何工具的输出都会经过 `defineTool`，
 * 以后新加工具也不必记得这条规则。
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function stripUndefined (value) {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : stripUndefined(item)))
  if (value === null || typeof value !== 'object') return value
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    out[key] = stripUndefined(item)
  }
  return out
}

/**
 * 造一个工具定义，形状与 `defineTool` 的产物一致，可直接交给
 * `ctx.tools.register()`。
 *
 * @param {Object} options
 * @param {string} options.name
 * @param {string} options.description
 * @param {Record<string, ParamSpec>} [options.parameters]
 * @param {Record<string, unknown>} options.outputSchema 输出值的 JSON Schema
 * @param {(value: unknown) => Array<Record<string, unknown>>} options.render 把输出值渲染成内容块
 * @param {(args: Record<string, unknown>, exec: { signal?: AbortSignal }) => Promise<unknown>} options.execute
 * @param {number} [options.timeoutMs]
 * @returns {Record<string, unknown>}
 */
export function defineTool (options) {
  const {
    name,
    description,
    parameters = {},
    outputSchema,
    render,
    execute,
    timeoutMs,
  } = options

  if (typeof name !== 'string' || name.length === 0) throw new Error('defineTool: name 必须是非空字符串')
  if (name === 'run_code') throw new Error('defineTool: run_code 是保留名')
  if (typeof description !== 'string' || description.length === 0) throw new Error(`defineTool("${name}"): 缺少 description`)
  if (typeof render !== 'function') throw new Error(`defineTool("${name}"): render 必须是函数`)
  if (typeof execute !== 'function') throw new Error(`defineTool("${name}"): execute 必须是函数`)
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`defineTool("${name}"): timeoutMs 必须是正有限数`)
  }

  /** @type {Record<string, unknown>} */
  const definition = {
    name,
    description,
    parameters: compileParameters(parameters),
    output: {
      schema: outputSchema ?? { type: 'string' },
      render: (_args, value) => render(value),
    },
    async execute (args, exec) {
      const safeArgs = args && typeof args === 'object' ? args : {}
      assertArgs(name, parameters, safeArgs)
      // 见 stripUndefined 的注释：undefined 会让宿主判整个工具输出非法。
      return /** @type {Record<string, unknown>} */ (stripUndefined(await execute(safeArgs, exec ?? {})))
    },
  }

  if (timeoutMs !== undefined) definition.timeoutMs = timeoutMs
  return definition
}

/**
 * 把一段多行文本包成工具结果内容块。
 * @param {string} text
 */
export function textBlocks (text) {
  return [{ type: 'text', text }]
}
