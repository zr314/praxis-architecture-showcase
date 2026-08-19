import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createTraceRecord, type TraceRecord } from '@praxis/core-sdk'
import type { SessionEvent } from '@praxis/protocol'
import { NdjsonRuntimeBridge } from '../apps/cli/src/bridge/ndjsonBridge.js'
import {
  gradeProductionSession,
  gradeProductionWorkspace,
} from '../apps/runtime/src/evaluation/productionGrader.js'
import { summarizeProductionTraces } from '../apps/runtime/src/evaluation/productionMetrics.js'
import { createProductionEvaluationRuntime } from '../apps/runtime/src/evaluation/productionRuntime.js'
import type { ProviderReplayTurn } from '../apps/runtime/src/evaluation/scenario.js'

const productionRuntimeEntry = fileURLToPath(
  new URL('./fixtures/production-evaluation-runtime.ts', import.meta.url),
)

test('production trace summary projects only bounded latency, routing, compaction, and usage metrics', () => {
  const context = { traceId: 'trace-1', runtimeId: 'rt-1', runId: 'run-1' }
  const at = (
    kind: Parameters<typeof createTraceRecord>[0]['kind'],
    input: {
      durationMs?: number
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
      costUsd?: number
    } = {},
  ) =>
    createTraceRecord({
      kind,
      timestamp: '2026-01-01T00:00:00.000Z',
      context,
      metrics: input,
    })

  const summary = summarizeProductionTraces([
    at('provider.first_token', { durationMs: 4 }),
    at('provider.completed', {
      durationMs: 9,
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      costUsd: 0.01,
    }),
    at('provider.retry'),
    at('provider.fallback'),
    at('tool.completed', { durationMs: 5 }),
    at('context.compacted'),
    at('persistence.completed', { durationMs: 2 }),
    at('run.completed', { durationMs: 12 }),
  ])

  assert.deepEqual(summary, {
    runs: 1,
    retries: 1,
    fallbacks: 1,
    compactions: 1,
    usage: {
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      costUsd: 0.01,
    },
    cache: { hitTokens: 1, missTokens: 2, hitRate: 1 / 3 },
    performance: {
      firstToken: { metric: 'first_token', samples: 1, p50: 4, p95: 4, max: 4 },
      provider: { metric: 'provider_latency', samples: 1, p50: 9, p95: 9, max: 9 },
      tool: { metric: 'tool_latency', samples: 1, p50: 5, p95: 5, max: 5 },
      persistence: { metric: 'persistence', samples: 1, p50: 2, p95: 2, max: 2 },
      total: { metric: 'run_latency', samples: 1, p50: 12, p95: 12, max: 12 },
    },
  })
  assert.equal(JSON.stringify(summary).includes('trace-1'), false)
})

