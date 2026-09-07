import { canonicalDigestV1 } from './canonical-json.js'
import { runtimeError } from './contracts.js'
import {
  MAX_PERSISTABLE_PROVIDER_RESPONSE_BYTES_V1,
  MAX_REVIEW_EVIDENCE_ITEMS_V1,
} from './provider-output-policy.js'

export const REVIEW_PLAN_SCHEMA_VERSION_V1 = 1
export const REVIEW_PLAN_SNAPSHOT_MAX_BYTES_V1 = 8_192
export const REVIEW_PLAN_SNAPSHOT_MAX_TOKENS_V1 = 2_048
export const MAX_REVIEW_RAW_RESPONSE_BYTES_V1 = MAX_PERSISTABLE_PROVIDER_RESPONSE_BYTES_V1

const MAX_OBJECTIVE_BYTES = 16_384
const MAX_DESCRIPTION_BYTES = 8_192
const MAX_ITEMS = 128
const MAX_CRITERIA = 128
const MAX_PARAMETERS = 64
const MAX_PATH_BYTES = 2_048
const MAX_DURABLE_ATTEMPT_EVIDENCE_REFS = 65_536
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u
const SHA256 = /^sha256:[a-f0-9]{64}$/u

export type CatalogSchemaRefV1 =
  | Readonly<{
      kind: 'catalog'
      schemaId: string
      schemaVersion: string
      schemaDigest: `sha256:${string}`
    }>
  | Readonly<{
      kind: 'artifact'
      artifactRef: string
      contentDigest: `sha256:${string}`
    }>

export type MechanicalCriterionSpecV1 =
  | Readonly<{
      checker: 'registered_check'
      checkerId: string
      checkerVersion: string
      checkerDigest: `sha256:${string}`
      parameters?: Readonly<Record<string, string | number | boolean>>
      expectedExitCodes: readonly number[]
    }>
  | Readonly<{
      checker: 'json_schema'
      evidenceRole: string
      schemaRef: CatalogSchemaRefV1
    }>
  | Readonly<{
      checker: 'file_rule'
      path: string
      rule:
        | Readonly<{ kind: 'exists' }>
        | Readonly<{ kind: 'sha256'; expectedDigest: `sha256:${string}` }>
        | Readonly<{
            kind: 'registered_content_rule'
            ruleId: string
            ruleVersion: string
            ruleDigest: `sha256:${string}`
          }>
    }>
  | Readonly<{
      checker: 'content_digest'
      /** Legacy organizational label. Runtime matching is based on the immutable digest. */
      evidenceRole?: string
      expectedDigest: `sha256:${string}`
    }>
  | Readonly<{
      checker: 'diff_boundary'
      allowedPathPrefixes: readonly string[]
      deniedPathPrefixes: readonly string[]
    }>
  | Readonly<{
      checker: 'tool_receipt'
      /** Legacy organizational label. Runtime matching is based on the recorded Tool identity. */
      evidenceRole?: string
      toolName?: string
      expectedState: 'succeeded'
    }>
  | Readonly<{
      checker: 'effect_receipt'
      /** Legacy organizational label. Runtime matching is based on the durable effect receipt. */
      evidenceRole?: string
      effectKind?: 'workspace_write' | 'external_idempotent' | 'external_non_idempotent'
      expectedState: 'committed'
    }>
  | Readonly<{
      checker: 'artifact_or_child_result'
      /** Legacy organizational label. Runtime matching is based on the recorded source. */
      evidenceRole?: string
      source: 'artifact' | 'child_result'
    }>

export type ReviewCriterionV1 = Readonly<{
  id: string
  description: string
  required: boolean
  reviewRequired?: boolean
}> &
  (
    | Readonly<{ kind: 'mechanical'; check: MechanicalCriterionSpecV1 }>
    | Readonly<{ kind: 'semantic'; check?: never }>
  )

export type ReviewPolicyV1 = Readonly<{
  semantic: 'final' | 'final_and_checkpoints'
  maxRepairAttemptsPerItem: number
  maxReplans: number
  maxReviewAttempts: number
  maxNoProgressAttempts: number
}>

export const DEFAULT_REVIEW_POLICY_V1: ReviewPolicyV1 = Object.freeze({
  semantic: 'final_and_checkpoints',
  maxRepairAttemptsPerItem: 8,
  maxReplans: 8,
  maxReviewAttempts: 3,
  maxNoProgressAttempts: 3,
})

export type ReviewPlanItemDefinitionV1 = Readonly<{
  id: string
  title: string
  criterionIds: readonly string[]
  reviewCheckpoint: boolean
}>

export type PlanCreateInputV1 = Readonly<{
  objective: string
  acceptanceCriteria: readonly ReviewCriterionV1[]
  items: readonly ReviewPlanItemDefinitionV1[]
  reviewPolicy?: ReviewPolicyV1
}>

