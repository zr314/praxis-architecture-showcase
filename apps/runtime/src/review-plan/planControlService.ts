import {
  canonicalDigestV1,
  canonicalJsonV1,
  createSessionCommitV3,
  DEFAULT_REVIEW_POLICY_V1,
  type ReviewPlanEventTypeV1,
  type ReviewPlanMutationOriginV1,
  type ReviewPlanProjectionV1,
  reviewPlanHashV1,
  runtimeError,
  validatePlanCreateInputV1,
  validateSessionEntryV3,
} from '@praxis/core-sdk'
import type {
  ApplyReviewDecisionRequestV1,
  PlanAbandonRequestV1,
  PlanControlServicePortV1,
  PlanCreateRequestV1,
  PlanDefinitionMaterializerV1,
  PlanHostMutationReceiptV1,
  PlanMutationReceiptV1,
  PlanProgressRequestV1,
  PlanReviewPrepareRequestV1,
  PlanRuntimeMutationReceiptV1,
  PlanToolMutationReceiptV1,
  PlanUpdateRequestV1,
  PreparedReviewReceiptV1,
  RequestSemanticReviewEventV1,
  ResolveReviewPlanBlockRequestV1,
  ReviewPlanExecutionBindingEventV1,
  ReviewPlanExecutionRequestEventV1,
  ReviewPlanJournalPortV1,
  ReviewPlanRootToolRequestV1,
  ReviewPlanRootToolResultV1,
} from './planControlPorts.js'
import { CanonicalPlanDefinitionMaterializerV1 } from './planDefinitionMaterializer.js'

const MAX_CAS_RETRIES = 4

type EventDraft = Readonly<{
  type: ReviewPlanEventTypeV1 | 'control.consumed'
  data: Readonly<Record<string, unknown>>
  runId?: string
}>

export class PlanControlServiceV1 implements PlanControlServicePortV1 {
  readonly #materializer: PlanDefinitionMaterializerV1

  constructor(
    private readonly journal: ReviewPlanJournalPortV1,
    options: Readonly<{ materializer?: PlanDefinitionMaterializerV1; now?: () => string }> = {},
  ) {
    this.#materializer = options.materializer ?? new CanonicalPlanDefinitionMaterializerV1()
    this.now = options.now ?? (() => new Date().toISOString())
  }

  private readonly now: () => string

