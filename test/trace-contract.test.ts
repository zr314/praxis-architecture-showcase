import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type AgentRun,
  createTraceRecord,
  NoopTraceSink,
  type TraceRecord,
  type TraceSink,
} from '@praxis/core-sdk'

// @ts-expect-error Agent run trace contexts must always carry both correlation identifiers.
const invalidRunTrace: AgentRun['trace'] = { traceId: 'trace', runtimeId: 'runtime' }
void invalidRunTrace

test('trace records use the stable, privacy-safe contract', () => {
  const record = createTraceRecord({
    kind: 'provider.completed',
    timestamp: '2026-01-01T00:00:00.000Z',
    context: {
      traceId: 'trace-1',
      runtimeId: 'rt-1',
      sessionId: 's-1',
      runId: 'run-1',
      turnId: 'turn-1',
    },
    attributes: { providerId: 'mock', stopReason: 'end_turn' },
    metrics: { durationMs: 4, inputTokens: 3, outputTokens: 2 },
  })

  assert.deepEqual(record, {
    schemaVersion: 1,
    kind: 'provider.completed',
    timestamp: '2026-01-01T00:00:00.000Z',
    context: {
      traceId: 'trace-1',
      runtimeId: 'rt-1',
      sessionId: 's-1',
      runId: 'run-1',
      turnId: 'turn-1',
    },
    attributes: { providerId: 'mock', stopReason: 'end_turn' },
    metrics: { durationMs: 4, inputTokens: 3, outputTokens: 2 },
  })
})

test('trace vocabulary captures first response and terminal persistence latency', () => {
  const context = { traceId: 'trace-1', runtimeId: 'rt-1', runId: 'run-1' }
  assert.equal(
    createTraceRecord({
      kind: 'provider.first_token',
      timestamp: '2026-01-01T00:00:00.000Z',
      context,
      attributes: { providerId: 'mock' },
      metrics: { durationMs: 3, candidateIndex: 0, attemptIndex: 0 },
    }).kind,
    'provider.first_token',
  )
  assert.equal(
    createTraceRecord({
      kind: 'persistence.completed',
      timestamp: '2026-01-01T00:00:00.000Z',
      context,
      metrics: { durationMs: 2 },
    }).kind,
    'persistence.completed',
  )
})

test('trace records discard undeclared and raw payload fields', () => {
  const record = createTraceRecord({
    kind: 'tool.completed',
    timestamp: '2026-01-01T00:00:00.000Z',
    context: { traceId: 'trace-1', runtimeId: 'rt-1' },
    attributes: {
      providerId: 'mock',
      prompt: 'do not retain',
      input: { secret: 'do not retain' },
      output: 'do not retain',
      environment: { API_KEY: 'do not retain' },
      token: 'do not retain',
      secret: 'do not retain',
      data: { arbitrary: true },
    },
    metrics: { durationMs: 1, arbitrary: 2 },
    provider: { raw: 'payload' },
    tool: { raw: 'payload' },
  } as never)
  const serialized = JSON.stringify(record)

  assert.deepEqual(record.attributes, { providerId: 'mock' })
  assert.deepEqual(record.metrics, { durationMs: 1 })
  for (const forbidden of ['prompt', 'input', 'output', 'environment', 'token', 'secret', 'data']) {
    assert.equal(serialized.includes(`"${forbidden}"`), false)
  }
  assert.equal(serialized.includes('raw'), false)
})

test('trace records reject invalid bounded metrics', () => {
  const input = {
    kind: 'run.completed' as const,
    timestamp: '2026-01-01T00:00:00.000Z',
    context: { traceId: 'trace-1', runtimeId: 'rt-1' },
  }

  for (const metrics of [
    { durationMs: -1 },
    { durationMs: Number.NaN },
    { inputTokens: -1 },
    { inputTokens: Number.POSITIVE_INFINITY },
    { outputTokens: -1 },
  ]) {
    assert.throws(() => createTraceRecord({ ...input, metrics }))
  }
})

test('trace records preserve bounded Provider attempt metadata and fixed health', () => {
  const record = createTraceRecord({
    kind: 'provider.failed',
    timestamp: '2026-01-01T00:00:00.000Z',
    context: { traceId: 'trace-1', runtimeId: 'rt-1', turnId: 'turn-1' },
    attributes: { providerId: 'backup', health: 'degraded' },
    metrics: { durationMs: 4, candidateIndex: 2, attemptIndex: 3 },
  } as never)

  assert.deepEqual(record.attributes, { providerId: 'backup', health: 'degraded' })
  assert.deepEqual(record.metrics, { durationMs: 4, candidateIndex: 2, attemptIndex: 3 })
})

