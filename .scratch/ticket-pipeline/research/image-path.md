# 截图像素到模型上下文的通路

> 回答 `.scratch/ticket-pipeline/issues/02-截图像素到模型上下文的通路.md`。
> 目标读者：写 `dsh-ticket-pipeline` Host 插件的实现者。
> 结论来源：DSH 已发布包（`app.asar` 内 `dsh/node_modules/@deepseek-ai/*`）+ `cordis_inspect_query` 返回的类型声明。
> 行号约定：`包名:行号` 指 asar 内 `dsh/node_modules/@deepseek-ai/<包名>/lib/index.js`。本地已抽出的副本在 `.scratch/_reference/_extract/`，文件名见每节标注。

---

## 0. 一句话结论

一张本地截图要变成模型能读到的像素，只有一条合法通路：

```
读取文件字节 (Uint8Array)
  → ctx.attachments.saveImage({ data, mediaType, name })   得到 ImageAttachmentRef
  → 构造 ImageBlock: { type: 'image', attachment: ref }
  → 塞进一条 UserMessage 的 content 数组
  → agent.followup(msg) / agent.steer(msg) / agent.inject(msg)
```

**没有「给一个本地文件路径，DSH 就会把图放进上下文」的 API。** 路径只在两个地方有用：`ctx.fs.readBytes()` 读字节，以及 `read_image` 这个工具（它内部做的正是上面四步）。provider adapter 在发请求时才把 `ImageAttachmentRef` 解析成真正的 base64/文件上传字节。

---

## 1. 可用的公开 API

### 1.1 `ctx.attachments` — `AttachmentStore` 服务

服务 key：`attachments`。取法两种（`cordis_inspect_query` → host/Service/`{"service":"attachments"}` 原文）：

```ts
// 可选依赖（插件推荐，缺服务时优雅降级）
optional: { expression: 'ctx.get("attachments")', requiresUndefinedCheck: true }
// 硬依赖
hardDependency: { inject: ["attachments"], expression: 'ctx.attachments' }
```

完整方法签名（逐字，来自 inspect 的 `service.methods[].signature`）：

```ts
abstract readonly imageLimits: ImageAttachmentLimits
abstract validateImage(input: SaveImageAttachment): Promise<void>
async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>
async admitPromptContent(content: readonly AttachmentAdmissionPart[]): Promise<AdmittedPromptContentPart[]>
admitEncodedFile(input: EncodedFileAttachment): Promise<FileAttachmentRef>
isAttachmentError(error: unknown): error is AttachmentError
abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>
abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
imageHostPath(ref: ImageAttachmentRef): string | undefined
saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef>
saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef>
async *readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array>
fileHostPath(ref: FileAttachmentRef): string | undefined
readImageRequest(ref: ImageAttachmentRef, target: ImageRequestTarget, signal?: AbortSignal): Promise<RequestImageAttachment>
```

**这是唯一的图片写入 API。** 注意 `saveImage` 的入参是**字节**，不是路径：

```ts
export interface SaveImageAttachment {
    data: Uint8Array;
    mediaType: ImageMediaType;
    name?: string;
}
```

证据：`dsh-attachment:228-236`（基类 `saveImages`）与 `dsh-attachment-local:1024-1034`（实现覆盖）。本地副本 `.scratch/_reference/_extract/att_index_full.js:217-236`。

### 1.2 五个 payload / ref 类型（逐字）

```ts
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface ImageAttachmentRef {
    attachmentId: AttachmentId;
    mediaType: ImageMediaType;
    bytes: number;
    width: number;
    height: number;
    name?: string;
    originalDimensions?: { width: number; height: number; };
}

export interface StoredImageAttachment { ref: ImageAttachmentRef; data: Uint8Array; }

export interface ImageRequestTarget { width: number; height: number; maxBytes: number; }

export interface RequestImageAttachment {
    variantId: ImageVariantId;
    attachment: ImageAttachmentRef;
    data: Uint8Array;
    mediaType: ImageMediaType;
    bytes: number;
    width: number;
    height: number;
    depth: 'uchar';
    space: 'srgb';
    hasAlpha: boolean;
}

export interface ImageAttachmentLimits {
    maxImageBytes: number;
    maxImagesPerMessage: number;
    maxMessageImageBytes: number;
    maxImagePixels: number;
    maxImageDimension: number;
    mediaTypes: readonly ImageMediaType[];
}
```

（`ImageBlock` / `ImageAttachmentRef` 亦在 `dsh-llm/lib/typert.host.js:371-378`，本地副本 `.scratch/_reference/_extract/llm_typert.js:371`。）

`AttachmentId` / `ImageVariantId` 是纯 identity 函数，无运行时校验（`dsh-attachment:126-136`，本地 `.scratch/_reference/_extract/att_index_full.js:126-136`）：

```js
function AttachmentId(value) { return value; }
function ImageVariantId(value) { return value; }
```

brand（`Branded<'AttachmentId'>`）只存在于类型层，所以插件在 JS 里直接透传字符串也安全。

### 1.3 `ImageBlock` 的正确构造

逐字（`dsh-llm/lib/typert.host.js:375`）：

```ts
export interface ImageBlock {
    type: 'image';
    attachment: ImageAttachmentRef;
    offloaded?: true;
}
```

