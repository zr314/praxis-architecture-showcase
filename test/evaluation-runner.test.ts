import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { EvaluationScenarioV1 } from '../apps/runtime/src/evaluation/scenario.js'
import { loadEvaluationScenario } from '../apps/runtime/src/evaluation/scenario.js'
import {
  runEvaluationScenario,
  type EvaluationScenarioResult,
} from '../apps/runtime/src/evaluation/scenarioRunner.js'

const basicScenario = (): EvaluationScenarioV1 => ({
  schemaVersion: 1,
  id: 'basic-e2e',
  description: 'Runs one deterministic completion through the production loop.',
  setup: { tools: [] },
  workspaceFixture: { files: [{ path: 'notes/input.txt', content: 'fixture' }] },
  request: {
    provider: 'replay',
    model: 'replay-v1',
    prompt: 'Complete the evaluation request.',
  },
  budget: {
    maxTurns: 1,
    maxToolCalls: 0,
    maxTokens: 16,
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
  },
  providerReplay: {
    turns: [
      {
        id: 'turn-1',
        expect: { model: 'replay-v1' },
        chunks: [
          { type: 'text_delta', text: 'Done.' },
          {
            type: 'completed',
            stopReason: 'end_turn',
            usage: { inputTokens: 3, outputTokens: 1 },
          },
        ],
      },
    ],
  },
  permissionDecisions: [],
  assertions: {
    terminalEvent: { type: 'prompt_completed', stopReason: 'end_turn' },
    eventCounts: { prompt_completed: 1, prompt_failed: 0, prompt_aborted: 0 },
    eventOrder: ['prompt_started', 'text_delta', 'message_committed', 'prompt_completed'],
    committedRoles: ['assistant'],
    traceKinds: [
      'run.started',
      'prompt.manifest',
      'context.selected',
      'provider.started',
      'provider.first_token',
      'provider.completed',
      'run.completed',
    ],
    usageBounds: {
      turns: { min: 1, max: 1 },
      toolCalls: { min: 0, max: 0 },
      inputTokens: { min: 3, max: 3 },
      outputTokens: { min: 1, max: 1 },
      subagents: { min: 0, max: 0 },
    },
    filesystemChanges: [],
    remainingReplayTurns: 0,
  },
})

test('runs a basic replay scenario through AgentLoop and captures one terminal observation', async () => {
  const result = await runEvaluationScenario(basicScenario())

  assert.equal(result.passed, true, result.failures.join('\n'))
  assert.equal(result.observation.events.filter(isTerminal).length, 1)
  assert.deepEqual(
    result.observation.messages.map((message) => message.role),
    ['assistant'],
  )
  assert.deepEqual(result.observation.usage, {
    turns: 1,
    toolCalls: 0,
    inputTokens: 3,
    outputTokens: 1,
    subagents: 0,
  })
  assert.match(result.workspaceRoot, /praxis-eval-/)
})

test('drives cancellation from explicit setup without relying on a reserved scenario id', async () => {
  const input = basicScenario() as unknown as Record<string, unknown>
  input.id = 'renamed-data-driven-cancellation'
  input.setup = {
    tools: ['cancel_probe'],
    cancellation: { boundary: 'after_first_provider_chunk', reason: 'user_abort' },
  }
  input.providerReplay = {
    turns: [
      {
        id: 'cancel-turn',
        chunks: [
          {
            type: 'tool_calls',
            calls: [{ id: 'must-not-run', name: 'cancel_probe', input: {} }],
          },
          { type: 'completed', stopReason: 'tool_calls' },
        ],
      },
    ],
  }
  input.assertions = {
    terminalEvent: { type: 'prompt_aborted', reason: 'user_abort' },
    eventCounts: { tool_start: 0, prompt_aborted: 1 },
    eventOrder: ['prompt_started', 'prompt_aborted'],
    committedRoles: [],
    traceKinds: [
      'run.started',
      'prompt.manifest',
      'context.selected',
      'provider.started',
      'provider.first_token',
      'provider.failed',
      'run.aborted',
    ],
    usageBounds: { turns: { min: 0, max: 0 } },
    filesystemChanges: [],
    remainingReplayTurns: 0,
    cancellationEvidence: {
      boundaryReached: true,
      toolStartsAfterBoundary: 0,
      committedMessagesAfterBoundary: 0,
    },
  }

  const result = await runEvaluationScenario(input as unknown as EvaluationScenarioV1)

  assert.equal(result.passed, true, result.failures.join('\n'))
  assert.equal(result.observation.events.at(-1)?.type, 'prompt_aborted')
})

