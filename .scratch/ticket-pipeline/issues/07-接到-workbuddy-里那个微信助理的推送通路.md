<!-- DSH-FORMAT: md-v1 -->
<!-- DSH-PARENT: 00 -->
<!-- DSH-LABELS: wayfinder:research -->
<!-- DSH-IDEMPOTENCY-KEY: deck-plan-ticket-pipeline-v1-child-wechat-push -->
<!-- DSH-CREATED: 2026-11-03T11:02:09.042Z -->
# 07: 接到 WorkBuddy 里那个微信助理的推送通路

Type: research

Status: resolved
## Question

WorkBuddy 的微信助理跑在 ClawBot / iLink 通道上（`~/.workbuddy/settings.json` 里 `weixinClawBot` 通道已启用、polling 模式，`botToken` 是 AES-256-GCM 加密存的）。有没有**受支持的、非逆向**的方式让外部进程给它发消息——WorkBuddy 的本地 HTTP 接口、CLI、MCP server、或可复用的 bot token？如果都要解密私有凭据或逆向，就明确说清边界，并给出 Server酱 / PushPlus 兜底方案的接入点。

## Comments

### local — 2026-11-03T11:21:48.678Z
## Resolution（research 完成）

报告：`.scratch/ticket-pipeline/research/wechat-push.md`（784 行，48 KB，全部实测，只读探测）。

**结论：WorkBuddy 没有任何「受支持的、供外部进程调用的发消息接口」。**

逐项排除（附证据）：

| # | 通路 | 结果 |
|---|---|---|
| 1 | 主进程本地 HTTP `127.0.0.1:18488`（LocalProbeServer） | 只有一个 `GET /workbuddy/probe` 健康探针，无鉴权也无发消息能力 |
| 2 | daemon `:54423` LocalMcpHost / `:58155` / `:61990` | 每路由一把一次性 token，单向注入给 WorkBuddy 自己拉起的 MCP 子进程，磁盘上无固定 token |
| 3 | 命名管道 `\\.\pipe\wbipc-95df69d40d14622f` | ticket 明文可读，但协议是私有 framed JSON-RPC + `session_hello` + bucket 校验；claw 相关 channel 只有 `clawControl:getSnapshot/refresh/onChange`（全只读） |
| 4 | EvalProxyServer `:18485` | **编译期**关死：`if(!evalModeEnabled) return`，桌面启动里 10+ 处硬编码 `evalModeEnabled:!1` |
| 5 | `codebuddy` CLI | 只有 `--acp/--print/--serve/daemon`，零推送子命令 |
| 6 | 当 MCP server 用 | `mcp.json` 7 条全是**出站** client 配置，无 server 侧 |
| 7 | WorkBuddy 自有微信通道 | **被动回复语义**：`WeixinClawBotClient.sendTextReply({userId,contextToken}, text)` 的 `context_token` 只能从 inbound 消息取 |

**决定性证据**：本机日志 `logs\2026-11-02\workbuddyMainThread__22be230a230dcc2f1d23d3d261812acb.log` 里 `getUpdates … "msgs":0` 连续 iteration 4611–4644（每轮 18s），全 logs 目录 `Received polled messages` / `Sending text reply` / `hasContextToken` **全部 0 命中** —— 这条通道上线至今从未收到过任何消息，`context_token` 从未产生。

**`botToken` 解不开**：AES-256-GCM 的 `$wbEncrypted` envelope（`{suite:1,keyId:"9127dea1b44020a7",nonce,authTag,ciphertext}`），密钥链 `keyblob(static-v1) ← protectorKey(9127dea1b44020a7) ← ?`，根在 asar 里找不到（`device-protector`/`DeviceProtector`/`createProtector`/`machine-secret` 全 0 命中）。**且即使解开也不能用**：主动推送必须 `context_token`，还会跟 WorkBuddy 抢 `get_updates_buf` 游标，微信侧还限制一个微信号只能绑一个 ClawBot。

**推荐通路：PushPlus `channel=clawbot`**（评级：需用户提供凭据）。文档已取全文（`pushplus.plus/doc/channel/clawbot.html`）：pushplus 基于微信 ClawBot 协议做对接，**支持主动推送**。`POST http://www.pushplus.plus/send/{token}`，body `{token,title,content,channel:"clawbot",template:"txt"}`。代价：微信侧限制**每 10 条要人主动发一次对话、每 24h 要一次**。响应异步（`code:200` 只代表受理，送达靠 callbackUrl）。
备选：企微群机器人 webhook（`POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=`，`{"msgtype":"text","text":{"content":...}}`；WorkBuddy 自己的「自动化推送」UI 也是填企微 webhook，两边可共用同一个 key）；Server酱 Turbo（`POST https://sctapi.ftqq.com/<SENDKEY>.send`，`title`+`desp`）。

**报告里给了可直接落地的接口**：`PushAdapter { send(msg: PushMessage, signal?): Promise<PushResult> }`、`PushMessage={title,body,severity?,url?,tags?,dedupeKey?,timeoutMs?}`、`PushResult={ok,provider,messageId?,delivered?,error?,raw?}`、`PushError={code,message,retryable,ambiguousDelivery?}`、错误码 `not-configured|auth|quota|rate-limit|bad-request|timeout|server-5xx|network|unknown`、HTTP 状态→错误码映射表、三档 `PushConfig` 判别联合 + `createPushAdapter()` 工厂（`kind:'none'` 返回 no-op）。

**需要人提供的只有一个**：PushPlus token（注册 → 渠道配置 → 微信ClawBot → 扫码 → 主动给该 ClawBot 发一条消息 → 点「我已发送」→ 状态「已激活」）。

⚠ 未核实：Server酱字段名与返回码、企微 webhook 字段与长度限制（官方文档是 SPA 取不到正文，需真实凭据实测）；pushplus 失败错误码表（903/900 等）未取到。

**对地图的影响**：Notes 里「通知默认走 WorkBuddy 现有的微信助理」这条要改 —— WorkBuddy 那条路走不通，推送适配器的默认实现应改成 PushPlus clawbot channel，WorkBuddy 只保留「人可以在 UI 里手动配企微 webhook」这一条旁路。

## Answer

research 收口：WorkBuddy 无对外推送接口（被动回复语义 + context_token 从未产生 + botToken 密钥根缺失）。推荐改走 PushPlus channel=clawbot，接口形状已在 `.scratch/ticket-pipeline/research/wechat-push.md` 给出。未开 PR（research 票规则）。

## 进度