export type ReviewPlanCanonicalInputV1 = Readonly<{
  objective: string
  acceptanceCriteria: readonly ReviewCriterionV1[]
  items: readonly ReviewPlanItemDefinitionV1[]
  reviewPolicy: ReviewPolicyV1
}>

export type ReviewPlanStateV1 =
  | 'active'
  | 'reviewing'
  | 'blocked'
  | 'completed'
  | 'abandoned'
  | 'cancelled'
export type ReviewPlanItemStateV1 =
  | 'pending'
  | 'running'
  | 'review_requested'
  | 'accepted'
  | 'needs_fix'
  | 'blocked'
  | 'skipped'

export type ReviewPlanItemAttemptV1 = Readonly<{
  itemAttemptId: string
  attemptNumber: number
  state: 'open' | 'review_requested' | 'accepted' | 'needs_fix' | 'blocked' | 'cancelled'
  /** Runtime-recorded evidence produced by this exact Attempt. */
  evidenceRefs?: readonly string[]
}>

export type ReviewPlanTaskContractV1 = Readonly<{
  runId: string
  messageId: string
  text: string
  digest: `sha256:${string}`
}>

export type PreparedFileRuleInputV1 = Readonly<{
  criterionId: string
  path: string
  exists: boolean
  artifactRef?: string
  contentDigest?: `sha256:${string}`
  contentBytes?: number
  fileIdentityDigest?: `sha256:${string}`
  workspaceBaselineDigest: `sha256:${string}`
}>

export type ReviewScopeV1 = Readonly<{ kind: 'item'; itemId: string }> | Readonly<{ kind: 'final' }>

export type PreparedReviewRefV1 = Readonly<{
  preparedReviewId: string
  scope: ReviewScopeV1
  planRevision: number
  itemAttemptId?: string
  criterionIds: readonly string[]
  evidenceRefs: readonly string[]
  reviewInputDigest: `sha256:${string}`
  resultSummaryArtifactRef: string
  resultSummaryDigest: `sha256:${string}`
  resultSummaryBytes: number
  preparedFileInputs: readonly PreparedFileRuleInputV1[]
  changedFilesArtifactRef?: string
  changedFilesDigest?: `sha256:${string}`
  triggerReasons: readonly string[]
}>

export type ReviewPlanEffectRefV1 = Readonly<{
  workflowId: string
  effectRequestId: string
  requestDigest: `sha256:${string}`
}>

export type ReviewPlanBlockV1 = Readonly<{
  blockId: `rpb_${string}`
  code: string
  allowedResolver: 'plan_revision' | 'user_input' | 'runtime_health' | 'trusted_host'
  detailDigest: `sha256:${string}`
  createdAt: string
  effectRefs?: readonly ReviewPlanEffectRefV1[]
}>

export type ReviewDecisionRefV1 = Readonly<{
  reviewRequestId: string
  decisionArtifactRef: string
  decisionDigest: `sha256:${string}`
  verdict: 'accepted' | 'needs_fix' | 'replan' | 'blocked'
}>

export type ReviewCriterionProjectionV1 = ReviewCriterionV1 &
  Readonly<{
    definitionDigest: `sha256:${string}`
    definitionArtifactRef?: string
    status: 'active' | 'retired'
    supersedesCriterionId?: string
  }>

export type ReviewPlanItemProjectionV1 = Readonly<{
  id: string
  title: string
  order: number
  criterionIds: readonly string[]
  state: ReviewPlanItemStateV1
  reviewCheckpoint: boolean
  attemptCount: number
  currentAttempt?: ReviewPlanItemAttemptV1
  block?: ReviewPlanBlockV1
  preparedReview?: PreparedReviewRefV1
  taskRefs: readonly string[]
  evidenceRefs: readonly string[]
  /** Evidence frozen by the Reviewer for the accepted Attempt only. */
  acceptedEvidenceRefs?: readonly string[]
  acceptedAttemptId?: string
  acceptedInputDigest?: `sha256:${string}`
  lastReview?: ReviewDecisionRefV1
}>

export type ReviewPlanProjectionV1 = Readonly<{
  schemaVersion: 1
  planId: string
  revision: number
  objective: string
  objectiveDigest: `sha256:${string}`
  /** Immutable persisted user request that caused this Plan to be created. */
  taskContract?: ReviewPlanTaskContractV1
  state: ReviewPlanStateV1
  policy: ReviewPolicyV1
  criteria: readonly ReviewCriterionProjectionV1[]
  items: readonly ReviewPlanItemProjectionV1[]
  attemptCount: number
  replanCount: number
  noProgressCount: number
  focusedRootAttemptId?: string
  block?: ReviewPlanBlockV1
  finalPreparedReview?: PreparedReviewRefV1
  lastReview?: ReviewDecisionRefV1
}>

