import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { TraceRecord } from '@praxis/core-sdk'
import {
  ProcessPluginHost,
  type ProcessPluginTraceBoundary,
} from '../apps/runtime/src/plugin/processPluginHost.js'

const fixture = fileURLToPath(new URL('./fixtures/process-plugin.ts', import.meta.url))
const malformedFixture = fileURLToPath(
  new URL('./fixtures/malformed-process-plugin.ts', import.meta.url),
)

test('enabled process host handshakes, invokes, and shuts down an isolated plugin', async () => {
  const host = new ProcessPluginHost({ enabled: true, requestTimeoutMs: 2_000 })
  const plugin = await host.start({
    command: process.execPath,
    args: ['--import', 'tsx', fixture],
    pluginId: 'fixture-plugin',
    workspace: process.cwd(),
  })

  assert.deepEqual(
    plugin.capabilities.map((capability) => capability.id),
    ['fixture.echo'],
  )
  assert.deepEqual(await plugin.invoke('fixture.echo', { value: 'hello' }), { value: 'hello' })
  await plugin.shutdown()
})

test('process plugin launch default-denies ambient Runtime credentials and preserves bootstrap environment', async () => {
  const previous = process.env.PRAXIS_PLUGIN_SENTINEL_SECRET
  process.env.PRAXIS_PLUGIN_SENTINEL_SECRET = 'must-not-cross-plugin-boundary'
  const host = new ProcessPluginHost({ enabled: true, requestTimeoutMs: 2_000 })
  try {
    const plugin = await host.start({
      command: process.execPath,
      args: ['--import', 'tsx', fixture],
      pluginId: 'fixture-plugin',
      workspace: process.cwd(),
    })
    try {
      assert.deepEqual(await plugin.invoke('fixture.echo', { readEnvironment: true }), {
        secret: null,
        pathAvailable: true,
      })
    } finally {
      await plugin.shutdown()
    }
  } finally {
    if (previous === undefined) delete process.env.PRAXIS_PLUGIN_SENTINEL_SECRET
    else process.env.PRAXIS_PLUGIN_SENTINEL_SECRET = previous
  }
})

test('process host traces one generated pluginCallId and never retains invocation input or output', async () => {
  const host = new ProcessPluginHost({ enabled: true, requestTimeoutMs: 2_000 })
  const plugin = await host.start({
    command: process.execPath,
    args: ['--import', 'tsx', fixture],
    pluginId: 'fixture-plugin',
    workspace: process.cwd(),
  })
  const records: TraceInput[] = []
  const boundary: ProcessPluginTraceBoundary = {
    context: {
      traceId: 'trace-plugin',
      runtimeId: 'rt-plugin',
      sessionId: 's-plugin',
      runId: 'r-plugin',
      turnId: 'turn-plugin',
      toolCallId: 'tool-plugin',
    },
    trace: async (record) => {
      records.push(record)
    },
  }

  try {
    assert.deepEqual(
      await plugin.invoke('fixture.echo', { value: 'private plugin input' }, undefined, boundary),
      { value: 'private plugin input' },
    )

    assert.deepEqual(
      records.map((record) => record.kind),
      ['plugin.started', 'plugin.stopped'],
    )
    assert.ok(records.every((record) => record.context.pluginCallId !== undefined))
    assert.equal(new Set(records.map((record) => record.context.pluginCallId)).size, 1)
    assert.ok(
      records.every(
        (record) =>
          record.context.traceId === boundary.context.traceId &&
          record.context.runtimeId === boundary.context.runtimeId &&
          record.context.sessionId === boundary.context.sessionId &&
          record.context.runId === boundary.context.runId &&
          record.context.turnId === boundary.context.turnId &&
          record.context.toolCallId === boundary.context.toolCallId,
      ),
    )
    assert.ok(
      records.every(
        (record) =>
          record.attributes?.pluginId === 'fixture-plugin' &&
          record.attributes.capabilityId === 'fixture.echo',
      ),
    )
    assert.equal(records[1]?.attributes?.health, 'healthy')
    assert.ok((records[1]?.metrics?.durationMs ?? -1) >= 0)
    assert.equal(JSON.stringify(records).includes('private plugin input'), false)
  } finally {
    await plugin.shutdown()
  }
})

test('process invocation remains successful when tracing fails', async () => {
  const host = new ProcessPluginHost({ enabled: true, requestTimeoutMs: 2_000 })
  const plugin = await host.start({
    command: process.execPath,
    args: ['--import', 'tsx', fixture],
    pluginId: 'fixture-plugin',
    workspace: process.cwd(),
  })

  try {
    assert.deepEqual(
      await plugin.invoke('fixture.echo', { value: 'hello' }, undefined, {
        context: { traceId: 'trace-plugin', runtimeId: 'rt-plugin' },
        trace: async () => {
          throw new Error('trace sink failed')
        },
      }),
      { value: 'hello' },
    )
  } finally {
    await plugin.shutdown()
  }
})

