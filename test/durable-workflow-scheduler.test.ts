import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DurableWorkflowSchedulerV1 } from '../apps/runtime/src/workflow/durableWorkflowScheduler.js'
import { DurableWorkflowWorkerServiceV1 } from '../apps/runtime/src/workflow/durableWorkflowWorkerService.js'
import { SqliteWorkflowAuthorityV1 } from '../apps/runtime/src/workflow/sqliteWorkflowAuthority.js'
import {
  registerBuiltinAgentProfilesV1,
  WorkflowOrchestratorV1,
} from '../apps/runtime/src/workflow/workflowOrchestrator.js'

const grant = {
  tools: ['*'],
  skills: ['*'],
  mcpServers: ['*'],
  workspace: 'write' as const,
  network: true,
  mayDelegate: true,
}

test('durable scheduler enforces journal dependencies and preserves result evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-durable-scheduler-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    const workflow = await orchestrator.start({
      sessionId: 'session-scheduler',
      parentRunId: 'run-scheduler',
      objective: 'Research then verify.',
      modePolicy: 'auto',
      cwd: 'D:/praxis',
      rootGrant: grant,
    })
    const rootClaim = await orchestrator.claimRoot(workflow.workflowId, 'root-worker')
    await orchestrator.markRunning(rootClaim)
    const graph = await orchestrator.admitAgentGraph(
      workflow.workflowId,
      'root',
      'proposal-order',
      [graphNode('research', []), graphNode('verify', ['research'])],
    )
    const research = graph.nodes.find(({ key }) => key === 'research')!
    const verify = graph.nodes.find(({ key }) => key === 'verify')!
    assert.equal(
      graph.projection.nodes.find(({ nodeId }) => nodeId === research.nodeId)?.state,
      'scheduled',
    )
    assert.equal(
      graph.projection.nodes.find(({ nodeId }) => nodeId === verify.nodeId)?.state,
      'admitted',
    )
    assert.equal(
      await authority.claim('illegal-early-worker', {
        workflowId: workflow.workflowId,
        nodeId: verify.nodeId,
      }),
      undefined,
    )

    const order: string[] = []
    const scheduler = new DurableWorkflowSchedulerV1(orchestrator, {
      execute: async (claim) => {
        order.push(claim.task.nodeId)
        return {
          ok: true,
          summary: `completed ${claim.task.nodeId}`,
          artifacts: [
            {
              artifactId: `artifact-${claim.task.nodeId}`,
              digest: `sha256:${'a'.repeat(64)}`,
              mediaType: 'application/json',
            },
          ],
        }
      },
    })
    const result = await scheduler.executeAgentGraph(graph, new AbortController().signal)
    assert.equal(result.ok, true)
    assert.deepEqual(order, [research.nodeId, verify.nodeId])
    const completed = await authority.get(workflow.workflowId)
    assert.equal(
      completed.nodes.find(({ nodeId }) => nodeId === verify.nodeId)?.resultRef?.artifactId,
      `artifact-${verify.nodeId}`,
    )
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('durable scheduler cancels dependent nodes after a collected failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-durable-scheduler-failure-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    const workflow = await orchestrator.start({
      sessionId: 'session-failure',
      parentRunId: 'run-failure',
      objective: 'Fail safely.',
      modePolicy: 'workflow',
      cwd: 'D:/praxis',
      rootGrant: grant,
    })
    const claim = await orchestrator.claimRoot(workflow.workflowId, 'root-failure')
    await orchestrator.markRunning(claim)
    const graph = await orchestrator.admitAgentGraph(
      workflow.workflowId,
      'root',
      'proposal-failure',
      [graphNode('first', []), graphNode('dependent', ['first'])],
    )
    const result = await new DurableWorkflowSchedulerV1(orchestrator, {
      execute: async () => {
        throw Object.assign(new Error('expected worker crash'), {
          code: 'EXPECTED_FAILURE',
          retryable: false,
        })
      },
    }).executeAgentGraph(graph, new AbortController().signal)
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'EXPECTED_FAILURE')
    const after = await authority.get(workflow.workflowId)
    assert.equal(
      after.nodes.find(({ nodeId }) => nodeId === graph.nodes[1]?.nodeId)?.state,
      'cancelled',
    )
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a recreated scheduler continues after persisted success without rerunning it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-durable-scheduler-restart-'))
  const firstAuthority = new SqliteWorkflowAuthorityV1(root)
  let reopened: SqliteWorkflowAuthorityV1 | undefined
  try {
    await firstAuthority.initialize()
    await registerBuiltinAgentProfilesV1(firstAuthority)
    const firstOrchestrator = new WorkflowOrchestratorV1(firstAuthority)
    const workflow = await firstOrchestrator.start({
      sessionId: 'session-restart',
      parentRunId: 'run-restart',
      objective: 'Resume graph.',
      modePolicy: 'auto',
      cwd: 'D:/praxis',
      rootGrant: grant,
    })
    const rootClaim = await firstOrchestrator.claimRoot(workflow.workflowId, 'root-restart')
    await firstOrchestrator.markRunning(rootClaim)
    const graph = await firstOrchestrator.admitAgentGraph(
      workflow.workflowId,
      'root',
      'proposal-restart',
      [graphNode('persisted', []), graphNode('remaining', ['persisted'])],
    )
    const persisted = graph.nodes[0]!
    const firstClaim = await firstOrchestrator.claimNode(
      workflow.workflowId,
      persisted.nodeId,
      'first-process',
    )
    await firstOrchestrator.markRunning(firstClaim)
    await firstOrchestrator.complete(firstClaim, {
      ok: true,
      resultRef: {
        artifactId: 'artifact-before-restart',
        digest: `sha256:${'b'.repeat(64)}`,
        mediaType: 'application/json',
      },
    })
    firstAuthority.close()

    reopened = new SqliteWorkflowAuthorityV1(root)
    await reopened.initialize()
    const executed: string[] = []
    const result = await new DurableWorkflowSchedulerV1(new WorkflowOrchestratorV1(reopened), {
      execute: async (claim) => {
        executed.push(claim.task.nodeId)
        return {
          ok: true,
          summary: 'resumed',
          artifacts: [
            {
              artifactId: 'artifact-after-restart',
              digest: `sha256:${'c'.repeat(64)}`,
              mediaType: 'application/json',
            },
          ],
        }
      },
    }).executeAgentGraph(graph, new AbortController().signal)
    assert.equal(result.ok, true)
    assert.deepEqual(executed, [graph.nodes[1]?.nodeId])
    assert.equal(result.evidence.persisted?.artifactId, 'artifact-before-restart')
    assert.equal(result.evidence.remaining?.artifactId, 'artifact-after-restart')
  } finally {
    firstAuthority.close()
    reopened?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('root success does not terminalize an active durable DAG', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-root-before-dag-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    const workflow = await orchestrator.start({
      sessionId: 'session-root-before-dag',
      parentRunId: 'run-root-before-dag',
      objective: 'Do not finish until the durable child settles.',
      modePolicy: 'auto',
      cwd: 'D:/praxis',
      rootGrant: grant,
    })
    const rootClaim = await orchestrator.claimRoot(workflow.workflowId, 'root-before-dag')
    await orchestrator.markRunning(rootClaim)
    const graph = await orchestrator.admitAgentGraph(
      workflow.workflowId,
      'root',
      'proposal-root-before-dag',
      [graphNode('child', [])],
    )

    const afterRoot = await orchestrator.complete(rootClaim, { ok: true })
    assert.equal(afterRoot.state, 'running')
    assert.equal(afterRoot.nodes.find(({ nodeId }) => nodeId === 'root')?.state, 'succeeded')

    const childClaim = await orchestrator.claimNode(
      workflow.workflowId,
      graph.nodes[0]!.nodeId,
      'child-after-root',
    )
    await orchestrator.markRunning(childClaim)
    const completed = await orchestrator.complete(childClaim, { ok: true })
    assert.equal(completed.state, 'completed')
    assert.equal(
      completed.nodes.find(({ nodeId }) => nodeId === graph.nodes[0]!.nodeId)?.state,
      'succeeded',
    )
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('parallel node state commits retry authority sequence races without losing a result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-parallel-authority-commits-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    const workflow = await orchestrator.start({
      sessionId: 'session-parallel-authority',
      parentRunId: 'run-parallel-authority',
      objective: 'Commit parallel results durably.',
      modePolicy: 'workflow',
      cwd: 'D:/praxis',
      rootGrant: grant,
    })
    const rootClaim = await orchestrator.claimRoot(workflow.workflowId, 'parallel-root')
    await orchestrator.markRunning(rootClaim)
    const graph = await orchestrator.admitAgentGraph(
      workflow.workflowId,
      'root',
      'proposal-parallel-authority',
      Array.from({ length: 8 }, (_, index) => graphNode(`parallel-${index}`, [])),
    )
    const claims = []
    for (const node of graph.nodes) {
      claims.push(
        await orchestrator.claimNode(workflow.workflowId, node.nodeId, `worker-${node.key}`),
      )
    }
    await Promise.all(claims.map((claim) => orchestrator.markRunning(claim)))
    await Promise.all(claims.map((claim) => orchestrator.complete(claim, { ok: true })))
    const completed = await orchestrator.complete(rootClaim, { ok: true })
    assert.equal(completed.state, 'completed')
    assert.equal(
      graph.nodes.filter(
        ({ nodeId }) =>
          completed.nodes.find((node) => node.nodeId === nodeId)?.state === 'succeeded',
      ).length,
      graph.nodes.length,
    )
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('background recovery rebuilds a multi-stage DAG and reruns root only after its join', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-background-dag-recovery-'))
  const first = new SqliteWorkflowAuthorityV1(root)
  let recovered: SqliteWorkflowAuthorityV1 | undefined
  let service: DurableWorkflowWorkerServiceV1 | undefined
  try {
    await first.initialize()
    await registerBuiltinAgentProfilesV1(first)
    const orchestrator = new WorkflowOrchestratorV1(first)
    const workflow = await orchestrator.start({
      sessionId: 'session-background-recovery',
      parentRunId: 'run-background-recovery',
      objective: 'Recover a persisted multi-stage graph.',
      modePolicy: 'auto',
      cwd: 'D:/praxis',
      rootGrant: grant,
    })
    const rootClaim = (await first.claim('first-root', {
      workflowId: workflow.workflowId,
      nodeId: 'root',
      leaseMs: 1_000,
    }))!
    await orchestrator.markRunning(rootClaim)
    const graph = await orchestrator.admitAgentGraph(
      workflow.workflowId,
      'root',
      'proposal-background-recovery',
      [
        graphNode('persisted', []),
        graphNode('review', ['persisted']),
        graphNode('synthesis', ['review']),
      ],
      { kind: 'quorum', minimum: 3 },
    )
    const persistedClaim = await orchestrator.claimNode(
      workflow.workflowId,
      graph.nodes[0]!.nodeId,
      'first-persisted',
    )
    await orchestrator.markRunning(persistedClaim)
    await orchestrator.complete(persistedClaim, {
      ok: true,
      resultRef: artifactRef('persisted'),
    })
    const interruptedClaim = (await first.claim('first-review', {
      workflowId: workflow.workflowId,
      nodeId: graph.nodes[1]!.nodeId,
      leaseMs: 1_000,
    }))!
    await orchestrator.markRunning(interruptedClaim)
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    first.close()

    recovered = new SqliteWorkflowAuthorityV1(root)
    await recovered.initialize()
    const order: string[] = []
    service = new DurableWorkflowWorkerServiceV1({
      authority: recovered,
      concurrency: 2,
      pollMs: 25,
      worker: async () => ({
        execute: async (claim) => {
          order.push(claim.task.nodeId)
          return {
            ok: true,
            summary: `recovered ${claim.task.nodeId}`,
            artifacts: [artifactRef(claim.task.nodeId)],
          }
        },
      }),
    })
    service.start()
    const completed = await waitForWorkflowTerminal(recovered, workflow.workflowId)
    assert.equal(completed.state, 'completed')
    assert.deepEqual(order, [graph.nodes[1]!.nodeId, graph.nodes[2]!.nodeId, 'root'])
    assert.equal(
      completed.nodes.find(({ nodeId }) => nodeId === graph.nodes[0]!.nodeId)?.attemptIds.length,
      1,
    )
    assert.equal(
      completed.nodes.find(({ nodeId }) => nodeId === graph.nodes[1]!.nodeId)?.attemptIds.length,
      2,
    )
    assert.equal(
      completed.nodes.find(({ nodeId }) => nodeId === graph.nodes[2]!.nodeId)?.attemptIds.length,
      1,
    )
    assert.equal(
      completed.nodes.find(({ nodeId }) => nodeId === graph.joinNodeId)?.state,
      'succeeded',
    )
    assert.equal(completed.nodes.find(({ nodeId }) => nodeId === 'root')?.attemptIds.length, 2)
  } finally {
    await service?.stop()
    first.close()
    recovered?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('conditional graph skips an unselected branch and releases its join', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-durable-scheduler-condition-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    const workflow = await orchestrator.start({
      sessionId: 'session-condition',
      parentRunId: 'run-condition',
      objective: 'Choose and join.',
      modePolicy: 'workflow',
      cwd: 'D:/praxis',
      rootGrant: grant,
    })
    const rootClaim = await orchestrator.claimRoot(workflow.workflowId, 'root-condition')
    await orchestrator.markRunning(rootClaim)
    const graph = await orchestrator.admitAgentGraph(
      workflow.workflowId,
      'root',
      'proposal-condition',
      [
        graphNode('decision', []),
        {
          ...graphNode('yes', ['decision']),
          conditions: [
            { dependency: 'decision', operator: 'status_is' as const, value: 'succeeded' },
          ],
        },
        {
          ...graphNode('no', ['decision']),
          conditions: [{ dependency: 'decision', operator: 'status_is' as const, value: 'failed' }],
        },
        graphNode('join', ['yes', 'no']),
      ],
    )
    const executed: string[] = []
    const result = await new DurableWorkflowSchedulerV1(orchestrator, {
      execute: async (claim) => {
        executed.push(graph.nodes.find(({ nodeId }) => nodeId === claim.task.nodeId)!.key)
        return { ok: true, summary: 'ok' }
      },
    }).executeAgentGraph(graph, new AbortController().signal)
    assert.equal(result.ok, true)
    assert.deepEqual(executed, ['decision', 'yes', 'join'])
    const after = await authority.get(workflow.workflowId)
    assert.equal(
      after.nodes.find(
        ({ nodeId }) => nodeId === graph.nodes.find(({ key }) => key === 'no')?.nodeId,
      )?.state,
      'skipped',
    )
    const skippedNodeId = graph.nodes.find(({ key }) => key === 'no')!.nodeId
    assert.equal(
      (await authority.listTasks({ workflowId: workflow.workflowId })).find(
        ({ nodeId }) => nodeId === skippedNodeId,
      )?.state,
      'cancelled',
    )
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('durable quorum join succeeds with partial failure and journals the decision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-durable-scheduler-quorum-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    const workflow = await orchestrator.start({
      sessionId: 'session-quorum',
      parentRunId: 'run-quorum',
      objective: 'Collect a durable majority.',
      modePolicy: 'workflow',
      cwd: 'D:/praxis',
      rootGrant: grant,
    })
    const rootClaim = await orchestrator.claimRoot(workflow.workflowId, 'root-quorum')
    await orchestrator.markRunning(rootClaim)
    const graph = await orchestrator.admitAgentGraph(
      workflow.workflowId,
      'root',
      'proposal-quorum',
      [graphNode('one', []), graphNode('two', []), graphNode('three', [])],
      { kind: 'quorum', minimum: 2 },
    )
    const result = await new DurableWorkflowSchedulerV1(orchestrator, {
      execute: async (claim) => ({
        ok: !String(claim.task.payload.objective).includes('two'),
        summary: 'settled',
        errorCode: String(claim.task.payload.objective).includes('two')
          ? 'EXPECTED_MINORITY_FAILURE'
          : undefined,
      }),
    }).executeAgentGraph(graph, new AbortController().signal)
    assert.equal(result.ok, true)
    const after = await authority.get(workflow.workflowId)
    assert.equal(after.nodes.find(({ nodeId }) => nodeId === graph.joinNodeId)?.state, 'succeeded')
    assert.equal(
      after.spec.nodes.find(({ nodeId }) => nodeId === graph.joinNodeId)?.join?.kind,
      'quorum',
    )
    const completed = await orchestrator.complete(rootClaim, { ok: true })
    assert.equal(completed.state, 'completed')
    assert.equal(completed.nodes.find(({ nodeId }) => nodeId === 'root')?.state, 'succeeded')
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('durable quorum commits fast results and cancels the slow running branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-durable-scheduler-quorum-early-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    const workflow = await orchestrator.start({
      sessionId: 'session-quorum-early',
      parentRunId: 'run-quorum-early',
      objective: 'Return after a durable majority without waiting for the straggler.',
      modePolicy: 'workflow',
      cwd: 'D:/praxis',
      rootGrant: grant,
    })
    const rootClaim = await orchestrator.claimRoot(workflow.workflowId, 'root-quorum-early')
    await orchestrator.markRunning(rootClaim)
    const graph = await orchestrator.admitAgentGraph(
      workflow.workflowId,
      'root',
      'proposal-quorum-early',
      [graphNode('fast-one', []), graphNode('fast-two', []), graphNode('slow', [])],
      { kind: 'quorum', minimum: 2 },
    )
    const cancelled: string[] = []
    const startedAt = Date.now()
    const result = await new DurableWorkflowSchedulerV1(orchestrator, {
      execute: async (claim, signal) => {
        if (!String(claim.task.payload.objective).includes('slow')) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          return { ok: true, summary: 'fast success' }
        }
        return await new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ ok: false, summary: 'slow cancelled', errorCode: 'CANCELLED' }),
            { once: true },
          )
        })
      },
      cancel: async (claim) => {
        cancelled.push(claim.task.nodeId)
      },
    }).executeAgentGraph(graph, new AbortController().signal)
    assert.equal(result.ok, true)
    assert.ok(Date.now() - startedAt < 500)
    const slow = graph.nodes.find(({ key }) => key === 'slow')!
    assert.deepEqual(cancelled, [slow.nodeId])
    const after = await authority.get(workflow.workflowId)
    assert.equal(after.nodes.find(({ nodeId }) => nodeId === slow.nodeId)?.state, 'cancelled')
    assert.equal(
      after.nodes.find(({ nodeId }) => nodeId === slow.nodeId)?.errorCode,
      'WORKFLOW_JOIN_SATISFIED',
    )
    const completed = await orchestrator.complete(rootClaim, { ok: true })
    assert.equal(completed.state, 'completed')
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('successful replacement can explicitly supersede a failed terminal graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-durable-scheduler-supersede-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    const workflow = await orchestrator.start({
      sessionId: 'session-supersede',
      parentRunId: 'run-supersede',
      objective: 'Replace a failed evidence graph without losing its audit history.',
      modePolicy: 'workflow',
      cwd: 'D:/praxis',
      rootGrant: grant,
    })
    const rootClaim = await orchestrator.claimRoot(workflow.workflowId, 'root-supersede')
    await orchestrator.markRunning(rootClaim)
    const failedGraph = await orchestrator.admitAgentGraph(
      workflow.workflowId,
      'root',
      'proposal-failed',
      [graphNode('one', []), graphNode('two', [])],
      { kind: 'any' },
    )
    const failed = await new DurableWorkflowSchedulerV1(orchestrator, {
      execute: async () => ({ ok: false, summary: 'expected failure', errorCode: 'EXPECTED' }),
    }).executeAgentGraph(failedGraph, new AbortController().signal)
    assert.equal(failed.ok, false)

    const replacementGraph = await orchestrator.admitAgentGraph(
      workflow.workflowId,
      'root',
      'proposal-replacement',
      [graphNode('replacement', [])],
    )
    const replacement = await new DurableWorkflowSchedulerV1(orchestrator, {
      execute: async () => ({ ok: true, summary: 'replacement complete' }),
    }).executeAgentGraph(replacementGraph, new AbortController().signal)
    assert.equal(replacement.ok, true)

    const supersededIds = [
      ...failedGraph.nodes.map(({ nodeId }) => nodeId),
      failedGraph.joinNodeId!,
    ]
    const patched = await orchestrator.supersedeFailedNodes(
      workflow.workflowId,
      supersededIds,
      replacementGraph.nodes.map(({ nodeId }) => nodeId),
      'replacement-accepted',
    )
    assert.equal(
      patched.nodes.some(({ nodeId }) => supersededIds.includes(nodeId)),
      false,
    )
    const completed = await orchestrator.complete(rootClaim, { ok: true })
    assert.equal(completed.state, 'completed')
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

function graphNode(key: string, dependencies: readonly string[]) {
  return {
    key,
    profileId: key.includes('verify') ? 'verifier' : 'researcher',
    objective: `Complete ${key}.`,
    dependencies,
    grantRequest: { ...grant, workspace: 'read' as const, mayDelegate: false },
  }
}

function artifactRef(id: string) {
  return {
    artifactId: `artifact-${id}`,
    digest: `sha256:${'d'.repeat(64)}` as const,
    mediaType: 'application/json',
  }
}

async function waitForWorkflowTerminal(authority: SqliteWorkflowAuthorityV1, workflowId: string) {
  const deadline = Date.now() + 10_000
  let current = await authority.get(workflowId)
  while (Date.now() < deadline) {
    current = await authority.get(workflowId)
    if (['completed', 'failed', 'cancelled', 'terminated'].includes(current.state)) return current
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Workflow recovery did not settle: ${JSON.stringify(current)}`)
}
