import {
  canonicalDigestV1,
  canonicalJsonV1,
  createSessionCommitV3,
  runtimeError,
  validateSessionEntryV3,
  validateWorkingPlanV1,
  type SessionEntryV3,
  type SessionProjectionV3,
  type WorkingPlanV1,
  type WorkingReviewV1,
  type PlanToolInvocationContextV1,
  type ProviderUsage,
  type ProviderMessage,
} from '@praxis/core-sdk'
import type { ReviewPlanJournalPortV1 } from '../review-plan/planControlPorts.js'
import type { ArtifactStore } from '../artifacts/artifactStore.js'
import type { ReviewCallStoreV1 } from '../review-plan/reviewCallStore.js'
import { ReviewBudgetServiceV1 } from '../review-plan/reviewBudgetService.js'
import {
  reviewOutputBudgetV1,
  type SemanticReviewerPortV1,
  type ReviewFailureDiagnosticV1,
} from '../review-plan/semanticReviewer.js'

type Saved = Extract<SessionEntryV3, { type: 'working_plan.saved' }>
type Mutation = 'create' | 'update' | 'progress' | 'abandon'

/** Working memory and advisory reviews share the durable Journal, not the execution ledger. */
export class WorkingPlanServiceV1 {
  private readonly operations = new Map<string, Saved>()
  private readonly tools = new Map<string, { sequence: number; message: unknown }>()
  private readonly requests = new Map<
    string,
    { sequence: number; name: string; input: unknown; ambiguous: boolean }
  >()
  private cursor = 0
  private latestRunId: string | undefined
  private omittedReceipts = 0
  private readonly tasks = new Map<string, unknown>()
  private readonly budget: ReviewBudgetServiceV1

  constructor(
    private readonly options: {
      sessionId: string
      journal: ReviewPlanJournalPortV1
      artifacts: Pick<ArtifactStore, 'put' | 'read'>
      reviewer: SemanticReviewerPortV1
      /** Frozen pre-advisory-v1 requests retain their original wire contract on recovery. */
      legacyReviewer?: SemanticReviewerPortV1
      reviewCalls?: ReviewCallStoreV1
      onProviderUsage?: (callId: string, usage: ProviderUsage) => void
    },
  ) {
    this.budget = new ReviewBudgetServiceV1(options.journal)
  }

  async mutate(
    action: Mutation,
    input: Record<string, unknown>,
    invocation: PlanToolInvocationContextV1,
  ) {
    await this.assertOptional(invocation)
    const digest = canonicalDigestV1({ action, input })
    await this.refresh()
    const replay = this.operations.get(invocation.invocationId)
    if (replay !== undefined) {
      if (replay.data.inputDigest !== digest)
        fail('PLAN_OPERATION_CONFLICT', 'The invocation was already used with different input.')
      return { projection: replay.data.plan, selfReported: true, replayed: true }
    }
    const result = (await this.append(
      'working_plan.saved',
      invocation,
      () => digest,
      (projection) => {
        const prior = projection.workingPlan
        if (action === 'create' && prior?.state === 'active')
          fail('PLAN_ALREADY_ACTIVE', 'Update or abandon the current working Plan.')
        if (action !== 'create' && prior === undefined)
          fail('PLAN_NOT_FOUND', 'Create a working Plan first.')
        if (
          input.expectedPlanRevision !== undefined &&
          input.expectedPlanRevision !== prior?.revision
        )
          fail(
            'PLAN_REVISION_CONFLICT',
            'Read the current Plan and retry the edit against its revision.',
          )
        let next: WorkingPlanV1
        if (action === 'create' || action === 'update') {
          next = validateWorkingPlanV1({
            schemaVersion: 1,
            planId: action === 'create' ? identity('wp', invocation.invocationId) : prior!.planId,
            revision: (prior?.revision ?? 0) + 1,
            objective: input.objective ?? prior?.objective,
            state: input.state ?? 'active',
            items:
              input.items === undefined
                ? prior?.items
                : (input.items as Record<string, unknown>[]).map((item) => ({
                    ...item,
                    status: item.status ?? 'pending',
                  })),
          })
        } else if (action === 'abandon') {
          next = { ...prior!, revision: prior!.revision + 1, state: 'abandoned' }
        } else {
          if (!prior!.items.some((item) => item.id === input.itemId))
            fail('PLAN_ITEM_NOT_FOUND', 'The working Plan item does not exist.')
          next = validateWorkingPlanV1({
            ...prior!,
            revision: prior!.revision + 1,
            state: 'active',
            items: prior!.items.map((item) =>
              item.id === input.itemId ? { ...item, status: input.status } : item,
            ),
          })
        }
        return { operationId: invocation.invocationId, inputDigest: digest, plan: next }
      },
    )) as Saved
    this.operations.set(invocation.invocationId, result)
    return { projection: result.data.plan, selfReported: true }
  }

