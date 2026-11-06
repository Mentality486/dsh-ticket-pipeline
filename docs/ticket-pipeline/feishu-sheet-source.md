# 飞书工单源 · 多维表格 + 电子表格双支持（设计与排期）

> 状态：**设计已定，待实施**（2026-11-06）
> 需求来源：用户 2026-11-06 指令「能否都支持 由插件判断用户使用的是多维表格还是电子表格选择特定的工单」
> 已确认的两个前提（用户拍板）：
> - **身份策略 = B（行号 / 序号）** —— 电子表格没有 `record_id`，只能自造行身份。
> - **本轮范围 = 先出设计 + 排期**，不写实现代码。
> 配套文档：`docs/ticket-pipeline/architecture.md`（四层契约）、`docs/ticket-pipeline/feature-checklist.md`（完成度与缺陷）、`docs/adr/0005-飞书电子表格源按表型分派.md`（决策）、`docs/ticket-pipeline/operation-flow.md`（操作流程图）。
> 文中所有行号取自 2026-11-06 工作区源码（HEAD `2488036` + 未提交的「本地提交」改造）。

---

## 1. 目标与范围

### 1.1 目标

同一套插件配置、同一套流水线内核，同时支持两种飞书工单表：

| 表型 | 官方叫法 | 绑定键 | 行身份 | 变更时间戳 |
| --- | --- | --- | --- | --- |
| 多维表格 | Bitable | `appToken` + `tableId` | `record_id`（平台生成，稳定） | 有（`last_modified_time`） |
| 电子表格 | Sheets | `spreadsheetToken` + `sheetId` | **无** → 自造（行号 / 序号） | **无** |

**用户侧的要求是「插件自己判断」**：配置里**不出现**「表型」这个字段。人照旧只填一张表的链接或 token，插件在扫描前探测它到底是哪种表，然后走对应的读取路径。

### 1.2 不在范围内

- 不做**写回**（电子表格同样只读，用户 2026-11-03 已拍板的硬约束）。
- 不支持电子表格里的**内嵌图片**（单元格内粘贴的图片没有稳定可下载的 token 形态）——首版只支持人填的链接 / 本地路径两种截图形态。
- 不做「一张配置同时盯多张飞书表」。一个 `projects[]` 条目 = 一张工单表 + 一个仓库（现状不变，见 `feature-checklist.md` §4.1）。要看两张表就写两个条目、起两个名字。
- 不改 `TicketSource` 契约（`src/contracts/ticket-source.js:41-46`）。电子表格是**飞书平台内部**的另一种文档类型，不是新平台 —— 契约一个字都不用动。

---

## 2. 决策摘要

| # | 决策 | 理由 | 代价 |
| --- | --- | --- | --- |
| D1 | **不新增 `platform`**，仍用 `feishu`；新增「表型」概念在适配器内部判定 | 用户要「插件判断」；`PLATFORMS` 是平台表（ADR-0001），bitable/sheet 是同一平台的两种文档类型 | 适配器内部多一条分派路径，探测失败要能说清「试了什么」 |
| D2 | **探测按 token 形态分三种走法**：wiki 节点看 `obj_type`；`/base/` 与裸 token 先试 bitable 再试 sheet；只有 `docNamePattern` 时 drive 搜索同时认 `bitable` 与 `sheet` | 探测成本一次、结果缓存整轮；wiki 节点类型是**权威**的（服务端直接告诉你是什么） | 裸 token 要试两次（各一次失败请求） |
| D3 | **探测结果缓存进 `tableCache`，形状升级为带 `kind`** | 一轮扫描只探测一次；`kind` 决定后续走哪条读表路径 | 改了配置要重建实例才生效（现状如此） |
| D4 | **电子表格的身份 = 序号列值优先，行号兜底**，两种形态用 `match.sheetIdentity` 显式选 | 序号列是人手填的、插行不重排，比行号稳；行号是最后的兜底 | 序号被重填 / 重复时会换身份；必须检测重复并**拒绝启动**，不能静默取第一个 |
| D5 | **电子表格分支不做早停**，改成「一次读全表 + 逐行指纹比对」 | 电子表格**没有行级 mtime**，`safePageRun` 早停没有依据；而且读值接口**没有分页**（`has_more` 字段根本不存在） | 大表每次轮询都读全量，撞 10 MB 响应上限；需要在配置里支持限定读取范围 |
| D6 | **代码落在新文件 `src/adapters/source-feishu/sheets.js`**，主 `index.js` 只做分派 | 与金山源同构（`source-wps/index.js` + `source-wps/xlsx.js`）；`index.js` 已 1274 行，不该再胖 | 多一个文件，读代码要跳两处 |

### 2.1 备选方案与否决理由

| 备选 | 否决理由 |
| --- | --- |
| 新增 `platform: 'feishu-sheet'` | 违背「由插件判断」——表型变成人填的配置项；且要动 `PLATFORMS`、`SOURCES`、`validateProject` 三处表（ADR-0001 说的「加平台成本」），而这不是新平台 |
| 新增 `match.tableKind: 'bitable' \| 'sheet'` 让人显式写 | 同上：把判断责任推给人。可作为**逃生阀**保留（见 §4.2 `match.tableKind`），但默认不给、探测失败时也不自动要求人填 |
| 电子表格身份用「内容哈希」 | 哈希会随内容变，等于每改一次内容就换一张票，水位永远对不上 |
| 电子表格身份用「创建时间」 | 接口不提供行级创建时间 |
| 电子表格分页读（模拟翻页） | 读值接口无分页协议，只能自己按行区间切多次请求 —— 能做但没必要（见 §5.2） |

