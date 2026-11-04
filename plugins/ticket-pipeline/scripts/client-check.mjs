#!/usr/bin/env node
/**
 * 一致性检查：`lib/client.js`（浏览器 bundle）与宿主侧声明是否还对得上。
 *
 * 浏览器 bundle 不能 import 宿主侧源码（模块表里没有这些路径），而且本仓库没有
 * 构建步骤，所以两边是**手抄的两份**：`src/remote/descriptors.js` 一份、
 * `lib/client.js` 里的 `TICKET_PIPELINE_REMOTE` 一份。改一处忘另一处，表现是
 * 「体检按钮点了报 gateway/invocation-unavailable」或者静默不渲染 —— 都很难排查。
 *
 * 这个脚本把它们拿出来比一遍，顺带查 package.json 的声明和 bundle 的外壳形态。
 *
 *   node scripts/client-check.mjs
 *
 * 退出码 0 = 没问题；1 = 有必须修的问题。
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const problems = []
const notes = []

function fail (message) {
  problems.push(message)
}

/** 从 bundle 源码里抠出一个顶层 `var NAME = {...}` / `export const NAME = ...` 的 JSON。 */
function sliceJsonObject (source, startIndex) {
  const open = source.indexOf('{', startIndex)
  if (open < 0) return undefined
  let depth = 0
  let inString = false
  let quote = ''
  let escaped = false
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) inString = false
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = true; quote = ch; continue }
    if (ch === '/') {
      const next = source[i + 1]
      if (next === '/') { while (i < source.length && source[i] !== '\n') i += 1; continue }
      if (next === '*') { i += 2; while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1; i += 1; continue }
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return undefined
}

/**
 * 把描述符剥成只含「跨端必须一致」的字段。
 *
 * 函数不能比相等，所以 codec 只比「有没有 create」这个布尔位 —— 但这一位恰恰是
 * 最容易漏的：`dsh-typert-registry` 的 `validateCodec` 会在 `$mount` 时校验 result
 * codec 有没有 create()，漏了整份贡献物被拒，界面上只表现为「按钮没反应」。
 */
function normalizeDescriptor (descriptor) {
  return {
    id: descriptor.id,
    service: descriptor.service,
    namespace: descriptor.namespace,
    method: descriptor.method,
    invocation: descriptor.invocation,
    result: descriptor.result
      ? {
          mode: descriptor.result.mode,
          typeSymbol: descriptor.result.typeSymbol,
          hasCreate: typeof descriptor.result.create === 'function',
        }
      : undefined,
    parameters: (descriptor.parameters ?? []).map(function (parameter) {
      return { name: parameter.name, wire: parameter.wire, source: parameter.source }
    }),
  }
}

/** 每个 result codec 必须能满足 typert 的 validateCodec 要求。 */
function checkResultCodecs (label, descriptors) {
  for (const descriptor of descriptors) {
    const result = descriptor.result
    if (result === undefined) {
      fail(label + ' 的 ' + descriptor.id + ' 没有 result codec')
      continue
    }
    if (result.mode !== 'strict') continue
    if (typeof result.typeSymbol !== 'string' || result.typeSymbol.length === 0) {
      fail(label + ' 的 ' + descriptor.id + ' 的 result.typeSymbol 为空')
    }
    if (typeof result.create !== 'function') {
      fail(label + ' 的 ' + descriptor.id + ' 的 result codec 没有 create() —— typert 的 validateCodec 会拒掉整份贡献物（ctx.remote.$mount 失败）')
    }
  }
}

async function readHostRemote () {
  // Windows 上绝对路径不能直接 import，必须先转成 file:// URL。
  const module = await import(pathToFileURL(join(root, 'src/remote/descriptors.js')).href)
  return {
    package: module.TICKET_PIPELINE_REMOTE.package,
    raw: module.TICKET_PIPELINE_REMOTE.descriptors,
    descriptors: module.TICKET_PIPELINE_REMOTE.descriptors.map(normalizeDescriptor),
  }
}

