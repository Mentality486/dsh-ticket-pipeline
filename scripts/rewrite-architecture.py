#!/usr/bin/env python3
"""通用化重写 architecture.md：删 mgiot-pms 硬编码，改成 projects[] 口径。

反斜杠用 chr(92) 构造，避免源码里反斜杠转义歧义。每处替换断言恰好命中一次。
"""
import io, sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

BS = chr(92)  # 反斜杠

path = "docs/ticket-pipeline/architecture.md"
with io.open(path, "r", encoding="utf-8") as f:
    text = f.read()

edits = []

# 1. §1 约束表（文件里是单反斜杠）
edits.append((
    f"| 代码仓库 | 只有 `D:{BS}WorkSpace{BS}mgiot-pms` | 地图 Decisions |",
    "| 代码仓库 | 项目清单维护在 `projects[]` 配置，每项目一个仓库 | 地图 Decisions |",
))
edits.append((
    "| MR | 只开 draft，绝不自动合并；`ref=v2.x`、`target=v2.x` | 票 `04` + 用户拍板 |",
    "| MR | 只开 draft，绝不自动合并；基准/目标分支由项目 `repo.baseBranch`/`repo.targetBranch` 决定 | 票 `04` + 用户拍板 |",
))

# 2. §2 架构图
edits.append((
    "              飞书 / WPS / xlsx   PMS 别名表   agent    PushPlus\n"
    "              / mock             + 候选路径   + MR      / 企微 / mock",
    "              飞书 / WPS / xlsx   projects[]   agent    PushPlus\n"
    "              / mock             查表         + MR      / 企微 / mock",
))

# 3. §3 硬规则
edits.append((
    "2. **`adapters/` 之间零 import**。`locator-pms` 不许 import `source-feishu`。需要数据由内核以参数传入。",
    "2. **`adapters/` 之间零 import**。`locator-table` 不许 import `source-feishu`。需要数据由内核以参数传入。",
))

# 4. §5.3 RepoLocator 整节重写
edits.append((
    "### 5.3 `RepoLocator` — 工单文字到代码路径\n\n"
    "```ts\n"
    "export interface RepoLocator {\n"
    "  readonly id: string\n"
    "\n"
    "  /**\n"
    "   * 把工单的「模块 / 操作流程」映射到仓库路径与候选文件。\n"
    "   *\n"
    "   * 契约：\n"
    "   * - 纯函数语义：不做 IO 到目标仓库之外、不建 worktree、不改任何文件。\n"
    "   * - 允许读仓库（如扫一遍目录），但读失败不能抛 —— 降级成空的 candidatePaths。\n"
    "   * - 拿不准就如实标 `ambiguous: true`，**绝不静默猜一个**。\n"
    "   */\n"
    "  locate (ticket: Ticket, signal: AbortSignal): Promise<LocateResult>\n"
    "}\n"
    "\n"
    "export type LocateResult = {\n"
    "  repoPath: string          // 绝对路径\n"
    "  module?: string           // 规范化后的模块名（工单里是旧称，这里换成现行叫法）\n"
    "  candidatePaths: string[]  // 建议 agent 先看的文件/目录（相对 repoPath）\n"
    "  ambiguous: boolean        // true = 需要人在环里定夺\n"
    "  /** 给 agent 的额外提示，会原样进 prompt。例：「问题管理现叫日常工作」。 */\n"
    "  notes?: string\n"
    "}\n"
    "```\n"
    "\n"
    "**`ambiguous: true` 不是失败**：票照常排队，但内核在给 agent 的 prompt 里显式列出候选并写明「若无法唯一确定，先停下来问人，不要猜」。\n"
    "\n"
    "**为什么这层必须独立**：模块名到代码路径的映射是这个项目里**最容易变、最容易错**的知识。mgiot-pms 的工单里写的是旧称（`问题管理` 现在的 UI 叫「日常工作」），`项目技术支持` 甚至是个挂 6 个模块的分组壳。把这些知识锁进一个可单测、可替换的小模块，比散在 prompt 里可靠得多。",
    "### 5.3 `RepoLocator` — 工单项目到仓库\n\n"
    "通用化后，`RepoLocator` 退化成**查表**：按 `ticket.projectId` 在 `projects[]` 里找到\n"
    "对应条目，返回它的仓库信息。**不做任何「模块 → 代码路径」的推断**——那一部分\n"
    "交给 `executor-agent` 现场读仓库自己定位。\n\n"
    "```ts\n"
    "export interface RepoLocator {\n"
    "  readonly id: string\n"
    "\n"
    "  /**\n"
    "   * 把工单的 projectId 映射到它所属项目的仓库与分支。\n"
    "   *\n"
    "   * 契约：\n"
    "   * - 纯查表，不做 IO 到目标仓库之外、不建 worktree、不改任何文件。\n"
    "   * - `ticket.projectId` 缺失或查不到时抛 PipelineError('invalid-input')。\n"
    "   * - 不猜代码路径：`candidatePaths` 恒为空、`ambiguous` 恒 false。\n"
    "   */\n"
    "  locate (ticket: Ticket, signal: AbortSignal): Promise<LocateResult>\n"
    "}\n"
    "\n"
    "export type LocateResult = {\n"
    "  repoPath: string          // 绝对路径（来自 project.repo.path）\n"
    "  remote?: string           // GitLab remote URL（来自 project.repo.remote）\n"
    "  baseBranch?: string       // 切 worktree 的基准分支（来自 project.repo.baseBranch）\n"
    "  targetBranch?: string     // draft MR 目标分支（来自 project.repo.targetBranch）\n"
    "  candidatePaths: string[]  // 恒为空：代码定位交给 executor-agent 现场读仓库\n"
    "  ambiguous: boolean        // 恒 false：这里不猜代码路径\n"
    "  notes?: string            // 项目 description，原样进 prompt\n"
    "}\n"
    "```\n"
    "\n"
    "**为什么退化成查表而不是删掉这一层**：工单属于哪个项目是**表级**决定的（飞书知识树\n"
    "里每个项目一张自己的工单表），这个绑定关系必须有一处统一、可单测的代码来表达；\n"
    "「工单对应哪个仓库」是流水线的第一跳，放查表里比散在各处可靠。**「该改哪个文件」\n"
    "则不属于这一层**——那需要读代码、看工单描述，是 agent 现场定位的事。",
))

