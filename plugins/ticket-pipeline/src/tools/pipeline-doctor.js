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
 * 4. **飞书连通性**：拿 token、读表元数据、读第一页数据，逐层报错并给修法。
 * 5. **通知通道**：按 pushAdapter 的实际值查对应凭据齐不齐（不真发消息）。
 * 6. **执行器/通知适配器**：是否还是 mock（mock 能跑通链路但不会真的改代码、发通知）。
 * 7. **插件版本**：正在跑的这份安装副本，是不是比本地源码旧（见下）。
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
 * - **只读**：不改任何文件、不跑任何会写盘的 git 命令、不写飞书任何表格。
 * - **碰飞书，但只读**：连通性检查发的是认证 + 读元数据 + 读第一页，
 *   绝不 setRecord。它不是「健康检查多此一举」——首跑失败里最高的四件事
 *   （权限没开 / 版本没发布 / 表没加协作者 / 通道没凭据）在本地完全看不出来，
 *   只能真连一次才知道；把这些留到「第一张票跑挂」，用户手里一条线索都没有。
 * - **某一项检查抛错不中断其它项** —— 体检就是要一次看到全部问题。
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
import { readConfigWarnings } from '../core/config.js'
import { probeFeishuConnectivity } from '../adapters/source-feishu/probe.js'

/** 「接下来的四步」清单：总开关还关着时追加，回答「我现在还差什么」。 */
const NEXT_STEPS = [
  '接下来四步（都在设置页里，点完这一轮就齐了）：',
  '  1. 「凭据」页签：填 FEISHU_APP_ID 与 FEISHU_APP_SECRET（开放平台 →「凭证与基础信息」）；要用邮件通知再填 QQMAIL_AUTH_CODE。',
  '  2. 飞书开放平台 →「权限管理」加权限 → **创建版本并发布**（不发布版本，权限不生效）。',
  '  3. 「项目」页签：至少配一个项目（仓库路径 + 工单表链接），配完这里再体检一次应当全绿。',
  '  4. 回「行为」组，把最上面的总开关打开 —— 不开它，前面配得再对也不会扫表。',
]

/**
 * @typedef {Object} DoctorOptions
 * @property {(argv: string[], opts?: { cwd?: string }) => Promise<{ code: number, stdout: string, stderr: string }> | null} [gitRunner]
 * @property {() => unknown} getConfig
 * @property {{ available?: () => boolean, describe?: (ref: string) => Promise<{ configured: boolean, source?: string } | undefined> } | null} [credentials]
 * @property {(ref: string) => Promise<string | undefined>} [readSecret] 真读凭据值。只有飞书连通性检查要用
 *   （换 tenant_access_token 必须有明文 secret）；不传就跳过飞书连通性检查。
 * @property {(input: { appId: string, appSecret: string, projects: any[] }) => Promise<any>} [probeFeishu]
 *   飞书连通性探针（自测注入离线桩；缺省用 source-feishu 的实现）。
 * @property {(runner: any, repoPath: string) => Promise<string>} [detectBaseBranch]
 * @property {(remote: string) => Promise<{ ok: boolean, reason?: string }>} [probeRemote]
 * @property {() => Promise<any>} [comparePluginVersion] 覆盖版本比对（自测用；缺省读真实文件系统）
 */