  async create(input: PlanCreateRequestV1): Promise<PlanToolMutationReceiptV1> {
    assertInvocation(input.sessionId, input.invocation)
    const definition = validatePlanCreateInputV1(input.input)
    const payload = { operation: 'create', input: definition }
    const origin = toolOrigin(input.invocation.invocationId, payload)
    const replay = await this.#findReplay(input.sessionId, origin, canonicalDigestV1(payload))
    if (replay !== undefined) return replay as PlanToolMutationReceiptV1
    const taskContract = taskContractFor(
      await this.journal.loadProjection(input.sessionId),
      input.invocation.runId,
    )
    const materialized = await this.#materializer.materialize({
      sessionId: input.sessionId,
      objective: definition.objective,
      criteria: definition.acceptanceCriteria,
      items: definition.items,
      ...(definition.reviewPolicy === undefined ? {} : { reviewPolicy: definition.reviewPolicy }),
    })
    const planId = stableId('rp', {
      sessionId: input.sessionId,
      invocationId: input.invocation.invocationId,
    })
    const planHash = reviewPlanHashV1({
      objective: materialized.input.objective,
      acceptanceCriteria: materialized.input.acceptanceCriteria,
      items: materialized.input.items,
      reviewPolicy: materialized.input.reviewPolicy ?? DEFAULT_REVIEW_POLICY_V1,
    })
    return (await this.#commit(input.sessionId, origin, payload, (projection) => {
      if (projection.reviewPlan !== undefined && !isTerminal(projection.reviewPlan.state)) {
        throw planFailure('PLAN_ALREADY_ACTIVE')
      }
      return [
        reviewDraft(
          'review_plan.created',
          origin,
          canonicalDigestV1(payload),
          planId,
          1,
          {
            input: materialized.input,
            planHash,
            taskContract,
          },
          input.invocation.runId,
        ),
      ]
    })) as PlanToolMutationReceiptV1
  }

  async update(input: PlanUpdateRequestV1): Promise<PlanToolMutationReceiptV1> {
    assertInvocation(input.sessionId, input.invocation)
    const definition = validatePlanCreateInputV1(input.input)
    const payload = {
      operation: 'update',
      input: definition,
      carryForwardAttemptIds: [...(input.carryForwardAttemptIds ?? [])],
    }
    const origin = toolOrigin(input.invocation.invocationId, payload)
    const materialized = await this.#materializer.materialize({
      sessionId: input.sessionId,
      objective: definition.objective,
      criteria: definition.acceptanceCriteria,
      items: definition.items,
      ...(definition.reviewPolicy === undefined ? {} : { reviewPolicy: definition.reviewPolicy }),
    })
    return (await this.#commit(input.sessionId, origin, payload, (projection) => {
      const plan = requirePlan(projection.reviewPlan, input.expectedPlanRevision)
      assertMutable(plan)
      if (hasFence(plan)) throw planFailure('PLAN_UPDATE_INFLIGHT_CONFLICT')
      const openAttempts = plan.items.flatMap((item) =>
        item.currentAttempt !== undefined &&
        ['open', 'review_requested'].includes(item.currentAttempt.state)
          ? [item.currentAttempt.itemAttemptId]
          : [],
      )
      if (openAttempts.length > 0) throw planFailure('PLAN_UPDATE_INFLIGHT_CONFLICT')
      const nextPolicy = materialized.input.reviewPolicy ?? plan.policy
      const currentHash = definitionHash(plan)
      const nextHash = reviewPlanHashV1({
        objective: materialized.input.objective,
        acceptanceCriteria: materialized.input.acceptanceCriteria,
        items: materialized.input.items,
        reviewPolicy: nextPolicy,
      })
      if (currentHash === nextHash) {
        return [
          reviewDraft(
            'review_plan.no_progress_recorded',
            origin,
            canonicalDigestV1(payload),
            plan.planId,
            plan.revision,
            { noProgressCount: plan.noProgressCount + 1 },
            input.invocation.runId,
          ),
        ]
      }
      if (plan.replanCount >= plan.policy.maxReplans)
        throw planFailure('PLAN_REPLAN_BUDGET_EXHAUSTED')
      return [
        reviewDraft(
          'review_plan.revised',
          origin,
          canonicalDigestV1(payload),
          plan.planId,
          plan.revision + 1,
          {
            fromPlanRevision: plan.revision,
            input: materialized.input,
            planHash: nextHash,
          },
          input.invocation.runId,
        ),
      ]
    })) as PlanToolMutationReceiptV1
  }

  async progress(input: PlanProgressRequestV1): Promise<PlanToolMutationReceiptV1> {
    assertInvocation(input.sessionId, input.invocation)
    const payload = {
      operation: 'progress',
      action: input.action,
    }
    const origin = toolOrigin(input.invocation.invocationId, payload)
    return (await this.#commit(input.sessionId, origin, payload, (projection) => {
      const plan = requirePlan(projection.reviewPlan, input.expectedPlanRevision)
      assertMutable(plan)
      if (plan.finalPreparedReview !== undefined) throw planFailure('PLAN_REVIEW_FENCE_ACTIVE')
      const item = requireItem(plan, input.action.itemId)
      if (item.preparedReview !== undefined) throw planFailure('PLAN_REVIEW_FENCE_ACTIVE')
      const digest = canonicalDigestV1(payload)
      if (input.action.kind === 'start') {
        if (item.attemptCount >= plan.policy.maxRepairAttemptsPerItem + 1) {
          throw planFailure('PLAN_REPAIR_BUDGET_EXHAUSTED')
        }
        const itemAttemptId = stableId('rpa', {
          planId: plan.planId,
          itemId: item.id,
          invocationId: input.invocation.invocationId,
        })
        return [
          reviewDraft(
            'review_plan.item_attempt_started',
            origin,
            digest,
            plan.planId,
            plan.revision,
            { itemId: item.id, itemAttemptId, attemptNumber: item.attemptCount + 1 },
            input.invocation.runId,
          ),
        ]
      }
      if (input.action.kind === 'focus') {
        return [
          reviewDraft(
            'review_plan.item_attempt_focused',
            origin,
            digest,
            plan.planId,
            plan.revision,
            { itemId: item.id, itemAttemptId: input.action.itemAttemptId },
            input.invocation.runId,
          ),
        ]
      }
      if (input.action.kind === 'request_skip') {
        if (item.criterionIds.some((criterionId) => requiredOnlyHere(plan, item.id, criterionId))) {
          throw planFailure('PLAN_REQUIRED_CRITERION_UNCOVERED')
        }
        return [
          reviewDraft(
            'review_plan.item_state_changed',
            origin,
            digest,
            plan.planId,
            plan.revision,
            { itemId: item.id, state: 'skipped' },
            input.invocation.runId,
          ),
        ]
      }
      const drafts: EventDraft[] = []
      const blockedAttemptId = input.action.itemAttemptId ?? item.currentAttempt?.itemAttemptId
      if (blockedAttemptId !== undefined) {
        drafts.push(
          reviewDraft(
            'review_plan.item_attempt_closed',
            origin,
            digest,
            plan.planId,
            plan.revision,
            {
              itemId: item.id,
              itemAttemptId: blockedAttemptId,
              attemptState: 'blocked',
            },
            input.invocation.runId,
          ),
        )
      }
      const block = {
        blockId: stableId('rpb', {
          planId: plan.planId,
          itemId: item.id,
          invocationId: input.invocation.invocationId,
        }) as `rpb_${string}`,
        code: input.action.code ?? 'MODEL_REPORTED_BLOCK',
        allowedResolver: 'plan_revision' as const,
        detailDigest: canonicalDigestV1({ reason: input.action.reason }),
        createdAt: this.now(),
      }
      drafts.push(
        reviewDraft(
          'review_plan.item_state_changed',
          origin,
          digest,
          plan.planId,
          plan.revision,
          { itemId: item.id, state: 'blocked', block },
          input.invocation.runId,
        ),
      )
      return drafts
    })) as PlanToolMutationReceiptV1
  }

  async prepareReview(input: PlanReviewPrepareRequestV1): Promise<PreparedReviewReceiptV1> {
    const payload = {
      operation: 'prepare_review',
      expectedPlanRevision: input.expectedPlanRevision,
      preparedReview: input.preparedReview,
    }
    assertOriginDigest(input.origin, payload)
    const receipt = await this.#commit(input.sessionId, input.origin, payload, (projection) => {
      const plan = requirePlan(projection.reviewPlan, input.expectedPlanRevision)
      assertMutable(plan)
      if (hasFence(plan)) throw planFailure('PLAN_REVIEW_FENCE_ACTIVE')
      if (input.preparedReview.planRevision !== plan.revision)
        throw planFailure('PLAN_REVISION_CONFLICT')
      if (input.preparedReview.scope.kind === 'item') {
        const item = requireItem(plan, input.preparedReview.scope.itemId)
        if (item.currentAttempt?.itemAttemptId !== input.preparedReview.itemAttemptId) {
          throw planFailure('PLAN_ATTEMPT_NOT_FOCUSED')
        }
      } else if (plan.items.some((item) => item.state !== 'accepted')) {
        throw planFailure('PLAN_FINAL_REVIEW_NOT_READY')
      }
      return [
        reviewDraft(
          'review_plan.review_prepared',
          input.origin,
          canonicalDigestV1(payload),
          plan.planId,
          plan.revision,
          { preparedReview: input.preparedReview },
        ),
      ]
    })
    return Object.freeze({
      ...receipt,
      preparedReview: input.preparedReview,
    }) as PreparedReviewReceiptV1
  }

  async abandon(input: PlanAbandonRequestV1): Promise<PlanToolMutationReceiptV1> {
    assertInvocation(input.sessionId, input.invocation)
    const payload = {
      operation: 'abandon',
      explanation: input.explanation,
      controlEventId: input.controlFact.controlEventId,
    }
    const origin = toolOrigin(input.invocation.invocationId, payload)
    return (await this.#commit(input.sessionId, origin, payload, (projection) => {
      const plan = requirePlan(projection.reviewPlan, input.expectedPlanRevision)
      const run = projection.snapshot.runs.find(
        (candidate) => candidate.runId === input.invocation.runId,
      )
      if (run?.planPolicy === 'required') throw planFailure('PLAN_ABANDON_REQUIRED_POLICY')
      assertControl(projection, input.controlFact, 'abandon', plan.planId)
      return [
        consumedDraft(input.controlFact),
        reviewDraft(
          'review_plan.state_changed',
          origin,
          canonicalDigestV1(payload),
          plan.planId,
          plan.revision,
          { state: 'abandoned' },
          input.invocation.runId,
        ),
      ]
    })) as PlanToolMutationReceiptV1
  }

  async requestExecution(
    input: ReviewPlanExecutionRequestEventV1,
  ): Promise<PlanRuntimeMutationReceiptV1> {
    const executionRequestId = stableId('rpe', {
      planId: input.planId,
      itemAttemptId: input.itemAttemptId,
      requestId: input.origin.requestId,
      purpose: 'execution',
    })
    const requestPayload = withoutOrigin(input)
    assertOriginDigest(input.origin, requestPayload)
    const payload = { ...requestPayload, executionRequestId }
    return (await this.#commit(input.sessionId, input.origin, payload, (projection) => {
      const plan = requirePlan(projection.reviewPlan, input.expectedPlanRevision, input.planId)
      assertAttempt(plan, input.itemId, input.itemAttemptId)
      return [
        reviewDraft(
          'review_plan.execution_requested',
          input.origin,
          canonicalDigestV1(payload),
          plan.planId,
          plan.revision,
          {
            itemId: input.itemId,
            itemAttemptId: input.itemAttemptId,
            executionRequestId,
            executionInputDigest: input.executionInputDigest,
          },
        ),
      ]
    })) as PlanRuntimeMutationReceiptV1
  }

  async bindExecution(
    input: ReviewPlanExecutionBindingEventV1,
  ): Promise<PlanRuntimeMutationReceiptV1> {
    const payload = withoutOrigin(input)
    assertOriginDigest(input.origin, payload)
    return (await this.#commit(input.sessionId, input.origin, payload, (projection) => {
      const plan = requirePlan(projection.reviewPlan, input.expectedPlanRevision, input.planId)
      assertAttempt(plan, input.itemId, input.itemAttemptId)
      if (
        input.binding.sessionId !== input.sessionId ||
        input.binding.planId !== input.planId ||
        input.binding.planRevision !== plan.revision ||
        input.binding.itemId !== input.itemId ||
        input.binding.itemAttemptId !== input.itemAttemptId ||
        input.binding.requestId !== input.executionRequestId
      ) {
        throw planFailure('PLAN_EXECUTION_BINDING_INVALID')
      }
      return [
        reviewDraft(
          'review_plan.execution_bound',
          input.origin,
          canonicalDigestV1(payload),
          plan.planId,
          plan.revision,
          {
            itemId: input.itemId,
            itemAttemptId: input.itemAttemptId,
            executionRequestId: input.executionRequestId,
            taskRef: input.taskRef,
          },
        ),
      ]
    })) as PlanRuntimeMutationReceiptV1
  }

  async recordRootToolRequest(
    input: ReviewPlanRootToolRequestV1,
  ): Promise<PlanRuntimeMutationReceiptV1> {
    const payload = withoutOrigin(input)
    assertOriginDigest(input.origin, payload)
    return (await this.#commit(input.sessionId, input.origin, payload, (projection) => {
      const plan = requirePlan(projection.reviewPlan, input.expectedPlanRevision, input.planId)
      assertAttempt(plan, input.itemId, input.itemAttemptId)
      return [
        reviewDraft(
          'review_plan.root_tool_requested',
          input.origin,
          canonicalDigestV1(payload),
          plan.planId,
          plan.revision,
          {
            itemId: input.itemId,
            itemAttemptId: input.itemAttemptId,
            requestId: input.requestId,
            invocationId: input.invocation.invocationId,
            toolName: input.toolName,
            inputDigest: input.inputDigest,
          },
        ),
      ]
    })) as PlanRuntimeMutationReceiptV1
  }

  async recordRootToolResult(
    input: ReviewPlanRootToolResultV1,
  ): Promise<PlanRuntimeMutationReceiptV1> {
    const payload = withoutOrigin(input)
    assertOriginDigest(input.origin, payload)
    return (await this.#commit(input.sessionId, input.origin, payload, (projection) => {
      const plan = requirePlan(projection.reviewPlan, input.expectedPlanRevision, input.planId)
      assertAttempt(plan, input.itemId, input.itemAttemptId)
      return [
        reviewDraft(
          'review_plan.root_tool_recorded',
          input.origin,
          canonicalDigestV1(payload),
          plan.planId,
          plan.revision,
          {
            itemId: input.itemId,
            itemAttemptId: input.itemAttemptId,
            requestId: input.requestId,
            ...(input.resultRef === undefined ? {} : { resultRef: input.resultRef }),
            ...(input.effectReceiptRef === undefined
              ? {}
              : { effectReceiptRef: input.effectReceiptRef }),
            ...(input.changedFilesDigest === undefined
              ? {}
              : { changedFilesDigest: input.changedFilesDigest }),
          },
        ),
      ]
    })) as PlanRuntimeMutationReceiptV1
  }

  async requestSemanticReview(
    input: RequestSemanticReviewEventV1,
  ): Promise<PlanRuntimeMutationReceiptV1> {
    const reviewRequestId = stableId('rpr', {
      preparedReviewId: input.preparedReviewId,
      deterministicDigest: input.deterministicDigest,
      requestId: input.origin.requestId,
    })
    const requestPayload = withoutOrigin(input)
    assertOriginDigest(input.origin, requestPayload)
    const payload = { ...requestPayload, reviewRequestId }
    return (await this.#commit(input.sessionId, input.origin, payload, (projection) => {
      const plan = requirePlan(projection.reviewPlan, input.expectedPlanRevision, input.planId)
      if (!preparedExists(plan, input.preparedReviewId))
        throw planFailure('PLAN_REVIEW_NOT_PREPARED')
      return [
        reviewDraft(
          'review_plan.review_requested',
          input.origin,
          canonicalDigestV1(payload),
          plan.planId,
          plan.revision,
          {
            preparedReviewId: input.preparedReviewId,
            reviewRequestId,
            deterministicDigest: input.deterministicDigest,
            deterministicAttemptCount: input.deterministicAttemptCount,
            providerAttemptCount: input.providerAttemptCount,
          },
        ),
      ]
    })) as PlanRuntimeMutationReceiptV1
  }

  async applyReviewDecision(
    input: ApplyReviewDecisionRequestV1,
  ): Promise<PlanRuntimeMutationReceiptV1> {
    const payload = withoutOrigin(input)
    assertOriginDigest(input.origin, payload)
    return (await this.#commit(input.sessionId, input.origin, payload, (projection) => {
      const plan = requirePlan(projection.reviewPlan, input.expectedPlanRevision, input.planId)
      if (!preparedExists(plan, input.preparedReviewId))
        throw planFailure('PLAN_REVIEW_NOT_PREPARED')
      return [
        reviewDraft(
          'review_plan.review_recorded',
          input.origin,
          canonicalDigestV1(payload),
          plan.planId,
          plan.revision,
          {
            preparedReviewId: input.preparedReviewId,
            reviewRequestId: input.decision.reviewRequestId,
            decision: input.decision,
          },
        ),
      ]
    })) as PlanRuntimeMutationReceiptV1
  }

  async resolveTrustedBlock(
    input: ResolveReviewPlanBlockRequestV1,
  ): Promise<PlanHostMutationReceiptV1> {
    const payload = {
      operation: 'resolve_block',
      planId: input.planId,
      expectedPlanRevision: input.expectedPlanRevision,
      blockId: input.blockId,
      controlEventId: input.controlFact.controlEventId,
    }
    assertOriginDigest(input.origin, payload)
    return (await this.#commit(input.sessionId, input.origin, payload, (projection) => {
      const plan = requirePlan(projection.reviewPlan, input.expectedPlanRevision, input.planId)
      assertControl(projection, input.controlFact, 'resolve_block', plan.planId)
      const block =
        plan.block?.blockId === input.blockId
          ? plan.block
          : plan.items.find((item) => item.block?.blockId === input.blockId)?.block
      if (block === undefined || !['trusted_host', 'user_input'].includes(block.allowedResolver)) {
        throw planFailure('PLAN_BLOCK_RESOLUTION_INVALID')
      }
      return [
        consumedDraft(input.controlFact),
        reviewDraft(
          'review_plan.block_resolved',
          input.origin,
          canonicalDigestV1(payload),
          plan.planId,
          plan.revision,
          { blockId: input.blockId },
        ),
      ]
    })) as PlanHostMutationReceiptV1
  }

  async #commit(
    sessionId: string,
    origin: ReviewPlanMutationOriginV1,
    payload: unknown,
    build: (
      projection: Awaited<ReturnType<ReviewPlanJournalPortV1['loadProjection']>>,
    ) => EventDraft[],
  ): Promise<PlanMutationReceiptV1> {
    const mutationDigest = canonicalDigestV1(payload)
    const replay = await this.#findReplay(sessionId, origin, mutationDigest)
    if (replay !== undefined) return replay
    const initialProjection = await this.journal.loadProjection(sessionId)
    const timestamp = monotonicTimestamp(initialProjection.snapshot.updatedAt, this.now())
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      const projection = await this.journal.loadProjection(sessionId)
      const drafts = build(projection)
      if (drafts.length === 0) throw planFailure('PLAN_MUTATION_EMPTY')
      const revision = projection.snapshot.revision + 1
      const firstSequence = projection.snapshot.sequence + 1
      const causalKey = originKey(origin)
      const entries = drafts.map((draft, index) =>
        validateSessionEntryV3({
          schemaVersion: 3,
          entryId: stableId('rpevent', { sessionId, kind: origin.kind, causalKey, index }),
          sessionId,
          sequence: firstSequence + index,
          revision,
          timestamp,
          type: draft.type,
          ...(draft.runId === undefined ? {} : { runId: draft.runId }),
          data: draft.data,
        }),
      )
      const commit = createSessionCommitV3({
        sessionId,
        commitId: stableId('rpcommit', { sessionId, kind: origin.kind, causalKey }),
        expectedRevision: projection.snapshot.revision,
        idempotencyKey: stableId('rpidem', { sessionId, kind: origin.kind, causalKey }),
        entries,
      })
      try {
        await this.journal.appendCommit(commit)
        const accepted = await this.#findReplay(sessionId, origin, mutationDigest)
        if (accepted === undefined) throw planFailure('PLAN_MUTATION_REPLAY_MISSING')
        return accepted
      } catch (error) {
        const accepted = await this.#findReplay(sessionId, origin, mutationDigest)
        if (accepted !== undefined) return accepted
        if (!hasCode(error, 'SESSION_COMMIT_REVISION_CONFLICT') || attempt + 1 >= MAX_CAS_RETRIES) {
          throw error
        }
      }
    }
    throw planFailure('PLAN_JOURNAL_CAS_EXHAUSTED')
  }

  async #findReplay(
    sessionId: string,
    origin: ReviewPlanMutationOriginV1,
    mutationDigest: `sha256:${string}`,
  ): Promise<PlanMutationReceiptV1 | undefined> {
    try {
      const result = await this.journal.querySession({
        sessionId,
        kind: 'review_plan_mutation',
        origin: queryOrigin(origin),
      })
      if (result.kind !== 'review_plan_mutation') throw planFailure('PLAN_MUTATION_REPLAY_INVALID')
      if (result.value.mutationDigest !== mutationDigest) throw originConflict(origin)
      return Object.freeze({
        origin: result.value.origin,
        planId: result.value.projection.planId,
        planRevision: result.value.projection.revision,
        journalRevision: result.value.events[0]!.revision,
        eventIds: result.value.events.map((entry) => entry.entryId),
        projection: result.value.projection,
      }) as PlanMutationReceiptV1
    } catch (error) {
      if (hasCode(error, 'SESSION_QUERY_NOT_FOUND')) return undefined
      if (hasCode(error, 'SESSION_QUERY_CONFLICT')) throw originConflict(origin)
      throw error
    }
  }
}

