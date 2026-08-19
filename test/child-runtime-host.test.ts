import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CancellationTree,
  type ExecutionBudget,
  type SubagentEvidenceRefV1,
} from '@praxis/core-sdk'
import { assertProtocolMessage } from '@praxis/protocol'
import {
  terminateProcessTree,
  waitForProcessExit,
} from '../apps/runtime/src/process/processTree.js'
import {
  ChildRuntimeHost,
  type ChildRuntimeProgressEventV1,
  type ChildRuntimeTraceEventV1,
  compactSubagentEvidenceRefsV1,
  parseStructuredChildOutputV1,
} from '../apps/runtime/src/subagent/childRuntimeHost.js'
import type { ContextPacketV1 } from '../apps/runtime/src/subagent/contextPacket.js'
import {
  InMemorySubagentAdmissionLedger,
  type SubagentAdmissionEvent,
} from '../apps/runtime/src/subagent/index.js'
import { mockChildCapabilityBundle } from './support/child-capability.js'

const fixture = fileURLToPath(new URL('./fixtures/child-runtime.ts', import.meta.url))
const controlledRuntime = fileURLToPath(
  new URL('./fixtures/controllable-child-runtime.ts', import.meta.url),
)
const schemaInvalidRuntime = fileURLToPath(
  new URL('./fixtures/schema-invalid-runtime.ts', import.meta.url),
)
const runtimeEntry = fileURLToPath(new URL('../apps/runtime/src/entry.ts', import.meta.url))

test('long child runs compact tool evidence into a parent-owned manifest', async () => {
  const evidenceRefs: SubagentEvidenceRefV1[] = Array.from({ length: 100 }, (_, index) => ({
    kind: 'result',
    ref: `tool-result:read:call-${index}`,
    digest: `sha256:${index.toString(16).padStart(64, '0')}`,
    mediaType: 'application/vnd.praxis.tool-result+json',
  }))
  evidenceRefs.push({
    kind: 'artifact',
    ref: 'artifact://full-child-output',
    digest: `sha256:${'e'.repeat(64)}`,
  })
  const storedBatchSizes: number[] = []
  const compacted = await compactSubagentEvidenceRefsV1(
    { parentRunId: 'parent-1', childRunId: 'child-1' },
    evidenceRefs,
    {
      store: async ({ evidenceRefs: stored }) => {
        storedBatchSizes.push(stored.length)
        return {
          kind: 'artifact',
          ref: 'artifact://evidence-manifest',
          digest: `sha256:${'f'.repeat(64)}`,
          mediaType: 'application/vnd.praxis.subagent-evidence-manifest+json',
        }
      },
    },
  )

  assert.deepEqual(storedBatchSizes, [63])
  assert.equal(compacted.length, 39)
  assert.equal(compacted[0]?.ref, 'artifact://evidence-manifest')
  assert.equal(compacted.at(-1)?.ref, 'artifact://full-child-output')
})

test('structured child output accepts one JSON fence with common Provider prose', () => {
  const criteria = [{ id: 'criterion-1', description: 'Return a verified result.' }] as const
  const payload = JSON.stringify({
    summary: 'Verified result.',
    criteria: [{ id: 'criterion-1', status: 'passed', summary: 'Verified.' }],
  })

  assert.deepEqual(
    parseStructuredChildOutputV1(criteria, `\n\`\`\`json\n${payload}\n\`\`\`\n`, []),
    {
      summary: 'Verified result.',
      checks: [{ id: 'criterion-1', status: 'passed', summary: 'Verified.' }],
    },
  )
  assert.deepEqual(
    parseStructuredChildOutputV1(
      criteria,
      `Here is the result:\n\`\`\`json\n${payload}\n\`\`\``,
      [],
    ),
    {
      summary: 'Verified result.',
      checks: [{ id: 'criterion-1', status: 'passed', summary: 'Verified.' }],
    },
  )
  assert.equal(
    parseStructuredChildOutputV1(
      criteria,
      `First:\n\`\`\`json\n${payload}\n\`\`\`\nSecond:\n\`\`\`json\n${payload}\n\`\`\``,
      [],
    ),
    undefined,
  )
  assert.equal(
    parseStructuredChildOutputV1(criteria, payload, [], {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'result', 'criteria'],
      properties: {
        summary: { type: 'string' },
        result: { type: 'object' },
        criteria: { type: 'array' },
      },
    }),
    undefined,
  )
})

