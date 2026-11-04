/**
 * `gitlab-client` —— 把「改好的文件」物化成一个 draft MR 的最小 GitLab 客户端。
 *
 * 为什么需要它：本机 `git push` **物理上不可能**（沙箱不给 `git-receive-pack`
 * 建 stdin 管道，`fatal: unable to fork`）。所以改动不能靠推分支，只能走
 * GitLab 的 **Commits API** 把文件写进远端分支，再开 MR。这个文件就是那两步。
 *
 * 三条实测结论，每条都写在对应方法上，别再踩：
 * 1. 分支**已存在**时 GitLab 的 `POST /repository/branches` 也可能返回 201，
 *    所以 `ensureBranch` 必须先 `GET` 探测一次，不能只信 POST 的返回码。
 * 2. `POST /merge_requests` 的 `draft=true` 参数会被**静默忽略** ——
 *    想开 draft 只能让标题以 `Draft:` 开头，这一条必须由客户端自己保证。
 * 3. 二进制内容不能塞进 `content` 字段当文本发，要 `encoding: 'base64'`。
 *
 * 零依赖：只用运行时自带的 `fetch`（可注入，自测里换成假实现）。
 */

import { PipelineError, toPipelineError } from '../../contracts/errors.js'

/** 单个 HTTP 请求的超时。开 MR 不是高频操作，卡住比失败更糟。 */
const REQUEST_TIMEOUT_MS = 30_000

/** draft MR 的唯一可靠开关：标题前缀。 */
export const DRAFT_PREFIX = 'Draft:'

/**
 * 造一个 GitLab 客户端。
 *
 * @param {Object} options
 * @param {string} options.baseUrl GitLab 站点根地址，如 `https://gitlab.example.com`
 * @param {string|number} [options.projectId] 数字 id 或「命名空间/仓库名」（会被 URL 编码成路径）
 * @param {() => Promise<string|undefined>} [options.getSecret] 取 token；缺省读 `options.token`
 * @param {string} [options.secretRef] 凭据名，默认 `GITLAB_TOKEN`
 * @param {string} [options.token] 直接给 token（自测用；生产走 getSecret）
 * @param {typeof fetch} [options.fetch] 注入用（自测里换成假实现）
 * @param {(msg: string, detail?: unknown) => void} [options.log]
 * @param {number} [options.timeoutMs]
 */
