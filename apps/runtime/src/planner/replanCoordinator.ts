import { randomUUID } from 'node:crypto'
import {
  createSessionCommitV3,
  type PlannerDecisionActionV3,
  runtimeError,
  type SessionEntryV3,
  type SessionJournalV3,
  type SessionPlanGraphProjectionV3,
  type SessionStepProjectionV3,
  validateSessionEntryV3,
} from '@praxis/core-sdk'
import {
  type FixedPlanProposalV1,
  PlanValidator,
  type PlanValidatorOptions,
} from './planValidator.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/

export type PlannerDecisionV1 = Readonly<{
  action: PlannerDecisionActionV3
  reasonCode: string
  stepId?: string
  attemptId?: string
}>

export type ReplanStepReuseV1 = Readonly<{
  proposalKey: string
  priorStepId: string
  nextInputDigest: `sha256:${string}`
}>

export type ReplanRequestV1 = Readonly<{
  sessionId: string
  parentRunId: string
  planId: string
  expectedRevision: number
  expectedPlanRevision: number
  proposal: FixedPlanProposalV1
  reuse?: readonly ReplanStepReuseV1[]
}>

export type ReplanResultV1 =
  | Readonly<{
      status: 'applied'
      planId: string
      previousRevision: number
      revision: number
      reusedStepIds: readonly string[]
      newStepIds: readonly string[]
    }>
  | Readonly<{
      status: 'no_progress'
      action: 'ask_user'
      occurrences: number
    }>
  | Readonly<{
      status: 'blocked'
      action: 'ask_user'
      occurrences: number
    }>

export type ReplanCoordinatorOptionsV1 = Readonly<{
  journal: SessionJournalV3
  admission: Omit<PlanValidatorOptions, 'createId'>
  createId?: (kind: string) => string
  now?: () => string
}>

export type PlannerDecisionRecordRequestV1 = Readonly<{
  sessionId: string
  parentRunId: string
  planId: string
  expectedRevision: number
  expectedPlanRevision: number
  decision: PlannerDecisionV1
}>

/** Validates the explicit recovery action vocabulary; no natural-language state guessing. */
export function validatePlannerDecisionV1(input: unknown): PlannerDecisionV1 {
  if (!isRecord(input)) replanFail('PLANNER_DECISION_INVALID')
  const allowed = new Set(['action', 'reasonCode', 'stepId', 'attemptId'])
  if (
    Object.keys(input).some((key) => !allowed.has(key)) ||
    !Object.hasOwn(input, 'action') ||
    !Object.hasOwn(input, 'reasonCode') ||
    !['retry', 'continue', 'fresh_worker', 'replan', 'ask_user'].includes(String(input.action)) ||
    !safeId(input.reasonCode) ||
    (input.stepId !== undefined && !safeId(input.stepId)) ||
    (input.attemptId !== undefined && !safeId(input.attemptId))
  ) {
    replanFail('PLANNER_DECISION_INVALID')
  }
  const action = input.action as PlannerDecisionActionV3
  const hasStep = input.stepId !== undefined
  const hasAttempt = input.attemptId !== undefined
  if (
    (['retry', 'continue', 'fresh_worker'].includes(action) && (!hasStep || !hasAttempt)) ||
    (['replan', 'ask_user'].includes(action) && (hasStep || hasAttempt))
  ) {
    replanFail('PLANNER_DECISION_INVALID')
  }
  return Object.freeze({
    action,
    reasonCode: input.reasonCode as string,
    ...(hasStep ? { stepId: input.stepId as string, attemptId: input.attemptId as string } : {}),
  })
}

/** One-shot, CAS-only plan revision coordinator. It never launches or restores a worker. */
export class ReplanCoordinatorV1 {
  readonly #createId: (kind: string) => string
  readonly #now: () => string