export type PlanControlReasonCodeV1 =
  | 'user_requested_abandon'
  | 'user_changed_scope'
  | 'user_resolved_block'
  | 'user_cancelled'
  | 'user_closed_session'
  | 'host_policy_override'

export type PlanControlTargetSelectorV1 =
  | Readonly<{ kind: 'plan'; planId: string }>
  | Readonly<{ kind: 'run'; runId: string }>
  | Readonly<{ kind: 'session' }>

export type PlanControlAuthorizationTargetV1 =
  | Readonly<{
      kind: 'plan'
      planId: string
      expectedPlanRevision: number
      planStateDigest: `sha256:${string}`
    }>
  | Readonly<{
      kind: 'run'
      runId: string
      runStateDigest: `sha256:${string}`
      planBinding: null | Readonly<{
        planId: string
        planRevision: number
        stateDigest: `sha256:${string}`
      }>
    }>
  | Readonly<{
      kind: 'session'
      sessionStateDigest: `sha256:${string}`
      planBinding: null | Readonly<{
        planId: string
        planRevision: number
        stateDigest: `sha256:${string}`
      }>
    }>

export type PlanControlAuthorizationChallengeV1 = Readonly<{
  challengeId: `pcc_${string}`
  challengeKeyId: string
  authorizationRequestId: string
  sessionId: string
  action: 'abandon' | 'scope_change' | 'resolve_block' | 'cancel' | 'session_close'
  reasonCode: PlanControlReasonCodeV1
  target: PlanControlAuthorizationTargetV1
  targetDigest: `sha256:${string}`
  actorBindingDigest: `sha256:${string}`
  issuedAt: string
  nonce: string
  challengeExpiresAt: string
  authorizationExpiresAt: string
}>

export type VerifiedPlanControlFactV1 = Readonly<{
  controlEventId: string
  actorId: string
  actorBindingDigest: `sha256:${string}`
  sessionId: string
  action: PlanControlAuthorizationChallengeV1['action']
  reasonCode: PlanControlReasonCodeV1
  target: PlanControlAuthorizationTargetV1
  targetDigest: `sha256:${string}`
  challengeId: `pcc_${string}`
  challengeDigest: `sha256:${string}`
  tokenDigest: `sha256:${string}`
  issuedAt: string
  expiresAt: string
  runId?: string
  providerTurnId?: string
}>

export function validateReviewCriterionV1(input: unknown): ReviewCriterionV1 {
  try {
    if (!isRecord(input)) criterionInvalid()
    const common = ['id', 'description', 'kind', 'required']
    const optional = ['reviewRequired']
    if (input.kind === 'mechanical') {
      if (!onlyKeys(input, [...common, 'check'], optional)) criterionInvalid()
    } else if (input.kind === 'semantic') {
      if (!onlyKeys(input, common, optional)) criterionInvalid()
    } else criterionInvalid()
    safeId(input.id)
    boundedText(input.description, MAX_DESCRIPTION_BYTES)
    boolean(input.required)
    if (input.reviewRequired !== undefined) boolean(input.reviewRequired)
    if (input.kind === 'mechanical') validateMechanicalCheck(input.check)
    return deepFreeze(structuredClone(input)) as ReviewCriterionV1
  } catch (error) {
    if (hasCode(error, 'REVIEW_CRITERION_INVALID')) throw error
    criterionInvalid()
  }
}

export function validatePlanCreateInputV1(input: unknown): PlanCreateInputV1 {
  try {
    if (
      !isRecord(input) ||
      !onlyKeys(input, ['objective', 'acceptanceCriteria', 'items'], ['reviewPolicy'])
    ) {
      planCreateInvalid()
    }
    boundedText(input.objective, MAX_OBJECTIVE_BYTES)
    if (!boundedArray(input.acceptanceCriteria, 1, MAX_CRITERIA)) planCreateInvalid()
    if (!boundedArray(input.items, 1, MAX_ITEMS)) planCreateInvalid()
    const criteria = input.acceptanceCriteria.map(validateReviewCriterionV1)
    unique(criteria.map((criterion) => criterion.id))
    const items = input.items.map(validateItemDefinition)
    unique(items.map((item) => item.id))
    const ids = new Set(criteria.map((criterion) => criterion.id))
    for (const item of items) {
      if (item.criterionIds.length === 0 || item.criterionIds.some((id) => !ids.has(id))) {
        planCreateInvalid()
      }
    }
    for (const criterion of criteria) {
      if (criterion.required && !items.some((item) => item.criterionIds.includes(criterion.id))) {
        planCreateInvalid()
      }
    }
    const reviewPolicy = validateReviewPolicyV1(input.reviewPolicy ?? DEFAULT_REVIEW_POLICY_V1)
    return deepFreeze({
      objective: input.objective,
      acceptanceCriteria: criteria,
      items,
      ...(input.reviewPolicy === undefined ? {} : { reviewPolicy }),
    }) as PlanCreateInputV1
  } catch (error) {
    if (hasCode(error, 'PLAN_CREATE_INVALID')) throw error
    planCreateInvalid()
  }
}

