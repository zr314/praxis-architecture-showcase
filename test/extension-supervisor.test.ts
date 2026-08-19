import assert from 'node:assert/strict'
import test from 'node:test'
import { runtimeError } from '@praxis/core-sdk'
import {
  ExtensionSupervisor,
  type ExtensionAdapter,
} from '../apps/runtime/src/extensions/extensionSupervisor.js'

test('extension supervisor bounds concurrency, propagates cancellation, and supports dev reload', async () => {
  const supervisor = new ExtensionSupervisor()
  let active = 0
  let maximum = 0
  let starts = 0
  const adapter: ExtensionAdapter = {
    start: async () => {
      starts += 1
    },
    health: async () => true,
    invoke: async (_method, input, signal) => {
      active += 1
      maximum = Math.max(maximum, active)
      try {
        await wait(15, signal)
        return input
      } finally {
        active -= 1
      }
    },
    stop: async () => {},
  }
  supervisor.register('bounded', adapter, { maxConcurrency: 2, invocationTimeoutMs: 1_000 })
  await Promise.all([
    supervisor.invoke('bounded', 'echo', 1),
    supervisor.invoke('bounded', 'echo', 2),
    supervisor.invoke('bounded', 'echo', 3),
  ])
  assert.equal(maximum, 2)
  await assert.rejects(
    supervisor.reload('bounded', false),
    hasCode('PLUGIN_RELOAD_PRODUCTION_FORBIDDEN'),
  )
  await supervisor.reload('bounded', true)
  assert.equal(starts, 2)
  await supervisor.shutdown()
})

test('protocol failure quarantines an extension and captures bounded stderr', async () => {
  const supervisor = new ExtensionSupervisor()
  supervisor.register(
    'broken',
    {
      start: async () => {},
      health: async () => true,
      invoke: async () => {
        throw runtimeError('PLUGIN_PROTOCOL_INVALID', 'plugin', 'invalid')
      },
      stop: async () => {},
    },
    { maxStderrBytes: 1_024 },
  )
  supervisor.captureStderr('broken', 'x'.repeat(2_048))
  await assert.rejects(supervisor.invoke('broken', 'bad', {}))
  assert.equal(supervisor.status('broken').health, 'quarantined')
  assert.equal(Buffer.byteLength(supervisor.stderr('broken')), 1_024)
})

test('caller cancellation does not count as an extension health failure', async () => {
  const supervisor = new ExtensionSupervisor()
  supervisor.register(
    'cancelled',
    {
      start: async () => {},
      health: async () => true,
      invoke: async () => {
        throw runtimeError('MCP_REQUEST_CANCELLED', 'plugin', 'cancelled')
      },
      stop: async () => {},
    },
    { quarantineThreshold: 1 },
  )
  await assert.rejects(supervisor.invoke('cancelled', 'wait', {}), hasCode('MCP_REQUEST_CANCELLED'))
  assert.equal(supervisor.status('cancelled').health, 'healthy')
  await supervisor.shutdown()
})

test('removing a supervised extension aborts active work, stops it, and unregisters it', async () => {
  const supervisor = new ExtensionSupervisor()
  let started = false
  let stops = 0
  supervisor.register('removable', {
    start: async () => {},
    health: async () => true,
    invoke: async (_method, _input, signal) => {
      started = true
      await wait(5_000, signal)
    },
    stop: async () => {
      stops += 1
    },
  })
  const contract = supervisor as ExtensionSupervisor & {
    remove?: (id: string) => Promise<void>
  }

  assert.equal(typeof contract.remove, 'function')
  const invocation = supervisor.invoke('removable', 'wait', {})
  await waitUntil(() => started, 500)
  await contract.remove?.('removable')

  await assert.rejects(invocation)
  assert.equal(stops, 1)
  assert.throws(() => supervisor.status('removable'), hasCode('PLUGIN_NOT_REGISTERED'))
})

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('Timed out waiting for extension activity.')
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
