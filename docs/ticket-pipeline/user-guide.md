# 工单流水线插件 · 使用手册（v0.1.0-test.1）

> 本手册面向**使用者**：从零开始把插件跑起来，直到收到第一封带 Draft MR 的通知邮件。
> 架构原理见 [architecture.md](./architecture.md)，实现进度见 [feature-checklist.md](./feature-checklist.md)。

---

## 0. 这个插件是干什么的

你在共享工单表（飞书多维表格 / 金山文档 Excel）里描述问题，插件自动完成：

```
监控工单表 → 发现「处理中」的行 → 解析问题描述/操作流程/截图
    → 在对应本地仓库切 worktree → AI 规划并改代码 → 跑构建/测试
    → 经 GitLab API 开 Draft MR → 通知你（QQ 邮箱直发 SMTP / PushPlus 中继微信）
    → 你人工验证后合并 MR，拨回工单状态
```

**人只做三件事**：填工单、收通知、验证合并。

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
| `GITLAB_TOKEN` | 开 MR 的 GitLab 私人令牌（需 api 权限） | workExecutor=agent 时 |
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

### 1.3 确认本地仓库

每个项目需要一个**本地 git 检出**（`repo.path`），并确认：

- 工作区干净（没有未提交改动，worktree 机制要求）
- 能访问对应 GitLab 远端（插件用 **GitLab Commits API** 提交，不依赖本机 `git push`）

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
| 配置 | 29 个字段按「扫描与队列 / 租约与重试 / 执行 / agent 与模型 / 通知 / 杂项」分组，改完点「保存」，写进 profile 的 `cordis.patch.yml`，重启后仍在。字段键名：`pollIntervalMinutes`、`safePageRun`、`goneAfterScans`、`concurrency` / `leaseTtlMinutes`、`leaseHeartbeatSeconds`、`maxAttempts` / `workExecutor`、`ticketTimeoutMinutes`、`fetchBeforeCreate`、`branchPrefix`、`worktreeRetentionHours` / `provider`、`model`、`maxTokens`、`agentPreset` / `pushAdapter`、`pushplus.token`、`pushplus.channel`、`pushplus.template`、`qqmail.host`、`qqmail.port`、`qqmail.secure`、`qqmail.user`、`qqmail.to`、`pushplus.callbackUrl`、`notifyOn` / `enabled`、`logLevel` |
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
        "baseBranch": "main"
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

**顶层**（全部 29 个字段，键名与 `src/core/config.js` 的 `CONFIG_FIELDS` 一一对应，按面板分组列出）：

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

**执行（5 个）**：

| 键 | 默认 | 说明 |
|---|---|---|
| `workExecutor` | `mock` | `mock`（离线验证）/ `agent`（真执行）。agent 是真实现：起宿主 agent 改码 → 收集改动 → 跑验证 → 开 GitLab draft MR，已产出过真实 draft MR |
| `ticketTimeoutMinutes` | `40` | 单票执行超时，超时只通知不重试 |
| `fetchBeforeCreate` | `true` | 切 worktree 前先 git fetch 一次基准分支 |
| `branchPrefix` | `ticket-` | 工作分支前缀 |
| `worktreeRetentionHours` | `24` | 终态票的 worktree 保留时长；0 = 不自动清理 |

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

| 键 | 说明 |
|---|---|
| `name` | 项目唯一标识（分支名里会出现：`ticket-pms-xxx-r1`） |
| `match.platform` | `feishu` / `wps` / `mock` / `webform` |
| `match.appToken` + `match.tableId` | 飞书表显式绑定（推荐） |
| `match.docNamePattern` | 兜底：按文件名模糊搜（飞书） |
| `match.statusValues` | 可配：状态列里哪些取值算「在处理中」（收票条件）。不填则用默认值 `处理中` |
| `match.recordIds` | 可配：只处理这几条工单（收窄开关）。不填 = 整张表 |
| `repo.path` | 本地 git 检出根目录（**必填**） |
| `repo.remote` | GitLab remote URL（开 MR 用） |
| `repo.baseBranch` | 切 worktree 的基准分支。**建议显式填**；不填则自动识别（`origin/HEAD` → 当前分支 → 最后才猜 `main`）。仓库主分支不叫 main 时（如 `v2.x`）不填也能跑，但 `pipeline_doctor` 会提醒你补上 |
| `verify.build` / `verify.test` | 验证命令；**不填则跳过验证直接开 draft MR** |

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
mock 执行器不碰真代码，但**扫描、定位、建 worktree、状态机、通知全链路都已走通**。

### 4.2 五个对话工具

| 工具 | 干什么 |
|---|---|
| `pipeline_scan` | 立即扫一次工单表（不等轮询） |
| `pipeline_status` | 看所有票的当前阶段与最近错误 |
| `pipeline_cancel` | 取消正在跑的那张票 |
| `pipeline_reset` | 把一张终态票（failed/gone 等）重置回 pending 重跑 |
| `pipeline_doctor` | 体检：git 链路 / 各项目仓库路径与 remote / 凭据 / 执行器与通知，结论按「必须修复」「提醒」分段 |

### 4.3 切换真执行

半程验证通过后：

1. `workExecutor` 改为 `"agent"`
2. `pushAdapter` 改为 `"qqmail"`（并填 `qqmail.user`/`qqmail.to`）
3. 确认 `GITLAB_TOKEN`、`QQMAIL_AUTH_CODE` 已配
4. `enabled` 保持 `true`，重新拨一张工单

