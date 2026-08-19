import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CancellationTree,
  type ProviderChunk,
  type ProviderRequest,
  runtimeError,
} from '@praxis/core-sdk'
import { OpenAIResponsesProvider } from '../apps/runtime/src/providers/openAIResponsesProvider.js'
import { InMemorySubagentAdmissionLedger } from '../apps/runtime/src/subagent/admission.js'
import {
  CHILD_BOOTSTRAP_METHODS,
  type ChildBootstrapMethod,
} from '../apps/runtime/src/subagent/childBootstrapProfile.js'
import type { ChildCredentialGrant } from '../apps/runtime/src/subagent/childCapabilityBundle.js'
import {
  ChildRuntimeHost,
  type ChildRuntimeRun,
  type ChildRuntimeTraceEventV1,
} from '../apps/runtime/src/subagent/childRuntimeHost.js'
import {
  ChildBrokeredProvider,
  ChildCredentialBrokerIpcServer,
} from '../apps/runtime/src/subagent/credentialBrokerIpc.js'
import {
  ChildCredentialDelegationService,
  type CredentialBrokerTraceEvent,
  InMemoryChildCredentialBroker,
} from '../apps/runtime/src/subagent/credentialDelegation.js'
import { mockChildCapabilityBundle } from './support/child-capability.js'

const runtimeEntry = fileURLToPath(new URL('../apps/runtime/src/entry.ts', import.meta.url))
const target = { providerId: 'openai', model: 'gpt-5.2' } as const
const OPENAI_SECRET = 'sk-parent-only-openai-secret'
const OTHER_PROVIDER_SECRET = 'sk-parent-only-anthropic-secret'

