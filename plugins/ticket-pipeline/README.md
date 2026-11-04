# 工单流水线（ticket-pipeline）

从工单表检测变化 → 定位代码 → 改动验证 → 开 draft MR → 微信推送。一个 DSH Host 插件。

## 一句话架构

四个可替换适配器（`TicketSource` / `RepoLocator` / `WorkExecutor` / `PushAdapter`）加一个
内核（`Scheduler` + `TicketStore` + `Config`）。完整设计见
[`docs/ticket-pipeline/architecture.md`](../../docs/ticket-pipeline/architecture.md)。

```
工单表 ──TicketSource──▶ Scheduler ──RepoLocator──▶ 项目仓库（projects[] 查表）
                              │
                              ├──WorkExecutor──▶ worktree 改码 + 构建/测试 + draft MR
                              │
                              └──PushAdapter──▶ 微信通知（PushPlus channel=clawbot）
```

## 目录

```
src/
  contracts/         纯接口与数据，不 import 任何具体实现
  core/              scheduler / store / recover / prompt / config / domain
  adapters/
    source-mock/     内存工单源（离线跑通全链路用，每个项目一个实例）
    source-feishu/   飞书多维表格（真实实现，票 #12）
    source-wps/      金山文档（不实现，见文件内说明）
    locator-table/   通用仓库定位器：拿 projectId 查 projects[]（不做模块→代码推断）
    executor-mock/   假执行器（离线跑通用）
    executor-agent/  真执行器（占位，需单独的地图票）
    push-mock/       假通知（记内存）
    push-pushplus/   PushPlus 真实现
  tools/             pipeline_scan / pipeline_status 两个工具
  index.js           组合根 + 三张注册表（SOURCES / EXECUTORS / PUSHES）
```

## 三个可替换件

| 接口 | 注册表键 | 现状 |
|---|---|---|
| `TicketSource` | `mock` / `feishu` / `wps` | mock ✅ / feishu ✅ / wps 不实现 |
| `WorkExecutor` | `mock` / `agent` | mock ✅ / agent 占位 |
| `PushAdapter` | `mock` / `pushplus` | mock ✅ / pushplus ✅ |

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

只能走 `plugin_manager install_bundle`（target = 本目录绝对路径，等价 `file:<abs>`）。
**不要手改 profile 的 `cordis.patch.yml` / `package.json`。**

装上后总开关 `enabled` 默认是 **`false`** —— 不会自动扫表、建工作区、开 MR。
先在配置里填好 `projects[]`（每个项目的工单表定位 + 仓库路径 + 可选验证命令），
再确认飞书凭据（app_secret 走 credentials），最后才打开 `enabled`。

## 已知约束（写代码时踩过的坑，别再踩）

1. **`@deepseek-ai/*` 宿主包在本目录 import 不到**（`ERR_MODULE_NOT_FOUND`）。
   所以 `core/config.js` 手写了 standard-schema、`core/domain.js` 手写 domain spec、
   `tools/define.js` 手写了 `defineTool` 等价物。代价：设置面板拿不到 schemastery
   的结构化 diff，退化成整体替换。校验、默认值、持久化不受影响。
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

## 自测

```bash
node scripts/dev-run.mjs
```

54 项断言，全绿 exit 0。它**不 import `src/index.js`**（那需要宿主服务），
测的是 `core/` + `contracts/` + mock 适配器的纯逻辑链路，
外加第 9 节的**飞书适配器打桩测试**（`scripts/feishu-checks.mjs`，假飞书服务端，不联网）。

第 9 节覆盖：认证与 token 缓存、`records/search` 的 `page_size`/`automatic_fields`/降序排序、
只收「处理中」、下拉字段形状规范化、水位推进与内容指纹判变更、`safePageRun` 停止条件、
状态改走退役 / 拨回重开、连续多轮不见才退役、截图三形态取字节、
`docNamePattern` 命中 0 张或 >1 张 = 配置错误、`sort` 被拒时兜底重试、
飞书错误码分类、凭据缺失、扫描取消，以及**全程没有写操作**。
