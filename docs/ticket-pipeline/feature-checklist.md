# 工单流水线插件 · 功能清单与完成度评估

> 生成日期：2026-11-04
> 对应代码：`plugins/ticket-pipeline/`（31 个源文件，约 6352 行）
> 对应设计文档：`docs/ticket-pipeline/architecture.md`（983 行，13 节）
> 评估方式：逐文件读源码 + 跑离线自测 + 与设计文档逐条比对。**本清单的每一条状态都对应可复查的代码位置或实测结果。**

---

## 0. 一句话结论

**骨架、契约、内核、飞书链路是真的；真正"干活"的那一段（自主改代码 → 跑测试 → 开 PR）还没有。**

按用户的六条需求算：**完整可用 2 条（②⑥的一半），部分可用 2 条（①③），未实现 2 条（④⑤）**。
架构层（可插拔、模块职责、数据契约、错误分类重试）已经扎实，**不需要推倒重写**；需要的是**补三块实现 + 修十个已定位的缺陷**。

整体完成度约 **55%（架构与基础设施 80%，端到端业务闭环 35%）**。

---

## 1. 六条需求的完成情况

| # | 需求 | 状态 | 依据 |
|---|---|---|---|
| ① | 多平台监控工单表内容变化 | 🟡 **飞书 ✅ / 金山 WPS ❌** | `adapters/source-feishu/index.js`（798 行，真实实现）；`adapters/source-wps/index.js:24-37` 直接抛「暂不实现」 |
| ② | 配置工单对应项目的本地仓库地址 | ✅ **已完成** | `core/config.js:254` `validateProject` 校验 `repo.path`；`adapters/locator-table/index.js` 按 `projectId` 查表 |
| ③ | 解析待修改项目 / 问题描述 / 操作流程 / 截图 | 🟡 **飞书侧 ✅ / WPS 侧 ❌** | `contracts/ticket-source.js:95` `makeTicket` 统一落字段；`source-feishu` 三形态截图取字节（附件 / 路径 / 链接） |
| ④ | 自主规划并执行修复 | ❌ **未实现** | `adapters/executor-agent/index.js:60-63` `run()` 抛 `PipelineError('invalid-input')` |
| ⑤ | 完成后测试 + 自动提交 PR | ❌ **未实现** | 同上；验证命令与 GitLab Commits API 的调用点都还没写 |
| ⑥ | 微信 Clawbot / QQ 邮箱推送通知 | 🟡 **PushPlus ✅ / QQ 邮箱 ❌** | `adapters/push-pushplus/index.js`（172 行，真实 HTTP）；全仓库 grep「qq / smtp / mail」**零命中** |

### 1.1 ① 多平台监控

**已实现（飞书）**
- 认证：`POST /open-apis/auth/v3/tenant_access_token/internal`，token 带缓存。
- 扫描：`records/search` `page_size=500`，按最后更新时间降序；停止条件是「连续 `safePageRun`（默认 20）条已知且未变」。
- 变更判定：**用内容指纹而不是 mtime**（`contracts/types.js:195` `fingerprintOf`）—— 人改「处理人」不会误触发修订。
- 退役：删除的行连续 `goneAfterScans`（默认 3）轮扫不到才置 `gone`。
- 收票条件：只收「是否处理 = 处理中」。
- 三种绑表路径：`appToken+tableId` 直用 / `appToken+docNamePattern` 匹配 / 只有 `docNamePattern` 先搜云文档再取唯一表；命中 0 张或 >1 张一律当配置错误。
- **绝不写回表格**（表是触发器，不是状态机）。

**未实现（金山文档 / WPS）**
- `source-wps/index.js` 全文 40 行，`scan` 与 `loadScreenshot` 都抛错。
- 文件头已经写清了三条硬理由，这是**实测结论不是偷懒**：
  1. WPS 开放平台 28 个 `kso.*` 事件里**没有表格内容/文件变更事件**，只能轮询；
  2. `range_data` 只给 `is_cell_pic:true`，**不给 URL / bytes / 附件 id**，唯一出路是下载 `.xlsx` 自己解 OOXML（`xl/media` + `xl/drawings/drawing*.xml` 的 `xdr:col`/`xdr:row`）——这是另一个规模的项目；
  3. 建应用要企业账号 + 管理员审批。
