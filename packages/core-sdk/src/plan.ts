import { type ExecutionBudget, runtimeError } from './contracts.js'

const MAX_GRAPH_BYTES = 256 * 1024
const MAX_STEPS = 64
const MAX_ATTEMPTS = 512
const MAX_DEPENDENCIES = 32
const MAX_CAPABILITIES = 64
const MAX_CONFLICT_KEYS = 64
const MAX_CRITERIA = 32
const MAX_PATHS = 64
const MAX_TEXT_BYTES = 8 * 1024
const MAX_REFERENCE_BYTES = 2 * 1024
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/

export type PlanStateV1 =
  | 'draft'
  | 'running'
  | 'blocked'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type PlanStepStateV1 =
  | 'pending'
  | 'running'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'interrupted'

export type PlanAttemptStateV1 =
  | 'reserved'
  | 'running'
  | 'execution_succeeded'
  | 'execution_failed'
  | 'verifying'
  | 'verified'
  | 'rejected'
  | 'cancelled'
  | 'interrupted'

export type PlanStepAccessV1 = Readonly<{
  mode: 'read_only' | 'isolated_process' | 'workspace_write'
  paths: readonly string[]
}>

export type PlanSuccessCriterionV1 = Readonly<{
  criterionId: string
  kind: 'schema' | 'file' | 'digest' | 'command' | 'check' | 'rule' | 'semantic'
  description: string
  ref?: string
  expectedDigest?: `sha256:${string}`
}>

export type PlanStepV1 = Readonly<{
  stepId: string
  title: string
  order: number
  state: PlanStepStateV1
  dependencies: readonly string[]
  access: PlanStepAccessV1
  capabilities: readonly string[]
  conflictKeys: readonly string[]
  criteria: readonly PlanSuccessCriterionV1[]
  budget: Readonly<ExecutionBudget>
  maxAttempts: number
  attemptIds: readonly string[]
}>

export type PlanAttemptV1 = Readonly<{
  attemptId: string
  stepId: string
  ordinal: number
  state: PlanAttemptStateV1
  childRunId?: string
  resultRef?: string
  resultDigest?: `sha256:${string}`
  verificationRef?: string
}>

export type PlanGraphV1 = Readonly<{
  schemaVersion: 1
  planId: string
  revision: number
  objective: string
  state: PlanStateV1
  steps: readonly PlanStepV1[]
  attempts: readonly PlanAttemptV1[]
}>

export type PlanStepTransitionOptions = Readonly<{
  retryApproved?: boolean
  recoveryRetryApproved?: boolean
  externalConditionChanged?: boolean
  createsNewAttempt?: boolean
}>

/** Strict bounded contract. Semantic DAG/proposal admission belongs to PlanValidator. */
export function validatePlanGraphV1(input: unknown): PlanGraphV1 {
  if (jsonBytes(input) > MAX_GRAPH_BYTES) throw planFailure('PLAN_GRAPH_OVERSIZED')
  const graph = exactRecord(input, [
    'schemaVersion',
    'planId',
    'revision',
    'objective',
    'state',
    'steps',
    'attempts',
  ])
  if (
    graph.schemaVersion !== 1 ||
    !safeId(graph.planId) ||
    !positiveInteger(graph.revision) ||
    !boundedText(graph.objective, MAX_TEXT_BYTES) ||
    !PLAN_STATES.has(graph.state as PlanStateV1) ||
    !Array.isArray(graph.steps) ||
    graph.steps.length < 1 ||
    graph.steps.length > MAX_STEPS ||
    !Array.isArray(graph.attempts) ||
    graph.attempts.length > MAX_ATTEMPTS
  ) {
    throw planFailure('PLAN_GRAPH_INVALID')
  }
  const steps = graph.steps.map(validatePlanStepV1)
  const attempts = graph.attempts.map(validatePlanAttemptV1)
  unique(steps.map((step) => step.stepId))
  unique(steps.map((step) => String(step.order)))
  unique(attempts.map((attempt) => attempt.attemptId))
  unique(
    attempts.flatMap((attempt) => (attempt.childRunId === undefined ? [] : [attempt.childRunId])),
  )

  const attemptsById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]))
  for (const step of steps) {
    const ordinals = new Set<number>()
    for (const attemptId of step.attemptIds) {
      const attempt = attemptsById.get(attemptId)
      if (
        attempt === undefined ||
        attempt.stepId !== step.stepId ||
        ordinals.has(attempt.ordinal)
      ) {
        throw planFailure('PLAN_GRAPH_INVALID')
      }
      ordinals.add(attempt.ordinal)
    }
  }
  const linkedAttemptIds = new Set(steps.flatMap((step) => [...step.attemptIds]))
  if (attempts.some((attempt) => !linkedAttemptIds.has(attempt.attemptId))) {
    throw planFailure('PLAN_GRAPH_INVALID')
  }
  return deepFreeze({
    schemaVersion: 1,
    planId: graph.planId,
    revision: graph.revision,
    objective: graph.objective,
    state: graph.state as PlanStateV1,
    steps,
    attempts,
  })
}

