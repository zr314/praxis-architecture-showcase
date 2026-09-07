import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  normalizeProviderToolCallIdsV1,
  planToolInvocationContextV1,
  rewriteAssistantToolContentV1,
} from '../apps/runtime/src/loop/toolInvocation.js'

test('missing Provider Tool IDs derive stable IDs from the reserved durable turn', () => {
  const input = {
    sessionId: 'session-1',
    runId: 'run-1',
    providerTurnId: 'message-1',
    content: [{ type: 'tool_call' as const, id: '', name: 'read', input: { path: 'a.ts' } }],
    toolCalls: [{ id: '', name: 'read', input: { path: 'a.ts' } }],
  }
  const first = normalizeProviderToolCallIdsV1(input)
  const replay = normalizeProviderToolCallIdsV1(structuredClone(input))
  assert.deepEqual(replay, first)
  assert.match(first.toolCalls[0]!.id, /^ptc_[a-f0-9]{64}$/u)
  assert.equal((first.content[0] as { type: 'tool_call'; id: string }).id, first.toolCalls[0]!.id)
})

test('invocation identity is derived after Tool middleware rewrites name and input', () => {
  const providerCallId = 'call-7'
  const rewritten = { id: providerCallId, name: 'workspace.read', input: { path: 'final.ts' } }
  const invocation = planToolInvocationContextV1({
    sessionId: 'session-1',
    runId: 'run-1',
    providerTurnId: 'message-1',
    providerToolCallId: rewritten.id,
    toolName: rewritten.name,
  })
  assert.match(invocation.invocationId, /^pti_[a-f0-9]{64}$/u)
  assert.deepEqual(invocation, {
    invocationId: invocation.invocationId,
    sessionId: 'session-1',
    runId: 'run-1',
    providerTurnId: 'message-1',
    providerToolCallId: 'call-7',
  })

  assert.deepEqual(
    rewriteAssistantToolContentV1(
      [{ type: 'tool_call', id: 'call-7', name: 'read', input: { path: 'draft.ts' } }],
      [rewritten],
    ),
    [{ type: 'tool_call', id: 'call-7', name: 'workspace.read', input: { path: 'final.ts' } }],
  )
})

test('duplicate non-empty Provider Tool IDs fail before Tool preparation', () => {
  assert.throws(
    () =>
      normalizeProviderToolCallIdsV1({
        sessionId: 'session-1',
        runId: 'run-1',
        providerTurnId: 'message-1',
        content: [],
        toolCalls: [
          { id: 'call-1', name: 'read', input: {} },
          { id: 'call-1', name: 'write', input: {} },
        ],
      }),
    hasCode('PROVIDER_TOOL_CALL_ID_DUPLICATE'),
  )
})

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
