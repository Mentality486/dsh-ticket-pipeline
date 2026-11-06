/**
 * `pipeline_doctor` —— 安装/激活后对当前机器环境做一次体检。
 *
 * ## 为什么要有这个工具
 *
 * 插件对宿主环境有几个「不满足就在跑票时才炸」的依赖，而炸的时刻越晚越难定位：
 * git 路径解析了但裸 spawn 被系统策略拒（EPERM/ENOENT）、仓库路径写错、
 * repo.remote 还是文档占位符、凭据没配……这些问题在首张票执行前完全不可见。
 * 这个工具把「跑票时才炸」变成「装完就告诉你」，一次调用覆盖全部环境依赖。
 *
 * ## 它查什么
 *
 * 1. **git 执行链路**：优先走 `ctx.shell`（bash -c，Windows 沙箱下唯一能落地的路径），
 *    跑 `git --version`；不可用时退回 `ctx.subprocess` 探测。两种都不行会给出明确提示。
 * 2. **每个项目的仓库**：路径存在、是 git 仓库（有 .git）、remote 能不能真的连上
 *    （走 `git ls-remote` 握手；连不上意味着 fetch/MR 全部失败）。
 * 3. **凭据**：用 credentials.describe()（只说配没配，绝不返回值）。
 * 4. **执行器/通知适配器**：是否还是 mock（mock 能跑通链路但不会真的改代码、发通知）。
 * 5. **插件版本**：正在跑的这份安装副本，是不是比本地源码旧（见下）。
 *
 * ## 为什么要查版本
 *
 * 插件装进 profile 时落的是**目录副本**（跨盘 pnpm 不落硬链接），而 HMR 不监听
 * 源码目录、`pnpm install` 也不会刷新它。于是「改完代码忘了同步」表现为
 * **跑的是旧代码、但一句报错都没有** —— 最难查的一类故障。这一节把它变成
 * 体检里的一行字，并给出同步命令。详见 `core/plugin-version.js`。
 *
 * 这一项只进 `warnings`、不进 `problems`：装的是旧版插件，票照样能跑完，
 * 只是跑的可能是旧逻辑。把它算成「必须修复」会让人以为流水线不可用。
 *
 * ## 边界
 *
 * - **只读**：不改任何文件、不跑任何会写盘的 git 命令。
 * - **不碰飞书**：连通性检查需要网络且会消耗接口配额，另在 scan 里天然覆盖。
 * - 某一项检查抛错不中断其它项 —— 体检就是要一次看到全部问题。
 *
 * ## 两个调用方
 *
 * 逻辑只在 `runDoctor()` 里写一份：
 *
 * 1. `pipeline_doctor` 工具（agent 侧，`createPipelineDoctorTool`）；
 * 2. 宿主 typert Remote 的 `doctor()`（GUI 侧，设置页的「立即体检」按钮）。
 *
 * 两边必须看到同一份结论，所以不允许各写一份。
 */

import { defineTool, textBlocks } from './define.js'
import { PLUGIN_WORKTREE_PATHSPEC_EXCLUDES, PORCELAIN_STATUS_ARGS, parseStatusZ } from '../contracts/git-status.js'
import { comparePluginTrees, needsUpdate } from '../core/plugin-version.js'

/**
 * @typedef {Object} DoctorOptions
 * @property {(argv: string[], opts?: { cwd?: string }) => Promise<{ code: number, stdout: string, stderr: string }> | null} [gitRunner]
 * @property {() => unknown} getConfig
 * @property {{ describe?: (ref: string) => Promise<{ configured: boolean, source?: string } | undefined> } | null} [credentials]
 * @property {(runner: any, repoPath: string) => Promise<string>} [detectBaseBranch]
 * @property {(remote: string) => Promise<{ ok: boolean, reason?: string }>} [probeRemote]
 * @property {() => Promise<any>} [comparePluginVersion] 覆盖版本比对（自测用；缺省读真实文件系统）
 */

/**
 * 结果类型：一次体检的结论。
 *
 * @typedef {Object} DoctorReport
 * @property {boolean} ok 是否没有「必须修复」的问题
 * @property {string[]} problems 必须修复的问题
 * @property {string[]} warnings 提醒（不挡跑票）
 * @property {string} text 给人看的整段文案（工具渲染与 GUI 都用它）
 */

/**
 * 跑一次环境体检。
 *
 * @param {DoctorOptions} options
 * @returns {Promise<DoctorReport>}
 */
