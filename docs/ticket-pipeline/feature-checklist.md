# 工单流水线插件 · 功能清单与完成度

> 生成日期：2026-11-05
> 代码基线：工作区 `D:\WorkSpace\dsh-ticket-pipeline`；本轮「appToken 贴整条表格链接」的代码与本文同一次提交，上一轮已提交代码为 `789f6b2`（`6fb9f08` 是配置页页签式改版、`789f6b2` 只改文档）；插件目录 `plugins/ticket-pipeline`
> 最近一次更新：2026-11-10（晚），**总览里每张工单多一行「9 个主站」的流程带** —— 上一轮把
> `pipeline_status` 缺省改成按项目聚合的总览之后，每张工单只剩一行摘要（阶段 + 停在第几站），
> 人还是看不出「这一票整条路走得顺不顺、哪一站慢/哪一站挂了」：那部分只在 `view: 'tickets'`
> 的九行日志里。现在总览每票下面多一行 `①✓ ②✓ ③✓ ④✓ ⑤✓（13 分 42 秒） ⑥✓ ⑦✓ ⑧✓ ⑨✓｜全程 13 分 53 秒`，
> 符号 `✓/✗/▶/–` 分别是「做成 / 没做成 / 正停在这一站 / 没走过」，图例在抬头下面只印一次。
> 三个刻意的取舍：**只给 ≥1 分钟的站标耗时**（①②③④ 常在 1 秒内，全标反而看不出哪里慢）；
> **终态票最后一站不标耗时**（用「现在」兜底会让昨天跑完的票显示「⑨发送消息（24 时 32 分）」）；
> **老票没有时间线时说「没有流程记录」而不是画九个 `–`**（那等于说「插件当时一个站都没走到」）。
> 返回体 `tickets[].flow` 给机器可读的九站结构。见 `architecture.md` §11.5、本文 §1.25。
> `dev-run` 483 → **486/486**。
> 同日上一轮**`pipeline_status` 缺省改成「按项目聚合的总览」** —— 以前只有一种输出形态
> （逐票一段）且 `includeDone` 缺省 `false` 会先筛掉终态票，两个后果都很难受：票全跑完时只回一句
> 「这次筛选一条都没命中」（明明库里有 6 张），票一多每票十几行、想看「哪个项目卡了」得从头翻。
> 现在新增视图参数 `view: 'overview' | 'tickets'`（**缺省 `overview`**）：总览按 `projectId` 聚合，
> 每个项目一行战报（共几张、几张要你动手、最近动静）+ 每票一行状态，**恒为全库口径**（`includeDone`
> 不参与），项目按「要你动手的多少」排序，每项目最多 8 张（超出折一句，`total` 不缩水）；
> `view: 'tickets'` 保持原明细，传 `recordId` 一律走明细。**新增参数而不是改 `includeDone` 的缺省语义**，
> 因为后者已被 `dev-run` 里 22 处调用依赖。返回体多 `view` 与 `projects[]`（每项
> `{projectId,total,counts,tiers,needsYouCount,needsYou[],awaitingReviewCount,runningCount,queuedCount,latestActivityAt}`），
> 见 `architecture.md` §11.5。同日早前**飞书电子表格支持落地** —— 以前只认多维表格，用户把电子表格
> 链接贴进 `match.appToken` 会被 `get_node` 里硬写的 `obj_type: 'bitable'` 判成「不是多维表格」，
> 一张票都扫不出来，报错还指向「权限」这个错误方向。现在适配器按表型分派（`sheet` 走电子表格
> 分支、`bitable` 走原来的路、老服务端不返回类型时按多维表格兜底），新增 9 个 `match.*` 配置键、
> 面板多一组「飞书电子表格」，`validateProject` 从「二选一」改成「四选一」放行。首版只读不写，
> **已于 2026-11-10 补齐回填（工单 #22，见 §1.23）**：`values_batch_update` 写三格、按序号列重新定位行、
> 四类失败各有说法。同轮还补齐了「不知道怎么填」的字段说明、
> 并给 `repo.path` 加了「选择目录」按钮（接宿主 `uiWorkspace.pickDirectory()`），见 §1.21。
> `dev-run` 384 → **451/451**、`feishu-checks` 60 → **80** 条、`client-smoke` 113 → **175 条**、
> `client-check` 面板项目字段 29 项与宿主 descriptor 对得上。此前同日**设置面板「添加项目」失败修好**（原来点「+ 添加项目」会立刻发一笔
> `settings.mutate`，而新项目带空的 `repo.path`，宿主对整份配置一次性校验 ⇒ 必然被
> `projects[n].repo.path 必须是非空字符串` 整笔拒掉，用户永远加不进去。现在改成「垫一张空卡片，
> 填完点顶部保存才与其它改动一起作为一笔提交」，见 §1.18），`client-smoke` 113 → **123 条**；
> 顺手把 `repo.remote` 的面板标签从「远端名」改成「GitLab 仓库地址」（它要的是仓库 URL 不是 git 远端名）；
> 此前同日**`appToken` 贴整条表格链接真的够了**（`parseBitableUrl` 挪进 `src/contracts/types.js`，
> 配置校验与飞书适配器共用：从 `?table=` 啃出 `table_id`、`?view=` 啃出 `view_id`，显式 `tableId` 仍优先；
> 此前只有适配器认得这个写法，用户在配置里只贴一条链接会被 `validateConfig` 拦在启动前），
> `dev-run` **384/384**、`feishu-checks` 58 → **60** 条（都是那一轮的值；电子表格支持后现为 **482/482** 与 **93** 条）；此前同日「配置页改成页签式、视觉对齐宿主设置页」
> （项目 / 参数 / 凭据 / 体检四个页签、一次只画一页、下划线式页签、卡片改用宿主 `settings-card-*` token 并去掉阴影、拆掉三层套娃、
> 面板不再铺灰底，见 §1.17），`client-smoke` 105 → **113 条**，`dev-run` **376/376** 全绿；
> 此前 2026-11-06 新增**关键节点流程日志（时间线）**（票据 `timeline` 17 节点表、9 主站 ①–⑨、
> `pipeline_status` 排成时间线并写「现在停在第 N 站，已 X 分 Y 秒没动」，见 §1.16），自测 **376/376** 全绿；
> 此前同日新增**配置页 UI/UX 大改造**（Label 置顶、高级参数折叠、凭据统一走顶部保存、
> 项目清单可增删、卡片化 + Switch 开关，顺手修掉 `[object Object]` 渲染 bug，见 §1.15），
> `client-smoke` 94 → **105 条**；此前同日新增四项改造 —— **处理完回填工单表**（`TicketSource.writeResult` 唯一写入口 + `writeBack` / `writeBackStatus`）、**处理完保留会话**（`ExecResult.sessionId` + `keepSession`）、**只提交 agent 真正改过的文件**（`createBaseline` 用 `git stash create` 拍基线，脏工作区也能跑，`assertCleanCheckout` 删除）、**设置面板补齐**（`projects` 子树可编辑 + 第 3 个 Remote 方法 `ticketPipeline.projects()`，配置变 33 键 / 7 组，现为 24 键 / 4 组）、**选择分支**（`repo.baseBranch` / `repo.targetBranch` 从手打改成带候选的输入框，第 4 个 Remote 方法 `ticketPipeline.branches()`，见 §1.12）、**设置面板瘦身**（项目卡片可收起、缺省只留 8 个常改字段、「显示全部字段」开关收高级项，见 §1.13），**上线加固**（5 条阻断项 + 4 条重要项：适配器名强校验、验证命令超时与取消、敏感名单 8 类 41 条、`.git`/profile 篡改自检、`pendingEffects` 事后动作补偿、回填失败进通知、租约诚实化，见 §1.14），该轮自测 **363/363** 全绿（后补时间线，现为 482/482）；此前同日新增「插件版本自检」（`src/core/plugin-version.js` + `pipeline_doctor` 第 5 节：比 profile 里声明的源码目录与安装副本的**文件内容**，不落后才静默，落后就给出同步命令），自测 294/294；此前同日新增「本地提交」改造（交付形态改为在项目工作区的检出里做一次真实本地提交，远程 GitLab draft MR 降级为 `repo.gitlab.enabled: true` 才走的可选出口）+ 当晚的「改代码落点」改造（`isolateWorktree` 缺省 `false`：直接在项目工作区的检出里改，检出脏也能跑；`true` 才每票开隔离 worktree）+ 改动收集改走 `git -z`（未跟踪新文件、重命名、中文名/空格名、`.agents/worktrees` 污染四个坑一并修掉），自测 285/285；2026-11-05 深夜的「项目工作区」改造（票 → 项目 → 宿主 Workspace 登记，会话 cwd = 工作区根）自测 262/262；再此前 `26f0391` 把收窄开关推广到三个源、「待修改项目」列不再丢、飞书截图白名单可配，连同 `5b94a17` 的 agent 侧四项，自测 242/242。同日另出「飞书电子表格支持」设计（**2026-11-09 已实施**，见 `docs/ticket-pipeline/feishu-sheet-source.md` 与 `docs/adr/0005-飞书电子表格源按表型分派.md`；当时估的 5 人日最终没按这个口径走，一天内做完，见 §1.21）
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
| ① | AI 同时监控多个平台（金山共享 Excel、飞书）上的工单表，检测内容变化 | **✅ 可用** | 飞书源 2 470 行（`index.js` 1 891 + `sheets.js` 579），已接真实表（appToken `RZZQbY4SkaY6z0shZaBcVpQCnhh` / table `tblWhRSGf0osJqrE`，79 条记录实测），**多维表格与电子表格都认**（按表型分派，见 §1.21）；金山源 1 660 行（xlsx/zip 自解 OOXML）；webform/mock 演示源 | 金山缺开放平台取数通道，只能用注入的 `fetchSheet`；飞书「收票状态值」与真实表语义不一致，已做成可配（`statusValues`）；电子表格首版**只读不回填** |
| ② | 可以在插件中配置对应工单的项目本地仓库地址 | **✅ 可用** | `projects[].repo.path` / `remote` / `baseBranch` / `targetBranch` / `gitlab`（enabled / baseUrl / projectId / remote），由 `locator-table`（187 行）把工单 projectId 映射到仓库；`repo.gitlab` 已能在配置校验层存活（`5b94a17`），`gitlab.enabled` 是远程 MR 出口总开关、缺省 `false` | 无（这项已补齐） |
| ③ | 解析每张工单中的待修改项目、问题描述、操作流程及截图 | **⚠️ 部分** | 飞书列映射 `contracts/feishu-columns.js` 的 13 个语义字段 + 两套表型共用 `mapColumns()` 别名解析（描述/操作流程/截图/模块/优先级/发现日期等；多维表格每轮先读 `/fields` 的真实字段名，见工单 #21）；金山列别名表 `xlsx.js:34-42`（含「待修改项目」）；截图三形态（附件 / 路径 / URL）都已建模并作为 `ImageBlock` 进消息 | ① 飞书表**没有「待修改项目」列**（实测列名只有：序号/发现部门/问题描述/发现日期/模块/操作流程/截图/优先级/是否处理/处理人/处理结果/处理日期）；② ~~金山表该列的值被丢弃~~ → **已修（`26f0391`）**：金山表该列的值现在进 `ticket.targetProject` 并写进任务书（不顶 `projectId` —— 那是存储主键的一半，而这一列是人手填的自由文本）；③ ~~URL 形态截图默认全拒、无配置键~~ → **已修（`26f0391`）**：新增 `match.allowedImageHosts` 白名单配置键（缺省仍为空 = 一律拒绝，安全闸门只有人能打开） |
| ④ | 自主规划并执行修复 | **⚠️ 部分** | `executor-agent` 真实现：先确保**项目工作区**（`repo.path` 目录在宿主 `workspaceRegistry` 里登记，一个项目一条，多票共用）→ `agents.create({meta:{cwd: workspacePath}})` + 挂 preset + （仅 `isolateWorktree: true` 时）`workingDirectory.set(worktreePath)` + `attachSession` 归属工作区 + followup + `git diff --name-status` 收集改动 + 敏感文件过滤；沙盒票 `sandbox\|rec-mock-001` 已由 agent 真改出 `src/pagination.js`，当轮开成 MR !1（**本轮改成在工作区检出里做本地提交**，见 §1.2） | 真实业务票（pms）只在配额上卡过一次；两处宿主侧雷已修（`5b94a17`：`{{model}}` 补齐、preset 缺服务硬失败），但**尚未在真实 pms 票上完整跑绿一次**（上游 workbuddy 429 配额限制，非插件缺陷） |
| ⑤ | 完成后对问题功能进行测试，自动提交 PR | **✅ 基本可用** | 真跑出 GitLab draft MR `http://gitlab.example.com/mk/end/ticket-pipeline-sandbox/-/merge_requests/1`（sha `634777aa…`，changes_count=1，源分支 `ticket-sandbox-rec-mock-001-r1`）；验证命令从 `projects[].verify.build/test` 注入，`verify.test` 真跑出 exit 0。**本轮起默认交付形态改成工作区检出里的本地提交**（`commitLocally` → `ExecResult.commit = {sha, branch, files}`），远程 draft MR 变成 `repo.gitlab.enabled: true` 才走的可选出口 | 没配验证命令时 `phase` 仍是 `done`（契约里 `skipped` 是合法成功路径），现在把验证结论写进提交说明以免误读（`5b94a17`）；要彻底区分得新增 phase，属契约变更 |
| ⑥ | 通过微信 Clawbot 推送或 QQ 邮箱推送（先实现）完成通知，收到后看 PR 详情，人工验证后手动合并 | **✅ QQ 邮箱可用；微信走中继** | QQ 邮箱零依赖 SMTP 适配器（574 行）已真实发信成功（traceId `<mw319ltk.47861f8c479221d3@qq.com>`）；PushPlus 适配器 171 行 | 插件**不直连微信**：微信消息经 PushPlus 的 `clawbot` 渠道中继，需配 `pushplus.token`；PushPlus 回执未消费 |

### 1.1 端到端真实跑通记录（唯一一次全绿的真实链路）

工单：`sandbox|rec-mock-001` —— 沙盒仓库的「列表页按状态筛选后，翻到第二页会跳回第一页」。

| 环节 | 实际结果 |
| --- | --- |
| 扫描入队 | 水位对比识别为新票，进 `pending` |
| 工作区 | 先确保 `repo.path` 这个目录在宿主 `workspaceRegistry` 里有一份登记（一个项目一条，多票共用）；当轮（2026-11-05）再 `git worktree add` 建本票的隔离检出 `.agents/worktrees/ticket-sandbox-rec-mock-001-r1`，会话 header 的 cwd 是工作区根、`workingDirectory` 钉到 worktree。**现在缺省不再切 worktree**：直接在工作区检出里改（脏也能跑，先拍基线、只提交 agent 改过的），`isolateWorktree: true` 才退回这一条 |
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
| 通知正文 | 首行 `draft MR：<url>` | 正文第一段是 项目/工单序号/模块/优先级 + 描述前 3 行，**描述之后**有一行 `本地提交：<sha 前 12 位> @ <branch>（<worktreePath>）`；仍配了远程出口的部署才多一行 `draft MR：<url>` |
| skipped 尾注 | （MR 已开成 draft，但验证没跑通，请人工确认） | （改动已交付到工作区检出；验证命令没通过，请人工确认这份改动是否可用）；邮件标题 `phaseLabelOf('skipped')` 改成「已交付（验证未通过，待人工验证）」 |
| 阶段中文名 | `mr-opening` = 正在开 MR；`skipped` = 已开 MR，但未跑通验证 | `mr-opening` = 正在本地提交；`skipped` = 已交付，待人工验证 |
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
`gitlab-checks` 里 `await check(` 从 51 → 58 → **68 → 86**（后两段见 §1.12、§1.14）。

