import {
  runtimeError,
  type ExecutionBudget,
  type SessionPlanGraphProjectionV3,
  type SessionStepProjectionV3,
  type SubagentExecutionRequestV1,
  validateSubagentExecutionRequestV1,
} from '@praxis/core-sdk'
import { validateChildCapabilityBundle } from './childCapabilityBundle.js'
import { assertContextPacketAuthority } from './contextPacket.js'
import {
  createSubagentExecutionRequestV1,
  type MaterializedSubagentExecutionV1,
  type SubagentExecutionMaterializer,
} from './subagentExecutor.js'

export type FixedPlanExecutionBuildInputV1 = Readonly<{
  sessionId: string
  parentRunId: string
  plan: SessionPlanGraphProjectionV3
  step: SessionStepProjectionV3
  attemptId: string
  childRunId: string
  /** Per-attempt lease allocated from the parent budget; the Step budget remains a ceiling. */
  budget: Readonly<ExecutionBudget>
}>

export type FixedPlanExecutionBuilderV1 = Readonly<{
  build(
    input: FixedPlanExecutionBuildInputV1,
  ): MaterializedSubagentExecutionV1 | Promise<MaterializedSubagentExecutionV1>
}>

type PendingExecution = Readonly<{
  request: SubagentExecutionRequestV1
  execution: MaterializedSubagentExecutionV1
}>

/**
 * Ephemeral composition bridge between fixed-plan steps and the opaque executor port.
 * Restart recovery interrupts active attempts, so materialized launch objects are never persisted.
 */
export class FixedPlanExecutionRegistryV1 implements SubagentExecutionMaterializer {
  readonly #pending = new Map<string, PendingExecution>()
  readonly #maxPendingExecutions: number

  constructor(
    private readonly builder: FixedPlanExecutionBuilderV1,
    options: Readonly<{ maxPendingExecutions?: number }> = {},
  ) {
    const maximum = options.maxPendingExecutions ?? 1
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32) {
      fail('SUPERVISOR_EXECUTION_REGISTRY_LIMIT_INVALID')
    }
    this.#maxPendingExecutions = maximum
  }

  async create(input: FixedPlanExecutionBuildInputV1): Promise<SubagentExecutionRequestV1> {
    if (this.#pending.size >= this.#maxPendingExecutions || this.#pending.has(input.childRunId)) {
      fail('SUPERVISOR_EXECUTION_REF_CONFLICT')
    }
    const execution = await this.builder.build(input)
    assertExecutionAuthority(input, execution)
    const request = createSubagentExecutionRequestV1(execution)
    this.#pending.set(input.childRunId, Object.freeze({ request, execution }))
    return request
  }

  materialize(input: SubagentExecutionRequestV1): MaterializedSubagentExecutionV1 {
    const request = validateSubagentExecutionRequestV1(input)
    const pending = this.#pending.get(request.childRunId)
    if (pending === undefined || !sameRequest(pending.request, request)) {
      fail('SUPERVISOR_EXECUTION_REF_NOT_FOUND')
    }
    this.#pending.delete(request.childRunId)
    return pending.execution
  }
}

