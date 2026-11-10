# 工单流水线（ticket-pipeline）· 开发文档

从工单表检测变化 → 定位代码 → 改动验证 → 在工作区检出里做本地提交 → 回填表格 → 通知。一个 DSH Host 插件。

> **怎么用？** 看 [使用手册](../../docs/ticket-pipeline/user-guide.md) 和 [配置项参考](../../docs/ticket-pipeline/reference/config.md)。
> 本文件面向**改这个插件的人**：模块结构、自测命令、踩过的坑、开发者排障。

## 一句话架构

四个可替换适配器（`TicketSource` / `RepoLocator` / `WorkExecutor` / `PushAdapter`）加一个
内核（`Scheduler` + `TicketStore` + `Config`）。完整设计见
[`docs/ticket-pipeline/architecture.md`](../../docs/ticket-pipeline/architecture.md)。

```
工单表 ──TicketSource──▶ Scheduler ──RepoLocator──▶ 项目仓库（projects[] 查表）
                              │
                              ├──WorkExecutor──▶ 在工作区检出里改码 + 构建/测试 + 本地提交（可选：隔离 worktree、draft MR）
                              │
                              └──PushAdapter──▶ 通知（qqmail 直发 SMTP / pushplus 中继微信，channel=clawbot）
```

## 目录

```
src/
  contracts/         纯接口与数据，不 import 任何具体实现
  core/              scheduler / store / recover / prompt / config / domain / branches / commit-summary
  adapters/
    source-mock/     内存工单源（离线跑通全链路用，每个项目一个实例）
    source-feishu/   飞书多维表格 + 飞书电子表格（sheets.js 纯函数解析、probe.js 连通性探针）
    source-wps/      金山文档共享 Excel（解析已实现；取数需注入 fetchSheet，开放平台通道待接）
    locator-table/   通用仓库定位器：拿 projectId 查 projects[]（不做模块→代码推断）
    executor-mock/   假执行器（离线跑通用）
    executor-agent/  真执行器：拍基线 → 起 agent 改码 → 过滤敏感文件 → 点名暂存 + 本地提交 → 保留会话 → 可选：开 draft MR
    gitlab-client/   GitLab REST 客户端（分支/提交/MR/错误分类）；只在 repo.gitlab.enabled=true 时被调用
    push-mock/       假通知（记内存）
    push-pushplus/   PushPlus 真实现
    push-qqmail/     QQ 邮箱 SMTP 真实现（零依赖手写协议）
  tools/             pipeline_scan / pipeline_status / pipeline_cancel / pipeline_reset / pipeline_doctor
                     （每个都导出一个 collect* 纯「算结果」函数，Remote 那边调同一个）
  remote/            浏览器端可调的 Remote：9 个 direct 方法（见下）
  index.js           组合根 + 三张注册表（SOURCES / EXECUTORS / PUSHES）
lib/
  client.js          浏览器端 bundle：插件设置页（五个页签：运行 / 项目 / 参数 / 凭据 / 体检）
scripts/             自测（不进安装包）；fixtures/ 放已下线适配器的留档
```

`TicketSource` 注册表键：`mock` / `feishu` / `wps`（`webform` 已移除，实现留档在
`scripts/fixtures/source-webform/`）。`WorkExecutor`：`mock` / `agent`。`PushAdapter`：`mock` / `pushplus` / `qqmail`。
换平台 = 在 `src/adapters/<name>/` 写一个实现 + 在 `src/index.js` 的表里加一行，**内核一行都不用改**。

## Remote 方法与设置页

`ticketPipeline` 命名空间下 9 个 direct 方法：

