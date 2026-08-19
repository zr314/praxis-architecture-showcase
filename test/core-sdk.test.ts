import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adaptLegacyExecutionBudgetV1,
  CancellationTree,
  type ChatProvider,
  clampChildBudget,
  createTelemetryRecord,
  createTraceRecord,
  LEGACY_EXECUTION_BUDGET_V1_DEPRECATION,
  NoopTelemetrySink,
  type PluginContext,
  type PluginManifest,
  type ProviderRequest,
  recordTelemetry,
  runtimeError,
  type SessionRepository,
  type TelemetryRecord,
  type TelemetrySink,
} from '@praxis/core-sdk'

test('child budgets cannot extend a parent budget or deadline', () => {
  const child = clampChildBudget(
    {
      maxTurns: 2,
      maxToolCalls: 3,
      maxTokens: 100,
      maxChildRuns: 1,
      maxParallelChildren: 1,
      maxDepth: 2,
      deadlineAt: '2026-07-16T02:00:00.000Z',
    },
    {
      maxTurns: 8,
      maxToolCalls: 8,
      maxTokens: 50,
      maxChildRuns: 4,
      maxParallelChildren: 2,
      maxDepth: 6,
      deadlineAt: '2026-07-16T01:00:00.000Z',
    },
  )

  assert.deepEqual(child, {
    maxTurns: 2,
    maxToolCalls: 3,
    maxTokens: 50,
    maxChildRuns: 1,
    maxParallelChildren: 1,
    maxDepth: 2,
    deadlineAt: '2026-07-16T01:00:00.000Z',
  })
})

test('deadline clamping compares real timestamps and rejects invalid timestamps', () => {
  const child = clampChildBudget(
    {
      maxTurns: 1,
      maxToolCalls: 1,
      maxChildRuns: 0,
      maxParallelChildren: 0,
      maxDepth: 0,
      deadlineAt: '2026-07-16T08:00:00+08:00',
    },
    {
      maxTurns: 1,
      maxToolCalls: 1,
      maxChildRuns: 0,
      maxParallelChildren: 0,
      maxDepth: 0,
      deadlineAt: '2026-07-16T00:30:00.000Z',
    },
  )

  assert.equal(child.deadlineAt, '2026-07-16T08:00:00+08:00')
  assert.throws(
    () =>
      clampChildBudget(
        {
          maxTurns: 1,
          maxToolCalls: 1,
          maxChildRuns: 0,
          maxParallelChildren: 0,
          maxDepth: 0,
          deadlineAt: 'not-a-date',
        },
        {
          maxTurns: 1,
          maxToolCalls: 1,
          maxChildRuns: 0,
          maxParallelChildren: 0,
          maxDepth: 0,
        },
      ),
    (error) => hasRuntimeErrorCode(error, 'INVALID_DEADLINE'),
  )
})

test('legacy execution budgets require an explicit concurrency policy', () => {
  const notices: unknown[] = []
  assert.deepEqual(
    adaptLegacyExecutionBudgetV1(
      { maxTurns: 4, maxToolCalls: 8, maxSubagents: 3, maxDepth: 2 },
      { maxParallelChildren: 1, onDeprecation: (notice) => notices.push(notice) },
    ),
    {
      maxTurns: 4,
      maxToolCalls: 8,
      maxChildRuns: 3,
      maxParallelChildren: 1,
      maxDepth: 2,
    },
  )
  assert.deepEqual(notices, [LEGACY_EXECUTION_BUDGET_V1_DEPRECATION])
  assert.equal(Object.isFrozen(LEGACY_EXECUTION_BUDGET_V1_DEPRECATION), true)
  assert.throws(
    () =>
      adaptLegacyExecutionBudgetV1(
        {
          maxTurns: 4,
          maxToolCalls: 8,
          maxSubagents: 3,
          maxDepth: 2,
          maxChildRuns: undefined,
        } as never,
        { maxParallelChildren: 1 },
      ),
    (error) => hasRuntimeErrorCode(error, 'EXECUTION_BUDGET_VERSION_MIXED'),
  )
  assert.throws(
    () =>
      adaptLegacyExecutionBudgetV1(
        { maxTurns: 4, maxToolCalls: 8, maxSubagents: 1, maxDepth: 2 },
        { maxParallelChildren: 2 },
      ),
    (error) => hasRuntimeErrorCode(error, 'INVALID_EXECUTION_BUDGET'),
  )
})

test('RuntimeError recursively removes secret-shaped diagnostic fields', () => {
  const error = runtimeError('PROVIDER_FAILED', 'provider', 'request failed', {
    apiKey: 'secret',
    prompt: 'do not retain user content',
    requestId: 'req-1',
    nested: {
      Authorization: 'Bearer secret',
      retained: true,
      values: [{ token: 'secret' }, { visible: 'yes' }],
    },
    env: { MOONSHOT_API_KEY: 'secret' },
  })

  assert.deepEqual(error, {
    code: 'PROVIDER_FAILED',
    category: 'provider',
    message: 'request failed',
    retryable: false,
    data: {
      requestId: 'req-1',
      nested: {
        retained: true,
        values: [{}, { visible: 'yes' }],
      },
    },
  })
})

