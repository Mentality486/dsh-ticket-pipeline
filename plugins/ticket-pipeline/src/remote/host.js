/**
 * `remote/host.js` —— 把体检与配置快照挂成宿主 Remote。
 *
 * 只在**宿主**跑；浏览器侧拿 `remote/descriptors.js` 里的描述符去 `$mount`。
 *
 * 为什么不用 `@deepseek-ai/dsh-typert-protocol` 的 `@Remote` 装饰器：
 * 那个包从插件目录解析不到（不在本包 dependencies 里，见 `core/config.js` 的说明）。
 * 换成「`ctx.provide` + `ctx.typert.register`」的 strict 注册就够了 ——
 * 网关既认 strict 注册，也认反射出来的 `typertRemote` 绑定，两条路都通。
 *
 * `typertRemote` 字段是网关的**绑定校验**要的，不是注册要的：
 * `validateBinding()` 会检查 `binding.service === 实例本身`、
 * `binding.serviceKey === ctx.provide 的键`、`binding.namespace` 与描述符一致。
 * 三者对不上会抛 `gateway/binding-invalid`。
 */

import { runDoctor } from '../tools/pipeline-doctor.js'
import { TICKET_PIPELINE_DESCRIPTORS, TICKET_PIPELINE_NAMESPACE } from './descriptors.js'

/**
 * 服务本体。方法就是普通方法（网关按名字 `Reflect.get` 调用）。
 */
export class TicketPipelineRemote {
  /**
   * @param {Object} options
   * @param {() => unknown} options.getConfig
   * @param {import('../tools/pipeline-doctor.js').DoctorOptions} options.doctorOptions
   */
  constructor (options) {
    this.getConfig = options.getConfig
    this.doctorOptions = options.doctorOptions

    // 网关的绑定校验读这个字段（见文件头注释）。
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: TICKET_PIPELINE_NAMESPACE,
      namespace: TICKET_PIPELINE_NAMESPACE,
    })
  }

  /** 跑一次环境体检（与 `pipeline_doctor` 工具同一份逻辑）。 */
  async doctor () {
    return runDoctor({ ...this.doctorOptions, getConfig: this.getConfig })
  }

  /** 当前生效的配置快照（敏感项已打码，见 `describeConfig()`）。 */
  async config () {
    const { describeConfig } = await import('../core/config.js')
    const config = this.getConfig() ?? {}
    return {
      config: describeConfig(config),
      projects: Array.isArray(config.projects) ? config.projects.length : 0,
    }
  }
}

/**
 * 在插件 context 里挂载 Remote。
 *
 * `typert` 不是所有 profile 都一定有的服务，所以用 `ctx.inject` 做**可选**装配：
 * 服务缺席时这段整体跳过，插件其余部分照常工作（体检工具仍然能用）。
 *
 * @param {any} ctx 插件 context
 * @param {TicketPipelineRemote} service
 * @returns {boolean} 是否挂上
 */
export function mountTicketPipelineRemote (ctx, service) {
  const typert = ctx.get('typert')
  if (typert === undefined || typeof typert.register !== 'function') return false

  ctx.provide(TICKET_PIPELINE_NAMESPACE, service)
  typert.register({
    package: '@local/ticket-pipeline',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: TICKET_PIPELINE_DESCRIPTORS,
  })
  return true
}
