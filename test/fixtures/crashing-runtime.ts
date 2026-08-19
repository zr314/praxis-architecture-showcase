import { createInterface } from 'node:readline'

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })

input.on('line', (line) => {
  const request = JSON.parse(line) as { id: string; method: string }
  if (request.method === 'initialize') {
    write(request.id, {
      protocolVersion: 1,
      runtime: { runtimeId: `crash-runtime-${process.pid}` },
      capabilities: {},
    })
    return
  }
  if (request.method === 'events.subscribe') {
    write(request.id, { subscriptionId: 'sub-1', nextSequence: 1, replaySupported: false })
    return
  }
  if (request.method === 'session.create') {
    write(request.id, {
      sessionId: 's-1',
      state: 'idle',
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-v1',
    })
    return
  }
  if (request.method === 'session.prompt') {
    write(request.id, { runId: 'r-1', accepted: true })
    process.nextTick(() => process.exit(1))
    return
  }
  write(request.id, { accepted: true })
})

function write(id: string, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}