---

## 3. 表型探测（核心机制）

### 3.1 探测输入矩阵

用户给的东西千奇百怪，现在只认三种（见 §4.1 的配置改写）：

| 用户填的 | 探测路径 | 结果 |
| --- | --- | --- |
| wiki 链接 `https://...feishu.cn/wiki/<token>` | `GET /open-apis/wiki/v2/spaces/get_node?token=<token>` | `node.obj_type` = `bitable` → bitable；= `sheet` → 电子表格 |
| 知识库节点 token（`wiki` 开头） | 同上 | 同上 |
| `/base/<token>` 链接 | 直接当 bitable `app_token` | bitable（该形态只有多维表格） |
| 裸 token（`appToken` / `spreadsheetToken`） | 先试 bitable 表清单，再试 sheet 工作表清单 | 哪个成功算哪个 |
| 只有 `docNamePattern` | `GET /open-apis/drive/v1/files` 扫 `type ∈ {bitable, sheet}` | 合计恰好命中 1 张才用；命中 2 张（一张多维表格 + 一张电子表格同名）→ **配置错误** |

### 3.2 为什么 wiki 节点的 `obj_type` 是权威答案

**已核准的接口事实**：电子表格的 wiki 节点 `obj_type` 取值就是 `sheet`，而且官方原文确认「知识库中的电子表格，`obj_token` 同时就是该表格的 `spreadsheetToken`」——即 `obj_token` 可以直接拿去读值，不需要再做一次换算。

**当前代码的问题**（必须改）：`src/adapters/source-feishu/index.js:763-766` 的 `get_node` 调用把 `obj_type: 'bitable'` **硬写进了 query**，`:770-775` 于是把 `sheet` 判成「不是多维表格」并报错，错误文案里还写着「sheet=电子表格」不支持。这是当前**电子表格 100% 进不来**的直接原因，不是权限问题。

**改法**：`get_node` 不带 `obj_type`（服务端默认按节点实际类型返回），读 `node.obj_type` 做判定；同时保留「`obj_type` 为空时按 bitable 兜底」的旧行为，避免老服务端返回空值时把能用的多维表格判死。

### 3.3 裸 token 的双试顺序与错误处理

```
先试 GET /open-apis/bitable/v1/apps/{token}/tables
  ├─ 成功（返回表清单）           → kind = 'bitable'
  └─ 失败 → 按错误类型分流：
       ├─ auth / rate-limit / network / internal → 直接抛，不试 sheet
       │     （凭据、限流、网络问题与表型无关，换接口试只会把真因埋掉）
       ├─ not-found / invalid-input            → 继续试 sheet
       └─ 其他                                  → 继续试 sheet（兜底）

再试 GET /open-apis/sheets/v3/spreadsheets/{token}/sheets/query
  ├─ 成功（返回工作表清单）       → kind = 'sheet'
  └─ 失败 → 抛 invalid-input，文案列出两次尝试（像现有多候选 app_token 的写法）
```

**关键约束**：探测阶段**不得**把 `auth` 类错误降级成「不是这种表」。现有多候选 app_token 的报错文案已经把每次尝试列出来（`index.js:806-810`），电子表格探测沿用同一套文案风格：人一眼能看出「我试了两种表型，都没找到」。

### 3.4 探测结果的缓存

`tableCache`（`index.js:359-360`，现形状 `{appToken, tableId}`）升级为：

```js
/** @type {{ kind: 'bitable', appToken: string, tableId: string }
 *        | { kind: 'sheet', spreadsheetToken: string, sheetId: string } | null} */
let tableCache = null
```

- `resolveTable(signal)`（`index.js:788-838`）改名语义不变、内部按 `kind` 分派；
- **一轮扫描只探测一次**：`scan()` 开头调 `resolveTable`（`index.js:917`），之后整轮复用；
- 探测失败 → `invalid-input`，**不重试**（配置错，重试没用）。

### 3.5 表型判定的流程图

```mermaid
flowchart TD
    P0([resolveTable]) --> P1{配置给了什么?}
    P1 -->|appToken + tableId| P2[按 bitable 处理<br/>tableId 已是数据表 id]
    P1 -->|spreadsheetToken (+ sheetId/sheetName)| P3[按 sheet 处理]
    P1 -->|只有 docNamePattern| P4[drive/v1/files 扫<br/>type ∈ bitable, sheet]

    P2 --> P5[探测完成]
    P3 --> P5
    P4 --> P6{命中几张?}
    P6 -->|0 张| PE1([invalid-input<br/>没找到匹配的表])
    P6 -->|1 张| P7{它是什么 type?}
    P6 -->|≥2 张| PE2([invalid-input<br/>多张同名候选，列出来])
    P7 -->|bitable| P2
    P7 -->|sheet| P3

    P8[用户填的是 wiki 链接或 wiki token] --> P9[get_node 不带 obj_type]
    P9 --> P10{node.obj_type}
    P10 -->|bitable| P5
    P10 -->|sheet| P3
    P10 -->|空| P11[按 bitable 兜底<br/>老服务端兼容]
    P11 --> P5

    P12[用户填的是裸 token] --> P13[试 bitable 表清单]
    P13 -->|成功| P5
    P13 -->|失败且是 auth/rate-limit/network| PE3([直接抛<br/>与表型无关的真因])
    P13 -->|失败且是 not-found/invalid-input| P14[试 sheet 工作表清单]
    P14 -->|成功| P5
    P14 -->|失败| PE4([invalid-input<br/>列出两次尝试])

    P5 --> P15[(tableCache = {kind, ...})]
```

