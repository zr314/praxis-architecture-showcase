import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  type ChatProvider,
  createPromptEnvelope,
  type ProviderMessage,
  promptDigest,
  type SessionRepository,
  type SystemPromptBuild,
} from '@praxis/core-sdk'
import { assertProtocolMessage } from '@praxis/protocol'
import { NdjsonRuntimeBridge } from '../apps/cli/src/bridge/ndjsonBridge.js'
import {
  formatRuntimeInitializationFailure,
  RuntimeKernel,
} from '../apps/runtime/src/framework/runtimeKernel.js'
import {
  terminateProcessTree,
  waitForProcessExit,
} from '../apps/runtime/src/process/processTree.js'
import { createRuntimeKernel } from '../apps/runtime/src/run.js'
import type { RuntimeTraceService } from '../apps/runtime/src/trace/index.js'

const runtimeEntry = fileURLToPath(new URL('../apps/runtime/src/entry.ts', import.meta.url))
const initializeFailureEntry = fileURLToPath(
  new URL('./fixtures/initialize-failure-runtime.ts', import.meta.url),
)

test('Runtime initialization diagnostics render structured errors instead of object coercion', () => {
  assert.equal(
    formatRuntimeInitializationFailure({
      code: 'PERSISTENCE_INVALID_DATA',
      message: 'SessionJournal data is invalid.',
      data: { operation: 'initialize', detail: 'Unsupported V2 Session catalog.' },
    }),
    '[PERSISTENCE_INVALID_DATA] SessionJournal data is invalid. Unsupported V2 Session catalog.',
  )
  assert.equal(
    formatRuntimeInitializationFailure({ unexpected: true }),
    'UNKNOWN_INITIALIZATION_FAILURE',
  )
})

test('Runtime stdout contains only schema-valid protocol messages', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-runtime-stdout-'))
  const child = spawn(process.execPath, ['--import', 'tsx', runtimeEntry], {
    cwd: process.cwd(),
    env: { ...process.env, PRAXIS_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const responses = new Map<
    string,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >()
  const terminal = deferred<void>()
  let terminalEvent: Record<string, unknown> | undefined
  const outputErrors: Error[] = []
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })

  lines.on('line', (line) => {
    try {
      const message: unknown = JSON.parse(line)
      assertProtocolMessage(message)
      if (isRecord(message) && typeof message.id === 'string') {
        const response = responses.get(message.id)
        if (response && 'result' in message) response.resolve(message.result)
        if (response && 'error' in message) response.reject(protocolResponseError(message.error))
      }
      if (isTerminalNotification(message)) {
        terminalEvent = (message as { params: { event: Record<string, unknown> } }).params.event
        terminal.resolve()
      }
    } catch (error) {
      outputErrors.push(error instanceof Error ? error : new Error(String(error)))
      terminal.reject(outputErrors[0])
    }
  })

  let nextId = 1
  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = String(nextId++)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => responses.set(id, { resolve, reject }))
  }

  try {
    await request('initialize', {
      protocolVersion: 1,
      client: { name: 'stdout-test', version: '1' },
      capabilities: { interactivePermissions: true, outputFormats: ['text'] },
    })
    await request('events.subscribe', { sessionId: null, fromSequence: null })
    const session = (await request('session.create', {
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-v1',
    })) as {
      sessionId: string
    }
    await request('session.prompt', {
      sessionId: session.sessionId,
      text: 'stdout cleanliness',
      clientRequestId: 'stdout-test-1',
    })
    await terminal.promise
    await request('shutdown', {})
    assert.deepEqual(outputErrors, [])
    assert.deepEqual(terminalEvent?.usage, {
      turns: 1,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      subagents: 0,
    })
  } finally {
    await terminateProcessTree(child.pid)
    await waitForProcessExit(child, 1_000)
    await rm(home, { recursive: true, force: true })
  }
})

