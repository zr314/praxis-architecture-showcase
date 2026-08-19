import { isAbsolute, resolve } from 'node:path'
import {
  type BudgetUsage,
  type ExecutionBudget,
  runtimeError,
  type SubagentChangedFileV1,
  type SubagentCheckV1,
  type SubagentEvidenceRefV1,
  type SubagentResultV1,
  type SubagentStructuredErrorV1,
} from '@praxis/core-sdk'
import type {
  ChildCapabilityBundleV1,
  ChildProviderTarget,
  ChildWorkspaceAccess,
} from './childCapabilityBundle.js'

export type {
  SubagentChangedFileV1,
  SubagentCheckV1,
  SubagentEvidenceRefV1,
  SubagentResultV1,
  SubagentStructuredErrorV1,
} from '@praxis/core-sdk'

export const CONTEXT_PACKET_MAX_BYTES = 40 * 1024
export const SUBAGENT_RESULT_MAX_BYTES = 32 * 1024
export const SUBAGENT_SUMMARY_MAX_BYTES = 8 * 1024
export const SUBAGENT_RESULT_MAX_EVIDENCE_REFS = 64

const OUTPUT_SCHEMA_MAX_BYTES = 16 * 1024
const MAX_ARRAY_ITEMS = 64
const MAX_JSON_DEPTH = 24
const MAX_JSON_NODES = 2_048
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const BUNDLE_DIGEST_PATTERN = /^[a-f0-9]{64}$/
const RESOURCE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]
export type JsonObject = Readonly<{ [key: string]: JsonValue }>

export type ContextReferenceV1 = Readonly<{
  kind: 'file' | 'artifact' | 'result'
  ref: string
  digest: `sha256:${string}`
  summary?: string
}>

export type ContextSuccessCriterionV1 = Readonly<{
  id: string
  description: string
}>

export type ContextPacketV1 = Readonly<{
  schemaVersion: 1
  packetId: string
  parentRunId: string
  childRunId: string
  objective: string
  step: Readonly<{ stepId: string; title: string; instructions: string }>
  constraints: readonly string[]
  relevantRefs: readonly ContextReferenceV1[]
  successCriteria: readonly ContextSuccessCriterionV1[]
  workspace: Readonly<{ root: string; access: ChildWorkspaceAccess }>
  grant: Readonly<{
    bundleId: string
    bundleDigest: string
    provider: ChildProviderTarget
    tools: readonly string[]
    skills: readonly string[]
    methods: readonly string[]
    mcpMode: 'disabled' | 'parent_broker' | 'child_launch'
  }>
  budget: Readonly<ExecutionBudget>
  prohibitions: readonly string[]
  outputSchema: Readonly<{
    format: 'json'
    schema: JsonObject
    maxInlineBytes: number
    overflow: 'artifact_ref'
  }>
}>

export type CreateSubagentResultV1Input = Omit<SubagentResultV1, 'schemaVersion'>

export type SubagentContractFailureCode =
  | 'SUBAGENT_CONTEXT_PACKET_INVALID'
  | 'SUBAGENT_CONTEXT_PACKET_VERSION_UNSUPPORTED'
  | 'SUBAGENT_CONTEXT_PACKET_OVERSIZED'
  | 'SUBAGENT_CONTEXT_PACKET_AUTHORITY_MISMATCH'
  | 'SUBAGENT_RESULT_INVALID'
  | 'SUBAGENT_RESULT_VERSION_UNSUPPORTED'
  | 'SUBAGENT_RESULT_OVERSIZED'

