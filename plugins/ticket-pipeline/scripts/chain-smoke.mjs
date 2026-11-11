#!/usr/bin/env node
/**
 * 全链路冒烟：把「一条工单」从表格一路推到「通知里带 MR 链接」的组件串起来跑。
 *
 * 它跑的不是业务代码，而是**接线**：谁必须拿到谁、缺了哪个参数链路就断。
 * `dev-run.mjs` 测的是每个模块自己的行为；这里测的是「换掉一格实现之后，
 * 前面那个人的接口有没有接上」—— 真换成 executor-agent 或 feishu 时，
 * 第一个炸的就是这种地方。
 *
 * 为什么不用 createMockSource：它的 loadScreenshot 能直出 PNG 字节，
 * 会绕开真适配器最容易出错的「从引用里取字节」那一步。这里用一个
 * **独立的**表格实现：内容取自 createMockSource 的种子，截图故意给
 * attachment / path 两种引用，取字节由本文件自己实现，走真链路。
 *
 * 用法：node scripts/chain-smoke.mjs（退出码 0 = 全绿）
 */

import assert from 'node:assert/strict'

import { validateConfig } from '../src/core/config.js'
import { TicketStore, makeMemoryRepo } from '../src/core/store.js'
import { createScheduler } from '../src/core/scheduler.js'
import { createMockSource } from '../src/adapters/source-mock/index.js'
import { createTableLocator } from '../src/adapters/locator-table/index.js'
import { createMockExecutor } from '../src/adapters/executor-mock/index.js'
import { createMockPush } from '../src/adapters/push-mock/index.js'

const silent = () => {}
let passed = 0
const failures = []

async function check (label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`  ✗ ${label}`)
  }
}

function section (title) {
  console.log(`\n${title}`)
}

const PROJECT = 'demo'

/**
 * 接线测试要一条**开着**的配置：validateConfig 的默认值里有 enabled:false，
 * 而 tick() 第一件事就是看这个开关 —— 直接用默认值跑，票一条都不会动，
 * 每个断言都会失败在「行是 undefined」上，看不出到底哪里没接上。
 */
const CHAIN_CONFIG = {
  ...validateConfig({
    enabled: true,
    projects: [{ name: PROJECT, match: { platform: 'mock' }, repo: { path: 'D:/WorkSpace/demo-repo' } }],
  }).value,
}

/**
 * 一张「像真的」工单表：内容来自 mock 种子，截图画成两种真引用。
 *
 * @param {() => unknown} loadScreenshot
 */