test('failed initialize terminates the spawned Runtime process', async () => {
  const marker = join(tmpdir(), `praxis-init-failure-${Date.now()}.txt`)
  try {
    await assert.rejects(
      NdjsonRuntimeBridge.start(process.execPath, [
        '--import',
        'tsx',
        initializeFailureEntry,
        marker,
      ]),
      /PROTOCOL_VERSION_UNSUPPORTED/,
    )
    await waitFor(() => existsSync(marker))
    const pid = Number.parseInt(readFileSync(marker, 'utf8'), 10)
    await waitFor(() => !isProcessAlive(pid))
  } finally {
    rmSync(marker, { force: true })
  }
})

test('stdin EOF performs a graceful runtime shutdown for a pending permission', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-runtime-eof-'))
  const child = spawn(process.execPath, ['--import', 'tsx', runtimeEntry], {
    cwd: process.cwd(),
    env: { ...process.env, PRAXIS_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const responses = new Map<
    string,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >()
  const events: Array<Record<string, unknown>> = []
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('line', (line) => {
    const message: unknown = JSON.parse(line)
    if (isRecord(message) && typeof message.id === 'string') {
      const response = responses.get(message.id)
      if (response && 'result' in message) response.resolve(message.result)
      if (response && 'error' in message) response.reject(protocolResponseError(message.error))
    }
    if (
      isRecord(message) &&
      message.method === 'event' &&
      isRecord(message.params) &&
      isRecord(message.params.event)
    ) {
      events.push(message.params.event)
    }
  })

  let nextId = 1
  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = String(nextId++)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => responses.set(id, { resolve, reject }))
  }

  try {
    await request('initialize', {
      protocolVersion: 1,
      client: { name: 'eof-test', version: '1' },
      capabilities: { interactivePermissions: true, outputFormats: ['text'] },
    })
    await request('events.subscribe', { sessionId: null, fromSequence: null })
    const session = (await request('session.create', { cwd: process.cwd(), provider: 'mock' })) as {
      sessionId: string
    }
    await request('session.prompt', {
      sessionId: session.sessionId,
      text: `tool:shell ${JSON.stringify({ command: process.platform === 'win32' ? 'Start-Sleep -Seconds 5' : 'sleep 5' })}`,
      clientRequestId: 'eof-test-1',
    })
    await waitFor(() => events.some((event) => event.type === 'permission_request'))

    child.stdin.end()
    const exit = await waitForExit(child)
    assert.equal(exit.code, 0)
    assert.equal(
      events.some(
        (event) => event.type === 'prompt_aborted' && event.reason === 'runtime_shutdown',
      ),
      true,
    )
  } finally {
    await terminateProcessTree(child.pid)
    await waitForProcessExit(child, 1_000)
    await rm(home, { recursive: true, force: true })
  }
})

test('RuntimeKernel keeps the injected SessionRepository as its composition authority', () => {
  const repository = {} as SessionRepository
  const kernel = createRuntimeKernel({ sessionRepository: repository })
  const internals = kernel as unknown as {
    repository: SessionRepository
    sessionService: { repository: SessionRepository }
  }

  assert.equal(internals.repository, repository)
  assert.equal(internals.sessionService.repository, repository)
})

