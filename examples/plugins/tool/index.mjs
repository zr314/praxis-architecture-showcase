import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin })
const manifest = {
  id: 'example.echo-tool',
  version: '0.1.0',
  apiVersion: 1,
  isolation: 'process',
  capabilities: ['tool'],
}

lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    respond(request.id, {
      manifest,
      capabilities: [
        {
          id: 'example.echo',
          kind: 'tool',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string', minLength: 1, maxLength: 4096 } },
            required: ['value'],
            additionalProperties: false,
          },
          outputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
          execution: {
            sideEffect: 'read',
            target: { kind: 'none' },
            parallelSafe: true,
            conflictScope: 'target',
            maxInlineBytes: 65536,
            timeoutMs: 5000,
          },
        },
      ],
    })
  } else if (request.method === 'capability.invoke') {
    respond(request.id, {
      invocationId: request.params.invocationId,
      output: request.params.input,
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
