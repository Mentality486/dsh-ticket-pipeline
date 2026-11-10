// 【已从产品里移除，仅作留档】演示平台：webform —— 一个内存表单工单源。
//
// 为什么删掉（2026-11-09，工单 #18）：
//   它的水位只存在内存里（见下面的 `memoryWatermark`），进程重启后全部丢失 ⇒
//   重启一次就把同一批工单当「新票」重收一遍。它也没有 writeResult（不回填）、
//   没有截图能力。留着它 = 留着一条「看起来能用、实际会重跑」的路，
//   而 `source-mock` 已经更好地承担了同一个角色（能落盘、能造票、是离线自测主力）。
//
// 为什么还留着这份文件：
//   它是 ADR-0001「新增一个平台只需要加一个目录」的第一个实证 —— 当年正是靠它
//   证明适配层边际成本极低。删实现、留证据：这个目录在 `scripts/` 下，
//   而发布白名单只含 `src/lib/locale/icon/patch`，所以它**不会进安装包**。
//   离线自测仍然 import 它来跑「recordIds 收窄」这类与平台无关的契约用例。
//
// 当年它验证的三件事（现在由 `source-mock` 承担）：
//   1. 这个目录（适配器自己，实现 TicketSource 契约）
//   2. src/index.js 的 SOURCES 表加一行
//   3. src/core/config.js 的 PLATFORMS 表加一个字符串
// 组合根与内核零改动。

import { PipelineError } from '../../../src/contracts/errors.js'
import { createRecordFilter } from '../../../src/contracts/record-filter.js'
import { assertTicketSource } from '../../../src/contracts/ticket-source.js'

// 平台能力：零依赖、无凭据、无截图，水位用适配器自带的内存兜底。
export const capabilities = Object.freeze([])

/**
 * @param {{
 *   projectId?: string,
 *   records?: Array<{ id: string, title?: string, description?: string, module?: string }>,
 *   recordIds?: string[] | string,
 *   now?: () => number,
 *   log?: any,
 * }} opts
 */
export function createWebformSource (opts = {}) {
  const projectId = opts.projectId ?? 'webform'
  const now = opts.now ?? Date.now
  const log = opts.log ?? console

  // 内存水位（capabilities 为空，宿主不会注入持久化水位 —— 语义见 source-wps 同款兜底）。
  // ⚠️ 这就是它被删掉的原因：重启即丢，同一批工单会被重收一遍。
  const memoryWatermark = new Map()

  // 收窄开关：各平台的语义必须完全一致，否则「试点一单」在换源时行为就变了。
  const recordFilter = createRecordFilter(opts.recordIds, 'webform 工单源 recordIds')

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
        // 名单外整行跳过，且在 live.add 之前：它这一轮既不收票，也不算「还在」。
        if (!recordFilter.allows(recordId)) continue
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
        if (!recordFilter.allows(recordId)) continue
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
