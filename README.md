# 工单流水线插件 · 使用手册（v0.1.0-test.1）

> 本手册面向**使用者**：从零开始把插件跑起来，直到收到第一封带**本地提交**的通知邮件。
> 架构原理见 [architecture.md](./architecture.md)，实现进度见 [feature-checklist.md](./feature-checklist.md)。

---

## 0. 这个插件是干什么的

你在共享工单表（飞书多维表格 / 金山文档 Excel）里描述问题，插件自动完成：

```
监控工单表 → 发现「处理中」的行 → 解析问题描述/操作流程/截图
    → 确定这张工单属于哪个项目 → 确保该项目的工作区已在 DSH 里登记
    → 直接在项目工作区的检出里改代码（缺省；检出脏也能跑，先拍一份基线）
      └─ 打开 isolateWorktree 时才额外切一个隔离 worktree 子目录
    → AI 规划并改代码 → 跑构建/测试
    → 在工作区的检出里做一次本地提交（commit）：只提交 agent 改过的文件
    → 回填工单表：「是否处理」「处理结果」「处理日期」三列
    → 邮箱/微信通知你（含提交 sha、分支、改动文件、验证结论）→ 你在检出里 review 这个提交
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
> 拨回 `处理中` = 重新收票（包括重跑失败的票）。
>
> **扫描只读，回填是唯一的写入口**：票跑成 `done` / `skipped` 后，插件会回填三列 ——
> 「是否处理」改成 `writeBackStatus` 的值（缺省 `是`）、「处理结果」写怎么改的、
> 「处理日期」写当天。失败的票**不回填**（表里那行留在 `处理中`，人一眼看出这票没成）。
> 整件事由 `writeBack` 开关控制（缺省开），关掉就退回纯只读。
> 细节见 [ADR-0006](./docs/adr/0006-处理完回填工单表.md)。

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
> 把你的应用加为协作者（**可编辑** —— 要回填「是否处理/处理结果/处理日期」三列，
> 只读权限写回会返回 `code 91403 Forbidden`，那时票仍是 `done`，只是
> `pipeline_status` 会显示「回填表格：没写成 —— …」）。**必须人工做**，应用自己加不了自己。
> QQ 邮箱授权码获取：QQ 邮箱网页版 → 设置 → 账户 → 开启 SMTP → 生成授权码。

### 1.3 确认本地仓库

每个项目需要一个**本地 git 检出**（`repo.path`），并确认：

- 工作区**脏也能跑**。缺省模式直接在**这份检出里**改代码并提交，插件开跑前先拍一份基线
  （`git stash create`，只读，不动工作区和索引），跑完**只提交 agent 真正改过的文件** ——
  你自己那些未提交改动会原样留在工作区，不会被带进工单提交。
  脏只会提醒不会拒跑：**日志里**会点名这 N 个文件（通知正文里没有这一段），让你知道这次是在脏检出里动的手术。
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
  "writeBack": true,
  "writeBackStatus": "是",
  "keepSession": true,
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
| `workExecutor` | — | **只能是** `mock`（离线验证）/ `agent`（真执行）。写错（含大小写、尾空格）会直接报 `invalid-input` 并列可用值，**不再静默退回 mock** |
| `pushAdapter` | — | **只能是** `mock` / `pushplus` / `qqmail`。同样写错即报错，不静默降级 |
| `ticketTimeoutMinutes` | `40` | 单票执行超时，超时只通知不重试 |
| `maxAttempts` | `3` | 可重试错误的自动重试上限 |
| `isolateWorktree` | `false` | **改代码落点**：`false`（缺省）直接在项目工作区的检出里改、就地提交（脏也能跑，只提交 agent 改的）；`true` 才每票开一个隔离 worktree |
| `branchPrefix` | `ticket-` | 票分支前缀（只有 `isolateWorktree: true` 才用得上） |
| `worktreeRetentionHours` | `24` | 终态票的 worktree 保留时长（只有 `isolateWorktree: true` 才有 worktree 可清） |
| `writeBack` | `true` | 处理完回填工单表：「是否处理」「处理结果」「处理日期」三列。关掉就完全不写表（退化成只读） |
| `writeBackStatus` | `是` | 回填时「是否处理」列写的值（有的表用「已完成」「已处理」） |
| `keepSession` | `true` | 处理完保留项目工作区里的那次会话（agent 释放，会话留在工作区名下，可在 GUI 里点进去继续追问）。关掉就把会话一起收掉 |
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
| `repo.baseBranch` | 基准分支（默认 `main`）；只有 `isolateWorktree: true` 建隔离 worktree 时才用到。设置页里带候选下拉（列出该检出真实存在的分支） |
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
mock 执行器不碰真代码，但**扫描、定位、确定改代码落点、状态机、回填表格、通知全链路都已走通**。
跑完那一行的「是否处理」会变成 `是`，「处理结果」写着这次怎么改的（mock 下是假数据）——
如果你不想让插件动真表，把 `writeBack` 关掉再试。

### 4.2 五个对话工具

| 工具 | 干什么 |
|---|---|
| `pipeline_scan` | 立即扫一次工单表（不等轮询） |
| `pipeline_status` | 看所有票的当前阶段、本地提交（sha + 分支）、处理会话、回填结果与最近错误；还有一张**关键节点流程日志**时间线，直接写「现在停在第 N 站，已 X 分 Y 秒没动」 |
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
插件（≤3 分钟内）：收票 → 确保项目工作区 → 在检出里改码 → 构建+测试 → 做本地提交 → 回填表格
你：收到邮件通知（含提交 sha + 分支 + 失败原因 + 工作区路径）
你：在工作区检出里 `git show <sha>` review（想追问就用 `pipeline_status` 里的 `处理会话` 点进那个会话 —— 通知里没有这一行）→ 满意就合到你自己的分支 → 把工单「是否处理」拨走
```