test('child runtime fixture clamps budget, records terminal usage, and reclaims its process', async () => {
  const ledger = new InMemorySubagentAdmissionLedger()
  ledger.registerRootScope({
    runId: 'parent',
    budget: rootBudget({ maxTurns: 4, maxToolCalls: 4, maxDepth: 2 }),
  })
  const host = new ChildRuntimeHost({
    ledger,
    cancellation: new CancellationTree(),
    requestTimeoutMs: 2_000,
  })

  const result = await host.runFixture({
    parentRunId: 'parent',
    childRunId: 'child',
    requestedBudget: requestedBudget({ maxTurns: 9, maxToolCalls: 9, maxDepth: 9 }),
    parentUsage: { turns: 0, toolCalls: 0 },
    launch: { command: process.execPath, args: ['--import', 'tsx', fixture], cwd: process.cwd() },
    request: { method: 'child.execute', params: { value: 'hello' } },
  })

  assert.deepEqual(result, { echoed: 'hello' })
  assert.deepEqual(ledger.terminalUsage('parent'), {
    turns: 1,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    subagents: 1,
  })
})

test('child runtime host inherits only bounded non-secret process environment', async () => {
  const ledger = new InMemorySubagentAdmissionLedger()
  ledger.registerRootScope({
    runId: 'environment-parent',
    budget: rootBudget({ maxTurns: 2, maxToolCalls: 1, maxDepth: 1 }),
  })
  const host = new ChildRuntimeHost({
    ledger,
    cancellation: new CancellationTree(),
    requestTimeoutMs: 2_000,
    environment: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      TZ: 'Asia/Shanghai',
      OPENAI_API_KEY: 'must-not-be-inherited',
      ANTHROPIC_API_KEY: 'must-not-be-inherited',
      PRAXIS_HOME: 'must-not-be-inherited',
      CUSTOM_CHILD_SECRET: 'must-not-be-inherited',
    },
  })

  const result = await host.runFixture({
    parentRunId: 'environment-parent',
    childRunId: 'environment-child',
    requestedBudget: requestedBudget({ maxTurns: 1, maxToolCalls: 0, maxDepth: 0 }),
    parentUsage: { turns: 0, toolCalls: 0 },
    launch: { command: process.execPath, args: ['--import', 'tsx', fixture], cwd: process.cwd() },
    request: { method: 'child.execute', params: { mode: 'environment' } },
  })

  assert.deepEqual(result, {
    path: true,
    timezone: true,
    openai: false,
    anthropic: false,
    praxisHome: false,
    customSecret: false,
  })
})

test('child vertical slice evaluates timeout, crash, malformed, and oversized output', async () => {
  const cases = [
    { mode: 'malformed', expectedCode: 'CHILD_RUNTIME_PROTOCOL_INVALID' },
    { mode: 'oversized', expectedCode: 'CHILD_RUNTIME_PROTOCOL_INVALID' },
    { mode: 'timeout', expectedCode: 'CHILD_RUNTIME_TIMEOUT' },
    { mode: 'early_exit', expectedCode: 'CHILD_RUNTIME_EXITED' },
  ] as const

  for (const { mode, expectedCode } of cases) {
    const parentRunId = `fixture-parent-${mode}`
    const ledger = new InMemorySubagentAdmissionLedger()
    ledger.registerRootScope({
      runId: parentRunId,
      budget: rootBudget({ maxTurns: 2, maxToolCalls: 1, maxDepth: 2 }),
    })
    const cancellation = new CancellationTree()
    const host = new ChildRuntimeHost({
      ledger,
      cancellation,
      requestTimeoutMs: 2_000,
    })

    await assert.rejects(
      host.runFixture({
        parentRunId,
        childRunId: `fixture-child-${mode}`,
        requestedBudget: requestedBudget({ maxTurns: 1, maxToolCalls: 0, maxDepth: 1 }),
        parentUsage: { turns: 0, toolCalls: 0 },
        launch: {
          command: process.execPath,
          args: ['--import', 'tsx', fixture],
          cwd: process.cwd(),
        },
        request: { method: 'child.execute', params: { mode } },
      }),
      (error: unknown) => hasErrorCode(error, expectedCode),
      mode,
    )
    assert.equal(ledger.scope(parentRunId)?.chargedChildRuns, 1, mode)
    assert.equal(ledger.scope(parentRunId)?.activeChildren, 0, mode)
    assert.equal(ledger.scope(`fixture-child-${mode}`), undefined, mode)
    assert.equal(cancellation.parentFor(`fixture-child-${mode}`), undefined, mode)
    assert.deepEqual(
      ledger.terminalUsage(parentRunId),
      {
        turns: 1,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        subagents: 1,
      },
      mode,
    )
  }
})

