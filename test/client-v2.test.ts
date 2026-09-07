import assert from 'node:assert/strict'
import test from 'node:test'
import type { EventNotification, JsonRpcRequest, PromptInput, SessionEvent } from '@praxis/protocol'
import { MockRuntimeBridge } from '../apps/cli/src/bridge/mockBridge.js'
import { policyDecision } from '../apps/cli/src/policyFile.js'
import { renderNonInteractive } from '../apps/cli/src/render/nonInteractive.js'
import { executeSlashCommand } from '../apps/cli/src/ui/slashCommands.js'
import { isBackwardDeleteSequence, TerminalEditorModel } from '../apps/cli/src/ui/terminalEditor.js'
import { PraxisClient, type ProtocolConnection } from '../packages/client/src/index.js'

test('multiline editor handles paste, history, Unicode backspace, and slash completion', () => {
  const editor = new TerminalEditorModel(['/compact'])
  editor.insert('\u001b[200~first\r\nsecond\u001b[201~')
  editor.newline()
  editor.insert('😀')
  editor.backspace()
  assert.equal(editor.submit(), 'first\nsecond')

  editor.insert('next')
  assert.equal(editor.submit(), 'next')
  assert.equal(editor.previousHistory(), 'next')
  assert.equal(editor.previousHistory(), 'first\nsecond')
  assert.equal(editor.nextHistory(), 'next')
  editor.replace('/comp')
  assert.equal(editor.complete(), '/compact ')
})

test('terminal editor exposes a grapheme-safe cursor and edits anywhere in multiline input', () => {
  const editor = new TerminalEditorModel()
  editor.replace('alpha\n😀omega')

  assert.equal(editor.moveToLineStart(), true)
  assert.equal(editor.cursorIndex, 6)
  assert.equal(editor.moveRight(), true)
  assert.equal(editor.cursorIndex, 8)
  editor.insert('middle ')
  assert.equal(editor.value, 'alpha\n😀middle omega')

  for (let index = 0; index < 7; index += 1) editor.moveLeft()
  editor.backspace()
  assert.equal(editor.value, 'alpha\nmiddle omega')
  assert.equal(editor.moveUp(), true)
  assert.equal(editor.moveToLineEnd(), true)
  editor.insert(' revised')
  assert.equal(editor.value, 'alpha revised\nmiddle omega')
  assert.equal(editor.moveDown(), true)
  assert.equal(editor.moveToLineStart(), true)
  for (let index = 0; index < 7; index += 1) editor.moveRight()
  editor.deleteForward()
  assert.equal(editor.value, 'alpha revised\nmiddle mega')
})

test('terminal editor restores the draft after browsing prompt history', () => {
  const editor = new TerminalEditorModel()
  editor.insert('submitted')
  assert.equal(editor.submit(), 'submitted')
  editor.insert('draft')
  assert.equal(editor.previousHistory(), 'submitted')
  assert.equal(editor.nextHistory(), 'draft')
  assert.equal(editor.cursorIndex, 'draft'.length)
})

test('terminal delete decoding distinguishes Backspace from forward Delete', () => {
  assert.equal(isBackwardDeleteSequence('\u007f'), true)
  assert.equal(isBackwardDeleteSequence('\u001b\u007f'), true)
  assert.equal(isBackwardDeleteSequence('\u001b[127u'), true)
  assert.equal(isBackwardDeleteSequence('\u001b[127;1:1u'), true)
  assert.equal(isBackwardDeleteSequence('\u001b[27;2;127~'), true)
  assert.equal(isBackwardDeleteSequence('\u001b[3~'), false)
  assert.equal(isBackwardDeleteSequence('\u001b[3;2~'), false)

  const editor = new TerminalEditorModel()
  editor.insert('abc')
  editor.moveLeft()
  editor.backspace()
  assert.equal(editor.value, 'ac')
  editor.deleteForward()
  assert.equal(editor.value, 'a')
})