即字面量只有三个键。**没有 base64、没有 path、没有 mime、没有 width/height**——全部从 `attachment` 这个 ref 里取。`offloaded` 由 `dsh-compaction-image-offload` 独占写入，插件不要自己设。

### 1.4 在 `UserMessage` 里的正确形状

`MessageBase`（`dsh-llm` 声明）：

```ts
export interface MessageBase {
    readonly id: MessageId;
    readonly content: readonly ContentBlock[];
    readonly source: MessageSource;
}
export interface UserMessage extends MessageBase { readonly role: 'user'; }
```

所以一条带图的 user message：

```js
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const message = createUserMessage({
  content: [
    { type: 'text', text: '<ticket 描述与文字上下文>' },
    { type: 'image', attachment: ref1 },
    { type: 'image', attachment: ref2 },
  ],
  source: { kind: 'user' },   // 或自定义 source kind，见 §1.6
});
```

`createUserMessage` 实现在 `dsh-llm/lib/message.js`（本地副本 `.scratch/_reference/dsh-plugin-docs/llm_message.js:40-100`）：补 `role:'user'` 与新 `id`，然后 `deepFreeze(structuredClone(...))`。**输入会被深冻结克隆**，不要指望之后还能改这个对象。

### 1.5 `agent.inject()` 的确切签名

逐字（`dsh-llm`/`dsh-agent` 类型，见 `dsh-user-questions/lib/typert.host.js:232` 等 10 处重复）：

```ts
export interface Agent {
    readonly id: SessionId;
    readonly options: AgentOptions;
    readonly session: Session;
    readonly inbox: Inbox;
    readonly status: AgentStatus;
    readonly ctx: Context;
    cancel(cause: AgentCancelCause, options?: CancelOptions): void;
    whenIdle(): Promise<void>;
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
    send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
    followup(message: UserMessage): void;
    steer(message: UserMessage): void;
    inject(message: UserMessage): void;
}
```

**`agent.inject()` 收整条 `UserMessage`，不是 `ContentBlock[]`。**

三者的区别，实现逐字（`dsh-agent-loop:800-814`，本地 `.scratch/_reference/dsh-plugin-docs/agent-loop_index.js:800-814`）：

```js
send(message, target, wakeup) {
  const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
  const resolvedTarget = wakingAfterAbort ? "next-turn" : target;
  this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
  if (wakeup) this.wakeDriver(wakingAfterAbort);
}
followup(input) { this.send(input, "next-turn", true); }
steer(input)    { this.send(input, "next-step", true); }
inject(input)   { this.send(input, "next-step", false); }
```

| 方法 | 进哪个队列 | 是否唤醒 agent |
|---|---|---|
| `followup(msg)` | `next-turn` | 是 |
| `steer(msg)` | `next-step` | 是 |
| `inject(msg)` | `next-step` | **否** |

三者都会 `session.append("agent/inbox/spliced", …)`（`dsh-agent-loop:198-206`），也就是都进会话日志，重启可恢复。

官方对 `inject` 的定位（`.scratch/_reference/dsh-plugin-docs/skill__references_practices.md:29`）："A timer that starts work calls `agent.followup()`, which wakes the agent; `agent.inject()` does not wake it, so injected context can wait in the inbox until other input arrives."

**对工单插件的直接含义**：插件自己起 turn 时用 `followup`（否则 agent 不会动）；往正在跑的 agent 里补上下文用 `inject` 或 `steer`。

### 1.6 `source` 该填什么 —— 一个必须注意的取舍

`MessageSourceMap` 逐字全文在 `dsh-llm/lib/typert.host.js:476`（本地 `.scratch/_reference/_extract/llm_typert.js:476`），共 23 个 key：`user`、`model`、`tool`、`'system-prompt'`、`'model-selection'`、`'runtime-context'`、`'working-directory'`、`'user-approval'`、`'ptc-mode'`、`'tool-registry'`、`'user-rpc'`、`'agent-message'`、`'subagent-settled'`、`'skill-invocation'`、`'compact-checkpoint'`、`'cordis-host-runner'`、`'team-message'`、`'user-question-reply'`、`goal`、`'plan-mode'`、`schedule`、`'session-reference'`、`webhook`。

**没有一个 key 是给第三方工单插件用的。** 三个现实选项，按推荐度排序：

1. **`{ kind: 'webhook', … }` —— 不推荐，未找到实现。**
   声明是 `{ readonly kind: 'webhook'; readonly provider: string; readonly source: WebhookSourceId; readonly deliveryId: WebhookDeliveryId; readonly ruleId: WebhookRuleId; readonly form: 'notice'; readonly summary: string; }`。
   但：asar 索引里**没有任何 `dsh-webhook*` 包**（`grep webhook .scratch/_reference/_tmp/asar-index.txt` 只命中 openai/anthropic SDK 与 `standardwebhooks` 库），已抽出的所有 `.js` 里也**没有 `kind: "webhook"` 的生产者**。这个 source 是预留类型，插件不应依赖。⇒ **未找到实现，不要用。**

2. **`{ kind: 'user' }` —— 最简单、100% 能跑。**
   代价：会话日志里看不出这条消息来自插件而不是人；Web UI 会把它渲染成一条普通用户消息。

