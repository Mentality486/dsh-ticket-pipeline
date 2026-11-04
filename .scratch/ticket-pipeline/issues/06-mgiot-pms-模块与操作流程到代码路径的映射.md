<!-- DSH-FORMAT: md-v1 -->
<!-- DSH-PARENT: 00 -->
<!-- DSH-LABELS: wayfinder:research -->
<!-- DSH-IDEMPOTENCY-KEY: deck-plan-ticket-pipeline-v1-child-repo-map -->
<!-- DSH-CREATED: 2026-11-03T11:02:09.042Z -->
# 06: mgiot-pms 模块与操作流程到代码路径的映射

Type: research

Status: resolved
## Question

工单里的「模块」（上门服务 / 工作台 / 客户投诉管理 / 项目技术支持 / 问题管理 / 登录）和「操作流程」（如 `客户投诉管理-投诉列表-投诉详情`）分别落在 `mgiot-pms` 的哪些目录与文件？给出一张可复用的模块→路径映射表，标明哪些模块前后端/小程序同时涉及，以及每条路径对应哪个构建与测试命令。

## Comments

### local — 2026-11-03T11:21:48.530Z
## Resolution（research 完成）

报告：`.scratch/ticket-pipeline/research/repo-map.md`（40 KB，784 行给的是 wechat 那份；这份 40 KB）。

核心结论：

1. **菜单/路由有 3 个前端注册中心 + 1 个后端权限树**，且**没有数据库菜单表**（`sql/**` 里 `sys_menu` 零命中）。真正渲染的是 `pms-web/src/layouts/components/Sidebar.vue:82-164` 的 `_allMenuItems`；`pms-web/src/stores/menuConfig.ts` 只管排序/隐藏/面包屑兜底/登录落地；`pms-web/src/router/index.ts` 是唯一路由表；`pms-server/.../controller/SysPermissionController.java:69-145` 是后端权限树。
2. **工单里的「模块」用的是旧称**，这是最大的坑：`问题管理` → 现 UI 叫**日常工作**（`/task`，`task:*`，`views/task/`）；`项目技术支持` **不是页面、是分组壳** `/project-group`「项目管理」，下挂 6 个模块（项目进度/日常工作/产品测试/首样测试/生产技术支持/上门服务）；`客户投诉管理` → `/complaint`；`上门服务` → `/service`；`工作台` → `/dashboard`；`登录` → `/login`。
3. **改名时间线**：`sql/migration/V2.49.sql`（2026-10-12）把「项目技术支持→项目进度」「产品首样测试→首样测试」，一级分组名由后端 `GROUP_LABELS` 常量控制（虚拟节点，无 DB 列）。
4. **详情页主流是 MasterDetail 右栏**：`?id=<id>` → 列表页内嵌 `*Detail.vue`（`embedded` 模式），少数另有独立路由供通知跳转。
5. **改一个页面最少动 4 处**：路由 `meta.permission` + `ALL_MENU_CONFIGS`/`Sidebar.vue` + `v-permission` + 后端 `@PreAuthorize`，再补 SQL 权限种子（`AGENTS.md:185`、`AGENTS.md:652`）。
6. 给了 `客户投诉管理-投诉列表-投诉详情` 的完整文件清单（前端 12 个文件 + 后端 12 个文件，全部带行号）与一条验证命令：`node scripts/check-consistency.mjs` + `npm run build` + `mvn -o test` + 起后端 `curl`。
7. **不确定项**（已标注）：`工作台-项目列表` 的「项目列表」已不存在（合并进「项目 · 人员」卡片）；`项目技术支持` 单出现时歧义（6 个模块），agent 需回问或全量搜；构建耗时未实测；`docs/SYSTEM_FLOW.md:60-95` 菜单树已过期，不能当映射依据；前端无 lint/单测，唯一自动化验证是 `npm run build`。

对流水线的直接含义：**模块 → 代码路径这一步不能靠模型猜，要先把这张别名表做成插件里的静态映射表**；`项目技术支持` 这类歧义值要在票的描述里保留原文并在 prompt 里显式列出 6 个候选。

## Answer

research 收口：映射表已写入 `.scratch/ticket-pipeline/research/repo-map.md`。关键发现是工单「模块」用旧称、`项目技术支持` 是分组壳、改页面最少动 4 处。未开 PR（research 票规则）。

## 进度