export function readyPlanStepIdsV1(input: PlanGraphV1): readonly string[] {
  const graph = validatePlanGraphV1(input)
  if (graph.state !== 'running') return Object.freeze([])
  const byId = new Map(graph.steps.map((step) => [step.stepId, step]))
  const ready = graph.steps
    .filter((step) => {
      if (step.state !== 'pending' || step.attemptIds.length >= step.maxAttempts) return false
      return step.dependencies.every((dependencyId) => {
        const dependency = byId.get(dependencyId)
        if (dependency === undefined) throw planFailure('PLAN_GRAPH_DEPENDENCY_MISSING')
        return dependency.state === 'succeeded'
      })
    })
    .sort((left, right) => left.order - right.order || left.stepId.localeCompare(right.stepId))
    .map((step) => step.stepId)
  return Object.freeze(ready)
}

export function assertPlanStateTransitionV1(from: PlanStateV1, to: PlanStateV1): void {
  if (!PLAN_TRANSITIONS[from].has(to)) throw planFailure('PLAN_TRANSITION_INVALID')
}

export function assertPlanStepTransitionV1(
  from: PlanStepStateV1,
  to: PlanStepStateV1,
  options: PlanStepTransitionOptions = {},
): void {
  if (from === 'failed' && to === 'pending') {
    if (options.retryApproved && options.createsNewAttempt) return
    throw planFailure('PLAN_TRANSITION_INVALID')
  }
  if (from === 'blocked' && to === 'pending') {
    if (options.externalConditionChanged && options.createsNewAttempt) return
    throw planFailure('PLAN_TRANSITION_INVALID')
  }
  if (from === 'interrupted' && to === 'pending') {
    if (options.recoveryRetryApproved && options.createsNewAttempt) return
    throw planFailure('PLAN_TRANSITION_INVALID')
  }
  if (!STEP_TRANSITIONS[from].has(to)) throw planFailure('PLAN_TRANSITION_INVALID')
}

export function assertPlanAttemptTransitionV1(
  from: PlanAttemptStateV1,
  to: PlanAttemptStateV1,
): void {
  if (!ATTEMPT_TRANSITIONS[from].has(to)) throw planFailure('PLAN_TRANSITION_INVALID')
}

export function validatePlanStepV1(input: unknown): PlanStepV1 {
  const step = exactRecord(input, [
    'stepId',
    'title',
    'order',
    'state',
    'dependencies',
    'access',
    'capabilities',
    'conflictKeys',
    'criteria',
    'budget',
    'maxAttempts',
    'attemptIds',
  ])
  if (
    !safeId(step.stepId) ||
    !boundedText(step.title, MAX_TEXT_BYTES) ||
    !nonNegativeInteger(step.order) ||
    !STEP_STATES.has(step.state as PlanStepStateV1) ||
    !positiveInteger(step.maxAttempts) ||
    (step.maxAttempts as number) > 16
  ) {
    throw planFailure('PLAN_GRAPH_INVALID')
  }
  const dependencies = idList(step.dependencies, MAX_DEPENDENCIES)
  const capabilities = idList(step.capabilities, MAX_CAPABILITIES)
  const conflictKeys = textList(step.conflictKeys, MAX_CONFLICT_KEYS, MAX_REFERENCE_BYTES)
  const attemptIds = idList(step.attemptIds, 16)
  if (
    dependencies.includes(step.stepId as string) ||
    attemptIds.length > (step.maxAttempts as number) ||
    !Array.isArray(step.criteria) ||
    step.criteria.length < 1 ||
    step.criteria.length > MAX_CRITERIA
  ) {
    throw planFailure('PLAN_GRAPH_INVALID')
  }
  return {
    stepId: step.stepId as string,
    title: step.title as string,
    order: step.order as number,
    state: step.state as PlanStepStateV1,
    dependencies,
    access: validateAccess(step.access),
    capabilities,
    conflictKeys,
    criteria: step.criteria.map(validateCriterion),
    budget: validateBudget(step.budget),
    maxAttempts: step.maxAttempts as number,
    attemptIds,
  }
}