3. **自定义 source kind —— 已验证可行（append 与 restore 两条路径都通过）。**
   `source: { kind: 'ticket', ticketId }` 在运行时能写进去、能读回来，且**不会被任何已发布消费者拒绝**。证据是两条独立的校验链：

   **(a) 写入路径不做 source 白名单。** `Session.append()`（`_extract/session_index.js:1517-1538`）只做三件事：`snapshotJsonValue(data)`（非 JSON 化即抛 `session event "${type}" carries non-JSON-serializable data`，`:1524`）→ `validateSessionEventData(event, …)`（`:1535`）→ `this.commit(event, entry)`（`:1536`）；`commit`（`:1579-1599`）只调 `this.surfaceManager.validateNext(event)`，**不再校验 message shape**。

   **(b) 恢复路径只对 system/assistant/tool 强制精确 kind。** `assertMessageEventShape`（`_extract/session_index.js:1194-1223`）是唯一校验 `source.kind` 的地方，且只在 `adoptSessionEvent`（`:1089`，restore/import）与 seed 校验（`:1165`）调用。逐字规则：
   ```js
   if (typeof source !== "object" || source === null || typeof source["kind"] !== "string" || source["kind"] === "")
       throw new Error(`${subject} message has invalid source`);
   if (type === "system/message")    { if (sourceRecord["kind"] !== "system-prompt") throw …; return; }
   if (type === "assistant/message") { if (sourceRecord["kind"] !== "model" || !hasProviderModel(sourceRecord)) throw …; return; }
   if (type !== "tool/result") return;
   if (sourceRecord["kind"] !== "tool" || …) throw …;
   ```
   ⇒ `user/message` **只要求 `kind` 是非空字符串**，不比对具体值。

   **(c) 消费端全部是「只认 `'user'` 做特判，其余走通用分支」，没有 `assertNever`/switch 抛错**（全量 `grep source\.kind` 于 `_extract/*.js`）：`dsh-client-ui-chat_client.js:2815` `inbox["next-step"].filter(m => m.source.kind === "user")`；`:2831` `if (source.kind !== "user" || !("rpcId" in source)) return [item];`；`:9813` `claimedHuman: removed.some(m => m.source.kind === "user")`；`dsh-client-ui-conversation_client.js:16958,16961` 只按 `'user'`+`rpcId` 过滤；`session_controller.js:1044,1131,1137,1874,3002` 只在 `kind === "user"` 时做 retire/幂等/`lastPromptAt` 更新；`llm_deepseek.js:1526` 只在 `kind === "model"` 时读 `replayState`。

   **已知副作用（都不影响本插件）**：自定义 kind 的消息不进 UI 的 steering 列表、不算 human claim（`:9813`）、不更新 `lastPromptAt`（`session_controller.js:1874`）、不触发 `fileUploads.retirePrompt`（`:1044`）。工单插件用自己的 `followup` 起 turn，不依赖这四条。

**这是需要人拍板的第 1 个点**（见 §7）。

### 1.7 `admitPromptContent` —— 唯一一批处理的入口，但它的入参是 base64

`PromptContentPart`（wire 形状，见 `dsh-subagent/lib/typert.host.js`）：

```ts
export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string; }
  | { readonly type: 'image'; readonly mediaType: ImageMediaType; readonly data: string; readonly name?: string; };
```

注意 image 分支是 **`data: string`（canonical base64）**，不是 `Uint8Array`，也**没有 url / path 字段**——`blob:` 和 `data:` URL 都不被接受。

`admitPromptContent` 实现（`dsh-attachment:242-268`，本地 `.scratch/_reference/_extract/att_index_full.js:242-268`）：

```js
async admitPromptContent(content) {
  if (content.every((part) => part.type !== "image")) return content.map((part) => part.type === "text" ? { type: "text", text: part.text } : { type: "file", attachment: part.attachment });
  const refs = await admitEncodedImages(this, content.filter((part) => part.type === "image"));
  let next = 0;
  return content.map((part) => { … return { type: "image", attachment: refs[next++] }; });
}
```

`admitEncodedImages` → `attachments.saveImages(images.map(saveInput))`，`saveInput` 里 `data: decodeBase64(image.data)`（`dsh-attachment:82-100`）。

**用法选择**：
- 如果插件手里已经是 `Uint8Array`（从飞书下载的字节），直接 `saveImage`/`saveImages` 更省一次 base64 编解码。
- 如果插件走的是和 API controller 一样的「wire 形状」入参，用 `admitPromptContent` 能让 text/file/image 顺序保持原样，并且 file ref 原样透传。

`decodeCanonicalBase64` 会检查 `decoded.toString('base64') !== data`，非规范 base64 抛 `INVALID_IMAGE_BASE64`（`dsh-attachment/lib/types/admission.js`）。从飞书下载的二进制如果自己编 base64，注意必须是无换行、标准字母表。

### 1.8 官方 prompt 路径的完整范式（照抄这个）

`dsh-api-session-controller/lib/index.js:926-967`（本地 `.scratch/_reference/_extract/session_controller.js:926-967`）：

```js
const hasImage = request.content.some((part) => part.type === "image");
if (hasImage) {
  const current = this.agents.selectionFor(agent).current;
  const model = await this.ctx.llm.resolveModelInfo(current.provider, current.model);
  if (model.inputModalities !== void 0 && !model.inputModalities.includes("image"))
    throw new RemoteError("session/attachment-invalid", `Model "${current.model}" does not support image input.`, { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" });
}
const admission = resolvePromptFileReceipts(request.content, (receiptId) => this.ctx.fileUploads.resolve(agent, receiptId));
const message = createUserMessage({ content: await this.ctx.attachments.admitPromptContent(admission.content), source });
if (request.mode === "steer") agent.steer(message); else agent.followup(message);
```

