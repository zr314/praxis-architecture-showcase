import { randomUUID } from 'node:crypto'
import {
  createSessionCommitV3,
  runtimeError,
  validateSessionEntryV3,
  validateSubagentExecutionRequestV1,
  type BudgetUsage,
  type ExecutionBudget,
  type SessionAttemptProjectionV3,
  type SessionJournalV3,
  type SessionPlanGraphProjectionV3,
  type SessionProjectionV3,
  type SessionStepProjectionV3,
  type SubagentExecutionRequestV1,
} from '@praxis/core-sdk'
import { currentRunBudgetUsageV1 } from './runBudgetUsage.js'

const MAX_PARALLEL_STEPS = 32
const ACTIVE_ATTEMPT_STATES = new Set(['reserved', 'running', 'execution_succeeded', 'verifying'])

export type RecoveryDependencyIncompatibilityCodeV1 =
  | 'RECOVERY_DEPENDENCY_NOT_FOUND'
  | 'RECOVERY_DEPENDENCY_VERSION_MISMATCH'
  | 'RECOVERY_DEPENDENCY_DIGEST_MISMATCH'
  | 'RECOVERY_CAPABILITY_DRIFT'
  | 'RECOVERY_PROFILE_INCOMPATIBLE'

export type DagRecoveryBlockCodeV1 =
  | RecoveryDependencyIncompatibilityCodeV1
  | 'RECOVERY_DEPENDENCY_BINDING_MISSING'
  | 'RECOVERY_DEPENDENCY_RESOLVER_FAILED'
  | 'RECOVERY_DEPENDENCY_REBUILD_INVALID'
  | 'RECOVERY_RETRY_NOT_SAFE'
  | 'RECOVERY_WORKSPACE_WRITE_UNSAFE'
  | 'RECOVERY_STEP_DEADLINE_EXCEEDED'
  | 'RECOVERY_ATTEMPT_LIMIT_REACHED'
  | 'RECOVERY_CHILD_BUDGET_EXHAUSTED'
  | 'RECOVERY_PARALLEL_CAPACITY_EXHAUSTED'
  | 'RECOVERY_CONFLICT_UNSAFE'
  | 'RECOVERY_PARENT_BUDGET_EXHAUSTED'

export type RecoveryDependencyResolverV1 = Readonly<{
  rebuild(
    input: Readonly<{
      sessionId: string
      parentRunId: string
      plan: SessionPlanGraphProjectionV3
      step: SessionStepProjectionV3
      interruptedAttempt: SessionAttemptProjectionV3
      persistedRequest: SubagentExecutionRequestV1
      newAttemptId: string
      newChildRunId: string
    }>,
  ): Promise<
    | Readonly<{ status: 'compatible'; request: SubagentExecutionRequestV1 }>
    | Readonly<{ status: 'incompatible'; code: RecoveryDependencyIncompatibilityCodeV1 }>
  >
}>

export type DagRecoveryPolicyV1 = Readonly<{
  maxParallelSteps?: number
}>

export type DagRecoveryInputV1 = Readonly<{
  sessionId: string
  parentRunId: string
  planId: string
  parentBudget: Readonly<ExecutionBudget>
}>

export type DagRecoveredClaimV1 = Readonly<{
  stepId: string
  previousAttemptId: string
  attemptId: string
  childRunId: string
  request: SubagentExecutionRequestV1
}>

export type DagRecoveryDecisionV1 = Readonly<{
  state: 'idle' | 'rescheduled' | 'blocked' | 'mixed'
  revision: number
  rescheduled: readonly DagRecoveredClaimV1[]
  blocked: readonly Readonly<{
    stepId: string
    attemptId: string
    code: DagRecoveryBlockCodeV1
  }>[]
  unknownUsage: readonly Readonly<{ attemptId: string; usage: Readonly<BudgetUsage> }>[]
}>

type JournalEventDraft = Readonly<{
  type: string
  data: Record<string, unknown>
  correlation: Record<string, string>
}>

type RecoveryCandidate = Readonly<{
  step: SessionStepProjectionV3
  attempt: SessionAttemptProjectionV3
  unknownUsage?: Readonly<BudgetUsage>
}>

type RecoveryResolution =
  | Readonly<{
      kind: 'reschedule'
      candidate: RecoveryCandidate
      claim: DagRecoveredClaimV1
    }>
  | Readonly<{
      kind: 'block'
      candidate: RecoveryCandidate
      code: DagRecoveryBlockCodeV1
    }>

