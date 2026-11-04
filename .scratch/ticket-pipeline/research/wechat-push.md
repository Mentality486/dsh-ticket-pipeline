# WorkBuddy 微信助理：外部进程推送通路调研

调研时间：2026-11-03 19:00–19:20（本机 Windows 11，Git-bash 只读探测）
调研对象：`D:\ProgramFiles\workbuddy`（appVersion **5.9.2**，安装包版本 37.10.3-43），数据目录 `C:\Users\Administrator\.workbuddy\`
用户诉求原文：*「我现在使用的 workbuddy 中的微信助理」* —— 即让流水线在开完 draft MR 后把消息推到**用户自己的微信**。

> 全文结论均标注证据；未核实项单独标 `⚠ 未核实`。调研过程**未修改** WorkBuddy 任何文件、未发送任何消息、未启停进程、未解密并打印任何凭据明文。

---

## 0. 结论速览

| # | 通路 | 能否让外部进程发微信 | 评级 | 依据 |
|---|---|---|---|---|
| 1 | WorkBuddy 主进程本地 HTTP（`127.0.0.1:18488`，LocalProbeServer） | ❌ 只有一个健康探针 GET | **不可用** | §1.1 |
| 2 | WorkBuddy daemon 本地 HTTP（`127.0.0.1:54423` LocalMcpHost / `:58155` / `:61990`） | ❌ 每路由一把一次性 token，由 WorkBuddy 单向注入给自家 MCP 子进程 | **需逆向-不做** | §1.2 |
| 3 | 命名管道 WBIPC（`\\.\pipe\wbipc-<id>`） | ❌ 私有 framed JSON-RPC + `session_hello` + bucket 校验 | **需逆向-不做** | §1.3 |
| 4 | EvalProxyServer（`127.0.0.1:18485`） | ❌ 生产构建里 `evalModeEnabled` 被硬编码为 `false`，永不启动 | **不可用**（非「开开关」即可） | §1.4 |
| 5 | `codebuddy` CLI | ❌ 是 agent CLI，无任何推送/微信子命令 | **不可用** | §2 |
| 6 | 把 WorkBuddy 当 MCP server 用 | ❌ `mcp.json` 全是**出站** client 配置，无 server 侧监听配置 | **不可用** | §3 |
| 7 | WorkBuddy automation → `push_to_wechat` → 云端 `wechatmpProxy/push` | ⚠️ 是官方链路，但**入口只能在 WorkBuddy UI 里配**，外部进程无法编程触发；且目标是公众号/客服通道 | **需用户在 UI 操作** | §4.1 |
| 8 | WorkBuddy automation → `push_to_wecom_bot` / `automation.wecomWebhookUrl` | ⚠️ 官方 UI 支持、有「测试推送」按钮，但目标是**企微群机器人/企微 AI Bot**，不是微信个人号 | **需用户在 UI 操作** | §4.2 |
| 9 | 解 `botToken` 后直连 iLink `sendmessage` | ❌ 密钥根（protectorKey）未定位；且**即使解开也无法主动推送**（缺 `context_token`），还会与 WorkBuddy 现有长轮询抢游标 | **需逆向-不做** | §5 |
| 10 | **PushPlus `channel=clawbot`** | ✅ 官方支持基于微信 ClawBot 协议做**主动推送**，用户扫码绑定即可 | **需用户提供凭据（推荐）** | §6.1 |
| 11 | 企业微信群机器人 webhook | ✅ 一次 POST，用户给 key | **需用户提供凭据（备选）** | §6.2 |
| 12 | Server酱 Turbo | ✅ 一次 POST，用户给 SENDKEY | **需用户提供凭据（备选）** | §6.3 ⚠ 未核实字段 |

**一句话**：WorkBuddy **没有**任何「受支持的、供外部进程调用的发消息接口**；它自己的微信通道是**被动回复语义**（必须有 inbound 消息带来的 `context_token`），而本机日志显示该通道上线至今 **`msgs:0`，从未收到过任何消息**。因此要让流水线主动推微信，只能走**第三方推送 SaaS（PushPlus ClawBot / Server酱）或企微群机器人**，用可替换适配器接进来。

---

## 1. 本地 HTTP / IPC 接口

### 1.1 主进程 LocalProbeServer —— 只有一个健康探针

源码在 asar 条目 `main/nunjucks.js`（条目 offset 11644248，size 93006；命中区约在 asar 全局 offset 11680352）。常量：

```
LOCAL_PROBE_DEFAULT_PORTS = [18488, 18489, 18490]
路径常量 = "/workbuddy/probe"
```

实测（主进程 PID 7228，`netstat -ano` 显示 `TCP 127.0.0.1:18488 LISTENING 7228`）：

```
GET http://127.0.0.1:18488/workbuddy/probe
→ 200 {"ok":true,"app":"workbuddy-desktop","version":"5.9.2","platform":"win32"}
   Access-Control-Allow-Origin: *   只允许 GET, OPTIONS

