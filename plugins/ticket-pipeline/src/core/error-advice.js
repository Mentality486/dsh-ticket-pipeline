/**
 * 「最近错误」的人话化。
 *
 * ## 为什么要这个
 *
 * 2026-11-17 用户原话：
 *
 * > 最近错误：本地提交失败（git commit -m fix(pms): [pms] #IF(COUNTA($B93:$L93)=0,"",ROW()-1)
 * > 集成minio组件存放附件图片 … 工单标识: sh-row-93 …）：error: pathspec '集成minio组件…'
 * > did not match any file(s) known to git
 * > …
 * > 没有明确的失败原因 哪里出的问题怎么修改 都不明确
 *
 * 那一行有 2000 多个字符，其中 90% 是**我们自己的命令原文**与**git 的英文 stderr**。
 * 真正有用的信息只有一句：「提交说明里的双引号把命令拆坏了」。
 * 结论是要么写进日志、要么写进人话 —— 不能把原始命令直接摊在人面前。
 *
 * ## 设计约束（三条，都是踩过的）
 *
 * 1. **只解释、不吞掉原文**：`raw` 仍然完整返回，`advice.raw` 给人展开看。
 *    悄悄改写错误信息比不解释更坏 —— 排障的人会以为那是全部。
 * 2. **认不出就老实说认不出**：返回 `known: false` + 一条通用指引，
 *    绝不硬套一个看起来像的模板。套错模板会把人引到错误的方向。
 * 3. **判据是「错误里出现的特征串」，不是 `kind`**：`kind` 只有 8 个值，
 *    `internal` 这一个值就盖住了 git 失败、内存溢出、逻辑 bug 等几十种情况，
 *    按 `kind` 给建议等于没说。
 *
 * @module core/error-advice
 */

import { PipelineError } from '../contracts/errors.js'

/**
 * @typedef {Object} ErrorAdvice
 * @property {boolean} known 认不认得这个错误（不认得时 only 通用指引）
 * @property {string} title 一句话说清「哪一步、因为什么」（不带命令原文）
 * @property {string} [why] 为什么会这样（能讲清机制时才给）
 * @property {string} [fix] 具体该怎么办（能给出可执行动作时才给）
 * @property {string} raw 原文（已截断到可读长度）
 * @property {boolean} truncated 原文是否被截断
 */

/** 原文最多留这么长。够看到第一段的错误行，又不会把一行撑成一屏。 */
const RAW_LIMIT = 400

/**
 * 认得出的错误形态。顺序有意义：**越具体的越靠前**。
 *
 * `match` 拿的是小写后的原文，所以里面写的都是小写。
 */
