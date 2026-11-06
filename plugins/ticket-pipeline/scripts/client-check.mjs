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

/**
 * 从 `startIndex` 往后抠一个括号平衡的字面量（字符串与注释里的括号不算）。
 *
 * `lib/client.js` 里的 `TICKET_PIPELINE_REMOTE` / `PROJECT_SECTIONS` 都是手写字面量，
 * 只能靠源码切片再求值来核对 —— 但它们里面既有中文又有注释，正则切不准。
 */
function sliceBalanced (source, startIndex, openChar, closeChar) {
  const open = source.indexOf(openChar, startIndex)
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
    if (ch === openChar) depth += 1
    else if (ch === closeChar) {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return undefined
}

/** 从 bundle 源码里抠出一个顶层 `var NAME = {...}` 的 JSON。 */
function sliceJsonObject (source, startIndex) {
  return sliceBalanced(source, startIndex, '{', '}')
}

/** 从 bundle 源码里抠出一个顶层 `var NAME = [...]` 的数组字面量。 */
function sliceJsonArray (source, startIndex) {
  return sliceBalanced(source, startIndex, '[', ']')
}

/**
 * 摊平 descriptor / 信封树，可选跳过根上的 `projects` 子树。
 *
 * `projects` 是数组，不在 `CONFIG_FIELDS` 里（由 `validateProjects` 单独校验），
 * 所以「常规叶子必须与 CONFIG_FIELDS 完全一致」那两条断言摊平时要把它排除，
 * 否则一旦宿主给它补上 descriptor 节点，断言就会误报。
 */
function collectLeaves (node, path, out, skipProjects) {
  if (node === null || typeof node !== 'object') return out
  if (node.dict && typeof node.dict === 'object') {
    for (const [key, child] of Object.entries(node.dict)) {
      if (skipProjects && path.length === 0 && key === 'projects') continue
      collectLeaves(child, path.concat([key]), out, skipProjects)
    }
    return out
  }
  out.push({ path, node })
  return out
}

/**
 * 专项体检 `projects` 子树（如果有）。
 *
 * 面板写的是**深层路径**（`['projects','0','repo','path']` 这种），不是整数组替换 ——
 * 整替换会把别人写的项目和 `appToken` 一起冲掉。要让深层路径写得进去，宿主
 * `applyPathOp` 必须一路都能 `dict[...]` / `inner` 下去，且沿途**每个**节点都得是
 * volatile（`validatePaths` 只在最后那一段上查 volatile，但中间的节点不声明就直接
 * 抛 `Config field "..." is not declared`）。所以这里按沿途逐节点查。
 *
 * @param {any} node descriptor 或重建后的信封根上的 `projects` 节点
 * @param {string} label 报错时用的位置说明
 * @returns {{ present: boolean, fields: string[] }} fields 是去掉 `projects` 前缀后的路径
 */
function auditProjectsNode (node, label) {
  if (node === undefined) return { present: false, fields: [] }
  if (node === null || typeof node !== 'object') {
    fail(label + ' 的 projects 节点不是对象')
    return { present: true, fields: [] }
  }
  if (node.type !== 'array') {
    fail(label + ' 的 projects 节点 type 是 ' + JSON.stringify(node.type) + '，必须是 "array"')
  }
  if (!node.meta || node.meta.volatile !== true) {
    fail(label + ' 的 projects 节点没有 meta.volatile —— 宿主会以 Config field "projects" is not volatile 拒掉整笔写入')
  }
  const inner = node.inner
  if (inner === undefined || inner === null || typeof inner !== 'object') {
    fail(label + ' 的 projects 是数组但 inner 为空 —— 浏览器重建后读 inner.meta 会抛 TypeError: Cannot read properties of undefined')
    return { present: true, fields: [] }
  }
  if (inner.type !== 'object') {
    fail(label + ' 的 projects.inner 是 ' + JSON.stringify(inner.type) + '，必须是 "object"（否则 projects[0].repo.path 这种深层路径走不下去）')
  }
  if (!inner.meta || inner.meta.volatile !== true) {
    fail(label + ' 的 projects.inner 没有 meta.volatile —— 深层路径写到元素上时会被拒')
  }

  const leaves = []
  collectLeaves(inner, [], leaves, false)
  const fields = []
  for (const leaf of leaves) {
    const key = leaf.path.join('.')
    fields.push(key)
    const meta = leaf.node.meta ?? {}
    if (meta.volatile !== true) {
      fail(label + ' 的项目字段 projects[].' + key + ' 没有 meta.volatile —— 写到这一层的 mutate 会被拒（Config field "' + (leaf.path[0] ?? '') + '" is not volatile）')
    }
    if (typeof leaf.node.toJSON !== 'function') {
      fail(label + ' 的项目字段 projects[].' + key + ' 的 descriptor 节点没有 toJSON()')
    }
  }
  if (fields.length === 0) {
    fail(label + ' 的 projects.inner 里一个字段都没有 —— 面板没法展示任何项目字段')
  }
  return { present: true, fields }
}

/**
 * 抠出 `lib/client.js` 里手写的项目字段表 `PROJECT_SECTIONS` 并摊平。
 *
 * 面板的字段表是手抄的（浏览器 bundle 用不了宿主源码），抄漏一个字段的表现是
 * 「这个字段在界面上根本不出现」，抄错路径的表现是保存时被宿主拒成
 * `Config field "..." is not declared`。两边都必须能对上。
 */
async function readClientProjectFields () {
  const source = await readFile(join(root, 'lib/client.js'), 'utf8')
  const anchor = source.indexOf('var PROJECT_SECTIONS')
  if (anchor < 0) {
    fail('lib/client.js 里找不到 PROJECT_SECTIONS（项目清单的字段表）')
    return undefined
  }
  const literal = sliceJsonArray(source, anchor)
  if (literal === undefined) {
    fail('lib/client.js 里的 PROJECT_SECTIONS 不是字面量数组（脚本抠不出来）')
    return undefined
  }
  // 字段表里引用外层常量（`options: PLATFORMS`），求值时要把它一起带上。
  const platformAnchor = source.indexOf('var PLATFORMS')
  const platformLiteral = platformAnchor < 0 ? undefined : sliceJsonArray(source, platformAnchor)
  if (platformLiteral === undefined) {
    fail('lib/client.js 里找不到 PLATFORMS 常量（项目平台下拉框的选项表）')
    return undefined
  }
  let sections
  try {
    sections = new Function('PLATFORMS', 'return (' + literal + ')')(new Function('return (' + platformLiteral + ')')())
  } catch (error) {
    fail('lib/client.js 里的 PROJECT_SECTIONS 解析失败：' + error.message)
    return undefined
  }
  const fields = []
  for (const section of sections) {
    for (const field of section.fields ?? []) fields.push(field)
  }
  return fields
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
  const descriptor = getConfigDescriptor()
  const leaves = []
  // 摊平 schema 树：有 dict 就是分支，否则是叶子。点号键在树里已经是嵌套的。
  // `projects` 是数组（不在 CONFIG_FIELDS 里），下面单独体检，这里跳过。
  collectLeaves(descriptor, [], leaves, true)

  const expectedKeys = Object.keys(CONFIG_FIELDS).sort()
  const actualKeys = leaves.map((leaf) => leaf.path.join('.')).sort()
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    fail('descriptor 叶子与 CONFIG_FIELDS 对不上：\n  声明：' + expectedKeys.join(', ') + '\n  实际：' + actualKeys.join(', '))
  }

  const projects = auditProjectsNode(descriptor && descriptor.dict ? descriptor.dict.projects : undefined, 'getConfigDescriptor()')
  if (projects.present) notes.push('descriptor 里 projects 可写：' + projects.fields.length + ' 个字段（深层路径 mutate）')

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

/**
 * 设置面板要的是 schemastery 的「信封」格式：`{ uid, refs }`，refs 里 dict/inner/list
 * 的值是 uid 数字（引用），不是内联对象。
 *
 * 这条链一旦不对，症状极其隐蔽：宿主 `dsh-settings` 重建之后 form.toJSON() 里的数组
 * 节点 inner 不是 uid，浏览器 `new Schema(envelope)` 后 inner === undefined，数组
 * resolver 去读 `inner.meta` 抛
 * `TypeError: Cannot read properties of undefined (reading 'meta')`，
 * 而 `dsh-client-ui-settings` 的 decode() 把这个异常静默 catch 掉 —— 于是整个
 * namespace 的表单永远停在 loading，界面上什么都不显示，也不报错。
 *
 * 这里手抄一遍宿主与浏览器两边真正走的那几行（两边都是手抄的，改一处记得改另一处）：
 *   宿主 dsh-settings/lib/index.js:103-117  plainSchema  → new z(schema.toJSON())
 *   宿主 dsh-settings/lib/index.js:122-131  volatileForm
 *   浏览器 dsh-client-ui-settings/lib/client.js:289-300  new Schema(serialized)
 *   浏览器 dsh-client-ui-settings/lib/client.js:773-777  数组 resolver 读 inner.meta
 */
function rehydrateEnvelope (serialized) {
  const refs = {}
  for (const key of Object.keys(serialized.refs ?? {})) {
    const raw = serialized.refs[key]
    const node = { type: raw.type, meta: { ...(raw.meta ?? {}) } }
    if (raw.dict) node.dict = { ...raw.dict }
    if (raw.inner !== undefined) node.inner = raw.inner
    if (raw.list) node.list = raw.list.slice()
    if (raw.sKey !== undefined) node.sKey = raw.sKey
    refs[key] = node
  }
  const getRef = (uid) => (uid === undefined ? undefined : refs[String(uid)])
  for (const key of Object.keys(refs)) {
    const node = refs[key]
    node.sKey = getRef(node.sKey)
    node.inner = getRef(node.inner)
    node.list = node.list && node.list.map(getRef)
    node.dict = node.dict && Object.fromEntries(Object.entries(node.dict).map(([k, v]) => [k, getRef(v)]))
  }
  return { refs, root: refs[String(serialized.uid)] }
}

/**
 * 按浏览器 schemastery 的 resolver 走一遍树，专门盯住会把表单整块打挂的那两处。
 */
function walkLikeBrowser (node, path, found) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'object') {
    for (const [key, child] of Object.entries(node.dict ?? {})) {
      if (child === undefined) {
        found.push('对象字段 ' + path.concat([key]).join('.') + ' 的 dict 引用解析成了 undefined')
        continue
      }
      walkLikeBrowser(child, path.concat([key]), found)
    }
    return
  }
  if (node.type === 'array') {
    const inner = node.inner
    if (inner === undefined || inner === null) {
      found.push('数组字段 ' + path.join('.') + ' 的 inner 解析成了 undefined —— 浏览器会抛 TypeError: Cannot read properties of undefined (reading \'meta\')')
      return
    }
    if (typeof inner.meta !== 'object' || inner.meta === null) {
      found.push('数组字段 ' + path.join('.') + ' 的 inner.meta 不是对象 —— 浏览器会抛 TypeError')
    }
  }
}

