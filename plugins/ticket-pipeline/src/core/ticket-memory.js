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
 * 插件里原本完全没有记忆：「跨票」这个词在 `src/` 里只命中测试替身
 * `makeMemoryRepo()`（一个内存 KV 表，与业务无关）。
 *
 * ## 记什么、不记什么
 *
 * 只记**可验证的事实**：一张票跑成功后，把它最终的 `changedFiles` 与从工单里
 * 抽出来的关键词绑在一起。不记「模型觉得哪里可能有问题」这种推测 ——
 * 推测会累积成噪音，而「上次改这个模块动过这三个文件」是硬事实。
 *
 * ## 为什么按项目分表
 *
 * 不同项目是不同仓库，同一模块名（「审批」「列表页」）在两个仓库里指向完全不同的
 * 文件。混在一起做全局记忆，等于把 A 项目的答案塞给 B 项目。
 *
 * ## 这是**提示**，不是**约束**
 *
 * 记忆只出现在任务书的「补充」里，措辞必须让人（和模型）明白「上次是这几个文件，
 * 但这次不一定是」。写死了会变成误导 —— 同一个模块的新问题完全可能在另一个文件里。
 */

/** 记忆表名。与 `core/domain.js` 里声明的表对应。 */
export const MEMORY_TABLE = 'memory'

/** 一个项目最多记多少条。多了会撑大任务书，也会让「上次」变得没有区分度。 */
export const MEMORY_LIMIT = 20

/**
 * 一条记忆。
 *
 * @typedef {object} MemoryEntry
 * @property {string[]} keywords 从工单里抽出的关键词（模块名、页面名、字段名这类）
 * @property {string[]} files 这张票最终改动过的文件（相对仓库根）
 * @property {string} recordId 来源票（人能从它追到原始工单）
 * @property {number} at 学到这条记忆的时刻（epoch ms）
 * @property {number} hits 这条记忆被复用了几次（复用过说明它有用，排序要靠它）
 */

/**
 * 从一张工单里抽出用于检索的关键词。
 *
 * 抽的都是**用户自己写下来的字**，不做任何分词或同义词扩展：
 * - `module`（模块列，如「首样测试」）；
 * - `flow`（操作流程列，短的时候它就是个模块名）；
 * - 问题描述里出现的、长度 ≥ 2 的英文标识符与中文词组片段。
 *
 * 为什么不去停用词、不做词干化：抽错一个词的代价是「任务书里多一行不相干提示」，
 * 抽漏一个词的代价是「记忆永远命不中」。前者便宜得多，所以宁可多抽。
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
    // 一段中文/一句话只留前 24 个字：整句话当关键词既占位置又几乎不可能命中。
    // 但标识符不截断 —— `PmsProductSampleTestServiceImpl` 33 个字，截一半就再也命不中，
    // 而它恰恰是这类记忆里最值钱的那个词。
    const limit = isIdentifier ? 120 : 24
    out.add(text.length > limit ? text.slice(0, limit) : text)
  }
  add(ticket?.module)
  add(ticket?.flow)
  const description = String(ticket?.description ?? '')
  // 英文标识符（驼峰类名、snake_case 字段名、路由名）是最可靠的检索词。
  for (const match of description.matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}/g)) add(match[0], true)
  // 中文按 2–4 字的滑动窗口抽，覆盖「并行节点」「进度条」这类短词。
  for (const run of description.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const text = run[0]
    for (let size = Math.min(4, text.length); size >= 2; size -= 1) {
      for (let i = 0; i + size <= text.length && i < 8; i += 1) add(text.slice(i, i + size))
    }
  }
  return [...out].slice(0, 40)
}

/**
 * 算一次「这张工单与这条记忆有多相关」。
 *
 * 用命中关键词个数而不是布尔匹配：命 1 个词和命 4 个词的记忆可信度差很多，
 * 平手时再按 `hits`（历史复用次数）排 —— 被证明有用的记忆优先。
 *
 * @param {string[]} keywords
 * @param {MemoryEntry} entry
 * @returns {number}
 */
function scoreOf (keywords, entry) {
  let score = 0
  for (const word of keywords) {
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
  return entries
    .map((entry) => ({ entry, score: scoreOf(keywords, entry), hits: Number(entry?.hits ?? 0) }))
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
 * 2. 说清「不一定」—— 同一模块的新问题可能在别的文件里；
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
   * 去重规则：**同一批文件 + 有重叠关键词**视为同一条，只累加 `hits` 并更新
   * `recordId`。不去重的话，同一个模块连续十张票会留下十条几乎一样的记忆，
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
      // 关键词取并集：同一批文件可能被不同措辞的工单命中，并集让检索面更宽。
      const merged = new Set([...(existing.keywords ?? []), ...(keywords ?? [])])
      existing.keywords = [...merged].slice(0, 40)
      await this.save(projectId, entries)
      return existing
    }
    /** @type {MemoryEntry} */
    const entry = {
      keywords: [...new Set(keywords ?? [])].slice(0, 40),
      files: cleaned,
      recordId,
      at: this.now(),
      hits: 0,
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
