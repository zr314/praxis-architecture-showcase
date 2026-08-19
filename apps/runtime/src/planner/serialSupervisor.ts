import { randomUUID } from 'node:crypto'
import {
  type ArtifactReference,
  createSessionCommitV3,
  type ExecutionBudget,
  runtimeError,
  type SessionJournalV3,
  type SessionPlanGraphProjectionV3,
  type SessionProjectionV3,
  type SessionRetrySafetyV3,
  type SessionStepProjectionV3,
  type SubagentExecutionRequestV1,
  type SubagentExecutor,
  type SubagentResultV1,
  validateSessionEntryV3,
  validateSubagentExecutionRequestV1,
} from '@praxis/core-sdk'
import {
  type SupervisorVerifierV1,
  semanticVerifierUnavailableV1,
  type VerificationDecisionV1,
} from './verifier.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/

export type FixedPlanSubagentRequestFactoryV1 = Readonly<{
  create(input: {
    sessionId: string
    parentRunId: string
    plan: SessionPlanGraphProjectionV3
    step: SessionStepProjectionV3
    attemptId: string
    childRunId: string
    budget: Readonly<ExecutionBudget>
  }): SubagentExecutionRequestV1 | Promise<SubagentExecutionRequestV1>
}>

export type SupervisorArtifactStoreV1 = Readonly<{
  put(value: unknown, mimeType?: string): Promise<ArtifactReference>
}>

export type SerialSupervisorOptions = Readonly<{
  journal: SessionJournalV3
  executor: SubagentExecutor
  requestFactory: FixedPlanSubagentRequestFactoryV1
  artifactStore: SupervisorArtifactStoreV1
  mechanicalVerifier: SupervisorVerifierV1
  ruleVerifier: SupervisorVerifierV1
  semanticVerifier?: SupervisorVerifierV1
  retrySafety?: (step: SessionStepProjectionV3) => SessionRetrySafetyV3
  createId?: (kind: string) => string
  now?: () => string
}>

export type SerialSupervisorInputV1 = Readonly<{
  sessionId: string
  parentRunId: string
  planId: string
  signal?: AbortSignal
}>

export type SerialSupervisorResultV1 = Readonly<{
  planId: string
  state: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'interrupted'
}>

type ClaimedAttempt = Readonly<{
  stepId: string
  attemptId: string
  childRunId: string
  ordinal: number
}>

type JournalEventDraft = Readonly<{
  type: string
  data: Record<string, unknown>
  runId?: string
  correlation?: Record<string, string>
}>

/** Fixed-plan, one-child-at-a-time Supervisor. It never materializes or launches a child directly. */
export class SerialSupervisor {
  readonly #createId: (kind: string) => string
  readonly #now: () => string
  readonly #retrySafety: (step: SessionStepProjectionV3) => SessionRetrySafetyV3

  constructor(private readonly options: SerialSupervisorOptions) {
    this.#createId = options.createId ?? ((kind) => `${kind}-${randomUUID()}`)
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#retrySafety = options.retrySafety ?? (() => 'unknown')
  }

  async execute(input: SerialSupervisorInputV1): Promise<SerialSupervisorResultV1> {
    validateInput(input)
    let projection = await this.options.journal.loadProjection(input.sessionId)
    let plan = requirePlan(projection, input.planId)
    requireActiveRun(projection, input.parentRunId)

    if (plan.state === 'draft') {
      if (input.signal?.aborted) return this.finishBeforeClaim(input, projection, 'cancelled')
      await this.append(projection, 'start-plan', [
        planEvent('plan.state_changed', plan, { state: 'running' }, input.parentRunId),
      ])
    } else if (plan.state !== 'running') {
      return terminalResult(plan)
    }

    while (true) {
      projection = await this.options.journal.loadProjection(input.sessionId)
      plan = requirePlan(projection, input.planId)
      if (plan.state !== 'running') return terminalResult(plan)
      if (input.signal?.aborted) return this.finishBeforeClaim(input, projection, 'cancelled')

      const stepId = plan.readyStepIds[0]
      if (stepId === undefined) return this.finishWithoutReadyStep(input, projection)
      let claim: ClaimedAttempt | undefined = await this.claim(input, projection, stepId)

      while (claim !== undefined) {
        const outcome = await this.executeClaim(input, claim)
        if ('terminal' in outcome) return outcome.terminal
        claim = outcome.retry
      }
    }
  }

