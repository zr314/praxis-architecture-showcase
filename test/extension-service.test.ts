import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatProvider, RuntimePlugin } from '@praxis/core-sdk'
import { ExtensionService } from '../apps/runtime/src/extensions/index.js'
import type { Planner } from '../apps/runtime/src/planner-api/index.js'
import { PluginManager } from '../apps/runtime/src/plugin/pluginManager.js'

const provider: ChatProvider = {
  id: 'mock',
  defaultModel: 'test-model',
  authState: () => ({ status: 'authenticated' }),
  async *stream() {
    yield { type: 'completed' as const }
  },
}

const planner: Planner = { execute: async () => {} }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function assertPending(promise: Promise<unknown>): Promise<void> {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(settled, false)
}

function lifecyclePlugin(lifecycle: string[]): RuntimePlugin {
  let registrationsComplete = false
  return {
    manifest: {
      id: 'test.builtin',
      version: '1.0.0',
      apiVersion: 1,
      isolation: 'in-process',
      capabilities: ['llm-provider', 'tool', 'planner'],
    },
    async start(context) {
      lifecycle.push('start')
      context.registerProvider({ id: provider.id, kind: 'llm-provider' }, () => provider)
      context.registerTool({ id: 'test-tool', kind: 'tool' }, () => {
        assert.equal(registrationsComplete, true)
        lifecycle.push('assemble:tool')
        return {
          definition: { name: 'test-tool', description: 'test tool', parameters: {} },
          execute: async () => ({ ok: true, summary: 'ok' }),
        }
      })
      context.registerPlanner({ id: 'agent-task', kind: 'planner' }, () => {
        assert.equal(registrationsComplete, true)
        lifecycle.push('assemble:planner')
        return planner
      })
      registrationsComplete = true
    },
    async stop() {
      lifecycle.push('stop')
    },
  }
}

test('ExtensionService installs built-ins once and publishes assembled capabilities', async () => {
  const lifecycle: string[] = []
  const extensions = new ExtensionService({
    manager: new PluginManager(),
    builtin: lifecyclePlugin(lifecycle),
  })

  const [first, second] = await Promise.all([extensions.initialize(), extensions.initialize()])

  assert.equal(first, second)
  assert.deepEqual(lifecycle, ['start', 'assemble:tool', 'assemble:planner'])
  assert.deepEqual(
    first.tools.definitions().map((tool) => tool.name),
    ['test-tool', 'artifact_read'],
  )
  assert.equal(first.planner, planner)
  assert.deepEqual(extensions.providerIds(), ['mock'])
  assert.equal(await extensions.provider('mock'), provider)
  assert.equal(await extensions.provider('missing'), undefined)

  await extensions.shutdown()
})

test('ExtensionService shutdown is idempotent', async () => {
  const lifecycle: string[] = []
  const extensions = new ExtensionService({
    manager: new PluginManager(),
    builtin: lifecyclePlugin(lifecycle),
  })
  await extensions.initialize()

  await Promise.all([extensions.shutdown(), extensions.shutdown()])
  await extensions.shutdown()

  assert.equal(lifecycle.filter((event) => event === 'stop').length, 1)
  assert.deepEqual(extensions.providerIds(), [])
  assert.equal(await extensions.provider('mock'), undefined)
})

test('ExtensionService exposes no partial snapshot when initialization fails', async () => {
  let stops = 0
  const failingBuiltin: RuntimePlugin = {
    manifest: {
      id: 'test.failing-builtin',
      version: '1.0.0',
      apiVersion: 1,
      isolation: 'in-process',
      capabilities: ['llm-provider', 'tool', 'planner'],
    },
    async start(context) {
      context.registerProvider({ id: provider.id, kind: 'llm-provider' }, () => provider)
      context.registerTool({ id: 'broken-tool', kind: 'tool' }, () => {
        throw new Error('tool assembly failed')
      })
      context.registerPlanner({ id: 'agent-task', kind: 'planner' }, () => planner)
    },
    async stop() {
      stops += 1
    },
  }
  const extensions = new ExtensionService({
    manager: new PluginManager(),
    builtin: failingBuiltin,
  })

  await assert.rejects(extensions.initialize(), /tool assembly failed/)

  assert.deepEqual(extensions.providerIds(), [])
  assert.equal(await extensions.provider('mock'), undefined)
  assert.equal(stops, 1)
  await extensions.shutdown()
  assert.equal(stops, 1)
})

