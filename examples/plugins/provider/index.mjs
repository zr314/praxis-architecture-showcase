import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin })
const manifest = {
  id: 'example.process-provider',
  version: '0.1.0',
  apiVersion: 1,
  isolation: 'process',
  capabilities: ['provider'],
}

lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    respond(request.id, {
      manifest,
      capabilities: [
        {
          id: 'example.provider',
          kind: 'provider',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          provider: {
            defaultModel: 'example-v1',
            capabilities: {
              streaming: { text: true, reasoning: false, usage: true },
              tools: { mode: 'native', parallelCalls: false },
              modalities: { text: true, vision: false, audio: false },
              output: { jsonSchema: false, citations: false },
              limits: { maxContextTokens: 8192, maxOutputTokens: 1024 },
            },
          },
        },
      ],
    })
  } else if (request.method === 'capability.invoke') {
    respond(request.id, {
      invocationId: request.params.invocationId,
      output: {
        chunks: [
          { type: 'message_start' },
          { type: 'text_start', contentIndex: 0 },
          { type: 'text_delta', contentIndex: 0, text: 'Example Provider response.' },
          { type: 'text_end', contentIndex: 0 },
          { type: 'completed', stopReason: 'end_turn', usage: { outputTokens: 4 } },
        ],
      },
    })
  } else if (request.method === 'capability.cancel') {
    respond(request.id, { invocationId: request.params.invocationId, accepted: true })
  } else if (request.method === 'health.ping') {
    respond(request.id, { nonce: request.params.nonce })
  } else if (request.method === 'shutdown') {
    respond(request.id, { accepted: true })
  }
})

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}
