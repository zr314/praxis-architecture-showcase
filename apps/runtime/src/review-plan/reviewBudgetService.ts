import { createHash } from 'node:crypto'
import {
  canonicalJsonV1,
  createSessionCommitV3,
  runtimeError,
  validateSessionEntryV3,
  type ProviderUsage,
} from '@praxis/core-sdk'
import type { ReviewPlanJournalPortV1 } from './planControlPorts.js'

const MAX_CAS_RETRIES = 4

export interface ReviewBudgetServicePortV1 {
  reserve(input: {
    sessionId: string
    reviewRequestId: string
    attemptNumber: number
    reservation: ProviderUsage
  }): Promise<void>
  settle(input: {
    sessionId: string
    reviewRequestId: string
    attemptNumber: number
    disposition: 'actual' | 'released_before_provider' | 'remote_outcome_unknown'
    usage: ProviderUsage
  }): Promise<void>
}

export class ReviewBudgetServiceV1 implements ReviewBudgetServicePortV1 {
  constructor(
    private readonly journal: Pick<ReviewPlanJournalPortV1, 'loadProjection' | 'appendCommit'>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  reserve(input: {
    sessionId: string
    reviewRequestId: string
    attemptNumber: number
    reservation: ProviderUsage
  }): Promise<void> {
    return this.append(input, 'review_budget.reserved', { ...input })
  }

  settle(input: {
    sessionId: string
    reviewRequestId: string
    attemptNumber: number
    disposition: 'actual' | 'released_before_provider' | 'remote_outcome_unknown'
    usage: ProviderUsage
  }): Promise<void> {
    return this.append(input, 'review_budget.settled', { ...input })
  }

  private async append(
    key: { sessionId: string; reviewRequestId: string; attemptNumber: number },
    type: 'review_budget.reserved' | 'review_budget.settled',
    value: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const { sessionId, ...data } = value
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      const projection = await this.journal.loadProjection(key.sessionId)
      const prior = projection.reviewBudgets?.find(
        (candidate) =>
          candidate.reviewRequestId === key.reviewRequestId &&
          candidate.attemptNumber === key.attemptNumber,
      )
      if (type === 'review_budget.reserved' && prior !== undefined) {
        if (canonicalJsonV1(prior.reservation) !== canonicalJsonV1(data.reservation)) conflict()
        return
      }
      if (type === 'review_budget.settled' && prior?.state === 'settled') {
        if (
          prior.disposition !== data.disposition ||
          canonicalJsonV1(prior.usage) !== canonicalJsonV1(data.usage)
        )
          conflict()
        return
      }
      if (type === 'review_budget.settled' && prior === undefined) conflict()
      const identity = {
        sessionId: key.sessionId,
        reviewRequestId: key.reviewRequestId,
        attemptNumber: key.attemptNumber,
        type,
      }
      const id = stableId('review_budget', identity)
      const timestamp = monotonicTimestamp(projection.snapshot.updatedAt, this.now())
      const entry = validateSessionEntryV3({
        schemaVersion: 3,
        entryId: id,
        sessionId: key.sessionId,
        sequence: projection.snapshot.sequence + 1,
        revision: projection.snapshot.revision + 1,
        timestamp,
        type,
        data,
      })
      try {
        await this.journal.appendCommit(
          createSessionCommitV3({
            sessionId: key.sessionId,
            commitId: stableId('review_budget_commit', identity),
            expectedRevision: projection.snapshot.revision,
            idempotencyKey: stableId('review_budget_idem', identity),
            entries: [entry],
          }),
        )
        return
      } catch (error) {
        if (!hasCode(error, 'SESSION_COMMIT_REVISION_CONFLICT') || attempt + 1 >= MAX_CAS_RETRIES)
          throw error
      }
    }
  }
}

function stableId(prefix: string, input: unknown): string {
  return `${prefix}_${createHash('sha256').update(canonicalJsonV1(input)).digest('hex')}`
}

function monotonicTimestamp(previous: string | undefined, candidate: string): string {
  if (previous === undefined || candidate > previous) return candidate
  return new Date(Date.parse(previous) + 1).toISOString()
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}

function conflict(): never {
  throw runtimeError('REVIEW_BUDGET_CONFLICT', 'persistence', 'Review budget state conflicts.')
}
