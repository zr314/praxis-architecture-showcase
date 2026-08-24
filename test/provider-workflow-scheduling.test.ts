import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  providerWorkflowConcurrencyPolicyV1,
  workflowSchedulingForProviderV1,
} from '../apps/runtime/src/providers/providerExecutionPolicy.js'
import { SqliteWorkflowAuthorityV1 } from '../apps/runtime/src/workflow/sqliteWorkflowAuthority.js'
import { WorkflowOrchestratorV1 } from '../apps/runtime/src/workflow/workflowOrchestrator.js'

const grant = {
  tools: ['*'],
  skills: ['*'],
  mcpServers: ['*'],
  workspace: 'write' as const,
  network: true,
  mayDelegate: true,
}

test('provider workflow policy has built-in limits and supports one centralized override', () => {
  const defaults = providerWorkflowConcurrencyPolicyV1({})
  assert.equal(defaults.defaultLimit, 4)
  assert.equal(defaults.providerLimits.minimax, 2)
  assert.equal(defaults.providerLimits['minimax-cn'], 2)

  const overridden = providerWorkflowConcurrencyPolicyV1({
    PRAXIS_WORKFLOW_PROVIDER_CONCURRENCY: '{"*":7,"minimax":3,"custom-provider":5}',
  })
  assert.equal(overridden.defaultLimit, 7)
  assert.equal(overridden.providerLimits.minimax, 3)
  assert.equal(overridden.providerLimits['custom-provider'], 5)
  assert.throws(
    () =>
      providerWorkflowConcurrencyPolicyV1({
        PRAXIS_WORKFLOW_PROVIDER_CONCURRENCY: '{"minimax":0}',
      }),
    (error: unknown) =>
      Reflect.get(error as object, 'code') === 'WORKFLOW_PROVIDER_CONCURRENCY_INVALID',
  )
})

test('authority atomically enforces persisted Provider capacity across Workflows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-provider-capacity-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    const orchestrator = new WorkflowOrchestratorV1(authority)
    const policy = { defaultLimit: 1, providerLimits: {} }
    const first = await orchestrator.start({
      sessionId: 'provider-capacity-first',
      parentRunId: 'provider-capacity-first-run',
      objective: 'first',
      modePolicy: 'workflow',
      cwd: 'D:/praxis',
      rootGrant: grant,
      executionTarget: { providerId: 'provider-a', model: 'model-a' },
      scheduling: workflowSchedulingForProviderV1('provider-a', policy),
    })
    const second = await orchestrator.start({
      sessionId: 'provider-capacity-second',
      parentRunId: 'provider-capacity-second-run',
      objective: 'second',
      modePolicy: 'workflow',
      cwd: 'D:/praxis',
      rootGrant: grant,
      executionTarget: { providerId: 'provider-a', model: 'model-a' },
      scheduling: workflowSchedulingForProviderV1('provider-a', policy),
    })
    const other = await orchestrator.start({
      sessionId: 'provider-capacity-other',
      parentRunId: 'provider-capacity-other-run',
      objective: 'other',
      modePolicy: 'workflow',
      cwd: 'D:/praxis',
      rootGrant: grant,
      executionTarget: { providerId: 'provider-b', model: 'model-b' },
      scheduling: workflowSchedulingForProviderV1('provider-b', policy),
    })

    const firstClaim = await orchestrator.claimRoot(first.workflowId, 'provider-worker-first')
    assert.equal(
      await authority.claim('provider-worker-blocked', {
        workflowId: second.workflowId,
        nodeId: 'root',
        kinds: ['agent'],
      }),
      undefined,
    )
    assert.equal(
      (await orchestrator.claimRoot(other.workflowId, 'provider-worker-other')).task.workflowId,
      other.workflowId,
    )

    await orchestrator.markRunning(firstClaim)
    await orchestrator.complete(firstClaim, { ok: true })
    assert.equal(
      (await orchestrator.claimRoot(second.workflowId, 'provider-worker-second')).task.workflowId,
      second.workflowId,
    )
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})
