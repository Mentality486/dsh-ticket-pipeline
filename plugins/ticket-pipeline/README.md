# 工单流水线（ticket-pipeline）

从工单表检测变化 → 定位代码 → 改动验证 → 在工作区检出里做本地提交 → 通知（QQ 邮箱 SMTP / PushPlus 中继微信）。一个 DSH Host 插件。

> 📖 **怎么用？** 看 [使用手册](../../docs/ticket-pipeline/user-guide.md) ——
> 从准备工单表、配凭据、装插件，到 mock 首跑、切真执行、日常循环与排障，全流程一步步讲。

## 一句话架构

四个可替换适配器（`TicketSource` / `RepoLocator` / `WorkExecutor` / `PushAdapter`）加一个
内核（`Scheduler` + `TicketStore` + `Config`）。完整设计见
[`docs/ticket-pipeline/architecture.md`](../../docs/ticket-pipeline/architecture.md)。

```
工单表 ──TicketSource──▶ Scheduler ──RepoLocator──▶ 项目仓库（projects[] 查表）
                              │
                              ├──WorkExecutor──▶ 在项目工作区的检出里改码 + 构建/测试 + 本地提交（可选：隔离 worktree、draft MR）
                              │
                              └──PushAdapter──▶ 通知（qqmail 直发 SMTP / pushplus 中继微信，channel=clawbot）
```

## 目录

```
src/
  contracts/         纯接口与数据，不 import 任何具体实现
  core/              scheduler / store / recover / prompt / config / domain
  adapters/
    source-mock/     内存工单源（离线跑通全链路用，每个项目一个实例）
    source-feishu/   飞书多维表格（真实实现）
    source-wps/      金山文档共享 Excel（解析已实现：零依赖手写 zip/xlsx 解析；取数需注入 fetchSheet，开放平台通道待接）
    source-webform/  演示平台（内存表单源，实证可插拔流程）
    locator-table/   通用仓库定位器：拿 projectId 查 projects[]（不做模块→代码推断）
    executor-mock/   假执行器（离线跑通用）
    executor-agent/  真执行器：拍基线 → 起 agent 改码 → 过滤敏感文件 → 点名暂存 + 本地提交（commitLocally）→ 保留会话（keepSession）→ 可选：Commits API 开 draft MR
    gitlab-client/   GitLab REST 客户端（分支/提交/MR/错误分类）；只在 repo.gitlab.enabled=true 时被调用
    push-mock/       假通知（记内存）
    push-pushplus/   PushPlus 真实现
    push-qqmail/     QQ 邮箱 SMTP 真实现（零依赖手写协议）
  tools/             pipeline_scan / pipeline_status / pipeline_cancel / pipeline_reset / pipeline_doctor 五个工具
  remote/            浏览器端可调的自建 Remote（ticketPipeline/doctor、ticketPipeline/config、ticketPipeline/projects、ticketPipeline/branches）
  index.js           组合根 + 三张注册表（SOURCES / EXECUTORS / PUSHES）
lib/
  client.js          浏览器端 bundle：插件设置页（填配置 + 凭据 + 立即体检）
```

## 设置页

插件详情页里本插件那一行有「配置」按钮，点进去是一整页：

- **环境体检**：「立即体检」按钮跑 `runDoctor`（与对话里的 `pipeline_doctor` 同一份逻辑），
  结果按「必须修复 / 提醒」分段显示。最后一节是**插件版本自检**：比安装副本与本目录的
  **文件内容**（`src/**/*.js`、`lib/**/*.js`、`cordis.patch.yml`、`icon.svg`、`locale/*.json`），
  落后时直接给出「把哪个目录同步到哪个目录，然后重启宿主」。
  它只进「提醒」不进「必须修复」—— 旧版插件照样能把票跑完，只是行为不是你刚改的那份。
  为什么不比版本号 / 不跟 origin 比 / 为什么 HMR 不会自己发现：见 `docs/ticket-pipeline/architecture.md` §12.11。
