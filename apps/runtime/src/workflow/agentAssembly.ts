import type {
  AgentAssemblyRequestV1,
  AgentHarnessProfileV1,
  AgentModelRequestV1,
  AgentSuccessCriterionRequestV1,
} from '@praxis/core-sdk'
import type { ChildProviderTarget } from '../subagent/childCapabilityBundle.js'

export const AGENT_HARNESS_PROFILES = ['default', 'worker', 'explorer'] as const
export const AGENT_REASONING_EFFORTS = ['none', 'low', 'medium', 'high'] as const
export const AGENT_MODEL_TIERS = ['fast', 'balanced', 'powerful'] as const

const MAX_INSTRUCTIONS_BYTES = 12 * 1024
const MAX_RESULT_SCHEMA_BYTES = 16 * 1024
const MAX_CRITERIA = 16
const MAX_INLINE_BYTES = 8 * 1024
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/

export const AGENT_ASSEMBLY_SCHEMA_PROPERTIES = {
  instructions: {
    type: 'string',
    minLength: 1,
    maxLength: MAX_INSTRUCTIONS_BYTES,
    description: 'Task-specific Child instructions. Runtime constraints remain authoritative.',
  },
  model: {
    type: 'object',
    additionalProperties: false,
    properties: {
      provider: { type: 'string', minLength: 1, maxLength: 128 },
      model: { type: 'string', minLength: 1, maxLength: 128 },
      tier: { enum: AGENT_MODEL_TIERS },
      reasoningEffort: { enum: AGENT_REASONING_EFFORTS },
    },
  },
  result: {
    type: 'object',
    additionalProperties: false,
    required: ['format'],
    properties: {
      format: { enum: ['text', 'markdown', 'json'] },
      schema: { type: 'object' },
      maxInlineBytes: { type: 'integer', minimum: 512, maximum: MAX_INLINE_BYTES },
    },
  },
  successCriteria: {
    type: 'array',
    minItems: 1,
    maxItems: MAX_CRITERIA,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'description'],
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$' },
        description: { type: 'string', minLength: 1, maxLength: 2_048 },
      },
    },
  },
} as const

export type AgentModelCandidateV1 = Readonly<{
  target: ChildProviderTarget
  reasoningLevels: readonly (typeof AGENT_REASONING_EFFORTS)[number][]
  speedRank: number
  powerRank: number
}>

export type AgentAssemblyDenialV1 = Readonly<{
  field: 'provider' | 'model' | 'reasoningEffort' | 'resultSchema'
  reason: 'not_in_parent_scope' | 'not_available' | 'unsupported' | 'invalid'
  requested: string
}>

export type EffectiveAgentAssemblyV1 = Readonly<{
  profile: AgentHarnessProfileV1
  instructions: string
  target: ChildProviderTarget
  modelTier: 'fast' | 'balanced' | 'powerful'
  reasoningEffort: (typeof AGENT_REASONING_EFFORTS)[number]
  reasoningMode: 'default' | 'compact'
  result: Readonly<{
    format: 'text' | 'markdown' | 'json'
    schema: Readonly<Record<string, unknown>>
    maxInlineBytes: number
  }>
  successCriteria: readonly AgentSuccessCriterionRequestV1[]
  denied: readonly AgentAssemblyDenialV1[]
}>

export function parseAgentAssemblyRequestV1(
  input: Readonly<Record<string, unknown>>,
): AgentAssemblyRequestV1 | undefined {
  const instructions = optionalBoundedText(input.instructions, MAX_INSTRUCTIONS_BYTES)
  const model = parseModelRequest(input.model)
  const result = parseResultRequest(input.result)
  const successCriteria = parseSuccessCriteria(input.successCriteria)
  if (
    instructions === undefined &&
    model === undefined &&
    result === undefined &&
    successCriteria === undefined
  ) {
    return undefined
  }
  return deepFreeze({
    ...(instructions === undefined ? {} : { instructions }),
    ...(model === undefined ? {} : { model }),
    ...(result === undefined ? {} : { result }),
    ...(successCriteria === undefined ? {} : { successCriteria }),
  })
}

