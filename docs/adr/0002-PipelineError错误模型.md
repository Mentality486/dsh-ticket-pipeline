# ADR-0002：PipelineError 错误模型

状态：已采纳（2026-11-04）

## 背景

流水线横跨扫描、定位、执行、推送四类外部依赖，错误形态五花八门：HTTP 状态码、GitLab 业务码、SMTP 应答、本地 git 退出码。如果不归一，重试逻辑就得在每个调用点各写一遍，而且没人说得清哪些错值得重试。

## 决策

全仓库只允许一种抛错形态：`PipelineError`，带三个字段——

- `kind`：受控枚举。`invalid-input`（配置/参数错，不重试）、`auth`（凭据失效，不重试，需人修）、`rate-limit`（可重试，带 `retryAfterMs`）、`network`（可重试）、`internal`（可重试兜底）、`aborted`（用户取消/超时，不重试不通知）。
- `retryable`：布尔。重试决策只看它，不看 kind。
- `retryAfterMs`：可选。上游给了就优先用（GitLab 429 的 `Retry-After`、飞书限频应答），没有就走 `backoffDelayMs`（指数退避，基准 30s 上限 30min，±20% jitter，见 `src/core/scheduler.js:53`）。

外部错误一律经 `toPipelineError` 归一化后才允许进 catch 分支的决策逻辑；适配器不许把第三方错误对象原样抛出。

## 后果

- scheduler 的重试只有一条路径：`normalized.retryable && attempt < maxAttempts`，重排队时尊重 `enqueuedAt`（含退避时间）。
- 不可重试的错误直接进 failed 并触发推送，人看到的原因是 `kind: message` 形式的字符串。
- 代价：每个适配器都要写映射（HTTP 状态码 → kind），漏写的新错误会落进 `internal` 兜底——宁可多试一次，不可漏试。
