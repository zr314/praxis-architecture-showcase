import { createInterface } from 'node:readline'

const version = '2026-07-28'

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'server/discover') {
    respond(request.id, {
      resultType: 'complete',
      supportedVersions: [version],
      capabilities: { tools: {} },
      ttlMs: 0,
      cacheScope: 'private',
    })
    return
  }
  if (request.method === 'tools/list') {
    respond(request.id, {
      resultType: 'complete',
      tools: [{ name: 'environment', inputSchema: { type: 'object' } }],
      ttlMs: 0,
      cacheScope: 'private',
    })
    return
  }
  if (request.method === 'tools/call') {
    const output = {
      approved: process.env.PRAXIS_MCP_TEST_VALUE ?? null,
      undeclared: process.env.PRAXIS_MCP_UNDECLARED_VALUE ?? null,
    }
    respond(request.id, {
      resultType: 'complete',
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
      isError: false,
    })
    return
  }
  if (request.method === 'shutdown') respond(request.id, { resultType: 'complete' })
})

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}