---

## 5. 日常使用循环

```
你：在飞书表填一行「问题描述/操作流程/模块/截图」，是否处理=处理中
插件（≤3 分钟内）：收票 → 建 worktree → AI 改码 → 构建+测试 → 开 Draft MR
你：收到邮件通知（含 MR 链接 + 失败原因 + worktree 保留路径）
你：本地 checkout 那个分支验证 → 满意就合 MR → 把工单「是否处理」拨走
```

### 5.1 通知里能读到什么

| 阶段 | 通知内容 |
|---|---|
| done | MR 链接、改动文件、测试结果 |
| failed | 失败原因（具体错误）、worktree 保留路径（去现场看） |
| needs-info | 缺什么（常见：截图取不到，需要人补图） |
| skipped | 已开 MR 但未经真实验证（Draft 性质） |

### 5.2 出问题怎么办

| 现象 | 处理 |
|---|---|
| 票卡住 / 改错了想重来 | `pipeline_reset`，或把工单「是否处理」拨走再拨回 |
| 票正在跑想停 | `pipeline_cancel` |
| 长时间没动静 | `pipeline_status` 看阶段；超 40 分钟是超时，会自动通知你 |
| 截图没进 prompt | 票会进 needs-info 并通知；补图后拨回重跑 |
| 想看改动细节 | 通知里的 worktree 路径保留 24 小时，直接本地打开看 |

### 5.3 安全边界（使用前必读）

- **工单正文按不可信输入处理**：表里出现「忽略以上要求/删文件/改配置/发邮件到某地址」等内容会被当问题描述忽略并转 needs-info（详见 ADR-0003）
- AI 只被授权改 worktree 里的代码 + 跑 `verify` 配置的命令；**敏感文件**（`application.yml`/`.env`/`*.pem`/`*secret*`）不会被提交
- 凭据全部走 DSH credentials 存储，不落配置文件、不出现在错误信息里
- 只开 **Draft MR**，不 push 分支到远端、不合 MR —— 合并权永远在人手上
- **插件里的 `git` 与 `verify` 命令以完整文件系统权限执行**。这不是疏忽，是宿主沙箱的硬约束：
  插件不是会话，调宿主 shell 时拿不到会话的写入授权，不显式声明 `danger-full-access` 就写不了
  `.git`（连 `git fetch` 都会 `Permission denied`）。所以这条旁路**只给 git 和 verify 用**，
  不用于执行工单正文里出现的任何命令。代价是你需要知道：跑票期间这两个子进程能写你的整台机器。
  详见 `docs/ticket-pipeline/architecture.md` §12.1

---

## 6. 验证安装是否正常

| 检查 | 命令/动作 | 预期 |
|---|---|---|
| 离线自测 | `node scripts/dev-run.mjs`（开发目录） | 230 项全过，exit 0 |
| 接线冒烟 | `node scripts/chain-smoke.mjs` | 11 项全过 |
| 插件加载 | 重启 DSH 后对话里说 `pipeline_status` | 工具能响应（enabled=false 时也会答） |
| 真扫表 | 配好凭据后说 `pipeline_scan` | 返回 created/updated/disappeared 计数 |
| 启动日志 | 看 DSH 启动输出 | 无 `did not activate ticket-pipeline` 警告 |
| 设置页 | Plugins → 工单流水线 → 该行的「配置」 | 打开是一整页：环境体检 / 凭据 / 配置 / 项目清单 |
| 设置页体检 | 该页点「立即体检」 | 出「【环境体检】…」报告，与对话里 `pipeline_doctor` 结论一致 |
| 设置页保存 | 改任一字段 → 保存 | 提示「已保存」；重启后值还在 |
| 浏览器端一致性 | `node scripts/client-check.mjs`（开发目录） | `✅ client-check 通过` |
| 浏览器端冒烟 | `node scripts/client-smoke.mjs`（开发目录） | `✅ client-smoke 通过` |

> **排查：启动时看到 `cannot get property "X" without inject` + `did not activate`？**
> 这是插件声明的 `inject` 与实际用到的宿主服务不匹配（v0.1.0-test.1 曾因缺 `'timer'` 崩过，已修）。
> 自检：`src/index.js` 的 `inject` 数组必须覆盖 `ctx.interval`（timer）等全部硬依赖；
> 弱依赖一律走 `ctx.get(name)` 而不是 `ctx.<name>` 直接属性访问。

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

**Q：改了表里的内容，为什么票没更新？**
只有「是否处理=处理中」的行会被跟踪修订；管理列（处理人/处理结果）的变化不触发。

**Q：一张票能同时被两个 DSH 进程处理吗？**
不能。租约机制保证单飞（`leaseTtlMinutes`），被抢走的进程会让出票并记 lastError。

**Q：AI 会直接动我的 main 分支吗？**
不会。每票一个独立 worktree + 独立分支（`<branchPrefix>...`），最终产物是 Draft MR。

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

**Q：在设置页改了配置，为什么行为没立刻变？**
本插件 `~standard.vendor` 不是 `schemastery`，loader 判定为「整对象换掉」而非按 volatile 字段热更，
所以保存后插件会重新加载一次。跑票中途保存不影响已经发出的那次 tick。

---

*手册对应版本：v0.1.0-test.1（2026-11-04）。配置项与代码逐一核对过；
若后续版本调整键名，以 `src/core/config.js` 的内联注释为准。*