test('child runtime cancellation closes the shared transport and reclaims the process', async () => {
  const events: SubagentAdmissionEvent[] = []
  const ledger = new InMemorySubagentAdmissionLedger({ events: (event) => events.push(event) })
  ledger.registerRootScope({
    runId: 'cancel-parent',
    budget: rootBudget({ maxTurns: 2, maxToolCalls: 1, maxDepth: 2 }),
  })
  const host = new ChildRuntimeHost({
    ledger,
    cancellation: new CancellationTree(),
    requestTimeoutMs: 10_000,
  })
  const execution = host.runFixture({
    parentRunId: 'cancel-parent',
    childRunId: 'cancel-child',
    requestedBudget: requestedBudget({ maxTurns: 1, maxToolCalls: 0, maxDepth: 1 }),
    parentUsage: { turns: 0, toolCalls: 0 },
    launch: { command: process.execPath, args: ['--import', 'tsx', fixture], cwd: process.cwd() },
    request: { method: 'child.execute', params: { mode: 'timeout' } },
  })

  await waitFor(() => events.some((event) => event.type === 'child_execution_accepted_and_charged'))
  assert.deepEqual(host.cancel('cancel-parent', 'user_abort'), [
    ['cancel-parent', 'user_abort'],
    ['cancel-child', 'parent_cancelled'],
  ])
  await assert.rejects(execution, (error: unknown) => hasErrorCode(error, 'CHILD_RUNTIME_CLOSED'))
  assert.deepEqual(ledger.terminalUsage('cancel-parent'), {
    turns: 1,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    subagents: 1,
  })
})