test('authenticated OpenAI child uses a parent broker, a read-only Tool, and real usage', async () => {
  const harness = await providerHarness('success')
  try {
    const result = await harness.host.run(harness.execution)

    assert.equal(
      result.status,
      'succeeded',
      JSON.stringify({
        result,
        brokerTrace: harness.brokerTrace,
      }),
    )
    assert.match(result.summary, /authenticated child read completed/iu)
    assert.deepEqual(result.usage, {
      turns: 2,
      toolCalls: 2,
      inputTokens: 9,
      outputTokens: 4,
      subagents: 0,
    })
    assert.equal(harness.authorizationHeaders.length, 2)
    assert.ok(harness.authorizationHeaders.every((header) => header === `Bearer ${OPENAI_SECRET}`))
    assert.equal(await exists(harness.execution.bootstrapProfile.ephemeral.root), false)
    assert.equal(await readFile(harness.durableCredentialPath, 'utf8'), OTHER_PROVIDER_SECRET)

    const childVisible = JSON.stringify({
      result,
      profile: harness.execution.bootstrapProfile,
      launch: harness.execution.launch,
      runtimeTrace: harness.runtimeTrace,
      brokerTrace: harness.brokerTrace,
    })
    assert.doesNotMatch(childVisible, /sk-parent-only/u)
    assert.equal(childVisible.includes(harness.handleId), true)
    assert.equal(JSON.stringify(harness.brokerTrace).includes(harness.handleId), false)
    assert.deepEqual(
      harness.brokerTrace
        .filter((event) => event.type === 'credential_broker_completed')
        .map((event) => event.usage),
      [
        { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
        { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
      ],
    )
  } finally {
    await harness.cleanup()
  }
})

test('authenticated child fails closed for missing, revoked, expired, wrong-model, and secret-bearing Provider failures', async () => {
  for (const mode of ['missing', 'revoked', 'wrong-model', 'secret-error'] as const) {
    const harness = await providerHarness(mode)
    try {
      const result = await harness.host.run(harness.execution)
      assert.equal(result.status, 'failed', mode)
      assert.equal(
        result.error?.code,
        {
          missing: 'CHILD_CREDENTIAL_HANDLE_UNKNOWN',
          revoked: 'CHILD_CREDENTIAL_REVOKED',
          'wrong-model': 'CHILD_CREDENTIAL_SCOPE_MISMATCH',
          'secret-error': 'CHILD_CREDENTIAL_PROVIDER_FAILED',
        }[mode],
        mode,
      )
      assert.equal(
        JSON.stringify({ result, trace: harness.runtimeTrace }).includes(OPENAI_SECRET),
        false,
      )
      if (mode === 'secret-error') {
        assert.equal(await exists(harness.execution.bootstrapProfile.ephemeral.root), false)
      }
    } finally {
      await harness.cleanup()
    }
  }

  const expired = await providerHarness('expired')
  try {
    await assert.rejects(expired.host.run(expired.execution), (error: unknown) =>
      hasCode(error, 'CHILD_RUNTIME_EXITED'),
    )
    assert.equal(JSON.stringify(expired.runtimeTrace).includes(OPENAI_SECRET), false)
  } finally {
    await expired.cleanup()
  }
})

test('parent cancellation aborts the active brokered Provider and settles once', async () => {
  const harness = await providerHarness('cancel')
  try {
    const active = harness.host.run(harness.execution)
    await harness.providerStarted
    assert.deepEqual(harness.host.cancel('provider-child', 'parent_cancelled'), [
      ['provider-child', 'parent_cancelled'],
    ])
    assert.deepEqual(harness.host.cancel('provider-child', 'parent_cancelled'), [])
    const result = await active
    assert.equal(result.status, 'cancelled')
    assert.equal(result.error?.code, 'CHILD_PARENT_CANCELLED')
    assert.equal(harness.ledger.scope('provider-parent')?.activeChildren, 0)
    assert.equal(harness.ledger.scope('provider-parent')?.chargedChildRuns, 1)
    assert.equal(await exists(harness.execution.bootstrapProfile.ephemeral.root), false)
  } finally {
    await harness.cleanup()
  }
})

test('broker IPC rejects unknown Provider chunk fields without forwarding their content', async () => {
  const sent: unknown[] = []
  const server = new ChildCredentialBrokerIpcServer({
    parentRunId: 'provider-parent',
    childRunId: 'provider-child',
    target,
    handleId: 'cbh-private-channel',
    broker: {
      async *invoke() {
        yield {
          type: 'message_start',
          unexpectedSecret: OPENAI_SECRET,
        } as ProviderChunk
      },
    },
  })
  server.attach(async (message) => {
    sent.push(message)
  })
  server.receive({
    schemaVersion: 1,
    type: 'credential_broker.invoke',
    requestId: 'cbreq-boundary',
    request: {
      model: target.model,
      messages: [{ role: 'user', content: 'bounded request' }],
      tools: [],
    },
  })
  await waitFor(() => sent.length === 1)
  assert.deepEqual(sent, [
    {
      schemaVersion: 1,
      type: 'credential_broker.failed',
      requestId: 'cbreq-boundary',
      sequence: 0,
      errorCode: 'CHILD_CREDENTIAL_INVALID',
    },
  ])
  assert.equal(JSON.stringify(sent).includes(OPENAI_SECRET), false)
  server.close()
})

test('broker IPC carries standalone native compaction without exposing credentials', async () => {
  let server!: ChildCredentialBrokerIpcServer
  const childProcess = Object.assign(new EventEmitter(), {
    connected: true,
    send(message: unknown) {
      server.receive(message)
      return true
    },
  })
  server = new ChildCredentialBrokerIpcServer({
    parentRunId: 'provider-parent',
    childRunId: 'provider-child',
    target,
    handleId: 'cbh-private-channel',
    broker: {
      async *invoke() {
        return
      },
      async compact(input) {
        assert.equal(input.request.model, target.model)
        return {
          format: 'openai.responses.compact.v1',
          items: [
            {
              type: 'compaction',
              encrypted_content: `opaque-${'x'.repeat(128 * 1024)}`,
            },
          ],
          usage: { inputTokens: 12, outputTokens: 3 },
        }
      },
    },
  })
  server.attach(async (message) => {
    childProcess.emit('message', message)
  })
  const provider = new ChildBrokeredProvider({
    target,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    capabilities: {
      streaming: { text: true, reasoning: true, usage: true },
      tools: { mode: 'native', parallelCalls: true },
      modalities: { text: true, vision: false, audio: false },
      output: { jsonSchema: true, citations: false },
      limits: { maxContextTokens: 256_000 },
    },
    process: childProcess as never,
  })

  const compact = provider.compact
  assert.ok(compact)
  const result = await compact({
    model: target.model,
    messages: [{ role: 'user', content: 'compact this child context' }],
    tools: [],
    signal: new AbortController().signal,
  })
  assert.equal(result.format, 'openai.responses.compact.v1')
  assert.equal(result.items[0]?.type, 'compaction')
  assert.equal(JSON.stringify(result).includes(OPENAI_SECRET), false)
  provider.close()
  server.close()
})

test('broker IPC carries long Child contexts without a whole-envelope byte ceiling', async () => {
  const sent: unknown[] = []
  const childProcess = Object.assign(new EventEmitter(), {
    connected: true,
    send(message: unknown) {
      sent.push(message)
      return true
    },
  })
  const provider = new ChildBrokeredProvider({
    target,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    capabilities: {
      streaming: { text: true, reasoning: true, usage: true },
      tools: { mode: 'native', parallelCalls: true },
      modalities: { text: true, vision: false, audio: false },
      output: { jsonSchema: true, citations: false },
      limits: { maxContextTokens: 256_000 },
    },
    process: childProcess as never,
  })
  const request = (bytes: number): ProviderRequest => ({
    model: target.model,
    messages: [{ role: 'user', content: 'x'.repeat(bytes) }],
    tools: [],
    signal: new AbortController().signal,
  })
  const iterator = provider.stream(request(300 * 1024))[Symbol.asyncIterator]()
  const pending = iterator.next()
  await waitFor(() => sent.length === 1)
  assert.ok(Buffer.byteLength(JSON.stringify(sent[0]), 'utf8') > 256 * 1024)
  provider.close()
  await assert.rejects(pending, (error: unknown) => hasCode(error, 'CHILD_CREDENTIAL_CANCELLED'))

  const large = new ChildBrokeredProvider({
    target,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    capabilities: provider.capabilities,
    process: childProcess as never,
  })
  const largePending = large
    .stream(request(5 * 1024 * 1024))
    [Symbol.asyncIterator]()
    .next()
  await waitFor(() => sent.length === 2)
  assert.ok(Buffer.byteLength(JSON.stringify(sent[1]), 'utf8') > 5 * 1024 * 1024)
  large.close()
  await assert.rejects(largePending, (error: unknown) =>
    hasCode(error, 'CHILD_CREDENTIAL_CANCELLED'),
  )
})

test('child credential broker retries upstream 429 before output and preserves its classification', async () => {
  let calls = 0
  const broker = new InMemoryChildCredentialBroker({
    provider: {
      async *stream() {
        calls += 1
        if (calls < 3) throw Object.assign(new Error('rate limited'), { status: 429 })
        yield {
          type: 'completed',
          stopReason: 'end_turn',
          usage: { inputTokens: 2, outputTokens: 3 },
        }
      },
    },
    maxProviderAttempts: 3,
    retryBaseDelayMs: 0,
  })
  const invocation = brokerInvocation(broker)

  const chunks: ProviderChunk[] = []
  for await (const chunk of broker.invoke(invocation)) chunks.push(chunk)

  assert.equal(calls, 3)
  assert.deepEqual(chunks, [
    {
      type: 'completed',
      stopReason: 'end_turn',
      usage: { inputTokens: 2, outputTokens: 3 },
    },
  ])
})

test('child credential broker authorizes and charges standalone compaction', async () => {
  const broker = new InMemoryChildCredentialBroker({
    provider: {
      async *stream() {
        return
      },
      async compact(candidate, request) {
        assert.deepEqual(candidate, target)
        assert.equal(request.model, target.model)
        return {
          format: 'openai.responses.compact.v1',
          items: [{ type: 'compaction', encrypted_content: 'opaque' }],
          usage: { inputTokens: 4, outputTokens: 1 },
        }
      },
    },
  })
  const invocation = brokerInvocation(broker)

  const result = await broker.compact(invocation)
  assert.equal(result.items[0]?.type, 'compaction')
  await assert.rejects(broker.compact(invocation), (error: unknown) =>
    hasCode(error, 'CHILD_CREDENTIAL_REPLAYED'),
  )
})

test('child credential broker maps exhausted 5xx to a retryable bounded failure', async () => {
  let calls = 0
  const broker = new InMemoryChildCredentialBroker({
    provider: {
      async *stream() {
        calls += 1
        throw Object.assign(new Error('upstream unavailable'), { status: 503 })
      },
    },
    maxProviderAttempts: 2,
    retryBaseDelayMs: 0,
  })
  const invocation = brokerInvocation(broker)

  await assert.rejects(
    async () => {
      for await (const _chunk of broker.invoke(invocation)) {
        // No chunks are expected before the classified upstream failure.
      }
    },
    (error: unknown) =>
      hasCode(error, 'CHILD_CREDENTIAL_PROVIDER_UNAVAILABLE') &&
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'retryable') === true,
  )
  assert.equal(calls, 2)
})

test('child credential broker preserves a non-retryable Provider account failure', async () => {
  const broker = new InMemoryChildCredentialBroker({
    provider: {
      async *stream() {
        throw Object.assign(new Error('redacted account failure'), { status: 402 })
      },
    },
  })
  const invocation = brokerInvocation(broker)

  await assert.rejects(
    async () => {
      for await (const _chunk of broker.invoke(invocation)) {
        // The account failure occurs before any Provider output.
      }
    },
    (error: unknown) =>
      hasCode(error, 'CHILD_CREDENTIAL_PROVIDER_ACCOUNT_UNAVAILABLE') &&
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'retryable') === false,
  )
})

