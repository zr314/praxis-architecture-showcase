import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type {
  ReserveWorkflowEffectRequestV1,
  WorkflowNodeSpecV1,
  WorkflowSpecV1,
} from '@praxis/core-sdk'
import { SqliteWorkflowAuthorityV1 } from '../apps/runtime/src/workflow/sqliteWorkflowAuthority.js'

test('internal effect requests persist exact Plan ownership independently of external idempotency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-effect-request-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await authority.create(spec(), 'create-workflow')
    const workspace = request('workspace_write', 'effect-workspace')
    const first = await authority.reserveEffectRequest(workspace)
    assert.equal(first.replayed, false)
    assert.equal(first.request.externalIdempotencyKey, undefined)
    assert.equal(first.request.executionBinding.itemAttemptId, 'item-attempt-1')
    assert.equal((await authority.reserveEffectRequest(workspace)).replayed, true)

    const external = request('external_idempotent', 'effect-external', 'provider-key-1')
    assert.equal(
      (await authority.reserveEffectRequest(external)).request.externalIdempotencyKey,
      'provider-key-1',
    )

    const nonIdempotent = request('external_non_idempotent', 'effect-non-idempotent')
    assert.equal(
      (await authority.reserveEffectRequest(nonIdempotent)).request.externalIdempotencyKey,
      undefined,
    )

    authority.close()
    const reopened = new SqliteWorkflowAuthorityV1(root)
    await reopened.initialize()
    assert.equal(
      (await reopened.getEffectRequestByRequestId('workflow-effect', 'effect-workspace'))
        ?.requestDigest,
      workspace.requestDigest,
    )
    await assert.rejects(
      reopened.reserveEffectRequest({
        ...workspace,
        requestDigest: `sha256:${'b'.repeat(64)}`,
      }),
      hasCode('WORKFLOW_EFFECT_REQUEST_CONFLICT'),
    )
    reopened.close()
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

function request(
  effectKind: ReserveWorkflowEffectRequestV1['effectKind'],
  requestId: string,
  externalIdempotencyKey?: string,
): ReserveWorkflowEffectRequestV1 {
  return {
    request: {
      sessionId: 'session-effect',
      planId: 'plan-1',
      planRevision: 1,
      itemId: 'item-1',
      itemAttemptId: 'item-attempt-1',
      requestId,
      workflowId: 'workflow-effect',
      inputDigest: `sha256:${'c'.repeat(64)}`,
    },
    requestDigest: `sha256:${'a'.repeat(64)}`,
    effectKind,
    ...(externalIdempotencyKey === undefined ? {} : { externalIdempotencyKey }),
    leaseExpiresAt: '2026-09-02T01:00:00.000Z',
    at: '2026-09-02T00:00:00.000Z',
  }
}

function spec(): WorkflowSpecV1 {
  return {
    schemaVersion: 1,
    workflowId: 'workflow-effect',
    runId: 'run-effect',
    sessionId: 'session-effect',
    workspace: process.cwd(),
    objective: 'Execute effect.',
    modePolicy: 'auto',
    topology: 'single_agent',
    revision: 1,
    nodes: [node()],
    edges: [],
    completion: 'all_required',
    budget: {
      maxWallClockMs: 60_000,
      maxTokens: 1_000,
      maxToolCalls: 10,
      maxAgentTasks: 10,
      maxParallelTasks: 2,
    },
    maxGraphMutations: 0,
    createdAt: '2026-09-02T00:00:00.000Z',
  }
}

function node(): WorkflowNodeSpecV1 {
  return {
    nodeId: 'root',
    kind: 'agent_task',
    title: 'Root',
    inputRefs: [],
    grantRequest: {
      tools: [],
      skills: [],
      mcpServers: [],
      workspace: 'write',
      network: true,
      mayDelegate: false,
    },
    effect: { class: 'pure', requiresApproval: false },
    retry: { maxAttempts: 1, initialBackoffMs: 100, maxBackoffMs: 100, retryableCodes: [] },
    timeout: { totalMs: 60_000, noProgressMs: 30_000, heartbeatMs: 10_000 },
    criteria: [],
  }
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}
