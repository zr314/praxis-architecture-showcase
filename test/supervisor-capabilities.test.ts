import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CancellationTree,
  createSessionCommitV3,
  type ExecutionBudget,
  ReducingSessionJournalV3,
  type RuntimeTool,
  type SessionEntryV3,
  type SessionPlanGraphProjectionV3,
  type SessionStepProjectionV3,
  type SubagentResultV1,
  type ToolDefinition,
  validateSessionEntryV3,
} from '@praxis/core-sdk'
import { ArtifactStore } from '../apps/runtime/src/artifacts/artifactStore.js'
import { McpStdioClient } from '../apps/runtime/src/extensions/mcpStdioClient.js'
import {
  type FixedPlanProposalV1,
  initialPlanJournalPayloadsV3,
  PlanValidator,
} from '../apps/runtime/src/planner/planValidator.js'
import { SerialSupervisor } from '../apps/runtime/src/planner/serialSupervisor.js'
import { MechanicalVerifierV1, RuleVerifierV1 } from '../apps/runtime/src/planner/verifier.js'
import { JsonlSessionJournalV3 } from '../apps/runtime/src/session-db/jsonlSessionJournalV3.js'
import { InMemorySubagentAdmissionLedger } from '../apps/runtime/src/subagent/admission.js'
import type { ChildBootstrapMethod } from '../apps/runtime/src/subagent/childBootstrapProfile.js'
import {
  type ChildCapabilityBundleV1,
  type ChildSkillCandidate,
  compileChildCapabilityBundle,
  digestToolDefinition,
  type McpToolGrant,
} from '../apps/runtime/src/subagent/childCapabilityBundle.js'
import { ChildRuntimeHost } from '../apps/runtime/src/subagent/childRuntimeHost.js'
import type { ContextPacketV1 } from '../apps/runtime/src/subagent/contextPacket.js'
import {
  type FixedPlanExecutionBuildInputV1,
  FixedPlanExecutionRegistryV1,
} from '../apps/runtime/src/subagent/fixedPlanExecutionRegistry.js'
import {
  bindChildMcpBrokerCapability,
  type ChildMcpBrokerCapability,
  ChildMcpToolBroker,
} from '../apps/runtime/src/subagent/mcpBrokerIpc.js'
import { ChildRuntimeSubagentExecutor } from '../apps/runtime/src/subagent/subagentExecutor.js'
import { mockChildCapabilityBundle } from './support/child-capability.js'

const runtimeEntry = fileURLToPath(new URL('../apps/runtime/src/entry.ts', import.meta.url))
const mcpServer = fileURLToPath(new URL('./fixtures/mcp-modern-server.mjs', import.meta.url))
const methods = [
  'initialize',
  'events.subscribe',
  'session.create',
  'session.prompt',
  'permission.decide',
  'session.abort',
  'shutdown',
] as const satisfies readonly ChildBootstrapMethod[]