---

## 4. 配置面

### 4.1 现有校验规则必须改（当前卡点）

`src/core/config.js:494-501`：

```js
if (platform === 'feishu') {
  const hasExplicit = ... appToken && tableId
  const hasPattern = ... docNamePattern
  if (!hasExplicit && !hasPattern) {
    fail('match', 'feishu 项目必须给 appToken+tableId（显式绑定）或 docNamePattern（文件名模糊匹配）二选一')
  }
}
```

只给 `spreadsheetToken` 的配置会被这条**直接拒掉**（`hasExplicit` 为假、`hasPattern` 为假）——这是加电子表格支持必须动的第一处。

**改后规则**（四选一）：

| 给了什么 | 表型 | 还需要什么 |
| --- | --- | --- |
| `appToken` + `tableId` | bitable | —— |
| `spreadsheetToken` + `sheetId` | sheet | —— |
| `spreadsheetToken` + `sheetName` | sheet | ——（名称必须**恰好**命中 1 张工作表） |
| `docNamePattern` | 自动探测 | —— |

### 4.2 电子表格用到的配置键（全部项目级；9 个里 8 个是新增，1 个复用）

| 键 | 类型 | 默认 | 作用 | 谁消费 |
| --- | --- | --- | --- | --- |
| `match.spreadsheetToken` | str | `''` | 飞书电子表格 token（`shtcn…`） | 配置层透传 → 适配器 |
| `match.sheetId` | str | `''` | 电子表格里的**工作表** id（`sheet_id`） | 同上 |
| `match.sheetName` | str | `''` | 电子表格里的**工作表名**（与 `sheetId` 二选一）。**复用金山源已有的同名键**（见下方撞车提醒） | 同上 |
| `match.sheetHeaderRow` | int | `1` | 表头在第几行（1 起） | 同上 |
| `match.sheetIdentity` | enum | `'seq'` | 身份来源：`seq` = 序号列值；`row` = 物理行号 | 同上 |
| `match.sheetIdColumn` | str | `'序号'` | 身份取自哪一列（`sheetIdentity: 'seq'` 时生效） | 同上 |
| `match.sheetColumns` | object | `{}` | 列名覆盖：`{语义: 实际表头文字}`，如 `{"description":"缺陷描述"}` | 同上 |
| `match.sheetRange` | str | `''` | 限定读取范围，如 `A1:M500`（不给 = 读整张工作表） | 同上 |
| `match.tableKind` | enum | `''` | **逃生阀**：`bitable` / `sheet`。默认空 = 走探测；探测两次都失败时，报错文案里提示「实在判断不了可以显式写这个」 | 同上 |

> `match.sheetName` / `match.sheetIdColumn` / `match.sheetHeaderRow` / `match.sheetIdentity` 这几个键**只对电子表格分支有意义**。配了但表是 bitable → 忽略（不报错，多配一个键不该让整张表跑不起来）。

> **命名撞车提醒**：`match.sheetName` 这个键**已经存在** —— 它是金山源（`wps`）的工作表名，`config.js:563` 的透传循环里就有（`'sheetUrl', 'sheetName', 'statusColumn', 'statusValue', 'mediaPrefix'`），`config.js:919` 的 `describeConfig` 里也透出了。飞书电子表格的「工作表名」**复用同一个键**（语义一致：都是「这张文档里用哪个页签」），**不要新增 `sheetName` 的第二份定义**。实施时配置层只补其余 8 个键 + 在 `describeConfig` 里给 `sheetName` 补一句「两个平台共用」的注释。其余 8 个键（`spreadsheetToken` / `sheetId` / `sheetHeaderRow` / `sheetIdentity` / `sheetIdColumn` / `sheetColumns` / `sheetRange` / `tableKind`）与现有键无冲突。

### 4.3 列名映射：复用现成两套别名表

电子表格的列是**位置**，不是名字 —— 但表头行里写着名字。三处已有资产可以直接复用：

| 来源 | 位置 | 内容 |
| --- | --- | --- |
| 飞书 12 列常量 | `source-feishu/index.js:47-61` `FEISHU_COLUMNS` | 序号 / 发现部门 / 问题描述 / 发现日期 / 模块 / 操作流程 / 截图 / 优先级 / 是否处理 / 处理人 / 处理结果 / 处理日期 |
| 金山列别名表 | `source-wps/xlsx.js:32-43` `DEFAULT_COLUMN_ALIASES` | 同义列名（「缺陷描述」「复现步骤」「问题截图」…） |
| 金山优先级表 | `source-wps/xlsx.js:46-50` | 比飞书多「严重 / 轻微」两档 |