export function validatePlanAttemptV1(input: unknown): PlanAttemptV1 {
  const attempt = exactRecord(
    input,
    ['attemptId', 'stepId', 'ordinal', 'state'],
    ['childRunId', 'resultRef', 'resultDigest', 'verificationRef'],
  )
  if (
    !safeId(attempt.attemptId) ||
    !safeId(attempt.stepId) ||
    !positiveInteger(attempt.ordinal) ||
    !ATTEMPT_STATES.has(attempt.state as PlanAttemptStateV1) ||
    (attempt.childRunId !== undefined && !safeId(attempt.childRunId)) ||
    (attempt.resultRef !== undefined && !boundedText(attempt.resultRef, MAX_REFERENCE_BYTES)) ||
    (attempt.resultDigest !== undefined && !digest(attempt.resultDigest)) ||
    (attempt.verificationRef !== undefined &&
      !boundedText(attempt.verificationRef, MAX_REFERENCE_BYTES)) ||
    (attempt.resultRef === undefined) !== (attempt.resultDigest === undefined)
  ) {
    throw planFailure('PLAN_GRAPH_INVALID')
  }
  return {
    attemptId: attempt.attemptId as string,
    stepId: attempt.stepId as string,
    ordinal: attempt.ordinal as number,
    state: attempt.state as PlanAttemptStateV1,
    ...(attempt.childRunId === undefined ? {} : { childRunId: attempt.childRunId as string }),
    ...(attempt.resultRef === undefined ? {} : { resultRef: attempt.resultRef as string }),
    ...(attempt.resultDigest === undefined
      ? {}
      : { resultDigest: attempt.resultDigest as `sha256:${string}` }),
    ...(attempt.verificationRef === undefined
      ? {}
      : { verificationRef: attempt.verificationRef as string }),
  }
}

function validateAccess(input: unknown): PlanStepAccessV1 {
  const access = exactRecord(input, ['mode', 'paths'])
  if (
    access.mode !== 'read_only' &&
    access.mode !== 'isolated_process' &&
    access.mode !== 'workspace_write'
  ) {
    throw planFailure('PLAN_GRAPH_INVALID')
  }
  return { mode: access.mode, paths: textList(access.paths, MAX_PATHS, MAX_REFERENCE_BYTES) }
}

function validateCriterion(input: unknown): PlanSuccessCriterionV1 {
  const criterion = exactRecord(
    input,
    ['criterionId', 'kind', 'description'],
    ['ref', 'expectedDigest'],
  )
  if (
    !safeId(criterion.criterionId) ||
    !CRITERION_KINDS.has(criterion.kind as PlanSuccessCriterionV1['kind']) ||
    !boundedText(criterion.description, MAX_TEXT_BYTES) ||
    (criterion.ref !== undefined && !boundedText(criterion.ref, MAX_REFERENCE_BYTES)) ||
    (criterion.expectedDigest !== undefined && !digest(criterion.expectedDigest))
  ) {
    throw planFailure('PLAN_GRAPH_INVALID')
  }
  return {
    criterionId: criterion.criterionId as string,
    kind: criterion.kind as PlanSuccessCriterionV1['kind'],
    description: criterion.description as string,
    ...(criterion.ref === undefined ? {} : { ref: criterion.ref as string }),
    ...(criterion.expectedDigest === undefined
      ? {}
      : { expectedDigest: criterion.expectedDigest as `sha256:${string}` }),
  }
}

