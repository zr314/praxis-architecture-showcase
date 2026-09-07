import { runtimeError } from './contracts.js'
import { canonicalDigestV1 } from './canonical-json.js'
import type { WorkflowNodeSpecV1 } from './workflow.js'
import type { VersionedWorkflowRefV1, WorkflowTaskKindV1 } from './workflow-types.js'

export type PlanExecutionBindingV1 = Readonly<{
  sessionId: string
  planId: string
  planRevision: number
  itemId: string
  itemAttemptId: string
  requestId: string
}>

export type ReviewPlanExecutionRequestV1 = PlanExecutionBindingV1 &
  Readonly<{
    workflowId: string
    inputDigest: `sha256:${string}`
  }>

export type WorkflowTaskSpecV1 = Readonly<{
  schemaVersion: 1
  node: WorkflowNodeSpecV1
  kind: WorkflowTaskKindV1
  profileRef?: VersionedWorkflowRefV1
  payload: Readonly<Record<string, unknown>>
  priority: number
  readyAt: string
  deadlineAt: string
  conflictKeys: readonly string[]
}>

export function workflowTaskRequestDigestV1(input: {
  request: ReviewPlanExecutionRequestV1
  taskSpec: WorkflowTaskSpecV1
}): `sha256:${string}` {
  validatePlanExecutionBindingV1({
    sessionId: input.request.sessionId,
    planId: input.request.planId,
    planRevision: input.request.planRevision,
    itemId: input.request.itemId,
    itemAttemptId: input.request.itemAttemptId,
    requestId: input.request.requestId,
  })
  if (
    !safeId(input.request.workflowId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.request.inputDigest) ||
    input.taskSpec.schemaVersion !== 1 ||
    !Number.isSafeInteger(input.taskSpec.priority) ||
    !timestamp(input.taskSpec.readyAt) ||
    !timestamp(input.taskSpec.deadlineAt) ||
    !Array.isArray(input.taskSpec.conflictKeys) ||
    input.taskSpec.conflictKeys.some((key) => !safeId(key))
  ) {
    throw runtimeError(
      'WORKFLOW_TASK_REQUEST_INVALID',
      'planner',
      'Workflow task request is invalid.',
    )
  }
  return canonicalDigestV1(input)
}

export function validatePlanExecutionBindingV1(input: unknown): PlanExecutionBindingV1 {
  if (!isRecord(input) || !onlyKeys(input, BINDING_KEYS)) invalid()
  if (
    !safeId(input.sessionId) ||
    !safeId(input.planId) ||
    !positiveInteger(input.planRevision) ||
    !safeId(input.itemId) ||
    !safeId(input.itemAttemptId) ||
    !safeId(input.requestId)
  ) {
    invalid()
  }
  return Object.freeze(structuredClone(input)) as PlanExecutionBindingV1
}

const BINDING_KEYS = [
  'sessionId',
  'planId',
  'planRevision',
  'itemId',
  'itemAttemptId',
  'requestId',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  )
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u.test(value)
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function invalid(): never {
  throw runtimeError(
    'PLAN_EXECUTION_BINDING_INVALID',
    'planner',
    'Plan execution binding is invalid.',
  )
}
