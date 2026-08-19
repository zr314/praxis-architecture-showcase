import { randomUUID } from 'node:crypto'
import {
  createSessionCommitV3,
  runtimeError,
  type ExecutionBudget,
  type BudgetUsage,
  type SessionJournalV3,
  type SessionPlanGraphProjectionV3,
  type SessionProjectionV3,
  type SessionStepProjectionV3,
  validateSessionEntryV3,
} from '@praxis/core-sdk'
import { currentRunBudgetUsageV1 } from './runBudgetUsage.js'

const MAX_PARALLEL_STEPS = 32
const ACTIVE_STEP_STATES = new Set(['running', 'verifying'])
const ACTIVE_CHILD_STATES = new Set(['reserved', 'running'])

export type DagFailureModeV1 = 'fail_fast' | 'collect_partial'

export type DagSchedulerPolicyV1 = Readonly<{
  maxParallelSteps?: number
}>

export type DagScheduleInputV1 = Readonly<{
  sessionId: string
  parentRunId: string
  planId: string
  parentBudget: Readonly<ExecutionBudget>
  failureMode: DagFailureModeV1
}>

export type DagStepClaimV1 = Readonly<{
  stepId: string
  attemptId: string
  childRunId: string
  ordinal: number
  budget: Readonly<ExecutionBudget>
}>

export type DagScheduleDecisionV1 = Readonly<{
  state:
    | 'claimed'
    | 'waiting'
    | 'complete'
    | 'failed'
    | 'blocked'
    | 'cancelled'
    | 'interrupted'
    | 'budget_exhausted'
    | 'deadlocked'
  claims: readonly DagStepClaimV1[]
  reasonCode?: string
  revision: number
  cumulativeChildRuns: number
  activeChildSlots: number
  activeSteps: number
}>

type JournalEventDraft = Readonly<{
  type: string
  data: Record<string, unknown>
  correlation: Record<string, string>
}>

/** Deterministic bounded DAG claim scheduler. Workspace isolation remains executor-owned. */
export class DagSchedulerV1 {
  readonly #maxParallelSteps: number
  readonly #createId: (kind: string) => string
  readonly #now: () => string

