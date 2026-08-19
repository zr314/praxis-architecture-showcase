import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderChunk, ProviderToolCall, ToolResult } from '@praxis/core-sdk'
import {
  consumeProviderTurn,
  executeToolBatch,
  LoopProgressGuard,
  typedSteerMessage,
} from '../apps/runtime/src/loop/units.js'

test('Provider turn unit normalizes chunks while streaming text and reasoning callbacks', async () => {
  const text: string[] = []
  const reasoning: string[] = []
  const chunks: ProviderChunk[] = [
    { type: 'reasoning_start', contentIndex: 0 },
    { type: 'reasoning_delta', contentIndex: 0, text: 'why' },
    { type: 'reasoning_end', contentIndex: 0 },
    { type: 'text_start', contentIndex: 1 },
    { type: 'text_delta', contentIndex: 1, text: 'answer' },
    { type: 'text_end', contentIndex: 1 },
    { type: 'completed', stopReason: 'stop' },
  ]

  const turn = await consumeProviderTurn(from(chunks), {
    onText: (delta) => text.push(delta),
    onReasoning: (delta) => reasoning.push(delta),
  })

  assert.deepEqual(text, ['answer'])
  assert.deepEqual(reasoning, ['why'])
  assert.equal(turn.stopReason, 'end_turn')
})

test('Tool batch unit is sequential and preserves Provider call order', async () => {
  const calls: ProviderToolCall[] = [
    { id: '1', name: 'first', input: {} },
    { id: '2', name: 'second', input: {} },
  ]
  const lifecycle: string[] = []
  const outcomes = await executeToolBatch(calls, async (call) => {
    lifecycle.push(`start:${call.id}`)
    await Promise.resolve()
    lifecycle.push(`end:${call.id}`)
    return { ok: true, summary: call.name }
  })

  assert.deepEqual(lifecycle, ['start:1', 'end:1', 'start:2', 'end:2'])
  assert.deepEqual(
    outcomes.map(({ call }) => call.id),
    ['1', '2'],
  )
})

test('Tool batch runs only independent read-only descriptors concurrently', async () => {
  const calls: ProviderToolCall[] = [
    { id: '1', name: 'read', input: { path: 'a' } },
    { id: '2', name: 'read', input: { path: 'b' } },
    { id: '3', name: 'write', input: { path: 'c' } },
  ]
  let active = 0
  let maximumActive = 0
  const outcomes = await executeToolBatch(
    calls,
    async (call) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active -= 1
      return { ok: true, summary: call.id }
    },
    () => false,
    {
      descriptor: (call) => ({
        sideEffect: call.name === 'read' ? 'read' : 'write',
        parallelSafe: call.name === 'read',
        target: String((call.input as { path: string }).path),
        conflictKey: `target:${String((call.input as { path: string }).path)}`,
        maxInlineBytes: 100,
      }),
      maxParallel: 2,
    },
  )

  assert.equal(maximumActive, 2)
  assert.deepEqual(
    outcomes.map(({ call }) => call.id),
    ['1', '2', '3'],
  )

  active = 0
  maximumActive = 0
  await executeToolBatch(
    calls.slice(0, 2),
    async (call) => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active -= 1
      return { ok: true, summary: call.id }
    },
    () => false,
    {
      descriptor: () => ({
        sideEffect: 'read',
        parallelSafe: true,
        conflictKey: 'target:same',
        maxInlineBytes: 100,
      }),
    },
  )
  assert.equal(maximumActive, 1)
})

test('progress guard advises on repeated calls, unchanged results, and identical failures without stopping the run', () => {
  const calls = [{ id: '1', name: 'read', input: { path: 'same' } }]
  const repeated = new LoopProgressGuard()
  assert.equal(repeated.observeToolCalls(calls), undefined)
  assert.match(repeated.observeToolCalls([{ ...calls[0], id: '2' }]) ?? '', /requested repeatedly/)
  assert.equal(repeated.observeToolCalls([{ ...calls[0], id: '3' }]), undefined)
  assert.match(repeated.observeToolCalls([{ ...calls[0], id: '4' }]) ?? '', /requested repeatedly/)

  const noProgress = new LoopProgressGuard()
  const unchanged: ToolResult[] = [{ ok: true, summary: 'unchanged' }]
  assert.equal(noProgress.observeToolResults(unchanged), undefined)
  assert.match(noProgress.observeToolResults(unchanged) ?? '', /no observable progress/)
  assert.equal(noProgress.observeToolResults(unchanged), undefined)

  const failures = new LoopProgressGuard()
  const failed = (summary: string): ToolResult => ({ ok: false, summary })
  failures.observeToolResults([failed('one')])
  failures.observeToolResults([failed('two')])
  failures.observeToolResults([failed('three')])
  failures.observeToolResults([failed('same')])
  assert.match(failures.observeToolResults([failed('same')]) ?? '', /failed repeatedly/)
  assert.equal(failures.observeToolResults([failed('same')]), undefined)

  const unrelated = new LoopProgressGuard()
  for (const [id, name] of [
    ['1', 'shell'],
    ['2', 'read'],
    ['3', 'artifact_read'],
  ]) {
    assert.equal(
      unrelated.observeToolResults(
        [failed('Tool execution failed.')],
        [{ id, name, input: { target: id } }],
      ),
      undefined,
    )
  }
})

test('steering becomes a typed low-trust message without prompt interpolation', () => {
  assert.deepEqual(typedSteerMessage('focus on tests'), {
    role: 'user',
    content: 'focus on tests',
    intent: 'steer',
    trust: 'low',
  })
})

async function* from(chunks: ProviderChunk[]): AsyncIterable<ProviderChunk> {
  yield* chunks
}
