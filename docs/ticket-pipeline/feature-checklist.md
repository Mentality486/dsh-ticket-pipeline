# 工单流水线插件 · 功能清单与完成度

> 生成日期：2026-11-05
> 代码基线：工作区 `D:\WorkSpace\dsh-ticket-pipeline`（git 65 次提交，HEAD `0b9dcff`），插件目录 `plugins/ticket-pipeline`
> 最近一次更新：2026-11-06，新增四项改造 —— **处理完回填工单表**（`TicketSource.writeResult` 唯一写入口 + `writeBack` / `writeBackStatus`）、**处理完保留会话**（`ExecResult.sessionId` + `keepSession`）、**只提交 agent 真正改过的文件**（`createBaseline` 用 `git stash create` 拍基线，脏工作区也能跑，`assertCleanCheckout` 删除）、**设置面板补齐**（`projects` 子树可编辑 + 第 3 个 Remote 方法 `ticketPipeline.projects()`，配置变 33 键 / 7 组）、**选择分支**（`repo.baseBranch` / `repo.targetBranch` 从手打改成带候选的输入框，第 4 个 Remote 方法 `ticketPipeline.branches()`，见 §1.12），自测 **325/325** 全绿；此前同日新增「插件版本自检」（`src/core/plugin-version.js` + `pipeline_doctor` 第 5 节：比 profile 里声明的源码目录与安装副本的**文件内容**，不落后才静默，落后就给出同步命令），自测 294/294；此前同日新增「本地提交」改造（交付形态改为在项目工作区的检出里做一次真实本地提交，远程 GitLab draft MR 降级为 `repo.gitlab.enabled: true` 才走的可选出口）+ 当晚的「改代码落点」改造（`isolateWorktree` 缺省 `false`：直接在项目工作区的检出里改，检出脏也能跑；`true` 才每票开隔离 worktree）+ 改动收集改走 `git -z`（未跟踪新文件、重命名、中文名/空格名、`.agents/worktrees` 污染四个坑一并修掉），自测 285/285；2026-11-05 深夜的「项目工作区」改造（票 → 项目 → 宿主 Workspace 登记，会话 cwd = 工作区根）自测 262/262；再此前 `26f0391` 把收窄开关推广到三个源、「待修改项目」列不再丢、飞书截图白名单可配，连同 `5b94a17` 的 agent 侧四项，自测 242/242。同日另出「飞书电子表格支持」设计（**设计已定、尚未实施**，见 `docs/ticket-pipeline/feishu-sheet-source.md` 与 `docs/adr/0005-飞书电子表格源按表型分派.md`，5 人日）
> 口径声明：**本文只写代码里真实存在且已验证的东西**。凡是「打算做」「应该做」的一律进第 9 章「未完成与缺陷清单」，不混进完成项。所有行号取自本文生成时的源码。

---

## 0. 一句话结论

骨架和主链路已经成型：**飞书工单表 → 解析工单四要素 → 项目工作区里（缺省直接在检出里，`isolateWorktree: true` 才切隔离 worktree）改码 → 跑验证 → 在工作区检出里做本地提交 → QQ 邮箱 / PushPlus 通知** 这条链在沙盒项目上真跑通过一次（当时的交付物是一条远程 draft MR !1，不是假对象；现在同一条链的交付物已经改成工作区里的本地提交）。

但**真实业务项目（mgiot-pms）的工单还没有完整跑绿一次**。截至 `26f0391`，轮子上的雷基本排干净了：agent 侧四项（模型默认补齐、preset 缺服务硬失败、`repo.gitlab` 透传、verify 命令引号）在 `5b94a17` 修完；收窄开关推广到四个源、「待修改项目」列不再被丢弃、飞书截图白名单可配 在 `26f0391` 修完。**剩下真正挡路的只有三样**：**上游模型配额**（workbuddy 429，非插件缺陷）、**金山文档源缺开放平台取数通道**（需金山账号与管理员审批）、**飞书表本身没有「待修改项目」这一列**（平台事实，不是代码缺陷 —— 真实表的列只有序号/发现部门/问题描述/发现日期/模块/操作流程/截图/优先级/是否处理/处理人/处理结果/处理日期）。

> 已修（`5b94a17` 入树）：agent 侧四个最挡路的雷 —— ① `{{model}}` 模板崩（新增 `resolveAgentOptions`，配置缺的从宿主 `agentDefaultModel.currentSelection()` 补齐，两项成对下发）② preset 服务缺失只记日志（改为**硬失败** `invalid-input`，把真因暴露出来）③ `repo.gitlab` 被配置校验层吞掉（透传 baseUrl/remote/projectId）④ verify 命令只按空白切（认引号，引号内反斜杠当字面量）。
> 已修（`26f0391` 入树）：① 收窄开关 `match.recordIds` 从飞书一源推广到**飞书 / 金山 / mock / webform 四个源**（名单外的行整行跳过，不收票也不进水位）② 金山表「待修改项目」列的值不再丢（进 `Ticket.targetProject`，进任务书，但**不顶 `projectId`**）③ 飞书截图外链白名单有了配置键 `match.allowedImageHosts`（缺省依旧全拒，只放行人点名的主机名）。

| 口径 | 完成度 |
| --- | --- |
| 按用户 6 条需求逐条算 | 4 条可用 / 2 条部分可用 / 0 条空白 |
| 按工程完成度（代码 + 自测 + 文档） | 约 75% |
| 按「能直接上生产接真实工单」算 | 约 60%（agent 侧四个雷 + 三个源收窄 + 「待修改项目」列 + 截图白名单，共 8 处已修；剩金山取数通道、上游模型配额两项外部依赖，以及真实 pms 票尚未复跑成功一次） |
| 架构骨架完成度 | 约 85% |

**不需要推倒重来。** 内核（契约 / 存储 / 调度 / 错误模型）已经是零平台知识的干净分层，重构代价远大于补齐缺口。详见第 10 章。

---

## 1. 用户原始需求逐条对照

| # | 需求（原始表述） | 状态 | 真实依据 | 差在哪 |
| --- | --- | --- | --- | --- |
| ① | AI 同时监控多个平台（金山共享 Excel、飞书）上的工单表，检测内容变化 | **✅ 可用** | 飞书源 1384 行，已接真实表（appToken `RZZQbY4SkaY6z0shZaBcVpQCnhh` / table `tblWhRSGf0osJqrE`，79 条记录实测）；金山源 1360 行（xlsx/zip 自解 OOXML）；webform/mock 演示源 | 金山缺开放平台取数通道，只能用注入的 `fetchSheet`；飞书「收票状态值」与真实表语义不一致，已做成可配（`statusValues`） |
| ② | 可以在插件中配置对应工单的项目本地仓库地址 | **✅ 可用** | `projects[].repo.path` / `remote` / `baseBranch` / `targetBranch` / `gitlab`（enabled / baseUrl / projectId / remote），由 `locator-table`（187 行）把工单 projectId 映射到仓库；`repo.gitlab` 已能在配置校验层存活（`5b94a17`），`gitlab.enabled` 是远程 MR 出口总开关、缺省 `false` | 无（这项已补齐） |
| ③ | 解析每张工单中的待修改项目、问题描述、操作流程及截图 | **⚠️ 部分** | 飞书列映射 `FEISHU_COLUMNS`（描述/操作流程/截图/模块/优先级/发现日期等）；金山列别名表 `xlsx.js:34-42`（含「待修改项目」）；截图三形态（附件 / 路径 / URL）都已建模并作为 `ImageBlock` 进消息 | ① 飞书表**没有「待修改项目」列**（实测列名只有：序号/发现部门/问题描述/发现日期/模块/操作流程/截图/优先级/是否处理/处理人/处理结果/处理日期）；② ~~金山表该列的值被丢弃~~ → **已修（`26f0391`）**：金山表该列的值现在进 `ticket.targetProject` 并写进任务书（不顶 `projectId` —— 那是存储主键的一半，而这一列是人手填的自由文本）；③ ~~URL 形态截图默认全拒、无配置键~~ → **已修（`26f0391`）**：新增 `match.allowedImageHosts` 白名单配置键（缺省仍为空 = 一律拒绝，安全闸门只有人能打开） |
| ④ | 自主规划并执行修复 | **⚠️ 部分** | `executor-agent` 真实现：先确保**项目工作区**（`repo.path` 目录在宿主 `workspaceRegistry` 里登记，一个项目一条，多票共用）→ `agents.create({meta:{cwd: workspacePath}})` + 挂 preset + （仅 `isolateWorktree: true` 时）`workingDirectory.set(worktreePath)` + `attachSession` 归属工作区 + followup + `git diff --name-status` 收集改动 + 敏感文件过滤；沙盒票 `sandbox\|rec-mock-001` 已由 agent 真改出 `src/pagination.js`，当轮开成 MR !1（**本轮改成在工作区检出里做本地提交**，见 §1.2） | 真实业务票（pms）只在配额上卡过一次；两处宿主侧雷已修（`5b94a17`：`{{model}}` 补齐、preset 缺服务硬失败），但**尚未在真实 pms 票上完整跑绿一次**（上游 workbuddy 429 配额限制，非插件缺陷） |
| ⑤ | 完成后对问题功能进行测试，自动提交 PR | **✅ 基本可用** | 真跑出 GitLab draft MR `http://gitlab.example.com/mk/end/ticket-pipeline-sandbox/-/merge_requests/1`（sha `634777aa…`，changes_count=1，源分支 `ticket-sandbox-rec-mock-001-r1`）；验证命令从 `projects[].verify.build/test` 注入，`verify.test` 真跑出 exit 0。**本轮起默认交付形态改成工作区检出里的本地提交**（`commitLocally` → `ExecResult.commit = {sha, branch, files}`），远程 draft MR 变成 `repo.gitlab.enabled: true` 才走的可选出口 | 没配验证命令时 `phase` 仍是 `done`（契约里 `skipped` 是合法成功路径），现在把验证结论写进提交说明以免误读（`5b94a17`）；要彻底区分得新增 phase，属契约变更 |
| ⑥ | 通过微信 Clawbot 推送或 QQ 邮箱推送（先实现）完成通知，收到后看 PR 详情，人工验证后手动合并 | **✅ QQ 邮箱可用；微信走中继** | QQ 邮箱零依赖 SMTP 适配器（574 行）已真实发信成功（traceId `<mw319ltk.47861f8c479221d3@qq.com>`）；PushPlus 适配器 171 行 | 插件**不直连微信**：微信消息经 PushPlus 的 `clawbot` 渠道中继，需配 `pushplus.token`；PushPlus 回执未消费 |

### 1.1 端到端真实跑通记录（唯一一次全绿的真实链路）

工单：`sandbox|rec-mock-001` —— 沙盒仓库的「列表页按状态筛选后，翻到第二页会跳回第一页」。

| 环节 | 实际结果 |
| --- | --- |
| 扫描入队 | 水位对比识别为新票，进 `pending` |
| 工作区 | 先确保 `repo.path` 这个目录在宿主 `workspaceRegistry` 里有一份登记（一个项目一条，多票共用）；当轮（2026-11-05）再 `git worktree add` 建本票的隔离检出 `.agents/worktrees/ticket-sandbox-rec-mock-001-r1`，会话 header 的 cwd 是工作区根、`workingDirectory` 钉到 worktree。**现在缺省不再切 worktree**：直接在工作区检出里改（要求检出干净），`isolateWorktree: true` 才退回这一条 |
| 改码 | agent 改 `src/pagination.js` |
| 验证 | `verify.test` 退出码 0 → `passed` |
| 提 MR | GitLab draft MR !1（opened, draft, 源分支→main）—— 那是 2026-11-05 的交付形态；本轮起改为在工作区检出里做本地提交（见 §1.2） |
| 通知 | 按配置走（当时为 mock） |
| 票态 | `done`，`testOutcome=passed`，`baseCommit=a6e3509…` |

其余 4 张票的失败原因（权威来源：`C:/Users/Administrator/.dsh/storages/ticket_pipeline.json` 的 `tables.tickets`）：

