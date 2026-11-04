<!-- DSH-STATUS: closed -->
## 维护者原话

出处：本会话（2026-11-03 21:36）
> 不需要操作mgiot-pms项目，只实现插件，该插件不能只对mgiot-pms项目生效呀，需要针对工单对应的项目执行

<!-- DSH-FORMAT: md-v1 -->
<!-- DSH-TITLE: 工单流水线插件：从飞书工单表到 GitLab MR 与微信通知 -->
<!-- DSH-STATUS: ready-for-agent -->
<!-- DSH-LABELS: wayfinder:map -->
<!-- DSH-IDEMPOTENCY-KEY: deck-plan-ticket-pipeline-v1-map -->
<!-- DSH-CREATED: 2026-11-03T11:02:08.987Z -->

出处：本会话（2026-11-03 21:43）
> 做成通用的，在插件中维护 工单中维护的话所有项目都在一起太乱了

出处：本会话（2026-11-03 21:48）
> 工单的文件名模糊匹配 或者 配置该项目的工单是那个具体的平台文件路径

出处：本会话（2026-11-03 21:51）
> 例如飞书平台 通过文件名称

## Destination

一份可落地的架构设计文档 ＋ 一个能端到端跑通的 **通用** DSH Host 插件骨架：任意多个项目，每个项目在飞书知识树里有自己的工单表 → 插件按 `projects[]` 配置为每个项目实例化一个工单源 → 检测到新工单/变更 → 执行 agent 在该项目仓库里现场定位代码并修改 → 按项目自己的验证命令验证 → 自动开 draft GitLab MR（开到该项目配置的远端/目标分支）→ 推一条微信消息通知人（PushPlus `channel=clawbot`，见 Decisions）。设计文档把四层（工单源 / 仓库定位 / 执行 / 通知）的接口契约与替换点写死，骨架用 mock 适配器把同一条链路跑通一遍。

## Notes

域：DSH Host 插件（Cordis）、飞书多维表格 OpenAPI、GitLab REST、`mgiot-pms`（Spring Boot 3.5.16 / Java 17 + Vue 3.5 / Vite 8）。开会话先读 `docs/agents/issue-tracker.md` 与 `docs/agents/domain.md`；写插件前读 `cordis-plugin-development` 技能。

标准偏好：

- 运行形态 = **DSH Host 插件常驻**（`timer` + `agents` + `worktrees` + `subagents` + `credentials` + `storage` 这些现成 service），不另写守护进程。
- **项目清单维护在插件配置里**（用户 2026-11-03 拍板）：`projects[]` 每条含 `name` + `match`（工单表绑定）+ `repo` + `verify`。新项目接入 = 配置里加一条，插件代码零改动。**工单属于哪个项目在「表」这一级就定了**（每个项目在飞书知识树里有自己的工单表），不在行级判断。
- `mgiot-pms`（`D:\WorkSpace\mgiot-pms`，远端 `http://gitlab.example.com/mk/end/mgiot-pms.git`）是 `projects[]` 的第一条示例配置，不再是唯一硬编码目标。
- **工单表只读**（用户 2026-11-03 决定）：插件绝不回写「是否处理 / 处理人 / 处理结果 / 处理日期」，所有流水线状态只存在插件自己的存储里。表格是触发器，不是状态机。
- 收票规则：**`是否处理 = 处理中`** 的行自动进入流水线。该列是下拉三值（**是 / 否 / 处理中**），`是` 与 `否` 都不进入。
- 轮询 3~5 分钟；串行，并发 1；单票超时 30~45 分钟。
- 只开 **draft MR**，绝不自动合并；人看完本地验完自己合。
- 功能测试 = 按项目配置的 `verify` 命令（构建 + 测试）；环境起不来记 `skipped`，仍开 draft MR。**验证命令放每个项目配置里，不放插件内核**（用户 2026-11-03 拍板；不配 `verify` 的项目跳过验证直接开 draft MR）。
- 通知做成可替换适配器 `PushAdapter`。**默认实现 = PushPlus `channel=clawbot`**（07 号票结论：WorkBuddy 没有任何受支持的对外发送接口，详见下）。
- 每个会话最多解一张票（research 票除外）。
- **语言**：所有产物（设计文档、票、代码注释、提交信息、通知文案）**一律用中文编写**（用户 2026-11-03 明确要求）。代码标识符保持英文。
- **本 effort 偏离 wayfinder 的 "plan, don't do" 默认：执行也进地图**——终点本身包含跑通的骨架。

