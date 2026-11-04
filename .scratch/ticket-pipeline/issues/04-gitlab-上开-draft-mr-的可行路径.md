<!-- DSH-FORMAT: md-v1 -->
<!-- DSH-PARENT: 00 -->
<!-- DSH-LABELS: wayfinder:research -->
<!-- DSH-IDEMPOTENCY-KEY: deck-plan-ticket-pipeline-v1-child-gitlab-mr -->
<!-- DSH-CREATED: 2026-11-03T11:02:09.041Z -->
# 04: GitLab 上开 draft MR 的可行路径

Type: research

Status: resolved
## Question

`mgiot-pms` 所在的 GitLab（`http://gitlab.example.com`）能不能用 Project Access Token 或别的非交互方式创建分支并开 draft MR？需要哪些 scope、API 调用序列是什么、仓库有没有 protected branch 限制、有没有 CI 会跟着跑、失败时怎么诊断？

## Answer

**能，纯 REST API 就能开 draft MR。** 完整证据链见 `.scratch/ticket-pipeline/research/gitlab-mr.md`（558 行，每条结论标注【实测】/【源码】/【不可知】）。

要点：

1. **实例**：`http://gitlab.example.com`（10.7.0.185）可达，**只能 HTTP**；版本 **16.9.6 CE**（`GET /api/v4/metadata`）。
2. **凭据**：Windows 凭据管理器 `git:http://gitlab.example.com` 是 **PAT**（user `wangchong`，掩码 `glpa…_yqD`），scope 含 **`api`**，到期 **2027-03-13**。但沙箱禁止任何需要 pipe 的子进程，插件应改走 `ctx.credentials` + in-process `fetch`，**不要** P/Invoke `CredReadW`。
3. **draft 只有一种写法**：`title: "Draft: …"`。实测 `draft=true` 参数被静默忽略（201 但 `draft:false`），`wip_event=draft` 直接 400。
4. **调用序列**：`GET /projects/mk%2Fend%2Fmgiot-pms`（斜杠必须编码）→ `POST /projects/28/repository/branches` → `POST /projects/28/merge_requests`。
5. **两个坑**：`source_branch` 不存在也返回 201（必须先 `GET /repository/branches/:branch`）；重复 MR 返回 **409**（文案是中文，只能按状态码判断）。
6. **`git push` 在本机不可能成功**（沙箱 fork/pipe 被拒，连本地裸仓库都失败）→ push option 那条路只能交给人；插件内替代方案是 Commits API + `start_branch`。
7. **protected branch**：只有 `main` 一条规则（push/merge 限 Maintainer 40+）；**CI 不会跟着 MR 跑**（`only: [v2.x]`，且 `main` 无 `.gitlab-ci.yml`）；默认分支是 **`main`**。
8. **待人拍板**：`main` 与 `v2.x` 差 504 commit / 918 文件，从 `v2.x` 切分支 target `main` 会是巨型 diff。建议 `ref=v2.x` + `target_branch=v2.x`，但这属于流程决策。
9. **需人提供**：一个专用 token（现 token 是 IDEA 插件建的，复用有连带影响）；以及 MR 目标分支的结论。

research 收口：纯 REST API 可开 draft MR（GitLab 16.9.6 CE），draft 只能用 title 前缀 `Draft:`；但本机沙箱物理封死 git push，必须改用 Commits API。目标分支需人拍板。未开 PR（research 票规则）。

## Comments

### local — 2026-11-03T11:36:57.842Z
## Resolution（research 完成）

报告：`.scratch/ticket-pipeline/research/gitlab-mr.md`（558 行，每条结论标【实测】/【源码】/【不可知】）。

### 一分钟版

| 问题 | 答案 | 置信度 |
|---|---|---|
| 实例能访问吗 | 能，**只能 HTTP**。`http://gitlab.example.com` → 10.7.0.185:80。HTTPS 在本机 schannel/SSL 双失败 | 【实测】 |
| 版本 | **GitLab 16.9.6 Community Edition**（`enterprise:false`） | 【实测】`GET /api/v4/metadata` |
| 凭据 | Windows 凭据管理器里有 `git:http://gitlab.example.com`，用户 `wangchong`，PAT（`glpat-…` 26 字符，掩码 `glpa…_yqD`），scope 含 **`api`**，到期 **2027-03-13**。是 IntelliJ 插件建的 —— 复用它会影响那台机器，建议另建专用 token | 【实测】 |
| 能开 MR 吗 | **能，纯 REST API**。已在真项目上建过 6 条探测 MR（iid 2–7）并全部 DELETE 复原 | 【实测】 |
| 能 push 吗 | **不能**。本机沙箱物理封死：`error: cannot create standard input pipe for git-receive-pack: Permission denied` + `fatal: unable to fork`，连本地裸仓库都失败，与网络/凭据无关 | 【实测】 |
| protected branch | **只有 `main`**：push/merge 限 Maintainers(40)+、`allow_force_push:false`。`master`/`v2.x` 不保护。当前用户 Owner(50) | 【实测】 |
| CI 跟着 MR 跑吗 | **不会**。`v2.x` 的 `.gitlab-ci.yml` 只有 `only: [v2.x]` 一个 deploy job；`main` 上**没有**该文件 | 【实测】 |
| 默认分支 | **`main`**（不是 `master`，也不是 `v2.x`） | 【实测】 |

