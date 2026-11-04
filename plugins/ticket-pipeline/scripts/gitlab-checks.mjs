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
  parseGitRemote,
  resolveGitlab,
  splitCommand,
} from '../src/adapters/executor-agent/index.js'

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
  const state = { followups, injects, get cancelled () { return cancelled }, get released () { return released } }
  /** @type {Array<() => void>} */
  const abortWaiters = []

  const agent = {
    status: 'idle',
    session: { get seq () { return seq } },
    followup (message) {
      followups.push(message)
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
  return { agent, state }
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

  const agents = {
    create: async (input) => {
      created.push(input)
      return { agent }
    },
  }

  const git = async (argv, _opts) => {
    gitCalls.push(argv)
    if (argv[0] === 'diff' && argv[1] === '--name-only') return { code: 0, stdout: files.join('\n'), stderr: '' }
    if (argv[0] === 'status') return { code: 0, stdout: options.gitStatusOutput ?? '', stderr: '' }
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

  return { executor, ctx, controller, state, agent, created, phases, gitCalls, gitServer, ticket: TICKET, target: { repoPath: '/repo', remote: 'git@gitlab.example.com:group/sub/repo.git', baseBranch: 'main' } }
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
