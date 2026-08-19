import { randomUUID } from 'node:crypto'
import {
  type ArtifactReference,
  type BudgetUsage,
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
import { currentRunBudgetUsageV1 } from './runBudgetUsage.js'
import { validateSubagentResultV1 } from '../subagent/contextPacket.js'
import type {
  DagFailureModeV1,
  DagScheduleInputV1,
  DagSchedulerV1,
  DagStepClaimV1,
} from './dagScheduler.js'
import type {
  FixedPlanSubagentRequestFactoryV1,
  SupervisorArtifactStoreV1,
} from './serialSupervisor.js'
import {
  type SupervisorVerifierV1,
  semanticVerifierUnavailableV1,
  type VerificationDecisionV1,
} from './verifier.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const DEFAULT_CAS_RETRIES = 8
const MAX_CAS_RETRIES = 32

export type DagResumableClaimV1 = Readonly<{
  stepId: string
  attemptId: string
  childRunId: string
  request: SubagentExecutionRequestV1
}>

export type DagSupervisorInputV1 = Readonly<{
  sessionId: string
  parentRunId: string
  planId: string
  parentBudget: Readonly<ExecutionBudget>
  failureMode: DagFailureModeV1
  resumedClaims?: readonly DagResumableClaimV1[]
  signal?: AbortSignal
}>

export type DagSupervisorResultV1 = Readonly<{
  planId: string
  state: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'interrupted'
  revision: number
  stepStates: readonly Readonly<{ stepId: string; state: string; errorCode?: string }>[]
}>

export type DagSupervisorOptionsV1 = Readonly<{
  journal: SessionJournalV3
  scheduler: DagSchedulerV1
  executor: SubagentExecutor
  requestFactory: FixedPlanSubagentRequestFactoryV1
  artifactStore: SupervisorArtifactStoreV1
  mechanicalVerifier: SupervisorVerifierV1
  ruleVerifier: SupervisorVerifierV1
  semanticVerifier?: SupervisorVerifierV1
  retrySafety?: (step: SessionStepProjectionV3) => SessionRetrySafetyV3
  maxCasRetries?: number
  createId?: (kind: string) => string
  now?: () => string
  /** Caller-owned keeps the parent Run active for a final synthesis phase. */
  terminalOwner?: 'supervisor' | 'caller'
}>

type WorkerClaim = Readonly<{
  stepId: string
  attemptId: string
  childRunId: string
  request?: SubagentExecutionRequestV1
  budget?: Readonly<ExecutionBudget>
}>

type WorkerOutcome = Readonly<{
  stepId: string
  state: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'interrupted'
  errorCode?: string
}>

type JournalEventDraft = Readonly<{
  type: string
  data: Record<string, unknown>
  correlation?: Record<string, string>
}>

/** Parent-owned bounded read-only DAG execution and single-terminal coordinator. */
export class DagSupervisorV1 {
  readonly #createId: (kind: string) => string
  readonly #now: () => string
  readonly #retrySafety: (step: SessionStepProjectionV3) => SessionRetrySafetyV3
  readonly #maxCasRetries: number

  constructor(private readonly options: DagSupervisorOptionsV1) {
    this.#createId = options.createId ?? ((kind) => `${kind}-${randomUUID()}`)
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#retrySafety = options.retrySafety ?? (() => 'unknown')
    const retries = options.maxCasRetries ?? DEFAULT_CAS_RETRIES
    if (!Number.isSafeInteger(retries) || retries < 1 || retries > MAX_CAS_RETRIES) {
      fail('DAG_SUPERVISOR_CAS_POLICY_INVALID')
    }
    this.#maxCasRetries = retries
  }

  async execute(input: DagSupervisorInputV1): Promise<DagSupervisorResultV1> {
    validateInput(input)
    let projection = await this.options.journal.loadProjection(input.sessionId)
    let plan = requirePlan(projection, input.planId)
    requireActiveRunOrTerminal(projection, input.parentRunId, plan)
    if (plan.state !== 'draft' && plan.state !== 'running') return result(projection, plan)

    if (plan.state === 'draft') {
      if (input.resumedClaims !== undefined && input.resumedClaims.length > 0) {
        fail('DAG_SUPERVISOR_RESUME_INVALID')
      }
      await this.appendWithRetry(input, 'start-plan', (current) => {
        const currentPlan = requirePlan(current, input.planId)
        if (currentPlan.state === 'running') return undefined
        if (currentPlan.state !== 'draft') return undefined
        return [
          planEvent('plan.state_changed', currentPlan, { state: 'running' }, input.parentRunId),
        ]
      })
    }

    const controller = new AbortController()
    const onParentAbort = () => controller.abort(input.signal?.reason)
    if (input.signal?.aborted) onParentAbort()
    else input.signal?.addEventListener('abort', onParentAbort, { once: true })

    try {
      if (input.resumedClaims !== undefined && input.resumedClaims.length > 0) {
        const resumed = await this.validateResumedClaims(input, input.resumedClaims)
        const outcomes = await this.runBatch(input, resumed, controller)
        if (input.signal?.aborted) return this.finalize(input, 'cancelled', 'DAG_CANCELLED')
        const failFast = terminalWorkerOutcome(outcomes)
        if (input.failureMode === 'fail_fast' && failFast !== undefined) {
          return this.finalize(input, terminalPlanState(failFast), failFast.errorCode)
        }
      }

      while (true) {
        if (input.signal?.aborted) return this.finalize(input, 'cancelled', 'DAG_CANCELLED')
        const decision = await this.scheduleWithRetry(input)
        if (decision.state === 'claimed') {
          const outcomes = await this.runBatch(input, decision.claims, controller)
          if (input.signal?.aborted) return this.finalize(input, 'cancelled', 'DAG_CANCELLED')
          const failFast = terminalWorkerOutcome(outcomes)
          if (input.failureMode === 'fail_fast' && failFast !== undefined) {
            return this.finalize(input, terminalPlanState(failFast), failFast.errorCode)
          }
          continue
        }
        if (decision.state === 'waiting') fail('DAG_SUPERVISOR_ACTIVE_WORK_UNOWNED')
        if (decision.state === 'complete') return this.finalize(input, 'succeeded')
        if (
          decision.state === 'failed' ||
          decision.state === 'blocked' ||
          decision.state === 'budget_exhausted' ||
          decision.state === 'deadlocked'
        ) {
          projection = await this.options.journal.loadProjection(input.sessionId)
          plan = requirePlan(projection, input.planId)
          const state = plan.steps.some((step) => ['failed', 'interrupted'].includes(step.state))
            ? 'failed'
            : 'blocked'
          return this.finalize(input, state, decision.reasonCode ?? 'DAG_NO_PROGRESS')
        }
        projection = await this.options.journal.loadProjection(input.sessionId)
        return result(projection, requirePlan(projection, input.planId))
      }
    } finally {
      input.signal?.removeEventListener('abort', onParentAbort)
    }
  }

  private async validateResumedClaims(
    input: DagSupervisorInputV1,
    claims: readonly DagResumableClaimV1[],
  ): Promise<readonly WorkerClaim[]> {
    const projection = await this.options.journal.loadProjection(input.sessionId)
    const plan = requirePlan(projection, input.planId)
    const seenSteps = new Set<string>()
    const seenAttempts = new Set<string>()
    const cumulativeAttempts = plan.steps.reduce((total, step) => total + step.attempts.length, 0)
    if (
      claims.length > input.parentBudget.maxParallelChildren ||
      cumulativeAttempts > input.parentBudget.maxChildRuns
    ) {
      fail('DAG_SUPERVISOR_RESUME_INVALID')
    }
    const validated = Object.freeze(
      claims.map((claim) => {
        if (seenSteps.has(claim.stepId) || seenAttempts.has(claim.attemptId)) {
          fail('DAG_SUPERVISOR_RESUME_INVALID')
        }
        seenSteps.add(claim.stepId)
        seenAttempts.add(claim.attemptId)
        const step = requireStep(plan, claim.stepId)
        const attempt = requireAttempt(step, claim.attemptId)
        const request = validateSubagentExecutionRequestV1(claim.request)
        if (
          step.state !== 'running' ||
          attempt.state !== 'running' ||
          attempt.childRunId !== claim.childRunId ||
          attempt.execution === undefined ||
          !sameRequest(attempt.execution.request, request) ||
          request.parentRunId !== input.parentRunId ||
          request.childRunId !== claim.childRunId
        ) {
          fail('DAG_SUPERVISOR_RESUME_INVALID')
        }
        return Object.freeze({ ...claim, request })
      }),
    )
    if (
      !budgetsFit(
        input.parentBudget,
        currentRunBudgetUsageV1(projection, input.parentRunId),
        validated.map((claim) => requireStep(plan, claim.stepId).budget),
      )
    ) {
      fail('DAG_SUPERVISOR_RESUME_INVALID')
    }
    return validated
  }

  private async runBatch(
    input: DagSupervisorInputV1,
    claims: readonly (DagStepClaimV1 | WorkerClaim)[],
    controller: AbortController,
  ): Promise<readonly WorkerOutcome[]> {
    const executions = claims.map(async (claim) => {
      const outcome = await this.runClaim(input, claim, controller.signal)
      if (input.failureMode === 'fail_fast' && outcome.state !== 'succeeded') {
        controller.abort(outcome.errorCode)
      }
      return outcome
    })
    return Object.freeze(await Promise.all(executions))
  }

  private async runClaim(
    input: DagSupervisorInputV1,
    claim: DagStepClaimV1 | WorkerClaim,
    signal: AbortSignal,
  ): Promise<WorkerOutcome> {
    let projection = await this.options.journal.loadProjection(input.sessionId)
    let plan = requirePlan(projection, input.planId)
    let step = requireStep(plan, claim.stepId)
    const executionBudget =
      'budget' in claim && claim.budget !== undefined ? claim.budget : step.budget
    requireRunningAttempt(step, claim.attemptId, claim.childRunId)
    if (deadlineReached(step.budget.deadlineAt, this.#now())) {
      return this.terminateAttempt(input, claim, 'failed', 'DAG_STEP_DEADLINE_EXCEEDED')
    }
    if (signal.aborted) {
      return this.terminateAttempt(input, claim, 'cancelled', 'DAG_CANCELLED')
    }

    let request: SubagentExecutionRequestV1
    if ('request' in claim && claim.request !== undefined) {
      request = validateSubagentExecutionRequestV1(claim.request)
    } else {
      try {
        request = validateSubagentExecutionRequestV1(
          await this.options.requestFactory.create({
            sessionId: input.sessionId,
            parentRunId: input.parentRunId,
            plan,
            step,
            attemptId: claim.attemptId,
            childRunId: claim.childRunId,
            budget: executionBudget,
          }),
        )
        if (request.parentRunId !== input.parentRunId || request.childRunId !== claim.childRunId) {
          fail('DAG_SUBAGENT_REQUEST_BINDING_MISMATCH')
        }
      } catch (error) {
        return this.terminateAttempt(
          input,
          claim,
          'interrupted',
          safeId(runtimeCode(error)) ? runtimeCode(error)! : 'DAG_SUBAGENT_REQUEST_FAILED',
        )
      }
      let retrySafety: SessionRetrySafetyV3
      try {
        retrySafety = this.#retrySafety(step)
        if (!['read_only_idempotent', 'non_idempotent', 'unknown'].includes(retrySafety)) {
          throw new Error('invalid retry safety')
        }
      } catch {
        return this.terminateAttempt(input, claim, 'interrupted', 'DAG_RETRY_SAFETY_INVALID')
      }
      try {
        await this.appendWithRetry(input, `bind-${claim.attemptId}`, (current) => {
          const currentPlan = requirePlan(current, input.planId)
          const currentStep = requireStep(currentPlan, claim.stepId)
          requireRunningAttempt(currentStep, claim.attemptId, claim.childRunId)
          return [
            attemptEvent(
              'subagent.execution_bound',
              currentPlan,
              currentStep,
              claim,
              { childRunId: claim.childRunId, request, retrySafety },
              input.parentRunId,
            ),
          ]
        })
      } catch {
        return this.terminateAttempt(input, claim, 'interrupted', 'DAG_SUBAGENT_BINDING_FAILED')
      }
    }

    if (signal.aborted) {
      return this.terminateAttempt(input, claim, 'cancelled', 'DAG_CANCELLED')
    }
    const cancel = () => {
      void this.options.executor
        .cancel({
          schemaVersion: 1,
          parentRunId: input.parentRunId,
          childRunId: claim.childRunId,
          reason: 'parent_cancelled',
        })
        .catch(() => false)
    }
    signal.addEventListener('abort', cancel, { once: true })
    let resultValue: SubagentResultV1
    let rawResult: unknown
    try {
      if (signal.aborted) cancel()
      rawResult = await this.options.executor.execute(request)
    } catch (error) {
      const code = runtimeCode(error) ?? 'DAG_SUBAGENT_CRASHED'
      return this.terminateAttempt(
        input,
        claim,
        signal.aborted ? 'cancelled' : 'interrupted',
        signal.aborted
          ? 'DAG_CANCELLED'
          : code.startsWith('CHILD_') || code.startsWith('SUBAGENT_')
            ? code
            : 'DAG_SUBAGENT_CRASHED',
        conservativeUsage(step.budget),
      )
    } finally {
      signal.removeEventListener('abort', cancel)
    }
    try {
      resultValue = validateSubagentResultV1(rawResult)
      if (
        resultValue.childRunId !== claim.childRunId ||
        !usageWithinStep(resultValue.usage, executionBudget)
      ) {
        fail('DAG_SUBAGENT_RESULT_INVALID')
      }
    } catch {
      return this.terminateAttempt(
        input,
        claim,
        signal.aborted ? 'cancelled' : 'interrupted',
        signal.aborted ? 'DAG_CANCELLED' : 'DAG_SUBAGENT_RESULT_INVALID',
        conservativeUsage(executionBudget),
      )
    }

    let artifact: ArtifactReference
    try {
      artifact = validateArtifact(
        await this.options.artifactStore.put(
          resultValue,
          'application/vnd.praxis.subagent-result.v1+json',
        ),
      )
    } catch {
      return this.terminateAttempt(
        input,
        claim,
        'interrupted',
        'DAG_RESULT_ARTIFACT_FAILED',
        resultValue.usage,
      )
    }

    const retryClaim =
      resultValue.status !== 'succeeded' &&
      resultValue.retryable &&
      !signal.aborted &&
      this.#retrySafety(step) === 'read_only_idempotent' &&
      step.attempts.length < step.maxAttempts &&
      plan.steps.reduce((total, candidate) => total + candidate.attempts.length, 0) <
        input.parentBudget.maxChildRuns &&
      hasRemainingRunBudget(
        input.parentBudget,
        currentRunBudgetUsageV1(projection, input.parentRunId),
        resultValue.usage,
      ) &&
      !deadlineReached(step.budget.deadlineAt, this.#now())
        ? Object.freeze({
            stepId: step.stepId,
            attemptId: this.#createId('attempt'),
            childRunId: this.#createId('child-run'),
            ordinal: step.attempts.length + 1,
            budget: remainingAttemptBudget(
              input.parentBudget,
              currentRunBudgetUsageV1(projection, input.parentRunId),
              resultValue.usage,
              step.budget,
            ),
          })
        : undefined

    let retryScheduled = false
    await this.appendWithRetry(input, `result-${claim.attemptId}`, (current) => {
      const currentPlan = requirePlan(current, input.planId)
      const currentStep = requireStep(currentPlan, claim.stepId)
      requireRunningAttempt(currentStep, claim.attemptId, claim.childRunId)
      retryScheduled =
        retryClaim !== undefined &&
        currentStep.attempts.length < currentStep.maxAttempts &&
        currentPlan.steps.reduce((total, candidate) => total + candidate.attempts.length, 0) <
          input.parentBudget.maxChildRuns &&
        hasRemainingRunBudget(
          input.parentBudget,
          currentRunBudgetUsageV1(current, input.parentRunId),
          resultValue.usage,
        ) &&
        !deadlineReached(currentStep.budget.deadlineAt, this.#now())
      const resultRef = `artifact://${artifact.artifactId}`
      const events: JournalEventDraft[] = [
        {
          type: 'artifact.referenced',
          correlation: correlation(currentPlan, currentStep, claim, input.parentRunId),
          data: { owner: 'subagent', artifact },
        },
        attemptEvent(
          'subagent.result_recorded',
          currentPlan,
          currentStep,
          claim,
          {
            childRunId: claim.childRunId,
            resultRef,
            resultDigest: artifact.digest,
            status: resultValue.status,
          },
          input.parentRunId,
        ),
        attemptEvent(
          'attempt.execution_completed',
          currentPlan,
          currentStep,
          claim,
          { status: resultValue.status },
          input.parentRunId,
        ),
        {
          type: 'usage.recorded',
          correlation: correlation(currentPlan, currentStep, claim, input.parentRunId),
          data: { source: 'subagent', usage: parentSubagentUsage(resultValue.usage) },
        },
      ]
      if (resultValue.status === 'succeeded') {
        events.push(
          attemptEvent(
            'attempt.state_changed',
            currentPlan,
            currentStep,
            claim,
            { state: 'verifying' },
            input.parentRunId,
          ),
          stepEvent(
            'step.state_changed',
            currentPlan,
            currentStep,
            { state: 'verifying' },
            input.parentRunId,
          ),
        )
      } else {
        events.push(
          stepEvent(
            'step.state_changed',
            currentPlan,
            currentStep,
            {
              state: !retryScheduled && resultValue.status === 'cancelled' ? 'cancelled' : 'failed',
              ...(resultValue.error === undefined ? {} : { errorCode: resultValue.error.code }),
            },
            input.parentRunId,
          ),
        )
        if (retryClaim !== undefined && retryScheduled) {
          events.push(
            attemptEvent(
              'attempt.created',
              currentPlan,
              currentStep,
              retryClaim,
              {
                ordinal: retryClaim.ordinal,
                state: 'reserved',
                childRunId: retryClaim.childRunId,
              },
              input.parentRunId,
            ),
            stepEvent(
              'step.state_changed',
              currentPlan,
              currentStep,
              {
                state: 'pending',
                reason: 'retry_approved',
                newAttemptId: retryClaim.attemptId,
              },
              input.parentRunId,
            ),
            stepEvent(
              'step.state_changed',
              currentPlan,
              currentStep,
              { state: 'running' },
              input.parentRunId,
            ),
            attemptEvent(
              'attempt.state_changed',
              currentPlan,
              currentStep,
              retryClaim,
              { state: 'running' },
              input.parentRunId,
            ),
          )
        }
      }
      return events
    })

    if (resultValue.status !== 'succeeded') {
      if (retryClaim !== undefined && retryScheduled) {
        return this.runClaim(input, retryClaim, signal)
      }
      return outcome(
        claim.stepId,
        resultValue.status === 'cancelled' ? 'cancelled' : 'failed',
        resultValue.error?.code ?? 'DAG_SUBAGENT_EXECUTION_FAILED',
      )
    }
    if (signal.aborted) {
      return this.terminateAttempt(input, claim, 'cancelled', 'DAG_CANCELLED')
    }

    projection = await this.options.journal.loadProjection(input.sessionId)
    plan = requirePlan(projection, input.planId)
    step = requireStep(plan, claim.stepId)
    const [mechanical, rule] = await Promise.all([
      verifySafely(
        this.options.mechanicalVerifier,
        { step, result: resultValue, signal },
        'mechanical',
      ),
      verifySafely(this.options.ruleVerifier, { step, result: resultValue, signal }, 'rule'),
    ])
    const needsSemantic = step.criteria.some((criterion) => criterion.kind === 'semantic')
    const semantic =
      needsSemantic && mechanical.status === 'passed' && rule.status === 'passed'
        ? this.options.semanticVerifier === undefined
          ? semanticVerifierUnavailableV1()
          : await verifySafely(
              this.options.semanticVerifier,
              { step, result: resultValue, signal },
              'model',
            )
        : undefined
    if (signal.aborted) {
      return this.terminateAttempt(input, claim, 'cancelled', 'DAG_CANCELLED')
    }

    const passed =
      mechanical.status === 'passed' &&
      rule.status === 'passed' &&
      (semantic === undefined || semantic.status === 'passed')
    const blocked =
      mechanical.status === 'blocked' || rule.status === 'blocked' || semantic?.status === 'blocked'
    const stepState = passed ? 'succeeded' : blocked ? 'blocked' : 'failed'
    const errorCode = passed ? undefined : verificationErrorCode(mechanical, rule, semantic)
    const verificationRetryClaim =
      !passed &&
      !blocked &&
      !signal.aborted &&
      [mechanical, rule, semantic].some(
        (decision) => decision?.status === 'failed' && decision.retryable,
      ) &&
      this.#retrySafety(step) === 'read_only_idempotent' &&
      step.attempts.length < step.maxAttempts &&
      plan.steps.reduce((total, candidate) => total + candidate.attempts.length, 0) <
        input.parentBudget.maxChildRuns &&
      hasRemainingRunBudget(
        input.parentBudget,
        currentRunBudgetUsageV1(projection, input.parentRunId),
      ) &&
      !deadlineReached(step.budget.deadlineAt, this.#now())
        ? Object.freeze({
            stepId: step.stepId,
            attemptId: this.#createId('attempt'),
            childRunId: this.#createId('child-run'),
            ordinal: step.attempts.length + 1,
            budget: remainingAttemptBudget(
              input.parentBudget,
              currentRunBudgetUsageV1(projection, input.parentRunId),
              Object.freeze({ turns: 0, toolCalls: 0, subagents: 0 }),
              step.budget,
            ),
          })
        : undefined
    let verificationRetryScheduled = false
    await this.appendWithRetry(input, `verify-${claim.attemptId}`, (current) => {
      const currentPlan = requirePlan(current, input.planId)
      const currentStep = requireStep(currentPlan, claim.stepId)
      requireVerifyingAttempt(currentStep, claim.attemptId, claim.childRunId)
      verificationRetryScheduled =
        verificationRetryClaim !== undefined &&
        currentStep.attempts.length < currentStep.maxAttempts &&
        currentPlan.steps.reduce((total, candidate) => total + candidate.attempts.length, 0) <
          input.parentBudget.maxChildRuns &&
        hasRemainingRunBudget(
          input.parentBudget,
          currentRunBudgetUsageV1(current, input.parentRunId),
        ) &&
        !deadlineReached(currentStep.budget.deadlineAt, this.#now())
      const events: JournalEventDraft[] = [
        verificationEvent(
          currentPlan,
          currentStep,
          claim,
          mechanical,
          this.#createId('verification'),
          input.parentRunId,
        ),
        verificationEvent(
          currentPlan,
          currentStep,
          claim,
          rule,
          this.#createId('verification'),
          input.parentRunId,
        ),
        ...(semantic === undefined
          ? []
          : [
              verificationEvent(
                currentPlan,
                currentStep,
                claim,
                semantic,
                this.#createId('verification'),
                input.parentRunId,
              ),
            ]),
        attemptEvent(
          'attempt.state_changed',
          currentPlan,
          currentStep,
          claim,
          { state: passed ? 'verified' : 'rejected' },
          input.parentRunId,
        ),
        stepEvent(
          'step.state_changed',
          currentPlan,
          currentStep,
          { state: stepState, ...(errorCode === undefined ? {} : { errorCode }) },
          input.parentRunId,
        ),
      ]
      if (verificationRetryClaim !== undefined && verificationRetryScheduled) {
        events.push(
          attemptEvent(
            'attempt.created',
            currentPlan,
            currentStep,
            verificationRetryClaim,
            {
              ordinal: verificationRetryClaim.ordinal,
              state: 'reserved',
              childRunId: verificationRetryClaim.childRunId,
            },
            input.parentRunId,
          ),
          stepEvent(
            'step.state_changed',
            currentPlan,
            currentStep,
            {
              state: 'pending',
              reason: 'retry_approved',
              newAttemptId: verificationRetryClaim.attemptId,
            },
            input.parentRunId,
          ),
          stepEvent(
            'step.state_changed',
            currentPlan,
            currentStep,
            { state: 'running' },
            input.parentRunId,
          ),
          attemptEvent(
            'attempt.state_changed',
            currentPlan,
            currentStep,
            verificationRetryClaim,
            { state: 'running' },
            input.parentRunId,
          ),
        )
      }
      return events
    })
    if (verificationRetryClaim !== undefined && verificationRetryScheduled) {
      return this.runClaim(input, verificationRetryClaim, signal)
    }
    return outcome(claim.stepId, stepState, errorCode)
  }

  private async terminateAttempt(
    input: DagSupervisorInputV1,
    claim: Readonly<{ stepId: string; attemptId: string; childRunId: string }>,
    state: 'failed' | 'cancelled' | 'interrupted',
    errorCode: string,
    usage?: Readonly<BudgetUsage>,
  ): Promise<WorkerOutcome> {
    await this.appendWithRetry(input, `terminate-${claim.attemptId}`, (current) => {
      const plan = requirePlan(current, input.planId)
      const step = requireStep(plan, claim.stepId)
      const attempt = requireAttempt(step, claim.attemptId)
      if (!['reserved', 'running', 'execution_succeeded', 'verifying'].includes(attempt.state)) {
        return undefined
      }
      const attemptState = state === 'cancelled' ? 'cancelled' : 'interrupted'
      return [
        attemptEvent(
          'attempt.state_changed',
          plan,
          step,
          claim,
          { state: attemptState, errorCode },
          input.parentRunId,
        ),
        stepEvent('step.state_changed', plan, step, { state, errorCode }, input.parentRunId),
        ...(usage === undefined
          ? []
          : [
              {
                type: 'usage.recorded',
                correlation: correlation(plan, step, claim, input.parentRunId),
                data: { source: 'subagent', usage: parentSubagentUsage(usage) },
              },
            ]),
      ]
    })
    return outcome(claim.stepId, state, errorCode)
  }

  private async finalize(
    input: DagSupervisorInputV1,
    state: 'succeeded' | 'failed' | 'blocked' | 'cancelled',
    errorCode?: string,
  ): Promise<DagSupervisorResultV1> {
    await this.appendWithRetry(input, `terminal-${state}`, (current) => {
      const plan = requirePlan(current, input.planId)
      if (plan.state !== 'running') return undefined
      const pending = plan.steps.filter((step) => step.state === 'pending')
      if (plan.steps.some((step) => ['running', 'verifying'].includes(step.state))) {
        fail('DAG_SUPERVISOR_TERMINAL_WITH_ACTIVE_WORK')
      }
      const events: JournalEventDraft[] = pending.map((step) =>
        stepEvent(
          'step.state_changed',
          plan,
          step,
          { state: 'cancelled', errorCode: errorCode ?? 'DAG_PLAN_TERMINAL' },
          input.parentRunId,
        ),
      )
      events.push(planEvent('plan.state_changed', plan, { state }, input.parentRunId))
      if ((this.options.terminalOwner ?? 'supervisor') === 'supervisor') {
        events.push({
          type: 'run.terminal',
          data: {
            status:
              state === 'succeeded' ? 'completed' : state === 'cancelled' ? 'aborted' : 'failed',
            usage: {},
            ...(errorCode === undefined ? {} : { errorCode }),
          },
        })
      }
      return events
    })
    const projection = await this.options.journal.loadProjection(input.sessionId)
    return result(projection, requirePlan(projection, input.planId))
  }

  private async appendWithRetry(
    input: DagSupervisorInputV1,
    label: string,
    build: (projection: SessionProjectionV3) => readonly JournalEventDraft[] | undefined,
  ): Promise<void> {
    for (let retry = 0; retry < this.#maxCasRetries; retry += 1) {
      const projection = await this.options.journal.loadProjection(input.sessionId)
      const events = build(projection)
      if (events === undefined || events.length === 0) return
      const token = this.#createId(label)
      const revision = projection.snapshot.revision + 1
      const timestamp = maxInstant(this.#now(), projection.catalog.updatedAt)
      try {
        await this.options.journal.appendCommit(
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
                ...(event.correlation === undefined ? {} : { correlation: event.correlation }),
                data: event.data,
              }),
            ),
          }),
        )
        return
      } catch (error) {
        if (runtimeCode(error) !== 'SESSION_COMMIT_REVISION_CONFLICT') throw error
      }
    }
    fail('DAG_SUPERVISOR_CAS_RETRY_EXHAUSTED')
  }

  private async scheduleWithRetry(input: DagSupervisorInputV1) {
    for (let retry = 0; retry < this.#maxCasRetries; retry += 1) {
      try {
        return await this.options.scheduler.schedule(scheduleInput(input))
      } catch (error) {
        if (runtimeCode(error) !== 'SESSION_COMMIT_REVISION_CONFLICT') throw error
      }
    }
    fail('DAG_SUPERVISOR_CAS_RETRY_EXHAUSTED')
  }
}

function scheduleInput(input: DagSupervisorInputV1): DagScheduleInputV1 {
  return {
    sessionId: input.sessionId,
    parentRunId: input.parentRunId,
    planId: input.planId,
    parentBudget: input.parentBudget,
    failureMode: input.failureMode,
  }
}

function terminalWorkerOutcome(outcomes: readonly WorkerOutcome[]): WorkerOutcome | undefined {
  return (
    outcomes.find((candidate) => candidate.state === 'blocked') ??
    outcomes.find((candidate) => ['failed', 'interrupted'].includes(candidate.state)) ??
    outcomes.find((candidate) => candidate.state === 'cancelled')
  )
}

function terminalPlanState(outcome: WorkerOutcome): 'failed' | 'blocked' | 'cancelled' {
  if (outcome.state === 'blocked') return 'blocked'
  if (outcome.state === 'cancelled') return 'cancelled'
  return 'failed'
}

function outcome(stepId: string, state: WorkerOutcome['state'], errorCode?: string): WorkerOutcome {
  return Object.freeze({ stepId, state, ...(errorCode === undefined ? {} : { errorCode }) })
}

function result(
  projection: SessionProjectionV3,
  plan: SessionPlanGraphProjectionV3,
): DagSupervisorResultV1 {
  if (!['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(plan.state)) {
    fail('DAG_SUPERVISOR_PLAN_NOT_TERMINAL')
  }
  return Object.freeze({
    planId: plan.planId,
    state: plan.state as DagSupervisorResultV1['state'],
    revision: projection.snapshot.revision,
    stepStates: Object.freeze(
      plan.steps.map((step) =>
        Object.freeze({
          stepId: step.stepId,
          state: step.state,
          ...(step.errorCode === undefined ? {} : { errorCode: step.errorCode }),
        }),
      ),
    ),
  })
}

function planEvent(
  type: string,
  plan: SessionPlanGraphProjectionV3,
  data: Record<string, unknown>,
  parentRunId: string,
): JournalEventDraft {
  return {
    type,
    correlation: { parentRunId, planId: plan.planId },
    data: { planId: plan.planId, planRevision: plan.revision, ...data },
  }
}

function stepEvent(
  type: string,
  plan: SessionPlanGraphProjectionV3,
  step: SessionStepProjectionV3,
  data: Record<string, unknown>,
  parentRunId: string,
): JournalEventDraft {
  return {
    type,
    correlation: { parentRunId, planId: plan.planId, stepId: step.stepId },
    data: { ...authorityFor(plan, step), ...data },
  }
}

function attemptEvent(
  type: string,
  plan: SessionPlanGraphProjectionV3,
  step: SessionStepProjectionV3,
  claim: Readonly<{ attemptId: string; childRunId: string }>,
  data: Record<string, unknown>,
  parentRunId: string,
): JournalEventDraft {
  return {
    type,
    correlation: correlation(plan, step, claim, parentRunId),
    data: { ...authorityFor(plan, step), attemptId: claim.attemptId, ...data },
  }
}

function verificationEvent(
  plan: SessionPlanGraphProjectionV3,
  step: SessionStepProjectionV3,
  claim: Readonly<{ attemptId: string; childRunId: string }>,
  decision: VerificationDecisionV1,
  verificationId: string,
  parentRunId: string,
): JournalEventDraft {
  return attemptEvent(
    'verification.recorded',
    plan,
    step,
    claim,
    {
      verificationId,
      verifier: decision.verifier,
      status: decision.status,
      evidenceRefs: decision.evidenceRefs,
      code: decision.code,
      retryable: decision.retryable,
    },
    parentRunId,
  )
}

function verificationErrorCode(
  mechanical: VerificationDecisionV1,
  rule: VerificationDecisionV1,
  semantic: VerificationDecisionV1 | undefined,
): string {
  return [mechanical, rule, semantic].find(
    (decision) => decision !== undefined && decision.status !== 'passed',
  )!.code
}

function correlation(
  plan: SessionPlanGraphProjectionV3,
  step: SessionStepProjectionV3,
  claim: Readonly<{ attemptId: string; childRunId: string }>,
  parentRunId: string,
): Record<string, string> {
  return {
    parentRunId,
    childRunId: claim.childRunId,
    planId: plan.planId,
    stepId: step.stepId,
    attemptId: claim.attemptId,
  }
}

function authorityFor(
  plan: SessionPlanGraphProjectionV3,
  step: SessionStepProjectionV3,
): Record<string, unknown> {
  return { planId: plan.planId, planRevision: plan.revision, stepId: step.stepId }
}

async function verifySafely(
  verifier: SupervisorVerifierV1,
  input: Parameters<SupervisorVerifierV1['verify']>[0],
  kind: VerificationDecisionV1['verifier'],
): Promise<VerificationDecisionV1> {
  try {
    const decision = await verifier.verify(input)
    if (
      typeof decision !== 'object' ||
      decision === null ||
      Object.keys(decision).length !== 5 ||
      !['verifier', 'status', 'evidenceRefs', 'code', 'retryable'].every((key) =>
        Object.hasOwn(decision, key),
      ) ||
      decision.verifier !== kind ||
      !['passed', 'failed', 'blocked'].includes(decision.status) ||
      !safeId(decision.code) ||
      typeof decision.retryable !== 'boolean' ||
      !Array.isArray(decision.evidenceRefs) ||
      decision.evidenceRefs.length > 256 ||
      !decision.evidenceRefs.every(
        (reference) =>
          typeof reference === 'string' && Buffer.byteLength(reference, 'utf8') <= 8 * 1024,
      )
    ) {
      throw new Error('invalid verifier decision')
    }
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

function conservativeUsage(budget: Readonly<ExecutionBudget>): Readonly<BudgetUsage> {
  return Object.freeze({
    turns: budget.maxTurns,
    toolCalls: budget.maxToolCalls,
    ...(budget.maxTokens === undefined ? {} : { inputTokens: budget.maxTokens }),
    subagents: budget.maxChildRuns,
  })
}

function usageWithinStep(usage: Readonly<BudgetUsage>, budget: Readonly<ExecutionBudget>): boolean {
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  return (
    usage.turns <= budget.maxTurns &&
    usage.toolCalls <= budget.maxToolCalls &&
    usage.subagents === 0 &&
    (budget.maxTokens === undefined || tokens <= budget.maxTokens)
  )
}

function remainingAttemptBudget(
  parent: Readonly<ExecutionBudget>,
  recorded: Readonly<BudgetUsage>,
  current: Readonly<BudgetUsage>,
  ceiling: Readonly<ExecutionBudget>,
): Readonly<ExecutionBudget> {
  const usedTokens =
    (recorded.inputTokens ?? 0) +
    (recorded.outputTokens ?? 0) +
    (current.inputTokens ?? 0) +
    (current.outputTokens ?? 0)
  return Object.freeze({
    ...ceiling,
    maxTurns: Math.max(
      1,
      Math.min(ceiling.maxTurns, parent.maxTurns - recorded.turns - current.turns),
    ),
    maxToolCalls: Math.max(
      0,
      Math.min(ceiling.maxToolCalls, parent.maxToolCalls - recorded.toolCalls - current.toolCalls),
    ),
    ...(parent.maxTokens === undefined
      ? {}
      : {
          maxTokens: Math.max(
            1,
            Math.min(ceiling.maxTokens ?? parent.maxTokens, parent.maxTokens - usedTokens),
          ),
        }),
  })
}

function hasRemainingRunBudget(
  parent: Readonly<ExecutionBudget>,
  recorded: Readonly<BudgetUsage>,
  current: Readonly<BudgetUsage> = Object.freeze({ turns: 0, toolCalls: 0, subagents: 0 }),
): boolean {
  const tokens =
    (recorded.inputTokens ?? 0) +
    (recorded.outputTokens ?? 0) +
    (current.inputTokens ?? 0) +
    (current.outputTokens ?? 0)
  return (
    recorded.turns + current.turns < parent.maxTurns &&
    (parent.maxTokens === undefined || tokens < parent.maxTokens)
  )
}

function validateArtifact(input: ArtifactReference): ArtifactReference {
  if (
    !safeId(input.artifactId) ||
    typeof input.digest !== 'string' ||
    !SHA256.test(input.digest) ||
    typeof input.mimeType !== 'string' ||
    input.mimeType.length === 0 ||
    Buffer.byteLength(input.mimeType, 'utf8') > 256 ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 0
  ) {
    fail('DAG_ARTIFACT_INVALID')
  }
  return input
}

function budgetsFit(
  parent: Readonly<ExecutionBudget>,
  usage: Readonly<BudgetUsage>,
  reservations: readonly Readonly<ExecutionBudget>[],
): boolean {
  const reservedTurns = reservations.reduce((total, budget) => total + budget.maxTurns, 0)
  const reservedTools = reservations.reduce((total, budget) => total + budget.maxToolCalls, 0)
  const reservedTokens = reservations.reduce(
    (total, budget) => total + (budget.maxTokens ?? Number.POSITIVE_INFINITY),
    0,
  )
  return (
    usage.turns + reservedTurns <= parent.maxTurns &&
    usage.toolCalls + reservedTools <= parent.maxToolCalls &&
    (parent.maxTokens === undefined ||
      (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + reservedTokens <= parent.maxTokens)
  )
}

function parentSubagentUsage(usage: Readonly<BudgetUsage>): BudgetUsage {
  return { ...usage, subagents: usage.subagents + 1 }
}

function requirePlan(
  projection: SessionProjectionV3,
  planId: string,
): SessionPlanGraphProjectionV3 {
  if (projection.planGraph?.planId !== planId) fail('DAG_SUPERVISOR_PLAN_NOT_FOUND')
  return projection.planGraph
}

function requireStep(plan: SessionPlanGraphProjectionV3, stepId: string): SessionStepProjectionV3 {
  const step = plan.steps.find((candidate) => candidate.stepId === stepId)
  if (step === undefined) fail('DAG_SUPERVISOR_STEP_NOT_FOUND')
  return step
}

function requireAttempt(step: SessionStepProjectionV3, attemptId: string) {
  const attempt = step.attempts.find((candidate) => candidate.attemptId === attemptId)
  if (attempt === undefined) fail('DAG_SUPERVISOR_ATTEMPT_NOT_FOUND')
  return attempt
}

function requireRunningAttempt(
  step: SessionStepProjectionV3,
  attemptId: string,
  childRunId: string,
): void {
  const attempt = requireAttempt(step, attemptId)
  if (
    step.state !== 'running' ||
    attempt.state !== 'running' ||
    attempt.childRunId !== childRunId
  ) {
    fail('DAG_SUPERVISOR_ATTEMPT_NOT_RUNNING')
  }
}

function requireVerifyingAttempt(
  step: SessionStepProjectionV3,
  attemptId: string,
  childRunId: string,
): void {
  const attempt = requireAttempt(step, attemptId)
  if (
    step.state !== 'verifying' ||
    attempt.state !== 'verifying' ||
    attempt.childRunId !== childRunId
  ) {
    fail('DAG_SUPERVISOR_ATTEMPT_NOT_VERIFYING')
  }
}

function requireActiveRunOrTerminal(
  projection: SessionProjectionV3,
  runId: string,
  plan: SessionPlanGraphProjectionV3,
): void {
  if (['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(plan.state)) return
  if (!projection.snapshot.runs.some((run) => run.runId === runId && run.state === 'running')) {
    fail('DAG_SUPERVISOR_PARENT_RUN_NOT_ACTIVE')
  }
}

function validateInput(input: DagSupervisorInputV1): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    !safeId(input.sessionId) ||
    !safeId(input.parentRunId) ||
    !safeId(input.planId) ||
    !['fail_fast', 'collect_partial'].includes(input.failureMode) ||
    typeof input.parentBudget !== 'object' ||
    input.parentBudget === null ||
    (input.resumedClaims !== undefined && !Array.isArray(input.resumedClaims))
  ) {
    fail('DAG_SUPERVISOR_INPUT_INVALID')
  }
  for (const value of [
    input.parentBudget.maxTurns,
    input.parentBudget.maxToolCalls,
    input.parentBudget.maxChildRuns,
    input.parentBudget.maxParallelChildren,
    input.parentBudget.maxDepth,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) fail('DAG_SUPERVISOR_INPUT_INVALID')
  }
  if (
    input.parentBudget.maxParallelChildren > input.parentBudget.maxChildRuns ||
    (input.parentBudget.maxTokens !== undefined &&
      (!Number.isSafeInteger(input.parentBudget.maxTokens) || input.parentBudget.maxTokens < 0)) ||
    (input.parentBudget.deadlineAt !== undefined &&
      Number.isNaN(Date.parse(input.parentBudget.deadlineAt)))
  ) {
    fail('DAG_SUPERVISOR_INPUT_INVALID')
  }
}

function sameRequest(left: SubagentExecutionRequestV1, right: SubagentExecutionRequestV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function deadlineReached(deadlineAt: string | undefined, now: string): boolean {
  return deadlineAt !== undefined && now >= deadlineAt
}

function maxInstant(left: string, right: string): string {
  return left >= right ? left : right
}

function runtimeCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function fail(code: string): never {
  throw Object.assign(new Error(code), runtimeError(code, 'planner', code), { code })
}
