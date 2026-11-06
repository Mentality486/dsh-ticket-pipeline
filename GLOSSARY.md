# GLOSSARY 术语表

工单流水线（`plugins/ticket-pipeline`）的领域词汇。改代码时用词以此为准；新术语先加进来再写代码。

| 术语 | 英文/代码名 | 含义 |
| --- | --- | --- |
| 工单源 | ticket source | 工单的来源平台适配器（飞书 / 金山 WPS / mock），实现 `TicketSource` 契约，负责扫描表格并产出工单 |
| 工单 | ticket | 一行待处理的缺陷记录，含项目、模块、问题描述、操作流程、截图引用与指纹 |
| 票 | record / row | 工单在本地存储（`TicketStore`）里的一行持久化状态，带 phase、attempt、租约等执行账目字段 |
| 指纹 | fingerprint | 工单内容的哈希。内容变了指纹就变，扫描靠它区分「新工单」和「旧工单被修订」 |
| 水位 | watermark | 每个工单源的扫描进度记忆（见过的 recordId、上次扫描时间），支持持久化；适配器没接持久化时退化为进程内内存 |
| 租约 | lease | 处理一张票前先从 `TicketStore` 拿的独占锁，带 TTL 与心跳续期，防止多个进程同时处理同一张票 |
| 项目工作区 | project workspace | 一个项目对应的**固定本地检出**（`projects[].repo.path`，如 `D:/WorkSpace/mgiot-pms`），同时登记成宿主 Workspace。缺省（`isolateWorktree: false`）就在这份检出里改码、跑验证、本地提交 —— 所以开跑前要求它干净 |
| 隔离 worktree | isolated worktree | 打开 `isolateWorktree: true` 时，为一张票单独开的 git worktree（`<repo>/.agents/worktrees/`），失败也不污染项目工作区。默认**不开** |
| 仓库定位器 | repo locator | 把「工单里的模块名」翻译成「本地仓库路径 + 代码位置」的适配器（`locator-table`，配置驱动的映射表） |
| 执行器 | work executor | 真正拿工单干活的角色（`executor-agent`）：读提示与截图、改码、跑验证、提交、开 MR。mock 执行器只演不动真格 |
| 推送 | push | 把结果（完成 / 失败 / 需要补信息）通知人的适配器（PushPlus / QQ 邮箱 / mock） |
| 扫描 | scan | 工单源的一次轮询：对比水位产出 created / updated / disappeared 三类变化 |
| 退役 | retire / disappeared | 工单行从表格消失或连续多轮不再「处理中」，终态标 `gone`，不再执行 |
| needs-info | 需要补信息 | 中间态：截图取不到、信息不全或工单正文疑似提示注入时，停下等人补，发通知 |
| dead-letter | 死信 | 重试耗尽（attempt 达到 maxAttempts）后的 failed 票。保留工作区与最后错误，等人工 `pipeline_reset` 或改表重跑 |
| 表型 | table kind | 同一平台（飞书）下工单表的两种形态：**多维表格**（bitable）与**电子表格**（sheet）。由插件探测，不写进配置 —— 用户只管填表，表型不是配置项 |
| 工作表 | sheet | 电子表格里的一个页签（`sheet_id` / `title`）。对应多维表格里的「数据表」（`table_id`） |
| 表头行 | header row | 电子表格里写着列名的那一行（默认第 1 行，`match.sheetHeaderRow` 可改）。不自动往下扫 —— 行号身份下表头行一变身份就变 |
| 行身份 | row identity | 电子表格没有 `record_id`，身份由插件自造：`sh-seq-<序号值>`（默认，取序号列）或 `sh-row-<物理行号>`（序号为空时的兜底）。插行会让行号身份整体漂移 |
| 安装副本 | installed copy | 宿主真正加载的那份插件代码，位于 profile 下（`~/.dsh/profiles/desktop/node_modules/@local/ticket-pipeline`）。**它不等于本仓库的源码目录**：跨盘 `file:` 依赖落成目录复制，改源码不会自动进去 |
| 插件版本自检 | plugin version check | `pipeline_doctor` 第 5 节：按 profile 里声明的 `file:`/`link:` 源码路径，比对**安装副本与源码的文件内容**（只比会真被加载的那些文件）。落后就提示同步，结论只进「提醒」 |