/** Rebuilds only durable, versioned child dependencies after a parent-process restart. */
export class DagRecoveryCoordinatorV1 {
  readonly #maxParallelSteps: number
  readonly #createId: (kind: string) => string
  readonly #now: () => string

  constructor(
    private readonly journal: SessionJournalV3,
    private readonly resolver: RecoveryDependencyResolverV1,
    policy: DagRecoveryPolicyV1 = {},
    options: Readonly<{ createId?: (kind: string) => string; now?: () => string }> = {},
  ) {
    const maxParallelSteps = policy.maxParallelSteps ?? 2
    if (
      !Number.isSafeInteger(maxParallelSteps) ||
      maxParallelSteps < 1 ||
      maxParallelSteps > MAX_PARALLEL_STEPS
    ) {
      fail('DAG_RECOVERY_POLICY_INVALID')
    }
    this.#maxParallelSteps = maxParallelSteps
    this.#createId = options.createId ?? ((kind) => `${kind}-${randomUUID()}`)
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async recover(input: DagRecoveryInputV1): Promise<DagRecoveryDecisionV1> {
    validateInput(input)
    const projection = await this.journal.loadProjection(input.sessionId)
    const plan = requirePlan(projection, input.planId)
    if (plan.state !== 'running') return emptyDecision(projection)
    requireActiveRun(projection, input.parentRunId)

    const candidates = collectCandidates(plan)
    if (candidates.length === 0) return emptyDecision(projection)

    const resolutions: RecoveryResolution[] = []
    const conflictKeys = new Set<string>()
    const now = this.#now()
    let remainingChildren = Math.max(0, input.parentBudget.maxChildRuns - countAttempts(plan))
    let remainingParallel = Math.min(this.#maxParallelSteps, input.parentBudget.maxParallelChildren)
    let remainingUsage = remainingBudget(
      input.parentBudget,
      currentRunBudgetUsageV1(projection, input.parentRunId),
    )

    for (const candidate of candidates) {
      remainingUsage = subtractUsage(remainingUsage, candidate.unknownUsage)
      const staticBlock = recoveryBlock(
        candidate,
        now,
        remainingChildren,
        remainingParallel,
        remainingUsage,
        conflictKeys,
      )
      if (staticBlock !== undefined) {
        resolutions.push({ kind: 'block', candidate, code: staticBlock })
        continue
      }

      const attemptId = this.#createId('attempt')
      const childRunId = this.#createId('child-run')
      const rebuilt = await rebuildSafely(
        this.resolver,
        input,
        plan,
        candidate,
        attemptId,
        childRunId,
      )
      if (rebuilt.status === 'incompatible') {
        resolutions.push({ kind: 'block', candidate, code: rebuilt.code })
        continue
      }

      const claim = Object.freeze({
        stepId: candidate.step.stepId,
        previousAttemptId: candidate.attempt.attemptId,
        attemptId,
        childRunId,
        request: rebuilt.request,
      })
      resolutions.push({ kind: 'reschedule', candidate, claim })
      remainingChildren -= 1
      remainingParallel -= 1
      remainingUsage = subtractBudget(remainingUsage, candidate.step.budget)
      for (const key of candidate.step.conflictKeys) conflictKeys.add(key)
    }

    const events = resolutions.flatMap((resolution) => recoveryEvents(input, plan, resolution))
    const token = this.#createId('dag-recovery')
    const revision = projection.snapshot.revision + 1
    const timestamp = maxInstant(now, projection.catalog.updatedAt)
    await this.journal.appendCommit(
      createSessionCommitV3({
        sessionId: input.sessionId,
        commitId: `commit-${token}`,
        expectedRevision: projection.snapshot.revision,
        idempotencyKey: `idem-${token}`,
        entries: events.map((event, index) =>
          validateSessionEntryV3({
            schemaVersion: 3,
            entryId: this.#createId('entry'),
            sessionId: input.sessionId,
            sequence: projection.snapshot.sequence + index + 1,
            revision,
            timestamp,
            type: event.type,
            runId: input.parentRunId,
            correlation: event.correlation,
            data: event.data,
          }),
        ),
      }),
    )

    const rescheduled = resolutions.flatMap((resolution) =>
      resolution.kind === 'reschedule' ? [resolution.claim] : [],
    )
    const blocked = resolutions.flatMap((resolution) =>
      resolution.kind === 'block'
        ? [
            Object.freeze({
              stepId: resolution.candidate.step.stepId,
              attemptId: resolution.candidate.attempt.attemptId,
              code: resolution.code,
            }),
          ]
        : [],
    )
    const unknownUsage = candidates.flatMap((candidate) =>
      candidate.unknownUsage === undefined
        ? []
        : [
            Object.freeze({
              attemptId: candidate.attempt.attemptId,
              usage: candidate.unknownUsage,
            }),
          ],
    )
    return Object.freeze({
      state:
        rescheduled.length > 0 && blocked.length > 0
          ? 'mixed'
          : rescheduled.length > 0
            ? 'rescheduled'
            : 'blocked',
      revision,
      rescheduled: Object.freeze(rescheduled),
      blocked: Object.freeze(blocked),
      unknownUsage: Object.freeze(unknownUsage),
    })
  }
}

function collectCandidates(plan: SessionPlanGraphProjectionV3): RecoveryCandidate[] {
  return plan.steps
    .flatMap((step) => {
      const active = step.attempts.filter((attempt) => ACTIVE_ATTEMPT_STATES.has(attempt.state))
      if (active.length > 1) fail('DAG_RECOVERY_ACTIVE_ATTEMPT_CONFLICT')
      const attempt = active[0]
      if (attempt === undefined) return []
      return [
        Object.freeze({
          step,
          attempt,
          ...(attempt.execution === undefined || attempt.resultRef !== undefined
            ? {}
            : { unknownUsage: conservativeUsage(step.budget) }),
        }),
      ]
    })
    .sort((left, right) => compareSteps(left.step, right.step))
}

function recoveryBlock(
  candidate: RecoveryCandidate,
  now: string,
  remainingChildren: number,
  remainingParallel: number,
  remainingUsage: Readonly<ExecutionBudget>,
  conflictKeys: ReadonlySet<string>,
): DagRecoveryBlockCodeV1 | undefined {
  const { attempt, step } = candidate
  if (attempt.execution === undefined) return 'RECOVERY_DEPENDENCY_BINDING_MISSING'
  if (step.access.mode !== 'read_only') return 'RECOVERY_WORKSPACE_WRITE_UNSAFE'
  if (attempt.execution.retrySafety !== 'read_only_idempotent') return 'RECOVERY_RETRY_NOT_SAFE'
  if (deadlineReached(step.budget.deadlineAt, now)) return 'RECOVERY_STEP_DEADLINE_EXCEEDED'
  if (step.attempts.length >= step.maxAttempts) return 'RECOVERY_ATTEMPT_LIMIT_REACHED'
  if (remainingChildren < 1) return 'RECOVERY_CHILD_BUDGET_EXHAUSTED'
  if (remainingParallel < 1) return 'RECOVERY_PARALLEL_CAPACITY_EXHAUSTED'
  if (step.conflictKeys.some((key) => conflictKeys.has(key))) return 'RECOVERY_CONFLICT_UNSAFE'
  if (!fitsBudget(step.budget, remainingUsage)) {
    return 'RECOVERY_PARENT_BUDGET_EXHAUSTED'
  }
  return undefined
}

async function rebuildSafely(
  resolver: RecoveryDependencyResolverV1,
  input: DagRecoveryInputV1,
  plan: SessionPlanGraphProjectionV3,
  candidate: RecoveryCandidate,
  attemptId: string,
  childRunId: string,
): Promise<
  | Readonly<{ status: 'compatible'; request: SubagentExecutionRequestV1 }>
  | Readonly<{ status: 'incompatible'; code: DagRecoveryBlockCodeV1 }>
> {
  let result: Awaited<ReturnType<RecoveryDependencyResolverV1['rebuild']>>
  try {
    result = await resolver.rebuild({
      sessionId: input.sessionId,
      parentRunId: input.parentRunId,
      plan,
      step: candidate.step,
      interruptedAttempt: candidate.attempt,
      persistedRequest: candidate.attempt.execution!.request,
      newAttemptId: attemptId,
      newChildRunId: childRunId,
    })
  } catch {
    return Object.freeze({ status: 'incompatible', code: 'RECOVERY_DEPENDENCY_RESOLVER_FAILED' })
  }
  if (result.status === 'incompatible') {
    if (!RECOVERY_INCOMPATIBILITY_CODES.has(result.code)) {
      return Object.freeze({ status: 'incompatible', code: 'RECOVERY_DEPENDENCY_REBUILD_INVALID' })
    }
    return Object.freeze({ status: 'incompatible', code: result.code })
  }
  try {
    const request = validateSubagentExecutionRequestV1(result.request)
    if (request.parentRunId !== input.parentRunId || request.childRunId !== childRunId) {
      return Object.freeze({ status: 'incompatible', code: 'RECOVERY_DEPENDENCY_REBUILD_INVALID' })
    }
    return Object.freeze({ status: 'compatible', request })
  } catch {
    return Object.freeze({ status: 'incompatible', code: 'RECOVERY_DEPENDENCY_REBUILD_INVALID' })
  }
}

function recoveryEvents(
  input: DagRecoveryInputV1,
  plan: SessionPlanGraphProjectionV3,
  resolution: RecoveryResolution,
): JournalEventDraft[] {
  const { attempt, step, unknownUsage } = resolution.candidate
  const oldCorrelation = correlation(input, plan, step, attempt.attemptId, attempt.childRunId)
  const authority = { planId: plan.planId, planRevision: plan.revision, stepId: step.stepId }
  const events: JournalEventDraft[] = [
    {
      type: 'attempt.state_changed',
      correlation: oldCorrelation,
      data: {
        ...authority,
        attemptId: attempt.attemptId,
        state: 'interrupted',
        errorCode: 'RECOVERY_PROCESS_LOST',
      },
    },
    {
      type: 'step.state_changed',
      correlation: oldCorrelation,
      data: { ...authority, state: 'interrupted', errorCode: 'RECOVERY_PROCESS_LOST' },
    },
  ]
  if (unknownUsage !== undefined) {
    events.push({
      type: 'usage.recorded',
      correlation: oldCorrelation,
      data: { source: 'subagent', usage: unknownUsage },
    })
  }
  if (resolution.kind === 'block') {
    events.push({
      type: 'step.state_changed',
      correlation: oldCorrelation,
      data: { ...authority, state: 'blocked', errorCode: resolution.code },
    })
    return events
  }

  const { claim } = resolution
  const newCorrelation = correlation(input, plan, step, claim.attemptId, claim.childRunId)
  events.push(
    {
      type: 'attempt.created',
      correlation: newCorrelation,
      data: {
        ...authority,
        attemptId: claim.attemptId,
        ordinal: step.attempts.length + 1,
        state: 'reserved',
        childRunId: claim.childRunId,
      },
    },
    {
      type: 'step.state_changed',
      correlation: newCorrelation,
      data: {
        ...authority,
        state: 'pending',
        reason: 'recovery_retry_approved',
        newAttemptId: claim.attemptId,
      },
    },
    {
      type: 'step.state_changed',
      correlation: newCorrelation,
      data: { ...authority, state: 'running' },
    },
    {
      type: 'attempt.state_changed',
      correlation: newCorrelation,
      data: { ...authority, attemptId: claim.attemptId, state: 'running' },
    },
    {
      type: 'subagent.execution_bound',
      correlation: newCorrelation,
      data: {
        ...authority,
        attemptId: claim.attemptId,
        childRunId: claim.childRunId,
        request: claim.request,
        retrySafety: 'read_only_idempotent',
      },
    },
  )
  return events
}

function remainingBudget(
  budget: Readonly<ExecutionBudget>,
  usage: Readonly<BudgetUsage>,
): Readonly<ExecutionBudget> {
  const usedTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  return Object.freeze({
    maxTurns: Math.max(0, budget.maxTurns - usage.turns),
    maxToolCalls: Math.max(0, budget.maxToolCalls - usage.toolCalls),
    ...(budget.maxTokens === undefined
      ? {}
      : { maxTokens: Math.max(0, budget.maxTokens - usedTokens) }),
    maxChildRuns: budget.maxChildRuns,
    maxParallelChildren: budget.maxParallelChildren,
    maxDepth: budget.maxDepth,
    ...(budget.deadlineAt === undefined ? {} : { deadlineAt: budget.deadlineAt }),
  })
}

function fitsBudget(
  requested: Readonly<ExecutionBudget>,
  remaining: Readonly<ExecutionBudget>,
): boolean {
  return (
    requested.maxTurns <= remaining.maxTurns &&
    requested.maxToolCalls <= remaining.maxToolCalls &&
    (requested.maxTokens === undefined ||
      (remaining.maxTokens !== undefined && requested.maxTokens <= remaining.maxTokens))
  )
}

function subtractUsage(
  remaining: Readonly<ExecutionBudget>,
  usage?: Readonly<BudgetUsage>,
): Readonly<ExecutionBudget> {
  if (usage === undefined) return remaining
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  return Object.freeze({
    ...remaining,
    maxTurns: Math.max(0, remaining.maxTurns - usage.turns),
    maxToolCalls: Math.max(0, remaining.maxToolCalls - usage.toolCalls),
    ...(remaining.maxTokens === undefined
      ? {}
      : { maxTokens: Math.max(0, remaining.maxTokens - tokens) }),
  })
}

function subtractBudget(
  remaining: Readonly<ExecutionBudget>,
  requested: Readonly<ExecutionBudget>,
): Readonly<ExecutionBudget> {
  return Object.freeze({
    ...remaining,
    maxTurns: Math.max(0, remaining.maxTurns - requested.maxTurns),
    maxToolCalls: Math.max(0, remaining.maxToolCalls - requested.maxToolCalls),
    ...(remaining.maxTokens === undefined || requested.maxTokens === undefined
      ? {}
      : { maxTokens: Math.max(0, remaining.maxTokens - requested.maxTokens) }),
  })
}

function conservativeUsage(budget: Readonly<ExecutionBudget>): Readonly<BudgetUsage> {
  return Object.freeze({
    turns: budget.maxTurns,
    toolCalls: budget.maxToolCalls,
    ...(budget.maxTokens === undefined ? {} : { inputTokens: budget.maxTokens }),
    subagents: budget.maxChildRuns,
  })
}

function correlation(
  input: DagRecoveryInputV1,
  plan: SessionPlanGraphProjectionV3,
  step: SessionStepProjectionV3,
  attemptId: string,
  childRunId?: string,
): Record<string, string> {
  return {
    parentRunId: input.parentRunId,
    ...(childRunId === undefined ? {} : { childRunId }),
    planId: plan.planId,
    stepId: step.stepId,
    attemptId,
  }
}

function emptyDecision(projection: SessionProjectionV3): DagRecoveryDecisionV1 {
  return Object.freeze({
    state: 'idle',
    revision: projection.snapshot.revision,
    rescheduled: Object.freeze([]),
    blocked: Object.freeze([]),
    unknownUsage: Object.freeze([]),
  })
}

function countAttempts(plan: SessionPlanGraphProjectionV3): number {
  return plan.steps.reduce((total, step) => total + step.attempts.length, 0)
}

function compareSteps(left: SessionStepProjectionV3, right: SessionStepProjectionV3): number {
  return left.order - right.order || left.stepId.localeCompare(right.stepId)
}

function requirePlan(
  projection: SessionProjectionV3,
  planId: string,
): SessionPlanGraphProjectionV3 {
  if (projection.planGraph?.planId !== planId) fail('DAG_RECOVERY_PLAN_NOT_FOUND')
  return projection.planGraph
}

function requireActiveRun(projection: SessionProjectionV3, runId: string): void {
  if (!projection.snapshot.runs.some((run) => run.runId === runId && run.state === 'running')) {
    fail('DAG_RECOVERY_PARENT_RUN_NOT_ACTIVE')
  }
}

function validateInput(input: DagRecoveryInputV1): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    !safeId(input.sessionId) ||
    !safeId(input.parentRunId) ||
    !safeId(input.planId) ||
    typeof input.parentBudget !== 'object' ||
    input.parentBudget === null
  ) {
    fail('DAG_RECOVERY_INPUT_INVALID')
  }
  for (const value of [
    input.parentBudget.maxTurns,
    input.parentBudget.maxToolCalls,
    input.parentBudget.maxChildRuns,
    input.parentBudget.maxParallelChildren,
    input.parentBudget.maxDepth,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) fail('DAG_RECOVERY_INPUT_INVALID')
  }
  if (
    (input.parentBudget.maxTokens !== undefined &&
      (!Number.isSafeInteger(input.parentBudget.maxTokens) || input.parentBudget.maxTokens < 0)) ||
    (input.parentBudget.deadlineAt !== undefined &&
      Number.isNaN(Date.parse(input.parentBudget.deadlineAt)))
  ) {
    fail('DAG_RECOVERY_INPUT_INVALID')
  }
}

const RECOVERY_INCOMPATIBILITY_CODES = new Set<RecoveryDependencyIncompatibilityCodeV1>([
  'RECOVERY_DEPENDENCY_NOT_FOUND',
  'RECOVERY_DEPENDENCY_VERSION_MISMATCH',
  'RECOVERY_DEPENDENCY_DIGEST_MISMATCH',
  'RECOVERY_CAPABILITY_DRIFT',
  'RECOVERY_PROFILE_INCOMPATIBLE',
])

function deadlineReached(deadlineAt: string | undefined, now: string): boolean {
  return deadlineAt !== undefined && now >= deadlineAt
}

function maxInstant(left: string, right: string): string {
  return left >= right ? left : right
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(value)
}

function fail(code: string): never {
  throw Object.assign(new Error(code), runtimeError(code, 'planner', code), { code })
}
