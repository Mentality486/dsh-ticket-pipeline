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
 * ## 取数为什么必须有超时、字节上限与跳转校验
 *
 * 唯一摸网络的地方是 `wpsOptionsFromMatch` 给的那个 `fetchSheet` 默认实现。早先它是
 * 一行 `fetch(sheetUrl, { redirect: 'follow' })`，三件事全都没人管，而这三件事各自都够
 * 把流水线整条卡死：
 *
 * 1. **没有超时**：连接卡住时那个 Promise 永不 settle → `scan` 永不返回 → 内核这一轮的
 *    `running` 恒真、下一 tick 不再调度 → 整条流水线停摆。与「验证命令卡死」同一类故障，
 *    而且现场表现是「什么都没发生」，比报错难查得多。
 * 2. **没有字节上限**：一张带图的表可能几十 MB，遇到异常响应体（或者对方压根不结束的流）
 *    会把进程内存吃光。上限必须有，而且必须**边读边计数** —— 只看 `content-length` 挡不住
 *    谎报大小、chunked 编码、以及根本没有这个头的响应。
 * 3. **跳转不校验**：`redirect: 'follow'` 会在不通知我们的情况下跳到任意主机、任意协议。
 *    配置里人写的只是「一段共享链接」，跟着它跳进 `file:` 就等于让配置项去读服务器本地文件。
 *    所以改成自己逐跳跟，每跳都重新过一遍协议（与可选主机）校验。
 *
 * 这三件事都收在 `downloadSheetLimited()` 里，并且它是**导出**的（fetch 作为第一个参数注入）：
 * 超时 / 上限 / 跳转的断言全在 `wps-checks.mjs` 用假 fetch 跑，不联网、不拖慢 dev-run。
 *
 * ## 硬约束（与飞书源同一套）
 *
 * - **绝不写回表格**：本文件只有读。
 * - 只认「是否处理 = 处理中」的行进入流水线。
 * - 记录身份用**行号**（见 `xlsx.js` 的 `buildRecordId`）：xlsx 没有平台级 record_id，
 *   行号是唯一跨轮次稳定又不需要额外状态的东西。代价（插行会让票换身份）写在那个函数上。
 */

import { PipelineError, toPipelineError } from '../../contracts/errors.js'
import { createRecordFilter, resolveRecordIds } from '../../contracts/record-filter.js'
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
 * 再要 `scanTuning`：连续几轮扫不到就退役（goneAfterScans）来自全局配置。
 * 不要 secret（token 由 `fetchSheet` 的实现自己管）、不要 localFile（截图字节在 xlsx 里，不读盘）。
 */
export const capabilities = Object.freeze(['watermark', 'scanTuning'])

/** 收票只看这一列的这一值。与飞书源同一句话，方便人从两边对照。 */
export const IN_PROGRESS_VALUE = '处理中'

/**
 * 没配取数通道时的报错。**分两层**（工单 #20）：
 *
 * 第一层给用户 —— 他选了 `platform: 'wps'`，然后是「一张票都拿不到」。他不需要知道
 * 什么是 `fetchSheet`，需要知道的是「这个选项现在不能用，该改用什么」。
 * 第二层给要真正接它的人（缩进一行）—— 函数名、注入点、看哪个文件。
 *
 * 以前只有第二层，于是用户在 `pipeline_scan` 的报错里读到一句让他去给某个函数传参数的
 * 话 —— 那不是他能做的事，等于把内部实现细节当成了故障排除建议。
 */
const MISSING_FETCH_SHEET = [
  '金山文档源在当前版本没有可用的取数通道，选它会拿不到任何工单（一张都拿不到）。请改用飞书多维表格或飞书电子表格。',
  '改法：打开设置页「项目」，把这个项目的「平台」从 wps 改成 feishu，再把工单表链接贴进卡片里的「工单表链接」。',
  '',
  '  给要自行接入的人：金山源的取数通道是注入式的，需要给 createWpsSource 传 fetchSheet()，',
  '  让它返回当前表格导出的 xlsx 字节。见 plugins/ticket-pipeline/src/adapters/source-wps/index.js 模块注释。',
  '  （为什么不内置：开放平台只给 is_cell_pic 标记、不给图片字节，必须整表导出后自己解 OOXML。）',
].join('\n')

