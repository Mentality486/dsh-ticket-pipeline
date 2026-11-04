<!-- DSH-FORMAT: md-v1 -->
<!-- DSH-PARENT: 00 -->
<!-- DSH-LABELS: wayfinder:task -->
<!-- DSH-IDEMPOTENCY-KEY: deck-61f949f6-5979027 -->
<!-- DSH-CREATED: 2026-11-03T12:18:35.963Z -->
# 12: 飞书多维表格 TicketSource 真实实现

Type: task

Status: resolved
## Question

实现飞书多维表格的 `TicketSource`（第一个真实适配器），把 `.scratch/ticket-pipeline/research/` 里的调研结论落成代码。

**通用化修正（2026-11-03，用户方向修正后新增）**：适配器必须是**多实例**的——启动时按 `projects[]` 每个条目实例化一次，构造参数 = 该条目的 `match`（显式 appToken/tableId 或 `docNamePattern` 模糊匹配）。本票同时要实现 `docNamePattern` → appToken/tableId 的文档名搜索解析（失败或多张命中 = 配置错误）。#09 的结论是本票的直接前置。

**要交付的**：

1. **认证**：`POST /open-apis/auth/v3/tenant_access_token/internal`（`app_id`/`app_secret`，`expire` 7200s），token 存 `ctx.credentials`，过期前自动刷新。
2. **变更水位**：`POST /open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/search`，`page_size ≤ 500`、20/s，`automatic_fields:true` 拿 `last_modified_time`，按「最后更新时间」降序分页 + 水位比对（`ExactDate` 过滤被截断到**天**，不能用）。
3. **收票筛选**：`是否处理 = 处理中`（下拉三值 `是 / 否 / 处理中`）。是否叠加「处理人为空」等条件由 #01 的结论定。
4. **附件下载**：`GET /open-apis/drive/v1/medias/:file_token/download`（Bearer tenant token，5 QPS / 1 万次/天）或 `batch_get_tmp_download_url`（≤5 tokens，24h 免鉴权）。拿到字节后走 `ctx.attachments.saveImage()`。
5. **截图两种形态**：附件字段直接下载；「共享路径/链接」文本形态按 #01 的结论处理。
6. **只读**：**不实现任何写回**（用户已决定表格只读）。
7. **文档级授权前置**：必须提示人完成「文档所有者 → … → 更多 → 添加文档应用」这一步，否则 API 拿不到数据；脚本化 `POST /drive/v1/permissions/:token/members` 只对 user_access_token 有效，tenant token 无法自举。

**前置已定**：#01 已收口（见 `issues/01-飞书多维表格的变更水位与去重.md` 的 Resolution），第 2、3、5 条直接照它的结论实现，不再是占位：

- 身份 = `record_id`；水位 = 客户端 `seen[recordId].mtime` + 内容指纹比对；停止条件 = 连续 `Config.safePageRun`（默认 20）条已知未变；**不用 `ExactDate`**。
- 收票 = 只要 `是否处理 = 处理中`，不叠加任何条件。**下拉字段返回值形状不固定**（`{text}` / `[{text}]` / 裸字符串），必须先规范化再判等。
- 删除行：连续 `Config.goneAfterScans`（默认 3）轮没出现才标 `gone`。
- 截图：适配器实现 `loadScreenshot(ref, signal)`，把 `attachment{fileToken}` / `path` / `url` / `unknown` 四种 ref 统一取成字节；取不到 → 标 `needs-info` 通知人补图，**不 fail、不阻塞排队**。

**参考**：`issues/01-飞书多维表格的变更水位与去重.md` 的 Resolution（本票的唯一权威依据）。飞书 Bitable 的接口事实（端点、限流、字段形状、文档级授权门）在 #01 的调研过程里已核实，摘要见下：
- `POST /open-apis/auth/v3/tenant_access_token/internal`（`app_id`/`app_secret`，`expire` 7200s）
- `POST /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/search`，`page_size ≤ 500`、20/s
- `GET /open-apis/drive/v1/medias/{file_token}/download`（Bearer tenant token，5 QPS / 1 万次/天）
- `POST /open-apis/drive/v1/files/{file_token}/subscribe?file_type=bitable`（变更事件订阅，仅 owner/manager）
- 限流 429 / `99991400`