test('RuntimeKernel freezes ContextView within a Run so appended turns keep a stable cache prefix', async () => {
  const kernel = new RuntimeKernel({ sessionRepository: {} as SessionRepository })
  const loop = Reflect.get(kernel, 'loop') as object
  const ports = Reflect.get(loop, 'ports') as {
    selectContext(
      session: object,
      run: object,
      provider: ChatProvider,
      prompt: SystemPromptBuild,
      tools: readonly object[],
    ): Promise<{
      contextMessages?: readonly ProviderMessage[]
      manifest?: { context?: { revision?: number } }
    }>
  }
  const prompt: SystemPromptBuild = {
    instructions: 'Stable policy.',
    contextMessages: [],
    manifest: {
      estimatedTokens: 4,
      maxTokens: 64,
      sections: [],
      program: {
        variant: 'baseline-v1',
        trustedInstructions: {
          id: 'praxis.trusted-instructions',
          version: 'test-v1',
          owner: 'runtime',
          blockCount: 1,
          digest: promptDigest('Stable policy.'),
          estimatedTokens: 4,
          componentIds: ['policy'],
        },
      },
    },
  }
  const provider: ChatProvider = {
    id: 'mock',
    defaultModel: 'mock-model',
    capabilities: {
      streaming: { text: true, reasoning: false, usage: true },
      tools: { mode: 'native', parallelCalls: true },
      modalities: { text: true, vision: false, audio: false },
      output: { jsonSchema: true, citations: false },
      limits: { maxContextTokens: 32_768, maxOutputTokens: 4_096 },
    },
    authState: () => ({ status: 'authenticated' }),
    async *stream() {
      yield { type: 'completed' }
    },
  }
  const messages: ProviderMessage[] = [{ role: 'user', content: 'Start.' }]
  const session = {
    sessionId: 'cache-session',
    cwd: 'D:\\workspace',
    provider: 'mock',
    model: 'mock-model',
    messages,
    memory: { sessionId: 'cache-session' },
  }
  const run = {
    id: 'cache-run',
    envelope: createPromptEnvelope({
      id: 'cache-prompt',
      source: 'user_text',
      effectiveText: 'Start.',
    }),
    promptCapabilitySnapshot: {
      snapshotId: 'cache-capabilities',
      digest: promptDigest('capabilities'),
      toolCount: 0,
    },
    tools: { definitions: () => [] },
  }

  const first = await ports.selectContext(session, run, provider, prompt, [])
  session.messages.push({ role: 'assistant', content: 'Inspecting.' })
  Reflect.set(session.memory, 'plan', {
    objective: 'Changed after the first Provider request.',
    revision: 99,
    updatedAt: '2026-08-09T00:00:00.000Z',
    steps: [],
  })
  const second = await ports.selectContext(session, run, provider, prompt, [])

  assert.equal(first.manifest?.context?.revision, 1)
  assert.equal(second.manifest?.context?.revision, 1)
  assert.deepEqual(second.contextMessages, first.contextMessages)
})

test('Runtime shutdown is bounded and closes the trace gate before final flush', async () => {
  const activeExecution = deferred<void>()
  let gates = 0
  const traceService = {
    createContext: () => ({ traceId: 'trace-1', runtimeId: 'rt-1' }),
    record: async () => {},
    exportTrace: async () => {
      throw new Error('not used')
    },
    beginShutdown: () => {
      gates += 1
    },
    flush: async () => {},
    shutdown: async () => {
      throw new Error('Runtime must gate and flush in separate lifecycle phases.')
    },
  } as RuntimeTraceService & { shutdown(): Promise<void> }
  const kernel = new RuntimeKernel({ traceService })
  const internals = kernel as unknown as {
    activeExecutions: Map<string, Promise<void>>
    performShutdown(): Promise<void>
  }
  internals.activeExecutions.set('run-1', activeExecution.promise)
  const originalSetTimeout = globalThis.setTimeout
  const originalExitCode = process.exitCode
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    if (delay === 2_000) queueMicrotask(callback)
    return { unref() {} }
  }) as unknown as typeof setTimeout

  try {
    const shutdown = internals.performShutdown()
    try {
      await new Promise((resolve) => originalSetTimeout(resolve, 0))
      assert.equal(gates, 1)
    } finally {
      activeExecution.resolve()
      await shutdown.catch(() => undefined)
    }
    assert.equal(process.exitCode, 1)
  } finally {
    process.exitCode = originalExitCode
    globalThis.setTimeout = originalSetTimeout
  }
})