**五步：取当前 route → `resolveModelInfo` 判 image → `admitPromptContent` → `createUserMessage` → `followup`/`steer`。**

`selectionFor(agent).current` 是 controller 私有实现（`session_controller.js:274`），插件拿不到；插件侧的等价物见 §3。

### 1.9 读文件字节：`ctx.fs`

服务 key：`fs`（`cordis_inspect_query` → host/Service/`{"service":"fs"}`）。

```ts
resolve(path: string, opts?: unknown): Promise<FsTarget>
readBytes(target: FsTarget, signal: AbortSignal, maxBytes: number): Promise<Uint8Array>   // 超限抛 FS_TOO_LARGE
readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
processPath(target: FsTarget): string
fileUrl(target: FsTarget): string
processPathFromHostPath(hostPath: string): string | undefined
interface FsTarget { targetKey: FsTargetKey; displayPath: string; }
```

`read_image` 用的就是这条（`dsh-tool-fs:1024-1027`）：

```js
const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes);
const data = await ctx.fs.readBytes(target, exec.signal, byteCap);
```

---

## 2. 图片大小与格式限制

### 2.1 支持的 mime

四种，硬编码：`image/png`、`image/jpeg`、`image/webp`、`image/gif`（`ImageMediaType`）。飞书截图一般是 png/jpeg，覆盖到了。**不支持的**：BMP、TIFF、HEIC、SVG、AVIF —— 插件必须自己转码或跳过。

### 2.2 限制常量（`dsh-attachment-local:895-920`，本地 `.scratch/_reference/_extract/att_local.js:896-916`）

```js
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;            // 20 MiB 编码后单图
const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20;
const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 200 * 1024 * 1024;   // 200 MiB 单条消息聚合
const DEFAULT_MAX_IMAGE_PIXELS = 64e6;                       // 64 Mpx 解码后
const DEFAULT_MAX_IMAGE_DIMENSION = 8192;                     // 单边
const DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS = 2048 * 2048;     // 存储归一化目标 ≈ 4.19 Mpx
const DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION = 8192;
const DEFAULT_NORMALIZED_IMAGE_MAX_BYTES = 4 * 1024 * 1024;  // 4 MiB 存储目标
const DEFAULT_IMAGE_COMPRESSION_CONCURRENCY = 2;
```

运行时解析值（`dsh-attachment-local:998-1010`）：

```js
imageLimits = {
  maxImageBytes: 20971520,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 209715200,
  maxImagePixels: 64e6,
  maxImageDimension: 8192,
  mediaTypes: ['image/png','image/jpeg','image/webp','image/gif'],
}
normalizationPolicy = { maxPixels: 4194304, maxDimension: 8192, maxBytes: 4194304 }
```

### 2.3 超限是报错还是缩放 —— 分两种情况，**这是最容易踩的坑**

| 情况 | 行为 | 证据 |
|---|---|---|
| 解码像素 > 4.19 Mpx，但 ≤ 64 Mpx，单边 ≤ 8192 | **自动等比缩小**，不报错；ref 里带 `originalDimensions` | `att_local.js:213` 快路径判定；`:235` `requestImageDimensions(...)` |
| 单边 > 8192 | `AttachmentError` `IMAGE_DIMENSION_TOO_LARGE` | `att_local.js:194` |
| 解码像素 > 64 Mpx | `AttachmentError` `IMAGE_TOO_MANY_PIXELS` | `att_local.js:193` |
| 编码字节 > 20 MiB | `AttachmentError` `IMAGE_TOO_LARGE`，**不缩** | `att_local.js:329` |
| 声明 mime 与实际字节不符 | `IMAGE_TYPE_MISMATCH` | `att_local.js:300-310` |
| 空字节 | `INVALID_IMAGE` | `att_local.js:300-310` |
| mime 不在四种内 | `UNSUPPORTED_IMAGE_TYPE`（批量预检） | `att_index_full.js:220` |
| 条数 > 20 | `TOO_MANY_IMAGES` | `att_index_full.js:219` |
| 聚合字节 > 200 MiB | `IMAGES_TOO_LARGE` | `att_index_full.js:220` |

docstring 原文（`dsh-attachment-local:905-911`）："Default total-pixel budget of the stored normalized image. A larger source is admitted and downscaled proportionally, so admission bounds what rides every later model request without refusing ordinary large sources."

⇒ **普通大截图（比如 3000×2000 的 Retina 截图）会被静默缩小，插件不需要自己做缩略图。** 只有 > 20 MiB 的字节、> 64 Mpx 的像素、> 8192 的边长才会被拒。

### 2.4 每张图进请求时还会再缩一次

provider 侧独立于存储限制，按 route 重新算尺寸。DeepSeek adapter（`dsh-llm-deepseek:210-230`，本地 `.scratch/_reference/_extract/llm_deepseek.js`）：

```js
const DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET = 512 * 512;
const DEFAULT_MAX_IMAGES_PER_REQUEST = 600;
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 2 * 1024 * 1024;   // 2 MiB / 请求图
const DEFAULT_MAX_REQUEST_FILES_BYTES = 128 * 1024 * 1024;
const REQUEST_IMAGE_MAX_DIMENSION = 4096;
function resolveRequestImageMaxBytes(model) { return model.imageMaxBytes ?? 2097152; }
```

