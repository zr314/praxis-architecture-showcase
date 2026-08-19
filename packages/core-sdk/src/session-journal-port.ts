import { createHash } from 'node:crypto'
import { runtimeError } from './contracts.js'
import {
  reduceSessionEntriesV3,
  validateSessionEntryV3,
  type SessionAttemptProjectionV3,
  type SessionEntryV3,
  type SessionPlanGraphProjectionV3,
  type SessionProjectionV3,
  type SessionRunProjectionV3,
  type SessionSnapshotV3,
  type SessionStepProjectionV3,
} from './session-journal.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const MAX_COMMIT_ENTRIES = 1_024
const MAX_PAGE_ENTRIES = 512

export type SessionCommitV3 = Readonly<{
  schemaVersion: 3
  sessionId: string
  commitId: string
  expectedRevision: number
  idempotencyKey: string
  entries: readonly SessionEntryV3[]
  checksum: `sha256:${string}`
}>

export type CreateSessionCommitInputV3 = Readonly<
  Omit<SessionCommitV3, 'schemaVersion' | 'checksum'>
>

export type SessionJournalHeadV3 = Readonly<{
  revision: number
  sequence: number
}>

export type SessionCommitReceiptV3 = Readonly<{
  sessionId: string
  commitId: string
  idempotencyKey: string
  revision: number
  firstSequence: number
  lastSequence: number
  entryIds: readonly string[]
  checksum: `sha256:${string}`
  duplicate: boolean
}>

export type ReadSessionEntriesInputV3 = Readonly<{
  sessionId: string
  afterSequence?: number
  limit?: number
  /** Pins every later page to the head returned by the first read. */
  throughSequence?: number
}>

export type SessionEntryPageV3 = Readonly<{
  sessionId: string
  entries: readonly SessionEntryV3[]
  nextAfterSequence: number
  hasMore: boolean
  head: SessionJournalHeadV3
}>

export type SessionQueryInputV3 =
  | Readonly<{ sessionId: string; kind: 'run'; runId: string }>
  | Readonly<{ sessionId: string; kind: 'plan'; planId: string }>
  | Readonly<{ sessionId: string; kind: 'step'; planId: string; stepId: string }>
  | Readonly<{
      sessionId: string
      kind: 'attempt'
      planId: string
      stepId: string
      attemptId: string
    }>

export type SessionQueryResultV3 =
  | Readonly<{ kind: 'run'; value: SessionRunProjectionV3 }>
  | Readonly<{ kind: 'plan'; value: SessionPlanGraphProjectionV3 }>
  | Readonly<{ kind: 'step'; value: SessionStepProjectionV3 }>
  | Readonly<{ kind: 'attempt'; value: SessionAttemptProjectionV3 }>

export type SessionCommitAcceptedEventV3 = Readonly<{
  type: 'session.commit.accepted'
  receipt: SessionCommitReceiptV3
  entries: readonly SessionEntryV3[]
}>

export type SessionCommitListenerV3 = (event: SessionCommitAcceptedEventV3) => void

/**
 * Required atomic adapter boundary. Implementations must enforce CAS and durable
 * commit/idempotency identity before resolving appendCommit().
 */
export interface SessionJournalCommitStoreV3 {
  appendCommit(commit: SessionCommitV3): Promise<SessionCommitReceiptV3>
  readEntries(input: ReadSessionEntriesInputV3): Promise<SessionEntryPageV3>
  /**
   * Optional validated materialized view. Durable backends may provide this so ordinary
   * reads do not replay the complete journal; deep integrity checks still use readEntries.
   */
  loadCachedProjection?(sessionId: string): Promise<SessionProjectionV3>
}

/** Planner-facing port. It intentionally exposes no file, offset, table, or transaction handle. */
export interface SessionJournalV3 {
  appendCommit(commit: SessionCommitV3): Promise<SessionCommitReceiptV3>
  readEntries(input: ReadSessionEntriesInputV3): Promise<SessionEntryPageV3>
  loadProjection(sessionId: string): Promise<SessionProjectionV3>
  loadSnapshot(sessionId: string): Promise<SessionSnapshotV3>
  querySession(input: SessionQueryInputV3): Promise<SessionQueryResultV3>
  subscribe(listener: SessionCommitListenerV3): () => void
}

