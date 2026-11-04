/**
 * `domain.js` —— 本插件持久化状态所在的 storage-domain 声明。
 *
 * ## 为什么不 `import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'`
 *
 * 和 `config.js` 不 import schemastery 是同一个原因：`@deepseek-ai/dsh-storage-domain`
 * 是 DSH 宿主自己的包，只存在于 profile 的 `node_modules`（或 asar）里，从
 * `plugins/ticket-pipeline/` 顶层 import 会 `ERR_MODULE_NOT_FOUND`，离线自测跑不起来。
 *
 * 好在 `ctx.storageDomain.open(spec)` 并不要求 spec 由 `defineDomain` 造出来 ——
 * 读源码（`.scratch/_reference/pkg/storage-domain.js`）确认：`open()` 只读
 * `spec.name` / `spec.version` / `spec.tables` / `spec.global` / `spec.layout` /
 * `spec.compatibleVersions` / `spec.invalidRecords`，然后对每张表调
 * `tableSpec.valueSchema.parse(raw)`。`defineDomain` 只是**装载期校验**的身份函数，
 * 校验项（name/table 合 `UNIT_NAME_RE`、version 非负整数、global 不得接受 null）
 * 我们在这里手工满足即可。
 *
 * 关键约定：
 * - `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`，所以 domain 名不能有连字符，
 *   得是 `ticket_pipeline` 这种小写下划线形式；表名同理。
 * - 每条记录载入时会过一遍 `valueSchema.parse(raw)`。行的结构由 `store.js` 自己
 *   保证，这里用宽松的 `{ parse: (v) => v }` 即可；真要收紧再回来换 zod。
 */

/** 宽松 schema：只要求值非空对象，其余交给 `store.js` 的写入方保证。 */
const looseRecord = {
  parse (value) {
    if (value === null || value === undefined || typeof value !== 'object') {
      throw new Error('ticket_pipeline：记录必须是对象')
    }
    return value
  },
}

/**
 * 组装 domain spec，等价于 `defineDomain({...})` 的产物。
 *
 * @returns {{
 *   name: string,
 *   version: number,
 *   tables: Record<string, { valueSchema: { parse: (raw: unknown) => unknown } }>,
 * }}
 */
export function makeDomainSpec () {
  return {
    name: 'ticket_pipeline',
    version: 1,
    tables: {
      // 票据主表：key = recordId，value = TicketRecordRow。
      tickets: { valueSchema: looseRecord },
      // 扫描水位：key = sourceId，value = 各 source 自管的水位对象。
      watermarks: { valueSchema: looseRecord },
      // 票级租约：key = recordId，value = LeaseRow。
      leases: { valueSchema: looseRecord },
    },
  }
}
