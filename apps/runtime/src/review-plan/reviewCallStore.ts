import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  canonicalJsonV1,
  MAX_REVIEW_RAW_RESPONSE_BYTES_V1,
  REVIEW_ATTEMPT_LEASE_MS_V1,
  runtimeError,
  type ProviderUsage,
} from '@praxis/core-sdk'
import { loadNodeSqlite } from '../store/nodeSqlite.js'
import type { SemanticReviewDecisionV1, SemanticReviewResponseV1 } from './semanticReviewer.js'
import type { ReviewFailureDiagnosticV1 } from './semanticReviewer.js'
import { safeReviewFailureV1 } from './reviewDiagnostics.js'

export type ReviewCallAttemptV1 = Readonly<{
  reviewRequestId: string
  attemptNumber: number
  requestDigest: `sha256:${string}`
  state:
    | 'reserved'
    | 'provider_started'
    | 'provider_completed'
    | 'provider_invalid'
    | 'provider_unknown'
    | 'decision_committed'
  leaseExpiresAt: string
  rawResponse?: string
  decision?: SemanticReviewDecisionV1
  usage?: ProviderUsage
  failure?: ReviewFailureDiagnosticV1
  evidenceReads?: SemanticReviewResponseV1['evidenceReads']
  createdAt: string
  updatedAt: string
}>

export class ReviewCallStoreV1 {
  readonly #path: string
  #database?: DatabaseSync
  #writer = Promise.resolve()

  constructor(root = process.env.PRAXIS_HOME ?? join(homedir(), '.praxis')) {
    this.#path = join(root, 'review-calls-v1.sqlite')
  }