### 5.1 通知里能读到什么

| 阶段 | 通知内容 |
|---|---|
| done | 本地提交的 sha（前 12 位）与分支、工作区路径、改动文件、测试结果 |
| failed | 失败原因（具体错误）、工作区保留路径（去现场看） |
| needs-info | 缺什么（常见：截图取不到，需要人补图） |
| skipped | 改动已提交到工作区，但验证没跑通，请人工确认 |

> 「处理结果」列里写的东西更全：改了几个文件（最多列 8 个）、验证结论、本地提交 sha/分支/路径、
> 处理会话 id，最后还写了一句「要进一步修改，把这个单元格清空、把「是否处理」拨回「处理中」即可重跑」。
>
> **`处理会话` 不在邮件里** —— 它只出现在两处：表格的「处理结果」列，以及 `pipeline_status` 的那一行
> `处理会话：<sessionId>（保留在工作区名下…）`。邮件正文只有 `本地提交：` / `draft MR：` / `改动文件：` / `验证：` 这几段。

### 5.2 出问题怎么办

| 现象 | 处理 |
|---|---|
| 票卡住 / 改错了想重来 | `pipeline_reset`，或把工单「是否处理」拨走再拨回 |
| 票正在跑想停 | `pipeline_cancel` |
| **不知道哪里有问题 / 卡在哪一站** | `pipeline_status` 的「流程日志」时间线（见 §5.2.1） |
| 长时间没动静 | `pipeline_status` 看阶段与流程日志（「现在停在第 N 站，已 X 分 Y 秒没动」）；超 40 分钟是超时，会自动通知你 |
| 截图没进 prompt | 票会进 needs-info 并通知；补图后拨回重跑 |
| 想看改动细节 | 通知里的工作区路径保留 24 小时，直接 `git show <sha>` 看那个本地提交（`isolateWorktree: true` 时路径是隔离 worktree） |

#### 5.2.1 流程日志（关键节点时间线）：一眼看出卡在哪