隔离目录这一层也要说明白：**缺省不隔离** —— 直接在该项目工作区的检出里改代码、就地提交，
开跑前用 `git status --porcelain -z -uall`（连同排除规则，见 §1.4）看一眼，**检出不干净也照跑**：
先 `createBaseline()` 拍一份只读基线（`git stash create`），结束后只提交 agent 真正改过的文件（见 §1.10）；
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
| `pipeline_doctor` | 只报凭据与 remote | 缺省模式额外读一次检出状态：干净显示「检出干净，可以直接跑票」，脏显示「检出不干净：N 个未提交改动（照跑，只提交 agent 改过的）」并只在提醒里说（不算必须修复，见 §1.10）；并打一行「ℹ️ 改代码落点：项目工作区检出里（脏也能跑，只提交 agent 改过的文件）」/「ℹ️ 改代码落点：每票一个隔离 worktree（.agents/worktrees/）」 |

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
| 正文 | `renderWriteBackResult()`：首句（skipped 是「已按工单改完并提交到工作区检出，待人工验证（验证命令没通过）。」）+ 改动文件（最多 8 个）+ 验证结论 + 本地提交 sha/分支/路径 + draft MR（若开）+ 处理会话 id + 末段「要进一步修改，把这个单元格清空、把「是否处理」拨回「处理中」即可重跑。」 |
| 飞书实现 | `PUT /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/{record_id}`，body `{ fields: { 是否处理, 处理结果, 处理日期 } }`；字段缺失（业务码 1254040 / 1254045）返 `{ written:false, note }` **不抛**，其余异常照抛 |
| 开关 | `writeBack`（bool，缺省 **true**）、`writeBackStatus`（str，缺省 `'是'`） |
| 可观测 | `pipeline_status` 每票多一行 `回填表格：成功（是否处理、处理结果、处理日期）` 或 `回填表格：没写成 —— <原因>`；返回体多 `writeBack` |
| 决策 | 新增 [ADR-0006](../adr/0006-处理完回填工单表.md) |

**为什么写在 `writeResult` 而不是塞进 `scan`**：`scan` 是高频、可重试、随时可能被取消的只读动作；
写必须低频（一票一次）、只在真出结果之后。混在一起的后果是「扫一半就把表写了」和「重试一轮写一次」。

**新增断言**（`dev-run.mjs` 第 16 节 + `feishu-checks.mjs`）：三列都写、`writeBackStatus` 可配且空白回落、
`writeBack=false` 一个请求都不发、failed 不回填、回填失败票态不回退、老适配器没实现时静默跳过、
skipped 的首句要说「待人工验证」（不要用否定式收尾）。`feishu-checks.mjs` 52 → **58**。

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
`client-smoke.mjs` 85 条断言全过（加「项目卡片折叠」6 条后 94 条）。

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
自测 **325/325** 全绿（当轮；上线加固 + 时间线后现为 **482/482**）；`client-check` 的 `kind` 白名单加了 `branch`，Remote 描述符 4 个方法一致；
真机验证 `listBranches` 在 `D:/WorkSpace/mgiot-pms`（当前 `v2.x`，候选 `v2.x`/`master`/`workbuddy/v2-x-8ef29a33`/`main`）、
本仓库（`v0.0.1`/`main`）、`.repos/tp-sandbox`（`main` + 3 个 worktree 分支）上都返回正确清单，
不存在的路径返回 `fatal: cannot change to ...`。

### 1.13 设置面板瘦身 + 项目卡片可收起（2026-11-06）

**要解决什么**：§1.11 把 `projects[]` 搬进面板之后，一屏放不下 —— 一个项目 5 个分区 21 个字段，
两个项目就是 42 行输入框，`repo.path`（每次都要看）和 `allowedImageHosts`（一年改一次）视觉权重一样。
真正常改的只有 8 个字段，其余 13 个是「配一次就不动」。

**做法**：

| 环 | 落点 |
| --- | --- |
| 折叠 1 | 项目卡片整体可收起：头部一个按钮（`.tp-proj-toggle`），收起后只留项目名 + 平台徽标 + 「已改 N 项」+「N 项待修」。**缺省展开** —— 人是来看「我该填什么」的，一进来全收起等于让他先点两下才看得见路径输入框 |
| 折叠 2 | 卡内 5 个分区各自可收起（`.tp-group-toggle`），状态与全局配置分组**分两个 localStorage 键**（`ticket-pipeline:open-projects`），否则不同项目里同名的「仓库」组会互相带 |
| 折叠的边界 | **改过或有错的字段永远露出来**（`sectionVisible` / `fieldVisible` 里的 `exempt` 短路）。否则高级字段被改过后从界面消失、人看不见也撤不回来，保存时却照样写进去 |
| 简化 1 | `PROJECT_SECTIONS` 引入 `advanced: true`：`description`、`viewId`、`recordIds`、`allowedImageHosts`、`mediaPrefix`、`repo.remote`、`repo.gitlab.enabled`、整组 `verify` 收进「显示全部字段」开关（缺省不显示）。缺省视图剩 8 个字段 + wps 组 |
| 简化 2 | `PROJECT_SECTIONS` 引入 `onlyFor: 'wps'`：金山那 5 个字段只在平台是 wps 时出现。**平台以草稿为准**（人刚把 mock 切成 wps，金山组要立刻出现，不用等保存） |
| 简化 3 | 开关本身不进 localStorage ——「我现在要配细节」是一次性意图，记住它反而让下次进来又是一屏 |
| 不删字段 | 隐藏 ≠ 删字段：`PROJECT_SECTIONS` 里 21 个 path 一个没少，`client-check` 的「面板 21 项与宿主 descriptor 对得上」照旧成立 |

**为什么两个折叠类名分开（`.tp-group-toggle` / `.tp-proj-toggle`）**：`client-smoke.mjs` 原来按
`.tp-toggle` 一把捞、断言「配置分组有 3 个折叠标题」；项目卡片与卡内分组加进来后变成 7 条，
断言就红了，而且红得看不出是哪儿错。各认自己的类名，断言才能稳定表达「配置分组有 3 个」。

**验收**：`dev-run` 363/363（当轮；时间线后现为 482/482）、`client-check` 全绿（21 项仍对得上、Remote 4 个方法一致）、
`client-smoke` **85 → 94 条**（新增「卡片有折叠开关 / 默认展开 / 收起后不再渲染字段 / 收起后仍显示项目名 /
aria-expanded 变 false / 再点一次展开回来 / 卡内有可折叠分组」7 条）。

---

### 1.14 上线加固：5 条阻断项 + 4 条重要项（2026-11-06，工作树未提交）

**要解决什么**：上线前审计查出 5 条阻断与 4 条重要问题 —— 全都是「出错时不是报错，而是悄悄跑歪」那一类：
适配器名写错会静默换成 mock（等于假执行却报成功）、验证命令没有超时（一条卡住的 build 会让整条流水线
`already-running` 静默停摆且取消不了）、敏感名单只覆盖 9 种文件名（`prod.env` / `bootstrap.yml` 漏拦）、
agent 能改 `.git/hooks` 与插件 profile、终态与「事后动作」（回填表格 / 发通知）不是同一次落库（进程在两步
之间挂掉就永久丢动作）。

**做法**：

| 环 | 落点 |
| --- | --- |
| 1 适配器名强校验 | `core/config.js:170` `enum: Object.freeze(['agent', 'mock'])`、`:248` `Object.freeze(['mock', 'pushplus', 'qqmail'])`；`src/index.js:256 pickAdapterFactory(table, requested, fieldName, label)` 查不到就抛 `invalid-input` 并列出可用值。`undefined` / `null` / 空串仍回落 mock（首次安装要能跑起来） |
| 2 验证命令超时与取消 | `src/index.js:598 export const VERIFY_TIMEOUT_MS = 30 * 60 * 1000`、`:607 export const VERIFY_TIMEOUT_EXIT_CODE = 124`；`makeCommandRunner(ctx)` 收 `{ argv, cwd, signal, timeoutMs }`，`signal?.aborted` 抛 `PipelineError('aborted', '验证命令还没开始跑就被取消了。')`，超时返回 **124**（与「检查未通过」的普通非 0 区分）。宿主 `dsh-bash-local` 的 `maxTimeoutMs` 缺省 10 分钟，`clampTimeout` 取两者较小值 —— 真实上限是 10 分钟，要 30 分钟得改 profile |
| 3 敏感名单 8 类 41 条 | `adapters/executor-agent/index.js:109 export const SENSITIVE_FILE_PATTERNS`（原来 9 条）：`.env` 家族（含 `env.local` 这类只在后缀白名单里的写法）、Spring（`application*` 与 **`bootstrap*`** 的 yaml/properties/conf/json）、包管理器 token、SSH·GPG、云与容器、明文机器凭据、证书·密钥库·Terraform 状态、关键字兜底 `/secret/i`。已知后缀白名单是为了**不误伤** `src/env.js` / `docs/credentials.md` / `.environment.md` |
| 4 `.git` / profile 篡改自检 | `executor-agent/index.js:194 GIT_HOOK_NAMES`（28 个官方 hook 名）、`:206 PROTECTED_GIT_FILES`（10 个：`config` / `config.worktree` / `HEAD` / `commondir` / `shallow` / `packed-refs` / `info/attributes` / `info/exclude` / `info/grafts` / `info/sparse-checkout`）、`:212 PROTECTED_PROFILE_FILES`（4 个 `cordis.*`）；`:250 snapshotProtectedPaths()` 用 `options.readFile` 拍 sha256 指纹，`:635 compareProtectedSnapshots()` 比对，动了就 `:641 unstageSensitiveFiles()`（`git restore --staged --`）撤回并判 `failed` + `invalid-input`（不可重试）。**没有 `readFile` 服务时跳过自检、票照常交付** —— 这是安全降级，不是漏洞回避 |
| 5 终态与事后动作同一次落库 | `core/scheduler.js:473-503`：终态那次 `setPhase` 同时写 `pendingEffects.writeBack` 与 `pendingEffects.notify`；`clearPendingEffect`（`:752`）刻意**不走 `setPhase`**，因为它会重写 `finishedAt`，让「这一票跑了多久」失真；`replayPendingEffects()`（`:771`，`src/index.js:1205` 启动时调）扫残留终态票把回填与通知补做完。`store` 的 `enqueue` / `revise` / `resetByHuman` 三处**都不继承** `pendingEffects` |
| 6 回填失败进通知 | `scheduler.js:1153-1154`：`row.writeBack.written === false` 时通知正文多一行 `回填表格：没写成 —— <原因>（表格里那一行可能还停在「处理中」，请手工改一下）`；成功时不加行（避免噪音） |
| 7 就地重跑起点 | `isolateWorktree: false` 时每轮重取 `snapshot.head` 当起点；上一轮已提交过、重跑时 agent 没有新改动会被判「没有产生任何文件改动」—— 预期行为，日志里会写出新旧两个 head |
| 8 租约诚实化 | 从「CAS」改口径为「**best-effort 租约**」：同进程靠 scheduler 的 `running` 单飞，跨进程靠 put 后二次读确认（被抢就记日志让出）。宿主 `storageDomain` 的 table API 只有 get/entries/put/delete，**没有 compare-and-swap 原语** |

**为什么 `approval/policy` 仍写 `never`**：宿主只提供 `ask` / `never` 两档，没有「只读自动批、写入弹卡」这一档；
`ask` 在无头场景 fail-closed，会让 agent 的每一步工具调用都失败。所以只能退回 `never` 并打一条 warn
（`executor-agent/index.js:1152`）。兜底只有 git 白名单 + 提交前篡改自检，**不是硬隔离**。

**新增断言**：`dev-run` 325 → **363/363**（当轮；第 16b 节「事后动作补偿（`pendingEffects`）与租约诚实化」14 条；时间线后现为 482/482）；
`gitlab-checks` 78 → **86**（敏感名单覆盖与不误伤、`.git/hooks` 与 `cordis.patch.yml` 篡改判失败、无 `readFile` 跳过、
白名单放行自检要用的 `rev-parse` 形态、`blockedFiles` 可见、受保护路径边界）；
`wps-checks` 25 → **34**（下载通道超时/取消/字节上限/逐跳重定向校验、`scan` 传 signal）；
`workspace-checks` 11 → **19**（验证命令 signal 已 aborted 不起进程、跑到一半取消即 kill、到点返回 124、30 分钟缺省、
适配器名写错要抛并列出可选值）。

---

### 1.15 配置页 UI/UX 大改造（2026-11-06）

**要解决什么**：面板功能全了，但一屏全是「左边一长串说明文字 + 右边输入框」，33 个配置项加 21 个项目字段不分主次；
更糟的是 `projects` 被当成普通字段渲染，`draftValueOf` 把对象数组 `join` 成 `[object Object], [object Object]` 摆在页面上。

**做法**：

| 环 | 落点 |
| --- | --- |
| 修 `[object Object]` | `lib/client.js` 的 `collectLeaves` 剔除 `projects`（`path.length===1 && path[0]==='projects'`）：它是结构化数组，由 `ProjectListCard` 画成卡片，当普通叶子会被 `draftValueOf` 拼成 `[object Object], [object Object]` |
| Label 置顶 | `.tp-field` 从 `grid-template-columns:minmax(140px,220px) 1fr`（左右两栏）改成上下三行：加粗字段名 / 输入框 / 浅灰说明（`1-60，缺省 3` 这种）；字段走 `repeat(auto-fill,minmax(260px,1fr))` 网格 |
| 高级参数折叠 | 新增 `ADVANCED_CONFIG_KEYS`（`safePageRun` / `goneAfterScans` / `concurrency` / `leaseHeartbeatSeconds` / `maxAttempts` / `fetchBeforeCreate` / `branchPrefix` / `worktreeRetentionHours` / `writeBackStatus` / `qqmail.port` / `qqmail.secure` / `pushplus.channel` / `pushplus.template` / `pushplus.callbackUrl`）收进组内「高级设置」折叠；**改过的和有错的字段永不藏**；刻意不收 `enabled` / `logLevel` / `qqmail.host`（自测断言它们必须可见） |
| 凭据统一操作 | `CredentialRow` 删掉每行小「保存」，改由顶部主「保存」一次提交（`onSave` 里先发 `credNs.set`、**不 await**，再同步 `ns.mutate`）；「已配置」用绿色 Tag（`✓ 已配置`），输入框 placeholder「已配置，留空即不修改」；「清除」保留但加 `window.confirm` 二次确认；`state` 字段名与宿主 `remote.credentials.describe()` 对齐（`configured` / `writable`） |
| 项目可增删 | 「+ 添加项目」走 `['projects', '<len>']` + `set` 追加；卡片头「删除」走 `['projects', '<i>']` + `unset`（宿主 `applyPathOp` 对数组是 `splice(i,1)`）。两者都复用现有 `settings.mutate` 通道，**不新增 Remote 方法**；有未保存字段改动时禁用，避免下标错位 |
| 卡片化 | 面板浅灰底（`--dsw-alias-bg-layer-1`）、卡片纯白 + 圆角 + `box-shadow:0 2px 8px rgba(0,0,0,.05)` + 24px 内边距；输入框 36px 高、限宽 |
| Switch 开关 | 布尔项换成 `role="switch"` + `aria-checked` 的开关（宿主 `practices.md` **禁止** `require('@deepseek-ai/dsh-client-ui-primitives')` 之类加载客户端包，只能自写控件、抄宿主 markup/CSS/行为） |
| 顶部操作条 | 顺序照草图：放弃改动 / 重新载入 / 体检 … 保存（主按钮最右，全页只此一颗 `tp-primary`） |

**自测**：`client-smoke` 94 → **105 条**（新增：凭据每行不再有「保存」按钮、清单无 `[object Object]`、
「+ 添加项目」/「删除」按钮、`role="switch"` 语义、布尔不落回原生 checkbox、全页只一颗主按钮）；
`client-check` ✅（descriptor 33 叶子 / 7 组、Remote 4 方法、面板 21 项对得上）、`dev-run` **363**（当轮；时间线后现为 482）、`chain-smoke` **11** 全绿。

---

### 1.16 关键节点流程日志（时间线）（2026-11-06）