| 票 | 状态 | 失败原因（票面文案） | 真因 | 现状 |
| --- | --- | --- | --- | --- |
| `pms\|reczz28VWNWVbpgL` | done | —— | mock 执行器，交付物是假的（当初是 `mock://draft-mr/...`，现在改成 `sha` 以 `mock` 开头的假 commit） | 仍是假对象，需要重跑 |
| `pms\|reczz28VWNWVefNA` | failed | `internal: agent 没有产生任何文件改动` | **上游 workbuddy HTTP 429 / `quota_exceeded`**（重置时间 2026-11-05 17:09:35 +08:00），agent 一轮都没跑起来 | 已在 `1f788cb` 修：解码 agent 会话 `turn/end` 的 `reason.error.code`，限流转 `rate-limit` 并**抛出**（抛出才进内核退避队列） |
| `sandbox\|rec-mock-002` | failed (attempt 2) | `internal: agent 这一轮以错误结束：prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")` | 配置里 `model` 留空 → 宿主渲染系统提示时 `{{model}}` 无值 | 已在 `5b94a17` 修：`resolveAgentOptions` 从宿主 `agentDefaultModel.currentSelection()` 补齐 provider/model |
| `sandbox\|rec-mock-003` | failed (attempt 2) | 同上 | 同上 | 同上 |

### 1.2 「本地提交」改造（2026-11-06，工作树未提交）

这一轮把**交付形态**从「开一条远程 GitLab draft MR」换成「在项目工作区的检出里做一次真实本地提交」。动机有两层：
本阶段验收只要求工作区里有可 review 的提交，`GITLAB_TOKEN` 与远端连通性不该成为交付的前置条件；而 `git push` 在本机沙箱里本来就不可用（见架构 §12.2），
为把改动送到远端而绕道 GitLab Commits API 属于额外复杂度，不该是唯一出口。

| 项 | 改造前 | 改造后 |
| --- | --- | --- |
| 执行器阶段 | `editing` → `testing` → `mr-opening`（开 draft MR） | 阶段名**保留** `mr-opening`，语义变成「在工作区检出里做本地提交」 |
| 执行器返回值 | `ExecResult.mr = { iid, url, draft }` | `ExecResult.commit = { sha, branch, files }`；`mr` 保留但只是可选出口 |
| 契约校验 | `phase=done/skipped` 必须给 `mr` | `phase=done/skipped` 必须给 `commit` 或 `mr` **之一** |
| 敏感文件 | 过滤掉不提交，仍照常开 MR | **点名暂存**：`git add -- <非敏感文件>`，再 `git commit -m <说明> -- <非敏感文件列表>`；敏感文件连 index 都进不去、留在工作区，文件名写进提交说明的「未提交」一行。**不用 `git add -A`** —— 全量暂存会让 `A application.yml` 露在 index 里，手一抖就提交走了；git 白名单也只放行 `add -- <文件>`，`add -A` / `add .` 一律拒绝。若 agent 自己把它 `git add` 进去过，`unstageSensitiveFiles()` 会跑 `git restore --staged -- <文件>` 把它退回未跟踪（`restore` 的白名单只放行 `--staged`，不带 `--staged` 的 `restore` 会连工作区改动一起丢掉，绝不放行） |
| 远程出口 | 唯一出口 | `repo.gitlab.enabled` **总开关，缺省 `false`**：缺省下不要 `GITLAB_TOKEN`、不发任何 GitLab 请求；显式 `true` + 配了 remote 才走原 Commits API 开 draft MR |
| 通知正文 | 首行 `draft MR：<url>` | 首行 `本地提交：<sha 前 12 位> @ <branch>（<worktreePath>）`；仍配了远程出口的部署才多一行 `draft MR：<url>` |
| skipped 尾注 | （MR 已开成 draft，但验证没跑通，请人工确认） | （改动已提交到工作区，但验证没跑通，请人工确认）；邮件标题 `phaseLabelOf('skipped')` 改成「已提交但未验证」 |
| 阶段中文名 | `mr-opening` = 正在开 MR；`skipped` = 已开 MR，但未跑通验证 | `mr-opening` = 正在本地提交；`skipped` = 已本地提交，但未跑通验证 |
| `pipeline_status` | 每票只列阶段/工作区/MR | 每票多一行 `本地提交：<sha12> @ <branch>`，返回体多字段 `commitSha` |
| `pipeline_doctor` | `GITLAB_TOKEN` 未配进 warnings；有 remote 就 `ls-remote` 握手 | `GITLAB_TOKEN` 未配只显示 `ℹ️ 凭据 GITLAB_TOKEN：未配置（本阶段不需要）`、**不进 warnings**；remote 为空且没开远程出口时**静默**；配了 remote 但没开 `gitlab.enabled` → 显示「只做本地提交（remote 未启用）」且**不发** `ls-remote` |

提交说明的真实样例（实测原文）：

```
fix(pms): [pms] ##1 rec-probe-1
工单标识: rec-probe-1
修订次数: 1

验证：通过（验证通过：test 全部退出码 0）
未提交（疑似含真实凭据，按约定留在工作区）：application.yml
```

自测从 262 → **269** → **274** → **285**（「本地提交」这轮新增 7 条：本地提交的 sha/分支/文件、敏感文件不进提交、`gitlab.enabled` 关闭时零 GitLab 请求、
提交失败让票失败、提交说明内容、`commitLocally` 拒绝空提交与缺 git runner、git 白名单放行 `commit` / `rev-parse HEAD`；
当晚「改代码落点」那轮又加 5 条，见 §1.3；最后一轮改动收集修缺陷又加 11 条，见 §1.4）。
`gitlab-checks` 里 `await check(` 从 51 → 58 → **68**。

隔离目录这一层也要说明白：**缺省不隔离** —— 直接在该项目工作区的检出里改代码、就地提交，
开跑前硬性要求检出干净（`git status --porcelain -z -uall` 连同排除规则一起用，见 §1.4，有输出就拒跑并点名文件）；
打开 `isolateWorktree: true` 才退回「每票一个 `.agents/worktrees/<branch>` 隔离 worktree」。
所以不要把「每票必开 worktree」当成硬约束来读。

### 1.3 「改代码落点」改造（2026-11-06 晚，工作树未提交）

这一轮解决的是「改在哪」：**默认就在项目工作区的检出里改**（等于人自己「在工作区新开一个会话处理这笔工单」的感觉），
而不是每张票都先切一个隔离目录。隔离能力保留，但降级成可选项。

| 项 | 改造前 | 改造后 |
| --- | --- | --- |
| 改代码落点 | 每票 `git worktree add -b <branch> .agents/worktrees/<branch>` | **缺省就在项目工作区的检出里改**（分支 = 检出当前分支，不另开票分支，`baseCommit` = 检出当前 HEAD） |
| 新增配置键 | — | `isolateWorktree: boolean`，**默认 `false`**。`true` 才退回上面的隔离 worktree 行为 |
| 开跑前置条件 | 无（新 worktree 天然是干净的新检出） | 缺省模式**脏也能跑**：`inspectCheckout()` 读 `git status --porcelain -z -uall -- . <排除 .agents/worktrees>` + `rev-parse --abbrev-ref HEAD`（`-z` / `-uall` / 排除规则三者的必要性见 §1.4），`describeDirtyCheckout()` 只提醒不拒跑（详见 §1.10） |
| `workingDirectory.set` | 只要有工作区坐标就钉到 worktree | 判据改成 `worktreePath !== workspacePath`：缺省模式两者相等 → 不需要钉、也不要求宿主有 `workingDirectory` 服务；只有 `isolateWorktree: true` 且缺服务才抛 `invalid-input` |
| 清理安全 | `git worktree remove --force` 直接执行 | 加 `isIsolatedWorktreePath()` 前缀校验（只认 `<repo>/.agents/worktrees/<name>`）。缺省模式下没有隔离 worktree，若不校验，`remove --force` 会对着人的主检出执行 —— 这是必须堵的口子 |
| 配置项关联 | `fetchBeforeCreate` / `branchPrefix` / `worktreeRetentionHours` 恒生效 | 三者现在**只在 `isolateWorktree: true` 时用得上**（不建 worktree 就没有可清、可拉、可命名的票分支） |
| `pipeline_doctor` | 只报凭据与 remote | 缺省模式额外检查检出干净度：干净显示「检出干净，可以直接跑票」，脏显示「⚠️ 检出有 N 个未提交改动（跑票会被拒）」；并打一行「ℹ️ 改代码落点：项目工作区检出里（要求检出干净）」/「ℹ️ 改代码落点：每票一个隔离 worktree（.agents/worktrees/）」 |

自测 269 → **274**（`dev-run.mjs` 新增第 15 节「改代码落点」）：`inspectCheckout` 干净/脏/拿不到状态三种情况都说清、
`describeDirtyCheckout` 脏工作区只提醒不拒跑且文案能照着理解（当时是 `assertCleanCheckout` 拒跑，见 §1.10 的后续改造）、
`isIsolatedWorktreePath` 只认插件自己开的 `.agents/worktrees/<name>`（人的主检出、`.agents` 本身、路径穿越一律 false）、
真实 `apply()` 缺省模式不建隔离 worktree 且票据落在工作区根上（`branch` = 检出当前分支，`baseCommit` = 检出 HEAD）。

### 1.4 改动收集改走 `git -z`（2026-11-06 深夜，工作树未提交）

「缺省在工作区检出里改」把 `baseCommit` 变成恒有值，于是原先只在少数路径上暴露的三个坑全部变成主路径上的**必现缺陷**。
这一轮把它们一并修掉，自测 274 → **285**。

| 缺陷 | 现象（真实 git 实测） | 修法 |
| --- | --- | --- |
| **未跟踪新文件漏提交** | `collectChanges` 有 `baseCommit` 时只跑 `git diff --name-status <baseCommit>`。`git diff` **看不见未跟踪文件**：改了 `a.txt` 又新建 `b.txt`，只输出 `M a.txt`；只新建文件时输出**空**。于是「agent 新建一个页面/组件」这种工单里最常见的产物既不进提交，还会因 `committable.length === 0` 被判 `failed`（`agent 没有产生任何文件改动`） | `collectChanges` 改成「`git diff --name-status -z <baseCommit> -- . <排除>` ∪ `git status --porcelain -z -uall -- . <排除>`」取并集，从 status 只补 diff 看不见的 `??`（create），同一路径不重复计数；无 `baseCommit`（首提交前的仓库）时只靠 status |
| **路径被引号/八进制转义 + 未跟踪目录被折叠** | 非 `-z` 输出下：中文名是 `?? "\346\226\260\345\273\272..."`（`core.quotePath` 默认 true）；含空格名即便 `quotePath=false` 仍是 `?? "space name.txt"`（旧解析器 `line.slice(3)` 会把引号带进提交路径 → git 找不到文件）。且 `git status --porcelain` 默认把未跟踪目录折叠成一个目录名（`?? newdir/`），里面的文件路径全丢 → **敏感文件可绕过拦截** | 一律改用 `-z`：`-z` 下路径不带引号、不转义、NUL 分隔（`git diff --name-status -z` 是「旧路径在前」，`git status --porcelain -z` 是「新路径在前」，两个解析器分开写）；未跟踪项必须 `-uall` 展开到文件级。解析器集中在新契约 `src/contracts/git-status.js`（`parseStatusZ` / `parseNameStatusZ` / `statusCodeToAction`），旧的三个非 `-z` 解析导出已删除（留着会诱使人继续用错口径） |
| **`.agents/worktrees` 污染检出** | 插件自己开的隔离 worktree 让主检出 `git status --porcelain` = `?? .agents/`，缺省模式 `assertCleanCheckout` 直接拒跑（`.repos/tp-sandbox` 实测修复前就卡在这） | 所有读状态的地方（`inspectCheckout`、`pipeline_doctor`、`collectChanges`）统一带排除 pathspec `['.', ':(exclude).agents/worktrees', ':(exclude).agents/worktrees/**']`。**只排 `.agents/worktrees`，不排整个 `.agents`**：实测排整个目录会把用户自己放在 `.agents/` 下的内容一起误排掉 |

提交这一侧也跟着改（`commitLocally`）：`addTargets` = 所有 `status !== 'delete'` 的 change 的 `path`，`commitSpecs` = 所有 change 的 `path ∪ from`。
三个理由都是实测出来的：`git add -- <已删除路径>` 会 `fatal: pathspec ... did not match any files`（所以删除路径不能进 `add`）；
`git commit -- <未跟踪文件>` 会 `error: pathspec ... did not match any file(s) known to git`（所以新文件必须先 `add`）；
已暂存的重命名只给新路径会让旧路径的删除留在 index、历史里留下「复制」而不是「重命名」（所以 `from` 必须进 commit pathspec）。