GET /            → 404 {"ok":false,"error":"Not Found"}
GET /health      → 404 同上
GET /api/v1/status → 404 同上
非 GET 方法       → 405
```

`handleRequest` 只实现 `OPTIONS` 与该唯一 `GET`。

**结论：本地 HTTP 面 = 一个健康探针。无鉴权，也无发消息能力。**

> 顺带纠正背景中的一条旧线索：日志里出现的 `127.0.0.1:54423` **不是**浏览器/代理，而是 WorkBuddy daemon 的 LocalMcpHost（见 §1.2）。此前「属于另一个进程」的判断是端口号巧合导致的误判。

### 1.2 daemon 本地 HTTP —— 三个口，全部不可外部复用

`netstat -ano` 实际监听（PID 13292 = WorkBuddy daemon）：

| 端口 | 服务 | 实测 |
|---|---|---|
| `127.0.0.1:54423` | **LocalMcpHost** | `GET /healthz` → `200 {"status":"ok","routes":8}`；`GET /` → `404 {"error":"not_found"}`（带 `X-Request-Id`）；`GET /mcp`、`POST /mcp`（JSON-RPC `initialize`）→ **`401 {"error":"unauthorized"}`** |
| `127.0.0.1:58155` | 内部 server | 全裸 404，`Connection: keep-alive, timeout=5`，`/healthz`、`/mcp` 均 404 |
| `127.0.0.1:61990` | 内部 server | `{"error":"not_found"}` 形态，`/healthz` 亦 404 |

另外试过并全部 404/401 的路径：`/health`、`/ping`、`/api/v1/ping`、`/workbuddy/probe`、`/v1/models`、`/api/status`、`/sse`、`/messages`、`/acp`、`/rpc`。

`LocalMcpHost` 源码（asar 全局 offset 15972647，`var LocalMcpHost=class`）关键行为：

- `start()` → `listenOnLoopback$1(e)`，即 `e.listen(0,'127.0.0.1')` —— **随机端口，只绑回环**。端口只能靠 `netstat` 或日志（`[McpHost] 监听回环端口 <port>`，中文在 asar 中被转义为 `\u76D1\u542C...`）发现。
- `dispatch(req,res)` 顺序：写 `X-Request-Id` → `verifyLoopbackHost` + `verifyOrigin`（`allowedOrigins` 集合）→ `/healthz` 特判 → `/.well-known/*` 一律 404 → `routes.resolve(path)` 未命中则 `404 not_found` / `410 route_gone` → `this.authorize(...)` **失败直接写 401 并返回** → 方法不匹配 `405 method_not_allowed`。
- 授权三件套 `{routes, tokens, envelope}`；`routes.onDidUnregister(routeKey => tokens.revoke(routeKey))`、`tokens.clear()`、in-flight abort —— **每条路由一把 token，路由注销即吊销**。
- token 的唯一投递方式是**注入 WorkBuddy 自己拉起的 MCP 子进程环境变量**（形如 `WORKBUDDY_GMAIL_CREDENTIAL_AUTHORIZATION`、`WORKBUDDY_MCP_CONTEXT`、`localRoute.urlEnv`）。**磁盘上没有可复用的固定 token 文件。**

另一个 `McpAppsHost`（offset 3252097 `createMcpAppsHost`、offset 3262250 `startWorkbuddyAppServerMcpAppsHost`）同样 `listenOnLoopback` 随机端口，供 MCP Apps / sandbox 预览用，也无对外业务路由。

**结论：LocalMcpHost 是「WorkBuddy 作为 MCP client 去连本机 MCP server 进程」的宿主，鉴权方向是 WorkBuddy→子进程单向下发。外部进程拿不到 token，无法反用来给 WorkBuddy 发消息。属「需逆向-不做」。**

### 1.3 命名管道 WBIPC —— ticket 可读，但协议是私有的

daemon.log 实测监听：

```
[WBIPC] listening on \\.\pipe\wbipc-95df69d40d14622f
[PacRpc] listening on \\.\pipe\workbuddy-pac-13292-d61ea9f38fff5a03
[sidecar-stderr] [Sidecar] Control socket listening on \\.\pipe\workbuddy-db3c94e56ec2-sidecar-control-314aaeee
[sidecar-stderr] [Sidecar] Data socket for <uuid> at \\.\pipe\workbuddy-db3c94e56ec2-sidecar-data-<uuid>
```

`C:\Users\Administrator\.workbuddy\wbipc\endpoint.json` 内容（**明文，本地任意进程可读**）：

```json
{"endpoint":"\\\\.\\pipe\\wbipc-95df69d40d14622f","ticket":"MOTmi0v8wp_DjxyldV3mf-AmSEqJJ5knj0t5t-1q9uc"}
```

但协议层是私有的 framed JSON-RPC（源码在 asar `main/server.js`）：

- 握手 `session_hello` → `session_hello_ack`（`{type, protocol:1, connection_epoch, max_inflight, pipes}`）。要求 `protocol_min`/`protocol_max` 覆盖 `PROTOCOL_VERSION`，`session_id` 必须在 `buckets` 里且 `state==='active' && registryVerified`，否则握手超时 `tx=5e3` 后 destroy。
- 帧上限 `ex=1048576`。
- broker 方法只有三个：`GET_PIPE='broker/GetPipe'`、`LIST_PIPES='broker/ListPipes'`、`CANCEL='$/cancel'`；业务通道要先 `broker/GetPipe` 拿到 pipe 名。
- 错误码全表（asar offset 17427893）：`E_TICKET_INVALID / E_REVOKED / E_ENDPOINT_UNTRUSTED / E_PROTOCOL_MISMATCH / E_PIPE_UNKNOWN / E_METHOD_UNKNOWN / E_METHOD_KIND_MISMATCH / E_NOT_DECLARED / E_CONSENT_REQUIRED / E_NOT_CONNECTED / E_POLICY_DENIED / E_UPSTREAM / E_BUSY / E_CHANNEL_UNKNOWN / E_BAD_REQUEST / E_CANCELLED / E_PAYLOAD_TOO_LARGE / E_TIMEOUT / E_INTERNAL`。
- 另有 entitlement 检查（日志 `[WBIPC][entitlement] conversation=… allowed=…`）与 `registry.listVisible()` pipe 注册表。

`claw` 相关 RPC channel 全清单只有三个，且**全部只读**：

```
clawControl:getSnapshot   (从云端 REST 拉快照)
clawControl:refresh
clawControl:onChange      (订阅)
```

`registerClawControlRuntimeHandlers` 的实现里只有 `e.handle('clawControl:getSnapshot', …)` 和 `e.handle('clawControl:refresh', …)`，`ClawControlService` 用 `createFetchBackedRestOperations$1` 打云端，`computeOwnerKey` 变化时丢弃响应。**没有任何 `sendMessage`/`sendIm` 形态的可调用 channel。**

主进程↔daemon 还有一条 stdio fd3/4 的 `[CatalogStdio]/[StdioConn]` 通道（日志 `[MainBootstrap] [CatalogStdio] invoke via fd3/4 {channel:"wb:experts:list"}`），同样是内部私有。

**结论：ticket 虽然是明文，但要让业务 RPC 跑起来还得逆向握手、bucket 规则与 pipe 注册表，且没有发送类 channel。属「需逆向-不做」。**

### 1.4 EvalProxyServer（18485）—— 生产构建里被编译期关死

源码 `main/eval-inject-server.js`（`main/runtime-http.js`、`main/http.js` 是 146-byte shim）。若启用，它会提供：

```
GET  /ping
GET  /healthz
POST /chat/<sessionId>          body {prompt}
POST /sessions/<id>/inject      body {turns:[{user,assistant,tool_calls?}]}
GET/POST/DELETE /sessions
DELETE /sessions?all=true
常量：preferredPort=18485, portRetries=10, ALLOWED_MODES=[craft,ask,plan],
      BODY_HARD_LIMIT_BYTES=209715200
```

**但它不会启动**：

```js
async function startEvalProxyServer(e){ let{evalModeEnabled:t, daemon:n}=e; if(!t) return; … }
```

而桌面主启动 pipeline 里**每一处都硬编码 `evalModeEnabled:!1`**（`createDatabaseStep({evalModeEnabled:!1,…})`、`initCellJSContainerStep({evalModeEnabled:!1,…})`、`startAppServerBackgroundStep({evalModeEnabled:!1})`、`schedulePostDaemonTasksStep({evalModeEnabled:!1,…})` 等 10+ 处，起点 asar offset 12464137）。

实测：`netstat | grep 18485` 为空；`main.log`/`daemon.log` 中 `EvalProxy` 计数为 0。

唯一的环境变量口子是 `WORKBUDDY_EVAL_HOST`（只改 host，不改开关）；`WORKBUDDY_EVAL_MODE` 之类 grep 0 命中。

**结论：这不是「用户开个开关就能用」，是这个构建里根本没有启动路径。之前把它列为「最接近可用的本地受支持面」的判断要下调为不可用。**

---

## 2. CLI

`D:\ProgramFiles\workbuddy\resources\app.asar.unpacked\cli\` 下：

```
bin/codebuddy           15166 B  #!/usr/bin/env node  —— CodeBuddy Code CLI
bin/codebuddy-lowmem
bin/cbc-prewarm
cli/dist/codebuddy-lite-wb.mjs + cli/dist/lazy-lite-wb/*.mjs
cli/builtin/workflows/deep-research.workflow.js
```

`bin/codebuddy` 的**全部** flag：

```
--a2a --acp --background --bg --help --input-format --output-format
--prewarm --print --serve --startup-prof --version
```

**没有任何微信/推送/消息子命令。**

几点复核：

- `which codebuddy`、`which cbc`、`which workbuddy`、`which wb` **全部 no** —— 没装进 PATH，只能绝对路径调用。
- ACP 侧（asar offset 13889846）：`I='--acp'`、`L='wb-acp:'`、`R='WORKBUDDY_CONVERSATION_ID'`、`buildAcpWorkerArgv0`、env `{ELECTRON_RUN_AS_NODE:'1', CODEBUDDY_DISABLE_IDE:'1', SERVER__PORT:'0', SERVER__HOST:'127.0.0.1'}`。**ACP 是 WorkBuddy 内部拉起 worker 的 stdio 协议，不是对外推送通道。**
- `cli/dist/codebuddy-lite-wb.mjs` 里 `listen(` 出现 22 次，全是 **pty/attach 的命名管道**（`this.server.listen(this.path,…)`、`unlinkSocket`、`protocolVersion:1`、`EBADREQ`/`ENOTREADY`、`onAttacherDisconnect`）—— 是 `codebuddy daemon/attach` 的终端复用通道，不是 HTTP、更不发消息。
- `.workbuddy/cli-env/wecom-cli.sh`（903 B，文件头 `# Generated by WorkBuddy — do not edit.`）是**企业微信 CLI 的 env**：`WECOM_CLI_CONFIG_DIR='C:\Users\Administrator\.workbuddy\connectors\398658c8-…\wecom-cli\personal'`，unset 了 `WECOM_CLI_BASE_URL`/`AUTH_ENDPOINT`/`ADDITIONAL_HEADERS`/`ACCESS_TOKEN`，export 了 `WECOM_CLI_ADDITIONAL_HEADERS_AGENT_TICKET`（活体 `agt1-…` ticket）、`WECOM_CLI_ADDITIONAL_HEADERS_CUSTOMER_USERID`、`WECOM_CLI_ADDITIONAL_HEADERS_ENTERPRISE_TYPE='{"X-WeCom-Enterprise-Type":"3"}'`。**是企微/WeCom 通道，不是 ClawBot 微信通道；且含活体凭据，本报告不贴全值。** 它证明 WorkBuddy 有「按 connector 生成 CLI env」的机制，但**没有对应的 weixin 版本**。

**结论：CLI 这条路不存在。**

---

## 3. MCP

`.workbuddy/connectors/default/mcp.json`（全量）：

```json
{"mcpServers":{
 "connector:tdx-connector":{"url":"https://txmcp.tdx.com.cn:3001/txmcp","type":"streamable-http","timeout":30000,"disabled":true},
 "connector:westock-mcp":{"type":"streamableHttp","url":"https://stockbuddy.qq.com/cgi/cgi-bin/openai/mcp/mcp",…},
 "connector:qq-mail":{"timeout":600000,"url":"https://api.mail.qq.com/mcp","disabled":true},
 "connector:ima-mcp":{"url":"https://ima.qq.com/mcp","type":"streamableHttp","timeout":20000,"disabled":true},
 "connector:lexiang":{"timeout":600000,"url":"https://mcp.lexiang-app.com/mcp","disabled":true},
 "connector:tencent-docs":{"timeout":600000,"url":"https://docs.qq.com/openapi/mcp","disabled":true},
 "connector:tencent-docs-oa":{"timeout":600000,"url":"https://saas.docs.qq.com/api/v6/open/agent/mcp","disabled":true}}}
```

全是**出站** client 配置（WorkBuddy 去连别人的 MCP server），**没有 server 侧监听配置**。settings.json 里 `settings.claw` 也无 MCP server 相关键。`.workbuddy/mcp.json`(199 B) 同为空壳。

`mcp-tool-list.json`（77242 B，8 个 md5 key 的 entries）里的工具全是出站 connector 的能力：`workbuddy_cloudservice_db_*`、`miniprogram_*`、`tdrive.*`、QQ 邮箱 11 个（`SendMessage`/`ReplyMessage`/`ForwardMessage`…）、设计类 26 个、`library_*`、excel 类、`weixinpay_*`、`miora_*`。**没有「给微信 ClawBot 发消息」的工具。**

**结论：WorkBuddy 不能当 MCP server 对外暴露；也没有内置 MCP 工具能发微信。**

---

## 4. WorkBuddy 自己的两条「官方推送」链路（都需要用户在 UI 里配）

这是**真正受支持**的两条路，但入口都是 WorkBuddy 设置页，不是外部 API。

### 4.1 automation → 微信（`push_to_wechat` → 云端代理）

SQLite `C:\Users\Administrator\.workbuddy\workbuddy.db`（462848 B）表 `automations` 有：

```sql
push_to_wechat     INTEGER NOT NULL DEFAULT 0
push_to_wecom_bot  INTEGER NOT NULL DEFAULT 0
```

当前全表**只有一行**：`id=6d9b8e22-2ac4-4607-9f87-673f4ff78d35`、`name=每日工作日报`、`rrule=FREQ=DAILY;BYHOUR=17;BYMINUTE=0`、`model_id=hy3`、`cwds=["D:\\WorkSpace"]`、**`push_to_wechat=0`、`push_to_wecom_bot=0`**。

另有 `automation_delivery_outbox` 表（**0 行**），schema 含 `channel TEXT DEFAULT 'wechatmp'`、`status ∈ {pending,retry_waiting,pending_auth,in_flight,succeeded,skipped,manual_required,abandoned}`、`max_attempts DEFAULT 5`、`dedupe_key`、`lease_owner`。

enqueue 逻辑（`AutomationService`，asar offset ~16338000–16346000）：

```js
if(!this.automationDeliveryWorker || !e.pushToWeChat && !e.pushToWecomBot) return;
$f='wechatmp'; ep='wecom_bot'; np=4000 /*summary 截断*/;
dedupeKey = `automation-delivery:${channel}:${uid||'unknown-user'}:${hostId}:${automationId}:${runId}`;
```

两个 sender（asar offset ~17122703）：

- `wechatmp.send` → `pushAutomationResultToWechatmp(t)`，返回 `{...r, deliveryId: r.notificationId}`
- `wecom_bot.send` → `pushAutomationResultViaAiBot({...})`，返回 `{success, retryable: !success, error}`

**`pushAutomationResultToWechatmp` 并不直连微信**（`ClawService` 方法，asar offset ~16602955），而是打 WorkBuddy 自家云端的代理端点：

```
POST ${endpoint}/v2/backgroundagent/wechatmpProxy/push
headers: resolveApiContext().headers        // 含 Authorization: Bearer <accessToken>
body: {content, title: automationName, msgType:'text', metadata,
       sourceDeviceId: getStableHostId(), ...attachments[]}   // attachments 最多 5 个