### 最短可用序列（已实测）

```
GET  /api/v4/projects/mk%2Fend%2Fmgiot-pms      → id=28, default_branch=main
     （斜杠必须 encodeURIComponent 成 %2F，否则 404）
POST /api/v4/projects/28/repository/branches    {branch:"feat/x", ref:"v2.x"}
POST /api/v4/projects/28/merge_requests         {source_branch:"feat/x", target_branch:"v2.x",
                                                 title:"Draft: <标题>", description:"…"}
```

**draft 只能用标题前缀 `Draft:`**。实测：`draft=true` 参数被**静默忽略**（201 但 `draft:false`）；`wip_event=draft` 直接 400（参数未声明）；`Draft:` 前缀 → 201 且 `"draft":true`。创建后必须断言 `resp.draft === true`。

### 两个坑

1. **`source_branch` 不存在也会返回 201**（iid 3/4 就是这么建出来的，已删）。开 MR 前必须先 `GET /repository/branches/:branch` 确认。
2. **16.9.6 上列表过滤 `?draft=` 是空操作，`?wip=yes` 才生效**。不要用服务端过滤器判断 draft，直接看返回体 `"draft"` 字段。

### 关键替代：Commits API 物化改动

因为不能 push，插件的可行链路是：

```
本地 git diff → 对新增/修改/删除每个文件各生成一条 action（content 用 base64）
→ POST /projects/28/repository/commits {branch:"feat/x", start_branch:"v2.x", commit_message, actions[]}
→ POST /merge_requests 开 draft
```

`actions[]` 支持 `action: create|update|delete|move|chmod`、`encoding: text|base64`、`last_commit_id` 乐观锁。实测该端点确实按 branch 校验（`{"message":"You can only create or edit files when you are on a branch"}`）。

两条限制：① 这样产生的 commit **不是**本地那个 commit（SHA 不同、作者默认是 token 用户，可用 `author_name`/`author_email` 覆盖）；② 只适合按文件内容表达改动，二进制/超大文件/重命名要单独处理，**且提交前必须过滤 `pms-server/src/main/resources/application.yml` 这类含真实凭据的文件**（`AGENTS.md:822` 明令禁止提交）。

### ⚠️ 必须人拍板：MR 目标分支

```
compare main   → v2.x: 504 commits / 918 diffs
compare master → v2.x: 271 commits / 569 diffs
compare main   → master: 233 commits / 565 diffs

GET /projects/28/merge_requests?state=all →
  [{"iid":1,"title":"后端 API","state":"opened","source_branch":"v2.x","target_branch":"main",
    "created_at":"2026-08-07T06:41:13.396Z"}]
```

`main` 只是初始模板，真正的开发在 `v2.x`；已有一个 `v2.x→main` 的 MR !1 开了 3 个月没合。**从 `v2.x` 切分支、target `main`，每个 agent MR 都会是 900+ 文件的巨型 diff**，还会和 !1 完全重复。

建议 `ref=v2.x` + `target_branch=v2.x`（diff 只有自己的改动）；代价是「合并进 v2.x = 触发生产部署」，但 draft MR 本来就不会被自动合、合并由人做，与「绝不自动合并」的前提一致。**这条没替人决定。**

### 探测副作用（诚实记录）

为取证在真项目建过 6 条探测 MR（iid 2–7），全部 `DELETE` 复原；最终回读确认 `branches=[main,master,v2.x]`、`MRs=[(1,'opened','后端 API')]`，与探测前一致。未创建分支、未提交代码、未 push、未改 `.git` 配置、未动 `mgiot-pms` 工作区文件。

### 给插件实现的落点

1. **认证**：token 进 `ctx.credentials`（**不要读 Windows 凭据管理器** —— 沙箱禁止需要 stdin/stdout pipe 的子进程，`CredReadW` 只是取证手段）；启动时 `GET /metadata` 探活 + `GET /personal_access_tokens/self` 校验 scope/到期；HTTP 用 in-process `fetch`。
2. **项目解析**：`GET /projects/<encodeURIComponent(path)>`，缓存 `id` 与 `default_branch`（每次运行重读）。
3. **分支**：优先 `POST /repository/commits` + `start_branch`（一次调用建分支并写文件）；只建空分支才用 `POST /repository/branches`。
4. **重复检测**：先 `GET /merge_requests?source_branch=X&state=opened`，再创建；**409 当幂等信号**（只按状态码判断，文案是中文）。
5. **不 push、不读凭据管理器、CI 不参与判断**（目标分支无 CI，MR 不会有 pipeline，「验收」只能在人这边做）。

## 进度