test('fixed serial Supervisor executes one signed Skill and one parent-broker MCP Tool', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-supervisor-capabilities-'))
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [mcpServer],
    pluginId: 'fixture',
    serverId: 'readonly',
    requestTimeoutMs: 2_000,
  })
  const store = new JsonlSessionJournalV3(join(home, 'journal'))
  await store.initialize()
  const journal = new ReducingSessionJournalV3(store)
  const artifacts = new ArtifactStore(join(home, 'artifacts'))
  const skill = skillCandidate('skill:review', 'Review only the selected workspace files.')
  const parentTool = client.runtimeTools()[0]!
  const mcpGrant = readOnlyMcpGrant(parentTool, 16 * 1024)
  const skillBundle = mockChildCapabilityBundle({ methods, skills: [skill], toolNames: [] })
  const mcpBundle = mockChildCapabilityBundle({
    methods,
    toolNames: [],
    mcpToolGrants: [mcpGrant],
  })
  let activeMcp: ChildMcpBrokerCapability | undefined
  const broker = new ChildMcpToolBroker((id) =>
    activeMcp?.grant.brokerCapabilityId === id ? activeMcp : undefined,
  )
  const ledger = new InMemorySubagentAdmissionLedger()
  ledger.registerRootScope({ runId: 'run-parent', budget: rootBudget() })
  const host = new ChildRuntimeHost({
    ledger,
    cancellation: new CancellationTree(),
    mcpBroker: broker,
    handshakeTimeoutMs: 10_000,
    shutdownGraceMs: 500,
  })
  const registry = new FixedPlanExecutionRegistryV1({
    build(input) {
      const usesSkill = input.step.capabilities.includes(skill.id)
      const bundle = usesSkill ? skillBundle : mcpBundle
      const execution = childExecution(home, input, bundle, usesSkill ? 'skill' : 'mcp', mcpGrant)
      if (!usesSkill) {
        activeMcp = bindChildMcpBrokerCapability(
          mcpGrant,
          parentTool,
          brokerAuthority(bundle, input.parentRunId, input.childRunId),
        )
      }
      return execution
    },
  })
  const executor = new ChildRuntimeSubagentExecutor({
    host,
    materializer: registry,
    permissionDecisions: { decide: () => ({ type: 'deny' }) },
  })
  let executorError: unknown
  const observedExecutor = {
    async execute(request: Parameters<ChildRuntimeSubagentExecutor['execute']>[0]) {
      try {
        return await executor.execute(request)
      } catch (error) {
        executorError = error
        throw error
      }
    },
    cancel: (request: Parameters<ChildRuntimeSubagentExecutor['cancel']>[0]) =>
      executor.cancel(request),
  }

  try {
    const graph = await seedPlan(journal, capabilityProposal(skill.id, mcpGrant.name))
    let id = 100
    const supervisor = new SerialSupervisor({
      journal,
      executor: observedExecutor,
      requestFactory: registry,
      artifactStore: artifacts,
      mechanicalVerifier: new MechanicalVerifierV1({
        fileDigest: async () => `sha256:${'0'.repeat(64)}`,
        runCheck: async () => ({ passed: false, evidenceRefs: [] }),
        validateSchema: async () => ({ passed: true, evidenceRefs: ['schema://subagent'] }),
      }),
      ruleVerifier: new RuleVerifierV1(),
      createId: (kind) => `${kind.replaceAll(/[^A-Za-z0-9._:/@+-]/gu, '-')}-${++id}`,
      now: () => '2026-08-03T00:00:00.000Z',
    })

    const outcome = await supervisor.execute({
      sessionId: 'session-supervisor-capabilities',
      parentRunId: 'run-parent',
      planId: graph.planId,
    })
    const projection = await journal.loadProjection('session-supervisor-capabilities')
    assert.deepEqual(
      outcome,
      { planId: graph.planId, state: 'succeeded' },
      JSON.stringify({
        executorError:
          typeof executorError === 'object' && executorError !== null
            ? (executorError as { code?: unknown }).code
            : String(executorError),
        run: projection.snapshot.runs[0],
        plan: projection.planGraph,
      }),
    )
    assert.deepEqual(
      projection.planGraph?.steps.map((step) => step.state),
      ['succeeded', 'succeeded'],
    )
    const results = await Promise.all(
      (await artifacts.list()).map((artifact) => artifacts.read(artifact.artifactId)),
    )
    const evidence = results.flatMap((result) => (result as SubagentResultV1).evidenceRefs)
    assert.deepEqual(
      new Set(evidence.map((item) => item.mediaType)),
      new Set([
        'application/vnd.praxis.skill-invocation+json',
        'application/vnd.praxis.mcp-tool-result+json',
      ]),
    )
    assert.equal(
      results.some((result) => /skill:review/iu.test((result as SubagentResultV1).summary)),
      true,
    )
    assert.equal(
      results.some((result) => /brokered-supervisor/iu.test((result as SubagentResultV1).summary)),
      true,
    )
  } finally {
    await client.shutdown()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('Supervisor capability names cannot bypass unauthorized, disabled, or quarantined Skill gates', async () => {
  for (const status of ['unauthorized', 'disabled', 'quarantined'] as const) {
    const skill = skillCandidate(
      'skill:blocked',
      'Blocked content.',
      status === 'unauthorized' ? 'enabled' : status,
    )
    const bundle = mockChildCapabilityBundle({
      methods,
      skills: status === 'unauthorized' ? [] : [skill],
      toolNames: [],
    })
    const registry = new FixedPlanExecutionRegistryV1({
      build: (input) => childExecution(process.cwd(), input, bundle, 'skill'),
    })

    await assert.rejects(
      registry.create(buildInput('skill:blocked')),
      hasCode('SUPERVISOR_STEP_CAPABILITY_UNAVAILABLE'),
    )
  }
})

test('Supervisor keeps unverified child-launch MCP categorically disabled', async () => {
  const bundle = childLaunchBundle()
  const registry = new FixedPlanExecutionRegistryV1({
    build: (input) => childExecution(process.cwd(), input, bundle, 'none'),
  })

  await assert.rejects(
    registry.create(buildInput()),
    hasCode('SUPERVISOR_CHILD_MCP_LAUNCH_DISABLED'),
  )
})

test('fixed-plan execution registry bounds concurrent opaque materializations', async () => {
  const bundle = mockChildCapabilityBundle({ methods, skills: [], toolNames: [] })
  const registry = new FixedPlanExecutionRegistryV1(
    {
      build: (input) => childExecution(process.cwd(), input, bundle, 'none'),
    },
    { maxPendingExecutions: 2 },
  )
  const firstInput = executionInput('first')
  const secondInput = executionInput('second')
  const thirdInput = executionInput('third')
  const first = await registry.create(firstInput)
  const second = await registry.create(secondInput)
  await assert.rejects(registry.create(thirdInput), hasCode('SUPERVISOR_EXECUTION_REF_CONFLICT'))
  assert.equal(registry.materialize(first).packet.childRunId, firstInput.childRunId)
  const third = await registry.create(thirdInput)
  assert.equal(registry.materialize(second).packet.childRunId, secondInput.childRunId)
  assert.equal(registry.materialize(third).packet.childRunId, thirdInput.childRunId)
  assert.throws(
    () =>
      new FixedPlanExecutionRegistryV1(
        { build: (input) => childExecution(process.cwd(), input, bundle, 'none') },
        { maxPendingExecutions: 0 },
      ),
    hasCode('SUPERVISOR_EXECUTION_REGISTRY_LIMIT_INVALID'),
  )
})

test('Supervisor materialization rejects broader bundle or path authority than the Step', async () => {
  const skill = skillCandidate('skill:extra', 'Extra content.')
  const extraBundle = mockChildCapabilityBundle({ methods, skills: [skill], toolNames: [] })
  const extraRegistry = new FixedPlanExecutionRegistryV1({
    build: (input) => childExecution(process.cwd(), input, extraBundle, 'none'),
  })
  await assert.rejects(
    extraRegistry.create(buildInput()),
    hasCode('SUPERVISOR_EXECUTION_AUTHORITY_MISMATCH'),
  )

  const emptyBundle = mockChildCapabilityBundle({ methods, skills: [], toolNames: [] })
  const narrowedRegistry = new FixedPlanExecutionRegistryV1({
    build: (input) => childExecution(process.cwd(), input, emptyBundle, 'none'),
  })
  await assert.rejects(
    narrowedRegistry.create(buildInput(undefined, ['src'])),
    hasCode('SUPERVISOR_EXECUTION_AUTHORITY_MISMATCH'),
  )
})

async function seedPlan(journal: ReducingSessionJournalV3, proposal: FixedPlanProposalV1) {
  const graph = new PlanValidator({
    parentBudget: rootBudget(),
    defaultStepBudget: { maxTurns: 2, maxToolCalls: 2, maxTokens: 1_000 },
    accessGrant: { mode: 'read_only', paths: ['.'] },
    allowedCapabilities: proposal.steps.flatMap((step) => step.capabilities ?? []),
    createId: (kind, source) => `${kind}-${source.replaceAll(':', '-')}`,
  }).validate(proposal)
  const payloads = initialPlanJournalPayloadsV3(graph)
  await journal.appendCommit(
    createSessionCommitV3({
      sessionId: 'session-supervisor-capabilities',
      commitId: 'commit-initial',
      expectedRevision: 0,
      idempotencyKey: 'idem-initial',
      entries: [
        entry(1, 'session.created', {
          cwd: resolve(process.cwd()),
          provider: 'mock',
          model: 'mock-v1',
          name: 'Supervisor capability smoke',
          labels: [],
        }),
        entry(2, 'run.started', { clientRequestId: 'request-parent' }, 'run-parent'),
        ...payloads.map((payload, index) =>
          entry(index + 3, payload.type, payload.data as Record<string, unknown>, 'run-parent'),
        ),
      ],
    }),
  )
  return graph
}

function capabilityProposal(skillId: string, mcpName: string): FixedPlanProposalV1 {
  return {
    objective: 'Exercise enabled child capability categories.',
    steps: [
      {
        key: 'skill',
        title: 'Invoke signed Skill',
        access: { mode: 'read_only', paths: ['.'] },
        capabilities: [skillId],
        criteria: [{ kind: 'schema', description: 'Child result schema is valid.' }],
      },
      {
        key: 'mcp',
        title: 'Invoke brokered MCP Tool',
        dependencies: ['skill'],
        access: { mode: 'read_only', paths: ['.'] },
        capabilities: [mcpName],
        criteria: [{ kind: 'schema', description: 'Child result schema is valid.' }],
      },
    ],
  }
}

function childExecution(
  home: string,
  input: FixedPlanExecutionBuildInputV1,
  bundle: ChildCapabilityBundleV1,
  capability: 'skill' | 'mcp' | 'none',
  mcpGrant?: McpToolGrant,
) {
  const root = join(home, `ephemeral-${input.childRunId}`)
  const deadlineAt = new Date(Date.now() + 30_000).toISOString()
  const profile = {
    schemaVersion: 3 as const,
    workspace: bundle.workspace,
    methodAllowlist: methods,
    ephemeral: {
      root,
      sessionRoot: join(root, 'sessions'),
      traceRoot: join(root, 'traces'),
      artifactRoot: join(root, 'artifacts'),
      retention: 'delete' as const,
    },
    provider: bundle.provider.target,
    capabilityBundleDigest: bundle.digest,
    capabilityBundle: bundle,
    deadlineAt,
    trace: { traceId: `trace-${input.childRunId}`, parentTraceId: 'trace-parent' },
  }
  return {
    packet: contextPacket(input, bundle, deadlineAt, capability, mcpGrant),
    parentUsage: { turns: 0, toolCalls: 0 },
    launch: {
      command: process.execPath,
      args: ['--import', 'tsx', runtimeEntry],
      cwd: process.cwd(),
    },
    bootstrapProfile: profile,
  }
}

function contextPacket(
  input: FixedPlanExecutionBuildInputV1,
  bundle: ChildCapabilityBundleV1,
  deadlineAt: string,
  capability: 'skill' | 'mcp' | 'none',
  mcpGrant?: McpToolGrant,
): ContextPacketV1 {
  const instructions =
    capability === 'skill'
      ? 'tool:skill {"name":"skill:review","arguments":"package.json"}'
      : capability === 'mcp'
        ? `tool:${mcpGrant!.name} {"value":"brokered-supervisor"}`
        : 'Return without invoking a capability.'
  return {
    schemaVersion: 1,
    packetId: `packet-${input.childRunId}`,
    parentRunId: input.parentRunId,
    childRunId: input.childRunId,
    objective: input.plan.objective,
    step: { stepId: input.step.stepId, title: input.step.title, instructions },
    constraints: ['Use only the signed child capability bundle.'],
    relevantRefs: [],
    successCriteria: input.step.criteria.map((criterion) => ({
      id: criterion.criterionId,
      description: criterion.description,
    })),
    workspace: bundle.workspace,
    grant: {
      bundleId: bundle.bundleId,
      bundleDigest: bundle.digest,
      provider: bundle.provider.target,
      tools: bundle.tools.map((tool) => tool.name),
      skills: bundle.skills.map((skill) => skill.id),
      methods: [...bundle.methodAllowlist],
      mcpMode: bundle.mcp.mode,
    },
    budget: {
      maxTurns: 2,
      maxToolCalls: 2,
      maxTokens: 1_000,
      maxChildRuns: 0,
      maxParallelChildren: 0,
      maxDepth: 0,
      deadlineAt,
    },
    prohibitions: ['Do not write files.', 'Do not spawn descendants.'],
    outputSchema: {
      format: 'json',
      schema: { type: 'object' },
      maxInlineBytes: 4_096,
      overflow: 'artifact_ref',
    },
  }
}

function buildInput(
  capability?: string,
  paths: readonly string[] = ['.'],
): FixedPlanExecutionBuildInputV1 {
  const step = {
    stepId: 'step-capability',
    title: 'Invoke capability',
    order: 0,
    state: 'pending',
    dependencies: [],
    access: { mode: 'read_only', paths },
    capabilities: capability === undefined ? [] : [capability],
    conflictKeys: [],
    criteria: [
      {
        criterionId: 'criterion-schema',
        kind: 'schema',
        description: 'Child result schema is valid.',
      },
    ],
    budget: {
      maxTurns: 2,
      maxToolCalls: 2,
      maxTokens: 1_000,
      maxChildRuns: 0,
      maxParallelChildren: 0,
      maxDepth: 0,
    },
    maxAttempts: 1,
    attemptIds: [],
    attempts: [],
  } as const satisfies SessionStepProjectionV3
  const plan = {
    schemaVersion: 1,
    planId: 'plan-capability',
    revision: 1,
    objective: 'Exercise a capability.',
    state: 'running',
    steps: [step],
    readyStepIds: [step.stepId],
  } as const satisfies SessionPlanGraphProjectionV3
  return {
    sessionId: 'session-capability',
    parentRunId: 'run-parent',
    plan,
    step,
    budget: step.budget,
    attemptId: 'attempt-capability',
    childRunId: 'child-capability',
  }
}

function executionInput(suffix: string): FixedPlanExecutionBuildInputV1 {
  return {
    ...buildInput(),
    attemptId: `attempt-${suffix}`,
    childRunId: `child-${suffix}`,
  }
}

function childLaunchBundle(): ChildCapabilityBundleV1 {
  const workspace = resolve(process.cwd())
  const provider = { providerId: 'mock', model: 'mock-v1' }
  return compileChildCapabilityBundle({
    bundleId: 'bundle-child-launch-disabled',
    parent: {
      workspace,
      providerTargets: [provider],
      tools: [],
      skills: [],
      mcp: {
        mode: 'child_launch',
        serverManifests: [
          {
            pluginId: 'fixture',
            serverId: 'disabled',
            version: '1.0.0',
            digest: `sha256:${'1'.repeat(64)}`,
            entryRef: 'plugin://fixture/mcp/disabled',
          },
        ],
      },
    },
    workspace: { root: workspace, access: 'read_only' },
    provider: { target: provider, credential: { kind: 'none', mode: 'mock' } },
    step: { toolNames: [], skillIds: [], methodAllowlist: methods, mcpMode: 'child_launch' },
    policy: {
      toolNames: [],
      skillIds: [],
      methodAllowlist: methods,
      providerTargets: [provider],
      mcpModes: ['child_launch'],
    },
    isolation: {
      builtinToolNames: [],
      allowInlineSkills: false,
      methodAllowlist: methods,
      providerTargets: [provider],
      credentialKinds: ['none'],
      mcpModes: ['child_launch'],
    },
  }).bundle
}

function skillCandidate(
  id: string,
  content: string,
  status: ChildSkillCandidate['status'] = 'enabled',
): ChildSkillCandidate {
  return {
    id,
    localId: id.slice(id.indexOf(':') + 1),
    name: id.slice(id.indexOf(':') + 1),
    description: 'Signed child fixture Skill.',
    origin: 'test://supervisor-skill-fixture',
    digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    disableModelInvocation: false,
    content,
    status,
  }
}

function readOnlyMcpGrant(tool: RuntimeTool, maxInlineBytes: number): McpToolGrant {
  const definition: ToolDefinition = {
    ...structuredClone(tool.definition),
    execution: {
      sideEffect: 'read',
      target: { kind: 'workspace' },
      parallelSafe: true,
      conflictScope: 'workspace',
      maxInlineBytes,
      timeoutMs: 5_000,
    },
  }
  return {
    name: definition.name,
    definition,
    definitionDigest: digestToolDefinition(definition),
    brokerCapabilityId: 'mcp-broker-supervisor-read',
  }
}

function brokerAuthority(bundle: ChildCapabilityBundleV1, parentRunId: string, childRunId: string) {
  return {
    parentRunId,
    childRunId,
    workspace: bundle.workspace.root,
    bundleId: bundle.bundleId,
    bundleDigest: bundle.digest,
  }
}

function rootBudget(): ExecutionBudget {
  return {
    maxTurns: 8,
    maxToolCalls: 8,
    maxTokens: 8_000,
    maxChildRuns: 2,
    maxParallelChildren: 1,
    maxDepth: 1,
  }
}

function entry(
  sequence: number,
  type: string,
  data: Record<string, unknown>,
  runId?: string,
): SessionEntryV3 {
  return validateSessionEntryV3({
    schemaVersion: 3,
    entryId: `entry-${sequence}`,
    sessionId: 'session-supervisor-capabilities',
    sequence,
    revision: 1,
    timestamp: '2026-08-03T00:00:00.000Z',
    type,
    ...(runId === undefined ? {} : { runId }),
    data,
  })
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