# 5. §6.1 Ticket 加 projectId，module 注释改
edits.append((
    "  recordId: string           // 平台侧稳定标识。飞书 = recXXXXXXXX。**唯一身份**",
    "  recordId: string           // 平台侧稳定标识（飞书 = recXXXXXXXX）。**平台内唯一**，跨项目靠 projectId 复合\n"
    "  projectId: string          // 所属项目（对应 projects[].name），复合主键的一半",
))
edits.append((
    "  module?: string            // 模块（旧称，需过 RepoLocator 的别名表）",
    "  module?: string            // 模块（平台原值，不参与定位，仅进指纹与 prompt）",
))

# 6. §6.5 TicketRecordRow / LeaseRow 主键改复合键
edits.append((
    "type TicketRecordRow = {\n"
    "  recordId: string                     // 主键",
    "type TicketRecordRow = {\n"
    "  key: string                          // 主键 = ticketKey(projectId, recordId)\n"
    "  projectId: string                    // 所属项目\n"
    "  recordId: string                     // 平台原值（显示用）",
))
edits.append((
    "type LeaseRow = {\n"
    "  recordId: string                     // 主键",
    "type LeaseRow = {\n"
    "  key: string                          // 主键（= ticketKey）",
))

# 7. §9 Config 整节重写（文件里 ts 块内是双反斜杠）
edits.append((
    "用 `export const Config`（schemastery）。值存在 profile 的 `cordis.patch.yml` 里本插件那一行，升级不丢。\n"
    "\n"
    "```ts\n"
    "export const Config = Schema.object({\n"
    "  // ── 工单源 ──────────────────────────────────────────\n"
    "  ticketSource: Schema.string().default('feishu')\n"
    "    .description('工单源适配器 id，对应 src/index.js 注册表里的键'),\n"
    "\n"
    "  feishu: Schema.object({\n"
    "    appToken: Schema.string().default(''),\n"
    "    tableId: Schema.string().default(''),\n"
    "    viewId: Schema.string().default(''),\n"
    "    appId: Schema.string().default(''),          // 走 credentials 而不是明文配置\n"
    "    appSecret: Schema.string().default(''),\n"
    "  }),\n"
    "\n"
    "  // ── 扫描与队列 ──────────────────────────────────────\n"
    "  pollIntervalMinutes: Schema.number().min(1).max(60).default(3),\n"
    "  safePageRun: Schema.number().min(5).max(100).default(20)\n"
    "    .description('连续多少条已知且未变的记录后停止翻页'),\n"
    "  goneAfterScans: Schema.number().min(1).max(20).default(3)\n"
    "    .description('连续几轮扫不到认定该行已删除'),\n"
    "  concurrency: Schema.number().min(1).max(1).default(1)\n"
    "    .description('并发数，当前只支持 1（串行）'),\n"
    "\n"
    "  // ── 租约与重试 ──────────────────────────────────────\n"
    "  leaseTtlMinutes: Schema.number().min(1).max(60).default(10),\n"
    "  leaseRenewSeconds: Schema.number().min(10).max(600).default(60),\n"
    "  maxAttempts: Schema.number().min(1).max(5).default(2),\n"
    "\n"
    "  // ── 执行 ────────────────────────────────────────────\n"
    "  ticketTimeoutMinutes: Schema.number().min(5).max(180).default(40),\n"
    f"  repoPath: Schema.string().default('D:{BS}{BS}WorkSpace{BS}{BS}mgiot-pms'),\n"
    "  baseRef: Schema.string().default('origin/v2.x'),\n"
    "  fetchBeforeCreate: Schema.boolean().default(true),\n"
    "  branchPrefix: Schema.string().default('ticket-'),\n"
    "  worktreeRetentionHours: Schema.number().min(0).max(720).default(24)\n"
    "    .description('终态票的 worktree 保留小时数；0 = 不自动清'),\n"
    "  dbOverrideUrl: Schema.string().default('')\n"
    "    .description('可选：给 agent 起后端时覆盖数据库地址，留空则不覆盖'),\n"
    "\n"
    "  // ── agent 与模型 ────────────────────────────────────\n"
    "  provider: Schema.string().default('deepseek'),\n"
    "  model: Schema.string().default('deepseek-v4-pro'),\n"
    "  maxTokens: Schema.number().default(32000),\n"
    "  reasoningEffort: Schema.string().default(''),\n"
    "\n"
    "  // ── 通知 ────────────────────────────────────────────\n"
    "  pushAdapter: Schema.string().default('pushplus'),\n"
    "  pushplus: Schema.object({\n"
    "    token: Schema.string().default(''),          // 走 credentials\n"
    "    channel: Schema.string().default('clawbot'),\n"
    "    template: Schema.string().default('txt')\n"
    "      .description('必须用 txt；富模板在 ClawBot 里只显示前 50 字'),\n"
    "    callbackUrl: Schema.string().default(''),\n"
    "  }),\n"
    "  notifyOn: Schema.array(Schema.string()).default(['done', 'skipped', 'failed', 'needs-info'])\n"
    "    .description('哪些终态要发通知'),\n"
    "\n"
    "  // ── 杂项 ────────────────────────────────────────────\n"
    "  enabled: Schema.boolean().default(false)\n"
    "    .description('总开关，默认关；第一次装上不会自动开始扫表'),\n"
    "  logLevel: Schema.string().default('info'),\n"
    "})\n"
    "```\n"
    "\n"
    "**凭据不进配置**：`feishu.appSecret`、`pushplus.token`、GitLab PAT 全部走 `ctx.credentials`（默认落 `~/.dsh/.credentials.yaml`）。配置里那几项是**占位说明**，实际读取顺序是 credentials → 配置（空则视为未配置）。",
    "用 `export const Config`（standard-schema 形状，见 `src/core/config.js`，不是 schemastery）。\n"
    "值存在 profile 的 `cordis.patch.yml` 里本插件那一行，升级不丢。字段清单与默认值\n"
    "以 `src/core/config.js` 的 `CONFIG_FIELDS` 为准，下面是概览：\n"
    "\n"
    "```ts\n"
    "export const Config = {\n"
    "  // ── 项目清单（核心，通用化的根）─────────────────────\n"
    "  projects: Array<{\n"
    "    name: string               // 项目唯一标识 = ticket.projectId\n"
    "    description?: string       // 项目描述，进 agent 定位提示\n"
    "    match: {                   // 工单表怎么定位（表级绑定）\n"
    "      platform: 'feishu' | 'wps' | 'mock'\n"
    "      appToken?: string        // 飞书多维表格 app_token（显式绑定）\n"
    "      tableId?: string         // 飞书数据表 id（与 appToken 一起用）\n"
    "      viewId?: string          // 可选：只扫某个视图\n"
    "      docNamePattern?: string  // 文件名模糊匹配（无显式绑定时的兜底）\n"
    "    },\n"
    "    repo: {\n"
    "      path: string             // 本地 git 检出根目录（必填）\n"
    "      remote?: string          // GitLab remote URL（开 MR 用）\n"
    "      baseBranch?: string      // 切 worktree 的基准分支（默认 main）\n"
    "      targetBranch?: string    // draft MR 目标分支（默认同 baseBranch）\n"
    "    },\n"
    "    verify?: {\n"
    "      build?: string           // 构建命令（如 npm run build），空串跳过\n"
    "      test?: string            // 测试命令（如 mvn -o test），空串跳过\n"
    "    },\n"
    "  }>,\n"
    "\n"
    "  // ── 扫描与队列 ──────────────────────────────────────\n"
    "  pollIntervalMinutes: number,   // 默认 3，1..60\n"
    "  safePageRun: number,           // 默认 20，5..100\n"
    "  goneAfterScans: number,        // 默认 3，1..20\n"
    "  concurrency: number,           // 默认 1（当前只支持 1）\n"
    "\n"
    "  // ── 租约与重试 ──────────────────────────────────────\n"
    "  leaseTtlMinutes: number,       // 默认 10，1..60\n"
    "  maxAttempts: number,           // 默认 2，1..5\n"
    "\n"
    "  // ── 执行 ────────────────────────────────────────────\n"
    "  workExecutor: 'mock' | 'agent', // 默认 mock（agent 未实现）\n"
    "  ticketTimeoutMinutes: number,  // 默认 40，5..180\n"
    "  fetchBeforeCreate: boolean,    // 默认 true\n"
    "  branchPrefix: string,          // 默认 'ticket-'，后接 <projectId>-<recordId>-r<修订号>\n"
    "  worktreeRetentionHours: number,// 默认 24，0..720\n"
    "\n"
    "  // ── agent 与模型 ────────────────────────────────────\n"
    "  provider: string,              // 默认 'workbuddy'\n"
    "  model: string,                 // 默认 'deepseek-v4.1-flash'\n"
    "  maxTokens: number,             // 默认 32000\n"
    "\n"
    "  // ── 通知 ────────────────────────────────────────────\n"
    "  pushAdapter: 'mock' | 'pushplus', // 默认 pushplus\n"
    "  pushplus: { token, channel, template },\n"
    "  notifyOn: string[],            // 默认 ['done','skipped','failed','needs-info']\n"
    "\n"
    "  // ── 杂项 ────────────────────────────────────────────\n"
    "  enabled: boolean,              // 默认 false\n"
    "  logLevel: string,              // 默认 'info'\n"
    "}\n"
    "```\n"
    "\n"
    "**凭据不进配置**：`pushplus.token`、GitLab PAT、飞书应用密钥全部走 `ctx.credentials`。\n"
    "配置里的 token 字段只是占位，读取顺序是 credentials → 配置（空则视为未配置）。",
))

