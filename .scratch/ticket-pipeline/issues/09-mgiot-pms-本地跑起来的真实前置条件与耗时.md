<!-- DSH-FORMAT: md-v1 -->
<!-- DSH-PARENT: 00 -->
<!-- DSH-LABELS: wayfinder:task -->
<!-- DSH-IDEMPOTENCY-KEY: deck-plan-ticket-pipeline-v1-child-env-baseline -->
<!-- DSH-CREATED: 2026-11-03T11:02:09.042Z -->
# 09: 项目清单与工单表绑定（projects 配置、两种绑定方式、多项目参数化）

Type: task

Status: resolved
## Question

插件从「只对 mgiot-pms 的专用流水线」改为**通用插件**（用户 2026-11-03 方向修正，原话见地图「维护者原话」区）。本票把通用化的地基做出来：

**每个项目在飞书知识树里有自己的工单表**（如「[问题统计]PMS任务工单」挂在「[运维]能耗SaaS标准版」节点下）——「工单属于哪个项目」在**表这一级**就定了，不在行级判断。

**要交付的**：

1. **`projects[]` 配置结构**（插件 Config 里的核心新增），每个条目至少含：
   - `name`：项目名（人工起，通知与分支名里显示用）
   - `match`：工单表绑定，两种方式二选一或并存（用户已拍板**两种都做、显式优先**）：
     - 显式：`platform` + `appToken` + `tableId`（+ 可选 `viewId`）
     - 模糊：`docNamePattern`（如 `[问题统计]*PMS*`），由飞书适配器按文档名搜索解析成 appToken/tableId；解析失败或命中多张 = 配置错误，不瞎猜
   - `repo`：`path`（本地仓库）、`remote`（GitLab 地址）、`baseBranch`、`targetBranch`
   - `verify`：该项目的构建/测试命令（**验证命令放每个项目配置里**，用户已拍板；不配则跳过验证直接开 draft MR）
2. **多项目运行时**：启动时遍历 `projects[]`，每个条目用 `SOURCES[platform]` 建一个 `TicketSource` 实例；`Ticket` 增加 `projectId` 字段——扫描结果天然带项目归属，永远不存在行级「这行工单属于谁」的判断。
3. **RepoLocator 退化成查表**：`locate(ticket)` = `projects[ticket.projectId].repo`，只返回仓库位置；**改哪里的代码交给执行 agent 现场读仓库定位**（用户已拍板，废除 mgiot-pms 静态模块别名表）。
4. **全链路按项目参数化**：worktree 建在该项目 repo 下、分支名含项目名、MR 开到该项目配置的远端/目标分支、验证跑该项目自己的 `verify`、通知文案带项目名。mgiot-pms 的一切（仓库路径、模块别名、mvn/npm、GitLab 地址）从内核与骨架退场，变成 projects[] 里的一条普通数据。
5. **未匹配的表**：忽略不处理（用户已拍板——工单表本来就按项目建，树里还有大量非工单文档）。
6. **mgiot-pms 作为第一条配置示例**写进 README 与 config.js 默认注释（不再硬编码）。

**同步修正**：`docs/ticket-pipeline/architecture.md` 里「只做 mgiot-pms」的表述、`plugins/ticket-pipeline/` 骨架里 locator-pms 的硬编码假设，都按本票结论改。

**已知沙箱约束**（不变）：流水线要真跑起来，插件所在会话必须满足 cwd/workspace 是目标仓库之一，或 file policy 为 `danger-full-access`——多项目后这条约束按项目逐一成立。

## Answer

交付物 6 条全部完成并验证：①projects[] 配置结构（config.js 的 validateProject 校验 name/match{platform,appToken,tableId,viewId,docNamePattern}/repo{path,remote,baseBranch,targetBranch}/verify{build,test}，两种绑定方式显式优先）②多项目运行时（index.js 遍历 projects[] 每项目建 source，Ticket 加 projectId，store 改复合主键 ticketKey(projectId,recordId)）③RepoLocator 退化成 locator-table 查表（locator-pms 整目录删除）④全链路按项目参数化（worktree 分支名含项目名、MR 目标分支取项目 repo.targetBranch、通知带项目名）⑤未匹配表忽略（多 source 只扫配置项目）⑥mgiot-pms 降为示例配置。同步修正：architecture.md 与插件骨架的 mgiot-pms/locator-pms/v2.x 硬编码全部清零（grep 0 命中），自测 node scripts/dev-run.mjs 32/32 绿 exit 0。

## 进度

- 进度：100%（2026-11-03T22:45:26+08:00）：通用化重写完成：projects[]配置+多source+复合主键+locator-table查表，架构文档与骨架硬编码清零，自测32/32绿
- 进度：10%（2026-11-03T21:59:42+08:00）：票已按通用化方向重写（原 mgiot-pms 实测耗时被用户否掉），未开工