test('stream-json emits versioned start, delta, usage, and terminal envelopes', async () => {
  const output: string[] = []
  const originalWrite = process.stdout.write
  const originalExitCode = process.exitCode
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    await renderNonInteractive(events(), 'stream-json')
  } finally {
    process.stdout.write = originalWrite
    process.exitCode = originalExitCode
  }
  const records = output
    .join('')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    records.map((record) => [record.schemaVersion, record.sequence, record.kind]),
    [
      [1, 1, 'start'],
      [1, 2, 'delta'],
      [1, 3, 'usage'],
      [1, 4, 'terminal'],
    ],
  )
})

test('non-interactive policy matches fixed Tool and target rules', () => {
  const event: Extract<SessionEvent, { type: 'permission_request' }> = {
    type: 'permission_request',
    runId: 'run',
    requestId: 'permission',
    toolCallId: 'call',
    tool: 'read',
    input: {},
    target: 'D:/workspace/file.txt',
  }
  assert.deepEqual(
    policyDecision(
      {
        version: 1,
        default: 'deny',
        rules: [
          {
            tool: 'read',
            decision: 'allow_once',
            targetPrefix: 'D:/workspace/',
          },
        ],
      },
      event,
    ),
    { type: 'allow_once' },
  )
})

test('slash commands route session, model, compaction, artifacts, plan, and doctor independently', async () => {
  const bridge = new MockRuntimeBridge()
  const session = await bridge.createSession({ cwd: process.cwd() })
  const context = { bridge, session, cwd: process.cwd() }
  assert.deepEqual((await executeSlashCommand('/session work', context)).action, {
    type: 'open_session_picker',
    query: 'work',
  })
  assert.match((await executeSlashCommand('/compact', context)).message ?? '', /compaction/i)
  assert.match((await executeSlashCommand('/plan', context)).message ?? '', /sessionId/)
  assert.equal((await executeSlashCommand('/artifacts', context)).message, 'No artifacts.')
  assert.match((await executeSlashCommand('/doctor', context)).message ?? '', /Mock bridge/)
  let copied = ''
  const copiedResult = await executeSlashCommand('/copy', {
    ...context,
    latestAssistantText: 'final answer',
    copyText: async (text) => {
      copied = text
    },
  })
  assert.equal(copied, 'final answer')
  assert.match(copiedResult.message ?? '', /Copied/)
  assert.match((await executeSlashCommand('/copy', context)).message ?? '', /No assistant response/)
  assert.deepEqual((await executeSlashCommand('/model', context)).action, {
    type: 'open_catalog',
    view: 'models',
  })
  assert.deepEqual((await executeSlashCommand('/provider', context)).action, {
    type: 'open_catalog',
    view: 'providers',
  })
  assert.deepEqual((await executeSlashCommand('/provider mock', context)).action, {
    type: 'open_catalog',
    view: 'models',
    provider: 'mock',
  })
  assert.deepEqual((await executeSlashCommand('/login', context)).action, {
    type: 'open_catalog',
    view: 'providers',
    intent: 'login',
  })
  assert.deepEqual((await executeSlashCommand('/login mock', context)).action, {
    type: 'open_catalog',
    view: 'providers',
    intent: 'login',
    provider: 'mock',
  })
  assert.deepEqual((await executeSlashCommand('/logout', context)).action, {
    type: 'open_catalog',
    view: 'providers',
    intent: 'logout',
  })
  assert.match(
    (await executeSlashCommand('/logout mock', context)).message ?? '',
    /Disconnected mock/,
  )
  assert.equal(
    (await executeSlashCommand('/model mock/mock-v1', context)).session?.model,
    'mock-v1',
  )
  assert.deepEqual((await executeSlashCommand('/model unknown', context)).action, {
    type: 'open_catalog',
    view: 'models',
    query: 'unknown',
  })
})

test('typed client negotiates v1 and rejects event sequence gaps', async () => {
  const requests: JsonRpcRequest[] = []
  const connection: ProtocolConnection = {
    async request<T>(request: JsonRpcRequest): Promise<T> {
      requests.push(request)
      if (request.method === 'initialize') {
        return {
          protocolVersion: 1,
          supportedProtocolVersions: [1],
          runtime: { name: 'runtime', version: '1', runtimeId: 'runtime-1' },
          capabilities: {},
        } as T
      }
      return {
        subscriptionId: 'subscription-1',
        nextSequence: 1,
        replaySupported: false,
      } as T
    },
    async *notifications() {
      yield notification(2, { type: 'runtime_ready', runtimeId: 'runtime-1' })
    },
    async close() {},
  }
  const client = new PraxisClient(async () => connection, {
    reconnectAttempts: 0,
  })
  await client.connect()
  await assert.rejects(async () => {
    for await (const _event of client.events()) {
    }
  }, /sequence gap/)
  assert.deepEqual(
    requests.map((request) => request.method),
    ['initialize', 'events.subscribe'],
  )
  await client.close()
})

