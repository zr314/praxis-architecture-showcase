import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type {
  PermissionDecision,
  SubagentCancellationRequestV1,
  SubagentExecutionRequestV1,
  SubagentExecutor,
  SubagentResultV1,
} from '@praxis/core-sdk'
import {
  CancellationTree,
  validateSubagentCancellationRequestV1,
  validateSubagentExecutionRequestV1,
} from '@praxis/core-sdk'
import type { SessionEvent } from '@praxis/protocol'
import { RuntimeKernel } from '../apps/runtime/src/framework/runtimeKernel.js'
import type {
  PolicyAuditRecord,
  PolicyGrant,
  PolicyStore,
} from '../apps/runtime/src/policy/index.js'
import type {
  ChildPermissionDecisionLifecyclePort,
  ChildPermissionRequestV1,
} from '../apps/runtime/src/subagent/childPermissionGate.js'
import {
  ChildRuntimeHost,
  type ChildRuntimeRun,
} from '../apps/runtime/src/subagent/childRuntimeHost.js'
import {
  createSubagentResultV1,
  validateSubagentResultV1,
} from '../apps/runtime/src/subagent/contextPacket.js'
import {
  ChildRuntimeSubagentExecutor,
  createSubagentExecutionRequestV1,
} from '../apps/runtime/src/subagent/subagentExecutor.js'
import { InMemorySubagentAdmissionLedger } from '../apps/runtime/src/subagent/index.js'
import { mockChildCapabilityBundle } from './support/child-capability.js'

type Mode = 'success' | 'refused' | 'timeout' | 'crash' | 'schema' | 'pending'
const runtimeEntry = fileURLToPath(new URL('../apps/runtime/src/entry.ts', import.meta.url))

test('Planner-facing executor request contains only exact versioned opaque references', async () => {
  const execution = materializedExecution()
  const request = createSubagentExecutionRequestV1(execution)
  const serialized = JSON.stringify(request)

  assert.deepEqual(Object.keys(request), [
    'schemaVersion',
    'parentRunId',
    'childRunId',
    'packetRef',
    'profileRef',
    'bundleRef',
    'budgetRef',
  ])
  assert.doesNotMatch(
    serialized,
    /command|stdio|temporary|ephemeral|credential|broker|nonce|reservation|ledger/iu,
  )
  assert.equal(request.packetRef.version, 1)
  assert.equal(request.profileRef.version, 3)
  assert.equal(request.bundleRef.version, 1)
  assert.equal(request.budgetRef.version, 1)
  assert.throws(
    () => validateSubagentExecutionRequestV1({ ...request, command: 'must-not-cross-port' }),
    (error: unknown) => hasCode(error, 'SUBAGENT_EXECUTOR_REQUEST_INVALID'),
  )
  assert.throws(
    () =>
      validateSubagentCancellationRequestV1({
        schemaVersion: 1,
        parentRunId: request.parentRunId,
        childRunId: request.childRunId,
        reason: 'unknown',
      }),
    (error: unknown) => hasCode(error, 'SUBAGENT_EXECUTOR_CANCEL_INVALID'),
  )
  let getterRead = false
  const accessor = { ...request }
  Object.defineProperty(accessor, 'packetRef', {
    enumerable: true,
    get() {
      getterRead = true
      return request.packetRef
    },
  })
  assert.throws(
    () => validateSubagentExecutionRequestV1(accessor),
    (error: unknown) => hasCode(error, 'SUBAGENT_EXECUTOR_REQUEST_INVALID'),
  )
  assert.equal(getterRead, false)
})