重试 2 次，超时 15000 ms，退避 [0, 1000]
成功判据：响应里有 notificationId
```

HTTP 状态分类 `classifyWechatmpPushHttpStatus`：`408→timeout(可重试, ambiguousDelivery)`、`429→rate-limit(可重试)`、`401/403→auth(不可重试)`、`400/413→bad-request`、`5xx→server-5xx(502/504 ambiguous)`。

前置条件：`if(!this.getWechatmpEnabled()) return {success:false,retryable:false,reason:'disabled'}` —— 需 `settings.json` 的 `.claw.channels.wechatmp.enabled===true`（**当前确实为 true**，`connectionMode:'webhook'`）。

**关键障碍**：`resolveApiContext()`（offset ~16628045）返回 `{endpoint, headers:{'Content-Type':'application/json', ...authenticationManager.buildAuthHeaders(true,true,false)}, userId}`，`buildAuthHeaders` 产出 `X-User-Id` + `Authorization: Bearer <accessToken>` + `X-Enterprise-Id`/`X-Tenant-Id`/`X-Domain`/`X-Department-Info`。**这个 accessToken 不是明文文件**，存在加密的 auth session 里（`file-authentication-storage.js`、`legacy-auth-session-migrator.js`、`createAuthCodec`，`purpose:'workbuddy-auth-session'`、`resourceId:'auth/<basename>'`、adapter=`credential-fields` —— 与 botToken 同一套 `$wbEncrypted` codec，见 §5）。

`getStableHostId()` = `sha256(hostname+'_'+homedir+'_'+platform+'_'+arch).hex.slice(0,32)`；`getStableWorkspaceId()` = `sha256(settingsPath).hex.slice(0,16)`。日志实测 `sessionId=398658c8-8e68-43b6-a8c7-afa0a9322f6f_c654ff80c0e86795430be6bd7b190b13_fa5a6a21a11cc8f0` 即 `${uid}_${hostId}_${workspaceId}`。

**可行性：外部进程无法编程触发（没有 API/IPC/CLI），只能在 WorkBuddy UI 里勾选。而且这是「WorkBuddy 跑完 automation 自己推」，语义上不是「外部进程推」。**

### 4.2 automation → 企微（这条才是有 UI + 一键测试的完整功能）

RPC channel 全清单（asar offset 10407668 附近常量表）：

```
claw:getAutomationWecomWebhookUrl   claw:setAutomationWecomWebhookUrl
claw:testAutomationWecomWebhook     claw:getAutomationWecomPushConfig
claw:setAutomationWecomPushConfig   claw:getWechatmpEnabled / setWechatmpEnabled
claw:getWecomEnabled / setWecomEnabled
claw:weixinQrStart / claw:weixinQrWait
claw:wechatkfGetLink / GetBindStatus / Unbind
claw:registerChannel / unregisterChannel / getChannelStatus
claw:getSavedChannelConfigs / getIOAImOverride / getLatestSession / notifySessionActive
claw:system-notification
```

**除 `claw:testAutomationWecomWebhook` 与 `automation:test` 外，全部是配置/状态语义。** `claw:system-notification` 是前端→主进程的 emit，主进程只 `console.info` 一行（offset 124449201：`case 'claw:system-notification': console.info('[WorkbuddyAdapter] claw:system-notification', t); break;`），不可用作发送入口。

`Store` 层（offset 16473021）：

- `getAutomationWecomWebhookUrl()` 读 `settings.json` 的 `automation.wecomWebhookUrl`
- `getAutomationWecomPushConfig()` 先读 `automation.wecomPushConfig`，否则回落 `{mode:'webhook', webhookUrl: automation.wecomWebhookUrl}`
- `setAutomationWecomPushConfig(e)`：`e.mode==='webhook' && e.webhookUrl` 时同步写 `automation.wecomWebhookUrl`
- 另有 `automation.wecomPushChatId`

**这些键是明文 JSON 字符串，不走 `$wbEncrypted`**（与 claw 用户态通道凭据不同）。但当前 `settings.json` 里**根本没有 `automation` 顶层键** → 用户尚未配置。

`claw:testAutomationWecomWebhook` handler（offset 18299108）就是发一条固定文案：

```js
pushAutomationResultViaAiBot({
  automationId:'test', automationName:'Test Notification', success:true,
  summary:'🎉 This is a test notification from WorkBuddy. If you see this message, the push is configured correctly!'})
