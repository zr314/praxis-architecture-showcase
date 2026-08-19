import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RuntimeTool } from '@praxis/core-sdk'
import { ArtifactStore } from '../apps/runtime/src/artifacts/artifactStore.js'
import { ToolRuntime } from '../apps/runtime/src/tools/toolRuntime.js'
import { SqliteWorkflowAuthorityV1 } from '../apps/runtime/src/workflow/sqliteWorkflowAuthority.js'
import { WorkflowCompensationToolV1 } from '../apps/runtime/src/workflow/workflowCompensationTool.js'
import { WorkflowEffectBrokerV1 } from '../apps/runtime/src/workflow/workflowEffectBroker.js'
import {
  registerBuiltinAgentProfilesV1,
  WorkflowOrchestratorV1,
} from '../apps/runtime/src/workflow/workflowOrchestrator.js'

test('external Tool broker journals success and receipt in the same durable Activity', async () => {
  const fixture = await createFixture()
  try {
    const runtime = toolRuntime(fixture, true)
    const result = await runtime.execute(
      'process__fixture__send',
      { value: 'hello', idempotencyKey: 'send-1' },
      'D:/praxis',
      new AbortController().signal,
    )
    assert.equal(result.ok, true)
    const projection = await fixture.authority.get(fixture.workflowId)
    const activity = projection.spec.nodes.find(({ kind }) => kind === 'tool_activity')
    assert.equal(
      projection.nodes.find(({ nodeId }) => nodeId === activity?.nodeId)?.state,
      'succeeded',
    )
    const [receipt] = await fixture.authority.listEffectReceipts(fixture.workflowId)
    assert.equal(receipt?.idempotencyKey, 'send-1')
    assert.equal(
      receipt?.artifactRef.digest,
      projection.nodes.find(({ nodeId }) => nodeId === activity?.nodeId)?.resultRef?.digest,
    )
  } finally {
    await fixture.close()
  }
})

test('solo mode journals mutable Tool Activities without admitting child agents', async () => {
  const fixture = await createFixture('solo')
  try {
    const result = await toolRuntime(fixture, true).execute(
      'process__fixture__send',
      { value: 'solo', idempotencyKey: 'solo-send-1' },
      'D:/praxis',
      new AbortController().signal,
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    const projection = await fixture.authority.get(fixture.workflowId)
    assert.equal(projection.spec.modePolicy, 'solo')
    assert.equal(projection.spec.nodes.filter(({ kind }) => kind === 'tool_activity').length, 1)
    assert.equal(projection.spec.nodes.filter(({ kind }) => kind === 'agent_task').length, 1)
  } finally {
    await fixture.close()
  }
})

test('failed non-idempotent external Tool becomes unknown instead of being blindly retryable', async () => {
  const fixture = await createFixture()
  try {
    const runtime = toolRuntime(fixture, false)
    const result = await runtime.execute(
      'process__fixture__send',
      { value: 'uncertain' },
      'D:/praxis',
      new AbortController().signal,
    )
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'WORKFLOW_EFFECT_OUTCOME_UNKNOWN')
    assert.match(result.summary, /inspect current state before retrying/u)
    const projection = await fixture.authority.get(fixture.workflowId)
    assert.equal(
      projection.nodes.find(({ nodeId }) => nodeId.startsWith('activity-'))?.state,
      'unknown',
    )
  } finally {
    await fixture.close()
  }
})

test('known workspace Tool failures release reservations and do not poison root recovery', async () => {
  const fixture = await createFixture()
  try {
    const result = await toolRuntime(fixture, false, undefined, 'write').execute(
      'process__fixture__send',
      { value: 'known-local-failure' },
      'D:/praxis',
      new AbortController().signal,
    )
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'CONNECTION_LOST')
    let projection = await fixture.authority.get(fixture.workflowId)
    assert.equal(
      projection.nodes.find(({ nodeId }) => nodeId.startsWith('activity-'))?.state,
      'failed',
    )
    projection = await fixture.orchestrator.complete(fixture.rootClaim, { ok: true })
    assert.equal(projection.state, 'completed')
  } finally {
    await fixture.close()
  }
})