`resolveRequestImageTarget`（`:241-248`）docstring："Small images are never enlarged."

DeepSeek 的视觉 token 模型（`:58-200`）：小于 544×544 的图会被**放大**，按 14px patch 对齐，每轴 3:1 降采样，单图上限 1024 token。

### 2.5 单请求的图片预算与 offload

`dsh-llm:236` `const IMAGE_OFFLOAD_REQUIRED_CODE = "IMAGE_OFFLOAD_REQUIRED";`。

`dsh-llm-deepseek:1458-1462`：

```js
function assertImagesFit(messages, versions, connection, representation) {
  const offloadImages = requiredImageOffload(messages, bounds(connection, representation), (block) => versions.get(block.attachment.attachmentId).bytes);
  if (offloadImages > 0) throw new LlmError(`DeepSeek Messages ${representation} request images exceed the route budget; ${offloadImages} more oldest occurrence(s) must be offloaded.`, IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages });
}
```

**这条是运行时自动处理的**：`@deepseek-ai/dsh-compaction-image-offload` 在 base composition 里（`.scratch/_reference/_extract/base_cordis.patch.yml:434-435`），它监听 `agent/request-error`，把最老的 N 张图标记 `offloaded: true`，写一条 `image/offload` 事件后重试整个请求（`dsh-compaction-image-offload:14-42`）。插件不需要自己管预算。

---

## 3. 模型不支持图片时的降级

### 3.1 DSH 里能查到「当前模型是否支持 vision」吗 —— 能

`llm` 服务的两个入口（inspect 权威）：

```ts
interface LlmModelInfo {
    provider: string; id: string; name: string; description?: string;
    inputModalities?: readonly ModelModality[];
}
type ModelModalityMap = { text: 'text'; image: 'image' };

async listModels(provider: string): Promise<LlmModelInfo[]>
async resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
```

判据：`info.inputModalities?.includes('image')`。

### 3.2 插件怎么拿「当前 route」

三条路，按可靠性排序：

| 入口 | 可用范围 | 签名 |
|---|---|---|
| `exec.agent?.session.requestHeader()?.config` | **只在 tool 执行内有 `exec`** | `requestHeader(): EpochHeader \| undefined`；`EpochHeader { config: LlmCallConfig; … }`，`LlmCallConfig { provider: string; model: string }` |
| `exec.agent?.options` | 同上 | `AgentOptions { provider?: string; model?: string; … }` |
| `ctx.agentDefaultModel.currentSelection()` | 任何地方（但只是**默认**选择，不一定是这个 agent 的实际 route） | `currentSelection(): ModelSelection`，`ModelSelection { provider; model; reasoningEffort? }` |

`agentDefaultModel` 只有两个方法（inspect 原文）：`currentSelection(): ModelSelection` 和 `async saveSelection(next: ModelSelection): Promise<void>`。

### 3.3 两种现有的 capability gate，语义不同

**宽松版**（`dsh-subagent:2234-2243`）——`undefined` 视为「未知，交给运行时投影」：

```js
async assertImageCapable(agent, signal) {
    const { provider, model } = agent.options;
    if (provider === void 0 || model === void 0) return;
    const llm = this.ctx.get("llm");
    if (llm === void 0) return;
    const info = await llm.resolveModelInfo(provider, model, signal);
    if (info.inputModalities !== void 0 && !info.inputModalities.includes("image"))
        throw new SubagentError(`Model "${model}" does not support image input.`, "MODEL_DOES_NOT_SUPPORT_IMAGES");
}
```

**严格版**（`dsh-tool-fs:909-917`，本地 `.scratch/_reference/_extract/tool_fs.js:909-917`）——`undefined` 视为「不支持」：

```js
async function assertImageCapableRoute(ctx, exec, requestedPath) {
	const routed = exec.agent?.session.requestHeader()?.config;
	const provider = routed?.provider ?? exec.agent?.options.provider;
	const model = routed?.model ?? exec.agent?.options.model;
	const llm = ctx.get("llm");
	if (provider === void 0 || model === void 0 || llm === void 0) throw new Error(`cannot read "${requestedPath}" as an image: the current model route could not be resolved`);
	const active = await llm.resolveModelInfo(provider, model, exec.signal);
	if (active.inputModalities === void 0 || !active.inputModalities.includes("image")) throw new Error(`cannot read "${requestedPath}" as an image: model "${model}" does not declare image input; switch to an image-capable model to read images`);
}
```

### 3.4 关键事实：**运行时会自己降级，插件不降级也不会瞎**

`dsh-llm:2337`（本地 `.scratch/_reference/_extract/llm_index.js:2337`）：

```js
if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image") && projectedMessages.some((message) => contentHasImage(message.content)))
  projectedMessages = projectImagesForTextModel(projectedMessages);
```

纯文本 route 收到的不是图，是一行确定性占位文本（`dsh-llm/lib/content.js:47-50`，本地 `.scratch/_reference/dsh-plugin-docs/llm_content.js:47-50`）：

```
[image omitted because this model accepts text only; attachment sha256:<前 8 位 hex>]
```

`dsh-llm__README.md:127` 确认这覆盖 tool result 里的图："…deterministic per-image placeholders, including tool-role result images, without rewriting append-only session history."

