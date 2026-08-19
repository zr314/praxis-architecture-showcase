import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'server/discover') {
    respondError(request.id, -32601, 'Method not found')
  } else if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: '2099-01-01',
      capabilities: { tools: {} },
      serverInfo: { name: 'wrong-version', version: '1.0.0' },
    })
  }
})

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}