function reviewDraft(
  type: ReviewPlanEventTypeV1,
  origin: ReviewPlanMutationOriginV1,
  mutationDigest: `sha256:${string}`,
  planId: string,
  planRevision: number,
  data: Readonly<Record<string, unknown>>,
  runId?: string,
): EventDraft {
  return {
    type,
    data: { origin, mutationDigest, planId, planRevision, ...data },
    ...(runId === undefined ? {} : { runId }),
  }
}

function consumedDraft(fact: VerifiedControlFact): EventDraft {
  return {
    type: 'control.consumed',
    data: {
      controlEventId: fact.controlEventId,
      action: fact.action,
      targetDigest: fact.targetDigest,
    },
    ...(fact.runId === undefined ? {} : { runId: fact.runId }),
  }
}

type VerifiedControlFact = PlanAbandonRequestV1['controlFact']

function toolOrigin(
  invocationId: `pti_${string}`,
  payload: unknown,
): Extract<ReviewPlanMutationOriginV1, { kind: 'tool' }> {
  return Object.freeze({ kind: 'tool', invocationId, payloadDigest: canonicalDigestV1(payload) })
}

function assertOriginDigest(origin: ReviewPlanMutationOriginV1, payload: unknown): void {
  const digest = canonicalDigestV1(payload)
  const actual = origin.kind === 'tool' ? origin.payloadDigest : origin.inputDigest
  if (actual !== digest) throw originConflict(origin)
}

