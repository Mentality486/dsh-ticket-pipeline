# mgiot-pms：模块 / 操作流程 → 代码路径 映射表

> 目的：让后续 agent 拿到工单里的两个字符串（`模块`、`操作流程`）就能落到具体文件、具体权限码、具体验证命令。
> 目标仓库：`D:\WorkSpace\mgiot-pms`（下文所有路径都是**相对仓库根**）。
> 调研方式：只读。全部结论带 `文件:行号` 证据；找不到的写「未找到」，不猜。
> 基线：`git HEAD = 6c68ac6`（2026-11-02）。

---

## 0. 一分钟版

| 问题 | 答案 |
| --- | --- |
| 菜单/路由有几个注册中心？ | **3 个前端 + 1 个后端**：`pms-web/src/router/index.ts`（路由表）、`pms-web/src/layouts/components/Sidebar.vue`（**真正渲染**的侧边栏）、`pms-web/src/stores/menuConfig.ts`（排序/隐藏/面包屑兜底/登录落地）、`pms-server/.../controller/SysPermissionController.java`（后台权限树） |
| 有数据库菜单表吗？ | **没有**。`sql/*.sql` 中 `sys_menu` 零命中；菜单是硬编码在代码里的，`sys_config` 只存「哪些菜单被隐藏」和「菜单排序」 |
| 「问题管理」对应谁？ | `task` 模块：路由 `/task`、权限 `task:list`、`views/task/TaskList.vue`、`PmsTaskController` |
| 「项目技术支持」对应谁？ | **不是页面，是分组壳** `/project-group`「项目管理」，下挂 6 个模块（项目进度/日常工作/产品测试/首样测试/生产技术支持/上门服务） |
| 详情页怎么打开？ | 主流是 **MasterDetail 右栏**：`?id=<id>` → 列表页内嵌 `*Detail.vue`（`embedded` 模式）；少数另有独立路由供通知跳转 |
| 改一个页面最少动几处？ | 新页面「四联改」：路由 `meta.permission` + `ALL_MENU_CONFIGS`/`Sidebar.vue` + `v-permission` + 后端 `@PreAuthorize`，再补 SQL 权限种子（`AGENTS.md:185`、`AGENTS.md:652`） |

---

## 1. 模块别名表（工单字符串 → 内部模块）

工单里的「模块」用的是**旧称**，和现在 UI 上的标签不一致，这是整张映射表最容易踩的坑。

| 工单「模块」 | 现 UI 名称 | 路由前缀 | 权限前缀 | 前端目录 | 后端文件簇 | 小程序 |
| --- | --- | --- | --- | --- | --- | --- |
| `登录` | 登录 | `/login` | 无（`requiresAuth:false`） | `pms-web/src/views/auth/Login.vue` | `controller/AuthController.java`、`service/AuthService.java`(+`impl/AuthServiceImpl.java`)、`config/JwtAuthenticationFilter.java`、`config/SecurityConfig.java` | `pms-miniapp/src/pages/login/index.vue`、`mp/controller/MpAuthController.java` |
| `工作台` | 工作台 | `/dashboard` | `dashboard:view` | `pms-web/src/views/dashboard/Index.vue`、`api/dashboard.ts` | `controller/DashboardController.java`、`service/impl/DashboardServiceImpl.java`（无 entity/mapper） | `pms-miniapp/src/pages/dashboard/index.vue`、`mp/controller/MpDashboardController.java` |
| `客户投诉管理` | 客户投诉管理 | `/complaint` | `complaint:*` | `pms-web/src/views/complaint/` | `Complaint*`（见 §6） | `pms-miniapp/src/pages/records/*`（`module=complaint` 参数化） |
| `问题管理` | **日常工作** | `/task` | `task:*` | `pms-web/src/views/task/` | `PmsTask*`（见 §6） | `pms-miniapp/src/pages/todo/*` |
| `项目技术支持` | **项目管理**（`/project-group` 分组壳） | 无独立路由 | 6 个子权限 | `views/{project,task,product-test,product-sample-test,production-issue,service}/` | 6 个独立文件簇 | `pages/todo/*` + `pages/records/*` |
| `上门服务` | 上门服务 | `/service` | `service:*` | `pms-web/src/views/service/ServiceList.vue` | `ServiceOrder*`（见 §6） | `pages/service/trip-log.vue`、`pages/records/*`(`module=service_order`) |

> 证据：`pms-web/src/layouts/components/Sidebar.vue:82-164`（菜单项与 `permission`）、`pms-web/src/stores/menuConfig.ts:43-87`（分组 permKeys）、`pms-server/.../controller/SysPermissionController.java:69-145`（后端权限树同名同序）。
> 旧称残留证据：`pms-web/src/views/project/ProjectList.vue:38`、`pms-server/.../controller/ActivityController.java:26`、`PmsProjectService.java:21` 里的「问题管理」都指 `task`；`Sidebar.vue:244`、`product-test/ProductTestList.vue:3`、`ProductSampleTestController.java:21`、`entity/PmsSampleTest.java:12` 里的「项目技术支持」都指 `/project-group` 分组壳。
> 改名时间线：`sql/migration/V2.49.sql`（2026-10-12）把「项目技术支持→项目进度」「产品首样测试→首样测试」，并注明**一级分组名由后端 `GROUP_LABELS` 常量控制（虚拟节点，无 DB 列）**。

### 1.1 扩展行（工单里也可能出现的模块，同样给出落点）

