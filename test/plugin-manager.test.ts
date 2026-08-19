import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatProvider, RuntimePlugin } from '@praxis/core-sdk'
import { BuiltinPlugin } from '../apps/runtime/src/plugin/builtinPlugin.js'
import { PluginManager } from '../apps/runtime/src/plugin/pluginManager.js'
import { ProcessPluginHost } from '../apps/runtime/src/plugin/processPluginHost.js'
import {
  isProcessPluginMessage,
  isProcessPluginResponseFor,
} from '../apps/runtime/src/plugin/processPluginProtocol.js'

const manifest = (
  id: string,
  capabilities: RuntimePlugin['manifest']['capabilities'],
): RuntimePlugin['manifest'] => ({
  id,
  version: '1.0.0',
  apiVersion: 1,
  isolation: 'in-process',
  capabilities,
})

const provider: ChatProvider = {
  id: 'provider',
  defaultModel: 'test-model',
  authState: () => ({ status: 'authenticated' }),
  async *stream() {
    yield { type: 'completed' as const }
  },
}

function toolPlugin(
  pluginId: string,
  capabilityId: string,
  lifecycle: string[] = [],
): RuntimePlugin {
  return {
    manifest: manifest(pluginId, ['tool']),
    async start(context) {
      lifecycle.push(`start:${pluginId}`)
      context.registerTool({ id: capabilityId, kind: 'tool', permission: 'none' }, () => ({
        definition: { name: capabilityId, description: 'test tool', parameters: {} },
        execute: async () => ({ ok: true, summary: 'ok' }),
      }))
    },
    async stop() {
      lifecycle.push(`stop:${pluginId}`)
    },
  }
}

test('PluginManager rejects duplicate capability IDs', async () => {
  const manager = new PluginManager()
  await manager.install(toolPlugin('one', 'read'))

  await assert.rejects(manager.install(toolPlugin('two', 'read')), (error: unknown) =>
    isRuntimeError(error, 'CAPABILITY_CONFLICT'),
  )
})

test('PluginManager validates manifests and declared capability kinds before lifecycle start', async () => {
  const manager = new PluginManager()
  const malformed: RuntimePlugin = {
    manifest: { ...manifest('', ['tool']) },
    async start() {},
    async stop() {},
  }
  await assert.rejects(manager.install(malformed), (error: unknown) =>
    isRuntimeError(error, 'INVALID_PLUGIN_MANIFEST'),
  )

  let started = false
  const undeclared: RuntimePlugin = {
    manifest: manifest('undeclared', ['tool']),
    async start(context) {
      started = true
      context.registerProvider({ id: 'provider', kind: 'llm-provider' }, () => provider)
    },
    async stop() {},
  }
  await assert.rejects(manager.install(undeclared), (error: unknown) =>
    isRuntimeError(error, 'UNDECLARED_CAPABILITY_KIND'),
  )
  assert.equal(started, true)
  assert.equal(await manager.provider('provider'), undefined)
})

test('PluginManager snapshots manifest and descriptor data, then closes its registrar', async () => {
  const manager = new PluginManager()
  const mutableManifest = manifest('mutable', ['tool']) as {
    capabilities: Array<'tool' | 'llm-provider'>
  } & RuntimePlugin['manifest']
  const mutableDescriptor = {
    id: 'stable-tool',
    kind: 'tool' as const,
    permission: 'none' as const,
  }
  let delayedRegistration: (() => void) | undefined
  const plugin: RuntimePlugin = {
    manifest: mutableManifest,
    async start(context) {
      mutableManifest.capabilities[0] = 'llm-provider'
      context.registerTool(mutableDescriptor, () => ({
        definition: { name: 'stable-tool', description: 'stable', parameters: {} },
        execute: async () => ({ ok: true, summary: 'ok' }),
      }))
      mutableDescriptor.id = 'mutated-tool'
      delayedRegistration = () =>
        context.registerTool({ id: 'late-tool', kind: 'tool' }, () => ({
          definition: { name: 'late-tool', description: 'late', parameters: {} },
          execute: async () => ({ ok: true, summary: 'ok' }),
        }))
    },
    async stop() {},
  }

  await manager.install(plugin)
  assert.deepEqual(manager.capabilityIds('tool'), ['stable-tool'])
  assert.equal(manager.toolDescriptor('stable-tool')?.permission, 'none')
  assert.throws(
    () => delayedRegistration?.(),
    (error: unknown) => isRuntimeError(error, 'REGISTRAR_CLOSED'),
  )
  await manager.stop()
})

