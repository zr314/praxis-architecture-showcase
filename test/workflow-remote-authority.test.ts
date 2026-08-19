import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  RemoteArtifactStoreV1,
  RemoteWorkflowAuthorityClientV1,
  WorkflowAuthorityHttpServerV1,
} from '../apps/runtime/src/workflow/remoteWorkflowAuthority.js'
import { DurableWorkflowWorkerServiceV1 } from '../apps/runtime/src/workflow/durableWorkflowWorkerService.js'
import { SqliteWorkflowAuthorityV1 } from '../apps/runtime/src/workflow/sqliteWorkflowAuthority.js'
import { ArtifactStore } from '../apps/runtime/src/artifacts/artifactStore.js'
import {
  registerBuiltinAgentProfilesV1,
  WorkflowOrchestratorV1,
} from '../apps/runtime/src/workflow/workflowOrchestrator.js'
import { workflowSpec } from './fixtures/workflow.js'

test('remote workers use the authenticated authority port instead of opening SQLite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-remote-authority-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  const artifacts = new ArtifactStore(join(root, 'artifacts'))
  const token = 'test-token-that-is-long-enough-for-remote-authority'
  const server = new WorkflowAuthorityHttpServerV1(authority, {
    host: '127.0.0.1',
    port: 0,
    token,
    artifacts,
  })
  try {
    await authority.initialize()
    await server.start()
    const client = new RemoteWorkflowAuthorityClientV1(server.url(), token)
    await client.initialize()
    const created = await client.create(workflowSpec(), 'remote-create')
    assert.equal((await client.get(created.workflowId)).sequence, created.sequence)
    assert.equal((await client.list({ sessionId: created.sessionId })).length, 1)
    const remoteArtifacts = new RemoteArtifactStoreV1(server.url(), token)
    const artifact = await remoteArtifacts.put({ evidence: true })
    assert.deepEqual(await remoteArtifacts.read(artifact.artifactId), { evidence: true })

    const denied = new RemoteWorkflowAuthorityClientV1(server.url(), `${token}-wrong`)
    await assert.rejects(denied.get(created.workflowId), /WORKFLOW_AUTHORITY_UNAUTHORIZED/u)

    await registerBuiltinAgentProfilesV1(client)
    const orchestrator = new WorkflowOrchestratorV1(client)
    const workflow = await orchestrator.start({
      sessionId: 'remote-session',
      parentRunId: 'remote-run',
      objective: 'Execute from a remote worker.',
      modePolicy: 'auto',
      cwd: 'D:/shared-workspace',
      rootGrant: {
        tools: ['*'],
        skills: ['*'],
        mcpServers: ['*'],
        workspace: 'read',
        network: false,
        mayDelegate: true,
      },
      executionTarget: { providerId: 'mock', model: 'mock-1' },
    })
    let observedTarget: unknown
    const worker = new DurableWorkflowWorkerServiceV1({
      authority: client,
      worker: async (projection, claim) => {
        observedTarget = projection.spec.executionTarget
        assert.equal(claim.task.payload.cwd, 'D:/shared-workspace')
        return {
          execute: async () => ({ ok: true, summary: 'remote complete' }),
        }
      },
    })
    await worker.pump()
    const completed = await waitForTerminal(client, workflow.workflowId)
    assert.equal(completed.state, 'completed')
    assert.deepEqual(observedTarget, { providerId: 'mock', model: 'mock-1' })
    await worker.stop()
  } finally {
    await server.close()
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function waitForTerminal(authority: RemoteWorkflowAuthorityClientV1, workflowId: string) {
  const deadline = Date.now() + 5_000
  let last = await authority.get(workflowId)
  while (Date.now() < deadline) {
    const projection = await authority.get(workflowId)
    last = projection
    if (['completed', 'failed', 'cancelled', 'terminated'].includes(projection.state)) {
      return projection
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(
    `Remote workflow did not reach a terminal state: ${JSON.stringify({ state: last.state, nodes: last.nodes, attempts: last.attempts })}`,
  )
}
