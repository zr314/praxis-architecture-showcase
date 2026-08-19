import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { WorkflowTaskV1 } from '@praxis/core-sdk'
import { SqliteWorkflowAuthorityV1 } from '../apps/runtime/src/workflow/sqliteWorkflowAuthority.js'
import { WorkflowOrchestratorV1 } from '../apps/runtime/src/workflow/workflowOrchestrator.js'
import { rootNode, workflowSpec } from './fixtures/workflow.js'

test('SQLite workflow authority atomically persists events, tasks and completion across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-'))
  const first = new SqliteWorkflowAuthorityV1(root)
  try {
    await first.initialize()
    let projection = await first.create(workflowSpec(), 'create-1')
    assert.equal(projection.state, 'running')
    const task = workflowTask()
    projection = await first.transact({
      transactionId: 'schedule-1',
      workflowId: projection.workflowId,
      expectedSequence: projection.sequence,
      occurredAt: task.createdAt,
      events: [
        { type: 'node.state_changed', nodeId: 'root', state: 'admitted' },
        { type: 'node.state_changed', nodeId: 'root', state: 'scheduled' },
        {
          type: 'attempt.created',
          attempt: { attemptId: task.attemptId, nodeId: 'root', ordinal: 1, state: 'scheduled' },
        },
      ],
      enqueueTasks: [task],
      outbox: [
        {
          messageId: 'message-1',
          workflowId: projection.workflowId,
          topic: 'workflow.task.ready',
          key: task.taskId,
          payload: { taskId: task.taskId },
          availableAt: task.readyAt,
        },
      ],
    })
    const duplicate = await first.transact({
      transactionId: 'schedule-1',
      workflowId: projection.workflowId,
      expectedSequence: 0,
      occurredAt: task.createdAt,
      events: [],
    })
    assert.equal(duplicate.sequence, projection.sequence)
    const claim = await first.claim('worker-1', { now: task.readyAt, leaseMs: 10_000 })
    assert.equal(claim?.task.taskId, task.taskId)
    assert.equal((await first.claim('worker-2', { now: task.readyAt }))?.task, undefined)
    await first.heartbeat(task.taskId, claim!.lease.token, true, '2026-08-06T00:00:01.000Z')
    projection = await first.get(task.workflowId)
    projection = await first.transact({
      transactionId: 'complete-1',
      workflowId: task.workflowId,
      expectedSequence: projection.sequence,
      occurredAt: '2026-08-06T00:00:02.000Z',
      events: [
        { type: 'node.state_changed', nodeId: 'root', state: 'running' },
        {
          type: 'attempt.state_changed',
          attemptId: task.attemptId,
          state: 'running',
          at: '2026-08-06T00:00:02.000Z',
        },
        {
          type: 'attempt.state_changed',
          attemptId: task.attemptId,
          state: 'succeeded',
          at: '2026-08-06T00:00:02.000Z',
        },
        { type: 'node.state_changed', nodeId: 'root', state: 'succeeded' },
        { type: 'workflow.terminal', state: 'completed' },
      ],
      acknowledgeTask: { taskId: task.taskId, leaseToken: claim!.lease.token, state: 'completed' },
    })
    assert.equal(projection.state, 'completed')
    first.close()

    const restarted = new SqliteWorkflowAuthorityV1(root)
    await restarted.initialize()
    assert.equal((await restarted.get(task.workflowId)).state, 'completed')
    assert.equal((await restarted.events(task.workflowId)).length, projection.sequence)
    restarted.close()
  } finally {
    first.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('expired leases retry safe effects with a new Attempt and keep non-idempotent effects unknown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-recovery-'))
  const store = new SqliteWorkflowAuthorityV1(root)
  try {
    await store.initialize()
    await scheduleAndClaim(
      store,
      workflowTask({ effect: { class: 'read', requiresApproval: false } }),
      'safe',
    )
    const safe = await store.recoverExpired('2026-08-06T00:00:02.000Z')
    assert.equal(safe[0]?.decision, 'retry')
    const safeProjection = await store.get('workflow-1')
    assert.equal(safeProjection.attempts.length, 2)
    assert.equal(safeProjection.nodes[0]?.state, 'scheduled')
    store.close()

    const secondRoot = join(root, 'unsafe')
    const unsafeStore = new SqliteWorkflowAuthorityV1(secondRoot)
    await unsafeStore.initialize()
    const unsafeSpec = {
      ...workflowSpec(),
      workflowId: 'workflow-unsafe',
      runId: 'run-unsafe',
      nodes: [
        {
          ...rootNode(),
          effect: { class: 'external_non_idempotent' as const, requiresApproval: true },
        },
      ],
    }
    const unsafeTask = workflowTask({
      workflowId: 'workflow-unsafe',
      runId: 'run-unsafe',
      effect: { class: 'external_non_idempotent', requiresApproval: true },
    })
    await scheduleAndClaim(unsafeStore, unsafeTask, 'unsafe', unsafeSpec)
    const unsafe = await unsafeStore.recoverExpired('2026-08-06T00:00:02.000Z')
    assert.equal(unsafe[0]?.decision, 'unknown')
    assert.equal((await unsafeStore.get('workflow-unsafe')).nodes[0]?.state, 'unknown')
    const resolved = await unsafeStore.resolveUnknown(
      'workflow-unsafe',
      'root',
      'failed',
      'OPERATOR_CONFIRMED_NO_EFFECT',
      '2026-08-06T00:00:03.000Z',
    )
    assert.equal(resolved.nodes[0]?.state, 'failed')
    const retried = await unsafeStore.retryNode(
      'workflow-unsafe',
      'root',
      '2026-08-06T00:00:04.000Z',
    )
    assert.equal(retried.nodes[0]?.state, 'scheduled')
    assert.equal(retried.attempts.length, 2)
    assert.equal(
      (
        await unsafeStore.claim('operator-retry', {
          workflowId: 'workflow-unsafe',
          now: '2026-08-06T00:00:04.000Z',
        })
      )?.task.attemptId,
      retried.attempts[1]?.attemptId,
    )
    unsafeStore.close()
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('expired child leases are cancelled instead of retried after the parent workflow is terminal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-terminal-recovery-'))
  const store = new SqliteWorkflowAuthorityV1(root)
  try {
    await store.initialize()
    const childNode = {
      ...rootNode(),
      nodeId: 'child',
      title: 'Child AgentTask',
      profileRef: { id: 'explorer', version: 1 },
      grantRequest: { ...rootNode().grantRequest, workspace: 'read' as const, mayDelegate: false },
      effect: { class: 'read' as const, requiresApproval: false },
    }
    const spec = workflowSpec('auto', [rootNode(), childNode])
    const task = workflowTask({
      taskId: 'task-child',
      nodeId: 'child',
      attemptId: 'attempt-child-1',
      profileRef: { id: 'explorer', version: 1 },
      conflictKeys: [],
      effect: childNode.effect,
    })
    let projection = await store.create(spec, 'create-terminal-recovery')
    projection = await store.transact({
      transactionId: 'schedule-terminal-child',
      workflowId: projection.workflowId,
      expectedSequence: projection.sequence,
      occurredAt: task.createdAt,
      events: [
        { type: 'node.state_changed', nodeId: 'child', state: 'admitted' },
        { type: 'node.state_changed', nodeId: 'child', state: 'scheduled' },
        {
          type: 'attempt.created',
          attempt: { attemptId: task.attemptId, nodeId: 'child', ordinal: 1, state: 'scheduled' },
        },
      ],
      enqueueTasks: [task],
    })
    assert.ok(await store.claim('worker-terminal-child', { now: task.readyAt, leaseMs: 1_000 }))
    projection = await store.get(spec.workflowId)
    await store.transact({
      transactionId: 'terminal-before-child-returned',
      workflowId: spec.workflowId,
      expectedSequence: projection.sequence,
      occurredAt: '2026-08-06T00:00:01.500Z',
      events: [{ type: 'workflow.terminal', state: 'failed', code: 'ROOT_AGENT_ABORTED' }],
    })

    assert.deepEqual(await store.recoverExpired('2026-08-06T00:00:02.000Z'), [])
    const recovered = await store.get(spec.workflowId)
    assert.equal(recovered.state, 'failed')
    assert.equal(recovered.nodes.find(({ nodeId }) => nodeId === 'child')?.state, 'cancelled')
    assert.equal((await store.listTasks({ workflowId: spec.workflowId }))[0]?.state, 'cancelled')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('signals, human decisions, and timers durably wake a waiting workflow exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-waits-'))
  const store = new SqliteWorkflowAuthorityV1(root)
  try {
    await store.initialize()
    let projection = await store.create(workflowSpec(), 'create-waits', {
      events: [{ type: 'workflow.waiting' }],
      timers: [
        {
          timerId: 'timer-wake',
          workflowId: 'workflow-1',
          nodeId: 'root',
          fireAt: '2026-08-06T00:10:00.000Z',
          payload: { reason: 'deadline' },
        },
      ],
      humanTasks: [
        {
          humanTaskId: 'human-approve',
          workflowId: 'workflow-1',
          nodeId: 'root',
          state: 'waiting',
          request: { question: 'Approve?' },
        },
      ],
    })
    assert.equal(projection.state, 'waiting')

    assert.equal(
      await store.signal({
        signalId: 'signal-1',
        workflowId: 'workflow-1',
        name: 'continue',
        payload: { value: 1 },
        receivedAt: '2026-08-06T00:01:00.000Z',
      }),
      true,
    )
    assert.equal(
      await store.signal({
        signalId: 'signal-1',
        workflowId: 'workflow-1',
        name: 'continue',
        payload: { value: 1 },
        receivedAt: '2026-08-06T00:01:00.000Z',
      }),
      false,
    )
    projection = await store.get('workflow-1')
    assert.equal(projection.state, 'running')
    projection = await store.transact({
      transactionId: 'wait-human',
      workflowId: 'workflow-1',
      expectedSequence: projection.sequence,
      occurredAt: '2026-08-06T00:02:00.000Z',
      events: [{ type: 'workflow.waiting' }],
    })
    assert.equal((await store.listHumanTasks('workflow-1', ['waiting'])).length, 1)
    assert.equal(
      (
        await store.resolveHumanTask(
          'human-approve',
          'allowed',
          { actor: 'user' },
          '2026-08-06T00:03:00.000Z',
        )
      ).state,
      'allowed',
    )
    projection = await store.get('workflow-1')
    assert.equal(projection.state, 'running')
    projection = await store.transact({
      transactionId: 'wait-timer',
      workflowId: 'workflow-1',
      expectedSequence: projection.sequence,
      occurredAt: '2026-08-06T00:04:00.000Z',
      events: [{ type: 'workflow.waiting' }],
    })
    assert.deepEqual(await store.fireDueTimers('2026-08-06T00:09:59.000Z'), [])
    assert.equal((await store.fireDueTimers('2026-08-06T00:10:00.000Z')).length, 1)
    assert.deepEqual(await store.fireDueTimers('2026-08-06T00:10:01.000Z'), [])
    assert.equal((await store.get('workflow-1')).state, 'running')
    const types = (await store.events('workflow-1')).map(({ data }) => data.type)
    assert.ok(types.includes('signal.received'))
    assert.ok(types.includes('human_task.resolved'))
    assert.ok(types.includes('timer.fired'))
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('external effects require an atomic durable receipt and enforce idempotency identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-receipt-'))
  const store = new SqliteWorkflowAuthorityV1(root)
  try {
    await store.initialize()
    const orchestrator = new WorkflowOrchestratorV1(store)
    const missing = await externalClaim(store, orchestrator, 'missing')
    const missingProjection = await orchestrator.complete(missing, { ok: true })
    assert.equal(missingProjection.state, 'failed')
    assert.equal(missingProjection.terminalCode, 'WORKFLOW_EFFECT_RECEIPT_REQUIRED')
    assert.deepEqual(await store.listEffectReceipts(missing.task.workflowId), [])

    const claimed = await externalClaim(store, orchestrator, 'recorded')
    const receiptRef = {
      artifactId: 'artifact-external-receipt',
      digest: `sha256:${'a'.repeat(64)}` as const,
      mediaType: 'application/json',
    }
    const completed = await orchestrator.complete(claimed, {
      ok: true,
      receiptRef,
    })
    assert.equal(completed.state, 'completed')
    assert.equal(completed.attempts.at(-1)?.receiptRef?.digest, receiptRef.digest)
    const receipt = await store.getEffectReceipt(completed.workflowId, 'external-recorded')
    assert.equal(receipt?.artifactRef.digest, receiptRef.digest)
    assert.equal((await store.listEffectReceipts(completed.workflowId)).length, 1)

    const projection = await store.get(completed.workflowId)
    await store.transact({
      transactionId: 'duplicate-effect-receipt',
      workflowId: completed.workflowId,
      expectedSequence: projection.sequence,
      occurredAt: '2026-08-06T00:00:03.000Z',
      events: [],
      effectReceipts: [
        {
          ...receipt!,
          receiptId: 'receipt-replayed-attempt',
          attemptId: 'attempt-replayed',
        },
      ],
    })
    assert.equal((await store.listEffectReceipts(completed.workflowId)).length, 1)
    await assert.rejects(
      store.transact({
        transactionId: 'conflicting-effect-receipt',
        workflowId: completed.workflowId,
        expectedSequence: projection.sequence,
        occurredAt: '2026-08-06T00:00:04.000Z',
        events: [],
        effectReceipts: [
          {
            ...receipt!,
            receiptId: 'receipt-conflict',
            attemptId: 'attempt-conflict',
            artifactRef: { ...receiptRef, digest: `sha256:${'b'.repeat(64)}` },
          },
        ],
      }),
      /WORKFLOW_EFFECT_IDEMPOTENCY_CONFLICT/u,
    )
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function scheduleAndClaim(
  store: SqliteWorkflowAuthorityV1,
  task: WorkflowTaskV1,
  suffix: string,
  spec = workflowSpec(),
) {
  let projection = await store.create(spec, `create-${suffix}`)
  projection = await store.transact({
    transactionId: `schedule-${suffix}`,
    workflowId: spec.workflowId,
    expectedSequence: projection.sequence,
    occurredAt: task.createdAt,
    events: [
      { type: 'node.state_changed', nodeId: 'root', state: 'admitted' },
      { type: 'node.state_changed', nodeId: 'root', state: 'scheduled' },
      {
        type: 'attempt.created',
        attempt: { attemptId: task.attemptId, nodeId: 'root', ordinal: 1, state: 'scheduled' },
      },
    ],
    enqueueTasks: [task],
  })
  const claim = await store.claim(`worker-${suffix}`, { now: task.readyAt, leaseMs: 1_000 })
  assert.ok(claim)
}

function workflowTask(overrides: Partial<WorkflowTaskV1> = {}): WorkflowTaskV1 {
  const now = '2026-08-06T00:00:00.000Z'
  return {
    schemaVersion: 1,
    taskId: 'task-root',
    workflowId: 'workflow-1',
    runId: 'workflow-run-1',
    nodeId: 'root',
    attemptId: 'attempt-root-1',
    kind: 'agent',
    profileRef: { id: 'coordinator', version: 1 },
    payload: { objective: 'Complete the requested work.' },
    state: 'ready',
    priority: 100,
    readyAt: now,
    deadlineAt: '2026-08-06T01:00:00.000Z',
    conflictKeys: ['workspace:D:/praxis'],
    effect: { class: 'workspace_write', requiresApproval: false },
    retry: {
      maxAttempts: 3,
      initialBackoffMs: 100,
      maxBackoffMs: 5_000,
      retryableCodes: ['PROVIDER_RATE_LIMITED'],
    },
    timeout: { totalMs: 3_600_000, noProgressMs: 600_000, heartbeatMs: 10_000 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

async function externalClaim(
  store: SqliteWorkflowAuthorityV1,
  orchestrator: WorkflowOrchestratorV1,
  suffix: string,
) {
  const workflowId = `workflow-external-${suffix}`
  const runId = `run-external-${suffix}`
  const effect = {
    class: 'external_idempotent' as const,
    idempotencyKey: `external-${suffix}`,
    requiresApproval: true,
  }
  const spec = {
    ...workflowSpec(),
    workflowId,
    runId,
    nodes: [{ ...rootNode(), effect }],
  }
  const task = workflowTask({
    taskId: `task-${suffix}`,
    workflowId,
    runId,
    attemptId: `attempt-${suffix}`,
    conflictKeys: [],
    effect,
  })
  let projection = await store.create(spec, `create-${suffix}`)
  projection = await store.transact({
    transactionId: `schedule-${suffix}`,
    workflowId,
    expectedSequence: projection.sequence,
    occurredAt: task.createdAt,
    events: [
      { type: 'node.state_changed', nodeId: 'root', state: 'admitted' },
      { type: 'node.state_changed', nodeId: 'root', state: 'scheduled' },
      {
        type: 'attempt.created',
        attempt: { attemptId: task.attemptId, nodeId: 'root', ordinal: 1, state: 'scheduled' },
      },
    ],
    enqueueTasks: [task],
  })
  const claim = await store.claim(`worker-${suffix}`, { workflowId, now: task.readyAt })
  assert.ok(claim)
  await orchestrator.markRunning(claim, '2026-08-06T00:00:01.000Z')
  return claim
}
