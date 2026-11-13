/**
 * `ticket-memory.js` —— 跨票积累「这类问题改过哪几个文件」。
 *
 * ## 为什么需要它
 *
 * 2026-11-11 那张跑通的票，前 46 次工具调用（21.5 分钟）全花在同一件事上：
 * 从「首样测试」四个字找到 `ProductSampleTestList.vue` + `PmsProductSampleTestServiceImpl.java`
 * + `PmsApprovalConfig.java` 这几个文件。这个过程**是可复用的知识**，
 * 但下一张同模块的票进来时，一切从零开始 —— 同样的 grep、同样的 250+ 处「首样」命中、
 * 同样的路径猜错再 glob 找回。
 *
 * 2026-11-13 实测：`sh-row-82` 第一次跑 49 分钟、探索 84 次、**一个文件没改**；
 * 第二次重跑又探索了 57 次才动手，其中 5 个文件是第一次已经读过的（第二次总共才读 11 个）。
 * 这些重复阅读全是「上一轮明明已经知道」的东西。
 *
 * ## 记什么、不记什么
 *
 * 只记**可验证的事实**：一张票跑成功后，把它最终的 `changedFiles` 与从工单的
 * **结构化字段**里抽出来的关键词绑在一起。不记「模型觉得哪里可能有问题」这种推测 ——
 * 推测会累积成噪音，而「上次改这个页面动过这三个文件」是硬事实。
 *
 * ## 为什么按项目分表
 *
 * 不同项目是不同仓库，同一模块名（「审批」「列表页」）在两个仓库里指向完全不同的
 * 文件。混在一起做全局记忆，等于把 A 项目的答案塞给 B 项目。
 *
 * ## 这是**提示**，不是**约束**
 *
 * 记忆只出现在任务书的「补充」里，措辞必须让人（和模型）明白「上次是这几个文件，
 * 但这次不一定是」。写死了会变成误导 —— 同一个页面的新问题完全可能在另一个文件里。
 */

/** 记忆表名。与 `core/domain.js` 里声明的表对应。 */
export const MEMORY_TABLE = 'memory'

/** 一个项目最多记多少条。多了会撑大任务书，也会让「上次」变得没有区分度。 */
export const MEMORY_LIMIT = 20

/**
 * 关键词抽取算法的版本。
 *
 * v1（2026-11-12）用中文 2–4 字**滑动窗口**从问题描述里抽词，结果是
 * `作台中的` / `台中的全` / `全据项` / `侧列表` 这种碎片，真正该用的 `工作台-全据项目报告`
 * 反被稀释。实测 `sh-row-82`（首样测试）召回的是 `sh-row-83`（上门服务）—— 两张完全不同的页面。
 *
 * v2（2026-11-13）只收**结构化字段**：模块列、操作流程列按 `-` 切出来的每一段、
 * 以及描述里的英文标识符。理由见 `extractKeywords` 的注释。
 *
 * 库里 v1 学到的条目**不做迁移**：它们的碎片词几乎不可能与本版本的抽取结果逐字相等
 * （本版本产出的全是 `项目管理` / `首样测试` 这类整段词），所以不会造成新的误召回；
 * 而那些条目本来也只会被同项目的票重新学到时覆盖掉。`kwv` 只用于将来排查「这条记忆是
 * 哪套算法抽的词」。
 */
export const MEMORY_KEYWORD_VERSION = 2

/**
 * 一条记忆。
 *
 * @typedef {object} MemoryEntry
 * @property {string[]} keywords 从工单里抽出的关键词（模块名、页面名、字段名这类）
 * @property {string[]} files 这张票最终改动过的文件（相对仓库根）
 * @property {string} recordId 来源票（人能从它追到原始工单）
 * @property {number} at 学到这条记忆的时刻（epoch ms）
 * @property {number} hits 这条记忆被复用了几次（复用过说明它有用，排序要靠它）
 * @property {number} [kwv] 抽词算法版本（见 `MEMORY_KEYWORD_VERSION`）
 */

/**
 * 操作流程列的段分隔符。
 *
 * 真实数据里这一列长这样：`项目管理-首样测试-审批按钮`、`工作台-全据项目报告`、
 * `产品方案配置-需求列表-需求详情`。它本来就是**人写的页面路径**，`-` 是天然的
 * 切分点 —— 这比任何分词都可靠，因为切出来的每一段都是用户自己命名的页面名。
 *
 * @type {RegExp}
 */