test('PluginManager rejects staged collisions atomically without ghost capabilities', async () => {
  const manager = new PluginManager()
  await manager.install(toolPlugin('existing', 'taken'))
  const mutableDescriptor = { id: 'staged-first', kind: 'tool' as const }
  const collision: RuntimePlugin = {
    manifest: manifest('collision', ['tool']),
    async start(context) {
      context.registerTool(mutableDescriptor, () => ({
        definition: { name: 'staged-first', description: 'first', parameters: {} },
        execute: async () => ({ ok: true, summary: 'ok' }),
      }))
      mutableDescriptor.id = 'taken'
      context.registerTool({ id: 'taken', kind: 'tool' }, () => ({
        definition: { name: 'taken', description: 'collision', parameters: {} },
        execute: async () => ({ ok: true, summary: 'ok' }),
      }))
    },
    async stop() {},
  }

  await assert.rejects(manager.install(collision), (error: unknown) =>
    isRuntimeError(error, 'CAPABILITY_CONFLICT'),
  )
  assert.deepEqual(manager.capabilityIds('tool'), ['taken'])
  assert.equal(await manager.tool('staged-first'), undefined)
  await manager.stop()
})

test('PluginManager replaces a plugin only after staging, then unpublishes before stopping old code', async () => {
  const lifecycle: string[] = []
  const manager = new PluginManager()
  const versionedTool = (version: string): RuntimePlugin => ({
    manifest: { ...manifest('replaceable', ['tool']), version },
    async start(context) {
      lifecycle.push(`start:${version}`)
      context.registerTool({ id: 'shared', kind: 'tool' }, () => ({
        definition: { name: 'shared', description: version, parameters: {} },
        execute: async () => ({ ok: true, summary: version }),
      }))
    },
    async stop() {
      assert.equal(await manager.tool('shared'), undefined)
      lifecycle.push(`stop:${version}`)
    },
  })

  await manager.install(versionedTool('1.0.0'))
  await manager.replace(versionedTool('2.0.0'))

  assert.deepEqual(lifecycle, ['start:1.0.0', 'start:2.0.0', 'stop:1.0.0'])
  assert.equal((await manager.tool('shared'))?.definition.description, '2.0.0')
  assert.deepEqual(manager.pluginIds(), ['replaceable'])
  await manager.stop()
})

test('PluginManager keeps the previous publication when replacement staging fails', async () => {
  const manager = new PluginManager()
  await manager.install(toolPlugin('replaceable', 'shared'))
  const invalidReplacement: RuntimePlugin = {
    manifest: { ...manifest('replaceable', ['tool']), version: '2.0.0' },
    async start(context) {
      context.registerTool({ id: 'duplicate', kind: 'tool' }, () => ({
        definition: { name: 'duplicate', description: 'first', parameters: {} },
        execute: async () => ({ ok: true, summary: 'first' }),
      }))
      context.registerTool({ id: 'duplicate', kind: 'tool' }, () => ({
        definition: { name: 'duplicate', description: 'second', parameters: {} },
        execute: async () => ({ ok: true, summary: 'second' }),
      }))
    },
    async stop() {},
  }

  await assert.rejects(manager.replace(invalidReplacement), (error: unknown) =>
    isRuntimeError(error, 'CAPABILITY_CONFLICT'),
  )
  assert.equal((await manager.tool('shared'))?.definition.name, 'shared')
  assert.deepEqual(manager.pluginIds(), ['replaceable'])
  await manager.stop()
})