export function validateReviewPlanProjectionV1(input: unknown): ReviewPlanProjectionV1 {
  try {
    if (
      !isRecord(input) ||
      !onlyKeys(
        input,
        [
          'schemaVersion',
          'planId',
          'revision',
          'objective',
          'objectiveDigest',
          'state',
          'policy',
          'criteria',
          'items',
          'attemptCount',
          'replanCount',
          'noProgressCount',
        ],
        ['taskContract', 'focusedRootAttemptId', 'block', 'finalPreparedReview', 'lastReview'],
      )
    ) {
      projectionInvalid()
    }
    if (input.schemaVersion !== REVIEW_PLAN_SCHEMA_VERSION_V1) projectionInvalid()
    safeId(input.planId)
    positive(input.revision)
    boundedText(input.objective, MAX_OBJECTIVE_BYTES)
    digest(input.objectiveDigest)
    if (input.taskContract !== undefined) validateTaskContract(input.taskContract)
    state(input.state, ['active', 'reviewing', 'blocked', 'completed', 'abandoned', 'cancelled'])
    const policy = validateReviewPolicyV1(input.policy)
    if (!boundedArray(input.criteria, 1, MAX_CRITERIA)) projectionInvalid()
    const criteria = input.criteria.map(validateCriterionProjection)
    unique(criteria.map((criterion) => criterion.id))
    if (!boundedArray(input.items, 1, MAX_ITEMS)) projectionInvalid()
    const items = input.items.map(validateItemProjection)
    unique(items.map((item) => item.id))
    const criterionIds = new Set(criteria.map((criterion) => criterion.id))
    if (items.some((item) => item.criterionIds.some((id) => !criterionIds.has(id))))
      projectionInvalid()
    nonNegative(input.attemptCount)
    nonNegative(input.replanCount)
    nonNegative(input.noProgressCount)
    if (input.focusedRootAttemptId !== undefined) safeId(input.focusedRootAttemptId)
    if (input.block !== undefined) validateBlock(input.block)
    if (input.finalPreparedReview !== undefined) validatePreparedReview(input.finalPreparedReview)
    if (input.lastReview !== undefined) validateDecisionRef(input.lastReview)
    return deepFreeze({
      ...structuredClone(input),
      policy,
      criteria,
      items,
    }) as unknown as ReviewPlanProjectionV1
  } catch (error) {
    if (hasCode(error, 'REVIEW_PLAN_PROJECTION_INVALID')) throw error
    projectionInvalid()
  }
}

export function reviewCriterionDigestV1(input: ReviewCriterionV1): `sha256:${string}` {
  return canonicalDigestV1(validateReviewCriterionV1(input))
}

export function reviewPlanHashV1(input: ReviewPlanCanonicalInputV1): `sha256:${string}` {
  const normalized = validatePlanCreateInputV1({
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria,
    items: input.items,
    reviewPolicy: input.reviewPolicy,
  })
  return canonicalDigestV1({
    objective: normalized.objective,
    acceptanceCriteria: normalized.acceptanceCriteria,
    items: normalized.items,
    reviewPolicy: normalized.reviewPolicy ?? DEFAULT_REVIEW_POLICY_V1,
  })
}

export function assertReviewPlanTransitionV1(from: ReviewPlanStateV1, to: ReviewPlanStateV1): void {
  const allowed: Record<ReviewPlanStateV1, readonly ReviewPlanStateV1[]> = {
    active: ['reviewing', 'blocked', 'abandoned', 'cancelled'],
    reviewing: ['active', 'blocked', 'completed', 'cancelled'],
    blocked: ['active', 'abandoned', 'cancelled'],
    completed: [],
    abandoned: [],
    cancelled: [],
  }
  if (!allowed[from].includes(to)) transitionInvalid()
}

export function assertReviewPlanItemTransitionV1(
  from: ReviewPlanItemStateV1,
  to: ReviewPlanItemStateV1,
): void {
  const allowed: Record<ReviewPlanItemStateV1, readonly ReviewPlanItemStateV1[]> = {
    pending: ['running', 'skipped', 'blocked'],
    running: ['review_requested', 'needs_fix', 'accepted', 'blocked'],
    review_requested: ['accepted', 'needs_fix', 'blocked'],
    accepted: [],
    needs_fix: ['running', 'blocked', 'skipped'],
    blocked: ['pending', 'running', 'skipped'],
    skipped: [],
  }
  if (!allowed[from].includes(to)) transitionInvalid()
}

