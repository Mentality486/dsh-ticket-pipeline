/**
 * 飞书**电子表格**（Sheets）分支。
 *
 * 与 `index.js` 里的多维表格（Bitable）分支是同一平台的两种文档类型：
 * 配置里仍然只写 `platform: 'feishu'`，**表型由插件探测**，不让人填
 * （设计见 `docs/ticket-pipeline/feishu-sheet-source.md`，ADR-0005）。
 *
 * 为什么单独一个文件：`index.js` 已经 1400 多行，而电子表格这一支从
 * 「定位工作表 → 读值 → 表头映射 → 造行身份」是完整的一套，和金山源
 * （`source-wps/index.js` + `xlsx.js`）同构。主文件只做分派。
 *
 * ## 与多维表格的三处本质差异（决定了这里的写法）
 *
 * 1. **没有 `record_id`**。平台不发行身份，只能自造：
 *    `sh-seq-<序号值>`（默认，人填的序号列）或 `sh-row-<物理行号>`。
 *    序号为空时**兜底**成行号并在 `raw.identitySource` 里标 `fallback-row`。
 * 2. **没有行级修改时间**。所以「早停」这套（`safePageRun`）在电子表格上
 *    没有依据，只能每次读全表 + 逐行比对内容指纹。
 * 3. **读值接口没有分页**（没有 `has_more` / `page_token`），只有 10 MB 单次上限；
 *    大表用 `match.sheetRange` 收窄。
 *
 * ## 只读
 *
 * 本文件**不发出任何写请求**。电子表格这一支不做回填（设计 §1.2 明确划出范围外），
 * 真链路里也只会有 `GET`。自测里有一条专门的「全程不得出现写请求」断言盯着这件事。
 */

import { PipelineError } from '../../contracts/errors.js'
import { FEISHU_SEMANTIC_FIELDS } from '../../contracts/feishu-columns.js'

/**
 * 表头认这些列名。
 *
 * 这是**飞书 12 列 + 金山别名表**的合成：同一张工单表被导出 / 搬到电子表格里时，
 * 「问题描述」可能叫「缺陷描述」（金山那套别名），也可能就是飞书那套叫法。
 * 两份都要认，否则用户把多维表格的数据搬到电子表格里就得手工改表头。
 *
 * 顺序即优先级（同一个字段的第一个名字优先）。
 */
export const SHEET_COLUMN_ALIASES = Object.freeze({
  seq: ['序号', '编号', 'No', 'No.'],
  projectId: ['待修改项目', '所属项目', '项目', '系统'],
  description: ['问题描述', '问题', '缺陷描述', 'Bug 描述'],
  flow: ['操作流程', '复现步骤', '操作步骤', '复现流程'],
  status: ['是否处理', '处理状态', '状态'],
  department: ['发现部门', '提出部门', '部门'],
  foundAt: ['发现日期', '提出日期', '日期'],
  priority: ['优先级', '严重程度', '等级'],
  module: ['模块', '所属模块', '功能模块'],
  screenshot: ['截图', '图片', '问题截图', '截图/录屏'],
  handler: ['处理人'],
  result: ['处理结果'],
  handledAt: ['处理日期'],
})

/** 必需列：缺任一就报配置错误，而不是静默扫出 0 张票。 */
export const REQUIRED_SHEET_FIELDS = Object.freeze(['description', 'status'])

/**
 * 多维表格那 13 列的**规范名**（工单 #21）。
 *
 * 这张表的结构来自用户贴出的《PMS系统问题Bug记录表》使用说明（12 列，
 * 外加一个自动字段「最后更新时间」）。规范名同时充当「缺省映射」：
 * 表里就叫这些名字时，一次映射都不用做。
 *
 * **定义已经搬到 `contracts/feishu-columns.js`**：`core/config.js` 校验
 * `match.columns` 时也要这份字段白名单，而 `core` 反向 import `adapters`
 * 是倒着的依赖方向。这里只做转出，保证「适配器认识的那 13 个」与
 * 「配置校验放行的那 13 个」永远是同一份。
 *
 * 注意它**不再是唯一的认定口径** —— 名字对不上时先查 `BITABLE_COLUMN_ALIASES`。
 */