async function readClientRemote () {
  const source = await readFile(join(root, 'lib/client.js'), 'utf8')
  const anchor = source.indexOf('var TICKET_PIPELINE_REMOTE')
  if (anchor < 0) {
    fail('lib/client.js 里找不到 TICKET_PIPELINE_REMOTE')
    return undefined
  }
  const literal = sliceJsonObject(source, anchor)
  if (literal === undefined) {
    fail('lib/client.js 里的 TICKET_PIPELINE_REMOTE 不是字面量对象（脚本抠不出来）')
    return undefined
  }
  let parsed
  try {
    // 手抄的那份是合法的 JS 对象字面量，键都能加引号，直接 JSON.parse 会失败；
    // 这里用 Function 求值（内容是本仓库自己的常量，不是外部输入）。
    parsed = new Function('return (' + literal + ')')()
  } catch (error) {
    fail('lib/client.js 里的 TICKET_PIPELINE_REMOTE 解析失败：' + error.message)
    return undefined
  }
  return {
    package: parsed.package,
    raw: parsed.descriptors,
    descriptors: parsed.descriptors.map(normalizeDescriptor),
  }
}

/**
 * 设置面板靠 `meta.group` / `meta.label` 分组与命名 —— 这两个键由 `CONFIG_GROUPS`
 * 派生，漏了字段就静默落到「其他」组或者显示成裸键名。这里把真实 descriptor 摊平核对。
 */
async function checkDescriptorMeta () {
  const configModule = await import(pathToFileURL(join(root, 'src/core/config.js')).href)
  const { CONFIG_GROUPS, CONFIG_FIELDS, FALLBACK_GROUP_LABEL, getConfigDescriptor } = configModule
  if (typeof getConfigDescriptor !== 'function') {
    fail('src/core/config.js 没导出 getConfigDescriptor()')
    return
  }
  if (typeof configModule.assertGroupCoverage === 'function') {
    const problems = configModule.assertGroupCoverage()
    for (const problem of problems) fail('CONFIG_GROUPS 与 CONFIG_FIELDS 不同步：' + problem)
  }

  const groupLabels = new Set(CONFIG_GROUPS.map((group) => group.label))
  const leaves = []
  /** 摊平 schema 树：有 dict 就是分支，否则是叶子。点号键在树里已经是嵌套的。 */
  function walk (node, path) {
    if (node === null || typeof node !== 'object') return
    if (node.dict && typeof node.dict === 'object') {
      for (const [key, child] of Object.entries(node.dict)) walk(child, path.concat([key]))
      return
    }
    leaves.push({ path, node })
  }
  walk(getConfigDescriptor(), [])

  const expectedKeys = Object.keys(CONFIG_FIELDS).sort()
  const actualKeys = leaves.map((leaf) => leaf.path.join('.')).sort()
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    fail('descriptor 叶子与 CONFIG_FIELDS 对不上：\n  声明：' + expectedKeys.join(', ') + '\n  实际：' + actualKeys.join(', '))
  }

  for (const leaf of leaves) {
    const key = leaf.path.join('.')
    const meta = leaf.node.meta ?? {}
    if (meta.volatile !== true) {
      // 叶子没标 volatile → dsh-settings 的 volatileForm() 会把它（连同整条设置项）吞掉。
      fail('字段 ' + key + ' 的 meta.volatile 不是 true —— 宿主的设置面板会静默跳过整个条目')
    }
    if (typeof meta.label !== 'string' || meta.label.length === 0) {
      fail('字段 ' + key + ' 没有 meta.label —— 面板里会显示裸键名')
    }
    if (typeof meta.group !== 'string' || meta.group.length === 0) {
      fail('字段 ' + key + ' 没有 meta.group —— 面板里会落到「' + FALLBACK_GROUP_LABEL + '」组')
    } else if (!groupLabels.has(meta.group)) {
      fail('字段 ' + key + ' 的 meta.group = ' + JSON.stringify(meta.group) + '，不是 CONFIG_GROUPS 里的任何组')
    }
    if (typeof leaf.node.toJSON !== 'function') {
      fail('字段 ' + key + ' 的 descriptor 节点没有 toJSON() —— dsh-settings 的 plainSchema() 会抛 TypeError')
    }
  }

  notes.push('descriptor 叶子 ' + leaves.length + ' 个，分组 ' + CONFIG_GROUPS.length + ' 组，meta 齐全')
}