**要解决什么**：用户要「完整的关键节点的流程日志，不然我不知道哪里有问题了或者卡在哪里了」——
覆盖「获取工单 → 查找对应工单的项目 → 检查是否存在工作区 → 创建会话选择分支和模型 → 处理工单问题
→ 处理完成后提交 → 发消息给我」这条整链。以前只有按时间散落的插件日志，看到「阶段 → testing」
之后迟迟没有下一条，说不清是卡在跑验证里、还是已经死了、还是差一步发通知。

**做法**：

| 环 | 落点 |
| --- | --- |
| 17 节点表 | `contracts/types.js:63 TIMELINE_NODES`：9 主站带 ①–⑨（discover / locate / workspace / session / editing / testing / mr-opening / writeback / notify）+ 8 补充站用 `no:'·'`（worktree-ready / planning / pending / needs-info / done / skipped / failed / gone）。**节点 id = phase 名**，⑤⑥⑦ 与终态由 `onPhase` 直接查表打点，不维护反查表 |
| 记录结构 | `TimelineEntry = {node,label,at,ok,detail?}`；`at` = 写下时刻 epoch ms（相邻 `at` 差 = 上一站耗时，现在 − 最后 `at` = 距最后动静多久）；`ok` 只有布尔 true/false（✓ / ✗），没有「进行中」三态 |
| 持久化 | `core/store.js appendTimeline(key,node,detail,ok,label)`：连续同 node 同 ok 合并成一条（保留最新 `at`/`detail`，`worktree-ready` 会连触发两次）、上限 80 条丢最旧。**刻意不走 `setPhase`**（它会重写 `finishedAt` 且要过阶段转移校验，而记日志可发生在任何阶段含终态） |
| 唯一写入口 | `core/scheduler.js markNode(...)` 包 `try/catch`（**记日志绝不能把票带崩**）；`markExtra(...)` 给补充站查表补 `label`。扫描入队记 ①、定位仓库记 ②、工作区新建/复用/陈旧重建记 ③、`executor.run` ctx 加 `onFlow` 让真 agent 报 ④、成功收尾记 ⑧⑨、各失败分支（超时/取消/退避/不可重试/needs-info/租约丢失）记 ✗、`replayPendingEffects` 补做标「补做」 |
| ④ 会话详情 | `adapters/executor-agent/index.js reportFlow(ctx,log,node,label,detail,ok)` 通过 `ctx.onFlow` 上报会话 id、provider+model、分支、工作目录；`resolveAgentOptions(...)` 上提保证与实际下发的一致；`executor-mock` 不调 `onFlow`（合法） |
| 历史不清空 | `timeline` 是历史不是本轮状态：`enqueue` 的 `if(existing)` 显式继承、`revise` 用 `{...existing}` 自然保留、`resetByHuman` 也不清空、只在末尾补一条 `pending` 分隔记录「人工重置，重新入队」 |
| 渲染 | `tools/pipeline-status.js describeFlow(row,now)` 倒序找最后主站、算 `stalledForMs` / `station` / `lastNodeOk`；`renderTimeline(row,now)` 排成 `11-06 20:14:58  ⑥ ✓ 跑验证 —— 开始跑验证命令（上一站 5 秒）` + `▶ 现在停在第 ⑥ 站「跑验证」，已 3 分 25 秒没动。`；needs-info 特别写「这一站在等人，不是插件卡死」，终态写「已经收尾」。固定 UTC+8 纯算术换算、`now` 可注入（整次查询用同一个「现在」） |
| 机器可读 | 返回体 `tickets[]` 加 `timeline` / `stalledForMs` / `station` / `lastNodeOk`；`stripUndefined` 会删掉 undefined 键，老票无时间线时 `timeline` 恒为 `[]`、不引入 `undefined` |

**为什么不做「进行中」三态**：「最后一条记录落在哪个节点 + 距今多久」已经能回答「卡在哪」；
多一种状态就要多维护一处「谁把 running 改成 ok」的更新点，反而容易漏、容易骗人。

**验收**：`dev-run` 第 **16c** 节 13 条断言全绿（主站顺序 / `at`/`ok`/`label` 合法性 / 相邻 `at` 单调 /
`onFlow` 报的 ④ 进时间线 / 失败站记 ✗ / 连续合并 / 80 条封顶 / 重新入队继承 / 人工重置不清空 /
`pipeline_status` 渲染「已 1 分 35 秒没动」/ 终态与 needs-info 文案 / 返回体四字段 / 老票无 undefined）；
累计 **376/376**（当轮；补 appToken 链接解析 2 条后现为 **482/482**），26 小节。真实链路探针跑一轮 mock tick 得 11 条时间线（④ 因 mock 不上报而缺席，合法），
渲染探针给出「现在停在第 ⑥ 站」与 `station/stalledForMs` 返回值。详见 `user-guide.md` 的「日常循环 →
为什么这么慢、卡在哪一站」、`architecture.md` §11.4、`operation-flow.md` §1/§7。
（2026-11-10 起 `README.md` 已瘦成 42 行的入口页，不再有 §5.2.1 这类章节号。）

---

### 1.17 配置页改成页签式，视觉对齐宿主设置页（2026-11-09）

**要解决什么**：§1.15 做完后用户仍说「配置页面太复杂了 样式也太丑了」。复看渲染树，两条硬伤：

- **太复杂**：四个大区块（体检 / 凭据 / 参数 / 项目清单）首尾相接竖排在一条线上，一屏 1300 多字，
  四张卡片长得几乎一样，**没有任何分区导航** —— 用户不知道从哪儿看起，也不知道哪些是「一次性调好的」、
  哪些是「日常要动的」。
- **太丑**：亮色主题下 `--dsw-alias-bg-layer-1/2/3` 与 `--dsw-alias-bg-base` **全是 `#fff`**，而上一版
  把面板底设成 `bg-layer-1`、卡片设成 `bg-base` ⇒ **白叠白**，层级只能靠 10% 透明度描边撑着；
  再叠加「灰面板 → 白卡 → 灰项目卡」三层套娃和每张卡上的阴影，视觉上就是「一堆框糊在一起」。
  另外这一版还**铺了一层 `#f9fafb` 灰底**，在宿主原本透明的设置区里像贴了一块异色区域。

**做法**：

| 环 | 落点 |
| --- | --- |
| 页签导航 | 新增 `TABS = [项目 / 参数 / 凭据 / 体检]`、`TAB_KEY = 'ticket-pipeline:open-tab'`、`readTab()` / `writeTab(key)`；`aria-selected` + `role="tablist"`。**缺省停在「项目」** —— 它是主线（一张工单表绑一个仓库），参数与凭据是一次性调好的配角。**（工单 #16 之后变成五个页签、缺省改「运行」，见本文 §1.22）** |
| 一次只画一页 | 主渲染改成 `panels = { projects, params, creds, doctor }` + `panels[activeTab]`，非当前页签的子树**根本不渲染**（不是藏起来），一屏字数从 1320 降到 601 / 148 / 467 / 128 |
| 页签角标 | `tabBadge(key)` 只在真有未保存/待修时才挂数字：参数页 = 未保存的配置项数（有校验错则显示错误数并转红），凭据页 = 待提交的凭据条数，项目页 = 未保存的项目改动数，体检页 = `problems.length` |
| 顶部工具条 | `TABS` 在左、`tp-bar-actions`（待修 / 未保存 / 放弃改动 / 重新载入 / 保存）在右，**吸顶**。「体检」从按钮变页签后工具条不再放重复入口 |
| 提示不随页签消失 | `saveError` / `saveMessage` / `loadError` 渲染在页签内容之外：保存针对整份配置，错在哪页都得看见 |
| 下划线式页签 | 抄宿主 `PluginsSettingsSection`：`border-bottom:.5px solid border-l2` + `[aria-selected=true]::after` 2px 底条；**不用胶囊分段** —— 胶囊只在宿主少数工具条里出现，设置区的惯例是下划线 |
| 去掉面板灰底 | `.tp-panel` 改透明 + `max-width:880px`，不再铺 `bg-module-platform` |
| 卡片用宿主 token | `--dsw-alias-settings-card-fill` / `-stroke` + `--dsw-radius-lg`，**去掉阴影**（白底 + 半像素描边本就是宿主卡片的标准做法，再叠阴影就糊） |
| 拆掉三层套娃 | 项目卡去掉自己那层灰底盒子：原来是「灰面板 → 白卡 → 灰项目卡」，现在就是白卡里的一段，靠 `border-top:.5px` 分隔 |
| 项目清单标题行拆分 | 原来 `h3` 一行里塞了「项目数 / 显示全部字段 / + 添加项目 / 重新读取」5 个控件、窄屏还折行；拆成「标题 + 项目数 badge」+ `p.tp-note` + 单独一行 `div.tp-list-bar` |
| 字号回归宿主比例 | 标题 18px/600、说明 13px、字段名 13px/500、输入框 32px 高（上一版 36px 偏大） |
| 折叠类名分开 | 项目卡内分区按钮 `'tp-toggle'` → `'tp-toggle tp-sec-toggle'`，与配置分组的 `tp-group-toggle` 区分，自测才能分别数 |

**为什么用页签而不是「再折一层」**：折叠只能把内容**藏到别处**，用户仍然要在一个长列表里反复展开收起来找；
页签给的是**并列关系**（四件不相干的事），一次只面对一件。上一版已经折过一层（分组折叠 + 卡内分区折叠），
用户依然说太复杂，说明问题不在「一次显示多少」而在「这些块之间是什么关系」没人告诉他。

**自测**：`client-smoke` 105 → **113 条**（新增：四个页签、`role="tablist"` 语义、缺省选中「项目」、
非当前页签不渲染内容；原有依赖「四块同屏」的断言按页签重校准 —— 参数页输入控件门槛 7 → 6，
因为凭据的 5 个密码框不再同屏；「项目卡内可折叠分组」改用 `tp-sec-toggle` 计数）。
`client-check` ✅（descriptor 33 叶子 / 7 组、schema 信封 71 节点 33 叶子、Remote 4 方法、面板 21 项对得上）、
`dev-run` **451**（当轮 384；22 张工单落地后为 **482**）、`chain-smoke` **11** 全绿。

---

### 1.18 「添加项目」失败：面板把半成品当成要立刻落库的写操作（2026-11-09）

**要解决什么**：用户在设置页点「+ 添加项目」，红字报

```
添加项目失败: invalid config: - projects[2].repo.path 必须是非空字符串（本地 git 检出根目录）(at projects.2.repo.path)
```

**根因**（两个事实叠在一起）：

1. `lib/client.js` 的 `onAddProject()` 以前**点下去就发 mutate**，新项目带 `repo: { path: '' }`
   （空壳，等用户填）：
   `value: { name: '新项目' + (next + 1), description: '', match: { platform: 'mock' }, repo: { path: '' } }`。
2. 宿主 `src/core/config.js:526-527` 对**整份配置**做 `~standard.validate`，`repo.path` 空就
   `fail('repo.path', '必须是非空字符串（本地 git 检出根目录）')`；**任一 issue 整笔回滚**。

⇒ 「先加个空壳再慢慢填」这条路从来就走不通，用户只能在外部手改 `cordis.patch.yml`。
`invalid config: - <path> <message> (at <path>)` 这个前缀是**宿主 loader** 拼的（插件里没有这个字面量）。

**做法**（选「垫卡片 + 一次保存」，否决「给个占位路径」和「让宿主放宽校验」）：

| 环 | 落点 |
| --- | --- |
| 加项目变纯本地 | `onAddProject()` 不再发 mutate：`blankProjectRecord(index)` 造一条缺省 `match.platform: 'mock'`（唯一免凭据平台）的记录塞进新状态 `projPending`，并把 `projectDrafts(record, index)` 的键铺进 `projDraft` —— 新卡片与真卡片共用同一套编辑/撤销/校验路径（绝对下标） |
| 保存时一起提交 | `collectOps()` 末尾追加 pending 循环：`{ op:'set', path:['projects', String(projList.length + q)], value: buildProjectValue(...) }`，宿主 `applyPathOp` 允许 `index === length` 时 set 一项。**新增与其它改动同 revision，要么全成要么全不成** |
| 组装完整对象 | `buildProjectValue(record, index, draft)` 按 `PROJECT_SECTIONS` 铺平；空串/空数组/false **一律不写**（写 `statusValues: []` 会被 `validateProject` 判错）；末尾兜底 `name` / `match.platform` / `repo.path` 三键 |
| 未填完不许保存 | `localProjectIssues` 改吃 `renderedProjects`（真项目 + pending），空壳参与校验 ⇒ 顶部「保存」灰掉并提示「N 项待修」 |
| 撤掉 vs 删除 | `onRemoveProject(index)` 双分支：`index >= projList.length` 只从 `projPending` splice（按钮文案「撤掉」，**不发 mutate**），并用 `addProjectDraftKeys` 把剩余 pending 的草稿键从旧下标搬到新下标；已保存的项目仍立即 `unset`（宿主 `splice`，按钮文案「删除」+ 确认框） |
| 成功/放弃时清干净 | `onSave()` 成功后 `setProjPending([])`（否则 `loadProjects()` 回来的真项目会和 pending 叠成两份卡片）；`onReset()` 也清 |
| 计数不炸 | `changedCount` 把 pending 项目**整张按 1 计** —— 否则刚点一下「+ 添加项目」就显示「未保存 21 项」 |

**顺手修的两个体验坑**：

- **出错不再吃掉整个清单**：`ProjectListCard` 原来 `error.length > 0` 时把 `body` 整个换成一行红字，
  两张项目卡片凭空消失；现在红字单独一行留在清单下方。
- **有未保存改动不再锁死「+ 添加项目」**：按钮 `disabled` 去掉了 `props.dirty`（垫卡片本身就会让
  `projectDirty` 为真，留着等于只能加一个），标题改成「在面板上加一个空项目（填完点顶部「保存」才写进配置）」。
- 顺带把 `repo.remote` 的面板标签从「远端名 / 缺省 origin」改成「**GitLab 仓库地址**」——
  它真正要的是仓库 URL（`resolveGitlab` 用它 `parseGitRemote` 推 `baseUrl` + `projectId`），
  `src/core/config.js` 的 descriptor 同步改；这两个标签此前一直误导用户去填 `origin`。

**自测**：`client-smoke` 113 → **123 条**（新增「按钮不被 dirty 锁死 / 点了不写宿主 / 多出一张卡 /
空壳时保存被拦住 / 填完保存后 mutate 里出现 `['projects','1']` 完整对象且 `repo.path` 非空 /
保存后「未保存」徽标消失」）。
调试时踩到两个选择器坑：卡片要用精确正则 `/^tp-proj( tp-collapsed)?$/`（`indexOf('tp-proj')` 会把
`tp-proj-head`/`tp-proj-body`/`tp-proj-toggle` 一起捞进来）；找「仓库」分区不能用 `indexOf('仓库')`
（「基本」分区的 hint 里也有「仓库」二字），改成认 `仓库仓库路径` 这一段。

---

### 1.19 「从 0 到 1」审计：新用户视角下修掉的 4 件事（2026-11-09）

拿「一台干净机器上的新用户」当标准，把安装 → 凭据 → 飞书权限 → 检出 → 配置 → 首跑 → 日常使用整条路走了一遍，
再逐个核对 33 个配置键与 25 个项目字段。四项必修：

