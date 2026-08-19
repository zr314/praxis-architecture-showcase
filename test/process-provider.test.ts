import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderCapabilities } from '@praxis/core-sdk'
import { ProcessProvider } from '../apps/runtime/src/extensions/processProvider.js'

const capabilities: ProviderCapabilities = {
  streaming: { text: true, reasoning: false, usage: true },
  tools: { mode: 'native', parallelCalls: false },
  modalities: { text: true, vision: false, audio: false },
  output: { jsonSchema: false, citations: false },
  limits: {},
}

test('Process Provider validates chunks while leaving retry and credentials to Runtime', async () => {
  const provider = new ProcessProvider({
    id: 'process-fixture',
    defaultModel: 'fixture-v1',
    capabilityId: 'fixture.provider',
    capabilities,
    client: {
      invoke: async () => ({
        chunks: [
          { type: 'message_start' },
          { type: 'text_start', contentIndex: 0 },
          { type: 'text_delta', contentIndex: 0, text: 'hello' },
          { type: 'text_end', contentIndex: 0 },
          { type: 'completed', stopReason: 'end_turn' },
        ],
      }),
      cancel: async () => {},
    },
  })
  const chunks = []
  for await (const chunk of provider.stream({
    model: 'fixture-v1',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    signal: new AbortController().signal,
  })) {
    chunks.push(chunk)
  }
  assert.equal(chunks.at(-1)?.type, 'completed')
})

test('Process Provider reports malformed stream order to the activation boundary', async () => {
  let protocolFailures = 0
  const provider = new ProcessProvider({
    id: 'process-invalid',
    defaultModel: 'fixture-v1',
    capabilityId: 'fixture.provider',
    capabilities,
    client: {
      invoke: async () => ({
        chunks: [
          { type: 'message_start' },
          { type: 'text_delta', contentIndex: 0, text: 'missing text_start' },
          { type: 'completed', stopReason: 'end_turn' },
        ],
      }),
      cancel: async () => {},
    },
    onProtocolFailure: async () => {
      protocolFailures += 1
    },
  })

  await assert.rejects(async () => {
    for await (const _chunk of provider.stream({
      model: 'fixture-v1',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      // Consume the complete stream so protocol finalization runs.
    }
  }, hasCode('PROCESS_PROVIDER_PROTOCOL_INVALID'))
  assert.equal(protocolFailures, 1)
})

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