```

`pushAutomationResultViaAiBot(e)`（offset 16615465）的完整前置链：

1. `ensureAutomationPushBotConnected()` 拿不到 client 时按 `reason` 分三支：
   - `'conflict'` → 改走 `pushAutomationResultViaAssistantBot(e)`
   - `'transient'` → `{success:false, error:'Automation push bot temporarily unavailable (connect failed); will retry'}`
   - 否则 → `{success:false, error:'Automation push bot not configured or credentials invalid', preconditionMissing:true}`
2. 有 client 但 `this.automationPushChatId` 为空 → **`{success:false, error:'No automation push chatId available. Please send a message to the automation bot first.', preconditionMissing:true}`**
3. 否则 `sendReply(chatId, content)`；artifacts 逐个 `uploadMedia` + `sendMediaMessage`（>20 MB 或文件不存在则跳过）

冲突保护：`if(e.mode==='websocket' && e.botId && this.getAssistantWecomBotId()===e.botId)` → `{success:false, error:'WeCom bot already in use by assistant channel', errorCode:'WECOM_BOT_ID_CONFLICT'}`（前端 toast key `settings.claw.automationSameBotAsAssistant`，asar offset 21588463）。

**注意第 2 条：企微 AI Bot 通道和微信 ClawBot 一样，也是「必须先有人给它发过消息拿到 chatId」才能推。** 这在本机同样未满足。

### 4.3 deep-link 不是发送口

`DeepLinkRouter.handleUrlAsync`（offset 10804229）分支：OAuth return → MCP OAuth callback → `wechat-chat-history`（导入聊天记录文件成 chip）→ market detail → 其余 `handleOpenUrl` 给 renderer。实际形态（全 asar 12 处）：`workbuddy://chat/<sessionId>?…`、`workbuddy://home`、`workbuddy://automation/run?v=1&automationId=&recordId=[&fileName&localPath&url&objectKey&mimeType&source&size]`、`workbuddy://agentmail`、`workbuddy://agentmail/admin`。**无 `workbuddy://send`。**

---

## 5. 凭据复用：`botToken` 的加密 envelope（只定位，不解密）

### 5.1 形态

`settings.json` → `.claw.users.398658c8-8e68-43b6-a8c7-afa0a9322f6f.channels.weixinClawBot`：

```jsonc
{
  "enabled": true,
  "baseUrl": "https://ilinkai.weixin.qq.com",
  "accountId": "16c32a368fa9@im.bot",
  "userId": "o9cq80…@im.wechat",
  "connectionMode": "polling",
  "channelId": {"$wbEncrypted":1, "envelope":"<b64> 146 B"},
  "botToken":  {"$wbEncrypted":1, "envelope":"<b64> 198 B"}
}
```

envelope base64 解码后是：

```json
{"suite":1,"keyId":"9127dea1b44020a7","nonce":"<12B b64>","authTag":"<16B b64>","ciphertext":"<b64>"}
```

`AtRestCrypto` 常量（asar）：framing 魔数 `{file:'WBEF1', field:'WBEV1', record:'WBER1', stream:'WBES1'}`，AAD 前缀 `{file:'WBEA1\n', field:'WBEV1'}`，suite 集合 `{1}`，envelope 字段集 `['authTag','ciphertext','keyId','nonce','suite']`，密钥长度 32，keyblob 上限 65536。→ **AES-256-GCM + 私有 framing。**

