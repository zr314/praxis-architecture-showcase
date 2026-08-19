import { randomUUID } from 'node:crypto'
import type {
  PlanSuccessCriterionV1,
  SessionStepProjectionV3,
  SubagentResultV1,
} from '@praxis/core-sdk'
import { runtimeError } from '@praxis/core-sdk'
import { isPlanPathWithinGrantV1, isPortablePlanPathV1 } from './planValidator.js'

export type VerificationDecisionV1 = Readonly<{
  verifier: 'mechanical' | 'rule' | 'model'
  status: 'passed' | 'failed' | 'blocked'
  evidenceRefs: readonly string[]
  code: string
  retryable: boolean
}>

export type VerificationInputV1 = Readonly<{
  step: SessionStepProjectionV3
  result: SubagentResultV1
  signal?: AbortSignal
}>

export interface SupervisorVerifierV1 {
  verify(input: VerificationInputV1): Promise<VerificationDecisionV1>
}

export type MechanicalCheckResultV1 = Readonly<{
  passed: boolean
  evidenceRefs: readonly string[]
}>

/** Parent-owned deterministic evidence operations; command IDs are not raw shell strings. */
export interface MechanicalVerificationEnvironmentV1 {
  fileDigest(path: string): Promise<`sha256:${string}`>
  runCheck(checkId: string): Promise<MechanicalCheckResultV1>
  validateSchema(schemaRef: string, value: unknown): Promise<MechanicalCheckResultV1>
}

export class MechanicalVerifierV1 implements SupervisorVerifierV1 {
  constructor(private readonly environment: MechanicalVerificationEnvironmentV1) {}

  async verify(input: VerificationInputV1): Promise<VerificationDecisionV1> {
    const evidenceRefs: string[] = []
    for (const criterion of input.step.criteria) {
      if (criterion.kind === 'rule' || criterion.kind === 'semantic') continue
      // Schema validity is established by the parent against the stored result. It must not
      // depend on a model echoing a synthetic criterion ID or attesting to its own schema.
      if (criterion.kind === 'schema') {
        const result = await this.verifyCriterion(criterion, input)
        evidenceRefs.push(...result.evidenceRefs)
        if (!result.passed) {
          return decision('mechanical', 'failed', evidenceRefs, 'MECHANICAL_CRITERION_FAILED', true)
        }
        continue
      }
      const reported = input.result.checks.find(
        (candidate) => candidate.id === criterion.criterionId,
      )
      if (reported?.evidenceRef !== undefined) evidenceRefs.push(reported.evidenceRef)
      if (reported?.status !== 'passed') {
        return decision(
          'mechanical',
          'failed',
          evidenceRefs,
          'MECHANICAL_CHILD_CRITERION_FAILED',
          true,
        )
      }
      const result = await this.verifyCriterion(criterion, input)
      evidenceRefs.push(...result.evidenceRefs)
      if (!result.passed) {
        return decision('mechanical', 'failed', evidenceRefs, 'MECHANICAL_CRITERION_FAILED', true)
      }
    }
    return decision('mechanical', 'passed', evidenceRefs, 'MECHANICAL_VERIFICATION_PASSED', false)
  }

  private async verifyCriterion(
    criterion: PlanSuccessCriterionV1,
    input: VerificationInputV1,
  ): Promise<MechanicalCheckResultV1> {
    switch (criterion.kind) {
      case 'schema':
        return this.environment.validateSchema(criterion.ref ?? 'subagent_result_v1', input.result)
      case 'file': {
        if (
          criterion.ref === undefined ||
          !input.step.access.paths.some((grant) => isPlanPathWithinGrantV1(criterion.ref!, grant))
        ) {
          return { passed: false, evidenceRefs: [] }
        }
        const actualDigest = await this.environment.fileDigest(criterion.ref)
        const evidence = input.result.evidenceRefs.find(
          (candidate) => candidate.kind === 'file' && candidate.ref === criterion.ref,
        )
        return {
          passed:
            evidence !== undefined &&
            evidence.digest === actualDigest &&
            (criterion.expectedDigest === undefined || criterion.expectedDigest === actualDigest),
          evidenceRefs: evidence === undefined ? [] : [evidence.ref],
        }
      }
      case 'digest': {
        if (criterion.expectedDigest === undefined) return { passed: false, evidenceRefs: [] }
        const evidence = input.result.evidenceRefs.find(
          (candidate) =>
            (criterion.ref === undefined || candidate.ref === criterion.ref) &&
            candidate.digest === criterion.expectedDigest,
        )
        return {
          passed: evidence !== undefined,
          evidenceRefs: evidence === undefined ? [] : [evidence.ref],
        }
      }
      case 'command':
      case 'check': {
        const checkId = criterion.ref ?? criterion.criterionId
        const executed = await this.environment.runCheck(checkId)
        return {
          passed: executed.passed,
          evidenceRefs: unique(executed.evidenceRefs),
        }
      }
      case 'rule':
      case 'semantic':
        return { passed: true, evidenceRefs: [] }
    }
  }
}

