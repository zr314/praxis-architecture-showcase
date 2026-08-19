import { createInterface } from 'node:readline'

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
const pending = new Map()

input.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    respond(request.id, {
      manifest: {
        id: 'example.process-runtime',
        version: '1.0.0',
        apiVersion: 1,
        isolation: 'process',
        capabilities: ['tool', 'provider'],
      },
      capabilities: [
        {
          id: 'echo',
          kind: 'tool',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
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
            sideEffect: 'process',
            target: { kind: 'workspace' },
            parallelSafe: false,
            conflictScope: 'workspace',
            maxInlineBytes: 65536,
            timeoutMs: 5000,
          },
        },
        {
          id: 'chat',
          kind: 'provider',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          provider: {
            defaultModel: 'fixture-v1',
            capabilities: {
              streaming: { text: true, reasoning: false, usage: true },
              tools: { mode: 'native', parallelCalls: false },
              modalities: { text: true, vision: false, audio: false },
              output: { jsonSchema: false, citations: false },
              limits: { maxContextTokens: 16384, maxOutputTokens: 1024 },
            },
          },
        },
      ],
    })
    return
  }
  if (request.method === 'health.ping') {
    respond(request.id, { nonce: request.params.nonce })
    return
  }
  if (request.method === 'capability.invoke') {
    const { invocationId, capabilityId, input: value, cancellationId } = request.params
    if (capabilityId === 'echo') {
      if (value?.value === 'crash') process.exit(23)
      respond(request.id, { invocationId, output: value })
      return
    }
    pending.set(cancellationId, { request, invocationId })
    event(invocationId, 'output', { chunk: { type: 'message_start' } })
    event(invocationId, 'output', {
      chunk: { type: 'text_start', contentIndex: 0 },
    })
    setTimeout(() => {
      if (!pending.has(cancellationId)) return
      event(invocationId, 'output', {
        chunk: { type: 'text_delta', contentIndex: 0, text: 'process provider' },
      })
      event(invocationId, 'output', {
        chunk: { type: 'text_end', contentIndex: 0 },
      })
      event(invocationId, 'output', {
        chunk: {
          type: 'completed',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 2 },
        },
      })
      pending.delete(cancellationId)
      respond(request.id, { invocationId, output: { streamed: true } })
    }, 10)
    return
  }
  if (request.method === 'capability.cancel') {
    for (const [cancellationId, active] of pending) {
      if (active.invocationId !== request.params.invocationId) continue
      pending.delete(cancellationId)
      respond(active.request.id, {
        invocationId: active.invocationId,
        output: { cancelled: true },
      })
    }
    respond(request.id, {
      invocationId: request.params.invocationId,
      accepted: true,
    })
    return
  }
  if (request.method === 'shutdown') {
    respond(request.id, { accepted: true })
    input.close()
  }
})

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function event(invocationId, type, payload) {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'event',
      params: { invocationId, type, payload },
    })}\n`,
  )
}