| 模块 | 路由 | 权限前缀 | 前端视图 | 后端文件簇 |
| --- | --- | --- | --- | --- |
| 生产技术支持 | `/production-issue` | `production_issue:*` | `views/production-issue/ProductionIssueList.vue` | `ProductionIssue*` |
| 产品测试 | `/product-test` | `product_test:*` | `views/product-test/ProductTestList.vue` | `ProductTest*` |
| 首样测试 | `/product-sample-test` | `product_sample_test:*` | `views/product-sample-test/ProductSampleTestList.vue` | `PmsSampleTest*`、`ProductSampleTestController.java` |
| 产品方案配置 | `/opportunity*` | `opportunity:*` | `views/opportunity/{OpportunityList,OpportunityDetail,OpportunityFunnel,OpportunityReport}.vue` | `Opportunity*`、`PmsOpportunity*` |
| 产品管理 | `/system/{product,customer,scheme}` | `system:product:*` 等 | `views/system/{product,customer,scheme}/Index.vue` | `ProductController`、`CustomerController`、`SchemeController` |
| 办公协作 | `/notification`、`/file`、`/time-stats` | `notification:view`、`file:list`、`timelog:list` | `views/notification/Index.vue`、`views/file/FileList.vue`、`views/timelog/TimeStats.vue` | `PmsNotificationController`、`PmsFileController`、`PmsTimeLogController` |
| 系统管理 | `/system/*` | `system:*:*` | `views/system/**` | `Sys*Controller` |

> 证据：`pms-web/src/router/index.ts:74-131`、`pms-web/src/layouts/components/Sidebar.vue:89-162`、`pms-server/.../controller/SysPermissionController.java:92-144`。

---

## 2. 注册中心之一：前端路由表

**文件：`pms-web/src/router/index.ts`（383 行）——全仓库唯一的路由表。**

| 行 | path | name | 组件 | `meta` |
| --- | --- | --- | --- | --- |
| 9-12 | `/login` | Login | `views/auth/Login.vue` | `{title:'登录', requiresAuth:false}` |
| 15-16 | `/` | — | `layouts/AppLayout.vue` | 重定向 `/dashboard`，所有子路由挂这里 |
| 20-23 | `dashboard` | Dashboard | `views/dashboard/Index.vue` | `工作台` / `dashboard:view` |
| 26-29 | `project` | ProjectList | `views/project/ProjectList.vue` | `项目进度` / `project:list` |
| 32-35 | `project/:id` | ProjectDetail | `views/project/ProjectDetail.vue` | `项目详情` / `project:list` |
| 38-41 | `my-follow` | MyFollow | `views/follow/MyFollow.vue` | `我的关注` / `project:list` |
| 44-47 | `report/overview` | GlobalReport | `views/report/GlobalReport.vue` | `全局项目报告` / `report:overview` / hidden |
| 50-53 | `project/:id/report` | ProjectReport | `views/report/ProjectReport.vue` | `项目报告` / `project:list` |
| 56-59 | `project/:id/report/history` | ReportHistory | `views/report/ReportHistory.vue` | `报告历史` / `project:list` / hidden |
| 62-65 | `task` | TaskList | `views/task/TaskList.vue` | `日常工作` / `task:list` |
| 68-71 | `task/detail/:id` | TaskDetail | `views/task/TaskDetail.vue` | `问题详情` / `task:list` / hidden |
| 74-77 | `product-test` | ProductTestList | `views/product-test/ProductTestList.vue` | `产品测试` / `product_test:list` |
| 80-83 | `product-sample-test` | ProductSampleTestList | `views/product-sample-test/ProductSampleTestList.vue` | `首样测试` / `product_sample_test:list` |
| 86-89 | `task/gantt` | GanttView | `views/task/GanttView.vue` | `甘特图` / `task:list` |
| 92-95 | `task/kanban` | KanbanView | `views/task/KanbanView.vue` | `看板视图` / `task:list` |
| 98-101 | `task/calendar` | CalendarView | `views/task/CalendarView.vue` | `日历视图` / `task:list` |
| 104-107 | `tag` | TagList | `views/tag/Index.vue` | `标签管理` / `task:list` |
| 110-113 | `production-issue` | ProductionIssueList | `views/production-issue/ProductionIssueList.vue` | `生产技术支持` / `production_issue:list` |
| 116-119 | `service` | ServiceList | `views/service/ServiceList.vue` | `上门服务` / `service:list` |
| 122-125 | `file` | FileList | `views/file/FileList.vue` | `文件管理` / `file:list` |
| 128-131 | `time-stats` | TimeStats | `views/timelog/TimeStats.vue` | `工时统计` / `timelog:list` |
| **134-137** | **`complaint`** | **ComplaintList** | **`views/complaint/ComplaintList.vue`** | **`投诉列表` / `complaint:list`** |
| **140-143** | **`complaint/:id`** | **ComplaintDetail** | **`views/complaint/ComplaintDetail.vue`** | **`投诉详情` / `complaint:list` / hidden** |
| **146-149** | **`complaint/report`** | **ComplaintReport** | **`views/complaint/ComplaintReport.vue`** | **`投诉报表` / `complaint:report`** |
| 152-155 | `opportunity` | OpportunityList | `views/opportunity/OpportunityList.vue` | `需求列表` / `opportunity:list` |
| 158-161 | `opportunity/:id` | OpportunityDetail | `views/opportunity/OpportunityDetail.vue` | `需求详情` / hidden |
| 164-167 | `opportunity/funnel` | OpportunityFunnel | `views/opportunity/OpportunityFunnel.vue` | `需求漏斗` / `opportunity:funnel` |
| 170-173 | `opportunity/report` | OpportunityReport | `views/opportunity/OpportunityReport.vue` | `需求报表` / `opportunity:report` |
| 176-179 | `system` | System | （父级，无组件） | `系统管理` |
| 182-251 | `system/{user,dept,role,log/operation,log/login,menu,product,customer,scheme,settings,workflow,holiday}` | 12 个 | `views/system/**` | 各自 `system:*:list` |
| 255-258 | `notification` | Notification | `views/notification/Index.vue` | `消息通知` / `notification:view` |
| 261-264 | `profile` | Profile | `views/profile/Index.vue` | `个人信息` / hidden |
| 267+ | `/:pathMatch(.*)*` | — | 重定向 `/login` | 兜底 |