- **凭据**：飞书 App ID / App Secret、QQ 邮箱授权码、PushPlus token；GitLab Token 也在这里，
  但只有项目打开 `repo.gitlab.enabled: true` 才需要（本阶段用不到），
  只写不读回（写入走 `ctx.get('remote.credentials')`，界面只显示「已配置 / 未配置」）。
- **配置**：按分组渲染 **33 个字段 / 7 个分组**，保存走 `ctx.get('remote.settings').mutate`（写 profile 的
  `cordis.patch.yml`，重启后仍在）。
- **项目清单**：`projects[]` 现在**也能在面板上改**（5 个分区 21 个字段：基本 / 工单表 / 金山文档 / 仓库 / 验证命令）。
  字段约束即时校验（必填、数字 `min`–`max`、枚举、列表按逗号切分），分组可折叠，脏字段带「已改」徽标并能单字段撤销。
  `match.appToken` **明文不下发**，只给「已配置」+「前 4…后 4」的预览，**面板上没有输入框**（要改只能手改
  `cordis.patch.yml`）；保存只发改动过的**深层路径**
  （`['projects','0','repo','path']` 这种），绝不整数组替换 —— 否则会抹掉别的项目和手写进去的 `appToken`。
  驱动它的是第三个 Remote 方法 `ticketPipeline.projects()`（返回项目扁平视图）。
  `repo.baseBranch` / `repo.targetBranch` 两个分支字段还带候选下拉（输入框 + `<datalist>`），
  候选来自第四个 Remote 方法 `ticketPipeline.branches()`（一次返回**全部**项目，不按项目各发一次 git；
  `src/core/branches.js` 的 `listBranches()` 绝不抛，拿不到就 `ok:false` + 一句人话原因）。
  手改配置文件仍然有效 —— 注意它是 **YAML 不是 JSON**，改完必须重启宿主（两个入口的取舍、
   每格对应面板哪一处见使用手册 §3.0 / §3.0.1）。
- **面板密度**：缺省只显示 8 个常改字段，其余收在「显示全部字段」复选框里；金山那 5 个字段只在平台是
  `wps` 时出现。项目卡片整体可收起，卡内 5 个分区也能各自收起（两套折叠类名分开，折叠状态存两个
  localStorage 键）。**改过或有错的字段无论收起与否都会露出来** —— 折叠不能成为遮蔽错误的工具。
  隐藏 ≠ 删字段：`PROJECT_SECTIONS` 里 21 个 path 一个没少。
- **面板长得什么样**：顶部四个**页签**（项目 / 参数 / 凭据 / 体检），**一次只画一页**（不是藏起来），
  缺省停在「项目」——它是主线，参数和凭据是一次性调好的配角。页签上只在真有未保存/待修时才挂数字。
  页签是下划线式（抄宿主 `PluginsSettingsSection`），面板不铺灰底，卡片用宿主
  `--dsw-alias-settings-card-fill` / `-stroke` 且**不带阴影** —— 亮色主题下 `bg-layer-1/2/3` 全是 `#fff`，
  白叠白再叠阴影就是「一堆框糊在一起」。字段是「加粗字段名 / 输入框 / 浅灰说明」的上下三行
  （不是左边一长串文字 + 右边输入框）；布尔项是 `role="switch"` 开关；全页只一颗主按钮（顶部「保存」），
  凭据值攒着随它一起提交，行内只剩「清除」（要二次确认）。项目清单右上角「+ 添加项目」
  只在面板上垫一张空卡片（标「未保存」），填完点顶部「保存」才与其它改动**一起**作为一笔
  `settings.mutate` 提交 —— 原因：宿主对整份配置一次性校验，带空 `repo.path` 的半成品
  直接提交必然被 `projects[n].repo.path 必须是非空字符串` 整笔拒掉。没保存的卡片「撤掉」只从
  面板拿掉；已保存的项目「删除」仍立即 `unset`（宿主 `splice`）。两种情况都不新增 Remote 方法。
  控件是自写的 —— 宿主 `practices.md` 禁止把 `dsh-client-ui-primitives` 之类客户端包当模块加载。