test('PluginManager starts in installation order, stops in reverse order, and creates registered capabilities', async () => {
  const lifecycle: string[] = []
  const manager = new PluginManager()
  await manager.install(toolPlugin('one', 'read', lifecycle))
  await manager.install({
    manifest: manifest('providers', ['llm-provider']),
    async start(context) {
      lifecycle.push('start:providers')
      context.registerProvider({ id: 'provider', kind: 'llm-provider' }, () => provider)
    },
    async stop() {
      lifecycle.push('stop:providers')
    },
  })

  assert.equal((await manager.tool('read'))?.definition.name, 'read')
  assert.equal((await manager.provider('provider'))?.id, 'provider')
  assert.deepEqual(manager.pluginIds(), ['one', 'providers'])

  await manager.stop()
  assert.deepEqual(lifecycle, ['start:one', 'start:providers', 'stop:providers', 'stop:one'])

  await manager.install(toolPlugin('reinstalled', 'read'))
  assert.equal((await manager.tool('read'))?.definition.name, 'read')
  await manager.stop()
})

test('capability registries reject factories that return a different stable capability ID', async () => {
  const manager = new PluginManager()
  await manager.install({
    manifest: manifest('mismatch', ['llm-provider', 'tool']),
    async start(context) {
      context.registerProvider({ id: 'registered-provider', kind: 'llm-provider' }, () => ({
        ...provider,
        id: 'returned-provider',
      }))
      context.registerTool({ id: 'registered-tool', kind: 'tool' }, async () => ({
        definition: { name: 'returned-tool', description: 'mismatch', parameters: {} },
        execute: async () => ({ ok: true, summary: 'ok' }),
      }))
    },
    async stop() {},
  })

  await assert.rejects(manager.provider('registered-provider'), (error: unknown) =>
    isRuntimeError(error, 'CAPABILITY_FACTORY_MISMATCH'),
  )
  await assert.rejects(manager.tool('registered-tool'), (error: unknown) =>
    isRuntimeError(error, 'CAPABILITY_FACTORY_MISMATCH'),
  )
  await manager.stop()
})

test('BuiltinPlugin exposes providers and tools, and registers the unified agent-task executor', async () => {
  const manager = new PluginManager()
  await manager.install(new BuiltinPlugin(() => ({ execute: async () => {} })))

  assert.deepEqual(manager.capabilityIds('llm-provider'), [
    'mock',
    'kimi',
    'deepseek',
    'anthropic',
    'openai',
    'qwen-token-plan',
    'qwen-token-plan-cn',
    'minimax',
    'minimax-cn',
    'openai-compatible',
    'openai-chat',
  ])
  assert.deepEqual(manager.capabilityIds('tool'), [
    'read',
    'glob',
    'grep',
    'ls',
    'find',
    'write',
    'edit',
    'shell',
  ])
  assert.equal(manager.toolDescriptor('read')?.permission, 'conditional')
  assert.equal(manager.toolDescriptor('glob')?.permission, 'none')
  assert.deepEqual(manager.capabilityIds('planner'), ['agent-task'])
  assert.ok(await manager.planner('agent-task'))
  await manager.stop()
})