test('trace records preserve content-free context editing aggregates', () => {
  const metrics = {
    toolResultTokensBefore: 48_000,
    toolResultTokensAfter: 20_000,
    truncatedToolResults: 2,
    truncatedToolResultTokens: 12_000,
    clearedToolResults: 3,
    clearedToolResultTokens: 16_000,
  }
  const record = createTraceRecord({
    kind: 'context.selected',
    timestamp: '2026-01-01T00:00:00.000Z',
    context: { traceId: 'trace-1', runtimeId: 'rt-1' },
    metrics,
  })

  assert.deepEqual(record.metrics, metrics)
})

test('trace records reject unbounded attempt metadata and unknown health values', () => {
  const input = {
    kind: 'provider.failed' as const,
    timestamp: '2026-01-01T00:00:00.000Z',
    context: { traceId: 'trace-1', runtimeId: 'rt-1' },
  }

  for (const metrics of [
    { candidateIndex: 1.5 },
    { candidateIndex: 65_536 },
    { attemptIndex: 1.5 },
    { attemptIndex: 65_536 },
  ]) {
    assert.throws(() => createTraceRecord({ ...input, metrics } as never))
  }
  assert.throws(() => createTraceRecord({ ...input, attributes: { health: 'unknown' } } as never))
})

test('trace records preserve fixed content-free prompt manifest metadata', () => {
  const manifestDigest = `sha256:${'a'.repeat(64)}`
  const sectionDigest = `sha256:${'b'.repeat(64)}`
  const record = createTraceRecord({
    kind: 'prompt.manifest',
    timestamp: '2026-01-01T00:00:00.000Z',
    context: { traceId: 'trace-1', runtimeId: 'rt-1', runId: 'run-1' },
    attributes: {
      manifestDigest,
      promptVariant: 'iron-law-lean-v1',
      promptSectionId: 'identity',
      promptSectionDigest: sectionDigest,
      promptSectionSource: 'builtin',
      promptSectionCacheScope: 'request',
      promptSectionIncluded: true,
    },
    metrics: {
      sectionCount: 1,
      sectionOrder: 10,
      characters: 42,
      estimatedTokens: 11,
    },
  } as never)

  assert.deepEqual(record.attributes, {
    manifestDigest,
    promptVariant: 'iron-law-lean-v1',
    promptSectionId: 'identity',
    promptSectionDigest: sectionDigest,
    promptSectionSource: 'builtin',
    promptSectionCacheScope: 'request',
    promptSectionIncluded: true,
  })
  assert.deepEqual(record.metrics, {
    sectionCount: 1,
    sectionOrder: 10,
    characters: 42,
    estimatedTokens: 11,
  })
})

test('trace records reject invalid or unbounded prompt manifest metadata', () => {
  const input = {
    kind: 'prompt.manifest' as const,
    timestamp: '2026-01-01T00:00:00.000Z',
    context: { traceId: 'trace-1', runtimeId: 'rt-1' },
  }

  for (const attributes of [
    { manifestDigest: 'sha256:not-a-digest' },
    { promptSectionDigest: 'sha256:not-a-digest' },
    { promptSectionId: 'x'.repeat(129) },
    { promptSectionSource: 'untrusted' },
    { promptSectionCacheScope: 'global' },
    { promptVariant: 'unknown-v1' },
    { promptSectionIncluded: 'yes' },
  ]) {
    assert.throws(() => createTraceRecord({ ...input, attributes } as never))
  }
  for (const metrics of [
    { sectionCount: 1.5 },
    { sectionOrder: 2_147_483_648 },
    { characters: 2_147_483_648 },
    { estimatedTokens: 1.5 },
  ]) {
    assert.throws(() => createTraceRecord({ ...input, metrics } as never))
  }
})

test('trace records preserve only fixed Tool terminal outcomes', () => {
  const input = {
    kind: 'tool.failed' as const,
    timestamp: '2026-01-01T00:00:00.000Z',
    context: { traceId: 'trace-1', runtimeId: 'rt-1', toolCallId: 'tool-1' },
  }

  for (const toolOutcome of [
    'completed',
    'input_blocked',
    'policy_blocked',
    'invocation_failed',
  ] as const) {
    assert.equal(
      createTraceRecord({ ...input, attributes: { toolOutcome } } as never).attributes?.toolOutcome,
      toolOutcome,
    )
  }
  assert.throws(() =>
    createTraceRecord({ ...input, attributes: { toolOutcome: 'arbitrary' } } as never),
  )
})