其余关键位置：
- `index.ts:275-278` `createRouter({ history: createWebHistory(import.meta.env.BASE_URL), routes })`
- `index.ts:287-333` `firstAccessiblePath(userInfo)`：登录后**按菜单顺序**（`useMenuConfigStore().orderedMenuConfigs`）挑第一个有权限的页面，admin/`*` 直接 `/dashboard`。注释 301-303 说明「不能用路由匹配顺序，否则会落到 `/task/gantt`」。
- `index.ts:337-374` `router.beforeEach`：`requiresAuth:false` 直通；否则懒取 `userStore.getUserInfo()`（HttpOnly cookie，失败 → `/login`）；353-369 权限闸门（admin/`*` 直通，否则 `next(fallback)` / `next(false)`）；372 设置 `document.title`。
- `index.ts:377-381` `router.onError` → `utils/chunkReload`（部署后旧 chunk 404 自动刷新一次）。

---

## 3. 注册中心之二：侧边栏（**真正渲染的那份**）

**文件：`pms-web/src/layouts/components/Sidebar.vue`**

`_allMenuItems`（L82-164）才是渲染源；`pms-web/src/stores/menuConfig.ts` 的 `ALL_MENU_CONFIGS` **不参与渲染**，只管排序/隐藏/面包屑兜底/登录落地。

| 行 | 分组 / 项 | `permission`（数组=任一命中） |
| --- | --- | --- |
| 83-88 | `/dashboard` 工作台 | `dashboard:view` |
| 89-102 | `/project-group` 项目管理 | `['project:list','task:list','product_test:list','product_sample_test:list','production_issue:list','service:list']` |
| 95 | ├ `/project` 项目进度 | `project:list` |
| 96 | ├ `/task` 日常工作（旧称「问题管理」） | `task:list` |
| 97 | ├ `/product-test` 产品测试 | `product_test:list` |
| 98 | ├ `/product-sample-test` 首样测试 | `product_sample_test:list` |
| 99 | ├ `/production-issue` 生产技术支持 | `production_issue:list` |
| 100 | └ `/service` 上门服务 | `service:list` |
| 103-113 | `/complaint-group` 客户投诉管理 | `['complaint:list','complaint:report']`（`permission` 在 L108） |
| 110 | ├ `/complaint` 投诉列表 | `complaint:list` |
| 111 | └ `/complaint/report` 投诉报表 | `complaint:report` |
| 114-124 | `/opportunity-group` 产品方案配置 | `['opportunity:list','opportunity:funnel','opportunity:report']` |
| 125-135 | `/product-group` 产品管理 | `['system:product:list','system:customer:list','system:scheme:list']` |
| 136-146 | `/collab-group` 办公协作 | `['notification:view','file:list','timelog:list']` |
| 147-163 | `/system` 系统管理 | 8 个 `system:*:list`（含 `system:holiday:list`） |

- L107 注释：「父级 permission 必须包含所有子项权限」——否则只有子权限的人看不到整个分组。`AGENTS.md:559-583` 有同样的 ✅/❌ 例。
- L167-185 `allMenuItems` computed：按 `menuConfigStore.menuOrder` 重排。
- L188-221 `menuItems` computed：按 `isMenuHidden(key)` + `hasPermission` 过滤；父项无可见子项时整组隐藏。
- L223-239 `selectedKeys`：`/complaint/report`、`/opportunity/report`、`/opportunity/funnel`、`/tag` 精确匹配，其余靠 `subRouteMap`（含 `/complaint/` → `/complaint` 前缀）保证进详情时父项仍高亮。
- L246-277 `PROJECT_GROUP_PREFIXES` + `groupKeysOf(path)`：把 `/system/product|customer|scheme` 归到 `/product-group` 等。
- L300-302 `handleClick` → `router.push(info.key)`；L305-315 `onMounted` 拉 userInfo + `menuConfigStore.loadFromServer()`。

> 已知不一致（**agent 必须容忍**）：`/system/holiday`（节假日管理）在 Sidebar 和路由里都有，但 `ALL_MENU_CONFIGS` 的 `/system` 是 `children: []`（`menuConfig.ts:87`）；反过来 `ALL_MENU_CONFIGS` 的子项**没有 permission 字段**（接口 `ChildMenuConfig{key,label}`，`menuConfig.ts:23-26`），`menuConfig.ts:80` 注释明确说子项可见性由 Sidebar 自己判断。

---

## 4. 注册中心之三：菜单配置 store（排序/隐藏/落地页）

**文件：`pms-web/src/stores/menuConfig.ts`**

| 行 | 内容 |
| --- | --- |
| 5-8 | 4 个 key：`pms_hidden_menus` / `menu_hidden_keys`（隐藏）、`pms_menu_order` / `menu_order`（排序） |
| 11 | `LOCKED_KEYS = ['/dashboard','/system']`（这两个永远不能被隐藏） |
| 14-21 | `getDefaultOrder()` 从 `ALL_MENU_CONFIGS` 派生默认顺序 |
| 43-87 | `ALL_MENU_CONFIGS`：7 个分组的 key/label/icon/locked/permKeys/children |
| 110-135 | `loadFromStorage()`（localStorage + 合并新增父/子项） |
| 138-169 | `loadFromServer()`：`get('/system/config/'+CONFIG_KEY)` + `get('/system/config/'+ORDER_CONFIG_KEY)`，合并后回写 localStorage |
| 172-180 | `saveToServer()`：`put('/system/config/'+CONFIG_KEY, {value, remark:'菜单隐藏配置'})` |
| 182-197 | `toggleMenu` / `isMenuHidden` / `resetAll`（受 LOCKED_KEYS 约束） |

后端对应：`pms-server/.../controller/SysConfigController.java:21` `GET /api/system/config/{key}`（`isAuthenticated()`，L23 注释「所有登录用户可读取配置（菜单配置需要）」）、`:28` `PUT`（`hasRole('admin')`）。存储表是 `sql/sys-init.sql:117-124` 的 `sys_config(config_key, config_value, remark)`。

管理界面：`pms-web/src/views/system/menu/Index.vue:73-74`（标题「菜单管理」，说明「配置侧边栏菜单的显示与隐藏，切换后对所有用户生效…工作台和系统管理始终显示」）。

