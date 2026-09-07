import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canonicalDigestV1,
  canonicalJsonV1,
  reviewCriterionDigestV1,
  validatePlanCreateInputV1,
  validateReviewCriterionV1,
  validateReviewPlanProjectionV1,
  type PlanCreateInputV1,
  type ReviewCriterionV1,
} from '@praxis/core-sdk'

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

const mechanicalCriterion: ReviewCriterionV1 = {
  id: 'tests',
  description: 'The registered test suite passes.',
  kind: 'mechanical',
  required: true,
  check: {
    checker: 'registered_check',
    checkerId: 'workspace-tests',
    checkerVersion: '1',
    checkerDigest: `sha256:${'1'.repeat(64)}`,
    expectedExitCodes: [0],
  },
}

function validPlan(overrides: Record<string, unknown> = {}): PlanCreateInputV1 {
  return {
    objective: 'Ship a verified change.',
    acceptanceCriteria: [mechanicalCriterion],
    items: [
      {
        id: 'implement',
        title: 'Implement and verify the change',
        criterionIds: ['tests'],
        reviewCheckpoint: true,
      },
    ],
    ...overrides,
  } as PlanCreateInputV1
}

test('canonical JSON sorts keys and hashes the exact UTF-8 representation', () => {
  const left = { z: [3, { b: false, a: null }], a: '中' }
  const right = { a: '中', z: [3, { a: null, b: false }] }
  assert.equal(canonicalJsonV1(left), '{"a":"中","z":[3,{"a":null,"b":false}]}')
  assert.equal(canonicalJsonV1(left), canonicalJsonV1(right))
  assert.equal(canonicalDigestV1(left), canonicalDigestV1(right))
})

test('canonical JSON rejects non-JSON, non-finite, non-plain, shared, and cyclic values', () => {
  assert.throws(() => canonicalJsonV1(undefined), hasCode('CANONICAL_JSON_INVALID'))
  assert.throws(() => canonicalJsonV1(Number.NaN), hasCode('CANONICAL_JSON_INVALID'))
  assert.throws(() => canonicalJsonV1(new Date()), hasCode('CANONICAL_JSON_INVALID'))
  const shared = { value: 1 }
  assert.throws(() => canonicalJsonV1([shared, shared]), hasCode('CANONICAL_JSON_INVALID'))
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  assert.throws(() => canonicalJsonV1(cyclic), hasCode('CANONICAL_JSON_INVALID'))
})

test('review plan domain requires typed mechanical checks', () => {
  assert.throws(
    () =>
      validateReviewCriterionV1({
        id: 'tests',
        description: 'Tests pass.',
        kind: 'mechanical',
        required: true,
      }),
    hasCode('REVIEW_CRITERION_INVALID'),
  )
  assert.throws(
    () =>
      validateReviewCriterionV1({
        id: 'semantic',
        description: 'The result is appropriate.',
        kind: 'semantic',
        required: true,
        check: mechanicalCriterion.check,
      }),
    hasCode('REVIEW_CRITERION_INVALID'),
  )
})

test('registered checks and content rules require exact ID, version, and digest tuples', () => {
  assert.throws(
    () =>
      validateReviewCriterionV1({
        ...mechanicalCriterion,
        check: {
          checker: 'registered_check',
          checkerId: 'workspace-tests',
          checkerVersion: '1',
          expectedExitCodes: [0],
        },
      }),
    hasCode('REVIEW_CRITERION_INVALID'),
  )
  const digest = reviewCriterionDigestV1(mechanicalCriterion)
  assert.equal(digest, reviewCriterionDigestV1(structuredClone(mechanicalCriterion)))
})

test('review plan creation rejects DAG and unknown fields', () => {
  assert.throws(
    () => validatePlanCreateInputV1(validPlan({ dependencies: ['other'] })),
    hasCode('PLAN_CREATE_INVALID'),
  )
  assert.throws(
    () => validatePlanCreateInputV1(validPlan({ edges: [] })),
    hasCode('PLAN_CREATE_INVALID'),
  )
})

test('review plan validates required criterion coverage and immutable prepared fences', () => {
  assert.throws(
    () =>
      validatePlanCreateInputV1({
        ...validPlan(),
        items: [{ id: 'implement', title: 'Implement', criterionIds: [], reviewCheckpoint: false }],
      }),
    hasCode('PLAN_CREATE_INVALID'),
  )

  const projection = validateReviewPlanProjectionV1({
    schemaVersion: 1,
    planId: 'rp_1',
    revision: 1,
    objective: 'Ship a verified change.',
    objectiveDigest: canonicalDigestV1('Ship a verified change.'),
    state: 'active',
    policy: {
      semantic: 'final_and_checkpoints',
      maxRepairAttemptsPerItem: 2,
      maxReplans: 1,
      maxReviewAttempts: 2,
      maxNoProgressAttempts: 2,
    },
    criteria: [
      {
        ...mechanicalCriterion,
        definitionDigest: reviewCriterionDigestV1(mechanicalCriterion),
        status: 'active',
      },
    ],
    items: [
      {
        id: 'implement',
        title: 'Implement',
        order: 0,
        criterionIds: ['tests'],
        state: 'running',
        reviewCheckpoint: true,
        attemptCount: 1,
        currentAttempt: {
          itemAttemptId: 'rpa_1',
          attemptNumber: 1,
          state: 'open',
        },
        preparedReview: {
          preparedReviewId: 'rpp_1',
          scope: { kind: 'item', itemId: 'implement' },
          planRevision: 1,
          itemAttemptId: 'rpa_1',
          criterionIds: ['tests'],
          evidenceRefs: ['artifact:result'],
          reviewInputDigest: `sha256:${'2'.repeat(64)}`,
          resultSummaryArtifactRef: 'artifact:summary',
          resultSummaryDigest: `sha256:${'3'.repeat(64)}`,
          resultSummaryBytes: 12,
          preparedFileInputs: [],
          triggerReasons: ['checkpoint'],
        },
        taskRefs: [],
        evidenceRefs: ['artifact:result'],
      },
    ],
    attemptCount: 1,
    replanCount: 0,
    noProgressCount: 0,
  })
  assert.equal(projection.items[0]?.preparedReview?.preparedReviewId, 'rpp_1')
})
