import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { WorkflowArtifactRefV1 } from '@praxis/core-sdk'
import type { WorkflowAgentWorkerPortV1 } from '../apps/runtime/src/workflow/agentDelegateTool.js'
import { SqliteWorkflowAuthorityV1 } from '../apps/runtime/src/workflow/sqliteWorkflowAuthority.js'
import { WorkflowLoopToolV1 } from '../apps/runtime/src/workflow/workflowLoopTool.js'
import {
  registerBuiltinAgentProfilesV1,
  WorkflowOrchestratorV1,
} from '../apps/runtime/src/workflow/workflowOrchestrator.js'

test('bounded loop unrolls iterations as durable acyclic graph revisions', async () => {
  const fixture = await createFixture()
  try {
    let calls = 0
    const worker: WorkflowAgentWorkerPortV1 = {
      execute: async (claim) => {
        calls += 1
        return {
          ok: true,
          summary: `iteration ${calls}`,
          output: { accepted: calls === 2, calls },
          artifacts: [artifact(claim.task.attemptId, calls)],
        }
      },
    }
    const result = await new WorkflowLoopToolV1(
      fixture.orchestrator,
      worker,
      fixture.workflowId,
    ).execute(
      request({
        profile: 'coder',
        objective: 'Improve until accepted.',
        maxIterations: 5,
        until: { operator: 'eq', pointer: '/accepted', value: true },
        workspace: 'write',
      }),
    )
    assert.equal(result.ok, true)
    assert.equal(calls, 2)
    const projection = await fixture.authority.get(fixture.workflowId)
    const loopNodes = projection.spec.nodes.filter(({ maxIterations }) => maxIterations === 5)
    assert.equal(loopNodes.length, 2)
    assert.equal(projection.graphMutations, 2)
    assert.equal(
      projection.spec.edges.some(
        ({ from, to }) => from === loopNodes[0]?.nodeId && to === loopNodes[1]?.nodeId,
      ),
      true,
    )
    assert.equal(loopNodes[1]?.inputRefs.length, 1)
  } finally {
    await fixture.close()
  }
})

test('bounded loop reports its durable limit without admitting an extra iteration', async () => {
  const fixture = await createFixture()
  try {
    const worker: WorkflowAgentWorkerPortV1 = {
      execute: async (claim) => ({
        ok: true,
        summary: 'not done',
        output: { accepted: false },
        artifacts: [artifact(claim.task.attemptId, 9)],
      }),
    }
    const result = await new WorkflowLoopToolV1(
      fixture.orchestrator,
      worker,
      fixture.workflowId,
    ).execute(
      request({
        profile: 'verifier',
        objective: 'Check until accepted.',
        maxIterations: 2,
        until: { operator: 'eq', pointer: '/accepted', value: true },
      }),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'WORKFLOW_LOOP_LIMIT_REACHED')
    const projection = await fixture.authority.get(fixture.workflowId)
    assert.equal(projection.spec.nodes.filter(({ maxIterations }) => maxIterations === 2).length, 2)
  } finally {
    await fixture.close()
  }
})

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-loop-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  await authority.initialize()
  await registerBuiltinAgentProfilesV1(authority)
  const orchestrator = new WorkflowOrchestratorV1(authority)
  const projection = await orchestrator.start({
    sessionId: 'session-loop',
    parentRunId: 'run-loop',
    objective: 'Coordinate bounded iteration.',
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
  const rootClaim = await orchestrator.claimRoot(projection.workflowId, 'root-loop')
  await orchestrator.markRunning(rootClaim)
  return {
    authority,
    orchestrator,
    workflowId: projection.workflowId,
    close: async () => {
      authority.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function artifact(attemptId: string, seed: number): WorkflowArtifactRefV1 {
  return {
    artifactId: `artifact-${attemptId}`,
    digest: `sha256:${String(seed).padStart(64, '0')}` as const,
    mediaType: 'application/json',
  }
}

function request(input: Record<string, unknown>) {
  return {
    name: 'workflow.loop',
    input,
    cwd: 'D:/praxis',
    signal: new AbortController().signal,
  }
}
