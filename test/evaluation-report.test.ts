import assert from 'node:assert/strict'
import test from 'node:test'
import { loadEvaluationScenario } from '../apps/runtime/src/evaluation/scenario.js'
import type { EvaluationScenarioV1 } from '../apps/runtime/src/evaluation/scenario.js'
import { runEvaluationScenario } from '../apps/runtime/src/evaluation/scenarioRunner.js'
import {
  createEvaluationReport,
  serializeEvaluationReport,
} from '../apps/runtime/src/evaluation/report.js'

test('reports passed and failed counts with compact event and side-effect diffs', async () => {
  const passing = await runEvaluationScenario(scenario('report-pass'))
  const failingInput = scenario('report-fail')
  failingInput.assertions.eventOrder = ['prompt_started', 'prompt_failed']
  failingInput.assertions.filesystemChanges = [{ path: 'unauthorized.txt', change: 'created' }]
  const failing = await runEvaluationScenario(failingInput)

  const report = createEvaluationReport([passing, failing])

  assert.deepEqual(report.summary, { total: 2, passed: 1, failed: 1 })
  assert.equal(report.scenarios[0]?.passed, true)
  assert.equal(report.scenarios[1]?.passed, false)
  assert.deepEqual(report.scenarios[1]?.failures, ['events', 'filesystem'])
})

test('normalizes only serialized reports and produces equivalent output across live runs', async () => {
  const first = await runEvaluationScenario(scenario('normalization'))
  const second = await runEvaluationScenario(scenario('normalization'))
  const firstLiveTimestamp = first.observation.traces[0]?.timestamp
  const firstLiveTraceId = first.observation.traces[0]?.context.traceId

  const firstJson = serializeEvaluationReport(createEvaluationReport([first]))
  const secondJson = serializeEvaluationReport(createEvaluationReport([second]))

  assert.equal(firstJson, secondJson)
  assert.equal(first.observation.traces[0]?.timestamp, firstLiveTimestamp)
  assert.equal(first.observation.traces[0]?.context.traceId, firstLiveTraceId)
  assert.notEqual(firstLiveTimestamp, '<timestamp>')
  assert.notEqual(firstLiveTraceId, '<trace-1>')
  assert.match(firstJson, /<timestamp>/)
  assert.match(firstJson, /<trace-1>/)
  assert.equal(firstJson.includes(first.workspaceRoot), false)
})

test('normalizes temporary roots embedded in serialized tool messages', async () => {
  const scenario = await loadEvaluationScenario(
    new URL('../evals/scenarios/tool-permission.json', import.meta.url),
  )
  const first = await runEvaluationScenario(scenario)
  const second = await runEvaluationScenario(scenario)

  const firstJson = serializeEvaluationReport(createEvaluationReport([first]))
  const secondJson = serializeEvaluationReport(createEvaluationReport([second]))

  assert.equal(firstJson, secondJson)
  assert.equal(firstJson.includes('praxis-eval-'), false)
})

test('persisted reports project every prompt, message, Tool, and Provider payload to content-free evidence', async () => {
  const input = scenario('content-free-report')
  input.request.prompt = 'SENTINEL_PROMPT'
  input.providerReplay.turns[0]!.chunks = [
    { type: 'text_delta', text: 'SENTINEL_PROVIDER_TEXT' },
    { type: 'completed', stopReason: 'end_turn' },
  ]
  const result = await runEvaluationScenario(input)
  result.observation.events.push({
    type: 'tool_started',
    toolName: 'SENTINEL_TOOL_NAME',
    input: { secret: 'SENTINEL_TOOL_INPUT' },
  } as never)
  result.observation.events.push({
    type: 'tool_completed',
    output: { secret: 'SENTINEL_TOOL_OUTPUT' },
  } as never)
  result.observation.messages.push({
    role: 'tool',
    toolCallId: 'tool-call-1',
    name: 'SENTINEL_TOOL_NAME',
    content: 'SENTINEL_TOOL_OUTPUT',
  })
  result.observation.messages.push({ role: 'assistant', content: 'SENTINEL_MESSAGE_CONTENT' })

  const report = createEvaluationReport([result])
  const serialized = serializeEvaluationReport(report)

  for (const sentinel of [
    'SENTINEL_PROMPT',
    'SENTINEL_PROVIDER_TEXT',
    'SENTINEL_TOOL_NAME',
    'SENTINEL_TOOL_INPUT',
    'SENTINEL_TOOL_OUTPUT',
    'SENTINEL_MESSAGE_CONTENT',
  ]) {
    assert.equal(serialized.includes(sentinel), false, sentinel)
  }
  assert.deepEqual(report.scenarios[0]?.observation.messages, [
    { role: 'assistant' },
    { role: 'tool' },
    { role: 'assistant' },
  ])
  assert.ok(
    report.scenarios[0]?.observation.events.every((event) => Object.keys(event).length === 1),
  )
})

test('persisted reports replace assertion details with content-free failure categories', async () => {
  const input = scenario('content-free-failure')
  input.assertions.contextSelection = {
    contextMessagesContain: ['SENTINEL_REQUIRED_CONTEXT'],
    messagesExclude: [],
  }
  const result = await runEvaluationScenario(input)

  assert.equal(result.passed, false)
  assert.match(result.failures.join('\n'), /SENTINEL_REQUIRED_CONTEXT/)

  const report = createEvaluationReport([result])
  const serialized = serializeEvaluationReport(report)

  assert.deepEqual(report.scenarios[0]?.failures, ['context_selection'])
  assert.equal(serialized.includes('SENTINEL_REQUIRED_CONTEXT'), false)
})

function scenario(id: string): EvaluationScenarioV1 {
  return {
    schemaVersion: 1,
    id,
    description: 'A deterministic report fixture.',
    setup: { tools: [] },
    workspaceFixture: { files: [] },
    request: {
      provider: 'replay',
      model: 'replay-v1',
      prompt: 'Report fixture.',
    },
    budget: {
      maxTurns: 1,
      maxToolCalls: 0,
      maxTokens: 8,
      maxChildRuns: 0,
      maxParallelChildren: 0,
      maxDepth: 0,
    },
    providerReplay: {
      turns: [
        {
          id: 'turn-1',
          chunks: [
            { type: 'text_delta', text: 'ok' },
            { type: 'completed', stopReason: 'end_turn' },
          ],
        },
      ],
    },
    permissionDecisions: [],
    assertions: {
      terminalEvent: { type: 'prompt_completed', stopReason: 'end_turn' },
      eventCounts: { prompt_completed: 1 },
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
      usageBounds: { turns: { min: 1, max: 1 } },
      filesystemChanges: [],
      remainingReplayTurns: 0,
    },
  }
}