**注意 `!== void 0 &&` 这个短路**：如果 adapter 根本没返回 `inputModalities` 字段，运行时**不会**投影，图会原样发给 adapter，然后 adapter 自己抛错。这正是严格版 gate 存在的理由。

### 3.5 具体模型的实际情况（`dsh-llm-deepseek:19-33`）

```js
{ id: "deepseek-flash",   name: "DeepSeek-V4.1-Flash", contextWindow: 1048576, inputModalities: ["text", "image"], … }
{ id: "deepseek-v4-pro",  name: "DeepSeek-V4-Pro",     … }   // 没有 inputModalities 字段
```

⇒ **`deepseek-flash` 声明支持图片；`deepseek-v4-pro` 不声明。** 按 §3.4 的短路语义，v4-pro 上运行时的自动降级**不会触发**，最终由 adapter 的 `prepareImages` 抛 `UNSUPPORTED_CONTENT`（`dsh-llm-deepseek:1430-1445`）。

### 3.6 插件应该怎么降级 —— 建议

三条路，按工单插件的实际处境排序：

**A. 不降级，硬性要求 vision 模型（推荐，最简单）**
在 §1.8 的五步里照抄 API controller 的检查：不是 vision 就**不要开这个 ticket 的 agent**，直接给工单标一个「需要视觉模型」的失败原因并发微信。理由：工单截图是任务输入的必需部分，没有图 agent 大概率改错代码，跑完也是废的。

**B. 降级成文字描述（不推荐）**
技术上可行：调一个 vision 模型（`ctx.llm.stream({ provider, model, messages })` 直接指定 route，绕过 agent 的 route）把截图描述成文字，再把文字塞进 prompt。代价：多一次模型调用、多一份延迟、多一层失败点、描述可能丢关键 UI 细节。**除非产品明确要求，不要做。**

**C. 跳过图继续跑（最差）**
agent 会在看不到界面的情况下猜，产出的 MR 基本不可用。

**关键实现点**：用**严格版** gate（`inputModalities === void 0` 也算不支持），不要用宽松版。理由：`deepseek-v4-pro` 就是 `undefined` 的实际例子，宽松版会放行然后炸在 adapter 里，错误信息是一句 `UNSUPPORTED_CONTENT`，排查成本高。

---

## 4. 一次多图（1~3 张截图）

### 4.1 单条消息放多张——完全支持

`saveImages` 就是批量 API（`dsh-attachment:228-236`）：

```js
async saveImages(inputs) {
  this.validateImageBatch(inputs);
  for (const input of inputs) await this.validateImage(input);
  const refs = [];
  for (const input of inputs) refs.push(await this.saveImage(input));
  return refs;
}
```

- 输入是有序数组，输出是**同序**的 `ImageAttachmentRef[]`。
- 上限 `maxImagesPerMessage = 20`（默认），聚合 `maxMessageImageBytes = 200 MiB`。
- **all-or-nothing**：`dsh-attachment__README.md:32` —— "if any image is refused, the whole message fails and nothing is published."
- `LocalAttachmentStore` 覆盖版（`dsh-attachment-local:1024-1034`）先 `Promise.all` 并行 `prepareImageFile`，再顺序 `commitPreparedImageFile`，并发由 `imageCompressionConcurrency`（默认 2）限流。

### 4.2 一条消息里放多张的写法

```js
const inputs = screenshots.map(s => ({ data: s.bytes, mediaType: s.mediaType, name: s.fileName }));
const refs = await attachments.saveImages(inputs);   // 与 inputs 同序

const message = createUserMessage({
  content: [
    { type: 'text', text: ticketPrompt },
    ...refs.map(ref => ({ type: 'image', attachment: ref })),
  ],
  source: { kind: 'user' },
});
```

想给每张图单独配一行说明，就交错排列——`createUserMessage` 的 `content` 是普通数组，顺序即语义：

```js
content: [
  { type: 'text', text: '截图 1：列表页报错' }, ref1 && { type: 'image', attachment: ref1 },
  { type: 'text', text: '截图 2：详情页空白' }, ref2 && { type: 'image', attachment: ref2 },
]
```

（注意 `MessageBase.content` 是 `readonly ContentBlock[]`，不要塞 `false`/`undefined`——先 filter 掉。）

### 4.3 各角色限制：**图片只能出现在 `user` 和 `tool`**

`dsh-llm-deepseek:1441`（本地 `.scratch/_reference/_extract/llm_deepseek.js:1441`）：

```js
if (messages.some((message) => message.role !== "user" && message.role !== "tool" && contentHasImage(message.content)))
  throw new LlmError("DeepSeek Messages supports images only in user messages and tool results", "UNSUPPORTED_CONTENT");
```

`dsh-attachment__README.md:136` 也确认：「the role-neutral `ImageBlock` leaves assistant-side image output as forward compatibility — current production adapters declare text-only output, so only user content carries images.」

⇒ **不要试图把图放进 assistant message。**

### 4.4 每多一张图的成本

`dsh-tool-fs__README.md:209`："The image is billed on every later request until compaction. Each call is independently bounded by the attachment store's `maxImageBytes`/`maxImagePixels`/`maxImageDimension`; repeated successful calls accumulate history, and content addressing deduplicates only the stored bytes, not the per-request token cost."

