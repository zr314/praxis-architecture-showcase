import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type ChatProvider,
  contentText,
  type PromptManifest,
  type ProviderRequest,
  providerToolCalls,
  reasoningText,
  runtimeError,
  type SystemPromptBuild,
  type TraceContext,
  type TraceRecord,
} from '@praxis/core-sdk'
import type { PermissionDecision, SessionEvent } from '@praxis/protocol'
import { AgentLoop, type AgentLoopPorts, type AgentRun } from '../apps/runtime/src/loop/index.js'
import { AgentTaskPlanner } from '../apps/runtime/src/planner/index.js'
import type { PlannerExecution } from '../apps/runtime/src/planner-api/index.js'
import { ProviderRouter } from '../apps/runtime/src/provider-router/providerRouter.js'
import type { ManagedSession } from '../apps/runtime/src/session/index.js'
import { GrepTool } from '../apps/runtime/src/tools/grepTool.js'
import { LsTool } from '../apps/runtime/src/tools/lsTool.js'
import { ToolRuntime } from '../apps/runtime/src/tools/toolRuntime.js'

const TEST_PROMPT_PROGRAM = {
  variant: 'baseline-v1' as const,
  trustedInstructions: {
    id: 'praxis.trusted-instructions' as const,
    version: 'test-v1',
    owner: 'runtime' as const,
    blockCount: 1 as const,
    digest: `sha256:${'0'.repeat(64)}` as const,
    estimatedTokens: 0,
    componentIds: [] as string[],
  },
}

test('AgentTaskPlanner delegates through AgentLoop and commits one terminal completion', async () => {
  const provider = scriptedProvider([
    [
      { type: 'text_delta', text: 'Hello from the loop.' },
      { type: 'completed', stopReason: 'end_turn' },
    ],
  ])
  const harness = createHarness(provider)
  await new AgentTaskPlanner(harness.loop).execute(harness.execution)

  assert.deepEqual(
    harness.events.map((event) => event.type),
    ['prompt_started', 'text_delta', 'message_committed', 'prompt_completed'],
  )
  assert.equal(harness.session.messages.at(-1)?.role, 'assistant')
  assert.equal(harness.terminals, 1)
  assert.equal(harness.traces.filter((record) => record.kind === 'run.completed').length, 1)
})

test('AgentLoop preserves structured reasoning and Tool blocks while accounting full usage', async () => {
  let turn = 0
  const provider: ChatProvider = {
    id: 'structured',
    defaultModel: 'test',
    contractVersion: 2,
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      if (turn++ === 0) {
        yield { type: 'message_start' as const }
        yield { type: 'reasoning_start' as const, contentIndex: 0 }
        yield { type: 'reasoning_delta' as const, contentIndex: 0, text: 'inspect first' }
        yield { type: 'reasoning_end' as const, contentIndex: 0 }
        yield { type: 'tool_call_start' as const, index: 0, id: 'call-v2', name: 'inspect' }
        yield {
          type: 'tool_call_delta' as const,
          index: 0,
          argumentsDelta: '{"path":"note.txt"}',
        }
        yield { type: 'tool_call_end' as const, index: 0 }
        yield {
          type: 'completed' as const,
          stopReason: 'tool_use',
          usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 3, costUsd: 0.001 },
        }
        return
      }
      yield { type: 'text_start' as const, contentIndex: 0 }
      yield { type: 'text_delta' as const, contentIndex: 0, text: 'Done.' }
      yield { type: 'text_end' as const, contentIndex: 0 }
      yield {
        type: 'completed' as const,
        stopReason: 'stop',
        usage: { inputTokens: 2, outputTokens: 1, cacheWriteTokens: 2, costUsd: 0.002 },
      }
    },
  }
  const harness = createHarness(provider)

  await harness.loop.execute(harness.session, harness.run)

  const assistantMessages = harness.session.messages.filter(
    (message) => message.role === 'assistant',
  )
  assert.equal(reasoningText(assistantMessages[0]!.content), 'inspect first')
  assert.deepEqual(providerToolCalls(assistantMessages[0]!), [
    { id: 'call-v2', name: 'inspect', input: { path: 'note.txt' } },
  ])
  assert.equal(contentText(assistantMessages[1]!.content), 'Done.')
  assert.equal(
    harness.events.some((event) => event.type === 'thinking_delta'),
    true,
  )
  assert.deepEqual(harness.run.usage, {
    turns: 2,
    toolCalls: 1,
    subagents: 0,
    inputTokens: 6,
    outputTokens: 3,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    costUsd: 0.003,
  })
})

test('AgentLoop persists model-selected Skill output as a typed invocation entry', async () => {
  const invocation = {
    type: 'skill_invocation' as const,
    version: 1 as const,
    capabilityId: 'project/review',
    origin: 'project:workspace',
    digest: `sha256:${'a'.repeat(64)}` as `sha256:${string}`,
    arguments: 'focus',
    content: 'Exact Skill content.',
  }
  const provider = scriptedProvider([
    [
      {
        type: 'tool_calls',
        calls: [{ id: 'skill-call', name: 'inspect', input: { path: '.' } }],
      },
      { type: 'completed', stopReason: 'tool_calls' },
    ],
    [{ type: 'completed', stopReason: 'end_turn' }],
  ])
  const harness = createHarness(provider, { inspectOutput: invocation })

  await harness.loop.execute(harness.session, harness.run)

  const message = harness.session.messages.find(
    (candidate) => candidate.role === 'tool' && candidate.toolCallId === 'skill-call',
  )
  assert.equal(message?.role, 'tool')
  assert.deepEqual(message?.role === 'tool' ? message.skillInvocation : undefined, invocation)
})

test('AgentLoop applies the selected model output ceiling to every Provider request', async () => {
  const limits: Array<number | undefined> = []
  const provider: ChatProvider = {
    id: 'limited',
    defaultModel: 'limited-model',
    authState: () => ({ status: 'authenticated' }),
    async *stream(request) {
      limits.push(request.maxOutputTokens)
      yield { type: 'completed' as const, stopReason: 'end_turn' }
    },
  }
  const harness = createHarness(provider, { outputTokenLimit: 32_000 })
  const budgeted = createHarness(provider, { outputTokenLimit: 32_000 })
  budgeted.run.budget = {
    maxTurns: 2,
    maxToolCalls: 0,
    maxTokens: 1_000,
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
  }

  await harness.loop.execute(harness.session, harness.run)
  await budgeted.loop.execute(budgeted.session, budgeted.run)

  assert.deepEqual(limits, [32_000, 1_000])
})

