import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type {
  ReviewPlanExecutionRequestV1,
  WorkflowNodeSpecV1,
  WorkflowSpecV1,
  WorkflowTaskSpecV1,
} from '@praxis/core-sdk'
import { SqliteWorkflowAuthorityV1 } from '../apps/runtime/src/workflow/sqliteWorkflowAuthority.js'

test('Workflow Authority admits one Task for twenty concurrent identical logical requests', async () => {
  await withAuthority(async ({ authority, root }) => {
    const input = admission()
    const results = await Promise.all(
      Array.from({ length: 20 }, () => authority.admitTaskForRequest(input)),
    )
    assert.equal(new Set(results.map(({ task }) => task.taskId)).size, 1)
    assert.equal(results.filter(({ replayed }) => !replayed).length, 1)
    const tasks = await authority.listTasks({ workflowId: 'workflow-plan' })
    assert.equal(tasks.length, 1)
    assert.deepEqual(tasks[0]?.executionBinding, {
      sessionId: 'session-plan',
      planId: 'plan-1',
      planRevision: 1,
      itemId: 'item-1',
      itemAttemptId: 'item-attempt-1',
      requestId: 'request-1',
    })
    const projection = await authority.get('workflow-plan')
    assert.equal(projection.graphMutations, 0)
    assert.equal(projection.nodes.filter(({ nodeId }) => nodeId === 'planned-task').length, 1)
    assert.equal(projection.attempts.length, 1)

    authority.close()
    const reopened = new SqliteWorkflowAuthorityV1(root)
    await reopened.initialize()
    const replay = await reopened.admitTaskForRequest(input)
    assert.equal(replay.replayed, true)
    assert.equal(replay.task.taskId, results[0]?.task.taskId)
    assert.equal(
      (await reopened.getTaskByRequestId('workflow-plan', 'request-1'))?.taskId,
      replay.task.taskId,
    )
    await assert.rejects(
      reopened.admitTaskForRequest({
        ...input,
        taskSpec: { ...input.taskSpec, priority: 2 },
      }),
      hasCode('WORKFLOW_TASK_REQUEST_CONFLICT'),
    )
    reopened.close()
  })
})

async function withAuthority(
  run: (input: { authority: SqliteWorkflowAuthorityV1; root: string }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-request-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await authority.create(workflowSpec(), 'create-workflow')
    await run({ authority, root })
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
}

function admission(): {
  request: ReviewPlanExecutionRequestV1
  taskSpec: WorkflowTaskSpecV1
} {
  return {
    request: {
      sessionId: 'session-plan',
      planId: 'plan-1',
      planRevision: 1,
      itemId: 'item-1',
      itemAttemptId: 'item-attempt-1',
      requestId: 'request-1',
      workflowId: 'workflow-plan',
      inputDigest: `sha256:${'a'.repeat(64)}`,
    },
    taskSpec: {
      schemaVersion: 1,
      node: node('planned-task'),
      kind: 'agent',
      payload: { objective: 'Do planned work.' },
      priority: 1,
      readyAt: '2026-09-02T00:00:00.000Z',
      deadlineAt: '2026-09-02T01:00:00.000Z',
      conflictKeys: ['workspace'],
    },
  }
}

function workflowSpec(): WorkflowSpecV1 {
  return {
    schemaVersion: 1,
    workflowId: 'workflow-plan',
    runId: 'run-plan',
    sessionId: 'session-plan',
    workspace: process.cwd(),
    objective: 'Execute plan.',
    modePolicy: 'auto',
    topology: 'single_agent',
    revision: 1,
    nodes: [node('root')],
    edges: [],
    completion: 'all_required',
    budget: {
      maxWallClockMs: 60_000,
      maxTokens: 10_000,
      maxToolCalls: 100,
      maxAgentTasks: 100,
      maxParallelTasks: 4,
    },
    maxGraphMutations: 0,
    createdAt: '2026-09-02T00:00:00.000Z',
  }
}

function node(nodeId: string): WorkflowNodeSpecV1 {
  return {
    nodeId,
    kind: 'agent_task',
    title: nodeId,
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