真实 git 端到端验收（`.scratch/_e2e-real-git.mjs`，临时仓库）：一次造出「改 / 删 / 重命名 / 新建 / 中文名 / 空格名」六类改动 + 敏感文件被 agent 自己 `git add` + `.agents/worktrees/` 污染，
`collectChanges` 收齐 9 条且不含插件自有目录，`unstageSensitiveFiles` 把 `application.yml` 退回 `??`，
`commitLocally` 产出的 `log --name-status` 精确等于期望（含 `R100 to-rename.txt renamed.txt`），提交后工作区只剩 `?? .agents/worktrees/...` 与 `?? application.yml`。

### 1.5 陈旧工作区坐标不得复用（2026-11-06 真实事故）

**事故**：`pms|reczz28VWNWVbpgL` 连续两次失败，通知里的错误是
`internal: executor-agent：把工作目录从工作区根切到 worktree 失败（working-directory: directory does not exist: "D:/WorkSpace/dsh-ticket-pipeline/.repos/mgiot-pms/.agents/worktrees/ticket-pms-reczz28VWNWVbpgL-r1"）。继续跑会在 D:\WorkSpace\mgiot-pms 里改代码，所以这里停下。`

**根因**：`core/scheduler.js` 的工作区守卫只看「字段有没有值」：

```js
if ((!row.worktreePath || !ws.workspacePath) && typeof prepareWorkspace === 'function') { ... }
```

这两个字段都非空时整段跳过 `prepareWorkspace`。而这一行恰好是**跨配置时代的混合坐标**：`workspacePath` / `repoPath` 是 11-06 新配置的 `D:/WorkSpace/mgiot-pms`，
`worktreePath` / `branch` 是 11-04 老配置时代的 `.repos/mgiot-pms/.agents/worktrees/…`，那个目录早就随旧仓库一起没了。
陈旧路径原样进执行器 → `setupAgent` 里 `needsPin` 成立 → `workingDirectory.set(agent, <不存在的目录>)` → 抛 `internal`。

**两个放大器**：
1. `store.resetByHuman()` 只把 phase 拨回 `pending`，**不清工作区坐标** —— 人照着通知「拨走再拨回处理中」重开，会带着同一份死坐标原样再失败一次；
2. `recoverPending()` 只在启动时遍历 `store.listActive()`（pending 与中间态），**`failed` 是终态、不在其中** —— 恢复流程永远修不好这张票。

**修法**（`core/scheduler.js`）：
- 新增 `isStaleWorkspaceCoords({ worktreePath, repoPath, currentRepoPath, worktreeExists })`，两种情形判为失效：
  ① 票据上的 `repoPath` 与本次定位到的 `repoPath` 不一致（换了仓库，旧目录可能是另一个仓库的有效检出）；
  ② `worktreeExists(worktreePath)` 明确回 `false`（目录确实没了）。
  **探测本身抛错不算失效** —— 问不到不等于没有，宁可复用旧坐标让人看见真实错误，也不要每轮把已有工作区推倒重来。
- 守卫条件加上 `|| staleCoords`，并且失效时必须把 `worktreePath / branch / baseCommit` **摘成 `undefined`** 再传 `prepareWorkspace`：
  否则它会走「已有 worktree，只补登记」那一支，把死路径原样回传。
- `createScheduler` 新增可选依赖 `worktreeExists`（由 `src/index.js` 用 `checkWorktreeByGit` 提供），与启动恢复共用同一个判定
  —— 两处口径不一致会出现「恢复说没了、调度器说还在」这种最难查的分歧。

新增 3 条断言：目录已删要重建且不把死坐标传下去、换了仓库要重建、探测抛错时不重建。
自测 285 → **288**。

### 1.6 插件版本自检：跑的是不是最新代码（2026-11-06）

**要解决的问题**：安装副本是**普通目录副本**（跨盘 `pnpm file:` 落成复制，不是软链），
而 HMR 的 `root: []` 不监听源码目录、默认 `ignored` 还列着 `node_modules` ——
所以改完源码不手工同步，宿主**一声不响地继续跑旧代码**。此前的表现是「明明改了却没生效」，
只能靠人肉 `robocopy` + 重启，出错时完全看不出来。

**做法**：新增 `src/core/plugin-version.js`（480 行），在 `pipeline_doctor` 里作第 5 节汇报。

- **不比版本号**：两侧 `package.json` 的 `version` 都是 `0.1.0-test.1`，比了也没用。
- **不跟 origin 比**：本阶段的交付形态是「工作区里的本地提交」，origin 长期落后本地，方向正好反了。
  ⇒ 基准取 **profile `package.json` 里声明本包的那条 `file:` / `link:` 源码路径**。
- **只比会真被加载的文件**：`src/**/*.js`、`lib/**/*.js`、`cordis.patch.yml`、`icon.svg`、`locale/*.json`。
  `README.md` / `scripts/` 改了不影响行为，不比 —— 否则每次改文档都误报「版本旧」。
  根目录的 `COMPARED_FILES` 还会先 `readdir` 确认文件真的在，避免 `icon.svg` 缺失把「本来就是这么装的」误报成「比对失败」。
- **链接安装直接判过**：`installedDir` 不含 `node_modules`（从源码直接跑），或两边 `realpath` 相同 ⇒ `linked: true`，不报落后。
  profile 目录不是硬套三层相对路径，而是 `findProfileDir()` 沿路向上最多 6 层找「真的声明了本包」的那份 `package.json`。
- **结论只进 `warnings`**：装旧版插件票照样能跑完，记成 `problems` 会让人以为流水线坏了。
  落后时的文案直接给出可照做的命令：同步哪个目录到哪个目录、然后重启宿主。

四种输出：`✅ 安装副本与源码一致（共比 N 个文件，指纹 xxx）` / `✅ 安装目录就是源码` /
`⚠️ 插件不是最新：… （N 个文件内容不同，副本缺 N 个，副本多 N 个）+ 源码 fp ↔ 副本 fp` /
`ℹ️ 无法比对（<原因>）`。

**同一份逻辑两处生效**：`src/index.js` 的 `doctorOptions` 只构造一次，同时喂 agent 侧的
`pipeline_doctor` 工具（`ctx.tools.register`）与 GUI 设置页的「立即体检」按钮（宿主 Remote），
所以版本检查写在 `runDoctor()` 里两处自动都有，不存在两边口径不一致。

新增 5 组断言：doctor 报落后并给出同步命令（另测一致态 / 链接态 / 比不出来态）、
profile 声明解析与链接识别、能比出内容差异与缺文件多文件、坏输入不抛、`listComparedFiles` 只收会加载的文件。
既有 7 个 doctor 用例全部注入 `comparePluginVersion` 桩，避免自测去读这台机器的真实安装状态。
自测 288 → **293** → **294**（最后一条是 setPhase 真正清 lastError）。

### 1.7 `setPhase` 清不掉字段：所有「清掉它」都静默失效（2026-11-06 真实事故）

**事故现场**：飞书票 `pms|reczz28VWNWVbpgL` 跑成 `done`、本地提交 `0e62fe5` 已在
`D:\WorkSpace\mgiot-pms` 里落地，但 `pipeline_status` 里这张「已完成」的票还挂着：

```
最近错误：internal: agent 这一轮以错误结束：pi-ai provider "workbuddy" has no configured model "deepseek-flash"
```

一条早就被修掉（改成显式 `provider`/`model`）的失败原因，跟着这张票走到了成功之后。

**根因**（`src/core/store.js` `setPhase`）：补丁里所有值为 `undefined` 的键被一概过滤掉。

```js
// 修改前
const defined = {}
for (const [field, value] of Object.entries(patch ?? {})) {
  if (value !== undefined) defined[field] = value
}
const next = { ...row, ...defined, phase: to }
```

而调用方**大量用 `undefined` 表达「清掉它」**，于是在这段代码之下，每一种清除都是静默失效的：

| 调用点 | 意图 | 实际结果 |
| --- | --- | --- |
| `scheduler.js` 成功收尾 `setPhase(key, finalPhase, { lastError: finalError })` | 这一轮没出错 → 清掉上一轮的失败原因 | 旧 `lastError` 原地留着 |
| `recover.js` 「工作区丢失」分支 `{ worktreePath: undefined, branch: undefined, mr: undefined, commit: undefined }` | 丢掉已失效的坐标，重新建 | 死坐标没被清掉，恢复等于白做 |
| `scheduler.js` 清理过期 worktree 后 `{ worktreePath: undefined, branch: undefined }` | 清掉已删目录的坐标 | 同上 |

**为什么自测没抓到**：`dev-run.mjs` 里那条「done 的通知不残留上一轮的失败原因」走的是
`resetByHuman`（`put` 整行，本来就把 `lastError` 抹了），根本没碰到 `setPhase` 的清除逻辑 ——
**清洗路径与断言路径不是同一条，测试是真绿、结论是假绿。**

**修法**：区分「键不存在」与「键在、值为 `undefined`」。

```js
// 修改后：键不存在 → 不动；键在且值为 undefined → 删掉这个字段
const next = { ...row }
for (const [field, value] of Object.entries(patch ?? {})) {
  if (value === undefined) delete next[field]
  else next[field] = value
}
next.phase = to
```

这样「顺手多传一个 undefined」也不会误删字段（没传的键根本不进 `patch`），
而不需要每个调用点各自写一遍 `delete`。

**新增断言**（`dev-run.mjs`）：走**真实重试路径** —— 执行器抛可重试错误 → 票回 `pending`
且写下 `lastError` → 下一轮跑成 → 断言 `row.lastError === undefined`。
这条在修复前会红，修复后绿；原来那条 `resetByHuman` 的用例保留（它测的是另一件事）。

---

### 1.8 处理完回填工单表（2026-11-06，工作树未提交）

**要解决什么**：票跑完了，人还得自己去表格里把「是否处理」改成「是」、把改了哪些文件抄进「处理结果」。
插件明明什么都知道，却让这一步纯手工 —— 忘一次，表里就是一张永远「处理中」的假在办票。

**做法**：`TicketSource` 加一个**可选**方法 `writeResult(recordId, { status?, result, handledAt? }, signal)`，
`scan` 仍然只读，**这是唯一的写入口**，只在票跑成 `done` / `skipped` 之后被调用一次。

| 环节 | 落点 |
| --- | --- |
| 契约 | `src/contracts/ticket-source.js`：`writeResult?` + `WriteBackReceipt = { written, fields?, note? }` |
| 调用 | `src/core/scheduler.js` `writeBackFor()` —— 三条硬约束：只写 done/skipped（failed 留在「处理中」是刻意留的信号）、回填失败只记日志**绝不影响票态**、被取消就不写 |
| 正文 | `renderWriteBackResult()`：首句（skipped 是「已按工单改完并提交，但验证没跑通，需要人工确认。」）+ 改动文件（最多 8 个）+ 验证结论 + 本地提交 sha/分支/路径 + draft MR（若开）+ 处理会话 id + 末段「要进一步修改，把这个单元格清空、把「是否处理」拨回「处理中」即可重跑。」 |
| 飞书实现 | `PUT /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/{record_id}`，body `{ fields: { 是否处理, 处理结果, 处理日期 } }`；字段缺失（业务码 1254040 / 1254045）返 `{ written:false, note }` **不抛**，其余异常照抛 |
| 开关 | `writeBack`（bool，缺省 **true**）、`writeBackStatus`（str，缺省 `'是'`） |
| 可观测 | `pipeline_status` 每票多一行 `回填表格：成功（是否处理、处理结果、处理日期）` 或 `回填表格：没写成 —— <原因>`；返回体多 `writeBack` |
| 决策 | 新增 [ADR-0006](../adr/0006-处理完回填工单表.md) |

**为什么写在 `writeResult` 而不是塞进 `scan`**：`scan` 是高频、可重试、随时可能被取消的只读动作；
写必须低频（一票一次）、只在真出结果之后。混在一起的后果是「扫一半就把表写了」和「重试一轮写一次」。

**新增断言**（`dev-run.mjs` 第 16 节 + `feishu-checks.mjs`）：三列都写、`writeBackStatus` 可配且空白回落、
`writeBack=false` 一个请求都不发、failed 不回填、回填失败票态不回退、老适配器没实现时静默跳过、
skipped 的首句要说「验证没跑通」。`feishu-checks.mjs` 52 → **58**。