async function checkPackageJson () {
  const text = await readFile(join(root, 'package.json'), 'utf8')
  let pkg
  try {
    pkg = JSON.parse(text)
  } catch (error) {
    fail('package.json 不是合法 JSON：' + error.message)
    return
  }
  const clientExport = pkg.exports && pkg.exports['./client']
  const resolved = typeof clientExport === 'string'
    ? clientExport
    : (clientExport && typeof clientExport.default === 'string' ? clientExport.default : undefined)
  if (resolved === undefined) {
    fail('package.json 缺少 exports["./client"]（字符串或 { default: string }）')
  } else if (resolved !== './lib/client.js') {
    notes.push('exports["./client"] = ' + resolved + '（预期 ./lib/client.js）')
  }
  const dsh = pkg.dsh ?? {}
  const client = dsh.client
  if (client === undefined) {
    fail('package.json 缺少 dsh.client —— 宿主不会加载浏览器端 bundle')
  } else {
    if (client.platform !== 'web') fail('dsh.client.platform 必须是 "web"（当前 ' + JSON.stringify(client.platform) + '）；否则宿主静默跳过，不报错')
    if (client.inject !== undefined && !Array.isArray(client.inject)) fail('dsh.client.inject 必须是字符串数组')
    if (client.external !== undefined && !Array.isArray(client.external)) fail('dsh.client.external 必须是字符串数组')
  }
  if (dsh.bundle === undefined || typeof dsh.bundle.patch !== 'string') {
    fail('package.json 缺少 dsh.bundle.patch —— 宿主的宿主侧插件不会装')
  }
  if (!Array.isArray(pkg.files) || pkg.files.indexOf('lib/**/*.js') < 0) {
    notes.push('package.json 的 files 里没有 "lib/**/*.js" —— 打包/安装时 client bundle 可能掉出去')
  }
}

async function checkClientShell () {
  const source = await readFile(join(root, 'lib/client.js'), 'utf8')
  if (!source.includes('window.__ModuleLoader__.load(')) {
    fail('lib/client.js 没有调用 window.__ModuleLoader__.load(...)')
  }
  const idMatch = source.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*'([^']+)'/)
  if (idMatch === null) {
    fail('lib/client.js 的 __ModuleLoader__.load 没有写 id')
  } else if (idMatch[1] !== '@local/ticket-pipeline') {
    fail('lib/client.js 的模块 id 是 ' + JSON.stringify(idMatch[1]) + '，必须等于包名 "@local/ticket-pipeline"（否则 require 不到、也不报错）')
  }

  // 只允许 require 宿主模块表里确实存在的 seed 词；第三方 bundle 不许 require 任何
  // dsh-client-* 包（官方规范明令禁止），所以这里把 require 的参数全部列出来查。
  const requires = []
  const requirePattern = /require\(\s*'([^']+)'\s*\)/g
  let match
  while ((match = requirePattern.exec(source)) !== null) requires.push(match[1])
  const allowed = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']
  for (const name of requires) {
    if (allowed.indexOf(name) < 0) {
      fail('lib/client.js require 了 ' + JSON.stringify(name) + '，不在允许清单（react / react/jsx-runtime / react-dom / react-dom/client）里')
    }
  }
  if (requires.indexOf('react') < 0) {
    fail('lib/client.js 没有 require("react")')
  }
  if (/require\(\s*'@deepseek-ai\//.test(source)) {
    fail('lib/client.js require 了 @deepseek-ai/* 包 —— 官方规范禁止第三方 bundle 依赖 Harness Client 包')
  }
}

