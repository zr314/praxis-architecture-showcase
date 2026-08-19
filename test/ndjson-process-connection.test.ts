import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  NdjsonProcessConnection,
  type ProcessMessageCodec,
} from '../apps/runtime/src/process/ndjsonProcessConnection.js'

type Notice = { method: 'child.notice'; params: { value: string } }

const fixture = fileURLToPath(new URL('./fixtures/child-runtime.ts', import.meta.url))

test('shared NDJSON process transport bounds stderr, routes notifications, and reclaims the child', async () => {
  const connection = new NdjsonProcessConnection<Notice>(
    process.execPath,
    ['--import', 'tsx', fixture],
    {
      cwd: process.cwd(),
      codec: fixtureCodec,
      failure: (kind) => new Error(`process-connection:${kind}`),
      requestTimeoutMs: 2_000,
      maxStderrBytes: 1_024,
      stderr: 'capture',
    },
  )
  let nextId = 1
  const request = (method: string, params: Record<string, unknown>) =>
    connection.request<{ echoed?: string }>({
      jsonrpc: '2.0',
      id: `transport-${nextId++}`,
      method,
      params,
    })

  try {
    await request('initialize', {})
    const notifications = connection.notifications()[Symbol.asyncIterator]()
    assert.deepEqual(await request('child.execute', { mode: 'notification' }), {
      echoed: 'notification',
    })
    assert.deepEqual(await notifications.next(), {
      done: false,
      value: { method: 'child.notice', params: { value: 'ready' } },
    })
    assert.deepEqual(await request('child.execute', { mode: 'stderr' }), { echoed: 'stderr' })
    assert.equal(Buffer.byteLength(connection.stderr), 1_024)
    assert.match(connection.stderr, /^x+$/)
  } finally {
    await connection.close()
  }

  assert.equal(isProcessAlive(connection.pid), false)
  await assert.rejects(request('child.execute', {}), /process-connection:closed/)
})

test('shared process close waits for graceful exit then terminates the descendant tree', async () => {
  const connection = new NdjsonProcessConnection<Notice>(
    process.execPath,
    ['--import', 'tsx', fixture],
    {
      cwd: process.cwd(),
      codec: fixtureCodec,
      failure: (kind) => new Error(`process-connection:${kind}`),
      requestTimeoutMs: 2_000,
      closeTimeoutMs: 100,
      stderr: 'capture',
    },
  )
  await connection.request({
    jsonrpc: '2.0',
    id: 'initialize-tree',
    method: 'initialize',
    params: {},
  })
  const result = await connection.request<{ descendantPid: number }>({
    jsonrpc: '2.0',
    id: 'spawn-tree',
    method: 'child.execute',
    params: { mode: 'process_tree' },
  })

  assert.equal(isProcessAlive(connection.pid), true)
  assert.equal(isProcessAlive(result.descendantPid), true)
  await connection.close()
  await waitFor(() => !isProcessAlive(result.descendantPid))
  assert.equal(isProcessAlive(connection.pid), false)
})

const fixtureCodec: ProcessMessageCodec<Notice> = {
  decode(value) {
    if (!isRecord(value) || value.jsonrpc !== '2.0') throw new Error('invalid fixture frame')
    if (value.method === 'child.notice' && isRecord(value.params)) {
      return {
        type: 'notification',
        notification: {
          method: 'child.notice',
          params: { value: String(value.params.value) },
        },
      }
    }
    if (typeof value.id !== 'string') throw new Error('invalid fixture response id')
    if (Object.hasOwn(value, 'error')) {
      return { type: 'response', id: value.id, error: value.error }
    }
    if (Object.hasOwn(value, 'result')) {
      return { type: 'response', id: value.id, result: value.result }
    }
    throw new Error('invalid fixture response')
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for process tree cleanup.')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
