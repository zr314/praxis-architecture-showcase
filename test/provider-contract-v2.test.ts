import assert from 'node:assert/strict'
import test from 'node:test'
import {
  contentText,
  isProviderNativeContext,
  normalizeProviderStopReason,
  providerToolCalls,
  type ProviderChunk,
  type ProviderMessage,
  type ProviderUsage,
} from '@praxis/core-sdk'

test('provider-native context has structural but no whole-payload byte ceiling', () => {
  assert.equal(
    isProviderNativeContext({
      schemaVersion: 1,
      provider: 'openai',
      model: 'gpt-5.2',
      format: 'openai.responses.compact.v1',
      items: [{ type: 'compaction', encrypted_content: 'x'.repeat(9 * 1024 * 1024) }],
      messageStart: 0,
      messageEnd: 1,
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      instructionsDigest: `sha256:${'b'.repeat(64)}`,
      estimatedTokens: 1,
      createdAt: new Date(0).toISOString(),
    }),
    true,
  )
})

test('provider messages preserve structured text, reasoning, images, and Tool calls', () => {
  const message: ProviderMessage = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'private working summary' },
      { type: 'text', text: 'Result' },
      {
        type: 'image_ref',
        artifactId: 'artifact-1',
        mimeType: 'image/png',
        alt: 'generated chart',
      },
      { type: 'tool_call', id: 'call-1', name: 'read', input: { path: 'README.md' } },
    ],
  }

  assert.equal(contentText(message.content), 'Result')
  assert.deepEqual(providerToolCalls(message), [
    { id: 'call-1', name: 'read', input: { path: 'README.md' } },
  ])
})

test('legacy string messages and assistant toolCalls remain compatible', () => {
  const message: ProviderMessage = {
    role: 'assistant',
    content: 'legacy text',
    toolCalls: [{ id: 'call-1', name: 'read', input: { path: 'README.md' } }],
  }

  assert.equal(contentText(message.content), 'legacy text')
  assert.deepEqual(providerToolCalls(message), message.toolCalls)
})

test('provider usage distinguishes unknown values from measured zeroes', () => {
  const usage: ProviderUsage = {
    inputTokens: 0,
    outputTokens: 4,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    costUsd: 0.001,
  }
  assert.deepEqual(usage, {
    inputTokens: 0,
    outputTokens: 4,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
    costUsd: 0.001,
  })
  assert.equal(Object.hasOwn({ outputTokens: 4 } satisfies ProviderUsage, 'inputTokens'), false)
})

test('provider stream contract exposes bounded start, delta, end, and terminal chunks', () => {
  const chunks: ProviderChunk[] = [
    { type: 'message_start' },
    { type: 'text_start', contentIndex: 0 },
    { type: 'text_delta', contentIndex: 0, text: 'hello' },
    { type: 'text_end', contentIndex: 0 },
    { type: 'reasoning_start', contentIndex: 1 },
    { type: 'reasoning_delta', contentIndex: 1, text: 'summary' },
    { type: 'reasoning_end', contentIndex: 1 },
    { type: 'tool_call_start', index: 0, id: 'call-1', name: 'read' },
    { type: 'tool_call_delta', index: 0, argumentsDelta: '{"path":' },
    { type: 'tool_call_delta', index: 0, argumentsDelta: '"README.md"}' },
    { type: 'tool_call_end', index: 0 },
    {
      type: 'completed',
      stopReason: 'tool_calls',
      usage: { inputTokens: 1, outputTokens: 2 },
    },
  ]
  assert.equal(chunks.at(-1)?.type, 'completed')
})

test('provider stop reasons normalize unknown Provider values without widening Runtime semantics', () => {
  assert.equal(normalizeProviderStopReason('end_turn'), 'end_turn')
  assert.equal(normalizeProviderStopReason('length'), 'max_output_tokens')
  assert.equal(normalizeProviderStopReason('vendor-specific'), 'unknown')
  assert.equal(normalizeProviderStopReason(undefined), 'unknown')
})
