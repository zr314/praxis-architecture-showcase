import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  PlanToolInvocationContextV1,
  PreparedToolInvocation,
  SessionProjectionV3,
  ToolResult,
} from '@praxis/core-sdk'
import {
  type PlanControlServicePortV1,
  RootToolExecutionBrokerV1,
} from '../apps/runtime/src/review-plan/index.js'

test('Direct optional work invokes unchanged and writes no Plan evidence', async () => {
  const harness = broker(projection())
  let invoked = 0
  const result = await harness.broker.execute(prepared('read', 'read'), signal(), async () => {
    invoked += 1
    return success()
  })
  assert.equal(result.ok, true)
  assert.equal(invoked, 1)
  assert.deepEqual(harness.calls, [])
  assert.equal(harness.artifacts.length, 0)
})

test('required policy rejects work before Plan creation but permits local planning reads', async () => {
  const snapshot = projection('required')
  const harness = broker(snapshot)
  let invoked = 0
  await assert.rejects(
    harness.broker.execute(prepared('write', 'write'), signal(), async () => {
      invoked += 1
      return success()
    }),
    hasCode('PLAN_REQUIRED_BEFORE_EXECUTION'),
  )
  assert.equal(invoked, 0)
  await harness.broker.execute(prepared('read', 'read'), signal(), async () => {
    invoked += 1
    return success()
  })
  assert.equal(invoked, 1)
})

test('optional Run ignores legacy ReviewPlan fences without bypassing the effect broker', async () => {
  const prior = plannedProjection()
  const optional = { ...prior, snapshot: projection('optional').snapshot }
  let effectCalled = false
  const harness = broker(optional, [], {
    execute: async (_prepared, _signal, invoke) => {
      effectCalled = true
      return invoke()
    },
    executeBound: async () => {
      throw new Error('Optional work must not require Plan execution binding')
    },
  })
  const result = await harness.broker.execute(prepared('read', 'read'), signal(), async () =>
    success(),
  )
  assert.equal(result.ok, true)
  assert.deepEqual(harness.calls, [])
  assert.equal(effectCalled, true)
})

test('planned Root Tool execution records one stable request and result under the focused attempt', async () => {
  const harness = broker(plannedProjection())
  const result = await harness.broker.execute(prepared('read', 'read'), signal(), async () =>
    success(),
  )
  assert.equal(result.ok, true)
  assert.deepEqual(
    harness.calls.map(({ kind }) => kind),
    ['requested', 'recorded'],
  )
  assert.equal(harness.calls[0]?.input.requestId, harness.calls[1]?.input.requestId)
  assert.equal(harness.calls[0]?.input.itemAttemptId, 'attempt-1')
  assert.equal(harness.artifacts.length, 1)
  const evidence = harness.artifacts[0] as Record<string, unknown>
  assert.equal(evidence.itemAttemptId, 'attempt-1')
  assert.equal(evidence.planRevision, 1)
  assert.equal(typeof evidence.startedAt, 'string')
  assert.match(JSON.stringify(evidence.inputEvidence), /file\.txt/u)
})

test('Root evidence input uses the existing declared-secret persistence policy', async () => {
  const harness = broker(plannedProjection(), ['private-fixture-value'])
  const call = {
    ...prepared('read', 'read'),
    input: { path: 'file.txt', credential: 'private-fixture-value' },
  }
  await harness.broker.execute(call, signal(), async () => success())
  const evidence = harness.artifacts[0] as Record<string, unknown>
  assert.doesNotMatch(JSON.stringify(evidence.inputEvidence), /private-fixture-value/u)
  assert.match(JSON.stringify(evidence.inputEvidence), /redacted/u)
})

test('missing focused attempt explains legal repair steps without invoking work', async () => {
  const prior = plannedProjection()
  const plan = prior.reviewPlan!
  const { currentAttempt: _attempt, ...item } = plan.items[0]!
  const { focusedRootAttemptId: _focus, ...unfocused } = plan
  const harness = broker({
    ...prior,
    reviewPlan: { ...unfocused, items: [{ ...item, state: 'accepted' }] },
  })
  let invoked = false
  await assert.rejects(
    harness.broker.execute(prepared('read', 'read'), signal(), async () => {
      invoked = true
      return success()
    }),
    (error: unknown) => {
      assert.equal(Reflect.get(error as object, 'code'), 'PLAN_ITEM_ATTEMPT_REQUIRED')
      const message = String(Reflect.get(error as object, 'message'))
      assert.match(message, /plan\.update to add a repair Item/u)
      assert.match(message, /Changing only the objective does not create an attempt/u)
      assert.match(message, /explain the block and end the turn/u)
      return true
    },
  )
  assert.equal(invoked, false)
  assert.deepEqual(harness.calls, [])
})

