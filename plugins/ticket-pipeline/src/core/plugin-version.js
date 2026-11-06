/**
 * `plugin-version` —— 判断「正在跑的这份插件，比源码旧多少」。
 *
 * ## 为什么需要这个检查
 *
 * 插件装进 profile 时，落在 `node_modules/@local/ticket-pipeline` 的是一份**目录副本**：
 * 宿主的 `pnpm` 是 `nodeLinker: hoisted`，而源码在 `D:`、pnpm store 在 `C:`，
 * 跨盘时 pnpm 不落硬链接，直接复制（同盘才会硬链）。于是——
 *
 * - 改完源码，副本一个字节都不会变；
 * - HMR 的 `root` 是 `[]`，不监听源码目录，默认 ignored 里还列着 node_modules；
 * - `pnpm install` 也不会救：锁文件没变，它输出 `Already up to date` 就结束了。
 *
 * 结果是最难查的一类故障：**跑的是旧代码，但没有任何报错**，只表现为旧行为
 * （某个新配置项没生效、某句新文案不出现）。所以让插件自己比一次，把
 * 「你改的代码没装上」变成体检里的一行字。
 *
 * ## 为什么不比版本号
 *
 * 源码与副本的 `package.json` 的 `version` 都是 `0.1.0-test.1` —— 比版本号永远
 * 得出「最新」。仓库没有构建步骤，也没有打戳的地方，只能比**文件内容**。
 *
 * ## 为什么跟本地源码比、不跟 origin 比
 *
 * 本仓库的交付形态是「工作区里的本地提交」，`origin` 上长期落在本地之后
 * （有多条未推送提交）。拿远端当基准会把「本地源码更新」误报成「你落后了」，
 * 方向正好反了。所以基准是 profile 里声明的那份 `file:` / `link:` 源码目录。
 *
 * ## 复杂度
 *
 * 只比**会真的被加载**的文件：`src/**` 的 `.js`、`lib/**` 的 `.js`、
 * `cordis.patch.yml`、`icon.svg`、`locale/*.json`。`README.md` 与 `scripts/`
 * 不比 —— 它们变了不影响行为，报出来只会让人以为必须重装。
 *
 * 读盘全部走注入的 `io`（默认 `node:fs`）：这个模块本身不碰网络、不写文件，
 * 也不假定自己跑在哪里，所以自测能拿内存假文件系统把每种分支都走一遍。
 */

import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** 要参与比对的两棵子树（相对插件根）。 */
export const COMPARED_DIRS = Object.freeze(['src', 'lib'])

/** 要参与比对的单文件（相对插件根）。 */
export const COMPARED_FILES = Object.freeze(['cordis.patch.yml', 'icon.svg'])

/** 要参与比对的目录（只取一层 `.json`）。 */
export const COMPARED_JSON_DIRS = Object.freeze(['locale'])

/**
 * 从模块 URL 反推插件根目录。
 *
 * 本文件在 `<插件根>/src/core/` 下，所以往上两级就是插件根。
 * 放在这里而不是各调用点自己算：路径推导错了会让整个检查对着
 * 两个互不相干的目录比，得出「一模一样」的假结论。
 *
 * @param {string} moduleUrl 通常就是 `import.meta.url`
 * @returns {string}
 */
export function pluginRootFromModuleUrl (moduleUrl) {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..')
}

/**
 * 从安装路径反推 profile 目录。
 *
 * 安装形态固定是 `<profile>/node_modules/@local/<name>`，所以往上一级是
 * scope 目录、再上一级是 `node_modules`、再上一级才是 profile。
 * 结构推导比读 `DSH_PROFILE_DIR` 稳：环境变量在宿主的某些启动方式下不一定有。
 *
 * 注意：**只在按标准布局安装时成立**。从源码目录直接跑（自测、`node .scratch/...`）
 * 时推出来的不是 profile，`comparePluginTrees` 会退到向上查找，见 `findProfileDir`。
 *
 * @param {string} installedDir
 * @returns {string}
 */
export function profileDirFromInstalledDir (installedDir) {
  return resolve(installedDir, '..', '..', '..')
}

/**
 * 沿着安装路径往上找，找到那个「声明了本包本地来源」的 profile 目录。
 *
 * 为什么需要：`profileDirFromInstalledDir` 假定标准布局，而插件在开发时可能
 * 直接从源码目录跑（自测、探针脚本）。那种情况下硬套三层会得到 `D:\WorkSpace`
 * 这种不相干目录，然后报「读不到 package.json」——把「我在开发环境」误报成故障。
 * 向上找一次就能同时覆盖两种情形，且找到的一定是**真的声明了来源**的那份 manifest。
 *
 * @param {string} installedDir
 * @param {string} packageName
 * @param {(path: string) => Promise<string>} readFile
 * @returns {Promise<{ profileDir: string, declared: { kind: 'file' | 'link', specPath: string } } | null>}
 */
