import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { LocalRuntimeServer } from '../apps/runtime/src/server/localRuntimeServer.js'

const fixture = fileURLToPath(new URL('./fixtures/ndjson-echo-process.mjs', import.meta.url))

test('local server is loopback-only, token authenticated, and protocol transparent', async () => {
  const server = new LocalRuntimeServer({
    command: process.execPath,
    args: [fixture],
    token: 'fixture-token',
  })
  const address = await server.start()
  const socket = connect({ host: address.host, port: address.port })
  const lines = createInterface({ input: socket, crlfDelay: Infinity })
  const next = lineReader(lines)
  try {
    socket.write(`${JSON.stringify({ token: address.token })}\n`)
    assert.deepEqual(JSON.parse(await next()), { authenticated: true })
    const request = { jsonrpc: '2.0', id: '1', method: 'fixture', params: {} }
    socket.write(`${JSON.stringify(request)}\n`)
    assert.deepEqual(JSON.parse(await next()), request)
  } finally {
    socket.destroy()
    lines.close()
    await server.shutdown()
  }
})

test('local server shutdown is idempotent while an authenticated child is active', async () => {
  const server = new LocalRuntimeServer({
    command: process.execPath,
    args: [fixture],
    token: 'shutdown-token',
    maxClients: 2,
  })
  const address = await server.start()
  const socket = connect({ host: address.host, port: address.port })
  const lines = createInterface({ input: socket, crlfDelay: Infinity })
  const next = lineReader(lines)

  socket.write(`${JSON.stringify({ token: address.token })}\n`)
  assert.deepEqual(JSON.parse(await next()), { authenticated: true })
  await Promise.all([server.shutdown(), server.shutdown()])
  await server.shutdown()
  assert.equal(socket.destroyed, true)
  lines.close()
})

function lineReader(lines: ReturnType<typeof createInterface>): () => Promise<string> {
  const values: string[] = []
  const waiters: Array<(value: string) => void> = []
  lines.on('line', (line) => {
    const waiter = waiters.shift()
    if (waiter) waiter(line)
    else values.push(line)
  })
  return async () => {
    const value = values.shift()
    return value ?? new Promise<string>((resolve) => waiters.push(resolve))
  }
}