test('AgentLoop synchronously claims exactly one terminal outcome across a finish race', async () => {
  const harness = createHarness(scriptedProvider([[]]), { portClaimsTerminal: false })

  await Promise.all([
    harness.loop.finish(harness.session, harness.run, {
      type: 'prompt_completed',
      runId: harness.run.id,
    }),
    harness.loop.finish(harness.session, harness.run, {
      type: 'prompt_failed',
      runId: harness.run.id,
      code: 'PROVIDER_ERROR',
      category: 'provider',
      error: 'The provider request failed.',
    }),
  ])

  assert.equal(harness.run.terminal, true)
  assert.equal(harness.terminals, 1)
  assert.equal(
    harness.traces.filter((record) =>
      ['run.completed', 'run.failed', 'run.aborted'].includes(record.kind),
    ).length,
    1,
  )
})

test('AgentLoop does not settle before asynchronous finalization completes', async () => {
  const finishStarted = deferred<void>()
  const finishGate = deferred<void>()
  const harness = createHarness(
    scriptedProvider([[{ type: 'completed', stopReason: 'end_turn' }]]),
    { finishStarted, finishGate },
  )

  let settled = false
  const execution = harness.loop.execute(harness.session, harness.run).finally(() => {
    settled = true
  })
  await finishStarted.promise
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(settled, false)
  assert.equal(
    harness.events.some((event) => event.type === 'prompt_completed'),
    false,
  )

  finishGate.resolve()
  await execution
  assert.equal(harness.events.at(-1)?.type, 'prompt_completed')
})

test('AgentLoop runs a permissioned tool, persists its result, then continues the provider turn', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_calls',
        calls: [{ id: 'call-1', name: 'inspect', input: { path: 'note.txt' } }],
      },
    ],
    [{ type: 'text_delta', text: 'Tool result received.' }, { type: 'completed' }],
  ])
  const harness = createHarness(provider, {
    permission: { type: 'allow_once' },
    providerRouter: new ProviderRouter(async (id) => (id === provider.id ? provider : undefined), {
      retryAttempts: 0,
    }),
  })
  await harness.loop.execute(harness.session, harness.run)

  assert.deepEqual(
    harness.events.filter((event) => event.type.startsWith('tool_')).map((event) => event.type),
    ['tool_planning', 'tool_start', 'tool_end'],
  )
  assert.equal(harness.session.messages.filter((message) => message.role === 'tool').length, 1)
  assert.equal(harness.events.at(-1)?.type, 'prompt_completed')
})

test('AgentLoop runs independent reads concurrently and commits Tool results in Provider order', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_calls',
        calls: [
          { id: 'read-a', name: 'inspect', input: { path: 'a.txt' } },
          { id: 'read-b', name: 'inspect', input: { path: 'b.txt' } },
        ],
      },
    ],
    [{ type: 'completed', stopReason: 'end_turn' }],
  ])
  const harness = createHarness(provider)

  await harness.loop.execute(harness.session, harness.run)

  assert.equal(harness.maximumToolExecutions, 2)
  assert.deepEqual(
    harness.session.messages
      .filter((message) => message.role === 'tool')
      .map((message) => message.toolCallId),
    ['read-a', 'read-b'],
  )
})

test('AgentLoop commits mixed Tool results independently in Provider order', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_calls',
        calls: [
          { id: 'read-a', name: 'inspect', input: { path: 'a.txt' } },
          { id: 'invalid-grep', name: 'grep', input: {} },
          { id: 'failed-ls', name: 'ls', input: { path: 'package.json' } },
          { id: 'read-b', name: 'inspect', input: { path: 'b.txt' } },
        ],
      },
    ],
    [{ type: 'completed', stopReason: 'end_turn' }],
  ])
  const harness = createHarness(provider)

  await harness.loop.execute(harness.session, harness.run)

  const messages = harness.session.messages.filter((message) => message.role === 'tool')
  assert.deepEqual(
    messages.map(({ toolCallId, name }) => ({ toolCallId, name })),
    [
      { toolCallId: 'read-a', name: 'inspect' },
      { toolCallId: 'invalid-grep', name: 'grep' },
      { toolCallId: 'failed-ls', name: 'ls' },
      { toolCallId: 'read-b', name: 'inspect' },
    ],
  )
  assert.deepEqual(
    messages.map((message) => JSON.parse(contentText(message.content))),
    [
      {
        ok: true,
        summary: 'inspected:{"path":"a.txt"}',
        output: { value: 'private-tool-output', input: { path: 'a.txt' } },
      },
      {
        ok: false,
        summary:
          "Tool input did not match its registered schema: / must have required property 'query'.",
        error: { code: 'TOOL_INPUT_INVALID', category: 'validation', retryable: true },
      },
      {
        ok: false,
        summary: 'Target has the wrong filesystem type.',
        error: { code: 'TOOL_TARGET_TYPE_INVALID', category: 'validation', retryable: true },
      },
      {
        ok: true,
        summary: 'inspected:{"path":"b.txt"}',
        output: { value: 'private-tool-output', input: { path: 'b.txt' } },
      },
    ],
  )
  assert.deepEqual(
    harness.events
      .filter((event) => event.type === 'tool_planning')
      .map(({ toolCallId, name }) => ({ toolCallId, name })),
    [
      { toolCallId: 'read-a', name: 'inspect' },
      { toolCallId: 'invalid-grep', name: 'grep' },
      { toolCallId: 'failed-ls', name: 'ls' },
      { toolCallId: 'read-b', name: 'inspect' },
    ],
  )
  assert.deepEqual(
    harness.events
      .filter((event) => event.type === 'tool_end')
      .map(({ toolCallId, ok, error }) => ({ toolCallId, ok, error })),
    [
      { toolCallId: 'read-a', ok: true, error: undefined },
      {
        toolCallId: 'invalid-grep',
        ok: false,
        error: { code: 'TOOL_INPUT_INVALID', category: 'validation', retryable: true },
      },
      {
        toolCallId: 'failed-ls',
        ok: false,
        error: { code: 'TOOL_TARGET_TYPE_INVALID', category: 'validation', retryable: true },
      },
      { toolCallId: 'read-b', ok: true, error: undefined },
    ],
  )
  assert.equal(harness.events.at(-1)?.type, 'prompt_completed')
})

test('AgentLoop returns missing Tool failures to the Provider as structured results', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_calls',
        calls: [{ id: 'missing-call', name: 'missing_tool', input: {} }],
      },
    ],
    [{ type: 'completed', stopReason: 'end_turn' }],
  ])
  const harness = createHarness(provider)

  await harness.loop.execute(harness.session, harness.run)

  const toolMessage = harness.session.messages.find((message) => message.role === 'tool')
  assert.deepEqual(JSON.parse(contentText(toolMessage!.content)), {
    ok: false,
    summary: 'Unknown tool: missing_tool',
    error: { code: 'TOOL_NOT_FOUND', category: 'not_found', retryable: false },
  })
  assert.equal(harness.events.at(-1)?.type, 'prompt_completed')
  assert.equal(harness.terminals, 1)
})

