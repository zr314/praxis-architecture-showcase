import { canonicalDigestV1 } from './canonical-json.js'
import { runtimeError } from './contracts.js'
import {
  assertReviewPlanItemTransitionV1,
  assertReviewPlanTransitionV1,
  DEFAULT_REVIEW_POLICY_V1,
  type PreparedReviewRefV1,
  type ReviewDecisionRefV1,
  type ReviewPlanItemProjectionV1,
  type ReviewPlanItemStateV1,
  type ReviewPlanProjectionV1,
  type ReviewPlanStateV1,
  reviewCriterionDigestV1,
  reviewPlanHashV1,
  validatePlanCreateInputV1,
  validatePreparedReviewRefV1,
  validateReviewDecisionRefV1,
  validateReviewPlanBlockV1,
  validateReviewPlanProjectionV1,
} from './review-plan.js'

export const REVIEW_PLAN_EVENT_TYPES_V1 = [
  'review_plan.created',
  'review_plan.revised',
  'review_plan.item_state_changed',
  'review_plan.item_attempt_started',
  'review_plan.item_attempt_focused',
  'review_plan.item_attempt_carried_forward',
  'review_plan.item_attempt_closed',
  'review_plan.execution_requested',
  'review_plan.execution_bound',
  'review_plan.root_tool_requested',
  'review_plan.root_tool_recorded',
  'review_plan.review_prepared',
  'review_plan.review_requested',
  'review_plan.review_recorded',
  'review_plan.no_progress_recorded',
  'review_plan.block_resolved',
  'review_plan.state_changed',
] as const

export type ReviewPlanEventTypeV1 = (typeof REVIEW_PLAN_EVENT_TYPES_V1)[number]

export type ReviewPlanMutationOriginV1 =
  | Readonly<{ kind: 'tool'; invocationId: `pti_${string}`; payloadDigest: `sha256:${string}` }>
  | Readonly<{ kind: 'runtime'; requestId: string; inputDigest: `sha256:${string}` }>
  | Readonly<{
      kind: 'host'
      controlEventId: string
      resolutionRequestId?: string
      inputDigest: `sha256:${string}`
    }>

export type ReviewPlanEventCorrelationV1 = Readonly<{
  planId?: string
  itemId?: string
  itemAttemptId?: string
  executionRequestId?: string
  reviewRequestId?: string
  invocationId?: string
  runtimeRequestId?: string
  controlEventId?: string
  resolutionRequestId?: string
}>

export type ReviewPlanJournalEventV1 = Readonly<{
  type: ReviewPlanEventTypeV1
  sequence: number
  revision: number
  runId?: string
  correlation?: ReviewPlanEventCorrelationV1
  data: Readonly<Record<string, unknown>>
}>

export type ReviewPlanSessionEntryV3 = Readonly<{
  schemaVersion: 3
  entryId: string
  sessionId: string
  sequence: number
  revision: number
  timestamp: string
  type: ReviewPlanEventTypeV1
  runId?: string
  correlation?: ReviewPlanEventCorrelationV1 & Readonly<Record<string, string | undefined>>
  data: Readonly<Record<string, unknown>>
}>

type Common = Readonly<{
  origin: ReviewPlanMutationOriginV1
  mutationDigest: `sha256:${string}`
  planId: string
  planRevision: number
}>

export function isReviewPlanEventTypeV1(value: string): value is ReviewPlanEventTypeV1 {
  return (REVIEW_PLAN_EVENT_TYPES_V1 as readonly string[]).includes(value)
}

