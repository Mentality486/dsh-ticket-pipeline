// 演示平台：webform —— 一个内存表单工单源。
//
// 作用是验证 ADR-0001 的承诺：新增一个平台只需要
//   1. 这个目录（适配器自己，实现 TicketSource 契约）
//   2. src/index.js 的 SOURCES 表加一行
//   3. src/core/config.js 的 PLATFORMS 表加一个字符串
// 组合根与内核零改动。
//
// 场景：内部一个简单 HTTP 表单页收工单，配置里给 records（数组）即可，
// 每轮 scan 直接从数组读当前状态 —— 内容改了指纹就变，删除了就退役。

import { PipelineError } from '../../contracts/errors.js'
import { assertTicketSource } from '../../contracts/ticket-source.js'

// 平台能力：零依赖、无凭据、无截图，水位用适配器自带的内存兜底。
export const capabilities = Object.freeze([])

/**
 * @param {{
 *   projectId?: string,
 *   records?: Array<{ id: string, title?: string, description?: string, module?: string }>,
 *   now?: () => number,
 *   log?: any,
 * }} opts
 */
export function createWebformSource (opts = {}) {
  const projectId = opts.projectId ?? 'webform'
  const now = opts.now ?? Date.now
  const log = opts.log ?? console

  // 内存水位（capabilities 为空，宿主不会注入持久化水位 —— 语义见 source-wps 同款兜底）
  const memoryWatermark = new Map()

  return assertTicketSource({
    id: 'webform:' + projectId,
    projectId,
    platform: 'webform',

    // 扫描：把配置里的 records 当作表格当前快照。
    // 所有记录都算「处理中」（webform 没有状态列，收到的就是待办的）。
    async scan () {
      const records = Array.isArray(opts.records) ? opts.records : []
      const watermark = memoryWatermark.get(projectId) ?? { seen: {} }
      const created = []
      const updated = []
      const disappeared = []
      const live = new Set()

      for (const record of records) {
        const recordId = String(record?.id ?? '').trim()
        if (!recordId) continue
        live.add(recordId)
        const description = String(record?.description ?? record?.title ?? '').trim()
        // 指纹只含内容字段：标题/描述/模块任何一处变了都算修订。
        const fingerprint = 'webform:' + recordId + ':' + description + ':' + String(record?.module ?? '')
        const prev = watermark.seen[recordId]
        const ticket = {
          recordId,
          projectId,
          module: String(record?.module ?? ''),
          description,
          flow: '',
          priority: '',
          foundBy: '',
          foundAt: now(),
          fingerprint,
          screenshots: [],
        }
        if (!prev) {
          created.push(ticket)
          watermark.seen[recordId] = { tracked: true, fingerprint }
        } else if (prev.fingerprint !== fingerprint) {
          updated.push(ticket)
          watermark.seen[recordId] = { tracked: true, fingerprint }
        } else {
          watermark.seen[recordId] = { ...prev, tracked: true }
        }
      }

      // 掉出快照的行：退役（webform 是数组直配，删了就是删了，无需宽限期）。
      for (const recordId of Object.keys(watermark.seen)) {
        if (!live.has(recordId)) {
          disappeared.push(recordId)
          delete watermark.seen[recordId]
        }
      }

      memoryWatermark.set(projectId, watermark)
      log.info?.('[webform] 扫描完成：新增 ' + created.length + '，修订 ' + updated.length + '，退役 ' + disappeared.length)
      return { created, updated, disappeared }
    },

    // webform 无截图：契约上要能被问到并给出明确答案，而不是假装成功。
    async loadScreenshot () {
      throw new PipelineError('invalid-input', 'webform 平台的工单不带截图（screenshots 恒为空，不该被问到）')
    },
  })
}