export async function runDoctor (options) {
const lines = []
const problems = []
const warnings = []

// ── 1. git 执行链路 ──────────────────────────────
let gitOk = false
let gitVersion = ''
if (typeof options.gitRunner === 'function') {
  try {
    const r = await options.gitRunner(['--version'], {})
    if (r.code === 0) {
      gitOk = true
      gitVersion = r.stdout.trim()
      lines.push(`✅ git：${gitVersion || '可用'}`)
    } else {
      problems.push(`git 命令退出码 ${r.code}：${r.stderr.slice(0, 200)}`)
    }
  } catch (error) {
    problems.push(`git 执行失败：${error?.message ?? String(error)}`)
  }
} else {
  problems.push('git 执行链路不可用（ctx.shell 与 ctx.subprocess 都没拿到）——工单将无法建 worktree，跑票必失败。')
}
if (!gitOk) {
  lines.push('❌ git：不可用')
}

// ── 2. 项目仓库 ──────────────────────────────────
const config = options.getConfig() ?? {}
const projects = Array.isArray(config.projects) ? config.projects : []
if (projects.length === 0) {
  warnings.push('没有配置任何项目（projects 为空）——流水线不会监控任何工单表。')
}
for (const project of projects) {
  const name = project?.name ?? '(未命名)'
  const repo = project?.repo ?? {}
  const path = typeof repo.path === 'string' ? repo.path : ''
  const remote = typeof repo.remote === 'string' ? repo.remote : ''
  const platform = project?.match?.platform ?? 'mock'

  if (path.length === 0) {
    problems.push(`项目 ${name}：repo.path 没配。`)
    lines.push(`❌ 项目 ${name}（${platform}）：仓库路径未配置`)
    continue
  }
  let exists = false
  try {
    if (typeof options.gitRunner === 'function') {
      // 用 git 自身做存在性 + 仓库判定，顺带覆盖 .git 目录检测：
      const r = await options.gitRunner(['rev-parse', '--is-inside-work-tree'], { cwd: path })
      exists = r.code === 0 && r.stdout.trim() === 'true'
      if (!exists) {
        problems.push(`项目 ${name}：${path} 不是可用的 git 仓库（${r.stderr.split('\n')[0]?.slice(0, 120) || '路径不存在或不是仓库'}）。`)
      }
    } else {
      exists = false
      problems.push(`项目 ${name}：git 不可用，无法检查仓库 ${path}。`)
    }
  } catch (error) {
    problems.push(`项目 ${name}：检查仓库失败（${error?.message ?? String(error)}）。`)
  }
  const mark = exists ? '✅' : '❌'
  let remoteNote = ''
  const wantRemote = repo?.gitlab?.enabled === true
  if (remote.length === 0 && wantRemote) {
    warnings.push(`项目 ${name}：repo.gitlab.enabled 是 true 但 repo.remote 没配 —— 远程 MR 开不出来。`)
  } else if (remote.length === 0) {
    // 本阶段交付形态是「工作区检出里的本地提交」，没有 remote 完全正常，不打扰人。
  } else if (!wantRemote) {
    remoteNote = '，只做本地提交（remote 未启用）'
  } else if (typeof options.probeRemote === 'function') {
    // 只按域名猜「是不是占位符」是不可靠的：`gitlab.example.com` 在某些内网部署里
    // 就是真服务器（猜错 = 把健康配置报成故障），而真正连不上的地址反而不一定长得像占位符。
    // 所以这里真的握一次手（`git ls-remote`，只读），连不上才提醒，并把 git 的原话带出来。
    try {
      const probe = await options.probeRemote(remote)
      if (probe?.ok) {
        remoteNote = '，remote 已连通'
      } else {
        const why = String(probe?.reason ?? '').trim()
        warnings.push(`项目 ${name}：repo.remote 连不上（${remote}）${why ? `—— git 说：${why}` : ''}。`)
        remoteNote = '（remote 连不上！）'
      }
    } catch (error) {
      warnings.push(`项目 ${name}：探测 repo.remote 失败（${error?.message ?? String(error)}）。`)
      remoteNote = '（remote 未探测）'
    }
  } else {
    remoteNote = '，remote 未探测'
  }
  // 基准分支：没显式配就去仓库里认，认不出来要说清（猜错分支 = fetch 直接失败）。
  let branchNote = ''
  const configuredBase = typeof repo.baseBranch === 'string' ? repo.baseBranch.trim() : ''
  if (exists) {
    if (configuredBase.length > 0) {
      branchNote = `，基准分支 ${configuredBase}`
    } else if (typeof options.detectBaseBranch === 'function') {
      try {
        const detected = await options.detectBaseBranch(options.gitRunner, path)
        branchNote = `，基准分支 ${detected}（自动识别，建议写进 repo.baseBranch）`
        if (detected === 'main') {
          warnings.push(`项目 ${name}：仓库里认不出主干分支，回退到 main —— 若主干不叫 main，fetch 一定失败，请显式配 repo.baseBranch。`)
        }
      } catch {
        branchNote = '，基准分支未知'
      }
    }
  }
  lines.push(`${mark} 项目 ${name}（${platform}）：仓库 ${path}${branchNote}${exists ? '' : ' ⚠️ 不可用'}${remoteNote}`)

  // 缺省模式下 agent 直接在这个检出里改代码、就地提交，所以「检出现在干净吗」
  // 是能不能开工的前提：不干净的话每张票都会以 invalid-input 失败。
  // 体检时就把这件事说出来，别等人跑票才看到。
  //
  // 参数与 `inspectCheckout`（src/index.js）必须一致：-z 免掉引号转义、-uall 展开
  // 未跟踪目录（否则人放进新目录的 .env 看不见）、排除插件自己的 .agents/worktrees
  // （否则每个开过隔离 worktree 的项目都会被报成脏）。三处口径不一致最难查。
  if (exists && config.isolateWorktree !== true && typeof options.gitRunner === 'function') {
    try {
      const status = await options.gitRunner(
        ['status', ...PORCELAIN_STATUS_ARGS, '--', '.', ...PLUGIN_WORKTREE_PATHSPEC_EXCLUDES],
        { cwd: path },
      )
      if (status.code !== 0) {
        problems.push(`项目 ${name}：看不了检出状态（git status 退出码 ${status.code}）：${String(status.stderr ?? '').split('\n')[0]?.slice(0, 160) || '没有输出'}。`)
      } else {
        const dirty = parseStatusZ(status.stdout).map((record) => `${record.code.trim()} ${record.path}`)
        if (dirty.length === 0) {
          lines.push(`　检出干净，可以直接跑票`)
        } else {
          const shown = dirty.slice(0, 5).join('、')
          const more = dirty.length > 5 ? `等 ${dirty.length} 个` : ''
          warnings.push(
            `项目 ${name}：检出里有 ${dirty.length} 个未提交改动（${shown}${more}）——`
            + '缺省模式下每张票都会因为「工作区不干净」被拒。提交或 stash 之后再跑，'
            + '或者把配置项 isolateWorktree 打开让每票用独立隔离目录。',
          )
          lines.push(`　⚠️ 检出有 ${dirty.length} 个未提交改动（跑票会被拒）`)
        }
      }
    } catch (error) {
      warnings.push(`项目 ${name}：检查检出是否干净失败（${error?.message ?? String(error)}）。`)
    }
  }
}

// ── 3. 凭据 ──────────────────────────────────────
const creds = options.credentials
if (creds && typeof creds.describe === 'function') {
  for (const ref of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'GITLAB_TOKEN']) {
    try {
      const hit = await creds.describe(ref)
      const ok = Boolean(hit?.configured)
      if (!ok && ref !== 'GITLAB_TOKEN') {
        warnings.push(`凭据 ${ref} 未配置 —— 飞书扫描将无法工作。`)
      }
      if (!ok && ref === 'GITLAB_TOKEN') {
        // 本阶段不需要：交付形态是工作区里的本地提交，不连远程、不开 MR。
        lines.push('ℹ️ 凭据 GITLAB_TOKEN：未配置（本阶段不需要）')
        continue
      }
      lines.push(`${ok ? '✅' : '⚠️'} 凭据 ${ref}：${ok ? '已配置' : '未配置'}`)
    } catch {
      lines.push(`⚠️ 凭据 ${ref}：无法查询`)
    }
  }
} else {
  lines.push('⚠️ 凭据服务不可用（ctx.credentials 缺席）——飞书扫描无法读取 app_secret。')
}