export function createSessionCommitV3(input: CreateSessionCommitInputV3): SessionCommitV3 {
  const candidate = {
    schemaVersion: 3 as const,
    sessionId: input.sessionId,
    commitId: input.commitId,
    expectedRevision: input.expectedRevision,
    idempotencyKey: input.idempotencyKey,
    entries: input.entries,
  }
  return validateSessionCommitV3({
    ...candidate,
    checksum: checksum(candidate),
  })
}

export function validateSessionCommitV3(input: unknown): SessionCommitV3 {
  if (
    !isRecord(input) ||
    !onlyKeys(input, [
      'schemaVersion',
      'sessionId',
      'commitId',
      'expectedRevision',
      'idempotencyKey',
      'entries',
      'checksum',
    ]) ||
    input.schemaVersion !== 3 ||
    !safeId(input.sessionId) ||
    !safeId(input.commitId) ||
    !nonNegativeInteger(input.expectedRevision) ||
    !safeId(input.idempotencyKey) ||
    !Array.isArray(input.entries) ||
    input.entries.length === 0 ||
    input.entries.length > MAX_COMMIT_ENTRIES ||
    typeof input.checksum !== 'string' ||
    !SHA256.test(input.checksum)
  ) {
    throw commitFailure('SESSION_COMMIT_INVALID')
  }

  const entries = input.entries.map(validateSessionEntryV3)
  const revision = input.expectedRevision + 1
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (
      entry.sessionId !== input.sessionId ||
      entry.revision !== revision ||
      (index > 0 && entry.sequence !== entries[index - 1]!.sequence + 1)
    ) {
      throw commitFailure('SESSION_COMMIT_INVALID')
    }
  }
  if (
    (input.expectedRevision === 0 &&
      (entries[0]!.sequence !== 1 || entries[0]!.type !== 'session.created')) ||
    (input.expectedRevision > 0 && entries.some((entry) => entry.type === 'session.created'))
  ) {
    throw commitFailure('SESSION_COMMIT_INVALID')
  }

  const canonical = {
    schemaVersion: 3 as const,
    sessionId: input.sessionId,
    commitId: input.commitId,
    expectedRevision: input.expectedRevision,
    idempotencyKey: input.idempotencyKey,
    entries,
  }
  if (checksum(canonical) !== input.checksum) {
    throw commitFailure('SESSION_COMMIT_CHECKSUM_INVALID')
  }
  return deepFreeze({ ...canonical, checksum: input.checksum as `sha256:${string}` })
}

export function assertSessionCommitAgainstHeadV3(
  commit: SessionCommitV3,
  head: SessionJournalHeadV3 | undefined,
): void {
  const expectedRevision = head?.revision ?? 0
  const expectedSequence = (head?.sequence ?? 0) + 1
  if (commit.expectedRevision !== expectedRevision) {
    throw commitFailure('SESSION_COMMIT_REVISION_CONFLICT')
  }
  if (commit.entries[0]!.sequence !== expectedSequence) {
    throw commitFailure('SESSION_COMMIT_SEQUENCE_CONFLICT')
  }
}

export function sessionCommitReceiptV3(
  commit: SessionCommitV3,
  duplicate = false,
): SessionCommitReceiptV3 {
  return deepFreeze({
    sessionId: commit.sessionId,
    commitId: commit.commitId,
    idempotencyKey: commit.idempotencyKey,
    revision: commit.expectedRevision + 1,
    firstSequence: commit.entries[0]!.sequence,
    lastSequence: commit.entries.at(-1)!.sequence,
    entryIds: commit.entries.map((entry) => entry.entryId),
    checksum: commit.checksum,
    duplicate,
  })
}

/**
 * Shared projection and publication layer. Adapters only own atomic bytes/rows;
 * accepted events are emitted after their durable append promise resolves.
 */
export class ReducingSessionJournalV3 implements SessionJournalV3 {
  readonly #listeners = new Set<SessionCommitListenerV3>()

  constructor(private readonly store: SessionJournalCommitStoreV3) {}