### 5.2 密钥链（第 3 层断了）

```
botToken 密文
  └─ 用 keyId=9127dea1b44020a7 的 master key 解（keyblob 里那把）
       └─ .workbuddy/keyblob  {"version":1,"keyId":"979df773a685f3cf",
                               "slots":[{"type":"static-v1","protectorKeyId":"9127dea1b44020a7","wrapped":"<216B b64>"}]}
            └─ 用 protectorKey(9127dea1b44020a7) 走 AtRestCrypto.open(…,{framing:'file'}) 解出 32 B
                 └─ 校验 sha256(key).hex.slice(0,16) === keyblob.keyId
                      └─ protectorKey 的来源：**未定位**
```

`loadOrCreateKeyblobMasterKey({keyblobPath, protectorKey, createIfMissing})` → `parseKeyblob` → `unwrapKeyblob` → 对每个 `type==='static-v1'` 槽执行 `unwrapStaticV1Slot(slot, keyId, protectorKey)`：校验 `slot.protectorKeyId === protectorKey.keyId`，`new AtRestCrypto(protectorKey).open(parseSupportedEnvelope(b64), {framing:'file'})`，再 `deriveAtRestKeyId(key)=sha256(key).digest('hex').slice(0,16)` 比对。

**protectorKey 的根找不到的证据（都做了，全空）：**

- `main/credential-protection.js`（50579 B，已解出）里 grep `safeStorage`/`DPAPI`/`master.key`/`keychain` → **0 命中**
- 全 asar grep `device-protector`/`DeviceProtector`/`createProtector`/`machine-secret`/`deviceSecret` → **0 命中**
- `protectorKeyId` 全 asar 仅 3 处，**全部在 keyblob 序列化/反序列化**（offset 9335391 / 9335580 / 9335607）
- `safeStorage` 全 asar 仅 2 处，都是 legacy auth 解密（`createElectronHostAuth().decryptLegacyAuthSession` 用 `electron.safeStorage.decryptString`），与 field codec 不是同一条路径
- `MachineGuid` 全 asar 仅 4 处，都在 `winUuid()` / `getMachineId$2()`（遥测 `CLIENT_INFO_MACHINE_ID`）；`deriveAtRestKeyId` 对 key 只做 sha256，**无 KDF 参数** → 「MachineGuid 派生出 protectorKey」这个假设**没有代码证据**，不能当结论
- `.workbuddy/` 目录全清单里**只有 `keyblob`(336 B) 一个密钥文件**，没有第二个

另有 `WORKBUDDY_AT_REST_ENCRYPTION` 环境变量控制策略（`credential-protection-bootstrap.js`：`readWorkbuddyCredentialProtectionPolicy(env)`，非法值回落 `'off'`）；daemon 侧通过 `DaemonCredentialProtectionBootstrapGate`（channel `daemon:credential-protection-bootstrap`，默认 5 s 超时）从主进程接收 `encodeAtRestEncryptionBootstrap({version:1, policy, symmetricKey:{keyId,keyBase64}|symmetricUnavailable,…})`，`decodeKey` 校验 `keyId === deriveAtRestKeyId(key)`。

### 5.3 顺带澄清：`.master.key` 不是这把钥匙

`connectors/398658c8-…/.master.key`（32 B 裸密钥，与 `app/connector-keys/03855dd4c07fa3ee0b8f199f1f7c8381.key` 前 32 B 相同，xxd 均为 `5da6737b69c7a7d4 41927f0796563b3f a2e4fb5b8660cf34 a626a312be6e3618`，`README-DO-NOT-DELETE.txt` 写明「.master.key 本地加密密钥（误删将导致所有连接器需要重新授权）」）属于**另一套 connector 凭据体系**（`.credentials.v3.json` 里 `{"encryption":{"scheme":"aes-256-gcm","kdf":"hkdf-sha256","salt":…}}`）。**与 claw 字段的 keyblob/static-v1 体系无关，不能拿来解 botToken。**

### 5.4 评级

**「需逆向-不做」。** 需要定位一个 WorkBuddy 刻意不落盘的 protectorKey 根（很可能是安装期生成后藏进某处或由机器绑定派生），属于逆向私有凭据。按调研纪律，**不实现、不尝试**。

---

## 6. 兜底方案：确切的调用形状

> ⚠ 本机出网被断（`curl https://www.baidu.com` → `000`，`nslookup sctapi.ftqq.com` → `DNS request timed out`），无法 curl 实测任何外部端点。以下凡标 `⚠ 未核实` 的，是「官方文档没取到正文」的项。

### 6.1 PushPlus —— 微信 ClawBot 通道（**推荐**）

文档已取到完整正文：`https://www.pushplus.plus/doc/guide/api.html`、`https://www.pushplus.plus/doc/channel/clawbot.html`（均 HTTP 200）。

**为什么它最贴合需求**：pushplus 基于微信 ClawBot 协议做了对接，实现**主动推送文字消息** —— 正好把「iLink botToken + context_token」这件要逆向的事，变成了合规 SaaS。

微信官方限制（文档原文四条）：

1. 初始化需主动扫码绑定，**一个微信号只能绑定一个 ClawBot**
2. 绑定后**需要主动发起一次对话**才能下发消息
3. **每下发 10 次消息后，需要主动发起一次对话**
4. **每隔 24 小时，也需要有一次主动对话**

接入流程：pushplus 个人中心 → 渠道配置 → 「微信ClawBot」→ 立即绑定 → 微信扫码 → 绑定成功后主动给该 ClawBot 发一条消息 → 点「我已发送」→ 状态变「已激活」。

调用形状（文档给的推荐形态）：

```http
POST http://www.pushplus.plus/send/{token}
Content-Type: application/json

{"token":"<token>","title":"...","content":"...","channel":"clawbot","template":"txt"}
```

（`template` 建议 `txt`，因为富文本模板只展示前 50 字。）

通用发送接口 `POST http://www.pushplus.plus/send`（生产可 https）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `token` | ✅ | 用户 token |
| `content` | ✅ | 正文 |
| `title` | | 标题 |
| `template` | | `html`(默认)/`txt`/`json`/`markdown`/`cloudMonitor`/`jenkins`/`route`/`pay`/`form`/`doc`/`excel` |
| `channel` | | `wechat`(默认)/**`clawbot`**/`cmcc`(仅中国移动)/`webhook`/`cp`(企微应用)/`qq`/`mail`/`app`/`extension`/`sms`(10 积分/条)/`voice`(30 积分/条) |
| `topic`/`to`/`option`/`callbackUrl`/`timestamp`/`pre`/`pushId` | | 可选；`timestamp` 为毫秒，服务器时间大于此值则不发送 |

**响应是异步的**：

```json
{"code":200,"msg":"请求成功","data":"<流水号>"}
```

`code:200` **只代表服务端收到请求，不代表送达**。确认送达要么用流水号查结果，要么配 `callbackUrl`（回调 body：`{"event":"message_complate","messageInfo":{"message":…,"shortCode":…,"sendStatus":0|1|2|3}}`，0=未发送 1=发送中 2=成功 3=失败）。