export async function findProfileDir (installedDir, packageName, readFile) {
  let current = resolve(installedDir)
  for (let depth = 0; depth < 6; depth += 1) {
    const manifestPath = join(current, 'package.json')
    let text = null
    try {
      text = await readFile(manifestPath)
    } catch {
      text = null
    }
    if (typeof text === 'string') {
      const declared = readLocalDependency(text, packageName)
      if (declared !== null) return { profileDir: current, declared }
    }
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  return null
}

/**
 * 从 profile 的 `package.json` 文本里读出某个包的本地来源声明。
 *
 * 只认 `file:` 与 `link:` 两种前缀（pnpm 的本地目录依赖只有这两种）。
 * 版本号形态（`^1.0.0`）说明这个包来自 registry，没有「本地源码」可比。
 *
 * @param {string} manifestText profile 的 package.json 原文
 * @param {string} packageName 例如 `@local/ticket-pipeline`
 * @returns {{ kind: 'file' | 'link', specPath: string } | null}
 */
export function readLocalDependency (manifestText, packageName) {
  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch {
    return null
  }
  const deps = {
    ...(manifest?.dependencies ?? {}),
    ...(manifest?.devDependencies ?? {}),
    ...(manifest?.optionalDependencies ?? {}),
  }
  const spec = deps[packageName]
  if (typeof spec !== 'string') return null
  const match = /^(file|link):(.+)$/.exec(spec.trim())
  if (!match) return null
  return { kind: /** @type {'file' | 'link'} */ (match[1]), specPath: match[2].trim() }
}

/**
 * 把 `file:` / `link:` 里的路径解析成绝对路径（相对路径按 profile 目录解析）。
 *
 * @param {string} profileDir
 * @param {string} specPath
 * @returns {string}
 */
export function resolveSpecPath (profileDir, specPath) {
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(specPath)
  if (windowsAbsolute || isAbsolute(specPath)) return resolve(specPath)
  return resolve(profileDir, specPath)
}

/**
 * 比内容前先做的归一化。
 *
 * 只把行尾统一成 `\n`：Windows 上 `git clone` 与 `robocopy` 对同一个文件
 * 可能给出 CRLF / LF 两种字节，内容其实一致。**不**做 trim、不忽略空白 ——
 * 空白差异也是差异，真要放过就该改源码，而不是让检查器撒谎。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeForCompare (text) {
  return String(text ?? '').replace(/\r\n/g, '\n')
}

/**
 * 给一棵文件树算一个短的展示用指纹（FNV-1a 32 位）。
 *
 * 只为在体检里印一句「源码 a1b2c3d4 ↔ 副本 e5f6a7b8」让人能贴到对话里，
 * 不是安全用途。用纯 JS 而不是 `node:crypto`：这里只需要「变没变」，
 * 越少依赖越好，也方便自测对比固定字符串。
 *
 * @param {Array<{ path: string, text: string }>} entries 已按 path 排序
 * @returns {string}
 */
export function fingerprintOfEntries (entries) {
  let hash = 0x811c9dc5
  for (const entry of entries) {
    const payload = `\u0000${entry.path}\u0000${normalizeForCompare(entry.text)}`
    for (let index = 0; index < payload.length; index += 1) {
      hash ^= payload.charCodeAt(index)
      // FNV 素数 16777619，用移位避免 Math.imul 之外的大数误差。
      hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0
    }
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 默认的读盘实现（只在真正跑体检时用得上）。
 *
 * @returns {{ readdir: (dir: string) => Promise<Array<{ name: string, isDirectory: boolean }>>, readFile: (path: string) => Promise<string>, realpath: (path: string) => Promise<string> }}
 */
function defaultIo () {
  return {
    async readdir (dir) {
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(dir, { withFileTypes: true })
      return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
    },
    async readFile (path) {
      const { readFile } = await import('node:fs/promises')
      return readFile(path, 'utf8')
    },
    async realpath (path) {
      const { realpath } = await import('node:fs/promises')
      return realpath(path)
    },
  }
}

/**
 * 列出一棵插件树里**要参与比对**的文件（相对路径，正斜杠，已排序）。
 *
 * 缺目录不算错：`lib/` 在某些裁剪安装里可能没有，`locale/` 同理。
 *
 * @param {string} root
 * @param {(dir: string) => Promise<Array<{ name: string, isDirectory: boolean }>>} readdir
 * @returns {Promise<string[]>}
 */
export async function listComparedFiles (root, readdir) {
  /** @type {string[]} */
  const out = []

  // 先列根目录：单文件清单（`cordis.patch.yml` / `icon.svg`）**只收真的存在的**。
  // 不能无条件塞进清单 —— 某些裁剪安装里没有 icon.svg，塞进去会让读文件报 ENOENT，
  // 把「本来就是这么装的」变成「比对失败」。
  let rootEntries
  try {
    rootEntries = await readdir(root)
  } catch {
    return out
  }
  const rootFiles = new Set(rootEntries.filter((entry) => !entry.isDirectory).map((entry) => entry.name))

  /** 递归只收 `.js`。 */
  const walkJs = async (relative) => {
    let entries
    try {
      entries = await readdir(join(root, relative))
    } catch {
      return
    }
    for (const entry of entries) {
      const childRelative = `${relative}/${entry.name}`
      if (entry.isDirectory) {
        await walkJs(childRelative)
      } else if (entry.name.endsWith('.js')) {
        out.push(childRelative)
      }
    }
  }

  for (const dir of COMPARED_DIRS) await walkJs(dir)
  for (const file of COMPARED_FILES) {
    if (rootFiles.has(file)) out.push(file)
  }
  for (const dir of COMPARED_JSON_DIRS) {
    let entries
    try {
      entries = await readdir(join(root, dir))
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory && entry.name.endsWith('.json')) out.push(`${dir}/${entry.name}`)
    }
  }

  return out.sort()
}

/**
 * 比对「源码」与「正在跑的安装副本」。
 *
 * 允许不传任何参数：安装副本由本模块自己的位置推出来（跑在副本里，就是副本），
 * 源码由 profile 的 `package.json` 声明推出来。任何一步推不出来都返回
 * `ok: false` + `reason`，**绝不抛** —— 体检的一节坏掉不该让整份体检失败。
 *
 * @param {{
 *   installedDir?: string,
 *   sourceDir?: string,
 *   packageName?: string,
 *   io?: Partial<ReturnType<typeof defaultIo>>,
 *   moduleUrl?: string,
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   linked: boolean,
 *   reason: string,
 *   sourceDir: string,
 *   installedDir: string,
 *   checked: number,
 *   stale: string[],
 *   missing: string[],
 *   extra: string[],
 *   sourceFingerprint: string,
 *   installedFingerprint: string,
 * }>}
 */
export async function comparePluginTrees (options = {}) {
  const io = { ...defaultIo(), ...(options.io ?? {}) }
  const installedDir = resolve(
    options.installedDir ?? pluginRootFromModuleUrl(options.moduleUrl ?? import.meta.url),
  )
  /** @type {string} */
  let sourceDir = options.sourceDir ? resolve(options.sourceDir) : ''

  /** 空结果骨架：所有失败分支都基于它，保证字段形状一致。 */
  const base = {
    ok: false,
    linked: false,
    reason: '',
    sourceDir,
    installedDir,
    checked: 0,
    stale: /** @type {string[]} */ ([]),
    missing: /** @type {string[]} */ ([]),
    extra: /** @type {string[]} */ ([]),
    sourceFingerprint: '',
    installedFingerprint: '',
  }

  // 不在 `node_modules` 下 ⇒ 这份代码就是源码检出本身（自测、探针脚本、直接
  // `node src/...` 跑）。此时不存在「副本落后于源码」这回事，直接说清。
  if (!/[\\/]node_modules[\\/]/.test(installedDir)) {
    return { ...base, ok: true, linked: true, reason: '正在从源码目录直接运行，不存在安装副本' }
  }

  if (sourceDir.length === 0) {
    const packageName = options.packageName ?? '@local/ticket-pipeline'
    // 标准布局（装进 profile）与开发布局（直接从源码目录跑）都要能对上：
    // 先按三层推一次，推不到再沿着路径往上找一个真声明了本地来源的 manifest。
    const standardProfileDir = profileDirFromInstalledDir(installedDir)
    let found = null
    try {
      const text = await io.readFile(join(standardProfileDir, 'package.json'))
      const declared = readLocalDependency(text, packageName)
      if (declared !== null) found = { profileDir: standardProfileDir, declared }
    } catch {
      found = null
    }
    if (found === null) found = await findProfileDir(installedDir, packageName, io.readFile)
    if (found === null) {
      return {
        ...base,
        reason: `从 ${installedDir} 往上找过，没有任何 package.json 声明 ${packageName} 的 file:/link: 本地来源`
          + ' —— 这份安装不是从本地源码装的，无从比较',
      }
    }
    sourceDir = resolveSpecPath(found.profileDir, found.declared.specPath)
    base.sourceDir = sourceDir
  }

  if (sourceDir === installedDir) {
    return { ...base, ok: true, linked: true, reason: '源码目录与安装目录是同一个（链接安装）' }
  }

  // 目录不同也可能指向同一份实物（junction / 符号链接）：这种情况下改源码
  // 即时生效，报「落后」就是假警报。
  try {
    const [realSource, realInstalled] = await Promise.all([io.realpath(sourceDir), io.realpath(installedDir)])
    if (realSource === realInstalled) {
      return { ...base, ok: true, linked: true, reason: '安装目录是指向源码的链接，改完即生效' }
    }
  } catch {
    // realpath 失败（源码目录不存在等）继续往下走，让后续比对给出更具体的原因。
  }

  let sourceFiles
  try {
    sourceFiles = await listComparedFiles(sourceDir, io.readdir)
  } catch (error) {
    return { ...base, reason: `列不出源码目录（${sourceDir}）：${error?.message ?? String(error)}` }
  }
  let installedFiles
  try {
    installedFiles = await listComparedFiles(installedDir, io.readdir)
  } catch (error) {
    return { ...base, reason: `列不出安装目录（${installedDir}）：${error?.message ?? String(error)}` }
  }

  if (sourceFiles.length === 0) {
    return { ...base, reason: `源码目录里没有可比的 .js（${sourceDir}）—— 路径可能配错了` }
  }

  const installedSet = new Set(installedFiles)
  const sourceSet = new Set(sourceFiles)
  /** @type {string[]} */
  const stale = []
  /** @type {string[]} */
  const missing = []
  /** @type {string[]} */
  const extra = []

  /** @type {Array<{ path: string, text: string }>} */
  const sourceEntries = []
  /** @type {Array<{ path: string, text: string }>} */
  const installedEntries = []
  /** @type {Map<string, string>} 免掉同一文件读两遍 */
  const installedTexts = new Map()

  for (const relative of sourceFiles) {
    let sourceText
    try {
      sourceText = await io.readFile(join(sourceDir, relative))
    } catch (error) {
      return { ...base, reason: `读不到源码文件 ${relative}：${error?.message ?? String(error)}` }
    }
    sourceEntries.push({ path: relative, text: sourceText })

    if (!installedSet.has(relative)) {
      missing.push(relative)
      continue
    }
    let installedText
    if (installedTexts.has(relative)) {
      installedText = installedTexts.get(relative)
    } else {
      try {
        installedText = await io.readFile(join(installedDir, relative))
      } catch (error) {
        return { ...base, reason: `读不到安装副本里的 ${relative}：${error?.message ?? String(error)}` }
      }
      installedTexts.set(relative, installedText)
    }
    if (normalizeForCompare(sourceText) !== normalizeForCompare(installedText)) stale.push(relative)
  }

  for (const relative of installedFiles) {
    if (!sourceSet.has(relative)) extra.push(relative)
    // 只把「两边都有」的文件算进副本指纹：副本多出来的文件另算，
    // 混进指纹会让「副本多一个文件」和「某文件内容不同」看起来一样。
    if (sourceSet.has(relative)) {
      if (!installedTexts.has(relative)) {
        try {
          installedTexts.set(relative, await io.readFile(join(installedDir, relative)))
        } catch {
          continue
        }
      }
      installedEntries.push({ path: relative, text: installedTexts.get(relative) ?? '' })
    }
  }

  return {
    ok: true,
    linked: false,
    reason: '',
    sourceDir,
    installedDir,
    checked: sourceFiles.length,
    stale,
    missing,
    extra,
    sourceFingerprint: fingerprintOfEntries(sourceEntries),
    installedFingerprint: fingerprintOfEntries(installedEntries),
  }
}

/**
 * 把比对结果翻成一句「要不要更新」。
 *
 * 只有「源码与副本不一致」才算需要更新；副本多出文件也算（可能是删过一个模块，
 * 旧文件还留在副本里，照样会被 import 到）。
 *
 * @param {Awaited<ReturnType<typeof comparePluginTrees>>} result
 * @returns {boolean}
 */
export function needsUpdate (result) {
  if (!result.ok) return false
  if (result.linked) return false
  return result.stale.length > 0 || result.missing.length > 0 || result.extra.length > 0
}
