#!/usr/bin/env node
/**
 * 把本目录（插件源码）同步到宿主真正加载的**安装副本**。
 *
 * 为什么需要这一步：宿主加载的不是这个目录，而是 profile 下的一份目录副本
 * （`<profile>/node_modules/@local/ticket-pipeline`）。profile 里声明的是
 * `file:` 依赖，但源码在 D:、pnpm store 在 C: —— 跨盘时 pnpm 落成**复制**而不是硬链接，
 * 所以改完源码副本不会自己变。`pnpm install` 也不会刷新它（只会说 Already up to date），
 * HMR 又不监听源码目录。三条叠起来就是「改了代码、没有任何报错、跑的还是旧的」。
 * 详见 `docs/ticket-pipeline/architecture.md` §12.11 与 `pipeline_doctor` 第 5 节。
 *
 * 用法（在插件目录下）：
 *
 *     node scripts/sync-install.mjs              # 同步到找到的所有 profile
 *     node scripts/sync-install.mjs --dry-run    # 只列出要改哪些文件，不动手
 *     node scripts/sync-install.mjs --dir <path> # 只同步到指定目录
 *
 * 同步完必须**完全重启宿主**（桌面包由 Electron 独占管理，刷新页面不算）；
 * `lib/client.js` 是浏览器 bundle，重启会重发。
 */
import { readdirSync, statSync, readFileSync, copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = '@local/ticket-pipeline'

/** 目录副本里不该被我们覆盖的东西（宿主装的依赖、VCS 元数据）。 */
const SKIP_DIRS = new Set(['node_modules', '.git'])

function walk (root, out = [], base = root) {
  for (const name of readdirSync(root)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(root, name)
    if (statSync(full).isDirectory()) walk(full, out, base)
    else out.push(relative(base, full).split('\\').join('/'))
  }
  return out
}

/** 找出这台机器上所有装了本包的 profile 副本目录。 */
function findInstalledDirs () {
  const root = join(homedir(), '.dsh', 'profiles')
  if (!existsSync(root)) return []
  const found = []
  for (const profile of readdirSync(root)) {
    const candidate = join(root, profile, 'node_modules', ...PACKAGE_NAME.split('/'))
    const manifest = join(candidate, 'package.json')
    if (!existsSync(manifest)) continue
    // 只认真是本包的那份：同名不同包（别的插件也占这个 id）不要动。
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
      if (parsed?.name !== PACKAGE_NAME) continue
    } catch {
      continue
    }
    found.push(candidate)
  }
  return found
}

function sameBytes (a, b) {
  const left = readFileSync(a)
  const right = readFileSync(b)
  return left.length === right.length && left.equals(right)
}

function plan (installedDir) {
  const sourceFiles = walk(SOURCE_DIR)
  const installedFiles = walk(installedDir)
  const sourceSet = new Set(sourceFiles)
  const changed = []
  const added = []
  for (const rel of sourceFiles) {
    const target = join(installedDir, rel)
    if (!existsSync(target)) added.push(rel)
    else if (!sameBytes(join(SOURCE_DIR, rel), target)) changed.push(rel)
  }
  // 只删副本里「本包自己的多余文件」。scripts/ 这类源码目录整份同步，多出来的通常是
  // 已经删掉的旧模块（例如 #18 移除的 webform 源），留着会被宿主加载到。
  const removed = installedFiles.filter((rel) => !sourceSet.has(rel))
  return { sourceFiles, changed, added, removed }
}

function sync (installedDir, dryRun) {
  const { sourceFiles, changed, added, removed } = plan(installedDir)
  console.log(`\n${installedDir}`)
  if (changed.length === 0 && added.length === 0 && removed.length === 0) {
    console.log('  ✓ 已经是源码最新，一个字节都不用动')
    return { changed: 0, added: 0, removed: 0 }
  }
  for (const rel of changed) console.log(`  ~ ${rel}`)
  for (const rel of added) console.log(`  + ${rel}`)
  for (const rel of removed) console.log(`  - ${rel}`)
  if (dryRun) {
    console.log(`  （dry-run：会改 ${changed.length} / 加 ${added.length} / 删 ${removed.length}）`)
    return { changed: changed.length, added: added.length, removed: removed.length }
  }
  for (const rel of sourceFiles) {
    const target = join(installedDir, rel)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(SOURCE_DIR, rel), target)
  }
  for (const rel of removed) rmSync(join(installedDir, rel), { force: true })
  console.log(`  → 已同步：改 ${changed.length} / 加 ${added.length} / 删 ${removed.length}`)
  return { changed: changed.length, added: added.length, removed: removed.length }
}

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const dirIndex = args.indexOf('--dir')
let targets
if (dirIndex >= 0) {
  const explicit = args[dirIndex + 1]
  if (!explicit) {
    console.error('--dir 后面要跟一个目录')
    process.exit(2)
  }
  targets = [resolve(explicit)]
} else {
  targets = findInstalledDirs()
}

if (targets.length === 0) {
  console.error(`没找到装了这个插件的 profile 副本（在 ${join(homedir(), '.dsh', 'profiles')} 下找不到 ${PACKAGE_NAME}）。`)
  console.error('如果还没装过，先执行：dsh.cmd plugin --profile desktop add "<本目录的绝对路径>"')
  process.exit(1)
}

let total = { changed: 0, added: 0, removed: 0 }
for (const target of targets) {
  const one = sync(target, dryRun)
  total = {
    changed: total.changed + one.changed,
    added: total.added + one.added,
    removed: total.removed + one.removed,
  }
}

if (!dryRun && total.changed + total.added + total.removed > 0) {
  console.log('\n下一步：**完全退出宿主再启动**（刷新页面不算）。')
  console.log('重启后跑一次 pipeline_doctor，第 5 节不再报「安装副本比源码旧」就对了。')
}