  /** M4 restart gate: active work is interrupted in one CAS commit and is never retried. */
  async recoverInterrupted(
    input: Pick<SerialSupervisorInputV1, 'sessionId' | 'parentRunId' | 'planId'>,
  ): Promise<SerialSupervisorResultV1> {
    validateInput(input)
    const projection = await this.options.journal.loadProjection(input.sessionId)
    const plan = requirePlan(projection, input.planId)
    if (plan.state !== 'running') return terminalResult(plan)
    const events: JournalEventDraft[] = []
    for (const step of plan.steps) {
      const activeAttempt = [...step.attempts]
        .reverse()
        .find((attempt) =>
          ['reserved', 'running', 'execution_succeeded', 'verifying'].includes(attempt.state),
        )
      if (activeAttempt !== undefined) {
        events.push(
          attemptEvent(
            'attempt.state_changed',
            plan,
            step,
            activeAttempt.attemptId,
            { state: 'interrupted' },
            input.parentRunId,
            activeAttempt.childRunId,
          ),
        )
      }
      if (step.state === 'running' || step.state === 'verifying') {
        events.push(
          stepEvent('step.state_changed', plan, step, { state: 'interrupted' }, input.parentRunId),
        )
      }
    }
    events.push(planEvent('plan.state_changed', plan, { state: 'interrupted' }, input.parentRunId))
    const activeRun = projection.snapshot.runs.find(
      (run) => run.runId === input.parentRunId && run.state === 'running',
    )
    if (activeRun !== undefined) {
      events.push({
        type: 'run.terminal',
        runId: input.parentRunId,
        data: { status: 'interrupted', usage: {}, errorCode: 'SUPERVISOR_RESTART_INTERRUPTED' },
      })
    }
    await this.append(projection, 'recover-interrupted', events)
    return Object.freeze({ planId: plan.planId, state: 'interrupted' })
  }

  private async claim(
    input: SerialSupervisorInputV1,
    projection: SessionProjectionV3,
    stepId: string,
  ): Promise<ClaimedAttempt> {
    const plan = requirePlan(projection, input.planId)
    const step = requireStep(plan, stepId)
    if (!plan.readyStepIds.includes(stepId)) fail('SUPERVISOR_STEP_NOT_READY')
    const attemptId = this.#createId('attempt')
    const childRunId = this.#createId('child-run')
    const ordinal = step.attempts.length + 1
    await this.append(projection, `claim-${stepId}`, [
      attemptEvent(
        'attempt.created',
        plan,
        step,
        attemptId,
        { ordinal, state: 'reserved', childRunId },
        input.parentRunId,
        childRunId,
      ),
      stepEvent('step.state_changed', plan, step, { state: 'running' }, input.parentRunId),
      attemptEvent(
        'attempt.state_changed',
        plan,
        step,
        attemptId,
        { state: 'running' },
        input.parentRunId,
        childRunId,
      ),
    ])
    return Object.freeze({ stepId, attemptId, childRunId, ordinal })
  }

