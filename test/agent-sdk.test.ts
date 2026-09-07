import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  CreateSessionInput,
  PermissionDecision,
  PromptInput,
  SessionEvent,
  SessionInfo,
} from '@praxis/protocol'
import { SystemPromptComposer } from '../apps/runtime/src/prompt/systemPromptComposer.js'
import { type AgentClient, type AgentRunResult, defineAgent } from '../packages/client/src/index.js'

test('defineAgent runs a typed application Agent through middleware and permission hooks', async () => {
  const client = new ScriptedAgentClient()
  const lifecycle: string[] = []
  const agent = defineAgent<{ attempts: number }, { answer: number }>({
    client,
    name: 'calculator',
    instructions: 'Return a JSON object with the computed answer.',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-v1',
    plannerMode: 'auto',
    initialState: () => ({ attempts: 0 }),
    metadata: { owner: 'sdk-test' },
    middleware: [
      {
        name: 'application-policy',
        beforeRun(context) {
          lifecycle.push('before')
          return {
            input: `${context.input} Respond as JSON.`,
            state: { attempts: context.state.attempts + 1 },
            metadata: { requestKind: 'calculation' },
          }
        },
        onEvent(_context, event) {
          lifecycle.push(`event:${event.type}`)
        },
        onPermissionRequest() {
          lifecycle.push('permission')
          return { type: 'allow_once' }
        },
        afterRun(_context, result) {
          lifecycle.push('after')
          return Object.freeze({
            ...result,
            metadata: Object.freeze({ ...result.metadata, reviewed: true }),
          })
        },
      },
    ],
    parseOutput: (text) => JSON.parse(text) as { answer: number },
  })

  const result = await agent.run('Calculate 6 * 7.')

  assert.deepEqual(client.created, {
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-v1',
    plannerMode: 'auto',
    name: 'calculator',
  })
  assert.equal(client.prompted?.text, 'Calculate 6 * 7. Respond as JSON.')
  assert.deepEqual(client.prompted?.agent, {
    name: 'calculator',
    instructions: 'Return a JSON object with the computed answer.',
  })
  assert.deepEqual(client.decisions, [['permission-1', { type: 'allow_once' }]])
  assert.deepEqual(result, {
    sessionId: 'session-new',
    runId: 'run-1',
    status: 'completed',
    text: '{"answer":42}',
    output: { answer: 42 },
    state: { attempts: 1 },
    metadata: {
      owner: 'sdk-test',
      requestKind: 'calculation',
      reviewed: true,
    },
    usage: { inputTokens: 10, outputTokens: 4 },
    stopReason: 'end_turn',
  } satisfies AgentRunResult<{ answer: number }, { attempts: number }>)
  assert.deepEqual(lifecycle, [
    'before',
    'event:prompt_started',
    'event:permission_request',
    'permission',
    'event:text_delta',
    'event:text_delta',
    'event:prompt_completed',
    'after',
  ])
})

test('resumed Agent sessions use follow-up and preserve the bound session id', async () => {
  const client = new ScriptedAgentClient()
  const agent = defineAgent({ client, cwd: 'D:/workspace' })
  const session = await agent.resume('session-existing')

  const result = await session.run('Continue the task.')

  assert.equal(session.sessionId, 'session-existing')
  assert.equal(client.resumed.at(-1), 'session-existing')
  assert.equal(client.followedUp?.sessionId, 'session-existing')
  assert.equal(client.followedUp?.text, 'Continue the task.')
  assert.equal(result.status, 'completed')
})

test('Agent AbortSignal aborts the active Runtime Run', async () => {
  const controller = new AbortController()
  const client = new ScriptedAgentClient({ waitForAbort: true })
  const agent = defineAgent({
    client,
    cwd: 'D:/workspace',
    middleware: [
      {
        onEvent(_context, event) {
          if (event.type === 'prompt_started') controller.abort('test_abort')
        },
      },
    ],
  })

  const result = await agent.run({ input: 'Wait for cancellation.', signal: controller.signal })

  assert.deepEqual(client.aborted, ['run-1'])
  assert.equal(result.status, 'aborted')
  assert.equal(result.runId, 'run-1')
})

test('Agent SDK fails clearly instead of racing two streams on one client', async () => {
  const client = new ScriptedAgentClient({ waitForAbort: true })
  const agent = defineAgent({ client, cwd: 'D:/workspace' })
  const first = agent.stream('First Run.')

  const started = await first.next()
  assert.equal(started.done, false)
  await assert.rejects(() => agent.run('Concurrent Run.'), {
    name: 'AgentClientBusyError',
  })

  await agent.abort('run-1')
  while (!(await first.next()).done) {
    // Drain the terminal event so the generator releases the client lease.
  }
  assert.equal((await agent.run('Run after release.')).status, 'aborted')
})

test('Agent SDK permits concurrent Runs when the client exposes multiplexing', async () => {
  const client = new ConcurrentAgentClient()
  const agent = defineAgent({ client, cwd: 'D:/workspace' })

  const [first, second] = await Promise.all([agent.run('First Run.'), agent.run('Second Run.')])

  assert.deepEqual(
    [first, second].map(({ status, text }) => ({ status, text })),
    [
      { status: 'completed', text: 'answer:session-concurrent-1' },
      { status: 'completed', text: 'answer:session-concurrent-2' },
    ],
  )
})

