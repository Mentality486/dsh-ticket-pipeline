# 配置项参考

工单流水线插件的**全量**配置项。使用流程见 [使用手册](../user-guide.md)，这里只回答
「这个键叫什么、类型是什么、缺省多少、什么时候才需要动它」。

> **口径先说清**：本页出现三个不同的「多少个字段」，别混：
>
> | 数字 | 指什么 | 来源 |
> |---|---|---|
> | **27 个键 / 4 个分组** | 顶层配置项（不含 `projects` 数组内部） | `src/core/config.js` 的 `CONFIG_FIELDS` / `CONFIG_GROUPS` |
> | **34 个字段** | 一个 `projects[]` 元素里可写的深层路径 | `listProjectDescriptorPaths()` |
> | **30 个字段** | 设置面板「项目」页里画出来的控件数（34 里 `match.appToken` / `match.tableId` / `match.spreadsheetToken` / `match.sheetId` 四个没有输入框：定位工单表只走卡片头上的「工单表链接」） | `src/remote/host.js` 的 `describeProject()` |
>
> 所有缺省值都与 `src/core/config.js` 的 `default` 一一对应。改这一页之前先改代码。

---

## 1. 顶层键（27 个，4 个分组）

### 1.1 行为（10 个）

| 键 | 类型 | 默认值 | 能填什么 / 什么时候需要动 |
|---|---|---|---|
| `enabled` | boolean | `false` | **总开关**。缺省关：装上不会自动扫表、不建工作区、不提交。配好一切后再打开 |
| `pollIntervalMinutes` | number | `3` | 轮询间隔（分钟），1–60。飞书没有可靠的单元格变更事件，只能轮询 |
| `ticketTimeoutMinutes` | number | `40` | 单票墙钟超时（分钟）。超时**只通知不自动重试** |
| `maxAttempts` | integer | `2` | 可重试错误（网络、限流、`internal`）最多试几次，1–10。**注意是 2 不是 3** |
| `workExecutor` | string | `"mock"` | `mock`（只走流程、不改代码）/ `agent`（真改代码）。写错（大小写、尾空格）直接报 `invalid-input` 并列可用值，**不静默退回 mock** |
| `provider` | string | `""`（空） | 跑任务书的模型 provider。**留空 = 跟随当前会话默认**（推荐留空：钉死一个 provider 换台宿主就跑不起来） |
| `isolateWorktree` | boolean | `false` | `false` = 直接在项目工作区的检出里改代码、就地提交（检出脏也能跑）；`true` = 每票另开隔离 worktree 与票分支 |
| `writeBack` | boolean | `true` | 跑成 `done` / `skipped` 后回填「是否处理」「处理结果」「处理日期」三列。关掉退化成纯只读 |
| `writeBackStatus` | string | `"是"` | 回填时「是否处理」列写什么值。有的表用「已完成」「已处理」 |
| `writeBackOnFailure` | boolean | `false` | 失败的工单也往「处理结果」列写一段说明。**绝不写「是否处理」/「处理日期」**。打开后超时也写，人工取消不写 |

### 1.2 agent 与模型（3 个）

| 键 | 类型 | 默认值 | 能填什么 / 什么时候需要动 |
|---|---|---|---|
| `model` | string | `""`（空） | 模型名。留空跟随会话默认（钉死模型会在它被限流时让整条流水线全灭） |
| `maxTokens` | integer | `32000` | 单次模型调用的最大输出 token |
| `agentPreset` | string | `"ptc"` | 执行器给子 agent 挂的 preset id（决定它有哪些工具）。留空 = 不挂 |

### 1.3 通知（8 个）

