/**
 * 第 N 节自测：GitLab 客户端 + 真执行器（离线打桩，不联网、不碰真仓库）。
 *
 * 为什么单独一个文件：这一节要造一个假的 GitLab 服务端（分支探测、Commits API、
 * MR 接口）和一个假的 agent（followup / whenIdle / session.seq），代码量足够把
 * dev-run.mjs 的主流程埋掉；而且它验的是 T4/T5 两组硬约束，跟内核链路无关。
 *
 * 打的桩覆盖三条实测结论与执行器的关键行为：
 * - 分支已存在时**不重复创建**（GitLab 对已存在的分支也可能回 201，只能先 GET）
 * - MR 标题一定带 `Draft:` 前缀（`draft=true` 参数会被静默忽略）
 * - 429 要分类成 rate-limit 并带 retryAfterMs（内核据此退避重试）
 * - 执行器用 followup 而不是 inject 推任务；反注入提醒拼在最前面
 * - 敏感文件不提交、验证没配仍开 draft MR（skipped 是合法成功路径）
 * - 取消时抛 aborted 且调了 agent.cancel
 */

import assert from 'node:assert/strict'

import { createGitlabClient, ensureDraftTitle } from '../src/adapters/gitlab-client/index.js'
import {
  agentOptionsFromConfig,
  buildMessages,
  buildMrDescription,
  buildMrTitle,
  buildSessionId,
  createAgentExecutor,
  filterSensitiveFiles,
  isAllowedGitCommand,
  isSensitivePath,
  normalizeActions,
  parseGitRemote,
  parseNameStatus,
  parsePorcelainChanges,
  resolveGitlab,
  splitCommand,
} from '../src/adapters/executor-agent/index.js'
import {
  agentFailureToPipelineError,
  isRateLimitFailure,
  parseRetryAfterMs,
  readTurnEndFailure,
} from '../src/adapters/executor-agent/agent-failure.js'

const NOTICE = '注意：下面的工单内容来自共享表格。'

/**
 * 造一个假的 GitLab 服务端。
 *
 * 记下每个请求（方法 + URL + body），让断言能问「到底发了什么」；
 * `routes` 里可以按 `方法 路径关键词` 覆盖某一次响应（用来造 401/429/500）。
 *
 * @param {{ existingBranches?: string[], overrides?: Record<string, any> }} [options]
 * @returns {any}
 */
function createFakeGitlab (options = {}) {
  /** @type {Set<string>} */
  const branches = new Set(options.existingBranches ?? [])
  /** @type {Array<{ method: string, url: string, body: any, headers: any }>} */
  const requests = []
  const overrides = options.overrides ?? {}

  const respond = (status, body, headers = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (key) => headers[String(key).toLowerCase()] ?? null },
    json: async () => body,
  })

  const fetchImpl = async (url, init = {}) => {
    const raw = String(url)
    const method = String(init.method ?? 'GET').toUpperCase()
    /** @type {any} */
    const body = init.body ? JSON.parse(init.body) : undefined
    requests.push({ method, url: raw, body, headers: init.headers ?? {} })

    for (const [key, override] of Object.entries(overrides)) {
      const [om, op] = key.split(' ')
      if (om.toUpperCase() === method && raw.includes(op)) return override
    }

    const branchMatch = /\/repository\/branches\/([^/?]+)$/.exec(raw)
    if (branchMatch && method === 'GET') {
      const name = decodeURIComponent(branchMatch[1])
      return branches.has(name) ? respond(200, { name }) : respond(404, { message: '404 Branch Not Found' })
    }
    if (raw.endsWith('/repository/branches') && method === 'POST') {
      // 真实 GitLab 在这里对已存在的分支也可能回 201 —— 桩也照这个来，
      // 客户端只能靠先 GET 才分得清。
      branches.add(body.branch)
      return respond(201, { name: body.branch })
    }
    if (raw.endsWith('/repository/commits') && method === 'POST') {
      return respond(201, { id: 'abc123def456', short_id: 'abc123d', web_url: 'https://gitlab.example.com/c/abc123d' })
    }
    if (raw.endsWith('/merge_requests') && method === 'POST') {
      return respond(201, { iid: 42, web_url: 'https://gitlab.example.com/mr/42', title: body.title })
    }
    // 列出源分支上已有的开放 MR（真实 GitLab 是 GET /merge_requests?state=opened&...）
    if (raw.includes('/merge_requests?') && method === 'GET') {
      const list = (options.openMergeRequests ?? []).map((item) => ({
        iid: item.iid,
        web_url: item.url ?? 'https://gitlab.example.com/mr/' + item.iid,
        title: item.title ?? 'Draft: 已有 MR',
        draft: item.draft !== false,
      }))
      return respond(200, list)
    }
    if (method === 'PUT' && /\/merge_requests\/\d+$/.test(raw)) {
      const iid = Number(/\/merge_requests\/(\d+)$/.exec(raw)[1])
      const put = (options.putMergeRequest ?? []).find((item) => item.iid === iid)
      if (put && put.fail) {
        return respond(put.status ?? 500, { message: put.message ?? '刷新失败' })
      }
      return respond(200, { iid, web_url: 'https://gitlab.example.com/mr/' + iid, title: body.title })
    }
    return respond(404, { message: `桩没实现 ${method} ${raw}` })
  }

  return { branches, requests, fetchImpl }
}

/**
 * 造一个客户端，指向假服务端。
 *
 * @param {any} server
 * @param {Record<string, any>} [extra]
 * @returns {any}
 */
function makeClient (server, extra = {}) {
  return createGitlabClient({
    baseUrl: 'https://gitlab.example.com',
    projectId: 'group/sub/repo',
    getSecret: async () => 'glpat-test',
    fetch: server.fetchImpl,
    ...extra,
  })
}

/**
 * 造一个假 agent。
 *
 * `whenIdle` 第一次返回时把 seq 推进一格（模拟「刚排上下一轮」），第二次才稳定 ——
 * 这正是 waitForAgentIdle 要处理的那种抖动。
 *
 * @param {{ onFollowup?: () => void, hangUntilAbort?: boolean, bumpSeqOnce?: boolean }} [options]
 * @returns {any}
 */