function assertInvocation(sessionId: string, invocation: PlanCreateRequestV1['invocation']): void {
  if (invocation.sessionId !== sessionId) throw planFailure('PLAN_INVOCATION_SCOPE_INVALID')
}

function taskContractFor(
  projection: Awaited<ReturnType<ReviewPlanJournalPortV1['loadProjection']>>,
  runId: string,
) {
  const run = projection.snapshot.runs.find((candidate) => candidate.runId === runId)
  if (run === undefined || run.state !== 'running')
    throw planFailure('PLAN_TASK_CONTRACT_NOT_FOUND')
  const userMessages = [...projection.snapshot.messages]
    .reverse()
    .filter(({ message }) => message.role === 'user')
  const candidate =
    userMessages.find(
      ({ message }) =>
        message.role === 'user' &&
        message.trust === 'user' &&
        (message.intent === 'prompt' || message.intent === 'follow_up'),
    ) ?? userMessages[0]
  if (candidate === undefined) throw planFailure('PLAN_TASK_CONTRACT_NOT_FOUND')
  const text =
    typeof candidate.message.content === 'string'
      ? candidate.message.content
      : canonicalJsonV1(candidate.message.content)
  if (text.length === 0) throw planFailure('PLAN_TASK_CONTRACT_NOT_FOUND')
  return Object.freeze({
    runId,
    messageId: candidate.messageId,
    text,
    digest: canonicalDigestV1(text),
  })
}