test('process host traces invocation failure with duration and the generated pluginCallId', async () => {
  const host = new ProcessPluginHost({ enabled: true, requestTimeoutMs: 2_000 })
  const plugin = await host.start({
    command: process.execPath,
    args: ['--import', 'tsx', fixture],
    pluginId: 'fixture-plugin',
    workspace: process.cwd(),
  })
  const records: TraceInput[] = []

  try {
    await assert.rejects(
      plugin.invoke('fixture.unknown', { value: 'private failed input' }, undefined, {
        context: { traceId: 'trace-plugin-failed', runtimeId: 'rt-plugin' },
        trace: async (record) => {
          records.push(record)
        },
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === 'PROCESS_PLUGIN_CAPABILITY_UNKNOWN',
    )
    assert.deepEqual(
      records.map((record) => record.kind),
      ['plugin.started', 'plugin.failed'],
    )
    assert.equal(new Set(records.map((record) => record.context.pluginCallId)).size, 1)
    assert.equal(records[1]?.attributes?.errorCode, 'PROCESS_PLUGIN_CAPABILITY_UNKNOWN')
    assert.equal(records[1]?.attributes?.health, 'unhealthy')
    assert.ok((records[1]?.metrics?.durationMs ?? -1) >= 0)
    assert.equal(JSON.stringify(records).includes('private failed input'), false)
  } finally {
    await plugin.shutdown()
  }
})

test('process cancellation correlates by cancellationId and claims one timed terminal trace', async () => {
  const host = new ProcessPluginHost({ enabled: true, requestTimeoutMs: 2_000 })
  const plugin = await host.start({
    command: process.execPath,
    args: ['--import', 'tsx', fixture],
    pluginId: 'fixture-plugin',
    workspace: process.cwd(),
  })
  const records: TraceInput[] = []
  let releaseStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    releaseStarted = resolve
  })
  const boundary: ProcessPluginTraceBoundary = {
    context: {
      traceId: 'trace-plugin-cancel',
      runtimeId: 'rt-plugin',
      sessionId: 's-plugin',
      runId: 'r-plugin',
      turnId: 'turn-plugin',
      toolCallId: 'tool-plugin',
    },
    trace: async (record) => {
      records.push(record)
      if (record.kind === 'plugin.started') releaseStarted?.()
    },
  }

  try {
    const invocation = plugin.invoke(
      'fixture.echo',
      { waitForCancel: true },
      'cancel-fixture',
      boundary,
    )
    await started
    await plugin.cancel('cancel-fixture', 'user_abort')
    await assert.rejects(
      invocation,
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === 'PROCESS_PLUGIN_CANCELLED',
    )

    assert.deepEqual(
      records.map((record) => record.kind),
      ['plugin.started', 'plugin.stopped'],
    )
    assert.equal(new Set(records.map((record) => record.context.pluginCallId)).size, 1)
    assert.equal(records[1]?.attributes?.stopReason, 'user_abort')
    assert.equal(records[1]?.attributes?.health, 'degraded')
    assert.ok((records[1]?.metrics?.durationMs ?? -1) >= 0)

    assert.deepEqual(
      await plugin.invoke('fixture.echo', { value: 'cleanup proved' }, 'cancel-fixture'),
      { value: 'cleanup proved' },
    )
  } finally {
    await plugin.shutdown()
  }
})

test('accepted process cancellation rejects a late success and emits one terminal trace', async () => {
  const host = new ProcessPluginHost({ enabled: true, requestTimeoutMs: 2_000 })
  const plugin = await host.start({
    command: process.execPath,
    args: ['--import', 'tsx', fixture],
    pluginId: 'fixture-plugin',
    workspace: process.cwd(),
  })
  const records: TraceInput[] = []
  let releaseStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    releaseStarted = resolve
  })

  try {
    const invocation = plugin.invoke(
      'fixture.echo',
      { waitForCancel: true, lateSuccessAfterCancel: true },
      'cancel-late-success',
      {
        context: { traceId: 'trace-plugin-cancel-race', runtimeId: 'rt-plugin' },
        trace: async (record) => {
          records.push(record)
          if (record.kind === 'plugin.started') releaseStarted?.()
        },
      },
    )
    await started
    await plugin.cancel('cancel-late-success', 'user_abort')

    await assert.rejects(
      invocation,
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === 'PROCESS_PLUGIN_CANCELLED',
    )
    assert.deepEqual(
      records.map((record) => record.kind),
      ['plugin.started', 'plugin.stopped'],
    )
    assert.equal(records[1]?.attributes?.stopReason, 'user_abort')
  } finally {
    await plugin.shutdown()
  }
})

test('process host rejects malformed plugin stdout and terminates the child', async () => {
  const host = new ProcessPluginHost({ enabled: true, requestTimeoutMs: 2_000 })

  await assert.rejects(
    host.start({
      command: process.execPath,
      args: ['--import', 'tsx', malformedFixture],
      pluginId: 'malformed',
      workspace: process.cwd(),
    }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'PROCESS_PLUGIN_PROTOCOL_INVALID',
  )
})

test('process host rejects an oversized stdout frame before a newline arrives', async () => {
  const host = new ProcessPluginHost({
    enabled: true,
    requestTimeoutMs: 2_000,
    maxStdoutLineBytes: 1_024,
  })

  await assert.rejects(
    host.start({
      command: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(2048)); setInterval(() => {}, 1000)"],
      pluginId: 'oversized',
      workspace: process.cwd(),
    }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'PROCESS_PLUGIN_PROTOCOL_INVALID',
  )
})

type TraceInput = Omit<TraceRecord, 'schemaVersion' | 'timestamp'>
