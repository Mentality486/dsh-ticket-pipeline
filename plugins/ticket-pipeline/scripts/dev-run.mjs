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

import { TicketStore, TABLES, makeDomainRepo, makeMemoryRepo, ticketKey } from '../src/core/store.js'
import { createScheduler } from '../src/core/scheduler.js'
import { recoverPending } from '../src/core/recover.js'
import { createMockSource } from '../src/adapters/source-mock/index.js'
import { createMockExecutor } from '../src/adapters/executor-mock/index.js'
import { createMockPush } from '../src/adapters/push-mock/index.js'
import { createTableLocator } from '../src/adapters/locator-table/index.js'
import { makeExecResult, normalizeTestOutcome } from '../src/contracts/work-executor.js'
import { PipelineError, ERROR_KINDS, RETRYABLE_KINDS, FATAL_KINDS, CANCELLED_KINDS, retryPolicy } from '../src/contracts/errors.js'
import { canTransition, PHASE_LABEL, TIMELINE_NODES, phaseLabel, parseFeishuLink } from '../src/contracts/types.js'
import { fingerprintOf } from '../src/contracts/types.js'
import { validateConfig, describeConfig, CONFIG_FIELDS, CONFIG_GROUPS, BUILTIN_LIMITS, assertGroupCoverage, configFieldLabel, suggestConfigKey, readConfigWarnings, REMOVED_CONFIG_KEYS } from '../src/core/config.js'
import { createPipelineCancelTool } from '../src/tools/pipeline-cancel.js'
import { createPipelineScanTool } from '../src/tools/pipeline-scan.js'
import { createPipelineResetTool } from '../src/tools/pipeline-reset.js'
import { createPipelineDoctorTool } from '../src/tools/pipeline-doctor.js'
import { describeProbeFailure, probeFeishuConnectivity } from '../src/adapters/source-feishu/probe.js'
import { createPipelineStatusTool } from '../src/tools/pipeline-status.js'
import { stripUndefined } from '../src/tools/define.js'
import { sanitizeBranchName } from '../src/core/branch-name.js'
import { pushplusOptionsFromConfig } from '../src/adapters/push-pushplus/index.js'
import { runFeishuChecks } from './feishu-checks.mjs'
import { runGitlabChecks } from './gitlab-checks.mjs'
import { runQqmailChecks } from './push-qqmail-checks.mjs'
import { runWpsChecks } from './wps-checks.mjs'
import { runWorkspaceChecks } from './workspace-checks.mjs'
import { apply, detectBaseBranch, makeCommandRunner, makeGitRunner, fullAccessSandboxPolicy, inspectCheckout, describeDirtyCheckout, makeCredentialsDescriber } from '../src/index.js'
import { isIsolatedWorktreePath } from '../src/core/worktree-path.js'
import { COMMIT_SUMMARY_FILE_LIMIT, describeCommit, renderCommitSummary } from '../src/core/commit-summary.js'
import { SHOW_SUMMARY_ARGS, parseShowSummaryZ } from '../src/contracts/git-status.js'
import {
  comparePluginTrees,
  fingerprintOfEntries,
  listComparedFiles,
  needsUpdate,
  normalizeForCompare,
  pluginRootFromModuleUrl,
  profileDirFromInstalledDir,
  readLocalDependency,
  resolveSpecPath,
} from '../src/core/plugin-version.js'
import {
  BRANCH_REF_ARGS,
  listBranches,
  mergeBranchChoices,
  parseBranchRefs,
} from '../src/core/branches.js'

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
    worktreeExists: options.worktreeExists,
    // 心跳间隔是内置常量（60 秒）。自测要把它压到毫秒级，走这个注入口而不是配置项
    // —— 配置项已经删掉了，删的理由是「配错会让两个进程同时改同一个 worktree」。
    leaseHeartbeatMsOverride: options.leaseHeartbeatMsOverride,
    // 站点心跳同样固定在 60 秒（它只影响「看起来多久没动」的粒度）。
    // 自测要验证心跳合并逻辑，也得能压到毫秒级。
    timelineHeartbeatMsOverride: options.timelineHeartbeatMsOverride,
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

  await check('makeExecResult 拦住 done/skipped 没写 testDetail', () => {
    // 入参名仍收老名字 'skipped'（第三方执行器不会跟着改名），内部归一成 'not-run'。
    assert.throws(
      () => makeExecResult({ phase: 'skipped', changedFiles: [], testOutcome: 'skipped', mr: { iid: 1, url: 'x' } }),
      /testDetail/,
    )
    // 新名字同样要拦住：漏了 testDetail 就没人知道为什么没跑。
    assert.throws(
      () => makeExecResult({ phase: 'done', changedFiles: [], testOutcome: 'not-run', mr: { iid: 1, url: 'x' } }),
      /testDetail/,
    )
  })

  await check('makeExecResult 拦住 done 没给 mr', () => {
    assert.throws(() => makeExecResult({ phase: 'done', changedFiles: [], testOutcome: 'passed' }), /mr/)
  })

  // 「粘贴工单表链接」的解析器。这是唯一一处允许把工单表的 token 写成人类
  // 会写的形态的地方 —— 它跑在宿主进程里（浏览器只把整条 URL 原样转交），
  // 所以这里错了会直接让人配不上表。
  await check('parseFeishuLink：多维表格 / wiki / 电子表格链接都能认出来', () => {
    const base = parseFeishuLink('https://pms.feishu.cn/base/bascnABCDEFGH?table=tblXYZ&view=vew1')
    assert.equal(base.kind, 'bitable')
    assert.equal(base.appToken, 'bascnABCDEFGH')
    assert.equal(base.tableId, 'tblXYZ')
    assert.equal(base.viewId, 'vew1')

    const wiki = parseFeishuLink('https://pms.feishu.cn/wiki/wikcnABCDEFGH')
    assert.equal(wiki.kind, 'wiki', 'wiki 里的表要先靠 node_token 反查，不能当成 appToken 直接写')
    assert.equal(wiki.appToken, 'wikcnABCDEFGH')

    const sheet = parseFeishuLink('https://pms.feishu.cn/sheets/shtcnABCDEFGH?sheet=sh123')
    assert.equal(sheet.kind, 'sheet')
    assert.equal(sheet.spreadsheetToken, 'shtcnABCDEFGH')
    assert.equal(sheet.sheetId, 'sh123')
  })

  await check('parseFeishuLink：带语言前缀、http、裸 token 都认', () => {
    // 飞书会在路径里塞 /zh-CN/ 之类的语言段，取 token 时要跳过它。
    const localized = parseFeishuLink('https://pms.feishu.cn/zh-CN/base/bascnABCDEFGH?table=tblXYZ')
    assert.equal(localized.kind, 'bitable')
    assert.equal(localized.appToken, 'bascnABCDEFGH')
    assert.equal(localized.tableId, 'tblXYZ')

    assert.equal(parseFeishuLink('http://pms.feishu.cn/base/bascnABCDEFGH').appToken, 'bascnABCDEFGH')

    // 裸 token：只给了 token 的人也得能用。
    const bareBit = parseFeishuLink('bascnABCDEFGH')
    assert.equal(bareBit.kind, 'bitable')
    assert.equal(bareBit.appToken, 'bascnABCDEFGH')
    const bareSheet = parseFeishuLink('shtcnABCDEFGH')
    assert.equal(bareSheet.kind, 'sheet')
    assert.equal(bareSheet.spreadsheetToken, 'shtcnABCDEFGH')
  })

  await check('parseFeishuLink：认不出来的必须是 unknown，不能瞎猜', () => {
    // 猜错的代价是把一张毫不相干的表写进配置，下一轮扫描才会炸 —— 宁可当场说不会。
    for (const raw of ['', '   ', '这不是链接', 'abc', 'https://example.com/foo/bar', undefined, null, 42]) {
      assert.equal(parseFeishuLink(raw).kind, 'unknown', `应当判成 unknown：${String(raw)}`)
    }
    assert.equal(parseFeishuLink('https://pms.feishu.cn/base/').appToken, '', '只有 /base/ 没有 token 也得是空的')
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
    assert.match(push.messages[0].title, /等你补充?信息/)
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
    // #09：testOutcome 改名 not-run（'skipped' 这个词留给 phase，两个意思撞词会读错）。
    assert.equal(row.testOutcome, 'not-run')
    assert.ok(row.testDetail, '必须写清为什么没跑')
    assert.match(push.messages[0].body, /未跑成/)
  })

  await check('skipped 的用户可见文案不以「没成」收尾，且通知按 info 级推', async () => {
    // #01：skipped 是合法成功终态（TERMINAL 里有它），用户该做的是人工验证、不是重跑。
    // 以前四处中文全以「没跑通/未验证」收尾，通知还按 warn 级推 —— 用户第一反应是「失败了，得重跑」。
    const negative = /没跑通|未跑通|未验证|已本地提交，但/
    assert.equal(negative.test(PHASE_LABEL.skipped), false, `PHASE_LABEL.skipped 不能以否定式收尾：${PHASE_LABEL.skipped}`)
    assert.equal(negative.test(TIMELINE_NODES.skipped.label), false, `时间线短标签不能以否定式收尾：${TIMELINE_NODES.skipped.label}`)

    const { scheduler, store, push } = harness({ executor: createMockExecutor({ outcome: 'skipped' }) })
    await scheduler.tick()
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'skipped')
    assert.equal(push.messages.length, 1)
    // done 与 skipped 同级：都是「知道一下就行」，不该吓人。
    assert.equal(push.messages[0].level, 'info', `skipped 通知不该是 warn 级：${push.messages[0].level}`)
    assert.equal(negative.test(push.messages[0].title), false, `通知标题不要否定式：${push.messages[0].title}`)
    assert.equal(negative.test(push.messages[0].body), false, `通知正文不要否定式：${push.messages[0].body}`)
  })

  await check('testOutcome 改名 not-run：老数据 skipped 读时归一，非法值被拒', () => {
    // #09：'skipped' 这个词已经被 phase 占用（phase=skipped 是「验证跑了但没过」），
    // 而 testOutcome 里的 'skipped' 是「验证根本没跑」。两个意思撞同一个词，
    // 人和代码都会读错，所以 outcome 改名 'not-run'。
    assert.equal(normalizeTestOutcome('not-run'), 'not-run')
    assert.equal(normalizeTestOutcome('skipped'), 'not-run', '老数据里的 skipped 与新名字同义')
    assert.equal(normalizeTestOutcome('passed'), 'passed')
    assert.equal(normalizeTestOutcome('failed'), 'failed')
    assert.equal(normalizeTestOutcome(undefined), undefined, '没写过就是没写过，不猜')
    assert.equal(normalizeTestOutcome('随便什么'), undefined)
    // 入参仍收老名字，返回体统一是新名字 —— 第三方执行器不必跟着改名。
    const result = makeExecResult({
      phase: 'done', changedFiles: [], testOutcome: 'skipped',
      testDetail: '没配验证命令', mr: { iid: 1, url: 'x' },
    })
    assert.equal(result.testOutcome, 'not-run')
  })

  await check('phaseLabel：done 必须分出「已验证 / 未跑验证」', () => {
    // #09：混成一个「已完成」，没配验证命令的项目会以为自己全绿。
    assert.equal(phaseLabel({ phase: 'done', testOutcome: 'passed' }), '已完成（已验证）')
    assert.equal(phaseLabel({ phase: 'done', testOutcome: 'not-run' }), '已完成（未跑验证）')
    assert.equal(phaseLabel({ phase: 'done', testOutcome: 'skipped' }), '已完成（未跑验证）', '老数据等价')
    assert.equal(phaseLabel({ phase: 'done' }), '已完成', '没有 testOutcome 的老票不猜')
    // 非 done 的阶段标签仍走 PHASE_LABEL，行为不变。
    assert.equal(phaseLabel({ phase: 'skipped', testOutcome: 'failed' }), PHASE_LABEL.skipped)
    assert.equal(phaseLabel({ phase: 'failed' }), PHASE_LABEL.failed)
  })

  await check('failed 票也留 sessionId：失败之后能点回那一轮会话', async () => {
    // #09：真机上唯一那张 failed 票，全部信息只有「agent 没有产生任何文件改动」，
    // 没有 sessionId —— 人想追问「它当时到底在干什么」就只能去会话列表里翻。
    // 会话 id 只有执行器知道，而票抛异常时执行器**返回不了结果**，
    // 所以必须靠 ctx.onSessionId 提前交出来。
    const executor = {
      id: 'fails-after-session',
      async run (ticket, target, ctx) {
        await ctx.onPhase('planning')
        await ctx.onSessionId?.('ticket-demo-rec-mock-001-42')
        // 用不可重试的 kind：可重试的（internal/network/rate-limit）会让票回 pending 重排，
        // 这条用例要的是「落成 failed 终态之后会话 id 还在」。
        throw new PipelineError('invalid-input', '任务书里没说清要改哪个文件')
      },
    }
    const { scheduler, store, push } = harness({ executor })
    await scheduler.tick()
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'failed')
    assert.equal(row.sessionId, 'ticket-demo-rec-mock-001-42', `失败的票要留住会话 id：${row.sessionId}`)
    assert.match(push.messages[0].body, /处理会话：ticket-demo-rec-mock-001-42/, push.messages[0].body)
  })

  await check('pipeline_status：全库分布按「需要你处理 / 待人工验证 / 已交付」分档', async () => {
    // #01：原来按 phase 枚举顺序拼一行，「待人工验证 2」和「失败 1」并列，
    // 人分不清哪一类要自己动手。最重的一档即使为 0 也要留行。
    const rows = [
      { key: k('a'), projectId: DEMO, recordId: 'a', phase: 'failed', attempt: 0 },
      { key: k('b'), projectId: DEMO, recordId: 'b', phase: 'skipped', attempt: 0 },
      { key: k('c'), projectId: DEMO, recordId: 'c', phase: 'done', attempt: 0 },
    ]
    const out = await createPipelineStatusTool({
      store: { listTickets: () => rows }, getConfig: () => validateConfig({}).value, now: () => 10_000,
    }).execute({ view: 'tickets', includeDone: true }, {})
    assert.match(out.text, /全库分布：需要你处理：失败 1/, `最重的一档要排第一：${out.text}`)
    assert.match(out.text, /待人工验证：1/, `skipped 单独成档：${out.text}`)
    assert.match(out.text, /已交付：1/, `done 归入已交付：${out.text}`)

    // 一张票都没有时，「需要你处理：0」仍要在 —— 空白不等于零。
    const empty = await createPipelineStatusTool({
      store: { listTickets: () => [] }, getConfig: () => validateConfig({}).value, now: () => 10_000,
    }).execute({}, {})
    assert.match(empty.text, /需要你处理：0/, `空库也要能一眼确认没事：${empty.text}`)
  })

  await check('pipeline_status：缺省视图按项目聚合，一眼看完所有项目', async () => {
    // 动机：以前只有「一张票十几行」的明细，票一多就得翻完才拼得出
    // 「每个项目现在什么情况」。而且明细缺省会筛掉终态票，全跑完的库里
    // 默认一条都不显示 —— 而人往往正是想知道「都跑完没有」。
    const rows = [
      { key: k('p1-a'), projectId: 'pms', recordId: 'p1-a', phase: 'failed', attempt: 0, lastError: 'internal: agent 没有产生任何文件改动', enqueuedAt: 1_000 },
      { key: k('p1-b'), projectId: 'pms', recordId: 'p1-b', phase: 'done', attempt: 0, enqueuedAt: 2_000 },
      { key: k('p2-a'), projectId: 'sandbox', recordId: 'p2-a', phase: 'skipped', attempt: 0, enqueuedAt: 3_000 },
    ]
    const out = await createPipelineStatusTool({
      store: { listTickets: () => rows }, getConfig: () => validateConfig({}).value, now: () => 100_000,
    }).execute({}, {})

    assert.equal(out.view, 'overview', '缺省视图是总览')
    assert.match(out.text, /━━ 项目总览：3 张票 \/ 2 个项目 ━━/, `要有总览抬头：${out.text}`)
    assert.match(out.text, /【pms】共 2 张/, `每个项目一行战报：${out.text}`)
    assert.match(out.text, /【sandbox】共 1 张/, `第二个项目也要在：${out.text}`)
    // 全库口径：done/skipped 这些终态票必须在总览里 —— 这正是明细缺省会漏掉的。
    assert.ok(out.text.includes('p1-b'), `终态票也要出现在总览里：${out.text}`)
    assert.ok(out.text.includes('p2-a'), `skipped 也要出现：${out.text}`)
    // 待你动手的项目排前面（pms 有 1 张失败，sandbox 没有）。
    assert.ok(out.text.indexOf('【pms】') < out.text.indexOf('【sandbox】'), `要动手的项目排前面：${out.text}`)
    // 每票一行，不是十几行：三张票 + 两行项目头 + 抬头 + 尾注。
    const ticketLines = out.text.split('\n').filter((line) => /^    [·✗] /.test(line))
    assert.equal(ticketLines.length, 3, `每票一行：${ticketLines.join(' | ')}`)
    // 机器可读：运行页签不该自己再按项目分组一次。
    assert.equal(out.projects.length, 2)
    assert.equal(out.projects[0].projectId, 'pms', '有需你处理的项目排第一')
    assert.equal(out.projects[0].total, 2)
    assert.equal(out.projects[0].needsYouCount, 1)
    assert.equal(out.projects[0].needsYou[0].recordId, 'p1-a')
    assert.equal(out.projects[0].needsYou[0].lastError, 'internal: agent 没有产生任何文件改动')
    assert.equal(out.projects[1].awaitingReviewCount, 1, 'skipped 归入待人工验证')
    assert.equal(typeof out.projects[0].latestActivityAt, 'number')
  })

  await check('pipeline_status：总览每项目最多列 8 张，超出的折成一句', async () => {
    // 总览的用途是「一眼看完」，不是把明细再抄一遍。一个项目几十张票时
    // 全列出来就是第二个明细视图。
    const rows = Array.from({ length: 11 }, (_, i) => ({
      key: k(`many-${i}`), projectId: 'pms', recordId: `many-${i}`, phase: 'done', attempt: 0, enqueuedAt: 1_000 + i,
    }))
    const out = await createPipelineStatusTool({
      store: { listTickets: () => rows }, getConfig: () => validateConfig({}).value, now: () => 100_000,
    }).execute({}, {})
    const ticketLines = out.text.split('\n').filter((line) => /^    [·✗] /.test(line))
    assert.equal(ticketLines.length, 8, `最多 8 行：${ticketLines.length}`)
    assert.match(out.text, /……还有 3 张没列出（明细用 view="tickets" 看全）/, `要指路去明细：${out.text}`)
    // 折叠只影响渲染，机器可读的计数必须是全的。
    assert.equal(out.projects[0].total, 11, '折叠不许把总数算少')
  })

  await check('pipeline_status：总览每张票带一条「9 个主站」的流程带，一眼看出哪站慢、哪站挂', async () => {
    // 动机：总览原来每票只有一行摘要（阶段 + 停在第几站），人还是看不出
    // 「这一票整条路走得顺不顺、在哪一站慢/挂了」—— 那部分只在 view="tickets"
    // 的九行日志里。流程带把九站压成一行符号，总览就能真的回答「全流程状态」。
    const base = 1_000_000_000
    const at = (delta) => ({ at: base + delta, ok: true })
    const doneRow = {
      key: k('flow-done'),
      projectId: DEMO,
      recordId: 'flow-done',
      phase: 'done',
      attempt: 0,
      testOutcome: 'passed',
      timeline: [
        { node: 'discover', label: '获取工单', ...at(0) },
        { node: 'locate', label: '查找对应工单的项目', ...at(1_000) },
        { node: 'workspace', label: '检查工作区', ...at(2_000) },
        { node: 'session', label: '创建会话（分支+模型）', ...at(3_000) },
        { node: 'editing', label: '处理工单问题', ...at(4_000) },
        // ⑤ 处理问题花了 5 分钟：只有它超过 1 分钟，应该只有它标耗时。
        { node: 'testing', label: '跑验证', ...at(304_000) },
        { node: 'mr-opening', label: '提交（本地提交 / PR）', ...at(306_000) },
        { node: 'done', label: '已完成', ...at(307_000) },
        { node: 'writeback', label: '回填工单表', ...at(307_500) },
        { node: 'notify', label: '发送消息', ...at(308_000) },
      ],
    }
    const out = await createPipelineStatusTool({
      store: { listTickets: () => [doneRow] }, getConfig: () => validateConfig({}).value, now: () => base + 400_000,
    }).execute({}, {})
    // 图例只打一次，且把符号含义说清（不然 ✓/✗/▶ 要人去猜）。
    assert.match(out.text, /①–⑨ 是 9 个主站/, `要有流程带图例：${out.text}`)
    assert.match(out.text, /✓ 做成 \/ ✗ 没做成 \/ ▶ 正停在这一站/, `图例要解释符号：${out.text}`)
    // 走完的票：九站全 ✓，只有 ⑤ 标了耗时。
    assert.ok(
      out.text.includes('①✓ ②✓ ③✓ ④✓ ⑤✓（5 分 0 秒） ⑥✓ ⑦✓ ⑧✓ ⑨✓'),
      `走完的票九站全 ✓、只标超过 1 分钟的站：${out.text}`,
    )
    assert.match(out.text, /｜全程 5 分 8 秒/, `要报全程耗时：${out.text}`)
    // 终态票的最后一站不该标耗时：跑完 28 小时的票若用「现在」算，
    // ⑨ 会显示成 28 小时，看着像卡在发消息上。
    assert.ok(!/⑨✓（/.test(out.text), `终态票的最后一站不标耗时：${out.text}`)

    // 机器可读：面板画进度条直接用这一份，不各自再压一遍。
    const flow = out.tickets[0].flow
    assert.equal(flow.stations.length, 9, '流程带固定 9 个主站')
    assert.equal(flow.reachedCount, 9)
    assert.equal(flow.totalMs, 308_000)
    assert.equal(flow.noRecord, false)
    assert.deepEqual(flow.stations.map((s) => s.state), Array(9).fill('ok'))
    assert.equal(flow.stations[4].elapsedMs, 300_000, '⑤ 的耗时 = 下一条打点 - 这一条')
  })

  await check('pipeline_status：流程带能标出「正停在这一站」与「这一站挂了」', async () => {
    const base = 1_000_000_000
    // 正在跑：停在 ⑤（editing 是最后一条，phase 还没进终态）。
    // 必须用 ▶ 而不是 ✓：⑨ 走完才是 ✓，停在站里说明它还在这一站里。
    const running = {
      key: k('flow-running'),
      projectId: DEMO,
      recordId: 'flow-running',
      phase: 'editing',
      attempt: 0,
      timeline: [
        { node: 'discover', label: '获取工单', at: base, ok: true },
        { node: 'locate', label: '查找对应工单的项目', at: base + 1_000, ok: true },
        { node: 'editing', label: '处理工单问题', at: base + 60_000, ok: true },
      ],
    }
    const out = await createPipelineStatusTool({
      store: { listTickets: () => [running] }, getConfig: () => validateConfig({}).value, now: () => base + 90_000,
    }).execute({}, {})
    assert.ok(out.text.includes('①✓ ②✓ ③– ④– ⑤▶'), `停在 ⑤ 要标 ▶、没走到的标 –：${out.text}`)
    const flow = out.tickets[0].flow
    assert.equal(flow.currentStation, '⑤')
    assert.equal(flow.failedStation, null)
    assert.equal(flow.reachedCount, 3)
    // 跑着的票：最后一站用「现在」算。这里 ⑤ 才跑了 30 秒 —— 不到 1 分钟的门槛，
    // 所以带上不标耗时（秒级噪音），但机器可读的 elapsedMs 仍是真实值。
    assert.equal(flow.stations[4].elapsedMs, 30_000)
    assert.ok(!out.text.includes('⑤▶（'), `不到 1 分钟的站不标耗时：${out.text}`)

    // 挂了的：② 这条打点 ok=false，要标 ✗，而且机器可读要能指出是第几站。
    const broken = {
      key: k('flow-broken'),
      projectId: DEMO,
      recordId: 'flow-broken',
      phase: 'failed',
      attempt: 0,
      lastError: 'auth: 飞书 token 无效',
      timeline: [
        { node: 'discover', label: '获取工单', at: base, ok: true },
        { node: 'locate', label: '查找对应工单的项目', at: base + 1_000, ok: false },
        { node: 'failed', label: '失败', at: base + 2_000, ok: false },
      ],
    }
    const brokenOut = await createPipelineStatusTool({
      store: { listTickets: () => [broken] }, getConfig: () => validateConfig({}).value, now: () => base + 10_000,
    }).execute({}, {})
    assert.ok(brokenOut.text.includes('①✓ ②✗ ③– ④–'), `挂掉的站要标 ✗：${brokenOut.text}`)
    assert.equal(brokenOut.tickets[0].flow.failedStation, '②')
    assert.equal(brokenOut.tickets[0].flow.currentStation, null, '终态票没有「正停在」这一站')
  })

  await check('pipeline_status：老票没有时间线时说「没有流程记录」，不画一条全 – 的带', async () => {
    // 2026-11-09 之前跑完的票没有 timeline。画九个 – 会让人以为「插件当时
    // 一个站都没走到」—— 事实是当时还没有打点这个功能，两者必须分开说。
    const old = { key: k('old'), projectId: DEMO, recordId: 'old', phase: 'done', attempt: 0, enqueuedAt: 1_000 }
    const out = await createPipelineStatusTool({
      store: { listTickets: () => [old] }, getConfig: () => validateConfig({}).value, now: () => 100_000,
    }).execute({}, {})
    assert.match(out.text, /没有流程记录 —— 这张票的处理早于流程日志功能/, `老票要说清没有记录：${out.text}`)
    assert.ok(!out.text.includes('①– ②–'), `老票不画全 – 的带：${out.text}`)
    const flow = out.tickets[0].flow
    assert.equal(flow.noRecord, true)
    assert.equal(flow.stations.length, 9, '即使是老票，结构上也给齐 9 站，面板不用判空')
    assert.equal(flow.reachedCount, 0)
    assert.equal(flow.totalMs, null)
  })

  await check('pipeline_status：view="tickets" 保持原有明细；传 recordId 时一律走明细', async () => {
    // 老调用方（22 处自测断言 + 用户习惯）靠明细，必须能原样拿回来。
    const rows = [
      { key: k('d1'), projectId: DEMO, recordId: 'd1', phase: 'done', attempt: 0, module: '列表页' },
      { key: k('d2'), projectId: DEMO, recordId: 'd2', phase: 'editing', attempt: 0, module: '详情页' },
    ]
    const detail = await createPipelineStatusTool({
      store: { listTickets: () => rows }, getConfig: () => validateConfig({}).value, now: () => 100_000,
    }).execute({ view: 'tickets', includeDone: true }, {})
    assert.equal(detail.view, 'tickets')
    assert.match(detail.text, /· \[demo\] d1｜已完成｜/, `明细要回到一张票一段：${detail.text}`)
    assert.ok(!detail.text.includes('项目总览'), `明细视图不该出现总览：${detail.text}`)

    // 传了 recordId 就是看这一张：总览里没有「只看一张」这回事。
    const one = await createPipelineStatusTool({
      store: { listTickets: () => rows }, getConfig: () => validateConfig({}).value, now: () => 100_000,
    }).execute({ recordId: 'd2' }, {})
    assert.equal(one.view, 'overview', 'view 参数照原样回显，但实际走的是明细')
    assert.equal(one.tickets.length, 1, '只给这一张')
    assert.equal(one.tickets[0].recordId, 'd2')
    assert.match(one.text, /· \[demo\] d2｜修改中｜/, `单票要看明细：${one.text}`)
    assert.ok(!one.text.includes('项目总览'), `单票不该给总览：${one.text}`)

    // 总览也不该跟着 includeDone 抖动 —— 它永远按全库算。
    const overviewIgnoresIncludeDone = await createPipelineStatusTool({
      store: { listTickets: () => rows }, getConfig: () => validateConfig({}).value, now: () => 100_000,
    }).execute({ includeDone: false }, {})
    assert.match(overviewIgnoresIncludeDone.text, /【demo】共 2 张/, `总览永远是全库口径：${overviewIgnoresIncludeDone.text}`)
  })

  await check('pipeline_status：队列说明写清「谁是下一个、怎么排、为什么串行」', async () => {
    // #17：并发恒 1 让「排队」成为常态，但以前一个字都不解释。
    // 三张 pending 按优先级/发现日期排：high 的先，同优先级发现日期早的先。
    const rows = [
      { key: k('low'), projectId: DEMO, recordId: 'low', phase: 'pending', priority: 'low', foundAt: '2026-11-01', enqueuedAt: 1, problemSummary: '低优先级那张' },
      { key: k('hi-late'), projectId: DEMO, recordId: 'hi-late', phase: 'pending', priority: 'high', foundAt: '2026-11-05', enqueuedAt: 3, problemSummary: '高优先级但报得晚' },
      { key: k('hi-early'), projectId: DEMO, recordId: 'hi-early', phase: 'pending', priority: 'high', foundAt: '2026-11-02', enqueuedAt: 2, problemSummary: '高优先级且报得早' },
    ]
    // 「下一个」必须直接问 pickNext()，不许这里再排一遍 —— 排序规则写两份会分道扬镳。
    // 故意让 pickNext 返回一张「按本文件的排序不可能选中」的票：
    // 若实现偷偷自己排，这条断言就会挂。
    const out = await createPipelineStatusTool({
      store: { listTickets: () => rows, pickNext: () => rows[2] },
      getConfig: () => validateConfig({}).value,
      now: () => 10_000,
    }).execute({}, {})
    assert.match(out.text, /队列：3 张在等（同一时刻只跑一张）/, `要说明有几张在等：${out.text}`)
    assert.match(out.text, /下一个：\[demo\] hi-early（优先级 高）｜高优先级且报得早/, `下一个要具体到 recordId：${out.text}`)
    assert.match(out.text, /排法：优先级高的先跑 → 发现日期早的先跑 → 入队早的先跑/, `排序规则要写出来：${out.text}`)
    assert.match(out.text, /为什么一次只跑一张/, `要顺手回答「能不能并发」：${out.text}`)
    // 机器可读：运行页签与告警不该自己再排一遍。
    assert.equal(out.queue.pendingCount, 3)
    assert.equal(out.queue.runnableCount, 3)
    assert.equal(out.queue.nextRecordId, 'hi-early', 'queue.nextRecordId 必须来自 pickNext()')
    assert.deepEqual(out.queue.backoff, [])
  })

  await check('pipeline_status：退避中的票与普通 pending 必须一眼可分', async () => {
    // #17：退避用的是 pending + enqueuedAt = 未来时刻，phase 一模一样。
    // 以前两行文字完全相同，人看到「排队中」等十分钟，分不清是等还是卡住。
    const now = 1_000_000
    const rows = [
      // 普通 pending：enqueuedAt 在过去
      { key: k('normal'), projectId: DEMO, recordId: 'normal', phase: 'pending', priority: 'high', enqueuedAt: now - 60_000, problemSummary: '正常排队的' },
      // 退避中：enqueuedAt 在 2 分钟后，且带着上次的错
      { key: k('back'), projectId: DEMO, recordId: 'back', phase: 'pending', priority: 'high', enqueuedAt: now + 120_000, lastError: 'agent 没有产生任何文件改动', problemSummary: '上次失败在退避的' },
    ]
    const out = await createPipelineStatusTool({
      store: { listTickets: () => rows },
      getConfig: () => validateConfig({}).value,
      now: () => now,
    }).execute({ view: 'tickets' }, {})
    assert.match(out.text, /back｜排队中（退避中，还要等 2 分 0 秒）｜/, `状态行要带退避与剩余时间：${out.text}`)
    assert.match(out.text, /正在退避：还要等 2 分 0 秒 才会被重新捞起来/, `建议行要说清在退避：${out.text}`)
    assert.match(out.text, /上次失败：agent 没有产生任何文件改动/, `退避要带上次失败原因：${out.text}`)
    // 普通那张不能被误标成退避
    assert.match(out.text, /normal｜排队中｜/, `普通 pending 不许出现「退避中」：${out.text}`)
    // 退避中的不算「前面还有 N 张」：pickNext 根本不会挑它
    assert.match(out.text, /队列里的下一张就是它/, `可跑队列里它排第一：${out.text}`)
    assert.equal(out.queue.backoff.length, 1)
    assert.equal(out.queue.backoff[0].recordId, 'back')
    assert.equal(out.queue.backoff[0].remainingMs, 120_000)
    assert.equal(out.queue.backoff[0].reason, 'agent 没有产生任何文件改动')
  })

  await check('pipeline_status：没有 pending 票时队列那一段完全不出现', async () => {
    // 空噪音也是一种伤害：全是终态的库里不该冒出一句「队列：0 张在等」。
    const rows = [
      { key: k('d'), projectId: DEMO, recordId: 'd', phase: 'done', attempt: 0 },
    ]
    const out = await createPipelineStatusTool({
      store: { listTickets: () => rows }, getConfig: () => validateConfig({}).value, now: () => 10_000,
    }).execute({ view: 'tickets', includeDone: true }, {})
    assert.ok(!out.text.includes('队列：'), `没有 pending 时不许出现队列段：${out.text}`)
    assert.ok(!out.text.includes('为什么一次只跑一张'), `没有 pending 时也不许出现串行解释：${out.text}`)
    assert.equal(out.queue.pendingCount, 0)
    assert.equal(out.queue.nextRecordId, null)
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
    // #08：lastError 只放人话，分类进 lastErrorKind —— 用户不该看见 `rate-limit:` 这种内部标识符。
    assert.match(row.lastError ?? '', /上游限流/)
    assert.equal(row.lastErrorKind, 'rate-limit', '分类要进结构化字段，不能拼进给人看的文案')
    assert.ok(!String(row.lastError).includes('rate-limit'), 'lastError 里不能出现内部 kind 前缀')
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
  await check('中间态票恢复后必须回到 pending，否则 pickNext 永远捡不起来', async () => {
    // 真坑（2026-11-09，真机 3 张 sandbox 票永久卡死）：旧实现恢复成 planning/testing，
    // 寓意是「停在本步重做」，但 `pickNext()` **只挑 pending**，而 `tick()` 的唯一入口
    // 就是 `pickNext()` —— 恢复日志说 resumed:1，票却一步也不再动，
    // `pipeline_reset` 又只认 failed/needs-info/gone，救不回来。
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
    assert.equal(row.phase, 'pending', '恢复后必须是 pending，中间态没有任何代码会再捡它')
    assert.equal(row.worktreePath, 'D:/wt/x', '工作区还在就要接着用，坐标别清')
    assert.equal(row.branch, 'ticket-rec-mock-001-r1', '分支也要留着')
    assert.ok(/上次停在/.test(row.lastError ?? ''), `lastError 要写清上次停在哪：${row.lastError}`)
    const next = store.pickNext()
    assert.ok(next, '恢复完之后 pickNext 必须能捡到它')
    assert.equal(next.recordId, 'rec-mock-001')
  })

  await check('工作区丢了 → 清坐标回 pending，让执行器重建', async () => {
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const source = createMockSource()
    const scan = await source.scan(new AbortController().signal)
    await store.enqueue(scan.created[0], { phase: 'worktree-ready' })
    await store.setPhase(k('rec-mock-001'), 'planning', {
      worktreePath: 'D:/wt/gone',
      branch: 'ticket-x-r1',
      commit: { sha: 'deadbeef', branch: 'ticket-x-r1', files: [] },
      mr: { iid: 7, url: 'http://gitlab/x/-/merge_requests/7', draft: true },
    })

    const result = await recoverPending({ store, worktreeExists: async () => false, log: silent })
    assert.equal(result.reset, 1)
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'pending')
    assert.equal(row.worktreePath, undefined, '工作区没了，坐标要清掉')
    assert.equal(row.branch, undefined)
    assert.equal(row.commit, undefined, '旧 sha 在新历史里不存在，必须清')
    assert.equal(row.mr, undefined, '旧 MR 指向的分支已经没了，必须清')
    assert.ok(store.pickNext(), '清完坐标也要能被捡起来')

    // 反过来：工作区还在时不能清坐标（否则白丢一个已经建好的检出）。
    const repo2 = makeMemoryRepo()
    const store2 = new TicketStore({ repo: repo2, log: silent })
    await store2.enqueue(scan.created[0], { phase: 'worktree-ready' })
    // worktree-ready 不能直接跳 testing（阶段表里没有这条边），先走到 planning 再走。
    await store2.setPhase(k('rec-mock-001'), 'planning', { worktreePath: 'D:/wt/keep', branch: 'ticket-y-r1' })
    await store2.setPhase(k('rec-mock-001'), 'testing', {})
    await recoverPending({ store: store2, worktreeExists: async () => true, log: silent })
    const kept = store2.getTicket(k('rec-mock-001'))
    assert.equal(kept.worktreePath, 'D:/wt/keep', '工作区有效时绝不能把坐标清掉')
    assert.equal(kept.phase, 'pending')
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
      leaseHeartbeatMsOverride: 20,
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
      leaseHeartbeatMsOverride: 20,
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
    // pushplus.token 已经从配置面删掉了（token 走凭据），所以打码逻辑改用
    // 仍然存在的、名字里带 token 的路径来验证：projects[].match.appToken。
    const result = validateConfig({
      projects: [{
        name: 'pms',
        match: { platform: 'feishu', appToken: 'cli_secret_app_token', tableId: 'tbl1' },
        repo: { path: 'D:/repo' },
      }],
      pushplus: { callbackUrl: 'https://cb.example/hook' },
    })
    assert.ok(result.value, `校验应当通过：${JSON.stringify(result.issues ?? [])}`)
    const described = describeConfig(result.value)
    assert.equal(described.projects[0].match.appToken, '***(已配置)', 'appToken 是密钥，必须打码')
    assert.equal(described.projects[0].match.tableId, 'tbl1', '非密钥字段照常显示')
    assert.equal(described['pushplus.callbackUrl'], 'https://cb.example/hook')
    // 已经删掉的键不该再出现在 describeConfig 的输出里（否则面板会把死键画出来）。
    assert.equal('pushplus.token' in described, false, '已删的配置键不能还留在 describe 输出里')
    assert.equal('logLevel' in described, false)
  })

  await check('配置面收敛到 25 个键 / 4 个分组，且每个键都归到了组里', async () => {
    // 涨键是有代价的：每多一个键，面板就多一格要人判断的东西，文档就多一行。
    // 这条断言把当前数字钉住 —— 想加键必须先回答「为什么这个人必须懂这件事」。
    // 24 → 25 是 #14 加的 `writeBackOnFailure`（失败也写「处理结果」列，缺省关）。
    const keys = Object.keys(CONFIG_FIELDS)
    assert.equal(keys.length, 25, '顶层配置字段应当是 25 个，实际：' + keys.join(', '))
    assert.equal(CONFIG_GROUPS.length, 4, '分组应当是 4 组')
    assertGroupCoverage() // 漏写分组会在这里抛
    // 死键必须真的死了：这两个键曾经在面板上可编辑、改了什么也不发生。
    assert.equal('concurrency' in CONFIG_FIELDS, false, 'concurrency 是死配置，必须删掉')
    assert.equal('logLevel' in CONFIG_FIELDS, false, 'logLevel 是死配置，必须删掉')
    // 收成内置常量的 4 个键不能再出现在配置面上（否则又是「配了不生效」）。
    for (const key of ['safePageRun', 'goneAfterScans', 'leaseHeartbeatSeconds', 'fetchBeforeCreate']) {
      assert.equal(key in CONFIG_FIELDS, false, key + ' 已收成内置常量，不该再是配置项')
    }
    assert.equal(BUILTIN_LIMITS.safePageRun, 20)
    assert.equal(BUILTIN_LIMITS.goneAfterScans, 3)
    assert.equal(BUILTIN_LIMITS.leaseHeartbeatSeconds, 60)
    assert.equal(BUILTIN_LIMITS.fetchBeforeCreate, true)
  })

  await check('老配置里留着已删的键：不报错、不生效、不静默改变行为', async () => {
    // 别人的 cordis.patch.yml 已经写着这些键了。删键不能变成「升级后插件装不上」。
    const legacy = {
      safePageRun: 50,
      goneAfterScans: 9,
      concurrency: 4,
      leaseHeartbeatSeconds: 5,
      fetchBeforeCreate: false,
      logLevel: 'debug',
      pushplus: { token: 'leftover', template: 'html' },
      qqmail: { port: 587, secure: false },
    }
    const result = validateConfig(legacy)
    assert.ok(result.value, '老配置必须能加载：' + JSON.stringify(result.issues ?? []))
    assert.equal(result.issues ?? undefined, undefined, '删掉的键不该产生校验错误')
    // 它们既不进归一后的配置，也不该偷偷改掉新键的默认值。
    for (const key of ['safePageRun', 'goneAfterScans', 'concurrency', 'leaseHeartbeatSeconds', 'fetchBeforeCreate', 'logLevel']) {
      assert.equal(key in result.value, false, key + ' 已删除，不该出现在归一后的配置里')
    }
    assert.equal(result.value.qqmail.encryption, 'tls', '老的 qqmail.port 不该顶掉新键的默认值')
  })

  await check('配置拼错一个字母：只警告不挡启动，且说出最像的那个键', async () => {
    // 真实痛点：`pollInvervalMinutes`（少一个字母）过去完全静默 —— 插件照常启动、
    // 按缺省 3 分钟跑，人以为自己配了 30 分钟，查半天查不出来。宁可多一句提醒。
    const result = validateConfig({ pollInvervalMinutes: 30 })
    assert.ok(result.value, '拼错的键不能挡住启动：' + JSON.stringify(result.issues ?? []))
    assert.equal(result.issues ?? undefined, undefined, '拼错的键是警告，不是错误')
    assert.equal('pollInvervalMinutes' in result.value, false, '拼错的键不该进归一后的配置')
    assert.equal(result.value.pollIntervalMinutes, 3, '拼错就当没配，回落缺省值')
    const warnings = result.warnings ?? []
    assert.equal(warnings.length, 1, '应当正好一条警告，实际：' + JSON.stringify(warnings))
    assert.match(warnings[0], /pollInvervalMinutes/, '警告要点名那个键')
    assert.match(warnings[0], /pollIntervalMinutes/, '警告要说「你要找的是哪个」')
    // 挂在配置对象上（不可枚举），pipeline_doctor 只拿得到配置对象，读不到就白做。
    assert.deepEqual(readConfigWarnings(result.value), warnings, '警告必须能随配置对象带出去')
    assert.equal(Object.keys(result.value).includes('pollInvervalMinutes'), false, '符号挂载不能污染普通键')
  })

  await check('配置里留着已删的键：给成因，不是一句「不存在」', async () => {
    // 老配置里躺着 `concurrency: 4` 的人，最想知道的是「它去哪了」而不是「它不存在」。
    const result = validateConfig({ concurrency: 4, logLevel: 'debug' })
    assert.ok(result.value)
    const warnings = result.warnings ?? []
    assert.equal(warnings.length, 2, '两个已删键各一条，实际：' + JSON.stringify(warnings))
    assert.match(warnings[0], /concurrency/)
    assert.match(warnings[0], /留着不影响启动/, '已删键的说辞要和「拼错」区分开：留着是合法的')
    assert.match(warnings[0], /恒 1|并发/, '要说清为什么没有再给配')
    assert.ok(Object.keys(REMOVED_CONFIG_KEYS).length >= 8, '已删键的成因表不该只剩几个')
    for (const key of ['concurrency', 'logLevel', 'safePageRun', 'pushplus.token', 'qqmail.port']) {
      assert.ok(key in REMOVED_CONFIG_KEYS, key + ' 应当在已删键成因表里')
    }
  })

  await check('完全不认识的键：不硬猜，但仍然说清楚「写了也不生效」', async () => {
    const result = validateConfig({ totallyMadeUpKey: 1 })
    assert.ok(result.value)
    const warnings = result.warnings ?? []
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /totallyMadeUpKey/)
    assert.match(warnings[0], /不会生效/)
    assert.equal(suggestConfigKey('totallyMadeUpKey'), '', '离得远就不该硬猜一个键出来')
    assert.equal(suggestConfigKey('pollInvervalMinutes'), 'pollIntervalMinutes', '差一个字母要猜得出来')
  })

  await check('校验报错带中文名与修法，不再只给一句「值不对」', async () => {
    const bad = validateConfig({ pollIntervalMinutes: 999 })
    assert.ok(bad.issues && bad.issues.length === 1)
    const issue = bad.issues[0]
    // 中文名 + 原始路径都要有：前者让人知道说的是哪一格，后者让人能在文件里搜到。
    assert.match(issue.message, /轮询间隔/, '要用中文 label，不能只甩 pollIntervalMinutes')
    assert.match(issue.message, /pollIntervalMinutes/, '原始路径要保留，方便 grep')
    assert.match(issue.message, /不能大于 60/)
    assert.ok(typeof issue.fix === 'string' && issue.fix.length > 0, '每条报错都要带修法')
    assert.match(issue.fix, /1–60|1-60/, '修法要给可用范围')
    assert.match(issue.fix, /3/, '修法要给常用值')

    const enumBad = validateConfig({ workExecutor: 'agentt' })
    const enumIssue = (enumBad.issues ?? [])[0]
    assert.match(enumIssue.message, /执行器/, '枚举字段也要中文名')
    assert.match(enumIssue.message, /agent/)
    assert.match(enumIssue.fix, /mock/, '枚举报错的修法要提缺省推荐值')

    // 项目侧字段同样要有中文名（不说人话的 `repo.path` 最容易让人卡住）。
    const projBad = validateConfig({ projects: [{ name: 'p', match: { platform: 'feishu' }, repo: {} }] })
    const pathIssue = (projBad.issues ?? []).find((one) => one.path.join('.').includes('repo.path'))
    assert.ok(pathIssue, 'repo.path 应当报错')
    assert.match(pathIssue.message, /仓库路径/, '项目字段也要中文名')
    assert.match(pathIssue.fix, /本机的路径|D:\//, '修法要给一个能照抄的例子')

    // label 查表本身也要能对得上几种形态（面板与校验共用同一套中文名）。
    assert.equal(configFieldLabel('pollIntervalMinutes'), '轮询间隔（分钟）')
    assert.equal(configFieldLabel('qqmail.host'), 'SMTP 主机')
    assert.equal(configFieldLabel('projects[0].repo.path'), '仓库路径')
    assert.equal(configFieldLabel('projects[].match.appToken'), '飞书 appToken')
    assert.equal(configFieldLabel('nope'), '')
  })

  await check('pushplus 的 token 只走凭据，不从配置里读', async () => {
    // 这条是真实事故：凭据页写着「填这里就行」，但 pushplus 分支根本没传 getSecret，
    // 用户填了凭据、通知永远发不出去，只留一条 warn。
    const { createPushplusPush, PUSHPLUS_SECRET_REF } = await import('../src/adapters/push-pushplus/index.js')
    const seen = []
    const push = createPushplusPush({
      getSecret: async (ref) => {
        seen.push(ref)
        return 'token-from-credentials'
      },
      fetch: async (url, init) => {
        const body = JSON.parse(init.body)
        assert.equal(body.token, 'token-from-credentials', '发出去的 token 必须来自凭据')
        return { ok: true, status: 200, json: async () => ({ code: 200 }) }
      },
    })
    const out = await push.send({ title: 't', body: 'b' }, undefined)
    assert.equal(out.accepted, true)
    assert.deepEqual(seen, [PUSHPLUS_SECRET_REF], '必须按 PUSHPLUS_TOKEN 取凭据')
    // 配置里不再有 pushplus.token 这个键（token 落进 yml 就等于明文泄露）。
    assert.equal('pushplus.token' in validateConfig({}).value.pushplus, false)
  })

  await check('pipeline_scan：总开关关着就说 disabled，且不启动任何后台工作', async () => {
    // 以前这里只承诺、不实现：代码永远返回 triggered，用户看到「已触发」以为在跑，
    // 其实 tick() 立刻返回 disabled，什么都没发生。
    let tickCalls = 0
    const tool = createPipelineScanTool({
      tick: async () => { tickCalls += 1; return { status: 'ok' } },
      isRunning: () => false,
      getConfig: () => ({ enabled: false }),
    })
    const out = await tool.execute({}, {})
    assert.equal(out.status, 'disabled')
    assert.equal(tickCalls, 0, '开关关着时不该起后台任务')
    assert.match(out.text, /enabled/)
    assert.match(out.text, /改配置|设置面板/)
  })

  await check('pipeline_scan：正在跑就说 already-running，不叠第二轮', async () => {
    let tickCalls = 0
    const tool = createPipelineScanTool({
      tick: async () => { tickCalls += 1; return { status: 'ok' } },
      isRunning: () => true,
      getConfig: () => ({ enabled: true }),
    })
    const out = await tool.execute({}, {})
    assert.equal(out.status, 'already-running')
    assert.equal(tickCalls, 0, '已经在跑时不能再触发一轮')
    assert.match(out.text, /不叠加/)
    assert.match(out.text, /pipeline_status/)
  })

  await check('pipeline_scan：空闲时触发一轮，但不等它跑完（fire-and-forget）', async () => {
    // 同步等会让宿主工具通道超时、报 not lossless JSON（生产实锤过），
    // 所以这条断言的核心是「tick 还没结束就返回了」。
    let resolveTick = null
    let tickCalls = 0
    const tool = createPipelineScanTool({
      tick: () => {
        tickCalls += 1
        return new Promise((resolve) => { resolveTick = resolve })
      },
      isRunning: () => false,
      getConfig: () => ({ enabled: true }),
    })
    const out = await tool.execute({ skipScan: true }, {})
    assert.equal(out.status, 'triggered')
    assert.equal(tickCalls, 1)
    assert.equal(out.scan, null, '还没跑完，扫表结果只能是 null')
    assert.equal(out.ran, null)
    assert.match(out.text, /pipeline_status/, '必须告诉人下一步去哪看结果')
    assert.equal(typeof resolveTick, 'function', 'tick 应该真的被调起来了')
    resolveTick({ status: 'ok' })
  })

  await check('pipeline_scan：后台那一轮炸了要有日志，不能静默', async () => {
    const logged = []
    const tool = createPipelineScanTool({
      tick: async () => { throw new Error('扫表炸了') },
      isRunning: () => false,
      getConfig: () => ({ enabled: true }),
      log: (message, detail) => logged.push([message, detail]),
    })
    const out = await tool.execute({}, {})
    assert.equal(out.status, 'triggered')
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(logged.length, 1, '后台失败必须留痕')
    assert.match(String(logged[0][1]?.reason ?? ''), /扫表炸了/)
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
    // #02：重开入口只有 pipeline_reset 这一条，取消文案必须先把人指向它，
    // 不要把「拨表格」当成主路径（那条路会整票重做并覆盖旧回填）。
    assert.match(out.text, /pipeline_reset/)
    assert.ok(out.text.indexOf('pipeline_reset') < out.text.indexOf('拨回'), '先提 reset，再提拨表格')
    await running
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'failed')
    assert.equal(row.lastError, 'cancelled by user')
    assert.equal(push.messages.length, 0, '人工取消不打扰人')
  })

  await check('pipeline_status 把「你取消的」和「它自己挂的」分开说', async () => {
    // #02：取消与真失败共用 phase=failed，只能靠 lastError 区分。
    // 不区分的话，人会把「我按的取消」当成「它挂了」，白紧张一场。
    const rows = [
      { key: k('c'), projectId: DEMO, recordId: 'c', phase: 'failed', attempt: 0, lastError: 'cancelled by user' },
      { key: k('f'), projectId: DEMO, recordId: 'f', phase: 'failed', attempt: 0, lastError: 'internal: agent 没有产生任何文件改动' },
    ]
    const out = await createPipelineStatusTool({
      store: { listTickets: () => rows }, getConfig: () => validateConfig({}).value, now: () => 10_000,
    }).execute({ view: 'tickets', includeDone: true }, {})

    assert.match(out.text, /失败（你取消的）/, `取消的票要在状态里认出来：${out.text}`)
    assert.match(out.text, /这张票是你取消的/, '取消的票不要用「去修好它」的语气')
    // 内部标识符不该漏到用户眼前：'cancelled by user' 只该出现在存储里。
    assert.equal(out.text.includes('cancelled by user'), false, `不要把内部标识符念给人听：${out.text}`)
    // 真失败那张不能也挂上「你取消的」—— 否则人以为可以不管。
    const fLine = out.text.split('\n').find((line) => /^· \[.*\] f｜/.test(line))
    assert.ok(fLine, `真失败那张要有一行：${out.text}`)
    assert.equal(fLine.includes('你取消的'), false, `真失败不冒充用户取消：${fLine}`)
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

  // 这一组用例对应真实事故 pms|reczz28VWNWVbpgL（2026-11-06）：票据上 worktreePath 与
  // workspacePath 都「有值」，但那个目录早被删了、仓库也换了，旧守卫整段跳过
  // prepareWorkspace，陈旧路径原样进执行器 → workingDirectory.set 对着空气报错 → 票 failed。
  // 更糟的是 resetByHuman 不清工作区坐标，人工重开之后还会原样再失败一次。
  const makeSeenExecutor = (holder) => ({
    id: 'spy',
    async run (ticket, target, ctx) {
      holder.ctx = ctx
      await ctx.onPhase('editing')
      await ctx.onPhase('testing')
      await ctx.onPhase('mr-opening')
      return makeExecResult({ phase: 'done', changedFiles: [], testOutcome: 'passed', mr: { iid: 1, url: 'mock://mr/1', draft: true } })
    },
  })

  await check('票据上的工作区目录已被删：不能复用，必须重建成新的', async () => {
    const holder = {}
    let prepares = 0
    const seenOpts = []
    const { scheduler, store } = harness({
      executor: makeSeenExecutor(holder),
      // 目录已不在
      worktreeExists: async () => false,
      prepareWorkspace: async (opts) => {
        prepares += 1
        seenOpts.push(opts)
        return { path: 'D:/WorkSpace/demo-repo', branch: 'v2.x', baseCommit: 'fresh1', repoPath: 'D:/WorkSpace/demo-repo', workspacePath: 'D:/WorkSpace/demo-repo', workspaceId: 'ws-new' }
      },
    })
    const source = createMockSource()
    const scan = await source.scan(new AbortController().signal)
    await store.enqueue(scan.created[0], { phase: 'worktree-ready' })
    await store.setPhase(k('rec-mock-001'), 'planning', {
      worktreePath: 'D:/gone/.agents/worktrees/ticket-demo-rec-mock-001-r1',
      branch: 'ticket-demo-rec-mock-001-r1',
      baseCommit: 'dead',
      repoPath: 'D:/WorkSpace/demo-repo',
      workspacePath: 'D:/WorkSpace/demo-repo',
      workspaceId: 'ws-old',
    })
    await store.setPhase(k('rec-mock-001'), 'pending')
    await scheduler.tick()
    assert.equal(prepares, 1, '目录没了就必须重新准备，不能抱着死路径往下跑')
    assert.equal(seenOpts[0].worktreePath, undefined, '失效坐标不能传给 prepareWorkspace，否则它只会补登记、把死路径原样回传')
    assert.equal(seenOpts[0].branch, undefined)
    assert.equal(seenOpts[0].baseCommit, undefined)
    assert.equal(holder.ctx.worktreePath, 'D:/WorkSpace/demo-repo', '执行器拿到的是重建成的新路径')
    assert.equal(holder.ctx.baseCommit, 'fresh1')
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.worktreePath, 'D:/WorkSpace/demo-repo', '新坐标要落库，下一轮才不会再重建')
  })

  await check('项目换了仓库：旧坐标指向的是别的仓库，也要重生', async () => {
    const holder = {}
    let prepares = 0
    const seenOpts = []
    const { scheduler, store } = harness({
      executor: makeSeenExecutor(holder),
      // 目录本身还在（旧仓库还在磁盘上），只是不再是这次要改的仓库
      worktreeExists: async () => true,
      prepareWorkspace: async (opts) => {
        prepares += 1
        seenOpts.push(opts)
        return { path: 'D:/WorkSpace/mgiot-pms', branch: 'v2.x', baseCommit: 'm1', repoPath: 'D:/WorkSpace/mgiot-pms', workspacePath: 'D:/WorkSpace/mgiot-pms', workspaceId: 'ws-m' }
      },
    })
    const source = createMockSource()
    const scan = await source.scan(new AbortController().signal)
    await store.enqueue(scan.created[0], { phase: 'worktree-ready' })
    await store.setPhase(k('rec-mock-001'), 'planning', {
      worktreePath: 'D:/WorkSpace/dsh-ticket-pipeline/.repos/mgiot-pms/.agents/worktrees/ticket-pms-rec-1-r1',
      branch: 'ticket-pms-rec-1-r1',
      baseCommit: 'old',
      // 当年是从 .repos/mgiot-pms 建的；现在项目 repo.path 已经指向 D:/WorkSpace/mgiot-pms
      repoPath: 'D:/WorkSpace/dsh-ticket-pipeline/.repos/mgiot-pms',
      workspacePath: 'D:/WorkSpace/dsh-ticket-pipeline/.repos/mgiot-pms',
      workspaceId: 'ws-old',
    })
    await store.setPhase(k('rec-mock-001'), 'pending')
    await scheduler.tick()
    assert.equal(prepares, 1, '换了仓库就必须重来：旧目录可能是另一个仓库的有效检出')
    assert.equal(seenOpts[0].worktreePath, undefined, '异仓库的坐标不能传给 prepareWorkspace')
    assert.equal(holder.ctx.repoPath, 'D:/WorkSpace/mgiot-pms')
  })

  await check('探测本身出错时不算失效：宁可复用也别把已有工作区推倒重来', async () => {
    const holder = {}
    let prepares = 0
    const { scheduler, store } = harness({
      executor: makeSeenExecutor(holder),
      worktreeExists: async () => {
        throw new Error('git 不在 PATH 里')
      },
      prepareWorkspace: async () => {
        prepares += 1
        return { path: 'D:/wt/other', branch: 'b', baseCommit: 'c' }
      },
    })
    const source = createMockSource()
    const scan = await source.scan(new AbortController().signal)
    await store.enqueue(scan.created[0], { phase: 'worktree-ready' })
    await store.setPhase(k('rec-mock-001'), 'planning', {
      worktreePath: 'D:/wt/keep',
      branch: 'b-keep',
      baseCommit: 'c1',
      repoPath: 'D:/WorkSpace/demo-repo',
      workspacePath: 'D:/WorkSpace/demo-repo',
      workspaceId: 'ws-keep',
    })
    await store.setPhase(k('rec-mock-001'), 'pending')
    await scheduler.tick()
    assert.equal(prepares, 0, '问不到 ≠ 没有了，不该重建')
    assert.equal(holder.ctx.worktreePath, 'D:/wt/keep', '照旧复用票据上的坐标')
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
    // #08：正文只给人话，不拼 `internal:` 前缀。分类进 lastErrorKind，不进正文。
    assert.match(body, /失败原因：mock：真实失败原因/, '失败原因要是这次的错误，不是运行前的旧值')
    assert.ok(!body.includes('internal:'), `通知正文不能出现内部 kind 前缀：${body}`)
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

  await check('可重试失败退避后跑成：setPhase 必须真的清掉上一轮的 lastError', async () => {
    // 上一条用例走的是 resetByHuman —— 那条路径直接 put 整行，本来就把 lastError 抹了，
    // 所以它根本碰不到 setPhase 的清除逻辑，用「清掉」与否都能通过（假绿）。
    // 这里走真实的重试路径：执行器抛可重试错误 → 票回 pending 且写下 lastError，
    // 下一轮跑成 → scheduler 传 `lastError: undefined` 表达「清掉」，必须真的生效。
    // 真实事故：2026-11-06 的 pms 票跑成了 done，却还挂着上一轮
    // `provider "workbuddy" has no configured model` —— 因为 setPhase 把 undefined 过滤掉了。
    let boom = true
    const flaky = {
      id: 'flaky',
      async run (ticket, target, ctx) {
        if (boom) throw new PipelineError('rate-limit', '上游限流了，稍后再来')
        await ctx.onPhase('editing')
        await ctx.onPhase('testing')
        await ctx.onPhase('mr-opening')
        return makeExecResult({
          phase: 'done',
          changedFiles: [],
          testOutcome: 'passed',
          commit: { sha: 'mockflaky01', branch: ctx.branch ?? '', files: [] },
        })
      },
    }
    const { scheduler, store } = harness({ executor: flaky })

    await scheduler.tick()
    const retried = store.getTicket(k('rec-mock-001'))
    assert.equal(retried.phase, 'pending', '可重试错误要让票留在队列里')
    assert.match(retried.lastError ?? '', /上游限流/, '退避时要写下这一轮的原因')
    assert.equal(retried.lastErrorKind, 'rate-limit', '分类进 lastErrorKind')

    // 退避到期，再跑一轮 —— 这次成功
    boom = false
    await store.setPhase(k('rec-mock-001'), 'pending', { enqueuedAt: 0 })
    store.listTickets()
      .filter((r) => r.recordId !== 'rec-mock-001')
      .forEach((r) => { r.phase = 'skipped' })
    await scheduler.tick()

    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'done', '第二轮应该跑成')
    assert.equal(row.lastError, undefined, '成功之后必须真的清掉上一轮的失败原因（不是靠 resetByHuman 兜的）')
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

  // 版本比对缺省会读真实磁盘（安装副本 + profile 的 package.json）。自测要离线、
  // 要不认这台机器的安装状态，所以每处都注入固定结果；真实比对另有 11.7 用假文件系统测。
  const NO_VERSION_CHECK = {
    comparePluginVersion: async () => ({
      ok: false,
      linked: false,
      reason: '自测：不读真实磁盘',
      sourceDir: '',
      installedDir: '',
      checked: 0,
      stale: [],
      missing: [],
      extra: [],
      sourceFingerprint: '',
      installedFingerprint: '',
    }),
  }

  await check('pipeline_doctor 全绿：git 可用 + 仓库正常 + 凭据齐', async () => {
    const tool = createPipelineDoctorTool({
      ...NO_VERSION_CHECK,
      // status --porcelain 必须回空串：这条用例验的是「干净时说检出干净」。
      // 回 'true' 会被当成一堆未提交改动（这条断言就是被它绊过）。
      gitRunner: async (argv) => ({
        code: 0,
        stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'),
        stderr: '',
      }),
      // enabled 必须显式 true：缺省是 false，体检会（正确地）报「总开关关着」。
      getConfig: () => ({ enabled: true, projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/repo/pms', remote: 'http://gitlab.local/mk/pms.git' } }], workExecutor: 'agent', pushAdapter: 'qqmail', qqmail: { host: 'smtp.qq.com', encryption: 'tls', user: 'a@qq.com', to: 'b@qq.com' }, isolateWorktree: false }),
      credentials: { describe: async (ref) => ({ configured: true }) },
    })
    const out = await tool.execute({}, {})
    assert.equal(out.ok, true, `应该全绿：${out.text}`)
    assert.equal(out.problems.length, 0)
    assert.equal(out.warnings.length, 0)
    assert.ok(out.text.includes('检出干净'), '缺省模式下要报告检出是否干净')
    assert.ok(out.text.includes('改代码落点'), '要把改代码落在哪里说出来')
    assert.ok(out.text.includes('项目工作区检出里'), '缺省是就地改，不是隔离 worktree')
    assert.ok(out.text.includes('总开关：已开启'), '开关开着要说出来，人才知道会自动扫表')
  })

  await check('凭据描述器：服务晚于 apply() 挂上也能用（真机上飞书能读到 secret，体检却报缺席）', async () => {
    // 真实现象：宿主里 credentials 服务是存在的、飞书也确实读到了 app_secret
    // （真链路回填发出了 data.setRecord，被多维表格权限挡回 ConnectorSyncTableActionForbidden），
    // 但 pipeline_doctor 一直报「⚠️ 凭据服务不可用（ctx.credentials 缺席）」。
    // 原因是描述器在 apply() 那一刻取一次并缓存成 null，之后永不重取。
    // credentials 不在 inject 里（故意的：mock 项目不需要它），所以挂载时刻没有保证。
    let service = null
    const ctx = { get: (name) => (name === 'credentials' ? service : undefined) }
    const describer = makeCredentialsDescriber(ctx)
    assert.equal(describer.available(), false, '服务还没挂上时 available() 必须说实话')
    assert.equal(await describer.describe('FEISHU_APP_SECRET'), undefined, '没服务时 describe 回 undefined')

    // 服务挂上来了（apply 之后），描述器必须能自己发现，不需要重启插件。
    service = { describe: async (ref) => ({ configured: ref === 'FEISHU_APP_SECRET' }) }
    assert.equal(describer.available(), true, '服务挂上后 available() 必须变 true')
    assert.equal((await describer.describe('FEISHU_APP_SECRET')).configured, true)
    assert.equal((await describer.describe('FEISHU_APP_ID')).configured, false)

    // 只有 resolve()（没有 describe）的服务也要能映射成布尔，且绝不把明文漏出来。
    service = { resolve: async (ref) => (ref === 'FEISHU_APP_ID' ? { value: 'cli_secret_value' } : undefined) }
    assert.equal((await describer.describe('FEISHU_APP_ID')).configured, true)
    assert.equal((await describer.describe('GITLAB_TOKEN')).configured, false)

    // 服务被卸掉之后也不能抛，只回落成 undefined。
    service = null
    assert.equal(describer.available(), false)
    assert.equal(await describer.describe('FEISHU_APP_ID'), undefined)
  })

  await check('pipeline_doctor 区分「凭据服务没挂上」和「这个 ref 没配」', async () => {
    const base = {
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({ projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/repo/pms' } }], workExecutor: 'agent', pushAdapter: 'qqmail', qqmail: { host: 'smtp.qq.com', encryption: 'tls', user: 'a@qq.com', to: 'b@qq.com' } }),
    }

    // a. 服务没挂上 —— 这是「装坏了/组合不对」，要进阻断（不是 warning），并说清怎么办。
    // 它挡的是整条跑票链路：读不到 app_secret 就换不到 token，一张票都收不到。
    const missing = await createPipelineDoctorTool({
      ...base,
      credentials: makeCredentialsDescriber({ get: () => undefined }),
    }).execute({}, {})
    assert.equal(missing.ok, false, `凭据服务缺席时不该报全绿：${missing.text}`)
    assert.ok(
      missing.blockers.some((p) => p.includes('凭据服务没挂上')),
      `要进 blockers：${JSON.stringify(missing.blockers)}`,
    )
    assert.ok(missing.text.includes('app_secret'), '要说清后果（读不到 app_secret）')
    assert.ok(missing.text.includes('重启'), '要给出下一步动作')

    // b. 服务在、但 ref 没配 —— 这是用户自己能修的，归 warnings 并指到设置页。
    const empty = await createPipelineDoctorTool({
      ...base,
      credentials: makeCredentialsDescriber({ get: () => ({ describe: async () => ({ configured: false }) }) }),
    }).execute({}, {})
    assert.ok(
      empty.blockers.some((w) => w.includes('凭据 FEISHU_APP_SECRET 未配置')),
      `服务在但没配要进 blockers（收不到票就跑不了）：${JSON.stringify(empty.blockers)}`,
    )
    assert.ok(
      empty.text.includes('「凭据」页签'),
      '要告诉用户去哪填（设置页凭据页签）',
    )
    assert.ok(!empty.blockers.some((p) => p.includes('凭据服务没挂上')), '服务在的时候不能说服务没挂上')
  })

  await check('pipeline_doctor 必须说出总开关状态（enabled 缺省 false，新用户配完也不跑）', async () => {
    // 真实现象：全新用户把项目、凭据、仓库都配好，体检报「环境体检通过」，
    // 然后永远等不到票 —— 因为 enabled 缺省 false，而以前体检一个字都不提它。
    const make = (enabled) => createPipelineDoctorTool({
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => ({
        code: 0,
        stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'),
        stderr: '',
      }),
      getConfig: () => ({
        enabled,
        projects: [{ name: 'pms', match: { platform: 'mock' }, repo: { path: 'D:/repo/pms' } }],
        workExecutor: 'agent',
        pushAdapter: 'qqmail', qqmail: { host: 'smtp.qq.com', encryption: 'tls', user: 'a@qq.com', to: 'b@qq.com' },
      }),
      credentials: { describe: async () => ({ configured: true }) },
    })

    const off = await make(false).execute({}, {})
    assert.ok(off.text.includes('总开关：关着'), `关着时必须显式说：${off.text}`)
    assert.ok(off.text.includes('enabled'), '要点名是哪个键')
    assert.ok(
      off.warnings.some((w) => w.includes('总开关是关的')),
      `也要进 warnings：${JSON.stringify(off.warnings)}`,
    )
    assert.ok(off.text.includes('pipeline_scan'), '要给出绕路办法（手动跑一轮）')
    // 关着不是「装坏了」，不该判成 problems 或 blockers —— 否则用户会以为环境有故障。
    assert.equal(off.problems.length, 0, `关开关不是故障：${JSON.stringify(off.problems)}`)
    assert.equal(off.blockers.length, 0, `关开关不是阻断：${JSON.stringify(off.blockers)}`)

    const on = await make(true).execute({}, {})
    assert.ok(on.text.includes('总开关：已开启'), `开着也要说一声：${on.text}`)
    assert.ok(!on.warnings.some((w) => w.includes('总开关')), '开着就不该再提醒开关')
  })

  await check('pipeline_doctor 报 git 不可用 + remote 连不上 + mock 提醒', async () => {
    const tool = createPipelineDoctorTool({
      ...NO_VERSION_CHECK,
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
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => (argv[0] === 'ls-remote'
        ? { code: 0, stdout: '', stderr: '' }
        : { code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({ projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/repo/pms', remote: 'http://gitlab.example.com/mk/pms.git', gitlab: { enabled: true } } }], workExecutor: 'agent', pushAdapter: 'qqmail', qqmail: { host: 'smtp.qq.com', encryption: 'tls', user: 'a@qq.com', to: 'b@qq.com' } }),
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
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({ projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/repo/pms', remote: 'http://gitlab.example.com/mk/pms.git' } }], workExecutor: 'agent', pushAdapter: 'qqmail', qqmail: { host: 'smtp.qq.com', encryption: 'tls', user: 'a@qq.com', to: 'b@qq.com' } }),
      credentials: { describe: async () => ({ configured: true }) },
      probeRemote: async () => { probed += 1; return { ok: true } },
    })
    const out2 = await noRemote.execute({}, {})
    assert.equal(probed, 0, '没开远程出口就不该去连 GitLab')
    assert.ok(out2.text.includes('只做本地提交'), `要说明只做本地提交：${out2.text}`)
  })

  await check('pipeline_doctor 检出脏时只提醒不拦：说清照跑、只提交 agent 改过的', async () => {
    const tool = createPipelineDoctorTool({
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => {
        if (argv[0] === 'status') return { code: 0, stdout: ' M a.ts\0?? b.ts\0', stderr: '' }
        return { code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : 'true', stderr: '' }
      },
      getConfig: () => ({ projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/repo/pms' } }], workExecutor: 'agent', pushAdapter: 'qqmail', qqmail: { host: 'smtp.qq.com', encryption: 'tls', user: 'a@qq.com', to: 'b@qq.com' }, isolateWorktree: false }),
      credentials: { describe: async () => ({ configured: true }) },
    })
    const out = await tool.execute({}, {})
    assert.ok(out.warnings.some((w) => w.includes('未提交改动')), `脏检出要提醒：${JSON.stringify(out.warnings)}`)
    // 脏检出已经不是「能不能跑」的前提了：跑票前会拍只读基线。
    // 文案必须说清「不影响跑票」，否则人会以为还得先去提交一遍。
    assert.equal(out.ok, true, '脏检出不能算「必须修复」')
    assert.equal(out.problems.length, 0, '脏检出不挡跑票')
    const dirtyNote = out.warnings.find((w) => w.includes('未提交改动')) ?? ''
    assert.ok(dirtyNote.includes('不影响跑票'), `要说明不影响跑票：${dirtyNote}`)
    assert.ok(dirtyNote.includes('只提交 agent 真正改过的文件'), `要说明只提交 agent 改的：${dirtyNote}`)
    assert.ok(out.text.includes('照跑'), `渲染要写清照跑：${out.text}`)
    // 打开隔离开关后就不该再拿「检出脏」说事：那时每票有自己的目录。
    const isolated = createPipelineDoctorTool({
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : 'true', stderr: '' }),
      getConfig: () => ({ projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/repo/pms' } }], workExecutor: 'agent', pushAdapter: 'qqmail', qqmail: { host: 'smtp.qq.com', encryption: 'tls', user: 'a@qq.com', to: 'b@qq.com' }, isolateWorktree: true }),
      credentials: { describe: async () => ({ configured: true }) },
    })
    const out3 = await isolated.execute({}, {})
    assert.ok(!out3.warnings.some((w) => w.includes('未提交改动')), '开了隔离就不该再要检出干净')
    assert.ok(out3.text.includes('隔离 worktree'), '要说明改代码落在隔离目录')
  })

  await check('pipeline_doctor 会显示自动识别出的基准分支，并在回退 main 时提醒', async () => {
    // 分支名猜错是这个插件最贵的一种错：fetch 第一步就失败，错误里看不出是分支名问题。
    const base = {
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : 'true', stderr: '' }),
      credentials: { describe: async () => ({ configured: true }) },
      getConfig: () => ({ projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/repo/pms', remote: 'http://gitlab.local/mk/pms.git' } }], workExecutor: 'agent', pushAdapter: 'qqmail', qqmail: { host: 'smtp.qq.com', encryption: 'tls', user: 'a@qq.com', to: 'b@qq.com' } }),
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
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : 'true', stderr: '' }),
      credentials: { describe: async () => ({ configured: true }) },
      detectBaseBranch: async () => { called = true; return 'main' },
      getConfig: () => ({ projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/repo/pms', remote: 'http://gitlab.local/mk/pms.git', baseBranch: 'v2.x' } }], workExecutor: 'agent', pushAdapter: 'qqmail', qqmail: { host: 'smtp.qq.com', encryption: 'tls', user: 'a@qq.com', to: 'b@qq.com' } }),
    })
    const out = await tool.execute({}, {})
    assert.equal(called, false, '配置写了就不该再猜')
    assert.ok(out.text.includes('基准分支 v2.x'), '要显示配置里的分支')
  })

  await check('pipeline_doctor 在 gitRunner 缺席时给出明确指引', async () => {
    const tool = createPipelineDoctorTool({
      ...NO_VERSION_CHECK,
      gitRunner: null,
      getConfig: () => ({ projects: [] }),
      credentials: null,
    })
    const out = await tool.execute({}, {})
    assert.equal(out.ok, false)
    assert.ok(out.text.includes('git'), '要点出 git 不可用')
    assert.ok(out.text.includes('projects 为空') === false || out.warnings.length > 0, '空项目要提醒')
  })

  // 版本检查这一节的三种结论都要能看见：一致 / 落后 / 比不出来。
  // 落后者必须同时进 warnings（人要被告知）和正文（同一份 text 给 GUI 与 agent）。
  await check('pipeline_doctor 报告插件版本落后，并给出同步命令', async () => {
    const stale = (extra = {}) => ({
      ok: true,
      linked: false,
      reason: '',
      sourceDir: 'D:/src/plugins/ticket-pipeline',
      installedDir: 'C:/Users/x/.dsh/profiles/desktop/node_modules/@local/ticket-pipeline',
      checked: 12,
      stale: ['src/index.js', 'src/tools/pipeline-doctor.js'],
      missing: ['src/core/plugin-version.js'],
      extra: [],
      sourceFingerprint: 'a1b2c3d4',
      installedFingerprint: 'e5f6a7b8',
      ...extra,
    })
    const tool = createPipelineDoctorTool({
      comparePluginVersion: async () => stale(),
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({ projects: [{ name: 'pms', match: { platform: 'feishu' }, repo: { path: 'D:/repo/pms' } }], workExecutor: 'agent', pushAdapter: 'qqmail', qqmail: { host: 'smtp.qq.com', encryption: 'tls', user: 'a@qq.com', to: 'b@qq.com' } }),
      credentials: { describe: async () => ({ configured: true }) },
    })
    const out = await tool.execute({}, {})
    // 装的是旧版插件，票照样跑得完 —— 不能算成「必须修复」。
    assert.equal(out.ok, true, `版本落后不该挡住跑票：${out.text}`)
    assert.equal(out.problems.length, 0, '不该进 problems')
    assert.ok(out.warnings.some((w) => w.includes('插件不是最新')), `要提醒插件不是最新：${JSON.stringify(out.warnings)}`)
    assert.ok(out.text.includes('src/index.js'), '要点名哪些文件不同')
    assert.ok(out.text.includes('重启宿主'), '要给出它该怎么做')
    assert.ok(out.text.includes('a1b2c3d4') && out.text.includes('e5f6a7b8'), '要印两边的指纹，方便贴到对话里')

    // 一致时说一致，不制造噪音。
    const same = createPipelineDoctorTool({
      comparePluginVersion: async () => stale({ stale: [], missing: [] }),
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({ projects: [] }),
      credentials: { describe: async () => ({ configured: true }) },
    })
    const out2 = await same.execute({}, {})
    assert.ok(!out2.warnings.some((w) => w.includes('插件不是最新')), '一致时不该提醒更新')
    assert.ok(out2.text.includes('安装副本与源码一致'), `一致要说清：${out2.text}`)

    // 链接安装（源码目录就是运行目录）永远是最新，不能说它落后。
    const linked = createPipelineDoctorTool({
      comparePluginVersion: async () => stale({ linked: true, reason: '安装目录是指向源码的链接，改完即生效', stale: [], missing: [] }),
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({ projects: [] }),
      credentials: { describe: async () => ({ configured: true }) },
    })
    const out3 = await linked.execute({}, {})
    assert.ok(!out3.warnings.some((w) => w.includes('插件不是最新')), '链接安装不该报落后')
    assert.ok(out3.text.includes('链接'), `链接安装要说清为什么不用更新：${out3.text}`)

    // 比不出来（从 registry 装的、profile 结构不认识）只说明一句，不算故障。
    const unknown = createPipelineDoctorTool({
      comparePluginVersion: async () => ({ ok: false, linked: false, reason: 'profile 里没有 file:/link: 声明', sourceDir: '', installedDir: '', checked: 0, stale: [], missing: [], extra: [], sourceFingerprint: '', installedFingerprint: '' }),
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({ projects: [] }),
      credentials: { describe: async () => ({ configured: true }) },
    })
    const out4 = await unknown.execute({}, {})
    assert.equal(out4.ok, true, '比不出来不该算问题')
    assert.ok(out4.text.includes('无法比对'), `要说清是比不出来：${out4.text}`)
    assert.ok(!out4.text.includes('插件不是最新'), '比不出来不能说它落后')
  })

  // ── 体检扩面：飞书连通性 / 通知完整性 / 三档结论 ──────────────────
  // 这四件事（权限没开、版本没发布、不是协作者、通知通道没填全）在本地完全看不出来，
  // 以前只能等第一张票跑挂才暴露，而那时用户手里一条线索都没有。
  await check('体检：飞书 App Secret 填错 → 报「不匹配」+ 具体修法（含错误码）', async () => {
    const tool = createPipelineDoctorTool({
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({
        enabled: true,
        projects: [{ name: 'pms', match: { platform: 'feishu', appToken: 'bascn', tableId: 'tbl1' }, repo: { path: 'D:/repo/pms' } }],
        workExecutor: 'agent',
        pushAdapter: 'mock',
      }),
      credentials: { describe: async () => ({ configured: true }) },
      readSecret: async (ref) => (ref === 'FEISHU_APP_SECRET' ? 'wrong-secret' : 'cli_app'),
      // 探针走真实现，只把 fetch 换成离线桩：这样验的是「码表 → 人话 + 修法」整条链，
      // 而不是我在测试里手工拼一个理想对象。
      probeFeishu: (input) => probeFeishuConnectivity({
        ...input,
        fetch: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ code: 10014, msg: 'app secret invalid' }),
          text: async () => JSON.stringify({ code: 10014, msg: 'app secret invalid' }),
        }),
      }),
    })
    const out = await tool.execute({}, {})
    assert.equal(out.ok, false, '认证过不了就跑不了票')
    assert.ok(out.text.includes('App ID / App Secret 不匹配'), `要说人话：${out.text}`)
    assert.ok(out.text.includes('10014'), '要带错误码，方便拿去搜')
    assert.ok(out.text.includes('凭证与基础信息'), '要给具体去哪修')
    assert.ok(out.blockers.length > 0, '认证失败要进阻断档')
  })

  await check('体检：应用不是表协作者 → 说清「读不到数据」+ 怎么加回来', async () => {
    const tool = createPipelineDoctorTool({
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({
        enabled: true,
        projects: [{ name: 'pms', match: { platform: 'feishu', appToken: 'bascn', tableId: 'tbl1' }, repo: { path: 'D:/repo/pms' } }],
        workExecutor: 'agent',
        pushAdapter: 'mock',
      }),
      credentials: { describe: async () => ({ configured: true }) },
      readSecret: async () => 'x',
      probeFeishu: async () => ({
        skipped: false,
        token: { ok: true, message: 'token 有效' },
        projects: [{
          name: 'pms',
          kind: 'bitable',
          table: 'tbl1',
          metadata: { ok: false, message: '表不存在，或者应用不是这张表的协作者（1254043）', fix: '表格 →「…」→「更多」→「添加文档应用」，加为可编辑协作者。', code: 1254043 },
        }],
      }),
    })
    const out = await tool.execute({}, {})
    assert.equal(out.ok, false)
    assert.ok(out.text.includes('读不到表元数据'), `要点出是哪一层失败：${out.text}`)
    assert.ok(out.text.includes('添加文档应用'), '要给「怎么加回来」的动作')
    assert.ok(out.blockers.some((b) => b.includes('飞书项目 pms')), '要指名是哪个项目')
  })

  await check('体检：通知通道不完整算阻断，不算提醒（票跑完发不出通知等于白跑）', async () => {
    const tool = createPipelineDoctorTool({
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({
        enabled: true,
        projects: [],
        workExecutor: 'agent',
        pushAdapter: 'qqmail',
        qqmail: { host: 'smtp.qq.com', encryption: 'tls', user: 'a@qq.com' }, // 故意缺 to
      }),
      credentials: { describe: async () => ({ configured: true }) },
    })
    const out = await tool.execute({}, {})
    assert.equal(out.ok, false, '缺 to 就发不出邮件')
    assert.ok(out.blockers.some((b) => b.includes('通知通道不完整')), `要进阻断：${JSON.stringify(out.blockers)}`)
    assert.ok(out.text.includes('qqmail.to'), '要点名缺哪个字段')
    assert.ok(out.text.includes('「通知」组'), '要指到设置页哪一组')
    // 而且不能说「体检通过」——这是最容易让人放心的假象。
    assert.ok(!out.text.includes('环境体检通过'), '有阻断时不能说通过')
  })

  await check('体检：pushAdapter=mock 时明说不会真的发通知', async () => {
    const tool = createPipelineDoctorTool({
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({ enabled: true, projects: [], workExecutor: 'agent', pushAdapter: 'mock' }),
      credentials: { describe: async () => ({ configured: true }) },
    })
    const out = await tool.execute({}, {})
    assert.equal(out.ok, true, `mock 是合法配置，不该算问题：${out.text}`)
    assert.ok(out.text.includes('不会真的发'), `要明说 mock 不发真消息：${out.text}`)
    assert.ok(out.warnings.some((w) => w.includes('mock')), 'mock 归提醒档')
  })

  await check('体检：飞书探针超时/炸了都不让体检失败，只记一行', async () => {
    const base = {
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({
        enabled: true,
        projects: [{ name: 'pms', match: { platform: 'feishu', appToken: 'bascn', tableId: 'tbl1' }, repo: { path: 'D:/repo/pms' } }],
        workExecutor: 'agent',
        pushAdapter: 'mock',
      }),
      credentials: { describe: async () => ({ configured: true }) },
      readSecret: async () => 'x',
    }
    const threw = await createPipelineDoctorTool({
      ...base,
      probeFeishu: async () => { throw new Error('socket hang up') },
    }).execute({}, {})
    assert.ok(!threw.text.includes('环境体检通过') || threw.blockers.length === 0, '探针炸了不该伪装成全绿')
    assert.ok(threw.text.includes('检查过程出错'), `要说清是探测本身出错，不是飞书那边的结论：${threw.text}`)
    assert.ok(threw.text.includes('socket hang up'), '要把原始错误带出来')

    // 超时同理：探针内部把 abort 归一成「检查超时」，体检只展示、不抛。
    const timedOut = await createPipelineDoctorTool({
      ...base,
      probeFeishu: async () => {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        return { skipped: false, token: describeProbeFailure(err), projects: [] }
      },
    }).execute({}, {})
    assert.ok(timedOut.text.includes('超时'), `超时要单独说：${timedOut.text}`)
    assert.ok(timedOut.text.includes('网络'), '要提示可能是网络问题')
  })

  await check('体检：总开关关着时给出「接下来四步」清单', async () => {
    const tool = createPipelineDoctorTool({
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({ enabled: false, projects: [], workExecutor: 'agent', pushAdapter: 'mock' }),
      credentials: { describe: async () => ({ configured: true }) },
    })
    const out = await tool.execute({}, {})
    assert.ok(out.text.includes('接下来四步'), `首跑要给清单：${out.text}`)
    assert.ok(out.text.includes('「凭据」页签'), '第一步是配凭据')
    assert.ok(out.text.includes('创建版本并发布'), '第二步要提醒发布版本（最常漏的一步）')
    assert.ok(out.text.includes('总开关'), '第四步是打开开关')
    // 顺序也要对：先凭据，最后才是开关 —— 反过来用户会先开开关再配凭据，中间白扫好几轮。
    // 只在「接下来四步」这一段里比位置：前面正文里也有「凭据」两个字。
    const stepsStart = out.text.indexOf('接下来四步')
    assert.ok(stepsStart >= 0, '要能找到清单起点')
    const steps = out.text.slice(stepsStart)
    assert.ok(steps.indexOf('「凭据」页签') < steps.indexOf('总开关'), `顺序不能反：${steps}`)
  })

  await check('体检：没开远程 MR 的项目，一个字都不提 GITLAB_TOKEN', async () => {
    // 真实现象：缺省安装里没有任何项目开 MR，体检每次却都念一句
    // 「ℹ️ 凭据 GITLAB_TOKEN：未配置」——念多了人就会学会整段忽略体检输出。
    const out = await createPipelineDoctorTool({
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({
        enabled: true,
        projects: [{ name: 'pms', match: { platform: 'mock' }, repo: { path: 'D:/repo/pms' } }],
        workExecutor: 'agent',
        pushAdapter: 'mock',
      }),
      credentials: { describe: async () => ({ configured: true }) },
    }).execute({}, {})
    assert.equal(out.ok, true, `缺省该项目全绿：${out.text}`)
    assert.ok(!out.text.includes('GITLAB_TOKEN'), `不该提 GITLAB_TOKEN：${out.text}`)
    assert.ok(!out.text.includes('远程 MR'), '没开的时候连这一节都不该出现')
  })

  await check('体检：开了远程 MR 却缺定位字段 → 进阻断，并说清「跑到最后一步才失败」', async () => {
    const out = await createPipelineDoctorTool({
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({
        enabled: true,
        projects: [{ name: 'pms', match: { platform: 'mock' }, repo: { path: 'D:/repo/pms', gitlab: { enabled: true } } }],
        workExecutor: 'agent',
        pushAdapter: 'mock',
      }),
      credentials: { describe: async (ref) => ({ configured: ref !== 'GITLAB_TOKEN' }) },
    }).execute({}, {})
    assert.equal(out.ok, false, `缺字段要拦：${out.text}`)
    assert.ok(
      out.blockers.some((b) => b.includes('远程 MR') || b.includes('repo.gitlab.enabled')),
      `要进 blockers：${JSON.stringify(out.blockers)}`,
    )
    assert.ok(out.text.includes('跑到最后一步才失败'), '要说清失败时机（改动都做完了才炸）')
    assert.ok(out.text.includes('GitLab Commits API'), '要说明为什么只能走 API')
    // 打开了才查 token：这条路径下缺 GITLAB_TOKEN 也是阻断。
    assert.ok(
      out.blockers.some((b) => b.includes('GITLAB_TOKEN')),
      `开了 MR 才该要 token：${JSON.stringify(out.blockers)}`,
    )
  })

  await check('体检：选了金山文档源就报阻断，并说清「一张票都拿不到」', async () => {
    // 工单 #20：wps 源的取数通道是注入式的，主装配没注入 ⇒ 选了它票永远是 0。
    // 这种「配完了什么都没发生」必须在这里拦，否则人只会以为插件坏了。
    const out = await createPipelineDoctorTool({
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({
        enabled: true,
        projects: [{ name: 'wps1', match: { platform: 'wps' }, repo: { path: 'D:/repo/wps1' } }],
        workExecutor: 'agent',
        pushAdapter: 'mock',
      }),
      credentials: { describe: async () => ({ configured: true }) },
    }).execute({}, {})
    assert.equal(out.ok, false, `选了 wps 要拦：${out.text}`)
    assert.ok(
      out.blockers.some((b) => b.includes('金山')),
      `要进 blockers：${JSON.stringify(out.blockers)}`,
    )
    assert.ok(out.text.includes('拿不到票'), '要说清后果（一张票都拿不到）')
    assert.ok(out.text.includes('feishu'), '要给出出路（改成 feishu）')
  })

  await check('体检：飞书连接失败都被归一成人话（码表 / 未知码 / 网络错 / 超时）', async () => {
    // 走真探针 + 假 fetch，每一档都验「用户看到的那句话」。
    // 不直接 new 内部错误类：那样测的是我的构造函数，不是用户的体验。
    const probeWith = (fetchImpl, extra = {}) => probeFeishuConnectivity({
      appId: 'cli_app',
      appSecret: 's',
      projects: [{ name: 'pms', match: { platform: 'feishu', appToken: 'bascn', tableId: 'tbl1' } }],
      fetch: fetchImpl,
      ...extra,
    })
    const jsonOnce = (body) => {
      let sent = 0
      return async () => {
        sent += 1
        // 第一个请求是认证：认证失败后探针不会再发后面的请求。
        void sent
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => body,
          text: async () => JSON.stringify(body),
        }
      }
    }

    // a. 码表命中：要给「人话 + 去哪修」。
    const auth = await probeWith(jsonOnce({ code: 10014, msg: 'invalid app_secret' }))
    assert.equal(auth.token.ok, false)
    assert.equal(auth.token.message, 'App ID / App Secret 不匹配')
    assert.ok(auth.token.fix.includes('凭证与基础信息'), '修法要具体到飞书后台哪个页面')
    assert.equal(auth.token.code, 10014)

    // b. 未知码：也要能看懂，且把原始码与 msg 带出来，方便拿去搜。
    const unknown = await probeWith(jsonOnce({ code: 88888, msg: 'something odd' }))
    assert.ok(unknown.token.message.includes('88888'), `未知码要把码带出来：${unknown.token.message}`)
    assert.ok(unknown.token.message.includes('something odd'), '原话要留着')

    // c. 网络错（连不上）：要说「不是配置问题」，否则人会去改 App Secret。
    const netErr = await probeWith(async () => {
      const error = new Error('getaddrinfo ENOTFOUND open.feishu.cn')
      error.code = 'ENOTFOUND'
      throw error
    })
    assert.ok(netErr.token.message.includes('连不上'), `网络错要说连不上：${netErr.token.message}`)
    assert.ok(netErr.token.message.includes('不是配置问题'), '要让人别去改凭据')

    // d. 超时：10 秒（这里压到 20ms）没回来，要说「可能是网络」，不能报成凭据错。
    //    桩必须真的响应 abort —— 否则探针那个 await 永远不 settle，
    //    定时器一烧完事件循环就空了，node 会静默退出（这条用例踩过一次）。
    const timedOut = await probeWith(
      (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('The operation was aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }),
      { timeoutMs: 20 },
    )
    assert.ok(timedOut.token.message.includes('超时'), `超时要单独说：${timedOut.token.message}`)
    assert.ok(timedOut.token.message.includes('网络'), '要提示可能是网络问题')
    assert.ok(!timedOut.token.message.includes('App Secret'), '超时不能冤枉成凭据填错')
  })

  await check('体检：电子表格配成整条链接 / 知识库 wiki 链接时，先归一再查（不能拿 URL 当 token）', async () => {
    // 这是真机踩出来的 bug：配置里 match.spreadsheetToken 填的是面板上贴的
    // 「工单表链接」（一条 /wiki/<node_token>?sheet=xxx 的 URL），而探针以前把
    // 这条 URL 整个 encode 进 /sheets/v3/spreadsheets/<token>/sheets/query 的路径，
    // 拼出来的地址必然 404 —— 体检就报「读不到表元数据」，看上去像用户配错了。
    // 适配器本体一直是会归一的（extractSheetToken / isWikiToken ⇒ probeWikiNode），
    // 两边认的输入形态必须一致，否则体检会给出方向完全错的修法。
    const seen = []
    const fakeFeishu = async (url) => {
      const u = new URL(String(url))
      seen.push(u.pathname + u.search)
      const json = (body) => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => body,
        text: async () => JSON.stringify(body),
      })
      if (u.pathname.endsWith('/tenant_access_token/internal')) {
        // 真接口把这个字段放在**顶层**（不在 data 里），探针也是这么读的。
        return json({ code: 0, tenant_access_token: 't-1' })
      }
      if (u.pathname.endsWith('/wiki/v2/spaces/get_node')) {
        return json({ code: 0, data: { node: { obj_type: 'sheet', obj_token: 'shtcnObjToken' } } })
      }
      if (/\/sheets\/v3\/spreadsheets\/[^/]+\/sheets\/query$/.test(u.pathname)) {
        return json({ code: 0, data: { sheets: [{ sheet_id: 'sh1', title: 'Sheet1' }] } })
      }
      if (/\/sheets\/v2\/spreadsheets\/[^/]+\/values\//.test(u.pathname)) {
        return json({ code: 0, data: { valueRange: { values: [['序号', '问题描述'], ['A-1', 'x']] } } })
      }
      // 走到这里说明拼错地址了：返回 404，让用例以「失败」收场而不是静默通过。
      return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({ code: 404, msg: 'not found' }), text: async () => '{"code":404}' }
    }
    const probeWithLink = (spreadsheetToken) => probeFeishuConnectivity({
      appId: 'cli_app',
      appSecret: 's',
      projects: [{ name: 'pms', match: { platform: 'feishu', spreadsheetToken, sheetId: 'sh1' } }],
      fetch: fakeFeishu,
    })

    // ① 知识库（wiki）形态：要先 get_node 换 obj_token，再拿 obj_token 查。
    const wiki = await probeWithLink('https://x.feishu.cn/wiki/wikcnABCDEFG?sheet=sh1')
    assert.equal(wiki.projects[0].kind, 'sheet')
    assert.ok(
      seen.some((p) => p.includes('/wiki/v2/spaces/get_node') && p.includes('token=wikcnABCDEFG')),
      `wiki 链接要先查 get_node：${seen.join(' | ')}`,
    )
    assert.ok(
      seen.some((p) => p.includes('/sheets/v3/spreadsheets/shtcnObjToken/sheets/query')),
      `查工作表要用 get_node 换出来的 obj_token：${seen.join(' | ')}`,
    )
    assert.ok(
      !seen.some((p) => /spreadsheets%2F|spreadsheets\/https/.test(p)),
      `绝不能把整条 URL 当 token 拼进路径：${seen.join(' | ')}`,
    )
    assert.equal(wiki.projects[0].metadata.ok, true, 'wiki 表格应该被验通')
    assert.equal(wiki.projects[0].records.ok, true)

    // ② 普通表格链接：抠出 /sheets/<token> 那一段。
    seen.length = 0
    const plain = await probeWithLink('https://x.feishu.cn/sheets/shtcnPlain?sheet=sh1')
    assert.ok(
      seen.some((p) => p.includes('/sheets/v3/spreadsheets/shtcnPlain/sheets/query')),
      `普通链接要抠出 shtcn 段：${seen.join(' | ')}`,
    )
    assert.equal(plain.projects[0].metadata.ok, true)
    // 报表里给人看的 table 也要是裸 token，不是一坨 URL。
    assert.equal(plain.projects[0].table, 'shtcnPlain')
  })

  await check('体检：appToken 里装的是 wiki 节点的电子表格时，不能按多维表格问（1254003 要能降级）', async () => {
    // 真机事故（2026-11-10）：面板「工单表链接」贴一条 /wiki/<token>，宿主把**裸 wiki token**
    // 写进 match.appToken（节点背后既可能是多维表格也可能是电子表格）。探针以前看到
    // appToken 非空就按多维表格问 bitable/v1/apps/<token>/tables，电子表格必然回
    // 1254003 WrongBaseToken —— 于是**扫票明明是 73 张，体检却报红**，人被引去改配置。
    const seen = []
    const fakeFeishu = async (url) => {
      const u = new URL(String(url))
      const path = u.pathname + u.search
      seen.push(path)
      const json = (body) => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => body,
        text: async () => JSON.stringify(body),
      })
      if (u.pathname.endsWith('/tenant_access_token/internal')) return json({ code: 0, tenant_access_token: 't-1' })
      // wiki 节点说：我是电子表格（obj_type: sheet），我的 obj_token 是 shtcnObjTok。
      if (u.pathname.endsWith('/wiki/v2/spaces/get_node')) {
        return json({ code: 0, data: { node: { obj_type: 'sheet', obj_token: 'shtcnObjTok' } } })
      }
      // 多维表格接口对这个 token 回「你拿错类型了」（HTTP 200 + 业务码，飞书就是这么回的）。
      if (/\/bitable\/v1\/apps\/[^/]+\/tables$/.test(u.pathname)) {
        return json({ code: 1254003, msg: 'WrongBaseToken' })
      }
      if (/\/sheets\/v3\/spreadsheets\/[^/]+\/sheets\/query$/.test(u.pathname)) {
        return json({ code: 0, data: { sheets: [{ sheet_id: 'sh1', title: 'Sheet1' }] } })
      }
      if (/\/sheets\/v2\/spreadsheets\/[^/]+\/values\//.test(u.pathname)) {
        return json({ code: 0, data: { valueRange: { values: [['序号'], ['1']] } } })
      }
      return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({ code: 404 }), text: async () => '{"code":404}' }
    }

    // appToken 装的是裸 wiki token（面板贴链接后的真实形态），没有 spreadsheetToken。
    const out = await probeFeishuConnectivity({
      appId: 'cli_app',
      appSecret: 's',
      projects: [{ name: 'pms', match: { platform: 'feishu', appToken: 'wikcnNodeTok' } }],
      fetch: fakeFeishu,
    })
    const project = out.projects[0]
    assert.ok(seen.some((p) => p.includes('/bitable/v1/apps/wikcnNodeTok/tables')), `要先按多维表格试一次：${seen.join(' | ')}`)
    assert.equal(project.kind, 'sheet', `1254003 是「类型不对」，应该降级认成电子表格：${JSON.stringify(project)}`)
    // 裸 wiki token 本身就能当 spreadsheetToken 用（实测 2026-11-10），
    // 所以降级时直接用手里这个 token 查，不必先多调一次 get_node —— 少一次往返。
    assert.ok(
      seen.some((p) => p.includes(`/sheets/v3/spreadsheets/wikcnNodeTok/sheets/query`)),
      `降级后要查工作表：${seen.join(' | ')}`,
    )
    assert.equal(project.metadata.ok, true, '电子表格应该能验通（不能报 1254003）')
    assert.equal(project.records.ok, true)
    assert.ok(!JSON.stringify(project).includes('1254003'), '成功时不该把 1254003 漏进报告')

    // 真故障不能降级：凭据错还是凭据错，换条路只会把真因埋掉。
    seen.length = 0
    const badAuth = await probeFeishuConnectivity({
      appId: 'cli_app',
      appSecret: 's',
      projects: [{ name: 'pms', match: { platform: 'feishu', appToken: 'wikcnNodeTok' } }],
      fetch: async (url) => {
        const u = new URL(String(url))
        seen.push(u.pathname)
        const json = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) })
        if (u.pathname.endsWith('/tenant_access_token/internal')) return json({ code: 0, tenant_access_token: 't-1' })
        if (u.pathname.endsWith('/wiki/v2/spaces/get_node')) return json({ code: 0, data: { node: { obj_type: 'bitable', obj_token: 'bascnTok' } } })
        return json({ code: 99991663, msg: 'tenant token invalid' })
      },
    })
    assert.equal(badAuth.projects[0].metadata.ok, false, '凭据错要报失败，不能假装成功')
    assert.ok(
      !seen.some((p) => p.includes('/sheets/')),
      `凭据错不该再试电子表格：${seen.join(' | ')}`,
    )
  })

  await check('体检：状态值跟表里实际值对不上时要明说（全绿却收不到票的头号原因）', async () => {
    // 真机事故（2026-11-10）：权限、表、数据全绿，却一张票都收不到 —— 因为缺省只认
    // 「处理中」（`IN_PROGRESS_VALUE`），而这张表的「是否处理」实际填的是「是 / 否」。
    // 实测同一张表：statusValues=['处理中'] 收 0 张、['是'] 收 73 张。
    // 体检以前只看「读不读得到数据」，所以这种情况一片绿，人只能去翻文档猜。
    const makeFetch = (values) => async (url) => {
      const u = new URL(String(url))
      const json = (body) => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => body,
        text: async () => JSON.stringify(body),
      })
      if (u.pathname.endsWith('/tenant_access_token/internal')) return json({ code: 0, tenant_access_token: 't-1' })
      if (/\/sheets\/v3\/spreadsheets\/[^/]+\/sheets\/query$/.test(u.pathname)) {
        return json({ code: 0, data: { sheets: [{ sheet_id: 'sh1', title: 'Sheet1' }] } })
      }
      if (/\/sheets\/v2\/spreadsheets\/[^/]+\/values\//.test(u.pathname)) {
        return json({ code: 0, data: { valueRange: { values } } })
      }
      return { ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({ code: 404 }), text: async () => '{"code":404}' }
    }
    const rows = [['序号', '问题描述', '是否处理'], ['1', '某某问题', '是'], ['2', '另一个问题', '否']]

    // ① 配置认「处理中」，表里是「是 / 否」→ 必须点出来，并给出修法。
    const bad = await probeFeishuConnectivity({
      appId: 'cli_app',
      appSecret: 's',
      projects: [{ name: 'pms', match: { platform: 'feishu', spreadsheetToken: 'shtcnSheet', statusValues: ['处理中'] } }],
      fetch: makeFetch(rows),
    })
    const badProject = bad.projects[0]
    assert.equal(badProject.metadata.ok, true, '这一层不是权限问题，元数据该是通的')
    assert.equal(badProject.records.ok, true, '数据也读得到')
    assert.equal(badProject.statusValues?.ok, false, `状态值对不上要报出来：${JSON.stringify(badProject)}`)
    assert.deepEqual(badProject.statusValues.values, ['是', '否'], '要把表里实际出现的值原样摆出来')
    assert.ok(badProject.statusValues.message.includes('一张票都收不到'), `要说清后果：${badProject.statusValues.message}`)
    assert.ok(badProject.statusValues.fix.includes('是'), `修法要给出具体该填什么：${badProject.statusValues.fix}`)

    // ② 配对了就该是绿的，并且把「表里出现什么」也带上（人一眼能确认自己没配错）。
    const good = await probeFeishuConnectivity({
      appId: 'cli_app',
      appSecret: 's',
      projects: [{ name: 'pms', match: { platform: 'feishu', spreadsheetToken: 'shtcnSheet', statusValues: ['是'] } }],
      fetch: makeFetch(rows),
    })
    assert.equal(good.projects[0].statusValues?.ok, true, '配对了不该误报')
    assert.ok(good.projects[0].statusValues.message.includes('对得上'), good.projects[0].statusValues.message)

    // ③ 认不出状态列时闭嘴，别在这里再报一个错 —— 列映射那层报得更清楚。
    const noColumn = await probeFeishuConnectivity({
      appId: 'cli_app',
      appSecret: 's',
      projects: [{ name: 'pms', match: { platform: 'feishu', spreadsheetToken: 'shtcnSheet', statusValues: ['处理中'] } }],
      fetch: makeFetch([['序号', '问题描述'], ['1', '某某问题']]),
    })
    assert.equal(noColumn.projects[0].statusValues, undefined, '认不出状态列就不该下结论')
  })

  await check('体检：状态值对不上只进提醒，不进阻断（收不到票不等于流水线坏了）', async () => {
    const tool = createPipelineDoctorTool({
      ...NO_VERSION_CHECK,
      gitRunner: async (argv) => ({ code: 0, stdout: argv[0] === '--version' ? 'git version 2.45.1' : (argv[0] === 'status' ? '' : 'true'), stderr: '' }),
      getConfig: () => ({
        enabled: true,
        projects: [{ name: 'pms', match: { platform: 'feishu', appToken: 'shtcn', sheetId: 'sh1' }, repo: { path: 'D:/repo/pms' } }],
        workExecutor: 'agent',
        pushAdapter: 'mock',
      }),
      credentials: { describe: async () => ({ configured: true }) },
      readSecret: async () => 'x',
      probeFeishu: async () => ({
        skipped: false,
        token: { ok: true, message: 'token 有效' },
        projects: [{
          name: 'pms',
          kind: 'sheet',
          table: 'shtcn',
          metadata: { ok: true, message: '能读到电子表格元数据（1 个工作表）' },
          records: { ok: true, message: '能读到第一页数据（100 行）' },
          statusValues: { ok: false, values: ['是', '否'], expected: ['处理中'], message: '状态列里没有一个是配置认的值', fix: '把「在处理中的状态值」改成「是」。' },
        }],
      }),
    })
    const out = await tool.execute({}, {})
    assert.ok(out.warnings.some((w) => w.includes('状态列里没有一个是配置认的值')), `要进提醒档：${JSON.stringify(out.warnings)}`)
    assert.ok(out.warnings.some((w) => w.includes('改成「是」')), '提醒里要带修法')
    assert.equal(out.ok, true, '这不该让整份体检判定为不可用')
    assert.equal(out.blockers.length, 0, '不该进阻断档')
    assert.ok(out.text.includes('状态值对不上'), `正文也要看得见：${out.text}`)
  })

  // 比对逻辑本身：拿内存假文件系统把每种分支都走一遍（不碰真实磁盘）。
  await check('plugin-version：profile 声明解析与链接安装识别', async () => {
    // profile 的 package.json 只认 file:/link:，版本号形态说明来自 registry。
    assert.deepEqual(
      readLocalDependency('{"dependencies":{"@local/ticket-pipeline":"file:D:/src/plugins/ticket-pipeline"}}', '@local/ticket-pipeline'),
      { kind: 'file', specPath: 'D:/src/plugins/ticket-pipeline' },
    )
    assert.deepEqual(
      readLocalDependency('{"devDependencies":{"@local/x":"link:../x"}}', '@local/x'),
      { kind: 'link', specPath: '../x' },
    )
    assert.equal(readLocalDependency('{"dependencies":{"@local/x":"^1.0.0"}}', '@local/x'), null, '版本号形态没有本地源码可比')
    assert.equal(readLocalDependency('{"dependencies":{}}', '@local/x'), null)
    assert.equal(readLocalDependency('not json', '@local/x'), null, '坏 JSON 不能抛')
    assert.equal(readLocalDependency('{"dependencies":{"@local/x":"workspace:*"}}', '@local/x'), null, 'workspace: 不是本地目录')

    // 相对路径按 profile 目录解析；盘符绝对路径原样用。
    assert.ok(resolveSpecPath('C:/p', 'D:/src').toUpperCase().startsWith('D:'), '盘符绝对路径要原样用')
    assert.ok(resolveSpecPath('C:/p', '../x').replace(/\\/g, '/').endsWith('/x'), '相对路径要按 profile 目录解析')
    assert.ok(!resolveSpecPath('C:/p', '../x').includes('..'), '解析完不该还留着 ..')

    // 安装路径 → profile 路径：往上是 scope、node_modules、profile。
    const profileDir = profileDirFromInstalledDir('C:/p/node_modules/@local/x').replace(/\\/g, '/')
    assert.equal(profileDir, 'C:/p')

    // 模块 URL → 插件根：src/core/xxx.js 往上两级。
    assert.equal(pluginRootFromModuleUrl('file:///D:/src/plugins/ticket-pipeline/src/core/plugin-version.js').replace(/\\/g, '/'), 'D:/src/plugins/ticket-pipeline')
  })

  await check('plugin-version：能比出内容差异、缺文件、多文件', async () => {
    /** 造一个内存假文件系统：{ 绝对路径: 内容 } 与 { 绝对路径: [子项] }。 */
    const makeIo = (files, dirs) => ({
      async readFile (path) {
        const key = String(path).replace(/\\/g, '/')
        if (!(key in files)) throw new Error(`ENOENT: ${key}`)
        return files[key]
      },
      async readdir (path) {
        const key = String(path).replace(/\\/g, '/')
        if (!(key in dirs)) throw new Error(`ENOENT: ${key}`)
        return dirs[key]
      },
      async realpath (path) { return String(path).replace(/\\/g, '/') },
    })

    const src = 'D:/src/plugins/ticket-pipeline'
    const ins = 'C:/p/node_modules/@local/ticket-pipeline'
    const dir = (names) => names.map((name) => ({ name, isDirectory: !name.includes('.') }))

    const files = {
      // 源码
      [`${src}/src/index.js`]: 'export const a = 1\n',
      [`${src}/src/core/stale.js`]: 'export const b = 1\n',
      [`${src}/src/core/missing.js`]: 'export const c = 1\n',
      [`${src}/cordis.patch.yml`]: 'insert: []\n',
      [`${src}/icon.svg`]: '<svg/>\n',
      [`${src}/locale/zh.json`]: '{"a":1}\n',
      // 副本：index.js 一致、stale.js 内容不同（且是 CRLF，要被视为相同行尾而非差异）、
      // missing.js 不存在、多出一个 old.js、README 不参与比对。
      [`${ins}/src/index.js`]: 'export const a = 1\n',
      [`${ins}/src/core/stale.js`]: 'export const b = 2\n',
      [`${ins}/src/core/old.js`]: 'export const gone = 1\n',
      [`${ins}/cordis.patch.yml`]: 'insert: []\r\n',
      [`${ins}/icon.svg`]: '<svg/>\n',
      [`${ins}/locale/zh.json`]: '{"a":1}\n',
      [`${ins}/README.md`]: '# 文档变了不算落后\n',
    }
    const dirs = {
      [`${src}`]: [
        { name: 'src', isDirectory: true },
        { name: 'locale', isDirectory: true },
        { name: 'cordis.patch.yml', isDirectory: false },
        { name: 'icon.svg', isDirectory: false },
      ],
      [`${src}/src`]: [{ name: 'index.js', isDirectory: false }, { name: 'core', isDirectory: true }],
      [`${src}/src/core`]: [{ name: 'stale.js', isDirectory: false }, { name: 'missing.js', isDirectory: false }],
      [`${src}/locale`]: [{ name: 'zh.json', isDirectory: false }],
      [`${ins}`]: [
        { name: 'src', isDirectory: true },
        { name: 'locale', isDirectory: true },
        { name: 'cordis.patch.yml', isDirectory: false },
        { name: 'icon.svg', isDirectory: false },
        { name: 'README.md', isDirectory: false },
      ],
      [`${ins}/src`]: [{ name: 'index.js', isDirectory: false }, { name: 'core', isDirectory: true }],
      [`${ins}/src/core`]: [{ name: 'stale.js', isDirectory: false }, { name: 'old.js', isDirectory: false }],
      [`${ins}/locale`]: [{ name: 'zh.json', isDirectory: false }],
    }

    const result = await comparePluginTrees({ sourceDir: src, installedDir: ins, io: makeIo(files, dirs) })
    assert.equal(result.ok, true, `比对该成功：${result.reason}`)
    assert.equal(result.linked, false)
    assert.deepEqual(result.stale, ['src/core/stale.js'], `只有内容真不同的才算旧：${JSON.stringify(result.stale)}`)
    assert.deepEqual(result.missing, ['src/core/missing.js'], '源码有、副本没有 = 缺')
    assert.deepEqual(result.extra, ['src/core/old.js'], '副本有、源码没有 = 多（旧模块留着照样会被 import）')
    assert.ok(result.checked > 0, '要记一共比了几个')
    assert.notEqual(result.sourceFingerprint, result.installedFingerprint, '不一致时两个指纹必须不同')
    assert.equal(needsUpdate(result), true, '有差异就要更新')

    // 行尾差异不算差异：robocopy / git clone 会给出 CRLF，内容其实一样。
    assert.equal(normalizeForCompare('a\r\nb'), 'a\nb')
    assert.equal(normalizeForCompare('a\nb'), 'a\nb')
    assert.notEqual(normalizeForCompare('a\nb'), normalizeForCompare('a\n b'), '空白差异仍算差异')

    // 完全一致时指纹相同、不需要更新。
    // 造法：源码那一份照旧，副本那一份**逐字复制源码内容**（清单也照源码的，
    // 免得副本多出来的 old.js 让「一致」这句话失真）。
    const sameFiles = { ...files }
    for (const [key, value] of Object.entries(files)) {
      if (key.startsWith(src)) sameFiles[`${ins}${key.slice(src.length)}`] = value
    }
    delete sameFiles[`${ins}/README.md`]
    const sameDirs = {
      ...dirs,
      [`${ins}/src/core`]: [{ name: 'stale.js', isDirectory: false }, { name: 'missing.js', isDirectory: false }],
    }
    const identical = await comparePluginTrees({
      sourceDir: src,
      installedDir: ins,
      io: makeIo(sameFiles, sameDirs),
    })
    assert.equal(identical.ok, true, `一致场景的比对也该成功：${identical.reason}`)
    assert.deepEqual(identical.stale, [])
    assert.deepEqual(identical.missing, [])
    assert.deepEqual(identical.extra, [])
    assert.equal(identical.sourceFingerprint, identical.installedFingerprint, '内容一致时指纹必须相同')
    assert.equal(needsUpdate(identical), false, '一致就不该催更新')

    // 指纹对内容敏感、对顺序稳定。
    assert.equal(fingerprintOfEntries([{ path: 'a.js', text: 'x' }]), fingerprintOfEntries([{ path: 'a.js', text: 'x' }]))
    assert.notEqual(fingerprintOfEntries([{ path: 'a.js', text: 'x' }]), fingerprintOfEntries([{ path: 'a.js', text: 'y' }]))
    assert.notEqual(fingerprintOfEntries([{ path: 'a.js', text: 'xy' }]), fingerprintOfEntries([{ path: 'a.js', text: 'x' }, { path: 'b.js', text: 'y' }]), '路径也要参与指纹')
  })

  await check('plugin-version：链接安装 / 目录不存在 / 声明缺失都不抛', async () => {
    const src = 'D:/src/plugins/ticket-pipeline'
    const ins = 'C:/p/node_modules/@local/ticket-pipeline'
    const io = {
      async readFile (path) {
        const key = String(path).replace(/\\/g, '/')
        if (key === 'C:/p/package.json') return '{"dependencies":{"@local/ticket-pipeline":"file:D:/src/plugins/ticket-pipeline"}}'
        throw new Error(`ENOENT: ${key}`)
      },
      async readdir (path) {
        const key = String(path).replace(/\\/g, '/')
        if (key === `${src}/src`) return [{ name: 'index.js', isDirectory: false }]
        if (key === `${ins}/src`) return [{ name: 'index.js', isDirectory: false }]
        throw new Error(`ENOENT: ${key}`)
      },
      // 副本是源码的链接：realpath 归一后相同，必须判成「改完即生效」。
      async realpath (path) { return String(path).replace(/\\/g, '/').replace(ins, src) },
    }
    const linked = await comparePluginTrees({ installedDir: ins, io })
    assert.equal(linked.ok, true, `链接安装该判成功：${linked.reason}`)
    assert.equal(linked.linked, true, '要认出是链接')
    assert.equal(needsUpdate(linked), false, '链接安装永远不需要更新')

    // profile 里没有本地来源声明（例如从 registry 装的）：说明原因，别抛。
    const noDecl = await comparePluginTrees({
      installedDir: ins,
      io: {
        async readFile () { return '{"dependencies":{"@local/ticket-pipeline":"1.0.0"}}' },
        async readdir () { throw new Error('不该走到这') },
        async realpath (path) { return path },
      },
    })
    assert.equal(noDecl.ok, false)
    assert.ok(noDecl.reason.includes('file:/link:'), `要说清为什么比不了：${noDecl.reason}`)
    assert.equal(needsUpdate(noDecl), false, '比不出来不能说它落后')

    // profile 的 package.json 读不到。
    const noManifest = await comparePluginTrees({
      installedDir: ins,
      io: {
        async readFile () { throw new Error('ENOENT: package.json') },
        async readdir () { throw new Error('不该走到这') },
        async realpath (path) { return path },
      },
    })
    assert.equal(noManifest.ok, false)
    assert.ok(noManifest.reason.includes('package.json'), `要指出读不到哪个文件：${noManifest.reason}`)

    // 源码目录根本列不出来。
    const noSource = await comparePluginTrees({
      installedDir: ins,
      sourceDir: 'D:/nope',
      io: {
        async readFile () { throw new Error('ENOENT') },
        async readdir () { throw new Error('ENOENT: 目录不存在') },
        async realpath (path) { return path },
      },
    })
    assert.equal(noSource.ok, false)
    assert.ok(noSource.reason.length > 0, '失败必须带原因，不能只是 ok:false')

    // 空源码目录（配错路径）：说清是路径可能配错了，而不是「一致」。
    const emptySource = await comparePluginTrees({
      installedDir: ins,
      sourceDir: src,
      io: {
        async readFile () { throw new Error('ENOENT') },
        async readdir () { return [] },
        async realpath (path) { return path },
      },
    })
    assert.equal(emptySource.ok, false)
    assert.ok(emptySource.reason.includes('配错'), `空目录要说可能是路径配错：${emptySource.reason}`)
  })

  await check('plugin-version：listComparedFiles 只收会加载的文件', async () => {
    // README.md、scripts/ 变了不影响行为 —— 报出来只会让人以为必须重装。
    const root = 'D:/p'
    const io = async (path) => {
      const key = String(path).replace(/\\/g, '/')
      if (key === root) {
        // 根目录决定单文件清单：icon.svg 这里故意不给，验证「只有真存在的才比」。
        return [
          { name: 'src', isDirectory: true },
          { name: 'lib', isDirectory: true },
          { name: 'locale', isDirectory: true },
          { name: 'cordis.patch.yml', isDirectory: false },
          { name: 'README.md', isDirectory: false },
        ]
      }
      if (key === `${root}/src`) return [{ name: 'index.js', isDirectory: false }, { name: 'core', isDirectory: true }, { name: 'README.md', isDirectory: false }]
      if (key === `${root}/src/core`) return [{ name: 'a.js', isDirectory: false }, { name: 'b.ts', isDirectory: false }]
      if (key === `${root}/lib`) return [{ name: 'client.js', isDirectory: false }]
      if (key === `${root}/locale`) return [{ name: 'zh.json', isDirectory: false }, { name: 'notes.txt', isDirectory: false }]
      throw new Error(`ENOENT: ${key}`)
    }
    const listed = await listComparedFiles(root, io)
    assert.deepEqual(listed, [
      'cordis.patch.yml',
      'lib/client.js',
      'locale/zh.json',
      'src/core/a.js',
      'src/index.js',
    ], `要比的文件清单：${JSON.stringify(listed)}`)
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
    const out = await tool.execute({ view: 'tickets', includeDone: true }, {})

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

  await check('model 与 provider 默认都留空（跟随会话默认），不钉死会被限流的模型/provider', async () => {
    // 真实事故一：插件把 model 钉成 deepseek-v4.1-flash，那天上游配额耗尽，
    // 整条流水线每一张票都死在「模型调用失败」上。留空 = 跟随宿主当前选择。
    // 真实事故二：provider 缺省写成 'workbuddy'，换一台宿主（没有这个 provider）
    // 之后每一张票都在建会话那一步炸；而且面板上「留空跟随默认」永远填不出来
    // —— draftValueOf 会把空值回落成 meta.default。所以默认值必须是空串。
    const { value: config } = validateConfig({})
    assert.equal(config.model, '', 'model 默认应当是空串（空串在执行器里表示「不下发模型参数」）')
    assert.equal(config.provider, '', 'provider 默认应当是空串（空串 = 跟随当前会话默认）')
    // 空串不能变成「下发一个空 provider」：执行器必须整条不写这个键。
    const { agentOptionsFromConfig } = await import('../src/adapters/executor-agent/index.js')
    assert.equal('provider' in agentOptionsFromConfig(config), false, 'provider 留空时不能给宿主下发空串')
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

  await check('appToken 只贴一条表格链接也能通过校验：table 从 ?table= 里补上（文档说「贴链接就够」必须真成立）', async () => {
    // 为什么这条重要：文档到处写着「appToken 可以直接写整条 URL，插件会自己啃出
    // app_token + table_id」。但要真成立，**配置校验器**也得认这个写法 ——
    // 只让适配器认得，用户贴一条链接进来会被「必须给 appToken+tableId 或 docNamePattern」拦在启动前。
    const url = 'https://vcn6ijgss3oy.feishu.cn/base/RZZQbY4SkaY6z0shZaBcVpQCnhh?table=tblWhRSGf0osJqrE&view=vewsyZldQC'
    const result = validateConfig({
      projects: [{ name: 'pms', match: { platform: 'feishu', appToken: url }, repo: { path: 'D:/repo' } }],
    })
    assert.ok(result.value, `贴整条链接应当通过校验，实际 issues：${JSON.stringify(result.issues ?? [])}`)
    assert.equal(result.value.projects[0].match.appToken, url, 'appToken 原值要留着，适配器还要从里面啃 app_token')

    // 只有 /base/<token> 没有 ?table=、又没给 docNamePattern → 仍然必须拦下（不能假装能定位）。
    const noTable = validateConfig({
      projects: [{ name: 'pms', match: { platform: 'feishu', appToken: 'https://x.feishu.cn/base/abcdef' }, repo: { path: 'D:/repo' } }],
    })
    assert.ok(noTable.issues, '链接里没有 table、也没有 docNamePattern 时该报错，而不是放行到运行时才炸')
    assert.match(JSON.stringify(noTable.issues), /docNamePattern/, '报错要说清还能怎么补（docNamePattern 兜底）')
  })

  await check('电子表格 token 只贴一条 wiki 链接也能过校验（面板只有一个「工单表链接」入口）', async () => {
    // 面板把三个入口（工单表组 / 飞书电子表格组 / 工单表链接行）并成了一个：
    // 用户贴进来的可能是 `/wiki/<token>`，而 wiki 链接**不带** `?table=` 或 `?sheet=`
    // —— 表型要运行时问 get_node 才知道。配置层要是硬要求 spreadsheetToken 必须配
    // sheetId，就等于「运行期能跑、配置层不让存」，逼人回去手改 YAML。
    const url = 'https://vcn6ijgss3oy.feishu.cn/wiki/It5gwQ9sMizJh0kdbDhc2rBfnug'
    const result = validateConfig({
      projects: [{ name: 'pms', match: { platform: 'feishu', spreadsheetToken: url }, repo: { path: 'D:/repo' } }],
    })
    assert.ok(result.value, `wiki 链接应当通过校验，实际 issues：${JSON.stringify(result.issues ?? [])}`)
    assert.equal(result.value.projects[0].match.spreadsheetToken, url, '原值要留着，适配器还要从里面抠 token')
  })

  await check('多维表格与电子表格两套 token 同时填：不拦，但要警告「另一套不起作用」', async () => {
    // 用户报的原话是「填来填去都填了，根本不清楚用的那个」。运行期 resolveTable()
    // 有明确优先级，所以不是错；但人看不出来 —— 必须有一条警告点名哪套生效。
    const result = validateConfig({
      projects: [{
        name: 'pms',
        match: {
          platform: 'feishu',
          appToken: 'bascnABCDEFGH',
          tableId: 'tblWhRSGf0osJqrE',
          spreadsheetToken: 'shtcnXYZ',
          sheetId: 'sh1',
        },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.ok(result.value, `两套并存不该被拦，实际 issues：${JSON.stringify(result.issues ?? [])}`)
    assert.ok(Array.isArray(result.warnings), 'warnings 要透到 validateConfig 顶层')
    assert.ok(
      result.warnings.some((w) => w.includes('两套') && w.includes('不起作用')),
      `要有「两套 token 并存」的警告，实际 ${JSON.stringify(result.warnings)}`,
    )
    // 点名的是哪一套生效：spreadsheetToken 存在时 resolveTable 走电子表格。
    assert.ok(
      result.warnings.some((w) => w.includes('电子表格')),
      '警告要说清实际按哪一套取工单',
    )
  })

  await check('tableId 与 sheetId 同时配：不拦，但要点出「两种表型各自的坐标」这个矛盾', async () => {
    // 真实事故（2026-11-11，pms 项目）：appToken 是裸 wiki token（背后是电子表格），
    // 却还留着上一轮多维表格的 tableId，再加上 sheetId。运行期 resolveTable() 按 token
    // 摸出真实表型这条路本身没坏，但「配了 tableId 就直接按多维表格定位」那条捷径
    // 曾让分派被抢走 —— scan 抛 WrongBaseToken，而体检说「能读」。
    // tableId 与 sheetId 不是两套并列的定位方式，而是两种表型各自的坐标，同时留着
    // 说明配置切换过没清干净。这条用例把「配置层要把它摆出来」钉死。
    const result = validateConfig({
      projects: [{
        name: 'pms',
        match: {
          platform: 'feishu',
          appToken: 'It5gwQ9sMizJh0kdbDhc2rBfnug',
          tableId: 'tblWhRSGf0osJqrE',
          sheetId: '3a5d28',
        },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.ok(result.value, `不该被拦，实际 issues：${JSON.stringify(result.issues ?? [])}`)
    assert.ok(
      result.warnings.some((w) => w.includes('tableId') && w.includes('sheetId')),
      `要有一条点名 tableId 与 sheetId 并存的警告，实际 ${JSON.stringify(result.warnings)}`,
    )
    assert.ok(
      result.warnings.some((w) => w.includes('两种表型各自的坐标')),
      '警告要解释清楚为什么这两个键不该同时出现（不是「两套方案」而是两种表型的坐标）',
    )
    // 只配一套时不该有这条警告，否则每次保存都冒一句无用的提醒。
    const clean = validateConfig({
      projects: [{
        name: 'pms',
        match: { platform: 'feishu', appToken: 'bascnABCDEFGH', tableId: 'tblWhRSGf0osJqrE' },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.ok(
      !(clean.warnings ?? []).some((w) => w.includes('两种表型各自的坐标')),
      `只配一套 tableId 时不该报这条，实际 ${JSON.stringify(clean.warnings)}`,
    )
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

  await check('recordIds 收窄对「内存水位型」源也成立：名单外的记录不会被判成「已删除」', async () => {
    // webform 源已从产品里移除（工单 #18：水位只在内存、重启就重收一遍），
    // 但它当年验证的这条契约对所有源都成立，所以实现搬到 scripts/fixtures/ 留档，
    // 用例继续跑 —— 不是「删测试过关」，是「测试对象从产品移到留档实现」。
    const { createWebformSource } = await import('./fixtures/source-webform/index.js')
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

  await check('webform 源已从产品里移除：PLATFORMS 不含它，老配置拿到的是迁移提示', async () => {
    const { PLATFORMS, REMOVED_PLATFORMS } = await import('../src/core/config.js')
    assert.equal(PLATFORMS.includes('webform'), false, 'webform 不该再出现在 PLATFORMS 里')
    assert.ok(REMOVED_PLATFORMS.webform, '已移除的平台要有迁移提示，不能只说「只能是 …」')
    // 组合根里也不该再有这个源（否则配置校验拒绝了、装配层却还留着死代码）。
    const { SOURCES } = await import('../src/index.js')
    assert.equal('webform' in SOURCES, false, 'SOURCES 里不该再有 webform')
    // 老配置：报错必须说得清「怎么改」，而不是「不认识这个词」。
    const result = validateConfig({
      projects: [{
        name: 'old',
        match: { platform: 'webform' },
        repo: { path: 'D:/repo' },
      }],
    })
    assert.equal(result.value, undefined, 'webform 配置应当被拒绝')
    const message = (result.issues ?? []).map((issue) => issue.message).join('\n')
    assert.match(message, /已移除/, '要说明它被移除了')
    assert.match(message, /mock/, '要给出可照做的替代（mock）')
    assert.match(message, /feishu/, '要给出可照做的替代（feishu）')
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

  section('15. 改代码落点：缺省在工作区检出里改（脏也能跑，只提交 agent 改的）')
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

  await check('describeDirtyCheckout：脏工作区只提醒不拒跑，文案要能照着理解', async () => {
    // 干净时什么都不说（不刷无意义的提示）。
    assert.equal(describeDirtyCheckout({ dirty: [] }, 'D:/repo'), undefined)
    assert.equal(describeDirtyCheckout(undefined, 'D:/repo'), undefined)

    const notice = describeDirtyCheckout({ dirty: ['M a.ts', '?? b.ts'] }, 'D:/repo')
    assert.equal(typeof notice, 'string', '不干净必须给出一句提醒')
    assert.ok(notice.includes('M a.ts'), `要点名具体文件：${notice}`)
    assert.ok(notice.includes('2 个未提交改动'), `要报出总数：${notice}`)
    assert.ok(notice.includes('照跑'), '这是「照跑」而不是拒跑')
    assert.ok(notice.includes('基线'), '要说明会拍基线')
    assert.ok(notice.includes('只提交 agent 真正改过的文件'), '要说明只提交 agent 改的')
    assert.ok(notice.includes('原样留在工作区'), '人得知道自己那些改动不会被带走')

    // 超过 10 个文件时不能把整张清单铺出来。
    const many = Array.from({ length: 13 }, (_, i) => `M f${i}.ts`)
    const long = describeDirtyCheckout({ dirty: many }, 'D:/repo')
    assert.ok(long.includes('13 个未提交改动'), `要报出真实总数：${long}`)
    assert.ok(long.includes('等 13 个'), `超量要折叠：${long}`)
    assert.ok(!long.includes('M f12.ts'), '第 11 个之后的文件名不该出现')
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

  section('16. 处理完回填工单表 + 保留工作区会话')

  await check('跑成 done → 回填表格：是否处理 / 处理结果 / 处理日期三列都写', async () => {
    // 用户 2026-11-06 的口径：改完需求要把「处理中」改成「是」，并写明怎么处理的、
    // 哪天处理的。这条钉住「真的调了 writeResult，且三列都给了」。
    const { scheduler, store, source } = harness()
    await scheduler.tick()

    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'done')
    assert.deepEqual(source.writes.length, 1, 'done 必须回填一次')
    const write = source.writes[0]
    assert.equal(write.recordId, 'rec-mock-001')
    assert.equal(write.status, '是', '「是否处理」缺省写「是」')
    assert.ok(Number.isFinite(write.handledAt) && write.handledAt > 0, '「处理日期」要是毫秒时间戳')
    assert.ok(write.result.includes('已按工单改完并提交'), `处理结果要说清做了什么：${write.result}`)
    assert.ok(write.result.includes('本地提交：'), '处理结果里要写提交在哪')
    assert.ok(write.result.includes('要进一步修改'), '要告诉人怎么重跑')

    assert.equal(row.writeBack?.written, true, '票据上要记下回填成功')
    assert.ok(Array.isArray(row.writeBack.fields) && row.writeBack.fields.length === 3, '要记下写了哪三列')
  })

  await check('回填的「是否处理」值可配：writeBackStatus 说了算，空白回落「是」', async () => {
    const custom = createMockSource()
    const { scheduler: s1 } = harness({
      source: custom,
      config: { writeBackStatus: '已完成' },
      prepareWorkspace: async () => ({ path: 'D:/wt/a', branch: 'b-a', baseCommit: 'c-a' }),
    })
    await s1.tick()
    assert.equal(custom.writes[0].status, '已完成', '配置项要能换成「已完成」这种表常用值')

    const blank = createMockSource()
    const { scheduler: s2 } = harness({
      source: blank,
      config: { writeBackStatus: '   ' },
      prepareWorkspace: async () => ({ path: 'D:/wt/b', branch: 'b-b', baseCommit: 'c-b' }),
    })
    await s2.tick()
    assert.equal(blank.writes[0].status, '是', '空白要回落「是」，不能写一个空单元格')
  })

  await check('writeBack=false 就完全不写表格（退化成只读）', async () => {
    const source = createMockSource()
    const { scheduler, store } = harness({ source, config: { writeBack: false } })
    await scheduler.tick()
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'done')
    assert.equal(source.writes.length, 0, '关掉开关就一个写请求都不许发')
    assert.equal(row.writeBack, undefined, '不写就别记回执')
  })

  await check('failed 的票不回填：表里那一行留在「处理中」是刻意留的信号', async () => {
    // 失败也写「是」会让人以为处理完了 —— 这个信号比「表格字段整齐」重要得多。
    const source = createMockSource()
    const { scheduler, store } = harness({ source, executor: createMockExecutor({ outcome: 'failed' }) })
    await scheduler.tick()
    assert.equal(store.getTicket(k('rec-mock-001')).phase, 'failed')
    assert.equal(source.writes.length, 0, '失败的票绝不能回填')
  })

  await check('回填失败只记在票据上，票态不回退、不影响通知', async () => {
    // 回填是「改完之后的附加动作」。表结构对不上（缺列）、应用没写权限 —— 这些都
    // 不该把一张已经改完的票判成失败，但也不能让「表没更新」无声无息。
    const source = createMockSource()
    source.setFailWrite(true)
    const { scheduler, store, push } = harness({ source })
    await scheduler.tick()

    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'done', '回填失败不能把票拖回 failed')
    assert.equal(row.writeBack?.written, false, '要记下「没写成」')
    assert.match(row.writeBack.note ?? '', /network|模拟回填失败/, `要留下失败原因：${row.writeBack?.note}`)
    assert.equal(push.messages.length, 1, '通知照发')
  })

  await check('工单源没提供 writeResult（老适配器）时静默跳过，不报错', async () => {
    // 契约里 writeResult 是可选方法：第三方适配器没实现它，流水线照样要跑。
    const source = createMockSource()
    delete source.writeResult
    const { scheduler, store } = harness({ source })
    await scheduler.tick()
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'done', '缺写回能力不该让票失败')
    assert.equal(row.writeBack, undefined)
  })

  await check('执行器返回 sessionId → 落到票据上，状态里能看到去哪找会话', async () => {
    // 「处理完保留会话」的另一半：得把 sessionId 记下来，否则人根本找不到那次会话。
    const withSession = {
      id: 'with-session',
      async run (ticket, target, ctx) {
        await ctx.onPhase('editing')
        await ctx.onPhase('testing')
        await ctx.onPhase('mr-opening')
        return makeExecResult({
          phase: 'done',
          changedFiles: [],
          testOutcome: 'passed',
          commit: { sha: 'mocksession1', branch: ctx.branch ?? '', files: [] },
          sessionId: 'ticket-demo-rec-session-1',
        })
      },
    }
    const { scheduler, store } = harness({ executor: withSession })
    await scheduler.tick()
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.sessionId, 'ticket-demo-rec-session-1', '会话 id 要存下来')

    const tool = createPipelineStatusTool({ store, getConfig: () => validateConfig({}).value })
    const out = await tool.execute({ view: 'tickets', includeDone: true }, {})
    assert.match(out.text, /处理会话：ticket-demo-rec-session-1/, `状态里要指出会话在哪：${out.text}`)
    assert.equal(out.tickets[0].sessionId, 'ticket-demo-rec-session-1', '返回体也要带 sessionId')
  })

  await check('pipeline_status：回填结果成功/失败都要能一眼看到', async () => {
    const rows = [
      { key: k('r-ok'), projectId: DEMO, recordId: 'r-ok', phase: 'done', attempt: 0, writeBack: { written: true, fields: ['是否处理', '处理结果', '处理日期'], at: 1 } },
      { key: k('r-no'), projectId: DEMO, recordId: 'r-no', phase: 'done', attempt: 0, writeBack: { written: false, note: 'auth: 应用没有写权限' } },
    ]
    const tool = createPipelineStatusTool({ store: { listTickets: () => rows }, getConfig: () => validateConfig({}).value })
    const out = await tool.execute({ view: 'tickets', includeDone: true }, {})
    assert.match(out.text, /回填表格：成功（是否处理、处理结果、处理日期）/, `成功要写清三列：${out.text}`)
    assert.match(out.text, /回填表格：没写成 —— auth: 应用没有写权限/, `失败要带原因：${out.text}`)
  })

  // #05：以前 pipeline_status 每票只给一个 sha，人要 review 还得离开 GUI 去敲 git show。
  // 下面三条覆盖：解析器（含 rename / 二进制）、describeCommit 的降级、以及
  // 「pipeline_status 里真的多渲了改动摘要」。
  section('16a. 改动摘要：pipeline_status 直接告诉人「这次改了什么」')

  await check('parseShowSummaryZ：raw + numstat 两段合并，rename 与二进制都不出错', async () => {
    // 真机输出形态（本机 git 2.45 实测）：先全部 raw 记录，再全部 numstat 记录，
    // 段间只有 NUL 没有换行；rename 在 raw 段是「状态/旧/新」，在 numstat 段是
    // `0\t0\t` + 空串 + 旧 + 新。二进制是 `-\t-\tpath`。
    const stdout = [
      ':100644 100644 2ae8088 4e8b263 M', 'README.md',
      ':100644 000000 ba077a4 0000000 D', 'b.txt',
      ':100644 100644 e64015c e64015c R100', 'a.txt', 'c.txt',
      ':000000 100644 0000000 fa49b07 A', 'd.txt',
      ':000000 100644 0000000 abc1234 A', 'logo.png',
      '1\t1\tREADME.md',
      '0\t1\tb.txt',
      '0\t0\t', 'a.txt', 'c.txt',
      '18\t0\td.txt',
      '-\t-\tlogo.png',
      '',
    ].join('\0')
    const files = parseShowSummaryZ(stdout)
    assert.equal(files.length, 5, `五个文件都要认出来：${JSON.stringify(files)}`)
    assert.deepEqual(
      files.map((f) => [f.status, f.path, f.insertions, f.deletions, f.binary === true]),
      [
        ['update', 'README.md', 1, 1, false],
        ['delete', 'b.txt', 0, 1, false],
        ['move', 'c.txt', 0, 0, false],
        ['create', 'd.txt', 18, 0, false],
        ['create', 'logo.png', undefined, undefined, true],
      ],
      `状态/路径/行数都要对上：${JSON.stringify(files)}`,
    )
    assert.equal(files[2].from, 'a.txt', 'rename 要保留旧路径')
    // 空输出（空提交）不能炸。
    assert.deepEqual(parseShowSummaryZ(''), [])
    assert.deepEqual(parseShowSummaryZ(undefined), [])
  })

  await check('describeCommit：一次调用拿全、逐文件上限截断、取不到就降级不抛', async () => {
    const calls = []
    const fakeSpawn = (stdout, code = 0, stderr = '') => async (argv, opts) => {
      calls.push({ argv, opts })
      return { code, stdout, stderr }
    }
    const stdout = [
      ':100644 100644 1 2 M', 'a.js',
      ':100644 100644 3 4 M', 'b.js',
      '10\t2\ta.js',
      '30\t4\tb.js',
      '',
    ].join('\0')
    const one = await describeCommit({ gitRunner: fakeSpawn(stdout), worktreePath: 'D:/repo', sha: 'abc123' })
    assert.equal(one.ok, true)
    assert.equal(one.fileCount, 2)
    assert.equal(one.insertions, 40, '总插入行数按 numstat 求和')
    assert.equal(one.deletions, 6)
    assert.equal(one.files[0].statusLabel, '修改', '状态要翻成中文，与 MR 描述同一套说法')
    assert.equal(calls.length, 1, `必须一次进程调用，实际 ${calls.length} 次`)
    assert.deepEqual(calls[0].argv.slice(0, 4), SHOW_SUMMARY_ARGS.slice(0, 4))
    assert.equal(calls[0].opts.cwd, 'D:/repo', '在改代码目录里跑')

    // 上限：超过 limit 只列前 limit 个，其余报个数。
    const many = []
    const manyNum = []
    for (let i = 0; i < 25; i += 1) {
      many.push(':100644 100644 1 2 M', `f${i}.js`)
      manyNum.push(`1\t1\tf${i}.js`)
    }
    const big = await describeCommit({
      gitRunner: fakeSpawn([...many, ...manyNum, ''].join('\0')), worktreePath: 'D:/repo', sha: 'abc',
    })
    assert.equal(big.fileCount, 25)
    assert.equal(big.files.length, COMMIT_SUMMARY_FILE_LIMIT, '逐文件最多列 20 个')
    assert.equal(big.truncated, true)
    assert.equal(big.hiddenCount, 5)

    // 三种「取不到」都要降级成 { ok:false }，不许抛：读不到摘要不该让整条 status 失败。
    const missing = await describeCommit({
      gitRunner: fakeSpawn('', 128, 'fatal: bad object abc\n'), worktreePath: 'D:/repo', sha: 'abc',
    })
    assert.equal(missing.ok, false)
    assert.match(missing.reason, /bad object/, `要带上 git 的原话：${missing.reason}`)
    assert.equal((await describeCommit({ gitRunner: fakeSpawn(''), worktreePath: '', sha: 'abc' })).ok, false, '没目录要降级')
    assert.equal((await describeCommit({ gitRunner: null, worktreePath: 'D:/repo', sha: 'abc' })).ok, false, '没 git 链路要降级')
    assert.equal((await describeCommit({ gitRunner: fakeSpawn(''), worktreePath: 'D:/repo', sha: '' })).ok, false, '没 sha 要降级')
    const boom = await describeCommit({
      gitRunner: async () => { throw new Error('spawn EPERM') }, worktreePath: 'D:/repo', sha: 'abc',
    })
    assert.equal(boom.ok, false, '执行器抛错也要降级')
    assert.match(boom.reason, /EPERM/)
  })

  await check('pipeline_status 每票多渲「改动摘要」，取不到时只多一行说明', async () => {
    const rows = [
      {
        key: k('r-sum'), projectId: DEMO, recordId: 'r-sum', phase: 'done', attempt: 0,
        worktreePath: 'D:/repo', commit: { sha: '3433b3a93e82abcdef', branch: 'v2.x' },
      },
      {
        key: k('r-nocommit'), projectId: DEMO, recordId: 'r-nocommit', phase: 'failed', attempt: 0,
        worktreePath: 'D:/repo', lastError: 'agent 没有产生任何文件改动',
      },
    ]
    const stdout = [':100644 100644 1 2 M', 'src/a.js', ':000000 100644 0 3 A', 'src/b.js', '42\t7\tsrc/a.js', '18\t0\tsrc/b.js', ''].join('\0')
    const tool = createPipelineStatusTool({
      store: { listTickets: () => rows },
      getConfig: () => validateConfig({}).value,
      gitRunner: async () => ({ code: 0, stdout, stderr: '' }),
      now: () => 1_000,
    })
    const out = await tool.execute({ view: 'tickets', includeDone: true }, {})
    assert.match(out.text, /改动摘要：2 个文件，\+60 \/ −7/, `要报总数：${out.text}`)
    assert.match(out.text, /\+42 \/ −7  src\/a\.js（修改）/, `要逐文件：${out.text}`)
    assert.match(out.text, /\+18 \/ −0  src\/b\.js（新增）/, `新增也要有标签：${out.text}`)
    assert.equal(out.tickets[0].commitSummary.fileCount, 2, '返回体带上机器可读摘要')
    assert.equal(out.tickets[1].commitSummary, null, '没有提交的票给 null，不是 undefined（lossless JSON）')

    // 取不到时：只有一行「取不到」，不抛、不刷屏，整条 status 照常完整。
    const brokenTool = createPipelineStatusTool({
      store: { listTickets: () => rows },
      getConfig: () => validateConfig({}).value,
      gitRunner: async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository\n' }),
      now: () => 1_000,
    })
    const broken = await brokenTool.execute({ view: 'tickets', includeDone: true }, {})
    assert.match(broken.text, /改动摘要：取不到（fatal: not a git repository）/, `要带原因：${broken.text}`)
    assert.match(broken.text, /已经收尾|失败了/, '其余内容仍要完整可读')
    assert.equal(broken.tickets[0].commitSummary.ok, false)

    // 压根没注入 gitRunner（宿主没有 git 链路）时也要能跑。
    const noGit = await createPipelineStatusTool({
      store: { listTickets: () => rows }, getConfig: () => validateConfig({}).value, now: () => 1_000,
    }).execute({ view: 'tickets', includeDone: true }, {})
    assert.match(noGit.text, /改动摘要：取不到（宿主没有可用的 git 执行链路）/, noGit.text)
  })

  await check('renderCommitSummary：没有摘要时一行都不多说', async () => {
    const lines = []
    renderCommitSummary(undefined, (line) => lines.push(line))
    renderCommitSummary(null, (line) => lines.push(line))
    assert.deepEqual(lines, [], 'failed 票不该多出空行或「取不到」噪音')
  })

  await check('skipped 的回填首句要说「待人工验证」，不能写成已完成', async () => {    // skipped 是「提交做了、验证没通过」。回填如果写成「已改完」，
    // 人看到表里那行「是」就不会再去看验证报告了。
    // 也不能写成「没跑通」这种否定式收尾（#01）——它是交付成功、待人工验证。
    const { scheduler, source } = harness({ executor: createMockExecutor({ outcome: 'skipped' }) })
    await scheduler.tick()
    assert.equal(source.writes.length, 1, 'skipped 也要回填')
    assert.match(source.writes[0].result, /待人工验证/, `首句要提示人工验证：${source.writes[0].result}`)
    assert.equal(/没跑通|未跑通|未验证/.test(source.writes[0].result), false, `不要用否定式收尾：${source.writes[0].result}`)
  })

  section('16b. 事后动作补偿（pendingEffects）与租约诚实化')

  await check('回填失败要在通知里说，不能只躺在日志里', async () => {
    // 回填是附加动作：表格没写成时票照样 done。人如果不主动去翻表格，
    // 就完全不知道「表里那行还停在处理中」—— 通知正文必须带上这一句。
    const source = createMockSource()
    source.setFailWrite(true)
    const { scheduler, push } = harness({ source })
    await scheduler.tick()

    assert.equal(push.messages.length, 1, '通知照发')
    const body = push.messages[0].body
    assert.match(body, /回填表格：没写成 —— /, `通知正文要写明回填失败：${body}`)
    assert.match(body, /模拟回填失败/, `要带上是哪一类失败：${body}`)
    assert.match(body, /手工改一下/, '要告诉人怎么补救')
  })

  await check('回填成功时通知里不写回填行（成功是预期行为，多一行只是噪音）', async () => {
    const { scheduler, push } = harness()
    await scheduler.tick()
    assert.equal(push.messages.length, 1)
    assert.doesNotMatch(push.messages[0].body, /回填表格/, `成功时不该有回填行：${push.messages[0].body}`)
  })

  // ── #08：交付维度 ────────────────────────────────────────────
  // 真机 reczz28VYQARkYBL：改动/验证/提交/通知全成，只有回填被飞书同步表挡住
  // （800074911 ConnectorSyncTableActionForbidden），而插件把整票判成「成功」，
  // 表格里那一行永远停在「处理中」。根因不是「忘了一条日志」，是模型缺一维：
  // phase 答「走到哪一站」，没有字段答「该交给人的东西交到了没有」。
  section('16c. 交付维度：票完了 ≠ 东西交到你手上了')

  await check('三个错误分类表互斥且覆盖全部 kind（别再造出「两张表都不在」的 aborted）', () => {
    for (const kind of ERROR_KINDS) {
      const hits = [RETRYABLE_KINDS.has(kind), FATAL_KINDS.has(kind), CANCELLED_KINDS.has(kind)].filter(Boolean).length
      assert.equal(hits, 1, `kind=${kind} 必须恰好落在一张表里（现在落在 ${hits} 张）`)
    }
    assert.equal(retryPolicy('network'), 'retry')
    assert.equal(retryPolicy('rate-limit'), 'retry')
    assert.equal(retryPolicy('unsupported'), 'fatal')
    assert.equal(retryPolicy('aborted'), 'cancelled')
    // 以前 aborted 两张表都不在：既不算可重试也不算致命，分类是空的。
    assert.equal(RETRYABLE_KINDS.has('aborted') || FATAL_KINDS.has('aborted'), false)
    assert.equal(CANCELLED_KINDS.has('aborted'), true)
  })

  await check('delivery 三项各自独立：提交成、回填败、通知成', async () => {
    const source = createMockSource()
    source.setFailWrite(true)
    const { scheduler, store, push } = harness({ source })
    await scheduler.tick()

    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'done', '回填失败不改票态')
    assert.ok(row.delivery, '票行必须有 delivery')
    assert.equal(row.delivery.commit?.ok, true, '有本地提交 = 交付成了')
    assert.equal(row.delivery.writeBack?.ok, false, '回填失败要如实记下来')
    assert.equal(row.delivery.notify?.ok, true, '通知发出去了')
    assert.equal(push.messages.length, 1)
    // 回填是 network 错（可重试）⇒ 留着待办 + giveUp=false
    assert.equal(row.delivery.writeBack.giveUp, false, '可重试的不能标成已放弃')
    assert.ok(row.pendingEffects?.writeBack, '可重试失败要留待补做')
    assert.equal(row.pendingEffects.writeBack.attempts, 1, '待办要记「试过几次」')
    // note 不再带 `network: ` 前缀（#08 的 D 条）
    assert.ok(!String(row.writeBack.note).startsWith('network:'), `note 不该带 kind 前缀：${row.writeBack.note}`)
    assert.equal(row.delivery.writeBack.errorKind, 'network', '分类进结构化字段')
  })

  await check('回填不可重试（飞书同步表）→ 当场放弃、giveUp=true、不再留待办', async () => {
    // 这张表结构上不接受直接写记录，再试一百次也是同一个 800074911。
    // 留着待办只会让每次启动都对着它撞一遍，还要在状态页上一直亮着「会再试一次」。
    const source = createMockSource()
    const original = source.writeResult.bind(source)
    source.writeResult = async (recordId, payload, signal) => ({
      written: false,
      retryable: false,
      errorKind: 'unsupported',
      note: '这张多维表格是「同步表」，飞书不允许直接改里面的行',
    })
    void original
    const { scheduler, store, push } = harness({ source })
    await scheduler.tick()

    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'done', '回填失败不改票态')
    assert.equal(row.delivery.writeBack?.ok, false)
    assert.equal(row.delivery.writeBack.giveUp, true, '不可重试要标成已放弃')
    assert.equal(row.pendingEffects?.writeBack, undefined, '放弃之后不该再留着待补做')
    assert.equal(row.delivery.writeBack.errorKind, 'unsupported')
    // 通知里要明说「别再等了」
    assert.match(push.messages[0].body, /不是再试一次能好的/, push.messages[0].body)
  })

  await check('done 却没有提交 → 交付记成没交出去（不能因为票面写着已完成就当它成了）', async () => {
    const executor = {
      id: 'done-without-commit',
      async run (ticket, target, ctx) {
        await ctx.onPhase('editing')
        await ctx.onPhase('mr-opening')
        // 故意**不**走 makeExecResult：契约层会直接拦住「done 但没有 commit/mr」，
        // 而这里要验的是内核自己那一层防线 —— 万一第三方执行器绕过了契约检查，
        // 交付维度也得如实记下「没有可 review 的东西」。
        return { phase: 'done', changedFiles: [], testOutcome: 'passed' }
      },
    }
    const { scheduler, store } = harness({ executor })
    await scheduler.tick()
    const row = store.getTicket(k('rec-mock-001'))
    assert.ok(row, '票要留在库里（不能凭空消失）')
    assert.equal(row.delivery.commit?.ok, false, '没有提交也没有 MR 要记成没交付')
    assert.match(row.delivery.commit.error ?? '', /既没有本地提交也没有 MR/)
  })

  await check('pipeline_status：交付未完成在标题行与全库分布里都看得见', async () => {
    const source = createMockSource()
    source.setFailWrite(true)
    const { scheduler, store } = harness({ source })
    await scheduler.tick()
    const status = createPipelineStatusTool({
      store,
      getConfig: () => validateConfig({ enabled: true }).value,
    })
    const out = await status.execute({ view: 'tickets', includeDone: true }, {})
    // 标题行后缀：只有回填失败时用短说法「（表格未回写）」，多项失败才逐个列。
    assert.match(out.text, /已完成（已验证）｜.*（表格未回写）|（表格未回写）/, out.text)
    assert.match(out.text, /交付未完成：1 张/, out.text)
    assert.match(out.text, /交付·回填表格：没做成/, out.text)
    assert.match(out.text, /会再自动试一次/, out.text)
    // 机器可读：delivery 与 deliveryIssues 都要给出来，运行页签不用自己再拼
    assert.equal(out.tickets[0].delivery.writeBack.ok, false)
    assert.equal(out.tickets[0].deliveryIssues[0].name, 'writeBack')
    assert.equal(out.tickets[0].deliveryIssues[0].giveUp, false)
  })

  // ── #14：失败票回填「处理结果」列 ─────────────────────────────
  // 表格里那一行永久停在「处理中」，在飞书 UI 里看跟「还没开始」完全一样。
  // 但把「是否处理」也写上会变成另一种谎 —— 所以只写「处理结果」一列，且缺省关。
  section('16c-2. 失败票回填：只写「处理结果」，绝不碰「是否处理」')

  await check('writeBackOnFailure 缺省关：失败票仍然完全不回填（回归）', async () => {
    const source = createMockSource()
    const { scheduler, store } = harness({
      source,
      executor: createMockExecutor({ outcome: 'failed' }),
    })
    await scheduler.tick()
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'failed')
    assert.equal(source.writes.length, 0, '缺省关时一次都不该写表格')
    assert.equal(row.writeBack, undefined, '连回执都不该有')
    assert.equal(row.delivery?.writeBack, undefined, '交付维度里也不该出现回填')
  })

  await check('打开 writeBackOnFailure：失败票只写「处理结果」，不写是否处理/处理日期', async () => {
    const source = createMockSource()
    const { scheduler, store, push } = harness({
      source,
      executor: createMockExecutor({ outcome: 'failed' }),
      config: { writeBackOnFailure: true },
    })
    await scheduler.tick()

    assert.equal(source.writes.length, 1, '失败票要写一次回填')
    const write = source.writes[0]
    assert.equal(write.onlyResult, true, '必须标成「只写结果列」')
    assert.equal(write.status, undefined, '「是否处理」不能写 —— 写了就等于说处理完了')
    assert.equal(write.handledAt, undefined, '「处理日期」是人的字段，不能写')
    assert.match(write.result, /\[流水线\] 失败：/, `结果列要说清这是失败：${write.result}`)
    assert.match(write.result, /pipeline_reset/, '要告诉人怎么重跑')

    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'failed', '回填不改票态')
    assert.equal(row.writeBack?.written, true, '回执要落库')
    assert.equal(row.delivery?.writeBack?.ok, true, '交付维度记成写成了')
    assert.equal(push.messages.length, 1, '通知照发（回填不抢通知的位置）')
  })

  await check('打开 writeBackOnFailure 后超时票也回填，但人工取消不回填', async () => {
    // 超时：人不在电脑前，表格里那行停「处理中」正是他最需要看到的东西。
    {
      const source = createMockSource()
      const { scheduler } = harness({
        source,
        executor: createMockExecutor({ hang: true }),
        config: { writeBackOnFailure: true, ticketTimeoutMinutes: 0.001 },
      })
      await scheduler.tick()
      assert.equal(source.writes.length, 1, '超时票要回填一句原因')
      assert.match(source.writes[0].result, /超时/, `要写清是超时：${source.writes[0].result}`)
      assert.equal(source.writes[0].status, undefined, '仍然不碰「是否处理」')
    }
    // 取消：人主动喊停，说明他不想让这条链路再动任何远端状态。
    {
      const source = createMockSource()
      const { scheduler } = harness({
        source,
        executor: createMockExecutor({ hang: true }),
        config: { writeBackOnFailure: true },
      })
      const pending = scheduler.tick()
      await new Promise((resolve) => setTimeout(resolve, 20))
      scheduler.cancelActive()
      await pending
      assert.equal(source.writes.length, 0, '人工取消不该回填')
    }
  })

  await check('失败票回填也会失败：进 delivery 分档，不做死循环', async () => {
    const source = createMockSource()
    source.setFailWrite(true) // network ⇒ 可重试
    const { scheduler, store } = harness({
      source,
      executor: createMockExecutor({ outcome: 'failed' }),
      config: { writeBackOnFailure: true },
    })
    await scheduler.tick()

    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'failed', '回填失败不能说成票的问题')
    assert.equal(row.delivery?.writeBack?.ok, false, '要如实记下没写成')
    assert.equal(row.delivery.writeBack.giveUp, false, 'network 是可重试的')
    assert.equal(row.pendingEffects?.writeBack?.attempts, 1, '待办要记「试过几次」')
    // 失败票本来就不回填「是否处理」，所以即使开了开关也不写 —— 这条同时钉住了
    // 「打开开关不能让表格状态变成处理完」这个产品承诺。
    assert.equal(row.writeBack?.written, false)
  })

  await check('失败票被 revivals 重跑后再失败：覆盖同一格，不追加', async () => {
    const source = createMockSource()
    const { scheduler, store } = harness({
      source,
      executor: createMockExecutor({ outcome: 'failed' }),
      config: { writeBackOnFailure: true },
    })
    await scheduler.tick()
    assert.equal(source.writes.length, 1)
    const first = source.writes[0].result

    // 人工重置回 pending，再跑一遍还是失败。飞书单元格是整格覆盖，
    // 所以只该多一次写、内容还是同一种格式，而不是两段拼在一起。
    await store.resetByHuman(k('rec-mock-001'))
    await scheduler.tick()
    assert.equal(source.writes.length, 2, '应该再写一次')
    assert.equal(source.writes[1].result.split('[流水线]').length, 2, '第二次的内容不能是两段拼起来')
    assert.match(first, /失败/)
  })

  // #06：通知是用户接触这个插件最频繁的界面（一张票一封），但原来只是一份
  // 「事实清单」——有项目、序号、sha、改动文件数，唯独没有一句「关我什么事」。
  // 判定行固定在第一行，因为手机邮件列表预览只取前 1–2 行。
  await check('通知第一行是判定行，六种情形各有各的句式', async () => {
    // ① done + 验证通过 + 回填成功 → 不用你做
    {
      const { scheduler, push } = harness()
      await scheduler.tick()
      const body = push.messages[0].body
      const first = body.split('\n')[0]
      assert.ok(first.startsWith('【'), `判定行必须在第一行，实际第一行是：${JSON.stringify(first)}`)
      assert.equal(first, '【不用你做，知道一下就行】', `done 全绿时不该要求人做事：${first}`)
      assert.equal(body.includes('要你做'), false, `一切正常时正文不该出现「要你做」：${body}`)
    }

    // ② done + 验证通过 + 回填失败 → 要人手工回填
    {
      const source = createMockSource()
      source.setFailWrite(true)
      const { scheduler, push } = harness({ source })
      await scheduler.tick()
      assert.equal(push.messages[0].body.split('\n')[0], '【要你做：去表格里手工回填这一行的「处理结果」】', push.messages[0].body)
    }

    // ③ done 但验证没跑成（workExecutor 没配 verify 命令）→ 要人自己验一遍。
    //    这一档最容易被误当成「验过了」，所以必须与 ① 分开。
    {
      const executor = {
        id: 'done-without-verify',
        async run (ticket, target, ctx) {
          await ctx.onPhase('editing')
          await ctx.onPhase('testing')
          await ctx.onPhase('mr-opening')
          return makeExecResult({
            phase: 'done',
            changedFiles: [],
            testOutcome: 'skipped',
            testDetail: '没有配置验证命令（verify.test 为空）',
            commit: { sha: 'abcdef123456', branch: 'ticket-demo', files: [] },
          })
        },
      }
      const { scheduler, push } = harness({ executor })
      await scheduler.tick()
      const body = push.messages[0].body
      assert.equal(body.split('\n')[0], '【要你做：这票没跑过验证，请人工验一遍】', body)
      assert.match(body, /验证：未跑成/, body)
    }

    // ④ skipped（验证跑了但没过）→ 要人确认这份改动能不能用
    {
      const { scheduler, push } = harness({ executor: createMockExecutor({ outcome: 'skipped' }) })
      await scheduler.tick()
      assert.equal(push.messages[0].body.split('\n')[0], '【要你做：改动已交付但验证没过，请人工确认】', push.messages[0].body)
    }

    // ⑤ failed → 要人重跑
    {
      const { scheduler, push } = harness({ executor: createMockExecutor({ outcome: 'failed' }) })
      await scheduler.tick()
      assert.equal(push.messages[0].body.split('\n')[0], '【要你做：这票失败了】', push.messages[0].body)
    }

    // ⑥ needs-info（截图取不到）→ 要人补图
    {
      const source = createMockSource({ failScreenshot: true })
      source.seeds[0].screenshot = { kind: 'path', path: 'D:/shots/1.png' }
      const { scheduler, push } = harness({ source, saveImage: async () => {} })
      await scheduler.tick()
      assert.equal(push.messages[0].body.split('\n')[0], '【要你做：补一张截图】', push.messages[0].body)
    }
  })

  await check('通知里带「处理会话」，收到邮件想追问能找到那个会话', async () => {
    // 断点 B3：原来只有渲染到「处理结果」列的分支会写会话 id，通知正文从来不写，
    // 用户想追问只能回 GUI 翻会话列表。说法与 renderWriteBackResult 保持一致。
    const executor = {
      id: 'with-session',
      async run (ticket, target, ctx) {
        await ctx.onPhase('editing')
        await ctx.onPhase('testing')
        await ctx.onPhase('mr-opening')
        return makeExecResult({
          phase: 'done',
          changedFiles: [],
          testOutcome: 'passed',
          sessionId: 'ticket-demo-rec-mock-001-1234567890',
          commit: { sha: 'abcdef123456', branch: 'ticket-demo', files: [] },
        })
      },
    }
    const { scheduler, push } = harness({ executor })
    await scheduler.tick()
    const body = push.messages[0].body
    assert.match(body, /处理会话：ticket-demo-rec-mock-001-1234567890/, `通知里要能直接看到会话 id：${body}`)
  })

  await check('验证失败时通知给 testDetail 加免责句（跨票耦合的失败容易误判）', async () => {
    // testDetail 是验证命令 stdout/stderr 的完整尾部（末 8 行），不按本票改动过滤。
    // 真机出现过「别的票的用例挂了、被写进这封通知」，人第一反应是自己的票把别人弄挂了。
    const executor = {
      id: 'failed-with-detail',
      async run (ticket, target, ctx) {
        await ctx.onPhase('editing')
        await ctx.onPhase('testing')
        await ctx.onPhase('mr-opening')
        return makeExecResult({
          phase: 'skipped',
          changedFiles: [],
          testOutcome: 'failed',
          testDetail: '✗ 行程分段天数（与本票无关）\n✗ 表单提交状态（与本票无关）',
          commit: { sha: 'abcdef123456', branch: 'ticket-demo', files: [] },
        })
      },
    }
    const { scheduler, push } = harness({ executor })
    await scheduler.tick()
    const body = push.messages[0].body
    assert.match(body, /可能包含与本工单无关的用例失败/, `要有免责句：${body}`)
    assert.match(body, /行程分段天数/, '免责句之后仍要把原始输出给人')
  })

  await check('一场跑完，pendingEffects 必须清干净（不清下次启动会重复补做）', async () => {
    const { scheduler, store } = harness()
    await scheduler.tick()
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'done')
    assert.equal(row.pendingEffects, undefined, `事后动作做完就该把标记删掉：${JSON.stringify(row.pendingEffects)}`)
  })

  await check('clearPendingEffect：只清报上来的那一项，两项都清完就把字段整个删掉', async () => {
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const [ticket] = (await createMockSource().scan(new AbortController().signal)).created
    await store.enqueue(ticket)
    const key = k('rec-mock-001')
    await store.setPhase(key, 'failed', { pendingEffects: { writeBack: { phase: 'done' }, notify: true } })

    await store.clearPendingEffect(key, 'notify')
    assert.equal(store.getTicket(key).pendingEffects.notify, undefined, '通知标记要清掉')
    assert.ok(store.getTicket(key).pendingEffects.writeBack, '另一项要留着')

    await store.clearPendingEffect(key, 'writeBack')
    assert.equal(store.getTicket(key).pendingEffects, undefined, '两项都清完就删字段，不留空对象')
  })

  await check('启动补偿：残留的终态票把回填和通知补做完，并清掉标记', async () => {
    // 真实事故：终态 setPhase 落库之后、回填/通知之前进程退出（DSH 重启、
    // 崩溃、机器被杀）。没有补偿的话，票在队列里看起来一切正常，表格却永远
    // 停在「处理中」，人也从没收到通知 —— 而且没有任何地方提示这一点。
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const source = createMockSource()
    const push = createMockPush()
    const scheduler = createScheduler({
      store,
      sources: [source],
      locator: createTableLocator({ projects: [{ name: DEMO, repo: { path: 'D:/WorkSpace/demo-repo' } }] }),
      executor: createMockExecutor(),
      push,
      config: {
        enabled: true,
        maxAttempts: 2,
        leaseTtlMinutes: 10,
        leaseHeartbeatSeconds: 60,
        ticketTimeoutMinutes: 40,
        worktreeRetentionHours: 24,
        notifyOn: ['done', 'skipped', 'failed', 'needs-info'],
      },
      log: silent,
    })

    const [ticket] = (await createMockSource().scan(new AbortController().signal)).created
    await store.enqueue(ticket)
    const key = k('rec-mock-001')
    const commit = { sha: 'deadbee1234', branch: 'v2.x', files: ['src/a.js'] }
    await store.setPhase(key, 'done', {
      commit,
      testOutcome: 'passed',
      pendingEffects: {
        writeBack: { phase: 'done', commit, changedFiles: ['src/a.js'], verification: { outcome: 'passed' } },
        notify: true,
      },
    }, { force: true })

    const replayed = await scheduler.replayPendingEffects({})
    assert.equal(replayed, 2, '回填 + 通知各算一个动作')
    assert.equal(source.writes.length, 1, '回填要补做')
    assert.equal(source.writes[0].recordId, 'rec-mock-001')
    assert.equal(push.messages.length, 1, '通知要补发')
    assert.equal(store.getTicket(key).pendingEffects, undefined, '补完就把标记清掉')
    assert.equal(store.getTicket(key).phase, 'done', '补偿不能改票态')
    assert.equal(store.getTicket(key).writeBack?.written, true, '补做的回执也要落库')
  })

  await check('重新入队（enqueue）不继承上一轮的 pendingEffects', async () => {
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const [ticket] = (await createMockSource().scan(new AbortController().signal)).created
    await store.enqueue(ticket)
    const key = k('rec-mock-001')
    await store.setPhase(key, 'done', { pendingEffects: { notify: true } }, { force: true })
    assert.equal(store.getTicket(key).pendingEffects.notify, true, '先确认标记真的落库了')

    // 工单在表格里被修订 → 重新入队。这票要重新跑一遍，跑完会重新登记待办；
    // 把旧标记带过来会让启动补偿在一张 pending 票上做终态动作。
    await store.enqueue(ticket)
    assert.equal(store.getTicket(key).pendingEffects, undefined, '新一轮不该带着上一轮待办')
  })

  await check('resetByHuman 不把 pendingEffects 带进新一轮', async () => {
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const [ticket] = (await createMockSource().scan(new AbortController().signal)).created
    await store.enqueue(ticket)
    const key = k('rec-mock-001')
    await store.setPhase(key, 'failed', { pendingEffects: { notify: true } })

    assert.equal(await store.resetByHuman(key), true)
    const row = store.getTicket(key)
    assert.equal(row.phase, 'pending')
    assert.equal(row.pendingEffects, undefined, '人工重开的票不该继承上一轮的待办')
  })

  await check('租约：别的 owner 连试两次都拿不到，续租按 token 判定', async () => {
    // 租约不是原子 CAS（read→判断→put→回读）。这条钉住的是**可观察语义**：
    // 抢不到就要稳定地抢不到，而不是时好时坏；续租只看 token，不是自己的就失败。
    const repo = makeMemoryRepo()
    const a = new TicketStore({ repo, log: silent })
    const b = new TicketStore({ repo, log: silent })
    const key = k('rec-mock-001')

    assert.equal(await a.acquireLease(key, 60_000), true, '第一个 owner 拿到')
    assert.equal(await b.acquireLease(key, 60_000), false, '第二个 owner 拿不到')
    assert.equal(await b.acquireLease(key, 60_000), false, '再试一次仍然拿不到（不是偶尔能抢到）')
    assert.equal(await b.renewLease(key, 60_000), false, '不是自己的租约，续租必须失败')
    assert.equal(await a.renewLease(key, 60_000), true, '自己的租约照常续')

    await a.releaseLease(key)
    assert.equal(await b.acquireLease(key, 60_000), true, '释放之后别人才能拿到')
  })

  await check('就地重跑：起点与票面记录不一致时，日志要说明「被判没有改动是预期」', async () => {
    // 就地模式每轮把检出的当前 HEAD 当起点。重跑时它已经是上一轮的提交，
    // 与票面记的 baseCommit 不同 → 这一轮 diff 基线变了，agent 没有新改动就会被判
    // failed。判定不改（用户 2026-11-06 确认），但必须把这件事说清楚，
    // 否则人只会看到一句「没有产生任何文件改动」而不知道是从哪来的。
    const { domain } = makeFakeDomain()
    const registered = []
    const logs = []
    const shell = {
      resolve: (request) => ({ ...request }),
      execute: async (spec) => {
        const command = String(spec?.command ?? '')
        let stdout = ''
        if (command.includes('rev-parse --abbrev-ref HEAD')) stdout = 'v2.x'
        else if (command.includes('rev-parse HEAD')) stdout = 'round2head'
        else if (command.includes('--is-inside-work-tree')) stdout = 'true'
        else if (command.includes('--version')) stdout = 'git version 2.45.1'
        return { result: async () => ({ exitCode: 0, stdout: { text: stdout }, stderr: { text: '' } }) }
      },
    }
    const ctx = {
      ...makeFakeCtx({ domain, registered }),
      get: (name) => {
        if (name === 'shell') return shell
        if (name === 'logger') {
          return { debug: silent, info: (msg) => { logs.push(String(msg)) }, warn: silent, error: silent }
        }
        return undefined
      },
    }
    const { value: config } = validateConfig({
      projects: [{ name: 'demo', match: { platform: 'mock' }, repo: { path: 'D:/repo' } }],
      workExecutor: 'mock',
      pushAdapter: 'mock',
      isolateWorktree: false,
      enabled: true,
    })
    await apply(ctx, config)

    const byName = new Map(registered.map((tool) => [tool.name, tool]))
    const store = new TicketStore({ repo: makeDomainRepo(domain), log: silent })
    const [ticket] = (await createMockSource().scan(new AbortController().signal)).created
    await store.enqueue(ticket)
    const key = k('rec-mock-001')
    // 上一轮留下的坐标：没有工作区登记、baseCommit 记的是更早的起点。
    await store.setPhase(key, 'pending', { worktreePath: 'D:/repo', branch: 'v2.x', baseCommit: 'oldbase0001' })

    await byName.get('pipeline_scan').execute({ skipScan: true }, {})
    const deadline = Date.now() + 5000
    let row = store.getTicket(key)
    while (Date.now() < deadline && (!row || row.phase === 'pending')) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      row = store.getTicket(key)
    }

    assert.ok(row, '这张票应该已经被跑过')
    assert.equal(row.baseCommit, 'round2head', '就地模式的起点取检出当前 HEAD')
    const notice = logs.find((line) => line.includes('这次起点是'))
    assert.ok(notice, `重跑起点与票面不一致时要打日志：${logs.join(' | ')}`)
    assert.match(notice, /round2head/, '要说清这次起点是什么')
    assert.match(notice, /oldbase0001/, '要说清票面记的是什么（全是空值就没人能对上）')
    assert.match(notice, /预期行为/, '要说明被判「没有产生任何文件改动」是预期')
  })

  await check('failed 也是终态：通知发完同样把 pendingEffects 清掉', async () => {
    // 失败路径同样有「落库了但通知没发」的窗口。它不回填（表里那行留在「处理中」
    // 是刻意留的信号），所以只登记 notify；发完必须清掉，否则每次启动都会补发一遍。
    const { scheduler, store, push } = harness({ executor: createMockExecutor({ outcome: 'failed' }) })
    await scheduler.tick()
    const row = store.getTicket(k('rec-mock-001'))
    assert.equal(row.phase, 'failed')
    assert.equal(push.messages.length, 1, '失败要通知')
    assert.equal(row.pendingEffects, undefined, `通知发完就该清标记：${JSON.stringify(row.pendingEffects)}`)
    assert.equal(row.writeBack, undefined, '失败的票不回填，也就不该有回执')
  })

  await check('启动补偿只捞终态票，pending 票上的标记不动（那是上一轮的残留，不该抢跑）', async () => {
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const source = createMockSource()
    const push = createMockPush()
    const scheduler = createScheduler({
      store,
      sources: [source],
      locator: createTableLocator({ projects: [{ name: DEMO, repo: { path: 'D:/WorkSpace/demo-repo' } }] }),
      executor: createMockExecutor(),
      push,
      config: {
        enabled: true,
        maxAttempts: 2,
        leaseTtlMinutes: 10,
        leaseHeartbeatSeconds: 60,
        ticketTimeoutMinutes: 40,
        worktreeRetentionHours: 24,
        notifyOn: ['done', 'skipped', 'failed', 'needs-info'],
      },
      log: silent,
    })

    const [ticket] = (await createMockSource().scan(new AbortController().signal)).created
    await store.enqueue(ticket)
    const key = k('rec-mock-001')
    // 人为造一张 pending 票还挂着待办：补做只该针对**已经到终态**的票。
    await store.setPhase(key, 'pending', { pendingEffects: { notify: true } })

    const replayed = await scheduler.replayPendingEffects({})
    assert.equal(replayed, 0, '没钱可补就不该动')
    assert.equal(push.messages.length, 0, 'pending 票不补通知')
    assert.equal(store.getTicket(key).pendingEffects.notify, true, '标记也不能替它清掉')
  })

  await check('pipeline_status：待补做的事后动作要能看见（否则表格停在处理中没人知道）', async () => {
    const rows = [
      {
        key: k('r-todo'),
        projectId: DEMO,
        recordId: 'r-todo',
        phase: 'done',
        attempt: 0,
        pendingEffects: { writeBack: { phase: 'done' }, notify: true },
      },
    ]
    const tool = createPipelineStatusTool({ store: { listTickets: () => rows }, getConfig: () => validateConfig({}).value })
    const out = await tool.execute({ view: 'tickets', includeDone: true }, {})
    assert.match(out.text, /待补做：回填表格、发通知/, `要列出还没做完的动作：${out.text}`)
    assert.deepEqual(out.tickets[0].pendingEffects, { writeBack: true, notify: true }, '返回体只暴露布尔，不摊内部载荷')
    assert.equal(out.tickets[0].writeBack, undefined, '还没回填就没有回执')

    // 干净票不带这一行：每张终态票都挂一句「待补做」只会教人忽略它。
    const clean = [{ key: k('r-clean'), projectId: DEMO, recordId: 'r-clean', phase: 'done', attempt: 0 }]
    const tool2 = createPipelineStatusTool({ store: { listTickets: () => clean }, getConfig: () => validateConfig({}).value })
    const out2 = await tool2.execute({ view: 'tickets', includeDone: true }, {})
    assert.doesNotMatch(out2.text, /待补做/, `干净票不该有待补做行：${out2.text}`)
    assert.equal(out2.tickets[0].pendingEffects, undefined)
  })

  await check('修订（revise）也不继承上一轮的 pendingEffects', async () => {
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const [ticket] = (await createMockSource().scan(new AbortController().signal)).created
    await store.enqueue(ticket)
    const key = k('rec-mock-001')
    await store.setPhase(key, 'done', { pendingEffects: { notify: true } }, { force: true })

    const revised = { ...ticket, revisionCount: (ticket.revisionCount ?? 1) + 1, fingerprint: 'changed-fp' }
    const { restarted } = await store.revise(revised)
    assert.equal(restarted, false, 'done 票收到修订不改 phase')
    assert.equal(store.getTicket(key).pendingEffects, undefined, '修订后不该带着上一轮的待办')
  })

  section('16c. 关键节点流程日志（时间线）')

  await check('时间线：一轮跑完把主站按链路顺序记下来，节点 id 就是 phase 名', async () => {
    const { scheduler, store } = harness()
    await scheduler.tick()
    const timeline = store.getTicket(k('rec-mock-001')).timeline
    assert.ok(Array.isArray(timeline), 'timeline 必须是数组')
    const nodes = timeline.map((e) => e.node)
    // mock 执行器不报 ④（session），所以这里只钉主链路里必然出现的那几站的顺序。
    const expectOrder = ['discover', 'locate', 'workspace', 'editing', 'testing', 'mr-opening', 'writeback', 'notify']
    let last = -1
    for (const n of expectOrder) {
      const i = nodes.indexOf(n)
      assert.ok(i > last, `${n} 应该排在前一站之后：${nodes.join(' → ')}`)
      last = i
    }
    assert.ok(nodes.includes('done'), `收尾要记 done 补充站：${nodes.join(' → ')}`)
  })

  await check('时间线：每条都带写下时刻（epoch ms）与布尔成败，label 是自包含中文名', async () => {
    const { scheduler, store } = harness()
    await scheduler.tick()
    for (const e of store.getTicket(k('rec-mock-001')).timeline) {
      assert.equal(typeof e.at, 'number', `${e.node} 要有 epoch 毫秒的 at`)
      assert.equal(typeof e.ok, 'boolean', `${e.node} 的 ok 必须是布尔（不是 running 三态）`)
      assert.equal(typeof e.label, 'string', `${e.node} 要有 label`)
      assert.ok(e.label.length > 0, `${e.node} 的 label 不能空`)
    }
  })

  await check('时间线：相邻两条 at 单调不减，之差就是上一站耗时', async () => {
    const { scheduler, store } = harness()
    await scheduler.tick()
    const timeline = store.getTicket(k('rec-mock-001')).timeline
    for (let i = 1; i < timeline.length; i += 1) {
      assert.ok(timeline[i].at >= timeline[i - 1].at, `第 ${i} 条的 at 不能比上一条早`)
    }
  })

  await check('时间线：「工作区就绪」和「检查工作区」两站说的不是同一句话（别重复记账）', async () => {
    const { scheduler, store } = harness()
    await scheduler.tick()
    const timeline = store.getTicket(k('rec-mock-001')).timeline
    const ready = timeline.find((e) => e.node === 'worktree-ready')
    const workspace = timeline.find((e) => e.node === 'workspace')
    assert.ok(ready, '要有 worktree-ready 这一站')
    assert.ok(workspace, '要有 workspace 这一站')
    assert.ok(typeof ready.detail === 'string' && ready.detail.length > 0, '工作区就绪要说明目录/分支')
    assert.ok(typeof workspace.detail === 'string' && workspace.detail.length > 0, '检查工作区要说明是新建还是复用')
    // 上一版两站套的是同一个字符串（都是「票据上还没有工作区，新建/登记一个；工作目录 …」），
    // 读起来像同一条日志被记了两遍。现在互补：就绪站报坐标，检查站报「复用/新建/重建」的判定。
    assert.notEqual(ready.detail, workspace.detail, `两站不能是同一句话：${ready.detail}`)
    assert.ok(/工作目录|项目工作区/.test(ready.detail), `工作区就绪要给出坐标：${ready.detail}`)
    assert.ok(/(复用|新建|重新准备|已失效)/.test(workspace.detail), `检查工作区要给出判定：${workspace.detail}`)
  })

  await check('时间线：执行器通过 onFlow 报上来的 ④ 会话也记进去（含模型/分支）', async () => {
    const flowExecutor = {
      async run (ticket, target, ctx) {
        if (typeof ctx.onFlow === 'function') {
          await ctx.onFlow('session', '创建会话（分支+模型）', '会话 ticket-demo-rec-mock-001-1，模型 workbuddy/deepseek-v4.1-flash，分支 v2.x，工作目录 D:/r')
        }
        return createMockExecutor().run(ticket, target, ctx)
      },
    }
    const { scheduler, store } = harness({ executor: flowExecutor })
    await scheduler.tick()
    const timeline = store.getTicket(k('rec-mock-001')).timeline
    const session = timeline.find((e) => e.node === 'session')
    assert.ok(session, `要有 ④ 会话站：${timeline.map((e) => e.node).join(' → ')}`)
    assert.equal(session.ok, true, '成功起会话是 ✓')
    assert.match(session.detail, /模型 workbuddy\/deepseek/, `detail 要带模型：${session.detail}`)
  })

  await check('时间线：失败票把 ✗ 站标出来，成功收尾标 ✓', async () => {
    const { scheduler, store } = harness({ executor: createMockExecutor({ outcome: 'failed' }) })
    await scheduler.tick()
    const timeline = store.getTicket(k('rec-mock-001')).timeline
    const failedEntry = timeline.find((e) => e.node === 'failed')
    assert.ok(failedEntry, `失败票要有 failed 站：${timeline.map((e) => e.node).join(' → ')}`)
    assert.equal(failedEntry.ok, false, 'failed 站必须是 ✗')
  })

  await check('时间线：连续同节点同成败合并成一条（worktree-ready 会触发两次）', async () => {
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const [ticket] = (await createMockSource().scan(new AbortController().signal)).created
    await store.enqueue(ticket)
    const key = k('rec-mock-001')
    await store.appendTimeline(key, 'worktree-ready', '第一次建', true)
    await store.appendTimeline(key, 'worktree-ready', '又补了一次', true)
    assert.equal(store.getTicket(key).timeline.length, 1, '连续同节点同 ok 要合并')
    assert.equal(store.getTicket(key).timeline[0].detail, '又补了一次', '保留最新 detail')
    await store.appendTimeline(key, 'worktree-ready', '这次没做成', false)
    assert.equal(store.getTicket(key).timeline.length, 2, 'ok 不同不能合并')
  })

  await check('时间线：超过 80 条只留最近的，不无界膨胀', async () => {
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const [ticket] = (await createMockSource().scan(new AbortController().signal)).created
    await store.enqueue(ticket)
    const key = k('rec-mock-001')
    for (let i = 0; i < 90; i += 1) {
      // 交替 ok 避免「连续同节点同 ok」被合并，才能真正测出封顶。
      await store.appendTimeline(key, 'editing', `第${i}次`, i % 2 === 0)
    }
    const timeline = store.getTicket(key).timeline
    assert.equal(timeline.length, 80, `上限是 80：${timeline.length}`)
    assert.equal(timeline[0].detail, '第10次', '最旧的 10 条被丢掉')
    assert.equal(timeline[79].detail, '第89次', '最新的留着')
  })

  await check('时间线：重新入队（enqueue）不抹掉上一轮的时间线', async () => {
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const [ticket] = (await createMockSource().scan(new AbortController().signal)).created
    await store.enqueue(ticket)
    const key = k('rec-mock-001')
    await store.appendTimeline(key, 'discover', '第一轮记的')
    await store.enqueue(ticket, { phase: 'pending', attempt: 0, enqueuedAt: Date.now() })
    const timeline = store.getTicket(key).timeline
    assert.ok(Array.isArray(timeline) && timeline.length >= 1, '重新入队不能把时间线清掉')
    assert.equal(timeline[0].detail, '第一轮记的', '上一轮的记录还在')
  })

  await check('时间线：人工重置不清空历史，末尾补一条「重新入队」分隔', async () => {
    const { scheduler, store } = harness({ executor: createMockExecutor({ outcome: 'failed' }) })
    await scheduler.tick()
    const key = k('rec-mock-001')
    const before = store.getTicket(key).timeline
    assert.ok(before.length >= 5, `失败跑完该有几站记录：${before.length}`)
    assert.equal(await store.resetByHuman(key), true, 'failed 票能重置')
    const after = store.getTicket(key).timeline
    assert.ok(after.length >= before.length, '历史不能被清空')
    const last = after[after.length - 1]
    assert.equal(last.node, 'pending', '末尾补一条排队分隔')
    assert.match(last.detail, /人工重置/, `要说明是人工重置：${last.detail}`)
    assert.ok(after.slice(0, before.length).some((e) => e.node === 'editing'), '上一轮的 editing 记录还在')
  })

  await check('pipeline_status：时间线渲染出来 + 「现在停在第 N 站，已 X 分 Y 秒没动」', async () => {
    const base = 1_000_000
    const rows = [{
      key: k('r-flow'), projectId: DEMO, recordId: 'r-flow', phase: 'editing', attempt: 0,
      problemSummary: '翻页跳回',
      timeline: [
        { node: 'discover', label: '获取工单', at: base, ok: true },
        { node: 'locate', label: '查找对应工单的项目', at: base + 60_000, ok: true },
        { node: 'editing', label: '处理工单问题', at: base + 300_000, ok: true },
      ],
    }]
    // 现在 = 最后一条 at 之后 95 秒，看渲染出的「已多久没动」是不是 1 分 35 秒。
    const tool = createPipelineStatusTool({
      store: { listTickets: () => rows },
      getConfig: () => validateConfig({}).value,
      now: () => base + 300_000 + 95_000,
    })
    const out = await tool.execute({ view: 'tickets', includeDone: true }, {})
    assert.match(out.text, /流程日志/, '要有时间线小节')
    assert.match(out.text, /现在停在第 ⑤ 站「处理工单问题」/, `要指出卡在第几站：${out.text}`)
    assert.match(out.text, /已 1 分 35 秒没动/, `要说清多久没动：${out.text}`)
  })

  await check('pipeline_status：终态票说「已经收尾」，needs-info 说「在等人」', async () => {
    const mk = (phase, node, ok) => [{
      key: k(`r-${phase}`), projectId: DEMO, recordId: `r-${phase}`, phase, attempt: 0,
      timeline: [{ node, label: TIMELINE_NODES[node].label, at: 5_000, ok }],
    }]
    const doneOut = await createPipelineStatusTool({
      store: { listTickets: () => mk('done', 'done', true) }, getConfig: () => validateConfig({}).value, now: () => 10_000,
    }).execute({ view: 'tickets', includeDone: true }, {})
    assert.match(doneOut.text, /已经收尾/, `终态要写「已收尾」：${doneOut.text}`)

    const needsOut = await createPipelineStatusTool({
      store: { listTickets: () => mk('needs-info', 'needs-info', false) }, getConfig: () => validateConfig({}).value, now: () => 10_000,
    }).execute({ view: 'tickets', includeDone: true }, {})
    assert.match(needsOut.text, /等你补充信息/, `needs-info 要写「在等人」：${needsOut.text}`)
    assert.match(needsOut.text, /不是插件卡死/, '要说清是等人不是卡死')
  })

  await check('pipeline_status：tickets[] 带机器可读 timeline，station/stalledForMs 算得出来', async () => {
    const base = 1_000_000
    const rows = [{
      key: k('r-m'), projectId: DEMO, recordId: 'r-m', phase: 'editing', attempt: 0,
      timeline: [
        { node: 'discover', label: '获取工单', at: base, ok: true },
        { node: 'editing', label: '处理工单问题', at: base + 300_000, ok: true },
      ],
    }]
    const out = await createPipelineStatusTool({
      store: { listTickets: () => rows }, getConfig: () => validateConfig({}).value, now: () => base + 395_000,
    }).execute({ view: 'tickets', includeDone: true }, {})
    assert.equal(out.tickets[0].timeline.length, 2, '返回体要带完整时间线')
    assert.equal(typeof out.tickets[0].timeline[0].at, 'number', 'at 是 epoch ms')
    assert.equal(out.tickets[0].station.no, '⑤', '当前站定位到 editing 的编号')
    assert.equal(out.tickets[0].stalledForMs, 95_000, '停滞时长算得对')
    assert.equal(out.tickets[0].lastNodeOk, true)
  })

  await check('pipeline_status：没有时间线的老票也不引入 undefined（lossless JSON）', async () => {
    const rows = [{ key: k('r-old'), projectId: DEMO, recordId: 'r-old', phase: 'done', attempt: 0 }]
    const out = await createPipelineStatusTool({
      store: { listTickets: () => rows }, getConfig: () => validateConfig({}).value, now: () => 1_000,
    }).execute({ view: 'tickets', includeDone: true }, {})
    const offenders = []
    const walk = (value, path) => {
      if (value === undefined) { offenders.push(path || '<root>'); return }
      if (Array.isArray(value)) { value.forEach((item, i) => walk(item, `${path}[${i}]`)); return }
      if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) walk(item, path ? `${path}.${key}` : key)
      }
    }
    walk(out, '')
    assert.deepEqual(offenders, [], `新字段不能漏 undefined：${offenders.join(', ')}`)
    assert.deepEqual(out.tickets[0].timeline, [], '没时间线就是空数组')
  })

  section('16d. 长站点心跳：跑十几分钟也不能看起来像卡死')

  await check('时间线：心跳只和心跳合并，不吃掉进站那条，也不占 80 条额度', async () => {
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const [ticket] = (await createMockSource().scan(new AbortController().signal)).created
    await store.enqueue(ticket)
    const key = k('rec-mock-001')
    await store.appendTimeline(key, 'testing', '进站了', true)
    // 连打 5 次心跳：只能合成一条，且进站那条必须还在。
    for (let i = 0; i < 5; i += 1) {
      await store.appendTimeline(key, 'testing', `第 ${i} 次心跳`, true, undefined, { heartbeat: true })
    }
    const timeline = store.getTicket(key).timeline
    assert.equal(timeline.length, 2, `进站 1 条 + 心跳 1 条：${timeline.map((e) => e.node).join(' → ')}`)
    assert.equal(timeline[0].detail, '进站了', '进站那条不能被心跳吃掉')
    assert.notEqual(timeline[0].heartbeat, true, '进站那条不是心跳')
    assert.equal(timeline[1].heartbeat, true, '第二条是心跳')
    assert.equal(timeline[1].detail, '第 4 次心跳', '心跳保留最新一条')

    // 心跳不占封顶额度：站点记录仍然能存满 80 条。
    const repo2 = makeMemoryRepo()
    const store2 = new TicketStore({ repo: repo2, log: silent })
    await store2.enqueue(ticket)
    for (let i = 0; i < 80; i += 1) {
      await store2.appendTimeline(key, 'editing', `第${i}站`, i % 2 === 0)
    }
    await store2.appendTimeline(key, 'editing', '心跳', true, undefined, { heartbeat: true })
    const capped = store2.getTicket(key).timeline
    assert.equal(capped.length, 80, `心跳不能把封顶挤爆：${capped.length}`)
  })

  await check('调度器：长站点跑起来会自己补心跳，人不会看到「13 分钟没动」', async () => {
    // 执行器在 testing 站里停 180ms，心跳 40ms 一次 —— 至少要补出 2 条心跳。
    const slowExecutor = {
      async run (ticket, target, ctx) {
        await ctx.onPhase('editing')
        await new Promise((resolve) => setTimeout(resolve, 20))
        await ctx.onPhase('testing')
        await new Promise((resolve) => setTimeout(resolve, 180))
        // 注意：这里不能再调 createMockExecutor().run(...) —— mock 内部第一步又是
        // onPhase('editing')，会给 editing 记第二条进站记录（中间隔着 testing，
        // 不满足「连续同 node 同 ok 才合并」）。直接返回结果最干净。
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
      executor: slowExecutor,
      timelineHeartbeatMsOverride: 40,
    })
    await scheduler.tick()
    const timeline = store.getTicket(k('rec-mock-001')).timeline
    const heartbeats = timeline.filter((e) => e.heartbeat === true)
    assert.ok(heartbeats.length >= 1, `长站点要补心跳：${timeline.map((e) => `${e.node}${e.heartbeat ? '(心跳)' : ''}`).join(' → ')}`)
    assert.equal(heartbeats[0].node, 'testing', '心跳打在正在跑的那一站上')
    assert.match(heartbeats[0].detail, /心跳/, 'detail 要说明这是心跳')

    // 心跳不能把别的站搞乱：editing 只该有进站那一条。
    const editingEntries = timeline.filter((e) => e.node === 'editing')
    assert.equal(editingEntries.length, 1, `editing 只有进站一条：${editingEntries.length}`)
    assert.notEqual(editingEntries[0].heartbeat, true)
  })

  await check('调度器：终态之后心跳立刻停，不会继续往时间线里塞', async () => {
    const { scheduler, store } = harness({ timelineHeartbeatMsOverride: 10 })
    await scheduler.tick()
    const key = k('rec-mock-001')
    const afterRun = store.getTicket(key).timeline.length
    await new Promise((resolve) => setTimeout(resolve, 80))
    const later = store.getTicket(key).timeline.length
    assert.equal(later, afterRun, '跑完就该停定时器，不能被心跳继续写')
  })

  await check('pipeline_status：长站点报「这一站已经跑了多久」+ 经验区间，超了才提示可能卡住', async () => {
    const base = 1_000_000
    const mkRows = (elapsedMs) => [{
      key: k('r-test'), projectId: DEMO, recordId: 'r-test', phase: 'testing', attempt: 0,
      timeline: [
        { node: 'discover', label: '获取工单', at: base, ok: true },
        { node: 'testing', label: '跑验证', at: base + 60_000, ok: true },
        // 心跳把「多久没动」推到最后一次心跳
        { node: 'testing', label: '跑验证', at: base + 60_000 + elapsedMs - 30_000, ok: true, heartbeat: true },
      ],
    }]
    // 8 分钟：在 3–15 分钟内，不该说「可能卡住」。
    const okOut = await createPipelineStatusTool({
      store: { listTickets: () => mkRows(8 * 60_000) },
      getConfig: () => validateConfig({}).value,
      now: () => base + 60_000 + 8 * 60_000,
    }).execute({ view: 'tickets', includeDone: true }, {})
    assert.match(okOut.text, /通常 3–15 分钟/, `站点标签要带经验区间：${okOut.text}`)
    assert.match(okOut.text, /这一站已经跑了|已经跑了 8 分/, `要报这一站跑了多久：${okOut.text}`)
    assert.doesNotMatch(okOut.text, /可能卡住了/, '范围内不能吓人')
    // 心跳不单独占一行：三站记录里只有两行站点。
    const stationLines = okOut.text.split('\n').filter((line) => /^\s{4}\d{2}-\d{2} /.test(line))
    assert.equal(stationLines.length, 2, `心跳不占行，只有 2 行站点：${stationLines.join(' | ')}`)
    assert.equal(okOut.tickets[0].timeline.length, 3, '机器可读 timeline 保留全部记录')
    assert.equal(okOut.tickets[0].stations.length, 2, 'stations 只留站点')
    assert.equal(okOut.tickets[0].heartbeatCount, 1)
    assert.equal(okOut.tickets[0].stationRange[1], 15, 'testing 的经验区间上界是 15 分钟')

    // 20 分钟：超了上界，必须升级措辞。
    const slowOut = await createPipelineStatusTool({
      store: { listTickets: () => mkRows(20 * 60_000) },
      getConfig: () => validateConfig({}).value,
      now: () => base + 60_000 + 20 * 60_000,
    }).execute({ view: 'tickets', includeDone: true }, {})
    assert.match(slowOut.text, /超过常见范围（3–15 分钟）/, `超范围要明说：${slowOut.text}`)
    assert.match(slowOut.text, /可以再等等，也可以取消后重跑/, '要给出两条路')
  })

  await check('pipeline_status：短站点保持原来的「已 X 没动」，不被心跳改造影响', async () => {
    const base = 1_000_000
    const rows = [{
      key: k('r-short'), projectId: DEMO, recordId: 'r-short', phase: 'editing', attempt: 0,
      timeline: [{ node: 'editing', label: '处理工单问题', at: base, ok: true }],
    }]
    const out = await createPipelineStatusTool({
      store: { listTickets: () => rows }, getConfig: () => validateConfig({}).value, now: () => base + 95_000,
    }).execute({ view: 'tickets', includeDone: true }, {})
    assert.match(out.text, /现在停在第 ⑤ 站「处理工单问题」/, '站号与站名不变')
    assert.match(out.text, /已 1 分 35 秒没动/, '没配经验区间的站仍然说「多久没动」')
    assert.equal(out.tickets[0].stationRange, undefined, '短站点没有经验区间')
  })

  await check('票据行里的数字键脏字段会被剔掉，且下一次写入把它从存储里清走', async () => {    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const key = ticketKey(DEMO, 'r-dirty')
    await store.enqueue({
      projectId: DEMO, recordId: 'r-dirty', fingerprint: 'f', revisionCount: 1,
      description: '说明', screenshots: [],
    })
    // 模拟老 bug 留下的形状：字符串被 Object.entries 展开成数字键。
    const dirty = { ...repo.get(TABLES.tickets, key) }
    ;['a', 'g', 'e', 'n', 't'].forEach((ch, i) => { dirty[String(i)] = ch })
    await repo.put(TABLES.tickets, key, dirty)
    assert.equal(Object.keys(repo.get(TABLES.tickets, key)).filter((n) => /^\d+$/.test(n)).length, 5, '前置：存储里确实脏了')

    const read = store.getTicket(key)
    assert.equal(Object.keys(read).filter((n) => /^\d+$/.test(n)).length, 0, 'getTicket 读出来要干净')
    assert.equal(read.description, '说明', '正常字段不受影响')
    assert.deepEqual(
      Object.keys(store.listTickets()[0]).filter((n) => /^\d+$/.test(n)), [], 'listTickets 也要干净')

    // 任何一次写入都会把存储里的脏键带走（展开的是已经洗过的行）。
    await store.appendTimeline(key, 'editing', '改代码')
    assert.equal(
      Object.keys(repo.get(TABLES.tickets, key)).filter((n) => /^\d+$/.test(n)).length, 0,
      '写回存储时脏键必须消失，不能一路带下去')
  })

  section('17. 选择分支：把检出里的分支列成下拉候选')

  await check('branches：解析 for-each-ref 输出，丢掉 origin/HEAD 这类符号引用', async () => {
    const parsed = parseBranchRefs([
      'refs/heads/main',
      'refs/heads/v2.x',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/v2.x',
      'refs/remotes/origin/feature/login',
      '',
    ].join('\n'))
    assert.deepEqual(parsed.local, ['main', 'v2.x'], `本地分支：${JSON.stringify(parsed.local)}`)
    assert.deepEqual(
      parsed.remote,
      [{ branch: 'v2.x', remote: 'origin' }, { branch: 'feature/login', remote: 'origin' }],
      `远端分支要剥掉 remote 名、保留分支名里的斜杠、丢掉 HEAD：${JSON.stringify(parsed.remote)}`,
    )
  })

  await check('branches：候选顺序是 当前分支 → 远端默认分支 → 本地 → 其余远端', async () => {
    const parsed = parseBranchRefs([
      'refs/heads/main',
      'refs/heads/v2.x',
      'refs/remotes/origin/v2.x',
      'refs/remotes/origin/dev',
    ].join('\n'))
    const choices = mergeBranchChoices(parsed, { current: 'v2.x', defaultBranch: 'main' })
    assert.deepEqual(choices, ['v2.x', 'main', 'dev'], `顺序与去重：${JSON.stringify(choices)}`)
  })

  await check('branches：listBranches 拿到分支、当前分支与主干', async () => {
    const calls = []
    const gitRunner = async (argv, opts) => {
      calls.push({ argv, cwd: opts && opts.cwd })
      if (argv[0] === 'for-each-ref') {
        return { code: 0, stdout: 'refs/heads/v2.x\nrefs/remotes/origin/v2.x\nrefs/remotes/origin/dev\n', stderr: '' }
      }
      if (argv[0] === 'rev-parse') return { code: 0, stdout: 'v2.x\n', stderr: '' }
      return { code: 1, stdout: '', stderr: 'unexpected' }
    }
    const out = await listBranches(gitRunner, 'D:/WorkSpace/mgiot-pms', {
      detectDefaultBranch: async () => 'v2.x',
    })
    assert.equal(out.ok, true, `应该成功：${JSON.stringify(out)}`)
    assert.equal(out.current, 'v2.x', '当前分支')
    assert.equal(out.defaultBranch, 'v2.x', '主干分支')
    assert.deepEqual(out.branches, ['v2.x', 'dev'], `候选：${JSON.stringify(out.branches)}`)
    assert.deepEqual(out.remote, ['v2.x', 'dev'], '远端清单')
    assert.equal(calls.length, 2, '只该跑两条 git 命令')
    assert.deepEqual(calls[0].argv, BRANCH_REF_ARGS, '第一条必须是 for-each-ref')
    assert.equal(calls[0].cwd, 'D:/WorkSpace/mgiot-pms', 'git 要在项目检出里跑')
  })

  await check('branches：各种拿不到分支的情况都不抛，只返回 ok:false + 原因', async () => {
    const noPath = await listBranches(async () => ({ code: 0, stdout: '', stderr: '' }), '  ')
    assert.equal(noPath.ok, false, 'repo.path 空要失败')
    assert.match(noPath.reason, /repo\.path/, `要说清是没配路径：${noPath.reason}`)

    const noRunner = await listBranches(undefined, 'D:/x')
    assert.equal(noRunner.ok, false, 'gitRunner 缺席要失败')
    assert.match(noRunner.reason, /gitRunner|执行链路/, `要说清是宿主没给执行链路：${noRunner.reason}`)

    const notRepo = await listBranches(async () => ({
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
    }), 'D:/nowhere')
    assert.equal(notRepo.ok, false, '非 git 检出要失败')
    assert.match(notRepo.reason, /not a git repository/, `要把 git 原话带出来：${notRepo.reason}`)

    const throws = await listBranches(async () => { throw new Error('EPERM: spawn git') }, 'D:/x')
    assert.equal(throws.ok, false, 'gitRunner 抛错也不能炸')
    assert.match(throws.reason, /EPERM/, `要把原因带出来：${throws.reason}`)
  })

  await check('branches：游离 HEAD 不算分支名，候选里也不会冒出一个 HAND', async () => {
    const gitRunner = async (argv) => {
      if (argv[0] === 'for-each-ref') return { code: 0, stdout: 'refs/heads/main\n', stderr: '' }
      return { code: 0, stdout: 'HEAD\n', stderr: '' }
    }
    const out = await listBranches(gitRunner, 'D:/x')
    assert.equal(out.ok, true)
    assert.equal(out.current, '', `游离 HEAD 不该当成分支名：${JSON.stringify(out.current)}`)
    assert.deepEqual(out.branches, ['main'], `候选：${JSON.stringify(out.branches)}`)
  })

  await check('branches：宿主 remote 暴露 branches()，项目路径配错不影响别的项目', async () => {
    const { TicketPipelineRemote } = await import('../src/remote/host.js')
    const gitRunner = async (argv, opts) => {
      if (argv[0] === 'for-each-ref') {
        if (String(opts && opts.cwd).includes('good')) {
          return { code: 0, stdout: 'refs/heads/main\nrefs/remotes/origin/dev\n', stderr: '' }
        }
        return { code: 128, stdout: '', stderr: 'fatal: not a git repository\n' }
      }
      return { code: 0, stdout: 'main\n', stderr: '' }
    }
    const remote = new TicketPipelineRemote({
      getConfig: () => ({
        projects: [
          { name: 'good', repo: { path: 'D:/good' } },
          { name: 'bad', repo: { path: 'D:/bad' } },
          { name: 'nopath', repo: {} },
        ],
      }),
      doctorOptions: { gitRunner },
    })
    const result = await remote.branches()
    assert.equal(result.count, 3, '三个项目都要有一条记录')
    assert.equal(result.branches[0].ok, true, `good 项目要成功：${JSON.stringify(result.branches[0])}`)
    assert.deepEqual(result.branches[0].branches, ['main', 'dev'], `good 候选：${JSON.stringify(result.branches[0].branches)}`)
    assert.equal(result.branches[1].ok, false, 'bad 项目要失败但不抛')
    assert.equal(result.branches[2].ok, false, '没配路径的项目也要有记录')
    assert.match(result.branches[2].reason, /repo\.path/, `要说清是没配路径：${result.branches[2].reason}`)
  })

  section('18. 设置面板「运行」页签：宿主 remote 的四个新方法（#16）')
  await check('remote.status()：面板拿到的就是工具那份结果，不另算一套', async () => {
    const { TicketPipelineRemote } = await import('../src/remote/host.js')
    const env = harness()
    const scan = await env.source.scan(new AbortController().signal)
    await env.store.enqueue(scan.created[0], { phase: 'worktree-ready' })
    const remote = new TicketPipelineRemote({
      getConfig: () => env.config,
      doctorOptions: {},
      store: env.store,
    })
    const out = await remote.status()
    // 必须和工具口径一致：面板上看到的票列表不能是第二套算法。
    // 面板看明细，所以 remote 固定传 view:'tickets'；工具缺省是 overview。
    assert.equal(out.view, 'tickets', '运行页签要明细行，不要按项目聚合')
    assert.equal(out.tickets.length, 1, `要点到具体那一票：${JSON.stringify(out.tickets)}`)
    assert.equal(out.tickets[0].phaseLabel, '工作区已就绪', `票面阶段要有中文：${out.tickets[0].phaseLabel}`)
    assert.ok(Array.isArray(out.tiers) && out.tiers.length > 0, '汇总行要能直接画')
    assert.equal(typeof out.text, 'string', 'text 也要带着（工具与面板同源）')
  })

  await check('remote.status(includeDone)：勾上「显示历史」才把收尾的票拉进来', async () => {
    const { TicketPipelineRemote } = await import('../src/remote/host.js')
    const env = harness()
    const scan = await env.source.scan(new AbortController().signal)
    // 一张留在队列里、一张直接落成终态：不传 includeDone 时只该看到前者。
    await env.store.enqueue(scan.created[0], { phase: 'worktree-ready' })
    await env.store.enqueue(scan.created[1], { phase: 'done', attempt: 1 })
    const remote = new TicketPipelineRemote({
      getConfig: () => env.config,
      doctorOptions: {},
      store: env.store,
    })
    const withoutHistory = await remote.status()
    assert.equal(withoutHistory.tickets.length, 1, `缺省只列未收尾的：${withoutHistory.tickets.length}`)
    assert.ok(
      !withoutHistory.tickets.some((row) => row.phase === 'done'),
      '缺省那一屏不该出现终态票'
    )
    // 显式 false 与不传完全等价 —— 面板两个分支（初始 / 点掉开关）走的是同一个口径。
    const explicitFalse = await remote.status(false)
    assert.equal(explicitFalse.tickets.length, 1, '显式 false 要和不传一样')
    // 非布尔一律当 false，不从别的类型里猜意图（面板传事件对象是真实会踩的坑）。
    const truthyish = await remote.status('true')
    assert.equal(truthyish.tickets.length, 1, '只有严格的 true 才算要看历史')
    const withHistory = await remote.status(true)
    assert.equal(withHistory.tickets.length, 2, `勾上后两张都要：${withHistory.tickets.length}`)
    assert.ok(
      withHistory.tickets.some((row) => row.phase === 'done'),
      '勾上后终态票必须在里面'
    )
    assert.equal(withHistory.view, 'tickets', '仍然走明细视图（面板要能挂按钮）')
  })

  await check('remote.status()：没有 store 时给人话，不抛 TypeError', async () => {
    const { TicketPipelineRemote } = await import('../src/remote/host.js')
    const remote = new TicketPipelineRemote({ getConfig: () => ({ enabled: false }), doctorOptions: {} })
    await assert.rejects(() => remote.status(), (error) => {
      assert.match(error.message, /没接上存储/, `要说清是装配问题：${error.message}`)
      assert.match(error.message, /store/, `要点名缺的是 store：${error.message}`)
      return true
    })
  })

  await check('remote.scan()：总开关关着时直接说 disabled，不起后台', async () => {
    const { TicketPipelineRemote } = await import('../src/remote/host.js')
    let tickCalls = 0
    const remote = new TicketPipelineRemote({
      getConfig: () => ({ enabled: false }),
      doctorOptions: {},
      scheduler: { tick: async () => { tickCalls += 1 }, get isRunning () { return false } },
    })
    const out = await remote.scan()
    assert.equal(out.status, 'disabled', `关着就该说关着：${JSON.stringify(out)}`)
    assert.equal(tickCalls, 0, '关着不能偷偷跑一轮')
    assert.match(out.text, /enabled/, '要告诉人开关在哪')
  })

  await check('remote.cancel()：没票在跑时说清楚，不报错', async () => {
    const { TicketPipelineRemote } = await import('../src/remote/host.js')
    const remote = new TicketPipelineRemote({
      getConfig: () => ({ enabled: true }),
      doctorOptions: {},
      scheduler: { cancelActive: () => false },
    })
    const out = await remote.cancel()
    assert.equal(out.cancelled, false)
    assert.match(out.text, /没有票在跑/, `要说清为什么什么都没取消：${out.text}`)
  })

  await check('remote.reset()：失败票能重开回 pending', async () => {
    const { TicketPipelineRemote } = await import('../src/remote/host.js')
    const env = harness()
    const scan = await env.source.scan(new AbortController().signal)
    const row = await env.store.enqueue(scan.created[0], { phase: 'worktree-ready' })
    await env.store.setPhase(row.key, 'failed', { lastError: '模型说它不想干' })
    const remote = new TicketPipelineRemote({ getConfig: () => env.config, doctorOptions: {}, store: env.store })
    // 只传 recordId：projectId 是 acceptsUndefined 的可选参数，
    // 显式传 undefined 会让浏览器侧「参数个数」校验对不上（票 #16 验收项）。
    const out = await remote.reset(scan.created[0].recordId)
    assert.equal(out.reset, true, `要重开成功：${JSON.stringify(out)}`)
    assert.equal(out.reason, 'ok', out.text)
    assert.equal(out.phase, 'pending', '重开后回 pending')
    assert.equal(env.store.getTicket(row.key).phase, 'pending', '存储里的票态也要真的回去')
  })

  await check('remote.reset()：不是终态的票不给重开（别把正在跑的打断）', async () => {
    const { TicketPipelineRemote } = await import('../src/remote/host.js')
    const env = harness()
    const scan = await env.source.scan(new AbortController().signal)
    await env.store.enqueue(scan.created[0], { phase: 'worktree-ready' })
    const remote = new TicketPipelineRemote({ getConfig: () => env.config, doctorOptions: {}, store: env.store })
    const out = await remote.reset(scan.created[0].recordId)
    assert.equal(out.reset, false)
    assert.equal(out.reason, 'not-resettable', `只有 failed / needs-info / gone 能重开：${JSON.stringify(out)}`)
    assert.match(out.text, /是否处理/, '要教人去表格里拨，而不是让人以为按钮坏了')
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