test('AgentLoop rejects Tool execution when Provider output was length-truncated', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_calls',
        calls: [{ id: 'truncated-call', name: 'inspect', input: { path: 'unsafe' } }],
      },
      { type: 'completed', stopReason: 'length' },
    ],
    [{ type: 'completed', stopReason: 'end_turn' }],
  ])
  const harness = createHarness(provider)

  await harness.loop.execute(harness.session, harness.run)

  assert.equal(harness.toolExecutions, 0)
  const toolMessage = harness.session.messages.find((message) => message.role === 'tool')
  assert.equal(JSON.parse(contentText(toolMessage!.content)).error.code, 'TOOL_CALL_TRUNCATED')
  assert.equal(harness.events.at(-1)?.type, 'prompt_completed')
})

test('AgentLoop preserves bounded partial text but fails a length-truncated final response', async () => {
  const provider = scriptedProvider([
    [
      { type: 'text_delta', text: 'bounded partial response' },
      { type: 'completed', stopReason: 'length' },
    ],
  ])
  const harness = createHarness(provider)

  await harness.loop.execute(harness.session, harness.run)

  assert.equal(contentText(harness.session.messages.at(-1)!.content), 'bounded partial response')
  assert.deepEqual(harness.events.at(-1), {
    type: 'prompt_failed',
    runId: harness.run.id,
    code: 'PROVIDER_OUTPUT_TRUNCATED',
    category: 'provider',
    error: 'The Provider reached the bounded output limit before completing the response.',
  })
})

test('AgentLoop maps malformed Provider streams to one content-free terminal failure', async () => {
  const provider: ChatProvider = {
    id: 'malformed',
    defaultModel: 'test',
    contractVersion: 2,
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      yield { type: 'text_start' as const, contentIndex: 0 }
      yield { type: 'text_delta' as const, contentIndex: 0, text: 'private partial output' }
      yield { type: 'completed' as const, stopReason: 'end_turn' }
    },
  }
  const harness = createHarness(provider)

  await harness.loop.execute(harness.session, harness.run)

  assert.deepEqual(harness.events.at(-1), {
    type: 'prompt_failed',
    runId: harness.run.id,
    code: 'PROVIDER_STREAM_INVALID',
    category: 'provider',
    error: 'The provider returned a malformed stream.',
  })
  assert.equal(JSON.stringify(harness.events.at(-1)).includes('private partial output'), false)
  assert.equal(harness.terminals, 1)
})

test('AgentLoop stops an oversized Provider stream before buffering or committing it', async () => {
  const provider: ChatProvider = {
    id: 'oversized',
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      yield { type: 'text_delta' as const, text: 'x'.repeat(769 * 1_024) }
      yield { type: 'completed' as const, stopReason: 'end_turn' }
    },
  }
  const harness = createHarness(provider)

  await harness.loop.execute(harness.session, harness.run)

  assert.deepEqual(harness.events.at(-1), {
    type: 'prompt_failed',
    runId: harness.run.id,
    code: 'PROVIDER_OUTPUT_OVERSIZED',
    category: 'provider',
    error: 'Provider output exceeded the bounded Runtime turn buffer.',
  })
  assert.equal(harness.session.messages.length, 1)
})

test('AgentLoop advises on a repeated Tool-call loop without imposing a hidden run ceiling', async () => {
  const provider = scriptedProvider([
    ...Array.from({ length: 3 }, (_, index) => [
      {
        type: 'tool_calls' as const,
        calls: [{ id: `duplicate-${index}`, name: 'inspect', input: { path: 'same' } }],
      },
    ]),
    [{ type: 'completed' as const, stopReason: 'end_turn' }],
  ])
  const harness = createHarness(provider)

  await harness.loop.execute(harness.session, harness.run)

  assert.equal(harness.toolExecutions, 3)
  assert.deepEqual(harness.events.at(-1), {
    type: 'prompt_completed',
    runId: harness.run.id,
    stopReason: 'end_turn',
    usage: undefined,
  })
  assert.equal(
    harness.session.messages.some(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes('no observable progress'),
    ),
    true,
  )
})

test('AgentLoop traces invalid Tool input as one timed input-blocked lifecycle', async () => {
  const provider = scriptedProvider([
    [{ type: 'tool_calls', calls: [{ id: 'invalid-call', name: 'inspect', input: 'private' }] }],
    [{ type: 'completed' }],
  ])
  const harness = createHarness(provider)

  await harness.loop.execute(harness.session, harness.run)

  const records = harness.traces.filter((record) => record.context.toolCallId === 'invalid-call')
  assert.deepEqual(
    records.map((record) => record.kind),
    ['tool.started', 'tool.failed'],
  )
  assert.equal(records[1]?.attributes?.toolOutcome, 'input_blocked')
  assert.ok((records[1]?.metrics?.durationMs ?? -1) >= 0)
  assert.equal(harness.toolExecutions, 0)
})

test('AgentLoop traces permission denial as one timed policy-blocked lifecycle', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_calls',
        calls: [{ id: 'denied-call', name: 'inspect', input: { path: 'private' } }],
      },
    ],
    [{ type: 'completed' }],
  ])
  const harness = createHarness(provider, { permission: { type: 'deny', reason: 'denied' } })

  await harness.loop.execute(harness.session, harness.run)

  const records = harness.traces.filter((record) => record.context.toolCallId === 'denied-call')
  assert.deepEqual(
    records.map((record) => record.kind),
    ['tool.started', 'permission.decided', 'tool.failed'],
  )
  assert.equal(records[1]?.attributes?.permissionDecision, 'deny')
  assert.equal(records[2]?.attributes?.toolOutcome, 'policy_blocked')
  assert.ok((records[2]?.metrics?.durationMs ?? -1) >= 0)
  assert.equal(harness.toolExecutions, 0)
})

test('AgentLoop traces an existing allow-always rule before the timed Tool completion', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_calls',
        calls: [{ id: 'allowed-call', name: 'inspect', input: { path: 'private' } }],
      },
    ],
    [{ type: 'completed' }],
  ])
  const harness = createHarness(provider, {
    permission: { type: 'allow_always' },
    permissionRule: true,
  })

  await harness.loop.execute(harness.session, harness.run)

  const records = harness.traces.filter((record) => record.context.toolCallId === 'allowed-call')
  assert.deepEqual(
    records.map((record) => record.kind),
    ['tool.started', 'permission.decided', 'tool.completed'],
  )
  assert.equal(records[1]?.attributes?.permissionDecision, 'allow_always')
  assert.equal(records[2]?.attributes?.toolOutcome, 'completed')
  assert.ok((records[2]?.metrics?.durationMs ?? -1) >= 0)
  assert.equal(harness.permissionRequests, 0)
  assert.equal(harness.toolExecutions, 1)
})