**已知沙箱约束（2026-11-03 实测）**：当前会话的 file policy 是 `workspace-write`，作用域仅 `D:\WorkSpace\dsh-ticket-pipeline`。在 `mgiot-pms` 里任何写入都会被拒（实测 `echo probe > .dsh-sandbox-probe.txt` → `Permission denied`）。⇒ 流水线要真跑起来，插件所在的会话必须满足其一：① 会话 cwd/workspace 就是 `mgiot-pms`；② 该会话的 file policy 为 `danger-full-access`。这一条直接影响 `ctx.worktrees.create()`（worktree 落在 `<repo>/.agents/worktrees/`，即 workspace 之外），落地时必须验证，写进 #09 的前置条件与 #11 的运行说明。

工单表结构（`PMS系统问题Bug记录表` / 工作表「问题Bug记录」，第 1-2 行为示例行）：

`序号 | 发现部门 | 问题描述 | 发现日期 | 模块 | 操作流程 | 截图 | 优先级 | 是否处理 | 处理人 | 处理结果 | 处理日期`

- `发现部门`：下拉（客服部/前台部/工程部/销售部/财务部/管理层/其他）
- `模块`：下拉，也可自行输入
- `是否处理`：下拉 **是 / 否 / 处理中**
- `处理人` / `处理结果` / `处理日期`：由处理人跟进后填写
- `截图`：问题截图粘贴在单元格里，或填写共享路径/链接
- 另有「统计汇总」表，自动统计，无需维护

## Decisions so far

