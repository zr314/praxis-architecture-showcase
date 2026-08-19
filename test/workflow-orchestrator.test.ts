import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteWorkflowAuthorityV1 } from '../apps/runtime/src/workflow/sqliteWorkflowAuthority.js'
import {
  registerBuiltinAgentProfilesV1,
  WorkflowOrchestratorV1,
} from '../apps/runtime/src/workflow/workflowOrchestrator.js'

const grant = {
  tools: ['read', 'write', 'shell'],
  skills: ['typescript'],
  mcpServers: ['github'],
  workspace: 'write' as const,
  network: true,
  mayDelegate: true,
}

test('auto starts as one durable AgentTask and can grow by model delegate proposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-orchestrator-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const legacyProfile = await authority.getProfile('coordinator', 2)
    const v3Profile = await authority.getProfile('coordinator', 3)
    const currentProfile = await authority.getProfile('coordinator', 4)
    assert.equal(
      legacyProfile.digest,
      'sha256:f4a321cb797e77ad04d3b8976e36f847a6203ce2197bfc5be562540ccd7e3173',
    )
    assert.equal(legacyProfile.defaultBudget.maxTokens, 1_000_000)
    assert.equal(
      v3Profile.digest,
      'sha256:c158dcb4d8e1507d74eecf4eb0b1683e99086220a24bea59dd4d6378a78496b2',
    )
    assert.equal(v3Profile.defaultBudget.maxTokens, undefined)
    assert.equal(v3Profile.defaultBudget.maxTurns, 100_000)
    assert.equal(v3Profile.defaultBudget.maxToolCalls, 1_000_000)
    assert.equal(v3Profile.delegationPolicy.maxDepth, 64)
    assert.deepEqual(currentProfile.defaultBudget, {})
    assert.equal(currentProfile.delegationPolicy.maxDepth, Number.MAX_SAFE_INTEGER)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    let projection = await orchestrator.start({
      sessionId: 'session-1',
      parentRunId: 'parent-run-1',
      objective: 'Implement and review the change.',
      modePolicy: 'auto',
      cwd: 'D:/praxis',
      rootGrant: grant,
      createdAt: '2026-08-06T00:00:00.000Z',
    })
    assert.equal(projection.spec.topology, 'single_agent')
    assert.equal(projection.nodes.length, 1)
    assert.equal(projection.spec.nodes[0]?.profileRef?.version, 4)
    assert.equal(projection.spec.maxGraphMutations, Number.MAX_SAFE_INTEGER)
    const rootClaim = await orchestrator.claimRoot(projection.workflowId, 'root-worker')
    projection = await orchestrator.markRunning(rootClaim, '2026-08-06T00:00:01.000Z')
    assert.equal(projection.nodes[0]?.state, 'running')

    const delegated = await orchestrator.admitDelegate(
      projection.workflowId,
      'root',
      {
        schemaVersion: 1,
        proposalId: 'review-1',
        profileRef: { id: 'reviewer', version: 1 },
        objective: 'Review the implementation independently.',
        inputRefs: [],
        grantRequest: {
          tools: ['read', 'write'],
          skills: ['typescript'],
          mcpServers: ['github'],
          workspace: 'read',
          network: false,
          mayDelegate: true,
        },
        budgetRequest: { maxWallClockMs: 600_000, maxTokens: 200_000, maxToolCalls: 1_000 },
        reasons: ['INDEPENDENT_VERIFICATION'],
      },
      '2026-08-06T00:00:02.000Z',
    )
    assert.equal(delegated.projection.spec.topology, 'delegated_agents')
    assert.deepEqual(delegated.grant.tools, ['read', 'write'])
    assert.equal(delegated.grant.workspace, 'read')
    assert.equal(delegated.grant.mayDelegate, false)
    const childClaim = await authority.claim('child-worker', {
      workflowId: projection.workflowId,
      now: '2026-08-06T00:00:02.000Z',
    })
    assert.equal(childClaim?.task.nodeId, 'delegate-review-1')
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('delegate wildcard requests inherit the concrete parent capability grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-orchestrator-wildcard-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    const projection = await orchestrator.start({
      sessionId: 'session-wildcard',
      parentRunId: 'run-wildcard',
      objective: 'Delegate with inherited capabilities.',
      modePolicy: 'auto',
      cwd: 'D:/praxis',
      rootGrant: grant,
    })
    const admitted = await orchestrator.admitDelegate(projection.workflowId, 'root', {
      schemaVersion: 1,
      proposalId: 'inherit-parent',
      profileRef: { id: 'coder', version: 2 },
      objective: 'Implement the bounded change.',
      inputRefs: [],
      grantRequest: {
        tools: ['*'],
        skills: ['*'],
        mcpServers: ['*'],
        workspace: 'write',
        network: true,
        mayDelegate: false,
      },
      budgetRequest: {},
      reasons: ['MULTI_DOMAIN'],
    })
    assert.deepEqual(admitted.grant.tools, grant.tools)
    assert.deepEqual(admitted.grant.skills, grant.skills)
    assert.deepEqual(admitted.grant.mcpServers, grant.mcpServers)
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('solo uses the same orchestrator but rejects topology growth', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-orchestrator-solo-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    const projection = await orchestrator.start({
      sessionId: 'session-2',
      parentRunId: 'run-2',
      objective: 'Answer.',
      modePolicy: 'solo',
      cwd: 'D:/praxis',
      rootGrant: grant,
    })
    await assert.rejects(
      orchestrator.admitDelegate(projection.workflowId, 'root', {
        schemaVersion: 1,
        proposalId: 'denied',
        profileRef: { id: 'researcher', version: 1 },
        objective: 'Research.',
        inputRefs: [],
        grantRequest: { ...grant, workspace: 'read' },
        budgetRequest: {},
        reasons: ['PARALLEL_EVIDENCE'],
      }),
      (error: unknown) =>
        error instanceof Error && Reflect.get(error, 'code') === 'MODE_OVERRIDE_INCOMPATIBLE',
    )
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('durable controls stop claims, resume work, and terminal commands are idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-orchestrator-control-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    let projection = await orchestrator.start({
      sessionId: 'session-control',
      parentRunId: 'run-control',
      objective: 'Wait for durable control.',
      modePolicy: 'auto',
      cwd: 'D:/praxis',
      rootGrant: grant,
      createdAt: '2026-08-06T01:00:00.000Z',
    })

    projection = await orchestrator.pause(projection.workflowId, '2026-08-06T01:00:01.000Z')
    assert.equal(projection.state, 'paused')
    assert.equal(
      await authority.claim('paused-worker', {
        workflowId: projection.workflowId,
        now: '2026-08-06T01:00:02.000Z',
      }),
      undefined,
    )

    projection = await orchestrator.resume(projection.workflowId, '2026-08-06T01:00:03.000Z')
    assert.equal(projection.state, 'running')
    assert.ok(
      await authority.claim('resumed-worker', {
        workflowId: projection.workflowId,
        now: '2026-08-06T01:00:04.000Z',
      }),
    )

    projection = await orchestrator.cancel(
      projection.workflowId,
      'USER_STOP',
      '2026-08-06T01:00:05.000Z',
    )
    assert.equal(projection.state, 'cancelled')
    assert.equal(projection.terminalCode, 'USER_STOP')
    assert.equal(
      (await orchestrator.cancel(projection.workflowId, 'IGNORED')).sequence,
      projection.sequence,
    )

    const second = await orchestrator.start({
      sessionId: 'session-terminate',
      parentRunId: 'run-terminate',
      objective: 'Terminate durably.',
      modePolicy: 'workflow',
      cwd: 'D:/praxis',
      rootGrant: grant,
      createdAt: '2026-08-06T02:00:00.000Z',
    })
    const terminated = await orchestrator.terminate(
      second.workflowId,
      'ADMIN_STOP',
      '2026-08-06T02:00:01.000Z',
    )
    assert.equal(terminated.state, 'terminated')
    assert.equal(terminated.terminalCode, 'ADMIN_STOP')
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})
