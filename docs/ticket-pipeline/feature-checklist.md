# 工单流水线插件 · 功能清单与完成度

> 生成日期：2026-11-05
> 代码基线：工作区 `D:\WorkSpace\dsh-ticket-pipeline`（git 51 次提交，HEAD `5b94a17`），插件目录 `plugins/ticket-pipeline`
> 最近一次更新：2026-11-05 晚，`5b94a17` 修完 agent 侧四项（模型补齐 / preset 硬闸 / repo.gitlab 透传 / verify 命令引号），自测 230/230 全绿
> 口径声明：**本文只写代码里真实存在且已验证的东西**。凡是「打算做」「应该做」的一律进第 9 章「未完成与缺陷清单」，不混进完成项。所有行号取自本文生成时的源码。

---

## 0. 一句话结论

骨架和主链路已经成型：**飞书工单表 → 解析工单四要素 → 本地 worktree 改码 → 跑验证 → 开 GitLab draft MR → QQ 邮箱 / PushPlus 通知** 这条链在沙盒项目上真跑通过一次（真实 MR !1，不是假对象）。

但**真实业务项目（mgiot-pms）的工单还没有完整跑绿一次**。截至 `5b94a17`，agent 侧四个挡路的雷已排掉（模型默认补齐、preset 缺服务硬失败、`repo.gitlab` 透传、verify 命令引号），剩下的是：**上游模型配额**（workbuddy 429，非插件缺陷）、**飞书截图白名单没有配置键**、**金山文档源缺开放平台取数通道**、**工单四要素里「待修改项目」在飞书源上没有对应列、在金山源上值被丢弃**。

> 已修（`5b94a17` 入树）：agent 侧四个最挡路的雷 —— ① `{{model}}` 模板崩（新增 `resolveAgentOptions`，配置缺的从宿主 `agentDefaultModel.currentSelection()` 补齐，两项成对下发）② preset 服务缺失只记日志（改为**硬失败** `invalid-input`，把真因暴露出来）③ `repo.gitlab` 被配置校验层吞掉（透传 baseUrl/remote/projectId）④ verify 命令只按空白切（认引号，引号内反斜杠当字面量）。

| 口径 | 完成度 |
| --- | --- |
| 按用户 6 条需求逐条算 | 4 条可用 / 2 条部分可用 / 0 条空白 |
| 按工程完成度（代码 + 自测 + 文档） | 约 75% |
| 按「能直接上生产接真实工单」算 | 约 55%（agent 侧四个雷已排；剩飞书截图白名单配置键、金山取数通道、「待修改项目」列，以及上游模型配额这种外部因素） |
| 架构骨架完成度 | 约 85% |

**不需要推倒重来。** 内核（契约 / 存储 / 调度 / 错误模型）已经是零平台知识的干净分层，重构代价远大于补齐缺口。详见第 10 章。

---

## 1. 用户原始需求逐条对照

