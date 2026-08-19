import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import basicReplay from '../evals/fixtures/basic-completion.json'
import {
  parseEvaluationScenario,
  parseProviderReplay,
  loadEvaluationScenario,
  loadProviderReplay,
  type EvaluationScenarioV1,
  type EvaluationUsageBounds,
} from '../apps/runtime/src/evaluation/scenario.js'

// @ts-expect-error Usage bounds must contain at least one declared bound.
const emptyUsageBounds: EvaluationUsageBounds = {}
void emptyUsageBounds

const scenario = (): EvaluationScenarioV1 => ({
  schemaVersion: 1,
  id: 'synthetic-basic-completion',
  description: 'Completes one synthetic request with deterministic replay data.',
  setup: { tools: [] },
  workspaceFixture: {
    files: [{ path: 'notes/synthetic.txt', content: 'Synthetic workspace content.' }],
  },
  request: {
    provider: 'replay',
    model: 'replay-v1',
    prompt: 'Produce the synthetic completion.',
  },
  budget: {
    maxTurns: 1,
    maxToolCalls: 0,
    maxTokens: 32,
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
  },
  providerReplay: {
    turns: [
      {
        id: 'turn-1',
        expect: { model: 'replay-v1', tools: [] },
        chunks: [
          { type: 'text_delta', text: 'Synthetic completion.' },
          {
            type: 'completed',
            stopReason: 'end_turn',
            usage: { inputTokens: 3, outputTokens: 2 },
          },
        ],
      },
    ],
  },
  permissionDecisions: [],
  assertions: {
    terminalEvent: { type: 'prompt_completed' },
    eventCounts: { prompt_started: 1, text_delta: 1, prompt_completed: 1 },
    eventOrder: ['prompt_started', 'text_delta', 'prompt_completed'],
    committedRoles: ['assistant'],
    traceKinds: [
      'run.started',
      'provider.started',
      'provider.first_token',
      'provider.completed',
      'run.completed',
    ],
    usageBounds: {
      turns: { min: 1, max: 1 },
      toolCalls: { min: 0, max: 0 },
      inputTokens: { min: 0, max: 8 },
      outputTokens: { min: 0, max: 8 },
      subagents: { min: 0, max: 0 },
    },
    filesystemChanges: [],
    remainingReplayTurns: 0,
  },
})

test('parses a strict v1 evaluation scenario and a standalone synthetic replay fixture', () => {
  const parsed = parseEvaluationScenario(scenario())

  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.assertions.terminalEvent.type, 'prompt_completed')
  assert.equal(parseProviderReplay(basicReplay).turns.length, 1)
})

test('rejects unsupported evaluation scenario schema versions', () => {
  const input = { ...scenario(), schemaVersion: 2 }

  assert.throws(
    () => parseEvaluationScenario(input),
    (error) => hasCode(error, 'EVAL_SCENARIO_INVALID'),
  )
})

test('rejects duplicate replay turn IDs', () => {
  const input = scenario()
  input.providerReplay.turns.push(structuredClone(input.providerReplay.turns[0]))

  assert.throws(
    () => parseEvaluationScenario(input),
    (error) => hasCode(error, 'EVAL_REPLAY_DUPLICATE_TURN_ID'),
  )
})

test('rejects unsupported Provider chunk types', () => {
  const input: unknown = {
    turns: [{ id: 'turn-1', chunks: [{ type: 'reasoning_delta', text: 'not supported' }] }],
  }

  assert.throws(
    () => parseProviderReplay(input),
    (error) => hasCode(error, 'EVAL_REPLAY_INVALID'),
  )
})

test('accepts structured v2 Provider stream chunks and complete usage accounting', () => {
  const replay = parseProviderReplay({
    turns: [
      {
        id: 'turn-v2',
        chunks: [
          { type: 'message_start' },
          { type: 'reasoning_start', contentIndex: 0 },
          { type: 'reasoning_delta', contentIndex: 0, text: 'brief' },
          { type: 'reasoning_end', contentIndex: 0 },
          { type: 'tool_call_start', index: 0, id: 'call-1', name: 'read' },
          { type: 'tool_call_delta', index: 0, argumentsDelta: '{"path":"README.md"}' },
          { type: 'tool_call_end', index: 0 },
          {
            type: 'completed',
            stopReason: 'tool_use',
            usage: {
              inputTokens: 3,
              outputTokens: 2,
              cacheReadTokens: 1,
              cacheWriteTokens: 0,
              costUsd: 0.001,
            },
          },
        ],
      },
    ],
  })

  assert.equal(replay.turns[0]?.chunks.length, 8)
})