test('production evaluation helpers reject ambiguous grading and unbounded delays', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-production-helper-'))
  try {
    await assert.rejects(
      gradeProductionWorkspace(root, [
        { path: 'result.txt', content: 'one' },
        { path: 'result.txt', content: 'two' },
      ]),
      /unique portable paths/u,
    )
    assert.deepEqual(
      gradeProductionSession(
        {
          exportVersion: 1,
          exportedAt: '2026-01-01T00:00:00.000Z',
          session: {
            sessionId: 'missing-state',
            state: 'idle',
            cwd: root,
            provider: 'replay',
            model: 'replay-v1',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            usage: {},
            messageCount: 0,
          },
          messages: [],
          memory: {},
        },
        {
          terminal: 'completed',
          minimumMessages: 1,
          requiredRoles: ['assistant'],
          checkpoint: true,
        },
      ),
      {
        passed: false,
        failures: ['terminal', 'message_count', 'role:assistant', 'checkpoint'],
      },
    )
    assert.throws(
      () =>
        createProductionEvaluationRuntime({
          repositoryRoot: join(root, 'repository'),
          traceRoot: join(root, 'trace'),
          replay: { turns: [completionTurn('unused', 'unused')] },
          chunkDelayMs: Number.POSITIVE_INFINITY,
        }),
      /between 0 and 1000 ms/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('production composition evaluation covers permission, paths, compaction, fallback, cancellation, finalization, and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-production-eval-'))
  const workspace = join(root, 'workspace')
  const repositoryRoot = join(root, 'repository')
  const traceRoot = join(root, 'trace')
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(repositoryRoot, { recursive: true }),
    mkdir(traceRoot, { recursive: true }),
  ])

  try {
    const first = await startProductionRuntime(root, {
      repositoryRoot,
      traceRoot,
      replay: {
        turns: [
          {
            id: 'write',
            expect: { model: 'replay-v1' },
            chunks: [
              {
                type: 'tool_calls',
                calls: [
                  {
                    id: 'write-1',
                    name: 'write',
                    input: {
                      path: 'nested/../result.txt',
                      content: 'production path',
                      createOnly: true,
                    },
                  },
                ],
              },
              {
                type: 'completed',
                stopReason: 'tool_calls',
                usage: { inputTokens: 2, outputTokens: 1 },
              },
            ],
          },
          completionTurn('write-finished', 'write complete'),
          completionTurn('history-1', 'must retain first history response'),
          completionTurn('history-2', 'must retain second history response'),
          completionTurn('fallback', 'fallback complete'),
        ],
      },
      fallback: {
        fromProvider: 'evaluation-primary',
        toProvider: 'replay',
        toModel: 'replay-v1',
      },
    })
    let sessionId = ''
    try {
      const session = await first.createSession({
        cwd: workspace,
        provider: 'replay',
        model: 'replay-v1',
      })
      sessionId = session.sessionId
      const writeEvents = await collectPrompt(first, session.sessionId, 'write result', (event) => {
        if (event.type !== 'permission_request') return
        assert.equal(event.target, join(workspace, 'result.txt'))
        return first.decidePermission(event.requestId, { type: 'allow_once' })
      })
      assert.equal(writeEvents.at(-1)?.type, 'prompt_completed')
      const historyOneEvents = await collectPrompt(first, session.sessionId, 'history one')
      assert.equal(
        historyOneEvents.at(-1)?.type,
        'prompt_completed',
        JSON.stringify(historyOneEvents.at(-1)),
      )
      const historyTwoEvents = await collectPrompt(first, session.sessionId, 'history two')
      assert.equal(
        historyTwoEvents.at(-1)?.type,
        'prompt_completed',
        JSON.stringify(historyTwoEvents.at(-1)),
      )
      assert.equal((await first.compactSession(session.sessionId)).compacted, true)

      const fallback = await first.createSession({
        cwd: workspace,
        provider: 'evaluation-primary',
        model: 'primary-v1',
      })
      const providerCompletionsBeforeFallback = (await loadProductionTraces(traceRoot)).filter(
        (record) => record.kind === 'provider.completed',
      ).length
      assert.equal(providerCompletionsBeforeFallback, 4)
      const fallbackEvents = await collectPrompt(first, fallback.sessionId, 'use fallback')
      assert.equal(
        fallbackEvents.at(-1)?.type,
        'prompt_completed',
        JSON.stringify(fallbackEvents.at(-1)),
      )

      const workspaceGrade = await gradeProductionWorkspace(workspace, [
        { path: 'result.txt', content: 'production path' },
      ])
      assert.deepEqual(workspaceGrade, {
        passed: true,
        failures: [],
        files: [
          {
            path: 'result.txt',
            digest: 'sha256:4ccbc0c17e2e5bc67622903f8a9a0989dc811feb6fbb1f679741f92958a8768d',
          },
        ],
      })
      assert.deepEqual(
        gradeProductionSession(await first.exportSession(session.sessionId), {
          terminal: 'completed',
          minimumMessages: 8,
          requiredRoles: ['user', 'assistant', 'tool'],
          checkpoint: true,
        }),
        { passed: true, failures: [] },
      )
    } finally {
      await first.dispose()
    }

    const cancellation = await startProductionRuntime(root, {
      repositoryRoot,
      traceRoot,
      chunkDelayMs: 100,
      replay: { turns: [completionTurn('cancel', 'cancel after this chunk')] },
    })
    try {
      const session = await cancellation.createSession({
        cwd: workspace,
        provider: 'replay',
        model: 'replay-v1',
      })
      const events = await collectPrompt(cancellation, session.sessionId, 'cancel me', (event) => {
        if (event.type === 'text_delta') return cancellation.abort(event.runId)
      })
      assert.equal(events.at(-1)?.type, 'prompt_aborted')
    } finally {
      await cancellation.dispose()
    }

    const failing = await startProductionRuntime(root, {
      repositoryRoot,
      traceRoot,
      failFirstFinalization: true,
      replay: { turns: [completionTurn('fail-finalization', 'durable before terminal')] },
    })
    try {
      const session = await failing.createSession({
        cwd: workspace,
        provider: 'replay',
        model: 'replay-v1',
      })
      sessionId = session.sessionId
      const events = await collectPrompt(failing, session.sessionId, 'fail finalization')
      const terminal = events.at(-1)
      assert.equal(terminal?.type, 'prompt_failed')
      assert.equal(
        terminal?.type === 'prompt_failed' ? terminal.code : undefined,
        'PERSISTENCE_OPERATION_FAILED',
      )
    } finally {
      await failing.dispose()
    }

    const restarted = await startProductionRuntime(root, {
      repositoryRoot,
      traceRoot,
      replay: { turns: [completionTurn('recovered', 'restart recovered')] },
    })
    try {
      const resumed = await restarted.resumeSession(sessionId)
      const events = await collectPrompt(restarted, resumed.sessionId, 'continue after restart')
      assert.equal(events.at(-1)?.type, 'prompt_completed')
      assert.equal((await restarted.exportSession(resumed.sessionId)).session.state, 'idle')
    } finally {
      await restarted.dispose()
    }

    const traces = await loadProductionTraces(traceRoot)
    const metrics = summarizeProductionTraces(traces)
    const compactionReasons = traces
      .filter((record) => record.kind === 'context.compacted')
      .map((record) => record.attributes?.compactionReason)
    assert.ok(metrics.runs >= 7)
    assert.equal(metrics.fallbacks, 1)
    assert.equal(metrics.compactions, compactionReasons.length)
    assert.equal(compactionReasons.filter((reason) => reason === 'manual').length, 1)
    assert.ok(compactionReasons.every((reason) => reason === 'manual' || reason === 'threshold'))
    assert.ok(metrics.performance.firstToken.samples >= 1)
    assert.ok(metrics.performance.provider.samples >= 1)
    assert.ok(metrics.performance.tool.samples >= 1)
    assert.ok(metrics.performance.persistence.samples >= 1)
    assert.ok(metrics.performance.total.samples >= 1)
    assert.equal(
      traces.some((record) => record.kind === 'persistence.failed'),
      true,
    )
    assert.equal(JSON.stringify(metrics).includes(workspace), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function completionTurn(id: string, text: string): ProviderReplayTurn {
  return {
    id,
    expect: { model: 'replay-v1' },
    chunks: [
      { type: 'text_delta', text },
      {
        type: 'completed',
        stopReason: 'end_turn',
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          cacheReadTokens: 1,
          cacheWriteTokens: 1,
          costUsd: 0.001,
        },
      },
    ],
  }
}

async function startProductionRuntime(root: string, config: Record<string, unknown>) {
  const configPath = join(root, `runtime-${crypto.randomUUID()}.json`)
  await writeFile(configPath, `${JSON.stringify(config)}\n`, 'utf8')
  return NdjsonRuntimeBridge.start(
    process.execPath,
    ['--import', 'tsx', productionRuntimeEntry, configPath],
    { env: { ...process.env, PRAXIS_HOME: root } },
  )
}

async function collectPrompt(
  bridge: NdjsonRuntimeBridge,
  sessionId: string,
  text: string,
  handle?: (event: SessionEvent) => void | Promise<void>,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = []
  for await (const event of bridge.prompt({
    sessionId,
    text,
    clientRequestId: `production-${crypto.randomUUID()}`,
    budget: { maxTurns: 3, maxToolCalls: 2, maxTokens: 64 },
    timeoutMs: 10_000,
  })) {
    events.push(event)
    await handle?.(event)
  }
  return events
}

async function loadProductionTraces(root: string) {
  const traces: TraceRecord[] = []
  for (const date of await readdir(join(root, 'traces'))) {
    for (const name of await readdir(join(root, 'traces', date))) {
      if (!name.endsWith('.jsonl')) continue
      const source = await readFile(join(root, 'traces', date, name), 'utf8')
      for (const line of source.trim().split('\n')) {
        if (line) traces.push(JSON.parse(line) as TraceRecord)
      }
    }
  }
  return traces
}