| # | 需求（原始表述） | 状态 | 真实依据 | 差在哪 |
| --- | --- | --- | --- | --- |
| ① | AI 同时监控多个平台（金山共享 Excel、飞书）上的工单表，检测内容变化 | **✅ 可用** | 飞书源 1264 行，已接真实表（appToken `RZZQbY4SkaY6z0shZaBcVpQCnhh` / table `tblWhRSGf0osJqrE`，79 条记录实测）；金山源 1340 行（xlsx/zip 自解 OOXML）；webform/mock 演示源 | 金山缺开放平台取数通道，只能用注入的 `fetchSheet`；飞书「收票状态值」与真实表语义不一致，已做成可配（`statusValues`） |
| ② | 可以在插件中配置对应工单的项目本地仓库地址 | **✅ 可用** | `projects[].repo.path` / `remote` / `baseBranch` / `targetBranch` / `gitlab`（baseUrl / projectId / remote），由 `locator-table`（187 行）把工单 projectId 映射到仓库；`repo.gitlab` 已能在配置校验层存活（`5b94a17`） | 无（这项已补齐） |
| ③ | 解析每张工单中的待修改项目、问题描述、操作流程及截图 | **⚠️ 部分** | 飞书列映射 `FEISHU_COLUMNS`（描述/操作流程/截图/模块/优先级/发现日期等）；金山列别名表 `xlsx.js:34-42`（含「待修改项目」）；截图三形态（附件 / 路径 / URL）都已建模并作为 `ImageBlock` 进消息 | ① 飞书表**没有「待修改项目」列**（实测列名只有：序号/发现部门/问题描述/发现日期/模块/操作流程/截图/优先级/是否处理/处理人/处理结果/处理日期）；② 金山表该列的值被丢弃，只留在 `raw.cells`；③ URL 形态截图默认全拒（无白名单配置键） |
| ④ | 自主规划并执行修复 | **⚠️ 部分** | `executor-agent` 真实现：`agents.create` + followup + 挂 preset + 钉 cwd + `git diff --name-status` 收集改动 + 敏感文件过滤；沙盒票 `sandbox\|rec-mock-001` 已由 agent 真改出 `src/pagination.js` 并开成 MR !1 | 真实业务票（pms）只在配额上卡过一次；两处宿主侧雷已修（`5b94a17`：`{{model}}` 补齐、preset 缺服务硬失败），但**尚未在真实 pms 票上完整跑绿一次**（上游 workbuddy 429 配额限制，非插件缺陷） |
| ⑤ | 完成后对问题功能进行测试，自动提交 PR | **✅ 基本可用** | 真跑出 GitLab draft MR `http://gitlab.example.com/mk/end/ticket-pipeline-sandbox/-/merge_requests/1`（sha `634777aa…`，changes_count=1，源分支 `ticket-sandbox-rec-mock-001-r1`）；验证命令从 `projects[].verify.build/test` 注入，`verify.test` 真跑出 exit 0 | 没配验证命令时 `phase` 仍是 `done`（契约里 `skipped` 是合法成功路径），现在把验证结论写在 `plan.summary` 最前面以免误读（`5b94a17`）；要彻底区分得新增 phase，属契约变更 |
| ⑥ | 通过微信 Clawbot 推送或 QQ 邮箱推送（先实现）完成通知，收到后看 PR 详情，人工验证后手动合并 | **✅ QQ 邮箱可用；微信走中继** | QQ 邮箱零依赖 SMTP 适配器（574 行）已真实发信成功（traceId `<mw319ltk.47861f8c479221d3@qq.com>`）；PushPlus 适配器 171 行 | 插件**不直连微信**：微信消息经 PushPlus 的 `clawbot` 渠道中继，需配 `pushplus.token`；PushPlus 回执未消费 |

### 1.1 端到端真实跑通记录（唯一一次全绿的真实链路）

工单：`sandbox|rec-mock-001` —— 沙盒仓库的「列表页按状态筛选后，翻到第二页会跳回第一页」。

| 环节 | 实际结果 |
| --- | --- |
| 扫描入队 | 水位对比识别为新票，进 `pending` |
| 工作区 | `git worktree add` 建 `.agents/worktrees/ticket-sandbox-rec-mock-001-r1` |
| 改码 | agent 改 `src/pagination.js` |
| 验证 | `verify.test` 退出码 0 → `passed` |
| 提 MR | GitLab draft MR !1（opened, draft, 源分支→main） |
| 通知 | 按配置走（当时为 mock） |
| 票态 | `done`，`testOutcome=passed`，`baseCommit=a6e3509…` |

其余 4 张票的失败原因（权威来源：`C:/Users/Administrator/.dsh/storages/ticket_pipeline.json` 的 `tables.tickets`）：

| 票 | 状态 | 失败原因（票面文案） | 真因 | 现状 |
| --- | --- | --- | --- | --- |
| `pms\|reczz28VWNWVbpgL` | done | —— | mock 执行器，MR 是 `mock://draft-mr/...` 假对象 | 仍是假 MR，需要重跑 |
| `pms\|reczz28VWNWVefNA` | failed | `internal: agent 没有产生任何文件改动` | **上游 workbuddy HTTP 429 / `quota_exceeded`**（重置时间 2026-11-05 17:09:35 +08:00），agent 一轮都没跑起来 | 已在 `1f788cb` 修：解码 agent 会话 `turn/end` 的 `reason.error.code`，限流转 `rate-limit` 并**抛出**（抛出才进内核退避队列） |
| `sandbox\|rec-mock-002` | failed (attempt 2) | `internal: agent 这一轮以错误结束：prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")` | 配置里 `model` 留空 → 宿主渲染系统提示时 `{{model}}` 无值 | 已在 `5b94a17` 修：`resolveAgentOptions` 从宿主 `agentDefaultModel.currentSelection()` 补齐 provider/model |
| `sandbox\|rec-mock-003` | failed (attempt 2) | 同上 | 同上 | 同上 |