### 1.9 处理完保留会话（2026-11-06，工作树未提交）

**要解决什么**：票跑完 agent 就没了，人收到「改完了，`git show` 看吧」，想追问一句「为什么这么改、
这里能不能换个写法」—— 没有地方问，只能自己读代码。

**做法**：`ExecResult` 新增可选 `sessionId`，`run()` 的三个出口（done / skipped / failed）都带它，
`executor-agent` 用 `buildSessionId(ticket, ctx)` 生成；票据上落 `sessionId`。

- **agent 实例永远释放**：`finally` 里无条件 `dispose()` —— 保留会话不等于占着模型配额。
- `keepSession !== false`（缺省）时只记一句日志「agent 已释放，会话保留」，与会话留在项目工作区名下，
  宿主 GUI 的会话列表里能看到并点进去继续问。
- `keepSession === false` 才调宿主的 `sessions` 服务收掉（`close` / `dispose` / `closeSession` **三选一，取到哪个用哪个，永不抛**）。
- `pipeline_status` 多一行 `处理会话：<sessionId>（保留在工作区名下，可在会话列表里点进去继续问）`。

**为什么默认保留**：会话归属的是项目工作区（一个项目一条），留着成本只是几条记录，而「能追问」是这件事
最有价值的部分。真嫌多余的人把 `keepSession` 关掉即可。

**新增断言**（`gitlab-checks.mjs`）：执行器返回 `sessionId` → 落到票据上、状态里能看到去哪找会话；
两个出口都带；`keepSession=false` 时会调回收且不抛。

### 1.10 只提交 agent 真正改过的文件（2026-11-06，工作树未提交）

**要解决什么**：缺省模式在人的日常检出里改代码，而人的检出**通常是脏的**（一堆没提交的调试改动）。
原先的 `assertCleanCheckout` 一律拒跑，等于「想跑票先把你手上的活收干净」；放宽成「脏也照跑」之后，
又必须保证**人的改动一个都不能被一起提交**。

**做法**：删掉 `assertCleanCheckout`，换成 `describeDirtyCheckout()`（脏只提醒不拒跑）+ 基线快照。

- `createBaseline()`（`executor-agent/index.js`，`agent.followup` **之前**拍）：`git stash create`
  只造一个 stash commit 对象并回它的 sha —— **不写 ref、不动工作区、不动索引**，`git stash list` 仍是空的；
  干净时返回空串 → 视为无基线；再 `git rev-parse HEAD`、`git status --porcelain -z -uall` 数人自己的未提交改动数、
  对每个 `??` 跑 `git hash-object -- <path>` 存内容哈希。
- `collectChanges()` 的 diff 端点换成基线 sha：比的是「agent 动手前」，人自己的改动天然不在里面；
  未跟踪文件哈希与基线相同 → 人早就放在那儿，跳过。人是 `git add` 进索引的改动同样被排除。
- **基线拍不下来就降级**：日志里说明「人原本未提交的改动可能被一起提交」，票不失败。
- 提示文案（`describeDirtyCheckout`）：项目工作区有 N 个未提交改动，本次照跑；会先拍基线，
  结束后只提交 agent 真正改过的文件，你自己的改动原样留在工作区。
- git 白名单新增两项：`stash create`（只这一个，`pop` / `apply` / `drop` 全拒）、`hash-object -- <path>`（强制 `--`）。

**为什么用 `git stash create` 而不是记 `HEAD`**：记 `HEAD` 的话 `git diff HEAD` 会把人的未提交改动
一并算成 agent 的产物，「不提交不是你修改的文件」就成了空话。

**验收**：真 git 端到端跑过（`dev-run.mjs` 第 15 节）——人的改动一个不出现；`.agents/worktrees/` 不污染判定；
`isIsolatedWorktreePath` 只认插件自己开的目录，防 `git worktree remove --force` 误删人的主检出。

### 1.11 设置面板补齐：项目清单可编辑（2026-11-06，工作树未提交）

**要解决什么**：设置页之前只能改标量配置，`projects[]` 那 25 个字段（仓库路径、工单表绑定、验证命令…）
还得手改 `cordis.patch.yml`；写错不报错、改了不生效都要重启才发现。

**做法**：

| 环 | 落点 |
| --- | --- |
| Config 树 | `src/core/config.js` `buildProjectsDescriptor()` 新增 `projects` 节点：`type:'array'`、**节点自身 `meta.volatile = true`**、`inner` 是 object（子节点也标 volatile）,`inner.dict` 覆盖 **25 个字段** |
| 为什么必须自标 volatile | 宿主 `isVolatilePath()` 只沿 `schema.dict` 下钻、**不认 `inner`**，而 `projects` 是数组 —— 深层路径 `['projects','0','repo','path']` 只能靠根节点自己 volatile 短路放行 |
| 写入 | 只发**深层路径**（`{op:'set', path:['projects','0','repo','path'], value}`），**绝不整数组替换**（会抹掉别的项目和手写 `appToken`），`lib/client.js` 的 `collectOps()` 守着 |
| 新 Remote 方法 | `ticketPipeline.projects()`（第 3 个）与 `ticketPipeline.branches()`（第 4 个，另两个是 `doctor` / `config`）。`projects()` 返回项目的扁平视图；`appToken` 只给 `hasAppToken` + `appTokenPreview`（前 4…后 4），**明文绝不下发**。`branches()` 对每个项目的检出跑 `git for-each-ref`，把本地 + 远端分支剥成纯分支名，给 `repo.baseBranch` / `repo.targetBranch` 当候选（`src/core/branches.js`） |
| 面板 | 项目清单可编辑（5 分区 21 字段）、字段约束即时校验（必填 / 数字 min-max / enum / 列表逗号切分）、**基准/目标分支带候选下拉**（输入框 + `<datalist>`，见 §1.12）、分组可折叠（`localStorage`）、sticky 操作条、脏字段「已改」徽标 + 单字段撤销、加载态「正在等待宿主就绪…」 |

全局配置随之变成 **33 个键 / 7 个分组**（新增 `writeBack`、`writeBackStatus` 进新组「回填工单表」，
`keepSession` 进「执行」组）；`projects` 子树另有 25 个字段，不在这 33 个里。

**验收**：`client-check.mjs` 全绿 —— descriptor 叶子 33 个 / 7 组，schema 信封 71 节点 33 叶子三方一致，
面板 21 项与宿主 `projects` descriptor 对得上，Remote 4 个方法一致，`projects` 可写 25 字段（深层路径 mutate）；
`client-smoke.mjs` 85 条断言全过。

### 1.12 选择分支：`repo.baseBranch` / `repo.targetBranch` 带候选（2026-11-06）

**要解决什么**：这两个键以前只能在面板上手打。打错的自查成本极高 —— 本机 pms 仓库主干叫 `v2.x`，
人凭印象写成 `main`，跑到 `git fetch origin main` 才炸 `fatal: couldn't find remote ref main`，
票全挂在第一步，错误文案里看不出是「分支名写错了」，人会去查权限、查网络。让面板把检出里真实存在的
分支列出来，这类错就从「运行时炸」变成「选项里根本没有」。

**做法**：

| 环 | 落点 |
| --- | --- |
| 解析 | `src/core/branches.js` 的 `parseBranchRefs()`：`git for-each-ref --format=%(refname) refs/heads refs/remotes` 一条一行；`refs/remotes/` 后**只切第一个 `/`**（`feature/x` 这种分支名要保留）；`origin/HEAD` 是符号引用，丢掉 |
| 合并 | `mergeBranchChoices()` 去重后按「当前分支 → 远端默认分支 → 本地分支 → 其余远端分支」排序 —— 下拉框第一项就是最可能对的那个 |
| 列 | `listBranches(gitRunner, repoPath, {detectDefaultBranch})`：**绝不抛**，拿不到就 `ok:false` + 一句人话原因（`repo.path` 没配 / 宿主没给 git 执行链路 / 不是 git 检出 / git 抛错）；主干分支复用体检那边的 `detectBaseBranch`，避免两处对「主干叫什么」的判断漂移 |
| Remote | `ticketPipeline.branches()`（第 4 个方法）**不带参数**：一次返回全部项目的分支。做成 `branches(repoPath)` 的话，面板每次重绘都会对每个项目各发一次请求，卡片一多就是几十个并发 git 进程 |
| 面板 | `PROJECT_SECTIONS` 里两个分支字段的 `kind` 从 `text` 改成 `branch`：渲染成 `<input list=...>` + `<datalist>`。**不做成纯 `<select>`** —— 列不出分支时（新克隆、`repo.path` 还没填）下拉是空的，人就彻底填不了了；输入框 + 候选让「列不出来」退化成「手打」而不是「填不了」 |
| 失败隔离 | 某个项目的 `repo.path` 配错只让它自己的下拉空着并附一句原因，不连累其他项目；分支取不到**从不设错误**，不影响项目清单那一路 |

**为什么按 index 对齐而不是按 repoPath**：两个项目可能指向同一个检出，按路径查表会串味；
`branches()` 与 `projects()` 用的是同一次 `config.projects` 遍历，index 一定对得上。

**验收**：`dev-run` 新增 6 条断言（解析 / 排序去重 / 真跑通 / 四种失败不抛 / 游离 HEAD / 宿主 remote 按项目隔离），
自测 **325/325** 全绿；`client-check` 的 `kind` 白名单加了 `branch`，Remote 描述符 4 个方法一致；
真机验证 `listBranches` 在 `D:/WorkSpace/mgiot-pms`（当前 `v2.x`，候选 `v2.x`/`master`/`workbuddy/v2-x-8ef29a33`/`main`）、
本仓库（`v0.0.1`/`main`）、`.repos/tp-sandbox`（`main` + 3 个 worktree 分支）上都返回正确清单，
不存在的路径返回 `fatal: cannot change to ...`。

---

---

## 2. 代码清单

`src/` 共 **43 个 .js / 14 675 行**；`scripts/` 共 9 个 .mjs / 9 035 行（`dev-run.mjs` 2 774 行）；`lib/client.js` 2 151 行（浏览器端设置面板）。

| 目录 | 行数 | 文件 |
| --- | --- | --- |
| `src/contracts/` | 1 185 | `errors.js`（错误模型）、`types.js`（阶段机 + 指纹）、`ticket-source.js`（`scan` 只读 + `writeResult` 唯一写入口）、`work-executor.js`、`push-adapter.js`、`repo-locator.js`、`record-filter.js`、`git-status.js`（`-z` 状态/改名解析 + 插件自有目录排除规则） |
| `src/core/` | 4 156 | `scheduler.js`（调度核心 + `writeBackFor` / `renderWriteBackResult`）、`store.js`（持久化 + 租约）、`config.js`（配置校验 + 描述符 + `projects` 子树）、`recover.js`（启动恢复）、`workspace.js`（项目工作区）、`worktree-path.js`（`isIsolatedWorktreePath`，清理安全校验）、**`plugin-version.js`（安装副本 vs 源码的文件级比对）**、**`branches.js`（`parseBranchRefs` / `mergeBranchChoices` / `listBranches`，分支候选）**、`prompt.js` / `prompts.js`（任务书与反注入提示）、`domain.js`、`branch-name.js` |
| `src/adapters/` | 6 852 | 见下表 |
| `src/tools/` | 1 154 | `define.js`（工具范本）、`pipeline-scan.js`、`pipeline-status.js`、`pipeline-doctor.js`、`pipeline-reset.js`、`pipeline-cancel.js` |
| `src/remote/` | 269 | `descriptors.js`（4 个 Remote 方法 / 87 行）、`host.js`（宿主 Remote 通道 / 182 行） |
| 根 | 1 059 | `src/index.js` —— 组合根（装配全部适配器、注册工具、起轮询；`inspectCheckout` / `describeDirtyCheckout` 也在这里） |