function createFakeAgent (options = {}) {
  /** @type {any[]} */
  const followups = []
  /** @type {any[]} */
  const injects = []
  let idleCalls = 0
  let cancelled = false
  let released = false
  let seq = 1
  /** 记录 setup 期间发生的事：preset 挂载、会话策略事件。 */
  const appends = []
  const mounts = []
  const state = { followups, injects, appends, mounts, get cancelled () { return cancelled }, get released () { return released } }
  /** @type {Array<() => void>} */
  const abortWaiters = []
  /**
   * 会话日志：宿主里 session.log 就是这样一个公开数组，
   * agent 这一轮为什么结束（turn/end）就在里面。
   */
  const sessionLog = []
  /** agent/error 的假订阅者。 */
  const errorListeners = []
  const agent = {
    status: 'idle',
    session: {
      get seq () { return seq },
      log: sessionLog,
      append (type, data) {
        appends.push({ type, data })
        sessionLog.push({ type, data })
      },
    },
    followup (message) {
      followups.push(message)
      // 「这一轮以什么结束」：真实宿主在 turn 收尾时会 append turn/end。
      // 可以给多条：最后一条才是这一轮的结论。
      for (const reason of options.turnEndReasons ?? (options.turnEndReason ? [options.turnEndReason] : [])) {
        sessionLog.push({ type: 'turn/end', data: { reason } })
      }
      // 「agent/error」事件：宿主 agent 自带的 ctx 上能订阅到。
      if (options.agentError) {
        for (const callback of errorListeners.slice()) {
          callback({ agent, error: options.agentError, turn: 1, step: 1 })
        }
      }
      options.onFollowup?.()
    },
    inject (message) {
      injects.push(message)
    },
    async whenIdle () {
      idleCalls += 1
      if (options.hangUntilAbort) {
        await new Promise((resolve) => abortWaiters.push(resolve))
        return
      }
      if (options.bumpSeqOnce !== false && idleCalls === 1) seq += 1
    },
    cancel () {
      cancelled = true
      for (const resolve of abortWaiters.splice(0)) resolve()
    },
    release () {
      released = true
    },
    /** 测试用：看清 whenIdle 被调了几次。 */
    get idleCalls () { return idleCalls },
  }
  if (options.agentError) {
    // 宿主里 agent 自带的 ctx 能订阅 agent/error；这里造一个同形的。
    agent.ctx = {
      on (name, callback) {
        if (name !== 'agent/error') return () => {}
        errorListeners.push(callback)
        return () => {
          const index = errorListeners.indexOf(callback)
          if (index >= 0) errorListeners.splice(index, 1)
        }
      },
    }
  }
  return { agent, state }
}

/**
 * 造一个只实现了 host 那部分能力的假 agentCtx（setup 回调拿到的第一个参数）。
 *
 * @param {{ presetError?: Error, presetIds?: string[] }} [options]
 * @returns {any}
 */
function createFakeAgentCtx (options = {}) {
  const state = { mounts: [], setCalls: [] }
  const presets = {
    list: async () => (options.presetIds ?? ['ptc', 'standard']).map((id) => ({ id })),
    mount: async (ctx, id) => {
      if (options.presetError) throw options.presetError
      state.mounts.push(id)
      return { id }
    },
  }
  const agentCtx = {
    get (name) {
      if (name === 'agentPresets') return presets
      if (name === 'workingDirectory') {
        return {
          get: () => undefined,
          set: async (_agent, path) => { state.setCalls.push(path); return path },
        }
      }
      return undefined
    },
  }
  return { agentCtx, state }
}

const TICKET = Object.freeze({
  recordId: 'rec-9',
  projectId: 'demo',
  fingerprint: 'fp',
  revisionCount: 1,
  seq: '17',
  description: '登录页点确认没反应',
  screenshots: [],
  raw: {},
})

/**
 * 造一套跑 `executor.run` 需要的上下文与注入。
 *
 * @param {{ files?: string[], verify?: any, gitStatusOutput?: string, agentOptions?: any, runCommandImpl?: any }} [options]
 * @returns {any}
 */
/**
 * 把 {path, status, from} 渲染成 `git diff --name-status` 的输出。
 *
 * @param {Array<{ path: string, status: string, from?: string }>} changes
 * @returns {string}
 */
function renderNameStatus (changes) {
  const letters = { create: 'A', update: 'M', delete: 'D', move: 'R100' }
  return changes.map((change) => {
    const letter = letters[change.status] ?? 'M'
    if (letter === 'R100') return `R100\t${change.from ?? change.path}\t${change.path}`
    return `${letter}\t${change.path}`
  }).join('\n')
}

/**
 * 把 {path, status, from} 渲染成 `git status --porcelain` 的输出。
 *
 * @param {Array<{ path: string, status: string, from?: string }>} changes
 * @returns {string}
 */
function renderPorcelain (changes) {
  const codes = { create: '??', update: ' M', delete: ' D', move: 'R ' }
  return changes.map((change) => {
    const code = codes[change.status] ?? ' M'
    if (code === 'R ') return `R  ${change.from ?? change.path} -> ${change.path}`
    return `${code} ${change.path}`
  }).join('\n')
}

