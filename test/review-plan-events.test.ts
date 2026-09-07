import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_REVIEW_POLICY_V1,
  type PlanCreateInputV1,
  REVIEW_PLAN_EVENT_TYPES_V1,
  type ReviewPlanJournalEventV1,
  reduceReviewPlanEventV1,
  reduceSessionEntriesV3,
  reviewPlanHashV1,
  validateReviewPlanEventV1,
  validateSessionEntryV3,
} from '@praxis/core-sdk'

const DIGEST = `sha256:${'a'.repeat(64)}` as const
const DEFINITION: PlanCreateInputV1 = {
  objective: 'Implement and verify the requested change.',
  acceptanceCriteria: [
    {
      id: 'tests',
      description: 'The registered test suite passes.',
      kind: 'mechanical',
      required: true,
      check: {
        checker: 'registered_check',
        checkerId: 'workspace-tests',
        checkerVersion: '1',
        checkerDigest: DIGEST,
        expectedExitCodes: [0],
      },
    },
  ],
  items: [
    {
      id: 'implement',
      title: 'Implement the change',
      criterionIds: ['tests'],
      reviewCheckpoint: true,
    },
  ],
}

const ORIGIN = {
  kind: 'tool' as const,
  invocationId: 'pti_create_1' as const,
  payloadDigest: DIGEST,
}

function event(
  type: ReviewPlanJournalEventV1['type'],
  data: Record<string, unknown>,
  sequence = 2,
): ReviewPlanJournalEventV1 {
  return {
    type,
    sequence,
    revision: 2,
    data: {
      origin: ORIGIN,
      mutationDigest: DIGEST,
      planId: 'rp_1',
      planRevision: 1,
      ...data,
    },
  }
}

function created(): ReviewPlanJournalEventV1 {
  return event('review_plan.created', {
    input: DEFINITION,
    planHash: reviewPlanHashV1({
      objective: DEFINITION.objective,
      acceptanceCriteria: DEFINITION.acceptanceCriteria,
      items: DEFINITION.items,
      reviewPolicy: DEFAULT_REVIEW_POLICY_V1,
    }),
  })
}

test('ReviewPlan event reducer preserves a prepared fence until its exact outcome', () => {
  let projection = reduceReviewPlanEventV1(undefined, created())
  projection = reduceReviewPlanEventV1(
    projection,
    event('review_plan.item_attempt_started', {
      itemId: 'implement',
      itemAttemptId: 'rpa_1',
      attemptNumber: 1,
    }),
  )
  projection = reduceReviewPlanEventV1(
    projection,
    event('review_plan.review_prepared', {
      preparedReview: {
        preparedReviewId: 'rpp_1',
        scope: { kind: 'item', itemId: 'implement' },
        planRevision: 1,
        itemAttemptId: 'rpa_1',
        criterionIds: ['tests'],
        evidenceRefs: ['artifact:result'],
        reviewInputDigest: DIGEST,
        resultSummaryArtifactRef: 'artifact:summary',
        resultSummaryDigest: DIGEST,
        resultSummaryBytes: 12,
        preparedFileInputs: [],
        triggerReasons: ['checkpoint'],
      },
    }),
  )
  projection = reduceReviewPlanEventV1(
    projection,
    event('review_plan.review_requested', {
      preparedReviewId: 'rpp_1',
      reviewRequestId: 'rr_1',
      deterministicDigest: DIGEST,
      deterministicAttemptCount: 1,
      providerAttemptCount: 0,
    }),
  )
  assert.equal(projection.items[0]?.preparedReview?.preparedReviewId, 'rpp_1')
  assert.equal(projection.items[0]?.state, 'review_requested')

  projection = reduceReviewPlanEventV1(
    projection,
    event('review_plan.review_recorded', {
      preparedReviewId: 'rpp_1',
      reviewRequestId: 'rr_1',
      decision: {
        reviewRequestId: 'rr_1',
        decisionArtifactRef: 'artifact:decision',
        decisionDigest: DIGEST,
        verdict: 'accepted',
      },
    }),
  )
  assert.equal(projection.items[0]?.preparedReview, undefined)
  assert.equal(projection.items[0]?.state, 'accepted')
  assert.equal(projection.items[0]?.currentAttempt, undefined)
  assert.deepEqual(projection.items[0]?.acceptedEvidenceRefs, ['artifact:result'])
  assert.equal(projection.items[0]?.acceptedAttemptId, 'rpa_1')
})