# 8. §10 目录 locator-pms → locator-table
edits.append((
    "│   ├── locator-pms/               ← mgiot-pms 的别名表 + 候选路径",
    "│   ├── locator-table/             ← 通用仓库定位器：按 projectId 查 projects[]",
))

# 9. §10 注册表
edits.append((
    "import { createPmsLocator }     from './adapters/locator-pms/index.js'",
    "import { createTableLocator }   from './adapters/locator-table/index.js'",
))
edits.append((
    "const SOURCES   = { mock: createMockSource, feishu: createFeishuSource }\n"
    "const LOCATORS  = { pms: createPmsLocator }\n"
    "const EXECUTORS = { agent: createAgentExecutor }\n"
    "const PUSHES    = { pushplus: createPushplus }",
    "const SOURCES   = { mock: createMockSource, feishu: createFeishuSource }\n"
    "const EXECUTORS = { mock: createMockExecutor, agent: createAgentExecutor }\n"
    "const PUSHES    = { mock: createMockPush, pushplus: createPushplus }\n"
    "// 仓库定位器只有 table 一种实现，不是可替换表：直接 createTableLocator({ projects })",
))

# 10. §10 判定标准
edits.append((
    "> 插件仍能构建、仍能用 `ticketSource: 'mock'` 跑通整条链路。",
    "> 插件仍能构建、仍能用 `projects: [{ name:'demo', match:{ platform:'mock' }, repo:{ path:'...' } }]` 跑通整条链路。",
))