test('child credential retry does not exceed the delegated deadline budget', async () => {
  let calls = 0
  const now = Date.now()
  const broker = new InMemoryChildCredentialBroker({
    provider: {
      async *stream() {
        calls += 1
        throw Object.assign(new Error('rate limited'), { status: 429 })
      },
    },
    now: () => now,
    maxProviderAttempts: 3,
    retryBaseDelayMs: 10,
  })
  const invocation = brokerInvocation(broker, new Date(now + 1).toISOString())

  await assert.rejects(
    async () => {
      for await (const _chunk of broker.invoke(invocation)) {
        // No chunks are expected before the classified upstream failure.
      }
    },
    (error: unknown) => hasCode(error, 'CHILD_CREDENTIAL_RATE_LIMITED'),
  )
  assert.equal(calls, 1)
})

const liveOpenAiKey = process.env.OPENAI_API_KEY
const liveSmokeEnabled =
  process.env.PRAXIS_RUN_AUTHENTICATED_CHILD_SMOKE === '1' && liveOpenAiKey !== undefined

test('optional local authenticated OpenAI child network smoke', {
  skip: liveSmokeEnabled ? false : 'Set the explicit smoke flag and OPENAI_API_KEY.',
}, async () => {
  const harness = await providerHarness('success', { apiKey: liveOpenAiKey! })
  try {
    const result = await harness.host.run(harness.execution)
    assert.equal(result.status, 'succeeded', JSON.stringify(result))
    assert.equal((result.usage.inputTokens ?? 0) > 0, true)
    assert.equal((result.usage.outputTokens ?? 0) > 0, true)
    assert.equal(
      JSON.stringify({
        result,
        profile: harness.execution.bootstrapProfile,
        trace: harness.runtimeTrace,
      }).includes(liveOpenAiKey!),
      false,
    )
  } finally {
    await harness.cleanup()
  }
})

