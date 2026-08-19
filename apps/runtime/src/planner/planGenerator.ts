import { runtimeError } from '@praxis/core-sdk'
import { type FixedPlanProposalV1, validateFixedPlanProposalV1 } from './planValidator.js'

export const PLAN_PROPOSAL_JSON_SCHEMA_V1 = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['execution', 'objective', 'steps'],
  properties: {
    execution: {
      type: 'string',
      enum: ['parent_only', 'dag'],
      description:
        'Use parent_only when the parent can answer without tools or workspace evidence; use dag only when child execution is materially required.',
    },
    objective: { type: 'string', minLength: 1 },
    steps: {
      type: 'array',
      minItems: 0,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'title', 'criteria'],
        properties: {
          key: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          dependencies: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          access: {
            type: 'object',
            description:
              'Bounded workspace access. Paths are portable workspace-relative paths; use "." for the workspace root and never use an absolute path.',
            additionalProperties: false,
            required: ['mode', 'paths'],
            properties: {
              mode: {
                type: 'string',
                enum: ['read_only', 'isolated_process', 'workspace_write'],
                description:
                  'Use isolated_process for commands/tests that must run a process without merging workspace changes.',
              },
              paths: {
                type: 'array',
                items: {
                  type: 'string',
                  minLength: 1,
                  description: 'Portable workspace-relative path, or "." for the root.',
                },
                uniqueItems: true,
              },
            },
          },
          capabilities: {
            type: 'array',
            items: {
              type: 'string',
              description: 'Exact capability name copied from planning context capabilities.',
            },
            uniqueItems: true,
          },
          conflictKeys: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          criteria: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'description'],
              properties: {
                kind: {
                  type: 'string',
                  enum: ['schema', 'file', 'digest', 'command', 'check', 'rule', 'semantic'],
                },
                description: { type: 'string', minLength: 1 },
                ref: { type: 'string', minLength: 1 },
                expectedDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
              },
            },
          },
          budget: {
            type: 'object',
            additionalProperties: false,
            properties: {
              maxTurns: { type: 'integer', minimum: 0 },
              maxToolCalls: { type: 'integer', minimum: 0 },
              maxTokens: { type: 'integer', minimum: 1 },
              deadlineAt: { type: 'string', format: 'date-time' },
            },
          },
          maxAttempts: { type: 'integer', minimum: 1, maximum: 16 },
        },
      },
    },
  },
})

export type PlanGenerationUsageV1 = Readonly<{
  inputTokens: number
  outputTokens: number
  costUsd: number
}>

export type PlanGeneratorModelInputV1 = Readonly<{
  objective: string
  context?: Readonly<Record<string, unknown>>
  responseFormat: Readonly<{
    type: 'json_schema'
    name: 'praxis_plan_proposal_v1'
    strict: true
    schema: typeof PLAN_PROPOSAL_JSON_SCHEMA_V1
  }>
  maxOutputTokens: number
  signal: AbortSignal
}>

export type PlanGeneratorModelOutputV1 = Readonly<{
  output: unknown
  usage: PlanGenerationUsageV1
}>

export interface PlanGeneratorModelPortV1 {
  readonly identity: Readonly<{ kind: 'model'; id: string }>
  generate(input: PlanGeneratorModelInputV1): Promise<PlanGeneratorModelOutputV1>
}

export type PlanGenerationBudgetV1 = Readonly<{
  maxInputTokens: number
  maxOutputTokens: number
  maxCostUsd: number
  deadlineMs: number
  maxSteps: number
  maxDependencies: number
  maxProviderAttempts: number
}>

export type PlanGenerationResultV1 = Readonly<{
  source: 'model' | 'fallback'
  proposal: FixedPlanProposalV1
  usage: PlanGenerationUsageV1
  generatorId: string
  fallbackFromCode?: string
}>

export type PlanGenerationFallbackV1 = (
  objective: string,
) => FixedPlanProposalV1 | Promise<FixedPlanProposalV1>

export type StructuredPlanGeneratorOptionsV1 = Readonly<{
  budget: PlanGenerationBudgetV1
  failureMode?: 'error' | 'fallback'
  fallback?: PlanGenerationFallbackV1
}>

const ZERO_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0, costUsd: 0 })

