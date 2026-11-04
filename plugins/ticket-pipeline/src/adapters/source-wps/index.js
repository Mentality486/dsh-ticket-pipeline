/**
 * `source-wps` —— 金山文档 / WPS 表格工单源。
 *
 * ## 为什么是「下载原始 xlsx 自己解」
 *
 * 金山文档开放平台的 `range_data` 对单元格图片只说 `is_cell_pic: true`，
 * 不给 URL、不给 bytes、不给附件 id，也没有任何接口能给出浮动图片的锚点行列。
 * 所以唯一能让「截图」真正进到任务书的做法是：按周期把整张表导成原始 `.xlsx`
 * （离线导出，不是逐格读），再自己解 OOXML —— 那是 `xlsx.js` + `zip.js` 干的事。
 *
 * 顺带的好处：导出走的是同一套文件格式，`source-xlsx` 那种「人在本地下载了一份表」
 * 的场景可以复用同一个解析器，只换 `fetchSheet`。
 *
 * ## 取数通道是注入的
 *
 * 本文件不碰网络、不认 token 细节：`fetchSheet()` 负责「给我一版最新的 xlsx 字节」。
 * 接真网关时只补这一个函数（用 token 下载文件），其余全部离线可测。
 * 默认实现直接报错并说清缺什么 —— 悄悄返回空数组会让流水线以为「表里没工单」。
 *
 * ## 硬约束（与飞书源同一套）
 *
 * - **绝不写回表格**：本文件只有读。
 * - 只认「是否处理 = 处理中」的行进入流水线。
 * - 记录身份用**行号**（见 `xlsx.js` 的 `buildRecordId`）：xlsx 没有平台级 record_id，
 *   行号是唯一跨轮次稳定又不需要额外状态的东西。代价（插行会让票换身份）写在那个函数上。
 */

import { PipelineError, toPipelineError } from '../../contracts/errors.js'
import { assertTicketSource, makeTicket } from '../../contracts/ticket-source.js'
import {
  DEFAULT_MEDIA_PREFIX,
  makeMediaToken,
  mediaTypeOf,
  normalizeBytes,
  parseWpsWorkbook,
  resolveMediaToken,
} from './xlsx.js'
import { readZipEntries, readZipEntry } from './zip.js'

/**
 * 这个工单源需要宿主注入哪些能力（T1 的声明式注入读这行）。
 *
 * 只要 `watermark`：内核把 `getWatermark` / `saveWatermark` 接进存储，
 * 否则每次重启都会把整张表当成「全都是新票」重新入队一遍。
 * 不要 secret（token 由 `fetchSheet` 的实现自己管）、不要 localFile（截图字节在 xlsx 里，不读盘）。
 */
export const capabilities = Object.freeze(['watermark'])

/** 收票只看这一列的这一值。与飞书源同一句话，方便人从两边对照。 */
export const IN_PROGRESS_VALUE = '处理中'

const MISSING_FETCH_SHEET =
  '金山文档源没有配置取数通道：请给 createWpsSource 传 fetchSheet()，让它返回当前表格导出的 xlsx 字节。' +
  '没有这一步就无法拿到单元格截图（开放接口只给 is_cell_pic 标记，不给图片字节）。'

/**
 * @typedef {Object} WpsSourceOptions
 * @property {string} [projectId] 所属项目名
 * @property {string} [sheetToken] 金山文档的表格 token（凭据由 fetchSheet 自己用）
 * @property {string} [sheetName] 指定工作表名
 * @property {string} [statusColumn] 「是否处理」列名
 * @property {string} [statusValue] 收票的状态值
 * @property {string} [mediaPrefix] 截图 fileToken 的前缀
 * @property {() => Promise<Uint8Array | ArrayBuffer>} [fetchSheet] 取数通道（注入）
 * @property {(sourceId: string) => Promise<any>} [getWatermark] 读水位
 * @property {(sourceId: string, value: any) => Promise<void>} [saveWatermark] 写水位
 * @property {number} [goneAfterScans] 连续多少轮没出现就退役（默认 3）
 * @property {() => number} [now]
 */

/**
 * 造一个金山文档工单源（每个项目一个实例）。
 *
 * @param {WpsSourceOptions} [options]
 * @returns {import('../../contracts/ticket-source.js').TicketSource & {
 *   projectId: string,
 *   fetchSheet: () => Promise<Uint8Array>,
 * }}
 */
