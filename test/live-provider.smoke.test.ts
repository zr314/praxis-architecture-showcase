import assert from 'node:assert/strict'
import test from 'node:test'
import { KimiProvider } from '../apps/runtime/src/providers/kimiProvider.js'

const apiKey = process.env.PRAXIS_LIVE_KIMI_API_KEY

test('opt-in Kimi smoke completes one token- and time-bounded request', {
  skip: !apiKey,
  timeout: 25_000,
}, async () => {
  const provider = new KimiProvider(apiKey)
  const chunks = []
  for await (const chunk of provider.stream({
    model: process.env.PRAXIS_LIVE_KIMI_MODEL ?? provider.defaultModel,
    messages: [{ role: 'user', content: 'Reply with OK only.' }],
    tools: [],
    signal: AbortSignal.timeout(20_000),
    maxOutputTokens: 16,
  })) {
    chunks.push(chunk)
  }
  assert.equal(chunks[0]?.type, 'message_start')
  assert.equal(chunks.at(-1)?.type, 'completed')
})
