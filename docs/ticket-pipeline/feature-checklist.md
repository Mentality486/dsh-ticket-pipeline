# 工单流水线插件 · 功能清单与完成度

> 生成日期：2026-11-05
> 代码基线：工作区 `D:\WorkSpace\dsh-ticket-pipeline`；本轮「40 分钟改一个小功能 + 通知换掉付费第三方」的代码与本文同一次提交，上一轮已提交代码为 `fdf8895`（图片块字段名改成 `attachment`）；插件目录 `plugins/ticket-pipeline`
> 最近一次更新：2026-11-16，**「修复说明的不足」** —— 用户原话「修复说明的不足」，指的是前一天
> 我向他列的「八条优势 + 五条不足」里站不住的地方。查出两处，一处是**错的**、一处是**缺守卫**：
> ①`pipeline_doctor` 对任何 `platform: 'wps'` 的项目都报**阻断**，理由写的是「取数通道是注入式的，
> 主装配没注入」—— 这句是错的，`wpsOptionsFromMatch()` 明明有「配了 `match.sheetUrl` 就装内置下载器」
> 那一档，真正的 `MISSING_FETCH_SHEET` 只发生在「选了 wps、没填链接、也没人注入」这一种配置上。
> 体检改成按「有没有内置通道」分档（没链接 → `blockers`；有链接 → `warnings` 说清「共享链接常需登录态」）。
> ②面板 ↔ Remote/DOM 的边界已连撞三次（`reset` 少传实参、`scan` 少传实参、`loadProjects` 把 click 事件
> 当 namespace），前两次靠 `checkCallArities` 兜住，第三次纯靠「记住这个坑」。现在补了第二条静态守卫
> `checkEventArgConfusion`：先用 `findMatchingBrace` 切出组件函数体、找出「把 `props.Y` 直接挂在 DOM
> 事件属性上」的地方，再看外层 `h(组件, { Y: 裸标识符 })` 里那个函数有没有声明形参 —— 两条同时成立即 fail。
> 判据刻意不维护名单，而且**写成 `onReload: function () { loadProjects() }` 就命中不了**，所以它也在指导写法。
> 实跑抓到 2 处并已改成包一层；函数内部那两个类型判断保留为兜底（兜底不是入口）。
> 两条守卫都做了回归测试，确认真的会红（`client-check` exit 1 并精确指到 `lib/client.js:4917`），
> `client-smoke` 另加一条运行时断言：真拿一个事件对象去点「重新读取」，不许出现那句冤枉话。
> **教训：「说明」也是要被核对的代码** —— 那次核对 16 条说法，15 条成立、1 条是自曝不足，
> 而错掉的那条已经写进了 `pipeline_doctor` 的输出，会主动误导人去改一个没坏的配置。
> 见 §1.49。`dev-run` **577/577**、`client-smoke` **280** 条。
> 同日更晚：**探索预算 12 次在 100% 的票上都响过，但「按需求分级」被数据否掉** ——
> 8 个会话拟合下来，票的静态特征对探索量没有预测力（`flowLen` 0.038 / `segs` 0.019），
> 同一张票跑两次差 3–4 倍。真正能预测的是**重复**（重复率 0.817），所以口径从「调用次数」
> 换成「不同目标数」、阈值 12 → **25**（首写前不同目标中位数 24），并支持按项目覆盖
> （仓库大小是稳定因素，票不是）。面板新增一格「探索预算」。见 §1.50。
> `dev-run` **581/581**、`client-smoke` **282** 条。
> 次日（11-17）：**两套看门狗各发一条，排队里就成了两条长消息** —— 一条数动作数、一条数时间，
> 触发条件不同但说的是同一件事（别再读了、动手），于是在同一次唤醒里各发一条。现在两个判据只判、
> 投递统一收在主循环一处，一次唤醒最多一条；两条都成立时合成一条（不是拼接，是认出同一件事只说一遍）。
> 见 §1.52。`dev-run` **584/584**、`client-smoke` **282** 条。
>
> 同日再晚（11-17）：一张票跑出两条同名会话 —— 会话 id 原先只在收尾时写盘，
> 插件一重载就丢，下一轮只能新建。改成「拿到就落库」，见 §1.53。
> 同日第三轮（11-17）：「①✓②✓…」人看不懂、全打勾却标失败、失败原因是 3098 字原文。
> 站带改成中文短名（取单 / 定位 / 改代码 / 提交…）、失败回填到真正倒下的那一站、
> 错误给「为什么 + 怎么办」。顺带查清那条失败的真因是两件事：提交说明里的双引号被
> PowerShell 重新拆开、电子表格的「序号」列是公式被当成序号读了。见 §1.54。
> `dev-run` **624/624**、`client-smoke` **282** 条（其中 9 条来自同一工作区的另一路改动 ——
> 检出级互斥 / 同项目票史 / 归属修正，见 §1.55）。
> 同日更早：**新增项目时两格「列名覆盖」被写成 `"[object Object]"`，整笔保存被拒** ——
> `buildProjectValue()` 的通用分支是 `String(normalized)`，而 `projectRawValue()` 对 `kind === 'columns'`
> 已经解析成对象了。只有「新增项目」这条整对象通道会踩（已有项目走单字段通道），所以两格空着也报。
> 改成逐 kind 处理：对象非空才写，否则整格不写。见 §1.41 的再补记。
> 2026-11-13 傍晚，**「跑一轮」也炸在同一个地方** —— 用户原话「跑一轮失败」，
> 截图红字 `跑一轮失败: client api: ticketPipeline#ticketPipeline/scan expected 1 argument(s), got 0`。
> `scan` 加了可选 `projectId`（工单 #39）之后调用点还留着 `ns.scan()`，而浏览器侧
> `prepareInvocation` 是按 `descriptor.parameters.length` 数位置实参的，`acceptsUndefined` 只有宿主侧认
> —— 与 11-11 的「重跑」是**同一个机制换了个方法**。修法两件：调用点改成 `ns.scan(undefined)`；
> 并在 `scripts/client-check.mjs` 加**静态守卫 `checkCallArities`**，把 bundle 里每一处
> `<xxx>ns.<method>(…)` 的实参个数与描述符声明逐个比对，对不上直接 fail 并报出「期望几个、实际几个」。
> 守卫本身踩了两个坑并已写进 `architecture.md`：①扫之前要剥注释（否则把自己举的反例当违规）；
> ②剥注释必须单独识别正则字面量（`/projects["'\]\s]*(is not)/i` 这种体内带引号的写法会把状态机
> 带偏到文件末尾，于是**守卫把要守的东西遮住、回归测试显示全绿**）。见 §1.42。
> 同日更早：**新增项目还没保存就贴工单表链接，必然失败** ——
> 用户原话「我新增加一个项目加不进去」，截图里红字是 `没能写进去: 没有第 1 个项目（当前共 1 个）`。
> 病灶不在宿主：`FeishuTableLinkRow` 只按平台是飞书就画链接行，而紧挨着的「测这张表」
> 早就判了 `pending !== true`，**同一张卡片两个动作对「宿主里有没有它」口径不一致**；
> `onPasteLink` 把 `index = projList.length + q` 直接发给宿主，那个下标在 `config.projects` 里不存在。
> 改成：未保存时贴链接**只记草稿**（按钮变「记下这条链接」），保存成功、项目真建出来之后再按新下标
> 补写一次；补写失败只说「项目保存好了，但链接没写进去」，不把整次保存判成失败。
> **同日补记**：只记草稿还不够 —— 宿主对**整份配置**校验，那一笔里新项目的 `match` 若没有任何
> 定位依据会被整笔拒（用户当天下午贴回来的就是 `projects[1] … feishu 项目必须给①工单表链接/token…`），
> 于是「保存后再补写」永远等不到。现在链接**随那一笔一起**塞进 `match.appToken`（三种 URL 形态运行期
> 各自拆解，浏览器仍不解析），保存后的 `setProjectTable()` 退化成「归一成精确坐标」。
> `dev-run` **576/576**、`client-smoke` 228 → **276** 条。见 §1.41、§1.42、§1.44、§1.45、§1.46、§1.47、§1.48。
> [2026-11-13 晚] 用户又点「跑一轮」，这次报 `match.sheetName="PMS项目管理系统工单" 没匹配到任何工作表`：
> 那一格填的是浏览器上的**文档标题**，而它要的是**页签名字**（实际都叫 `Sheet1`）。
> 更该先修的是 `probe.js` 原来压根不看 `sheetName`（配了 `sheetId` 就用、否则 `sheets[0]`）
> ⇒ **体检全绿、扫票失败**。现在 `resolveWorksheet()` 加「名字等于文档标题且只有一张可见表」的降级档
> （多张就报错、不猜），探针改调同一个函数并落 `metadata.nameIssue` / `note`，doctor 与 `testProject` 据此判红。
> `dev-run` 557 → **562** → **569** → **576**（+5 会话标题、+7 工作区补登记与 git add 忽略路径、+6 同票重跑续接会话，见 §1.44、§1.45、§1.46）、`feishu-checks` **99**、`client-smoke` **276**。
> 2026-11-11 更晚，**运行页签三件事一起修** —— 用户原话
> 「运行页面的历史 重试报错 也删除不了 优化一下显示历史的ui和展现方式。项目页面的重新读取失败」。
> 三个互不相干的原因：①「重跑」每次都抛 `expected 2 argument(s), got 1` ——
> 浏览器侧 `prepareInvocation` 按 `parameters.length` 数个数，**`acceptsUndefined` 只有宿主侧认**，
> 面板只传了一个实参；②「重新读取」必报「宿主还没提供 projects()」—— `loadProjects` 的第一参被
> `onClick` 的 click 事件顶掉（**宿主一直是好的**，这句冤枉话把人指向完全错误的方向）；
> ③「删除不了」= 压根没有删除能力，三层补上 `store.forgetTicket` / 工具 `pipeline_forget` /
> Remote `forget` / 面板「删除记录」（只删本地记录，不动工单表与代码，且删完不会被下一轮重收）。
> 同时按用户要求重做历史屏：票按档位**分组**、每票第二行加**九站流程带**
> （`①– ②✓ ③✓ ④✓ ⑤✓（4 分 32 秒） …｜全程 13 分 53 秒`）。
> 基线：`dev-run` 512 → **517/517**、`client-smoke` **228**、`client-check` ✅（Remote **10** 方法）。
> 见 §1.38。
> 11-12 上午，**五项优化一起做完** —— 契机是 `sh-row-81` 在 11-11 17:09 第一次真正跑通
> （本地提交 `9829db89422e`，6 files +650/−36），有了成功样本才量得出该优化什么：
> 第一次写文件在**第 46 次调用、开始后 21.5 分钟**（read 109 / grep 50 / glob 10 vs edit 46），
> 而任务书里那句「探索预算 12 次」**没有任何计数器**；项目配的验证命令
> （`node scripts/check-consistency.mjs`，两秒跑完）**只有执行器知道**，agent 自己摸索跑了
> 12 次 mvn/npm；「操作流程」列只有 9 个字 `项目管理-首样测试` 却是整个定位策略的前提；
> 上一张票摸出来的文件线索**票一收尾就全丢**；`renderPlanRequest` 是零引用的死代码。
> 五项修法见 §1.39，自测 **517 → 530**。
> 同日深夜（二），**一张改小功能的票跑了 40 分钟、写了 0 个文件** ——
> `sh-row-81` 在 ⑤ 站整票硬超时失败。解会话日志才看清：39 分钟、63 次工具调用、
> 读了 23 个文件（平均每个读 2 次）、**写/改过的文件 0 个**，而 `session.seq` 全程都在涨。
> 两个独立的病：① 任务书 `## 代码定位` 只说「先读仓库结构」，**没说读到什么时候该动手**；
> ② 执行器「4. 等 agent 干完」只有一句 `await waitForAgentIdle(...)`，全文件
> `grep setTimeout|setInterval|progress|stall` 零命中 —— 卡在读文件和飞快改代码在它眼里一样。
> 修法：任务书加 `## 工作方式`（探索预算 **12 次**、先动手再补细节、同一类信息只查一次、
> 卡住就停）；`waitForAgentIdle` 加停滞看门狗，**进步信号只认工作区文件**
> （`git status --porcelain` 指纹）**不认 `session.seq`**，超 8 分钟没变就记时间线 + 催一句
> （最多 2 次，催了不杀，交给硬超时兜底）。同时把通知换成**飞书自建应用直发**
> （`push-feishu` 适配器）：PushPlus 的 ClawBot 要实名付费、回 `905`，而应用本来就带 IM 能力，
> `im/v1/messages` 真机已实发成功（`om_x100b600a…`），不经过任何第三方；
> `230013` 是「机器人可用范围里没这个人」，不是缺 scope。
> 基线：`dev-run` **504 → 508**（同日晚口径修正后 508 → 509 → 511 → **512/512**）、`chain-smoke` **11/11**、`client-smoke` **219**、`feishu-checks` **97**。
> 见 §1.32 与 §1.33；**同日晚这修法的一半被推翻，见 §1.34** —— 预算不能变成「交半成品」的许可。
> 同日再晚一些：`pipeline_status` 汇总说「交付未完成的 4 张，票态已经是完成」，
> 而明细里那 4 张**全是 `failed`** —— 汇总句断言了 `phase`，`deliveryIssues()` 却只读 `delivery`。
> 两类票要人做的事完全不同（done 补回填就行，failed 得 reset 重跑），改成分开数、分开说，
> 见 §1.36（自测 511 → 512，含反向断言 `doesNotMatch(/票态已经是完成/)`）。
> 同日上一轮，**带截图的工单在 ⑤ 站崩** —— pms 第一张真实工单 `sh-row-81`
> 带着一张附件截图，跑到 ⑤ 站直接失败：
> `Cannot read properties of undefined (reading 'attachmentId')`。
> 同批没截图的票一切正常，这正是它藏得久的原因。根因：内核 `src/core/prompt.js` 的 `renderTicketContent`
> 把图片引用放在自己起的 `image` 字段上，而宿主 `@deepseek-ai/dsh-llm` 的 `ImageBlock`
> 契约是 `{ type: 'image', attachment: ImageAttachmentRef }`，所有读图代码一律写 `block.attachment.attachmentId`
> （`collectImageRefs` / `imageIdentity` / `textOnlyImageText` / `llm-pi-ai` 的 `case "image"` / `llm-deepseek` 的 upload 校验）。
> 更要记的是：**自测把错误形状抄了进去** —— `dev-run` 与 `chain-smoke` 的断言照着实现写 `.image`，
> 两边自洽所以 498 条全绿，契约方从没被引用过一次；修完实现后那两条断言立刻变红，
> 说明它们并没有「测到」，只是「附和了」。修法：块改成 `attachment`，两条断言改成断言 `attachment` 并各加一条反向断言。
> 基线不变：`dev-run` **498/498**、`chain-smoke` **11/11**、`client-smoke` **219**、`feishu-checks` **97**。见 §1.31。
> 同日上一轮，**定位捷径不能跳过表型判定** —— 跑了一次 `pipeline_scan`，
> 一张新票都没进来，界面安静得像什么都没发生。查下去：现场配置同时有
> `appToken: It5g…`（裸 wiki token，背后是一张**电子表格**）、`tableId: tblWhRS…`（上一轮用
> 多维表格时留下的）与 `sheetId: 3a5d28`。适配器的 `resolveBitableTableByIdentity` 开头有一句
> `if (tableId) return { kind:'bitable', appToken, tableId }`，**一个请求都不打**就「定位成功」——
> 于是表型分派被 `tableId` 抢走、`shouldTrySheet()` 的降级路被堵死（降级只在**定位失败**时发生），
> 一路拖到 `resolveBitableColumns` 去问 `fields` 才炸 `1254003 WrongBaseToken`。
> 而**体检说「能读」**（探针问 `get_node` 的 `obj_type`，不认 `tableId`）—— 同一个毛病体检全绿、
> 真正跑票失败，报错还是一句后端黑话。修法两层：运行期配了 `tableId` 也先验一次 `tables`
> （真是多维表格只多一个请求；是电子表格就在这儿失败成 `invalid-input`，降级照常发生）；
> 配置期 `tableId` 与 `sheetId` 并存就出警告，说清「这是两种表型各自的坐标」并建议重贴链接。
> `dev-run` 495 → **498/498**、`feishu-checks` 96 → **97 条**。见 §1.30。
> 同日上一轮，**「凭据」页签填了 token 点保存，什么都没发生** —— 用户在凭据页填了
> `PUSHPLUS_TOKEN`，页签上挂着「未保存 1 项」，点顶部「保存」却回一句「没有需要保存的改动」，
> 两句话自相矛盾。根因在 `lib/client.js` 的 `onSave()`：它先算配置改动 `collectOps()`，
> **为空就直接 `return`**，而「写凭据」那一整段在这行 `return` 之后 —— 只填凭据、不动任何配置字段时，
> 凭据一个字节都没写进去，还替人宣布「没有需要保存的改动」。而保存按钮是亮的、页签计数也确实在涨
> （`credDirty` 算进去了），所以人只会以为保存坏了。现在把凭据写入**移到提前返回之前**，两条通道
> 互不阻塞（凭据失败只报凭据那条，配置照样存）；只提交凭据时不再说那句假话。`client-smoke`
> 215 → **219 条**（新增 4 条守着这个回归）。见 §1.29。
> 同日上一轮，**体检补上「状态值口径」这一层** —— 用户报「我使用电子表格
> 连接，环境体检不通过，获取不到飞书工单信息，只有使用多维表格才能获取到」。查下去是**两个独立
> 的毛病叠在一起**：① 体检探针按「`appToken` 非空」就认定是多维表格，而面板贴 `/wiki/<token>`
> 链接时宿主写进 `appToken` 的正是**裸 wiki token**（节点背后可能是电子表格）—— 于是探针拿它去问
> 多维表格接口，飞书回 `1254003 WrongBaseToken`，体检报红；而适配器本体走 `isWikiToken ⇒ probeWikiNode`
> 一直是好的，**扫票 73 张、体检却说读不到表**。② 真正「一张票都收不到」的原因根本不是表型，是
> **状态值对不上**：插件缺省只认「处理中」（`IN_PROGRESS_VALUE`），而这张表的「是否处理」实际填的是
> 「是 / 否」—— 实测同一张表 `statusValues: ['处理中']` 收 0 张、`['是']` 收 73 张。现在体检会采样
> 状态列的实际取值，一个都对不上时直接说「表里实际是『是』『否』，配置认『处理中』—— 这样一张票都
> 收不到」并给出修法；只进提醒、不进阻断（收不到票不等于流水线坏了）。`dev-run` 492 → **495/495**。
> 见 §1.28。
> 同日上一轮，**运行页签多了「显示历史」开关** —— 这一屏以前固定只列未收尾的票
> （`status()` 里写死 `includeDone: false`），票一跑完打开面板就是空的。用户原话是「在哪里能查到历史的
> 工单处理流程」：其实票据只增不删、历史一直都在，只是缺省不占这一屏。现在 `status(includeDone?)`
> 带一个可选参数，状态行右侧挂一个勾选，勾上就连已完成 / 已交付 / 失败 / 已删除的票一起列出来。
> 缺省仍然关着（反过来会让跑了一个月的库开屏渲染几百行），勾选状态记在 localStorage
> （重开面板又变空白会被读成「历史被删了」）。**只认严格的 `true`** —— 这个方法同时被当 `onClick`
> 处理器用（`onRefresh: loadRun`），那里第一参是事件对象。见 §1.27。
> `dev-run` 491 → **492/492**、`client-smoke` 208 → **215** 条。
> 同日上一轮，**定位工单表只剩一个入口** —— 项目卡片以前同时有「工单表」组、
> 「飞书电子表格」组和卡片头上的「工单表链接」行，三处都能指定「表是哪张」，人填了两三处也判断不了
> 哪个生效（实际生效的是 `resolveTable()` 的判定顺序，那东西不在配置里）。现在只留「工单表链接」：
> 把浏览器地址整条贴进去，插件自己认多维表格 / 电子表格 / 知识库里的表。同时修掉「电子表格取不到工单」
> —— `extractSheetToken` 不认 `/wiki/<token>`，整条 wiki 链接被原样拼进接口、飞书回 404；
> 另补齐错误码 `1254003 WrongBaseToken` 归入「类型不对」，否则只贴裸 token 的电子表格永远走不到
> 电子表格分支。`validateProject` 相应放宽（不再要求 token 必须配 tableId/sheetId），两套 token 并存
> 从「静默放行」改成「警告另一套不起作用」。见 §1.26。
> `feishu-checks` 80 → **96** 条。
> 同日上一轮，**总览里每张工单多一行「9 个主站」的流程带** —— 上一轮把
> `pipeline_status` 缺省改成按项目聚合的总览之后，每张工单只剩一行摘要（阶段 + 停在第几站），
> 人还是看不出「这一票整条路走得顺不顺、哪一站慢/哪一站挂了」：那部分只在 `view: 'tickets'`
> 的九行日志里。现在总览每票下面多一行 `①✓ ②✓ ③✓ ④✓ ⑤✓（13 分 42 秒） ⑥✓ ⑦✓ ⑧✓ ⑨✓｜全程 13 分 53 秒`，
> 符号 `✓/✗/▶/–` 分别是「做成 / 没做成 / 正停在这一站 / 没走过」，图例在抬头下面只印一次。
> 三个刻意的取舍：**只给 ≥1 分钟的站标耗时**（①②③④ 常在 1 秒内，全标反而看不出哪里慢）；
> **终态票最后一站不标耗时**（用「现在」兜底会让昨天跑完的票显示「⑨发送消息（24 时 32 分）」）；
> **老票没有时间线时说「没有流程记录」而不是画九个 `–`**（那等于说「插件当时一个站都没走到」）。
> 返回体 `tickets[].flow` 给机器可读的九站结构。见 `architecture.md` §11.5、本文 §1.25。
> `dev-run` 483 → **486/486**。
> 同日上一轮**`pipeline_status` 缺省改成「按项目聚合的总览」** —— 以前只有一种输出形态
> （逐票一段）且 `includeDone` 缺省 `false` 会先筛掉终态票，两个后果都很难受：票全跑完时只回一句
> 「这次筛选一条都没命中」（明明库里有 6 张），票一多每票十几行、想看「哪个项目卡了」得从头翻。
> 现在新增视图参数 `view: 'overview' | 'tickets'`（**缺省 `overview`**）：总览按 `projectId` 聚合，
> 每个项目一行战报（共几张、几张要你动手、最近动静）+ 每票一行状态，**恒为全库口径**（`includeDone`
> 不参与），项目按「要你动手的多少」排序，每项目最多 8 张（超出折一句，`total` 不缩水）；
> `view: 'tickets'` 保持原明细，传 `recordId` 一律走明细。**新增参数而不是改 `includeDone` 的缺省语义**，
> 因为后者已被 `dev-run` 里 22 处调用依赖。返回体多 `view` 与 `projects[]`（每项
> `{projectId,total,counts,tiers,needsYouCount,needsYou[],awaitingReviewCount,runningCount,queuedCount,latestActivityAt}`），
> 见 `architecture.md` §11.5。同日早前**飞书电子表格支持落地** —— 以前只认多维表格，用户把电子表格
> 链接贴进 `match.appToken` 会被 `get_node` 里硬写的 `obj_type: 'bitable'` 判成「不是多维表格」，
> 一张票都扫不出来，报错还指向「权限」这个错误方向。现在适配器按表型分派（`sheet` 走电子表格
> 分支、`bitable` 走原来的路、老服务端不返回类型时按多维表格兜底），新增 9 个 `match.*` 配置键、
> 面板多一组「飞书电子表格」（**当轮**；2026-11-10 夜已改名「表格读取参数」并只留「工单表链接」一个入口，
> 见 §1.26，下同），`validateProject` 从「二选一」改成「四选一」放行（**后已放宽成「至少一个定位依据」**）。首版只读不写，
> **已于 2026-11-10 补齐回填（工单 #22，见 §1.23）**：`values_batch_update` 写三格、按序号列重新定位行、
> 四类失败各有说法。同轮还补齐了「不知道怎么填」的字段说明、
> 并给 `repo.path` 加了「选择目录」按钮（接宿主 `uiWorkspace.pickDirectory()`），见 §1.21。
> `dev-run` 384 → **451/451**、`feishu-checks` 60 → **80** 条、`client-smoke` 113 → **175 条**、
> `client-check` 面板项目字段 29 项与宿主 descriptor 对得上。此前同日**设置面板「添加项目」失败修好**（原来点「+ 添加项目」会立刻发一笔
> `settings.mutate`，而新项目带空的 `repo.path`，宿主对整份配置一次性校验 ⇒ 必然被
> `projects[n].repo.path 必须是非空字符串` 整笔拒掉，用户永远加不进去。现在改成「垫一张空卡片，
> 填完点顶部保存才与其它改动一起作为一笔提交」，见 §1.18），`client-smoke` 113 → **123 条**；
> 顺手把 `repo.remote` 的面板标签从「远端名」改成「GitLab 仓库地址」（它要的是仓库 URL 不是 git 远端名）；
> 此前同日**`appToken` 贴整条表格链接真的够了**（`parseBitableUrl` 挪进 `src/contracts/types.js`，
> 配置校验与飞书适配器共用：从 `?table=` 啃出 `table_id`、`?view=` 啃出 `view_id`，显式 `tableId` 仍优先；
> 此前只有适配器认得这个写法，用户在配置里只贴一条链接会被 `validateConfig` 拦在启动前），
> `dev-run` **384/384**、`feishu-checks` 58 → **60** 条（都是那一轮的值；电子表格支持后现为 **482/482** 与 **93** 条）；此前同日「配置页改成页签式、视觉对齐宿主设置页」
> （项目 / 参数 / 凭据 / 体检四个页签、一次只画一页、下划线式页签、卡片改用宿主 `settings-card-*` token 并去掉阴影、拆掉三层套娃、
> 面板不再铺灰底，见 §1.17），`client-smoke` 105 → **113 条**，`dev-run` **376/376** 全绿；
> 此前 2026-11-06 新增**关键节点流程日志（时间线）**（票据 `timeline` 17 节点表、9 主站 ①–⑨、
> `pipeline_status` 排成时间线并写「现在停在第 N 站，已 X 分 Y 秒没动」，见 §1.16），自测 **376/376** 全绿；
> 此前同日新增**配置页 UI/UX 大改造**（Label 置顶、高级参数折叠、凭据统一走顶部保存、
> 项目清单可增删、卡片化 + Switch 开关，顺手修掉 `[object Object]` 渲染 bug，见 §1.15），
> `client-smoke` 94 → **105 条**；此前同日新增四项改造 —— **处理完回填工单表**（`TicketSource.writeResult` 唯一写入口 + `writeBack` / `writeBackStatus`）、**处理完保留会话**（`ExecResult.sessionId` + `keepSession`）、**只提交 agent 真正改过的文件**（`createBaseline` 用 `git stash create` 拍基线，脏工作区也能跑，`assertCleanCheckout` 删除）、**设置面板补齐**（`projects` 子树可编辑 + 第 3 个 Remote 方法 `ticketPipeline.projects()`，配置变 33 键 / 7 组，现为 24 键 / 4 组）、**选择分支**（`repo.baseBranch` / `repo.targetBranch` 从手打改成带候选的输入框，第 4 个 Remote 方法 `ticketPipeline.branches()`，见 §1.12）、**设置面板瘦身**（项目卡片可收起、缺省只留 8 个常改字段、「显示全部字段」开关收高级项，见 §1.13），**上线加固**（5 条阻断项 + 4 条重要项：适配器名强校验、验证命令超时与取消、敏感名单 8 类 41 条、`.git`/profile 篡改自检、`pendingEffects` 事后动作补偿、回填失败进通知、租约诚实化，见 §1.14），该轮自测 **363/363** 全绿（后补时间线，现为 482/482）；此前同日新增「插件版本自检」（`src/core/plugin-version.js` + `pipeline_doctor` 第 5 节：比 profile 里声明的源码目录与安装副本的**文件内容**，不落后才静默，落后就给出同步命令），自测 294/294；此前同日新增「本地提交」改造（交付形态改为在项目工作区的检出里做一次真实本地提交，远程 GitLab draft MR 降级为 `repo.gitlab.enabled: true` 才走的可选出口）+ 当晚的「改代码落点」改造（`isolateWorktree` 缺省 `false`：直接在项目工作区的检出里改，检出脏也能跑；`true` 才每票开隔离 worktree）+ 改动收集改走 `git -z`（未跟踪新文件、重命名、中文名/空格名、`.agents/worktrees` 污染四个坑一并修掉），自测 285/285；2026-11-05 深夜的「项目工作区」改造（票 → 项目 → 宿主 Workspace 登记，会话 cwd = 工作区根）自测 262/262；再此前 `26f0391` 把收窄开关推广到三个源、「待修改项目」列不再丢、飞书截图白名单可配，连同 `5b94a17` 的 agent 侧四项，自测 242/242。同日另出「飞书电子表格支持」设计（**2026-11-09 已实施**，见 `docs/ticket-pipeline/feishu-sheet-source.md` 与 `docs/adr/0005-飞书电子表格源按表型分派.md`；当时估的 5 人日最终没按这个口径走，一天内做完，见 §1.21）
> 口径声明：**本文只写代码里真实存在且已验证的东西**。凡是「打算做」「应该做」的一律进第 9 章「未完成与缺陷清单」，不混进完成项。所有行号取自本文生成时的源码。

---

## 0. 一句话结论

骨架和主链路已经成型：**飞书工单表 → 解析工单四要素 → 项目工作区里（缺省直接在检出里，`isolateWorktree: true` 才切隔离 worktree）改码 → 跑验证 → 在工作区检出里做本地提交 → QQ 邮箱 / PushPlus 通知** 这条链在沙盒项目上真跑通过一次（当时的交付物是一条远程 draft MR !1，不是假对象；现在同一条链的交付物已经改成工作区里的本地提交）。

但**真实业务项目（mgiot-pms）的工单还没有完整跑绿一次**。截至 `26f0391`，轮子上的雷基本排干净了：agent 侧四项（模型默认补齐、preset 缺服务硬失败、`repo.gitlab` 透传、verify 命令引号）在 `5b94a17` 修完；收窄开关推广到四个源、「待修改项目」列不再被丢弃、飞书截图白名单可配 在 `26f0391` 修完。**剩下真正挡路的只有三样**：**上游模型配额**（workbuddy 429，非插件缺陷）、**金山文档源缺开放平台取数通道**（需金山账号与管理员审批）、**飞书表本身没有「待修改项目」这一列**（平台事实，不是代码缺陷 —— 真实表的列只有序号/发现部门/问题描述/发现日期/模块/操作流程/截图/优先级/是否处理/处理人/处理结果/处理日期）。

> 已修（`5b94a17` 入树）：agent 侧四个最挡路的雷 —— ① `{{model}}` 模板崩（新增 `resolveAgentOptions`，配置缺的从宿主 `agentDefaultModel.currentSelection()` 补齐，两项成对下发）② preset 服务缺失只记日志（改为**硬失败** `invalid-input`，把真因暴露出来）③ `repo.gitlab` 被配置校验层吞掉（透传 baseUrl/remote/projectId）④ verify 命令只按空白切（认引号，引号内反斜杠当字面量）。
> 已修（`26f0391` 入树）：① 收窄开关 `match.recordIds` 从飞书一源推广到**飞书 / 金山 / mock / webform 四个源**（名单外的行整行跳过，不收票也不进水位）② 金山表「待修改项目」列的值不再丢（进 `Ticket.targetProject`，进任务书，但**不顶 `projectId`**）③ 飞书截图外链白名单有了配置键 `match.allowedImageHosts`（缺省依旧全拒，只放行人点名的主机名）。

| 口径 | 完成度 |
| --- | --- |
| 按用户 6 条需求逐条算 | 4 条可用 / 2 条部分可用 / 0 条空白 |
| 按工程完成度（代码 + 自测 + 文档） | 约 75% |
| 按「能直接上生产接真实工单」算 | 约 60%（agent 侧四个雷 + 三个源收窄 + 「待修改项目」列 + 截图白名单，共 8 处已修；剩金山取数通道、上游模型配额两项外部依赖，以及真实 pms 票尚未复跑成功一次） |
| 架构骨架完成度 | 约 85% |

**不需要推倒重来。** 内核（契约 / 存储 / 调度 / 错误模型）已经是零平台知识的干净分层，重构代价远大于补齐缺口。详见第 10 章。

---

## 1. 用户原始需求逐条对照

| # | 需求（原始表述） | 状态 | 真实依据 | 差在哪 |
| --- | --- | --- | --- | --- |
| ① | AI 同时监控多个平台（金山共享 Excel、飞书）上的工单表，检测内容变化 | **✅ 可用** | 飞书源 2 470 行（`index.js` 1 891 + `sheets.js` 579），已接真实表（appToken `RZZQbY4SkaY6z0shZaBcVpQCnhh` / table `tblWhRSGf0osJqrE`，79 条记录实测），**多维表格与电子表格都认**（按表型分派，见 §1.21）；金山源 1 660 行（xlsx/zip 自解 OOXML）；webform/mock 演示源 | 金山缺开放平台取数通道，只能用注入的 `fetchSheet`；飞书「收票状态值」与真实表语义不一致，已做成可配（`statusValues`）；电子表格首版**只读不回填** |
| ② | 可以在插件中配置对应工单的项目本地仓库地址 | **✅ 可用** | `projects[].repo.path` / `remote` / `baseBranch` / `targetBranch` / `gitlab`（enabled / baseUrl / projectId / remote），由 `locator-table`（187 行）把工单 projectId 映射到仓库；`repo.gitlab` 已能在配置校验层存活（`5b94a17`），`gitlab.enabled` 是远程 MR 出口总开关、缺省 `false` | 无（这项已补齐） |
| ③ | 解析每张工单中的待修改项目、问题描述、操作流程及截图 | **⚠️ 部分** | 飞书列映射 `contracts/feishu-columns.js` 的 13 个语义字段 + 两套表型共用 `mapColumns()` 别名解析（描述/操作流程/截图/模块/优先级/发现日期等；多维表格每轮先读 `/fields` 的真实字段名，见工单 #21）；金山列别名表 `xlsx.js:34-42`（含「待修改项目」）；截图三形态（附件 / 路径 / URL）都已建模并作为 `ImageBlock` 进消息 | ① 飞书表**没有「待修改项目」列**（实测列名只有：序号/发现部门/问题描述/发现日期/模块/操作流程/截图/优先级/是否处理/处理人/处理结果/处理日期）；② ~~金山表该列的值被丢弃~~ → **已修（`26f0391`）**：金山表该列的值现在进 `ticket.targetProject` 并写进任务书（不顶 `projectId` —— 那是存储主键的一半，而这一列是人手填的自由文本）；③ ~~URL 形态截图默认全拒、无配置键~~ → **已修（`26f0391`）**：新增 `match.allowedImageHosts` 白名单配置键（缺省仍为空 = 一律拒绝，安全闸门只有人能打开） |
| ④ | 自主规划并执行修复 | **⚠️ 部分** | `executor-agent` 真实现：先确保**项目工作区**（`repo.path` 目录在宿主 `workspaceRegistry` 里登记，一个项目一条，多票共用）→ `agents.create({meta:{cwd: workspacePath}})` + 挂 preset + （仅 `isolateWorktree: true` 时）`workingDirectory.set(worktreePath)` + `attachSession` 归属工作区 + followup + `git diff --name-status` 收集改动 + 敏感文件过滤；沙盒票 `sandbox\|rec-mock-001` 已由 agent 真改出 `src/pagination.js`，当轮开成 MR !1（**本轮改成在工作区检出里做本地提交**，见 §1.2） | 真实业务票（pms）只在配额上卡过一次；两处宿主侧雷已修（`5b94a17`：`{{model}}` 补齐、preset 缺服务硬失败），但**尚未在真实 pms 票上完整跑绿一次**（上游 workbuddy 429 配额限制，非插件缺陷） |
| ⑤ | 完成后对问题功能进行测试，自动提交 PR | **✅ 基本可用** | 真跑出 GitLab draft MR `http://gitlab.example.com/mk/end/ticket-pipeline-sandbox/-/merge_requests/1`（sha `634777aa…`，changes_count=1，源分支 `ticket-sandbox-rec-mock-001-r1`）；验证命令从 `projects[].verify.build/test` 注入，`verify.test` 真跑出 exit 0。**本轮起默认交付形态改成工作区检出里的本地提交**（`commitLocally` → `ExecResult.commit = {sha, branch, files}`），远程 draft MR 变成 `repo.gitlab.enabled: true` 才走的可选出口 | 没配验证命令时 `phase` 仍是 `done`（契约里 `skipped` 是合法成功路径），现在把验证结论写进提交说明以免误读（`5b94a17`）；要彻底区分得新增 phase，属契约变更 |
| ⑥ | 通过微信 Clawbot 推送或 QQ 邮箱推送（先实现）完成通知，收到后看 PR 详情，人工验证后手动合并 | **✅ QQ 邮箱可用；微信走中继** | QQ 邮箱零依赖 SMTP 适配器（574 行）已真实发信成功（traceId `<mw319ltk.47861f8c479221d3@qq.com>`）；PushPlus 适配器 171 行 | 插件**不直连微信**：微信消息经 PushPlus 的 `clawbot` 渠道中继，需配 `pushplus.token`；PushPlus 回执未消费 |

### 1.1 端到端真实跑通记录（唯一一次全绿的真实链路）

工单：`sandbox|rec-mock-001` —— 沙盒仓库的「列表页按状态筛选后，翻到第二页会跳回第一页」。

| 环节 | 实际结果 |
| --- | --- |
| 扫描入队 | 水位对比识别为新票，进 `pending` |
| 工作区 | 先确保 `repo.path` 这个目录在宿主 `workspaceRegistry` 里有一份登记（一个项目一条，多票共用）；当轮（2026-11-05）再 `git worktree add` 建本票的隔离检出 `.agents/worktrees/ticket-sandbox-rec-mock-001-r1`，会话 header 的 cwd 是工作区根、`workingDirectory` 钉到 worktree。**现在缺省不再切 worktree**：直接在工作区检出里改（脏也能跑，先拍基线、只提交 agent 改过的），`isolateWorktree: true` 才退回这一条 |
| 改码 | agent 改 `src/pagination.js` |
| 验证 | `verify.test` 退出码 0 → `passed` |
| 提 MR | GitLab draft MR !1（opened, draft, 源分支→main）—— 那是 2026-11-05 的交付形态；本轮起改为在工作区检出里做本地提交（见 §1.2） |
| 通知 | 按配置走（当时为 mock） |
| 票态 | `done`，`testOutcome=passed`，`baseCommit=a6e3509…` |

其余 4 张票的失败原因（权威来源：`C:/Users/Administrator/.dsh/storages/ticket_pipeline.json` 的 `tables.tickets`）：

| 票 | 状态 | 失败原因（票面文案） | 真因 | 现状 |
| --- | --- | --- | --- | --- |
| `pms\|reczz28VWNWVbpgL` | done | —— | mock 执行器，交付物是假的（当初是 `mock://draft-mr/...`，现在改成 `sha` 以 `mock` 开头的假 commit） | 仍是假对象，需要重跑 |
| `pms\|reczz28VWNWVefNA` | failed | `internal: agent 没有产生任何文件改动` | **上游 workbuddy HTTP 429 / `quota_exceeded`**（重置时间 2026-11-05 17:09:35 +08:00），agent 一轮都没跑起来 | 已在 `1f788cb` 修：解码 agent 会话 `turn/end` 的 `reason.error.code`，限流转 `rate-limit` 并**抛出**（抛出才进内核退避队列） |
| `sandbox\|rec-mock-002` | failed (attempt 2) | `internal: agent 这一轮以错误结束：prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")` | 配置里 `model` 留空 → 宿主渲染系统提示时 `{{model}}` 无值 | 已在 `5b94a17` 修：`resolveAgentOptions` 从宿主 `agentDefaultModel.currentSelection()` 补齐 provider/model |
| `sandbox\|rec-mock-003` | failed (attempt 2) | 同上 | 同上 | 同上 |

### 1.2 「本地提交」改造（2026-11-06，工作树未提交）

这一轮把**交付形态**从「开一条远程 GitLab draft MR」换成「在项目工作区的检出里做一次真实本地提交」。动机有两层：
本阶段验收只要求工作区里有可 review 的提交，`GITLAB_TOKEN` 与远端连通性不该成为交付的前置条件；而 `git push` 在本机沙箱里本来就不可用（见架构 §12.2），
为把改动送到远端而绕道 GitLab Commits API 属于额外复杂度，不该是唯一出口。

| 项 | 改造前 | 改造后 |
| --- | --- | --- |
| 执行器阶段 | `editing` → `testing` → `mr-opening`（开 draft MR） | 阶段名**保留** `mr-opening`，语义变成「在工作区检出里做本地提交」 |
| 执行器返回值 | `ExecResult.mr = { iid, url, draft }` | `ExecResult.commit = { sha, branch, files }`；`mr` 保留但只是可选出口 |
| 契约校验 | `phase=done/skipped` 必须给 `mr` | `phase=done/skipped` 必须给 `commit` 或 `mr` **之一** |
| 敏感文件 | 过滤掉不提交，仍照常开 MR | **点名暂存**：`git add -- <非敏感文件>`，再 `git commit -m <说明> -- <非敏感文件列表>`；敏感文件连 index 都进不去、留在工作区，文件名写进提交说明的「未提交」一行。**不用 `git add -A`** —— 全量暂存会让 `A application.yml` 露在 index 里，手一抖就提交走了；git 白名单也只放行 `add -- <文件>`，`add -A` / `add .` 一律拒绝。若 agent 自己把它 `git add` 进去过，`unstageSensitiveFiles()` 会跑 `git restore --staged -- <文件>` 把它退回未跟踪（`restore` 的白名单只放行 `--staged`，不带 `--staged` 的 `restore` 会连工作区改动一起丢掉，绝不放行） |
| 远程出口 | 唯一出口 | `repo.gitlab.enabled` **总开关，缺省 `false`**：缺省下不要 `GITLAB_TOKEN`、不发任何 GitLab 请求；显式 `true` + 配了 remote 才走原 Commits API 开 draft MR |
| 通知正文 | 首行 `draft MR：<url>` | 正文第一段是 项目/工单序号/模块/优先级 + 描述前 3 行，**描述之后**有一行 `本地提交：<sha 前 12 位> @ <branch>（<worktreePath>）`；仍配了远程出口的部署才多一行 `draft MR：<url>` |
| skipped 尾注 | （MR 已开成 draft，但验证没跑通，请人工确认） | （改动已交付到工作区检出；验证命令没通过，请人工确认这份改动是否可用）；邮件标题 `phaseLabelOf('skipped')` 改成「已交付（验证未通过，待人工验证）」 |
| 阶段中文名 | `mr-opening` = 正在开 MR；`skipped` = 已开 MR，但未跑通验证 | `mr-opening` = 正在本地提交；`skipped` = 已交付，待人工验证 |
| `pipeline_status` | 每票只列阶段/工作区/MR | 每票多一行 `本地提交：<sha12> @ <branch>`，返回体多字段 `commitSha` |
| `pipeline_doctor` | `GITLAB_TOKEN` 未配进 warnings；有 remote 就 `ls-remote` 握手 | `GITLAB_TOKEN` 未配只显示 `ℹ️ 凭据 GITLAB_TOKEN：未配置（本阶段不需要）`、**不进 warnings**；remote 为空且没开远程出口时**静默**；配了 remote 但没开 `gitlab.enabled` → 显示「只做本地提交（remote 未启用）」且**不发** `ls-remote` |

提交说明的真实样例（实测原文）：

```
fix(pms): [pms] ##1 rec-probe-1
工单标识: rec-probe-1
修订次数: 1

验证：通过（验证通过：test 全部退出码 0）
未提交（疑似含真实凭据，按约定留在工作区）：application.yml
```

自测从 262 → **269** → **274** → **285**（「本地提交」这轮新增 7 条：本地提交的 sha/分支/文件、敏感文件不进提交、`gitlab.enabled` 关闭时零 GitLab 请求、
提交失败让票失败、提交说明内容、`commitLocally` 拒绝空提交与缺 git runner、git 白名单放行 `commit` / `rev-parse HEAD`；
当晚「改代码落点」那轮又加 5 条，见 §1.3；最后一轮改动收集修缺陷又加 11 条，见 §1.4）。
`gitlab-checks` 里 `await check(` 从 51 → 58 → **68 → 86**（后两段见 §1.12、§1.14）。

隔离目录这一层也要说明白：**缺省不隔离** —— 直接在该项目工作区的检出里改代码、就地提交，
开跑前用 `git status --porcelain -z -uall`（连同排除规则，见 §1.4）看一眼，**检出不干净也照跑**：
先 `createBaseline()` 拍一份只读基线（`git stash create`），结束后只提交 agent 真正改过的文件（见 §1.10）；
打开 `isolateWorktree: true` 才退回「每票一个 `.agents/worktrees/<branch>` 隔离 worktree」。
所以不要把「每票必开 worktree」当成硬约束来读。

### 1.3 「改代码落点」改造（2026-11-06 晚，工作树未提交）

这一轮解决的是「改在哪」：**默认就在项目工作区的检出里改**（等于人自己「在工作区新开一个会话处理这笔工单」的感觉），
而不是每张票都先切一个隔离目录。隔离能力保留，但降级成可选项。

| 项 | 改造前 | 改造后 |
| --- | --- | --- |
| 改代码落点 | 每票 `git worktree add -b <branch> .agents/worktrees/<branch>` | **缺省就在项目工作区的检出里改**（分支 = 检出当前分支，不另开票分支，`baseCommit` = 检出当前 HEAD） |
| 新增配置键 | — | `isolateWorktree: boolean`，**默认 `false`**。`true` 才退回上面的隔离 worktree 行为 |
| 开跑前置条件 | 无（新 worktree 天然是干净的新检出） | 缺省模式**脏也能跑**：`inspectCheckout()` 读 `git status --porcelain -z -uall -- . <排除 .agents/worktrees>` + `rev-parse --abbrev-ref HEAD`（`-z` / `-uall` / 排除规则三者的必要性见 §1.4），`describeDirtyCheckout()` 只提醒不拒跑（详见 §1.10） |
| `workingDirectory.set` | 只要有工作区坐标就钉到 worktree | 判据改成 `worktreePath !== workspacePath`：缺省模式两者相等 → 不需要钉、也不要求宿主有 `workingDirectory` 服务；只有 `isolateWorktree: true` 且缺服务才抛 `invalid-input` |
| 清理安全 | `git worktree remove --force` 直接执行 | 加 `isIsolatedWorktreePath()` 前缀校验（只认 `<repo>/.agents/worktrees/<name>`）。缺省模式下没有隔离 worktree，若不校验，`remove --force` 会对着人的主检出执行 —— 这是必须堵的口子 |
| 配置项关联 | `fetchBeforeCreate` / `branchPrefix` / `worktreeRetentionHours` 恒生效 | 三者现在**只在 `isolateWorktree: true` 时用得上**（不建 worktree 就没有可清、可拉、可命名的票分支） |
| `pipeline_doctor` | 只报凭据与 remote | 缺省模式额外读一次检出状态：干净显示「检出干净，可以直接跑票」，脏显示「检出不干净：N 个未提交改动（照跑，只提交 agent 改过的）」并只在提醒里说（不算必须修复，见 §1.10）；并打一行「ℹ️ 改代码落点：项目工作区检出里（脏也能跑，只提交 agent 改过的文件）」/「ℹ️ 改代码落点：每票一个隔离 worktree（.agents/worktrees/）」 |

自测 269 → **274**（`dev-run.mjs` 新增第 15 节「改代码落点」）：`inspectCheckout` 干净/脏/拿不到状态三种情况都说清、
`describeDirtyCheckout` 脏工作区只提醒不拒跑且文案能照着理解（当时是 `assertCleanCheckout` 拒跑，见 §1.10 的后续改造）、
`isIsolatedWorktreePath` 只认插件自己开的 `.agents/worktrees/<name>`（人的主检出、`.agents` 本身、路径穿越一律 false）、
真实 `apply()` 缺省模式不建隔离 worktree 且票据落在工作区根上（`branch` = 检出当前分支，`baseCommit` = 检出 HEAD）。

### 1.4 改动收集改走 `git -z`（2026-11-06 深夜，工作树未提交）

「缺省在工作区检出里改」把 `baseCommit` 变成恒有值，于是原先只在少数路径上暴露的三个坑全部变成主路径上的**必现缺陷**。
这一轮把它们一并修掉，自测 274 → **285**。

| 缺陷 | 现象（真实 git 实测） | 修法 |
| --- | --- | --- |
| **未跟踪新文件漏提交** | `collectChanges` 有 `baseCommit` 时只跑 `git diff --name-status <baseCommit>`。`git diff` **看不见未跟踪文件**：改了 `a.txt` 又新建 `b.txt`，只输出 `M a.txt`；只新建文件时输出**空**。于是「agent 新建一个页面/组件」这种工单里最常见的产物既不进提交，还会因 `committable.length === 0` 被判 `failed`（`agent 没有产生任何文件改动`） | `collectChanges` 改成「`git diff --name-status -z <baseCommit> -- . <排除>` ∪ `git status --porcelain -z -uall -- . <排除>`」取并集，从 status 只补 diff 看不见的 `??`（create），同一路径不重复计数；无 `baseCommit`（首提交前的仓库）时只靠 status |
| **路径被引号/八进制转义 + 未跟踪目录被折叠** | 非 `-z` 输出下：中文名是 `?? "\346\226\260\345\273\272..."`（`core.quotePath` 默认 true）；含空格名即便 `quotePath=false` 仍是 `?? "space name.txt"`（旧解析器 `line.slice(3)` 会把引号带进提交路径 → git 找不到文件）。且 `git status --porcelain` 默认把未跟踪目录折叠成一个目录名（`?? newdir/`），里面的文件路径全丢 → **敏感文件可绕过拦截** | 一律改用 `-z`：`-z` 下路径不带引号、不转义、NUL 分隔（`git diff --name-status -z` 是「旧路径在前」，`git status --porcelain -z` 是「新路径在前」，两个解析器分开写）；未跟踪项必须 `-uall` 展开到文件级。解析器集中在新契约 `src/contracts/git-status.js`（`parseStatusZ` / `parseNameStatusZ` / `statusCodeToAction`），旧的三个非 `-z` 解析导出已删除（留着会诱使人继续用错口径） |
| **`.agents/worktrees` 污染检出** | 插件自己开的隔离 worktree 让主检出 `git status --porcelain` = `?? .agents/`，缺省模式 `assertCleanCheckout` 直接拒跑（`.repos/tp-sandbox` 实测修复前就卡在这） | 所有读状态的地方（`inspectCheckout`、`pipeline_doctor`、`collectChanges`）统一带排除 pathspec `['.', ':(exclude).agents/worktrees', ':(exclude).agents/worktrees/**']`。**只排 `.agents/worktrees`，不排整个 `.agents`**：实测排整个目录会把用户自己放在 `.agents/` 下的内容一起误排掉 |

提交这一侧也跟着改（`commitLocally`）：`addTargets` = 所有 `status !== 'delete'` 的 change 的 `path`，`commitSpecs` = 所有 change 的 `path ∪ from`。
三个理由都是实测出来的：`git add -- <已删除路径>` 会 `fatal: pathspec ... did not match any files`（所以删除路径不能进 `add`）；
`git commit -- <未跟踪文件>` 会 `error: pathspec ... did not match any file(s) known to git`（所以新文件必须先 `add`）；
已暂存的重命名只给新路径会让旧路径的删除留在 index、历史里留下「复制」而不是「重命名」（所以 `from` 必须进 commit pathspec）。

真实 git 端到端验收（`.scratch/_e2e-real-git.mjs`，临时仓库）：一次造出「改 / 删 / 重命名 / 新建 / 中文名 / 空格名」六类改动 + 敏感文件被 agent 自己 `git add` + `.agents/worktrees/` 污染，
`collectChanges` 收齐 9 条且不含插件自有目录，`unstageSensitiveFiles` 把 `application.yml` 退回 `??`，
`commitLocally` 产出的 `log --name-status` 精确等于期望（含 `R100 to-rename.txt renamed.txt`），提交后工作区只剩 `?? .agents/worktrees/...` 与 `?? application.yml`。

### 1.5 陈旧工作区坐标不得复用（2026-11-06 真实事故）

**事故**：`pms|reczz28VWNWVbpgL` 连续两次失败，通知里的错误是
`internal: executor-agent：把工作目录从工作区根切到 worktree 失败（working-directory: directory does not exist: "D:/WorkSpace/dsh-ticket-pipeline/.repos/mgiot-pms/.agents/worktrees/ticket-pms-reczz28VWNWVbpgL-r1"）。继续跑会在 D:\WorkSpace\mgiot-pms 里改代码，所以这里停下。`

**根因**：`core/scheduler.js` 的工作区守卫只看「字段有没有值」：

```js
if ((!row.worktreePath || !ws.workspacePath) && typeof prepareWorkspace === 'function') { ... }
```

这两个字段都非空时整段跳过 `prepareWorkspace`。而这一行恰好是**跨配置时代的混合坐标**：`workspacePath` / `repoPath` 是 11-06 新配置的 `D:/WorkSpace/mgiot-pms`，
`worktreePath` / `branch` 是 11-04 老配置时代的 `.repos/mgiot-pms/.agents/worktrees/…`，那个目录早就随旧仓库一起没了。
陈旧路径原样进执行器 → `setupAgent` 里 `needsPin` 成立 → `workingDirectory.set(agent, <不存在的目录>)` → 抛 `internal`。

**两个放大器**：
1. `store.resetByHuman()` 只把 phase 拨回 `pending`，**不清工作区坐标** —— 人照着通知「拨走再拨回处理中」重开，会带着同一份死坐标原样再失败一次；
2. `recoverPending()` 只在启动时遍历 `store.listActive()`（pending 与中间态），**`failed` 是终态、不在其中** —— 恢复流程永远修不好这张票。

**修法**（`core/scheduler.js`）：
- 新增 `isStaleWorkspaceCoords({ worktreePath, repoPath, currentRepoPath, worktreeExists })`，两种情形判为失效：
  ① 票据上的 `repoPath` 与本次定位到的 `repoPath` 不一致（换了仓库，旧目录可能是另一个仓库的有效检出）；
  ② `worktreeExists(worktreePath)` 明确回 `false`（目录确实没了）。
  **探测本身抛错不算失效** —— 问不到不等于没有，宁可复用旧坐标让人看见真实错误，也不要每轮把已有工作区推倒重来。
- 守卫条件加上 `|| staleCoords`，并且失效时必须把 `worktreePath / branch / baseCommit` **摘成 `undefined`** 再传 `prepareWorkspace`：
  否则它会走「已有 worktree，只补登记」那一支，把死路径原样回传。
- `createScheduler` 新增可选依赖 `worktreeExists`（由 `src/index.js` 用 `checkWorktreeByGit` 提供），与启动恢复共用同一个判定
  —— 两处口径不一致会出现「恢复说没了、调度器说还在」这种最难查的分歧。

新增 3 条断言：目录已删要重建且不把死坐标传下去、换了仓库要重建、探测抛错时不重建。
自测 285 → **288**。

### 1.6 插件版本自检：跑的是不是最新代码（2026-11-06）

**要解决的问题**：安装副本是**普通目录副本**（跨盘 `pnpm file:` 落成复制，不是软链），
而 HMR 的 `root: []` 不监听源码目录、默认 `ignored` 还列着 `node_modules` ——
所以改完源码不手工同步，宿主**一声不响地继续跑旧代码**。此前的表现是「明明改了却没生效」，
只能靠人肉 `robocopy` + 重启，出错时完全看不出来。

**做法**：新增 `src/core/plugin-version.js`（480 行），在 `pipeline_doctor` 里作第 5 节汇报。

- **不比版本号**：两侧 `package.json` 的 `version` 都是 `0.1.0-test.1`，比了也没用。
- **不跟 origin 比**：本阶段的交付形态是「工作区里的本地提交」，origin 长期落后本地，方向正好反了。
  ⇒ 基准取 **profile `package.json` 里声明本包的那条 `file:` / `link:` 源码路径**。
- **只比会真被加载的文件**：`src/**/*.js`、`lib/**/*.js`、`cordis.patch.yml`、`icon.svg`、`locale/*.json`。
  `README.md` / `scripts/` 改了不影响行为，不比 —— 否则每次改文档都误报「版本旧」。
  根目录的 `COMPARED_FILES` 还会先 `readdir` 确认文件真的在，避免 `icon.svg` 缺失把「本来就是这么装的」误报成「比对失败」。
- **链接安装直接判过**：`installedDir` 不含 `node_modules`（从源码直接跑），或两边 `realpath` 相同 ⇒ `linked: true`，不报落后。
  profile 目录不是硬套三层相对路径，而是 `findProfileDir()` 沿路向上最多 6 层找「真的声明了本包」的那份 `package.json`。
- **结论只进 `warnings`**：装旧版插件票照样能跑完，记成 `problems` 会让人以为流水线坏了。
  落后时的文案直接给出可照做的命令：同步哪个目录到哪个目录、然后重启宿主。

四种输出：`✅ 安装副本与源码一致（共比 N 个文件，指纹 xxx）` / `✅ 安装目录就是源码` /
`⚠️ 插件不是最新：… （N 个文件内容不同，副本缺 N 个，副本多 N 个）+ 源码 fp ↔ 副本 fp` /
`ℹ️ 无法比对（<原因>）`。

**同一份逻辑两处生效**：`src/index.js` 的 `doctorOptions` 只构造一次，同时喂 agent 侧的
`pipeline_doctor` 工具（`ctx.tools.register`）与 GUI 设置页的「立即体检」按钮（宿主 Remote），
所以版本检查写在 `runDoctor()` 里两处自动都有，不存在两边口径不一致。

新增 5 组断言：doctor 报落后并给出同步命令（另测一致态 / 链接态 / 比不出来态）、
profile 声明解析与链接识别、能比出内容差异与缺文件多文件、坏输入不抛、`listComparedFiles` 只收会加载的文件。
既有 7 个 doctor 用例全部注入 `comparePluginVersion` 桩，避免自测去读这台机器的真实安装状态。
自测 288 → **293** → **294**（最后一条是 setPhase 真正清 lastError）。

### 1.7 `setPhase` 清不掉字段：所有「清掉它」都静默失效（2026-11-06 真实事故）

**事故现场**：飞书票 `pms|reczz28VWNWVbpgL` 跑成 `done`、本地提交 `0e62fe5` 已在
`D:\WorkSpace\mgiot-pms` 里落地，但 `pipeline_status` 里这张「已完成」的票还挂着：

```
最近错误：internal: agent 这一轮以错误结束：pi-ai provider "workbuddy" has no configured model "deepseek-flash"
```

一条早就被修掉（改成显式 `provider`/`model`）的失败原因，跟着这张票走到了成功之后。

**根因**（`src/core/store.js` `setPhase`）：补丁里所有值为 `undefined` 的键被一概过滤掉。

```js
// 修改前
const defined = {}
for (const [field, value] of Object.entries(patch ?? {})) {
  if (value !== undefined) defined[field] = value
}
const next = { ...row, ...defined, phase: to }
```

而调用方**大量用 `undefined` 表达「清掉它」**，于是在这段代码之下，每一种清除都是静默失效的：

| 调用点 | 意图 | 实际结果 |
| --- | --- | --- |
| `scheduler.js` 成功收尾 `setPhase(key, finalPhase, { lastError: finalError })` | 这一轮没出错 → 清掉上一轮的失败原因 | 旧 `lastError` 原地留着 |
| `recover.js` 「工作区丢失」分支 `{ worktreePath: undefined, branch: undefined, mr: undefined, commit: undefined }` | 丢掉已失效的坐标，重新建 | 死坐标没被清掉，恢复等于白做 |
| `scheduler.js` 清理过期 worktree 后 `{ worktreePath: undefined, branch: undefined }` | 清掉已删目录的坐标 | 同上 |

**为什么自测没抓到**：`dev-run.mjs` 里那条「done 的通知不残留上一轮的失败原因」走的是
`resetByHuman`（`put` 整行，本来就把 `lastError` 抹了），根本没碰到 `setPhase` 的清除逻辑 ——
**清洗路径与断言路径不是同一条，测试是真绿、结论是假绿。**

**修法**：区分「键不存在」与「键在、值为 `undefined`」。

```js
// 修改后：键不存在 → 不动；键在且值为 undefined → 删掉这个字段
const next = { ...row }
for (const [field, value] of Object.entries(patch ?? {})) {
  if (value === undefined) delete next[field]
  else next[field] = value
}
next.phase = to
```

这样「顺手多传一个 undefined」也不会误删字段（没传的键根本不进 `patch`），
而不需要每个调用点各自写一遍 `delete`。

**新增断言**（`dev-run.mjs`）：走**真实重试路径** —— 执行器抛可重试错误 → 票回 `pending`
且写下 `lastError` → 下一轮跑成 → 断言 `row.lastError === undefined`。
这条在修复前会红，修复后绿；原来那条 `resetByHuman` 的用例保留（它测的是另一件事）。

---

### 1.8 处理完回填工单表（2026-11-06，工作树未提交）

**要解决什么**：票跑完了，人还得自己去表格里把「是否处理」改成「是」、把改了哪些文件抄进「处理结果」。
插件明明什么都知道，却让这一步纯手工 —— 忘一次，表里就是一张永远「处理中」的假在办票。

**做法**：`TicketSource` 加一个**可选**方法 `writeResult(recordId, { status?, result, handledAt? }, signal)`，
`scan` 仍然只读，**这是唯一的写入口**，只在票跑成 `done` / `skipped` 之后被调用一次。

| 环节 | 落点 |
| --- | --- |
| 契约 | `src/contracts/ticket-source.js`：`writeResult?` + `WriteBackReceipt = { written, fields?, note? }` |
| 调用 | `src/core/scheduler.js` `writeBackFor()` —— 三条硬约束：只写 done/skipped（failed 留在「处理中」是刻意留的信号）、回填失败只记日志**绝不影响票态**、被取消就不写 |
| 正文 | `renderWriteBackResult()`：首句（skipped 是「已按工单改完并提交，验证没通过，待人工验证。」）+ 验证结论 + 本地提交 sha/分支 + draft MR（若开）+ 处理会话 id + **末行「记录号：<recordId>（要重跑就用 pipeline_reset 带上它）」**。**刻意不写**改动文件清单、工作区路径、长段重跑说明（用户 2026-11-16 口径：单元格只留「人下一步要用的」，记录号必须逐字出现；文件清单在 `pipeline_status` 与 `git show <sha>` 里） |
| 飞书实现 | `PUT /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/{record_id}`，body `{ fields: { 是否处理, 处理结果, 处理日期 } }`；字段缺失（业务码 1254040 / 1254045）返 `{ written:false, note }` **不抛**，其余异常照抛 |
| 开关 | `writeBack`（bool，缺省 **true**）、`writeBackStatus`（str，缺省 `'是'`） |
| 可观测 | `pipeline_status` 每票多一行 `回填表格：成功（是否处理、处理结果、处理日期）` 或 `回填表格：没写成 —— <原因>`；返回体多 `writeBack` |
| 决策 | 新增 [ADR-0006](../adr/0006-处理完回填工单表.md) |

**为什么写在 `writeResult` 而不是塞进 `scan`**：`scan` 是高频、可重试、随时可能被取消的只读动作；
写必须低频（一票一次）、只在真出结果之后。混在一起的后果是「扫一半就把表写了」和「重试一轮写一次」。

**新增断言**（`dev-run.mjs` 第 16 节 + `feishu-checks.mjs`）：三列都写、`writeBackStatus` 可配且空白回落、
`writeBack=false` 一个请求都不发、failed 不回填、回填失败票态不回退、老适配器没实现时静默跳过、
skipped 的首句要说「待人工验证」（不要用否定式收尾）。`feishu-checks.mjs` 52 → **58**。

### 1.9 处理完保留会话（2026-11-06，工作树未提交）

**要解决什么**：票跑完 agent 就没了，人收到「改完了，`git show` 看吧」，想追问一句「为什么这么改、
这里能不能换个写法」—— 没有地方问，只能自己读代码。

**做法**：`ExecResult` 新增可选 `sessionId`，`run()` 的三个出口（done / skipped / failed）都带它，
`executor-agent` 用 `buildSessionId(ticket, ctx)` 生成；票据上落 `sessionId`。

- **agent 实例永远释放**：`finally` 里无条件 `dispose()` —— 保留会话不等于占着模型配额。
- `keepSession !== false`（缺省）时只记一句日志「agent 已释放，会话保留」，与会话留在项目工作区名下，
  宿主 GUI 的会话列表里能看到并点进去继续问。
- `keepSession === false` 才调宿主的 `sessions` 服务收掉（`close` / `dispose` / `closeSession` **三选一，取到哪个用哪个，永不抛**）。
- `pipeline_status` 多一行 `处理会话：<sessionId>（保留在工作区名下，可在会话列表里点进去继续问）`。

**为什么默认保留**：会话归属的是项目工作区（一个项目一条），留着成本只是几条记录，而「能追问」是这件事
最有价值的部分。真嫌多余的人把 `keepSession` 关掉即可。

**新增断言**（`gitlab-checks.mjs`）：执行器返回 `sessionId` → 落到票据上、状态里能看到去哪找会话；
两个出口都带；`keepSession=false` 时会调回收且不抛。

### 1.10 只提交 agent 真正改过的文件（2026-11-06，工作树未提交）

**要解决什么**：缺省模式在人的日常检出里改代码，而人的检出**通常是脏的**（一堆没提交的调试改动）。
原先的 `assertCleanCheckout` 一律拒跑，等于「想跑票先把你手上的活收干净」；放宽成「脏也照跑」之后，
又必须保证**人的改动一个都不能被一起提交**。

**做法**：删掉 `assertCleanCheckout`，换成 `describeDirtyCheckout()`（脏只提醒不拒跑）+ 基线快照。

- `createBaseline()`（`executor-agent/index.js`，`agent.followup` **之前**拍）：`git stash create`
  只造一个 stash commit 对象并回它的 sha —— **不写 ref、不动工作区、不动索引**，`git stash list` 仍是空的；
  干净时返回空串 → 视为无基线；再 `git rev-parse HEAD`、`git status --porcelain -z -uall` 数人自己的未提交改动数、
  对每个 `??` 跑 `git hash-object -- <path>` 存内容哈希。
- `collectChanges()` 的 diff 端点换成基线 sha：比的是「agent 动手前」，人自己的改动天然不在里面；
  未跟踪文件哈希与基线相同 → 人早就放在那儿，跳过。人是 `git add` 进索引的改动同样被排除。
- **基线拍不下来就降级**：日志里说明「人原本未提交的改动可能被一起提交」，票不失败。
- 提示文案（`describeDirtyCheckout`）：项目工作区有 N 个未提交改动，本次照跑；会先拍基线，
  结束后只提交 agent 真正改过的文件，你自己的改动原样留在工作区。
- git 白名单新增两项：`stash create`（只这一个，`pop` / `apply` / `drop` 全拒）、`hash-object -- <path>`（强制 `--`）。

**为什么用 `git stash create` 而不是记 `HEAD`**：记 `HEAD` 的话 `git diff HEAD` 会把人的未提交改动
一并算成 agent 的产物，「不提交不是你修改的文件」就成了空话。

**验收**：真 git 端到端跑过（`dev-run.mjs` 第 15 节）——人的改动一个不出现；`.agents/worktrees/` 不污染判定；
`isIsolatedWorktreePath` 只认插件自己开的目录，防 `git worktree remove --force` 误删人的主检出。

### 1.11 设置面板补齐：项目清单可编辑（2026-11-06，工作树未提交）

**要解决什么**：设置页之前只能改标量配置，`projects[]` 那 25 个字段（仓库路径、工单表绑定、验证命令…）
还得手改 `cordis.patch.yml`；写错不报错、改了不生效都要重启才发现。

**做法**：

| 环 | 落点 |
| --- | --- |
| Config 树 | `src/core/config.js` `buildProjectsDescriptor()` 新增 `projects` 节点：`type:'array'`、**节点自身 `meta.volatile = true`**、`inner` 是 object（子节点也标 volatile）,`inner.dict` 覆盖 **25 个字段** |
| 为什么必须自标 volatile | 宿主 `isVolatilePath()` 只沿 `schema.dict` 下钻、**不认 `inner`**，而 `projects` 是数组 —— 深层路径 `['projects','0','repo','path']` 只能靠根节点自己 volatile 短路放行 |
| 写入 | 只发**深层路径**（`{op:'set', path:['projects','0','repo','path'], value}`），**绝不整数组替换**（会抹掉别的项目和手写 `appToken`），`lib/client.js` 的 `collectOps()` 守着 |
| 新 Remote 方法 | `ticketPipeline.projects()`（第 3 个）与 `ticketPipeline.branches()`（第 4 个，另两个是 `doctor` / `config`）。`projects()` 返回项目的扁平视图；`appToken` 只给 `hasAppToken` + `appTokenPreview`（前 4…后 4），**明文绝不下发**。`branches()` 对每个项目的检出跑 `git for-each-ref`，把本地 + 远端分支剥成纯分支名，给 `repo.baseBranch` / `repo.targetBranch` 当候选（`src/core/branches.js`） |
| 面板 | 项目清单可编辑（5 分区 21 字段）、字段约束即时校验（必填 / 数字 min-max / enum / 列表逗号切分）、**基准/目标分支带候选下拉**（输入框 + `<datalist>`，见 §1.12）、分组可折叠（`localStorage`）、sticky 操作条、脏字段「已改」徽标 + 单字段撤销、加载态「正在等待宿主就绪…」 |

全局配置随之变成 **33 个键 / 7 个分组**（新增 `writeBack`、`writeBackStatus` 进新组「回填工单表」，
`keepSession` 进「执行」组）；`projects` 子树另有 25 个字段，不在这 33 个里。

**验收**：`client-check.mjs` 全绿 —— descriptor 叶子 33 个 / 7 组，schema 信封 71 节点 33 叶子三方一致，
面板 21 项与宿主 `projects` descriptor 对得上，Remote 4 个方法一致，`projects` 可写 25 字段（深层路径 mutate）；
`client-smoke.mjs` 85 条断言全过（加「项目卡片折叠」6 条后 94 条）。

### 1.12 选择分支：`repo.baseBranch` / `repo.targetBranch` 带候选（2026-11-06）

**要解决什么**：这两个键以前只能在面板上手打。打错的自查成本极高 —— 本机 pms 仓库主干叫 `v2.x`，
人凭印象写成 `main`，跑到 `git fetch origin main` 才炸 `fatal: couldn't find remote ref main`，
票全挂在第一步，错误文案里看不出是「分支名写错了」，人会去查权限、查网络。让面板把检出里真实存在的
分支列出来，这类错就从「运行时炸」变成「选项里根本没有」。

**做法**：

| 环 | 落点 |
| --- | --- |
| 解析 | `src/core/branches.js` 的 `parseBranchRefs()`：`git for-each-ref --format=%(refname) refs/heads refs/remotes` 一条一行；`refs/remotes/` 后**只切第一个 `/`**（`feature/x` 这种分支名要保留）；`origin/HEAD` 是符号引用，丢掉 |
| 合并 | `mergeBranchChoices()` 去重后按「当前分支 → 远端默认分支 → 本地分支 → 其余远端分支」排序 —— 下拉框第一项就是最可能对的那个 |
| 列 | `listBranches(gitRunner, repoPath, {detectDefaultBranch})`：**绝不抛**，拿不到就 `ok:false` + 一句人话原因（`repo.path` 没配 / 宿主没给 git 执行链路 / 不是 git 检出 / git 抛错）；主干分支复用体检那边的 `detectBaseBranch`，避免两处对「主干叫什么」的判断漂移 |
| Remote | `ticketPipeline.branches()`（第 4 个方法）**不带参数**：一次返回全部项目的分支。做成 `branches(repoPath)` 的话，面板每次重绘都会对每个项目各发一次请求，卡片一多就是几十个并发 git 进程 |
| 面板 | `PROJECT_SECTIONS` 里两个分支字段的 `kind` 从 `text` 改成 `branch`：渲染成 `<input list=...>` + `<datalist>`。**不做成纯 `<select>`** —— 列不出分支时（新克隆、`repo.path` 还没填）下拉是空的，人就彻底填不了了；输入框 + 候选让「列不出来」退化成「手打」而不是「填不了」 |
| 失败隔离 | 某个项目的 `repo.path` 配错只让它自己的下拉空着并附一句原因，不连累其他项目；分支取不到**从不设错误**，不影响项目清单那一路 |

**为什么按 index 对齐而不是按 repoPath**：两个项目可能指向同一个检出，按路径查表会串味；
`branches()` 与 `projects()` 用的是同一次 `config.projects` 遍历，index 一定对得上。

**验收**：`dev-run` 新增 6 条断言（解析 / 排序去重 / 真跑通 / 四种失败不抛 / 游离 HEAD / 宿主 remote 按项目隔离），
自测 **325/325** 全绿（当轮；上线加固 + 时间线后现为 **482/482**）；`client-check` 的 `kind` 白名单加了 `branch`，Remote 描述符 4 个方法一致；
真机验证 `listBranches` 在 `D:/WorkSpace/mgiot-pms`（当前 `v2.x`，候选 `v2.x`/`master`/`workbuddy/v2-x-8ef29a33`/`main`）、
本仓库（`v0.0.1`/`main`）、`.repos/tp-sandbox`（`main` + 3 个 worktree 分支）上都返回正确清单，
不存在的路径返回 `fatal: cannot change to ...`。

### 1.13 设置面板瘦身 + 项目卡片可收起（2026-11-06）

**要解决什么**：§1.11 把 `projects[]` 搬进面板之后，一屏放不下 —— 一个项目 5 个分区 21 个字段，
两个项目就是 42 行输入框，`repo.path`（每次都要看）和 `allowedImageHosts`（一年改一次）视觉权重一样。
真正常改的只有 8 个字段，其余 13 个是「配一次就不动」。

**做法**：

| 环 | 落点 |
| --- | --- |
| 折叠 1 | 项目卡片整体可收起：头部一个按钮（`.tp-proj-toggle`），收起后只留项目名 + 平台徽标 + 「已改 N 项」+「N 项待修」。**缺省展开** —— 人是来看「我该填什么」的，一进来全收起等于让他先点两下才看得见路径输入框 |
| 折叠 2 | 卡内 5 个分区各自可收起（`.tp-group-toggle`），状态与全局配置分组**分两个 localStorage 键**（`ticket-pipeline:open-projects`），否则不同项目里同名的「仓库」组会互相带 |
| 折叠的边界 | **改过或有错的字段永远露出来**（`sectionVisible` / `fieldVisible` 里的 `exempt` 短路）。否则高级字段被改过后从界面消失、人看不见也撤不回来，保存时却照样写进去 |
| 简化 1 | `PROJECT_SECTIONS` 引入 `advanced: true`：`description`、`viewId`、`recordIds`、`allowedImageHosts`、`mediaPrefix`、`repo.remote`、`repo.gitlab.enabled`、整组 `verify` 收进「显示全部字段」开关（缺省不显示）。缺省视图剩 8 个字段 + wps 组 |
| 简化 2 | `PROJECT_SECTIONS` 引入 `onlyFor: 'wps'`：金山那 5 个字段只在平台是 wps 时出现。**平台以草稿为准**（人刚把 mock 切成 wps，金山组要立刻出现，不用等保存） |
| 简化 3 | 开关本身不进 localStorage ——「我现在要配细节」是一次性意图，记住它反而让下次进来又是一屏 |
| 不删字段 | 隐藏 ≠ 删字段：`PROJECT_SECTIONS` 里 21 个 path 一个没少，`client-check` 的「面板 21 项与宿主 descriptor 对得上」照旧成立 |

**为什么两个折叠类名分开（`.tp-group-toggle` / `.tp-proj-toggle`）**：`client-smoke.mjs` 原来按
`.tp-toggle` 一把捞、断言「配置分组有 3 个折叠标题」；项目卡片与卡内分组加进来后变成 7 条，
断言就红了，而且红得看不出是哪儿错。各认自己的类名，断言才能稳定表达「配置分组有 3 个」。

**验收**：`dev-run` 363/363（当轮；时间线后现为 482/482）、`client-check` 全绿（21 项仍对得上、Remote 4 个方法一致）、
`client-smoke` **85 → 94 条**（新增「卡片有折叠开关 / 默认展开 / 收起后不再渲染字段 / 收起后仍显示项目名 /
aria-expanded 变 false / 再点一次展开回来 / 卡内有可折叠分组」7 条）。

---

### 1.14 上线加固：5 条阻断项 + 4 条重要项（2026-11-06，工作树未提交）

**要解决什么**：上线前审计查出 5 条阻断与 4 条重要问题 —— 全都是「出错时不是报错，而是悄悄跑歪」那一类：
适配器名写错会静默换成 mock（等于假执行却报成功）、验证命令没有超时（一条卡住的 build 会让整条流水线
`already-running` 静默停摆且取消不了）、敏感名单只覆盖 9 种文件名（`prod.env` / `bootstrap.yml` 漏拦）、
agent 能改 `.git/hooks` 与插件 profile、终态与「事后动作」（回填表格 / 发通知）不是同一次落库（进程在两步
之间挂掉就永久丢动作）。

**做法**：

| 环 | 落点 |
| --- | --- |
| 1 适配器名强校验 | `core/config.js:170` `enum: Object.freeze(['agent', 'mock'])`、`:248` `Object.freeze(['mock', 'pushplus', 'qqmail'])`；`src/index.js:256 pickAdapterFactory(table, requested, fieldName, label)` 查不到就抛 `invalid-input` 并列出可用值。`undefined` / `null` / 空串仍回落 mock（首次安装要能跑起来） |
| 2 验证命令超时与取消 | `src/index.js:598 export const VERIFY_TIMEOUT_MS = 30 * 60 * 1000`、`:607 export const VERIFY_TIMEOUT_EXIT_CODE = 124`；`makeCommandRunner(ctx)` 收 `{ argv, cwd, signal, timeoutMs }`，`signal?.aborted` 抛 `PipelineError('aborted', '验证命令还没开始跑就被取消了。')`，超时返回 **124**（与「检查未通过」的普通非 0 区分）。宿主 `dsh-bash-local` 的 `maxTimeoutMs` 缺省 10 分钟，`clampTimeout` 取两者较小值 —— 真实上限是 10 分钟，要 30 分钟得改 profile |
| 3 敏感名单 8 类 41 条 | `adapters/executor-agent/index.js:109 export const SENSITIVE_FILE_PATTERNS`（原来 9 条）：`.env` 家族（含 `env.local` 这类只在后缀白名单里的写法）、Spring（`application*` 与 **`bootstrap*`** 的 yaml/properties/conf/json）、包管理器 token、SSH·GPG、云与容器、明文机器凭据、证书·密钥库·Terraform 状态、关键字兜底 `/secret/i`。已知后缀白名单是为了**不误伤** `src/env.js` / `docs/credentials.md` / `.environment.md` |
| 4 `.git` / profile 篡改自检 | `executor-agent/index.js:194 GIT_HOOK_NAMES`（28 个官方 hook 名）、`:206 PROTECTED_GIT_FILES`（10 个：`config` / `config.worktree` / `HEAD` / `commondir` / `shallow` / `packed-refs` / `info/attributes` / `info/exclude` / `info/grafts` / `info/sparse-checkout`）、`:212 PROTECTED_PROFILE_FILES`（4 个 `cordis.*`）；`:250 snapshotProtectedPaths()` 用 `options.readFile` 拍 sha256 指纹，`:635 compareProtectedSnapshots()` 比对，动了就 `:641 unstageSensitiveFiles()`（`git restore --staged --`）撤回并判 `failed` + `invalid-input`（不可重试）。**没有 `readFile` 服务时跳过自检、票照常交付** —— 这是安全降级，不是漏洞回避 |
| 5 终态与事后动作同一次落库 | `core/scheduler.js:473-503`：终态那次 `setPhase` 同时写 `pendingEffects.writeBack` 与 `pendingEffects.notify`；`clearPendingEffect`（`:752`）刻意**不走 `setPhase`**，因为它会重写 `finishedAt`，让「这一票跑了多久」失真；`replayPendingEffects()`（`:771`，`src/index.js:1205` 启动时调）扫残留终态票把回填与通知补做完。`store` 的 `enqueue` / `revise` / `resetByHuman` 三处**都不继承** `pendingEffects` |
| 6 回填失败进通知 | `scheduler.js:1153-1154`：`row.writeBack.written === false` 时通知正文多一行 `回填表格：没写成 —— <原因>（表格里那一行可能还停在「处理中」，请手工改一下）`；成功时不加行（避免噪音） |
| 7 就地重跑起点 | `isolateWorktree: false` 时每轮重取 `snapshot.head` 当起点；上一轮已提交过、重跑时 agent 没有新改动会被判「没有产生任何文件改动」—— 预期行为，日志里会写出新旧两个 head |
| 8 租约诚实化 | 从「CAS」改口径为「**best-effort 租约**」：同进程靠 scheduler 的 `running` 单飞，跨进程靠 put 后二次读确认（被抢就记日志让出）。宿主 `storageDomain` 的 table API 只有 get/entries/put/delete，**没有 compare-and-swap 原语** |

**为什么 `approval/policy` 仍写 `never`**：宿主只提供 `ask` / `never` 两档，没有「只读自动批、写入弹卡」这一档；
`ask` 在无头场景 fail-closed，会让 agent 的每一步工具调用都失败。所以只能退回 `never` 并打一条 warn
（`executor-agent/index.js:1152`）。兜底只有 git 白名单 + 提交前篡改自检，**不是硬隔离**。

**新增断言**：`dev-run` 325 → **363/363**（当轮；第 16b 节「事后动作补偿（`pendingEffects`）与租约诚实化」14 条；时间线后现为 482/482）；
`gitlab-checks` 78 → **86**（敏感名单覆盖与不误伤、`.git/hooks` 与 `cordis.patch.yml` 篡改判失败、无 `readFile` 跳过、
白名单放行自检要用的 `rev-parse` 形态、`blockedFiles` 可见、受保护路径边界）；
`wps-checks` 25 → **34**（下载通道超时/取消/字节上限/逐跳重定向校验、`scan` 传 signal）；
`workspace-checks` 11 → **19**（验证命令 signal 已 aborted 不起进程、跑到一半取消即 kill、到点返回 124、30 分钟缺省、
适配器名写错要抛并列出可选值）。

---

### 1.15 配置页 UI/UX 大改造（2026-11-06）

**要解决什么**：面板功能全了，但一屏全是「左边一长串说明文字 + 右边输入框」，33 个配置项加 21 个项目字段不分主次；
更糟的是 `projects` 被当成普通字段渲染，`draftValueOf` 把对象数组 `join` 成 `[object Object], [object Object]` 摆在页面上。

**做法**：

| 环 | 落点 |
| --- | --- |
| 修 `[object Object]` | `lib/client.js` 的 `collectLeaves` 剔除 `projects`（`path.length===1 && path[0]==='projects'`）：它是结构化数组，由 `ProjectListCard` 画成卡片，当普通叶子会被 `draftValueOf` 拼成 `[object Object], [object Object]` |
| Label 置顶 | `.tp-field` 从 `grid-template-columns:minmax(140px,220px) 1fr`（左右两栏）改成上下三行：加粗字段名 / 输入框 / 浅灰说明（`1-60，缺省 3` 这种）；字段走 `repeat(auto-fill,minmax(260px,1fr))` 网格 |
| 高级参数折叠 | 新增 `ADVANCED_CONFIG_KEYS`（`safePageRun` / `goneAfterScans` / `concurrency` / `leaseHeartbeatSeconds` / `maxAttempts` / `fetchBeforeCreate` / `branchPrefix` / `worktreeRetentionHours` / `writeBackStatus` / `qqmail.port` / `qqmail.secure` / `pushplus.channel` / `pushplus.template` / `pushplus.callbackUrl`）收进组内「高级设置」折叠；**改过的和有错的字段永不藏**；刻意不收 `enabled` / `logLevel` / `qqmail.host`（自测断言它们必须可见） |
| 凭据统一操作 | `CredentialRow` 删掉每行小「保存」，改由顶部主「保存」一次提交（`onSave` 里先发 `credNs.set`、**不 await**，再同步 `ns.mutate`）；「已配置」用绿色 Tag（`✓ 已配置`），输入框 placeholder「已配置，留空即不修改」；「清除」保留但加 `window.confirm` 二次确认；`state` 字段名与宿主 `remote.credentials.describe()` 对齐（`configured` / `writable`） |
| 项目可增删 | 「+ 添加项目」走 `['projects', '<len>']` + `set` 追加；卡片头「删除」走 `['projects', '<i>']` + `unset`（宿主 `applyPathOp` 对数组是 `splice(i,1)`）。两者都复用现有 `settings.mutate` 通道，**不新增 Remote 方法**；有未保存字段改动时禁用，避免下标错位 |
| 卡片化 | 面板浅灰底（`--dsw-alias-bg-layer-1`）、卡片纯白 + 圆角 + `box-shadow:0 2px 8px rgba(0,0,0,.05)` + 24px 内边距；输入框 36px 高、限宽 |
| Switch 开关 | 布尔项换成 `role="switch"` + `aria-checked` 的开关（宿主 `practices.md` **禁止** `require('@deepseek-ai/dsh-client-ui-primitives')` 之类加载客户端包，只能自写控件、抄宿主 markup/CSS/行为） |
| 顶部操作条 | 顺序照草图：放弃改动 / 重新载入 / 体检 … 保存（主按钮最右，全页只此一颗 `tp-primary`） |

**自测**：`client-smoke` 94 → **105 条**（新增：凭据每行不再有「保存」按钮、清单无 `[object Object]`、
「+ 添加项目」/「删除」按钮、`role="switch"` 语义、布尔不落回原生 checkbox、全页只一颗主按钮）；
`client-check` ✅（descriptor 33 叶子 / 7 组、Remote 4 方法、面板 21 项对得上）、`dev-run` **363**（当轮；时间线后现为 482）、`chain-smoke` **11** 全绿。

---

### 1.16 关键节点流程日志（时间线）（2026-11-06）

**要解决什么**：用户要「完整的关键节点的流程日志，不然我不知道哪里有问题了或者卡在哪里了」——
覆盖「获取工单 → 查找对应工单的项目 → 检查是否存在工作区 → 创建会话选择分支和模型 → 处理工单问题
→ 处理完成后提交 → 发消息给我」这条整链。以前只有按时间散落的插件日志，看到「阶段 → testing」
之后迟迟没有下一条，说不清是卡在跑验证里、还是已经死了、还是差一步发通知。

**做法**：

| 环 | 落点 |
| --- | --- |
| 17 节点表 | `contracts/types.js:63 TIMELINE_NODES`：9 主站带 ①–⑨（discover / locate / workspace / session / editing / testing / mr-opening / writeback / notify）+ 8 补充站用 `no:'·'`（worktree-ready / planning / pending / needs-info / done / skipped / failed / gone）。**节点 id = phase 名**，⑤⑥⑦ 与终态由 `onPhase` 直接查表打点，不维护反查表 |
| 记录结构 | `TimelineEntry = {node,label,at,ok,detail?}`；`at` = 写下时刻 epoch ms（相邻 `at` 差 = 上一站耗时，现在 − 最后 `at` = 距最后动静多久）；`ok` 只有布尔 true/false（✓ / ✗），没有「进行中」三态 |
| 持久化 | `core/store.js appendTimeline(key,node,detail,ok,label)`：连续同 node 同 ok 合并成一条（保留最新 `at`/`detail`，`worktree-ready` 会连触发两次）、上限 80 条丢最旧。**刻意不走 `setPhase`**（它会重写 `finishedAt` 且要过阶段转移校验，而记日志可发生在任何阶段含终态） |
| 唯一写入口 | `core/scheduler.js markNode(...)` 包 `try/catch`（**记日志绝不能把票带崩**）；`markExtra(...)` 给补充站查表补 `label`。扫描入队记 ①、定位仓库记 ②、工作区新建/复用/陈旧重建记 ③、`executor.run` ctx 加 `onFlow` 让真 agent 报 ④、成功收尾记 ⑧⑨、各失败分支（超时/取消/退避/不可重试/needs-info/租约丢失）记 ✗、`replayPendingEffects` 补做标「补做」 |
| ④ 会话详情 | `adapters/executor-agent/index.js reportFlow(ctx,log,node,label,detail,ok)` 通过 `ctx.onFlow` 上报会话 id、provider+model、分支、工作目录；`resolveAgentOptions(...)` 上提保证与实际下发的一致；`executor-mock` 不调 `onFlow`（合法） |
| 历史不清空 | `timeline` 是历史不是本轮状态：`enqueue` 的 `if(existing)` 显式继承、`revise` 用 `{...existing}` 自然保留、`resetByHuman` 也不清空、只在末尾补一条 `pending` 分隔记录「人工重置，重新入队」 |
| 渲染 | `tools/pipeline-status.js describeFlow(row,now)` 倒序找最后主站、算 `stalledForMs` / `station` / `lastNodeOk`；`renderTimeline(row,now)` 排成 `11-06 20:14:58  ⑥ ✓ 跑验证 —— 开始跑验证命令（上一站 5 秒）` + `▶ 现在停在第 ⑥ 站「跑验证」，已 3 分 25 秒没动。`；needs-info 特别写「这一站在等人，不是插件卡死」，终态写「已经收尾」。固定 UTC+8 纯算术换算、`now` 可注入（整次查询用同一个「现在」） |
| 机器可读 | 返回体 `tickets[]` 加 `timeline` / `stalledForMs` / `station` / `lastNodeOk`；`stripUndefined` 会删掉 undefined 键，老票无时间线时 `timeline` 恒为 `[]`、不引入 `undefined` |

**为什么不做「进行中」三态**：「最后一条记录落在哪个节点 + 距今多久」已经能回答「卡在哪」；
多一种状态就要多维护一处「谁把 running 改成 ok」的更新点，反而容易漏、容易骗人。

**验收**：`dev-run` 第 **16c** 节 13 条断言全绿（主站顺序 / `at`/`ok`/`label` 合法性 / 相邻 `at` 单调 /
`onFlow` 报的 ④ 进时间线 / 失败站记 ✗ / 连续合并 / 80 条封顶 / 重新入队继承 / 人工重置不清空 /
`pipeline_status` 渲染「已 1 分 35 秒没动」/ 终态与 needs-info 文案 / 返回体四字段 / 老票无 undefined）；
累计 **376/376**（当轮；补 appToken 链接解析 2 条后现为 **482/482**），26 小节。真实链路探针跑一轮 mock tick 得 11 条时间线（④ 因 mock 不上报而缺席，合法），
渲染探针给出「现在停在第 ⑥ 站」与 `station/stalledForMs` 返回值。详见 `user-guide.md` 的「日常循环 →
为什么这么慢、卡在哪一站」、`architecture.md` §11.4、`operation-flow.md` §1/§7。
（2026-11-10 起 `README.md` 已瘦成 42 行的入口页，不再有 §5.2.1 这类章节号。）

---

### 1.17 配置页改成页签式，视觉对齐宿主设置页（2026-11-09）

**要解决什么**：§1.15 做完后用户仍说「配置页面太复杂了 样式也太丑了」。复看渲染树，两条硬伤：

- **太复杂**：四个大区块（体检 / 凭据 / 参数 / 项目清单）首尾相接竖排在一条线上，一屏 1300 多字，
  四张卡片长得几乎一样，**没有任何分区导航** —— 用户不知道从哪儿看起，也不知道哪些是「一次性调好的」、
  哪些是「日常要动的」。
- **太丑**：亮色主题下 `--dsw-alias-bg-layer-1/2/3` 与 `--dsw-alias-bg-base` **全是 `#fff`**，而上一版
  把面板底设成 `bg-layer-1`、卡片设成 `bg-base` ⇒ **白叠白**，层级只能靠 10% 透明度描边撑着；
  再叠加「灰面板 → 白卡 → 灰项目卡」三层套娃和每张卡上的阴影，视觉上就是「一堆框糊在一起」。
  另外这一版还**铺了一层 `#f9fafb` 灰底**，在宿主原本透明的设置区里像贴了一块异色区域。

**做法**：

| 环 | 落点 |
| --- | --- |
| 页签导航 | 新增 `TABS = [项目 / 参数 / 凭据 / 体检]`、`TAB_KEY = 'ticket-pipeline:open-tab'`、`readTab()` / `writeTab(key)`；`aria-selected` + `role="tablist"`。**缺省停在「项目」** —— 它是主线（一张工单表绑一个仓库），参数与凭据是一次性调好的配角。**（工单 #16 之后变成五个页签、缺省改「运行」，见本文 §1.22）** |
| 一次只画一页 | 主渲染改成 `panels = { projects, params, creds, doctor }` + `panels[activeTab]`，非当前页签的子树**根本不渲染**（不是藏起来），一屏字数从 1320 降到 601 / 148 / 467 / 128 |
| 页签角标 | `tabBadge(key)` 只在真有未保存/待修时才挂数字：参数页 = 未保存的配置项数（有校验错则显示错误数并转红），凭据页 = 待提交的凭据条数，项目页 = 未保存的项目改动数，体检页 = `problems.length` |
| 顶部工具条 | `TABS` 在左、`tp-bar-actions`（待修 / 未保存 / 放弃改动 / 重新载入 / 保存）在右，**吸顶**。「体检」从按钮变页签后工具条不再放重复入口 |
| 提示不随页签消失 | `saveError` / `saveMessage` / `loadError` 渲染在页签内容之外：保存针对整份配置，错在哪页都得看见 |
| 下划线式页签 | 抄宿主 `PluginsSettingsSection`：`border-bottom:.5px solid border-l2` + `[aria-selected=true]::after` 2px 底条；**不用胶囊分段** —— 胶囊只在宿主少数工具条里出现，设置区的惯例是下划线 |
| 去掉面板灰底 | `.tp-panel` 改透明 + `max-width:880px`，不再铺 `bg-module-platform` |
| 卡片用宿主 token | `--dsw-alias-settings-card-fill` / `-stroke` + `--dsw-radius-lg`，**去掉阴影**（白底 + 半像素描边本就是宿主卡片的标准做法，再叠阴影就糊） |
| 拆掉三层套娃 | 项目卡去掉自己那层灰底盒子：原来是「灰面板 → 白卡 → 灰项目卡」，现在就是白卡里的一段，靠 `border-top:.5px` 分隔 |
| 项目清单标题行拆分 | 原来 `h3` 一行里塞了「项目数 / 显示全部字段 / + 添加项目 / 重新读取」5 个控件、窄屏还折行；拆成「标题 + 项目数 badge」+ `p.tp-note` + 单独一行 `div.tp-list-bar` |
| 字号回归宿主比例 | 标题 18px/600、说明 13px、字段名 13px/500、输入框 32px 高（上一版 36px 偏大） |
| 折叠类名分开 | 项目卡内分区按钮 `'tp-toggle'` → `'tp-toggle tp-sec-toggle'`，与配置分组的 `tp-group-toggle` 区分，自测才能分别数 |

**为什么用页签而不是「再折一层」**：折叠只能把内容**藏到别处**，用户仍然要在一个长列表里反复展开收起来找；
页签给的是**并列关系**（四件不相干的事），一次只面对一件。上一版已经折过一层（分组折叠 + 卡内分区折叠），
用户依然说太复杂，说明问题不在「一次显示多少」而在「这些块之间是什么关系」没人告诉他。

**自测**：`client-smoke` 105 → **113 条**（新增：四个页签、`role="tablist"` 语义、缺省选中「项目」、
非当前页签不渲染内容；原有依赖「四块同屏」的断言按页签重校准 —— 参数页输入控件门槛 7 → 6，
因为凭据的 5 个密码框不再同屏；「项目卡内可折叠分组」改用 `tp-sec-toggle` 计数）。
`client-check` ✅（descriptor 33 叶子 / 7 组、schema 信封 71 节点 33 叶子、Remote 4 方法、面板 21 项对得上）、
`dev-run` **451**（当轮 384；22 张工单落地后为 **482**）、`chain-smoke` **11** 全绿。

---

### 1.18 「添加项目」失败：面板把半成品当成要立刻落库的写操作（2026-11-09）

**要解决什么**：用户在设置页点「+ 添加项目」，红字报

```
添加项目失败: invalid config: - projects[2].repo.path 必须是非空字符串（本地 git 检出根目录）(at projects.2.repo.path)
```

**根因**（两个事实叠在一起）：

1. `lib/client.js` 的 `onAddProject()` 以前**点下去就发 mutate**，新项目带 `repo: { path: '' }`
   （空壳，等用户填）：
   `value: { name: '新项目' + (next + 1), description: '', match: { platform: 'mock' }, repo: { path: '' } }`。
2. 宿主 `src/core/config.js:526-527` 对**整份配置**做 `~standard.validate`，`repo.path` 空就
   `fail('repo.path', '必须是非空字符串（本地 git 检出根目录）')`；**任一 issue 整笔回滚**。

⇒ 「先加个空壳再慢慢填」这条路从来就走不通，用户只能在外部手改 `cordis.patch.yml`。
`invalid config: - <path> <message> (at <path>)` 这个前缀是**宿主 loader** 拼的（插件里没有这个字面量）。

**做法**（选「垫卡片 + 一次保存」，否决「给个占位路径」和「让宿主放宽校验」）：

| 环 | 落点 |
| --- | --- |
| 加项目变纯本地 | `onAddProject()` 不再发 mutate：`blankProjectRecord(index)` 造一条缺省 `match.platform: 'mock'`（唯一免凭据平台）的记录塞进新状态 `projPending`，并把 `projectDrafts(record, index)` 的键铺进 `projDraft` —— 新卡片与真卡片共用同一套编辑/撤销/校验路径（绝对下标） |
| 保存时一起提交 | `collectOps()` 末尾追加 pending 循环：`{ op:'set', path:['projects', String(projList.length + q)], value: buildProjectValue(...) }`，宿主 `applyPathOp` 允许 `index === length` 时 set 一项。**新增与其它改动同 revision，要么全成要么全不成** |
| 组装完整对象 | `buildProjectValue(record, index, draft)` 按 `PROJECT_SECTIONS` 铺平；空串/空数组/false **一律不写**（写 `statusValues: []` 会被 `validateProject` 判错）；末尾兜底 `name` / `match.platform` / `repo.path` 三键 |
| 未填完不许保存 | `localProjectIssues` 改吃 `renderedProjects`（真项目 + pending），空壳参与校验 ⇒ 顶部「保存」灰掉并提示「N 项待修」 |
| 撤掉 vs 删除 | `onRemoveProject(index)` 双分支：`index >= projList.length` 只从 `projPending` splice（按钮文案「撤掉」，**不发 mutate**），并用 `addProjectDraftKeys` 把剩余 pending 的草稿键从旧下标搬到新下标；已保存的项目仍立即 `unset`（宿主 `splice`，按钮文案「删除」+ 确认框） |
| 成功/放弃时清干净 | `onSave()` 成功后 `setProjPending([])`（否则 `loadProjects()` 回来的真项目会和 pending 叠成两份卡片）；`onReset()` 也清 |
| 计数不炸 | `changedCount` 把 pending 项目**整张按 1 计** —— 否则刚点一下「+ 添加项目」就显示「未保存 21 项」 |

**顺手修的两个体验坑**：

- **出错不再吃掉整个清单**：`ProjectListCard` 原来 `error.length > 0` 时把 `body` 整个换成一行红字，
  两张项目卡片凭空消失；现在红字单独一行留在清单下方。
- **有未保存改动不再锁死「+ 添加项目」**：按钮 `disabled` 去掉了 `props.dirty`（垫卡片本身就会让
  `projectDirty` 为真，留着等于只能加一个），标题改成「在面板上加一个空项目（填完点顶部「保存」才写进配置）」。
- 顺带把 `repo.remote` 的面板标签从「远端名 / 缺省 origin」改成「**GitLab 仓库地址**」——
  它真正要的是仓库 URL（`resolveGitlab` 用它 `parseGitRemote` 推 `baseUrl` + `projectId`），
  `src/core/config.js` 的 descriptor 同步改；这两个标签此前一直误导用户去填 `origin`。

**自测**：`client-smoke` 113 → **123 条**（新增「按钮不被 dirty 锁死 / 点了不写宿主 / 多出一张卡 /
空壳时保存被拦住 / 填完保存后 mutate 里出现 `['projects','1']` 完整对象且 `repo.path` 非空 /
保存后「未保存」徽标消失」）。
调试时踩到两个选择器坑：卡片要用精确正则 `/^tp-proj( tp-collapsed)?$/`（`indexOf('tp-proj')` 会把
`tp-proj-head`/`tp-proj-body`/`tp-proj-toggle` 一起捞进来）；找「仓库」分区不能用 `indexOf('仓库')`
（「基本」分区的 hint 里也有「仓库」二字），改成认 `仓库仓库路径` 这一段。

---

### 1.19 「从 0 到 1」审计：新用户视角下修掉的 4 件事（2026-11-09）

拿「一台干净机器上的新用户」当标准，把安装 → 凭据 → 飞书权限 → 检出 → 配置 → 首跑 → 日常使用整条路走了一遍，
再逐个核对 33 个配置键与 25 个项目字段。四项必修：

| # | 症状（新用户会遇到什么） | 根因 | 落点与改法 |
| --- | --- | --- | --- |
| 1 | 体检长期挂 `⚠️ 凭据服务不可用（ctx.credentials 缺席）`，看起来像装坏了；但飞书其实能正常读 `app_secret` | `makeCredentialsDescriber(ctx)` 在 `apply()` 时取一次 `ctx.get('credentials')` 并缓存成 `null`，之后再也不重取；而凭据服务由宿主 base composition 提供，挂载时刻晚于插件 `apply()`。真正读 secret 的 `makeSecretReader` 是每次重取，所以能工作 | `src/index.js`：`makeCredentialsDescriber` 改成惰性 `current()`（每次调用重取）+ 暴露 `available()`；`src/tools/pipeline-doctor.js` §3 三分支：服务可用→逐个 `describe`；服务没挂上→**进 `problems`** 并说明是宿主组合问题（确认 profile 挂了该服务 / 重装后完全重启）；连描述器都没有→`ℹ️ 内部接线问题，不影响跑票` |
| 2 | 按文档配完一切，票永远不动，而体检报「环境体检通过」 | `enabled` 缺省 `false`（安全默认），`pipeline_status` 会说「总开关是关的」，但 `pipeline_doctor` **一个字都不提** | `src/tools/pipeline-doctor.js` §2 开头加 `✅ 总开关：已开启，会按 pollIntervalMinutes 自动扫表` / `⏸️ 总开关：关着（enabled=false）——不会自动扫表，也不会跑任何票。去设置页「参数」页签把 enabled 打开，或者直接调一次 pipeline_scan 手动跑一轮。`。**关着只进 `warnings` 不进 `problems`**——这不是装坏了，进 problems 会让人以为环境有故障 |
| 3 | 票处理完了，表格里那一格却写不进去，票据上挂一句像插件坏了的 `internal:`，还会被当成可重试错误反复重试 | 用的是飞书**同步表**（数据由连接器同步进来），飞书不允许直接改行：`800074911 ConnectorSyncTableActionForbidden` / `[status_code: 800004105 msg: syncTable can not apply action:action=data.setRecord …]` | `src/adapters/source-feishu/index.js`：新增 `SYNC_TABLE_FORBIDDEN_ERROR_CODES = new Set([800074911, 800004105])` + `isSyncTableForbiddenError(error)`（先 `/(?:报错\|错误码)\s*(\d+)/` 取码比对，再 `ConnectorSyncTableActionForbidden`、`syncTable … can not/cannot`、裸码兜底）；`writeResult` 的 catch 在 `isFieldMissingError` 之后加分支，退化成 `{written:false, note:'这张多维表格是「同步表」…要么在原系统里看结果，要么把 writeBack 关掉…要么换成自己建的非同步表…飞书原话：…'}`。**重试一万次也一样，所以不能算网络类可重试错误** |
| 4 | 进程被杀在「改到一半」，重启后票**永久卡死**：恢复日志说 `resumed: 1`，票一步不动；`pipeline_reset` 又只认 failed/needs-info/gone，救不回来 | `recoverPending()` 把票恢复成原中间态（`planning`/`testing`）寓意「停在本步重做」，但 `store.pickNext()` **只挑 `pending`**，而 `tick()` 的唯一入口就是 `pickNext()` —— 恢复完之后没有任何代码路径会再把它交给执行器 | `src/core/recover.js`：恢复终态统一成 `pending`。工作区坐标有效就**留着**（`runOne` 会先问 `isStaleWorkspaceCoords`，坐标仍然有效就直接复用那个检出，不重新 clone）；失效则清掉 `worktreePath`/`branch`/`baseCommit`/`commit`/`mr` 再回 `pending` 重建。「上次停在哪一步」写进 `lastError` 给人看。真机事故现场：三张 sandbox 票停在 `testing`/`planning` 就这样躺了三天 |

**配置页核对结论（全新用户视角）**：

- `CONFIG_FIELDS` **24 个叶子 / 4 组**（行为 / agent 与模型 / 通知 / 高级；当轮是 33 个 / 7 组，后来把 `safePageRun`、`goneAfterScans`、`concurrency`、`leaseHeartbeatSeconds`、`fetchBeforeCreate` 收成内置常量，删掉 `pushplus.token`、`pushplus.template`、`qqmail.port`、`qqmail.secure`、`logLevel`）；`getConfigDescriptor()` 与面板三方一致（`client-check` 守）。
- 项目字段 descriptor 里 **25 个**，面板只画 **21 个**。缺的 4 个：`match.appToken`（含明文密钥，宿主不下发，面板只显示「已配置（前 4…后 4）」）、`repo.gitlab.baseUrl` / `repo.gitlab.remote` / `repo.gitlab.projectId`（只能改配置文件）。**这是设计而非缺陷，但新用户不知道**。
  **（2026-11-10 已改）：**现在 descriptor 是 **34 个深层路径**、面板画 **33 个**，缺的那一个只有 `match.appToken` —— 而且它不再是「只能手改」：项目卡片里有「工单表链接」，贴整条 URL、宿主解析后落盘，明文不进浏览器（工单 #11）。`repo.gitlab.*` 三个字段也补上了可填输入框，收进「远程 MR（实验性）」组（工单 #19）。三处数字的口径差异见 [`reference/config.md`](reference/config.md) 开头那张表。
- 空清单文案原来写「如果当前宿主还不支持通过设置通道写 `projects`，保存时会把宿主原话显示出来 —— 那就改 profile 的 `cordis.patch.yml`」，**对现在的面板已经过时**，改成「点上面的「+ 添加项目」加一个：先在面板上垫一张空卡片，填完右边这些必填项，再点顶部「保存」。」+「一个项目 = 一张工单表 + 一个本地 git 检出。最少要填 `name`（唯一）、`match.platform`、`repo.path`；飞书来源还要手填 `match.appToken`」。

**自测**：`dev-run` 378 → **382**（+4：凭据描述器「服务晚于 apply() 挂上也能用」、doctor 区分「服务没挂上 / 这个 ref 没配」、doctor 必须说出总开关、「恢复完必须能被 pickNext 捡起来」并反向断言「工作区有效时不得清坐标」）；`feishu-checks` 59 → **60**（同步表回执）。

---

### 1.20 票据行里的数字键脏字段：老 bug 留下的疤，不会自己好（2026-11-09）

真链路跑完之后翻存储，发现两张票的票据行里各多出 18 个数字键字段：

- `sandbox\0rec-mock-001`：`"0":"跑" "1":"项" "2":"目" … "17":"码"`
- `pms\0reczz28VWNWVefNA`：`"0":"a" "1":"g" "2":"e" … "17":"码"`

正好是 `onPhase('editing', '跑项目配置里的验证命令书，开始改代码')` 这类**阶段说明字符串**被
`Object.entries` 展开的样子。这个 bug 本身已经修掉了 —— `store.setPhase` 现在有闸
（`if (typeof patch !== 'object') throw new TypeError('setPhase: patch 必须是对象…')`，
提交 `be05b71` `fix(kernel): 阶段说明别当字段补丁写进票据`，2026-11-05 14:34），
`onPhase` 也会把字符串参数单独识别成「只记日志的说明」。

**但已经落库的行不会自己好**。并且 `setPhase` / `appendTimeline` / `clearPendingEffect`
全都是 `{ ...row }` 展开后整体写回，于是这十几个垃圾字段会一路被带下去 —— 修得掉来源，
修不掉存量。清单核对时读到这张票，`Object.keys()` 里会突然冒出 `0`–`17`。

**改法**（`plugins/ticket-pipeline/src/core/store.js`）：新增模块内 `isNumericKey(name)` 与
`sanitizeRow(row)`，在**读的出口**（`getTicket` / `listTickets`）剔一次数字键。票据行本来就没有
任何字段以数字命名，所以按「数字键」剔不会误伤正常字段（若按白名单剔，就要跟着
`TicketRecordRow` 一直维护，漏一个字段就悄悄删掉它）。因为所有写路径都是「先读、再整体写回」，
下一次任何写入就会顺手把存储里的脏键清走 —— 不需要迁移脚本，也不需要用户手动清库。

**自测**：`dev-run` 383 → **384**（`票据行里的数字键脏字段会被剔掉，且下一次写入把它从存储里清走`：
先往存储里手工写 5 个数字键，断言 `getTicket` / `listTickets` 读出来都干净、`description` 等正常字段不受影响，
再 `appendTimeline` 一次，断言存储里的数字键也消失了）。

---

### 1.21 飞书电子表格支持：同一张平台下的两种表型（2026-11-09）

**背景**：飞书里「多维表格」和「电子表格」是两种文档类型，API 完全不同 —— 多维表格有 `app_token` /
`table_id` / `record_id` / 行级 `last_modified_time`，电子表格只有 `spreadsheet_token` / `sheet_id`，
**没有行级 id、也没有行级修改时间**。插件以前只认前一种，而报错方式很误导：`normalizeAppToken` 查 wiki
节点时把 `obj_type: 'bitable'` 硬写进 query，于是电子表格被服务端判成「不是多维表格」，抛出的文案是
「请在飞书里确认工单表是一张多维表格」—— 用户看到会以为是权限或配置问题，实际是代码路径压根没通。

**决策**（`docs/adr/0005-飞书电子表格源按表型分派.md`）：**不新增 `platform`**。`PLATFORMS` 是「平台」表，
bitable / sheet 是**同一平台上两种文档类型**，硬拆成两个 platform 会让用户在飞书里换一种表格就要重配整个
项目。改成在适配器内部按表型分派。

**代码落点**：
- 新增 `plugins/ticket-pipeline/src/adapters/source-feishu/sheets.js`（**579 行纯函数**）：列名别名表
  `SHEET_COLUMN_ALIASES`（飞书 12 列 + 金山别名，另加处理人/处理结果/处理日期）、`REQUIRED_SHEET_FIELDS`
  （`description` + `status` 缺一不可）、`resolveSheetColumns` / `mergeSheetAliases` / `mapColumns`（`match.sheetColumns` 与 `match.columns` 都只覆盖不替换；两套表型共用同一份解析器）、
  `columnLetter` / `columnIndex` / `parseSheetRange` / `buildValueRange`、`resolveWorksheet`（按 id / 名字 / 第一张可见）、
  `locateSheetHeader`（**不往下扫表头**）、`cellReader`、`buildRowIdentity`、`sheetPriorityOf`、
  `normalizeSheetDate`（回 `YYYY-MM-DD` 字符串）、`parseSheetRows`（**同轮序号重复直接报错**）。
- `plugins/ticket-pipeline/src/adapters/source-feishu/index.js`（1 452 → 1 891 行）：
  `get_node` 的 query **只剩 `token`**，表型读 `node.obj_type`（老服务端不返回时按 bitable 兜底）；
  `searchBitableDocs` → `searchCloudDocs` 认 `type ∈ {bitable, sheet}`；`resolveTable` 成为**表型分派总闸**
  （显式 `tableKind` → `spreadsheetToken` → `appToken` 双试 → `docNamePattern`）；`scan` 拆成
  `scanBitable`（翻页 + 早停）/ `scanSheet`（一次读全表 + 逐行指纹、mtime 恒 0、**不早停**）。
- `plugins/ticket-pipeline/src/core/config.js`：`validateProject` 从「`appToken`+`tableId` 或 `docNamePattern`」
  改成**四选一**（`appToken`+`tableId` / `spreadsheetToken`+`sheetId` / `spreadsheetToken`+`sheetName` /
  `docNamePattern`）；9 个键（`spreadsheetToken` / `sheetId` / `sheetName` / `sheetHeaderRow` / `sheetIdentity` /
  `sheetIdColumn` / `sheetColumns` / `sheetRange` / `tableKind`）透传 + 校验；descriptor 的 `match` 组加 8 个叶子。

**三处「试错分流」是这段代码里最容易写错的地方**：
1. **auth / rate-limit / network / internal 的错不许去试另一种表型** —— 那是真故障，换接口只会把真因埋掉，
   用户会拿着「既不是多维表格也不是电子表格」的文案去找权限问题。
2. **已经证明是多维表格就别换** —— `resolveBitableTableByIdentity` 能成功列出数据表，说明 token 就是
   bitable，只是 `docNamePattern` 没匹配上，这时给 error 打 `confirmedBitable = true`，`shouldTrySheet` 见它返回 false。
3. **`docNamePattern` 只用来挑云文档，不再用来过滤数据表名** —— 第四步已经用它挑出唯一那张表，若再拿它过滤
   `tables` 清单会 0 命中（`resolveBitableTableByIdentity(token, signal, false)`）。

**首版范围：只读不回填**（**2026-11-10 已改，见 §1.23**）。当时电子表格分支的 `writeResult` 在 `resolveTable` 之后立刻挡掉，返回
`{ written: false, note: '这张工单表是飞书「电子表格」，首版只支持从电子表格读票、不支持回填…' }`。
不能让它往下拼 —— sheet 分支上 `table.appToken` / `table.tableId` 根本不存在，拼出来是
`/bitable/v1/apps/undefined/tables/undefined/records/sh-seq-3`，一个必然 404 的请求，还会被当成可重试故障反复重试。
当时断言里专门验证了「一个非 GET 请求都不发」。
**后来发现这个「只读」不只是缺个功能，它会自我放大**：「是否处理」永远停在「处理中」⇒ 下一轮扫描
把同一张票再收一次。工单 #22 因此把它补上了（`values_batch_update` 三格 + 每次重新定位行）。

**面板与配置说明**（同轮一起做的，见用户第 ②③ 条诉求）：
- 项目卡片多一组「飞书电子表格」（`PROJECT_SECTIONS` 第 6 组，`onlyFor: 'feishu'`）8 个字段，
  每个都写了「这一格该填什么」；`sheetIdentity`（`seq` / `row`）与 `tableKind`（空 / `bitable` / `sheet`）是下拉。
  **2026-11-10 夜已改**：组名改「表格读取参数」、`spreadsheetToken`/`sheetId` 两个输入框撤掉、
  「工单表」组里的 `tableId` 也撤掉，定位工单表只留卡片头上的「工单表链接」一个入口，见 §1.26。
- `sheetColumns`（电子表格）/ `columns`（多维表格）都用**一行文本** `description=我的列名, status=我的状态`（对应控件的 `kind: 'columns'`），
  保存时由 `parseColumnsDraft()` 解析回对象，值里带 `|` 会拆成数组（`seq=序号|编号`）。
- `sheetName` **只在「工单表」组画一次** —— 金山组和飞书组各画一次会变成两个输入框绑同一个草稿键，
  `client-check` 直接报「重复字段：match.sheetName」。
- `repo.path` 那格多了「选择目录」按钮，接宿主 client service `uiWorkspace.pickDirectory()`（原生目录选择器）。
  `uiWorkspace` **不写进 `inject`** —— 没装 `dsh-client-ui-workspace` 的部署里硬依赖会让本 fiber 永不激活、
  整页静默消失；拿不到只是按钮不出现，手打路径照常。只改草稿不发 `settings.mutate`，所以「撤销」照常管用。

**自测**：`dev-run` 384 → **451/451**（其中 19 条电子表格断言，含**只读断言**：全程不得出现对 sheets 的写请求）；
`feishu-checks` 60 → **80 条**（新增「回填退化成只读回执」一条）；`client-smoke` 113 → **175 条**；
`client-check` 通过（面板项目字段 29 项与宿主 descriptor 对得上）。

**仍未验证**（别当成已完成）：`docs/ticket-pipeline/feishu-sheet-source.md` §8.2 的四条**人工前置**一条都没做 ——
①飞书开放平台开 `sheets:spreadsheet` scope（**读写**；只读够扫票、回填会被拒，见 §1.23；与多维表格的
`bitable:app:readonly` 是**两套独立**权限）；
②表格所有者「…」→「添加文档应用」把应用加为**可编辑**协作者（`tenant_access_token` 无法自举，这步只能人做）；
③一张带表头行 + 序号列 + 问题描述列 + 是否处理列的真表；④应用至少有一个云文档 API 权限已开通。
**真表还没读过一张** —— 在这四条做完之前，不要对外说「电子表格已经在真表上跑过」。
（回填那条同理：`values_batch_update` 只在假服务端验过，真表上还没写过一格。）

---

### 1.22 设置页第五个页签「运行」：把队列从对话里搬进面板（2026-11-10，工单 #16）

**要解决什么**：面板以前**只能改配置**。想知道「现在跑到哪了、哪张卡住了、失败的那张怎么重来」，
唯一入口是回对话里敲 `pipeline_status` / `pipeline_scan` / `pipeline_reset` —— 而不知道有这些工具的人
**根本无从查起**。配置页是「一劳永逸」的地方，人打开它时的第一个问题却往往是运营状态。

**做法（顺序即代码顺序）**：
1. **工具侧先把「算结果」抽成模块级函数**，这是整票的地基 —— 不抽就只能复制一份，两种口径迟早不一致。
   `pipeline-status.js` 的 `execute` 主体变成 `export async function collectStatus (options, args)`；
   同款抽出 `collectReset`（`pipeline-reset.js`）、`collectCancel`（`pipeline-cancel.js`）、
   `collectScan`（`pipeline-scan.js`，`preflight()` 同时提到模块级）。工具 `execute` 与 Remote 方法**调同一个函数**。
2. **四个新 Remote 方法**（`descriptors.js` 9 个方法，每参数 `codec` + `strictCodec` 两份）：
   `status()` / `scan()` / `cancel()` / `reset(recordId, projectId?)`。`reset` 是第二个带参方法。
   `method()` 的 result 分派表必须补三行，否则 `status`/`scan`/`cancel` 会全落到 `configSnapshot` 的 typeSymbol 上。
3. **`host.js` 多收四个依赖** `store` / `scheduler` / `gitRunner` / `log`（全可选）；缺了给**人话**
   （`requireStore()` → 「运行页签没接上存储（store 缺席），status 不可用。这通常是宿主装配没把 store 传进来。」），
   不是 `TypeError`。`dev-run` 里有只传 `getConfig` + `doctorOptions` 的老用例，不能崩。
4. **返回体补三个「面板要用、但浏览器里算不出来」的字段**（口径只许在 src 里有一处）：
   每票 `phaseLabel`（浏览器 bundle 里没有 `PHASE_LABEL`）、每票 `canReset`（`RESETTABLE_PHASES`
   已 `export`）、整体 `tiers`（`tierCounts()` 的结果，早退分支也要给）。
   面板**不重算**任何档位或名单，只读这三个字段。
5. **面板**：`TABS` 加 `{key:'run',label:'运行'}` **放最前**，三处 `readTab()` 缺省值全改 `'run'`，
   `panels.run` + 兜底 `|| panels.run`（漏了会静默显示项目页）。`RunCard` 只做「看 + 三个动作」：
   状态行（`已开启` / `关着（enabled=false）` + 圆点）、汇总行、下一个、票列表（`.tp-run-row` 一行一张，
   点开 `.tp-run-detail` 看最近错误/验证/提交/交付缺项/卡在哪站/工作区/会话）、失败票行尾「重跑」。
   轮询是**自递归 `setTimeout` 3 秒 × 最多 200 轮**，不用 `setInterval`（自测沙箱没有它）。

**四个只在这一票里踩到的坑**：
1. **轮询把自测进程吊死**：假 React（`client-smoke.mjs` 的 `makeReact()`）**只执行 effect、从不执行它的
   cleanup 返回值**，于是 `setTimeout` 永远续期、Node 事件循环不空，`client-smoke` 挂 120 秒像卡死。
   修法 `timer.unref?.()`（浏览器里 `setTimeout` 返回数字，没有 `unref`，问号调用安全）。
2. **`useEffect` deps 不能放 `useCallback` 的函数**（`loadRun` 每次渲染都是新引用）⇒ 每渲染一次重读一次队列
   ⇒ 自测渲染循环停不下来。deps 只放 `[isPage, mounted, activeTab]` / `[runPolling]`。
3. **页签文案断言不能用 `textOf(node)`**：角标数字会粘进文字（实测 `运行1|项目|…`），
   要比标签就读 `props.children[0]`；原生标签的 children 也不进 `node.children`（这是
   「`textOf(option)` 读不到 option 文字」的同一个坑，第 3 次踩）。
4. **`ns.reset(recordId)` 只传 1 个实参**：`projectId` 是 `acceptsUndefined`，显式传 `undefined`
   仍会让浏览器侧的「参数个数」校验抛 `expected 2 argument(s), got 1`。

**自测**：`dev-run` 469 → **475**（新增一节 6 条：status 与工具同源、无 store 给人话、
scan 关着时 `disabled` 且 `tickCalls === 0`、cancel 没票在跑说清楚、reset 把失败票放回 pending、
reset 不给非终态票重开）；`client-smoke` 175 → 全绿（新增 9 描述符、四方法形状、五页签、
缺省「运行」、状态行/汇总/票行/角标/展开/三个按钮的点击断言）。`client-check` ✅（9 个方法）。

**没做（票里明确不做）**：监控大盘（图表/趋势）、diff 视图（#05 的文本摘要已够）、实时日志流
（`host.js` 只有 direct，没有 stream）。

---

### 1.23 电子表格也能回填了：只读不是缺功能，是自我放大的 bug（2026-11-10，工单 #22）

**要解决什么**：电子表格分支的 `writeResult` 从 §1.21 起是**挡板**（返回只读回执）。当时的理由是「多写多错、
首版先只读」，但这个口子留错了 —— 电子表格的行身份是**「是否处理=处理中」**，而回填正是把那一格改成「是」。
不写 ⇒ 那一行永远停在「处理中」⇒ **下一轮扫描把同一张票再收一次**，无限重跑。所以「不支持回填」不是少个功能，
是一个会自己长大的 bug。

**为什么不能照抄多维表格那段**：多维表格按 `record_id` PUT 一条记录，`record_id` 是稳定的。电子表格**没有
record_id**，只有「第几行第几列」，而**行号会漂移** —— 人在中间插一行，后面所有票都往下挪一格，
按上次记下的行号写就写到隔壁票上去了。所以回填必须**每次重新读表、按身份列重新定位目标行**。

**做法（顺序即代码顺序）**：
1. **把读表那一段从 `scanSheet` 里抽成 `readSheetValues(table, signal)`**，返回 `{ values, header, rows }`。
   扫描与回填**必须走同一个函数** —— 两处各认一次列，迟早变成「按 A 列认、往 B 列写」。
   它复用 `locateSheetHeader()` + `parseSheetRows()`，于是 `rows[i].rowNumber` 天然就是**人看到的行号**（1-based），
   定位不需要另写一套。
2. **`writeSheetResult(table, recordId, input, signal)`**：`rows.find(r => r.recordId === recordId)` 拿到目标行
   → 按 `header.columns[field]` 反查列字母 → 拼 `valueRanges` → **一次 `values_batch_update` 写三格**
   （逐格 PUT 是三个请求，中间失败会在表里留下「写了一半」，那比全没写更难查）。
3. **四种失败各有专属 `errorKind` + `note`**（不共用一个笼统的「回填失败」）：
   行没了 → `not-found`「找不到那一行（可能被删掉，或序号列被改过）」；
   缺列 → `unsupported` + 列出**表里实际有哪些列名** + 两条改法（`match.sheetColumns` / 关 `writeBack`）；
   只有读权限（403/`auth`）→ `auth` + 点名 `sheets:spreadsheet`（**不是** `:readonly`）+「创建版本并发布」+「可编辑协作者」；
   限流 → 交给 #08 的分档，`retryable` 由 `retryPolicy()` 决定，不在这里自造第二套。
4. **日期写文本不写时间戳**：`normalizeSheetDate(handledAt)` 给 `YYYY-MM-DD`。直接写毫秒数字，文本格式的
   单元格会显示一串 `1762…`，看起来像坏了。
5. **`pipeline_doctor` 加一条「看不见的前置」警告**：读票只要只读权限、写回那三列要读写权限。缺这一档时
   **读得好好的，票跑完了才在回填那一步失败**，而那时票已经是「完成」，人只会看到表格没更新 ——
   体检是唯一能在跑之前提醒的地方。只提醒不写表（写一次就能验权限，但体检的硬约束是不写任何表格）。

**坑**：
1. **假服务端的 `/values/` 路由不分 GET/PUT**（`feishu-checks.mjs`）—— 写请求会被当成读、悄悄返回读的数据，
   于是「回填失败」这个场景永远测不出来。必须单开 `values_batch_update` 分支，并记住 `state.sheetWrites`。
2. **「回填过的那一行下一轮不会被重复收票」是最该断言的一条**（这是本票的真正价值）。测法：把适配器**真发出去**
   的 range 与值回写进假表（列字母转列号、行号减一），再 `scan` 一次，断言 `created.length === 0`
   **且 `updated.length === 0`**。少断言后半个，就等于允许它「再收一次但没改」—— 那还是重跑一遍。
3. **测「行漂移」要在 scan 之后改假表数据**，不能一开始就把目标行放在第 3 行：那样第 2 行和第 3 行都在、
   断言分不清是「定位对了」还是「碰巧」。先 scan（行在第 2 行）→ 再插一行把目标挪到第 3 行 → 回填 → 断言
   `every(r => /[A-Z]3:[A-Z]3$/.test(r.range))` 且**不含 `2:2`**。

**自测**：`dev-run` 475 → **482**（`feishu-checks` 里的 8 条：写对三格、插行后重新定位、行被删不发写请求、
缺列退回只读回执并列实际列名、只有读权限的 note、失败票只写一格、回填后不重复收票、打对 token 与 sheet id）。
`feishu-checks` 86 → **93** 条（+8 新、−1 条老的「回填退化成只读回执」）。

**没做（票里明确不做）**：不新增行（只在既有行上写）、不动三列之外的语义（`status` 仍写 `writeBackStatus`
缺省「是」）、不在读票路径上顺手回填。

---

### 1.24 体检把「自己的 bug」报成「你配置错了」：探针忘了归一 spreadsheetToken（2026-11-10）

**真机症状**：`pipeline_doctor` 报**阻断**——「飞书项目 pms：读不到表元数据（HTTP 404）」，而同一份配置下
适配器扫票是正常的。人看到「读不到表元数据」，第一反应一定是去开放平台查权限、或者怀疑表格没把应用加成协作者，
**而实际上什么都没配错**。

**根因**：`probe.js` 的 `probeOneProject()` 判出表型是电子表格后，直接把 `match.spreadsheetToken` 原值
`encodeURIComponent` 进请求路径：

```js
`/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(base.table)}/sheets/query`
```

而面板推荐的填法是**贴整条工单表链接**，知识库里的表就是一条
`https://<租户>.feishu.cn/wiki/<node_token>?sheet=<sheet_id>`。于是拼出来的是

```
…/spreadsheets/https%3A%2F%2F…%2Fwiki%2F…%2Fsheets%2Fquery
```

⇒ 必然 404。适配器本体从来不这么干：`index.js` 有 `extractSheetToken()`（抠 `/sheets/<token>` 或裸 token），
`resolveSheetTarget()` 会先调它；wiki 形态还会先走 `probeWikiNode()` 用 `get_node` 换出 `obj_token`。
**体检少抄了这两层归一，于是把「探针自己拼错了地址」报成了「你读不到表元数据」** —— 这是最坏的一种误导，
因为修法方向完全相反（它会让人去改一个没问题的配置）。

**修法（`probe.js`）**：
1. 补 `isWikiToken()` / `extractWikiToken()` / `extractSheetToken()` 三个本地函数（**故意不复用 `index.js` 的**：
   探针的硬约束是「绝不 import 适配器内部、绝不抛错」，一旦反过来依赖适配器的闭包，离线自测就跑不起来了；
   代价是这三段小逻辑要跟着适配器保持一致 —— 用例里明写了「两边认同一组输入形态」）。
2. 表型判定后先把 `spreadsheetToken` 归一成裸 token 再放进 `base.table`（报表里给人看的也是裸 token，不是一坨 URL）。
3. `kind === 'sheet'` 且值是 wiki 形态时，先 `GET /open-apis/wiki/v2/spaces/get_node?token=<node_token>`：
   - `obj_type` 是别的类型 ⇒ 明说「wiki 节点不是电子表格（实际类型 X）」，不再发第二个请求；
   - `obj_token` 有值 ⇒ 拿它当 `spreadsheetToken` 继续；
   - `obj_type` 为空（老服务端）⇒ 按电子表格继续（因为这一步是**显式配了 `spreadsheetToken`** 才进来的）。
4. 后面的 `sheets/query` 与 `values/{range}` 都用归一后的 `sheetToken`（不是 `base.table`）。

**自测**：`dev-run` 482 → **483**。新增一条 `体检：电子表格配成整条链接 / 知识库 wiki 链接时，先归一再查
（不能拿 URL 当 token）`，走**真探针 + 假 fetch**，两个子场景：
- wiki 链接 ⇒ 断言**先**打了 `get_node?token=wikcnABCDEFG`、**再**用**换出来的 `obj_token`** 查 `sheets/query`，
  且**全链路没有一处把整条 URL 编进路径**（`!/spreadsheets%2F|spreadsheets\/https/.test(p)`）；
- 普通 `/sheets/shtcnXXX?sheet=…` 链接 ⇒ 断言抠出 `shtcnXXX` 段，且报表里的 `table` 字段是裸 token。

**真机验证**（同一天，用真实 credentials 打真飞书，只读）：修复前 `HTTP 404`；修复后
`kind: sheet` / `metadata.ok: true`（「能读到电子表格元数据（1 个工作表）」）/ `records.ok: true`（「能读到第一页数据（2 行）」），
`table` 是 `get_node` 换出来的裸 token。

**教训**：**一个工具报出的「环境问题」，本身也可能是那个工具的 bug**。体检这类「诊断器」必须与被执行的那条真实
链路口径完全一致 —— 否则它比不体检更糟：它会把一个能跑的配置说成不能跑，让人去改对的东西。凡是「探针/校验器
复制了一份被检对象的解析逻辑」，就要问一句「它抄全了吗？」，并为此写一条**跨两份实现的一致性断言**。

---

### 1.25 总览的每张工单多一行「9 个主站」流程带：把「现在怎样」和「一路怎么走过来的」分开（2026-11-10）

**诉求**：「我想看到由插件执行过的项目的工单执行的**全流程状态**」。

**当时的状态**：上一轮（§11.5）把缺省视图改成按项目聚合的总览之后，每张工单只有一行
`✗/· recordId｜阶段｜模块｜站⑤（已跑 X）｜最近动静｜失败原因`。这一行回答的是「**现在**怎么样」，
而「**整条路**走得顺不顺、哪一站慢/哪一站挂了」仍然只在 `view: 'tickets'` 的九行 `renderTimeline` 里。
于是「看全流程」这件事仍然要求人切视图、翻一段十几行的日志 —— 总览没解决它。

**改法**：总览里**每张工单多渲染一行**流程带（`describeStations()` + `renderFlowLine()`）。
摘要行管「现在」，流程带管「一路」。九个主站来自 `TIMELINE_NODES` 的 `MAIN_STATIONS`：
`discover ① / locate ② / workspace ③ / session ④ / editing ⑤ / testing ⑥ / mr-opening ⑦ /
writeback ⑧ / notify ⑨`（顺序就是人对流程的直觉顺序，不是内部阶段枚举顺序）。

符号表 `STATION_MARK = { ok:'✓', failed:'✗', now:'▶', unreached:'–' }`。**`now` 必须与 `ok` 分开**：
停在⑥时标 `✓` 会让人以为它在等下一站，而实际是这一站还没做完。

三个刻意的取舍，每条都是「看起来更全，实际更误导」的避免：

1. **只给 ≥1 分钟的站标耗时**（`formatShortDuration` 对 < 60 秒返回空串）。①②③④ 常常都在 1 秒内，
   九个都标就成了 `①✓（0 秒） ②✓（0 秒） ③✓（0 秒）…`，反而把真正慢的那一站淹掉。
2. **终态票的最后一站不标耗时**。非终态票当然要用 `now` 兜底补最后一站（「这一站已经跑了多久」正是它要回答的），
   但终态票用 `now` 会得到荒唐数字 —— 一张昨天跑完的票会显示「⑨发送消息（24 时 32 分）」，
   看着像卡在发消息上。所以只有非终态票才用 `now` 补。
3. **老票没有时间线时不画一条全 `–` 的带**。`describeStations` 先判 `timeline.length === 0` 早退，
   返回九个 `unreached` + `noRecord: true`，渲染成「（没有流程记录 —— 这张票的处理早于流程日志功能，
   或刚入队还没开始打点）」。画九个 `–` 等于断言「插件当时一个站都没走到」，而事实是当时还没有打点这个功能。
   **结构上仍给齐九站**（面板不用判空）。

**另一个防分家的决定**：「现在停在哪一站」不自己算，直接取 `describeFlow(row, now).station.no`
（`describeFlow` 是明细视图与时间线渲染共用的那一份）。两处各判一次，迟早出现
「带子上说停在⑥、结论说停在第⑤站」。

**渲染形态**（图例在总览抬头下面只印一次，逐票重复九次解释会把总览撑成第二个明细视图）：

```
━━ 项目总览：6 张票 / 2 个项目 ━━
  （①–⑨ 是 9 个主站：①获取工单 ②查找项目 ③检查工作区 ④创建会话 ⑤处理问题 ⑥跑验证 ⑦提交 ⑧回填表格
   ⑨发送消息；✓ 做成 / ✗ 没做成 / ▶ 正停在这一站 / – 没走过或没有记录；只有超过 1 分钟的站才标耗时）
【sandbox】共 3 张｜待人工验证 2｜已交付 1｜最近动静 3 时 14 分前
    · rec-mock-003｜已完成（已验证）｜模块 表单｜最近动静 3 时 14 分前
        ①– ②✓ ③✓ ④✓ ⑤✓（13 分 42 秒） ⑥✓ ⑦✓ ⑧✓ ⑨✓｜全程 13 分 53 秒
【pms】共 3 张｜需要你处理 1｜已交付 2｜最近动静 95 时 20 分前
    ✗ reczz28VWNWVefNA｜失败｜模块 项目技术支持｜最近动静 123 时 01 分前｜internal: agent 没有产生任何文件改动
        （没有流程记录 —— 这张票的处理早于流程日志功能，或刚入队还没开始打点）
```

注意 `①–`：那三张 sandbox 票是「启动恢复后重新排队」的老票，入队时已经过了打 ① 的时机，
所以 ① 是 `–` 而不是 `✗` —— 没走过 ≠ 没做成，符号必须分开。

**机器可读**：返回体 `tickets[].flow` = `{stations[{no,node,label,state,at,elapsedMs}×9],
reachedCount, total, failedStation, currentStation, totalMs, strip, noRecord}`。
将来面板画进度条直接用这一份，不各自再压一遍。

**自测**：`dev-run` 483 → **486**（新增 3 条）：①完整走完的票九站全 `✓`、只有 ⑤ 标耗时、
`flow.totalMs` 与 `stations[4].elapsedMs` 精确对得上；②跑着的票停在 ⑤ 标 `▶`、没走到的标 `–`、
挂了的那条打点标 `✗` 且 `flow.failedStation === '②'`；③老票说「没有流程记录」而不是画全 `–`。

**教训**：「看到全流程」不是把明细复制一份进总览，而是让总览**每一行都各自回答一个不同的问题**。
摘要行 + 流程带是两种粒度，凑在一起才叫全流程；只加行数不换信息维度，就只是把明细压扁。

---

### 1.26 定位工单表只留一个入口：三个框填同一件事，人当然分不清哪个生效（2026-11-10）

**背景**：用户在设置页上截了三个红框 —— 项目卡片里同时有「工单表」组、「飞书电子表格」组、
和卡片头上的「工单表链接」行，三处都能指定「工单表是哪张」。他的原话是：

> 插件配置页面的工单表 飞书电子表格和工单表连接 保留一个即可 只需要复制工单来源的连接
> 插件处理分辨是电子表格还是多维表格然后获取工单信息等其他的信息，目前这样填来填去都填了
> 根本不清楚用的那个 而且电子表格的获取不到工单

现场配置把这个问题暴露得很干净（`~/.dsh/profiles/desktop/cordis.patch.yml`）：

```yaml
- name: pms
  match:
    appToken: It5gwQ9sMizJh0kdbDhc2rBfnug                          # 多维表格侧
    tableId: tblWhRSGf0osJqrE
    viewId: vewsyZldQC
    spreadsheetToken: https://vcn6ijgss3oy.feishu.cn/wiki/It5gwQ9sMizJh0kdbDhc2rBfnug?sheet=3a5d28  # 电子表格侧
    sheetId: 3a5d28
```

**两套 token 同时存在**，而且 `spreadsheetToken` 里存的是**整条 wiki 链接**。没有人能从这份配置
看出「哪一套真的在生效」—— 答案是 `resolveTable()` 的判定顺序，而它不在配置里。这就是
「填来填去都填了，根本不清楚用的那个」。

**第二个问题：电子表格一张票都取不到。** 根因在 `src/adapters/source-feishu/index.js` 的
`extractSheetToken(raw)`：它只认 `/sheets/([A-Za-z0-9]+)` 和裸 token 两种写法，末尾还有个
「都不匹配就原样返回整串」的兜底。知识库（wiki）里的电子表格，从地址栏复制出来是
`https://<域名>/wiki/<token>?sheet=<sheetId>`，两处正则都命中不了 ⇒ **整条 URL 被
`encodeURIComponent` 之后拼进** `/open-apis/sheets/v3/spreadsheets/<...>/sheets/query`
⇒ 飞书回 `HTTP 404 404 page not found`。

真机验证（2026-11-10，用 `~/.dsh/.credentials.yaml` 里的应用凭据直连飞书，只读）：

| 请求 | 结果 |
| --- | --- |
| `wiki/v2/spaces/get_node?token=It5gwQ9s…` | `obj_type: "sheet"`、`obj_token: "MuVEsnmEbh…"` ⇒ 探测本身是对的 |
| `sheets/v3/spreadsheets/<整条URL>/sheets/query` | **404 `404 page not found`**（用户看到的现象） |
| `sheets/v3/spreadsheets/It5gwQ9s…/sheets/query`（wiki token 直接当 token） | **200**，`sheet_id: "3a5d28"`、`row_count: 199`、`column_count: 20` |
| `sheets/v2/spreadsheets/<token>/values/3a5d28!A1:J3` | **200**，表头 `序号/发现部门/问题描述/发现日期/模块/操作流程/截图/优先级/是否处理/处理人` |

⇒ **wiki token 与 `obj_token` 都能直接当 `spreadsheetToken` 用**，不需要多调一次 `get_node` 换算。

**决策与代码落点**：

1. **面板只留一个入口**（`plugins/ticket-pipeline/lib/client.js`）：
   - `match` 组删掉 `match.tableId` 输入框；`sheet` 组删掉 `spreadsheetToken` 与 `sheetId` 两个输入框，
     组名从「飞书电子表格」改成「**表格读取参数**」（它现在只放读取细节：表头在第几行、序号列名、
     行身份怎么认、读取范围、列名覆盖、强制表型）。
   - `FeishuTableLinkRow` 提到卡片最上面（`ProjectCard` 的返回体从 `[wpsNotice, ...sections, tokenRow]`
     改成 `[wpsNotice, tokenRow, ...sections]`），文案改成「把工单表的浏览器地址整条贴进来，
     **不用管它是多维表格还是电子表格** —— 插件自己认表型并取出工单」。
   - 为什么改名：叫「飞书电子表格」会让人以为「电子表格在这里配、多维表格在别处配」，
     而那正是这次要消掉的误解。读取参数两套表型共用同一份解析器（`sheets.js` 的 `mapColumns`）。

2. **适配器四种写法都认**（`extractSheetToken`）：`/sheets/<token>` → `/wiki/<token>` → 裸 token；
   带协议头却一个都不匹配时**抛 `invalid-input`**（文案列出支持的两种链接形态），不再「原样返回整串
   去拼 404」—— 静默 404 比报错更误导。

3. **第二个隐藏 bug：错误码 1254003 没归入「类型不对」**。`INVALID_INPUT_ERROR_CODES`
   原本是 `{1254005, 1254006, 1254007}`，不含 `1254003 WrongBaseToken` —— 那是「拿电子表格 token
   去问多维表格 `apps/{token}/tables`」时飞书回的业务码。`shouldTrySheet()` 只在 `invalid-input` /
   `not-found` 上才降级去试电子表格，归成 `internal` 就会被当成真故障直接抛出去 ⇒
   **「只贴裸 token 的电子表格」永远走不到电子表格分支**。现在补齐为
   `{1254003, 1254005, 1254006, 1254007}`。

4. **配置层放宽**（`src/core/config.js` 的 `validateProject`）：不再要求
   `appToken` 必须配 `tableId`、`spreadsheetToken` 必须配 `sheetId`/`sheetName`，只要求
   `appToken` / `spreadsheetToken` / `docNamePattern` **至少有一个**。理由：面板现在只有一个入口，
   而 `/wiki/<token>` 不带 `?table=`/`?sheet=`，运行期本来就能自己解决
   （`resolveBitableTableByIdentity` 按 `docNamePattern` 或「表里恰好一张」定位；
   `resolveWorksheet` 取第一张可见工作表）。配置层硬拦等于「运行期能跑、配置层不让存」，
   逼人回头手改 YAML —— 那正是「填来填去」的来源。
   - 保留 `tableKind` 白名单（只能 `bitable` / `sheet`）。
   - **两套 token 并存时只警告不拦**（`warnings`，与「未知键只警告」同一套通道）：
     「实际按<电子表格/多维表格>取工单，另一套不起作用」。
   - `/base/` 链接缺 `?table=`、又没 `docNamePattern`、也没 `spreadsheetToken` 时**仍然拦**：
     `/base/` 是多维表格自己的地址栏形态，飞书一定带 `?table=`，不带是坏输入。
     非 `/base/` 的 URL（wiki / sheets）缺配套参数只警告 —— wiki 表从来不带 `?table=`，
     硬拦会把 wiki 表全挡在门外。

5. **`?sheet=` 不能丢**（`src/contracts/types.js` 的 `parseFeishuLink`）：wiki 分支原本返回
   `sheetId: ''`，现在带上 `?sheet=`。wiki 里既能放多维表格也能放电子表格，`?sheet=` 只在那确实是
   电子表格时有意义；丢掉会让「一个工作簿多张工作表」退回取第一张。
   对应地 `src/remote/host.js` 的 `setProjectTable` 在 bitable/wiki 分支从「无条件 `unset sheetId`」
   改成「有 `?sheet=` 就 set、没有才 unset」。

**修完之后真机跑通三种配置形态**（同一张票 `sh-row-81`，都能取到）：

| 形态 | 配置 | 结果 |
| --- | --- | --- |
| A 粘贴链接后 | `appToken=<整条 wiki URL>?sheet=3a5d28` + `sheetId`，无 `spreadsheetToken` | `created=1` |
| B 旧配置原样 | 两套并存 + `spreadsheetToken` 是整条 wiki URL | `created=1` |
| C 只贴裸 wiki token | 无 `?sheet=`，靠取第一张可见工作表 | 修前 `internal: 飞书接口报错 1254003`，修后 `created=1` |

**自测**：`dev-run` 486 → **491**（新增 5 条：wiki 链接能过校验、两套并存给警告、
裸 token 探多维表格报 1254003 时降级去试电子表格、整条 wiki 链接要抠出 token 再请求、
认不出的链接要报 `invalid-input` 而不是静默 404；同一轮合入的「显示历史」再加 1 条，
当前基线 **492/492**，见 §1.27）；`feishu-checks` 80 → **96 条**；
`client-smoke` 208 → **215 条**（⑦ 节改成断言「定位工单表只剩『工单表链接』一个入口」+
「面板里不再有电子表格 token / tableId 输入框」）；`client-check` 通过
（面板项目字段 33 → **30 项**，宿主 descriptor 里的 `match.appToken` / `match.tableId` /
`match.spreadsheetToken` / `match.sheetId` 面板都不画了，只能改配置文件或经「工单表链接」写入）。

**教训**：**同一个事实有多个入口，就等于没有入口。** 三个框都能指定「表在哪」，用户既判断不了
哪个生效，也说不清自己填的是不是废话；把入口收敛到一个，再让程序自己分辨该走哪条路，
比在文档里解释三条路的优先级有用得多。第二个教训：**兜底分支不要「原样返回」**——
`extractSheetToken` 的 `return text` 让一条认不出的链接变成 404，报错信息指不到真正的原因。

---

### 1.27 运行页签的「显示历史」：历史不是没有，是被一个缺省值挡在门外（2026-11-10）

**用户的诉求**：先问「在哪里能查到历史的工单处理流程」，我答出四条渠道之后他只回了两个字「补上」。
问的是渠道，要的是**面板上直接能看到**。

**当时的真相**：历史一直在。票据只增不删（`store.js` 里没有任何删票方法，`gone` 的票也留着），
`pipeline_status({ view: 'tickets', includeDone: true })` 实跑能列出 6 张票 / 110 行。
问题在面板这一侧：`src/remote/host.js` 的 `status()` 写死
`collectStatus(..., { view: 'tickets', includeDone: false })`，注释还写着「历史用展开的方式看」——
可 `lib/client.js` 里 `includeDone` / 「历史」两个词一次都没出现，**面板根本没有那个「展开的方式」**。
于是票一收尾，运行页签就是一屏空白，人自然以为历史没了。

**改法**（三层各一处，加起来不到 60 行）：
1. `src/remote/descriptors.js`：把 `method('status')` 换成 `status()`，带一个可选参数
   `includeDone`（`parameter(..., optional = true)` → `acceptsUndefined: true`），
   parse 里 `undefined` 原样放行、非布尔直接抛 `TypeError`。
2. `src/remote/host.js`：`async status (includeDone)`，
   `collectStatus(..., { view: 'tickets', includeDone: includeDone === true })`。
   **`=== true` 而不是「真值判断」** —— 见下面第二个取舍。
3. `lib/client.js`：状态行右侧挂一个勾选（class `tp-run-history`），
   `useState(readRunHistory)` 从 localStorage 的 `ticket-pipeline:run-history` 读（存的就是 `'1'`），
   `onRunHistory(next)` 写回并**立刻** `loadRun(next)`。`loadRun(historyOverride?)` 只在覆盖值是
   布尔时才用，否则读当前 state。

**三个刻意的取舍**：
- **缺省仍然关着。** 票据只增不删，跑一个月之后 `includeDone: true` 的开屏要渲染几百行；
  这一屏首先要回答的是「还要我做什么」。
- **`includeDone === true` 严格判定，不从别的类型猜意图。** 面板把 `loadRun` 同时当
  `onRefresh: loadRun` 传下去 —— 那里第一个实参是 click 事件对象。写成真值判断的话，
  人点一下「刷新状态」，对象是 truthy，就会**突然跳进历史模式**。
- **勾选状态记 localStorage。** 「重开面板又变回空白」会被读成「历史被删了」，
  这比缺省带一堆行更容易让人误解。

空列表文案也随开关分岔：关着时说「没有未收尾的票…已经跑完的历史票，勾上「显示历史」就能看到」，
开着才说「库里还没有任何票 —— 票据只增不删，一张都没跑过就是空的」。

**自测**：`dev-run` 491 → **492**（1 条：`remote.status(includeDone)` 不传 / 显式 `false` /
传 `'true'` 三种都只回 1 张、传 `true` 回 2 张且含终态票、`view` 仍是 `tickets`）；
`client-smoke` 208 → **215**（7 条：勾选缺省关、缺省传 `false`、缺省屏里没有历史票、
勾上后传 `true`、勾上后历史票出现、再点掉回到 `false`、描述符里 `status` 带 1 个可选参数）；
`client-check` 通过（两端都是「`status` 带 1 个参数：includeDone」）。

**教训**：**注释里写「用 X 方式看」的时候，去界面上确认那个 X 真的在。**
`host.js` 那句注释描述的是一个不存在的入口，它比没有注释更坏 —— 后来的读者会以为
「历史看不见」是自己不会用。

---

### 1.28 体检补上「状态值口径」：全绿却一张票都收不到（2026-11-10 真实事故）

**用户的诉求**：用户说（原文）「我使用电子表格连接 环境体检不通过获取不到飞书工单信息，
只有使用多维表格才能获取到」。一句话里其实是**两个独立问题**，而且都不在「电子表格支持」上。

**问题一：体检把自己的 bug 报成了「你配置错了」。**

面板「工单表链接」贴一条 `/wiki/<node_token>` 时，`src/remote/host.js` 的 `setProjectTable`
走 else 分支，把**裸 wiki token 写进 `match.appToken`**（`parseFeishuLink` 对 wiki 返回
`{ kind: 'wiki', appToken: wikiToken }`）。那个节点背后既可能是多维表格、也可能是电子表格 ——
字段名叫 `appToken` 但装的不一定是多维表格 token。

- 适配器本体是对的：`resolveTable()` 里 `isWikiToken(appToken)` 为真就先 `probeWikiNode`
  问 `obj_type`，是 `sheet` 就走 `resolveSheetTarget`。
- 体检探针是错的：`probe.js` 的 `probeOneProject` 原来只有两行判定 ——
  `if (spreadsheetToken.length > 0) kind = 'sheet' else if (appToken.length > 0) kind = 'bitable'`，
  于是拿 wiki token 去问 `/bitable/v1/apps/<token>/tables`，飞书回
  `1254003 WrongBaseToken`（HTTP 200 + 业务码，不是 4xx）。

实测同一条配置：**适配器 `✅ 票数 = 73`，探针 `❌ 1254003`**。人看到红字就去改配置，
越改越乱 —— 这是最坏的一种误导：体检本身的 bug，被包装成用户的操作错误。

修法：`probe.js` 加 `TYPE_MISMATCH_CODES = new Set([1254003, 1254005, 1254006, 1254007, 1254043, 1254045])`
与 `shouldFallbackToSheet(error)`（与适配器 `shouldTrySheet()` 同一口径：只有「类型不对」才换条路，
凭据错 / 限流 / 网络错都是真故障），并把「表元数据」段重写成「表型探测 + 表元数据」：
wiki 形态先 `get_node` 定 `obj_type`，bitable 侧把 `obj_token` 与 nodeToken 都当候选逐个试，
降级时用手里那个 token 直接查 sheets（**wiki token 与 obj_token 都能当 spreadsheetToken 用**，
实测 2026-11-10，少一次往返）。另把 `extractSheetToken` 补上 `/wiki/([A-Za-z0-9]+)`。

**问题二（真正的「收不到票」）：状态值对不上。**

这与表型完全无关。`src/adapters/source-feishu/index.js:73` 的 `IN_PROGRESS_VALUE = '处理中'`
是缺省值，`resolveStatusValues` 在未配时退回 `['处理中']`。而这只表「是否处理」的实际取值是：

| 表型 | 200 / 80 行里的分布 | `statusValues: ['处理中']` | `statusValues: ['是']` |
| --- | --- | --- | --- |
| 电子表格（sheet `3a5d28`） | `是` 73 / `否` 7 / 空 119 | **0 张** | **73 张**（首票 `sh-row-2`） |
| 多维表格（`tblWhRSGf0osJqrE`） | `是` 73 / `否` 7 | **0 张** | **73 张**（首票 `reczz28VWNWVaWOj`） |

人感觉「只有多维表格能取到」，是因为多维表格那条配置之前被单独调过 —— 与表型无关，
两种表型都得把 `statusValues` 改成 `['是']`。

体检原来**查不出这一层**：它只验「读不读得到数据」，不验「读到的状态值是不是你要的」。
于是权限、表、数据全绿，票却一张都不来。

修法：`probe.js` 采样状态列的实际取值（电子表格用 `mapColumns` 认列后逐行取、
多维表格用 `BITABLE_COLUMN_ALIASES` + `normalizeCellText` 认字段），
与 `resolveStatusValues(match.statusValues)` 比对，产出
`{ ok, values, expected, message, fix }`：

- 一个都对不上、且表里**也没有任何闭环取值** → `ok: false`，文案给出**表里实际是哪些值、配置认哪些值、这样一张票都收不到**，
  修法是「改成表里真实出现的那个，比如『待处理』」。
- 一个都对不上、但表里出现了**闭环取值**（回填写的「是」+ 人工否掉的「否」+ 配置里的 `writeBackStatus`）
  → `ok: true` + `idle: true`，文案改口说「**表里现在没有待办的票** …… 收 0 张是对的，不是配置错」。
- 至少一个对上 → `ok: true`，并把「表里出现什么」也印出来（人一眼能确认自己没配错）。
- 采样里没有非空值 / 认不出状态列 → 不产出这一层（闭嘴），交给列映射那层报得更清楚。

**2026-11-12 纠偏（真机）**：上面第一条以前把「一个都对不上」一律当成配置错，包括
「表里全是『是/否』」这种**完全正常**的稳态。真机上 pms 那张表 74 行「是」+ 6 行「否」、
零行「处理中」，旧文案催人「把状态值改成『是』」—— 真照着改，74 张已完成的票会全部
重收并重跑。**这是最危险的一类错建议：听起来像修复，实际是引爆。** 因此探针里加了
`closedStatusValues`（缺省 `['是','否']`，调用方再叠上配置的 `writeBackStatus`），
三种结论分开：正常稳态 ⇒ `ℹ️` 中性说明且**不进 reminders**；真配错 ⇒ 仍 `⚠️` + 修法；
表空 ⇒ 闭嘴。`pipeline_doctor.js` 与 `remote/host.js` 的 `testProject()` 同一条口径
（「测这张表」此时说「读得通，只是现在没票可收」，不再承诺「能收到票」）。

`src/tools/pipeline-doctor.js` 的逐项目渲染里加一段：`ok === false` 时
`lines.push('　⚠️ 状态值对不上：…')` + `warnings.push(...)`；`idle === true` 时只印
`　ℹ️ …` 一行（**不进提醒**）；`ok === true` 时只印一行。
**只进提醒、不进阻断** —— 收不到票不等于流水线坏了，而且人可能正按别的状态值跑。

**采样窗口为什么是 100 行**：够看出取值分布，又不会让体检把整张表拖下来。写进常量
`STATUS_SAMPLE_ROWS = 100`，同时把「第一页数据」的读取范围从 `!A1:Z2` / `page_size: 1`
一起放宽到这个值 —— 否则采样只看得到两行。

**真机验证**（`.scratch/_diag-status.cjs`，只读不写飞书）：五种配置形态全跑一遍，
`['处理中']` 的两种表型都报「表里实际是『是』『否』…一张票都收不到」，`['是']` 的两种都报
「状态值对得上」。体检全文实跑（`.scratch/_diag-doctor-live.cjs`）：

```
✅ 飞书认证：能换到 tenant_access_token（App ID / App Secret 是对的）
✅ 飞书项目 pms：能读到多维表格元数据（2 张数据表）
　能读到第一页数据（这张表里有记录）
　⚠️ 状态值对不上：状态列里没有一个是配置认的值（表里实际是 「是」 「否」，配置认 「处理中」）—— 这样一张票都收不到
```

**自测**：`dev-run` 492 → **495**（2 条：① 状态值对不上要点出来 + 给出修法、配对时不误报、
认不出状态列时闭嘴；② 只进 `warnings`、`blockers` 为空、`ok` 仍为 `true`）。
`feishu-checks` 当时仍 96 条，`client-smoke` 当时仍 215 条，`client-check` 通过（Remote 仍 9 方法）。

**教训**：

1. **同一个问题有两份实现（适配器 vs 体检探针）时，认定口径必须逐条对齐。**
   两边各自「看起来合理」的判定，合起来就是「扫票好好的，体检报红」。
2. **字段名会骗人。** `appToken` 可能是多维表格 token，也可能是 wiki 节点 token
   （背后是电子表格）。看到字段名就下结论是错的。
3. **用户说的「只有 X 能用」往往不是一个 bug，而是两个叠在一起。**
   这里一个是假红（体检口径），一个是真拦（状态值），互相掩盖。
4. **体检要验「验完之后能不能真跑起来」，不只是「接口通不通」。**
   权限、表、数据三项全绿，票仍然可以是 0 张 —— 中间隔着一个「状态值」的口径。

---

### 1.29 「凭据」页签填了 token 点保存，什么都没发生（2026-11-11 真实事故）

用户原话（配着一张截图）：**「凭据页面保存不成功」**。截图里「凭据」页签上挂着数字 **1**，卡片顶上
却写着「没有需要保存的改动」—— 这两句话互相矛盾，而人只会得出一个结论：保存坏了。

#### 现场

五个凭据里 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `QQMAIL_AUTH_CODE` / `GITLAB_TOKEN` 都是
「✓ 已配置」，最下面的 `PUSHPLUS_TOKEN` 未配置。往最后那个密码框填了 token，页签计数从 0 涨到 1，
点顶部「保存」，回来一句「没有需要保存的改动」，凭据库里什么都没多。

#### 根因（`plugins/ticket-pipeline/lib/client.js` 的 `onSave()`）

```js
var ops = collectOps()          // 只算「配置字段」的改动
if (ops.length === 0) {
  setDraft(...); setProjDraft(...)
  setSaveMessage('没有需要保存的改动')
  return                        // ← 在这里返回
}
if (pendingCreds.length > 0) { … }   // ← 写凭据的整段在 return 之后，永远走不到
```

凭据和配置走的是**两条独立通道**（`credentials.set` vs `settings.mutate`），但 `onSave()` 把它俩
串成了「先看配置有没有改动，没有就整体无操作」。只填凭据、不动任何配置字段时，`collectOps()`
是空数组 ⇒ 提前返回 ⇒ 凭据一个字节都没写。

更糟的是**面板自己也在骗人**：页签计数 `tabBadge('cred')` 把 `credDirty` 算进去了，
保存按钮的 `disabled` 也写成 `saving || (changedCount === 0 && !credDirty)` —— 所以按钮是亮的、
数字也确实在涨。**能点、能涨、点了没用**，这是最难自查的一种坏。

#### 修法

把「写凭据」整段**移到 `ops.length === 0` 提前返回之前**，两条通道彻底解耦：

1. 先在 `savingCreds` 标志下逐条 `credNs.set(entry.ref, entry.value)`（刻意**不 await**，让
   `settings.mutate` 立刻发出去 —— 自测按「点保存 → 同一拍里 mutate 数 +1」断言）。
2. 没有 `credentials` 命名空间时显式报错，不再静默什么都不做。
3. `ops.length === 0` 分支改成 `setSaveMessage(savingCreds ? '' : '没有需要保存的改动')` ——
   只提交凭据时，结果由 `credMessage` 逐条报（成功/失败各有文案），这里别抢话。

#### 自测（`plugins/ticket-pipeline/scripts/client-smoke.mjs` 的 ④b 节，4 条）

- 只填凭据时保存按钮**是能点的**（`credSave.props.disabled === false`）
- 只填凭据也能写进去（`credentialSet` 里出现 `{ ref: 'PUSHPLUS_TOKEN', value: 'tok-only-cred' }`）
- 只填凭据时**不该编出一条配置 mutate**（`calls.mutate.length` 不变）
- 只填凭据时**不说**「没有需要保存的改动」

#### 教训

1. **入口能点、计数会涨、点了没反应 —— 先查「有没有一个空集合提前 return」。**
   这类 bug 的伪装极强：接口没报错、日志没异常、UI 状态还理直气壮。
2. **两条独立通道不该串成一个「有没有改动」的总闸。** 凭据与配置各有各的成功/失败语义，
   用其中一个的空集去决定另一个要不要执行，是把耦合藏进了一个 `if`。
3. **面板自己算的「未保存 N 项」必须和「点了保存会做什么」用同一份真相。**
   这次 `tabBadge` 算进了 `credDirty`，而 `onSave()` 没有 —— 两个函数各记各的，用户看到的就是自相矛盾。

---

### 1.30 定位捷径不能跳过表型判定：一次 scan 静悄悄地什么都没做（2026-11-11 真实事故）

用户跑了一次 `pipeline_scan`，**一张新票都没进来**。界面上没有报错、没有红字，安静得像什么都没发生。

#### 现场配置

```yaml
- name: pms
  match:
    platform: feishu
    appToken: It5gwQ9sMizJh0kdbDhc2rBfnug   # 裸 wiki token，背后是一张电子表格
    tableId:  tblWhRSGf0osJqrE               # 上一轮用多维表格时留下的
    sheetId:  3a5d28
    docNamePattern: PMS项目管理系统工单
    statusValues: [处理中]
```

#### 根因（`plugins/ticket-pipeline/src/adapters/source-feishu/index.js`）

```js
// resolveBitableTableByIdentity，旧写法
if (tableId) return { kind: 'bitable', appToken: resolvedAppToken, tableId }
```

**配了 `tableId` 就一个请求都不打、「定位成功」。** 而裸 wiki token 不以 `wiki` 开头、也不含
`/wiki/`，`isWikiToken()` 认不出来 ⇒ 走「原生 token：先按多维表格试」那条路 ⇒ 被 `tableId` 一句
早退钉成 `kind:'bitable'`。连锁后果三条：

1. **表型分派被抢走**，永远走不到电子表格分支；
2. **`shouldTrySheet()` 的降级路被堵死** —— 降级只在**定位失败**时发生，这里「成功」了，没失败可降；
3. 一路拖到 `resolveBitableColumns` 去问 `/bitable/v1/apps/<wiki token>/tables/<tableId>/fields`
   才炸，报 `1254003 WrongBaseToken`。

真机堆栈（`.scratch/_scan-source.mjs`）：`mapApiError (index.js:586) … resolveBitableColumns (index.js:1354)
← scanBitable (index.js:1507) ← scan (index.js:1457)`。

#### 为什么特别难查：体检全绿

| 路径 | 表现 |
| --- | --- |
| `pipeline_doctor`（体检） | ✅ 全绿 —— 探针认表型是问 `get_node` 的 `obj_type`，**不认 `tableId`** |
| `source.scan()`（真正跑票） | ❌ 抛 `WrongBaseToken`，且只在后台 tick 里出现 |

同一个毛病，体检绿色、跑票失败，用户看到的只有「电子表格不能用了」。

#### 修法（两层，缺一不可）

- **运行期**（`resolveBitableTableByIdentity`）：配了 `tableId` 也先问一次 `tables`。
  token 真是多维表格 ⇒ 只多一个请求，行为不变；是电子表格 ⇒ 在这儿失败成 `invalid-input`，
  `resolveTable` 照常降级去试 sheet。
- **配置期**（`src/core/config.js` 的 `validateProject`）：`tableId` 与 `sheetId` 同时存在就
  `warnings.push`，说清「这两个是两种表型各自的坐标」并建议把链接重贴一次。
- **写入期**（`src/remote/host.js` 的 `setProjectTable`，2026-11-11 补）：`tableId` / `viewId`
  改成和 `sheetId` 一样**成对处理** —— 链接里有就 `set`，没有就 `unset`。
  
  这一层是复盘时才发现漏的：原来 else 分支只写了
  ```js
  if (parsed.tableId.length > 0) ops.push({ op: 'set', path: [...base, 'tableId'], value: parsed.tableId })
  if (parsed.viewId.length > 0) ops.push({ op: 'set', path: [...base, 'viewId'], value: parsed.viewId })
  ```
  **没有 `else unset`**。而 wiki 链接不带 `?table=`，那两句根本不执行 ⇒ 旧的 `tableId` 原样留着。
  于是「重贴一次链接就好了」这个建议**当时并不成立**：贴完 `spreadsheetToken` 被清、`appToken`
  被换成 wiki token，那个外来的 `tableId` 却还在。这正是现场配置长成那样的机制。

#### 现场那个 `tableId` 到底属于谁（真机取证）

| 问题 | 答案 |
| --- | --- |
| `appToken: It5g…` 是什么 | wiki 节点，`get_node` → `obj_type: sheet`、`obj_token: MuVEsnmEbhnYH8tDUyvc0c6Wnch` |
| 拿它问多维表格 `apps/<token>/tables` | `code: 1254003 WrongBaseToken` |
| 拿它问电子表格 `spreadsheets/<token>/sheets/query` | `code: 0`，1 个工作表 `{id: '3a5d28', rows: 199}` |
| `tableId: tblWhRSGf0osJqrE` 属于谁 | **另一个**多维表格 App `RZZQbY4SkaY6z0shZaBcVpQCnhh`（它有 `tblocC5iuHKFspd6`「数据表」与 `tblWhRSGf0osJqrE`「PMS项目管理系统工单」两张表） |

⇒ 这个 `tableId` 不是「不新鲜」，是**外来 id** —— 它指向的那张表跟当前 `appToken` 指向的电子表格
毫无关系。两者同时存在，任何「按 X 取表」的捷径都可能指错。

两边其实是**同一批票的两份副本**（电子表格 80 条、多维表格 80 条，序号集合都是 `1..80`、
状态归一后分布都是 `是 73 / 否 6 / 处理中 1`）。所以用户无论走哪边都能拿到同一批工单，
但配置里留着两套坐标只会让「到底用哪套」变成一道猜谜。

#### 验证

真机三形态全部 `created=1`：① 现场原样（wiki sheet token + 多维表格 tableId 并存）→
首票 `sh-seq-80`；② 纯电子表格 → `sh-seq-80`；③ 纯多维表格 → `reczz28XtT1Chm9E`（无回归）。
修复前形态 ① 直接抛 `WrongBaseToken`。

#### 自测

- `feishu-checks` 新增 1 条：`appToken 是 wiki 电子表格 token、同时还留着多维表格的 tableId 时，
  不能被 tableId 抢走分派` —— `makeSheetServer({ tablesFailCode: 1254003, wikiNodeType: 'sheet' })`，
  断言建出 1 张票、`recordId` 是 `sh-seq-A-1`（走电子表格）、请求里有 `/sheets/v3/spreadsheets/`、
  **没有** `/fields`。
- `dev-run` 新增 1 条：`tableId 与 sheetId 同时配：不拦，但要点出「两种表型各自的坐标」这个矛盾`，
  并反向断言只配一套时不出这条警告（否则每次保存都冒一句无用提醒）。
- `dev-run` 再新增 1 条：`remote.setProjectTable()：贴一条不带 ?table= 的链接，必须把旧的 tableId 清掉`
  —— 用最小 `settings.mutate` 桩记录写入的 ops，断言 wiki 链接会 `unset tableId` 与 `viewId`；
  反过来贴带 `?table=` 的链接时要写进新值、且不能再 unset 掉它。
- 基线：`dev-run` 495 → **498/498**；`feishu-checks` 96 → **97 条**。

#### 教训

1. **任何「配了 X 就不用再验证 Y」的捷径，先问一句 X 是否真的蕴含 Y。** `tableId` 不蕴含
   「这是多维表格」—— 它只说明「某张表里有个这个 id 的数据表」。
2. **一个毛病在两条路径上表现不同时，先怀疑两边认的不是同一件事。** 体检问 `get_node`、
   跑票认 `tableId`，同一份配置得出相反结论。
3. **「重贴一次就好」这类建议，必须先在代码里验一遍再出口。** 我第一次就是这么说的，
   复盘时才发现写入路径根本没清那个键 —— 对一个正在气头上的用户，这种话比不答更糟。
4. **set/unset 必须成对。** 只要有一个分支写了「条件 set」，就要立刻问「条件不成立时旧值怎么办」。

#### 教训

1. **任何「配了 X 就不用再验证 Y」的捷径，先问「X 是否蕴含 Y」。** 不蕴含的话，这条捷径省下的
   那一次请求，迟早会由用户在别处付出一次排查。
2. **`tableId` 与 `sheetId` 不是两套并列的定位方式**，而是两种表型各自的坐标。配置里它们长得一样
   （都是平级字符串），运行期却互斥 —— 这种「形态上看不出区别」的矛盾必须在某一层显式说出来。
3. **体检全绿不等于能跑。** 体检与适配器是两份实现（体检要能在不跑票的前提下验权限，这个分法没错），
   但它们必须对同一份配置得出同一个「是什么表」的结论。体检的绿色会主动掩盖故障。
4. **静默失败最贵。** 这条 bug 从头到尾没有任何一条错误日志出现在人看得见的地方 ——
   它只在后台 tick 里抛一次、然后被吞掉，表现成「扫描跑了但没票」。

---

### 1.31 带截图的工单在 ⑤ 站崩：内容块的字段名是宿主的契约（2026-11-11 真实事故）

#### 现场

pms 第一张真实工单 `sh-row-81`（电子表格第 81 行，项目编号 80）带一张附件形态的截图，
10:11 跑到 ⑤ 站直接失败：

```
agent 这一轮以错误结束：Cannot read properties of undefined (reading 'attachmentId')
```

同时入队的其它票（没有截图）一路正常。**「只有带截图的票崩」** 是这个 bug 的关键特征。

#### 根因

内核渲染消息内容块的地方 `src/core/prompt.js` 的 `renderTicketContent` 原先写：

```js
blocks.push({ type: 'image', image })   // 字段名是我们自己起的
```

宿主 `@deepseek-ai/dsh-llm` 的契约是 `ImageBlock`：

```ts
export interface ImageAttachmentRef {
    attachmentId: AttachmentId
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
    name?: string
    originalDimensions?: { width: number; height: number; }
}
// ImageBlock: { type: 'image'; attachment: ImageAttachmentRef; offloaded?: boolean }
```

宿主读的字段叫 `attachment`，而且处处写 `block.attachment.attachmentId`：
`collectImageRefs`、`imageIdentity`、`textOnlyImageText`、`llm-pi-ai` 的 `case "image"`、
`llm-deepseek` 的 upload index 校验（后者还要求形如 `sha256:<64 hex>`）。
我们的块没有 `attachment` ⇒ 宿主取 `undefined.attachmentId` ⇒ 崩在宿主自己的代码里，堆栈里连我们的文件名都没有。

#### 更值得记的：自测把错误形状抄了进去

这条链路本来就断言过（`scripts/dev-run.mjs` 的 §11「截图进 prompt」那节、
`scripts/chain-smoke.mjs` 的端到端那一节），但两边写的都是：

```js
assert.equal(imageBlocks[0].image.refId, 'img-1')   // dev-run
for (const block of images) assert.ok(block.image)   // chain-smoke
```

**断言照着实现写的，而实现在照着自己的想象写。** 两边自洽 ⇒ 498 条全绿；
真正的契约方（宿主）从没被引用过一次。改完实现之后这两条断言立刻变红 ——
它们并不是「测到了」，只是「附和了」。

#### 修法

- `src/core/prompt.js`：块改成 `{ type: 'image', attachment: image }`，并补 `ImageAttachmentRef` 的 typedef（照抄宿主声明），
  文件头写清为什么字段名必须是 `attachment`。
- `src/contracts/work-executor.js` 的 `ExecCtx.content` 与 `src/adapters/executor-agent/index.js` 的 `buildMessages` JSDoc 同步改。
- 两条断言改成断言 `attachment`，并加一条反向断言 `assert.equal(imageBlocks[0].image, undefined)`。

#### 自测

- `dev-run`：断言从 `.image` 改成 `.attachment`，并新增反向断言
  「不能把引用放在 `image` 字段上」—— 改回旧写法会红。
- `chain-smoke`：同样改断言，并新增反向断言。
- 基线不变：`dev-run` **498/498**、`chain-smoke` **11/11**、`client-smoke` **219**、`feishu-checks` **97**。

#### 影响面

`grep "type: 'image'"` 在 `src/` 下只命中 `src/core/prompt.js` 一处（另两处是 JSDoc 注释）；消费端只有 `src/adapters/executor-agent/index.js` 的 `buildMessages`，它把 `ctx.content` 原样交给 `createUserMessage({ content })`，不改形状。
其余执行器/推送适配器不碰内容块 ⇒ 修一处即可，不存在第二份实现。

#### 教训

1. **跨进程边界的结构体，字段名归对面所有。** 名字对不对，唯一权威是宿主的类型声明，
   不是我们的注释、也不是我们的直觉。
2. **自测里断言外部契约形状的那几条，必须能从契约本身引证。** 否则它只是在给实现盖章：
   实现错了它跟着错，还替错误背书。
3. **「只有带 X 的输入才崩」先看有没有一段只在 X 存在时才走的分支。** 全绿 + 少数输入崩溃，
   通常说明测试的输入面比真实输入面窄。
4. **崩在别人代码里的堆栈，第一时间找「我们交给它什么」。** 报错在宿主的 `attachmentId`，
   根因在我们的块结构；堆栈里没有我们的文件名，不代表不是我们的事。

### 1.32 40 分钟改一个小功能：任务书没给边界，执行器也没在看（2026-11-11 真实事故）

#### 现场

用户 `sh-row-81` 跑到 ⑤ 站后，整票在 **40 分钟硬超时**被判失败，回填与通知都没做成。
票上留的原因只有一句「超时」，看不出它这 40 分钟在干什么。

解 agent 的会话日志（`.scratch/_sessstats.cjs` 统计调用分布与间隔，`.scratch/_readpattern.cjs`
统计每文件读/搜/写次数）得到的事实：

| 指标 | 数值 |
|---|---|
| 会话跨度 | 2422 秒（约 40 分钟） |
| 工具调用 | 63 次（全部是 `run_code`） |
| 涉及文件 | 23 个，**平均每个文件被读 2.0 次** |
| 单次调用间隔最长 | 119 / 103 / 102 / 82 / 77 秒 |
| **写/改过的文件** | **0 个** |

它是真的在干活 —— 一直在读，一直在搜，`session.seq` 全程都在涨。**它就是一次代码都没改。**

#### 两个独立的病

**病一：任务书没有边界。** `src/core/prompt.js` 的 `## 代码定位` 那节只说「先读仓库结构，
自己判断工单说的是哪个页面/接口」，**没说读到什么时候该动手**。于是它可以无限读下去，
每读一轮就是一次完整的模型往返 —— 39 分钟里 63 次调用，平均 38 秒一次。

**病二：执行器在盲等。** `src/adapters/executor-agent/index.js` 的「4. 等 agent 干完」
只有一句 `await waitForAgentIdle(agent, signal, cancelAgent)`，一次性放行到结束，
中间没有任何干预点。全文件 `grep setTimeout|setInterval|progress|stall|elapsed` 零命中
—— 它没有任何停滞检测。于是「卡在读文件上」和「正在飞快改代码」在它眼里一模一样。

#### 修法

**(a) 任务书给探索预算**（`src/core/prompt.js` 新增 `## 工作方式` 一节）：

> **⚠ 本节描述的第一版措辞已被同日晚的 §1.34 推翻。** 第一版写的是「超过 12 次就按目前
> 最好的判断改，然后在说明里写清还有哪几处没确认」—— 用户当即指出这是把「快」放在「对」
> 前面：流水线要的是真正修好，不是交一版「大概是这儿」的改动。现在的口径见 §1.34。
> 下面保留第一版原文，用来看演进。

- 先动手，再补细节：读到能说出「要改哪个文件的哪一段」就开始改第一版。
- **探索预算：读文件/搜索合计不要超过 12 次。** 超过还没定位到，就按目前最好的判断改，
  然后在说明里写清「还有哪几处没确认」。
- 同一类信息只查一次：读过的文件别重复读同一区段，定位到的符号别再全局搜一遍。
- 不要为了确认而确认：编译/测试会告诉你对不对，先改一版跑一次。
- 卡住就停：12 次之内既定位不到也说不清该改什么，就停下来说清查了什么、卡在哪
  —— 这会被当成「需要人补信息」，比超时好。

**(b) 执行器加停滞看门狗**（`waitForAgentIdle` 新增第 4 个 `options` 参数）：

关键设计决定：**进步信号只能看文件，不能看 `session.seq`。** 事故里 seq 全程都在动，
按 seq 判是「一直在进展」，按文件判是「一步没走」。所以：

- 每醒来一次跑一次 `git status --porcelain` 当工作区指纹（`PORCELAIN_STATUS_ARGS`
  已在 `assertAllowedGit` 白名单里，不产生任何副作用、不碰索引）。
- 指纹超过 `agentStallWarnMinutes`（缺省 **8 分钟**，见 `BUILTIN_LIMITS`）没变
  → `onPhase('editing', ...)` 记一条时间线（否则人不知道为什么突然催它）+ 催一句。
- 最多催 `agentStallNudges`（缺省 **2**）次。**催了不杀**：催一次成本一轮往返，
  杀一张票成本整张重跑；催了还不动说明不是「忘了动手」而是模型/工具坏了，交给硬超时兜底。
- 文件一有变化就把计时归零、催的次数也归零 —— 「在改」不能被当成「卡住」。

**停滞判定放在每轮循环开头，而不是「不空闲」那个分支里。** 这是自测抓出来的：
`await agent.whenIdle()` 本来就会阻塞到 agent 空闲，循环体每执行一次就代表它刚做完
一批工具调用 —— 那是唯一能观察到它的地方。放进「不空闲」分支等于把观察点放到一个
实际进不去的分支里（测试里 `snapshots.length` 一直是 0 就是证据）。

**催的话术不提「你花太久了」**：模型会解释自己为什么慢，白烧一轮。第一版给的是
「挑最有把握的那一处，直接改」+ 一个出口 —— **这句「挑最有把握的那处」同样在 §1.34 被推翻**
（那是交半成品的许可）。现在给的是「再走一遍两条定位路径」+「定位不到就说缺哪一条信息」。

**(c) 免费通知**：见 §1.33。三件事同一次提交，因为都是这张超时票逼出来的。

#### 自测

`dev-run` **504 → 508**（探索预算 1 条、停滞 4 条）；**同日晚再加 1 条变 509，见 §1.34**：

- 「任务书里必须有探索预算：不许无限读下去，先改一版再补细节」—— 断言 `## 工作方式` /
  「先动手，再补细节」/「探索预算」/「不要超过 12 次」/「同一类信息只查一次」/「卡住就停」。
  （§1.34 已把这条用例改名并换成「探索预算 12 次」+ 三条质量底线断言 + 一条反向断言。）
  删掉任一条都会红：这不是措辞问题，是「删了它就等着超时复发」。
- 「停滞监控：文件一直不变时按『文件没变』判停滞，而不是按 session.seq（它一直在涨）」——
  假 agent 让 `session.seq` 每次都变、`whenIdle` 每次推进 60 秒、快照恒定不变；
  断言看了 ≥2 次快照、催了 1–2 次、时间线有记录、分钟数真实。**这条就是事故的复现器。**
- 「停滞监控：文件一有变化就重新计时」—— 快照每次都不同，`onStall` 里直接抛错，
  证明「在改」不会被判成「卡住」。
- 「催话术说的是『现在该做什么』，不是『你花太久了』」—— 断言含「直接改」「停下来」，
  且不含「为什么/太久/慢」。
- 「BUILTIN_LIMITS 里有停滞阈值，且是『分钟』量级」—— 断言阈值 >0 且 <40
  （必须小于硬超时，否则永远轮不到触发）、催的次数是 ≥1 的整数。

#### 教训

1. **「超时」不是原因，是结果。** 票上写「超时」时，真正的信息在会话日志里 ——
   它花了多少秒、调了多少次、读了多少文件、写了几个文件。不量化就只能猜。
2. **没有边界的任务书会把模型拖进无限探索。** 模型不是懒，是没有「该动手了」的信号；
   给一个具体数字（12 次）比说「不要读太多」有用得多。
3. **进步信号要选「真的关心」的那个量。** 我们关心的是「代码有没有动」，
   而 `session.seq`、工具调用次数、消息条数都只是「它在忙」的代理指标 ——
   事故里它们全都健康，只有文件数停在 0。
4. **看门狗放在观察不到的位置等于没有。** 判定逻辑放对了、放进了进不去的分支，
   和没写一样；只有自测能抓出这种错（真人不会盯着一个永远不打印的日志）。
5. **催比杀便宜，但要给上限。** 催一次 = 一轮往返；重跑一张票 = 40 分钟 + 全部上下文重建。

### 1.33 通知不再依赖要实名的第三方：用你自己的飞书应用直接发（2026-11-11）

#### 现场

`sh-row-81` 超时后，⑨ 站发通知失败：

```
pushplus：905 账户未进行实名认证
```

PushPlus 的 ClawBot 渠道要实名认证（付费）才能用；官方额度表里未实名用户每个渠道额度都是
**0 次**。用户问得很直接：「为什么都是第三方 推荐使用第三方的吗 不能自己集成吗」。

#### 结论：能自己集成，而且早就具备条件

真机探针（`.scratch/_feishu-im-probe.cjs`、`_feishu-dm-probe.cjs`、`_feishu-send-probe.cjs`）：

| 探测 | 结果 |
|---|---|
| `GET /open-apis/bot/v3/info` | `code:0`，机器人名「Mentality的工作流智能助手」⇒ **应用本来就带 IM 能力** |
| `GET /im/v1/chats` | 0 个群 |
| 按邮箱查 open_id（`contact/v3/users/batch_get_id`） | `99991672`，缺 `contact:user.id:readonly` |
| `GET /contact/v3/users` | 成功，唯一用户 `ou_68380a136afe29e800b6225e25a94a6c` |
| 发给机器人自己的 open_id | `230013 Bot has NO availability to this user` |
| 发给上面那个用户的 open_id | **`code:0` + `message_id: om_x100b600a00e0c138b085f97545dd125`** |

关键认知：`230013` **不是**「没有发消息权限」（那会回 `99991672` 并点名缺哪个 scope），
而是**机器人的「可用范围」里没有这个人**。解法是开放平台「应用功能 → 机器人」把可用范围
设成包含目标用户，或把机器人拉进群用 `chat_id`。

#### 实现

新增 `src/adapters/push-feishu/index.js`（约 400 行），与其余推送适配器同一契约
（`{ id, send(msg, signal) → PushReceipt }`）：

- `POST /open-apis/im/v1/messages?receive_id_type=<open_id|email|chat_id>`，
  body `{ receive_id, msg_type: 'text', content: JSON.stringify({ text }) }`。
  **`content` 必须是字符串化的 JSON**，传对象会被拒。
- 认证接口 `POST /open-apis/auth/v3/tenant_access_token/internal` 的响应体
  **没有 `data` 包装**，`tenant_access_token` 在顶层 —— 这里踩过一次。
- token 进程内缓存，提前 60 秒过期（与 `source-feishu` 的单飞做法不同：推送是低频动作，
  简单缓存够了）。
- 复用读工单表那对应用级凭据（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`），不新增凭据项。
- **收件人缺失时构造不抛**：装插件时配置常为空，在这里抛会让整插件挂载失败。
  第一次真发才报 `invalid-input` 并点名 `receiveId`。
- 错误分类：`99991663/99991664`→`auth`；`230013`→`invalid-input`（附「去设可用范围」的修法）；
  `230001/230002`→`invalid-input`；`99991400/230020`→`rate-limit`；其余→`internal`。

接线三处：`src/index.js` 的 `PUSHES` 注册表 + `pushAdapterOptions` 的 `feishu` 分支；
`src/core/config.js` 的 `pushAdapter` enum 加 `'feishu'`，新增 `feishuPush.receiveId` 与
`feishuPush.receiveIdType` 两个键（`notify` 组），顶层配置键 25 → **27**。

真机验证（`.scratch/_push-feishu-live.mjs`）：
`[debug] push-feishu：已受理 om_x100b600a174890a8b0f030fb0e75325`，
回执 `{"accepted":true,"traceId":"om_x100b600a174890a8b0f030fb0e75325"}`。

#### 自测（新增 5 条）

- `PUSHES` 里有 `feishu`，且能造出 `id: 'feishu'` 的适配器。
- 发的形状对：先换 token 再发消息、URL 带 `receive_id_type`、`msg_type: 'text'`、
  **`typeof body.content === 'string'`**、`JSON.parse(content).text` 含正文。
- `230013` 要说清人该干什么（`kind === 'invalid-input'` 且文案含「可用范围」）。
- 没有收件人时构造不抛、真发才报 `invalid-input`。
- 组合根能把飞书应用凭据读取器注入进去（`apply()` 不抛且注册 ≥5 个工具）。

#### 注意事项

`accepted: true` **只代表飞书服务端收下了请求，不代表人收到了**。这个纪律与
PushPlus / QQ 邮箱一致：日志只记 `message_id`，不说「已送达」。

#### 教训

1. **「要第三方」通常是没查过自己手里已有什么。** 应用本来就有 IM 能力，
   探一次 `/bot/v3/info` 就知道了 —— 这一条省掉一个付费依赖。
2. **错误码要读到「它到底在拒绝什么」。** `230013` 看起来像权限问题，
   实际是机器人可用范围；判错方向会让人去开一堆用不上的 scope。
3. **配置项缺失不该在构造期炸。** 插件挂载失败会牵连整条流水线，
   而「还没填收件人」是个完全正常的中间状态。
4. **同一对应用凭据可以服务两件事**（读表 + 发消息），但权限要分开开通 ——
   所以适配器里不假设「能读表就能发消息」。

### 1.34 预算不能变成「交半成品」的许可：两条真正的定位路径（2026-11-11）

**用户原话**（同一天，紧接着 §1.32 交付之后）：

> 效率提高 但是要保证质量啊任务要完成 不能是按最好的判断改一版 要做到最好
> 根据操作流程定位页面 然后通过页面信息和截图解决问题描述。

这三句话把 §1.32 的修法否掉了一半。剩下一半（停滞看门狗）是对的方向，但任务书那部分
**把「快」放在了「对」前面**：原措辞是「超过 12 次就按你目前最好的判断改，然后在最终说明里
写清还有哪几处没确认」。这条路的终点是「每张票都交一版猜的改动」—— 比超时更糟，因为超时
至少看得出来，猜的改动会当成做完了往下走（还会回填表格、发通知）。

#### 改法一：预算是「逼你瞄准」，不是「允许你交差」

`## 工作方式` 整节重写，第一句换成结论：

> **你要交的是真正修好的改动，不是一版「大概在这儿」的猜测。** 下面几条是让你更快地改对，
> 不是让你更快地交差。

预算那条改成三段：

- 12 次这个数字是**逼你瞄准**的，不是「读满 12 次就可以随便改」。
- 真到了 12 次还没定位到，说明**线索不够** —— 这时应当停下来说明「还缺哪一条信息才能定位」
  （例如操作流程没写是哪个页面、截图看不清、问题描述有歧义），当成「需要人补信息」。
- **绝对不要交一版自己都不确定能修好的改动。**

「读完 12 次怎么办」的出路从「猜着改」变成「说出缺什么」。这两种出路对流水线的价值完全不同：
前者产出一张看起来 done、实际没修的票，后者产出一次明确的人工介入请求。

#### 改法二：把「怎么定位」写成可执行的两条路径

原来 `## 代码定位` 只说「先读仓库结构，自己判断工单说的是哪个页面」—— 等于把定位这个
最需要方法的一步全推给模型自由发挥，它当然选最顺手的方式：全仓搜关键词、然后挨个读。
这次直接把两条高效路径写进任务书，新增整节
**「定位到具体页面：按「操作流程」走，别在全仓里漫游」**：

**路径一（主路径）：操作流程 ⇒ 页面 ⇒ 组件 ⇒ 接口。**

1. 工单里的 **「操作流程」那一列就是用户走过的页面路径**（先点哪个菜单、再进哪个列表、
   最后在哪一步出错）。按它去找代码，比按关键词全仓搜索快一个数量级。
2. 先从操作流程里框出**出问题的那个页面**（列表页 / 详情页 / 弹窗 / 某个按钮所在的表单）。
3. 在源码里找这个页面对应的路由与页面组件（前端看 `router` / `views` / `pages`，
   后端看 controller 路径）。
4. 只读这个页面组件 + 它直接调用的接口（通常 2–4 个文件就够），确认数据怎么来、怎么显示。

**路径二：截图里的字面量 ⇒ grep 源码。**

> **截图是证据，不是配图。** 图上出现的标题、按钮文字、表头、字段名、报错文案，
> 都是可以直接在源码里搜的字面量 —— 拿它们去 grep，往往一步就命中页面。

并给了「截图 vs 问题描述」对不上时的分流判断：

| 现象 | 问题大概在哪 |
|---|---|
| 截图显示得不对（错位 / 缺失 / 数值不对） | 渲染或取值 |
| 截图正常但操作后状态不对 | 提交、刷新或状态流转 |
| 截图里有报错文案 | 直接搜那句话 |

这一节把「定位」从一个模糊动作变成三条可照着走的步骤，比原来那句「自己判断」具体得多。
`## 代码定位` 也同步删掉与之冲突的「先读仓库结构」，改成指向这一节。

#### 改法三：催话术也不能说「随便改一个」

`createNudgeMessage` 原来写「现在请立刻做这件事：挑你目前**最有把握的那一处**，直接改」——
和任务书同一个毛病。现在换成把两条定位路径再讲一遍（操作流程 ⇒ 页面、截图 ⇒ grep），
出路改成「定位不到就说出还缺哪条信息，不要硬猜一个改动交上去」。

#### 自测

`dev-run` **508 → 509**：

- 原「任务书里必须有探索预算」那条改名成「任务书里必须有探索预算，且预算不是『随便改一版』
  的借口」，新增三条质量底线断言（`你要交的是真正修好的改动` /
  `绝对不要交一版自己都不确定能修好的改动` / `缺哪一条信息`）
  **加一条反向断言**：`assert.doesNotMatch(prompt, /按你目前最好的判断改/)` ——
  这句一回来就红，因为它是「允许交半成品」的原话。
- 新增用例「任务书要给两条定位路径：按操作流程走页面、拿截图里的字面量搜源码」，
  断言有一节 `## 定位到具体页面`、「操作流程」那一列就是用户走过的页面路径、
  框出出问题的那个页面、只读这个页面组件 + 它直接调用的接口、
  截图是证据不是配图、都是可以直接在源码里搜的字面量、拿它们去 grep。
- 「催话术」那条改名成「催话术给的是『怎么定位』，不是『你花太久了』也不是『随便改一个』」，
  新增断言 `操作流程` / `截图` / `grep` / `还缺哪一条信息` / `不要硬猜一个改动交上去`，
  并加反向断言 `doesNotMatch(/最有把握的那一处/)`。

#### 教训

1. **「快」和「对」冲突时，流水线永远选「对」。** 交一版猜的改动比超时更糟：超时看得见，
   猜的改动会当成做完了往下走（还会回填表格、发通知）。
2. **预算类约束必须同时写清「超支了怎么办」。** 只写数字，模型会自己发明出路；
   而它发明的出路通常是「先随便改一个」。出路必须显式指定成「说出缺什么」。
3. **把「怎么定位」写进任务书，比把「别读太多」写进任务书有用得多。**
   限制读的次数只是在压制行为；给出更快的路径才是真的提高效率，而且顺带提高准确率。
4. **同一个口径出现在几处就要一起改。** 任务书改了、催话术没改，等于留了一个后门
   （恰好是在 agent 最卡住、最容易乱来的时候触发）。自测给两处都钉了反向断言。

---

### 1.35 体检自己的白名单没跟上适配器（2026-11-11）

用户说「现在推送就用飞书吧」之后，把 `cordis.patch.yml` 的 `pushAdapter` 从 `pushplus`
改成 `feishu`、补上 `feishuPush.receiveId`，再跑体检 —— 结果体检自己报了红：

```
❌ 通知：feishu（不认识的值）
阻断（不修就跑不了票）：
· pushAdapter=feishu 不是认识的通道（只能是 mock / pushplus / qqmail）——通知不会发出去。
```

**根因**：`src/tools/pipeline-doctor.js` 的通知检查是一串 `if / else if`，白名单写死成
三个值。上一轮加 `pushAdapter: feishu` 时改了适配器、`src/core/config.js` 的 enum、
`src/index.js` 的 `PUSHES` 注册表 —— **三处都改了，第四处（体检）漏了**。

这正是体检最容易犯也最伤的一种错：它的职责是把「看起来配好了其实不行」提前暴露，
一旦它自己成为那个「看起来不行其实行」，人就会去改一个本来正确的配置（或者干脆放弃新通道）。

#### 修法

`src/tools/pipeline-doctor.js`：

1. 加 `feishu` 分支：印出 `收件人类型 → 收件人`，声明体检不真发（有副作用），
   并**提前说清 `230013` 是「机器人可用范围里没有这个人」而不是缺 scope** ——
   判错方向会让人去开放平台开一堆用不上的权限。
2. 收件人没填算**阻断**（票跑完却通知不到人，属于「跑不出去」），
   文案指明去设置页「参数 → 通知」填。
3. 凭据要求复用 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，但**不与「有飞书项目」那条重复添加**
   —— `if (pushAdapter === 'feishu' && !requiredRefs.some(i => i.ref === 'FEISHU_APP_ID'))`。
   同一行在体检里出现两次，重复告警会训练人忽略体检输出。
4. `mock` 与「不认识的值」两条文案里的通道清单补上 `feishu`。

#### 自测（509 → 511 → 512）

- 「pipeline_doctor 认得 pushAdapter=feishu（别把配好的通道报成不认识）」——
  断言 `ok === true`、`problems` 为空、**反向断言** `doesNotMatch(/不认识的值/)`、
  正文含「飞书直发」/「230013」/ 收件人 open_id。
- 「pushAdapter=feishu 但没填收件人 → 阻断，并说清去哪儿填」——
  断言 `ok === false`、阻断项点名 `feishuPush.receiveId`、正文含「参数」。
  踩了个小坑：第一版断言写 `out.problems`，但收件人缺失进的是 `blockers`
  （`problems` 是「能跑但结果不对」，`blockers` 是「跑不了」），改成两个都看。

#### 教训

1. **加一个可插拔实现，要盘点所有「枚举了它」的地方。** 这次是适配器 / config enum /
   PUSHES 注册表 / 体检白名单四处，改了三处，第四处漏了。
2. **体检本身也要有「别把对的报成错的」的断言**，尤其是反向断言
   （`doesNotMatch(/不认识的值/)`）—— 只断言「坏的说出来了」不够。
3. **阻断 vs 提醒的边界是「能不能跑出去」**：收件人没填 → 阻断；
   机器人可用范围没设 → 因为查不了（缺通讯录权限），只能前置在文案里提示。

---

### 1.36 「交付未完成」的票不都是「票态已完成」（2026-11-11）

#### 现象

跑 `pipeline_status` 时，汇总那行写：

```
交付未完成：4 张（票态已经是完成，但该交给你的东西没交到 —— 见下面带「（表格未回写）」的票）
```

而下面明细里那 4 张，**`phase` 全是 `failed`**：

```
· [sandbox] rec-mock-001｜失败（表格未回写）｜列表页按状态筛选后…
· [sandbox] rec-mock-002｜失败（表格未回写）｜行程记录里出差天数算错…
· [sandbox] rec-mock-003｜失败（表格未回写）｜提交后状态不刷新…
· [pms]     sh-row-81   ｜失败（表格未回写）｜首样测试的第二三步流程…
```

一句「票态已经是完成」和四行「失败」摆在一起，人读到第一反应是「这工具在瞎说」。

#### 根因

`plugins/ticket-pipeline/src/tools/pipeline-status.js` 的汇总段把
「`delivery` 里有哪一项 `ok === false`」直接等价成了「票态是 done」：

```js
const deliveryIncomplete = allTicketsInitial.filter((row) => deliveryIssues(row).length > 0).length
if (deliveryIncomplete > 0) {
  lines.push(`交付未完成：${deliveryIncomplete} 张（票态已经是完成，但该交给你的东西没交到 —— …）`)
}
```

`deliveryIssues()` 只看 `row.delivery`，**完全不看 `row.phase`**。这本来是它的设计意图
（「不管票态是什么，只要该交的东西没交到就要报出来」），但汇总文案自作主张补了一句
关于 `phase` 的话 —— 而那句话在这批票上是假的。

#### 为什么这不是「措辞问题」而是「误导」

两类票要人做的动作完全不同：

| 票态 | 交付缺席的含义 | 人该做什么 |
|---|---|---|
| `done` | 活干成了、提交了，只是表格没回写 | 补一次回填就行，票本身不用重跑 |
| `failed` | 本来就没跑成，回填自然也做不成 | 得 `pipeline_reset` 重跑，光补回填没意义 |

混成一句「票态已经是完成」，人会以为「只是漏了回填」，于是不去重跑；
反过来，若只说「失败」又会漏掉 `done` 那一类真正「只差回填」的票。

#### 修法

汇总行改成**分开数、分开说**，每类给一句独立的话：

```js
const deliveryIncompleteRows = allTicketsInitial.filter((row) => deliveryIssues(row).length > 0)
const deliveryDoneButIncomplete = deliveryIncompleteRows.filter((row) => row.phase === 'done').length
const deliveryFailedToo = deliveryIncompleteRows.filter((row) => row.phase === 'failed').length
if (deliveryIncompleteRows.length > 0) {
  const parts = []
  if (deliveryDoneButIncomplete > 0) parts.push(`${deliveryDoneButIncomplete} 张票态已完成却漏了交付`)
  if (deliveryFailedToo > 0) parts.push(`${deliveryFailedToo} 张本身就跑失败了、交付也没做成`)
  const rest = deliveryIncompleteRows.length - deliveryDoneButIncomplete - deliveryFailedToo
  if (rest > 0) parts.push(`${rest} 张其它状态`)
  lines.push(`交付未完成：${deliveryIncompleteRows.length} 张（${parts.join('；')} —— 见下面带「（表格未回写）」或「（交付未完成：…）」的票）`)
}
```

真机上现在输出：`交付未完成：4 张（4 张本身就跑失败了、交付也没做成 —— …）`。

#### 自测（511 → 512）

新增 `pipeline_status：交付未完成里失败的票不能被说成「票态已完成」`：

- 构造一张 `setFailWrite(true)` 的票 → 正常 tick 后它是 `done` + 回填失败；
- 用 `store.setPhase(ticketKey(projectId, recordId), 'failed', { lastError }, { force: true })`
  把它改成 `failed`（`done` 是终态，正常转移表不允许 `done → failed`，
  所以必须 `force` —— 这里是要造一个**真机上确实存在、但状态机不产出**的行）；
- 断言 `交付未完成：1 张`、**反向断言** `assert.doesNotMatch(out.text, /票态已经是完成/)`、
  并断言失败那一类要如实点名（`/本身就跑失败了/`）。

#### 教训

1. **汇总句里出现关于另一个字段的断言，那个字段就必须真的被读过。**
   这里 `deliveryIssues()` 只看 `delivery`，汇总却断言了 `phase` —— 两个数据源，
   只读了一个。凡是「X 的票其实都是 Y」这类话，写之前先 `grep` 一遍有没有真的读过 Y。
2. **反向断言比正向断言更能抓住「文案与明细打架」。**
   原来的正向断言是 `交付未完成：1 张` —— 那句话改没改都会通过。
   加上 `doesNotMatch(/票态已经是完成/)` 之后，这条路径才第一次真正被锁住。
3. **同一个数字背后可能是两种要做不同动作的票。** 「4 张」本身没错，
   错在把 4 张说成同一类。汇总的价值在于「告诉我要做什么」，
   把不同动作的票并成一句话就等于没告诉。

---

### 1.37 停滞看门狗自己崩了，而且在最该响的 40 分钟里全程失聪（2026-11-11 真实事故）

**现场**：`sh-row-81` 第三次跑（13:50:11 进 ⑤ 站）结局：

```
11-11 14:30:05  ⑤ ✓ 处理工单问题 —— agent 已 40 分钟没有改动任何文件，第 1 次催它先动手（上一站 39 分 54 秒）
11-11 14:30:06  · ✗ 失败 —— 执行器收尾：createUserMessage is not defined（上一站 0 秒）
```

票态 `失败（交付未完成：回填表格、发通知）`，`最近错误：createUserMessage is not defined`。
会话日志：226 帧 / 563 事件 / **62 次工具调用全是 `run_code`**，最后一次工具调用 14:29:59 —— 也就是整整 40 分钟内它一直在读，一次没写完。

上一轮刚加的看门狗**触发了**（14:30:05 那条「第 1 次催它先动手」就是它写的），但它同时暴露两个独立的 bug。

**bug 1：催办那一行引用了不存在的名字**

`plugins/ticket-pipeline/src/adapters/executor-agent/index.js` 里 `waitForAgentIdle(agent, signal, cancelAgent, options)` 是**模块级导出函数**，而真正的 `createUserMessage` 是 `createAgentExecutor()` 里的局部量（`:543` `const createUserMessage = resolveCreateUserMessage(options.createUserMessage)`）。兜底那条写作：

```js
: (mins) => createNudgeMessage(mins, createUserMessage)   // ← 这一层作用域里没有这个名字
```

生产的 `run()` 调用 `waitForAgentIdle` 时只传了 `worktreeSnapshot` / `stallWarnMs` / `maxNudges` / `now` / `onStall`，**没传 `makeNudgeMessage`** ⇒ 必然走兜底 ⇒ 催办那一瞬抛 `ReferenceError`。看门狗把一个「催它继续干活」的动作变成了「把整张票打成失败」。

修法：

```js
: (mins) => createNudgeMessage(mins, resolveCreateUserMessage(undefined))
```

**bug 2：看门狗在最该响的时候全程失聪**

主循环里 `await agent.whenIdle()` **干等** —— 而 `whenIdle()` 只在一整轮 turn 结束时才 resolve。事故形态恰恰是「一轮 turn 连跑 39 分 54 秒、中间一次都没空闲」，于是：

- 该在 8 分钟就响的看门狗，等到 14:30:05（turn 结束那一瞬）才响第一次；
- 一秒钟后票就收尾失败了（14:30:06），催了没有任何意义。

修法是让定时器与 `whenIdle` 竞速：

```js
const pollMs = stallWarnMs > 0 && snapshot
  ? Math.max(1000, Math.min(60_000, Math.floor(stallWarnMs / 8)))
  : 0
// ...
if (pollMs > 0) {
  await waitForIdleWithStallCheck(agent, checkStall, pollMs, signal)
} else {
  await agent.whenIdle()
}
await checkStall()
```

`waitForIdleWithStallCheck` 用 `Promise.race([idle, ticked])`，定时器赢就跑一次 `onTick()`（= `checkStall`）。阈值 8 分钟 ⇒ 每 60 秒醒一次看工作区，这样「一轮 turn 跑 40 分钟」也能在第 8 分钟被叫醒。

**新增两条自测**（`dev-run` 512 → **514**），各锁一个 bug、互不重叠：

| 用例 | 假 agent 的形态 | 抓的是 |
| --- | --- | --- |
| 「一轮 turn 连跑不停时也要能催」 | `whenIdle: () => new Promise(() => {})`（**永不 resolve**） | bug 2 —— 旧实现会挂死在这里，催 0 次 |
| 「催办自己不许崩」 | **不传 `makeNudgeMessage`**，走兜底分支 | bug 1 —— 旧实现在这里抛 `createUserMessage is not defined` |

**两个 bug 都做过回归验证**：把代码临时改回 bug 写法，对应用例立刻变红，且**只红那一条**（bug1 改回 ⇒ 只有「催办自己不许崩」红；bug2 改回 ⇒ 只有「一轮 turn 连跑」红，报 `实际催了 0 次`）。

**四条教训**：

1. **模块级函数不能伸手去摸工厂闭包里的变量** —— 那个名字在定义处根本不存在，只有运行时走到才炸。凡是「兜底 / 默认值」这种平时不跑的分支，尤其要检查它引用的东西在当前作用域里到底有没有。
2. **计时器的对手是「永远不返回的 promise」** —— 用 `await whenIdle()` 做轮询的宿主，等于把轮询频率绑在对方什么时候空闲上；对方一轮跑 40 分钟，你就 40 分钟没法观察它。
3. **看门狗必须能在「对方正在忙」的时候工作**，而不是「等对方忙完了再判断刚才有没有卡住」。后者在语义上是自相矛盾的：等它闲下来，本来就不需要催了。
4. **自测必须造出真实故障的形态**。上一轮那 4 条停滞断言全绿，但假 agent 的 `whenIdle` 是 `async () => { clock += 60_000 }`（立刻返回）—— 恰恰绕开了这次真正出事的那条路径。全部通过的测试如果和事故形态不重合，它的绿色是假的。

**基线**：`dev-run` 512 → **514/514**；`chain-smoke` 11/11；`client-check` ✅（Remote 9 方法）。

---

### 1.38 运行页签三件事：重跑报错、删不掉记录、历史屏看不出全流程（2026-11-11）

**用户的诉求**（原文）：「运行页面的历史 重试报错 也删除不了 优化一下显示历史的ui和展现方式。
项目页面的重新读取失败」。四条，背后是三个互不相干的原因。

**bug 1：「重跑」每次都报错 —— 浏览器侧的位置参数是硬校验**

面板调的是 `ns.reset(recordId)`，只传了**一个**实参，而描述符声明了两个
（`recordId` 必填 + `projectId` 可选）。两级校验的规则不一样：

```js
// 宿主侧（app.asar 的 dsh-typert，assertExactArguments）
const acceptsMissing = new Set(descriptor.parameters.filter((p) => p.source === 'json'
  && (p.acceptsUndefined === true || p.codec.mode === 'src-json')).map((p) => p.wire));
const missing = [...expected].filter((key) => !Object.hasOwn(args, key) && !acceptsMissing.has(key));
// 浏览器侧（prepareInvocation）
const expected = descriptor.parameters.length - (projection?.parameterIndex === void 0 ? 0 : 1);
if (values.length !== expected && !hasCallerSignal) throw new Error(
  `client api: ${endpoint} expected ${expected} argument(s), got ${values.length}`);
```

**`acceptsUndefined` 只在宿主侧生效，浏览器侧只数个数。** 少传一个立刻抛
`client api: ticketPipeline#ticketPipeline/reset expected 2 argument(s), got 1`，
而 `onRunRerun` 的 `.catch` 把它写成「重跑失败：…」，人只看到一条报错。
修法：`ns.reset(recordId, undefined)` —— `undefined` 不会写进 `args`（`if (value !== undefined)`），
宿主侧再靠 `acceptsUndefined` 接住缺席，两头都合法。

**bug 2：项目页「重新读取」必然失败 —— 第一参被当成 namespace**

```js
// 原来
var ns = target !== undefined ? target : getNamespace('ticketPipeline')
```

它同时被当 `onClick` 传给「重新读取」（`onReload: loadProjects`）—— React 把 click 事件对象
塞进第一参，`target !== undefined` 成立 ⇒ `ns` 变成事件对象 ⇒ 报出
「宿主还没提供 ticketPipeline.projects()（Remote 版本比面板旧）」。
**宿主一直是好的**，这句冤枉话把人指向了完全错误的方向。
判定改成「它到底像不像一个 namespace」：`(target && typeof target.projects === 'function') ? target : getNamespace(...)`。
`loadRun` 早先已用「只认布尔」防住同一类问题（`onRefresh: loadRun`），这里是同一个坑换了个入口。

**bug 3：「删除不了」= 根本没有删除能力**

票据只增不删（`store.js` 里没有任何删票方法），历史票在界面上也没有任何清理入口。
三层补上：`store.forgetTicket(key)` / 工具 `pipeline_forget` / Remote `forget(recordId, projectId?)` / 面板「删除记录」。

边界写死在 `tools/pipeline-forget.js` 的文件头，**只删插件本地的票据行**：

- 不碰工单表里那一行、不回滚代码提交、不删工作区；
- 可删的只有 `FORGETTABLE_PHASES = [...TERMINAL, 'needs-info']`；排队中与正在跑的一律拒绝
  （删了正在跑的票，`runOne` 的 `finally` 会摸到一条不存在的记录）；
- **删完不会被下一轮扫描重新收进来**：水位 `seen[recordId]` 还留着，扫描器只在 `!prev` 时才推 `created`；
- 同名 `recordId` 跨项目冲突时不猜，返 `ambiguous` 并列出候选。

按钮叫「删除记录」而不是「删除」，点下去先弹二次确认，把「删什么、不删什么」列清楚 ——
人点「删除」时想的常常是「连同它做的事都别要了」，而那是做不到的。

**UI：历史屏按档位分组 + 每票第二行流程带**

勾上「显示历史」后几十张票平铺，「要我动手的」被埋在「早验收完的」里。改法：

- 按 `RUN_GROUPS`（需要你处理 / 正在跑 / 待人工验证 / 已交付 / 已退役）分组，空组不画；
  宿主要是给了面板不认识的新 phase，落到「其它」而不是吞掉。
- 每票第二行渲染 `tickets[].flow.stations` 的九站符号带：
  `①– ②✓ ③✓ ④✓ ⑤✓（4 分 32 秒） ⑥✓ ⑦✓ ⑧✓ ⑨✓｜全程 13 分 53 秒`。
  符号与宿主 `STATION_MARK` 一致（✓ 做成 / ✗ 没做成 / ▶ 正停在这一站 / – 没走过），
  只有 ≥1 分钟的站标耗时（秒级噪音会让每一站都显示「0 秒」，反而看不出哪里慢）。
- **面板不自己读 timeline 重算站点** —— 口径只在 `describeStations()` 一处，
  重算一遍迟早出现「带子上说停在⑥、结论说停在第⑤站」。

**自测**（`dev-run` 514 → **517**，`client-smoke` 215 → **228**）：

| 脚本 | 新增断言 |
| --- | --- |
| `dev-run` | `apply()` 注册**五**个工具且 `pipeline_forget` 接同一份 store（pending 拒删 / failed 删得掉 / 删完 `getTicket` 为 `undefined`）；`remote.reset(recordId, undefined)` 两个实参；`remote.forget()` 三态（not-forgettable / ok / not-found）；`canReset` 与 `canForget` 两个布尔一起下发 |
| `client-smoke` | 「重跑」调用实参表长度为 2；「删除记录」只挂在 `canForget` 的票上（正在跑的那张没有）；点删除先弹二次确认且文案含「本地 / 工单表 / 不会把它重新收进来」；确认后 `forget(recordId, projectId)` 两实参；分组标题出现；流程带 ①…⑨ 渲染；失败站是 `⑤✗`；正在跑的是 `⑤▶` |

**两条教训**：

1. **`acceptsUndefined` 是宿主侧的概念，别指望浏览器侧认它。** 任何声明了可选参数的
   Remote 方法，调用侧都必须传满位置实参（`undefined` 占位），不能靠「少传一个」表达可选。
   两级校验规则不一致时，报错信息会出现在离真正原因很远的地方。
2. **同一个「处理器兼作回调」的坑会换入口复发。** `loadRun` 修过一次（只认布尔），
   `loadProjects` 又栽了一次（只认 namespace）。凡是既要能被直接调用、又要能当 `onClick`
   传下去的函数，第一参必须做形态判定，不能做 `!== undefined` 判定。

**基线**：`dev-run` 514 → **517/517**；`client-smoke` **228**；`client-check` ✅（Remote **10** 方法）；`chain-smoke` 11/11。


### 1.39 五项优化：预算要能被数、验证命令要同源、记忆是线索不是约束（2026-11-12）

**用户的诉求**（原文）：「该插件还有优化空间」，随后「按顺序开始动手」。
动工的契机是 `sh-row-81` **第一次真正跑通**（2026-11-11 17:09，本地提交 `9829db89422e`，
6 files +650/−36，⑤ 站 48.2 分钟）。既然跑通了，性能数据才有可比性 ——
解会话日志（175 次工具调用 / 47.8 分钟）得到的画像：

| 指标 | 实测 | 含义 |
| --- | --- | --- |
| 第一次写文件 | 第 **46** 次调用、开始后 **21.5 分钟** | 45% 的时间在探索，一行代码还没改 |
| 工具频次 | `read 109` / `grep 50` / `glob 10` / `edit 46` / `pwsh 35` / `compress 9` | 探索 169 次，产出 46 次 |
| 调用间隔中位数 | **10.1 秒**（最长 83 秒） | 时间花在模型往返，不是本地 IO |
| `compress` 时点 | +2.3 / +6.4 / +6.6 / +9.6 / +13.1 分 | 前 13 分钟压了 5 次，上下文压力早就报警了 |

五项改动，边界都在这条链上：**任务书说什么** → **执行器盯什么** → **下一张票能继承什么**。

#### #1 探索预算从「劝告」变成「能被数、会被催」

任务书里写着「**探索预算 12 次**（读文件 + 搜索合计）」，而这一轮实际读了
**109 + 50 + 10 = 169 次**。grep `toolCall|readCount|budget|intercept` 零命中 ——
整条链路**没有计数器**，那句话是纯文本劝告。

新建 `src/adapters/executor-agent/explore-budget.js`（102 行）：

```js
export const EXPLORATION_TOOLS = new Set(['read', 'grep', 'glob', 'search_context', 'list_files'])
export const EXPLORE_BUDGET = 12
export function countExploration (events) { … }   // 按 data.subCallId 去重
export function describeExploration (counted) { … } // 探索 20 次（read 15 次、grep 5 次）
```

**为什么不能数 `tool/call`**：它的 `data.name` **恒为 `run_code`**，一次 `run_code` 里能塞十几个
`read`。真正带工具名的是 `tool/ptc-dispatch` 的 `data.name`（`arguments` 那里已经是解析好的对象）。
2026-11-11 的性能分析第一版就是按 `tool/call` 数的，得出「63 次调用」这个偏小一倍的数字。

**为什么 `pwsh` 不在名单里**：分不清 `git status` 和 `mvn test`；`edit` / `write` 是产出，数进去会
让「改得多」触发「别读了」。

执行器侧（`executor-agent/index.js`）把监控拆成**同一个进度源驱动的两套判断**：

```js
const justChanged = await refreshProgress()   // 一次 git status 同时喂两套监控
await checkStall()                            // 停太久 —— 认「8 分钟没改文件」
await checkExplore(justChanged)               // 读太多 —— 认「read+grep+glob 超预算」
```

顺序有讲究：**必须先刷新指纹再判断**，否则探索监控读到旧指纹，会把「刚改完文件」判成「没改」，
继续念预算。第一版 `checkExplore` 自己又调了一次 `snapshot()`，导致主循环那句 `refreshProgress()`
变成多余且顺序错乱 —— 两条既有停滞用例当场变红（`文件一直在变，绝不该判成停滞`）。

催办话术 `createExploreNudgeMessage` **绝口不提分钟数**：触发条件是「读得多」不是「停得久」，
说「你已经 8 分钟没动了」是假话，模型会先纠正事实、白烧一轮。

#### #2 验证命令只有执行器知道，agent 不知道

`runVerification(options, verify, cwd, signal)`（`executor-agent/index.js:1928`）从
`project.verify` 拿命令跑，**执行器一直知道**；而任务书渲染 `renderTicketPrompt(ticket, located)`
的签名里根本没有 verify。后果：agent 自己去找 `pom.xml` / `package.json` 猜构建方式，
这一轮跑了 **12 次 mvn/npm、花 5.4 分钟**；而项目配置的
`verify.test: node scripts/check-consistency.mjs` 是个**纯静态交叉引用检查**（两秒跑完，
grep `mvn|javac|npm|tsc|vite` 零命中）。

修法：`renderVerifySection(verify)` 成为独立一节 `## 改完怎么验证`，有命令就逐条列出
`- 构建：\`…\`` / `- 测试：\`…\``，并明说「不要自己去找 `pom.xml` / `package.json` 猜构建方式」；
都没配就说「本项目**没有配置验证命令** —— 改完不用为了『跑点什么』去构建整个工程」。
`src/core/scheduler.js` 的 `runOne()` 里 `projects.find(p => p.name === projectId)?.verify` 取出来，随
`promptOptions` 一起下发。

#### #3 「操作流程」列可能只是模块名，不是页面路径

任务书用 13 行要求「按『操作流程』那一列走，别在全仓里漫游」，而这张票的 flow 实际只有
**9 个字**：`项目管理-首样测试`。它照做发现无路可走，只好 `grep 首样`（250+ 处命中）。

`renderFlowSection(flow)` 按长度分流：≥ 15 当页面路径直出；**< 15 则追加
「（这一列只写了 N 个字，是一个模块名，不是可走的页面路径。）」**，并指向「截图字面量 ⇒ grep」
那条路。判据是「够不够长到能当路径」，不是「值是不是空」—— 空值本来就不会进这一节。

#### #4 跨票记忆：跑成功就把「同类问题改过哪几个文件」留下来

`sh-row-81` 摸出来的「首样测试 ⇒ `PmsProductSampleTestServiceImpl` +
`ProductSampleTestList.vue` + `pms_approval_config`」在票收尾那一刻全丢了，下一张同模块的票
从零开始。新建 `src/core/ticket-memory.js`（约 340 行）：

- `extractKeywords(ticket)` 只抽**结构化字段**（`module` 整串、`flow` 整串 + 按
  `-–—/\>»·、，,|；;：:` 切开的每一段、描述里的英文标识符），**中文一律不从问题描述里抽**。
  理由见下面那处「必须记的坑」。
- `remember()` 只在 `finalPhase === 'done' || 'skipped'` 时写；**同一批文件**视为同一条，
  只累加 `hits`、更新 `recordId`、关键词取并集；`files` 为空直接返回（失败票学不到可信东西）。
- `recallMemories()` **只读不写**，`touch()` 单独一个方法记「召回的那些真被用上了」——
  否则重渲一次任务书就把 `hits` 刷高，排序权重全虚。**顺序也不能反**：先 `touch` 上一轮的、
  再 `remember` 这一轮的。
- 记笔记整块 try/catch 包住、只 `logInfo`：**记忆坏了绝不能让已交付的票变红**。
- 存在 domain 的另一张表 `memory`（key = projectId），**`pipeline_forget` 清票后知识仍留着** ——
  票是「这一次」，知识是「这个项目」。

任务书里出现的是 `## 这个项目里同类问题的历史`，措辞固定含三点：
「上次处理同类问题」「可以从这几个文件开始找」「**不一定还是它们**」「这些是历史，不是这次的事实」。

**两处必须记的坑**（都来自真机，见 §1.47）：

1. `extractKeywords` 第一版把所有词截到 24 字，而
   `PmsProductSampleTestServiceImpl`（33 字）被截成 `PmsProductSampleTestSe` ⇒ **永远命不中**，
   而它恰恰是最值钱的检索词。改成标识符走 120 字上限。
2. 第一版用「中文 2–4 字滑窗」从描述里抽词，抽出来全是 `作台中的` / `台中的全` / `全据项`
   这类碎片，把真词稀释掉，于是**该召回的召不回、不该召回的召回了**。现在中文只从
   `module` 与 `flow` 切段取整词。

#### #5 `renderPlanRequest` 是死代码，删掉

`src/core/prompt.js` 里定义了 `renderPlanRequest(ticket)`（「先不要改代码，用 3–6 行说明」），
`src/` 与 `scripts/` 里**零引用、零测试**。要么接上要么删 —— 删。死代码最贵的不是体积，
是「下一个人以为它在生效」。

#### 自测（`dev-run` 517 → **530**）

| 组 | 新增断言 |
| --- | --- |
| 探索预算 | `BUILTIN_LIMITS` 的预算/催次数合法；**任务书里写的数字与看门狗数到的数字是同一个配置项**（`EXPLORE_BUDGET === BUILTIN_LIMITS.agentExploreBudget`，`renderTicketPrompt(t, {}, { exploreBudget: 7 })` 含「探索预算 7 次」）；只数 `read/grep/glob` 不数 `edit/write/pwsh` 且同 `subCallId` 去重；读超了要催且**话术不含「分钟」**；已经开始改文件就不再念预算 |
| 跨票记忆 | `extractKeywords` 四类词；`recallMemories` 排序（命中词数 → `hits` → `at`）；`describeMemory` 三点措辞 + 空 files 返回 `''`；`remember` 同批去重 / 累加 `hits` / 关键词并集 / 新排最前 / 空 files 不写库；`touch` 与 `recall` 分离；`limit: 3` 截断；**端到端两票**（第一票成功后第二票任务书里看得到、且 `hits` 只为已被用上的 +1）；失败票不动记忆；记忆坏了不影响交付 |

**回归验证**（`.scratch/_reg/patch.mjs`，只能红对应那一条）：把 `done||skipped` 改成 `if (memory)` →
只红「失败不动记忆」；把 `logInfo` 换成 `throw error` → 只红「记忆坏了不影响交付」；
把 `touch` 那行改成 `if (false)` → 只红端到端 `hits`；在 `recall` 里就地 `hits += 1` → 红「recall 纯读」
与端到端；把标识符上限改回 24 → 只红 `extractKeywords`。

**三条教训**：

1. **写在提示词里的数字，必须和执行侧读的是同一个配置项。** 否则「文案写 12、实测 169」这种
   分裂会一直存在，而且没有任何报警 —— 只有解会话日志才看得见。
2. **一个能力在系统里有多个持有者时，使用者往往是最后一个知道的。** 验证命令在项目配置里、
   执行器手里都有，唯独要跑它的 agent 没有。
3. **计数要数你真在意的那个量。** `tool/call` 是 `run_code` 的计数，不是「读了几次文件」的计数；
   `session.seq` 是事件的计数，不是「有没有进展」的计数（2026-11-11 §1.37 已经栽过一次）。

**基线**：`dev-run` 517 → **530/530**（本节当年；现在 551）；`chain-smoke` 11/11；`client-check` ✅（Remote 10 方法，现在 11）；`client-smoke` **228**（现在 272）。


### 1.40 第二轮产品评审的落地批次：把「它到底在不在跑」和「配完对不对」变成看得见的事（2026-11-12，工单 #39–#43）

第一轮（22 张票）解决的是「能不能用」，这一轮解决的是「敢不敢交给别人用」。评审时按
「用户此刻最会被卡在哪」排了优先级，然后**按那个顺序一件件落地**（用户原话：
「按照这个优先级开始优化」）。

#### P0-2 飞书直发通知在面板上整条路走不通

`pushAdapter` 的枚举有四个值（`mock` / `pushplus` / `qqmail` / **`feishu`**），
`push-feishu` 适配器也写完了，`feishuPush.receiveId` / `receiveIdType` 两个键都在，
`pipeline_doctor` 连 230013 的提示都有 —— **只有面板的 `notifyVisibility(adapter)` 漏了这一支**。

后果不是「少两个输入框」：选了飞书之后收件人字段被隐藏、旁边还写着「当前是 mock：不会真的
发通知」、保存后体检报「缺 `feishuPush.receiveId`」，而界面上没有任何一格能填。**这条路
从面板出发根本走不完。**

修法：`notifyVisibility` 补第三分支 `keep: ['pushAdapter','notifyOn','feishuPush.receiveId','feishuPush.receiveIdType']`
+ 一句 note（App Secret 复用「凭据」页那一对、230013 是「机器人可用范围」不是缺权限）；
`ENUM_LABELS.pushAdapter.feishu` 补中文说法。

**教训**：枚举、适配器、配置键、体检提示四处都齐了，唯独**用户能走到的那一处**没接 ——
这类缺失在看代码时最难被当成 bug（每一处单看都对）。
自测要钉的反向判据是「选了 feishu **不许**说『当前是 mock』」，光断言「字段出现了」不够。

#### P0-1 扫描失败对用户完全不可见

`scheduler.js` 扫表失败时写的是 `result.status = 'scan-failed'` 并记一行日志；`result`
只活在 `tick()` 的返回值里，而 `pipeline_status` 和面板都不读它。`lastScanAt` 只写在
工单源水位里（`store.saveWatermark`），**同样没有任何消费方**。

于是凭据过期、表被移出协作者、网络出口断掉 —— 插件安静地什么都不做，而运行页上的
「没有未收尾的工单」与「一切正常」长得一模一样。

修法：
- `store.listWatermarks()`（水位是唯一跨重启还在的东西）；
- `scheduler` 加内存快照 `scanState` + 导出 `getScanState(nowAt)`，内存与水位取较大者；
- `pipeline_status` 出 `scan` 对象（`lastScanAt` / `lastAttemptAt` / `nextScanAt` / `pollIntervalMs` /
  `lastError` / `lastErrorKind` / `consecutiveFailures` / **`alarm`**），并渲染
  「扫描：上次 X 前（下次约 Y 后会再扫）」+ 失败行；
- **`alarm` 的阈值（≥3 次）写在工具侧**，不写在面板里 —— 「工具文案与面板颜色」必须同一口径；
- `lastError` 只放人话，**不带 `kind:` 前缀**（`kind` 进结构化字段）；
- **被人工取消不算失败**，不污染 `scanState`。

**教训**：`formatDuration(ms)` 是三段口径（`<60` → `N 秒`；`<60 分` → `N 分 S 秒`；否则
`H 时 MM 分`），断言必须拿**实际输出串**比，别按自己脑补的换算写。

#### P1-3 队列吞吐：一轮只跑一张

`tick()` 原先 `store.pickNext()` 取一张、跑完就 `return`，剩下的等下一个轮询周期
（`pollIntervalMinutes`，缺省 3，用户配到了 60）。**5 张票 × 60 分钟 ⇒ 最后一张等 4 小时。**

修法：`tick()` 里改成串行 `for` 循环，跑到「队列空 / 预算用尽 / 被取消」为止；
`maxTicketsPerTick` **缺省 1（= 老行为）**，装配层传 `BUILTIN_LIMITS.maxTicketsPerTick = 5`；
上限 20 是护栏。**并发仍恒 1** —— 连点两次不会加速，任何时刻只有一张在跑。

为什么不放进 `CONFIG_FIELDS`：它是**代码节奏**，不是环境差异，用户没有判断依据；
放了只会多一个「设错了还怪插件」的旋钮。5 这个数的理由是「取消是逐张生效的」：
再大就会让人按了取消之后等太久。

`TickResult` 新增 `ranAll`（`ran` 保留「本轮第一张」的老语义）——
`maxTicketsPerTick > 1` 时只看 `ran` 会漏掉后面的票。

#### P1-4 项目级开关 + 「只跑这个项目」

`projects[].enabled`：**只有显式写 `false` 才落盘**，不写这个键 = 启用 ⇒ 老配置零迁移。
写成字符串 `'false'` 是典型 YAML 手误，**必须报错**：静默当成「没关」会让「我以为我关了」
变成最难查的那一类问题（票照跑、表照样被回填）。

运行时**每次重读 `config.projects`**（`pausedProjects()`），不在 `createScheduler()` 时算一次 ——
配置改了宿主会重建插件，但重建前已经在跑的那一轮仍可能拿着老对象，而人的预期是
「我关掉就别再动」。关掉的项目的表**连都不去读**：不是「读完再扔掉」，而是根本不该产生
那次远端请求（表被移出协作者的人最不想的就是每轮都失败一次）。

`store.pickNext(options)` 新增 `projectId`（只挑一个）与 `excludeProjects`（暂停的项目不挑）。
**用「排除谁」而不是「只允许谁」**：配置里删掉的项目留下的历史票不该因为不在白名单里
就永远挑不出来（那会变成一张谁也跑不了的死票）。

`pipeline_scan` 加可选 `projectId`；Remote 的 `scan(projectId)` 空串归一成 `undefined`。

#### P1-5 补做只在重启时发生

`replayPendingEffects` 原先只有 `apply()` 里调一次 —— **补做回填 / 补发通知只在重启时发生**，
长时间不重启就一直挂着（`delivery` 里记着 `attempts` 与 `giveUp`）。

修法：挂进 `tick` 的收尾，节流 `REPLAY_INTERVAL_MS = 30 * 60_000`；`lastReplayAt` 初值取
建调度器那一刻（装配层已经补过一次）。三条边界写进注释：**被取消不补 / 补做炸了不影响
本轮结果 / 只跑一个项目时不补**。30 分钟的理由：补做是真发通知，太勤就是骚扰。

#### UI① 高危配置项的「后果提示」

面板上每个字段只说「它是什么」，不说「改了会怎样」；于是**最危险的开关看起来最无害** ——
「处理完回填表格」关了只是少一个亮着的小滑块，真实后果是表格那行永远停在「处理中」、
下一轮扫描把同一张票当新票再收一遍。

`RISK_HINTS` 的口径：**只在当前值处于「已经开始付代价」的那一侧才提示**。一律挂提示会变噪音，
人一学会忽略黄色，红色就没用了。文案说「会发生什么」，不说「不建议」。

最终四条：`workExecutor === 'mock'` / `writeBack === false` / `keepSession === false` /
`writeBackOnFailure === true`。**刻意不进表**：总开关（`renderMasterSwitch` 已有一行状态句）、
`pushAdapter`（通知组顶部 note 已说）、`isolateWorktree`（缺省 false 是设计决定，
天天挂橙框会把人训练成忽略橙框）。

#### UI② 运行页的筛选与搜索

票一多（尤其勾了「显示历史」）就只能靠肉眼在五个分组里翻。加搜索框（命中
`recordId` / 标题 / 项目 / 状态 / 最近错误，不分大小写）与分组下拉。

**「能不能取消」按未筛选的全集判断** —— 筛掉之后画面里没在跑的票，不代表宿主里没有。
筛出 0 张时的说法要与「本来就没票」分开。

#### UI③ 项目卡片「测这张表」

配项目时人是「一边填一边试」的，需要三秒内知道「这张表通不通」；跑一遍全量体检要读十几行
再从里面挑出本项目那几行。

Remote 新增 `testProject(index)`：只把 `projects[index]` 交给体检那份飞书探针（**只传这一项**，
保证与体检口径一致，不出现「这里绿了、体检里红」），逐层回 ✅/❌（认证 → 表 → 数据 → 状态值）。
**参数是下标不是项目名**：项目名允许重复（`config.js` 只警告不拦），而下标与面板那张卡片一一对应。

非飞书平台返回 `skipped`（不是错误）；金山源必须**先于**「非飞书」判断并报不通过 ——
它虽然也不是 feishu，但真实结论仍然是「这条路大概率拿不到票」，归进 skipped 会让人以为这个项目没事。
（2026-11-16 纠正：原句写的是「一张票都拿不到」，那是把「没填表格链接」这一种配置当成了全部；
配了 `match.sheetUrl` 时内置下载器是装上的，所以这里说「大概率」而不是断言拿不到。）

界面位置在「工单表链接」那一行内部、紧贴写入按钮：人的动作顺序是「贴链接 → 保存 → 想确认对不对」。

#### 数值演进

| 项 | 之前 | 之后 |
| --- | --- | --- |
| 配置键 | 25 | **27**（`feishuPush.receiveId` / `receiveIdType`） |
| `projects` 可写路径 | 34 | **35**（`enabled`） |
| 面板项目控件 | 30 | **31** |
| Remote 方法 | 10 | **11**（`testProject`） |
| `dev-run` | 530 | **551** |
| `client-smoke` | 228 | **260** |
| `dev-run` 小节 | 32 | **34** |

**教训**：这一批全部是「已经存在、但人看不见」的东西 —— 失败看不见（P0-1）、走不通看不见
（P0-2）、代价看不见（UI①）、结论看不见（UI③）。**功能做完了不等于功能存在**；
能不能被人在三秒内看见，是独立的一层工作量。


### 1.41 新增项目还没保存，贴链接必然失败（2026-11-13）

用户原话：「我新增加一个项目加不进去」。截图里他做了完全正常的三件事 ——
点「+ 添加项目」、把项目名改成 `city-enc`、把工单表链接贴进卡片顶部的框 ——
然后红字回一句 **`没能写进去: 没有第 1 个项目（当前共 1 个）`**。

#### 病灶：同一张卡片上，两个动作对「宿主里有没有它」的判断不一致

`FeishuTableLinkRow` 只按 `platformNow === 'feishu'` 就画链接行；而紧挨着的「测这张表」
早就用了 `canTest: pending !== true`，连 title 都写着「这个项目还没保存 —— 先点顶部「保存」，
宿主那边有了它才能测」。**一个动作知道宿主里没有这个下标，另一个不知道** ——
`onPasteLink` 直接把 `index = projList.length + q` 发给 `setProjectTable(index, url)`，
宿主 `config.projects` 里根本没这一项，于是 `src/remote/host.js` 那句
`没有第 N 个项目（当前共 M 个）` 就成了用户看到的「加不进去」。

这句报错本身没错（宿主说的是实话），错的是**面板把一个只有保存之后才能做的事摆在了保存之前**。

#### 修法：未保存时只记草稿，保存成功后再按新下标补写

- `FeishuTableLinkRow` 接 `pending` 与 `initialText`，按钮文案分岔成「记下这条链接」/「用这条链接」，
  说明文字也分岔 —— pending 时明说「面板不会解析这条链接，只负责记住，真正的绑定是保存之后由宿主做的」。
- 面板新增 `linkDraft`（`{index, text}`）：pending 卡片贴链接**只进草稿**，一个写请求都不发。
- `onSave` 成功之后（此时项目已经建出来、`loadProjects()` 也拿到了真清单）再调一次
  `setProjectTable(draft.index, draft.text)` 补写。
- 补写失败**不把整次保存判成失败** —— 文案是「项目保存好了，但链接没写进去：…」，
  因为项目本身确实已经建出来了，说成「保存失败」会让人再点一次、多建一个。
- `onReset` 与 `onRemoveProject` 会同步收拾草稿（撤掉中间那张卡片时，后面 pending 卡片的下标要前移）。

#### 自测

`client-smoke` 新增第 ⑧ 组 9 条：pending 卡片上有链接框、按钮是「记下这条链接」、
点了**不发** `setProjectTable`、保存后**按新下标补写一次且 URL 原样**、回话落在卡片里。

写这些断言时踩到两个坑，都值得记下来：
1. `projects()` 假实现要**跟着 mutate 变** —— 保存成功后宿主那边是真有新项目的，
   夹具还固定回 1 项的话，「补写链接的回话」根本没有卡片可落，断言会红得莫名其妙。
2. 断言里的下标**不能写死**：这一组跑在前面几组之后，卡片张数是累积的（实测第 3 张），
   改成从 mutate 里出现的最大 `['projects','N']` 推期望值才稳。
   顺手还发现夹具的第二个项目与第一个**同名**（`projectIssues` 会判重名），一并改掉。

`dev-run` 551/551、`client-smoke` **274** 条、`client-check` ✅（Remote **11** 方法）。

**教训**：凡是「面板上的动作要写宿主」的地方，先问一句「宿主那边此刻有没有这个东西」。
`pending` 是面板自己的状态，宿主完全不知道它存在 —— 这类动作要么延后到保存之后，
要么明确告诉人「先保存」。

#### 补记（同日当天下午）：只记草稿还不够，链接必须**随那一笔一起**写进去

上面那套「先记草稿、保存成功再补写」当天就被用户撞回来了：

```
有 1 项没通过校验，已在下方标红。
保存失败：invalid config:
  - projects[1] 工单表绑定（match） feishu 项目必须给①工单表链接/token（多维表格或电子表格都行）
    ②spreadsheetToken ③docNamePattern（按文件名匹配）之一 (at projects.1.match)
```

宿主 `validateProject` 校验的是**整份配置**，而面板推出去的那一笔里，新项目的 `match`
只有 `{ platform: 'feishu' }` —— 定位依据一个都没有 ⇒ **整笔被拒**。于是「保存成功之后再补写」
这一步永远等不到（保存压根没成功），人看到的就是「加了项目但存不进去」。

正确形状是两步各有其职：

1. **那一笔自带定位依据。** `collectOps()` 造新项目整对象时，如果这张卡片上已经贴了链接
   （`linkDraft.index === index`）且 `match` 里还没有任何定位依据（`projectHasLocator()`），
   就把它原样塞进 `value.match.appToken`。这不是权宜之计：`config.js` 那条校验的文案本身
   就写着「①工单表链接/token（多维表格或电子表格都行）」，运行期 `/base/`、`/wiki/`、`/sheets/`
   三种形态分别由 `normalizeAppToken` / `probeWikiNode` / `extractSheetToken` 各自拆解，
   `match.appToken` 本来就接受整条链接。**浏览器仍然不解析它**（解析出 token 等于让明文进浏览器）。
2. **补写照旧执行，但职责变了。** 保存成功之后那次 `setProjectTable()` 从「唯一一次写入」
   变成「把这条链接归一成 `spreadsheetToken`+`sheetId` 之类的精确坐标」；它失败也不影响项目
   已经存住 —— 这正是当初「补写失败不把整次保存判失败」那条判据真正的用处。

连带一处：`projectIssues()` 的飞书段判定「有没有定位依据」时要**把草稿链接也算一条**
（`allProjectIssues(list, draft, linkDraft)` 新增第三个参数）。否则新卡片明明已经贴了链接，
仍挂着「这个飞书项目还没绑定任何工单表」的软提示 —— 面板自己的校验与它自己要发的那一笔
必须用同一套判据。

自测加一条：`client-smoke` 断言「新增项目那一笔自带 `match.appToken`（原样 URL）」，
不再只断言「保存后补写了一次」。另用探针 `.scratch/_probe-add-project-save.mjs`
直接拿 `validateConfig` 验了四种合法写法（整条 wiki 链接 / 带 `?sheet=` / 整条 base 链接 /
裸 token）都能过、什么都不给确实被拒 —— 免得下次又以为「是校验太严」。

**教训（比上一条更靠前一步）：** 「先 A 后 B」的两步链里，**A 那一笔也必须自身合法**。
把合法性寄托在「等 B 补上」，等于假设 A 能通过一个它其实通不过的校验。

#### 再补记（当天傍晚）：整对象通道里每个 `kind` 都得逐类处理，不能一律 `String()`

链接的事修好之后，用户又撞回第三条：

```
有 2 项没通过校验，已在下方标红。
保存失败：invalid config:
  - projects[1] 列名覆盖（match.sheetColumns） 必须是对象，形如 { "description": "问题描述", "status": "是否处理" }
  - projects[1] 列名覆盖（多维表格）（match.columns） 必须是对象，形如 { "description": "缺陷描述", "status": "处理状态" }
```

他一个新项目**什么都没填**也报这两条。病灶在 `buildProjectValue()`：它给所有普通字段
走的是一句 `String(normalized).trim()`，而 `projectRawValue()` 对 `kind === 'columns'`
**已经把「一行文本 `a=b, c=d`」解析成了对象**（`parseColumnsDraft('')` 回 `{}`）——
于是 `String({})` 得到 `"[object Object]"` 被原样写进这两个键，宿主当然说「必须是对象」。

**只有「新增项目」这条通道会踩到**：已有项目的改动走单字段路径，那里直接把
`projectRawValue()` 的结果发出去，不经过这个函数。所以症状是「只有加新项目才报、
而且跟那两格填了什么无关」—— 空着也报。

修法是在 `kind === 'list'` 分支之后单独处理 `kind === 'columns'`：是对象且非空就
原样 `put()`，否则整格不写。空对象**不能**写进去 —— 宿主那边「键存在但不是对象」
会报错，空串又会被当成「人想覆盖但没填」；一律按「没配」处理，让它走缺省列名。

顺手回答用户同时问的「这两个字段有什么用，没用到可以去掉吗」——**有用，别去**：

- `match.sheetColumns`（电子表格）归一后喂给 `locateSheetHeader`（`source-feishu/index.js:375`、`:1673`），
  表头叫法跟插件不一样时靠它把实际文字映射到 13 个语义字段名；回填报错时也会指路这一格（`:1736`）。
- `match.columns`（多维表格，工单 #21）走同一个 `resolveSheetColumns()` 归一、喂给
  `mapColumns(overrides)`（`index.js:379`、`:1330`）。
- 分成两个键而不是共用一个，是因为两种表型「认识哪些字段名」不完全一样，
  分开才能让校验给出准确的白名单提示（`config.js:877-881`）。
- 两格都留空就是走缺省别名表（`DEFAULT_COLUMN_ALIASES` / `BITABLE_COLUMN_ALIASES`），
  表面本来就跟插件认知一致的项目根本不用碰它们；面板上也都是 `advanced`（缺省收起）。

自测加两条：`client-smoke` 断言「没填这两格时，新增项目那一笔的 `match` 里
不带这两个键」以及「那一笔里不许出现 `"[object Object]"`」。另用探针
`.scratch/_probe-columns-save.mjs` 拿真 `validateConfig` 对照新旧实现 —— 旧的在
「什么都不填」与「填了一项」两种输入下都报 2 条（正是用户看到的两行），新的都是 0 条。

**教训（第三条，和上面两条串成一条线）：** 「整对象提交」这条通道上，字段的类型
必须**逐类处理**（bool / list / object / 字符串各走各的），一律 `String()` 会把对象
变成 `[object Object]`、把布尔变成 `"false"` 却仍为真值。而这类 bug 只在「一次提交
一整块」的路径上出现 —— 逐字段提交的路径看着好好的，很容易以为功能本身有问题。


### 1.42 「跑一轮」炸在同一个机制上：可选参数也必须传满位置（2026-11-13 傍晚）

用户原话就三个字：「跑一轮失败」。截图红字写得很清楚：

```
跑一轮失败: client api: ticketPipeline#ticketPipeline/scan expected 1 argument(s), got 0
```

#### 病灶

`scan` 在工单 #39 加了可选参数 `projectId`（面板上「只跑这个项目」那一格），
但「跑一轮」的调用点还是老样子 `ns.scan()` —— **声明里可选，调用时干脆不传**。
浏览器侧 `prepareInvocation` 是按 `descriptor.parameters.length` 数**位置实参**的：

```js
const expected = descriptor.parameters.length
if (values.length !== expected && !hasCallerSignal) {
  throw new Error(`client api: ${endpoint} expected ${expected} argument(s), got ${values.length}`)
}
```

`acceptsUndefined: true` **只有宿主侧** `assertExactArguments` 会认（它用它决定
「缺这个键算不算 missing」），浏览器侧完全不看这个标志。所以「可选」在两端语义不同：
宿主侧是「可以不传这个字段」，浏览器侧是「必须占住这个位置」。

这与 2026-11-11 修的「重跑」是**同一个机制、换了个方法**（那次是 `reset` 少传
`projectId`）。一天半之内撞两次，说明这不是「写的时候粗心」能解释的 ——
它出现在最自然的写法上：既然参数可选，不传不就完了。

#### 修法

1. 调用点改成 `ns.scan(undefined)`。`undefined` 不会写进 `args`
   （网关那句 `if (value !== void 0) args[wire] = value`），宿主侧再靠
   `acceptsUndefined` 接住缺席 —— 两头都合法。
2. **加静态守卫**：`scripts/client-check.mjs` 新增 `checkCallArities()`，
   从 bundle 里抠出每一处 `<xxx>ns.<method>(…)` 调用点，数顶层实参个数，
   与 `TICKET_PIPELINE_DESCRIPTORS` 的 `parameters.length` 逐个比对，对不上就 fail：

   ```
   lib/client.js:4607 调用 `ns.scan()` 传了 0 个实参，但描述符声明了 1 个 ——
   浏览器侧会直接抛 `client api: … expected 1 argument(s), got 0`。可选参数也要按位置传满（填 undefined）。
   ```

   顺带补一条运行时断言：`client-smoke` 的假宿主把 `arguments.length` 记进
   `calls.scanArgs`，断言点「跑一轮」时是 `[1]`，并且界面上不出现
   `expected 1 argument` / `跑一轮失败`。

#### 给守卫做回归测试，结果险些变成摆设

写完断言我照例把 `ns.scan(undefined)` 改回 `ns.scan()` 看它会不会红 ——
**它没红，exit 0、全绿**。原因是 `stripComments()` 里「见到引号就进字符串」那条规则
被正则字面量带偏了：源码中有 `/projects["'\]\s]*(is not|is)/i` 这种**体内带引号**的写法，
状态机从那里以为进了字符串、一路吞到文件末尾，于是**守卫把自己要守的调用点遮掉了**。

改用通行启发式之后才正常：`/` 的前一位有效字符是 `)`、`]`、标识符或数字时算除号，
否则算正则开头，正则整体原样跳过（`[...]` 字符类里的 `/` 不算结束）。再跑回归测试，
exit 1 并精确报出 `lib/client.js:4607`。

**教训（这条比 bug 本身重要）：** 「加了个断言」和「断言真的会拦住」是两件事。
新加的守卫**必须**用「故意把 bug 放回去」的方式验证它确实变红 ——
这次如果不做这一步，交付的会是一个看起来更安全、实际一条都拦不住的检查，
比没有更糟（人会因为「有守卫了」而放松）。




### 1.43 「文档标题」被当成「工作表名」：体检全绿、扫票失败（2026-11-13 晚）

用户点「跑一轮」，`pipeline_status` 顶上出现：

```
⚠️ 上次扫表失败：这个 token 既当不了多维表格，也当不了电子表格。
- 按多维表格读：飞书参数错误：WrongBaseToken
- 按电子表格读：match.sheetName="PMS项目管理系统工单" 没匹配到任何工作表。现有工作表：Sheet1 [3a5d28]
```

#### 病灶不在插件，但也确实该修

真人真机核对（只读 GET）：

| 项目 | 配置 `match.sheetName` | 实际工作表（页签） | 文档标题 |
| --- | --- | --- | --- |
| `pms` | `PMS项目管理系统工单` | **`Sheet1`** [`3a5d28`] | `PMS项目管理系统工单` |
| `city-enc` | `城建能耗管理系统工单` | **`Sheet1`** [`c2f927`] | `城建能耗管理系统工单` |

两个名字都真实存在，只是**不在同一层级**：人从浏览器地址栏复制来的必然是文档标题，
而 `match.sheetName` 要的是页签名字。报错原文「没匹配到任何工作表」是实话，
但它不给「你取错了层级」这个提示 —— 修法方向完全不指路。

#### 比这个报错更该先修的：体检和扫票用了两套判据

`probe.js` 原来的挑选逻辑是「配了 `sheetId` 就用它，否则 `sheets[0]`」—— **压根不看 `sheetName`**；
而扫票走 `resolveWorksheet()`，会拿 `sheetName` 去匹配。于是同一份配置得到两个相反结论：
**体检全绿、扫票失败**。这和 §1.28 / §12.13「体检与适配器必须认同一套输入形态与口径」是同一个病 ——
诊断器只要和真实链路用了两套判据，它给出的「通过」就没有意义。

#### 三处改动

1. `sheets.js` 的 `resolveWorksheet(sheets, { sheetId, sheetName, documentTitle })` 加一档：
   名字命中 1 张 ⇒ 照旧；**一个都不命中、但 `sheetName` 恰好等于文档标题、且可见工作表只有 1 张**
   ⇒ 降级用那一张并返回 `note`（说清「你填的是文档标题」，点出实际工作表名与 `sheetId`）；
   否则照旧抛 `invalid-input`，只是错误里补一句「这张电子表格文档的标题是「X」——那是文档名，
   不是工作表（页签）名」。**「可见工作表恰好 1 张」是护栏不是便利**：多张表时猜错
   就是把别人的数据当工单读。
2. `index.js` 的 `resolveSheetTarget()`：只有在配了 `sheetName` 时才多问一次
   `GET /open-apis/sheets/v3/spreadsheets/<token>` 取 `data.spreadsheet.title` 当 `documentTitle`；
   这次请求失败不算错（`aborted` / `auth` 仍抛），只是少一句提示 —— 没配 `sheetName` 的人
   不该为一句提示付一次请求。
3. `probe.js` 按配置挑表：`readSheetMetadata` 末尾改调同一个 `resolveWorksheet()`；
   抛错时记 `metadata.nameIssue` 并**退回第一张继续查**（体检的职责是分层说清哪一步不对，
   不是名字不对就什么都不查）；降级成功记 `metadata.note`。`pipeline_doctor.js` 把 `nameIssue`
   算**阻断**、`note` 打 `ℹ️`；`remote/host.js` 的 `testProject()` 同样判红 —— 三个消费方读同一份字段。

#### 判据

1. **凡是「人填的名字」，先问清它属于哪一层**（文档标题 / 页签 / 视图 / 字段名），
   报错文案要点出「最可能是取错层级」，而不是只说「没找到」。
2. **容错只往「唯一解」方向退**：唯一可见表可以降级，多张就报错让人自己选。
3. **同一份配置，体检与运行必须给出同一个结论**；做不到说明判据有两套，先合并判据再谈文案。
4. 自测：`dev-run` 551 → **557**（nameIssue 判阻断 1 条、降级 note 算通过 1 条、
   `remote.testProject()` 判失败 1 条、探针按配置挑表 2 条 + seam 1 处）；
   `feishu-checks` 97 → **99**（单张可见表降级、多张可见表不许猜）；`client-smoke` **276** 条。


### 1.44 会话名要能认人：插件自己钉 `session/title`（2026-11-13）

用户一句话点出来的：「创建会话 会话命名目前没有」。

会话创建在 `executor-agent/index.js` 的 `run()` 里，`sessionId` 由 `buildSessionId()` 拼成
`ticket-pms-sh-row-84-1794559390983`。**那个 id 就是 GUI 会话列表里显示的名字** —— 同一张票
重跑几次就有几条只差尾号的会话，人认不出谁是谁。而「点开处理会话看它当时怎么改的」正是
这套东西给人留的最重要一条后路，名字认不出来，那条后路等于半废。

#### 为什么不能指望宿主的自动标题

`SessionTitleService` 的自动生成有三条前置条件：`!session.header.isSeeded`、`origin !== 'subagent'`、
第 1 条消息来自 user、且当前还没有标题。我们这条会话是 `agents.create()` 建的，不是从一条用户
消息开始的 —— 这些条件都不是我们能保证的形态。（fallback 那条更差：截任务书开头的几十个字，
比 id 好一点，但仍然不像「哪张票」。）

反过来，`onUserMessage` 里有一句早退：**当前标题 `source.kind === 'user'` 时直接 return**。
也就是说，插件先钉一个 user 标题，后面不管有没有 LLM provider、消息怎么来，都不会被改掉。
这是唯一「每次都一样」的路。

#### 做法

1. 新增 `buildSessionTitle(ticket, maxBytes = 80)`，**以「修复」开头**：
   `修复<问题描述>（项目 #序号）` ⇒ `修复列表翻页丢数据（pms #84）`。没 `description` 退到 `recordId`，
   全空退到 `修复工单` —— **不能是空串**，空串会被服务判 `SessionTitleInvalidError`。
   （第一阶段先用了 `[pms] #84 …` 的形状，上线后发现会话列表里项目已经是分组标题、再重复一遍
   只是浪费 80 字节里最贵的几个字，当天改成「修复…」。见 §1.45。）
2. **按 UTF-8 字节截，不按字符数截**。服务侧 `maxTitleBytes: 80`（`dsh-base/cordis.patch.yml`）；
   中文 1 字 3 字节、英文 1 字节，按字符截必然超限，按字节 `slice` 又会在汉字中间断开（得 `\uFFFD`）。
   所以逐码点累加 `Buffer.byteLength(ch, 'utf8')`，预算 `maxBytes - 3`（省略号 3 字节），末尾补 `…`。
3. `setupAgent()` 在拿到 `session` 之后、写沙箱/审批策略之前插一段：
   `session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } })`，
   **单独一层 try/catch** —— 标题只是给人看的，写不上绝不能连累下面那两条真正的策略事件
   （沙箱模式、审批策略）。失败只记一行日志「写会话标题失败（不影响跑票，只是 GUI 里显示的还是 id）」。
4. `run()` 在 `agents.create({...})` 的 `setup` 回调里多传 `title: buildSessionTitle(ticket)`。

#### 判据

1. **凡是「人要点开来看」的东西，名字必须能对上号**（会话、工作区、分支、MR 标题是同一类问题）。
   id 唯一但不可读，等于没有导航。
2. **能自己定的名字就别等下一个人猜**：自动生成依赖一串前置条件，显式 append 只依赖「拿到了
   session 句柄」—— 后者在 `setup` 里必然成立。
3. **给人看的东西失败必须降级，不能传染**：标题写不上 ≠ 跑票失败，两件事严重程度差两个数量级，
   不能共用一个 try。
4. **字节预算要对齐上游配置**，别在插件里再定一个「差不多」的值；抄 80 并注明出处。

5. 自测：`dev-run` 557 → **562**（+5：标题拼法三段退路、UTF-8 截断不切汉字、
   `setupAgent` 写出 `source.kind === 'user'` 且不吞掉沙箱/审批事件、标题写失败只记日志）。

### 1.45 三个「看起来都正常」的暗坑：会话名、工作区归属、被忽略的文件（2026-11-13 深夜）

用户报了三件事，现场看一眼都像是「插件没干活」，实际是三条互不相干的静默降级。

#### 一、会话名全变成「注意：下面的工单内容来自共」

§1.44 钉的标题**根本没生效** —— 但原因不是钉错了，是**宿主根本没重启**（跑的还是老副本）。
于是命中的是宿主的 fallback 标题：`fallbackSessionTitle(首条 user 消息, fallbackMaxWords: 5,
fallbackMaxBytes: 40)`，而首条 user 消息的第一块是反注入提醒「注意：下面的工单内容来自共享渠道…」。
`cleanTitleText` 把 `\s+` 折成单空格后中文整段保留，于是被 40 字节切在「来自共」—— 十条会话一个名字。

**为什么不能靠「把提醒挪到后面」解决**：提醒位置是安全要求，挪到正文之后会被正文里那句
「忽略以上要求」盖掉（`buildMessages` 的注释写死了这条）。**唯一的路是插件自己钉标题**，
并让它足够早。这条的教训不是「标题要写对」，而是：**改了代码没重启 = 改了跟没改一样，
而症状会伪装成「新功能没生效」**。

顺带把形状改成 `修复<问题描述>（项目 #序号）` —— 人找会话是按「这条在改什么」找的，
不是按项目号；项目与序号降级成尾巴上的坐标，截断时先被切掉的正好是它。

#### 二、两张票（`sh-row-83` / `sh-row-84`）的会话不在 `mgiot-pms` 分组下

票据行上 `workspacePath` 有值、`workspaceId` 是 `undefined`，而会话归属只认 id：

```js
const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : ''
if (workspaceId.length > 0) { … attachSession … } else { log('没有工作区坐标，会话不归属') }
```

根因是 `scheduler.js` 的工作区守卫**只检查路径**：

```js
if ((!row.worktreePath || !ws.workspacePath || staleCoords) && typeof prepareWorkspace === 'function')
```

一旦某一轮 `prepareWorkspace` 只回了路径没回 id（登记降级：本机没有 `workspaceRegistry` 服务 /
`create` 抛错被吞 / `create` 返回空 —— 三条都只记日志、不报错），此后每轮都判「坐标仍然有效，
直接复用」，**永远不再补登记、也永远不会自愈**。这是「一次静默降级变成永久状态」的典型：

1. 守卫补 `missingWorkspaceId` —— 缺 id 就再跑一次准备，`resolveByPath` 会把既有工作区认回来；
2. 执行器侧兜底：`workspaceId` 空但 `workspacePath` 有值时用 `registry.resolveByPath(workspacePath)`
   反查 id 再 attach —— 调度器那条要等下一轮，而这一轮的人已经在等结果了。

#### 三、`sh-row-82` 判失败：`git add` 撞上已跟踪的被忽略文件

```
git add -- .idea/jarRepositories.xml pms-server/… sql/pms-init.sql
→ The following paths are ignored by one of your .gitignore files: .idea
→ hint: Use -f if you really want to add them.
```

真跑 git 2.45.1 确认：**这不是「跳过那一个文件」，是整条命令 exit 1** —— 另外两个真正要提交的文件
一个都没进索引。而 `.idea/jarRepositories.xml` **在库里早就跟踪着**（只是 `.gitignore` 又写了 `.idea`），
所以它不是「不该提交的东西」，而是「提交它需要 `-f`」。

修法是分两步（`addPathsForCommit`）：先 `ls-files -z -- <全部路径>` 问哪些在库里，
在库里的用 `add --force`，不在库里的按原样 `add`（它们要是也被忽略，就该让 git 拒绝并暴露出来）。
**不用 `git check-ignore` 筛**：它只回答「匹配了哪条规则」，不回答「在不在库里」—— 这两件事恰好是这里的分界。
git 白名单同步放行 `add --force/-f` 与 `ls-files -z --`，形状钉死（不给 `-A`、不给不带路径的 `ls-files`）。

#### 判据

1. **静默降级必须能被下一次尝试纠正**：降级本身可以接受（本机没这个服务也能跑票），
   但降级留下的状态不能让后续轮次误判成「已经是好的」。
2. **守卫检查的字段要和下游消费的字段一致**：下游只认 `workspaceId`，守卫却只看 `workspacePath`。
3. **给人看的失败和真正的失败不能共用一条路**：标题写不上 ≠ 跑票失败。
4. **`git add` 是「全有或全无」**：一条坏路径能让整批暂存失败，所以必须先分类再分批。

#### 自测

`dev-run` 562 → **569**（+7：会话标题改成「修复…」开头后的 4 条断言改写 + 缺 `workspaceId` 必须补登记 1 条
+ `gitlab-checks` 的 `add --force` 分批 1 条 + git 白名单 `add --force`/`ls-files` 形状 1 条）。

### 1.46 同一张票重跑，接着上一轮的会话继续（2026-11-13）

#### 现场

`sh-row-82` 第一轮跑了 49 分钟、探索 84 次、**0 个文件改动**；人工重开后又跑了 27 分钟，
探索 57 次才动手 —— 而第二轮总共只读了 11 个文件，其中 **5 个第一轮刚读过**。
同一个项目里的 10 个工单会话累计读了 41 个不同文件、只改过 11 个，交集大面积重叠：
每一次重跑都在把同一段探索重走一遍。

#### 根因

`plugins/ticket-pipeline/src/adapters/executor-agent/index.js` 的 `buildSessionId()`
注释里早就写着「同一张票重跑要能认出上一轮的 session（宿主据此复用/续接），所以键排前面、
时间戳放最后」—— 意图是在的，但实现只做了「把键排前面」，末尾仍然拼 `Date.now()`，
而且**全仓没有任何一处调用 `agents.resume`**。会话 id 虽然已经落到票据的 `row.sessionId` 上
（失败票也会留），但它只被用来在 `pipeline_status` 里显示「处理会话：」那一行，
从来没往下传给执行器。

#### 改法（三处，缺一不可）

1. **契约**：`plugins/ticket-pipeline/src/contracts/work-executor.js` 的 `ExecCtx` 加
   `@property {string} [sessionId]`，注明这是「上一轮用过的会话」，可选、老调用方不传
   就是老行为。
2. **调度器**：`plugins/ticket-pipeline/src/core/scheduler.js` 构造 `ExecCtx` 时把
   `row.sessionId` 传下去 —— 从票据上读而不是自己记，因为执行器抛异常/超时/被取消时
   返回不了结果，会话 id 只有 `onSessionId` 那条回调能落库，而重启、人工重开之后调度器
   手上只有库里的这一行。
3. **执行器**：先试续接、失败再新建。`agents.resume` 的选项形状与 `create` **不同**：

   ```js
   created = await agents.resume({
     resumeSessionId: previousSessionId,   // 身份只在这里，没有 sessionId
     agentOptions,
     setup: makeSetup(previousSessionId),  // 与 create 同形，preset 必须照样挂
     signal,
   })
   // 对照 create：{ sessionId, meta: { cwd: sessionCwd }, agentOptions, setup }
   ```

   `resume` 的 cwd 来自持久化会话 header，**不在这层给**（传 `meta` 是多余的）。
   把 `setup` 抽成 `makeSetup(useSessionId)` 工厂让两条路复用同一份挂载逻辑。

#### 判据

1. **有意图的注释不算实现**：代码里写着「宿主据此复用」而实际每次都新建，比没写更坏
   —— 读注释的人会以为这条路已经通了，于是不再去查。
2. **降级必须可见**：`resume` 是外部状态在说话（持久化后端没挂、会话被人删了、header
   坏掉），失败原因一条都不该让票跑不了，但**必须留一条日志**「续接失败，改为新建」
   —— 静默新建会让人以为「它记得」，其实又从零开始了。
3. **续接成功要回传旧 id**：如果照常回传新造的 id，票上就被换成新号，下一轮又续不上，
   等于只续了一次。
4. **老宿主不该被判失败**：`agents.resume` 不是每个宿主版本都有，`typeof !== 'function'`
   时直接新建。

#### 自测

`dev-run` 569 → **576**：
- `gitlab-checks.mjs` +5（票上有上一轮就续接不再新建 / 续接成功回传旧 id / 续接失败退回
  新建且留日志 / 宿主没有 `agents.resume` 时直接新建 / 新票行为不变）；
- `dev-run.mjs` +1（调度器把票据上的 `sessionId` 交给执行器）。
三条执行器用例都做过「把 resume 分支掐掉 → 只有对应用例变红」的回归验证；
调度器那条同样做过「删掉传参那行 → 只有它变红」的验证。

### 1.47 跨票记忆召不回该召回的票：中文滑窗把真词淹了（2026-11-13）

#### 现场

`~/.dsh/storages/ticket_pipeline.json` 的 `tables.memory.pms.entries` 里只有两条记忆，
关键词长这样：

```
作台中的 / 台中的全 / 的全据 / 全据项 / 据项目 / 项目报 / …（各 40 个）
```

而这条记忆真正对应的是 `工作台-全据项目报告` 那个页面。**决定性证据**是召回结果：
`sh-row-82`（首样测试）召回的是 `sh-row-83`（上门服务）—— 完全不同的页面；
而本应召回的 `sh-row-81`（同样改首样测试）反而没被召回，因为
`项目管理-首样测试` 与 `项目管理-首样测试-审批按钮` 整串精确比较永不相等。

另一条独立证据：10 个 agent 会话日志里搜「这个项目里同类问题的历史」，**全部没有**；
但同一批日志里「改完怎么验证」段全都有 ⇒ 部署的是新代码，只是召回恒空。

#### 根因（三处，都在 `src/core/ticket-memory.js`）

1. **抽词**：中文用 2–4 字滑窗从问题描述里切，切出的是碎片而不是词。碎片词还有个更坏的
   副作用 —— 它们能命中任何一段中文，于是「不该召回的」被召回了。
2. **判据**：区分度阈值用了含旧条目的 `entries.length`，且最后 `.map` 遍历的是 `entries`
   而不是过滤后的 `usable` —— 旧条目从这里全部漏了回来。
3. **单条边界**：区分度按「每条记忆都有就不算区分度」算，只剩一条记忆时它每个词的
   df 都等于条目数 ⇒ 整条被滤空 ⇒ 项目里第二张票永远看不到第一张学到的东西，
   记忆功能等于没开。

#### 改法

```js
// 中文只从结构化字段取整词，不从问题描述里抽
add(ticket?.module)
add(ticket?.flow)                                  // 整串留着供人回看
for (const segment of String(ticket?.flow ?? '').split(FLOW_SEPARATOR)) add(segment)
for (const m of description.matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}/g)) add(m[0], true)
```

`FLOW_SEPARATOR = /[-–—/\\>»·、，,|；;：:]/` —— flow 是 `-` 分段的页面路径，那段路径就是
天然的整词切分点。切段顺带解决了「精确比较永不相等」：`项目管理-首样测试` 与
`项目管理-首样测试-审批按钮` 共享 `首样测试`。

配套三条：

- 新增 `MEMORY_KEYWORD_VERSION = 2`，`recallMemories` **只认同版本**的条目 —— v1 的碎片词
  与 v2 的整段词是两套词表，混用只有巧合命中；而被重新学到的旧条目在 `remember()` 里
  **整批换词**（不是并集，否则碎片词会被永久固化）。
- 区分度用 `documentFrequency`，判据是「所有记忆都有」而不是「超过一半」：不需要调阈值，
  小样本下也不会误杀。
- 只剩一条记忆时不做区分度过滤（否则它会把自己滤空）。

#### 判据

1. **抽词的粒度和检索的粒度必须一致**：拿 2 字滑窗去匹配「哪几个文件」，抽的就已经不是
   「这张票在哪个页面」这个信息了。
2. **描述写的是「哪里不对」，不是「在哪个页面」** —— 同一页面的两张票措辞几乎一定不同；
   措辞相同的两张票（都提「列表/排序/筛选」）可能是八竿子打不着的两个页面。所以
   「哪几个文件」只跟页面有关，页面就在 `module` + `flow` 里。
3. **换词表就要升版本号**：静默混用两种词表的失效方式是「偶尔命中」，从结果上看和
   「功能没写对」一模一样。
4. **单条样本要当边界情况想**：「超过一半」「所有都有」这类判据在 n=1 时语义会塌。

#### 自测

`dev-run` 530 → **569**（含会话标题那批），本次记忆相关 6 条：抽词只收 module/flow 整段
+ 标识符（含反向断言「描述里的中文一个都不抽」）/ flow 只有一段时不过度抽 / 按命中词数
排、平手看复用次数 / 旧算法条目不参与召回 / 两条都有的模块名不算区分度且单条不能被滤空 /
旧条目被重新学到时整批换词。


### 1.48 回填进表格的那一格要能一屏读完：只留「人下一步要用的」（2026-11-16）

#### 现场

用户原话：「回填处理结果时只记录重要的信息，如 recordId 等」。真机上打开表里那一格看到的是
400 多字：一句「已按工单改完并提交」+「改动 6 个文件」+ 六行 40–80 字的 Java 全路径 +
验证结论 + 提交 sha @ 分支（带工作区绝对路径）+ 处理会话 id + 末段三行重跑说明。
**人下一步真正要复制的那个 recordId，一个字都没出现。**

#### 根因

不是「写得不好」，是**写的人和读的人关心的东西不一样**：写代码的人想「把上下文都留下」，
而读表格的人只有两件事要做 —— 去检出里 review、或者重跑。第一件靠 sha，第二件靠 recordId。
文件清单、工作区路径、重跑步骤长说明，三样都不在这两件事里（前两样在 `pipeline_status`
与 `git show <sha>` 里查得到，第三样一句「用 pipeline_reset 带上记录号」就说完了）。

#### 改法

```
已按工单改完并提交。
验证：通过
本地提交：a1b2c3d4e5f6 @ ticket-pms-84
处理会话：ticket-pms-sh-row-84-1794559390983
记录号：sh-row-84（要重跑就用 pipeline_reset 带上它）
```

- 首句按 phase 分叉：`skipped` 写成「已按工单改完并提交，验证没通过，待人工验证。」——
  表里这一行会被写成「是」，人看到「是」就不会再翻验证报告了。
- **记录号单独成行、放最后**：它是唯一必须逐字出现在单元格里的东西。
- 失败票同款瘦身：`lastError` 走新增的 `truncateError(lastError, max = 120)` —— 真机上
  错误常是「飞书接口报错 800074911：ConnectorSyncTableActionForbidden, [status_code: 800004105 …]」，
  有用的只有开头半句，后面那半截会把记录号挤出屏幕。
- 删掉「改动 N 个文件 + 最多 8 条路径」「改代码目录：<绝对路径>」
  「要进一步修改，先把这个单元格清空…」三块。

#### 判据

1. **单元格的读者是「手上只有这张表的人」，不是「能看插件日志的人」** —— 所以只写
   「用别的渠道查不到、或者查起来很麻烦」的信息。
2. **人下一步要复制的东西必须一行内、逐字可复制**：夹在长句中间的 id 等于没有。
3. **给人看的失败与真失败不能共用一条路**：失败票写的是「为什么没成 + 记录号」，
   不是「完整错误栈」——后者给日志。
4. **删信息要留出处**：文件清单没丢，它在 `pipeline_status` 与 `git show <sha>` 里。

#### 自测

`dev-run` 575 → **576**：新增「处理结果单元格只留关键信息：记录号必在，文件清单与长段说明都不进」
（正向断言 `/^记录号：rec-mock-001/m`、总字数 < 300、行数 ≤ 6；反向断言不含
`pms-server/` / `pms-web/`、不含盘符路径）；并把两条老断言从「要写『要进一步修改』」
反转为「不许再写」，失败票那条加了「记录号必在」「不许出现『改代码目录』」。

### 1.49 「说明」也要被核对：一条写进产品输出的错误说法，和一个缺了三次的守卫（2026-11-16）

#### 现场

用户原话：「修复说明的不足」。前一天我刚向他列过「八条优势 + 五条不足」，
所以这次要修的不是代码，是**说明书里站不住的地方**。

做法是先把八条优势逐条对代码核（`.scratch/_audit-claims.mjs`）：16 条核对，15 条成立，
1 条是刻意自曝的不足（日志无落盘 sink）。但五条不足里有一条不只是「不好用」，是**说错了**。

#### 错在哪

`pipeline_doctor` 对**任何** `platform: 'wps'` 的项目都报**阻断**，行文案是
`❌ 金山文档源：… —— 取数通道未接，一张票都拿不到`，注释理由是「取数通道是注入式的，
主装配里没有注入」。

而 `src/adapters/source-wps/index.js` 的 `wpsOptionsFromMatch()` 里明明有：

```js
const sheetUrl = String(m.sheetUrl ?? '')
if (sheetUrl) {
  options.sheetUrl = sheetUrl
  options.fetchSheet = async (signal) => downloadSheetLimited(fetch, sheetUrl, { signal })
}
```

⇒ **配了「表格链接」就有取数通道**（内置下载器，超时 / 取消 / 字节上限 / 逐跳重定向校验都是它）。
真正的 `MISSING_FETCH_SHEET` 只发生在「选了 wps、又没填链接、也没人注入 `fetchSheet`」这一种配置上。

探针 `.scratch/_probe-wps-fetchsheet.mjs` 跑三档确认：配了 `sheetUrl` → `fetchSheet` 是函数；
没配 → `undefined`；**配了空串 `'   '` → 仍是函数**（`String(...)` 后非空，`if (sheetUrl)` 为真 ——
这一档我原以为应该没有，实测是「有」）。再给真 URL + 已 abort 的 signal，抛
`kind=aborted` / `msg=取表被取消`，证明它真的会走下载逻辑而不是空壳。

#### 改法

判据从「platform 是不是 wps」换成「有没有内置通道」：

- **没配表格链接** → `blockers`：`既没配「表格链接」也没有注入 fetchSheet —— 这些项目一张票都拿不到`
- **配了表格链接** → `warnings`：`这条路能跑，但共享链接通常要登录态 —— 如果扫描报 HTTP 403/401 或超时，就是这里缺授权，不是插件坏了`
- 「`recordId` 用行号 ⇒ 插行会让票换身份」这条限制挪到分档之外，两档都看得到。

自测里那条「选了金山就报阻断」保留（它测的是没配链接那一档，仍成立），新增一条
`体检：金山项目配了表格链接就不算阻断 —— 内置下载通道是存在的`。

#### 第二件事：一个缺了三次的守卫

「面板 ↔ Remote / DOM 的边界脆弱」这条不足，当时只是列出来。核的时候发现它已经撞了三次：

| # | 症状 | 真因 |
| --- | --- | --- |
| 1 | 点「重跑」报 `expected 2 argument(s), got 1` | `ns.reset(recordId)` 少传可选 `projectId` |
| 2 | 点「跑一轮」报 `expected 1 argument(s), got 0` | `ns.scan()` 少传可选 `projectId` |
| 3 | 点「重新读取」报「宿主还没提供 `projects()`」 | `loadProjects(target)` 的首参被 click 事件顶掉 |

①② 已有 `checkCallArities` 兜住（比「实参个数」）。③ 一直只靠「记住这个坑」——
而**记性不是机制**。现在补第二条静态守卫 `checkEventArgConfusion()`，判据刻意不维护任何名单：

1. 用 `findMatchingBrace()` 切出每个组件函数体，扫出 **把 `props.Y` 直接挂在 DOM 事件属性上**
   的地方（`onClick: props.onReload` 这种）—— DOM 会把事件对象当第一实参递进去；
2. 再看外层 `h(组件, { onReload: 裸标识符 })` 里那个标识符是不是**声明了形参**的本地函数。

两条同时成立即 fail，并直接说「第一个实参会是 React 的事件对象，不是 `<形参名>`」。
写成 `onReload: function () { loadProjects() }` 就不命中 —— 这既是修复形态，也说明守卫在**指导**写法：
能透传就在调用点包一层，把「谁传什么」说清。

实跑抓到 2 处（`<RunCard> onRefresh: loadRun`、`<ProjectListCard> onReload: loadProjects`），
都已改成包一层；函数内部那两个类型判断**保留为兜底**（兜底不是入口，但入口不该依赖兜底）。

#### 判据

1. **「说明」也是要被核对的代码**：那条错误说法已经写进 `pipeline_doctor` 的输出，会主动
   误导人去改一个没坏的配置 —— 错误说法的代价不是「不够准确」，是**让人做错事**。
2. **同一个坑撞到第三次就该上守卫**：前两次都是「记住了」，第三次证明记住不管用。
   守卫的判据要能从代码里推出来（不维护名单），否则名单本身会腐。
3. **守卫顺手把正确写法也定义了**：`checkEventArgConfusion` 只认「裸标识符」，
   所以它同时在教「这里该包一层」。一条只能拦、不能引导的守卫，会被人当成噪音绕过。
4. **守卫必须做回归测试，且手动确认它会红** —— 这条在 §1.42 已经付过一次学费
   （第一版 `stripComments` 把自己的目标遮住，回归测试显示全绿）。

#### 自测

- `dev-run` 576 → **577**（新增金山源分档 1 条）。
- `client-check` 新增输出：`· DOM 事件属性透传 4 处，其中裸函数名 0 处（会收到事件对象）`。
- `client-smoke` 276 → **280**（「重新读取」带事件对象不报错 / 真的又读一遍 / 卡片还在 / 有按钮）。
- 两条守卫都做了回归测试：`onReload` 改回裸传 → `client-check` exit 1 并精确报
  `lib/client.js:4917 把 loadProjects(target) 裸传给了 <ProjectListCard> 的 onReload…`；恢复后 exit 0。
  `client-smoke` 侧同时退回裸传 + 内部判定退回 `target !== undefined` 也会红。

### 1.50 探索预算 12 次太少，但「按需求分级」这条路走不通（2026-11-16）

#### 现场

用户原话：「探索预算是 12 次 是不是太少了，应该按照不同的需求 给不一样的探索预算」。

12 是 §1.39 定的：跑通那张票前 45 次调用里真正定位大约用了 6–8 次，留一倍余量。
从存储里的时间线看，**这个数字在 100% 的票上都响过** —— 包括最后成功交付的：

| 票 | 催了几次 | 每次催办时的探索量 |
| --- | --- | --- |
| `sh-row-82` | 9 次 | 14→25→26→35→38→57→59→59→60 |
| `sh-row-83` | 4 次 | 12→37→53→56 |
| `sh-row-85` | 2 次 | 19→31 |

每次都响的告警不是告警，是噪音；催办本身还要花一轮模型往返。

#### 「按需求分级」被数据否掉

用户的直觉（不同的票给不同的预算）是对的，但**票上没有任何特征能预测它需要探索多少**。
解 8 个会话（`.scratch/_budget-audit.mjs` / `_budget-predict.mjs`，按 `tool/ptc-dispatch`
的 `data.name` 数真工具名、按 `subCallId` 去重），拟合「首写前探索量」：

| 特征 | 与首写前探索量的相关系数 |
| --- | --- |
| `flowLen`（操作流程列字符数） | **0.038** |
| `segs`（流程列切段数） | **0.019** |
| `descLen`（问题描述长度） | **−0.490** |
| 描述里的英文标识符数 | 全为 0，无区分度 |
| 截图数 | 全相同，无区分度 |

最硬的反证是**同一张票跑两次差 3–4 倍**：`sh-row-82` 84 vs 57、`sh-row-85` 11 vs 39。
差异来自模型当轮状态，不来自需求。按需求分级只会得到一张拟合噪音的价目表。

真正能预测的是**重复**：`总调用数 vs 首写分钟` **0.977**、`重复率 vs 首写分钟` **0.817**、
`不同目标数 vs 首写分钟` **0.718**。`sh-row-81` 探索 82 次只有 **22 个不同目标** ——
**73% 是重复**（同一文件读 3–4 遍、同样内容 grep 十几遍）。

#### 改法

```js
export const EXPLORE_BUDGET = 25   // 原 12

/** 只取「定位」字段：read→file_path、grep→pattern、glob→pattern… */
export function explorationTarget (name, args) { … }

// total = 不同目标数（按 `${name}\0${target}` 去重）
// calls = 原始调用次数（同 subCallId 的多条事件仍去重）
// repeated = calls - total
```

1. **口径换成「不同目标数」**：同一个文件读第二遍、同一个关键词再搜一遍都不加数。
   阈值 **25** —— 首写前「不同目标」的中位数是 **24**，意味约一半的票被提醒一次，
   另一半干净通过。这才有区分度。
2. **催办话术把重复量说出来**：`你已经查了 N 处不同的东西……，其中 M 次是在重看同一处`。
   重复才是最该被提醒的那件事。
3. **任务书写明口径**：`探索预算 N 次（按**不同目标**计 —— 同一个文件读第二遍……
   都不加数）`。不写清会说反：模型以为「读满 N 次就触线」，读到 N−1 次宁可不动手。
4. **按项目覆盖**（`ProjectEntry.exploreBudget`，唯一站得住的「分级」维度 ——
   仓库大小与技术栈跨票稳定）：缺省全局 25，大仓 40–60、小仓 15。`scheduler` 算一次、
   同时喂任务书与执行器（`ExecCtx.exploreBudget`），两个消费者读同一个数。
   面板「基本」组新增一格（高级项，`kind: 'text'`，数字校验交给宿主 `validateProject`）；
   宿主 `describeProject()` 只透出「人配了没有」（空串 = 用全局），**不透出求值后的值** ——
   否则「没配」和「配成全局值」在界面上长得一样，人改不了主意。

#### 判据

1. **在 100% 样本上都触发的阈值不是告警，是噪音。** 它不再传递「你卡住了」的信号，
   只剩日志与模型往返的成本。
2. **样本量是 1 时给出的数字，只是猜测的一种写法。** `12` 从一张票的 6–8 次外推，
   `25` 来自 8 个会话的中位数 —— 写配置缺省值时要分清这两者。
3. **「分级」必须按稳定因素分。** 按票分 = 拟合噪音；按项目分 = 真有依据。
   分辨方法很简单：同一张票跑两次，这个维度会不会变。
4. **数重复比数次数更接近真相。** 73% 的探索是重复，而重复恰恰是「迷路」的直接形态；
   数调用次数会把「认真多读了两处」和「同一个文件读四遍」算成一样。

#### 自测

- `dev-run` 577 → **580**（探索计数口径 1 条、项目级覆盖校验 1 条、覆盖值一路传到
  任务书与执行器 1 条）。
- 改既有 2 条：硬编码 `/探索预算 12 次/` → `new RegExp(\`探索预算 ${BUILTIN_LIMITS.agentExploreBudget} 次\`)`
  （**不再硬编码数字**，否则每次调预算都要改测试）；`/读了 20 次/` → `/已经查了 20 处不同的东西/`。
- `client-smoke` 280 → **282**（勾上「显示全部字段」后能看到「探索预算」、能带出宿主下发的 40）。
- 回归验证：把 `scheduler` 改回 `const exploreBudget = BUILTIN_LIMITS.agentExploreBudget`
  → **恰好 1 条红**（通过 579，失败 1），证明覆盖链路真的被锁住了。

### 1.51 「一直催，会重复发好多次」：可重置的计数器挡不住重复（2026-11-16 当天第二轮）

#### 现场

上一条（阈值 12 → 25、口径换成不同目标数）刚装上，用户报：

> 优化这个一直催。就是你已经读了 60 次（read 26 次、grep 33 次、glob 1 次），任务书给的
> 探索预算是 12 次。……这个优化掉 会重复发好多次

同一张票收到了好几条一模一样的催办。**不是阈值问题 —— 25 也照样重复。**

#### 根因：两层，第二层才是根

1. **只看瞬时的 `justChanged`。** 旧判据「这一轮醒来恰好看到工作区变了就不念」，假设
   agent 的节奏是「一直读 → 一直改」。真实节奏是「改一会儿 → 读一会儿确认 → 再改」，
   那些「没在改」的醒来瞬间都失去保护，于是每回到只读状态就被念一次。
2. **阈值跟着计数器一起倒退。** `exploreNudges`（催过几次）被 `refreshProgress()`
   在每次文件改动时归零，而 `counted.total`（累计不同目标数）**只增不减**。于是下一轮
   判据 `total < budget * (0 + 1)` 立刻成立 —— `total` 早就越过 `budget` 了。
   改一次代码催一次，直到 `maxExploreNudges` 烧光。

**为什么会写成这样**：三个计数器（`nudges` / `lastNudgeAt` / `exploreNudges`）一起写在
`refreshProgress()` 里归零，是照着「它们都是催办预算」这个表面相似性抄的。但两套监控的
归零语义**本来就不同**：停滞监控的 `nudges` 归零是对的（再停 8 分钟该重新催），
探索监控的**不该**（读过的量不会变少）。

#### 改法：三道保险，第三道才是根

```js
let editingStarted = false      // 已经开始改文件 ⇒ 永久退休
let lastNudgedTotal = 0         // 单调门坎

// checkExplore 里：
if (editingStarted || justChanged) return
if (counted.total <= lastNudgedTotal) return   // ← 与状态无关的那一道
```

前两道都是状态量，任何一个被别处归零就失效。第三道拿 `counted.total` 这个累计只增的
量当门坎 —— 就算将来有人再往 `refreshProgress` 里加一行 `exploreNudges = 0`，
同一批探索也催不出第二句。

#### 判据

1. **让「不可能重复」由数据结构保证，不要由「没有别的地方会重置它」这个约定保证。**
   约定会被后来的改动打破，单调量不会。
2. **表面相似的计数器不要一起归零。** 先问「归零的语义对每个计数器都成立吗」——
   对 `nudges` 成立、对 `exploreNudges` 不成立，写在同一个函数里就埋了个必炸的雷。
3. **回归测试要造出真实的时间窗，而不是真实的调用序列。** 第一版用例每轮都有文件改动，
   旧代码照样绿 —— 因为 bug 只在「改完之后**停下来**」的那几轮里发生。所以快照序列
   写成 `S0 → S0 → S1 → S1 → S1 …`，并且让前 5 轮 `status` 报 `running`，
   否则循环两轮就到 `quietTicks` 退出了。

#### 自测

- `dev-run` 580 → **581**：新增「探索预算：改一会儿、读一会儿，不许反复催」，
  断言 `nudges.length === 1`。
- 回归验证分两次：① 摘掉 `editingStarted` → 红（实际催了 **4** 次）；② 只摘状态保险、
  保留单调门坎 → 绿，证明第三道独立成立。

### 1.52 两套看门狗各发一条，排队里就成了两条长消息（2026-11-17）

#### 现场

用户发来截图：某张票的「2 条排队消息」里并排躺着两条 ——

1. 「你已经查了 61 处不同的东西（read 32 次、grep 31 次、glob 13 次），其中 15 次是在重看同一处，
   任务书给的探索预算是 25 次。」
2. 「已经 8 分钟没有任何文件改动了 —— 你还在读和搜。这一轮需要的是把问题真正修好，
   但继续漫游读代码并不会让你更接近答案……」

> 注意第 1 条的文案已经是新口径（「查了 61 处不同的东西」），说明宿主跑的是 §1.51 之后的代码 ——
> 这一条不是旧 bug 复发，是**合流之前的另一个形态**。

#### 根因

两套看门狗各判各的、各自 `agent.followup`：

| 判据 | 数什么 | 触发条件 |
| --- | --- | --- |
| 停滞监控 `checkStall` | **时间**（距上次文件改动） | 8 分钟没动 |
| 探索监控 `checkExplore` | **动作数**（不同目标数） | 越过 `budget × N` |

两者覆盖不同的坏形态（一个抓「一次读 40 分钟」，一个抓「读得飞快但一直在读」）—— 这是设计意图，
没错。错的是**投递**：在一次不许闲着的长 turn 里，两条判据经常在同一秒同时成立，于是 agent
一口气收到两条长消息，每条都让它做一遍同样的三步动作。既浪费上下文，也把「催办」变成了噪音：
**两条都在说的道理只值一条。**

#### 改法

两个 check 从「判 + 发」拆成「只判」：命中时 `return { … }`，未命中 `return null`。
投递统一交给主循环里新加的 `deliverNudge(stall, explore)`：

```js
const stallDue = await checkStall()
const exploreDue = await checkExplore(justChanged)
await deliverNudge(stallDue, exploreDue)     // 一次唤醒最多发一条
```

- 两条都成立 → `createCombinedNudgeMessage`；
- 只 stall → 原 `createNudgeMessage`；
- 只 explore → 原 `createExploreNudgeMessage`。

**合并的原则不是「把两段拼起来」** —— 那样比发两条更糟（更长、更重复）。而是认出它们说的是同一件事，
**只说一遍**：开头一个从句把两个观测事实都交代掉（模型需要知道「它被看见了」），
随后一句「这两件事指向同一个结论：继续读下去不会让答案更清楚，该动手了」，
然后只留**一份**动作清单，最后保留「定位不到就说缺什么、不要硬猜一个改动交上去」这条出路。

#### 判据

1. **同一个目的，多个触发条件，投递要收敛到一个点。** 判据可以多套（时间、动作数、将来可能还有
   token 数），但「对 agent 说话」的出口只该有一个，否则每加一套监控就多一条重复消息。
2. **合并是「认出同一件事」，不是「拼接两段文本」。** 拼接会让消息变长、变重复，比分开更糟。
   自测里用 `(text.match(/edit 它/g) ?? []).length === 1` 钉住这一点 —— 动作清单出现两次就是退化了。
3. **「只发一条」要用预算钉死，不要让用例靠时序碰运气。** 两条预算都设成 1，总消息数就被钉死在 1：
   合流坏掉的第一次唤醒会各发一条，拿到 2 条直接红。

#### 自测

- `dev-run` 581 → **583**。新增两条：
  - 「催办：两套监控同时成立时只发一条，不许排队里并排躺着两条长消息」——
    `maxNudges: 1` + `maxExploreNudges: 1`，断言 `nudges.length === 1` 且 `kind === 'combined'`。
  - 「催办：合并文案把两件事说成一件，动作清单只出现一份」——断言两个观测事实都在、
    `edit 它` 只出现一次、反向 `doesNotMatch(/最有把握的那一处/)`。
- 回归验证：把主循环改回 `deliverNudge(stallDue, null)` + `deliverNudge(null, exploreDue)`
  → 恰好 1 条红（「实际发了 2 条」），恢复后全绿。
- 增量链：**583**（两套看门狗合流成一条消息 2 条，见 §1.52）、**584**（会话 id 拿到就落库 1 条，见 §1.53）。

### 1.53 一张票跑出两个会话：会话 id 只活在内存里（2026-11-17 当天第二轮）

#### 现场

用户发来截图：某个工作区的会话列表里并排两条**同名**会话「修复集成minio组件存放附…」，
一条 19 分钟、一条 1 小时。用户判断是「那个工单失败了，所以重试了」。

票 `pms|sh-row-93` 的时间线（`~/.dsh/storages/ticket_pipeline.json`）：

| 时刻 | 发生了什么 |
| --- | --- |
| 10:19:38 | 第一轮：新建工作区、建会话 `ticket-pms-sh-row-93-1794881978861` |
| 10:19:57 | 进「改代码」 |
| 10:28:15 | 「agent 已 8 分钟没有改动任何文件，第 1 次催它先动手」 |
| 10:33:33 | 最后一条心跳（这一站已 13 分钟） |
| **10:33:46** | 票被悄悄放回队列（`enqueuedAt`），**timeline 里没有任何对应节点** |
| 10:43:50 | 第二轮：重新定位 → 复用工作区 → 建会话 `…-1794883432402` |
| 11:05:04 | 第二轮失败（`git commit` 报「git add 被 .gitignore 忽略」） |

#### 根因

两个独立的缺口叠在一起：

**① 谁把票放回了队列？** 不是失败重试（那一刻票还在 `editing`，`attempt` 是 0）。
是**宿主重载了插件**：`cordis.patch.yml` 的 mtime 正是 **10:33:46** —— 与人改配置的时刻
**精确到同一秒**。插件重新挂载 → `recoverPending()` 扫到仍是 `editing` 的票 →
把它放回 `pending`（`recover.js:133`）。而 `setPhase` **不写 timeline**，所以
「有 `enqueuedAt`、没有节点」这个矛盾形态完全说得通。

**② 为什么第二轮没续接？** `runSessionId` 是 `scheduler.js` 里的局部变量
（`:509`），`onSessionId` 只把它记在内存里（旧代码）：

```js
onSessionId: (sessionId) => {
  if (typeof sessionId === 'string' && sessionId.length > 0) runSessionId = sessionId
}
```

`sessionId` **只在异常收尾时才写盘**（超时 / 失败 / 取消，`scheduler.js:1003/1010/1038/1083/1106`）。
插件一重载，那个变量随旧实例一起消失 → 票上 `sessionId` 是空的 →
下一轮 `executor.run` 拿到 `sessionId: undefined` → 走 `agents.create` **新建**，
而不是 `agents.resume` 续接。

旁证：第一轮那个会话在磁盘上**根本不存在**（`~/.dsh/sessions/` 下只有第二轮那条，
`workspace.json` 的 `sessionIds` 里也只有它）。它是在插件被卸载的瞬间夭折的，
从未落盘 —— GUI 里看到的第一条只活在宿主内存里。

#### 改法

**会话 id 拿到就落库，不等收尾。** `store.js` 加一个只动一个字段的窄接口：

```js
async setSessionId (key, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false
  const row = this.getTicket(key)
  if (!row) return false
  if (row.sessionId === sessionId) return true
  await this.repo.put(TABLES.tickets, key, { ...row, sessionId })
  return true
}
```

`onSessionId` 改成 async 并 `await` 它（执行器本来就 `await ctx.onSessionId(...)`）：

```js
async onSessionId (sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return
  runSessionId = sessionId
  try {
    await store.setSessionId(key, sessionId)
  } catch (error) {
    logInfo('会话 id 落库失败（不影响这一轮执行，但重启后可能续接不上）', { … })
  }
}
```

**不用 fire-and-forget**：我们正是要「它返回时写入已经落盘」这个保证。
插件恰好在写盘途中被卸载，恰好又回到这次事故的形态。

**为什么不做成 `setPhase` 的补丁**：`setPhase` 会顺带重写 `finishedAt` / `startedAt`
这些时间戳，而这里只想动一个字段；调用点在执行器**运行期间**，那时 phase 是
`editing` 之类的中间态，用 `setPhase` 还得再传一遍目标 phase，容易写错。

**顺手把恢复的文案说清楚**（`recover.js`）：`recoverPending` **本来就不会清 `sessionId`**，
所以修好 ① 之后下一轮自然能续接。但人看到「重新排队」会以为是从零跑一遍，
于是去 GUI 里找两条会话、拿第一条当废记录 —— 所以文案补一句：

```js
const sessionHint = row.sessionId ? '；这一轮会接着用上一轮的会话' : ''
lastError: `${was}，启动恢复后重新排队（工作区沿用，不会重新 clone${sessionHint}）`
```

#### 判据

1. **只在收尾写盘的状态，等于「进程一断就丢」。** 判断标准很简单：这个字段
   下一轮还要不要用？要用就必须在**产生它的那一刻**写盘，不能攒到收尾。
   `sessionId` 攒了；`attempt` / `changedFiles` 攒了没事（它们只在收尾时才有意义）。
2. **「凭空出现的时间戳」要顺着唯一写入点反查。** `enqueuedAt` 只有 5 处会写，
   排除掉会留 timeline 的几条之后，只剩 `recover.js` —— 这比猜「可能是崩溃」快得多。
3. **配置文件的 mtime 是事故现场的一部分。** `cordis.patch.yml` 的 mtime 与
   `enqueuedAt` 精确到同一秒，直接把「插件重载」和「票被放回队列」钉成了因果。
   以后再遇到「票莫名重新排队」，先看这个文件的 mtime。
4. **续接的默认值应该是「接着用」，不是「重开一个」。** 一张票跑出两条同名会话，
   人根本分不清哪条是真的；而续接的代价只是一次 `agents.resume` 调用（失败还能退回新建）。
5. **人的归因常常对一半。** 用户说「失败了所以重试了」——重试这件事确实存在（第二轮），
   但**触发重排的是一次插件重载，不是失败**（那一刻票还没失败）。事故报告里的
   「因为 A 所以 B」要拿时间线验一遍再采信。

#### 自测

- `dev-run` 583 → **584**。新增一条：
  - 「会话 id 拿到就落库：这一轮就算半路被打断，下一轮也认得出它」——
    假执行器报完 `ctx.onSessionId('mid-run-session')` 之后**立刻抛错**
    （模拟「半路被打断、result 根本不存在」），断言票上 `sessionId` 已经是它。
    如果只在收尾路径写盘，这条必然失败。
- 既有恢复用例加了三条断言：恢复后 `sessionId` 必须还在、`lastError` 必须写明
  「接着用上一轮的会话」、前置断言「得真的停在中间态」（`pending → editing` 不是合法边，
  写错了会静默留在 `pending`，恢复压根不碰它）。
- 回归验证：把 `setSessionId` 退化成 `return false`（等价旧行为）→ **恰好 1 条红**；
  把 `recover.js` 的 `sessionHint` 去掉、同时 `sessionId: undefined` → **恰好 1 条红**。
  两次都只红对应用例，恢复后全绿。

### 1.54 「①✓」对看工单的人是密码：站带要写人话，失败要落在倒下的那一站（2026-11-17 第三轮）

用户原话（m13787）：「插件中只标了序号 用户看不懂啊 而且不知道那一步错了 还不好看 优化」；
随后（m13909）把面板上 `sh-row-93` 的整段输出贴回来，末尾一句：
「没有明确的失败原因 哪里出的问题怎么修改 都不明确」。

#### 现场

一句话里叠了三个毛病，而且互相掩护 —— 谁先修都看不出效果：

| 现象 | 真因 |
|---|---|
| 站带是 `①✓②✓③✓④✓⑤✓（12 分 25 秒）⑥✓⑦✓⑧✓⑨✓` | 九站只有符号，人要回头翻图例才知道 ⑦ 是「提交」 |
| 全 ✓ 却标着「失败」 | 执行器先 `onPhase('mr-opening')` 记一条 `ok:true`，真正的失败由调度器收尾另记一条 `failed`；站带只看每站自身 `ok`，看不到后面那条 |
| 「最近错误」是 3098 字的原文 | 里面塞着整条 `git commit -m ...` 命令、几十个文件路径、以及同一段 stderr 重复两次 |

第 2 条是这次最值钱的发现：**「全打勾但结果是失败」比直接报错更让人困惑** ——
人会以为自己看漏了某一站，于是把九站重新数一遍，数完还是全 ✓。

#### 改法

**一、站名写人话。** `TIMELINE_NODES` 每个节点加一个 2–4 字的 `short`（`取单` / `定位` /
`工作区` / `会话` / `改代码` / `验证` / `提交` / `回填` / `通知`），站带走 `short` 不走 `no`：

```
取单✓ 定位✓ 工作区✓ 会话✓ 改代码✓（12 分 25 秒） 验证✓ 提交✓ 回填✓ 通知✓｜全程 45 分 34 秒
```

长度约束写进注释：2–4 字，九站要在一行里放得下；`①✓` 那种记号留给工具输出（要紧凑），
面板给人看。

**二、失败回填到它倒下的那一站。** `describeStations` 倒序扫最后一条主站，
`row.phase === 'failed'` 时把那一站的状态强制成 `failed`：

```js
const blamedNode = row.phase === FAILED_TERMINAL ? lastMainNode : undefined
// ...
else if (node === blamedNode) state = 'failed'
```

只认 `failed` —— `done` / `skipped` 不许涂红（它们最后一站自己那条也是 `ok`，
照搬同一套逻辑会把成功的票误标成失败）。站带上再补一句「｜✗ 倒在第 ⑦ 站「提交（提交）』」，
省掉人自己去找那个 ✗。

**三、错误要给「为什么 + 怎么办」。** 新增 `src/core/error-advice.js`，12 条规则，
判据是**特征串**不是 `kind`（`internal` 一个值盖住几十种情况，按 kind 分等于没分）：

```
最近错误：提交失败：git 把提交说明里的引号当成了文件名
  为什么：提交说明里带了双引号。插件把这条命令交给 Windows PowerShell 执行时，
          PowerShell 会重新拆一次带双引号的参数，于是说明被切成好几段，
          git 把后半段当成了「要提交哪些文件」的路径。代码其实已经改完了、验证也过了。
  怎么办：已修复（2026-11-17）：提交说明会把双引号换成单引号，序号里的公式也不再进标题。
          这张票直接「重跑」即可 —— 工作区里的改动还在，重跑会重新提交。
  原文：本地提交失败（git commit -m fix(pms): [pms] #IF(COUNTA(…）…（原文共 3098 字，已截断）
```

三条硬约束写进文件头：**只解释不吞原文**（排障的人可能要原样去搜）、**认不出就老实说认不出**
（硬套模板比不解释更坏）、**判据用特征串不用 kind**。

#### 判据

1. **符号是给人看的还是给机器看的，决定它该不该出现在界面上。** `①✓` 在工具输出里省地方，
   在面板上就是密码本。两处不是同一份文案，但必须是同一个数据源（`short` 从 `TIMELINE_NODES` 取）。
2. **状态要按「结果」算，不能按「每一步自己说 ok」算。** 每站自己 `ok:true` 而整票 `failed`
   是常态（失败发生在站的收尾里），站带必须补一层「按最终结果回填」。
3. **错误的「原文」和「解释」要分开给。** 人先看解释决定怎么办，需要深挖时才看原文 ——
   把两者混在一行里，等于让人先读完 3098 字才知道结论。
4. **同一份解释不许两处各写一遍。** 工具输出与面板都用宿主下发的 `lastErrorAdvice`，
   面板不再自己拼措辞（否则工具说「引号拆命令」、面板说「未知错误」，人不知道该信哪个）。
5. **挡一次不够，要挡在「最靠近源头」的那一层。** 双引号既在 `sanitizeCommitText`（出口）挡，
   也在序号解析（入口）挡 —— 公式与双引号各有两条进入路径，只挡一条会漏。

#### 自测

- `dev-run` 584 → **596**，新增 12 条（第 21 节 5 条 + 第 22 节 6 条 + 会话标题 1 条）：
  - 第 21 节（顺序号公式 / 提交说明双引号）：`looksLikeFormula` 正反例、`sanitizeCommitText`
    正反例（`$HOME`、反引号、`-- `、换行、`%` 必须原样保留）、本地提交说明不含双引号、
    `buildMrTitle` 挡公式、电子表格序号是公式时退回 `sh-row-93` 且 `identitySource === 'fallback-row'`。
  - 第 22 节（错误要能看懂）：认得出的错误三样齐全 / 认不出的老实说认不出 / 原文不被吞
    （含超长截断且**明说**截断）/ 渲染行形状且长原文渲染后要短得多 /
    `pipeline_status` 明细给人话且「最近错误」只出现一次 / **⑦ 自己 ok、票却失败时 ✗ 落在⑦身上**
    （含 `done` 票不许涂红）。
- 既有 3 条站带断言改成中文短名（`取单✓ 定位✓ 工作区✓ …`）；图例断言改成
  `/流程带的九站按顺序是：获取工单 → 查找项目/` —— **文案变了断言就该跟着变，不是把断言放宽**。
- 回归验证（`.scratch/_regress-562.cjs`，参数 `none|nosanitize|noformula|noseqguard`）：
  `nosanitize` → 红「提交说明里还有双引号」；`noformula` → 红「标题里不该出现公式」；
  `noseqguard` → 红「公式要当成空序号」。三次都只红对应用例。
- **第一版测试是假绿的**：用公式当序号时 `buildMrTitle` 已经把公式挡掉，双引号根本没进文本，
  于是「拆掉清洗」和「拆掉公式判断」两种改法都 589/590 全绿。改成「描述本身带双引号」+
  单测 `buildMrTitle` 之后才抓住。**一条永远绿的回归用例比没有更坏** —— 它会让人以为这条路有人守。

### 1.55 同一个检出上「先后两张票」：租约只管得到票，管不到目录（2026-11-17）

#### 现场

用户问的是 super-agent 那类形态：「多个会话在一个工作区修改，可能改同一个文件，插件能让他们
互相有感知么」。实际观察：GUI 里那些会话是**先后**的，不是同时的 —— `scheduler.js` 一直是
`let running = false`，重入直接回 `already-running`。所以「并发」不是当时的问题。

但这不等于没问题。三个真实缺口：

1. **租约的粒度是「票」，不是「检出」**。`store.acquireLease(ticketKey(projectId, recordId), ttl)`
   —— 防的是「同一张票被跑两遍」。就地模式（`isolateWorktree` 缺省 false）下，同一个仓库上的
   两张**不同**票共用一个工作目录，两个宿主进程可以同时改它。票级锁对此一言不发。
2. **后一张票看不到前一张改了什么**。人写代码会顺手看一眼 `git log` 或者同事刚动过哪儿，
   模型不会主动去查。前一张票刚改了 `pms-server/.../TicketController.java`，后一张票按
   「原始代码」的印象去改，就会把前一票的修复覆盖掉。
3. **`changedFiles` 会把别人的提交算进来**。`collectChanges` 用
   `git diff <baseline.sha>`（基线 = agent 动手前拍的 `git stash create`）。如果这中间
   另一个进程把改动**提交**进了这个检出，那些文件也在工作区里，于是出现在同一份 diff 里，
   被当成这张票的产物一起提交 —— 替别人签字，复盘时也数不清到底谁改了什么。

#### 做了什么（四层，对应工单里「第 2 档」）

**A. 仓库级互斥（`store.js` + `scheduler.js`）**

- `repoLeaseKey(repoPath)`：复用同一张 `leases` 表，key 用 `repo\u0000<归一化路径>`。
  归一化是 `\` → `/`、折连续斜杠、去尾斜杠、Windows 下折大小写 —— **`D:\WorkSpace\repo`、
  `D:/WorkSpace/repo/`、`D:\\WorkSpace\\repo` 必须是同一把锁**，否则换个写法就能绕开互斥。
- `acquireRepoLease` / `renewRepoLease` / `releaseRepoLease` / `isRepoLeasedByOther`，
  形状与票级完全一致（含回读校验，因为 read→put 之间没有互斥）。
- `runOne` **在 `prepareWorkspace` 之前**抢检出（那里可能真去建 worktree / 登记工作区，
  先建完才发现检出不归我们就是白做）；抢不到就把这张票放回 `pending`、写一句人话
  `lastError`、记一条时间线，然后 `return true` 让出这一轮。
- 租约心跳（`heartbeatId`）里**同时续两把锁**：票租约续成功后马上续仓库租约，
  续不上就 `leaseLost = true` + `handle.abort()` 让出。
- `finally` 里**先放仓库租约、再放票租约** —— 顺序反过来会有一个「票已自由、检出还锁着」的窗口。
- `tick` 的消费循环把让出的票 key 收进 `skippedByRepoLease`，下一圈 `pickNext({ excludeKeys })`
  跳过它 —— 否则一轮会在同一张票上原地打转。**关键语义：抢不到检出不是「这一轮停了」，
  而是「这张票先让它，去跑队列里别的票」。**

**B. 票史推导（`recentProjectTickets`，不新开表）**

从 `store.listTickets()` 推同项目、非本票、按 `rowActivityAt` 降序取前 6 条，
每条带 `recordId / phase / label / files（前 8 个）/ committed`。**不新开表**：真相就在
票据表里，再存一份就是第二真相，迟早分叉。

**C. 任务书告知（`prompt.js` 的 `renderInFlightSection`）**

插在「代码定位」相关章节之后、「定位到具体页面」之前（两者都是「别人已经/正在留下什么」，
放一起读最省事）。正文先破误解「同一时刻只跑一张票，所以你手上不会和别人并行改同一个目录」，
再给清单，再给三条用法：改到同一文件先看它现在什么样、同一段逻辑别重写、
**「这条信息只是线索，不是禁令」**——票还没跑，改哪是它自己定位出来的，我们并不知道。

**D. `changedFiles` 归属修正（`collectChanges`）**

`baseline` 现在除了 `sha` 还带 `head`。收完改动后：若 `baseline.head !== 当前 HEAD`，
就 `git diff --name-status <head> <HEAD>` 查出「这中间别人提交了哪些路径」；对这些路径
再逐条问 `git diff HEAD -- <path>` —— **工作区与 HEAD 一致**说明该路径上的全部变化都来自
别人的提交（排掉，计入 `droppedOthers`）；**不一致**说明 agent 在别人的提交之上又改了一笔
（保留）。没有 `baseline.head` 的老基线一律不排（判断不了就多收，少收会让票白跑）。

#### 判据

- **换个写法也抢不到同一把锁**：路径归一化之后必须是同一个 key。
- **一个项目被占不能拖垮整轮**：让出这张，接着跑下一张。
- **静默必须能被下一次尝试纠正**：抢不到只是这一轮让出，不是把票判失败。
- **「不是它改的」不该进它的提交**：多收会替别人签字，少收会让票白跑 —— 两者都要有断言。

#### 自测

`dev-run` 596 → **602**（仓库租约 3 条：key 归一化 / 让出但接着跑 / 跑完释放；
任务书 3 条：出现位置与措辞 / 没有就不出现 / 从票据表推出且排除自己），
`gitlab-checks` 86 → **96**（`git add` 与忽略文件 2 条 + 基线之后别人提交 3 条 +
白名单形状等既有项合并计数）。

### 1.56 「哪一步失败」要写成一句话，重开从失败那站接着跑（2026-11-17 第四轮）

#### 现场

用户贴回 `sh-row-82` 的整块面板输出，末尾三句原话：

> 这失败了也没告诉用户哪一步失败了 是工单处理问题失败了 还是测试失败了
> 不要重新跑 应该是修复只针对失败的那一步进行修复然后接着跑后续的
> 还在那个失败的会话中继续

而面板当时给的是：站带 `获取工单✓查找对应工单的项目✓…发送消息✓ 全程 50 分 46 秒`
（**每一站都是 ✓**）、`最近错误：本地提交失败（git add -- .idea/jarRepositories.xml …）`
（2000 多字，含整条 shell 命令）、`这一站已经待了 5751 分钟`。

三个毛病叠在一起：**站带全绿**（失败是一条独立节点，站带只认每站自己的 `ok`）、
**没人说倒在哪**（`failedStation` 不存在，渲染期只能猜）、**重开就是整票重跑**。

#### 根因

1. 失败那一条时间线节点（`node: failed`）不与任何主站关联，`describeStations` 只看每站
   自己的 `ok`，所以 ⑦ 提交那条 `ok: true` 照样显示 ✓。
2. 失败时**没有把「倒在哪一站」存下来** —— 渲染期能从 timeline 倒推，但下一轮要拿它做决定，
   就必须落库。
3. `resetByHuman` 一律把票当新票：清 `attempt`、清 `lastError`、⑤ 从头探索。

#### 改法

**记录（`store.js` + `scheduler.js`）**：票据新增 `failedStation` / `resumeFrom` / `baseline` /
`verification` 四个字段。失败收尾写 `failedStation = lastMainStationOf(timeline)`，
**四处失败分支都要写**（正常收尾、catch 终态失败、超时/取消、可重试退避）—— 真机 `sh-row-82`
正是从执行器里抛出来的，走 catch。成功收尾则把它清成 `undefined`。

**续跑计划（新文件 `src/core/station.js`）**：`resumePlanOf(station)` 把站翻译成「这一轮做什么」——

| 倒在哪 | 要 agent | 要重跑验证 | 说明 |
|---|---|---|---|
| ⑤ 改代码 | 是 | 是 | 代码没改完，一切重来 |
| ⑥ 跑验证 | 是 | 是 | 可能要看报错再改一笔 |
| ⑦ 提交 | 否 | 否 | 代码改完、验证过了，只差一次提交 |
| ⑧⑨ | 不给计划 | — | 回填/通知走 `pendingEffects` 补偿，不走重跑 |

**执行器（`executor-agent/index.js`）**：`needsAgent === false` 时完全跳过起 agent（也不 `resume`），
只报一句「从「⑦ 提交」接着跑，这一轮不新建会话」；基线优先从票据还原；
验证优先用 `ctx.verification`（文案注明「沿用上一轮」）；要 agent 时推的是
`createResumeMessage()`（三段：上一轮停在哪 + 接着往下做 + 三条要点），**不重推整份任务书**。

**工具（`pipeline-reset.js`）**：缺省从 `failedStation` 续跑，新增 `from: begin` 才是整票重来；
`from` 认不出返回 `bad-from`，不猜。返回体新增 `resumeFrom` / `failedStation`。

**面板（`pipeline-status.js` + `lib/client.js`）**：明细新增 `卡在哪一步：**提交**（第 7 站「⑦ 提交（本地提交 / PR）」）`
与 `怎么接着跑：pipeline_reset 会从这一步继续…`；机器可读载荷新增 `failedStation` / `failureCategory` / `canResume`；
面板把按钮从「重跑」改成「接着跑」（`canResume` 时），title 说明「前面做完的不重做，会话也还是原来那个」。

#### 判据

- **渲染能算出来的东西不等于存下来了**：要给下一轮做决定的，就必须写进票据。
- **最常见的失败形态才是主路**：执行器抛异常走 catch，别只改正常收尾。
- **续跑看「还缺什么」不看「跑到哪儿」**：⑦ 倒下时验证已过，重跑是浪费。
- **复用状态要成对**：复用会话就必须复用基线，只复用一半会让改动凭空消失。
- **判不出站就说「未知」**：返回空串会让面板渲染成「卡在哪一步：****」。
- **校验说「认得出」就要真按它跑**：`from` 通过了参数校验、行为却退回失败站，
  比直接报错更难发现 —— 这一条是本轮的用例抓出来的（第一版传 `{}`，store 自己读回 `failedStation`）。

#### 自测

`dev-run` 605 → **624**（`station` 纯函数 4 条 + 失败/成功收尾的落库与清理 2 条 +
`pipeline_reset` 五条分支 + `pipeline_status` 明细），
`gitlab-checks` 96 → **103**（续跑 7 条）。

两条回归验证都只红对应用例：把 `failedStation` 那两行去掉 → 红「失败站要落库」；
把 `pipeline_reset` 的缺省值改回 `null` → 红「缺省从失败那一站续跑」。

## 2. 代码清单

`src/` 共 **52 个 .js / 26 478 行**；`scripts/` 共 10 个 .mjs / **18 863 行**（`dev-run.mjs` **8 383 行**）；`lib/client.js` **5 399 行**（浏览器端设置面板）。

| 目录 | 行数 | 文件 |
| --- | --- | --- |
| `src/contracts/` | 1 687（9 个 .js） | `errors.js`（错误模型）、`types.js`（阶段机 + 指纹 + **`TIMELINE_NODES` 17 节点表 / `TimelineEntry` / `parseBitableUrl` / `parseFeishuLink`**）、`feishu-columns.js`（`FEISHU_SEMANTIC_FIELDS` 13 个语义列名）、`ticket-source.js`（`scan` 只读 + `writeResult` 唯一写入口）、`work-executor.js`（`ExecCtx` + **`onFlow` 回调**）、`push-adapter.js`、`repo-locator.js`、`record-filter.js`、`git-status.js`（`-z` 状态/改名解析 + 插件自有目录排除规则） |
| `src/core/` | 7 763（16 个 .js） | `prompt.js`（任务书渲染；`renderTicketContent` 的图片块**字段名是 `attachment`**，照宿主 `ImageBlock` 契约；`## 工作方式` 一节含**探索预算**，`## 改完怎么验证` 由项目 verify 注入，flow < 15 字时改走「截图字面量 ⇒ grep」）、**`ticket-memory.js`（跨票记忆：关键词抽取 / 召回 / 命中计数，key = projectId）**、`scheduler.js`（调度核心 + `writeBackFor` / `renderWriteBackResult` / `pendingEffects` / `replayPendingEffects` + **`markNode` / `markExtra` 全链路打点** + 成功票写记忆）、`store.js`（持久化 + 租约 + **`appendTimeline`** + `sanitizeRow`）、`config.js`（配置校验 + 描述符 + `projects` 子树 + **飞书表定位「至少一个依据」校验 / 两套 token 并存的警告**）、`recover.js`（启动恢复）、`workspace.js`（项目工作区）、`worktree-path.js`（`isIsolatedWorktreePath`，清理安全校验）、**`plugin-version.js`（安装副本 vs 源码的文件级比对）**、**`error-advice.js`（把 `lastError` 翻成「为什么 + 怎么办」，12 条规则按特征串匹配，认不出就老实说认不出）**、**`station.js`（九站顺序 / `lastMainStationOf` 倒推失败站 / `resumePlanOf` 把「倒在哪站」翻译成「这一轮做什么」/ `failureCategoryOf` 用人要做的动作命名）**、**`branches.js`（`parseBranchRefs` / `mergeBranchChoices` / `listBranches`，分支候选）**、`prompt.js` / `prompts.js`（任务书与反注入提示）、`domain.js`、`branch-name.js` |
| `src/adapters/` | 11 599（17 个 .js） | 见下表 |
| `src/tools/` | 3 105（7 个 .js） | `define.js`（工具范本）、`pipeline-scan.js`、**`pipeline-status.js`（按项目聚合的总览 + 9 主站流程带 + 关键节点时间线 + 「现在停在第 N 站」+ `canReset`/`canForget` 两个布尔）**、`pipeline-doctor.js`、`pipeline-reset.js`、**`pipeline-forget.js`（删本地票据记录；`FORGETTABLE_PHASES` 与 `canForget` 是「能不能删」的唯一口径）**、`pipeline-cancel.js` |
| `src/remote/` | 965（2 个 .js） | `descriptors.js`（**11 个 Remote 方法**，含五个带参的 `setProjectTable(index, url)`、`status(includeDone?)`、`scan(projectId?)`、`reset(recordId, projectId?)`、`forget(recordId, projectId?)` 与 `testProject(index)`）、`host.js`（宿主 Remote 通道 + **`describeProject` 摊平电子表格字段** + `setProjectTable` 解析落盘 + **`status`/`scan`/`cancel`/`reset`/`forget` 复用工具的 collect\* 层**；`status(includeDone)` 只认严格 `true`，对应运行页签的「显示历史」） |
| 根 | 1 360（1 个 .js） | `src/index.js` —— 组合根（装配全部适配器、注册**五个**工具、起轮询；`inspectCheckout` / `describeDirtyCheckout` / `pickAdapterFactory` / `VERIFY_TIMEOUT_MS` 也在这里） |

| 适配器 | 行数 | 状态 | 说明 |
| --- | --- | --- | --- |
| `source-feishu/` | 3 833（`index.js` 2 277 + `sheets.js` 754 + `probe.js` 804） | **真实可用（含电子表格）** | 飞书多维表格 API + **电子表格 API**；`resolveTable` 是表型分派总闸（显式 `tableKind` → `spreadsheetToken` → `appToken` 双试 → `docNamePattern`），`get_node` 不再硬写 `obj_type`；`scan` 拆 `scanBitable`（翻页 + 早停）/ `scanSheet`（读全表 + 逐行指纹、mtime 恒 0、不早停）；水位、状态值可配、recordIds 收窄、截图三形态（电子表格只支持 path/url，内嵌图当没有）、`allowedImageHosts` 白名单；**`appToken` 可写整条表格 URL**（`parseBitableUrl` 啃 `?table=` / `?view=`）；**`extractSheetToken` 四种写法都认**（`/sheets/<token>`、`/wiki/<token>`、裸 token；带协议头却认不出就抛 `invalid-input`，不再原样拼进接口）；**`writeResult` 回填三列**（多维表格按 `record_id` PUT；**电子表格按序号列重新定位行 + `values_batch_update` 写三格，工单 #22**） |
| `source-wps/` | 1 675 | **experimental（解析可用；配了「表格链接」就有内置取数通道）** | `index.js` + `xlsx.js` + `zip.js`；自解 xlsx/OOXML、截图按锚点解包；「待修改项目」列进 `targetProject`；recordIds 收窄；取数通道有两个：`match.sheetUrl` 非空时 `wpsOptionsFromMatch()` 会装内置下载器（**不需要注入**），或宿主注入 `fetchSheet`；两者都没有才抛 `MISSING_FETCH_SHEET`（**2026-11-16 纠正**：此前写成「主装配不注入 ⇒ 一张票都拿不到」是错的，`pipeline_doctor` 也据此从「一律阻断」改成分档）；`recordId` 用行号 ⇒ 插行会让票换身份（已知限制）；**`downloadSheetLimited` 下载通道有超时 / 取消 / 字节上限 / 逐跳重定向校验** |
| ~~`source-webform/`~~ | ~~106~~ | **已移除（工单 #18）** | 演示用内存表单源，水位只在内存里 `memoryWatermark = new Map()`，重启就把同一批工单重收一遍。实现已移到 `plugins/ticket-pipeline/scripts/fixtures/source-webform/index.js` 留档（`scripts/` 不进安装包），`PLATFORMS` 只剩 `feishu / wps / mock`，老配置会拿到「改用 mock 或 feishu」的迁移提示 |
| `source-mock/` | 337 | 测试 | 离线源；也接 recordIds；实现 `writeResult` 供自测断言 |
| `executor-agent/` | 3 548（`index.js` 3 113 + `agent-failure.js` 252 + **`explore-budget.js` 183**） | **真实实现** | 真 agent 改码、**先拍基线**（`createBaseline`：`git stash create` + 未跟踪文件内容哈希）再 `-z` 口径收集改动、跑验证、在工作区检出里做本地提交（`commitLocally`，点名暂存 `git add -- <文件>`）；`unstageSensitiveFiles` 把 agent 自己暂存进去的敏感文件退回去；**敏感名单 8 大类 41 条正则**、**`.git`/profile 篡改自检**（28 个 hook 名 + 10 个 git 元数据文件 + 4 个 `cordis.*`）；**`reportFlow` 通过 `ctx.onFlow` 上报 ④ 创建会话（分支+模型，含会话 id / provider+model / 工作目录）**；三个出口都带 `sessionId`，`keepSession` 控制会话回收；`repo.gitlab.enabled: true` 时才额外开 draft MR；含 `agent-failure.js` 失败原因识别（限流转可重试）；**两套看门狗共用一次 `git status` 指纹** —— 停滞（8 分钟没改文件）+ **探索超预算（`read`/`grep`/`glob` 数到 `agentExploreBudget` 就催，`explore-budget.js` 只认 `tool/ptc-dispatch` 的 `data.name`，不认恒为 `run_code` 的 `tool/call`）** |
| `executor-mock/` | 144 | 测试 | 只演不动真格；返回假的 `commit = { sha: 'mock…', branch, files }` |
| `gitlab-client/` | 495 | **真实可用** | Commits API + MR API；源分支已有开放 MR 时复用而不撞 409 |
| `push-qqmail/` | 581 | **真实可用** | 零依赖手写 SMTP（`node:net` / `node:tls` / `node:crypto`），已实发成功 |
| `push-feishu/` | 356 | **真实可用（推荐）** | 用你自己的飞书自建应用直接发 IM 消息（`im/v1/messages`，`content` 必须字符串化 JSON），**不经过任何第三方**；与读表共用一对应用凭据；`230013` 归 `invalid-input` 并给出「去设机器人可用范围」的修法 |
| `push-pushplus/` | 205 | 可用（需实名） | HTTP `pushplus.plus/send`；微信走它的 `clawbot` 渠道。**未实名账户每个渠道额度都是 0**，接口回 `905` |
| `push-mock/` | 65 | 测试 | |
| `locator-table/` | 187 | **真实可用** | 工单 projectId → 仓库/分支/remote 的查表定位器 |

### 2.1 工具（对宿主暴露的 6 个）

| 工具 | 作用 |
| --- | --- |
| `pipeline_scan` | 立刻扫一轮工单表 |
| `pipeline_status` | **缺省给按项目聚合的总览**（每项目一行战报 + 每票一行摘要 + 一行 9 主站流程带）；`view: "tickets"` 才是逐票明细，传 `recordId` 一律走明细 |
| `pipeline_doctor` | 环境体检：git 链路、各项目仓库连通性、凭据、执行器与通知适配器，以及**正在跑的插件是不是比本地源码旧** |
| `pipeline_reset` | 把 failed / needs-info / gone 的票放回队列重跑 |
| `pipeline_forget` | **删掉一张历史票的本地记录**（清理历史用）。不碰工单表、不回滚代码、不删工作区；只对 `done` / `skipped` / `failed` / `gone` / `needs-info` 生效 |
| `pipeline_cancel` | 取消正在跑的那张票（并发恒 1） |

---

## 3. 平台适配层：可插拔到什么程度

这一层是「后续能替换或新增工单来源」的落点，做法见 `docs/adr/0001-平台适配层可插拔.md`。

### 3.1 三张静态注册表（`src/index.js:201/221/227`）

```js
export const SOURCES = { mock, feishu, wps, webform }      // 一个项目一个实例
export const EXECUTORS = { mock, agent }                   // 全局单实例
export const PUSHES = { mock, pushplus, qqmail }            // 全局单实例
```

### 3.2 能力声明式注入（`src/index.js:94-113` `CAPABILITY_ASSEMBLERS`）

适配器不在 `SOURCES` 里直接点名宿主能力，而是**声明**自己要哪些，内核按声明装配：

| 能力 | 装配器给的东西 | 谁在用 |
| --- | --- | --- |
| `watermark` | `getWatermark` / `saveWatermark`（水位必须落盘，否则重启后满屏新票） | feishu、wps |
| `secret` | `getSecret`（密钥现取，不落明文配置） | feishu |
| `localFile` | `readLocalFile`（路径形态截图读本机字节） | feishu |
| `scanTuning` | `safePageRun` / `goneAfterScans`（早停与退役节流） | feishu、wps |

**没声明的能力一律不注入** —— 多给只会让「这平台到底依赖什么」越来越说不清。

### 3.3 新增一个平台要写什么

一个目录（实现 `TicketSource` 契约）+ `SOURCES` 里一行（声明 capabilities、可选 `match.build` 翻译绑定参数）+ 配置里 `projects[].match.platform` 加一个取值。**内核与组合根其余部分一行都不用改。**

平台枚举：`src/core/config.js:447` `PLATFORMS = ['feishu', 'wps', 'mock', 'webform']`（表驱动，新增平台只加这一处）。

### 3.4 契约层（8 个文件 / 1 195 行）

| 契约 | 内容 |
| --- | --- |
| `errors.js` | `ERROR_KINDS` 7 类（auth / network / rate-limit / not-found / invalid-input / aborted / internal）；`RETRYABLE_KINDS = {network, rate-limit, internal}`；`FATAL_KINDS = {auth, not-found, invalid-input}`；`PipelineError` 带 `retryAfterMs` |
| `types.js` | 11 个 phase 与 `PHASE_TRANSITIONS` 转移表；`TERMINAL = [done, skipped, failed, gone]`；指纹字段序 |
| `ticket-source.js` | `TicketSource` 接口：`scan()` 产出 created / updated / disappeared；**可选 `writeResult(recordId, {status, result, handledAt}, signal)` 是唯一写入口**，只在 done/skipped 后调一次 |
| `work-executor.js` | `WorkExecutor` 接口：`run(ticket, target, ctx)` 产出 `ExecResult`（含可选 `commit` / `mr` / `sessionId`） |
| `push-adapter.js` | `PushAdapter` 接口：`send(input, signal)` 产出 `PushReceipt` |
| `repo-locator.js` | `locate(projectId)` → 仓库 / 分支 / remote |
| `record-filter.js` | 工单收窄开关（recordIds） |
| `git-status.js` | `parseStatusZ` / `parseNameStatusZ` / `statusCodeToAction`：`-z` 状态与改名解析、插件自有目录排除规则 |

---

## 4. 配置项全表

全局配置 **33 个键 / 7 个分组**（`src/core/config.js` `CONFIG_FIELDS` + `CONFIG_GROUPS`，含 `pushplus.*` / `qqmail.*` 这类点号子键），另有项目级配置（`projects` 子树 25 个字段，不在这 33 个里）。

| 键 | 类型 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- | --- |
| `pollIntervalMinutes` | number | 3 | 1–60 | 轮询间隔 |
| `safePageRun` | int | 20 | 5–100 | 连续 N 条已知未变就早停（防误杀退役） |
| `goneAfterScans` | int | 3 | 1–20 | 连续 N 轮扫不到才退役 |
| `concurrency` | int | 1 | 固定 1 | **当前恒为 1，且是死配置**（代码无消费点） |
| `leaseTtlMinutes` | number | 10 | 1–60 | 租约 TTL |
| `leaseHeartbeatSeconds` | number | 60 | 1–1800 | 租约续期心跳间隔 |
| `maxAttempts` | int | 2 | 1–5 | 超过即进死信 |
| `workExecutor` | str | `mock` | enum `agent` / `mock` | **强校验**：写错（含大小写、尾空格）直接抛 `invalid-input` 并列可用值，**不再静默退回 mock**；`undefined` / `null` / 空串才回落 `mock` |
| `ticketTimeoutMinutes` | number | 40 | 5–180 | 单票执行超时 |
| `isolateWorktree` | bool | **false** | — | **改代码落点**：`false`（缺省）直接在项目工作区的检出里改、就地提交，**检出脏也能跑**（先拍基线、只提交 agent 改过的）；`true` 才每票 `git fetch` + `git worktree add -b <branch> .agents/worktrees/<branch>` |
| `fetchBeforeCreate` | bool | true | — | 建工作区前先 `git fetch`（只有 `isolateWorktree: true` 时用得上） |
| `branchPrefix` | str | `ticket-` | — | 分支名前缀（只有 `isolateWorktree: true` 时用于票分支） |
| `worktreeRetentionHours` | number | 24 | 0–720 | 隔离 worktree 保留时长（只有 `isolateWorktree: true` 才有 worktree 可清） |
| `keepSession` | bool | **true** | — | **处理完保留会话**：agent 实例一定释放，会话留在项目工作区名下（GUI 里能点进去继续追问）；设 `false` 才连会话一起收掉 |
| `writeBack` | bool | **true** | — | **处理后回填工单表**：「是否处理 / 处理结果 / 处理日期」三列；关掉退回纯只读，一个写请求都不发 |
| `writeBackStatus` | str | `是` | — | 回填写进「是否处理」的值（空串回落 `是`；有的表用「已完成」） |
| `provider` | str | `workbuddy` | — | 模型 provider |
| `model` | str | `''`（空=跟随会话默认） | — | 留空才跟随会话默认；钉死会在它被限流时全灭 |
| `maxTokens` | int | 32000 | 1024–200000 | |
| `agentPreset` | str | `ptc` | — | 挂给 agent 的 preset（=工具矩阵） |
| `pushAdapter` | str | `pushplus` | enum `mock` / `pushplus` / `qqmail` | **强校验**：写错抛 `invalid-input` 并列可用值，**不再静默退回 mock** |
| `pushplus.token` | str | `''` | — | PushPlus 令牌（**当前走明文配置**，与文档「建议走 credentials」矛盾） |
| `pushplus.channel` | str | `clawbot` | — | 微信经此渠道中继 |
| `pushplus.template` | str | `txt` | enum `txt` | |
| `pushplus.callbackUrl` | str | `''` | — | 送达回执回调；留空只有「已受理」 |
| `qqmail.host` | str | `smtp.qq.com` | — | SMTP 主机 |
| `qqmail.port` | number | 465 | 1–65535 | |
| `qqmail.secure` | bool | true | — | 是否 TLS |
| `qqmail.user` | str | `''` | — | 发件账号（授权码从凭据服务取 `QQMAIL_AUTH_CODE`） |
| `qqmail.to` | str | `''` | — | 收件人 |
| `notifyOn` | string[] | `[done, skipped, failed, needs-info]` | — | 哪些阶段发通知 |
| `enabled` | bool | false | — | 总开关 |
| `logLevel` | str | `info` | enum | **死配置**（代码无消费点） |

### 4.1 项目级配置（`projects[]`）

飞书表定位用到的 9 个键里 **8 个是新增**、1 个（`sheetName`）**复用金山源已有的同名键**（**已实施**，见 `docs/ticket-pipeline/feishu-sheet-source.md` §4.2 设计、§12 实施结果）。它们只对**飞书电子表格**分支有意义；配了但表是多维表格时忽略（不报错）。

指引：字段、默认值与生效条件见 `docs/ticket-pipeline/feishu-sheet-source.md` §4.2；表型分派的决策依据见 `docs/adr/0005-飞书电子表格源按表型分派.md`。

| 字段 | 用途 |
| --- | --- |
| `name` | 项目名（= 工单 projectId，定位仓库用） |
| `match.platform` | `feishu` / `wps` / `mock` / `webform`；飞书项目支持 `feishu`（**多维表格 + 电子表格**两种表型，插件自动判断，表型不写进配置） |
| `match.appToken` / `tableId` / `viewId` / `docNamePattern` | 飞书表定位 |
| `match.spreadsheetToken` | 飞书**电子表格** token（`shtcn…`）；与 `appToken` 二选一，配了插件就按电子表格处理（整条表格链接贴进来也行） |
| `match.sheetId` | 电子表格里的**工作表** id（与 `spreadsheetToken` 配套，与 `sheetName` 二选一） |
| `match.sheetName` | 电子表格里的**工作表名**（与 `spreadsheetToken` 配套，与 `sheetId` 二选一）。**与下方金山表定位共用同一个键**（语义一致：这张文档里用哪个页签），不新增第二份定义 |
| `match.sheetHeaderRow` | 表头在第几行（默认 `1`）；行号身份下表头行一变身份就变，所以不自动往下扫 |
| `match.sheetIdentity` | 行身份来源：`seq`（默认，序号列值）/ `row`（物理行号）。电子表格没有 `record_id`，身份只能自造 |
| `match.sheetIdColumn` | 身份取自哪一列（默认「序号」），仅 `sheetIdentity: 'seq'` 时生效 |
| `match.sheetColumns` / `match.columns` | 列名覆盖 `{语义: 实际表头文字}`，如 `{"description":"缺陷描述"}`。前者管电子表格，后者管多维表格（工单 #21），形状与校验完全一致 |
| `match.sheetRange` | 限定读取范围（如 `A1:M500`）；读值接口无分页、单次上限 10 MB，大表靠这个收窄 |
| `match.tableKind` | **逃生阀**：`bitable` / `sheet`。默认空 = 插件自己探测表型；显式写就跳过探测 |
| `match.statusValues` | 收票状态值集合（**可配**：真实表用「否」，缺省「处理中」） |
| `match.recordIds` | 只处理指定几张工单（收窄开关，**四个源（飞书 / 金山 / mock / webform）都接了**；名单外的行整行跳过，不收票也不进水位） |
| `match.allowedImageHosts` | URL 形态截图的允许主机名（缺省为空 = 一律拒绝，见 9.1 第 6 条） |
| `match.sheetUrl` / `sheetName`（与飞书电子表格共用）/ `statusColumn` / `statusValue` / `mediaPrefix` | 金山表定位 |
| `repo.path` | **本地仓库路径**（需求②）；**同时就是这个项目的工作区目录** —— 插件的 `core/workspace.js` 会确保它在宿主 `workspaceRegistry` 里有登记（已登记则复用，没有则补一条）。目录必须真实存在，插件不会替你克隆 |
| `repo.remote` / `baseBranch` / `targetBranch` | 基准分支与目标分支 |
| `verify.build` / `verify.test` | 验证命令（从配置注入，执行器里不硬编码任何命令） |

### 4.2 运行时事实（未暴露为配置项）

| 事实 | 位置 |
| --- | --- |
| 通知超时 20 秒 | `core/scheduler.js` `notifyTimeoutMs`，硬编码 |
| 并发上限恒为 1 | 一轮最多跑一票 |
| 验证命令超时 30 分钟、超时退出码 124 | `src/index.js` `VERIFY_TIMEOUT_MS` / `VERIFY_TIMEOUT_EXIT_CODE`；宿主 `dsh-bash-local` 的 `maxTimeoutMs` 缺省 10 分钟会夹下去 |
| 退避基数 30 秒、上限 30 分钟、抖动 0.2 | `core/scheduler.js` `backoffDelayMs` |
| 租约心跳默认 60 秒 | `leaseHeartbeatSeconds` |
---

## 5. 数据流转（从表格到通知）

```
工单表 ──scan()──▶ Ticket[] ──指纹比对──▶ created/updated/disappeared
                      │
                      ├─▶ store.enqueue ──▶ 票（pending）
                      │                      │
                      │                      ├─ acquireLease（租约 + 心跳续期）
                      │                      ├─ locator.locate(projectId) → 仓库/分支
                      │                      ├─ prepareWorkspace（确保项目工作区）
                      │                      │     ├─ 缺省：inspectCheckout + describeDirtyCheckout（脏只提醒、照跑）
                      │                      │     └─ isolateWorktree: true：git fetch + worktree add
                      │                      ├─ 取截图字节 → saveImage → ImageBlock
                      │                      ├─ executor.run(ticket, target, ctx)
                      │                      │     ├─ agent：拍基线(createBaseline) + 受保护路径快照(snapshotProtectedPaths) → 改码
                      │                      │     │        → collectChanges(对基线) → verify（30 分钟超时 / 可取消，超时退出码 124）
                      │                      │     │        → 篡改自检(compareProtectedSnapshots，动过 .git/profile 就 failed)
                      │                      │     │        → commitLocally（点名暂存的本地提交）→ 返回 commit + sessionId
                      │                      │     │        → keepSession 决定要不要回收会话
                      │                      │     └─ mock：只演（返回假 commit）
                      │                      ├─ setPhase(done/skipped/failed/gone) —— 同一次落库写 pendingEffects
                      │                      ├─ writeBackFor（仅 done/skipped 且 writeBack 没关）
                      │                      │     └─ source.writeResult → 回执落到票据 writeBack
                      │                      ├─ releaseLease
                      │                      └─ push.send（按 notifyOn 过滤；回填失败会多一行）
                      │
                      │   启动时：replayPendingEffects() 把残留终态票没做完的回填/通知补上
                      │
                      └─ disappeared → 连续 goneAfterScans 轮不见 → gone
```

### 5.1 工单四要素如何落到内核

| 要素 | 内核字段 | 飞书来源 | 金山来源 |
| --- | --- | --- | --- |
| 待修改项目 | `projectId` | **表里没有这一列** → 回落为源实例项目名 | 列别名 `待修改项目/所属项目/项目/系统`（`xlsx.js:34`），但**值被丢弃**（见 9.1 第 5 条） |
| 问题描述 | `description` | `问题描述` 列 | `问题描述/问题/缺陷描述/Bug 描述` |
| 操作流程 | `flow` | `操作流程` 列 | `操作流程/复现步骤/操作步骤/复现流程` |
| 截图 | `screenshots[]` | `截图` 列（文本链接形态） | `截图/图片/问题截图/截图-录屏`（附件 + 链接两种） |
| 附加 | `module` / `priority` / `foundAt` / `department` / `seq` | 对应列 | 对应列别名 |

截图三种形态在内核统一：`kind=attachment`（fileToken）、`kind=path`（本机路径）、`kind=url`（外链）。取不到字节不判整票失败，而是转 `needs-info` 让人补图（`core/scheduler.js:487-540`）。

### 5.2 截图怎么真正进模型

`core/prompt.js:88` `renderTicketContent(ticket, located, images)` 把任务书与截图拼成 content 块数组：`{type:text}` + 若干 `{type:image}`。`core/scheduler.js:339-343` 同时传 `prompt`（纯文本，给只认 prompt 的老适配器）与 `content`（带图）。

**这一段曾经是断的**：修复前截图只落盘、从没作为图像块传给模型，等于「解析截图」只完成了取字节。现已接通并在 `dev-run.mjs` §11 有断言守着。

---

## 6. 错误与重试

### 6.1 错误分类（`src/contracts/errors.js`）

| kind | 可重试 | 语义 |
| --- | --- | --- |
| `auth` | ❌ 致命 | 凭据不对，重试只会继续错 |
| `not-found` | ❌ 致命 | 资源没了 |
| `invalid-input` | ❌ 致命 | 配置或参数写错 |
| `network` | ✅ | 临时网络问题 |
| `rate-limit` | ✅ | 被限流 / 配额耗尽 |
| `internal` | ✅ | 其它内部错误 |
| `aborted` | — | 取消 / 超时 |

### 6.2 调度器如何分档（`core/scheduler.js` `runOne` 的 catch 分支）

| 情形 | 结果 | 是否通知 |
| --- | --- | --- |
| 租约丢失（心跳续租失败） | 回 `pending`，让出这票 | **不通知**（不是人的问题） |
| 被取消 / 超时 | `failed` | 超时才通知 |
| 抛出的可重试错误且 `attempt < maxAttempts` | 回 `pending`，`enqueuedAt = now + 退避` | 不通知 |
| 抛出的不可重试错误 | `failed` | 通知 |
| 执行器**返回** failed 结果 | `failed`（**当前不重试**，见 9.2 第 7 条） | 通知 |

### 6.3 退避

`backoffDelayMs(attempt, retryAfterMs, random)`：基数 30 秒、上限 30 分钟、抖动 0.2。执行器若给出 `retryAfterMs`（如上游说「17:09:35 重置」），优先按它算。

### 6.4 限流识别（`executor-agent/agent-failure.js`，`1f788cb` 修）

从 `agent.session.log` 末条 `turn/end` 事件的 `data.reason.error` 里取 `code` / `message`，归一化后判是否限流（code 命中 `RATE_LIMIT` / `QUOTA` / `SOFT_RATE` 等，或文案命中「被限流 / rate limit / quota exceeded / 429」），命中即转 `PipelineError(rate-limit)` —— **可重试**。

修复前真实故障被误报成 `internal: agent 没有产生任何文件改动` 且标成不可重试，等于「上游配额没了」被当成「代码改不动」。

---

## 7. 安全与权限边界（现状）

| 边界 | 现状 |
| --- | --- |
| 密钥 | 飞书 / GitLab / QQ 授权码走 `ctx.get(credentials)` 现取（`src/index.js:386/408/622`），**不落明文配置**；但 `pushplus.token` 仍是明文配置项（见 9.2 第 13 条） |
| 工单正文不可信 | `core/prompts.js` `UNTRUSTED_TICKET_NOTICE` 拼在消息最前，要求模型把正文当数据、遇到指令就判 `needs-info`（`docs/adr/0003`） |
| git 写权限 | git / verify 走 `fullAccessSandboxPolicy`（`src/index.js:233-266`），理由见 `docs/adr/0004`：Windows ACL 缺 sessionId 时子进程只读，git 写 `.git/FETCH_HEAD` 会 Permission denied |
| 截图外链 | URL 形态截图默认**一律拒**（`source-feishu/index.js:302-308`）：截图地址是外部输入，不设白名单等于让填表的人替服务器发任意请求。`26f0391` 起可由 `match.allowedImageHosts` 显式放行（**只放行点名的主机名，缺省依旧全拒**） |
| 仓库定位 | `locator-table` 只做「工单 projectId → 配置里的项目条目」查表，**不做任何「模块名 → 代码路径」的推断**（那类知识装不进通用插件），代码定位交给 agent 现场读仓库 |
| 坏项目隔离 | `locator-table` 构造期只把坏条目记进 `brokenProjects`、不抛 —— 一个项目配错不会让整条流水线起不来 |
| 敏感文件 | `executor-agent` 有 `SENSITIVE_FILE_PATTERNS` 白名单过滤（**8 大类 41 条正则**，见 §1.14）：**点名暂存** `git add -- <非敏感文件>`，再 `git commit -m <说明> -- <非敏感文件列表>`，被拦文件**连 index 都进不去、留在工作区**，文件名写进提交说明的「未提交」一行。**不用 `git add -A`**：全量暂存会让 `A application.yml` 露在 index 里，手一抖就提交走了；git 白名单也只放行 `add -- <文件>`，`add -A` / `add .` 一律拒绝 |
| `.git` / profile 篡改自检 | 每票开始与提交前各拍一次 sha256 快照（28 个官方 hook 名 + 10 个 git 元数据文件 + 4 个 `cordis.*`），动过就 `git restore --staged --` 撤回、判 `failed` + `invalid-input`（不可重试）并点名文件。**这是「被发现」不是「被阻止」**：拿不到 `readFile` 服务时自检跳过、票照常交付 |
| 验证命令 | 有超时与取消：`VERIFY_TIMEOUT_MS` 缺省 30 分钟、宿主 `dsh-bash-local` 的 `maxTimeoutMs` 缺省 10 分钟会夹下去（真实上限取小者）、超时退出码 **124**、取消会真 kill 子进程 |
| approval / policy | 仍是 `never`（`executor-agent/index.js:1149` 注释）：宿主只提供 `ask` / `never`，没有「只读自动批、写入弹卡」这一档；`ask` 在无头场景 fail-closed 会让每步工具调用失败。兜底只有 git 白名单 + 篡改自检，**不是硬隔离** |
| 合并动作 | 插件**只在工作区检出里做一次本地提交，从不 push、从不合并**；远程 draft MR 是 `repo.gitlab.enabled: true` 才走的可选出口，合并同样由人手动做 |
---

## 8. 自测与验证

### 8.1 离线自测（可复跑，不联网）

| 命令 | 断言数 | 结果 |
| --- | --- | --- |
| `node scripts/dev-run.mjs` | **624** | 通过 624，失败 0（2026-11-17 实跑；262 → 274 → 285 → 288 → 293 → 294 → 319 → 325 → 363 → 376 → 378 → 382 → 383 → 384 → **451**（2026-11-09→ **482**（2026-11-10）。451 之前那批：319 是「回填工单表 / 保留会话 / 基线收集 / 配置面板」四项改造，再往后 6 条是「选择分支」，再往后 38 条是「上线加固」的 5 条阻断项 + 4 条重要项（见 §1.14），再往后 13 条是「关键节点流程日志（时间线）」（见 §1.16），再往后 2 条是「appToken 贴整条链接」的配置校验，再往后 4 条是「从 0 到 1」审计（见 §1.19），再往后 1 条是「工作区就绪 / 检查工作区两站不许说同一句话」，再往后 1 条是「票据行里的数字键脏字段会被剔掉」（见 §1.20），再往后 20 条是「飞书电子表格支持」（见 §1.21）。**2026-11-10 = 22 张产品工单的落地批次**：451 之后依次涨到 462（doctor 三档 + GitLab/WPS 降级）、463、469（多维表格列名别名）、475（运行页签）、482（电子表格回填）、483（探针归一 spreadsheetToken），**486**（总览流程带 3 条，见 §1.25），**491**（定位工单表只留一个入口 + 电子表格取票修复 5 条，见 §1.26），**492**（运行页签「显示历史」1 条，见 §1.27），**495**（体检补状态值口径 2 条 + 探针表型探测，见 §1.28），**498**（定位捷径不能跳过表型判定 1 条 + `tableId`/`sheetId` 并存警告 1 条，见 §1.30），**508**（探索预算 1 条 + 停滞看门狗 4 条 + 飞书推送适配器 5 条，见 §1.32 与 §1.33），**509**（预算不能交半成品 1 条，见 §1.34），**511**（体检白名单跟上 feishu 2 条，见 §1.35），**512**（「交付未完成」不都是已完成的 1 条，见 §1.36），**514**（停滞看门狗的 2 条，见 §1.37），**517**（运行页签三件事：删除记录 / 重跑实参 / canReset+canForget 3 条，见 §1.38），**521**（探索预算强制执行 4 条，见 §1.39），**530**（跨票记忆 9 条，见 §1.39），**544**（项目级开关 4 条 + 补做挂进 tick 3 条），**548**（「测这张表」4 条），**551**（体检把「表里没有待办」误报成配置错 3 条，见 §1.41），**557**（工作表名对不上：适配器降级 2 条 + 体检 2 条 + 探针 2 条 + `testProject` 1 条，见 §1.42），**562**（会话标题 5 条，见 §1.44）、**569**（会话标题改成「修复…」开头 + 缺 workspaceId 的票补登记 + `git add` 撞上已跟踪的被忽略文件 7 条，见 §1.45）、**575**（同一张票重跑接着上一轮的会话继续 6 条，见 §1.46；跨票记忆抽词口径订正，见 §1.47）、**576**（回填单元格只留「人下一步要用的」1 条，见 §1.48）、**577**（2026-11-16 纠正金山源「取数通道未接」这个错误说法：体检改成按「有没有配表格链接」分档，1 条；同日补 `checkEventArgConfusion` 静态守卫与 2 个调用点包一层，不新增 `dev-run` 断言，只加 `client-check` / `client-smoke`，见 §1.49）、**580**（探索预算口径改成「不同目标数」+ 阈值 12→25 + 项目级覆盖 3 条，见 §1.50）、**581**（不许反复催：可重置计数器挡不住重复，1 条，见 §1.51）、**583**（两套看门狗合流成一条消息 2 条，见 §1.52）、**584**（会话 id 拿到就落库 1 条，见 §1.53）、**596**（站带改中文短名 + 失败落到倒下的站 + 错误人话化 12 条，见 §1.54）、**605**（检出级互斥 + 同项目票史 + 归属修正 9 条，见 §1.55）、**623**（失败落站 + 从失败那站续跑 18 条，见 §1.56）、**624**（`from` 点名一站要真按它跑 1 条，见 §1.56）—— 见 §1.40。这 624 条**也包括** `runFeishuChecks` 从 `dev-run` 里驱动的那 99 条（见 §1.26 与 §1.23 注） |
| `node scripts/chain-smoke.mjs` | **11** | 通过 11，失败 0 |
| `node scripts/client-smoke.mjs` | **280** | 通过 280（215 → 219：§1.29；→ 240 左右：运行页签筛选/搜索与后果提示；→ 260：飞书通知分支 6 条 + 「测这张表」4 条 + 描述符 11 个；→ 276：面板四处保存/实参 bug 的回归，见 §1.41 之后那四个 commit；→ 280：「重新读取」带事件对象不报错的运行时断言 4 条，见 §1.49） |

`dev-run.mjs` 分 35 个小节：

| # | 小节 | 覆盖 |
| --- | --- | --- |
| 1 | 契约层 | 错误分类、阶段机、指纹 |
| 2 | 队列与租约 | 入队、租约、续租、让出 |
| 2b | 多项目主键隔离 | 不同 projectId 不串票 |
| 3 | 整轮 tick（mock 全链路） | 扫描→执行→通知 |
| 4 | 各种失败与收尾 | 扫描失败暴露、通知失败不改票态、分支名清洗 |
| 5 | 修订、退役与人工重置 | 指纹变更、gone、`resetByHuman` |
| 6 | 启动恢复 | `recoverPending` 断点续跑 |
| 7 | 通用仓库定位器 | `projects[]` 查表、坏条目隔离 |
| 8 | 工作区清理 | 过期 worktree 回收（只有开了 `isolateWorktree` 才有 worktree 可清）、`isIsolatedWorktreePath` 前缀校验 |
| 9 | 飞书适配器（离线打桩） | **58 项**：状态值、recordIds、指纹、早停退役、**`writeResult` 回填三列**（+6 条） |
| 10 | P0 修复 | 租约心跳、注入时钟、送达回执配置、人工取消 |
| 11 | §5.1 A 组链路断点 | 截图进 prompt、真实工作区、失败原因、人工重开；**陈旧工作区坐标不复用**（目录已删要重建且不把死坐标传下去 / 换了仓库要重建 / 探测抛错时不重建） |
| 11.6 | `onPhase` 的第二参 | 字符串是「说明」，不能被当字段补丁写进票据 |
| 11.5 | `pipeline_doctor` | 环境体检；**插件版本自检**：落后时给出同步命令与两个指纹，一致/链接安装/比不出来三态各有断言，既有 7 个用例注入 `NO_VERSION_CHECK` 桩避免读真实磁盘；**三档结论 `blockers/problems/warnings`**、「通知通道完整性」、「飞书连通性」（真探针 + 假 fetch，码表命中 / 未知码 / 网络错 / 超时四种归一）、「接下来四步」清单、`GITLAB_TOKEN` 只在真开了远程 MR 时才查（见 #10、#19） |
| 12 | 组合根接线 | 工具真注册进 ctx、真拿到 store |
| 12b | 注册表真的接上了适配器 | qqmail 推送、agent 执行器 |
| 12c | 走宿主 shell 必须显式带 sandboxPolicy | 写授权 |
| 12d | 工具输出必须是 lossless JSON | `undefined` 会让宿主判整次调用失败 |
| 12e | 平台可插拔 | 状态值可配 + 金山文档接进组合根；`PLATFORMS` 只剩 `feishu/wps/mock`，`webform` 拿到迁移提示（见 #18） |
| 13 | 新适配器 | gitlab 客户端 **86 项**（新增 7 条本地提交断言 + 10 条 `-z` 收集/暂存断言 + 10 条基线/keepSession 断言 + **8 条敏感名单与篡改自检断言**，原 51）/ qqmail 推送 18 项 / wps 工单源 **34 项** |
| 14 | 项目工作区 | **19 项**：目录不存在给可照做的报错、无 `repo.path`、未登记则登记、已登记则复用、create 幂等、无 registry 降级、create 抛错降级、无 fs 服务、fs 说是文件、同项目多票复用、attachSession 归属；**验证命令的 signal 语义与超时 124**、**适配器名写错要抛并列出可选值** |
| 15 | 改代码落点 | `inspectCheckout` 干净/脏/拿不到状态三种情况（`-z -uall` + 排除插件自有目录）；`describeDirtyCheckout` 脏工作区只提醒不拒跑、文案能照着理解；`isIsolatedWorktreePath` 只认 `.agents/worktrees/<name>`；真实 `apply()` 缺省不建隔离 worktree、票据落在工作区根上（`branch` = 检出当前分支、`baseCommit` = 检出 HEAD） |
| 16 | 处理完回填工单表 + 保留工作区会话 | done → 三列都写；`writeBackStatus` 可配、空白回落「是」；`writeBack=false` 完全不写（退化成只读）；failed 不回填；回填失败只记票据、票态不回退、不影响通知；老适配器没有 `writeResult` 时静默跳过；执行器返回 `sessionId` 落到票据、状态里能看到去哪找会话；`pipeline_status` 成功/失败都能一眼看到；skipped 的回填首句要说「待人工验证」 |
| 16a | 改动摘要 | `pipeline_status` 每票多渲「改动摘要：N 个文件，+X / −Y」；`commitSummary` 无提交时是 `null` 不是 `undefined`；一次 `git show --raw --numstat -z` 拿全（两种 `-z` 互斥） |
| 16b | 事后动作补偿（`pendingEffects`）与租约诚实化 | **14 项**：回填失败要在通知里说、回填成功时不写回填行、一场跑完 `pendingEffects` 必须清干净、`clearPendingEffect` 只清报上来的那一项（两项清完就把字段整个删掉）、启动补偿：残留终态票把回填和通知补做完并清标记、`enqueue` / `resetByHuman` / `revise` 都不继承上一轮 `pendingEffects`、租约：别的 owner 连试两次都拿不到且续租按 token 判定、就地重跑起点与票面记录不一致时日志要说明「被判没有改动是预期」、`failed` 也是终态（通知发完同样清 `pendingEffects`）、启动补偿只捞终态票、`pipeline_status` 待补动作要能看见 |
| 16c | 交付维度 | done ≠ 东西交到手上：`delivery` 三项（commit / writeBack / notify）各自记账；回填失败/不可重试分别落 `giveUp`；票标题加「（表格未回写）」「（交付未完成：…）」；全库分布多一行「交付未完成：N 张」；返回体带 `delivery` / `deliveryIssues`（见 #08） |
| 16c-2 | 失败票回填 | `writeBackOnFailure` 缺省关；打开后只写「处理结果」一列、绝不碰「是否处理」/「处理日期」；**超时也写、人工取消不写**；失败票被重跑后再失败是覆盖同一格不追加（见 #14） |
| 16c | 关键节点流程日志（时间线） | **13 项**：主站顺序（①–⑨ + 补充站）、每条 `at` 是时间 / `ok` 是布尔 / `label` 非空、相邻 `at` 单调不减、执行器 `onFlow` 报的 ④ 会话进时间线、失败票 `failed` 站记 ✗、连续同节点同成败合并、90 条触发 80 条封顶、重新入队继承时间线、人工重置不清空只补「排队中」分隔、`pipeline_status` 渲染「现在停在第 ⑤ 站…已 1 分 35 秒没动」、终态写「已经收尾」/ needs-info 写「不是插件卡死」、返回体带 `timeline`/`station`/`stalledForMs`、老票无时间线不引入 `undefined` |
| 16d | 长站点心跳 | `planning` / `editing` / `testing` 每分钟追加一条 `heartbeat` 时间线条目（同类才合并，别吃掉进站那条）；只渲「最近一次心跳 HH:MM:SS」，不单独占行；`testing` 额外给「通常 3–15 分钟」的区间（见 #07） |
| 17 | 选择分支 | `parseBranchRefs` 解析 `for-each-ref`（`refs/remotes/` 后只切第一个 `/`、丢掉 `origin/HEAD` 这类符号引用）；`mergeBranchChoices` 排序（当前分支 → 远端默认 → 本地 → 其余远端）；`listBranches` 真跑通；四种拿不到分支的情况（无 `repo.path` / 无 git 执行链路 / 不是 git 检出 / git 抛错）**只返回 `ok:false` + 原因、绝不抛**；游离 HEAD 不算分支名；宿主 remote 暴露 `branches()` 且某个项目配错不影响别的项目 |
| 18 | 运行页签的四个 Remote 方法 | `status` 与工具同源（`collectStatus`）、无 store 给人话、`status(includeDone)` 只在严格传 `true` 时才把终态票拉进来（不传 / `false` / `'true'` 三种都只回未收尾的）、`scan` 关着时 `disabled` 且不起后台、`cancel` 没票在跑说清楚、`reset` 把失败票放回 pending、不给非终态票重开（见 #16、§1.27） |
| 19 | 跨票记忆 | **9 条**：`extractKeywords` 抽 module/flow/英文标识符/中文 2–4 字滑窗（**标识符走 120 字上限**，否则 `PmsProductSampleTestServiceImpl` 会被截成命不中的半截）；`recallMemories` 三重排序（命中词数 → `hits` → `at`）；`describeMemory` 三点措辞；`remember` 同批去重 / 累加 `hits` / 关键词并集 / 新排最前 / 空 files 不写库；`touch` 与 `recall` 分离（重渲任务书不许刷权重）；`limit: 3` 截断；**端到端两票**（第二票任务书里看得到，且 `hits` 只为已被用上的 +1）；失败票不动记忆；记忆坏了不影响交付（见 §1.39） |
| 20 | 会话标题 | **5 条**：`buildSessionTitle` 拼 **`修复<问题描述>（项目 #序号）`**（**以「修复」开头**，项目与序号降级成尾巴坐标；无描述退 `recordId`、全空退兜底，绝不出空串）；按 UTF-8 字节截断（逐码点累加、预算减省略号 3 字节、不含 `\uFFFD`，截断不许切掉「修复」）；`setupAgent` 写出 `session/title` 且`source.kind === 'user'`（钉住，不被后续自动生成覆盖）与空 `messageSeqs`；标题写失败只记日志、不连累沙箱/审批两条策略事件（见 §1.44、§1.45、架构 §12.22） |

### 8.2 真实链路验证记录

| 验证项 | 结果 |
| --- | --- |
| 本地提交（本阶段交付形态） | ✅ `git add -- <非敏感文件>`（点名暂存）→ `git commit -m <说明> -- <非敏感文件>` → `rev-parse HEAD` 全链路实跑，提交说明含工单溯源、验证结论与「未提交」文件清单 |
| 脏工作区只提交 agent 改的 | ✅ 真 git 端到端验过：有基线时人的改动一个都不出现；用户 `git add` 进索引的改动同样被排除 |
| 回填工单表（新） | ⚠️ 代码与自测全绿（`dev-run.mjs` 第 16 节 10 条断言）；真实表待应用拿到**编辑**权限后端到端复跑 |
| 保留会话（新） | ✅ `pipeline_status` 与回填进表格「处理结果」列的正文都能看到 `处理会话：<sessionId>`（**通知正文里没有这一行**）；agent 实例在 `finally` 里无条件释放 |
| 设置面板（新） | ✅ `client-check.mjs`：descriptor 27 叶子 / 4 组、schema 信封 76 节点 27 叶子、**Remote 11 个方法**（含带参 `setProjectTable`、`status`、`scan`、`reset`、`forget` 与 `testProject`）、`projects` 可写 35 字段、面板项目字段 31 项；另有两道静态守卫：`checkCallArities` 比对每个 `ns.<method>(…)` 的实参个数（10 处全对）、`checkEventArgConfusion` 拦「把声明了形参的函数裸传给 DOM 事件属性」（4 处透传、裸函数名 0 处，见 §1.49）；`client-smoke.mjs` 280 条全过（页签式布局见 §1.17，「添加项目」见 §1.18，运行页签见 §1.22，「显示历史」见 §1.27，删除记录 / 分组 / 流程带见 §1.38） |
| 上线加固（新，2026-11-06） | ✅ 代码与自测全绿：`dev-run` 累计 **376/376**（该轮 363/363，第 16b 节 14 条；补 appToken 链接解析 2 条后现为 482/482）、`gitlab-checks` 86、`wps-checks` 34、`workspace-checks` 19；敏感名单 41 条实测 BLOCK/PASS 清单符合预期（`src/env.js` / `docs/credentials.md` / `.environment.md` 不误伤） |
| 关键节点流程日志（新，2026-11-06） | ✅ 票据 `timeline` 逐站打点（17 节点表 / 9 主站 ①–⑨）、`pipeline_status` 排成时间线并写「现在停在第 N 站，已 X 分 Y 秒没动」、`dev-run` 第 **16c** 节 13 条断言全绿、返回体带 `timeline`/`station`/`stalledForMs`/`lastNodeOk` |
| appToken 贴整条表格链接（新，2026-11-09） | ✅ `parseBitableUrl`（`src/contracts/types.js`）被配置校验与飞书适配器共用：`?table=` → `table_id`、`?view=` → `view_id`，显式 `tableId` 仍优先；`feishu-checks` 58 → **60** 条、`dev-run` 加 2 条配置校验断言（那是当轮的值；现为 **482/482** 与 **93** 条） |
| 面板「添加项目」修好（新，2026-11-09） | ✅ 加项目改成「垫空卡片 + 一次保存提交」：不再拿空 `repo.path` 撞宿主整份校验（见 §1.18）；顺手修「出错吃掉整个清单」与「有未保存改动就锁死加项目」；`repo.remote` 面板标签改「GitLab 仓库地址」；`client-smoke` 113 → **123** 条断言全过 |
| 真实 GitLab draft MR 创建（可选出口） | ✅ MR !1（sandbox project 33）；现在只有 `repo.gitlab.enabled: true` 才走这条 |
| GitLab 凭据权限 | Owner 级（`/repository/branches`、`/merge_requests` 均 200） |
| QQ 邮箱真实发信 | ✅ `accepted=true`，traceId `<mw319ltk.47861f8c479221d3@qq.com>` |
| PushPlus 适配器 | 已实现，发信通道依赖对方 token |
| 真实飞书表读取 | ✅ appToken `RZZQbY4SkaY6z0shZaBcVpQCnhh` / table `tblWhRSGf0osJqrE`，79 条 |
| 真实飞书工单入队 | ✅ `pms\|reczz28VWNWVefNA`（当时用 `statusValues` + `recordIds` 精确收窄，只收进这一张；宿主 profile 现已去掉 `recordIds` 试点限制，改按状态值整表收） |
| 真实飞书工单改码 | ⚠️ 入队与四要素解析全对；agent 一轮被上游 429 配额挡死（非插件缺陷），宿主侧「`{{model}}` 崩」与「preset 缺服务」两个雷已在 `5b94a17` 排掉，尚未在配额恢复后复跑 |
| 飞书写回状态列 | ⚠️ app 对该表之前只有读权限，写回返 `code 91403 Forbidden`；现在「回填」已是主路径（`writeResult`），需要把应用加成**可编辑**协作者后再验一次；没权限时票仍是 `done`，只在 `pipeline_status` 显示「回填表格：没写成 —— …」 |
| 金山文档真实取数 | ❌ 无开放平台对接（见 9.1 第 3 条） |

### 8.3 环境事实（影响可复现性）

| 事实 | 值 |
| --- | --- |
| 宿主 shell | **Windows PowerShell 5.1**（不支持 `&&`、忽略 `cwd` 字段）→ 一律用 `git -C <path>` |
| DSH 沙箱写权限 | 子进程只能写会话工作区 → 目标仓库必须克隆到 `.repos/` 下 |
| 目标仓库 | `.repos/mgiot-pms`（GitLab project 28，`v2.x`）、`.repos/tp-sandbox`（project 33，main） |
| 宿主 profile 现状（2026-11-06） | pms 项目 `repo.path` = `D:/WorkSpace/mgiot-pms`（直接指向项目工作区）、`match.statusValues` = `["处理中"]`、`fetchBeforeCreate: false`；**已去掉 `recordIds` 试点收窄**（整张表按状态值收） |
| 插件依赖 | **零 npm 依赖**；一切宿主能力从 `options` 注入（插件目录解析不到 `@deepseek-ai/*`） |
| 插件改动生效 | 跑 `node scripts/sync-install.mjs`（自动找 `~/.dsh/profiles/*/node_modules/@local/ticket-pipeline`，可用 `--dry-run` 先看、`--dir` 指定）再**完全重启宿主**；手抄路径不再需要。为什么要这一步见 `architecture.md` §12.11 |
| 权威票态 | `C:/Users/Administrator/.dsh/storages/ticket_pipeline.json` 的 `tables.tickets`（object，键 = projectId + `\u0000` + recordId） |

---

## 9. 未完成与缺陷清单

下面每一条都定位到了具体文件位置。**「已修（`<commit>` 前）」= 代码已提交（这一列在 2026-11-06 复核时补）；「已缓解」= 症状减轻但仍非根治；「待修」= 还没人动手。** 所有结论均对照 2026-11-06 工作区源码（HEAD `dbfa21f`）核实。

> 本轮（2026-11-06「本地提交」改造）当场关掉一条契约耦合：**~~「GitLab Commits API 是改动唯一出口」~~**。原来 `makeExecResult` 在 `phase=done/skipped` 时必须给 `mr`，等于把「有远端的 GitLab」写进了内核契约；现在 `commit` 或 `mr` 给一个即可，默认交付形态改成工作区检出里的本地提交（`commitLocally`），远程 Commits API 降级为 `repo.gitlab.enabled: true` 才走的可选出口。证据：`src/contracts/work-executor.js`（校验分支）、`src/adapters/executor-agent/index.js`（`commitLocally` / `openDraftMr` 的 `optional` 出口）、`scripts/gitlab-checks.mjs` 新增 7 条断言。

### 9.1 P0 —— 挡住真实工单端到端

| # | 缺陷 | 位置 | 影响 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | **模型默认留空 → 宿主 persona 模板崩**：`agentOptionsFromConfig` 在 `model` 为空串时不带 model，宿主给 agent 会话装 personaPrefix 时含 `{{model}}` 变量 → 装配阶段直接报 `prompt variable "{{model}}" has no value for this assembly` | `src/adapters/executor-agent/index.js`（新增 `resolveAgentOptions`） | 沙盒 002/003 两张票就是这么挂的（attempt=2） | **已修（`5b94a17`）**：新增 `resolveAgentOptions`，配置优先、缺的读宿主 `agentDefaultModel.currentSelection()` 补齐，两项必须成对下发；宿主也给不出就报 `internal` 并说清该配什么。（早期那条「空串不下传即跟随会话默认」的判断是错的 —— 空串就是真的不下发，才会在模板上崩） |
| 2 | **找不到 agentPresets 服务只记日志继续跑**：agent 起来了但是零工具，改不出任何文件，最后报「没有产生任何文件改动」，真因被埋 | `src/adapters/executor-agent/index.js`（`setupAgent`） | headless profile 必现；桌面 profile 也可能缺 | **已修（`5b94a17`）**：改为抛 `invalid-input` 硬失败并列出该配什么（重试没用，是环境问题） |
| 3 | **金山文档无开放平台取数通道**：`wpsOptionsFromMatch` 只支持 `sheetUrl` 全局 fetch 下载，缺登录态大概率失败；无开放平台网关接入 | `src/adapters/source-wps/index.js:371-399` | 需求①的「金山」只有解析能力，没有取数能力 | **已降级为 experimental（工单 #20，2026-11-10）**：不再声称「已支持」——面板下拉标「实验性」，`MISSING_FETCH_SHEET` 改成「用户层先说拿不到票 + 改用飞书，开发者层再给 `fetchSheet()`」。**2026-11-16 纠正**：此前文档写「主装配不注入 `fetchSheet` ⇒ 所有 wps 项目一张票都拿不到」，这是**错的** —— 配了 `match.sheetUrl` 就装内置下载器。`pipeline_doctor` 据此不再对 wps 一律报阻断，改成「没配链接 → 阻断 / 配了链接 → 提醒（可能因登录态下不下来）」。真接开放平台网关仍需金山账号 + 管理员审批 |
| 4 | **`repo.gitlab` 配置被校验层吞掉**：`validateProject` 只复制 `repo.remote/baseBranch/targetBranch`，而 `resolveGitlab` 优先读 `repo.gitlab.baseUrl/projectId` | `src/core/config.js`（`validateProject`） | 自建 GitLab / 子组路径配了也不生效 | **已修（`5b94a17`）**：透传 `baseUrl` / `remote` / `projectId` |
| 5 | ~~**金山表「待修改项目」列的值被丢弃**~~：`toTickets` 用的 `projectId` 是源实例项目名，`makeTicket` 不接收该列的值，表格里那列只留在 `raw.cells` | `src/adapters/source-wps/index.js`（`toTickets` → `targetProject`）、`src/contracts/ticket-source.js` | 需求③「待修改项目」在金山侧拿不到 | **已修（`26f0391`）**：新增 `Ticket.targetProject`，金山该列原值进 `targetProject` 并渲染进任务书；**刻意不顶 `projectId`**（存储主键一半，且该列是人手填的自由文本），任务书里也明确写「不要拿它当目录名直接去改」 |
| 6 | ~~**飞书 / 金山截图白名单没有配置键**~~：适配器读 `options.allowedImageHosts`（`source-feishu/index.js:306`），但 `CONFIG_FIELDS` 无此键、`feishuOptionsFromMatch` 都不透传 | `src/core/config.js`（`validateProject` / `describeConfig`）、`src/adapters/source-feishu/index.js`（`feishuOptionsFromMatch`） | 真实表的截图是文本链接形态 → 取不到图 → 整票转 needs-info（缺省一律拒，且无法从配置放开） | **已修（`26f0391`）**：新增 `match.allowedImageHosts`，校验层归一化（trim + 小写 + 去重、空集合报错）并透传到适配器；**不给缺省值** —— 安全闸门只有人能打开 |

### 9.2 P1 —— 影响正确性与可运维性

| # | 缺陷 | 位置 | 影响 | 状态 |
| --- | --- | --- | --- | --- |
| 7 | **执行器返回 failed 结果时不重试**：调度器只对「抛出的错误」分档重试；执行器返回 `{error:{retryable:true}}` 也直接判 failed | `core/scheduler.js` `runOne`（只看 `normalized.retryable`，而执行器返回结果走成功路径不进 catch） | 可重试的失败被当成终态 | **待修**（但 executor-agent 已改为「限流等真失败一律抛出」绕开这条路，见 9.3 第 26 条） |
| 8 | **没配验证命令却报 done**：「未经验证」和「验证通过」在票面上看不出区别 | `src/adapters/executor-agent/index.js`（`run()` 末尾 `plan.summary`） | 人容易把「完成」误读成「测试过了」 | **已缓解（`5b94a17`）**：`phase` 语义按契约保持不变（`skipped` 是合法成功路径），改为把验证结论写在 `plan.summary` 最前面——通过写「验证通过：…」，没跑/失败写「⚠ 未通过验证（skipped）：…」。彻底区分需要新增 phase，属于契约变更，本轮不做 |
| 9 | **敏感文件只拦不报**：检出敏感文件改动后票仍按成功交付，且只写一行日志 | `src/adapters/executor-agent/index.js`（`run()` 末尾 `plan.summary`、`buildLocalCommitMessage`） | 人最后只会在交付物里发现「少改了一个文件」 | **已修（`5b94a17`）**：被拦文件数与文件名写进 `plan.summary`；**本轮又加一道**：提交说明末尾固定写一行 `未提交（疑似含真实凭据，按约定留在工作区）：<文件名>`，`git show` 就能看到 |
| 10 | **verify 命令只按空白切**：不识别引号 | `src/adapters/executor-agent/index.js`（`splitCommand`） | Windows 下 `node "C:\Program Files\x\check.mjs"` 起不来 | **已修（`5b94a17`）**：认单双引号；引号内反斜杠一律当字面量（否则路径被吃成 `C:Program Filesx`）；未闭合引号报 `invalid-input` 并降级 `skipped` 而不是 `failed`。仍然**不解释** `&&` / 管道 / 重定向（配置项不该成为 shell 注入面） |
| 11 | ~~**recordIds 收窄只有飞书接了**~~：`createRecordFilter` 只被 `source-feishu` 使用 | `src/contracts/record-filter.js` 及四个源的 `scan` 循环 | 金山 / mock / webform 源无法收窄 | **已修（`26f0391`）**：`createRecordFilter` 推广到金山 / mock / webform，名单外行在 `live.add` 之前跳过（不收票、不进水位、不参与退役计数）；`wpsOptionsFromMatch` 也翻译 `recordIds` |
| 12 | **金山 recordId 用行号**：表格插一行会让同一张票换身份 | `src/adapters/source-wps/xlsx.js:611-613` | 插行后旧票变新票 + 旧票退役 | **待修** |
| 13 | **`pushplus.token` 走明文配置**，与 config 层描述「建议走 ctx.credentials」矛盾 | `src/adapters/push-pushplus/index.js:163-171` | 令牌落在 cordis.patch.yml | 待修 |
| 14 | **死配置**：`logLevel` 与 `concurrency` 只出现在配置定义里，代码无任何消费点 | `src/core/config.js:126`（`concurrency` 定义）/`:317`（`logLevel` 定义）/`:342`、`:407`（分组标签） | 改它们不生效 | 待修 |
| 15 | **`PipelineError.retryAfterMs` 有写入但无读取方**（退避从未按上游建议时间算） | `src/contracts/errors.js:43-47` | 上游说「17:09 重置」，实际只按 30 秒基数退避 | **已修（`dbfa21f` 前）**：`src/core/scheduler.js:53` `backoffDelayMs(attempt, retryAfterMs, random)` 收了服务端建议值（`:54` `const serverHint = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : undefined`），`:571-573` 传 `normalized.retryAfterMs` 进退避并仍受封顶夹住 |
| 16 | **飞书工单源只支持多维表格，电子表格进不来** —— ① `normalizeAppToken` 的 wiki 节点查询把 `obj_type: 'bitable'` 硬写进 query（`src/adapters/source-feishu/index.js:763-766`），`:770-775` 把 `sheet` 判成「不是多维表格」并抛错，错误文案里还写着「sheet=电子表格」不支持；② `searchBitableDocs` 只认 `type === 'bitable'`（`:713`）；③ 配置校验只认「`appToken`+`tableId`」或「`docNamePattern`」二选一（`src/core/config.js:494-501`），只给 `spreadsheetToken` 的配置在启动时就被拒 | `src/adapters/source-feishu/index.js`（`normalizeAppToken` / `searchBitableDocs` / `resolveTable`）、`src/core/config.js`（`validateProject`） | 用户的飞书工单表如果是电子表格，插件**完全扫不出票**，且报错文案指向错误方向（像权限问题，实际是代码路径问题） | **已修（2026-11-09）**：新增 `src/adapters/source-feishu/sheets.js`（579 行），`get_node` 不再带 `obj_type`、改读 `node.obj_type` 分派；`searchBitableDocs` → `searchCloudDocs` 认 `type ∈ {bitable, sheet}`；`resolveTable` 成为表型分派总闸（显式 `tableKind` → `spreadsheetToken` → `appToken` 双试 → `docNamePattern`）；`scan` 拆 `scanBitable` / `scanSheet`；`validateProject` 改成四选一放行。自测 `dev-run` 384 → **451**、`feishu-checks` 60 → **80**（19 条电子表格断言）。**回填也已补上（2026-11-10，工单 #22，见 §1.23）**：`values_batch_update` 写三格、按序号列重新定位行、四类失败各有 `errorKind`+`note`；`dev-run` 475 → **482**、`feishu-checks` 86 → **93**（86 是 #21 列名别名之后的值）。**仍待**：真表验证（要开 `sheets:spreadsheet` **读写** scope + 文档级「添加文档应用」加成可编辑） |

### 9.3 P2 —— 健壮性与体验

> 这张表原来没有「状态」列，读的人无从判断哪些已经修掉了。下面按 2026-11-06（`dbfa21f`）的工作树逐条核过：
> **17–23 已修**、**21/22 各有半条仍成立**、24–26 仍然成立，详见每行状态。
> 复核方式：每条都去 `src/` 里找消费点/守卫，找不到才算「仍成立」；已修条目的证据行号逐条列在状态列里。

| # | 缺陷 | 位置 | 状态 |
| --- | --- | --- | --- |
| 17 | 飞书 token 无 single-flight；401/403 不清缓存 → 密钥轮换后最长 2 小时全失败 | `src/adapters/source-feishu/index.js` | **已修（`dbfa21f` 前）**：`:396-403` `let tokenInflight = null`（注释「single-flight，B4」）复用同一个在途 Promise，`:462` `finally(() => { tokenInflight = null })`，`:473-476` `invalidateToken(deadToken)` 按失效 token 精确清 cache 与 inflight；`:512` / `:560` / `:626` 是 401/403 分支 |
| 18 | 飞书四处请求未传 `signal`；fetch 无请求级超时；URL 截图裸 fetch 有 SSRF 面 | `src/adapters/source-feishu/index.js` | **已修（`dbfa21f` 前）**：全仓 `fetch(` 只有 `:547` / `:614` / `:1226` 三个调用点，全部带 signal；`:552` `signal: withTimeout(init.signal, requestTimeoutMs)`、`:617` 同、`:1230` `withTimeout(signal, remaining)`（`fetchImageUrl` 手动跟跳），`:620-621` 超时抛 `PipelineError('network', …超时（${requestTimeoutMs}ms）')` |
| 19 | 附件无字节上限 | `src/adapters/source-feishu/index.js` | **已修（`dbfa21f` 前）**：`:335` `const maxBytes = Math.max(1024, Number(options.maxBytes ?? 10 * 1024 * 1024) \|\| 10 * 1024 * 1024)`，`:644` 传入，`:1257-1258` `readBodyWithLimit` 边读边累加上限 |
| 20 | `pickNext` 不排除中间相位（planning / testing 等） | `src/core/store.js:441` | **已修（`dbfa21f` 前）**：`if (row.phase !== 'pending') return false`（注释「只跑排队中的票；中间态留给启动恢复」） |
| 21 | 飞书早停时把「未访问」当「不存在」计退役；指纹先更新后判定 → 改内容再改回旧内容永不触发 updated | `src/adapters/source-feishu/index.js` | **前半已修、后半已修**：`:1076-1099` 的退役判定整体包在 `if (!stopped)` 里（注释写明「早停时未访问 ≠ 不存在」，代价是停点之后的真删除会一直挂在水位里）；指纹只在收进 `updated` 时才更新（`:1033-1035` 注释 + `:1059-1062`）。**残留**：早停导致停点后的行整轮不访问，真删除永不消失 —— 已知代价，不改 |
| 22 | `notifyFor` 用不会 abort 的 signal；`locator.locate` 不传 signal | `core/scheduler.js`、`src/adapters/locator-table/index.js` | **已修（`dbfa21f` 前）**：`scheduler.js:351` 已是 `await locator.locate(ticket, handle.signal)`；`notifyFor`（`:790-802`）自带 `linkSignal(signal)` + `notifyTimeoutMs` 超时，catch 只 `logInfo('通知失败（不影响票据状态）')` |
| 23 | `tools/define.js` 的 integer 校验不查 min/max（`pipeline_status` 声明了 min1/max100，0/1000 照样放行） | `src/tools/define.js:151-163` | **已修（`dbfa21f` 前）**：`case 'integer'` 已查 `spec.min` / `spec.max`，`:152-155` 注释就在讲这个 bug 已补 |
| 24 | `ownerToken` 含 pid + 时间戳 → 重启后旧租约最多阻塞 10 分钟 | `src/core/store.js:78-81` | **仍成立** |
| 25 | 无定时器卸载钩子；agent 泄漏（`agents.create` 返回的 `dispose` 已在 `1f788cb` 改为 `await created.dispose?.()`，老宿主退回 `agent.release?.()`） | `src/index.js`、`src/adapters/executor-agent/index.js` | **部分成立**：agent 释放已修；定时器只有 `scheduler.js:604` 一处 `clearInterval(heartbeatId)`，轮询走宿主 `ctx.interval`（`src/index.js:1026`），生命周期由宿主管 —— 无自己的卸载钩子 |
| 26 | **限流只能靠抛异常绕开**：executor-agent 把「上游 429 / 配额」转成 `PipelineError('rate-limit')` 抛出后才会进退避队列；若哪天有人改回「返回 failed 结果」，重试又会失效（根因是 9.2 第 7 条） | `src/adapters/executor-agent/agent-failure.js`、`src/core/scheduler.js` | **仍成立**（根因 9.2 第 7 条未修） |

---

## 10. 要不要重构

**结论：不要推倒重来，做定点修复 + 补两个适配器。**

### 10.1 支持「不重构」的依据

| 依据 | 说明 |
| --- | --- |
| 内核零平台知识 | `core/` 与 `contracts/` 里 grep 不到任何飞书 / 金山专有字段；平台差异全在 `SOURCES` 表与适配器目录里 |
| 契约自洽 | 8 个契约文件、11 个 phase、7 类错误都有单测覆盖（`dev-run.mjs` 第 1 节） |
| 回归网够密 | **624** 项离线断言 + **282** 条面板断言 + **99** 条飞书断言全绿，改一处坏一处会立刻被看见 |
| 装配层已是表驱动 | 加平台 = 加目录 + `SOURCES` 一行（ADR-0001） |
| 坏隔离已做 | 一个项目配错不拖垮其它项目；能力名拼错只记日志 |

### 10.2 真要重构的话，只有这两处值得动

| 建议 | 理由 | 代价 |
| --- | --- | --- |
| 把 `scheduler` 里「执行器返回结果」与「执行器抛异常」两条失败通路合并成一条 | 现在可重试性判断被分裂在两处，行为不一致（9.2 第 7 条） | 中，要动调度器核心 + 补测试 |
| 把 `src/index.js`（1 248 行）按「装配 / 工具注册 / 轮询」拆三块 | 文件偏大，但拆了也不改变行为 | 低，收益也一般，**不建议本轮做** |

### 10.3 建议的推进顺序

第二步与第二步半互不阻塞，第二步半可与第二步并行。

| 阶段 | 内容 | 判据 |
| --- | --- | --- |
| 第一步（`5b94a17` + `26f0391`，**已完成**） | 9.1 的 P0 里除金山取数通道外全部关掉；9.2 的 5 条关掉；收窄开关推广到四个源 | ✅ 自测 242/242；沙盒 001 已真跑出 MR !1 |
| 第一步补（**已完成**） | 项目工作区：票 → 项目 → 宿主 Workspace 登记（`core/workspace.js`），会话 cwd = 工作区根 + `workingDirectory` 钉隔离目录（仅 `isolateWorktree: true` 时）+ `attachSession` 归属 | ✅ 自测 262/262（新增 11 项工作区断言 + 7 项执行器会话断言） |
| 「本地提交」改造（**已完成**，2026-11-06） | 交付形态从远程 draft MR 换成本地提交：`commitLocally`、`ExecResult.commit`、`repo.gitlab.enabled` 总开关、通知/状态/体检三处文案 | ✅ 自测 269/269（新增 7 条）；`gitlab-checks` 51 → 58 |
| 「改代码落点」改造（**已完成**，2026-11-06 晚） | 缺省直接在项目工作区的检出里改代码、就地提交（当轮要求检出干净，后由 §1.10 的基线机制取代成「脏也能跑」），新增 `isolateWorktree`（默认 `false`）把隔离 worktree 降级成可选项；`isIsolatedWorktreePath` 堵住清理误删主检出 | ✅ 自测 274/274（新增 5 条，`dev-run.mjs` 第 15 节）；见 §1.3 |
| 「改动收集改 `git -z`」缺陷修复（**已完成**，2026-11-06 深夜） | 未跟踪新文件漏提交、路径被引号/八进制转义、未跟踪目录折叠导致敏感文件绕过、`.agents/worktrees` 污染检出 —— 四个坑一并修；新增契约 `src/contracts/git-status.js`、新增 `unstageSensitiveFiles`、删除三个非 `-z` 解析导出 | ✅ 自测 285/285（新增 11 条）；`gitlab-checks` 58 → 68；真实 git 端到端探针通过；见 §1.4 |
| 「陈旧工作区坐标不得复用」缺陷修复（**已完成**，2026-11-06） | 守卫只看字段有没有值 → 目录已删/换了仓库仍复用死路径，`workingDirectory.set` 对着空气报错；`resetByHuman` 不清坐标、`recoverPending` 不管 failed，两处放大器让票重置后必然复现 | ✅ 自测 288/288（新增 3 条）；见 §1.5 |
| 「插件版本自检」（**已完成**，2026-11-06） | 宿主加载的是 profile 下的目录副本（跨盘 `file:` 落成复制），HMR `root: []` 不监听源码 ⇒ 改完不同步就静默跑旧代码；新增 `src/core/plugin-version.js`，`pipeline_doctor` 比对安装副本与源码的**文件内容**，落后时给出同步命令，只进「提醒」 | ✅ 自测 288 → 293（新增 5 组断言）；见 §1.6 与 `architecture.md` §12.11 |
| 「`setPhase` 清不掉字段」缺陷修复（**已完成**，2026-11-06） | `setPhase` 把补丁里所有 `undefined` 一概过滤，于是调用方写的每一种「清掉」都静默失效：成功票上挂着上一轮 `lastError`（真实事故：`pms\|reczz28VWNWVbpgL` 跑成 done 却显示 `provider "workbuddy" has no configured model`），启动恢复以为清了死坐标其实没清。改为「键不存在 = 不动 / 键在值为 undefined = 删掉」 | ✅ 自测 293 → 294（新增 1 条走真实重试路径 —— 旧的那条是 `resetByHuman` 兜的假绿）；见 §1.7 |
| 「回填 / 保留会话 / 基线 / 面板」四项改造（**已完成**，2026-11-06） | ①处理完回填工单表（`TicketSource.writeResult` 唯一写入口 + `writeBack`/`writeBackStatus`，见 §1.8）②处理完保留会话（`ExecResult.sessionId` + `keepSession`，见 §1.9）③脏工作区只提交 agent 改过的文件（`createBaseline` + `describeDirtyCheckout`，`assertCleanCheckout` 删除，见 §1.10）④设置面板补齐（`projects` 子树可编辑 + 第 3 个 Remote 方法，配置 33 键 / 7 组，现为 24 键 / 4 组，见 §1.11） | ✅ 自测 319/319（新增 25 条，`dev-run.mjs` 第 16 节 + 第 15 节改写）；`feishu-checks` 52 → 58、`gitlab-checks` 68 → 78；`client-check` / `client-smoke` 全绿 |
| 「选择分支」改造（**已完成**，2026-11-06） | `repo.baseBranch` / `repo.targetBranch` 带候选下拉：`src/core/branches.js`（`parseBranchRefs` / `mergeBranchChoices` / `listBranches` 绝不抛）+ 第 4 个 Remote 方法 `ticketPipeline.branches()`（一次返回全部项目）+ 面板字段 `kind` 从 `text` 改 `branch`（`<input list>` + `<datalist>`，不做纯 `<select>`），见 §1.12 | ✅ 自测 319 → **325/325**（新增 6 条，`dev-run.mjs` 第 17 节；上线加固 + 时间线后现为 482/482）；`client-check` 的 `kind` 白名单加 `branch`，Remote 描述符 4 个方法一致 |
| **上线加固**（**已完成**，2026-11-06） | 5 条阻断项 + 4 条重要项：适配器名强校验（`workExecutor` / `pushAdapter` 的 `enum`，写错抛 `invalid-input` 不静默退 mock）、验证命令超时与取消（30 分钟缺省、退出码 124、取消真 kill）、敏感名单 9 → **8 大类 41 条正则**、`.git`/profile 篡改自检（28 + 10 + 4）、终态与事后动作同一次落库（`pendingEffects` + `replayPendingEffects`）、回填失败进通知、就地重跑起点、租约诚实化（best-effort，不是原子 CAS），见 §1.14 | ✅ 自测 325 → **363/363**（当轮；新增 38 条，`dev-run.mjs` 第 16b 节 14 条 + 各 checks）；`gitlab-checks` 78 → 86、`wps-checks` 25 → 34、`workspace-checks` 11 → 19 |
| **关键节点流程日志（时间线）**（**已完成**，2026-11-06） | 票据 `timeline` 17 节点表（9 主站 ①–⑨ + 8 补充站）、`markNode` / `markExtra` / `onFlow` 全链路打点、`pipeline_status` 排成时间线并写「现在停在第 N 站，已 X 分 Y 秒没动」、历史不清空 + 80 条封顶，见 §1.16 | ✅ 自测 363 → **376/376**（新增 13 条，`dev-run.mjs` 第 16c 节）；26 小节；真实链路探针 11 条时间线、渲染探针给出 `station`/`stalledForMs` |
| **飞书电子表格支持**（**已完成**，2026-11-09） | 新增 `src/adapters/source-feishu/sheets.js`（579 行纯函数：列名别名、工作表定位、range、读值、行身份、日期/优先级）；`get_node` 不再硬写 `obj_type`；`resolveTable` 成表型分派总闸（显式 `tableKind` → `spreadsheetToken` → `appToken` 双试 → `docNamePattern`）；`scan` 拆 `scanBitable` / `scanSheet`；`validateProject` 四选一；9 个配置键透传；面板加「飞书电子表格」一组（含 `kind:'columns'` 一行写法）。见 §1.21 | ✅ 自测 384 → **451/451**；`feishu-checks` 60 → **80**（19 条电子表格断言）；`client-smoke` **175** 条；`client-check` 面板字段 29 项与 descriptor 对得上 |
| **22 张产品工单落地批次**（**已完成**，2026-11-10） | 产品评审出的 22 张票全部实施完（见 `.scratch/ticket-pipeline-product/spec.md` 索引）：配置 33 → **25 键 4 组**、`skipped` 终态文案四档、面板加「运行」第五页签、`delivery` 交付维度、`appToken` 面板贴链接、多维表格列名别名、电子表格回填、WPS 与 GitLab 降级为 experimental、doctor 三档体检、校验带修复建议与拼错键检测 | ✅ `dev-run` 451 → **483/483**；`feishu-checks` **93** 条；`client-check` **9 个 Remote 方法** / 25 叶子 / 72 节点 / `projects` 可写 34 字段；`client-smoke`、`chain-smoke`（11）、`wps-checks` 全绿 |
| **总览的流程带**（**已完成**，2026-11-10 晚） | 总览每张工单多一行 9 主站流程带（`describeStations` / `renderFlowLine`）：`①✓ ②✓ …⑨✓｜全程 X`，符号 `✓/✗/▶/–` + 图例只印一次；只给 ≥1 分钟的站标耗时、终态票最后一站不标、老票说「没有流程记录」而不是画全 `–`；返回体 `tickets[].flow` 给机器可读九站结构。见 §1.25 / `architecture.md` §11.5 | ✅ 自测 483 → **486/486**（新增 3 条） |
| 第二步（当前） | 真实飞书票 `pms\|reczz28VWNWVefNA` 复跑一次全链路 | 收到真 QQ 邮件、邮件里有本地提交 sha 且能 `git show` 到、`verify.test` 真跑过 |
| 第二步半（**代码已完成**，2026-11-09） | **飞书电子表格支持**（设计见 `docs/ticket-pipeline/feishu-sheet-source.md`，决策见 `docs/adr/0005-飞书电子表格源按表型分派.md`；回填见 §1.23） | ✅ `dev-run` 384 → **451** → **482**（#22 回填）；真表读数据与回填待 §8.2 人工前置（开 `sheets:spreadsheet` **读写** + 「添加文档应用」加成可编辑） |
| 第三步 | 补金山开放平台取数通道 | 给一张真实金山表链接 + 凭据，能扫出票 |
| 第四步 | 9.2 / 9.3 剩余项按需修 | —— |