test('AgentLoop correlates run, Provider, policy, and Tool records without retaining content', async () => {
  const provider = scriptedProvider([
    [
      {
        type: 'tool_calls',
        calls: [
          { id: 'stable-call-1', name: 'inspect', input: { path: 'private-tool-input.txt' } },
        ],
      },
    ],
    [
      { type: 'text_delta', text: 'private-provider-output' },
      {
        type: 'completed',
        stopReason: 'end_turn',
        usage: { inputTokens: 11, outputTokens: 7 },
      },
    ],
  ])
  const harness = createHarness(provider, {
    permission: { type: 'allow_once' },
    providerRouter: new ProviderRouter(async (id) => (id === provider.id ? provider : undefined), {
      retryAttempts: 0,
    }),
  })
  harness.run.text = 'private-run-prompt'
  harness.session.messages[0] = { role: 'user', content: harness.run.text }

  await harness.loop.execute(harness.session, harness.run)

  assert.ok(harness.traces.length > 0)
  assert.ok(
    harness.traces.every(
      (record) =>
        record.context.traceId === harness.run.trace.traceId &&
        record.context.runtimeId === harness.run.trace.runtimeId &&
        record.context.sessionId === harness.run.trace.sessionId &&
        record.context.runId === harness.run.trace.runId,
    ),
  )
  const providerStarts = harness.traces.filter((record) => record.kind === 'provider.started')
  assert.equal(providerStarts.length, 2)
  assert.equal(new Set(providerStarts.map((record) => record.context.turnId)).size, 2)
  assert.ok(providerStarts.every((record) => record.context.turnId !== undefined))

  const toolRecords = harness.traces.filter((record) => record.kind.startsWith('tool.'))
  assert.deepEqual(
    toolRecords.map((record) => record.context.toolCallId),
    ['stable-call-1', 'stable-call-1'],
  )
  assert.ok(
    toolRecords.every((record) => record.context.turnId === providerStarts[0]?.context.turnId),
  )
  assert.equal(
    harness.traces.find((record) => record.kind === 'permission.decided')?.attributes
      ?.permissionDecision,
    'allow_once',
  )
  assert.equal(harness.traces.filter((record) => record.kind === 'prompt.manifest').length, 1)
  assert.ok(
    harness.traces
      .filter((record) =>
        ['provider.completed', 'tool.completed', 'run.completed'].includes(record.kind),
      )
      .every((record) => record.metrics?.durationMs !== undefined),
  )
  const providerUsage = harness.traces.find(
    (record) => record.kind === 'provider.completed' && record.metrics?.inputTokens === 11,
  )?.metrics
  assert.equal(providerUsage?.inputTokens, 11)
  assert.equal(providerUsage?.outputTokens, 7)
  assert.ok((providerUsage?.durationMs ?? -1) >= 0)
  assert.equal(
    harness.traces.filter((record) =>
      ['run.completed', 'run.failed', 'run.aborted'].includes(record.kind),
    ).length,
    1,
  )
  const serialized = JSON.stringify(harness.traces)
  for (const content of [
    'private-run-prompt',
    'private-tool-input.txt',
    'private-tool-output',
    'private-provider-output',
  ]) {
    assert.equal(serialized.includes(content), false)
  }
})

test('AgentLoop with the real router attributes fallback lifecycle only to actual Providers', async () => {
  const primary: ChatProvider = {
    id: 'primary',
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      throw runtimeError('TEMPORARY', 'provider', 'retry me', undefined, true)
    },
  }
  let backupRequest: ProviderRequest | undefined
  const backup: ChatProvider = {
    id: 'scripted',
    defaultModel: 'backup-default',
    authState: () => ({ status: 'authenticated' }),
    capabilities: {
      streaming: { text: true, reasoning: false, usage: true },
      tools: { mode: 'native', parallelCalls: false },
      modalities: { text: true, vision: false, audio: false },
      output: { jsonSchema: false, citations: false },
      limits: { maxContextTokens: 4096, maxOutputTokens: 17 },
    },
    async *stream(request) {
      backupRequest = request
      yield { type: 'completed', stopReason: 'end_turn' }
    },
  }
  const router = new ProviderRouter(async (id) => ({ primary, scripted: backup })[id], {
    fallbacks: { primary: [{ provider: 'scripted', model: 'backup-model' }] },
    retryAttempts: 0,
  })
  const selectedTargets: string[] = []
  const harness = createHarness(primary, {
    providerRouter: router,
    selectContext: (session, _run, targetProvider, _promptBuild, _tools, target) => {
      selectedTargets.push(`${targetProvider.id}/${target?.model ?? session.model}`)
      return {
        messages: [
          {
            role: 'user',
            content: target?.model === 'backup-model' ? 'backup context' : 'primary context',
          },
        ],
      }
    },
    outputTokenLimitPort: (_session, _provider, _target, capabilities) =>
      capabilities?.limits.maxOutputTokens,
  })

  await harness.loop.execute(harness.session, harness.run)

  assert.deepEqual(
    harness.traces
      .filter((record) => record.kind.startsWith('provider.'))
      .map((record) => ({ kind: record.kind, providerId: record.attributes?.providerId })),
    [
      { kind: 'provider.started', providerId: 'primary' },
      { kind: 'provider.failed', providerId: 'primary' },
      { kind: 'provider.fallback', providerId: 'scripted' },
      { kind: 'provider.started', providerId: 'scripted' },
      { kind: 'provider.completed', providerId: 'scripted' },
    ],
  )
  assert.deepEqual(selectedTargets, ['primary/test', 'scripted/backup-model'])
  assert.equal(backupRequest?.model, 'backup-model')
  assert.equal(backupRequest?.maxOutputTokens, 17)
  assert.equal(backupRequest?.messages[0]?.content, 'backup context')
  assert.equal(harness.traces.filter((record) => record.kind === 'run.completed').length, 1)
})

test('AgentLoop treats trace failures as diagnostics and preserves one terminal outcome', async () => {
  const harness = createHarness(
    scriptedProvider([[{ type: 'completed', stopReason: 'end_turn' }]]),
    { traceFails: true },
  )

  await harness.loop.execute(harness.session, harness.run)

  assert.equal(harness.events.at(-1)?.type, 'prompt_completed')
  assert.equal(harness.terminals, 1)
})

test('AgentLoop reports its configured turn ceiling without blaming the Provider', async () => {
  const provider = scriptedProvider(
    Array.from({ length: 8 }, (_, index) => [
      {
        type: 'tool_calls' as const,
        calls: [{ id: `call-${index}`, name: 'inspect', input: { index } }],
      },
    ]),
  )
  const harness = createHarness(provider)
  harness.run.usage = { turns: 6, toolCalls: 0, subagents: 2 }
  harness.run.budget = {
    maxTurns: 8,
    maxToolCalls: 8,
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
  }
  await harness.loop.execute(harness.session, harness.run)

  assert.equal(harness.events.filter((event) => event.type === 'tool_end').length, 2)
  assert.deepEqual(harness.events.at(-1), {
    type: 'prompt_failed',
    runId: harness.run.id,
    code: 'AGENT_TURN_LIMIT_EXCEEDED',
    category: 'planner',
    error:
      'Agent reached the 8-turn cumulative limit before producing a final response. Continue the session or raise the maximum turn limit.',
  })
  assert.equal(harness.terminals, 1)
})