  constructor(
    private readonly journal: SessionJournalV3,
    policy: DagSchedulerPolicyV1 = {},
    options: Readonly<{ createId?: (kind: string) => string; now?: () => string }> = {},
  ) {
    const maxParallelSteps = policy.maxParallelSteps ?? 2
    if (
      !Number.isSafeInteger(maxParallelSteps) ||
      maxParallelSteps < 1 ||
      maxParallelSteps > MAX_PARALLEL_STEPS
    ) {
      fail('DAG_SCHEDULER_POLICY_INVALID')
    }
    this.#maxParallelSteps = maxParallelSteps
    this.#createId = options.createId ?? ((kind) => `${kind}-${randomUUID()}`)
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async schedule(input: DagScheduleInputV1): Promise<DagScheduleDecisionV1> {
    validateInput(input)
    const projection = await this.journal.loadProjection(input.sessionId)
    const plan = requirePlan(projection, input.planId)
    const counters = countCapacity(plan)
    if (plan.state !== 'running') return terminalDecision(plan, projection, counters)
    requireActiveRun(projection, input.parentRunId)
    const now = this.#now()

    const failedStep = plan.steps.find((step) => ['failed', 'interrupted'].includes(step.state))
    const failed = failedStep !== undefined
    const blocked = plan.steps.some((step) => step.state === 'blocked')
    if (input.failureMode === 'fail_fast' && (failed || blocked)) {
      return decision(
        blocked ? 'blocked' : 'failed',
        projection,
        counters,
        blocked ? 'DAG_STEP_BLOCKED' : (failedStep?.errorCode ?? 'DAG_STEP_FAILED'),
      )
    }

    const orderedReady = plan.steps
      .filter((step) => plan.readyStepIds.includes(step.stepId))
      .sort(compareSteps)
    const expired = orderedReady.filter((step) => deadlineReached(step.budget.deadlineAt, now))
    if (input.failureMode === 'fail_fast' && expired.length > 0) {
      return decision('blocked', projection, counters, 'DAG_STEP_DEADLINE_EXCEEDED')
    }
    // Attempt leases are intentionally ephemeral execution authority. Do not issue a second
    // batch while any prior batch is active: its exact lease is owned by the running Supervisor
    // and is not reconstructed from the broader durable Step ceiling.
    if (counters.activeSteps > 0 || counters.activeChildSlots > 0) {
      return decision('waiting', projection, counters, 'DAG_ACTIVE_WORK')
    }

    const stepCapacity = Math.max(0, this.#maxParallelSteps - counters.activeSteps)
    const childCapacity = Math.max(
      0,
      input.parentBudget.maxParallelChildren - counters.activeChildSlots,
    )
    const cumulativeCapacity = Math.max(
      0,
      input.parentBudget.maxChildRuns - counters.cumulativeChildRuns,
    )
    const capacity = Math.min(stepCapacity, childCapacity, cumulativeCapacity)
    const remainingExecution = remainingExecutionBudget(
      input.parentBudget,
      currentRunBudgetUsageV1(projection, input.parentRunId),
      plan.steps.filter((step) => ACTIVE_STEP_STATES.has(step.state)),
    )
    if (capacity > 0) {
      const liveReady = orderedReady.filter((step) => !deadlineReached(step.budget.deadlineAt, now))
      const selected = selectConflictFree(liveReady, activeConflictKeys(plan), capacity)
      if (selected.length > 0) {
        const leased = allocateBudgetLeases(selected, remainingExecution)
        if (leased.length > 0) return this.claim(input, projection, plan, leased, counters)
      }
    }

    if (counters.activeSteps > 0 || counters.activeChildSlots > 0) {
      return decision('waiting', projection, counters, 'DAG_ACTIVE_WORK')
    }
    if (plan.steps.every((step) => step.state === 'succeeded')) {
      return decision('complete', projection, counters)
    }
    if (expired.length > 0) {
      return decision('blocked', projection, counters, 'DAG_STEP_DEADLINE_EXCEEDED')
    }
    if (cumulativeCapacity === 0 || input.parentBudget.maxParallelChildren === 0) {
      return decision('budget_exhausted', projection, counters, 'DAG_CHILD_BUDGET_EXHAUSTED')
    }
    if (
      orderedReady.some((step) => !deadlineReached(step.budget.deadlineAt, now)) &&
      !orderedReady.some(
        (step) =>
          !deadlineReached(step.budget.deadlineAt, now) &&
          hasMinimumExecutionBudget(remainingExecution),
      )
    ) {
      return decision('budget_exhausted', projection, counters, 'DAG_EXECUTION_BUDGET_EXHAUSTED')
    }
    if (blocked) return decision('blocked', projection, counters, 'DAG_STEP_BLOCKED')
    if (failed) {
      return decision('failed', projection, counters, failedStep?.errorCode ?? 'DAG_STEP_FAILED')
    }
    if (hasAttemptLimitBlock(plan)) {
      return decision('blocked', projection, counters, 'DAG_ATTEMPT_LIMIT_REACHED')
    }
    return decision('deadlocked', projection, counters, 'DAG_NO_READY_STEP')
  }

  private async claim(
    input: DagScheduleInputV1,
    projection: SessionProjectionV3,
    plan: SessionPlanGraphProjectionV3,
    leased: readonly Readonly<{ step: SessionStepProjectionV3; budget: ExecutionBudget }>[],
    counters: CapacityCounters,
  ): Promise<DagScheduleDecisionV1> {
    const claims = leased.map(({ step, budget }) =>
      Object.freeze({
        stepId: step.stepId,
        attemptId: this.#createId('attempt'),
        childRunId: this.#createId('child-run'),
        ordinal: step.attempts.length + 1,
        budget,
      }),
    )
    const events = claims.flatMap((claim, index) => {
      const step = leased[index]!.step
      return claimEvents(input, plan, step, claim)
    })
    const token = this.#createId('dag-claim')
    const revision = projection.snapshot.revision + 1
    const timestamp = maxInstant(this.#now(), projection.catalog.updatedAt)
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
    return Object.freeze({
      state: 'claimed',
      claims: Object.freeze(claims),
      revision,
      cumulativeChildRuns: counters.cumulativeChildRuns + claims.length,
      activeChildSlots: counters.activeChildSlots + claims.length,
      activeSteps: counters.activeSteps + claims.length,
    })
  }
}

type CapacityCounters = Readonly<{
  cumulativeChildRuns: number
  activeChildSlots: number
  activeSteps: number
}>

function countCapacity(plan: SessionPlanGraphProjectionV3): CapacityCounters {
  return Object.freeze({
    cumulativeChildRuns: plan.steps.reduce((total, step) => total + step.attempts.length, 0),
    activeChildSlots: plan.steps.reduce(
      (total, step) =>
        total + step.attempts.filter((attempt) => ACTIVE_CHILD_STATES.has(attempt.state)).length,
      0,
    ),
    activeSteps: plan.steps.filter((step) => ACTIVE_STEP_STATES.has(step.state)).length,
  })
}

function selectConflictFree(
  ready: readonly SessionStepProjectionV3[],
  activeKeys: ReadonlySet<string>,
  capacity: number,
): SessionStepProjectionV3[] {
  const selected: SessionStepProjectionV3[] = []
  const claimedKeys = new Set(activeKeys)
  for (const step of ready) {
    if (selected.length >= capacity) break
    if (step.conflictKeys.some((key) => claimedKeys.has(key))) continue
    selected.push(step)
    for (const key of step.conflictKeys) claimedKeys.add(key)
  }
  return selected
}

function allocateBudgetLeases(
  steps: readonly SessionStepProjectionV3[],
  available: Readonly<ExecutionBudget>,
): readonly Readonly<{ step: SessionStepProjectionV3; budget: ExecutionBudget }>[] {
  if (!hasMinimumExecutionBudget(available)) return []
  const leases: Array<Readonly<{ step: SessionStepProjectionV3; budget: ExecutionBudget }>> = []
  let remaining = available
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!
    const slots = steps.length - index
    const maxTurns = Math.min(
      step.budget.maxTurns,
      Math.max(1, Math.floor(remaining.maxTurns / slots)),
    )
    if (maxTurns < 1) break
    const maxToolCalls = Math.min(
      step.budget.maxToolCalls,
      Math.max(0, Math.floor(remaining.maxToolCalls / slots)),
    )
    const maxTokens =
      remaining.maxTokens === undefined
        ? step.budget.maxTokens
        : Math.min(
            step.budget.maxTokens ?? remaining.maxTokens,
            Math.max(1, Math.floor(remaining.maxTokens / slots)),
          )
    const budget = Object.freeze({
      ...step.budget,
      maxTurns,
      maxToolCalls,
      ...(maxTokens === undefined ? {} : { maxTokens }),
    })
    leases.push(Object.freeze({ step, budget }))
    remaining = subtractExecutionBudget(remaining, budget)
  }
  return Object.freeze(leases)
}

function remainingExecutionBudget(
  parent: Readonly<ExecutionBudget>,
  usage: Readonly<BudgetUsage>,
  active: readonly SessionStepProjectionV3[],
): Readonly<ExecutionBudget> {
  const usedTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  let remaining: Readonly<ExecutionBudget> = Object.freeze({
    ...parent,
    maxTurns: Math.max(0, parent.maxTurns - usage.turns),
    maxToolCalls: Math.max(0, parent.maxToolCalls - usage.toolCalls),
    ...(parent.maxTokens === undefined
      ? {}
      : { maxTokens: Math.max(0, parent.maxTokens - usedTokens) }),
  })
  for (const step of active) remaining = subtractExecutionBudget(remaining, step.budget)
  return remaining
}

function hasMinimumExecutionBudget(remaining: Readonly<ExecutionBudget>): boolean {
  return remaining.maxTurns > 0 && (remaining.maxTokens === undefined || remaining.maxTokens > 0)
}

function subtractExecutionBudget(
  remaining: Readonly<ExecutionBudget>,
  requested: Readonly<ExecutionBudget>,
): Readonly<ExecutionBudget> {
  return Object.freeze({
    ...remaining,
    maxTurns: Math.max(0, remaining.maxTurns - requested.maxTurns),
    maxToolCalls: Math.max(0, remaining.maxToolCalls - requested.maxToolCalls),
    ...(remaining.maxTokens === undefined
      ? {}
      : {
          maxTokens: Math.max(
            0,
            remaining.maxTokens - (requested.maxTokens ?? remaining.maxTokens),
          ),
        }),
  })
}

function activeConflictKeys(plan: SessionPlanGraphProjectionV3): ReadonlySet<string> {
  return new Set(
    plan.steps
      .filter((step) => ACTIVE_STEP_STATES.has(step.state))
      .flatMap((step) => step.conflictKeys),
  )
}

function claimEvents(
  input: DagScheduleInputV1,
  plan: SessionPlanGraphProjectionV3,
  step: SessionStepProjectionV3,
  claim: DagStepClaimV1,
): JournalEventDraft[] {
  const correlation = {
    parentRunId: input.parentRunId,
    childRunId: claim.childRunId,
    planId: plan.planId,
    stepId: step.stepId,
    attemptId: claim.attemptId,
  }
  const authority = {
    planId: plan.planId,
    planRevision: plan.revision,
    stepId: step.stepId,
  }
  return [
    {
      type: 'attempt.created',
      correlation,
      data: {
        ...authority,
        attemptId: claim.attemptId,
        ordinal: claim.ordinal,
        state: 'reserved',
        childRunId: claim.childRunId,
      },
    },
    {
      type: 'step.state_changed',
      correlation,
      data: { ...authority, state: 'running' },
    },
    {
      type: 'attempt.state_changed',
      correlation,
      data: { ...authority, attemptId: claim.attemptId, state: 'running' },
    },
  ]
}

function terminalDecision(
  plan: SessionPlanGraphProjectionV3,
  projection: SessionProjectionV3,
  counters: CapacityCounters,
): DagScheduleDecisionV1 {
  switch (plan.state) {
    case 'succeeded':
      return decision('complete', projection, counters)
    case 'failed':
    case 'blocked':
    case 'cancelled':
    case 'interrupted':
      return decision(plan.state, projection, counters)
    case 'draft':
      return decision('blocked', projection, counters, 'DAG_PLAN_NOT_STARTED')
    case 'running':
      fail('DAG_PLAN_STATE_INVALID')
  }
}

function decision(
  state: DagScheduleDecisionV1['state'],
  projection: SessionProjectionV3,
  counters: CapacityCounters,
  reasonCode?: string,
): DagScheduleDecisionV1 {
  return Object.freeze({
    state,
    claims: Object.freeze([]),
    ...(reasonCode === undefined ? {} : { reasonCode }),
    revision: projection.snapshot.revision,
    ...counters,
  })
}

function compareSteps(left: SessionStepProjectionV3, right: SessionStepProjectionV3): number {
  return left.order - right.order || left.stepId.localeCompare(right.stepId)
}

function hasAttemptLimitBlock(plan: SessionPlanGraphProjectionV3): boolean {
  return plan.steps.some(
    (step) => step.state === 'pending' && step.attempts.length >= step.maxAttempts,
  )
}

function requirePlan(
  projection: SessionProjectionV3,
  planId: string,
): SessionPlanGraphProjectionV3 {
  if (projection.planGraph?.planId !== planId) fail('DAG_PLAN_NOT_FOUND')
  return projection.planGraph
}

function requireActiveRun(projection: SessionProjectionV3, runId: string): void {
  if (!projection.snapshot.runs.some((run) => run.runId === runId && run.state === 'running')) {
    fail('DAG_PARENT_RUN_NOT_ACTIVE')
  }
}

function validateInput(input: DagScheduleInputV1): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    !['fail_fast', 'collect_partial'].includes(input.failureMode) ||
    !safeId(input.sessionId) ||
    !safeId(input.parentRunId) ||
    !safeId(input.planId) ||
    typeof input.parentBudget !== 'object' ||
    input.parentBudget === null
  ) {
    fail('DAG_SCHEDULER_INPUT_INVALID')
  }
  for (const value of [
    input.parentBudget.maxTurns,
    input.parentBudget.maxToolCalls,
    input.parentBudget.maxChildRuns,
    input.parentBudget.maxParallelChildren,
    input.parentBudget.maxDepth,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) fail('DAG_SCHEDULER_INPUT_INVALID')
  }
  if (
    (input.parentBudget.maxTokens !== undefined &&
      (!Number.isSafeInteger(input.parentBudget.maxTokens) || input.parentBudget.maxTokens < 0)) ||
    (input.parentBudget.deadlineAt !== undefined &&
      Number.isNaN(Date.parse(input.parentBudget.deadlineAt)))
  ) {
    fail('DAG_SCHEDULER_INPUT_INVALID')
  }
}

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