> 结论：**想改菜单文案/顺序/可见性，不要动 SQL**——顺序和显隐是运行时配置（`sys_config`），文案写死在 `Sidebar.vue` + `ALL_MENU_CONFIGS` + `PAGE_TREE` 三处。

---

## 5. 注册中心之四：后端权限树

**文件：`pms-server/src/main/java/com/company/pms/controller/SysPermissionController.java`**

| 行 | 内容 |
| --- | --- |
| 34-42 | `GROUP_LABELS`（LinkedHashMap，顺序即分组顺序）：`dashboard`→工作台、`opportunity-group`→产品方案配置、`project-group`→项目管理、`complaint-group`→客户投诉管理、`product-group`→产品管理、`collab-group`→办公协作、`system`→系统管理 |
| 51 | `record SubPageDef(String permKey, List<String> leafPermKeys)`（子页，如 `project:file`） |
| 59 | `record PageDef(groupKey, pageLabel, modulePermKey, leafPermKeys, subPages)` |
| 69-145 | `PAGE_TREE`：与前台菜单一一对应，逐页列出叶子权限键 |
| 121-125 | 投诉列表 `complaint` 的 12 个叶子：list/add/edit/delete/assign/start/submit_verify/close/reject/cancel/reopen/export |
| 126 | 投诉报表 `complaint:report` |
| 148 | `DIRECT_DB_GROUPS = Set.of("system")`：系统管理不走 PAGE_TREE，直接用 DB 子树 |
| 152-169 | `@GetMapping("/tree")` + `@PreAuthorize("hasAuthority('system:role:list')")` |
| 171-198 | `getHiddenPermKeys()` 读 `sys_config.menu_hidden_keys`，按 `permKey` 前缀过滤（`opportunity:*` 连子项一起隐藏） |
| 222-248 | `buildGroupedTree()`：遍历 GROUP_LABELS → `system` 走 DB 子树 → 其余走 PAGE_TREE |

消费方：`pms-web/src/views/system/role/Index.vue:6` `import { getPermissionTree } from '@/api/permission'`、`:64` 调用，渲染「角色管理 → 配置权限」的勾选树。`api/permission.ts` 仅 6 行。

> 这就是「后端权限树 = 菜单树」的实现：**改菜单名必须同时改 `GROUP_LABELS`（一级分组名，无 DB 列）和 `sys_permission.perm_name`（二级页面名，有 DB 列）**，见 `sql/migration/V2.49.sql` 的说明段。

---

## 6. 「操作流程」字符串 → 页面/组件 的解析规则

工单里的 `操作流程` 形如 `客户投诉管理-投诉列表-投诉详情`、`工作台-项目列表/最近问题`、`项目技术支持-上门服务`。**用 `-` 或 `/` 切段，逐段对着菜单标签查。**

### 6.1 解析算法（给流水线 agent 用）

1. 切段：`操作流程.split(/[-/]/)`，trim，丢掉空段。
2. **第 1 段 = 模块**：查 §1 别名表。命中 `项目技术支持` 时**不要**立刻定文件——它只是分组壳，必须靠第 2 段落到具体模块。
3. **第 2 段 = 二级菜单**：查下表（菜单标签 → path → 组件）。这一段决定**列表页文件**。
4. **第 3 段（可选）= 三级视图**：
   - 若该模块是 MasterDetail 结构（投诉/任务/项目/生产技术支持/首样测试/上门服务）→ 第 3 段对应**右栏详情组件**，通过 `?id=` 打开，不再有独立 URL。
   - 若是 Tab/子路由（如项目阶段切片、投诉报表）→ 第 3 段对应独立路由或子组件。
5. 由「列表页文件」反推：`api/*.ts`（同名前缀）、`constants/*.ts`、后端 `XxxController` → `XxxService`/`XxxServiceImpl` → `entity/PmsXxx.java` → `mapper/PmsXxxMapper.java` → `sql/pms-init.sql` 里的表。

### 6.2 菜单标签 → 路由 → 组件（第 2 段查找表）

| 第 2 段（菜单标签） | path | 列表页组件 | 归属模块 |
| --- | --- | --- | --- |
| 工作台 | `/dashboard` | `views/dashboard/Index.vue` | dashboard |
| 项目进度 / 技术支持项目 | `/project` | `views/project/ProjectList.vue` | project |
| 日常工作 / 任务跟踪 | `/task` | `views/task/TaskList.vue` | task |
| 产品测试 | `/product-test` | `views/product-test/ProductTestList.vue` | product_test |
| 首样测试 / 产品首样测试 | `/product-sample-test` | `views/product-sample-test/ProductSampleTestList.vue` | product_sample_test |
| 生产技术支持 | `/production-issue` | `views/production-issue/ProductionIssueList.vue` | production_issue |
| **上门服务** | `/service` | `views/service/ServiceList.vue` | service_order |
| **投诉列表** | `/complaint` | `views/complaint/ComplaintList.vue` | complaint |
| 投诉报表 | `/complaint/report` | `views/complaint/ComplaintReport.vue` | complaint |
| 需求列表 | `/opportunity` | `views/opportunity/OpportunityList.vue` | opportunity |
| 需求漏斗 | `/opportunity/funnel` | `views/opportunity/OpportunityFunnel.vue` | opportunity |
| 需求报表 | `/opportunity/report` | `views/opportunity/OpportunityReport.vue` | opportunity |
| 消息通知 / 文件管理 / 工时统计 | `/notification` / `/file` / `/time-stats` | `views/{notification/Index,file/FileList,timelog/TimeStats}.vue` | notification / file / timelog |
| 系统管理下 12 页 | `/system/*` | `views/system/**` | system |

### 6.3 第 3 段（详情/子视图）落点

