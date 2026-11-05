/**
 * `record-filter` —— 「只处理指定几张工单」的收窄开关。
 *
 * ## 为什么需要它
 *
 * 真实工单表里一行就是一件待办，但流水线不一定要一次吃掉整张表：
 * 新接一个平台时先挑一单试点，是最省事的验收方式。
 * 而「只收这几行」这件事**只能放在适配器层**：内核（scheduler）按 `projectId` 分区、
 * 按 `recordId` 建键，它不认识「白名单」这个概念；真要在内核里加，就得让内核去
 * 猜每个平台用什么标识去比 —— 那是把平台知识漏回内核，违反 ADR-0001。
 *
 * ## 语义（两条，都很重要）
 *
 * 1. **不在名单里的行不参与任何状态变化**：不收票、不算「这轮还在」、
 *    也不被累加 `missingScans`。这样「收窄期间」不会把名单外的旧票误判成「已删除」。
 * 2. **名单里的行照常判定**：整行从表里删掉了，连续几轮扫不到照样退役。
 *
 * 第 1 条是本文件存在的全部理由：只做「跳过收票」的话，名单外的旧票会在
 * 连续几轮扫描后被内核标成 `gone`（票被收尾），而人根本没打算动它们。
 *
 * 契约层不 import 适配器，适配器 import 契约层 —— 依赖方向单一。
 */

import { PipelineError } from './errors.js'

/**
 * 把配置里的 `recordIds` 归一成「一组 record_id」或者「不收窄」。
 *
 * 形态：
 * - 不给 / 给 null / 给空串 → **不收窄**（收整张表，与旧行为一致）；
 * - 给一个字符串 → 当成单元素集合；
 * - 给数组 → 取每个非空字符串并去重。
 *
 * 空数组是**配置错误**而不是「不收窄」：不收窄意味着「收整张表」，
 * 与调用方的字面意思（挑零张）正好相反，把它当成「全收」等于把闸门反锁了。
 * 所以这里抛 `invalid-input`，让配置层先拦下来。
 *
 * @param {unknown} value
 * @returns {string[] | null} null 表示不收窄
 */
export function resolveRecordIds (value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.length === 0) return null
    return [text]
  }
  if (!Array.isArray(value)) {
    throw new PipelineError('invalid-input', 'recordIds 必须是字符串或字符串数组')
  }
  /** @type {string[]} */
  const out = []
  for (const item of value) {
    if (item === undefined || item === null) continue
    const text = String(item).trim()
    if (text.length === 0) continue
    if (!out.includes(text)) out.push(text)
  }
  if (out.length === 0) {
    throw new PipelineError('invalid-input',
      'recordIds 不能是空数组：空数组表示「挑零张工单」，不能当成「不收窄」，否则会收下整张表')
  }
  return out
}

/**
 * 造一个收窄过滤器。
 *
 * @typedef {Object} RecordFilter
 * @property {boolean} enabled 是否启用收窄
 * @property {string[] | null} ids 生效的 record_id 集合（enabled 为 false 时是 null）
 * @property {(recordId: string) => boolean} allows 这行要不要参与收票与存活判定
 */

/**
 * @param {unknown} value 配置里的 recordIds
 * @param {string} [label] 报错时的来源说明
 * @returns {RecordFilter}
 */
export function createRecordFilter (value, label = 'recordIds') {
  /** @type {string[] | null} */
  let ids = null
  try {
    ids = resolveRecordIds(value)
  } catch (error) {
    if (error instanceof PipelineError) {
      throw new PipelineError('invalid-input', label + '：' + error.message)
    }
    throw error
  }
  const enabled = Array.isArray(ids) && ids.length > 0
  return {
    enabled,
    ids,
    allows: (recordId) => {
      if (!enabled) return true
      return /** @type {string[]} */ (ids).includes(String(recordId))
    },
  }
}