export class RuleVerifierV1 implements SupervisorVerifierV1 {
  async verify(input: VerificationInputV1): Promise<VerificationDecisionV1> {
    if (
      (input.step.access.mode !== 'workspace_write' && input.result.changedFiles.length > 0) ||
      input.result.changedFiles.some(
        (change) =>
          !isPortablePlanPathV1(change.path) ||
          !input.step.access.paths.some((grant) => isPlanPathWithinGrantV1(change.path, grant)),
      ) ||
      input.result.evidenceRefs.some(
        (evidence) =>
          evidence.kind === 'file' &&
          (!isPortablePlanPathV1(evidence.ref) ||
            !input.step.access.paths.some((grant) => isPlanPathWithinGrantV1(evidence.ref, grant))),
      )
    ) {
      return decision('rule', 'blocked', [], 'RULE_SCOPE_VIOLATION', false)
    }

    const evidenceRefs: string[] = []
    for (const criterion of input.step.criteria.filter((candidate) => candidate.kind === 'rule')) {
      const check = input.result.checks.find((candidate) => candidate.id === criterion.criterionId)
      if (check?.evidenceRef !== undefined) evidenceRefs.push(check.evidenceRef)
      if (check?.status !== 'passed') {
        return decision('rule', 'failed', evidenceRefs, 'RULE_CRITERION_FAILED', true)
      }
    }
    return decision('rule', 'passed', evidenceRefs, 'RULE_VERIFICATION_PASSED', false)
  }
}

export const SEMANTIC_VERIFICATION_JSON_SCHEMA_V1 = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['criteria'],
  properties: {
    criteria: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterionId', 'status', 'evidenceRefs'],
        properties: {
          criterionId: { type: 'string', minLength: 1 },
          status: { enum: ['passed', 'failed'] },
          evidenceRefs: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', minLength: 1 },
            uniqueItems: true,
          },
        },
      },
    },
  },
})

export type SemanticVerifierUsageV1 = Readonly<{
  inputTokens: number
  outputTokens: number
  costUsd: number
}>

export type SemanticVerifierModelInputV1 = Readonly<{
  identity: Readonly<{
    role: 'semantic_verifier'
    verifierRunId: string
    modelId: string
  }>
  context: Readonly<{ mode: 'fresh' }>
  criteria: readonly PlanSuccessCriterionV1[]
  result: Readonly<{
    status: SubagentResultV1['status']
    summary: string
    evidenceRefs: SubagentResultV1['evidenceRefs']
    changedFiles: SubagentResultV1['changedFiles']
    checks: SubagentResultV1['checks']
  }>
  responseFormat: Readonly<{
    type: 'json_schema'
    name: 'praxis_semantic_verification_v1'
    strict: true
    schema: typeof SEMANTIC_VERIFICATION_JSON_SCHEMA_V1
  }>
  maxOutputTokens: number
  signal: AbortSignal
}>

export type SemanticVerifierModelOutputV1 = Readonly<{
  output: unknown
  usage: SemanticVerifierUsageV1
}>

export interface SemanticVerifierModelPortV1 {
  readonly identity: Readonly<{ kind: 'model'; id: string }>
  verify(input: SemanticVerifierModelInputV1): Promise<SemanticVerifierModelOutputV1>
}

export type SemanticVerifierBudgetV1 = Readonly<{
  maxInputTokens: number
  maxOutputTokens: number
  maxCostUsd: number
  deadlineMs: number
}>

export type SemanticModelVerifierOptionsV1 = Readonly<{
  budget: SemanticVerifierBudgetV1
  failureStrategy: 'fail_closed' | 'ask_user'
  createId?: () => string
}>

/** Fresh-context semantic judge. Mechanical and rule checks remain separate parent-owned gates. */
export class SemanticModelVerifierV1 implements SupervisorVerifierV1 {
  readonly #budget: SemanticVerifierBudgetV1
  readonly #failureStrategy: 'fail_closed' | 'ask_user'
  readonly #createId: () => string