| # | 症状（新用户会遇到什么） | 根因 | 落点与改法 |
| --- | --- | --- | --- |
| 1 | 体检长期挂 `⚠️ 凭据服务不可用（ctx.credentials 缺席）`，看起来像装坏了；但飞书其实能正常读 `app_secret` | `makeCredentialsDescriber(ctx)` 在 `apply()` 时取一次 `ctx.get('credentials')` 并缓存成 `null`，之后再也不重取；而凭据服务由宿主 base composition 提供，挂载时刻晚于插件 `apply()`。真正读 secret 的 `makeSecretReader` 是每次重取，所以能工作 | `src/index.js`：`makeCredentialsDescriber` 改成惰性 `current()`（每次调用重取）+ 暴露 `available()`；`src/tools/pipeline-doctor.js` §3 三分支：服务可用→逐个 `describe`；服务没挂上→**进 `problems`** 并说明是宿主组合问题（确认 profile 挂了该服务 / 重装后完全重启）；连描述器都没有→`ℹ️ 内部接线问题，不影响跑票` |
| 2 | 按文档配完一切，票永远不动，而体检报「环境体检通过」 | `enabled` 缺省 `false`（安全默认），`pipeline_status` 会说「总开关是关的」，但 `pipeline_doctor` **一个字都不提** | `src/tools/pipeline-doctor.js` §2 开头加 `✅ 总开关：已开启，会按 pollIntervalMinutes 自动扫表` / `⏸️ 总开关：关着（enabled=false）——不会自动扫表，也不会跑任何票。去设置页「参数」页签把 enabled 打开，或者直接调一次 pipeline_scan 手动跑一轮。`。**关着只进 `warnings` 不进 `problems`**——这不是装坏了，进 problems 会让人以为环境有故障 |
| 3 | 票处理完了，表格里那一格却写不进去，票据上挂一句像插件坏了的 `internal:`，还会被当成可重试错误反复重试 | 用的是飞书**同步表**（数据由连接器同步进来），飞书不允许直接改行：`800074911 ConnectorSyncTableActionForbidden` / `[status_code: 800004105 msg: syncTable can not apply action:action=data.setRecord …]` | `src/adapters/source-feishu/index.js`：新增 `SYNC_TABLE_FORBIDDEN_ERROR_CODES = new Set([800074911, 800004105])` + `isSyncTableForbiddenError(error)`（先 `/(?:报错|错误码)\s*(\d+)/` 取码比对，再 `ConnectorSyncTableActionForbidden`、`syncTable … can not/cannot`、裸码兜底）；`writeResult` 的 catch 在 `isFieldMissingError` 之后加分支，退化成 `{written:false, note:'这张多维表格是「同步表」…要么在原系统里看结果，要么把 writeBack 关掉…要么换成自己建的非同步表…飞书原话：…'}`。**重试一万次也一样，所以不能算网络类可重试错误** |
| 4 | 进程被杀在「改到一半」，重启后票**永久卡死**：恢复日志说 `resumed: 1`，票一步不动；`pipeline_reset` 又只认 failed/needs-info/gone，救不回来 | `recoverPending()` 把票恢复成原中间态（`planning`/`testing`）寓意「停在本步重做」，但 `store.pickNext()` **只挑 `pending`**，而 `tick()` 的唯一入口就是 `pickNext()` —— 恢复完之后没有任何代码路径会再把它交给执行器 | `src/core/recover.js`：恢复终态统一成 `pending`。工作区坐标有效就**留着**（`runOne` 会先问 `isStaleWorkspaceCoords`，坐标仍然有效就直接复用那个检出，不重新 clone）；失效则清掉 `worktreePath`/`branch`/`baseCommit`/`commit`/`mr` 再回 `pending` 重建。「上次停在哪一步」写进 `lastError` 给人看。真机事故现场：三张 sandbox 票停在 `testing`/`planning` 就这样躺了三天 |

**配置页核对结论（全新用户视角）**：

- `CONFIG_FIELDS` **24 个叶子 / 4 组**（行为 / agent 与模型 / 通知 / 高级；当轮是 33 个 / 7 组，后来把 `safePageRun`、`goneAfterScans`、`concurrency`、`leaseHeartbeatSeconds`、`fetchBeforeCreate` 收成内置常量，删掉 `pushplus.token`、`pushplus.template`、`qqmail.port`、`qqmail.secure`、`logLevel`）；`getConfigDescriptor()` 与面板三方一致（`client-check` 守）。
- 项目字段 descriptor 里 **25 个**，面板只画 **21 个**。缺的 4 个：`match.appToken`（含明文密钥，宿主不下发，面板只显示「已配置（前 4…后 4）」）、`repo.gitlab.baseUrl` / `repo.gitlab.remote` / `repo.gitlab.projectId`（只能改配置文件）。**这是设计而非缺陷，但新用户不知道**。
  **（2026-11-10 已改）：**现在 descriptor 是 **34 个深层路径**、面板画 **33 个**，缺的那一个只有 `match.appToken` —— 而且它不再是「只能手改」：项目卡片里有「工单表链接」，贴整条 URL、宿主解析后落盘，明文不进浏览器（工单 #11）。`repo.gitlab.*` 三个字段也补上了可填输入框，收进「远程 MR（实验性）」组（工单 #19）。三处数字的口径差异见 [`reference/config.md`](reference/config.md) 开头那张表。
- 空清单文案原来写「如果当前宿主还不支持通过设置通道写 `projects`，保存时会把宿主原话显示出来 —— 那就改 profile 的 `cordis.patch.yml`」，**对现在的面板已经过时**，改成「点上面的「+ 添加项目」加一个：先在面板上垫一张空卡片，填完右边这些必填项，再点顶部「保存」。」+「一个项目 = 一张工单表 + 一个本地 git 检出。最少要填 `name`（唯一）、`match.platform`、`repo.path`；飞书来源还要手填 `match.appToken`」。

**自测**：`dev-run` 378 → **382**（+4：凭据描述器「服务晚于 apply() 挂上也能用」、doctor 区分「服务没挂上 / 这个 ref 没配」、doctor 必须说出总开关、「恢复完必须能被 pickNext 捡起来」并反向断言「工作区有效时不得清坐标」）；`feishu-checks` 59 → **60**（同步表回执）。

---

### 1.20 票据行里的数字键脏字段：老 bug 留下的疤，不会自己好（2026-11-09）

真链路跑完之后翻存储，发现两张票的票据行里各多出 18 个数字键字段：

- `sandbox\0rec-mock-001`：`"0":"跑" "1":"项" "2":"目" … "17":"码"`
- `pms\0reczz28VWNWVefNA`：`"0":"a" "1":"g" "2":"e" … "17":"码"`

正好是 `onPhase('editing', '跑项目配置里的验证命令书，开始改代码')` 这类**阶段说明字符串**被
`Object.entries` 展开的样子。这个 bug 本身已经修掉了 —— `store.setPhase` 现在有闸
（`if (typeof patch !== 'object') throw new TypeError('setPhase: patch 必须是对象…')`，
提交 `be05b71` `fix(kernel): 阶段说明别当字段补丁写进票据`，2026-11-05 14:34），
`onPhase` 也会把字符串参数单独识别成「只记日志的说明」。

**但已经落库的行不会自己好**。并且 `setPhase` / `appendTimeline` / `clearPendingEffect`
全都是 `{ ...row }` 展开后整体写回，于是这十几个垃圾字段会一路被带下去 —— 修得掉来源，
修不掉存量。清单核对时读到这张票，`Object.keys()` 里会突然冒出 `0`–`17`。

**改法**（`plugins/ticket-pipeline/src/core/store.js`）：新增模块内 `isNumericKey(name)` 与
`sanitizeRow(row)`，在**读的出口**（`getTicket` / `listTickets`）剔一次数字键。票据行本来就没有
任何字段以数字命名，所以按「数字键」剔不会误伤正常字段（若按白名单剔，就要跟着
`TicketRecordRow` 一直维护，漏一个字段就悄悄删掉它）。因为所有写路径都是「先读、再整体写回」，
下一次任何写入就会顺手把存储里的脏键清走 —— 不需要迁移脚本，也不需要用户手动清库。

**自测**：`dev-run` 383 → **384**（`票据行里的数字键脏字段会被剔掉，且下一次写入把它从存储里清走`：
先往存储里手工写 5 个数字键，断言 `getTicket` / `listTickets` 读出来都干净、`description` 等正常字段不受影响，
再 `appendTimeline` 一次，断言存储里的数字键也消失了）。

---

### 1.21 飞书电子表格支持：同一张平台下的两种表型（2026-11-09）

**背景**：飞书里「多维表格」和「电子表格」是两种文档类型，API 完全不同 —— 多维表格有 `app_token` /
`table_id` / `record_id` / 行级 `last_modified_time`，电子表格只有 `spreadsheet_token` / `sheet_id`，
**没有行级 id、也没有行级修改时间**。插件以前只认前一种，而报错方式很误导：`normalizeAppToken` 查 wiki
节点时把 `obj_type: 'bitable'` 硬写进 query，于是电子表格被服务端判成「不是多维表格」，抛出的文案是
「请在飞书里确认工单表是一张多维表格」—— 用户看到会以为是权限或配置问题，实际是代码路径压根没通。

**决策**（`docs/adr/0005-飞书电子表格源按表型分派.md`）：**不新增 `platform`**。`PLATFORMS` 是「平台」表，
bitable / sheet 是**同一平台上两种文档类型**，硬拆成两个 platform 会让用户在飞书里换一种表格就要重配整个
项目。改成在适配器内部按表型分派。

**代码落点**：
- 新增 `plugins/ticket-pipeline/src/adapters/source-feishu/sheets.js`（**579 行纯函数**）：列名别名表
  `SHEET_COLUMN_ALIASES`（飞书 12 列 + 金山别名，另加处理人/处理结果/处理日期）、`REQUIRED_SHEET_FIELDS`
  （`description` + `status` 缺一不可）、`resolveSheetColumns` / `mergeSheetAliases` / `mapColumns`（`match.sheetColumns` 与 `match.columns` 都只覆盖不替换；两套表型共用同一份解析器）、
  `columnLetter` / `columnIndex` / `parseSheetRange` / `buildValueRange`、`resolveWorksheet`（按 id / 名字 / 第一张可见）、
  `locateSheetHeader`（**不往下扫表头**）、`cellReader`、`buildRowIdentity`、`sheetPriorityOf`、
  `normalizeSheetDate`（回 `YYYY-MM-DD` 字符串）、`parseSheetRows`（**同轮序号重复直接报错**）。
- `plugins/ticket-pipeline/src/adapters/source-feishu/index.js`（1 452 → 1 891 行）：
  `get_node` 的 query **只剩 `token`**，表型读 `node.obj_type`（老服务端不返回时按 bitable 兜底）；
  `searchBitableDocs` → `searchCloudDocs` 认 `type ∈ {bitable, sheet}`；`resolveTable` 成为**表型分派总闸**
  （显式 `tableKind` → `spreadsheetToken` → `appToken` 双试 → `docNamePattern`）；`scan` 拆成
  `scanBitable`（翻页 + 早停）/ `scanSheet`（一次读全表 + 逐行指纹、mtime 恒 0、**不早停**）。
- `plugins/ticket-pipeline/src/core/config.js`：`validateProject` 从「`appToken`+`tableId` 或 `docNamePattern`」
  改成**四选一**（`appToken`+`tableId` / `spreadsheetToken`+`sheetId` / `spreadsheetToken`+`sheetName` /
  `docNamePattern`）；9 个键（`spreadsheetToken` / `sheetId` / `sheetName` / `sheetHeaderRow` / `sheetIdentity` /
  `sheetIdColumn` / `sheetColumns` / `sheetRange` / `tableKind`）透传 + 校验；descriptor 的 `match` 组加 8 个叶子。

**三处「试错分流」是这段代码里最容易写错的地方**：
1. **auth / rate-limit / network / internal 的错不许去试另一种表型** —— 那是真故障，换接口只会把真因埋掉，
   用户会拿着「既不是多维表格也不是电子表格」的文案去找权限问题。
2. **已经证明是多维表格就别换** —— `resolveBitableTableByIdentity` 能成功列出数据表，说明 token 就是
   bitable，只是 `docNamePattern` 没匹配上，这时给 error 打 `confirmedBitable = true`，`shouldTrySheet` 见它返回 false。
3. **`docNamePattern` 只用来挑云文档，不再用来过滤数据表名** —— 第四步已经用它挑出唯一那张表，若再拿它过滤
   `tables` 清单会 0 命中（`resolveBitableTableByIdentity(token, signal, false)`）。

**首版范围：只读不回填**（**2026-11-10 已改，见 §1.23**）。当时电子表格分支的 `writeResult` 在 `resolveTable` 之后立刻挡掉，返回
`{ written: false, note: '这张工单表是飞书「电子表格」，首版只支持从电子表格读票、不支持回填…' }`。
不能让它往下拼 —— sheet 分支上 `table.appToken` / `table.tableId` 根本不存在，拼出来是
`/bitable/v1/apps/undefined/tables/undefined/records/sh-seq-3`，一个必然 404 的请求，还会被当成可重试故障反复重试。
当时断言里专门验证了「一个非 GET 请求都不发」。
**后来发现这个「只读」不只是缺个功能，它会自我放大**：「是否处理」永远停在「处理中」⇒ 下一轮扫描
把同一张票再收一次。工单 #22 因此把它补上了（`values_batch_update` 三格 + 每次重新定位行）。

**面板与配置说明**（同轮一起做的，见用户第 ②③ 条诉求）：
- 项目卡片多一组「飞书电子表格」（`PROJECT_SECTIONS` 第 6 组，`onlyFor: 'feishu'`）8 个字段，
  每个都写了「这一格该填什么」；`sheetIdentity`（`seq` / `row`）与 `tableKind`（空 / `bitable` / `sheet`）是下拉。
- `sheetColumns`（电子表格）/ `columns`（多维表格）都用**一行文本** `description=我的列名, status=我的状态`（对应控件的 `kind: 'columns'`），
  保存时由 `parseColumnsDraft()` 解析回对象，值里带 `|` 会拆成数组（`seq=序号|编号`）。
- `sheetName` **只在「工单表」组画一次** —— 金山组和飞书组各画一次会变成两个输入框绑同一个草稿键，
  `client-check` 直接报「重复字段：match.sheetName」。
- `repo.path` 那格多了「选择目录」按钮，接宿主 client service `uiWorkspace.pickDirectory()`（原生目录选择器）。
  `uiWorkspace` **不写进 `inject`** —— 没装 `dsh-client-ui-workspace` 的部署里硬依赖会让本 fiber 永不激活、
  整页静默消失；拿不到只是按钮不出现，手打路径照常。只改草稿不发 `settings.mutate`，所以「撤销」照常管用。

**自测**：`dev-run` 384 → **451/451**（其中 19 条电子表格断言，含**只读断言**：全程不得出现对 sheets 的写请求）；
`feishu-checks` 60 → **80 条**（新增「回填退化成只读回执」一条）；`client-smoke` 113 → **175 条**；
`client-check` 通过（面板项目字段 29 项与宿主 descriptor 对得上）。

**仍未验证**（别当成已完成）：`docs/ticket-pipeline/feishu-sheet-source.md` §8.2 的四条**人工前置**一条都没做 ——
①飞书开放平台开 `sheets:spreadsheet` scope（**读写**；只读够扫票、回填会被拒，见 §1.23；与多维表格的
`bitable:app:readonly` 是**两套独立**权限）；
②表格所有者「…」→「添加文档应用」把应用加为**可编辑**协作者（`tenant_access_token` 无法自举，这步只能人做）；
③一张带表头行 + 序号列 + 问题描述列 + 是否处理列的真表；④应用至少有一个云文档 API 权限已开通。
**真表还没读过一张** —— 在这四条做完之前，不要对外说「电子表格已经在真表上跑过」。
（回填那条同理：`values_batch_update` 只在假服务端验过，真表上还没写过一格。）

---

### 1.22 设置页第五个页签「运行」：把队列从对话里搬进面板（2026-11-10，工单 #16）

**要解决什么**：面板以前**只能改配置**。想知道「现在跑到哪了、哪张卡住了、失败的那张怎么重来」，
唯一入口是回对话里敲 `pipeline_status` / `pipeline_scan` / `pipeline_reset` —— 而不知道有这些工具的人
**根本无从查起**。配置页是「一劳永逸」的地方，人打开它时的第一个问题却往往是运营状态。