/**
 * Calls an isolated structured-output model port and returns only an untrusted proposal.
 * Durable IDs, admitted capabilities and execution budgets remain PlanValidator concerns.
 */
export class StructuredPlanGeneratorV1 {
  readonly #model: PlanGeneratorModelPortV1
  readonly #budget: PlanGenerationBudgetV1
  readonly #failureMode: 'error' | 'fallback'
  readonly #fallback?: PlanGenerationFallbackV1

  constructor(model: PlanGeneratorModelPortV1, options: StructuredPlanGeneratorOptionsV1) {
    this.#model = validateModel(model)
    this.#budget = validateBudget(options?.budget)
    this.#failureMode = options.failureMode ?? 'error'
    this.#fallback = options.fallback
    if (this.#failureMode === 'fallback' && this.#fallback === undefined) {
      fail('PLAN_GENERATOR_FALLBACK_MISSING', 'planner')
    }
  }

  async generate(input: {
    objective: string
    context?: Readonly<Record<string, unknown>>
    signal?: AbortSignal
  }): Promise<PlanGenerationResultV1> {
    if (typeof input?.objective !== 'string' || input.objective.length === 0) {
      return this.#recover('PLAN_GENERATOR_INPUT_INVALID', '', ZERO_USAGE)
    }
    if (input.signal?.aborted) fail('PLAN_GENERATOR_CANCELLED', 'cancelled')
    if (
      estimatedTokens(input.objective) +
        (input.context === undefined ? 0 : estimatedTokensJson(input.context)) >
      this.#budget.maxInputTokens
    ) {
      return this.#recover('PLAN_GENERATOR_INPUT_TOKENS_EXCEEDED', input.objective, ZERO_USAGE)
    }

    const controller = new AbortController()
    let deadlineExceeded = false
    const abortFromCaller = (): void => controller.abort('plan_generator_cancelled')
    input.signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timer = setTimeout(() => {
      deadlineExceeded = true
      controller.abort('plan_generator_deadline')
    }, this.#budget.deadlineMs)

    try {
      let output: PlanGeneratorModelOutputV1 | undefined
      for (let attempt = 0; attempt < this.#budget.maxProviderAttempts; attempt += 1) {
        try {
          output = await Promise.race([
            this.#model.generate({
              objective: input.objective,
              ...(input.context === undefined ? {} : { context: input.context }),
              responseFormat: {
                type: 'json_schema',
                name: 'praxis_plan_proposal_v1',
                strict: true,
                schema: PLAN_PROPOSAL_JSON_SCHEMA_V1,
              },
              maxOutputTokens: this.#budget.maxOutputTokens,
              signal: controller.signal,
            }),
            aborted(controller.signal),
          ])
          break
        } catch (error) {
          if (input.signal?.aborted) fail('PLAN_GENERATOR_CANCELLED', 'cancelled')
          if (deadlineExceeded) {
            return this.#recover('PLAN_GENERATOR_DEADLINE_EXCEEDED', input.objective, ZERO_USAGE)
          }
          const code = errorCode(error)
          if (code.startsWith('PLAN_GENERATOR_')) throw error
          const retryDelayMs = providerRetryDelayMs(error, attempt)
          const finalAttempt = attempt + 1 >= this.#budget.maxProviderAttempts
          if (
            finalAttempt ||
            !planProviderRetryable(error) ||
            providerOutputStarted(error) ||
            retryDelayMs >= this.#budget.deadlineMs
          ) {
            return this.#recover(planProviderFailureCode(error), input.objective, ZERO_USAGE)
          }
          await abortableDelay(retryDelayMs, controller.signal)
        }
      }
      if (output === undefined) {
        return this.#recover('PLAN_GENERATOR_PROVIDER_FAILED', input.objective, ZERO_USAGE)
      }
      const usage = validateUsage(output?.usage)
      const outputTokens = Math.max(usage.outputTokens, estimatedTokensJson(output?.output))
      if (usage.inputTokens > this.#budget.maxInputTokens) {
        return this.#recover('PLAN_GENERATOR_INPUT_TOKENS_EXCEEDED', input.objective, usage)
      }
      if (outputTokens > this.#budget.maxOutputTokens) {
        return this.#recover('PLAN_GENERATOR_OUTPUT_TOKENS_EXCEEDED', input.objective, usage)
      }
      if (usage.costUsd > this.#budget.maxCostUsd) {
        return this.#recover('PLAN_GENERATOR_COST_EXCEEDED', input.objective, usage)
      }

      let proposal: FixedPlanProposalV1
      try {
        proposal = validateFixedPlanProposalV1(output.output, {
          maxSteps: this.#budget.maxSteps,
          maxDependencies: this.#budget.maxDependencies,
        })
      } catch {
        return this.#recover('PLAN_GENERATOR_SCHEMA_INVALID', input.objective, usage)
      }
      return Object.freeze({
        source: 'model',
        proposal,
        usage,
        generatorId: this.#model.identity.id,
      })
    } catch (error) {
      if (input.signal?.aborted) fail('PLAN_GENERATOR_CANCELLED', 'cancelled')
      if (deadlineExceeded) {
        return this.#recover('PLAN_GENERATOR_DEADLINE_EXCEEDED', input.objective, ZERO_USAGE)
      }
      const code = errorCode(error)
      if (code.startsWith('PLAN_GENERATOR_')) throw error
      return this.#recover(planProviderFailureCode(error), input.objective, ZERO_USAGE)
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  async #recover(
    code: string,
    objective: string,
    usage: PlanGenerationUsageV1,
  ): Promise<PlanGenerationResultV1> {
    if (this.#failureMode === 'error' || this.#fallback === undefined) fail(code, 'planner')
    let proposal: FixedPlanProposalV1
    try {
      proposal = validateFixedPlanProposalV1(await this.#fallback(objective), {
        maxSteps: this.#budget.maxSteps,
        maxDependencies: this.#budget.maxDependencies,
      })
    } catch {
      fail('PLAN_GENERATOR_FALLBACK_INVALID', 'planner')
    }
    return Object.freeze({
      source: 'fallback',
      proposal,
      usage,
      generatorId: this.#model.identity.id,
      fallbackFromCode: code,
    })
  }
}