| 键 | 类型 | 默认值 | 能填什么 / 什么时候需要动 |
|---|---|---|---|
| `pushAdapter` | string | `"mock"` | `mock`（不发真消息）/ **`feishu`（用你自己的飞书应用直发 IM，不经过第三方，推荐）** / `qqmail`（直发 SMTP，授权码走凭据 `QQMAIL_AUTH_CODE`）/ `pushplus`（中继微信，token 走凭据 `PUSHPLUS_TOKEN`，**需实名认证**）。写错直接报错 |
| `notifyOn` | string-array | `["done","skipped","failed","needs-info"]` | 哪些终态发通知 |
| `feishuPush.receiveId` | string | `""`（空） | `pushAdapter: feishu` 时的收件人。`open_id` 形如 `ou_…`；用 `open_id` 类型时**必须**先把这个人在开放平台「应用功能 → 机器人」的可用范围里加上，否则接口回 `230013`（那不是缺 scope） |
| `feishuPush.receiveIdType` | string | `"open_id"` | `open_id` / `email` / `chat_id`。`email` 需要 `contact:user.id:readonly`（否则 `99991672`）；群发用 `chat_id`（先把机器人拉进群） |
| `pushplus.channel` | string | `"clawbot"` | PushPlus 推送渠道，ClawBot 用 `clawbot` |
| `pushplus.callbackUrl` | string | `""`（空） | 送达回执地址（可选）。PushPlus 把 `sendStatus` 回吐到这里；HTTP 200 只代表受理，不代表送达 |
| `qqmail.host` | string | `"smtp.qq.com"` | SMTP 主机。企业邮箱换成自己的 |
| `qqmail.encryption` | string | `"tls"` | `tls` = 465 端口直连加密（推荐）／ `starttls` = 587 端口先明文再升级。**端口由它派生，不用另填** |
| `qqmail.user` | string | `""`（空） | 发件邮箱，如 `someone@qq.com` |
| `qqmail.to` | string | `""`（空） | 收件邮箱，多个用逗号分隔 |

### 1.4 高级（4 个）

| 键 | 类型 | 默认值 | 能填什么 / 什么时候需要动 |
|---|---|---|---|
| `leaseTtlMinutes` | number | `10` | 票级租约存活时间，防多进程抢同一张工单。心跳间隔是内置的 60 秒，不用配 |
| `branchPrefix` | string | `"ticket-"` | 票分支名前缀，后接 `<projectId>-<recordId>-r<修订号>`。**只有 `isolateWorktree: true` 时用得上** |
| `worktreeRetentionHours` | number | `24` | 终态工单的隔离 worktree 保留小时数，`0` = 不自动清理。只有开了 `isolateWorktree` 才有东西可清 |
| `keepSession` | boolean | `true` | 处理完保留那次会话（agent 实例永远释放，会话留在项目工作区名下，可在 GUI 里点进去继续追问）。`false` 才回收 |

### 1.5 不再给配的键（留着不报错、不生效）

| 键 | 收成什么 | 为什么 |
|---|---|---|
| `safePageRun` | 内置 `20` | 改大容易把一次扫描拖到超时 |
| `goneAfterScans` | 内置 `3` | 改小会误退役 |
| `concurrency` | 恒 `1` | 并发改同一个检出必然互相踩 |
| `leaseHeartbeatSeconds` | 内置 `60` | 配大点会让两个进程同时改同一个 worktree |
| `fetchBeforeCreate` | 内置 `true` | 不开会基于过期基线建分支 |

已**删除**的键：`pushplus.token`（改走凭据 `PUSHPLUS_TOKEN`）、`pushplus.template`（恒 `txt`）、
`qqmail.port` + `qqmail.secure`（合成 `qqmail.encryption`）、`logLevel`（从来没被消费过）。