type HarnessMode =
  | 'success'
  | 'missing'
  | 'revoked'
  | 'expired'
  | 'wrong-model'
  | 'secret-error'
  | 'cancel'

async function providerHarness(mode: HarnessMode, live?: { apiKey: string }) {
  const home = await mkdtemp(join(tmpdir(), `praxis-authenticated-child-${mode}-`))
  const durableCredentialPath = join(home, 'credentials.json')
  await writeFile(durableCredentialPath, OTHER_PROVIDER_SECRET, 'utf8')
  const authorizationHeaders: string[] = []
  let releaseProviderStarted!: () => void
  const providerStarted = new Promise<void>((resolveStarted) => {
    releaseProviderStarted = resolveStarted
  })
  let providerCalls = 0
  const providerSecret = live?.apiKey ?? OPENAI_SECRET
  const fixtureFetch = async (_input: string | URL | Request, init?: RequestInit) => {
    authorizationHeaders.push(new Headers(init?.headers).get('authorization') ?? '')
    if (mode === 'cancel') {
      releaseProviderStarted()
      return new Promise<Response>((_resolveResponse, rejectResponse) => {
        init?.signal?.addEventListener(
          'abort',
          () => rejectResponse(new Error('fixture provider aborted')),
          { once: true },
        )
      })
    }
    if (mode === 'secret-error') throw new Error(`Provider rejected ${OPENAI_SECRET}`)
    const response =
      providerCalls++ === 0
        ? sseResponse([
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { type: 'function_call', call_id: 'read-call', name: 'read' },
            },
            {
              type: 'response.function_call_arguments.delta',
              output_index: 0,
              delta: '{"path":"package.json","limit":5}',
            },
            {
              type: 'response.completed',
              response: { usage: { input_tokens: 5, output_tokens: 1 } },
            },
          ])
        : sseResponse([
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: {
                type: 'function_call',
                call_id: 'submit-child-result',
                name: 'praxis_submit_child_result',
              },
            },
            {
              type: 'response.function_call_arguments.delta',
              output_index: 0,
              delta: JSON.stringify({
                summary: 'Authenticated child read completed.',
                criteria: [
                  {
                    id: 'provider-read',
                    status: 'passed',
                    summary: 'Return the read result.',
                  },
                ],
              }),
            },
            {
              type: 'response.completed',
              response: { usage: { input_tokens: 4, output_tokens: 3 } },
            },
          ])
    return response
  }
  const provider = new OpenAIResponsesProvider({
    apiKey: providerSecret,
    defaultModel: target.model,
    ...(live === undefined ? { fetch: fixtureFetch } : {}),
  })
  const brokerTrace: CredentialBrokerTraceEvent[] = []
  const broker = new InMemoryChildCredentialBroker({
    provider: {
      stream(candidate, request: ProviderRequest) {
        if (candidate.providerId !== provider.id) {
          throw runtimeError('PROVIDER_NOT_FOUND', 'provider', 'Provider is unavailable.')
        }
        return provider.stream(request)
      },
    },
    trace: (event) => {
      brokerTrace.push(event)
    },
  })
  const delegation = new ChildCredentialDelegationService({ broker })
  const deadlineAt = new Date(Date.now() + 60_000).toISOString()
  const issued = await delegation.delegate({
    parentRunId: 'provider-parent',
    childRunId: 'provider-child',
    target,
    deadlineAt,
    maxTokens: 100,
  })
  assert.equal(issued.kind, 'broker_handle')
  if (issued.kind !== 'broker_handle') throw new Error('Expected broker handle fixture.')
  const handleId = issued.handleId
  if (mode === 'revoked') broker.revokeHandle(handleId)

  const selectedTarget =
    mode === 'wrong-model' ? ({ providerId: 'openai', model: 'gpt-5.1' } as const) : target
  const credential: ChildCredentialGrant =
    mode === 'expired'
      ? {
          kind: 'broker_handle',
          handleId,
          expiresAt: '2025-01-01T00:00:00.000Z',
        }
      : issued
  const bundle = mockChildCapabilityBundle({
    workspace: resolve(process.cwd()),
    methods: CHILD_BOOTSTRAP_METHODS,
    toolNames: ['read'],
    provider: selectedTarget,
    credential,
  })
  const ephemeralRoot = join(home, 'ephemeral')
  const execution: ChildRuntimeRun = {
    packet: {
      schemaVersion: 1,
      packetId: `provider-packet-${mode}`,
      parentRunId: 'provider-parent',
      childRunId: 'provider-child',
      objective: 'Read the workspace package manifest with the authenticated Provider.',
      step: {
        stepId: 'provider-step',
        title: 'Read manifest',
        instructions: 'Read package.json with the granted Tool, then report completion.',
      },
      constraints: ['Use only the signed Provider and read-only Tool grant.'],
      relevantRefs: [],
      successCriteria: [{ id: 'provider-read', description: 'Return the read result.' }],
      workspace: { root: resolve(process.cwd()), access: 'read_only' },
      grant: {
        bundleId: bundle.bundleId,
        bundleDigest: bundle.digest,
        provider: selectedTarget,
        tools: ['read'],
        skills: [],
        methods: [...bundle.methodAllowlist],
        mcpMode: 'disabled',
      },
      budget: {
        maxTurns: 3,
        maxToolCalls: 2,
        maxTokens: 100,
        maxChildRuns: 0,
        maxParallelChildren: 0,
        maxDepth: 0,
        deadlineAt,
      },
      prohibitions: ['Do not write.', 'Do not inspect credentials or environment variables.'],
      outputSchema: {
        format: 'json',
        schema: { type: 'object' },
        maxInlineBytes: 4_096,
        overflow: 'artifact_ref',
      },
    },
    parentUsage: { turns: 0, toolCalls: 0 },
    launch: {
      command: process.execPath,
      args: ['--import', 'tsx', runtimeEntry],
      cwd: process.cwd(),
    },
    bootstrapProfile: {
      schemaVersion: 3,
      workspace: { root: resolve(process.cwd()), access: 'read_only' },
      methodAllowlist: CHILD_BOOTSTRAP_METHODS as readonly ChildBootstrapMethod[],
      ephemeral: {
        root: ephemeralRoot,
        sessionRoot: join(ephemeralRoot, 'sessions'),
        traceRoot: join(ephemeralRoot, 'traces'),
        artifactRoot: join(ephemeralRoot, 'artifacts'),
        retention: 'delete',
      },
      provider: selectedTarget,
      capabilityBundleDigest: bundle.digest,
      capabilityBundle: bundle,
      deadlineAt,
      trace: { traceId: `trace-provider-${mode}`, parentTraceId: 'trace-provider-parent' },
    },
  }
  const ledger = new InMemorySubagentAdmissionLedger()
  ledger.registerRootScope({
    runId: 'provider-parent',
    budget: {
      maxTurns: 6,
      maxToolCalls: 4,
      maxTokens: 200,
      maxChildRuns: 1,
      maxParallelChildren: 1,
      maxDepth: 1,
    },
  })
  const runtimeTrace: ChildRuntimeTraceEventV1[] = []
  const host = new ChildRuntimeHost({
    ledger,
    cancellation: new CancellationTree(),
    handshakeTimeoutMs: 20_000,
    environment: {
      ...process.env,
      OPENAI_API_KEY: providerSecret,
      ANTHROPIC_API_KEY: OTHER_PROVIDER_SECRET,
      PRAXIS_HOME: home,
    },
    credentialDelegation: delegation,
    ...(mode === 'missing' ? {} : { credentialBroker: broker }),
    trace: {
      record: (event) => {
        runtimeTrace.push(event)
      },
    },
  })

  return {
    host,
    ledger,
    execution,
    handleId,
    providerStarted,
    authorizationHeaders,
    durableCredentialPath,
    brokerTrace,
    runtimeTrace,
    cleanup: () => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  }
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function brokerInvocation(
  broker: InMemoryChildCredentialBroker,
  deadlineAt = new Date(Date.now() + 60_000).toISOString(),
) {
  const grant = broker.issue({
    parentRunId: 'retry-parent',
    childRunId: 'retry-child',
    target,
    deadlineAt,
    maxTokens: 10,
  })
  return {
    handleId: grant.handleId,
    parentRunId: 'retry-parent',
    childRunId: 'retry-child',
    target,
    requestId: 'retry-request',
    request: {
      model: target.model,
      messages: [{ role: 'user' as const, content: 'retry within budget' }],
      tools: [],
      signal: new AbortController().signal,
    },
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for broker IPC fixture.')
    await new Promise((resolveWait) => setTimeout(resolveWait, 5))
  }
}