export function compileAgentAssemblyV1(input: {
  profile: AgentHarnessProfileV1
  request?: AgentAssemblyRequestV1
  parentTarget: ChildProviderTarget
  candidates: readonly AgentModelCandidateV1[]
}): EffectiveAgentAssemblyV1 {
  const denied: AgentAssemblyDenialV1[] = []
  const candidates = uniqueCandidates(input.candidates)
  const fallback =
    candidates.find((candidate) => sameTarget(candidate.target, input.parentTarget)) ??
    candidates[0]
  if (fallback === undefined) throw new TypeError('AGENT_MODEL_CANDIDATES_EMPTY')
  const requested = input.request?.model
  let eligible = candidates
  if (requested?.provider !== undefined && requested.provider !== input.parentTarget.providerId) {
    denied.push({
      field: 'provider',
      reason: 'not_in_parent_scope',
      requested: requested.provider,
    })
  } else if (requested?.provider !== undefined) {
    eligible = candidates.filter(({ target }) => target.providerId === requested.provider)
  }
  let selected: AgentModelCandidateV1 | undefined
  if (requested?.model !== undefined) {
    selected = eligible.find(({ target }) => target.model === requested.model)
    if (selected === undefined) {
      denied.push({ field: 'model', reason: 'not_available', requested: requested.model })
    }
  }
  const tier = requested?.tier ?? 'balanced'
  selected ??= selectTier(eligible, tier, fallback)
  const requestedReasoning = requested?.reasoningEffort ?? defaultReasoning(tier)
  const reasoningEffort = selected.reasoningLevels.includes(requestedReasoning)
    ? requestedReasoning
    : selected.reasoningLevels.includes('none')
      ? 'none'
      : (selected.reasoningLevels[0] ?? 'none')
  if (reasoningEffort !== requestedReasoning) {
    denied.push({
      field: 'reasoningEffort',
      reason: 'unsupported',
      requested: requestedReasoning,
    })
  }
  const result = effectiveResult(input.request?.result, denied)
  const successCriteria = effectiveCriteria(input.request?.successCriteria)
  return deepFreeze({
    profile: input.profile,
    instructions: [profileInstructions(input.profile), input.request?.instructions]
      .filter((value): value is string => value !== undefined)
      .join('\n\n'),
    target: { ...selected.target },
    modelTier: tier,
    reasoningEffort,
    reasoningMode: reasoningEffort === 'none' || reasoningEffort === 'low' ? 'compact' : 'default',
    result,
    successCriteria,
    denied,
  })
}

function parseModelRequest(value: unknown): AgentModelRequestV1 | undefined {
  if (!isRecord(value)) return undefined
  const provider = optionalSafeText(value.provider)
  const model = optionalSafeText(value.model)
  const tier = AGENT_MODEL_TIERS.includes(value.tier as (typeof AGENT_MODEL_TIERS)[number])
    ? (value.tier as (typeof AGENT_MODEL_TIERS)[number])
    : undefined
  const reasoningEffort = AGENT_REASONING_EFFORTS.includes(
    value.reasoningEffort as (typeof AGENT_REASONING_EFFORTS)[number],
  )
    ? (value.reasoningEffort as (typeof AGENT_REASONING_EFFORTS)[number])
    : undefined
  if (
    provider === undefined &&
    model === undefined &&
    tier === undefined &&
    reasoningEffort === undefined
  ) {
    return undefined
  }
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(tier === undefined ? {} : { tier }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

function parseResultRequest(value: unknown): AgentAssemblyRequestV1['result'] | undefined {
  if (!isRecord(value) || !['text', 'markdown', 'json'].includes(String(value.format))) {
    return undefined
  }
  const schema = isRecord(value.schema) ? boundedSchema(value.schema) : undefined
  const maxInlineBytes = Number.isSafeInteger(value.maxInlineBytes)
    ? Math.max(512, Math.min(MAX_INLINE_BYTES, Number(value.maxInlineBytes)))
    : undefined
  return {
    format: value.format as 'text' | 'markdown' | 'json',
    ...(schema === undefined ? {} : { schema }),
    ...(maxInlineBytes === undefined ? {} : { maxInlineBytes }),
  }
}

function parseSuccessCriteria(
  value: unknown,
): readonly AgentSuccessCriterionRequestV1[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = new Set<string>()
  const criteria: AgentSuccessCriterionRequestV1[] = []
  for (const candidate of value.slice(0, MAX_CRITERIA)) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !SAFE_ID.test(candidate.id)) {
      continue
    }
    const description = optionalBoundedText(candidate.description, 2 * 1024)
    if (description === undefined || ids.has(candidate.id)) continue
    ids.add(candidate.id)
    criteria.push({ id: candidate.id, description })
  }
  return criteria.length === 0 ? undefined : deepFreeze(criteria)
}