  constructor(private readonly options: ReplanCoordinatorOptionsV1) {
    if (!options?.journal || !options.admission) replanFail('REPLAN_OPTIONS_INVALID')
    this.#createId = options.createId ?? ((kind) => `${kind}-${randomUUID()}`)
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async recordDecision(input: PlannerDecisionRecordRequestV1): Promise<PlannerDecisionV1> {
    if (
      !isRecord(input) ||
      !exactKeys(input, [
        'sessionId',
        'parentRunId',
        'planId',
        'expectedRevision',
        'expectedPlanRevision',
        'decision',
      ]) ||
      !safeId(input.sessionId) ||
      !safeId(input.parentRunId) ||
      !safeId(input.planId) ||
      !nonNegativeInteger(input.expectedRevision) ||
      !positiveInteger(input.expectedPlanRevision)
    ) {
      replanFail('PLANNER_DECISION_REQUEST_INVALID')
    }
    const decision = validatePlannerDecisionV1(input.decision)
    if (decision.action === 'replan') replanFail('PLANNER_DECISION_USE_REPLAN')
    const projection = await this.options.journal.loadProjection(input.sessionId)
    const plan = requirePlanRevision(projection.planGraph, input.planId, input.expectedPlanRevision)
    requireActiveParentRun(projection.snapshot.runs, input.parentRunId)
    if (projection.snapshot.revision !== input.expectedRevision) {
      replanFail('REPLAN_EXPECTED_REVISION_CONFLICT')
    }
    if (decision.stepId !== undefined && decision.attemptId !== undefined) {
      const step = requireStep(plan, decision.stepId)
      const attempt = step.attempts.find((candidate) => candidate.attemptId === decision.attemptId)
      if (attempt === undefined) replanFail('PLANNER_DECISION_TARGET_INVALID')
      const valid =
        decision.action === 'retry'
          ? ['execution_failed', 'rejected'].includes(attempt.state)
          : decision.action === 'continue'
            ? attempt.state === 'interrupted' && attempt.execution !== undefined
            : decision.action === 'fresh_worker'
              ? ['execution_failed', 'rejected', 'interrupted'].includes(attempt.state)
              : false
      if (!valid) replanFail('PLANNER_DECISION_TARGET_INVALID')
    }
    const history = await readAll(this.options.journal, input.sessionId)
    await this.append(
      input,
      history,
      [
        {
          type: 'plan.decision_recorded',
          data: {
            planId: plan.planId,
            planRevision: plan.revision,
            ...decision,
            outcome: 'selected',
          },
        },
      ],
      `decision-${decision.action}`,
    )
    return decision
  }

  async replan(input: ReplanRequestV1): Promise<ReplanResultV1> {
    validateRequest(input)
    const projection = await this.options.journal.loadProjection(input.sessionId)
    const plan = requireReplannablePlan(projection.planGraph, input)
    requireActiveParentRun(projection.snapshot.runs, input.parentRunId)
    if (projection.snapshot.revision !== input.expectedRevision) {
      replanFail('REPLAN_EXPECTED_REVISION_CONFLICT')
    }
    const entries = await readAll(this.options.journal, input.sessionId)
    const applied = entries.filter(
      (entry) =>
        entry.type === 'plan.decision_recorded' &&
        entry.runId === input.parentRunId &&
        entry.data.planId === input.planId &&
        entry.data.action === 'replan' &&
        entry.data.outcome === 'applied',
    ).length
    if (applied >= 1) replanFail('REPLAN_LIMIT_EXCEEDED')

    const reuse = validateReuse(input.reuse ?? [], plan)
    const byProposalKey = new Map(reuse.map((candidate) => [candidate.proposalKey, candidate]))
    const priorByStepId = new Map(plan.steps.map((step) => [step.stepId, step]))
    const candidate = new PlanValidator({
      ...this.options.admission,
      createId: (kind, sourceKey) => {
        if (kind === 'plan') return plan.planId
        if (kind === 'step')
          return byProposalKey.get(sourceKey)?.priorStepId ?? this.#createId(kind)
        const separator = sourceKey.lastIndexOf(':')
        const proposalKey = separator < 0 ? sourceKey : sourceKey.slice(0, separator)
        const criterionIndex = separator < 0 ? -1 : Number(sourceKey.slice(separator + 1)) - 1
        const priorStep = priorByStepId.get(byProposalKey.get(proposalKey)?.priorStepId ?? '')
        return priorStep?.criteria[criterionIndex]?.criterionId ?? this.#createId(kind)
      },
    }).validate(input.proposal)
    const nextRevision = plan.revision + 1

    for (const item of reuse) {
      const prior = requireStep(plan, item.priorStepId)
      const next = candidate.steps.find((step) => step.stepId === item.priorStepId)
      const latest = [...prior.attempts].sort((left, right) => right.ordinal - left.ordinal)[0]
      if (
        next === undefined ||
        prior.state !== 'succeeded' ||
        latest?.state !== 'verified' ||
        latest.execution?.request.packetRef.digest !== item.nextInputDigest ||
        !sameStepDefinition(prior, next) ||
        prior.dependencies.some(
          (dependency) =>
            !reuse.some((candidateReuse) => candidateReuse.priorStepId === dependency),
        )
      ) {
        replanFail('REPLAN_REUSE_INVALID')
      }
    }

    const reusedStepIds = Object.freeze(reuse.map((item) => item.priorStepId))
    const newSteps = candidate.steps.filter((step) => !reusedStepIds.includes(step.stepId))
    const consumedChildren = entries.filter(
      (entry) => entry.type === 'attempt.created' && entry.runId === input.parentRunId,
    ).length
    const reservedChildren = newSteps.reduce((total, step) => total + step.maxAttempts, 0)
    if (consumedChildren + reservedChildren > this.options.admission.parentBudget.maxChildRuns) {
      replanFail('REPLAN_CHILD_BUDGET_EXCEEDED')
    }

    if (samePlanDefinition(plan, candidate)) {
      const priorNoProgress = entries.filter(
        (entry) =>
          entry.type === 'plan.decision_recorded' &&
          entry.runId === input.parentRunId &&
          entry.data.planId === input.planId &&
          entry.data.action === 'replan' &&
          entry.data.outcome === 'no_progress',
      ).length
      const occurrences = priorNoProgress + 1
      if (priorNoProgress >= 2) {
        return Object.freeze({
          status: 'blocked',
          action: 'ask_user',
          occurrences: priorNoProgress,
        })
      }
      const drafts: JournalDraft[] = [decisionDraft(plan, 'no_progress', 'REPLAN_NO_PROGRESS')]
      if (occurrences >= 2 && plan.state === 'running') {
        drafts.push({
          type: 'plan.state_changed',
          data: { planId: plan.planId, planRevision: plan.revision, state: 'blocked' },
        })
      }
      await this.append(input, entries, drafts, `no-progress-${occurrences}`)
      return Object.freeze({
        status: occurrences >= 2 ? 'blocked' : 'no_progress',
        action: 'ask_user',
        occurrences,
      })
    }

    const drafts: JournalDraft[] = [
      decisionDraft(plan, 'applied', 'REPLAN_APPLIED'),
      {
        type: 'plan.revised',
        data: {
          planId: plan.planId,
          fromRevision: plan.revision,
          toRevision: nextRevision,
          objective: candidate.objective,
          state: 'running',
          reuseProofs: reuse.map((item) => {
            const prior = requireStep(plan, item.priorStepId)
            const latest = [...prior.attempts].sort(
              (left, right) => right.ordinal - left.ordinal,
            )[0]!
            return {
              stepId: item.priorStepId,
              previousInputDigest: latest.execution!.request.packetRef.digest,
              nextInputDigest: item.nextInputDigest,
            }
          }),
        },
      },
      ...newSteps.map((step) => ({
        type: 'step.created',
        data: {
          planId: plan.planId,
          planRevision: nextRevision,
          stepId: step.stepId,
          title: step.title,
          order: step.order,
          state: 'pending',
          dependencies: [...step.dependencies],
          access: structuredClone(step.access),
          capabilities: [...step.capabilities],
          conflictKeys: [...step.conflictKeys],
          criteria: structuredClone(step.criteria),
          budget: structuredClone(step.budget),
          maxAttempts: step.maxAttempts,
        },
      })),
    ]
    await this.append(input, entries, drafts, `apply-${nextRevision}`)
    return Object.freeze({
      status: 'applied',
      planId: plan.planId,
      previousRevision: plan.revision,
      revision: nextRevision,
      reusedStepIds,
      newStepIds: Object.freeze(newSteps.map((step) => step.stepId)),
    })
  }

  private async append(
    input: Readonly<{
      sessionId: string
      parentRunId: string
      planId: string
      expectedRevision: number
      expectedPlanRevision: number
    }>,
    history: readonly SessionEntryV3[],
    drafts: readonly JournalDraft[],
    suffix: string,
  ): Promise<void> {
    const timestamp = monotonicTimestamp(this.#now(), history.at(-1)?.timestamp)
    const revision = input.expectedRevision + 1
    const entries = drafts.map((draft, index) =>
      validateSessionEntryV3({
        schemaVersion: 3,
        entryId: this.#createId('entry'),
        sessionId: input.sessionId,
        sequence: history.length + index + 1,
        revision,
        timestamp,
        type: draft.type,
        runId: input.parentRunId,
        correlation: { parentRunId: input.parentRunId, planId: input.planId },
        data: draft.data,
      }),
    )
    try {
      await this.options.journal.appendCommit(
        createSessionCommitV3({
          sessionId: input.sessionId,
          commitId: this.#createId('commit'),
          expectedRevision: input.expectedRevision,
          idempotencyKey: `replan-${input.parentRunId}-${input.expectedPlanRevision}-${suffix}`,
          entries,
        }),
      )
    } catch (error) {
      if (
        errorCode(error) === 'SESSION_COMMIT_REVISION_CONFLICT' ||
        errorCode(error) === 'SESSION_COMMIT_SEQUENCE_CONFLICT' ||
        errorCode(error) === 'SESSION_COMMIT_IDEMPOTENCY_CONFLICT'
      ) {
        replanFail('REPLAN_EXPECTED_REVISION_CONFLICT')
      }
      throw error
    }
  }
}

type JournalDraft = Readonly<{ type: string; data: Record<string, unknown> }>

function validateRequest(input: ReplanRequestV1): void {
  if (
    !isRecord(input) ||
    !exactKeys(input, [
      'sessionId',
      'parentRunId',
      'planId',
      'expectedRevision',
      'expectedPlanRevision',
      'proposal',
      ...(input.reuse === undefined ? [] : ['reuse']),
    ]) ||
    !safeId(input.sessionId) ||
    !safeId(input.parentRunId) ||
    !safeId(input.planId) ||
    !nonNegativeInteger(input.expectedRevision) ||
    !positiveInteger(input.expectedPlanRevision)
  ) {
    replanFail('REPLAN_REQUEST_INVALID')
  }
}

function requireReplannablePlan(
  plan: SessionPlanGraphProjectionV3 | undefined,
  input: ReplanRequestV1,
): SessionPlanGraphProjectionV3 {
  if (plan?.planId !== input.planId) replanFail('REPLAN_PLAN_NOT_FOUND')
  if (plan.revision !== input.expectedPlanRevision) replanFail('REPLAN_PLAN_REVISION_CONFLICT')
  // A failed plan is terminal for ordinary state transitions, but an admitted
  // plan.revised event is the explicit recovery boundary: it replaces all
  // non-reused steps and advances the durable revision before execution resumes.
  if (!['running', 'blocked', 'failed'].includes(plan.state)) replanFail('REPLAN_STATE_INVALID')
  if (
    plan.steps.some(
      (step) =>
        ['running', 'verifying'].includes(step.state) ||
        step.attempts.some((attempt) =>
          ['reserved', 'running', 'execution_succeeded', 'verifying'].includes(attempt.state),
        ),
    )
  ) {
    replanFail('REPLAN_ACTIVE_ATTEMPT')
  }
  return plan
}

function requirePlanRevision(
  plan: SessionPlanGraphProjectionV3 | undefined,
  planId: string,
  revision: number,
): SessionPlanGraphProjectionV3 {
  if (plan?.planId !== planId) replanFail('REPLAN_PLAN_NOT_FOUND')
  if (plan.revision !== revision) replanFail('REPLAN_PLAN_REVISION_CONFLICT')
  return plan
}

function requireActiveParentRun(
  runs: readonly Readonly<{ runId: string; state: string }>[],
  parentRunId: string,
): void {
  if (!runs.some((run) => run.runId === parentRunId && run.state === 'running')) {
    replanFail('REPLAN_PARENT_RUN_INACTIVE')
  }
}

function validateReuse(
  input: readonly ReplanStepReuseV1[],
  plan: SessionPlanGraphProjectionV3,
): readonly ReplanStepReuseV1[] {
  if (!Array.isArray(input) || input.length > 64) replanFail('REPLAN_REUSE_INVALID')
  const proposalKeys = new Set<string>()
  const stepIds = new Set<string>()
  return Object.freeze(
    input.map((candidate) => {
      if (
        !isRecord(candidate) ||
        !exactKeys(candidate, ['proposalKey', 'priorStepId', 'nextInputDigest']) ||
        !safeId(candidate.proposalKey) ||
        !safeId(candidate.priorStepId) ||
        typeof candidate.nextInputDigest !== 'string' ||
        !SHA256.test(candidate.nextInputDigest) ||
        proposalKeys.has(candidate.proposalKey) ||
        stepIds.has(candidate.priorStepId) ||
        !plan.steps.some((step) => step.stepId === candidate.priorStepId)
      ) {
        replanFail('REPLAN_REUSE_INVALID')
      }
      proposalKeys.add(candidate.proposalKey)
      stepIds.add(candidate.priorStepId)
      return Object.freeze({
        proposalKey: candidate.proposalKey,
        priorStepId: candidate.priorStepId,
        nextInputDigest: candidate.nextInputDigest as `sha256:${string}`,
      })
    }),
  )
}

function sameStepDefinition(
  prior: SessionStepProjectionV3,
  next: ReturnType<PlanValidator['validate']>['steps'][number],
): boolean {
  return (
    prior.stepId === next.stepId &&
    prior.title === next.title &&
    prior.order === next.order &&
    JSON.stringify(prior.dependencies) === JSON.stringify(next.dependencies) &&
    JSON.stringify(prior.access) === JSON.stringify(next.access) &&
    JSON.stringify(prior.capabilities) === JSON.stringify(next.capabilities) &&
    JSON.stringify(prior.conflictKeys) === JSON.stringify(next.conflictKeys) &&
    JSON.stringify(prior.criteria) === JSON.stringify(next.criteria) &&
    JSON.stringify(prior.budget) === JSON.stringify(next.budget) &&
    prior.maxAttempts === next.maxAttempts
  )
}

function samePlanDefinition(
  current: SessionPlanGraphProjectionV3,
  candidate: ReturnType<PlanValidator['validate']>,
): boolean {
  if (
    current.objective !== candidate.objective ||
    current.steps.length !== candidate.steps.length
  ) {
    return false
  }
  return (
    JSON.stringify(planSignature(current.steps)) === JSON.stringify(planSignature(candidate.steps))
  )
}

function planSignature(
  steps: readonly Readonly<{
    stepId: string
    title: string
    order: number
    dependencies: readonly string[]
    access: unknown
    capabilities: readonly string[]
    conflictKeys: readonly string[]
    criteria: readonly Readonly<{
      kind: string
      description: string
      ref?: string
      expectedDigest?: string
    }>[]
    budget: unknown
    maxAttempts: number
  }>[],
): unknown {
  const order = new Map(steps.map((step) => [step.stepId, step.order]))
  return [...steps]
    .sort((left, right) => left.order - right.order)
    .map((step) => ({
      title: step.title,
      order: step.order,
      dependencies: step.dependencies.map((dependency) => order.get(dependency)).sort(),
      access: step.access,
      capabilities: step.capabilities,
      conflictKeys: step.conflictKeys,
      criteria: step.criteria.map(({ kind, description, ref, expectedDigest }) => ({
        kind,
        description,
        ...(ref === undefined ? {} : { ref }),
        ...(expectedDigest === undefined ? {} : { expectedDigest }),
      })),
      budget: step.budget,
      maxAttempts: step.maxAttempts,
    }))
}

function decisionDraft(
  plan: SessionPlanGraphProjectionV3,
  outcome: 'applied' | 'no_progress',
  reasonCode: string,
): JournalDraft {
  return {
    type: 'plan.decision_recorded',
    data: {
      planId: plan.planId,
      planRevision: plan.revision,
      action: 'replan',
      outcome,
      reasonCode,
    },
  }
}

function requireStep(plan: SessionPlanGraphProjectionV3, stepId: string): SessionStepProjectionV3 {
  const step = plan.steps.find((candidate) => candidate.stepId === stepId)
  if (step === undefined) replanFail('REPLAN_REUSE_INVALID')
  return step
}

async function readAll(journal: SessionJournalV3, sessionId: string): Promise<SessionEntryV3[]> {
  const result: SessionEntryV3[] = []
  let afterSequence = 0
  let throughSequence: number | undefined
  let hasMore = true
  while (hasMore) {
    const page = await journal.readEntries({
      sessionId,
      afterSequence,
      limit: 512,
      ...(throughSequence === undefined ? {} : { throughSequence }),
    })
    throughSequence ??= page.head.sequence
    result.push(...page.entries)
    afterSequence = page.nextAfterSequence
    hasMore = page.hasMore
  }
  return result
}

function monotonicTimestamp(now: string, previous: string | undefined): string {
  if (!canonicalInstant(now)) replanFail('REPLAN_CLOCK_INVALID')
  return previous !== undefined && previous > now ? previous : now
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function canonicalInstant(value: string): boolean {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

function errorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : 'UNKNOWN'
}

function replanFail(code: string): never {
  throw Object.assign(new Error(code), runtimeError(code, 'planner', code), { code })
}