test('contains allowed absolute and parent path tools while observing the allowed workspace write', async () => {
  const outsideDirectory = await mkdtemp(join(tmpdir(), 'praxis-eval-outside-'))
  const absoluteTarget = join(outsideDirectory, 'absolute-escape.txt')
  const parentName = `praxis-eval-parent-escape-${randomUUID()}.txt`
  const parentTarget = join(tmpdir(), parentName)
  try {
    const result = await runEvaluationScenario(
      containmentScenario(absoluteTarget, `../${parentName}`),
    )

    assert.equal(result.passed, true, result.failures.join('\n'))
    assert.deepEqual(result.observation.filesystem, [
      {
        path: 'allowed.txt',
        digest: 'sha256:eabc01f12ec3e7cb6db0ada0f8f37323b0cfe6d08a2a73479e7d5b62d7e63529',
      },
      {
        path: 'carrier.txt',
        digest: 'sha256:5803587e6791c11992f31cb91a035dbbcd5659b5370e88c4e2f4d3dbba9fa3b7',
      },
    ])
    assert.equal(await exists(absoluteTarget), false)
    assert.equal(await exists(parentTarget), false)
  } finally {
    await rm(outsideDirectory, { recursive: true, force: true })
    await rm(parentTarget, { force: true })
  }
})

test('rejects a non-portable ADS fixture path with the fixed scenario error', async () => {
  const scenario = basicScenario()
  scenario.workspaceFixture.files = [
    { path: 'carrier.txt', content: 'carrier' },
    { path: 'carrier.txt:secret', content: 'must-not-be-hidden' },
  ]

  await assert.rejects(
    runEvaluationScenario(scenario),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EVAL_SCENARIO_INVALID',
  )
})

test('rejects an undeclared process-plugin tool before runner setup can start its child', async () => {
  const scenario = await loadEvaluationScenario(
    new URL('../evals/scenarios/plugin-crash.json', import.meta.url),
  )
  scenario.setup.tools = []

  await assert.rejects(
    runEvaluationScenario(scenario),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EVAL_SCENARIO_INVALID',
  )
})

test('runs all eight baseline scenarios offline and exercises their production boundaries', async () => {
  const ids = [
    'basic-completion',
    'tool-permission',
    'provider-fallback',
    'plugin-crash',
    'long-session',
    'context-compaction',
    'iterative-compaction',
    'cancellation',
  ] as const
  const results: EvaluationScenarioResult[] = []

  for (const id of ids) {
    const scenario = await loadEvaluationScenario(
      new URL(`../evals/scenarios/${id}.json`, import.meta.url),
    )
    results.push(await runEvaluationScenario(scenario))
  }

  assert.deepEqual(
    results.filter((result) => !result.passed).map((result) => [result.id, result.failures]),
    [],
  )
  const plugin = results.find((result) => result.id === 'plugin-crash')!
  assert.deepEqual(
    plugin.observation.traces
      .filter((trace) => trace.kind.startsWith('plugin.'))
      .map((trace) => trace.kind),
    ['plugin.started', 'plugin.failed'],
  )
  assert.equal(plugin.observation.events.at(-1)?.type, 'prompt_failed')

  const compacted = results.find((result) => result.id === 'context-compaction')!
  assert.ok(compacted.evidence.contextSelections.length > 0)

  const cancelled = results.find((result) => result.id === 'cancellation')!
  assert.equal(cancelled.observation.messages.length, 0)
  assert.equal(
    cancelled.observation.events.some((event) => event.type === 'tool_start'),
    false,
  )
  assert.equal(cancelled.observation.events.at(-1)?.type, 'prompt_aborted')
})