  async review(
    input: Record<string, unknown>,
    invocation: PlanToolInvocationContextV1,
    signal: AbortSignal,
  ) {
    await this.assertOptional(invocation)
    if (this.options.reviewCalls === undefined)
      fail(
        'REVIEW_STORAGE_UNAVAILABLE',
        'This Host has no durable Reviewer call store. Working Plan and task execution remain available.',
      )
    const inputDigest = canonicalDigestV1(input)
    let projection = await this.options.journal.loadProjection(this.options.sessionId)
    let review = projection.workingReviews?.find((r) => r.operationId === invocation.invocationId)
    if (review !== undefined && review.inputDigest !== inputDigest)
      fail('PLAN_OPERATION_CONFLICT', 'This review invocation has different input.')
    if (review?.reportRef !== undefined) return this.options.artifacts.read(review.reportRef)
    if (review === undefined) {
      await this.refresh()
      projection = await this.options.journal.loadProjection(this.options.sessionId)
      const entries = [...this.tools.values()].sort((a, b) => a.sequence - b.sequence)
      // Freeze observations already recorded by Runtime, never read paths chosen by the model.
      // Keep recent full receipts within the input budget and disclose omissions.
      let remaining = 48 * 1024
      const evidence: {
        ref: string
        available: boolean
        contentPreview: string
        truncated: boolean
        contentDigest: string
      }[] = []
      for (const e of [...entries].reverse()) {
        if (remaining <= 0) break
        const content = canonicalJsonV1(e.message)
        const slice = Buffer.from(content, 'utf8').subarray(0, remaining).toString('utf8')
        remaining -= Buffer.byteLength(slice, 'utf8')
        evidence.unshift({
          ref: `receipt-${e.sequence}`,
          available: true,
          contentPreview: slice,
          truncated: slice !== content,
          contentDigest: canonicalDigestV1(e.message),
        })
      }
      const task = this.tasks.get(invocation.runId)
      const objective =
        typeof input.question === 'string' ? input.question : projection.workingPlan?.objective
      if (!objective)
        fail(
          'PLAN_REVIEW_QUESTION_REQUIRED',
          'Supply a review question when no working Plan exists.',
        )
      const criteria = ((input.criteria as string[] | undefined) ?? [objective]).map(
        (description, index) => ({
          id: `c${index + 1}`,
          description,
          required: true,
          kind: 'semantic',
        }),
      )
      const reviewRequestId = identity('wr', invocation.invocationId)
      const payload = {
        schemaVersion: 1,
        reviewRequestId,
        summary: objective,
        originalTaskContract: { text: task === undefined ? '' : canonicalJsonV1(task) },
        reviewContract: { version: 1, kind: 'advisory-v1' },
        scopeContext: {
          kind: 'advisory',
          instruction:
            'Review the supplied question and criteria within the original task requirements. The Agent question is not authoritative when it contradicts the original task. Do not require unrelated work or checklist completion. This report cannot accept or block execution. Paired Tool requests show attempted actions, observations show recorded outcomes, and both are historical snapshots rather than live workspace state.',
        },
        criteria,
        evidenceRefs: evidence.map((e) => e.ref),
        evidenceManifest: {
          entries: evidence,
          omittedReceipts: this.omittedReceipts + entries.length - evidence.length,
        },
        deterministicResults: [],
      }
      const artifact = await this.options.artifacts.put(payload)
      review = {
        reviewRequestId,
        operationId: invocation.invocationId,
        inputDigest,
        inputRef: artifact.artifactId,
        requestDigest: canonicalDigestV1(payload),
        planRevision: projection.workingPlan?.revision ?? null,
        snapshotSequence: projection.snapshot.sequence,
        evidenceSequence: entries.at(-1)?.sequence ?? 0,
      }
      const frozen = review
      const acceptedRequest = await this.append(
        'working_plan.review_requested',
        invocation,
        () => inputDigest,
        () => ({ review: frozen }),
      )
      review = (acceptedRequest.data as { review: WorkingReviewV1 }).review
    }
    const payload = (await this.options.artifacts.read(review.inputRef)) as Record<string, unknown>
    if (canonicalDigestV1(payload) !== review.requestDigest)
      fail('PLAN_REVIEW_SNAPSHOT_INVALID', 'The frozen review input does not match its digest.')
    const criteria = payload.criteria as { id: string }[]
    const evidenceRefs = payload.evidenceRefs as string[]
    const advisory =
      (payload.reviewContract as { kind?: string } | undefined)?.kind === 'advisory-v1'
    const reviewer =
      !advisory && this.options.legacyReviewer !== undefined
        ? this.options.legacyReviewer
        : this.options.reviewer
    const reservation = {
      inputTokens: Math.ceil(Buffer.byteLength(canonicalJsonV1(payload)) / 2) + 2048,
      outputTokens:
        reviewer.outputTokenLimit?.(criteria.length) ?? reviewOutputBudgetV1(criteria.length),
    }
    let report: Record<string, unknown> | undefined
    let failure: ReviewFailureDiagnosticV1 | undefined
    // Bounded transport/schema retries, not a limit on task replanning or repairs.
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (signal.aborted) throw signal.reason
      const attemptPayload =
        failure === undefined
          ? payload
          : {
              ...payload,
              priorResponseFailure: {
                code: failure.code,
                validationPath: failure.validationPath ?? '$',
                ...(failure.validationHint === undefined ? {} : { hint: failure.validationHint }),
                instruction:
                  'Correct the response format and keep evidence explanations concise. This is not a task failure.',
              },
            }
      await this.budget.reserve({
        sessionId: this.options.sessionId,
        reviewRequestId: review.reviewRequestId,
        attemptNumber: attempt,
        reservation,
      })
      const { attempt: saved } = await this.options.reviewCalls.reserve(
        review.reviewRequestId,
        attempt,
        canonicalDigestV1(attemptPayload),
      )
      if (saved.decision !== undefined) {
        await this.settle(review, attempt, saved.usage ?? {}, true, reservation)
        report = { ...saved.decision, attemptNumber: attempt }
        break
      }
      if (
        saved.failure !== undefined ||
        saved.state === 'provider_started' ||
        saved.state === 'provider_unknown'
      ) {
        failure = saved.failure
        await this.settle(
          review,
          attempt,
          saved.usage ?? {},
          saved.failure?.usageComplete === true,
          reservation,
        )
        continue
      }
      await this.options.reviewCalls.markProviderStarted(review.reviewRequestId, attempt)
      try {
        const response = await reviewer.review({
          reviewRequestId: review.reviewRequestId,
          neutralPayload: attemptPayload,
          criterionIds: criteria.map((c) => c.id),
          evidenceRefs,
          signal,
        })
        await this.options.reviewCalls.completeProvider(review.reviewRequestId, attempt, response)
        this.options.onProviderUsage?.(`${review.reviewRequestId}:${attempt}`, response.usage)
        await this.settle(review, attempt, response.usage, true, reservation)
        report = { ...response.decision, attemptNumber: attempt }
        break
      } catch (error) {
        // Persistence/settlement errors after a saved Provider response are not model failures.
        if (
          (await this.options.reviewCalls.get(review.reviewRequestId, attempt))?.state !==
          'provider_started'
        )
          throw error
        const e = error as {
          reviewFailure?: ReviewFailureDiagnosticV1
          reviewUsage?: ProviderUsage
        }
        failure = e.reviewFailure ?? {
          code: 'REVIEW_PROVIDER_FAILED',
          stage: 'provider',
          usageComplete: false,
        }
        await this.options.reviewCalls.recordFailure(
          review.reviewRequestId,
          attempt,
          failure,
          e.reviewUsage ?? {},
        )
        if (e.reviewUsage !== undefined)
          this.options.onProviderUsage?.(`${review.reviewRequestId}:${attempt}`, e.reviewUsage)
        await this.settle(review, attempt, e.reviewUsage ?? {}, failure.usageComplete, reservation)
        if (signal.aborted) throw error
      }
    }
    report ??= {
      verdict: 'unavailable',
      summary:
        'Advisory review could not produce a valid report. The task is not blocked by this service failure.',
      failureCode: failure?.code ?? 'REVIEW_PROVIDER_OUTCOME_UNKNOWN',
    }
    const result = {
      ...report,
      advisory: true,
      ...(advisory
        ? {
            reportContract: 'advisory-v1',
            findingsLabel: 'Snapshot observations, not acceptance decisions.',
          }
        : {}),
      reviewRequestId: review.reviewRequestId,
      planRevision: review.planRevision,
      snapshotSequence: review.snapshotSequence,
      evidenceSequence: review.evidenceSequence,
      validity:
        'Applies only to the frozen observations and scoped question; never certifies later workspace changes.',
    }
    const artifact = await this.options.artifacts.put(result)
    const completed: WorkingReviewV1 = {
      ...review,
      reportRef: artifact.artifactId,
      verdict: report.verdict as WorkingReviewV1['verdict'],
    }
    await this.append(
      'working_plan.reviewed',
      invocation,
      () => inputDigest,
      () => ({ review: completed }),
    )
    if (typeof report.attemptNumber === 'number')
      await this.options.reviewCalls.markDecisionCommitted(
        review.reviewRequestId,
        report.attemptNumber,
      )
    return result
  }

  private async settle(
    review: WorkingReviewV1,
    attemptNumber: number,
    usage: ProviderUsage,
    complete: boolean,
    reservation: ProviderUsage,
  ) {
    const measured = complete && Object.keys(usage).length > 0
    await this.budget.settle({
      sessionId: this.options.sessionId,
      reviewRequestId: review.reviewRequestId,
      attemptNumber,
      disposition: measured ? 'actual' : 'remote_outcome_unknown',
      usage: measured ? usage : reservation,
    })
  }

  private async assertOptional(invocation: PlanToolInvocationContextV1) {
    if (invocation.sessionId !== this.options.sessionId)
      fail('PLAN_SESSION_MISMATCH', 'Working Plan belongs to another Session.')
    const projection = await this.options.journal.loadProjection(this.options.sessionId)
    const run = projection.snapshot.runs.find((r) => r.runId === invocation.runId)
    if (run === undefined || run.planPolicy === 'required')
      fail(
        'PLAN_POLICY_MISMATCH',
        'This Run must use its Host-selected strict ReviewPlan contract.',
      )
  }

  private async refresh() {
    let through: number | undefined
    while (true) {
      const page = await this.options.journal.readEntries({
        sessionId: this.options.sessionId,
        afterSequence: this.cursor,
        limit: 512,
        ...(through === undefined ? {} : { throughSequence: through }),
      })
      through ??= page.head.sequence
      for (const entry of page.entries) {
        if (entry.type === 'run.started') this.latestRunId = entry.runId
        if (
          entry.type === 'message.committed' &&
          entry.data.message.role === 'user' &&
          (entry.runId ?? this.latestRunId) !== undefined &&
          !this.tasks.has((entry.runId ?? this.latestRunId)!)
        )
          this.tasks.set((entry.runId ?? this.latestRunId)!, entry.data.message)
        if (entry.type === 'working_plan.saved') this.operations.set(entry.data.operationId, entry)
        if (entry.type === 'message.committed' && entry.data.message.role === 'assistant') {
          const message = entry.data.message
          const calls = Array.isArray(message.content)
            ? message.content.filter((b) => b.type === 'tool_call')
            : []
          // Legacy toolCalls may mirror content blocks; do not count that representation twice.
          const all = [
            ...calls,
            ...(message.toolCalls ?? []).filter((c) => !calls.some((b) => b.id === c.id)),
          ]
          for (const call of all) {
            const key = `${entry.runId ?? this.latestRunId ?? ''}:${call.id}`
            this.requests.set(key, {
              sequence: entry.sequence,
              name: call.name,
              input: call.input,
              ambiguous: this.requests.has(key),
            })
          }
          while (this.requests.size > 512) this.requests.delete(this.requests.keys().next().value!)
        }
        if (
          entry.type === 'message.committed' &&
          entry.data.message.role === 'tool' &&
          !entry.data.message.name.startsWith('plan.')
        ) {
          const message = entry.data.message as Extract<ProviderMessage, { role: 'tool' }>
          const key = `${entry.runId ?? this.latestRunId ?? ''}:${message.toolCallId}`
          const request = this.requests.get(key)
          const matched =
            request !== undefined && !request.ambiguous && request.name === message.name
          this.tools.set(entry.entryId, {
            sequence: entry.sequence,
            message: {
              runId: entry.runId ?? this.latestRunId ?? null,
              sequence: entry.sequence,
              observation: entry.data.message,
              requestAvailable: matched,
              ...(matched
                ? {
                    request: {
                      sequence: request.sequence,
                      name: request.name,
                      input: request.input,
                      toolCallId: message.toolCallId,
                    },
                  }
                : {}),
            },
          })
          this.requests.delete(key)
        }
        if (this.tools.size > 128) {
          this.tools.delete(this.tools.keys().next().value!)
          this.omittedReceipts++
        }
      }
      this.cursor = page.nextAfterSequence
      if (!page.hasMore) return
    }
  }

  private async append(
    type: 'working_plan.saved' | 'working_plan.review_requested' | 'working_plan.reviewed',
    invocation: PlanToolInvocationContextV1,
    digest: () => string,
    build: (p: SessionProjectionV3) => Record<string, unknown>,
  ): Promise<SessionEntryV3> {
    for (let retry = 0; retry < 8; retry++) {
      const projection = await this.options.journal.loadProjection(this.options.sessionId)
      // A concurrent commit or resumed operation may already have completed this exact mutation.
      await this.refresh()
      if (type === 'working_plan.saved') {
        const prior = this.operations.get(invocation.invocationId)
        if (prior !== undefined) {
          if (prior.data.inputDigest !== digest())
            fail('PLAN_OPERATION_CONFLICT', 'Conflicting replay.')
          return prior
        }
      } else {
        const prior = projection.workingReviews?.find(
          (r) => r.operationId === invocation.invocationId,
        )
        if (prior !== undefined && prior.inputDigest !== digest())
          fail('PLAN_OPERATION_CONFLICT', 'Conflicting review replay.')
        if (
          prior !== undefined &&
          (type === 'working_plan.review_requested' || prior.reportRef !== undefined)
        ) {
          return validateSessionEntryV3({
            schemaVersion: 3,
            entryId: identity('wpe', `${invocation.invocationId}:${type}`),
            sessionId: this.options.sessionId,
            sequence: projection.snapshot.sequence,
            revision: projection.snapshot.revision,
            timestamp: projection.snapshot.updatedAt,
            type,
            runId: invocation.runId,
            data: { review: type === 'working_plan.review_requested' ? stripReport(prior) : prior },
          })
        }
      }
      const entry = validateSessionEntryV3({
        schemaVersion: 3,
        entryId: identity('wpe', `${invocation.invocationId}:${type}`),
        sessionId: this.options.sessionId,
        sequence: projection.snapshot.sequence + 1,
        revision: projection.snapshot.revision + 1,
        timestamp: new Date(
          Math.max(
            Date.now(),
            Date.parse(
              projection.snapshot.updatedAt ??
                projection.snapshot.createdAt ??
                '1970-01-01T00:00:00.000Z',
            ),
          ),
        ).toISOString(),
        type,
        runId: invocation.runId,
        data: build(projection),
      })
      try {
        const key = identity('wpc', `${invocation.invocationId}:${type}`)
        await this.options.journal.appendCommit(
          createSessionCommitV3({
            sessionId: this.options.sessionId,
            commitId: key,
            idempotencyKey: key,
            expectedRevision: projection.snapshot.revision,
            entries: [entry],
          }),
        )
        return entry
      } catch (error) {
        if (
          !['SESSION_COMMIT_REVISION_CONFLICT', 'SESSION_COMMIT_IDEMPOTENCY_CONFLICT'].includes(
            (error as { code?: string }).code ?? '',
          ) ||
          retry === 7
        )
          throw error
      }
    }
    throw new Error('Unreachable working Plan commit retry.')
  }
}

function identity(prefix: string, value: string): string {
  return `${prefix}_${canonicalDigestV1(value).slice(7)}`
}
function stripReport(r: WorkingReviewV1): WorkingReviewV1 {
  const { reportRef: _report, verdict: _verdict, ...rest } = r
  return rest
}
function fail(code: string, message: string): never {
  throw runtimeError(code, 'planner', message)
}