test('process plugin protocol validates only complete v1 envelopes', () => {
  const pluginManifest = {
    id: 'example',
    version: '1.0.0',
    apiVersion: 1,
    isolation: 'process',
    capabilities: ['tool'],
  }
  assert.equal(
    isProcessPluginMessage({
      jsonrpc: '2.0',
      id: '1',
      result: {
        manifest: pluginManifest,
        capabilities: [
          {
            id: 'example.tool',
            kind: 'tool',
            inputSchema: {},
            outputSchema: {},
            execution: {
              sideEffect: 'process',
              target: { kind: 'workspace' },
              parallelSafe: false,
              conflictScope: 'workspace',
              maxInlineBytes: 65_536,
            },
          },
        ],
      },
    }),
    true,
  )
  const initializeRequest = {
    jsonrpc: '2.0' as const,
    id: 'initialize-1',
    method: 'initialize' as const,
    params: {
      protocolVersion: 1,
      runtimeApiVersion: 1,
      requestedPluginId: 'example',
      grants: [],
      workspace: 'D:/workspace',
    },
  }
  const initializeResponse = {
    jsonrpc: '2.0' as const,
    id: 'initialize-1',
    result: {
      manifest: pluginManifest,
      capabilities: [
        {
          id: 'example.tool',
          kind: 'tool',
          inputSchema: {},
          outputSchema: {},
          execution: {
            sideEffect: 'process',
            target: { kind: 'workspace' },
            parallelSafe: false,
            conflictScope: 'workspace',
            maxInlineBytes: 65_536,
          },
        },
      ],
    },
  }
  assert.equal(isProcessPluginResponseFor(initializeRequest, initializeResponse), true)
  assert.equal(
    isProcessPluginResponseFor(initializeRequest, { ...initializeResponse, id: 'wrong-id' }),
    false,
  )
  assert.equal(
    isProcessPluginMessage({
      jsonrpc: '2.0',
      id: 'initialize-extra',
      result: { manifest: pluginManifest, capabilities: [], extra: true },
    }),
    false,
  )
  assert.equal(
    isProcessPluginMessage({
      jsonrpc: '2.0',
      id: '3',
      result: {
        manifest: pluginManifest,
        capabilities: [
          { id: 'example.provider', kind: 'llm-provider', inputSchema: {}, outputSchema: {} },
        ],
      },
    }),
    false,
  )
  assert.equal(
    isProcessPluginMessage({
      jsonrpc: '2.0',
      id: '2',
      method: 'capability.invoke',
      params: {
        invocationId: 'i-1',
        capabilityId: 'example.tool',
        input: {},
        cancellationId: 'c-1',
      },
    }),
    true,
  )
  const cancelRequest = {
    jsonrpc: '2.0' as const,
    id: 'cancel-1',
    method: 'capability.cancel' as const,
    params: { invocationId: 'i-1', reason: 'user_abort' as const },
  }
  assert.equal(
    isProcessPluginResponseFor(cancelRequest, {
      jsonrpc: '2.0',
      id: 'cancel-1',
      result: { accepted: true },
    }),
    false,
  )
  assert.equal(
    isProcessPluginResponseFor(cancelRequest, {
      jsonrpc: '2.0',
      id: 'cancel-1',
      result: { invocationId: 'i-1', accepted: true },
    }),
    true,
  )
  assert.equal(
    isProcessPluginMessage({
      jsonrpc: '2.0',
      id: '4',
      method: 'capability.invoke',
      params: {
        invocationId: 'i-1',
        capabilityId: 'example.tool',
        input: {},
        cancellationId: 'c-1',
        extra: true,
      },
    }),
    false,
  )
  assert.equal(
    isProcessPluginMessage({
      jsonrpc: '2.0',
      id: '7',
      result: { nonce: 'n-1', extra: true },
    }),
    false,
  )
  assert.equal(
    isProcessPluginMessage({
      jsonrpc: '2.0',
      method: 'event',
      params: { invocationId: 'i-1', type: 'progress', payload: {} },
    }),
    true,
  )
  assert.equal(
    isProcessPluginMessage({
      jsonrpc: '2.0',
      method: 'event',
      params: { invocationId: 'i-1', type: 'unknown-event', payload: {} },
    }),
    false,
  )
  assert.equal(
    isProcessPluginMessage({
      jsonrpc: '2.0',
      id: '5',
      result: { invocationId: 'i-1', output: {}, extra: true },
    }),
    false,
  )
  assert.equal(
    isProcessPluginMessage({
      jsonrpc: '2.0',
      id: '6',
      result: { invocationId: 'i-1', accepted: true },
    }),
    true,
  )
  assert.equal(
    isProcessPluginMessage({ id: '1', method: 'health.ping', params: { nonce: 'n' } }),
    false,
  )
  assert.equal(
    isProcessPluginMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'health.ping',
      params: { nonce: 'n' },
    }),
    false,
  )
  assert.equal(
    isProcessPluginMessage({ jsonrpc: '2.0', method: 'event', params: { invocationId: 1 } }),
    false,
  )
})

test('disabled process host fails without spawning a child', async () => {
  await assert.rejects(new ProcessPluginHost().start({ command: 'never-run' }), (error: unknown) =>
    isRuntimeError(error, 'PROCESS_PLUGIN_DISABLED'),
  )
})

function isRuntimeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