- 结论：**金山文档这一半是独立工作量，不是「加个目录」**，且成本远高于飞书。

### 1.2 ② 配置本地仓库地址 —— 已完成

- 配置形状：`projects[]` 每条含 `name` / `match`（表绑定）/ `repo`（本地路径 + 远端 + 基准分支 + 目标分支）/ `verify`（构建 + 测试命令）/ `description`。
- `repo.path` 必填（本地 git 检出根目录）；`match.platform` 限 `feishu|wps|mock`；飞书必须给 `appToken+tableId` 或 `docNamePattern` 二选一；`name` 必须唯一。
- 校验时机在**插件挂载那一刻**（`locator-table` 构造时索引校验，缺 `name` 或重名直接抛）—— 配置写错立刻炸，不等到跑起来。
- **表级绑定**：工单属于哪个项目在「表」这一级就定了，不在行级判断。

### 1.3 ③ 解析工单字段 —— 飞书侧已完成

- 统一入口 `makeTicket`（`contracts/ticket-source.js:95`）：`recordId` / `projectId` / `description` / `screenshots` / `seq` / `department` / `foundAt` / `module` / `flow` / `priority` / `status` / `raw`。
- **指纹字段**：`description / module / flow / screenshots / priority / department` —— 刻意**不含** `status`、处理人、处理结果、处理日期。
- 截图四种引用形态：`attachment{fileToken}` / `path{path}` / `url{url}` / `unknown{raw}`，归一化保证指纹可复现。
- 截图取字节的三条路：附件走 `drive/v1/medias/:file_token/download`；本地路径走 `ctx.fs.readBytes`（20MB 上限）；链接走裸 `fetch`（**不带凭据**）。
- 渲染成 agent 任务书：`core/prompt.js:27` `renderTicketPrompt` —— 问题描述 / 操作流程 / 代码定位指引 / 7 条约束（只改相关代码、不提交含凭据配置、不动 CI 不合并、按项目 `verify` 跑验证、跑不起要写清原因不要编造、全程中文）。
- **刻意不内置任何项目专属的「模块 → 代码路径」别名表**（通用插件装不下项目专属知识，代码定位交给 executor-agent 现场读仓库）。

### 1.4 ④⑤ 自主规划执行 + 测试提 PR —— 未实现（这是最大缺口）

- `adapters/executor-agent/index.js` 只有 67 行，`run()` 抛错。
- 好消息：**实现要点已经写在该文件的头注释里**，不需要重新调研：
  1. 起 agent：`ctx.agents.create({sessionId, meta:{cwd}, agentOptions, setup})`；
  2. 推任务必须 `agent.followup(userMessage)` —— `inject()` **不唤醒** agent（followup=下一轮+唤醒 / steer=下一步+唤醒 / inject=下一步不唤醒）；
  3. 等结束：`await agent.whenIdle()` + `session.seq` 判稳，等 `turn/end` 持久事件，**不轮询** `agent/status`；
  4. 验证：命令从项目配置 `verify` 注入，环境起不来记 `testOutcome:'skipped'` 且写清原因，**仍然开 draft MR**（契约明确这是合法成功路径）；
  5. 开 MR：`git push` 本机物理不可能（沙箱禁止给 `git-receive-pack` 建 stdin 管道，`fatal: unable to fork`）→ 只能用 GitLab **Commits API** `POST /api/v4/projects/:id/repository/commits`（`branch` + `commit_message` + `actions[]`）物化改动，再 `POST /merge_requests` 且**标题必须 `Draft:` 前缀**（`draft=true` 被静默忽略）；开之前先 `GET /repository/branches/:branch` 探存在（分支不存在时 GitLab 也返回 201）；
  6. 不提交含真实凭据的配置文件。