**做法**：电子表格分支用「飞书 12 列名 + 金山别名表」合成一张默认别名表，首行（或 `sheetHeaderRow` 指的那行）做表头，逐列反查语义；`match.sheetColumns` 覆盖个别列名。**必需列**：`description`（问题描述）与 `status`（是否处理）—— 缺任一列就报 `invalid-input` 并说清「表头里没有『问题描述』这一列，现有列名：…」，因为缺了描述列 = 收出来的票全是空的。

金山已有的 `HEADER_SCAN_ROWS = 10`（`xlsx.js:53`）思路可以借用，但电子表格**不做**「往下扫 10 行找表头」——行号是身份的一部分，表头行一变身份就变，必须显式配 `sheetHeaderRow`。

### 4.4 透传与脱敏

- `feishuOptionsFromMatch`（`index.js:1245-1274`）新增 9 条「**写了才透传**」分支（沿用现成的 `allowedImageHosts` 那种写法：不写就不给，适配器里给缺省值）。其中 `sheetName` 与金山源共用同一个键，适配器翻译时按平台区分即可。
- `describeConfig`（`config.js:891-928`）新增打码/透出：`spreadsheetToken` 打码为 `***(已配置)`（同 `appToken`）；`sheetId` / `sheetName` / `sheetIdentity` / `sheetIdColumn` / `sheetHeaderRow` / `sheetRange` / `sheetColumns` 透出（排障时要看「到底读的是哪张工作表、哪一行做表头、身份怎么算」）；`tableKind` 透出。
- `config.js` 顶部的 `ProjectMatch` typedef（`:60-79`）补上新键说明。

---

## 5. 电子表格分支的扫描设计

### 5.1 定位工作表

```
GET /open-apis/sheets/v3/spreadsheets/{spreadsheetToken}/sheets/query
→ data.sheets[]: { sheet_id, title, index, hidden, grid_properties{row_count, column_count}, resource_type }
```

- 给了 `sheetId` → 直接用（但要校验它确实在列表里，否则 `sheetId` 拼错和「表不存在」分不开 —— 调研已确认这点）；
- 给了 `sheetName` → 按 `title` 匹配，必须**恰好 1 张**，否则 `invalid-input` 并列出所有工作表名；
- 都没给 → 取 `index === 0` 且 `hidden !== true` 的第一张；多张可见时要求显式指定（**不瞎猜**，与现有「命中 0 或 >1 都当配置错误」的口径一致）。

### 5.2 读值

```
GET /open-apis/sheets/v2/spreadsheets/{spreadsheetToken}/values/{range}
range = {sheetId}!A{headerRow}:{endCol}{endRow}
→ data.valueRange{ majorDimension:'ROWS', range, revision, values: [[裸值, 裸值, ...], ...] }
```

**接口事实（已核准，设计必须遵守）**：

| 事实 | 后果 |
| --- | --- |
| `range` 是 **URL path 参数**（不是 query），`!` 与 `:` 都在路径里 | 必须 URL 编码后再拼 URL |
| 响应 `values` 是**二维数组、元素是裸值**（不是多维表格的 `{text}`） | 但 `normalizeCellText`（`index.js:116-131`）照样能用：裸字符串 / 数字都认得，顺带兼容富文本 `{text}` |
| **无 `has_more` / 无 `page_token`** —— 响应结构里根本没有分页字段 | **不能**套用多维表格的翻页循环；一次读一片 |
| 单次返回 ≤ 10 MB | 大表必须靠 `match.sheetRange` 收窄，否则读爆 |
| 某些 range 写法硬限 100 列 | 12 列的工单表无所谓，但要校验并报错而不是静默少读 |
| 空单元格形态**未核实**（`""` / `null` / 省略三种都可能） | 取值必须三种都容错 |
| 读值 v2、元数据 v3 | v3 是 snake_case（`sheet_id` / `row_count`），v2 是 camelCase（`sheetId` / `rowCount`），**不能共用取值函数** |

### 5.3 组装工单

```
values 二维数组
  → 第 headerRow 行 = 表头行 → 语义列映射（§4.3）
  → 第 headerRow+1 行起 = 数据行
      → 每行按语义列取值 → normalizeCellText / normalizeDateCell / extractScreenshots
      → makeTicket({ recordId, description, module, flow, priority, department, foundAt, seq, status, screenshots, raw })
```

- `makeTicket`（`src/contracts/ticket-source.js:88-121`）**一个字都不用改** —— 它只认语义字段，与表型无关。
- `priority` 归一沿用 `PRIORITY_MAP`（`index.js:93-98`）；电子表格分支额外并入金山那两档（`xlsx.js:46-50`），与金山源保持同一口径。
- `foundAt` 归一沿用 `normalizeDateCell`（`index.js:138-146`）：数字按毫秒/秒时间戳换算，其余按文本。
- `raw`：放 `{ sheetId, rowNumber, identitySource }`，排障时能直接看出这条票是第几行、身份是怎么来的。

### 5.4 身份（用户拍板的 B 方案）