test('normalizes recursively non-JSON replay values to a fixed content-free error', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const invalidValues: Array<[string, unknown]> = [
    ['function', () => 'PRIVATE_FUNCTION_BODY_MARKER'],
    ['undefined', undefined],
    ['date', new Date('2026-07-22T00:00:00.000Z')],
    ['map', new Map([['PRIVATE_MAP_KEY_MARKER', 'value']])],
    ['bigint', 1n],
    ['symbol', Symbol('PRIVATE_SYMBOL_MARKER')],
    ['non-finite number', Number.NaN],
    ['circular object', circular],
  ]

  for (const [label, value] of invalidValues) {
    assert.throws(
      () => parseProviderReplay(replayWithInput(value)),
      (error) => isFixedReplayInvalid(error),
      label,
    )
  }
})

test('rejects an array index accessor without executing its getter', () => {
  let getterCalls = 0
  const accessorArray: unknown[] = []
  Object.defineProperty(accessorArray, '0', {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1
      return 'PRIVATE_ARRAY_GETTER_MARKER'
    },
  })

  const error = replayParseError(accessorArray)

  assert.equal(getterCalls, 0)
  assert.equal(isFixedReplayInvalid(error), true)
})

test('rejects symbol, non-enumerable, and extra string own properties on arrays', () => {
  const symbolExtended = ['synthetic']
  Object.defineProperty(symbolExtended, Symbol('PRIVATE_ARRAY_SYMBOL_MARKER'), {
    configurable: true,
    enumerable: true,
    value: 'private',
  })
  const nonEnumerableExtended = ['synthetic']
  Object.defineProperty(nonEnumerableExtended, 'hidden', {
    configurable: true,
    enumerable: false,
    value: 'PRIVATE_ARRAY_HIDDEN_MARKER',
  })
  const stringExtended = ['synthetic']
  Object.defineProperty(stringExtended, 'extra', {
    configurable: true,
    enumerable: true,
    value: 'PRIVATE_ARRAY_EXTRA_MARKER',
  })

  for (const input of [symbolExtended, nonEnumerableExtended, stringExtended]) {
    assert.equal(isFixedReplayInvalid(replayParseError(input)), true)
  }
})

test('rejects sparse arrays and non-standard index or length descriptors', () => {
  const sparse = new Array<unknown>(2)
  sparse[1] = 'synthetic'
  const lockedIndex = ['synthetic']
  Object.defineProperty(lockedIndex, '0', { writable: false })
  const lockedLength = ['synthetic']
  Object.defineProperty(lockedLength, 'length', { writable: false })

  for (const input of [sparse, lockedIndex, lockedLength]) {
    assert.equal(isFixedReplayInvalid(replayParseError(input)), true)
  }
})

test('accepts standard dense arrays containing recursive JSON values', () => {
  assert.doesNotThrow(() =>
    parseProviderReplay(replayWithInput([null, true, 1, 'synthetic', { nested: [] }])),
  )
})

test('rejects undeclared scenario properties', () => {
  const input = { ...scenario(), environment: { SECRET_TOKEN: 'not-a-real-secret' } }

  assert.throws(
    () => parseEvaluationScenario(input),
    (error) => hasCode(error, 'EVAL_SCENARIO_INVALID'),
  )
})