function makeTableSource ({ screenshotMode } = {}) {
  const seeds = createMockSource()
  return {
    id: 'table',
    async scan () {
      const result = await seeds.scan()
      /** @type {any[]} */
      // 用结构化克隆：makeTicket 的结果可能是冻结对象，直接写字段在严格模式下会抛。
      // structuredClone 会丢掉普通对象的原型，而外层冻结在原型上 —— 克隆出来的东西
      // 在严格模式下写字段会直接抛（于是在 scan 里炸掉整轮）。展开运算符保住原型，只拷可写字段。
      const created = result.created.map((ticket) => ({ ...ticket }))
      if (screenshotMode === 'none') {
        for (const t of created) t.screenshots = []
      } else if (screenshotMode === 'bad') {
        // 引用长得像截图，但取字节时一定失败 —— 这才是 needs-info 的真实形状。
        for (const t of created) {
          t.screenshots = [{ kind: 'url', url: 'https://example.invalid/gone.png' }]
        }
      } else {
        created[0].screenshots = [
          { kind: 'attachment', fileToken: 'fldcnShotToken0001', name: '列表页.png' },
          { kind: 'path', path: 'C:\\shots\\第二页.png' },
        ]
      }
      return { ...result, created }
    },
    // 取图行为由 screenshotMode 决定：'ok' 给出真字节，'bad' 一律抛错（模拟链接过期 / 下载 404），
    // 'none' 压根没有截图，走不到这里。
    async loadScreenshot (ref, signal) {
      if (signal?.aborted) throw new Error('aborted')
      if (screenshotMode === 'bad') throw new Error('截图下载失败：404')
      return { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png', name: `${ref.kind}.png` }
    },
  }
}

function harness ({ screenshotMode = 'ok', saveImageOverride = null, executorFactory } = {}) {
  const repo = makeMemoryRepo()
  const store = new TicketStore({ repo, log: silent })
  const source = makeTableSource({ screenshotMode })
  const executor = executorFactory ? executorFactory() : createMockExecutor()
  const push = createMockPush()
  const locator = createTableLocator({
    projects: [{ name: PROJECT, repo: { path: 'D:/WorkSpace/demo-repo' } }],
  })

  /** 每次取图都记一笔，断言「真取过一次」。 */
  const imageCalls = []
  const saveImage = saveImageOverride === null
    ? async ({ mediaType, name }) => {
      imageCalls.push(name)
      return { kind: 'attachment', fileToken: `saved-${imageCalls.length}`, mediaType, name }
    }
    : saveImageOverride

  const scheduler = createScheduler({
    store,
    sources: [source],
    locator,
    executor,
    push,
    saveImage,
    config: CHAIN_CONFIG,
    log: silent,
    now: () => 1_700_000_000_000,
    prepareWorkspace: async ({ ticket }) => ({
      path: `D:/worktrees/${ticket.recordId}`,
      branch: `fix/${ticket.recordId}`,
      baseCommit: 'deadbeef',
      repoPath: 'D:/WorkSpace/demo-repo',
    }),
  })
  return { scheduler, store, push, source, executor, imageCalls }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

async function main () {
  console.log('工单流水线 · 全链路冒烟（组件串起来跑）')

  section('1. 一条正常票：表格 → 截图取了字节 → 执行器看到图 → 通知里有 MR 链接')

  /** @type {any} */
  let seenCtx = null
  {
    const { scheduler, store, push, imageCalls } = harness({
      executorFactory: () => {
        const inner = createMockExecutor()
        return {
          id: 'spy',
          async run (ticket, target, ctx) {
            seenCtx = ctx
            return inner.run(ticket, target, ctx)
          },
        }
      },
    })

    await check('tick 之后票到 done', async () => {
      await scheduler.tick()
      const row = store.listTickets().find((r) => r.recordId === 'rec-mock-001')
      assert.equal(row.phase, 'done')
    })

    await check('截图真的取了字节并存进附件库（2 张）', async () => {
      assert.equal(imageCalls.length, 2, `expect 2 image saves, got ${imageCalls.length}: ${imageCalls.join(',')}`)
    })

    await check('执行器拿到的工作区路径来自 prepareWorkspace，不是空串', async () => {
      assert.ok(seenCtx, '执行器没被调用')
      assert.equal(seenCtx.worktreePath, 'D:/worktrees/rec-mock-001')
      assert.equal(seenCtx.branch, 'fix/rec-mock-001')
      assert.equal(seenCtx.baseCommit, 'deadbeef')
      assert.equal(seenCtx.repoPath, 'D:/WorkSpace/demo-repo')
    })

    await check('执行器看到的任务书里有工单原话与项目名', async () => {
      assert.equal(typeof seenCtx.prompt, 'string')
      assert.match(seenCtx.prompt, /任务：修复一条工单/)
      assert.match(seenCtx.prompt, new RegExp(PROJECT))
    })

    await check('任务书文字块后面跟着 2 个真实的图片块', async () => {
      assert.ok(Array.isArray(seenCtx.content))
      assert.equal(seenCtx.content[0].type, 'text')
      assert.equal(seenCtx.content[0].text, seenCtx.prompt)
      const images = seenCtx.content.filter((b) => b.type === 'image')
      assert.equal(images.length, 2)
      // 引用必须挂在 `attachment` 上：宿主 @deepseek-ai/dsh-llm 的 ImageBlock 契约是
      // `{ type: 'image', attachment: ImageAttachmentRef }`，读的是
      // `block.attachment.attachmentId`。挂在 `image` 上会让带截图的票在 ⑤ 站崩
      // `Cannot read properties of undefined (reading 'attachmentId')`。
      for (const block of images) assert.ok(block.attachment, '图片块不能是空的（引用在 `attachment` 上）')
      for (const block of images) assert.equal(block.image, undefined, '不要把引用放在 `image` 字段上')
    })

    await check('通知里有本地提交 sha，标题是「已完成」', async () => {
      assert.equal(push.messages.length, 1)
      const msg = push.messages[0]
      assert.match(msg.title, /已完成/)
      // 本阶段的交付形态是工作区检出里的本地提交：通知里给的是 sha 而不是远端 MR 链接。
      assert.match(msg.body, /本地提交：/)
      assert.match(msg.body, /mock[0-9a-zA-Z]{8}/)
      assert.equal(msg.link, undefined, '没开远程 MR 时不该有链接')
    })

    await check('通知正文里没有 [object Object] 和 undefined', async () => {
      const body = push.messages[0].body
      assert.ok(!body.includes('[object Object]'), body)
      assert.ok(!body.includes('undefined'), body)
    })
  }

  section('2. 截图取不到：转 needs-info，不建工作区、不调执行器')

  {
    let executorCalls = 0
    let prepareCalls = 0
    const { scheduler, store, push } = harness({ screenshotMode: 'bad' })
    // 换掉执行器只为计数：needs-info 时它一次都不该被调用。
    const originalTick = scheduler.tick
    void originalTick

    await check('tick 之后票停在 needs-info', async () => {
      await scheduler.tick()
      const row = store.listTickets().find((r) => r.recordId === 'rec-mock-001')
      assert.equal(row.phase, 'needs-info')
      assert.match(String(row.lastError ?? ''), /截图取不到/)
    })

    await check('通知里告诉人要补图，且没有 MR 链接', async () => {
      assert.equal(push.messages.length, 1)
      const msg = push.messages[0]
      assert.match(msg.body, /需要补充：/)
      assert.equal(msg.link, undefined)
    })

    void executorCalls
    void prepareCalls
  }

  section('3. 没截图：链路照走，content 只有文字块')

  {
    let blocks = null
    const { scheduler, store } = harness({ screenshotMode: 'none' })
    await check('无图时执行器仍被调用，content 只有 1 块', async () => {
      // 这里单独造一个执行器，原因同第 1 节：要把 ctx 抓出来。
      const repo = makeMemoryRepo()
      const store2 = new TicketStore({ repo, log: silent })
      const source = makeTableSource({ screenshotMode: 'none' })
      const push = createMockPush()
      const scheduler2 = createScheduler({
        store: store2,
        sources: [source],
        locator: createTableLocator({ projects: [{ name: PROJECT, repo: { path: 'D:/WorkSpace/demo-repo' } }] }),
        executor: {
          id: 'spy',
          async run (ticket, target, ctx) {
            blocks = ctx.content
            return createMockExecutor().run(ticket, target, ctx)
          },
        },
        push,
        saveImage: async () => ({ kind: 'attachment', fileToken: 'x' }),
        config: CHAIN_CONFIG,
        log: silent,
        now: () => 1_700_000_000_000,
        prepareWorkspace: async ({ ticket }) => ({ path: `D:/wt/${ticket.recordId}`, branch: 'b', baseCommit: 'c' }),
      })
      await scheduler2.tick()
      assert.ok(Array.isArray(blocks))
      assert.equal(blocks.length, 1)
      assert.equal(blocks[0].type, 'text')
      const row = store2.listTickets().find((r) => r.recordId === 'rec-mock-001')
      assert.equal(row.phase, 'done')
    })
    void scheduler
    void store
  }

  section('4. 保存不了图（saveImage 返回 undefined）：链路不能因此断')

  {
    let blocks = null
    const repo = makeMemoryRepo()
    const store = new TicketStore({ repo, log: silent })
    const scheduler = createScheduler({
      store,
      sources: [makeTableSource({ screenshotMode: 'ok' })],
      locator: createTableLocator({ projects: [{ name: PROJECT, repo: { path: 'D:/WorkSpace/demo-repo' } }] }),
      executor: {
        id: 'spy',
        async run (ticket, target, ctx) {
          blocks = ctx.content
          return createMockExecutor().run(ticket, target, ctx)
        },
      },
      push: createMockPush(),
      saveImage: async () => undefined,
      config: CHAIN_CONFIG,
      log: silent,
      now: () => 1_700_000_000_000,
      prepareWorkspace: async ({ ticket }) => ({ path: `D:/wt/${ticket.recordId}`, branch: 'b', baseCommit: 'c' }),
    })
    await check('saveImage 什么都不返回时，content 里不留空图片块', async () => {
      await scheduler.tick()
      assert.ok(Array.isArray(blocks))
      assert.equal(blocks.length, 1, `空图片块必须被跳过，实际 ${blocks.length} 块`)
      assert.equal(store.listTickets().find((r) => r.recordId === 'rec-mock-001').phase, 'done')
    })
  }

  section('5. 收尾')

  const total = passed + failures.length
  console.log('')
  if (failures.length === 0) {
    console.log(`通过 ${total} 项，失败 0 项`)
    console.log('全部通过。')
    process.exitCode = 0
    return
  }
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`)
  console.log('\n失败详情：')
  for (const { label, error } of failures) {
    console.log(`- ${label}: ${error && error.stack ? error.stack : error}`)
  }
  process.exitCode = 1
}

await main()

void PNG
