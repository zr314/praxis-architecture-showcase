import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canonicalDigestV1,
  REVIEW_PLAN_SNAPSHOT_MAX_BYTES_V1,
  type ReviewPlanProjectionV1,
  validateReviewPlanProjectionV1,
} from '@praxis/core-sdk'
import { reviewPlanSnapshotMessageV1 } from '../apps/runtime/src/review-plan/reviewPlanSnapshot.js'

const digest = (character: string): `sha256:${string}` =>
  `sha256:${character.repeat(64)}` as `sha256:${string}`

function projection(evidenceRefs: readonly string[]): ReviewPlanProjectionV1 {
  return validateReviewPlanProjectionV1({
    schemaVersion: 1,
    planId: 'rp_snapshot',
    revision: 1,
    objective:
      'Complete a long-running task without copying its evidence ledger into every prompt.',
    objectiveDigest: canonicalDigestV1(
      'Complete a long-running task without copying its evidence ledger into every prompt.',
    ),
    state: 'active',
    policy: {
      semantic: 'final_and_checkpoints',
      maxRepairAttemptsPerItem: 3,
      maxReplans: 2,
      maxReviewAttempts: 2,
      maxNoProgressAttempts: 2,
    },
    criteria: [
      {
        id: 'verified',
        description: 'The implementation is verified.',
        kind: 'semantic',
        required: true,
        status: 'active',
        definitionDigest: digest('1'),
      },
    ],
    items: [
      {
        id: 'implementation',
        title: 'Implement and verify',
        order: 0,
        criterionIds: ['verified'],
        state: 'running',
        reviewCheckpoint: true,
        attemptCount: 1,
        currentAttempt: {
          itemAttemptId: 'rpa_snapshot',
          attemptNumber: 1,
          state: 'open',
          evidenceRefs,
        },
        taskRefs: [],
        evidenceRefs,
      },
    ],
    attemptCount: 1,
    replanCount: 0,
    noProgressCount: 0,
    focusedRootAttemptId: 'rpa_snapshot',
  })
}

function messageText(message: NonNullable<ReturnType<typeof reviewPlanSnapshotMessageV1>>): string {
  const content = message.content
  if (typeof content !== 'string') throw new TypeError('Expected a text-only snapshot message.')
  return content
}

function snapshotPayload(
  message: NonNullable<ReturnType<typeof reviewPlanSnapshotMessageV1>>,
): string {
  const match = /<review-plan-snapshot>\n([\s\S]+)\n<\/review-plan-snapshot>/u.exec(
    messageText(message),
  )
  assert.ok(match?.[1])
  return match[1]
}

test('review plan snapshot remains bounded and cache-stable as attempt evidence grows', () => {
  const initial = reviewPlanSnapshotMessageV1(projection([]))
  const evidenceRefs = Array.from(
    { length: 600 },
    (_, index) => `artifact-${index}-${'e'.repeat(300)}`,
  )
  const afterTools = reviewPlanSnapshotMessageV1(projection(evidenceRefs))

  assert.ok(initial)
  assert.ok(afterTools)
  assert.equal(messageText(afterTools), messageText(initial))
  assert.ok(
    Buffer.byteLength(snapshotPayload(afterTools), 'utf8') < REVIEW_PLAN_SNAPSHOT_MAX_BYTES_V1,
  )
  assert.doesNotMatch(messageText(afterTools), /artifact-599-/u)
})