export type OfflinePlanFixtureKindV1 = 'inspect' | 'change' | 'verify'

/** Explicit offline fixtures for common tasks; callers choose the task kind without text guessing. */
export function offlinePlanFixtureV1(
  kind: OfflinePlanFixtureKindV1,
  objective: string,
): FixedPlanProposalV1 {
  const definitions: Record<OfflinePlanFixtureKindV1, FixedPlanProposalV1['steps']> = {
    inspect: [
      {
        key: 'inspect',
        title: 'Inspect the requested scope',
        access: { mode: 'read_only', paths: ['.'] },
        capabilities: ['builtin.read'],
        criteria: [{ kind: 'rule', description: 'Requested scope was inspected.' }],
      },
    ],
    change: [
      {
        key: 'inspect',
        title: 'Inspect the requested scope',
        access: { mode: 'read_only', paths: ['.'] },
        capabilities: ['builtin.read'],
        criteria: [{ kind: 'rule', description: 'Relevant inputs were inspected.' }],
      },
      {
        key: 'change',
        title: 'Apply the bounded change',
        dependencies: ['inspect'],
        access: { mode: 'workspace_write', paths: ['.'] },
        capabilities: ['builtin.read', 'builtin.write'],
        conflictKeys: ['workspace'],
        criteria: [{ kind: 'file', description: 'Requested files contain the admitted change.' }],
      },
    ],
    verify: [
      {
        key: 'verify',
        title: 'Run the requested verification',
        access: { mode: 'read_only', paths: ['.'] },
        capabilities: ['builtin.read', 'builtin.command'],
        criteria: [{ kind: 'check', description: 'The requested verification passes.' }],
      },
    ],
  }
  return validateFixedPlanProposalV1({ objective, steps: definitions[kind] })
}

function validateModel(model: PlanGeneratorModelPortV1): PlanGeneratorModelPortV1 {
  if (
    typeof model !== 'object' ||
    model === null ||
    typeof model.generate !== 'function' ||
    model.identity?.kind !== 'model' ||
    typeof model.identity.id !== 'string' ||
    model.identity.id.length === 0
  ) {
    fail('PLAN_GENERATOR_MODEL_INVALID', 'planner')
  }
  return model
}