test('AgentLoop preserves the explicit cancellation reason in its single terminal event', async () => {
  const provider = scriptedProvider([[]])
  const harness = createHarness(provider)
  harness.loop.cancel(harness.run, 'runtime_shutdown')

  await harness.loop.execute(harness.session, harness.run)

  assert.deepEqual(
    harness.events.map((event) => event.type),
    ['prompt_started', 'prompt_aborted'],
  )
  assert.deepEqual(harness.events.at(-1), {
    type: 'prompt_aborted',
    runId: 'r-loop',
    reason: 'runtime_shutdown',
  })
  assert.equal(harness.terminals, 1)
})

test('a stubborn provider cannot emit or commit after the framework has terminally aborted its run', async () => {
  const release = deferred<void>()
  const started = deferred<void>()
  const harness = createHarness(stubbornProvider(started, release))
  const execution = harness.loop.execute(harness.session, harness.run)
  await started.promise

  harness.loop.cancel(harness.run, 'user_abort')
  harness.finish({ type: 'prompt_aborted', runId: harness.run.id, reason: 'user_abort' })
  release.resolve()
  await execution

  assert.deepEqual(
    harness.events.map((event) => event.type),
    ['prompt_started', 'prompt_aborted'],
  )
  assert.equal(harness.session.messages.length, 1)
  assert.equal(harness.terminals, 1)
})

test('AgentLoop abort closes an active routed Provider attempt with one correlated terminal', async () => {
  const release = deferred<void>()
  const started = deferred<void>()
  const provider = stubbornProvider(started, release)
  const harness = createHarness(provider, {
    providerRouter: new ProviderRouter(async () => provider, { retryAttempts: 0 }),
  })
  const execution = harness.loop.execute(harness.session, harness.run)
  await started.promise

  harness.loop.cancel(harness.run, 'user_abort')
  release.resolve()
  await execution

  const providerRecords = harness.traces.filter((record) => record.kind.startsWith('provider.'))
  assert.deepEqual(
    providerRecords.map((record) => record.kind),
    ['provider.started', 'provider.first_token', 'provider.failed'],
  )
  assert.ok(
    providerRecords.every(
      (record) =>
        record.context.traceId === harness.run.trace.traceId &&
        record.context.runtimeId === harness.run.trace.runtimeId &&
        record.context.sessionId === harness.run.sessionId &&
        record.context.runId === harness.run.id &&
        record.context.turnId !== undefined,
    ),
  )
  assert.equal(providerRecords[2]?.attributes?.errorCode, 'PROVIDER_CANCELLED')
  assert.equal(providerRecords[2]?.attributes?.errorCategory, 'cancelled')
  assert.equal(providerRecords[2]?.attributes?.stopReason, 'cancelled')
  assert.equal(providerRecords[2]?.attributes?.health, 'healthy')
  assert.ok((providerRecords[1]?.metrics?.durationMs ?? -1) >= 0)
  assert.equal(harness.traces.filter((record) => record.kind === 'run.aborted').length, 1)
  assert.equal(harness.terminals, 1)
})

test('AgentLoop preserves a RuntimeError code and category in the failed terminal event', async () => {
  const provider: ChatProvider = {
    id: 'failing',
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      throw runtimeError('TOOL_POLICY_DENIED', 'tool', 'The tool policy rejected this request.')
    },
  }
  const harness = createHarness(provider, {
    providerRouter: new ProviderRouter(async () => provider, { retryAttempts: 0 }),
  })
  await harness.loop.execute(harness.session, harness.run)

  assert.deepEqual(harness.events.at(-1), {
    type: 'prompt_failed',
    runId: harness.run.id,
    code: 'TOOL_POLICY_DENIED',
    category: 'tool',
    error: 'The tool policy rejected this request.',
  })
  assert.equal(harness.traces.filter((record) => record.kind === 'provider.failed').length, 1)
  assert.equal(harness.traces.filter((record) => record.kind === 'run.failed').length, 1)
})

test('AgentLoop redacts an unexpected provider exception from its terminal event', async () => {
  const provider: ChatProvider = {
    id: 'failing',
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      throw new Error('Upstream response detail should remain private.')
    },
  }
  const harness = createHarness(provider, {
    providerRouter: new ProviderRouter(async () => provider, { retryAttempts: 0 }),
  })
  await harness.loop.execute(harness.session, harness.run)

  assert.deepEqual(harness.events.at(-1), {
    type: 'prompt_failed',
    runId: harness.run.id,
    code: 'PROVIDER_ERROR',
    category: 'provider',
    error: 'The provider request failed.',
  })
  assert.equal(harness.traces.filter((record) => record.kind === 'provider.failed').length, 1)
  assert.equal(harness.traces.filter((record) => record.kind === 'run.failed').length, 1)
})

test('AgentLoop rejects steering an aborted or terminal run', async () => {
  const harness = createHarness(scriptedProvider([[]]))
  harness.loop.cancel(harness.run, 'user_abort')
  await assert.rejects(
    harness.loop.queueSteer(harness.session, harness.run, 'late steer'),
    hasCode('RUN_NOT_ACTIVE'),
  )

  const terminalHarness = createHarness(scriptedProvider([[]]))
  terminalHarness.run.terminal = true
  await assert.rejects(
    terminalHarness.loop.queueSteer(terminalHarness.session, terminalHarness.run, 'late steer'),
    hasCode('RUN_NOT_ACTIVE'),
  )
})