- 现成的 mock 执行器（`adapters/executor-mock`）已经把阶段推进、超时、失败、通知的全链路跑通了，**接真执行器时内核不用改**。

### 1.5 ⑥ 通知推送

**已实现（PushPlus + 微信 clawbot）**
- `POST https://www.pushplus.plus/send`，15 秒超时，body `{token, title, content, channel, template, callbackUrl?}`。
- 错误分类：5xx → `internal`、4xx → `invalid-input`、`code` 903/907 → `auth`、其余非 200 → `internal`。
- 空 token **不在构造期抛**（避免插件挂载失败），发送时抛 `auth`。
- `txt` 模板不渲染 Markdown，所以 `renderContent` 把 MR 链接单独提到最后一行。

**两个已知缺口**
1. **`pushplus.callbackUrl` 配不进去** —— 代码读得到（`push-pushplus/index.js:169`），但 `core/config.js` 的 `CONFIG_FIELDS` **没有这个键**，用户写进配置会被 flatten 掉。⇒ 送达回执链路接不上。
2. **`accepted` ≠ 送达** —— PushPlus `code:200` 只代表服务端受理，真送达要看 `callbackUrl` 的 `sendStatus`（0 未发 / 1 发送中 / 2 成功 / 3 失败）。契约里已写明内核不得据此认定「人已知」。

**未实现（QQ 邮箱）**
- 全仓库无任何 `smtp` / `mail` 相关代码。
- 实现要点（已在审计中给出）：QQ 邮箱只有 SMTP、没有 HTTP 发信 API，而本插件**零 npm 依赖**（本机 `npm install` 不可用）→ 需用 `node:net`/`node:tls` 自写 SMTP（EHLO / STARTTLS / AUTH LOGIN / MAIL FROM / RCPT TO / DATA）；内核传的 `signal` 永不 abort，需自建 `AbortController` + 超时；凭据缺失不要在构造期抛。

---

## 2. 架构层完成度

| 架构要素 | 状态 | 说明 |
|---|---|---|
| 平台适配层可插拔 | ✅ **设计到位，落地有 2 处硬编码** | 四层接口契约（`TicketSource` / `RepoLocator` / `WorkExecutor` / `PushAdapter`）齐全，内核零平台知识；换平台 = 新目录 + 注册表加一行。**但**：`core/config.js:242` `normalizePlatform` 硬编码 `feishu|wps|mock`；`src/index.js:243` 只给 feishu 注入水位/凭据/本地文件能力 |
| 模块职责 | ✅ 清晰 | `core/`（scheduler / store / config / recover / prompt / domain）、`contracts/`（6 个契约文件）、`adapters/`（8 个）、`tools/`（2 个）、`src/index.js`（组合根） |
| 数据流转 | ✅ 完整且已文档化 | 架构文档 §6 数据契约、§7 状态机（11 个 phase + 18 条转移边）、§11 完整时序 |
| 配置项 | ✅ 全量 21 个键 | 见 §4 |
| 错误与重试处理 | ✅ 设计完整 | 7 种错误分类 + 可重试/致命集合 + 决策表 + 降级表 + 通知文案模板；⚠️ 但有两处实现漏了（见 §5） |
| 安全权限边界 | 🟡 **散落在文档各处，缺独立章节** | 已有：凭据走 `ctx.credentials` 不进配置、工单表只读、只开 draft MR 不自动合并、不改 CI、不提交含凭据配置、沙箱实测约束。**缺**：一份集中的「权限边界」章节 + 明确的凭据引用清单 |

**依赖方向**（架构文档 §3）：`core → contracts ← adapters`，适配器之间**禁止互相 import**，唯一例外是 `src/index.js`。这条纪律在代码里被遵守了。

---

## 3. 已经跑通的部分（可信度最高）

**离线自测：`node scripts/dev-run.mjs` → 通过 54 项，失败 0 项，exit 0**（本轮复跑确认）

