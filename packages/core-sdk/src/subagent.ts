import { runtimeError, type BudgetUsage, type CancellationReason } from './contracts.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/

export type SubagentVersionedRefV1 = Readonly<{
  schemaVersion: 1
  kind: 'context_packet' | 'bootstrap_profile' | 'capability_bundle' | 'execution_budget'
  id: string
  version: number
  digest: `sha256:${string}`
}>

export type SubagentExecutionRequestV1 = Readonly<{
  schemaVersion: 1
  parentRunId: string
  childRunId: string
  packetRef: SubagentVersionedRefV1
  profileRef: SubagentVersionedRefV1
  bundleRef: SubagentVersionedRefV1
  budgetRef: SubagentVersionedRefV1
}>

export type SubagentCancellationRequestV1 = Readonly<{
  schemaVersion: 1
  parentRunId: string
  childRunId: string
  reason: CancellationReason
}>

export type SubagentEvidenceRefV1 = Readonly<{
  kind: 'file' | 'artifact' | 'result' | 'check'
  ref: string
  digest: `sha256:${string}`
  mediaType?: string
  summary?: string
}>

export type SubagentChangedFileV1 = Readonly<{
  path: string
  change: 'created' | 'modified' | 'deleted'
  digest?: `sha256:${string}`
}>

export type SubagentCheckV1 = Readonly<{
  id: string
  status: 'passed' | 'failed' | 'skipped'
  summary: string
  evidenceRef?: string
}>

export type SubagentStructuredErrorV1 = Readonly<{
  code: string
  category: 'validation' | 'execution' | 'cancellation' | 'protocol'
  message: string
  retryable: boolean
}>

export type SubagentResultV1 = Readonly<{
  schemaVersion: 1
  childRunId: string
  status: 'succeeded' | 'failed' | 'cancelled'
  summary: string
  evidenceRefs: readonly SubagentEvidenceRefV1[]
  changedFiles: readonly SubagentChangedFileV1[]
  checks: readonly SubagentCheckV1[]
  usage: Readonly<BudgetUsage>
  retryable: boolean
  error?: SubagentStructuredErrorV1
}>

/** Planner-facing child execution boundary. Implementations own materialization and process details. */
export interface SubagentExecutor {
  execute(request: SubagentExecutionRequestV1): Promise<SubagentResultV1>
  cancel(request: SubagentCancellationRequestV1): Promise<boolean>
}

export function validateSubagentExecutionRequestV1(input: unknown): SubagentExecutionRequestV1 {
  if (
    !isExactRecord(input, [
      'schemaVersion',
      'parentRunId',
      'childRunId',
      'packetRef',
      'profileRef',
      'bundleRef',
      'budgetRef',
    ]) ||
    input.schemaVersion !== 1 ||
    !safeId(input.parentRunId) ||
    !safeId(input.childRunId) ||
    input.parentRunId === input.childRunId
  ) {
    throw invalidExecutorRequest('SUBAGENT_EXECUTOR_REQUEST_INVALID')
  }
  const packetRef = versionedRef(input.packetRef, 'context_packet', 1)
  const profileRef = versionedRef(input.profileRef, 'bootstrap_profile', 3)
  const bundleRef = versionedRef(input.bundleRef, 'capability_bundle', 1)
  const budgetRef = versionedRef(input.budgetRef, 'execution_budget', 1)
  return Object.freeze({
    schemaVersion: 1,
    parentRunId: input.parentRunId,
    childRunId: input.childRunId,
    packetRef,
    profileRef,
    bundleRef,
    budgetRef,
  })
}

export function validateSubagentCancellationRequestV1(
  input: unknown,
): SubagentCancellationRequestV1 {
  if (
    !isExactRecord(input, ['schemaVersion', 'parentRunId', 'childRunId', 'reason']) ||
    input.schemaVersion !== 1 ||
    !safeId(input.parentRunId) ||
    !safeId(input.childRunId) ||
    input.parentRunId === input.childRunId ||
    !CANCELLATION_REASONS.has(input.reason as CancellationReason)
  ) {
    throw invalidExecutorRequest('SUBAGENT_EXECUTOR_CANCEL_INVALID')
  }
  return Object.freeze({
    schemaVersion: 1,
    parentRunId: input.parentRunId,
    childRunId: input.childRunId,
    reason: input.reason as CancellationReason,
  })
}

function versionedRef(
  input: unknown,
  kind: SubagentVersionedRefV1['kind'],
  version: number,
): SubagentVersionedRefV1 {
  if (
    !isExactRecord(input, ['schemaVersion', 'kind', 'id', 'version', 'digest']) ||
    input.schemaVersion !== 1 ||
    input.kind !== kind ||
    !safeId(input.id) ||
    input.version !== version ||
    typeof input.digest !== 'string' ||
    !SHA256.test(input.digest)
  ) {
    throw invalidExecutorRequest('SUBAGENT_EXECUTOR_REQUEST_INVALID')
  }
  return Object.freeze({
    schemaVersion: 1,
    kind,
    id: input.id,
    version,
    digest: input.digest as `sha256:${string}`,
  })
}

const CANCELLATION_REASONS = new Set<CancellationReason>([
  'user_abort',
  'deadline_exceeded',
  'budget_exhausted',
  'parent_cancelled',
  'plugin_failure',
  'runtime_shutdown',
])

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string') ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    return false
  }
  return ownKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && 'value' in descriptor
  })
}

function invalidExecutorRequest(
  code: 'SUBAGENT_EXECUTOR_REQUEST_INVALID' | 'SUBAGENT_EXECUTOR_CANCEL_INVALID',
): Error {
  const message = 'The Planner-facing subagent request is invalid.'
  return Object.assign(new Error(message), runtimeError(code, 'subagent', message))
}