表单不自带渲染器：`src/core/config.js` 在 `Config` 上挂了一棵手写的 schema descriptor
（每个节点带 `toJSON`、叶子带 `meta.volatile`），宿主 `dsh-settings` 用它投影出可写字段。
**没挂 descriptor 时宿主会静默跳过整条设置项** —— 加字段后记得同步 `CONFIG_GROUPS`，
`node scripts/client-check.mjs` 会检查这一点。

`projects` 这棵子树有个特殊要求：**数组节点自己必须标 `meta.volatile = true`**（`inner` 里的子节点也要标）。
原因是宿主的 `isVolatilePath(schema, path)` 只沿 `schema.dict` 往下走、**完全不认 `inner`**，而 `projects` 是数组 ——
深层路径 `['projects','0','repo','path']` 只能靠根节点自己 volatile 短路放行，否则每次保存都被拒成
`Config field "projects" is not volatile`。`client-check.mjs` 的 `auditProjectsNode()` 会逐层查这一点。

descriptor 的 `toJSON()` 必须返回 schemastery 的**信封** `{ uid, refs }`，
`refs` 里 `dict`/`inner`/`list` 的值是 **uid 数字**（引用），不能是内联对象。
两处都会 `new z(...)` 重建：宿主 `dsh-settings` 与浏览器 `dsh-client-ui-settings`。
引用一旦断了，数组字段的 `inner` 在浏览器里变成 `undefined`，校验抛
`Cannot read properties of undefined (reading 'meta')`，又被客户端的 `catch` 静默吞掉 ——
**整块设置面板永远停在 loading，什么也不显示，也不报错**。
`scripts/client-check.mjs` 的 `checkSchemaEnvelope()` 就是守这一条的（改坏了它会红）。

**命名空间服务一律走 `ctx.get('remote.<ns>')`，不能写 `ctx.remote.<ns>`。**
`settings` / `credentials` / `ticketPipeline` 三个命名空间是 gateway 装在**兄弟 fiber** 上的
独立服务（服务名 `remote.<ns>`），不是 `remote` 对象的属性 —— cordis 的属性访问沿 fiber 链
**向上**找 provide，兄弟不是祖先 ⇒ 抛 `cannot get property "remote.settings" without inject`，
错误边界把面板接住 ⇒ **整页空白，控制台还只有一行用户看不懂的报错**。
`ctx.get(name)` 查的是全局服务 store，不查 inject、不沿 fiber 链，兄弟 fiber 提供的服务照样取得到。

反过来，**不能把 `ticketPipeline` 写进 `inject`**：它是我们自己用 `remote.$mount()` 建的，
写进 inject 等于「等自己把命名空间建出来」⇒ fiber 永远不激活、`apply` 一次都不执行
（表现：配置页静默全空，「配置」按钮都不出现）。所以 `inject` 里只留 `['slots']`。

## 三个可替换件

| 接口 | 注册表键 | 现状 |
|---|---|---|
| `TicketSource` | `mock` / `feishu` / `wps` / `webform` | 全部 ✅ |
| `WorkExecutor` | `mock` / `agent` | 全部 ✅ |
| `PushAdapter` | `mock` / `pushplus` / `qqmail` | 全部 ✅ |

> `RepoLocator` 通用化后不再是可替换表 —— 它只有「查 `projects[]`」一种实现
> （`locator-table`），直接由配置驱动。代码定位交给 executor-agent 现场读仓库。

换平台 = 在 `src/adapters/<name>/` 写一个实现 + 在 `src/index.js` 的表里加一行。
**内核一行都不用改** —— 这是架构文档 §10 写的验收标准。

## 关键决策（都来自地图 Decisions，勿擅自改）

- **扫描只读，回填是唯一写入口**：`scan()` 全程不写远端状态。票跑成 `done` / `skipped` 之后，
  调度器调一次 `TicketSource.writeResult(recordId, { status, result, handledAt })`，只写「是否处理 / 处理结果 / 处理日期」三列。
  `failed` 不回填（留在「处理中」是刻意留的信号）；回填失败只记在票据上、票态不回退、通知照发。开关 `writeBack`（缺省 `true`）与 `writeBackStatus`（缺省 `是`）。
  为什么必须拆成两个方法见 [`docs/adr/0006-处理完回填工单表.md`](../../docs/adr/0006-处理完回填工单表.md)。