9 个测试段：
1. 契约层（4）
2. 队列与租约（3）
3. 多项目主键隔离（1）
4. 整轮 tick（5）
5. 失败与收尾（7）
6. 修订退役与人工重置（4）
7. 启动恢复（3）
8. 通用仓库定位器（4）
9. 工作区清理（1）
10. 飞书适配器离线打桩（21）

已覆盖的核心机制：
- **单飞**（一轮不叠第二轮）、**存储租约**（写后回读校验的 CAS 语义，不用文件锁）
- **复合主键隔离**：`ticketKey = projectId + \u0000 + recordId`，防止跨项目串票
- **超时**（`ticketTimeoutMinutes` 默认 40，自测用 0.001 = 300ms）、**人工取消**（标 failed 但不通知）、**可重试错误回队尾保留工作区**
- **修订退役**：指纹变了才 revise；终态票（done/skipped/gone）收到修订会复活重入队；`failed` 不自动重跑（唯一重开路径 = 人把「是否处理」拨走再拨回）
- **启动恢复**：`RESUME_PHASE` 停在原步重做不跳步；工作区没了就重建或回队列
- **飞书全链路离线打桩**（21 项）：认证、分页停止条件、字段归一、截图三形态、错误码映射、绝不写回

---

## 4. 配置项全量清单（21 个键 + `projects[]`）

| 键 | 默认 | 范围 | 有消费者？ |
|---|---|---|---|
| `pollIntervalMinutes` | 3 | 1–60 | ✅ |
| `safePageRun` | 20 | 5–100 | ✅ |
| `goneAfterScans` | 3 | 1–20 | ✅ |
| `concurrency` | 1 | **min=max=1** | ❌ **死配置**（内核硬编码一轮一票） |
| `leaseTtlMinutes` | 10 | 1–60 | ⚠️ 用了，但**从不续租**（见 §5-①） |
| `maxAttempts` | 2 | 1–5 | ✅ |
| `workExecutor` | 'mock' | 字符串 | ✅ |
| `ticketTimeoutMinutes` | 40 | 5–180 | ✅ |
| `fetchBeforeCreate` | true | 布尔 | ✅ |
| `branchPrefix` | 'ticket-' | 字符串 | ✅ |
| `worktreeRetentionHours` | 24 | 0–720 | ✅ |
| `provider` | 'workbuddy' | 字符串 | ❌ **死配置** |
| `model` | 'deepseek-v4.1-flash' | 字符串 | ❌ **死配置** |
| `maxTokens` | 32000 | 1024–200000 | ❌ **死配置** |
| `pushAdapter` | 'pushplus' | 字符串 | ✅ |
| `pushplus.token` | '' | 字符串 | ✅ |
| `pushplus.channel` | 'clawbot' | 字符串 | ✅ |
| `pushplus.template` | 'txt' | 枚举仅 txt | ✅ |
| `pushplus.callbackUrl` | — | — | ❌ **代码读但 schema 不认**（§5-④） |
| `notifyOn` | ['done','skipped','failed','needs-info'] | 字符串数组 | ✅ |
| `enabled` | **false** | 布尔 | ✅（默认关着，需人工打开） |
| `logLevel` | 'info' | 字符串 | ❌ **死配置**（日志级别没真接） |

`projects[]` 每条：`name`（唯一，必填）、`match{platform, appToken?, tableId?, viewId?, docNamePattern?}`、`repo{path(必填), remote?, baseBranch?, targetBranch?}`、`verify{build?, test?}`、`description?`。

**凭据一律不进配置**：飞书 `FEISHU_APP_ID`/`FEISHU_APP_SECRET`、PushPlus token、GitLab PAT 全走 `ctx.credentials` 的字符串 ref。

---

## 5. 已定位的缺陷（10 条，按优先级）

