import { runtimeError } from './contracts.js'
import {
  createSessionCommitV3,
  type SessionCommitReceiptV3,
  type SessionCommitV3,
  type SessionJournalV3,
} from './session-journal-port.js'
import {
  sessionCompactionSummaryDigestV3,
  validateSessionEntryV3,
  type CompactionCreatedEntryV3,
  type SessionCompactionCheckpointProjectionV3,
  type SessionCompactionProvenanceV3,
  type SessionCompactionReasonV3,
  type SessionCompactionSummaryV3,
} from './session-journal.js'

export type PrepareSessionCompactionInputV3 = Readonly<{
  sessionId: string
  commitId: string
  idempotencyKey: string
  entryId: string
  checkpointId: string
  timestamp: string
  coveredStartSequence: number
  coveredEndSequence: number
  summary: SessionCompactionSummaryV3
  provenance: SessionCompactionProvenanceV3
  summaryTokens: number
  reason: SessionCompactionReasonV3
}>

export type CommittedSessionCompactionV3 = Readonly<{
  receipt: SessionCommitReceiptV3
  checkpoint: SessionCompactionCheckpointProjectionV3
}>

/**
 * Prepares one CAS-bound compaction commit from the current journal projection.
 * Callers retry the returned immutable commit, never regenerate IDs after an
 * unknown durable outcome.
 */
export async function prepareSessionCompactionCommitV3(
  journal: SessionJournalV3,
  input: PrepareSessionCompactionInputV3,
): Promise<SessionCommitV3> {
  const projection = await journal.loadProjection(input.sessionId)
  const previous = projection.checkpoint
  const entry = validateSessionEntryV3({
    schemaVersion: 3,
    entryId: input.entryId,
    sessionId: input.sessionId,
    sequence: projection.snapshot.sequence + 1,
    revision: projection.snapshot.revision + 1,
    timestamp: input.timestamp,
    type: 'compaction.created',
    data: {
      checkpointId: input.checkpointId,
      coveredStartSequence: input.coveredStartSequence,
      coveredEndSequence: input.coveredEndSequence,
      ...(previous === undefined ? {} : { previousCheckpointId: previous.checkpointId }),
      retainedStartSequence: input.coveredEndSequence + 1,
      summary: input.summary,
      provenance: input.provenance,
      summaryDigest: sessionCompactionSummaryDigestV3(input.summary),
      summaryTokens: input.summaryTokens,
      reason: input.reason,
    },
  })
  if (entry.type !== 'compaction.created') throw compactionFailure('SESSION_COMPACTION_INVALID')
  validateRange(entry, projection.checkpoint)
  return createSessionCommitV3({
    sessionId: input.sessionId,
    commitId: input.commitId,
    expectedRevision: projection.snapshot.revision,
    idempotencyKey: input.idempotencyKey,
    entries: [entry],
  })
}

/** Appends first; only a durable receipt is followed by projection observation/event delivery. */
export async function commitPreparedSessionCompactionV3(
  journal: SessionJournalV3,
  input: SessionCommitV3,
): Promise<CommittedSessionCompactionV3> {
  if (input.entries.length !== 1 || input.entries[0]?.type !== 'compaction.created') {
    throw compactionFailure('SESSION_COMPACTION_COMMIT_INVALID')
  }
  const receipt = await journal.appendCommit(input)
  const projection = await journal.loadProjection(input.sessionId)
  const checkpoint = projection.checkpoint
  if (checkpoint?.checkpointId !== input.entries[0].data.checkpointId) {
    throw compactionFailure('SESSION_COMPACTION_PROJECTION_INVALID')
  }
  return Object.freeze({ receipt, checkpoint })
}

export async function commitSessionCompactionV3(
  journal: SessionJournalV3,
  input: PrepareSessionCompactionInputV3,
): Promise<CommittedSessionCompactionV3> {
  return commitPreparedSessionCompactionV3(
    journal,
    await prepareSessionCompactionCommitV3(journal, input),
  )
}

function validateRange(
  entry: CompactionCreatedEntryV3,
  previous: SessionCompactionCheckpointProjectionV3 | undefined,
): void {
  if (
    entry.data.coveredEndSequence >= entry.sequence ||
    (previous === undefined
      ? entry.data.coveredStartSequence !== 1
      : entry.data.coveredStartSequence !== previous.coveredRange.startSequence ||
        entry.data.coveredEndSequence <= previous.coveredRange.endSequence)
  ) {
    throw compactionFailure('SESSION_COMPACTION_RANGE_INVALID')
  }
}

function compactionFailure(code: string) {
  return runtimeError(code, 'persistence', 'Session compaction journal operation failed.')
}
