/**
 * 离线全链路自测。
 *
 * 这不是单元测试，是**证据**：用 mock 四件套把内核整条链路真跑一遍，
 * 逐条断言架构文档里承诺的行为。任何一条挂了，说明内核有回归。
 *
 * 跑法：
 * ```
 * cd plugins/ticket-pipeline && node scripts/dev-run.mjs
 * ```
 * 不依赖 DSH、不联网、不碰任何真实项目仓库、不需要凭据。
 *
 * 通用化后：mock source 每个项目一个实例（projectId 默认 'demo'），
 * 仓库定位器用 `createTableLocator`（查 projects[]），票据主键是
 * `ticketKey(projectId, recordId)` 复合键。
 */

import assert from 'node:assert/strict'

import { TicketStore, makeDomainRepo, makeMemoryRepo, ticketKey } from '../src/core/store.js'
import { createScheduler } from '../src/core/scheduler.js'
import { recoverPending } from '../src/core/recover.js'
import { createMockSource } from '../src/adapters/source-mock/index.js'
import { createMockExecutor } from '../src/adapters/executor-mock/index.js'
import { createMockPush } from '../src/adapters/push-mock/index.js'
import { createTableLocator } from '../src/adapters/locator-table/index.js'
import { makeExecResult } from '../src/contracts/work-executor.js'
import { PipelineError } from '../src/contracts/errors.js'
import { canTransition } from '../src/contracts/types.js'
import { fingerprintOf } from '../src/contracts/types.js'
import { validateConfig, describeConfig } from '../src/core/config.js'
import { createPipelineCancelTool } from '../src/tools/pipeline-cancel.js'
import { createPipelineResetTool } from '../src/tools/pipeline-reset.js'
import { createPipelineDoctorTool } from '../src/tools/pipeline-doctor.js'
import { createPipelineStatusTool } from '../src/tools/pipeline-status.js'
import { stripUndefined } from '../src/tools/define.js'
import { sanitizeBranchName } from '../src/core/branch-name.js'
import { pushplusOptionsFromConfig } from '../src/adapters/push-pushplus/index.js'
import { runFeishuChecks } from './feishu-checks.mjs'
import { runGitlabChecks } from './gitlab-checks.mjs'
import { runQqmailChecks } from './push-qqmail-checks.mjs'
import { runWpsChecks } from './wps-checks.mjs'
import { runWorkspaceChecks } from './workspace-checks.mjs'
import { apply, detectBaseBranch, makeCommandRunner, makeGitRunner, fullAccessSandboxPolicy, inspectCheckout, assertCleanCheckout } from '../src/index.js'
import { isIsolatedWorktreePath } from '../src/core/worktree-path.js'

// ── 小工具 ────────────────────────────────────────────────

let passed = 0
let failed = 0
const failures = []

/** 默认 mock 项目名，也是默认 mock source 的 projectId。 */
const DEMO = 'demo'
/** 默认 mock 项目名对应的复合主键（recordId 参数化）。 */
const k = (recordId) => ticketKey(DEMO, recordId)

/**
 * @param {string} name
 * @param {() => Promise<void> | void} fn
 */