function validateBudget(input: PlanGenerationBudgetV1): PlanGenerationBudgetV1 {
  if (
    typeof input !== 'object' ||
    input === null ||
    !positiveInteger(input.maxInputTokens) ||
    !positiveInteger(input.maxOutputTokens) ||
    typeof input.maxCostUsd !== 'number' ||
    !Number.isFinite(input.maxCostUsd) ||
    input.maxCostUsd < 0 ||
    !positiveInteger(input.deadlineMs) ||
    !positiveInteger(input.maxSteps) ||
    input.maxSteps > 64 ||
    !nonNegativeInteger(input.maxDependencies) ||
    input.maxDependencies > 32 ||
    !positiveInteger(input.maxProviderAttempts) ||
    input.maxProviderAttempts > 8
  ) {
    fail('PLAN_GENERATOR_BUDGET_INVALID', 'planner')
  }
  return Object.freeze({ ...input })
}

function validateUsage(input: unknown): PlanGenerationUsageV1 {
  if (
    typeof input !== 'object' ||
    input === null ||
    !nonNegativeInteger(Reflect.get(input, 'inputTokens')) ||
    !nonNegativeInteger(Reflect.get(input, 'outputTokens')) ||
    typeof Reflect.get(input, 'costUsd') !== 'number' ||
    !Number.isFinite(Reflect.get(input, 'costUsd')) ||
    (Reflect.get(input, 'costUsd') as number) < 0
  ) {
    fail('PLAN_GENERATOR_USAGE_INVALID', 'provider')
  }
  return Object.freeze({
    inputTokens: Reflect.get(input, 'inputTokens') as number,
    outputTokens: Reflect.get(input, 'outputTokens') as number,
    costUsd: Reflect.get(input, 'costUsd') as number,
  })
}

function estimatedTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 3)
}

function estimatedTokensJson(value: unknown): number {
  try {
    return estimatedTokens(JSON.stringify(value))
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(Object.assign(new Error('PLAN_GENERATOR_ABORTED'), { code: 'ABORT_ERR' })),
      { once: true },
    )
  })
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function errorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : 'UNKNOWN'
}

function planProviderFailureCode(error: unknown): string {
  const status = providerStatus(error)
  if (status === 400 || status === 422) return 'PLAN_GENERATOR_PROVIDER_REQUEST_INVALID'
  if (status === 401 || status === 403) return 'PLAN_GENERATOR_PROVIDER_AUTH_FAILED'
  if (status === 404) return 'PLAN_GENERATOR_MODEL_UNAVAILABLE'
  if (status === 408 || status === 409) return 'PLAN_GENERATOR_PROVIDER_UNAVAILABLE'
  if (status === 429) return 'PLAN_GENERATOR_PROVIDER_RATE_LIMITED'
  if (status !== undefined && status >= 500) return 'PLAN_GENERATOR_PROVIDER_UNAVAILABLE'
  return 'PLAN_GENERATOR_PROVIDER_FAILED'
}

function planProviderRetryable(error: unknown): boolean {
  const status = providerStatus(error)
  return (
    status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)
  )
}

function providerOutputStarted(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'planProviderOutputStarted') === true
  )
}

function providerRetryDelayMs(error: unknown, attempt: number): number {
  const retryAfterMs = providerDataNumber(error, 'retryAfterMs')
  return Math.min(15_000, retryAfterMs ?? 1_000 * 2 ** attempt)
}

function providerStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const direct = Reflect.get(error, 'status')
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct
  const data = Reflect.get(error, 'data')
  if (typeof data === 'object' && data !== null) {
    const nested = Reflect.get(data, 'status')
    if (typeof nested === 'number' && Number.isFinite(nested)) return nested
  }
  return providerStatus(Reflect.get(error, 'cause'))
}

function providerDataNumber(error: unknown, key: string): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const data = Reflect.get(error, 'data')
  if (typeof data === 'object' && data !== null) {
    const value = Reflect.get(data, key)
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return providerDataNumber(Reflect.get(error, 'cause'), key)
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Planner retry was cancelled.'))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Planner retry was cancelled.'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function fail(code: string, category: 'planner' | 'provider' | 'cancelled'): never {
  throw Object.assign(new Error(code), runtimeError(code, category, code), { code })
}
