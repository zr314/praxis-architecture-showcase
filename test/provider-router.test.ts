import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type ChatProvider,
  type ProviderCapabilities,
  type ProviderChunk,
  type ProviderRequest,
  runtimeError,
  type TraceContext,
  type TraceRecord,
} from '@praxis/core-sdk'
import { ProviderRouter } from '../apps/runtime/src/provider-router/providerRouter.js'

test('router retries a retryable primary failure before streaming its result', async () => {
  let attempts = 0
  const primary = provider('primary', async function* () {
    attempts += 1
    if (attempts === 1) throw runtimeError('TEMPORARY', 'provider', 'retry me', undefined, true)
    yield { type: 'text_delta' as const, text: 'recovered' }
    yield { type: 'completed' as const }
  })
  const router = new ProviderRouter(async (id) => (id === 'primary' ? primary : undefined))

  assert.deepEqual(await collect(router.stream('primary', request())), [
    { type: 'text_delta', text: 'recovered' },
    { type: 'completed' },
  ])
  assert.equal(attempts, 2)
})

test('router falls back once when the primary remains retryable', async () => {
  const primary = provider('primary', async function* () {
    throw runtimeError('TEMPORARY', 'provider', 'retry me', undefined, true)
  })
  const backup = provider('backup', async function* () {
    yield { type: 'completed' as const, stopReason: 'end_turn' }
  })
  const router = new ProviderRouter(async (id) => ({ primary, backup })[id], {
    fallbacks: { primary: [{ provider: 'backup', model: 'backup-model' }] },
  })

  assert.deepEqual(await collect(router.stream('primary', request())), [
    { type: 'completed', stopReason: 'end_turn' },
  ])
})

test('router never retries or falls back after publishing a Provider chunk', async () => {
  let primaryAttempts = 0
  let backupAttempts = 0
  const primary = provider('primary', async function* () {
    primaryAttempts += 1
    yield { type: 'text_delta' as const, text: 'partial' }
    throw runtimeError('TEMPORARY', 'provider', 'failed after output', undefined, true)
  })
  const backup = provider('backup', async function* () {
    backupAttempts += 1
    yield { type: 'text_delta' as const, text: 'backup' }
    yield { type: 'completed' as const }
  })
  const records: TraceInput[] = []
  const router = new ProviderRouter(async (id) => ({ primary, backup })[id], {
    fallbacks: { primary: [{ provider: 'backup', model: 'backup-model' }] },
  })
  const iterator = router
    .stream('primary', request(), {
      context: { traceId: 'trace-partial', runtimeId: 'rt-router' },
      trace: async (record) => {
        records.push(record)
      },
    })
    [Symbol.asyncIterator]()

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: 'text_delta', text: 'partial' },
  })
  await assert.rejects(iterator.next(), hasCode('TEMPORARY'))

  assert.equal(primaryAttempts, 1)
  assert.equal(backupAttempts, 0)
  assert.deepEqual(
    records.map((record) => record.kind),
    ['provider.started', 'provider.first_token', 'provider.failed'],
  )
  assert.equal(records[2]?.attributes?.providerId, 'primary')
  assert.equal(records[2]?.attributes?.errorCode, 'TEMPORARY')
})

test('router normalizes account model-access failures into an actionable stable error', async () => {
  const unavailable = provider('primary', async function* () {
    throw Object.assign(new Error('private upstream detail'), {
      status: 404,
      code: 'model_not_found',
    })
  })
  const router = new ProviderRouter(async () => unavailable, { retryAttempts: 0 })

  await assert.rejects(collect(router.stream('primary', request())), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'PROVIDER_MODEL_UNAVAILABLE')
    assert.match((error as { message: string }).message, /Choose another model/)
    assert.doesNotMatch((error as { message: string }).message, /private upstream detail/)
    return true
  })
})

test('router traces one terminal failure when its consumer closes an active attempt', async () => {
  let providerClosed = false
  const active = provider('active', async function* () {
    try {
      yield { type: 'text_delta' as const, text: 'partial' }
      yield { type: 'completed' as const }
    } finally {
      providerClosed = true
    }
  })
  const records: TraceInput[] = []
  const router = new ProviderRouter(async () => active)
  const iterator = router
    .stream('active', request(), {
      context: { traceId: 'trace-close', runtimeId: 'rt-router' },
      trace: async (record) => {
        records.push(record)
      },
    })
    [Symbol.asyncIterator]()

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: 'text_delta', text: 'partial' },
  })
  await iterator.return?.()

  assert.equal(providerClosed, true)
  assert.deepEqual(
    records.map((record) => record.kind),
    ['provider.started', 'provider.first_token', 'provider.failed'],
  )
  assert.equal(records[2]?.attributes?.providerId, 'active')
  assert.equal(records[2]?.attributes?.errorCode, 'PROVIDER_CONSUMER_CLOSED')
  assert.equal(records[2]?.attributes?.errorCategory, 'cancelled')
  assert.equal(records[2]?.attributes?.stopReason, 'consumer_closed')
  assert.equal(records[2]?.attributes?.health, 'healthy')
  assert.deepEqual(router.health('active'), { state: 'healthy', consecutiveFailures: 0 })
  assert.ok((records[1]?.metrics?.durationMs ?? -1) >= 0)
  assert.ok((records[2]?.metrics?.durationMs ?? -1) >= 0)
  assert.equal(records.filter((record) => record.kind === 'provider.failed').length, 1)
})