test('typed client fails only a slow consumer that exceeds its bounded event queue', async () => {
  const connection = scriptedConnection('runtime-buffer', [], async function* () {
    yield notification(1, {
      type: 'runtime_ready',
      runtimeId: 'runtime-buffer',
    })
    yield notification(2, {
      type: 'runtime_warning',
      code: 'ONE',
      message: 'one',
    })
    yield notification(3, {
      type: 'runtime_warning',
      code: 'TWO',
      message: 'two',
    })
  })
  const client = new PraxisClient(async () => connection, {
    reconnectAttempts: 0,
    eventBufferCapacity: 1,
  })
  const iterator = client.events()[Symbol.asyncIterator]()

  assert.equal((await iterator.next()).value?.type, 'runtime_ready')
  await new Promise<void>((resolve) => setImmediate(resolve))
  await assert.rejects(() => iterator.next(), {
    name: 'EventBufferOverflowError',
  })
  await client.close()
})

test('typed client rejects schema-invalid connection results', async () => {
  const connection: ProtocolConnection = {
    async request<T>(): Promise<T> {
      return {
        accepted: true,
      } as T
    },
    async *notifications() {},
    async close() {},
  }
  const client = new PraxisClient(async () => connection, {
    reconnectAttempts: 0,
  })

  await assert.rejects(() => client.connect(), /Protocol schema validation failed/)
  await client.close()
})

test('typed client exposes resume, follow-up, steer, and abort Runtime controls', async () => {
  const requests: JsonRpcRequest[] = []
  const connection: ProtocolConnection = {
    async request<T>(request: JsonRpcRequest): Promise<T> {
      requests.push(request)
      switch (request.method) {
        case 'initialize':
          return {
            protocolVersion: 1,
            supportedProtocolVersions: [1],
            runtime: {
              name: 'runtime',
              version: '1',
              runtimeId: 'runtime-controls',
            },
            capabilities: {},
          } as T
        case 'events.subscribe':
          return {
            subscriptionId: 'subscription-1',
            nextSequence: 1,
            replaySupported: false,
          } as T
        case 'session.resume':
          return {
            sessionId: 'session-controls',
            state: 'idle',
            cwd: 'D:/workspace',
            provider: 'mock',
            model: 'mock-v1',
          } as T
        case 'session.follow_up':
          return { runId: 'run-controls', accepted: true } as T
        case 'session.steer':
          return { accepted: true, applyAt: 'next_safe_boundary' } as T
        default:
          return { accepted: true } as T
      }
    },
    async *notifications() {
      yield notification(1, {
        type: 'prompt_started',
        sessionId: 'session-controls',
        runId: 'run-controls',
        prompt: 'Continue.',
      })
      yield notification(2, {
        type: 'prompt_completed',
        runId: 'run-controls',
      })
    },
    async close() {},
  }
  const client = new PraxisClient(async () => connection, {
    reconnectAttempts: 0,
  })

  await client.resumeSession('session-controls')
  const events: SessionEvent[] = []
  for await (const event of client.followUp({
    sessionId: 'session-controls',
    text: 'Continue.',
    agent: { name: 'reviewer', instructions: 'Review the current changes.' },
  })) {
    events.push(event)
  }
  await client.steer('session-controls', 'run-controls', 'Check one more edge case.')
  await client.abort('run-controls')

  assert.deepEqual(
    requests.map(({ method }) => method),
    [
      'initialize',
      'events.subscribe',
      'session.resume',
      'session.follow_up',
      'session.steer',
      'session.abort',
    ],
  )
  const followUpRequest = requests.find(({ method }) => method === 'session.follow_up')
  assert.ok(followUpRequest)
  assert.deepEqual((followUpRequest.params as PromptInput).agent, {
    name: 'reviewer',
    instructions: 'Review the current changes.',
  })
  assert.deepEqual(
    events.map(({ type }) => type),
    ['prompt_started', 'prompt_completed'],
  )
  await client.close()
})