- **2026-11-03 目的地**：设计文档 + 可跑通骨架（不是纯文档，也不是直接上真实平台的第一版）。
- **2026-11-03 平台**：第一个真实适配器做**飞书多维表格**；WPS/金山文档作为第二个适配器，接口按可替换设计。选飞书的理由：附件是一等字段（`record_id` 直接取图，不用像素几何），有变更事件可加，写回 API 也完整；WPS 那边单元格图片拿不到字节、只有轮询、还要企业账号。
- **2026-11-03 仓库**：~~只做 `D:\WorkSpace\mgiot-pms`~~（已被通用化取代，见下条）。
- **2026-11-03 项目清单与工单表绑定（用户 2026-11-03 方向修正，取代上一条）**：插件**通用化**，不硬编码任何项目。**每个项目在飞书知识树里有自己的工单表**（如「[问题统计]PMS任务工单」挂「[运维]能耗SaaS标准版」节点下），所以「工单属于哪个项目」在**表这一级**就定了，不在行级判断。**项目清单 = 插件 `projects[]` 配置**（用户拍板：工单表里不加「项目」列，因为「所有项目都在一起太乱了」）。每个条目 = `name`（项目名）+ `match`（工单表绑定：显式 `platform+appToken+tableId` 优先，或 `docNamePattern` 文件名模糊匹配，两者都实现、二选一或并存）+ `repo`（`path`/`remote`/`baseBranch`/`targetBranch`）+ `verify`（该项目的构建/测试命令）。**代码定位交给执行 agent 现场读仓库定位**（用户拍板，真通用），废除 mgiot-pms 静态模块别名表（原 #06 结论退场）。`RepoLocator` 退化成查表返回 `projects[ticket.projectId].repo`。**未匹配到任何项目条目的工单表忽略不处理**（用户拍板——树里还有大量非工单文档）。运行链路：启动遍历 `projects[]` 每条目实例化一个 `TicketSource`；`Ticket` 带 `projectId`；worktree 建该项目 repo 下、分支含项目名、MR 开该项目远端/目标分支、验证跑该项目 `verify`、通知带项目名。新项目接入 = 配置加一条，插件代码零改动。
- **2026-11-03 通知通路**：用户原本想走 WorkBuddy 的微信助理，但 07 号票实测证明**WorkBuddy 没有任何受支持的、供外部进程调用的发送接口** —— 它的微信通道是**被动回复语义**（`WeixinClawBotClient.sendTextReply({userId,contextToken}, text)` 的 `context_token` 只能从入站消息里取），而本机日志 `getUpdates … "msgs":0` 连续 4611–4644 轮、全 logs 目录 `Received polled messages`/`Sending text reply`/`hasContextToken` 全部 0 命中 —— 这条通道上线至今从未收到过任何消息。`botToken` 是 AES-256-GCM envelope，密钥根 `protectorKey` 在 asar 里找不到，且即使解开也不够（缺 `context_token`、会抢游标）。⇒ **改用 PushPlus `channel=clawbot`**（扫码绑定后可主动推送；限制是每 10 条 / 每 24h 需要有人主动发一次对话）。备选：企微群机器人 webhook（WorkBuddy 自己的「自动化推送」UI 也认这个 URL，可共用 key）、Server酱 Turbo。
- **2026-11-03 截图通路**：`saveImage({data, mediaType, name})` → `ImageBlock{type:'image', attachment: ref}` → 塞进 `UserMessage.content` → `agent.followup()`。**没有「给本地路径就上图」的 API**；`read_image` 工具在 base composition 里已默认开启，插件不用自己写读图 tool。无 vision 模型时用严格判定（`inputModalities?.includes('image')`，`undefined` 即拒），因为 `deepseek-v4-pro` 根本没声明该字段。
- **2026-11-03 表格只读**：不做状态回写。流水线状态全部落在插件自己的存储里，表格只用来发现工单。
- **2026-11-03 GitLab 通路**：纯 REST API 可开 draft MR（实例 `http://gitlab.example.com` 16.9.6 CE，只能 HTTP）。**draft 只能用 `title: "Draft: …"` 前缀**（`draft=true` 参数被静默忽略、`wip_event=draft` 直接 400）。**本机沙箱物理封死 `git push`**（`cannot create standard input pipe for git-receive-pack: Permission denied`、`fatal: unable to fork`，连本地裸仓库都失败），只能用 **Commits API + `start_branch`** 物化改动。默认分支 `main`，唯一受保护的也是 `main`；CI 只在 `v2.x` 触发，MR 不会有 pipeline。目标分支已定：`ref=v2.x` + `target=v2.x`（见下条）。
- **2026-11-03 模块映射**：工单「模块」用的是**旧称**，必须过一张别名表 —— `问题管理` → `task` 模块（现 UI 叫日常工作）、`项目技术支持` → `/project-group` 分组壳（挂 6 个模块，单出现时有歧义，需回问或全量搜）、`客户投诉管理` → `/complaint`、`上门服务` → `/service`、`工作台` → `/dashboard`、`登录` → `/login`。**没有 `sys_menu` 表**：菜单是 3 份前端硬编码（`router/index.ts`、`Sidebar.vue`、`menuConfig.ts`）+ 1 份后端权限树（`SysPermissionController.PAGE_TREE`）互相镜像。改一个页面最少动 4 处（路由 `meta.permission` + 侧边栏/菜单配置 + `v-permission` + 后端 `@PreAuthorize`），再补 SQL 权限种子。
- **2026-11-03 MR 目标分支（用户拍板）**：`ref = v2.x`、`target_branch = v2.x`。理由：diff 只含 agent 自己的改动，且不与挂着的 MR !1 重复。已知代价 = 合并进 `v2.x` 会触发生产部署；但 draft MR 不自动合，合并由人在验收后自己做，与「绝不自动合并」的前提一致。
- **2026-11-03 收票**：`是否处理 = 处理中` 的行自动进入。用户贴出的表格使用说明原文确认了该列是下拉三值 `是 / 否 / 处理中`，因此不存在「另一列状态」的疑问。
- **2026-11-03 变更检测与去重（01 收口）**：身份用 **`record_id`**（不用「序号」列，人手填且会因插删行重排）。扫描 = `records/search` 按「最后更新时间」降序翻页 + `automatic_fields:true`，**客户端逐条比 `seen[recordId].mtime` + 内容指纹**；停止条件是**连续 20 条已知未变**（`safePageRun`），不是「见到第一条 ≤ 水位就停」—— `last_modified_time` 会因批量操作/导入乱序，单点水位会漏票。**`ExactDate` 过滤不能用**（截断到天）。删除行连续 3 轮没出现才标 `gone`。**收票只认 `是否处理 = 处理中`，不叠加任何条件**（用户拍板：叠「处理人为空」会把别人认领后放弃的票永远卡死）。三值语义：`否`=待认领不进、`处理中`=开工信号进、`是`=已闭环退役且**以表格为准**（哪怕插件自己判 failed）。**跑到一半被改 = 同一条修订**，`revisionCount++` 排到队尾，**不打断正在跑的那一版**（用户拍板）。幂等键 = `recordId + fingerprint`，指纹只含工单内容（问题描述/模块/操作流程/截图 ref 列表/优先级/发现部门），不含管理字段。并发用**存储层租约 + 回写校验**（`ownerToken` + `leaseExpiresAt`，10 min TTL、60 s 续租、回读发现被覆盖就退让），不用文件锁。`Config` 新增：`pollIntervalMinutes`(3) / `safePageRun`(20) / `leaseTtlMinutes`(10) / `maxAttempts`(2) / `goneAfterScans`(3)。
- **2026-11-03 截图两形态（01 收口）**：`ScreenshotRef` 联合类型 `attachment{fileToken}` / `path{path}` / `url{url}` / `unknown{raw}`；**取字节留在适配器**（`TicketSource.loadScreenshot(ref, signal)`），内核统一 `saveImage` → `ImageBlock` → `followup`。取不到字节 → 标 `needs-info` 通知人补图，**票继续排队不 fail**。
- **2026-11-03 四层接口契约（03 收口）**：`TicketSource` / `RepoLocator` / `WorkExecutor` / `PushAdapter` 四个接口（变化原因彼此独立，这是拆分的唯一理由）。`scan(signal) → {created, updated, disappeared}` **分开返回三类**（用户拍板）—— 内核动作不同（入队 / 修订排队尾 / 退役），适配器本来就在比 `seen` 表，顺手分类零成本。`onExternalChange?()` **可选**（用户拍板纯轮询为主，飞书将来能订阅事件再接）。适配器**静态 import 表**注册（用户拍板，不用目录自动发现：打包 `files` 会漏动态 import、构建期看不到依赖、报错只剩 `MODULE_NOT_FOUND`）。共用 `ErrorKind` 七分类（`auth`/`network`/`rate-limit`/`not-found`/`invalid-input`/`aborted`/`internal`），适配器抛错必须带 kind。**四个接口里没有任何 `writeBack`**（表格只读）。可替换边界 = `src/adapters/<name>/` 一个目录 + `src/index.js` 一行注册；判定标准 = 删掉 `src/adapters/source-feishu/` 整个目录和那一行，插件仍能构建、仍能用 mock 跑通。`LocateResult.ambiguous=true` 不是失败：照常排队，但 prompt 里显式列候选并要求定不了就问人。
- **2026-11-03 工作区与调度（08 收口）**：每票一个 **`ctx.worktrees.create(agent, {name, from})`**（用户拍板）。实测契约：默认目录 `<repo>/.agents/worktrees/<name>`（服务自己写 `*` 的 `.gitignore`，不污染 `git status`）、**`from` 只认本地提交且不 fetch**、**已存在的分支/目录直接报错**、**创建成功后会把调用方 agent 的 cwd 切到新检出** ⇒ **必须用每票自己新建的 agent 去调，绝不能用主会话 agent**（否则人的界面 cwd 被拽走）。切前先 `git -C <repo> fetch origin v2.x`（用户拍板；只动 `.git` 不影响脏改动），失败按 `network` 处理、下轮重试、超 `maxAttempts` 标 failed。**不搬脏改动**（用户拍板）：`application.yml` 库名改动与 `version.ts` 换行差异都不带进 worktree；需要连库时用 `Config.dbOverrideUrl` 显式覆盖，不继承脏文件。**每次修订一个新分支**（用户拍板，因为 `create` 拒绝重名）：`ticket-<recordId>-r<N>`（不带斜杠 —— `name` 同时决定分支名和目录名，带斜杠会让目录变嵌套）。调度 = `timer.interval` + 内存单飞布尔（防同进程重入）+ 存储层租约（防多窗口抢票），**一轮最多跑一票**，队列按优先级降序→发现日期升序但并发恒为 1。**超时只报给人不自动重试**（用户拍板）：`timer.timeout` → `agent.cancel()` → 标 `failed` → 通知（带超时分钟数与 worktree 路径）→ 保留 worktree；同一 recordId 下轮扫描见 `failed` 直接跳过，除非人把「是否处理」拨走再拨回 `处理中`（视为手动重置，重置 `attempt`）。人工取消标 `failed` 但**不发通知**。worktree 保留 `worktreeRetentionHours`(24) 后由每轮最多清 1 个的清理步骤删除并 `git worktree prune`；**`failed` 的永不自动删**；分支不自动删（MR 还指着）。清理只碰 `<repo>/.agents/worktrees/` 白名单前缀，**绝不碰 WorkBuddy 的 `C:/Users/Administrator/WorkBuddy/Worktrees/mgiot-pms/`**。
- **2026-11-04 飞书适配器落地（12 收口）**：`source-feishu` 从占位改成真实实现（790 行）。四件事：①认证 `POST /open-apis/auth/v3/tenant_access_token/internal`，token 缓存、过期前 60s 刷新；②扫描 `records/search`（`page_size:500` + `automatic_fields:true` + 按「最后更新时间」降序），**停止条件是连续 `safePageRun`(20) 条已知未变**，**变更判定用内容指纹不用 mtime**（批量/导入会让 mtime 乱序，单点水位会漏票），`ExactDate` 不用（截断到天）；③收票只认 `是否处理 = 处理中`，**下拉字段形状不固定必须先归一再判等**，状态改走立刻退役、拨回「处理中」重新收票，行被删连续 `goneAfterScans`(3) 轮才退役；④截图三形态取字节（附件走 `drive/v1/medias/:file_token/download`、路径走 `ctx.fs.readBytes`、链接裸 `fetch` 不能带凭据）。**绑表三条路**，命中 0 张或 >1 张一律当**配置错误**（不瞎猜）：`appToken+tableId` 直接用 / 有 `appToken` 按 `docNamePattern` 匹配表 / 只有 `docNamePattern` 先在云文档找唯一 bitable 再取其唯一表。**绝不写回表格**（自测里有一条断言专门盯着：扫描全程只允许 `GET` / `POST /auth` / `POST /records/search`）。**凭据走 `ctx.credentials` 的普通字符串 ref**（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`），不用 branded `credentialRef`（那个包只在 asar 内，插件目录 import 不到）；空串不算已配置。**文档级授权是人工前置**：`POST /drive/v1/permissions/:token/members` 只对 `user_access_token` 有效，插件用的 `tenant_access_token` 没法自举，必须表格所有者手动把应用加为协作者。**踩过的坑**：飞书认证接口的响应体**没有 `data` 包装**（`tenant_access_token` 在顶层），`apiCall()` 必须返回整个响应体，业务接口自己取 `payload.data` —— 写成 `return payload.data` 会让认证永远拿不到 token。
- [mgiot-pms 模块与操作流程到代码路径的映射](issues/06-mgiot-pms-模块与操作流程到代码路径的映射.md): research 收口：映射表已写入 `.scratch/ticket-pipeline/research/repo-map.md`。关键发现是工单「模块」用旧称、`项目技术支持` 是分组壳、改页面最少动 4 处。未开 PR（researc…
- [接到 WorkBuddy 里那个微信助理的推送通路](issues/07-接到-workbuddy-里那个微信助理的推送通路.md): research 收口：WorkBuddy 无对外推送接口（被动回复语义 + context_token 从未产生 + botToken 密钥根缺失）。推荐改走 PushPlus channel=clawbot，接口形状已在 `.scrat…
- [截图像素到模型上下文的通路](issues/02-截图像素到模型上下文的通路.md): research 收口：唯一合法通路是 saveImage → ImageBlock → UserMessage.content → followup。报告在 `.scratch/ticket-pipeline/research/image…
- [GitLab 上开 draft MR 的可行路径](issues/04-gitlab-上开-draft-mr-的可行路径.md): **能，纯 REST API 就能开 draft MR。** 完整证据链见 `.scratch/ticket-pipeline/research/gitlab-mr.md`（558 行，每条结论标注【实测】/【源码】/【不可知】）。
- [插件骨架的模块划分与运行边界](issues/05-插件骨架的模块划分与运行边界.md): grilling 收口（用户确认「都按推荐」）：四层适配器 + 内核；agent 走进程内 agents.create；重启靠 storageDomain 的 phase 状态机恢复；timer.interval 为默认驱动 + 手动触发兜…
- [飞书多维表格的变更水位与去重（只读，不回写）](issues/01-飞书多维表格的变更水位与去重.md): 只看最后更新时间做客户端水位 + record_id 做身份 + 内容指纹去重；收票只认「处理中」不叠加条件；跑到一半被改算同一条修订，不打断当前运行；截图两形态在适配器内统一取字节，都走 saveImage。
- [工单源适配层的接口契约与替换点](issues/03-工单源适配层的接口契约与替换点.md): 四层接口签名定稿：TicketSource.scan 返回 created/updated/disappeared 三类、纯轮询 + 可选事件回调；适配器静态 import 表注册；取字节留在适配器、内核统一 saveImage；不设写回；…
- [每票的隔离工作区、串行调度与超时](issues/08-每票的隔离工作区-串行调度与超时.md): 隔离 = 每票一个 ctx.worktrees.create（每票自带 agent，避免动主会话 cwd）；切前 git fetch origin v2.x，从 origin/v2.x 干净切、不搬脏改动；分支 ticket/&lt;rec…
- [写架构设计文档（四层接口契约与替换点）](issues/10-10-写架构设计文档-四层接口契约与替换点.md): 架构设计文档已落 docs/ticket-pipeline/architecture.md（879 行）：13 节，含四层接口完整 TS 签名、依赖方向图、文件级可替换点与判定标准、phase 状态机转移表（含非法转移）、五个数据契约、错误…
- [搭骨架并用 mock 适配器跑通全链路](issues/11-11-搭骨架并用-mock-适配器跑通全链路.md): 交付物 6 条全部核对通过，离线自测 31/31 绿；组合根、工具、包壳、README 均落盘并验证。
- [项目清单与工单表绑定（projects 配置、两种绑定方式、多项目参数化）](issues/09-mgiot-pms-本地跑起来的真实前置条件与耗时.md): 交付物 6 条全部完成并验证：①projects[] 配置结构（config.js 的 validateProject 校验 name/match{platform,appToken,tableId,viewId,docNamePatter…
- [飞书多维表格 TicketSource 真实实现](issues/12-12-飞书多维表格-ticketsource-真实实现.md): 七项交付全部落地并验证：

## Not yet specified

- Web UI 要不要给一个流水线面板（当前跑到哪一票、队列、历史）
- 多张工单指向同一模块时的改动冲突与排队策略
- 表格「处理人」字段与实际执行者的绑定规则（哪些行该认领）
- 人在微信里回一句「这个不对」之后，流水线怎么接住并继续（双向通道）
- 优先级 = 高 的票是否走不同策略（动手前先问人）
- 每票的 token / 时间预算与超支处理

## Out of scope

- 个人微信 bot 框架（wechaty / itchat / wcferry 之类）：违反微信 ToS，有封号风险
- 自动合并 MR：用户要本地验收后自己合
- `pms-miniapp` 小程序的自动化测试
- 工单表状态回写（用户明确只要只读）

## 进度

- 2026-11-03：chart 完成（12 张子票）。已关 02/04/05/06/07（四份调研 + 骨架决策）+ 01（变更水位与去重）+ 03（四层接口契约）+ 08（工作区与调度）。
- 决策票已全部收口（01/03/05/08 四张 grilling + 02/04/06/07 四张 research）。**剩下的全是执行票**：09（通用化：项目清单与工单表绑定）、10（写设计文档）、11（骨架 + mock 跑通）、12（飞书真实实现）。
- 下一步顺序：10（设计文档，把已定契约写死）→ 11（骨架 + mock 跑通）→ 09（实测起后端的前置与耗时，为 12 的测试阶段校准）→ 12（飞书真实实现）。
- 四份调研报告在 `.scratch/ticket-pipeline/research/`：`gitlab-mr.md` / `image-path.md` / `repo-map.md` / `wechat-push.md`。
- 2026-11-03：**#10 已关**（架构设计文档 `docs/ticket-pipeline/architecture.md` 879 行落地）。**#11 已关**（`plugins/ticket-pipeline/` 全落盘，31 项离线自测全绿，组合根 + 两个工具 + 包壳 + README 齐）。
- 2026-11-03 **方向修正（用户拍板）**：插件**通用化**，不硬编码 mgiot-pms。#09 已从「mgiot-pms 实测耗时」重定位为「项目清单与工单表绑定（projects 配置 + 两种绑定方式 + 多项目参数化）」；#12 增加 `docNamePattern` 模糊匹配与多实例化前置。原「只做 mgiot-pms」的硬编码假设需在 #10 架构文档与 #11 骨架里同步修正。
- 剩 2 张执行票：**#09**（通用化：项目清单与工单表绑定）、**#12**（飞书多维表格 TicketSource 真实实现 + 多实例）。另有 `executor-agent` 真实现需**单独开一张地图票**（要真连 GitLab + 起 JVM）。
- 2026-11-04：**#09 已关**（通用化返工：删 `src/adapters/locator-pms/`、新建 `locator-table/`、config 换 `projects[]`、store 换复合主键 `ticketKey(projectId,recordId)`、架构文档 22 处硬编码改写；grep `mgiot-pms|locator-pms|v2\.x` 在 plugins/ 与 architecture.md 里 **0 命中**；离线自测 32/32 绿）。
- 2026-11-04：**#12 已关**（`source-feishu` 真实实现 790 行 + 组合根注入 `getSecret`/`getWatermark`/`saveWatermark`/`readLocalFile`；离线自测加第 9 节「飞书适配器（离线打桩）」，**54/54 全绿**；架构文档加 §12.7 落地细节 + §12.8 凭据与授权前置；README 更新）。
- **wayfinder 地图到此收口**：12 张子票全关，Destination（架构设计文档 + 能端到端跑通的骨架）已达成。剩下的两件**不是规划问题、是新 effort 的活**：①`executor-agent` 真实现（要真连 GitLab + 起 JVM）；②真实飞书凭据 + 文档级授权的端到端验证。