export function validateReviewPlanMutationOriginV1(input: unknown): ReviewPlanMutationOriginV1 {
  if (!record(input)) invalid()
  if (input.kind === 'tool') {
    exact(input, ['kind', 'invocationId', 'payloadDigest'])
    if (
      typeof input.invocationId !== 'string' ||
      !/^pti_[A-Za-z0-9._:+-]{1,124}$/u.test(input.invocationId)
    )
      invalid()
    digest(input.payloadDigest)
  } else if (input.kind === 'runtime') {
    exact(input, ['kind', 'requestId', 'inputDigest'])
    safeId(input.requestId)
    digest(input.inputDigest)
  } else if (input.kind === 'host') {
    exact(input, ['kind', 'controlEventId', 'inputDigest'], ['resolutionRequestId'])
    safeId(input.controlEventId)
    digest(input.inputDigest)
    if (input.resolutionRequestId !== undefined) safeId(input.resolutionRequestId)
  } else invalid()
  return freeze(structuredClone(input)) as ReviewPlanMutationOriginV1
}

export function validateReviewPlanEventV1(
  input: ReviewPlanJournalEventV1,
): ReviewPlanJournalEventV1 {
  try {
    if (
      !record(input) ||
      !exactKeys(input, ['type', 'sequence', 'revision', 'data'], ['runId', 'correlation'])
    )
      invalid()
    if (
      !isReviewPlanEventTypeV1(input.type) ||
      !positive(input.sequence) ||
      !positive(input.revision) ||
      !record(input.data)
    )
      invalid()
    if (input.runId !== undefined) safeId(input.runId)
    if (input.correlation !== undefined) validateCorrelation(input.correlation)
    validateEventData(input.type, input.data)
    return freeze(structuredClone(input)) as ReviewPlanJournalEventV1
  } catch (error) {
    if (hasCode(error, 'REVIEW_PLAN_EVENT_INVALID')) throw error
    invalid()
  }
}