  private async executeClaim(
    input: SerialSupervisorInputV1,
    claim: ClaimedAttempt,
  ): Promise<
    | Readonly<{ retry: ClaimedAttempt | undefined }>
    | Readonly<{ terminal: SerialSupervisorResultV1 }>
  > {
    let projection = await this.options.journal.loadProjection(input.sessionId)
    let plan = requirePlan(projection, input.planId)
    let step = requireStep(plan, claim.stepId)
    if (deadlineReached(step.budget.deadlineAt, this.#now())) {
      return {
        terminal: await this.finishActiveAttempt(
          input,
          projection,
          step,
          claim,
          'failed',
          'SUPERVISOR_STEP_DEADLINE_EXCEEDED',
        ),
      }
    }
    if (input.signal?.aborted) {
      return {
        terminal: await this.finishActiveAttempt(
          input,
          projection,
          step,
          claim,
          'cancelled',
          'SUPERVISOR_CANCELLED',
        ),
      }
    }

    let request: SubagentExecutionRequestV1
    try {
      request = validateSubagentExecutionRequestV1(
        await this.options.requestFactory.create({
          sessionId: input.sessionId,
          parentRunId: input.parentRunId,
          plan,
          step,
          attemptId: claim.attemptId,
          childRunId: claim.childRunId,
          budget: step.budget,
        }),
      )
      if (request.parentRunId !== input.parentRunId || request.childRunId !== claim.childRunId) {
        fail('SUPERVISOR_SUBAGENT_REQUEST_BINDING_MISMATCH')
      }
    } catch {
      return {
        terminal: await this.finishActiveAttempt(
          input,
          projection,
          step,
          claim,
          'interrupted',
          'SUPERVISOR_SUBAGENT_REQUEST_FAILED',
        ),
      }
    }

    try {
      const retrySafety = this.#retrySafety(step)
      if (!['read_only_idempotent', 'non_idempotent', 'unknown'].includes(retrySafety)) {
        fail('SUPERVISOR_RETRY_SAFETY_INVALID')
      }
      await this.append(projection, `bind-${claim.attemptId}`, [
        attemptEvent(
          'subagent.execution_bound',
          plan,
          step,
          claim.attemptId,
          { childRunId: claim.childRunId, request, retrySafety },
          input.parentRunId,
          claim.childRunId,
        ),
      ])
    } catch {
      projection = await this.options.journal.loadProjection(input.sessionId)
      step = requireStep(requirePlan(projection, input.planId), claim.stepId)
      return {
        terminal: await this.finishActiveAttempt(
          input,
          projection,
          step,
          claim,
          'interrupted',
          'SUPERVISOR_SUBAGENT_BINDING_FAILED',
        ),
      }
    }

    const cancel = () => {
      void this.options.executor.cancel({
        schemaVersion: 1,
        parentRunId: input.parentRunId,
        childRunId: claim.childRunId,
        reason: 'parent_cancelled',
      })
    }
    input.signal?.addEventListener('abort', cancel, { once: true })
    let result: SubagentResultV1
    try {
      result = await this.options.executor.execute(request)
      if (result.childRunId !== claim.childRunId) {
        fail('SUPERVISOR_SUBAGENT_RESULT_BINDING_MISMATCH')
      }
    } catch {
      projection = await this.options.journal.loadProjection(input.sessionId)
      plan = requirePlan(projection, input.planId)
      step = requireStep(plan, claim.stepId)
      return {
        terminal: await this.finishActiveAttempt(
          input,
          projection,
          step,
          claim,
          input.signal?.aborted ? 'cancelled' : 'interrupted',
          input.signal?.aborted ? 'SUPERVISOR_CANCELLED' : 'SUPERVISOR_SUBAGENT_FAILED',
        ),
      }
    } finally {
      input.signal?.removeEventListener('abort', cancel)
    }

    if (input.signal?.aborted) {
      projection = await this.options.journal.loadProjection(input.sessionId)
      step = requireStep(requirePlan(projection, input.planId), claim.stepId)
      return {
        terminal: await this.finishActiveAttempt(
          input,
          projection,
          step,
          claim,
          'cancelled',
          'SUPERVISOR_CANCELLED',
        ),
      }
    }

    let artifact: ArtifactReference
    try {
      artifact = validateArtifact(
        await this.options.artifactStore.put(
          result,
          'application/vnd.praxis.subagent-result.v1+json',
        ),
      )
    } catch {
      projection = await this.options.journal.loadProjection(input.sessionId)
      step = requireStep(requirePlan(projection, input.planId), claim.stepId)
      return {
        terminal: await this.finishActiveAttempt(
          input,
          projection,
          step,
          claim,
          'interrupted',
          'SUPERVISOR_RESULT_ARTIFACT_FAILED',
        ),
      }
    }

    projection = await this.options.journal.loadProjection(input.sessionId)
    plan = requirePlan(projection, input.planId)
    step = requireStep(plan, claim.stepId)
    const resultRef = `artifact://${artifact.artifactId}`
    const resultEvents: JournalEventDraft[] = [
      {
        type: 'artifact.referenced',
        runId: input.parentRunId,
        correlation: correlation(plan, step, claim.attemptId, claim.childRunId),
        data: { owner: 'subagent', artifact },
      },
      attemptEvent(
        'subagent.result_recorded',
        plan,
        step,
        claim.attemptId,
        {
          childRunId: claim.childRunId,
          resultRef,
          resultDigest: artifact.digest,
          status: result.status,
        },
        input.parentRunId,
        claim.childRunId,
      ),
      attemptEvent(
        'attempt.execution_completed',
        plan,
        step,
        claim.attemptId,
        { status: result.status },
        input.parentRunId,
        claim.childRunId,
      ),
      {
        type: 'usage.recorded',
        runId: input.parentRunId,
        correlation: correlation(plan, step, claim.attemptId, claim.childRunId),
        data: { source: 'subagent', usage: result.usage },
      },
    ]

    if (result.status === 'succeeded') {
      resultEvents.push(
        attemptEvent(
          'attempt.state_changed',
          plan,
          step,
          claim.attemptId,
          { state: 'verifying' },
          input.parentRunId,
          claim.childRunId,
        ),
        stepEvent('step.state_changed', plan, step, { state: 'verifying' }, input.parentRunId),
      )
      await this.append(projection, `execution-succeeded-${claim.attemptId}`, resultEvents)
      return this.verifyClaim(input, claim, result)
    }

    if (result.status === 'cancelled') {
      resultEvents.push(
        stepEvent('step.state_changed', plan, step, { state: 'cancelled' }, input.parentRunId),
        ...this.planAndRunTerminalEvents(input, plan, 'cancelled', 'SUPERVISOR_CANCELLED'),
      )
      await this.append(projection, `execution-cancelled-${claim.attemptId}`, resultEvents)
      return { terminal: Object.freeze({ planId: plan.planId, state: 'cancelled' }) }
    }

    resultEvents.push(
      stepEvent('step.state_changed', plan, step, { state: 'failed' }, input.parentRunId),
    )
    const retry = result.retryable ? this.retryEvents(input, plan, step, claim.ordinal) : undefined
    if (retry !== undefined) {
      resultEvents.push(...retry.events)
    } else {
      resultEvents.push(
        ...this.cancelPendingSteps(input, plan, step.stepId),
        ...this.planAndRunTerminalEvents(
          input,
          plan,
          'failed',
          result.error?.code ?? 'SUPERVISOR_SUBAGENT_EXECUTION_FAILED',
        ),
      )
    }
    await this.append(projection, `execution-failed-${claim.attemptId}`, resultEvents)
    return retry === undefined
      ? { terminal: Object.freeze({ planId: plan.planId, state: 'failed' }) }
      : { retry: retry.claim }
  }

  private async verifyClaim(
    input: SerialSupervisorInputV1,
    claim: ClaimedAttempt,
    result: SubagentResultV1,
  ): Promise<
    | Readonly<{ retry: ClaimedAttempt | undefined }>
    | Readonly<{ terminal: SerialSupervisorResultV1 }>
  > {
    const projection = await this.options.journal.loadProjection(input.sessionId)
    const plan = requirePlan(projection, input.planId)
    const step = requireStep(plan, claim.stepId)
    const mechanical = await verifySafely(
      this.options.mechanicalVerifier,
      { step, result, signal: input.signal },
      'mechanical',
    )
    const rule = await verifySafely(
      this.options.ruleVerifier,
      { step, result, signal: input.signal },
      'rule',
    )
    const needsSemantic = step.criteria.some((criterion) => criterion.kind === 'semantic')
    const semantic =
      needsSemantic && mechanical.status === 'passed' && rule.status === 'passed'
        ? this.options.semanticVerifier === undefined
          ? semanticVerifierUnavailableV1()
          : await verifySafely(
              this.options.semanticVerifier,
              { step, result, signal: input.signal },
              'model',
            )
        : undefined
    if (input.signal?.aborted) {
      return {
        terminal: await this.finishActiveAttempt(
          input,
          projection,
          step,
          claim,
          'cancelled',
          'SUPERVISOR_CANCELLED',
        ),
      }
    }
    const events: JournalEventDraft[] = [
      verificationEvent(
        plan,
        step,
        claim,
        mechanical,
        this.#createId('verification'),
        input.parentRunId,
      ),
      verificationEvent(plan, step, claim, rule, this.#createId('verification'), input.parentRunId),
      ...(semantic === undefined
        ? []
        : [
            verificationEvent(
              plan,
              step,
              claim,
              semantic,
              this.#createId('verification'),
              input.parentRunId,
            ),
          ]),
    ]
    const passed =
      mechanical.status === 'passed' &&
      rule.status === 'passed' &&
      (semantic === undefined || semantic.status === 'passed')
    if (passed) {
      events.push(
        attemptEvent(
          'attempt.state_changed',
          plan,
          step,
          claim.attemptId,
          { state: 'verified' },
          input.parentRunId,
          claim.childRunId,
        ),
        stepEvent('step.state_changed', plan, step, { state: 'succeeded' }, input.parentRunId),
      )
      const lastStep = plan.steps.every(
        (candidate) => candidate.stepId === step.stepId || candidate.state === 'succeeded',
      )
      if (lastStep) {
        events.push(...this.planAndRunTerminalEvents(input, plan, 'succeeded'))
      }
      await this.append(projection, `verification-passed-${claim.attemptId}`, events)
      return lastStep
        ? { terminal: Object.freeze({ planId: plan.planId, state: 'succeeded' }) }
        : { retry: undefined }
    }

    const blocked =
      mechanical.status === 'blocked' || rule.status === 'blocked' || semantic?.status === 'blocked'
    events.push(
      attemptEvent(
        'attempt.state_changed',
        plan,
        step,
        claim.attemptId,
        { state: 'rejected' },
        input.parentRunId,
        claim.childRunId,
      ),
      stepEvent(
        'step.state_changed',
        plan,
        step,
        { state: blocked ? 'blocked' : 'failed' },
        input.parentRunId,
      ),
    )
    const retry =
      !blocked && (mechanical.retryable || rule.retryable || semantic?.retryable === true)
        ? this.retryEvents(input, plan, step, claim.ordinal)
        : undefined
    if (retry !== undefined) {
      events.push(...retry.events)
    } else {
      if (!blocked) events.push(...this.cancelPendingSteps(input, plan, step.stepId))
      events.push(
        ...this.planAndRunTerminalEvents(
          input,
          plan,
          blocked ? 'blocked' : 'failed',
          blocked ? 'SUPERVISOR_VERIFICATION_BLOCKED' : 'SUPERVISOR_VERIFICATION_FAILED',
        ),
      )
    }
    await this.append(projection, `verification-rejected-${claim.attemptId}`, events)
    return retry === undefined
      ? {
          terminal: Object.freeze({
            planId: plan.planId,
            state: blocked ? 'blocked' : 'failed',
          }),
        }
      : { retry: retry.claim }
  }

  private retryEvents(
    input: SerialSupervisorInputV1,
    plan: SessionPlanGraphProjectionV3,
    step: SessionStepProjectionV3,
    completedOrdinal: number,
  ): Readonly<{ claim: ClaimedAttempt; events: readonly JournalEventDraft[] }> | undefined {
    if (completedOrdinal >= step.maxAttempts) return undefined
    const attemptId = this.#createId('attempt')
    const childRunId = this.#createId('child-run')
    const ordinal = completedOrdinal + 1
    const claim = Object.freeze({ stepId: step.stepId, attemptId, childRunId, ordinal })
    return Object.freeze({
      claim,
      events: Object.freeze([
        attemptEvent(
          'attempt.created',
          plan,
          step,
          attemptId,
          { ordinal, state: 'reserved', childRunId },
          input.parentRunId,
          childRunId,
        ),
        stepEvent(
          'step.state_changed',
          plan,
          step,
          { state: 'pending', reason: 'retry_approved', newAttemptId: attemptId },
          input.parentRunId,
        ),
        stepEvent('step.state_changed', plan, step, { state: 'running' }, input.parentRunId),
        attemptEvent(
          'attempt.state_changed',
          plan,
          step,
          attemptId,
          { state: 'running' },
          input.parentRunId,
          childRunId,
        ),
      ]),
    })
  }

  private async finishBeforeClaim(
    input: SerialSupervisorInputV1,
    projection: SessionProjectionV3,
    state: 'cancelled',
  ): Promise<SerialSupervisorResultV1> {
    const plan = requirePlan(projection, input.planId)
    await this.append(projection, 'cancel-before-claim', [
      ...this.cancelPendingSteps(input, plan),
      ...this.planAndRunTerminalEvents(input, plan, state, 'SUPERVISOR_CANCELLED'),
    ])
    return Object.freeze({ planId: plan.planId, state })
  }

  private async finishWithoutReadyStep(
    input: SerialSupervisorInputV1,
    projection: SessionProjectionV3,
  ): Promise<SerialSupervisorResultV1> {
    const plan = requirePlan(projection, input.planId)
    if (plan.steps.every((step) => step.state === 'succeeded')) {
      await this.append(
        projection,
        'complete-plan',
        this.planAndRunTerminalEvents(input, plan, 'succeeded'),
      )
      return Object.freeze({ planId: plan.planId, state: 'succeeded' })
    }
    const blocked = plan.steps.some((step) => step.state === 'blocked')
    const failed = plan.steps.some((step) => step.state === 'failed')
    const cancelled = plan.steps.some((step) => step.state === 'cancelled')
    const state = cancelled ? 'cancelled' : failed ? 'failed' : 'blocked'
    const errorCode =
      state === 'cancelled'
        ? 'SUPERVISOR_CANCELLED'
        : state === 'failed'
          ? 'SUPERVISOR_DEPENDENCY_FAILED'
          : blocked
            ? 'SUPERVISOR_BLOCKED'
            : 'SUPERVISOR_DEADLOCK'
    await this.append(projection, `finish-${state}`, [
      ...(state === 'failed' || state === 'cancelled' ? this.cancelPendingSteps(input, plan) : []),
      ...this.planAndRunTerminalEvents(input, plan, state, errorCode),
    ])
    return Object.freeze({ planId: plan.planId, state })
  }

  private async finishActiveAttempt(
    input: SerialSupervisorInputV1,
    projection: SessionProjectionV3,
    step: SessionStepProjectionV3,
    claim: ClaimedAttempt,
    state: 'failed' | 'cancelled' | 'interrupted',
    errorCode: string,
  ): Promise<SerialSupervisorResultV1> {
    const plan = requirePlan(projection, input.planId)
    const attemptState = state === 'interrupted' ? 'interrupted' : 'cancelled'
    const stepState = state
    const events: JournalEventDraft[] = [
      attemptEvent(
        'attempt.state_changed',
        plan,
        step,
        claim.attemptId,
        { state: attemptState },
        input.parentRunId,
        claim.childRunId,
      ),
      stepEvent('step.state_changed', plan, step, { state: stepState }, input.parentRunId),
      ...this.cancelPendingSteps(input, plan, step.stepId),
      ...this.planAndRunTerminalEvents(input, plan, state, errorCode),
    ]
    await this.append(projection, `active-${state}-${claim.attemptId}`, events)
    return Object.freeze({ planId: plan.planId, state })
  }

  private cancelPendingSteps(
    input: Pick<SerialSupervisorInputV1, 'parentRunId'>,
    plan: SessionPlanGraphProjectionV3,
    exceptStepId?: string,
  ): JournalEventDraft[] {
    return plan.steps
      .filter((step) => step.stepId !== exceptStepId && step.state === 'pending')
      .map((step) =>
        stepEvent('step.state_changed', plan, step, { state: 'cancelled' }, input.parentRunId),
      )
  }

  private planAndRunTerminalEvents(
    input: Pick<SerialSupervisorInputV1, 'parentRunId'>,
    plan: SessionPlanGraphProjectionV3,
    state: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'interrupted',
    errorCode?: string,
  ): JournalEventDraft[] {
    return [
      planEvent('plan.state_changed', plan, { state }, input.parentRunId),
      {
        type: 'run.terminal',
        runId: input.parentRunId,
        data: {
          status:
            state === 'succeeded'
              ? 'completed'
              : state === 'cancelled'
                ? 'aborted'
                : state === 'interrupted'
                  ? 'interrupted'
                  : 'failed',
          usage: {},
          ...(errorCode === undefined ? {} : { errorCode }),
        },
      },
    ]
  }

  private async append(
    projection: SessionProjectionV3,
    label: string,
    events: readonly JournalEventDraft[],
  ): Promise<void> {
    if (events.length === 0) fail('SUPERVISOR_EMPTY_COMMIT')
    const token = this.#createId(label)
    const revision = projection.snapshot.revision + 1
    const timestamp = maxInstant(this.#now(), projection.catalog.updatedAt)
    const entries = events.map((event, index) =>
      validateSessionEntryV3({
        schemaVersion: 3,
        entryId: this.#createId('entry'),
        sessionId: projection.snapshot.sessionId,
        sequence: projection.snapshot.sequence + index + 1,
        revision,
        timestamp,
        type: event.type,
        ...(event.runId === undefined ? {} : { runId: event.runId }),
        ...(event.correlation === undefined ? {} : { correlation: event.correlation }),
        data: event.data,
      }),
    )
    await this.options.journal.appendCommit(
      createSessionCommitV3({
        sessionId: projection.snapshot.sessionId,
        commitId: `commit-${token}`,
        expectedRevision: projection.snapshot.revision,
        idempotencyKey: `idem-${token}`,
        entries,
      }),
    )
  }
}

function planEvent(
  type: string,
  plan: SessionPlanGraphProjectionV3,
  data: Record<string, unknown>,
  runId: string,
): JournalEventDraft {
  return {
    type,
    runId,
    correlation: { parentRunId: runId, planId: plan.planId },
    data: { planId: plan.planId, planRevision: plan.revision, ...data },
  }
}

function stepEvent(
  type: string,
  plan: SessionPlanGraphProjectionV3,
  step: SessionStepProjectionV3,
  data: Record<string, unknown>,
  runId: string,
): JournalEventDraft {
  return {
    type,
    runId,
    correlation: { parentRunId: runId, planId: plan.planId, stepId: step.stepId },
    data: {
      planId: plan.planId,
      planRevision: plan.revision,
      stepId: step.stepId,
      ...data,
    },
  }
}

function attemptEvent(
  type: string,
  plan: SessionPlanGraphProjectionV3,
  step: SessionStepProjectionV3,
  attemptId: string,
  data: Record<string, unknown>,
  runId: string,
  childRunId?: string,
): JournalEventDraft {
  return {
    type,
    runId,
    correlation: correlation(plan, step, attemptId, childRunId, runId),
    data: {
      planId: plan.planId,
      planRevision: plan.revision,
      stepId: step.stepId,
      attemptId,
      ...data,
    },
  }
}

function verificationEvent(
  plan: SessionPlanGraphProjectionV3,
  step: SessionStepProjectionV3,
  claim: ClaimedAttempt,
  decision: VerificationDecisionV1,
  verificationId: string,
  runId: string,
): JournalEventDraft {
  return attemptEvent(
    'verification.recorded',
    plan,
    step,
    claim.attemptId,
    {
      verificationId,
      verifier: decision.verifier,
      status: decision.status,
      evidenceRefs: decision.evidenceRefs,
      code: decision.code,
      retryable: decision.retryable,
    },
    runId,
    claim.childRunId,
  )
}

function correlation(
  plan: SessionPlanGraphProjectionV3,
  step: SessionStepProjectionV3,
  attemptId: string,
  childRunId?: string,
  parentRunId?: string,
): Record<string, string> {
  return {
    ...(parentRunId === undefined ? {} : { parentRunId }),
    ...(childRunId === undefined ? {} : { childRunId }),
    planId: plan.planId,
    stepId: step.stepId,
    attemptId,
  }
}

async function verifySafely(
  verifier: SupervisorVerifierV1,
  input: Parameters<SupervisorVerifierV1['verify']>[0],
  kind: VerificationDecisionV1['verifier'],
): Promise<VerificationDecisionV1> {
  try {
    const decision = await verifier.verify(input)
    if (decision.verifier !== kind) throw new Error('verifier kind mismatch')
    return decision
  } catch {
    return Object.freeze({
      verifier: kind,
      status: 'blocked',
      evidenceRefs: Object.freeze([]),
      code: 'VERIFIER_FAILED',
      retryable: false,
    })
  }
}

function requirePlan(
  projection: SessionProjectionV3,
  planId: string,
): SessionPlanGraphProjectionV3 {
  if (projection.planGraph?.planId !== planId) fail('SUPERVISOR_PLAN_NOT_FOUND')
  return projection.planGraph
}

function requireStep(plan: SessionPlanGraphProjectionV3, stepId: string): SessionStepProjectionV3 {
  const step = plan.steps.find((candidate) => candidate.stepId === stepId)
  if (step === undefined) fail('SUPERVISOR_STEP_NOT_FOUND')
  return step
}

function requireActiveRun(projection: SessionProjectionV3, runId: string): void {
  if (!projection.snapshot.runs.some((run) => run.runId === runId && run.state === 'running')) {
    fail('SUPERVISOR_PARENT_RUN_NOT_ACTIVE')
  }
}

function terminalResult(plan: SessionPlanGraphProjectionV3): SerialSupervisorResultV1 {
  if (!['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(plan.state)) {
    fail('SUPERVISOR_PLAN_NOT_RUNNING')
  }
  return Object.freeze({
    planId: plan.planId,
    state: plan.state as SerialSupervisorResultV1['state'],
  })
}

function validateInput(
  input: Pick<SerialSupervisorInputV1, 'sessionId' | 'parentRunId' | 'planId'>,
): void {
  if (!safeId(input.sessionId) || !safeId(input.parentRunId) || !safeId(input.planId)) {
    fail('SUPERVISOR_INPUT_INVALID')
  }
}

function validateArtifact(input: ArtifactReference): ArtifactReference {
  if (
    !safeId(input.artifactId) ||
    typeof input.digest !== 'string' ||
    !SHA256.test(input.digest) ||
    typeof input.mimeType !== 'string' ||
    input.mimeType.length === 0 ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 0
  ) {
    fail('SUPERVISOR_ARTIFACT_INVALID')
  }
  return input
}

function deadlineReached(deadlineAt: string | undefined, now: string): boolean {
  return deadlineAt !== undefined && now >= deadlineAt
}

function maxInstant(left: string, right: string): string {
  return left >= right ? left : right
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function fail(code: string): never {
  throw Object.assign(new Error(code), runtimeError(code, 'planner', code), { code })
}