| 适配器 | 行数 | 状态 | 说明 |
| --- | --- | --- | --- |
| `source-feishu/` | 1 384 | **真实可用** | 飞书多维表格 API；水位、状态值可配、recordIds 收窄、截图三形态、`allowedImageHosts` 白名单；**`writeResult` 回填三列**（`PUT /records/:record_id`，字段缺失返 `{written:false}` 不抛） |
| `source-wps/` | 1 360 | **解析可用，取数待接** | `index.js` + `xlsx.js` + `zip.js`；自解 xlsx/OOXML、截图按锚点解包；「待修改项目」列进 `targetProject`；recordIds 收窄；取数走注入的 `fetchSheet` |
| `source-webform/` | 106 | 演示 | 内存表单源，验证「加平台 = 加目录 + 两行表」；也接 recordIds |
| `source-mock/` | 329 | 测试 | 离线源；也接 recordIds；实现 `writeResult` 供自测断言 |
| `executor-agent/` | 1 786 | **真实实现** | 真 agent 改码、**先拍基线**（`createBaseline`：`git stash create` + 未跟踪文件内容哈希）再 `-z` 口径收集改动、跑验证、在工作区检出里做本地提交（`commitLocally`，点名暂存 `git add -- <文件>`）；`unstageSensitiveFiles` 把 agent 自己暂存进去的敏感文件退回去；三个出口都带 `sessionId`，`keepSession` 控制会话回收；`repo.gitlab.enabled: true` 时才额外开 draft MR；含 `agent-failure.js` 失败原因识别（限流转可重试） |
| `executor-mock/` | 143 | 测试 | 只演不动真格；返回假的 `commit = { sha: 'mock…', branch, files }` |
| `gitlab-client/` | 495 | **真实可用** | Commits API + MR API；源分支已有开放 MR 时复用而不撞 409 |
| `push-qqmail/` | 574 | **真实可用** | 零依赖手写 SMTP（`node:net` / `node:tls` / `node:crypto`），已实发成功 |
| `push-pushplus/` | 171 | 可用 | HTTP `pushplus.plus/send`；微信走它的 `clawbot` 渠道 |
| `push-mock/` | 65 | 测试 | |
| `locator-table/` | 187 | **真实可用** | 工单 projectId → 仓库/分支/remote 的查表定位器 |

### 2.1 工具（对宿主暴露的 5 个）

| 工具 | 作用 |
| --- | --- |
| `pipeline_scan` | 立刻扫一轮工单表 |
| `pipeline_status` | 看队列与各票阶段 |
| `pipeline_doctor` | 环境体检：git 链路、各项目仓库连通性、凭据、执行器与通知适配器，以及**正在跑的插件是不是比本地源码旧** |
| `pipeline_reset` | 把 failed / needs-info / gone 的票放回队列重跑 |
| `pipeline_cancel` | 取消正在跑的那张票（并发恒 1） |

---

## 3. 平台适配层：可插拔到什么程度

这一层是「后续能替换或新增工单来源」的落点，做法见 `docs/adr/0001-平台适配层可插拔.md`。

### 3.1 三张静态注册表（`src/index.js:201/221/227`）

```js
export const SOURCES = { mock, feishu, wps, webform }      // 一个项目一个实例
export const EXECUTORS = { mock, agent }                   // 全局单实例
export const PUSHES = { mock, pushplus, qqmail }            // 全局单实例
```

### 3.2 能力声明式注入（`src/index.js:94-113` `CAPABILITY_ASSEMBLERS`）

适配器不在 `SOURCES` 里直接点名宿主能力，而是**声明**自己要哪些，内核按声明装配：

| 能力 | 装配器给的东西 | 谁在用 |
| --- | --- | --- |
| `watermark` | `getWatermark` / `saveWatermark`（水位必须落盘，否则重启后满屏新票） | feishu、wps |
| `secret` | `getSecret`（密钥现取，不落明文配置） | feishu |
| `localFile` | `readLocalFile`（路径形态截图读本机字节） | feishu |
| `scanTuning` | `safePageRun` / `goneAfterScans`（早停与退役节流） | feishu、wps |

**没声明的能力一律不注入** —— 多给只会让「这平台到底依赖什么」越来越说不清。

### 3.3 新增一个平台要写什么

一个目录（实现 `TicketSource` 契约）+ `SOURCES` 里一行（声明 capabilities、可选 `match.build` 翻译绑定参数）+ 配置里 `projects[].match.platform` 加一个取值。**内核与组合根其余部分一行都不用改。**

平台枚举：`src/core/config.js:447` `PLATFORMS = ['feishu', 'wps', 'mock', 'webform']`（表驱动，新增平台只加这一处）。

### 3.4 契约层（8 个文件 / 1 185 行）

| 契约 | 内容 |
| --- | --- |
| `errors.js` | `ERROR_KINDS` 7 类（auth / network / rate-limit / not-found / invalid-input / aborted / internal）；`RETRYABLE_KINDS = {network, rate-limit, internal}`；`FATAL_KINDS = {auth, not-found, invalid-input}`；`PipelineError` 带 `retryAfterMs` |
| `types.js` | 11 个 phase 与 `PHASE_TRANSITIONS` 转移表；`TERMINAL = [done, skipped, failed, gone]`；指纹字段序 |
| `ticket-source.js` | `TicketSource` 接口：`scan()` 产出 created / updated / disappeared；**可选 `writeResult(recordId, {status, result, handledAt}, signal)` 是唯一写入口**，只在 done/skipped 后调一次 |
| `work-executor.js` | `WorkExecutor` 接口：`run(ticket, target, ctx)` 产出 `ExecResult`（含可选 `commit` / `mr` / `sessionId`） |
| `push-adapter.js` | `PushAdapter` 接口：`send(input, signal)` 产出 `PushReceipt` |
| `repo-locator.js` | `locate(projectId)` → 仓库 / 分支 / remote |
| `record-filter.js` | 工单收窄开关（recordIds） |
| `git-status.js` | `parseStatusZ` / `parseNameStatusZ` / `statusCodeToAction`：`-z` 状态与改名解析、插件自有目录排除规则 |

---

## 4. 配置项全表

全局配置 **33 个键 / 7 个分组**（`src/core/config.js` `CONFIG_FIELDS` + `CONFIG_GROUPS`，含 `pushplus.*` / `qqmail.*` 这类点号子键），另有项目级配置（`projects` 子树 25 个字段，不在这 33 个里）。

| 键 | 类型 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `pollIntervalMinutes` | number | 3 | 1–60 | 轮询间隔 |
| `safePageRun` | int | 20 | 5–100 | 连续 N 条已知未变就早停（防误杀退役） |
| `goneAfterScans` | int | 3 | 1–20 | 连续 N 轮扫不到才退役 |
| `concurrency` | int | 1 | 固定 1 | **当前恒为 1，且是死配置**（代码无消费点） |
| `leaseTtlMinutes` | number | 10 | 1–60 | 租约 TTL |
| `leaseHeartbeatSeconds` | number | 60 | 1–1800 | 租约续期心跳间隔 |
| `maxAttempts` | int | 2 | 1–5 | 超过即进死信 |
| `workExecutor` | str | `mock` | — | `mock` / `agent` |
| `ticketTimeoutMinutes` | number | 40 | 5–180 | 单票执行超时 |
| `isolateWorktree` | bool | **false** | — | **改代码落点**：`false`（缺省）直接在项目工作区的检出里改、就地提交，**检出脏也能跑**（先拍基线、只提交 agent 改过的）；`true` 才每票 `git fetch` + `git worktree add -b <branch> .agents/worktrees/<branch>` |
| `fetchBeforeCreate` | bool | true | — | 建工作区前先 `git fetch`（只有 `isolateWorktree: true` 时用得上） |
| `branchPrefix` | str | `ticket-` | — | 分支名前缀（只有 `isolateWorktree: true` 时用于票分支） |
| `worktreeRetentionHours` | number | 24 | 0–720 | 隔离 worktree 保留时长（只有 `isolateWorktree: true` 才有 worktree 可清） |
| `keepSession` | bool | **true** | — | **处理完保留会话**：agent 实例一定释放，会话留在项目工作区名下（GUI 里能点进去继续追问）；设 `false` 才连会话一起收掉 |
| `writeBack` | bool | **true** | — | **处理后回填工单表**：「是否处理 / 处理结果 / 处理日期」三列；关掉退回纯只读，一个写请求都不发 |
| `writeBackStatus` | str | `是` | — | 回填写进「是否处理」的值（空串回落 `是`；有的表用「已完成」） |
| `provider` | str | `workbuddy` | — | 模型 provider |
| `model` | str | `''`（空=跟随会话默认） | — | 留空才跟随会话默认；钉死会在它被限流时全灭 |
| `maxTokens` | int | 32000 | 1024–200000 | |
| `agentPreset` | str | `ptc` | — | 挂给 agent 的 preset（=工具矩阵） |
| `pushAdapter` | str | `pushplus` | — | `mock` / `pushplus` / `qqmail` |
| `pushplus.token` | str | `''` | — | PushPlus 令牌（**当前走明文配置**，与文档「建议走 credentials」矛盾） |
| `pushplus.channel` | str | `clawbot` | — | 微信经此渠道中继 |
| `pushplus.template` | str | `txt` | enum `txt` | |
| `pushplus.callbackUrl` | str | `''` | — | 送达回执回调；留空只有「已受理」 |
| `qqmail.host` | str | `smtp.qq.com` | — | SMTP 主机 |
| `qqmail.port` | number | 465 | 1–65535 | |
| `qqmail.secure` | bool | true | — | 是否 TLS |
| `qqmail.user` | str | `''` | — | 发件账号（授权码从凭据服务取 `QQMAIL_AUTH_CODE`） |
| `qqmail.to` | str | `''` | — | 收件人 |
| `notifyOn` | string[] | `[done, skipped, failed, needs-info]` | — | 哪些阶段发通知 |
| `enabled` | bool | false | — | 总开关 |
| `logLevel` | str | `info` | enum | **死配置**（代码无消费点） |

### 4.1 项目级配置（`projects[]`）

飞书表定位用到的 9 个键里 **8 个是新增**、1 个（`sheetName`）**复用金山源已有的同名键**（**设计待实施**，见 `docs/ticket-pipeline/feishu-sheet-source.md` §4.2）。它们只对**飞书电子表格**分支有意义；配了但表是多维表格时忽略（不报错）。

指引：字段、默认值与生效条件见 `docs/ticket-pipeline/feishu-sheet-source.md` §4.2；表型分派的决策依据见 `docs/adr/0005-飞书电子表格源按表型分派.md`。

| 字段 | 用途 |
| --- | --- |
| `name` | 项目名（= 工单 projectId，定位仓库用） |
| `match.platform` | `feishu` / `wps` / `mock` / `webform`；飞书项目支持 `feishu`（**多维表格 + 电子表格**两种表型，插件自动判断，表型不写进配置 —— 设计待实施） |
| `match.appToken` / `tableId` / `viewId` / `docNamePattern` | 飞书表定位 |
| `match.spreadsheetToken` | 飞书**电子表格** token（`shtcn…`）；与 `appToken` 二选一，配了插件就按电子表格处理（**设计待实施**） |
| `match.sheetId` | 电子表格里的**工作表** id（与 `spreadsheetToken` 配套，与 `sheetName` 二选一） |
| `match.sheetName` | 电子表格里的**工作表名**（与 `spreadsheetToken` 配套，与 `sheetId` 二选一）。**与下方金山表定位共用同一个键**（语义一致：这张文档里用哪个页签），不新增第二份定义 |
| `match.sheetHeaderRow` | 表头在第几行（默认 `1`）；行号身份下表头行一变身份就变，所以不自动往下扫 |
| `match.sheetIdentity` | 行身份来源：`seq`（默认，序号列值）/ `row`（物理行号）。电子表格没有 `record_id`，身份只能自造 |
| `match.sheetIdColumn` | 身份取自哪一列（默认「序号」），仅 `sheetIdentity: 'seq'` 时生效 |
| `match.sheetColumns` | 列名覆盖 `{语义: 实际表头文字}`，如 `{"description":"缺陷描述"}` |
| `match.sheetRange` | 限定读取范围（如 `A1:M500`）；读值接口无分页、单次上限 10 MB，大表靠这个收窄 |
| `match.tableKind` | **逃生阀**：`bitable` / `sheet`。默认空 = 插件自己探测表型；显式写就跳过探测 |
| `match.statusValues` | 收票状态值集合（**可配**：真实表用「否」，缺省「处理中」） |
| `match.recordIds` | 只处理指定几张工单（收窄开关，**四个源（飞书 / 金山 / mock / webform）都接了**；名单外的行整行跳过，不收票也不进水位） |
| `match.allowedImageHosts` | URL 形态截图的允许主机名（缺省为空 = 一律拒绝，见 9.1 第 6 条） |
| `match.sheetUrl` / `sheetName`（与飞书电子表格共用）/ `statusColumn` / `statusValue` / `mediaPrefix` | 金山表定位 |
| `repo.path` | **本地仓库路径**（需求②）；**同时就是这个项目的工作区目录** —— 插件的 `core/workspace.js` 会确保它在宿主 `workspaceRegistry` 里有登记（已登记则复用，没有则补一条）。目录必须真实存在，插件不会替你克隆 |
| `repo.remote` / `baseBranch` / `targetBranch` | 基准分支与目标分支 |
| `verify.build` / `verify.test` | 验证命令（从配置注入，执行器里不硬编码任何命令） |

