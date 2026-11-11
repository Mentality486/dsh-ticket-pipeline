# 工单流水线插件 · 架构设计

> 状态：设计定稿（对应地图票 #10）；§4 / §7.2 / §12A 于 2026-11-04 按实现回填，§2 / §9 / §10 / §11 / §12.7 于 2026-11-05 按当前代码回填，「本地提交」改造（§5.4 / §7.1 / §9 / §11）于 2026-11-06 回填，「改代码落点」改造（§5.4 / §7.4–§7.7 / §9 / §11）于 2026-11-06 晚回填，四项改造与「选择分支」（§5.2 / §5.4 / §6.5 / §9 / §10 / §11）于 2026-11-06 深夜回填
> 日期：2026-11-03（最近一次按实现校准：2026-11-11 深夜（二），**进步信号要选你真的关心的那个量** —— 第一张真实工单 `sh-row-81` 在 ⑤ 站跑了 39 分钟、63 次工具调用、读了 23 个文件（平均每个读 2 次），**改过的文件 0 个**，最后整票硬超时失败。两个独立的病：任务书 `## 代码定位` 只说「先读仓库结构」而没说读到什么时候该动手；执行器「等 agent 干完」只有一句 `await waitForAgentIdle(...)`，且它判进展用的是 `session.seq`（读文件也会涨）—— 卡在读文件和飞快改代码在它眼里一样。修法：任务书加 `## 工作方式`（探索预算 **12 次**、先动手再补细节、同一类信息只查一次、卡住就停）；`waitForAgentIdle` 加停滞看门狗（`BUILTIN_LIMITS.agentStallWarnMinutes = 8`、`agentStallNudges = 2`），**进步信号换成工作区文件指纹**，催而不杀。同一轮把通知从 PushPlus（ClawBot 要实名付费、回 `905`）换成**飞书自建应用直发**（`push-feishu` 适配器，`im/v1/messages`，真机实发成功 `om_x100b600a…`），见 §12.17 与 §12.18。上一轮是**内容块的字段名是宿主的契约** —— `sh-row-81` 带截图，在 ⑤ 站崩 `Cannot read properties of undefined (reading 'attachmentId')`：`renderTicketContent` 把图片引用放在自己起的 `image` 字段上，而宿主 `@deepseek-ai/dsh-llm` 的 `ImageBlock` 契约是 `{ type: 'image', attachment: ImageAttachmentRef }`，所有读图代码都写 `block.attachment.attachmentId`。更要记的是**自测把错误形状抄了进去** —— `dev-run` 与 `chain-smoke` 的断言照着实现写 `.image`，两边自洽所以 498 条全绿，契约方从没被引用过。见 §12.16。再上一轮是**定位捷径不能跳过表型判定** —— pms 项目里 `appToken` 是裸 wiki token（背后是电子表格）、却还留着上一轮多维表格的 `tableId`；旧版 `resolveBitableTableByIdentity` 开头一句 `if (tableId) return { kind:'bitable', … }` 一个请求都不打就「定位成功」，于是表型分派被 `tableId` 抢走、`shouldTrySheet()` 降级路被堵死，一路拖到 `resolveBitableColumns` 才炸 `1254003 WrongBaseToken`，而体检说「能读」—— 同一个毛病体检全绿、真正跑票失败，界面上还一片安静。修法两层：运行期配了 `tableId` 也先验一次 `tables`、配置期 `tableId`+`sheetId` 并存就警告。见 §12.15。上一轮是**面板两条写入通道不能串成一个总闸** —— 「凭据」页签填了 token 点保存什么都没发生：`onSave()` 先算配置改动，为空就 `return`，写凭据那段在这行 `return` 之后，于是只填凭据时一个字节都没写进去，面板还回一句「没有需要保存的改动」，而页签计数又把 `credDirty` 算进去了 —— 能点、会涨、点了没用。现在凭据写入移到提前返回之前，两条通道互不阻塞，见 §12.14。更早 2026-11-10 深夜是**体检与适配器认同一套输入形态与状态值口径** —— 用户报「用电子表格链接体检不通过、取不到工单」，查下去是两个独立毛病：体检探针按「`appToken` 非空」就认定多维表格（面板贴 `/wiki/<token>` 时写进 `appToken` 的正是裸 wiki token，背后可能是电子表格）→ 飞书回 `1254003` 报红，而适配器本体一直是好的；真正「一张票都收不到」的是**状态值对不上**（缺省只认「处理中」，这张表实际填「是 / 否」，实测 `['处理中']` 收 0 张、`['是']` 收 73 张）。体检现在会采样状态列实际取值并给出修法，只进提醒不进阻断，见 §12.13。同日上一轮，**定位工单表只剩一个入口** —— 项目卡片上的「工单表」组 / 「飞书电子表格」组 / 「工单表链接」行三处都能指定同一件事，填了也不知道哪个生效；现在只留「工单表链接」，`extractSheetToken` 认 `/wiki/<token>` 并补齐错误码 `1254003`，`validateProject` 放宽成「至少一个定位依据」，见 §12.10「一个入口」小节。更早 2026-11-10 是 **22 张产品工单落地** —— 配置 33 → **25 键 4 组**（§11.2）、`delivery` 交付维度（ADR-0007）、`pipeline_status` 缺省改成「按项目聚合的总览」（`view: 'overview' | 'tickets'`，见 §11.5）、**设置面板第五页签「运行」+ 9 个 Remote 方法**（§10）、多维表格列名别名（§12.10）、**电子表格回填**（§12.10）、WPS 与 GitLab 降级为 experimental、doctor 三档体检；再往前 2026-11-09 是**飞书电子表格支持落地** —— `get_node` 不再硬写 `obj_type`、`resolveTable` 成为表型分派总闸、新增 `src/adapters/source-feishu/sheets.js`、`validateProject` 改成四选一，见 §12.10；此前「`appToken` 贴整条表格链接」的 `parseBitableUrl`（`src/contracts/types.js`，配置校验与飞书适配器共用）也已回填；时间线见 §11.4）
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
    - [12.10 飞书电子表格支持（已实施）](#1210-飞书电子表格支持已实施)
    - [12.11 插件改动为什么会静默不生效](#1211-插件改动为什么会静默不生效pipeline_doctor-第-5-节)
    - [12.13 体检与适配器必须认同一套输入形态与口径](#1213-体检与适配器必须认同一套输入形态与口径pipeline_doctor-飞书连通性)
    - [12.14 面板的两条写入通道：凭据与配置不能串成一个总闸](#1214-面板的两条写入通道凭据与配置不能串成一个总闸)
    - [12.15 定位捷径不能跳过「这 token 到底是哪种表」](#1215-定位捷径不能跳过这-token-到底是哪种表)
- [12.16 内容块的字段名是宿主的契约，不是我们随口起的](#1216-内容块的字段名是宿主的契约不是我们随口起的)
    - [12.17 进步信号要选你真的关心的那个量](#1217-进步信号要选你真的关心的那个量执行器停滞看门狗)
    - [12.18 通知适配器可插拔，优先用「已经有凭据」的那条通道](#1218-通知适配器可插拔优先用已经有凭据的那条通道)
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
| 工单表 | **扫描只读**；唯一的写入口是 `TicketSource.writeResult()`，只在票跑成 done/skipped 后回填三列（是否处理 / 处理结果 / 处理日期），开关 `writeBack` | 地图 Decisions（用户 2026-11-03 定为只读 → **2026-11-06 改口径要求回填**） |
| 收票信号 | 「是否处理」列取值命中 `match.statusValues`（**缺省 `['处理中']`**；真实表用的是「否」，见 §9）。下拉三值是 / 否 / 处理中 | 地图 Decisions + 实表核实 |
| 代码仓库 | 项目清单维护在 `projects[]` 配置，每项目一个仓库 | 地图 Decisions |
| 交付物 | **默认是项目工作区检出里的一次本地提交**（`ExecResult.commit`）；远程 draft MR 是可选出口，只有项目显式 `repo.gitlab.enabled: true` 才开 | 2026-11-06 用户拍板（本阶段交付形态） |
| MR（可选出口） | 开了也只开 draft，绝不自动合并；基准/目标分支由项目 `repo.baseBranch`/`repo.targetBranch` 决定 | 票 `04` + 用户拍板 |
| 通知 | `PushAdapter` 可替换：PushPlus（`channel=clawbot` 中继微信）/ QQ 邮箱 SMTP 直发 / mock；默认 PushPlus | 票 `07` + 实现补充 |
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
          飞书 / WPS / mock      projects[]   agent    PushPlus
                                            查表         + commit  / qqmail / mock
```

> `webform` 源已于 2026-11-09 移除（工单 #18）：它当年是 ADR-0001「加平台只加目录」的第一个实证，
> 但水位只在内存里、重启就把同一批工单重收一遍，留着等于留一条「看起来能用、实际会重跑」的路。
> 实现留档在 `plugins/ticket-pipeline/scripts/fixtures/source-webform/`（`scripts/` 不进安装包）。

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
  // 5. 启动恢复：recoverPending()，把跑到一半的票放回 pending（工作区坐标有效就沿用）
  // 6. 注册 ctx.interval 轮询（enabled 关着时 tick 直接返回 disabled）
}
```

所有注册都用 `ctx.effect()` / 返回 disposer 的形式 —— 插件卸载时定时器、监听器、agent 句柄一起收干净。

**`inject` 为什么只有三个**（`export const inject = ['tools', 'storageDomain', 'timer']`，
见 [`src/index.js:71`](../../plugins/ticket-pipeline/src/index.js)）：

| 宿主服务 | 取法 | 为什么 |
|---|---|---|
| `tools` | `inject` | 注册五个工具，缺了插件没有入口 |
| `storageDomain` | `inject` | 票据 / 水位 / 租约三张表都在这上面 |
| `timer` | `inject` | `ctx.interval` 是唯一的默认入口；**宿主 sandbox 的白名单只放行 TIMER_VERBS**，不声明 timer 插件一激活就崩 |
| `subprocess` | `ctx.get('subprocess')` | 老宿主上跑 git 的兜底；现在首选 `shell` |
| `shell` | `ctx.get('shell')` | git 与 verify 命令走它（能带 sandboxPolicy），缺了退回 `subprocess` |
| `agents` | `ctx.get('agents')` | `workExecutor: 'agent'` 才需要 |
| `agentDefaultModel` | `ctx.get('agentDefaultModel')` | 配置里没写 provider/model 时，用它补齐（否则宿主 persona 的 `{{model}}` 没值直接崩） |
| `agentPresets` | `agentCtx.get('agentPresets')`（在 setup 回调里） | 给 agent 挂 preset；缺了就是「agent 一个工具都没有」，现在直接抛 invalid-input |
| `logger` | `ctx.get('logger')` | 弱取，拿不到就用 console |
| `credentials` | `ctx.get('credentials')` | 凭据可能还没配，缺了应该让飞书那一路报 `auth`，不该让整个插件挂载失败 |
| `fs` | `ctx.get('fs')` | 只有路径形态的截图要读本地字节 |
| `attachments` | `ctx.get('attachments')` | 离线自测没有附件库，`saveImage` 要能降级成 `undefined` |

惰性取的共同理由：这几个服务「缺了也要能装得上」，否则一个平台的环境问题会连带把其它平台拖死。代价是缺服务时只在运行期暴露 —— 所以每个 `ctx.get()` 都写了降级分支，并用日志说清降级到了哪一步。

### 4.2 什么时候跑

| 触发 | 方式 | 说明 |
|---|---|---|
| 定时扫描 | `ctx.interval(() => tick(), Config.pollIntervalMinutes * 60_000)` | **唯一默认入口**，默认 3 分钟 |
| 手动扫描 | 工具 `pipeline_scan` | 直接调 `tick()`，返回本轮结论 |
| 启动恢复 | `apply` 末尾扫一遍 `TicketStore` | 未到终态的票放回 `pending`（工作区坐标有效则沿用，失效则清掉重建） |
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

**五个工具**（都注册在 `apply` 里，见 [`src/index.js`](../../plugins/ticket-pipeline/src/index.js)）：

| 工具 | 作用 | 关键边界 |
|---|---|---|
| `pipeline_scan` | 立刻推一轮 | 不绕过单飞，正在跑时返回 `already-running`；不动 `enabled` |
| `pipeline_status` | 只读查队列与历史 | 不改任何状态。**缺省 `view: 'overview'`** 给按项目聚合的总览（全库口径，`includeDone` 不参与）；`view: 'tickets'` 才是逐票明细，传 `recordId` 时一律走明细 |
| `pipeline_cancel` | 取消当前在跑的那一票 | 落 `failed` + `lastError='cancelled by user'`，**不通知**，工作区保留；空闲时返回 `cancelled:false` |
| `pipeline_reset` | 人工重开一张卡住的票 | 只对 `failed` / `needs-info` / `gone` 生效；同名 recordId 冲突时要求补 `projectId`，不猜 |
| `pipeline_doctor` | 环境体检（只读） | 查 git 链路 / 每个项目仓库能否 `ls-remote` / 凭据有没有 / 执行器与通知器配的是哪个；以及**正在跑的安装副本是不是比本地源码旧**（只进「提醒」，不改任何东西） |

`pipeline_reset` 与「把表格里『是否处理』拨走再拨回 `statusValues` 里的值」是**同一个底层动作**（`store.resetByHuman`），区别只在于一个在表格里做、一个在插件里做。

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

  /**
   * 可选：把处理结果回填到工单表。**这是唯一的写入口**（`scan` 依旧只读）。
   *
   * 契约：
   * - 只在票跑成 `done` / `skipped` 之后被调用**一次**，绝不在扫描或重试中间调。
   * - 写不进去不算失败：目标表没有这几列、应用没写权限，都返回 `{ written: false, note }`
   *   而不是抛 —— 票已经处理完了，回填是附加动作。
   * - **`written: false` 时必须用 `retryable` 说清「还能不能救」**（ADR-0007）：
   *   `retryable: false` = 结构/配置上写不进去（同步表、少列、电子表格只有读权限或那一行已被删），
   *   再试一百次也是同一个错误；内核当场放弃并让人去改表格。留空视同 `false`。
   * - 只有真正的传输 / 鉴权异常才抛，内核会把它记进 `writeBack.note`，票态不回退；
   *   内核按 `errors.js` 的三张分类表推导该错可不可重试。
   * - 不实现也行（老适配器），内核静默跳过。
   */
  writeResult? (
    recordId: string,
    result: { status?: string, result: string, handledAt?: number },
    signal: AbortSignal,
  ): Promise<WriteBackReceipt>
}

/**
 * 回执：写了没、写了哪些列、为什么没写成、还能不能救。落到票据的 `writeBack` 上。
 *
 * `note` 会同时进表格、通知正文与 `pipeline_status`，**都是给人看的** ——
 * 不要拼 `kind: ` 这类内部前缀，分类放进 `errorKind`。
 */
export type WriteBackReceipt = {
  written: boolean
  fields?: string[]      // 实际写成功的列名，pipeline_status 直接列出来
  note?: string          // written=false 时的原因（人话）
  retryable?: boolean    // written=false 时：再试一次有没有意义（留空视同 false）
  errorKind?: ErrorKind  // written=false 时的错误分类（程序用，不给人看）
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

**为什么回填是 `writeResult` 而不是把写藏在 `scan` 里**：`scan` 是高频、可重试、可能在任意时刻被取消的只读动作；写必须低频（一票一次）、只在真出结果之后发生。混在一起的后果是「扫一半就把表写了」和「重试一轮写一次」。所以契约拆成两半：`scan` 只读、`writeResult` 是唯一写入口。决策记录见 [ADR 0006](../adr/0006-处理完回填工单表.md)。

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
  remote?: string           // GitLab remote URL（来自 project.repo.remote）；只有 repo.gitlab.enabled=true 才用于开 draft MR
  baseBranch?: string       // 建隔离 worktree 的基准分支（来自 project.repo.baseBranch；只在 isolateWorktree: true 时用到）
  targetBranch?: string     // draft MR 目标分支（来自 project.repo.targetBranch，可选出口才用）
  candidatePaths: string[]  // 恒为空：代码定位交给 executor-agent 现场读仓库
  ambiguous: boolean        // 恒 false：这里不猜代码路径
  notes?: string            // 项目 description，原样进 prompt
}
```

**为什么退化成查表而不是删掉这一层**：工单属于哪个项目是**表级**决定的（飞书知识树
里每个项目一张自己的工单表），这个绑定关系必须有一处统一、可单测的代码来表达；
「工单对应哪个仓库」是流水线的第一跳，放查表里比散在各处可靠。**「该改哪个文件」
则不属于这一层**——那需要读代码、看工单描述，是 agent 现场定位的事。

### 5.4 `WorkExecutor` — 怎么改代码、怎么验证、怎么落交付物

```ts
export interface WorkExecutor {
  readonly id: string

  /**
   * 执行一票。内部按阶段推进，每进入一个阶段调 onPhase 落库（崩溃恢复用）。
   *
   * 契约：
   * - 必须尊重 signal：aborted 时停手、保留工作区、抛 PipelineError('aborted')。
   * - 每进入新阶段必须 await onPhase(...)，不能只在自己的内存里更新 —— 那是崩溃恢复的唯一依据。
   * - 不改改代码落点之外的文件；不 push（沙箱封死，见 §12）。
   * - 返回前必须已经把改动落成**可交付的东西**：默认本地提交（commit，写清工单溯源）；
   *   配了 GitLab 的部署还会同时开 draft MR（mr）。两样都没有时必须在 error 里说明为什么。
   */
  run (ticket: Ticket, target: LocateResult, ctx: ExecCtx): Promise<ExecResult>
}

export type ExecCtx = {
  signal: AbortSignal
  workspacePath?: string                   // 项目工作区根（= 宿主的 Workspace.path）
  workspaceId?: string                     // 宿主 WorkspaceId，用来 attachSession 归属会话
  worktreePath: string                     // 改代码的落点绝对路径：缺省就是工作区根（isolateWorktree 关）；
                                           // 打开 isolateWorktree 时才是隔离检出 <repoPath>/.agents/worktrees/<branch>
  branch: string                           // 缺省 = 检出当前分支；isolateWorktree 打开时是新建的票分支
  onPhase (phase: Phase, detail?: string): Promise<void>
  log (msg: string): void                  // 写进插件日志，带 recordId 前缀
}

export type ExecResult = {
  phase: Phase                             // 终态：done / skipped / failed
  plan?: Plan                              // 执行器产出的方案（进提交说明 / MR 描述）
  changedFiles: string[]
  testOutcome: 'passed' | 'failed' | 'not-run'   // not-run = 验证没跑成（没配命令 / 起不来）；老数据写 'skipped'，读时归一
  testDetail?: string                      // not-run 时必须写原因
  commit?: { sha: string; branch: string; files: string[] }  // 在工作区检出里做出来的本地提交（本阶段交付形态）
  mr?: { iid: number; url: string; draft: boolean }          // 远程 GitLab 开出来的 draft MR。**实验性、缺省路径不生产**（工单 #19）
  sessionId?: string                       // 这一轮处理用的 agent 会话 id（记到票据上，人可以直接点进去追问）
  error?: { kind: ErrorKind; message: string; retryable: boolean }
}
```

**`phase = done/skipped` 时 `commit` 与 `mr` 至少给一个**（`makeExecResult` 会校验，两个都没有直接抛）。
这是本轮改造的核心：原来契约要求「必须给 `mr`」，等于把「有远端的 GitLab」写进了内核契约；
现在默认交付形态是**工作区检出里的一次本地提交**，远程 MR 降级成 `repo.gitlab.enabled: true` 才走的可选出口。

**`sessionId` 是可选但推荐返回的**：`run()` 的三个出口（done / skipped / failed）都带它，
`executor-agent` 用 `buildSessionId(ticket, ctx)` 生成同一个人能认出来的名字，落到票据的 `sessionId`。
有了它，`pipeline_status` 才会打出「处理会话：…（可在会话列表里点进去继续问）」，回填进表格「处理结果」列的那段话里也有一行 `处理会话：`。
**注意通知正文里没有这一行** —— `renderNotifyBody()` 只写 `本地提交：` / `draft MR：` / `改动文件：` / `验证：` 那几段。

**`testOutcome: 'not-run'` 是合法成功路径**（老数据里写 `'skipped'`，读时由 `normalizeTestOutcome()` 归一）：环境起不来（比如 MySQL 连不上、端口被占）就记 not-run 仍然做本地提交，但**必须把原因写进 `testDetail`**，不能默默略过 —— 人 `git show` 才知道「这个改动没被真跑过」。改名理由：`skipped` 这个词已经被 phase 占用（phase=skipped 是「验证跑了但没过」），两个意思撞同一个词，人和代码都会读错。

**`workspacePath` 与 `worktreePath` 是两个不同的东西**：前者是**项目工作区** ——
`projects[].repo.path` 那个目录在宿主的 `workspaceRegistry` 里的一条登记（一个项目一条，
多张票共用）；后者只有在 `isolateWorktree: true` 时才有值，是**这一票**的隔离检出
（`<repoPath>/.agents/worktrees/<branch>`）。
为什么要两套：宿主 `Workspace.attachSession(sessionId)` 强制要求会话 header 的规范 cwd
**等于**工作区路径，隔离子目录挂不上；而 agent 又必须在一个具体的检出里改代码。
所以会话 `meta.cwd` 用 `workspacePath`，再由 `workingDirectory.set` 把**这一轮的工作目录**
换成 `worktreePath`（只追加事件、不改 header.cwd，两者可以共存）。缺 `workspacePath`
（升级前入队的老票据）时退回「cwd = worktreePath」。

**隔离层是可选的，缺省关；检出脏也能跑**：`isolateWorktree` 默认 `false`，`prepareWorkspace` 走缺省分支 ——
`inspectCheckout()` 读 `git status --porcelain -z -uall -- . <排除 .agents/worktrees>` + `git rev-parse --abbrev-ref HEAD`，
`describeDirtyCheckout()` 发现未提交改动**只提醒不拒跑**（文案说清：本次照跑、会先给项目工作区拍一份基线、
结束后只提交 agent 真正改过的文件、你自己的未提交改动原样留在工作区），
然后 `{ path: workspacePath, branch: 检出当前分支, baseCommit: 检出当前 HEAD }`
—— **就在项目工作区的检出里改、就地提交**，不建 worktree、不另开票分支。
只有 `isolateWorktree: true` 才 `git fetch` + `git worktree add -b <branch> .agents/worktrees/<branch>`。

> 早先这里是 `assertCleanCheckout()`：检出一脏就抛 `invalid-input` 拒跑。2026-11-06 用户要求
> 「脏工作区也得能跑，但只提交 agent 改过的那些文件」之后，拒跑改成了**基线快照**（见 §11 的
> `createBaseline`），`assertCleanCheckout` 已从源码里删掉。

读检出状态这件事有三个容易踩的坑（都实测过，缺陷详情与修法见 `feature-checklist.md` §1.4）：`-uall` 不能省（否则未跟踪目录折叠成一个目录名，
里面的文件路径全丢，`application.yml` 这类敏感文件就绕过了拦截）；`-z` 不能省（否则中文名输出八进制转义、
含空格名一定加引号，旧解析器会把引号带进提交路径）；排除规则只排 `.agents/worktrees`，**不排整个 `.agents`**
（排整个目录会把用户自己放在 `.agents/` 下的内容一起误排）。三处读状态的地方（`inspectCheckout`、
`pipeline_doctor`、`collectChanges`）必须用同一组参数，否则「体检说干净、跑票说脏」这种问题最难查。

**`onPhase` 的第二个参数是给人看的说明，不是落库补丁**：`scheduler` 只对对象形态的参数调
`store.setPhase(phase, patch)`；字符串会被当成 detail 写进日志。踩过的坑：早先 `scheduler` 把字符串
原样传给 `setPhase`，而 `setPhase` 用 `Object.entries(patch)` 展开 → 字符串被摊成 `{0:'跑',1:'项',…}`
写进票据行（存储里多出 18 个数字键字段）。现在 `store.setPhase` 第一行就拒绝非对象补丁。

**「值得重试的外部失败必须抛，不要包成 `phase:'failed'` 结果」** —— 理由见 §8.4。

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
  link?: string                  // 通常是 MR URL；本阶段交付形态是本地提交，没有 MR 时为空
  level: 'info' | 'warn' | 'error'
}

export type PushReceipt = {
  accepted: boolean
  traceId?: string               // PushPlus 的流水号，用于查 callback / 人工追查
}
```

**为什么只有 `send` 一个方法**：通知是单向的。人在微信里回复「这个不对」属于**双向通道**，明确在 `## Out of scope` 之外（见地图 `Not yet specified`）。

**三种实现怎么填 `accepted` / `traceId`**：

| 实现 | `accepted` | `traceId` |
|---|---|---|
| `pushplus` | HTTP 200 且 `code===200`（只是受理） | PushPlus 的流水号 |
| `qqmail` | SMTP 的 `250` 受理（对端 `accepted:true`） | 服务端返回的消息号（`<...@qq.com>` 形态），出问题时拿它查日志 |
| `mock` | 恒 true | 本地生成，自测用来断言「确实推了」 |

---

## 6. 数据契约

### 6.1 `Ticket`

内核只读，由 `TicketSource` 构造。

```ts
// 说明：本文件里字段顺序与 src/contracts/types.js 的 typedef 一致，改代码时同步改这里。
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
  targetProject?: string     // 工单里写的「待修改项目」原值（表格列），仅进 prompt
                             // **不能顶掉 projectId**：那是存储主键的一半，而这一列是人手填的自由文本
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

执行器在 `planning` 阶段产出，存进 `TicketStore`，最终进提交说明 / MR 描述。

```ts
export type Plan = {
  summary: string          // 一句话：打算改什么
  targetPaths: string[]    // 计划改哪些文件（相对 repoPath）
  approach: string         // 怎么做（Markdown，可以有几段）
  risks?: string           // 你担心的点 / 不确定的地方
}
```

`risks` 不是装饰。人 review 那个本地提交（或 draft MR）时最想知道的就是「AI 自己觉得哪里可能不对」。

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
  workspacePath?: string               // 项目工作区目录（= 该项目 repo.path 的规范绝对路径）
  workspaceId?: string                 // 宿主 workspaceRegistry 里的 WorkspaceId（无 registry 时为空）
  worktreePath?: string
  branch?: string
  baseCommit?: string
  plan?: Plan
  changedFiles?: string[]
  testOutcome?: 'passed' | 'failed' | 'not-run'
  commit?: { sha: string; branch: string; files: string[] }  // 工作区检出里的本地提交（本阶段交付形态）
  mr?: { iid: number; url: string; draft: boolean }          // 远程 GitLab 开出来的 draft MR。**实验性、缺省路径不生产**（工单 #19）
  sessionId?: string                   // 这一轮处理用的 agent 会话 id（会话留在项目工作区名下）
  writeBack?: { written: boolean; fields?: string[]; at: number; note?: string }  // 回填工单表的回执
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
  | 'mr-opening'      // 正在本地提交（阶段名保留，语义已从「开 draft MR」改为「在工作区检出里做本地提交」）
  | 'needs-info'      // 等人补信息（截图取不到），补上后回 pending
  | 'done'            // 终态：成功
  | 'skipped'         // 终态：改动已本地提交，但测试没跑成
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
| `pending` | `worktree-ready` | `prepareWorkspace` 成功（未注入它时也会推进） | 回填并记 `worktreePath`（缺省模式 === workspacePath）/`branch`/`baseCommit` |
| `pending` | `needs-info` | `loadScreenshot` 抛错 | 通知人补图、释放租约、**不标 failed** |
| `pending` | `gone` | 连续 `goneAfterScans` 轮没扫到 | 静默退役、释放租约 |
| `needs-info` | `pending` · `gone` · `failed` | 人在表格里改了内容 / 行被删 / 人工重开后重跑失败 | 指纹变才回到队里，否则继续等人 |
| `worktree-ready` | `worktree-ready` · `planning` · `pending` · `failed` | 重打点 / 开工 / 工作区丢了回队列 / 失败 | 开工时起超时定时器、`startedAt = now` |
| `planning` | `planning` · `editing` · `worktree-ready` · `pending` · `failed` | agent 报「定位完成」/ 要重建工作区 / 可重试错误回队 / 失败 | 存 `Plan` |
| `editing` | `editing` · `testing` · `planning` · `worktree-ready` · `pending` · `failed` | agent 报「改完了」/ 验证不通过退回重做 | 存 `changedFiles` |
| `testing` | `testing` · `mr-opening` · `done` · `skipped` · `planning` · `worktree-ready` · `pending` · `failed` | 构建/测试有结论；或退回重做 | 存 `testOutcome`、`testDetail` |
| `mr-opening` | `mr-opening` · `done` · `skipped` · `planning` · `worktree-ready` · `pending` · `failed` | 本地提交做成功（或开完可选 draft MR）/ 提交之前发现问题退回 | 存 `commit`（有远端时一并存 `mr`）、发通知、释放租约、清超时定时器 |
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
差别在副作用：**保留改代码落点**（缺省就是项目工作区的检出，本来也不会删；开了 `isolateWorktree` 则是那个隔离目录）、发通知、释放租约；超时还要先 `agent.cancel()`。
而可重试错误且 `attempt < maxAttempts` 走的是**回 `pending`**（`attempt++`、回队首、同样保留改代码落点）。

**回退路径**（`recover.js`，§7.6）：**恢复的终态统一是 `pending`**，区别只在保不保工作区坐标 ——
`worktreePath` 还在且 `git rev-parse` 通过就留着（`runOne` 会先问 `isStaleWorkspaceCoords`，坐标有效就直接复用那个检出，不重新 clone）；
不在就清掉 `worktreePath`/`branch`/`baseCommit`/`commit`/`mr` 再回 `pending`，让执行器重建。
「上次停在哪一步」写进 `lastError` 给人看。

> **为什么不是「停在原中间态重做」**：`store.pickNext()` 只挑 `pending`，而 `tick()` 的唯一入口就是 `pickNext()`；
> 恢复成 `planning`/`testing` 之后**没有任何代码路径会再把它交给执行器**（真机事故：3 张 sandbox 票永久卡死，
> 恢复日志说 `resumed: 1`，票却一步不动，`pipeline_reset` 又只认 failed/needs-info/gone，救不回来）。

**人工重开有两个入口、同一个动作**（`store.resetByHuman`）：表格里「是否处理」由非收票值 → 收票值，
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
3. 通知（`level: 'warn'`，正文写明超时分钟数与工作区绝对路径）
4. **保留改代码落点**（排查线索）
5. **不自动重试**（用户拍板）

同一 `recordId` 下一轮扫描见 `phase = failed` → **直接跳过**，不再入队。

**唯一的重开路径**是人工重置：人把表格里「是否处理」从别的值拨回 `statusValues` 里的值（缺省 `处理中`），
或在插件里调 `pipeline_reset`。内核据此把 `attempt` 归零、回到队列。这条路径的存在让「不自动重试」不会变成死局。

### 7.5 人工中断

用户点取消 → `agent.cancel()` → `turn/end` 的 `reason.kind === 'aborted'`：

- 标 `phase = failed`，`lastError = 'cancelled by user'`
- **不发通知**（人自己取消的，不需要再告诉他）
- 保留改代码落点

### 7.6 进程重启恢复

`apply()` 末尾：

1. 读 `TicketRecordRow` 里 `phase ∉ TERMINAL` 的全部记录
2. 对每条：
   - `worktreePath` 存在且 `git -C <path> rev-parse --is-inside-work-tree` 通过 → **保留坐标**，phase 放回 `pending`（`runOne` 会先问 `isStaleWorkspaceCoords`，坐标仍然有效就直接复用这个检出，不重新 clone / 不重新 `worktree add`）
   - `worktreePath` 不存在或不通过 → 清掉 `worktreePath`/`branch`/`baseCommit`/`commit`/`mr`，phase 放回 `pending`，让组合根的 `prepareWorkspace` 下一轮重建：`isolateWorktree` 关（缺省）时就地复用项目工作区检出，打开时才 `git worktree add`
   - 分支已被删 / 已被改 → 同样清坐标重建，不重用
   - 「上次停在哪一步」写进 `lastError`（`上次停在「跑验证」，启动恢复后重新排队（工作区沿用，不会重新 clone）`），因为 phase 已经统一成 `pending`，光看 phase 看不出中断点
3. **不从头重跑**：已经改过的文件不重改；已经做过的本地提交不重做（新工作区是新检出，旧 sha 不存在，恢复时 `commit` 会被清掉）；可选的 draft MR 也不重开（先查 `merge_requests?source_branch=X&state=opened`）

> **恢复终态必须是 `pending`，不能是原中间态。** `store.pickNext()` 只挑 `pending`，而 `tick()` 的唯一入口就是 `pickNext()` ——
> 恢复成 `planning`/`testing` 之后没有任何代码路径会再把它交给执行器。真机事故（2026-11-09）：三张 sandbox 票
> 停在 `testing`/`planning`，每轮启动恢复都报 `resumed: 1`，票一步不动；`pipeline_reset` 只认 failed/needs-info/gone，
> 也救不回来。这是「看起来恢复了、其实死透了」的典型，所以恢复后统一回队列。

**恢复流程覆盖不到 `failed`**：它只遍历 `listActive()`（pending 与中间态）。`failed` 是终态，
人照着通知「拨走再拨回处理中」重开之后，票带着**原样的**工作区坐标回到调度器 ——
所以调度器自己也必须有失效判定，见 §7.7 末尾的「陈旧坐标」。两处用的是同一个
`worktreeExists` 判定（`src/index.js` 用 `checkWorktreeByGit` 提供），口径不一致会出现
「恢复说没了、调度器说还在」这种最难查的分歧。

### 7.7 项目工作区（票 → 项目 → 宿主 Workspace）

工单表里**没有**「待修改项目」这一列（飞书那 13 列是固定的，加不了也不该加）。
归属只能由 `projects[].match` 决定 —— 一张表就是一个项目。项目一旦确定，
它的 `repo.path` 就是**这个项目的工作区目录**。

每张票开跑前（`worktree-ready` 之前），组合根的 `prepareWorkspace` 先调
`src/core/workspace.js` 的 `ensureProjectWorkspace({path: repoPath, title: projectId})`：

| 情形 | 结果 |
|---|---|
| 目录不存在 | 抛 `invalid-input`（「项目工作区目录不存在：… 插件不会替你克隆或创建目录」）—— 不是 ENOENT 原文 |
| 目录在、宿主里已登记 | 复用，**不写登记表**，返回 `{workspacePath, workspaceId, created:false}` |
| 目录在、还没登记 | `workspaceRegistry.create(path, title)` 补一条，返回 `created:true` |
| 本机没有 `workspaceRegistry`（headless / 老宿主） | 记日志降级，只返回路径、没有 id；票照跑 |
| `create` 抛错 | 记日志降级继续跑票（GUI 里少一个工作区分组，不该让整张票死） |

**为什么先 `resolveByPath` 再 `create`**：`create` 虽然对同一路径幂等，但会把新登记
工作区**置顶**到持久顺序。每张票都 create 一次 = 每张票都把人工作区列表搅一遍。
所以正常路径是「查到了就完事」，`create` 只在新项目第一次出现时跑一次。

登记下来的 `workspacePath` / `workspaceId` 落进 `TicketRecordRow`，执行器据此：
1. `agents.create({ meta: { cwd: workspacePath } })` —— 会话 header 的 cwd 是工作区根；
2. `setup` 里 `workingDirectory.set(agent, worktreePath)` —— 把这一轮的工作目录钉到改代码的落点
   （缺省模式 `worktreePath` 就是工作区根，这一步等于不换目录；打开 `isolateWorktree` 才是隔离检出）；
3. `workspaceRegistry.get(workspaceId).attachSession(sessionId)` —— 会话归属到该工作区，
   在 GUI 的工作区分组下能看到，而不是散落的孤儿会话。

**只有「会话 cwd 与改代码落点不是同一个目录」时才算需要钉，钉不了就抛 `invalid-input`**：
判据是 `worktreePath.length > 0 && workspacePath.length > 0 && workspacePath !== worktreePath`。
缺省模式（`isolateWorktree` 关）两者**相等**，`needsPin` 为 false，根本不需要 `workingDirectory` 服务
—— agent 就在会话 cwd 里改，正合本意。打开 `isolateWorktree` 时两者不同、又缺 `workingDirectory`，
才直接抛 `invalid-input`：继续跑就是在项目主检出里改代码，宁可这张票失败也不能偷偷污染人工位上的工作区。
没有工作区坐标时（离线自测、headless 链路）同样不 pin、也不要求 `workingDirectory` ——
那时 `meta.cwd` 本来就是改代码落点，行为与改造前一致。

**陈旧坐标：票据上有值 ≠ 还能用**（2026-11-06 真实事故 `pms|reczz28VWNWVbpgL`）。
调度器复用一个已有工作区之前必须先判失效，两种情形都算失效：

| 情形 | 判据 | 为什么 |
|---|---|---|
| 目录没了 | `worktreeExists(worktreePath) === false` | 旧隔离 worktree 被清掉、被人手工删掉 |
| 换了仓库 | 票据上的 `repoPath` ≠ 本次定位到的 `repoPath` | 配置从 `.repos/mgiot-pms` 改成 `D:/WorkSpace/mgiot-pms` 之后，旧 worktreePath 指向的是**另一个仓库里的有效检出**，路径存在但改了白改 |

判失效之后的两个规定动作：① 重跑 `prepareWorkspace`；② **把 `worktreePath` / `branch` / `baseCommit`
摘成 `undefined` 再传** —— 否则 `prepareWorkspace` 会走「已有 worktree，只补登记」那一支，
把死路径原样回传（`src/index.js:831-850`）。

**探测本身出错不算失效**：问不到不等于没有了。宁可复用旧坐标让真实错误暴露出来，
也不要因为一次 `git` 调用失败就把已有工作区每轮推倒重来。

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
| 测试环境起不来 | `testOutcome = 'not-run'`，仍做本地提交，原因写进 `testDetail` |
| `RepoLocator` 标了 `ambiguous` | 照常跑，prompt 里列候选并要求定不了就问人 |
| 目标仓库读不到 | `network` 处理，重试到上限 |
| 单据内容为空（`description` 空） | 直接 `invalid-input` → `failed` + 通知（这票没法做） |

### 8.3 通知文案模板

标题：`【{projectId}】{状态短语}｜{problemSummary}`（`{状态短语}` 见 §7.1 的中文名，
`skipped` 在通知里叫「已交付（验证未通过，待人工验证）」；注意它不是失败，通知按 `info` 级推。）

正文（`scheduler.renderNotifyBody`）：

```
项目：{projectId}
工单序号：{seq}
模块：{module}
优先级：{priority}

{描述前 3 行}

本地提交：{sha 前 12 位}[ @ {branch}][（{worktreePath}）]
draft MR：{url}                ← 只有开了远程出口（repo.gitlab.enabled: true）才有这一行
改动文件：{N} 个
- {file}
…
验证：通过 / 未跑成 —— {原因} / 未通过

（改动已交付到工作区检出；验证命令没通过，请人工确认这份改动是否可用）   ← 仅 skipped 的尾注
```

失败分支是另一套：`失败原因：{lastError}` + `工作区保留在：{worktreePath}` + 一句「修好之后把表格里
「是否处理」拨走再拨回「处理中」即可重跑」。needs-info 分支：`需要补充：{…}` + 怎么补。

`level` 约定：`info` = done、`warn` = skipped / needs-info / 超时 / 需人介入、`error` = failed。
`link` 只在开了远程出口、真有 `mr.url` 时才带；本阶段交付形态是本地提交，通常为空。

### 8.4 重试只认「抛出的错误」（实现约束，改代码前必读）

`scheduler` 的重试分档**只走 catch 分支**：

1. 租约丢了 → 回 `pending`，不通知；
2. `aborted` / 超时 → `failed`（超时才通知）；
3. 其它 → `attempt + 1`；`retryable && attempt < maxAttempts` 时回 `pending` +
   `enqueuedAt = now + backoff`，否则 `failed` + 通知。

**执行器「返回一个 `phase: 'failed'` 的结果」不经过这套分档** —— 那只是「这票做不了」，直接被 `setPhase(failed)` + 通知，不进退避队列。

所以 `executor-agent` 必须把「值得重试的外部失败」**抛出去**，而不是包成结果返回。已知的那一条就踩过坑：上游模型 429 配额耗尽被误报成「agent 没有产生任何文件改动」且标 `retryable:false`，于是票直接判死、也不会退避重试。现在的做法是：

- `agent-failure.js` 从 `agent.ctx.on('agent/error')` 与 `agent.session.log` 里最后一条
  `turn/end` 的 `reason.error` 读出真实失败（`code` ∈ `RATE_LIMIT` / `QUOTA` / … 或文案命中
  429 / quota_exceeded / 被限流）；
- 判定为限流 → `throw PipelineError('rate-limit')`（退避重试）；其余 → `internal`；
- 「最后一轮不是 error」时**不翻旧账**，避免拿上一次失败冤枉这一轮。

改动这一块时的验收：`scripts/gitlab-checks.mjs` 里有「最后一轮成功就不该被更早那轮的失败冤枉」与「限流要抛而不是返回 failed」两组断言。

---

## 9. `Config` 全量

用 `export const Config`（standard-schema 形状，见 `src/core/config.js`，不是 schemastery）。
值存在 profile 的 `cordis.patch.yml` 里本插件那一行，升级不丢。字段清单与默认值
以 `src/core/config.js` 的 `CONFIG_FIELDS` 为准（**25 个键、4 个分组**，设置页按 `CONFIG_GROUPS`
分组渲染；`projects` 子树另有 33 个可写字段，不在这 25 个里），下面是概览：

```ts
export const Config = {
  // ── 项目清单（核心，通用化的根）─────────────────────
  projects: Array<{
    name: string               // 项目唯一标识 = ticket.projectId
    description?: string       // 项目描述，进 agent 定位提示
    match: {                   // 工单表怎么定位（表级绑定）；各平台专有键见下
      platform: 'feishu' | 'wps' | 'mock'   // webform 已于 2026-11-09 移除（见 §15 / 工单 #18）
      // ── 飞书 ──
      appToken?: string        // 飞书多维表格 app_token；也可以直接写整条表格 URL（从 ?table= / ?view= 解析出下面两格）
      tableId?: string         // 飞书数据表 id（显式优先；不写则由 appToken 链接里的 ?table= 补上）
      viewId?: string          // 可选：只扫某个视图（不写则由 ?view= 补上）
      docNamePattern?: string  // 文件名模糊匹配（无显式绑定、链接里也没 ?table= 时的兜底）
      // ── 收票语义（飞书 / WPS 共用）──
      statusValues?: string[]  // 「在处理中」的状态取值集合，默认 ['处理中']
                               // 真实表下拉是 是/否/处理中，试点时配 ['否']
      recordIds?: string[]     // 收窄到指定工单（缺省=不收窄）。空数组是配置错误
                               // 语义：名单外的行整行跳过，不收票也不进水位
      allowedImageHosts?: string[] // url 形态截图的主机白名单；缺省为空 = 一律拒绝
      // ── 金山文档 ──
      sheetUrl?: string        // 共享链接，适配器会用全局 fetch 直接下 xlsx（大概率要登录态）
      sheetName?: string
      statusColumn?: string    // 状态列列名，默认「是否处理」
      statusValue?: string     // 单值形态的 statusValues（等价写法）
      mediaPrefix?: string     // 截图表里相对路径的前缀
    },
    repo: {
      path: string             // 本地 git 检出根目录（必填）
      remote?: string          // GitLab remote URL（只有开了远程 MR 出口才用得上）
      baseBranch?: string      // 建隔离 worktree 用的基准分支（不填则自动识别：origin/HEAD → 当前分支 → main；只在 isolateWorktree: true 时用到）
      targetBranch?: string    // 可选出口的 draft MR 目标分支（默认同 baseBranch）
      gitlab?: {               // 自建站点坐标（不填则从 remote URL 里解析）
        enabled?: boolean      // 远程 MR 出口总开关，缺省 false：不连远程、不要 GITLAB_TOKEN
        baseUrl?: string       // 例如 http://gitlab.example.com
        remote?: string        // 可覆盖 repo.remote
        projectId?: number | string // 数字优先，其次是 group/sub/repo 路径
      },
    },
    verify?: {
      build?: string           // 构建命令（如 npm run build），空串跳过
      test?: string            // 测试命令（如 mvn -o test），空串跳过
    },
  }>,

  // ── 行为（9）────────────────────────────────────────
  enabled: boolean,              // 默认 false。总开关：关着不扫表、不建工作区、不提交
  pollIntervalMinutes: number,   // 默认 3，1..60
  ticketTimeoutMinutes: number,  // 默认 40，5..180；超时只通知不重试
  maxAttempts: number,           // 默认 2，1..5（可重试错误的自动重试上限）
  workExecutor: 'mock' | 'agent', // 默认 mock。**enum 强校验**：写错（含大小写、尾空格）激活期直接抛 invalid-input 并列可选值，
                                  // 只有 undefined/null/空串才回落到 mock；以前静默退回 mock（agent 执行器已接线：真实起 agent 改码 → 跑验证 → 在工作区检出里做本地提交）
  provider: string,              // 默认 ''（留空 = 跟随当前会话默认；钉死一个 provider 换台宿主就跑不起来）
  isolateWorktree: boolean,      // 默认 false：直接在项目工作区的检出里改代码（检出脏也能跑，只提交 agent 改过的）；
                                 // true 才每票 `git worktree add -b <branch> .agents/worktrees/<branch>` 开隔离检出
  writeBack: boolean,            // 默认 true：票跑成 done/skipped 后回填「是否处理/处理结果/处理日期」三列；
                                 // 关掉就退回纯只读，一个写请求都不发
  writeBackStatus: string,       // 默认 '是'：回填时「是否处理」列写的值（空串回落 '是'）
  writeBackOnFailure: boolean,   // 默认 false（工单 #14）：打开后 failed/needs-info 也回填，但**只写「处理结果」一列**，
                                 // 绝不碰「是否处理」与「处理日期」—— 那两列填了等于对看板说「处理完了」。
                                 // 超时的票也写（人不在电脑前时表里那行正需要说话）；人工取消的不写（gone 也不写：行已被删）

  // ── agent 与模型（3）────────────────────────────────
  model: string,                 // 默认 ''（留空 = 跟随会话默认模型；钉死某个模型会在它被限流时让流水线全灭）
  maxTokens: number,             // 默认 32000，1024..200000
  agentPreset: string,           // 默认 'ptc'；空串 = 不挂 preset（agent 会一个工具都没有）

  // ── 通知（8）────────────────────────────────────────
  pushAdapter: 'mock' | 'pushplus' | 'qqmail', // 默认 mock。同样 enum 强校验：写错即抛 invalid-input 并列可选值
  notifyOn: string[],            // 默认 ['done','skipped','failed','needs-info']
  pushplus: { channel, callbackUrl },  // token 走凭据 PUSHPLUS_TOKEN；template 恒 txt（不再给配）
  qqmail: {                      // QQ 邮箱 SMTP 直发；授权码走 credentials 的 QQMAIL_AUTH_CODE
    host: string,                // 默认 'smtp.qq.com'
    encryption: 'tls' | 'starttls', // 默认 'tls'（465 直连）；starttls = 587 先明文再升级。端口由它派生，不再单独配 port/secure
    user: string,                // 发件邮箱，例如 3488029716@qq.com
    to: string,                  // 收件地址（可逗号分隔），微信推送一般用 QQ 邮箱→微信提醒
  },

  // ── 高级（4）────────────────────────────────────────
  leaseTtlMinutes: number,       // 默认 10，1..60（租约时长；心跳间隔是内置常量 60 秒，不给配）
  branchPrefix: string,          // 默认 'ticket-'，后接 <projectId>-<recordId>-r<修订号>（只在 isolateWorktree: true 时用于票分支）
  worktreeRetentionHours: number,// 默认 24，0..720（只有 isolateWorktree: true 才有 worktree 可清）
  keepSession: boolean,          // 默认 true：处理完把那次 agent 会话留在项目工作区名下（GUI 里能点进去继续追问）；
                                 // agent 实例无论如何都会释放，设 false 才连会话一起收掉
}
```

**已收成内置常量的 5 个**（`BUILTIN_LIMITS`，老配置里留着不报错也不生效）：`safePageRun`（20）、
`goneAfterScans`（3）、`concurrency`（恒 1：`scheduler` 的 `running` 标志单飞 + `store.pickNext()` 只取一张）、
`leaseHeartbeatSeconds`（60）、`fetchBeforeCreate`（true）。收走的统一理由：**改错会出事、改对没收益**。

**已删除的 5 个**：`pushplus.token`（→ 凭据 `PUSHPLUS_TOKEN`）、`pushplus.template`（恒 `txt`）、
`qqmail.port` + `qqmail.secure`（合成 `qqmail.encryption`，两件事必须配套）、`logLevel`（从来没有消费点）。

**凭据不进配置**：`pushplus.token`、GitLab PAT、飞书应用密钥全部走 `ctx.credentials`。
配置里的 token 字段只是占位，读取顺序是 credentials → 配置（空则视为未配置）。

**`enabled` 默认 `false` 的理由**：插件装上就自动开始扫表、跑票、改工作区里的代码并做提交是很危险的默认值。必须由人显式打开。

**`repo.gitlab.enabled` 也默认 `false`**：它是**远程 MR 出口的总开关**。缺省下执行器完全不需要 `GITLAB_TOKEN`、
不发任何 GitLab 请求，交付物就是工作区检出里的一次本地提交；只有项目显式写 `true` 且配了 `repo.remote`，
才走原来的 GitLab Commits API 开 draft MR。`config.js` 的 `validateProject` 只在严格 `=== true` 时把它透传下去。

**`writeBack` 默认 `true`，而 `enabled` 默认 `false`**：这两个默认值方向相反是有意的。
`enabled` 是「要不要开始干活」的总闸，必须人显式打开；`writeBack` 是「干完之后要不要把结果写回表里」——
用户就是不想再手工去表里更新状态才要这个插件，所以干完就该写。担心写错表就把 `writeBack` 关掉，
退回纯只读；`writeBackStatus` 只是换「是否处理」写的那个值（有的表用「已完成」）。
`writeBackOnFailure` 默认 `false`：失败票回填属于**行为变更**（升级后表里会突然多出内容），
所以缺省关；打开后也只写「处理结果」一列，「是否处理」保持「处理中」——
那两列是人的判据，插件替人写就说谎了（见 ADR-0006「决策 2 的修订」）。

**`keepSession` 默认 `true`**：处理完那次会话留在项目工作区名下（宿主 GUI 的会话列表里能看到并点进去追问
「为什么这么改」），而 **agent 实例无论如何都会在 `finally` 里释放** —— 保留的是会话记录，不是模型占用。
设成 `false` 才调宿主的 `sessions` 服务把会话一起收掉（`close` / `dispose` / `closeSession` 三选一，取到哪个用哪个）。

**拼错的键与已删的键：只警告，不拦启动**（2026-11-10，工单 #13）。`validateConfig` 在遍历完
`CONFIG_FIELDS` 之后会检查 `flatten()` 收进来的剩余键，产出 `warnings: string[]`：

- 命中 `REMOVED_CONFIG_KEYS` ⇒ 说清成因（「`concurrency` 已经是内置常量 1，不用再配」），并说明**留着不影响启动**；
- 其它未知键 ⇒ 用 `suggestConfigKey(key)` 拿编辑距离 ≤2 的候选，说「你要找的是 `pollIntervalMinutes` 吗？」；
  猜不出来就只说不生效，**不硬猜**。

警告不能用普通字段挂在配置对象上（`describeConfig`/面板序列化会把它当配置项显示），所以用
`Object.defineProperty(value, CONFIG_WARNINGS, { enumerable: false })` 挂一个 `Symbol.for('ticket-pipeline.configWarnings')`，
`readConfigWarnings(config)` 读回。两个消费点：`src/index.js` 的启动日志、`pipeline_doctor` 的第 2b 节。

**报错文案用「中文 label（原始键名） + fix」**：`configFieldLabel(path)` 从 `CONFIG_FIELDS` 的
`FIELD_PRESENTATION` 与 `buildProjectsDescriptor()` 派生的项目字段表里查中文名，`validateConfig` /
`validateProject` 的每条 issue 都是 `{ message, path, fix? }`。三个都不新增依赖（`editDistance` 是自实现的）。

**`workExecutor` / `pushAdapter` 是 enum 强校验，写错就停**：两个键在 `CONFIG_FIELDS` 里带
`enum: Object.freeze([...])`（`config.js` 的 `workExecutor` / `pushAdapter`），激活期由
`src/index.js` 的 `pickAdapterFactory(table, requested, fieldName, label)` 取工厂。语义刻意区分：

- `undefined` / `null` / 空串（含纯空白）→ 用 `mock`（首次安装与离线自测靠它跑通链路）；
- 写了任何别的值 → 必须是注册表里的键，否则抛 `invalid-input` 并列出可选值。

为什么不再用 `EXECUTORS[config.workExecutor] ?? EXECUTORS.mock`：写错一个字母（`Agent`、`agents`、带尾空格）
会让插件**悄悄用 mock 跑完整条链路** —— 不改一行代码，却给票打 `testOutcome: 'passed'`、写个假 commit sha、
回填表格写「已按工单改完并提交」，还能照常发通知。这类「看起来成功」的假执行是上线后最难发现的事故，
所以宁可激活期直接停。

**验证命令的超时与取消**：`src/index.js` 的 `VERIFY_TIMEOUT_MS = 30 * 60 * 1000`、
`VERIFY_TIMEOUT_EXIT_CODE = 124`；`makeCommandRunner(ctx)` 生成的 runner 收
`{ argv, cwd, signal, timeoutMs }`，把 `timeoutMs` 与 `signal` 一起交给宿主 `shell.resolve`，
外面再套一层 `Promise.race` 兜底（宿主版本忽略这两个字段时也要能走开并 `handle.kill()`）。
超时**返回 124 而不是抛**（沿 coreutils `timeout` 约定：124 = 命令没跑完，和「检查没通过」区分开）；
`signal` 已 aborted 时不启进程、直接抛 `PipelineError('aborted', ...)`。
宿主 `bash-local` 还会按它自己的 `maxTimeoutMs`（缺省 10 分钟）夹一次（`clampTimeout` 取 min），
所以真实上限是两者里小的那个 —— 要真的跑到 30 分钟得改 profile 的 bash-local 配置。
这一层不是「锦上添花」：没有它，一条卡住的 `npm test` 会让 `runOne` 永远停在 `await` 上，
`finally` 走不到、单飞标记 `running` 恒为 `true`，之后每次 tick 都直接返回 `already-running` ——
**整条流水线静默停摆，而且 `pipeline_cancel` 也取消不了**（票面超时只 abort 了 signal，子进程照跑）。

---

## 10. 可替换点（文件级）

```
src/
├── core/                          ← 内核：换平台时一行不改
│   ├── scheduler.js               ← tick、单飞、队列、租约续期、超时、清理
│   ├── store.js                   ← storageDomain 封装、phase 转移、租约
│   ├── recover.js                 ← 启动恢复（扫未完成票）
│   ├── config.js                  ← Config 校验（CONFIG_FIELDS + projects[]）
│   ├── workspace.js               ← 项目工作区：repo.path ↔ 宿主 workspaceRegistry 的登记
│   ├── worktree-path.js           ← isIsolatedWorktreePath（清理前的前缀校验，防误删主检出）
│   ├── plugin-version.js          ← 安装副本 vs 源码的文件级比对（判断「跑的是不是最新代码」）
│   ├── domain.js                  ← 平台无关的小工具（ID 归一、时间等）
│   ├── branch-name.js             ← 分支名 sanitize
│   ├── branches.js                ← 分支候选：parseBranchRefs / mergeBranchChoices / listBranches（给 baseBranch / targetBranch 当候选，绝不抛）
│   ├── prompt.js                  ← 给 agent 的 task 文案拼装（纯文本 + 图片块）
│   └── prompts.js                 ← 插件自带的提示词片段（面板/工具文案）
├── contracts/                     ← 只有类型与错误类，不 import 任何东西
│   ├── errors.js                  ← PipelineError + ErrorKind
│   ├── ticket-source.js           ← TicketSource / ScanResult / makeTicket
│   ├── repo-locator.js            ← RepoLocator / LocateResult
│   ├── work-executor.js           ← WorkExecutor / ExecCtx / ExecResult / Plan
│   ├── push-adapter.js            ← PushAdapter / NotifyMessage / PushReceipt
│   ├── record-filter.js           ← recordIds 收窄开关（resolve/create）
│   ├── git-status.js              ← `git -z` 状态/改名解析 + 插件自有目录排除规则
│   └── types.js                   ← Ticket / ScreenshotRef / Phase / 状态机
├── adapters/                      ← 唯一允许按平台改的地方
│   ├── source-mock/               ← 内存里造票，用于开发与自测
│   ├── source-feishu/             ← 飞书多维表格（分页 + 水位 + 指纹 + 截图；写回三列走 writeResult）
│   ├── source-wps/                ← 金山文档（xlsx/zip 自解析 + 可选 sheetUrl 取数）
│   │   ├── index.js               ← 平台适配（扫表、收票、截图归一）
│   │   ├── xlsx.js                ← 零依赖 xlsx 解析（表头定位、列别名、行号 recordId）
│   │   └── zip.js                 ← 零依赖 zip 解包
│   ├── source-webform/            ← 已移除（2026-11-09，工单 #18）；留档在 scripts/fixtures/source-webform/
│   ├── locator-table/             ← 通用仓库定位器：按 projectId 查 projects[]
│   ├── executor-agent/            ← 真 agent 改码 → 跑验证 → 在工作区检出里做本地提交（可选出口才开 draft MR）
│   │   ├── index.js               ← 主流程（起 agent、preset、基线快照、受保护路径快照、collect、verify、篡改自检、commitLocally、keepSession、可选 openDraftMr）；含敏感名单 SENSITIVE_FILE_PATTERNS（8 大类 41 条）
│   │   └── agent-failure.js       ← 从 session.log / agent/error 里读真实失败原因
│   ├── executor-mock/             ← 不发真改动的执行器，自测用（返回假的 commit）
│   ├── gitlab-client/             ← Commits API + draft MR 的最小客户端（只在 repo.gitlab.enabled=true 时被调用）
│   ├── push-pushplus/             ← PushPlus channel=clawbot
│   ├── push-qqmail/               ← 零依赖手写 SMTP（QQ 邮箱直发）
│   └── push-mock/                 ← 记录推送内容的假适配器
├── remote/                        ← 面板侧调用宿主工具的薄壳
│   ├── descriptors.js
│   └── host.js
├── tools/
│   ├── pipeline-scan.js           ← 工具 pipeline_scan
│   ├── pipeline-status.js         ← 工具 pipeline_status（只读查询队列与历史）
│   ├── pipeline-cancel.js         ← 工具 pipeline_cancel（人工取消在跑的那一票）
│   ├── pipeline-reset.js          ← 工具 pipeline_reset（人工重开 failed / needs-info / gone）
│   ├── pipeline-doctor.js         ← 工具 pipeline_doctor（环境体检：git / 仓库 / 凭据 / 通知 / 插件版本）
│   └── define.js                  ← 工具定义的最小封装（名字校验、文本块渲染）
└── index.js                       ← 组合根：三张注册表 + 能力装配器 + apply
```

### 注册表（`src/index.js`）

```js
// 1) 能力装配器：内核能代办的通用能力，适配器只用字符串声明自己要不要
export const CAPABILITY_ASSEMBLERS = {
  watermark:  (deps) => ({ getWatermark, saveWatermark }),        // 水位落盘
  secret:     (deps) => ({ getSecret: deps.readSecret }),          // 密钥现取
  localFile:  (deps) => ({ readLocalFile: deps.readLocalFile }),   // 路径形态截图
  scanTuning: (deps) => ({ safePageRun, goneAfterScans }),         // 扫描节流两个数
}

// 2) 绑定参数装配器：怎么从 projects[].match 里摘「这个平台怎么定位那张表」
//    缺省用飞书那套键；新平台字段名不同就在自己那一行写 match 覆盖。
export const DEFAULT_MATCH_OPTIONS = { build: (match) => feishuOptionsFromMatch(match) }

// 3) 三张静态注册表
export const SOURCES = {
  mock:    { capabilities: [], factory: createMockSource },
  feishu:  { capabilities: ['watermark','secret','localFile','scanTuning'], factory: createFeishuSource },
  wps:     { capabilities: ['watermark','scanTuning'], factory: createWpsSource,
             // 实验性（工单 #20）：主装配不注入 fetchSheet，选它的项目拿不到票；doctor 会报阻断。
             match: { build: (match) => wpsOptionsFromMatch(match) } },
  // webform 已于 2026-11-09 移除（水位只在内存、重启即重收），留档在 scripts/fixtures/
}
export const EXECUTORS = { mock: createMockExecutor, agent: createAgentExecutor }
export const PUSHES    = { mock: createMockPush, pushplus: createPushplusPush, qqmail: createQqmailPush }
// 仓库定位器只有 table 一种实现，不是可替换表：直接 createTableLocator({ projects })
```

`buildSourceOptions(entry, deps)` 按 `capabilities` 逐个调装配器拼出构造参数：
**没声明的能力一律不注入**（多余注入只会让「这平台到底依赖什么」变糊，还会把读本地文件、
读密钥这类宿主能力顺手递给不需要的适配器）。能力名写错只记日志跳过，不拖垮插件。

**为什么是静态表而不是目录自动发现**：

- 打包时 `files` 字段容易漏掉动态 import 的目录
- 构建期静态分析看不到依赖，tree-shaking / 类型检查都失效
- 出错信息只剩一个 `MODULE_NOT_FOUND`，定位成本高

静态表只多一行 import，换来可检查、可打包、可跳转。**「换适配器只需一行注册」的验收标准依然满足** —— 那一行就是表里的一行。

### 设置面板与 Remote 描述符

面板全在 `lib/client.js`（浏览器侧，不碰内核）。宿主 → 浏览器这条链路走自建的 typert Remote，
描述符在 `plugins/ticket-pipeline/src/remote/descriptors.js`：**不 import 任何宿主包**，所以注册与
`$mount` 共用同一份纯 JSON，不需要 codegen。**九个 direct 方法**（七个无参，两个带参）：

| 方法 | 返回 | 用途 |
|---|---|---|
| `ticketPipeline.doctor()` | 体检报告 | 设置页「立即体检」按钮 |
| `ticketPipeline.config()` | 配置快照 | 渲染整棵设置表单 |
| `ticketPipeline.projects()` | 项目清单的**扁平视图** | 渲染项目卡片；`appToken` 只给 `hasAppToken` + `appTokenPreview`（前 4…后 4），**明文绝不下发** |
| `ticketPipeline.branches()` | 每个项目检出的分支清单 | 给 `repo.baseBranch` / `repo.targetBranch` 当候选（`listBranches()` 跑 `git for-each-ref`）；按项目 index 对齐，某个项目配错只让它自己空着 |
| `ticketPipeline.setProjectTable(index, url)` | 写入后的项目投影 + 一句人话 | 面板「粘贴工单表链接」**唯一入口**：浏览器只转交整条 URL，**宿主**用 `parseFeishuLink()` 解析出 app_token / spreadsheetToken / tableId / viewId / sheetId，再经 `ctx.get('settings').mutate()` 写进 profile，并**把另一套定位字段清掉**（换表型时 `appToken`/`tableId` 与 `spreadsheetToken`/`sheetId` 不会并存）。这样四个定位键都不用卡片上的输入框，明文也永远不会出现在浏览器内存或请求体里 |
| `ticketPipeline.status(includeDone?)` | 与 `pipeline_status` **同一份**结果 | 设置页「运行」页签的票列表与汇总行。**不许另写一套算法** —— 工具侧早把「算结果」抽成了模块级 `collectStatus(options, args)`，Remote 直接调它（`view:'tickets'`，面板要明细不要按项目聚合）。`includeDone` 是 `acceptsUndefined` 的可选参数，对应面板上的「显示历史」勾选：不传 = `false`（先回答「还要我做什么」），传 `true` 才把终态票一起拉进来。**只认严格的 `true`** —— 面板把这个方法同时当 `onClick` 处理器用（`onRefresh: loadRun`），那里第一参是事件对象，从别的类型里猜意图会把「点一下刷新」变成「突然看历史」 |
| `ticketPipeline.scan()` | `{status, text}` | 「跑一轮」（等价 `pipeline_scan`）。同样复用 `collectScan()`；`disabled` / `already-running` 在这里就同步判掉，不叠后台任务 |
| `ticketPipeline.cancel()` | `{cancelled, text}` | 「取消当前」（等价 `pipeline_cancel`），复用 `collectCancel()` |
| `ticketPipeline.reset(recordId, projectId?)` | `{reset, reason, phase, text}` | 失败票行尾「重跑」（等价 `pipeline_reset`），复用 `collectReset()`。`projectId` 是 `acceptsUndefined` 的可选参数：**浏览器侧只传 1 个实参**，不传 `undefined` 占位（否则参数个数校验对不上） |

**连线方式：工具与面板共用「算结果」那一层，面板不做第二套口径。** `pipeline-status.js` /
`pipeline-scan.js` / `pipeline-cancel.js` / `pipeline-reset.js` 各自把 execute 主体抽成模块级的
`collectStatus` / `collectScan` / `collectCancel` / `collectReset`，工具的 `execute` 与
`remote/host.js` 的方法调的是同一个函数 —— 所以 `/run` 页签上的文字与对话里 `pipeline_status`
的输出天然一致，改一处不会漏掉另一处。`remote/host.js` 的 constructor 因此多收
`store` / `scheduler` / `gitRunner` / `log`（全部可选，缺了给人话错误而不是 `TypeError`：
`dev-run.mjs` 里有只传 `getConfig` + `doctorOptions` 的老用例）。

**`setProjectTable` 与 `reset` 是唯一两个带参的 Remote 方法**，它们的参数形状受两条约束（`@deepseek-ai/dsh-api-gateway`
与 `-typert-registry` 的实际行为）：浏览器侧按 `descriptor.parameters` 的**位置**组装 args、只写
`value !== undefined` 的项；宿主侧 `assertExactArguments()` 按 `wire` 名字做精确集合比对，多一个少一个都拒。
所以每个参数都必须显式写 `name` + `wire` + `source:'json'` + `codec` + `strictCodec`（生成代码里
`codec` 与 `strictCodec` 是同一份的两个引用，两边都写才和上游一致）；`scripts/client-check.mjs` 的
`checkParameters()` 逐参数核对这条，两端任何一处写歪都会在自检里红。

**`projects` 子树必须自己标 `meta.volatile = true`**（`config.js` 的 `buildProjectsDescriptor`）。
宿主的 `isVolatilePath(schema, path)` 只沿 `schema.dict` 下钻、**完全不认 `inner`**，而 `projects` 是数组 ——
深层路径 `['projects','0','repo','path']` 的 `'0'` 那一段只能从 `inner` 走。所以 volatile 必须标在
**数组节点自己**身上让它在第一步短路；子节点也一并标（宿主当前版本上游一个 volatile 就够，
但 `scripts/client-check.mjs` 的 `auditProjectsNode()` 会逐层查，将来宿主改成「沿途每段都要声明」时不用回头补）。

**写配置只发深层路径**（`{op:'set', path:['projects','0','repo','path'], value}`），
**绝不整数组替换** —— 整块替换会把别的项目条目、以及配置文件里手写的 `appToken` 一起抹掉。
`lib/client.js` 的 `collectOps()` 里守着这条。

项目清单在面板上可编辑（5 个分区 21 个字段，`projects` 子树共 33 个可写字段），
字段约束即时校验（必填 / 数字 min-max / enum / 列表按逗号切分）、脏字段有「已改」徽标与单字段撤销。

面板的**信息密度**由两层折叠 + 一层开关控制，因为一屏 42 个输入框时人和「随便点点」没区别：

- 项目卡片整体可收起（`.tp-proj-toggle`），**缺省展开** —— 人是来看「我该填什么」的；收起后头部仍留着
  「已改 N 项」「N 项待修」，折叠不能成为遮蔽错误的工具。
- 卡内 5 个分区各自可收起（`.tp-group-toggle`），折叠状态存在**独立**的 localStorage 键里
  （`ticket-pipeline:open-projects`，键形如 `p0:repo`），不能与全局配置分组共用 ——
  不同项目里同名的「仓库」组会互相带。
- `PROJECT_SECTIONS` 的 `advanced: true` / `onlyFor: 'wps'` 让缺省视图只剩 8 个常改字段；
  想配细节就勾「显示全部字段」。**改过或有错的字段永远露出来**（`exempt` 短路），
  否则改过的字段从界面消失、撤不回来，保存时却照样写进去。
- 隐藏 ≠ 删字段：`PROJECT_SECTIONS` 里 21 个 path 一个没少，`client-check.mjs` 的
  「面板 21 项与宿主 descriptor 对得上」照旧成立。

**视觉与操作的统一**（2026-11-06 UI/UX 改造，见 feature-checklist §1.15）：
面板浅灰底、卡片纯白圆角带极轻阴影，字段是「加粗字段名 / 输入框 / 浅灰说明」的上下三行
（不是左边一长串文字 + 右边输入框），颜色一律走 `--dsw-alias-*` token 不写死。三条操作纪律：

- **全页只一颗主按钮**（顶部「保存」）—— 凭据行原先各带一个小「保存」，页面上同时出现五六个
  「保存」谁也说不清点哪个会把什么写下去；现在凭据值攒着随顶部保存一起提交，行内只剩「清除」
  （破坏性，要二次确认）。
- **布尔项一律 `role="switch"` 开关**，不落回原生 checkbox；宿主 `practices.md` **禁止**加载
  `dsh-client-ui-primitives` 之类客户端包当模块，所以控件是自写的、抄宿主 markup/CSS/行为。
- **项目清单可增删**：卡片头「删除」→ `['projects','<i>']` + `unset`（宿主 `applyPathOp` 对数组是
  `splice(i,1)`），立即生效。「+ 添加项目」**不发 mutate** —— 只往本地状态 `projPending` 塞一条
  `blankProjectRecord()`（缺省 `match.platform: 'mock'`，唯一免凭据平台），在面板上垫一张标「未保存」
  的空卡片；点顶部「保存」时由 `collectOps()` 末尾的 pending 循环发
  `{ op:'set', path:['projects', String(projList.length + q)], value: buildProjectValue(...) }`
  （宿主 `applyPathOp` 允许 `index === length` 时 set 一项）。
  理由：宿主对**整份配置**做 `~standard.validate`，任一 issue 整笔回滚；新项目的 `repo.path` 必然
  先是空的，直接提交必被 `projects[n].repo.path 必须是非空字符串` 拒掉（见功能清单 §1.18）。
  这样新增与其它改动同属一个 revision，要么全成要么全不成。复用现有 `settings.mutate` 通道，
  **不新增 Remote 方法**；已保存项目的删除在有未保存字段改动时仍禁用，避免删完下标错位。
  `buildProjectValue` 只写非空值（空串/空数组/false 一律不写，否则 `statusValues: []` 会被判配置错），
  末尾兜底 `name` / `match.platform` / `repo.path` 三键。`renderedProjects` = `projList` + `projPending`
  的统一视图，编辑/撤销/校验/计数全走它；`onRemoveProject` 对 pending 只 splice 并搬移草稿键
  （`addProjectDraftKeys`），不发 mutate；保存成功与「放弃改动」都清 `projPending`。

`projects` 子树不再进普通字段渲染：`collectLeaves` 直接跳过它（`path[0] === 'projects'`），
否则它是 `type:'array'` 的结构化数组，会被 `draftValueOf` 拼成 `[object Object], [object Object]`。

**页签式布局：一次只面对一件事**（2026-11-09，见 feature-checklist §1.17）：

§1.15 之后用户仍说「太复杂、太丑」。复盘出的根因不是「显示得太多」，而是**这些块之间是什么关系没人告诉他**：

- 四个大区块（体检 / 凭据 / 参数 / 项目清单）首尾相接竖排在一条线上，一屏 1300 多字，四张卡片长得几乎一样。
  折叠只能把内容藏到别处，用户仍要在长列表里反复展开收起 —— 所以改成**并列的页签**：
  `TABS = [项目 / 参数 / 凭据 / 体检]`，`panels[activeTab]` **只渲染当前页**（不是藏起来），
  一屏字数降到 601 / 148 / 467 / 128。缺省停在「项目」，因为它是主线（一张工单表绑一个仓库），
  参数与凭据是一次性调好的配角。
  **工单 #16 之后变成五个页签，`TABS = [运行 / 项目 / 参数 / 凭据 / 体检]`，缺省停在「运行」**：
  「配置」这个词只对后四个成立，而人打开这个面板时的第一个问题几乎总是「现在跑得怎么样」——
  这一页以前只能回对话里敲 `pipeline_status`，不知道有这个工具的人根本无从查起。
  「运行」页不放任何配置项（配置在它右边的页签里），只放：状态行（开着/关着 + 「跑一轮」「取消当前」「刷新状态」）、
  汇总行（直接用 `collectStatus` 下发的 `tiers`，**浏览器里不重算档位**）、票列表（一行一张、可展开）、
  以及**失败票行尾的「重跑」**（`canReset` 由宿主按 `RESETTABLE_PHASES` 算好下发，面板不抄名单）。
  点过「跑一轮」后每 3 秒自递归 `setTimeout` 拉一次 `status()`，最多 200 轮；**不做 WebSocket / 实时流**，
  因为 `host.js` 只有 direct 调用没有 stream。
- **「显示历史」勾选（2026-11-10 补）**：这一屏缺省只列未收尾的票（`includeDone: false`），
  于是票一旦全部收尾，打开面板就是空的 —— 用户原话「在哪里能查到历史的工单处理流程」。
  修法是把 `includeDone` 做成 `status()` 的可选参数、在状态行右侧挂一个勾选，
  **缺省仍关着**（票据只增不删，反过来的缺省会在跑一个月之后让开屏渲染几百行）。
  勾选状态记在 localStorage 的 `ticket-pipeline:run-history`（值就是 `'1'` / 不存在），
  因为「重开面板又变回空白」会被读成「历史被删了」。切换时**立刻**按新口径重读一次，不等下一次轮询。
  空列表文案也随开关分岔：关着时说「没有未收尾的票」并提示可以勾上历史，开着才说「库里还没有任何票」。
- 页签角标只在**真有**未保存/待修时才挂数字，平时不占位：参数页 = 未保存的配置项数（有校验错转红显示错误数）、
  凭据页 = 待提交的凭据条数、项目页 = 未保存的项目改动数、体检页 = `problems.length`。
- **保存类提示不随页签切换消失**（`saveError` / `saveMessage` / `loadError` 渲染在页签内容之外）：
  保存针对整份配置，错在哪页都得看见。

视觉上「丑」的根因是**白叠白**：亮色主题下 `--dsw-alias-bg-layer-1/2/3` 与 `--dsw-alias-bg-base` 全是 `#fff`，
上一版把面板底设成 `bg-layer-1`、卡片设成 `bg-base`，层级只能靠 10% 透明度描边撑着；再叠三层套娃
（灰面板 → 白卡 → 灰项目卡）和每卡阴影，就成了「一堆框糊在一起」。改法：

- 面板**不铺底**（宿主设置区本就是透明的，铺 `#f9fafb` 像贴了一块异色区域），`max-width:880px`。
- 卡片用宿主自己的 `--dsw-alias-settings-card-fill` / `-stroke` + `--dsw-radius-lg`，**去掉阴影**。
- 页签抄宿主 `PluginsSettingsSection` 的**下划线式**（`border-bottom:.5px` + `[aria-selected=true]::after` 2px 底条），
  不用胶囊分段 —— 胶囊只在宿主少数工具条里出现。
- 项目卡拆掉自己那层灰底盒子：白卡里的一段 + `border-top:.5px` 分隔。
- 字号回归宿主比例：标题 18px/600、说明 13px、字段名 13px/500、输入框 32px 高。

### 判定标准（改完自己验一遍）

> 删掉 `src/adapters/source-feishu/` 整个目录 + `src/index.js` 里那个 import 和表里那一行，
> 插件仍能构建、仍能用 `projects: [{ name:'demo', match:{ platform:'mock' }, repo:{ path:'...' } }]` 跑通整条链路。

> 静态注册表背后的取舍写在 [ADR 0001：平台适配层可插拔](../adr/0001-平台适配层可插拔.md)；错误模型见 [ADR 0002：PipelineError 错误模型](../adr/0002-PipelineError错误模型.md)；工单正文不可信的边界见 [ADR 0003：工单正文不可信](../adr/0003-工单正文不可信.md)；插件为何要给 git/verify 显式申请完整文件权限见 [ADR 0004](../adr/0004-插件git需要完整文件权限.md)；飞书电子表格按表型分派的决策见 [ADR 0005](../adr/0005-飞书电子表格源按表型分派.md)。术语表在仓库根 [GLOSSARY.md](../../GLOSSARY.md)。

做不到就说明边界漏了 —— 有内核代码直接引用了飞书的细节，或者适配器之间互相 import 了。

---

## 11. 一次完整跑的时序

以「飞书出现一条命中 `match.statusValues`（缺省即 `是否处理 = 处理中`）的新行」为例：

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
        ├─ 组合根的 prepareWorkspace 先确保**项目工作区**（`repo.path` 这个目录在宿主
        │    workspaceRegistry 里有登记：已登记就复用，没登记就补一条，见 §7.7）
        ├─ isolateWorktree !== true（**缺省**）：inspectCheckout → describeDirtyCheckout，
        │    读状态统一用 `git status --porcelain -z -uall -- . <排除 .agents/worktrees>`；
        │    检出脏**只提醒不拒跑**（日志一句「工作区不干净，仍然照跑（只提交 agent 改过的文件）」），
        │    path = 工作区根、branch = 检出当前分支、baseCommit = 检出当前 HEAD
        │    —— 就在这份检出里改代码、就地提交，不建 worktree
        ├─ isolateWorktree === true：若 fetchBeforeCreate → git fetch <项目 baseBranch>，
        │    再跑 git worktree add -b <branch> `<repoPath>/.agents/worktrees/<branch>`
        │    （隔离层是可选的；没有 subprocess 时只返回工作区坐标，阶段照走）
        └─ onPhase('worktree-ready') 记 workspacePath/workspaceId/worktreePath/branch/baseCommit
             （先回填进 ws 再落库，执行器读 ws；缺省模式下 worktreePath === workspacePath，
               branch 是检出当前分支，不是新造的票分支）

T+0:02  onPhase('planning')，起超时定时器（40 min）
        ├─ 截图是**输入**不是阶段，在开工之前就取：
        │    逐条 source.loadScreenshot → 组合根 saveImage →
        │    attachments.saveImage({data, mediaType, name}) → ImageBlock{...}
        ├─ 内核渲染任务书：renderTicketPrompt() 出纯文本，renderTicketContent() 出「文本块 + 图片块」
        ├─ 调 executor.run(ticket, located, ctx)
        │    ctx 里 prompt / content / images 三个都给：老适配器只读 prompt，
        │    新适配器按 content 才看得见图；falsy 的图在 content 里被跳过
        └─ executor-agent 内部：agents.create({ sessionId, meta:{cwd: workspacePath},
              agentOptions: resolveAgentOptions(config), setup }) → agent.followup(msg)
              ← 必须 followup（inject 不唤醒 agent）
              ← header.cwd 是**项目工作区根**：宿主 attachSession 要求会话 cwd 正好
                等于工作区路径，隔离子目录挂不上
             setup 里做三件事：挂 preset、追加 sandbox/mode 与 approval/policy、
             attachSession 归属工作区；只有 worktreePath !== workspacePath
             （即 isolateWorktree 打开）时才把工作目录钉到隔离检出（workingDirectory.set）
           ★ 在 followup **之前**拍基线：createBaseline() 跑 `git stash create`
             （只造一个 commit 对象并回 sha，不写 ref、不动工作区、不动索引，
             `git stash list` 仍是空的）+ `git rev-parse HEAD` +
             `git status --porcelain -z -uall` 数人自己的未提交改动 +
             对每个 `??` 跑 `git hash-object -- <path>` 存内容哈希
             拍不下来就降级：日志里说明「人原本未提交的改动可能被一起提交」，票不失败

T+0:03  … agent 在改代码落点里读代码、定位、规划（缺省就是项目工作区的检出）
        └─ 报「定位完成」→ onPhase('editing')，存 Plan

T+0:30  … agent 改完 → onPhase('testing')
        └─ 验证命令从项目配置 verify.build / verify.test 注入
           （没配 verify 就跳过验证，验证结论记为「未跑成」，仍然做本地提交）

T+0:35  onPhase('mr-opening', '在工作区检出里做本地提交')
        ├─ 收集改动：有基线时 `git diff --name-status -z <baseline.sha> -- . <排除>`
        │    （比的是「agent 动手前」，所以人自己的未提交改动一个都不会进来；
        │     没有基线才退回 `git diff <baseCommit>`，此时两者等价）
        │    ∪ `git status --porcelain -z -uall -- . <排除>`
        │    ⚠️ `git diff` 看不见未跟踪新文件，而「新建文件」是工单最常见产物；
        │       漏了会连 committable.length === 0 一起判 failed
        │    ⚠️ 未跟踪文件再比一次内容哈希：与基线里那份相同 → 是人早就放在那儿的，跳过；
        │       人是 `git add` 进索引的改动同样被排除
        │    ⚠️ 一律走 `-z`：非 `-z` 下中文名是八进制转义、含空格名一定带引号，
        │       旧解析器会把引号写进提交路径 → git 找不到文件
        ├─ 敏感文件过滤后，若 agent 自己把它们 `git add` 过：
        │    `git restore --staged -- <敏感文件>` 退回未跟踪（白名单只放行 --staged）
        ├─ ★ 提交前复拍受保护路径快照，与 T+0:02 前那份比：
        │    `.git/` 的 10 个元数据文件（config / config.worktree / HEAD / commondir / shallow /
        │    packed-refs / info/attributes / info/exclude / info/grafts / info/sparse-checkout）
        │    + 28 个 git hook 名（githooks(5) 固定清单）+ 4 个插件 profile 文件
        │    （cordis.patch.yml / .yaml / cordis.yml / .yaml）
        │    —— 动过就把这些路径 `git restore --staged --` 撤回、判 failed + invalid-input（不可重试），
        │    理由「agent 改动了受保护的元数据（…），按约定不提交；请人工核查这些文件后再决定是否重跑」
        │    ⚠️ 这是「被发现」不是「被阻止」：git 看不见自己的元数据、profile 压根不在仓库里，
        │       没有「diff 里冒出一行」这种免费信号，只能自己拍哈希比对。
        │       拿不到 readFile 服务时跳过自检并记日志（安全降级：提交仍只含非敏感文件）
        ├─ git add -- <非敏感且非删除的文件>   ← 点名暂存（不用 add -A：全量暂存会让
        │    ⚠️ 敏感文件露在 index 里，人一提交就跟着走了；git 白名单也只放行 `add -- <文件>`）
        ├─ git commit -m <提交说明> -- <改动文件 ∪ 重命名前的旧路径>
        │    ⚠️ 删除路径不能进 add（会 fatal: pathspec did not match any files），
        │       但必须进 commit pathspec；重命名的旧路径同理，否则历史里变「复制」
        │    ⚠️ 过滤 application.yml 之类含真实凭据的文件：它们根本进不了 index，
        │       留在工作区，文件名写进提交说明的「未提交（疑似含真实凭据，按约定留在工作区）：」一行
        ├─ git rev-parse HEAD → sha
        ├─ 得到 ExecResult.commit = { sha, branch, files }
        └─ 只有 repo.gitlab.enabled === true 时才继续开远程 draft MR（可选出口）：
             git push 不可用（沙箱封死，见 §12）→ 改走 GitLab Commits API 物化
             POST /api/v4/projects/28/repository/commits
             GET /repository/branches/:branch 确认分支存在（POST 分支不存在也返 201）
             GET /merge_requests?source_branch=X&state=opened 去重
             POST /merge_requests { source_branch, target_branch, title:'Draft: [工单#N] 摘要', description }
             开完断言 draft === true

T+0:36  onPhase('done') / onPhase('skipped')
        ├─ 这一段落库时**同时**写 pendingEffects（见 §11.1）：
        │    终态字段 + 「还没做完的事后动作」在同一次 setPhase 里落下，
        │    这样进程在两者之间崩掉时，下次启动知道还有事没做完
        ├─ 存 commit.sha / commit.branch / commit.files、sessionId
        │    （有远程出口时一并存 mr.iid / mr.url）
        ├─ 释放 agent 实例（finally 里无条件 dispose）；keepSession !== false 时
        │    只记一句「agent 已释放，会话保留」，会话留在项目工作区名下 —— 宿主 GUI
        │    的会话列表里能看到并点进去继续问；keepSession === false 才调宿主
        │    sessions 服务的 close / dispose / closeSession（三选一，永不抛）
        ├─ writeBackFor()：`writeBack !== false` 且适配器实现了 writeResult
        │    且终态是 done/skipped 时，调一次 writeResult(recordId,
        │    { status: writeBackStatus, result: renderWriteBackResult(...), handledAt })
        │    → 回执落到票据 writeBack = { written, fields, at, note? }
        │    做完就 clearPendingEffect(key, 'writeBack')
        │    ⚠️ failed 不回填（表里留在「处理中」是刻意留的信号）；
        │       被取消就不写；回填失败只记日志，票态不回退、通知照发
        ├─ push.send({ title, body, level:'info' })：正文第一段是 项目/工单序号/模块/优先级
        │    + 描述前 3 行，**描述之后**才有一行
        │    「本地提交：<sha 前 12 位> @ <branch>（<worktreePath>）」；有 mr 时才多带 link
        │    ⚠️ writeBack.written === false 时正文多一行
        │       「回填表格：没写成 —— <原因>（表格里那一行可能还停在「处理中」，请手工改一下）」；
        │       成功时不加（预期行为，多一行只是噪音）
        │    发完就 clearPendingEffect(key, 'notify')
        ├─ 释放租约、清超时定时器
        └─ running = false

T+3:00  下一轮 tick()（队列空，只扫描 + 清理）
        └─ cleanupExpiredWorktrees()：done/skipped 且超 24h 的最多清 1 个
```

**关键点**：整条链路里，内核只调了四个接口。它不知道飞书的 URL、不知道 GitLab 的 API、不知道该改哪个 `.vue` 文件。
默认交付形态是**工作区检出里的本地提交**，GitLab 那一半（`commitLocally` 之后的 `openDraftMr`）只有项目显式
打开 `repo.gitlab.enabled: true` 时才发生 —— 内核连「有没有远端」都不关心，它只认 `ExecResult.commit` 或 `mr`。

### 11.1 事后动作补偿（`pendingEffects`）

回填与通知都是**在终态之后**做的外部动作，都可能失败或被打断（进程崩了、网络断了、用户关了窗口）。
如果只把它们当普通 `await`，中间崩一次就会永远丢掉：票据是 `done`，但表格停在「处理中」、人也收不到通知 ——
而且没有任何地方记得「还欠两件事」。

做法是把「还没做完的事后动作」和终态**同一次写入**落库：

```js
// scheduler.js，setPhase 到终态那一次
const pendingEffects = {}
pendingEffects.writeBack = { /* 待写的内容 */ }
if (willNotify(finalPhase)) pendingEffects.notify = true
await store.setPhase(key, finalPhase, {
  ...终态字段,
  pendingEffects: Object.keys(pendingEffects).length > 0 ? pendingEffects : undefined,
})
```

- **清一项用 `clearPendingEffect(key, name)`，刻意不走 `setPhase`**：`setPhase` 会重写 `finishedAt`，
  让「这票跑了多久」失真（见 `store.js` 的 `clearPendingEffect` 注释）。它只动 `pendingEffects` 一个字段，
  两个子项都清空时把整个字段删掉（而不是留一个 `{}`）。
- **待办只在「动作真的做成了」时清**（ADR-0007 修订了这条）：以前不论成败都清，于是「回填写失败了」
  这件事在存储里彻底消失 —— `replayPendingEffects()` 永远捞不到它，表格里那一行就永远停在
  「处理中」，而没有任何地方会说这件事。真机 `reczz28VYQARkYBL` 就是这么丢的。
  现在的规则：写成功 → 清；写失败且可重试 → 留着待办并累加 `attempts`；写失败且不可重试
  （飞书同步表 / 少列 / 电子表格只有读权限或那一行已被删）→ 清掉待办**同时**把人必须自己动手这件事记进 `delivery.writeBack.giveUp`。
- **启动时 `replayPendingEffects()` 补做**：只捞 `pendingEffects && TERMINAL.includes(row.phase)` 的票，
  补发通知前先记日志。`src/index.js` 的 `apply` 里在启动阶段调它一次。
- **`enqueue` / `revise` / `resetByHuman` 都不继承 `pendingEffects`**：那是「上一轮已经到终态、但事后动作还没补完」
  的标记，带进新一轮会让启动补偿在新结果上再补发一次旧通知。
- **`recover`/清理路径不写 `pendingEffects`**：否则每次启动都会捞到一批永远做不完的票。
- `pipeline_status` 会打一行「待补：回填表格」/「待补：通知」，接口里也有 `pendingEffects` 字段 ——
  否则表格停在「处理中」没人知道。

### 11.2 交付维度（`delivery`）：与 phase 正交

`phase` 答的是「流程走到哪一站」，`done` 只说明执行器认为活干完了。它**不**说明：

- 有没有可 review 的改动（执行器可能说 done 却既没有本地提交也没有 MR）；
- 表格三列写成了没有；
- 通知真的发出去了没有。

这三件事各有各的失败方式，且都不改变 phase。把它们挤进 phase 只会让状态机变成笛卡尔积，
所以单独记一个与 phase 正交的 `delivery` 维度，落在票据行上：

```js
delivery = {
  commit?:   { ok, at, error?, errorKind?, attempts?, giveUp? },
  writeBack?: DeliveryState,
  notify?:   DeliveryState,
}
```

- **写入点是三处**：`runOne` 终态之后（commit）、回填段之后（writeBack）、`notifyFor` 里（notify）。
- **读法**：`delivery[name].ok === false` 就是「该交给人的东西没交到」；`giveUp === true`
  表示「已放弃，人必须自己动手」。`pipeline_status` 用它给票标题行加后缀、算「交付未完成」计数。
- **为什么不复用 `writeBack` / `pendingEffects`**：`writeBack` 只是回执（写没写成），
  `pendingEffects` 只是「还没做完的事」的标记；前者说不出「放弃了」，后者说不出「做过了但失败了」。
  而 `notify` 连回执都没有 —— 它彻底是新的。
- 错误分类走 `errors.js` 的三张互斥表（`RETRYABLE_KINDS` / `FATAL_KINDS` / `CANCELLED_KINDS`），
  用 `retryPolicy(kind)` 得到 `retry` / `fatal` / `cancelled`。任何 kind 必须恰好落在一张表里
  （自测里有断言遍历 `ERROR_KINDS` 检查）—— `aborted` 曾经两张表都不在，导致分类是空的。

### 11.3 租约是 best-effort，不是原子 CAS

早先文档里把租约写成「CAS」（compare-and-swap）。实际宿主 `storageDomain` 的 table API 只有
`get` / `entries` / `put` / `delete`，**没有 compare-and-swap 原语**，`read` 与 `put` 之间也没有互斥。

所以真实保证是：

- **同进程**靠调度器的单飞标记 `running`（一个 tick 只跑一票，`already-running` 直接返回）；
- **跨进程**靠「put 之后再读一次确认」——被抢就记日志、让出这张票（写 `lastError`），不硬抢。

这不是「保证不会双跑」，而是「正常路径下单飞 + 抢到了能发现」。多进程同表跑同一票仍有极小的双跑窗口
（例如两边同时在 read 与 put 之间），代价是同一票可能被改两遍；`leaseTtlMinutes` 只影响「多久算过期」。

### 11.4 关键节点流程日志（时间线）

以前想知道「票卡在哪了」只能靠翻插件日志：日志是按时间散落的、没有结构，看到「阶段 → testing」之后
迟迟没有下一条，也说不清是卡在跑验证里还是已经死了。现在票据行上挂一个 `timeline` 数组，把
「获取工单 → 找到项目 → 检查工作区 → 建会话 → 改代码 → 跑验证 → 提交 → 回填 → 发消息」这条主链的
每个关键节点都写成一条带时刻、带成败的记录，`pipeline_status` 直接排成时间线并给出「现在停在第 N 站，
已 X 分 Y 秒没动」。

- **节点表**：`src/contracts/types.js` 的 `TIMELINE_NODES`（17 项）。9 个主站带序号
  ① `discover` 获取工单 / ② `locate` 查找对应工单的项目 / ③ `workspace` 检查工作区 /
  ④ `session` 创建会话（分支+模型） / ⑤ `editing` 处理工单问题 / ⑥ `testing` 跑验证 /
  ⑦ `mr-opening` 提交（本地提交 / PR） / ⑧ `writeback` 回填工单表 / ⑨ `notify` 发送消息；
  另 8 个补充站用 `no: '·'`（`worktree-ready` / `planning` / `pending` / `needs-info` / `done` /
  `skipped` / `failed` / `gone`）。**节点 id 就等于 phase 名** —— ⑤⑥⑦ 及终态由 `onPhase` 直接查表打点，
  不用维护一张「phase → 节点」的反查表（少一层状态机、少一处漏更新的地方）。

- **记录结构** `TimelineEntry`：`{ node, label, at, ok, detail? }`。`at` 是**写下这一刻**的 epoch ms
  （不是阶段开始时间），所以「相邻两条 `at` 之差」正好是上一站耗时、「现在 − 最后一条 `at`」正好是
  「距最后一次动静多久」。`ok` 只有布尔 `true`/`false`（没有「进行中」）：`✓` 做成、`✗` 没做成。
  `label` 自包含中文站名，渲染不必再查表。

- **谁打点**：`core/scheduler.js` 的 `markNode(key, node, detail, ok, label)` 是唯一写入口，
  内部 `store.appendTimeline(...)` 并包一层 `try/catch`（**记日志绝不能把票带崩**）；
  `markExtra(...)` 给补充站补上查表得到的 `label`。调度器在扫描入队后记 ①、定位仓库后记 ②、
  准备/复用工作区后记 ③、`executor.run` 的 ctx 加 `onFlow` 让真 agent 执行器通过 `reportFlow`
  上报 ④（会话 id / provider+model / 分支 / 工作目录），成功收尾记 ⑧⑨，各失败分支（超时 / 取消 /
  退避重试 / 不可重试 / needs-info / 租约丢失）记 ✗，启动补偿 `replayPendingEffects` 补做时标「补做」。
  ⑤⑥⑦ 与终态由 `onPhase` 自动记。

- **历史不清空**：`timeline` 是历史，不是这一轮的状态。`store.enqueue` 的 `if (existing)` 段显式
  `row.timeline = existing.timeline` 继承旧记录（与 `lastError`/`pendingEffects` 相反，那两个是本轮状态），
  `revise` 用 `{...existing}` 自然保留，`resetByHuman` 也不清空、只在末尾补一条 `pending` 分隔记录
  「人工重置，重新入队」，方便重开后对照上一轮走到哪。数组上限 80 条（跑完约 10–15 条），超了丢最旧；
  连续两条同 node 同 ok 会合并成一条（保留最新 `at`/`detail`），因为 `worktree-ready` 会被连触发两次。

- **`appendTimeline` 刻意不走 `setPhase`**：`setPhase` 每次重写 `finishedAt`（会让「跑了多久」失真）
  而且要过阶段转移校验 —— 而记日志可能发生在任何阶段（含终态），不该被阶段机拦住。

- **渲染**：`src/tools/pipeline-status.js` 的 `describeFlow(row, now)` 倒序找出最后到达的主站，
  算出 `stalledForMs`、`station`、`lastNodeOk`，`renderTimeline(row, now)` 排成
  `11-06 20:14:58  ⑥ ✓ 跑验证 —— 开始跑验证命令（上一站 5 秒）` 这样的行，末尾一句
  `▶ 现在停在第 ⑥ 站「跑验证」，已 3 分 25 秒没动。`；`needs-info` 特别写「这一站在等人，不是插件卡死」，
  终态写「已经收尾」。时间一律按固定 UTC+8 纯算术换算（Asia/Shanghai 1991 年后无夏令时），不赌机器时区。
  返回体 `tickets[]` 带 `timeline` / `stalledForMs` / `station` / `lastNodeOk`，便于机器读；
  `now` 可注入（缺省 `() => Date.now()`），整次查询用同一个「现在」，自测能写确定值。

- **④ 只有真 agent 执行器会记**：`executor-mock` 不调 `onFlow`（合法，老调用方不传等于不记时间线）；
  真 agent 的 `reportFlow` 也包了 `try/catch`，`onFlow` 抛错只记日志、不影响跑票。

### 11.5 `pipeline_status` 的两种视图：总览（缺省）与明细

以前 `pipeline_status` 只有一种输出形态：逐票一段，且 `includeDone` 缺省 `false` 会先把终态票筛掉。
两个后果在日常使用里都很难受：①票全跑完时只回一句「这次筛选一条都没命中」，明明库里有 6 张票；
②票一多，每票十几行，想看「哪个项目卡了」得从头往下翻。

现在加一个**视图参数** `view`（`src/tools/pipeline-status.js`）：

- `view: 'overview'`（**缺省**）：按项目聚合的总览。
  `summarizeProjects(rows)` 按 `row.projectId` 分组（空串当 `null` 归一组），每组算
  `{total, counts, tiers, needsYouCount, needsYou[≤3], awaitingReviewCount, awaitingReview[≤3], runningCount, running[≤3], queuedCount, latestActivityAt}`
  —— `needsYou` 是 `failed` + `needs-info`（要人动手的），`running` 是「非终态、非 pending、非 needs-info」。
  项目排序：`needsYouCount` 降 → `runningCount` 降 → `awaitingReviewCount` 降 → `projectId` 升。
  渲染在 `renderProjectOverview(projects, rowsByProject, now)`：抬头 `━━ 项目总览：N 张票 / M 个项目 ━━`，
  每个项目一行 `【pms】共 3 张｜需要你处理 1｜已交付 2｜最近动静 90 时 18 分前`，项目内每票一行
  `compactTicketLine`（`✗/· recordId｜阶段｜模块｜站⑤（已跑 X）｜最近动静｜失败原因`），
  **每项目最多 `OVERVIEW_ROWS_PER_PROJECT = 8` 张**，超出折成「……还有 N 张没列出（明细用 view="tickets" 看全）」
  —— 折叠只影响行数，`total` 仍是真实总数。
  **每票下面再多一行流程带**（`renderFlowLine` → `describeStations`）：把 9 个主站压成
  `①✓ ②✓ ③✓ ④✓ ⑤✓（5 分 18 秒） ⑥✓ ⑦✓ ⑧✓ ⑨✓｜全程 5 分 31 秒`。
  摘要是「现在怎么样」，流程带是「整条路走得顺不顺、哪站慢/哪站挂了」—— 这两问都答了才算
  「看得到全流程状态」，否则人还得切 `view: 'tickets'` 去翻九行日志。
  符号 `STATION_MARK = {ok:'✓', failed:'✗', now:'▶', unreached:'–'}`，**`now` 与 `ok` 必须分开**：
  停在⑥时标 ✓ 会让人以为在等下一站。图例 `FLOW_LEGEND` **只打一次**（在总览抬头下面），
  逐票重复九次解释会把总览撑成第二个明细视图。
  时长只标 **≥1 分钟**的站（`formatShortDuration`）：①②③④ 常常都在 1 秒内，九个都标反而看不出
  哪里慢。**终态票的最后一站不标耗时** —— 原地用 `now` 兜底的话，一张跑完 24 小时的票会显示
  「⑨发送消息（24 时 32 分）」，看着像卡在发消息上；只有非终态票才用 `now` 补最后一站。
  **老票没有时间线时不画全 `–`**，直接写「没有流程记录 —— 这张票的处理早于流程日志功能」：
  画九个 `–` 等于断言「插件当时一个站都没走到」，而事实是当时还没有打点这个功能。
  「现在停在哪一站」不自己算，直接取 `describeFlow(row, now).station.no` —— 两处各判一次，
  迟早出现「带子上说停在⑥、结论说停在第⑤站」。
  机器可读在返回体 `tickets[].flow = {stations[{no,node,label,state,at,elapsedMs}×9],
  reachedCount, total, failedStation, currentStation, totalMs, strip, noRecord}`，将来面板画进度条
  直接用这一份。
- `view: 'tickets'`：原来的明细（逐票一段、带完整流程日志）。`dev-run` 里 20 处老断言都显式传这条路，
  所以老行为一字未变。
- **传了 `recordId` 一律走明细**，不受 `view` 影响（查询单票时人要看的就是细节）。

两个刻意的口径决定：

- **总览永远按全库算**，`includeDone` / `limit` / `recordId` 都不参与。`filteredScope` 也据此改成
  `hasRecordId || (!overview && !includeDone)` —— 否则「总览 + includeDone:false」会被当成「筛过」，
  又回到「一条都没命中」那种答非所问。
- **新增 `view` 而不是改 `includeDone` 的缺省语义**：`includeDone` 已被 `dev-run` 里 22 处调用依赖，
  改缺省等于让几十条断言一夜换输出，而它们的断言对象其实与「总览」无关。

`lastActivityAt(row)` 是这两个视图共用的「最近动静」口径：候选 `finishedAt` / `timeline` 末条 `at` /
`startedAt` / `enqueuedAt`，过滤 `Number.isFinite` 后取 **max**（reset 过的票 `startedAt` 可能比时间线更早；
老票可能只有 `enqueuedAt`）。`tierCounts(counts)` 与 `formatDistribution` 共用 `PHASE_TIERS`，
未识别的 phase 归「其它」—— 两处各写一份档位表迟早出现「汇总说 1 张需处理，明细里却找不到」。

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

- 本地 commit 留在检出里给人看（**这就是本阶段的交付形态**，人 `git show <sha>` 就能 review）
- 真需要远端时才用 **Commits API** 物化改动（`actions[]` 按文件内容表达）—— 只在 `repo.gitlab.enabled: true` 的可选出口里发生

代价：远端那个 commit 和本地那个 SHA 不同、作者默认是 token 用户（可用 `author_name`/`author_email` 覆盖）。

### 12.3 MR 必须走标题前缀（只在远程出口打开时才相关）

`repo.gitlab.enabled` 缺省 `false`，本节只在那条可选出口真的打开时才适用：

- `draft=true` 参数被**静默忽略**（返回 201 但 `draft:false`）
- `wip_event=draft` 直接 400（参数未声明）
- 唯一有效：`title: "Draft: …"` → 201 且 `"draft": true`

**开完必须断言返回体 `draft === true`**，不能只看 201。

### 12.4 两个 GitLab 坑（同上，只在远程出口打开时适用）

1. **`source_branch` 不存在也返回 201** → 开 MR 前必须先 `GET /repository/branches/:branch`
2. **重复 MR 返回 409**（文案是中文）→ 只按状态码判断，不匹配文案

### 12.5 未决（地图 `Not yet specified`）

| 项 | 影响 | 何时定 |
|---|---|---|
| Web UI 面板 | 设置页已落地（**五个页签：运行 / 项目 / 参数 / 凭据 / 体检**，一次只画一页；运行页 = 队列状态行 + 汇总行 + 票列表 + 「跑一轮 / 取消当前 / 刷新 / 重跑」；25 个字段 / 4 组 + 项目清单可增删可编辑 + 分支下拉 + 两层折叠 + 总开关置顶、「显示全部字段」开关与组内「高级设置」、Label 置顶 + Switch、下划线式页签 + 宿主 `settings-card-*` token、**9 个 Remote 方法**（含带参的 `setProjectTable` 与 `reset`）+ 项目卡片「粘贴工单表链接」）；**队列看板已做（工单 #16）** —— 但刻意只做「看 + 三个动作」，不做图表/趋势、不做 diff 视图（改动摘要够用）、不做实时日志流（direct 没有 stream） | ~~有人真的想看队列时~~ **已完成** |
| 多张工单指向同一模块的冲突 | 当前靠串行天然规避，但是「时间换安全」 | 出现真冲突时 |
| 处理人绑定规则 | 当前不绑（只看 `statusValues`） | 有人抱怨「谁都能被派活」时 |
| 金山文档的开放平台取数通道 | 现在只能靠 `match.sheetUrl` + 全局 fetch（大概率要登录态），或宿主注入 `fetchSheet` | 要真跑多张金山表时 |
| 上游模型限流后的自动重试 | 执行器已能识别 429/QUOTA 并抛 `rate-limit`，但重试仍受 `maxAttempts`（默认 2）限制，配额窗口比这长 | 出现连续被限流时 |
| `recordIds` 是否该进内核 | 现在是适配器层各自实现（飞书/WPS/mock/webform），内核不认识白名单 | 再来两个平台时 |
| 微信双向回复 | `PushAdapter` 只有单向 `send` | 明确不做，除非需求变了 |
| 高优先级是否动手前问人 | 当前所有票一视同仁 | 出现高风险票时 |
| token / 时间预算 | 当前只有总超时，没有 token 上限 | 发现烧太多时 |

### 12.6 明确不做（`Out of scope`）

- 个人微信 bot 框架（wechaty / itchat / wcferry）—— 违反微信 ToS，有封号风险
- 自动合并 MR —— 人验收后自己合（本阶段连 MR 都不开，交付物是本地提交）
- `projects[]` 未配置的仓库
- `pms-miniapp` 小程序的自动化测试

> **已从「明确不做」里移出**：工单表状态回写曾经写在这一条下面（「用户明确只要只读」）。
> 用户 2026-11-06 改了口径：**处理完要回填表格** —— 「是否处理」改成「是」、
> 「处理结果」写清楚怎么处理的、「处理日期」写当天。落地方式见 §12.8，开关是配置项
> `writeBack`；关掉它就退回纯只读。扫描仍然只读，写只有一个入口 `TicketSource.writeResult`。

### 12.7 飞书适配器的落地细节（票 `12` 已实现）

实现文件：`plugins/ticket-pipeline/src/adapters/source-feishu/index.js`（1000+ 行）。离线自测在
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

**收票**只认「是否处理」列值命中 `match.statusValues`（缺省 `['处理中']`，真实表是 `['否']`），
不叠加任何别的条件。`match.recordIds` 是另一层收窄：名单外的行整行跳过、不进水位。
下拉字段的返回形状不固定（裸字符串 /
`{text}` / `[{text}]`），**必须先 `normalizeCellText()` 归一再判等**。

**退役有两条路**：①人把 `是否处理` 改成别的值（`否` = 待认领、`是` = 已闭环）→ 立刻退役；
②行被删了 → 连续 `goneAfterScans`（默认 3）轮没扫到才退役，静默、不通知、不删历史。
反过来，人把状态拨回 `statusValues` 里的值（缺省就是 `处理中`）= 手动重置 → 重新收票。

**绑定工单表有三条路**，任何一步命中 0 张或 >1 张都当**配置错误**（宁可报错让人改配置，
也不要扫错表把别人的表当工单表）：

| 给了什么 | 怎么找表 |
|---|---|
| `appToken` + `tableId` | 直接用（显式 `tableId` 优先） |
| `appToken` 是整条表格 URL（带 `?table=`） | `parseBitableUrl`（`src/contracts/types.js`）从 `?table=` 取 `table_id`、`?view=` 取 `view_id` 当 `viewId`；等价于"URL + tableId"，不用再另填 `tableId` |
| `appToken`（无 `tableId`、链接里也没 `?table=`） | `GET /open-apis/bitable/v1/apps/:appToken/tables`，按 `docNamePattern` 过滤，必须恰好 1 张 |
| 只有 `docNamePattern` | 先 `GET /open-apis/drive/v1/files` 找 `type==='bitable'` 且名字匹配的文档（必须恰好 1 张），再取它唯一的表 |

> **为什么 `parseBitableUrl` 住在 `contracts/` 而不是适配器里**：`validateConfig` 也得认这个写法。
> 只让适配器认得，用户在配置里只贴一条链接就会被「必须给 appToken+tableId 或 docNamePattern」
> 拦在启动前 —— 文档写的「贴一条链接就够」就成了空话。两边共用同一个纯函数，
> 解析规则只有一处，不会漂移。`feishuOptionsFromMatch` 里显式 `tableId` / `viewId` **优先**于
> 链接里的问号参数（别让 URL 覆盖人的明确意图）。
>
> 同一族里还有 `parseFeishuLink(raw)`（也住 `src/contracts/types.js`，`appToken` 的上一族）。
> 分工是：`parseBitableUrl` 回答「这条 `appToken` 里带的 `?table=`/`?view=` 是多少」（配置校验与
> `feishuOptionsFromMatch` 用）；`parseFeishuLink` 回答「人贴的这条链接是哪一种表、token 是什么」
> （面板「粘贴工单表链接」用）。后者**只跑在宿主进程里**（`remote/host.js` 的 `setProjectTable`），
> 浏览器只转交原始字符串 —— appToken 明文不进浏览器内存与请求体，这是 #11 定下的安全边界。

`docNamePattern` 先当正则用（`new RegExp(pattern,'i')`），正则不合法就退回「包含」。

**截图取字节**（三形态，`loadScreenshot` 只管拿字节）：

| 形态 | 怎么取 |
|---|---|
| `attachment{fileToken}` | `GET /open-apis/drive/v1/medias/:file_token/download`（Bearer tenant token） |
| `path{path}` | `ctx.fs.resolve()` + `ctx.fs.readBytes()`（由组合根注入 `readLocalFile`） |
| `url{url}` | 裸 `fetch`，但**先过 `match.allowedImageHosts` 白名单**：缺省为空 = 一律拒绝（截图地址是外部输入，不设白名单等于让填表的人替服务器发任意请求） |
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

**扫描只读、回填是唯一写入口**（2026-11-06 起）：

- `scan()` 全程只发 `GET` / `POST /auth/...` / `POST /records/search`，自测里有断言盯着：
  一旦出现 `records/update|batch_update|delete|create` 就失败。
- 唯一的写入口是 `TicketSource.writeResult()`，只在票据跑成 `done` / `skipped` 之后
  被调用**一次**（绝不在扫描/重试中间调），实现在飞书适配器里：
  `PUT /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/:record_id`，
  body `{ fields: { 是否处理, 处理结果, 处理日期 } }`。
- 写回由 `src/core/scheduler.js` 的 `writeBackFor()` 驱动，三条硬约束：
  ①**缺省只写 done/skipped** —— failed 不写，表里那行还是「处理中」，人一眼看出这票没成；
  打开 `writeBackOnFailure` 后 failed/needs-info 也写，但**只写「处理结果」一列**（工单 #14）；
  ②**回填失败绝不影响票态** —— 表格写不进去是网络/权限问题，不是这票白干了，只在
  `writeBack.note` 里记原因；③**被取消就不写**。
- 开关是配置项 `writeBack`（缺省 `true`）、`writeBackStatus`（缺省 `是`）与
  `writeBackOnFailure`（缺省 `false`）。关掉 `writeBack` 就退回纯只读。
- 字段缺失不算失败：表里没有这三列时适配器返回 `{written:false, note}` 而不抛
  （回填是附加动作，票已经处理完了）。

> ⚠️ 飞书应用对该表要有**写权限**。实测过只有读权限时写回返回 `code 91403 Forbidden` ——
> 这时票仍然是 `done`，只是 `writeBack.written === false`，`pipeline_status` 会显示
> 「回填表格：没写成 —— …」。

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

### 12.9 金山文档适配器的落地细节（**实验性：解析可用，取数通道未接**）

> **状态：experimental（工单 #20，2026-11-10）**
> `PLATFORMS` 里仍保留 `'wps'`，但**主装配不会注入 `fetchSheet`** ⇒ 选它的项目一张票都拿不到。
> 这不是「已支持」：面板下拉把它标成「实验性，需自行注入取数通道」，选中时卡片顶部亮橙框说明，
> `pipeline_doctor` 对 wps 项目直接报**阻断**。想自己接的人看下面「取数通道有两个，都靠注入」。
> 代码**故意保留不删** —— `xlsx.js` / `zip.js` 与 `source-feishu/sheets.js` 共用同一套解析口径，
> 删掉等于让电子表格那条路失去参照实现。

实现文件：`plugins/ticket-pipeline/src/adapters/source-wps/`，三个文件分工明确 ——

| 文件 | 职责 |
|---|---|
| `index.js` | 平台适配：扫表、收票、截图归一、水位、`recordIds` 收窄 |
| `xlsx.js` | 零依赖 xlsx 解析：zip 解包 → 表头定位 → 列别名 → 行号 recordId |
| `zip.js` | 零依赖 zip 解包（押 `zlib.inflateRawSync`） |

**为什么自己解析 xlsx**：宿主的表格能力不保证在插件进程可用，而金山这条路的输入
就是「一张导出的 xlsx 字节」。自己解的好处是离线可测、不依赖外部服务。

**取数通道有两个，都靠注入**：

1. `match.sheetUrl` → 适配器用全局 `fetch` 直接下 xlsx。共享链接大概率要登录态，
   非 2xx 时抛 `invalid-input` 并明确提示「请改用注入 `fetchSheet` 的方式接入」。
2. 宿主注入 `options.fetchSheet()` 返回字节（或 `{bytes}`），整个替换掉下载这一层。

两者都没有时抛 `MISSING_FETCH_SHEET`（`invalid-input`），**不会静默扫出一张空表**。

**资源标识是行号**：`buildRecordId(rowIndex)` → `'r' + rowIndex`。这是唯一跨轮次稳定、
又不需要额外状态的东西；代价是插行会让同一条工单换身份（已知缺陷，写在代码注释里）。

**「待修改项目」列进 `ticket.targetProject`，不顶 `projectId`**：`xlsx.js` 的列别名表
（`['待修改项目','所属项目','项目','系统']`）已经把值读进 `record.projectId`，但那是**表格里
人手填的自由文本**，而 `Ticket.projectId` 是配置里的项目名、是存储主键的一半。硬顶上去会让
同一张表的票散到不同主键下，还让「项目 → 本地仓库」的绑定失效。所以它单独走 `targetProject`，
只进任务书供模型参考。

**能力声明**：`capabilities = ['watermark', 'scanTuning']` —— 金山这条路不需要密钥，也不读本地文件；
水位必须落盘（否则重启后整张表当新票重收），扫描节流两个数来自全局配置。

### 12.10 飞书电子表格支持（已实施）

> **状态：已实施（2026-11-09）。** 本节先记「为什么必须做」（当时的四条硬证据，现在是四条**已修**的坑），
> 再记实施后的实际形状。设计全过程见 `docs/ticket-pipeline/feishu-sheet-source.md`（§12 是实施结果），
> 决策记录见 `docs/adr/0005-飞书电子表格源按表型分派.md`。

**实施前：电子表格 100% 进不来，而且报错文案会把人引到错方向。**

四条硬证据（都在**代码路径**上，与权限无关）：

| 证据 | 位置 | 说明 |
|---|---|---|
| wiki 节点查询把表型写死 | `src/adapters/source-feishu/index.js:763-766` | `get_node` 的 query 里硬写 `obj_type: 'bitable'` |
| `sheet` 被判成「不是多维表格」 | `src/adapters/source-feishu/index.js:770-775` | 抛 `invalid-input`，文案里写着「sheet=电子表格」不支持 |
| 云文档搜索只认 bitable | `src/adapters/source-feishu/index.js:713` | `searchBitableDocs` 只收 `type === 'bitable'` |
| 配置校验只认两种绑定 | `src/core/config.js:529-540` | `validateProject` 只给「`appToken`+`tableId`（`tableId` 也可以写在 `appToken` 那条链接的 `?table=` 里，`parseBitableUrl` 解析）」或「`docNamePattern`」二选一，只给 `spreadsheetToken` 的配置**启动时就被拒** |

**这是代码路径问题，不是权限问题** —— 错误文案（先说「不是多维表格」，再列一串 `docx` / `sheet` / `mindnote`）
很容易把人引到「去申请权限」的错方向，而实际上**哪怕权限全开也扫不出来**。

**实施后（同一位置现在的行为）**：`get_node` 的 query 只剩 `token`，表型读 `node.obj_type`；`sheet` 走
电子表格分支；云文档搜索改名 `searchCloudDocs` 并认 `type ∈ {bitable, sheet}`；`validateProject` 改成
四选一（`appToken`+`tableId` / `spreadsheetToken`+`sheetId` / `spreadsheetToken`+`sheetName` / `docNamePattern`）。
**2026-11-10 夜进一步放宽成「至少一个定位依据」**（`appToken` / `spreadsheetToken` / `docNamePattern`
三者有一个即可，不再要求配 `tableId` / `sheetId` / `sheetName`），理由见本节末「一个入口」。

**两种表型的八维对照**（下面每一行都是电子表格分支要单独处理的差异）：

| 维度 | 多维表格 | 电子表格 |
| --- | --- | --- |
| 绑定键 | `appToken` + `tableId` | `spreadsheetToken` + `sheetId` |
| 读值接口 | `bitable/v1 .../records/search`（**有分页**：`has_more` / `page_token`） | `sheets/v2 .../values/:range`（**无分页**，响应里根本没有这两个字段；单次上限 10 MB） |
| 行身份 | `record_id`（平台生成，稳定） | **没有** → 插件自造（`sh-seq-<序号值>` / `sh-row-<行号>`） |
| 行级 mtime | 有（`pickMtime`，`index.js:894-906`） | **没有** → 变更判定完全依赖指纹 |
| 元数据接口 | `bitable/v1 .../tables` | `sheets/v3 .../sheets/query`（**snake_case**，与 v2 读值接口的 camelCase 不是一套风格） |
| 早停 | 连续 `safePageRun` 条已知未变就停翻页（`index.js:1004-1005`、`:1031-1034`） | **不做早停**（没有 mtime、没有分页可停） |
| 截图 | attachment / path / url 三形态 | **只支持 path / url**（内嵌图片没有稳定可下载的 token 形态） |
| 表型判定 | —— | wiki 节点看 `node.obj_type`（`bitable` / `sheet`）；裸 token 先试 bitable 表清单再试 sheet 工作表清单；`docNamePattern` 时 drive 搜索扩 `type ∈ {bitable, sheet}` |

**不变契约的红利**：**不新增 `platform`**，仍用 `feishu` —— 表型是同一平台下的两种文档类型，不是新平台。
于是 `src/contracts/*`（`TicketSource` 契约、`makeTicket`、`fingerprintOf`）、`src/core/scheduler.js`、
`src/core/store.js`、`src/index.js` 的 `SOURCES` / `PLATFORMS` / `buildSourceOptions`
**一个字都不用改**。这正是 ADR-0001「加平台 = 加目录 + `SOURCES` 一行 + `PLATFORMS` 一个字符串」那套成本
**不用付**的原因。

**身份策略与代价**：电子表格没有 `record_id`，身份只能自造。默认取**序号列**的值（`sh-seq-<值>`），
序号为空时兜底物理行号（`sh-row-<行号>`，在 `raw.identitySource` 标 `fallback-row`），
同一轮序号重复直接报 `invalid-input`（**不静默取第一个** —— 静默取第一个 = 一张票吞掉另一张，最难查）。
已知代价：**在表上方插行会让所有后续行的行号身份整体漂移**（旧票退役 + 新票涌入）；序号被重填也会换身份。
金山源已经踩过同一个坑（`src/adapters/source-wps/xlsx.js:611-613` 的注释明确写了这个取舍），
电子表格分支**继承同一套水位与退役语义**，不另造机制。

**探测的错误分流**：探测阶段 `auth` / `rate-limit` / `network` / `internal` 类错误**直接抛**，不换接口重试 ——
凭据、限流、网络问题与表型无关，换个接口再试只会把真因埋掉。只有 `not-found` / `invalid-input`
才继续试另一种表型。两次都失败时，`invalid-input` 的文案要**列出每次尝试**
（沿用现有多候选 app_token 的写法，`index.js:806-810`）。

实施时补了第二种「不该换接口」的情形：**已经证明是多维表格也别换**。`resolveBitableTableByIdentity`
把数据表清单读回来了、只是 `docNamePattern` 匹配不上 —— 这说明 token 就是多维表格，换 sheet 接口
重试只会把「表名写错了」这个真因埋掉。做法：抛错对象上打 `confirmedBitable = true`，
`shouldTrySheet(error)` 见到它回 false。

**探测结果缓存**：`tableCache`（`index.js:359-360`，现形状 `{appToken, tableId}`）升级为带 `kind` 的联合类型，
一轮扫描只探测一次（`scan` 开头调 `resolveTable`，`index.js:917`）。

**落地形态**：新增 `src/adapters/source-feishu/sheets.js`（579 行：列名别名、工作表定位、range 拼装、
读值解析、行身份、日期/优先级归一 —— 全是纯函数），`index.js` 只做分派 —— 与金山源同构
（`source-wps/index.js` + `source-wps/xlsx.js`）。`scan` 拆成 `scanBitable` / `scanSheet` 两条互不干扰的路径。

**人工前置**（与多维表格**两套独立 scope**）：`sheets:spreadsheet`（**读写**；只读够读票，
但回填那三列会被拒 —— 工单 #22 起是硬前置）或 `drive:drive`；
电子表格所有者要手动「…」→「…更多」→「添加文档应用」把应用加为**可编辑**协作者
（`POST /drive/v1/permissions/:token/members` 只对 `user_access_token` 有效，插件用的是
`tenant_access_token`，**无法自举** —— 同 §12.8 记的多维表格那条）。改完权限必须**创建版本并发布**。

**面板上的形状**（2026-11-09 起）：项目卡片里多一组「飞书电子表格」（`onlyFor: 'feishu'`），8 个字段
按 `lib/client.js` 的 `PROJECT_SECTIONS` 画；`sheetName`（工作表名）挪到「工单表」组统一画一次 ——
两个组各画一次会变成两个输入框绑同一个草稿键。`sheetColumns`（列名覆盖）用一行文本
`description=我的列名, status=我的状态`，保存时由 `parseColumnsDraft()` 解析回对象。

> **2026-11-10 夜已收敛**（见下「一个入口」一节）：组名改「表格读取参数」，
> `spreadsheetToken` / `sheetId` / `tableId` 三个输入框撤掉，定位工单表只留卡片头上的「工单表链接」。

**多维表格也一样（工单 #21 起）**：`match.columns` 与 `match.sheetColumns` 完全同形、同一个
`kind: 'columns'` 控件，只是白名单用 `contracts/feishu-columns.js` 的 13 个语义字段。两种表型
共用 `source-feishu/sheets.js` 的 `mapColumns({ actualNames, overrides, aliases })` —— 电子表格拿
表头行做 `actualNames`，多维表格每轮先读 `/fields` 的真实字段名（`resolveBitableColumns()`，
结果缓存在 `columnCache`，`activeColumns()` 在未解析时回落规范名）。**代价与收益**：每轮多一次
`/fields` 请求（single-flight，整轮复用），换来「字段叫『缺陷描述』也能收票」而不是静默 0 张。

**回填（工单 #22 起，2026-11-10）**：早期这是块挡板（`written: false` 只读回执），因为电子表格没有
`record_id`、行号会漂移。**挡板的问题不是缺功能，而是会自我放大**：「是否处理」永远停在「处理中」
⇒ 下一轮扫描把同一张票再收一次。现在的做法：把读表那一段从 `scanSheet` 抽成 `readSheetValues()`
（扫描与回填共用，避免「按 A 列认、往 B 列写」），回填时**重新读表 + 按身份列重新定位行**
（`writeSheetResult()`），一次 `values_batch_update` 写三格（逐格 PUT 会在中途失败时留下「写了一半」）。
四种失败各给专属 `errorKind`：行没了 → `not-found`；缺列 → `unsupported` + 列出表里实际列名；
只有读权限 → `auth` + 点名 `sheets:spreadsheet` 与「重新发布版本」；限流 → 交给 `retryPolicy()` 分档。

**自测**：`dev-run` 384 → **451**（19 条电子表格断言）→ **482**（#22 回填 8 条）→ **483**（探针归一 spreadsheetToken 1 条，其中
「回填过的那一行下一轮不会被重复收票」是这一票的核心断言）→ **486**（总览流程带 3 条，见 §11.5）；
`feishu-checks` 60 → **80** → **93**；`client-smoke` **175** 条 `check(`。

完整设计、代码落点清单与排期见 `docs/ticket-pipeline/feishu-sheet-source.md`（§12 是实施结果与三处
与设计不同的决定）；决策记录见 `docs/adr/0005-飞书电子表格源按表型分派.md`。

**一个入口（2026-11-10 夜）**：以前「工单表」组、「飞书电子表格」组和卡片头上的「工单表链接」行
**三处都能指定同一件事**，用户在设置页上同时填了两套 token，然后问「根本不清楚用的那个」——
而实际生效的是 `resolveTable()` 的判定顺序，那东西根本不在配置里。现在：

- **面板**：只留「工单表链接」一个入口（`ProjectCard` 的返回体从 `[wpsNotice, ...sections, tokenRow]`
  改成 `[wpsNotice, tokenRow, ...sections]`，链接行提到最上）。`match` 组删 `tableId`，
  `sheet` 组改名「表格读取参数」并删 `spreadsheetToken` / `sheetId` —— 剩下的只有读取细节
  （表头行号、序号列名、行身份、读取范围、列名覆盖、强制表型）。面板画出的项目字段从 33 项降到 **30 项**
  （`client-check` 会报出剩下落差的四条：`match.appToken` / `match.tableId` /
  `match.spreadsheetToken` / `match.sheetId` 只能改配置文件或经「工单表链接」写入）。
- **适配器**（`source-feishu/index.js` 的 `extractSheetToken`）：四种写法都认 ——
  `/sheets/<token>` → `/wiki/<token>` → 裸 token → `shtcn…`；带协议头却一个都不匹配时
  **抛 `invalid-input`**，不再「原样返回整串」去拼 404。这就是「电子表格取不到工单」的直接原因：
  知识库里的电子表格从地址栏复制出来是 `/wiki/<token>?sheet=…`，两处正则都命中不了，整条 URL 被
  `encodeURIComponent` 拼进 `/open-apis/sheets/v3/spreadsheets/<...>/sheets/query`，飞书回
  `HTTP 404 404 page not found`。实测（2026-11-10）wiki token 与 `obj_token` **都能直接当
  `spreadsheetToken` 用**，不需要多调一次 `get_node` 换算。
- **错误码**：`INVALID_INPUT_ERROR_CODES` 补上 `1254003 WrongBaseToken` ——
  它是「拿电子表格 token 去问多维表格 `apps/{token}/tables`」时飞书回的业务码，
  `shouldTrySheet()` 只在 `invalid-input` / `not-found` 上才降级去试电子表格，
  归成 `internal` 就会被当**真故障**抛出去 ⇒ 只贴裸 token 的电子表格永远走不到电子表格分支。
- **配置校验**（`core/config.js` 的 `validateProject`）：从「四选一」放宽成
  **「`appToken` / `spreadsheetToken` / `docNamePattern` 至少有一个」** ——
  不再要求 token 必须配 `tableId` / `sheetId` / `sheetName`。理由：面板只有一个入口，
  而 `/wiki/<token>` 不带 `?table=`/`?sheet=`，运行期本来就能自己解决；配置层硬拦等于
  「运行期能跑、配置层不让存」，逼人回头手改 YAML。两套 token 并存**不拦但警告**
  （走 `warnings` 通道，与「未知键只警告」同一套）。例外：`/base/` 链接缺 `?table=` 且没有
  `docNamePattern`、也没有 `spreadsheetToken` 时**仍然拦** —— `/base/` 是多维表格自己的地址栏形态，
  飞书一定带 `?table=`，不带是坏输入；非 `/base/` 的 URL 缺配套参数只警告，否则 wiki 表会被全挡在门外。
- **`?sheet=` 不能丢**（`contracts/types.js` 的 `parseFeishuLink` wiki 分支 + `remote/host.js` 的
  `setProjectTable`）：wiki 里既能放多维表格也能放表格，`?sheet=` 只在那确实是表格时有意义；
  丢掉会让「一个工作簿多张工作表」退回取第一张。所以 bitable/wiki 分支从「无条件 `unset sheetId`」
  改成「有 `?sheet=` 就 set、没有才 unset」。

**自测**：`dev-run` 486 → **492**（5 条：wiki 链接能过校验、两套并存给警告、1254003 降级、
整条 wiki 链接要抠出 token 再请求、认不出的链接要报 `invalid-input`；「显示历史」另 1 条见 §11.5）；
再涨到 **495**（体检补状态值口径 2 条，见 §12.13）；再涨到 **498**（`tableId` 抢走电子表格分派
1 条 + `tableId`/`sheetId` 并存警告 1 条，见 §12.15）；
`feishu-checks` 93 → **96** → **97**；`client-smoke` **219** 条。

### 12.11 插件改动为什么会静默不生效（`pipeline_doctor` 第 5 节）

宿主加载的不是本仓库的源码目录，而是 profile 下的一份**目录副本**
（`~/.dsh/profiles/desktop/node_modules/@local/ticket-pipeline`）。三件事叠起来，导致「改了没生效」且**没有任何报错**：

1. **`file:` 依赖是复制不是软链**。profile 的 `package.json` 写的是
   `"@local/ticket-pipeline": "file:D:/WorkSpace/dsh-ticket-pipeline/plugins/ticket-pipeline"`，
   但源在 `D:`、pnpm store 在 `C:` —— 跨盘时 pnpm 落成目录副本（同盘才会硬链接）。
   实测两侧 `src/index.js` 的 `fsutil file queryfileid` 是两个不同 ID，`LinkType` 为空。
2. **`pnpm install` 不会刷新它**：输出 `Lockfile is up to date` / `Already up to date`，一个字节都不动。
3. **HMR 不会自己发现**：base 组合里 `hmr` 的 `root: []`（不监听源码目录），默认 `ignored` 还含 `node_modules`。
   只有 profile 重组（改 `cordis.patch.yml` / 走 Plugin Manager 操作）时才会比对
   `node_modules` 下已加载文件的 mtime/size 并替换 —— 也就是**偶然**生效，不能依赖。
   另外浏览器侧模块图走独立加载机制，`lib/client.js` 改了必须刷新页面。

⇒ 所以 `runDoctor()` 第 5 节（`src/core/plugin-version.js`）比的是**安装副本与源码的文件内容**：

- **基准是 profile 里声明本包的那条 `file:` / `link:` 路径**，不是 `package.json` 的 `version`
  （两侧都是 `0.1.0-test.1`，比了没用），也不是 `origin`（本阶段交付形态是工作区里的本地提交，
  origin 长期落后本地，方向反了）。
- **只比会真被加载的文件**：`src/**/*.js`、`lib/**/*.js`、`cordis.patch.yml`、`icon.svg`、`locale/*.json`。
  `README.md` / `scripts/` 不比，否则改文档就误报。
- **链接安装直接判过**：`installedDir` 不含 `node_modules`（从源码直接跑）或两侧 `realpath` 相同 ⇒ `linked: true`。
  profile 目录不硬套三层相对路径，`findProfileDir()` 沿路向上最多 6 层找真的声明了本包的那份 `package.json`。
- **只进 `warnings` 不进 `problems`**：装旧版插件票照样能跑完，记成 `problems` 会让人以为流水线坏了。
  落后时文案直接给出「把 `<sourceDir>` 同步到 `<installedDir>`，然后重启宿主」。
  **同步动作本身有脚本**：`node scripts/sync-install.mjs`（`--dry-run` 只看不改、`--dir <path>` 指定目标，
  缺省遍历 `~/.dsh/profiles/*/node_modules/@local/ticket-pipeline` 并核对 `package.json` 里的 `name`
  才动 —— 同名不同包不能误伤）。它只写安装副本：多出的旧文件一并删（例如 #18 移除的 webform 源），
  源码目录一个字节都不动。
- 比对器**绝不抛**：路径不存在、profile 声明缺失、源码目录里没有可比文件，全部走 `ok: false` + `reason`，
  `runDoctor` 把它渲染成 `ℹ️ 插件版本：无法比对（<原因>）`。

同一份 `doctorOptions` 同时喂 `ctx.tools.register(createPipelineDoctorTool(...))` 与
`new TicketPipelineRemote({ doctorOptions })`（`src/index.js:974-1004`），所以对话里的
`pipeline_doctor` 与设置页「立即体检」按钮的版本结论天然一致，不需要两处维护。

### 12.12 执行器的安全兜底（三层，都不是硬隔离）

agent 在本机跑，能执行任意命令。宿主给不出「只读自动批、写入弹卡」这一档
（`APPROVAL_POLICIES = ['ask', 'never']`，见 `executor-agent/index.js` 文件头与实跑 warn 日志），
所以 `approval/policy` 实跑是 `never` —— 无头场景下 `ask` 会 fail-closed，让每一步工具调用都失败。
真正兜底只有三层：

**一、git 白名单**（`assertAllowedGit`）：只放行插件自己需要的那几个形态 ——
`add -- <具体文件>`、`commit`、`rev-parse HEAD`（与自检要用的 `--git-dir` / `--git-common-dir` 形态）、
`restore --staged -- <文件>`、`stash create`、`hash-object -- <path>`。
`add -A` / `add .` / `push` / `stash pop|apply|drop` 一律拒绝 —— 全量暂存会让敏感文件露在 index 里，
人一提交就跟着走了。

**二、敏感文件名单**（`SENSITIVE_FILE_PATTERNS`，**8 大类、41 条正则**，原 9 条）：`.env` 家族、
Spring 配置（`application*` 与 `bootstrap*`）、包管理器 token、SSH·GPG 私钥、云与容器凭据、
明文机器凭据、证书·密钥库·Terraform 状态、关键字兜底 `secret`。
命中就**不进提交**，文件名进 `ExecResult.blockedFiles` 与「未提交」那一行。
名单用「已知后缀白名单」而不是通配（`env\..+` 会把 `src/env.js` 也拦掉），
所以 `src/env.js`、`docs/credentials.md`、`.environment.md` 这类代码/文档不会被误伤 —— 这条有专门断言守着。

**三、提交前的元数据篡改自检**（**这是「被发现」不是「被阻止」**）：
git 看不见自己的元数据（`.git/` 不在 `diff`/`status` 视野里），插件 profile 更不在仓库里，
所以没有「diff 里冒出一行」这种免费信号。只能在 agent 动手前拍 sha256 快照、提交前复拍比对：

| 保护对象 | 数量 | 为什么 |
|---|---|---|
| `PROTECTED_GIT_FILES` | 10 | `config`（能改 `core.hooksPath` 把 hook 指到别处）、`config.worktree`、`HEAD`、`commondir`、`shallow`、`packed-refs`、`info/attributes`、`info/exclude`、`info/grafts`、`info/sparse-checkout` —— 改这些等于劫持执行器自己的提交动作 |
| `GIT_HOOK_NAMES` | 28 | `githooks(5)` 的固定清单；git 只会执行名字在这份清单里的 hook，agent 想留后门只能占其中一个文件名。按名字列全而不是「列出目录里有什么」，因为执行器没有目录列举能力 |
| `PROTECTED_PROFILE_FILES` | 4 | `cordis.patch.yml` / `cordis.patch.yaml` / `cordis.yml` / `cordis.yaml` —— 插件的装配清单，改它等于改宿主行为 |

动过就把这些路径 `git restore --staged --` 撤回、判 `failed` + `invalid-input`（不可重试，
因为重试只会重复篡改），理由写「agent 改动了受保护的元数据（…），按约定不提交；请人工核查这些文件后再决定是否重跑」。
快照用 `options.readFile` 而不是 `fs`（本文件坚持不 import 宿主包），存的是 sha256 而不是原文
（`.git/config` 里可能有远程地址与凭据片段，没必要在工作区多留一份明文）。
拿不到 `readFile`（老宿主/纯 mock）就跳过自检并记日志 —— **跳过是安全降级**：提交仍只含非敏感文件，
只是少了「元数据被动过」这一层告警。

### 12.13 体检与适配器必须认同一套输入形态与口径（`pipeline_doctor` 飞书连通性）

体检（`src/adapters/source-feishu/probe.js` → `src/tools/pipeline-doctor.js`）和扫票
（`src/adapters/source-feishu/index.js`）是**同一件事的两份实现**。两份实现各自「看起来合理」的判定，
合起来就是「扫票明明是好的，体检却报红」—— 2026-11-10 的真实事故。

**第一条：表型不能靠字段名猜。** 面板「工单表链接」贴 `/wiki/<node_token>` 时，
`remote/host.js` 的 `setProjectTable` 把**裸 wiki token 写进 `match.appToken`**
（`parseFeishuLink` 对 wiki 返回 `{ kind: 'wiki', appToken: wikiToken }`），
而那个节点背后可能是多维表格，也可能是电子表格。所以：

- 适配器 `resolveTable()` 的顺序是：`tableKind` 显式指定 → `spreadsheetToken` 非空 →
  `appToken` 非空时先看 `isWikiToken`，是就 `probeWikiNode` 问 `obj_type` 再按结果分派 →
  否则先 bitable 后 sheet 双试。
- 体检必须照抄这套顺序，不能写成 `if (spreadsheetToken) sheet else if (appToken) bitable`。
  后者会拿 wiki token 去问 `/bitable/v1/apps/<token>/tables`，飞书回
  `1254003 WrongBaseToken`（**HTTP 200 + body 里的业务码**，不是 4xx）。

**第二条：「类型不对」与「真故障」要分开。** 只有「你拿错类型来问我」才值得换条路再试：

| 归类 | 错误码 / 形态 | 为什么 |
|---|---|---|
| 类型不对，可降级 | `1254003`（WrongBaseToken）、`1254005`/`1254006`/`1254007`、表不存在 `1254043`/`1254045`、非 2xx 的 `400`/`404` | 换成另一种表型再试可能就通了 |
| 真故障，不许降级 | 凭据错（`10013`/`10014`/`99991663`）、限流、网络错 | 换条路只会把真因埋掉 |

两边用的是同一份集合（适配器 `shouldTrySheet()` ↔ 探针 `shouldFallbackToSheet()`，
探针侧常量 `TYPE_MISMATCH_CODES`）。归错类的代价是单向的：`1254003` 若归成 `internal`，
「只贴裸 token 的电子表格」**永远走不到电子表格分支**。

**第三条：体检要验「验完能不能真跑起来」，不只是「接口通不通」。** 权限、表、数据三项全绿，
票仍然可以是 0 张 —— 中间隔着一个**状态值口径**：

| 表型 | 表里「是否处理」的实际取值 | `statusValues: ['处理中']`（缺省） | `statusValues: ['是']` |
|---|---|---|---|
| 电子表格 | `是` 73 / `否` 7 / 空 119 | **0 张** | **73 张** |
| 多维表格 | `是` 73 / `否` 7 | **0 张** | **73 张** |

缺省值是 `IN_PROGRESS_VALUE = '处理中'`（`index.js:73`），而这张表根本不填「处理中」。
现在探针会采样状态列实际取值（`STATUS_SAMPLE_ROWS = 100` 行；电子表格用 `mapColumns` 认列后逐行取，
多维表格用 `BITABLE_COLUMN_ALIASES` + `normalizeCellText` 认字段），产出
`{ ok, values, expected, message, fix }` 挂在每个项目的 `statusValues` 上：

- 一个都对不上 → `ok: false`，文案给出「表里实际是哪些值 / 配置认哪些值 / 这样一张票都收不到」+ 修法；
- 至少一个对上 → `ok: true`，并把「表里出现什么」也印出来；
- 采样里没有非空值，或认不出状态列 → **不产出这一层**，交给列映射那层报得更清楚。

`pipeline-doctor.js` 把它渲染成 `　⚠️ 状态值对不上：…` 并**只进 `warnings` 不进 `blockers`**：
收不到票不等于流水线坏了，人可能正按别的状态值跑。

**第四条：归一化的输入形态要往回调。** 探针曾经把 `match.spreadsheetToken` 原样拼进请求路径，
于是「面板上贴整条链接」这个被文档推荐的做法在体检里必然 404 —— 而适配器
`extractSheetToken` 一直是归一的。现在探针的 `extractSheetToken` 认四种写法
（`/sheets/<token>`、`/wiki/<token>`、裸 token、`shtcn…`），与适配器对齐。

**判据**：改其中一边的输入形态或错误分类时，**必须同时看另一边**。
两边不一致时，错的那一边通常是「报错更晚」的那个 —— 它把矛盾包装成了用户的操作错误。

### 12.14 面板的两条写入通道：凭据与配置不能串成一个总闸

设置面板上有两条**互不相干**的写入通道：

| 通道 | 命名空间 | 语义 | 失败的含义 |
| --- | --- | --- | --- |
| 配置 | `settings.mutate` | 深层路径 set/unset，整份校验，要么全成要么全不成 | 有一条不过校验，整笔回滚 |
| 凭据 | `credentials.set` | 逐条写宿主凭据库，不进配置文件 | 单条失败，与其它条目无关 |

**纪律：一次「保存」必须同时发起两条通道，谁空都不影响另一条。**

这条纪律是从一次真实事故里立起来的（见 `docs/ticket-pipeline/feature-checklist.md` §1.29）：
`onSave()` 先算 `collectOps()`，**为空就 `return`**，而写凭据那一段挂在这行 `return` 之后。
于是「只填凭据、不动任何配置字段」这个再正常不过的操作，变成了**能点、计数会涨、点了什么都不发生**。
凭据没写进去，面板还替人宣布「没有需要保存的改动」。

三条推论：

1. **判定「有没有未保存的东西」与「保存会做什么」必须用同一份真相。** 当时页签计数
   (`tabBadge`) 把 `credDirty` 算进去了，`onSave()` 却没有 —— 两个函数各记各的，
   用户看到的就是「挂着 1 项未保存」和「没有需要保存的改动」同时出现。
2. **别用空集合当总闸。** `ops.length === 0` 是「配置没有改动」，不是「没有事情要做」。
   把它当早退条件是把自己的耦合藏进了一个 `if`。
3. **两个通道刻意不 `await` 互等。** 凭据失败只报凭据那条，配置照样发出去；反之亦然。
   串行化会让一个慢通道卡住另一个，还会把两件独立的事的错误混成一个。

**判据**：给面板新增第三种写入通道时，先问「它在不在 `onSave()` 里？早退条件会不会把它吞掉？」
凡是「能被用户点亮、但走了另一条通道」的东西，都在这个问题的射程内。

### 12.15 定位捷径不能跳过「这 token 到底是哪种表」

飞书的 `tableId`（多维表格的数据表）与 `sheetId`（电子表格的工作表）**不是两套并列的定位方式**，
而是两种表型各自的坐标。可这条区别在配置里看不出来 —— 两个键是平级的字符串，都是「填了就更准」。

有一步捷径让这个区别变成了真实故障（2026-11-11，pms 项目）：

```js
// 旧写法：resolveBitableTableByIdentity
if (tableId) return { kind: 'bitable', appToken: resolvedAppToken, tableId }
```

现场配置同时有：

```yaml
appToken: It5gwQ9sMizJh0kdbDhc2rBfnug   # 裸 wiki token，背后是一张电子表格
tableId:  tblWhRSGf0osJqrE               # 上一轮用多维表格时留下的
sheetId:  3a5d28
```

裸 wiki token 不以 `wiki` 开头、也不含 `/wiki/`，`isWikiToken()` 认不出来，所以走
「原生 token：先按多维表格试」那条路。配了 `tableId` ⇒ 上面那句**一个请求都不打**就返回
`kind:'bitable'`，于是：

1. 表型分派被 `tableId` 直接抢走，永远走不到电子表格分支；
2. `shouldTrySheet()` 的降级路也被堵死 —— 降级只在**定位失败**时发生，这里「成功」了；
3. 一路拖到 `resolveBitableColumns` 去问 `fields` 才炸，报 `1254003 WrongBaseToken`。

而**体检说「能读」**：探针认表型是问 `get_node` 的 `obj_type`，不认 `tableId`。两边口径不一致，
人只看到「电子表格不能用」，报错还是一句后端黑话。

**修法两层，缺一不可**：

- **运行期**：配了 `tableId` 也先问一次 `tables`。token 真是多维表格只是多一个请求（行为不变）；
  是电子表格就在这里失败成 `invalid-input`，`resolveTable` 照常降级去试 sheet。
- **配置期**：`tableId` 与 `sheetId` 同时存在就出警告，说清「这是两种表型各自的坐标」并建议重贴链接
  （`src/core/config.js` 的 `validateProject`，与「两套 token 并存」那条警告并列）。

**第三层：写入期必须成对 set/unset**（复盘时才补上的，前面两层放不住这个病）。

建议里那句「重贴链接就好了」当时并不成立。`src/remote/host.js` 的 `setProjectTable` 的 else 分支
（贴 wiki / 多维表格链接时走）原本是：

```js
if (parsed.tableId.length > 0) ops.push({ op: 'set', path: [...base, 'tableId'], value: parsed.tableId })
if (parsed.viewId.length > 0) ops.push({ op: 'set', path: [...base, 'viewId'], value: parsed.viewId })
```

**只有「有就 set」，没有「没有就 unset」。** wiki 链接不带 `?table=`，这两句根本不执行，旧的
`tableId` 原样留着。用户按建议重贴一次，`spreadsheetToken` 被清、`appToken` 换成 wiki token，
那个**属于另一个多维表格 App** 的 `tableId` 却还在原地。

真机取证（现场那个 `tableId` 不是「不新鲜」，是**外来 id**）：

| 问题 | 答案 |
| --- | --- |
| `appToken: It5g…` 是什么 | wiki 节点，`get_node` → `obj_type: sheet`、`obj_token: MuVEsnmEbhnYH8tDUyvc0c6Wnch` |
| 拿它问 `apps/<token>/tables` | `code: 1254003 WrongBaseToken` |
| 拿它问 `spreadsheets/<token>/sheets/query` | `code: 0`，1 个工作表 `{id: '3a5d28', rows: 199}` |
| `tableId: tblWhRSGf0osJqrE` 属于谁 | **另一个**多维表格 App `RZZQbY4SkaY6z0shZaBcVpQCnhh` |

修法：`tableId` / `viewId` 改成与 `sheetId` 一样成对 —— 有就 `set`，没有就 `unset`。
语义上也站得住：新贴的链接没指定数据表，那么任何旧的 `tableId` 都属于**上一张**表，留着只可能指错。

**判据（两条）**：

1. 任何一条「配了 X 就不用再验证 Y」的捷径，先问「X 是否蕴含 Y」。
   不蕴含的话，这条捷径省下的那一次请求，迟早会由用户在别处付出一次排查。
2. 任何一处写了「条件 `set`」，立刻问「条件不成立时旧值怎么办」。
   `set` 与 `unset` 必须成对考虑 —— 缺一半的写入逻辑不会报错，只会让配置越用越脏。

**为什么这次特别难查**：同一个毛病在两条路径上表现不同 —— 体检 ✅ 全绿（探针走 `get_node`，认得出
电子表格），真正跑票的 `source.scan()` 却抛 `WrongBaseToken`，而后者只出现在后台 tick 里，界面上
一片安静。体检的绿色会主动掩盖故障，所以运行期改完必须补一条 `feishu-checks`（假服务端 + 假 token），
配置期改完必须补一条 `dev-run`，写入期改完必须补一条 `dev-run` 的 `setProjectTable` 用例；
修好一条路径不等于修好这个毛病。

### 12.16 内容块的字段名是宿主的契约，不是我们随口起的

2026-11-11，pms 第一张真实工单 `sh-row-81` 在 ⑤ 站崩了：

```
agent 这一轮以错误结束：Cannot read properties of undefined (reading 'attachmentId')
```

它带一张截图。同批没截图的票一切正常 —— 这就是这个 bug 藏了这么久的原因：
整条流水线只有**附图**的票才会走到那行。

#### 原因

内核渲染消息内容块的地方（`src/core/prompt.js` 的 `renderTicketContent`）原先是：

```js
blocks.push({ type: 'image', image })   // ← 字段名自己起的
```

而宿主 `@deepseek-ai/dsh-llm` 的 `ImageBlock` 契约是：

```ts
export interface ImageAttachmentRef {
    attachmentId: AttachmentId
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
    name?: string
    originalDimensions?: { width: number; height: number; }
}
// ImageBlock: { type: 'image'; attachment: ImageAttachmentRef; offloaded?: boolean }
```

宿主管这个字段叫 **`attachment`**，且所有读图代码一律写 `block.attachment.attachmentId`：

- `dsh-llm/lib/types/content.js` 的 `collectImageRefs`：`refs.set(block.attachment.attachmentId, block.attachment)`
- `dsh-llm/lib/types/content.js` 的 `imageIdentity(ref)` / `textOnlyImageText(ref)`：`ref.attachmentId`
- `dsh-llm-pi-ai/lib/index.js`：`case "image": requestImages.get(block.attachment.attachmentId)`
- `dsh-llm-deepseek/lib/index.js` 的 upload index 校验：`/^sha256:[0-9a-f]{64}$/u.test(record.attachmentId)`

我们的块上没有 `attachment` ⇒ 宿主取 `undefined.attachmentId` ⇒ 崩在它自己的代码里，
堆栈里连我们的文件名都没有。

#### 更值得记的：我们的自测把错误形状抄了进去

`scripts/dev-run.mjs` 与 `scripts/chain-smoke.mjs` 里本来就有断言覆盖这条链路，但写的是：

```js
assert.equal(imageBlocks[0].image.refId, 'img-1')   // dev-run
for (const block of images) assert.ok(block.image)   // chain-smoke
```

**断言照着实现写的，而实现在照着自己的想象写。** 两边自洽，所以 498 条全绿；
真正的契约方（宿主）从来没被引用过一次。修完实现之后这两条断言立刻变红 ——
它们不是「测到了」，只是「附和了」。

修法是把契约抄进测试（`plugins/ticket-pipeline/src/core/prompt.js` 里也补了
`ImageAttachmentRef` 的 typedef），断言改成：

```js
assert.equal(imageBlocks[0].attachment.refId, 'img-1')
assert.equal(imageBlocks[0].image, undefined, '不能把引用放在 `image` 字段上 —— 宿主读的是 `attachment`')
```

#### 判据

1. **跨进程边界的结构体，字段名归对面所有。** 我们只负责把值塞进它认的名字里；
   名字对不对，唯一的权威是宿主的类型声明，不是我们的注释。
2. **自测里凡是断言「某个外部契约的形状」，必须能从契约本身引证。** 否则那条断言
   只是在给实现盖章：实现错了它跟着错，还替错误背书。
3. **「只有带 X 的输入才崩」的 bug，先看有没有一段只在 X 存在时才走的分支。**
   全绿的自测 + 少数输入崩溃，通常说明测试的输入面比真实输入面窄。

#### 影响面

只有 `src/core/prompt.js` 生产 image 块（`grep "type: 'image'"` 在 `src/` 下仅此一处）；
消费端只有 `src/adapters/executor-agent/index.js` 的 `buildMessages`，它把 `ctx.content`
原样交给 `createUserMessage({ content })`，不改形状。其余适配器（`executor-mock`、
`push-*`）不碰内容块。所以修一处即可，不存在第二份实现。


### 12.17 进步信号要选你真的关心的那个量（执行器停滞看门狗）

2026-11-11 `sh-row-81` 超时失败。`pipeline_status` 只给了「⑤ 站 38 分 53 秒」这一个数字，
把 agent 的会话日志解出来才看清实际形状：

| 指标 | 实测值 |
| --- | --- |
| 会话跨度 | 2 422 秒 |
| 工具调用次数 | 63（全部是 `run_code`） |
| 涉及文件 | 23 个，平均每个被读 **2.0** 次 |
| 单次调用最长间隔 | 119 / 103 / 102 / 82 / 77 / 72 / 69 / 66 秒 |
| **写/改过的文件** | **0 个** |

39 分钟里它一次都没改代码，全在读和搜。而 `waitForAgentIdle` 那 39 分钟完全满意：
`session.seq` 一直在涨（每次读文件都涨），在它眼里这就是「持续进展」。

**教训是：`session.seq` 是「这个 agent 还活着」的信号，不是「它在推进这件事」的信号。**
两者在一个只会读不会写的循环里完全脱钩。要判有没有进展，只能看**这件事的产出物**变了没有 ——
这里就是工作区里的文件。

#### 实现

`plugins/ticket-pipeline/src/adapters/executor-agent/index.js` 的 `waitForAgentIdle` 新增
`options.worktreeSnapshot`（缺省不启用，自测传桩），每轮循环开头调 `checkStall()`：

```js
const fingerprint = await options.worktreeSnapshot()      // git status --porcelain -z 的 stdout
if (fingerprint !== lastFingerprint) {
  lastFingerprint = fingerprint
  lastProgressAt = now()
  nudges = 0                                             // 有新改动就把额度还回去
} else if (nudges < maxNudges) {
  nudges += 1
  await options.onStall?.({ minutes, nudgeCount: nudges })
  agent.followup(makeNudgeMessage(minutes))              // 催，但不中止
}
```

配套的两个常量放在 `src/core/config.js` 的 `BUILTIN_LIMITS`：

| 键 | 值 | 为什么是这个值 |
| --- | --- | --- |
| `agentStallWarnMinutes` | `8` | 必须远小于整票硬超时（`ticketTimeoutMinutes` 缺省 40 分钟），否则轮到它的时候票已经死了 |
| `agentStallNudges` | `2` | 催一次 = 一轮完整往返（可能好几分钟）；无限催会把「卡住」变成「烧钱」。催了不杀 —— 杀一张票等于整张重跑 |

催话术（`createNudgeMessage`）刻意**不提「你花太久了」**：模型被指责会先解释自己为什么慢，
白烧一轮。第一版说的是「挑最有把握的那一处，直接改」—— **这句在 2026-11-11 同一天被推翻**：
它是「交一版大概是这儿」的许可，而流水线要的是真修好。现在催话术改成把两条定位路径
（操作流程 ⇒ 页面、截图字面量 ⇒ grep）再讲一遍，出路改成「定位不到就说缺哪一条信息」。
「确实定位不到就停下来，这会被当成需要人补信息，比拖到整票超时好」。

#### 一个实现上的坑（自测抓出来的）

`checkStall()` 第一版放进了这个分支里：

```js
if (agent.status !== 'idle' || seq !== idleSeq) continue   // ← 错在这里
```

它永远进不去 —— `await agent.whenIdle()` 本身就阻塞到空闲，循环体能执行一次就说明它刚做完一批
工具调用。放到 `await agent.whenIdle()` 之后、`seq` 判断之前才对。

#### 判据

1. **判「是否在进展」的，必须是这件事的产出物，不是活动量。** CPU、token、工具调用次数、
   `seq` 都是活动量。
2. **看门狗只在「能叫醒它」的时候有用。** 只记日志不干预等于没装；但干预也不能是中止 ——
   中止的代价是整张票重跑，通常大于再等 8 分钟。
3. **阈值要跟兜底机制比，不能跟「感觉」比。** 8 分钟看门狗 + 2 次催促，必须能在 40 分钟硬超时
   之内跑完它的全部动作，否则永远不触发。

**2026-11-11 当天又补了两个坑**（都是看门狗上线后第一次真机跑就撞上的）：

1. **兜底分支引用不到工厂闭包里的变量。** `waitForAgentIdle` 是模块级导出函数，而 `createUserMessage` 是 `createAgentExecutor()` 里的局部量。兜底那条 `: (mins) => createNudgeMessage(mins, createUserMessage)` 在生产路径（没传 `makeNudgeMessage`）上必然被执行，于是一催就抛 `ReferenceError`，把整张票打成 `failed`。修法：兜底自己造 —— `resolveCreateUserMessage(undefined)`。判据：**模块级函数里出现的每个标识符，都必须在模块作用域里能找到**；「兜底 / 默认值」这类平时不跑的分支尤其要查。
2. **`await agent.whenIdle()` 让看门狗在最该响的时候全程失聪。** `whenIdle()` 只在一整轮 turn 结束时 resolve，而事故形态正是「一轮 turn 连跑 40 分钟、中间一次没空闲」⇒ 本该 8 分钟就响的监控等到 40 分钟 turn 结束才响第一次，一秒钟后票已收尾。修法：定时器与 `whenIdle` 竞速（`waitForIdleWithStallCheck`，`Promise.race([idle, ticked])`），阈值 8 分钟 ⇒ 每 60 秒醒一次看工作区。判据：**轮询的频率不能绑在「对方什么时候有空」上**；看门狗必须能在对方正忙的时候工作。

两条各配一条自测，且都做过「把代码改回 bug 写法、对应用例必须变红」的回归验证（改回 bug1 只红「催办自己不许崩」；改回 bug2 只红「一轮 turn 连跑」）。
坑 2 的更普遍教训：**上一轮的 4 条停滞断言全绿，但假 agent 的 `whenIdle` 是「立刻返回」，恰好绕开了真正出事的路径** —— 测试形态与事故形态不重合时，绿色是假的。

### 12.18 通知适配器可插拔，优先用「已经有凭据」的那条通道

第三方通知服务有个隐形成本：**它自己的准入条件**。PushPlus 的 ClawBot 渠道要求实名认证，
未实名账户每个渠道额度都是 0，接口回 `905 account not real-name authenticated` ——
这个错在插件侧看起来像「配置错了」，实际是「你得去别的地方办个手续，且要付费」。

而同一个插件手里已经有飞书应用凭据（读工单表本来就要）。飞书自建应用自带机器人能力，
`POST /open-apis/im/v1/messages?receive_id_type=<type>` 就能发：

```
{ receive_id: 'ou_…', msg_type: 'text', content: JSON.stringify({ text }) }
```

`content` **必须是字符串化的 JSON**（传对象会被接口拒），这是这个接口最容易踩的一处。
真机实测（2026-11-11）：`http=200 code=0 message_id = om_x100b600a00e0c138b085f97545dd125`。

#### `230013` 不是「没有发消息权限」

第一次试发时收到 `230013 Bot has NO availability to this user`。这句话很容易被读成
「缺 `im:message:send_as_bot` scope」，但它跟缺 scope 是两回事：

| 错误码 | 含义 | 修法 |
| --- | --- | --- |
| `99991672` | 缺 scope（响应 `error.message` 会**点名**缺哪个） | 开放平台「权限管理」加 scope 并**创建版本发布** |
| `230013` | 机器人**「可用范围」**里没有这个收件人 | 开放平台「应用功能 → 机器人」设可用范围，或把机器人拉进群用 `chat_id` |

所以 `mapSendErrorKind` 把 `230013` 归成 `invalid-input` 而不是 `auth` —— 它是「收件人不对」，
不是「凭据不对」，归成 `auth` 会让人去重填 App Secret。

#### 适配器的注册形状

`src/contracts/push-adapter.js` 的契约是 `{ id, send(msg, signal) → PushReceipt }`，
`src/index.js` 的 `PUSHES` 注册表一行一个工厂。加一条通道 = 加一个目录 + `PUSHES` 一行 +
`config.pushAdapter` 的 enum 加一个值 + `CONFIG_GROUPS` 对齐（`assertGroupCoverage()` 会当场报错，
漏不掉）。当前四条：`mock` / `feishu` / `qqmail` / `pushplus`。

**注意 `accepted` 的语义**：它只代表服务端受理，不代表送达。飞书的 `message_id`、
PushPlus 的 `sendStatus`（0 未发 / 1 发送中 / 2 成功 / 3 失败）都只是受理侧的回执，
真正的送达要有回执通道，目前没有 —— 文档里必须说清这一点，别让人以为「accepted 就是收到了」。

#### 判据

1. **引入一个第三方之前，先问「我手里已有的凭据能不能干这件事」。** 多一个依赖就多一套
   准入条件、一套额度、一个可能收费的环节。
2. **报错文案要区分「谁的错」。** 「你配置错了」和「对方账号没办手续」对使用者是完全不同的
   两条行动，归错类会让人白折腾。
3. **受理 ≠ 送达，在任何通知适配器里都要写进契约注释。** 否则下游会拿 `accepted: true`
   当「用户已经知道了」。

## 13. 事实来源

本文所有「实测」结论都来自以下材料，改动前先回读原文：

| 主题 | 位置 |
|---|---|
| DSH 插件系统 / 服务 / slot / 发布 | `docs/research/dsh-capabilities.md`；抽取的原始文档在 `.scratch/_reference/dsh-plugin-docs/` |
| 飞书多维表格 API、水位、附件 | 票 `.scratch/ticket-pipeline/issues/01-飞书多维表格的变更水位与去重.md` 的 Resolution |
| 截图上模型的唯一合法通路 | `.scratch/ticket-pipeline/research/image-path.md`（723 行，每条带 `包名:行号`） |
| GitLab draft MR / Commits API（**现在只是 `repo.gitlab.enabled: true` 才走的可选出口**） | `.scratch/ticket-pipeline/research/gitlab-mr.md`（558 行，每条标【实测】/【源码】/【不可知】） |
| 项目仓库目录结构与验证命令参考 | `.scratch/ticket-pipeline/research/repo-map.md`（405 行，11 节，作示例） |
| 微信推送（WorkBuddy 排除 / PushPlus） | `.scratch/ticket-pipeline/research/wechat-push.md`（784 行） |
| `worktrees` 服务契约 | `.scratch/_reference/worktree-README.md`（从 asar 抽出） |
| 所有决策与用户拍板 | `.scratch/ticket-pipeline/map.md` 的 `## Decisions so far` |
| QQ 邮箱 SMTP 直发（真实发信已验） | `plugins/ticket-pipeline/src/adapters/push-qqmail/index.js`；自测 `scripts/push-qqmail-checks.mjs` |
| 宿主 shell / 沙箱 / agent 装配链（asar 解包实读） | `.scratch/_asar/`（`dsh-agent-loop` / `dsh-headless` / `dsh-subagent` / `api-session-controller` 等） |
| 真实飞书工单表结构与状态分布 | 表 `RZZQbY4SkaY6z0shZaBcVpQCnhh` / `tblWhRSGf0osJqrE`，79 条；「是否处理」分布 是:71 / 否:6 / 处理中:1 / 空:1 |
| 真实跑通记录（本地提交） | 2026-11-06 在 `D:/WorkSpace/mgiot-pms` 的工作区检出里实跑：`fix(pms): [pms] ##1 rec-probe-1` → sha 落库、通知正文里有「本地提交：<sha12> @ <branch>」一行（在描述之后），敏感文件 `application.yml` 留在工作区并写进提交说明 |
| 真实跑通记录（沙盒票 → 真 MR，可选出口） | `sandbox\|rec-mock-001` → GitLab MR !1（draft，source `ticket-sandbox-rec-mock-001-r1` → `main`）；现在只有 `repo.gitlab.enabled: true` 才走这条 |
| 上游模型限流真因（不是插件缺陷） | agent 会话 `session.v4.jsonl.zstd` 里的 `turn/end` reason：HTTP 429 / `quota_exceeded` |