test('router traces bounded retry and fallback reasons without retaining Provider requests', async () => {
  const primary = provider('primary', async function* () {
    throw runtimeError('TEMPORARY', 'provider', 'private upstream failure', undefined, true)
  })
  const backup = provider('backup', async function* () {
    yield { type: 'completed' as const, stopReason: 'end_turn' }
  })
  const router = new ProviderRouter(async (id) => ({ primary, backup })[id], {
    fallbacks: { primary: [{ provider: 'backup', model: 'backup-model' }] },
  })
  const records: TraceInput[] = []
  const boundary: RouterTraceBoundary = {
    context: {
      traceId: 'trace-router',
      runtimeId: 'rt-router',
      sessionId: 's-router',
      runId: 'r-router',
      turnId: 'turn-router',
    },
    trace: async (record) => {
      records.push(record)
    },
  }

  await collect(
    streamWithTrace(router, 'primary', request('private Provider message content'), boundary),
  )

  assert.deepEqual(
    records.map((record) => ({
      kind: record.kind,
      providerId: record.attributes?.providerId,
      errorCode: record.attributes?.errorCode,
      health: record.attributes?.health,
      candidateIndex: record.metrics?.candidateIndex,
      attemptIndex: record.metrics?.attemptIndex,
    })),
    [
      {
        kind: 'provider.started',
        providerId: 'primary',
        errorCode: undefined,
        health: undefined,
        candidateIndex: 0,
        attemptIndex: 0,
      },
      {
        kind: 'provider.failed',
        providerId: 'primary',
        errorCode: 'TEMPORARY',
        health: 'degraded',
        candidateIndex: 0,
        attemptIndex: 0,
      },
      {
        kind: 'provider.retry',
        providerId: 'primary',
        errorCode: 'TEMPORARY',
        health: 'degraded',
        candidateIndex: 0,
        attemptIndex: 1,
      },
      {
        kind: 'provider.started',
        providerId: 'primary',
        errorCode: undefined,
        health: undefined,
        candidateIndex: 0,
        attemptIndex: 1,
      },
      {
        kind: 'provider.failed',
        providerId: 'primary',
        errorCode: 'TEMPORARY',
        health: 'degraded',
        candidateIndex: 0,
        attemptIndex: 1,
      },
      {
        kind: 'provider.fallback',
        providerId: 'backup',
        errorCode: 'TEMPORARY',
        health: 'degraded',
        candidateIndex: 1,
        attemptIndex: 0,
      },
      {
        kind: 'provider.started',
        providerId: 'backup',
        errorCode: undefined,
        health: undefined,
        candidateIndex: 1,
        attemptIndex: 0,
      },
      {
        kind: 'provider.completed',
        providerId: 'backup',
        errorCode: undefined,
        health: 'healthy',
        candidateIndex: 1,
        attemptIndex: 0,
      },
    ],
  )
  assert.ok(
    records
      .filter((record) => ['provider.completed', 'provider.failed'].includes(record.kind))
      .every((record) => (record.metrics?.durationMs ?? -1) >= 0),
  )
  assert.ok(records.every((record) => record.context === boundary.context))
  assert.equal(JSON.stringify(records).includes('private Provider message content'), false)
  assert.equal(JSON.stringify(records).includes('private upstream failure'), false)
})

test('router ignores trace callback failures while preserving Provider fallback', async () => {
  const primary = provider('primary', async function* () {
    throw runtimeError('TEMPORARY', 'provider', 'retry me', undefined, true)
  })
  const backup = provider('backup', async function* () {
    yield { type: 'completed' as const }
  })
  const router = new ProviderRouter(async (id) => ({ primary, backup })[id], {
    fallbacks: { primary: [{ provider: 'backup', model: 'backup-model' }] },
  })

  assert.deepEqual(
    await collect(
      streamWithTrace(router, 'primary', request(), {
        context: {
          traceId: 'trace-router',
          runtimeId: 'rt-router',
          sessionId: 's-router',
          runId: 'r-router',
          turnId: 'turn-router',
        },
        trace: async () => {
          throw new Error('trace sink failed')
        },
      }),
    ),
    [{ type: 'completed' }],
  )
})