function assertExecutionAuthority(
  input: FixedPlanExecutionBuildInputV1,
  execution: MaterializedSubagentExecutionV1,
): void {
  const profile = execution.bootstrapProfile
  const bundle = validateChildCapabilityBundle(profile.capabilityBundle, {
    digest: profile.capabilityBundleDigest,
    workspace: { root: profile.workspace.root, access: profile.workspace.access },
    provider: profile.provider,
    methodAllowlist: profile.methodAllowlist,
  })
  const packet = assertContextPacketAuthority(execution.packet, {
    workspace: profile.workspace,
    provider: profile.provider,
    capabilityBundle: bundle,
  })
  if (
    input.step.access.paths.length !== 1 ||
    input.step.access.paths[0] !== '.' ||
    profile.workspace.access !== input.step.access.mode ||
    packet.parentRunId !== input.parentRunId ||
    packet.childRunId !== input.childRunId ||
    packet.objective !== input.plan.objective ||
    packet.step.stepId !== input.step.stepId ||
    packet.step.title !== input.step.title ||
    packet.workspace.access !== input.step.access.mode ||
    packet.grant.bundleId !== bundle.bundleId ||
    packet.grant.bundleDigest !== bundle.digest ||
    !sameCriteria(packet.successCriteria, input.step.criteria) ||
    !sameExecutionBudget(packet.budget, input.budget) ||
    !budgetWithinStep(packet.budget, input.step.budget)
  ) {
    fail('SUPERVISOR_EXECUTION_AUTHORITY_MISMATCH')
  }
  if (bundle.mcp.mode === 'child_launch') {
    fail('SUPERVISOR_CHILD_MCP_LAUNCH_DISABLED')
  }
  const realized = new Set([
    ...bundle.tools.map((tool) => tool.name),
    ...bundle.skills.map((skill) => skill.id),
    ...(bundle.mcp.mode === 'parent_broker'
      ? bundle.mcp.toolGrants.map((grant) => grant.name)
      : []),
  ])
  if (input.step.capabilities.some((capability) => !realized.has(capability))) {
    fail('SUPERVISOR_STEP_CAPABILITY_UNAVAILABLE')
  }
  if ([...realized].some((capability) => !input.step.capabilities.includes(capability))) {
    fail('SUPERVISOR_EXECUTION_AUTHORITY_MISMATCH')
  }
}

function sameExecutionBudget(
  child: MaterializedSubagentExecutionV1['packet']['budget'],
  lease: Readonly<ExecutionBudget>,
): boolean {
  return (
    child.maxTurns === lease.maxTurns &&
    child.maxToolCalls === lease.maxToolCalls &&
    child.maxTokens === lease.maxTokens &&
    (lease.deadlineAt === undefined ||
      (child.deadlineAt !== undefined && child.deadlineAt <= lease.deadlineAt)) &&
    child.maxChildRuns === 0 &&
    child.maxParallelChildren === 0 &&
    child.maxDepth === 0
  )
}

function sameCriteria(
  actual: ContextPacketCriteria,
  expected: SessionStepProjectionV3['criteria'],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every(
      (criterion, index) =>
        criterion.id === expected[index]?.criterionId &&
        criterion.description === expected[index]?.description,
    )
  )
}

function budgetWithinStep(
  child: MaterializedSubagentExecutionV1['packet']['budget'],
  step: SessionStepProjectionV3['budget'],
): boolean {
  return (
    child.maxTurns <= step.maxTurns &&
    child.maxToolCalls <= step.maxToolCalls &&
    (step.maxTokens === undefined ||
      (child.maxTokens !== undefined && child.maxTokens <= step.maxTokens)) &&
    child.maxChildRuns === 0 &&
    child.maxParallelChildren === 0 &&
    child.maxDepth === 0 &&
    (step.deadlineAt === undefined ||
      (child.deadlineAt !== undefined && child.deadlineAt <= step.deadlineAt))
  )
}

type ContextPacketCriteria = MaterializedSubagentExecutionV1['packet']['successCriteria']

function sameRequest(left: SubagentExecutionRequestV1, right: SubagentExecutionRequestV1): boolean {
  return (
    left.parentRunId === right.parentRunId &&
    left.childRunId === right.childRunId &&
    sameRef(left.packetRef, right.packetRef) &&
    sameRef(left.profileRef, right.profileRef) &&
    sameRef(left.bundleRef, right.bundleRef) &&
    sameRef(left.budgetRef, right.budgetRef)
  )
}

function sameRef(
  left: SubagentExecutionRequestV1['packetRef'],
  right: SubagentExecutionRequestV1['packetRef'],
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.kind === right.kind &&
    left.id === right.id &&
    left.version === right.version &&
    left.digest === right.digest
  )
}

function fail(code: string): never {
  throw Object.assign(
    new Error(code),
    runtimeError(code, 'subagent', 'Fixed-plan child execution authority was rejected.'),
    { code },
  )
}
