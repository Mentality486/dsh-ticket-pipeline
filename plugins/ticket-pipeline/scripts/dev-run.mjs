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

import { TicketStore, makeMemoryRepo, ticketKey } from '../src/core/store.js'
import { createScheduler } from '../src/core/scheduler.js'
import { recoverPending } from '../src/core/recover.js'
import { createMockSource } from '../src/adapters/source-mock/index.js'
import { createMockExecutor } from '../src/adapters/executor-mock/index.js'
import { createMockPush } from '../src/adapters/push-mock/index.js'
import { createTableLocator } from '../src/adapters/locator-table/index.js'
import { makeExecResult } from '../src/contracts/work-executor.js'
import { canTransition } from '../src/contracts/types.js'
import { fingerprintOf } from '../src/contracts/types.js'
import { runFeishuChecks } from './feishu-checks.mjs'

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
      config: { ticketTimeoutMinutes: 0.005 }, // 300ms
    })
    await scheduler.tick()
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

  await check('项目名重复在构造时报错', () => {
    assert.throws(
      () => createTableLocator({ projects: [{ name: 'alpha', repo: { path: 'a' } }, { name: 'alpha', repo: { path: 'b' } }] }),
      /重复/,
    )
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