test('typed client ends a Run stream on recoverable prompt_blocked', async () => {
  const connection: ProtocolConnection = {
    async request<T>(request: JsonRpcRequest): Promise<T> {
      if (request.method === 'initialize') {
        return {
          protocolVersion: 1,
          supportedProtocolVersions: [1],
          runtime: {
            name: 'runtime',
            version: '1',
            runtimeId: 'runtime-blocked',
          },
          capabilities: {},
        } as T
      }
      if (request.method === 'events.subscribe') {
        return {
          subscriptionId: 'subscription-1',
          nextSequence: 1,
          replaySupported: true,
        } as T
      }
      return { runId: 'run-blocked', accepted: true } as T
    },
    async *notifications() {
      yield notification(1, {
        type: 'prompt_started',
        sessionId: 'session-blocked',
        runId: 'run-blocked',
        prompt: 'Complete a required Plan.',
      })
      yield notification(2, {
        type: 'prompt_blocked',
        runId: 'run-blocked',
        code: 'PLAN_COMPLETION_REQUIRED',
        reason: 'Final Review is required.',
        recoverable: true,
      })
    },
    async close() {},
  }
  const client = new PraxisClient(async () => connection, {
    reconnectAttempts: 0,
  })

  const events = await collectEvents(
    client.prompt({
      sessionId: 'session-blocked',
      text: 'Complete a required Plan.',
    }),
  )

  assert.deepEqual(
    events.map(({ type }) => type),
    ['prompt_started', 'prompt_blocked'],
  )
  await client.close()
})

test('typed client multiplexes interleaved concurrent Run streams without losing early events', async () => {
  const queue = new NotificationQueue()
  let sequence = 1
  let promptRequests = 0
  const connection: ProtocolConnection = {
    async request<T>(request: JsonRpcRequest): Promise<T> {
      if (request.method === 'initialize') {
        return {
          protocolVersion: 1,
          supportedProtocolVersions: [1],
          runtime: {
            name: 'runtime',
            version: '1',
            runtimeId: 'runtime-multiplex',
          },
          capabilities: {},
        } as T
      }
      if (request.method === 'events.subscribe') {
        return {
          subscriptionId: 'subscription-1',
          nextSequence: 1,
          replaySupported: false,
        } as T
      }
      if (request.method === 'session.prompt') {
        promptRequests += 1
        const runId = `run-${promptRequests}`
        const params = request.params as PromptInput
        queue.push(
          notification(sequence++, {
            type: 'prompt_started',
            sessionId: params.sessionId,
            runId,
            prompt: params.text,
          }),
        )
        if (promptRequests === 2) {
          queue.push(
            notification(sequence++, {
              type: 'text_delta',
              runId: 'run-2',
              text: 'B',
            }),
          )
          queue.push(
            notification(sequence++, {
              type: 'text_delta',
              runId: 'run-1',
              text: 'A',
            }),
          )
          queue.push(
            notification(sequence++, {
              type: 'prompt_completed',
              runId: 'run-2',
            }),
          )
          queue.push(
            notification(sequence++, {
              type: 'prompt_completed',
              runId: 'run-1',
            }),
          )
        }
        return { runId, accepted: true } as T
      }
      throw new Error(`Unexpected method: ${request.method}`)
    },
    notifications: () => queue,
    async close() {
      queue.close()
    },
  }
  const client = new PraxisClient(async () => connection, {
    reconnectAttempts: 0,
  })

  const [first, second] = await Promise.all([
    collectEvents(client.prompt({ sessionId: 'session-1', text: 'First.' })),
    collectEvents(client.prompt({ sessionId: 'session-2', text: 'Second.' })),
  ])

  assert.deepEqual(
    first.map(({ type }) => type),
    ['prompt_started', 'text_delta', 'prompt_completed'],
  )
  assert.deepEqual(
    second.map(({ type }) => type),
    ['prompt_started', 'text_delta', 'prompt_completed'],
  )
  assert.equal(first.find(isTextDelta)?.runId, 'run-1')
  assert.equal(second.find(isTextDelta)?.runId, 'run-2')
  await client.close()
})

