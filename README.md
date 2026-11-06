# 工单流水线插件 · 使用手册（v0.1.0-test.1）

> 本手册面向**使用者**：从零开始把插件跑起来，直到收到第一封带**本地提交**的通知邮件。
> 架构原理见 [architecture.md](./architecture.md)，实现进度见 [feature-checklist.md](./feature-checklist.md)。

---

## 0. 这个插件是干什么的

你在共享工单表（飞书多维表格 / 金山文档 Excel）里描述问题，插件自动完成：

```
监控工单表 → 发现「处理中」的行 → 解析问题描述/操作流程/截图
    → 确定这张工单属于哪个项目 → 确保该项目的工作区已在 DSH 里登记
    → 直接在项目工作区的检出里改代码（缺省，开跑前要求检出干净）
      └─ 打开 isolateWorktree 时才额外切一个隔离 worktree 子目录
    → AI 规划并改代码 → 跑构建/测试
    → 在工作区的检出里做一次本地提交（commit）→ 邮箱/微信通知你
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
| `GITLAB_TOKEN` | 开远程 draft MR 的 GitLab 私人令牌（需 api 权限） | **仅** 项目显式打开 `repo.gitlab.enabled: true` 时；本阶段用不到 |
| `QQMAIL_AUTH_CODE` | QQ 邮箱**授权码**（不是登录密码） | pushAdapter=qqmail 时 |
| `PUSHPLUS_TOKEN` | PushPlus 推送 token | pushAdapter=pushplus 时 |

> ⚠️ 飞书应用需要被授权访问目标多维表格：在表格右上角「…→更多→添加文档应用」，
> 把你的应用加为协作者（可读）。**必须人工做**，应用自己加不了自己。
> QQ 邮箱授权码获取：QQ 邮箱网页版 → 设置 → 账户 → 开启 SMTP → 生成授权码。

### 1.3 确认本地仓库

每个项目需要一个**本地 git 检出**（`repo.path`），并确认：

- 工作区干净。缺省模式直接在**这份检出里**改代码并提交，脏起点会把你的半成品混进工单提交 ——
  插件会直接拒跑这张票并点名是哪些文件（提交或 `git stash` 之后再跑；或者打开 `isolateWorktree: true` 让每票用独立的隔离 worktree）。
  插件读状态用的是 `git status --porcelain -z -uall -- . ':(exclude).agents/worktrees' ':(exclude).agents/worktrees/**'`
  —— 带上 `-uall` 才能看穿未跟踪目录（否则目录里混的 `application.yml` 会被折叠成一个目录名而躲过拦截），
  并排除插件自己开的隔离 worktree；你手工核对时用 `git status --porcelain` 看到 `?? .agents/` 属正常，不算脏
- 能访问对应 GitLab 远端 —— **只在你打开了 `repo.gitlab.enabled: true`、要额外开远程 draft MR 时才需要**。
  默认交付形态是工作区检出里的本地提交，不需要远端、也不需要 `GITLAB_TOKEN`

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

装好重启后，在插件设置里填配置。完整示例（可直接抄，改三个地方）：

```json
{
  "enabled": false,
  "workExecutor": "mock",
  "pushAdapter": "mock",
  "isolateWorktree": false,
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

**顶层**：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关。配好一切前**别开** |
| `pollIntervalMinutes` | `3` | 扫表轮询间隔（分钟） |
| `workExecutor` | — | `mock`（离线验证）/ `agent`（真执行） |
| `pushAdapter` | — | `mock` / `pushplus` / `qqmail` |
| `ticketTimeoutMinutes` | `40` | 单票执行超时，超时只通知不重试 |
| `maxAttempts` | `3` | 可重试错误的自动重试上限 |
| `isolateWorktree` | `false` | **改代码落点**：`false`（缺省）直接在项目工作区的检出里改、就地提交（要求检出干净）；`true` 才每票开一个隔离 worktree |
| `branchPrefix` | `ticket-` | 票分支前缀（只有 `isolateWorktree: true` 才用得上） |
| `worktreeRetentionHours` | `24` | 终态票的 worktree 保留时长（只有 `isolateWorktree: true` 才有 worktree 可清） |
| `leaseTtlMinutes` | `10` | 租约时长（多进程防双跑） |
| `notifyOn` | done/skipped/failed/needs-info | 哪些阶段发通知 |
| `qqmail.user` / `qqmail.to` | — | 发件邮箱 / 收件邮箱（pushAdapter=qqmail 时） |
| `qqmail.host` / `qqmail.port` / `qqmail.secure` | smtp.qq.com / 465 / true | SMTP 连接参数 |

**projects[] 每项**：

| 键 | 说明 |
|---|---|
| `name` | 项目唯一标识（分支名里会出现：`ticket-pms-xxx-r1`） |
| `match.platform` | `feishu` / `wps` / `mock` / `webform` |
| `match.appToken` + `match.tableId` | 飞书表显式绑定（推荐） |
| `match.docNamePattern` | 兜底：按文件名模糊搜（飞书） |
| `repo.path` | 本地 git 检出根目录（**必填**）；**同时就是这个项目的工作区目录** —— 插件会确保它在 DSH 的 Workspace 列表里有一份登记（已登记则复用，没有则补一条），目录必须真实存在，插件不会替你克隆 |
| `repo.remote` | GitLab remote URL。只在要额外开远程 draft MR 时才需要（配合 `repo.gitlab.enabled`） |
| `repo.gitlab.enabled` | 远程 MR 出口总开关，**缺省 `false`**。缺省下只在工作区检出里做本地提交，不要 `GITLAB_TOKEN`、不发任何 GitLab 请求 |
| `repo.baseBranch` | 基准分支（默认 `main`）；只有 `isolateWorktree: true` 建隔离 worktree 时才用到 |
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

预期：能看到一张 `pending → worktree-ready → planning → done` 的票。
mock 执行器不碰真代码，但**扫描、定位、确定改代码落点、状态机、通知全链路都已走通**。

### 4.2 五个对话工具

| 工具 | 干什么 |
|---|---|
| `pipeline_scan` | 立即扫一次工单表（不等轮询） |
| `pipeline_status` | 看所有票的当前阶段、本地提交（sha + 分支）与最近错误 |
| `pipeline_cancel` | 取消正在跑的那张票 |
| `pipeline_reset` | 把一张终态票（failed/gone 等）重置回 pending 重跑 |
| `pipeline_doctor` | 环境体检：git 链路、各项目仓库与 remote、凭据、执行器与通知适配器，以及**正在跑的插件是不是比本地源码旧** |

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
插件（≤3 分钟内）：收票 → 确保项目工作区 → 在检出里改码 → 构建+测试 → 做本地提交
你：收到邮件通知（含提交 sha + 分支 + 失败原因 + 工作区路径）
你：在工作区检出里 `git show <sha>` review → 满意就合到你自己的分支 → 把工单「是否处理」拨走
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
| 想看改动细节 | 通知里的工作区路径保留 24 小时，直接 `git show <sha>` 看那个本地提交（`isolateWorktree: true` 时路径是隔离 worktree） |

### 5.3 安全边界（使用前必读）

- **工单正文按不可信输入处理**：表里出现「忽略以上要求/删文件/改配置/发邮件到某地址」等内容会被当问题描述忽略并转 needs-info（详见 ADR-0003）
- AI 只被授权改**这张票的落点目录**里的代码（缺省就是项目工作区的检出；`isolateWorktree: true` 时是隔离 worktree）+ 跑 `verify` 配置的命令；**敏感文件**（`application.yml`/`.env`/`*.pem`/`*secret*`）不会被提交 —— 只点名暂存要提交的非敏感文件（`git add -- <文件>` + `git commit -- <文件>`），敏感文件连索引都不进、留在工作区，文件名写进提交说明的「未提交」一行
- 凭据全部走 DSH credentials 存储，不落配置文件、不出现在错误信息里
- 默认只在**工作区检出里做本地提交**，不 push 分支到远端、不合任何 MR —— 要不要进主干永远由人决定。
  只有项目显式写 `repo.gitlab.enabled: true` 时才会额外开一条 draft MR（同样不自动合并）

---

## 6. 验证安装是否正常

| 检查 | 命令/动作 | 预期 |
|---|---|---|
| 离线自测 | `node scripts/dev-run.mjs`（开发目录） | 294 项全过，exit 0 |
| 接线冒烟 | `node scripts/chain-smoke.mjs` | 11 项全过 |
| 插件加载 | 重启 DSH 后对话里说 `pipeline_status` | 工具能响应（enabled=false 时也会答） |
| 真扫表 | 配好凭据后说 `pipeline_scan` | 返回 created/updated/disappeared 计数 |

> 注意：`scripts/` 不进安装包（发布白名单只含 src/locale/icon/patch），
> 自测命令要在**开发目录** `D:/WorkSpace/dsh-ticket-pipeline/plugins/ticket-pipeline` 下跑。

---

## 7. 常见问题（FAQ）

**Q：为什么我配了凭据还是报 auth 错？**
飞书文档授权必须人工把应用加为表格协作者（§1.2）；空字符串凭据会被当成「没配」。

**Q：改了表里的内容，为什么票没更新？**
只有「是否处理=处理中」的行会被跟踪修订；管理列（处理人/处理结果）的变化不触发。

**Q：一张票能同时被两个 DSH 进程处理吗？**
不能。租约机制保证单飞（`leaseTtlMinutes`），被抢走的进程会让出票并记 lastError。

**Q：AI 会直接动我的 main 分支吗？**
缺省模式下**会**：`isolateWorktree` 缺省 `false`，agent 直接在项目工作区的检出里改代码，改动就提交在**检出当前分支**上（通常就是 main）。
所以开跑前会硬性要求检出干净（`git status --porcelain` 有输出就拒跑并点名文件），避免把你的半成品混进工单提交。
想彻底隔离就在配置里打开 `isolateWorktree: true`：每票 `git fetch` + `git worktree add -b ticket-xxx` 开独立分支与隔离目录。
不管哪种模式，最终产物都是该检出里的一次**本地提交**，要不要合进主干、怎么合，由你决定（插件从不 push、从不合并）。

**Q：`GITLAB_TOKEN` 还要不要配？**
本阶段不用配。交付形态是「工作区检出里的本地提交」，执行器不连远程、不发任何 GitLab 请求；
`pipeline_doctor` 会把它显示成 `ℹ️ 凭据 GITLAB_TOKEN：未配置（本阶段不需要）`，不算问题。
只有你显式打开 `repo.gitlab.enabled: true` 想额外开远程 draft MR 时才需要它。

**Q：插件会自己克隆仓库吗？**
不会。`projects[].repo.path` 必须是**已经存在**的 git 检出目录；目录不存在时这张票会以
`invalid-input` 失败并告诉你该配哪里（不会给你留一个半克隆的空目录）。
插件会把这个目录登记成 DSH 的 Workspace（一个项目一条，多张票共用同一个），
每张票的会话都归属到它下面。

**Q：同一个项目同时来两张工单会怎样？**
共用同一个项目工作区；缺省模式下两张票都改在这份检出里（所以要求检出干净、并且调度单飞不并发），
打开 `isolateWorktree: true` 时才会各自开独立的 worktree 与分支。会话都会归属到同一个工作区下。
调度仍是单飞 —— 一轮只跑一票，第二张票排队。

---

*手册对应版本：v0.1.0-test.1（2026-11-04）。配置项与代码逐一核对过；
若后续版本调整键名，以 `src/core/config.js` 的内联注释为准。*