export function validateContextPacketV1(input: unknown): ContextPacketV1 {
  if (!isRecord(input)) throw contractFailure('SUBAGENT_CONTEXT_PACKET_INVALID')
  if (input.schemaVersion !== 1) {
    throw contractFailure('SUBAGENT_CONTEXT_PACKET_VERSION_UNSUPPORTED')
  }
  assertSerializedBound(
    input,
    CONTEXT_PACKET_MAX_BYTES,
    'SUBAGENT_CONTEXT_PACKET_OVERSIZED',
    'SUBAGENT_CONTEXT_PACKET_INVALID',
  )
  if (
    !isExactRecord(input, [
      'schemaVersion',
      'packetId',
      'parentRunId',
      'childRunId',
      'objective',
      'step',
      'constraints',
      'relevantRefs',
      'successCriteria',
      'workspace',
      'grant',
      'budget',
      'prohibitions',
      'outputSchema',
    ])
  ) {
    throw contractFailure('SUBAGENT_CONTEXT_PACKET_INVALID')
  }

  const packet = {
    schemaVersion: 1 as const,
    packetId: safeId(input.packetId),
    parentRunId: safeId(input.parentRunId),
    childRunId: safeId(input.childRunId),
    objective: boundedString(input.objective, 8 * 1024),
    step: validateStep(input.step),
    constraints: validateStringList(input.constraints),
    relevantRefs: validateContextReferences(input.relevantRefs),
    successCriteria: validateSuccessCriteria(input.successCriteria),
    workspace: validateWorkspace(input.workspace),
    grant: validateGrant(input.grant),
    budget: validateBudget(input.budget),
    prohibitions: validateStringList(input.prohibitions),
    outputSchema: validateOutputSchema(input.outputSchema),
  }
  return deepFreeze(packet)
}

export function renderContextPacketPrompt(input: ContextPacketV1): string {
  const packet = validateContextPacketV1(input)
  return [
    'Execute the bounded task described by the Praxis context packet.',
    'Use only the declared workspace, grant, budget, and constraints.',
    'Return exactly one complete result envelope matching outputSchema.',
    'When the Runtime exposes praxis_submit_child_result, finish by calling that Tool exactly once with the complete envelope as its arguments. Do not print the envelope as prose; the Tool call is the result commit point.',
    'outputSchema.maxInlineBytes is a parent transport threshold, not a generation limit. Do not compress, retry, or repeat a completed result merely to fit it; the parent Runtime will durably store oversized output and substitute artifact evidence after completion.',
    'For every successCriteria item, copy its id exactly into one criteria result. Do not invent, rename, omit, or duplicate criterion IDs.',
    '--- PRAXIS_CONTEXT_PACKET_V1 ---',
    canonicalJson(packet),
    '--- END_PRAXIS_CONTEXT_PACKET_V1 ---',
  ].join('\n')
}

export function assertContextPacketAuthority(
  input: ContextPacketV1,
  authority: Readonly<{
    workspace: Readonly<{ root: string; access: ChildWorkspaceAccess }>
    provider: ChildProviderTarget
    capabilityBundle: ChildCapabilityBundleV1
  }>,
): ContextPacketV1 {
  const packet = validateContextPacketV1(input)
  const bundle = authority.capabilityBundle
  if (
    packet.workspace.root !== resolve(authority.workspace.root) ||
    packet.workspace.access !== authority.workspace.access ||
    packet.grant.bundleId !== bundle.bundleId ||
    packet.grant.bundleDigest !== bundle.digest ||
    packet.grant.provider.providerId !== authority.provider.providerId ||
    packet.grant.provider.model !== authority.provider.model ||
    packet.grant.provider.providerId !== bundle.provider.target.providerId ||
    packet.grant.provider.model !== bundle.provider.target.model ||
    !sameStrings(
      packet.grant.tools,
      bundle.tools.map((tool) => tool.name),
    ) ||
    !sameStrings(
      packet.grant.skills,
      bundle.skills.map((skill) => skill.id),
    ) ||
    !sameStrings(packet.grant.methods, bundle.methodAllowlist) ||
    packet.grant.mcpMode !== bundle.mcp.mode
  ) {
    throw contractFailure('SUBAGENT_CONTEXT_PACKET_AUTHORITY_MISMATCH')
  }
  return packet
}

export function createSubagentResultV1(input: CreateSubagentResultV1Input): SubagentResultV1 {
  return validateSubagentResultV1({ schemaVersion: 1, ...input })
}