---

## 2. 代码清单

`src/` 共 **38 个 .js / 11 717 行**；`scripts/` 共 8 个 .mjs / 6 154 行；`lib/client.js` 959 行（浏览器端设置面板）。

| 目录 | 行数 | 文件 |
| --- | --- | --- |
| `src/contracts/` | 970 | `errors.js`（错误模型）、`types.js`（阶段机 + 指纹）、`ticket-source.js`、`work-executor.js`、`push-adapter.js`、`repo-locator.js`、`record-filter.js` |
| `src/core/` | 2 716 | `scheduler.js`（调度核心）、`store.js`（持久化 + 租约）、`config.js`（配置校验 + 描述符）、`recover.js`（启动恢复）、`prompt.js` / `prompts.js`（任务书与反注入提示）、`domain.js`、`branch-name.js` |
| `src/adapters/` | 5 978 | 见下表 |
| `src/tools/` | 1 038 | `define.js`（工具范本）、`pipeline-scan.js`、`pipeline-status.js`、`pipeline-doctor.js`、`pipeline-reset.js`、`pipeline-cancel.js` |
| `src/remote/` | 151 | `descriptors.js`、`host.js`（宿主 Remote 通道） |
| 根 | 864 | `src/index.js` —— 组合根（装配全部适配器、注册工具、起轮询） |

| 适配器 | 行数 | 状态 | 说明 |
| --- | --- | --- | --- |
| `source-feishu/` | 1 264 | **真实可用** | 飞书多维表格 API；水位、状态值可配、recordIds 收窄、截图三形态 |
| `source-wps/` | 1 340 | **解析可用，取数待接** | `index.js` 401 + `xlsx.js` 750 + `zip.js`；自解 xlsx/OOXML、截图按锚点解包；取数走注入的 `fetchSheet` |
| `source-webform/` | 97 | 演示 | 内存表单源，验证「加平台 = 加目录 + 两行表」 |
| `source-mock/` | 257 | 测试 | 离线源 |
| `executor-agent/` | 1 387 | **真实实现（有 P0）** | 真 agent 改码、收集改动、跑验证、开 draft MR；含 `agent-failure.js` 失败原因识别 |
| `executor-mock/` | 141 | 测试 | 只演不动真格 |
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
| `pipeline_doctor` | 环境体检：git 链路、各项目仓库连通性、凭据、执行器与通知适配器 |
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

平台枚举：`src/core/config.js:441` `PLATFORMS = ['feishu', 'wps', 'mock', 'webform']`（表驱动，新增平台只加这一处）。

### 3.4 契约层（6 个文件 / 970 行）

| 契约 | 内容 |
| --- | --- |
| `errors.js` | `ERROR_KINDS` 7 类（auth / network / rate-limit / not-found / invalid-input / aborted / internal）；`RETRYABLE_KINDS = {network, rate-limit, internal}`；`FATAL_KINDS = {auth, not-found, invalid-input}`；`PipelineError` 带 `retryAfterMs` |
| `types.js` | 11 个 phase 与 `PHASE_TRANSITIONS` 转移表；`TERMINAL = [done, skipped, failed, gone]`；指纹字段序 |
| `ticket-source.js` | `TicketSource` 接口：`scan()` 产出 created / updated / disappeared |
| `work-executor.js` | `WorkExecutor` 接口：`run(ticket, target, ctx)` 产出 `ExecResult` |
| `push-adapter.js` | `PushAdapter` 接口：`send(input, signal)` 产出 `PushReceipt` |
| `repo-locator.js` | `locate(projectId)` → 仓库 / 分支 / remote |
| `record-filter.js` | 工单收窄开关（recordIds） |

---

## 4. 配置项全表

全局配置 **29 个键**（`src/core/config.js` `CONFIG_FIELDS`），另有项目级配置。

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
| `fetchBeforeCreate` | bool | true | — | 建工作区前先 `git fetch` |
| `branchPrefix` | str | `ticket-` | — | 分支名前缀 |
| `worktreeRetentionHours` | number | 24 | 0–720 | 工作区保留时长 |
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