export function reduceReviewPlanEventV1(
  current: ReviewPlanProjectionV1 | undefined,
  rawEvent: ReviewPlanJournalEventV1,
): ReviewPlanProjectionV1 {
  const event = validateReviewPlanEventV1(rawEvent)
  const data = event.data as Common & Record<string, unknown>
  if (event.type === 'review_plan.created') {
    if (current !== undefined || data.planRevision !== 1) transitionInvalid()
    const definition = validatePlanCreateInputV1(data.input)
    const policy = definition.reviewPolicy ?? DEFAULT_REVIEW_POLICY_V1
    const expectedHash = reviewPlanHashV1({
      objective: definition.objective,
      acceptanceCriteria: definition.acceptanceCriteria,
      items: definition.items,
      reviewPolicy: policy,
    })
    if (data.planHash !== expectedHash) transitionInvalid()
    return validateReviewPlanProjectionV1({
      schemaVersion: 1,
      planId: data.planId,
      revision: 1,
      objective: definition.objective,
      objectiveDigest: canonicalDigestV1(definition.objective),
      ...(data.taskContract === undefined ? {} : { taskContract: data.taskContract }),
      state: 'active',
      policy,
      criteria: definition.acceptanceCriteria.map((criterion) => ({
        ...criterion,
        definitionDigest: reviewCriterionDigestV1(criterion),
        status: 'active',
      })),
      items: definition.items.map((item, order) => ({
        ...item,
        order,
        state: 'pending',
        attemptCount: 0,
        taskRefs: [],
        evidenceRefs: [],
      })),
      attemptCount: 0,
      replanCount: 0,
      noProgressCount: 0,
    })
  }

  const plan = requireCurrent(current, data.planId, data.planRevision, event.type)
  const next = structuredClone(plan) as unknown as MutableReviewPlan
  switch (event.type) {
    case 'review_plan.revised': {
      const definition = validatePlanCreateInputV1(data.input)
      const fromRevision = data.fromPlanRevision as number
      if (fromRevision !== plan.revision || data.planRevision !== plan.revision + 1)
        transitionInvalid()
      const policy = definition.reviewPolicy ?? plan.policy
      const expectedHash = reviewPlanHashV1({
        objective: definition.objective,
        acceptanceCriteria: definition.acceptanceCriteria,
        items: definition.items,
        reviewPolicy: policy,
      })
      if (data.planHash !== expectedHash || plan.finalPreparedReview !== undefined)
        transitionInvalid()
      next.revision = data.planRevision
      next.objective = definition.objective
      next.objectiveDigest = canonicalDigestV1(definition.objective)
      next.policy = policy
      next.criteria = definition.acceptanceCriteria.map((criterion) => ({
        ...criterion,
        definitionDigest: reviewCriterionDigestV1(criterion),
        status: 'active' as const,
      }))
      next.items = definition.items.map((definitionItem, order) => {
        const prior = plan.items.find((item) => item.id === definitionItem.id)
        const sameDefinition =
          prior !== undefined &&
          prior.title === definitionItem.title &&
          prior.reviewCheckpoint === definitionItem.reviewCheckpoint &&
          equalStrings(prior.criterionIds, definitionItem.criterionIds)
        if (sameDefinition && prior.state === 'accepted') {
          const { currentAttempt, ...priorWithoutAttempt } = prior
          return {
            ...priorWithoutAttempt,
            order,
            taskRefs: [...prior.taskRefs],
            evidenceRefs: [...prior.evidenceRefs],
            ...(currentAttempt === undefined
              ? {}
              : {
                  currentAttempt: {
                    itemAttemptId: currentAttempt.itemAttemptId,
                    attemptNumber: currentAttempt.attemptNumber,
                    state: currentAttempt.state,
                    ...(currentAttempt.evidenceRefs === undefined
                      ? {}
                      : { evidenceRefs: [...currentAttempt.evidenceRefs] }),
                  },
                }),
          }
        }
        return {
          ...definitionItem,
          order,
          state: 'pending' as const,
          attemptCount: 0,
          taskRefs: [],
          evidenceRefs: [],
        }
      })
      next.replanCount += 1
      next.state = 'active'
      delete next.block
      delete next.finalPreparedReview
      break
    }
    case 'review_plan.item_state_changed': {
      const item = mutableItem(next, data.itemId)
      const state = data.state as ReviewPlanItemStateV1
      assertReviewPlanItemTransitionV1(item.state, state)
      item.state = state
      if (data.block === undefined) delete item.block
      else item.block = validateReviewPlanBlockV1(data.block)
      break
    }
    case 'review_plan.item_attempt_started': {
      const item = mutableItem(next, data.itemId)
      if (
        item.currentAttempt !== undefined ||
        !['pending', 'needs_fix', 'blocked'].includes(item.state)
      )
        transitionInvalid()
      const attemptNumber = data.attemptNumber as number
      if (attemptNumber !== item.attemptCount + 1) transitionInvalid()
      item.currentAttempt = {
        itemAttemptId: data.itemAttemptId as string,
        attemptNumber,
        state: 'open',
        evidenceRefs: [],
      }
      item.attemptCount = attemptNumber
      item.state = 'running'
      delete item.block
      next.attemptCount += 1
      ;(next as MutableReviewPlan & { focusedRootAttemptId?: string }).focusedRootAttemptId =
        data.itemAttemptId as string
      break
    }
    case 'review_plan.item_attempt_focused': {
      const item = mutableItem(next, data.itemId)
      requireAttempt(item, data.itemAttemptId)
      ;(next as MutableReviewPlan & { focusedRootAttemptId?: string }).focusedRootAttemptId =
        data.itemAttemptId as string
      break
    }
    case 'review_plan.item_attempt_carried_forward': {
      const item = mutableItem(next, data.itemId)
      requireAttempt(item, data.itemAttemptId)
      if (data.fromPlanRevision !== plan.revision - 1 || data.planRevision !== plan.revision)
        transitionInvalid()
      break
    }
    case 'review_plan.item_attempt_closed': {
      const item = mutableItem(next, data.itemId)
      const attempt = requireAttempt(item, data.itemAttemptId)
      attempt.state = data.attemptState as typeof attempt.state
      delete item.currentAttempt
      if (
        (next as MutableReviewPlan & { focusedRootAttemptId?: string }).focusedRootAttemptId ===
        data.itemAttemptId
      ) {
        delete (next as MutableReviewPlan & { focusedRootAttemptId?: string }).focusedRootAttemptId
      }
      break
    }
    case 'review_plan.execution_requested':
      requireAttempt(mutableItem(next, data.itemId), data.itemAttemptId)
      break
    case 'review_plan.execution_bound': {
      const item = mutableItem(next, data.itemId)
      requireAttempt(item, data.itemAttemptId)
      appendUnique(item.taskRefs, data.taskRef as string)
      break
    }
    case 'review_plan.root_tool_requested':
      requireAttempt(mutableItem(next, data.itemId), data.itemAttemptId)
      break
    case 'review_plan.root_tool_recorded': {
      const item = mutableItem(next, data.itemId)
      const attempt = requireAttempt(item, data.itemAttemptId)
      if (attempt.evidenceRefs === undefined) attempt.evidenceRefs = []
      const attemptEvidence = attempt.evidenceRefs
      if (data.resultRef !== undefined) {
        appendUnique(item.evidenceRefs, data.resultRef as string)
        appendUnique(attemptEvidence, data.resultRef as string)
      }
      if (data.effectReceiptRef !== undefined) {
        appendUnique(item.evidenceRefs, data.effectReceiptRef as string)
        appendUnique(attemptEvidence, data.effectReceiptRef as string)
      }
      break
    }
    case 'review_plan.review_prepared': {
      const prepared = validatePreparedReviewRefV1(data.preparedReview)
      if (prepared.planRevision !== plan.revision) transitionInvalid()
      if (prepared.scope.kind === 'item') {
        const item = mutableItem(next, prepared.scope.itemId)
        requireAttempt(item, prepared.itemAttemptId)
        if (item.preparedReview !== undefined) transitionInvalid()
        item.preparedReview = prepared
      } else {
        if (next.finalPreparedReview !== undefined) transitionInvalid()
        next.finalPreparedReview = prepared
      }
      break
    }
    case 'review_plan.review_requested': {
      const prepared = requirePrepared(next, data.preparedReviewId)
      if (prepared.scope.kind === 'item') {
        const item = mutableItem(next, prepared.scope.itemId)
        const attempt = requireAttempt(item, prepared.itemAttemptId)
        attempt.state = 'review_requested'
        item.state = 'review_requested'
      } else {
        assertReviewPlanTransitionV1(next.state, 'reviewing')
        next.state = 'reviewing'
      }
      break
    }
    case 'review_plan.review_recorded': {
      const prepared = requirePrepared(next, data.preparedReviewId)
      const decision = validateReviewDecisionRefV1(data.decision)
      if (decision.reviewRequestId !== data.reviewRequestId) transitionInvalid()
      if (prepared.scope.kind === 'item') {
        const item = mutableItem(next, prepared.scope.itemId)
        const attempt = requireAttempt(item, prepared.itemAttemptId)
        item.lastReview = decision
        item.state = itemStateForVerdict(decision.verdict)
        attempt.state = attemptStateForVerdict(decision.verdict)
        if (decision.verdict === 'accepted') {
          item.acceptedInputDigest = prepared.reviewInputDigest
          item.acceptedEvidenceRefs = [...prepared.evidenceRefs]
          item.acceptedAttemptId = attempt.itemAttemptId
        }
        delete item.preparedReview
        delete item.currentAttempt
        if (next.focusedRootAttemptId === attempt.itemAttemptId) delete next.focusedRootAttemptId
      } else {
        next.lastReview = decision
        delete next.finalPreparedReview
        const target = planStateForVerdict(decision.verdict)
        if (next.state !== target) assertReviewPlanTransitionV1(next.state, target)
        next.state = target
      }
      break
    }
    case 'review_plan.no_progress_recorded':
      if (data.noProgressCount !== next.noProgressCount + 1) transitionInvalid()
      next.noProgressCount = data.noProgressCount as number
      break
    case 'review_plan.block_resolved':
      if (next.block?.blockId === data.blockId) {
        delete next.block
        next.state = 'active'
      } else {
        const item = next.items.find((candidate) => candidate.block?.blockId === data.blockId)
        if (item === undefined) transitionInvalid()
        delete item.block
        if (item.state === 'blocked') item.state = 'pending'
      }
      break
    case 'review_plan.state_changed': {
      const state = data.state as ReviewPlanStateV1
      assertReviewPlanTransitionV1(next.state, state)
      next.state = state
      if (data.block === undefined) delete next.block
      else next.block = validateReviewPlanBlockV1(data.block)
      if (['abandoned', 'cancelled'].includes(state)) {
        delete next.finalPreparedReview
        for (const item of next.items) delete item.preparedReview
      }
      break
    }
  }
  return validateReviewPlanProjectionV1(next)
}

