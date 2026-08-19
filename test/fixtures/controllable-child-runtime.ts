import { createInterface } from 'node:readline'

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let sequence = 1
let sessionId = 's-controlled'
let runId = 'r-controlled'
let subscriptionId = 'sub-controlled'
let terminal = false

input.on('line', (line) => {
  const request = JSON.parse(line) as {
    id: string
    method: string
    params: Record<string, unknown>
  }
  if (request.method === 'initialize') {
    write(request.id, {
      protocolVersion: 1,
      runtime: { runtimeId: `controlled-child-${process.pid}` },
      capabilities: {},
    })
    return
  }
  if (request.method === 'events.subscribe') {
    subscriptionId = 'sub-controlled'
    write(request.id, { subscriptionId, nextSequence: sequence, replaySupported: false })
    return
  }
  if (request.method === 'session.create') {
    sessionId = 's-controlled'
    write(request.id, {
      sessionId,
      state: 'idle',
      cwd: request.params.cwd,
      provider: request.params.provider,
      model: request.params.model,
    })
    return
  }
  if (request.method === 'session.prompt') {
    runId = 'r-controlled'
    write(request.id, { runId, accepted: true })
    process.stderr.write('x'.repeat(20 * 1024))
    notify({
      type: 'prompt_started',
      sessionId,
      runId,
      prompt: 'bounded child prompt',
    })
    return
  }
  if (request.method === 'session.abort') {
    if (!terminal) {
      terminal = true
      notify({
        type: 'prompt_aborted',
        runId,
        reason: 'user_abort',
        usage: { turns: 0, toolCalls: 0, subagents: 0 },
      })
    }
    write(request.id, { accepted: true })
    return
  }
  if (request.method === 'shutdown') {
    write(request.id, { accepted: true })
    input.close()
    return
  }
  write(request.id, { accepted: true })
})

function notify(event: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'event',
      params: {
        subscriptionId,
        sequence: sequence++,
        timestamp: new Date().toISOString(),
        sessionId,
        runId,
        event,
      },
    })}\n`,
  )
}

function write(id: string, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}