| 字段 | 用途 |
| --- | --- |
| `name` | 项目名（= 工单 projectId，定位仓库用） |
| `match.platform` | `feishu` / `wps` / `mock` / `webform` |
| `match.appToken` / `tableId` / `viewId` / `docNamePattern` | 飞书表定位 |
| `match.statusValues` | 收票状态值集合（**可配**：真实表用「否」，缺省「处理中」） |
| `match.recordIds` | 只处理指定几张工单（收窄开关，**目前只有飞书接了**） |
| `match.sheetUrl` / `sheetName` / `statusColumn` / `statusValue` / `mediaPrefix` | 金山表定位 |
| `repo.path` | **本地仓库路径**（需求②） |
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
                      │                      ├─ prepareWorkspace（git fetch + worktree add）
                      │                      ├─ 取截图字节 → saveImage → ImageBlock
                      │                      ├─ executor.run(ticket, target, ctx)
                      │                      │     ├─ agent：改码 → collectChanges → verify → draft MR
                      │                      │     └─ mock：只演
                      │                      ├─ setPhase(done/skipped/failed/gone)
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
| 密钥 | 飞书 / GitLab / QQ 授权码走 `ctx.get(credentials)` 现取（`src/index.js:386/408/622`），**不落明文配置**；但 `pushplus.token` 仍是明文配置项（task-17 P1-10） |
| 工单正文不可信 | `core/prompts.js` `UNTRUSTED_TICKET_NOTICE` 拼在消息最前，要求模型把正文当数据、遇到指令就判 `needs-info`（`docs/adr/0003`） |
| git 写权限 | git / verify 走 `fullAccessSandboxPolicy`（`src/index.js:233-266`），理由见 `docs/adr/0004`：Windows ACL 缺 sessionId 时子进程只读，git 写 `.git/FETCH_HEAD` 会 Permission denied |
| 截图外链 | URL 形态截图默认**一律拒**（`source-feishu/index.js:302-308`）：截图地址是外部输入，不设白名单等于让填表的人替服务器发任意请求。代价：没有配置键可以放开（见 9.1 第 6 条） |
| 仓库定位 | `locator-table` 只做「工单 projectId → 配置里的项目条目」查表，**不做任何「模块名 → 代码路径」的推断**（那类知识装不进通用插件），代码定位交给 agent 现场读仓库 |
| 坏项目隔离 | `locator-table` 构造期只把坏条目记进 `brokenProjects`、不抛 —— 一个项目配错不会让整条流水线起不来 |
| 敏感文件 | `executor-agent` 有 `SENSITIVE_FILE_PATTERNS` 白名单过滤，被拦文件**不提交但仍开 MR**；`5b94a17` 起被拦文件名会写进 `plan.summary`（之前只有一行日志） |
| 合并动作 | 插件**只开 draft MR，从不合并**；合并由人手动做 |
---

## 8. 自测与验证

### 8.1 离线自测（可复跑，不联网）

| 命令 | 断言数 | 结果 |
| --- | --- | --- |
| `node scripts/dev-run.mjs` | **230** | 通过 230，失败 0（2026-11-05 实跑；早期那条受 `spawnSync git EPERM` 限制的用例已随 git 链路改走宿主 shell 而消失） |
| `node scripts/chain-smoke.mjs` | **11** | 通过 11，失败 0 |

`dev-run.mjs` 分 16 个小节：

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
| 8 | 工作区清理 | 过期 worktree 回收 |
| 9 | 飞书适配器（离线打桩） | 52 项：状态值、recordIds、指纹、早停退役 |
| 10 | P0 修复 | 租约心跳、注入时钟、送达回执配置、人工取消 |
| 11 | §5.1 A 组链路断点 | 截图进 prompt、真实工作区、失败原因、人工重开 |
| 11.5 | `pipeline_doctor` | 环境体检 |
| 12 | 组合根接线 | 工具真注册进 ctx、真拿到 store |
| 12b | 注册表真的接上了适配器 | qqmail 推送、agent 执行器 |
| 12c | 走宿主 shell 必须显式带 sandboxPolicy | 写授权 |
| 12d | 工具输出必须是 lossless JSON | `undefined` 会让宿主判整次调用失败 |
| 12e | 平台可插拔 | 状态值可配 + 金山文档接进组合根 |
| 13 | 新适配器 | gitlab 客户端 43 项 / qqmail 推送 / wps 工单源 21 项 |

### 8.2 真实链路验证记录

