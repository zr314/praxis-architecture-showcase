import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  workflowTaskRequestDigestV1,
  type ReviewPlanExecutionRequestV1,
  type WorkflowNodeSpecV1,
  type WorkflowTaskSpecV1,
} from '@praxis/core-sdk'

const REQUEST: ReviewPlanExecutionRequestV1 = {
  sessionId: 'session-1',
  planId: 'plan-1',
  planRevision: 2,
  itemId: 'item-1',
  itemAttemptId: 'attempt-1',
  requestId: 'request-1',
  workflowId: 'workflow-1',
  inputDigest: `sha256:${'a'.repeat(64)}`,
}

test('Workflow task request digest is canonical and covers the complete request and task spec', () => {
  const taskSpec = task()
  const first = workflowTaskRequestDigestV1({ request: REQUEST, taskSpec })
  const reordered = workflowTaskRequestDigestV1({
    request: { ...REQUEST },
    taskSpec: { ...taskSpec, payload: { z: 2, a: 1 } },
  })
  assert.equal(first, reordered)
  assert.notEqual(
    first,
    workflowTaskRequestDigestV1({
      request: { ...REQUEST, planRevision: 3 },
      taskSpec,
    }),
  )
  assert.notEqual(
    first,
    workflowTaskRequestDigestV1({
      request: REQUEST,
      taskSpec: { ...taskSpec, priority: 2 },
    }),
  )
})

test('Workflow task request rejects incomplete Plan execution identity', () => {
  assert.throws(
    () =>
      workflowTaskRequestDigestV1({
        request: { ...REQUEST, itemAttemptId: '' },
        taskSpec: task(),
      }),
    hasCode('PLAN_EXECUTION_BINDING_INVALID'),
  )
})

function task(): WorkflowTaskSpecV1 {
  return {
    schemaVersion: 1,
    node: node(),
    kind: 'agent',
    payload: { a: 1, z: 2 },
    priority: 1,
    readyAt: '2026-09-02T00:00:00.000Z',
    deadlineAt: '2026-09-02T01:00:00.000Z',
    conflictKeys: ['workspace'],
  }
}

function node(): WorkflowNodeSpecV1 {
  return {
    nodeId: 'plan-task-1',
    kind: 'agent_task',
    title: 'Plan task',
    inputRefs: [],
    grantRequest: {
      tools: [],
      skills: [],
      mcpServers: [],
      workspace: 'read',
      network: false,
      mayDelegate: false,
    },
    effect: { class: 'read', requiresApproval: false },
    retry: {
      maxAttempts: 2,
      initialBackoffMs: 100,
      maxBackoffMs: 1_000,
      retryableCodes: [],
    },
    timeout: { totalMs: 60_000, noProgressMs: 30_000, heartbeatMs: 10_000 },
    criteria: [],
  }
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}