test('trace records reject non-string values in every declared context and attribute field', () => {
  const input = {
    kind: 'run.completed' as const,
    timestamp: '2026-01-01T00:00:00.000Z',
    context: {
      traceId: 'trace-1',
      runtimeId: 'rt-1',
      sessionId: 's-1',
      runId: 'run-1',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      pluginCallId: 'plugin-1',
    },
    attributes: {
      providerId: 'mock',
      model: 'model-1',
      toolName: 'tool',
      pluginId: 'plugin',
      capabilityId: 'capability',
      stopReason: 'end_turn',
      errorCode: 'NONE',
      errorCategory: 'none',
    },
  }
  const unsafeValues = [{ prompt: 'do not retain' }, ['tool input'], () => 'provider output']

  for (const property of [
    'traceId',
    'runtimeId',
    'sessionId',
    'runId',
    'turnId',
    'toolCallId',
    'pluginCallId',
  ]) {
    for (const unsafeValue of unsafeValues) {
      assert.throws(() =>
        createTraceRecord({
          ...input,
          context: { ...input.context, [property]: unsafeValue },
        } as never),
      )
    }
  }

  for (const property of [
    'providerId',
    'model',
    'toolName',
    'pluginId',
    'capabilityId',
    'stopReason',
    'errorCode',
    'errorCategory',
  ]) {
    for (const unsafeValue of unsafeValues) {
      assert.throws(() =>
        createTraceRecord({
          ...input,
          attributes: { ...input.attributes, [property]: unsafeValue },
        } as never),
      )
    }
  }
})

test('trace records reject non-string timestamp values before serialization', () => {
  const input = {
    kind: 'run.completed' as const,
    timestamp: '2026-01-01T00:00:00.000Z',
    context: { traceId: 'trace-1', runtimeId: 'rt-1' },
  }

  for (const unsafeTimestamp of [
    { prompt: 'do not retain', input: { secret: 'do not retain' } },
    ['tool input'],
    () => 'provider output',
  ]) {
    assert.throws(() => createTraceRecord({ ...input, timestamp: unsafeTimestamp } as never))
  }
})

test('trace strings are bounded safe identifiers and untrusted terminal fields use fixed fallbacks', () => {
  const sentinel = `PRIVATE_PAYLOAD_${'x'.repeat(20_000)}`
  const record = createTraceRecord({
    kind: 'provider.failed',
    timestamp: '2026-01-01T00:00:00.000Z',
    context: { traceId: 'trace-1', runtimeId: 'runtime:local/1' },
    attributes: {
      providerId: 'vendor/provider.v2',
      model: 'vendor/model-4.1@2026-01',
      stopReason: sentinel,
      errorCode: sentinel,
      errorCategory: sentinel,
    },
  })

  assert.deepEqual(record.attributes, {
    providerId: 'vendor/provider.v2',
    model: 'vendor/model-4.1@2026-01',
    stopReason: 'other',
    errorCode: 'UNCLASSIFIED',
    errorCategory: 'unknown',
  })
  assert.equal(JSON.stringify(record).includes('PRIVATE_PAYLOAD'), false)
  assert.ok(Buffer.byteLength(JSON.stringify(record), 'utf8') < 16 * 1024)

  for (const context of [
    { traceId: '', runtimeId: 'runtime-1' },
    { traceId: 'trace/with-path', runtimeId: 'runtime-1' },
    { traceId: '../private payload', runtimeId: 'runtime-1' },
    { traceId: 'x'.repeat(129), runtimeId: 'runtime-1' },
  ]) {
    assert.throws(() =>
      createTraceRecord({
        kind: 'run.started',
        timestamp: '2026-01-01T00:00:00.000Z',
        context,
      }),
    )
  }
  assert.throws(() =>
    createTraceRecord({
      kind: 'provider.started',
      timestamp: '2026-01-01T00:00:00.000Z',
      context: { traceId: 'trace-1', runtimeId: 'runtime-1' },
      attributes: { providerId: 'private payload' },
    }),
  )
})

test('trace timestamps must be canonical valid UTC instants', () => {
  for (const timestamp of ['', 'private payload', '2026-99-99T00:00:00.000Z']) {
    assert.throws(() =>
      createTraceRecord({
        kind: 'run.started',
        timestamp,
        context: { traceId: 'trace-1', runtimeId: 'runtime-1' },
      }),
    )
  }
})

test('trace records reject unknown event kinds and permission decisions at runtime', () => {
  const input = {
    kind: 'run.completed' as const,
    timestamp: '2026-01-01T00:00:00.000Z',
    context: { traceId: 'trace-1', runtimeId: 'rt-1' },
  }

  assert.throws(() => createTraceRecord({ ...input, kind: 'arbitrary.data' } as never))
  assert.throws(() =>
    createTraceRecord({
      ...input,
      attributes: { permissionDecision: 'anything' },
    } as never),
  )
})

test('NoopTraceSink fulfils the asynchronous trace sink contract without retaining records', async () => {
  const sink: TraceSink = new NoopTraceSink()
  const record: TraceRecord = createTraceRecord({
    kind: 'run.started',
    timestamp: '2026-01-01T00:00:00.000Z',
    context: { traceId: 'trace-1', runtimeId: 'rt-1' },
  })

  await sink.append(record)
  await sink.flush()
})