test('prepared review fence rejects Tool execution before invoking work', async () => {
  const fenced = plannedProjection()
  const fencedProjection: SessionProjectionV3 = {
    ...fenced,
    reviewPlan: {
      ...fenced.reviewPlan!,
      items: [
        {
          ...fenced.reviewPlan!.items[0]!,
          preparedReview: {
            preparedReviewId: 'prepared-1',
            scope: { kind: 'item', itemId: 'item-1' },
            planRevision: 1,
            itemAttemptId: 'attempt-1',
            criterionIds: ['criterion-1'],
            evidenceRefs: [],
            reviewInputDigest: `sha256:${'a'.repeat(64)}`,
            resultSummaryArtifactRef: 'artifact-summary',
            resultSummaryDigest: `sha256:${'b'.repeat(64)}`,
            resultSummaryBytes: 1,
            preparedFileInputs: [],
            triggerReasons: ['checkpoint'],
          },
        },
      ],
    },
  }
  const harness = broker(fencedProjection)
  let invoked = false
  await assert.rejects(
    harness.broker.execute(prepared('read', 'read'), signal(), async () => {
      invoked = true
      return success()
    }),
    hasCode('PLAN_REVIEW_ALREADY_PREPARED'),
  )
  assert.equal(invoked, false)
})

function broker(
  session: SessionProjectionV3,
  sensitiveValues: readonly string[] = [],
  effects?: ConstructorParameters<typeof RootToolExecutionBrokerV1>[0]['effects'],
) {
  const calls: Array<{ kind: string; input: Record<string, unknown> }> = []
  const artifacts: unknown[] = []
  const unsupported = () => Promise.reject(new Error('unused'))
  const control = {
    create: unsupported,
    update: unsupported,
    progress: unsupported,
    prepareReview: unsupported,
    abandon: unsupported,
    requestExecution: unsupported,
    bindExecution: unsupported,
    recordRootToolRequest(input: Record<string, unknown>) {
      calls.push({ kind: 'requested', input })
      return Promise.resolve({})
    },
    recordRootToolResult(input: Record<string, unknown>) {
      calls.push({ kind: 'recorded', input })
      return Promise.resolve({})
    },
    requestSemanticReview: unsupported,
    applyReviewDecision: unsupported,
    resolveTrustedBlock: unsupported,
  } as unknown as PlanControlServicePortV1
  return {
    broker: new RootToolExecutionBrokerV1({
      ...(effects === undefined ? {} : { effects }),
      journal: { loadProjection: () => Promise.resolve(session) },
      control,
      artifacts: {
        put(value: unknown) {
          artifacts.push(value)
          return Promise.resolve({
            artifactId: 'artifact-result',
            digest: `sha256:${'c'.repeat(64)}`,
            mimeType: 'application/json',
            bytes: 1,
          })
        },
      },
      workflowId: 'workflow-1',
      sensitiveValues,
    }),
    calls,
    artifacts,
  }
}

function prepared(name: string, sideEffect: 'read' | 'write'): PreparedToolInvocation {
  return {
    name,
    input: { path: 'file.txt' },
    cwd: process.cwd(),
    descriptor: {
      sideEffect,
      parallelSafe: false,
      conflictKey: 'workspace',
      maxInlineBytes: 1024,
    },
    executionContext: { invocation: invocation() },
  }
}

function invocation(): PlanToolInvocationContextV1 {
  return {
    invocationId: 'pti_root-tool',
    sessionId: 'session-1',
    runId: 'run-1',
    providerTurnId: 'turn-1',
    providerToolCallId: 'call-1',
  }
}

function projection(planPolicy: 'optional' | 'required' = 'optional'): SessionProjectionV3 {
  return {
    sessionId: 'session-1',
    revision: 1,
    sequence: 1,
    snapshot: {
      messages: [],
      runs: [
        {
          runId: 'run-1',
          clientRequestId: 'request-run-1',
          state: 'running',
          usage: {},
          planPolicy,
        },
      ],
      checkpoints: [],
      usage: { turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, subagents: 0 },
    },
    updatedAt: '2026-09-02T00:00:00.000Z',
  } as unknown as SessionProjectionV3
}

function plannedProjection(): SessionProjectionV3 {
  const session = projection('required')
  return {
    ...session,
    reviewPlan: {
      schemaVersion: 1,
      planId: 'plan-1',
      revision: 1,
      objective: 'Do work.',
      objectiveDigest: `sha256:${'a'.repeat(64)}`,
      state: 'active',
      policy: {
        semantic: 'final_and_checkpoints',
        maxRepairAttemptsPerItem: 2,
        maxReplans: 1,
        maxReviewAttempts: 2,
        maxNoProgressAttempts: 2,
      },
      criteria: [],
      items: [
        {
          id: 'item-1',
          title: 'Work',
          order: 0,
          criterionIds: ['criterion-1'],
          state: 'running',
          reviewCheckpoint: true,
          attemptCount: 1,
          currentAttempt: {
            itemAttemptId: 'attempt-1',
            attemptNumber: 1,
            state: 'open',
          },
          taskRefs: [],
          evidenceRefs: [],
        },
      ],
      attemptCount: 1,
      replanCount: 0,
      noProgressCount: 0,
      focusedRootAttemptId: 'attempt-1',
    },
  }
}

function signal() {
  return new AbortController().signal
}

function success(): ToolResult {
  return { ok: true, summary: 'ok', output: { value: 1 } }
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}
