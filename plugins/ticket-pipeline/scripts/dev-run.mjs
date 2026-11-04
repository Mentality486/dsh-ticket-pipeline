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
import { canTransition } from '../src/contracts/types.js'
import { fingerprintOf } from '../src/contracts/types.js'
import { validateConfig, describeConfig } from '../src/core/config.js'
import { createPipelineCancelTool } from '../src/tools/pipeline-cancel.js'
import { createPipelineResetTool } from '../src/tools/pipeline-reset.js'
import { pushplusOptionsFromConfig } from '../src/adapters/push-pushplus/index.js'
import { runFeishuChecks } from './feishu-checks.mjs'
import { runGitlabChecks } from './gitlab-checks.mjs'
import { runQqmailChecks } from './push-qqmail-checks.mjs'
import { runWpsChecks } from './wps-checks.mjs'
import { apply } from '../src/index.js'

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
    assert.ok(row.mr, '必须存下 mr')
    assert.equal(row.mr.draft, true)
    assert.equal(push.messages.length, 1, 'done 只发一条通知')
    assert.match(push.messages[0].title, /已完成/)
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
  await check('done 且超保留期才清；failed 永不自动清', async () => {
    const { repo, store } = harness()
    const source = createMockSource()
    const scan = await source.scan(new AbortController().signal)
    const old = Date.now() - 10 * 24 * 3600 * 1000

    // 终态票直接以终态入队（`pending → done` 不是合法转移，走 setPhase 会被拒），
    // 再用 repo.put 硬写 finishedAt —— setPhase 落终态时会把 finishedAt 盖成「现在」。
    await store.enqueue(scan.created[0], { phase: 'done' })
    await repo.put('tickets', k('rec-mock-001'), {
      ...store.getTicket(k('rec-mock-001')),
      worktreePath: 'D:/wt/a',
      finishedAt: old,
    })
    // 刚完成的 done：还在保留期内，不该被清
    await store.enqueue(scan.created[2], { phase: 'done' })
    await repo.put('tickets', k('rec-mock-003'), {
      ...store.getTicket(k('rec-mock-003')),
      worktreePath: 'D:/wt/c',
      finishedAt: Date.now(),
    })
    await store.enqueue(scan.created[1], { phase: 'failed' })
    await repo.put('tickets', k('rec-mock-002'), {
      ...store.getTicket(k('rec-mock-002')),
      worktreePath: 'D:/wt/b',
      finishedAt: old,
    })

    const expired = store.listExpiredWorktrees(3600 * 1000)
    const ids = expired.map((r) => r.recordId)
    assert.ok(ids.includes('rec-mock-001'), 'done 超期要清')
    assert.equal(ids.includes('rec-mock-003'), false, '还在保留期内不该清')
    assert.equal(ids.includes('rec-mock-002'), false, 'failed 的永不自动清')
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
    const { scheduler, store } = harness({
      executor,
      prepareWorkspace: async () => {
        prepares += 1
        return { path: 'D:/wt/new', branch: 'b-new', baseCommit: 'c2' }
      },
    })
    const source = createMockSource()
    const scan = await source.scan(new AbortController().signal)
    await store.enqueue(scan.created[0], { phase: 'worktree-ready' })
    await store.setPhase(k('rec-mock-001'), 'planning', { worktreePath: 'D:/wt/keep', branch: 'b-keep', baseCommit: 'c1' })
    // 把它送回可跑的阶段：planning 不是 pickNext 取得到的中间态，先回 pending
    await store.setPhase(k('rec-mock-001'), 'pending')
    await scheduler.tick()
    assert.equal(prepares, 0, '已经有工作区就不该再建')
    assert.equal(seenCtx.worktreePath, 'D:/wt/keep', '应该沿用存储里的路径')
    assert.equal(seenCtx.branch, 'b-keep')
    assert.equal(seenCtx.baseCommit, 'c1')
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
    for (const toolName of ['pipeline_scan', 'pipeline_status', 'pipeline_cancel', 'pipeline_reset']) {
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

  section('13. 新适配器：gitlab 客户端 / qqmail 推送 / wps 工单源')
  await runGitlabChecks(check)
  await runQqmailChecks(check)
  await runWpsChecks(check)

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