const RULES = [
  {
    id: 'git-pathspec-quote',
    match: (text) => text.includes('did not match any file(s) known to git') || /error: pathspec '.*' did not match/.test(text),
    title: '提交失败：git 把提交说明里的引号当成了文件名',
    why: '提交说明里带了双引号。插件把这条命令交给 Windows PowerShell 执行时，'
      + 'PowerShell 会重新拆一次带双引号的参数，于是说明被切成好几段，'
      + 'git 把后半段当成了「要提交哪些文件」的路径。代码其实已经改完了、验证也过了。',
    fix: '已修复（2026-11-17）：提交说明会把双引号换成单引号，序号里的公式也不再进标题。'
      + '这张票直接「重跑」即可 —— 工作区里的改动还在，重跑会重新提交。',
  },
  {
    id: 'git-ignored-paths',
    match: (text) => text.includes('the following paths are ignored by one of your .gitignore files'),
    title: '暂存失败：要提交的文件被 .gitignore 挡住了',
    why: '这些文件在仓库里早就被跟踪着，但 .gitignore 里又写了要忽略它们。'
      + 'git 对「已跟踪但被忽略」的文件不让 add，除非显式加 --force。',
    fix: '已修复（2026-11-13）：插件会先问 git「哪些早就在库里」，在库的用 --force 暂存。重跑即可。',
  },
  {
    id: 'sync-table-forbidden',
    match: (text) => text.includes('connectorsynctableactionforbidden') || text.includes('800074911'),
    title: '回填失败：这张工单表是多维表格的「同步表」，不允许接口回写',
    why: '同步表的单元格由同步任务自己维护，飞书不允许 API 往里写 —— 这是平台限制，不是权限没开。',
    fix: '把工单来源换成**原生的多维表格**或**电子表格**（不要用「同步表」）。'
      + '插件这边的代码改动、提交都是成功的，只有回填这一步没写成。',
  },
  {
    id: 'feishu-no-permission',
    match: (text) => text.includes('99991672') || /no permission|permission denied/i.test(text) && text.includes('飞书'),
    title: '飞书接口报「没有权限」',
    why: '这个自建应用还没有被授予这个接口要的权限范围（scope），或者文档没有把应用加进协作者。',
    fix: '去飞书开放平台给应用开通对应权限并**发布版本**，再把应用加进那张表/那个文件夹的协作者。'
      + '然后点「体检」确认那一段变绿。',
  },
  {
    id: 'feishu-bot-scope',
    match: (text) => text.includes('230013'),
    title: '发消息失败：收件人不在机器人的可用范围里',
    why: '230013 说的是「这个人用不了这个机器人」，不是缺权限范围（缺 scope 会报 99991672）。',
    fix: '去飞书开放平台 → 应用 → 机器人 → 可用范围里把这个收件人加进去，然后重新发布版本。',
  },
  {
    id: 'feishu-wrong-base-token',
    match: (text) => text.includes('1254003') || text.includes('wrongbasetoken'),
    title: '飞书接口报「token 类型不对」',
    why: '拿着电子表格的 token 去问多维表格的接口（或反过来）。通常是配置里两套坐标还同时存在。',
    fix: '重新贴一次工单表链接（链接会带着表型），插件会据此重算坐标；不需要手填 token。',
  },
  {
    id: 'agent-no-change',
    match: (text) => text.includes('agent 没有产生任何文件改动'),
    title: 'agent 跑完了，但一个文件都没改',
    why: '它读了一圈没动手，或者把结论写在了回复里而没落到文件上。'
      + '常见于问题描述太笼统、或「操作流程」列没写清是哪个页面。',
    fix: '把工单的「操作流程」写具体（哪个菜单 → 哪个页面 → 哪个按钮），'
      + '或者在描述里点明出现问题的页面标题/字段名。然后重跑。',
  },
  {
    id: 'agent-timeout',
    match: (text) => text.includes('超时') && (text.includes('分钟') || text.includes('ticketTimeout')),
    title: '这张票跑到超时为止还没做完',
    why: '它一直在读和搜，没动手改文件。任务书里的探索预算就是防这个的，'
      + '但预算是「只催不杀」—— 真正兜底的是超时。',
    fix: '先看流程带：如果 ⑤ 处理问题那一站占满了时间，说明它卡在定位上。'
      + '把工单的描述/操作流程写得更具体，重跑会快很多。也可以在项目设置里调大「探索预算」。',
  },
  {
    id: 'no-verify-command',
    match: (text) => text.includes('没有 verify.build') || text.includes('本票没有跑验证'),
    title: '这一票没有跑验证：项目配置里没写验证命令',
    why: '插件不知道这个项目该怎么验证，就跳过了 —— 它不是失败，是缺配置。',
    fix: '在项目配置的 `verify` 里写上命令（例如 `{"test": "npm test"}`），'
      + '下一张票就会真的跑它，并把结论写进提交说明。',
  },
  {
    id: 'worktree-dirty',
    match: (text) => text.includes('检出') && text.includes('未提交'),
    title: '项目检出里有别人的未提交改动，插件不敢动',
    why: '缺省模式下插件直接在你那份检出里改代码、就地提交 —— '
      + '起点有脏文件时，提交会把别人的改动一起带进去。',
    fix: '先把检出里的改动处理掉（提交或 stash），或者打开「每票一个隔离 worktree」'
      + '（`isolateWorktree`），插件会给每张票单独开一份工作区。',
  },
  {
    id: 'lease-lost',
    match: (text) => text.includes('租约'),
    title: '这张票被另一个进程接管了',
    why: '同一张票上出现了两个插件实例（常见于连着开了两个宿主窗口）。租约是防止两边同时改同一份代码。',
    fix: '不需要处理 —— 抢到的那一边会跑完。如果两张都跑了，检查是不是开了两个宿主。',
  },
  {
    id: 'auth-failed',
    match: (text) => text.includes('鉴权') || text.includes('token 无效') || text.includes('invalid token') || text.includes('401'),
    title: '凭据不对，接口拒绝了这次请求',
    why: '应用凭据过期/填错，或者被轮换过。',
    fix: '去「凭据」页签重新填一遍（飞书 appId/appSecret、GitLab token 等），保存后点「体检」确认。',
  },
]