// ── 4. 执行器与通知 ──────────────────────────────
const executor = typeof config.workExecutor === 'string' ? config.workExecutor : '(默认)'
const push = typeof config.pushAdapter === 'string' ? config.pushAdapter : '(默认)'
if (executor === 'mock') {
  warnings.push(`workExecutor=mock：工单会走假执行（不真改代码），只验证链路。`)
}
if (push === 'mock') {
  warnings.push('pushAdapter=mock：通知走假推送（不会真的发邮件/微信）。')
}
lines.push(`ℹ️ 执行器：${executor}｜通知：${push}`)
// 改代码的落点必须显式说出来：缺省是「直接在项目工作区里改」，
// 这跟「每票一个隔离 worktree」是完全不同的风险面，人不该靠猜。
lines.push(config.isolateWorktree === true
  ? 'ℹ️ 改代码落点：每票一个隔离 worktree（.agents/worktrees/）'
  : 'ℹ️ 改代码落点：项目工作区检出里（要求检出干净）')

// ── 5. 插件版本 ──────────────────────────────────
// 「跑的是旧代码」不会报错，只表现为旧行为，所以必须主动比一次。
// 基准是 profile 里声明的 file:/link: 源码目录，比的是会真被加载的那些文件。
// 只进 warnings：装旧版插件票照样跑得完，算成 problems 会让人以为流水线坏了。
try {
  const compare = typeof options.comparePluginVersion === 'function'
    ? options.comparePluginVersion
    : () => comparePluginTrees()
  const version = await compare()
  if (version?.ok === true && version.linked === true) {
    lines.push(`✅ 插件版本：${version.reason || '安装目录就是源码'}`)
  } else if (version?.ok === true) {
    const needs = needsUpdate(version)
    if (needs) {
      const parts = []
      if (version.stale.length > 0) parts.push(`${version.stale.length} 个文件内容不同`)
      if (version.missing.length > 0) parts.push(`副本缺 ${version.missing.length} 个`)
      if (version.extra.length > 0) parts.push(`副本多 ${version.extra.length} 个`)
      const shown = [...version.stale, ...version.missing, ...version.extra].slice(0, 5).join('、')
      warnings.push(
        `插件不是最新：正在跑的安装副本比源码旧（${parts.join('，')}：${shown}`
        + `${version.stale.length + version.missing.length + version.extra.length > 5 ? ' 等' : ''}）——`
        + `此时跑的是旧代码，改动没生效。把 ${version.sourceDir} 同步到 ${version.installedDir}，然后重启宿主。`,
      )
      lines.push(`⚠️ 插件版本：安装副本比源码旧（${parts.join('，')}）`)
      lines.push(`　源码 ${version.sourceFingerprint} ↔ 副本 ${version.installedFingerprint}（共比 ${version.checked} 个文件）`)
    } else {
      lines.push(`✅ 插件版本：安装副本与源码一致（共比 ${version.checked} 个文件，指纹 ${version.sourceFingerprint}）`)
    }
  } else {
    // 比不出来不算故障：可能是从 registry 装的、或 profile 结构不是预期的。
    lines.push(`ℹ️ 插件版本：无法比对（${String(version?.reason ?? '').trim() || '原因未知'}）`)
  }
} catch (error) {
  lines.push(`ℹ️ 插件版本：检查失败（${error?.message ?? String(error)}）`)
}

