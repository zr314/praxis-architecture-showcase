import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderChunk, ProviderRequest } from '@praxis/core-sdk'
import { ReplayProvider } from '../apps/runtime/src/evaluation/replayProvider.js'
import type { ProviderReplay } from '../apps/runtime/src/evaluation/scenario.js'

const fixture = (): ProviderReplay => ({
  turns: [
    {
      id: 'turn-1',
      expect: { model: 'replay-v1', tools: ['read'] },
      chunks: [
        { type: 'text_delta', text: 'Synthetic ' },
        {
          type: 'tool_calls',
          calls: [{ id: 'call-1', name: 'read', input: { path: 'synthetic.txt' } }],
        },
        {
          type: 'completed',
          stopReason: 'tool_calls',
          usage: { inputTokens: 4, outputTokens: 2 },
        },
      ],
    },
  ],
})

const twoTurnFixture = (): ProviderReplay => ({
  turns: [
    {
      id: 'turn-a',
      expect: { model: 'model-a', tools: [] },
      chunks: [
        { type: 'text_delta', text: 'turn-a' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    },
    {
      id: 'turn-b',
      expect: { model: 'model-b', tools: [] },
      chunks: [
        { type: 'text_delta', text: 'turn-b' },
        { type: 'completed', stopReason: 'end_turn' },
      ],
    },
  ],
})

test('replays exactly one fixture turn with exact chunk ordering', async () => {
  const replay = fixture()
  const provider = new ReplayProvider(replay)

  assert.deepEqual(await collect(provider.stream(request())), replay.turns[0].chunks)
  assert.equal(provider.remainingTurns(), 0)
})

test('reserves replay turns in stream call order when streams are iterated in reverse', async () => {
  const replay = twoTurnFixture()
  const provider = new ReplayProvider(replay)

  const first = provider.stream(request({ model: 'model-a', toolNames: [] }))
  const second = provider.stream(request({ model: 'model-b', toolNames: [] }))

  assert.equal(provider.remainingTurns(), 0)
  assert.deepEqual(await collect(second), replay.turns[1].chunks)
  assert.deepEqual(await collect(first), replay.turns[0].chunks)
})

test('keeps a call-time reservation when its iterator closes before the first chunk', async () => {
  const replay = twoTurnFixture()
  const provider = new ReplayProvider(replay)
  const iterator = provider
    .stream(request({ model: 'model-a', toolNames: [] }))
    [Symbol.asyncIterator]()

  assert.equal(provider.remainingTurns(), 1)
  await iterator.return?.()
  assert.equal(provider.remainingTurns(), 1)
  assert.deepEqual(
    await collect(provider.stream(request({ model: 'model-b', toolNames: [] }))),
    replay.turns[1].chunks,
  )
})

test('keeps a call-time reservation when its iterator closes after the first chunk', async () => {
  const replay = twoTurnFixture()
  const provider = new ReplayProvider(replay)
  const iterator = provider
    .stream(request({ model: 'model-a', toolNames: [] }))
    [Symbol.asyncIterator]()

  assert.deepEqual(await iterator.next(), { done: false, value: replay.turns[0].chunks[0] })
  await iterator.return?.()
  assert.equal(provider.remainingTurns(), 1)
  assert.deepEqual(
    await collect(provider.stream(request({ model: 'model-b', toolNames: [] }))),
    replay.turns[1].chunks,
  )
})

test('reports exhausted replay data with a stable evaluation code', async () => {
  const provider = new ReplayProvider(fixture())
  await collect(provider.stream(request()))

  await assert.rejects(collect(provider.stream(request())), (error) =>
    hasCode(error, 'EVAL_REPLAY_EXHAUSTED'),
  )
})

test('normalizes an invalid nested replay input in the Provider constructor', () => {
  assert.throws(
    () =>
      new ReplayProvider({
        turns: [
          {
            id: 'turn-1',
            chunks: [
              {
                type: 'tool_calls',
                calls: [
                  {
                    id: 'call-1',
                    name: 'read',
                    input: () => 'PRIVATE_CONSTRUCTOR_MARKER',
                  },
                ],
              },
            ],
          },
        ],
      }),
    (error) =>
      hasCode(error, 'EVAL_REPLAY_INVALID') &&
      error instanceof Error &&
      error.message === 'Provider replay fixture validation failed.',
  )
})

test('reports unconsumed replay turns until every fixture turn is consumed', async () => {
  const provider = new ReplayProvider(fixture())

  assert.throws(
    () => provider.assertConsumed(),
    (error) => hasCode(error, 'EVAL_REPLAY_UNCONSUMED'),
  )
  await collect(provider.stream(request()))
  assert.doesNotThrow(() => provider.assertConsumed())
})

test('checks declared model and ordered tool expectations', async () => {
  const modelProvider = new ReplayProvider(fixture())
  await assert.rejects(collect(modelProvider.stream(request({ model: 'other-model' }))), (error) =>
    hasCode(error, 'EVAL_REPLAY_MODEL_MISMATCH'),
  )
  assert.equal(modelProvider.remainingTurns(), 0)

  const toolProvider = new ReplayProvider(fixture())
  await assert.rejects(
    collect(toolProvider.stream(request({ toolNames: ['write', 'read'] }))),
    (error) => hasCode(error, 'EVAL_REPLAY_TOOLS_MISMATCH'),
  )
  assert.equal(toolProvider.remainingTurns(), 0)
})

test('uses fixed content-free messages for model and tool expectation mismatches', async () => {
  const modelReplay = fixture()
  modelReplay.turns[0].expect = { model: 'PRIVATE_FIXTURE_MODEL', tools: ['read'] }
  const modelError = await rejection(
    collect(new ReplayProvider(modelReplay).stream(request({ model: 'PRIVATE_CALLER_MODEL' }))),
  )
  assert.deepEqual(errorSummary(modelError), {
    code: 'EVAL_REPLAY_MODEL_MISMATCH',
    message: 'Replay model expectation did not match the request.',
  })

  const toolReplay = fixture()
  toolReplay.turns[0].expect = { model: 'replay-v1', tools: ['PRIVATE_FIXTURE_TOOL'] }
  const toolError = await rejection(
    collect(new ReplayProvider(toolReplay).stream(request({ toolNames: ['PRIVATE_CALLER_TOOL'] }))),
  )
  assert.deepEqual(errorSummary(toolError), {
    code: 'EVAL_REPLAY_TOOLS_MISMATCH',
    message: 'Replay tool expectations did not match the request.',
  })
})

test('honors an already-aborted signal without consuming replay data', async () => {
  const provider = new ReplayProvider(fixture())
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(collect(provider.stream(request({ signal: controller.signal }))), (error) =>
    hasCode(error, 'EVAL_REPLAY_ABORTED'),
  )
  assert.equal(provider.remainingTurns(), 1)
})

test('honors aborts between chunks after consuming the active fixture turn', async () => {
  const provider = new ReplayProvider(fixture())
  const controller = new AbortController()
  const iterator = provider.stream(request({ signal: controller.signal }))[Symbol.asyncIterator]()

  assert.deepEqual(await iterator.next(), { done: false, value: fixture().turns[0].chunks[0] })
  controller.abort()
  await assert.rejects(iterator.next(), (error) => hasCode(error, 'EVAL_REPLAY_ABORTED'))
  assert.equal(provider.remainingTurns(), 0)
})

test('clones input fixtures and yielded chunks instead of mutating replay data', async () => {
  const replay = fixture()
  const snapshot = structuredClone(replay)
  const provider = new ReplayProvider(replay)
  replay.turns[0].chunks[0] = { type: 'text_delta', text: 'Caller mutation.' }

  const chunks = await collect(provider.stream(request()))
  assert.deepEqual(chunks, snapshot.turns[0].chunks)
  ;(chunks[1] as Extract<ProviderChunk, { type: 'tool_calls' }>).calls[0].input = {
    path: 'mutated.txt',
  }
  assert.deepEqual(replay.turns[0].chunks.slice(1), snapshot.turns[0].chunks.slice(1))
})

test('deep-clones every yielded chunk when two reserved turns share nested replay data', async () => {
  const sharedInput = { path: 'synthetic-original.txt' }
  const replay: ProviderReplay = {
    turns: ['turn-a', 'turn-b'].map((id) => ({
      id,
      expect: { model: 'replay-v1', tools: ['read'] },
      chunks: [
        {
          type: 'tool_calls' as const,
          calls: [{ id: `${id}-call`, name: 'read', input: sharedInput }],
        },
        { type: 'completed' as const, stopReason: 'tool_calls' },
      ],
    })),
  }
  const provider = new ReplayProvider(replay)

  const first = await collect(provider.stream(request()))
  const firstCalls = first[0] as Extract<ProviderChunk, { type: 'tool_calls' }>
  ;(firstCalls.calls[0].input as { path: string }).path = 'caller-mutated.txt'

  const second = await collect(provider.stream(request()))
  const secondCalls = second[0] as Extract<ProviderChunk, { type: 'tool_calls' }>
  assert.deepEqual(secondCalls.calls[0].input, { path: 'synthetic-original.txt' })
  assert.equal(provider.remainingTurns(), 0)
})

function request(
  options: { model?: string; toolNames?: string[]; signal?: AbortSignal } = {},
): ProviderRequest {
  return {
    model: options.model ?? 'replay-v1',
    messages: [{ role: 'user', content: 'Synthetic request.' }],
    tools: (options.toolNames ?? ['read']).map((name) => ({
      name,
      description: `Synthetic ${name} tool.`,
      parameters: { type: 'object' },
    })),
    signal: options.signal ?? new AbortController().signal,
  }
}

async function collect(chunks: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const collected: ProviderChunk[] = []
  for await (const chunk of chunks) collected.push(chunk)
  return collected
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('Expected promise to reject.')
}

function errorSummary(error: unknown): { code: unknown; message: unknown } {
  if (typeof error !== 'object' || error === null) assert.fail('Expected an error object.')
  return {
    code: 'code' in error ? error.code : undefined,
    message: 'message' in error ? error.message : undefined,
  }
}
