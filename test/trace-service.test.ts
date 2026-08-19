import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import {
  assertSafeTraceId,
  JsonlTraceSink,
  TraceService,
  type TraceRecordStore,
} from '../apps/runtime/src/trace/index.js'

const now = () => new Date('2026-07-20T08:00:00.000Z')

test('TraceService creates correlated contexts and supplies schema version and timestamps', async () => {
  await withTemporaryDirectories(async (_home) => {
    const sink = new JsonlTraceSink()
    const service = new TraceService({
      sink,
      now,
      createId: () => 'generated-id',
    })
    const context = service.createContext({ runtimeId: 'rt-1', sessionId: 's-1', runId: 'r-1' })

    assert.deepEqual(context, {
      traceId: 'trace-generated-id',
      runtimeId: 'rt-1',
      sessionId: 's-1',
      runId: 'r-1',
    })

    await service.record({ kind: 'run.started', context })
    await service.flush()

    assert.deepEqual(await sink.load(context.traceId), [
      {
        schemaVersion: 1,
        kind: 'run.started',
        timestamp: '2026-07-20T08:00:00.000Z',
        context,
      },
    ])
  })
})

test('TraceService preserves bounded child ancestry correlation without plan identifiers', async () => {
  await withTemporaryDirectories(async (_home) => {
    const service = new TraceService({
      sink: new JsonlTraceSink(),
      now,
      createId: () => 'child-trace',
      correlation: {
        parentRunId: 'parent-run',
        childRunId: 'child-run',
        parentTraceId: 'trace-parent',
      },
    })
    const context = service.createContext({
      runtimeId: 'child-runtime',
      sessionId: 'child-session',
      runId: 'child-agent-run',
    })

    assert.deepEqual(context, {
      traceId: 'trace-child-trace',
      runtimeId: 'child-runtime',
      sessionId: 'child-session',
      runId: 'child-agent-run',
      parentRunId: 'parent-run',
      childRunId: 'child-run',
      parentTraceId: 'trace-parent',
    })
    assert.equal('planId' in context, false)
    assert.equal('stepId' in context, false)
  })
})

test('TraceService rejects non-string context identifiers during context creation', async () => {
  await withTemporaryDirectories(async (_home) => {
    const service = new TraceService({ sink: new JsonlTraceSink(), now })

    assert.throws(() => service.createContext({ runtimeId: { prompt: 'do not retain' } } as never))
  })
})

test('TraceService preserves its generated trace ID when runtime input contains an extra ID', async () => {
  await withTemporaryDirectories(async (_home) => {
    const service = new TraceService({
      sink: new JsonlTraceSink(),
      now,
      createId: () => 'generated-id',
    })

    const context = service.createContext({
      runtimeId: 'rt-1',
      traceId: '../caller-controlled',
    } as never)

    assert.equal(context.traceId, 'trace-generated-id')
  })
})

test('trace ID validation rejects non-string values instead of coercing them', () => {
  assert.throws(() => assertSafeTraceId(123 as never), /string/i)
})

test('TraceService shutdown gates late records and waits for an in-flight record before flush', async () => {
  const appendEntered = traceDeferred()
  const releaseAppend = traceDeferred()
  let flushes = 0
  const sink: TraceRecordStore = {
    append: async () => {
      appendEntered.resolve()
      await releaseAppend.promise
    },
    load: async () => [],
    flush: async () => {
      flushes += 1
    },
  }
  const service = new TraceService({ sink, now })
  const shutdownService = service as TraceService & { shutdown(): Promise<void> }

  assert.equal(typeof shutdownService.shutdown, 'function')
  const recording = service.record({
    kind: 'run.started',
    context: { traceId: 'trace-1', runtimeId: 'rt-1' },
  })
  await appendEntered.promise
  const shuttingDown = shutdownService.shutdown()

  await assertTracePending(shuttingDown)
  await assert.rejects(
    () =>
      service.record({
        kind: 'run.completed',
        context: { traceId: 'trace-1', runtimeId: 'rt-1' },
      }),
    /shutting down/i,
  )
  releaseAppend.resolve()
  await recording
  await shuttingDown
  assert.equal(flushes, 1)
})