test('production adapter materializes opaque refs into the shipping child Runtime', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-subagent-executor-shipping-'))
  const ledger = new InMemorySubagentAdmissionLedger()
  ledger.registerRootScope({
    runId: 'parent-run',
    budget: {
      maxTurns: 4,
      maxToolCalls: 4,
      maxChildRuns: 1,
      maxParallelChildren: 1,
      maxDepth: 1,
    },
  })
  const host = new ChildRuntimeHost({
    ledger,
    cancellation: new CancellationTree(),
    handshakeTimeoutMs: 20_000,
  })
  const execution = shippingExecution(home)
  const request = createSubagentExecutionRequestV1(execution)
  const executor = new ChildRuntimeSubagentExecutor({
    host,
    materializer: { materialize: () => execution },
    permissionDecisions: permissionPort(),
  })

  try {
    const result = await executor.execute(request)
    assert.equal(result.status, 'succeeded')
    assert.match(result.summary, /Tool read completed/u)
    assert.deepEqual(result.usage, {
      turns: 2,
      toolCalls: 2,
      inputTokens: 0,
      outputTokens: 0,
      subagents: 0,
    })
    assert.equal(ledger.scope('parent-run')?.chargedChildRuns, 1)
    assert.equal(ledger.scope('parent-run')?.activeChildren, 0)
    assert.equal(await exists(execution.bootstrapProfile.ephemeral.root), false)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

for (const implementation of ['production-adapter', 'fake'] as const) {
  test(`${implementation} satisfies success, refusal, timeout, crash, and schema contracts`, async () => {
    for (const mode of ['success', 'refused', 'timeout', 'crash', 'schema'] as const) {
      const harness = executorHarness(implementation, mode)
      if (mode === 'success') {
        const result = await harness.executor.execute(harness.request)
        assert.equal(result.status, 'succeeded', implementation)
        assert.equal(result.childRunId, harness.request.childRunId, implementation)
        assert.equal(await harness.executor.cancel(cancelRequest(harness.request)), false)
        continue
      }
      const code = {
        refused: 'CHILD_MVP_TOOL_DENIED',
        timeout: 'CHILD_RUNTIME_TIMEOUT',
        crash: 'CHILD_RUNTIME_EXITED',
        schema: 'SUBAGENT_RESULT_INVALID',
      }[mode]
      await assert.rejects(
        harness.executor.execute(harness.request),
        (error: unknown) => hasCode(error, code),
        `${implementation}:${mode}`,
      )
      assert.equal(await harness.executor.cancel(cancelRequest(harness.request)), false)
    }
  })

  test(`${implementation} cancellation is subtree-scoped and terminally idempotent`, async () => {
    const harness = executorHarness(implementation, 'pending')
    const execution = harness.executor.execute(harness.request)
    await Promise.resolve()
    await assert.rejects(harness.executor.execute(harness.request), (error: unknown) =>
      hasCode(error, 'SUBAGENT_EXECUTOR_CONFLICT'),
    )
    assert.equal(await harness.executor.cancel(cancelRequest(harness.request)), true)
    const result = await execution
    assert.equal(result.status, 'cancelled')
    assert.equal(result.error?.code, 'CHILD_USER_ABORTED')
    assert.equal(await harness.executor.cancel(cancelRequest(harness.request)), false)
    assert.ok(harness.permissionCleanupCount() >= 1)
  })
}

test('production adapter rejects materialization drift before invoking the child host', async () => {
  const execution = materializedExecution()
  const request = createSubagentExecutionRequestV1(execution)
  const host = new ContractHost('success')
  const executor = new ChildRuntimeSubagentExecutor({
    host,
    materializer: { materialize: () => execution },
    permissionDecisions: permissionPort(),
  })

  await assert.rejects(
    executor.execute({
      ...request,
      packetRef: { ...request.packetRef, digest: `sha256:${'0'.repeat(64)}` },
    }),
    (error: unknown) => hasCode(error, 'SUBAGENT_EXECUTOR_BINDING_MISMATCH'),
  )
  assert.equal(host.runCalls, 0)
})

test('Runtime parent permission port reuses Policy and CLI decision flow with child correlation', async () => {
  const policyStore = new MemoryPolicyStore()
  const kernel = new RuntimeKernel({ policyStore })
  const events: SessionEvent[] = []
  const internals = kernel as unknown as {
    sessionService: { sessions: Map<string, unknown> }
    pendingPermissions: Map<string, unknown>
    emit(event: SessionEvent): void
    decidePermission(params: unknown): Promise<{ accepted: true }>
  }
  internals.sessionService.sessions.set('parent-session', {
    sessionId: 'parent-session',
    cwd: process.cwd(),
    activeRun: { id: 'parent-run' },
  })
  internals.emit = (event) => events.push(event)

  const first = childPermissionRequest(resolve(process.cwd(), '.praxis-isolated-child'))
  const firstDecision = kernel.childPermissionDecisions.decide(first)
  const event = events.at(-1)
  assert.equal(event?.type, 'permission_request')
  if (event?.type !== 'permission_request') throw new Error('Expected permission request.')
  assert.equal(event.runId, 'parent-run')
  assert.equal(event.parentRunId, 'parent-run')
  assert.equal(event.childRunId, 'child-run')
  assert.equal(event.childAgentRunId, 'child-agent-run')
  assert.equal(event.childRequestId, 'child-permission')
  assert.equal(event.target, resolve(process.cwd(), 'package.json'))
  assert.equal(event.rule, `read-outside:${resolve(process.cwd(), 'package.json')}`)

  await internals.decidePermission({
    requestId: event.requestId,
    decision: { type: 'allow_always' },
  })
  assert.deepEqual(await firstDecision, { type: 'allow_always' })
  assert.equal(policyStore.grants.length, 1)

  const replayed = await kernel.childPermissionDecisions.decide({
    ...first,
    requestId: 'child-permission-replayed',
  })
  assert.deepEqual(replayed, { type: 'allow_always' })
  assert.equal(events.length, 1)

  const pending = kernel.childPermissionDecisions.decide({
    ...first,
    requestId: 'child-permission-cancelled',
    rule: 'read-outside:cancelled',
  })
  assert.equal(events.length, 2)
  await kernel.childPermissionDecisions.cancelChild?.('parent-run', 'child-run')
  assert.deepEqual(await pending, { type: 'deny', reason: 'Run cancelled.' })
  assert.equal(internals.pendingPermissions.size, 0)

  assert.deepEqual(
    await kernel.childPermissionDecisions.decide({ ...first, parentRunId: 'missing-parent' }),
    { type: 'deny', reason: 'Child permission denied (parent_session_unavailable).' },
  )
})

function executorHarness(
  implementation: 'production-adapter' | 'fake',
  mode: Mode,
): {
  executor: SubagentExecutor
  request: SubagentExecutionRequestV1
  permissionCleanupCount(): number
} {
  const execution = materializedExecution()
  const request = createSubagentExecutionRequestV1(execution)
  if (implementation === 'fake') {
    const executor = new ContractFakeExecutor(mode)
    return { executor, request, permissionCleanupCount: () => executor.cleanupCount }
  }
  const host = new ContractHost(mode)
  const permissions = permissionPort()
  return {
    executor: new ChildRuntimeSubagentExecutor({
      host,
      materializer: { materialize: () => execution },
      permissionDecisions: permissions,
    }),
    request,
    permissionCleanupCount: () => permissions.cleanupCount,
  }
}

class ContractHost {
  runCalls = 0
  #pending?: ReturnType<typeof deferred<SubagentResultV1>>

  constructor(private readonly mode: Mode) {}

  async run(input: ChildRuntimeRun): Promise<SubagentResultV1> {
    this.runCalls += 1
    assert.ok(input.permissionDecisions)
    if (this.mode === 'pending') {
      this.#pending = deferred<SubagentResultV1>()
      return this.#pending.promise
    }
    return behavior(this.mode, input.packet.childRunId)
  }

  cancel(runId: string): Array<[string, 'user_abort']> {
    if (!this.#pending) return []
    this.#pending.resolve(cancelledResult(runId))
    this.#pending = undefined
    return [[runId, 'user_abort']]
  }
}

class ContractFakeExecutor implements SubagentExecutor {
  cleanupCount = 0
  readonly #active = new Set<string>()
  #pending?: ReturnType<typeof deferred<SubagentResultV1>>

  constructor(private readonly mode: Mode) {}

  async execute(input: SubagentExecutionRequestV1): Promise<SubagentResultV1> {
    const request = validateSubagentExecutionRequestV1(input)
    if (this.#active.has(request.childRunId)) throw coded('SUBAGENT_EXECUTOR_CONFLICT')
    this.#active.add(request.childRunId)
    try {
      if (this.mode === 'pending') {
        this.#pending = deferred<SubagentResultV1>()
        return validateSubagentResultV1(await this.#pending.promise)
      }
      return validateSubagentResultV1(await behavior(this.mode, request.childRunId))
    } finally {
      this.#active.delete(request.childRunId)
      this.cleanupCount += 1
    }
  }

  async cancel(input: SubagentCancellationRequestV1): Promise<boolean> {
    const request = validateSubagentCancellationRequestV1(input)
    if (!this.#active.has(request.childRunId) || !this.#pending) return false
    this.#pending.resolve(cancelledResult(request.childRunId))
    this.#pending = undefined
    this.cleanupCount += 1
    return true
  }
}

function behavior(mode: Exclude<Mode, 'pending'>, childRunId: string): SubagentResultV1 {
  if (mode === 'refused') throw coded('CHILD_MVP_TOOL_DENIED')
  if (mode === 'timeout') throw coded('CHILD_RUNTIME_TIMEOUT')
  if (mode === 'crash') throw coded('CHILD_RUNTIME_EXITED')
  if (mode === 'schema') return { schemaVersion: 1, childRunId } as SubagentResultV1
  return createSubagentResultV1({
    childRunId,
    status: 'succeeded',
    summary: 'bounded success',
    evidenceRefs: [],
    changedFiles: [],
    checks: [],
    usage: { turns: 1, toolCalls: 0, subagents: 0 },
    retryable: false,
  })
}

function cancelledResult(childRunId: string): SubagentResultV1 {
  return createSubagentResultV1({
    childRunId,
    status: 'cancelled',
    summary: 'Cancelled.',
    evidenceRefs: [],
    changedFiles: [],
    checks: [],
    usage: { turns: 0, toolCalls: 0, subagents: 0 },
    retryable: false,
    error: {
      code: 'CHILD_USER_ABORTED',
      category: 'cancellation',
      message: 'Cancelled by contract fixture.',
      retryable: false,
    },
  })
}

function materializedExecution(): ChildRuntimeRun {
  const workspace = resolve(process.cwd())
  const methods = [
    'initialize',
    'events.subscribe',
    'session.create',
    'session.prompt',
    'permission.decide',
    'session.abort',
    'shutdown',
  ] as const
  const bundle = mockChildCapabilityBundle({ workspace, methods, toolNames: ['read'] })
  const deadlineAt = '2099-01-01T00:00:00.000Z'
  return {
    packet: {
      schemaVersion: 1,
      packetId: 'packet-ref-contract',
      parentRunId: 'parent-run',
      childRunId: 'child-run',
      objective: 'Analyze the bounded fixture.',
      step: { stepId: 'step-1', title: 'Analyze', instructions: 'Read input.txt.' },
      constraints: ['Read only.'],
      relevantRefs: [],
      successCriteria: [{ id: 'criterion-1', description: 'Return one bounded result.' }],
      workspace: { root: workspace, access: 'read_only' },
      grant: {
        bundleId: bundle.bundleId,
        bundleDigest: bundle.digest,
        provider: bundle.provider.target,
        tools: bundle.tools.map((tool) => tool.name),
        skills: [],
        methods: [...bundle.methodAllowlist],
        mcpMode: 'disabled',
      },
      budget: {
        maxTurns: 2,
        maxToolCalls: 2,
        maxChildRuns: 0,
        maxParallelChildren: 0,
        maxDepth: 0,
        deadlineAt,
      },
      prohibitions: ['Do not write.'],
      outputSchema: {
        format: 'json',
        schema: { type: 'object' },
        maxInlineBytes: 4_096,
        overflow: 'artifact_ref',
      },
    },
    parentUsage: { turns: 0, toolCalls: 0 },
    launch: { command: 'hidden-command', args: ['hidden-stdio-argument'] },
    bootstrapProfile: {
      schemaVersion: 3,
      workspace: { root: workspace, access: 'read_only' },
      methodAllowlist: methods,
      ephemeral: {
        root: resolve('.private-child-root'),
        sessionRoot: resolve('.private-child-root/sessions'),
        traceRoot: resolve('.private-child-root/traces'),
        artifactRoot: resolve('.private-child-root/artifacts'),
        retention: 'delete',
      },
      provider: { providerId: 'mock', model: 'mock-v1' },
      capabilityBundleDigest: bundle.digest,
      capabilityBundle: bundle,
      deadlineAt,
      trace: { traceId: 'trace-child', parentTraceId: 'trace-parent' },
    },
  }
}

function shippingExecution(home: string): ChildRuntimeRun {
  const execution = materializedExecution()
  const deadlineAt = new Date(Date.now() + 60_000).toISOString()
  const ephemeralRoot = join(home, 'ephemeral')
  return {
    ...execution,
    packet: {
      ...execution.packet,
      step: {
        ...execution.packet.step,
        instructions: 'tool:read {"path":"package.json","limit":5}',
      },
      budget: { ...execution.packet.budget, deadlineAt },
    },
    launch: {
      command: process.execPath,
      args: ['--import', 'tsx', runtimeEntry],
      cwd: process.cwd(),
    },
    bootstrapProfile: {
      ...execution.bootstrapProfile,
      ephemeral: {
        root: ephemeralRoot,
        sessionRoot: join(ephemeralRoot, 'sessions'),
        traceRoot: join(ephemeralRoot, 'traces'),
        artifactRoot: join(ephemeralRoot, 'artifacts'),
        retention: 'delete',
      },
      deadlineAt,
    },
  }
}

function cancelRequest(request: SubagentExecutionRequestV1): SubagentCancellationRequestV1 {
  return {
    schemaVersion: 1,
    parentRunId: request.parentRunId,
    childRunId: request.childRunId,
    reason: 'user_abort',
  }
}

function permissionPort(): ChildPermissionDecisionLifecyclePort & { cleanupCount: number } {
  return {
    cleanupCount: 0,
    decide(): PermissionDecision {
      return { type: 'deny' }
    },
    cancelChild() {
      this.cleanupCount += 1
    },
  }
}

function childPermissionRequest(workspace = resolve(process.cwd())): ChildPermissionRequestV1 {
  return {
    schemaVersion: 1,
    parentRunId: 'parent-run',
    childRunId: 'child-run',
    workspace,
    runId: 'child-agent-run',
    requestId: 'child-permission',
    toolCallId: 'child-tool-call',
    tool: 'read',
    rule: `read-outside:${resolve(workspace, 'package.json')}`,
    input: { path: 'package.json' },
    risk: 'medium',
    target: resolve(workspace, 'package.json'),
    grant: { bundleId: 'bundle-id', bundleDigest: 'a'.repeat(64) },
  }
}

class MemoryPolicyStore implements PolicyStore {
  grants: PolicyGrant[] = []
  audits: PolicyAuditRecord[] = []

  async loadGrants(): Promise<PolicyGrant[]> {
    return this.grants.map((grant) => ({ ...grant }))
  }

  async saveGrants(grants: PolicyGrant[]): Promise<void> {
    this.grants = grants.map((grant) => ({ ...grant }))
  }

  async appendAudit(record: PolicyAuditRecord): Promise<void> {
    this.audits.push({ ...record })
  }
}

function coded(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
