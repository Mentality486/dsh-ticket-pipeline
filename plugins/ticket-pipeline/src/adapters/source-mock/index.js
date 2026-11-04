/**
 * `source-mock` —— 内存里的工单源。
 *
 * 它的价值不是「假装有工单」，而是**让整条链路能在不碰任何真实系统的情况下跑通**：
 * 不连飞书、不建 worktree、不开 MR、不发通知。开发时靠它迭代内核，
 * 也是「换适配器只需一个目录」这条验收标准的证据。
 *
 * 通用化之后，mock source 是**每个项目一个实例**：构造时带上 `projectId`，
 * 它生成的每张票都挂上这个 projectId，id 用 `mock:<projectId>` 保证多实例可区分。
 */

import { makeTicket } from '../../contracts/ticket-source.js'
import { PipelineError } from '../../contracts/errors.js'

/**
 * 一条 mock 工单的种子数据形状。
 * @typedef {Object} MockTicketSeed
 * @property {string} recordId
 * @property {string} [seq]
 * @property {string} [department]
 * @property {string} description
 * @property {string} [foundAt]
 * @property {string} [module]
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
 * 造一个 mock 工单源。
 *
 * `seeds` 是可变数组 —— 测试里可以直接往里推、改字段，再调 `scan` 看内核反应。
 *
 * @param {Object} [options]
 * @param {string} [options.projectId] 本 source 所属项目；每张票都挂这个 projectId
 * @param {MockTicketSeed[]} [options.seeds]
 * @param {boolean} [options.failScan] 强制扫描失败（用来验证「扫失败要暴露出来」）
 * @param {boolean} [options.failScreenshot] 强制截图取不到（用来验证 needs-info 分支）
 * @param {number} [options.screenshotBytes] 假截图的字节数
 * @returns {import('../../contracts/ticket-source.js').TicketSource & {
 *   projectId: string,
 *   seeds: MockTicketSeed[],
 *   setFailScan: (v: boolean) => void,
 *   setFailScreenshot: (v: boolean) => void,
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
  const screenshotBytes = Number(options.screenshotBytes ?? 64)

  /** mock 的「删除行需连续几轮」—— 固定 3，与 `Config.goneAfterScans` 默认值一致。 */
  const GONE_AFTER_SCANS = 3

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
      flow: seed.flow,
      priority: seed.priority,
      status: seed.status,
      raw: seed,
    })
  }

  return {
    id: `mock:${projectId}`,
    projectId,
    seeds,

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
      // 最小合法 PNG 头 + 补零，够 `saveImage` 之外的逻辑用；真正的解码在 DSH 附件层。
      const data = new Uint8Array(screenshotBytes)
      data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
      return { data, mediaType: /** @type {const} */ ('image/png'), name: `${ref.kind}-shot.png` }
    },

    setFailScan (value) {
      failScan = Boolean(value)
    },

    setFailScreenshot (value) {
      failScreenshot = Boolean(value)
    },

    removeSeed (recordId) {
      const index = seeds.findIndex((seed) => seed.recordId === recordId)
      if (index >= 0) seeds.splice(index, 1)
    },
  }
}
