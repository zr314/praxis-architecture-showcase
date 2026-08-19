import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'notifications/initialized') return
  if (request.method === 'notifications/cancelled') return
  if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'praxis-example-mcp', version: '0.1.0' },
    })
  } else if (request.method === 'tools/list') {
    respond(request.id, {
      tools: [
        {
          name: 'echo',
          description: 'Returns its input.',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
        },
      ],
    })
  } else if (request.method === 'tools/call') {
    respond(request.id, {
      content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }],
      structuredContent: request.params.arguments,
      isError: false,
    })
  } else if (request.method === 'shutdown') {
    respond(request.id, {})
  }
})

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}