function requirePlan(
  plan: ReviewPlanProjectionV1 | undefined,
  expectedRevision: number,
  planId?: string,
): ReviewPlanProjectionV1 {
  if (plan === undefined) throw planFailure('PLAN_NOT_FOUND')
  if (plan.revision !== expectedRevision || (planId !== undefined && plan.planId !== planId)) {
    throw planFailure('PLAN_REVISION_CONFLICT')
  }
  return plan
}

function requireItem(plan: ReviewPlanProjectionV1, itemId: string) {
  const item = plan.items.find((candidate) => candidate.id === itemId)
  if (item === undefined) throw planFailure('PLAN_ITEM_NOT_FOUND')
  if (item.state === 'accepted') throw planFailure('PLAN_ACCEPTED_ITEM_IMMUTABLE')
  return item
}

function assertAttempt(plan: ReviewPlanProjectionV1, itemId: string, itemAttemptId: string): void {
  const item = requireItem(plan, itemId)
  if (item.currentAttempt?.itemAttemptId !== itemAttemptId) {
    throw planFailure('PLAN_ATTEMPT_NOT_FOCUSED')
  }
  if (item.preparedReview !== undefined || plan.finalPreparedReview !== undefined) {
    throw planFailure('PLAN_REVIEW_FENCE_ACTIVE')
  }
}