  constructor(
    private readonly model: SemanticVerifierModelPortV1,
    options: SemanticModelVerifierOptionsV1,
  ) {
    validateSemanticModel(model)
    this.#budget = validateSemanticBudget(options?.budget)
    this.#failureStrategy = options.failureStrategy
    if (!['fail_closed', 'ask_user'].includes(this.#failureStrategy)) {
      semanticFail('SEMANTIC_VERIFIER_OPTIONS_INVALID')
    }
    this.#createId = options.createId ?? (() => `semantic-verifier-${randomUUID()}`)
  }

  async verify(input: VerificationInputV1): Promise<VerificationDecisionV1> {
    const criteria = input.step.criteria.filter((criterion) => criterion.kind === 'semantic')
    if (criteria.length === 0) {
      return decision('model', 'passed', [], 'SEMANTIC_VERIFICATION_NOT_REQUIRED', false)
    }
    if (input.signal?.aborted) return this.failure('SEMANTIC_VERIFIER_CANCELLED')
    const modelInput = {
      identity: {
        role: 'semantic_verifier' as const,
        verifierRunId: this.#createId(),
        modelId: this.model.identity.id,
      },
      context: { mode: 'fresh' as const },
      criteria: structuredClone(criteria),
      result: {
        status: input.result.status,
        summary: input.result.summary,
        evidenceRefs: structuredClone(input.result.evidenceRefs),
        changedFiles: structuredClone(input.result.changedFiles),
        checks: structuredClone(input.result.checks),
      },
      responseFormat: {
        type: 'json_schema' as const,
        name: 'praxis_semantic_verification_v1' as const,
        strict: true as const,
        schema: SEMANTIC_VERIFICATION_JSON_SCHEMA_V1,
      },
      maxOutputTokens: this.#budget.maxOutputTokens,
    }
    if (estimatedTokensJson(modelInput) > this.#budget.maxInputTokens) {
      return this.failure('SEMANTIC_VERIFIER_INPUT_TOKENS_EXCEEDED')
    }

    const controller = new AbortController()
    let deadlineExceeded = false
    const abortFromCaller = (): void => controller.abort('semantic_verifier_cancelled')
    input.signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timer = setTimeout(() => {
      deadlineExceeded = true
      controller.abort('semantic_verifier_deadline')
    }, this.#budget.deadlineMs)
    try {
      const output = await Promise.race([
        this.model.verify({ ...modelInput, signal: controller.signal }),
        abortPromise(controller.signal),
      ])
      const usage = validateSemanticUsage(output?.usage)
      if (usage.inputTokens > this.#budget.maxInputTokens) {
        return this.failure('SEMANTIC_VERIFIER_INPUT_TOKENS_EXCEEDED')
      }
      if (
        Math.max(usage.outputTokens, estimatedTokensJson(output?.output)) >
        this.#budget.maxOutputTokens
      ) {
        return this.failure('SEMANTIC_VERIFIER_OUTPUT_TOKENS_EXCEEDED')
      }
      if (usage.costUsd > this.#budget.maxCostUsd) {
        return this.failure('SEMANTIC_VERIFIER_COST_EXCEEDED')
      }
      const result = validateSemanticOutput(output.output, criteria, input.result)
      return result.code === 'SEMANTIC_VERIFIER_SCHEMA_INVALID' ? this.failure(result.code) : result
    } catch (error) {
      if (input.signal?.aborted) return this.failure('SEMANTIC_VERIFIER_CANCELLED')
      const code = semanticErrorCode(error)
      if (code.startsWith('SEMANTIC_VERIFIER_')) return this.failure(code)
      return this.failure(
        deadlineExceeded ? 'SEMANTIC_VERIFIER_DEADLINE_EXCEEDED' : 'SEMANTIC_VERIFIER_MODEL_FAILED',
      )
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  private failure(code: string): VerificationDecisionV1 {
    const retryable = [
      'SEMANTIC_VERIFIER_SCHEMA_INVALID',
      'SEMANTIC_VERIFIER_MODEL_FAILED',
      'SEMANTIC_VERIFIER_DEADLINE_EXCEEDED',
    ].includes(code)
    return decision(
      'model',
      this.#failureStrategy === 'ask_user' ? 'blocked' : 'failed',
      [],
      this.#failureStrategy === 'ask_user' ? `${code}_ASK_USER` : code,
      retryable,
    )
  }
}

export function semanticVerifierUnavailableV1(): VerificationDecisionV1 {
  return decision('model', 'blocked', [], 'SEMANTIC_VERIFIER_NOT_CONFIGURED', false)
}

function decision(
  verifier: VerificationDecisionV1['verifier'],
  status: VerificationDecisionV1['status'],
  evidenceRefs: readonly string[],
  code: string,
  retryable: boolean,
): VerificationDecisionV1 {
  return Object.freeze({
    verifier,
    status,
    evidenceRefs: Object.freeze(unique(evidenceRefs)),
    code,
    retryable,
  })
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function validateSemanticOutput(
  input: unknown,
  criteria: readonly PlanSuccessCriterionV1[],
  result: SubagentResultV1,
): VerificationDecisionV1 {
  if (!recordWithFields(input, ['criteria']) || !Array.isArray(input.criteria)) {
    return semanticInvalid()
  }
  const availableEvidence = new Set([
    ...result.evidenceRefs.map((evidence) => evidence.ref),
    ...result.checks.flatMap((check) =>
      check.evidenceRef === undefined ? [] : [check.evidenceRef],
    ),
  ])
  const expected = new Map(criteria.map((criterion) => [criterion.criterionId, criterion]))
  const seen = new Set<string>()
  const evidenceRefs: string[] = []
  let failed = false
  for (const candidate of input.criteria) {
    if (
      !recordWithFields(candidate, ['criterionId', 'status', 'evidenceRefs']) ||
      typeof candidate.criterionId !== 'string' ||
      seen.has(candidate.criterionId) ||
      !expected.has(candidate.criterionId) ||
      !['passed', 'failed'].includes(String(candidate.status)) ||
      !Array.isArray(candidate.evidenceRefs) ||
      candidate.evidenceRefs.length < 1 ||
      candidate.evidenceRefs.length > 256 ||
      !candidate.evidenceRefs.every(
        (reference) =>
          typeof reference === 'string' &&
          Buffer.byteLength(reference, 'utf8') <= 8 * 1024 &&
          availableEvidence.has(reference),
      ) ||
      new Set(candidate.evidenceRefs).size !== candidate.evidenceRefs.length
    ) {
      return semanticInvalid()
    }
    const criterion = expected.get(candidate.criterionId)!
    if (criterion.ref !== undefined && !candidate.evidenceRefs.includes(criterion.ref)) {
      return semanticInvalid()
    }
    seen.add(candidate.criterionId)
    evidenceRefs.push(...(candidate.evidenceRefs as string[]))
    failed ||= candidate.status === 'failed'
  }
  if (seen.size !== expected.size) return semanticInvalid()
  return decision(
    'model',
    failed ? 'failed' : 'passed',
    evidenceRefs,
    failed ? 'SEMANTIC_CRITERION_FAILED' : 'SEMANTIC_VERIFICATION_PASSED',
    false,
  )
}

function semanticInvalid(): VerificationDecisionV1 {
  return decision('model', 'blocked', [], 'SEMANTIC_VERIFIER_SCHEMA_INVALID', false)
}

function validateSemanticModel(model: SemanticVerifierModelPortV1): void {
  if (
    typeof model !== 'object' ||
    model === null ||
    typeof model.verify !== 'function' ||
    model.identity?.kind !== 'model' ||
    typeof model.identity.id !== 'string' ||
    model.identity.id.length === 0
  ) {
    semanticFail('SEMANTIC_VERIFIER_MODEL_INVALID')
  }
}

function validateSemanticBudget(input: SemanticVerifierBudgetV1): SemanticVerifierBudgetV1 {
  if (
    typeof input !== 'object' ||
    input === null ||
    !positiveInteger(input.maxInputTokens) ||
    !positiveInteger(input.maxOutputTokens) ||
    typeof input.maxCostUsd !== 'number' ||
    !Number.isFinite(input.maxCostUsd) ||
    input.maxCostUsd < 0 ||
    !positiveInteger(input.deadlineMs)
  ) {
    semanticFail('SEMANTIC_VERIFIER_BUDGET_INVALID')
  }
  return Object.freeze({ ...input })
}

function validateSemanticUsage(input: unknown): SemanticVerifierUsageV1 {
  if (
    typeof input !== 'object' ||
    input === null ||
    !nonNegativeInteger(Reflect.get(input, 'inputTokens')) ||
    !nonNegativeInteger(Reflect.get(input, 'outputTokens')) ||
    typeof Reflect.get(input, 'costUsd') !== 'number' ||
    !Number.isFinite(Reflect.get(input, 'costUsd')) ||
    (Reflect.get(input, 'costUsd') as number) < 0
  ) {
    semanticFail('SEMANTIC_VERIFIER_USAGE_INVALID')
  }
  return Object.freeze({
    inputTokens: Reflect.get(input, 'inputTokens') as number,
    outputTokens: Reflect.get(input, 'outputTokens') as number,
    costUsd: Reflect.get(input, 'costUsd') as number,
  })
}

function recordWithFields(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function estimatedTokensJson(value: unknown): number {
  try {
    return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 3)
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('semantic verifier aborted')), {
      once: true,
    })
  })
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function semanticFail(code: string): never {
  throw Object.assign(new Error(code), runtimeError(code, 'planner', code), { code })
}

function semanticErrorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : 'UNKNOWN'
}
