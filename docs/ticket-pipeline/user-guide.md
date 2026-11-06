# 工单流水线插件 · 使用手册（v0.1.0-test.1）

> 本手册面向**使用者**：从零开始把插件跑起来，直到收到第一封带**本地提交**的通知邮件。
> 架构原理见 [architecture.md](./architecture.md)，实现进度见 [feature-checklist.md](./feature-checklist.md)。

---

## 0. 这个插件是干什么的

你在共享工单表（飞书多维表格 / 金山文档 Excel）里描述问题，插件自动完成：

```
监控工单表 → 发现「处理中」的行 → 解析问题描述/操作流程/截图
    → 确定这张工单属于哪个项目 → 确保该项目的工作区已登记在 DSH 里
    → 直接在项目工作区的检出里改代码（缺省；开跑前要求检出干净）
      └─ 打开 isolateWorktree 时才额外切一个隔离 worktree 子目录
    → AI 规划并改代码 → 跑构建/测试
    → 在工作区检出里做一次本地提交 → 通知你（QQ 邮箱直发 SMTP / PushPlus 中继微信）
    → 你在检出里 review 这个提交，拨回工单状态
```

**人只做三件事**：填工单、收通知、review 那个本地提交。

---

## 1. 准备工作

### 1.1 准备工单表（以飞书为例）

多维表格的数据表必须**按以下 13 个列名命名**（顺序无所谓，列名必须一致）：

| 列名 | 说明 |
|---|---|
| 序号 | 人手填的编号（仅展示用，插件不拿它当身份） |
| 发现部门 | 提工单的部门 |
| 问题描述 | ⭐ 核心：改什么、为什么改 |
| 发现日期 | — |
| 模块 | 出问题的功能模块（给 AI 的定位提示） |
| 操作流程 | 复现步骤 |
| 截图 | 附件或 URL 均可 |
| 优先级 | 高/中/低（或 p0-p3、urgent 等） |
| 是否处理 | ⭐ 流水线开关：只有填 **`处理中`** 的行会被收票 |
| 处理人 | — |
| 处理结果 | — |
| 处理日期 | — |
| 最后更新时间 | 修订检测用 |

> 关键规则：**「是否处理」拨到 `处理中` = 收票**；拨走（改成别的值）= 停止处理；
> 拨回 `处理中` = 重新收票（包括重跑失败的票）。插件**只读**这张表，不回写任何列。

### 1.2 准备凭据

在 DSH 的凭据存储（credentials）里配置以下键名（**一字不差**）：

| 凭据键名 | 用途 | 必填场景 |
|---|---|---|
| `FEISHU_APP_ID` | 飞书应用 id | 用飞书工单源时 |
| `FEISHU_APP_SECRET` | 飞书应用密钥 | 用飞书工单源时 |
| `GITLAB_TOKEN` | 开远程 draft MR 的 GitLab 私人令牌（需 api 权限） | **仅**项目显式打开 `repo.gitlab.enabled: true` 时；本阶段用不到 |
| `QQMAIL_AUTH_CODE` | QQ 邮箱**授权码**（不是登录密码） | pushAdapter=qqmail 时 |
| `PUSHPLUS_TOKEN` | PushPlus 推送 token | pushAdapter=pushplus 时 |

> ⚠️ 飞书应用需要被授权访问目标多维表格：在表格右上角「…→更多→添加文档应用」，
> 把你的应用加为协作者（可读）。**必须人工做**，应用自己加不了自己。
> QQ 邮箱授权码获取：QQ 邮箱网页版 → 设置 → 账户 → 开启 SMTP → 生成授权码。

### 1.2.1 飞书应用开通权限并发布