| 验证项 | 结果 |
| --- | --- |
| 真实 GitLab draft MR 创建 | ✅ MR !1（sandbox project 33） |
| GitLab 凭据权限 | Owner 级（`/repository/branches`、`/merge_requests` 均 200） |
| QQ 邮箱真实发信 | ✅ `accepted=true`，traceId `<mw319ltk.47861f8c479221d3@qq.com>` |
| PushPlus 适配器 | 已实现，发信通道依赖对方 token |
| 真实飞书表读取 | ✅ appToken `RZZQbY4SkaY6z0shZaBcVpQCnhh` / table `tblWhRSGf0osJqrE`，79 条 |
| 真实飞书工单入队 | ✅ `pms|reczz28VWNWVefNA`（statusValues + recordIds 精确收窄，只收进这一张） |
| 真实飞书工单改码 | ⚠️ 入队与四要素解析全对；agent 一轮被上游 429 配额挡死（非插件缺陷），宿主侧「`{{model}}` 崩」与「preset 缺服务」两个雷已在 `5b94a17` 排掉，尚未在配额恢复后复跑 |
| 飞书写回状态列 | ❌ app 对该表只有读权限，写回报 `code 91403 Forbidden` |
| 金山文档真实取数 | ❌ 无开放平台对接（见 9.1 第 3 条） |

### 8.3 环境事实（影响可复现性）

| 事实 | 值 |
| --- | --- |
| 宿主 shell | **Windows PowerShell 5.1**（不支持 `&&`、忽略 `cwd` 字段）→ 一律用 `git -C <path>` |
| DSH 沙箱写权限 | 子进程只能写会话工作区 → 目标仓库必须克隆到 `.repos/` 下 |
| 目标仓库 | `.repos/mgiot-pms`（GitLab project 28，`v2.x`）、`.repos/tp-sandbox`（project 33，main） |
| 插件依赖 | **零 npm 依赖**；一切宿主能力从 `options` 注入（插件目录解析不到 `@deepseek-ai/*`） |
| 插件改动生效 | 必须 `cp -r` 到安装副本 `C:/Users/Administrator/.dsh/profiles/desktop/node_modules/@local/ticket-pipeline/` 并重启宿主 |
| 权威票态 | `C:/Users/Administrator/.dsh/storages/ticket_pipeline.json` 的 `tables.tickets`（object，键 = projectId + `\u0000` + recordId） |

---

## 9. 未完成与缺陷清单

下面每一条都定位到了具体文件位置。**「已修（`<commit>`）」= 代码已提交；「已缓解」= 症状减轻但仍非根治；「待修」= 还没人动手。** 所有结论均对照 2026-11-05 工作区源码（HEAD `5b94a17`）核实。

### 9.1 P0 —— 挡住真实工单端到端

| # | 缺陷 | 位置 | 影响 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | **模型默认留空 → 宿主 persona 模板崩**：`agentOptionsFromConfig` 在 `model` 为空串时不带 model，宿主给 agent 会话装 personaPrefix 时含 `{{model}}` 变量 → 装配阶段直接报 `prompt variable "{{model}}" has no value for this assembly` | `src/adapters/executor-agent/index.js`（新增 `resolveAgentOptions`） | 沙盒 002/003 两张票就是这么挂的（attempt=2） | **已修（`5b94a17`）**：新增 `resolveAgentOptions`，配置优先、缺的读宿主 `agentDefaultModel.currentSelection()` 补齐，两项必须成对下发；宿主也给不出就报 `internal` 并说清该配什么。（早期那条「空串不下传即跟随会话默认」的判断是错的 —— 空串就是真的不下发，才会在模板上崩） |
| 2 | **找不到 agentPresets 服务只记日志继续跑**：agent 起来了但是零工具，改不出任何文件，最后报「没有产生任何文件改动」，真因被埋 | `src/adapters/executor-agent/index.js`（`setupAgent`） | headless profile 必现；桌面 profile 也可能缺 | **已修（`5b94a17`）**：改为抛 `invalid-input` 硬失败并列出该配什么（重试没用，是环境问题） |
| 3 | **金山文档无开放平台取数通道**：`wpsOptionsFromMatch` 只支持 `sheetUrl` 全局 fetch 下载，缺登录态大概率失败；无开放平台网关接入 | `src/adapters/source-wps/index.js:371-399` | 需求①的「金山」只有解析能力，没有取数能力 | **待修**（需金山账号 + 管理员审批建应用，或注入 `fetchSheet`） |
| 4 | **`repo.gitlab` 配置被校验层吞掉**：`validateProject` 只复制 `repo.remote/baseBranch/targetBranch`，而 `resolveGitlab` 优先读 `repo.gitlab.baseUrl/projectId` | `src/core/config.js`（`validateProject`） | 自建 GitLab / 子组路径配了也不生效 | **已修（`5b94a17`）**：透传 `baseUrl` / `remote` / `projectId` |
| 5 | **金山表「待修改项目」列的值被丢弃**：`toTickets` 用的 `projectId` 是源实例项目名，`makeTicket` 不接收该列的值，表格里那列只留在 `raw.cells` | `src/adapters/source-wps/index.js:156-169` | 需求③「待修改项目」在金山侧拿不到 | **待修** |
| 6 | **飞书 / 金山截图白名单没有配置键**：适配器读 `options.allowedImageHosts`（`source-feishu/index.js:306`），但 `CONFIG_FIELDS` 无此键、`feishuOptionsFromMatch` / `wpsOptionsFromMatch` 都不透传 | `src/adapters/source-feishu/index.js:306`、`src/core/config.js`、`source-wps/index.js:371` | 真实表的截图是文本链接形态 → 取不到图 → 整票转 needs-info（缺省一律拒，且无法从配置放开） | **待修（配置层缺口）** |