function assertMutable(plan: ReviewPlanProjectionV1): void {
  if (isTerminal(plan.state)) throw planFailure('PLAN_TERMINAL')
}

function isTerminal(state: ReviewPlanProjectionV1['state']): boolean {
  return ['completed', 'abandoned', 'cancelled'].includes(state)
}

function hasFence(plan: ReviewPlanProjectionV1): boolean {
  return (
    plan.finalPreparedReview !== undefined ||
    plan.items.some((item) => item.preparedReview !== undefined)
  )
}

function preparedExists(plan: ReviewPlanProjectionV1, preparedReviewId: string): boolean {
  return (
    plan.finalPreparedReview?.preparedReviewId === preparedReviewId ||
    plan.items.some((item) => item.preparedReview?.preparedReviewId === preparedReviewId)
  )
}

function requiredOnlyHere(
  plan: ReviewPlanProjectionV1,
  itemId: string,
  criterionId: string,
): boolean {
  const criterion = plan.criteria.find((candidate) => candidate.id === criterionId)
  return (
    criterion?.required === true &&
    !plan.items.some(
      (item) =>
        item.id !== itemId && item.state !== 'skipped' && item.criterionIds.includes(criterionId),
    )
  )
}

function definitionHash(plan: ReviewPlanProjectionV1): `sha256:${string}` {
  return reviewPlanHashV1({
    objective: plan.objective,
    acceptanceCriteria: plan.criteria
      .filter((criterion) => criterion.status === 'active')
      .map(
        ({
          definitionDigest: _digest,
          status: _status,
          definitionArtifactRef: _ref,
          supersedesCriterionId: _supersedes,
          ...criterion
        }) => criterion,
      ),
    items: plan.items.map((item) => ({
      id: item.id,
      title: item.title,
      criterionIds: item.criterionIds,
      reviewCheckpoint: item.reviewCheckpoint,
    })),
    reviewPolicy: plan.policy,
  })
}