function validateMechanicalCheck(input: unknown): MechanicalCriterionSpecV1 {
  if (!isRecord(input) || typeof input.checker !== 'string') criterionInvalid()
  switch (input.checker) {
    case 'registered_check':
      if (
        !onlyKeys(
          input,
          ['checker', 'checkerId', 'checkerVersion', 'checkerDigest', 'expectedExitCodes'],
          ['parameters'],
        )
      )
        criterionInvalid()
      safeId(input.checkerId)
      safeId(input.checkerVersion)
      digest(input.checkerDigest)
      if (
        !boundedArray(input.expectedExitCodes, 1, 32) ||
        input.expectedExitCodes.some((code) => !Number.isSafeInteger(code))
      )
        criterionInvalid()
      if (input.parameters !== undefined) validateParameters(input.parameters)
      break
    case 'json_schema':
      if (!onlyKeys(input, ['checker', 'evidenceRole', 'schemaRef'])) criterionInvalid()
      safeId(input.evidenceRole)
      validateSchemaRef(input.schemaRef)
      break
    case 'file_rule':
      if (!onlyKeys(input, ['checker', 'path', 'rule'])) criterionInvalid()
      workspacePath(input.path)
      validateFileRule(input.rule)
      break
    case 'content_digest':
      if (!onlyKeys(input, ['checker', 'expectedDigest'], ['evidenceRole'])) criterionInvalid()
      if (input.evidenceRole !== undefined) safeId(input.evidenceRole)
      digest(input.expectedDigest)
      break
    case 'diff_boundary':
      if (!onlyKeys(input, ['checker', 'allowedPathPrefixes', 'deniedPathPrefixes']))
        criterionInvalid()
      pathList(input.allowedPathPrefixes)
      pathList(input.deniedPathPrefixes)
      break
    case 'tool_receipt':
      if (
        !onlyKeys(input, ['checker', 'expectedState'], ['evidenceRole', 'toolName']) ||
        input.expectedState !== 'succeeded'
      )
        criterionInvalid()
      if (input.evidenceRole !== undefined) safeId(input.evidenceRole)
      if (input.toolName !== undefined) safeId(input.toolName)
      break
    case 'effect_receipt':
      if (
        !onlyKeys(input, ['checker', 'expectedState'], ['evidenceRole', 'effectKind']) ||
        input.expectedState !== 'committed'
      )
        criterionInvalid()
      if (input.evidenceRole !== undefined) safeId(input.evidenceRole)
      if (input.effectKind !== undefined)
        state(input.effectKind, [
          'workspace_write',
          'external_idempotent',
          'external_non_idempotent',
        ])
      break
    case 'artifact_or_child_result':
      if (!onlyKeys(input, ['checker', 'source'], ['evidenceRole'])) criterionInvalid()
      if (input.evidenceRole !== undefined) safeId(input.evidenceRole)
      state(input.source, ['artifact', 'child_result'])
      break
    default:
      criterionInvalid()
  }
  return deepFreeze(structuredClone(input)) as MechanicalCriterionSpecV1
}

function validateSchemaRef(input: unknown): CatalogSchemaRefV1 {
  if (!isRecord(input)) criterionInvalid()
  if (input.kind === 'catalog') {
    if (!onlyKeys(input, ['kind', 'schemaId', 'schemaVersion', 'schemaDigest'])) criterionInvalid()
    safeId(input.schemaId)
    safeId(input.schemaVersion)
    digest(input.schemaDigest)
  } else if (input.kind === 'artifact') {
    if (!onlyKeys(input, ['kind', 'artifactRef', 'contentDigest'])) criterionInvalid()
    boundedText(input.artifactRef, 512)
    digest(input.contentDigest)
  } else criterionInvalid()
  return deepFreeze(structuredClone(input)) as CatalogSchemaRefV1
}

function validateFileRule(input: unknown): void {
  if (!isRecord(input) || typeof input.kind !== 'string') criterionInvalid()
  if (input.kind === 'exists') {
    if (!onlyKeys(input, ['kind'])) criterionInvalid()
  } else if (input.kind === 'sha256') {
    if (!onlyKeys(input, ['kind', 'expectedDigest'])) criterionInvalid()
    digest(input.expectedDigest)
  } else if (input.kind === 'registered_content_rule') {
    if (!onlyKeys(input, ['kind', 'ruleId', 'ruleVersion', 'ruleDigest'])) criterionInvalid()
    safeId(input.ruleId)
    safeId(input.ruleVersion)
    digest(input.ruleDigest)
  } else criterionInvalid()
}

function validateParameters(input: unknown): void {
  if (!isRecord(input) || Object.keys(input).length > MAX_PARAMETERS) criterionInvalid()
  for (const [key, value] of Object.entries(input)) {
    safeId(key)
    if (
      !['string', 'number', 'boolean'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value))
    )
      criterionInvalid()
  }
}