test('TraceService exports one deterministic JSON bundle with an explicit privacy inventory', async () => {
  await withTemporaryDirectories(async (_home, destination) => {
    const service = new TraceService({ sink: new JsonlTraceSink(), now })
    const context = { traceId: 'trace-1', runtimeId: 'rt-1' }
    await service.record({ kind: 'run.started', context })
    await service.record({ kind: 'run.completed', context, metrics: { durationMs: 3 } })

    const bundle = await service.exportTrace('trace-1', destination)

    assert.equal(bundle.bundleVersion, 1)
    assert.equal(bundle.schemaVersion, 1)
    assert.equal(bundle.traceId, 'trace-1')
    assert.equal(bundle.createdAt, '2026-07-20T08:00:00.000Z')
    assert.equal(bundle.recordCount, 2)
    assert.equal(basename(bundle.path), 'trace-1.json')
    assert.deepEqual(bundle.privacy.excluded, [
      'prompts',
      'credentials',
      'environment',
      'rawToolInput',
      'rawToolOutput',
    ])
    assert.deepEqual(bundle.privacy.included, [
      'eventKinds',
      'timestamps',
      'correlationIds',
      'declaredAttributes',
      'aggregateMetrics',
    ])
    assert.equal(
      bundle.records.every((record) => record.context.traceId === 'trace-1'),
      true,
    )

    const source = await readFile(bundle.path, 'utf8')
    assert.deepEqual(JSON.parse(source), bundleWithoutPath(bundle))
    assert.equal(source, `${JSON.stringify(bundleWithoutPath(bundle), undefined, 2)}\n`)
  })
})

test('TraceService rejects unsafe trace IDs without writing outside the destination', async () => {
  await withTemporaryDirectories(async (_home, destination) => {
    const service = new TraceService({ sink: new JsonlTraceSink(), now })

    await assert.rejects(() => service.exportTrace('../escape', destination), /trace ID/i)
    await assert.rejects(() => service.exportTrace('trace/escape', destination), /trace ID/i)
  })
})

test('TraceService refuses a junctioned export destination', async () => {
  await withTemporaryDirectories(async (home, destination) => {
    const service = new TraceService({ sink: new JsonlTraceSink(), now })
    await service.record({
      kind: 'run.started',
      context: { traceId: 'trace-1', runtimeId: 'rt-1' },
    })
    const outside = join(home, 'outside-export')
    await mkdir(outside, { recursive: true })
    await symlink(outside, destination, 'junction')

    await assert.rejects(() => service.exportTrace('trace-1', destination), /symbolic link/i)
    await assert.rejects(() => readFile(join(outside, 'trace-1.json'), 'utf8'), /ENOENT/)
  })
})

function bundleWithoutPath(bundle: Awaited<ReturnType<TraceService['exportTrace']>>) {
  const { path: _path, ...document } = bundle
  return document
}

async function withTemporaryDirectories(
  action: (home: string, destination: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-trace-service-'))
  const previousHome = process.env.PRAXIS_HOME
  process.env.PRAXIS_HOME = join(root, 'home')
  try {
    await action(join(root, 'home'), join(root, 'exports'))
  } finally {
    if (previousHome === undefined) delete process.env.PRAXIS_HOME
    else process.env.PRAXIS_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
}

function traceDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return {
    promise: new Promise<void>((resolvePromise) => {
      resolve = resolvePromise
    }),
    resolve,
  }
}

async function assertTracePending(promise: Promise<unknown>): Promise<void> {
  let settled = false
  void promise.finally(() => {
    settled = true
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(settled, false)
}