/**
 * 结果类型：一次体检的结论。
 *
 * 三档严重度，语义必须分清 —— 混在一起就没人按它行动了：
 *
 * - `blockers`：**这一步不通就跑不了票**。配了错的东西 / 缺必需的凭据 / 连不上表。
 * - `problems`：能跑，但跑出来的结果大概率不是你想要的（比如远端连不上、仓库不是 git）。
 * - `warnings`：能跑且结果对，只是提醒（mock 执行器、装的是旧版插件）。
 *
 * @typedef {Object} DoctorReport
 * @property {boolean} ok 是否没有「阻断」项
 * @property {string[]} blockers 阻断项（会导致跑不了）
 * @property {string[]} problems 必须修复的问题（能跑但结果不对）
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
const blockers = []
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

// 总开关单独说：`enabled` 缺省是 false，一个全新用户把项目、凭据、仓库都配好之后
// 体检照样「通过」，然后永远等不到票 —— 因为没人告诉他开关还关着。
// 这不算「必须修复的问题」（没装坏），但必须**显式**说出来，不能只躺在提醒里。
const pipelineEnabled = config.enabled === true
if (pipelineEnabled) {
  lines.push('✅ 总开关：已开启，会按 pollIntervalMinutes 自动扫表')
} else {
  lines.push('⏸️ 总开关：关着（enabled=false）——不会自动扫表，也不会跑任何票。'
    + '去设置页「参数」页签把 enabled 打开，或者直接调一次 pipeline_scan 手动跑一轮。')
  warnings.push('流水线总开关是关的（enabled=false）：配好了也不会自动运行，'
    + '需要在设置页「参数」页签打开 enabled（或每次手动 pipeline_scan）。')
}

if (projects.length === 0) {
  warnings.push('没有配置任何项目（projects 为空）——流水线不会监控任何工单表。')
}

// ── 2b. 配置里有没有不生效的键 ──────────────────────
//
// 为什么值得单独一节：`pollInvervalMinutes`（少一个字母）在过去是完全静默的 ——
// 插件照常启动、照常按缺省 3 分钟轮询，人以为自己配了 30 分钟，查半天查不出原因。
// 这类错本地看不出来（配置能加载、票也能跑），只有把「这个键不认识」说出来才有救。
// 只算提醒：老配置里留着已删的键是合法的（见 config.js 的 REMOVED_CONFIG_KEYS）。
const configWarnings = readConfigWarnings(config)
for (const warning of configWarnings) {
  warnings.push(warning)
  lines.push(`⚠️ 配置：${warning}`)
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

  // 缺省模式下 agent 直接在这个检出里改代码、就地提交。检出脏不再挡跑票
  // （跑票前会先拍一份只读基线，结束后只提交 agent 真正改过的文件），
  // 但体检时还是要说清楚有几处未提交改动会让基线变大 —— 人有时候以为自己
  // 只改了一处，其实还留着三天前的半成品。
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
          // 归到 warnings 而不是 problems：脏检出已经不再挡跑票了
          // （跑票前会拍只读基线，结束后只提交 agent 改过的文件）。
          warnings.push(
            `项目 ${name}：检出里有 ${dirty.length} 个未提交改动（${shown}${more}）——`
            + '不影响跑票：插件会先拍一份只读基线，结束后只提交 agent 真正改过的文件，'
            + '你自己这些改动会原样留在工作区。',
          )
          lines.push(`　检出不干净：${dirty.length} 个未提交改动（照跑，只提交 agent 改过的）`)
        }
      }
    } catch (error) {
      warnings.push(`项目 ${name}：检查检出是否干净失败（${error?.message ?? String(error)}）。`)
    }
  }
}

// ── 3. 凭据 ──────────────────────────────────────
//
// 这里要分清两种「拿不到凭据」，因为它们对用户的处理方式完全不同：
//   a. 宿主压根没挂 credentials 服务   —— 装坏了 / 组合不对，得改 profile；
//   b. 服务在，只是这个 ref 还没填      —— 去设置页的「凭据」页签填一下就好。
// 以前两种情况都会走 describe() 然后一律显示成「无法查询」，或者更糟：
// 描述器在 apply 时就缓存成 null，于是明明配好了也永远报「服务不可用」。
const feishuProjects = projects.filter((project) => String(project?.match?.platform ?? '') === 'feishu')
// 要查哪些凭据，取决于**实际配了什么**，不是一张写死的清单。
// 以前不管有没有飞书项目都查 FEISHU_*、不管走哪个通道都不查通道凭据，
// 结果是「体检全绿、通知必挂」—— 查的和用的是两回事。
/** @type {Array<{ ref: string, blocker: boolean, why: string }>} */
const requiredRefs = []
if (feishuProjects.length > 0) {
  requiredRefs.push({ ref: 'FEISHU_APP_ID', blocker: true, why: '飞书扫描要它换 tenant_access_token' })
  requiredRefs.push({ ref: 'FEISHU_APP_SECRET', blocker: true, why: '飞书扫描要它换 tenant_access_token' })
}
const pushAdapter = typeof config.pushAdapter === 'string' ? config.pushAdapter : 'mock'
if (pushAdapter === 'qqmail') {
  requiredRefs.push({ ref: 'QQMAIL_AUTH_CODE', blocker: true, why: 'QQ 邮箱发信要它（不是登录密码，是「授权码」）' })
}
if (pushAdapter === 'pushplus') {
  requiredRefs.push({ ref: 'PUSHPLUS_TOKEN', blocker: true, why: 'PushPlus 推送要它' })
}
// GITLAB_TOKEN 只在开了远程交付时才需要；缺了不算阻断（本阶段交付形态是本地提交）。
requiredRefs.push({ ref: 'GITLAB_TOKEN', blocker: false, why: '只在你打开 repo.gitlab.enabled 之后需要' })
const creds = options.credentials
const credsUsable = Boolean(creds) && typeof creds.describe === 'function'
const credsAvailable = credsUsable
  && (typeof creds.available === 'function' ? creds.available() : true)