| 模块 | 列表页 | 详情组件 | 打开方式 | 证据 |
| --- | --- | --- | --- | --- |
| 客户投诉管理 | `ComplaintList.vue` | `ComplaintDetail.vue` | `?id=` → 右栏 `#detail` slot；另有独立路由 `/complaint/:id`（通知跳转用） | `ComplaintList.vue:30-31,536,660-671`；`ComplaintDetail.vue:66,71`；`router/index.ts:140-143` |
| 工作台 | `dashboard/Index.vue` | 无子页（卡片：审批待办 / 最近问题 / 项目·人员 / 图表） | 卡片内跳转 | `dashboard/Index.vue:554-576`（最近问题）、`:656-680`（项目·人员） |
| 问题管理（日常工作） | `task/TaskList.vue` | `task/TaskDetail.vue` | `?id=` → 右栏；另有 `/task/detail/:id` | `TaskList.vue:25,989,1268-1274`；`TaskDetail.vue:39,152`；`router/index.ts:68-71` |
| 项目进度 | `project/ProjectList.vue` | `ProjectDetail.vue`（总览）/ `ProjectStageView.vue`（阶段切片） | `?id=` + `stage` | `ProjectList.vue:19-21,101-104,830` |
| 生产技术支持 | `ProductionIssueList.vue` | **同文件内联**（无独立 Detail.vue） | `?id=` → 右栏 | `ProductionIssueList.vue:51,1040,1148` |
| 上门服务 | `ServiceList.vue` | **同文件内联**（`selectedOrder`） | `?id=` → 右栏 | `ServiceList.vue:53,1455,1583` |
| 首样测试 | `ProductSampleTestList.vue` | **同文件内联** + `components/ApprovalTimeline.vue` | `?id=` → 右栏 | `ProductSampleTestList.vue:13-14,56,60,686` |

> 通用机制：`pms-web/src/components/MasterDetailLayout.vue:12-22`（props `selectedId` / `activeSelector` / `total`）、`:73,80`（`#list` / `#detail` slot）、`:34-53`（自动滚到选中行）。
> **详情深链的唯一来源**：`pms-web/src/utils/module.ts:9-27` `MODULE_ROUTE` + `moduleDetailPath(module, id)`，被 `Header.vue:26/275`、`notification/Index.vue:12/141`、`components/ApprovalTodoList.vue:55/117` 共用。新增模块的详情路由**只改这里**。

### 6.4 三个真实例子的解析结果

| 工单字符串 | 解析 | 落点 |
| --- | --- | --- |
| `客户投诉管理-投诉列表-投诉详情` | 模块=complaint、二级=投诉列表、三级=详情 | `views/complaint/ComplaintList.vue` + `ComplaintDetail.vue`；后端 `ComplaintController`/`ComplaintServiceImpl`（见 §7 样板行） |
| `工作台-项目列表/最近问题` | 模块=dashboard；「最近问题」= 卡片；「项目列表」**已不存在** | `views/dashboard/Index.vue:554-576`（最近问题表格）、`:656-700`（「项目·人员」卡片，注释明确写「合并原『项目列表』与『部门-人员-问题详情』」）；数据 `api/dashboard.ts` + `DashboardController` |
| `项目技术支持-上门服务` | 模块=project-group 分组壳；二级=上门服务 | `views/service/ServiceList.vue`；后端 `ServiceOrderController`/`ServiceOrderServiceImpl` |

> ⚠️ `工作台-项目列表` 是**过期标签**：`dashboard/Index.vue:656` 注释「合并原「项目列表」与「部门-人员-问题详情」」。agent 看到「项目列表」应落到 `dashboard/Index.vue` 的「项目 · 人员」卡片，**不要**去找 `project/ProjectList.vue`（那是另一个菜单「项目进度」）。

---

## 7. 后端命名约定与每模块文件簇

### 7.1 约定（照抄即可定位邻居文件）

| 层 | 包/目录 | 命名 | 例（投诉） |
| --- | --- | --- | --- |
| Controller | `pms-server/src/main/java/com/company/pms/controller/` | `XxxController.java`，`@RequestMapping("/api/<模块>")`，`@Tag(name="中文名")` | `ComplaintController.java:24` `/api/complaint`、`:26` `@Tag(name="客诉管理")` |
| Service 接口 | `.../service/` | `XxxService.java` | `ComplaintService.java` |
| Service 实现 | `.../service/impl/` | `XxxServiceImpl.java`，`@Service` + `extends ServiceImpl<XxxMapper, Xxx>` | `ComplaintServiceImpl.java:77` `@Service`、`:79` class 声明 |
| Entity | `.../entity/` | `PmsXxx.java`，`@TableName("pms_xxx")`，`extends BaseEntity` | `PmsComplaint.java:19` `@TableName("pms_complaint")` |
| Mapper | `.../mapper/` | `PmsXxxMapper.java`，`@Mapper interface ... extends BaseMapper<PmsXxx>` | `PmsComplaintMapper.java:7-9` |
| Mapper XML | `pms-server/src/main/resources/mapper/` | 仅 5 个：`PmsProjectMapper.xml`、`PmsProjectMemberMapper.xml`、`SysPermissionMapper.xml`、`SysRoleMapper.xml`、`SysUserMapper.xml`（其余全用 MyBatis-Plus 注解/链式） | — |
| DTO / VO | `.../dto/`、`.../vo/` | `XxxDTO` / `XxxVO` | `dto/ComplaintDTO.java`、`vo/ComplaintVO.java` |
| 表 DDL | `sql/pms-init.sql`（全新建库）/ `sql/migration/V*.sql`（增量） | `pms_xxx` | `sql/pms-init.sql:330` `pms_complaint` |
| 系统表 | `sql/sys-init.sql` | `sys_*` | `sys_permission` L153+、`sys_config` L117-124 |

- 命名不是 `Pms*` 的只有：`BaseEntity` 和系统表实体 `Sys*`（`SysUser`/`SysRole`/`SysPermission`/`SysDept`/`SysConfig`/`SysOperationLog`/`SysLoginLog`/`SysRolePermission`/`SysRoleDataScope`/`SysUserRole`）。
- 表名 = 实体名 snake_case（`PmsSampleTest` → `pms_sample_test`；注意 DDL 在 `sql/pms-init.sql:777`，不在 300 行附近）。

### 7.2 每模块文件簇一览