> `pushAdapter: feishu` 复用读工单表那对凭据（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`），**不需要额外凭据**，
> 也不经过任何第三方服务。代价是「机器人可用范围」得在开放平台里配一次（`230013` 就是没配它）。
> 若那两个凭据还没填，适配器仍能装上（构造不抛），第一次真发时才报 `invalid-input` 并点名收件人 ——
> 装插件时配置常为空，在构造期抛会让整个插件挂载失败。

---

## 2. `projects[]` 每项（34 个字段）

一个项目 = 一张工单表 + 一个本地仓库。设置面板上的「项目」页把它们分成
**基本 / 工单表 / 金山文档 / 仓库 / 验证命令** 几个分区，金山那一组只在平台是 `wps` 时出现。

### 2.1 基本

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `name` | string | —（必填） | 项目唯一标识，分支名里会出现：`ticket-pms-xxx-r1` |
| `description` | string | `""` | 会进 agent 的定位提示，可留空 |

### 2.2 工单表定位（`match.*`）

> **定位工单表只有一个入口：项目卡片头上的「工单表链接」。** 把工单表的浏览器地址整条贴进去，
> 宿主解析后写进下面这几个 key —— 多维表格写 `appToken`（+`tableId`/`viewId`）、电子表格写
> `spreadsheetToken`（+`sheetId`）、知识库里的表写 `appToken`（表型留到运行时探测），
> 并且**一次只留一套**（写另一套时会把前一套清掉）。面板上这四个 key 都没有输入框，
> 手动改 YAML 当然可以，但要自己保证不并存两套。
>
> **校验口径（2026-11-10 起）**：`appToken` / `spreadsheetToken` / `docNamePattern`
> **至少有一个**就能通过 —— 不再要求 token 必须配 `tableId` / `sheetId` / `sheetName`。
> 理由：`/wiki/<token>` 这种链接不带 `?table=`/`?sheet=`，运行期本来就能自己解决
> （多维表格按表名或「表里恰好一张」定位、电子表格取第一张可见工作表）。
> 两套 token 同时存在**不拦，但会给一条警告**说「实际按哪套取工单，另一套不起作用」。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `match.platform` | string | `"feishu"` | `feishu` / `wps` / `mock`。**`wps` 是实验性**：没有内置取数通道，选它一张工单都拿不到（面板亮橙框，体检报阻断）。`webform` 已移除，老配置会拿到迁移提示 |
| `match.appToken` | string | — | 飞书**多维表格**的 `app_token`，或**知识库（wiki）里任意一张表的 token**。**可直接写整条链接**：从 `/base/<token>` 或 `/wiki/<token>` 取 token，从 `?table=` 取 table_id。表型不一定写死 —— wiki 链接的表型到运行时问 `get_node` 才知道。面板上没有明文输入框，用「工单表链接」写入 |
| `match.tableId` | string | — | 多维表格的 `table_id`。与 `appToken` 一起构成显式绑定；显式填了优先于链接里的 `?table=` |
| `match.viewId` | string | — | 只看某个视图 |
| `match.docNamePattern` | string | — | 兜底：按文件名模糊搜。没有显式 `appToken`/`tableId` 时用 |
| `match.statusValues` | string-array | `["处理中"]` | 状态列里哪些取值算「在处理中」（收票条件）。**缺省只认「处理中」这一个词**，而很多表的「是否处理」填的是「是 / 否 / 已完成」—— 值与配置对不上时**一张票都收不到，但接口全绿**。体检会采样状态列前 100 行实际取值，一个都对不上就报「状态值对不上」并给出改法（只进提醒，不阻断） |
| `match.recordIds` | string-array | `[]`（= 整张表） | 只处理这几条工单，收窄用 |
| `match.allowedImageHosts` | string-array | — | 截图 URL 的放行主机白名单（SSRF 防护） |
| `match.sheetUrl` | string | — | 金山文档表格的分享链接（`wps` 平台） |
| `match.sheetName` | string | — | 工作表名。金山用它；飞书电子表格也用它指定工作表 |
| `match.statusColumn` | string | — | 「是否处理」列名（`wps` 平台） |
| `match.statusValue` | string | — | 在处理中的取值（`wps` 单值形态；飞书用 `statusValues`） |
| `match.mediaPrefix` | string | — | 截图 fileToken 的前缀（`wps` 平台） |
| `match.spreadsheetToken` | string | — | 飞书**电子表格**的链接或 token。**四种写法都认**：`https://…/sheets/<token>`、`https://…/wiki/<token>`（知识库里的表格，最常踩坑的一种）、裸 token、`shtcn…`。带协议头却一个都认不出时直接报 `invalid-input`，不会静默拼出 404 |
| `match.sheetId` | string | — | 电子表格里的工作表 id（`sh…`）。不知道就留空并填 `sheetName`；两个都不填取第一张可见工作表 |
| `match.sheetHeaderRow` | integer | `1` | 表头在第几行。**不会自动往下找**，表头上方有标题行时改成实际行号 |
| `match.sheetIdentity` | string | `"seq"` | 行身份来源：`seq`（按序号列的值）/ `row`（按物理行号，插行会换身份） |
| `match.sheetIdColumn` | string | `"序号"` | 序号列的表头文字。取它的值当工单身份，空值退回行号 |
| `match.sheetRange` | string | — | 限定读取范围，如 `A1:M500`（大表用；读值接口无分页、单次上限 10 MB） |
| `match.sheetColumns` | object | — | 列名覆盖（**电子表格**），如 `{"description":"缺陷描述"}`。面板上写成一行 `description=我的列名, status=我的状态列` |
| `match.columns` | object | — | 列名覆盖（**多维表格**），写法同上。多维表格本来就会自动认一批常见别名，只有别名都不沾边时才需要 |
| `match.tableKind` | string | — | 逃生阀：`bitable` / `sheet`。**一般不用填**，留空 = 按 token 自动探测表型 |