export const BITABLE_CANONICAL_COLUMNS = FEISHU_SEMANTIC_FIELDS

/**
 * 多维表格的列名别名表（工单 #21）。
 *
 * 为什么必须和电子表格共用一套：同一张工单表被人从多维表格导出、再导入回来，
 * 或者干脆被人重建成多维表格时，字段名会变成「缺陷描述」「处理状态」这些
 * 电子表格侧本来就认的写法。以前多维表格走的是硬编码常量，名字一换就
 * **静默扫出 0 张票**（`fields['问题描述']` 取不到 ⇒ 描述为空 ⇒ 全被过滤掉），
 * 既不报错也不提示，最难查。
 *
 * 构造规则：字段 = 规范名的 13 个 ∪ 电子表格别名表的字段；
 * 每个字段的候选名 = **规范名排第一**，其后接电子表格那套别名（去重）。
 * 顺序即优先级 —— 表里同时存在「问题描述」和「缺陷描述」两列时，认规范名那列。
 */
export const BITABLE_COLUMN_ALIASES = Object.freeze(buildBitableAliases())

/**
 * @returns {Record<string, string[]>}
 */
function buildBitableAliases () {
  /** @type {Record<string, string[]>} */
  const out = {}
  for (const [field, canonical] of Object.entries(BITABLE_CANONICAL_COLUMNS)) {
    const extra = SHEET_COLUMN_ALIASES[field] ?? []
    // 规范名必须排第一：别名表里也有一堆同义写法，但「问题描述」是这张表的正名。
    out[field] = Object.freeze([canonical, ...extra.filter((name) => name !== canonical)])
  }
  return out
}

/** 优先级字面量 → 内部档位。含金山那个表多出来的「严重 / 轻微」。 */
const SHEET_PRIORITY_MAP = new Map([
  ['高', 'high'], ['高优先级', 'high'], ['紧急', 'high'], ['严重', 'high'], ['urgent', 'high'], ['critical', 'high'], ['p0', 'high'], ['p1', 'high'],
  ['中', 'medium'], ['中优先级', 'medium'], ['一般', 'medium'], ['普通', 'medium'], ['medium', 'medium'], ['p2', 'medium'],
  ['低', 'low'], ['低优先级', 'low'], ['轻微', 'low'], ['minor', 'low'], ['low', 'low'], ['p3', 'low'],
])

/** 缺省的表头在哪一行（1-based，和人在 Excel 里看到的一致）。 */
export const DEFAULT_SHEET_HEADER_ROW = 1

/** 缺省用哪一列做序号身份。 */
export const DEFAULT_SHEET_ID_COLUMN = '序号'

/** 行身份的前缀。刻意不用 `rec` —— 那是多维表格 `record_id` 的形态，混了会看不出来源。 */
export const SHEET_ID_PREFIX = 'sh-'

/** 电子表格里最多认多少列（XFD = 16383）。防坏数据把循环拖死。 */
const MAX_COLUMN_INDEX = 16383

/**
 * 把表头文本归一成可比对的口径：去空白 / 全角空格 / 末尾冒号 / 统一小写。
 *
 * 真实表里「是否处理：」「 是否处理 」「是否处理:」三种写法到处都有，
 * 不归一就等于让人手工改表头。与 `source-wps/xlsx.js` 的 `normalizeHeaderKey`
 * 同一套口径 —— 两个源认同一张表时必须得出同样的映射。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeHeaderKey (text) {
  return String(text ?? '').replace(/[\s\u3000]+/g, '').replace(/[:：]+$/, '').toLowerCase()
}

/**
 * 合并别名覆盖：**合并而不是替换**。
 *
 * 配置里只想把「是否处理」改成「处理情况」时，其余列不该因此全都不认识。
 *
 * @param {Record<string, string[]>} [overrides]
 * @param {Record<string, string[]>} [base]
 * @returns {Record<string, string[]>}
 */