test('review plan snapshot falls back to identity-preserving minimal projection', () => {
  const criteria = Array.from({ length: 30 }, (_, index) => ({
    id: `criterion_${index}`,
    description: `criterion-${index}-${'说明'.repeat(500)}`,
    kind: 'semantic' as const,
    required: true,
    status: 'active' as const,
    definitionDigest: digest((index % 10).toString()),
  }))
  const plan = validateReviewPlanProjectionV1({
    schemaVersion: 1,
    planId: 'rp_minimal',
    revision: 4,
    objective: '目标'.repeat(2_000),
    objectiveDigest: digest('a'),
    state: 'active',
    policy: {
      semantic: 'final',
      maxRepairAttemptsPerItem: 3,
      maxReplans: 2,
      maxReviewAttempts: 2,
      maxNoProgressAttempts: 2,
    },
    criteria,
    items: [
      {
        id: 'work',
        title: '标题'.repeat(1_000),
        order: 0,
        criterionIds: criteria.map((criterion) => criterion.id),
        state: 'pending',
        reviewCheckpoint: false,
        attemptCount: 0,
        taskRefs: [],
        evidenceRefs: [],
      },
    ],
    attemptCount: 0,
    replanCount: 1,
    noProgressCount: 0,
  })

  const message = reviewPlanSnapshotMessageV1(plan)
  assert.ok(message)
  assert.ok(Buffer.byteLength(snapshotPayload(message), 'utf8') < REVIEW_PLAN_SNAPSHOT_MAX_BYTES_V1)
  assert.match(messageText(message), /"planId":"rp_minimal"/u)
  assert.match(messageText(message), /"id":"criterion_29"/u)
  assert.doesNotMatch(messageText(message), /"description":/u)
  assert.doesNotMatch(messageText(message), /"objective":/u)
})

test('review plan snapshot remains bounded as accepted Item reviews accumulate', () => {
  const criteria = Array.from({ length: 11 }, (_, index) => ({
    id: `criterion_${index}`,
    description: `Verify criterion ${index}: ${'observable result '.repeat(18)}`,
    kind: 'semantic' as const,
    required: true,
    status: 'active' as const,
    definitionDigest: digest((index % 10).toString()),
  }))
  const acceptedEvidenceRefs = Array.from(
    { length: 225 },
    (_, index) => `artifact-${index}-${'e'.repeat(120)}`,
  )
  const items = Array.from({ length: 7 }, (_, index) => {
    const accepted = index < 5
    return {
      id: `item_${index}`,
      title: `Implement and verify item ${index}: ${'detailed work '.repeat(12)}`,
      order: index,
      criterionIds: [criteria[index]?.id ?? criteria[0]!.id],
      state: accepted ? ('accepted' as const) : ('pending' as const),
      reviewCheckpoint: index === 6,
      attemptCount: accepted ? 1 : 0,
      taskRefs: [],
      evidenceRefs: accepted && index === 1 ? acceptedEvidenceRefs : [],
      ...(accepted
        ? {
            acceptedEvidenceRefs: accepted && index === 1 ? acceptedEvidenceRefs : [],
            acceptedAttemptId: `rpa_${index}_${'a'.repeat(64)}`,
            acceptedInputDigest: digest('a'),
            lastReview: {
              reviewRequestId: `rpr_${index}_${'r'.repeat(64)}`,
              decisionArtifactRef: `artifact-${'f'.repeat(64)}`,
              decisionDigest: digest('f'),
              verdict: 'accepted' as const,
            },
          }
        : {}),
      ...(index < 2
        ? {
            block: {
              blockId: `rpb_${'b'.repeat(64)}` as const,
              code: 'MODEL_REPORTED_BLOCK',
              allowedResolver: 'plan_revision' as const,
              detailDigest: digest('b'),
              createdAt: '2026-09-03T00:00:00.000Z',
            },
          }
        : {}),
    }
  })
  const plan = validateReviewPlanProjectionV1({
    schemaVersion: 1,
    planId: `rp_${'p'.repeat(64)}`,
    revision: 1,
    objective: 'Complete a realistic multi-item long-running task with review checkpoints.',
    objectiveDigest: digest('a'),
    state: 'active',
    policy: {
      semantic: 'final_and_checkpoints',
      maxRepairAttemptsPerItem: 3,
      maxReplans: 2,
      maxReviewAttempts: 3,
      maxNoProgressAttempts: 3,
    },
    criteria,
    items,
    attemptCount: 5,
    replanCount: 0,
    noProgressCount: 0,
  })

  const message = reviewPlanSnapshotMessageV1(plan)
  assert.ok(message)
  assert.ok(Buffer.byteLength(snapshotPayload(message), 'utf8') < REVIEW_PLAN_SNAPSHOT_MAX_BYTES_V1)
  assert.match(messageText(message), /"id":"criterion_10"/u)
  assert.match(messageText(message), /"id":"item_6"/u)
  assert.doesNotMatch(messageText(message), /"decisionArtifactRef":/u)
  assert.doesNotMatch(messageText(message), /"blockId":/u)
  assert.doesNotMatch(messageText(message), /artifact-224-/u)
})