function validateItemDefinition(input: unknown): ReviewPlanItemDefinitionV1 {
  if (!isRecord(input) || !onlyKeys(input, ['id', 'title', 'criterionIds', 'reviewCheckpoint']))
    planCreateInvalid()
  safeId(input.id)
  boundedText(input.title, MAX_DESCRIPTION_BYTES)
  stringIds(input.criterionIds, 1, MAX_CRITERIA)
  unique(input.criterionIds as string[])
  boolean(input.reviewCheckpoint)
  return deepFreeze(structuredClone(input)) as ReviewPlanItemDefinitionV1
}

export function validateReviewPolicyV1(input: unknown): ReviewPolicyV1 {
  if (
    !isRecord(input) ||
    !onlyKeys(input, [
      'semantic',
      'maxRepairAttemptsPerItem',
      'maxReplans',
      'maxReviewAttempts',
      'maxNoProgressAttempts',
    ])
  )
    planCreateInvalid()
  state(input.semantic, ['final', 'final_and_checkpoints'])
  positive(input.maxRepairAttemptsPerItem)
  positive(input.maxReplans)
  positive(input.maxReviewAttempts)
  positive(input.maxNoProgressAttempts)
  if (
    [
      input.maxRepairAttemptsPerItem,
      input.maxReplans,
      input.maxReviewAttempts,
      input.maxNoProgressAttempts,
    ].some((value) => (value as number) > 32)
  )
    planCreateInvalid()
  return deepFreeze(structuredClone(input)) as ReviewPolicyV1
}

export function validatePreparedReviewRefV1(input: unknown): PreparedReviewRefV1 {
  try {
    return validatePreparedReview(input)
  } catch (error) {
    if (hasCode(error, 'REVIEW_PLAN_PROJECTION_INVALID')) throw error
    projectionInvalid()
  }
}

export function validateReviewPlanBlockV1(input: unknown): ReviewPlanBlockV1 {
  try {
    validateBlock(input)
    return deepFreeze(structuredClone(input)) as ReviewPlanBlockV1
  } catch (error) {
    if (hasCode(error, 'REVIEW_PLAN_PROJECTION_INVALID')) throw error
    projectionInvalid()
  }
}

export function validateReviewDecisionRefV1(input: unknown): ReviewDecisionRefV1 {
  try {
    validateDecisionRef(input)
    return deepFreeze(structuredClone(input)) as ReviewDecisionRefV1
  } catch (error) {
    if (hasCode(error, 'REVIEW_PLAN_PROJECTION_INVALID')) throw error
    projectionInvalid()
  }
}

function validateCriterionProjection(input: unknown): ReviewCriterionProjectionV1 {
  if (!isRecord(input)) projectionInvalid()
  const criterion = validateReviewCriterionV1({
    id: input.id,
    description: input.description,
    kind: input.kind,
    required: input.required,
    ...(input.reviewRequired === undefined ? {} : { reviewRequired: input.reviewRequired }),
    ...(input.kind === 'mechanical' ? { check: input.check } : {}),
  })
  digest(input.definitionDigest)
  if (input.definitionArtifactRef !== undefined) boundedText(input.definitionArtifactRef, 512)
  state(input.status, ['active', 'retired'])
  if (input.supersedesCriterionId !== undefined) safeId(input.supersedesCriterionId)
  const allowed = [
    'id',
    'description',
    'kind',
    'required',
    'reviewRequired',
    'check',
    'definitionDigest',
    'definitionArtifactRef',
    'status',
    'supersedesCriterionId',
  ]
  if (Object.keys(input).some((key) => !allowed.includes(key))) projectionInvalid()
  return deepFreeze({
    ...criterion,
    definitionDigest: input.definitionDigest,
    ...(input.definitionArtifactRef === undefined
      ? {}
      : { definitionArtifactRef: input.definitionArtifactRef }),
    status: input.status,
    ...(input.supersedesCriterionId === undefined
      ? {}
      : { supersedesCriterionId: input.supersedesCriterionId }),
  }) as ReviewCriterionProjectionV1
}