export function mergeSheetAliases (overrides, base = SHEET_COLUMN_ALIASES) {
  if (!overrides || Object.keys(overrides).length === 0) return base
  /** @type {Record<string, string[]>} */
  const merged = { ...base }
  for (const [field, names] of Object.entries(overrides)) {
    if (!Array.isArray(names) || names.length === 0) continue
    // 覆盖值排在最前面 = 优先级最高。人显式写下来的名字必须赢过内置别名。
    merged[field] = [...names.map(String), ...(base[field] ?? [])]
  }
  return merged
}

/**
 * **两种表型共用的列名解析**（工单 #21）。
 *
 * 电子表格靠「表头行的一组文字」认列，多维表格靠「表的字段名列表」认列 ——
 * 输入形态不同，但要做的事是同一件：把「语义字段」对上「表里那个真实名字」。
 * 以前这段逻辑只活在 `locateSheetHeader` 里，多维表格那边则是一个 `FEISHU_COLUMNS`
 * 硬编码常量，结果同一个插件对同一件事有两套标准：用户把现成的表搬进多维表格，
 * 列名一换就**静默扫出 0 张票**。
 *
 * 这里只做纯函数映射，不抛错也不猜：`required` 交给调用方，因为两种表型
 * 报错的措辞不一样（一个说「表头里找不到」，一个说「表里没有这个字段」）。
 *
 * @param {Object} input
 * @param {unknown[]} input.actualNames 表里真实存在的名字，**顺序即列顺序**
 * @param {Record<string, string[]>} [input.overrides] `match.sheetColumns` / `match.columns` 归一后的形状
 * @param {Record<string, string[]>} [input.aliases] 别名表（缺省电子表格那张）
 * @returns {{
 *   entries: Array<{ index: number, name: string, field: string | null }>,
 *   columns: Record<string, number>,
 *   names: Record<string, string>,
 *   missing: string[],
 * }}
 */
export function mapColumns ({ actualNames, overrides, aliases }) {
  const names = Array.isArray(actualNames) ? actualNames : []
  const merged = mergeSheetAliases(overrides, aliases ?? SHEET_COLUMN_ALIASES)

  // 归一后的名字 → 语义字段。同一个归一名字被两个字段抢时，先到先得（别名表顺序即优先级）。
  /** @type {Map<string, string>} */
  const lookup = new Map()
  for (const [field, list] of Object.entries(merged)) {
    for (const candidate of list) {
      const key = normalizeHeaderKey(candidate)
      if (key.length === 0 || lookup.has(key)) continue
      lookup.set(key, field)
    }
  }

  /** @type {Array<{ index: number, name: string, field: string | null }>} */
  const entries = []
  /** @type {Record<string, number>} */
  const columns = {}
  /** @type {Record<string, string>} */
  const found = {}
  for (let index = 0; index < names.length; index += 1) {
    const name = String(names[index] ?? '').trim()
    if (name.length === 0) continue
    const field = lookup.get(normalizeHeaderKey(name)) ?? null
    entries.push({ index, name, field })
    // 同一字段只认**第一列**：表里真有两列都叫「问题描述」时（导入常见空格差异），
    // 取靠左那列，并且不因此报错 —— 宽进严出，别让人为了这种小事改表。
    if (field !== null && columns[field] === undefined) {
      columns[field] = index
      found[field] = name
    }
  }

  const missing = REQUIRED_SHEET_FIELDS.filter((field) => columns[field] === undefined)
  return { entries, columns, names: found, missing }
}

/**
 * 把「插件认识的别名」摊成一句人话，用于「表头对不上」的报错。
 *
 * 报错里必须同时给**表里实际有什么**和**插件认识什么** —— 只给其中一半，
 * 人都得再去翻文档。
 *
 * @param {Record<string, string[]>} [aliases]
 * @returns {string}
 */