test('AgentLoop sends composed instructions and a content-free manifest for every provider request', async () => {
  let received: Parameters<ChatProvider['stream']>[0] | undefined
  const provider: ChatProvider = {
    id: 'capturing',
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    async *stream(request) {
      received = request
      yield { type: 'completed' as const }
    },
  }
  const promptBuild: SystemPromptBuild = {
    instructions: 'Original Praxis policy text.',
    contextMessages: [],
    manifest: {
      estimatedTokens: 8,
      maxTokens: 64,
      program: TEST_PROMPT_PROGRAM,
      sections: [
        {
          id: 'identity',
          source: 'builtin',
          order: 10,
          cacheScope: 'request',
          characters: 29,
          estimatedTokens: 8,
          included: true,
          digest: `sha256:${'c'.repeat(64)}`,
        },
      ],
    },
  }
  const harness = createHarness(provider, { promptBuild })

  await harness.loop.execute(harness.session, harness.run)

  assert.equal(received?.instructions, promptBuild.instructions)
  assert.deepEqual(received?.promptManifest, promptBuild.manifest)
  assert.equal(JSON.stringify(received?.promptManifest).includes(promptBuild.instructions), false)
  assert.deepEqual(harness.promptManifests, [promptBuild.manifest])
  const manifestRecords = harness.traces.filter((record) => record.kind === 'prompt.manifest')
  assert.equal(manifestRecords.length, 2)
  assert.match(manifestRecords[0]?.attributes?.manifestDigest ?? '', /^sha256:[a-f0-9]{64}$/)
  assert.equal(manifestRecords[0]?.attributes?.promptVariant, 'baseline-v1')
  assert.deepEqual(manifestRecords[0]?.metrics, {
    sectionCount: 1,
    estimatedTokens: 8,
  })
  assert.deepEqual(manifestRecords[1]?.attributes, {
    manifestDigest: manifestRecords[0]?.attributes?.manifestDigest,
    promptSectionId: 'identity',
    promptSectionDigest: `sha256:${'c'.repeat(64)}`,
    promptSectionSource: 'builtin',
    promptSectionCacheScope: 'request',
    promptSectionIncluded: true,
  })
  assert.deepEqual(manifestRecords[1]?.metrics, {
    sectionOrder: 10,
    characters: 29,
    estimatedTokens: 8,
  })
  assert.equal(JSON.stringify(manifestRecords).includes(promptBuild.instructions), false)
})

test('AgentLoop awaits an asynchronous system prompt build before calling the provider', async () => {
  let received: Parameters<ChatProvider['stream']>[0] | undefined
  const provider: ChatProvider = {
    id: 'capturing',
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    async *stream(request) {
      received = request
      yield { type: 'completed' as const }
    },
  }
  const promptBuild: SystemPromptBuild = {
    instructions: 'Asynchronously loaded project instructions.',
    contextMessages: [],
    manifest: {
      estimatedTokens: 9,
      maxTokens: 64,
      sections: [],
      program: TEST_PROMPT_PROGRAM,
    },
  }
  const harness = createHarness(provider, { promptBuild: Promise.resolve(promptBuild) })

  await harness.loop.execute(harness.session, harness.run)

  assert.equal(received?.instructions, promptBuild.instructions)
  assert.deepEqual(harness.promptManifests, [promptBuild.manifest])
})

test('AgentLoop freezes one prompt snapshot across tool-call rounds', async () => {
  const requests: Parameters<ChatProvider['stream']>[0][] = []
  let builds = 0
  const provider: ChatProvider = {
    id: 'snapshot',
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    async *stream(request) {
      requests.push(request)
      if (requests.length === 1) {
        yield { type: 'tool_calls' as const, calls: [{ id: 'call-1', name: 'inspect', input: {} }] }
        return
      }
      yield { type: 'completed' as const }
    },
  }
  const manifest: PromptManifest = {
    estimatedTokens: 9,
    maxTokens: 64,
    sections: [],
    program: TEST_PROMPT_PROGRAM,
  }
  const guidance = '<system-reminder>guidance-v1</system-reminder>'
  const harness = createHarness(provider, {
    promptBuild: () => {
      builds += 1
      return {
        instructions: `policy-v${builds}`,
        contextMessages: [{ role: 'user', content: guidance }],
        manifest,
      }
    },
  })

  await harness.loop.execute(harness.session, harness.run)

  assert.equal(builds, 1)
  assert.deepEqual(harness.promptManifests, [manifest])
  assert.deepEqual(
    requests.map((request) => request.contextMessages),
    [[{ role: 'user', content: guidance }], [{ role: 'user', content: guidance }]],
  )
  assert.ok(
    requests.every(
      (request) => request.messages.some((message) => message.content === guidance) === false,
    ),
  )
})

test('AgentLoop ends once with budget_exhausted when provider usage crosses the run budget', async () => {
  const provider: ChatProvider = {
    id: 'budget',
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      yield { type: 'completed' as const, usage: { inputTokens: 6, outputTokens: 5 } }
    },
  }
  const harness = createHarness(provider)
  harness.run.budget = {
    maxTurns: 8,
    maxToolCalls: 8,
    maxTokens: 10,
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
  }

  await harness.loop.execute(harness.session, harness.run)

  assert.deepEqual(harness.events.at(-1), {
    type: 'prompt_aborted',
    runId: harness.run.id,
    reason: 'budget_exhausted',
  })
  assert.deepEqual(harness.run.usage, {
    turns: 1,
    toolCalls: 0,
    inputTokens: 6,
    outputTokens: 5,
    subagents: 0,
  })
})

test('AgentLoop compacts at threshold and retries one Provider context overflow', async () => {
  let providerAttempts = 0
  let compactions = 0
  const contextReport = {
    contextWindowTokens: 100,
    reservedTokens: 25,
    selectedTokens: 30,
    checkpointTokens: 0,
    selectedMessages: 1,
    omittedMessages: 0,
    uncoveredOmittedMessages: 0,
    pressure: 0.4,
    checkpointId: undefined as string | undefined,
  }
  const provider: ChatProvider = {
    id: 'overflow',
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      providerAttempts += 1
      if (providerAttempts === 1) {
        throw runtimeError('PROVIDER_CONTEXT_LIMIT', 'provider', 'context exceeded')
      }
      yield { type: 'completed' as const, stopReason: 'end_turn' }
    },
  }
  const harness = createHarness(provider, {
    contextReport,
    compactContext: async () => {
      compactions += 1
      contextReport.checkpointId = 'cp-overflow'
      return {
        compacted: true,
        checkpointTokens: 12,
        omittedMessages: 4,
        estimatedGainTokens: 100,
        checkpointId: 'cp-overflow',
        usage: { inputTokens: 3, outputTokens: 1 },
      }
    },
  })

  await harness.loop.execute(harness.session, harness.run)

  assert.equal(providerAttempts, 2)
  assert.equal(compactions, 1)
  assert.equal(harness.events.at(-1)?.type, 'prompt_completed')
  assert.deepEqual(harness.run.usage, {
    turns: 1,
    toolCalls: 0,
    inputTokens: 3,
    outputTokens: 1,
    subagents: 0,
  })
  assert.deepEqual(harness.traces.find((record) => record.kind === 'context.compacted')?.metrics, {
    checkpointTokens: 12,
    omittedMessages: 4,
    inputTokens: 3,
    outputTokens: 1,
  })
  assert.deepEqual(
    harness.traces
      .filter((record) => record.kind.startsWith('context.'))
      .map((record) => ({
        kind: record.kind,
        reason: record.attributes?.compactionReason,
      })),
    [
      { kind: 'context.selected', reason: undefined },
      { kind: 'context.compacted', reason: 'overflow' },
      { kind: 'context.selected', reason: undefined },
    ],
  )
})