不知道「票到底走到哪了、为什么不动了」时看这里。整条链路的**关键节点**逐条记在票据的 `timeline` 上，`pipeline_status` 排成时间线：

```
11-06 20:14:58  ⑥ ✓ 跑验证 —— 开始跑验证命令（上一站 5 秒）
  ▶ 现在停在第 ⑥ 站「跑验证」，已 3 分 25 秒没动。时间一直不涨就是卡在这一站里（日志只在站点切换时打点）。
```

- **9 个主站**（①–⑨）：获取工单 → 查找对应工单的项目 → 检查工作区 → 创建会话（分支+模型）→ 处理工单问题 → 跑验证 → 提交（本地提交 / PR）→ 回填工单表 → 发送消息。另有 `·` 补充站（工作区就绪 / 规划改动 / 排队中 / 等你补充信息 / 已完成 / 已提交但验证没跑通 / 失败 / 表格里已删除）。
- **✓ 做成 / ✗ 没做成**：超时、被取消、可重试退避、不可重试失败、截图取不到（needs-info）、租约被抢走都会记 ✗，原因写在破折号后面那句中文补充里。
- **「现在停在第 N 站，已 X 分 Y 秒没动」** 就是回答「卡在哪里」：插件只在站点切换时打点，所以这个数一直不涨（或涨得离谱）就是卡在这一站里。needs-info 会注明「在等人，不是插件卡死」，终态写「已经收尾」。
- **括号「上一站 X 分 Y 秒」** = 相邻两条 `at`（写下时刻）之差，看哪一步慢扫一眼即可。
- **时间线是历史，不是这一轮状态**：工单被改、重新入队、人工重置都不清空；人工重置只在末尾补一条「排队中」分隔；上限 80 条。日志写失败只记插件日志，**不影响跑票**。
- ④ 只有真 agent 执行器会记（会话 id / provider+model / 分支 / 工作目录），mock 不记合法。
- 机器可读：`pipeline_status` 返回体 `tickets[]` 带 `timeline`（每条 `node`/`label`/`at` epoch ms/`ok`/`detail`）、`stalledForMs`、`station`、`lastNodeOk`。

### 5.3 安全边界（使用前必读）

- **工单正文按不可信输入处理**：表里出现「忽略以上要求/删文件/改配置/发邮件到某地址」等内容会被当问题描述忽略并转 needs-info（详见 ADR-0003）
- AI 只被授权改**这张票的落点目录**里的代码（缺省就是项目工作区的检出；`isolateWorktree: true` 时是隔离 worktree）+ 跑 `verify` 配置的命令；**敏感文件**不会被提交 —— 只点名暂存要提交的非敏感文件（`git add -- <文件>` + `git commit -- <文件>`），敏感文件连索引都不进、留在工作区，文件名写进提交说明的「未提交」一行
  - 敏感名单现在覆盖 **8 大类、41 条正则**（原 9 条；`.env` 家族 / Spring 配置 / 包管理器 token / SSH·GPG 私钥 / 云与容器凭据 / 明文机器凭据 / 证书·密钥库·Terraform 状态 / 关键字兜底）。被拦文件会进 `ExecResult.blockedFiles`，`plan.summary` 里写「另有 N 个敏感文件按约定未提交（疑似含真实凭据）：a、b、c」
  - 不会误伤 `src/env.js`、`docs/credentials.md`、`.environment.md` 这类源码/文档