function assertControl(
  projection: Awaited<ReturnType<ReviewPlanJournalPortV1['loadProjection']>>,
  fact: VerifiedControlFact,
  action: VerifiedControlFact['action'],
  planId: string,
): void {
  const durable = projection.reviewControls?.find(
    (candidate) => candidate.controlEventId === fact.controlEventId,
  )
  if (
    durable === undefined ||
    durable.state !== 'authorized' ||
    canonicalDigestV1(durable.fact) !== canonicalDigestV1(fact) ||
    fact.action !== action ||
    fact.sessionId !== projection.snapshot.sessionId ||
    fact.target.kind !== 'plan' ||
    fact.target.planId !== planId ||
    fact.expiresAt <= projection.snapshot.updatedAt!
  ) {
    throw planFailure('PLAN_CONTROL_AUTHORIZATION_INVALID')
  }
}

function queryOrigin(origin: ReviewPlanMutationOriginV1) {
  if (origin.kind === 'tool') return { kind: 'tool' as const, invocationId: origin.invocationId }
  if (origin.kind === 'runtime') return { kind: 'runtime' as const, requestId: origin.requestId }
  return {
    kind: 'host' as const,
    controlEventId: origin.controlEventId,
    ...(origin.resolutionRequestId === undefined
      ? {}
      : { resolutionRequestId: origin.resolutionRequestId }),
  }
}