test('Agent SDK forwards planPolicy and returns prompt_blocked as a terminal result', async () => {
  let promptInput: PromptInput | undefined
  const events = async function* (input: PromptInput): AsyncIterable<SessionEvent> {
    promptInput = input
    yield {
      type: 'prompt_started',
      sessionId: input.sessionId,
      runId: 'run-blocked',
      prompt: input.text,
    }
    yield {
      type: 'prompt_blocked',
      runId: 'run-blocked',
      code: 'PLAN_REVIEW_REQUIRED',
      reason: 'Final Review has not been accepted.',
      recoverable: true,
    }
  }
  const client: AgentClient = {
    createSession: async () => session('session-blocked'),
    resumeSession: async (sessionId) => session(sessionId),
    prompt: events,
    followUp: events,
    decidePermission: async () => undefined,
    abort: async () => undefined,
  }
  const agent = defineAgent({ client, cwd: 'D:/workspace' })

  const result = await agent.run({ input: 'Do reviewed work.', planPolicy: 'required' })

  assert.equal(promptInput?.planPolicy, 'required')
  assert.equal(result.status, 'blocked')
  assert.deepEqual(result.error, {
    code: 'PLAN_REVIEW_REQUIRED',
    message: 'Final Review has not been accepted.',
  })
})

test('application instructions stay below Runtime policy in both prompt programs', () => {
  for (const variant of ['baseline-v1', 'iron-law-lean-v1'] as const) {
    const build = new SystemPromptComposer().compose({
      workspace: { cwd: 'D:/workspace', platform: 'win32', shell: 'powershell' },
      tools: [],
      variant,
      application: {
        name: 'reviewer',
        instructions: 'Review changes and return concise JSON.',
      },
      maxSystemPromptTokens: 4_096,
    })
    assert.match(build.instructions, /Runtime-enforced permissions|Runtime permission decisions/u)
    assert.match(build.instructions, /# Application Agent: reviewer/u)
    assert.match(build.instructions, /Review changes and return concise JSON/u)
    assert.ok(
      build.instructions.indexOf('Runtime') < build.instructions.indexOf('# Application Agent'),
    )
  }
})

class ScriptedAgentClient implements AgentClient {
  created?: CreateSessionInput
  prompted?: PromptInput
  followedUp?: PromptInput
  readonly resumed: string[] = []
  readonly decisions: Array<[string, PermissionDecision]> = []
  readonly aborted: string[] = []
  readonly #waitForAbort: boolean
  #releaseAbort?: () => void
  #abortRequested = false

  constructor(options: { waitForAbort?: boolean } = {}) {
    this.#waitForAbort = options.waitForAbort ?? false
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    this.created = input
    return session('session-new')
  }

  async resumeSession(sessionId: string): Promise<SessionInfo> {
    this.resumed.push(sessionId)
    return session(sessionId)
  }

  prompt(input: PromptInput): AsyncIterable<SessionEvent> {
    this.prompted = input
    return this.events(input.sessionId)
  }

  followUp(input: PromptInput): AsyncIterable<SessionEvent> {
    this.followedUp = input
    return this.events(input.sessionId)
  }

  async decidePermission(requestId: string, decision: PermissionDecision): Promise<void> {
    this.decisions.push([requestId, decision])
  }

  async abort(runId: string): Promise<void> {
    this.aborted.push(runId)
    this.#abortRequested = true
    this.#releaseAbort?.()
  }

  private async *events(sessionId: string): AsyncIterable<SessionEvent> {
    yield {
      type: 'prompt_started',
      sessionId,
      runId: 'run-1',
      prompt: 'prompt',
    }
    if (this.#waitForAbort) {
      if (!this.#abortRequested) {
        await new Promise<void>((resolve) => {
          this.#releaseAbort = resolve
        })
      }
      yield { type: 'prompt_aborted', runId: 'run-1', reason: 'user_abort' }
      return
    }
    yield {
      type: 'permission_request',
      runId: 'run-1',
      requestId: 'permission-1',
      toolCallId: 'tool-call-1',
      tool: 'read',
      input: { path: 'README.md' },
    }
    yield { type: 'text_delta', runId: 'run-1', text: '{"answer":' }
    yield { type: 'text_delta', runId: 'run-1', text: '42}' }
    yield {
      type: 'prompt_completed',
      runId: 'run-1',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 4 },
    }
  }
}

class ConcurrentAgentClient implements AgentClient {
  readonly supportsConcurrentRuns = true
  #nextSession = 1
  #started = 0
  #release?: () => void
  readonly #bothStarted = new Promise<void>((resolve) => {
    this.#release = resolve
  })

  async createSession(): Promise<SessionInfo> {
    return session(`session-concurrent-${this.#nextSession++}`)
  }

  async resumeSession(sessionId: string): Promise<SessionInfo> {
    return session(sessionId)
  }

  prompt(input: PromptInput): AsyncIterable<SessionEvent> {
    return this.events(input.sessionId)
  }

  followUp(input: PromptInput): AsyncIterable<SessionEvent> {
    return this.events(input.sessionId)
  }

  async decidePermission(): Promise<void> {}

  async abort(): Promise<void> {}

  private async *events(sessionId: string): AsyncIterable<SessionEvent> {
    const runId = `run:${sessionId}`
    yield { type: 'prompt_started', sessionId, runId, prompt: 'prompt' }
    this.#started += 1
    if (this.#started === 2) this.#release?.()
    await this.#bothStarted
    yield { type: 'text_delta', runId, text: `answer:${sessionId}` }
    yield { type: 'prompt_completed', runId }
  }
}

function session(sessionId: string): SessionInfo {
  return {
    sessionId,
    state: 'idle',
    cwd: 'D:/workspace',
    provider: 'mock',
    model: 'mock-v1',
  }
}