if (credsUsable && credsAvailable) {
  for (const item of requiredRefs) {
    const ref = item.ref
    try {
      const hit = await creds.describe(ref)
      if (!hit) {
        // describe 回 undefined = 服务在这一刻没了（刚被卸载），不是「没配」。
        lines.push(`⚠️ 凭据 ${ref}：查询时凭据服务不见了`)
        continue
      }
      const ok = Boolean(hit.configured)
      if (!ok && !item.blocker) {
        lines.push(`ℹ️ 凭据 ${ref}：未配置（${item.why}）`)
        continue
      }
      if (!ok) {
        // 阻断：这一步不过，飞书扫不了表 / 通知发不出去 —— 都是「跑不起来」，不是「跑得不好」。
        blockers.push(`凭据 ${ref} 未配置 —— ${item.why}。去设置页「凭据」页签填一下。`)
      }
      lines.push(`${ok ? '✅' : '❌'} 凭据 ${ref}：${ok ? '已配置' : '未配置（阻断）'}`)
    } catch {
      lines.push(`⚠️ 凭据 ${ref}：无法查询`)
    }
  }
} else if (credsUsable) {
  // 服务描述器在，但此刻 ctx.get('credentials') 还是空的。
  blockers.push(
    '凭据服务没挂上（ctx.get("credentials") 取不到）——飞书扫描读不到 app_secret、'
    + '设置页「凭据」页签也会是空的。这是宿主组合的问题（不是配置问题）：'
    + '确认 profile 里挂了这个凭据服务，或者重新安装插件后完全重启 DSH。',
  )
  lines.push('⚠️ 凭据服务不可用（ctx.get("credentials") 取不到）——见上面的问题说明。')
} else {
  lines.push('ℹ️ 凭据：本插件的体检没有拿到凭据描述器（内部接线问题，不影响跑票）')
}

