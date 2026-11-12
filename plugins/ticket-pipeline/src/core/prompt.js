/**
 * `prompt.js` —— 把一张票渲染成给 agent 的初始消息。
 *
 * 为什么单独一个文件：prompt 是这套流水线里**唯一直接决定 agent 干活质量**的输入。
 * 它需要能被单独读、单独改、单独验，而不是埋在调度逻辑里。
 *
 * 通用化之后的三条硬性要求：
 * 1. 不内置任何项目的「模块 → 代码路径」别名表 —— 那是某个具体项目专属的知识，
 *    通用插件装不下，代码定位交给 executor-agent 现场读仓库做。
 * 2. 截图不是路径也不是 base64，是 `ImageBlock`，得由调用方塞进 `content` ——
 *    这件事现在由本文件的 `renderTicketContent` 承担：它把任务书渲染成 text 块，
 *    再按顺序把截图引用接成 image 块，调用方只需要拿着 `saveImage` 的返回值来找它。
 * 3. 验证命令**从项目配置 `verify` 注入**，不在 prompt 里硬编码任何构建/测试命令。
 */

import { PHASE_LABEL } from '../contracts/types.js'
import { BUILTIN_LIMITS } from './config.js'
import { describeMemory } from './ticket-memory.js'

/**
 * @typedef {import('../contracts/types.js').Ticket} Ticket
 * @typedef {import('../contracts/types.js').LocateResult} LocateResult
 * @typedef {import('../contracts/types.js').Plan} Plan
 */

/**
 * 项目配置里的验证命令（`projects[].verify`）。
 *
 * 只在渲染任务书时用来告诉 agent「改完跑这条命令」。**不在这里执行** ——
 * 执行是 `executor-agent` 的 `runVerification` 干的，两处引用同一份配置。
 *
 * @typedef {object} VerifyCommands
 * @property {string} [build]
 * @property {string} [test]
 */

/**
 * 把验证命令渲染成任务书里的一节。
 *
 * ## 为什么必须写进任务书
 *
 * 2026-11-11 那张跑通之前，任务书里只有一句「改完按项目配置里的验证命令跑验证」，
 * 但**从没告诉它命令是什么**。于是它自己摸索：跑了 12 次 `mvn` / `npm`，花掉 5.4 分钟
 * 构建了整个后端，而项目配置的 `verify.test` 其实是 `node scripts/check-consistency.mjs`
 * —— 一个纯静态的交叉引用检查，两秒跑完。执行器知道命令（`runVerification` 拿得到
 * `project.verify`），但 agent 不知道，两边信息不对等，多花的时间全是白烧的。
 *
 * ## 为什么空命令也要说一句
 *
 * 什么都不写的话，agent 会默认「应该有构建命令」而自己去找 `pom.xml` / `package.json`。
 * 明说「本项目没配验证命令」能省掉那轮猜测，也让它知道不必为了「跑点什么」而构建。
 *
 * @param {VerifyCommands | undefined} verify
 * @returns {string[]}
 */
function renderVerifySection (verify) {
  const build = typeof verify?.build === 'string' ? verify.build.trim() : ''
  const test = typeof verify?.test === 'string' ? verify.test.trim() : ''
  const lines = []
  lines.push('')
  lines.push('## 改完怎么验证')
  if (build === '' && test === '') {
    lines.push('本项目**没有配置验证命令** —— 改完不用为了「跑点什么」去构建整个工程。')
    lines.push('把改动读一遍确认逻辑正确即可；如果确实需要跑一个检查，只跑与这次改动直接相关的那一个。')
    return lines
  }
  lines.push('改完**直接跑下面这几条命令**，不要自己去找 `pom.xml` / `package.json` 猜构建方式：')
  if (build !== '') lines.push(`- 构建：\`${build}\``)
  if (test !== '') lines.push(`- 测试：\`${test}\``)
  lines.push('')
  lines.push('命令失败就把输出当线索去修；命令跑不起来（缺依赖、缺环境）就在最终说明里写清原因，')
  lines.push('**不要编造「已测试通过」**。')
  return lines
}