> **必需列**：`description`（问题描述）与 `status`（是否处理）。映射不上时当场报错并列出表里实际的列名。

### 2.3 仓库（`repo.*`）

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `repo.path` | string | —（必填） | 本地 git 检出根目录。**同时就是这个项目的工作区目录**；目录必须已存在，插件不替你克隆。面板上有「选择目录」按钮 |
| `repo.remote` | string | — | **GitLab 仓库地址**（不是 git 远端名）。只有打开 `repo.gitlab.enabled` 时才用得上 |
| `repo.baseBranch` | string | 自动识别 | 从哪条分支切出工作分支（`origin/HEAD` → 当前分支 → 才猜 `main`）。**只有 `isolateWorktree: true` 时用到**。面板上带候选下拉 |
| `repo.targetBranch` | string | 同 `baseBranch` | MR 的目标分支。同样只在开 MR 时有意义 |
| `repo.gitlab.enabled` | boolean | `false` | 远程 MR 出口总开关。关着 = 只在工作区检出里做本地提交，不需要 `GITLAB_TOKEN`、不发任何 GitLab 请求。**实验性** |
| `repo.gitlab.baseUrl` | string | 从 `repo.remote` 推导 | 自建站点或子组路径时显式覆盖 |
| `repo.gitlab.remote` | string | 从 `repo.remote` 推导 | 推 MR 时用哪个 remote 的 URL（用于推导 projectId） |
| `repo.gitlab.projectId` | string | 从 `repo.remote` 推导 | 数字 id 或 `group/project` 路径 |

> 打开了 `repo.gitlab.enabled` 却只填一半（缺 `baseUrl` 或 `projectId`，且 `repo.remote` 也空），
> 工单会**跑到最后一步才失败**。面板会提前标红，体检会算作阻断。

### 2.4 验证命令（`verify.*`）

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `verify.build` | string | — | 构建命令。留空跳过构建 |
| `verify.test` | string | — | 验证命令。**留空跳过验证，直接做本地提交**（验证结论记为「未跑成」并写进通知） |

> 验证命令有超时与取消：缺省 30 分钟，超时退出码 **124**（与「检查没通过」区分开）。
> 宿主 `dsh-bash-local` 的 `maxTimeoutMs` 缺省 10 分钟会把它夹下去，真实上限取小者。

---

## 3. 凭据（不在配置文件里）

凭据**永远不写进 `cordis.patch.yml`**，走 DSH 的 credentials 存储，界面只显示「已配置 / 未配置」。
空字符串算「没配」。

| 键名 | 用途 | 必填场景 |
|---|---|---|
| `FEISHU_APP_ID` | 飞书应用 id | 用飞书工单源时 |
| `FEISHU_APP_SECRET` | 飞书应用密钥 | 用飞书工单源时 |
| `GITLAB_TOKEN` | GitLab 私人令牌（api 权限） | **仅**项目显式打开 `repo.gitlab.enabled: true` 时；缺省不填不影响任何事，体检在没打开时一个字都不提它 |
| `QQMAIL_AUTH_CODE` | QQ 邮箱**授权码**（不是登录密码） | `pushAdapter: qqmail` 时 |
| `PUSHPLUS_TOKEN` | PushPlus 推送 token | `pushAdapter: pushplus` 时 |

---

## 4. 校验与报错

配置写错时的手感（三件事都发生在「保存」或插件启动那一刻）：

1. **报错用中文名 + 原始路径 + 一句修法**。例：`轮询间隔（分钟，pollIntervalMinutes） 不能大于 60`，
   下面跟一句「填 1–60 之间的数字，常用 3」。
2. **拼错的键会被点名，但只警告不拦启动**。启动日志与 `pipeline_doctor` 会说
   「配置里有 `pollInvervalMinutes`，这个键不存在；你要找的是 `pollIntervalMinutes` 吗？」
   —— 老配置里留着已删的键是合法的，所以不能升级成硬错误。
3. **保存失败先说有几项没过**：「有 N 项没通过校验，已在下方标红」，并自动滚到第一个标红处。

> **配置能加载 ≠ 配置生效了**。拼错的键、写错位置的键都不会报警，只会安静地按缺省值跑。
> 想知道有没有这种键，跑一次 `pipeline_doctor`。

相关：决策记录见 [`docs/adr/`](../../adr/)，架构见 [architecture.md](../architecture.md)。