// ── 汇总 ─────────────────────────────────────────
const ok = problems.length === 0
const summary = ok
  ? `环境体检通过${warnings.length > 0 ? `，但有 ${warnings.length} 条提醒` : ''}。`
  : `发现 ${problems.length} 个必须修复的问题。`
const text = [
  `【环境体检】${summary}`,
  '',
  ...lines,
  ...(problems.length > 0 ? ['', '必须修复：', ...problems.map(p => `· ${p}`)] : []),
  ...(warnings.length > 0 ? ['', '提醒（不挡跑票）：', ...warnings.map(w => `· ${w}`)] : []),
].join('\n')

return {
  ok,
  problems,
  warnings,
  text,
}
}

/**
 * `pipeline_doctor` 工具：把 `runDoctor()` 的 `text` 直接回给模型。
 *
 * @param {DoctorOptions} options
 * @returns {Record<string, unknown>}
 */
export function createPipelineDoctorTool (options) {
  return defineTool({
    name: 'pipeline_doctor',
    description:
      '体检当前机器环境：git 执行链路、各项目仓库路径与 remote、凭据配置、执行器与通知适配器状态，'
      + '以及正在跑的插件是不是比本地源码旧。'
      + '安装插件后或跑票连续失败时先跑一次这个，一次看到全部环境问题。只读，不改任何东西。',
    parameters: {},
    outputSchema: { type: 'object' },
    render: (value) => textBlocks(value.text),
    async execute (args, exec) {
      void args
      void exec
      return runDoctor(options)
    },
  })
}