function validateEventData(type: ReviewPlanEventTypeV1, data: Record<string, unknown>): void {
  const common = ['origin', 'mutationDigest', 'planId', 'planRevision']
  validateCommon(data)
  switch (type) {
    case 'review_plan.created':
      exact(data, [...common, 'input', 'planHash'], ['taskContract'])
      validatePlanCreateInputV1(data.input)
      digest(data.planHash)
      if (data.taskContract !== undefined) validateTaskContractData(data.taskContract)
      break
    case 'review_plan.revised':
      exact(data, [...common, 'fromPlanRevision', 'input', 'planHash'])
      positive(data.fromPlanRevision)
      validatePlanCreateInputV1(data.input)
      digest(data.planHash)
      break
    case 'review_plan.item_state_changed':
      exact(data, [...common, 'itemId', 'state'], ['block'])
      item(data.itemId, data.itemAttemptId)
      enumValue(data.state, [
        'pending',
        'running',
        'review_requested',
        'accepted',
        'needs_fix',
        'blocked',
        'skipped',
      ])
      if (data.block !== undefined) validateReviewPlanBlockV1(data.block)
      break
    case 'review_plan.item_attempt_started':
      exact(data, [...common, 'itemId', 'itemAttemptId', 'attemptNumber'])
      item(data.itemId, data.itemAttemptId)
      positive(data.attemptNumber)
      break
    case 'review_plan.item_attempt_focused':
      exact(data, [...common, 'itemId', 'itemAttemptId'])
      item(data.itemId, data.itemAttemptId)
      break
    case 'review_plan.item_attempt_carried_forward':
      exact(data, [
        ...common,
        'itemId',
        'itemAttemptId',
        'fromPlanRevision',
        'executionInputDigest',
      ])
      item(data.itemId, data.itemAttemptId)
      positive(data.fromPlanRevision)
      digest(data.executionInputDigest)
      break
    case 'review_plan.item_attempt_closed':
      exact(data, [...common, 'itemId', 'itemAttemptId', 'attemptState'])
      item(data.itemId, data.itemAttemptId)
      enumValue(data.attemptState, ['accepted', 'needs_fix', 'blocked', 'cancelled'])
      break
    case 'review_plan.execution_requested':
      exact(data, [
        ...common,
        'itemId',
        'itemAttemptId',
        'executionRequestId',
        'executionInputDigest',
      ])
      item(data.itemId, data.itemAttemptId)
      safeId(data.executionRequestId)
      digest(data.executionInputDigest)
      break
    case 'review_plan.execution_bound':
      exact(data, [...common, 'itemId', 'itemAttemptId', 'executionRequestId', 'taskRef'])
      item(data.itemId, data.itemAttemptId)
      safeId(data.executionRequestId)
      bounded(data.taskRef)
      break
    case 'review_plan.root_tool_requested':
      exact(data, [
        ...common,
        'itemId',
        'itemAttemptId',
        'requestId',
        'invocationId',
        'toolName',
        'inputDigest',
      ])
      item(data.itemId, data.itemAttemptId)
      for (const key of ['requestId', 'invocationId', 'toolName']) safeId(data[key])
      digest(data.inputDigest)
      break
    case 'review_plan.root_tool_recorded':
      exact(
        data,
        [...common, 'itemId', 'itemAttemptId', 'requestId'],
        ['resultRef', 'effectReceiptRef', 'changedFilesDigest'],
      )
      item(data.itemId, data.itemAttemptId)
      safeId(data.requestId)
      if (data.resultRef === undefined && data.effectReceiptRef === undefined) invalid()
      if (data.resultRef !== undefined) bounded(data.resultRef)
      if (data.effectReceiptRef !== undefined) bounded(data.effectReceiptRef)
      if (data.changedFilesDigest !== undefined) digest(data.changedFilesDigest)
      break
    case 'review_plan.review_prepared':
      exact(data, [...common, 'preparedReview'])
      validatePreparedReviewRefV1(data.preparedReview)
      break
    case 'review_plan.review_requested':
      exact(data, [
        ...common,
        'preparedReviewId',
        'reviewRequestId',
        'deterministicDigest',
        'deterministicAttemptCount',
        'providerAttemptCount',
      ])
      safeId(data.preparedReviewId)
      safeId(data.reviewRequestId)
      digest(data.deterministicDigest)
      positive(data.deterministicAttemptCount)
      nonNegative(data.providerAttemptCount)
      break
    case 'review_plan.review_recorded':
      exact(data, [...common, 'preparedReviewId', 'reviewRequestId', 'decision'])
      safeId(data.preparedReviewId)
      safeId(data.reviewRequestId)
      validateReviewDecisionRefV1(data.decision)
      break
    case 'review_plan.no_progress_recorded':
      exact(data, [...common, 'noProgressCount'])
      positive(data.noProgressCount)
      break
    case 'review_plan.block_resolved':
      exact(data, [...common, 'blockId'])
      if (typeof data.blockId !== 'string' || !data.blockId.startsWith('rpb_')) invalid()
      break
    case 'review_plan.state_changed':
      exact(data, [...common, 'state'], ['block'])
      enumValue(data.state, [
        'active',
        'reviewing',
        'blocked',
        'completed',
        'abandoned',
        'cancelled',
      ])
      if (data.block !== undefined) validateReviewPlanBlockV1(data.block)
      if ((data.state === 'blocked') !== (data.block !== undefined)) invalid()
      break
  }
}

