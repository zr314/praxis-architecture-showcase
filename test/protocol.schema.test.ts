import assert from 'node:assert/strict'
import test from 'node:test'
import { createPromptEnvelope } from '@praxis/core-sdk'
import {
  assertProtocolMessage,
  assertProtocolResult,
  isProtocolMessage,
  parseProtocolMessage,
} from '@praxis/protocol'
import {
  createRuntimeCommandRegistryV1,
  RUNTIME_COMMAND_CAPABILITIES_V1,
} from '../apps/runtime/src/commands/builtinCommandRegistry.js'

const baseRequest = { jsonrpc: '2.0' as const, id: '1' }
const commandCatalog = createRuntimeCommandRegistryV1().snapshot({
  workspaceId: 'workspace:test',
  workspaceTrusted: true,
  capabilityIds: RUNTIME_COMMAND_CAPABILITIES_V1,
})
const compactDescriptor = commandCatalog.entries.find(
  ({ descriptor }) => descriptor.command === 'compact',
)!.descriptor
const commandInvocation = {
  schemaVersion: 1 as const,
  invocationId: 'command:protocol-1',
  clientRequestId: 'protocol-1',
  descriptorId: compactDescriptor.id,
  descriptorDigest: compactDescriptor.descriptorDigest,
  command: compactDescriptor.command,
  arguments: {},
}

test('method-level request fixtures satisfy the protocol schema', () => {
  const fixtures = [
    [
      'initialize',
      {
        protocolVersion: 1,
        client: { name: 'test', version: '1' },
        capabilities: { interactivePermissions: true, outputFormats: ['text'] },
      },
    ],
    ['events.subscribe', { sessionId: null, fromSequence: null }],
    ['auth.status', { provider: 'mock' }],
    ['auth.login', { provider: 'mock', mode: 'api_key' }],
    ['auth.login', { provider: 'kimi', mode: 'api_key', apiKey: 'secret-value' }],
    ['auth.logout', { provider: 'mock' }],
    ['models.list', {}],
    ['settings.get', {}],
    ['settings.model.set', { provider: 'mock', model: 'mock-v1' }],
    ['runtime.doctor', {}],
    ['commands.list', { workspace: process.cwd() }],
    [
      'commands.invoke',
      {
        schemaVersion: 1,
        workspace: process.cwd(),
        catalogSnapshotDigest: commandCatalog.snapshotDigest,
        capabilityDigest: commandCatalog.capabilityDigest,
        invocation: commandInvocation,
        sessionId: 's-1',
      },
    ],
    [
      'plugin.enable',
      {
        workspace: process.cwd(),
        id: 'example.tool',
        version: '1.0.0',
        grants: [{ type: 'filesystem', access: 'read', paths: ['$' + '{workspace}'] }],
      },
    ],
    [
      'plugin.update',
      {
        workspace: process.cwd(),
        source: process.cwd(),
        grants: [{ type: 'network', hosts: ['api.example.com'] }],
      },
    ],
    ['resource.list', { workspace: process.cwd() }],
    ['resource.inspect', { workspace: process.cwd(), id: 'project/review' }],
    ['resource.enable', { workspace: process.cwd(), id: 'project/review', projectTrusted: true }],
    ['resource.disable', { workspace: process.cwd(), id: 'project/review' }],
    ['session.create', { cwd: process.cwd() }],
    ['session.list', {}],
    ['session.search', { query: 'test' }],
    ['session.inspect', { sessionId: 's-1' }],
    ['session.resume', { sessionId: 's-1' }],
    ['session.configure', { sessionId: 's-1', provider: 'mock', model: 'mock-v1' }],
    ['session.close', { sessionId: 's-1' }],
    ['session.transcript', { sessionId: 's-1', before: 200, limit: 100 }],
    ['session.plan', { sessionId: 's-1' }],
    ['session.compact', { sessionId: 's-1' }],
    [
      'session.prompt',
      {
        sessionId: 's-1',
        text: 'hello',
        clientRequestId: 'c-1',
        commandInvocationId: 'command:protocol-1',
      },
    ],
    ['session.follow_up', { sessionId: 's-1', text: 'again', clientRequestId: 'c-2' }],
    ['session.steer', { sessionId: 's-1', runId: 'r-1', text: 'focus' }],
    ['session.abort', { runId: 'r-1' }],
    ['trace.export', { traceId: 'trace-1', destination: process.cwd() }],
    ['permission.decide', { requestId: 'p-1', decision: { type: 'allow_once' } }],
    ['permission.decide', { requestId: 'p-2', decision: { type: 'allow_always' } }],
    ['shutdown', {}],
  ]

  for (const [method, params] of fixtures) {
    assertProtocolMessage({ ...baseRequest, method, params })
  }
})