function validateItemProjection(input: unknown): ReviewPlanItemProjectionV1 {
  if (
    !isRecord(input) ||
    !onlyKeys(
      input,
      [
        'id',
        'title',
        'order',
        'criterionIds',
        'state',
        'reviewCheckpoint',
        'attemptCount',
        'taskRefs',
        'evidenceRefs',
      ],
      [
        'currentAttempt',
        'block',
        'preparedReview',
        'acceptedEvidenceRefs',
        'acceptedAttemptId',
        'acceptedInputDigest',
        'lastReview',
      ],
    )
  )
    projectionInvalid()
  safeId(input.id)
  boundedText(input.title, MAX_DESCRIPTION_BYTES)
  nonNegative(input.order)
  stringIds(input.criterionIds, 1, MAX_CRITERIA)
  unique(input.criterionIds as string[])
  state(input.state, [
    'pending',
    'running',
    'review_requested',
    'accepted',
    'needs_fix',
    'blocked',
    'skipped',
  ])
  boolean(input.reviewCheckpoint)
  nonNegative(input.attemptCount)
  if (input.currentAttempt !== undefined) validateItemAttempt(input.currentAttempt)
  if (input.block !== undefined) validateBlock(input.block)
  if (input.preparedReview !== undefined) validatePreparedReview(input.preparedReview)
  stringList(input.taskRefs, 256)
  stringList(input.evidenceRefs, MAX_DURABLE_ATTEMPT_EVIDENCE_REFS)
  if (input.acceptedEvidenceRefs !== undefined)
    stringList(input.acceptedEvidenceRefs, MAX_REVIEW_EVIDENCE_ITEMS_V1)
  if (input.acceptedAttemptId !== undefined) safeId(input.acceptedAttemptId)
  if (
    (input.acceptedEvidenceRefs === undefined) !== (input.acceptedAttemptId === undefined) ||
    (input.state === 'accepted' && input.acceptedEvidenceRefs === undefined)
  )
    projectionInvalid()
  if (input.acceptedInputDigest !== undefined) digest(input.acceptedInputDigest)
  if (input.lastReview !== undefined) validateDecisionRef(input.lastReview)
  return deepFreeze(structuredClone(input)) as ReviewPlanItemProjectionV1
}

function validateItemAttempt(input: unknown): void {
  if (
    !isRecord(input) ||
    !onlyKeys(input, ['itemAttemptId', 'attemptNumber', 'state'], ['evidenceRefs'])
  )
    projectionInvalid()
  safeId(input.itemAttemptId)
  positive(input.attemptNumber)
  state(input.state, ['open', 'review_requested', 'accepted', 'needs_fix', 'blocked', 'cancelled'])
  if (input.evidenceRefs !== undefined)
    stringList(input.evidenceRefs, MAX_DURABLE_ATTEMPT_EVIDENCE_REFS)
}

function validateTaskContract(input: unknown): void {
  if (!isRecord(input) || !onlyKeys(input, ['runId', 'messageId', 'text', 'digest']))
    projectionInvalid()
  safeId(input.runId)
  safeId(input.messageId)
  boundedText(input.text, 64 * 1024)
  digest(input.digest)
  if (input.digest !== canonicalDigestV1(input.text)) projectionInvalid()
}

function validatePreparedReview(input: unknown): PreparedReviewRefV1 {
  if (
    !isRecord(input) ||
    !onlyKeys(
      input,
      [
        'preparedReviewId',
        'scope',
        'planRevision',
        'criterionIds',
        'evidenceRefs',
        'reviewInputDigest',
        'resultSummaryArtifactRef',
        'resultSummaryDigest',
        'resultSummaryBytes',
        'preparedFileInputs',
        'triggerReasons',
      ],
      ['itemAttemptId', 'changedFilesArtifactRef', 'changedFilesDigest'],
    )
  )
    projectionInvalid()
  safeId(input.preparedReviewId)
  validateScope(input.scope)
  positive(input.planRevision)
  if (input.itemAttemptId !== undefined) safeId(input.itemAttemptId)
  if ((input.scope as ReviewScopeV1).kind === 'item' && input.itemAttemptId === undefined)
    projectionInvalid()
  stringIds(input.criterionIds, 1, MAX_CRITERIA)
  unique(input.criterionIds as string[])
  stringList(input.evidenceRefs, MAX_REVIEW_EVIDENCE_ITEMS_V1)
  digest(input.reviewInputDigest)
  boundedText(input.resultSummaryArtifactRef, 512)
  digest(input.resultSummaryDigest)
  nonNegative(input.resultSummaryBytes)
  if (!boundedArray(input.preparedFileInputs, 0, 64)) projectionInvalid()
  input.preparedFileInputs.forEach(validatePreparedFile)
  if ((input.changedFilesArtifactRef === undefined) !== (input.changedFilesDigest === undefined))
    projectionInvalid()
  if (input.changedFilesArtifactRef !== undefined) boundedText(input.changedFilesArtifactRef, 512)
  if (input.changedFilesDigest !== undefined) digest(input.changedFilesDigest)
  stringList(input.triggerReasons, 64)
  return deepFreeze(structuredClone(input)) as PreparedReviewRefV1
}

function validatePreparedFile(input: unknown): void {
  if (
    !isRecord(input) ||
    !onlyKeys(
      input,
      ['criterionId', 'path', 'exists', 'workspaceBaselineDigest'],
      ['artifactRef', 'contentDigest', 'contentBytes', 'fileIdentityDigest'],
    )
  )
    projectionInvalid()
  safeId(input.criterionId)
  workspacePath(input.path)
  boolean(input.exists)
  digest(input.workspaceBaselineDigest)
  const contentFields = [
    input.artifactRef,
    input.contentDigest,
    input.contentBytes,
    input.fileIdentityDigest,
  ]
  if (input.exists && contentFields.some((value) => value === undefined)) projectionInvalid()
  if (!input.exists && contentFields.some((value) => value !== undefined)) projectionInvalid()
  if (input.artifactRef !== undefined) boundedText(input.artifactRef, 512)
  if (input.contentDigest !== undefined) digest(input.contentDigest)
  if (input.contentBytes !== undefined) nonNegative(input.contentBytes)
  if (input.fileIdentityDigest !== undefined) digest(input.fileIdentityDigest)
}

