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
  resolveAgentOptions,
  buildMessages,
  buildMrDescription,
  buildMrTitle,
  buildLocalCommitMessage,
  buildSessionId,
  commitLocally,
  collectChanges,
  createAgentExecutor,
  createBaseline,
  filterSensitiveFiles,
  isAllowedGitCommand,
  isSensitivePath,
  normalizeActions,
  parseGitRemote,
  resolveGitlab,
  splitCommand,
  unstageSensitiveFiles,
} from '../src/adapters/executor-agent/index.js'
import {
  agentFailureToPipelineError,
  isRateLimitFailure,
  parseRetryAfterMs,
  readTurnEndFailure,
} from '../src/adapters/executor-agent/agent-failure.js'
import {
  parseNameStatusZ,
  parseStatusZ,
  statusCodeToAction,
} from '../src/contracts/git-status.js'

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
  const state = { mounts: [], setCalls: [], attachCalls: [], sessionCloseCalls: [], sessionDisposeCalls: [] }
  const presets = {
    list: async () => (options.presetIds ?? ['ptc', 'standard']).map((id) => ({ id })),
    mount: async (ctx, id) => {
      if (options.presetError) throw options.presetError
      state.mounts.push(id)
      return { id }
    },
  }
  const workspaceRegistry = {
    get: (id) => ({
      id,
      path: options.workspacePath ?? '/repo',
      attachSession: async (sessionId) => { state.attachCalls.push({ workspaceId: id, sessionId }) },
    }),
  }
  // 会话服务：只有传了 sessionsService 才存在 —— 真实宿主里也不是每个 profile 都挂它，
  // `closeSession` 必须能优雅处理「取不到」的情况。
  const sessionsService = options.sessionsService
    ? {
        ...(options.sessionsService === 'close' ? { close: async (id) => { state.sessionCloseCalls.push(id) } } : {}),
        ...(options.sessionsService === 'dispose' ? { dispose: async (id) => { state.sessionDisposeCalls.push(id) } } : {}),
        ...(options.sessionsService === 'closeSession' ? { closeSession: async (id) => { state.sessionCloseCalls.push(id) } } : {}),
      }
    : undefined
  const agentCtx = {
    get (name) {
      if (name === 'agentPresets') return presets
      if (name === 'workspaceRegistry') return workspaceRegistry
      if (name === 'sessions') return sessionsService
      if (name === 'workingDirectory') {
        // noWorkingDirectory = 模拟 headless profile：这个服务根本不存在。
        if (options.noWorkingDirectory) return undefined
        return {
          get: () => undefined,
          set: async (_agent, path) => { state.setCalls.push(path); return path },
        }
      }
      return undefined
    },
  }
  return { agentCtx, state, workspaceRegistry }
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
 * 把 {path, status, from} 渲染成 `git diff --name-status -z` 的输出。
 *
 * `-z` 格式：状态与路径之间是 NUL；重命名是「状态 / 旧路径 / 新路径」。
 * 这里必须按 `-z` 渲染 —— 生产代码只用 `-z` 解析（理由见 `contracts/git-status.js`），
 * 假 git 若还回 tab 分隔的旧格式，测出来的东西和真实 git 不是一回事。
 *
 * @param {Array<{ path: string, status: string, from?: string }>} changes
 * @returns {string}
 */
function renderNameStatus (changes) {
  const letters = { create: 'A', update: 'M', delete: 'D', move: 'R100' }
  return changes.map((change) => {
    const letter = letters[change.status] ?? 'M'
    if (letter === 'R100') return `${letter}\0${change.from ?? change.path}\0${change.path}`
    return `${letter}\0${change.path}`
  }).join('\0') + '\0'
}

/**
 * 把 {path, status, from} 渲染成 `git status --porcelain -z` 的输出。
 *
 * `-z` 格式：每条记录是「两字符状态码 + 空格 + 路径」，记录之间 NUL 分隔；
 * 重命名/复制**新路径在前**、紧跟一条只含旧路径的记录（与 `--name-status -z` 相反）。
 *
 * @param {Array<{ path: string, status: string, from?: string }>} changes
 * @returns {string}
 */