/**
 * @typedef {Object} WpsSourceOptions
 * @property {string} [projectId] 所属项目名
 * @property {string} [sheetToken] 金山文档的表格 token（凭据由 fetchSheet 自己用）
 * @property {string} [sheetName] 指定工作表名
 * @property {string} [statusColumn] 「是否处理」列名
 * @property {string} [statusValue] 收票的状态值
 * @property {string} [mediaPrefix] 截图 fileToken 的前缀
 * @property {(signal?: AbortSignal) => Promise<Uint8Array | ArrayBuffer>} [fetchSheet] 取数通道（注入）
 *   收到 signal 时必须尽快中断（默认的下载实现会把它接进 fetch）。
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
 *   fetchSheet: (signal?: AbortSignal) => Promise<Uint8Array>,
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
  // 收窄开关：与飞书源同一套语义（见 contracts/record-filter.js）。
  // 名单外的行整行跳过 —— 不收票、不算「这轮还在」、也不累加 missingScans，
  // 否则试点期间会把没打算动的旧票误判成「已删除」。
  const recordFilter = createRecordFilter(options.recordIds, '金山文档源 recordIds')
  const goneAfterScans = Math.max(1, Math.min(20, Number(options.goneAfterScans ?? 3) || 3))
  if (recordFilter.enabled && typeof options.log === 'function') {
    options.log('金山文档 工单收窄生效', { sourceId, recordIds: recordFilter.ids })
  }

  /**
   * 取数通道。默认实现**抛错而不是返回空**：空数组会被内核当成「这一轮表里没有工单」，
   * 于是所有票连续几轮不见 → 集体退役。那是比报错难查得多的故障。
   *
   * `signal` 必须一路透传下去（B8）：注入的 `fetchSheet` 实现（尤其是默认那个下载器）
   * 只有在拿到 signal 时才能在「内核取消整轮扫描」时立刻断开正在飞的连接。
   * 早先这里不传，取消只能在下载**前后**各查一次 → 一次卡住的下载要等到自己超时才停。
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<Uint8Array>}
   */
  const fetchSheet = async (signal) => {
    if (typeof options.fetchSheet !== 'function') {
      throw new PipelineError('invalid-input', MISSING_FETCH_SHEET)
    }
    try {
      const value = await options.fetchSheet(signal)
      // 取数通道允许两种返回：裸字节，或 `{ bytes }` 包一层（方便实现方附带 etag / 导出时间等元信息）。
      return normalizeBytes(value && typeof value === 'object' && 'bytes' in value ? value.bytes : value)
    } catch (error) {
      // **取数通道本身**抛的错也要过一遍归一：注入方（或默认下载器）抛的可能是裸 DOMException。
      // 取消尤其要紧 —— 不归一的话 `scan` 会把一个没有 `kind` 的错误往上抛，
      // 内核只能当 internal（可重试）处理，于是一次「要求停」变成了一轮重试。
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

      // 「待修改项目」列不能顶掉 projectId：那是配置里的项目名，也是存储复合主键的一部分。
      // 这一列是人手填的自由文本（可能写成「日报系统」，也可能是别的项目名），
      // 顶上去只会让同一张表的票散到不同主键下，还让「项目 → 本地仓库」的对应关系失效。
      // 所以它进 targetProject，跟任务书一起交给模型参考（见 core/prompt.js）。
      tickets.push(makeTicket({
        recordId: record.recordId,
        projectId,
        targetProject: record.projectId,
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
    const bytes = await fetchSheet(signal)
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
      // 收窄：必须在 live.add 之前跳过，否则名单外的行会被算成「这轮还在」，
      // 而它们本来就不该参与任何存活判定。
      if (!recordFilter.allows(recordId)) continue
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

      const bytes = await fetchSheet(signal)
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

// ── 受限下载：超时 / 取消 / 字节上限 / 逐跳校验 ──────────────────────────────
//
// 这一段的三个常量都是**缺省值**，调用方（测试、宿主）可以通过 options 覆盖：
// 断言超时的时候把 timeoutMs 传成 20ms 就行，不需要真等 30 秒。

/** 取一版 xlsx 的总时长上限（毫秒）。带图的问题表一般在几 MB 量级，30 秒足够宽松。 */
export const DEFAULT_SHEET_TIMEOUT_MS = 30_000

/** 单次取数的字节上限（10 MiB）。与飞书源取图用的是同一条量级判断。 */
export const DEFAULT_SHEET_MAX_BYTES = 10 * 1024 * 1024

/** 最多跟几跳重定向。登录墙一般一两跳就到位，再多就该怀疑是循环或者钓鱼链路。 */
export const MAX_SHEET_REDIRECTS = 3

/**
 * 把一个 options 里的数字取成干净的正整数。
 *
 * 为什么不用 `Number(x) || fallback`：那样 `0` 会被当成「没填」而静默替换成缺省值，
 * 而 `0` 在这里（尤其 maxRedirects）是有意义的值 —— 「一跳都不许跟」。
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @returns {number}
 */
function numberOption (value, fallback, min) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.floor(n))
}

/**
 * 给一次请求挂上超时，同时保留调用方的取消信号。
 *
 * 与飞书源的 `withTimeout` 同一套写法，理由也一样：只挂 `AbortSignal.timeout()`
 * 会让「内核取消整轮扫描」这件事传不进去 —— 那时正在飞的连接得等它自己超时才断，
 * 而扫描卡死正是这次要修的病根之一。两个信号谁先触发都要立刻中断，所以用 `AbortSignal.any`。
 *
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {AbortSignal}
 */
function withTimeout (signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeoutSignal
  return AbortSignal.any([signal, timeoutSignal])
}

/**
 * 区分「超时」与「被调用方取消」。两者都是 AbortError 家族，但处理方式完全不同：
 * 超时是网络故障（可重试），取消是内核让我们停（不能重试）。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isTimeoutError (error) {
  if (!error || typeof error !== 'object') return false
  const name = String(/** @type {any} */ (error).name ?? '')
  return name === 'TimeoutError' || /timed? ?out/i.test(String(/** @type {any} */ (error).message ?? ''))
}

/**
 * 算出这次取数允许落在哪些主机上。
 *
 * 缺省**只放行起点链接自己的主机**：`sheetUrl` 是人写在配置里的一段共享链接，
 * 人写的是哪台主机就只从哪台取。跳转目标则是远端返回的、人没写过的地址，
 * 不设限就等于让远端替我们决定去访问谁（内网地址 / 云元数据 / 本机服务）。
 * 确有跨主机跳转的需求时，用 `allowedHosts` 显式放行，支持 `*.example.com` 通配子域。
 *
 * @param {string} url
 * @param {unknown} configured
 * @returns {string[]}
 */
function resolveAllowedSheetHosts (url, configured) {
  const explicit = Array.isArray(configured) ? configured : (configured ? [configured] : [])
  const list = explicit.map((host) => String(host ?? '').trim().toLowerCase()).filter(Boolean)
  if (list.length > 0) return list
  try {
    return [new URL(url).hostname.toLowerCase()]
  } catch {
    // 链接本身都不合法，交给 assertSheetUrlAllowed 去报那句更准确的错。
    return []
  }
}

/**
 * 校验一跳地址：协议必须是 http/https，主机必须在放行表里。
 *
 * @param {string} rawUrl
 * @param {string[]} allowedHosts
 * @param {string} what 出错时的主语（「表格链接」/「表格链接的跳转目标」）
 * @returns {URL}
 */
function assertSheetUrlAllowed (rawUrl, allowedHosts, what) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new PipelineError('invalid-input', `${what}不是合法 URL：${rawUrl}`)
  }
  // 只认 http/https。`file:` 能直接读服务器本地文件，是这类「跟远端给的地址」最典型的
  // 升级路径；`data:` / `ftp:` 也没有正当用途。
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PipelineError('invalid-input',
      `${what}只允许 http / https，收到 ${parsed.protocol}：${rawUrl}`)
  }
  const host = parsed.hostname.toLowerCase()
  const allowed = allowedHosts.some((entry) => (
    entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry
  ))
  if (!allowed) {
    throw new PipelineError('invalid-input',
      `${what}指向未放行的主机 ${host}（放行：${allowedHosts.join(' / ') || '无'}）：${rawUrl}。` +
      '跳转目标是远端返回的、配置里没写过的地址，所以每一跳都要重新校验。')
  }
  return parsed
}