- **`.git` 与插件 profile 有篡改自检**：git 自己看不见 `.git/` 的改动，所以执行器在每票开始与提交前各拍一次 sha256 快照比对（10 个 git 元数据文件 + 28 个官方 hook 名 + 4 个插件 profile 文件）；动过就 `git restore --staged` 撤回、判 `failed` + `invalid-input`（不可重试）并点名文件。**这是「被发现」不是「被阻止」**；真正能挡住 agent 任意命令的只有宿主权限
- **验证命令有超时与取消**：缺省 30 分钟（宿主 `dsh-bash-local` 的 `maxTimeoutMs` 缺省 10 分钟会把它夹下去，真实上限取小者），超时退出码 **124**（与「检查没通过」区分开），取消会真的 kill 子进程。要把上限提到 30 分钟得改 profile 里的 bash-local 配置
- **租约是 best-effort，不是原子 CAS**：同进程靠调度单飞，跨进程靠 put 后二次读确认。宿主 storageDomain 的 table API 没有 compare-and-swap 原语
- 凭据全部走 DSH credentials 存储，不落配置文件、不出现在错误信息里
- **回填只写三列**：`是否处理` / `处理结果` / `处理日期`。不碰别的列，不删行，不改工单正文；
  失败的票一律不写（表里留在「处理中」是刻意留的信号）。回填失败只记日志，
  票该是 done 还是 done，`pipeline_status` 会显示「回填表格：没写成 —— …」，
  **通知正文里也会多一行** `回填表格：没写成 —— <原因>（表格里那一行可能还停在「处理中」，请手工改一下）`
  （成功时不加这行，避免噪音）
- 默认只在**工作区检出里做本地提交**，不 push 分支到远端、不合任何 MR —— 要不要进主干永远由人决定。
  只有项目显式写 `repo.gitlab.enabled: true` 时才会额外开一条 draft MR（同样不自动合并）

---

## 6. 验证安装是否正常

| 检查 | 命令/动作 | 预期 |
|---|---|---|
| 离线自测 | `node scripts/dev-run.mjs`（开发目录） | 376 项全过，exit 0 |
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
检出脏也不会拒跑了（脏也能跑）：插件开跑前先拍一份基线，跑完只提交 agent 真正改过的文件，
你自己那些未提交改动原样留在工作区，不会被带进工单提交。
想彻底隔离就在配置里打开 `isolateWorktree: true`：每票 `git fetch` + `git worktree add -b ticket-xxx` 开独立分支与隔离目录。
不管哪种模式，最终产物都是该检出里的一次**本地提交**，要不要合进主干、怎么合，由你决定（插件从不 push、从不合并）。

**Q：工作区里有未提交改动，还能跑票吗？**
能。缺省模式不再要求检出干净 —— 插件先用 `git stash create` 拍一份基线快照（只读：不写 ref、不动工作区、
不动索引，`git stash list` 仍是空的），再把 agent 改的与基线比，**只提交 agent 真正改过的文件**。
你用 `git add` 进索引的改动同样被排除。唯一例外是拍基线本身失败（极罕见），那时会退化成按检出点收集改动，
日志里会提示「人原本未提交的改动可能被一起提交」。

**Q：处理完表格会怎么变？**
「是否处理」变成 `writeBackStatus` 的值（缺省 `是`），「处理结果」写这次怎么改的（改了哪些文件、验证结论、
本地提交 sha/分支/路径、处理会话 id、以及怎么重跑），「处理日期」写当天。
失败的票不回填。不想让插件写表就把 `writeBack` 关掉。写回被拒（应用只有可读权限）时票仍然是 `done`，
`pipeline_status` 会显示「回填表格：没写成 —— …」。

**Q：处理完那次会话去哪了？**
留在该票所属的**项目工作区**名下，不会消失 —— `keepSession` 缺省 `true`，`pipeline_status` 里能看到
`处理会话：<sessionId>`，在 GUI 会话列表里点进去就能接着问「为什么这么改」。agent 实例本身
一定会释放（不占模型配额），保留的只是那次会话。不想要就把 `keepSession` 设成 `false`。

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
共用同一个项目工作区；缺省模式下两张票都改在这份检出里（所以调度单飞、一轮只跑一票），
打开 `isolateWorktree: true` 时才会各自开独立的 worktree 与分支。会话都会归属到同一个工作区下。
调度仍是单飞 —— 一轮只跑一票，第二张票排队。

---

*手册对应版本：v0.1.0-test.1（2026-11-04）。配置项与代码逐一核对过；
若后续版本调整键名，以 `src/core/config.js` 的内联注释为准。*