export function describeColumnAliases (aliases = SHEET_COLUMN_ALIASES) {
  return Object.entries(aliases)
    .filter(([, list]) => Array.isArray(list) && list.length > 0)
    .map(([field, list]) => `${field}（${list.slice(0, 3).join(' / ')}${list.length > 3 ? ' …' : ''}）`)
    .join('、')
}

/**
 * 把 `match.sheetColumns` 的形状归一成 `{ 字段: [别名...] }`。
 *
 * 用户可能写 `{ description: '缺陷描述' }`（单值）或
 * `{ description: ['缺陷描述', 'Bug 描述'] }`（数组）；两种都认。
 * 字段名必须是别名表里认识的，写错字段名要报错 —— 否则人以为自己覆盖了，
 * 实际上一个都没生效。
 *
 * @param {unknown} raw
 * @param {{ aliases?: Record<string, string[]>, optionName?: string }} [config]
 * @returns {Record<string, string[]> | undefined}
 */
export function resolveSheetColumns (raw, config = {}) {
  const aliases = config.aliases ?? SHEET_COLUMN_ALIASES
  const optionName = config.optionName ?? 'match.sheetColumns'
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PipelineError('invalid-input', `${optionName} 必须是对象：{ 字段: "实际表头文字" }`)
  }
  /** @type {Record<string, string[]>} */
  const out = {}
  for (const [field, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    if (!(field in aliases)) {
      throw new PipelineError(
        'invalid-input',
        `${optionName} 里的 "${field}" 不是认识的字段名。可用：${Object.keys(aliases).join(' / ')}`,
      )
    }
    const list = Array.isArray(value) ? value : [value]
    const names = list
      .filter((item) => typeof item === 'string')
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0)
    if (names.length === 0) {
      throw new PipelineError('invalid-input', `${optionName}.${field} 必须是非空字符串或字符串数组`)
    }
    out[field] = names
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 列号（0-based）→ Excel 列字母（0→A、26→AA）。
 * @param {number} index
 * @returns {string}
 */
export function columnLetter (index) {
  let n = Number(index)
  if (!Number.isInteger(n) || n < 0 || n > MAX_COLUMN_INDEX) {
    throw new PipelineError('invalid-input', `列号不合法：${index}（应在 0..${MAX_COLUMN_INDEX} 之间）`)
  }
  let out = ''
  n += 1
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/**
 * Excel 列字母 → 列号（0-based）。`A`→0、`AA`→26。
 * @param {string} letters
 * @returns {number}
 */
export function columnIndex (letters) {
  const text = String(letters ?? '').trim().toUpperCase()
  if (!/^[A-Z]+$/.test(text)) {
    throw new PipelineError('invalid-input', `列字母不合法：${letters}（只认 A..Z 的组合，例如 A、M、AA）`)
  }
  let n = 0
  for (const ch of text) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/**
 * 解析 `match.sheetRange`：`A1:M500` / `B2:K` / `A:Z` / 空。
 *
 * 只支持**单段**（设计 §11 Q2 已定）：多段就配多个 `projects[]` 条目。
 * 返回的 `startRow` / `endRow` 是 1-based 行号，`undefined` 表示「到末尾」。
 *
 * @param {unknown} raw
 * @returns {{ startColumn: number, startRow: number, endColumn?: number, endRow?: number } | undefined}
 */
export function parseSheetRange (raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return undefined
  const match = text.match(/^([A-Za-z]+)(\d*)(?::([A-Za-z]+)(\d*))?$/)
  if (!match) {
    throw new PipelineError(
      'invalid-input',
      `match.sheetRange 写法不认识："${text}"。支持 A1:M500 / B2:K / A:Z 这几种（只支持单段，多段请拆成多个项目条目）`,
    )
  }
  const startColumn = columnIndex(match[1])
  const startRow = match[2] ? Number(match[2]) : 1
  const endColumn = match[3] ? columnIndex(match[3]) : undefined
  const endRow = match[4] ? Number(match[4]) : undefined
  if (!Number.isInteger(startRow) || startRow < 1) {
    throw new PipelineError('invalid-input', `match.sheetRange 的起始行不合法："${text}"`)
  }
  if (endColumn !== undefined && endColumn < startColumn) {
    throw new PipelineError('invalid-input', `match.sheetRange 的结束列在起始列左边："${text}"`)
  }
  if (endRow !== undefined && endRow < startRow) {
    throw new PipelineError('invalid-input', `match.sheetRange 的结束行在起始行上边："${text}"`)
  }
  return { startColumn, startRow, endColumn, endRow }
}

/**
 * 从工作表清单里选出要读的那一张。
 *
 * 三条规则（设计 §5.1）：
 * - 给了 `sheetId`：必须在清单里，否则报错并列出全部工作表名
 *   （「拼错了」和「表被删了」在人看来是同一件事，但人需要看到现有清单才能改）。
 * - 给了 `sheetName`：必须**恰好命中 1 张**，命中多张就列出来让人指定。
 * - 都没给：取「第一张可见工作表」（`index` 最小且没被隐藏）。
 *   有多张可见表时仍按 `index` 取第一张，但会在返回的 `note` 里说明取的是哪张 ——
 *   不静默瞎猜，也不因为「不确定」就拒绝启动（人第一次接入时通常只有一张）。
 *
 * @param {any[]} sheets `sheets/query` 返回的 `data.sheets`
 * @param {{ sheetId?: string, sheetName?: string }} [options]
 * @returns {{ sheetId: string, title: string, index: number, hidden: boolean, note?: string }}
 */
export function resolveWorksheet (sheets, options = {}) {
  const list = (Array.isArray(sheets) ? sheets : [])
    .map((item) => ({
      sheetId: String(item?.sheet_id ?? ''),
      title: String(item?.title ?? ''),
      index: Number.isFinite(Number(item?.index)) ? Number(item.index) : 0,
      hidden: item?.hidden === true,
    }))
    .filter((item) => item.sheetId.length > 0)

  if (list.length === 0) {
    throw new PipelineError('invalid-input', '这张电子表格里没有任何工作表（sheets/query 返回空）。确认链接指向的是一张电子表格。')
  }

  const describe = () => list.map((item) => `${item.title}${item.hidden ? '（已隐藏）' : ''} [${item.sheetId}]`).join('、')

  const wantedId = String(options.sheetId ?? '').trim()
  if (wantedId.length > 0) {
    const hit = list.find((item) => item.sheetId === wantedId)
    if (!hit) {
      throw new PipelineError(
        'invalid-input',
        `match.sheetId="${wantedId}" 不在这张电子表格里。现有工作表：${describe()}`,
      )
    }
    return hit
  }

  const wantedName = String(options.sheetName ?? '').trim()
  if (wantedName.length > 0) {
    const hits = list.filter((item) => item.title === wantedName)
    if (hits.length !== 1) {
      throw new PipelineError(
        'invalid-input',
        hits.length === 0
          ? `match.sheetName="${wantedName}" 没匹配到任何工作表。现有工作表：${describe()}`
          : `match.sheetName="${wantedName}" 匹配到 ${hits.length} 张同名工作表，请改用 match.sheetId 指定。现有工作表：${describe()}`,
      )
    }
    return hits[0]
  }

  const visible = list.filter((item) => !item.hidden).sort((a, b) => a.index - b.index)
  const picked = visible[0] ?? list.slice().sort((a, b) => a.index - b.index)[0]
  return {
    ...picked,
    note: list.length > 1
      ? `没指定 match.sheetId / match.sheetName，取第一张可见工作表「${picked.title}」。这张表里有 ${list.length} 张工作表：${describe()}`
      : undefined,
  }
}

/**
 * 拼读值接口的 range 参数（**不含 sheetId 前缀**，那部分由调用方拼）。
 *
 * 形状：`A{headerRow}:{endCol}{endRow}`；尾部行号未知时只写到列（`A1:M`，
 * 表示「从第 1 行到末尾」）—— 读值接口支持这种开放式写法。
 *
 * @param {Object} input
 * @param {{ startColumn: number, startRow: number, endColumn?: number, endRow?: number }} input.range
 * @param {number} [input.endColumn] 显式给结束列（`sheetRange` 没写时用表头宽度兜底）
 * @returns {string}
 */
export function buildValueRange ({ range, endColumn }) {
  const start = `A${range.startRow}`
  const last = range.endColumn ?? endColumn ?? range.startColumn
  const endCol = columnLetter(Math.max(0, last))
  if (range.endRow !== undefined) return `${start}:${endCol}${range.endRow}`
  return `${start}:${endCol}`
}

/**
 * 在指定的表头行里认列名。
 *
 * 与金山源不同，**这里不往下扫**（设计 §11 Q3 已定）：电子表格的行身份依赖
 * 「数据行从表头下一行开始」这个事实，若自动往下找表头，行号身份就会和
 * 人看到的行号错位。表头不在第 1 行就请显式配 `match.sheetHeaderRow`。
 *
 * @param {any[]} values `valueRange.values` 二维裸值
 * @param {Object} [options]
 * @param {number} [options.headerRow] 表头行号（1-based）
 * @param {Record<string, string[]>} [options.columns] 别名覆盖
 * @returns {{ headerRow: number, columns: Record<string, number>, headers: string[] }}
 */
export function locateSheetHeader (values, options = {}) {
  const headerRow = Number(options.headerRow ?? DEFAULT_SHEET_HEADER_ROW)
  if (!Number.isInteger(headerRow) || headerRow < 1) {
    throw new PipelineError('invalid-input', `match.sheetHeaderRow 必须是 ≥1 的整数，实际是 ${options.headerRow}`)
  }
  const rows = Array.isArray(values) ? values : []
  const row = rows[headerRow - 1]
  if (!Array.isArray(row)) {
    throw new PipelineError(
      'invalid-input',
      `表头行（match.sheetHeaderRow=${headerRow}）读不到内容。这张表实际读到 ${rows.length} 行，确认范围 / 表头行号是否写对。`,
    )
  }

  // 认列这件事本身收敛进 `mapColumns()`：多维表格那边走的是同一个函数（工单 #21）。
  const { columns, missing } = mapColumns({ actualNames: row, overrides: options.columns })

  const headers = row.map((cell) => String(cell ?? '').trim()).filter((text) => text.length > 0)
  if (missing.length > 0) {
    const names = missing.map((field) => `${field === 'description' ? '“问题描述”' : '“是否处理”'}`).join(' 和 ')
    throw new PipelineError(
      'invalid-input',
      `表头里找不到 ${names} 列。读到 ${headerRow} 行的列名：${headers.join(' / ') || '（空）'}。`
        + '要么把表头改成这几个名字，要么用 match.sheetColumns / match.sheetHeaderRow 指明实际写法。',
    )
  }

  return { headerRow, columns, headers }
}

/**
 * 把一行裸值转成「按字段取值」的读取器。
 *
 * 电子表格的单元格是**裸值**（字符串 / 数字 / 布尔 / null），不像多维表格那样
 * 有 `{text}` / `[{text}]` 那种不稳定形状。所以这里只做字符串化 + 去空白。
 *
 * @param {any[]} row
 * @param {Record<string, number>} columns
 * @returns {(field: string) => string}
 */
export function cellReader (row, columns) {
  const cells = Array.isArray(row) ? row : []
  return (field) => {
    const index = columns[field]
    if (index === undefined) return ''
    const value = cells[index]
    if (value === null || value === undefined) return ''
    if (typeof value === 'string') return value.trim()
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (Array.isArray(value)) {
      return value.map((item) => (item === null || item === undefined ? '' : String(item).trim())).filter(Boolean).join(' ')
    }
    if (typeof value === 'object') {
      const obj = /** @type {Record<string, unknown>} */ (value)
      for (const key of ['text', 'name', 'value', 'link']) {
        if (key in obj) return String(obj[key] ?? '').trim()
      }
      return ''
    }
    return ''
  }
}

/**
 * 把序号列的值归一成「能当身份用」的样子。
 *
 * 电子表格里序号常常是数字（`1`）或者被填成 `1.0` / `" 1 "`；
 * 身份要稳定，所以统一按「去掉前后空白」的字符串算。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeSeqIdentity (text) {
  const raw = String(text ?? '').trim()
  if (raw.length === 0) return ''
  // `1.0` / `1` 指同一行，别因为一个人写了小数就换身份。
  if (/^\d+\.0+$/.test(raw)) return raw.replace(/\.0+$/, '')
  return raw
}

/**
 * 造行身份。
 *
 * 两种模式（设计 §5.4，用户拍板「B 方案 = 行号 / 序号」）：
 * - `seq`（缺省）：`sh-seq-<序号值>`；序号为空时**兜底**成 `sh-row-<行号>`，
 *   并在返回值的 `identitySource` 标 `fallback-row` —— 排障时要能看出这张票
 *   的身份是猜出来的。
 * - `row`：`sh-row-<物理行号>`，永远用行号。
 *
 * @param {Object} input
 * @param {'seq'|'row'} input.mode
 * @param {string} input.seqValue 序号列的值（已字符串化）
 * @param {number} input.rowNumber 这张表里的物理行号（1-based，和人在 Excel 里看到的一致）
 * @returns {{ recordId: string, identitySource: 'seq'|'row'|'fallback-row' }}
 */
export function buildRowIdentity ({ mode, seqValue, rowNumber }) {
  const row = Number(rowNumber)
  if (!Number.isInteger(row) || row < 1) {
    throw new PipelineError('invalid-input', `行号不合法：${rowNumber}`)
  }
  if (mode === 'row') {
    return { recordId: `${SHEET_ID_PREFIX}row-${row}`, identitySource: 'row' }
  }
  const seq = normalizeSeqIdentity(seqValue)
  if (seq.length === 0) {
    return { recordId: `${SHEET_ID_PREFIX}row-${row}`, identitySource: 'fallback-row' }
  }
  return { recordId: `${SHEET_ID_PREFIX}seq-${seq}`, identitySource: 'seq' }
}

/**
 * 优先级文本 → 内部档位。
 * @param {string} text
 * @returns {'high'|'medium'|'low'|undefined}
 */
export function sheetPriorityOf (text) {
  const key = String(text ?? '').trim().toLowerCase()
  if (key.length === 0) return undefined
  return SHEET_PRIORITY_MAP.get(key)
}

/**
 * 电子表格里的日期格子可能是 `2026-11-09`、`2026/11/9`、`2026年11月9日`，
 * 也可能是 Excel 序列号（读值接口有时给数字）。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSheetDate (value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 读值接口给的可能是毫秒时间戳，也可能是 Excel 序列号（~45000 量级）。
    const ms = value > 1e11 ? value : value > 20000 && value < 60000 ? (value - 25569) * 86400 * 1000 : value * 1000
    const date = new Date(ms)
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10)
    return ''
  }
  const text = String(value ?? '').trim()
  if (text.length === 0) return ''
  const cn = text.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/)
  if (cn) {
    return `${cn[1]}-${String(cn[2]).padStart(2, '0')}-${String(cn[3]).padStart(2, '0')}`
  }
  const sep = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (sep) {
    return `${sep[1]}-${String(sep[2]).padStart(2, '0')}-${String(sep[3]).padStart(2, '0')}`
  }
  return text
}

/**
 * 把读到的二维值转成「一行一张票」的中间形态。
 *
 * 这里只做**解析**，不碰水位 / 指纹 / 退役 —— 那些交给调用方（`index.js` 的
 * `scanSheet`），因为它们要和多维表格分支共用同一套水位语义。
 *
 * 处理的三件事：
 * 1. 跳过表头行及之前的行；
 * 2. 跳过整行空白（电子表格末尾常有一堆空行，值全 `null`）；
 * 3. 序号重复**直接报错**并列出重复值与行号 —— 不静默取第一个，
 *    否则同一张票会有两个身份，水位会来回抖（设计 §5.4 硬要求）。
 *
 * @param {Object} input
 * @param {any[]} input.values `valueRange.values`
 * @param {{ headerRow: number, columns: Record<string, number> }} input.header
 * @param {'seq'|'row'} [input.identity]
 * @param {string} [input.idColumn] 序号列的表头文字（缺省「序号」）
 * @param {(cell: unknown) => import('../../contracts/types.js').ScreenshotRef[]} input.extractScreenshots
 * @returns {Array<{ recordId: string, rowNumber: number, identitySource: string, cells: Record<string, string>, screenshots: any[] }>}
 */
export function parseSheetRows (input) {
  const values = Array.isArray(input.values) ? input.values : []
  const { headerRow, columns } = input.header
  const identityMode = input.identity === 'row' ? 'row' : 'seq'
  const idColumnName = String(input.idColumn ?? DEFAULT_SHEET_ID_COLUMN)
  const extract = input.extractScreenshots

  // 序号列的位置：优先按 sheetIdColumn 指定的表头文字在表头行里找；
  // 找不到就退回别名表给的 `seq` 列（「序号」「编号」都算）。
  let idColumnIndex = columns.seq
  if (idColumnIndex === undefined) {
    const wanted = normalizeHeaderKey(idColumnName)
    const headerRowCells = Array.isArray(values[headerRow - 1]) ? values[headerRow - 1] : []
    for (let i = 0; i < headerRowCells.length; i += 1) {
      if (normalizeHeaderKey(headerRowCells[i]) === wanted) {
        idColumnIndex = i
        break
      }
    }
  }
  if (identityMode === 'seq' && idColumnIndex === undefined) {
    // 没有序号列不致命：全部兜底成行号身份，但要说清楚为什么。
    idColumnIndex = -1
  }

  /** @type {Map<string, number[]>} 序号值 → 出现的行号列表 */
  const seqSeen = new Map()
  /** @type {any[]} */
  const out = []

  for (let i = headerRow; i < values.length; i += 1) {
    const row = values[i]
    if (!Array.isArray(row)) continue
    const rowNumber = i + 1
    const read = cellReader(row, columns)

    // 整行空白直接跳过：电子表格末尾的空白行不该变成票。
    const anyContent = row.some((cell) => String(cell ?? '').trim().length > 0)
    if (!anyContent) continue

    const cells = {}
    for (const field of Object.keys(columns)) cells[field] = read(field)
    if (idColumnIndex >= 0) {
      const seqRaw = row[idColumnIndex]
      cells.__seqCell = seqRaw === null || seqRaw === undefined ? '' : String(seqRaw).trim()
    } else {
      cells.__seqCell = ''
    }

    // 描述为空的行不是工单（表头下面常常有「合计」这类汇总行）。
    if (cells.description.length === 0) continue

    const identity = buildRowIdentity({ mode: identityMode, seqValue: cells.__seqCell, rowNumber })
    if (identityMode === 'seq' && identity.identitySource === 'seq') {
      const list = seqSeen.get(identity.recordId) ?? []
      list.push(rowNumber)
      seqSeen.set(identity.recordId, list)
    }

    const screenshotCell = columns.screenshot === undefined ? '' : row[columns.screenshot]
    out.push({
      recordId: identity.recordId,
      rowNumber,
      identitySource: identity.identitySource,
      cells,
      screenshots: extract ? extract(screenshotCell) : [],
    })
  }

  const duplicates = [...seqSeen.entries()].filter(([, rows]) => rows.length > 1)
  if (duplicates.length > 0) {
    throw new PipelineError(
      'invalid-input',
      '同一轮扫描里序号重复，无法确定行身份（会来回刷票）：'
        + duplicates.map(([id, rows]) => `${id.replace(SHEET_ID_PREFIX, '')} 出现在第 ${rows.join('、')} 行`).join('；')
        + '。请把序号列填成唯一值，或改用 match.sheetIdentity="row"（按行号当身份）。',
    )
  }

  return out
}
