/**
 * `source-mock` —— 内存里的工单源。
 *
 * 它的价值不是「假装有工单」，而是**让整条链路能在不碰任何真实系统的情况下跑通**：
 * 不连飞书、不建 worktree、不开 MR、不发通知。开发时靠它迭代内核，
 * 也是「换适配器只需一个目录」这条验收标准的证据。
 *
 * 通用化之后，mock source 是**每个项目一个实例**：构造时带上 `projectId`，
 * 它生成的每张票都挂上这个 projectId，id 用 `mock:<projectId>` 保证多实例可区分。
 *
 * ## 为什么它也要过契约校验、也要给真 PNG
 *
 * mock 是别人照着写真实适配器的样板。样板自己不合契约（少方法、类型不对）等于把人教错，
 * 所以它在构造期就走一遍 `assertTicketSource`。
 *
 * 截图字节以前是「PNG 魔数 + 一堆零」：解出来根本不是图。它的下游是 DSH 附件层，
 * 那边会真的解码 —— 拿到坏图要么报错、要么静默丢图，而自测里全程看不到，
 * 因为没有人去解它。现在换成一张真的 1×1 图（合法的 IHDR/IDAT/IEND），
 * 让它走完附件库时和真实截图一样能被解开。
 */

import { assertTicketSource, makeTicket } from '../../contracts/ticket-source.js'
import { createRecordFilter } from '../../contracts/record-filter.js'
import { PipelineError } from '../../contracts/errors.js'

/**
 * 最小合法 PNG：1×1、RGBA、单个 IDAT。
 *
 * 为什么写死成常量而不是运行时现算：现算要 `zlib.deflateSync` 加一段 CRC 表，
 * 为了 70 个字节引入这些不划算；而这张图的内容没有意义（没有断言会去看像素），
 * 只要**字节合法**就够了。它由「IHDR + IDAT(未压缩块) + IEND」拼成，长度 70。
 */
const MINIMAL_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mOwbvr2HwAFYgKzQLzFTwAAAABJRU5ErkJggg=='

/**
 * 一条 mock 工单的种子数据形状。
 * @typedef {Object} MockTicketSeed
 * @property {string} recordId
 * @property {string} [seq]
 * @property {string} [department]
 * @property {string} description
 * @property {string} [foundAt]
 * @property {string} [module]
 * @property {string} [targetProject] 工单原文里的「待修改项目」列（只给模型参考，不参与主键）
 * @property {string} [flow]
 * @property {{ kind: 'path', path: string } | { kind: 'url', url: string } | { kind: 'attachment', fileToken: string }} [screenshot]
 * @property {'high'|'medium'|'low'} [priority]
 * @property {string} [status]
 */

/** 默认种子：三条覆盖不同优先级与不同模块，全部挂到「示例项目」下。 */
export const DEFAULT_SEEDS = Object.freeze([
  {
    recordId: 'rec-mock-001',
    seq: '1',
    department: '客服部',
    description: '列表页按状态筛选后，翻到第二页会跳回第一页',
    foundAt: '2026-11-01',
    module: '列表',
    flow: '列表-筛选',
    priority: 'high',
    status: '处理中',
  },
  {
    recordId: 'rec-mock-002',
    seq: '2',
    department: '工程部',
    description: '行程记录里出差天数算错，跨月时多算一天',
    foundAt: '2026-11-02',
    module: '行程记录',
    flow: '行程记录',
    priority: 'medium',
    status: '处理中',
  },
  {
    recordId: 'rec-mock-003',
    seq: '3',
    department: '销售部',
    description: '提交后状态不刷新，要手动刷新页面才看到结果',
    foundAt: '2026-11-03',
    module: '表单',
    flow: '表单-提交',
    priority: 'low',
    status: '处理中',
  },
])

/**
 * 回填到「表格」上的三列（与飞书适配器的 `FEISHU_COLUMNS` 同名同义）。
 *
 * 为什么 mock 也要有：自测要去断言「跑完一张票之后确实回填了三列」。
 * 只在飞书适配器里实现的话，这条链路在 dev-run 里就完全没覆盖 ——
 * 而它恰恰是唯一会**写远端**的动作，最该在离线环境里先跑通一遍。
 */
const WRITE_BACK_FIELDS = Object.freeze(['是否处理', '处理结果', '处理日期'])