test('router rejects a request that exceeds the selected provider context limit before calling it', async () => {
  let calls = 0
  const limited = provider(
    'limited',
    async function* () {
      calls += 1
      yield { type: 'completed' as const }
    },
    2,
  )
  const router = new ProviderRouter(async () => limited)

  await assert.rejects(
    collect(router.stream('limited', request('this request exceeds two tokens'))),
    hasCode('PROVIDER_CONTEXT_LIMIT'),
  )
  assert.equal(calls, 0)
})

test('router enforces the selected model limit instead of the Provider default', async () => {
  let calls = 0
  const broad = provider(
    'broad',
    async function* () {
      calls += 1
      yield { type: 'completed' as const }
    },
    100_000,
  )
  const router = new ProviderRouter(async () => broad, {
    modelCapabilities: () => ({
      ...broad.capabilities!,
      limits: { ...broad.capabilities!.limits, maxContextTokens: 2 },
    }),
  })

  await assert.rejects(
    collect(router.stream('broad', request('this model has the smaller context window'))),
    hasCode('PROVIDER_CONTEXT_LIMIT'),
  )
  assert.equal(calls, 0)
})

test('router traces a capability rejection as the failed candidate attempt', async () => {
  const base = provider('unsupported', async function* () {
    yield { type: 'completed' as const }
  })
  const unsupported: ChatProvider = {
    ...base,
    capabilities: {
      ...base.capabilities!,
      tools: { mode: 'none', parallelCalls: false },
    },
  }
  const records: TraceInput[] = []
  const router = new ProviderRouter(async () => unsupported)

  await assert.rejects(
    collect(
      router.stream(
        'unsupported',
        {
          ...request(),
          tools: [{ name: 'inspect', description: 'inspect', parameters: {} }],
        },
        {
          context: { traceId: 'trace-unsupported', runtimeId: 'rt-router' },
          trace: async (record) => {
            records.push(record)
          },
        },
      ),
    ),
    hasCode('PROVIDER_CAPABILITY_UNSUPPORTED'),
  )
  assert.deepEqual(
    records.map((record) => record.kind),
    ['provider.started', 'provider.failed'],
  )
  assert.equal(records[1]?.attributes?.providerId, 'unsupported')
  assert.equal(records[1]?.attributes?.health, 'healthy')
  assert.deepEqual(router.health('unsupported'), {
    state: 'healthy',
    consecutiveFailures: 0,
  })
})

test('router prepares every explicit provider-model candidate with effective capabilities', async () => {
  const primary = provider('primary', async function* () {
    throw runtimeError('PROVIDER_MODEL_UNAVAILABLE', 'provider', 'not available')
  })
  const backup = provider('backup', async function* (providerRequest) {
    assert.equal(providerRequest.model, 'backup-model')
    assert.equal(providerRequest.maxOutputTokens, 64)
    yield { type: 'completed' as const }
  })
  const prepared: Array<{
    provider: string
    model: string
    maxContextTokens?: number
  }> = []
  const router = new ProviderRouter(async (id) => ({ primary, backup })[id], {
    retryAttempts: 0,
    fallbacks: { primary: [{ provider: 'backup', model: 'backup-model' }] },
    modelCapabilities: (_providerId, modelId) =>
      modelId === 'backup-model'
        ? capabilities({ maxContextTokens: 512, maxOutputTokens: 64 })
        : capabilities({ maxContextTokens: 1024, maxOutputTokens: 128 }),
  })

  await collect(
    router.stream('primary', request(), undefined, async (candidate, baseRequest) => {
      prepared.push({
        provider: candidate.target.provider,
        model: candidate.target.model,
        maxContextTokens: candidate.capabilities?.limits.maxContextTokens,
      })
      return {
        ...baseRequest,
        maxOutputTokens: candidate.capabilities?.limits.maxOutputTokens,
      }
    }),
  )

  assert.deepEqual(prepared, [
    { provider: 'primary', model: 'test', maxContextTokens: 1024 },
    { provider: 'backup', model: 'backup-model', maxContextTokens: 512 },
  ])
})

test('router intersects adapter and model capabilities instead of advertising their union', async () => {
  let calls = 0
  const adapter = provider('primary', async function* () {
    calls += 1
    yield { type: 'completed' as const }
  })
  const router = new ProviderRouter(async () => adapter, {
    retryAttempts: 0,
    modelCapabilities: () => ({
      ...capabilities({ maxContextTokens: 20_000, maxOutputTokens: 2_000 }),
      modalities: { text: true, vision: true, audio: true },
      output: { jsonSchema: true, citations: true },
    }),
  })

  await assert.rejects(
    collect(
      router.stream('primary', {
        ...request(),
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_ref', artifactId: 'artifact-image' }],
          },
        ],
      }),
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'PROVIDER_CAPABILITY_UNSUPPORTED')
      assert.deepEqual(
        (error as { data?: { unsupportedBlocks?: unknown } }).data?.unsupportedBlocks,
        ['image_ref'],
      )
      return true
    },
  )
  assert.equal(calls, 0)
  assert.deepEqual(router.health('primary'), {
    state: 'healthy',
    consecutiveFailures: 0,
  })
})