**做法（顺序即代码顺序）**：
1. **工具侧先把「算结果」抽成模块级函数**，这是整票的地基 —— 不抽就只能复制一份，两种口径迟早不一致。
   `pipeline-status.js` 的 `execute` 主体变成 `export async function collectStatus (options, args)`；
   同款抽出 `collectReset`（`pipeline-reset.js`）、`collectCancel`（`pipeline-cancel.js`）、
   `collectScan`（`pipeline-scan.js`，`preflight()` 同时提到模块级）。工具 `execute` 与 Remote 方法**调同一个函数**。
2. **四个新 Remote 方法**（`descriptors.js` 9 个方法，每参数 `codec` + `strictCodec` 两份）：
   `status()` / `scan()` / `cancel()` / `reset(recordId, projectId?)`。`reset` 是第二个带参方法。
   `method()` 的 result 分派表必须补三行，否则 `status`/`scan`/`cancel` 会全落到 `configSnapshot` 的 typeSymbol 上。
3. **`host.js` 多收四个依赖** `store` / `scheduler` / `gitRunner` / `log`（全可选）；缺了给**人话**
   （`requireStore()` → 「运行页签没接上存储（store 缺席），status 不可用。这通常是宿主装配没把 store 传进来。」），
   不是 `TypeError`。`dev-run` 里有只传 `getConfig` + `doctorOptions` 的老用例，不能崩。
4. **返回体补三个「面板要用、但浏览器里算不出来」的字段**（口径只许在 src 里有一处）：
   每票 `phaseLabel`（浏览器 bundle 里没有 `PHASE_LABEL`）、每票 `canReset`（`RESETTABLE_PHASES`
   已 `export`）、整体 `tiers`（`tierCounts()` 的结果，早退分支也要给）。
   面板**不重算**任何档位或名单，只读这三个字段。
5. **面板**：`TABS` 加 `{key:'run',label:'运行'}` **放最前**，三处 `readTab()` 缺省值全改 `'run'`，
   `panels.run` + 兜底 `|| panels.run`（漏了会静默显示项目页）。`RunCard` 只做「看 + 三个动作」：
   状态行（`已开启` / `关着（enabled=false）` + 圆点）、汇总行、下一个、票列表（`.tp-run-row` 一行一张，
   点开 `.tp-run-detail` 看最近错误/验证/提交/交付缺项/卡在哪站/工作区/会话）、失败票行尾「重跑」。
   轮询是**自递归 `setTimeout` 3 秒 × 最多 200 轮**，不用 `setInterval`（自测沙箱没有它）。

**四个只在这一票里踩到的坑**：
1. **轮询把自测进程吊死**：假 React（`client-smoke.mjs` 的 `makeReact()`）**只执行 effect、从不执行它的
   cleanup 返回值**，于是 `setTimeout` 永远续期、Node 事件循环不空，`client-smoke` 挂 120 秒像卡死。
   修法 `timer.unref?.()`（浏览器里 `setTimeout` 返回数字，没有 `unref`，问号调用安全）。
2. **`useEffect` deps 不能放 `useCallback` 的函数**（`loadRun` 每次渲染都是新引用）⇒ 每渲染一次重读一次队列
   ⇒ 自测渲染循环停不下来。deps 只放 `[isPage, mounted, activeTab]` / `[runPolling]`。
3. **页签文案断言不能用 `textOf(node)`**：角标数字会粘进文字（实测 `运行1|项目|…`），
   要比标签就读 `props.children[0]`；原生标签的 children 也不进 `node.children`（这是
   「`textOf(option)` 读不到 option 文字」的同一个坑，第 3 次踩）。
4. **`ns.reset(recordId)` 只传 1 个实参**：`projectId` 是 `acceptsUndefined`，显式传 `undefined`
   仍会让浏览器侧的「参数个数」校验抛 `expected 2 argument(s), got 1`。

**自测**：`dev-run` 469 → **475**（新增一节 6 条：status 与工具同源、无 store 给人话、
scan 关着时 `disabled` 且 `tickCalls === 0`、cancel 没票在跑说清楚、reset 把失败票放回 pending、
reset 不给非终态票重开）；`client-smoke` 175 → 全绿（新增 9 描述符、四方法形状、五页签、
缺省「运行」、状态行/汇总/票行/角标/展开/三个按钮的点击断言）。`client-check` ✅（9 个方法）。

**没做（票里明确不做）**：监控大盘（图表/趋势）、diff 视图（#05 的文本摘要已够）、实时日志流
（`host.js` 只有 direct，没有 stream）。

---

### 1.23 电子表格也能回填了：只读不是缺功能，是自我放大的 bug（2026-11-10，工单 #22）

**要解决什么**：电子表格分支的 `writeResult` 从 §1.21 起是**挡板**（返回只读回执）。当时的理由是「多写多错、
首版先只读」，但这个口子留错了 —— 电子表格的行身份是**「是否处理=处理中」**，而回填正是把那一格改成「是」。
不写 ⇒ 那一行永远停在「处理中」⇒ **下一轮扫描把同一张票再收一次**，无限重跑。所以「不支持回填」不是少个功能，
是一个会自己长大的 bug。

**为什么不能照抄多维表格那段**：多维表格按 `record_id` PUT 一条记录，`record_id` 是稳定的。电子表格**没有
record_id**，只有「第几行第几列」，而**行号会漂移** —— 人在中间插一行，后面所有票都往下挪一格，
按上次记下的行号写就写到隔壁票上去了。所以回填必须**每次重新读表、按身份列重新定位目标行**。

**做法（顺序即代码顺序）**：
1. **把读表那一段从 `scanSheet` 里抽成 `readSheetValues(table, signal)`**，返回 `{ values, header, rows }`。
   扫描与回填**必须走同一个函数** —— 两处各认一次列，迟早变成「按 A 列认、往 B 列写」。
   它复用 `locateSheetHeader()` + `parseSheetRows()`，于是 `rows[i].rowNumber` 天然就是**人看到的行号**（1-based），
   定位不需要另写一套。
2. **`writeSheetResult(table, recordId, input, signal)`**：`rows.find(r => r.recordId === recordId)` 拿到目标行
   → 按 `header.columns[field]` 反查列字母 → 拼 `valueRanges` → **一次 `values_batch_update` 写三格**
   （逐格 PUT 是三个请求，中间失败会在表里留下「写了一半」，那比全没写更难查）。
3. **四种失败各有专属 `errorKind` + `note`**（不共用一个笼统的「回填失败」）：
   行没了 → `not-found`「找不到那一行（可能被删掉，或序号列被改过）」；
   缺列 → `unsupported` + 列出**表里实际有哪些列名** + 两条改法（`match.sheetColumns` / 关 `writeBack`）；
   只有读权限（403/`auth`）→ `auth` + 点名 `sheets:spreadsheet`（**不是** `:readonly`）+「创建版本并发布」+「可编辑协作者」；
   限流 → 交给 #08 的分档，`retryable` 由 `retryPolicy()` 决定，不在这里自造第二套。
4. **日期写文本不写时间戳**：`normalizeSheetDate(handledAt)` 给 `YYYY-MM-DD`。直接写毫秒数字，文本格式的
   单元格会显示一串 `1762…`，看起来像坏了。
5. **`pipeline_doctor` 加一条「看不见的前置」警告**：读票只要只读权限、写回那三列要读写权限。缺这一档时
   **读得好好的，票跑完了才在回填那一步失败**，而那时票已经是「完成」，人只会看到表格没更新 ——
   体检是唯一能在跑之前提醒的地方。只提醒不写表（写一次就能验权限，但体检的硬约束是不写任何表格）。

**坑**：
1. **假服务端的 `/values/` 路由不分 GET/PUT**（`feishu-checks.mjs`）—— 写请求会被当成读、悄悄返回读的数据，
   于是「回填失败」这个场景永远测不出来。必须单开 `values_batch_update` 分支，并记住 `state.sheetWrites`。
2. **「回填过的那一行下一轮不会被重复收票」是最该断言的一条**（这是本票的真正价值）。测法：把适配器**真发出去**
   的 range 与值回写进假表（列字母转列号、行号减一），再 `scan` 一次，断言 `created.length === 0`
   **且 `updated.length === 0`**。少断言后半个，就等于允许它「再收一次但没改」—— 那还是重跑一遍。
3. **测「行漂移」要在 scan 之后改假表数据**，不能一开始就把目标行放在第 3 行：那样第 2 行和第 3 行都在、
   断言分不清是「定位对了」还是「碰巧」。先 scan（行在第 2 行）→ 再插一行把目标挪到第 3 行 → 回填 → 断言
   `every(r => /[A-Z]3:[A-Z]3$/.test(r.range))` 且**不含 `2:2`**。

**自测**：`dev-run` 475 → **482**（`feishu-checks` 里的 8 条：写对三格、插行后重新定位、行被删不发写请求、
缺列退回只读回执并列实际列名、只有读权限的 note、失败票只写一格、回填后不重复收票、打对 token 与 sheet id）。
`feishu-checks` 86 → **93** 条（+8 新、−1 条老的「回填退化成只读回执」）。

**没做（票里明确不做）**：不新增行（只在既有行上写）、不动三列之外的语义（`status` 仍写 `writeBackStatus`
缺省「是」）、不在读票路径上顺手回填。

---

### 1.24 体检把「自己的 bug」报成「你配置错了」：探针忘了归一 spreadsheetToken（2026-11-10）

**真机症状**：`pipeline_doctor` 报**阻断**——「飞书项目 pms：读不到表元数据（HTTP 404）」，而同一份配置下
适配器扫票是正常的。人看到「读不到表元数据」，第一反应一定是去开放平台查权限、或者怀疑表格没把应用加成协作者，
**而实际上什么都没配错**。

**根因**：`probe.js` 的 `probeOneProject()` 判出表型是电子表格后，直接把 `match.spreadsheetToken` 原值
`encodeURIComponent` 进请求路径：

```js
`/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(base.table)}/sheets/query`
```

而面板推荐的填法是**贴整条工单表链接**，知识库里的表就是一条
`https://<租户>.feishu.cn/wiki/<node_token>?sheet=<sheet_id>`。于是拼出来的是

```
…/spreadsheets/https%3A%2F%2F…%2Fwiki%2F…%2Fsheets%2Fquery
```

⇒ 必然 404。适配器本体从来不这么干：`index.js` 有 `extractSheetToken()`（抠 `/sheets/<token>` 或裸 token），
`resolveSheetTarget()` 会先调它；wiki 形态还会先走 `probeWikiNode()` 用 `get_node` 换出 `obj_token`。
**体检少抄了这两层归一，于是把「探针自己拼错了地址」报成了「你读不到表元数据」** —— 这是最坏的一种误导，
因为修法方向完全相反（它会让人去改一个没问题的配置）。

**修法（`probe.js`）**：
1. 补 `isWikiToken()` / `extractWikiToken()` / `extractSheetToken()` 三个本地函数（**故意不复用 `index.js` 的**：
   探针的硬约束是「绝不 import 适配器内部、绝不抛错」，一旦反过来依赖适配器的闭包，离线自测就跑不起来了；
   代价是这三段小逻辑要跟着适配器保持一致 —— 用例里明写了「两边认同一组输入形态」）。
2. 表型判定后先把 `spreadsheetToken` 归一成裸 token 再放进 `base.table`（报表里给人看的也是裸 token，不是一坨 URL）。
3. `kind === 'sheet'` 且值是 wiki 形态时，先 `GET /open-apis/wiki/v2/spaces/get_node?token=<node_token>`：
   - `obj_type` 是别的类型 ⇒ 明说「wiki 节点不是电子表格（实际类型 X）」，不再发第二个请求；
   - `obj_token` 有值 ⇒ 拿它当 `spreadsheetToken` 继续；
   - `obj_type` 为空（老服务端）⇒ 按电子表格继续（因为这一步是**显式配了 `spreadsheetToken`** 才进来的）。
4. 后面的 `sheets/query` 与 `values/{range}` 都用归一后的 `sheetToken`（不是 `base.table`）。

**自测**：`dev-run` 482 → **483**。新增一条 `体检：电子表格配成整条链接 / 知识库 wiki 链接时，先归一再查
（不能拿 URL 当 token）`，走**真探针 + 假 fetch**，两个子场景：
- wiki 链接 ⇒ 断言**先**打了 `get_node?token=wikcnABCDEFG`、**再**用**换出来的 `obj_token`** 查 `sheets/query`，
  且**全链路没有一处把整条 URL 编进路径**（`!/spreadsheets%2F|spreadsheets\/https/.test(p)`）；
- 普通 `/sheets/shtcnXXX?sheet=…` 链接 ⇒ 断言抠出 `shtcnXXX` 段，且报表里的 `table` 字段是裸 token。

**真机验证**（同一天，用真实 credentials 打真飞书，只读）：修复前 `HTTP 404`；修复后
`kind: sheet` / `metadata.ok: true`（「能读到电子表格元数据（1 个工作表）」）/ `records.ok: true`（「能读到第一页数据（2 行）」），
`table` 是 `get_node` 换出来的裸 token。

**教训**：**一个工具报出的「环境问题」，本身也可能是那个工具的 bug**。体检这类「诊断器」必须与被执行的那条真实
链路口径完全一致 —— 否则它比不体检更糟：它会把一个能跑的配置说成不能跑，让人去改对的东西。凡是「探针/校验器
复制了一份被检对象的解析逻辑」，就要问一句「它抄全了吗？」，并为此写一条**跨两份实现的一致性断言**。

---

### 1.25 总览的每张工单多一行「9 个主站」流程带：把「现在怎样」和「一路怎么走过来的」分开（2026-11-10）

**诉求**：「我想看到由插件执行过的项目的工单执行的**全流程状态**」。

**当时的状态**：上一轮（§11.5）把缺省视图改成按项目聚合的总览之后，每张工单只有一行
`✗/· recordId｜阶段｜模块｜站⑤（已跑 X）｜最近动静｜失败原因`。这一行回答的是「**现在**怎么样」，
而「**整条路**走得顺不顺、哪一站慢/哪一站挂了」仍然只在 `view: 'tickets'` 的九行 `renderTimeline` 里。
于是「看全流程」这件事仍然要求人切视图、翻一段十几行的日志 —— 总览没解决它。

**改法**：总览里**每张工单多渲染一行**流程带（`describeStations()` + `renderFlowLine()`）。
摘要行管「现在」，流程带管「一路」。九个主站来自 `TIMELINE_NODES` 的 `MAIN_STATIONS`：
`discover ① / locate ② / workspace ③ / session ④ / editing ⑤ / testing ⑥ / mr-opening ⑦ /
writeback ⑧ / notify ⑨`（顺序就是人对流程的直觉顺序，不是内部阶段枚举顺序）。

符号表 `STATION_MARK = { ok:'✓', failed:'✗', now:'▶', unreached:'–' }`。**`now` 必须与 `ok` 分开**：
停在⑥时标 `✓` 会让人以为它在等下一站，而实际是这一站还没做完。

三个刻意的取舍，每条都是「看起来更全，实际更误导」的避免：

1. **只给 ≥1 分钟的站标耗时**（`formatShortDuration` 对 < 60 秒返回空串）。①②③④ 常常都在 1 秒内，
   九个都标就成了 `①✓（0 秒） ②✓（0 秒） ③✓（0 秒）…`，反而把真正慢的那一站淹掉。
2. **终态票的最后一站不标耗时**。非终态票当然要用 `now` 兜底补最后一站（「这一站已经跑了多久」正是它要回答的），
   但终态票用 `now` 会得到荒唐数字 —— 一张昨天跑完的票会显示「⑨发送消息（24 时 32 分）」，
   看着像卡在发消息上。所以只有非终态票才用 `now` 补。
3. **老票没有时间线时不画一条全 `–` 的带**。`describeStations` 先判 `timeline.length === 0` 早退，
   返回九个 `unreached` + `noRecord: true`，渲染成「（没有流程记录 —— 这张票的处理早于流程日志功能，
   或刚入队还没开始打点）」。画九个 `–` 等于断言「插件当时一个站都没走到」，而事实是当时还没有打点这个功能。
   **结构上仍给齐九站**（面板不用判空）。