export function validateSubagentResultV1(input: unknown): SubagentResultV1 {
  if (!isRecord(input)) throw contractFailure('SUBAGENT_RESULT_INVALID')
  if (input.schemaVersion !== 1) {
    throw contractFailure('SUBAGENT_RESULT_VERSION_UNSUPPORTED')
  }
  assertSerializedBound(
    input,
    SUBAGENT_RESULT_MAX_BYTES,
    'SUBAGENT_RESULT_OVERSIZED',
    'SUBAGENT_RESULT_INVALID',
  )
  if (
    !isExactRecord(
      input,
      [
        'schemaVersion',
        'childRunId',
        'status',
        'summary',
        'evidenceRefs',
        'changedFiles',
        'checks',
        'usage',
        'retryable',
      ],
      ['error'],
    )
  ) {
    throw contractFailure('SUBAGENT_RESULT_INVALID')
  }
  const status = terminalStatus(input.status)
  const retryable = booleanValue(input.retryable)
  const error = input.error === undefined ? undefined : validateStructuredError(input.error)
  if (
    (status === 'succeeded' && (error !== undefined || retryable)) ||
    (status !== 'succeeded' && (error === undefined || error.retryable !== retryable)) ||
    (status === 'cancelled' && error?.category !== 'cancellation')
  ) {
    throw contractFailure('SUBAGENT_RESULT_INVALID')
  }
  const result = {
    schemaVersion: 1 as const,
    childRunId: resultSafeId(input.childRunId),
    status,
    summary: boundedResultString(input.summary, SUBAGENT_SUMMARY_MAX_BYTES),
    evidenceRefs: validateEvidenceRefs(input.evidenceRefs),
    changedFiles: validateChangedFiles(input.changedFiles),
    checks: validateChecks(input.checks),
    usage: validateUsage(input.usage),
    retryable,
    ...(error === undefined ? {} : { error }),
  }
  return deepFreeze(result)
}

function validateStep(value: unknown): ContextPacketV1['step'] {
  if (!isExactRecord(value, ['stepId', 'title', 'instructions'])) throw packetInvalid()
  return {
    stepId: safeId(value.stepId),
    title: boundedString(value.title, 1_024),
    instructions: boundedString(value.instructions, 12 * 1024),
  }
}

function validateContextReferences(value: unknown): readonly ContextReferenceV1[] {
  return validateArray(value, (entry) => {
    if (!isExactRecord(entry, ['kind', 'ref', 'digest'], ['summary'])) throw packetInvalid()
    if (!['file', 'artifact', 'result'].includes(String(entry.kind))) throw packetInvalid()
    return {
      kind: entry.kind as ContextReferenceV1['kind'],
      ref: boundedString(entry.ref, 1_024),
      digest: resourceDigest(entry.digest),
      ...(entry.summary === undefined ? {} : { summary: boundedString(entry.summary, 1_024) }),
    }
  })
}

function validateSuccessCriteria(value: unknown): readonly ContextSuccessCriterionV1[] {
  const criteria = validateArray(value, (entry) => {
    if (!isExactRecord(entry, ['id', 'description'])) throw packetInvalid()
    return {
      id: safeId(entry.id),
      description: boundedString(entry.description, 2 * 1024),
    }
  })
  if (criteria.length === 0 || hasDuplicate(criteria.map((item) => item.id))) throw packetInvalid()
  return criteria
}

function validateWorkspace(value: unknown): ContextPacketV1['workspace'] {
  if (!isExactRecord(value, ['root', 'access'])) throw packetInvalid()
  if (
    typeof value.root !== 'string' ||
    !isAbsolute(value.root) ||
    (value.access !== 'read_only' &&
      value.access !== 'isolated_process' &&
      value.access !== 'workspace_write')
  ) {
    throw packetInvalid()
  }
  return { root: resolve(value.root), access: value.access }
}