test('parses explicit setup and evidence assertions while keeping nested setup strict', () => {
  const input = scenario() as unknown as Record<string, unknown>
  ;(input.request as Record<string, unknown>).provider = 'synthetic-primary'
  input.setup = {
    tools: ['write', 'plugin_crash'],
    providerRouting: {
      retryAttempts: 1,
      fallback: { provider: 'replay', model: 'replay-v1' },
      primaryFailure: {
        code: 'SYNTHETIC_RETRYABLE',
        retryable: true,
      },
    },
    processPlugin: {
      fixture: 'crash-on-invoke',
      pluginId: 'synthetic-plugin',
      capabilityId: 'fixture.crash',
      tool: 'plugin_crash',
    },
    session: {
      initialMessages: [{ role: 'user', content: 'old raw message' }],
      checkpoint: {
        id: 'checkpoint-1',
        messageStart: 0,
        messageEnd: 1,
        content: 'summary',
        digest: `sha256:${'0'.repeat(64)}`,
        estimatedTokens: 4,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    },
    cancellation: { boundary: 'after_first_provider_chunk', reason: 'user_abort' },
  }
  ;(input.assertions as Record<string, unknown>).contextSelection = {
    contextMessagesContain: ['summary'],
    messagesExclude: ['old raw message'],
  }
  ;(input.assertions as Record<string, unknown>).cancellationEvidence = {
    boundaryReached: true,
    toolStartsAfterBoundary: 0,
    committedMessagesAfterBoundary: 0,
  }

  const parsed = parseEvaluationScenario(input)

  assert.equal(parsed.setup.providerRouting?.primaryFailure.retryable, true)
  assert.equal(parsed.setup.processPlugin?.fixture, 'crash-on-invoke')
  assert.equal(parsed.setup.session?.checkpoint?.id, 'checkpoint-1')
  assert.equal(parsed.assertions.cancellationEvidence?.boundaryReached, true)

  const invalid = structuredClone(input)
  ;(invalid.setup as Record<string, unknown>).undeclared = true
  assert.throws(
    () => parseEvaluationScenario(invalid),
    (error) => hasCode(error, 'EVAL_SCENARIO_INVALID'),
  )

  const shell = structuredClone(input)
  ;(shell.setup as { tools: string[] }).tools = ['shell']
  assert.throws(
    () => parseEvaluationScenario(shell),
    (error) => hasCode(error, 'EVAL_SCENARIO_INVALID'),
  )
})

test('rejects a process plugin tool omitted from the declared execution set', () => {
  const input = scenario()
  input.setup.processPlugin = {
    fixture: 'crash-on-invoke',
    pluginId: 'synthetic-plugin',
    capabilityId: 'fixture.crash',
    tool: 'plugin_crash',
  }

  assert.throws(
    () => parseEvaluationScenario(input),
    (error) => hasCode(error, 'EVAL_SCENARIO_INVALID'),
  )
})

test('rejects provider fallback routing back to the requested provider-model pair', () => {
  const input = scenario()
  input.setup.providerRouting = {
    retryAttempts: 0,
    fallback: { provider: 'replay', model: 'replay-v1' },
    primaryFailure: { code: 'SYNTHETIC_PRIMARY_FAILURE', retryable: false },
  }

  assert.throws(
    () => parseEvaluationScenario(input),
    (error) => hasCode(error, 'EVAL_SCENARIO_INVALID'),
  )
})

test('accepts provider routing with a session context limit for candidate reselection', () => {
  const input = scenario()
  input.request.provider = 'synthetic-primary'
  input.setup.providerRouting = {
    retryAttempts: 0,
    fallback: { provider: 'replay', model: 'replay-v1' },
    primaryFailure: { code: 'SYNTHETIC_PRIMARY_FAILURE', retryable: false },
  }
  input.setup.session = {
    initialMessages: [],
    contextLimitTokens: 64,
  }

  assert.equal(parseEvaluationScenario(input).setup.session?.contextLimitTokens, 64)
})

test('rejects evaluation usage bounds whose minimum exceeds their maximum', () => {
  const input = scenario()
  input.assertions.usageBounds.turns = { min: 2, max: 1 }

  assert.throws(
    () => parseEvaluationScenario(input),
    (error) => hasCode(error, 'EVAL_SCENARIO_INVALID'),
  )
})

test('rejects a budget deadline that Runtime Date.parse semantics cannot enforce', () => {
  const input = scenario()
  input.budget.deadlineAt = 'not-a-date'

  assert.throws(
    () => parseEvaluationScenario(input),
    (error) => hasCode(error, 'EVAL_SCENARIO_INVALID'),
  )
})

test('loads and validates evaluation JSON from files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'praxis-eval-loader-'))
  const scenarioPath = join(directory, 'scenario.json')
  try {
    await writeFile(scenarioPath, JSON.stringify(scenario()), 'utf8')

    assert.equal((await loadEvaluationScenario(scenarioPath)).id, scenario().id)
    assert.equal(
      (
        await loadProviderReplay(
          new URL('../evals/fixtures/basic-completion.json', import.meta.url),
        )
      ).turns[0].id,
      'turn-1',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function replayWithInput(input: unknown): unknown {
  return {
    turns: [
      {
        id: 'turn-1',
        chunks: [
          {
            type: 'tool_calls',
            calls: [{ id: 'call-1', name: 'read', input }],
          },
        ],
      },
    ],
  }
}

function isFixedReplayInvalid(error: unknown): boolean {
  return (
    hasCode(error, 'EVAL_REPLAY_INVALID') &&
    error instanceof Error &&
    error.message === 'Provider replay fixture validation failed.'
  )
}

function replayParseError(input: unknown): unknown {
  try {
    parseProviderReplay(replayWithInput(input))
  } catch (error) {
    return error
  }
  return undefined
}