- **`record_id` 是平台内唯一身份**，不用「序号」列（人手填、会重排）。**跨项目用复合主键** `ticketKey(projectId, recordId)`。
- **项目清单在插件配置 `projects[]` 里维护**（工单→项目在表级绑定，一个项目一条配置：name + match + repo + verify）。
- **变更检测靠轮询**：飞书没有可靠的单元格变更事件。间隔读 `Config.pollIntervalMinutes`（默认 3 分钟）。
- **并发恒 1**：一轮最多跑一票、最多清一个 worktree。
- **默认只做本地提交，不开 MR**：交付形态是项目工作区检出里的一次 `git commit`（`ExecResult.commit`），
  敏感文件不进去。远程 draft MR 是可选出口，只有项目显式 `repo.gitlab.enabled: true` 才走 GitLab Commits API，
  而且 MR 标题必须 `Draft:` 前缀（`git push` 在本机被沙箱封死，见下）。
- **`accepted` ≠ 送达**：PushPlus `code:200` 只代表受理，真送达看 `callbackUrl` 的 `sendStatus`。
- **项目工作区复用，改代码落点可配**：`projects[].repo.path` 那个目录就是一个项目的**工作区** ——
  插件会确保它在宿主 `workspaceRegistry` 里有一份登记（一个项目一条，多张票共用同一个；
  已登记则复用，没登记则补一条）。目录必须真实存在，插件不会替你克隆。
  **缺省（`isolateWorktree: false`）就直接在这个检出里改代码**，分支 = 检出当前分支、不另开票分支。
  **检出脏也能跑**：agent 动手前用 `git stash create` 拍一份只读基线（不写 ref、不动工作区、不动索引），
  结束后只提交 agent 真正改过的文件 —— 你自己攒着的未提交改动、甚至已经 `git add` 进索引的改动都原样留在工作区。
  `pipeline_doctor` 看到脏只提醒一句，不再拒跑。
  打开 `isolateWorktree: true` 才退回旧行为：每票 `git fetch` 该项目配置的 baseBranch，
  再 `git worktree add -b <branchPrefix><projectId>-<recordId>-r<修订号>` 开隔离 worktree
  （`fetchBeforeCreate` / `branchPrefix` / `worktreeRetentionHours` 也只有这时才用得上）。
  会话的 header cwd 用**工作区根**（宿主 `attachSession` 要求会话 cwd 正好等于工作区路径），
  只有 `worktreePath !== workspacePath`（即开了 `isolateWorktree`）时才用 `workingDirectory.set`
  把这一轮的工作目录钉到隔离子目录；缺省模式两者相等，不需要这个服务。
  最后 `attachSession` 把会话归属到该工作区，在 GUI 的工作区分组下能看到。
- **清理安全**：`removeWorktree` / `listExpiredWorktrees` 先过 `isIsolatedWorktreePath()`
  （只认 `<repo>/.agents/worktrees/<name>`）。缺省模式没有隔离 worktree，若不校验，
  `git worktree remove --force` 会对着人的主检出执行 —— 这个口子必须堵。
- **超时只报给人，不自动重试**；唯一重开路径 = 人把「是否处理」拨走再拨回「处理中」。
- **处理完保留会话**：`ExecResult.sessionId` 落票据；agent 实例在 `finally` 里**永远** `dispose()`，
  但 `keepSession !== false`（缺省 `true`）时不做任何会话回收 —— 会话留在项目工作区名下，人能在会话列表里点进去继续追问。
  只有显式 `keepSession: false` 才调宿主 `sessions` 服务（`close` / `dispose` / `closeSession` 三选一，调用永不抛）。
- **设置面板补齐**：`projects` 子树可编辑（5 分区 21 字段 / 25 个可写字段），`match.appToken` 只下发
  `hasAppToken` + `appTokenPreview`（前 4…后 4）。第 3 个 Remote 方法 `ticketPipeline.projects()` 提供扁平视图，
  第 4 个 `ticketPipeline.branches()` 给两个分支字段当候选；
  写入只发深层路径，绝不整数组替换。全局配置现在 **33 个键 / 7 个分组**（`projects` 子树另算）。
