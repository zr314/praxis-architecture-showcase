import { randomUUID } from 'node:crypto'
import {
  type ExecutionBudget,
  type PlanCreatedEntryV3,
  type PlanGraphV1,
  type PlanStepAccessV1,
  type PlanSuccessCriterionV1,
  runtimeError,
  type StepCreatedEntryV3,
  validatePlanGraphV1,
} from '@praxis/core-sdk'

const MAX_PROPOSAL_BYTES = 256 * 1024
const MAX_STEPS = 64
const MAX_DEPENDENCIES = 32
const MAX_CAPABILITIES = 64
const MAX_CONFLICT_KEYS = 64
const MAX_CRITERIA = 32
const MAX_PATHS = 64
const MAX_TEXT_BYTES = 8 * 1024
const MAX_REFERENCE_BYTES = 2 * 1024
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const INVALID_WIN32_CHARACTERS = new Set(['<', '>', ':', '"', '|', '?', '*'])
const RESERVED_WIN32_BASENAME = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/i

export type FixedPlanProposalV1 = Readonly<{
  execution?: 'parent_only' | 'dag'
  objective: string
  steps: readonly FixedPlanStepProposalV1[]
}>

export type FixedPlanStepProposalV1 = Readonly<{
  key: string
  title: string
  dependencies?: readonly string[]
  access?: PlanStepAccessV1
  capabilities?: readonly string[]
  conflictKeys?: readonly string[]
  criteria: readonly PlanCriterionProposalV1[]
  budget?: Readonly<PlanStepBudgetProposalV1>
  maxAttempts?: number
}>

export type PlanCriterionProposalV1 = Readonly<{
  kind: PlanSuccessCriterionV1['kind']
  description: string
  ref?: string
  expectedDigest?: `sha256:${string}`
}>

export type PlanStepBudgetProposalV1 = Readonly<{
  maxTurns?: number
  maxToolCalls?: number
  maxTokens?: number
  deadlineAt?: string
}>

export type PlanRuntimeIdKindV1 = 'plan' | 'step' | 'criterion'

export type PlanValidatorOptions = Readonly<{
  parentBudget: Readonly<ExecutionBudget>
  defaultStepBudget: Readonly<PlanStepBudgetProposalV1>
  accessGrant: PlanStepAccessV1
  allowedCapabilities: readonly string[]
  allowedCriterionKinds?: readonly PlanSuccessCriterionV1['kind'][]
  createId?: (kind: PlanRuntimeIdKindV1, sourceKey: string) => string
}>

export type InitialPlanJournalPayloadV3 =
  | Readonly<{ type: 'plan.created'; data: PlanCreatedEntryV3['data'] }>
  | Readonly<{ type: 'step.created'; data: StepCreatedEntryV3['data'] }>

export type PlanProposalShapeBoundsV1 = Readonly<{
  maxSteps?: number
  maxDependencies?: number
}>

/**
 * Parses the model-owned proposal surface without assigning any durable identity or authority.
 * Runtime callers must still pass the returned proposal through PlanValidator before execution.
 */
export function validateFixedPlanProposalV1(
  input: unknown,
  bounds: PlanProposalShapeBoundsV1 = {},
): FixedPlanProposalV1 {
  const parsed = parseProposal(input)
  const maxSteps = boundedPositiveInteger(bounds.maxSteps, MAX_STEPS)
  const maxDependencies = boundedNonNegativeInteger(bounds.maxDependencies, MAX_DEPENDENCIES)
  if (
    parsed.steps.length > maxSteps ||
    parsed.steps.reduce((total, step) => total + step.dependencies.length, 0) > maxDependencies
  ) {
    fail('PLAN_PROPOSAL_INVALID')
  }
  return deepFreeze({
    execution: parsed.execution,
    objective: parsed.objective,
    steps: parsed.steps.map((step) => ({
      key: step.key,
      title: step.title,
      dependencies: [...step.dependencies],
      access: structuredClone(step.access),
      capabilities: [...step.capabilities],
      conflictKeys: [...step.conflictKeys],
      criteria: structuredClone(step.criteria),
      budget: structuredClone(step.budget),
      maxAttempts: step.maxAttempts,
    })),
  })
}