test('result and discriminated event fixtures satisfy the protocol schema', () => {
  const results = [
    { protocolVersion: 1, runtime: { runtimeId: 'rt-1' }, capabilities: {} },
    { subscriptionId: 'sub-1', nextSequence: 1, replaySupported: false },
    { status: 'authenticated', provider: 'mock', accountLabel: 'Mock Provider' },
    { loginId: 'login-1' },
    { ok: true },
    { accepted: true },
    commandCatalog,
    {
      schemaVersion: 1,
      invocationId: commandInvocation.invocationId,
      clientRequestId: commandInvocation.clientRequestId,
      descriptorId: commandInvocation.descriptorId,
      descriptorDigest: commandInvocation.descriptorDigest,
      effect: 'mutation',
      audited: true,
      output: { kind: 'ui_action', action: 'show_message', payload: { message: 'done' } },
    },
    {
      schemaVersion: 1,
      invocationId: commandInvocation.invocationId,
      clientRequestId: commandInvocation.clientRequestId,
      descriptorId: commandInvocation.descriptorId,
      descriptorDigest: commandInvocation.descriptorDigest,
      effect: 'prompt',
      audited: true,
      output: {
        kind: 'prompt_envelope',
        envelope: createPromptEnvelope({
          id: 'prompt-command-1',
          source: 'prompt_template',
          effectiveText: 'Review this target.',
          commandInvocationId: commandInvocation.invocationId,
          additionalParts: [
            {
              kind: 'template_expansion',
              trust: 'low',
              persistence: 'plaintext',
              origin: 'project:prompt-review',
              digest: `sha256:${'a'.repeat(64)}`,
              ref: 'project/template/review',
            },
          ],
        }),
      },
    },
    {
      version: 1,
      defaultModel: {
        provider: 'mock',
        model: 'mock-v1',
        updatedAt: '2026-07-29T00:00:00.000Z',
      },
    },
    { sessionId: 's-1', state: 'idle', cwd: process.cwd(), provider: 'mock', model: 'mock-v1' },
    [{ sessionId: 's-1', state: 'idle', cwd: process.cwd(), provider: 'mock', model: 'mock-v1' }],
    { runId: 'r-1', accepted: true },
    { accepted: true, applyAt: 'next_safe_boundary' },
    { compacted: true, checkpointId: 'cp-1' },
    {
      sessionId: 's-1',
      start: 100,
      end: 200,
      totalMessages: 250,
      hasMore: true,
      messages: [],
    },
    {
      traceId: 'trace-1',
      path: '/tmp/trace-1.json',
      recordCount: 2,
      privacy: {
        included: [
          'eventKinds',
          'timestamps',
          'correlationIds',
          'declaredAttributes',
          'aggregateMetrics',
        ],
        excluded: ['prompts', 'credentials', 'environment', 'rawToolInput', 'rawToolOutput'],
      },
    },
  ]
  for (const result of results) {
    assertProtocolMessage({ jsonrpc: '2.0', id: 'result', result })
  }

  const events = [
    { type: 'runtime_ready', runtimeId: 'rt-1' },
    {
      type: 'auth_login_action',
      loginId: 'l-1',
      action: 'open_url',
      url: 'https://example.invalid',
    },
    { type: 'auth_status_changed', provider: 'mock', status: 'authenticated' },
    { type: 'runtime_warning', code: 'WARN', message: 'warning' },
    {
      type: 'prompt_started',
      sessionId: 's-1',
      runId: 'r-1',
      prompt: 'hello',
      promptKind: 'prompt',
    },
    { type: 'thinking_delta', runId: 'r-1', text: 'thinking' },
    { type: 'text_delta', runId: 'r-1', text: 'text' },
    { type: 'tool_planning', runId: 'r-1', toolCallId: 't-1', name: 'read', input: {} },
    {
      type: 'permission_request',
      runId: 'r-1',
      requestId: 'p-1',
      toolCallId: 't-1',
      tool: 'read',
      input: {},
      rule: 'read-outside:D:/workspace/file.txt',
      parentRunId: 'r-parent',
      childRunId: 'r-child',
      childAgentRunId: 'r-child-agent',
      childRequestId: 'p-child',
    },
    { type: 'tool_start', runId: 'r-1', toolCallId: 't-1', name: 'read', input: {} },
    {
      type: 'tool_update',
      runId: 'r-1',
      toolCallId: 't-1',
      message: 'working',
      stream: 'stdout',
      delta: 'partial output',
      bytes: 14,
    },
    {
      type: 'tool_end',
      runId: 'r-1',
      toolCallId: 't-1',
      ok: false,
      summary: 'Target was not found.',
      error: { code: 'TOOL_TARGET_NOT_FOUND', category: 'not_found', retryable: false },
    },
    { type: 'steer_queued', runId: 'r-1', steerId: 'st-1' },
    { type: 'steer_applied', runId: 'r-1', steerId: 'st-1' },
    { type: 'message_committed', runId: 'r-1', messageId: 'm-1', role: 'assistant' },
    {
      type: 'prompt_completed',
      runId: 'r-1',
      usage: { turns: 2, toolCalls: 1, inputTokens: 1, outputTokens: 1, subagents: 0 },
    },
    {
      type: 'prompt_failed',
      runId: 'r-1',
      error: 'failed',
      code: 'TOOL_POLICY_DENIED',
      usage: { turns: 1, toolCalls: 1, subagents: 0 },
    },
    {
      type: 'prompt_aborted',
      runId: 'r-1',
      reason: 'user_requested',
      usage: { turns: 0, toolCalls: 0, subagents: 0 },
    },
  ]
  for (const [index, event] of events.entries()) {
    assertProtocolMessage({
      jsonrpc: '2.0',
      method: 'event',
      params: {
        subscriptionId: 'sub-1',
        sequence: index + 1,
        timestamp: '2026-07-13T00:00:00.000Z',
        ...(event.type.includes('prompt') || 'runId' in event ? { sessionId: 's-1' } : {}),
        ...('runId' in event ? { runId: event.runId } : {}),
        event,
      },
    })
  }
})