test('router normalizes cancellation without degrading provider circuit health', async () => {
  const controller = new AbortController()
  const cancelled = provider('primary', async function* () {
    controller.abort()
    throw Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
  })
  const router = new ProviderRouter(async () => cancelled, {
    retryAttempts: 0,
    circuitFailureThreshold: 1,
  })

  await assert.rejects(
    collect(router.stream('primary', request('small', controller.signal))),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'PROVIDER_CANCELLED')
      assert.equal((error as { category?: string }).category, 'cancelled')
      return true
    },
  )
  assert.deepEqual(router.health('primary'), {
    state: 'healthy',
    consecutiveFailures: 0,
  })
})

test('router normalizes Runtime HTTP failures and transport errors into stable categories', async () => {
  const cases = [
    {
      source: runtimeError('PROVIDER_HTTP_ERROR', 'provider', 'private', { status: 401 }),
      code: 'PROVIDER_AUTH_REQUIRED',
      retryable: false,
    },
    {
      source: runtimeError('PROVIDER_HTTP_ERROR', 'provider', 'private', { status: 429 }),
      code: 'PROVIDER_RATE_LIMITED',
      retryable: true,
    },
    {
      source: Object.assign(new Error('invalid tool name'), {
        status: 400,
        code: 'invalid_request_error',
      }),
      code: 'PROVIDER_REQUEST_INVALID',
      retryable: false,
    },
    {
      source: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
      code: 'PROVIDER_TRANSPORT_ERROR',
      retryable: true,
    },
    {
      source: Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('socket closed before headers'), {
          code: 'UND_ERR_SOCKET',
        }),
      }),
      code: 'PROVIDER_TRANSPORT_ERROR',
      retryable: true,
    },
  ] as const

  for (const entry of cases) {
    const failing = provider('primary', async function* () {
      throw entry.source
    })
    const router = new ProviderRouter(async () => failing, { retryAttempts: 0 })
    await assert.rejects(collect(router.stream('primary', request())), (error: unknown) => {
      assert.equal((error as { code?: string }).code, entry.code)
      assert.equal((error as { retryable?: boolean }).retryable, entry.retryable)
      return true
    })
  }
})

test('router classifies provider auth state before dispatch without harming health', async () => {
  let calls = 0
  const unauthenticated: ChatProvider = {
    ...provider('primary', async function* () {
      calls += 1
      yield { type: 'completed' }
    }),
    authState: () => ({ status: 'expired' }),
  }
  const router = new ProviderRouter(async () => unauthenticated, { retryAttempts: 0 })

  await assert.rejects(
    collect(router.stream('primary', request())),
    hasCode('PROVIDER_AUTH_REQUIRED'),
  )
  assert.equal(calls, 0)
  assert.deepEqual(router.health('primary'), { state: 'healthy', consecutiveFailures: 0 })
})

function request(content = 'small', signal = new AbortController().signal) {
  return {
    model: 'test',
    messages: [{ role: 'user' as const, content }],
    tools: [],
    signal,
  }
}

function capabilities(limits: ProviderCapabilities['limits'] = {}): ProviderCapabilities {
  return {
    streaming: { text: true, reasoning: false, usage: true },
    tools: { mode: 'native', parallelCalls: false },
    modalities: { text: true, vision: false, audio: false },
    output: { jsonSchema: false, citations: false },
    limits,
  }
}

function provider(
  id: string,
  stream: ChatProvider['stream'],
  maxContextTokens?: number,
): ChatProvider {
  return {
    id,
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    stream,
    capabilities: {
      streaming: { text: true, reasoning: false, usage: true },
      tools: { mode: 'native', parallelCalls: false },
      modalities: { text: true, vision: false, audio: false },
      output: { jsonSchema: false, citations: false },
      limits: { ...(maxContextTokens === undefined ? {} : { maxContextTokens }) },
    },
  }
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = []
  for await (const value of stream) values.push(value)
  return values
}

type TraceInput = Omit<TraceRecord, 'schemaVersion' | 'timestamp'>

type RouterTraceBoundary = {
  context: TraceContext
  trace(record: TraceInput): Promise<void>
}

function streamWithTrace(
  router: ProviderRouter,
  providerId: string,
  providerRequest: ProviderRequest,
  trace: RouterTraceBoundary,
): AsyncIterable<ProviderChunk> {
  return router.stream(providerId, providerRequest, trace)
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