test('typed client replays one Runtime epoch but resets sequence state for a new Runtime', async () => {
  const requests: JsonRpcRequest[][] = [[], []]
  const connections = [
    scriptedConnection('runtime-1', requests[0]!, async function* () {
      yield notification(1, { type: 'runtime_ready', runtimeId: 'runtime-1' })
      throw new Error('first transport closed')
    }),
    scriptedConnection('runtime-2', requests[1]!, async function* () {
      yield notification(1, { type: 'runtime_ready', runtimeId: 'runtime-2' })
    }),
  ]
  const epochs: Array<{
    previousRuntimeId?: string
    runtimeId: string
    epoch: number
  }> = []
  const client = new PraxisClient(
    async () => {
      const connection = connections.shift()
      if (!connection) throw new Error('No scripted connection remains.')
      return connection
    },
    {
      reconnectAttempts: 1,
      onRuntimeEpoch: (transition) => {
        epochs.push(transition)
      },
    },
  )

  const events: SessionEvent[] = []
  for await (const event of client.events()) events.push(event)

  assert.deepEqual(
    events.map((event) => (event.type === 'runtime_ready' ? event.runtimeId : event.type)),
    ['runtime-1', 'runtime-2'],
  )
  assert.deepEqual(
    requests.map((connectionRequests) =>
      connectionRequests
        .filter((request) => request.method === 'events.subscribe')
        .map((request) => request.params),
    ),
    [[{ sessionId: null, fromSequence: null }], [{ sessionId: null, fromSequence: null }]],
  )
  assert.deepEqual(epochs, [
    { runtimeId: 'runtime-1', epoch: 1 },
    { previousRuntimeId: 'runtime-1', runtimeId: 'runtime-2', epoch: 2 },
  ])
  assert.equal(client.runtimeId, 'runtime-2')
  assert.equal(client.runtimeEpoch, 2)
  await client.close()
})

test('typed client requests replay only when reconnecting to the same Runtime epoch', async () => {
  const requests: JsonRpcRequest[][] = [[], []]
  const connections = [
    scriptedConnection('runtime-stable', requests[0]!, async function* () {
      yield notification(1, {
        type: 'runtime_ready',
        runtimeId: 'runtime-stable',
      })
      throw new Error('temporary transport failure')
    }),
    scriptedConnection('runtime-stable', requests[1]!, async function* () {
      yield notification(2, {
        type: 'runtime_warning',
        code: 'REPLAYED',
        message: 'replayed',
      })
    }),
  ]
  const client = new PraxisClient(async () => connections.shift()!, {
    reconnectAttempts: 1,
  })

  const events: SessionEvent[] = []
  for await (const event of client.events()) events.push(event)

  assert.deepEqual(
    requests[1]
      ?.filter((request) => request.method === 'events.subscribe')
      .map((request) => request.params),
    [{ sessionId: null, fromSequence: 2 }],
  )
  assert.deepEqual(
    events.map((event) => event.type),
    ['runtime_ready', 'runtime_warning'],
  )
  assert.equal(client.runtimeEpoch, 1)
  await client.close()
})

test('typed client replays sequence one when a same-Runtime connection fails before any event', async () => {
  const requests: JsonRpcRequest[][] = [[], []]
  const connections = [
    scriptedConnection('runtime-stable', requests[0]!, async function* () {
      throw new Error('transport failed before first event')
    }),
    scriptedConnection('runtime-stable', requests[1]!, async function* () {
      yield notification(1, {
        type: 'runtime_ready',
        runtimeId: 'runtime-stable',
      })
    }),
  ]
  const client = new PraxisClient(async () => connections.shift()!, {
    reconnectAttempts: 1,
  })

  const events: SessionEvent[] = []
  for await (const event of client.events()) events.push(event)

  assert.deepEqual(
    requests.map((connectionRequests) =>
      connectionRequests
        .filter((request) => request.method === 'events.subscribe')
        .map((request) => request.params),
    ),
    [[{ sessionId: null, fromSequence: null }], [{ sessionId: null, fromSequence: 1 }]],
  )
  assert.deepEqual(
    events.map((event) => event.type),
    ['runtime_ready'],
  )
  await client.close()
})