| `match.sheetIdentity` | 身份取值 | 形态 | 什么时候坏 |
| --- | --- | --- | --- |
| `seq`（默认） | `sh-seq-<序号值>` | 取 `sheetIdColumn`（默认「序号」）列的值 | 人**重填 / 改写**序号；序号为空时**兜底成行号** |
| `row` | `sh-row-<物理行号>` | 数据行在表格里的绝对行号 | 人在上方**插行 / 删行** → 后面所有行整体漂移 |

**兜底与冲突处理**（这几条是 B 方案的代价，必须写死）：

1. `seq` 模式下某行序号为空 → 身份退化为 `sh-row-<行号>`，并在 `raw.identitySource = 'fallback-row'` 标记。**同一种来源必须能区分开**，否则一张票一会儿是 seq 一会儿是 row，水位对不上。
2. 同一轮里**序号重复** → 报 `invalid-input`，列出重复值与对应行号，**不静默取第一个**（静默取第一个 = 一张票吞掉另一张，最难查）。
3. 插行导致的漂移**已知且接受**：金山的行号身份已经踩过同一个坑，`source-wps/xlsx.js:611-613` 的注释写着「插行会让票换身份 → 旧票变新票 + 旧票退役」。电子表格分支**继承同一套水位与退役语义**，不另造机制。
4. 身份前缀 `sh-` 与多维表格的 `record_id`（形如 `recXXXX`）不会撞。

### 5.5 指纹与水位（与 bitable 同源，差别在「没有 mtime」）

| 维度 | bitable 分支 | sheet 分支 |
| --- | --- | --- |
| 指纹算法 | `fingerprintOf(ticket)`（`contracts/types.js`） | **同一份**（`makeTicket` 里算） |
| 指纹内容 | 描述 / 模块 / 操作流程 / 截图 / 优先级 / 发现部门（**不含** `是否处理` 等管理字段） | 同一份 |
| 变更判定 | 指纹变 → `updated` | 指纹变 → `updated` |
| mtime | `pickMtime`（`index.js:894-906`） | **拿不到 → 记 0** |
| 早停 | 连续 `safePageRun` 条已知未变就停翻页（`index.js:1004-1005`、`:1031-1034`） | **不做早停**（一次读全表，没有分页可停） |
| 首次出现 | 记水位、`tracked = 是否在处理中` | 同 |
| 掉出「处理中」 | 立刻退役（`index.js:1007-1015`） | 同 |
| 连续 `goneAfterScans` 轮没出现 | 退役（`index.js:1053-1065`） | 同 |

**指纹不含状态列**这件事在电子表格上同样成立：人把「是否处理」从「否」拨回「处理中」是**手动重置**，要重新处理（`index.js:1017-1022`），而不是「内容修订」。

**没有 mtime 的后果**（写进文档的已知代价）：

- `seen[recordId].mtime` 恒为 0 → 多维表格分支那条「mtime 只增不减」的保护在 sheet 分支没有对应物，**变更判定完全依赖指纹**；
- 指纹相同的行不会触发任何动作 —— 与 bitable 行为一致，没问题；
- 但**「这一行被人动过但内容没变」无法察觉**（比如只改了「处理人」列）—— 同样与 bitable 一致（指纹不含管理字段，本就不该触发工单）。

### 5.6 截图（首版只支持两种形态）

| 形态 | 电子表格能不能拿到 | 处理 |
| --- | --- | --- |
| `attachment{fileToken}` | ❌ 内嵌图片没有稳定可下载的 token 形态 | **不支持**。若表里有内嵌图片，首版一律当「没有截图」 |
| `path{path}` | ✅ 人填的共享路径 | 走 `readLocalFile`（`index.js:1096-1106`） |
| `url{url}` | ✅ 人填的链接 | 走 `fetchImageUrl` + **`allowedImageHosts` 白名单**（`index.js:1108+`、`:1129`），缺省全拒 |
| `unknown{raw}` | 认不出来 | 抛 `invalid-input` → 内核标 `needs-info` 让人补图，**不阻塞排队** |