test('child runtime host binds an immutable bootstrap profile through the dedicated channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-child-bootstrap-host-'))
  const deadlineAt = new Date(Date.now() + 60_000).toISOString()
  const ledger = new InMemorySubagentAdmissionLedger()
  const revokedChildren: Array<[string, string]> = []
  ledger.registerRootScope({
    runId: 'bootstrap-parent',
    budget: rootBudget({ maxTurns: 2, maxToolCalls: 1, maxDepth: 2 }),
  })
  const host = new ChildRuntimeHost({
    ledger,
    cancellation: new CancellationTree(),
    requestTimeoutMs: 2_000,
    credentialDelegation: {
      revokeChild(parentRunId, childRunId) {
        revokedChildren.push([parentRunId, childRunId])
      },
    },
  })

  try {
    const result = await host.runFixture({
      parentRunId: 'bootstrap-parent',
      childRunId: 'bootstrap-child',
      requestedBudget: requestedBudget({ maxTurns: 1, maxToolCalls: 0, maxDepth: 1 }),
      parentUsage: { turns: 0, toolCalls: 0 },
      launch: { command: process.execPath, args: ['--import', 'tsx', fixture], cwd: process.cwd() },
      bootstrapProfile: bootstrapProfile(root, deadlineAt),
      request: { method: 'session.prompt', params: { mode: 'bootstrap' } },
    })
    assert.deepEqual(result, {
      parentRunId: 'bootstrap-parent',
      childRunId: 'bootstrap-child',
      workspace: { root: process.cwd(), access: 'read_only' },
      methodAllowlist: [
        'initialize',
        'events.subscribe',
        'session.create',
        'session.prompt',
        'permission.decide',
        'session.abort',
        'shutdown',
      ],
      budget: {
        maxTurns: 1,
        maxToolCalls: 0,
        maxChildRuns: 0,
        maxParallelChildren: 0,
        maxDepth: 1,
        deadlineAt,
      },
      admission: { depth: 1, remainingDepth: 1 },
      launchEnvironmentScrubbed: true,
    })
    assert.deepEqual(revokedChildren, [['bootstrap-parent', 'bootstrap-child']])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('child runtime host rejects a method outside the launch profile before spawn or charge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-child-bootstrap-denied-'))
  const deadlineAt = new Date(Date.now() + 60_000).toISOString()
  const ledger = new InMemorySubagentAdmissionLedger()
  ledger.registerRootScope({
    runId: 'denied-parent',
    budget: rootBudget({ maxTurns: 2, maxToolCalls: 1, maxDepth: 2 }),
  })
  const host = new ChildRuntimeHost({ ledger, cancellation: new CancellationTree() })

  try {
    await assert.rejects(
      host.runFixture({
        parentRunId: 'denied-parent',
        childRunId: 'denied-child',
        requestedBudget: requestedBudget({ maxTurns: 1, maxToolCalls: 0, maxDepth: 1 }),
        parentUsage: { turns: 0, toolCalls: 0 },
        launch: { command: 'must-not-spawn' },
        bootstrapProfile: bootstrapProfile(root, deadlineAt),
        request: { method: 'child.execute', params: {} },
      }),
      (error: unknown) => hasErrorCode(error, 'CHILD_RUNTIME_METHOD_NOT_ALLOWED'),
    )
    assert.equal(ledger.scope('denied-parent')?.chargedChildRuns, 0)
    assert.equal(ledger.scope('denied-parent')?.activeChildren, 0)
    assert.deepEqual(host.cancel('denied-parent', 'user_abort'), [['denied-parent', 'user_abort']])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('formal child host rejects packet authority drift before spawn or charge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-child-packet-denied-'))
  const deadlineAt = new Date(Date.now() + 60_000).toISOString()
  const ledger = new InMemorySubagentAdmissionLedger()
  ledger.registerRootScope({
    runId: 'production-parent',
    budget: rootBudget({ maxTurns: 2, maxToolCalls: 1, maxDepth: 1 }),
  })
  const host = new ChildRuntimeHost({ ledger, cancellation: new CancellationTree() })
  const profile = bootstrapProfile(root, deadlineAt)
  const packet = contextPacket(profile, deadlineAt)

  try {
    await assert.rejects(
      host.run({
        packet: {
          ...packet,
          grant: { ...packet.grant, bundleDigest: '1'.repeat(64) },
        },
        parentUsage: { turns: 0, toolCalls: 0 },
        launch: { command: 'must-not-spawn' },
        bootstrapProfile: profile,
      }),
      (error: unknown) => hasErrorCode(error, 'SUBAGENT_CONTEXT_PACKET_AUTHORITY_MISMATCH'),
    )
    assert.equal(ledger.scope('production-parent')?.chargedChildRuns, 0)
    assert.equal(ledger.scope('production-parent')?.activeChildren, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('formal child host rejects descendant authority before spawn or charge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-child-host-descendants-'))
  const ledger = new InMemorySubagentAdmissionLedger()
  ledger.registerRootScope({
    runId: 'production-parent',
    budget: rootBudget({ maxTurns: 4, maxToolCalls: 4, maxDepth: 2 }),
  })
  const host = new ChildRuntimeHost({ ledger, cancellation: new CancellationTree() })

  try {
    const deadlineAt = new Date(Date.now() + 60_000).toISOString()
    const profile = bootstrapProfile(root, deadlineAt)
    const packet = contextPacket(profile, deadlineAt)
    await assert.rejects(
      host.run({
        packet: {
          ...packet,
          budget: {
            ...packet.budget,
            maxChildRuns: 1,
            maxParallelChildren: 1,
            maxDepth: 1,
          },
        },
        parentUsage: { turns: 0, toolCalls: 0 },
        launch: { command: 'must-not-spawn-descendant-authority' },
        bootstrapProfile: profile,
      }),
      (error: unknown) => hasErrorCode(error, 'CHILD_MVP_DESCENDANTS_DENIED'),
    )
    assert.equal(ledger.scope('production-parent')?.chargedChildRuns, 0)
    assert.equal(ledger.scope('production-parent')?.activeChildren, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('child runtime host executes the shipping Runtime through formal session RPC', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-child-host-production-'))
  const ledger = new InMemorySubagentAdmissionLedger()
  ledger.registerRootScope({
    runId: 'production-parent',
    budget: rootBudget({ maxTurns: 4, maxToolCalls: 4, maxDepth: 2 }),
  })
  const trace: ChildRuntimeTraceEventV1[] = []
  const progress: Array<{
    parentRunId: string
    childRunId: string
    stepId: string
    event: ChildRuntimeProgressEventV1
  }> = []
  const host = new ChildRuntimeHost({
    ledger,
    cancellation: new CancellationTree(),
    requestTimeoutMs: 20_000,
    resultOverflow: {
      async store() {
        return {
          kind: 'artifact',
          ref: `artifact://artifact-${'e'.repeat(64)}`,
          digest: `sha256:${'e'.repeat(64)}`,
          mediaType: 'application/vnd.praxis.subagent-output+json',
        }
      },
    },
    trace: {
      record(event) {
        trace.push(event)
      },
    },
    progress: {
      publish(event) {
        progress.push(event)
      },
    },
  })

  try {
    const deadlineAt = new Date(Date.now() + 60_000).toISOString()
    const profile = bootstrapProfile(home, deadlineAt)
    const result = await host.run({
      packet: {
        ...contextPacket(profile, deadlineAt),
        outputSchema: {
          ...contextPacket(profile, deadlineAt).outputSchema,
          maxInlineBytes: 1,
        },
      },
      parentUsage: { turns: 0, toolCalls: 0 },
      launch: {
        command: process.execPath,
        args: ['--import', 'tsx', runtimeEntry],
        cwd: process.cwd(),
      },
      bootstrapProfile: profile,
    })

    assert.equal(result.schemaVersion, 1)
    assert.equal(result.childRunId, 'production-child')
    assert.equal(result.status, 'succeeded')
    assert.match(result.summary, /Tool read completed/u)
    assert.equal(result.evidenceRefs.length, 2)
    assert.equal(result.evidenceRefs[0]?.ref, 'tool-result:read:mock-tool-1')
    assert.equal(result.evidenceRefs[1]?.ref, `artifact://artifact-${'e'.repeat(64)}`)
    assert.deepEqual(result.changedFiles, [])
    assert.deepEqual(result.checks, [
      {
        id: 'manifest-read',
        status: 'passed',
        summary: 'The package manifest is read successfully.',
      },
    ])
    assert.deepEqual(result.usage, {
      turns: 2,
      toolCalls: 2,
      inputTokens: 0,
      outputTokens: 0,
      subagents: 0,
    })
    assert.equal('events' in result, false)
    assert.equal('sessionId' in result, false)
    assert.deepEqual(ledger.terminalUsage('production-parent'), {
      turns: 2,
      toolCalls: 2,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      subagents: 1,
    })
    assert.equal(ledger.scope('production-parent')?.activeChildren, 0)
    assert.equal(ledger.scope('production-parent')?.chargedChildRuns, 1)
    assert.ok(progress.some((event) => event.event.type === 'tool_start'))
    assert.ok(progress.some((event) => event.event.type === 'tool_end'))
    assert.ok(
      progress.every(
        (event) =>
          event.parentRunId === 'production-parent' &&
          event.childRunId === 'production-child' &&
          event.stepId === 'formal-child-step',
      ),
    )
    assert.deepEqual(
      trace.map((event) => event.phase),
      ['launch', 'accepted', 'terminal'],
    )
    assert.equal(trace.filter((event) => event.phase === 'terminal').length, 1)
    for (const event of trace) {
      assert.equal(event.parentRunId, 'production-parent')
      assert.equal(event.childRunId, 'production-child')
      assert.equal(event.traceId, 'trace-child-bootstrap')
      assert.equal(event.parentTraceId, 'trace-parent-bootstrap')
      assert.equal('planId' in event, false)
      assert.equal('stepId' in event, false)
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('child vertical slice denies an ungranted write without workspace or main-state pollution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-child-host-zero-pollution-'))
  const workspace = join(root, 'workspace')
  const mainHome = join(root, 'main-home')
  await mkdir(workspace)
  await writeFile(join(workspace, 'input.txt'), 'immutable fixture\n', 'utf8')
  const ledger = new InMemorySubagentAdmissionLedger()
  ledger.registerRootScope({
    runId: 'production-parent',
    budget: rootBudget({ maxTurns: 4, maxToolCalls: 4, maxDepth: 2 }),
  })
  const host = new ChildRuntimeHost({
    ledger,
    cancellation: new CancellationTree(),
    handshakeTimeoutMs: 20_000,
    environment: { ...process.env, PRAXIS_HOME: mainHome },
  })

  try {
    const deadlineAt = new Date(Date.now() + 60_000).toISOString()
    const profile = bootstrapProfile(root, deadlineAt, { workspace, toolNames: ['read'] })
    const packet = contextPacket(profile, deadlineAt)
    const result = await host.run({
      packet: {
        ...packet,
        objective: 'Prove that an ungranted write cannot mutate the workspace.',
        step: {
          ...packet.step,
          instructions: 'tool:write {"path":"created.txt","content":"must-not-exist"}',
        },
      },
      parentUsage: { turns: 0, toolCalls: 0 },
      launch: {
        command: process.execPath,
        args: ['--import', 'tsx', runtimeEntry],
        cwd: process.cwd(),
      },
      bootstrapProfile: profile,
    })

    assert.equal(result.status, 'succeeded')
    assert.match(result.summary, /Unknown tool: write/u)
    assert.deepEqual(
      profile.capabilityBundle.tools.map((tool) => tool.name),
      ['read'],
    )
    assert.equal(packet.budget.maxChildRuns, 0)
    assert.equal(packet.budget.maxParallelChildren, 0)
    assert.equal(packet.budget.maxDepth, 0)
    assert.deepEqual(await readdir(workspace), ['input.txt'])
    assert.equal(await readFile(join(workspace, 'input.txt'), 'utf8'), 'immutable fixture\n')
    assert.equal(await exists(mainHome), false)
    assert.equal(await exists(profile.ephemeral.root), false)
    assert.equal(ledger.scope('production-parent')?.chargedChildRuns, 1)
    assert.equal(ledger.scope('production-parent')?.activeChildren, 0)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('formal child host maps schema-invalid stdout to one stable protocol failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-child-host-protocol-pollution-'))
  const ledger = new InMemorySubagentAdmissionLedger()
  ledger.registerRootScope({
    runId: 'production-parent',
    budget: rootBudget({ maxTurns: 4, maxToolCalls: 4, maxDepth: 2 }),
  })
  const host = new ChildRuntimeHost({
    ledger,
    cancellation: new CancellationTree(),
    handshakeTimeoutMs: 2_000,
    shutdownGraceMs: 100,
  })

  try {
    const deadlineAt = new Date(Date.now() + 60_000).toISOString()
    const profile = bootstrapProfile(root, deadlineAt)
    await assert.rejects(
      host.run({
        packet: contextPacket(profile, deadlineAt),
        parentUsage: { turns: 0, toolCalls: 0 },
        launch: {
          command: process.execPath,
          args: ['--import', 'tsx', schemaInvalidRuntime],
          cwd: process.cwd(),
        },
        bootstrapProfile: profile,
      }),
      (error: unknown) => hasErrorCode(error, 'CHILD_RUNTIME_PROTOCOL_INVALID'),
    )
    assert.equal(ledger.scope('production-parent')?.chargedChildRuns, 0)
    assert.equal(ledger.scope('production-parent')?.activeChildren, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parent cancellation yields one child terminal result and bounded stderr trace metadata', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-child-host-parent-cancel-'))
  const events: SubagentAdmissionEvent[] = []
  const trace: ChildRuntimeTraceEventV1[] = []
  const cancellation = new CancellationTree()
  const ledger = new InMemorySubagentAdmissionLedger({ events: (event) => events.push(event) })
  ledger.registerRootScope({
    runId: 'production-parent',
    budget: rootBudget({ maxTurns: 4, maxToolCalls: 4, maxDepth: 2 }),
  })
  const host = new ChildRuntimeHost({
    ledger,
    cancellation,
    handshakeTimeoutMs: 5_000,
    shutdownGraceMs: 500,
    trace: {
      record(event) {
        trace.push(event)
      },
    },
  })

  try {
    const deadlineAt = new Date(Date.now() + 60_000).toISOString()
    const profile = bootstrapProfile(home, deadlineAt)
    const packet = contextPacket(profile, deadlineAt)
    const execution = host.run({
      packet,
      parentUsage: { turns: 0, toolCalls: 0 },
      launch: {
        command: process.execPath,
        args: ['--import', 'tsx', controlledRuntime],
        cwd: process.cwd(),
      },
      bootstrapProfile: profile,
    })

    await waitFor(() =>
      events.some((event) => event.type === 'child_execution_accepted_and_charged'),
    )
    assert.deepEqual(host.cancel('production-parent', 'user_abort'), [
      ['production-parent', 'user_abort'],
      ['production-child', 'parent_cancelled'],
    ])
    const result = await execution

    assert.equal(result.status, 'cancelled')
    assert.equal(result.error?.code, 'CHILD_PARENT_CANCELLED')
    assert.deepEqual(result.usage, { turns: 0, toolCalls: 0, subagents: 0 })
    assert.equal(cancellation.reasonFor('production-parent'), 'user_abort')
    assert.equal(cancellation.reasonFor('production-child'), 'parent_cancelled')
    assert.deepEqual(host.cancel('production-parent', 'user_abort'), [])
    assert.equal(ledger.scope('production-parent')?.chargedChildRuns, 1)
    assert.equal(ledger.scope('production-parent')?.activeChildren, 0)
    assert.equal(ledger.scope('production-child'), undefined)
    assert.equal(trace.filter((event) => event.phase === 'terminal').length, 1)
    const terminalTrace = trace.find((event) => event.phase === 'terminal')
    assert.equal(terminalTrace?.outcome, 'cancelled')
    assert.equal(terminalTrace?.code, 'CHILD_PARENT_CANCELLED')
    assert.equal(terminalTrace?.stderr?.capturedBytes, 16 * 1024)
    assert.equal(terminalTrace?.stderr?.totalBytes, 20 * 1024)
    assert.equal(terminalTrace?.stderr?.truncated, true)
    assert.match(terminalTrace?.stderr?.digest ?? '', /^sha256:[a-f0-9]{64}$/u)
    assert.equal('content' in (terminalTrace?.stderr ?? {}), false)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('execution deadline is independent from handshake timeout and aborts the child subtree', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-child-host-deadline-'))
  const cancellation = new CancellationTree()
  const ledger = new InMemorySubagentAdmissionLedger()
  ledger.registerRootScope({
    runId: 'production-parent',
    budget: rootBudget({ maxTurns: 4, maxToolCalls: 4, maxDepth: 2 }),
  })
  const host = new ChildRuntimeHost({
    ledger,
    cancellation,
    handshakeTimeoutMs: 1_500,
    shutdownGraceMs: 500,
  })

  try {
    const deadlineAt = new Date(Date.now() + 5_000).toISOString()
    const profile = bootstrapProfile(home, deadlineAt)
    const packet = contextPacket(profile, deadlineAt)
    const startedAt = Date.now()
    const result = await host.run({
      packet,
      parentUsage: { turns: 0, toolCalls: 0 },
      launch: {
        command: process.execPath,
        args: ['--import', 'tsx', controlledRuntime],
        cwd: process.cwd(),
      },
      bootstrapProfile: profile,
    })

    assert.equal(result.status, 'cancelled')
    assert.equal(result.error?.code, 'CHILD_DEADLINE_EXCEEDED')
    assert.equal(result.retryable, true)
    assert.equal(cancellation.reasonFor('production-parent'), undefined)
    assert.equal(cancellation.reasonFor('production-child'), 'deadline_exceeded')
    assert.ok(Date.now() - startedAt >= 3_000)
    assert.ok(Date.now() - startedAt < 10_000)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('no-progress deadline aborts an idle child without consuming its total deadline', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-child-host-no-progress-'))
  const cancellation = new CancellationTree()
  const ledger = new InMemorySubagentAdmissionLedger()
  ledger.registerRootScope({
    runId: 'production-parent',
    budget: rootBudget({ maxTurns: 4, maxToolCalls: 4, maxDepth: 2 }),
  })
  const host = new ChildRuntimeHost({
    ledger,
    cancellation,
    handshakeTimeoutMs: 1_500,
    shutdownGraceMs: 500,
    noProgressTimeoutMs: 1_000,
  })

  try {
    const deadlineAt = new Date(Date.now() + 30_000).toISOString()
    const profile = bootstrapProfile(home, deadlineAt)
    const startedAt = Date.now()
    const result = await host.run({
      packet: contextPacket(profile, deadlineAt),
      parentUsage: { turns: 0, toolCalls: 0 },
      launch: {
        command: process.execPath,
        args: ['--import', 'tsx', controlledRuntime],
        cwd: process.cwd(),
      },
      bootstrapProfile: profile,
    })

    assert.equal(result.error?.code, 'CHILD_DEADLINE_EXCEEDED')
    assert.match(result.summary, /no-progress deadline/u)
    assert.ok(Date.now() - startedAt < 10_000)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('formal child host denies an out-of-workspace read without consulting parent policy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-child-host-permission-'))
  const ledger = new InMemorySubagentAdmissionLedger()
  ledger.registerRootScope({
    runId: 'production-parent',
    budget: rootBudget({ maxTurns: 4, maxToolCalls: 4, maxDepth: 2 }),
  })
  let parentDecisions = 0
  const host = new ChildRuntimeHost({
    ledger,
    cancellation: new CancellationTree(),
    requestTimeoutMs: 20_000,
    permissionDecisions: {
      decide() {
        parentDecisions += 1
        return { type: 'allow_once' }
      },
    },
  })

  try {
    const deadlineAt = new Date(Date.now() + 60_000).toISOString()
    const profile = bootstrapProfile(home, deadlineAt)
    const packet = contextPacket(profile, deadlineAt)
    const outside = resolve(process.cwd(), '..', 'praxis-child-outside.txt')
    const result = await host.run({
      packet: {
        ...packet,
        step: {
          ...packet.step,
          instructions: `tool:read ${JSON.stringify({ path: outside, limit: 5 })}`,
        },
      },
      parentUsage: { turns: 0, toolCalls: 0 },
      launch: {
        command: process.execPath,
        args: ['--import', 'tsx', runtimeEntry],
        cwd: process.cwd(),
      },
      bootstrapProfile: profile,
    })

    assert.equal(result.status, 'succeeded')
    assert.match(result.summary, /permission denied \(outside_signed_grant\)/iu)
    assert.equal(parentDecisions, 0)
    assert.equal(ledger.scope('production-parent')?.chargedChildRuns, 1)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('shipping Runtime reserves protocol-version errors for schema-valid initialize requests', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-child-host-version-'))
  const request = {
    jsonrpc: '2.0' as const,
    id: 'initialize-version-mismatch',
    method: 'initialize' as const,
    params: {
      protocolVersion: 1 as const,
      supportedProtocolVersions: [2],
      client: { name: 'child-runtime-host-test', version: '1' },
      capabilities: { interactivePermissions: false, outputFormats: ['json'] as const },
    },
  }
  assertProtocolMessage(request)

  try {
    const response = await requestShippingRuntime(home, request)
    assert.equal(response.id, request.id)
    assert.equal(response.error?.code, 'PROTOCOL_VERSION_UNSUPPORTED')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

function bootstrapProfile(
  root: string,
  deadlineAt: string,
  options: { workspace?: string; toolNames?: readonly string[] } = {},
) {
  const ephemeralRoot = join(root, 'ephemeral')
  const workspace = resolve(options.workspace ?? process.cwd())
  const methodAllowlist = [
    'initialize',
    'events.subscribe',
    'session.create',
    'session.prompt',
    'permission.decide',
    'session.abort',
    'shutdown',
  ] as const
  const capabilityBundle = mockChildCapabilityBundle({
    methods: methodAllowlist,
    workspace,
    ...(options.toolNames === undefined ? {} : { toolNames: options.toolNames }),
  })
  return {
    schemaVersion: 3 as const,
    workspace: { root: workspace, access: 'read_only' as const },
    methodAllowlist,
    ephemeral: {
      root: ephemeralRoot,
      sessionRoot: join(ephemeralRoot, 'sessions'),
      traceRoot: join(ephemeralRoot, 'traces'),
      artifactRoot: join(ephemeralRoot, 'artifacts'),
      retention: 'delete' as const,
    },
    provider: { providerId: 'mock', model: 'mock-v1' },
    capabilityBundleDigest: capabilityBundle.digest,
    capabilityBundle,
    deadlineAt,
    trace: { traceId: 'trace-child-bootstrap', parentTraceId: 'trace-parent-bootstrap' },
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function contextPacket(
  profile: ReturnType<typeof bootstrapProfile>,
  deadlineAt: string,
): ContextPacketV1 {
  return {
    schemaVersion: 1,
    packetId: 'formal-child-packet',
    parentRunId: 'production-parent',
    childRunId: 'production-child',
    objective: 'Read the workspace package manifest and report bounded evidence.',
    step: {
      stepId: 'formal-child-step',
      title: 'Read package manifest',
      instructions: 'tool:read {"path":"package.json","limit":5}',
    },
    constraints: ['Use only the signed child capability grant.'],
    relevantRefs: [
      {
        kind: 'file',
        ref: 'package.json',
        digest: `sha256:${'0'.repeat(64)}`,
        summary: 'Workspace package manifest.',
      },
    ],
    successCriteria: [
      { id: 'manifest-read', description: 'The package manifest is read successfully.' },
    ],
    workspace: profile.workspace,
    grant: {
      bundleId: profile.capabilityBundle.bundleId,
      bundleDigest: profile.capabilityBundle.digest,
      provider: profile.provider,
      tools: profile.capabilityBundle.tools.map((tool) => tool.name),
      skills: profile.capabilityBundle.skills.map((skill) => skill.id),
      methods: [...profile.capabilityBundle.methodAllowlist],
      mcpMode: profile.capabilityBundle.mcp.mode,
    },
    budget: requestedBudget({
      maxTurns: 2,
      maxToolCalls: 2,
      maxTokens: 1_000,
      maxDepth: 0,
      deadlineAt,
    }),
    prohibitions: ['Do not write files.', 'Do not access capabilities outside the grant.'],
    outputSchema: {
      format: 'json',
      schema: {
        type: 'object',
        required: ['summary', 'criteria'],
        properties: {
          summary: { type: 'string' },
          criteria: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'status', 'summary'],
              properties: {
                id: { type: 'string' },
                status: { enum: ['passed', 'failed', 'skipped'] },
                summary: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      maxInlineBytes: 4_096,
      overflow: 'artifact_ref',
    },
  }
}

function rootBudget(overrides: Partial<ExecutionBudget> = {}): ExecutionBudget {
  return {
    maxTurns: 4,
    maxToolCalls: 4,
    maxChildRuns: 1,
    maxParallelChildren: 1,
    maxDepth: 1,
    ...overrides,
  }
}

function requestedBudget(overrides: Partial<ExecutionBudget> = {}): ExecutionBudget {
  return {
    maxTurns: 2,
    maxToolCalls: 1,
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
    ...overrides,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for child admission state.')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function requestShippingRuntime(
  home: string,
  request: Record<string, unknown>,
): Promise<{ id?: string; error?: { code?: string } }> {
  const child = spawn(process.execPath, ['--import', 'tsx', runtimeEntry], {
    cwd: process.cwd(),
    env: { ...process.env, PRAXIS_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length)
  })

  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Timed out waiting for shipping Runtime. stderr=${stderr || '<empty>'}`))
      }, 10_000)
      const cleanup = () => {
        clearTimeout(timer)
        lines.off('line', onLine)
        child.off('error', onError)
        child.off('exit', onExit)
      }
      const onLine = (line: string) => {
        try {
          const response = JSON.parse(line) as { id?: string; error?: { code?: string } }
          assertProtocolMessage(response)
          cleanup()
          resolve(response)
        } catch (error) {
          cleanup()
          reject(error)
        }
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup()
        reject(
          new Error(
            `Shipping Runtime exited before initialize response (code=${String(code)}, signal=${String(signal)}). stderr=${stderr || '<empty>'}`,
          ),
        )
      }
      lines.on('line', onLine)
      child.once('error', onError)
      child.once('exit', onExit)
      child.stdin.write(`${JSON.stringify(request)}\n`)
    })
  } finally {
    child.stdin.end()
    lines.close()
    await terminateProcessTree(child.pid)
    await waitForProcessExit(child, 2_000)
  }
}