### 4.2 运行时事实（未暴露为配置项）

| 事实 | 位置 |
| --- | --- |
| 通知超时 20 秒 | `core/scheduler.js` `notifyTimeoutMs`，硬编码 |
| 并发上限恒为 1 | 一轮最多跑一票 |
| 退避基数 30 秒、上限 30 分钟、抖动 0.2 | `core/scheduler.js` `backoffDelayMs` |
| 租约心跳默认 60 秒 | `leaseHeartbeatSeconds` |
---

## 5. 数据流转（从表格到通知）

```
工单表 ──scan()──▶ Ticket[] ──指纹比对──▶ created/updated/disappeared
                      │
                      ├─▶ store.enqueue ──▶ 票（pending）
                      │                      │
                      │                      ├─ acquireLease（租约 + 心跳续期）
                      │                      ├─ locator.locate(projectId) → 仓库/分支
                      │                      ├─ prepareWorkspace（确保项目工作区）
                      │                      │     ├─ 缺省：inspectCheckout + describeDirtyCheckout（脏只提醒、照跑）
                      │                      │     └─ isolateWorktree: true：git fetch + worktree add
                      │                      ├─ 取截图字节 → saveImage → ImageBlock
                      │                      ├─ executor.run(ticket, target, ctx)
                      │                      │     ├─ agent：拍基线(createBaseline) → 改码 → collectChanges(对基线) → verify
                      │                      │     │        → commitLocally（本地提交）→ 返回 commit + sessionId
                      │                      │     │        → keepSession 决定要不要回收会话
                      │                      │     └─ mock：只演（返回假 commit）
                      │                      ├─ setPhase(done/skipped/failed/gone)
                      │                      ├─ writeBackFor（仅 done/skipped 且 writeBack 没关）
                      │                      │     └─ source.writeResult → 回执落到票据 writeBack
                      │                      ├─ releaseLease
                      │                      └─ push.send（按 notifyOn 过滤）
                      │
                      └─ disappeared → 连续 goneAfterScans 轮不见 → gone
```

### 5.1 工单四要素如何落到内核

| 要素 | 内核字段 | 飞书来源 | 金山来源 |
| --- | --- | --- | --- |
| 待修改项目 | `projectId` | **表里没有这一列** → 回落为源实例项目名 | 列别名 `待修改项目/所属项目/项目/系统`（`xlsx.js:34`），但**值被丢弃**（见 9.1 第 5 条） |
| 问题描述 | `description` | `问题描述` 列 | `问题描述/问题/缺陷描述/Bug 描述` |
| 操作流程 | `flow` | `操作流程` 列 | `操作流程/复现步骤/操作步骤/复现流程` |
| 截图 | `screenshots[]` | `截图` 列（文本链接形态） | `截图/图片/问题截图/截图-录屏`（附件 + 链接两种） |
| 附加 | `module` / `priority` / `foundAt` / `department` / `seq` | 对应列 | 对应列别名 |

截图三种形态在内核统一：`kind=attachment`（fileToken）、`kind=path`（本机路径）、`kind=url`（外链）。取不到字节不判整票失败，而是转 `needs-info` 让人补图（`core/scheduler.js:487-540`）。

### 5.2 截图怎么真正进模型

`core/prompt.js:88` `renderTicketContent(ticket, located, images)` 把任务书与截图拼成 content 块数组：`{type:text}` + 若干 `{type:image}`。`core/scheduler.js:339-343` 同时传 `prompt`（纯文本，给只认 prompt 的老适配器）与 `content`（带图）。

**这一段曾经是断的**：修复前截图只落盘、从没作为图像块传给模型，等于「解析截图」只完成了取字节。现已接通并在 `dev-run.mjs` §11 有断言守着。

---

## 6. 错误与重试

### 6.1 错误分类（`src/contracts/errors.js`）

| kind | 可重试 | 语义 |
| --- | --- | --- |
| `auth` | ❌ 致命 | 凭据不对，重试只会继续错 |
| `not-found` | ❌ 致命 | 资源没了 |
| `invalid-input` | ❌ 致命 | 配置或参数写错 |
| `network` | ✅ | 临时网络问题 |
| `rate-limit` | ✅ | 被限流 / 配额耗尽 |
| `internal` | ✅ | 其它内部错误 |
| `aborted` | — | 取消 / 超时 |

### 6.2 调度器如何分档（`core/scheduler.js` `runOne` 的 catch 分支）

| 情形 | 结果 | 是否通知 |
| --- | --- | --- |
| 租约丢失（心跳续租失败） | 回 `pending`，让出这票 | **不通知**（不是人的问题） |
| 被取消 / 超时 | `failed` | 超时才通知 |
| 抛出的可重试错误且 `attempt < maxAttempts` | 回 `pending`，`enqueuedAt = now + 退避` | 不通知 |
| 抛出的不可重试错误 | `failed` | 通知 |
| 执行器**返回** failed 结果 | `failed`（**当前不重试**，见 9.2 第 7 条） | 通知 |

### 6.3 退避

`backoffDelayMs(attempt, retryAfterMs, random)`：基数 30 秒、上限 30 分钟、抖动 0.2。执行器若给出 `retryAfterMs`（如上游说「17:09:35 重置」），优先按它算。

### 6.4 限流识别（`executor-agent/agent-failure.js`，`1f788cb` 修）

从 `agent.session.log` 末条 `turn/end` 事件的 `data.reason.error` 里取 `code` / `message`，归一化后判是否限流（code 命中 `RATE_LIMIT` / `QUOTA` / `SOFT_RATE` 等，或文案命中「被限流 / rate limit / quota exceeded / 429」），命中即转 `PipelineError(rate-limit)` —— **可重试**。

修复前真实故障被误报成 `internal: agent 没有产生任何文件改动` 且标成不可重试，等于「上游配额没了」被当成「代码改不动」。

---

## 7. 安全与权限边界（现状）

| 边界 | 现状 |
| --- | --- |
| 密钥 | 飞书 / GitLab / QQ 授权码走 `ctx.get(credentials)` 现取（`src/index.js:386/408/622`），**不落明文配置**；但 `pushplus.token` 仍是明文配置项（见 9.2 第 13 条） |
| 工单正文不可信 | `core/prompts.js` `UNTRUSTED_TICKET_NOTICE` 拼在消息最前，要求模型把正文当数据、遇到指令就判 `needs-info`（`docs/adr/0003`） |
| git 写权限 | git / verify 走 `fullAccessSandboxPolicy`（`src/index.js:233-266`），理由见 `docs/adr/0004`：Windows ACL 缺 sessionId 时子进程只读，git 写 `.git/FETCH_HEAD` 会 Permission denied |
| 截图外链 | URL 形态截图默认**一律拒**（`source-feishu/index.js:302-308`）：截图地址是外部输入，不设白名单等于让填表的人替服务器发任意请求。`26f0391` 起可由 `match.allowedImageHosts` 显式放行（**只放行点名的主机名，缺省依旧全拒**） |
| 仓库定位 | `locator-table` 只做「工单 projectId → 配置里的项目条目」查表，**不做任何「模块名 → 代码路径」的推断**（那类知识装不进通用插件），代码定位交给 agent 现场读仓库 |
| 坏项目隔离 | `locator-table` 构造期只把坏条目记进 `brokenProjects`、不抛 —— 一个项目配错不会让整条流水线起不来 |
| 敏感文件 | `executor-agent` 有 `SENSITIVE_FILE_PATTERNS` 白名单过滤：**点名暂存** `git add -- <非敏感文件>`，再 `git commit -m <说明> -- <非敏感文件列表>`，被拦文件**连 index 都进不去、留在工作区**，文件名写进提交说明的「未提交」一行（`5b94a17` 起还会进 `plan.summary`）。**不用 `git add -A`**：全量暂存会让 `A application.yml` 露在 index 里，手一抖就提交走了；git 白名单也只放行 `add -- <文件>`，`add -A` / `add .` 一律拒绝 |
| 合并动作 | 插件**只在工作区检出里做一次本地提交，从不 push、从不合并**；远程 draft MR 是 `repo.gitlab.enabled: true` 才走的可选出口，合并同样由人手动做 |
---

## 8. 自测与验证

### 8.1 离线自测（可复跑，不联网）

| 命令 | 断言数 | 结果 |
| --- | --- | --- |
| `node scripts/dev-run.mjs` | **325** | 通过 325，失败 0（2026-11-06 实跑；262 → 274 → 285 → 288 → 293 → 294 → 319 → **325**，319 那批 25 条是「回填工单表 / 保留会话 / 基线收集 / 配置面板」四项改造，再往后 6 条是「选择分支」） |
| `node scripts/chain-smoke.mjs` | **11** | 通过 11，失败 0 |

`dev-run.mjs` 分 24 个小节：

| # | 小节 | 覆盖 |
| --- | --- | --- |
| 1 | 契约层 | 错误分类、阶段机、指纹 |
| 2 | 队列与租约 | 入队、租约、续租、让出 |
| 2b | 多项目主键隔离 | 不同 projectId 不串票 |
| 3 | 整轮 tick（mock 全链路） | 扫描→执行→通知 |
| 4 | 各种失败与收尾 | 扫描失败暴露、通知失败不改票态、分支名清洗 |
| 5 | 修订、退役与人工重置 | 指纹变更、gone、`resetByHuman` |
| 6 | 启动恢复 | `recoverPending` 断点续跑 |
| 7 | 通用仓库定位器 | `projects[]` 查表、坏条目隔离 |
| 8 | 工作区清理 | 过期 worktree 回收（只有开了 `isolateWorktree` 才有 worktree 可清）、`isIsolatedWorktreePath` 前缀校验 |
| 9 | 飞书适配器（离线打桩） | **58 项**：状态值、recordIds、指纹、早停退役、**`writeResult` 回填三列**（+6 条） |
| 10 | P0 修复 | 租约心跳、注入时钟、送达回执配置、人工取消 |
| 11 | §5.1 A 组链路断点 | 截图进 prompt、真实工作区、失败原因、人工重开；**陈旧工作区坐标不复用**（目录已删要重建且不把死坐标传下去 / 换了仓库要重建 / 探测抛错时不重建） |
| 11.6 | `onPhase` 的第二参 | 字符串是「说明」，不能被当字段补丁写进票据 |
| 11.5 | `pipeline_doctor` | 环境体检；**插件版本自检**：落后时给出同步命令与两个指纹，一致/链接安装/比不出来三态各有断言，既有 7 个用例注入 `NO_VERSION_CHECK` 桩避免读真实磁盘 |
| 12 | 组合根接线 | 工具真注册进 ctx、真拿到 store |
| 12b | 注册表真的接上了适配器 | qqmail 推送、agent 执行器 |
| 12c | 走宿主 shell 必须显式带 sandboxPolicy | 写授权 |
| 12d | 工具输出必须是 lossless JSON | `undefined` 会让宿主判整次调用失败 |
| 12e | 平台可插拔 | 状态值可配 + 金山文档接进组合根 |
| 13 | 新适配器 | gitlab 客户端 **78 项**（新增 7 条本地提交断言 + 10 条 `-z` 收集/暂存断言 + **10 条基线/keepSession 断言**，原 51）/ qqmail 推送 18 项 / wps 工单源 25 项 |
| 14 | 项目工作区 | 11 项：目录不存在给可照做的报错、无 `repo.path`、未登记则登记、已登记则复用、create 幂等、无 registry 降级、create 抛错降级、无 fs 服务、fs 说是文件、同项目多票复用、attachSession 归属 |
| 15 | 改代码落点 | `inspectCheckout` 干净/脏/拿不到状态三种情况（`-z -uall` + 排除插件自有目录）；`describeDirtyCheckout` 脏工作区只提醒不拒跑、文案能照着理解；`isIsolatedWorktreePath` 只认 `.agents/worktrees/<name>`；真实 `apply()` 缺省不建隔离 worktree、票据落在工作区根上（`branch` = 检出当前分支、`baseCommit` = 检出 HEAD） |
| 16 | 处理完回填工单表 + 保留工作区会话 | done → 三列都写；`writeBackStatus` 可配、空白回落「是」；`writeBack=false` 完全不写（退化成只读）；failed 不回填；回填失败只记票据、票态不回退、不影响通知；老适配器没有 `writeResult` 时静默跳过；执行器返回 `sessionId` 落到票据、状态里能看到去哪找会话；`pipeline_status` 成功/失败都能一眼看到；skipped 的回填首句要说「验证没跑通，需要人工确认」 |
| 17 | 选择分支 | `parseBranchRefs` 解析 `for-each-ref`（`refs/remotes/` 后只切第一个 `/`、丢掉 `origin/HEAD` 这类符号引用）；`mergeBranchChoices` 排序（当前分支 → 远端默认 → 本地 → 其余远端）；`listBranches` 真跑通；四种拿不到分支的情况（无 `repo.path` / 无 git 执行链路 / 不是 git 检出 / git 抛错）**只返回 `ok:false` + 原因、绝不抛**；游离 HEAD 不算分支名；宿主 remote 暴露 `branches()` 且某个项目配错不影响别的项目 |