## Answer

七项交付全部落地并验证：

1. **认证** —— `POST /open-apis/auth/v3/tenant_access_token/internal`，token 本地缓存、过期前 60s 自动刷新。凭据从 `ctx.credentials` 取（普通字符串 ref `FEISHU_APP_ID` / `FEISHU_APP_SECRET`），组合根注入 `getSecret`。
2. **变更水位** —— `records/search`（`page_size:500` + `automatic_fields:true` + 按「最后更新时间」降序），客户端逐条比 `seen[recordId]` 的 mtime + 内容指纹；停止条件 = 连续 `safePageRun`(20) 条已知未变；不用 ExactDate；服务端拒 sort 时去掉 sort 重试一次。
3. **收票筛选** —— 只认 `是否处理 = 处理中`，不叠加任何条件；下拉字段形状不固定（裸字符串 / `{text}` / `[{text}]`），先 `normalizeCellText` 归一再判等。
4. **附件下载** —— `GET /open-apis/drive/v1/medias/:file_token/download`（Bearer tenant token），拿到字节交内核 `saveImage` → `ImageBlock` → `followup`。
5. **截图两形态** —— `attachment` / `path`（`ctx.fs.readBytes`）/ `url`（裸 fetch，不带凭据）/ `unknown`（抛 invalid-input → 内核标 needs-info，不阻塞排队）。
6. **只读** —— 适配器里没有任何对记录的写操作，自测有一条断言专门盯着（全程只允许 `GET` / `POST /auth` / `POST /records/search`）。
7. **文档级授权前置** —— 已写进架构文档 §12.8 与 README：`POST /drive/v1/permissions/:token/members` 只对 user_access_token 有效，插件用的 tenant_access_token 无法自举，必须表格所有者手动把应用加为协作者。

**通用化修正也做到了**：按 `projects[]` 每个条目实例化一个 source（`src/index.js` 里遍历 projects 造 source，注入 `getWatermark`/`saveWatermark`/`getSecret`/`readLocalFile`/`safePageRun`/`goneAfterScans`）；`docNamePattern` → appToken/tableId 的文档名搜索解析实现了（先在云文档找唯一 bitable，再取其唯一表），**命中 0 张或 >1 张一律当配置错误**，不瞎猜。

**验证**：离线自测 `cd plugins/ticket-pipeline && node scripts/dev-run.mjs` → **54 项全绿 exit 0**（新增第 9 节「飞书适配器（离线打桩，不联网）」，在 `scripts/feishu-checks.mjs`，21 条断言覆盖认证缓存、请求形状、只收处理中、下拉规范化、水位推进、safePageRun 停止、退役与拨回重开、goneAfterScans、截图三形态、绑表 0/1/多张、sort 兜底、错误码分类、凭据缺失、扫描取消、绝无写操作）。

**踩到的坑（已写进架构文档 §12.7 与 README）**：飞书认证接口的响应体**没有 `data` 包装**（`tenant_access_token` 在顶层），`apiCall()` 必须返回整个响应体、业务接口自己取 `payload.data`；写成 `return payload.data` 会让认证永远拿不到 token。

**尚未做（需要人工前置，不是规划缺口）**：真实端到端验证需要 App ID + App Secret，以及至少一张工单表的 app_token/table_id（或能唯一匹配它的 docNamePattern），并由表格所有者完成文档级授权。打桩证明逻辑对，不证明权限通。

## 进度

- 进度：100%（2026-11-04T09:02:48+08:00）：飞书适配器真实实现落地：source-feishu 790 行 + 组合根注入凭据/水位/本地文件读取 + 离线自测第 9 节 21 条断言，全套 54/54 绿；架构文档加 §12.7/§12.8，README 与 map Decisions 同步。
