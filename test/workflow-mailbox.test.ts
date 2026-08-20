import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DurableWorkflowWorkerServiceV1 } from '../apps/runtime/src/workflow/durableWorkflowWorkerService.js'
import { SqliteWorkflowAuthorityV1 } from '../apps/runtime/src/workflow/sqliteWorkflowAuthority.js'
import {
  WorkflowInboxToolV1,
  WorkflowJoinToolV1,
} from '../apps/runtime/src/workflow/workflowCoordinationTools.js'
import { WorkflowExpandToolV1 } from '../apps/runtime/src/workflow/workflowExpandTool.js'
import {
  registerBuiltinAgentProfilesV1,
  WorkflowOrchestratorV1,
} from '../apps/runtime/src/workflow/workflowOrchestrator.js'

test('workflow mailbox durably orders, deduplicates, and acknowledges addressed messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-mailbox-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const workflow = await startWorkflow(authority)
    const input = {
      schemaVersion: 1 as const,
      messageId: 'steer-1',
      workflowId: workflow.workflowId,
      sender: { kind: 'user' as const, id: 'session-mailbox' },
      recipient: { kind: 'node' as const, id: 'root' },
      type: 'instruction' as const,
      payload: { text: 'Prefer the safe path.', intent: 'steer' },
      causationId: 'steer-1',
      correlationId: workflow.runId,
      createdAt: '2026-08-20T00:00:00.000Z',
    }
    const first = await authority.postMessage(input)
    const duplicate = await authority.postMessage(input)
    assert.equal(first.sequence, 1)
    assert.equal(duplicate.sequence, 1)
    assert.equal(
      (await authority.listMessages({ workflowId: workflow.workflowId, recipientNodeId: 'root' }))
        .length,
      1,
    )
    assert.equal(await authority.acknowledgeMessage(workflow.workflowId, 'steer-1', 'root'), true)
    assert.equal(await authority.acknowledgeMessage(workflow.workflowId, 'steer-1', 'root'), false)
    assert.equal(
      (await authority.listMessages({ workflowId: workflow.workflowId, recipientNodeId: 'root' }))
        .length,
      0,
    )
    authority.close()

    const restarted = new SqliteWorkflowAuthorityV1(root)
    await restarted.initialize()
    const restored = await restarted.listMessages({
      workflowId: workflow.workflowId,
      recipientNodeId: 'root',
      includeAcknowledged: true,
    })
    assert.equal(restored[0]?.messageId, 'steer-1')
    assert.ok(restored[0]?.acknowledgedAt)
    restarted.close()
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Root can continue after spawning a DAG, then inspect and explicitly join background results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-background-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  const service = new DurableWorkflowWorkerServiceV1({
    authority,
    pollMs: 10_000,
    concurrency: 2,
    canRun: (_projection, task) => task.payload.coordinationMode === 'background',
    worker: async () => ({
      execute: async (claim) => ({
        ok: true,
        summary: `completed ${claim.task.nodeId}`,
        output: { nodeId: claim.task.nodeId },
        artifacts: [
          {
            artifactId: `artifact-${'a'.repeat(64)}`,
            digest: `sha256:${'b'.repeat(64)}`,
            mediaType: 'application/json',
          },
        ],
      }),
    }),
  })
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const workflow = await startWorkflow(authority)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    const rootClaim = await orchestrator.claimRoot(workflow.workflowId, 'root-background')
    await orchestrator.markRunning(rootClaim)
    let foregroundExecutions = 0
    const expand = new WorkflowExpandToolV1(
      orchestrator,
      {
        execute: async () => {
          foregroundExecutions += 1
          return { ok: false, summary: 'foreground worker must not run' }
        },
      },
      workflow.workflowId,
    )
    const expanded = await expand.execute(
      request('workflow.expand', {
        rootAction: 'continue',
        nodes: [
          {
            id: 'research',
            profile: 'explorer',
            objective: 'Inspect the durable mailbox.',
            dependencies: [],
            workspace: 'read',
          },
        ],
      }),
    )
    assert.equal(expanded.ok, true)
    assert.equal(foregroundExecutions, 0)
    const nodeId = (expanded.output as { graph: { nodeIds: Readonly<Record<string, string>> } })
      .graph.nodeIds.research!
    const task = (await authority.listTasks({ workflowId: workflow.workflowId })).find(
      (candidate) => candidate.nodeId === nodeId,
    )
    assert.equal(task?.payload.coordinationMode, 'background')

    await authority.postMessage({
      schemaVersion: 1,
      messageId: 'instruction-before-result',
      workflowId: workflow.workflowId,
      sender: { kind: 'user', id: 'session-mailbox' },
      recipient: { kind: 'node', id: 'root' },
      type: 'instruction',
      payload: { text: 'This filtered message must remain unread.' },
      createdAt: '2026-08-20T00:00:01.000Z',
    })

    await service.pump()
    await eventually(async () => {
      const projection = await authority.get(workflow.workflowId)
      return projection.nodes.find((node) => node.nodeId === nodeId)?.state === 'succeeded'
    })

    const inbox = await new WorkflowInboxToolV1(orchestrator, workflow.workflowId).execute(
      request('workflow.inbox', { types: ['result'], acknowledge: true }),
    )
    assert.equal(inbox.ok, true)
    const messages = (inbox.output as { messages: readonly { type: string }[] }).messages
    assert.equal(messages[0]?.type, 'result')
    assert.deepEqual(
      (
        await authority.listMessages({
          workflowId: workflow.workflowId,
          recipientNodeId: 'root',
        })
      ).map(({ messageId }) => messageId),
      ['instruction-before-result'],
    )

    const joined = await new WorkflowJoinToolV1(orchestrator, workflow.workflowId).execute(
      request('workflow.join', { nodeIds: [nodeId], mode: 'all' }),
    )
    assert.equal(joined.ok, true)
    assert.deepEqual(
      (
        await authority.listMessages({
          workflowId: workflow.workflowId,
          recipientNodeId: 'root',
        })
      ).map(({ messageId }) => messageId),
      ['instruction-before-result'],
    )
  } finally {
    await service.stop()
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function startWorkflow(authority: SqliteWorkflowAuthorityV1) {
  return new WorkflowOrchestratorV1(authority).start({
    sessionId: 'session-mailbox',
    parentRunId: 'run-mailbox',
    objective: 'Coordinate background work.',
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
}

function request(name: string, input: Record<string, unknown>) {
  return {
    name,
    input,
    cwd: 'D:/praxis',
    signal: new AbortController().signal,
  }
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail('condition did not become true')
}