批量：`POST http://www.pushplus.plus/batchSend`，`channel` 逗号分隔多值，`option` 一一对应。

**限制**：每 10 条 / 24h 需要有人手动发一条消息（否则微信侧封推送）。对「一天几次 MR 通知」的流水线完全够用，但必须把这条写进运维说明。

### 6.2 企业微信群机器人 webhook（**备选，最稳**）

`⚠ 未核实`：`https://developer.work.weixin.qq.com/document/path/91770` 返回 HTTP 200 但正文只有标题「消息推送配置说明」，内容被截断，未取到字段原文。以下按公开常识给出，**落地前请用户用真实 key 打一次**：

```http
POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<KEY>
Content-Type: application/json
```

text：

```json
{"msgtype":"text","text":{"content":"...","mentioned_list":["@all"]}}
```

markdown：

```json
{"msgtype":"markdown","markdown":{"content":"**标题**\n> 内容"}}
```

成功判据：`{"errcode":0,"errmsg":"ok"}`。长度上限：text 2048 字节、markdown 4096 字节（按公开资料）。

**注意**：这是**企业微信群**，不是用户个人微信。但它是本次调研里**唯一「WorkBuddy 官方 UI 也认」的形态**——WorkBuddy 设置页的「自动化推送」正是填这个 URL（见 §4.2），可以两边共用同一个 key。

### 6.3 Server酱 Turbo（**备选**）

`⚠ 未核实`：`https://sct.ftqq.com/`、`/sendkey/`、`/forward/` 均 HTTP 200 但正文只有标题（纯 SPA，web_fetch 取不到细节）；`doc.sct.ftqq.com` DNS 不存在。以下按公开常识给出：

```http
POST https://sctapi.ftqq.com/<SENDKEY>.send
Content-Type: application/x-www-form-urlencoded   (也接受 JSON)

title=<标题>&desp=<Markdown 正文>
```

返回 `{"code":0,"message":"","data":{"pushid":…,"readkey":…,"error":"SUCCESS","errno":0}}`；`code!==0` 为失败。正文 `desp` 支持 Markdown，上限 32 KB。

**落地前必须实测**：用用户真实 SENDKEY 打一次，确认字段名与返回码。

---

## 7. 协议层兜底：iLink bot 协议

源码：`main/weixin.js`（35417 B，已解出到 `.scratch/_reference/_tmp/wb/weixin.js`）。

### 7.1 端点与头

```
base:  https://ilinkai.weixin.qq.com        (常量 u)
       url(p) = `${apiBaseUrl.replace(/\/$/,'')}/ilink/bot/${p}`

headers: {
  'Content-Type': 'application/json',
  'AuthorizationType': 'ilink_bot_token',
  'Content-Length': …,
  'X-WECHAT-UIN': randomWechatUin(),        // randomBytes(4).readUInt32BE → base64
  'Authorization': 'Bearer ' + botToken
}
base_info: { channel_version: 'workbuddy-desktop-1.0.0' }   // 每个 POST 自动附加
```

### 7.2 方法

| 方法 | 路径 | 超时 | 说明 |
|---|---|---|---|
| `getUpdates(get_updates_buf, timeout?, signal?)` | `ilink/bot/getupdates` | 35 s (+10 s) | 长轮询；`AbortError` 时返回 `{ret:0,msgs:[],get_updates_buf}` |
| `sendMessage(e)` | `ilink/bot/sendmessage` | 15 s | 成功后**不返回 body**；`if(t.ret && t.ret!==0) throw Error(\`Weixin sendmessage failed: ret=${t.ret}, errmsg=${t.errmsg\|\|'unknown'}\`)` |
| `getConfig(ilink_user_id, context_token)` | `ilink/bot/getconfig` | 10 s | 返回 `typing_ticket` |
| `sendTyping(e)` | `ilink/bot/sendtyping` | 10 s | 打字状态 |

二维码登录：`GET {base}/ilink/bot/get_bot_qrcode?bot_type=3`；`GET {base}/ilink/bot/get_qrcode_status?qrcode=…`（header `{'iLink-App-ClientVersion':'1'}`），`status ∈ {wait, scaned, expired, confirmed}`；confirmed 返回 `{apiBaseUrl: n.baseurl||base, botToken: n.bot_token, accountId: n.ilink_bot_id, userId: n.ilink_user_id}`。`waitForWeixinQrLogin(qrcode, base, timeout=480000)`。

### 7.3 发送实体（关键：**必须带 `context_token`**）

```json
{"msg":{
  "from_user_id":"",
  "to_user_id":"<userId>",
  "client_id":"workbuddy-<Date.now()>-<rand6>",
  "message_type":2,
  "message_state":2,
  "context_token":"<contextToken>",
  "item_list":[{"type":1,"text_item":{"text":"<text>"}}]
},
 "base_info":{"channel_version":"workbuddy-desktop-1.0.0"}}
```

`type` 枚举：`{TEXT:1, IMAGE:2, VOICE:3, FILE:4, VIDEO:5}`。

`WeixinClawBotClient` 的发送入口只有两个，**签名里 `contextToken` 都是必填参数**：

```ts
sendTextReply({userId, contextToken}, text): Promise<boolean>
sendReply(userId, contextToken, text, files?, opts?): Promise<boolean>
   // 内部：cleanMarkdown → 切 3800 字符块（块间 300 ms）→ 逐块 sendTextReply → 再发图片/文件
   // 过滤落在 <tmpdir>/workbuddy-weixin-media/inbound 下的回声文件
sendMediaReply(...)  // 缺 contextToken 直接 logger.error('Cannot send media reply: no contextToken') → false
```

**`contextToken` 的唯一来源**：`handleMessage(e)` 里从 inbound 消息的 `e.context_token` 取，按 `from_user_id` 存进 `typingContextTokens`；`replyContext` 由 `gateway.convertInbound` 组装成 `{channelType:'weixinClawBot', userId, contextToken, sessionId, messageId}`。

**→ 没有 inbound 消息 ⇒ 没有 context_token ⇒ 无法主动推送。这是协议语义，不是实现选择。**

### 7.4 三个致命障碍（都在本机实测过）

1. **本机从来没有过 inbound。** `logs\2026-11-02\workbuddyMainThread__22be230a230dcc2f1d23d3d261812acb.log`：

   ```
   WeixinClawBotClient] pollLoop getUpdates returned {"iteration":4640,"elapsedMs":18087,"hasBuf":true,"msgs":0
   …4611…4644 全是 "msgs":0   （每轮约 18 s）
   ```

   全 `logs/` 目录里 `Received polled messages`、`Accepted inbound message`、`Sending text reply`、`hasContextToken` **全部 0 命中**。**即 context_token 从未产生过。**

2. **抢游标。** 游标持久化在 `C:\Users\Administrator\.workbuddy\claw-state\weixin\16c32a368fa9_im.bot.cursor.json`：

   ```json
   {"get_updates_buf":"ChAIARDy7vS+kzQYye70vpM0EjoxNmMzMmEzNjhmYTlAaW0uYm90OjA2MDAwMDA2NDM0NzlmNzkxYWM2YjNkMmY3MDFmNzFlNjEwZGEw"}
   ```

   `connect()` 会先 `loadPersistedCursor(accountId)` 再 `pollLoop()`。**若外部进程用同一 bot 身份也跑 `getupdates`，两个 consumer 会互相把 `get_updates_buf` 推走**，造成消息丢失或重复 —— 而且必然先打断用户正在用的 WorkBuddy。