test('schema rejects unknown methods and malformed event payloads', () => {
  assert.equal(isProtocolMessage({ ...baseRequest, method: 'unknown.method', params: {} }), false)
  assert.equal(
    isProtocolMessage({
      jsonrpc: '2.0',
      method: 'event',
      params: {
        subscriptionId: 'sub-1',
        sequence: 1,
        timestamp: '2026-07-13T00:00:00.000Z',
        event: { type: 'text_delta', runId: 'r-1' },
      },
    }),
    false,
  )
})

test('protocol line parser rejects malformed JSON and schema-invalid messages', () => {
  const request = { ...baseRequest, method: 'session.list', params: {} }
  assert.deepEqual(parseProtocolMessage(JSON.stringify(request)), request)
  assert.throws(() => parseProtocolMessage('{'), /Invalid protocol JSON/)
  assert.throws(
    () =>
      parseProtocolMessage(
        JSON.stringify({ ...baseRequest, method: 'session.list', params: { extra: true } }),
      ),
    /Protocol schema validation failed/,
  )
})

test('method-correlated result validation rejects a valid result for the wrong method', () => {
  assertProtocolResult('session.prompt', 'run-result', { runId: 'r-1', accepted: true })
  assertProtocolResult('session.plan', 'plan-result', {
    sessionId: 's-1',
    plan: null,
    plannerGeneration: {
      phase: 'initial',
      generatorId: 'kimi/kimi-k3',
      source: 'model',
      status: 'failed',
      fallbackUsed: false,
      failureCode: 'PLAN_GENERATOR_PROVIDER_FAILED',
      runId: 'r-1',
      recordedAt: '2026-08-05T00:00:00.000Z',
    },
  })
  assert.throws(
    () => assertProtocolResult('session.create', 'session-result', { accepted: true }),
    /Protocol result validation failed for session\.create/,
  )
  assertProtocolResult('commands.list', 'command-list', commandCatalog)
  assertProtocolResult('commands.invoke', 'command-invoke', {
    schemaVersion: 1,
    invocationId: commandInvocation.invocationId,
    clientRequestId: commandInvocation.clientRequestId,
    descriptorId: commandInvocation.descriptorId,
    descriptorDigest: commandInvocation.descriptorDigest,
    effect: 'mutation',
    audited: true,
    output: { kind: 'ui_action', action: 'show_message', payload: { message: 'done' } },
  })
})

