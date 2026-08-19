import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ProviderStreamAccumulator,
  ProviderStreamProtocolError,
  type ProviderChunk,
} from '@praxis/core-sdk'

test('structured Provider chunks assemble ordered content and incremental Tool arguments', () => {
  const accumulator = new ProviderStreamAccumulator()
  const chunks: ProviderChunk[] = [
    { type: 'message_start' },
    { type: 'reasoning_start', contentIndex: 0 },
    { type: 'reasoning_delta', contentIndex: 0, text: 'short rationale' },
    { type: 'reasoning_end', contentIndex: 0 },
    { type: 'text_start', contentIndex: 1 },
    { type: 'text_delta', contentIndex: 1, text: 'Checking.' },
    { type: 'text_end', contentIndex: 1 },
    { type: 'tool_call_start', index: 0, id: 'call-1', name: 'read' },
    { type: 'tool_call_delta', index: 0, argumentsDelta: '{"path":' },
    { type: 'tool_call_delta', index: 0, argumentsDelta: '"README.md"}' },
    { type: 'tool_call_end', index: 0 },
    {
      type: 'completed',
      stopReason: 'tool_use',
      usage: {
        inputTokens: 9,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
        costUsd: 0.002,
      },
    },
  ]
  for (const chunk of chunks) accumulator.accept(chunk)

  assert.deepEqual(accumulator.finish(), {
    content: [
      { type: 'reasoning', text: 'short rationale' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_call', id: 'call-1', name: 'read', input: { path: 'README.md' } },
    ],
    toolCalls: [{ id: 'call-1', name: 'read', input: { path: 'README.md' } }],
    stopReason: 'tool_calls',
    usage: {
      inputTokens: 9,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      costUsd: 0.002,
    },
  })
})

test('legacy Provider chunks are normalized by the same accumulator', () => {
  const accumulator = new ProviderStreamAccumulator()
  accumulator.accept({ type: 'text_delta', text: 'legacy' })
  accumulator.accept({
    type: 'tool_calls',
    calls: [{ id: 'call-1', name: 'read', input: { path: 'README.md' } }],
  })
  accumulator.accept({ type: 'completed', stopReason: 'length' })

  assert.deepEqual(accumulator.finish(), {
    content: [
      { type: 'text', text: 'legacy' },
      { type: 'tool_call', id: 'call-1', name: 'read', input: { path: 'README.md' } },
    ],
    toolCalls: [{ id: 'call-1', name: 'read', input: { path: 'README.md' } }],
    stopReason: 'max_output_tokens',
  })
})

test('Provider stream rejects incomplete, duplicate terminal, and post-terminal chunks', () => {
  const missingTerminal = new ProviderStreamAccumulator()
  missingTerminal.accept({ type: 'text_delta', text: 'partial' })
  assert.throws(() => missingTerminal.finish(), ProviderStreamProtocolError)

  const duplicate = new ProviderStreamAccumulator()
  duplicate.accept({ type: 'completed', stopReason: 'end_turn' })
  assert.throws(
    () => duplicate.accept({ type: 'completed', stopReason: 'end_turn' }),
    /after its terminal chunk/,
  )

  const postTerminal = new ProviderStreamAccumulator()
  postTerminal.accept({ type: 'completed', stopReason: 'end_turn' })
  assert.throws(() => postTerminal.accept({ type: 'text_delta', text: 'late' }), {
    code: 'PROVIDER_STREAM_INVALID',
  })
})

test('Provider stream rejects malformed block ordering and Tool arguments', () => {
  const text = new ProviderStreamAccumulator()
  assert.throws(() => text.accept({ type: 'text_end', contentIndex: 0 }), /was not active/)

  const tool = new ProviderStreamAccumulator()
  tool.accept({ type: 'tool_call_start', index: 0, id: 'call-1', name: 'read' })
  tool.accept({ type: 'tool_call_delta', index: 0, argumentsDelta: '{"path":' })
  assert.throws(
    () => tool.accept({ type: 'tool_call_end', index: 0 }),
    /arguments were not valid JSON/,
  )
})

test('Provider stream rejects negative or non-finite usage without inventing values', () => {
  const negative = new ProviderStreamAccumulator()
  assert.throws(
    () =>
      negative.accept({
        type: 'completed',
        usage: { inputTokens: -1 },
      }),
    /inputTokens/,
  )

  const infinite = new ProviderStreamAccumulator()
  assert.throws(
    () =>
      infinite.accept({
        type: 'completed',
        usage: { costUsd: Number.POSITIVE_INFINITY },
      }),
    /costUsd/,
  )
})