function validateGrant(value: unknown): ContextPacketV1['grant'] {
  if (
    !isExactRecord(value, [
      'bundleId',
      'bundleDigest',
      'provider',
      'tools',
      'skills',
      'methods',
      'mcpMode',
    ])
  ) {
    throw packetInvalid()
  }
  if (
    typeof value.bundleDigest !== 'string' ||
    !BUNDLE_DIGEST_PATTERN.test(value.bundleDigest) ||
    !['disabled', 'parent_broker', 'child_launch'].includes(String(value.mcpMode))
  ) {
    throw packetInvalid()
  }
  if (!isExactRecord(value.provider, ['providerId', 'model'])) throw packetInvalid()
  const tools = validateIdList(value.tools)
  const skills = validateIdList(value.skills)
  const methods = validateIdList(value.methods)
  return {
    bundleId: safeId(value.bundleId),
    bundleDigest: value.bundleDigest,
    provider: {
      providerId: safeId(value.provider.providerId),
      model: safeId(value.provider.model),
    },
    tools,
    skills,
    methods,
    mcpMode: value.mcpMode as ContextPacketV1['grant']['mcpMode'],
  }
}

function validateBudget(value: unknown): Readonly<ExecutionBudget> {
  if (
    !isExactRecord(
      value,
      ['maxTurns', 'maxToolCalls', 'maxChildRuns', 'maxParallelChildren', 'maxDepth'],
      ['maxTokens', 'deadlineAt'],
    ) ||
    !positiveInteger(value.maxTurns) ||
    !nonNegativeInteger(value.maxToolCalls) ||
    !nonNegativeInteger(value.maxChildRuns) ||
    !nonNegativeInteger(value.maxParallelChildren) ||
    !nonNegativeInteger(value.maxDepth) ||
    (value.maxTokens !== undefined && !positiveInteger(value.maxTokens)) ||
    value.maxParallelChildren > value.maxChildRuns
  ) {
    throw packetInvalid()
  }
  const deadlineAt =
    value.deadlineAt === undefined ? undefined : canonicalTimestamp(value.deadlineAt)
  return {
    maxTurns: value.maxTurns,
    maxToolCalls: value.maxToolCalls,
    ...(value.maxTokens === undefined ? {} : { maxTokens: value.maxTokens }),
    maxChildRuns: value.maxChildRuns,
    maxParallelChildren: value.maxParallelChildren,
    maxDepth: value.maxDepth,
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  }
}

function validateOutputSchema(value: unknown): ContextPacketV1['outputSchema'] {
  if (!isExactRecord(value, ['format', 'schema', 'maxInlineBytes', 'overflow'])) {
    throw packetInvalid()
  }
  if (
    value.format !== 'json' ||
    value.overflow !== 'artifact_ref' ||
    !positiveInteger(value.maxInlineBytes) ||
    value.maxInlineBytes > SUBAGENT_SUMMARY_MAX_BYTES ||
    !isRecord(value.schema)
  ) {
    throw packetInvalid()
  }
  assertSerializedBound(
    value.schema,
    OUTPUT_SCHEMA_MAX_BYTES,
    'SUBAGENT_CONTEXT_PACKET_OVERSIZED',
    'SUBAGENT_CONTEXT_PACKET_INVALID',
  )
  const schema = cloneJsonObject(value.schema)
  return {
    format: 'json',
    schema,
    maxInlineBytes: value.maxInlineBytes,
    overflow: 'artifact_ref',
  }
}

function validateEvidenceRefs(value: unknown): readonly SubagentEvidenceRefV1[] {
  return validateResultArray(
    value,
    (entry) => {
      if (!isExactRecord(entry, ['kind', 'ref', 'digest'], ['mediaType', 'summary'])) {
        throw resultInvalid()
      }
      if (!['file', 'artifact', 'result', 'check'].includes(String(entry.kind))) {
        throw resultInvalid()
      }
      return {
        kind: entry.kind as SubagentEvidenceRefV1['kind'],
        ref: boundedResultString(entry.ref, 1_024),
        digest: resultResourceDigest(entry.digest),
        ...(entry.mediaType === undefined
          ? {}
          : { mediaType: boundedResultString(entry.mediaType, 256) }),
        ...(entry.summary === undefined
          ? {}
          : { summary: boundedResultString(entry.summary, 1_024) }),
      }
    },
    SUBAGENT_RESULT_MAX_EVIDENCE_REFS,
  )
}