**另一个防分家的决定**：「现在停在哪一站」不自己算，直接取 `describeFlow(row, now).station.no`
（`describeFlow` 是明细视图与时间线渲染共用的那一份）。两处各判一次，迟早出现
「带子上说停在⑥、结论说停在第⑤站」。

**渲染形态**（图例在总览抬头下面只印一次，逐票重复九次解释会把总览撑成第二个明细视图）：

```
━━ 项目总览：6 张票 / 2 个项目 ━━
  （①–⑨ 是 9 个主站：①获取工单 ②查找项目 ③检查工作区 ④创建会话 ⑤处理问题 ⑥跑验证 ⑦提交 ⑧回填表格
   ⑨发送消息；✓ 做成 / ✗ 没做成 / ▶ 正停在这一站 / – 没走过或没有记录；只有超过 1 分钟的站才标耗时）
【sandbox】共 3 张｜待人工验证 2｜已交付 1｜最近动静 3 时 14 分前
    · rec-mock-003｜已完成（已验证）｜模块 表单｜最近动静 3 时 14 分前
        ①– ②✓ ③✓ ④✓ ⑤✓（13 分 42 秒） ⑥✓ ⑦✓ ⑧✓ ⑨✓｜全程 13 分 53 秒
【pms】共 3 张｜需要你处理 1｜已交付 2｜最近动静 95 时 20 分前
    ✗ reczz28VWNWVefNA｜失败｜模块 项目技术支持｜最近动静 123 时 01 分前｜internal: agent 没有产生任何文件改动
        （没有流程记录 —— 这张票的处理早于流程日志功能，或刚入队还没开始打点）
```

注意 `①–`：那三张 sandbox 票是「启动恢复后重新排队」的老票，入队时已经过了打 ① 的时机，
所以 ① 是 `–` 而不是 `✗` —— 没走过 ≠ 没做成，符号必须分开。

**机器可读**：返回体 `tickets[].flow` = `{stations[{no,node,label,state,at,elapsedMs}×9],
reachedCount, total, failedStation, currentStation, totalMs, strip, noRecord}`。
将来面板画进度条直接用这一份，不各自再压一遍。

**自测**：`dev-run` 483 → **486**（新增 3 条）：①完整走完的票九站全 `✓`、只有 ⑤ 标耗时、
`flow.totalMs` 与 `stations[4].elapsedMs` 精确对得上；②跑着的票停在 ⑤ 标 `▶`、没走到的标 `–`、
挂了的那条打点标 `✗` 且 `flow.failedStation === '②'`；③老票说「没有流程记录」而不是画全 `–`。

**教训**：「看到全流程」不是把明细复制一份进总览，而是让总览**每一行都各自回答一个不同的问题**。
摘要行 + 流程带是两种粒度，凑在一起才叫全流程；只加行数不换信息维度，就只是把明细压扁。

---

## 2. 代码清单

`src/` 共 **46 个 .js / 21 378 行**；`scripts/` 共 9 个 .mjs / **14 102 行**（`dev-run.mjs` **5 251 行**）；`lib/client.js` **4 394 行**（浏览器端设置面板）。

| 目录 | 行数 | 文件 |
| --- | --- | --- |
| `src/contracts/` | 1 313 | `errors.js`（错误模型）、`types.js`（阶段机 + 指纹 + **`TIMELINE_NODES` 17 节点表 / `TimelineEntry` / `parseBitableUrl`**）、`ticket-source.js`（`scan` 只读 + `writeResult` 唯一写入口）、`work-executor.js`（`ExecCtx` + **`onFlow` 回调**）、`push-adapter.js`、`repo-locator.js`、`record-filter.js`、`git-status.js`（`-z` 状态/改名解析 + 插件自有目录排除规则） |
| `src/core/` | 4 680 | `scheduler.js`（调度核心 + `writeBackFor` / `renderWriteBackResult` / `pendingEffects` / `replayPendingEffects` + **`markNode` / `markExtra` 全链路打点**）、`store.js`（持久化 + 租约 + **`appendTimeline`** + `sanitizeRow`）、`config.js`（配置校验 + 描述符 + `projects` 子树 + **飞书电子表格 9 键校验/透传**）、`recover.js`（启动恢复）、`workspace.js`（项目工作区）、`worktree-path.js`（`isIsolatedWorktreePath`，清理安全校验）、**`plugin-version.js`（安装副本 vs 源码的文件级比对）**、**`branches.js`（`parseBranchRefs` / `mergeBranchChoices` / `listBranches`，分支候选）**、`prompt.js` / `prompts.js`（任务书与反注入提示）、`domain.js`、`branch-name.js` |
| `src/adapters/` | 8 696（15 个 .js） | 见下表 |
| `src/tools/` | 1 333 | `define.js`（工具范本）、`pipeline-scan.js`、**`pipeline-status.js`（关键节点时间线渲染 + 「现在停在第 N 站」）**、`pipeline-doctor.js`、`pipeline-reset.js`、`pipeline-cancel.js` |
| `src/remote/` | 476 | `descriptors.js`（**9 个 Remote 方法**，含两个带参的 `setProjectTable(index, url)` 与 `reset(recordId, projectId?)`）、`host.js`（宿主 Remote 通道 + **`describeProject` 摊平电子表格字段** + `setProjectTable` 解析落盘 + **`status`/`scan`/`cancel`/`reset` 复用工具的 collect\* 层**） |
| 根 | 1 266 | `src/index.js` —— 组合根（装配全部适配器、注册工具、起轮询；`inspectCheckout` / `describeDirtyCheckout` / `pickAdapterFactory` / `VERIFY_TIMEOUT_MS` 也在这里） |

| 适配器 | 行数 | 状态 | 说明 |
| --- | --- | --- | --- |
| `source-feishu/` | 2 470（`index.js` 1 891 + `sheets.js` 579 + `probe.js` 428） | **真实可用（含电子表格）** | 飞书多维表格 API + **电子表格 API**；`resolveTable` 是表型分派总闸（显式 `tableKind` → `spreadsheetToken` → `appToken` 双试 → `docNamePattern`），`get_node` 不再硬写 `obj_type`；`scan` 拆 `scanBitable`（翻页 + 早停）/ `scanSheet`（读全表 + 逐行指纹、mtime 恒 0、不早停）；水位、状态值可配、recordIds 收窄、截图三形态（电子表格只支持 path/url，内嵌图当没有）、`allowedImageHosts` 白名单；**`appToken` 可写整条表格 URL**（`parseBitableUrl` 啃 `?table=` / `?view=`）；**`writeResult` 回填三列**（多维表格按 `record_id` PUT；**电子表格按序号列重新定位行 + `values_batch_update` 写三格，工单 #22**） |
| `source-wps/` | 1 660 | **experimental（解析可用，取数通道未接）** | `index.js` + `xlsx.js` + `zip.js`；自解 xlsx/OOXML、截图按锚点解包；「待修改项目」列进 `targetProject`；recordIds 收窄；取数走注入的 `fetchSheet`（**主装配不注入 ⇒ 选 wps 的项目一张票都拿不到**，工单 #20）；`recordId` 用行号 ⇒ 插行会让票换身份（已知限制）；**`downloadSheetLimited` 下载通道有超时 / 取消 / 字节上限 / 逐跳重定向校验** |
| ~~`source-webform/`~~ | ~~106~~ | **已移除（工单 #18）** | 演示用内存表单源，水位只在内存里 `memoryWatermark = new Map()`，重启就把同一批工单重收一遍。实现已移到 `plugins/ticket-pipeline/scripts/fixtures/source-webform/index.js` 留档（`scripts/` 不进安装包），`PLATFORMS` 只剩 `feishu / wps / mock`，老配置会拿到「改用 mock 或 feishu」的迁移提示 |
| `source-mock/` | 329 | 测试 | 离线源；也接 recordIds；实现 `writeResult` 供自测断言 |
| `executor-agent/` | 2 496 | **真实实现** | 真 agent 改码、**先拍基线**（`createBaseline`：`git stash create` + 未跟踪文件内容哈希）再 `-z` 口径收集改动、跑验证、在工作区检出里做本地提交（`commitLocally`，点名暂存 `git add -- <文件>`）；`unstageSensitiveFiles` 把 agent 自己暂存进去的敏感文件退回去；**敏感名单 8 大类 41 条正则**、**`.git`/profile 篡改自检**（28 个 hook 名 + 10 个 git 元数据文件 + 4 个 `cordis.*`）；**`reportFlow` 通过 `ctx.onFlow` 上报 ④ 创建会话（分支+模型，含会话 id / provider+model / 工作目录）**；三个出口都带 `sessionId`，`keepSession` 控制会话回收；`repo.gitlab.enabled: true` 时才额外开 draft MR；含 `agent-failure.js` 失败原因识别（限流转可重试） |
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

### 3.4 契约层（8 个文件 / 1 195 行）

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
| `workExecutor` | str | `mock` | enum `agent` / `mock` | **强校验**：写错（含大小写、尾空格）直接抛 `invalid-input` 并列可用值，**不再静默退回 mock**；`undefined` / `null` / 空串才回落 `mock` |
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
| `pushAdapter` | str | `pushplus` | enum `mock` / `pushplus` / `qqmail` | **强校验**：写错抛 `invalid-input` 并列可用值，**不再静默退回 mock** |
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

飞书表定位用到的 9 个键里 **8 个是新增**、1 个（`sheetName`）**复用金山源已有的同名键**（**已实施**，见 `docs/ticket-pipeline/feishu-sheet-source.md` §4.2 设计、§12 实施结果）。它们只对**飞书电子表格**分支有意义；配了但表是多维表格时忽略（不报错）。

指引：字段、默认值与生效条件见 `docs/ticket-pipeline/feishu-sheet-source.md` §4.2；表型分派的决策依据见 `docs/adr/0005-飞书电子表格源按表型分派.md`。

| 字段 | 用途 |
| --- | --- |
| `name` | 项目名（= 工单 projectId，定位仓库用） |
| `match.platform` | `feishu` / `wps` / `mock` / `webform`；飞书项目支持 `feishu`（**多维表格 + 电子表格**两种表型，插件自动判断，表型不写进配置） |
| `match.appToken` / `tableId` / `viewId` / `docNamePattern` | 飞书表定位 |
| `match.spreadsheetToken` | 飞书**电子表格** token（`shtcn…`）；与 `appToken` 二选一，配了插件就按电子表格处理（整条表格链接贴进来也行） |
| `match.sheetId` | 电子表格里的**工作表** id（与 `spreadsheetToken` 配套，与 `sheetName` 二选一） |
| `match.sheetName` | 电子表格里的**工作表名**（与 `spreadsheetToken` 配套，与 `sheetId` 二选一）。**与下方金山表定位共用同一个键**（语义一致：这张文档里用哪个页签），不新增第二份定义 |
| `match.sheetHeaderRow` | 表头在第几行（默认 `1`）；行号身份下表头行一变身份就变，所以不自动往下扫 |
| `match.sheetIdentity` | 行身份来源：`seq`（默认，序号列值）/ `row`（物理行号）。电子表格没有 `record_id`，身份只能自造 |
| `match.sheetIdColumn` | 身份取自哪一列（默认「序号」），仅 `sheetIdentity: 'seq'` 时生效 |
| `match.sheetColumns` / `match.columns` | 列名覆盖 `{语义: 实际表头文字}`，如 `{"description":"缺陷描述"}`。前者管电子表格，后者管多维表格（工单 #21），形状与校验完全一致 |
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
| 验证命令超时 30 分钟、超时退出码 124 | `src/index.js` `VERIFY_TIMEOUT_MS` / `VERIFY_TIMEOUT_EXIT_CODE`；宿主 `dsh-bash-local` 的 `maxTimeoutMs` 缺省 10 分钟会夹下去 |
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
                      │                      │     ├─ agent：拍基线(createBaseline) + 受保护路径快照(snapshotProtectedPaths) → 改码
                      │                      │     │        → collectChanges(对基线) → verify（30 分钟超时 / 可取消，超时退出码 124）
                      │                      │     │        → 篡改自检(compareProtectedSnapshots，动过 .git/profile 就 failed)
                      │                      │     │        → commitLocally（点名暂存的本地提交）→ 返回 commit + sessionId
                      │                      │     │        → keepSession 决定要不要回收会话
                      │                      │     └─ mock：只演（返回假 commit）
                      │                      ├─ setPhase(done/skipped/failed/gone) —— 同一次落库写 pendingEffects
                      │                      ├─ writeBackFor（仅 done/skipped 且 writeBack 没关）
                      │                      │     └─ source.writeResult → 回执落到票据 writeBack
                      │                      ├─ releaseLease
                      │                      └─ push.send（按 notifyOn 过滤；回填失败会多一行）
                      │
                      │   启动时：replayPendingEffects() 把残留终态票没做完的回填/通知补上
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
| 敏感文件 | `executor-agent` 有 `SENSITIVE_FILE_PATTERNS` 白名单过滤（**8 大类 41 条正则**，见 §1.14）：**点名暂存** `git add -- <非敏感文件>`，再 `git commit -m <说明> -- <非敏感文件列表>`，被拦文件**连 index 都进不去、留在工作区**，文件名写进提交说明的「未提交」一行。**不用 `git add -A`**：全量暂存会让 `A application.yml` 露在 index 里，手一抖就提交走了；git 白名单也只放行 `add -- <文件>`，`add -A` / `add .` 一律拒绝 |
| `.git` / profile 篡改自检 | 每票开始与提交前各拍一次 sha256 快照（28 个官方 hook 名 + 10 个 git 元数据文件 + 4 个 `cordis.*`），动过就 `git restore --staged --` 撤回、判 `failed` + `invalid-input`（不可重试）并点名文件。**这是「被发现」不是「被阻止」**：拿不到 `readFile` 服务时自检跳过、票照常交付 |
| 验证命令 | 有超时与取消：`VERIFY_TIMEOUT_MS` 缺省 30 分钟、宿主 `dsh-bash-local` 的 `maxTimeoutMs` 缺省 10 分钟会夹下去（真实上限取小者）、超时退出码 **124**、取消会真 kill 子进程 |
| approval / policy | 仍是 `never`（`executor-agent/index.js:1149` 注释）：宿主只提供 `ask` / `never`，没有「只读自动批、写入弹卡」这一档；`ask` 在无头场景 fail-closed 会让每步工具调用失败。兜底只有 git 白名单 + 篡改自检，**不是硬隔离** |
| 合并动作 | 插件**只在工作区检出里做一次本地提交，从不 push、从不合并**；远程 draft MR 是 `repo.gitlab.enabled: true` 才走的可选出口，合并同样由人手动做 |
---

## 8. 自测与验证

### 8.1 离线自测（可复跑，不联网）

| 命令 | 断言数 | 结果 |
| --- | --- | --- |
| `node scripts/dev-run.mjs` | **486** | 通过 486，失败 0（2026-11-10 实跑；262 → 274 → 285 → 288 → 293 → 294 → 319 → 325 → 363 → 376 → 378 → 382 → 383 → 384 → **451**（2026-11-09）→ **482**（2026-11-10）。451 之前那批：319 是「回填工单表 / 保留会话 / 基线收集 / 配置面板」四项改造，再往后 6 条是「选择分支」，再往后 38 条是「上线加固」的 5 条阻断项 + 4 条重要项（见 §1.14），再往后 13 条是「关键节点流程日志（时间线）」（见 §1.16），再往后 2 条是「appToken 贴整条链接」的配置校验，再往后 4 条是「从 0 到 1」审计（见 §1.19），再往后 1 条是「工作区就绪 / 检查工作区两站不许说同一句话」，再往后 1 条是「票据行里的数字键脏字段会被剔掉」（见 §1.20），再往后 20 条是「飞书电子表格支持」（见 §1.21）。**2026-11-10 = 22 张产品工单的落地批次**：451 之后依次涨到 462（doctor 三档 + GitLab/WPS 降级）、463、469（多维表格列名别名）、475（运行页签）、482（电子表格回填）、483（探针归一 spreadsheetToken），**486**（总览流程带 3 条，见 §1.25）。这 486 条**也包括** `runFeishuChecks` 从 `dev-run` 里驱动的那 93 条（见 §1.23 注） |
| `node scripts/chain-smoke.mjs` | **11** | 通过 11，失败 0 |