  async initialize(): Promise<void> {
    if (this.#database !== undefined) return
    await mkdir(dirname(this.#path), { recursive: true })
    const { DatabaseSync } = await loadNodeSqlite()
    const database = new DatabaseSync(this.#path)
    database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    database.exec(`
      CREATE TABLE IF NOT EXISTS review_call_attempts (
        review_request_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        request_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        raw_response TEXT,
        decision_json TEXT,
        usage_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (review_request_id, attempt_number)
      );
    `)
    database.exec('BEGIN IMMEDIATE')
    try {
      const columns = database.prepare('PRAGMA table_info(review_call_attempts)').all() as {
        name: string
      }[]
      if (!columns.some(({ name }) => name === 'evidence_reads_json')) {
        database.exec('ALTER TABLE review_call_attempts ADD COLUMN evidence_reads_json TEXT')
      }
      if (!columns.some(({ name }) => name === 'failure_json')) {
        database.exec('ALTER TABLE review_call_attempts ADD COLUMN failure_json TEXT')
      }
      database.exec('COMMIT')
    } catch (error) {
      rollback(database)
      database.close()
      throw error
    }
    this.#database = database
  }

  reserve(
    reviewRequestId: string,
    attemptNumber: number,
    requestDigest: `sha256:${string}`,
    at = new Date().toISOString(),
  ): Promise<{ attempt: ReviewCallAttemptV1; replayed: boolean }> {
    return this.exclusive(() => {
      const database = this.database()
      database.exec('BEGIN IMMEDIATE')
      try {
        const prior = this.getSync(reviewRequestId, attemptNumber)
        if (prior !== undefined) {
          if (prior.requestDigest !== requestDigest) throw callError('REVIEW_REQUEST_CONFLICT')
          database.exec('COMMIT')
          return { attempt: prior, replayed: true }
        }
        const attempt: ReviewCallAttemptV1 = {
          reviewRequestId,
          attemptNumber,
          requestDigest,
          state: 'reserved',
          leaseExpiresAt: new Date(Date.parse(at) + REVIEW_ATTEMPT_LEASE_MS_V1).toISOString(),
          createdAt: at,
          updatedAt: at,
        }
        database
          .prepare(
            `INSERT INTO review_call_attempts
             (review_request_id, attempt_number, request_digest, state, lease_expires_at, created_at, updated_at)
             VALUES (?, ?, ?, 'reserved', ?, ?, ?)`,
          )
          .run(reviewRequestId, attemptNumber, requestDigest, attempt.leaseExpiresAt, at, at)
        database.exec('COMMIT')
        return { attempt, replayed: false }
      } catch (error) {
        rollback(database)
        throw error
      }
    })
  }

  markProviderStarted(
    reviewRequestId: string,
    attemptNumber: number,
    at = new Date().toISOString(),
  ): Promise<ReviewCallAttemptV1> {
    return this.transition(reviewRequestId, attemptNumber, ['reserved'], 'provider_started', {}, at)
  }

  completeProvider(
    reviewRequestId: string,
    attemptNumber: number,
    response: SemanticReviewResponseV1,
    at = new Date().toISOString(),
  ): Promise<ReviewCallAttemptV1> {
    if (Buffer.byteLength(response.rawResponse, 'utf8') > MAX_REVIEW_RAW_RESPONSE_BYTES_V1)
      return Promise.reject(callError('REVIEW_RESPONSE_TOO_LARGE'))
    return this.transition(
      reviewRequestId,
      attemptNumber,
      ['provider_started', 'provider_completed'],
      'provider_completed',
      {
        raw_response: response.rawResponse,
        decision_json: canonicalJsonV1(response.decision),
        usage_json: canonicalJsonV1(response.usage),
        evidence_reads_json: canonicalJsonV1(response.evidenceReads ?? []),
      },
      at,
    )
  }

  markDecisionCommitted(
    reviewRequestId: string,
    attemptNumber: number,
    at = new Date().toISOString(),
  ): Promise<ReviewCallAttemptV1> {
    return this.transition(
      reviewRequestId,
      attemptNumber,
      ['provider_completed', 'decision_committed'],
      'decision_committed',
      {},
      at,
    )
  }

  recordFailure(
    reviewRequestId: string,
    attemptNumber: number,
    failure: ReviewFailureDiagnosticV1,
    usage: ProviderUsage = {},
  ): Promise<ReviewCallAttemptV1> {
    return this.transition(
      reviewRequestId,
      attemptNumber,
      ['provider_started'],
      failure.usageComplete ? 'provider_invalid' : 'provider_unknown',
      {
        failure_json: canonicalJsonV1(safeReviewFailureV1(failure)),
        usage_json: canonicalJsonV1(usage),
      },
      new Date().toISOString(),
    )
  }

  get(reviewRequestId: string, attemptNumber: number): Promise<ReviewCallAttemptV1 | undefined> {
    return Promise.resolve(this.getSync(reviewRequestId, attemptNumber))
  }

  recoverExpired(at = new Date().toISOString()): Promise<readonly ReviewCallAttemptV1[]> {
    const rows = this.database()
      .prepare(
        `SELECT * FROM review_call_attempts
         WHERE state IN ('reserved', 'provider_started', 'provider_unknown') AND lease_expires_at <= ?
         ORDER BY review_request_id, attempt_number`,
      )
      .all(at) as ReviewCallRow[]
    return Promise.resolve(rows.map(parseRow))
  }

  close(): void {
    this.#database?.close()
    this.#database = undefined
  }

  private transition(
    reviewRequestId: string,
    attemptNumber: number,
    allowed: readonly ReviewCallAttemptV1['state'][],
    state: ReviewCallAttemptV1['state'],
    fields: Readonly<Record<string, string>>,
    at: string,
  ): Promise<ReviewCallAttemptV1> {
    return this.exclusive(() => {
      const database = this.database()
      database.exec('BEGIN IMMEDIATE')
      try {
        const prior = this.getSync(reviewRequestId, attemptNumber)
        if (prior === undefined) throw callError('REVIEW_ATTEMPT_NOT_FOUND')
        if (prior.state === state) {
          database.exec('COMMIT')
          return prior
        }
        if (!allowed.includes(prior.state)) throw callError('REVIEW_ATTEMPT_STATE_CONFLICT')
        const assignments = [
          'state = ?',
          'updated_at = ?',
          ...Object.keys(fields).map((key) => `${key} = ?`),
        ]
        database
          .prepare(
            `UPDATE review_call_attempts SET ${assignments.join(', ')}
             WHERE review_request_id = ? AND attempt_number = ?`,
          )
          .run(state, at, ...Object.values(fields), reviewRequestId, attemptNumber)
        const next = this.getSync(reviewRequestId, attemptNumber)!
        database.exec('COMMIT')
        return next
      } catch (error) {
        rollback(database)
        throw error
      }
    })
  }

  private getSync(reviewRequestId: string, attemptNumber: number) {
    const row = this.database()
      .prepare(
        'SELECT * FROM review_call_attempts WHERE review_request_id = ? AND attempt_number = ?',
      )
      .get(reviewRequestId, attemptNumber) as ReviewCallRow | undefined
    return row === undefined ? undefined : parseRow(row)
  }

  private database(): DatabaseSync {
    if (this.#database === undefined) throw callError('REVIEW_CALL_STORE_NOT_INITIALIZED')
    return this.#database
  }

  private exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.#writer.then(operation)
    this.#writer = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

type ReviewCallRow = {
  review_request_id: string
  attempt_number: number
  request_digest: `sha256:${string}`
  state: ReviewCallAttemptV1['state']
  lease_expires_at: string
  raw_response: string | null
  decision_json: string | null
  usage_json: string | null
  evidence_reads_json: string | null
  failure_json: string | null
  created_at: string
  updated_at: string
}

function parseRow(row: ReviewCallRow): ReviewCallAttemptV1 {
  return Object.freeze({
    reviewRequestId: row.review_request_id,
    attemptNumber: Number(row.attempt_number),
    requestDigest: row.request_digest,
    state: row.state,
    leaseExpiresAt: row.lease_expires_at,
    ...(row.raw_response === null ? {} : { rawResponse: row.raw_response }),
    ...(row.decision_json === null
      ? {}
      : { decision: JSON.parse(row.decision_json) as SemanticReviewDecisionV1 }),
    ...(row.usage_json === null ? {} : { usage: JSON.parse(row.usage_json) as ProviderUsage }),
    ...(row.failure_json == null
      ? {}
      : { failure: JSON.parse(row.failure_json) as ReviewFailureDiagnosticV1 }),
    ...(row.evidence_reads_json === null
      ? {}
      : {
          evidenceReads: JSON.parse(
            row.evidence_reads_json,
          ) as SemanticReviewResponseV1['evidenceReads'],
        }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
}

function rollback(database: DatabaseSync) {
  try {
    database.exec('ROLLBACK')
  } catch {
    // Original error wins.
  }
}

function callError(code: string) {
  return runtimeError(code, 'persistence', 'Review call persistence failed.')
}