function validateChangedFiles(value: unknown): readonly SubagentChangedFileV1[] {
  return validateResultArray(value, (entry) => {
    if (!isExactRecord(entry, ['path', 'change'], ['digest'])) throw resultInvalid()
    if (!['created', 'modified', 'deleted'].includes(String(entry.change))) throw resultInvalid()
    return {
      path: boundedResultString(entry.path, 1_024),
      change: entry.change as SubagentChangedFileV1['change'],
      ...(entry.digest === undefined ? {} : { digest: resultResourceDigest(entry.digest) }),
    }
  })
}

function validateChecks(value: unknown): readonly SubagentCheckV1[] {
  const checks = validateResultArray(value, (entry) => {
    if (!isExactRecord(entry, ['id', 'status', 'summary'], ['evidenceRef'])) {
      throw resultInvalid()
    }
    if (!['passed', 'failed', 'skipped'].includes(String(entry.status))) throw resultInvalid()
    return {
      id: resultSafeId(entry.id),
      status: entry.status as SubagentCheckV1['status'],
      summary: boundedResultString(entry.summary, 2 * 1024),
      ...(entry.evidenceRef === undefined
        ? {}
        : { evidenceRef: boundedResultString(entry.evidenceRef, 1_024) }),
    }
  })
  if (hasDuplicate(checks.map((item) => item.id))) throw resultInvalid()
  return checks
}

function validateUsage(value: unknown): Readonly<BudgetUsage> {
  if (
    !isExactRecord(
      value,
      ['turns', 'toolCalls', 'subagents'],
      ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd'],
    ) ||
    !nonNegativeInteger(value.turns) ||
    !nonNegativeInteger(value.toolCalls) ||
    !nonNegativeInteger(value.subagents) ||
    !optionalNonNegativeInteger(value.inputTokens) ||
    !optionalNonNegativeInteger(value.outputTokens) ||
    !optionalNonNegativeInteger(value.cacheReadTokens) ||
    !optionalNonNegativeInteger(value.cacheWriteTokens) ||
    (value.costUsd !== undefined &&
      (typeof value.costUsd !== 'number' || !Number.isFinite(value.costUsd) || value.costUsd < 0))
  ) {
    throw resultInvalid()
  }
  return {
    turns: value.turns,
    toolCalls: value.toolCalls,
    ...(value.inputTokens === undefined ? {} : { inputTokens: value.inputTokens as number }),
    ...(value.outputTokens === undefined ? {} : { outputTokens: value.outputTokens as number }),
    ...(value.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: value.cacheReadTokens as number }),
    ...(value.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: value.cacheWriteTokens as number }),
    ...(value.costUsd === undefined ? {} : { costUsd: value.costUsd }),
    subagents: value.subagents,
  }
}

function validateStructuredError(value: unknown): SubagentStructuredErrorV1 {
  if (!isExactRecord(value, ['code', 'category', 'message', 'retryable'])) {
    throw resultInvalid()
  }
  if (!['validation', 'execution', 'cancellation', 'protocol'].includes(String(value.category))) {
    throw resultInvalid()
  }
  return {
    code: resultSafeId(value.code),
    category: value.category as SubagentStructuredErrorV1['category'],
    message: boundedResultString(value.message, 2 * 1024),
    retryable: booleanValue(value.retryable),
  }
}

function terminalStatus(value: unknown): SubagentResultV1['status'] {
  if (value === 'succeeded' || value === 'failed' || value === 'cancelled') return value
  throw resultInvalid()
}

function cloneJsonObject(value: Record<string, unknown>): JsonObject {
  const state = { nodes: 0 }
  return cloneJsonValue(value, 0, state) as JsonObject
}