| 方法 | 参数 | 干什么 |
|---|---|---|
| `doctor()` | — | 环境体检（与对话里的 `pipeline_doctor` 同一份 `runDoctor`） |
| `config()` | — | 配置快照（`describeConfig` + 项目数） |
| `projects()` | — | 项目扁平视图（`describeProject`），`appToken` 只下发 `hasAppToken` + 前 4…后 4 |
| `branches()` | — | 全部项目的分支候选（`src/core/branches.js`） |
| `setProjectTable(index, url)` | 2 | 贴整条表格链接 → 宿主解析 → `settings.mutate` 落盘（明文不进浏览器） |
| `status()` | — | 复用 `collectStatus`，`view: 'tickets'` + `includeDone: false` |
| `scan()` | — | 复用 `collectScan`（fire-and-forget） |
| `cancel()` | — | 复用 `collectCancel` |
| `reset(recordId, projectId?)` | 2 | 复用 `collectReset`；`projectId` 是 `acceptsUndefined` |

**工具与面板共用「算结果」那一层**：每个 `tools/pipeline-*.js` 都导出 `collect*`，工具 `execute` 与
`remote/host.js` 都调它。**不要复制实现，也不要用假 `exec` 复用 `execute`** —— 那是把工具外壳当内部 API，
将来 `defineTool` 加前置时 Remote 会绕过。`remote/host.js` 的 constructor 多收
`store` / `scheduler` / `gitRunner` / `log`，全部可选，缺了给人话（`requireStore()`）。

设置页细节：

- **五个页签**（运行 / 项目 / 参数 / 凭据 / 体检），**缺省停在「运行」**。一次只画一页（不是藏起来）。
  页签上只在真有未保存 / 待修时才挂数字。
- **参数页按分组渲染 25 个字段 / 4 个分组**；`enabled` 被提成页面级**主开关**置顶（不在任何分组里）。
- **项目页 `projects[]` 可编辑**：`listProjectDescriptorPaths()` 共 **34 个深层路径**（面板画 **33 个控件**，
  `match.appToken` 没有明文输入框，走「工单表链接」）。缺省只显示常改字段，其余收在「显示全部字段」；
  分组可折叠，脏字段带「已改」徽标并能单字段撤销；改过或有错的字段无论收起与否都会露出来
  —— 折叠不能成为遮蔽错误的工具。保存只发改动过的**深层路径**（`['projects','0','repo','path']` 这种），
  绝不整数组替换，否则会抹掉别的项目和手写进去的 `appToken`。
- 凭据只写不读回（`ctx.get('remote.credentials')`），界面只显示「已配置 / 未配置」。
- 控件全部自写 —— 宿主 `practices.md` 禁止把 `dsh-client-ui-primitives` 之类客户端包当模块加载。

## 踩过的坑（改设置页之前必读）

**descriptor 信封**：`src/core/config.js` 在 `Config` 上挂了一棵手写的 schema descriptor，宿主 `dsh-settings`
用它投影出可写字段。**没挂 descriptor 时宿主会静默跳过整条设置项** —— 加字段后记得同步 `CONFIG_GROUPS`，
`node scripts/client-check.mjs` 会查。`toJSON()` 必须返回 schemastery 的**信封** `{ uid, refs }`，
`refs` 里 `dict`/`inner`/`list` 的值是 **uid 数字**（引用），不能是内联对象；引用一旦断了，
浏览器里 `inner` 变成 `undefined`，校验抛 `Cannot read properties of undefined (reading 'meta')`，
又被客户端 `catch` 静默吞掉 ⇒ **整块面板永远停在 loading，不显示也不报错**。

**`projects` 子树必须自己标 `meta.volatile = true`**（`inner` 里的子节点也要标）。宿主 `isVolatilePath(schema, path)`
只沿 `schema.dict` 往下走、完全不认 `inner`，而 `projects` 是数组 —— 深层路径只能靠根节点自己 volatile 短路放行，
否则每次保存都被拒成 `Config field "projects" is not volatile`。`client-check.mjs` 的 `auditProjectsNode()` 逐层查。

**命名空间服务一律走 `ctx.get('remote.<ns>')`，不能写 `ctx.remote.<ns>`**。`settings` / `credentials` / `ticketPipeline`
三个命名空间是 gateway 装在**兄弟 fiber** 上的独立服务，不是 `remote` 对象的属性 —— cordis 的属性访问沿 fiber 链
**向上**找 provide，兄弟不是祖先 ⇒ 抛 `cannot get property "remote.settings" without inject`，
错误边界把面板接住 ⇒ **整页空白，控制台只有一行用户看不懂的报错**。`ctx.get(name)` 查全局服务 store，兄弟的也取得到。