### ① 租约从不续期 —— 长票会被别的进程抢走（真实并发缺陷）
- `core/store.js:342` 有 `renewLease(key, ttlMs)`，**全仓库只有定义处，内核从不调用**。
- `leaseTtlMinutes` 默认 10 分钟，`ticketTimeoutMinutes` 默认 40 分钟 ⇒ **跑超过 10 分钟的票，租约过期后另一个进程可以 `acquireLease` 抢到同一张票，两个进程同时改同一个 worktree**。
- 架构文档 §6.5（第 468 行）明确写了「续：跑的过程中每 60 秒重复第 1-2 步」—— **文档写了，代码没做**。
- 修法：`runOne` 里起一个心跳定时器，每 60 秒调 `renewLease`，失败即让出这票。

### ② 时钟注入不一致
- `core/store.js:110` 与 `core/scheduler.js:54` 的 `now` 都可注入，但 `core/recover.js:110` 写死 `enqueuedAt: Date.now()`。自测语义与真实时间语义会不一致。

### ③ 死配置三件套 + 并发项
- `provider` / `model` / `maxTokens` 在 executor-agent 落地前无处消费；`concurrency` 与内核「一轮一票」的关系没说清；`logLevel` 没接。
- 修法：要么删掉，要么在配置描述里标注「executor-agent 落地后消费」，别留看起来能用其实不生效的开关。

### ④ `pushplus.callbackUrl` 配不进去
- 代码读得到（`push-pushplus/index.js:169`），schema 不认（`core/config.js` 的 `CONFIG_FIELDS` 没这个键）⇒ 送达回执接不上。
- 修法：`CONFIG_FIELDS` 加 `'pushplus.callbackUrl': { type: 'string', default: '' }`。

### ⑤ 人工中断能力实际不可用
- `core/scheduler.js:478` 的 `cancelActive` 已实现，但**没有任何工具或命令能调到**（全仓库只有定义处）。

### ⑥ 平台可插拔有两处硬编码
- `core/config.js:242` `normalizePlatform` 硬编码 `feishu|wps|mock` ⇒ 新增平台要改内核，不是纯「加个目录」。
- `src/index.js:243` 只给 feishu 注入 `getWatermark/saveWatermark/getSecret/readLocalFile/safePageRun/goneAfterScans` ⇒ **WPS 即使实现了，也拿不到水位持久化，重启后全量重复入队**。
- 修法：组合根改成**按平台能力声明式注入**（每个 source 工厂声明自己需要哪些能力，组合根按声明注入）。

### ⑦ 契约层的死字段与校验缺漏
- 悬空类型：`contracts/ticket-source.js:14` 引用 `ImageMediaType`，该 typedef 不存在。
- `FINGERPRINT_FIELDS` 与 `fingerprintOf` 内部（`types.js:197-204`）**双份硬编码**，改一处必漏。
- 无人消费：`ACTIVE`、`FATAL_KINDS`、`PipelineError.retryAfterMs`（⇒ rate-limit 无退避）、`Plan.risks`、`LocateResult.remote/targetBranch/candidatePaths/ambiguous`、`onExternalChange`（内核从不调用）、`ExecResult.error.retryable`（`scheduler.js:241` 直接丢弃）。
- 契约 ≠ 实现：`ExecCtx` 只声明 5 个字段，`scheduler.js:222-231` 实际多传 `baseCommit/prompt/config`；`worktreePath`/`branch` 声明必填实际可空。
- 校验缺漏：`makeExecResult` 不校验 `error.kind ∈ ERROR_KINDS`，不校验 phase × testOutcome 自洽（`skipped+passed`、`done+failed` 都放行）；`PushReceipt` 无归一（send 返回 undefined 会让 `scheduler.js:375` 读 `receipt.accepted` 抛错）；`makeNotifyMessage` 不校验 level。
- 契约混入平台知识：`contracts/push-adapter.js:56-57` 按**微信 txt 模板**把标题截到 48 字 —— 这条规则该下沉到 `push-pushplus`，否则做邮件适配器时标题会被莫名截断。
- `makeTicket` 静默丢非法 priority（中文「高」会被丢且不入指纹）。