`extractScreenshots`（`index.js:160-209`）对裸字符串的处理正好够用：`https://…` → url、含 `\` 或 `/` → path、其它 → unknown。

**白名单闸门继续生效**：截图地址是**外部输入**，电子表格同样不例外 —— 缺省全拒，放行要人显式配 `match.allowedImageHosts`（这条已在 `26f0391` 修好，别在新增分支上破例）。

### 5.7 电子表格分支的扫描流程图

```mermaid
flowchart TD
    S0([scan]) --> S1[resolveTable → kind='sheet']
    S1 --> S2[GET sheets/v3 .../sheets/query]
    S2 --> S3{定位到工作表?}
    S3 -->|给了 sheetId 但列表里没有| SE1([invalid-input<br/>sheetId 不存在，列出所有工作表])
    S3 -->|给了 sheetName 命中 ≠1| SE2([invalid-input<br/>列出工作表名])
    S3 -->|都没给且可见表 ≠1| SE3([invalid-input<br/>要显式指定])
    S3 -->|命中| S4[拿到 sheet_id 与 row_count/column_count]

    S4 --> S5[拼 range: sheetId!A{headerRow}:{endCol}{endRow}]
    S5 --> S6{有 match.sheetRange?}
    S6 -->|有| S7[用配置的范围]
    S6 -->|没有| S8[用整表范围]
    S7 --> S9[GET sheets/v2 .../values/{range}]
    S8 --> S9
    S9 --> S10{响应超过 10MB 或列数 >100?}
    S10 -->|是| SE4([invalid-input<br/>提示用 sheetRange 收窄])
    S10 -->|否| S11[values 二维数组]

    S11 --> S12[表头行 → 语义列映射]
    S12 --> S13{缺描述列或状态列?}
    S13 -->|缺| SE5([invalid-input<br/>列出表头现有列名])
    S13 -->|不缺| S14[逐行取值 → normalizeCellText]

    S14 --> S15[算身份]
    S15 --> S16{sheetIdentity}
    S16 -->|seq| S17[取序号列值]
    S16 -->|row| S18[取物理行号]
    S17 --> S19{序号为空?}
    S19 -->|是| S20[兜底 sh-row-{行号}<br/>标 identitySource=fallback-row]
    S19 -->|否| S21[sh-seq-{值}]
    S20 --> S22{本轮序号重复?}
    S21 --> S22
    S18 --> S22
    S22 -->|重复| SE6([invalid-input<br/>列出重复值与行号])
    S22 -->|不重复| S23[makeTicket → 指纹]

    S23 --> S24{水里有这条?}
    S24 -->|没有| S25[记水位<br/>状态命中 statusValues → created]
    S24 -->|有| S26{指纹变了吗?}
    S26 -->|没变| S27[不动]
    S26 -->|变了| S28[updated]
    S25 --> S29[扫完整表 → 无早停]
    S27 --> S29
    S28 --> S29
    S29 --> S30{这轮完整扫完?}
    S30 -->|是| S31[没出现的行 missingScans+1<br/>满 goneAfterScans → 退役]
    S30 -->|否（异常中断）| S32[不推进 missingScans]
    S31 --> S33[(saveWatermark)]
    S33 --> S34([返回 created/updated/disappeared])