3. **凭据解不开**（§5）。且重新扫码绑定也不行：微信侧限制「一个微信号只能绑定一个 ClawBot」。

### 7.5 错误语义（写进适配器时要映射）

| 现象 | 处理 |
|---|---|
| `ret!==0` 或 `errcode!==0` | `backoffDelay()`：`min(1000*2^n, 60000) + random*1000` |
| `errcode === -14` | `Session expired` → 停轮询，`status='error'` |
| 健康时 | 透传响应里的 `longpolling_timeout_ms` |

**评级：「需逆向-不做」。即使拿下 botToken 也不可行（缺 context_token + 抢游标 + 违反单绑定限制）。**

---

## 8. 推荐通路

### 8.1 主推荐：PushPlus `channel=clawbot`

- **评级：需用户提供凭据**（一次扫码 + 一个 token）
- 理由：唯一「主动推到用户**微信**、不逆向、有官方协议对接」的通路；Semantics 与用户诉求（「微信助理」那条 ClawBot 通道）完全一致
- 代价：每 10 条 / 24 h 需要用户手动发一条消息激活窗口 —— 必须写进运维说明，并在适配器里把 `quota` 错误码单独暴露

### 8.2 备选 A：企业微信群机器人 webhook

- **评级：需用户提供凭据**（一个 key）
- 理由：最稳、最简单、无需激活窗口；且 WorkBuddy 官方「自动化推送」UI 认同一个 URL，两边可共用
- 代价：进的是企微群，不是个人微信

### 8.3 备选 B：Server酱 Turbo

- **评级：需用户提供凭据**（一个 SENDKEY）
- 代价：字段未核实；免费版有配额

### 8.4 明确不推荐

- 走 WorkBuddy 自有通道：入口只在 UI，外部进程无法触发；即使触发也只能到公众号/企微通道；且企微 AI Bot 同样需要「先有人发消息拿 chatId」（本机未满足）
- 解 `botToken` 直连 iLink：需逆向 + 仍不可行（§7.4）
- 写 `workbuddy.db` 的 `push_to_wechat=1` 来「偷偷开开关」：属于修改 WorkBuddy 数据、破坏 Drizzle 迁移与 outbox 语义，**不做**

---

## 9. 适配器接口形状（供插件替换）

```ts
// ---- 统一消息模型 ----
export type PushSeverity = 'info' | 'success' | 'warn' | 'error';

export interface PushMessage {
  /** 短标题，<= 64 字符。企微 text 通道会拼成 "title\n\nbody" */
  title: string;
  /** Markdown 正文。适配器负责按各自限制截断 */
  body: string;
  /** 只影响前缀 emoji / 颜色，缺省 'info' */
  severity?: PushSeverity;
  /** 可选跳转链接（MR URL / deep link）。不支持 url 的通道拼进 body 末尾 */
  url?: string;
  /** 可选，通道可忽略 */
  tags?: string[];
  /** 幂等键。适配器可做短期去重（pushplus 用 pushId，企微无对应字段则忽略） */
  dedupeKey?: string;
  /** 缺省 15000 ms */
  timeoutMs?: number;
}

// ---- 统一结果 ----
export type PushErrorCode =
  | 'not-configured'   // 缺 token/key —— 配置问题，不要重试、不要告警轰炸
  | 'auth'             // 凭据失效/被撤销 —— 不要重试，需要人重新绑定
  | 'quota'            // 配额/激活窗口用完（pushplus 每 10 条需对话）—— 不要重试，提示人发一条
  | 'rate-limit'       // 限流 —— 可重试（指数退避）
  | 'bad-request'      // 请求体不合法 —— 不要重试，是 bug
  | 'timeout'          // 超时 —— 可重试，但可能已送达（ambiguousDelivery）
  | 'server-5xx'       // 对端 5xx —— 可重试（502/504 视为 ambiguous）
  | 'network'          // DNS/连接失败 —— 可重试
  | 'unknown';

export interface PushError {
  code: PushErrorCode;
  message: string;
  /** false ⇒ 上层不要重试，直接降级/告警 */
  retryable: boolean;
  /** true ⇒ 请求可能已经送达，重试前必须用 dedupeKey 幂等 */
  ambiguousDelivery?: boolean;
}

export interface PushResult {
  ok: boolean;
  /** 'pushplus-clawbot' | 'wecom-webhook' | 'serverchan' | 'ilink' */
  provider: string;
  /** provider 侧 id：pushplus 流水号 / 企微 errmsg 无 id / ilink 无 */
  messageId?: string;
  /** true=确认送达；false=已受理未确认（pushplus 同步响应就是这种）；undefined=未知 */
  delivered?: boolean;
  error?: PushError;
  /** 脱敏后的原始响应，便于排障（不得含 token） */
  raw?: unknown;
}

// ---- 适配器 ----
export interface PushAdapter {
  readonly name: string;
  readonly capabilities: {
    markdown: boolean;
    title: boolean;
    url: boolean;
    media: false;              // 本期不做
    deliveryReceipt: boolean;  // false ⇒ 只能给 delivered:false
  };
  /** 缺配置时构造期就抛 not-configured，不要等到 send */
  send(msg: PushMessage, signal?: AbortSignal): Promise<PushResult>;
}

// ---- 工厂 ----
export type PushConfig =
  | { kind: 'pushplus-clawbot'; token: string; topic?: string }
  | { kind: 'wecom-webhook';    key: string }
  | { kind: 'serverchan';       sendKey: string }
  | { kind: 'none' };

export function createPushAdapter(cfg: PushConfig): PushAdapter;  // kind:'none' ⇒ 返回 no-op 适配器，send 立即返回 {ok:true, provider:'none', delivered:true}
```

### 9.1 各适配器的字段映射

| `PushMessage` | pushplus-clawbot | wecom-webhook | serverchan |
|---|---|---|---|
| `title` | `title` | 拼进 `text.content` 首行 | `title` |
| `body` | `content`（`template:'txt'`） | `text.content` 或 `markdown.content` | `desp` |
| `severity` | 标题前缀 emoji | 同左 | 同左 |
| `url` | 追加 `\n\n${url}` 到 `content` | 同左 | 同左 |
| `dedupeKey` | `pushId`（可选） | 忽略 | 忽略 |
| `timeoutMs` | fetch timeout | 同左 | 同左 |

### 9.2 HTTP 状态 → `PushErrorCode` 映射（与 WorkBuddy 自己的 `classifyWechatmpPushHttpStatus` 对齐）