export function createWpsSource (options = {}) {
  const projectId = typeof options.projectId === 'string' ? options.projectId : ''
  const sourceId = 'wps:' + (projectId || 'unnamed')
  const sheetName = String(options.sheetName ?? '')
  const statusColumn = String(options.statusColumn ?? '')
  const statusValue = String(options.statusValue ?? IN_PROGRESS_VALUE)
  const mediaPrefix = deriveMediaPrefix(options.mediaPrefix, projectId)
  const getWatermark = typeof options.getWatermark === 'function' ? options.getWatermark : null
  const saveWatermark = typeof options.saveWatermark === 'function' ? options.saveWatermark : null

  // 宿主没接水位持久化时退化为进程内内存：功能完整（同进程内两轮扫描不会重复收票），
  // 只是重启后会忘。capabilities 里的 'watermark' 就是告诉宿主「接了持久化可以不丢」。
  const memoryWatermark = new Map()
  const readWatermark = getWatermark ?? (async (id) => memoryWatermark.get(id))
  const writeWatermark = saveWatermark ?? (async (id, value) => { memoryWatermark.set(id, value) })
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const goneAfterScans = Math.max(1, Math.min(20, Number(options.goneAfterScans ?? 3) || 3))

  /**
   * 取数通道。默认实现**抛错而不是返回空**：空数组会被内核当成「这一轮表里没有工单」，
   * 于是所有票连续几轮不见 → 集体退役。那是比报错难查得多的故障。
   *
   * @returns {Promise<Uint8Array>}
   */
  const fetchSheet = async () => {
    if (typeof options.fetchSheet !== 'function') {
      throw new PipelineError('invalid-input', MISSING_FETCH_SHEET)
    }
    const value = await options.fetchSheet()
    try {
      // 取数通道允许两种返回：裸字节，或 `{ bytes }` 包一层（方便实现方附带 etag / 导出时间等元信息）。
      return normalizeBytes(value && typeof value === 'object' && 'bytes' in value ? value.bytes : value)
    } catch (error) {
      throw toPipelineError(error, 'invalid-input')
    }
  }

  /**
   * 解析一版字节 → 内部 Ticket。
   *
   * @param {Uint8Array} bytes
   * @returns {import('../../contracts/types.js').Ticket[]}
   */
  function toTickets (bytes) {
    const parsed = parseWpsWorkbook({
      bytes,
      sheetName,
      mediaPrefix,
      columnAliases: statusColumn ? { status: [statusColumn] } : undefined,
    })

    /** @type {import('../../contracts/types.js').Ticket[]} */
    const tickets = []
    for (const record of parsed.records) {
      // 截图三种形态在这里塌成两种：
      // - 附件：fileToken 指向 xlsx 里的条目，字节由 loadScreenshot 回来取；
      // - 人填的共享路径 / 链接：分别写成 path / url 引用。
      // 内核只认这三种 kind（见 contracts/types.js），所以不做别的归一。
      /** @type {import('../../contracts/types.js').ScreenshotRef[]} */
      const screenshots = []
      for (const token of record.screenshotTokens) {
        const media = parsed.media.get(token)
        /** @type {import('../../contracts/types.js').ScreenshotRef} */
        const ref = { kind: 'attachment', fileToken: token }
        if (media) {
          ref.name = media.name
          ref.size = media.data.length
        }
        screenshots.push(ref)
      }
      for (const text of record.screenshotRefs) {
        if (/^https?:\/\//i.test(text)) screenshots.push({ kind: 'url', url: text })
        else screenshots.push({ kind: 'path', path: text })
      }

      tickets.push(makeTicket({
        recordId: record.recordId,
        projectId,
        description: record.description,
        screenshots,
        seq: record.seq,
        department: record.department,
        foundAt: record.foundAt,
        module: record.module,
        flow: record.flow,
        priority: record.priority,
        status: record.status,
        raw: record.raw,
      }))
    }
    return tickets
  }

  /**
   * 扫一轮金山文档工单表。
   *
   * 与飞书源不同，这里没有分页与「早停」：一次导出就是全量。
   * 所以「没出现在这一轮」的判断是**确定的**，不需要 safePageRun 那种防误杀的机制。
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<import('../../contracts/ticket-source.js').ScanResult>}
   */
  async function scan (signal) {
    if (signal?.aborted) throw new PipelineError('aborted', '扫描被取消')
    const bytes = await fetchSheet()
    if (signal?.aborted) throw new PipelineError('aborted', '扫描被取消')

    /** @type {import('../../contracts/types.js').Ticket[]} */
    let tickets
    try {
      tickets = toTickets(bytes)
    } catch (error) {
      throw toPipelineError(error, 'invalid-input')
    }

    const watermark = (await readWatermark(sourceId)) ?? {}
    /** @type {Record<string, { fingerprint: string, missingScans: number, tracked?: boolean }>} */
    const seen = { ...(watermark.seen ?? {}) }

    /** @type {import('../../contracts/types.js').Ticket[]} */
    const created = []
    /** @type {import('../../contracts/types.js').Ticket[]} */
    const updated = []
    /** @type {string[]} */
    const disappeared = []
    const live = new Set()

    for (const ticket of tickets) {
      const recordId = ticket.recordId
      live.add(recordId)
      const inProgress = ticket.status === statusValue
      const prev = seen[recordId]

      if (!prev) {
        // 第一次看见。非「处理中」的行也记进水位（但不跟踪），
        // 免得下一轮它被拨成「处理中」时又被当成新票。
        seen[recordId] = { fingerprint: ticket.fingerprint, missingScans: 0, tracked: inProgress }
        if (inProgress) created.push(ticket)
        continue
      }

      if (!inProgress) {
        // 「否」= 待认领，「是」= 已闭环 —— 都不进流水线。之前跟踪过的行**不立刻退役**：
        // 人可能只是误勾，下一轮又拨回来。等同「这轮没出现」走 missingScans 计数，
        // 连续 goneAfterScans 轮都不是「处理中」了，才报 disappeared 让内核把票收尾。
        if (prev.tracked) {
          prev.missingScans = (prev.missingScans ?? 0) + 1
        }
        continue
      }

      prev.missingScans = 0

      if (!prev.tracked) {
        // 人把「是否处理」拨回「处理中」= 手动重置，要重新处理。
        prev.tracked = true
        created.push(ticket)
        continue
      }

      // 指纹只在真正收进 updated 时才更新：提前更新会让「非处理中期间改了内容」的修订永久丢失
      // （与飞书源同一个坑，那边有完整论证）。
      if (ticket.fingerprint !== prev.fingerprint) {
        updated.push(ticket)
        prev.fingerprint = ticket.fingerprint
      }
    }

    // 退役判定统一在这里做：行被删了（不在 live），或行还在但连续 goneAfterScans 轮都不是「处理中」。
    // xlsx 是一次全量导出，没有「没扫到的页」这回事，中途一次导出失败已经被上面抛错挡掉了。
    for (const [recordId, state] of Object.entries(seen)) {
      if (!live.has(recordId)) {
        state.missingScans = (state.missingScans ?? 0) + 1
      }
      if (!state.tracked) continue
      if ((state.missingScans ?? 0) >= goneAfterScans) {
        if (!disappeared.includes(recordId)) disappeared.push(recordId)
        delete seen[recordId]
      }
    }

    await writeWatermark(sourceId, { seen, lastScanAt: now() })

    return { created, updated, disappeared }
  }

  /**
   * 取截图字节。
   *
   * 附件形态的 token 指向 xlsx 里的 `xl/media/*`，所以这里要**重新拉一次表**：
   * 扫描时那份字节已经用完就丢，长久缓存整张表不值得（一张带图的问题表可能几十 MB），
   * 而取图发生在真正要跑这张票的时候，那时再取一次最新的也合理。
   *
   * 「token 在最新一版里找不到」不是内部错误：人可能已经把图换掉了。
   * 这时报 invalid-input，内核会把它标成 needs-info 让人确认，而不是反复重试。
   *
   * @param {import('../../contracts/types.js').ScreenshotRef} ref
   * @param {AbortSignal} [signal]
   * @returns {Promise<import('../../contracts/ticket-source.js').LoadedScreenshot>}
   */
  async function loadScreenshot (ref, signal) {
    if (signal?.aborted) throw new PipelineError('aborted', '取图被取消')
    if (!ref || typeof ref !== 'object') {
      throw new PipelineError('invalid-input', '截图引用不是对象')
    }

    if (ref.kind === 'attachment') {
      const fileToken = String(ref.fileToken ?? '')
      if (!fileToken) throw new PipelineError('invalid-input', '附件引用缺 fileToken')

      const bytes = await fetchSheet()
      if (signal?.aborted) throw new PipelineError('aborted', '取图被取消')

      /** @type {import('./zip.js').ZipEntry[]} */
      let entries
      let mediaPath
      try {
        entries = readZipEntries(bytes)
        mediaPath = resolveMediaToken(entries, fileToken, mediaPrefix)
      } catch (error) {
        throw toPipelineError(error, 'invalid-input')
      }
      if (!mediaPath) {
        throw new PipelineError('invalid-input',
          '表格最新一版里找不到这张截图（' + fileToken + '）：图可能已经被换掉或删掉，请人工确认这张工单还要不要图片')
      }

      const data = readZipEntry(bytes, entries, mediaPath)
      if (!data || data.length === 0) {
        throw new PipelineError('invalid-input', '截图在 xlsx 里是空的：' + mediaPath)
      }

      // 类型按扩展名判断而不是嗅探字节：xlsx 里的图片扩展名由写文件的工具决定，可信度足够，
      // 而 DSH 附件层只认这四类，猜错会让整票在渲染阶段炸掉。
      const mediaType = mediaTypeOf(mediaPath)
      if (!mediaType) {
        throw new PipelineError('invalid-input', '截图不是受支持的图片类型：' + mediaPath)
      }
      return { data, mediaType, name: ref.name ?? mediaPath.slice(mediaPath.lastIndexOf('/') + 1) }
    }

    if (ref.kind === 'path') {
      throw new PipelineError('invalid-input',
        '这张工单的截图是人填的共享路径（' + String(ref.path ?? '') + '），本适配器不读盘：' +
        '请把图贴进表格，或改走 feishu 源的路径形态')
    }

    if (ref.kind === 'url') {
      throw new PipelineError('invalid-input',
        '这张工单的截图是人填的链接（' + String(ref.url ?? '') + '），本适配器不代下载：' +
        '请把图贴进表格，或改走 feishu 源的链接形态')
    }

    throw new PipelineError('invalid-input', '认不出这张截图的形态，需要人补图')
  }

  return Object.assign(assertTicketSource({ id: sourceId, projectId, scan, loadScreenshot }), {
    projectId,
    fetchSheet,
    // 组合根（T1 的声明式注入）按**实例字段**判断要注入哪些能力：模块级导出只给 import 方看，
    // 挂到实例上能力注入才能在「只拿到 source 对象」的场景（如测试与将来的动态挂载）下工作。
    capabilities,
  })
}

/**
 * 截图 fileToken 的前缀必须**按项目区分**。
 *
 * 为什么不能都用默认前缀：两个项目各有一张 `xl/media/image1.png` 时，默认前缀会让
 * 两张不同的图得到同一个 token；内核按 token 缓存附件，于是 B 项目会拿到 A 项目的图。
 * 配置里显式给了前缀就照用（人可能要为兼容旧水位固定它）。
 *
 * @param {unknown} configured
 * @param {string} projectId
 * @returns {string}
 */
function deriveMediaPrefix (configured, projectId) {
  const explicit = String(configured ?? '').trim()
  if (explicit) return explicit
  return projectId ? DEFAULT_MEDIA_PREFIX + ':' + projectId : DEFAULT_MEDIA_PREFIX
}

/**
 * 从项目条目的 `match` 里摘出本适配器用得到的值。
 *
 * 与 `feishuOptionsFromMatch` 同形：组合根只要把 `match` 丢进来，不用知道每个平台有哪些键。
 *
 * @param {any} match 项目条目的 `match` 字段
 * @returns {{ sheetName: string, statusColumn: string, mediaPrefix: string }}
 */
export function wpsOptionsFromMatch (match) {
  const m = match ?? {}
  const options = {
    sheetName: String(m.sheetName ?? ''),
    statusColumn: String(m.statusColumn ?? ''),
    mediaPrefix: String(m.mediaPrefix ?? DEFAULT_MEDIA_PREFIX),
  }
  if (m.projectId !== undefined) options.projectId = String(m.projectId)
  if (m.goneAfterScans !== undefined) options.goneAfterScans = Number(m.goneAfterScans)
  if (m.statusValue !== undefined) options.statusValue = String(m.statusValue)

  // match 里给了 sheetUrl 时，翻译结果必须自带取数通道（createWpsSource 没有它直接报错）。
  // 这里用全局 fetch 下载导出文件：Node 18+ 内置 fetch，保持零 npm 依赖；
  // 真接开放平台网关时，宿主可以注入自己的 fetchSheet 把这个默认实现整个换掉。
  const sheetUrl = String(m.sheetUrl ?? '')
  if (sheetUrl) {
    options.sheetUrl = sheetUrl
    options.fetchSheet = async () => {
      const response = await fetch(sheetUrl, { redirect: 'follow' })
      if (!response.ok) {
        throw new PipelineError('invalid-input',
          '从 ' + sheetUrl + ' 下载表格失败：HTTP ' + response.status + '。' +
          '共享链接大概率需要登录态，请改用注入 fetchSheet 的方式接入。')
      }
      return new Uint8Array(await response.arrayBuffer())
    }
  }
  return options
}

export { makeMediaToken }