| 模块 | Controller | Service / Impl | Entity 群 | Mapper 群 | 主表 |
| --- | --- | --- | --- | --- | --- |
| 客户投诉 | `ComplaintController` | `ComplaintService` / `ComplaintServiceImpl`(2208 行) | `PmsComplaint` +File +Product +Step | 4 | `pms_complaint`(`sql/pms-init.sql:330`) |
| 上门服务 | `ServiceOrderController` | `ServiceOrderService` / `ServiceOrderServiceImpl`(2097) | `PmsServiceOrder` +Log +TripLog | 3 | `pms_service_order`(`:547`) |
| 生产技术支持 | `ProductionIssueController` + `ProductionIssueDelayApplyController` | `ProductionIssueService` / `…Impl`(1552) | `PmsProductionIssue` +Dept +Log +Progress +DelayApply | 5 | `pms_production_issue`(`:272`) |
| 问题管理（日常工作） | `PmsTaskController` + `PmsTaskCommentController` + `PmsTaskProcessController` + `PmsTaskDependencyController` + `PmsTaskDelayApplyController` | `PmsTaskService`(+4 子服务) / `PmsTaskServiceImpl`(1450) + `TaskAccessGuard` | `PmsTask` +Comment +DelayApply +Dependency +Follow +Process +Product +Tag | 8 | `pms_task`(`:97`) |
| 项目进度 | `PmsProjectController` + `PmsProjectWeekSummaryController` | `PmsProjectService`/`…Impl`(1135) + `PmsProjectWeekSummaryService` | `PmsProject` +Follow +Member +Pin +Product +WeekSummary(+Comment,Qty) | 9 | `pms_project`(`:7`) |
| 产品测试 | `ProductTestController` | `PmsProductTestService`/`…Impl`(750) | `PmsProductTest` +Step | 2 | `pms_product_test`(`:46`) |
| 首样测试 | `ProductSampleTestController` | `PmsProductSampleTestService`/`…Impl`(1061) | `PmsSampleTest` +Record | 2 | `pms_sample_test`(`:777`) |
| 产品方案配置 | `OpportunityController` | `OpportunityService`/`…Impl`(2502) | `PmsOpportunity` +Followup +Product +Project | 4 | `pms_opportunity`(`:415`) |
| 工作台 | `DashboardController` | `DashboardServiceImpl`(879)，无接口 | — | — | 聚合查询 |
| 登录 | `AuthController` | `AuthService`/`AuthServiceImpl` | `SysUser` | `SysUserMapper` | `sys_user`(`sql/sys-init.sql`) |
| 小程序聚合 | `mp/controller/Mp*Controller`（11 个，`/api/mp/**`） | `mp/service/Mp*Service` + impl | 复用业务实体 | 复用 | — |

- 审批引擎（4 个模块共用）：`service/approval/{ApprovalEngine,ApprovalAccessGuard,ApprovalEngineAdapter,NodeAssigneeResolver}` + `impl/`；配置表 `pms_approval_config`(`sql/pms-init.sql:643`)，种子 L694+
- 只被引擎管理的模块：`SysWorkflowServiceImpl.java:61-66` `ALLOWED_MODULES = {service_order, opportunity, production_issue, product_sample_test}` —— **投诉不走审批引擎**（`docs/SYSTEM_FLOW.md`、`scripts/check-consistency.mjs` 的 INFO 均确认），别去动 `pms_approval_config`。

---

## 8. 权限码：命名、定义、校验

### 8.1 命名

- 二级：`模块:动作` —— `complaint:list`、`service:approve_tech_lead`、`product_test:delete`
- 三级（子域）：`模块:子域:动作` —— `service:tripLog:delete`、`project:file:upload`
- 依据：`AGENTS.md:652-678`（「权限标识规范」）；禁止按 ID 区间规划权限（ID 是自增）。

### 8.2 定义处（**四处，缺一不可**）

| # | 位置 | 作用 |
| --- | --- | --- |
| 1 | `sql/migration/V*.sql`：`INSERT INTO sys_permission` + 给原持有同类权限的角色补 `sys_role_permission` | 运行时权限数据 |
| 2 | `sql/sys-init.sql` 的 `sys_permission` 快照（L153-262 等） | 全新建库时的种子 |
| 3 | `SysPermissionController.PAGE_TREE`（L69-145）的叶子列表 | 「角色管理→配置权限」树里能勾出来 |
| 4 | 后端 `@PreAuthorize` + 前端 `v-permission` / 路由 `meta.permission` | 真正的闸门 |

> 原话（`AGENTS.md:185`）：「新增菜单/按钮必须『四联改』：路由 `meta.permission`、`ALL_MENU_CONFIGS`（及后端权限树归组）、`v-permission` 指令、后端 `@PreAuthorize`，并补 `pms-init.sql` 权限种子与角色授权。」
> 另一处自检清单（`AGENTS.md:792`）：「新增权限/字段：**迁移脚本 + init 快照 + `PAGE_TREE` + `@PreAuthorize`** 四处都改了。」

### 8.3 校验

- 后端：`@PreAuthorize("hasAuthority('complaint:list')")`（`pms-server/src/main/java` 下 `@PreAuthorize` 共 **345** 处，分布 62 个文件；`scripts/check-consistency.mjs` 统计的「后端 360 个引用点」是权限键引用数，略多于注解数）。变体：
  - `hasAnyAuthority(...)`：状态流转这类「多个动作共用一个接口」，如 `ComplaintController.java:78-86`（start/submit_verify/close/reject/cancel/reopen/edit 任一）。
  - `or hasRole('admin')`：导出等，如 `ComplaintController.java:125,135`。
  - **SpEL 委派**：`@approvalAccessGuard.canApproveAsCurrentAssignee('service_order', #id)`（`ServiceOrderController.java:85,92,99,106` 等）、`@serviceOrderServiceImpl.isApplicant(#id, ...)`（`:168`）、`@taskServiceImpl.canDeleteTask(#id)`（`PmsTaskController.java:97`）。
  - 业务端点**禁止**用 `isAuthenticated()` 兜底（`AGENTS.md:427-472`），只允许下拉框等轻量接口。