// ── 4. 通知通道完整性 ────────────────────────────
//
// 凭据查完只是一半：`qqmail` 还必须有收件人与账号，否则凭据齐了也发不出去
// （而且失败发生在「票已经跑完、正要通知你」的时刻，最难发现）。
// 这里**不真发一封**：体检被点开时不该产生外部副作用。
const pushLine = typeof config.pushAdapter === 'string' ? config.pushAdapter : '(默认)'
if (pushAdapter === 'mock') {
  warnings.push('pushAdapter=mock：通知走假推送（不会真的发邮件/微信），消息只写进插件日志。')
  lines.push('ℹ️ 通知：mock（不会真的发；换成 qqmail / pushplus 才会真发）')
} else if (pushAdapter === 'qqmail') {
  const qqmail = config.qqmail ?? {}
  const user = String(qqmail.user ?? '').trim()
  const to = String(qqmail.to ?? '').trim()
  const encryption = qqmail.encryption === 'starttls' ? 'starttls（587）' : 'tls（465）'
  if (user.length === 0 || to.length === 0) {
    const missingField = user.length === 0 ? 'qqmail.user（哪个 QQ 邮箱发的）' : 'qqmail.to（发给谁）'
    blockers.push(`通知通道不完整：pushAdapter=qqmail 但 ${missingField} 没配 —— 票跑完了也发不出通知。去设置页「通知」组填上。`)
    lines.push(`❌ 通知：qqmail 缺 ${missingField}`)
  } else {
    lines.push(`✅ 通知：QQ 邮箱（${user} → ${to}，加密方式 ${encryption}）`)
    lines.push('　体检不会真发一封测试邮件（有副作用）。要验，跑一张 mock 票看日志。')
  }
} else if (pushAdapter === 'pushplus') {
  lines.push('✅ 通知：PushPlus（体检不会真发；要验就跑一张 mock 票看日志）')
} else {
  blockers.push(`pushAdapter=${pushLine} 不是认识的通道（只能是 mock / pushplus / qqmail）——通知不会发出去。`)
  lines.push(`❌ 通知：${pushLine}（不认识的值）`)
}

// ── 5. 飞书连通性 ────────────────────────────────
//
// 这是首跑失败率最高的一块，而它在本地完全看不出来：权限没开、版本没发布、
// 表没把应用加成协作者 —— 三种都会让「看起来配好了」变成「一张票都收不到」。
// 这里真连一次（只读），并且**每一层失败都带修法**。
const probeFeishu = typeof options.probeFeishu === 'function' ? options.probeFeishu : null
const readSecret = typeof options.readSecret === 'function' ? options.readSecret : null
if (feishuProjects.length === 0) {
  lines.push('ℹ️ 飞书连通性：没有 feishu 项目，跳过')
} else if (!probeFeishu || !readSecret) {
  // 没有注入探针（内部接线问题）不该打扰用户，但也不能假装查过了。
  lines.push('ℹ️ 飞书连通性：本次体检没有启用远程探测（内部接线问题，不影响跑票）')
} else {
  let appId = ''
  let appSecret = ''
  try {
    appId = String(await readSecret('FEISHU_APP_ID') ?? '').trim()
    appSecret = String(await readSecret('FEISHU_APP_SECRET') ?? '').trim()
  } catch (error) {
    lines.push(`⚠️ 飞书连通性：读凭据失败（${error?.message ?? String(error)}）`)
  }
  try {
    const probe = await probeFeishu({ appId, appSecret, projects })
    if (probe?.skipped === true) {
      lines.push(`ℹ️ 飞书连通性：${probe.skipReason ?? '跳过'}`)
    } else {
      // 认证层
      if (probe?.token?.ok === true) {
        lines.push(`✅ 飞书认证：${probe.token.message}`)
      } else {
        const fix = probe?.token?.fix ? ` —— 修复：${probe.token.fix}` : ''
        // 错误码要印出来：用户拿它去搜 / 贴给人看，比截一张图有用得多。
        const code = probe?.token?.code !== undefined ? `（飞书错误码 ${probe.token.code}）` : ''
        blockers.push(`飞书认证没过：${probe?.token?.message ?? '原因未记录'}${code}${fix}`)
        lines.push(`❌ 飞书认证：${probe?.token?.message ?? '不通过'}${code}`)
      }
      // 每个项目：元数据 → 数据
      for (const item of probe?.projects ?? []) {
        const name = item?.name ?? '(未命名)'
        if (item?.metadata?.ok === true) {
          lines.push(`✅ 飞书项目 ${name}：${item.metadata.message}`)
        } else if (probe?.token?.ok === true) {
          const fix = item?.metadata?.fix ? ` —— 修复：${item.metadata.fix}` : ''
          const code = item?.metadata?.code !== undefined ? `（飞书错误码 ${item.metadata.code}）` : ''
          blockers.push(`飞书项目 ${name}：读不到表元数据（${item?.metadata?.message ?? '原因未记录'}）${code}${fix}`)
          lines.push(`❌ 飞书项目 ${name}：读不到表元数据（${item?.metadata?.message ?? '原因未记录'}）${code}`)
        }
        if (item?.records?.ok === true) {
          lines.push(`　${item.records.message}`)
        } else if (probe?.token?.ok === true && item?.metadata?.ok === true) {
          const fix = item?.records?.fix ? ` —— 修复：${item.records.fix}` : ''
          const code = item?.records?.code !== undefined ? `（飞书错误码 ${item.records.code}）` : ''
          blockers.push(`飞书项目 ${name}：读不到表里的数据（${item?.records?.message ?? '原因未记录'}）${code}${fix}`)
          lines.push(`　❌ 读不到数据：${item?.records?.message ?? '原因未记录'}${code}`)
        }
      }
    }
  } catch (error) {
    // 探针自己炸了不该让体检失败 —— 记一行，继续。
    lines.push(`⚠️ 飞书连通性：检查过程出错（${error?.message ?? String(error)}）`)
  }
}