### 9.2 P1 —— 影响正确性与可运维性

| # | 缺陷 | 位置 | 影响 | 状态 |
| --- | --- | --- | --- | --- |
| 7 | **执行器返回 failed 结果时不重试**：调度器只对「抛出的错误」分档重试；执行器返回 `{error:{retryable:true}}` 也直接判 failed | `core/scheduler.js` `runOne`（只看 `normalized.retryable`，而执行器返回结果走成功路径不进 catch） | 可重试的失败被当成终态 | **待修**（但 executor-agent 已改为「限流等真失败一律抛出」绕开这条路，见 9.3 第 25 条） |
| 8 | **没配验证命令却报 done**：「未经验证」和「验证通过」在票面上看不出区别 | `src/adapters/executor-agent/index.js`（`run()` 末尾 `plan.summary`） | 人容易把「完成」误读成「测试过了」 | **已缓解（`5b94a17`）**：`phase` 语义按契约保持不变（`skipped` 是合法成功路径），改为把验证结论写在 `plan.summary` 最前面——通过写「验证通过：…」，没跑/失败写「⚠ 未通过验证（skipped）：…」。彻底区分需要新增 phase，属于契约变更，本轮不做 |
| 9 | **敏感文件只拦不报**：检出敏感文件改动后票仍按成功开 MR，且只写一行日志 | `src/adapters/executor-agent/index.js`（`run()` 末尾 `plan.summary`） | 人最后只会在 MR 里发现「少改了一个文件」 | **已修（`5b94a17`）**：被拦文件数与文件名写进 `plan.summary`（MR 描述里也带） |
| 10 | **verify 命令只按空白切**：不识别引号 | `src/adapters/executor-agent/index.js`（`splitCommand`） | Windows 下 `node "C:\Program Files\x\check.mjs"` 起不来 | **已修（`5b94a17`）**：认单双引号；引号内反斜杠一律当字面量（否则路径被吃成 `C:Program Filesx`）；未闭合引号报 `invalid-input` 并降级 `skipped` 而不是 `failed`。仍然**不解释** `&&` / 管道 / 重定向（配置项不该成为 shell 注入面） |
| 11 | **recordIds 收窄只有飞书接了**：`createRecordFilter` 只被 `source-feishu` 使用 | `src/contracts/record-filter.js` | 金山 / mock / webform 源无法收窄 | **待修** |
| 12 | **金山 recordId 用行号**：表格插一行会让同一张票换身份 | `src/adapters/source-wps/xlsx.js:611-613` | 插行后旧票变新票 + 旧票退役 | **待修** |
| 13 | **`pushplus.token` 走明文配置**，与 config 层描述「建议走 ctx.credentials」矛盾 | `src/adapters/push-pushplus/index.js:163-171` | 令牌落在 cordis.patch.yml | 待修 |
| 14 | **死配置**：`logLevel` 与 `concurrency` 只出现在配置定义里，代码无任何消费点 | `src/core/config.js:126/287/312/367` | 改它们不生效 | 待修 |
| 15 | **`PipelineError.retryAfterMs` 有写入但无读取方**（退避从未按上游建议时间算） | `src/contracts/errors.js:43-47` | 上游说「17:09 重置」，实际只按 30 秒基数退避 | 待修 |