function validateCommon(data: Record<string, unknown>): void {
  validateReviewPlanMutationOriginV1(data.origin)
  digest(data.mutationDigest)
  safeId(data.planId)
  positive(data.planRevision)
}

function validateCorrelation(value: unknown): void {
  if (
    !record(value) ||
    Object.keys(value).length === 0 ||
    !Object.values(value).every((entry) => entry === undefined || safeId(entry))
  )
    invalid()
  const allowed = [
    'planId',
    'itemId',
    'itemAttemptId',
    'executionRequestId',
    'reviewRequestId',
    'invocationId',
    'runtimeRequestId',
    'controlEventId',
    'resolutionRequestId',
  ]
  if (!Object.keys(value).every((key) => allowed.includes(key))) invalid()
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }

type MutableItem = Omit<
  Mutable<ReviewPlanItemProjectionV1>,
  'taskRefs' | 'evidenceRefs' | 'currentAttempt'
> & {
  taskRefs: string[]
  evidenceRefs: string[]
  currentAttempt?: {
    itemAttemptId: string
    attemptNumber: number
    state: 'open' | 'review_requested' | 'accepted' | 'needs_fix' | 'blocked' | 'cancelled'
    evidenceRefs?: string[]
  }
}

type MutableReviewPlan = Omit<Mutable<ReviewPlanProjectionV1>, 'items' | 'criteria'> & {
  items: MutableItem[]
  criteria: ReviewPlanProjectionV1['criteria'] extends readonly (infer T)[] ? T[] : never
  focusedRootAttemptId?: string
}