test('AgentLoop retains the Provider for semantic compaction when selected history is incomplete', async () => {
  const contextReport = {
    contextWindowTokens: 100,
    reservedTokens: 25,
    selectedTokens: 30,
    checkpointTokens: 0,
    selectedMessages: 1,
    omittedMessages: 1,
    uncoveredOmittedMessages: 1,
    pressure: 0.4,
    checkpointId: undefined as string | undefined,
  }
  const provider: ChatProvider = {
    id: 'semantic-compaction',
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      yield { type: 'completed' as const, stopReason: 'end_turn' }
    },
  }
  let candidate: Parameters<NonNullable<AgentLoopPorts['compactContext']>>[3]
  const harness = createHarness(provider, {
    contextReport,
    compactContext: async (_session, _run, _reason, input) => {
      candidate = input
      contextReport.omittedMessages = 0
      contextReport.uncoveredOmittedMessages = 0
      contextReport.checkpointId = 'cp-semantic'
      return { compacted: true, checkpointId: 'cp-semantic' }
    },
  })

  await harness.loop.execute(harness.session, harness.run)

  assert.equal(candidate?.provider, provider)
  assert.equal(candidate?.nativeEligible, false)
  assert.equal(harness.events.at(-1)?.type, 'prompt_completed')
})

test('AgentLoop fails with a stable error when overflow compaction makes no progress', async () => {
  let providerAttempts = 0
  const provider: ChatProvider = {
    id: 'overflow-no-progress',
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      providerAttempts += 1
      throw runtimeError('PROVIDER_CONTEXT_LIMIT', 'provider', 'context exceeded')
    },
  }
  const harness = createHarness(provider, {
    contextReport: {
      contextWindowTokens: 100,
      reservedTokens: 25,
      selectedTokens: 30,
      checkpointTokens: 0,
      selectedMessages: 1,
      omittedMessages: 0,
      uncoveredOmittedMessages: 0,
      pressure: 0.4,
    },
    compactContext: async () => ({ compacted: true, estimatedGainTokens: 100 }),
  })

  await harness.loop.execute(harness.session, harness.run)

  assert.equal(providerAttempts, 1)
  assert.deepEqual(harness.events.at(-1), {
    type: 'prompt_failed',
    runId: harness.run.id,
    code: 'CONTEXT_COMPACTION_NO_PROGRESS',
    category: 'provider',
    error: 'Context compaction did not make bounded progress.',
  })
})

test('AgentLoop retries Provider context overflow at most once per turn', async () => {
  let providerAttempts = 0
  let compactions = 0
  const contextReport = {
    contextWindowTokens: 100,
    reservedTokens: 25,
    selectedTokens: 30,
    checkpointTokens: 0,
    selectedMessages: 1,
    omittedMessages: 0,
    uncoveredOmittedMessages: 0,
    pressure: 0.4,
    checkpointId: undefined as string | undefined,
  }
  const provider: ChatProvider = {
    id: 'overflow-bounded',
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      providerAttempts += 1
      throw runtimeError('PROVIDER_CONTEXT_LIMIT', 'provider', 'context exceeded')
    },
  }
  const harness = createHarness(provider, {
    contextReport,
    compactContext: async () => {
      compactions += 1
      contextReport.checkpointId = 'cp-bounded'
      return {
        compacted: true,
        estimatedGainTokens: 100,
        checkpointId: 'cp-bounded',
      }
    },
  })

  await harness.loop.execute(harness.session, harness.run)

  assert.equal(providerAttempts, 2)
  assert.equal(compactions, 1)
  assert.deepEqual(harness.events.at(-1), {
    type: 'prompt_failed',
    runId: harness.run.id,
    code: 'PROVIDER_CONTEXT_LIMIT',
    category: 'provider',
    error: 'context exceeded',
  })
})

test('AgentLoop converts a prose child ending into one forced structured terminal Tool commit', async () => {
  const choices: unknown[] = []
  let turn = 0
  const provider: ChatProvider = {
    id: 'terminal-tool',
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    async *stream(request) {
      choices.push(request.toolChoice)
      turn += 1
      if (turn === 1) {
        yield { type: 'text_delta' as const, text: '{malformed "quoted" prose}' }
        yield { type: 'completed' as const, stopReason: 'end_turn' }
        return
      }
      yield {
        type: 'tool_calls' as const,
        calls: [
          {
            id: 'submit-1',
            name: 'submit_result',
            input: { summary: 'grammar-constrained result' },
          },
        ],
      }
      yield { type: 'completed' as const, stopReason: 'tool_calls' }
    },
  }
  const harness = createHarness(provider, { terminalTool: { name: 'submit_result' } })

  await harness.loop.execute(harness.session, harness.run)

  assert.deepEqual(choices, [undefined, { name: 'submit_result' }])
  assert.equal(
    harness.session.messages.some(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes('submit_result'),
    ),
    true,
  )
  assert.deepEqual(harness.events.at(-1), {
    type: 'prompt_completed',
    runId: harness.run.id,
    stopReason: 'terminal_tool',
    usage: undefined,
  })
})