const FLOW_SEPARATOR = /[-–—/\\>»·、，,|；;：:]/

/**
 * 从一张工单里抽出用于检索的关键词。
 *
 * ## 只收结构化字段，不从问题描述里切中文
 *
 * 三个来源：
 * 1. `module`（模块列，如「工作台」）；
 * 2. `flow`（操作流程列）按 `-` 切出来的**每一段**，例如
 *    `项目管理-首样测试-审批按钮` ⇒ `项目管理` / `首样测试` / `审批按钮`。
 *    切段还顺带解决了「精确比较永远不相等」的问题：`项目管理-首样测试` 与
 *    `项目管理-首样测试-审批按钮` 是两张票的 flow，整串比是一个都不等，
 *    切成段之后它们共享 `首样测试`，这正是「同一个页面」的信号。
 * 3. 问题描述里的**英文标识符**（类名、字段名、路由名），这类词最可靠且不会误命中。
 *
 * **中文一律不从问题描述里抽**，这是 v2 的关键改动。理由：描述写的是「哪里不对」，
 * 而两张票碰巧同一个页面时，措辞几乎一定不同；反过来，两张票措辞相同（都提「列表」
 * 「排序」「筛选」）却完全可能是八竿子打不着的两个页面。按描述的中文匹配，命中的
 * 大多是巧合。
 *
 * 而「哪几个文件」这件事，只跟**页面**有关 —— 页面就在 module + flow 里。
 *
 * @param {{ module?: string, flow?: string, description?: string }} ticket
 * @returns {string[]}
 */
export function extractKeywords (ticket) {
  /** @type {Set<string>} */
  const out = new Set()
  /**
   * @param {string} raw
   * @param {boolean} [isIdentifier] 标识符（类名/字段名/路由名）不截断
   */
  const add = (raw, isIdentifier = false) => {
    const text = String(raw ?? '').trim()
    if (text.length < 2) return
    // 一段中文只留前 24 个字：整句话当关键词既占位置又几乎不可能命中。
    // 但标识符不截断 —— `PmsProductSampleTestServiceImpl` 33 个字，截一半就再也命不中，
    // 而它恰恰是这类记忆里最值钱的那个词。
    const limit = isIdentifier ? 120 : 24
    out.add(text.length > limit ? text.slice(0, limit) : text)
  }
  add(ticket?.module)
  // flow 既留整串（人回看时能认出是哪条路径），也切段（检索用的就是段）。
  add(ticket?.flow)
  const flowSegments = String(ticket?.flow ?? '').split(FLOW_SEPARATOR)
  for (const segment of flowSegments) add(segment)
  const description = String(ticket?.description ?? '')
  // 英文标识符（驼峰类名、snake_case 字段名、路由名）是最可靠的检索词。
  for (const match of description.matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}/g)) add(match[0], true)
  return [...out]
}

/**
 * 每条关键词出现在多少条记忆里。
 *
 * 用来滤掉「没有区分度」的词：一个词如果**每条记忆都有**，它就不能用来判断
 * 「这次该找哪一条」。实测例子：pms 项目里 `项目管理` 几乎出现在每条记忆里，
 * 只靠它命中就会把「首样测试」的票引到「上门服务」的改动上去 —— 2026-11-13
 * 现场就发生过这一次（`sh-row-82` 召回到 `sh-row-83`）。
 *
 * 判据用「所有记忆都有」而不是「超过一半」，理由是前者不需要调阈值、
 * 也不会在小样本下（n=2、n=3）把有用的词误杀：n=1 时一条记忆身上的任何词都算数，
 * n=2 时只有两条共有的词被滤掉。
 *
 * @param {MemoryEntry[]} entries
 * @returns {Map<string, number>}
 */
function documentFrequency (entries) {
  /** @type {Map<string, number>} */
  const df = new Map()
  for (const entry of entries) {
    const words = Array.isArray(entry?.keywords) ? entry.keywords : []
    for (const word of new Set(words)) df.set(word, (df.get(word) ?? 0) + 1)
  }
  return df
}