- 前端：
  - 路由闸门 `router/index.ts:353-369`（`meta.permission` 与 `userStore.userInfo.permissions` 比对，admin/`*` 直通）。
  - 按钮闸门 `v-permission`：`pms-web/src/directives/permission.ts:4-39`（`hide()` 只设 `display:none` 不摘 DOM，注释 L31-32 解释是为了避免 `insertBefore` 报错）；全局注册在 `main.ts:28`。
  - 组合式 API `usePermission()`：`pms-web/src/utils/permission.ts:15-24`（`isAdmin` = 角色含 `admin` 或权限含 `*`；数组 = `some`）。
  - 规则：**只用 `v-permission`，不要 `v-if + hasPermission`**（`AGENTS.md:742-763`）；`meta.permission` 必须等于后端权限键（`AGENTS.md:766-781`）。

### 8.4 「改一个模块要动权限码吗？」

- 只改文案/样式/查询条件 → **不用**。
- 改已有按钮的可见性 → 不必新增键，改 `v-permission` 引用的键即可（但要确认该键已在 SQL 里）。
- 新增按钮/页面/接口 → **必须**按 §8.2 四处都动，否则会出现「树上勾不出来」「勾了也没用」「点得到但 403」。
- 只改显示名（菜单改名）→ 动 `SysPermissionController.GROUP_LABELS`（一级分组，无 DB 列）+ `sys_permission.perm_name`（二级页面，走 migration，参考 `V2.49.sql`）+ `Sidebar.vue` / `ALL_MENU_CONFIGS` 的 label。

---

## 9. 构建与测试命令

| 场景 | 命令（Git-bash） | 端口 | 说明 / 耗时 |
| --- | --- | --- | --- |
| 前端开发 | `cd /d/WorkSpace/mgiot-pms/pms-web && npm run dev` | 3000 | `vite.config.ts:14-16` `host 0.0.0.0 port 3000`；L17-31 代理 `/api`、`/avatar`、`/uploads` → `http://127.0.0.1:8010` |
| 前端验证（**唯一自动化门禁**） | `cd /d/WorkSpace/mgiot-pms/pms-web && npm run build` | — | `package.json` scripts：`build = vue-tsc -b && vite build`；没有 lint/单测（`AGENTS.md:11-19`）。冷启动含类型检查通常 1–2 分钟量级，热 `node_modules` 后 30–60s；**本会话未实测，按 `pms-web/dist` 产物时间戳推断可构建** |
| 后端开发 | `cd /d/WorkSpace/mgiot-pms/pms-server && mvn spring-boot:run` | **8010**（不是 8080） | `application.yml:2` `port: 8010`、`:4` `context-path: /` |
| 后端单测 | `cd /d/WorkSpace/mgiot-pms/pms-server && mvn -o test` | — | JUnit5 + Mockito，**无 Spring 上下文、不连库**；`AGENTS.md:21-31` 称「17 类 155 例」，但同段注明 2026-10-27 实测 **23 类 / 181 例**，以实际输出为准。单类耗时 0.003–1.574s（`target/surefire-reports`），整体数十秒量级（`~/.m2` 已热） |
| 后端打包（CI 口径） | `cd /d/WorkSpace/mgiot-pms/pms-server && mvn clean package -DskipTests` | — | `AGENTS.md:21-31` |
| **静态一致性检查（推荐）** | `cd /d/WorkSpace/mgiot-pms && node scripts/check-consistency.mjs` | — | 零依赖、不连库，交叉校验 `@PreAuthorize` / `meta.permission` / `v-permission` / `PAGE_TREE` / `sys-init.sql` 快照 + `pms_approval_config` 引用；exit 0=无 ERROR，1=有 ERROR。**本次实跑结果：权限键 136，引用点 后端 360/路由或侧边栏 91/v-permission 88/权限树 90，审批配置 30 节点 5 模块，0 ERROR 0 WARN** |
| 小程序（微信） | `cd /d/WorkSpace/mgiot-pms/pms-miniapp && npm run dev:mp-weixin` / `npm run build:mp-weixin` | — | `package.json` scripts；产物需用微信开发者工具打开 |
| 小程序（H5 预览） | `cd /d/WorkSpace/mgiot-pms/pms-miniapp && npm run dev:h5` | 3100 | `vite.config.ts:61-72` `port:3100`，代理仅 `/api/mp` → `:8010` |
| 小程序类型检查 | `cd /d/WorkSpace/mgiot-pms/pms-miniapp && npm run type-check` | — | `vue-tsc --noEmit` |
| 起依赖（MySQL/Redis） | `cd /d/WorkSpace/mgiot-pms && docker compose up -d mysql redis` | 3306 / 6379 | `docker-compose.yml`；只有 `sys-init.sql`、`pms-init.sql` 会自动导入，`migration/` 需手动跑（注释 L23） |

本机已装：node v22.22.0、npm 10.2.3、Maven 3.9.6、Java 17.0.11（GraalVM）。`pms-web/node_modules`、`pms-web/dist`、`pms-miniapp/node_modules`、`pms-server/target/pms-server.jar` 均已存在，可直接增量构建。

> ⚠️ 后端默认数据源指向**远端开发库** `jdbc:mysql://10.7.0.185:3306/pms_db`（`application.yml:14`），不是本地 docker。要本地跑需覆盖 `SPRING_DATASOURCE_URL`。工作区里该文件已被本地改动（dirty），看到的值可能与本表不同。

---

## 10. 样板行：`客户投诉管理 - 投诉列表 - 投诉详情` 的完整文件清单

### 10.1 前端