```

---

## 6. 代码落点（改动清单）

> 本节是给实施者看的**实施清单**，本轮不写代码。

| 文件 | 位置 | 动作 | 规模 |
| --- | --- | --- | --- |
| `src/adapters/source-feishu/sheets.js` | **新建** | 表型探测的 sheet 分支 + 工作表定位 + 读值 + 表头映射 + 身份计算 | ~350 行 |
| `src/adapters/source-feishu/index.js` | `:748-786` `normalizeAppToken` | `get_node` 不再硬写 `obj_type: 'bitable'`；按 `node.obj_type` 判定；wiki 节点是 sheet 时返回 sheet 候选 | ~40 行改 |
| `src/adapters/source-feishu/index.js` | `:788-838` `resolveTable` | 三种绑定形态分派；裸 token 双试；drive 搜索扩 `type === 'sheet'`；缓存带 `kind` | ~80 行改 |
| `src/adapters/source-feishu/index.js` | `:359-360` `tableCache` | 类型升级为带 `kind` 的联合类型 | ~6 行改 |
| `src/adapters/source-feishu/index.js` | `:914-1070` `scan` | 开头按 `kind` 分派到 `_scanBitable`（现有逻辑原样搬）/ `_scanSheet`（新） | ~30 行改（主要是函数拆分） |
| `src/adapters/source-feishu/index.js` | `:1245-1274` `feishuOptionsFromMatch` | 9 条「写了才透传」新键 | ~20 行增 |
| `src/core/config.js` | `:494-501` `validateProject` | 校验规则改四选一 | ~20 行改 |
| `src/core/config.js` | `:512-515`（飞书透传段）、`:562-566`（金山透传段，`sheetName` 复用） | 透传 9 个新键（其中 `sheetName` 复用金山同名键，只需在飞书段也带上它） | ~12 行增 |
| `src/core/config.js` | `:891-928` `describeConfig` | `spreadsheetToken` 打码，其余透出 | ~10 行增 |
| `src/core/config.js` | `:60-79` `ProjectMatch` typedef | 补新键说明 | ~10 行增 |
| `scripts/feishu-checks.mjs` | 打桩服务器 | 加 sheets v2/v3 分支、wiki 返回 `obj_type: 'sheet'` 的场景 | ~80 行 |
| `scripts/feishu-checks.mjs` | 新增断言 | 见 §7 | ~200 行 |

**不动的**：`src/contracts/*`（`TicketSource` 契约、`makeTicket`、`fingerprintOf`）、`src/core/scheduler.js`、`src/core/store.js`、`src/index.js`（`SOURCES` / `PLATFORMS` / `buildSourceOptions` 一个字都不用改 —— 这正是 D1「不新增平台」的红利）、金山源、mock 源、webform 源。

---

## 7. 自测计划

### 7.1 打桩要覆盖的形状

在 `scripts/feishu-checks.mjs` 现有 `createFakeServer`（`:102-208`）上补：

- `GET /open-apis/sheets/v3/spreadsheets/{token}/sheets/query` → 返回 1~2 张工作表（含 `grid_properties`）；
- `GET /open-apis/sheets/v2/spreadsheets/{token}/values/{range}` → 返回二维裸值数组；
- `get_node` 打桩可配置 `obj_type`（现打桩固定返回 `bitable`，见 `:188-194`）；
- 裸 token 探测：让 bitable 清单返回 91403、让 sheet 清单返回 200。

### 7.2 断言清单（20 条）

| # | 断言 |
| --- | --- |
| 1 | wiki 节点 `obj_type: 'sheet'` → 走电子表格分支，不再报「不是多维表格」 |
| 2 | wiki 节点 `obj_type: 'bitable'` → 仍走多维表格分支（不回归） |
| 3 | `get_node` 返回空 `obj_type` → 按 bitable 兜底 |
| 4 | 裸 token：bitable 表清单 200 → `kind = 'bitable'` |
| 5 | 裸 token：bitable 失败（91403）→ 试 sheet 成功 → `kind = 'sheet'` |
| 6 | 裸 token：两边都失败 → `invalid-input`，报错文案里**列出了两次尝试** |
| 7 | 裸 token：bitable 探测返回 `auth` 错 → **直接抛 auth**，不再试 sheet（真因不被埋） |
| 8 | `docNamePattern` 命中一张 `type: 'sheet'` 的文档 → 走 sheet 分支 |
| 9 | `docNamePattern` 同时命中一张 bitable + 一张 sheet → `invalid-input`（不瞎猜） |
| 10 | 给了 `sheetId` 但列表里没有 → `invalid-input` 并列出所有工作表 |
| 11 | 给了 `sheetName` 命中 2 张 → `invalid-input` |
| 12 | 表头行不在第 1 行（`sheetHeaderRow: 2`）→ 正确映射列 |
| 13 | 表头缺「问题描述」列 → `invalid-input` 并列出表头现有列名 |
| 14 | 表头列名是别名（「缺陷描述」）→ 也能映射上 |
| 15 | 身份：序号模式 → `sh-seq-<值>`；序号为空 → `sh-row-<行号>` 且标 `fallback-row` |
| 16 | 身份：同轮序号重复 → `invalid-input` 并列出重复值与行号 |
| 17 | 水位：连扫两轮，第二轮不重复推；改了描述 → `updated`；只改「是否处理」→ 不算变更 |
| 18 | 退役：删掉一行 → 连续 `goneAfterScans` 轮后才退役 |
| 19 | 截图：url 形态且域名不在白名单 → 拒绝；`path` 形态能读出字节 |
| 20 | **只读断言**：全程不得出现对 sheets 的写请求（与现有多维表格的「绝无写操作」断言同款） |

### 7.3 预期计数

现基线：`node scripts/dev-run.mjs` 实跑 **294 项全过**（2026-11-06，HEAD `2158e41` + 插件版本自检改动），`node scripts/chain-smoke.mjs` **11/11**。本设计落地后目标：**294 + 20 = 314 项**，`chain-smoke` 不变（不碰内核）。

---

## 8. 排期

> 单人工作量估算，含自测与文档回填；**不含**人工前置（应用权限、文档授权）。

| 阶段 | 内容 | 产出 | 人日 | 判据 |
| --- | --- | --- | --- | --- |
| **A · 配置层** | `validateProject` 四选一规则；9 个键的校验/透传/打码（其中 `sheetName` 复用金山同名键）；typedef 补文档 | `config.js` 改动 | 0.5 | 单独给一张电子表格的配置能通过校验并出现在 `describeConfig` 里 |
| **B · 表型探测** | `get_node` 改造 + 裸 token 双试 + drive 搜索扩 type + `tableCache` 带 `kind` | `sheets.js` 的探测部分 | 1 | 断言 1–9 全过；`kind` 能被日志打出来 |
| **C · 读值与映射** | 工作表定位、range 拼装、读值、表头映射、必需列校验 | `sheets.js` 的读取部分 | 1 | 断言 10–14 全过 |
| **D · 身份与水位** | 序号 / 行号身份、重复检测、兜底标记、指纹比对、退役 | `sheets.js` 的扫描部分 | 1 | 断言 15–18 全过 |
| **E · 截图与安全** | url / path 形态截图、白名单闸门、只读断言 | `sheets.js` + 断言 | 0.5 | 断言 19–20 全过 |
| **F · 文档回填** | 把现在标着「**设计待实施**」的地方改成实际行为：`architecture.md` §12.10、`feature-checklist.md` §4.1/§9.2 第 16 条/§10.3 第二步半、`user-guide.md` §3.1 + FAQ、`GLOSSARY.md` 新术语、ADR-0005 的状态行 | 文档 | 0.5 | 文档口径与代码一致（不再有「待实施」字样） |
| **G · 真实链路验证** | 真实电子表格读一遍 + 真跑一票 | 验收记录 | 0.5 | 读到真数据；一票跑绿 |
| | | **合计** | **5 人日** | |

### 8.1 关键路径与依赖

```
A 配置层 ──┬──> B 探测 ──> C 读值 ──> D 身份水位 ──> E 截图 ──> G 真实验证
           └──> F 文档（可与 B~E 并行）
```

- **A 必须先做**：否则只给 `spreadsheetToken` 的配置在启动时就被 `validateProject` 拒掉（`config.js:494-501`），后面的都无从谈起。
- **B 与 C 有依赖**：探测要知道表型，读值才知道读哪张工作表。
- **D 可与 C 并行**（身份计算只依赖「哪些行是数据行」这一事实）。
- **F 贯穿全程**，但口径最终要等 E 结束。

### 8.2 人工前置（不在人日内，但会卡住 G）

1. 开放平台应用开通权限：`sheets:spreadsheet:readonly`（或 `drive:drive:readonly`）—— 与现有多维表格的 `bitable:app:readonly` 是**两套独立 scope**，要单独开。
2. **文档级授权**：电子表格所有者 → 「…」→「…更多」→「添加文档应用」把应用加为协作者。`POST /drive/v1/permissions/:token/members` 只对 `user_access_token` 有效，插件用的 `tenant_access_token` 无法自举（同 `architecture.md` §12.8 记的多维表格那条）。
3. 一张真实的飞书电子表格（带表头行 + 序号列 + 问题描述列 + 是否处理列）。
4. 应用需要至少一个云文档 API 权限**已开通**，否则授权按钮不可用。

### 8.3 建议的推进顺序（并入 `feature-checklist.md` §10.3）

| 阶段 | 内容 | 判据 |
| --- | --- | --- |
| 第二步（当前） | 真实飞书票 `pms\|reczz28VWNWVefNA` 复跑一次全链路 | 收到真 QQ 邮件、邮件里有本地提交 sha 且能 `git show` 到、`verify.test` 真跑过 |
| **第二步半（新增）** | **飞书电子表格支持（本文档）** | 5 人日；`dev-run` 294 → 314；一张真表读出一张真票 |
| 第三步 | 补金山开放平台取数通道 | 给一张真实金山表链接 + 凭据，能扫出票 |
| 第四步 | 9.2 / 9.3 剩余项按需修 | —— |

---

## 9. 风险与已知代价

| # | 风险 / 代价 | 影响面 | 缓解 |
| --- | --- | --- | --- |
| R1 | **身份漂移**：`row` 模式插行即换身份（所有后续行整体漂移 → 旧票退役 + 新票涌入）；`seq` 模式人重填序号即换身份 | 高（会刷票） | 默认 `seq`；序号为空兜底行号并标记来源；序号重复直接拒绝启动；文档写明「不要在上方插行」 |
| R2 | **没有行级 mtime** → 变更判定完全依赖指纹 | 中 | 与 bitable 的指纹口径保持一致（本来就不含管理字段），行为可预期 |
| R3 | **读值无分页 + 10 MB 上限** | 中（大表） | `match.sheetRange` 收窄；超限时报 `invalid-input` 而不是截断 |
| R4 | **每次轮询读全表** | 中（配额） | 读值接口限流 100 次/秒，轮询间隔 3 分钟 → 完全够；不早停只是多读，不多打接口 |
| R5 | **v2 / v3 字段风格不一致**（snake_case vs camelCase） | 低 | 两套取值函数，不共用 |
| R6 | **空单元格形态未核实** | 低 | 取值容错 `""` / `null` / 缺失三种 |
| R7 | **内嵌图片不支持** | 中（体验） | 文档明说；表里有内嵌图时按「没有截图」处理，票里描述照常进模型 |
| R8 | **探测误判**：一个 token 两个接口都认 | 低 | bitable 优先（保持现状兼容）；仍不确定时让 `match.tableKind` 逃生 |
| R9 | **探测请求翻倍**（裸 token 场景多一次失败请求） | 低 | 一轮只探测一次并缓存 |
| R10 | **scope 要单独开**（`sheets:spreadsheet:readonly`） | 中（人工前置） | 写进 §8.2 与 `user-guide.md` §1.2.1 |

---

## 10. 术语补充（`GLOSSARY.md`）

| 术语 | 英文/代码名 | 含义 |
| --- | --- | --- |
| 表型 | table kind | 同一平台（飞书）下工单表的两种形态：多维表格（bitable）与电子表格（sheet）。由插件探测，不写进配置 |
| 工作表 | sheet | 电子表格里的一个页签（`sheet_id` / `title`）。对应多维表格里的「数据表」（`table_id`） |
| 表头行 | header row | 电子表格里写着列名的那一行（默认第 1 行，`match.sheetHeaderRow` 可改） |
| 行身份 | row identity | 电子表格没有 `record_id`，身份由插件自造：`sh-seq-<序号值>` 或 `sh-row-<行号>` |

---

## 11. 未决问题（本设计未定死，需要时再定）

| # | 问题 | 当前倾向 | 何时必须定 |
| --- | --- | --- | --- |
| Q1 | 电子表格分支要不要也支持「序号列 + 行号」双保险身份（两个都写进 `raw`） | 倾向支持：`raw.rowNumber` 已经带上了，不额外做 | 实施时 |
| Q2 | `match.sheetRange` 的范围语法要不要支持多段（`A1:M100,N200:P300`） | 倾向**不支持**（只支持单段），多表就配多个 `projects[]` 条目 | 实施时 |
| Q3 | 表头行要不要支持「往下扫 N 行找第一行有 ≥3 个已知列名的行」 | 倾向**不支持**（会与行号身份打架），坚持显式配 | 已定：显式配 |
| Q4 | 电子表格分支要不要支持 `viewId` 视图 | 倾向不支持（视图是 bitable 概念） | 已定：不支持 |
| Q5 | 探测失败时要不要自动回退到 `match.tableKind` | 要：`tableKind` 显式配置时**跳过探测**（省两次请求），没配置才探测 | 实施时 |