/**
 * 算一次「这张工单与这条记忆有多相关」。
 *
 * 用命中关键词个数而不是布尔匹配：命 1 个词和命 4 个词的记忆可信度差很多。
 * 只数**有区分度**的词（见 `documentFrequency`）。
 *
 * @param {string[]} distinctive
 * @param {MemoryEntry} entry
 * @returns {number}
 */
function scoreOf (distinctive, entry) {
  let score = 0
  for (const word of distinctive) {
    if (entry.keywords?.includes(word)) score += 1
  }
  return score
}

/**
 * 找出与这张工单最相关的记忆。
 *
 * @param {MemoryEntry[]} entries
 * @param {string[]} keywords
 * @param {number} [limit]
 * @returns {MemoryEntry[]}
 */
export function recallMemories (entries, keywords, limit = 3) {
  if (!Array.isArray(entries) || entries.length === 0) return []
  if (!Array.isArray(keywords) || keywords.length === 0) return []
  // 跳过用旧算法抽词的条目：v1 的词表是「作台中的 / 侧列表排」这类 2–4 字碎片，
  // v2 查询词是「首样测试 / 审批按钮」这类整段词。两套词表之间做子串以外的匹配
  // 只会产生巧合命中 —— 实测 v1 数据下 `sh-row-82`（首样测试）召回到
  // `sh-row-83`（上门服务），两张完全不同的页面。旧条目留着不动，
  // 等同一个页面再有票跑成功时自然被覆盖、或被新条目挤出 20 条上限。
  const usable = entries.filter((entry) => entry?.kwv === MEMORY_KEYWORD_VERSION)
  if (usable.length === 0) return []
  const df = documentFrequency(usable)
  // 区分度必须在**可用条目**上算，而且后面的遍历也只在可用条目上做 ——
  // 两处都漏一处，旧条目就会原样混回来（自测抓过：把 `entries` 写在 `.map` 上，
  // 结果三条全召回）。
  //
  // 只剩一条记忆时不滤：那一条的每个词 df 都等于 1 = 条目数，按「每条都有」的判据
  // 会被整条滤空 —— 于是项目里第二张票永远看不到第一张学到的东西，记忆功能等于没开。
  // 「所有记忆都有」这个判据本来就需要至少两条才有意义。
  const distinctive = usable.length === 1
    ? [...keywords]
    : keywords.filter((word) => (df.get(word) ?? 0) < usable.length)
  if (distinctive.length === 0) return []
  return usable
    .map((entry) => ({ entry, score: scoreOf(distinctive, entry), hits: Number(entry?.hits ?? 0) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => (b.score - a.score) || (b.hits - a.hits) || (b.entry.at - a.entry.at))
    .slice(0, Math.max(1, limit))
    .map((item) => item.entry)
}

/**
 * 把一条记忆压成任务书里的一行。
 *
 * 措辞的三条要求（都是防止把提示写成约束）：
 * 1. 说清「上次」—— 这是历史，不是这次的事实；
 * 2. 说清「不一定」—— 同一个页面的新问题可能在别的文件里；
 * 3. 给出可执行的动作 —— 「从这里开始找」而不是「照这个改」。
 *
 * @param {MemoryEntry} entry
 * @returns {string}
 */
export function describeMemory (entry) {
  const files = Array.isArray(entry?.files) ? entry.files.filter((f) => typeof f === 'string' && f.length > 0) : []
  if (files.length === 0) return ''
  const shown = files.slice(0, 6).join('`、`')
  const more = files.length > 6 ? ` 等 ${files.length} 个文件` : ''
  return `上次处理同类问题（工单 ${entry.recordId}）改的是 \`${shown}\`${more} —— 可以从这几个文件开始找，但不一定还是它们。`
}

/**
 * 项目级记忆仓库。
 *
 * 用 `TicketStore` 之外的一张小表：记忆与票的生命周期无关，票被 `forget` 清掉之后
 * 学到的东西应该留着。所以不给它加在 `TicketRecordRow` 上，而是独立的 KV。
 */
export class TicketMemory {
  /**
   * @param {Object} options
   * @param {{ get: (table: string, key: string) => unknown, put: (table: string, key: string, value: unknown) => Promise<void> }} options.repo
   * @param {() => number} [options.now]
   * @param {number} [options.limit] 每个项目最多留几条
   */
  constructor ({ repo, now, limit }) {
    this.repo = repo
    this.now = now ?? (() => Date.now())
    this.limit = Number(limit) > 0 ? Number(limit) : MEMORY_LIMIT
  }

  /**
   * @param {string} projectId
   * @returns {MemoryEntry[]}
   */
  list (projectId) {
    if (!projectId) return []
    const raw = /** @type {any} */ (this.repo.get(MEMORY_TABLE, projectId))
    const entries = raw?.entries
    return Array.isArray(entries) ? entries : []
  }

  /**
   * 记一条：这张票改了这些文件。
   *
   * 去重规则：**同一批文件**视为同一条，只累加 `hits` 并更新 `recordId`。
   * 不去重的话，同一个页面连续十张票会留下十条几乎一样的记忆，
   * 把真正不同的那几条挤出去（限制是 20 条）。
   *
   * @param {{ projectId: string, recordId: string, keywords: string[], files: string[] }} input
   * @returns {Promise<MemoryEntry | undefined>} 记下来的那一条（没文件可记时返回 undefined）
   */
  async remember ({ projectId, recordId, keywords, files }) {
    if (!projectId) return undefined
    const cleaned = Array.isArray(files)
      ? [...new Set(files.filter((f) => typeof f === 'string' && f.trim().length > 0))]
      : []
    // 没有改动文件的票不产生记忆：它要么没干活，要么改了又被拦下，学到的东西不可信。
    if (cleaned.length === 0) return undefined
    const entries = this.list(projectId)
    const sameFiles = (a, b) => a.length === b.length && a.every((f) => b.includes(f))
    const existing = entries.find((entry) => sameFiles(entry.files ?? [], cleaned))
    if (existing) {
      existing.hits = Number(existing.hits ?? 0) + 1
      existing.at = this.now()
      existing.recordId = recordId
      // 关键词：同一批文件可能被不同措辞的工单命中，所以正常情况取并集让检索面更宽。
      // **但旧算法（kwv !== 当前版本）的条目不能并** —— 它那批词是中文碎片，
      // 并进来就等于把已经确认没用的噪音永久留在库里。这种情况整批换成新词。
      const fromOldVersion = existing.kwv !== MEMORY_KEYWORD_VERSION
      const merged = fromOldVersion
        ? new Set(keywords ?? [])
        : new Set([...(existing.keywords ?? []), ...(keywords ?? [])])
      existing.keywords = [...merged]
      existing.kwv = MEMORY_KEYWORD_VERSION
      await this.save(projectId, entries)
      return existing
    }
    /** @type {MemoryEntry} */
    const entry = {
      keywords: [...new Set(keywords ?? [])],
      files: cleaned,
      recordId,
      at: this.now(),
      hits: 0,
      kwv: MEMORY_KEYWORD_VERSION,
    }
    // 新的排前面，超出上限就丢最旧的。
    const next = [entry, ...entries].slice(0, this.limit)
    await this.save(projectId, next)
    return entry
  }

  /**
   * 把记忆里被复用过的条目记一次 `hits`（排序用）。
   *
   * 单独一个方法而不是在 `recall` 里就地改：`recall` 只读不写，避免「渲染任务书」
   * 这个纯函数顺手改了数据库 —— 那样重渲一次任务书就会把 `hits` 刷高。
   *
   * @param {string} projectId
   * @param {MemoryEntry[]} used 这次真的写进任务书的那些
   * @returns {Promise<void>}
   */
  async touch (projectId, used) {
    if (!projectId || !Array.isArray(used) || used.length === 0) return
    const entries = this.list(projectId)
    const ids = new Set(used.map((entry) => `${entry.recordId}|${(entry.files ?? []).join(',')}`))
    let changed = false
    for (const entry of entries) {
      if (ids.has(`${entry.recordId}|${(entry.files ?? []).join(',')}`)) {
        entry.hits = Number(entry.hits ?? 0) + 1
        changed = true
      }
    }
    if (changed) await this.save(projectId, entries)
  }

  /**
   * @param {string} projectId
   * @param {MemoryEntry[]} entries
   * @returns {Promise<void>}
   */
  async save (projectId, entries) {
    await this.repo.put(MEMORY_TABLE, projectId, { entries })
  }
}