`dev-run.mjs` 分 31 个小节：

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
| 11.5 | `pipeline_doctor` | 环境体检；**插件版本自检**：落后时给出同步命令与两个指纹，一致/链接安装/比不出来三态各有断言，既有 7 个用例注入 `NO_VERSION_CHECK` 桩避免读真实磁盘；**三档结论 `blockers/problems/warnings`**、「通知通道完整性」、「飞书连通性」（真探针 + 假 fetch，码表命中 / 未知码 / 网络错 / 超时四种归一）、「接下来四步」清单、`GITLAB_TOKEN` 只在真开了远程 MR 时才查（见 #10、#19） |
| 12 | 组合根接线 | 工具真注册进 ctx、真拿到 store |
| 12b | 注册表真的接上了适配器 | qqmail 推送、agent 执行器 |
| 12c | 走宿主 shell 必须显式带 sandboxPolicy | 写授权 |
| 12d | 工具输出必须是 lossless JSON | `undefined` 会让宿主判整次调用失败 |
| 12e | 平台可插拔 | 状态值可配 + 金山文档接进组合根；`PLATFORMS` 只剩 `feishu/wps/mock`，`webform` 拿到迁移提示（见 #18） |
| 13 | 新适配器 | gitlab 客户端 **86 项**（新增 7 条本地提交断言 + 10 条 `-z` 收集/暂存断言 + 10 条基线/keepSession 断言 + **8 条敏感名单与篡改自检断言**，原 51）/ qqmail 推送 18 项 / wps 工单源 **34 项** |
| 14 | 项目工作区 | **19 项**：目录不存在给可照做的报错、无 `repo.path`、未登记则登记、已登记则复用、create 幂等、无 registry 降级、create 抛错降级、无 fs 服务、fs 说是文件、同项目多票复用、attachSession 归属；**验证命令的 signal 语义与超时 124**、**适配器名写错要抛并列出可选值** |
| 15 | 改代码落点 | `inspectCheckout` 干净/脏/拿不到状态三种情况（`-z -uall` + 排除插件自有目录）；`describeDirtyCheckout` 脏工作区只提醒不拒跑、文案能照着理解；`isIsolatedWorktreePath` 只认 `.agents/worktrees/<name>`；真实 `apply()` 缺省不建隔离 worktree、票据落在工作区根上（`branch` = 检出当前分支、`baseCommit` = 检出 HEAD） |
| 16 | 处理完回填工单表 + 保留工作区会话 | done → 三列都写；`writeBackStatus` 可配、空白回落「是」；`writeBack=false` 完全不写（退化成只读）；failed 不回填；回填失败只记票据、票态不回退、不影响通知；老适配器没有 `writeResult` 时静默跳过；执行器返回 `sessionId` 落到票据、状态里能看到去哪找会话；`pipeline_status` 成功/失败都能一眼看到；skipped 的回填首句要说「待人工验证」 |
| 16a | 改动摘要 | `pipeline_status` 每票多渲「改动摘要：N 个文件，+X / −Y」；`commitSummary` 无提交时是 `null` 不是 `undefined`；一次 `git show --raw --numstat -z` 拿全（两种 `-z` 互斥） |
| 16b | 事后动作补偿（`pendingEffects`）与租约诚实化 | **14 项**：回填失败要在通知里说、回填成功时不写回填行、一场跑完 `pendingEffects` 必须清干净、`clearPendingEffect` 只清报上来的那一项（两项清完就把字段整个删掉）、启动补偿：残留终态票把回填和通知补做完并清标记、`enqueue` / `resetByHuman` / `revise` 都不继承上一轮 `pendingEffects`、租约：别的 owner 连试两次都拿不到且续租按 token 判定、就地重跑起点与票面记录不一致时日志要说明「被判没有改动是预期」、`failed` 也是终态（通知发完同样清 `pendingEffects`）、启动补偿只捞终态票、`pipeline_status` 待补动作要能看见 |
| 16c | 交付维度 | done ≠ 东西交到手上：`delivery` 三项（commit / writeBack / notify）各自记账；回填失败/不可重试分别落 `giveUp`；票标题加「（表格未回写）」「（交付未完成：…）」；全库分布多一行「交付未完成：N 张」；返回体带 `delivery` / `deliveryIssues`（见 #08） |
| 16c-2 | 失败票回填 | `writeBackOnFailure` 缺省关；打开后只写「处理结果」一列、绝不碰「是否处理」/「处理日期」；**超时也写、人工取消不写**；失败票被重跑后再失败是覆盖同一格不追加（见 #14） |
| 16c | 关键节点流程日志（时间线） | **13 项**：主站顺序（①–⑨ + 补充站）、每条 `at` 是时间 / `ok` 是布尔 / `label` 非空、相邻 `at` 单调不减、执行器 `onFlow` 报的 ④ 会话进时间线、失败票 `failed` 站记 ✗、连续同节点同成败合并、90 条触发 80 条封顶、重新入队继承时间线、人工重置不清空只补「排队中」分隔、`pipeline_status` 渲染「现在停在第 ⑤ 站…已 1 分 35 秒没动」、终态写「已经收尾」/ needs-info 写「不是插件卡死」、返回体带 `timeline`/`station`/`stalledForMs`、老票无时间线不引入 `undefined` |
| 16d | 长站点心跳 | `planning` / `editing` / `testing` 每分钟追加一条 `heartbeat` 时间线条目（同类才合并，别吃掉进站那条）；只渲「最近一次心跳 HH:MM:SS」，不单独占行；`testing` 额外给「通常 3–15 分钟」的区间（见 #07） |
| 17 | 选择分支 | `parseBranchRefs` 解析 `for-each-ref`（`refs/remotes/` 后只切第一个 `/`、丢掉 `origin/HEAD` 这类符号引用）；`mergeBranchChoices` 排序（当前分支 → 远端默认 → 本地 → 其余远端）；`listBranches` 真跑通；四种拿不到分支的情况（无 `repo.path` / 无 git 执行链路 / 不是 git 检出 / git 抛错）**只返回 `ok:false` + 原因、绝不抛**；游离 HEAD 不算分支名；宿主 remote 暴露 `branches()` 且某个项目配错不影响别的项目 |
| 18 | 运行页签的四个 Remote 方法 | `status` 与工具同源（`collectStatus`）、无 store 给人话、`scan` 关着时 `disabled` 且不起后台、`cancel` 没票在跑说清楚、`reset` 把失败票放回 pending、不给非终态票重开（见 #16） |

### 8.2 真实链路验证记录

| 验证项 | 结果 |
| --- | --- |
| 本地提交（本阶段交付形态） | ✅ `git add -- <非敏感文件>`（点名暂存）→ `git commit -m <说明> -- <非敏感文件>` → `rev-parse HEAD` 全链路实跑，提交说明含工单溯源、验证结论与「未提交」文件清单 |
| 脏工作区只提交 agent 改的 | ✅ 真 git 端到端验过：有基线时人的改动一个都不出现；用户 `git add` 进索引的改动同样被排除 |
| 回填工单表（新） | ⚠️ 代码与自测全绿（`dev-run.mjs` 第 16 节 10 条断言）；真实表待应用拿到**编辑**权限后端到端复跑 |
| 保留会话（新） | ✅ `pipeline_status` 与回填进表格「处理结果」列的正文都能看到 `处理会话：<sessionId>`（**通知正文里没有这一行**）；agent 实例在 `finally` 里无条件释放 |
| 设置面板（新） | ✅ `client-check.mjs`：descriptor 25 叶子 / 4 组、schema 信封 72 节点 25 叶子、**Remote 9 个方法**（含带参 `setProjectTable` 与 `reset`）、`projects` 可写 34 字段；`client-smoke.mjs` 全过（页签式布局见 §1.17，「添加项目」见 §1.18，运行页签见 §1.22） |
| 上线加固（新，2026-11-06） | ✅ 代码与自测全绿：`dev-run` 累计 **376/376**（该轮 363/363，第 16b 节 14 条；补 appToken 链接解析 2 条后现为 482/482）、`gitlab-checks` 86、`wps-checks` 34、`workspace-checks` 19；敏感名单 41 条实测 BLOCK/PASS 清单符合预期（`src/env.js` / `docs/credentials.md` / `.environment.md` 不误伤） |
| 关键节点流程日志（新，2026-11-06） | ✅ 票据 `timeline` 逐站打点（17 节点表 / 9 主站 ①–⑨）、`pipeline_status` 排成时间线并写「现在停在第 N 站，已 X 分 Y 秒没动」、`dev-run` 第 **16c** 节 13 条断言全绿、返回体带 `timeline`/`station`/`stalledForMs`/`lastNodeOk` |
| appToken 贴整条表格链接（新，2026-11-09） | ✅ `parseBitableUrl`（`src/contracts/types.js`）被配置校验与飞书适配器共用：`?table=` → `table_id`、`?view=` → `view_id`，显式 `tableId` 仍优先；`feishu-checks` 58 → **60** 条、`dev-run` 加 2 条配置校验断言（那是当轮的值；现为 **482/482** 与 **93** 条） |
| 面板「添加项目」修好（新，2026-11-09） | ✅ 加项目改成「垫空卡片 + 一次保存提交」：不再拿空 `repo.path` 撞宿主整份校验（见 §1.18）；顺手修「出错吃掉整个清单」与「有未保存改动就锁死加项目」；`repo.remote` 面板标签改「GitLab 仓库地址」；`client-smoke` 113 → **123** 条断言全过 |
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

下面每一条都定位到了具体文件位置。**「已修（`<commit>` 前）」= 代码已提交（这一列在 2026-11-06 复核时补）；「已缓解」= 症状减轻但仍非根治；「待修」= 还没人动手。** 所有结论均对照 2026-11-06 工作区源码（HEAD `dbfa21f`）核实。

> 本轮（2026-11-06「本地提交」改造）当场关掉一条契约耦合：**~~「GitLab Commits API 是改动唯一出口」~~**。原来 `makeExecResult` 在 `phase=done/skipped` 时必须给 `mr`，等于把「有远端的 GitLab」写进了内核契约；现在 `commit` 或 `mr` 给一个即可，默认交付形态改成工作区检出里的本地提交（`commitLocally`），远程 Commits API 降级为 `repo.gitlab.enabled: true` 才走的可选出口。证据：`src/contracts/work-executor.js`（校验分支）、`src/adapters/executor-agent/index.js`（`commitLocally` / `openDraftMr` 的 `optional` 出口）、`scripts/gitlab-checks.mjs` 新增 7 条断言。

### 9.1 P0 —— 挡住真实工单端到端

| # | 缺陷 | 位置 | 影响 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | **模型默认留空 → 宿主 persona 模板崩**：`agentOptionsFromConfig` 在 `model` 为空串时不带 model，宿主给 agent 会话装 personaPrefix 时含 `{{model}}` 变量 → 装配阶段直接报 `prompt variable "{{model}}" has no value for this assembly` | `src/adapters/executor-agent/index.js`（新增 `resolveAgentOptions`） | 沙盒 002/003 两张票就是这么挂的（attempt=2） | **已修（`5b94a17`）**：新增 `resolveAgentOptions`，配置优先、缺的读宿主 `agentDefaultModel.currentSelection()` 补齐，两项必须成对下发；宿主也给不出就报 `internal` 并说清该配什么。（早期那条「空串不下传即跟随会话默认」的判断是错的 —— 空串就是真的不下发，才会在模板上崩） |
| 2 | **找不到 agentPresets 服务只记日志继续跑**：agent 起来了但是零工具，改不出任何文件，最后报「没有产生任何文件改动」，真因被埋 | `src/adapters/executor-agent/index.js`（`setupAgent`） | headless profile 必现；桌面 profile 也可能缺 | **已修（`5b94a17`）**：改为抛 `invalid-input` 硬失败并列出该配什么（重试没用，是环境问题） |
| 3 | **金山文档无开放平台取数通道**：`wpsOptionsFromMatch` 只支持 `sheetUrl` 全局 fetch 下载，缺登录态大概率失败；无开放平台网关接入 | `src/adapters/source-wps/index.js:371-399` | 需求①的「金山」只有解析能力，没有取数能力 | **已降级为 experimental（工单 #20，2026-11-10）**：不再声称「已支持」——面板下拉标「实验性，需自行注入取数通道」，选中时卡片亮橙框，`pipeline_doctor` 对 wps 项目报**阻断**，`MISSING_FETCH_SHEET` 改成「用户层先说拿不到票 + 改用飞书，开发者层再给 `fetchSheet()`」。真接通道仍需金山账号 + 管理员审批 |
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
| 14 | **死配置**：`logLevel` 与 `concurrency` 只出现在配置定义里，代码无任何消费点 | `src/core/config.js:126`（`concurrency` 定义）/`:317`（`logLevel` 定义）/`:342`、`:407`（分组标签） | 改它们不生效 | 待修 |
| 15 | **`PipelineError.retryAfterMs` 有写入但无读取方**（退避从未按上游建议时间算） | `src/contracts/errors.js:43-47` | 上游说「17:09 重置」，实际只按 30 秒基数退避 | **已修（`dbfa21f` 前）**：`src/core/scheduler.js:53` `backoffDelayMs(attempt, retryAfterMs, random)` 收了服务端建议值（`:54` `const serverHint = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : undefined`），`:571-573` 传 `normalized.retryAfterMs` 进退避并仍受封顶夹住 |
| 16 | **飞书工单源只支持多维表格，电子表格进不来** —— ① `normalizeAppToken` 的 wiki 节点查询把 `obj_type: 'bitable'` 硬写进 query（`src/adapters/source-feishu/index.js:763-766`），`:770-775` 把 `sheet` 判成「不是多维表格」并抛错，错误文案里还写着「sheet=电子表格」不支持；② `searchBitableDocs` 只认 `type === 'bitable'`（`:713`）；③ 配置校验只认「`appToken`+`tableId`」或「`docNamePattern`」二选一（`src/core/config.js:494-501`），只给 `spreadsheetToken` 的配置在启动时就被拒 | `src/adapters/source-feishu/index.js`（`normalizeAppToken` / `searchBitableDocs` / `resolveTable`）、`src/core/config.js`（`validateProject`） | 用户的飞书工单表如果是电子表格，插件**完全扫不出票**，且报错文案指向错误方向（像权限问题，实际是代码路径问题） | **已修（2026-11-09）**：新增 `src/adapters/source-feishu/sheets.js`（579 行），`get_node` 不再带 `obj_type`、改读 `node.obj_type` 分派；`searchBitableDocs` → `searchCloudDocs` 认 `type ∈ {bitable, sheet}`；`resolveTable` 成为表型分派总闸（显式 `tableKind` → `spreadsheetToken` → `appToken` 双试 → `docNamePattern`）；`scan` 拆 `scanBitable` / `scanSheet`；`validateProject` 改成四选一放行。自测 `dev-run` 384 → **451**、`feishu-checks` 60 → **80**（19 条电子表格断言）。**回填也已补上（2026-11-10，工单 #22，见 §1.23）**：`values_batch_update` 写三格、按序号列重新定位行、四类失败各有 `errorKind`+`note`；`dev-run` 475 → **482**、`feishu-checks` 86 → **93**（86 是 #21 列名别名之后的值）。**仍待**：真表验证（要开 `sheets:spreadsheet` **读写** scope + 文档级「添加文档应用」加成可编辑） |

### 9.3 P2 —— 健壮性与体验