反过来，**不能把 `ticketPipeline` 写进 `inject`**：它是自己用 `remote.$mount()` 建的，写进 inject 等于
「等自己把命名空间建出来」⇒ fiber 永远不激活、`apply` 一次都不执行（表现：配置页静默全空，「配置」按钮都不出现）。
所以 `inject` 里只留 `['slots']`。

**sandbox ctx 的属性访问是白名单制**：`ctx.interval` / `ctx.timeout` 这类 timer 动词要求 `inject` 里声明 `'timer'`，
否则宿主抛 `cannot get property "timer" without inject`、**整个 bundle 激活失败**；
其余服务（`logger` 等）走 `ctx.get(name)` 弱取。**不要**写 `ctx.logger` —— proxy 上它等于「读一个未声明服务」，同样会抛。

## 开发者 FAQ

**Q：`pipeline_status` 报 `value is not lossless JSON`？**
工具的返回体里出现了 `undefined`。宿主工具通道要求 lossless JSON，`defineTool` 里虽然有 `stripUndefined`
（对象跳过 `undefined` 键、数组里 `undefined` → `null`），但只要有一处漏出来整次调用就失败。
往返回体里加字段时，`null` 与 `undefined` 要分清：**没有值时给 `null`，不要给 `undefined`**（例如 `commitSummary`）。

**Q：设置页空白 / 显示「暂无配置项」？**
三种原因，按概率排：① `inject` 里误写了 `ticketPipeline`（fiber 不激活）；② descriptor 信封的 uid 引用断了
（上面那个 `reading 'meta'`）；③ `Config` 上没挂 descriptor 或没同步 `CONFIG_GROUPS`。
`node scripts/client-check.mjs` 能抓 ②③，①只能看代码。

**Q：插件页里那一行没有「配置」按钮？**
`apply()` 没跑到（同上三条）或 `dsh.client.platform !== 'web'`。`client-check` 会验 platform。

**Q：怎么知道宿主跑的是不是最新代码？**
`pipeline_doctor` 最后一节比**文件内容**（`src/**/*.js`、`lib/**/*.js`、`cordis.patch.yml`、`icon.svg`、`locale/*.json`），
落后时直接给同步命令。它只进「提醒」不进「必须修复」—— 旧版照样能把工单跑完，只是行为不是你刚改的那份。
为什么不比版本号、不跟 origin 比、为什么 HMR 不会自己发现：见 `architecture.md` §12.11。

**Q：改了插件代码，怎么让宿主跑上新代码？**
三件事，少一件都不生效：

1. **把本目录同步到安装副本**（`dsh.cmd plugin --profile desktop add` 走的是拷进 profile 的副本，不是这个目录）。
   `pipeline_doctor` 会告诉你「把哪个目录同步到哪个目录」。
2. **重启宿主**（桌面包由 Electron 独占管理，刷新页面不算）。
3. **`lib/client.js` 是浏览器 bundle**：改完还要让宿重重发 bundle 才能生效（重启覆盖这一点）。

**Q：在设置页改了配置，为什么行为没立刻变？**
配置是读一次快照用的，改动落盘后由宿主 `settings` 服务通知插件重读；但**已打开的面板页面**要刷新才重取。
`pipeline_scan` / 巡检间隔这类由宿主 timer 驱动的动作，也可能要等下一个 tick。

## 自测

主入口（工作目录 = 本目录）：

```bash
node scripts/dev-run.mjs
```

**482 项断言，全绿 exit 0**，共 **31 个小节**（编号到 18，另有 `2b` / `11.5` / `11.6` / `12b`–`12e` / `16a`–`16d` 这类补丁小节）。
它只用假 ctx 驱动 `src/index.js`（真 `apply()` 装配，宿主服务全部打桩），其余测的是
`core/` + `contracts/` + mock 适配器的纯逻辑链路，并转调五个适配器 checks：

