/**
 * 飞书工单表的 13 个语义字段 → 文档里写的标准列名。
 *
 * 为什么放在 `contracts/` 而不是 `adapters/source-feishu/`：
 *
 * 这张表有**三个**正当使用方，而且它们分属不同层：
 *
 * 1. `adapters/source-feishu/index.js` —— 多维表格分支的**缺省**列名映射
 *    （先按标准名猜，拿到 `fields` 接口的真实字段名后再覆盖，工单 #21）。
 * 2. `adapters/source-feishu/sheets.js` —— 电子表格分支的别名表以它为正名，
 *    两边共用一份，免得「多维表格认 13 个、电子表格认 15 个」慢慢分道扬镳。
 * 3. `core/config.js` —— 校验 `match.columns` 时要知道**哪些字段名是认识的**。
 *    配错一个字段名等于「配了但没生效」，那正是这个键要治的病，
 *    所以白名单必须与适配器认识的那份**是同一份**，不能各抄一遍。
 *
 * `core` 去 import `adapters` 是反向依赖，`adapters` 反向 import `core` 会成环；
 * 共用的常量放这层，两边都只依赖 `contracts/`，方向就顺了。
 *
 * 改这里的任何一个中文字，等于改对外的**缺省**列名（用户不改配置时认这些名字），
 * 保守起见别动；要支持别的叫法请往 `SHEET_COLUMN_ALIASES` 里加别名。
 */

/** @type {Record<string, string>} */
export const FEISHU_SEMANTIC_FIELDS = Object.freeze({
  seq: '序号',
  department: '发现部门',
  description: '问题描述',
  foundAt: '发现日期',
  module: '模块',
  flow: '操作流程',
  screenshot: '截图',
  priority: '优先级',
  status: '是否处理',
  handler: '处理人',
  result: '处理结果',
  handledAt: '处理日期',
  lastModified: '最后更新时间',
})

/**
 * 插件认识的 13 个语义字段名（`match.columns` / `match.sheetColumns` 的键白名单）。
 * @type {readonly string[]}
 */
export const FEISHU_SEMANTIC_FIELD_NAMES = Object.freeze(Object.keys(FEISHU_SEMANTIC_FIELDS))