function validateBudget(input: unknown): Readonly<ExecutionBudget> {
  const budget = exactRecord(
    input,
    ['maxTurns', 'maxToolCalls', 'maxChildRuns', 'maxParallelChildren', 'maxDepth'],
    ['maxTokens', 'deadlineAt'],
  )
  if (
    !nonNegativeInteger(budget.maxTurns) ||
    !nonNegativeInteger(budget.maxToolCalls) ||
    (budget.maxTokens !== undefined && !positiveInteger(budget.maxTokens)) ||
    budget.maxChildRuns !== 0 ||
    budget.maxParallelChildren !== 0 ||
    budget.maxDepth !== 0 ||
    (budget.deadlineAt !== undefined && !canonicalInstant(budget.deadlineAt))
  ) {
    throw planFailure('PLAN_GRAPH_INVALID')
  }
  return {
    maxTurns: budget.maxTurns as number,
    maxToolCalls: budget.maxToolCalls as number,
    ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens as number }),
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
    ...(budget.deadlineAt === undefined ? {} : { deadlineAt: budget.deadlineAt as string }),
  }
}

const PLAN_STATES = new Set<PlanStateV1>([
  'draft',
  'running',
  'blocked',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
])
const STEP_STATES = new Set<PlanStepStateV1>([
  'pending',
  'running',
  'verifying',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
  'interrupted',
])
const ATTEMPT_STATES = new Set<PlanAttemptStateV1>([
  'reserved',
  'running',
  'execution_succeeded',
  'execution_failed',
  'verifying',
  'verified',
  'rejected',
  'cancelled',
  'interrupted',
])
const CRITERION_KINDS = new Set<PlanSuccessCriterionV1['kind']>([
  'schema',
  'file',
  'digest',
  'command',
  'check',
  'rule',
  'semantic',
])

const PLAN_TRANSITIONS: Record<PlanStateV1, ReadonlySet<PlanStateV1>> = {
  draft: new Set(['running', 'cancelled']),
  running: new Set(['blocked', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  blocked: new Set(['running', 'failed', 'cancelled', 'interrupted']),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set(['running', 'failed', 'cancelled']),
}
const STEP_TRANSITIONS: Record<PlanStepStateV1, ReadonlySet<PlanStepStateV1>> = {
  pending: new Set(['running', 'cancelled', 'interrupted']),
  running: new Set(['verifying', 'failed', 'cancelled', 'interrupted']),
  verifying: new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'interrupted']),
  succeeded: new Set(),
  failed: new Set(),
  blocked: new Set(),
  cancelled: new Set(),
  interrupted: new Set(['blocked']),
}
const ATTEMPT_TRANSITIONS: Record<PlanAttemptStateV1, ReadonlySet<PlanAttemptStateV1>> = {
  reserved: new Set(['running', 'cancelled', 'interrupted']),
  running: new Set(['execution_succeeded', 'execution_failed', 'cancelled', 'interrupted']),
  execution_succeeded: new Set(['verifying', 'interrupted']),
  execution_failed: new Set(),
  verifying: new Set(['verified', 'rejected', 'cancelled', 'interrupted']),
  verified: new Set(),
  rejected: new Set(),
  cancelled: new Set(),
  interrupted: new Set(),
}

function exactRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw planFailure('PLAN_GRAPH_INVALID')
  }
  const value = input as Record<string, unknown>
  const keys = new Set([...required, ...optional])
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.has(key))
  ) {
    throw planFailure('PLAN_GRAPH_INVALID')
  }
  return value
}

function idList(input: unknown, maximum: number): readonly string[] {
  if (!Array.isArray(input) || input.length > maximum || !input.every(safeId)) {
    throw planFailure('PLAN_GRAPH_INVALID')
  }
  unique(input)
  return [...input]
}

function textList(input: unknown, maximum: number, bytes: number): readonly string[] {
  if (
    !Array.isArray(input) ||
    input.length > maximum ||
    !input.every((value) => boundedText(value, bytes))
  ) {
    throw planFailure('PLAN_GRAPH_INVALID')
  }
  unique(input)
  return [...input]
}

function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw planFailure('PLAN_GRAPH_INVALID')
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function boundedText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes
  )
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && SHA256.test(value)
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

function planFailure(code: string): Error {
  return Object.assign(new Error(code), runtimeError(code, 'planner', code), { code })
}