test('all 17 ReviewPlan event names are recognized and unknown fields fail closed', () => {
  assert.equal(REVIEW_PLAN_EVENT_TYPES_V1.length, 17)
  for (const type of REVIEW_PLAN_EVENT_TYPES_V1) assert.equal(type.startsWith('review_plan.'), true)
  assert.throws(
    () =>
      validateReviewPlanEventV1({ ...created(), data: { ...created().data, unexpected: true } }),
    hasCode('REVIEW_PLAN_EVENT_INVALID'),
  )
})

test('Session Journal projects ReviewPlan, one-shot control facts, and Review usage', () => {
  const fact = {
    controlEventId: 'control_1',
    actorId: 'actor_1',
    actorBindingDigest: DIGEST,
    sessionId: 'session_1',
    action: 'cancel' as const,
    reasonCode: 'user_cancelled' as const,
    target: {
      kind: 'run' as const,
      runId: 'run_1',
      runStateDigest: DIGEST,
      planBinding: null,
    },
    targetDigest: DIGEST,
    challengeId: 'pcc_1' as const,
    challengeDigest: DIGEST,
    tokenDigest: DIGEST,
    issuedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-09-01T00:05:00.000Z',
    runId: 'run_1',
    providerTurnId: 'turn_1',
  }
  const entries = [
    journalEntry(1, 1, 'session.created', {
      cwd: 'D:/workspace',
      provider: 'fixture',
      model: 'fixture-model',
      name: 'Review session',
      labels: [],
    }),
    journalEntry(2, 2, created().type, created().data),
    journalEntry(3, 3, 'control.authorized', {
      authorizationRequestId: 'auth_1',
      challengeEnvelopeDigest: DIGEST,
      fact,
    }),
    journalEntry(4, 4, 'control.turn_bound', {
      controlEventId: 'control_1',
      runId: 'run_1',
      providerTurnId: 'turn_1',
    }),
    journalEntry(5, 5, 'control.consumed', {
      controlEventId: 'control_1',
      action: 'cancel',
      targetDigest: DIGEST,
    }),
    journalEntry(6, 6, 'review_budget.reserved', {
      reviewRequestId: 'rr_1',
      attemptNumber: 1,
      reservation: { inputTokens: 100, outputTokens: 50, costUsd: 0.02 },
    }),
    journalEntry(7, 7, 'review_budget.settled', {
      reviewRequestId: 'rr_1',
      attemptNumber: 1,
      disposition: 'actual',
      usage: { inputTokens: 80, outputTokens: 20, costUsd: 0.01 },
    }),
  ].map(validateSessionEntryV3)

  const projection = reduceSessionEntriesV3(entries)
  assert.equal(projection.reviewPlan?.planId, 'rp_1')
  assert.equal(projection.reviewControls?.[0]?.state, 'consumed')
  assert.equal(projection.reviewBudgets?.[0]?.state, 'settled')
  assert.equal(projection.snapshot.usage.turns, 0)
  assert.equal(projection.snapshot.usage.inputTokens, 80)
  assert.equal(projection.snapshot.usage.outputTokens, 20)
})

function journalEntry(
  sequence: number,
  revision: number,
  type: string,
  data: Readonly<Record<string, unknown>>,
) {
  return {
    schemaVersion: 3,
    entryId: `entry_${sequence}`,
    sessionId: 'session_1',
    sequence,
    revision,
    timestamp: `2026-09-01T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    type,
    data,
  }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