⇒ 3 张图 × 单图上限 1024 token ≈ 3000 视觉 token **每一轮请求都要重付**。工单插件一个 ticket 一个 session、跑完就结束的话没问题；如果是有长历史的 session，要考虑 on-demand 而不是一次全塞。

---

## 5. tool 返回图 vs 直接 inject —— 有什么差别

### 5.1 tool 返回图：机制上完全可行

`ToolDefinition`（inspect，key `tools`）：

```ts
export interface ToolDefinition extends ToolSchema {
    readonly output: ToolOutputDefinition;
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    projectContent?(exec: ToolExecutionResult): ContentBlock[] | undefined;
    finalizeContent?(exec: ToolExecutionResult): ContentBlock[] | undefined;
    timeoutMs?: number;
    isConcurrencySafe?(args: unknown): boolean;
    presentCall?(args: unknown): ToolCallView | undefined;
    presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}
export interface ToolOutputDefinition {
    readonly schema: JsonSchemaNode;
    render(args: unknown, value: JsonValue): ContentBlock[];
    presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}
export interface ToolExecutionSuccess {
    isError: false; value: JsonValue; content: ContentBlock[]; meta?: JsonValue;
    additionalContexts?: UserMessage[]; concludesTurn?: true;
}
```

`output.render()` 返回 `ContentBlock[]`，所以可以直接给出 `{ type: 'image', attachment: ref }`。**但必须通过 lossless JSON 检查**（`dsh-tools:2661-2670`）：

```js
function snapshotProjection(toolName, projector, candidate) {
  … 非 lossless JSON → throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`])
}
```

`ImageBlock` 是纯 JSON（ref 里全是 string/number），能过。`Uint8Array` 过不去——所以**不能直接把图片字节塞进 tool 返回值**，必须先 `saveImage` 拿 ref。

ship 的参考实现就是 `read_image`（`dsh-tool-fs:966-980`，本地 `.scratch/_reference/_extract/tool_fs.js:966-980`）：

```js
function imageReadContent(value) {
	return [{
		type: "text",
		text: formatImageReadOutput(value.path, value.image)
	}, {
		type: "image",
		attachment: imageRefFromValue(value.image)
	}];
}
```

即 **先一段文本信封，再 image block**。信封格式（`dsh-tool-fs:944-963`）：

```
<path>{displayPath}</path>
<type>image</type>
<content>
{mediaType} image, {w}x{h} px, {bytes} bytes (downscaled from {ow}x{oh} px; multiply coordinates by {x} to locate features in the original file)
</content>
```

### 5.2 两条通路的实质差别

| 维度 | tool `output.render()` 返回图 | 直接 `agent.followup/inject(UserMessage)` |
|---|---|---|
| 落盘位置 | `tool/result` 事件（`session.append("tool/result", {turn, step, message, …}, {surfaceOp:'append', sourceEventSeqs:[callSeq]})`，`dsh-agent-loop:691-707`） | `user/message` 事件 + `agent/inbox/spliced`（`dsh-agent-loop:198-206`、`:1043-1074`） |
| 模型看到的位置 | 紧跟 assistant 的 tool_call 之后，作为 tool 结果 | 作为一条独立的 user 消息 |
| 需要模型主动调 | **是**（否则不会发生） | 否（插件推） |
| 是否唤醒 agent | 不涉及（tool 已在跑） | `followup`/`steer` 唤醒，`inject` 不唤醒 |
| 每轮成本 | 与 user 图相同，进历史后每轮重付 | 同 |
| UI 渲染 | tool result 卡片里的图（`dsh-tool-fs__README.md:254`：经浏览器 `tool.call.images` slot） | 普通消息里的附件缩略图 |
| 能否被 offload | **能**（`dsh-compaction-image-offload:19`：`if (event.type !== "user/message" && event.type !== "tool/result") continue;`） | 能 |
| 适用场景 | **工单开跑后 agent 自己决定看哪张图**；图很多、按需取 | **工单到达时插件一次性把上下文铺好** |

### 5.3 tool 还有第三条通道：`additionalContexts`

`ToolExecutionResult.additionalContexts?: UserMessage[]`。`dsh-agent-loop:565-576` `commitReady`：

```js
for (const context of result.additionalContexts ?? []) acceptContext(context);
```

`acceptContext` → `this.inbox.splice("next-step", this.inbox.nextStep.length, 0, [context])`（`dsh-agent-loop:1166`）。**等价于 `agent.inject()`，但由 tool 触发。**

### 5.4 对工单插件的建议

**混合，而不是二选一：**

1. **开跑时**：把工单描述 + 1~3 张截图的 `ImageBlock` 直接 `followup` 进首发 message —— 这是任务的必要输入，agent 一上来就该看到。
2. **跑的过程中**：装一个类似 `read_image` 的 tool（或者干脆复用现成的 `read_image`，base composition 已经装了，见 `.scratch/_reference/_extract/base_cordis.patch.yml:295-296`），让 agent 在需要放大某张图、看别的截图时自己去读。

**注意：`read_image` 已经存在且默认开启。** `dsh-tool-fs` 的 `Config.readImage` 默认 `true`（`dsh-tool-fs:1221`：`if (resolved.readImage) ctx.inject(["attachments"], (imageCtx) => applyReadImageTool(imageCtx));`），base composition 里的 `tool-fs` 条目没有 config，所以取默认。⇒ **插件大概率不需要自己写读图 tool，只要把截图落到 agent 能访问的路径上。**

⇒ **这是需要人拍板的第 2 个点**：截图是走「下载到工作目录 + 让 agent 用 `read_image`」，还是「插件直接 `saveImage` + inject」。见 §7。

---

## 6. 端到端验证过的调用链

```
飞书附件 → 插件下载 bytes
  → ctx.fs.resolve(absPath) → ctx.fs.readBytes(target, signal, cap)     // 或直接内存里就有
  → attachments.saveImage({ data, mediaType, name })                     // 归一化 + 落盘 + 返回 ref
  → createUserMessage({ content: [{type:'text'}, {type:'image', attachment: ref}], source })
  → agent.followup(msg)
  → 下一 step: agent/pre-step waterfall → session.append("user/message", msg)
  → 请求组装: llm.prepareCall → adapter.prepareImages
       ├─ projectOffloadedImages（把 offloaded 的换成占位）
       ├─ 检查 role ∈ {user, tool}
       ├─ 检查 model.inputModalities.includes('image')
       └─ 对每个 ref: attachments.readImageRequest(ref, resolveRequestImageTarget(...))
  → adapter.serialize: 每张图前插一行 handle 文本，再发 {type:'image', source:{type:'base64', …}}