test('typed client resets the reconnect budget after receiving a valid replayed event', async () => {
  const requests: JsonRpcRequest[][] = [[], [], []]
  const connections = [
    scriptedConnection('runtime-stable', requests[0]!, async function* () {
      yield notification(1, {
        type: 'runtime_ready',
        runtimeId: 'runtime-stable',
      })
      throw new Error('first isolated transport failure')
    }),
    scriptedConnection('runtime-stable', requests[1]!, async function* () {
      yield notification(2, {
        type: 'runtime_warning',
        code: 'FIRST_REPLAY',
        message: 'first replay',
      })
      throw new Error('second isolated transport failure')
    }),
    scriptedConnection('runtime-stable', requests[2]!, async function* () {
      yield notification(3, {
        type: 'runtime_warning',
        code: 'SECOND_REPLAY',
        message: 'second replay',
      })
    }),
  ]
  const client = new PraxisClient(async () => connections.shift()!, {
    reconnectAttempts: 1,
  })

  const events: SessionEvent[] = []
  for await (const event of client.events()) events.push(event)

  assert.deepEqual(
    events.map((event) => event.type),
    ['runtime_ready', 'runtime_warning', 'runtime_warning'],
  )
  assert.deepEqual(
    requests.map((connectionRequests) =>
      connectionRequests
        .filter((request) => request.method === 'events.subscribe')
        .map((request) => request.params),
    ),
    [
      [{ sessionId: null, fromSequence: null }],
      [{ sessionId: null, fromSequence: 2 }],
      [{ sessionId: null, fromSequence: 3 }],
    ],
  )
  await client.close()
})

async function* events(): AsyncIterable<SessionEvent> {
  yield {
    type: 'prompt_started',
    sessionId: 'session',
    runId: 'run',
    prompt: 'prompt',
  }
  yield { type: 'text_delta', runId: 'run', text: 'answer' }
  yield {
    type: 'prompt_completed',
    runId: 'run',
    usage: { inputTokens: 1, outputTokens: 1 },
  }
}

async function collectEvents(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const collected: SessionEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

class NotificationQueue implements AsyncIterable<EventNotification> {
  readonly #values: EventNotification[] = []
  readonly #waiters: Array<(result: IteratorResult<EventNotification>) => void> = []
  #closed = false

  push(value: EventNotification): void {
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ done: false, value })
    else this.#values.push(value)
  }

  close(): void {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  async *[Symbol.asyncIterator](): AsyncIterator<EventNotification> {
    while (true) {
      const value = this.#values.shift()
      if (value !== undefined) {
        yield value
        continue
      }
      if (this.#closed) return
      const result = await new Promise<IteratorResult<EventNotification>>((resolve) => {
        this.#waiters.push(resolve)
      })
      if (result.done) return
      yield result.value
    }
  }
}

function scriptedConnection(
  runtimeId: string,
  requests: JsonRpcRequest[],
  notifications: () => AsyncIterable<EventNotification>,
): ProtocolConnection {
  return {
    async request<T>(request: JsonRpcRequest): Promise<T> {
      requests.push(request)
      if (request.method === 'initialize') {
        return {
          protocolVersion: 1,
          supportedProtocolVersions: [1],
          runtime: { name: 'runtime', version: '1', runtimeId },
          capabilities: {},
        } as T
      }
      return {
        subscriptionId: 'subscription-1',
        nextSequence:
          request.params &&
          typeof request.params === 'object' &&
          'fromSequence' in request.params &&
          typeof request.params.fromSequence === 'number'
            ? request.params.fromSequence
            : 1,
        replaySupported: true,
      } as T
    },
    notifications,
    async close() {},
  }
}

function notification(sequence: number, event: SessionEvent): EventNotification {
  return {
    jsonrpc: '2.0',
    method: 'event',
    params: {
      subscriptionId: 'subscription-1',
      sequence,
      timestamp: new Date(0).toISOString(),
      event,
    },
  }
}

function isTextDelta(event: SessionEvent): event is Extract<SessionEvent, { type: 'text_delta' }> {
  return event.type === 'text_delta'
}