/**
 * 把一条原始错误解释成人话。
 *
 * @param {unknown} lastError
 * @returns {ErrorAdvice}
 */
export function explainError (lastError) {
  const raw = String(lastError ?? '').trim()
  if (raw.length === 0) {
    return { known: false, title: '没有记录错误原因', raw: '', truncated: false }
  }
  const lower = raw.toLowerCase()
  for (const rule of RULES) {
    if (rule.match(lower)) {
      return {
        known: true,
        rule: rule.id,
        title: rule.title,
        why: rule.why,
        fix: rule.fix,
        raw: truncate(raw),
        truncated: raw.length > RAW_LIMIT,
      }
    }
  }
  // 认不出：给通用指引，**不硬套模板**。硬套会把人引到错的方向。
  return {
    known: false,
    title: firstLine(raw),
    why: undefined,
    fix: '这条错误插件还认不出来。原文在下面 —— 它的第一句通常就是原因；'
      + '如果看不懂，把这段原文整段发我，我按它加一条判据。',
    raw: truncate(raw),
    truncated: raw.length > RAW_LIMIT,
  }
}

/**
 * 多行错误只取第一段有意义的行。
 *
 * 为什么不是「第一行」：真实错误常常以 `本地提交失败（git commit -m …` 开头，
 * 那一行有几百字。取第一行等于没截断。取**第一句短的那行**更能当标题。
 *
 * @param {string} raw
 * @returns {string}
 */
function firstLine (raw) {
  const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const short = lines.find((line) => line.length <= 120)
  const picked = short ?? lines[0] ?? raw
  return picked.length > 120 ? `${picked.slice(0, 120)}…` : picked
}

/** @param {string} text */
function truncate (text) {
  if (text.length <= RAW_LIMIT) return text
  return `${text.slice(0, RAW_LIMIT)}…（原文共 ${text.length} 字，已截断）`
}

/**
 * 渲染成几行给人看。
 *
 * 形状（明细视图里）：
 *
 * ```
 *   最近错误：提交失败：git 把提交说明里的引号当成了文件名
 *     为什么：提交说明里带了双引号。…
 *     怎么办：已修复（2026-11-17）…重跑即可
 *     原文：本地提交失败（git commit -m …）
 * ```
 *
 * @param {unknown} lastError
 * @param {{ indent?: string, showRaw?: boolean }} [options]
 * @returns {string[]}
 */
export function renderErrorAdvice (lastError, options = {}) {
  const indent = options.indent ?? '  '
  const advice = explainError(lastError)
  const lines = [`${indent}最近错误：${advice.title}`]
  if (advice.why) lines.push(`${indent}  为什么：${advice.why}`)
  if (advice.fix) lines.push(`${indent}  怎么办：${advice.fix}`)
  if (options.showRaw !== false && advice.raw.length > 0 && advice.raw !== advice.title) {
    lines.push(`${indent}  原文：${advice.raw}`)
  }
  return lines
}

/**
 * `explainError` 的 `PipelineError` 版本：拿到的可能是一条 `PipelineError`，
 * 也可能只是 `.message` 字符串（存储里只存 message）。
 *
 * @param {unknown} error
 * @returns {ErrorAdvice}
 */
export function explainPipelineError (error) {
  if (error instanceof PipelineError) {
    const advice = explainError(error.message)
    return { ...advice, kind: error.kind, retryable: error.retryable }
  }
  return explainError(error)
}
