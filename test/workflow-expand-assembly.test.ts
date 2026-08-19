import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { WorkflowTaskClaimV1 } from '@praxis/core-sdk'
import { ToolRuntime } from '../apps/runtime/src/tools/toolRuntime.js'
import {
  boundedUtf8Summary,
  dependencyResultRefsV1,
  workflowStepTitle,
} from '../apps/runtime/src/workflow/localWorkflowAgentWorker.js'
import { SqliteWorkflowAuthorityV1 } from '../apps/runtime/src/workflow/sqliteWorkflowAuthority.js'
import { WorkflowExpandToolV1 } from '../apps/runtime/src/workflow/workflowExpandTool.js'
import {
  registerBuiltinAgentProfilesV1,
  WorkflowOrchestratorV1,
} from '../apps/runtime/src/workflow/workflowOrchestrator.js'

test('workflow.expand persists per-node assembly for parallel, serial, and cross-review DAGs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-expand-assembly-'))
  const authority = new SqliteWorkflowAuthorityV1(root)
  try {
    await authority.initialize()
    await registerBuiltinAgentProfilesV1(authority)
    const orchestrator = new WorkflowOrchestratorV1(authority)
    const projection = await orchestrator.start({
      sessionId: 'session-expand',
      parentRunId: 'run-expand',
      objective: 'Investigate, implement, and review.',
      modePolicy: 'auto',
      cwd: 'D:/praxis',
      rootGrant: {
        tools: ['read', 'write', 'shell'],
        skills: ['repo-guide'],
        mcpServers: ['code-index'],
        workspace: 'write',
        network: true,
        mayDelegate: true,
      },
    })
    const rootClaim = await orchestrator.claimRoot(projection.workflowId, 'root-expand')
    await orchestrator.markRunning(rootClaim)
    const claims: WorkflowTaskClaimV1[] = []
    const tool = new WorkflowExpandToolV1(
      orchestrator,
      {
        execute: async (claim) => {
          claims.push(claim)
          return {
            ok: true,
            summary: `completed ${claim.task.nodeId}`,
            output: {},
            artifacts: [
              {
                artifactId: `artifact-${claim.task.attemptId}`,
                digest: `sha256:${'a'.repeat(64)}`,
                mediaType: 'application/json',
              },
            ],
          }
        },
      },
      projection.workflowId,
    )
    const expansionInput = {
      nodes: [
        {
          id: 'explore',
          profile: 'explorer',
          objective: 'Inspect relevant code.',
          dependencies: [],
          tools: ['read'],
          skills: ['repo-guide'],
          workspace: 'read',
          maxTokens: 4_096,
          model: { tier: 'fast', reasoningEffort: 'low' },
        },
        {
          id: 'implement',
          profile: 'worker',
          objective: 'Implement the bounded change.',
          dependencies: ['explore'],
          tools: ['read', 'write', 'shell'],
          workspace: 'write',
          instructions: 'Use the explorer result and verify the change.',
        },
        {
          id: 'cross-review',
          profile: 'default',
          objective: 'Independently review the implementation.',
          dependencies: ['implement'],
          workspace: 'read',
          successCriteria: [
            { id: 'independent-review', description: 'Identify any remaining defect.' },
          ],
        },
      ],
    }
    assert.equal(
      new ToolRuntime([tool], { exposeArtifactTool: false }).validateInput(
        'workflow.expand',
        expansionInput,
      ),
      undefined,
    )
    const result = await tool.execute({
      name: 'workflow.expand',
      cwd: 'D:/praxis',
      signal: new AbortController().signal,
      input: expansionInput,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(
      claims.map(({ task }) => task.profileRef?.id),
      ['explorer', 'worker', 'default'],
    )
    assert.deepEqual(
      claims.map(({ task }) => task.profileRef?.version),
      [4, 4, 4],
    )
    assert.deepEqual(claims[0]?.task.payload.assemblyRequest, {
      model: { tier: 'fast', reasoningEffort: 'low' },
    })
    assert.equal(
      (claims[0]?.task.payload.budget as { maxTokens?: number } | undefined)?.maxTokens,
      4_096,
    )
    assert.equal(
      (claims[1]?.task.payload.budget as { maxTokens?: number } | undefined)?.maxTokens,
      undefined,
    )
    assert.equal(
      (claims[1]?.task.payload.assemblyRequest as { instructions?: string } | undefined)
        ?.instructions,
      'Use the explorer result and verify the change.',
    )
    assert.equal(
      (
        claims[2]?.task.payload.assemblyRequest as
          | { successCriteria?: readonly { id: string }[] }
          | undefined
      )?.successCriteria?.[0]?.id,
      'independent-review',
    )
    const finalProjection = await authority.get(projection.workflowId)
    assert.deepEqual(
      dependencyResultRefsV1(finalProjection, claims[2]!.task.nodeId).map(
        ({ artifactId }) => artifactId,
      ),
      [`artifact-${claims[1]!.task.attemptId}`],
    )

    const priorReviewNodeId = (result.output as { graph: { nodeIds: Record<string, string> } })
      .graph.nodeIds['cross-review']!
    const explicitInput = {
      artifactId: `artifact-${'b'.repeat(64)}`,
      digest: `sha256:${'b'.repeat(64)}` as const,
      mediaType: 'application/vnd.praxis.external-review+json',
    }
    const replacement = await tool.execute({
      name: 'workflow.expand',
      cwd: 'D:/praxis',
      signal: new AbortController().signal,
      input: {
        nodes: [
          {
            id: 'replacement-synthesis',
            profile: 'default',
            objective: 'Reuse a successful prior node and an explicit persisted artifact.',
            dependencies: [priorReviewNodeId],
            inputRefs: [explicitInput],
            workspace: 'read',
            tools: ['read'],
          },
        ],
      },
    })

    assert.equal(replacement.ok, true)
    assert.deepEqual(claims[3]?.task.payload.inputRefs, [explicitInput])
    const replacementProjection = await authority.get(projection.workflowId)
    assert.deepEqual(
      dependencyResultRefsV1(replacementProjection, claims[3]!.task.nodeId).map(
        ({ artifactId }) => artifactId,
      ),
      [`artifact-${claims[2]!.task.attemptId}`],
    )
  } finally {
    authority.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('dependency context summaries honor UTF-8 byte limits for multilingual results', () => {
  const summary = boundedUtf8Summary('成功读取并核对前驱结果。'.repeat(200), 1_024)
  assert.ok(Buffer.byteLength(summary, 'utf8') <= 1_024)
  assert.ok(summary.endsWith('...'))
  assert.equal(summary.includes('\uFFFD'), false)
})

test('workflow child titles summarize long multilingual objectives within the packet limit', () => {
  const objective = `\n\n${'只读审计运行时韧性、恢复和安全边界。'.repeat(100)}\n保留完整后续说明。`
  const title = workflowStepTitle(objective)

  assert.ok(Buffer.byteLength(objective, 'utf8') > 1_024)
  assert.ok(Buffer.byteLength(title, 'utf8') <= 1_024)
  assert.ok(title.endsWith('...'))
  assert.equal(title.includes('\uFFFD'), false)
})