```

---

## 7. 需要人决定的地方

1. **`source.kind` 用什么。** 三个选项（§1.6）：`{kind:'user'}`（最稳，但会话里分不清是人还是插件）、自定义 `{kind:'ticket', …}`（**已验证 append/restore 都能过，且无消费者会抛错**，代价是不进 UI steering 列表、不算 human claim、不更新 `lastPromptAt`）、`{kind:'webhook', …}`（**类型里声明了但已发布包无实现，不要用**）。建议：自定义 `{kind:'ticket', ticketId}`，可观测性最好且已验证安全。

2. **截图走哪条通路。** （§5.4）
   - **A：落盘 + `read_image`**：插件把截图写到工作目录，prompt 里写路径，让 agent 自己 `read_image` 读。优点：agent 按需读、可重复读、不占首发 context；缺点：多一次工具往返、agent 可能不读。
   - **B：直接 `saveImage` + inject**：首发 message 里就带图。优点：agent 一上来就看到，不会漏；缺点：3 张图每轮都重付视觉 token、且不能"只看一张"。
   - **C：A+B 混合**（推荐）：首发送 1 张主截图（或缩略版），其余落盘，prompt 里列出路径让 agent 按需 `read_image`。

3. **vision 模型缺失时整票失败还是排期重试。** （§3.6）如果当前默认模型被切到 `deepseek-v4-pro`（不声明 image），工单应该立刻失败并通知，还是留在队列里等模型切回来？建议立刻失败 + 微信通知，因为静默排队会让工单看起来"卡住"。

---

## 8. 未找到 / 未核实

- **`webhook` message source 的生产者。** 类型在 `dsh-llm/lib/typert.host.js:476` 声明，但 asar 索引里没有 `dsh-webhook*` 包，已抽出的 `.js` 里也没有 `kind: "webhook"` 的构造点。查过的位置：`.scratch/_reference/_tmp/asar-index.txt`（`grep webhook` 只命中 openai/anthropic SDK 与 `standardwebhooks` 库）、`.scratch/_reference/_extract/*.js`（`grep 'kind: "webhook"'` 无命中）。**结论：类型预留，无实现。**
- **`tool.call.images` slot 的运行时内容。** `dsh-tool-fs__README.md:254` 描述了它（"the tool-result card renders the image through the browser's `tool.call.images` slot, which the attachment presentation plugin fills"），但 `cordis_inspect_query` → client/Slots/`listSubTree({"root":"tool.call.images"})` **超时（10s）**，未取到 live 拓扑。`dsh-client-ui-conversation/lib/client.js:16876-16897` 的 `queueAttachments` 证明 client 会从 history 里收集 image block 并渲染缩略图（`dsh-client-ui-attachment/lib/client.js:446-467, 711-737`），但具体 slot 接线未验证。
- ~~自定义 `source.kind` 的消费者兼容性~~ —— **已核实，不再是未知项**：全量 `grep source\.kind` 于 `.scratch/_reference/_extract/*.js` 的 19 处命中全部是「只认 `'user'` 做特判，其余走通用分支」，无 `assertNever`/switch 抛错；`Session.append()` 与 `adoptSessionEvent()` 两条写入/恢复路径都接受任意非空 kind 的 `user/message`（`_extract/session_index.js:1194-1223`、`:1517-1538`、`:1579-1599`）。详见 §1.6。
- **`dsh-tools` 包内没有 `lib/typert.host.js`**（`asar-tool list` 未找到该路径），所以 `ToolDefinition` / `ToolExecutionResult` 的类型只能从 `tools_index.js` 的实现 + 早期 inspect 结果得到，没有官方 `.d.ts` 声明原文。
- **`defineTool` 的 `parameters` 简化 spec 支持哪些字段**：已确认支持 `type`（`string|number|integer|boolean|null|array|object|json|oneOf`）、`required: true`、`description`、`title`、`default`、`examples`、`enum`、`const`、`items`、`properties`、`additionalProperties`（`dsh-tools:537-542` 的 `ANNOTATION_KEYS` + `:686-737` 的 switch）。**不支持**完整 JSON Schema 的其他关键字。
