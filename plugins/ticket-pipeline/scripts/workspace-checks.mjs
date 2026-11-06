/**
 * `workspace-checks.mjs` —— 项目工作区（宿主 `workspaceRegistry`）这一层的离线自测。
 *
 * 守护的是用户提的那条要求：**工单进来后，先看本机有没有这个项目的工作区；
 * 有就在里面建会话处理，没有就先建工作区再处理。**
 *
 * 这里不碰真的 `~/.dsh/storages/workspace.json` —— 用假 registry 把宿主那几条
 * 硬约束原样复现（目录不存在要 reject、create 幂等、attachSession 校验 cwd），
 * 断言我们的调用顺序与降级行为，而不是断言宿主自己怎么实现。
 */

import assert from 'node:assert/strict'

import { createProjectWorkspaceManager } from '../src/core/workspace.js'
import { PipelineError } from '../src/contracts/errors.js'

/**
 * 造一个假的宿主 `fs` 服务：只实现 workspace.js 用到的三个方法，
 * 存在性由传进来的 Set 决定。
 *
 * @param {Set<string>} existingDirs
 */
function makeFakeFs (existingDirs) {
  return {
    resolve: async (path) => {
      if (!existingDirs.has(path)) throw new Error(`ENOENT: no such file or directory, realpath '${path}'`)
      return { targetKey: path, displayPath: path }
    },
    stat: async (target) => {
      if (!existingDirs.has(target.targetKey)) return undefined
      return { version: 1, type: 'directory' }
    },
    processPath: (target) => target.targetKey,
  }
}

/**
 * 造一个假的宿主 `workspaceRegistry`：复现三条真实行为 ——
 * 1. `create` 要求目录已存在（不存在就 reject）；
 * 2. `create` 对同一路径幂等（返回既有实体，不新增）；
 * 3. `resolveByPath` 只在「目录存在但没登记」时返回 undefined。
 *
 * @param {Set<string>} existingDirs
 */
function makeFakeRegistry (existingDirs) {
  /** @type {Map<string, any>} */
  const byPath = new Map()
  /** @type {Map<string, any>} */
  const byId = new Map()
  const calls = { create: [], resolveByPath: [], attach: [] }
  let nextId = 1

  const workspaceRegistry = {
    async resolveByPath (path) {
      calls.resolveByPath.push(path)
      if (!existingDirs.has(path)) throw new Error(`ENOENT: realpath '${path}'`)
      return byPath.get(path)
    },
    async create (path, title) {
      calls.create.push({ path, title })
      if (!existingDirs.has(path)) throw new Error(`ENOENT: realpath '${path}'`)
      const existing = byPath.get(path)
      if (existing) return existing
      const workspace = {
        id: `ws-${nextId++}`,
        path,
        title: title ?? path,
        sessionIds: [],
        async attachSession (sessionId) {
          calls.attach.push({ workspaceId: workspace.id, sessionId })
          // 宿主的真实约束：会话 header 的规范 cwd 必须等于工作区路径。
          // 自测里由调用方把「会话 cwd」塞进 sessions 表，这里只校验它挂在哪个工作区下。
          workspace.sessionIds.push(sessionId)
        },
      }
      byPath.set(path, workspace)
      byId.set(workspace.id, workspace)
      return workspace
    },
    get (id) {
      return byId.get(id)
    },
    list () {
      return [...byId.values()]
    },
  }
  return { workspaceRegistry, calls }
}

/**
 * @param {(name: string, fn: () => Promise<void> | void) => Promise<void>} check
 */