- **适配器名写错就报错，不再静默退回 mock**：`workExecutor` 只能是 `agent` / `mock`，`pushAdapter` 只能是
  `mock` / `pushplus` / `qqmail`（`src/core/config.js` 里带 `enum`）。写错一个字（含大小写、尾空格）激活期直接抛
  `invalid-input` 并列出可选值；只有 `undefined` / `null` / 空串才回落到 `mock`。
  以前 `EXECUTORS[config.workExecutor] ?? EXECUTORS.mock` 的写法会让 `Agent` 这类笔误静默跑完整条链路 ——
  不改一行代码、给票打 `testOutcome: 'passed'`、写个假 commit sha、回填表格写「已按工单改完并提交」，
  是最难发现的「看起来成功」的假执行（`src/index.js` `pickAdapterFactory()`）。
- **验证命令必须有超时与取消**：缺省 `VERIFY_TIMEOUT_MS = 30 分钟`，超时退出码 **`VERIFY_TIMEOUT_EXIT_CODE = 124`**
  （沿 coreutils `timeout` 约定，和「检查没通过」区分开）；`signal` 一起进宿主 `shell.resolve`，
  用户取消会真的 kill 子进程。宿主 `bash-local` 的 `maxTimeoutMs` 缺省 10 分钟会把它夹下去（真实上限取小者）。
  没有这一层时，一条卡住的 `npm test` 会让 `runOne` 永远停在 `await` 上 → 单飞标记 `running` 恒 `true` →
  之后每次 tick 都直接返回 `already-running`，**整条流水线静默停摆且取消不了**。
- **敏感文件名单 8 大类 / 41 条正则**（`SENSITIVE_FILE_PATTERNS`，原 9 条）：`.env` 家族、Spring 配置（含 `bootstrap*`）、
  包管理器 token、SSH·GPG 私钥、云与容器凭据、明文机器凭据、证书·密钥库·Terraform 状态、关键字兜底。
  被拦文件进 `ExecResult.blockedFiles`，`plan.summary` 写「另有 N 个敏感文件按约定未提交（疑似含真实凭据）：…」。
  名单按「已知后缀白名单」写而不是通配，所以 `src/env.js`、`docs/credentials.md`、`.environment.md` 不会被误伤。
- **`.git` 与插件 profile 的篡改自检**：git 看不见自己的元数据、profile 不在仓库里，所以只能自己在 agent 动手前
  拍 sha256 快照、提交前复拍比对（10 个 git 元数据文件 + 28 个官方 hook 名 + 4 个 profile 文件）。
  动过就 `git restore --staged` 撤回、判 `failed` + `invalid-input`（不可重试）并点名文件。
  拿不到 `readFile` 服务时跳过自检并记日志（安全降级）。**这是「被发现」不是「被阻止」**。
- **approval/policy 仍然是 `never`**：宿主只有 `ask` / `never` 两档，**没有**「只读自动批、写入弹卡」。
  `ask` 在无头场景 fail-closed 会让每一步工具调用失败，所以实跑会用 `never` 并打 warn 日志。
  兜底只有 git 白名单 + 提交前篡改自检，**不是硬隔离**。
- **终态与事后动作同一次落库（`pendingEffects`）**：回填与通知都可能失败/被打断，所以 `setPhase` 到终态时
  把「还没做完的事后动作」一起写进票据（`pendingEffects.writeBack` / `.notify`）；做完一项就
  `clearPendingEffect()` 清一项（刻意不走 `setPhase`，否则会重写 `finishedAt` 让「跑了多久」失真）。
  启动时 `replayPendingEffects()` 扫终态票把没做完的补做；`enqueue` / `revise` / `resetByHuman` **都不继承**
  上一轮的 `pendingEffects`。`pipeline_status` 会打「待补：回填表格」。
- **回填失败要进通知**：`writeBack.written === false` 时通知正文多一行
  `回填表格：没写成 —— <原因>（表格里那一行可能还停在「处理中」，请手工改一下）`；成功时不加（避免噪音）。
  注意这只影响通知，不改票态。