/**
 * Admits untrusted fixed-plan proposals. Proposals contain only local dependency keys;
 * stable IDs, defaults and final authority are assigned by the Runtime.
 */
export class PlanValidator {
  readonly #options: PlanValidatorOptions
  readonly #createId: (kind: PlanRuntimeIdKindV1, sourceKey: string) => string

  constructor(options: PlanValidatorOptions) {
    this.#options = validateOptions(options)
    this.#createId = options.createId ?? ((kind) => `${kind}-${randomUUID()}`)
  }

  validate(input: unknown): PlanGraphV1 {
    const proposal = parseProposal(input)
    const steps = proposal.steps

    const admittedAttempts = steps.reduce((total, step) => total + step.maxAttempts, 0)
    if (admittedAttempts > this.#options.parentBudget.maxChildRuns) {
      fail('PLAN_PROPOSAL_CHILD_BUDGET_EXCEEDED')
    }

    const stepIds = new Map(
      steps.map((step) => [step.key, this.#createId('step', step.key)] as const),
    )
    const graph = {
      schemaVersion: 1 as const,
      planId: this.#createId('plan', 'root'),
      revision: 1,
      objective: proposal.objective,
      state: 'draft' as const,
      steps: steps.map((step) => ({
        stepId: stepIds.get(step.key)!,
        title: step.title,
        order: step.order,
        state: 'pending' as const,
        dependencies: step.dependencies.map((dependency) => stepIds.get(dependency)!),
        access: admitAccess(step.access, this.#options.accessGrant),
        capabilities: admitCapabilities(step.capabilities, this.#options.allowedCapabilities),
        conflictKeys: step.conflictKeys,
        criteria: admitCriteria(step.criteria, this.#options.allowedCriterionKinds).map(
          (criterion, index) => ({
            criterionId: this.#createId('criterion', `${step.key}:${index + 1}`),
            kind: criterion.kind,
            description: criterion.description,
            ...(criterion.ref === undefined ? {} : { ref: criterion.ref }),
            ...(criterion.expectedDigest === undefined
              ? {}
              : { expectedDigest: criterion.expectedDigest }),
          }),
        ),
        budget: admitBudget(
          step.budget,
          this.#options.defaultStepBudget,
          this.#options.parentBudget,
        ),
        maxAttempts: step.maxAttempts,
        attemptIds: [],
      })),
      attempts: [],
    }
    return validatePlanGraphV1(graph)
  }
}

function parseProposal(
  input: unknown,
): Readonly<{ execution: 'parent_only' | 'dag'; objective: string; steps: readonly ParsedStep[] }> {
  if (jsonBytes(input) > MAX_PROPOSAL_BYTES) fail('PLAN_PROPOSAL_OVERSIZED')
  const proposal = exactRecord(input, ['objective', 'steps'], ['execution'])
  const execution = proposal.execution ?? 'dag'
  if (
    !['parent_only', 'dag'].includes(String(execution)) ||
    !boundedText(proposal.objective, MAX_TEXT_BYTES) ||
    !Array.isArray(proposal.steps) ||
    (execution === 'dag' && proposal.steps.length < 1) ||
    (execution === 'parent_only' && proposal.steps.length !== 0) ||
    proposal.steps.length > MAX_STEPS
  ) {
    fail('PLAN_PROPOSAL_INVALID')
  }

  const steps = proposal.steps.map((candidate, index) => parseStep(candidate, index))
  unique(
    steps.map((step) => step.key),
    'PLAN_PROPOSAL_DUPLICATE_KEY',
  )
  const byKey = new Map(steps.map((step) => [step.key, step]))
  for (const step of steps) {
    for (const dependency of step.dependencies) {
      if (dependency === step.key) fail('PLAN_PROPOSAL_SELF_DEPENDENCY')
      if (!byKey.has(dependency)) fail('PLAN_PROPOSAL_DEPENDENCY_MISSING')
    }
  }
  assertAcyclic(steps)
  return { execution: execution as 'parent_only' | 'dag', objective: proposal.objective, steps }
}

/** Produces the complete atomic journal payload for a newly admitted fixed plan. */
export function initialPlanJournalPayloadsV3(
  input: PlanGraphV1,
): readonly InitialPlanJournalPayloadV3[] {
  const graph = validatePlanGraphV1(input)
  if (
    graph.revision !== 1 ||
    graph.state !== 'draft' ||
    graph.attempts.length !== 0 ||
    graph.steps.some((step) => step.state !== 'pending' || step.attemptIds.length !== 0)
  ) {
    fail('PLAN_INITIAL_JOURNAL_STATE_INVALID')
  }
  return deepFreeze([
    Object.freeze({
      type: 'plan.created' as const,
      data: Object.freeze({
        planId: graph.planId,
        planRevision: graph.revision,
        objective: graph.objective,
        state: graph.state,
      }),
    }),
    ...graph.steps.map((step) =>
      Object.freeze({
        type: 'step.created' as const,
        data: Object.freeze({
          planId: graph.planId,
          planRevision: graph.revision,
          stepId: step.stepId,
          title: step.title,
          order: step.order,
          state: step.state,
          dependencies: [...step.dependencies],
          access: structuredClone(step.access),
          capabilities: [...step.capabilities],
          conflictKeys: [...step.conflictKeys],
          criteria: structuredClone(step.criteria),
          budget: structuredClone(step.budget),
          maxAttempts: step.maxAttempts,
        }),
      }),
    ),
  ])
}

type ParsedStep = Readonly<{
  key: string
  title: string
  order: number
  dependencies: readonly string[]
  access: PlanStepAccessV1
  capabilities: readonly string[]
  conflictKeys: readonly string[]
  criteria: readonly PlanCriterionProposalV1[]
  budget: PlanStepBudgetProposalV1
  maxAttempts: number
}>

function validateOptions(input: PlanValidatorOptions): PlanValidatorOptions {
  if (!isRecord(input)) fail('PLAN_VALIDATOR_OPTIONS_INVALID')
  const value = exactRecord(
    input,
    ['parentBudget', 'defaultStepBudget', 'accessGrant', 'allowedCapabilities'],
    ['allowedCriterionKinds', 'createId'],
  )
  if (value.createId !== undefined && typeof value.createId !== 'function') {
    fail('PLAN_VALIDATOR_OPTIONS_INVALID')
  }
  const parentBudget = validateParentBudget(value.parentBudget)
  const defaultStepBudget = parseStepBudget(value.defaultStepBudget)
  const accessGrant = parseAccess(value.accessGrant)
  const allowedCapabilities = stringList(value.allowedCapabilities, MAX_CAPABILITIES, true)
  const allowedCriterionKinds = parseAllowedCriterionKinds(value.allowedCriterionKinds)
  admitBudget(defaultStepBudget, {}, parentBudget)
  return Object.freeze({
    parentBudget,
    defaultStepBudget,
    accessGrant,
    allowedCapabilities,
    allowedCriterionKinds,
    ...(value.createId === undefined
      ? {}
      : {
          createId: value.createId as (kind: PlanRuntimeIdKindV1, sourceKey: string) => string,
        }),
  })
}

function parseAllowedCriterionKinds(input: unknown): readonly PlanSuccessCriterionV1['kind'][] {
  const all: readonly PlanSuccessCriterionV1['kind'][] = [
    'schema',
    'file',
    'digest',
    'command',
    'check',
    'rule',
    'semantic',
  ]
  if (input === undefined) return all
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > all.length ||
    input.some((kind) => typeof kind !== 'string' || !all.includes(kind as (typeof all)[number]))
  ) {
    fail('PLAN_VALIDATOR_OPTIONS_INVALID')
  }
  unique(input as string[], 'PLAN_VALIDATOR_OPTIONS_INVALID')
  return Object.freeze([...(input as PlanSuccessCriterionV1['kind'][])])
}

function admitCriteria(
  criteria: readonly PlanCriterionProposalV1[],
  allowed: readonly PlanSuccessCriterionV1['kind'][] = [],
): readonly PlanCriterionProposalV1[] {
  const allowedSet = new Set(allowed)
  if (criteria.some((criterion) => !allowedSet.has(criterion.kind))) {
    fail('PLAN_PROPOSAL_CRITERION_DENIED')
  }
  return criteria
}

function parseStep(input: unknown, order: number): ParsedStep {
  const step = exactRecord(
    input,
    ['key', 'title', 'criteria'],
    ['dependencies', 'access', 'capabilities', 'conflictKeys', 'budget', 'maxAttempts'],
  )
  if (
    typeof step.key !== 'string' ||
    !SAFE_KEY.test(step.key) ||
    !boundedText(step.title, MAX_TEXT_BYTES) ||
    !Array.isArray(step.criteria) ||
    step.criteria.length < 1 ||
    step.criteria.length > MAX_CRITERIA ||
    (step.maxAttempts !== undefined &&
      (!positiveInteger(step.maxAttempts) || step.maxAttempts > 16))
  ) {
    fail('PLAN_PROPOSAL_INVALID')
  }
  return {
    key: step.key,
    title: step.title,
    order,
    dependencies: keyList(step.dependencies ?? [], MAX_DEPENDENCIES),
    access: step.access === undefined ? { mode: 'read_only', paths: [] } : parseAccess(step.access),
    capabilities: stringList(step.capabilities ?? [], MAX_CAPABILITIES, true),
    conflictKeys: stringList(step.conflictKeys ?? [], MAX_CONFLICT_KEYS, false),
    criteria: step.criteria.map(parseCriterion),
    budget: step.budget === undefined ? {} : parseStepBudget(step.budget),
    maxAttempts: (step.maxAttempts as number | undefined) ?? 1,
  }
}

function parseCriterion(input: unknown): PlanCriterionProposalV1 {
  const criterion = exactRecord(input, ['kind', 'description'], ['ref', 'expectedDigest'])
  if (
    !['schema', 'file', 'digest', 'command', 'check', 'rule', 'semantic'].includes(
      String(criterion.kind),
    ) ||
    !boundedText(criterion.description, MAX_TEXT_BYTES) ||
    (criterion.ref !== undefined && !boundedText(criterion.ref, MAX_REFERENCE_BYTES)) ||
    (criterion.expectedDigest !== undefined &&
      (typeof criterion.expectedDigest !== 'string' || !SHA256.test(criterion.expectedDigest)))
  ) {
    fail('PLAN_PROPOSAL_INVALID')
  }
  return {
    kind: criterion.kind as PlanSuccessCriterionV1['kind'],
    description: criterion.description,
    ...(criterion.ref === undefined ? {} : { ref: criterion.ref as string }),
    ...(criterion.expectedDigest === undefined
      ? {}
      : { expectedDigest: criterion.expectedDigest as `sha256:${string}` }),
  }
}

function parseAccess(input: unknown): PlanStepAccessV1 {
  const access = exactRecord(input, ['mode', 'paths'])
  if (
    access.mode !== 'read_only' &&
    access.mode !== 'isolated_process' &&
    access.mode !== 'workspace_write'
  ) {
    fail('PLAN_PROPOSAL_ACCESS_INVALID')
  }
  if (!Array.isArray(access.paths) || access.paths.length > MAX_PATHS) {
    fail('PLAN_PROPOSAL_ACCESS_INVALID')
  }
  const paths = access.paths.map((path) => {
    if (typeof path !== 'string' || !isPortablePlanPathV1(path)) {
      fail('PLAN_PROPOSAL_ACCESS_INVALID')
    }
    return path
  })
  unique(paths, 'PLAN_PROPOSAL_ACCESS_INVALID')
  return Object.freeze({ mode: access.mode, paths: Object.freeze(paths) })
}

function admitAccess(requested: PlanStepAccessV1, grant: PlanStepAccessV1): PlanStepAccessV1 {
  const authority = { read_only: 0, isolated_process: 1, workspace_write: 2 } as const
  if (authority[requested.mode] > authority[grant.mode]) {
    fail('PLAN_PROPOSAL_ACCESS_DENIED')
  }
  if (
    requested.paths.some(
      (path) => !grant.paths.some((allowed) => isPlanPathWithinGrantV1(path, allowed)),
    )
  ) {
    fail('PLAN_PROPOSAL_ACCESS_DENIED')
  }
  return requested
}

function admitCapabilities(
  requested: readonly string[],
  allowed: readonly string[],
): readonly string[] {
  const allowedSet = new Set(allowed)
  if (requested.some((capability) => !allowedSet.has(capability))) {
    fail('PLAN_PROPOSAL_CAPABILITY_DENIED')
  }
  return requested
}

function parseStepBudget(input: unknown): PlanStepBudgetProposalV1 {
  const budget = exactRecord(input, [], ['maxTurns', 'maxToolCalls', 'maxTokens', 'deadlineAt'])
  for (const field of ['maxTurns', 'maxToolCalls'] as const) {
    if (budget[field] !== undefined && !nonNegativeInteger(budget[field])) {
      fail('PLAN_PROPOSAL_BUDGET_INVALID')
    }
  }
  if (budget.maxTokens !== undefined && !positiveInteger(budget.maxTokens)) {
    fail('PLAN_PROPOSAL_BUDGET_INVALID')
  }
  if (budget.deadlineAt !== undefined && !canonicalInstant(budget.deadlineAt)) {
    fail('PLAN_PROPOSAL_BUDGET_INVALID')
  }
  return {
    ...(budget.maxTurns === undefined ? {} : { maxTurns: budget.maxTurns as number }),
    ...(budget.maxToolCalls === undefined ? {} : { maxToolCalls: budget.maxToolCalls as number }),
    ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens as number }),
    ...(budget.deadlineAt === undefined ? {} : { deadlineAt: budget.deadlineAt as string }),
  }
}

function admitBudget(
  requested: PlanStepBudgetProposalV1,
  defaults: PlanStepBudgetProposalV1,
  parent: ExecutionBudget,
): Readonly<ExecutionBudget> {
  const maxTurns = requested.maxTurns ?? defaults.maxTurns ?? 0
  const maxToolCalls = requested.maxToolCalls ?? defaults.maxToolCalls ?? 0
  const maxTokens = requested.maxTokens ?? defaults.maxTokens
  const deadlineAt = requested.deadlineAt ?? defaults.deadlineAt ?? parent.deadlineAt
  if (
    maxTurns > parent.maxTurns ||
    maxToolCalls > parent.maxToolCalls ||
    (maxTokens !== undefined && (parent.maxTokens === undefined || maxTokens > parent.maxTokens)) ||
    (deadlineAt !== undefined && parent.deadlineAt !== undefined && deadlineAt > parent.deadlineAt)
  ) {
    fail('PLAN_PROPOSAL_BUDGET_EXCEEDED')
  }
  return Object.freeze({
    maxTurns,
    maxToolCalls,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  })
}

function validateParentBudget(input: unknown): Readonly<ExecutionBudget> {
  const budget = exactRecord(
    input,
    ['maxTurns', 'maxToolCalls', 'maxChildRuns', 'maxParallelChildren', 'maxDepth'],
    ['maxTokens', 'deadlineAt'],
  )
  for (const field of [
    'maxTurns',
    'maxToolCalls',
    'maxChildRuns',
    'maxParallelChildren',
    'maxDepth',
  ] as const) {
    if (!nonNegativeInteger(budget[field])) fail('PLAN_VALIDATOR_OPTIONS_INVALID')
  }
  if (
    (budget.maxTokens !== undefined && !positiveInteger(budget.maxTokens)) ||
    (budget.deadlineAt !== undefined && !canonicalInstant(budget.deadlineAt))
  ) {
    fail('PLAN_VALIDATOR_OPTIONS_INVALID')
  }
  return Object.freeze({
    maxTurns: budget.maxTurns as number,
    maxToolCalls: budget.maxToolCalls as number,
    ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens as number }),
    maxChildRuns: budget.maxChildRuns as number,
    maxParallelChildren: budget.maxParallelChildren as number,
    maxDepth: budget.maxDepth as number,
    ...(budget.deadlineAt === undefined ? {} : { deadlineAt: budget.deadlineAt as string }),
  })
}