/**
 * 读响应体，边读边计数，超过上限立刻断连。
 *
 * 为什么不能只看 `content-length`：那个头是对方自己报的，可以谎报、可以没有
 * （chunked 编码），也可以是一个永远不结束的流。头里报了大小只是省一次读取，
 * 真正的保证必须在**读的过程中**。超限时主动 `reader.cancel()`，
 * 否则对方还在往里灌数据，读端已经没人要了。
 *
 * @param {any} response
 * @param {number} limit
 * @param {string} what
 * @returns {Promise<Uint8Array>}
 */
async function readBodyWithLimit (response, limit, what) {
  const declared = Number(response?.headers?.get?.('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > limit) {
    throw new PipelineError('invalid-input', `${what} 太大：${declared} 字节，超过上限 ${limit} 字节`)
  }

  const reader = response?.body?.getReader?.()
  if (!reader) {
    // 没有流式 body（老实现 / 测试桩）：只能整个读回来再量。
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > limit) {
      throw new PipelineError('invalid-input', `${what} 太大：${buffer.byteLength} 字节，超过上限 ${limit} 字节`)
    }
    return new Uint8Array(buffer)
  }

  /** @type {Uint8Array[]} */
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > limit) {
        throw new PipelineError('invalid-input', `${what} 太大：已读超过上限 ${limit} 字节，已中止下载`)
      }
      chunks.push(value)
    }
  } catch (error) {
    try { await reader.cancel() } catch { /* 断连失败不影响结论 */ }
    throw error
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * 从一段共享链接下载 xlsx 字节 —— **带超时、可取消、有字节上限、逐跳校验**。
 *
 * 这是本适配器唯一真正摸网络的函数，所以它被单独导出来：断言全部用假 fetch 注入，
 * 不联网、不确定、不拖慢 dev-run。`fetchImpl` 放第一个参数就是为了让这件事显眼。
 *
 * 三个缺省值（超时 30s / 10 MiB / 最多 3 跳）在 `options` 里都能覆盖，测试里传 20ms、几字节即可。
 *
 * 错误分类（内核按 kind 决策，所以这里分得很细）：
 * - `aborted`   —— 调用方的 signal 触发了（内核要停），不许再重试。
 * - `network`   —— 超时 / 连不上 / 传输中断，**可重试**。卡死的连接最终会落到这里，
 *                  而不是让 `scan` 永不返回。
 * - `invalid-input` —— 链接不合法、跳转到未放行的主机或非 http(s)、跳太多、HTTP 非 2xx、
 *                      响应体超过上限。这些都是「配置/远端有问题，重试没用」，要人改。
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {{ signal?: AbortSignal, timeoutMs?: number, maxBytes?: number,
 *   maxRedirects?: number, allowedHosts?: string[] }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function downloadSheetLimited (fetchImpl, url, options = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new PipelineError('internal', '下载表格需要注入一个 fetch 实现（Node 18+ 自带全局 fetch）')
  }
  const rawUrl = String(url ?? '').trim()
  if (!rawUrl) throw new PipelineError('invalid-input', '表格链接是空的，没法取数')

  const timeoutMs = numberOption(options.timeoutMs, DEFAULT_SHEET_TIMEOUT_MS, 1)
  const maxBytes = numberOption(options.maxBytes, DEFAULT_SHEET_MAX_BYTES, 1)
  const maxRedirects = numberOption(options.maxRedirects, MAX_SHEET_REDIRECTS, 0)
  const signal = options.signal
  const allowedHosts = resolveAllowedSheetHosts(rawUrl, options.allowedHosts)

  if (signal?.aborted) throw new PipelineError('aborted', '取表被取消')

  // 总超时按**整条重定向链**算，不是每跳各算一份：否则 3 跳 × 30 秒能拖到 90 秒，
  // 「卡死」只是从一轮延长成一分半。
  const deadline = Date.now() + timeoutMs
  let currentUrl = assertSheetUrlAllowed(rawUrl, allowedHosts, '表格链接').toString()

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new PipelineError('network', `下载表格超时（${timeoutMs}ms）：${rawUrl}`)
    }

    let response
    try {
      response = await fetchImpl(currentUrl, {
        method: 'GET',
        // 手动跟跳：这一层必须由我们逐跳校验，不能让 fetch 自己跳过去。
        redirect: 'manual',
        signal: withTimeout(signal, remaining),
      })
    } catch (error) {
      // 先看调用方信号：`AbortSignal.any` 里两个信号谁先触发都会 reject，
      // 判成「超时可重试」而实际是「内核要求停」会导致无谓的重试与更慢的收尾。
      if (signal?.aborted) throw new PipelineError('aborted', '取表被取消', error)
      if (isTimeoutError(error)) {
        throw new PipelineError('network', `下载表格超时（${timeoutMs}ms）：${currentUrl}`, error)
      }
      throw new PipelineError('network',
        '下载表格失败：' + (error instanceof Error ? error.message : String(error)), error)
    }

    const status = Number(response?.status ?? 0)
    const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308
    if (isRedirect) {
      if (hop === maxRedirects) {
        throw new PipelineError('invalid-input',
          `表格链接重定向超过 ${maxRedirects} 跳，当作可疑链接拒绝：${rawUrl}`)
      }
      const location = response.headers?.get?.('location') ?? ''
      if (!location) {
        throw new PipelineError('invalid-input', `表格链接返回 ${status} 但没有 Location：${currentUrl}`)
      }
      // 相对跳转要按当前地址解析，然后**重新**过一遍协议与主机校验 —— 每一跳都过。
      currentUrl = assertSheetUrlAllowed(
        new URL(location, currentUrl).toString(), allowedHosts, '表格链接的跳转目标').toString()
      continue
    }

    // 假 fetch / 极简实现可能不给 `ok` 字段，退化成按状态码判断。
    const ok = typeof response?.ok === 'boolean' ? response.ok : (status >= 200 && status < 300)
    if (!ok) {
      throw new PipelineError('invalid-input',
        '从 ' + currentUrl + ' 下载表格失败：HTTP ' + status + '。' +
        '共享链接大概率需要登录态，请改用注入 fetchSheet 的方式接入。')
    }

    return await readBodyWithLimit(response, maxBytes, '表格文件 ' + currentUrl)
  }

  // 理论上到不了这里（循环里有 return/throw），留个兜底免得返回 undefined 让上层拿到空表。
  throw new PipelineError('invalid-input', `表格链接重定向过多：${rawUrl}`)
}