test('transcript pagination enforces bounded cursors, page sizes, and results', () => {
  assertProtocolResult('session.transcript', 'transcript', {
    sessionId: 's-1',
    start: 0,
    end: 2,
    totalMessages: 2,
    hasMore: false,
    messages: [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ],
  })
  assert.equal(
    isProtocolMessage({
      ...baseRequest,
      method: 'session.transcript',
      params: { sessionId: 's-1', limit: 501 },
    }),
    false,
  )
  assert.throws(
    () =>
      assertProtocolResult('session.transcript', 'oversized-transcript', {
        sessionId: 's-1',
        start: 0,
        end: 501,
        totalMessages: 501,
        hasMore: false,
        messages: Array.from({ length: 501 }, () => null),
      }),
    /Protocol result validation failed for session\.transcript/u,
  )
})

test('plugin results expose strict grants and management lifecycle state', () => {
  const status = {
    id: 'example.tool',
    version: '1.0.0',
    digest: `sha256:${'a'.repeat(64)}`,
    origin: '/plugins/example.tool',
    grants: [{ type: 'filesystem', access: 'read', paths: ['$' + '{workspace}'] }],
    health: 'stopped',
    lifecycle: 'workspace-enabled',
    isolation: 'process',
    enabled: true,
    provenance: 'unsigned',
  }
  assertProtocolResult('plugin.enable', 'plugin-status', status)
  assertProtocolResult('plugin.list', 'plugin-list', [status])
  assertProtocolResult('plugin.permissions', 'plugin-permissions', {
    requested: status.grants,
    approved: status.grants,
  })
  assert.throws(
    () =>
      assertProtocolResult('plugin.enable', 'plugin-status', {
        ...status,
        grants: [{ type: 'network', hosts: ['api.example.com'], allowPrivate: true }],
      }),
    /Protocol result validation failed for plugin\.enable/,
  )
  assert.throws(
    () =>
      assertProtocolResult('plugin.enable', 'plugin-status', { ...status, lifecycle: 'enabled' }),
    /Protocol result validation failed for plugin\.enable/,
  )
})

test('trace export protocol fixtures remain exact', () => {
  assert.equal(
    isProtocolMessage({
      ...baseRequest,
      method: 'trace.export',
      params: { traceId: 'trace-1', destination: process.cwd(), extra: true },
    }),
    false,
  )
  assert.equal(
    isProtocolMessage({
      ...baseRequest,
      method: 'trace.export',
      params: { traceId: '', destination: process.cwd() },
    }),
    false,
  )
  assert.equal(
    isProtocolMessage({
      ...baseRequest,
      method: 'trace.export',
      params: { traceId: '../escape', destination: process.cwd() },
    }),
    false,
  )
  assert.equal(
    isProtocolMessage({
      ...baseRequest,
      method: 'trace.export',
      params: { traceId: 'trace-1', destination: '' },
    }),
    false,
  )
  assert.equal(
    isProtocolMessage({
      jsonrpc: '2.0',
      id: 'result',
      result: {
        traceId: '../escape',
        path: '/tmp/trace-1.json',
        recordCount: 1,
        privacy: {
          included: [
            'eventKinds',
            'timestamps',
            'correlationIds',
            'declaredAttributes',
            'aggregateMetrics',
          ],
          excluded: ['prompts', 'credentials', 'environment', 'rawToolInput', 'rawToolOutput'],
        },
      },
    }),
    false,
  )
  assert.equal(
    isProtocolMessage({
      jsonrpc: '2.0',
      id: 'result',
      result: {
        traceId: 'trace-1',
        path: '/tmp/trace-1.json',
        recordCount: 1,
        privacy: {
          included: [
            'eventKinds',
            'timestamps',
            'correlationIds',
            'declaredAttributes',
            'aggregateMetrics',
          ],
          excluded: ['prompts', 'credentials', 'environment', 'rawToolInput', 'rawToolOutput'],
        },
        extra: true,
      },
    }),
    false,
  )
})