function assertAcyclic(steps: readonly ParsedStep[]): void {
  const dependencies = new Map(steps.map((step) => [step.key, step.dependencies]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): void => {
    if (visited.has(key)) return
    if (visiting.has(key)) fail('PLAN_PROPOSAL_CYCLE')
    visiting.add(key)
    for (const dependency of dependencies.get(key) ?? []) visit(dependency)
    visiting.delete(key)
    visited.add(key)
  }
  for (const step of steps) visit(step.key)
}

export function isPortablePlanPathV1(path: string): boolean {
  if (path === '.') return true
  if (path.length === 0 || path.startsWith('/') || path.includes('\\')) return false
  return path.split('/').every((component) => {
    if (
      component.length === 0 ||
      component === '.' ||
      component === '..' ||
      component.endsWith('.') ||
      component.endsWith(' ')
    ) {
      return false
    }
    for (const character of component) {
      if (character.charCodeAt(0) <= 31 || INVALID_WIN32_CHARACTERS.has(character)) return false
    }
    return !RESERVED_WIN32_BASENAME.test(component.split('.', 1)[0]!)
  })
}

export function isPlanPathWithinGrantV1(path: string, grant: string): boolean {
  return grant === '.' || path === grant || path.startsWith(`${grant}/`)
}

function keyList(input: unknown, maximum: number): readonly string[] {
  if (
    !Array.isArray(input) ||
    input.length > maximum ||
    !input.every((value) => typeof value === 'string' && SAFE_KEY.test(value))
  ) {
    fail('PLAN_PROPOSAL_INVALID')
  }
  unique(input, 'PLAN_PROPOSAL_INVALID')
  return Object.freeze([...input])
}

function stringList(input: unknown, maximum: number, safeKeys: boolean): readonly string[] {
  if (
    !Array.isArray(input) ||
    input.length > maximum ||
    !input.every((value) =>
      safeKeys
        ? typeof value === 'string' && SAFE_KEY.test(value)
        : boundedText(value, MAX_REFERENCE_BYTES),
    )
  ) {
    fail('PLAN_PROPOSAL_INVALID')
  }
  unique(input, 'PLAN_PROPOSAL_INVALID')
  return Object.freeze([...input])
}

function exactRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(input)) fail('PLAN_PROPOSAL_INVALID')
  const allowed = new Set([...required, ...optional])
  if (
    required.some((key) => !Object.hasOwn(input, key)) ||
    Object.keys(input).some((key) => !allowed.has(key))
  ) {
    fail('PLAN_PROPOSAL_INVALID')
  }
  return input
}

function unique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) fail(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function boundedPositiveInteger(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum
  if (!positiveInteger(value) || value > maximum) fail('PLAN_PROPOSAL_BOUNDS_INVALID')
  return value
}

function boundedNonNegativeInteger(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum
  if (!nonNegativeInteger(value) || value > maximum) fail('PLAN_PROPOSAL_BOUNDS_INVALID')
  return value
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
  if (value && typeof value === 'object') {
    if (!Object.isFrozen(value)) Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

function fail(code: string): never {
  throw Object.assign(new Error(code), runtimeError(code, 'planner', code), {
    code,
  })
}
