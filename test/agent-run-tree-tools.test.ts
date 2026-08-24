import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AgentCancelToolV1,
  AgentResultToolV1,
  AgentSpawnToolV1,
  AgentSteerToolV1,
  AgentWaitToolV1,
  type AgentRunTreeControlPortV1,
} from '../apps/runtime/src/workflow/agentRunTreeTools.js'
import { SqliteWorkflowAuthorityV1 } from '../apps/runtime/src/workflow/sqliteWorkflowAuthority.js'
import {
  registerBuiltinAgentProfilesV1,
  WorkflowOrchestratorV1,
} from '../apps/runtime/src/workflow/workflowOrchestrator.js'

test('agent Run Tree tools expose durable Child handles without requiring graph authoring', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-agent-run-tree-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    const projection = await orchestrator.start({
      sessionId: 'session-run-tree',
      parentRunId: 'run-tree-root',
      objective: 'Investigate while the parent continues.',
      modePolicy: 'auto',
      cwd: 'D:/praxis',
      rootGrant: {
        tools: ['*'],
        skills: ['*'],
        mcpServers: ['*'],
        workspace: 'write',
        network: true,
        mayDelegate: true,
      },
    })
    const rootClaim = await orchestrator.claimRoot(projection.workflowId, 'root-worker')
    await orchestrator.markRunning(rootClaim)

    const controlCalls: Array<readonly [string, string]> = []
    const control: AgentRunTreeControlPortV1 = {
      cancel: async (_workflowId, childIds) => childIds.length,
      steer: async (_workflowId, childId, instruction) => {
        controlCalls.push([childId, instruction])
        return false
      },
    }

    const spawned = await new AgentSpawnToolV1(orchestrator, projection.workflowId).execute(
      request('agent.spawn', {
        objective: 'Inspect the persistence boundary.',
        profile: 'explorer',
        workspace: 'read',
        // Direct execution also ignores legacy/model-invented numeric budgets;
        // normal ToolRuntime validation rejects them as unknown properties.
        maxTokens: 1,
      }),
    )
    assert.equal(spawned.ok, true)
    const childId = (spawned.output as { childId: string }).childId
    const admitted = await authority.get(projection.workflowId)
    assert.equal(admitted.spec.nodes.find(({ nodeId }) => nodeId === childId)?.required, false)
    const [task] = await authority.listTasks({
      workflowId: projection.workflowId,
      states: ['ready'],
    })
    assert.ok(task)
    assert.equal(task.nodeId, childId)
    assert.equal(task.payload.coordinationMode, 'background')
    assert.equal((task.payload.budget as { maxTokens?: number }).maxTokens, undefined)
    assert.equal(
      Object.hasOwn(
        new AgentSpawnToolV1(orchestrator, projection.workflowId).definition.parameters.properties,
        'maxTokens',
      ),
      false,
    )

    const steered = await new AgentSteerToolV1(
      orchestrator,
      control,
      projection.workflowId,
    ).execute(request('agent.steer', { childId, instruction: 'Check restart recovery too.' }))
    assert.equal(steered.ok, true)
    assert.equal((steered.output as { delivered: boolean }).delivered, false)
    assert.deepEqual(controlCalls, [[childId, 'Check restart recovery too.']])
    const instructions = await authority.listMessages({
      workflowId: projection.workflowId,
      recipientNodeId: childId,
      types: ['instruction'],
    })
    assert.equal(instructions.length, 1)

    const childClaim = await orchestrator.claimNode(projection.workflowId, childId, 'child-worker')
    await orchestrator.markRunning(childClaim)
    await orchestrator.complete(childClaim, {
      ok: true,
      resultRef: {
        artifactId: 'artifact-run-tree-result',
        digest: `sha256:${'a'.repeat(64)}`,
        mediaType: 'application/json',
      },
    })
    const waited = await new AgentWaitToolV1(orchestrator, projection.workflowId).execute(
      request('agent.wait', { childIds: [childId] }),
    )
    assert.equal(waited.ok, true)
    assert.equal(
      (waited.output as { children: Array<{ state: string }> }).children[0]?.state,
      'succeeded',
    )
    const result = await new AgentResultToolV1(orchestrator, projection.workflowId).execute(
      request('agent.result', { childIds: [childId] }),
    )
    assert.equal(result.ok, true)

    const second = await new AgentSpawnToolV1(orchestrator, projection.workflowId).execute(
      request('agent.spawn', { objective: 'Explore a route that will be abandoned.' }),
    )
    const secondId = (second.output as { childId: string }).childId
    const cancelled = await new AgentCancelToolV1(
      orchestrator,
      control,
      projection.workflowId,
    ).execute(request('agent.cancel', { childIds: [secondId], reason: 'route changed' }))
    assert.equal(cancelled.ok, true)
    const afterCancel = await authority.get(projection.workflowId)
    assert.equal(afterCancel.nodes.find(({ nodeId }) => nodeId === secondId)?.state, 'cancelled')

    const running = await new AgentSpawnToolV1(orchestrator, projection.workflowId).execute(
      request('agent.spawn', { objective: 'Run until the parent changes direction.' }),
    )
    const runningId = (running.output as { childId: string }).childId
    const runningClaim = await orchestrator.claimNode(
      projection.workflowId,
      runningId,
      'running-child-worker',
    )
    await orchestrator.markRunning(runningClaim)
    const runningCancelled = await orchestrator.complete(runningClaim, {
      ok: false,
      cancelled: true,
      errorCode: 'CHILD_PARENT_CANCELLED',
    })
    assert.equal(
      runningCancelled.nodes.find(({ nodeId }) => nodeId === runningId)?.state,
      'cancelled',
    )
    assert.equal(
      runningCancelled.nodes.find(({ nodeId }) => nodeId === runningId)?.errorCode,
      'CHILD_PARENT_CANCELLED',
    )

    const completed = await orchestrator.complete(rootClaim, { ok: true })
    assert.equal(completed.state, 'completed')
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

function request(name: string, input: Record<string, unknown>) {
  return {
    name,
    input,
    cwd: 'D:/praxis',
    signal: new AbortController().signal,
  }
}