### ⑧ mock 与契约的差距
- `executor-mock`：`mr.iid = 0`（假值）、`url = 'mock://...'`（不是合法 URL）；`changedFiles` 取自 `candidatePaths`，而 `locator-table` 恒给 `[]` ⇒ 永远空；failed 分支给 `kind:'internal' + retryable:false`，与 `RETRYABLE_KINDS`（internal 可重试）自相矛盾。
- `source-mock`：水位只在内存，重启全成新票；扫描只在入口查一次 `signal.aborted`（契约要求分页每页查）；截图返回的 8 字节 PNG 头不是合法 PNG。
- `locator-table`：`candidatePaths` 恒 `[]`、`ambiguous` 恒 `false`、不给 `module`（`scheduler.js:218` 回落 `row.module`）；`locate` 不看 signal。
- `push-mock`：**唯一没调 `assertPushAdapter` 的适配器**（其他适配器都调了，形状校验形同虚设）；失败时抛裸 Error（违 `contracts/errors.js` 的分类要求）。

### ⑨ 文档与代码三处不一致
- §4.1（第 110 行）写 `inject = ['timer','agents','worktrees','storage','credentials','tools','commands']`，实际 `src/index.js:58` 是 `['tools','storageDomain']`（其余服务走 `ctx.get()` 惰性取，缺了优雅降级）。
- §4.2（第 128 行）提到命令 `/pipeline-scan`，**实际没有命令注册**，只有 `pipeline_scan` / `pipeline_status` 两个工具（全仓库 grep `ctx.command` 零命中）。
- §2（第 69 行）架构图里 PushAdapter 标了「企微」，实际只有 pushplus / mock。
- 另：§7.2 的状态机转移表比 `contracts/types.js` 的 `PHASE_TRANSITIONS` 少好几条恢复边，文档应以代码为准补齐。

### ⑩ 运行环境两个硬约束（不是 bug，但决定「能不能真跑」）
- **worktree 落点在 workspace 之外**：`<repo>/.agents/worktrees/`，当前会话 file policy = `workspace-write` ⇒ 会被拒。真跑必须满足：会话 cwd/workspace 就是目标仓库，或 file policy = `danger-full-access`。
- **`failed` 票的 worktree 永不自动清理**（`listExpiredWorktrees` 只清终态非 failed）—— 保留排查线索是对的，但会堆积，需要一个手工清理入口。

---

## 6. 是否需要重构？

### 结论：**不需要推倒重写。需要「补实现 + 修缺陷 + 补文档」。**