  async appendCommit(input: SessionCommitV3): Promise<SessionCommitReceiptV3> {
    const commit = validateSessionCommitV3(input)
    const receipt = validateReceipt(await this.store.appendCommit(commit), commit)
    if (!receipt.duplicate) {
      const event = deepFreeze({
        type: 'session.commit.accepted' as const,
        receipt,
        entries: commit.entries,
      })
      for (const listener of this.#listeners) {
        try {
          listener(event)
        } catch {
          // Persistence already succeeded; observers cannot roll it back or change the receipt.
        }
      }
    }
    return receipt
  }

  async readEntries(input: ReadSessionEntriesInputV3): Promise<SessionEntryPageV3> {
    validateReadInput(input)
    return validatePage(await this.store.readEntries(input), input)
  }

  async loadSnapshot(sessionId: string): Promise<SessionSnapshotV3> {
    return (await this.loadProjection(sessionId)).snapshot
  }

  async querySession(input: SessionQueryInputV3): Promise<SessionQueryResultV3> {
    validateQuery(input)
    const projection = await this.loadProjection(input.sessionId)
    switch (input.kind) {
      case 'run': {
        const value = projection.snapshot.runs.find((run) => run.runId === input.runId)
        if (value === undefined) queryNotFound()
        return deepFreeze({ kind: 'run', value })
      }
      case 'plan': {
        if (projection.planGraph?.planId !== input.planId) queryNotFound()
        return deepFreeze({ kind: 'plan', value: projection.planGraph })
      }
      case 'step': {
        if (projection.planGraph?.planId !== input.planId) queryNotFound()
        const value = projection.planGraph.steps.find((step) => step.stepId === input.stepId)
        if (value === undefined) queryNotFound()
        return deepFreeze({ kind: 'step', value })
      }
      case 'attempt': {
        if (projection.planGraph?.planId !== input.planId) queryNotFound()
        const step = projection.planGraph.steps.find(
          (candidate) => candidate.stepId === input.stepId,
        )
        const value = step?.attempts.find((attempt) => attempt.attemptId === input.attemptId)
        if (value === undefined) queryNotFound()
        return deepFreeze({ kind: 'attempt', value })
      }
    }
  }

  subscribe(listener: SessionCommitListenerV3): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async loadProjection(sessionId: string): Promise<SessionProjectionV3> {
    if (!safeId(sessionId)) throw journalFailure('SESSION_ID_INVALID')
    if (this.store.loadCachedProjection !== undefined) {
      return this.store.loadCachedProjection(sessionId)
    }
    const entries: SessionEntryV3[] = []
    let afterSequence = 0
    let throughSequence: number | undefined
    let hasMore = true
    while (hasMore) {
      const page = await this.readEntries({
        sessionId,
        afterSequence,
        limit: MAX_PAGE_ENTRIES,
        ...(throughSequence === undefined ? {} : { throughSequence }),
      })
      throughSequence ??= page.head.sequence
      entries.push(...page.entries)
      afterSequence = page.nextAfterSequence
      hasMore = page.hasMore
    }
    if (entries.length === 0) throw journalFailure('SESSION_NOT_FOUND')
    return reduceSessionEntriesV3(entries)
  }
}

function validateReadInput(input: ReadSessionEntriesInputV3): void {
  if (
    !isRecord(input) ||
    !onlyKeys(input, ['sessionId', 'afterSequence', 'limit', 'throughSequence']) ||
    !safeId(input.sessionId) ||
    (input.afterSequence !== undefined && !nonNegativeInteger(input.afterSequence)) ||
    (input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_ENTRIES)) ||
    (input.throughSequence !== undefined && !nonNegativeInteger(input.throughSequence))
  ) {
    throw journalFailure('SESSION_READ_INVALID')
  }
}