/**
 * 从项目条目的 `match` 里摘出本适配器用得到的值。
 *
 * 与 `feishuOptionsFromMatch` 同形：组合根只要把 `match` 丢进来，不用知道每个平台有哪些键。
 *
 * @param {any} match 项目条目的 `match` 字段
 * @returns {{ sheetName: string, statusColumn: string, mediaPrefix: string,
 *   sheetUrl?: string, fetchSheet?: (signal?: AbortSignal) => Promise<Uint8Array> }}
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
  // 收窄开关：不写就不透传（空数组是配置错误，配置层先拦下）。
  if (m.recordIds !== undefined && m.recordIds !== null && m.recordIds !== '') {
    options.recordIds = resolveRecordIds(m.recordIds)
  }
  if (m.statusValue !== undefined) options.statusValue = String(m.statusValue)

  // match 里给了 sheetUrl 时，翻译结果必须自带取数通道（createWpsSource 没有它直接报错）。
  // 这里用全局 fetch 下载导出文件：Node 18+ 内置 fetch，保持零 npm 依赖；
  // 真接开放平台网关时，宿主可以注入自己的 fetchSheet 把这个默认实现整个换掉。
  //
  // 这个默认实现**必须**走 downloadSheetLimited：早先那版是一行
  // `fetch(sheetUrl, { redirect: 'follow' })` —— 无超时（连接卡住就是整条流水线停摆）、
  // 无字节上限（大响应体把内存吃光）、跳转不校验（远端能把我们导去 `file:` 或内网地址）。
  // 三个缺省值见文件头部的常量；宿主想改就整个换掉 fetchSheet。
  const sheetUrl = String(m.sheetUrl ?? '')
  if (sheetUrl) {
    options.sheetUrl = sheetUrl
    // 收下 signal：内核取消整轮扫描时，正在下载的那一次要能立刻断，而不是等它自己超时。
    options.fetchSheet = async (signal) => downloadSheetLimited(fetch, sheetUrl, { signal })
  }
  return options
}

export { makeMediaToken }
