import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyWorkflowEventV1,
  initialWorkflowProjectionV1,
  type WorkflowEventDataV1,
  type WorkflowEventV1,
  type WorkflowNodeSpecV1,
  type WorkflowSpecV1,
} from '@praxis/core-sdk'

test('execution.task_admitted adds a node and attempt without consuming graph mutation budget', () => {
  const spec = workflowSpec()
  let projection = initialWorkflowProjectionV1(spec)
  projection = apply(projection, { type: 'workflow.created', spec })
  projection = apply(projection, { type: 'workflow.started' })
  const node = planNode()
  projection = apply(projection, {
    type: 'execution.task_admitted',
    requestId: 'request-1',
    requestDigest: `sha256:${'a'.repeat(64)}`,
    node,
    attempt: {
      attemptId: 'workflow-attempt-1',
      nodeId: node.nodeId,
      ordinal: 1,
      state: 'scheduled',
    },
  })
  assert.equal(projection.graphMutations, 0)
  assert.equal(projection.revision, 1)
  assert.equal(projection.nodes.at(-1)?.nodeId, node.nodeId)
  assert.equal(projection.attempts.at(-1)?.attemptId, 'workflow-attempt-1')
  assert.throws(
    () =>
      apply(projection, {
        type: 'execution.task_admitted',
        requestId: 'request-1',
        requestDigest: `sha256:${'a'.repeat(64)}`,
        node,
        attempt: {
          attemptId: 'workflow-attempt-2',
          nodeId: node.nodeId,
          ordinal: 1,
          state: 'scheduled',
        },
      }),
    hasCode('WORKFLOW_TASK_REQUEST_CONFLICT'),
  )
})

function apply(
  projection: ReturnType<typeof initialWorkflowProjectionV1>,
  data: WorkflowEventDataV1,
) {
  const event: WorkflowEventV1 = {
    schemaVersion: 1,
    eventId: `event-${projection.sequence + 1}`,
    workflowId: projection.workflowId,
    runId: projection.runId,
    sequence: projection.sequence + 1,
    occurredAt: '2026-09-02T00:00:00.000Z',
    data,
  }
  return applyWorkflowEventV1(projection, event)
}

function workflowSpec(): WorkflowSpecV1 {
  return {
    schemaVersion: 1,
    workflowId: 'workflow-1',
    runId: 'run-1',
    sessionId: 'session-1',
    workspace: process.cwd(),
    objective: 'Execute plan work.',
    modePolicy: 'auto',
    topology: 'single_agent',
    revision: 1,
    nodes: [rootNode()],
    edges: [],
    completion: 'all_required',
    budget: {
      maxWallClockMs: 60_000,
      maxTokens: 1_000,
      maxToolCalls: 10,
      maxAgentTasks: 10,
      maxParallelTasks: 2,
    },
    maxGraphMutations: 1,
    createdAt: '2026-09-02T00:00:00.000Z',
  }
}

function rootNode(): WorkflowNodeSpecV1 {
  return { ...planNode(), nodeId: 'root', title: 'Root' }
}

function planNode(): WorkflowNodeSpecV1 {
  return {
    nodeId: 'plan-task-1',
    kind: 'agent_task',
    title: 'Plan task',
    required: false,
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