async function checkSchemaEnvelope () {
  const configModule = await import(pathToFileURL(join(root, 'src/core/config.js')).href)
  const { CONFIG_FIELDS, Config, getConfigDescriptor } = configModule

  // 1) 宿主 dsh-settings 的 describe() 会对 Config 调一次 toJSON()，算出 revision 哈希。
  //    两次生成必须逐字节相同，否则每次保存都会撞 SETTINGS_CONFLICT。
  const first = JSON.stringify(Config.toJSON())
  const second = JSON.stringify(Config.toJSON())
  if (first !== second) {
    fail('Config.toJSON() 两次生成不一致 —— 宿主 describe() 的 revision 哈希会漂移，每次保存都会撞 SETTINGS_CONFLICT')
  }

  const envelope = Config.toJSON()
  if (typeof envelope.uid !== 'number' || envelope.refs === undefined) {
    fail('Config.toJSON() 没返回 { uid, refs } 信封 —— 宿主 new z(schema.toJSON()) 与浏览器 new Schema(envelope) 都重建不出来')
    return
  }

  // 2) refs 里每条记录都要能被 getRef 命中；dict/inner/list 的值必须是 uid 数字。
  for (const [key, ref] of Object.entries(envelope.refs)) {
    if (typeof ref.type !== 'string' || ref.type.length === 0) {
      fail('信封 refs[' + key + '] 没有 type —— schemastery 重建时会抛 unsupported type')
    }
    for (const field of ['dict', 'inner', 'list', 'sKey']) {
      const value = ref[field]
      if (value === undefined) continue
      if (field === 'dict') {
        for (const [childKey, uid] of Object.entries(value)) {
          if (typeof uid !== 'number') {
            fail('信封 refs[' + key + '].dict.' + childKey + ' 不是 uid 数字（是 ' + typeof uid + '）')
          } else if (envelope.refs[String(uid)] === undefined) {
            fail('信封 refs[' + key + '].dict.' + childKey + ' 指向的 uid ' + uid + ' 不存在')
          }
        }
        continue
      }
      if (field === 'list') {
        for (const [index, uid] of value.entries()) {
          if (typeof uid !== 'number' || envelope.refs[String(uid)] === undefined) {
            fail('信封 refs[' + key + '].list[' + index + '] 不是有效 uid')
          }
        }
        continue
      }
      if (typeof value !== 'number') {
        fail('信封 refs[' + key + '].' + field + ' 不是 uid 数字（是 ' + typeof value + '）')
      } else if (envelope.refs[String(value)] === undefined) {
        fail('信封 refs[' + key + '].' + field + ' 指向的 uid ' + value + ' 不存在')
      }
    }
  }
  if (envelope.refs[String(envelope.uid)] === undefined) {
    fail('信封根 uid ' + envelope.uid + ' 不在 refs 里 —— new z(envelope) 会静默返回 undefined，整个条目不会进设置面板')
    return
  }

  // 3) 走一遍浏览器的重建与 resolver，重点是数组的 inner。
  const { root: rootNode } = rehydrateEnvelope(envelope)
  const found = []
  walkLikeBrowser(rootNode, [], found)
  for (const message of found) fail('信封重建后 ' + message)

  // 4) 信封摊出来的叶子必须与源树、CONFIG_FIELDS 三方一致，面板才知道每个字段叫什么、在哪一组。
  //    `projects` 是数组、不在 CONFIG_FIELDS 里，摊平时跳过它（单独体检）。
  const sourceLeaves = []
  const sourceMeta = new Map()
  for (const leaf of collectLeaves(getConfigDescriptor(), [], [], true)) {
    sourceLeaves.push(leaf.path.join('.'))
    sourceMeta.set(leaf.path.join('.'), leaf.node.meta)
  }

  const envelopeLeaves = collectLeaves(rootNode, [], [], true).map((leaf) => ({
    key: leaf.path.join('.'),
    meta: leaf.node.meta ?? {},
  }))

  const expected = Object.keys(CONFIG_FIELDS).sort()
  const fromSource = sourceLeaves.slice().sort()
  const fromEnvelope = envelopeLeaves.map((leaf) => leaf.key).sort()
  if (JSON.stringify(expected) !== JSON.stringify(fromSource)) {
    fail('源树的叶子与 CONFIG_FIELDS 对不上')
  }
  if (JSON.stringify(expected) !== JSON.stringify(fromEnvelope)) {
    fail('信封摊出来的叶子与 CONFIG_FIELDS 对不上：\n  声明：' + expected.join(', ') + '\n  实际：' + fromEnvelope.join(', '))
  }
  for (const leaf of envelopeLeaves) {
    if (typeof leaf.meta.label !== 'string' || leaf.meta.label.length === 0) {
      fail('信封里字段 ' + leaf.key + ' 没有 meta.label —— 面板里会显示裸键名')
    }
    if (typeof leaf.meta.group !== 'string' || leaf.meta.group.length === 0) {
      fail('信封里字段 ' + leaf.key + ' 没有 meta.group —— 面板里会落到「其他」组')
    }
  }

  // 5) 宿主 plainSchema 的 walk() 会 delete node.meta.volatile，而它重建出来的 Schema
  //    与信封里的 meta 是同一个对象引用。toJSON() 必须给出 meta 的副本，否则源树上的
  //    volatile 标记会被抹掉，之后所有写入都被拒（Config field "..." is not volatile）。
  for (const leaf of envelopeLeaves) {
    const source = sourceMeta.get(leaf.key)
    if (source !== undefined && leaf.meta === source) {
      fail('信封里字段 ' + leaf.key + ' 的 meta 与源树共用同一个对象 —— 宿主重建时 delete meta.volatile 会抹掉源树的 volatile 标记，写入会被拒')
      break
    }
  }
  for (const leaf of envelopeLeaves) {
    const source = sourceMeta.get(leaf.key)
    if (source === undefined) continue
    if (source.volatile !== true) {
      fail('源树字段 ' + leaf.key + ' 没有 meta.volatile —— 宿主的 volatileForm() 会把整个条目从设置面板里吞掉')
      break
    }
  }

  notes.push('schema 信封 ' + Object.keys(envelope.refs).length + ' 个节点，' + envelopeLeaves.length + ' 个叶子，三方一致')
}