/**
 * 把「操作流程」那一列渲染成引导语。
 *
 * 这一列有两种形态，处理方式完全不同，所以必须先判断再决定说什么：
 * - **页面路径**（「项目管理 → 首样测试 → 点新增 → 提交报错」）：按它走就能定位到组件；
 * - **模块名**（「项目管理-首样测试」，9 个字）：它只是告诉你「问题在这个模块」，
 *   给不出任何「哪个页面、哪一步」的信息。
 *
 * 2026-11-11 那张票就是第二种形态，而当时任务书用整整一节要求它「按操作流程走」。
 * 它照着做，发现那一列没有可走的路径，只好回头 `grep 首样` 全仓搜（250+ 处命中）。
 * **话术与实际内容不匹配，比没有这句话更费时间** —— 所以要按长度分流。
 *
 * @param {string} flow
 * @returns {string[]}
 */
function renderFlowSection (flow) {
  const text = flow.trim()
  const lines = []
  lines.push('')
  lines.push('## 操作流程')
  lines.push(text)
  if (text.length >= 15) return lines
  lines.push('')
  lines.push(`（这一列只写了 ${text.length} 个字，是一个**模块名**，不是可走的页面路径。）`)
  lines.push('所以别指望从它推断出页面：直接走下一节的第二条路 —— 把**截图上看到的标题/按钮/表头/')
  lines.push('字段名/报错文案**和问题描述里的原话拿去 grep，再结合这个模块名收窄范围。')
  return lines
}

/**
 * 宿主的 `ImageBlock` 里那个 `attachment` 字段的契约（照抄
 * `@deepseek-ai/dsh-llm` 的 `ImageAttachmentRef`，宿主是 `attachmentId` 拼
 * `sha256:<64hex>` 的持久引用）。
 *
 * @typedef {object} ImageAttachmentRef
 * @property {string} attachmentId 形如 `sha256:<64 位十六进制>`
 * @property {string} mediaType 如 `image/png`
 * @property {number} bytes
 * @property {number} width
 * @property {number} height
 * @property {string} [name]
 * @property {{ width: number, height: number }} [originalDimensions] 被宿主降采样过才有
 */

/**
 * 把跨票记忆渲染成任务书的补充段。
 *
 * ## 为什么要有这一段
 *
 * 2026-11-11 那张跑通的票，**前 21.5 分钟（46 次工具调用）全花在定位上**：
 * 从「首样测试」四个字找到三个具体文件。这是可复用的知识，但下一张同模块的票
 * 一切从零 —— 同样的 grep、同样的 250+ 处命中、同样的路径猜错再 glob 找回。
 *
 * ## 措辞约束（比代码本身更重要）
 *
 * 记忆是**历史**，不是这次的事实。写成「改这几个文件」会把模型按在旧答案上，
 * 而同一模块的新问题完全可能在另一个文件里。所以三处都必须说清：
 * 「上次」+「可以从这里开始」+「不一定还是它们」。
 *
 * @param {Array<{ files?: string[], recordId?: string }>} memories
 * @returns {string[]}
 */
function renderMemorySection (memories) {
  if (!Array.isArray(memories) || memories.length === 0) return []
  const lines = keyLinesOf(memories)
  if (lines.length === 0) return []
  const out = []
  out.push('')
  out.push('## 这个项目里同类问题的历史')
  for (const line of lines) out.push(`- ${line}`)
  out.push('')
  out.push('**这些是历史，不是这次的事实。** 从这里开始找能省一大截定位时间，')
  out.push('但如果代码已经变了、或者这次的现象对不上，就按下一节的办法重新定位。')
  return out
}

/**
 * 逐条渲染记忆行（用 `describeMemory` 的措辞，保持一处定义）。
 * @param {Array<{ files?: string[], recordId?: string }>} memories
 * @returns {string[]}
 */
function keyLinesOf (memories) {
  const out = []
  for (const entry of memories) {
    const line = describeMemory(/** @type {any} */ (entry))
    if (line) out.push(line)
  }
  return out
}

/**
 * @param {Ticket} ticket
 * @param {LocateResult} located
 * @param {{ verify?: VerifyCommands, exploreBudget?: number, memories?: Array<{ files?: string[], recordId?: string }> }} [options]
 *   `verify` 是项目配置里的验证命令；`exploreBudget` 是探索预算（缺省取 `BUILTIN_LIMITS`）；
 *   `memories` 是同类问题的历史改动文件。三者都由调度器从项目配置/limits/记忆表里取，
 *   **渲染与执行同源**。
 * @returns {string}
 */
