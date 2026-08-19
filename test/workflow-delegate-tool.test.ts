import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { WorkflowTaskClaimV1 } from '@praxis/core-sdk'
import { AgentDelegateToolV1 } from '../apps/runtime/src/workflow/agentDelegateTool.js'
import { SqliteWorkflowAuthorityV1 } from '../apps/runtime/src/workflow/sqliteWorkflowAuthority.js'
import {
  registerBuiltinAgentProfilesV1,
  WorkflowOrchestratorV1,
} from '../apps/runtime/src/workflow/workflowOrchestrator.js'

test('agent.delegate is a model proposal admitted through the durable workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-delegate-tool-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    const projection = await orchestrator.start({
      sessionId: 'session-1',
      parentRunId: 'run-1',
      objective: 'Build and review.',
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
    const rootClaim = await orchestrator.claimRoot(projection.workflowId, 'root')
    await orchestrator.markRunning(rootClaim)
    let delegatedClaim: WorkflowTaskClaimV1 | undefined
    const tool = new AgentDelegateToolV1(
      orchestrator,
      {
        execute: async (claim) => {
          delegatedClaim = claim
          return {
            ok: true,
            summary: 'Independent review completed.',
            output: { findings: [] },
            artifacts: [],
            errorCode: undefined,
          }
        },
      },
      projection.workflowId,
    )
    const result = await tool.execute({
      name: 'agent.delegate',
      cwd: 'D:/praxis',
      signal: new AbortController().signal,
      input: {
        profile: 'explorer',
        objective: 'Review the change.',
        reasons: ['INDEPENDENT_VERIFICATION'],
        workspace: 'read',
        maxTokens: 2_000,
        instructions: 'Cross-check every conclusion against a file reference.',
        model: { tier: 'fast', reasoningEffort: 'low' },
        result: { format: 'json', schema: { type: 'object' } },
        successCriteria: [{ id: 'evidence', description: 'Cite inspected evidence.' }],
      },
    })
    assert.equal(result.ok, true)
    assert.equal((result.output as { profile: string }).profile, 'explorer')
    assert.equal(
      (delegatedClaim?.task.payload.budget as { maxTokens?: number } | undefined)?.maxTokens,
      2_000,
    )
    assert.deepEqual(delegatedClaim?.task.payload.assemblyRequest, {
      instructions: 'Cross-check every conclusion against a file reference.',
      model: { tier: 'fast', reasoningEffort: 'low' },
      result: { format: 'json', schema: { type: 'object' } },
      successCriteria: [{ id: 'evidence', description: 'Cite inspected evidence.' }],
    })
    assert.equal(
      (delegatedClaim?.task.payload.capabilityRequest as { mayDelegate: boolean } | undefined)
        ?.mayDelegate,
      false,
    )
    const after = await authority.get(projection.workflowId)
    assert.equal(after.spec.topology, 'delegated_agents')
    assert.equal(
      after.nodes.find(({ nodeId }) => nodeId.startsWith('delegate-'))?.state,
      'succeeded',
    )
    assert.equal(after.state, 'running')
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})