// ── 6. 执行器 ────────────────────────────────────
const executor = typeof config.workExecutor === 'string' ? config.workExecutor : '(默认)'
if (executor === 'mock') {
  warnings.push(`workExecutor=mock：工单会走假执行（不真改代码），只验证链路。`)
}
lines.push(`ℹ️ 执行器：${executor}｜通知：${pushLine}`)
// 改代码的落点必须显式说出来：缺省是「直接在项目工作区里改」，
// 这跟「每票一个隔离 worktree」是完全不同的风险面，人不该靠猜。
lines.push(config.isolateWorktree === true
  ? 'ℹ️ 改代码落点：每票一个隔离 worktree（.agents/worktrees/）'
  : 'ℹ️ 改代码落点：项目工作区检出里（脏也能跑，只提交 agent 改过的文件）')

// ── 7. 插件版本 ──────────────────────────────────
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
//
// 三档的边界再强调一次（这里决定了用户按哪一条去行动）：
//   blockers = 这一步不通就跑不了票；problems = 能跑但结果不对；warnings = 只是提醒。
// 「跑不了」和「跑得不好」混在一起时，用户会去修不重要的那条，然后以为自己修好了。
const ok = blockers.length === 0 && problems.length === 0
const summary = ok
  ? `环境体检通过${warnings.length > 0 ? `，但有 ${warnings.length} 条提醒` : ''}。`
  : [
    blockers.length > 0 ? `${blockers.length} 个阻断问题（不修就跑不了票）` : '',
    problems.length > 0 ? `${problems.length} 个必须修复的问题` : '',
  ].filter(Boolean).join('、') + '。'
const text = [
  `【环境体检】${summary}`,
  '',
  ...lines,
  ...(blockers.length > 0 ? ['', '阻断（不修就跑不了票）：', ...blockers.map(b => `· ${b}`)] : []),
  ...(problems.length > 0 ? ['', '必须修复（能跑，但结果大概率不对）：', ...problems.map(p => `· ${p}`)] : []),
  ...(warnings.length > 0 ? ['', '提醒（不挡跑票）：', ...warnings.map(w => `· ${w}`)] : []),
  // 开关关着的时候，人真正的问题往往不是「哪儿配错了」，而是「我下一步该干什么」。
  // 只在人手点开体检时补这段：它不是告警，是一份行动清单。
  ...(!pipelineEnabled ? ['', ...NEXT_STEPS] : []),
].join('\n')

return {
  ok,
  blockers,
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
      '体检当前机器环境：git 执行链路、各项目仓库路径与 remote、凭据配置、'
      + '飞书连通性（能不能换 token / 读到表元数据 / 读到第一页数据，失败会给具体修法）、'
      + '通知通道完整性、执行器与通知适配器状态，以及正在跑的插件是不是比本地源码旧。'
      + '结论分三档：阻断（不修就跑不了票）/ 必须修复（能跑但结果不对）/ 提醒。'
      + '安装插件后或跑票连续失败时先跑一次这个，一次看到全部环境问题。只读，不改任何东西、不写表格。',
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