export function renderTicketPrompt (ticket, located, options = {}) {
  // 探索预算的数字来自配置，不再是硬编码的 12 —— 文案与看门狗用同一个数，
  // 否则又会重演「写着 12 次、实测 169 次」。
  const exploreBudget = Number(options.exploreBudget) > 0
    ? Number(options.exploreBudget)
    : BUILTIN_LIMITS.agentExploreBudget
  const lines = []
  lines.push('# 任务：修复一条工单')
  if (ticket.projectId) lines.push(`所属项目：${ticket.projectId}`)
  if (ticket.seq) lines.push(`工单序号：${ticket.seq}`)
  if (ticket.recordId) lines.push(`工单标识：${ticket.recordId}`)
  if (ticket.department) lines.push(`发现部门：${ticket.department}`)
  if (ticket.foundAt) lines.push(`发现日期：${ticket.foundAt}`)
  if (ticket.priority) lines.push(`优先级：${ticket.priority}`)
  if (ticket.targetProject) lines.push(`待修改项目（工单原文）：${ticket.targetProject}`)
  if (ticket.module) lines.push(`模块（工单原文）：${ticket.module}`)

  lines.push('')
  lines.push('## 问题描述')
  lines.push(ticket.description.trim() || '（空）')

  if (ticket.flow && ticket.flow.trim()) {
    lines.push(...renderFlowSection(ticket.flow))
  }

  lines.push('')
  lines.push('## 代码定位')
  lines.push('工单的「模块」「待修改项目」两列都是用户随手写的，可能与代码里的目录/路由名对不上，')
  lines.push('不要拿它们当目录名直接去改，也不要靠它们去猜目录结构。')
  lines.push('当前工作目录就是本工单对应的项目仓库 —— 下面一节给的是**怎么快速走到那个页面**，按它走。')

  // 「代码定位」「工作方式」这两节是 2026-11-11 两次真实事故的产物，别删：
  // 第一次：一张「改个小功能」的票，agent 花 39 分钟读了 23 个文件、写了 0 个文件，
  //   最后整票超时。复盘发现任务书里没有任何「探索预算」—— 它不知道读够多少就该动手。
  //   当时只加了预算，措辞是「超过就按你目前最好的判断改一版」。
  // 第二次（同日）：用户立刻指出这句话是错的 —— **流水线要的是把问题真正修好，
  //   不是交一版「大概是这儿」的改动**。预算的作用是「逼你瞄准」，不是「允许你交半成品」。
  // 所以这一节重写成：先给两条真正高效的定位路径（操作流程 ⇒ 页面 ⇒ 组件；
  //   截图里的字面量 ⇒ grep 源码），再讲预算 —— 并且把预算超支的出路从
  //   「随便改一版」改成「说明还缺哪条线索」。
  // 跨票记忆放在「定位」之前：它是最省时间的一条线索，先看到能省掉下面前两步。
  lines.push(...renderMemorySection(options.memories ?? []))

  lines.push('')
  lines.push('## 定位到具体页面：按「操作流程」走，别在全仓里漫游')
  lines.push('工单里的 **「操作流程」那一列就是用户走过的页面路径**（先点哪个菜单、再进哪个列表、最后在哪一步出错）。')
  lines.push('按它去找代码是最快的定位方式，比按关键词全仓搜索快一个数量级：')
  lines.push('1. 先从操作流程里框出**出问题的那个页面**（列表页 / 详情页 / 弹窗 / 某个按钮所在的表单）。')
  lines.push('2. 在源码里找这个页面对应的路由与页面组件（前端看 `router` / `views` / `pages`，后端看 controller 路径）。')
  lines.push('3. 只读这个页面组件 + 它直接调用的接口（通常 2–4 个文件就够），确认数据怎么来、怎么显示。')
  lines.push('')
  lines.push('**截图是证据，不是配图。** 图上出现的标题、按钮文字、表头、字段名、报错文案，')
  lines.push('都是可以直接在源码里搜的字面量 —— 拿它们去 grep，往往一步就命中页面。')
  lines.push('把「截图里看到的」和「问题描述里写的」对上，再决定改哪里：')
  lines.push('- 截图显示得不对（错位/缺失/数值不对）→ 问题在渲染或取值；')
  lines.push('- 截图正常但操作后状态不对 → 问题在提交、刷新或状态流转；')
  lines.push('- 截图里有报错文案 → 直接搜那句话。')

  lines.push('')
  lines.push('## 工作方式（重要，直接决定这张票多久跑完、以及改得对不对）')
  lines.push('**你要交的是真正修好的改动，不是一版「大概在这儿」的猜测。** 下面几条是让你更快地改对，')
  lines.push('不是让你更快地交差。')
  lines.push('')
  lines.push('- **先动手，再补细节**：读到能说出「要改哪个文件的哪一段、改成什么」就开始改第一版，')
  lines.push('  不要等把整个仓库读完 —— 剩下的细节靠跑验证来收敛，比继续阅读快。')
  lines.push(`- **探索预算 ${exploreBudget} 次**（读文件 + 搜索合计）：这个数字是用来**逼你瞄准**的，`)
  lines.push('  不是「读满就停下来」。真到了还没定位到，说明**线索不够**，')
  lines.push('  这时应当停下来说明「还缺哪一条信息才能定位」（例如操作流程没写是哪个页面、')
  lines.push('  截图看不清、问题描述有歧义），把它当成「需要人补信息」。')
  lines.push('  **绝对不要交一版自己都不确定能修好的改动。**')
  lines.push('- **同一类信息只查一次**：某个文件读过就别重复读同一个区段；要找的符号已经定位到就别再全局搜一遍。')
  lines.push('- **不要为了确认而确认**：编译/测试会告诉你对不对，先改一版跑一次，比反复阅读更快。')

  if (located.notes) {
    lines.push('')
    lines.push(`补充：${located.notes}`)
  }

  // 验证命令：必须写具体的命令，不能只说「按项目配置跑验证」——
  // 2026-11-11 那张票就是因为不知道命令是什么，自己摸索跑了 12 次 mvn/npm。
  lines.push(...renderVerifySection(options.verify))

  lines.push('')
  lines.push('## 约束')
  lines.push('- 只改这一个问题相关的代码，不要顺手重构别的地方。')
  lines.push('- 不要提交含真实凭据的配置文件（如 `application.yml` / `.env`）。')
  lines.push('- 不要动 CI 配置文件，也不要合并任何分支。')
  lines.push('- 真跑不起验证就把原因写清楚，**不要编造「已测试通过」**。')
  lines.push('- 全程用中文写说明、注释与提交信息。')

  return lines.join('\n')
}