### 8.2 真实链路验证记录

| 验证项 | 结果 |
| --- | --- |
| 本地提交（本阶段交付形态） | ✅ `git add -- <非敏感文件>`（点名暂存）→ `git commit -m <说明> -- <非敏感文件>` → `rev-parse HEAD` 全链路实跑，提交说明含工单溯源、验证结论与「未提交」文件清单 |
| 脏工作区只提交 agent 改的 | ✅ 真 git 端到端验过：有基线时人的改动一个都不出现；用户 `git add` 进索引的改动同样被排除 |
| 回填工单表（新） | ⚠️ 代码与自测全绿（`dev-run.mjs` 第 16 节 10 条断言）；真实表待应用拿到**编辑**权限后端到端复跑 |
| 保留会话（新） | ✅ 本地提交那轮的通知与 `pipeline_status` 都能看到 `处理会话：<sessionId>`；agent 实例在 `finally` 里无条件释放 |
| 设置面板（新） | ✅ `client-check.mjs`：descriptor 33 叶子 / 7 组、schema 信封 71 节点 33 叶子、Remote 4 个方法、`projects` 可写 25 字段；`client-smoke.mjs` 85 条断言全过 |
| 真实 GitLab draft MR 创建（可选出口） | ✅ MR !1（sandbox project 33）；现在只有 `repo.gitlab.enabled: true` 才走这条 |
| GitLab 凭据权限 | Owner 级（`/repository/branches`、`/merge_requests` 均 200） |
| QQ 邮箱真实发信 | ✅ `accepted=true`，traceId `<mw319ltk.47861f8c479221d3@qq.com>` |
| PushPlus 适配器 | 已实现，发信通道依赖对方 token |
| 真实飞书表读取 | ✅ appToken `RZZQbY4SkaY6z0shZaBcVpQCnhh` / table `tblWhRSGf0osJqrE`，79 条 |
| 真实飞书工单入队 | ✅ `pms\|reczz28VWNWVefNA`（当时用 `statusValues` + `recordIds` 精确收窄，只收进这一张；宿主 profile 现已去掉 `recordIds` 试点限制，改按状态值整表收） |
| 真实飞书工单改码 | ⚠️ 入队与四要素解析全对；agent 一轮被上游 429 配额挡死（非插件缺陷），宿主侧「`{{model}}` 崩」与「preset 缺服务」两个雷已在 `5b94a17` 排掉，尚未在配额恢复后复跑 |
| 飞书写回状态列 | ⚠️ app 对该表之前只有读权限，写回返 `code 91403 Forbidden`；现在「回填」已是主路径（`writeResult`），需要把应用加成**可编辑**协作者后再验一次；没权限时票仍是 `done`，只在 `pipeline_status` 显示「回填表格：没写成 —— …」 |
| 金山文档真实取数 | ❌ 无开放平台对接（见 9.1 第 3 条） |

### 8.3 环境事实（影响可复现性）

| 事实 | 值 |
| --- | --- |
| 宿主 shell | **Windows PowerShell 5.1**（不支持 `&&`、忽略 `cwd` 字段）→ 一律用 `git -C <path>` |
| DSH 沙箱写权限 | 子进程只能写会话工作区 → 目标仓库必须克隆到 `.repos/` 下 |
| 目标仓库 | `.repos/mgiot-pms`（GitLab project 28，`v2.x`）、`.repos/tp-sandbox`（project 33，main） |
| 宿主 profile 现状（2026-11-06） | pms 项目 `repo.path` = `D:/WorkSpace/mgiot-pms`（直接指向项目工作区）、`match.statusValues` = `["处理中"]`、`fetchBeforeCreate: false`；**已去掉 `recordIds` 试点收窄**（整张表按状态值收） |
| 插件依赖 | **零 npm 依赖**；一切宿主能力从 `options` 注入（插件目录解析不到 `@deepseek-ai/*`） |
| 插件改动生效 | 必须 `cp -r` 到安装副本 `C:/Users/Administrator/.dsh/profiles/desktop/node_modules/@local/ticket-pipeline/` 并重启宿主 |
| 权威票态 | `C:/Users/Administrator/.dsh/storages/ticket_pipeline.json` 的 `tables.tickets`（object，键 = projectId + `\u0000` + recordId） |

---

## 9. 未完成与缺陷清单

下面每一条都定位到了具体文件位置。**「已修（`<commit>`）」= 代码已提交；「已缓解」= 症状减轻但仍非根治；「待修」= 还没人动手。** 所有结论均对照 2026-11-06 工作区源码（HEAD `2488036` + 未提交的「本地提交」改造）核实。

> 本轮（2026-11-06「本地提交」改造）当场关掉一条契约耦合：**~~「GitLab Commits API 是改动唯一出口」~~**。原来 `makeExecResult` 在 `phase=done/skipped` 时必须给 `mr`，等于把「有远端的 GitLab」写进了内核契约；现在 `commit` 或 `mr` 给一个即可，默认交付形态改成工作区检出里的本地提交（`commitLocally`），远程 Commits API 降级为 `repo.gitlab.enabled: true` 才走的可选出口。证据：`src/contracts/work-executor.js`（校验分支）、`src/adapters/executor-agent/index.js`（`commitLocally` / `openDraftMr` 的 `optional` 出口）、`scripts/gitlab-checks.mjs` 新增 7 条断言。

### 9.1 P0 —— 挡住真实工单端到端

| # | 缺陷 | 位置 | 影响 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | **模型默认留空 → 宿主 persona 模板崩**：`agentOptionsFromConfig` 在 `model` 为空串时不带 model，宿主给 agent 会话装 personaPrefix 时含 `{{model}}` 变量 → 装配阶段直接报 `prompt variable "{{model}}" has no value for this assembly` | `src/adapters/executor-agent/index.js`（新增 `resolveAgentOptions`） | 沙盒 002/003 两张票就是这么挂的（attempt=2） | **已修（`5b94a17`）**：新增 `resolveAgentOptions`，配置优先、缺的读宿主 `agentDefaultModel.currentSelection()` 补齐，两项必须成对下发；宿主也给不出就报 `internal` 并说清该配什么。（早期那条「空串不下传即跟随会话默认」的判断是错的 —— 空串就是真的不下发，才会在模板上崩） |
| 2 | **找不到 agentPresets 服务只记日志继续跑**：agent 起来了但是零工具，改不出任何文件，最后报「没有产生任何文件改动」，真因被埋 | `src/adapters/executor-agent/index.js`（`setupAgent`） | headless profile 必现；桌面 profile 也可能缺 | **已修（`5b94a17`）**：改为抛 `invalid-input` 硬失败并列出该配什么（重试没用，是环境问题） |
| 3 | **金山文档无开放平台取数通道**：`wpsOptionsFromMatch` 只支持 `sheetUrl` 全局 fetch 下载，缺登录态大概率失败；无开放平台网关接入 | `src/adapters/source-wps/index.js:371-399` | 需求①的「金山」只有解析能力，没有取数能力 | **待修**（需金山账号 + 管理员审批建应用，或注入 `fetchSheet`） |
| 4 | **`repo.gitlab` 配置被校验层吞掉**：`validateProject` 只复制 `repo.remote/baseBranch/targetBranch`，而 `resolveGitlab` 优先读 `repo.gitlab.baseUrl/projectId` | `src/core/config.js`（`validateProject`） | 自建 GitLab / 子组路径配了也不生效 | **已修（`5b94a17`）**：透传 `baseUrl` / `remote` / `projectId` |
| 5 | ~~**金山表「待修改项目」列的值被丢弃**~~：`toTickets` 用的 `projectId` 是源实例项目名，`makeTicket` 不接收该列的值，表格里那列只留在 `raw.cells` | `src/adapters/source-wps/index.js`（`toTickets` → `targetProject`）、`src/contracts/ticket-source.js` | 需求③「待修改项目」在金山侧拿不到 | **已修（`26f0391`）**：新增 `Ticket.targetProject`，金山该列原值进 `targetProject` 并渲染进任务书；**刻意不顶 `projectId`**（存储主键一半，且该列是人手填的自由文本），任务书里也明确写「不要拿它当目录名直接去改」 |
| 6 | ~~**飞书 / 金山截图白名单没有配置键**~~：适配器读 `options.allowedImageHosts`（`source-feishu/index.js:306`），但 `CONFIG_FIELDS` 无此键、`feishuOptionsFromMatch` 都不透传 | `src/core/config.js`（`validateProject` / `describeConfig`）、`src/adapters/source-feishu/index.js`（`feishuOptionsFromMatch`） | 真实表的截图是文本链接形态 → 取不到图 → 整票转 needs-info（缺省一律拒，且无法从配置放开） | **已修（`26f0391`）**：新增 `match.allowedImageHosts`，校验层归一化（trim + 小写 + 去重、空集合报错）并透传到适配器；**不给缺省值** —— 安全闸门只有人能打开 |

### 9.2 P1 —— 影响正确性与可运维性