> 这张表原来没有「状态」列，读的人无从判断哪些已经修掉了。下面按 2026-11-06（`dbfa21f`）的工作树逐条核过：
> **17–23 已修**、**21/22 各有半条仍成立**、24–26 仍然成立，详见每行状态。
> 复核方式：每条都去 `src/` 里找消费点/守卫，找不到才算「仍成立」；已修条目的证据行号逐条列在状态列里。

| # | 缺陷 | 位置 | 状态 |
| --- | --- | --- | --- |
| 17 | 飞书 token 无 single-flight；401/403 不清缓存 → 密钥轮换后最长 2 小时全失败 | `src/adapters/source-feishu/index.js` | **已修（`dbfa21f` 前）**：`:396-403` `let tokenInflight = null`（注释「single-flight，B4」）复用同一个在途 Promise，`:462` `finally(() => { tokenInflight = null })`，`:473-476` `invalidateToken(deadToken)` 按失效 token 精确清 cache 与 inflight；`:512` / `:560` / `:626` 是 401/403 分支 |
| 18 | 飞书四处请求未传 `signal`；fetch 无请求级超时；URL 截图裸 fetch 有 SSRF 面 | `src/adapters/source-feishu/index.js` | **已修（`dbfa21f` 前）**：全仓 `fetch(` 只有 `:547` / `:614` / `:1226` 三个调用点，全部带 signal；`:552` `signal: withTimeout(init.signal, requestTimeoutMs)`、`:617` 同、`:1230` `withTimeout(signal, remaining)`（`fetchImageUrl` 手动跟跳），`:620-621` 超时抛 `PipelineError('network', …超时（${requestTimeoutMs}ms）')` |
| 19 | 附件无字节上限 | `src/adapters/source-feishu/index.js` | **已修（`dbfa21f` 前）**：`:335` `const maxBytes = Math.max(1024, Number(options.maxBytes ?? 10 * 1024 * 1024) \|\| 10 * 1024 * 1024)`，`:644` 传入，`:1257-1258` `readBodyWithLimit` 边读边累加上限 |
| 20 | `pickNext` 不排除中间相位（planning / testing 等） | `src/core/store.js:441` | **已修（`dbfa21f` 前）**：`if (row.phase !== 'pending') return false`（注释「只跑排队中的票；中间态留给启动恢复」） |
| 21 | 飞书早停时把「未访问」当「不存在」计退役；指纹先更新后判定 → 改内容再改回旧内容永不触发 updated | `src/adapters/source-feishu/index.js` | **前半已修、后半已修**：`:1076-1099` 的退役判定整体包在 `if (!stopped)` 里（注释写明「早停时未访问 ≠ 不存在」，代价是停点之后的真删除会一直挂在水位里）；指纹只在收进 `updated` 时才更新（`:1033-1035` 注释 + `:1059-1062`）。**残留**：早停导致停点后的行整轮不访问，真删除永不消失 —— 已知代价，不改 |
| 22 | `notifyFor` 用不会 abort 的 signal；`locator.locate` 不传 signal | `core/scheduler.js`、`src/adapters/locator-table/index.js` | **已修（`dbfa21f` 前）**：`scheduler.js:351` 已是 `await locator.locate(ticket, handle.signal)`；`notifyFor`（`:790-802`）自带 `linkSignal(signal)` + `notifyTimeoutMs` 超时，catch 只 `logInfo('通知失败（不影响票据状态）')` |
| 23 | `tools/define.js` 的 integer 校验不查 min/max（`pipeline_status` 声明了 min1/max100，0/1000 照样放行） | `src/tools/define.js:151-163` | **已修（`dbfa21f` 前）**：`case 'integer'` 已查 `spec.min` / `spec.max`，`:152-155` 注释就在讲这个 bug 已补 |
| 24 | `ownerToken` 含 pid + 时间戳 → 重启后旧租约最多阻塞 10 分钟 | `src/core/store.js:78-81` | **仍成立** |
| 25 | 无定时器卸载钩子；agent 泄漏（`agents.create` 返回的 `dispose` 已在 `1f788cb` 改为 `await created.dispose?.()`，老宿主退回 `agent.release?.()`） | `src/index.js`、`src/adapters/executor-agent/index.js` | **部分成立**：agent 释放已修；定时器只有 `scheduler.js:604` 一处 `clearInterval(heartbeatId)`，轮询走宿主 `ctx.interval`（`src/index.js:1026`），生命周期由宿主管 —— 无自己的卸载钩子 |
| 26 | **限流只能靠抛异常绕开**：executor-agent 把「上游 429 / 配额」转成 `PipelineError('rate-limit')` 抛出后才会进退避队列；若哪天有人改回「返回 failed 结果」，重试又会失效（根因是 9.2 第 7 条） | `src/adapters/executor-agent/agent-failure.js`、`src/core/scheduler.js` | **仍成立**（根因 9.2 第 7 条未修） |

---

## 10. 要不要重构

**结论：不要推倒重来，做定点修复 + 补两个适配器。**

### 10.1 支持「不重构」的依据

| 依据 | 说明 |
| --- | --- |
| 内核零平台知识 | `core/` 与 `contracts/` 里 grep 不到任何飞书 / 金山专有字段；平台差异全在 `SOURCES` 表与适配器目录里 |
| 契约自洽 | 8 个契约文件、11 个 phase、7 类错误都有单测覆盖（`dev-run.mjs` 第 1 节） |
| 回归网够密 | **486** 项离线断言全绿，改一处坏一处会立刻被看见 |
| 装配层已是表驱动 | 加平台 = 加目录 + `SOURCES` 一行（ADR-0001） |
| 坏隔离已做 | 一个项目配错不拖垮其它项目；能力名拼错只记日志 |

### 10.2 真要重构的话，只有这两处值得动

| 建议 | 理由 | 代价 |
| --- | --- | --- |
| 把 `scheduler` 里「执行器返回结果」与「执行器抛异常」两条失败通路合并成一条 | 现在可重试性判断被分裂在两处，行为不一致（9.2 第 7 条） | 中，要动调度器核心 + 补测试 |
| 把 `src/index.js`（1 248 行）按「装配 / 工具注册 / 轮询」拆三块 | 文件偏大，但拆了也不改变行为 | 低，收益也一般，**不建议本轮做** |

### 10.3 建议的推进顺序

第二步与第二步半互不阻塞，第二步半可与第二步并行。

| 阶段 | 内容 | 判据 |
| --- | --- | --- |
| 第一步（`5b94a17` + `26f0391`，**已完成**） | 9.1 的 P0 里除金山取数通道外全部关掉；9.2 的 5 条关掉；收窄开关推广到四个源 | ✅ 自测 242/242；沙盒 001 已真跑出 MR !1 |
| 第一步补（**已完成**） | 项目工作区：票 → 项目 → 宿主 Workspace 登记（`core/workspace.js`），会话 cwd = 工作区根 + `workingDirectory` 钉隔离目录（仅 `isolateWorktree: true` 时）+ `attachSession` 归属 | ✅ 自测 262/262（新增 11 项工作区断言 + 7 项执行器会话断言） |
| 「本地提交」改造（**已完成**，2026-11-06） | 交付形态从远程 draft MR 换成本地提交：`commitLocally`、`ExecResult.commit`、`repo.gitlab.enabled` 总开关、通知/状态/体检三处文案 | ✅ 自测 269/269（新增 7 条）；`gitlab-checks` 51 → 58 |
| 「改代码落点」改造（**已完成**，2026-11-06 晚） | 缺省直接在项目工作区的检出里改代码、就地提交（当轮要求检出干净，后由 §1.10 的基线机制取代成「脏也能跑」），新增 `isolateWorktree`（默认 `false`）把隔离 worktree 降级成可选项；`isIsolatedWorktreePath` 堵住清理误删主检出 | ✅ 自测 274/274（新增 5 条，`dev-run.mjs` 第 15 节）；见 §1.3 |
| 「改动收集改 `git -z`」缺陷修复（**已完成**，2026-11-06 深夜） | 未跟踪新文件漏提交、路径被引号/八进制转义、未跟踪目录折叠导致敏感文件绕过、`.agents/worktrees` 污染检出 —— 四个坑一并修；新增契约 `src/contracts/git-status.js`、新增 `unstageSensitiveFiles`、删除三个非 `-z` 解析导出 | ✅ 自测 285/285（新增 11 条）；`gitlab-checks` 58 → 68；真实 git 端到端探针通过；见 §1.4 |
| 「陈旧工作区坐标不得复用」缺陷修复（**已完成**，2026-11-06） | 守卫只看字段有没有值 → 目录已删/换了仓库仍复用死路径，`workingDirectory.set` 对着空气报错；`resetByHuman` 不清坐标、`recoverPending` 不管 failed，两处放大器让票重置后必然复现 | ✅ 自测 288/288（新增 3 条）；见 §1.5 |
| 「插件版本自检」（**已完成**，2026-11-06） | 宿主加载的是 profile 下的目录副本（跨盘 `file:` 落成复制），HMR `root: []` 不监听源码 ⇒ 改完不同步就静默跑旧代码；新增 `src/core/plugin-version.js`，`pipeline_doctor` 比对安装副本与源码的**文件内容**，落后时给出同步命令，只进「提醒」 | ✅ 自测 288 → 293（新增 5 组断言）；见 §1.6 与 `architecture.md` §12.11 |
| 「`setPhase` 清不掉字段」缺陷修复（**已完成**，2026-11-06） | `setPhase` 把补丁里所有 `undefined` 一概过滤，于是调用方写的每一种「清掉」都静默失效：成功票上挂着上一轮 `lastError`（真实事故：`pms\|reczz28VWNWVbpgL` 跑成 done 却显示 `provider "workbuddy" has no configured model`），启动恢复以为清了死坐标其实没清。改为「键不存在 = 不动 / 键在值为 undefined = 删掉」 | ✅ 自测 293 → 294（新增 1 条走真实重试路径 —— 旧的那条是 `resetByHuman` 兜的假绿）；见 §1.7 |
| 「回填 / 保留会话 / 基线 / 面板」四项改造（**已完成**，2026-11-06） | ①处理完回填工单表（`TicketSource.writeResult` 唯一写入口 + `writeBack`/`writeBackStatus`，见 §1.8）②处理完保留会话（`ExecResult.sessionId` + `keepSession`，见 §1.9）③脏工作区只提交 agent 改过的文件（`createBaseline` + `describeDirtyCheckout`，`assertCleanCheckout` 删除，见 §1.10）④设置面板补齐（`projects` 子树可编辑 + 第 3 个 Remote 方法，配置 33 键 / 7 组，现为 24 键 / 4 组，见 §1.11） | ✅ 自测 319/319（新增 25 条，`dev-run.mjs` 第 16 节 + 第 15 节改写）；`feishu-checks` 52 → 58、`gitlab-checks` 68 → 78；`client-check` / `client-smoke` 全绿 |
| 「选择分支」改造（**已完成**，2026-11-06） | `repo.baseBranch` / `repo.targetBranch` 带候选下拉：`src/core/branches.js`（`parseBranchRefs` / `mergeBranchChoices` / `listBranches` 绝不抛）+ 第 4 个 Remote 方法 `ticketPipeline.branches()`（一次返回全部项目）+ 面板字段 `kind` 从 `text` 改 `branch`（`<input list>` + `<datalist>`，不做纯 `<select>`），见 §1.12 | ✅ 自测 319 → **325/325**（新增 6 条，`dev-run.mjs` 第 17 节；上线加固 + 时间线后现为 482/482）；`client-check` 的 `kind` 白名单加 `branch`，Remote 描述符 4 个方法一致 |
| **上线加固**（**已完成**，2026-11-06） | 5 条阻断项 + 4 条重要项：适配器名强校验（`workExecutor` / `pushAdapter` 的 `enum`，写错抛 `invalid-input` 不静默退 mock）、验证命令超时与取消（30 分钟缺省、退出码 124、取消真 kill）、敏感名单 9 → **8 大类 41 条正则**、`.git`/profile 篡改自检（28 + 10 + 4）、终态与事后动作同一次落库（`pendingEffects` + `replayPendingEffects`）、回填失败进通知、就地重跑起点、租约诚实化（best-effort，不是原子 CAS），见 §1.14 | ✅ 自测 325 → **363/363**（当轮；新增 38 条，`dev-run.mjs` 第 16b 节 14 条 + 各 checks）；`gitlab-checks` 78 → 86、`wps-checks` 25 → 34、`workspace-checks` 11 → 19 |
| **关键节点流程日志（时间线）**（**已完成**，2026-11-06） | 票据 `timeline` 17 节点表（9 主站 ①–⑨ + 8 补充站）、`markNode` / `markExtra` / `onFlow` 全链路打点、`pipeline_status` 排成时间线并写「现在停在第 N 站，已 X 分 Y 秒没动」、历史不清空 + 80 条封顶，见 §1.16 | ✅ 自测 363 → **376/376**（新增 13 条，`dev-run.mjs` 第 16c 节）；26 小节；真实链路探针 11 条时间线、渲染探针给出 `station`/`stalledForMs` |
| **飞书电子表格支持**（**已完成**，2026-11-09） | 新增 `src/adapters/source-feishu/sheets.js`（579 行纯函数：列名别名、工作表定位、range、读值、行身份、日期/优先级）；`get_node` 不再硬写 `obj_type`；`resolveTable` 成表型分派总闸（显式 `tableKind` → `spreadsheetToken` → `appToken` 双试 → `docNamePattern`）；`scan` 拆 `scanBitable` / `scanSheet`；`validateProject` 四选一；9 个配置键透传；面板加「飞书电子表格」一组（含 `kind:'columns'` 一行写法）。见 §1.21 | ✅ 自测 384 → **451/451**；`feishu-checks` 60 → **80**（19 条电子表格断言）；`client-smoke` **175** 条；`client-check` 面板字段 29 项与 descriptor 对得上 |
| **22 张产品工单落地批次**（**已完成**，2026-11-10） | 产品评审出的 22 张票全部实施完（见 `.scratch/ticket-pipeline-product/spec.md` 索引）：配置 33 → **25 键 4 组**、`skipped` 终态文案四档、面板加「运行」第五页签、`delivery` 交付维度、`appToken` 面板贴链接、多维表格列名别名、电子表格回填、WPS 与 GitLab 降级为 experimental、doctor 三档体检、校验带修复建议与拼错键检测 | ✅ `dev-run` 451 → **483/483**；`feishu-checks` **93** 条；`client-check` **9 个 Remote 方法** / 25 叶子 / 72 节点 / `projects` 可写 34 字段；`client-smoke`、`chain-smoke`（11）、`wps-checks` 全绿 |
| **总览的流程带**（**已完成**，2026-11-10 晚） | 总览每张工单多一行 9 主站流程带（`describeStations` / `renderFlowLine`）：`①✓ ②✓ …⑨✓｜全程 X`，符号 `✓/✗/▶/–` + 图例只印一次；只给 ≥1 分钟的站标耗时、终态票最后一站不标、老票说「没有流程记录」而不是画全 `–`；返回体 `tickets[].flow` 给机器可读九站结构。见 §1.25 / `architecture.md` §11.5 | ✅ 自测 483 → **486/486**（新增 3 条） |
| 第二步（当前） | 真实飞书票 `pms\|reczz28VWNWVefNA` 复跑一次全链路 | 收到真 QQ 邮件、邮件里有本地提交 sha 且能 `git show` 到、`verify.test` 真跑过 |
| 第二步半（**代码已完成**，2026-11-09） | **飞书电子表格支持**（设计见 `docs/ticket-pipeline/feishu-sheet-source.md`，决策见 `docs/adr/0005-飞书电子表格源按表型分派.md`；回填见 §1.23） | ✅ `dev-run` 384 → **451** → **482**（#22 回填）；真表读数据与回填待 §8.2 人工前置（开 `sheets:spreadsheet` **读写** + 「添加文档应用」加成可编辑） |
| 第三步 | 补金山开放平台取数通道 | 给一张真实金山表链接 + 凭据，能扫出票 |
| 第四步 | 9.2 / 9.3 剩余项按需修 | —— |