function renderPorcelain (changes) {
  const codes = { create: '??', update: ' M', delete: ' D', move: 'R ' }
  return changes.map((change) => {
    const code = codes[change.status] ?? ' M'
    if (code === 'R ') return `R  ${change.path}\0${change.from ?? change.path}`
    return `${code} ${change.path}`
  }).join('\0') + '\0'
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
  /** @type {Array<{ message: string, paths: string[] }>} */
  const commits = []
  const files = options.files ?? ['src/login.js', 'src/helper.js']
  const contents = options.contents ?? {}
  // git 视角的改动清单：默认全是「改现有文件」（M），要测新增/删除/重命名就传 changes。
  const changes = options.changes ?? files.map((path) => ({ path, status: 'update' }))

  // 宿主的 setup 是「publish 之前」调用的：这里照样在返回 agent 之前 await 它，
  // 这样断言能看到 preset 挂载与会话策略事件的真实顺序。
  const { agentCtx, state: setupState, workspaceRegistry } = createFakeAgentCtx(options)
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
    if (argv[0] === 'diff' && argv[1] === '--name-status') {
      // 第三个参数是「跟谁比」：拍基线成功时是 baseline sha，否则是检出点 baseCommit。
      // `changesFor(ref)` 让用例按 ref 给出不同的改动清单 —— 这正是「有基线时人的改动
      // 不该出现在 diff 里」这件事可被验证的方式。
      const ref = String(argv[3] ?? '')
      const list = typeof options.changesFor === 'function' ? options.changesFor(ref) : changes
      return { code: 0, stdout: renderNameStatus(list), stderr: '' }
    }
    if (argv[0] === 'diff' && argv[1] === '--name-only') return { code: 0, stdout: files.join('\n'), stderr: '' }
    if (argv[0] === 'status') {
      const statusOut = typeof options.gitStatusOutput === 'function' ? options.gitStatusOutput() : options.gitStatusOutput
      return { code: 0, stdout: statusOut ?? renderPorcelain(changes), stderr: '' }
    }
    if (argv[0] === 'add') return { code: 0, stdout: '', stderr: '' }
    // 本地提交：记下 commit 的 argv（paths 在 `--` 之后），供断言核对「只提交非敏感文件」。
    if (argv[0] === 'commit') {
      const sep = argv.indexOf('--')
      commits.push({ message: argv[argv.indexOf('-m') + 1], paths: sep >= 0 ? argv.slice(sep + 1) : [] })
      return { code: options.commitFails ? 1 : 0, stdout: '', stderr: options.commitFails ? 'nothing to commit' : '' }
    }
    if (argv[0] === 'rev-parse' && argv[1] === 'HEAD') {
      if (options.revParseFails) return { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
      return { code: 0, stdout: options.headSha ?? 'deadbeefcafe1234567890abcdef1234567890ab', stderr: '' }
    }
    // 拍基线：`git stash create` 真实语义是「有未提交改动就回一个 stash commit 的 sha，
    // 工作区干净就回**空串**」。用 stashSha 显式模拟这两种，别让假 git 静默回空。
    if (argv[0] === 'stash' && argv[1] === 'create') {
      if (options.stashFails) return { code: 128, stdout: '', stderr: 'fatal: stash create failed' }
      return { code: 0, stdout: options.stashSha ?? 'stash0000000000000000000000000000000001', stderr: '' }
    }
    // 未跟踪文件的内容哈希：哈希变了 = agent 动过，哈希没变 = 人本来就有的。
    if (argv[0] === 'hash-object') {
      const sep = argv.indexOf('--')
      const path = sep >= 0 ? argv[sep + 1] : argv[1]
      return { code: 0, stdout: `${options.hashFor?.(path) ?? `hash:${path}`}\n`, stderr: '' }
    }
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
    // 组合根真实注入的就是这个（宿主只在 web-app 层挂 registry，agentCtx 里未必有）。
    workspaceRegistry: options.workspaceRegistry ?? workspaceRegistry,
  })

  const config = {
    provider: '',
    model: '',
    maxTokens: 4096,
    // keepSession 是**全局**行为开关（core/config.js），不是项目级配置 —— 所以放在
    // 这一层。不传就是 undefined，等于走缺省 true（保留会话）。
    ...(options.keepSession === undefined ? {} : { keepSession: options.keepSession }),
    projects: [{
      name: 'demo',
      match: { platform: 'mock' },
      // 远程 MR 出口默认**关着**（本阶段只要本地提交）；这一节里大部分用例验的是
      // 远程物化路径，所以显式打开 repo.gitlab.enabled 才走 MR；传 gitlabEnabled:false
      // 就是「本阶段默认形态」：只做本地提交、不要 GITLAB_TOKEN。
      repo: {
        path: '/repo',
        remote: 'git@gitlab.example.com:group/sub/repo.git',
        baseBranch: 'main',
        targetBranch: 'main',
        ...(options.gitlabEnabled === false ? {} : { gitlab: { enabled: true } }),
      },
      verify: options.verify,
    }],
  }

  const controller = new AbortController()
  /** @type {string[]} */
  const logs = []
  const ctx = {
    signal: controller.signal,
    worktreePath: '/repo/.agents/worktrees/ticket-demo-rec-9-r1',
    branch: 'ticket-demo-rec-9-r1',
    baseCommit: 'base123',
    repoPath: '/repo',
    // 项目工作区：默认给上（这是「工单有项目工作区」的正常形态）；
    // 传 workspacePath: null 可以模拟「升级前的老票据，只有 worktree」。
    ...(options.workspacePath === null
      ? {}
      : {
          workspacePath: options.workspacePath ?? '/repo',
          workspaceId: options.workspaceId ?? 'ws-1',
        }),
    prompt: '任务书正文',
    content: [{ type: 'text', text: '任务书正文' }],
    images: [],
    config,
    log: (message) => { logs.push(String(message)) },
    onPhase: async (phase) => { phases.push(phase) },
  }

  return { executor, ctx, controller, state, agent, created, phases, commits, gitCalls, gitServer, setupState, changes, logs, ticket: TICKET, target: { repoPath: '/repo', remote: 'git@gitlab.example.com:group/sub/repo.git', baseBranch: 'main' } }
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
    assert.match(env.created[0].sessionId, /^ticket-demo-rec-9-\d+$/)
  })

  await check('执行器：会话 cwd 用项目工作区根，改代码目录靠 workingDirectory 钉到 worktree', async () => {
    // 为什么必须这样分：宿主 `attachSession` 要求会话 header 的 canonical cwd
    // 正好等于工作区路径，worktree 子目录挂不上；但 agent 又必须在 worktree 里改代码。
    // 所以 header.cwd = 工作区根，workingDirectory.set 把「这一轮的工作目录」换成 worktree。
    const env = makeRunEnv()
    await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(env.created[0].meta.cwd, '/repo', 'header.cwd 必须是项目工作区根，否则会话挂不上工作区')
    assert.deepEqual(env.setupState.setCalls, [env.ctx.worktreePath], '工作目录必须被钉到 worktree，否则会在主检出里改代码')
  })

  await check('执行器：没有工作区坐标时退回「cwd = worktree」，行为与改造前一致', async () => {
    // 升级前入队的老票据只有 worktreePath。这时没有工作区可挂，也不该需要
    // workingDirectory 服务 —— 直接把 worktree 当 cwd 就是改造前的正确行为。
    const env = makeRunEnv({ workspacePath: null, noWorkingDirectory: true })
    await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(env.created[0].meta.cwd, env.ctx.worktreePath, '没有工作区时 cwd 就该是 worktree')
    assert.deepEqual(env.setupState.setCalls, [], '不需要钉，header 已经对了')
  })

  await check('执行器：有工作区但本机没有 workingDirectory 服务时，拒绝在项目主检出里改代码', async () => {
    // 这是最危险的一种降级：不报错就继续跑，agent 会直接改人的检出。
    // 宁可这张票失败，也不能偷偷污染主工作区。
    const env = makeRunEnv({ noWorkingDirectory: true })
    await assert.rejects(
      () => env.executor.run(env.ticket, env.target, env.ctx),
      (error) => {
        assert.equal(error.kind, 'invalid-input', '缺服务重试也没用')
        assert.match(error.message, /workingDirectory/)
        assert.match(error.message, /会在项目主检出里改代码/)
        return true
      },
    )
  })

  await check('执行器：会话归属到项目工作区（attachSession 用的是 workspaceId）', async () => {
    const env = makeRunEnv({ workspaceId: 'ws-77' })
    await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(env.setupState.attachCalls.length, 1, '必须把会话挂到工作区名下，否则 GUI 里是散落的孤儿会话')
    assert.equal(env.setupState.attachCalls[0].workspaceId, 'ws-77')
    assert.equal(env.setupState.attachCalls[0].sessionId, env.created[0].sessionId)
  })

  await check('执行器：attachSession 失败不影响改代码（只记日志）', async () => {
    const failing = { get: () => ({ id: 'ws-x', attachSession: async () => { throw new Error('宿主：attach 失败') } }) }
    const env = makeRunEnv({ workspaceRegistry: failing })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.phase, 'done', '挂不上工作区只是 GUI 少一层分组，不该让票失败')
  })

  await check('执行器：没有 workspaceId 时不尝试 attach（headless / 老票据）', async () => {
    const env = makeRunEnv({ workspaceId: '' })
    await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(env.setupState.attachCalls.length, 0)
  })

  await check('执行器：provider/model 留空时不下发（跟随宿主默认）', async () => {
    const opts = agentOptionsFromConfig({ provider: '', model: '', maxTokens: 8192 })
    assert.deepEqual(opts, { maxTokens: 8192 }, '空串有语义：表示跟随默认，传下去会被当成「空模型名」')
    assert.equal(agentOptionsFromConfig({ provider: 'workbuddy', model: 'x' }).provider, 'workbuddy')
  })

  await check('执行器：配置留空时用宿主默认模型补齐，缺了 model 宿主会在 {{model}} 上崩', async () => {
    // 为什么必须补：宿主渲染系统提示时把 {{model}} 换成 agent.options.model，
    // 配置里 model 留空就真的不下发 → 渲染时抛
    // `prompt variable "{{model}}" has no value for this assembly`，
    // 票全变成「agent 没有产生任何文件改动」。真实工单上撞过（sandbox rec-mock-002/003）。
    const host = { currentSelection: () => ({ provider: 'workbuddy', model: 'space-bunny', reasoningEffort: 'xhigh' }) }
    const opts = resolveAgentOptions({ provider: '', model: '', maxTokens: 4096 }, { agentDefaultModel: host })
    assert.equal(opts.provider, 'workbuddy', '宿主默认 provider 必须补上')
    assert.equal(opts.model, 'space-bunny', '宿主默认 model 必须补上，否则 {{model}} 没值')
    assert.equal(opts.maxTokens, 4096)

    // 显式配置永远赢，不去问宿主。
    let asked = 0
    const spy = { currentSelection: () => { asked += 1; return { provider: 'p', model: 'm' } } }
    const explicit = resolveAgentOptions({ provider: 'workbuddy', model: 'mine' }, { agentDefaultModel: spy })
    assert.equal(explicit.model, 'mine')
    assert.equal(asked, 0, '配置齐全时不该再去问宿主')

    // 只配了 provider：model 仍要从宿主补，两项必须成对。
    const partial = resolveAgentOptions({ provider: 'workbuddy', model: '' }, { agentDefaultModel: host })
    assert.equal(partial.model, 'space-bunny', '只配 provider 时 model 也要补齐')

    // 没有宿主服务（离线自测 / 裁剪过的 profile）：保持配置原样，不凭空编模型名。
    const offline = resolveAgentOptions({ provider: '', model: '' }, {})
    assert.equal('model' in offline, false, '没有宿主服务时不能编一个模型名出来')

    // 有服务但拿不到值：必须明确报错，而不是让宿主在模板渲染处给一条看不懂的错。
    await assert.rejects(
      () => Promise.resolve().then(() => resolveAgentOptions({}, { agentDefaultModel: { currentSelection: () => ({}) } })),
      /provider=\$?\{?|没有给 provider\/model/,
      '宿主也给不出模型时必须自己报清楚',
    )
  })

  await check('执行器：本机没有 agentPresets 服务时报 invalid-input，不能静默起一个没工具的 agent', async () => {
    // 为什么：少了 preset 的 agent 一个工具都没有，读不到也改不了文件，
    // 最后只会落到「agent 没有产生任何文件改动」，真因被埋掉、还白烧一轮 token。
    const env = makeRunEnv()
    env.ctx.config.agentPreset = 'ptc'
    const executor = createAgentExecutor({
      agents: {
        create: async (input) => {
          await input.setup?.({ get: () => undefined }, env.agent)
          return { agent: env.agent }
        },
      },
      git: async () => ({ code: 0, stdout: '', stderr: '' }),
      getSecret: async () => 'x',
      createGitlabClient: async () => { throw new Error('不该走到这里') },
    })
    await assert.rejects(
      () => executor.run(env.ticket, env.target, env.ctx),
      (error) => {
        assert.equal(error.kind, 'invalid-input', '缺 preset 服务是环境/配置问题，不该重试')
        assert.match(error.message, /没有 agentPresets 服务/)
        assert.match(error.message, /改动必为空/)
        return true
      },
    )
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

  await check('执行器：在工作区检出里做本地提交，返回 sha 与分支', async () => {
    const env = makeRunEnv({ headSha: 'abc1234def5678' })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.phase, 'done')
    assert.equal(result.commit.sha, 'abc1234def5678', 'commit 必须带回 git 给的真实 sha')
    assert.equal(result.commit.branch, env.ctx.branch, 'commit 要带分支名，通知书里才有上下文')
    assert.deepEqual(result.commit.files, ['src/login.js', 'src/helper.js'])
    // git 调用顺序：add -- <文件…> → commit（带 pathspec）→ rev-parse HEAD
    const verbs = env.gitCalls.map((argv) => argv[0])
    assert.ok(verbs.includes('add'), '必须先 git add')
    assert.ok(verbs.includes('commit'), '必须真有 git commit')
    assert.ok(verbs.includes('rev-parse'), '提交后要取 sha')
    const addCall = env.gitCalls.find((argv) => argv[0] === 'add')
    assert.deepEqual(addCall, ['add', '--', 'src/login.js', 'src/helper.js'], '暂存也要点名，不许全量暂存')
    assert.equal(env.commits.length, 1, '一次执行只做一次本地提交')
    assert.deepEqual(env.commits[0].paths, ['src/login.js', 'src/helper.js'], '提交只点名非敏感文件')
  })

  await check('执行器：本地提交不带敏感文件，敏感文件留在工作区', async () => {
    // 敏感文件连索引都不能进：`git add -A` 全量暂存之后，人回来看到
    // `A  application.yml` 顺手 `git commit` 就把它带走了。所以这一步也点名暂存。
    const env = makeRunEnv({ files: ['src/login.js', 'application.yml', '.env.local'] })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.phase, 'done')
    assert.deepEqual(env.commits[0].paths, ['src/login.js'], '敏感文件绝不能进这次提交')
    const addCall = env.gitCalls.find((argv) => argv[0] === 'add')
    assert.deepEqual(addCall, ['add', '--', 'src/login.js'], '暂存也不能碰到敏感文件')
    assert.ok(/application\.yml/.test(env.commits[0].message), '提交说明要写清哪些文件被刻意留下')
    assert.ok(/未提交/.test(env.commits[0].message))
  })

  await check('执行器：没打开 repo.gitlab.enabled 时只做本地提交，不碰 GITLAB_TOKEN', async () => {
    // 这是本阶段的默认形态：只做本地提交、不连远程。
    // 关键点是「配了 repo.remote 也不代表要开 MR」——否则会去要 token、去连 GitLab。
    const env = makeRunEnv({ gitlabEnabled: false })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.phase, 'done')
    assert.ok(result.commit, '本地提交必须有')
    assert.equal(result.mr, undefined, '远程出口没打开就不该开 MR')
    assert.equal(
      env.gitServer.requests.filter((r) => r.url.endsWith('/merge_requests')).length,
      0,
      '一次 MR 请求都不该发出去',
    )
    assert.equal(
      env.gitServer.requests.filter((r) => r.url.endsWith('/repository/commits')).length,
      0,
      '也不该走 Commits API（那是远程物化路径）',
    )
  })

  await check('执行器：本地提交失败要让票失败，不能报 done', async () => {
    // 没有提交就等于什么都没交付；报 done 会让人以为工作区里已经有成果了。
    const env = makeRunEnv({ commitFails: true })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.phase, 'failed')
    assert.equal(result.commit, undefined)
  })

  await check('执行器：本地提交说明带工单溯源、验证结论与未提交文件', async () => {
    const message = buildLocalCommitMessage(TICKET, {
      blocked: ['application.yml'],
      verification: { outcome: 'skipped', detail: '没配命令' },
    })
    assert.ok(message.includes('rec-9'), `提交说明要带 recordId：${message}`)
    assert.ok(message.includes('验证：skipped（没配命令）'), `要写清验证结论：${message}`)
    assert.ok(message.includes('未提交'), '要写清哪些文件被刻意留下')
    assert.ok(message.includes('application.yml'))
    // 验证通过时文案不同：不能把 passed 也写成「skipped」。
    const passed = buildLocalCommitMessage(TICKET, { verification: { outcome: 'passed', detail: '全部 0' } })
    assert.ok(passed.includes('验证：通过（全部 0）'), passed)
    assert.ok(!passed.includes('未提交'), '没有 blocked 时不该出现「未提交」一节')
  })

  await check('执行器：commitLocally 拒绝空提交与缺 git 运行器', async () => {
    await assert.rejects(
      () => commitLocally({}, { ticket: TICKET, worktreePath: '/w', branch: 'b', files: [], blocked: [], verification: { outcome: 'passed', detail: '' } }),
      (error) => {
        assert.equal(error.kind, 'invalid-input')
        assert.match(error.message, /缺少注入的 git 运行器/)
        return true
      },
    )
    await assert.rejects(
      () => commitLocally({ git: async () => ({ code: 0, stdout: '', stderr: '' }) }, { ticket: TICKET, worktreePath: '/w', branch: 'b', files: [], blocked: [], verification: { outcome: 'passed', detail: '' } }),
      (error) => {
        assert.equal(error.kind, 'internal')
        assert.match(error.message, /空提交/)
        return true
      },
    )
  })

  await check('执行器：agent 自己暂存过的敏感文件要被退回未跟踪（否则人顺手 commit 就带走了）', async () => {
    // 真实场景：agent 干活时跑过 `git add -A`，application.yml 就停在索引里
    // （`A  application.yml`）。我们的提交是点名暂存的，它进不了这次提交 ——
    // 但它还躺在索引里，人回来 `git commit` 一下就把真实凭据提交上去了。
    const calls = []
    const restored = await unstageSensitiveFiles({
      git: async (argv) => {
        calls.push(argv)
        if (argv[0] === 'status') return { code: 0, stdout: 'A  application.yml\0 M src/login.js\0?? .env.local\0', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }, '/w', ['application.yml', 'src/login.js', '.env.local'], {})
    // 只有 application.yml 真的在索引里；src/login.js 只是工作区改动（次列 M），
    // .env.local 是未跟踪（`??`）—— 对这两个跑 restore --staged 会 fatal。
    assert.deepEqual(restored, ['application.yml'])
    const restoreCall = calls.find((argv) => argv[0] === 'restore')
    assert.deepEqual(restoreCall, ['restore', '--staged', '--', 'application.yml'])
  })

  await check('执行器：没有敏感文件在索引里时不发 restore（该命令对未暂存文件会 fatal）', async () => {
    const calls = []
    const restored = await unstageSensitiveFiles({
      git: async (argv) => {
        calls.push(argv)
        if (argv[0] === 'status') return { code: 0, stdout: '?? .env.local\0 M application.yml\0', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }, '/w', ['.env.local', 'application.yml'], {})
    assert.deepEqual(restored, [])
    assert.equal(calls.filter((argv) => argv[0] === 'restore').length, 0)
  })

  await check('执行器：读不到检出状态也不影响提交（只记一条日志）', async () => {
    const logs = []
    const restored = await unstageSensitiveFiles({
      git: async (argv) => ({ code: 128, stdout: '', stderr: 'not a git repo' }),
    }, '/w', ['application.yml'], { log: (message) => logs.push(message) })
    assert.deepEqual(restored, [])
    assert.equal(logs.length, 1, '要留下一条能查的日志')
  })

  await check('执行器：git 白名单放行 commit / rev-parse HEAD，仍挡 push', async () => {
    assert.equal(isAllowedGitCommand(['commit', '-m', 'x', '--', 'a.js']), true)
    assert.equal(isAllowedGitCommand(['rev-parse', 'HEAD']), true)
    // 只放行 `rev-parse HEAD`：别的 rev-parse 子形态没有用处，放进来只是扩大攻击面。
    assert.equal(isAllowedGitCommand(['rev-parse', '--all']), false)
    assert.equal(isAllowedGitCommand(['push']), false)
  })

  await check('执行器：git 白名单只放行「带 -z -uall 与排除规则」的 status', async () => {
    // status 的放行面必须收窄到生产代码真正用的那一组参数：
    // 放宽成「argv[0] === 'status' 就 true」等于给了一个能读整个仓库的入口。
    assert.equal(isAllowedGitCommand(['status', '--porcelain', '-z', '-uall']), true)
    assert.equal(
      isAllowedGitCommand(['status', '--porcelain', '-z', '-uall', '--', '.', ':(exclude).agents/worktrees', ':(exclude).agents/worktrees/**']),
      true,
      '排除插件自有目录的那一组必须放行，否则 collectChanges 会被自己的闸门挡住',
    )
    assert.equal(isAllowedGitCommand(['status', '--porcelain']), true, '老形态仍要放行')
    assert.equal(isAllowedGitCommand(['status']), false)
    assert.equal(isAllowedGitCommand(['status', '--porcelain', '--short']), false, '未知 flag 一律拒')
    assert.equal(isAllowedGitCommand(['status', '--porcelain', '--', '/etc']), false, 'pathspec 只能以 . 开头')
    assert.equal(isAllowedGitCommand(['status', '--porcelain', '--', '.', 'src']), false, '只允许排除规则，不允许额外包含')
  })

  await check('执行器：git 白名单放行 restore --staged，但挡住不带 --staged 的 restore', async () => {
    // 敏感文件被 agent 自己 add 进去之后，必须先退回未跟踪，否则它会留在索引里
    // 等人下一次 git commit 顺手带走。
    assert.equal(isAllowedGitCommand(['restore', '--staged', '--', 'application.yml']), true)
    // 不带 --staged 的 restore 会把工作区的改动一起扔掉 —— 那是「删人代码」，绝不能放行。
    assert.equal(isAllowedGitCommand(['restore', '--', 'a.js']), false)
    assert.equal(isAllowedGitCommand(['restore', '--staged', 'a.js']), false, '必须用 -- 隔开')
    assert.equal(isAllowedGitCommand(['restore', '--staged', '--']), false, '空列表没意义')
  })

  await check('执行器：git 白名单只放行 stash create 与带 -- 的 hash-object', async () => {
    // 拍基线要用这两条。风险点都在「子命令选错就会动工作区/动对象库」：
    // - stash pop / apply / drop 会改工作区（pop 还会把人的改动糊回去），绝不能放行；
    //   只有 `stash create` 是纯读的 —— 它造一个 commit 对象、写进 stdout，不动 ref、不动工作区。
    assert.equal(isAllowedGitCommand(['stash', 'create']), true)
    assert.equal(isAllowedGitCommand(['stash', 'pop']), false, 'pop 会动工作区，放行等于能把人的改动搞乱')
    assert.equal(isAllowedGitCommand(['stash']), false)
    assert.equal(isAllowedGitCommand(['stash', 'create', 'x']), false)
    // hash-object 必须带 `--`：缺了它，文件名会被当成 flag（比如 -w 会把内容写进对象库）。
    assert.equal(isAllowedGitCommand(['hash-object', '--', 'a.txt']), true)
    assert.equal(isAllowedGitCommand(['hash-object', 'a.txt']), false, '不带 -- 时 -w 之类的 flag 会被当成文件名前缀')
    assert.equal(isAllowedGitCommand(['hash-object', '--']), false, '空列表没意义')
    assert.equal(isAllowedGitCommand(['hash-object', '--', '']), false, '空路径没意义')
  })

  await check('执行器：collectChanges 把未跟踪的新文件也算进改动（git diff 看不见它们）', async () => {
    // 这是本改造最致命的一条：缺省模式下 baseCommit 必然有值，
    // 只跑 `git diff <baseCommit>` 就会漏掉 agent 新建的所有文件 ——
    // 而「新建一个页面/组件」恰恰是工单里最常见的产物。
    const calls = []
    const cwd = '/repo'
    const result = await collectChanges({
      git: async (argv) => {
        calls.push(argv)
        if (argv[0] === 'diff') return { code: 0, stdout: 'M\0src/old.js\0', stderr: '' }
        if (argv[0] === 'status') return { code: 0, stdout: ' M src/old.js\0?? src/new.js\0?? 中文名.js\0', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }, { cwd, baseCommit: 'base123', signal: new AbortController().signal })
    assert.deepEqual(result.changes, [
      { path: 'src/old.js', status: 'update' },
      { path: 'src/new.js', status: 'create' },
      { path: '中文名.js', status: 'create' },
    ])
    assert.deepEqual(result.files, ['src/old.js', 'src/new.js', '中文名.js'])
    // 两条 git 调用都必须带排除插件自有目录的 pathspec，否则 .agents/worktrees 会被收进来。
    for (const argv of calls) {
      assert.ok(argv.includes(':(exclude).agents/worktrees'), `每条都要排除插件目录：${argv.join(' ')}`)
      assert.ok(argv.includes('-z'), `必须用 -z 读，否则中文名/空格名会被转义：${argv.join(' ')}`)
    }
    assert.ok(calls.some((argv) => argv[0] === 'status' && argv.includes('-uall')), '未跟踪目录必须 -uall 展开到文件级')
  })

  await check('执行器：同一路径 diff 与 status 都报时不重复计数', async () => {
    const result = await collectChanges({
      git: async (argv) => {
        if (argv[0] === 'diff') return { code: 0, stdout: 'A\0src/both.js\0', stderr: '' }
        if (argv[0] === 'status') return { code: 0, stdout: '?? src/both.js\0', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }, { cwd: '/repo', baseCommit: 'base123', signal: new AbortController().signal })
    assert.deepEqual(result.changes, [{ path: 'src/both.js', status: 'create' }], '以 diff 的结论为准，不重复')
  })

  await check('执行器：没有 baseCommit 时也靠 status 拿到改动（首提交前的仓库）', async () => {
    // 无 HEAD 的仓库里 `git diff HEAD` 直接 fatal，只有 status 这条路能走通。
    const result = await collectChanges({
      git: async (argv) => {
        if (argv[0] === 'status') return { code: 0, stdout: '?? a.js\0', stderr: '' }
        throw new Error(`不该走 diff：${argv.join(' ')}`)
      },
    }, { cwd: '/repo', baseCommit: '', signal: new AbortController().signal })
    assert.deepEqual(result.changes, [{ path: 'a.js', status: 'create' }])
  })

  await check('执行器：有基线时只收 agent 的改动，人自己未提交的改动一个都不进提交', async () => {
    // 这是「不提交不是你修改的文件」的核心一条。没有基线时 diff 的右端点是检出点
    // （baseCommit = 检出 HEAD），人早先攒下的未提交改动会一起出现在 diff 里，
    // 然后被当成 agent 的产物提交掉。有基线（stash create 的 sha）之后，
    // 那些改动在基线快照里已经有了，diff 出来就是空的。
    const calls = []
    const result = await collectChanges({
      git: async (argv) => {
        calls.push(argv)
        if (argv[0] === 'diff') return { code: 0, stdout: 'A\0agent.txt\0', stderr: '' }
        if (argv[0] === 'status') return { code: 0, stdout: ' M user-edit.txt\0?? user-new.txt\0?? agent.txt\0', stderr: '' }
        if (argv[0] === 'hash-object') {
          const path = argv[argv.indexOf('--') + 1]
          return { code: 0, stdout: `${path === 'user-new.txt' ? 'h1' : 'h-other'}\n`, stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }, {
      cwd: '/repo',
      baseCommit: 'base123',
      baseline: { sha: 'stashsha1', head: 'head1', untracked: new Map([['user-new.txt', 'h1']]) },
      signal: new AbortController().signal,
    })
    assert.deepEqual(result.changes, [{ path: 'agent.txt', status: 'create' }], '人的改动一个都不能进提交')
    assert.deepEqual(result.files, ['agent.txt'])
    const diffCall = calls.find((argv) => argv[0] === 'diff')
    assert.equal(diffCall[3], 'stashsha1', '有基线时必须跟基线比，不能跟检出点比（否则人的改动全被算成 agent 的）')
    assert.ok(!diffCall.includes('base123'), '有基线就不该再拿 baseCommit 当端点')
  })

  await check('执行器：agent 改了人正在改的那个未跟踪文件，照样提交（内容哈希变了）', async () => {
    // 不能因为「这个路径在基线里」就一概跳过：人改了一半、agent 接着改，
    // 内容已经变了，那确实是这次要交付的活。
    const result = await collectChanges({
      git: async (argv) => {
        if (argv[0] === 'status') return { code: 0, stdout: '?? draft.md\0', stderr: '' }
        if (argv[0] === 'hash-object') return { code: 0, stdout: 'h2\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }, {
      cwd: '/repo',
      baseCommit: '',
      baseline: { sha: undefined, head: 'head1', untracked: new Map([['draft.md', 'h1']]) },
      signal: new AbortController().signal,
    })
    assert.deepEqual(result.changes, [{ path: 'draft.md', status: 'create' }])
    // 顺带：baseline.sha 为空（工作区干净时 stash create 回空串）就别跑 diff，
    // 只靠 status —— 干净工作区也没有已跟踪改动可收集。
    assert.equal(result.changes.length, 1)
  })

  await check('执行器：agent 改了人也在改的已跟踪文件，照样提交', async () => {
    // 基线记的是「人改到一半」的那一版；agent 接着改，文件与基线之间就有差异，
    // 那是本次真要交付的东西，必须收下（只是「别把人的改动算进来」，不是「一律不碰」）。
    const result = await collectChanges({
      git: async (argv) => {
        if (argv[0] === 'diff') return { code: 0, stdout: 'M\0user-edit.txt\0', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }, {
      cwd: '/repo',
      baseCommit: 'base123',
      baseline: { sha: 'stashsha1', head: 'head1', untracked: new Map() },
      signal: new AbortController().signal,
    })
    assert.deepEqual(result.changes, [{ path: 'user-edit.txt', status: 'update' }])
  })

  await check('执行器：createBaseline 无 git 运行器返回 undefined，stash create 回空串时 sha 记 undefined', async () => {
    assert.equal(await createBaseline({}, '/repo', new AbortController().signal), undefined, '没有 git 就没有可拍的基线')
    const clean = await createBaseline({
      git: async (argv) => {
        if (argv[0] === 'stash') return { code: 0, stdout: '', stderr: '' } // 干净工作区的真实返回值是空串
        if (argv[0] === 'rev-parse') return { code: 0, stdout: 'head123\n', stderr: '' }
        if (argv[0] === 'status') return { code: 0, stdout: '', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }, '/repo', new AbortController().signal)
    assert.ok(clean, '有 git 就要回一个基线对象')
    assert.equal(clean.sha, undefined, '空串必须当成「没有基线」，否则 git diff "" 会直接 fatal')
    assert.equal(clean.head, 'head123')
    assert.equal(clean.untracked.size, 0)
    assert.equal(clean.dirtyCount, 0)

    // 脏工作区：stash create 回 sha，未跟踪文件记下内容哈希。
    const dirty = await createBaseline({
      git: async (argv) => {
        if (argv[0] === 'stash') return { code: 0, stdout: 'stashsha1\n', stderr: '' }
        if (argv[0] === 'rev-parse') return { code: 0, stdout: 'head123\n', stderr: '' }
        if (argv[0] === 'status') return { code: 0, stdout: ' M a.txt\0?? b.txt\0', stderr: '' }
        if (argv[0] === 'hash-object') return { code: 0, stdout: 'hh-b\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }, '/repo', new AbortController().signal)
    assert.equal(dirty.sha, 'stashsha1')
    assert.deepEqual([...dirty.untracked.keys()], ['b.txt'], '只有未跟踪文件需要记内容哈希')
    assert.equal(dirty.untracked.get('b.txt'), 'hh-b')
    assert.equal(dirty.dirtyCount, 2, '日志里要能说「用户已有 N 个未提交改动」')
  })

  await check('执行器：本地提交对删除与重命名分别给对 pathspec', async () => {
    // 三个坑（都真跑过 git 2.45.1）：
    // 1. `git add -- <已删除路径>` → fatal: pathspec did not match any files
    // 2. 未跟踪文件不先 add → commit 报 pathspec not known to git
    // 3. 重命名只给新路径 → 历史里变成「复制 + 留下旧路径的删除」
    const calls = []
    const commit = await commitLocally({
      git: async (argv) => {
        calls.push(argv)
        if (argv[0] === 'rev-parse') return { code: 0, stdout: 'sha-after\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }, {
      ticket: TICKET,
      worktreePath: '/w',
      branch: 'b',
      files: ['src/added.js', 'src/gone.js', 'src/new-name.js'],
      changes: [
        { path: 'src/added.js', status: 'create' },
        { path: 'src/gone.js', status: 'delete' },
        { path: 'src/new-name.js', status: 'move', from: 'src/old-name.js' },
      ],
      blocked: [],
      verification: { outcome: 'passed', detail: 'ok' },
    })
    assert.equal(commit.sha, 'sha-after')
    const addCall = calls.find((argv) => argv[0] === 'add')
    assert.deepEqual(addCall, ['add', '--', 'src/added.js', 'src/new-name.js'], '删除的文件绝不能进 add（会 fatal）')
    const commitCall = calls.find((argv) => argv[0] === 'commit')
    const sep = commitCall.indexOf('--')
    assert.deepEqual(
      commitCall.slice(sep + 1),
      ['src/added.js', 'src/gone.js', 'src/new-name.js', 'src/old-name.js'],
      '删除路径与重命名的旧路径都必须进 commit 的 pathspec',
    )
  })

  await check('执行器：本地提交全是删除时不发 add（否则 git 直接 fatal）', async () => {
    const calls = []
    await commitLocally({
      git: async (argv) => {
        calls.push(argv)
        if (argv[0] === 'rev-parse') return { code: 0, stdout: 'sha\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }, {
      ticket: TICKET,
      worktreePath: '/w',
      branch: 'b',
      files: ['src/gone.js'],
      changes: [{ path: 'src/gone.js', status: 'delete' }],
      blocked: [],
      verification: { outcome: 'passed', detail: 'ok' },
    })
    assert.equal(calls.filter((argv) => argv[0] === 'add').length, 0, '没有要暂存的路径时不该发 add')
    assert.equal(calls.filter((argv) => argv[0] === 'commit').length, 1)
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

  await check('执行器：git 状态解析 —— -z 格式的 name-status 与 porcelain 都给出 create/update/delete/move', async () => {
    // 生产代码只认 -z（未跟踪目录折叠、路径引号转义、两种格式 rename 字段顺序相反
    // 这三个坑见 contracts/git-status.js）。这里直接喂 -z 原始字节。
    assert.deepEqual(parseNameStatusZ('A\0src/a.js\0M\0src/b.js\0D\0src/c.js\0R100\0src/d.js\0src/e.js\0'), [
      { path: 'src/a.js', status: 'create' },
      { path: 'src/b.js', status: 'update' },
      { path: 'src/c.js', status: 'delete' },
      { path: 'src/e.js', status: 'move', from: 'src/d.js' },
    ])
    // porcelain 的 rename 字段顺序与 name-status 相反：新路径在前，旧的单独一段。
    assert.deepEqual(parseStatusZ('?? src/a.js\0 M src/b.js\0 D src/c.js\0R  src/e.js\0src/d.js\0'), [
      { code: '??', path: 'src/a.js' },
      { code: ' M', path: 'src/b.js' },
      { code: ' D', path: 'src/c.js' },
      { code: 'R ', path: 'src/e.js', from: 'src/d.js' },
    ])
    assert.equal(statusCodeToAction('??'), 'create')
    assert.equal(statusCodeToAction('!!'), 'ignored')
    assert.equal(statusCodeToAction('R '), 'move')
    assert.equal(statusCodeToAction(' D'), 'delete')
    assert.equal(statusCodeToAction('A '), 'create')
    assert.equal(statusCodeToAction(' M'), 'update')
    // 没有状态（老调用方只传 files）就退回 update：这是唯一安全假设。
    assert.deepEqual(normalizeActions(['src/x.js'], undefined), [{ path: 'src/x.js', status: 'update' }])
    assert.deepEqual(normalizeActions(['src/x.js'], [{ path: 'src/x.js', status: 'weird' }]), [{ path: 'src/x.js', status: 'update' }])
  })

  await check('执行器：提交内容按 worktree 拼路径读，不读会话工作区里的同名文件', async () => {
    // 为什么：readFile 是按进程 cwd 解析的，git 给的是仓库相对路径。
    // 不拼 worktree 就可能把工作区里另一个仓库的同名文件提交上去。
    const read = []
    const env = makeRunEnv({ files: ['src/login.js'] })
    // 这条用例只验「读文件拼 worktree 根」，刻意给一个没有 agentPresets 的 ctx；
    // 因此把 agentPreset 留空（=不挂 preset），否则会被「缺 preset 服务」的新闸门拦住。
    env.ctx.config.agentPreset = ''
    // 这条不测工作区：去掉工作区坐标，走「cwd = worktree」那条老路径，
    // 否则会被「有工作区但没 workingDirectory 服务」的闸门拦住（那是另一条用例）。
    const { workspacePath: _wp, workspaceId: _wid, ...ctxWithoutWorkspace } = env.ctx
    const executor = createAgentExecutor({
      agents: { create: async (input) => { await input.setup?.({ get: () => undefined }, env.agent); return { agent: env.agent } } },
      git: async (argv) => {
        if (argv[0] === 'diff') return { code: 0, stdout: 'M\0src/login.js\0', stderr: '' }
        if (argv[0] === 'status') return { code: 0, stdout: '', stderr: '' }
        if (argv[0] === 'rev-parse' && argv[1] === 'HEAD') return { code: 0, stdout: 'abc123def456', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
      readFile: async (path) => { read.push(path); return 'x' },
      runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      getSecret: async () => 'glpat-test',
      createGitlabClient: async (cfg) => createGitlabClient({ ...cfg, fetch: env.gitServer.fetchImpl }),
      prompts: { untrustedNotice: NOTICE },
    })
    const result = await executor.run(env.ticket, env.target, ctxWithoutWorkspace)
    assert.equal(result.phase, 'done')
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

  await check('执行器：整条跑下来只提交 agent 改过的文件，人未提交的改动不进提交', async () => {
    // 端到端一条：假 git 按「跟谁比」给不同的改动清单 —— 跟基线比只有 agent 的文件，
    // 跟检出点比会多出人自己未提交的那个。断言最终 commit 的 pathspec 里没有它。
    const env = makeRunEnv({
      stashSha: 'stashsha1',
      changesFor: (ref) => (ref === 'stashsha1'
        ? [{ path: 'src/login.js', status: 'update' }]
        : [{ path: 'src/login.js', status: 'update' }, { path: 'src/user-wip.js', status: 'update' }]),
    })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.phase, 'done')
    assert.deepEqual(result.changedFiles, ['src/login.js'], '只有 agent 改的文件算本次改动')
    assert.equal(env.commits.length, 1)
    const committedPaths = env.commits[0].paths
    assert.ok(!committedPaths.includes('src/user-wip.js'), `人未提交的改动绝不能进 commit：${JSON.stringify(committedPaths)}`)
    assert.deepEqual(committedPaths, ['src/login.js'])
    const diffCall = env.gitCalls.find((argv) => argv[0] === 'diff' && argv[1] === '--name-status')
    assert.equal(diffCall[3], 'stashsha1', '收集改动必须跟基线比')
    // 日志必须把「谁的改动进了提交」写清楚，否则人只看到自己改的文件没进提交，会以为执行器丢了东西。
    assert.ok(env.logs.some((line) => line.includes('基线') && line.includes('本次只提交')), `缺少基线日志：${env.logs.join(' | ')}`)
  })

  await check('执行器：拍基线失败时退回检出点收集，票照样跑完（基线失败不能让整票失败）', async () => {
    // 老 git / 仓库有锁之类会让 `git stash create` 失败。这时候宁可退化成老行为
    // （可能把人的改动一起提交），也不能让一张本来能跑通的票直接失败。
    const env = makeRunEnv({ stashFails: true })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(result.phase, 'done', '拍不到基线不是失败')
    const diffCall = env.gitCalls.find((argv) => argv[0] === 'diff' && argv[1] === '--name-status')
    assert.equal(diffCall[3], 'base123', '没有基线就退回检出点，行为与改造前一致')
  })

  await check('执行器：keepSession 缺省（保留会话）只释放 agent，不动会话', async () => {
    // 缺省是「保留」：agent 必须释放（否则每次跑票泄漏一个 agent 实例），
    // 但会话不能收 —— 会话要留在项目工作区名下，人可以在 GUI 里点进去继续追问。
    // 所以这里给上 sessions 服务，断言它一次都没被调用。
    const env = makeRunEnv({ sessionsService: 'close' })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(env.state.disposed, true, 'agent 永远要释放，跟 keepSession 无关')
    assert.deepEqual(env.setupState.sessionCloseCalls, [], 'keepSession 缺省为 true，绝不能偷收会话')
    assert.deepEqual(env.setupState.sessionDisposeCalls, [], 'keepSession 缺省为 true，绝不能偷收会话')
    assert.ok(typeof result.sessionId === 'string' && result.sessionId.length > 0, '会话留在工作区名下，id 必须带回去')
  })

  await check('执行器：keepSession=false 时额外把会话收掉（agent 照样释放）', async () => {
    const env = makeRunEnv({ keepSession: false, sessionsService: 'close' })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(env.state.disposed, true, '关会话不能顶替释放 agent')
    assert.equal(env.setupState.sessionCloseCalls.length, 1, 'keepSession=false 必须把会话关掉一次')
    assert.equal(env.setupState.sessionCloseCalls[0], result.sessionId, '关的必须是这次用的那个会话')
  })

  await check('执行器：keepSession=false 但本机没有会话服务时只记日志，不影响票的结论', async () => {
    const env = makeRunEnv({ keepSession: false })
    const result = await env.executor.run(env.ticket, env.target, env.ctx)
    assert.equal(env.state.disposed, true)
    assert.equal(result.phase, 'done', '拿不到会话服务不能把已经跑成的票判成失败')
    assert.equal(result.sessionId.length > 0, true)
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
    assert.equal(isAllowedGitCommand(['add', '--', 'src/a.js']), true)
    assert.equal(isAllowedGitCommand(['commit', '-m', 'x']), true)
    // 全量暂存被禁：`add -A` 会把敏感文件也塞进索引，人一回来 `git commit` 就带走了。
    // 只认点名暂存（`add -- <文件…>`）。
    for (const argv of [
      ['add', '-A'],
      ['add', '.'],
      ['add', '--'],
      ['push'], ['push', 'origin', 'main'], ['fetch', 'origin'], ['reset', '--hard'], ['clean', '-fd'],
    ]) {
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

  await check('执行器：命令串认引号（Windows 路径有空格），但仍不解释 shell 语法', async () => {
    assert.deepEqual(splitCommand('npm run build'), ['npm', 'run', 'build'])
    assert.deepEqual(splitCommand('  mvn   -o test  '), ['mvn', '-o', 'test'])
    assert.deepEqual(splitCommand(''), [])
    // 引号内的空格不切分：Windows 上 `C:\Program Files\...` 是常态。
    assert.deepEqual(
      splitCommand('node "C:\\Program Files\\x\\check.mjs" --fast'),
      ['node', 'C:\\Program Files\\x\\check.mjs', '--fast'],
    )
    assert.deepEqual(splitCommand("node 'a b/c.mjs'"), ['node', 'a b/c.mjs'])
    // 空引号是一个"空参数"，不能丢：丢了就变成少传一个参数。
    assert.deepEqual(splitCommand('node ""'), ['node', ''])
    // `&&` 仍原样留着 —— 配置项不该成为 shell 注入面。
    assert.deepEqual(splitCommand('a && b'), ['a', '&&', 'b'])
    // 引号没闭合：报 invalid-input，而不是当成"参数里带了个引号"。
    assert.throws(() => splitCommand('node "unterminated'), /引号没有闭合/)
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