async function check (name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`  ✗ ${name}`)
    console.log(`    ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** @param {string} title */
function section (title) {
  console.log(`\n${title}`)
}

const silent = () => {}

/**
 * 造一套跑完整链路的依赖。
 * @param {Object} [options]
 */
function harness (options = {}) {
  const repo = makeMemoryRepo()
  const store = new TicketStore({ repo, log: silent })
  const source = options.source ?? createMockSource()
  const executor = options.executor ?? createMockExecutor()
  const push = options.push ?? createMockPush()
  const locator = options.locator ?? createTableLocator({
    projects: [{ name: DEMO, repo: { path: 'D:/WorkSpace/demo-repo' } }],
  })

  const config = {
    enabled: true,
    maxAttempts: 2,
    leaseTtlMinutes: 10,
    leaseHeartbeatSeconds: 60,
    ticketTimeoutMinutes: 40,
    worktreeRetentionHours: 24,
    notifyOn: ['done', 'skipped', 'failed', 'needs-info'],
    ...(options.config ?? {}),
  }

  const scheduler = createScheduler({
    store,
    sources: [source],
    locator,
    executor,
    push,
    config,
    log: silent,
    saveImage: options.saveImage,
    prepareWorkspace: options.prepareWorkspace,
    removeWorktree: options.removeWorktree,
  })
  return { repo, store, source, executor, push, locator, config, scheduler }
}

// ── 断言开始 ──────────────────────────────────────────────

async function main () {
  console.log('工单流水线 · 离线全链路自测')

  section('1. 契约层')
  await check('转移表：合法与非法', () => {
    assert.equal(canTransition('pending', 'worktree-ready'), true)
    assert.equal(canTransition('done', 'pending'), false, 'done 是终态，不可退回')
    assert.equal(canTransition('pending', 'planning'), false, '没有工作区不能直接规划')
    assert.equal(canTransition('failed', 'pending'), true, '人工重置路径必须留着')
  })

  await check('指纹不受「是否处理」影响', () => {
    const base = { description: 'a', module: 'b', flow: 'c', screenshots: [], priority: 'high', department: 'd' }
    const a = fingerprintOf({ ...base, status: '处理中' })
    const b = fingerprintOf({ ...base, status: '是' })
    assert.equal(a, b, 'status 不在指纹字段里')
    const c = fingerprintOf({ ...base, status: '处理中', description: 'a2' })
    assert.notEqual(a, c, '描述变了指纹必须变')
  })

  await check('指纹可复现：同一输入两次一致', () => {
    const t = { description: '翻页跳回', module: '列表', screenshots: [{ kind: 'path', path: 'C:\\a\\1.png' }] }
    assert.equal(fingerprintOf(t), fingerprintOf(t))
  })

  await check('makeExecResult 拦住 skipped 没写 testDetail', () => {
    assert.throws(
      () => makeExecResult({ phase: 'skipped', changedFiles: [], testOutcome: 'skipped', mr: { iid: 1, url: 'x' } }),
      /testDetail/,
    )
  })

  await check('makeExecResult 拦住 done 没给 mr', () => {
    assert.throws(() => makeExecResult({ phase: 'done', changedFiles: [], testOutcome: 'passed' }), /mr/)
  })

  section('2. 队列与租约')
  await check('入队 → pickNext 拿到；优先级高的先出', async () => {
    const { store } = harness()
    const source = createMockSource()
    const scan = await source.scan(new AbortController().signal)
    assert.equal(scan.created.length, 3)
    for (const ticket of scan.created) await store.enqueue(ticket, { phase: 'pending' })
    const next = store.pickNext()
    assert.ok(next, '应该有一张')
    assert.equal(next.recordId, 'rec-mock-001', 'high 优先级应该排最前')
  })

  await check('租约：第二个 owner 抢不到', async () => {
    const repo = makeMemoryRepo()
    const a = new TicketStore({ repo, log: silent })
    const b = new TicketStore({ repo, log: silent })
    const source = createMockSource()
    const scan = await source.scan(new AbortController().signal)
    await a.enqueue(scan.created[0], {})
    assert.equal(await a.acquireLease(k('rec-mock-001'), 60_000), true)
    assert.equal(await b.acquireLease(k('rec-mock-001'), 60_000), false, '别人还占着')
    assert.equal(b.isLeasedByOther(k('rec-mock-001')), true)
    await a.releaseLease(k('rec-mock-001'))
    assert.equal(await b.acquireLease(k('rec-mock-001'), 60_000), true, '释放后可以抢')
  })

  await check('非法转移被拒绝且不抛', async () => {
    const { store } = harness()
    const source = createMockSource()
    const scan = await source.scan(new AbortController().signal)
    await store.enqueue(scan.created[0], { phase: 'done' })
    const result = await store.setPhase(k('rec-mock-001'), 'pending')
    assert.equal(result, undefined, '终态不可退回')
    assert.equal(store.getTicket(k('rec-mock-001')).phase, 'done')
  })

  section('2b. 多项目主键隔离')
  await check('两个项目同 recordId 不串票', async () => {
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const s1 = createMockSource({ projectId: 'alpha' })
    const s2 = createMockSource({ projectId: 'beta' })
    const scan1 = await s1.scan(new AbortController().signal)
    const scan2 = await s2.scan(new AbortController().signal)
    await store.enqueue(scan1.created[0], {})
    await store.enqueue(scan2.created[0], {})
    assert.equal(store.listTickets().length, 2, '两个项目各一张，不互相覆盖')
    assert.equal(store.getTicket(ticketKey('alpha', 'rec-mock-001')).projectId, 'alpha')
    assert.equal(store.getTicket(ticketKey('beta', 'rec-mock-001')).projectId, 'beta')
  })

  section('3. 整轮 tick（mock 全链路）')
  await check('一轮跑完整条链路，票到 done，通知一条', async () => {
    const { scheduler, store, push } = harness()
    const result = await scheduler.tick()
    assert.equal(result.status, 'ok')
    assert.equal(result.scan.created, 3, '三条新票都该入队')
    assert.ok(result.ran, '这一轮应该真跑了票')
    assert.equal(result.ran.recordId, 'rec-mock-001', '高优先级先跑')
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'done')
    assert.equal(row.testOutcome, 'passed')
    assert.ok(row.commit, '必须存下本地提交')
    assert.ok(String(row.commit.sha).length > 0, 'commit 要带 sha')
    assert.deepEqual(row.commit.files, row.changedFiles, '提交的文件要与改动文件对得上')
    assert.equal(push.messages.length, 1, 'done 只发一条通知')
    assert.match(push.messages[0].title, /已完成/)
    assert.match(push.messages[0].body, /本地提交：/, '通知书里要能直接看到提交在哪')
  })

  await check('并发恒为 1：一轮最多跑一票', async () => {
    const { scheduler, store } = harness()
    const result = await scheduler.tick()
    assert.equal(result.ran !== null, true)
    const pendingCount = store.listTickets().filter((r) => r.phase === 'pending').length
    assert.equal(pendingCount, 2, '另外两张还在排队')
  })

  await check('第二轮接着跑第二张', async () => {
    const { scheduler, store } = harness()
    await scheduler.tick()
    await scheduler.tick()
    const done = store.listTickets().filter((r) => r.phase === 'done')
    assert.equal(done.length, 2)
  })

  await check('单飞：tick 重入被拒', async () => {
    const { scheduler } = harness({ executor: createMockExecutor({ stepsDelayMs: 20 }) })
    const first = scheduler.tick()
    const second = await scheduler.tick()
    assert.equal(second.status, 'already-running')
    await first
  })

  await check('enabled=false 时不动手', async () => {
    const { scheduler } = harness({ config: { enabled: false } })
    const result = await scheduler.tick()
    assert.equal(result.status, 'disabled')
  })

  section('4. 各种失败与收尾')
  await check('扫描失败要暴露出来，不能假装没变化', async () => {
    const source = createMockSource({ failScan: true })
    const { scheduler } = harness({ source })
    const result = await scheduler.tick()
    assert.equal(result.status, 'scan-failed')
    assert.match(result.error ?? '', /network/)
  })

  await check('截图取不到 → needs-info + 通知，票不 fail', async () => {
    const source = createMockSource({ failScreenshot: true })
    source.seeds[0].screenshot = { kind: 'path', path: 'D:/shots/1.png' }
    // 让 scheduler 真的去取那张图
    const { scheduler, store, push } = harness({ source, saveImage: async () => {} })
    const result = await scheduler.tick()
    assert.ok(result.ran)
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'needs-info', '截图取不到应该是 needs-info，不是 failed')
    assert.equal(push.messages.length, 1)
    assert.match(push.messages[0].title, /等你补信息/)
  })

  await check('执行器返回 failed → failed + 通知', async () => {
    const { scheduler, store, push } = harness({ executor: createMockExecutor({ outcome: 'failed' }) })
    const result = await scheduler.tick()
    assert.ok(result.ran)
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'failed')
    assert.equal(push.messages.length, 1)
    assert.match(push.messages[0].title, /失败/)
  })

  await check('skipped 也是成功路径：MR 有、原因有', async () => {
    const { scheduler, store, push } = harness({ executor: createMockExecutor({ outcome: 'skipped' }) })
    await scheduler.tick()
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'skipped')
    assert.equal(row.testOutcome, 'skipped')
    assert.ok(row.testDetail, '必须写清为什么没跑')
    assert.match(push.messages[0].body, /未跑成/)
  })

  await check('超时 → failed + 通知，worktree 保留', async () => {
    const { scheduler, store, push } = harness({
      executor: createMockExecutor({ hang: true }),
      // maxAttempts:1：这条测的是「超时怎么收尾」，不是「退避几次」。
      config: { ticketTimeoutMinutes: 0.005, maxAttempts: 1 }, // 300ms
    })
    const report = await scheduler.tick()
    // 光断言票据字段不够：tick 返回的 ran.ok 才是「这一轮这张票算不算结束」的口径，
    // 它决定调度器要不要继续推。（超时是终态，ok 必须为 true。）
    assert.ok(report.ran, '这一轮应该真的跑到了一张票')
    assert.equal(report.ran.recordId, 'rec-mock-001')
    assert.equal(report.ran.ok, true, '超时是终态，必须算这一轮结束')
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'failed')
    assert.match(row.lastError ?? '', /超时/)
    assert.equal(push.messages.length, 1)
    assert.match(push.messages[0].title, /失败/)
  })

  await check('通知失败不改变票据状态', async () => {
    const push = createMockPush({ fail: true })
    const { scheduler, store } = harness({ push })
    await scheduler.tick()
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'done', '活已经干完了，通知失败不能回滚状态')
  })

  await check('执行器抛可重试错误 → 票回 pending 退避重试，不判死也不发通知', async () => {
    // 为什么：模型限流、上游 5xx 这类故障是「等一会儿再来」，
    // 判成 failed 就等于永久放弃这张票，人却只看到一句失败通知。
    const failing = {
      id: 'boom',
      async run () {
        throw new PipelineError('rate-limit', '上游限流了，稍后再来', undefined, 1234)
      },
    }
    const { scheduler, store, push } = harness({ executor: failing })
    await scheduler.tick()
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'pending', '可重试错误要让票留在队列里，不能判死')
    assert.equal(row.attempt, 1)
    assert.match(row.lastError ?? '', /rate-limit/)
    assert.ok((row.enqueuedAt ?? 0) > 0, '要写退避后的入队时间')
    assert.equal(push.messages.length, 0, '还没最终失败，不用打扰人')
  })

  await check('执行器抛不可重试错误 → failed + 通知', async () => {
    const failing = {
      id: 'boom',
      async run () {
        throw new PipelineError('invalid-input', '这活没法干：配置缺了')
      },
    }
    const { scheduler, store, push } = harness({ executor: failing })
    await scheduler.tick()
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'failed')
    assert.equal(push.messages.length, 1)
    assert.match(push.messages[0].title, /失败/)
  })

  section('5. 修订、退役与人工重置')
  await check('跑到一半被改 → 记修订、排到队尾、不打断', async () => {
    const { scheduler, store, source } = harness()
    await scheduler.tick() // 跑掉 001
    const before = store.getTicket(k('rec-mock-002'))
    source.seeds.find((s) => s.recordId === 'rec-mock-002').description = '改过的描述'
    await scheduler.tick() // 这一轮先扫到修订
    const after = store.getTicket(k('rec-mock-002'))
    assert.ok(after.revisionCount > before.revisionCount, '修订计数要加')
    await scheduler.tick() // 再一轮把它跑掉
    assert.equal(store.getTicket(k('rec-mock-002')).phase, 'done')
  })

  await check('删除行：连续 3 轮没扫到才退役', async () => {
    const { scheduler, store, source } = harness()
    await scheduler.tick() // 跑掉 001
    await scheduler.tick() // 跑掉 002
    // 让 003 停在 needs-info：否则下一轮它会先被跑成 done，
    // 而终态票本来就不参与退役（否则会覆盖掉已完成的成果），测不到退役逻辑。
    await store.setPhase(k('rec-mock-003'), 'needs-info')
    source.removeSeed('rec-mock-003')
    await scheduler.tick()
    assert.equal(store.getTicket(k('rec-mock-003')).phase, 'needs-info', '第一轮还不该退役')
    await scheduler.tick()
    await scheduler.tick()
    assert.equal(store.getTicket(k('rec-mock-003')).phase, 'gone', '第三轮退役')
  })

  await check('failed 票不会被自动重跑', async () => {
    const { scheduler, store } = harness({ executor: createMockExecutor({ outcome: 'failed' }) })
    await scheduler.tick()
    assert.equal(store.getTicket(k('rec-mock-001')).phase, 'failed')
    const result = await scheduler.tick()
    // 下一张是 002，不是重跑 001
    assert.notEqual(result.ran?.recordId, 'rec-mock-001')
  })

  await check('人工重置让 failed 票重新入队', async () => {
    const { scheduler, store, executor } = harness({ executor: createMockExecutor({ outcome: 'failed' }) })
    await scheduler.tick()
    assert.equal(await store.resetByHuman(k('rec-mock-001')), true)
    executor.setOutcome('done')
    // 清掉其余的票，只留 001，保证下一轮必跑到它
    store.listTickets()
      .filter((r) => r.recordId !== 'rec-mock-001')
      .forEach((r) => { r.phase = 'skipped' })
    await scheduler.tick()
    assert.equal(store.getTicket(k('rec-mock-001')).phase, 'done')
  })

  section('6. 启动恢复')
  await check('中间态票从当前阶段继续，不从头重跑', async () => {
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const source = createMockSource()
    const scan = await source.scan(new AbortController().signal)
    await store.enqueue(scan.created[0], { phase: 'worktree-ready' })
    await store.setPhase(k('rec-mock-001'), 'planning', { worktreePath: 'D:/wt/x', branch: 'ticket-rec-mock-001-r1' })

    const result = await recoverPending({
      store,
      worktreeExists: async () => true,
      log: silent,
    })
    assert.equal(result.resumed, 1)
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'planning', '应该停在 planning 重做，而不是回到 pending')
    assert.equal(row.worktreePath, 'D:/wt/x', '工作区还在就要接着用')
  })

  await check('工作区丢了 → 退回 worktree-ready 重建', async () => {
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const source = createMockSource()
    const scan = await source.scan(new AbortController().signal)
    await store.enqueue(scan.created[0], { phase: 'worktree-ready' })
    await store.setPhase(k('rec-mock-001'), 'planning', { worktreePath: 'D:/wt/gone' })

    const result = await recoverPending({ store, worktreeExists: async () => false, log: silent })
    assert.equal(result.reset, 1)
    assert.equal(store.getTicket(k('rec-mock-001')).phase, 'worktree-ready')
  })

  await check('needs-info 恢复时不动它', async () => {
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const source = createMockSource()
    const scan = await source.scan(new AbortController().signal)
    await store.enqueue(scan.created[0], { phase: 'needs-info' })
    const result = await recoverPending({ store, worktreeExists: async () => true, log: silent })
    assert.equal(result.skipped, 1)
    assert.equal(store.getTicket(k('rec-mock-001')).phase, 'needs-info')
  })

  section('7. 通用仓库定位器（projects[] 查表）')
  await check('按 projectId 定位到项目仓库，不猜模块', async () => {
    const locator = createTableLocator({
      projects: [
        { name: 'alpha', repo: { path: 'D:/WorkSpace/demo-repo', remote: 'http://gitlab.example.com/mk/end/demo-repo.git', baseBranch: 'main', targetBranch: 'main' } },
        { name: 'beta', repo: { path: 'D:/WorkSpace/demo-repo-2' } },
      ],
    })
    const result = await locator.locate({ projectId: 'alpha', recordId: 'x', description: 'd', screenshots: [], fingerprint: '', revisionCount: 1 })
    assert.equal(result.repoPath, 'D:/WorkSpace/demo-repo')
    assert.equal(result.baseBranch, 'main')
    assert.equal(result.targetBranch, 'main')
    assert.equal(result.ambiguous, false, '查表定位不应该有歧义')
    assert.deepEqual(result.candidatePaths, [], '不再做模块→代码路径推断')
  })

  await check('未知 projectId 抛 invalid-input，不硬猜', async () => {
    const locator = createTableLocator({ projects: [{ name: 'alpha', repo: { path: 'D:/WorkSpace/demo-repo' } }] })
    await assert.rejects(
      () => locator.locate({ projectId: 'nope', recordId: 'x', description: 'd', screenshots: [], fingerprint: '', revisionCount: 1 }),
      /没有项目 "nope"/,
    )
  })

  await check('缺少 projectId 抛 invalid-input', async () => {
    const locator = createTableLocator({ projects: [{ name: 'alpha', repo: { path: 'D:/WorkSpace/demo-repo' } }] })
    await assert.rejects(
      () => locator.locate({ recordId: 'x', description: 'd', screenshots: [], fingerprint: '', revisionCount: 1 }),
      /缺少 projectId/,
    )
  })

  // 一个项目配错不该让整个插件挂载失败（G4）：构造期只记录，locate() 碰到才抛。
  await check('项目名重复：构造不抛，记进 brokenProjects，locate 时才报错', async () => {
    const locator = createTableLocator({
      projects: [{ name: 'alpha', repo: { path: 'a' } }, { name: 'alpha', repo: { path: 'b' } }],
    })
    assert.equal(locator.brokenProjects.length, 1)
    assert.equal(locator.brokenProjects[0].projectId, 'alpha')
    assert.match(locator.brokenProjects[0].reason, /重复/)
    await assert.rejects(() => locator.locate({ projectId: 'alpha', recordId: 'x' }), /重复/)
  })

  section('8. 工作区清理')
  await check('done 且超保留期才清；failed 永不自动清；主检出永不进清理候选', async () => {
    const { repo, store } = harness()
    const source = createMockSource()
    const scan = await source.scan(new AbortController().signal)
    const old = Date.now() - 10 * 24 * 3600 * 1000
    // 只有插件自己开的隔离 worktree 才会被清（`<repo>/.agents/worktrees/<name>`）。
    const isolated = (name) => `D:/repo/.agents/worktrees/${name}`

    // 终态票直接以终态入队（`pending → done` 不是合法转移，走 setPhase 会被拒），
    // 再用 repo.put 硬写 finishedAt —— setPhase 落终态时会把 finishedAt 盖成「现在」。
    await store.enqueue(scan.created[0], { phase: 'done' })
    await repo.put('tickets', k('rec-mock-001'), {
      ...store.getTicket(k('rec-mock-001')),
      worktreePath: isolated('ticket-demo-rec-mock-001-r1'),
      finishedAt: old,
    })
    // 刚完成的 done：还在保留期内，不该被清
    await store.enqueue(scan.created[2], { phase: 'done' })
    await repo.put('tickets', k('rec-mock-003'), {
      ...store.getTicket(k('rec-mock-003')),
      worktreePath: isolated('ticket-demo-rec-mock-003-r1'),
      finishedAt: Date.now(),
    })
    await store.enqueue(scan.created[1], { phase: 'failed' })
    await repo.put('tickets', k('rec-mock-002'), {
      ...store.getTicket(k('rec-mock-002')),
      worktreePath: isolated('ticket-demo-rec-mock-002-r1'),
      finishedAt: old,
    })

    const expired = store.listExpiredWorktrees(3600 * 1000)
    const ids = expired.map((r) => r.recordId)
    assert.ok(ids.includes('rec-mock-001'), 'done 超期要清')
    assert.equal(ids.includes('rec-mock-003'), false, '还在保留期内不该清')
    assert.equal(ids.includes('rec-mock-002'), false, 'failed 的永不自动清')

    // 缺省模式（不开 isolateWorktree）票据的 worktreePath 就是人的主检出。
    // 它再老也不能进清理候选：`git worktree remove --force` 对主检出等于删掉整个工作目录。
    await store.enqueue({ ...scan.created[0], recordId: 'rec-mock-main-checkout' }, { phase: 'done' })
    await repo.put('tickets', k('rec-mock-main-checkout'), {
      ...store.getTicket(k('rec-mock-main-checkout')),
      worktreePath: 'D:/WorkSpace/mgiot-pms',
      finishedAt: old,
    })
    const afterMainCheckout = store.listExpiredWorktrees(3600 * 1000).map((r) => r.recordId)
    assert.equal(afterMainCheckout.includes('rec-mock-main-checkout'), false, '主检出永不被自动清理')
    assert.ok(afterMainCheckout.includes('rec-mock-001'), '真实隔离目录照旧要清')
  })

  section('9. 飞书适配器（离线打桩，不联网）')
  await runFeishuChecks(check)

  section('10. P0 修复：租约心跳 / 注入时钟 / 送达回执配置 / 人工取消')
  await check('跑票期间定期续租，长票不会被别的进程抢走', async () => {
    const { scheduler, store } = harness({
      executor: createMockExecutor({ stepsDelayMs: 120 }),
      config: { leaseHeartbeatSeconds: 0.02 },
    })
    const original = store.renewLease.bind(store)
    let renewals = 0
    store.renewLease = async (...args) => {
      renewals += 1
      return original(...args)
    }
    await scheduler.tick()
    assert.ok(renewals >= 2, `心跳至少要续租两次，实际 ${renewals} 次`)
    assert.equal(store.getTicket(k('rec-mock-001')).phase, 'done')
  })

  await check('续租失败 → 让出这票：回 pending、不通知人', async () => {
    const { scheduler, store, push } = harness({
      executor: createMockExecutor({ stepsDelayMs: 200 }),
      config: { leaseHeartbeatSeconds: 0.02 },
    })
    // 模拟租约被别的进程抢走：续租一律失败。
    store.renewLease = async () => false
    await scheduler.tick()
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'pending', '租约丢了要放回队列，不能当成失败')
    assert.match(row.lastError ?? '', /租约丢失/)
    assert.equal(push.messages.length, 0, '让出不是失败，不该打扰人')
  })

  await check('启动恢复用注入的时钟写 enqueuedAt，不依赖真时钟', async () => {
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const source = createMockSource()
    const scan = await source.scan(new AbortController().signal)
    await store.enqueue(scan.created[0], { phase: 'worktree-ready' })
    await store.setPhase(k('rec-mock-001'), 'planning', { worktreePath: 'D:/wt/x' })

    const fixed = 1_700_000_000_000
    const result = await recoverPending({
      store,
      worktreeExists: async () => true,
      log: silent,
      now: () => fixed,
    })
    assert.equal(result.resumed, 1)
    assert.equal(store.getTicket(k('rec-mock-001')).enqueuedAt, fixed)
  })

  await check('pushplus.callbackUrl 进得了配置（否则送达回执永远拿不到）', async () => {
    const result = validateConfig({ pushplus: { callbackUrl: 'https://cb.example/hook' } })
    assert.ok(result.value, `校验应当通过：${JSON.stringify(result.issues ?? [])}`)
    assert.equal(result.value.pushplus.callbackUrl, 'https://cb.example/hook')
    const options = pushplusOptionsFromConfig(result.value)
    assert.equal(options.callbackUrl, 'https://cb.example/hook')
  })

  await check('describeConfig：token 打码，送达回执地址照常显示', async () => {
    const result = validateConfig({ pushplus: { token: 'secret-token', callbackUrl: 'https://cb.example/hook' } })
    const described = describeConfig(result.value)
    assert.equal(described['pushplus.token'], '***(已配置)')
    assert.equal(described['pushplus.callbackUrl'], 'https://cb.example/hook')
  })

  await check('pipeline_cancel 空闲时如实说没东西可取消', async () => {
    const { scheduler } = harness()
    const tool = createPipelineCancelTool({ cancelActive: () => scheduler.cancelActive() })
    const out = await tool.execute({}, {})
    assert.equal(out.cancelled, false)
    assert.match(out.text, /没有票在跑/)
  })

  await check('pipeline_cancel 取消正在跑的那票：落 failed、不通知', async () => {
    const { scheduler, store, push } = harness({ executor: createMockExecutor({ hang: true }) })
    const tool = createPipelineCancelTool({ cancelActive: () => scheduler.cancelActive() })
    const running = scheduler.tick()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const out = await tool.execute({}, {})
    assert.equal(out.cancelled, true)
    await running
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'failed')
    assert.equal(row.lastError, 'cancelled by user')
    assert.equal(push.messages.length, 0, '人工取消不打扰人')
  })

  section('11. §5.1 A 组链路断点：截图进 prompt / 真实工作区 / 失败原因 / 人工重开')

  await check('截图存进附件库后，ref 与内容块真的交给了执行器', async () => {
    // 关键点：showScreenshots 以前只把字节丢进 saveImage 就完事，
    // 返回的 ref 既不传执行器也不进 prompt —— 工单最关键的上下文（截图）等于丢了。
    const source = createMockSource()
    source.seeds[0].screenshot = { kind: 'attachment', fileToken: 'ft-1', name: 'shot.png' }
    const savedRefs = []
    let seenCtx = null
    const executor = {
      id: 'spy',
      async run (ticket, target, ctx) {
        seenCtx = ctx
        await ctx.onPhase('editing')
        await ctx.onPhase('testing')
        await ctx.onPhase('mr-opening')
        return makeExecResult({
          phase: 'done',
          changedFiles: [],
          testOutcome: 'passed',
          mr: { iid: 1, url: 'mock://mr/1', draft: true },
        })
      },
    }
    const { scheduler, store } = harness({
      source,
      executor,
      saveImage: async ({ data, mediaType, name }) => {
        const ref = { refId: `img-${savedRefs.length + 1}`, mediaType, name, bytes: data.length }
        savedRefs.push(ref)
        return ref
      },
    })
    await scheduler.tick()
    assert.equal(store.getTicket(k('rec-mock-001')).phase, 'done')
    assert.equal(savedRefs.length, 1, '截图应该真的被存进附件库')
    assert.ok(Array.isArray(seenCtx.images), '执行器必须拿到 images 数组')
    assert.equal(seenCtx.images.length, 1, '一张截图就该有一个 ref')
    assert.equal(seenCtx.images[0].refId, 'img-1')
    assert.ok(Array.isArray(seenCtx.content), '执行器必须拿到内容块数组')
    assert.equal(seenCtx.content[0].type, 'text', '第一块是任务书正文')
    assert.ok(seenCtx.content[0].text.includes('问题描述'), '正文里要有工单内容')
    const imageBlocks = seenCtx.content.filter((block) => block.type === 'image')
    assert.equal(imageBlocks.length, 1, '截图表现在内容块里')
    assert.equal(imageBlocks[0].image.refId, 'img-1', '内容块指向同一份 ref')
    assert.equal(imageBlocks[0].image, seenCtx.images[0], '内容块与 images 必须引用同一个对象，别各拷一份')
    assert.equal(typeof seenCtx.prompt, 'string', 'prompt 字符串仍然保留，向后兼容')
    assert.equal(seenCtx.content[0].text, seenCtx.prompt, 'content 的正文块必须与 prompt 一字不差，否则两条通路会看到两份任务书')
  })

  await check('任务书里带「待修改项目」原文，并明确告诉模型别拿它当目录名', async () => {
    // 真实工单的「模块」「待修改项目」两列都是人随手写的，常与代码里的目录/路由名对不上。
    // 不把这一列交给模型，等于让它拿一个猜的名字去找文件。
    const source = createMockSource()
    source.seeds[0].targetProject = '日报系统'
    source.seeds[0].module = '问题管理'
    let seenCtx = null
    const executor = {
      id: 'spy',
      async run (ticket, target, ctx) {
        seenCtx = ctx
        await ctx.onPhase('editing')
        await ctx.onPhase('testing')
        await ctx.onPhase('mr-opening')
        return makeExecResult({ phase: 'done', changedFiles: [], testOutcome: 'passed', mr: { iid: 1, url: 'mock://mr/1', draft: true } })
      },
    }
    const { scheduler } = harness({ source, executor })
    await scheduler.tick()
    assert.match(seenCtx.prompt, /待修改项目（工单原文）：日报系统/)
    assert.match(seenCtx.prompt, /模块（工单原文）：问题管理/)
    assert.match(seenCtx.prompt, /不要拿它们当目录名直接去改/)
  })

  await check('saveImage 什么都没返回时跳过空图块，不塞进 content', async () => {
    // 离线 mock 的 saveImage 就是返回 undefined：空引用塞进 content 会让适配器组装消息时炸掉。
    const source = createMockSource()
    source.seeds[0].screenshot = { kind: 'attachment', fileToken: 'ft-1', name: 'shot.png' }
    let seenCtx = null
    const executor = {
      id: 'spy',
      async run (ticket, target, ctx) {
        seenCtx = ctx
        await ctx.onPhase('editing')
        await ctx.onPhase('testing')
        await ctx.onPhase('mr-opening')
        return makeExecResult({ phase: 'done', changedFiles: [], testOutcome: 'passed', mr: { iid: 1, url: 'mock://mr/1', draft: true } })
      },
    }
    const { scheduler } = harness({ source, executor, saveImage: async () => {} })
    await scheduler.tick()
    assert.deepEqual(seenCtx.images, [undefined], 'saveImage 返回什么就收集什么')
    assert.equal(seenCtx.content.filter((b) => b.type === 'image').length, 0, '空引用不该变成 image 块')
    assert.equal(seenCtx.content.length, 1, '只剩正文一块')
  })

  await check('没有截图时 images 是空数组，不出 image 块', async () => {
    let seenCtx = null
    const executor = {
      id: 'spy',
      async run (ticket, target, ctx) {
        seenCtx = ctx
        await ctx.onPhase('editing')
        await ctx.onPhase('testing')
        await ctx.onPhase('mr-opening')
        return makeExecResult({ phase: 'done', changedFiles: [], testOutcome: 'passed', mr: { iid: 1, url: 'mock://mr/1', draft: true } })
      },
    }
    const { scheduler } = harness({ executor })
    await scheduler.tick()
    assert.deepEqual(seenCtx.images, [], '没截图就该是空数组，不是 undefined')
    assert.equal(seenCtx.content.filter((b) => b.type === 'image').length, 0)
    assert.equal(seenCtx.content.length, 1, '只有正文一块')
  })

  await check('执行器拿到的是刚建好的工作区，不是入队时的空快照', async () => {
    // 以前 executor.run 读的是 runOne 入参 row 的旧值：prepareWorkspace 刚建好工作区，
    // 局部 row 却没刷新，首次运行 worktreePath / branch / baseCommit 全是 undefined。
    let seenCtx = null
    const executor = {
      id: 'spy',
      async run (ticket, target, ctx) {
        seenCtx = ctx
        await ctx.onPhase('editing')
        await ctx.onPhase('testing')
        await ctx.onPhase('mr-opening')
        return makeExecResult({ phase: 'done', changedFiles: [], testOutcome: 'passed', mr: { iid: 1, url: 'mock://mr/1', draft: true } })
      },
    }
    const calls = []
    const { scheduler, store } = harness({
      executor,
      prepareWorkspace: async (opts) => {
        calls.push(opts)
        return { path: 'D:/wt/ticket-demo-rec-mock-001-r1', branch: 'ticket-demo-rec-mock-001-r1', baseCommit: 'abc123', repoPath: 'D:/WorkSpace/demo-repo' }
      },
    })
    await scheduler.tick()
    assert.equal(calls.length, 1, '应该建一次工作区')
    assert.equal(seenCtx.worktreePath, 'D:/wt/ticket-demo-rec-mock-001-r1', '执行器必须拿到真实路径')
    assert.equal(seenCtx.branch, 'ticket-demo-rec-mock-001-r1', '分支名要传对')
    assert.equal(seenCtx.baseCommit, 'abc123', '基线提交要传对')
    assert.equal(seenCtx.repoPath, 'D:/WorkSpace/demo-repo')
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.worktreePath, 'D:/wt/ticket-demo-rec-mock-001-r1', '存储里也要有')
  })

  await check('已有工作区的票不再重建，执行器拿存储里的路径', async () => {
    let seenCtx = null
    const executor = {
      id: 'spy',
      async run (ticket, target, ctx) {
        seenCtx = ctx
        await ctx.onPhase('editing')
        await ctx.onPhase('testing')
        await ctx.onPhase('mr-opening')
        return makeExecResult({ phase: 'done', changedFiles: [], testOutcome: 'passed', mr: { iid: 1, url: 'mock://mr/1', draft: true } })
      },
    }
    let prepares = 0
    const seenOpts = []
    const { scheduler, store } = harness({
      executor,
      prepareWorkspace: async (opts) => {
        prepares += 1
        seenOpts.push(opts)
        // 已有 worktree 时只补工作区登记，不重建分支 —— 和真实实现一样原样回传坐标
        return {
          path: opts.worktreePath,
          branch: opts.branch,
          baseCommit: opts.baseCommit,
          repoPath: 'D:/WorkSpace/demo-repo',
          workspacePath: 'D:/WorkSpace/demo-repo',
          workspaceId: 'ws-keep',
        }
      },
    })
    const source = createMockSource()
    const scan = await source.scan(new AbortController().signal)
    await store.enqueue(scan.created[0], { phase: 'worktree-ready' })
    await store.setPhase(k('rec-mock-001'), 'planning', { worktreePath: 'D:/wt/keep', branch: 'b-keep', baseCommit: 'c1' })
    // 把它送回可跑的阶段：planning 不是 pickNext 取得到的中间态，先回 pending
    await store.setPhase(k('rec-mock-001'), 'pending')
    await scheduler.tick()
    // 会调一次 prepareWorkspace：老票据没有工作区坐标，要补登记（宿主 Workspace）。
    // 但「补登记」和「重建 worktree」是两件事 —— 传下去的 worktreePath 让实现知道别重建。
    assert.equal(prepares, 1, '缺工作区坐标时要补一次登记')
    assert.equal(seenOpts[0].worktreePath, 'D:/wt/keep', '要把已有 worktree 传给 prepareWorkspace，它才知道不用重建')
    assert.equal(seenCtx.worktreePath, 'D:/wt/keep', '应该沿用存储里的路径')
    assert.equal(seenCtx.branch, 'b-keep')
    assert.equal(seenCtx.baseCommit, 'c1')
  })

  await check('工作区坐标已经在票据上：不再调 prepareWorkspace', async () => {
    let seenCtx = null
    const executor = {
      id: 'spy',
      async run (ticket, target, ctx) {
        seenCtx = ctx
        await ctx.onPhase('editing')
        await ctx.onPhase('testing')
        await ctx.onPhase('mr-opening')
        return makeExecResult({ phase: 'done', changedFiles: [], testOutcome: 'passed', mr: { iid: 1, url: 'mock://mr/1', draft: true } })
      },
    }
    let prepares = 0
    const { scheduler, store } = harness({
      executor,
      prepareWorkspace: async () => {
        prepares += 1
        return { path: 'D:/wt/other', branch: 'b-other', baseCommit: 'c3' }
      },
    })
    const source = createMockSource()
    const scan = await source.scan(new AbortController().signal)
    await store.enqueue(scan.created[0], { phase: 'worktree-ready' })
    await store.setPhase(k('rec-mock-001'), 'planning', {
      worktreePath: 'D:/wt/ready',
      branch: 'b-ready',
      baseCommit: 'c4',
      workspacePath: 'D:/WorkSpace/demo-repo',
      workspaceId: 'ws-42',
    })
    await store.setPhase(k('rec-mock-001'), 'pending')
    await scheduler.tick()
    assert.equal(prepares, 0, '工作区与 worktree 都有了，一次都不该重建')
    assert.equal(seenCtx.worktreePath, 'D:/wt/ready')
    assert.equal(seenCtx.workspacePath, 'D:/WorkSpace/demo-repo', '执行器必须拿到项目工作区路径（会话 cwd 用它）')
    assert.equal(seenCtx.workspaceId, 'ws-42', '工作区 id 要透传，执行器要用它 attach 会话')
  })

  await check('prepareWorkspace 建出来的工作区坐标会落库并传给执行器', async () => {
    let seenCtx = null
    const executor = {
      id: 'spy',
      async run (ticket, target, ctx) {
        seenCtx = ctx
        await ctx.onPhase('editing')
        await ctx.onPhase('testing')
        await ctx.onPhase('mr-opening')
        return makeExecResult({ phase: 'done', changedFiles: [], testOutcome: 'passed', mr: { iid: 1, url: 'mock://mr/1', draft: true } })
      },
    }
    const { scheduler, store } = harness({
      executor,
      prepareWorkspace: async () => ({
        path: 'D:/repo/.agents/worktrees/ticket-demo-rec-mock-001-r1',
        branch: 'ticket-demo-rec-mock-001-r1',
        baseCommit: 'abc123',
        repoPath: 'D:/repo',
        workspacePath: 'D:/repo',
        workspaceId: 'ws-7',
      }),
    })
    await scheduler.tick()
    assert.equal(seenCtx.workspacePath, 'D:/repo', '工作区路径要传给执行器')
    assert.equal(seenCtx.workspaceId, 'ws-7')
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.workspacePath, 'D:/repo', '工作区路径要落库，下一轮才能复用')
    assert.equal(row.workspaceId, 'ws-7')
  })

  await check('prepareWorkspace 只补登记时，不覆盖票据上已有的 worktree 坐标', async () => {
    let seenCtx = null
    const executor = {
      id: 'spy',
      async run (ticket, target, ctx) {
        seenCtx = ctx
        await ctx.onPhase('editing')
        await ctx.onPhase('testing')
        await ctx.onPhase('mr-opening')
        return makeExecResult({ phase: 'done', changedFiles: [], testOutcome: 'passed', mr: { iid: 1, url: 'mock://mr/1', draft: true } })
      },
    }
    const { scheduler } = harness({
      executor,
      prepareWorkspace: async (opts) => ({
        // 只补登记：原样回传传进来的 worktree 坐标
        path: opts.worktreePath,
        branch: opts.branch,
        baseCommit: opts.baseCommit,
        repoPath: 'D:/repo',
        workspacePath: 'D:/repo',
        workspaceId: 'ws-9',
      }),
    })
    await scheduler.tick()
    assert.equal(seenCtx.workspacePath, 'D:/repo')
    assert.equal(seenCtx.workspaceId, 'ws-9')
  })

  await check('首次运行就失败：通知里必须带上刚建好的工作区路径', async () => {
    // 失败票的工作区是留给人的现场。runOne 的 catch 分支要是只铺 ...row（进 runOne 时的快照），
    // 首次运行时快照里压根没有 worktreePath，通知就会缺掉「工作区保留在」那一行。
    let seenCtx = null
    const executor = {
      id: 'spy',
      async run (ticket, target, ctx) {
        seenCtx = ctx
        await ctx.onPhase('editing')
        await ctx.onPhase('failed')
        return makeExecResult({
          phase: 'failed',
          changedFiles: [],
          testOutcome: 'failed',
          error: { kind: 'internal', message: 'mock：首次运行就挂了', retryable: false },
        })
      },
    }
    const { scheduler, push } = harness({
      executor,
      prepareWorkspace: async () => ({ path: 'D:/wt/fresh', branch: 'b-fresh', baseCommit: 'c9' }),
    })
    await scheduler.tick()
    // 基线对照：执行器收到的就是这条路，证明工作区确实建在了这里
    assert.equal(seenCtx.worktreePath, 'D:/wt/fresh')
    assert.equal(push.messages.length, 1)
    assert.match(push.messages[0].body, /工作区保留在：D:\/wt\/fresh/, `失败通知要指出工作区：${push.messages[0].body}`)
  })

  await check('跑到一半抛错（走 catch 分支）：通知里同样要有工作区路径', async () => {
    const executor = {
      id: 'spy',
      async run (ticket, target, ctx) {
        await ctx.onPhase('editing')
        throw new Error('mock：执行器直接抛了')
      },
    }
    // maxAttempts 压到 1：普通 Error 归一到可重试错误，默认配置下这张票会被打回 pending 等下一轮，
    // 根本走不到 catch 里的「判失败 + 通知」那一支 —— 那就测不到我们想测的东西。
    const { scheduler, store, push } = harness({
      executor,
      config: { maxAttempts: 1 },
      prepareWorkspace: async () => ({ path: 'D:/wt/boom', branch: 'b-boom', baseCommit: 'c1' }),
    })
    await scheduler.tick()
    assert.equal(store.getTicket(k('rec-mock-001')).phase, 'failed')
    assert.equal(push.messages.length, 1)
    assert.match(push.messages[0].body, /工作区保留在：D:\/wt\/boom/, `失败通知要指出工作区：${push.messages[0].body}`)
  })

  await check('执行器返回 failed → 通知里给的是这次的失败原因，不是 [object Object]', async () => {
    const { scheduler, push } = harness({ executor: createMockExecutor({ outcome: 'failed', failMessage: 'mock：真实失败原因' }) })
    await scheduler.tick()
    assert.equal(push.messages.length, 1)
    const body = push.messages[0].body
    assert.ok(!body.includes('[object Object]'), `通知正文不能出现对象字符串化：${body}`)
    assert.match(body, /失败原因：internal: mock：真实失败原因/, '失败原因要是这次的错误，不是运行前的旧值')
  })

  await check('done 的通知不残留上一轮的失败原因', async () => {
    // 同一个 TicketStore 里先失败一次、人工重置后再成功一次：
    // enqueue/resetByHuman 之外，通知载荷里的 lastError 必须跟着这次运行走，
    // 否则人会在「已完成」的通知里读到上一轮的失败原因。
    const executor = createMockExecutor({ outcome: 'failed' })
    const { scheduler, store, push } = harness({ executor })
    await scheduler.tick()
    assert.equal(store.getTicket(k('rec-mock-001')).phase, 'failed')
    assert.equal(push.messages.length, 1)

    await store.resetByHuman(k('rec-mock-001'))
    // 其余的票先挪开，保证下一轮必定跑到 001
    store.listTickets()
      .filter((r) => r.recordId !== 'rec-mock-001')
      .forEach((r) => { r.phase = 'skipped' })
    executor.setOutcome('done')
    await scheduler.tick()

    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'done', '重置后应该能跑成')
    assert.equal(row.lastError, undefined, '成功之后存储里不该留着失败原因')
    const doneMsg = push.messages[push.messages.length - 1]
    assert.match(doneMsg.title, /已完成/)
    assert.ok(!doneMsg.body.includes('失败原因'), '已完成的通知不该出现「失败原因」这一节')
  })

  await check('pipeline_reset 把 failed 票放回队列，下一轮真的重跑', async () => {
    const { scheduler, store, executor } = harness({ executor: createMockExecutor({ outcome: 'failed' }) })
    await scheduler.tick()
    assert.equal(store.getTicket(k('rec-mock-001')).phase, 'failed')
    const tool = createPipelineResetTool({ store })
    const out = await tool.execute({ recordId: 'rec-mock-001' }, {})
    assert.equal(out.reset, true, `应该重置成功：${out.text}`)
    assert.equal(store.getTicket(k('rec-mock-001')).phase, 'pending', '重置后回队列')
    assert.equal(store.getTicket(k('rec-mock-001')).lastError, undefined, '失败原因要清掉')
    executor.setOutcome('done')
    store.listTickets().filter((r) => r.recordId !== 'rec-mock-001').forEach((r) => { r.phase = 'skipped' })
    await scheduler.tick()
    assert.equal(store.getTicket(k('rec-mock-001')).phase, 'done', '重开之后要能跑成')
  })

  await check('pipeline_reset 拒绝没见过的 recordId 与不可重置的状态', async () => {
    const { store } = harness({ executor: createMockExecutor({ outcome: 'done' }) })
    const tool = createPipelineResetTool({ store })
    // recordId 是必填参数：缺参数时 defineTool 的 assertArgs 会直接拒掉（比返回 reset:false 更早一步）。
    await assert.rejects(() => tool.execute({}, {}), /缺少必填参数 recordId/)
    // 生造的 recordId 走「没这条票」的分支，不抛错。
    const notFound = await tool.execute({ recordId: '不存在' }, {})
    assert.equal(notFound.reset, false)
    assert.equal(notFound.reason, 'not-found')
  })

  await check('pipeline_reset 对不可重置的状态说不，且不改动那一行', async () => {
    const { store, scheduler } = harness()
    await scheduler.tick()
    const before = store.getTicket(k('rec-mock-001'))
    assert.equal(before.phase, 'done')
    const tool = createPipelineResetTool({ store })
    const out = await tool.execute({ recordId: 'rec-mock-001' }, {})
    assert.equal(out.reset, false)
    assert.equal(out.reason, 'not-resettable')
    assert.equal(store.getTicket(k('rec-mock-001')).phase, 'done', '拒绝时不能把 done 票动成 pending')
  })

  section('11.6 onPhase 的第二参：字符串是「说明」，不能当字段补丁写进票据')

  await check('执行器用字符串描述阶段时，票据里不该多出数字键', async () => {
    // 真实事故：executor-agent 调 ctx.onPhase('testing', '跑项目配置里的验证命令')，
    // 而 scheduler 的 onPhase 把第二参原样当 patch 交给 store.setPhase，
    // setPhase 用 Object.entries 展开它 —— 字符串被展开成 {0:'跑',1:'项',…}，
    // 于是一张票的存储行里多出十几个垃圾字段，一路跟着这条记录活下去。
    let seenCtx = null
    const executor = {
      id: 'spy',
      async run (ticket, target, ctx) {
        seenCtx = ctx
        await ctx.onPhase('editing', 'agent 已接到任务书，开始改代码')
        await ctx.onPhase('testing', '跑项目配置里的验证命令')
        await ctx.onPhase('mr-opening')
        return makeExecResult({ phase: 'done', changedFiles: [], testOutcome: 'passed', mr: { iid: 1, url: 'mock://mr/1', draft: true } })
      },
    }
    const { scheduler, store } = harness({ executor })
    await scheduler.tick()
    assert.equal(typeof seenCtx.onPhase, 'function', '执行器确实拿到了 onPhase')
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'done')
    const numericKeys = Object.keys(row).filter((field) => /^\d+$/.test(field))
    assert.deepEqual(numericKeys, [], '阶段说明被当成补丁展开了：' + numericKeys.join(','))
    assert.equal(row['0'], undefined, '第 0 个字不该成为字段')
  })

  await check('store.setPhase 拒收非对象补丁：字符串补丁必须抛出而不是落库', async () => {
    const { scheduler, store } = harness()
    await scheduler.tick()
    // 把票退回 pending 才好在合法转移上试补丁校验（done 是终态，先撞的是转移表）。
    await store.setPhase(k('rec-mock-001'), 'pending', {}, { force: true })
    const before = store.getTicket(k('rec-mock-001'))
    await assert.rejects(
      () => store.setPhase(k('rec-mock-001'), 'planning', '跑项目配置里的验证命令'),
      /patch 必须是对象/,
    )
    const after = store.getTicket(k('rec-mock-001'))
    assert.equal(after.phase, before.phase, '抛错时票据一个字段都不该动')
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort())
  })

  section('11.5 pipeline_doctor：环境体检')

  await check('pipeline_doctor 全绿：git 可用 + 仓库正常 + 凭据齐', async () => {
    const tool = createPipelineDoctorTool({
      // status --porcelain 必须回空串：缺省模式下「检出干净」是能跑票的前提，
      // 回 'true' 会被当成一堆未提交改动（这条断言就是被它绊过）。
      gitRunner: async (argv) => ({
        code: 0,
        stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'),
        stderr: '',
      }),
      getConfig: () => ({ projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/repo/pms', remote: 'http://gitlab.local/mk/pms.git' } }], workExecutor: 'agent', pushAdapter: 'qqmail', isolateWorktree: false }),
      credentials: { describe: async (ref) => ({ configured: true }) },
    })
    const out = await tool.execute({}, {})
    assert.equal(out.ok, true, `应该全绿：${out.text}`)
    assert.equal(out.problems.length, 0)
    assert.equal(out.warnings.length, 0)
    assert.ok(out.text.includes('检出干净'), '缺省模式下要报告检出是否干净')
    assert.ok(out.text.includes('改代码落点'), '要把改代码落在哪里说出来')
    assert.ok(out.text.includes('项目工作区检出里'), '缺省是就地改，不是隔离 worktree')
  })

  await check('pipeline_doctor 报 git 不可用 + remote 连不上 + mock 提醒', async () => {
    const tool = createPipelineDoctorTool({
      gitRunner: async () => ({ code: 1, stdout: '', stderr: 'fatal: not a git repository' }),
      // 只有显式打开远程出口（repo.gitlab.enabled）才会去握手探测 remote。
      getConfig: () => ({ projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/nope', remote: 'http://gitlab.example.com/mk/pms.git', gitlab: { enabled: true } } }], workExecutor: 'mock', pushAdapter: 'mock' }),
      credentials: null,
      probeRemote: async () => ({ ok: false, reason: "fatal: could not read Username for 'http://gitlab.example.com'" }),
    })
    const out = await tool.execute({}, {})
    assert.equal(out.ok, false, '有问题时必须不是 ok')
    assert.ok(out.problems.length > 0, '要有 problems')
    assert.ok(out.text.includes('连不上'), 'remote 连不上要点名')
    assert.ok(out.text.includes('could not read Username'), '要把 git 的原话带出来，人才知道是认证还是 DNS')
    assert.ok(out.text.includes('mock'), 'mock 状态要提醒')
  })

  await check('pipeline_doctor 用握手判 remote，不靠域名猜占位符', async () => {
    // gitlab.example.com 在有些内网部署里就是真服务器：按域名判占位符会把健康配置报成故障，
    // 而真正连不上的地址反而不一定长得像占位符。
    const make = (probeRemote) => createPipelineDoctorTool({
      gitRunner: async (argv) => (argv[0] === 'ls-remote'
        ? { code: 0, stdout: '', stderr: '' }
        : { code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({ projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/repo/pms', remote: 'http://gitlab.example.com/mk/pms.git', gitlab: { enabled: true } } }], workExecutor: 'agent', pushAdapter: 'qqmail' }),
      credentials: { describe: async () => ({ configured: true }) },
      detectBaseBranch: async () => 'v2.x',
      probeRemote,
    })

    const reachable = await make(async () => ({ ok: true })).execute({}, {})
    assert.equal(reachable.ok, true, `真服务器不该被报成问题：${reachable.text}`)
    assert.ok(!reachable.text.includes('占位符'), '不该再出现「占位符」这个词')
    assert.ok(reachable.text.includes('remote 已连通'), '连通要说清')

    const unreachable = await make(async () => ({ ok: false, reason: 'timeout' })).execute({}, {})
    assert.ok(unreachable.warnings.some((w) => w.includes('连不上')), '连不上要提醒')

    // 没打开远程出口 -> 一次握手都不该发，且要说明「只做本地提交」。
    let probed = 0
    const noRemote = createPipelineDoctorTool({
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({ projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/repo/pms', remote: 'http://gitlab.example.com/mk/pms.git' } }], workExecutor: 'agent', pushAdapter: 'qqmail' }),
      credentials: { describe: async () => ({ configured: true }) },
      probeRemote: async () => { probed += 1; return { ok: true } },
    })
    const out2 = await noRemote.execute({}, {})
    assert.equal(probed, 0, '没开远程出口就不该去连 GitLab')
    assert.ok(out2.text.includes('只做本地提交'), `要说明只做本地提交：${out2.text}`)
  })

  await check('pipeline_doctor 检出脏时要提醒（缺省模式每票都会被拒）', async () => {
    const tool = createPipelineDoctorTool({
      gitRunner: async (argv) => {
        if (argv[0] === 'status') return { code: 0, stdout: ' M a.ts\0?? b.ts\0', stderr: '' }
        return { code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : 'true', stderr: '' }
      },
      getConfig: () => ({ projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/repo/pms' } }], workExecutor: 'agent', pushAdapter: 'qqmail', isolateWorktree: false }),
      credentials: { describe: async () => ({ configured: true }) },
    })
    const out = await tool.execute({}, {})
    assert.ok(out.warnings.some((w) => w.includes('未提交改动')), `脏检出要提醒：${JSON.stringify(out.warnings)}`)
    // 打开隔离开关后就不该再拿「检出脏」说事：那时每票有自己的目录。
    const isolated = createPipelineDoctorTool({
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : 'true', stderr: '' }),
      getConfig: () => ({ projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/repo/pms' } }], workExecutor: 'agent', pushAdapter: 'qqmail', isolateWorktree: true }),
      credentials: { describe: async () => ({ configured: true }) },
    })
    const out3 = await isolated.execute({}, {})
    assert.ok(!out3.warnings.some((w) => w.includes('未提交改动')), '开了隔离就不该再要检出干净')
    assert.ok(out3.text.includes('隔离 worktree'), '要说明改代码落在隔离目录')
  })

  await check('pipeline_doctor 会显示自动识别出的基准分支，并在回退 main 时提醒', async () => {
    // 分支名猜错是这个插件最贵的一种错：fetch 第一步就失败，错误里看不出是分支名问题。
    const base = {
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : 'true', stderr: '' }),
      credentials: { describe: async () => ({ configured: true }) },
      getConfig: () => ({ projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/repo/pms', remote: 'http://gitlab.local/mk/pms.git' } }], workExecutor: 'agent', pushAdapter: 'qqmail' }),
    }

    const detected = createPipelineDoctorTool({ ...base, detectBaseBranch: async () => 'v2.x' })
    const out1 = await detected.execute({}, {})
    assert.ok(out1.text.includes('基准分支 v2.x'), `要显示识别出的分支：${out1.text}`)
    assert.equal(out1.ok, true, '识别成功不该算问题')

    const fallback = createPipelineDoctorTool({ ...base, detectBaseBranch: async () => 'main' })
    const out2 = await fallback.execute({}, {})
    assert.ok(out2.warnings.some((w) => w.includes('repo.baseBranch')), '回退 main 必须提醒去显式配置')
  })

  await check('pipeline_doctor 显式配了 repo.baseBranch 就不再去识别', async () => {
    let called = false
    const tool = createPipelineDoctorTool({
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : 'true', stderr: '' }),
      credentials: { describe: async () => ({ configured: true }) },
      detectBaseBranch: async () => { called = true; return 'main' },
      getConfig: () => ({ projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/repo/pms', remote: 'http://gitlab.local/mk/pms.git', baseBranch: 'v2.x' } }], workExecutor: 'agent', pushAdapter: 'qqmail' }),
    })
    const out = await tool.execute({}, {})
    assert.equal(called, false, '配置写了就不该再猜')
    assert.ok(out.text.includes('基准分支 v2.x'), '要显示配置里的分支')
  })

  await check('pipeline_doctor 在 gitRunner 缺席时给出明确指引', async () => {
    const tool = createPipelineDoctorTool({
      gitRunner: null,
      getConfig: () => ({ projects: [] }),
      credentials: null,
    })
    const out = await tool.execute({}, {})
    assert.equal(out.ok, false)
    assert.ok(out.text.includes('git'), '要点出 git 不可用')
    assert.ok(out.text.includes('projects 为空') === false || out.warnings.length > 0, '空项目要提醒')
  })

  section('12. 组合根接线：工具真的注册进 ctx、真的拿到 store')

  await check('apply() 注册四个工具，pipeline_reset 接的是同一个 store', async () => {
    // 前面的断言都是自己 new 工具再 execute，从来不经过 index.js ——
    // 注册行被删、或 store 传错成别的对象，那些断言照样全绿。这里补上真实接线。
    const { domain } = makeFakeDomain()
    const registered = []
    const ctx = makeFakeCtx({ domain, registered })
    const { value: config } = validateConfig({})
    await apply(ctx, config)

    const byName = new Map(registered.map((tool) => [tool.name, tool]))
    for (const toolName of ['pipeline_scan', 'pipeline_status', 'pipeline_cancel', 'pipeline_reset', 'pipeline_doctor']) {
      assert.ok(byName.has(toolName), `${toolName} 应该被注册进来，实际注册了：${[...byName.keys()].join(', ')}`)
    }

    // 真的走一遍：往 ctx 打开的那张 tickets 表里塞一条 failed 票，再调工具。
    const store = new TicketStore({ repo: makeDomainRepo(domain), log: silent })
    const scan = await createMockSource().scan(new AbortController().signal)
    await store.enqueue(scan.created[0], { phase: 'pending' })
    await store.setPhase(k('rec-mock-001'), 'planning')
    await store.setPhase(k('rec-mock-001'), 'failed', { lastError: 'internal: 假的' })
    const out = await byName.get('pipeline_reset').execute({ recordId: 'rec-mock-001' }, {})
    assert.equal(out.reset, true, `工具必须能读到插件自己打开的那张表：${out.text}`)
    assert.equal(store.getTicket(k('rec-mock-001')).phase, 'pending', '重置要落到同一份存储上')
  })

// 组合根接线用的最小假 ctx / 假 storageDomain：
// 只实现 apply() 真正用到的那几项，让 index.js 能被离线驱动。
function makeFakeDomain () {
  const tables = new Map()
  const tableOf = (name) => {
    if (!tables.has(name)) tables.set(name, new Map())
    return tables.get(name)
  }
  const domain = {
    table: (name) => ({
      get: (key) => tableOf(name).get(key),
      entries: () => [...tableOf(name).entries()][Symbol.iterator](),
      put: async (key, value) => { tableOf(name).set(key, value) },
      delete: async (key) => tableOf(name).delete(key),
    }),
    close: async () => {},
  }
  return { domain, tables }
}

function makeFakeCtx ({ domain, registered }) {
  const tools = {
    register: (tool) => { registered.push(tool); return tool },
  }
  return {
    get: () => undefined, // subprocess / attachments / fs / credentials 一律没接 → 走降级路径
    logger: () => ({ debug: silent, info: silent, warn: silent, error: silent }),
    tools,
    storageDomain: { open: async () => domain },
    effect: () => {},
    interval: () => () => {},
  }
}

  await check('A5：分支名清洗——recordId 带空格/中文/特殊字符也不炸 git', async () => {
    // index.js:416 拼分支名时对 `projectId-recordId-rN` 过 sanitizeBranchName（A5 接线）。
    const cases = [
      ['pms', 'rec-mock-001', 1, 'pms-rec-mock-001-r1'],           // 常规：原样保留
      ['pms', '第 3 号 bug！', 2, 'pms-3-bug-r2'],                  // 中文/空格/！全换 - 且连续 - 合并
      ['pms', 'a  b//c', 1, 'pms-a-b//c-r1'],                      // 连续 - 合并、斜杠保留
    ]
    for (const [projectId, recordId, rev, expected] of cases) {
      const seg = sanitizeBranchName(`${projectId}-${recordId}-r${rev}`)
      assert.equal(seg, expected, `recordId=${recordId} 的片段应为 ${expected}`)
      assert.match(seg, /^[^~^:?*[\\ ]+$/, '片段里不能有 git ref 拒绝的字符')
      assert.ok(seg.length <= 200, '片段不能超长')
    }
    assert.equal(sanitizeBranchName('!!!'), 'ticket', '全非法字符时回退 ticket')
  })

  section('12d. 工具输出必须是 lossless JSON（undefined 会让宿主判整次调用失败）')

  await check('工具输出里任何一层都不能残留 undefined', async () => {
    // 真实现象：pipeline_status 在「有失败票」时报
    //   tool "pipeline_status" returned invalid output: value is not lossless JSON
    // 在「全是干净票」时又正常 —— 因为票行投影里 lastError/testDetail 是可选的，
    // 干净票没有这两个键，值就是 undefined。undefined 不是合法 JSON 值，
    // 宿主于是把一次成功的调用判成工具坏了。
    const rows = [
      // 干净票：lastError / testDetail 天然不存在
      { key: k('r1'), projectId: DEMO, recordId: 'r1', phase: 'done', problemSummary: '干净', attempt: 0 },
      // 失败票：反过来，mr / worktreePath 不存在
      { key: k('r2'), projectId: DEMO, recordId: 'r2', phase: 'failed', lastError: 'internal: 假的', attempt: 2 },
    ]
    const tool = createPipelineStatusTool({
      store: { listTickets: () => rows },
      getConfig: () => validateConfig({}).value,
    })
    const out = await tool.execute({ includeDone: true }, {})

    // JSON.stringify 会把 undefined 悄悄丢掉，所以不能靠它验证 ——
    // 要真走一遍宿主那条「lossless JSON」判据：递归找 undefined。
    const offenders = []
    const walk = (value, path) => {
      if (value === undefined) { offenders.push(path || '<root>'); return }
      if (Array.isArray(value)) { value.forEach((item, i) => walk(item, `${path}[${i}]`)); return }
      if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) walk(item, path ? `${path}.${key}` : key)
      }
    }
    walk(out, '')
    assert.deepEqual(offenders, [], `输出里还有 undefined：${offenders.join(', ')}`)
    assert.equal(out.tickets.length, 2, '两张票都要在')
  })

  await check('stripUndefined 保留 false / 0 / 空字符串，只去掉 undefined', async () => {
    // 这个函数是「删 undefined」，很容易顺手写成「删假值」——
    // 那样 enabled:false 变没有、attempt:0 变没有、changedFiles:[] 也会被误解。
    assert.deepEqual(
      stripUndefined({ a: 1, b: undefined, c: false, d: 0, e: '', f: null, g: [], h: {} }),
      { a: 1, c: false, d: 0, e: '', f: null, g: [], h: {} },
    )
    // 数组里的 undefined 要变 null 而不是被删 —— 删了会改变长度、下标全错位。
    assert.deepEqual(stripUndefined({ list: [1, undefined, 3] }), { list: [1, null, 3] })
  })

  section('12b. 注册表真的接上了适配器（qqmail 推送 / agent 执行器）')

  await check('PUSHES 里有 qqmail，且能造出 id=qqmail 的适配器', async () => {
    // 之前这里只有 mock / pushplus：配置写 pushAdapter: qqmail 会被静默换成 mock，
    // 通知永远发不出去还不报错。这条断言把「表里有没有」钉住。
    const { PUSHES } = await import('../src/index.js')
    assert.ok(typeof PUSHES.qqmail === 'function', 'PUSHES 必须注册 qqmail，否则配了也不生效')
    const adapter = PUSHES.qqmail({ user: 'a@qq.com', to: 'b@qq.com', getSecret: async () => undefined })
    assert.equal(adapter.id, 'qqmail', '造出来的适配器 id 必须是 qqmail')
    for (const name of ['mock', 'pushplus', 'qqmail']) {
      assert.ok(typeof PUSHES[name] === 'function', `PUSHES.${name} 应该在表里`)
    }
  })

  await check('pushAdapter: qqmail 时组合根能把授权码读取器注入进去', async () => {
    const { domain } = makeFakeDomain()
    const registered = []
    const ctx = makeFakeCtx({ domain, registered })
    const { value: config } = validateConfig({ pushAdapter: 'qqmail', qqmail: { user: 'a@qq.com', to: 'b@qq.com' } })
    // 关键：构造期不该因为「凭据还没配」而抛 —— 装了插件但还没填授权码是常态。
    await apply(ctx, config)
    assert.ok(registered.length >= 5, 'qqmail 配置下工具仍要正常注册')
  })

  await check('EXECUTORS.agent 被注入 agents / git / createGitlabClient 等宿主依赖', async () => {
    // 只传 prompts 的话 executor-agent 一开跑就报「本机没有 agents 服务」。
    // 这条用假 ctx 走一遍 apply，确认装配阶段不抛、且 agent 执行器被选中。
    const { domain } = makeFakeDomain()
    const registered = []
    const ctx = makeFakeCtx({ domain, registered })
    const { value: config } = validateConfig({ workExecutor: 'agent' })
    await apply(ctx, config)
    assert.ok(registered.some((tool) => tool.name === 'pipeline_scan'), 'agent 执行器下工具仍要注册')
  })

  await check('model 默认留空（跟随会话默认模型），不钉死某个会被限流的模型', async () => {
    // 真实事故：插件把 model 钉成 deepseek-v4.1-flash，那天上游配额耗尽，
    // 整条流水线每一张票都死在「模型调用失败」上。留空 = 跟随宿主当前选择。
    const { value: config } = validateConfig({})
    assert.equal(config.model, '', 'model 默认应当是空串（空串在执行器里表示「不下发模型参数」）')
    assert.equal(config.provider, 'workbuddy', 'provider 默认与 profile 一致')
  })

  section('12e. 平台可插拔：状态值可配 + 金山文档真的接进组合根')

  await check('statusValues 进得了配置（配成「否」就按「否」收票）', async () => {
    // 这条是真实事故：真实飞书表的「是否处理」列用的是「否」，
    // 而适配器把状态值写死成「处理中」，于是插件一张票都收不到、看上去「一切正常」。
    const result = validateConfig({
      projects: [{
        name: 'pms',
        match: { platform: 'feishu', appToken: 'a', tableId: 't', statusValues: ['否', '待处理'] },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.ok(result.value, `校验应当通过：${JSON.stringify(result.issues ?? [])}`)
    assert.deepEqual(result.value.projects[0].match.statusValues, ['否', '待处理'])
  })

  await check('statusValues 写成单字符串也认，且归一成数组', async () => {
    const result = validateConfig({
      projects: [{
        name: 'pms',
        match: { platform: 'feishu', appToken: 'a', tableId: 't', statusValues: '否' },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.ok(result.value, `校验应当通过：${JSON.stringify(result.issues ?? [])}`)
    assert.deepEqual(result.value.projects[0].match.statusValues, ['否'])
  })

  await check('statusValues 配成空集合要报错（否则整张表收不到票还没人知道）', async () => {
    const result = validateConfig({
      projects: [{
        name: 'pms',
        match: { platform: 'feishu', appToken: 'a', tableId: 't', statusValues: [] },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.ok(result.issues, '空集合必须被拦下')
    assert.match(JSON.stringify(result.issues), /statusValues/)
  })

  await check('不配 statusValues 就别塞进配置（保持适配器缺省不被顶掉）', async () => {
    const result = validateConfig({
      projects: [{
        name: 'pms',
        match: { platform: 'feishu', appToken: 'a', tableId: 't' },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.ok(result.value)
    assert.equal(result.value.projects[0].match.statusValues, undefined)
  })

  await check('金山文档的定位字段进得了配置（sheetUrl / sheetName / statusColumn …）', async () => {
    const result = validateConfig({
      projects: [{
        name: 'wps-demo',
        match: {
          platform: 'wps',
          sheetUrl: 'https://www.kdocs.cn/l/abcdef',
          sheetName: '问题记录表',
          statusColumn: '是否处理',
          statusValue: '否',
          mediaPrefix: 'wps-media',
        },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.ok(result.value, `校验应当通过：${JSON.stringify(result.issues ?? [])}`)
    const match = result.value.projects[0].match
    assert.equal(match.sheetUrl, 'https://www.kdocs.cn/l/abcdef')
    assert.equal(match.sheetName, '问题记录表')
    assert.equal(match.statusColumn, '是否处理')
    assert.equal(match.statusValue, '否')
    assert.equal(match.mediaPrefix, 'wps-media')
  })

  await check('SOURCES 里 wps 已接上：声明水位能力 + 有 match 翻译器', async () => {
    // 之前 wps 那行 capabilities 是空的、也没有 match：配 platform: wps 只会得到一个
    // 「没取数通道」的源，等于平台没接。这条把接线钉住。
    const { SOURCES } = await import('../src/index.js')
    assert.ok(SOURCES.wps, 'SOURCES 里必须有 wps')
    assert.ok(SOURCES.wps.capabilities.includes('watermark'), 'wps 必须声明水位能力，否则重启后整张表重收一遍')
    assert.equal(typeof SOURCES.wps.match?.build, 'function', 'wps 必须有自己的 match 翻译器（组合根不认识平台字段）')
  })

  await check('buildSourceOptions：wps 项目的 match 被翻译成适配器认得的参数', async () => {
    const { SOURCES, buildSourceOptions } = await import('../src/index.js')
    const saved = []
    const opts = buildSourceOptions(SOURCES.wps, {
      project: {
        name: 'wps-demo',
        match: { platform: 'wps', sheetName: '问题记录表', statusColumn: '是否处理', statusValue: '否' },
      },
      store: {
        getWatermark: async () => null,
        saveWatermark: async (_id, value) => { saved.push(value) },
      },
      readSecret: async () => undefined,
      readLocalFile: async () => { throw new Error('不该被调用') },
      config: { safePageRun: 20, goneAfterScans: 3 },
      log: silent,
    })
    assert.equal(opts.sheetName, '问题记录表')
    assert.equal(opts.statusColumn, '是否处理')
    assert.equal(opts.statusValue, '否')
    assert.equal(typeof opts.getWatermark, 'function', '声明了水位能力就要拿到水位函数')
    assert.equal(typeof opts.saveWatermark, 'function')
    assert.equal(opts.goneAfterScans, 3, 'scanTuning 能力要把全局配置接进来')
  })

  await check('buildSourceOptions：飞书项目的 statusValues 一路透到适配器', async () => {
    const { SOURCES, buildSourceOptions } = await import('../src/index.js')
    const opts = buildSourceOptions(SOURCES.feishu, {
      project: {
        name: 'pms',
        match: { platform: 'feishu', appToken: 'a', tableId: 't', statusValues: ['否'] },
      },
      store: { getWatermark: async () => null, saveWatermark: async () => {} },
      readSecret: async () => 'secret',
      readLocalFile: async () => ({ data: new Uint8Array() }),
      config: { safePageRun: 20, goneAfterScans: 3 },
      log: silent,
    })
    assert.deepEqual(opts.statusValues, ['否'], '配置里的状态值集合必须真的到适配器手上')
  })

  await check('recordIds 进得了配置（只处理指定几张工单）', async () => {
    const result = validateConfig({
      projects: [{
        name: 'pms',
        match: { platform: 'feishu', appToken: 'a', tableId: 't', recordIds: ['rec-a', 'rec-b'] },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.ok(result.value, `校验应当通过：${JSON.stringify(result.issues ?? [])}`)
    assert.deepEqual(result.value.projects[0].match.recordIds, ['rec-a', 'rec-b'])
  })

  await check('recordIds 写成单字符串也认，且归一成数组', async () => {
    const result = validateConfig({
      projects: [{
        name: 'pms',
        match: { platform: 'feishu', appToken: 'a', tableId: 't', recordIds: 'rec-a' },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.ok(result.value, `校验应当通过：${JSON.stringify(result.issues ?? [])}`)
    assert.deepEqual(result.value.projects[0].match.recordIds, ['rec-a'])
  })

  await check('recordIds 配成空数组要报错（它字面意思是「挑零张」，不能当成「不收窄」）', async () => {
    const result = validateConfig({
      projects: [{
        name: 'pms',
        match: { platform: 'feishu', appToken: 'a', tableId: 't', recordIds: [] },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.ok(result.issues, '空数组必须被拦下')
    assert.match(JSON.stringify(result.issues), /recordIds/)
  })

  await check('不配 recordIds 就别塞进配置（保持适配器缺省不被顶掉）', async () => {
    const result = validateConfig({
      projects: [{
        name: 'pms',
        match: { platform: 'feishu', appToken: 'a', tableId: 't' },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.ok(result.value)
    assert.equal(result.value.projects[0].match.recordIds, undefined)
  })

  await check('buildSourceOptions：飞书项目的 recordIds 一路透到适配器', async () => {
    const { SOURCES, buildSourceOptions } = await import('../src/index.js')
    const opts = buildSourceOptions(SOURCES.feishu, {
      project: {
        name: 'pms',
        match: { platform: 'feishu', appToken: 'a', tableId: 't', recordIds: ['rec-a'] },
      },
      store: { getWatermark: async () => null, saveWatermark: async () => {} },
      readSecret: async () => 'secret',
      readLocalFile: async () => ({ data: new Uint8Array() }),
      config: { safePageRun: 20, goneAfterScans: 3 },
      log: silent,
    })
    assert.deepEqual(opts.recordIds, ['rec-a'], '配置里的收窄名单必须真的到适配器手上')
  })

  await check('allowedImageHosts 进得了配置：归一成小写去重（截图链接是外部输入，白名单只有人能开）', async () => {
    const result = validateConfig({
      projects: [{
        name: 'pms',
        match: { platform: 'feishu', appToken: 'a', tableId: 't', allowedImageHosts: ['CDN.Example.com', ' cdn.example.com ', 'img.example.com'] },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.ok(result.value, `校验应当通过：${JSON.stringify(result.issues ?? [])}`)
    assert.deepEqual(result.value.projects[0].match.allowedImageHosts, ['cdn.example.com', 'img.example.com'],
      '大小写与空白要归一，重复的要去掉')
  })

  await check('allowedImageHosts 写成单字符串也认', async () => {
    const result = validateConfig({
      projects: [{
        name: 'pms',
        match: { platform: 'feishu', appToken: 'a', tableId: 't', allowedImageHosts: 'cdn.example.com' },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.ok(result.value)
    assert.deepEqual(result.value.projects[0].match.allowedImageHosts, ['cdn.example.com'])
  })

  await check('allowedImageHosts 写成空集合要报错（写了键却一个域名不给 = 配了等于没配）', async () => {
    const result = validateConfig({
      projects: [{
        name: 'pms',
        match: { platform: 'feishu', appToken: 'a', tableId: 't', allowedImageHosts: [] },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.ok(result.issues, '空集合必须被拦下')
    assert.match(JSON.stringify(result.issues), /allowedImageHosts/)
  })

  await check('不配 allowedImageHosts 就别塞进配置（缺省是一律拒绝，不能被顶掉）', async () => {
    const result = validateConfig({
      projects: [{
        name: 'pms',
        match: { platform: 'feishu', appToken: 'a', tableId: 't' },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.ok(result.value)
    assert.equal(result.value.projects[0].match.allowedImageHosts, undefined)
  })

  await check('buildSourceOptions：飞书项目的 allowedImageHosts 一路透到适配器', async () => {
    const { SOURCES, buildSourceOptions } = await import('../src/index.js')
    const opts = buildSourceOptions(SOURCES.feishu, {
      project: {
        name: 'pms',
        match: { platform: 'feishu', appToken: 'a', tableId: 't', allowedImageHosts: ['cdn.example.com'] },
      },
      store: { getWatermark: async () => null, saveWatermark: async () => {} },
      readSecret: async () => 'secret',
      readLocalFile: async () => ({ data: new Uint8Array() }),
      config: { safePageRun: 20, goneAfterScans: 3 },
      log: silent,
    })
    assert.deepEqual(opts.allowedImageHosts, ['cdn.example.com'], '白名单必须真的到适配器手上，否则截图永远取不到')
  })

  await check('mock 源也认 recordIds（试点单票最常用的路径就是它）', async () => {
    const source = createMockSource({ recordIds: ['rec-mock-002'] })
    const round = await source.scan(new AbortController().signal)
    assert.deepEqual(round.created.map((ticket) => ticket.recordId), ['rec-mock-002'], '只该收点名的那张')
  })

  await check('webform 源也认 recordIds，且名单外的记录不会被判成「已删除」', async () => {
    const { createWebformSource } = await import('../src/adapters/source-webform/index.js')
    const source = createWebformSource({
      projectId: 'wf',
      recordIds: ['b'],
      records: [{ id: 'a', description: '不处理' }, { id: 'b', description: '要处理' }],
    })
    const first = await source.scan()
    assert.deepEqual(first.created.map((ticket) => ticket.recordId), ['b'])
    const second = await source.scan()
    assert.deepEqual(second.disappeared, [], '名单外的 a 从来就没进水位，不该报退役')
  })

  await check('describeConfig 会把收窄名单透出来（排障时先看这一轮在处理哪几张票）', async () => {
    const { describeConfig } = await import('../src/core/config.js')
    const described = describeConfig({
      projects: [{
        name: 'pms',
        match: { platform: 'feishu', appToken: 'a', tableId: 't', recordIds: ['rec-a'] },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.deepEqual(described.projects[0].match.recordIds, ['rec-a'])
  })

  section('12c. 走宿主 shell 时必须显式带 sandboxPolicy（否则无 session 调用拿不到写授权）')

  /** 造一个假 shell 服务，记录每次 resolve 收到的请求。 */
  function makeFakeShell (result = { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }) {
    const requests = []
    return {
      requests,
      resolve: (request) => { requests.push(request); return { ...request } },
      execute: async () => ({ result: async () => result }),
    }
  }

  await check('fullAccessSandboxPolicy 给出 danger-full-access + 绝对 workspaceRoot', async () => {
    // 宿主 windows-acl 运行器在 sessionId 缺失时一个写 SID 都不发；
    // 只有 danger-full-access 这条路能在无 session 的调用里拿到写权限。
    const policy = fullAccessSandboxPolicy('D:/some/repo')
    assert.equal(policy.mode, 'danger-full-access', '必须是不套沙箱的模式')
    assert.equal(policy.workspaceRoot, 'D:/some/repo', 'workspaceRoot 用调用方给的 cwd')
    assert.ok(typeof fullAccessSandboxPolicy(undefined).workspaceRoot === 'string', '缺 cwd 时要退到一个真实路径')
  })

  await check('gitRunner 传给 shell.resolve 的请求里带着 sandboxPolicy', async () => {
    // 回归的正是「票每次都挂在 git fetch: Permission denied」：少了这个字段，
    // 宿主会退回部署级默认策略，子进程只读，FETCH_HEAD 永远写不进去。
    const shell = makeFakeShell()
    const ctx = { get: (name) => (name === 'shell' ? shell : undefined) }
    const git = makeGitRunner(ctx)
    assert.ok(git, '有 shell 服务时 gitRunner 必须造得出来')
    await git(['fetch', 'origin', 'v2.x'], { cwd: 'D:/some/repo' })
    assert.equal(shell.requests.length, 1, '应该只发一次 shell 调用')
    const request = shell.requests[0]
    assert.ok(request.sandboxPolicy, 'shell.resolve 请求里必须带 sandboxPolicy')
    assert.equal(request.sandboxPolicy.mode, 'danger-full-access', '模式必须是 danger-full-access')
    assert.equal(request.sandboxPolicy.workspaceRoot, 'D:/some/repo', 'workspaceRoot 要指向被跑命令的仓库')
    assert.ok(String(request.command).includes("'-C'") === false, '路径不该被多余转义')
    assert.ok(String(request.command).includes('-C'), '工作目录要用 git -C 表达')
  })

  await check('gitRunner 没有 cwd 时也带 sandboxPolicy（退到进程工作目录）', async () => {
    const shell = makeFakeShell()
    const ctx = { get: (name) => (name === 'shell' ? shell : undefined) }
    const git = makeGitRunner(ctx)
    await git(['rev-parse', 'HEAD'])
    assert.ok(shell.requests[0].sandboxPolicy, '缺省路径同样要带策略')
    assert.ok(shell.requests[0].sandboxPolicy.workspaceRoot.length > 0, 'workspaceRoot 不能为空')
  })

  await check('commandRunner（verify 用）同样带 sandboxPolicy', async () => {
    const shell = makeFakeShell()
    const ctx = { get: (name) => (name === 'shell' ? shell : undefined) }
    const run = makeCommandRunner(ctx)
    assert.ok(run, '有 shell 服务时 commandRunner 必须造得出来')
    await run({ argv: ['npm', 'test'], cwd: 'D:/some/repo' })
    const request = shell.requests[0]
    assert.ok(request.sandboxPolicy, 'verify 也会写 node_modules 缓存，同样要带策略')
    assert.equal(request.sandboxPolicy.mode, 'danger-full-access')
    assert.equal(request.sandboxPolicy.workspaceRoot, 'D:/some/repo')
  })

  await check('commandRunner：命令名不能加引号（PowerShell 里 \'node\' 是字符串字面量，会 ParserError）', async () => {
    // 真实事故：verify 命令被拼成 cd 'x'; 'node' 'scripts/check-consistency.mjs'，
    // 宿主 shell 是 PowerShell，直接 ParserError（UnexpectedToken）——
    // 票于是被判成「验证失败」，可代码其实改对了、MR 也开了。
    const shell = makeFakeShell()
    const ctx = { get: (name) => (name === 'shell' ? shell : undefined) }
    const run = makeCommandRunner(ctx)
    await run({ argv: ['node', 'scripts/check-consistency.mjs'], cwd: 'D:/some/repo' })
    const command = String(shell.requests[0].command)
    assert.ok(command.includes('node scripts/check-consistency.mjs'), `命令名不该被引号包起来：${command}`)
    assert.ok(!command.includes("'node'"), `命令名加引号在 PowerShell 下是语法错误：${command}`)
    assert.ok(command.includes("cd 'D:/some/repo'"), `工作目录用 cd 表达：${command}`)
  })

  await check('commandRunner：参数照旧单引号转义（路径含空格也不破）', async () => {
    const shell = makeFakeShell()
    const ctx = { get: (name) => (name === 'shell' ? shell : undefined) }
    const run = makeCommandRunner(ctx)
    await run({ argv: ['npm', 'run', 'build', '--', 'my folder'], cwd: 'D:/some/repo' })
    const command = String(shell.requests[0].command)
    assert.ok(command.includes("'my folder'"), `带空格的参数要转义：${command}`)
    assert.ok(command.includes('npm run build'), `普通参数不该被引号包起来：${command}`)
  })

  await check('commandRunner：程序名含空格/特殊字符时报 invalid-input（跨 shell 没法安全转义）', async () => {
    const shell = makeFakeShell()
    const ctx = { get: (name) => (name === 'shell' ? shell : undefined) }
    const run = makeCommandRunner(ctx)
    let error = null
    try {
      await run({ argv: ['C:/Program Files/node.exe', 'x.mjs'], cwd: 'D:/some/repo' })
    } catch (err) {
      error = err
    }
    assert.ok(error, '必须报错而不是把命令拼出去')
    assert.equal(error.kind, 'invalid-input')
    assert.ok(error.message.includes('node'), '错误里要给出可用的替代写法')
  })

  await check('commandRunner：空命令报 invalid-input', async () => {
    const shell = makeFakeShell()
    const ctx = { get: (name) => (name === 'shell' ? shell : undefined) }
    const run = makeCommandRunner(ctx)
    let error = null
    try {
      await run({ argv: [], cwd: 'D:/some/repo' })
    } catch (err) {
      error = err
    }
    assert.ok(error, '空命令必须报错')
    assert.equal(error.kind, 'invalid-input')
  })

  await check('detectBaseBranch 优先用 remote HEAD，不猜 main', async () => {
    // 本机 pms 仓库的主干叫 v2.x；以前硬编码 'main' 会让 fetch 直接失败。
    const calls = []
    const git = async (argv, opts) => {
      calls.push([argv.join(' '), opts?.cwd])
      if (argv[0] === 'symbolic-ref') return { code: 0, stdout: 'origin/v2.x\n', stderr: '' }
      return { code: 0, stdout: 'v2.x\n', stderr: '' }
    }
    const base = await detectBaseBranch(git, 'D:/repo')
    assert.equal(base, 'v2.x', '应该剥掉 origin/ 前缀后返回 v2.x')
    assert.equal(calls[0][1], 'D:/repo', '查分支也要带 cwd')
  })

  await check('detectBaseBranch：拿不到 remote HEAD 时退本地分支，再退 main', async () => {
    const localOnly = async (argv) => {
      if (argv[0] === 'symbolic-ref') return { code: 128, stdout: '', stderr: 'not a symbolic ref' }
      return { code: 0, stdout: 'develop\n', stderr: '' }
    }
    assert.equal(await detectBaseBranch(localOnly, 'D:/repo'), 'develop', '退到本地当前分支')

    const nothing = async () => ({ code: 128, stdout: '', stderr: '' })
    assert.equal(await detectBaseBranch(nothing, 'D:/repo'), 'main', '全拿不到才退回 main')
  })

  await check('真实仓库上 detectBaseBranch 认得出 v2.x', async () => {
    // 用真的 git（走 bash 链路），守护「remote HEAD 能读出来」这条事实。
    const { execFileSync } = await import('node:child_process')
    const repo = '.repos/mgiot-pms'
    let exists = true
    try { execFileSync('git', ['-C', repo, 'rev-parse', '--git-dir'], { stdio: 'ignore' }) } catch { exists = false }
    if (!exists) return // 没克隆过就跳过，别让离线机器红
    const git = async (argv, opts = {}) => {
      const out = execFileSync('git', ['-C', String(opts.cwd), ...argv], { encoding: 'utf8' })
      return { code: 0, stdout: out, stderr: '' }
    }
    const base = await detectBaseBranch(git, repo)
    assert.ok(['v2.x', 'master'].includes(base), `真实仓库的主干应该认出来，实际 ${base}`)
  })

  section('13. 新适配器：gitlab 客户端 / qqmail 推送 / wps 工单源')
  await runGitlabChecks(check)
  await runQqmailChecks(check)
  await runWpsChecks(check)

  section('14. 项目工作区：有则复用、无则登记、服务缺失降级')
  await runWorkspaceChecks(check)

  section('15. 改代码落点：缺省在工作区检出里改（要求干净）')
  await check('inspectCheckout：干净 / 脏 / 拿不到状态三种情况都说清', async () => {
    const clean = async (argv) => {
      if (argv[0] === 'status') return { code: 0, stdout: '', stderr: '' }
      if (argv[0] === 'rev-parse' && argv[1] === '--abbrev-ref') return { code: 0, stdout: 'v2.x\n', stderr: '' }
      return { code: 0, stdout: 'abc123\n', stderr: '' }
    }
    const ok = await inspectCheckout(clean, 'D:/repo')
    assert.equal(ok.clean, true, '没有输出就是干净')
    assert.equal(ok.branch, 'v2.x')
    assert.equal(ok.head, 'abc123')

    const dirty = async (argv) => {
      // -z 格式：记录之间是 NUL、路径不带引号。生产代码只认这一种（见
      // contracts/git-status.js：未跟踪目录折叠 / 中文名八进制转义 / 含空格加引号）。
      if (argv[0] === 'status') return { code: 0, stdout: ' M a.ts\0?? b.ts\0', stderr: '' }
      if (argv[0] === 'rev-parse' && argv[1] === '--abbrev-ref') return { code: 0, stdout: 'HEAD\n', stderr: '' }
      return { code: 0, stdout: 'abc123\n', stderr: '' }
    }
    const d = await inspectCheckout(dirty, 'D:/repo')
    assert.equal(d.clean, false)
    assert.deepEqual(d.dirty, ['M a.ts', '?? b.ts'])
    assert.equal(d.branch, undefined, 'detached HEAD 不该当成分支名')

    // 拿不到状态必须抛：不知道检出现在什么样的时候，绝不能往里提交。
    const broken = async () => ({ code: 128, stdout: '', stderr: 'not a git repo' })
    await assert.rejects(() => inspectCheckout(broken, 'D:/repo'), /看不了项目检出的状态/)
  })

  await check('inspectCheckout：读状态用 -z -uall 并排除插件自己的 .agents/worktrees', async () => {
    // 三个真实坑，缺一个都会出错：
    // 1. 不加 -uall → 未跟踪目录被折叠成 `?? .agents/`，插件自己开的隔离 worktree
    //    会把主的检出判成「脏」，每张票都被拒跑；
    // 2. 不加 -z → 中文名变八进制转义、含空格的名字被引号包住，报错里人看不懂；
    // 3. 不排除 .agents/worktrees → 同上第 1 条。
    const calls = []
    const fake = async (argv) => {
      calls.push(argv)
      if (argv[0] === 'status') return { code: 0, stdout: '', stderr: '' }
      if (argv[0] === 'rev-parse' && argv[1] === '--abbrev-ref') return { code: 0, stdout: 'v2.x\n', stderr: '' }
      return { code: 0, stdout: 'abc123\n', stderr: '' }
    }
    await inspectCheckout(fake, 'D:/repo')
    const statusCall = calls.find((argv) => argv[0] === 'status')
    assert.ok(statusCall.includes('--porcelain'), '还是 porcelain 格式，人读得懂')
    assert.ok(statusCall.includes('-z'), '必须 -z，否则中文名被转义')
    assert.ok(statusCall.includes('-uall'), '必须 -uall，否则未跟踪目录折叠')
    assert.ok(statusCall.includes(':(exclude).agents/worktrees'), '插件自己的隔离目录不能算脏')
    assert.ok(statusCall.includes(':(exclude).agents/worktrees/**'))

    // 中文名与空格名要能原样认出来（-z 下 git 不给引号也不转义）。
    const weird = async (argv) => {
      if (argv[0] === 'status') return { code: 0, stdout: '?? 新建文件.txt\0?? space name.txt\0', stderr: '' }
      if (argv[0] === 'rev-parse' && argv[1] === '--abbrev-ref') return { code: 0, stdout: 'main\n', stderr: '' }
      return { code: 0, stdout: 'abc123\n', stderr: '' }
    }
    const w = await inspectCheckout(weird, 'D:/repo')
    assert.deepEqual(w.dirty, ['?? 新建文件.txt', '?? space name.txt'], '中文名与空格名都不能被转义')
  })

  await check('assertCleanCheckout：脏工作区拒跑，报错要能照着做', async () => {
    assertCleanCheckout({ dirty: [] }, 'D:/repo') // 干净时什么都不做
    let error = null
    try {
      assertCleanCheckout({ dirty: ['M a.ts', '?? b.ts'] }, 'D:/repo')
    } catch (err) {
      error = err
    }
    assert.ok(error, '不干净必须抛')
    assert.equal(error.kind, 'invalid-input')
    assert.ok(error.message.includes('M a.ts'), `要点名具体文件：${error.message}`)
    assert.ok(error.message.includes('stash'), '要告诉人怎么办')
    assert.ok(error.message.includes('isolateWorktree'), '要给出旁路配置项')
  })

  await check('isIsolatedWorktreePath：只认插件自己开的 .agents/worktrees/<name>', async () => {
    assert.equal(isIsolatedWorktreePath('D:/repo/.agents/worktrees/ticket-demo-r1'), true)
    assert.equal(isIsolatedWorktreePath('D:\\repo\\.agents\\worktrees\\ticket-demo-r1'), true, 'Windows 反斜杠也要认')
    // 以下都不是「某一票的隔离目录」，绝不能交给 git worktree remove --force。
    assert.equal(isIsolatedWorktreePath('D:/WorkSpace/mgiot-pms'), false, '人的主检出')
    assert.equal(isIsolatedWorktreePath('D:/repo/.agents'), false)
    assert.equal(isIsolatedWorktreePath('D:/repo/.agents/worktrees'), false, '目录本身不算')
    assert.equal(isIsolatedWorktreePath('D:/repo/.agents/worktrees/'), false)
    assert.equal(isIsolatedWorktreePath(''), false)
    assert.equal(isIsolatedWorktreePath(undefined), false)
    assert.equal(isIsolatedWorktreePath('D:/repo/.agents/worktrees/../..'), false, '路径穿越要拒')
  })

  await check('真实 apply()：缺省模式不建隔离 worktree，票据落在工作区根上', async () => {
    // 这一段走的是 index.js 里真实接线的 prepareWorkspace —— 只有 apply() 能测到它。
    const { domain } = makeFakeDomain()
    const registered = []
    const shell = {
      resolve: (request) => ({ ...request }),
      execute: async (spec) => {
        const command = String(spec?.command ?? '')
        let stdout = ''
        if (command.includes('rev-parse --abbrev-ref HEAD')) stdout = 'v2.x'
        else if (command.includes('rev-parse HEAD')) stdout = 'base0001'
        else if (command.includes('--is-inside-work-tree')) stdout = 'true'
        else if (command.includes('--version')) stdout = 'git version 2.45.1'
        // status --porcelain 故意留空：干净仓库。
        return { result: async () => ({ exitCode: 0, stdout: { text: stdout }, stderr: { text: '' } }) }
      },
    }
    const ctx = {
      ...makeFakeCtx({ domain, registered }),
      get: (name) => (name === 'shell' ? shell : undefined),
    }
    const { value: config } = validateConfig({
      projects: [{ name: 'demo', match: { platform: 'mock' }, repo: { path: 'D:/repo' } }],
      workExecutor: 'mock',
      pushAdapter: 'mock',
      isolateWorktree: false,
      // 总开关缺省是 false（配置项默认关），不开这一轮 tick 直接返回 disabled、什么都不跑。
      enabled: true,
    })
    await apply(ctx, config)

    const byName = new Map(registered.map((tool) => [tool.name, tool]))
    assert.ok(byName.has('pipeline_scan'), 'scan 工具必须注册')
    const store = new TicketStore({ repo: makeDomainRepo(domain), log: silent })
    const scan = await createMockSource().scan(new AbortController().signal)
    await store.enqueue(scan.created[0])
    // pipeline_scan 是 fire-and-forget（同步等会撑爆工具通道），所以这里自己等它跑完。
    await byName.get('pipeline_scan').execute({ skipScan: true }, {})
    const deadline = Date.now() + 5000
    let row = store.getTicket(k('rec-mock-001'))
    while (Date.now() < deadline && (!row || row.phase === 'pending')) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      row = store.getTicket(k('rec-mock-001'))
    }

    assert.ok(row, '这张票应该已经被跑过')
    assert.equal(
      String(row.worktreePath ?? '').includes('.agents/worktrees/'),
      false,
      `缺省模式不该建隔离 worktree，实际 ${row.worktreePath}`,
    )
    assert.ok(String(row.worktreePath ?? '').length > 0, '缺省模式仍要给出改代码的目录（工作区根）')
    assert.equal(row.branch, 'v2.x', '就地改代码时分支就是检出当前分支，不该另开票分支')
    assert.equal(row.baseCommit, 'base0001', '基线提交要记下来，改动靠它算 diff')
  })

  // ── 收尾 ────────────────────────────────────────────────
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
  if (failed > 0) {
    console.log('\n失败详情：')
    for (const f of failures) console.log(`- ${f.name}: ${f.error instanceof Error ? f.error.stack : f.error}`)
    process.exitCode = 1
  } else {
    console.log('全部通过。')
  }
}

main().catch((error) => {
  console.error('自测脚本自身崩了：', error)
  process.exitCode = 1
})