function cloneJsonValue(value: unknown, depth: number, state: { nodes: number }): JsonValue {
  state.nodes += 1
  if (depth > MAX_JSON_DEPTH || state.nodes > MAX_JSON_NODES) throw packetInvalid()
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw packetInvalid()
    return value.map((item) => cloneJsonValue(item, depth + 1, state))
  }
  if (!isRecord(value)) throw packetInvalid()
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (!key || Buffer.byteLength(key, 'utf8') > 256) throw packetInvalid()
      return [key, cloneJsonValue(entry, depth + 1, state)]
    }),
  )
}

function validateStringList(value: unknown): readonly string[] {
  return validateArray(value, (entry) => boundedString(entry, 2 * 1024))
}

function validateIdList(value: unknown): readonly string[] {
  const entries = validateArray(value, safeId)
  if (hasDuplicate(entries)) throw packetInvalid()
  return entries
}

function validateArray<T>(value: unknown, validate: (entry: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) throw packetInvalid()
  return value.map(validate)
}

function validateResultArray<T>(
  value: unknown,
  validate: (entry: unknown) => T,
  maxItems = MAX_ARRAY_ITEMS,
): readonly T[] {
  if (!Array.isArray(value) || value.length > maxItems) throw resultInvalid()
  return value.map(validate)
}

function safeId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw packetInvalid()
  return value
}

function resultSafeId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw resultInvalid()
  return value
}

function boundedString(value: unknown, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw packetInvalid()
  }
  return value
}

function boundedResultString(value: unknown, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw resultInvalid()
  }
  return value
}

function resourceDigest(value: unknown): `sha256:${string}` {
  if (typeof value !== 'string' || !RESOURCE_DIGEST_PATTERN.test(value)) throw packetInvalid()
  return value as `sha256:${string}`
}

function resultResourceDigest(value: unknown): `sha256:${string}` {
  if (typeof value !== 'string' || !RESOURCE_DIGEST_PATTERN.test(value)) throw resultInvalid()
  return value as `sha256:${string}`
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw packetInvalid()
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw packetInvalid()
  }
  return value
}

function assertSerializedBound(
  value: unknown,
  maxBytes: number,
  oversized: SubagentContractFailureCode,
  invalid: SubagentContractFailureCode,
): void {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw contractFailure(invalid)
  }
  if (serialized === undefined) throw contractFailure(invalid)
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw contractFailure(oversized)
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  )
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    return Object.freeze(value)
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry)
    return Object.freeze(value)
  }
  return value
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || nonNegativeInteger(value)
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') throw resultInvalid()
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isExactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key))
}

function packetInvalid(): Error {
  return contractFailure('SUBAGENT_CONTEXT_PACKET_INVALID')
}

function resultInvalid(): Error {
  return contractFailure('SUBAGENT_RESULT_INVALID')
}

function contractFailure(code: SubagentContractFailureCode): Error {
  const messages: Record<SubagentContractFailureCode, string> = {
    SUBAGENT_CONTEXT_PACKET_INVALID: 'The subagent context packet is invalid.',
    SUBAGENT_CONTEXT_PACKET_VERSION_UNSUPPORTED:
      'The subagent context packet version is unsupported.',
    SUBAGENT_CONTEXT_PACKET_OVERSIZED: 'The subagent context packet exceeds its size limit.',
    SUBAGENT_CONTEXT_PACKET_AUTHORITY_MISMATCH:
      'The subagent context packet does not match its launch authority.',
    SUBAGENT_RESULT_INVALID: 'The subagent result is invalid.',
    SUBAGENT_RESULT_VERSION_UNSUPPORTED: 'The subagent result version is unsupported.',
    SUBAGENT_RESULT_OVERSIZED: 'The subagent result exceeds its size limit.',
  }
  return Object.assign(
    new Error(messages[code]),
    runtimeError(code, 'subagent', messages[code], undefined, false),
  )
}
