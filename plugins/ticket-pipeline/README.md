# 工单流水线（ticket-pipeline）

从工单表检测变化 → 定位代码 → 改动验证 → 开 draft MR → 通知（QQ 邮箱 SMTP / PushPlus 中继微信）。一个 DSH Host 插件。

> 📖 **怎么用？** 看 [使用手册](../../docs/ticket-pipeline/user-guide.md) ——
> 从准备工单表、配凭据、装插件，到 mock 首跑、切真执行、日常循环与排障，全流程一步步讲。

## 一句话架构

四个可替换适配器（`TicketSource` / `RepoLocator` / `WorkExecutor` / `PushAdapter`）加一个
内核（`Scheduler` + `TicketStore` + `Config`）。完整设计见
[`docs/ticket-pipeline/architecture.md`](../../docs/ticket-pipeline/architecture.md)。

```
工单表 ──TicketSource──▶ Scheduler ──RepoLocator──▶ 项目仓库（projects[] 查表）
                              │
                              ├──WorkExecutor──▶ worktree 改码 + 构建/测试 + draft MR
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
    executor-agent/  真执行器：起 agent 改码 → 过滤敏感文件 → GitLab Commits API 提交 → Draft MR
    gitlab-client/   GitLab REST 客户端（分支/提交/MR/错误分类）
    push-mock/       假通知（记内存）
    push-pushplus/   PushPlus 真实现
    push-qqmail/     QQ 邮箱 SMTP 真实现（零依赖手写协议）
  tools/             pipeline_scan / pipeline_status / pipeline_cancel / pipeline_reset / pipeline_doctor 五个工具
  remote/            浏览器端可调的自建 Remote（ticketPipeline/doctor、ticketPipeline/config）
  index.js           组合根 + 三张注册表（SOURCES / EXECUTORS / PUSHES）
lib/
  client.js          浏览器端 bundle：插件设置页（填配置 + 凭据 + 立即体检）
```

## 设置页

插件详情页里本插件那一行有「配置」按钮，点进去是一整页：

- **环境体检**：「立即体检」按钮跑 `runDoctor`（与对话里的 `pipeline_doctor` 同一份逻辑），
  结果按「必须修复 / 提醒」分段显示。
- **凭据**：飞书 App ID / App Secret、QQ 邮箱授权码、GitLab Token、PushPlus token，
  只写不读回（写入走 `ctx.get('remote.credentials')`，界面只显示「已配置 / 未配置」）。
- **配置**：按分组渲染 29 个字段，保存走 `ctx.get('remote.settings').mutate`（写 profile 的
  `cordis.patch.yml`，重启后仍在）。`projects[]` 是结构化数组，不在这张表单里，仍需手改配置（见使用手册 §3）。

表单不自带渲染器：`src/core/config.js` 在 `Config` 上挂了一棵手写的 schema descriptor
（每个节点带 `toJSON`、叶子带 `meta.volatile`），宿主 `dsh-settings` 用它投影出可写字段。
**没挂 descriptor 时宿主会静默跳过整条设置项** —— 加字段后记得同步 `CONFIG_GROUPS`，
`node scripts/client-check.mjs` 会检查这一点。

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

- **工单表只读**：不回写处理结果/处理人/PR 链接。收票条件 = `是否处理 = 处理中`。
- **`record_id` 是平台内唯一身份**，不用「序号」列（人手填、会重排）。**跨项目用复合主键** `ticketKey(projectId, recordId)`。
- **项目清单在插件配置 `projects[]` 里维护**（工单→项目在表级绑定，一个项目一条配置：name + match + repo + verify）。
- **变更检测靠轮询**：飞书没有可靠的单元格变更事件。间隔读 `Config.pollIntervalMinutes`（默认 3 分钟）。
- **并发恒 1**：一轮最多跑一票、最多清一个 worktree。
- **只开 draft MR**：`git push` 在本机被沙箱封死，改动经 GitLab Commits API 物化，MR 标题必须 `Draft:` 前缀。
- **`accepted` ≠ 送达**：PushPlus `code:200` 只代表受理，真送达看 `callbackUrl` 的 `sendStatus`。
- **每票一个 worktree**，分支 `<branchPrefix><projectId>-<recordId>-r<修订号>`，切前先 `git fetch` 该项目配置的 baseBranch。
- **超时只报给人，不自动重试**；唯一重开路径 = 人把「是否处理」拨走再拨回「处理中」。

## 安装

> 完整的分步流程（含凭据申请、配置示例、mock 首跑、日常循环、排障）见
> **[使用手册 §2-§5](../../docs/ticket-pipeline/user-guide.md)**。

只能走 `plugin_manager install_bundle`（target = 本目录绝对路径，等价 `file:<abs>`），
或直接 `dsh.cmd plugin --profile desktop add "file:<本目录绝对路径>"`。
**不要手改 profile 的 `cordis.patch.yml` / `package.json`。**

装上后总开关 `enabled` 默认是 **`false`** —— 不会自动扫表、建工作区、开 MR。
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
   所以走 GitLab Commits API 而非 push。
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

**153 项断言，全绿 exit 0**，共 13 段。它不 import `src/index.js`（那需要宿主服务），
测的是 `core/` + `contracts/` + mock 适配器的纯逻辑链路，并转调四个适配器 checks：

| 段 | 覆盖 |
|---|---|
| 内核与契约 | 调度、租约心跳、退避重试、状态机、store 持久化、pipeline_* 四工具、组合根接线 |
| `feishu-checks`（37 项） | 假飞书服务端打桩：认证与 token 缓存、401 清缓存重取、single-flight、分页、只收「处理中」、指纹判变更、退役/拨回、截图三形态、SSRF 白名单、字节上限、错误码分类、全程无写操作 |
| `gitlab-checks`（25 项） | 假 GitLab 服务端：ensureBranch、Commits API 提交、Draft MR、错误分类（401/404/409/429）、敏感文件过滤 |
| `push-qqmail`（18 项） | 假 socket 打桩的 SMTP 全流程：EHLO/AUTH LOGIN/MAIL FROM/RCPT TO/DATA、UTF-8 主题编码、多行应答 |
| `wps-checks`（21 项） | 现场构造最小 xlsx（deflate + stored）：zip 解析、截图挂行、「掉出处理中」宽限期、水位兜底 |

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
`react` / `react/jsx-runtime` / `react-dom` / `react-dom/client`）与 `dsh.client.platform === 'web'`
（platform 写错宿主会静默跳过整个 bundle）。

单跑某个适配器（都在 dev-run 里跑过了，单独跑只用于排查）：

```bash
node scripts/feishu-checks.mjs      # exit 0 = 全绿（库式脚本，详情由 dev-run 打印）
node scripts/gitlab-checks.mjs
node scripts/push-qqmail-checks.mjs
node scripts/wps-checks.mjs
```

### 真端到端验收（需要真实凭据，不在自测范围内）

自测全部离线。真链路验收需要：飞书应用凭据（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`）、
`GITLAB_TOKEN`、可选 `QQMAIL_AUTH_CODE`；安装插件后在配置里填好 `projects[]`
（工单表定位 + 仓库路径 + 验证命令），确认无误后再打开 `enabled`。