function effectiveResult(
  request: AgentAssemblyRequestV1['result'],
  denied: AgentAssemblyDenialV1[],
): EffectiveAgentAssemblyV1['result'] {
  const format = request?.format ?? 'json'
  let schema: Readonly<Record<string, unknown>> = { type: 'object' }
  if (request?.schema !== undefined) {
    try {
      schema = boundedSchema(request.schema)
    } catch {
      denied.push({
        field: 'resultSchema',
        reason: 'invalid',
        requested: 'custom-schema',
      })
    }
  }
  return {
    format,
    schema,
    maxInlineBytes: Math.max(512, Math.min(MAX_INLINE_BYTES, request?.maxInlineBytes ?? 8_192)),
  }
}

function effectiveCriteria(
  requested: AgentAssemblyRequestV1['successCriteria'],
): readonly AgentSuccessCriterionRequestV1[] {
  return requested && requested.length > 0
    ? requested
    : [
        {
          id: 'delegated-outcome',
          description: 'Return evidence that directly addresses the delegated objective.',
        },
      ]
}

function selectTier(
  candidates: readonly AgentModelCandidateV1[],
  tier: 'fast' | 'balanced' | 'powerful',
  fallback: AgentModelCandidateV1,
): AgentModelCandidateV1 {
  if (tier === 'balanced') return fallback
  const sorted = [...candidates].sort((left, right) =>
    tier === 'fast' ? left.speedRank - right.speedRank : right.powerRank - left.powerRank,
  )
  return sorted[0] ?? fallback
}

function defaultReasoning(tier: 'fast' | 'balanced' | 'powerful') {
  return tier === 'fast'
    ? ('low' as const)
    : tier === 'powerful'
      ? ('high' as const)
      : ('medium' as const)
}

function profileInstructions(profile: AgentHarnessProfileV1): string {
  if (profile === 'worker') {
    return 'Act as an execution worker: implement or repair the bounded task, inspect before editing, and verify changed behavior.'
  }
  if (profile === 'explorer') {
    return 'Act as a read-oriented explorer: gather precise evidence, follow references, and avoid workspace changes unless the effective grant explicitly permits them.'
  }
  return 'Act as a general-purpose delegated agent and complete the bounded objective with concise evidence.'
}

function boundedSchema(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_SCHEMA_BYTES) {
    throw new TypeError('AGENT_RESULT_SCHEMA_OVERSIZED')
  }
  return deepFreeze(JSON.parse(serialized) as Record<string, unknown>)
}

function optionalBoundedText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (normalized.length === 0 || Buffer.byteLength(normalized, 'utf8') > maxBytes) return undefined
  return normalized
}

function optionalSafeText(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined
}

function uniqueCandidates(candidates: readonly AgentModelCandidateV1[]) {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = `${candidate.target.providerId}\0${candidate.target.model}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function sameTarget(left: ChildProviderTarget, right: ChildProviderTarget): boolean {
  return left.providerId === right.providerId && left.model === right.model
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}