test('ExtensionService shutdown waits for asynchronous plugin start and prevents publication', async () => {
  const startEntered = deferred()
  const releaseStart = deferred()
  let stops = 0
  const builtin: RuntimePlugin = {
    manifest: {
      id: 'test.gated-start',
      version: '1.0.0',
      apiVersion: 1,
      isolation: 'in-process',
      capabilities: ['llm-provider', 'tool', 'planner'],
    },
    async start(context) {
      startEntered.resolve()
      await releaseStart.promise
      context.registerProvider({ id: provider.id, kind: 'llm-provider' }, () => provider)
      context.registerTool({ id: 'test-tool', kind: 'tool' }, () => ({
        definition: { name: 'test-tool', description: 'test tool', parameters: {} },
        execute: async () => ({ ok: true, summary: 'ok' }),
      }))
      context.registerPlanner({ id: 'agent-task', kind: 'planner' }, () => planner)
    },
    async stop() {
      stops += 1
    },
  }
  const extensions = new ExtensionService({ manager: new PluginManager(), builtin })

  const initializing = extensions.initialize()
  await startEntered.promise
  const shuttingDown = extensions.shutdown()
  await assertPending(shuttingDown)

  releaseStart.resolve()
  await assert.rejects(initializing, /shut down/)
  await shuttingDown

  assert.deepEqual(extensions.providerIds(), [])
  assert.equal(await extensions.provider('mock'), undefined)
  assert.equal(stops, 1)
  await extensions.shutdown()
  assert.equal(stops, 1)
})

test('ExtensionService shutdown waits for capability assembly and prevents publication', async () => {
  const assemblyEntered = deferred()
  const releaseAssembly = deferred()
  let stops = 0
  const builtin: RuntimePlugin = {
    manifest: {
      id: 'test.gated-assembly',
      version: '1.0.0',
      apiVersion: 1,
      isolation: 'in-process',
      capabilities: ['llm-provider', 'tool', 'planner'],
    },
    async start(context) {
      context.registerProvider({ id: provider.id, kind: 'llm-provider' }, () => provider)
      context.registerTool({ id: 'test-tool', kind: 'tool' }, async () => {
        assemblyEntered.resolve()
        await releaseAssembly.promise
        return {
          definition: { name: 'test-tool', description: 'test tool', parameters: {} },
          execute: async () => ({ ok: true, summary: 'ok' }),
        }
      })
      context.registerPlanner({ id: 'agent-task', kind: 'planner' }, () => planner)
    },
    async stop() {
      stops += 1
    },
  }
  const extensions = new ExtensionService({ manager: new PluginManager(), builtin })

  const initializing = extensions.initialize()
  await assemblyEntered.promise
  const shuttingDown = extensions.shutdown()
  await assertPending(shuttingDown)

  releaseAssembly.resolve()
  await assert.rejects(initializing, /shut down/)
  await shuttingDown

  assert.deepEqual(extensions.providerIds(), [])
  assert.equal(await extensions.provider('mock'), undefined)
  assert.equal(stops, 1)
  await extensions.shutdown()
  assert.equal(stops, 1)
})

test('ExtensionService retries atomically after failed assembly and shares the new attempt', async () => {
  const retryAssemblyEntered = deferred()
  const releaseRetryAssembly = deferred()
  let starts = 0
  let stops = 0
  const builtin: RuntimePlugin = {
    manifest: {
      id: 'test.retry',
      version: '1.0.0',
      apiVersion: 1,
      isolation: 'in-process',
      capabilities: ['llm-provider', 'tool', 'planner'],
    },
    async start(context) {
      starts += 1
      const attempt = starts
      context.registerProvider({ id: provider.id, kind: 'llm-provider' }, () => provider)
      context.registerTool({ id: 'test-tool', kind: 'tool' }, async () => {
        if (attempt === 1) throw new Error('first assembly failed')
        retryAssemblyEntered.resolve()
        await releaseRetryAssembly.promise
        return {
          definition: { name: 'test-tool', description: 'test tool', parameters: {} },
          execute: async () => ({ ok: true, summary: 'ok' }),
        }
      })
      context.registerPlanner({ id: 'agent-task', kind: 'planner' }, () => planner)
    },
    async stop() {
      stops += 1
    },
  }
  const extensions = new ExtensionService({ manager: new PluginManager(), builtin })

  await assert.rejects(extensions.initialize(), /first assembly failed/)
  assert.equal(starts, 1)
  assert.equal(stops, 1)
  assert.deepEqual(extensions.providerIds(), [])

  const firstRetry = extensions.initialize()
  const secondRetry = extensions.initialize()
  void firstRetry.catch(() => undefined)
  void secondRetry.catch(() => undefined)
  assert.equal(firstRetry, secondRetry)
  await retryAssemblyEntered.promise
  assert.equal(starts, 2)
  releaseRetryAssembly.resolve()

  const [firstReady, secondReady] = await Promise.all([firstRetry, secondRetry])
  assert.equal(firstReady, secondReady)
  assert.deepEqual(extensions.providerIds(), ['mock'])
  assert.equal(await extensions.provider('mock'), provider)

  await extensions.shutdown()
  assert.equal(stops, 2)
})

