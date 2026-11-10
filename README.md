# 工单流水线插件（ticket-pipeline）

你在共享工单表里写一行问题，插件自动定位代码 → 改完 → 跑验证 → 在**工作区检出**里做一次本地提交
→ 回填表格 → 通知你。**人只做三件事**：填工单、收通知、review 那个提交。

## 30 秒装完

```bash
dsh.cmd plugin --profile desktop add "file:<本仓库>/plugins/ticket-pipeline"
```

装完**完全重启 DSH 宿主**（桌面包由 Electron 独占管理，刷新页面不算）。
总开关 `enabled` 缺省是 `false` —— 装完不会自己开始跑，这是故意的。

## 三个门槛（缺一样都跑不出第一张工单）

1. **飞书应用**：开放平台建企业自建应用，拿 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 填进设置页「凭据」。
2. **权限 + 发布**：开 `bitable:app`（**读写**，回填要写三列）。电子表格工单表则开
   `sheets:spreadsheet`（读写，不是 `:readonly`）。改完**必须创建版本并发布**，不发布不生效。
3. **协作者**：在表格右上「…→更多→**添加文档应用**」把应用加成**可编辑**协作者。
   插件用 `tenant_access_token`，没法自己给自己授权，这一步只能人做。

然后填一个 `projects[]`（工单表定位 + 本地 git 检出路径），先用 `workExecutor: mock` +
`pushAdapter: mock` 跑通半程，再切真执行。**工单表定位只需一步**：在项目卡片最上面的
「工单表链接」里把表格的浏览器地址整条贴进去，多维表格 / 电子表格 / 知识库里的表都行 ——
插件自己认表型，不用你分辨，也不用再填别的 token。

## 接下来读哪页

| 想干什么 | 去哪 |
|---|---|
| 从零跑通第一张工单 | [使用手册 · 快速开始](docs/ticket-pipeline/user-guide.md#快速开始) |
| 每天怎么用、通知怎么读、出问题怎么办 | [使用手册 · 日常循环](docs/ticket-pipeline/user-guide.md#日常循环) · [排障](docs/ticket-pipeline/user-guide.md#排障) |
| 某个配置键叫什么、缺省多少 | [配置项参考](docs/ticket-pipeline/reference/config.md) |
| 改插件代码、跑自测 | [插件开发文档](plugins/ticket-pipeline/README.md) |
| 实现细节、设计取舍 | [architecture.md](docs/ticket-pipeline/architecture.md) · [ADR](docs/adr/) · [术语表](GLOSSARY.md) |

## 使用前必须知道的三条

- **总开关缺省关**，配好一切再打开；否则你会以为插件坏了。
- **缺省只做本地提交，不 push、不开 MR**。要不要合进主干永远由人决定。
- **回填是唯一的写入口**，只写「是否处理 / 处理结果 / 处理日期」三列，不碰别的列、不删行。
  失败的工单缺省不回填 —— 留在「处理中」是刻意留给你的信号。