function validatePage(input: unknown, request: ReadSessionEntriesInputV3): SessionEntryPageV3 {
  if (
    !isRecord(input) ||
    !onlyKeys(input, ['sessionId', 'entries', 'nextAfterSequence', 'hasMore', 'head']) ||
    input.sessionId !== request.sessionId ||
    !Array.isArray(input.entries) ||
    typeof input.hasMore !== 'boolean' ||
    !nonNegativeInteger(input.nextAfterSequence) ||
    !isRecord(input.head) ||
    !onlyKeys(input.head, ['revision', 'sequence']) ||
    !nonNegativeInteger(input.head.revision) ||
    !nonNegativeInteger(input.head.sequence)
  ) {
    throw journalFailure('SESSION_BACKEND_CONTRACT_INVALID')
  }
  const entries = input.entries.map(validateSessionEntryV3)
  const after = request.afterSequence ?? 0
  const through = request.throughSequence ?? input.head.sequence
  if (
    input.head.sequence < through ||
    entries.length > (request.limit ?? MAX_PAGE_ENTRIES) ||
    entries.some(
      (entry, index) =>
        entry.sessionId !== request.sessionId ||
        entry.sequence <= after ||
        entry.sequence > through ||
        (index > 0 && entry.sequence !== entries[index - 1]!.sequence + 1),
    ) ||
    input.nextAfterSequence !== (entries.at(-1)?.sequence ?? after) ||
    input.hasMore !== input.nextAfterSequence < through
  ) {
    throw journalFailure('SESSION_BACKEND_CONTRACT_INVALID')
  }
  return deepFreeze({
    sessionId: input.sessionId,
    entries,
    nextAfterSequence: input.nextAfterSequence,
    hasMore: input.hasMore,
    head: { revision: input.head.revision, sequence: input.head.sequence },
  })
}

function validateReceipt(input: unknown, commit: SessionCommitV3): SessionCommitReceiptV3 {
  if (
    !isRecord(input) ||
    !onlyKeys(input, [
      'sessionId',
      'commitId',
      'idempotencyKey',
      'revision',
      'firstSequence',
      'lastSequence',
      'entryIds',
      'checksum',
      'duplicate',
    ]) ||
    input.sessionId !== commit.sessionId ||
    input.commitId !== commit.commitId ||
    input.idempotencyKey !== commit.idempotencyKey ||
    input.revision !== commit.expectedRevision + 1 ||
    input.firstSequence !== commit.entries[0]!.sequence ||
    input.lastSequence !== commit.entries.at(-1)!.sequence ||
    !Array.isArray(input.entryIds) ||
    input.entryIds.length !== commit.entries.length ||
    input.entryIds.some((id, index) => id !== commit.entries[index]!.entryId) ||
    input.checksum !== commit.checksum ||
    typeof input.duplicate !== 'boolean'
  ) {
    throw journalFailure('SESSION_BACKEND_CONTRACT_INVALID')
  }
  return deepFreeze(structuredClone(input)) as SessionCommitReceiptV3
}

function validateQuery(input: SessionQueryInputV3): void {
  if (!isRecord(input) || !safeId(input.sessionId)) {
    throw journalFailure('SESSION_QUERY_INVALID')
  }
  switch (input.kind) {
    case 'run':
      if (!onlyKeys(input, ['sessionId', 'kind', 'runId']) || !safeId(input.runId)) queryInvalid()
      break
    case 'plan':
      if (!onlyKeys(input, ['sessionId', 'kind', 'planId']) || !safeId(input.planId)) {
        queryInvalid()
      }
      break
    case 'step':
      if (
        !onlyKeys(input, ['sessionId', 'kind', 'planId', 'stepId']) ||
        !safeId(input.planId) ||
        !safeId(input.stepId)
      ) {
        queryInvalid()
      }
      break
    case 'attempt':
      if (
        !onlyKeys(input, ['sessionId', 'kind', 'planId', 'stepId', 'attemptId']) ||
        !safeId(input.planId) ||
        !safeId(input.stepId) ||
        !safeId(input.attemptId)
      ) {
        queryInvalid()
      }
      break
    default:
      queryInvalid()
  }
}

function checksum(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  throw commitFailure('SESSION_COMMIT_INVALID')
}

function queryInvalid(): never {
  throw journalFailure('SESSION_QUERY_INVALID')
}

function queryNotFound(): never {
  throw journalFailure('SESSION_QUERY_NOT_FOUND')
}

function commitFailure(code: string) {
  return runtimeError(code, 'persistence', 'Session commit is invalid.')
}

function journalFailure(code: string) {
  return runtimeError(code, 'persistence', 'Session journal operation failed.')
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