- **就地模式的重跑起点**：`isolateWorktree: false` 时每轮重新取检出当前 HEAD 当起点。上一轮已经提交过、
  重跑时 agent 若无新改动，会被判「没有产生任何文件改动」—— 这是预期行为，日志会写新旧两个 head 方便对账。
- **租约是 best-effort，不是原子 CAS**：宿主 storageDomain 的 table API 只有 get/entries/put/delete，
  没有 compare-and-swap 原语。同进程靠调度器的 `running` 单飞，跨进程靠 put 之后二次读确认（被抢就记日志让出）。

## 安装

> 完整的分步流程（含凭据申请、配置示例、mock 首跑、日常循环、排障）见
> **[使用手册 §2-§5](../../docs/ticket-pipeline/user-guide.md)**。

只能走 `plugin_manager install_bundle`（target = 本目录绝对路径，等价 `file:<abs>`），
或直接 `dsh.cmd plugin --profile desktop add "file:<本目录绝对路径>"`。
**不要手改 profile 的 `cordis.patch.yml` / `package.json`。**

装上后总开关 `enabled` 默认是 **`false`** —— 不会自动扫表、建工作区、做提交。
先在配置里填好 `projects[]`（每个项目的工单表定位 + 仓库路径 + 可选验证命令），
再确认飞书凭据（app_secret 走 credentials），最后才打开 `enabled`。

## 已知约束（写代码时踩过的坑，别再踩）

1. **`@deepseek-ai/*` 宿主包在本目录 import 不到**（`ERR_MODULE_NOT_FOUND`）。
   所以 `core/config.js` 手写了 standard-schema、`core/domain.js` 手写 domain spec、
   `tools/define.js` 手写了 `defineTool` 等价物。代价：设置面板拿不到 schemastery
   的结构化 diff，退化成整体替换。校验、默认值、持久化不受影响。
   注意「手写 standard-schema」不等于「手写形状」：设置面板要的是 schemastery 的
   **信封格式** `{ uid, refs }`，所以 `core/config.js` 里的 `descriptorEnvelope()`
   按 uid 引用把整棵树重新打包 —— 详见上面「设置面板」那段与
   `scripts/client-check.mjs` 的 `checkSchemaEnvelope()`。
2. **本机 `npm install` / `npm view` 不可用**（`npm-cache/_logs` 目录不可写），
   无法联网查版本、无法装依赖 —— 所有依赖都在 DSH 宿主或 profile 里，本包零 npm 依赖。
3. **`git push` 在本机不可能**（沙箱禁止给 `git-receive-pack` 建 stdin 管道），
   所以默认交付形态是本机 `git commit`；真要远端 commit/MR 只能走 GitLab Commits API
   （`repo.gitlab.enabled: true` 的可选出口）。
4. DSH 工具的 JSON Schema 子集很严：`type` 只能是单字符串、**不支持 `minimum`/`maximum`**。
   范围校验要在 `execute` 里自己断言。
5. `ctx.timer.interval`/`ctx.timer.timeout` 的实际调用形态是 `ctx.interval`/`ctx.timeout`
   （`ctx.timer` 服务存在，但混入后的 `ctx.interval` 才是常用写法）。
6. **飞书认证接口的响应体没有 `data` 包装** —— `tenant_access_token` 在顶层。
   所以 `apiCall()` 返回整个响应体，业务接口自己取 `payload.data`。
   写成 `return payload.data` 会让认证永远拿不到 token（实测踩过）。