| 角色 | 路径 | 关键行 |
| --- | --- | --- |
| 路由 | `pms-web/src/router/index.ts` | `134-137` 列表、`140-143` 详情（hidden）、`146-149` 报表 |
| 侧边栏 | `pms-web/src/layouts/components/Sidebar.vue` | `103-113` 分组（`permission` L108）、`110-111` 两个子项 |
| 菜单配置 | `pms-web/src/stores/menuConfig.ts` | `64-69`（合并顺序/隐藏判定） |
| 面包屑 | `pms-web/src/layouts/AppLayout.vue` | `122-130`（`/complaint/<id>` → 客户投诉管理/投诉详情） |
| 列表页 | `pms-web/src/views/complaint/ComplaintList.vue`（1088 行） | `30-31` 引入 layout+detail、`536` layout、`660-671` `#detail`、`541/544/547/551/574` `v-permission` |
| 详情页 | `pms-web/src/views/complaint/ComplaintDetail.vue`（2666 行） | `66` props、`71` id 解析、`323/538` 拉详情、`1254` 非嵌入头部、`1454` 处理日志、`1604` 附件、`1557-1591` 动作按钮权限 |
| 布局组件 | `pms-web/src/components/MasterDetailLayout.vue` | `12-22` props、`73/80` slot |
| API | `pms-web/src/api/complaint.ts`（124 行） | 20 个导出，见 `4,9,14,19,24,29,39,48,53,58,63,73,78,83,93,98,103,108,113,122` |
| 常量/枚举 | `pms-web/src/constants/complaint.ts`（72 行） | `2` 状态、`11` 来源、`18` 满意度、`25` 责任定性、`62` 缺陷模式 |
| 报表页 | `pms-web/src/views/complaint/ComplaintReport.vue`（501 行） | 独立路由 `/complaint/report` |
| 深链映射 | `pms-web/src/utils/module.ts` | `12` `complaint: '/complaint/{id}'` |

### 10.2 后端

| 角色 | 路径 | 关键行 |
| --- | --- | --- |
| Controller | `pms-server/src/main/java/com/company/pms/controller/ComplaintController.java`（199 行） | `24` `/api/complaint`、`26` `@Tag`；端点 `33/40/47/54/61/69/80/90/103/110/118/125/135/142/151/158/173/181/188` |
| Service 接口 | `.../service/ComplaintService.java`（44 行） | — |
| Service 实现 | `.../service/impl/ComplaintServiceImpl.java`（2208 行） | `127` create、`174` list、`213` getDetail、`277` update、`351` delete、`401` assign、`472` updateStatus（`481` 流转校验、`484` 质量反馈函、`489-499` 关闭前置、`643` `validateStatusTransition`）、`699` addStep、`803` getSteps、`841` 导入、`1096` 导出、`1353` 统计、`1475` 质量反馈函上传、`1732` `buildDataScopeWrapper()` |
| Entity | `.../entity/PmsComplaint.java` + `PmsComplaintFile` / `PmsComplaintProduct` / `PmsComplaintStep` | `PmsComplaint.java:19` `@TableName("pms_complaint")` |
| Mapper | `.../mapper/PmsComplaintMapper.java` + 3 个兄弟 | `7-9` |
| DTO / VO | `.../dto/ComplaintDTO.java`、`.../vo/{ComplaintVO,ComplaintStepVO,ComplaintSummaryVO,ComplaintReportItemVO}.java` | — |
| 数据权限 | `common/annotation/DataScope.java`、`common/interceptor/DataScopeInterceptor.java`、`common/utils/{DataScopeResolver,SecurityUtils}.java` | Service 层手写：`ComplaintServiceImpl:1732` |
| 表结构 | `sql/pms-init.sql` | `330` `pms_complaint`、`382` `pms_complaint_file`、`391` `pms_complaint_product`、`403` `pms_complaint_step` |
| 权限种子 | `sql/sys-init.sql` | `194-198`（complaint 节点+4 动作）、`231`（分组）、`248-256`（assign…report 9 个） |
| 权限树 | `SysPermissionController.java` | `121-126` |
| 小程序 | `pms-miniapp/src/pages/records/{index,detail}.vue`（`module=complaint`）+ `mp/controller/MpRecordController`、`mp/service/MpRecordService` | `records/index.vue:132-134`；`constants/approval.ts:12-18` |

### 10.3 一条命令验证这一行改对了

```bash
cd /d/WorkSpace/mgiot-pms
node scripts/check-consistency.mjs          # 权限/审批配置零 ERROR
cd pms-web && npm run build                 # 前端类型 + 构建
cd ../pms-server && mvn -o test             # 后端单测
# 起后端打接口（需可用 DB）
mvn spring-boot:run                          # :8010
curl -b cookie.txt http://127.0.0.1:8010/api/complaint?page=1&size=10
```

---

## 11. 不确定 / 未找到

1. **`工作台-项目列表` 的「项目列表」已不存在**：`dashboard/Index.vue:656` 注释说被合并进「项目 · 人员」卡片。工单里出现该字样时按 §6.4 落到 dashboard，但**无法 100% 确认用户指的就是这块卡片**（也可能指菜单「项目进度」）。
2. **`项目技术支持` 单出现时歧义**：它是分组壳（6 个模块）。若「操作流程」只有这一段，agent 必须回问或按 6 个模块全量搜一遍。
3. **构建耗时未实测**：本会话只读，没有跑 `npm run build` / `mvn -o test`（避免写 `target/`、`dist/`）。表中耗时是按 surefire 单类耗时与产物时间戳推断的量级，不是实测值。
4. **后端默认连远端库**（`application.yml:14` 指向 `10.7.0.185`），本地起服务能否连通未验证；且该文件在本机已被改动（git dirty）。
5. **`docs/SYSTEM_FLOW.md:60-95` 的菜单树已过期**（旧名、`/template` 路由已删、文件管理/工时统计权限写错）。该文档**不能**作为映射依据，只能作为背景。
6. **未找到**：任何 `sys_menu` 表 / 菜单 DDL（`sql/**` 零命中）——菜单确实没有数据库来源。
7. **未找到**：`pms-web` 的 lint / 单测配置（`package.json` 无 lint、test 脚本；无 eslint/prettier 配置引用）。前端唯一自动化验证就是 `npm run build`。
8. `工作台` 卡片「最近问题」的数据字段名未逐一核对（只用到了 `recentTasks`，`dashboard/Index.vue:44,231`）；具体列定义在 `taskColumns` 里，未展开。