# 11. §11 时序
edits.append((
    "        ├─ locate = locator.locate(票A)  → { repoPath, module:'complaint',\n"
    "        │                                    candidatePaths:[...], ambiguous:false }\n"
    "        ├─ 若 fetchBeforeCreate → git fetch origin v2.x",
    "        ├─ locate = locator.locate(票A)  → { repoPath, baseBranch, targetBranch,\n"
    "        │                                    candidatePaths:[], ambiguous:false }\n"
    "        ├─ 若 fetchBeforeCreate → git fetch <项目 baseBranch>",
))
edits.append((
    "        ├─ wt = await ctx.worktrees.create(agent, { name:'ticket-recXXX-r1',\n"
    "        │                                           from:'origin/v2.x' })",
    "        ├─ wt = await ctx.worktrees.create(agent, { name:'<branchPrefix><projectId>-<recordId>-r1',\n"
    "        │                                           from:'<项目 baseBranch>' })",
))
edits.append((
    "T+0:30  … agent 改完 → onPhase('testing')\n"
    "        ├─ node scripts/check-consistency.mjs   （零依赖，不连库）\n"
    "        ├─ npm run build                        （改到前端时）\n"
    "        ├─ mvn -o test                          （改到后端时）\n"
    "        └─ mvn spring-boot:run + curl 打接口    （起不来 → skipped + 原因）",
    "T+0:30  … agent 改完 → onPhase('testing')\n"
    "        └─ 验证命令从项目配置 verify.build / verify.test 注入\n"
    "           （没配 verify 就跳过验证，直接开 draft MR）",
))
edits.append((
    "        └─ POST /merge_requests { source_branch, target_branch:'v2.x',\n"
    "                                  title:'Draft: [工单#N] 摘要', description }",
    "        └─ POST /merge_requests { source_branch, target_branch:'<项目 targetBranch>',\n"
    "                                  title:'Draft: [工单#N] 摘要', description }",
))