/**
 * 造一个 mock 工单源。
 *
 * `seeds` 是可变数组 —— 测试里可以直接往里推、改字段，再调 `scan` 看内核反应。
 *
 * @param {Object} [options]
 * @param {string} [options.projectId] 本 source 所属项目；每张票都挂这个 projectId
 * @param {MockTicketSeed[]} [options.seeds]
 * @param {boolean} [options.failScan] 强制扫描失败（用来验证「扫失败要暴露出来」）
 * @param {boolean} [options.failScreenshot] 强制截图取不到（用来验证 needs-info 分支）
 * @param {boolean} [options.failWrite] 强制回填失败（用来验证「回填失败不影响票态」）
 * @param {number} [options.screenshotBytes] 假截图的目标字节数（只用于「大图」场景，边界见 loadScreenshot）
 * @returns {import('../../contracts/ticket-source.js').TicketSource & {
 *   projectId: string,
 *   seeds: MockTicketSeed[],
 *   writes: Array<{ recordId: string, status: string, result: string, handledAt: number }>,
 *   setFailScan: (v: boolean) => void,
 *   setFailScreenshot: (v: boolean) => void,
 *   setFailWrite: (v: boolean) => void,
 *   removeSeed: (recordId: string) => void,
 * }}
 */
export function createMockSource (options = {}) {
  const projectId = typeof options.projectId === 'string' && options.projectId.length > 0 ? options.projectId : 'demo'
  /** @type {MockTicketSeed[]} */
  const seeds = options.seeds ? [...options.seeds] : [...DEFAULT_SEEDS]

  /**
   * 水位：见过的 recordId → { 指纹, 连续几轮没出现 }。
   * 真实适配器（飞书）会把这个存到 `TicketStore` 里；mock 放内存就够，
   * 因为它的用途是「一次进程内跑完整链路」。
   * @type {Map<string, { fingerprint: string, missing: number }>}
   */
  const seen = new Map()

  let failScan = Boolean(options.failScan)
  let failScreenshot = Boolean(options.failScreenshot)
  let failWrite = Boolean(options.failWrite)
  const screenshotBytes = Number(options.screenshotBytes ?? 64)

  /**
   * 回填记录（只进内存，不碰任何真实系统）。
   *
   * 形状与真实适配器写出去的字段一一对应，自测直接断言它就知道「回填了什么」：
   * `status` 是落进「是否处理」的值，`result` 是「处理结果」，`handledAt` 是「处理日期」的时间戳。
   * @type {Array<{ recordId: string, status: string, result: string, handledAt: number }>}
   */
  const writes = []

  /** mock 的「删除行需连续几轮」—— 固定 3，与 `Config.goneAfterScans` 默认值一致。 */
  const GONE_AFTER_SCANS = 3

  // 收窄开关：mock 也要认，否则「先拿 mock 试跑单张票」这条最常用的验收路径走不通。
  // 语义与真实适配器完全一致（名单外整行跳过，语义见 contracts/record-filter.js）。
  const recordFilter = createRecordFilter(options.recordIds, 'mock 工单源 recordIds')

  /**
   * @param {MockTicketSeed} seed
   * @returns {import('../../contracts/types.js').Ticket}
   */
  function toTicket (seed) {
    /** @type {import('../../contracts/types.js').ScreenshotRef[]} */
    const screenshots = []
    if (seed.screenshot) screenshots.push(seed.screenshot)
    return makeTicket({
      recordId: seed.recordId,
      projectId,
      description: seed.description,
      screenshots,
      seq: seed.seq,
      department: seed.department,
      foundAt: seed.foundAt,
      module: seed.module,
      targetProject: seed.targetProject,
      flow: seed.flow,
      priority: seed.priority,
      status: seed.status,
      raw: seed,
    })
  }

  return assertTicketSource({
    id: `mock:${projectId}`,
    projectId,
    seeds,
    writes,

    /** @param {AbortSignal} signal */
    async scan (signal) {
      if (signal?.aborted) throw new PipelineError('aborted', '扫描被取消')
      if (failScan) {
        // 故意抛错：内核必须把「扫失败」和「没变化」区分开。
        throw new PipelineError('network', 'mock：模拟网络故障')
      }

      /** @type {import('../../contracts/types.js').Ticket[]} */
      const created = []
      /** @type {import('../../contracts/types.js').Ticket[]} */
      const updated = []
      /** @type {string[]} */
      const disappeared = []

      const live = new Set()

      for (const seed of seeds) {
        // 名单外整行跳过，且**必须在 live.add 之前**：否则它会被算成「这轮还在」，
        // 而它本来就该完全退出这一轮的所有判定。
        if (!recordFilter.allows(seed.recordId)) continue
        const ticket = toTicket(seed)
        live.add(seed.recordId)
        const previous = seen.get(seed.recordId)

        if (!previous) {
          // 只认「处理中」的票（与真实适配器一致）
          seen.set(seed.recordId, { fingerprint: ticket.fingerprint, missing: 0 })
          if (seed.status === '处理中') created.push(ticket)
          continue
        }

        previous.missing = 0
        if (previous.fingerprint !== ticket.fingerprint) {
          previous.fingerprint = ticket.fingerprint
          if (seed.status === '处理中') updated.push(ticket)
        }
      }

      // 没出现的行：连续 N 轮才退役
      for (const [recordId, state] of seen) {
        if (live.has(recordId)) continue
        state.missing += 1
        if (state.missing >= GONE_AFTER_SCANS) {
          disappeared.push(recordId)
          seen.delete(recordId)
        }
      }

      return { created, updated, disappeared }
    },

    /**
     * 造一张假截图。真适配器会去下载 / 读文件；这里只是让 `needs-info` 之外的路径可跑。
     * @param {import('../../contracts/types.js').ScreenshotRef} ref
     * @param {AbortSignal} signal
     */
    async loadScreenshot (ref, signal) {
      if (signal?.aborted) throw new PipelineError('aborted', '取图被取消')
      if (failScreenshot) {
        throw new PipelineError('not-found', 'mock：截图取不到')
      }
      if (ref.kind === 'unknown') {
        throw new PipelineError('invalid-input', 'mock：无法识别的截图引用')
      }
      // 一张真能被解码的 1×1 PNG（见 MINIMAL_PNG_B64）。补零的「假装是 PNG」会被附件层丢掉。
      //
      // `screenshotBytes` 仍然保留：有些自测要在「大图」上验证上限/分页行为，
      // 那时才需要凑够字节数 —— 把 IDAT 的负载重复到目标长度，外面仍是合法 PNG 容器。
      // 注意重复块里带着每块的 CRC，所以只能整块复制，不能简单补零。
      const png = Buffer.from(MINIMAL_PNG_B64, 'base64')
      let data = new Uint8Array(png)
      const target = Number.isInteger(screenshotBytes) && screenshotBytes > png.length ? screenshotBytes : 0
      if (target > 0) {
        // 取 IDAT 那一段（偏移 33 = 8 字节签名 + IHDR 块 25 字节；长度另算），重复填到目标长度，
        // 再补一个 IEND 收尾，保证 capstone 之前的内容都是合法块。
        const idatStart = 8 + 25
        const idatLen = png.readUInt32BE(idatStart)
        const idatChunk = png.subarray(idatStart, idatStart + 12 + idatLen)
        const head = png.subarray(0, idatStart)
        const tail = png.subarray(idatStart + 12 + idatLen)
        const parts = [head]
        let size = head.length + tail.length
        while (size + idatChunk.length <= target) {
          parts.push(idatChunk)
          size += idatChunk.length
        }
        parts.push(tail)
        data = new Uint8Array(Buffer.concat(parts))
      }
      return { data, mediaType: /** @type {const} */ ('image/png'), name: `${ref.kind}-shot.png` }
    },

    /**
     * 把回填记到内存里，返回与真实适配器同形状的回执。
     *
     * 缺省值与真实适配器保持一致（`status` 缺省「是」、`handledAt` 缺省当前时间），
     * 否则「用 mock 试跑一张票」的验收路径会跟线上行为对不上。
     *
     * @param {string} recordId
     * @param {import('../../contracts/ticket-source.js').WriteBackResult} payload
     * @param {AbortSignal} [signal]
     * @returns {Promise<import('../../contracts/ticket-source.js').WriteBackReceipt>}
     */
    async writeResult (recordId, payload, signal) {
      if (signal?.aborted) throw new PipelineError('aborted', '回填被取消')
      const id = String(recordId ?? '').trim()
      if (!id) throw new PipelineError('invalid-input', '回填缺 recordId，无法定位要写哪一行')
      if (!payload || typeof payload !== 'object' || typeof payload.result !== 'string') {
        throw new PipelineError('invalid-input', '回填内容必须是对象且带 result（「处理结果」要写什么）')
      }
      if (failWrite) {
        // 故意抛错：验证「回填失败只记日志，票态不回退」这条边界。
        throw new PipelineError('network', 'mock：模拟回填失败')
      }

      const status = typeof payload.status === 'string' && payload.status.trim().length > 0
        ? payload.status.trim()
        : '是'
      const handledAt = payload.handledAt === undefined ? Date.now() : Number(payload.handledAt)
      if (!Number.isFinite(handledAt) || handledAt <= 0) {
        throw new PipelineError('invalid-input', `回填的处理日期不是合法毫秒时间戳：${String(payload.handledAt)}`)
      }

      writes.push({ recordId: id, status, result: payload.result, handledAt })
      return { written: true, fields: [...WRITE_BACK_FIELDS] }
    },

    setFailScan (value) {
      failScan = Boolean(value)
    },

    setFailScreenshot (value) {
      failScreenshot = Boolean(value)
    },

    setFailWrite (value) {
      failWrite = Boolean(value)
    },

    removeSeed (recordId) {
      const index = seeds.findIndex((seed) => seed.recordId === recordId)
      if (index >= 0) seeds.splice(index, 1)
    },
  }, `TicketSource("mock:${projectId}")`)
}