export async function runWorkspaceChecks (check) {
  await check('工作区：目录不存在时给一条能照着做的报错，不是 ENOENT 原文', async () => {
    const dirs = new Set()
    const manager = createProjectWorkspaceManager({ workspaceRegistry: makeFakeRegistry(dirs).workspaceRegistry, fs: makeFakeFs(dirs) })
    await assert.rejects(
      () => manager.ensureProjectWorkspace({ path: 'D:/WorkSpace/not-there' }),
      (error) => {
        assert.ok(error instanceof PipelineError, '必须是 PipelineError，内核才能按 kind 分档')
        assert.equal(error.kind, 'invalid-input', '目录不存在重试也没用，不能被当成可重试错误')
        assert.match(error.message, /项目工作区目录不存在/)
        assert.match(error.message, /不会替你克隆或创建目录/, '要说清插件不负责建目录')
        return true
      },
    )
  })

  await check('工作区：没有 repo.path 时报 invalid-input 并指出该配哪里', async () => {
    const manager = createProjectWorkspaceManager({})
    for (const path of ['', '   ', undefined]) {
      await assert.rejects(
        () => manager.ensureProjectWorkspace({ path }),
        (error) => {
          assert.equal(error.kind, 'invalid-input')
          assert.match(error.message, /repo\.path/)
          return true
        },
        `path=${JSON.stringify(path)} 应该被拒`,
      )
    }
  })

  await check('工作区：没登记过就建一条，并把路径与 id 带回来', async () => {
    const dirs = new Set(['D:/WorkSpace/mgiot-pms'])
    const { workspaceRegistry, calls } = makeFakeRegistry(dirs)
    const manager = createProjectWorkspaceManager({ workspaceRegistry, fs: makeFakeFs(dirs) })
    const out = await manager.ensureProjectWorkspace({ path: 'D:/WorkSpace/mgiot-pms', title: 'pms' })
    assert.equal(out.registered, true)
    assert.equal(out.created, true, '第一次应该是新建')
    assert.equal(out.workspacePath, 'D:/WorkSpace/mgiot-pms')
    assert.match(out.workspaceId, /^ws-\d+$/)
    assert.equal(calls.create.length, 1)
    assert.equal(calls.create[0].title, 'pms', '标题用项目名，GUI 里显示的就是这个')
  })

  await check('工作区：已经登记过就复用，不再写登记表', async () => {
    const dirs = new Set(['D:/WorkSpace/mgiot-pms'])
    const { workspaceRegistry, calls } = makeFakeRegistry(dirs)
    const manager = createProjectWorkspaceManager({ workspaceRegistry, fs: makeFakeFs(dirs) })
    const first = await manager.ensureProjectWorkspace({ path: 'D:/WorkSpace/mgiot-pms', title: 'pms' })
    const second = await manager.ensureProjectWorkspace({ path: 'D:/WorkSpace/mgiot-pms', title: '改个名字' })
    assert.equal(calls.create.length, 1, '第二次不该再 create')
    assert.equal(second.created, false, '第二次是复用')
    assert.equal(second.workspaceId, first.workspaceId, '必须是同一个工作区')
    // 顺序是有意义的：先 resolveByPath 查、查不到才 create。
    // 反过来的话每张票都会把工作区在 GUI 列表里顶到最前面。
    assert.equal(calls.resolveByPath.length, 2, '每次都先查一遍')
  })

  await check('工作区：create 是幂等的（宿主保证），重复调用不会建出第二个', async () => {
    const dirs = new Set(['D:/repo'])
    const { workspaceRegistry } = makeFakeRegistry(dirs)
    const a = await workspaceRegistry.create('D:/repo', 'a')
    const b = await workspaceRegistry.create('D:/repo', 'b')
    assert.equal(a.id, b.id, '同一路径必须是同一个工作区')
    assert.equal(a.title, 'a', '重复 create 不该改标题（宿主原文行为）')
  })

  await check('工作区：本机没有 workspaceRegistry 服务时降级，不抛错', async () => {
    const dirs = new Set(['D:/repo'])
    const logs = []
    const manager = createProjectWorkspaceManager({ fs: makeFakeFs(dirs), log: (msg) => logs.push(msg) })
    const out = await manager.ensureProjectWorkspace({ path: 'D:/repo' })
    assert.equal(out.registered, false, '没服务就是没登记')
    assert.equal(out.workspacePath, 'D:/repo', '但路径还是要给出来，工单得继续修')
    assert.equal(out.workspaceId, undefined)
    assert.ok(logs.some((m) => m.includes('workspaceRegistry')), '要在日志里说清为什么没登记')
  })

  await check('工作区：registry.create 抛错时降级继续跑票，不让整张票死掉', async () => {
    const dirs = new Set(['D:/repo'])
    const logs = []
    const brokenRegistry = {
      resolveByPath: async () => undefined,
      create: async () => { throw new Error('宿主：登记表写不进去') },
    }
    const manager = createProjectWorkspaceManager({
      workspaceRegistry: brokenRegistry,
      fs: makeFakeFs(dirs),
      log: (msg) => logs.push(msg),
    })
    const out = await manager.ensureProjectWorkspace({ path: 'D:/repo' })
    assert.equal(out.registered, false, '登记失败')
    assert.equal(out.workspacePath, 'D:/repo', '但目录还在，该修的问题还得修')
    assert.ok(logs.some((m) => m.includes('登记失败')), '要让排障的人看见登记失败')
  })

  await check('工作区：没装 fs 服务时交给 registry 自己判存在性', async () => {
    const dirs = new Set(['D:/repo'])
    const { workspaceRegistry, calls } = makeFakeRegistry(dirs)
    const manager = createProjectWorkspaceManager({ workspaceRegistry })
    const out = await manager.ensureProjectWorkspace({ path: 'D:/repo' })
    assert.equal(out.workspacePath, 'D:/repo')
    assert.equal(calls.create.length, 1)
  })

  await check('工作区：fs 说不是目录（是文件）也一样拒掉', async () => {
    const fs = {
      resolve: async (path) => ({ targetKey: path, displayPath: path }),
      stat: async () => ({ version: 1, type: 'file', size: 10 }),
      processPath: (target) => target.targetKey,
    }
    const dirs = new Set(['D:/repo/README.md'])
    const manager = createProjectWorkspaceManager({ workspaceRegistry: makeFakeRegistry(dirs).workspaceRegistry, fs })
    await assert.rejects(
      () => manager.ensureProjectWorkspace({ path: 'D:/repo/README.md' }),
      (error) => {
        assert.match(error.message, /项目工作区目录不存在/)
        return true
      },
    )
  })

  await check('工作区：同一项目多张票复用同一个工作区（不是每票一个）', async () => {
    const dirs = new Set(['D:/repo'])
    const { workspaceRegistry, calls } = makeFakeRegistry(dirs)
    const manager = createProjectWorkspaceManager({ workspaceRegistry, fs: makeFakeFs(dirs) })
    const ids = []
    for (const recordId of ['rec-1', 'rec-2', 'rec-3']) {
      const out = await manager.ensureProjectWorkspace({ path: 'D:/repo', title: `pms-${recordId}` })
      ids.push(out.workspaceId)
    }
    assert.equal(new Set(ids).size, 1, '同一个项目目录只有一个工作区')
    assert.equal(calls.create.length, 1, '后面两张票都该复用')
  })

  await check('工作区：会话能挂到工作区名下（attachSession 走的是 workspace id）', async () => {
    const dirs = new Set(['D:/repo'])
    const { workspaceRegistry, calls } = makeFakeRegistry(dirs)
    const manager = createProjectWorkspaceManager({ workspaceRegistry, fs: makeFakeFs(dirs) })
    const { workspaceId } = await manager.ensureProjectWorkspace({ path: 'D:/repo' })
    const workspace = workspaceRegistry.get(workspaceId)
    assert.ok(workspace, '按 id 能取回工作区')
    await workspace.attachSession('ticket-pms-rec-1-1700000000000')
    assert.equal(calls.attach.length, 1)
    assert.equal(calls.attach[0].workspaceId, workspaceId)
    assert.deepEqual(workspace.sessionIds, ['ticket-pms-rec-1-1700000000000'])
  })
}