function requireCurrent(
  current: ReviewPlanProjectionV1 | undefined,
  planId: unknown,
  revision: unknown,
  type: ReviewPlanEventTypeV1,
): ReviewPlanProjectionV1 {
  if (current === undefined || current.planId !== planId) transitionInvalid()
  if (type !== 'review_plan.revised' && current.revision !== revision) transitionInvalid()
  return current
}

function mutableItem(plan: MutableReviewPlan, itemId: unknown): MutableItem {
  const item = plan.items.find((candidate) => candidate.id === itemId)
  if (item === undefined) transitionInvalid()
  return item
}

function requireAttempt(item: MutableItem, attemptId: unknown) {
  if (item.currentAttempt === undefined || item.currentAttempt.itemAttemptId !== attemptId)
    transitionInvalid()
  return item.currentAttempt
}

function requirePrepared(plan: MutableReviewPlan, preparedReviewId: unknown): PreparedReviewRefV1 {
  const prepared =
    plan.finalPreparedReview ??
    plan.items.find((item) => item.preparedReview?.preparedReviewId === preparedReviewId)
      ?.preparedReview
  if (prepared === undefined || prepared.preparedReviewId !== preparedReviewId) transitionInvalid()
  return prepared
}

function itemStateForVerdict(verdict: ReviewDecisionRefV1['verdict']): ReviewPlanItemStateV1 {
  if (verdict === 'accepted') return 'accepted'
  if (verdict === 'blocked') return 'blocked'
  return 'needs_fix'
}