| 段 | 项数 | 覆盖 |
|---|---|---|
| 内核与契约 | — | 调度、租约心跳、退避重试、状态机、store 持久化、`pipeline_*` 五工具、组合根接线；`pipeline_status` 两种视图（缺省 `view: 'overview'` 按项目聚合，`view: 'tickets'` 明细）；时间线 17 节点表 / 9 主站 / 80 条封顶 |
| `feishu-checks` | **93** | 假飞书服务端：认证与 token 缓存、401 清缓存重取、single-flight、分页、只收「处理中」、指纹判变更、退役/拨回、截图三形态、SSRF 白名单、错误码分类、扫描全程无写；回填 `PUT …/records/:id` 只写三列、字段缺失返 `{written:false,note}` 不抛、91403 分类；`parseBitableUrl` 链接解析；**电子表格 19 条**（表型分派、裸 token 双试、读值定位、`sheetHeaderRow=2`、列名别名、空序号兜底、序号重复报错、水位三态）；**电子表格回填 8 条**（写对三格、插行后重定位、行被删、缺列、只有读权限、失败票只写一格、回填后不重复收票、token 与工作表 id） |
| `gitlab-checks` | **86** | 假 GitLab 服务端：ensureBranch、Commits API、Draft MR、错误分类、敏感文件过滤；本地提交 `commitLocally`；基线 `createBaseline`；保留会话；敏感名单 8 大类 41 条；`.git` 与 profile 篡改自检；`-z` 解析；会话 cwd 与 `workingDirectory` |
| `push-qqmail-checks` | **18** | 假 socket 打桩的 SMTP 全流程：EHLO/AUTH LOGIN/MAIL FROM/RCPT TO/DATA、UTF-8 主题编码、多行应答 |
| `wps-checks` | **34** | 现场构造最小 xlsx：zip 解析、截图挂行、宽限期、水位兜底；下载通道超时/取消/字节上限/跳转校验；取数通道 signal 透传 |
| `workspace-checks` | **19** | 项目工作区登记与复用；验证命令 signal / 超时 124 / 缺省 30 分钟；适配器名写错要报错并列出可选值 |

另有**全链路接线冒烟**（测「组件之间接没接对」）：

```bash
node scripts/chain-smoke.mjs     # 11 项：真扫描 → 定位 → 截图入消息 → 执行器 → 通知
```

浏览器端那一半（`lib/client.js`）不进 `dev-run`，有独立两个脚本：

```bash
node scripts/client-check.mjs        # 静态一致性：bundle 里的 Remote 描述符 vs src/remote/descriptors.js
node scripts/client-smoke.mjs        # 假 React 真跑一遍 bundle：注册 slot、渲染表单、保存、体检
```

`client-check` 守的是「bundle 不能 import 宿主源码、只能手抄一份」这条约束 —— 改了
`src/remote/descriptors.js` 忘了改 `lib/client.js` 会**静默无响应**（点了体检没反应、宿主也不报错）。
它同时校验 `require()` 白名单（只允许 `react` / `react/jsx-runtime` / `react-dom` / `react-dom/client`）、
`dsh.client.platform === 'web'`（写错宿主会静默跳过整个 bundle），以及 descriptor 数字：
叶子 **25 个 / 4 组**、schema 信封 **72 节点 / 25 叶子**、Remote **9 个方法**、`projects` 可写 **34 字段**、
面板项目字段 **33 项**。`client-smoke` 真跑一遍 bundle，**206 条**断言。

单跑某个适配器（都在 dev-run 里跑过了，单独跑只用于排查）：

```bash
node scripts/feishu-checks.mjs      # exit 0 = 全绿（库式脚本，详情由 dev-run 打印）
node scripts/gitlab-checks.mjs
node scripts/push-qqmail-checks.mjs  # 这个会自己打印项数
node scripts/wps-checks.mjs
```

