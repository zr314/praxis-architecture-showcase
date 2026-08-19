import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderChunk, ProviderRequest } from '@praxis/core-sdk'
import {
  ChildCredentialDelegationService,
  InMemoryChildCredentialBroker,
  type CredentialBrokerTraceEvent,
} from '../apps/runtime/src/subagent/credentialDelegation.js'
import type { ChildProviderTarget } from '../apps/runtime/src/subagent/childCapabilityBundle.js'

const target = { providerId: 'openai', model: 'gpt-test' } as const
const NOW = Date.parse('2026-08-03T00:00:00.000Z')

test('Mock and Replay delegation return none without issuing a secret-bearing capability', async () => {
  const trace: CredentialBrokerTraceEvent[] = []
  const broker = brokerFixture({ trace })
  const delegation = new ChildCredentialDelegationService({ broker, now: () => NOW })

  assert.deepEqual(
    await delegation.delegate(scope({ target: { providerId: 'mock', model: 'mock-v1' } })),
    { kind: 'none', mode: 'mock' },
  )
  assert.deepEqual(
    await delegation.delegate(scope({ target: { providerId: 'replay', model: 'replay-v1' } })),
    { kind: 'none', mode: 'replay' },
  )
  assert.deepEqual(trace, [])
})

test('broker handles bind scope, reject replay, and emit only redacted aggregate trace', async () => {
  let now = Date.parse('2026-08-03T00:00:00.000Z')
  const trace: CredentialBrokerTraceEvent[] = []
  const seenRequests: ProviderRequest[] = []
  const broker = brokerFixture({
    now: () => now,
    trace,
    stream: async function* (_target, request) {
      const invocationIndex = seenRequests.length
      seenRequests.push(request)
      yield { type: 'text_delta', text: 'PRIVATE PROVIDER OUTPUT' }
      yield {
        type: 'completed',
        stopReason: 'end_turn',
        usage:
          invocationIndex === 0
            ? { inputTokens: 4, outputTokens: 2 }
            : { inputTokens: 2, outputTokens: 2 },
      }
    },
  })
  const delegation = new ChildCredentialDelegationService({ broker, now: () => now })
  const grant = await delegation.delegate(scope({ maxTokens: 10 }))
  assert.equal(grant.kind, 'broker_handle')
  if (grant.kind !== 'broker_handle') return

  await assert.rejects(
    collect(
      broker.invoke({
        ...invocation(grant.handleId, 'request-wrong-child'),
        childRunId: 'other-child',
      }),
    ),
    (error: unknown) => hasCode(error, 'CHILD_CREDENTIAL_SCOPE_MISMATCH'),
  )
  await assert.rejects(
    collect(
      broker.invoke({
        ...invocation(grant.handleId, 'request-wrong-provider'),
        target: { providerId: 'anthropic', model: 'claude-test' },
      }),
    ),
    (error: unknown) => hasCode(error, 'CHILD_CREDENTIAL_SCOPE_MISMATCH'),
  )

  const chunks = await collect(broker.invoke(invocation(grant.handleId, 'request-1')))
  assert.equal(chunks.at(-1)?.type, 'completed')
  assert.equal(seenRequests[0]?.maxOutputTokens, 10)
  assert.equal(seenRequests[0]?.model, 'gpt-test')
  await assert.rejects(
    collect(broker.invoke(invocation(grant.handleId, 'request-1'))),
    (error: unknown) => hasCode(error, 'CHILD_CREDENTIAL_REPLAYED'),
  )

  await collect(broker.invoke(invocation(grant.handleId, 'request-2')))
  assert.equal(seenRequests[1]?.maxOutputTokens, 4)
  assert.equal(
    JSON.stringify(trace).includes('PRIVATE') || JSON.stringify(trace).includes(grant.handleId),
    false,
  )
  assert.deepEqual(
    trace.filter((event) => event.type === 'credential_broker_completed')[0]?.usage,
    { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
  )

  now = Date.parse(grant.expiresAt)
  await assert.rejects(
    collect(broker.invoke(invocation(grant.handleId, 'request-expired'))),
    (error: unknown) => hasCode(error, 'CHILD_CREDENTIAL_EXPIRED'),
  )
})

test('broker revocation covers handle, parent exit, active cancellation, and unknown usage', async () => {
  let releaseStarted!: () => void
  const started = new Promise<void>((resolve) => {
    releaseStarted = resolve
  })
  const broker = brokerFixture({
    stream: async function* (_target, request) {
      releaseStarted()
      await new Promise<void>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      yield { type: 'message_start' }
    },
  })
  const grant = broker.issue(scope())
  const active = collect(broker.invoke(invocation(grant.handleId, 'request-active')))
  await started
  broker.revokeParent('parent-run')
  await assert.rejects(active, (error: unknown) => hasCode(error, 'CHILD_CREDENTIAL_REVOKED'))

  const revoked = broker.issue(scope({ childRunId: 'child-revoked' }))
  broker.revokeHandle(revoked.handleId)
  await assert.rejects(
    collect(
      broker.invoke({
        ...invocation(revoked.handleId, 'request-revoked'),
        childRunId: 'child-revoked',
      }),
    ),
    (error: unknown) => hasCode(error, 'CHILD_CREDENTIAL_REVOKED'),
  )

  const unknownUsageBroker = brokerFixture({
    stream: async function* () {
      yield { type: 'completed', stopReason: 'end_turn' }
    },
  })
  const unknown = unknownUsageBroker.issue(scope())
  await assert.rejects(
    collect(unknownUsageBroker.invoke(invocation(unknown.handleId, 'request-unknown'))),
    (error: unknown) => hasCode(error, 'CHILD_CREDENTIAL_USAGE_UNKNOWN'),
  )
})

test('caller cancellation aborts the broker invocation without revoking the handle', async () => {
  let releaseStarted!: () => void
  const started = new Promise<void>((resolve) => {
    releaseStarted = resolve
  })
  let calls = 0
  const broker = brokerFixture({
    stream: async function* () {
      calls += 1
      if (calls > 1) {
        yield {
          type: 'completed',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        }
        return
      }
      releaseStarted()
      await new Promise<void>(() => {})
      yield { type: 'message_start' }
    },
  })
  const grant = broker.issue(scope())
  const controller = new AbortController()
  const active = collect(
    broker.invoke({
      ...invocation(grant.handleId, 'request-cancelled'),
      request: request(controller.signal),
    }),
  )
  await started
  controller.abort()
  await assert.rejects(active, (error: unknown) => hasCode(error, 'CHILD_CREDENTIAL_CANCELLED'))

  const completed = await collect(broker.invoke(invocation(grant.handleId, 'request-after-cancel')))
  assert.equal(completed.at(-1)?.type, 'completed')
})

test('broker deadline fails closed even when the Provider ignores its AbortSignal', async () => {
  const broker = brokerFixture({
    now: Date.now,
    stream: async function* () {
      await new Promise<void>(() => {})
      yield { type: 'message_start' }
    },
  })
  const grant = broker.issue(
    scope({ deadlineAt: new Date(Date.now() + 50).toISOString(), maxTokens: 2 }),
  )
  const startedAt = Date.now()
  await assert.rejects(
    collect(broker.invoke(invocation(grant.handleId, 'request-deadline'))),
    (error: unknown) => hasCode(error, 'CHILD_CREDENTIAL_EXPIRED'),
  )
  assert.equal(Date.now() - startedAt < 1_000, true)
})

test('ephemeral token refs require explicit Provider support and bounded expiry', async () => {
  const now = Date.parse('2026-08-03T00:00:00.000Z')
  const revoked: string[] = []
  const delegation = new ChildCredentialDelegationService({
    broker: brokerFixture({ now: () => now }),
    now: () => now,
    ephemeralTokens: {
      supports(candidate) {
        return candidate.providerId === 'openai'
      },
      async issue(input) {
        return {
          tokenRef: `token-ref-${input.childRunId}`,
          expiresAt: new Date(now + 30_000).toISOString(),
        }
      },
      async revoke(tokenRef) {
        revoked.push(tokenRef)
      },
    },
  })
  const grant = await delegation.delegate(scope({ preference: 'ephemeral_token' }))
  assert.deepEqual(grant, {
    kind: 'ephemeral_token',
    tokenRef: 'token-ref-child-run',
    expiresAt: new Date(now + 30_000).toISOString(),
  })
  await delegation.revokeParent('parent-run')
  assert.deepEqual(revoked, ['token-ref-child-run'])

  await assert.rejects(
    delegation.delegate(
      scope({
        target: { providerId: 'anthropic', model: 'claude-test' },
        preference: 'ephemeral_token',
      }),
    ),
    (error: unknown) => hasCode(error, 'CHILD_CREDENTIAL_TOKEN_UNSUPPORTED'),
  )

  const lateDelegation = new ChildCredentialDelegationService({
    broker: brokerFixture({ now: () => now }),
    now: () => now,
    ephemeralTokens: {
      supports: () => true,
      async issue() {
        return {
          tokenRef: 'token-ref-too-late',
          expiresAt: new Date(now + 120_000).toISOString(),
        }
      },
    },
  })
  await assert.rejects(
    lateDelegation.delegate(scope({ preference: 'ephemeral_token' })),
    (error: unknown) => hasCode(error, 'CHILD_CREDENTIAL_INVALID'),
  )
})

function brokerFixture(
  options: {
    now?: () => number
    trace?: CredentialBrokerTraceEvent[]
    stream?: (target: ChildProviderTarget, request: ProviderRequest) => AsyncIterable<ProviderChunk>
  } = {},
) {
  const stream =
    options.stream ??
    async function* (_target: typeof target, _request: ProviderRequest) {
      yield {
        type: 'completed' as const,
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      }
    }
  let randomFill = 7
  return new InMemoryChildCredentialBroker({
    provider: { stream },
    now: options.now ?? (() => NOW),
    randomBytes: (size) => Buffer.alloc(size, randomFill++),
    trace: (event) => {
      options.trace?.push(event)
    },
  })
}

function scope(
  overrides: Partial<{
    parentRunId: string
    childRunId: string
    target: typeof target | { providerId: 'mock' | 'replay' | 'anthropic'; model: string }
    deadlineAt: string
    maxTokens: number
    preference: 'broker_handle' | 'ephemeral_token'
  }> = {},
) {
  return {
    parentRunId: 'parent-run',
    childRunId: 'child-run',
    target,
    deadlineAt: new Date('2026-08-03T00:01:00.000Z').toISOString(),
    maxTokens: 10,
    ...overrides,
  }
}

function invocation(handleId: string, requestId: string) {
  return {
    handleId,
    parentRunId: 'parent-run',
    childRunId: 'child-run',
    target,
    requestId,
    request: request(new AbortController().signal),
  }
}

function request(signal: AbortSignal): ProviderRequest {
  return {
    model: target.model,
    messages: [{ role: 'user', content: 'PRIVATE PROMPT' }],
    tools: [],
    signal,
    maxOutputTokens: 999,
  }
}

async function collect(iterable: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const chunks: ProviderChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
