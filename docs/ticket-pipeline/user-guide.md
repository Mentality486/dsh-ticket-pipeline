# 工单流水线插件 · 使用手册（v0.1.0-test.1）

> 本手册面向**使用者**：从零开始把插件跑起来，直到收到第一封带**本地提交**的通知邮件。
> 架构原理见 [architecture.md](./architecture.md)，实现进度见 [feature-checklist.md](./feature-checklist.md)。

---

## 0. 这个插件是干什么的

你在共享工单表（飞书多维表格 / 金山文档 Excel）里描述问题，插件自动完成：

```
监控工单表 → 发现「处理中」的行 → 解析问题描述/操作流程/截图
    → 确定这张工单属于哪个项目 → 确保该项目的工作区已登记在 DSH 里
    → 直接在项目工作区的检出里改代码（缺省；检出脏也能跑，先拍一份只读基线）
      └─ 打开 isolateWorktree 时才额外切一个隔离 worktree 子目录
    → AI 规划并改代码 → 跑构建/测试
    → 在工作区检出里做一次本地提交（只提交 agent 真正改过的文件）
    → 回填工单表：「是否处理」「处理结果」「处理日期」三列
    → 通知你（QQ 邮箱直发 SMTP / PushPlus 中继微信），含提交 sha、分支与验证结论
    → 你在检出里 review 这个提交；想接着问就用 `pipeline_status` 里的 `处理会话` 点进那个会话
      （`处理会话` 只出现在 `pipeline_status` 与表格「处理结果」列，邮件里没有）
```

**人只做三件事**：填工单、收通知、review 那个本地提交。

---

## 0.5 从零上手：整条路只有 6 步

先看这张路线图，心里有个数；每一步的细节在后面各自的小节里。

