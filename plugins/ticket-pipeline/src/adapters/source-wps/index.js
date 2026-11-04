/**
 * `source-wps` —— 金山文档 / WPS 表格工单源。
 *
 * 状态：**不实现**（保留文件只为说明「这一层是可替换的，换平台不用动内核」）。
 *
 * 为什么不实现（`research/wps-report` 的结论，见地图 Decisions）：
 * 1. 只有轮询：WPS 开放平台的 28 个 `kso.*` 事件里**没有**表格内容或文件变更事件。
 * 2. **单元格图片拿不到字节**：`range_data` 只说 `is_cell_pic: true`，不给 URL、
 *    不给 bytes、不给附件 id；也没有任何 API 能给出浮动图片的锚点行列。
 *    唯一办法是下载原始 `.xlsx` 自己解 OOXML（`xl/media/*` + `xl/drawings/drawing*.xml`
 *    里的 `<xdr:from><xdr:col>/<xdr:row>`）—— 那是另一个规模的项目。
 * 3. 建应用要企业账号 + 管理员审批，免费个人号不在 v7 覆盖范围内。
 *
 * 对比之下飞书多维表格的附件是 record 的一等字段，`record_id` 直接就能取到图，
 * 不需要解压、不需要像素几何。这就是选飞书的原因。
 *
 * 真要接 WPS 时：复制这个目录改名，实现 `scan` 与 `loadScreenshot`，
 * 在 `src/index.js` 的 `SOURCES` 表里加一行 —— 内核一行都不用改。
 */

import { PipelineError } from '../../contracts/errors.js'
import { assertTicketSource } from '../../contracts/ticket-source.js'

const NOT_SUPPORTED = '金山文档适配器暂不实现：单元格图片取不到字节（见本文件顶部说明）。请把项目 match.platform 设为 feishu 或 mock。'

/**
 * @returns {import('../../contracts/ticket-source.js').TicketSource}
 */
export function createWpsSource () {
  return assertTicketSource({
    id: 'wps',
    async scan () {
      throw new PipelineError('invalid-input', NOT_SUPPORTED)
    },
    async loadScreenshot () {
      throw new PipelineError('invalid-input', NOT_SUPPORTED)
    },
  })
}