test('cancellation tree marks every descendant and stays idempotent', () => {
  const tree = new CancellationTree()
  tree.link('run-root', 'run-child')
  tree.link('run-child', 'run-grandchild')

  assert.deepEqual(tree.cancel('run-root', 'user_abort'), [
    ['run-root', 'user_abort'],
    ['run-child', 'parent_cancelled'],
    ['run-grandchild', 'parent_cancelled'],
  ])
  assert.deepEqual(tree.cancel('run-root', 'user_abort'), [])
})

test('cancellation links can be unlinked idempotently', () => {
  const tree = new CancellationTree()
  tree.link('run-root', 'run-child')

  assert.equal(tree.unlink('run-root', 'run-child'), true)
  assert.equal(tree.unlink('run-root', 'run-child'), false)
  assert.equal(tree.parentFor('run-child'), undefined)
  assert.deepEqual(tree.cancel('run-root', 'user_abort'), [['run-root', 'user_abort']])
})

test('cancellation tree rejects self, indirect, and multiple-parent links', () => {
  const self = new CancellationTree()
  assert.throws(
    () => self.link('run-a', 'run-a'),
    (error) => hasRuntimeErrorCode(error, 'CANCELLATION_TREE_CYCLE'),
  )

  const indirect = new CancellationTree()
  indirect.link('run-root', 'run-child')
  assert.equal(indirect.parentFor('run-child'), 'run-root')
  assert.throws(
    () => indirect.link('run-child', 'run-root'),
    (error) => hasRuntimeErrorCode(error, 'CANCELLATION_TREE_CYCLE'),
  )

  const multipleParents = new CancellationTree()
  multipleParents.link('run-one', 'run-child')
  assert.throws(
    () => multipleParents.link('run-two', 'run-child'),
    (error) => hasRuntimeErrorCode(error, 'CANCELLATION_TREE_MULTIPLE_PARENTS'),
  )
})

test('linking a child after its parent is cancelled cancels the child immediately', () => {
  const tree = new CancellationTree()
  tree.cancel('run-root', 'runtime_shutdown')
  tree.link('run-root', 'run-late-child')

  assert.equal(tree.reasonFor('run-late-child'), 'parent_cancelled')
  assert.deepEqual(tree.cancel('run-late-child', 'user_abort'), [])
})

test('NoopTelemetrySink retains no diagnostic record', () => {
  const sink = new NoopTelemetrySink()
  sink.record({ runId: 'r-1', outcome: 'completed', data: { prompt: 'must not be stored' } })
  assert.deepEqual(sink.records(), [])
})

test('safe telemetry records redact sensitive data before a sink can observe it', () => {
  const input: TelemetryRecord = {
    runId: 'r-1',
    outcome: 'failed',
    data: {
      prompt: 'must not be recorded',
      token: 'must not be recorded',
      requestId: 'req-1',
      nested: { secret: 'must not be recorded', visible: true },
    },
  }
  const sanitized = createTelemetryRecord(input)
  assert.deepEqual(sanitized.data, { requestId: 'req-1', nested: { visible: true } })

  let observed: TelemetryRecord | undefined
  const sink: TelemetrySink = {
    record(record) {
      observed = record
    },
    records() {
      return observed ? [observed] : []
    },
  }
  recordTelemetry(sink, input)
  assert.deepEqual(observed?.data, { requestId: 'req-1', nested: { visible: true } })
})

test('compatibility telemetry remains available beside trace contracts', () => {
  const telemetry = createTelemetryRecord({ runId: 'r-1', outcome: 'completed' })
  const trace = createTraceRecord({
    kind: 'run.completed',
    timestamp: '2026-01-01T00:00:00.000Z',
    context: { traceId: 'trace-1', runtimeId: 'rt-1' },
  })

  assert.equal(telemetry.outcome, 'completed')
  assert.equal(trace.kind, 'run.completed')
})

test('core contracts support provider-neutral adapters and implementation-free ports', () => {
  const request: ProviderRequest = {
    model: 'example-model',
    messages: [{ role: 'user', content: 'hello' }],
    contextMessages: [
      { role: 'user', content: '<system-reminder>project guidance</system-reminder>' },
    ],
    tools: [],
    signal: new AbortController().signal,
  }
  const provider: ChatProvider = {
    id: 'example',
    defaultModel: request.model,
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      yield { type: 'completed' as const }
    },
  }
  const manifest: PluginManifest = {
    id: 'example-plugin',
    version: '1.0.0',
    apiVersion: 1,
    isolation: 'in-process',
    capabilities: ['llm-provider'],
  }
  const repository: SessionRepository = {
    initialize: async () => {},
    list: async () => [],
    get: async () => undefined,
    create: async (_session) => {},
    update: async (_session) => {},
    appendMessage: async () => {},
    loadMessages: async () => [],
    loadMemory: async (sessionId) => ({ sessionId }),
    saveMemory: async () => {},
  }
  const context: PluginContext = {
    registerProvider: () => {},
    registerTool: () => {},
    registerPlanner: () => {},
    registerSubagent: () => {},
    registerPersistence: () => {},
  }

  assert.equal(provider.id, 'example')
  assert.equal(request.contextMessages?.[0]?.role, 'user')
  assert.equal(manifest.capabilities[0], 'llm-provider')
  assert.equal(typeof repository.loadMessages, 'function')
  assert.equal(typeof context.registerProvider, 'function')
})

function hasRuntimeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code &&
    'category' in error
  )
}