| # | 做什么 | 在哪做 | 怎么算这步过了 | 详见 |
|---|---|---|---|---|
| 1 | 把插件装进 profile | 命令行 `dsh.cmd plugin --profile desktop add "file:<插件目录>"`，然后**重启宿主** | 对话里说 `pipeline_status` 有响应 | §2 |
| 2 | 配凭据 | 设置页「凭据」区块（或 DSH 凭据存储） | 该页显示「已配置」；`pipeline_doctor` 里凭据那行是 ✅ | §1.2 |
| 3 | 给飞书应用开权限并发布 | [飞书开放平台](https://open.feishu.cn) → 权限管理 → 版本管理与发布 | 能把应用加成多维表格协作者（**可编辑**） | §1.2.1 |
| 4 | 准备一份本地 git 检出 | 自己 `git clone` 到 `repo.path`（插件不替你克隆） | 那个目录里 `git status` 能跑 | §1.3 |
| 5 | 写配置 | 设置面板（常规）**或**手改 `cordis.patch.yml`（见下） | 面板能保存；手改则必须重启后 `pipeline_doctor` 认到项目 | §3.0 |
| 6 | mock 首跑 → 切真执行 | 先在对话里 `pipeline_scan` 走半程，再改 `workExecutor`/`pushAdapter` | `pipeline_status` 里出现一张 `done` 的票 | §4.1 / §4.3 |

### 0.5.1 如果你打算手改配置文件（和最初一样）

**这条路一直有效，插件现在也照样认**。手改的唯一代价是：**改完必须重启宿主**，因为配置在插件启动时读入。步骤：

1. 找到 `<DSH_PROFILE_DIR>\cordis.patch.yml`（Windows 桌面版缺省 `C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml`）。
2. 在文件里找 `- id: ticket-pipeline` 那一段（**已经存在就只改里面的键，别整段重复贴**；不存在才整段追加）。
3. 按下面这份最小配置改（**YAML 不是 JSON**：列表用 `-`、缩进两个空格、键值之间是「冒号+空格」）。
4. 存盘，**完全重启宿主**（关掉再开，页面刷新不算）。
5. 对话里说 `pipeline_doctor`：项目、仓库、分支、执行器、通知都被认到，就算配好了。

```yaml
- id: ticket-pipeline
  name: '@local/ticket-pipeline'
  config:
    enabled: true                 # 总开关，缺省是 false —— 最容易忘的一格
    workExecutor: mock            # 先 mock 走半程，验通再换 agent
    pushAdapter: mock             # 先 mock，验通再换 qqmail
    pollIntervalMinutes: 3        # 多久扫一次工单表
    projects:
      - name: pms
        description: 项目管理系统
        match:
          platform: feishu
          # 可以直接写飞书表格的整条 URL：插件会从 /base/<token> 里啃出 app_token，
          # 从 ?table=<tableId> 里啃出 table_id（这一条以前只啃前者，现在两个都认）。
          # 值里有 ? & : 这些字符时务必加引号，否则 YAML 会解析出错。
          appToken: "https://<你的域>.feishu.cn/base/<appToken>?table=<tableId>&view=<viewId>"
          # docNamePattern 是老写法（按文件名在多维表格里挑唯一一张表），
          # URL 里已经带 ?table= 时可以不写；只写 appToken 不带 table 时才需要它兜底。
          docNamePattern: 项目管理系统工单
          statusValues:
            - 处理中
        repo:
          path: D:/WorkSpace/pms          # 必须已存在（插件不替你 clone）
          baseBranch: main
          targetBranch: main
        verify:
          test: npm test                  # 不填 = 跳过验证，直接本地提交
  disabled: false
```

> 只写你想改的键就行，**其余走缺省**（比如 `writeBack` / `keepSession` / `isolateWorktree` 不写就是
> `true` / `true` / `false`）。但 `enabled` 缺省是 `false`，一定要自己写一行 `true`。
>
> 三个「写了却不生效」的典型原因：键名拼错（拼错的键被忽略、不报错）、段落没落在 `config:` 下面、
> 改完没重启宿主。用一个 `pipeline_doctor` 就能把前两个排掉。

**面板 vs 手改，选哪个？** 日常微调（改分支、改通知、开关总开关）用面板更省事，保存即生效、不用重启；
只有 `projects[].match.appToken` 这一格面板上没有输入框（明文密钥不下发浏览器），必须手改文件。
两者改的是**同一个文件、同一段落**，混着用也不会打架 —— 但**别同时开着两边改**，后保存的一方覆盖。

---

## 1. 准备工作

### 1.1 准备工单表（以飞书为例）

多维表格的数据表必须**按以下 13 个列名命名**（顺序无所谓，列名必须一致）：

| 列名 | 说明 |
|---|---|
| 序号 | 人手填的编号（仅展示用，插件不拿它当身份） |
| 发现部门 | 提工单的部门 |
| 问题描述 | ⭐ 核心：改什么、为什么改 |
| 发现日期 | — |
| 模块 | 出问题的功能模块（给 AI 的定位提示） |
| 操作流程 | 复现步骤 |
| 截图 | 附件或 URL 均可 |
| 优先级 | 高/中/低（或 p0-p3、urgent 等） |
| 是否处理 | ⭐ 流水线开关：只有填 **`处理中`** 的行会被收票 |
| 处理人 | — |
| 处理结果 | — |
| 处理日期 | — |
| 最后更新时间 | 修订检测用 |

> 关键规则：**「是否处理」拨到 `处理中` = 收票**；拨走（改成别的值）= 停止处理；
> 拨回 `处理中` = 重新收票（包括重跑失败的票）。
> 插件**扫描时只读**这张表；票跑成 `done` / `skipped` 之后会**回填三列**（「是否处理」「处理结果」「处理日期」），
> 别的一律不碰。`failed` 的票不回填 —— 留在「处理中」是刻意留的信号。不想让它写就把 `writeBack` 关掉。

### 1.2 准备凭据

在 DSH 的凭据存储（credentials）里配置以下键名（**一字不差**）：

| 凭据键名 | 用途 | 必填场景 |
|---|---|---|
| `FEISHU_APP_ID` | 飞书应用 id | 用飞书工单源时 |
| `FEISHU_APP_SECRET` | 飞书应用密钥 | 用飞书工单源时 |
| `GITLAB_TOKEN` | 开远程 draft MR 的 GitLab 私人令牌（需 api 权限） | **仅**项目显式打开 `repo.gitlab.enabled: true` 时；本阶段用不到 |
| `QQMAIL_AUTH_CODE` | QQ 邮箱**授权码**（不是登录密码） | pushAdapter=qqmail 时 |
| `PUSHPLUS_TOKEN` | PushPlus 推送 token | pushAdapter=pushplus 时 |

> ⚠️ 飞书应用需要被授权访问目标多维表格：在表格右上角「…→更多→添加文档应用」，
> 把你的应用加为协作者（**可编辑**）。**必须人工做**，应用自己加不了自己。
> 回填表格要写三列，所以这里得是「可编辑」而不是「可读」；只给读权限时票照样能跑完，
> 只是 `pipeline_status` 里那行会显示「回填表格：没写成 —— …」（飞书返回 `code 91403 Forbidden`）。
> QQ 邮箱授权码获取：QQ 邮箱网页版 → 设置 → 账户 → 开启 SMTP → 生成授权码。

### 1.2.1 飞书应用开通权限并发布

在 [飞书开放平台](https://open.feishu.cn) 进入你的应用：

1. 左侧 **权限管理** → 搜索 `bitable`，开通其中一个（要回填表格三列，选 **读写**；如果暂时不想让它写表就先开只读并关掉 `writeBack`）：
   - ✅ `bitable:app`（读写，**回填表格需要这个**）
   - 或 `bitable:app:readonly`（只读；只够扫描，回填会 `91403 Forbidden`）
2. 顺手把这两个也检查一下（后面步骤要用，一次配完省得再发版）：
   - ✅ `wiki:wiki:readonly` —— 查看知识库（wiki 换算用，可能已配好）
   - ✅ `drive:drive:readonly` —— 搜索云文档（`docNamePattern` 匹配用）
   - 📎 `drive:file:readonly` 或附件相关 —— 读截图附件用（不需要 `docx:document:readonly`，主要是媒体下载，一般跟随 drive 权限）
3. **关键一步：发布** —— 左侧 **版本管理与发布** → 创建版本 → 填个版本号和更新说明 → 提交发布。
   **权限不开版本不生效**（企业自建应用一般秒过或管理员自动审批）。

> **用电子表格当工单表时，还要额外开一组权限**：`sheets:spreadsheet:readonly`（或 `drive:drive:readonly`）。
> 这跟多维表格的 `bitable:app:readonly` **是两套互不相通的 scope，必须单独申请**。
> 另外电子表格的所有者要在表格页面「…」→「…更多」→「**添加文档应用**」把应用加为协作者 ——
> 插件用的是应用身份（`tenant_access_token`），没法自己给自己授权，这一步必须人工做一次。
> （电子表格支持**设计待实施**，这一步是等它落地后才需要的。）

### 1.3 确认本地仓库

每个项目需要一个**本地 git 检出**（`repo.path`），并确认：

- 工作区**脏也能跑**。**缺省模式（`isolateWorktree: false`）就在这份检出里改代码、就地提交**：插件会在 agent 动手之前用 `git stash create` 拍一份只读基线（不写 ref、不动工作区、不动索引），结束后只提交 agent 真正改过的文件 —— 你自己攒着的未提交改动、甚至已经 `git add` 进索引的改动，都会原样留在工作区，不会被这次提交带走。检出脏时插件只提醒一句（点名是哪些文件），照跑。
  插件判脏的口径是 `git status --porcelain -z -uall -- . ':(exclude).agents/worktrees' ':(exclude).agents/worktrees/**'`：`-uall` 会把未跟踪目录展开到文件级（否则目录里混的 `application.yml` 会被折叠成一个目录名、躲过敏感文件拦截），末尾两条排除规则跳过插件自己开的隔离 worktree —— 所以你手工跑 `git status --porcelain` 看到 `?? .agents/` 不算脏
- 远端 GitLab **只在**你打开了 `repo.gitlab.enabled: true`、要额外开远程 draft MR 时才需要。默认交付形态是工作区检出里的一次本地提交，不需要远端，也不需要 `GITLAB_TOKEN`

---

## 2. 安装插件

### 方式 A：从发布包安装（推荐）

```bash
dsh.cmd plugin --profile desktop add "file:D:/WorkSpace/dsh-ticket-pipeline/plugins/ticket-pipeline"
```

### 方式 B：从 zip 包

解压 `ticket-pipeline-0.1.0-test.1.zip` 后同上指向解压目录。

装完后**重启 DSH 宿主**（desktop profile 由 Electron 独占管理，重启才加载）。

---

## 3. 配置插件

> **配置到底填在哪、要不要手写 JSON**：见下方 **§3.0**。一句话答案 —— 两个入口
> （设置面板 / 手改 `cordis.patch.yml`），**常规用面板点就行，不需要抄任何 JSON**。
> 面板长这样：

装好重启后，打开**侧栏 Plugins → 找到「工单流水线」→ 点那一行的「配置」**，是一整页。顶部四个**页签**，
一次只显示一页（缺省停在「项目」，因为那是主线；参数和凭据是一次性调好的配角）。
页签上会挂小数字 —— 只在真有未保存的改动或待修的错时才出现，平时不占位：

| 页签 | 干什么 |
|---|---|
| **项目** | **可以在面板上直接改**：每个项目 5 个分区 21 个字段（**基本 / 工单表 / 金山文档 / 仓库 / 验证命令**；金山那组只在平台是 `wps` 时出现），改完点保存。`match.appToken` 只显示「已配置 / 前 4…后 4」的**只读预览**（面板不提供输入框，改它要手改配置文件，见 §3.0.1）；保存时只发改动过的深层路径，不会把整个数组覆盖掉。基准/目标分支两个字段还带**候选下拉**（列出该检出里真实存在的分支，可手打）。**缺省只显示 8 个常改字段**，其余收在「显示全部字段」复选框里。点项目名可以收起整个项目卡片，卡片内每个分区也能单独收起 —— 改过的和有错的字段无论收起与否都会露出来。**还能增删**：项目清单右上角「+ 添加项目」追加一个新项目，卡片头「删除」删掉整个项目（都带二次确认或禁用保护） |
| **参数** | **33 个字段 / 7 个分组**（扫描与队列 / 租约与重试 / 执行 / 回填工单表 / agent 与模型 / 通知 / 杂项），不常动的收在组内「高级设置」里。改完点顶部「保存」，写进 profile 的 `cordis.patch.yml`，重启后仍在。字段键名：`pollIntervalMinutes`、`safePageRun`、`goneAfterScans`、`concurrency` / `leaseTtlMinutes`、`leaseHeartbeatSeconds`、`maxAttempts` / `workExecutor`、`ticketTimeoutMinutes`、`isolateWorktree`、`keepSession`、`fetchBeforeCreate`、`branchPrefix`、`worktreeRetentionHours` / `writeBack`、`writeBackStatus` / `provider`、`model`、`maxTokens`、`agentPreset` / `pushAdapter`、`pushplus.token`、`pushplus.channel`、`pushplus.template`、`qqmail.host`、`qqmail.port`、`qqmail.secure`、`qqmail.user`、`qqmail.to`、`pushplus.callbackUrl`、`notifyOn` / `enabled`、`logLevel` |
| **凭据** | 飞书 App ID & App Secret、QQ 邮箱授权码、GitLab Token、PushPlus token。**只写不读回**，界面只告诉你「已配置 / 未配置」。填完跟顶部「保存」一起提交，每行不再各带一个小「保存」 |
| **体检** | 点「立即体检」跑一遍和 `pipeline_doctor` 同一份检查（git 链路 / 仓库路径与 remote / 凭据 / 执行器与通知 / **插件是不是最新**），结果按「必须修复」「提醒」分段 |

> 保存出错时提示**不随页签切换消失** —— 保存针对整份配置，错在哪页都得让你看见。

> 「配置」按钮只在插件被正常加载后出现；整页空白/没有按钮，先在对话里说 `pipeline_status`
> 确认插件活着，再看 §6 的排查。

### 3.0 这些配置到底填在哪？（面板 还是 手改文件）

**两个入口，改哪个都行，最终落在同一个文件**：profile 的 `cordis.patch.yml` 里
`- id: ticket-pipeline` 那一段的 `config:` 下。

| 入口 | 怎么改 | 什么时候生效 |
|---|---|---|
| **设置面板（常规，推荐）** | 侧栏 Plugins → 工单流水线 → 那一行的「配置」→ 改完点顶部「保存」 | 保存即写回 `cordis.patch.yml`，一般不用重启；改完发现行为没变（少数设置是启动时固化的），再重启一次宿主 |
| **手改配置文件** | 用编辑器直接改下面那段 YAML | **必须重启宿主**，插件启动时才读 |

配置文件位置（Windows 桌面版缺省）：

```
C:\Users\<你的用户名>\.dsh\profiles\desktop\cordis.patch.yml
```

也就是 `%DSH_PROFILE_DIR%\cordis.patch.yml`（`DSH_PROFILE_DIR` 指向哪就改哪；换过
profile 名字就把 `desktop` 换掉）。用记事本、VS Code 都行，**别**动同一文件里别的插件段落。

> **面板上不需要你抄 JSON**。下面这段 JSON 只是**结构示意** —— 讲清「字段长什么样、
> 谁嵌套在谁里面」，方便你对照面板上的分组。真想手改，请照 JSON 后面那段 **YAML** 写：
> 文件是 **YAML 不是 JSON**（列表用 `-`，缩进两个空格，键值之间是 `冒号+空格`），
> 而且整段必须落在 `- id: ticket-pipeline` 的 `config:` 里面，否则插件读不到。

结构示意（`projects[]` 与其余字段的嵌套关系）：

```json
{
  "enabled": false,
  "workExecutor": "mock",
  "pushAdapter": "mock",
  "projects": [
    {
      "name": "pms",
      "description": "项目管理系统",
      "match": {
        "platform": "feishu",
        "appToken": "<你的多维表格 app_token>",
        "tableId": "<你的数据表 id>"
      },
      "repo": {
        "path": "D:/WorkSpace/pms",
        "remote": "https://gitlab.example.com/group/pms.git",
        "baseBranch": "main",
        "gitlab": { "enabled": false }
      },
      "verify": {
        "build": "npm run build",
        "test": "npm test"
      }
    }
  ]
}
```

手改时照抄这份 **YAML**（这才是文件里真实的样子，可直接粘到 `- id: ticket-pipeline` 的
`config:` 下；把路径、token、分支换成你自己的）：

```yaml
- id: ticket-pipeline
  name: '@local/ticket-pipeline'
  config:
    enabled: false
    workExecutor: mock
    pushAdapter: mock
    pollIntervalMinutes: 3
    projects:
      - name: pms
        description: 项目管理系统
        match:
          platform: feishu
          appToken: <你的多维表格 app_token>
          tableId: <你的数据表 id>
        repo:
          path: D:/WorkSpace/pms
          remote: https://gitlab.example.com/group/pms.git
          baseBranch: main
          gitlab:
            enabled: false
        verify:
          build: npm run build
          test: npm test
  disabled: false
```

几个容易踩的点：

- **已有 `- id: ticket-pipeline` 段落就只改里面的键**，别整段重复贴一遍（YAML 里同 id 出现两次，行为取决于加载器，可能只有一个生效）。
- `match.appToken` **可以直接写飞书多维表格的整条 URL**（`https://<域>/base/<appToken>?table=<tableId>&view=…`），插件会自己啃出 app_token **和 table_id**（app_token 来自 `/base/<token>`，table_id 来自 `?table=`；`?view=` 也会一并当成 `viewId`）—— 也就是说**贴一条链接就够，不必再另外去找 table_id**。也可以老老实实只填 app_token + `tableId` 两个字段（显式 `tableId` 优先于链接里的 `?table=`）。若链接里没带 `?table=`，则仍需 `tableId` 或 `docNamePattern` 兜底，否则启动校验会拒绝。**面板上这一格是只读的**：只显示「已配置 / 前 4…后 4」，明文不下发到浏览器，也不提供输入框 —— 要改只能手改配置文件（见 §3.0.1 末尾）。
- **`enabled` 缺省是 `false`**，手改时别忘了自己那行是 `true` 还是 `false`；写完重启宿主，用 `pipeline_doctor` 确认插件加载到了。
- **值里带 `?` `&` `:` 这类字符（比如把整条飞书表格 URL 写进 `appToken`）时给整串加引号**，
  例如 `appToken: "https://<域>/base/xxx?table=tblYYY&view=vewZZZ"`；不加引号时 YAML 也常能读，
  但一旦值里出现 `: `（冒号+空格）就会被当成嵌套键，报错信息很难懂。
- 手写的键名必须与 §3.1 的表**一字不差**（拼错的键会被忽略，不会报错 —— 表现就是「我改了它怎么没反应」）。

### 3.0.1 这条 JSON 的每一格，在面板上对应哪里

如果你已经看过上面那段 JSON，可以直接按下表在设置页里找（**绝大多数格子在面板上点就能改**，
只有 `match.appToken` 一格必须手改配置文件，原因见表格下面的说明）：

| JSON 里的键 | 设置页位置 | 控件 |
|---|---|---|
| `enabled` | 「配置」→ 分组 **杂项** | 开关 —— **总开关**，配好一切前别开 |
| `workExecutor` | 「配置」→ 分组 **执行** | 下拉（`mock` / `agent`），写错直接报错不会静默退回 mock |
| `pushAdapter` | 「配置」→ 分组 **通知** | 下拉（`mock` / `pushplus` / `qqmail`） |
| `pollIntervalMinutes` | 「配置」→ 分组 **扫描与队列** | 数字，轮询间隔（分钟） |
| `projects`（整个数组） | 「项目清单」区块 | 卡片列表，右上角「+ 添加项目」，卡片头「删除」（带二次确认） |
| `projects[].name` | 项目卡片 → **基本** | 文本（必填、唯一） |
| `projects[].description` | 项目卡片 → **基本** | 文本（收在「显示全部字段」里） |
| `projects[].match.platform` | 项目卡片 → **基本** | 下拉（`feishu` / `wps` / `mock` / `webform`） |
| `projects[].match.appToken` | 项目卡片 → 底部一行 **只读状态** | **面板不提供输入框**，只显示「已配置（前 4…后 4）／未配置」—— 要改只能手改 `cordis.patch.yml` |
| `projects[].match.tableId` | 项目卡片 → **工单表** | 文本 |
| `projects[].repo.path` | 项目卡片 → **仓库** | 文本（**必填**，目录必须已存在） |
| `projects[].repo.baseBranch` | 项目卡片 → **仓库** | 输入框 + **候选下拉**（列出该检出里真实分支，也可手打） |
| `projects[].repo.targetBranch` | 项目卡片 → **仓库** | 同上 |
| `projects[].repo.remote` | 项目卡片 → **仓库**（面板上标作「远端名」，名字有误导） | 文本，收在「显示全部字段」里。**实际要填的是 GitLab 仓库地址**（`https://gitlab.x/group/repo.git` 或 `git@gitlab.x:group/repo.git`），插件从它推 `baseUrl` + `projectId` —— **不要**填 `origin`；**只有** `repo.gitlab.enabled: true` 走远程 draft MR 时才需要 |
| `projects[].repo.gitlab.enabled` | 项目卡片 → **仓库** | 开关，收在「显示全部字段」里（关着 = 只做本地提交） |
| `projects[].verify.build` / `.test` | 项目卡片 → **验证命令** | 文本（整组收在「显示全部字段」里；不填 = 跳过验证直接本地提交） |

> 项目卡片缺省只显示 8 个常改字段，其余收在「显示全部字段」复选框里；
> 平台是 `wps` 时才会多出金山那 5 个字段（另有一组「金山文档」分区）。
> 改过的和有错的字段**无论收起与否都会露出来**。

**为什么 `appToken` 在面板上只读**：它里面是明文密钥。宿主只把
`hasAppToken`（布尔）和 `appTokenPreview`（前 4…后 4）下发给浏览器，
**明文永不出宿主**，所以面板上没有编辑框 —— 硬画一个输入框只会让人以为
改了就存进凭据库，其实没有地方存。改它的唯一合法途径就是编辑 profile 的
`cordis.patch.yml`（§3.0 上面那段 YAML 里的 `match.appToken`），改完重启宿主。
反过来，`FEISHU_APP_ID` / `FEISHU_APP_SECRET` 这些**应用凭据**走的是「凭据」区块，
那是真能填的（写进 DSH 的 credentials 存储，只写不读回）。两者别混：

| 填什么 | 在哪填 | 存到哪 |
|---|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 设置页「凭据」区块 | DSH credentials（只写不读回） |
| `QQMAIL_AUTH_CODE` / `PUSHPLUS_TOKEN` / `GITLAB_TOKEN` | 同上 | 同上 |
| `projects[].match.appToken`（多维表格 app_token） | **只能手改 `cordis.patch.yml`** | profile 配置文件 |
| 其余 33 个配置键 + 项目清单其它字段 | 设置页「配置」「项目清单」 | profile 配置文件 |

### 3.1 配置项速查

**顶层**（全部 **33 个字段 / 7 个分组**，键名与 `src/core/config.js` 的 `CONFIG_FIELDS` 一一对应，按面板分组列出）：

**扫描与队列（4 个）**：

| 键 | 默认 | 说明 |
|---|---|---|
| `pollIntervalMinutes` | `3` | 扫表轮询间隔（分钟） |
| `safePageRun` | `20` | 连续扫到多少条已知且未变的记录后停止翻页 |
| `goneAfterScans` | `3` | 连续几轮扫不到就认定该行已被删除 |
| `concurrency` | `1` | 并发数。当前只支持 1：一轮最多跑一票。**当前是死配置，改了不生效**（见 `feature-checklist.md` §9.2 第 14 条） |

**租约与重试（3 个）**：

| 键 | 默认 | 说明 |
|---|---|---|
| `leaseTtlMinutes` | `10` | 租约时长（多进程防双跑） |
| `leaseHeartbeatSeconds` | `60` | 跑票期间续租间隔（秒），必须显著小于租约时长 |
| `maxAttempts` | `2` | 可重试错误的自动重试上限 |

**执行（7 个）**：

| 键 | 默认 | 说明 |
|---|---|---|
| `workExecutor` | `mock` | **只能是** `mock`（离线验证）或 `agent`（真执行），写错（含大小写、尾空格）直接报 `invalid-input` 并列出可用值 —— **不再静默退回 mock**。agent 是真实现：起宿主 agent 改码 → 拍基线 → 收集 agent 改过的 → 跑验证（有 30 分钟超时与取消）→ 在工作区检出里做本地提交（`repo.gitlab.enabled: true` 时才额外开 draft MR） |
| `ticketTimeoutMinutes` | `40` | 单票执行超时，超时只通知不重试 |
| `isolateWorktree` | `false` | **改代码落点**。`false`（缺省）直接在项目工作区的检出里改代码、就地提交，**脏也能跑**（先拍只读基线，只提交 agent 真正改过的文件）；`true` 才每票 `git fetch` + `git worktree add` 开隔离 worktree |
| `keepSession` | `true` | **处理完保留会话**。agent 实例永远释放；`true` 时只记日志、会话留在项目工作区名下（可在会话列表点进去继续追问），`false` 才调宿主 `sessions` 服务回收 |
| `fetchBeforeCreate` | `true` | 切 worktree 前先 `git fetch` 一次基准分支（只有 `isolateWorktree: true` 时用得上；宿主 profile 现为 `false`，项目工作区已是最新检出时不必每次拉） |
| `branchPrefix` | `ticket-` | 工作分支前缀（只有 `isolateWorktree: true` 时用于票分支） |
| `worktreeRetentionHours` | `24` | 终态票的隔离 worktree 保留时长；0 = 不自动清理（只有开了 `isolateWorktree` 才有 worktree 可清） |

**回填工单表（2 个）**：

| 键 | 默认 | 说明 |
|---|---|---|
| `writeBack` | `true` | 票跑成 `done` / `skipped` 后回填工单表（写「是否处理」「处理结果」「处理日期」三列）。关掉就退化成只读。`failed` 的票一律不回填 |
| `writeBackStatus` | `是` | 回填时「是否处理」列写什么值；留空回落成「是」 |

**agent 与模型（4 个）**：

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | `workbuddy` | 跑任务书的模型 provider，留空则跟随当前会话默认 |
| `model` | ``（空） | 模型名，留空跟随会话默认（钉死模型会在它被限流时让整条流水线全灭） |
| `maxTokens` | `32000` | 单次模型调用的最大输出 token |
| `agentPreset` | `ptc` | agent 执行器给子 agent 挂的 preset id（决定它有哪些工具）。留空 = 不挂 |

**通知（11 个）**：

| 键 | 默认 | 说明 |
|---|---|---|
| `pushAdapter` | `pushplus` | 通知适配器 id，**只能是** `mock`（只记内存）/ `pushplus`（微信不直连，经 PushPlus 的 `clawbot` 渠道中继，需要 `pushplus.token`）/ `qqmail`（零依赖自写 SMTP，已真实发信成功，授权码走凭据 `QQMAIL_AUTH_CODE`）；写错直接报 `invalid-input` 并列出可用值 |
| `pushplus.token` | ``（空） | PushPlus token，建议走凭据 |
| `pushplus.channel` | `clawbot` | PushPlus 推送渠道，ClawBot 用 `clawbot` |
| `pushplus.template` | `txt` | 只能用 `txt`：富模板在 ClawBot 里只显示前 50 字 |
| `qqmail.host` | `smtp.qq.com` | QQ 邮箱 SMTP 主机（企业邮箱换成自己的） |
| `qqmail.port` | `465` | SMTP 端口：465 = TLS 直连（推荐），587 = STARTTLS |
| `qqmail.secure` | `true` | true = 连上就是 TLS（465）；false = 先明文 EHLO 再 STARTTLS（587） |
| `qqmail.user` | ``（空） | 发件邮箱地址，例如 someone@qq.com |
| `qqmail.to` | ``（空） | 收件邮箱；多个用逗号分隔 |
| `pushplus.callbackUrl` | ``（空） | 送达回执地址（可选）。PushPlus 把 sendStatus 回吐到这里；HTTP 200 只代表受理，不代表送达 |
| `notifyOn` | done/skipped/failed/needs-info | 哪些阶段发通知 |

**杂项（2 个）**：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关。配好一切前**别开** |
| `logLevel` | `info` | 日志级别：debug / info / warn / error。**当前是死配置，改了不生效**（见 `feature-checklist.md` §9.2 第 14 条） |

**projects[] 每项**：

> 飞书的工单表可以是**多维表格**也可以是**电子表格**，插件自己判断，你不用填表型。
> 电子表格这套键**设计待实施**（见 `docs/ticket-pipeline/feishu-sheet-source.md`）。

| 键 | 说明 |
|---|---|
| `name` | 项目唯一标识（分支名里会出现：`ticket-pms-xxx-r1`） |
| `match.platform` | `feishu` / `wps` / `mock` / `webform` |
| `match.appToken` + `match.tableId` | 飞书表显式绑定（推荐）。`tableId` 可在面板里改；**`appToken` 只能手改 `cordis.patch.yml`**（面板上是只读状态行，因为它含明文密钥、宿主不下发给浏览器，见 §3.0.1）。`appToken` 也可以直接写整条飞书表格 URL：插件从 `/base/<token>` 取 app_token、从 `?table=` 取 table_id，于是**只贴一条链接就能定位到表**，不用再单独填 `tableId` |
| `match.docNamePattern` | 兜底：按文件名模糊搜（飞书） |
| `match.spreadsheetToken` | 飞书**电子表格** token（`shtcn…`）。和多维表格的 `appToken` 二选一；配了插件就按电子表格处理（**该能力设计待实施**） |
| `match.sheetId` / `match.sheetName` | 电子表格里**工作表**的 id 或名字（二选一），跟 `spreadsheetToken` 配套。`match.sheetName` 与金山源共用同一个键 |
| `match.sheetHeaderRow` | 表头在第几行，默认 `1` |
| `match.sheetIdentity` | 行身份来源：`seq`（默认，取序号列的值）/ `row`（取物理行号） |
| `match.sheetIdColumn` | 序号列的表头文字，默认「序号」 |
| `match.sheetColumns` | 列名覆盖，如 `{"description":"缺陷描述"}` |
| `match.sheetRange` | 限定读取范围，如 `A1:M500`（大表用；读值接口无分页、单次上限 10 MB） |
| `match.tableKind` | 逃生阀：`bitable` / `sheet`。**一般不用填**，留空 = 插件自己判断表型 |
| `match.statusValues` | 可配：状态列里哪些取值算「在处理中」（收票条件）。不填则用默认值 `处理中` |
| `match.recordIds` | 可配：只处理这几条工单（收窄开关）。不填 = 整张表 |
| `repo.path` | 本地 git 检出根目录（**必填**）；**同时就是这个项目的工作区目录** —— 插件会确保它在 DSH 的 Workspace 列表里有一份登记（已登记则复用，没有则补一条；一个项目一条，多张票共用）。目录必须**已经存在**，插件不会替你克隆；不存在时这张票以 `invalid-input` 失败并说明该改哪个配置 |
| `repo.remote` | **GitLab 仓库地址**（不是 git 远端名）。**只有** `repo.gitlab.enabled: true` 要走远程 draft MR 时才用得上；本阶段（只做本地提交）留空即可。设置页里这一格的标签写的是「远端名」，**别被名字带偏去填 `origin`** —— 插件拿它推 `baseUrl` + `projectId` |
| `repo.gitlab.enabled` | 远程 MR 出口总开关，**缺省 `false`**。false 时执行器完全不需要 `GITLAB_TOKEN`、不发任何 GitLab 请求，只做本地提交 |
| `repo.baseBranch` | 建隔离 worktree 用的基准分支（只有 `isolateWorktree: true` 时用到）。**建议显式填**；不填则自动识别（`origin/HEAD` → 当前分支 → 最后才猜 `main`）。仓库主分支不叫 main 时（如 `v2.x`）不填也能跑，但 `pipeline_doctor` 会提醒你补上。设置页里这个框带**候选下拉**（列出该检出里真实存在的分支，顺序是当前分支 → 远端默认 → 本地 → 其余远端），写错分支名这类错从「运行时炸」变成「选项里根本没有」；分支列不出来（`repo.path` 还没填、不是 git 检出）时仍可直接手打 |
| `verify.build` / `verify.test` | 验证命令；**不填则跳过验证直接做本地提交**（验证结论记为「未跑成」并写进通知） |

---

## 4. 首次运行（强烈建议先走这一步）

### 4.1 mock 首跑：验证半程链路

保持 `workExecutor: "mock"`、`pushAdapter: "mock"`，开 `enabled: true`。

在工单表里新建一行：问题描述写「测试：请忽略」，「是否处理」填 `处理中`。

等一个轮询周期（≤3 分钟）后，在 DSH 对话里问插件：

```
pipeline_status
```

预期：能看到一张 `pending → worktree-ready → planning → done` 的票，`pipeline_status` 里带一行 `本地提交：mock…`。
mock 执行器不碰真代码，但**扫描、定位、确定改代码落点、状态机、通知全链路都已走通**。

### 4.2 五个对话工具

| 工具 | 干什么 |
|---|---|
| `pipeline_scan` | 立即扫一次工单表（不等轮询） |
| `pipeline_status` | 看所有票的当前阶段、本地提交（sha + 分支）、处理会话、回填结果与最近错误 |
| `pipeline_cancel` | 取消正在跑的那张票 |
| `pipeline_reset` | 把一张终态票（failed/gone 等）重置回 pending 重跑 |
| `pipeline_doctor` | 体检：git 链路 / 各项目仓库路径与 remote / 凭据 / 执行器与通知 / **插件是不是最新**，结论按「必须修复」「提醒」分段 |

### 4.3 切换真执行

半程验证通过后：

1. `workExecutor` 改为 `"agent"`
2. `pushAdapter` 改为 `"qqmail"`（并填 `qqmail.user`/`qqmail.to`）
3. 确认 `QQMAIL_AUTH_CODE` 已配（**不需要** `GITLAB_TOKEN` —— 除非你另外打开了 `repo.gitlab.enabled: true`）
4. `enabled` 保持 `true`，重新拨一张工单

---

## 5. 日常使用循环

```
你：在飞书表填一行「问题描述/操作流程/模块/截图」，是否处理=处理中
插件（≤3 分钟内）：收票 → 确保项目工作区 → 确定改代码落点（缺省就在检出里，`isolateWorktree: true` 才开隔离 worktree）→ 拍只读基线 → AI 改码 → 构建+测试 → 在工作区检出里做本地提交（只提交 agent 改过的）→ 回填工单表三列
你：收到邮件通知（含本地提交 sha + 分支 + 失败原因 + 工作区路径）
你：在检出里 `git show <sha>` review → 满意就合到你自己的分支（表格已经自己回填好了，不用再动手）；想接着问就点进那个处理会话
```

### 5.1 通知里能读到什么

| 阶段 | 通知内容 |
|---|---|
| done | 本地提交的 sha（前 12 位）与分支、工作区路径、改动文件、测试结果 |
| failed | 失败原因（具体错误）、工作区保留路径（去现场看）。**这种票不会回填表格**，留在「处理中」是刻意留的信号 |
| needs-info | 缺什么（常见：截图取不到，需要人补图） |
| skipped | 改动已提交到工作区，但验证没跑通，请人工确认 |

> 表格的「处理结果」列会写一段结构化正文：首句（done 是「已按工单改完并提交。」，skipped 是「已按工单改完并提交，但验证没跑通，需要人工确认。」）、改动文件清单（最多 8 个）、验证结论、`本地提交：<sha12> @ <分支>（<路径>）`、可选的 draft MR、`处理会话：<sessionId>`，最后一句「要进一步修改，把这个单元格清空、把「是否处理」拨回「处理中」即可重跑。」

### 5.2 出问题怎么办

| 现象 | 处理 |
|---|---|
| 票卡住 / 改错了想重来 | `pipeline_reset`，或把工单「是否处理」拨走再拨回 |
| 票正在跑想停 | `pipeline_cancel` |
| 长时间没动静 | `pipeline_status` 看阶段；超 40 分钟是单票超时，会自动通知你。验证命令另有自己的超时（缺省 30 分钟，宿主 shell 的 `maxTimeoutMs` 缺省 10 分钟会夹下去），超时会按「检查未通过（退出码 124）」记 |
| 截图没进 prompt | 票会进 needs-info 并通知；补图后拨回重跑 |
| 想看改动细节 | 通知里的工作区路径保留 24 小时，直接 `git show <sha>` 看那个本地提交 |
| 表格没回填 / 显示「回填表格：没写成」 | 多半是飞书应用只有**读**权限（`code 91403 Forbidden`）。把应用加成可编辑协作者，或在面板里关掉 `writeBack` |
| 想接着问那一轮的处理细节 | `pipeline_status` 里每票有 `处理会话：<sessionId>`，到会话列表里点进去继续问（`keepSession` 缺省是 true） |
| **不知道哪里有问题 / 卡在哪一站** | `pipeline_status` 的「流程日志」时间线（见 §5.2.1） |

#### 5.2.1 流程日志（关键节点时间线）：一眼看出卡在哪

用户最常问的是「票到底走到哪了、为什么不动了」。插件把整条链路的**关键节点**逐条记在票据的 `timeline` 字段上，`pipeline_status` 把它们排成时间线给你看。每一条长这样：

```
11-06 20:14:58  ⑥ ✓ 跑验证 —— 开始跑验证命令（上一站 5 秒）
  ▶ 现在停在第 ⑥ 站「跑验证」，已 3 分 25 秒没动。时间一直不涨就是卡在这一站里（日志只在站点切换时打点）。
```

**怎么读**：

- **9 个主站**（编号 ①–⑨）正对上一条工单的一生：①获取工单 → ②查找对应工单的项目 → ③检查工作区 → ④创建会话（分支+模型）→ ⑤处理工单问题 → ⑥跑验证 → ⑦提交（本地提交 / PR）→ ⑧回填工单表 → ⑨发送消息。另有几个 `·` 补充站（工作区就绪、规划改动、排队中、等你补充信息、已完成、已提交但验证没跑通、失败、表格里已删除），不占站号、只补细节。
- **✓ / ✗**：`✓` 这一站做成了，`✗` 没做成。超时、被取消、可重试退避、不可重试失败、截图取不到（needs-info）、租约被抢走都会记成 ✗，并把原因写进破折号后面那句中文补充里。别只盯着 `phase`，往上看时间线里的 ✗ 那行就知道是哪一步出的问题。
- **「现在停在第 N 站，已 X 分 Y 秒没动」**：这是回答「卡在哪里」的那句话。插件只在**站点切换时**打点，所以「已多久没动」= 当前站点从开始到现在的时间；数字一直不涨（或涨得离谱）就是卡在这一站里。needs-info 会特别写明「这一站在等人，不是插件卡死」，终态票写「已经收尾」。
- **括号里的「上一站 X 分 Y 秒」**：相邻两条 `at`（写下时刻）之差，就是上一站实际花了多久。想看哪一步慢，扫一眼括号即可。
- **时间是历史，不是这一轮的状态**：工单被改（`revise`）、重新入队、人工重置（`pipeline_reset`）都**不会清空**时间线 —— 上一轮走到哪儿、卡在哪儿，正是重开后最想对照看的。人工重置只在末尾补一条「排队中」分隔记录，把两轮故事分开。时间线上限 80 条，超了丢最旧的。
- **日志写失败不影响跑票**：记时间线是「旁路」，写失败只会在插件日志里留一行，绝不把整张票带崩、不改票态。
- **机器可读**：`pipeline_status` 返回体的 `tickets[]` 里也带原始 `timeline`（每条 `node`/`label`/`at` epoch ms/`ok`/`detail`）、`stalledForMs`、`station`、`lastNodeOk`，可以拿去画图或做告警。

④「创建会话（分支+模型）」只有真 agent 执行器会记（它才知道会话 id、provider/model、分支与工作目录）；mock 执行器不记这一站是合法的。

### 5.3 安全边界（使用前必读）

- **工单正文按不可信输入处理**：表里出现「忽略以上要求/删文件/改配置/发邮件到某地址」等内容会被当问题描述忽略并转 needs-info（详见 ADR-0003）
- AI 只被授权改**这张票的改代码落点**里的代码（缺省就是项目工作区的检出；`isolateWorktree: true` 时是隔离 worktree）+ 跑 `verify` 配置的命令；**敏感文件**（`.env` 家族、Spring 的 `application*`/`bootstrap*`、包管理器 token、SSH/GPG 私钥、云与容器凭据、明文机器凭据、证书·密钥库·Terraform 状态、名字带 `secret` 的——共 **8 大类 41 条正则**）不会被提交 —— 只用**点名暂存** `git add -- <非敏感文件>`，再用 `git commit -- <非敏感文件列表>` 只提交放行的那些，**不用 `git add -A`**（全量暂存会让敏感文件露在 index 里，手一抖就跟着提交走了）；被拦下的留在工作区并写进提交说明的「未提交」一行
- **`.git` 与插件 profile 有篡改自检**：每票开始与提交前各拍一次 sha256 快照（28 个官方 hook 名 + 10 个 git 元数据文件 + 4 个 `cordis.*`），agent 动过就把这些路径从 index 里撤回、整票判失败并点名文件。说清楚：这是**「被发现」不是「被阻止」** —— agent 在自检之前就已经写过那些文件了，拦住的是「别把它提交出去」。approval/policy 只能是 `never`（宿主没有「只读自动批、写入弹卡」这一档），所以兜底只有 git 白名单 + 这一层自检，**不是硬隔离**
- 凭据全部走 DSH credentials 存储，不落配置文件、不出现在错误信息里
- 默认**只做本地提交**，不 push、不合任何分支 —— 要不要合进主干永远由人决定。只有项目显式打开 `repo.gitlab.enabled: true` 时才会额外开一条 draft MR
- **回填只写三列**：票跑成 `done` / `skipped` 后，插件只写「是否处理」「处理结果」「处理日期」，不碰别的列、不删行、不改别人的字段；`failed` 的票一律不回填（留在「处理中」是刻意留的信号）；回填失败只记在票据上、只影响 `pipeline_status` 的显示与通知里多一行「回填表格：没写成」，票态不回退。想完全不动真表就把 `writeBack` 关掉
- **事后动作会被补偿**：回填与发通知跟终态是同一次落库的（`pendingEffects`），做完一项清一项；宿主中途重启，下次启动会把残留终态票没做完的补上，`pipeline_status` 里能看到「待补」
- **插件里的 `git` 与 `verify` 命令以完整文件系统权限执行**。这不是疏忽，是宿主沙箱的硬约束：
  插件不是会话，调宿主 shell 时拿不到会话的写入授权，不显式声明 `danger-full-access` 就写不了
  `.git`（连 `git fetch` 都会 `Permission denied`）。所以这条旁路**只给 git 和 verify 用**，
  不用于执行工单正文里出现的任何命令。代价是你需要知道：跑票期间这两个子进程能写你的整台机器。
  详见 `docs/ticket-pipeline/architecture.md` §12.1

---

## 6. 验证安装是否正常

| 检查 | 命令/动作 | 预期 |
|---|---|---|
| 离线自测 | `node scripts/dev-run.mjs`（开发目录） | **378 项全过**，exit 0 |
| 接线冒烟 | `node scripts/chain-smoke.mjs` | 11 项全过 |
| 插件加载 | 重启 DSH 后对话里说 `pipeline_status` | 工具能响应（enabled=false 时也会答） |
| 真扫表 | 配好凭据后说 `pipeline_scan` | 返回 created/updated/disappeared 计数 |
| 启动日志 | 看 DSH 启动输出 | 无 `did not activate ticket-pipeline` 警告 |
| 设置页 | Plugins → 工单流水线 → 该行的「配置」 | 打开是一整页，顶部四个页签：**项目 / 参数 / 凭据 / 体检**，一次只显示一页。项目页 = 项目清单（可增删、可编辑，21 个字段）；参数页 = **33 个字段 / 7 个分组**（不常动的收在组内「高级设置」里）；凭据页 = 5 个凭据（填好点顶部「保存」一起提交）；体检页 = 环境体检报告 |
| 设置页体检 | 切到「体检」页签，点「立即体检」 | 出「【环境体检】…」报告，与对话里 `pipeline_doctor` 结论一致 |
| 设置页保存 | 改任一字段 → 保存 | 提示「已保存」；重启后值还在 |
| 浏览器端一致性 | `node scripts/client-check.mjs`（开发目录） | `✅ client-check 通过` |
| 浏览器端冒烟 | `node scripts/client-smoke.mjs`（开发目录） | `✅ client-smoke 通过` |

> **排查：看到 `cannot get property "X" without inject`？**
> 两种成因，处理方式不同：
>
> 1. **宿主侧硬依赖没声明**（例如缺 `'timer'`）：`src/index.js` 的 `inject` 数组必须覆盖
>    `ctx.interval` 等全部硬依赖；漏了会出现 `did not activate ticket-pipeline`。
> 2. **客户端侧命名空间服务用属性访问**：宿主给的 `settings` / `credentials` / `ticketPipeline`
>    命名空间服务是**兄弟 fiber** 上的独立服务（服务名 `remote.<ns>`），不是 `remote` 对象的属性。
>    属性访问沿 fiber 链**向上**找 provide，兄弟不是祖先 ⇒ 抛这个错 ⇒ 配置页被错误边界接住，
>    **整页空白、控制台只有一行看不懂的报错**。正确写法是一律 `ctx.get('remote.<ns>')`
>    （查全局服务 store，不查 inject、不沿 fiber 链）。
>
> 另外：命名空间服务**不要写进 `inject`** —— 我们自己的 `ticketPipeline` 是用 `remote.$mount()`
> 建的，写进 inject 等于等自己把它建出来，fiber 永远不激活、配置页静默全空。
>
> 自检：`node scripts/client-smoke.mjs` 的假宿主照抄了真实 cordis 的服务模型
> （`ctx.get('remote.<ns>')` 取得到、属性式 `ctx.remote.<ns>` 取不到），退回坏写法会当场红。

> 注意：`scripts/` 不进安装包（发布白名单只含 src/lib/locale/icon/patch），
> 自测命令要在**开发目录** `D:/WorkSpace/dsh-ticket-pipeline/plugins/ticket-pipeline` 下跑。
>
> `client-check` 守的是「浏览器 bundle 只能手抄一份宿主侧描述符」这条约束：
> 改了 `src/remote/descriptors.js` 忘了改 `lib/client.js`，表现是**点体检没反应、宿主也不报错**，
> 所以发版前必跑。

---

## 7. 常见问题（FAQ）

**Q：为什么我配了凭据还是报 auth 错？**
飞书文档授权必须人工把应用加为表格协作者（§1.2）；空字符串凭据会被当成「没配」。

**Q：我的飞书工单表是「电子表格」不是「多维表格」，能扫到吗？**
当前**还不能** —— 插件的飞书源目前只支持多维表格，电子表格会在探测阶段被判成「不是多维表格」并报错
（这是代码路径限制，不是权限问题，别去反复申请权限）。电子表格支持**设计已定、尚未实施**，
方案见 `docs/ticket-pipeline/feishu-sheet-source.md`。届时你只要填电子表格的 token，
插件会自己判断表型，不用你选。

**Q：电子表格没有 `record_id`，插件怎么认出「还是那张票」？**
靠**序号列**（默认取表头叫「序号」的那一列）。人在表格上方**插行**会让所有后续行的行号整体漂移，
所以请**不要在工单上方插行**，也不要重填序号；序号留空时插件会兜底用物理行号，
但那张票在插行后会被判成新票。

**Q：改了表里的内容，为什么票没更新？**
只有「是否处理=处理中」的行会被跟踪修订；管理列（处理人/处理结果）的变化不触发。

**Q：一张票能同时被两个 DSH 进程处理吗？**
不能。租约机制保证单飞（`leaseTtlMinutes`），被抢走的进程会让出票并记 lastError。

**Q：AI 会直接动我的 main 分支吗？**
**缺省会。** 缺省模式（`isolateWorktree: false`）就在项目工作区的检出里改代码、就地提交，提交落在检出当前分支上 ——
如果那份检出停在 `main`，那就是 `main`。提交本身只是本地 commit，**插件从不 push、从不合并**；
你攒着的未提交改动也不会被混进来（插件动手前会拍一份只读基线，只提交 agent 真正改过的文件）。
想彻底隔离就打开 `isolateWorktree: true`：每票 `git fetch` + `git worktree add -b <branchPrefix>…` 开一个独立隔离目录。
不管哪种模式，最终产物都是这个检出里的一次**本地提交**：要不要合进主干、怎么合，由你决定。

**Q：同一个项目来两张工单，会在同一个目录里改代码吗？**
缺省模式**会** —— 两张票都改在同一份项目工作区检出里（调度单飞、一轮只跑一票，所以不会同时改；
检出脏也没关系，各自的提交只带 agent 自己改过的文件）。
打开 `isolateWorktree: true` 时才会各自开一个隔离 worktree 与独立分支。
会话都归属到同一个工作区下，在 GUI 里能一起看到。

**Q：报「项目工作区目录不存在：…」怎么办？**
`projects[].repo.path` 指向的目录不存在。插件不会替你克隆仓库（宿主的 Workspace 登记也要求
目录已存在），请先把仓库检出到那个位置，或把配置改成一个真实的检出目录。

**Q：报「会话的 cwd 是项目工作区根，需要把工作目录钉到 worktree，但本机没有 workingDirectory 服务」怎么办？**
只在 `isolateWorktree: true`（每票一个隔离 worktree）时才会撞到这个：那时插件要把 agent 的会话目录从
工作区根钉到隔离子目录，宿主缺 `workingDirectory` 服务就做不到，插件宁可让这张票失败也不会在错的地方改代码。
两条出路：装齐宿主服务（桌面版自带，裁剪过的 profile 可能没有）；或者关掉 `isolateWorktree`，
缺省模式 `worktreePath` 就等于工作区根、两者一致，**根本不需要这个服务**。

**Q：报 `git fetch 失败：couldn't find remote ref main` 怎么办？**
你的仓库主分支不叫 `main`。插件会自动识别（`origin/HEAD` → 当前分支），但显式写上更稳：
在项目配置里加 `repo.baseBranch: "v2.x"`（换成你的真实分支名）。跑 `pipeline_doctor` 能看到它实际用的分支。

**Q：报 `git fetch 失败：cannot open '.git/FETCH_HEAD': Permission denied` 怎么办？**
这是旧版本的行为（插件没给 shell 带沙箱策略，拿不到写授权）。更新到最新版即可；
若仍出现，确认安装副本已同步、且宿主**完全重启**过（页面刷新不算，模块有进程内缓存）。

**Q：`pipeline_status` 报 `value is not lossless JSON` 怎么办？**
同样是旧版本的 bug（工具输出里残留 `undefined`，宿主判整次调用失败）。最新版已在
`defineTool` 层统一剥掉 `undefined`，更新并重启即可。

**Q：插件页里那一行没有「配置」按钮？**
「配置」按钮只在这一行注册了 `plugins.row.config`（key 为 `@local/ticket-pipeline#ticket-pipeline`）
且 `package.json` 声明了 `dsh.client.platform: "web"` 时出现。装的是旧副本（安装目录里的
`lib/client.js` 不存在）就看不到 —— 重装插件并**完全重启宿主**（刷新页面不算）。

**Q：设置页空白 / 打开是「暂无配置项」？**
说明宿主的设置服务没把本插件列为可配 —— `src/core/config.js` 里 `Config` 上那棵 schema
descriptor 没挂上，或字段没标 `meta.volatile`。宿主对这种情况是**静默跳过**（不报错）。
自检：`node scripts/client-check.mjs` 会核对 descriptor 与分组表是否对齐。

**Q：在设置页填了 QQ 邮箱授权码，为什么配置里看不到？**
凭据从不回写配置文件、也不回传明文，界面只显示「已配置」。真要核对，看「立即体检」的
凭据段（`QQMAIL_AUTH_CODE` 不在体检清单里，体检只查 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` /
`GITLAB_TOKEN`）；发信失败时看通知日志里的错误码。

**Q：配置是手动填 JSON 吗？我没找到 `enabled` / `workExecutor` / `projects` 该写在哪。**
不用填 JSON，也**不需要**手写配置文件 —— 常规做法是在设置面板里点着改（§3.0）。
面板里的「配置」是 33 个字段 / 7 个分组，「项目清单」是每个项目 5 个分区 21 个字段，
`enabled`、`workExecutor`、`pushAdapter`、`projects[].repo.*` 这些都有对应的输入控件，
§3.0.1 有一张「JSON 键 → 面板哪一格」的对照表。

**唯一的例外是 `projects[].match.appToken`**（飞书多维表格的 app_token）：它含明文密钥，
宿主只下发「已配置 / 前 4…后 4」，面板上是**只读状态行、没有输入框** ——
要改它只能手改 profile 的 `cordis.patch.yml`，改完重启宿主。

手改配置文件也行，但注意那是 **YAML 不是 JSON**，且要落在 `- id: ticket-pipeline` 的
`config:` 下面（§3.0 给了可直接抄的 YAML 片段）。手改完**必须重启宿主**才生效。

**Q：处理完表格会自己回填吗？**
会。票跑成 `done` / `skipped` 之后，插件会回填三列：「是否处理」（值由 `writeBackStatus` 决定，缺省 `是`）、
「处理结果」（结构化正文：首句结论 + 改动文件 + 验证结论 + 本地提交 sha/分支/路径 + 处理会话 id + 重跑提示）、
「处理日期」。`failed` 的票**不回填** —— 留在「处理中」是刻意留给你的信号。
不想让它动真表就把 `writeBack` 关掉；飞书应用只有读权限时写回会失败（`code 91403 Forbidden`），
票仍然是 `done`，只是 `pipeline_status` 里那行显示「回填表格：没写成 —— …」。
决策记录见 [`docs/adr/0006-处理完回填工单表.md`](../adr/0006-处理完回填工单表.md)。

**Q：处理完那次会话去哪了？**
它留在项目工作区名下，没被回收。`pipeline_status` 里每票都有一行 `处理会话：<sessionId>`，
到会话列表里点进去就能接着问（上下文还在）。注意 agent **实例**是每次都释放的，
留下的是会话本身。不想保留就把 `keepSession` 设成 `false`，那时插件会主动调宿主 `sessions` 服务回收。

**Q：工作区里有未提交改动，还能跑票吗？**
能。缺省模式不再要求检出干净：插件会在 agent 动手**之前**用 `git stash create` 拍一份只读基线
（只造一个 commit 对象，不写 ref、不动工作区、不动索引，拍完 `git stash list` 仍然是空的），
结束后只提交 agent 真正改过的文件。你攒着的未提交改动、甚至已经 `git add` 进索引的改动，都会原样留在工作区。
`pipeline_doctor` 看到检出不干净只提醒一句，不算必须修复。

**Q：验证命令卡住会不会把整条流水线挂死？**
不会了。验证命令有超时与取消：缺省 `VERIFY_TIMEOUT_MS` 是 30 分钟，到点按「检查未通过」记（退出码 **124**，和普通非 0 区分），
`pipeline_cancel` 会真 kill 子进程。注意宿主 `dsh-bash-local` 自己的 `maxTimeoutMs` 缺省 10 分钟，
两者取小 —— 真实上限是 10 分钟，要放宽得改 profile 里 `dsh-bash-local` 的配置。
修之前这里确实会挂死：`runOne` 不返回 → 内存里 `running` 恒为 true → 后面每一轮都判 `already-running`，静默停摆。

**Q：我把 `workExecutor` 写成 `Agent`（大写）会怎样？**
直接报 `invalid-input` 并列出可用值（`agent` / `mock`），不会再静默退回 mock 假装跑了一轮。
`pushAdapter` 同理（`mock` / `pushplus` / `qqmail`）。只有留空 / 不填时才回落 mock。

**Q：`GITLAB_TOKEN` 还要不要配？**
本阶段**不用配**，交付形态是项目工作区检出里的一次本地提交。缺省下执行器完全不碰 `GITLAB_TOKEN`、
不发任何 GitLab 请求；`pipeline_doctor` 没看到它也只说一句
`ℹ️ 凭据 GITLAB_TOKEN：未配置（本阶段不需要）`，**不进 warnings**。
只有项目显式写了 `repo.gitlab.enabled: true` 并配了 `repo.remote`，才会走原来的 GitLab Commits API
开一条 draft MR —— 那时才需要这个 token。

**Q：在设置页改了配置，为什么行为没立刻变？**
本插件 `~standard.vendor` 不是 `schemastery`，loader 判定为「整对象换掉」而非按 volatile 字段热更，
所以保存后插件会重新加载一次。跑票中途保存不影响已经发出的那次 tick。

**Q：怎么知道插件跑的是不是最新代码？**
跑一次 `pipeline_doctor`（或设置页点「立即体检」），看最后一行：

| 输出 | 含义 |
|---|---|
| `✅ 插件版本：安装副本与源码一致（共比 N 个文件，指纹 xxx）` | 最新，不用管 |
| `✅ 插件版本：安装目录就是源码（…）` | 从源码目录直接跑（`link:` 安装），本来就没有副本要同步 |
| `⚠️ 插件不是最新：…（N 个文件内容不同，副本缺 N 个，副本多 N 个）` | **正在跑旧代码**，改动没生效；报告里直接给出同步命令 |
| `ℹ️ 插件版本：无法比对（<原因>）` | profile 里没找到本包的 `file:` / `link:` 声明，或源码目录不在原位 |

这条只进「提醒」不进「必须修复」：旧版插件照样能把票跑完，只是行为不是你刚改的那份。
比的是**文件内容**（`src/**/*.js`、`lib/**/*.js`、`cordis.patch.yml`、`icon.svg`、`locale/*.json`），
不看 `package.json` 的 `version` —— 源码和副本的版本号本来就一样，也比不出新旧。

**Q：改了插件代码，怎么让宿主跑上新代码？**
三件事，少一件都不生效：

1. **把源码同步到安装副本**（改的是 `D:/WorkSpace/dsh-ticket-pipeline/plugins/ticket-pipeline`，
   宿主加载的是 `~/.dsh/profiles/desktop/node_modules/@local/ticket-pipeline`）。
   `file:` 依赖是**跨盘复制**，不是软链；`pnpm install` 会说 `Already up to date` 而什么都不刷，别指望它。
2. **让宿主重新加载**（重启宿主最稳；HMR 的 `root` 是空的，不监听源码目录，不会自己发现）。
3. 如果改的是 `lib/client.js`（浏览器端），**还要刷新页面** —— 那一侧走独立的加载机制。

同步完再跑一次 `pipeline_doctor`，看到 `✅ 插件版本：安装副本与源码一致` 就是真生效了。

---

*手册对应版本：v0.1.0-test.1（2026-11-04）。配置项与代码逐一核对过；
若后续版本调整键名，以 `src/core/config.js` 的内联注释为准。*