test('idempotency is reserved before invocation and committed results replay without a second effect', async () => {
  const fixture = await createFixture()
  let invocations = 0
  try {
    const runtime = toolRuntime(fixture, true, () => {
      invocations += 1
    })
    const input = { value: 'once', idempotencyKey: 'effect-once' }
    const first = await runtime.execute(
      'process__fixture__send',
      input,
      'D:/praxis',
      new AbortController().signal,
    )
    const proxy = runtime.brokeredTools(new Set(['process__fixture__send']))[0]!
    const replay = await proxy.execute({
      name: 'process__fixture__send',
      input,
      cwd: 'D:/praxis',
      signal: new AbortController().signal,
    })
    assert.equal(first.ok, true)
    assert.equal(replay.ok, true, JSON.stringify(replay))
    assert.equal(invocations, 1)
    assert.equal((await fixture.authority.listEffectReceipts(fixture.workflowId)).length, 1)
  } finally {
    await fixture.close()
  }
})

test('Saga compensation requires a second committed effect receipt and links both durably', async () => {
  const fixture = await createFixture()
  try {
    const runtime = toolRuntime(fixture, true)
    await runtime.execute(
      'process__fixture__send',
      { value: 'create', idempotencyKey: 'saga-create' },
      'D:/praxis',
      new AbortController().signal,
    )
    await runtime.execute(
      'process__fixture__send',
      { value: 'delete', idempotencyKey: 'saga-delete' },
      'D:/praxis',
      new AbortController().signal,
    )
    const receipts = await fixture.authority.listEffectReceipts(fixture.workflowId)
    assert.equal(receipts.length, 2)
    const result = await new WorkflowCompensationToolV1(
      fixture.orchestrator,
      fixture.workflowId,
    ).execute({
      name: 'workflow.compensate',
      input: {
        sourceReceiptArtifactId: receipts[0]!.artifactRef.artifactId,
        compensationReceiptArtifactId: receipts[1]!.artifactRef.artifactId,
      },
      cwd: 'D:/praxis',
      signal: new AbortController().signal,
    })
    assert.equal(result.ok, true)
    const [source] = await fixture.authority.listEffectReceipts(fixture.workflowId)
    assert.equal(source?.state, 'compensated')
    assert.equal(source?.compensationReceiptRef?.artifactId, receipts[1]!.artifactRef.artifactId)
    assert.ok(
      (await fixture.authority.events(fixture.workflowId)).some(
        ({ data }) => data.type === 'effect.compensated',
      ),
    )
  } finally {
    await fixture.close()
  }
})

async function createFixture(modePolicy: 'auto' | 'solo' = 'auto') {
  const root = await mkdtemp(join(tmpdir(), 'praxis-effect-broker-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  await authority.initialize()
  await registerBuiltinAgentProfilesV1(authority)
  const orchestrator = new WorkflowOrchestratorV1(authority)
  const workflow = await orchestrator.start({
    sessionId: 'session-effect',
    parentRunId: 'run-effect',
    objective: 'Execute an external effect.',
    modePolicy,
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
  const rootClaim = await orchestrator.claimRoot(workflow.workflowId, 'root-effect')
  await orchestrator.markRunning(rootClaim)
  const artifacts = new ArtifactStore(join(root, 'artifacts'))
  return {
    authority,
    orchestrator,
    artifacts,
    workflowId: workflow.workflowId,
    rootClaim,
    close: async () => {
      authority.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function toolRuntime(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  succeeds: boolean,
  onInvoke?: () => void,
  sideEffect: 'process' | 'write' = 'process',
): ToolRuntime {
  const tool: RuntimeTool = {
    definition: {
      name: 'process__fixture__send',
      description: 'External effect fixture.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: { value: { type: 'string' }, idempotencyKey: { type: 'string' } },
      },
      outputSchema: { type: 'object' },
      execution: {
        sideEffect,
        target: { kind: 'workspace' },
        parallelSafe: false,
        conflictScope: 'workspace',
        maxInlineBytes: 65_536,
      },
    },
    execute: async () => {
      onInvoke?.()
      return succeeds
        ? { ok: true, summary: 'sent', output: { accepted: true } }
        : {
            ok: false,
            summary: 'connection lost after send',
            error: { code: 'CONNECTION_LOST', category: 'execution', retryable: true },
          }
    },
  }
  return new ToolRuntime([tool], {
    artifactStore: fixture.artifacts,
    exposeArtifactTool: false,
    executionBroker: new WorkflowEffectBrokerV1(
      fixture.orchestrator,
      fixture.artifacts,
      fixture.workflowId,
    ),
  })
}