/**
 * slot 的声明时机由 plugin-manager 决定（它在运行时才 register 出 plugins.row.config /
 * plugins.bundle.config 这些 slot）。声明还没出现时裸调 ctx.slots.register 会抛
 * `slot "<name>" is not declared`，整个 apply 失败、设置页空白。必须走 ctx.slots.inject
 * 挂起等待声明。
 */
async function checkSlotInjection () {
  const source = await readFile(join(root, 'lib/client.js'), 'utf8')
  if (!source.includes('ctx.slots.inject(')) {
    fail('lib/client.js 没有用 ctx.slots.inject(...) 挂 slot —— 裸 register 会在 slot 尚未声明时抛错')
  }
  // apply 里（去掉 serveSlot 的兜底分支后）不应再有直接的 ctx.slots.register 调用。
  const direct = /ctx\.slots\.register\(/.test(source.replace(/ctx\.slots\.register\(options, component\)/, ''))
  if (direct) {
    fail('lib/client.js 里还有绕过 slots.inject 的 ctx.slots.register(...) 调用')
  }
  for (const name of ['settings.section', 'settings.plugins.tab', 'plugins.row.config', 'plugins.bundle.config']) {
    if (!source.includes("'" + name + "'")) {
      fail('lib/client.js 没有注册 ' + name)
    }
  }
  // remote 不能进 inject：dsh-api-gateway 自己还要等 typert/connection，
  // 一旦它没就绪，我们的 fiber 就永远停在 waiting for activation，apply 一次都不跑。
  const injectMatch = source.match(/var inject = \[([^\]]*)\]/)
  if (injectMatch !== null && injectMatch[1].includes("'remote'")) {
    fail("lib/client.js 的 inject 里不能有 'remote'（会让 apply 永不执行），改走 ctx.get('remote')")
  }
}

async function main () {
  await checkPackageJson()
  await checkClientShell()
  await checkSlotInjection()
  await checkDescriptorMeta()

  const host = await readHostRemote()
  const client = await readClientRemote()
  if (host !== undefined && client !== undefined) {
    checkResultCodecs('宿主侧 src/remote/descriptors.js', host.raw)
    checkResultCodecs('浏览器侧 lib/client.js', client.raw)
    if (host.package !== client.package) {
      fail('包名不一致：宿主 ' + host.package + ' vs 浏览器 ' + client.package)
    }
    const hostKey = JSON.stringify(host.descriptors)
    const clientKey = JSON.stringify(client.descriptors)
    if (hostKey !== clientKey) {
      fail('lib/client.js 里的 TICKET_PIPELINE_REMOTE 与 src/remote/descriptors.js 已经不一致：\n  宿主：' + hostKey + '\n  浏览器：' + clientKey)
    } else {
      notes.push('Remote 描述符一致（' + host.descriptors.length + ' 个方法：' + host.descriptors.map(function (d) { return d.namespace + '/' + d.method }).join(', ') + '）')
    }
    const namespace = host.descriptors.length > 0 ? host.descriptors[0].namespace : undefined
    if (namespace !== undefined && namespace !== 'ticketPipeline') {
      notes.push('Remote 命名空间是 ' + namespace + '（浏览器侧按 remote.ticketPipeline.* 调用，注意同步）')
    }
  }

  for (const note of notes) console.log('· ' + note)
  if (problems.length === 0) {
    console.log('✅ client-check 通过')
    return
  }
  console.error('❌ client-check 发现 ' + problems.length + ' 个问题：')
  for (const problem of problems) console.error('  - ' + problem)
  process.exitCode = 1
}

await main()