function validateScope(input: unknown): void {
  if (!isRecord(input)) projectionInvalid()
  if (input.kind === 'item') {
    if (!onlyKeys(input, ['kind', 'itemId'])) projectionInvalid()
    safeId(input.itemId)
  } else if (input.kind === 'final') {
    if (!onlyKeys(input, ['kind'])) projectionInvalid()
  } else projectionInvalid()
}

function validateBlock(input: unknown): void {
  if (
    !isRecord(input) ||
    !onlyKeys(
      input,
      ['blockId', 'code', 'allowedResolver', 'detailDigest', 'createdAt'],
      ['effectRefs'],
    )
  )
    projectionInvalid()
  if (typeof input.blockId !== 'string' || !/^rpb_[A-Za-z0-9._:+-]{1,124}$/u.test(input.blockId))
    projectionInvalid()
  safeId(input.code)
  state(input.allowedResolver, ['plan_revision', 'user_input', 'runtime_health', 'trusted_host'])
  digest(input.detailDigest)
  instant(input.createdAt)
  if (input.effectRefs !== undefined) {
    if (!boundedArray(input.effectRefs, 1, 64)) projectionInvalid()
    for (const ref of input.effectRefs) {
      if (!isRecord(ref) || !onlyKeys(ref, ['workflowId', 'effectRequestId', 'requestDigest']))
        projectionInvalid()
      safeId(ref.workflowId)
      safeId(ref.effectRequestId)
      digest(ref.requestDigest)
    }
  }
}

function validateDecisionRef(input: unknown): void {
  if (
    !isRecord(input) ||
    !onlyKeys(input, ['reviewRequestId', 'decisionArtifactRef', 'decisionDigest', 'verdict'])
  )
    projectionInvalid()
  safeId(input.reviewRequestId)
  boundedText(input.decisionArtifactRef, 512)
  digest(input.decisionDigest)
  state(input.verdict, ['accepted', 'needs_fix', 'replan', 'blocked'])
}

function workspacePath(value: unknown): asserts value is string {
  boundedText(value, MAX_PATH_BYTES)
  if (
    /^(?:[A-Za-z]:|[/\\]|.*(?:^|[/\\])\.\.(?:[/\\]|$))/u.test(value as string) ||
    (value as string).includes('\0')
  )
    criterionInvalid()
}

function pathList(value: unknown): void {
  if (!boundedArray(value, 0, 64)) criterionInvalid()
  value.forEach(workspacePath)
}

function stringIds(value: unknown, minimum: number, maximum: number): asserts value is string[] {
  if (!boundedArray(value, minimum, maximum)) planCreateInvalid()
  value.forEach(safeId)
}

function stringList(value: unknown, maximum: number): asserts value is string[] {
  if (!boundedArray(value, 0, maximum)) projectionInvalid()
  value.forEach((entry) => {
    boundedText(entry, 512)
  })
}

function boundedArray(value: unknown, minimum: number, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= maximum
}

function boundedText(value: unknown, maximumBytes: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  )
    throw new TypeError('bounded text')
}

function safeId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError('safe id')
}

function digest(value: unknown): asserts value is `sha256:${string}` {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new TypeError('digest')
}

function boolean(value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') throw new TypeError('boolean')
}

function positive(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new TypeError('positive integer')
}

function nonNegative(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError('non-negative integer')
}

function instant(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new TypeError('instant')
}

function state(value: unknown, values: readonly string[]): asserts value is string {
  if (typeof value !== 'string' || !values.includes(value)) throw new TypeError('enum')
}

function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new TypeError('unique')
}

function onlyKeys(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  return value
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

function criterionInvalid(): never {
  throw runtimeError('REVIEW_CRITERION_INVALID', 'planner', 'Review criterion is invalid.')
}

function planCreateInvalid(): never {
  throw runtimeError('PLAN_CREATE_INVALID', 'planner', 'ReviewPlan creation input is invalid.')
}

function projectionInvalid(): never {
  throw runtimeError(
    'REVIEW_PLAN_PROJECTION_INVALID',
    'planner',
    'ReviewPlan projection is invalid.',
  )
}

function transitionInvalid(): never {
  throw runtimeError(
    'REVIEW_PLAN_TRANSITION_INVALID',
    'planner',
    'ReviewPlan transition is invalid.',
  )
}
