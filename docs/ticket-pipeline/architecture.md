# 工单流水线插件 · 架构设计

> 状态：设计定稿（对应地图票 #10）；§12A 安全与权限边界按 2026-11-04 的代码状态补写
> 日期：2026-11-03（§4 / §7.2 / §12A 于 2026-11-04 按实现回填）
> 决策来源：地图 `00` 的 Decisions、票 `01` / `03` / `05` / `08` 的 Resolution、`.scratch/ticket-pipeline/research/` 下四份调研报告
> 语言约定：本文与全部代码注释、提交信息、通知文案一律用中文；代码标识符保持英文。

---

## 目录

1. [这份文档是什么](#1-这份文档是什么)
2. [一句话架构](#2-一句话架构)
3. [依赖方向](#3-依赖方向)
4. [运行边界](#4-运行边界)
5. [四层接口契约](#5-四层接口契约)
6. [数据契约](#6-数据契约)
7. [phase 状态机](#7-phase-状态机)
8. [错误分类与重试](#8-错误分类与重试)
9. [`Config` 全量](#9-config-全量)
10. [可替换点（文件级）](#10-可替换点文件级)
11. [一次完整跑的时序](#11-一次完整跑的时序)
12. [已知约束与未决](#12-已知约束与未决)
12A. [安全与权限边界](#12a-安全与权限边界)
13. [事实来源](#13-事实来源)

---

## 1. 这份文档是什么

**是**：四层接口的完整契约、依赖方向、状态机、数据形状、错误分类、配置项，以及「换一个平台时要改哪几个文件」的判定标准。照着这份文档能直接开始写代码，两个不同的人写出来的适配器能拼在一起。

**不是**：

- 不是某张具体工单怎么改的说明（那是运行时的事，由 agent 现场判断）
- 不是飞书 API 的字段手册（见票 `01` 的 Resolution 与 `research/` 下的记录）
- 不是 GitLab 调用序列手册（见票 `04` 与 `research/gitlab-mr.md`）
- 不是用户手册（见票 `11` 的产物）

**设计的核心约束**（全部来自用户拍板，改动前先回去看地图）：

| 约束 | 内容 | 出处 |
|---|---|---|
| 运行形态 | DSH Host 插件常驻，不写独立守护进程 | 地图 Notes |
| 工单表 | **只读**，绝不回写任何列 | 地图 Decisions（用户 2026-11-03） |
| 收票信号 | `是否处理 = 处理中`（下拉三值是 / 否 / 处理中） | 地图 Decisions |
| 代码仓库 | 项目清单维护在 `projects[]` 配置，每项目一个仓库 | 地图 Decisions |
| MR | 只开 draft，绝不自动合并；基准/目标分支由项目 `repo.baseBranch`/`repo.targetBranch` 决定 | 票 `04` + 用户拍板 |
| 通知 | `PushAdapter` 可替换，默认 PushPlus `channel=clawbot` | 票 `07` |
| 并发 | 串行，并发恒为 1 | 票 `08` |
| 超时 | 超时只报给人，**不自动重试** | 票 `08` |

---

## 2. 一句话架构

**四层可替换适配器 + 一个什么都不实现的内核。**

```
                    ┌──────────────────────────────────────┐
                    │  内核 Core（不认识任何平台）          │
                    │  Scheduler · TicketStore · Config     │
                    └───┬──────────┬──────────┬────────┬────┘
                        │          │          │        │
              ┌─────────▼──┐ ┌─────▼─────┐ ┌──▼─────┐ ┌▼──────────┐
              │TicketSource│ │RepoLocator│ │WorkExec│ │PushAdapter│
              └─────┬──────┘ └─────┬─────┘ └──┬─────┘ └┬──────────┘
                    │              │          │        │
              飞书 / WPS         projects[]   agent    PushPlus
              / mock             查表         + MR      / mock
```

内核**四个接口都要用，一个都不实现**。它不知道飞书长什么样、不知道 GitLab 的 URL 怎么拼、不知道该改哪个文件。它只知道：拿到票 → 建工作区 → 让执行器干活 → 把结果推出去 → 记住进度。

---

## 3. 依赖方向

```
        ┌──────────────┐
        │     core     │  ← 可以 import contracts
        └──────┬───────┘
               │ import（只 import 类型与错误类）
        ┌──────▼───────┐
        │  contracts   │  ← 不 import 任何东西（除标准库类型）
        └──────▲───────┘
               │ implement
        ┌──────┴───────┐
        │   adapters   │  ← 可以 import contracts；**禁止互相 import**
        └──────────────┘
```

**三条硬规则**：

1. **`contracts/` 不 import 任何业务代码**。它只有 `interface`、`type`、错误类。这样任何适配器实现都能引用它而不引入依赖。
2. **`adapters/` 之间零 import**。`locator-table` 不许 import `source-feishu`。需要数据由内核以参数传入。
3. **`core/` 不认识任何具体适配器**。它只认接口，具体实现由 `index.js` 的注册表注入。

**唯一例外**：`src/index.js`（注册表）同时 import 内核与所有适配器 —— 它是组合根，唯一允许知道「具体有哪些实现」的地方。

---

## 4. 运行边界

### 4.1 谁在跑

一个 DSH Host 插件（Cordis 插件），随 Harness 进程常驻。`apply(ctx, config)` 里：

```js
export const name = 'ticket-pipeline'
// 硬依赖只有两个：没有 tools 和 storageDomain，插件本身就没有意义。
export const inject = ['tools', 'storageDomain']

export async function apply (ctx, config) {
  // 1. 持久化：ctx.storageDomain.open(...) → TicketStore
  // 2. 适配器：projects[] → sources[]、locator、executor、push
  // 3. 内核：createScheduler({ store, sources, locator, executor, push, ... })
  // 4. 注册四个工具：pipeline_scan / pipeline_status / pipeline_cancel / pipeline_reset
  // 5. 启动恢复：recoverPending()，把跑到一半的票从当前 phase 接着走
  // 6. 注册 ctx.interval 轮询（enabled 关着时 tick 直接返回 disabled）
}
```

所有注册都用 `ctx.effect()` / 返回 disposer 的形式 —— 插件卸载时定时器、监听器、agent 句柄一起收干净。

**`inject` 为什么只有两个**（见 [`src/index.js:61`](../../plugins/ticket-pipeline/src/index.js)）：

| 宿主服务 | 取法 | 为什么 |
|---|---|---|
| `tools` | `inject` | 注册四个工具，缺了插件没有入口 |
| `storageDomain` | `inject` | 票据 / 水位 / 租约三张表都在这上面 |
| `subprocess` | `ctx.get('subprocess')` | 只有「要跑 git」时才需要；取不到就跳过建工作区、不挂清理 |
| `credentials` | `ctx.get('credentials')` | 凭据可能还没配，缺了应该让飞书那一路报 `auth`，不该让整个插件挂载失败 |
| `fs` | `ctx.get('fs')` | 只有路径形态的截图要读本地字节 |
| `attachments` | `ctx.get('attachments')` | 离线自测没有附件库，`saveImage` 要能降级成 `undefined` |

惰性取的共同理由：这几个服务「缺了也要能装得上」，否则一个平台的环境问题会连带把其它平台拖死。代价是缺服务时只在运行期暴露 —— 所以每个 `ctx.get()` 都写了降级分支，并用日志说清降级到了哪一步。

### 4.2 什么时候跑

| 触发 | 方式 | 说明 |
|---|---|---|
| 定时扫描 | `ctx.interval(() => tick(), Config.pollIntervalMinutes * 60_000)` | **唯一默认入口**，默认 3 分钟 |
| 手动扫描 | 工具 `pipeline_scan` | 直接调 `tick()`，返回本轮结论 |
| 启动恢复 | `apply` 末尾扫一遍 `TicketStore` | 未到终态的票从当前 phase 接着走 |
| 外部事件 | 适配器可选 `onExternalChange()` | 不支持就不实现，内核只轮询 |

**不用 `ctx.schedule`**：它是「持久提醒」，绑会话、靠往会话追加 follow-up 投递；本插件要的是进程内的周期任务，`ctx.interval` 才是对的工具（`ctx.timer` 服务存在，但混入后的 `ctx.interval`/`ctx.timeout` 才是常用调用形态，两者等价）。

### 4.3 单飞

```js
let running = false

async function tick () {
  if (running) return { skipped: 'already-running' }
  running = true
  try {
    const scan = await scanAndEnqueue()
    const ran = await drainOne()        // 一轮最多跑一票
    await cleanupExpiredWorktrees()     // 一轮最多清一个
    return { scan, ran }
  } finally {
    running = false
  }
}
```

**两层防重入**：

- 内存布尔 `running` —— 防同进程内定时器重入
- 存储层租约 —— 防多个 Harness 窗口抢同一张票（见 §6.5）

**四个工具**（都注册在 `apply` 里，见 [`src/index.js`](../../plugins/ticket-pipeline/src/index.js)）：

| 工具 | 作用 | 关键边界 |
|---|---|---|
| `pipeline_scan` | 立刻推一轮 | 不绕过单飞，正在跑时返回 `already-running`；不动 `enabled` |
| `pipeline_status` | 只读查队列与历史 | 不改任何状态 |
| `pipeline_cancel` | 取消当前在跑的那一票 | 落 `failed` + `lastError='cancelled by user'`，**不通知**，工作区保留；空闲时返回 `cancelled:false` |
| `pipeline_reset` | 人工重开一张卡住的票 | 只对 `failed` / `needs-info` / `gone` 生效；同名 recordId 冲突时要求补 `projectId`，不猜 |

`pipeline_reset` 与「把表格里『是否处理』拨走再拨回『处理中』」是**同一个底层动作**（`store.resetByHuman`），区别只在于一个在表格里做、一个在插件里做。

---

## 5. 四层接口契约

以下全部是 `contracts/` 下的定义。**每条注释都是契约的一部分，实现时必须满足**。

### 5.1 公共类型

```ts
/** 所有适配器抛错时的错误分类。内核只按 kind 决策，不解析 message。 */
export type ErrorKind =
  | 'auth'          // 凭据失效 / 无权限 —— 不可重试，通知人
  | 'network'       // 网络 / 超时 —— 可重试
  | 'rate-limit'    // 429 —— 可重试，带退避
  | 'not-found'     // 资源不存在（分支 / 记录 / 文件）—— 不可重试
  | 'invalid-input' // 数据形态不对（如下拉字段形状变体未覆盖）—— 不可重试，通知人
  | 'aborted'       // 被 AbortSignal 取消 —— 不算失败
  | 'internal'      // 其它 bug —— 可重试一次，再失败标 failed

/**
 * 适配器必须抛这个，不许抛裸 Error('出错了')。
 * 理由：内核要按 kind 决定「重试 / 通知 / 跳过」，字符串匹配不可靠且国际化后更不可靠。
 */
export class PipelineError extends Error {
  constructor (
    readonly kind: ErrorKind,
    message: string,
    readonly cause?: unknown,
    readonly retryAfterMs?: number,   // kind='rate-limit' 时服务端给的等待时间
  ) { super(message) }
}
```

### 5.2 `TicketSource` — 工单从哪来

```ts
export interface TicketSource {
  /** 稳定标识：'feishu' | 'wps' | 'xlsx' | 'mock'。用于存储分区与日志前缀。 */
  readonly id: string

  /**
   * 扫描一轮，返回与上次相比的变化。
   *
   * 契约：
   * - 表只读：本方法**不得**写任何远端状态。
   * - 抛错 = 本轮扫描失败。不要返回空数组假装成功 —— 内核要区分「没变化」与「扫失败了」。
   * - `signal.aborted` 时必须尽快抛 AbortError，不能吞掉继续跑完。分页循环里每页检查一次。
   * - 适配器自己维护「见过什么」的水位；内核不参与比对。
   */
  scan (signal: AbortSignal): Promise<ScanResult>

  /**
   * 把任意形态的截图引用取成字节。
   *
   * 契约：
   * - 只负责**拿字节**，不负责 saveImage / ImageBlock / 消息构造 —— 那是内核的事。
   * - 取不到抛 PipelineError（kind 按原因：'not-found' 文件没了 / 'network' 下载失败 /
   *   'auth' 无权限 / 'invalid-input' 形态不认识）。
   * - 返回的 mediaType 必须落在 png/jpeg/webp/gif 四者之内（DSH 附件层只收这四种）。
   */
  loadScreenshot (
    ref: ScreenshotRef,
    signal: AbortSignal,
  ): Promise<{ data: Uint8Array; mediaType: ImageMediaType; name?: string }>

  /**
   * 可选：外部变更事件。不支持就不实现（内核只轮询）。
   * 实现时必须自己处理退订，返回释放函数。
   * 回调里的 recordIds 只是**提示**，内核不会因此跳过轮询 —— 事件可能丢、可能重复。
   */
  onExternalChange? (cb: (hint: { recordIds?: string[] }) => void): () => void
}

export type ScanResult = {
  /** 首次出现的行（无论 mtime 多早）。内核动作：入队。 */
  created: Ticket[]
  /** 见过且内容指纹变了。内核动作：revisionCount++，排到队尾，**不打断当前运行**。 */
  updated: Ticket[]
  /** 连续 Config.goneAfterScans 轮没扫到的 recordId。内核动作：退役。 */
  disappeared: string[]
}
```

**为什么分开返回三类**：内核要做的动作完全不同（入队 / 修订排队尾 / 退役并释放租约）。合成一个数组内核还得自己 diff 两遍，而适配器**本来就在比对 `seen` 表**，顺手分类几乎零成本。

**为什么 `loadScreenshot` 在适配器而不是内核**：飞书要拿 `file_token` 调 media 接口、本地路径要读文件、URL 要下载 —— 每种平台的取法完全不同。内核统一做 `saveImage` 就够了。

### 5.3 `RepoLocator` — 工单项目到仓库

通用化后，`RepoLocator` 退化成**查表**：按 `ticket.projectId` 在 `projects[]` 里找到
对应条目，返回它的仓库信息。**不做任何「模块 → 代码路径」的推断**——那一部分
交给 `executor-agent` 现场读仓库自己定位。

```ts
export interface RepoLocator {
  readonly id: string

  /**
   * 把工单的 projectId 映射到它所属项目的仓库与分支。
   *
   * 契约：
   * - 纯查表，不做 IO 到目标仓库之外、不建 worktree、不改任何文件。
   * - `ticket.projectId` 缺失或查不到时抛 PipelineError('invalid-input')。
   * - 不猜代码路径：`candidatePaths` 恒为空、`ambiguous` 恒 false。
   */
  locate (ticket: Ticket, signal: AbortSignal): Promise<LocateResult>
}

export type LocateResult = {
  repoPath: string          // 绝对路径（来自 project.repo.path）
  remote?: string           // GitLab remote URL（来自 project.repo.remote）
  baseBranch?: string       // 切 worktree 的基准分支（来自 project.repo.baseBranch）
  targetBranch?: string     // draft MR 目标分支（来自 project.repo.targetBranch）
  candidatePaths: string[]  // 恒为空：代码定位交给 executor-agent 现场读仓库
  ambiguous: boolean        // 恒 false：这里不猜代码路径
  notes?: string            // 项目 description，原样进 prompt
}
```

**为什么退化成查表而不是删掉这一层**：工单属于哪个项目是**表级**决定的（飞书知识树
里每个项目一张自己的工单表），这个绑定关系必须有一处统一、可单测的代码来表达；
「工单对应哪个仓库」是流水线的第一跳，放查表里比散在各处可靠。**「该改哪个文件」
则不属于这一层**——那需要读代码、看工单描述，是 agent 现场定位的事。

### 5.4 `WorkExecutor` — 怎么改代码、怎么验证、怎么开 MR

```ts
export interface WorkExecutor {
  readonly id: string

  /**
   * 执行一票。内部按阶段推进，每进入一个阶段调 onPhase 落库（崩溃恢复用）。
   *
   * 契约：
   * - 必须尊重 signal：aborted 时停手、保留 worktree、抛 PipelineError('aborted')。
   * - 每进入新阶段必须 await onPhase(...)，不能只在自己的内存里更新 —— 那是崩溃恢复的唯一依据。
   * - 不改 worktree 之外的文件；不 push（沙箱封死，见 §12）。
   * - 返回前必须已经开完 MR（或在 error 里说明为什么没开）。
   */
  run (ticket: Ticket, target: LocateResult, ctx: ExecCtx): Promise<ExecResult>
}

export type ExecCtx = {
  signal: AbortSignal
  worktreePath: string                     // 已建好的隔离工作区绝对路径
  branch: string                           // 已创建的分支名
  onPhase (phase: Phase, detail?: string): Promise<void>
  log (msg: string): void                  // 写进插件日志，带 recordId 前缀
}

export type ExecResult = {
  phase: Phase                             // 终态：done / skipped / failed
  plan?: Plan                              // 执行器产出的方案（进 MR 描述）
  changedFiles: string[]
  testOutcome: 'passed' | 'failed' | 'skipped'
  testDetail?: string                      // skipped 时必须写原因
  mr?: { iid: number; url: string; draft: boolean }
  error?: { kind: ErrorKind; message: string; retryable: boolean }
}
```

**`testOutcome: 'skipped'` 是合法成功路径**：环境起不来（比如 MySQL 连不上、端口被占）就记 skipped 仍然开 draft MR，但**必须把原因写进 MR 描述**，不能默默略过 —— 人看到 draft MR 才知道「这个改动没被真跑过」。

### 5.5 `PushAdapter` — 消息怎么送出去

```ts
export interface PushAdapter {
  readonly id: string

  /**
   * 发一条通知。
   *
   * ⚠️ 契约里最重要的一条：`accepted` 只代表「服务端受理」，**不代表送达**。
   * PushPlus 的 code:200 只是收了请求，真送达要看 callbackUrl 里的 sendStatus
   * （0 未发 / 1 发送中 / 2 成功 / 3 失败）。内核不得把 accepted:true 当成
   * 「人已经知道了」，更不得据此决定跳过重试。
   */
  send (msg: NotifyMessage, signal: AbortSignal): Promise<PushReceipt>
}

export type NotifyMessage = {
  title: string                  // 短，能在一行里看完
  body: string                   // Markdown
  link?: string                  // 通常是 MR URL
  level: 'info' | 'warn' | 'error'
}

export type PushReceipt = {
  accepted: boolean
  traceId?: string               // PushPlus 的流水号，用于查 callback / 人工追查
}
```

**为什么只有 `send` 一个方法**：通知是单向的。人在微信里回复「这个不对」属于**双向通道**，明确在 `## Out of scope` 之外（见地图 `Not yet specified`）。

---

## 6. 数据契约

### 6.1 `Ticket`

内核只读，由 `TicketSource` 构造。

```ts
export type Ticket = {
  recordId: string           // 平台侧稳定标识（飞书 = recXXXXXXXX）。**平台内唯一**，跨项目靠 projectId 复合
  projectId: string          // 所属项目（对应 projects[].name），复合主键的一半
  fingerprint: string        // 内容指纹（见 §6.2）。变 = 新修订
  revisionCount: number      // 第几次修订，从 1 开始
  seq?: string               // 「序号」列，仅用于显示，**绝不用于身份**
  department?: string        // 发现部门
  description: string        // 问题描述（必需，空则票无效）
  foundAt?: string           // 发现日期（ISO 日期串，不带时区）
  module?: string            // 模块（平台原值，不参与定位，仅进指纹与 prompt）
  flow?: string              // 操作流程
  screenshots: ScreenshotRef[]
  priority?: 'high' | 'medium' | 'low'
  status?: string            // 「是否处理」的原值，仅用于日志
  raw: unknown               // 平台原始 record，调试用，**内核不解释**
}
```

**`seq` 为什么不能当身份**：那一列是人手填的，会重排、会重复、前两行还是示例行。用 `record_id` 才能抵抗插行删行。

### 6.2 内容指纹

```ts
fingerprint = sha256(
  问题描述 ‖ 模块 ‖ 操作流程 ‖ 截图 ref 规范化串 ‖ 优先级 ‖ 发现部门
).slice(0, 16)
```

**刻意不包含**：`是否处理`、`处理人`、`处理结果`、`处理日期`。

理由：这四个字段是**人管理这条工单的过程**，不是**工单内容**。把它们算进指纹，人每改一次「处理人」就触发一次「修订」，流水线会被无意义的改动反复打断。

**截图 ref 规范化串**必须可复现：`attachment:fileToken` / `path:规范化后的绝对路径` / `url:规范化后的 URL` / `unknown:原文`，多个用 `|` 连接，顺序按 ref 在表格里的出现顺序。

### 6.3 `ScreenshotRef`

```ts
export type ScreenshotRef =
  | { kind: 'attachment'; fileToken: string; name?: string; size?: number }
  | { kind: 'path'; path: string }          // 共享路径（UNC / 本地绝对路径）
  | { kind: 'url'; url: string }            // http(s) 链接
  | { kind: 'unknown'; raw: string }        // 认不出的形态，保留原文供人工排查
```

工单表的「截图」列有两形态（粘贴图片到单元格 / 填共享路径或链接），所以必须有 `path` 与 `url`。`unknown` 兜底：认不出就把原文留着，让 `loadScreenshot` 抛 `invalid-input` → 标 `needs-info` 通知人，而不是整票失败。

### 6.4 `Plan`

执行器在 `planning` 阶段产出，存进 `TicketStore`，最终进 MR 描述。

```ts
export type Plan = {
  summary: string          // 一句话：打算改什么
  targetPaths: string[]    // 计划改哪些文件（相对 repoPath）
  approach: string         // 怎么做（Markdown，可以有几段）
  risks?: string           // 你担心的点 / 不确定的地方
}
```

`risks` 不是装饰。人审 draft MR 时最想知道的就是「AI 自己觉得哪里可能不对」。

### 6.5 存储形状（`TicketStore`）

用 `ctx.storageDomain` + `defineDomain`，三个表：

```ts
type TicketRecordRow = {
  key: string                          // 主键 = ticketKey(projectId, recordId)
  projectId: string                    // 所属项目
  recordId: string                     // 平台原值（显示用）
  fingerprint: string
  revisionCount: number
  phase: Phase
  worktreePath?: string
  branch?: string
  baseCommit?: string
  plan?: Plan
  changedFiles?: string[]
  testOutcome?: 'passed' | 'failed' | 'skipped'
  mr?: { iid: number; url: string; draft: boolean }
  attempt: number                      // 失败重试计数
  startedAt?: number                   // epoch ms
  finishedAt?: number
  lastError?: string
  lastScanAt?: number
}

type WatermarkRow = {
  sourceId: string                     // 主键（每个适配器一行）
  seen: Record<string, { mtime: number; fingerprint: string; missingScans: number }>
  lastScanAt: number
}

type LeaseRow = {
  key: string                          // 主键（= ticketKey）
  ownerToken: string                   // 本进程的随机 token
  leaseExpiresAt: number               // epoch ms
}
```

**为什么用存储而不是内存**：进程重启后要能从 phase 接着走。这是 #05 定的恢复策略的全部依据。

**租约协议**（不用文件锁，因为跨平台 + 沙箱下文件锁不可靠）：

1. 抢：读 `LeaseRow` → 不存在或 `leaseExpiresAt < now` → 写入自己 `ownerToken` + `now + ttl`
2. **写完立刻回读**：读到的 `ownerToken` 还是自己的 → 抢到；不是 → 退让，本轮跳过这票
3. 续：跑的过程中每 60 秒重复第 1-2 步
4. 放：进终态立刻删 `LeaseRow`

TTL 10 分钟、续租 60 秒 —— 留足余量，单次存储操作不可能超过 10 分钟。

---

## 7. phase 状态机

### 7.1 枚举

```ts
export type Phase =
  | 'pending'         // 已入队，未开工
  | 'worktree-ready'  // 隔离工作区已建好
  | 'planning'        // agent 正在定位与规划
  | 'editing'         // agent 正在改代码
  | 'testing'         // agent 正在构建 / 单测 / 起后端验证
  | 'mr-opening'      // 正在开 draft MR
  | 'needs-info'      // 等人补信息（截图取不到），补上后回 pending
  | 'done'            // 终态：成功
  | 'skipped'         // 终态：MR 开了但测试没跑成
  | 'failed'          // 终态：失败
  | 'gone'            // 终态：表格里这行消失了

export const TERMINAL: Phase[] = ['done', 'skipped', 'failed', 'gone']
```

### 7.2 转移表

**以代码为准**：[`PHASE_TRANSITIONS`](../../plugins/ticket-pipeline/src/contracts/types.js)（`src/contracts/types.js` 第 57–71 行）。
下表逐格抄自它；`TicketStore.setPhase` 拿它当闸门 —— 表外的转移一律拒绝并记日志（`store.js` 的 `setPhase`）。

**先看入口**。状态机的输入是 `scan()` 的三类结果（§5.2）：

- `scan.created` → `pending`：落库、入队尾、写 `WatermarkRow`。
- `scan.updated`（指纹变）→ `pending`：`revisionCount++`、移队尾、**不打断当前运行**。
  若该票已在 `done` / `skipped` / `gone`，走的是**复活**（直接入队回 `pending`、`attempt = 0`），不是表里的边。
- `scan.disappeared`（连续 `goneAfterScans` 轮没扫到）→ `gone`：静默退役、不通知。

**转移表**（左列 = 从哪来，中列 = 表里允许的去处，含自环）：

| 从 | 允许到 | 谁触发 | 副作用 |
|---|---|---|---|
| `pending` | `pending` · `worktree-ready` · `needs-info` · `gone` · `failed` | 修订打点 / 建工作区 / 截图取不到 / 行被删 / 早期失败 | 见下三行 |
| `pending` | `worktree-ready` | `prepareWorkspace` 成功（未注入它时也会推进） | 回填并记 `worktreePath`/`branch`/`baseCommit` |
| `pending` | `needs-info` | `loadScreenshot` 抛错 | 通知人补图、释放租约、**不标 failed** |
| `pending` | `gone` | 连续 `goneAfterScans` 轮没扫到 | 静默退役、释放租约 |
| `needs-info` | `pending` · `gone` · `failed` | 人在表格里改了内容 / 行被删 / 人工重开后重跑失败 | 指纹变才回到队里，否则继续等人 |
| `worktree-ready` | `worktree-ready` · `planning` · `pending` · `failed` | 重打点 / 开工 / 工作区丢了回队列 / 失败 | 开工时起超时定时器、`startedAt = now` |
| `planning` | `planning` · `editing` · `worktree-ready` · `pending` · `failed` | agent 报「定位完成」/ 要重建工作区 / 可重试错误回队 / 失败 | 存 `Plan` |
| `editing` | `editing` · `testing` · `planning` · `worktree-ready` · `pending` · `failed` | agent 报「改完了」/ 验证不通过退回重做 | 存 `changedFiles` |
| `testing` | `testing` · `mr-opening` · `done` · `skipped` · `planning` · `worktree-ready` · `pending` · `failed` | 构建/测试有结论；或退回重做 | 存 `testOutcome`、`testDetail` |
| `mr-opening` | `mr-opening` · `done` · `skipped` · `planning` · `worktree-ready` · `pending` · `failed` | MR 开成功 / 开之前发现问题退回 | 存 `mr`、发通知、释放租约、清超时定时器 |
| `done` | `done` | 幂等重打点 | 不改任何东西；**终态一旦落下就不再退回**（要重跑只能靠复活） |
| `skipped` | `skipped` | 同上 | 同上 |
| `failed` | `failed` · `pending` | 幂等重打点 / **人工重开** | 人工重开：`attempt = 0`、清 `lastError`、回队首 |
| `gone` | `gone` | 幂等重打点 | 行真回来了走「复活」，不是这条边 |

**两类恢复边**——这张表比「一条直线」宽的原因（注释在 `types.js` 里）：

1. **自环**（`X → X`）：恢复时把票留在原地再打一次点，语义不变。
2. **回退到 `worktree-ready` / `planning`**：工作区丢了要重建，或上一轮改到一半要重做。
   没有这两类边，坏数据恢复会被静默拒绝，票会永远卡在中间态。

**「任意非终态 → `failed`」在代码里并不是一条通配边**：`failed` 之所以能从每个中间态到达，是因为上表每个中间态那一行都列了 `failed`。
超时 / 不可重试错误（`auth`/`not-found`/`invalid-input`）/ 可重试错误且 `attempt ≥ maxAttempts` 这三种情况都落到 `failed`，
差别在副作用：**保留 worktree**、发通知、释放租约；超时还要先 `agent.cancel()`。
而可重试错误且 `attempt < maxAttempts` 走的是**回 `pending`**（`attempt++`、回队首、同样保留 worktree）。

**回退路径**（`recover.js`，§7.6）：`worktreePath` 不在时优先退到 `worktree-ready`；
若当前 phase 不允许（实际不会发生，上表每个中间态都允许），再退一步回 `pending` 并清掉工作区坐标。

**人工重开有两个入口、同一个动作**（`store.resetByHuman`）：表格里「是否处理」由非处理中 → 处理中，
或直接调 `pipeline_reset` 工具（§4.3）。

### 7.3 非法转移（实现时必须拒绝并记日志）

- `done` → 任何非 `done`：终态不可退回。表格说 `是` 就是 `是`，哪怕插件自己判过 `failed`。
- `gone` → `pending`：行都没了。若同名 `record_id` 又出现（不可能，但兜底），那是 `scan.created`，走 `— → pending`。
- `pending` → `planning`：必须经过 `worktree-ready`，没有工作区不能开工。
- 任何转移在 `signal.aborted` 后：只允许转 `failed`。

### 7.4 超时

```js
const t = ctx.timeout(() => controller.abort(new Error('ticket-timeout')),
                       Config.ticketTimeoutMinutes * 60_000)
```

触发后：

1. `agent.cancel()` —— 让 agent 停手
2. `onPhase('failed', '超时 N 分钟')`
3. 通知（`level: 'warn'`，正文写明超时分钟数与 worktree 绝对路径）
4. **保留 worktree**（排查线索）
5. **不自动重试**（用户拍板）

同一 `recordId` 下一轮扫描见 `phase = failed` → **直接跳过**，不再入队。

**唯一的重开路径**是人工重置：人把表格里「是否处理」从别的值拨回 `处理中`。内核据此把 `attempt` 归零、回到队列。这条路径的存在让「不自动重试」不会变成死局。

### 7.5 人工中断

用户点取消 → `agent.cancel()` → `turn/end` 的 `reason.kind === 'aborted'`：

- 标 `phase = failed`，`lastError = 'cancelled by user'`
- **不发通知**（人自己取消的，不需要再告诉他）
- 保留 worktree

### 7.6 进程重启恢复

`apply()` 末尾：

1. 读 `TicketRecordRow` 里 `phase ∉ TERMINAL` 的全部记录
2. 对每条：
   - `worktreePath` 存在且 `git -C <path> rev-parse --is-inside-work-tree` 通过 → 从当前 phase 接着走
   - `worktreePath` 不存在 → 重新 `worktrees.create`，phase 回退到 `worktree-ready`（不可复用脏状态）
   - 分支已被删 / 已被改 → 重建，不重用
3. **不从头重跑**：已经改过的文件不重改，已经开过的 MR 不重开（先查 `merge_requests?source_branch=X&state=opened`）

---

## 8. 错误分类与重试

### 8.1 决策表

| `ErrorKind` | 可重试 | 重试次数 | 通知 | 通知文案要点 |
|---|---|---|---|---|
| `auth` | 否 | 0 | 是（`error`） | 哪一层的凭据失效 + 去哪里重新配置 |
| `network` | 是 | `maxAttempts` | 达到上限才发 | 网络不通，已重试 N 次 |
| `rate-limit` | 是 | `maxAttempts` | 达到上限才发 | 被限流，`retryAfterMs` 后重试 |
| `not-found` | 否 | 0 | 是（`error`） | 哪个资源没了（分支 / record / 文件） |
| `invalid-input` | 否 | 0 | 是（`warn`） | 数据形态没覆盖 + 原文样本，请人补充 |
| `aborted` | — | — | 否 | （人自己取消的） |
| `internal` | 是 | 1 | 达到上限才发 | 内部错误 + message |

### 8.2 降级而非失败

以下情况**不标 failed**，走专门的状态：

| 情况 | 处理 |
|---|---|
| 截图取不到 | `needs-info` + 通知人补图；票留在队列，不阻塞后面的票 |
| 测试环境起不来 | `testOutcome = 'skipped'`，仍开 draft MR，原因写进 MR 描述 |
| `RepoLocator` 标了 `ambiguous` | 照常跑，prompt 里列候选并要求定不了就问人 |
| 目标仓库读不到 | `network` 处理，重试到上限 |
| 单据内容为空（`description` 空） | 直接 `invalid-input` → `failed` + 通知（这票没法做） |

### 8.3 通知文案模板

```
[工单流水线] {状态短语}：{problemSummary}

工单：{seq} · {department} · {module}
状态：{phase 中文}
{额外一行：MR 链接 / 超时分钟数 / 失败原因 / 需要你做什么}

分支：{branch}
工作区：{worktreePath}
```

`level` 约定：`info` = done/skipped，`warn` = 超时 / needs-info / 需人介入，`error` = failed。

---

## 9. `Config` 全量

用 `export const Config`（standard-schema 形状，见 `src/core/config.js`，不是 schemastery）。
值存在 profile 的 `cordis.patch.yml` 里本插件那一行，升级不丢。字段清单与默认值
以 `src/core/config.js` 的 `CONFIG_FIELDS` 为准，下面是概览：

```ts
export const Config = {
  // ── 项目清单（核心，通用化的根）─────────────────────
  projects: Array<{
    name: string               // 项目唯一标识 = ticket.projectId
    description?: string       // 项目描述，进 agent 定位提示
    match: {                   // 工单表怎么定位（表级绑定）
      platform: 'feishu' | 'wps' | 'mock'
      appToken?: string        // 飞书多维表格 app_token（显式绑定）
      tableId?: string         // 飞书数据表 id（与 appToken 一起用）
      viewId?: string          // 可选：只扫某个视图
      docNamePattern?: string  // 文件名模糊匹配（无显式绑定时的兜底）
    },
    repo: {
      path: string             // 本地 git 检出根目录（必填）
      remote?: string          // GitLab remote URL（开 MR 用）
      baseBranch?: string      // 切 worktree 的基准分支（不填则自动识别：origin/HEAD → 当前分支 → main）
      targetBranch?: string    // draft MR 目标分支（默认同 baseBranch）
    },
    verify?: {
      build?: string           // 构建命令（如 npm run build），空串跳过
      test?: string            // 测试命令（如 mvn -o test），空串跳过
    },
  }>,

  // ── 扫描与队列 ──────────────────────────────────────
  pollIntervalMinutes: number,   // 默认 3，1..60
  safePageRun: number,           // 默认 20，5..100
  goneAfterScans: number,        // 默认 3，1..20
  concurrency: number,           // 默认 1（当前只支持 1）

  // ── 租约与重试 ──────────────────────────────────────
  leaseTtlMinutes: number,       // 默认 10，1..60
  maxAttempts: number,           // 默认 2，1..5

  // ── 执行 ────────────────────────────────────────────
  workExecutor: 'mock' | 'agent', // 默认 mock（agent 未实现）
  ticketTimeoutMinutes: number,  // 默认 40，5..180
  fetchBeforeCreate: boolean,    // 默认 true
  branchPrefix: string,          // 默认 'ticket-'，后接 <projectId>-<recordId>-r<修订号>
  worktreeRetentionHours: number,// 默认 24，0..720

  // ── agent 与模型 ────────────────────────────────────
  provider: string,              // 默认 'workbuddy'
  model: string,                 // 默认 'deepseek-v4.1-flash'
  maxTokens: number,             // 默认 32000

  // ── 通知 ────────────────────────────────────────────
  pushAdapter: 'mock' | 'pushplus', // 默认 pushplus
  pushplus: { token, channel, template },
  notifyOn: string[],            // 默认 ['done','skipped','failed','needs-info']

  // ── 杂项 ────────────────────────────────────────────
  enabled: boolean,              // 默认 false
  logLevel: string,              // 默认 'info'
}
```

**凭据不进配置**：`pushplus.token`、GitLab PAT、飞书应用密钥全部走 `ctx.credentials`。
配置里的 token 字段只是占位，读取顺序是 credentials → 配置（空则视为未配置）。

**`enabled` 默认 `false` 的理由**：插件装上就自动开始扫表、建 worktree、开 MR 是很危险的默认值。必须由人显式打开。

---

## 10. 可替换点（文件级）

```
src/
├── core/                          ← 内核：换平台时一行不改
│   ├── scheduler.js               ← tick、单飞、队列、超时、清理
│   ├── store.js                   ← storageDomain 封装、phase 转移、租约
│   ├── recover.js                 ← 启动恢复（扫未完成票）
│   └── prompt.js                  ← 给 agent 的 task 文案拼装
├── contracts/                     ← 只有类型与错误类，不 import 任何东西
│   ├── errors.js                  ← PipelineError + ErrorKind
│   ├── ticket-source.js           ← TicketSource / ScanResult
│   ├── repo-locator.js            ← RepoLocator / LocateResult
│   ├── work-executor.js           ← WorkExecutor / ExecCtx / ExecResult / Plan
│   ├── push-adapter.js            ← PushAdapter / NotifyMessage / PushReceipt
│   └── types.js                   ← Ticket / ScreenshotRef / Phase
├── adapters/                      ← 唯一允许按平台改的地方
│   ├── source-mock/               ← 内存里造票，用于开发与自测
│   ├── source-feishu/             ← 飞书多维表格（票 12）
│   ├── source-wps/                ← 金山文档（第二平台，暂不实现）
│   ├── locator-table/             ← 通用仓库定位器：按 projectId 查 projects[]
│   ├── executor-agent/            ← agent 驱动 + 构建 / 单测 / 起后端 + 开 MR（目前是占位实现）
│   ├── gitlab-client/             ← Commits API + draft MR 的最小客户端（executor-agent 落地时使用）
│   └── push-pushplus/             ← PushPlus channel=clawbot
├── tools/
│   ├── pipeline-scan.js           ← 工具 pipeline_scan
│   ├── pipeline-status.js         ← 工具 pipeline_status（只读查询队列与历史）
│   ├── pipeline-cancel.js         ← 工具 pipeline_cancel（人工取消在跑的那一票）
│   ├── pipeline-reset.js          ← 工具 pipeline_reset（人工重开 failed / needs-info / gone）
│   └── define.js                  ← 工具定义的最小封装（名字校验、文本块渲染）
└── index.js                       ← 组合根：注册表 + apply
```

### 注册表（`src/index.js`）

```js
import { createMockSource }     from './adapters/source-mock/index.js'
import { createFeishuSource }   from './adapters/source-feishu/index.js'
import { createTableLocator }   from './adapters/locator-table/index.js'
import { createAgentExecutor }  from './adapters/executor-agent/index.js'
import { createPushplus }       from './adapters/push-pushplus/index.js'

const SOURCES   = { mock: createMockSource, feishu: createFeishuSource }
const EXECUTORS = { mock: createMockExecutor, agent: createAgentExecutor }
const PUSHES    = { mock: createMockPush, pushplus: createPushplus }
// 仓库定位器只有 table 一种实现，不是可替换表：直接 createTableLocator({ projects })
```

**为什么是静态表而不是目录自动发现**：

- 打包时 `files` 字段容易漏掉动态 import 的目录
- 构建期静态分析看不到依赖，tree-shaking / 类型检查都失效
- 出错信息只剩一个 `MODULE_NOT_FOUND`，定位成本高

静态表只多一行 import，换来可检查、可打包、可跳转。**「换适配器只需一行注册」的验收标准依然满足** —— 那一行就是表里的一行。

### 判定标准（改完自己验一遍）

> 删掉 `src/adapters/source-feishu/` 整个目录 + `src/index.js` 里那个 import 和表里那一行，
> 插件仍能构建、仍能用 `projects: [{ name:'demo', match:{ platform:'mock' }, repo:{ path:'...' } }]` 跑通整条链路。

> 静态注册表背后的取舍写在 [ADR 0001：平台适配层可插拔](../adr/0001-平台适配层可插拔.md)；错误模型见 [ADR 0002：PipelineError 错误模型](../adr/0002-PipelineError错误模型.md)；工单正文不可信的边界见 [ADR 0003：工单正文不可信](../adr/0003-工单正文不可信.md)。术语表在仓库根 [GLOSSARY.md](../../GLOSSARY.md)。

做不到就说明边界漏了 —— 有内核代码直接引用了飞书的细节，或者适配器之间互相 import 了。

---

## 11. 一次完整跑的时序

以「飞书出现一条 `是否处理 = 处理中` 的新行」为例：

```
T+0:00  timer.interval 触发 tick()
        ├─ running = true（单飞）
        ├─ source.scan() → { created: [票A], updated: [], disappeared: [] }
        │    └─ 适配器内部：records/search 降序翻页，比对 WatermarkRow.seen，
        │       连扫 safePageRun(20) 条已知未变即停
        ├─ TicketStore.put(票A, phase='pending', attempt=0)
        └─ 队列 = [票A]

T+0:01  drainOne() 取出票A（并发 1，一轮只跑一票）
        ├─ 抢租约（写 + 回读校验）
        ├─ locate = locator.locate(票A)  → { repoPath, baseBranch, targetBranch,
        │                                    candidatePaths:[], ambiguous:false }
        ├─ 若 fetchBeforeCreate → git fetch <项目 baseBranch>
        ├─ [executor-agent 实现时使用，当前 scheduler 里不存在]
        │    agent = ctx.agents.create({ sessionId, meta:{cwd: repoPath} })
        │    wt = await ctx.worktrees.create(agent, { name:'<branchPrefix><projectId>-<recordId>-r1',
        │                                            from:'<项目 baseBranch>' })
        │    副作用：**这个 agent 的 cwd** 被切到 wt.path（不是主会话）
        ├─ 当前实现：组合根的 prepareWorkspace 跑 git fetch + git worktree add，
        │    落到 `<repoPath>/.agents/worktrees/<branch>`；没有 subprocess 时返回 {}，阶段照走
        └─ onPhase('worktree-ready') 记 worktreePath/branch/baseCommit（先回填进 ws 再落库，执行器读 ws）

T+0:02  onPhase('planning')，起超时定时器（40 min）
        ├─ 截图是**输入**不是阶段，在开工之前就取：
        │    逐条 source.loadScreenshot → 组合根 saveImage →
        │    attachments.saveImage({data, mediaType, name}) → ImageBlock{...}
        ├─ 内核渲染任务书：renderTicketPrompt() 出纯文本，renderTicketContent() 出「文本块 + 图片块」
        ├─ 调 executor.run(ticket, located, ctx)
        │    ctx 里 prompt / content / images 三个都给：老适配器只读 prompt，
        │    新适配器按 content 才看得见图；falsy 的图在 content 里被跳过
        └─ [executor-agent 实现时使用，当前 scheduler 里不存在] agent.followup(msg)
              ← 必须 followup（inject 不唤醒 agent）

T+0:03  … agent 在 wt.path 里读代码、定位、规划
        └─ 报「定位完成」→ onPhase('editing')，存 Plan

T+0:30  … agent 改完 → onPhase('testing')
        └─ 验证命令从项目配置 verify.build / verify.test 注入
           （没配 verify 就跳过验证，直接开 draft MR）

T+0:35  onPhase('mr-opening')
        ├─ git push 不可用（沙箱封死，见 §12）
        ├─ 用 GitLab Commits API 把改动物化成远端 commit
        │    POST /api/v4/projects/28/repository/commits
        │      { branch, commit_message, actions:[{action:'update', file_path, content}] }
        │    ⚠️ 过滤 application.yml 之类含真实凭据的文件
        ├─ GET /repository/branches/:branch 确认分支存在（POST 分支不存在也返 201）
        ├─ GET /merge_requests?source_branch=X&state=opened 去重
        └─ POST /merge_requests { source_branch, target_branch:'<项目 targetBranch>',
                                  title:'Draft: [工单#N] 摘要', description }

T+0:36  onPhase('done') / onPhase('skipped')
        ├─ 存 mr.iid / mr.url
        ├─ push.send({ title, body, link: mr.url, level:'info' })
        ├─ 释放租约、清超时定时器
        └─ running = false

T+3:00  下一轮 tick()（队列空，只扫描 + 清理）
        └─ cleanupExpiredWorktrees()：done/skipped 且超 24h 的最多清 1 个
```

**关键点**：整条链路里，内核只调了四个接口。它不知道飞书的 URL、不知道 GitLab 的 API、不知道该改哪个 `.vue` 文件。

---

## 12. 已知约束与未决

### 12.1 沙箱：插件里的 shell 调用必须自己带策略（已实测并修复）

**现象**（2026-11-04）：插件跑 `git fetch` 稳定失败

```
internal: git fetch 失败：error: cannot open '.git/FETCH_HEAD': Permission denied
```

而同一条命令、同一个路径、同一个用户，在 DSH 的 bash 工具里**成功**。
`icacls` 上目标目录与 `.git` 只有继承的允许项，**没有任何 DENY** —— 所以不是 ACL、也不是路径指错。

**真机制**（读宿主 `app.asar` 源码坐实）：插件调 `shell.execute(shell.resolve({ command }))` 时没传
`sandboxPolicy`，宿主 `SandboxBashExecutor.resolve` 就退回 `ctx.sandboxPolicy.resolve()`。
插件不是会话，这个调用**没有 `session`**，于是：

1. `SandboxPolicyService.resolve` 返回的策略里**没有 `sessionId`**；
2. Windows 的 `windowsAclRunnerArgv(policy)` 在 `sessionId === undefined` 时
   **一个写授权 SID 都不发**（只给 `--workspace/--temp/--mode`）；
3. 子进程因此只有受限令牌 + Low 完整性 → git 写 `.git/FETCH_HEAD`（lockfile + rename）必被拒。

工具 bash 之所以能成，是因为它走会话策略，本会话是 `danger-full-access`，
而 `SandboxBashExecutor.execute` 在 `mode === 'danger-full-access'` 时**直接本地执行、完全跳过 confine**。

**修法**（`plugins/ticket-pipeline/src/index.js`）：所有走宿主 shell 的调用点**显式传策略**。

```js
export function fullAccessSandboxPolicy (cwd) {
  return { mode: 'danger-full-access', workspaceRoot: <绝对路径> }
}
```

`workspaceRoot` 必须是绝对路径（宿主 `resolveWorkspaceRoot` 只认绝对路径，相对路径会抛
`sandbox-policy: workspace root must be an absolute execution-world path`），所以函数里有绝对路径守卫，
不可用时回退 `process.cwd()`。

**安全边界**：这条策略确实绕过按会话的写入准入。因此它**只用于 git 与 verify 命令**
（`makeGitRunner` / `makeCommandRunner`），**不用于执行模型生成的任意 shell** ——
后者由 `executor-agent` 走它自己的命令通道，不共享这条旁路。

**结论**：流水线跑起来的容器前提是「插件进程能写目标仓库」；本插件用显式 `danger-full-access`
把它变成调用方声明的行为，而不是靠部署默认值碰运气。这也意味着**部署方要清楚**：
跑票会把 `git`/`npm test` 这类命令以**完整文件系统权限**执行。

### 12.1.1 基准分支不能硬编码 `main`

实测（`mgiot-pms`）：`git fetch origin main` → `fatal: couldn't find remote ref main`。
该仓库真实分支是 `v2.x`（= `origin/HEAD`）与 `master`。
硬编码 `main` 会让 **fetch 第一步就失败**，而错误文案看起来像权限问题，极难定位。

现在的顺序是 `detectBaseBranch`（`src/index.js` 模块级导出）：`repo.baseBranch`（显式配置）→
`git symbolic-ref --short refs/remotes/origin/HEAD`（剥 `origin/`）→
`git rev-parse --abbrev-ref HEAD`（排除 `HEAD`）→ 才退回 `'main'` 并记一条警告日志。
`pipeline_doctor` 会把实际用到的分支打出来，并在回退 `main` 时提醒显式配置。

### 12.2 `git push` 被沙箱物理封死

```
error: cannot create standard input pipe for git-receive-pack: Permission denied
fatal: unable to fork
```

不是网络、不是权限配置，是子进程管道建不出来（连本地裸仓库都失败）。**所以不能用 `git push -o merge_request.create`**，只能：

- 本地 commit 留在 worktree 里给人看
- 远端用 **Commits API** 物化改动（`actions[]` 按文件内容表达）

代价：远端那个 commit 和本地那个 SHA 不同、作者默认是 token 用户（可用 `author_name`/`author_email` 覆盖）。

### 12.3 MR 必须走标题前缀

- `draft=true` 参数被**静默忽略**（返回 201 但 `draft:false`）
- `wip_event=draft` 直接 400（参数未声明）
- 唯一有效：`title: "Draft: …"` → 201 且 `"draft": true`

**开完必须断言返回体 `draft === true`**，不能只看 201。

### 12.4 两个 GitLab 坑

1. **`source_branch` 不存在也返回 201** → 开 MR 前必须先 `GET /repository/branches/:branch`
2. **重复 MR 返回 409**（文案是中文）→ 只按状态码判断，不匹配文案

### 12.5 未决（地图 `Not yet specified`）

| 项 | 影响 | 何时定 |
|---|---|---|
| Web UI 面板 | 不影响架构，纯增量 | 有人真的想看队列时 |
| 多张工单指向同一模块的冲突 | 当前靠串行天然规避，但是「时间换安全」 | 出现真冲突时 |
| 处理人绑定规则 | 当前不绑（只看 `是否处理`） | 有人抱怨「谁都能被派活」时 |
| 微信双向回复 | `PushAdapter` 只有单向 `send` | 明确不做，除非需求变了 |
| 高优先级是否动手前问人 | 当前所有票一视同仁 | 出现高风险票时 |
| token / 时间预算 | 当前只有总超时，没有 token 上限 | 发现烧太多时 |

### 12.6 明确不做（`Out of scope`）

- 个人微信 bot 框架（wechaty / itchat / wcferry）—— 违反微信 ToS，有封号风险
- 自动合并 MR —— 人验收后自己合
- `projects[]` 未配置的仓库
- `pms-miniapp` 小程序的自动化测试
- **工单表状态回写** —— 用户明确只要只读

### 12.7 飞书适配器的落地细节（票 `12` 已实现）

实现文件：`plugins/ticket-pipeline/src/adapters/source-feishu/index.js`（790 行）。离线自测在
`plugins/ticket-pipeline/scripts/feishu-checks.mjs`，跑 `node scripts/dev-run.mjs` 第 9 节。

**认证**：`POST /open-apis/auth/v3/tenant_access_token/internal`，`{app_id, app_secret}`。
token 缓存到本地，**过期前 60 秒**自动刷新（`expire` 默认 7200 秒）。

> ⚠️ **认证接口的响应体没有 `data` 这层包装** —— `tenant_access_token` 就在顶层。
> 其余接口的业务数据才在 `data` 里。所以 `apiCall()` 返回**整个响应体**，调用方自己取
> `payload.data`。写成 `return payload.data` 会让认证永远拿不到 token（实测踩过）。

**扫描**：`POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/search`，
`page_size:500` + `automatic_fields:true` + `sort:[{field_name:'最后更新时间',desc:true}]`。
有些表不允许按自动字段排序，**服务端会用 `invalid-input` 拒掉** —— 这时删掉 `sort` 重试一次
（宁可多翻几页也别整轮失败）。

**停止条件**是连续 `safePageRun`（默认 20）条**已知且未变**的记录，不是「见到第一条 ≤ 水位就停」。
理由：`last_modified_time` 由服务端维护，批量操作 / 导入 / 跨时区写入会**乱序**（后改的行时间戳反而更早），
单点水位会漏票。

**变更判定用内容指纹，不用 mtime**。指纹只含工单内容（问题描述 / 模块 / 操作流程 / 截图 / 优先级 /
发现部门），**不含** `是否处理` / 处理人 / 处理结果 / 处理日期 —— 否则人改一次处理人就触发一次修订。

**收票**只认 `是否处理 = 处理中`，不叠加任何别的条件。下拉字段的返回形状不固定（裸字符串 /
`{text}` / `[{text}]`），**必须先 `normalizeCellText()` 归一再判等**。

**退役有两条路**：①人把 `是否处理` 改成别的值（`否` = 待认领、`是` = 已闭环）→ 立刻退役；
②行被删了 → 连续 `goneAfterScans`（默认 3）轮没扫到才退役，静默、不通知、不删历史。
反过来，人把状态从 `否`/`是` 拨回 `处理中` = 手动重置 → 重新收票。

**绑定工单表有三条路**，任何一步命中 0 张或 >1 张都当**配置错误**（宁可报错让人改配置，
也不要扫错表把别人的表当工单表）：

| 给了什么 | 怎么找表 |
|---|---|
| `appToken` + `tableId` | 直接用 |
| `appToken`（无 `tableId`） | `GET /open-apis/bitable/v1/apps/:appToken/tables`，按 `docNamePattern` 过滤，必须恰好 1 张 |
| 只有 `docNamePattern` | 先 `GET /open-apis/drive/v1/files` 找 `type==='bitable'` 且名字匹配的文档（必须恰好 1 张），再取它唯一的表 |

`docNamePattern` 先当正则用（`new RegExp(pattern,'i')`），正则不合法就退回「包含」。

**截图取字节**（三形态，`loadScreenshot` 只管拿字节）：

| 形态 | 怎么取 |
|---|---|
| `attachment{fileToken}` | `GET /open-apis/drive/v1/medias/:file_token/download`（Bearer tenant token） |
| `path{path}` | `ctx.fs.resolve()` + `ctx.fs.readBytes()`（由组合根注入 `readLocalFile`） |
| `url{url}` | 裸 `fetch`（**不能**用 `ctx.web.fetch` —— 它带不了凭据） |
| `unknown{raw}` | 抛 `invalid-input`，内核标 `needs-info` 让人补图，不阻塞排队 |

取到的字节统一走 `ctx.attachments.saveImage({data, mediaType, name})` → `ImageBlock` → `agent.followup()`。

**错误分类**（飞书错误码 → 我们的 kind）：

| 飞书码 | kind | 可重试 |
|---|---|---|
| `99991663` `99991664` `99991665` `99991668` `99991672` `1254301` | `auth` | 否 |
| `1254043` `1254045` `1254290` | `not-found` | 否 |
| `1254005` `1254006` `1254007` | `invalid-input` | 否 |
| `99991400` `99991403` / HTTP 429 | `rate-limit` | 是（退避 5s 或读 `retry-after`） |
| HTTP 401 / 403 | `auth` | 否 |
| 其它 | `internal` | 是 |

**绝不写回**：本文件里没有任何对记录的写操作。自测里有一条断言专门盯着这件事 ——
扫描全程只允许出现 `GET` / `POST /auth/...` / `POST /records/search` 三种请求，
一旦出现 `records/update|batch_update|delete|create` 就失败。

### 12.8 飞书凭据与授权前置

**凭据从 `ctx.credentials` 取，不进配置文件**：

| ref 名 | 内容 |
|---|---|
| `FEISHU_APP_ID` | 开放平台应用的 App ID |
| `FEISHU_APP_SECRET` | 开放平台应用的 App Secret |

组合根注入 `getSecret`（`plugins/ticket-pipeline/src/index.js`）：惰性取 `ctx.get('credentials')`，
调 `credentials.resolve(ref)`。**用的是普通字符串 ref，不是 branded `credentialRef`** ——
`@deepseek-ai/dsh-credentials` 这个包只存在于 asar 内，插件目录 import 不到，
而 `resolve()` 按字符串 key 取值，普通 ref 完全可用。

⚠️ 空串不算已配置（`resolve` 跳过空串、`describe` 报 unconfigured），所以「配了但是空的」
会被当成「没配」，报 `auth` 错。

**文档级授权是人工前置，脚本搞不定**：

1. 表格所有者 → 分享 → 添加文档应用（把工单表授权给你的飞书应用）
2. 应用要有多维表格读取权限（`bitable:app` 之类）
3. 如果用 `docNamePattern` 走云文档搜索，还额外需要云空间读权限（`drive:drive`）

**为什么不能脚本化**：`POST /open-apis/drive/v1/permissions/:token/members`（把协作者加给应用）
只对 `user_access_token` 有效；插件用的是 `tenant_access_token`，**没法给自己加权限**。
所以这一步必须人去点。插件侧能做的是：认证失败 / 权限不足时抛 `auth`，
错误信息里写清楚「先让表格所有者把这个表授权给你的应用」。

**真实端到端验证需要人提供**：App ID + App Secret，以及至少一张工单表的
`app_token` / `table_id`（或一个能唯一匹配到它的 `docNamePattern`）。
没有这些，自测只能停在打桩层（第 9 节）—— 打桩证明**逻辑**对，不证明**权限通**。

---

## 13. 事实来源

本文所有「实测」结论都来自以下材料，改动前先回读原文：

| 主题 | 位置 |
|---|---|
| DSH 插件系统 / 服务 / slot / 发布 | `docs/research/dsh-capabilities.md`；抽取的原始文档在 `.scratch/_reference/dsh-plugin-docs/` |
| 飞书多维表格 API、水位、附件 | 票 `.scratch/ticket-pipeline/issues/01-飞书多维表格的变更水位与去重.md` 的 Resolution |
| 截图上模型的唯一合法通路 | `.scratch/ticket-pipeline/research/image-path.md`（723 行，每条带 `包名:行号`） |
| GitLab draft MR / Commits API | `.scratch/ticket-pipeline/research/gitlab-mr.md`（558 行，每条标【实测】/【源码】/【不可知】） |
| 项目仓库目录结构与验证命令参考 | `.scratch/ticket-pipeline/research/repo-map.md`（405 行，11 节，作示例） |
| 微信推送（WorkBuddy 排除 / PushPlus） | `.scratch/ticket-pipeline/research/wechat-push.md`（784 行） |
| `worktrees` 服务契约 | `.scratch/_reference/worktree-README.md`（从 asar 抽出） |
| 所有决策与用户拍板 | `.scratch/ticket-pipeline/map.md` 的 `## Decisions so far` |