test('ExtensionService shares an initialization attempt reentered synchronously from plugin start', async () => {
  const startEntered = deferred()
  let starts = 0
  let stops = 0
  let extensions!: ExtensionService
  let reentered!: ReturnType<ExtensionService['initialize']>
  const builtin: RuntimePlugin = {
    manifest: {
      id: 'test.reentrant-initialize',
      version: '1.0.0',
      apiVersion: 1,
      isolation: 'in-process',
      capabilities: ['llm-provider', 'tool', 'planner'],
    },
    async start(context) {
      starts += 1
      if (starts === 1) reentered = extensions.initialize()
      context.registerProvider({ id: provider.id, kind: 'llm-provider' }, () => provider)
      context.registerTool({ id: 'test-tool', kind: 'tool' }, () => ({
        definition: { name: 'test-tool', description: 'test tool', parameters: {} },
        execute: async () => ({ ok: true, summary: 'ok' }),
      }))
      context.registerPlanner({ id: 'agent-task', kind: 'planner' }, () => planner)
      startEntered.resolve()
    },
    async stop() {
      stops += 1
    },
  }
  extensions = new ExtensionService({ manager: new PluginManager(), builtin })

  const initializing = extensions.initialize()
  void initializing.catch(() => undefined)
  await startEntered.promise
  void reentered.catch(() => undefined)

  assert.equal(reentered, initializing)
  const [firstReady, secondReady] = await Promise.all([initializing, reentered])
  assert.equal(firstReady, secondReady)
  assert.equal(starts, 1)
  assert.deepEqual(extensions.providerIds(), ['mock'])

  await extensions.shutdown()
  assert.equal(stops, 1)
})

test('ExtensionService completes terminal shutdown reentered synchronously from plugin start', async () => {
  const startEntered = deferred()
  let starts = 0
  let stops = 0
  let extensions!: ExtensionService
  let reenteredShutdown!: Promise<void>
  const builtin: RuntimePlugin = {
    manifest: {
      id: 'test.reentrant-shutdown',
      version: '1.0.0',
      apiVersion: 1,
      isolation: 'in-process',
      capabilities: ['llm-provider', 'tool', 'planner'],
    },
    async start(context) {
      starts += 1
      reenteredShutdown = extensions.shutdown()
      context.registerProvider({ id: provider.id, kind: 'llm-provider' }, () => provider)
      context.registerTool({ id: 'test-tool', kind: 'tool' }, () => ({
        definition: { name: 'test-tool', description: 'test tool', parameters: {} },
        execute: async () => ({ ok: true, summary: 'ok' }),
      }))
      context.registerPlanner({ id: 'agent-task', kind: 'planner' }, () => planner)
      startEntered.resolve()
    },
    async stop() {
      stops += 1
    },
  }
  extensions = new ExtensionService({ manager: new PluginManager(), builtin })

  const initializing = extensions.initialize()
  void initializing.catch(() => undefined)
  await startEntered.promise
  await assertPending(reenteredShutdown)

  await assert.rejects(initializing, /shut down/)
  await reenteredShutdown

  assert.equal(starts, 1)
  assert.equal(stops, 1)
  assert.deepEqual(extensions.providerIds(), [])
  assert.equal(await extensions.provider('mock'), undefined)
  assert.equal(extensions.shutdown(), reenteredShutdown)
  await assert.rejects(extensions.initialize(), /shut down/)
})