function makeRunEnv (options = {}) {
  const gitServer = createFakeGitlab({ existingBranches: options.existingBranches ?? [] })
  /** @type {string[][]} */
  const gitCalls = []
  const { agent, state } = createFakeAgent(options)
  /** @type {any[]} */
  const created = []
  /** @type {string[]} */
  const phases = []
  const files = options.files ?? ['src/login.js', 'src/helper.js']
  const contents = options.contents ?? {}
  // git 视角的改动清单：默认全是「改现有文件」（M），要测新增/删除/重命名就传 changes。
  const changes = options.changes ?? files.map((path) => ({ path, status: 'update' }))

  // 宿主的 setup 是「publish 之前」调用的：这里照样在返回 agent 之前 await 它，
  // 这样断言能看到 preset 挂载与会话策略事件的真实顺序。
  const { agentCtx, state: setupState } = createFakeAgentCtx(options)
  let disposed = false
  Object.defineProperty(state, 'disposed', { get () { return disposed } })
  const agents = {
    create: async (input) => {
      created.push(input)
      await input.setup?.(agentCtx, agent)
      // 宿主里 agents.create 返回的就是 {agent, dispose}：拆除动作在 dispose 上。
      return {
        agent,
        dispose: async () => {
          disposed = true
          agent.release?.()
        },
      }
    },
  }

  const git = async (argv, _opts) => {
    gitCalls.push(argv)
    if (argv[0] === 'diff' && argv[1] === '--name-status') return { code: 0, stdout: renderNameStatus(changes), stderr: '' }
    if (argv[0] === 'diff' && argv[1] === '--name-only') return { code: 0, stdout: files.join('\n'), stderr: '' }
    if (argv[0] === 'status') return { code: 0, stdout: options.gitStatusOutput ?? renderPorcelain(changes), stderr: '' }
    if (argv[0] === 'add') return { code: 0, stdout: '', stderr: '' }
    if (argv[0] === 'show') {
      const path = String(argv[1]).replace(/^:0:/, '')
      return { code: 0, stdout: contents[path] ?? `content of ${path}`, stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }

  const executor = createAgentExecutor({
    agents,
    git,
    runCommand: options.runCommand ?? options.runCommandImpl,
    // 假服务端不需要真凭据；这里固定成注册表里的名字，免得自测依赖本机凭据。
    getSecret: async () => 'glpat-test',
    createGitlabClient: async (cfg) => createGitlabClient({ ...cfg, fetch: gitServer.fetchImpl }),
    prompts: { untrustedNotice: NOTICE },
  })

  const config = {
    provider: '',
    model: '',
    maxTokens: 4096,
    projects: [{
      name: 'demo',
      match: { platform: 'mock' },
      repo: { path: '/repo', remote: 'git@gitlab.example.com:group/sub/repo.git', baseBranch: 'main', targetBranch: 'main' },
      verify: options.verify,
    }],
  }

  const controller = new AbortController()
  const ctx = {
    signal: controller.signal,
    worktreePath: '/repo/.agents/worktrees/ticket-demo-rec-9-r1',
    branch: 'ticket-demo-rec-9-r1',
    baseCommit: 'base123',
    repoPath: '/repo',
    prompt: '任务书正文',
    content: [{ type: 'text', text: '任务书正文' }],
    images: [],
    config,
    log: () => {},
    onPhase: async (phase) => { phases.push(phase) },
  }

  return { executor, ctx, controller, state, agent, created, phases, gitCalls, gitServer, setupState, changes, ticket: TICKET, target: { repoPath: '/repo', remote: 'git@gitlab.example.com:group/sub/repo.git', baseBranch: 'main' } }
}

/**
 * 跑这一节的全部断言。
 *
 * @param {(name: string, fn: () => Promise<void> | void) => Promise<void>} check
 */
export async function runGitlabChecks (check) {
  // ── T4：GitLab 客户端 ──────────────────────────────
  await check('GitLab：分支已存在时只 GET 一次，不重复创建', async () => {
    // 为什么：真实 GitLab 对已存在的分支也可能回 201，只看 POST 的返回码会把
    // 「早就存在」当成「刚建好」，于是每次重跑都多一个 201 日志、还可能覆盖 ref。
    const server = createFakeGitlab({ existingBranches: ['ticket-demo-rec-9-r1'] })
    const client = makeClient(server)
    const out = await client.ensureBranch({ branch: 'ticket-demo-rec-9-r1', ref: 'main' })
    assert.equal(out.created, false, '分支已存在时 created 必须为 false')
    const posts = server.requests.filter((r) => r.method === 'POST')
    assert.equal(posts.length, 0, `已存在的分支不该再 POST，实际发了 ${posts.length} 次`)
    const gets = server.requests.filter((r) => r.method === 'GET')
    assert.equal(gets.length, 1, '应该只探测一次')
    assert.ok(gets[0].url.includes('/projects/group%2Fsub%2Frepo/repository/branches/'), `项目路径必须整段编码：${gets[0].url}`)
    assert.equal(gets[0].headers['PRIVATE-TOKEN'], 'glpat-test', 'token 必须走 PRIVATE-TOKEN 头')
  })

  await check('GitLab：分支不存在时先 404 探测、再 POST 创建', async () => {
    const server = createFakeGitlab({ existingBranches: [] })
    const client = makeClient(server)
    const out = await client.ensureBranch({ branch: 'ticket-new', ref: 'abc123' })
    assert.equal(out.created, true)
    assert.deepEqual(server.requests.map((r) => r.method), ['GET', 'POST'], '顺序必须是先探测后创建')
    assert.equal(server.requests[1].body.branch, 'ticket-new')
    assert.equal(server.requests[1].body.ref, 'abc123')
  })

  await check('GitLab：MR 标题一定带 Draft: 前缀（draft 参数会被静默忽略）', async () => {
    const server = createFakeGitlab({ existingBranches: ['ticket-x'] })
    const client = makeClient(server)
    const mr = await client.createMergeRequest({ sourceBranch: 'ticket-x', targetBranch: 'main', title: '修复登录' })
    assert.equal(mr.iid, 42)
    assert.equal(mr.draft, true)
    const post = server.requests.find((r) => r.method === 'POST' && r.url.endsWith('/merge_requests'))
    assert.ok(post, '应该调了 MR 接口')
    assert.ok(post.body.title.startsWith('Draft:'), `标题必须以 Draft: 开头，实际是「${post.body.title}」`)
    // 已经有前缀的不重复加，否则会变成「Draft: Draft: …」
    assert.equal(ensureDraftTitle('Draft: 修复登录'), 'Draft: 修复登录')
    assert.equal(ensureDraftTitle('WIP: 修复登录'), 'WIP: 修复登录')
    assert.equal(ensureDraftTitle('修复登录'), 'Draft: 修复登录')
  })

  await check('GitLab：源分支上已有开放 MR 时复用它，不重复开（重跑同一张票不能撞 409）', async () => {
    // 为什么：重跑同一张票时分支名不变（ticket-<project>-<record>-r1），
    // 远端那个 draft MR 还在。再 POST 就是 409，而 409 被归成可重试错误 ——
    // 等多久都不会自己好，票会一直失败。必须复用。
    const server = createFakeGitlab({
      existingBranches: ['ticket-demo-rec-9-r1'],
      openMergeRequests: [{ iid: 7, url: 'https://gitlab.example.com/mr/7', title: 'Draft: 上一轮开的' }],
    })
    const client = makeClient(server)
    const mr = await client.createMergeRequest({ sourceBranch: 'ticket-demo-rec-9-r1', targetBranch: 'main', title: '修复登录' })
    assert.equal(mr.iid, 7, '应该复用已有 MR 的 iid')
    assert.equal(mr.url, 'https://gitlab.example.com/mr/7')
    assert.equal(mr.draft, true)
    const posts = server.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/merge_requests'))
    assert.equal(posts.length, 0, '不该再 POST 一个 MR，实际发了 ' + posts.length + ' 次')
    const put = server.requests.find((r) => r.method === 'PUT')
    assert.ok(put, '复用时应该刷新已有 MR 的标题与描述')
    assert.ok(put.body.title.startsWith('Draft:'), '刷新后的标题也要带 Draft: 前缀')
  })

  await check('GitLab：已有 MR 不是草稿时不自动复用，要人处理', async () => {
    // 为什么：流水线只该产出「待人审的草稿」。远端那个是正式 MR，说明人已经在处理了，
    // 自动复用会改掉别人的东西。
    const server = createFakeGitlab({
      openMergeRequests: [{ iid: 9, url: 'https://gitlab.example.com/mr/9', title: '正式 MR', draft: false }],
    })
    const client = makeClient(server)
    await assert.rejects(
      () => client.createMergeRequest({ sourceBranch: 'ticket-x', targetBranch: 'main', title: '修复登录' }),
      (error) => {
        assert.equal(error.kind, 'internal')
        assert.ok(/不是草稿/.test(error.message), '错误文案要说清是「不是草稿」，实际是 ' + error.message)
        return true
      },
    )
  })

  await check('GitLab：POST 撞上 409 时再查一次并复用竞态出来的 MR', async () => {
    // 为什么：查「有没有已有 MR」和 POST 之间存在窗口，别人刚好开了一个。
    // 这时再查一次拿到就复用，不要把 409 直接抛出去。
    let mrListCalls = 0
    const server = createFakeGitlab({
      overrides: {
        'POST /merge_requests': {
          status: 409,
          ok: false,
          headers: { get: () => null },
          json: async () => ({ message: '此源分支已存在另一个开放的合并请求：!3' }),
        },
      },
    })
    const baseFetch = server.fetchImpl
    server.fetchImpl = async (url, init) => {
      const method = String(init?.method ?? 'GET').toUpperCase()
      if (method === 'GET' && String(url).includes('/merge_requests?')) {
        mrListCalls += 1
        if (mrListCalls === 1) return { status: 200, ok: true, headers: { get: () => null }, json: async () => [] }
        return {
          status: 200, ok: true, headers: { get: () => null },
          json: async () => [{ iid: 3, web_url: 'https://gitlab.example.com/mr/3', title: 'Draft: 竞态出来的' }],
        }
      }
      return await baseFetch(url, init)
    }
    const client = makeClient(server)
    const mr = await client.createMergeRequest({ sourceBranch: 'ticket-x', targetBranch: 'main', title: '修复登录' })
    assert.equal(mr.iid, 3, '竞态出来的 MR 应该被复用')
    assert.equal(mr.draft, true)
  })

  await check('GitLab：刷新已有 MR 失败不把整张票判死', async () => {
    // 为什么：标题已经带 Draft: 前缀，描述过时不影响「这是草稿、要人审」这件事。
    const server = createFakeGitlab({
      openMergeRequests: [{ iid: 11, url: 'https://gitlab.example.com/mr/11' }],
      putMergeRequest: [{ iid: 11, fail: true, status: 500 }],
    })
    const client = makeClient(server)
    const mr = await client.createMergeRequest({ sourceBranch: 'ticket-x', targetBranch: 'main', title: '修复登录' })
    assert.equal(mr.iid, 11, '刷新失败也要把已有 MR 的链接交出去')
  })
  await check('GitLab：429 分类成 rate-limit 并带 retryAfterMs', async () => {
    // 为什么：内核靠 kind 决定「能不能重试」、靠 retryAfterMs 决定「等多久」。
    // 分类错了就会被当成 fatal 直接通知人，或者立刻重试再次撞墙。
    const server = createFakeGitlab({
      overrides: {
        'POST /merge_requests': {
          status: 429,
          ok: false,
          headers: { get: (key) => (String(key).toLowerCase() === 'retry-after' ? '3' : null) },
          json: async () => ({ message: 'Too many requests' }),
        },
      },
    })
    const client = makeClient(server)
    await assert.rejects(
      () => client.createMergeRequest({ sourceBranch: 'a', targetBranch: 'b', title: 'x' }),
      (error) => {
        assert.equal(error.kind, 'rate-limit', `kind 应该是 rate-limit，实际是 ${error.kind}`)
        assert.equal(error.retryable, true, 'rate-limit 必须可重试')
        assert.equal(error.retryAfterMs, 3000, `retryAfterMs 应该是 3000，实际是 ${error.retryAfterMs}`)
        return true
      },
    )
  })
  await check('GitLab：状态码分类与可重试性对得上', async () => {
    const cases = [
      [401, 'auth', false],
      [403, 'auth', false],
      [404, 'invalid-input', false],
      [409, 'internal', true],
      [500, 'network', true],
    ]
    for (const [status, kind, retryable] of cases) {
      const server = createFakeGitlab({
        overrides: {
          'POST /merge_requests': { status, ok: false, headers: { get: () => null }, json: async () => ({ message: 'x' }) },
        },
      })
      const client = makeClient(server)
      await assert.rejects(
        () => client.createMergeRequest({ sourceBranch: 'a', targetBranch: 'b', title: 'x' }),
        (error) => {
          assert.equal(error.kind, kind, `HTTP ${status} 应归成 ${kind}，实际 ${error.kind}`)
          assert.equal(error.retryable, retryable, `HTTP ${status} 的 retryable 应为 ${retryable}`)
          return true
        },
      )
    }
  })

  await check('GitLab：没有 token 时是 auth 错误，且不会发出请求', async () => {
    const server = createFakeGitlab({ existingBranches: ['a'] })
    const client = createGitlabClient({ baseUrl: 'https://gitlab.example.com', projectId: 7, fetch: server.fetchImpl })
    await assert.rejects(
      () => client.ensureBranch({ branch: 'a', ref: 'main' }),
      (error) => error.kind === 'auth' && /GITLAB_TOKEN/.test(error.message),
      '缺 token 必须报 auth 并点名 GITLAB_TOKEN',
    )
    assert.equal(server.requests.length, 0, '没有凭据就不该发请求')
  })

  await check('GitLab：数值 projectId 原样进 URL，baseUrl 里的 /api/v4 去重', async () => {
    const server = createFakeGitlab({ existingBranches: ['a'] })
    const client = createGitlabClient({ baseUrl: 'https://gitlab.example.com/api/v4', projectId: 123, token: 't', fetch: server.fetchImpl })
    await client.ensureBranch({ branch: 'a', ref: 'main' })
    const url = server.requests[0].url
    assert.ok(url.startsWith('https://gitlab.example.com/api/v4/projects/123/repository/branches/'), `URL 拼错了：${url}`)
  })
  // ── T5：executor-agent ────────────────────────────
  await check('执行器：没有 agents 服务时报 invalid-input，说清缺什么', async () => {
    const executor = createAgentExecutor({})
    await assert.rejects(
      () => executor.run(TICKET, { repoPath: '/repo' }, { signal: new AbortController().signal, worktreePath: '/w', onPhase: async () => {}, config: {} }),
      (error) => error.kind === 'invalid-input' && /agents 服务/.test(error.message),
      '缺 agents 必须报 invalid-input（重试两次还是缺，不该重试）',
    )
  })

  await check('执行器：用 followup 推任务（inject 不唤醒 agent），反注入提醒在最前面', async () => {
    const env = makeRunEnv()
    await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(env.state.followups.length, 1, '应该 followup 一次')
    assert.equal(env.state.injects.length, 0, '绝不能走 inject —— 它不唤醒 agent')
    const message = env.state.followups[0]
    assert.equal(message.role, 'user')
    assert.equal(message.source.kind, 'user')
    assert.equal(message.content[0].type, 'text')
    assert.equal(message.content[0].text, NOTICE, '反注入提醒必须是第一块，不能插在中间')
    assert.equal(message.content[1].text, '任务书正文')
    // 纯函数也验一遍，免得上面的断言只是碰巧成立。
    const built = buildMessages(TICKET, { prompt: 'p', content: [{ type: 'text', text: 'p' }] }, NOTICE)
    assert.equal(built[0].text, NOTICE)
  })

  await check('执行器：sessionId 形如 ticket-<projectId>-<recordId>-<时间戳>，且无非法字符', async () => {
    const sessionId = buildSessionId({ projectId: 'demo/svc', recordId: 'rec 9' }, {})
    assert.match(sessionId, /^ticket-[A-Za-z0-9._-]+-[A-Za-z0-9._-]+-\d{10,}$/, `sessionId 形状不对：${sessionId}`)
    assert.ok(!sessionId.includes('/'), 'sessionId 里不能有斜杠（会被当成路径）')
    const env = makeRunEnv()
    await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(env.created.length, 1)
    assert.equal(env.created[0].meta.cwd, env.ctx.worktreePath, 'agent 的 cwd 必须是 worktree，不能在主目录里改代码')
    assert.match(env.created[0].sessionId, /^ticket-demo-rec-9-\d+$/)
  })

  await check('执行器：provider/model 留空时不下发（跟随宿主默认）', async () => {
    const opts = agentOptionsFromConfig({ provider: '', model: '', maxTokens: 8192 })
    assert.deepEqual(opts, { maxTokens: 8192 }, '空串有语义：表示跟随默认，传下去会被当成「空模型名」')
    assert.equal(agentOptionsFromConfig({ provider: 'workbuddy', model: 'x' }).provider, 'workbuddy')
  })

  await check('执行器：setup 里挂 preset —— 不挂的话 agent 没有任何工具，改动必为空', async () => {
    // 这是「切到 agent 执行器后票永远 failed」的根因：setup 曾经只打一行日志。
    // 宿主自己的子 agent 走 presets.mount（dsh-subagent:applyChildComposition），
    // 插件起的 agent 必须做同一件事。
    const env = makeRunEnv()
    await env.executor.run(env.ticket, env.target, env.ctx)
    assert.deepEqual(env.setupState.mounts, ['ptc'], `应该挂默认 preset ptc，实际挂了 ${JSON.stringify(env.setupState.mounts)}`)
  })

  await check('执行器：agentPreset 可配置，留空则不挂', async () => {
    const custom = makeRunEnv()
    custom.ctx.config.agentPreset = 'standard'
    await custom.executor.run(custom.ticket, custom.target, custom.ctx)
    assert.deepEqual(custom.setupState.mounts, ['standard'], 'agentPreset 配置要能被读到')

    const none = makeRunEnv()
    none.ctx.config.agentPreset = ''
    await none.executor.run(none.ticket, none.target, none.ctx)
    assert.deepEqual(none.setupState.mounts, [], '留空 = 不挂 preset（交给宿主默认）')
  })

  await check('执行器：setup 里记 sandbox/mode 与 approval/policy —— 不记就吃部署默认（可能只读）', async () => {
    const env = makeRunEnv()
    await env.executor.run(env.ticket, env.target, env.ctx)
    const mode = env.state.appends.find((event) => event.type === 'sandbox/mode')
    const approval = env.state.appends.find((event) => event.type === 'approval/policy')
    assert.ok(mode, '必须 append sandbox/mode，否则 agent 改不动 worktree')
    assert.equal(mode.data.mode, 'danger-full-access')
    assert.ok(approval, '必须 append approval/policy，否则 worker 里会弹审批卡死')
    assert.equal(approval.data.policy, 'never')
  })

  await check('执行器：preset 挂不上时报 invalid-input 并列出可用 preset（不埋掉真因）', async () => {
    const env = makeRunEnv({ presetError: new Error('Unknown agent preset: nope') })
    await assert.rejects(
      () => env.executor.run(env.ticket, env.target, env.ctx),
      (error) => {
        assert.equal(error.kind, 'invalid-input', 'preset 名写错是配置问题，不该重试')
        assert.match(error.message, /agentPreset "ptc" 失败/)
        assert.ok(error.message.includes('ptc / standard'), '要把本机可用的 preset 列出来，人才能改对')
        return true
      },
    )
  })

  await check('执行器：跟进消息必须带 id（宿主 inbox 按 id 记账，缺了会炸 invalid inbox splice）', async () => {
    const env = makeRunEnv()
    await env.executor.run(env.ticket, env.target, env.ctx)
    const message = env.state.followups[0]
    assert.ok(typeof message.id === 'string' && message.id.length > 0, 'followup 的消息必须有 id')
    // 两条消息的 id 必须不同，否则第二条会被宿主判成「重复 id」。
    const second = makeRunEnv()
    await second.executor.run(second.ticket, second.target, second.ctx)
    assert.notEqual(second.state.followups[0].id, message.id, '每条 followup 的 id 必须唯一')
  })

  await check('执行器：阶段按 editing → testing → mr-opening 推进', async () => {
    const env = makeRunEnv()
    await env.executor.run(env.ticket, env.target, env.ctx)
    assert.deepEqual(env.phases, ['editing', 'testing', 'mr-opening'])
  })

  await check('执行器：改动经 GitLab Commits API 物化，开的是 draft MR', async () => {
    const env = makeRunEnv()
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.phase, 'done', `没配 verify 时应该是 done，实际 ${result.phase}：${result.error?.message ?? ''}`)
    assert.equal(result.mr.draft, true)
    assert.equal(result.mr.iid, 42)
    assert.deepEqual(result.changedFiles, ['src/login.js', 'src/helper.js'])
    const commit = env.gitServer.requests.find((r) => r.url.endsWith('/repository/commits'))
    assert.ok(commit, '必须走 Commits API：本机 git push 物理上不可能')
    assert.equal(commit.body.branch, 'ticket-demo-rec-9-r1')
    assert.equal(commit.body.actions.length, 2)
    assert.equal(commit.body.actions[0].file_path, 'src/login.js')
    // 内容必须真读出来，不能用空串占位（空内容会清空远端文件）。
    assert.equal(commit.body.actions[0].content, 'content of src/login.js')
    const mr = env.gitServer.requests.find((r) => r.url.endsWith('/merge_requests'))
    assert.ok(mr.body.title.startsWith('Draft:'), `MR 标题必须 Draft: 开头：${mr.body.title}`)
  })

  await check('执行器：新增文件用 action=create，删除用 delete 且不带 content', async () => {
    // 为什么：一律 update 时，新文件在远端不存在 → 400「A file with this name doesn't exist」；
    // 被删的文件用 update + 空 content → 远端文件被清空。两种都是静默的数据事故。
    const env = makeRunEnv({
      files: ['src/new-page.vue', 'src/old-page.vue', 'src/login.js'],
      changes: [
        { path: 'src/new-page.vue', status: 'create' },
        { path: 'src/old-page.vue', status: 'delete' },
        { path: 'src/login.js', status: 'update' },
      ],
    })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.phase, 'done')
    const commit = env.gitServer.requests.find((r) => r.url.endsWith('/repository/commits'))
    const byPath = new Map(commit.body.actions.map((action) => [action.file_path, action]))
    assert.equal(byPath.get('src/new-page.vue').action, 'create')
    assert.equal(byPath.get('src/old-page.vue').action, 'delete')
    assert.equal('content' in byPath.get('src/old-page.vue'), false, 'delete 不能带 content，带了等于把文件写回空')
    assert.equal(byPath.get('src/login.js').action, 'update')
    assert.equal(byPath.get('src/login.js').content, 'content of src/login.js')
    // MR 描述里也要标出新增/删除：review 时「删了一个文件」比「改了几行」重要得多。
    const mr = env.gitServer.requests.find((request) => request.url.endsWith('/merge_requests'))
    assert.ok(mr.body.description.includes('src/new-page.vue（新增）'), mr.body.description)
    assert.ok(mr.body.description.includes('src/old-page.vue（删除）'), mr.body.description)
    assert.ok(mr.body.description.includes('src/login.js（修改）'), mr.body.description)
  })

  await check('执行器：重命名用 action=move 且带 previous_path', async () => {
    const env = makeRunEnv({
      files: ['src/renamed.js'],
      changes: [{ path: 'src/renamed.js', status: 'move', from: 'src/before.js' }],
    })
    await env.executor.run(env.ticket, env.target, env.ctx)
    const commit = env.gitServer.requests.find((r) => r.url.endsWith('/repository/commits'))
    assert.equal(commit.body.actions[0].action, 'move')
    assert.equal(commit.body.actions[0].file_path, 'src/renamed.js')
    assert.equal(commit.body.actions[0].previous_path, 'src/before.js', '缺 previous_path 会变成「新建一个 + 留一个孤儿」')
  })

  await check('执行器：git 状态解析 —— name-status 与 porcelain 都给出 create/update/delete/move', async () => {
    assert.deepEqual(parseNameStatus('A\tsrc/a.js\nM\tsrc/b.js\nD\tsrc/c.js\nR100\tsrc/d.js\tsrc/e.js'), [
      { path: 'src/a.js', status: 'create' },
      { path: 'src/b.js', status: 'update' },
      { path: 'src/c.js', status: 'delete' },
      { path: 'src/e.js', status: 'move', from: 'src/d.js' },
    ])
    assert.deepEqual(parsePorcelainChanges('?? src/a.js\n M src/b.js\n D src/c.js\nR  src/d.js -> src/e.js'), [
      { path: 'src/a.js', status: 'create' },
      { path: 'src/b.js', status: 'update' },
      { path: 'src/c.js', status: 'delete' },
      { path: 'src/e.js', status: 'move', from: 'src/d.js' },
    ])
    // 没有状态（老调用方只传 files）就退回 update：这是唯一安全假设。
    assert.deepEqual(normalizeActions(['src/x.js'], undefined), [{ path: 'src/x.js', status: 'update' }])
    assert.deepEqual(normalizeActions(['src/x.js'], [{ path: 'src/x.js', status: 'weird' }]), [{ path: 'src/x.js', status: 'update' }])
  })

  await check('执行器：提交内容按 worktree 拼路径读，不读会话工作区里的同名文件', async () => {
    // 为什么：readFile 是按进程 cwd 解析的，git 给的是仓库相对路径。
    // 不拼 worktree 就可能把工作区里另一个仓库的同名文件提交上去。
    const read = []
    const env = makeRunEnv({ files: ['src/login.js'] })
    const executor = createAgentExecutor({
      agents: { create: async (input) => { await input.setup?.({ get: () => undefined }, env.agent); return { agent: env.agent } } },
      git: async (argv) => { if (argv[0] === 'diff') return { code: 0, stdout: 'M\tsrc/login.js', stderr: '' }; return { code: 0, stdout: '', stderr: '' } },
      readFile: async (path) => { read.push(path); return 'x' },
      runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      getSecret: async () => 'glpat-test',
      createGitlabClient: async (cfg) => createGitlabClient({ ...cfg, fetch: env.gitServer.fetchImpl }),
      prompts: { untrustedNotice: NOTICE },
    })
    await executor.run(env.ticket, env.target, env.ctx)
    assert.equal(read.length, 1)
    // Windows 上 path.join 会输出反斜杠，统一成正斜杠再断言。
    const normalized = read[0].replace(/\\/g, '/')
    assert.ok(normalized.includes('.agents/worktrees/ticket-demo-rec-9-r1'), `必须拼上 worktree 根，实际 ${read[0]}`)
    assert.ok(!normalized.endsWith('/repo/src/login.js'), '不能直接拿仓库相对路径去读')
  })
  await check('执行器：敏感文件不提交，并写进 MR 描述', async () => {
    const env = makeRunEnv({ files: ['src/login.js', 'application.yml', '.env.local', 'config/prod.pem'] })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.phase, 'done')
    assert.deepEqual(result.changedFiles, ['src/login.js'], '敏感文件一个都不能提交')
    const commit = env.gitServer.requests.find((r) => r.url.endsWith('/repository/commits'))
    assert.deepEqual(commit.body.actions.map((a) => a.file_path), ['src/login.js'])
    const mr = env.gitServer.requests.find((r) => r.url.endsWith('/merge_requests'))
    assert.ok(mr.body.description.includes('application.yml'), '被拦下的文件必须写进 MR 描述，否则人不知道')
    assert.ok(mr.body.description.includes('.env.local'))
    // 纯函数单独验：Windows 路径也要认。
    assert.equal(isSensitivePath('src\\main\\application.yml'), true)
    assert.equal(isSensitivePath('src/login.js'), false)
    assert.deepEqual(filterSensitiveFiles(['a.js', 'B.SECRET.txt']), ['a.js'], 'secret 不分大小写')
  })

  await check('执行器：只有敏感文件改动时判 failed 且不开 MR', async () => {
    const env = makeRunEnv({ files: ['application.yml'] })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.phase, 'failed')
    assert.equal(result.mr, undefined, '空 MR 只会让人白点一次，不该开')
    assert.ok(/敏感文件/.test(result.error.message), `错误文案要说清原因：${result.error.message}`)
    assert.equal(env.gitServer.requests.filter((r) => r.url.endsWith('/merge_requests')).length, 0)
  })
  await check('执行器：没配 verify 时 testOutcome=skipped 且仍开 draft MR（合法成功路径）', async () => {
    const env = makeRunEnv({ verify: undefined })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.testOutcome, 'skipped')
    assert.ok(result.testDetail && result.testDetail.length > 0, 'skipped 必须写清原因')
    assert.ok(result.mr, '环境没起来也要开 MR —— 契约里这是合法成功路径')
  })

  await check('执行器：验证命令从项目配置读，通过记 passed', async () => {
    const calls = []
    const env = makeRunEnv({
      verify: { build: 'npm run build', test: 'node --test' },
      runCommandImpl: async ({ argv, cwd }) => { calls.push({ argv, cwd }); return { code: 0, stdout: 'ok', stderr: '' } },
    })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.testOutcome, 'passed')
    assert.deepEqual(calls.map((c) => c.argv), [['npm', 'run', 'build'], ['node', '--test']])
    assert.equal(calls[0].cwd, env.ctx.worktreePath, '验证命令必须在 worktree 里跑')
    assert.equal(result.phase, 'done')
  })

  await check('执行器：验证命令退出码非零记 failed，MR 照样开', async () => {
    const env = makeRunEnv({
      verify: { test: 'mvn -o test' },
      runCommandImpl: async () => ({ code: 1, stdout: '', stderr: 'Tests run: 1, Failures: 1' }),
    })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.testOutcome, 'failed')
    assert.equal(result.phase, 'skipped', '测试没过不是执行失败：改动是真的，MR 要给人看')
    assert.ok(/Tests run: 1, Failures: 1/.test(result.testDetail), `testDetail 要带上失败输出：${result.testDetail}`)
    assert.ok(result.mr)
  })

  await check('执行器：验证命令起不来（ENOENT）记 skipped 而不是 failed', async () => {
    const env = makeRunEnv({
      verify: { test: 'mvn -o test' },
      runCommandImpl: async () => { throw new Error('spawn mvn ENOENT') },
    })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.testOutcome, 'skipped', '环境起不来是 skipped，不是代码有问题')
    assert.ok(/ENOENT/.test(result.testDetail), `原因要写清楚：${result.testDetail}`)
    assert.ok(result.mr, '仍然开 draft MR')
  })

  await check('执行器：取消时调 agent.cancel 并抛 aborted（不转成 failed）', async () => {
    const env = makeRunEnv({ hangUntilAbort: true })
    const pending = env.executor.run(env.ticket, env.target, env.ctx)
    // 等 agent 真被挂住，再取消。
    await new Promise((resolve) => setTimeout(resolve, 10))
    env.controller.abort()
    await assert.rejects(
      () => pending,
      (error) => error.kind === 'aborted',
      '取消必须抛 aborted，让内核走取消分支而不是发失败通知',
    )
    assert.equal(env.state.cancelled, true, '取消时必须停下来，不能让 agent 空转烧 token')
    assert.equal(env.state.released, true, '取消路径也要释放 agent')
  })

  await check('执行器：agent 被上游限流时抛 rate-limit（可重试），不误报「没有文件改动」', async () => {
    // 为什么单独测：模型被限流和 agent「觉得不用改」从外面看一模一样（都闲着没改文件），
    // 但前者等一会儿再来就行，后者重试一百次还是一样。分错就是永久判死。
    const env = makeRunEnv({
      files: [],
      changes: [],
      agentError: {
        code: 'QUOTA',
        message: '429: workbuddy 上游失败：被限流（http 429）（code 6004）。您的使用量已超出频率限制，将在 2099-01-01 10:00:00 UTC+8 重置',
      },
    })
    await assert.rejects(
      () => env.executor.run(env.ticket, env.target, env.ctx),
      (error) => {
        assert.equal(error.kind, 'rate-limit', '限流要归到 rate-limit，内核才会退避重试')
        assert.equal(error.retryable, true, '限流必须可重试')
        assert.match(error.message, /限流/)
        assert.doesNotMatch(error.message, /没有产生任何文件改动/, '不能把模型失败说成「没改东西」')
        assert.ok((error.retryAfterMs ?? 0) > 0, '上游给了重置时刻，要如实带给内核')
        return true
      },
    )
  })

  await check('执行器：agent 以非限流错误结束时抛 internal 并带上真实原因', async () => {
    const env = makeRunEnv({
      files: [],
      changes: [],
      agentError: { code: 'SERVER_ERROR', message: '上游 500：内部错误' },
    })
    await assert.rejects(
      () => env.executor.run(env.ticket, env.target, env.ctx),
      (error) => {
        assert.equal(error.kind, 'internal')
        assert.match(error.message, /上游 500/, '要带上真实原因，别只说一句「agent 失败了」')
        return true
      },
    )
  })

  await check('执行器：最后一轮 turn/end 是成功时，不拿更早那轮的失败冤枉这次执行', async () => {
    const env = makeRunEnv({
      files: [],
      changes: [],
      turnEndReasons: [
        { kind: 'error', error: { code: 'RATE_LIMIT', message: '429 被限流' } },
        { kind: 'completed' },
      ],
    })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.phase, 'failed')
    assert.equal(result.error.kind, 'internal')
    assert.match(result.error.message, /没有产生任何文件改动/, '最后一轮成功了就该按「agent 认为不用改」收尾')
  })

  await check('执行器：跑完要释放 agent（宿主给的是 {agent, dispose}）', async () => {
    const env = makeRunEnv()
    await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(env.state.disposed, true, '宿主里 agents.create 返回 {agent, dispose}，必须走 dispose 才拆得掉')
  })

  await check('agent 失败原因：限流判定、重置时刻解析、最后一轮 turn/end', () => {
    assert.equal(isRateLimitFailure({ code: 'QUOTA', message: 'x' }), true)
    assert.equal(isRateLimitFailure({ code: 'rate_limit', message: 'x' }), true)
    assert.equal(isRateLimitFailure({ code: 'SERVER_ERROR', message: '上游 500' }), false)
    assert.equal(isRateLimitFailure({ code: 'UNKNOWN', message: '被限流了（http 429）' }), true, '文案兜底也要认')
    assert.equal(isRateLimitFailure(null), false)

    const reset = parseRetryAfterMs('将在 2099-01-01 10:00:00 UTC+8 重置')
    assert.ok(reset > 0, 'UTC+8 的重置时刻要能解析出来')
    assert.equal(parseRetryAfterMs('30 秒后恢复'), 30000)
    assert.equal(parseRetryAfterMs('没有时间信息'), undefined)

    const agent = { session: { log: [
      { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'QUOTA', message: '被限流' } } } },
    ] } }
    assert.deepEqual(readTurnEndFailure(agent), { code: 'QUOTA', message: '被限流' })
    assert.equal(readTurnEndFailure({ session: { log: [] } }), null)
    assert.equal(readTurnEndFailure({}), null, '老宿主不暴露 session.log 时要优雅降级')

    const error = agentFailureToPipelineError({ code: 'QUOTA', message: '被限流' })
    assert.equal(error.kind, 'rate-limit')
    assert.equal(error.retryable, true)
    assert.equal(error.agentFailure, true, '要带 agentFailure 标记，内核才知道这是「agent 失败」而不是「结论」')
  })

  await check('执行器：whenIdle 之后再比一次 seq，抖动一次也不会提前收工', async () => {
    const env = makeRunEnv({ bumpSeqOnce: true })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.phase, 'done')
    // 假 agent 第一次 whenIdle 会推进 seq，因此必须至少 await 两次。
    assert.ok(env.agent.idleCalls >= 2, `只等了一次 whenIdle 就收工了（seq 刚变过）：${env.agent.idleCalls}`)
  })

  await check('执行器：git 命令白名单挡住 push / fetch 这类会改变远端的命令', async () => {
    assert.equal(isAllowedGitCommand(['status', '--porcelain']), true)
    assert.equal(isAllowedGitCommand(['diff', '--name-only', 'abc']), true)
    assert.equal(isAllowedGitCommand(['add', '-A']), true)
    assert.equal(isAllowedGitCommand(['commit', '-m', 'x']), true)
    for (const argv of [['push'], ['push', 'origin', 'main'], ['fetch', 'origin'], ['reset', '--hard'], ['clean', '-fd']]) {
      assert.equal(isAllowedGitCommand(argv), false, `git ${argv.join(' ')} 必须被白名单挡住`)
    }
  })

  await check('执行器：从 GitLab remote 推 baseUrl / projectId / 目标分支', async () => {
    assert.deepEqual(parseGitRemote('git@gitlab.example.com:group/sub/repo.git'), { baseUrl: 'https://gitlab.example.com', projectPath: 'group/sub/repo' })
    assert.deepEqual(parseGitRemote('https://gitlab.example.com/group/repo.git'), { baseUrl: 'https://gitlab.example.com', projectPath: 'group/repo' })
    assert.equal(parseGitRemote(''), null)
    const resolved = resolveGitlab({ repo: { remote: 'git@gitlab.example.com:g/r.git', targetBranch: 'release' } }, {})
    assert.deepEqual(resolved, { baseUrl: 'https://gitlab.example.com', projectId: 'g/r', targetBranch: 'release' })
    // 显式配置优先：自建站点 / 子组路径只有它能表达。
    const explicit = resolveGitlab({ repo: { gitlab: { baseUrl: 'https://gl.internal', projectId: 9 }, remote: 'git@x:y/z.git' } }, {})
    assert.equal(explicit.baseUrl, 'https://gl.internal')
    assert.equal(explicit.projectId, 9)
    assert.equal(resolveGitlab({ repo: { path: '/r' } }, {}), null, '没有 GitLab 坐标时要返回 null，而不是编一个')
  })

  await check('执行器：命令串只按空白切，不偷偷解释 shell 语法', async () => {
    assert.deepEqual(splitCommand('npm run build'), ['npm', 'run', 'build'])
    assert.deepEqual(splitCommand('  mvn   -o test  '), ['mvn', '-o', 'test'])
    // `&&` 会变成独立的 argv 元素送给子进程，而不是被拼成 shell 复合命令。
    assert.deepEqual(splitCommand('a && b'), ['a', '&&', 'b'])
    assert.deepEqual(splitCommand(''), [])
  })

  await check('执行器：MR 标题与描述带上工单溯源信息', async () => {
    const title = buildMrTitle(TICKET)
    assert.ok(title.includes('#17'), `标题要带序号：${title}`)
    assert.ok(title.includes('登录页'), `标题要带问题描述：${title}`)
    const description = buildMrDescription({
      ticket: TICKET,
      files: ['a.js'],
      blocked: ['application.yml'],
      verification: { outcome: 'skipped', detail: '没配命令' },
      ctx: { branch: 'ticket-demo-rec-9-r1' },
    })
    assert.ok(description.includes('rec-9'), '描述要带 recordId')
    assert.ok(description.includes('没配命令'), '描述要写清验证结论')
    assert.ok(description.includes('未提交的文件'), '有被拦文件时必须单独一节说明')
  })
}
