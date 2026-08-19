import type { WorkflowNodeSpecV1, WorkflowSpecV1 } from '@praxis/core-sdk'

const at = '2026-08-06T00:00:00.000Z'

export function workflowSpec(
  modePolicy: WorkflowSpecV1['modePolicy'] = 'auto',
  nodes: readonly WorkflowNodeSpecV1[] = [rootNode()],
  edges: WorkflowSpecV1['edges'] = [],
): WorkflowSpecV1 {
  return {
    schemaVersion: 1,
    workflowId: 'workflow-1',
    runId: 'workflow-run-1',
    sessionId: 'session-1',
    workspace: 'D:/praxis',
    objective: 'Complete the requested work.',
    modePolicy,
    topology: nodes.length === 1 ? 'single_agent' : 'workflow_graph',
    revision: 1,
    nodes,
    edges,
    completion: 'all_required',
    budget: {
      maxWallClockMs: 3_600_000,
      maxTokens: 1_000_000,
      maxToolCalls: 10_000,
      maxAgentTasks: 128,
      maxParallelTasks: 16,
    },
    maxGraphMutations: 128,
    createdAt: at,
  }
}

export function rootNode(): WorkflowNodeSpecV1 {
  return {
    nodeId: 'root',
    kind: 'agent_task',
    title: 'Root AgentTask',
    profileRef: { id: 'coordinator', version: 1 },
    inputRefs: [],
    grantRequest: {
      tools: ['*'],
      skills: ['*'],
      mcpServers: ['*'],
      workspace: 'write',
      network: true,
      mayDelegate: true,
    },
    effect: { class: 'workspace_write', requiresApproval: false },
    retry: {
      maxAttempts: 3,
      initialBackoffMs: 100,
      maxBackoffMs: 5_000,
      retryableCodes: ['PROVIDER_RATE_LIMITED'],
    },
    timeout: { totalMs: 3_600_000, noProgressMs: 600_000, heartbeatMs: 10_000 },
    criteria: [],
  }
}