**为什么不用重构**
- 内核（`scheduler` / `store` / `config` / ecover`）**没有平台知识**，四层契约完整且自洽，这是最值钱的部分，重构会毁掉它。
- 状态机、租约、指纹、重试、恢复这些**易错的地方都写对了**，而且有 54 项离线自测兜底。
- 架构文档 983 行、13 节，接口契约、状态机、错误决策表、GitLab 坑位都有实测依据。

**建议的动作顺序**

| 阶段 | 内容 | 理由 |
|---|---|---|
| **P0 修缺陷** | ① 补租约心跳（每 60 秒 `renewLease`，失败让出）② `recover.js` 用注入时钟 ③ 补 `pushplus.callbackUrl` 配置键 ④ `cancelActive` 接到工具上 | 这四条是**已经埋着的雷**：长票双写、送达回执接不上、人工中断不可用。改动都小（各 5–20 行） |
| **P1 补可扩展性** | ⑤ 组合根改「平台能力声明式注入」 ⑥ `normalizePlatform` 抽成注册表来源 ⑦ 契约层清理（去死字段、补 `ExecCtx` 真实字段、`makeExecResult` 加自洽校验、标题截断下沉到 pushplus） | 让「新增一个平台」真的等于「加一个目录 + 注册表一行」，这是用户明确要的架构目标 |
| **P2 补主实现** | ⑧ `executor-agent` 真实现（起 agent → followup → whenIdle → 改码 → verify → GitLab Commits API → Draft MR） | 这是需求④⑤的缺口，也是整条链路的最后一块 |
| **P3 补平台与通道** | ⑨ `source-wps`（含 xlsx OOXML 图片解包） ⑩ `push-qqmail`（自写 SMTP） | 按用户的优先级顺序：先 qqmail（成本低），WPS 单独排期（成本高、有前置审批） |
| **P4 补文档** | ⑪ 架构文档加「安全权限边界」独立章节 ⑫ 修 §4.1/§4.2/§2 三处不一致 ⑬ §7.2 状态机与代码对齐 | 安全边界是用户明确点名要的，现在散落在 §12 各处 |

**必须先验证才能声称「跑通了」**（架构文档 §12.1 已写明）：用 mock 适配器跑通 ≠ 真实链路跑通。真跑要解决 worktree 落 workspace 之外的问题。

---

## 7. 安全与权限边界（当前的实际状态）

**已经落实的**
- 工单表**只读**，绝不回写「是否处理 / 处理人 / 处理结果 / 处理日期」—— 表格是触发器，流水线状态只存在插件自己的存储里。
- 凭据**不进配置文件**，全走 `ctx.credentials` 的字符串 ref；配置展示时 `describeConfig` 对 `token|secret|password` 和 `match.appToken` 打码。
- **只开 draft MR，绝不自动合并** —— 人验收后自己合。
- 执行器不得改 worktree 之外的文件、不得提交含真实凭据的配置文件、不得动 CI。
- `git` 调用统一带 `-c core.hooksPath=/dev/null -c core.fsmonitor=false`、`GIT_TERMINAL_PROMPT=0`（防交互挂死）。
- 飞书截图的 `url` 形态走裸 `fetch`，**不带凭据**。
- 飞书用 `tenant_access_token`，**插件没法给自己加权限**，文档级授权必须人工做（已写进 §12.8）。

**还没落实的**
- 架构文档**没有集中的权限边界章节**，安全内容散在 §1 / §4 / §5 / §12。
- **凭据引用清单**缺失：哪些 ref 是必须的、每个 ref 归哪个适配器用，没有一张表。
- `pushplus.callbackUrl` 配不进去 ⇒ 送达回执（谁真的收到了）无审计。
- `enabled` 默认 `false`，但没有说明「打开前必须先做完哪几项前置」的操作清单。

---

## 8. 下一步的三种走法

**A. 先把链路跑通（推荐）**
先做 P0 + P1 + P2（executor-agent），用**飞书 + 一个真项目**跑通「工单 → 改码 → 测试 → draft MR → 微信通知」。金山文档和 QQ 邮箱随后。

**B. 先补齐用户点名的两个缺口**
先做 P3 的 qqmail（成本最低、用户明确点了名），再做 P2。

**C. 先补文档与边界**
先做 P4，把架构文档、权限边界、配置清单补齐，让后面开发有据可依。

> 无论走哪条，P0 的四条都建议先做 —— 它们是**已经在跑的系统里的雷**，不是新功能的成本。

---

## 附：证据索引

| 结论 | 可复查位置 |
|---|---|
| 飞书适配器真实实现 | `plugins/ticket-pipeline/src/adapters/source-feishu/index.js`（798 行） |
| WPS 占位 | `plugins/ticket-pipeline/src/adapters/source-wps/index.js:24-37` |
| executor-agent 占位 | `plugins/ticket-pipeline/src/adapters/executor-agent/index.js:44,60-63` |
| 租约不续期 | `src/core/store.js:342`（定义）vs `src/core/scheduler.js`（零调用） |
| 时钟硬编码 | `src/core/recover.js:110` |
| 死配置 | `src/core/config.js:99,155,160,165,207` |
| callbackUrl 缺失 | `src/adapters/push-pushplus/index.js:169` vs `src/core/config.js:76-213` |
| 平台硬编码 | `src/core/config.js:242`、`src/index.js:243` |
| 文档不一致 | `docs/ticket-pipeline/architecture.md:110,128,69` |
| 离线自测 54 项 | `plugins/ticket-pipeline/scripts/dev-run.mjs`（`node scripts/dev-run.mjs`） |
| 设计文档 | `docs/ticket-pipeline/architecture.md`（983 行 / 13 节） |