7. **飞书凭据走 `ctx.credentials`，用普通字符串 ref**（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`）。
   不用 branded `credentialRef` —— `@deepseek-ai/dsh-credentials` 只在 asar 内，插件目录 import 不到。
   空串不算已配置，会被当成「没配」报 `auth` 错。
8. **飞书文档级授权必须人工做**：把协作者加给应用只对 `user_access_token` 有效，
   插件用的是 `tenant_access_token`，没法自己给自己加权限。
9. **sandbox ctx 的属性访问是白名单制**（实测踩过，激活期崩溃）：
   `ctx.interval`/`ctx.timeout` 等 timer 类动词要求插件 `inject` 里声明 `'timer'`，
   否则宿主直接抛 `cannot get property "timer" without inject`、整个 bundle 激活失败；
   其余服务（`logger` 等）走 `ctx.get(name)` 弱取（`get` 不要求声明，缺失即降级），
   **不要**写 `ctx.logger` 这种直接属性访问 —— proxy 上它等于「读一个未声明服务」，同样会抛。

## 自测

主入口（工作目录 = 本目录）：

```bash
node scripts/dev-run.mjs
```

**378 项断言，全绿 exit 0**，共 26 个小节（编号到 17，另有 `2b` / `11.5` / `11.6` / `12b`–`12e` / `16b` / `16c` 这类补丁小节；第 16 节专测回填工单表与保留会话，`16b` 专测事后动作补偿（`pendingEffects`）与租约诚实化，`16c` 专测**关键节点流程日志（时间线）**，第 17 节专测分支候选）。
它只用假 ctx 驱动 `src/index.js`（真 `apply()` 装配，但宿主服务全部打桩），
其余测的是 `core/` + `contracts/` + mock 适配器的纯逻辑链路，并转调四个适配器 checks：

| 段 | 覆盖 |
|---|---|
| 内核与契约 | 调度、租约心跳、退避重试、状态机、store 持久化、pipeline_* 四工具、组合根接线；**时间线**：17 节点表、9 主站逐站打点、`✓/✗` 成败、连续同节点合并与 80 条封顶、重新入队/人工重置继承历史、`pipeline_status` 排成时间线并写「现在停在第 N 站，已 X 分 Y 秒没动」、返回体带 `timeline`/`station`/`stalledForMs` |
| `feishu-checks`（59 项） | 假飞书服务端打桩：认证与 token 缓存、401 清缓存重取、single-flight、分页、只收「处理中」、指纹判变更、退役/拨回、截图三形态、SSRF 白名单、字节上限、错误码分类、扫描全程无写操作；**回填**：`writeResult` 走 `PUT …/records/:id` 只写三列、字段缺失（1254040 / 1254045）返 `{written:false,note}` 不抛、写失败时按 91403 分类；**链接解析**：`parseBitableUrl` 从整条表格 URL 里啃出 `?table=` / `?view=`（纯 token 回空串、显式 `tableId` 优先） |
| `gitlab-checks`（86 项） | 假 GitLab 服务端：ensureBranch、Commits API 提交、Draft MR、错误分类（401/404/409/429）、敏感文件过滤；执行器在工作区检出里做本地提交（`commitLocally`：sha/分支/文件、敏感文件不进提交、`repo.gitlab.enabled` 未开时零 GitLab 请求、提交失败让票失败、空提交与缺 git 运行器被拒、git 白名单只放行 `add -- <文件>` / `commit` / `rev-parse HEAD` / `restore --staged -- <文件>` / `stash create` / `hash-object --`）；**基线**：`createBaseline` 拍的基线只读、人的未提交改动与已 `git add` 的改动都进不了本次提交、拍不下来降级不失败；**保留会话**：`sessionId` 三个出口都带回、agent 实例必释放、`keepSession: false` 才回收；**敏感名单**：覆盖各家凭据落盘位置（私钥 / 云 / 证书 / 状态文件）且不误伤「名字像但其实是代码/文档」的文件、被拦文件在 `ExecResult.blockedFiles` 里看得见；**篡改自检**：agent 动了 `.git/hooks` 或插件 `cordis.patch.yml` 就整票失败（不提交也不开 MR）、没有 `readFile` 服务时跳过自检但票照常交付、受保护路径判定与快照比对边界（缺失 / 删除 / 无服务）；`-z` 解析（`parseStatusZ` / `parseNameStatusZ`）：未跟踪新文件要算进改动、重命名的旧路径要进 commit pathspec、删除的路径不能进 `add`、中文名与空格名不被转义；会话 cwd = 项目工作区根、`workingDirectory` 仅在隔离 worktree 打开时钉到隔离子目录、`attachSession` 归属工作区 |
| `push-qqmail`（18 项） | 假 socket 打桩的 SMTP 全流程：EHLO/AUTH LOGIN/MAIL FROM/RCPT TO/DATA、UTF-8 主题编码、多行应答 |
| `wps-checks`（34 项） | 现场构造最小 xlsx（deflate + stored）：zip 解析、截图挂行、「掉出处理中」宽限期、水位兜底；**下载通道**：超时中断报 `network`（可重试）、调用方取消算 `aborted` 且立刻断、`content-length` 谎报超大就当场拒绝、无 `content-length` 时边读边计数超限即断连、跳转最多跟 `MAX_SHEET_REDIRECTS` 跳、逐跳校验协议与主机（`file:` / 未放行主机都拒）；**取数通道**：`scan` 能把 signal 传下去、`wpsOptionsFromMatch` 译出的通道带超时与字节上限（不是裸 fetch） |
| `workspace-checks`（19 项） | 项目工作区：目录不存在给可照做的报错、无 `repo.path`、未登记则登记、已登记则复用、create 幂等、无 registry 降级、create 抛错降级、无 fs 服务、fs 说是文件、同项目多票复用同一工作区、attachSession 归属；**验证命令**：signal 已 aborted 时不起子进程、跑到一半被取消立刻返回并 kill、取消恰好发生在起进程那一瞬间也不漏、到点返回 **124** 不再无限等待、不传 `timeoutMs` 时用 30 分钟缺省；**适配器名**：`workExecutor` / `pushAdapter` 写错一个字要报错并列出可选值（以前静默换成 mock），组合根查不到时抛 `invalid-input` |

另有**全链路接线冒烟**（独立于 dev-run，测「组件之间接没接对」而不是单模块行为）：

```bash
node scripts/chain-smoke.mjs
```

11 项断言：真扫描 → 定位 → 截图入消息 → 执行器 → 通知的完整链路，
含「截图取不到 → needs-info + 通知」「saveImage 返回空 → 跳过图块」等边界。

浏览器端那一半（`lib/client.js`）不进 `dev-run`，有独立两个脚本：

```bash
node scripts/client-check.mjs        # 静态一致性：bundle 里的 Remote 描述符 vs src/remote/descriptors.js
node scripts/client-smoke.mjs        # 假 React 真跑一遍 bundle：注册 slot、渲染表单、保存、体检
```

`client-check` 守的是「bundle 不能 import 宿主源码、只能手抄一份」这条约束 ——
改了 `src/remote/descriptors.js` 忘了改 `lib/client.js` 会**静默无响应**（点了体检没反应、
宿主也不报错），所以这个检查必须跑。它还校验 `require()` 的白名单（只允许
`react` / `react/jsx-runtime` / `react-dom` / `react-dom/client`）、`dsh.client.platform === 'web'`
（platform 写错宿主会静默跳过整个 bundle），以及 **`projects` 子树的 `meta.volatile`**：
descriptor 叶子 **33 个 / 7 组**、schema 信封 **71 节点 / 33 叶子**、Remote **4 个方法**
（`doctor` / `config` / `projects` / `branches`）、`projects` 可写 **25 字段**、面板项目字段 **21 项**与宿主对得上。
（`client-smoke` 真跑一遍 bundle，实跑 **123 条**断言。）

单跑某个适配器（都在 dev-run 里跑过了，单独跑只用于排查）：

```bash
node scripts/feishu-checks.mjs      # exit 0 = 全绿（库式脚本，详情由 dev-run 打印）
node scripts/gitlab-checks.mjs
node scripts/push-qqmail-checks.mjs
node scripts/wps-checks.mjs
```

### 真端到端验收（需要真实凭据，不在自测范围内）

自测全部离线。真链路验收需要：飞书应用凭据（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`）、
可选 `QQMAIL_AUTH_CODE`；**不需要 `GITLAB_TOKEN`** —— 当前交付形态是工作区检出里的本地提交，
只有项目显式 `repo.gitlab.enabled: true` 想额外开 draft MR 时才需要它。
安装插件后在配置里填好 `projects[]`（工单表定位 + 仓库路径 + 验证命令），确认无误后再打开 `enabled`。