### 9.3 P2 —— 健壮性与体验

| # | 缺陷 | 位置 |
| --- | --- | --- |
| 16 | 飞书 token 无 single-flight；401/403 不清缓存 → 密钥轮换后最长 2 小时全失败 | `src/adapters/source-feishu/index.js` |
| 17 | 飞书四处请求未传 `signal`；fetch 无请求级超时；URL 截图裸 fetch 有 SSRF 面 | `src/adapters/source-feishu/index.js` |
| 18 | 附件无字节上限 | `src/adapters/source-feishu/index.js` |
| 19 | `pickNext` 不排除中间相位（planning / testing 等） | `src/core/store.js:387-395` |
| 20 | 飞书早停时把「未访问」当「不存在」计退役；指纹先更新后判定 → 改内容再改回旧内容永不触发 updated | `src/adapters/source-feishu/index.js` |
| 21 | `notifyFor` 用不会 abort 的 signal；`locator.locate` 不传 signal | `core/scheduler.js`、`src/adapters/locator-table/index.js` |
| 22 | `tools/define.js` 的 integer 校验不查 min/max（`pipeline_status` 声明了 min1/max100，0/1000 照样放行） | `src/tools/define.js:135-138` |
| 23 | `ownerToken` 含 pid + 时间戳 → 重启后旧租约最多阻塞 10 分钟 | `src/core/store.js:78-81` |
| 24 | 无定时器卸载钩子；agent 泄漏（`agents.create` 返回的 `dispose` 已在 `1f788cb` 改为 `await created.dispose?.()`，老宿主退回 `agent.release?.()`） | `src/index.js`、`src/adapters/executor-agent/index.js` |
| 25 | **限流只能靠抛异常绕开**：executor-agent 把「上游 429 / 配额」转成 `PipelineError('rate-limit')` 抛出后才会进退避队列；若哪天有人改回「返回 failed 结果」，重试又会失效（根因是 9.2 第 7 条） | `src/adapters/executor-agent/agent-failure.js`、`src/core/scheduler.js` |

---

## 10. 要不要重构

**结论：不要推倒重来，做定点修复 + 补两个适配器。**

### 10.1 支持「不重构」的依据

| 依据 | 说明 |
| --- | --- |
| 内核零平台知识 | `core/` 与 `contracts/` 里 grep 不到任何飞书 / 金山专有字段；平台差异全在 `SOURCES` 表与适配器目录里 |
| 契约自洽 | 7 个契约文件、11 个 phase、7 类错误都有单测覆盖（`dev-run.mjs` 第 1 节） |
| 回归网够密 | 230 项离线断言全绿，改一处坏一处会立刻被看见 |
| 装配层已是表驱动 | 加平台 = 加目录 + `SOURCES` 一行（ADR-0001） |
| 坏隔离已做 | 一个项目配错不拖垮其它项目；能力名拼错只记日志 |

### 10.2 真要重构的话，只有这两处值得动

| 建议 | 理由 | 代价 |
| --- | --- | --- |
| 把 `scheduler` 里「执行器返回结果」与「执行器抛异常」两条失败通路合并成一条 | 现在可重试性判断被分裂在两处，行为不一致（9.2 第 7 条） | 中，要动调度器核心 + 补测试 |
| 把 `src/index.js`（864 行）按「装配 / 工具注册 / 轮询」拆三块 | 文件偏大，但拆了也不改变行为 | 低，收益也一般，**不建议本轮做** |

### 10.3 建议的推进顺序

| 阶段 | 内容 | 判据 |
| --- | --- | --- |
| 第一步（本轮） | 修 9.1 的 6 条 P0 + 9.2 里的 5 条 | 沙盒 002/003 与真实飞书票能跑过 agent 段 |
| 第二步 | 补金山开放平台取数通道 | 给一张真实金山表链接 + 凭据，能扫出票 |
| 第三步 | 真实飞书票跑通全链路（改码 → 验证 → draft MR → QQ 邮件） | 收到真邮件、点开是真 MR |
| 第四步 | 9.2 / 9.3 剩余项按需修 | —— |