export function createGitlabClient (options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const token = typeof options.token === 'string' ? options.token.trim() : ''
  const secretRef = typeof options.secretRef === 'string' && options.secretRef.length > 0 ? options.secretRef : 'GITLAB_TOKEN'
  const doFetch = options.fetch ?? globalThis.fetch
  const log = options.log ?? (() => {})
  const timeoutMs = Number(options.timeoutMs ?? REQUEST_TIMEOUT_MS)

  // projectId 允许两种写法：数字 id，或者带命名空间的路径。
  // 后者必须**整段** URL 编码（斜杠也要变成 %2F），否则 `/api/v4/projects/group/repo`
  // 会被 GitLab 当成别的路由 —— 这是 API 文档明确要求、却很容易漏的一步。
  const projectPath = encodeProjectId(options.projectId)

  /**
   * 按需取 token。不缓存：凭据服务里的值可能在运行期被人工换掉。
   * @returns {Promise<string>}
   */
  async function resolveToken () {
    if (typeof options.getSecret === 'function') {
      const value = await options.getSecret(secretRef)
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
    if (token.length > 0) return token
    // constructor 里不抛：插件装上时凭据往往还没配，抛在那里会让整个插件挂载失败。
    throw new PipelineError('auth', `gitlab：没有配置 ${secretRef}，无法访问 GitLab`)
  }

  /**
   * 一次 API 调用。所有错误分类都在这里做，上层方法只关心业务。
   *
   * @param {string} method
   * @param {string} apiPath 相对 `/api/v4` 的路径（已含前导斜杠）
   * @param {{ body?: any, signal?: AbortSignal, allow404?: boolean }} [opts]
   * @returns {Promise<{ status: number, body: any }>} allow404 且真 404 时 body 为 null
   */
  async function call (method, apiPath, opts = {}) {
    if (baseUrl.length === 0) {
      throw new PipelineError('invalid-input', 'gitlab：没有配置 baseUrl，无法访问 GitLab')
    }
    if (typeof doFetch !== 'function') {
      throw new PipelineError('internal', 'gitlab：当前运行时没有 fetch')
    }
    const auth = await resolveToken()

    // 外部 signal 与本地超时合成一个：单次请求超时是「这次没成」，不该一路挂到票超时。
    const controller = new AbortController()
    const outer = opts.signal
    const onOuterAbort = () => controller.abort(outer?.reason)
    if (outer) {
      if (outer.aborted) throw new PipelineError('aborted', 'gitlab：请求前已取消')
      outer.addEventListener('abort', onOuterAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(new Error('gitlab 请求超时')), timeoutMs)

    const url = `${baseUrl}/api/v4${apiPath}`
    try {
      const init = {
        method,
        headers: {
          'PRIVATE-TOKEN': auth,
          accept: 'application/json',
        },
        signal: controller.signal,
      }
      if (opts.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(opts.body)
      }

      const response = await doFetch(url, init)
      const status = Number(response?.status ?? 0)
      const payload = await readJson(response)

      if (status >= 200 && status < 300) return { status, body: payload }
      if (status === 404 && opts.allow404 === true) return { status, body: null }

      throw classify(status, payload, method, apiPath, response)
    } catch (error) {
      if (error instanceof PipelineError) throw error
      if (outer?.aborted) throw new PipelineError('aborted', 'gitlab：请求被取消', error)
      if (controller.signal.aborted) {
        throw new PipelineError('network', `gitlab：请求超时（${Math.round(timeoutMs / 1000)} 秒）`, error)
      }
      // fetch 自己抛的（DNS、TLS、连接被拒）一律按网络问题算 —— 可重试。
      throw toPipelineError(error, 'network')
    } finally {
      clearTimeout(timer)
      if (outer) outer.removeEventListener('abort', onOuterAbort)
    }
  }

  return {
    id: 'gitlab',
    baseUrl,
    projectPath,

    /**
     * 确保远端分支存在。
     *
     * 为什么先 GET：分支已存在时 `POST /repository/branches` 也可能返回 201，
     * 只看 POST 的返回码会把「早就存在」当成「刚建好」。先探测，存在就直接返回。
     *
     * @param {{ branch: string, ref: string, signal?: AbortSignal }} input
     * @returns {Promise<{ created: boolean, branch: string }>}
     */
    async ensureBranch ({ branch, ref, signal }) {
      assertName(branch, '分支名')
      if (typeof ref !== 'string' || ref.trim().length === 0) {
        throw new PipelineError('invalid-input', 'gitlab：ensureBranch 需要 ref（从哪个提交或分支切）')
      }
      const existing = await call('GET', `/projects/${projectPath}/repository/branches/${encodeURIComponent(branch)}`, { signal, allow404: true })
      if (existing.body) {
        log('gitlab：分支已存在，不重复创建', { branch })
        return { created: false, branch }
      }
      await call('POST', `/projects/${projectPath}/repository/branches`, {
        body: { branch, ref },
        signal,
      })
      log('gitlab：已创建分支', { branch, ref })
      return { created: true, branch }
    },

    /**
     * 一次提交多个文件改动（GitLab Commits API 的 `actions[]`）。
     *
     * 二进制（截图、字节码）走 `encoding: 'base64'`：字节直接塞进 JSON 的
     * `content` 会被当 UTF-8 解释，图片一律损坏。
     *
     * @param {{ branch: string, message: string, actions: Array<{action: 'create'|'update'|'delete'|'move', file_path: string, content?: string, encoding?: 'text'|'base64', previous_path?: string}>, signal?: AbortSignal }} input
     * @returns {Promise<{ id: string, shortId?: string, webUrl?: string }>}
     */
    async commitFiles ({ branch, message, actions, signal }) {
      assertName(branch, '分支名')
      if (typeof message !== 'string' || message.trim().length === 0) {
        throw new PipelineError('invalid-input', 'gitlab：commitFiles 需要 commit message')
      }
      if (!Array.isArray(actions) || actions.length === 0) {
        throw new PipelineError('invalid-input', 'gitlab：commitFiles 的 actions 不能为空（空提交没有意义）')
      }
      for (const action of actions) {
        if (!action || typeof action.file_path !== 'string' || action.file_path.length === 0) {
          throw new PipelineError('invalid-input', 'gitlab：每个 action 都必须有 file_path')
        }
        if (!['create', 'update', 'delete', 'move'].includes(action.action)) {
          throw new PipelineError('invalid-input', `gitlab：未知的 action "${String(action.action)}"`)
        }
      }

      const result = await call('POST', `/projects/${projectPath}/repository/commits`, {
        body: { branch, commit_message: message, actions },
        signal,
      })
      const body = result.body ?? {}
      log('gitlab：已提交', { branch, files: actions.length, id: body.id })
      /** @type {{ id: string, shortId?: string, webUrl?: string }} */
      const out = { id: String(body.id ?? '') }
      if (typeof body.short_id === 'string') out.shortId = body.short_id
      if (typeof body.web_url === 'string') out.webUrl = body.web_url
      return out
    },

    /**
     * 开 MR。**标题一律补 `Draft:` 前缀**。
     *
     * 为什么不用 `draft=true`：那个参数会被 GitLab 静默忽略，MR 会照常开成
     * 可合并状态 —— 流水线的产出必须是「待人审的草稿」，这条不能指望服务端。
     *
     * @param {{ sourceBranch: string, targetBranch: string, title: string, description?: string, signal?: AbortSignal }} input
     * @returns {Promise<{ iid: number, url: string, draft: true }>}
     */
    async createMergeRequest ({ sourceBranch, targetBranch, title, description, signal }) {
      assertName(sourceBranch, '源分支名')
      assertName(targetBranch, '目标分支名')
      if (typeof title !== 'string' || title.trim().length === 0) {
        throw new PipelineError('invalid-input', 'gitlab：createMergeRequest 需要标题')
      }
      const result = await call('POST', `/projects/${projectPath}/merge_requests`, {
        body: {
          source_branch: sourceBranch,
          target_branch: targetBranch,
          title: ensureDraftTitle(title),
          description: typeof description === 'string' ? description : '',
          // 照发 draft:true，只为让接口形状与真实 API 一致；
          // 真正生效的是标题前缀，代码里不要把期望寄托在这个字段上。
          draft: true,
        },
        signal,
      })
      const body = result.body ?? {}
      const iid = Number(body.iid)
      const webUrl = typeof body.web_url === 'string' ? body.web_url : ''
      if (!Number.isFinite(iid) || webUrl.length === 0) {
        throw new PipelineError('internal', 'gitlab：创建 MR 的响应里没有 iid 或 web_url（没法把链接给人）')
      }
      log('gitlab：已开 draft MR', { iid, webUrl })
      return { iid, url: webUrl, draft: true }
    },
  }
}

/**
 * 标题补 `Draft:`。已有前缀时**不重复加** —— 重复加会变成
 * "Draft: Draft: …"，人一眼就能看出是机器乱拼的。
 *
 * @param {string} title
 * @returns {string}
 */
export function ensureDraftTitle (title) {
  const trimmed = String(title ?? '').trim()
  // GitLab 同时认 "Draft:" 与旧写法 "WIP:"，两种都视为已经是草稿。
  if (/^(draft:|wip:)\s*/i.test(trimmed)) return trimmed
  return `${DRAFT_PREFIX} ${trimmed}`
}

/**
 * 把 HTTP 状态码翻译成内核认识的 `ErrorKind`。
 *
 * 分类依据是「内核拿到它会不会重试、要不要通知人」（见 `contracts/errors.js`）：
 * - 401/403：token 不对或没权限 —— 重试一万次也一样，必须人来修（auth）
 * - 404：projectId / 分支写错了，是配置问题（invalid-input，不是 not-found）
 * - 409：「远端状态与我的假设不一致」，等一下再试就能成（internal，可重试）
 * - 429：被限流，按服务端给的 Retry-After 等（rate-limit，带 retryAfterMs）
 * - 5xx：GitLab 自己挂了（network，可重试）
 *
 * @param {number} status
 * @param {any} payload
 * @param {string} method
 * @param {string} apiPath
 * @param {any} response
 * @returns {PipelineError}
 */
function classify (status, payload, method, apiPath, response) {
  const detail = describePayload(payload)
  const where = `${method} ${apiPath}${detail ? '：' + detail : ''}`
  if (status === 401 || status === 403) {
    return new PipelineError('auth', `gitlab：HTTP ${status}，token 无效或没有权限（${where}）`)
  }
  if (status === 404) {
    return new PipelineError('invalid-input', `gitlab：HTTP 404，projectId 或分支/资源不存在（${where}）`)
  }
  if (status === 409) {
    return new PipelineError('internal', `gitlab：HTTP 409，远端状态冲突，稍后重试（${where}）`)
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(response?.headers)
    return new PipelineError('rate-limit', `gitlab：HTTP 429，被限流（${where}）`, undefined, retryAfterMs)
  }
  if (status >= 500) {
    return new PipelineError('network', `gitlab：HTTP ${status}，服务端故障（${where}）`)
  }
  // 其余 4xx（400 参数错、422 语义错）都是「请求本身写错了」，重试没用。
  return new PipelineError('invalid-input', `gitlab：HTTP ${status}（${where}）`)
}

/**
 * 读 `Retry-After`。HTTP 允许两种写法：秒数，或 HTTP 日期。
 *
 * @param {any} headers
 * @returns {number|undefined}
 */
function parseRetryAfter (headers) {
  const raw = readHeader(headers, 'retry-after')
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(raw)
  if (Number.isFinite(at)) return Math.max(0, at - Date.now())
  return undefined
}

/**
 * 取一个响应头。`Headers` 与普通对象两种形状都认 —— 注入的假 fetch
 * 通常给普通对象，自测里不想为此专门造一个 `Headers` 实例。
 *
 * @param {any} headers
 * @param {string} name
 * @returns {string|undefined}
 */
function readHeader (headers, name) {
  if (!headers) return undefined
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return typeof value === 'string' ? value : undefined
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return typeof value === 'string' ? value : String(value)
  }
  return undefined
}

/**
 * 尽力读出响应体 JSON。读不出来不算错 —— 错误分类只看状态码，
 * 响应体只是用来让人看懂「为什么」。
 *
 * @param {any} response
 * @returns {Promise<any>}
 */
async function readJson (response) {
  if (!response) return null
  try {
    if (typeof response.json === 'function') return await response.json()
    if (typeof response.text === 'function') {
      const text = await response.text()
      return text.length > 0 ? JSON.parse(text) : null
    }
  } catch {
    return null
  }
  return null
}

/**
 * 从 GitLab 的错误体里抠一句人话。字段花样很多：
 * `{message}`（字符串或对象）、`{error}`、`{error_description}`。
 *
 * @param {any} payload
 * @returns {string}
 */
function describePayload (payload) {
  if (!payload || typeof payload !== 'object') return typeof payload === 'string' ? payload.slice(0, 200) : ''
  for (const key of ['message', 'error_description', 'error']) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) return value.slice(0, 200)
    if (value && typeof value === 'object') return JSON.stringify(value).slice(0, 200)
  }
  return ''
}

/**
 * 拼 baseUrl：去掉尾随斜杠与已经写进去的 `/api/v4`。
 * 人配 `https://gitlab.x/` 或 `https://gitlab.x/api/v4` 都会得到同样的结果。
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeBaseUrl (value) {
  if (typeof value !== 'string') return ''
  let url = value.trim().replace(/\/+$/, '')
  url = url.replace(/\/api\/v4$/, '')
  return url
}

/**
 * projectId 可以是数字 id，也可以是「命名空间/仓库名」路径；后者整段 URL 编码。
 *
 * @param {unknown} value
 * @returns {string}
 */
function encodeProjectId (value) {
  if (value === undefined || value === null || value === '') return ''
  const text = String(value).trim()
  if (/^\d+$/.test(text)) return text
  return encodeURIComponent(text)
}

/**
 * 参数自检。空分支名会拼出 `/repository/branches/`，那是对「分支列表」的请求，
 * 500 回来之后很难看出是「少填了一个参数」。
 *
 * @param {unknown} value
 * @param {string} label
 */
function assertName (value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PipelineError('invalid-input', `gitlab：${label}不能为空`)
  }
}