function createHarness(
  provider: ChatProvider,
  options: {
    permission?: PermissionDecision
    traceFails?: boolean
    providerRouter?: ProviderRouter
    permissionRule?: boolean
    portClaimsTerminal?: boolean
    finishStarted?: Deferred<void>
    finishGate?: Deferred<void>
    outputTokenLimit?: number
    outputTokenLimitPort?: AgentLoopPorts['outputTokenLimit']
    selectContext?: AgentLoopPorts['selectContext']
    promptBuild?:
      | SystemPromptBuild
      | Promise<SystemPromptBuild>
      | (() => SystemPromptBuild | Promise<SystemPromptBuild>)
    contextReport?: {
      contextWindowTokens: number
      reservedTokens: number
      selectedTokens: number
      checkpointTokens: number
      selectedMessages: number
      omittedMessages: number
      uncoveredOmittedMessages: number
      pressure: number
      checkpointId?: string
    }
    compactContext?: AgentLoopPorts['compactContext']
    inspectOutput?: unknown
    terminalTool?: Readonly<{ name: string }>
  } = {},
) {
  const events: SessionEvent[] = []
  const session: ManagedSession<AgentRun> = {
    sessionId: 's-loop',
    state: 'running',
    cwd: process.cwd(),
    provider: provider.id,
    model: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    clientRequests: new Map(),
    messages: [{ role: 'user', content: 'test loop' }],
    memory: { sessionId: 's-loop' },
  }
  const run: AgentRun & { trace: TraceContext } = {
    id: 'r-loop',
    sessionId: session.sessionId,
    promptKind: 'prompt',
    text: 'test loop',
    aborted: false,
    terminal: false,
    controller: new AbortController(),
    steerQueue: [],
    trace: {
      traceId: 'trace-loop',
      runtimeId: 'rt-loop',
      sessionId: session.sessionId,
      runId: 'r-loop',
    },
  }
  let terminals = 0
  const finish = async (target: AgentRun, event: Parameters<AgentLoopPorts['finishRun']>[2]) => {
    options.finishStarted?.resolve()
    if (options.finishGate) await options.finishGate.promise
    if (options.portClaimsTerminal ?? true) target.terminal = true
    terminals += 1
    events.push(event)
    return event
  }
  let toolExecutions = 0
  let activeToolExecutions = 0
  let maximumToolExecutions = 0
  const tools = new ToolRuntime([
    {
      definition: {
        name: 'inspect',
        description: 'inspect',
        parameters: {},
        execution: {
          sideEffect: 'read',
          target: { kind: 'input_path', field: 'path' },
          parallelSafe: true,
          conflictScope: 'target',
          maxInlineBytes: 65_536,
        },
      },
      async execute(request) {
        toolExecutions += 1
        activeToolExecutions += 1
        maximumToolExecutions = Math.max(maximumToolExecutions, activeToolExecutions)
        await Promise.resolve()
        activeToolExecutions -= 1
        return {
          ok: true,
          summary: `inspected:${JSON.stringify(request.input)}`,
          output: options.inspectOutput ?? { value: 'private-tool-output', input: request.input },
        }
      },
    },
    new GrepTool(),
    new LsTool(),
    ...(options.terminalTool === undefined
      ? []
      : [
          {
            definition: {
              name: options.terminalTool.name,
              description: 'commit result',
              parameters: { type: 'object' },
              outputSchema: { type: 'object' },
              execution: {
                sideEffect: 'none' as const,
                target: { kind: 'none' as const },
                parallelSafe: false,
                conflictScope: 'global' as const,
                maxInlineBytes: 65_536,
              },
            },
            async execute(request: import('@praxis/core-sdk').ToolRequest) {
              return { ok: true, summary: 'committed', output: request.input }
            },
          },
        ]),
  ])
  const toolPort = {
    definitions: () => tools.definitions(),
    validateInput: (name: string, input: Record<string, unknown>) =>
      tools.validateInput(name, input),
    prepare: (name: string, input: Record<string, unknown>, cwd: string) => {
      const prepared = tools.prepare(name, input, cwd)
      return options.permission && name === 'inspect'
        ? {
            ...prepared,
            permission: { risk: 'medium' as const, rule: 'inspect:test' },
          }
        : prepared
    },
    executePrepared: (prepared: ReturnType<ToolRuntime['prepare']>, signal: AbortSignal) =>
      tools.executePrepared(prepared, signal),
  }
  const promptManifests: PromptManifest[] = []
  const traces: TraceInput[] = []
  let permissionRequests = 0
  let nextTurn = 1
  const traceRecord = async (record: TraceInput) => {
    if (options.traceFails) throw new Error('trace sink unavailable')
    traces.push(record)
  }
  const ports: AgentLoopPorts = {
    providerFor: async (id) => (id === provider.id ? provider : undefined),
    streamProvider: (target, request, context, prepareRequest) =>
      options.providerRouter
        ? options.providerRouter.stream(
            target.id,
            request,
            { context, trace: traceRecord },
            prepareRequest,
          )
        : target.stream(request),
    tools: () => toolPort,
    ...(options.terminalTool === undefined ? {} : { terminalTool: () => options.terminalTool }),
    commitMessage: async (target, _run, message) => {
      target.messages.push(message)
    },
    emit: (event) => {
      events.push(event)
    },
    requestPermission: async () => {
      permissionRequests += 1
      return options.permission ?? { type: 'allow_once' }
    },
    hasPermissionRule: () => options.permissionRule ?? false,
    finishRun: (_session, target, event) => finish(target, event),
    buildSystemPrompt: () =>
      typeof options.promptBuild === 'function'
        ? options.promptBuild()
        : ((options.promptBuild ?? defaultPromptBuild()) as SystemPromptBuild),
    recordPromptManifest: (_session, _run, manifest) => {
      promptManifests.push(manifest)
    },
    selectContext:
      options.selectContext ??
      ((target) => ({
        messages: target.messages,
        ...(options.contextReport === undefined
          ? {}
          : { report: structuredClone(options.contextReport) }),
      })),
    ...(options.outputTokenLimitPort
      ? { outputTokenLimit: options.outputTokenLimitPort }
      : options.outputTokenLimit === undefined
        ? {}
        : { outputTokenLimit: () => options.outputTokenLimit }),
    ...(options.compactContext === undefined ? {} : { compactContext: options.compactContext }),
    nextMessageId: () => 'm-loop',
    nextSteerId: () => 'steer-loop',
    trace: traceRecord,
    nextTurnId: () => `turn-${nextTurn++}`,
  }
  const loop = new AgentLoop(ports)
  return {
    loop,
    session,
    run,
    events,
    traces,
    promptManifests,
    get permissionRequests() {
      return permissionRequests
    },
    get toolExecutions() {
      return toolExecutions
    },
    get maximumToolExecutions() {
      return maximumToolExecutions
    },
    finish: (event: Parameters<AgentLoopPorts['finishRun']>[2]) => finish(run, event),
    get terminals() {
      return terminals
    },
    execution: { session, run } satisfies PlannerExecution,
  }
}

type TraceInput = Omit<TraceRecord, 'schemaVersion' | 'timestamp'>

function defaultPromptBuild(): SystemPromptBuild {
  return {
    instructions: 'Test instructions.',
    contextMessages: [],
    manifest: {
      estimatedTokens: 5,
      maxTokens: 64,
      sections: [],
      program: TEST_PROMPT_PROGRAM,
    },
  }
}

function stubbornProvider(started: Deferred<void>, release: Deferred<void>): ChatProvider {
  return {
    id: 'stubborn',
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      started.resolve()
      await release.promise
      yield { type: 'text_delta' as const, text: 'late output that must be ignored' }
      yield { type: 'completed' as const }
    },
  }
}

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

function scriptedProvider(
  scripts: Array<
    Array<
      | { type: 'text_delta'; text: string }
      | { type: 'tool_calls'; calls: Array<{ id: string; name: string; input: unknown }> }
      | {
          type: 'completed'
          stopReason?: string
          usage?: { inputTokens?: number; outputTokens?: number }
        }
    >
  >,
): ChatProvider {
  let index = 0
  return {
    id: 'scripted',
    defaultModel: 'test',
    authState: () => ({ status: 'authenticated' }),
    async *stream(): AsyncIterable<
      | { type: 'text_delta'; text: string }
      | { type: 'tool_calls'; calls: Array<{ id: string; name: string; input: unknown }> }
      | {
          type: 'completed'
          stopReason?: string
          usage?: { inputTokens?: number; outputTokens?: number }
        }
    > {
      for (const chunk of scripts[index++] ?? []) yield chunk
    },
  }
}