function originKey(origin: ReviewPlanMutationOriginV1): string {
  if (origin.kind === 'tool') return origin.invocationId
  if (origin.kind === 'runtime') return origin.requestId
  return `${origin.controlEventId}:${origin.resolutionRequestId ?? '-'}`
}

function stableId(prefix: string, input: unknown): string {
  return `${prefix}_${canonicalDigestV1(input).slice('sha256:'.length)}`
}

function monotonicTimestamp(previous: string | undefined, candidate: string): string {
  if (previous === undefined || candidate >= previous) return candidate
  return new Date(Date.parse(previous) + 1).toISOString()
}

function withoutOrigin<T extends Readonly<{ origin: ReviewPlanMutationOriginV1 }>>(
  input: T,
): Omit<T, 'origin'> {
  const { origin: _origin, ...payload } = input
  return payload
}

function originConflict(origin: ReviewPlanMutationOriginV1): ReturnType<typeof runtimeError> {
  return planFailure(
    origin.kind === 'tool'
      ? 'PLAN_MUTATION_IDEMPOTENCY_CONFLICT'
      : origin.kind === 'runtime'
        ? 'PLAN_RUNTIME_REQUEST_CONFLICT'
        : 'PLAN_CONTROL_REQUEST_CONFLICT',
  )
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

function planFailure(code: string): ReturnType<typeof runtimeError> {
  if (code === 'PLAN_FINAL_REVIEW_NOT_READY') {
    return runtimeError(
      code,
      'planner',
      'Final Review requires every Item to be accepted. Submit plan.review with scope=item for each completed open Item attempt first, including one-Item Plans; resolve any needs_fix or pending Item, then submit scope=final. Do not repeat final Review while an Item remains unaccepted.',
    )
  }
  const message =
    code === 'PLAN_ACCEPTED_ITEM_IMMUTABLE'
      ? 'This Item is already accepted; its frozen evidence cannot be reopened with start or focus. If further work is required, use plan.update to add a new repair Item while preserving the original criteria, then start the new Item. If the missing requirement needs trusted external input or recovery, explain the block and end the turn.'
      : 'ReviewPlan control operation was rejected.'
  return runtimeError(code, 'planner', message)
}