function isTerminal(event: { type: string }): boolean {
  return ['prompt_completed', 'prompt_failed', 'prompt_aborted'].includes(event.type)
}

function containmentScenario(absoluteTarget: string, parentTarget: string): EvaluationScenarioV1 {
  return {
    schemaVersion: 1,
    id: 'tool-containment',
    description: 'Contains path tools inside the temporary evaluation workspace.',
    setup: { tools: ['write'] },
    workspaceFixture: { files: [{ path: 'carrier.txt', content: 'carrier' }] },
    request: {
      provider: 'replay',
      model: 'replay-v1',
      prompt: 'Attempt contained writes.',
    },
    budget: {
      maxTurns: 2,
      maxToolCalls: 4,
      maxTokens: 32,
      maxChildRuns: 0,
      maxParallelChildren: 0,
      maxDepth: 0,
    },
    providerReplay: {
      turns: [
        {
          id: 'writes',
          expect: { tools: ['write'] },
          chunks: [
            {
              type: 'tool_calls',
              calls: [
                {
                  id: 'absolute-write',
                  name: 'write',
                  input: { path: absoluteTarget, content: 'must-not-exist' },
                },
                {
                  id: 'parent-write',
                  name: 'write',
                  input: { path: parentTarget, content: 'must-not-exist' },
                },
                {
                  id: 'allowed-write',
                  name: 'write',
                  input: { path: 'allowed.txt', content: 'allowed' },
                },
                {
                  id: 'ads-write',
                  name: 'write',
                  input: { path: 'carrier.txt:secret', content: 'must-not-be-hidden' },
                },
              ],
            },
            { type: 'completed', stopReason: 'tool_calls' },
          ],
        },
        {
          id: 'completion',
          expect: { tools: ['write'] },
          chunks: [
            { type: 'text_delta', text: 'Contained.' },
            { type: 'completed', stopReason: 'end_turn' },
          ],
        },
      ],
    },
    permissionDecisions: [
      { toolCallId: 'absolute-write', decision: { type: 'allow_once' } },
      { toolCallId: 'parent-write', decision: { type: 'allow_once' } },
      { toolCallId: 'allowed-write', decision: { type: 'allow_once' } },
      { toolCallId: 'ads-write', decision: { type: 'allow_once' } },
    ],
    assertions: {
      terminalEvent: { type: 'prompt_completed', stopReason: 'end_turn' },
      eventCounts: { tool_start: 4, tool_end: 4, prompt_completed: 1 },
      eventOrder: [
        'prompt_started',
        'tool_planning',
        'tool_start',
        'tool_end',
        'tool_planning',
        'tool_start',
        'tool_end',
        'tool_planning',
        'tool_start',
        'tool_end',
        'tool_planning',
        'tool_start',
        'tool_end',
        'text_delta',
        'message_committed',
        'prompt_completed',
      ],
      committedRoles: ['assistant', 'tool', 'tool', 'tool', 'tool', 'assistant'],
      traceKinds: [
        'run.started',
        'prompt.manifest',
        'context.selected',
        'provider.started',
        'provider.first_token',
        'provider.completed',
        'tool.started',
        'permission.decided',
        'tool.failed',
        'tool.started',
        'permission.decided',
        'tool.failed',
        'tool.started',
        'permission.decided',
        'tool.completed',
        'tool.started',
        'permission.decided',
        'tool.failed',
        'context.selected',
        'provider.started',
        'provider.first_token',
        'provider.completed',
        'run.completed',
      ],
      usageBounds: {
        turns: { min: 2, max: 2 },
        toolCalls: { min: 4, max: 4 },
      },
      filesystemChanges: [
        {
          path: 'allowed.txt',
          change: 'created',
          digest: 'sha256:eabc01f12ec3e7cb6db0ada0f8f37323b0cfe6d08a2a73479e7d5b62d7e63529',
        },
      ],
      remainingReplayTurns: 0,
    },
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
