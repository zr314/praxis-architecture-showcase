import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPlanAttemptTransitionV1,
  assertPlanStateTransitionV1,
  assertPlanStepTransitionV1,
  readyPlanStepIdsV1,
  validatePlanGraphV1,
} from '@praxis/core-sdk'

const DIGEST = `sha256:${'a'.repeat(64)}` as const

test('PlanGraphV1 is bounded, immutable, and preserves complete step and attempt history fields', () => {
  const input = fixture()
  const graph = validatePlanGraphV1(input)

  assert.equal(Object.isFrozen(graph), true)
  assert.equal(Object.isFrozen(graph.steps[0]?.criteria), true)
  assert.deepEqual(graph.steps[0], {
    stepId: 'step-read',
    title: 'Read repository evidence',
    order: 0,
    state: 'pending',
    dependencies: [],
    access: { mode: 'read_only', paths: ['src/**'] },
    capabilities: ['tool:read'],
    conflictKeys: ['workspace:read'],
    criteria: [
      {
        criterionId: 'criterion-read',
        kind: 'file',
        description: 'Return one digest-backed file reference.',
        ref: 'src/index.ts',
        expectedDigest: DIGEST,
      },
    ],
    budget: {
      maxTurns: 4,
      maxToolCalls: 8,
      maxTokens: 2_000,
      maxChildRuns: 0,
      maxParallelChildren: 0,
      maxDepth: 0,
    },
    maxAttempts: 2,
    attemptIds: [],
  })
  assert.deepEqual(graph.attempts[0], {
    attemptId: 'attempt-review-1',
    stepId: 'step-review',
    ordinal: 1,
    state: 'execution_failed',
    childRunId: 'child-review-1',
    resultRef: 'result://review-1',
    resultDigest: DIGEST,
  })
  assert.throws(() => (graph.steps as unknown[]).push({}), TypeError)
})

test('ready is a deterministic derived view and only verified succeeded dependencies release work', () => {
  const graph = validatePlanGraphV1(fixture())
  assert.deepEqual(readyPlanStepIdsV1(graph), ['step-read'])

  const released = fixture()
  released.steps[0]!.state = 'succeeded'
  assert.deepEqual(readyPlanStepIdsV1(validatePlanGraphV1(released)), ['step-summarize'])

  const missing = fixture()
  missing.steps[1]!.dependencies = ['step-absent']
  assert.throws(
    () => readyPlanStepIdsV1(validatePlanGraphV1(missing)),
    hasCode('PLAN_GRAPH_DEPENDENCY_MISSING'),
  )
})

test('plan, step, and attempt transition guards forbid worker shortcuts and require explicit retry evidence', () => {
  assert.doesNotThrow(() => assertPlanStateTransitionV1('draft', 'running'))
  assert.doesNotThrow(() => assertPlanStepTransitionV1('running', 'verifying'))
  assert.doesNotThrow(() => assertPlanStepTransitionV1('verifying', 'succeeded'))
  assert.throws(
    () => assertPlanStepTransitionV1('running', 'succeeded'),
    hasCode('PLAN_TRANSITION_INVALID'),
  )
  assert.throws(
    () => assertPlanStepTransitionV1('failed', 'pending', { retryApproved: true }),
    hasCode('PLAN_TRANSITION_INVALID'),
  )
  assert.doesNotThrow(() =>
    assertPlanStepTransitionV1('failed', 'pending', {
      retryApproved: true,
      createsNewAttempt: true,
    }),
  )
  assert.doesNotThrow(() => assertPlanAttemptTransitionV1('running', 'execution_succeeded'))
  assert.doesNotThrow(() => assertPlanAttemptTransitionV1('execution_succeeded', 'verifying'))
  assert.throws(
    () => assertPlanAttemptTransitionV1('execution_succeeded', 'verified'),
    hasCode('PLAN_TRANSITION_INVALID'),
  )
})

test('PlanGraphV1 rejects unknown fields, oversized text, inline-shaped results, and inconsistent attempt indexes', () => {
  assert.throws(
    () => validatePlanGraphV1({ ...fixture(), authorityGrant: ['write'] }),
    hasCode('PLAN_GRAPH_INVALID'),
  )
  assert.throws(
    () => validatePlanGraphV1({ ...fixture(), objective: 'x'.repeat(300_000) }),
    hasCode('PLAN_GRAPH_OVERSIZED'),
  )

  const missingDigest = fixture()
  delete (missingDigest.attempts[0] as { resultDigest?: string }).resultDigest
  assert.throws(() => validatePlanGraphV1(missingDigest), hasCode('PLAN_GRAPH_INVALID'))

  const dangling = fixture()
  dangling.steps[2]!.attemptIds = []
  assert.throws(() => validatePlanGraphV1(dangling), hasCode('PLAN_GRAPH_INVALID'))

  const duplicateOrder = fixture()
  duplicateOrder.steps[1]!.order = 0
  assert.throws(() => validatePlanGraphV1(duplicateOrder), hasCode('PLAN_GRAPH_INVALID'))
})

function fixture() {
  return {
    schemaVersion: 1,
    planId: 'plan-fixed',
    revision: 1,
    objective: 'Inspect and summarize the repository.',
    state: 'running',
    steps: [
      step('step-read', 0, []),
      step('step-summarize', 1, ['step-read']),
      {
        ...step('step-review', 2, ['step-summarize']),
        state: 'failed',
        attemptIds: ['attempt-review-1'],
      },
    ],
    attempts: [
      {
        attemptId: 'attempt-review-1',
        stepId: 'step-review',
        ordinal: 1,
        state: 'execution_failed',
        childRunId: 'child-review-1',
        resultRef: 'result://review-1',
        resultDigest: DIGEST,
      },
    ],
  }
}

function step(stepId: string, order: number, dependencies: string[]) {
  return {
    stepId,
    title: stepId === 'step-read' ? 'Read repository evidence' : stepId,
    order,
    state: 'pending',
    dependencies,
    access: { mode: 'read_only', paths: ['src/**'] },
    capabilities: ['tool:read'],
    conflictKeys: ['workspace:read'],
    criteria: [
      {
        criterionId: `criterion-${stepId.replace('step-', '')}`,
        kind: 'file',
        description: 'Return one digest-backed file reference.',
        ref: 'src/index.ts',
        expectedDigest: DIGEST,
      },
    ],
    budget: {
      maxTurns: 4,
      maxToolCalls: 8,
      maxTokens: 2_000,
      maxChildRuns: 0,
      maxParallelChildren: 0,
      maxDepth: 0,
    },
    maxAttempts: 2,
    attemptIds: [],
  }
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