### 真端到端验收（需要真实凭据，不在自测范围内）

自测全部离线。真链路验收需要 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`、可选 `QQMAIL_AUTH_CODE`；
**不需要 `GITLAB_TOKEN`** —— 交付形态是工作区检出里的本地提交，只有项目显式打开远程 MR 才需要它。
填好 `projects[]` 并确认无误后再打开 `enabled`。

## 关键决策（勿擅自改）

- **扫描只读，回填是唯一写入口**：`scan()` 全程不写远端状态。跑成 `done` / `skipped` 之后调一次
  `writeResult()`，只写「是否处理 / 处理结果 / 处理日期」三列。`failed` 不回填（留在「处理中」是刻意留的信号）；
  回填失败只记在工单行上、状态不回退、通知照发。见 [ADR-0006](../../docs/adr/0006-处理完回填工单表.md)。
- **`record_id` 是平台内唯一身份**，不用「序号」列。跨项目用复合主键 `ticketKey(projectId, recordId)`。
  电子表格没有 `record_id`，用序号列拼 `sh-<序号>`，所以**回填必须按序号重新定位行**（行号会漂移）。
- **变更检测靠轮询**（飞书没有可靠的单元格变更事件），间隔读 `pollIntervalMinutes`（缺省 3 分钟）。
- **并发恒 1**：一轮最多跑一张工单、最多清一个 worktree。多张同时改同一个工作区检出会互相踩。
- **默认只做本地提交，不开 MR**：交付形态是工作区检出里的一次 `git commit`。远程 draft MR 是可选出口
  （`repo.gitlab.enabled: true`，实验性），而且 `git push` 在本机被沙箱封死，只能走 GitLab Commits API。
- **`accepted` ≠ 送达**：PushPlus `code:200` 只代表受理，真送达看 `callbackUrl` 的 `sendStatus`。
- **项目工作区复用**：`projects[].repo.path` 那个目录就是项目工作区，插件确保它在 `workspaceRegistry` 有一份登记。
  **缺省（`isolateWorktree: false`）就直接在这个检出里改代码**，分支 = 检出当前分支、不另开票分支；
  **检出脏也能跑**（agent 动手前用 `git stash create` 拍只读基线，结束后只提交 agent 真正改过的文件）。
  打开 `isolateWorktree: true` 才退回旧行为（每票 `git fetch` + `git worktree add`）。
  会话 header cwd 用**工作区根**（宿主 `attachSession` 要求），只有 `worktreePath !== workspacePath` 时才用
  `workingDirectory.set` 钉到隔离子目录。
- **清理安全**：`removeWorktree` / `listExpiredWorktrees` 先过 `isIsolatedWorktreePath()`
  （只认 `<repo>/.agents/worktrees/<name>`）—— 不校验的话 `git worktree remove --force` 会对着人的主检出执行。
- **超时只报给人，不自动重试**；重开走 `pipeline_reset`（面板「运行」页签有「重跑」按钮）。
- **处理完保留会话**：`sessionId` 落工单行；agent 实例在 `finally` 里**永远** `dispose()`，
  但 `keepSession !== false` 时不做会话回收，人能在会话列表点进去继续追问。
- **适配器名写错就报错，不静默退回 mock**：`workExecutor` / `pushAdapter` 都有 `enum`，写错（含大小写、
  尾空格）激活期直接抛 `invalid-input` 并列出可选值。以前 `?? EXECUTORS.mock` 会让 `Agent` 这类笔误
  静默跑完整条链路 —— 不改一行代码、给工单打 `passed`、写个假 commit sha、回填「已按工单改完并提交」，
  是最难发现的「看起来成功」的假执行。
- **验证命令必须有超时与取消**：缺省 30 分钟，超时退出码 **124**（与「检查没通过」区分开）；`signal` 进宿主
  `shell.resolve`，取消会真的 kill。宿主 `bash-local` 的 `maxTimeoutMs` 缺省 10 分钟会把它夹下去。
  没有这一层时一条卡住的 `npm test` 会让单飞标记恒 `true` ⇒ **整条流水线静默停摆且取消不了**。
- **敏感文件名单 8 大类 / 41 条正则**：被拦文件进 `blockedFiles`，写进提交说明的「未提交」一行。
  名单按「已知后缀白名单」写而不是通配，所以 `src/env.js`、`docs/credentials.md` 不会被误伤。
- **`.git` 与插件 profile 的篡改自检**：agent 动手前与提交前各拍 sha256 快照（10 个 git 元数据文件 +
  28 个官方 hook 名 + 4 个 profile 文件），动过就撤回暂存、判 `failed` + `invalid-input` 并点名文件。
  **这是「被发现」不是「被阻止」**。
- **approval / policy 仍是 `never`**：宿主只有 `ask` / `never`，`ask` 在无头场景 fail-closed 会让每一步工具
  调用失败。兜底只有 git 白名单 + 篡改自检，**不是硬隔离**。
- **终态与事后动作同一次落库（`pendingEffects`）**：做完一项清一项（刻意不走 `setPhase`，否则会重写
  `finishedAt` 让「跑了多久」失真）；启动时 `replayPendingEffects()` 补做。
- **交付维度与 phase 正交**（`delivery.commit` / `.writeBack` / `.notify`）：`phase` 答「走到哪」，
  `delivery` 答「该交付的交给去了没有」。见 [ADR-0007](../../docs/adr/0007-交付维度.md)。
- **租约是 best-effort，不是原子 CAS**：宿主 storageDomain 只有 get/entries/put/delete，没有 compare-and-swap。
  同进程靠 `running` 单飞，跨进程靠 put 之后二次读确认。

## 安装

只能走 `plugin_manager install_bundle`（target = 本目录绝对路径，等价 `file:<abs>`），
或 `dsh.cmd plugin --profile desktop add "file:<本目录绝对路径>"`。
**不要手改 profile 的 `cordis.patch.yml` / `package.json`。**
装上后 `enabled` 缺省 `false`，不会自动扫表、建工作区、做提交。

## 已知约束（别再踩）

1. **`@deepseek-ai/*` 宿主包在本目录 import 不到**（`ERR_MODULE_NOT_FOUND`），所以 `core/config.js` 手写了
   standard-schema、`core/domain.js` 手写 domain spec、`tools/define.js` 手写 `defineTool` 等价物。
   代价：设置面板拿不到 schemastery 的结构化 diff，退化成整体替换。
2. **本机 `npm install` / `npm view` 不可用**（npm cache 目录不可写）—— 本包零 npm 依赖，全在宿主或 profile 里。
3. **`git push` 在本机不可能**（沙箱禁止给 `git-receive-pack` 建 stdin 管道），所以默认交付形态是本机 commit。
4. DSH 工具的 JSON Schema 子集很严：`type` 只能是单字符串、**不支持 `minimum`/`maximum`**，范围校验要在
   `execute` 里自己断言。
5. `ctx.timer.interval` / `ctx.timer.timeout` 的实际调用形态是 `ctx.interval` / `ctx.timeout`。
6. **飞书认证接口的响应体没有 `data` 包装** —— `tenant_access_token` 在顶层。`apiCall()` 返回整个响应体，
   业务接口自己取 `payload.data`。写成 `return payload.data` 会让认证永远拿不到 token。
7. **飞书凭据走 `ctx.credentials`，用普通字符串 ref**（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`），不用 branded
   `credentialRef` —— `@deepseek-ai/dsh-credentials` 只在 asar 内，插件目录 import 不到。空串算「没配」。
8. **飞书文档级授权必须人工做**：把协作者加给应用只对 `user_access_token` 有效，插件用的是 `tenant_access_token`。
9. **改源码文件只用编辑工具或 node `writeFileSync(...,'utf8')`**：PowerShell 的 `Get-Content | Set-Content`
   会毁掉 UTF-8 中文（实测把 2130 行写成 1 行）。含 `$` / `{}` 的内联 `node -e` 也会被 shell 吃掉，改写成脚本文件再跑。