function attemptStateForVerdict(
  verdict: ReviewDecisionRefV1['verdict'],
): 'accepted' | 'needs_fix' | 'blocked' {
  if (verdict === 'accepted') return 'accepted'
  if (verdict === 'blocked') return 'blocked'
  return 'needs_fix'
}

function planStateForVerdict(verdict: ReviewDecisionRefV1['verdict']): ReviewPlanStateV1 {
  if (verdict === 'accepted') return 'completed'
  if (verdict === 'blocked') return 'blocked'
  return 'active'
}

function appendUnique(values: string[], value: string): void {
  if (values.includes(value)) transitionInvalid()
  values.push(value)
}

function item(itemId: unknown, attemptId: unknown): void {
  safeId(itemId)
  if (attemptId !== undefined) safeId(attemptId)
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function validateTaskContractData(value: unknown): void {
  if (!record(value)) invalid()
  exact(value, ['runId', 'messageId', 'text', 'digest'])
  safeId(value.runId)
  safeId(value.messageId)
  if (
    typeof value.text !== 'string' ||
    value.text.length === 0 ||
    Buffer.byteLength(value.text, 'utf8') > 64 * 1024
  )
    invalid()
  digest(value.digest)
  if (value.digest !== canonicalDigestV1(value.text)) invalid()
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (!exactKeys(value, required, optional)) invalid()
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value)
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

function safeId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u.test(value)) invalid()
  return true
}

function digest(value: unknown): asserts value is `sha256:${string}` {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) invalid()
}

function bounded(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 2_048)
    invalid()
}

function positive(value: unknown): value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid()
  return true
}

function nonNegative(value: unknown): value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid()
  return true
}

function enumValue(value: unknown, values: readonly string[]): void {
  if (typeof value !== 'string' || !values.includes(value)) invalid()
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested)
  return value
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

function invalid(): never {
  throw runtimeError('REVIEW_PLAN_EVENT_INVALID', 'planner', 'ReviewPlan Journal event is invalid.')
}

function transitionInvalid(): never {
  throw runtimeError(
    'REVIEW_PLAN_EVENT_TRANSITION_INVALID',
    'planner',
    'ReviewPlan Journal transition is invalid.',
  )
}
