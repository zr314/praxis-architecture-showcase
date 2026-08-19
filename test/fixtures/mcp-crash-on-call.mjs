import { createInterface } from 'node:readline'

const PROTOCOL_VERSION = '2026-07-28'
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'server/discover') {
    respond(request.id, {
      resultType: 'complete',
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      ttlMs: 0,
      cacheScope: 'private',
      _meta: {
        'io.modelcontextprotocol/serverInfo': {
          name: 'praxis-call-crash-fixture',
          version: '1.0.0',
        },
      },
    })
  } else if (request.method === 'tools/list') {
    respond(request.id, {
      resultType: 'complete',
      tools: [{ name: 'crash', inputSchema: { type: 'object' } }],
      ttlMs: 0,
      cacheScope: 'private',
    })
  } else if (request.method === 'tools/call') {
    process.exit(19)
  }
})

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}