| HTTP / 现象 | code | retryable | ambiguousDelivery |
|---|---|---|---|
| 408 | `timeout` | ✅ | ✅ |
| 429 | `rate-limit` | ✅ | ❌ |
| 401 / 403 | `auth` | ❌ | ❌ |
| 400 / 413 | `bad-request` | ❌ | ❌ |
| 5xx（非 502/504） | `server-5xx` | ✅ | ❌ |
| 502 / 504 | `server-5xx` | ✅ | ✅ |
| DNS/ECONNREFUSED | `network` | ✅ | ❌ |
| fetch abort（调用方取消） | `timeout` | ❌ | ✅ |
| pushplus `code!==200` | 按 `code`：`903`→`quota`、`900`→`auth`、其余→`bad-request`（`⚠ 具体码值未核实，先按 msg 文本兜底） | | |

### 9.3 语义约定（重要）

1. `send` **只在「已受理」时返回 `ok:true`**；是否真送达由 `delivered` 表达。pushplus 同步响应永远是 `delivered:false`。
2. `not-configured` / `quota` / `auth` **三类不重试**，应当直接降级为「写本地日志 + 在流水线输出里提示人」。
3. `ambiguousDelivery:true` 时上层若重试，**必须**带同一 `dedupeKey`。
4. 适配器 **不得** 在日志里打印 token/key；`raw` 必须脱敏。

---

## 10. 需要人提供什么

| 通路 | 需要人做的事 | 代号 |
|---|---|---|
| **PushPlus ClawBot（推荐）** | ① 注册 pushplus 拿 `token`；② 个人中心→渠道配置→微信ClawBot→立即绑定→微信扫码；③ 扫码后**主动给该 ClawBot 发一条消息**，回页面点「我已发送」，状态变「已激活」；④ 把 `token` 给插件 | `PUSHPLUS_TOKEN` |
| 企微群机器人（备选） | 在目标企微群 → 群设置 → 群机器人 → 添加 → 复制 webhook URL（形如 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx`） | `WECOM_WEBHOOK_URL` |
| Server酱（备选） | 登录 `sct.ftqq.com` → 获取 SendKey | `SERVERCHAN_SENDKEY` |
| 若坚持走 WorkBuddy 自有通道 | 在 WorkBuddy 设置页手动勾选 automation 的「推送到微信」/「推送到企微」；**外部进程无法代劳** | — |

**不需要人提供**（也拿不到）：WorkBuddy 的 `botToken` 明文、登录态 `accessToken`。

---

## 附录 A：证据索引

| 结论 | 证据位置 |
|---|---|
| 版本 5.9.2 / PID 7228 | `main.log` `[MainMemWatch] pid=7228 ver=5.9.2`；probe 响应 |
| LocalProbeServer 唯一路由 | asar `main/nunjucks.js`（条目 offset 11644248），全局 offset ≈11680352；`.scratch/_reference/_tmp/probe_region.txt` |
| daemon 三端口 | `netstat -ano`：PID 13292 → 54423 / 58155 / 61990 |
| LocalMcpHost 源码 | asar 全局 offset 15972647 |
| McpAppsHost | asar offset 3252097 / 3262250 |
| WBIPC 协议 | asar `main/server.js`；`.workbuddy/wbipc/endpoint.json`；`daemon.log` |
| EvalProxy 编译期关闭 | asar offset 11920981（源码）、12464137+（10+ 处 `evalModeEnabled:!1`） |
| CLI flag 集 | `resources/app.asar.unpacked/cli/bin/codebuddy` |
| mcp.json 全出站 | `.workbuddy/connectors/default/mcp.json` |
| automation 表 schema | `workbuddy.db` 表 `automations` / `automation_delivery_outbox`（副本 `.scratch/_reference/_tmp/wb-copy.db`） |
| `wechatmpProxy/push` | asar offset ≈16602955（`ClawService.pushAutomationResultToWechatmp`） |
| `resolveApiContext` / auth headers | asar offset ≈16628045、4194779、6028266 |
| `pushAutomationResultViaAiBot` | asar offset 16615465 |
| claw channel 全清单 | asar offset 10407668 |
| `Store` automation 键 | asar offset 16473021 |
| `claw:testAutomationWecomWebhook` handler | asar offset 18299108 |
| deep-link 分支 | asar offset 10804229 / 10817991 |
| `claw:system-notification` 只打日志 | asar offset 124449201、21593923 |
| `clawControl` 只读 | asar offset ≈10406000 |
| weixin.js 全链路 | `.scratch/_reference/_tmp/wb/weixin.js`（35417 B，源自 asar `main/weixin.js`） |
| context_token 来源 | 同上 `handleMessage` / `typingContextTokens` |
| 从未收到消息 | `logs\2026-11-02\workbuddyMainThread__22be230a230dcc2f1d23d3d261812acb.log`，`getUpdates … "msgs":0` × iteration 4611–4644 |
| 游标文件 | `.workbuddy\claw-state\weixin\16c32a368fa9_im.bot.cursor.json` |
| envelope 结构 | `settings.json` → `botToken.envelope` base64 解码（未解密） |
| keyblob | `.workbuddy\keyblob`（336 B） |
| 密钥根缺失 | 全 asar grep `device-protector`/`DeviceProtector`/`createProtector`/`machine-secret`/`deviceSecret` = 0；`protectorKeyId` 仅 3 处（offset 9335391/9335580/9335607） |
| connector 密钥是另一套 | `connectors/398658c8-…/.credentials.v3.json`（`hkdf-sha256`）+ `.master.key` |
| pushplus 文档 | `https://www.pushplus.plus/doc/guide/api.html`、`/doc/channel/clawbot.html`（HTTP 200，已取全文） |
| Server酱 / 企微 webhook 文档 | 均 HTTP 200 但正文被截断/SPA → ⚠ 未核实 |

## 附录 B：复现命令（只读）

```bash
# 端口
netstat -ano | grep LISTEN | grep 127.0.0.1

# 探针
curl -s -i http://127.0.0.1:18488/workbuddy/probe

# MCP host
curl -s -i http://127.0.0.1:54423/healthz
curl -s -i -X POST http://127.0.0.1:54423/mcp -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# 是否收到过微信消息（应为 0）
grep -rc "Received polled messages" /c/Users/Administrator/.workbuddy/logs/ 2>/dev/null

# 解 asar 单条目
node .scratch/_reference/asar-tool.mjs /d/ProgramFiles/workbuddy/resources/app.asar \
     extract main/weixin.js /tmp/weixin.js
```

## 附录 C：未核实 / 遗留

1. Server酱 Turbo 的字段名与返回码 —— 文档站是 SPA，取不到正文，**必须用真实 SENDKEY 实测一次**。
2. 企微群机器人 webhook 的字段与长度限制 —— 官方文档页被截断，**同上**。
3. pushplus 的 `code` 具体错误码表（903/900 等）—— 文档只给了 `200` 成功语义，失败码未取到。
4. WorkBuddy 的 `protectorKey` 根 —— 未定位，且按纪律不做进一步尝试。
5. `main/wecom-new.js`、`main/wecomaibot*.js`、`main/wechatkf.js` 未逐行复核（已有结论足够：全部是「先有 inbound 才有 replyContext」的被动回复模型）。
6. `wechatmp` 通道（`.claw.channels.wechatmp.connectionMode='webhook'`）走的是 `WechatmpOutboundAdapter`，同样要求 `replyContext.webhookUrl` + `userId`，`if(!t) return {success:false,error:'Missing webhookUrl in replyContext'}` —— 无 inbound 不可用。
