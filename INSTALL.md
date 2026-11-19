# 安装 ticket-pipeline

这份文档写给**拿到插件包的人**（不是写代码的人）。改插件代码看 [插件开发文档](plugins/ticket-pipeline/README.md)。

先说三件会让人以为「装坏了」的事：

- 装完**必须完全退出 DSH 再启动**。刷新页面不算 —— 桌面包由 Electron 独占管理，插件在启动时加载。
- 总开关 `enabled` **缺省是 `false`**。装完不会自己开始跑，这是故意的：先把凭据和项目配好。
- 插件**不改你的仓库**。缺省交付形态是在工作区检出里做一次**本地提交**，不 push、不开 MR。

---

## 一、你拿到的是什么

有三种形态，装法各差一点点，本文三条都写。

| 形态 | 长相 | 适合 |
|---|---|---|
| **tgz 包**（推荐给不走 GitHub 的人） | 一个 `local-ticket-pipeline-0.1.0-test.1.tgz`，约 536 KB（文件名里的版本号以你手上那个为准） | 微信/飞书直接发文件 |
| **GitHub 直装**（推荐给能上 GitHub 的人） | 仓库地址 + 一个分支名 | 不想 clone、想一直跟着作者更新 |
| **整个仓库** | 一个目录，里面有 `plugins/ticket-pipeline/` | 你要读源码、要改插件本身 |

tgz 里是**插件本体 60 个文件**。整仓形态下你要指向的 `plugins/ticket-pipeline/` 除了那 60 个，还多一个 `scripts/`（作者的自测脚本），装的时候不参与。

tgz 里**不含**任何配置或凭据。

插件是**自包含**的：没有 `dependencies`，装的时候不需要联网、不需要 `npm install`。

> 我这份文档里的路径、版本号都是示例，照抄时换成你手上那个文件的真实路径。
> `INSTALL.md` 只在仓库里有，**tgz 里没有**（它不在打包白名单里）—— 所以如果你是收的人，
> 这份文档得单独发给你；如果你是自己打包发人，记得连这份说明一起发。

---

## 二、装（三选一）

### A. 拿到 tgz

**不用解压**，直接存到一个你找得到的地方，例如 `D:\dsh-plugins\local-ticket-pipeline-0.1.0-test.1.tgz`。
然后打开 PowerShell，执行：

```powershell
dsh.cmd plugin --profile desktop add "file:D:\dsh-plugins\local-ticket-pipeline-0.1.0-test.1.tgz"
```

（tgz 是压缩包，但 pnpm 自己会解，你不用动它。路径里有中文或空格也行 —— 前提是整段用双引号包住。）

### B. 拿到整个仓库

先 clone 到本地，然后指向仓库里的插件目录（不是仓库根）：

```powershell
git clone https://github.com/Mentality486/dsh-ticket-pipeline.git D:\dsh-ticket-pipeline
dsh.cmd plugin --profile desktop add "file:D:\dsh-ticket-pipeline\plugins\ticket-pipeline"
```

> **clone 完确认一下有没有 `plugins\ticket-pipeline` 这个目录。** 默认分支 `main` 现在是有内容的（`main` 与
> `v0.0.1` 指向同一个提交），正常 clone 下来就有。如果没有，说明默认分支被改到了别的分支上 ——
> 那就显式指定：`git clone -b v0.0.1 <地址> D:\dsh-ticket-pipeline`，或者干脆用 tgz（路 A）。

仓库里除了插件本体（`plugins/ticket-pipeline/`），还有作者的设计文档（`docs/`）和自测脚本。装插件只用前面那个目录。

> **注意 `file:` 后面是绝对路径**，`~`、相对路径、引号里带 `%` 都会让 pnpm 解析错。
> 路径里有空格时必须用双引号包住整段（中文路径也能装，作者实测过）。

### C. 直接从 GitHub 装（不 clone，一条命令）

仓库是公开的，不用 GitHub 账号，也不用配 ssh key。装这一条：

```powershell
dsh.cmd --% plugin --profile desktop add "github:Mentality486/dsh-ticket-pipeline#v0.0.1&path:/plugins/ticket-pipeline"
```

看到下面这样就算成了（约 1～2 分钟，pnpm 要下 4 MB 左右的 tarball）：

```
+ @local/ticket-pipeline 0.1.0-test.1
Done in 1m 33.5s using pnpm v11.28.5
```

这条命令有两个**不能省**的地方，省了必然报 `ERR_PNPM_INVALID_DEPENDENCY_NAME ... invalid alias "dsh-ticket-pipeline#v0.0.1"`：

| 不能省 | 为什么 |
|---|---|
| **`--%`** | 它是 PowerShell 的「后面别解析」开关。没有它，`&` 会被当成命令分隔符，spec 在传给 pnpm 之前就被截断了。用变量包、用反引号转义、在 cmd 里用 `^&` 都不稳，`--%` 是唯一可靠的写法。 |
| **`&path:/plugins/ticket-pipeline`** | 仓库根目录没有 `package.json`，pnpm 默认只认仓库根，于是把 `#v0.0.1` 当成包名的一部分。带 `path:` 它才会进子目录找包。 |

更新：作者推了新提交之后，**把同一条命令再跑一次就行** —— 实测过，同样 spec 再 `add` 会装到新内容（这点和 tgz 不同，tgz 同版本号重装不生效）。

> 想装别的分支或 tag，把 `#v0.0.1` 换掉即可，例如 `#main`、`#v0.0.2`。
> 这条命令在你的终端里跑，走的是 https（`codeload.github.com`），不需要 ssh 权限。

### 命令里那个 `dsh.cmd` 在哪

如果你已经把 DSH 加进 PATH，直接用 `dsh` 就行。不知道装在哪，先找一下：

