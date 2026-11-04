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
 * 2. **每个项目的仓库**：路径存在、是 git 仓库（有 .git）、remote 是否还是
 *    `gitlab.example.com` 占位符（占位符会导致 fetch/MR 全部失败）。
 * 3. **凭据**：用 credentials.describe()（只说配没配，绝不返回值）。
 * 4. **执行器/通知适配器**：是否还是 mock（mock 能跑通链路但不会真的改代码、发通知）。
 *
 * ## 边界
 *
 * - **只读**：不改任何文件、不跑任何会写盘的 git 命令。
 * - **不碰飞书**：连通性检查需要网络且会消耗接口配额，另在 scan 里天然覆盖。
 * - 某一项检查抛错不中断其它项 —— 体检就是要一次看到全部问题。
 */

import { defineTool, textBlocks } from './define.js'

/**
 * @param {Object} options
 * @param {(argv: string[], opts?: { cwd?: string }) => Promise<{ code: number, stdout: string, stderr: string }> | null} options.gitRunner
 * @param {() => unknown} options.getConfig
 * @param {{ describe?: (ref: string) => Promise<{ configured: boolean, source?: string } | undefined> } | null} [options.credentials]
 * @returns {Record<string, unknown>}
 */
export function createPipelineDoctorTool (options) {
  return defineTool({
    name: 'pipeline_doctor',
    description:
      '体检当前机器环境：git 执行链路、各项目仓库路径与 remote、凭据配置、执行器与通知适配器状态。'
      + '安装插件后或跑票连续失败时先跑一次这个，一次看到全部环境问题。只读，不改任何东西。',
    parameters: {},
    outputSchema: { type: 'object' },
    render: (value) => textBlocks(value.text),
    async execute (args, exec) {
      void args
      void exec

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
        if (remote.length === 0) {
          warnings.push(`项目 ${name}：repo.remote 没配 —— fetch/PR 将无法进行。`)
        } else if (/gitlab\.example\.com|example\.com|placeholder/i.test(remote)) {
          warnings.push(`项目 ${name}：repo.remote 还是占位符（${remote}）——需要换成真实 GitLab 地址。`)
          remoteNote = '（占位符！）'
        }
        lines.push(`${mark} 项目 ${name}（${platform}）：仓库 ${path}${exists ? '' : ' ⚠️ 不可用'}${remoteNote}`)
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
              warnings.push('凭据 GITLAB_TOKEN 未配置 —— 真 executor 开 MR 时才需要，mock 模式不影响。')
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
    },
  })
}
