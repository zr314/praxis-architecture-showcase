import { canonicalJsonV1 } from './canonical-json.js'
import { runtimeError } from './contracts.js'

/** Model-owned working memory, never an execution permission or acceptance certificate. */
export type WorkingPlanV1 = Readonly<{
  schemaVersion: 1
  planId: string
  revision: number
  objective: string
  state: 'active' | 'done' | 'abandoned'
  items: readonly Readonly<{
    id: string
    title: string
    status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped'
  }>[]
}>

export type WorkingReviewV1 = Readonly<{
  reviewRequestId: string
  operationId: string
  inputDigest: string
  inputRef: string
  requestDigest: string
  planRevision: number | null
  snapshotSequence: number
  evidenceSequence: number
  reportRef?: string
  verdict?: 'accepted' | 'needs_fix' | 'replan' | 'blocked' | 'unavailable'
}>

export function validateWorkingPlanV1(value: unknown): WorkingPlanV1 {
  const p = object(value)
  exact(p, ['schemaVersion', 'planId', 'revision', 'objective', 'state', 'items'])
  if (p.schemaVersion !== 1 || !positive(p.revision)) invalid()
  id(p.planId)
  text(p.objective)
  if (!['active', 'done', 'abandoned'].includes(String(p.state)) || !Array.isArray(p.items))
    invalid()
  const seen = new Set<string>()
  for (const value of p.items) {
    const item = object(value)
    exact(item, ['id', 'title', 'status'])
    id(item.id)
    text(item.title)
    if (seen.has(String(item.id))) invalid()
    seen.add(String(item.id))
    if (!['pending', 'in_progress', 'done', 'blocked', 'skipped'].includes(String(item.status)))
      invalid()
  }
  return structuredClone(p) as WorkingPlanV1
}

export function validateWorkingReviewV1(value: unknown): WorkingReviewV1 {
  const r = object(value)
  exact(
    r,
    [
      'reviewRequestId',
      'operationId',
      'inputDigest',
      'inputRef',
      'requestDigest',
      'planRevision',
      'snapshotSequence',
      'evidenceSequence',
    ],
    ['reportRef', 'verdict'],
  )
  id(r.reviewRequestId)
  id(r.operationId)
  for (const key of ['inputDigest', 'requestDigest'])
    if (!/^sha256:[a-f0-9]{64}$/.test(String(r[key]))) invalid()
  for (const key of ['inputRef', 'reportRef'])
    if (r[key] !== undefined && !/^artifact-[a-f0-9]{64}$/.test(String(r[key]))) invalid()
  if (r.planRevision !== null && !positive(r.planRevision)) invalid()
  for (const key of ['snapshotSequence', 'evidenceSequence'])
    if (!Number.isSafeInteger(r[key]) || Number(r[key]) < 0) invalid()
  if (Number(r.evidenceSequence) > Number(r.snapshotSequence)) invalid()
  if ((r.verdict === undefined) !== (r.reportRef === undefined)) invalid()
  if (
    r.verdict !== undefined &&
    !['accepted', 'needs_fix', 'replan', 'blocked', 'unavailable'].includes(String(r.verdict))
  )
    invalid()
  return structuredClone(r) as WorkingReviewV1
}

export function validateWorkingPlanEventV1(type: string, data: Record<string, unknown>): void {
  if (type === 'working_plan.saved') {
    exact(data, ['operationId', 'inputDigest', 'plan'])
    id(data.operationId)
    if (!/^sha256:[a-f0-9]{64}$/.test(String(data.inputDigest))) invalid()
    validateWorkingPlanV1(data.plan)
  } else {
    exact(data, ['review'])
    const review = validateWorkingReviewV1(data.review)
    if ((type === 'working_plan.reviewed') !== (review.reportRef !== undefined)) invalid()
  }
  canonicalJsonV1(data)
}

function positive(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0
}
function text(value: unknown): void {
  if (typeof value !== 'string' || !value.trim()) invalid()
}
function id(value: unknown): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(value)) invalid()
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k))
  )
    invalid()
}
function invalid(): never {
  throw runtimeError(
    'WORKING_PLAN_INVALID',
    'planner',
    'Invalid working Plan data; progress is self-reported, never verified.',
  )
}