test('Runtime shutdown settles failed persistence before trace and extension cleanup', async () => {
  const lifecycle: string[] = []
  const persistenceFailure = Promise.reject(new Error('persistence failed'))
  const remainingPersistence = deferred<void>()
  void persistenceFailure.catch(() => undefined)
  const kernel = new RuntimeKernel({
    extensions: shutdownExtensions(lifecycle),
    traceService: shutdownTraceService(lifecycle),
  })
  const internals = kernel as unknown as {
    pendingPersistence: Set<Promise<void>>
    performShutdown(): Promise<void>
  }
  internals.pendingPersistence.add(persistenceFailure)
  internals.pendingPersistence.add(remainingPersistence.promise)
  const originalSetTimeout = globalThis.setTimeout
  const originalExitCode = process.exitCode
  globalThis.setTimeout = (() => ({ unref() {} })) as unknown as typeof setTimeout

  try {
    const shutdown = internals.performShutdown()
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(lifecycle, ['trace.beginShutdown'])
    remainingPersistence.resolve()
    await shutdown
    assert.deepEqual(lifecycle, ['trace.beginShutdown', 'trace.flush', 'extensions.shutdown'])
    assert.equal(process.exitCode, 1)
  } finally {
    process.exitCode = originalExitCode
    globalThis.setTimeout = originalSetTimeout
  }
})

test('Runtime shutdown still cleans up extensions when final trace flush fails', async () => {
  const lifecycle: string[] = []
  const kernel = new RuntimeKernel({
    extensions: shutdownExtensions(lifecycle),
    traceService: shutdownTraceService(lifecycle, new Error('trace flush failed')),
  })
  const internals = kernel as unknown as { performShutdown(): Promise<void> }
  const originalSetTimeout = globalThis.setTimeout
  const originalExitCode = process.exitCode
  globalThis.setTimeout = (() => ({ unref() {} })) as unknown as typeof setTimeout

  try {
    await internals.performShutdown()
    assert.deepEqual(lifecycle, ['trace.beginShutdown', 'trace.flush', 'extensions.shutdown'])
    assert.equal(process.exitCode, 1)
  } finally {
    process.exitCode = originalExitCode
    globalThis.setTimeout = originalSetTimeout
  }
})

function isTerminalNotification(message: unknown): boolean {
  if (!isRecord(message) || message.method !== 'event' || !isRecord(message.params)) return false
  const event = message.params.event
  return (
    isRecord(event) &&
    ['prompt_completed', 'prompt_failed', 'prompt_aborted'].includes(String(event.type))
  )
}

function shutdownTraceService(
  lifecycle: string[],
  failure?: Error,
): RuntimeTraceService & { shutdown(): Promise<void> } {
  return {
    createContext: () => ({ traceId: 'trace-1', runtimeId: 'rt-1' }),
    record: async () => {},
    exportTrace: async () => {
      throw new Error('not used')
    },
    beginShutdown: () => {
      lifecycle.push('trace.beginShutdown')
    },
    flush: async () => {
      lifecycle.push('trace.flush')
      if (failure) throw failure
    },
    shutdown: async () => {
      throw new Error('not used')
    },
  }
}

function shutdownExtensions(lifecycle: string[]) {
  return {
    initialize: async () => {
      throw new Error('not used')
    },
    provider: async () => undefined,
    providerIds: () => [],
    shutdown: async () => {
      lifecycle.push('extensions.shutdown')
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function protocolResponseError(value: unknown): Error {
  if (!isRecord(value)) return new Error('Runtime returned an invalid protocol error.')
  const code = typeof value.code === 'string' ? value.code : 'RUNTIME_REQUEST_FAILED'
  const message = typeof value.message === 'string' ? value.message : 'Runtime request failed.'
  return new Error(`${code}: ${message}`)
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  return {
    promise: new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    }),
    resolve,
    reject,
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 40; attempts += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for Runtime process cleanup.')
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
      child.once('error', reject)
    }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for Runtime EOF shutdown.')), 4_000),
    ),
  ])
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}
