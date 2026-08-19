import assert from 'node:assert/strict'
import test from 'node:test'
import { KimiProvider } from '../apps/runtime/src/providers/kimiProvider.js'
import { openAICompatibleToolName } from '../apps/runtime/src/providers/openAiCompatibleProvider.js'
import { MockProvider } from '../apps/runtime/src/providers/mockProvider.js'

test('Kimi Provider reports unauthenticated without an API key', () => {
  const provider = new KimiProvider('')
  assert.deepEqual(provider.authState(), { status: 'unauthenticated' })
})

test('Mock Provider remains deterministic and authenticated for offline tests', async () => {
  const provider = new MockProvider()
  assert.equal(provider.authState().status, 'authenticated')

  const controller = new AbortController()
  const chunks = []
  for await (const chunk of provider.stream({
    model: provider.defaultModel,
    messages: [{ role: 'user', content: 'offline test' }],
    tools: [],
    signal: controller.signal,
  })) {
    chunks.push(chunk)
  }
  assert.equal(chunks.at(-1)?.type, 'completed')
})

test('Kimi Provider sends ephemeral context after trusted instructions and before session messages', async () => {
  const provider = new KimiProvider('test-key')
  let requestPayload:
    | {
        messages?: Array<{ role: string; content: string | null }>
        tools?: Array<{ function: { description: string } }>
      }
    | undefined
  const stream = (async function* () {
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
  })()
  ;(
    provider as unknown as {
      client: {
        chat: { completions: { create(payload: typeof requestPayload): Promise<typeof stream> } }
      }
    }
  ).client = {
    chat: {
      completions: {
        async create(payload) {
          requestPayload = payload
          return stream
        },
      },
    },
  }

  for await (const _chunk of provider.stream({
    model: provider.defaultModel,
    instructions: 'trusted policy',
    contextMessages: [{ role: 'user', content: 'low-trust project guidance' }],
    messages: [{ role: 'user', content: 'persisted user task' }],
    tools: [
      { name: 'read', description: 'Native tool description', parameters: { type: 'object' } },
    ],
    signal: new AbortController().signal,
  })) {
  }

  assert.deepEqual(
    requestPayload?.messages?.map((message) => [message.role, message.content]),
    [
      ['system', 'trusted policy'],
      ['user', 'low-trust project guidance'],
      ['user', 'persisted user task'],
    ],
  )
  assert.equal(requestPayload?.tools?.[0]?.function.description, 'Native tool description')
})

test('OpenAI-compatible Provider aliases namespaced Tools on the wire and decodes calls', async () => {
  const provider = new KimiProvider('test-key')
  const internalName = 'agent.delegate'
  const wireName = openAICompatibleToolName(internalName)
  assert.match(wireName, /^[A-Za-z0-9_-]{1,64}$/u)
  assert.notEqual(wireName, internalName)
  let requestPayload:
    | {
        messages?: Array<{
          role: string
          tool_calls?: Array<{ function: { name: string } }>
        }>
        tools?: Array<{ function: { name: string } }>
        tool_choice?: { function: { name: string } }
      }
    | undefined
  const stream = (async function* () {
    yield {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: 'call-1', function: { name: wireName, arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }
  })()
  ;(
    provider as unknown as {
      client: {
        chat: { completions: { create(payload: typeof requestPayload): Promise<typeof stream> } }
      }
    }
  ).client = {
    chat: {
      completions: {
        async create(payload) {
          requestPayload = payload
          return stream
        },
      },
    },
  }

  const chunks = []
  for await (const chunk of provider.stream({
    model: provider.defaultModel,
    messages: [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'prior-call', name: internalName, input: {} }],
      },
      { role: 'tool', toolCallId: 'prior-call', name: internalName, content: 'done' },
    ],
    tools: [
      { name: internalName, description: 'Delegate work.', parameters: { type: 'object' } },
      {
        name: wireName,
        description: 'Deliberately collides with the generated alias.',
        parameters: { type: 'object' },
      },
    ],
    toolChoice: { name: internalName },
    signal: new AbortController().signal,
  })) {
    chunks.push(chunk)
  }

  assert.equal(requestPayload?.tools?.[0]?.function.name, wireName)
  assert.notEqual(requestPayload?.tools?.[1]?.function.name, wireName)
  assert.equal(requestPayload?.tool_choice?.function.name, wireName)
  assert.equal(requestPayload?.messages?.[0]?.tool_calls?.[0]?.function.name, wireName)
  assert.equal(chunks.find((chunk) => chunk.type === 'tool_call_start')?.name, internalName)
})