# 12. §12 沙箱措辞（文件里是单反斜杠）
edits.append((
    f"**实测**（2026-11-03）：本会话 file policy = `workspace-write`，作用域仅 `D:{BS}WorkSpace{BS}dsh-ticket-pipeline`。往 `mgiot-pms` 写任何东西都被拒：",
    "**实测**（2026-11-03）：本会话 file policy = `workspace-write`，作用域仅当前会话 workspace。往该作用域之外的仓库写任何东西都被拒：",
))
edits.append((
    "1. 插件所在会话的 cwd / workspace **就是** `mgiot-pms`，或",
    "1. 插件所在会话的 cwd / workspace **就是**目标仓库（`projects[].repo.path`），或",
))

# 13. §12.6 Out of scope
edits.append((
    "- `mgiot-pms` 之外的仓库",
    "- `projects[]` 未配置的仓库",
))

# 14. §13 事实来源
edits.append((
    "| mgiot-pms 模块别名与代码路径 | `.scratch/ticket-pipeline/research/repo-map.md`（405 行，11 节） |",
    "| 项目仓库目录结构与验证命令参考 | `.scratch/ticket-pipeline/research/repo-map.md`（405 行，11 节，作示例） |",
))

# 执行替换
missing = []
for old, new in edits:
    n = text.count(old)
    if n != 1:
        missing.append((n, old[:90]))
        continue
    text = text.replace(old, new, 1)

if missing:
    for n, head in missing:
        print(f"[MISS x{n}] {head!r}", file=sys.stderr)
    sys.exit(1)

with io.open(path, "w", encoding="utf-8", newline="\n") as f:
    f.write(text)

print(f"OK: applied {len(edits)} edits")