```powershell
Get-Command dsh.cmd
```

它会打印完整路径，例如作者的机器上是 `D:\ProgramFiles\deepseekharness\resources\runtime\cli\bin\dsh.cmd`。
找不到就按「deepseekharness」在磁盘上搜一下，或者从开始菜单右键 DSH 图标 →「打开文件所在位置」往上翻到 `resources\runtime\cli\bin\`。

### 看到什么算成功

```
dependencies:
+ @local/ticket-pipeline 0.1.0-test.1
Done in 542ms using pnpm v11.28.5
```

然后**完全退出 DSH 再启动**（托盘图标右键退出，不是关窗口）。
重启后在**设置**里应该能看到一栏「**工单流水线**」（设置 → 插件 → 工单流水线那个页签也在，两处是同一个面板）。
点进去有五个页签：运行 / 项目 / 参数 / 凭据 / 体检。

---

## 三、装完配什么（不配不会跑）

1. **打开总开关**：设置 → 工单流水线 → **参数**页签，最上面那条「总开关」是关着的，打开它。
   在此之前插件不会扫表、不会建工作区、不会提交（运行页会明确写着「总开关是关的」）。
2. **凭据页**填 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`。这两个是你在飞书开放平台建自建应用拿到的。
3. **飞书那边还要做两步人工动作**（插件替你做不了）：
   - 权限里开 `bitable:app`（读写）或电子表格 `sheets:spreadsheet`（读写，**不是** `:readonly`），然后**创建版本并发布** —— 不发布不生效；
   - 在表格右上「… → 更多 → 添加文档应用」把应用加成**可编辑**协作者。插件用的是 `tenant_access_token`，没法自己给自己授权。
4. **项目页**加一个项目：贴工单表链接 + 填本地 git 检出路径。字段逐个解释见 [配置项参考](docs/ticket-pipeline/reference/config.md)。
5. 上手先别用真执行器：参数页把「执行器」选 `mock`、「通知适配器」也选 `mock`，跑一轮看流程对不对，再切 `agent` + 真通知。

**卡住了就跑体检**：设置 → 工单流水线 → 体检，或直接说一句「跑 pipeline_doctor」。
它会分三档告诉你：阻断（不修跑不了票）/ 必须修复（能跑但结果不对）/ 提醒，每条带具体修法。

---

## 四、更新

### 拿到**新 tgz** 的情况

**直接 `add` 新文件就行**，前提是新包的版本号变过：

```powershell
dsh.cmd plugin --profile desktop add "file:D:\dsh-plugins\local-ticket-pipeline-0.1.0-test.2.tgz"
```

会看到 `- @local/ticket-pipeline 0.1.0-test.1` / `+ @local/ticket-pipeline 0.1.0-test.2`，然后重启 DSH。

> ⚠️ **同版本号覆盖装不会生效。** 作者如果把内容改了但版本号没变，pnpm 会认为「已经是最新」，一个字节都不动（实测：`Already up to date`，文件没换）。
> 遇到这种情况，先 `remove` 再 `add`：
>
> ```powershell
> dsh.cmd plugin --profile desktop remove "@local/ticket-pipeline"
> dsh.cmd plugin --profile desktop add "file:D:\dsh-plugins\新包.tgz"
> ```

### 拿到**整个仓库**的情况

```powershell
cd D:\dsh-ticket-pipeline
git pull
```

但 **`git pull` 不会自动同步到 DSH 实际加载的那个副本** —— 安装目录 `~\.dsh\profiles\desktop\node_modules\@local\ticket-pipeline` 是普通目录（跨盘 `file:` 依赖落成复制），不是软链，`pnpm install` 也说 `Already up to date` 却不改内容。

所以拉完还要重新装一次：

```powershell
dsh.cmd plugin --profile desktop remove "@local/ticket-pipeline"
dsh.cmd plugin --profile desktop add "file:D:\dsh-ticket-pipeline\plugins\ticket-pipeline"
```

然后重启 DSH。

### 怎么确认装的是不是最新

两个办法：

- 设置 → 工单流水线 → 体检，看「插件版本」那一节。安装副本比源码旧会明确列出来；
- 或者问一句「跑 pipeline_doctor」。

---

## 五、卸载

```powershell
dsh.cmd plugin --profile desktop remove "@local/ticket-pipeline"
```

然后重启 DSH。这会摘掉插件，**不会**动你的工单表、不会回滚任何提交、不会删工作区目录。
插件自己的历史记录（哪些票跑过）留在 `~\.dsh\storages\ticket_pipeline.json`，要彻底清干净就手工删这个文件。

---

## 六、常见问题

**重启后设置里没有「工单流水线」**
先确认命令真的成功了（看有没有 `+ @local/ticket-pipeline`），再确认是**完全退出**而不是关窗口。都对了还不行，跑一次 `dsh.cmd plugin --profile desktop why "@local/ticket-pipeline"` —— 它会告诉你这个包是否真的被 profile 引用。

**体检说「安装副本比源码旧」**
你改的是源码目录、但 DSH 加载的是 profile 下的副本。按上面「更新」那一节 remove + add 一次。

**装完报「与 dsh 版本不兼容」**
那是**别的插件**的警告（比如 subagent 系列），和本插件无关。本插件没有声明 `engines`，跟着你装的 DSH 版本走。

**插件能装但面板空白**
打开开发者工具看有没有 `descriptor` 相关报错。最常见原因是装了一半就重启了 —— 重装一次。

**它会不会改乱我的仓库**
缺省只做本地提交，而且只在「项目里配的那个检出」里。要连本地提交都不要，就在参数页把「执行器」保持 `mock`。它不 push、不开 MR、不删行。
