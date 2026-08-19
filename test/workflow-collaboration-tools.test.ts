import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentHandoffToolV1 } from '../apps/runtime/src/workflow/agentHandoffTool.js'
import type { WorkflowAgentWorkerPortV1 } from '../apps/runtime/src/workflow/agentDelegateTool.js'
import { SqliteWorkflowAuthorityV1 } from '../apps/runtime/src/workflow/sqliteWorkflowAuthority.js'
import { SubworkflowToolV1 } from '../apps/runtime/src/workflow/subworkflowTool.js'
import {
  registerBuiltinAgentProfilesV1,
  WorkflowOrchestratorV1,
} from '../apps/runtime/src/workflow/workflowOrchestrator.js'

test('handoff persists a synthesis node and subworkflow keeps separate parent identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-collaboration-tools-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    const parent = await orchestrator.start({
      sessionId: 'session-collaboration',
      parentRunId: 'run-collaboration',
      objective: 'Coordinate specialists.',
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
    const rootClaim = await orchestrator.claimRoot(parent.workflowId, 'root-collaboration')
    await orchestrator.markRunning(rootClaim)
    const worker: WorkflowAgentWorkerPortV1 = {
      execute: async (claim) => ({
        ok: true,
        summary: 'specialist result',
        output: { nodeId: claim.task.nodeId },
        artifacts: [
          {
            artifactId: `artifact-${claim.task.attemptId}`,
            digest: `sha256:${'d'.repeat(64)}`,
            mediaType: 'application/json',
          },
        ],
      }),
    }
    const handoff = await new AgentHandoffToolV1(orchestrator, worker, parent.workflowId).execute(
      request('agent.handoff', { profile: 'reviewer', objective: 'Own the review.' }),
    )
    assert.equal(handoff.ok, true)
    let parentProjection = await authority.get(parent.workflowId)
    const synthesis = parentProjection.spec.nodes.find(({ kind }) => kind === 'synthesis')
    assert.equal(
      parentProjection.nodes.find(({ nodeId }) => nodeId === synthesis?.nodeId)?.state,
      'succeeded',
    )

    const subworkflow = await new SubworkflowToolV1(
      orchestrator,
      worker,
      parent.workflowId,
    ).execute(request('workflow.subworkflow', { objective: 'Run isolated investigation.' }))
    assert.equal(subworkflow.ok, true)
    const childWorkflowId = (subworkflow.output as { childWorkflowId: string }).childWorkflowId
    const child = await authority.get(childWorkflowId)
    assert.equal(child.state, 'completed')
    assert.equal(child.spec.parentWorkflowId, parent.workflowId)
    parentProjection = await authority.get(parent.workflowId)
    const parentNode = parentProjection.spec.nodes.find(({ kind }) => kind === 'subworkflow')
    assert.equal(child.spec.parentNodeId, parentNode?.nodeId)
    assert.equal(
      parentProjection.nodes.find(({ nodeId }) => nodeId === parentNode?.nodeId)?.state,
      'succeeded',
    )
    assert.equal((await authority.list({ sessionId: parent.sessionId })).length, 2)
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