在 [飞书开放平台](https://open.feishu.cn) 进入你的应用：

1. 左侧 **权限管理** → 搜索 `bitable`，开通其中一个（推荐第一个，最小权限，插件只读表）：
   - ✅ `bitable:app:readonly` —— 查看、评论、编辑多维表格（只读够用）
   - 或 `bitable:app`（读写）
2. 顺手把这两个也检查一下（后面步骤要用，一次配完省得再发版）：
   - ✅ `wiki:wiki:readonly` —— 查看知识库（wiki 换算用，可能已配好）
   - ✅ `drive:drive:readonly` —— 搜索云文档（`docNamePattern` 匹配用）
   - 📎 `drive:file:readonly` 或附件相关 —— 读截图附件用（不需要 `docx:document:readonly`，主要是媒体下载，一般跟随 drive 权限）
3. **关键一步：发布** —— 左侧 **版本管理与发布** → 创建版本 → 填个版本号和更新说明 → 提交发布。
   **权限不开版本不生效**（企业自建应用一般秒过或管理员自动审批）。

> **用电子表格当工单表时，还要额外开一组权限**：`sheets:spreadsheet:readonly`（或 `drive:drive:readonly`）。
> 这跟多维表格的 `bitable:app:readonly` **是两套互不相通的 scope，必须单独申请**。
> 另外电子表格的所有者要在表格页面「…」→「…更多」→「**添加文档应用**」把应用加为协作者 ——
> 插件用的是应用身份（`tenant_access_token`），没法自己给自己授权，这一步必须人工做一次。
> （电子表格支持**设计待实施**，这一步是等它落地后才需要的。）

### 1.3 确认本地仓库

每个项目需要一个**本地 git 检出**（`repo.path`），并确认：

- 工作区干净。**缺省模式（`isolateWorktree: false`）就在这份检出里改代码、就地提交**，脏起点会把别人的改动混进这次提交；检出脏时插件会直接拒跑并点名是哪些文件，让你先提交或 `git stash`。
  插件判脏的口径是 `git status --porcelain -z -uall -- . ':(exclude).agents/worktrees' ':(exclude).agents/worktrees/**'`：`-uall` 会把未跟踪目录展开到文件级（否则目录里混的 `application.yml` 会被折叠成一个目录名、躲过敏感文件拦截），末尾两条排除规则跳过插件自己开的隔离 worktree —— 所以你手工跑 `git status --porcelain` 看到 `?? .agents/` 不算脏
- 远端 GitLab **只在**你打开了 `repo.gitlab.enabled: true`、要额外开远程 draft MR 时才需要。默认交付形态是工作区检出里的一次本地提交，不需要远端，也不需要 `GITLAB_TOKEN`

---

## 2. 安装插件

### 方式 A：从发布包安装（推荐）

```bash
dsh.cmd plugin --profile desktop add "file:D:/WorkSpace/dsh-ticket-pipeline/plugins/ticket-pipeline"
```

### 方式 B：从 zip 包

解压 `ticket-pipeline-0.1.0-test.1.zip` 后同上指向解压目录。

装完后**重启 DSH 宿主**（desktop profile 由 Electron 独占管理，重启才加载）。

---

## 3. 配置插件

装好重启后，打开**侧栏 Plugins → 找到「工单流水线」→ 点那一行的「配置」**，是一整页：

| 区块 | 干什么 |
|---|---|
| 环境体检 | 点「立即体检」跑一遍和 `pipeline_doctor` 同一份检查（git 链路 / 仓库路径与 remote / 凭据 / 执行器与通知），结果按「必须修复」「提醒」分段 |
| 凭据 | 飞书 App ID & App Secret、QQ 邮箱授权码、GitLab Token、PushPlus token。**只写不读回**，界面只告诉你「已配置 / 未配置」 |
| 配置 | 30 个字段按「扫描与队列 / 租约与重试 / 执行 / agent 与模型 / 通知 / 杂项」分组，改完点「保存」，写进 profile 的 `cordis.patch.yml`，重启后仍在。字段键名：`pollIntervalMinutes`、`safePageRun`、`goneAfterScans`、`concurrency` / `leaseTtlMinutes`、`leaseHeartbeatSeconds`、`maxAttempts` / `workExecutor`、`ticketTimeoutMinutes`、`isolateWorktree`、`fetchBeforeCreate`、`branchPrefix`、`worktreeRetentionHours` / `provider`、`model`、`maxTokens`、`agentPreset` / `pushAdapter`、`pushplus.token`、`pushplus.channel`、`pushplus.template`、`qqmail.host`、`qqmail.port`、`qqmail.secure`、`qqmail.user`、`qqmail.to`、`pushplus.callbackUrl`、`notifyOn` / `enabled`、`logLevel` |
| 项目清单 | `projects[]` 是结构化数组，**不在表单里**，仍按下文手改配置 |

> 「配置」按钮只在插件被正常加载后出现；整页空白/没有按钮，先在对话里说 `pipeline_status`
> 确认插件活着，再看 §6 的排查。

`projects[]` 与其余字段的等价 JSON 写法（想手改配置时用，可直接抄，改三个地方）：

```json
{
  "enabled": false,
  "workExecutor": "mock",
  "pushAdapter": "mock",
  "projects": [
    {
      "name": "pms",
      "description": "项目管理系统",
      "match": {
        "platform": "feishu",
        "appToken": "<你的多维表格 app_token>",
        "tableId": "<你的数据表 id>"
      },
      "repo": {
        "path": "D:/WorkSpace/pms",
        "remote": "https://gitlab.example.com/group/pms.git",
        "baseBranch": "main",
        "gitlab": { "enabled": false }
      },
      "verify": {
        "build": "npm run build",
        "test": "npm test"
      }
    }
  ]
}
```

### 3.1 配置项速查

**顶层**（全部 30 个字段，键名与 `src/core/config.js` 的 `CONFIG_FIELDS` 一一对应，按面板分组列出）：

**扫描与队列（4 个）**：

| 键 | 默认 | 说明 |
|---|---|---|
| `pollIntervalMinutes` | `3` | 扫表轮询间隔（分钟） |
| `safePageRun` | `20` | 连续扫到多少条已知且未变的记录后停止翻页 |
| `goneAfterScans` | `3` | 连续几轮扫不到就认定该行已被删除 |
| `concurrency` | `1` | 并发数。当前只支持 1：一轮最多跑一票 |

**租约与重试（3 个）**：

| 键 | 默认 | 说明 |
|---|---|---|
| `leaseTtlMinutes` | `10` | 租约时长（多进程防双跑） |
| `leaseHeartbeatSeconds` | `60` | 跑票期间续租间隔（秒），必须显著小于租约时长 |
| `maxAttempts` | `2` | 可重试错误的自动重试上限 |

**执行（6 个）**：

| 键 | 默认 | 说明 |
|---|---|---|
| `workExecutor` | `mock` | `mock`（离线验证）/ `agent`（真执行）。agent 是真实现：起宿主 agent 改码 → 收集改动 → 跑验证 → 在工作区检出里做本地提交（`repo.gitlab.enabled: true` 时才额外开 draft MR） |
| `ticketTimeoutMinutes` | `40` | 单票执行超时，超时只通知不重试 |
| `isolateWorktree` | `false` | **改代码落点**。`false`（缺省）直接在项目工作区的检出里改代码、就地提交，**要求检出干净**（脏就拒跑并点名文件）；`true` 才每票 `git fetch` + `git worktree add` 开隔离 worktree |
| `fetchBeforeCreate` | `true` | 切 worktree 前先 `git fetch` 一次基准分支（只有 `isolateWorktree: true` 时用得上；宿主 profile 现为 `false`，项目工作区已是最新检出时不必每次拉） |
| `branchPrefix` | `ticket-` | 工作分支前缀（只有 `isolateWorktree: true` 时用于票分支） |
| `worktreeRetentionHours` | `24` | 终态票的隔离 worktree 保留时长；0 = 不自动清理（只有开了 `isolateWorktree` 才有 worktree 可清） |

**agent 与模型（4 个）**：

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | `workbuddy` | 跑任务书的模型 provider，留空则跟随当前会话默认 |
| `model` | ``（空） | 模型名，留空跟随会话默认（钉死模型会在它被限流时让整条流水线全灭） |
| `maxTokens` | `32000` | 单次模型调用的最大输出 token |
| `agentPreset` | `ptc` | agent 执行器给子 agent 挂的 preset id（决定它有哪些工具）。留空 = 不挂 |

**通知（11 个）**：

| 键 | 默认 | 说明 |
|---|---|---|
| `pushAdapter` | `pushplus` | 通知适配器 id：`mock`（只记内存）/ `pushplus`（微信不直连，经 PushPlus 的 `clawbot` 渠道中继，需要 `pushplus.token`）/ `qqmail`（零依赖自写 SMTP，已真实发信成功，授权码走凭据 `QQMAIL_AUTH_CODE`） |
| `pushplus.token` | ``（空） | PushPlus token，建议走凭据 |
| `pushplus.channel` | `clawbot` | PushPlus 推送渠道，ClawBot 用 `clawbot` |
| `pushplus.template` | `txt` | 只能用 `txt`：富模板在 ClawBot 里只显示前 50 字 |
| `qqmail.host` | `smtp.qq.com` | QQ 邮箱 SMTP 主机（企业邮箱换成自己的） |
| `qqmail.port` | `465` | SMTP 端口：465 = TLS 直连（推荐），587 = STARTTLS |
| `qqmail.secure` | `true` | true = 连上就是 TLS（465）；false = 先明文 EHLO 再 STARTTLS（587） |
| `qqmail.user` | ``（空） | 发件邮箱地址，例如 someone@qq.com |
| `qqmail.to` | ``（空） | 收件邮箱；多个用逗号分隔 |
| `pushplus.callbackUrl` | ``（空） | 送达回执地址（可选）。PushPlus 把 sendStatus 回吐到这里；HTTP 200 只代表受理，不代表送达 |
| `notifyOn` | done/skipped/failed/needs-info | 哪些阶段发通知 |

**杂项（2 个）**：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关。配好一切前**别开** |
| `logLevel` | `info` | 日志级别：debug / info / warn / error |

**projects[] 每项**：

> 飞书的工单表可以是**多维表格**也可以是**电子表格**，插件自己判断，你不用填表型。
> 电子表格这套键**设计待实施**（见 `docs/ticket-pipeline/feishu-sheet-source.md`）。

| 键 | 说明 |
|---|---|
| `name` | 项目唯一标识（分支名里会出现：`ticket-pms-xxx-r1`） |
| `match.platform` | `feishu` / `wps` / `mock` / `webform` |
| `match.appToken` + `match.tableId` | 飞书表显式绑定（推荐） |
| `match.docNamePattern` | 兜底：按文件名模糊搜（飞书） |
| `match.spreadsheetToken` | 飞书**电子表格** token（`shtcn…`）。和多维表格的 `appToken` 二选一；配了插件就按电子表格处理（**该能力设计待实施**） |
| `match.sheetId` / `match.sheetName` | 电子表格里**工作表**的 id 或名字（二选一），跟 `spreadsheetToken` 配套。`match.sheetName` 与金山源共用同一个键 |
| `match.sheetHeaderRow` | 表头在第几行，默认 `1` |
| `match.sheetIdentity` | 行身份来源：`seq`（默认，取序号列的值）/ `row`（取物理行号） |
| `match.sheetIdColumn` | 序号列的表头文字，默认「序号」 |
| `match.sheetColumns` | 列名覆盖，如 `{"description":"缺陷描述"}` |
| `match.sheetRange` | 限定读取范围，如 `A1:M500`（大表用；读值接口无分页、单次上限 10 MB） |
| `match.tableKind` | 逃生阀：`bitable` / `sheet`。**一般不用填**，留空 = 插件自己判断表型 |
| `match.statusValues` | 可配：状态列里哪些取值算「在处理中」（收票条件）。不填则用默认值 `处理中` |
| `match.recordIds` | 可配：只处理这几条工单（收窄开关）。不填 = 整张表 |
| `repo.path` | 本地 git 检出根目录（**必填**）；**同时就是这个项目的工作区目录** —— 插件会确保它在 DSH 的 Workspace 列表里有一份登记（已登记则复用，没有则补一条；一个项目一条，多张票共用）。目录必须**已经存在**，插件不会替你克隆；不存在时这张票以 `invalid-input` 失败并说明该改哪个配置 |
| `repo.remote` | GitLab remote URL。**只有** `repo.gitlab.enabled: true` 要走远程 draft MR 时才用得上；本阶段留空即可 |
| `repo.gitlab.enabled` | 远程 MR 出口总开关，**缺省 `false`**。false 时执行器完全不需要 `GITLAB_TOKEN`、不发任何 GitLab 请求，只做本地提交 |
| `repo.baseBranch` | 建隔离 worktree 用的基准分支（只有 `isolateWorktree: true` 时用到）。**建议显式填**；不填则自动识别（`origin/HEAD` → 当前分支 → 最后才猜 `main`）。仓库主分支不叫 main 时（如 `v2.x`）不填也能跑，但 `pipeline_doctor` 会提醒你补上 |
| `verify.build` / `verify.test` | 验证命令；**不填则跳过验证直接做本地提交**（验证结论记为「未跑成」并写进通知） |

---

## 4. 首次运行（强烈建议先走这一步）

### 4.1 mock 首跑：验证半程链路

保持 `workExecutor: "mock"`、`pushAdapter: "mock"`，开 `enabled: true`。

在工单表里新建一行：问题描述写「测试：请忽略」，「是否处理」填 `处理中`。

等一个轮询周期（≤3 分钟）后，在 DSH 对话里问插件：

```
pipeline_status
```

预期：能看到一张 `pending → worktree-ready → planning → done` 的票，`pipeline_status` 里带一行 `本地提交：mock…`。
mock 执行器不碰真代码，但**扫描、定位、确定改代码落点、状态机、通知全链路都已走通**。

### 4.2 五个对话工具

| 工具 | 干什么 |
|---|---|
| `pipeline_scan` | 立即扫一次工单表（不等轮询） |
| `pipeline_status` | 看所有票的当前阶段、本地提交（sha + 分支）与最近错误 |
| `pipeline_cancel` | 取消正在跑的那张票 |
| `pipeline_reset` | 把一张终态票（failed/gone 等）重置回 pending 重跑 |
| `pipeline_doctor` | 体检：git 链路 / 各项目仓库路径与 remote / 凭据 / 执行器与通知，结论按「必须修复」「提醒」分段 |

### 4.3 切换真执行

半程验证通过后：

1. `workExecutor` 改为 `"agent"`
2. `pushAdapter` 改为 `"qqmail"`（并填 `qqmail.user`/`qqmail.to`）
3. 确认 `QQMAIL_AUTH_CODE` 已配（**不需要** `GITLAB_TOKEN` —— 除非你另外打开了 `repo.gitlab.enabled: true`）
4. `enabled` 保持 `true`，重新拨一张工单

---

## 5. 日常使用循环

```
你：在飞书表填一行「问题描述/操作流程/模块/截图」，是否处理=处理中
插件（≤3 分钟内）：收票 → 确保项目工作区 → 确定改代码落点（缺省就在检出里，`isolateWorktree: true` 才开隔离 worktree）→ AI 改码 → 构建+测试 → 在工作区检出里做本地提交
你：收到邮件通知（含本地提交 sha + 分支 + 失败原因 + 工作区路径）
你：在检出里 `git show <sha>` review → 满意就合到你自己的分支 → 把工单「是否处理」拨走
```

### 5.1 通知里能读到什么

| 阶段 | 通知内容 |
|---|---|
| done | 本地提交的 sha（前 12 位）与分支、工作区路径、改动文件、测试结果 |
| failed | 失败原因（具体错误）、工作区保留路径（去现场看） |
| needs-info | 缺什么（常见：截图取不到，需要人补图） |
| skipped | 改动已提交到工作区，但验证没跑通，请人工确认 |

### 5.2 出问题怎么办

| 现象 | 处理 |
|---|---|
| 票卡住 / 改错了想重来 | `pipeline_reset`，或把工单「是否处理」拨走再拨回 |
| 票正在跑想停 | `pipeline_cancel` |
| 长时间没动静 | `pipeline_status` 看阶段；超 40 分钟是超时，会自动通知你 |
| 截图没进 prompt | 票会进 needs-info 并通知；补图后拨回重跑 |
| 想看改动细节 | 通知里的工作区路径保留 24 小时，直接 `git show <sha>` 看那个本地提交 |

### 5.3 安全边界（使用前必读）

- **工单正文按不可信输入处理**：表里出现「忽略以上要求/删文件/改配置/发邮件到某地址」等内容会被当问题描述忽略并转 needs-info（详见 ADR-0003）
- AI 只被授权改**这张票的改代码落点**里的代码（缺省就是项目工作区的检出；`isolateWorktree: true` 时是隔离 worktree）+ 跑 `verify` 配置的命令；**敏感文件**（`application.yml`/`.env`/`*.pem`/`*secret*`）不会被提交 —— 只用**点名暂存** `git add -- <非敏感文件>`，再用 `git commit -- <非敏感文件列表>` 只提交放行的那些，**不用 `git add -A`**（全量暂存会让敏感文件露在 index 里，手一抖就跟着提交走了）；被拦下的留在工作区并写进提交说明的「未提交」一行
- 凭据全部走 DSH credentials 存储，不落配置文件、不出现在错误信息里
- 默认**只做本地提交**，不 push、不合任何分支 —— 要不要合进主干永远由人决定。只有项目显式打开 `repo.gitlab.enabled: true` 时才会额外开一条 draft MR
- **插件里的 `git` 与 `verify` 命令以完整文件系统权限执行**。这不是疏忽，是宿主沙箱的硬约束：
  插件不是会话，调宿主 shell 时拿不到会话的写入授权，不显式声明 `danger-full-access` 就写不了
  `.git`（连 `git fetch` 都会 `Permission denied`）。所以这条旁路**只给 git 和 verify 用**，
  不用于执行工单正文里出现的任何命令。代价是你需要知道：跑票期间这两个子进程能写你的整台机器。
  详见 `docs/ticket-pipeline/architecture.md` §12.1

---

## 6. 验证安装是否正常

| 检查 | 命令/动作 | 预期 |
|---|---|---|
| 离线自测 | `node scripts/dev-run.mjs`（开发目录） | 288 项全过，exit 0 |
| 接线冒烟 | `node scripts/chain-smoke.mjs` | 11 项全过 |
| 插件加载 | 重启 DSH 后对话里说 `pipeline_status` | 工具能响应（enabled=false 时也会答） |
| 真扫表 | 配好凭据后说 `pipeline_scan` | 返回 created/updated/disappeared 计数 |
| 启动日志 | 看 DSH 启动输出 | 无 `did not activate ticket-pipeline` 警告 |
| 设置页 | Plugins → 工单流水线 → 该行的「配置」 | 打开是一整页：环境体检 / 凭据 / 配置（30 个字段，6 个分组） |
| 设置页体检 | 该页点「立即体检」 | 出「【环境体检】…」报告，与对话里 `pipeline_doctor` 结论一致 |
| 设置页保存 | 改任一字段 → 保存 | 提示「已保存」；重启后值还在 |
| 浏览器端一致性 | `node scripts/client-check.mjs`（开发目录） | `✅ client-check 通过` |
| 浏览器端冒烟 | `node scripts/client-smoke.mjs`（开发目录） | `✅ client-smoke 通过` |

> **排查：看到 `cannot get property "X" without inject`？**
> 两种成因，处理方式不同：
>
> 1. **宿主侧硬依赖没声明**（例如缺 `'timer'`）：`src/index.js` 的 `inject` 数组必须覆盖
>    `ctx.interval` 等全部硬依赖；漏了会出现 `did not activate ticket-pipeline`。
> 2. **客户端侧命名空间服务用属性访问**：宿主给的 `settings` / `credentials` / `ticketPipeline`
>    命名空间服务是**兄弟 fiber** 上的独立服务（服务名 `remote.<ns>`），不是 `remote` 对象的属性。
>    属性访问沿 fiber 链**向上**找 provide，兄弟不是祖先 ⇒ 抛这个错 ⇒ 配置页被错误边界接住，
>    **整页空白、控制台只有一行看不懂的报错**。正确写法是一律 `ctx.get('remote.<ns>')`
>    （查全局服务 store，不查 inject、不沿 fiber 链）。
>
> 另外：命名空间服务**不要写进 `inject`** —— 我们自己的 `ticketPipeline` 是用 `remote.$mount()`
> 建的，写进 inject 等于等自己把它建出来，fiber 永远不激活、配置页静默全空。
>
> 自检：`node scripts/client-smoke.mjs` 的假宿主照抄了真实 cordis 的服务模型
> （`ctx.get('remote.<ns>')` 取得到、属性式 `ctx.remote.<ns>` 取不到），退回坏写法会当场红。

> 注意：`scripts/` 不进安装包（发布白名单只含 src/lib/locale/icon/patch），
> 自测命令要在**开发目录** `D:/WorkSpace/dsh-ticket-pipeline/plugins/ticket-pipeline` 下跑。
>
> `client-check` 守的是「浏览器 bundle 只能手抄一份宿主侧描述符」这条约束：
> 改了 `src/remote/descriptors.js` 忘了改 `lib/client.js`，表现是**点体检没反应、宿主也不报错**，
> 所以发版前必跑。

---

## 7. 常见问题（FAQ）

**Q：为什么我配了凭据还是报 auth 错？**
飞书文档授权必须人工把应用加为表格协作者（§1.2）；空字符串凭据会被当成「没配」。

**Q：我的飞书工单表是「电子表格」不是「多维表格」，能扫到吗？**
当前**还不能** —— 插件的飞书源目前只支持多维表格，电子表格会在探测阶段被判成「不是多维表格」并报错
（这是代码路径限制，不是权限问题，别去反复申请权限）。电子表格支持**设计已定、尚未实施**，
方案见 `docs/ticket-pipeline/feishu-sheet-source.md`。届时你只要填电子表格的 token，
插件会自己判断表型，不用你选。

**Q：电子表格没有 `record_id`，插件怎么认出「还是那张票」？**
靠**序号列**（默认取表头叫「序号」的那一列）。人在表格上方**插行**会让所有后续行的行号整体漂移，
所以请**不要在工单上方插行**，也不要重填序号；序号留空时插件会兜底用物理行号，
但那张票在插行后会被判成新票。

**Q：改了表里的内容，为什么票没更新？**
只有「是否处理=处理中」的行会被跟踪修订；管理列（处理人/处理结果）的变化不触发。

**Q：一张票能同时被两个 DSH 进程处理吗？**
不能。租约机制保证单飞（`leaseTtlMinutes`），被抢走的进程会让出票并记 lastError。

**Q：AI 会直接动我的 main 分支吗？**
**缺省会。** 缺省模式（`isolateWorktree: false`）就在项目工作区的检出里改代码、就地提交，提交落在检出当前分支上 ——
如果那份检出停在 `main`，那就是 `main`。所以插件开跑前**硬性要求检出干净**（`git status --porcelain` 一有输出就拒跑，
并点名是哪些文件），提交本身也只是本地 commit，**插件从不 push、从不合并**。
想彻底隔离就打开 `isolateWorktree: true`：每票 `git fetch` + `git worktree add -b <branchPrefix>…` 开一个独立隔离目录。
不管哪种模式，最终产物都是这个检出里的一次**本地提交**：要不要合进主干、怎么合，由你决定。

**Q：同一个项目来两张工单，会在同一个目录里改代码吗？**
缺省模式**会** —— 两张票都改在同一份项目工作区检出里（所以要求检出干净，并且调度单飞、一轮只跑一票）。
打开 `isolateWorktree: true` 时才会各自开一个隔离 worktree 与独立分支。
会话都归属到同一个工作区下，在 GUI 里能一起看到。

**Q：报「项目工作区目录不存在：…」怎么办？**
`projects[].repo.path` 指向的目录不存在。插件不会替你克隆仓库（宿主的 Workspace 登记也要求
目录已存在），请先把仓库检出到那个位置，或把配置改成一个真实的检出目录。

**Q：报「会话的 cwd 是项目工作区根，需要把工作目录钉到 worktree，但本机没有 workingDirectory 服务」怎么办？**
只在 `isolateWorktree: true`（每票一个隔离 worktree）时才会撞到这个：那时插件要把 agent 的会话目录从
工作区根钉到隔离子目录，宿主缺 `workingDirectory` 服务就做不到，插件宁可让这张票失败也不会在错的地方改代码。
两条出路：装齐宿主服务（桌面版自带，裁剪过的 profile 可能没有）；或者关掉 `isolateWorktree`，
缺省模式 `worktreePath` 就等于工作区根、两者一致，**根本不需要这个服务**。

**Q：报 `git fetch 失败：couldn't find remote ref main` 怎么办？**
你的仓库主分支不叫 `main`。插件会自动识别（`origin/HEAD` → 当前分支），但显式写上更稳：
在项目配置里加 `repo.baseBranch: "v2.x"`（换成你的真实分支名）。跑 `pipeline_doctor` 能看到它实际用的分支。

**Q：报 `git fetch 失败：cannot open '.git/FETCH_HEAD': Permission denied` 怎么办？**
这是旧版本的行为（插件没给 shell 带沙箱策略，拿不到写授权）。更新到最新版即可；
若仍出现，确认安装副本已同步、且宿主**完全重启**过（页面刷新不算，模块有进程内缓存）。

**Q：`pipeline_status` 报 `value is not lossless JSON` 怎么办？**
同样是旧版本的 bug（工具输出里残留 `undefined`，宿主判整次调用失败）。最新版已在
`defineTool` 层统一剥掉 `undefined`，更新并重启即可。

**Q：插件页里那一行没有「配置」按钮？**
「配置」按钮只在这一行注册了 `plugins.row.config`（key 为 `@local/ticket-pipeline#ticket-pipeline`）
且 `package.json` 声明了 `dsh.client.platform: "web"` 时出现。装的是旧副本（安装目录里的
`lib/client.js` 不存在）就看不到 —— 重装插件并**完全重启宿主**（刷新页面不算）。

**Q：设置页空白 / 打开是「暂无配置项」？**
说明宿主的设置服务没把本插件列为可配 —— `src/core/config.js` 里 `Config` 上那棵 schema
descriptor 没挂上，或字段没标 `meta.volatile`。宿主对这种情况是**静默跳过**（不报错）。
自检：`node scripts/client-check.mjs` 会核对 descriptor 与分组表是否对齐。

**Q：在设置页填了 QQ 邮箱授权码，为什么配置里看不到？**
凭据从不回写配置文件、也不回传明文，界面只显示「已配置」。真要核对，看「立即体检」的
凭据段（`QQMAIL_AUTH_CODE` 不在体检清单里，体检只查 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` /
`GITLAB_TOKEN`）；发信失败时看通知日志里的错误码。

**Q：`GITLAB_TOKEN` 还要不要配？**
本阶段**不用配**，交付形态是项目工作区检出里的一次本地提交。缺省下执行器完全不碰 `GITLAB_TOKEN`、
不发任何 GitLab 请求；`pipeline_doctor` 没看到它也只说一句
`ℹ️ 凭据 GITLAB_TOKEN：未配置（本阶段不需要）`，**不进 warnings**。
只有项目显式写了 `repo.gitlab.enabled: true` 并配了 `repo.remote`，才会走原来的 GitLab Commits API
开一条 draft MR —— 那时才需要这个 token。

**Q：在设置页改了配置，为什么行为没立刻变？**
本插件 `~standard.vendor` 不是 `schemastery`，loader 判定为「整对象换掉」而非按 volatile 字段热更，
所以保存后插件会重新加载一次。跑票中途保存不影响已经发出的那次 tick。

---

*手册对应版本：v0.1.0-test.1（2026-11-04）。配置项与代码逐一核对过；
若后续版本调整键名，以 `src/core/config.js` 的内联注释为准。*
