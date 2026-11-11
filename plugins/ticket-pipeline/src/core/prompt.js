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

/**
 * @typedef {import('../contracts/types.js').Ticket} Ticket
 * @typedef {import('../contracts/types.js').LocateResult} LocateResult
 * @typedef {import('../contracts/types.js').Plan} Plan
 */

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
 * @param {Ticket} ticket
 * @param {LocateResult} located
 * @returns {string}
 */
export function renderTicketPrompt (ticket, located) {
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

  if (ticket.flow) {
    lines.push('')
    lines.push('## 操作流程')
    lines.push(ticket.flow.trim())
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
  lines.push('- **探索预算 12 次**（读文件 + 搜索合计）：这个数字是用来**逼你瞄准**的，')
  lines.push('  不是「读满 12 次就可以随便改」。真到了 12 次还没定位到，说明**线索不够**，')
  lines.push('  这时应当停下来说明「还缺哪一条信息才能定位」（例如操作流程没写是哪个页面、')
  lines.push('  截图看不清、问题描述有歧义），把它当成「需要人补信息」。')
  lines.push('  **绝对不要交一版自己都不确定能修好的改动。**')
  lines.push('- **同一类信息只查一次**：某个文件读过就别重复读同一个区段；要找的符号已经定位到就别再全局搜一遍。')
  lines.push('- **不要为了确认而确认**：编译/测试会告诉你对不对，先改一版跑一次，比反复阅读更快。')

  if (located.notes) {
    lines.push('')
    lines.push(`补充：${located.notes}`)
  }

  lines.push('')
  lines.push('## 约束')
  lines.push('- 只改这一个问题相关的代码，不要顺手重构别的地方。')
  lines.push('- 不要提交含真实凭据的配置文件（如 `application.yml` / `.env`）。')
  lines.push('- 不要动 CI 配置文件，也不要合并任何分支。')
  lines.push('- 改完按项目配置里的验证命令跑验证（构建 / 测试）。')
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
 * @returns {Array<{ type: 'text', text: string } | { type: 'image', attachment: ImageAttachmentRef }>}
 */
export function renderTicketContent (ticket, located, images = []) {
  const blocks = [{ type: 'text', text: renderTicketPrompt(ticket, located) }]
  for (const image of images) {
    if (!image) continue
    blocks.push({ type: 'image', attachment: image })
  }
  return blocks
}

/**
 * 极简的执行计划文本：只要求 agent 先报「要改哪几个文件、怎么改」。
 *
 * 不做结构化解析 —— `Plan` 由 `WorkExecutor` 适配器自己决定要不要填，
 * 内核只把它存下来给通知用。
 *
 * @param {Ticket} ticket
 * @returns {string}
 */
export function renderPlanRequest (ticket) {
  return [
    '先不要改代码。用 3–6 行说明：',
    '1. 你判断工单说的是哪个页面/接口；',
    '2. 你打算改哪几个文件，各改什么；',
    '3. 改完怎么验证。',
    '',
    `工单问题：${ticket.description.split(/\r?\n/)[0] ?? ''}`,
  ].join('\n')
}

/**
 * 通知正文里的一行状态摘要。
 * @param {import('../contracts/types.js').Phase} phase
 * @returns {string}
 */
export function phaseLabel (phase) {
  return PHASE_LABEL[phase] ?? phase
}