/**
 * 面板的项目字段表 vs 宿主 `projects` descriptor：两边必须能对上。
 *
 * 两份表是**手抄的两份**（`lib/client.js` 的 `PROJECT_SECTIONS` 与
 * `src/core/config.js` 的 `buildProjectsDescriptor`）。对不上的后果只有两种，
 * 而且都发生在别人点保存之后：漏抄字段 = 那个字段在界面上根本改不了；
 * 多抄/抄错路径 = 宿主回 `Config field "..." is not declared`，整笔写入被拒。
 */
async function checkProjectFields () {
  const configModule = await import(pathToFileURL(join(root, 'src/core/config.js')).href)
  const { getConfigDescriptor } = configModule
  if (typeof getConfigDescriptor !== 'function') return
  const descriptor = getConfigDescriptor()
  const projectsNode = descriptor && descriptor.dict ? descriptor.dict.projects : undefined
  const fields = await readClientProjectFields()
  if (fields === undefined) return

  const panelPaths = fields.map((field) => (Array.isArray(field.path) ? field.path.join('.') : String(field.path)))
  const duplicate = panelPaths.filter((path, index) => panelPaths.indexOf(path) !== index)
  if (duplicate.length > 0) {
    fail('lib/client.js 的 PROJECT_SECTIONS 里有重复字段：' + Array.from(new Set(duplicate)).join(', '))
  }
  for (const field of fields) {
    if (!Array.isArray(field.path) || field.path.length === 0) {
      fail('lib/client.js 的 PROJECT_SECTIONS 里有字段没写 path：' + JSON.stringify(field))
      continue
    }
    if (typeof field.from !== 'string' || field.from.length === 0) {
      fail('lib/client.js 的 PROJECT_SECTIONS 里 ' + field.path.join('.') + ' 没有 from（宿主 describeProject 的扁平字段名）')
    }
    if (['text', 'list', 'select', 'bool', 'branch'].indexOf(field.kind) < 0) {
      fail('lib/client.js 的 PROJECT_SECTIONS 里 ' + field.path.join('.') + ' 的 kind 不认识：' + JSON.stringify(field.kind))
    }
    if (typeof field.label !== 'string' || field.label.length === 0) {
      fail('lib/client.js 的 PROJECT_SECTIONS 里 ' + field.path.join('.') + ' 没有 label —— 界面上会显示裸键名')
    }
  }

  if (projectsNode === undefined) {
    // 宿主还没把 projects 做成可写节点时，面板照样能画出来（只是保存会被拒，
    // 界面上会原样显示宿主的 error.message）。这不算失败，但要提示。
    notes.push('宿主 descriptor 里还没有可写的 projects 节点（面板字段表 ' + panelPaths.length + ' 项已就绪，保存会被宿主拒）')
    return
  }

  const audit = auditProjectsNode(projectsNode, 'getConfigDescriptor()')
  const declared = new Set(audit.fields)
  for (const path of panelPaths) {
    if (!declared.has(path)) {
      fail('面板字段 ' + path + ' 在宿主 projects descriptor 里没有对应节点 —— 保存会被拒成 Config field "' + path.split('.')[0] + '" is not declared')
    }
  }
  for (const path of audit.fields) {
    if (panelPaths.indexOf(path) < 0) {
      notes.push('宿主 projects descriptor 里有 ' + path + '，面板没画（这个字段只能改配置文件）')
    }
  }
  notes.push('面板项目字段 ' + panelPaths.length + ' 项与宿主 projects descriptor 对得上')
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
  await checkSchemaEnvelope()
  await checkProjectFields()

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