| # | 缺陷 | 位置 | 影响 | 状态 |
| --- | --- | --- | --- | --- |
| 7 | **执行器返回 failed 结果时不重试**：调度器只对「抛出的错误」分档重试；执行器返回 `{error:{retryable:true}}` 也直接判 failed | `core/scheduler.js` `runOne`（只看 `normalized.retryable`，而执行器返回结果走成功路径不进 catch） | 可重试的失败被当成终态 | **待修**（但 executor-agent 已改为「限流等真失败一律抛出」绕开这条路，见 9.3 第 26 条） |
| 8 | **没配验证命令却报 done**：「未经验证」和「验证通过」在票面上看不出区别 | `src/adapters/executor-agent/index.js`（`run()` 末尾 `plan.summary`） | 人容易把「完成」误读成「测试过了」 | **已缓解（`5b94a17`）**：`phase` 语义按契约保持不变（`skipped` 是合法成功路径），改为把验证结论写在 `plan.summary` 最前面——通过写「验证通过：…」，没跑/失败写「⚠ 未通过验证（skipped）：…」。彻底区分需要新增 phase，属于契约变更，本轮不做 |
| 9 | **敏感文件只拦不报**：检出敏感文件改动后票仍按成功交付，且只写一行日志 | `src/adapters/executor-agent/index.js`（`run()` 末尾 `plan.summary`、`buildLocalCommitMessage`） | 人最后只会在交付物里发现「少改了一个文件」 | **已修（`5b94a17`）**：被拦文件数与文件名写进 `plan.summary`；**本轮又加一道**：提交说明末尾固定写一行 `未提交（疑似含真实凭据，按约定留在工作区）：<文件名>`，`git show` 就能看到 |
| 10 | **verify 命令只按空白切**：不识别引号 | `src/adapters/executor-agent/index.js`（`splitCommand`） | Windows 下 `node "C:\Program Files\x\check.mjs"` 起不来 | **已修（`5b94a17`）**：认单双引号；引号内反斜杠一律当字面量（否则路径被吃成 `C:Program Filesx`）；未闭合引号报 `invalid-input` 并降级 `skipped` 而不是 `failed`。仍然**不解释** `&&` / 管道 / 重定向（配置项不该成为 shell 注入面） |
| 11 | ~~**recordIds 收窄只有飞书接了**~~：`createRecordFilter` 只被 `source-feishu` 使用 | `src/contracts/record-filter.js` 及四个源的 `scan` 循环 | 金山 / mock / webform 源无法收窄 | **已修（`26f0391`）**：`createRecordFilter` 推广到金山 / mock / webform，名单外行在 `live.add` 之前跳过（不收票、不进水位、不参与退役计数）；`wpsOptionsFromMatch` 也翻译 `recordIds` |
| 12 | **金山 recordId 用行号**：表格插一行会让同一张票换身份 | `src/adapters/source-wps/xlsx.js:611-613` | 插行后旧票变新票 + 旧票退役 | **待修** |
| 13 | **`pushplus.token` 走明文配置**，与 config 层描述「建议走 ctx.credentials」矛盾 | `src/adapters/push-pushplus/index.js:163-171` | 令牌落在 cordis.patch.yml | 待修 |
| 14 | **死配置**：`logLevel` 与 `concurrency` 只出现在配置定义里，代码无任何消费点 | `src/core/config.js:126/287/312/367` | 改它们不生效 | 待修 |
| 15 | **`PipelineError.retryAfterMs` 有写入但无读取方**（退避从未按上游建议时间算） | `src/contracts/errors.js:43-47` | 上游说「17:09 重置」，实际只按 30 秒基数退避 | 待修 |
| 16 | **飞书工单源只支持多维表格，电子表格进不来** —— ① `normalizeAppToken` 的 wiki 节点查询把 `obj_type: 'bitable'` 硬写进 query（`src/adapters/source-feishu/index.js:763-766`），`:770-775` 把 `sheet` 判成「不是多维表格」并抛错，错误文案里还写着「sheet=电子表格」不支持；② `searchBitableDocs` 只认 `type === 'bitable'`（`:713`）；③ 配置校验只认「`appToken`+`tableId`」或「`docNamePattern`」二选一（`src/core/config.js:494-501`），只给 `spreadsheetToken` 的配置在启动时就被拒 | `src/adapters/source-feishu/index.js`（`normalizeAppToken` / `searchBitableDocs` / `resolveTable`）、`src/core/config.js`（`validateProject`） | 用户的飞书工单表如果是电子表格，插件**完全扫不出票**，且报错文案指向错误方向（像权限问题，实际是代码路径问题） | **设计已定，待实施** —— 方案与排期见 `docs/ticket-pipeline/feishu-sheet-source.md`（5 人日，探测 + 读值 + 行身份三条主线）、决策见 `docs/adr/0005-飞书电子表格源按表型分派.md`（不新增 `platform`，表型由插件探测；电子表格没有 `record_id`，行身份用序号列值、缺省兜底物理行号） |

### 9.3 P2 —— 健壮性与体验

| # | 缺陷 | 位置 |
| --- | --- | --- |
| 17 | 飞书 token 无 single-flight；401/403 不清缓存 → 密钥轮换后最长 2 小时全失败 | `src/adapters/source-feishu/index.js` |
| 18 | 飞书四处请求未传 `signal`；fetch 无请求级超时；URL 截图裸 fetch 有 SSRF 面 | `src/adapters/source-feishu/index.js` |
| 19 | 附件无字节上限 | `src/adapters/source-feishu/index.js` |
| 20 | `pickNext` 不排除中间相位（planning / testing 等） | `src/core/store.js:387-395` |
| 21 | 飞书早停时把「未访问」当「不存在」计退役；指纹先更新后判定 → 改内容再改回旧内容永不触发 updated | `src/adapters/source-feishu/index.js` |
| 22 | `notifyFor` 用不会 abort 的 signal；`locator.locate` 不传 signal | `core/scheduler.js`、`src/adapters/locator-table/index.js` |
| 23 | `tools/define.js` 的 integer 校验不查 min/max（`pipeline_status` 声明了 min1/max100，0/1000 照样放行） | `src/tools/define.js:135-138` |
| 24 | `ownerToken` 含 pid + 时间戳 → 重启后旧租约最多阻塞 10 分钟 | `src/core/store.js:78-81` |
| 25 | 无定时器卸载钩子；agent 泄漏（`agents.create` 返回的 `dispose` 已在 `1f788cb` 改为 `await created.dispose?.()`，老宿主退回 `agent.release?.()`） | `src/index.js`、`src/adapters/executor-agent/index.js` |
| 26 | **限流只能靠抛异常绕开**：executor-agent 把「上游 429 / 配额」转成 `PipelineError('rate-limit')` 抛出后才会进退避队列；若哪天有人改回「返回 failed 结果」，重试又会失效（根因是 9.2 第 7 条） | `src/adapters/executor-agent/agent-failure.js`、`src/core/scheduler.js` |

---

## 10. 要不要重构

**结论：不要推倒重来，做定点修复 + 补两个适配器。**

### 10.1 支持「不重构」的依据

| 依据 | 说明 |
| --- | --- |
| 内核零平台知识 | `core/` 与 `contracts/` 里 grep 不到任何飞书 / 金山专有字段；平台差异全在 `SOURCES` 表与适配器目录里 |
| 契约自洽 | 8 个契约文件、11 个 phase、7 类错误都有单测覆盖（`dev-run.mjs` 第 1 节） |
| 回归网够密 | **325** 项离线断言全绿，改一处坏一处会立刻被看见 |
| 装配层已是表驱动 | 加平台 = 加目录 + `SOURCES` 一行（ADR-0001） |
| 坏隔离已做 | 一个项目配错不拖垮其它项目；能力名拼错只记日志 |

### 10.2 真要重构的话，只有这两处值得动

| 建议 | 理由 | 代价 |
| --- | --- | --- |
| 把 `scheduler` 里「执行器返回结果」与「执行器抛异常」两条失败通路合并成一条 | 现在可重试性判断被分裂在两处，行为不一致（9.2 第 7 条） | 中，要动调度器核心 + 补测试 |
| 把 `src/index.js`（1 059 行）按「装配 / 工具注册 / 轮询」拆三块 | 文件偏大，但拆了也不改变行为 | 低，收益也一般，**不建议本轮做** |

### 10.3 建议的推进顺序

第二步与第二步半互不阻塞，第二步半可与第二步并行。

| 阶段 | 内容 | 判据 |
| --- | --- | --- |
| 第一步（`5b94a17` + `26f0391`，**已完成**） | 9.1 的 P0 里除金山取数通道外全部关掉；9.2 的 5 条关掉；收窄开关推广到四个源 | ✅ 自测 242/242；沙盒 001 已真跑出 MR !1 |
| 第一步补（**已完成**） | 项目工作区：票 → 项目 → 宿主 Workspace 登记（`core/workspace.js`），会话 cwd = 工作区根 + `workingDirectory` 钉隔离目录（仅 `isolateWorktree: true` 时）+ `attachSession` 归属 | ✅ 自测 262/262（新增 11 项工作区断言 + 7 项执行器会话断言） |
| 「本地提交」改造（**已完成**，2026-11-06） | 交付形态从远程 draft MR 换成本地提交：`commitLocally`、`ExecResult.commit`、`repo.gitlab.enabled` 总开关、通知/状态/体检三处文案 | ✅ 自测 269/269（新增 7 条）；`gitlab-checks` 51 → 58 |
| 「改代码落点」改造（**已完成**，2026-11-06 晚） | 缺省直接在项目工作区的检出里改代码、就地提交（要求检出干净），新增 `isolateWorktree`（默认 `false`）把隔离 worktree 降级成可选项；`isIsolatedWorktreePath` 堵住清理误删主检出 | ✅ 自测 274/274（新增 5 条，`dev-run.mjs` 第 15 节）；见 §1.3 |
| 「改动收集改 `git -z`」缺陷修复（**已完成**，2026-11-06 深夜） | 未跟踪新文件漏提交、路径被引号/八进制转义、未跟踪目录折叠导致敏感文件绕过、`.agents/worktrees` 污染检出 —— 四个坑一并修；新增契约 `src/contracts/git-status.js`、新增 `unstageSensitiveFiles`、删除三个非 `-z` 解析导出 | ✅ 自测 285/285（新增 11 条）；`gitlab-checks` 58 → 68；真实 git 端到端探针通过；见 §1.4 |
| 「陈旧工作区坐标不得复用」缺陷修复（**已完成**，2026-11-06） | 守卫只看字段有没有值 → 目录已删/换了仓库仍复用死路径，`workingDirectory.set` 对着空气报错；`resetByHuman` 不清坐标、`recoverPending` 不管 failed，两处放大器让票重置后必然复现 | ✅ 自测 288/288（新增 3 条）；见 §1.5 |
| 「插件版本自检」（**已完成**，2026-11-06） | 宿主加载的是 profile 下的目录副本（跨盘 `file:` 落成复制），HMR `root: []` 不监听源码 ⇒ 改完不同步就静默跑旧代码；新增 `src/core/plugin-version.js`，`pipeline_doctor` 比对安装副本与源码的**文件内容**，落后时给出同步命令，只进「提醒」 | ✅ 自测 288 → 293（新增 5 组断言）；见 §1.6 与 `architecture.md` §12.11 |
| 「`setPhase` 清不掉字段」缺陷修复（**已完成**，2026-11-06） | `setPhase` 把补丁里所有 `undefined` 一概过滤，于是调用方写的每一种「清掉」都静默失效：成功票上挂着上一轮 `lastError`（真实事故：`pms\|reczz28VWNWVbpgL` 跑成 done 却显示 `provider "workbuddy" has no configured model`），启动恢复以为清了死坐标其实没清。改为「键不存在 = 不动 / 键在值为 undefined = 删掉」 | ✅ 自测 293 → 294（新增 1 条走真实重试路径 —— 旧的那条是 `resetByHuman` 兜的假绿）；见 §1.7 |
| 「回填 / 保留会话 / 基线 / 面板」四项改造（**已完成**，2026-11-06） | ①处理完回填工单表（`TicketSource.writeResult` 唯一写入口 + `writeBack`/`writeBackStatus`，见 §1.8）②处理完保留会话（`ExecResult.sessionId` + `keepSession`，见 §1.9）③脏工作区只提交 agent 改过的文件（`createBaseline` + `describeDirtyCheckout`，`assertCleanCheckout` 删除，见 §1.10）④设置面板补齐（`projects` 子树可编辑 + 第 3 个 Remote 方法，配置 33 键 / 7 组，见 §1.11） | ✅ 自测 319/319（新增 25 条，`dev-run.mjs` 第 16 节 + 第 15 节改写）；`feishu-checks` 52 → 58、`gitlab-checks` 68 → 78；`client-check` / `client-smoke` 全绿 |
| 「选择分支」改造（**已完成**，2026-11-06） | `repo.baseBranch` / `repo.targetBranch` 带候选下拉：`src/core/branches.js`（`parseBranchRefs` / `mergeBranchChoices` / `listBranches` 绝不抛）+ 第 4 个 Remote 方法 `ticketPipeline.branches()`（一次返回全部项目）+ 面板字段 `kind` 从 `text` 改 `branch`（`<input list>` + `<datalist>`，不做纯 `<select>`），见 §1.12 | ✅ 自测 319 → **325/325**（新增 6 条，`dev-run.mjs` 第 17 节）；`client-check` 的 `kind` 白名单加 `branch`，Remote 描述符 4 个方法一致 |
| 第二步（当前） | 真实飞书票 `pms\|reczz28VWNWVefNA` 复跑一次全链路 | 收到真 QQ 邮件、邮件里有本地提交 sha 且能 `git show` 到、`verify.test` 真跑过 |
| 第二步半 | **飞书电子表格支持**（设计见 `docs/ticket-pipeline/feishu-sheet-source.md`，决策见 `docs/adr/0005-飞书电子表格源按表型分派.md`） | 5 人日；`dev-run` 325 → 345；一张真表读出一张真票 |
| 第三步 | 补金山开放平台取数通道 | 给一张真实金山表链接 + 凭据，能扫出票 |
| 第四步 | 9.2 / 9.3 剩余项按需修 | —— |