/**
 * 把任务书 + 截图拼成消息内容块数组。
 *
 * 为什么不让调用方自己拼：text 块必须与 `renderTicketPrompt` 保持一致（否则
 * 走 content 的适配器和走 prompt 的适配器会看到两份不同的任务书），
 * 这个拼装只应该有一个实现。image 块按截图原顺序追加，模型才能对得上文字里说的「第几张图」。
 *
 * `images` 里可能有 undefined（`saveImage` 什么都不返回时），这里直接跳过：
 * 空引用塞进 content 会让适配器组装消息时炸掉，而没有图本身不是错误。
 *
 * **字段名必须是 `attachment`，不是 `image`**（2026-11-11 真实事故）：
 * 宿主 `@deepseek-ai/dsh-llm` 的 `ImageBlock` 契约是
 * `{ type: 'image', attachment: ImageAttachmentRef, offloaded?: boolean }`，
 * 所有读图代码都写 `block.attachment.attachmentId`（`collectImageRefs`、
 * `visitImageBlocks` 的调用方、`llm-pi-ai` 的 `case "image"`）。
 * 我们原先把引用放在 `image` 字段上，宿主取 `block.attachment.attachmentId`
 * 就拿到 undefined 并抛 `Cannot read properties of undefined (reading 'attachmentId')`
 * —— 只有**带截图的票**会炸，没图的票一切正常，所以这个问题藏了很久。
 *
 * @param {Ticket} ticket
 * @param {LocateResult} located
 * @param {ImageAttachmentRef[]} [images] 截图引用（`saveImage` 的返回值）
 * @param {{ verify?: VerifyCommands, exploreBudget?: number, memories?: Array<{ files?: string[], recordId?: string }> }} [options] 与 `renderTicketPrompt` 同一份
 * @returns {Array<{ type: 'text', text: string } | { type: 'image', attachment: ImageAttachmentRef }>}
 */
export function renderTicketContent (ticket, located, images = [], options = {}) {
  const blocks = [{ type: 'text', text: renderTicketPrompt(ticket, located, options) }]
  for (const image of images) {
    if (!image) continue
    blocks.push({ type: 'image', attachment: image })
  }
  return blocks
}

/**
 * 通知正文里的一行状态摘要。
 * @param {import('../contracts/types.js').Phase} phase
 * @returns {string}
 */
export function phaseLabel (phase) {
  return PHASE_LABEL[phase] ?? phase
}
