import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MAX_REVIEW_RAW_RESPONSE_BYTES_V1 } from '@praxis/core-sdk'
import { ReviewCallStoreV1 } from '../apps/runtime/src/review-plan/reviewCallStore.js'
import { loadNodeSqlite } from '../apps/runtime/src/store/nodeSqlite.js'

const DIGEST = `sha256:${'a'.repeat(64)}` as const

test('invalid and interrupted Reviewer attempts retain safe diagnostics and measured usage across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-review-failures-'))
  const store = new ReviewCallStoreV1(root)
  try {
    await store.initialize()
    for (const attemptNumber of [1, 2]) {
      await store.reserve('review', attemptNumber, DIGEST, '2026-09-02T00:00:00.000Z')
      await store.markProviderStarted('review', attemptNumber)
      await store.recordFailure(
        'review',
        attemptNumber,
        {
          code: attemptNumber === 1 ? 'REVIEW_RESPONSE_TRUNCATED' : 'PROVIDER_NETWORK_FAILED',
          stage: 'response',
          usageComplete: attemptNumber === 1,
          validationPath: 'findings.length',
          responseDigest: DIGEST,
          responseBytes: 512,
          submittedResponse: {
            summary: '',
            findings: [{ status: 'passed', proof: { unresolvedAssumptions: ['none'] } }],
            api_key: 'private-credential',
          },
        },
        { inputTokens: 31, outputTokens: 12 },
      )
    }
    store.close()
    await store.initialize()
    const failed = await store.reserve('review', 1, DIGEST)
    assert.equal(failed.replayed, true)
    assert.equal(failed.attempt.state, 'provider_invalid')
    assert.equal(failed.attempt.failure?.validationPath, 'findings.length')
    assert.equal(failed.attempt.usage?.outputTokens, 12)
    assert.equal(failed.attempt.rawResponse, undefined)
    assert.deepEqual(failed.attempt.failure?.submittedResponse, {
      summary: '',
      findings: [{ status: 'passed', proof: { unresolvedAssumptions: ['none'] } }],
      api_key: '[REDACTED]',
    })
    assert.equal((await store.get('review', 2))?.state, 'provider_unknown')
    const expired = await store.recoverExpired('2026-10-01T00:00:00.000Z')
    assert.deepEqual(
      expired.map(({ attemptNumber }) => attemptNumber),
      [2],
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('ReviewCallStore upgrades old rows without losing a saved decision or usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-review-call-upgrade-'))
  const { DatabaseSync } = await loadNodeSqlite()
  const legacy = new DatabaseSync(join(root, 'review-calls-v1.sqlite'))
  legacy.exec(
    'CREATE TABLE review_call_attempts (review_request_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, request_digest TEXT NOT NULL, state TEXT NOT NULL, lease_expires_at TEXT NOT NULL, raw_response TEXT, decision_json TEXT, usage_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (review_request_id, attempt_number))',
  )
  legacy
    .prepare('INSERT INTO review_call_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      'legacy-review',
      1,
      DIGEST,
      'provider_completed',
      '2026-09-01T00:00:00.000Z',
      '{}',
      JSON.stringify({ verdict: 'blocked', summary: 'Existing decision.', findings: [] }),
      JSON.stringify({ inputTokens: 17 }),
      '2026-09-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
    )
  legacy.close()
  const store = new ReviewCallStoreV1(root)
  try {
    await store.initialize()
    const row = await store.reserve('legacy-review', 1, DIGEST)
    assert.equal(row.replayed, true)
    assert.equal(row.attempt.decision?.summary, 'Existing decision.')
    assert.equal(row.attempt.usage?.inputTokens, 17)
    assert.equal(row.attempt.evidenceReads, undefined)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('ReviewCallStore durably replays a completed provider response after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-review-calls-'))
  const first = new ReviewCallStoreV1(root)
  try {
    await first.initialize()
    const reserved = await first.reserve('review-1', 1, DIGEST, '2026-09-02T00:00:00.000Z')
    assert.equal(reserved.replayed, false)
    assert.equal((await first.reserve('review-1', 1, DIGEST)).replayed, true)
    await first.markProviderStarted('review-1', 1)
    await first.completeProvider('review-1', 1, {
      rawResponse: '{"verdict":"accepted"}',
      decision: {
        verdict: 'accepted',
        summary: 'Verified.',
        findings: [
          {
            criterionId: 'criterion-1',
            status: 'passed',
            reason: 'Evidence matches.',
            evidenceRefs: ['artifact-1'],
          },
        ],
      },
      usage: { inputTokens: 7, outputTokens: 3 },
      evidenceReads: [{ ref: 'artifact-1', offset: 10, length: 20, responseDigest: DIGEST }],
    })
    first.close()

    const reopened = new ReviewCallStoreV1(root)
    await reopened.initialize()
    const replay = await reopened.reserve('review-1', 1, DIGEST)
    assert.equal(replay.replayed, true)
    assert.equal(replay.attempt.state, 'provider_completed')
    assert.equal(replay.attempt.rawResponse, '{"verdict":"accepted"}')
    assert.equal(replay.attempt.decision?.verdict, 'accepted')
    assert.equal(replay.attempt.usage?.inputTokens, 7)
    assert.deepEqual(replay.attempt.evidenceReads, [
      { ref: 'artifact-1', offset: 10, length: 20, responseDigest: DIGEST },
    ])
    assert.equal((await reopened.markDecisionCommitted('review-1', 1)).state, 'decision_committed')
    reopened.close()
  } finally {
    first.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('ReviewCallStore detects conflicts, caps raw responses, and reports expired leases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-review-calls-'))
  const store = new ReviewCallStoreV1(root)
  try {
    await store.initialize()
    await store.reserve('review-expired', 1, DIGEST, '2020-01-01T00:00:00.000Z')
    assert.deepEqual(
      (await store.recoverExpired('2026-09-02T00:00:00.000Z')).map(
        ({ reviewRequestId }) => reviewRequestId,
      ),
      ['review-expired'],
    )
    await assert.rejects(
      store.reserve('review-expired', 1, `sha256:${'b'.repeat(64)}`),
      hasCode('REVIEW_REQUEST_CONFLICT'),
    )
    await store.markProviderStarted('review-expired', 1)
    await assert.rejects(
      store.completeProvider('review-expired', 1, {
        rawResponse: 'x'.repeat(MAX_REVIEW_RAW_RESPONSE_BYTES_V1 + 1),
        decision: { verdict: 'blocked', summary: 'Too large.', findings: [] },
        usage: {},
      }),
      hasCode('REVIEW_RESPONSE_TOO_LARGE'),
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
}
