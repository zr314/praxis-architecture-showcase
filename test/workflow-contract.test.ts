import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyWorkflowEventV1,
  initialWorkflowProjectionV1,
  readyWorkflowNodeIdsV1,
  workflowNodeReadinessV1,
  validateWorkflowSpecV1,
  type WorkflowEventV1,
  type WorkflowNodeSpecV1,
  type WorkflowSpecV1,
} from '@praxis/core-sdk'

const at = '2026-08-06T00:00:00.000Z'

test('workflow contract creates one root AgentTask for every mode policy', () => {
  for (const modePolicy of ['auto', 'solo', 'workflow'] as const) {
    const spec = workflowSpec(modePolicy)
    const projection = initialWorkflowProjectionV1(spec)
    assert.equal(projection.state, 'created')
    assert.equal(projection.nodes[0]?.nodeId, 'root')
    assert.deepEqual(projection.attempts, [])
  }
})

test('workflow usage accounting preserves a final-turn budget overshoot', () => {
  const spec = {
    ...workflowSpec(),
    budget: { ...workflowSpec().budget, maxTokens: 10 },
  }
  let projection = initialWorkflowProjectionV1(spec)
  projection = apply(projection, 1, { type: 'workflow.created', spec })
  projection = apply(projection, 2, {
    type: 'budget.charged',
    turns: 1,
    toolCalls: 0,
    inputTokens: 11,
    outputTokens: 1,
    agentTasks: 0,
  })
  assert.equal(projection.usage.inputTokens + projection.usage.outputTokens, 12)
})

test('solo is a topology constraint rather than a second execution implementation', () => {
  assert.throws(
    () =>
      validateWorkflowSpecV1({
        ...workflowSpec('solo'),
        nodes: [rootNode(), { ...rootNode(), nodeId: 'child' }],
      }),
    (error: unknown) =>
      error instanceof Error && Reflect.get(error, 'code') === 'MODE_OVERRIDE_INCOMPATIBLE',
  )
})

test('solo permits durable Tool Activities without permitting child AgentTasks', () => {
  const spec = workflowSpec('solo')
  assert.doesNotThrow(() =>
    validateWorkflowSpecV1({
      ...spec,
      topology: 'workflow_graph',
      nodes: [
        rootNode(),
        {
          ...rootNode(),
          nodeId: 'activity-write',
          kind: 'tool_activity',
          title: 'write',
          profileRef: undefined,
        },
      ],
    }),
  )
})

test('workflow contracts do not impose a lifetime node or edge ceiling', () => {
  const nodes = Array.from({ length: 300 }, (_, index) => ({
    ...rootNode(),
    nodeId: index === 0 ? 'root' : `node-${index}`,
    title: `Node ${index}`,
  }))
  const denseNodes = nodes.slice(0, 66)
  const edges = denseNodes.flatMap((from, fromIndex) =>
    denseNodes.slice(fromIndex + 1).map((to) => ({ from: from.nodeId, to: to.nodeId })),
  )

  assert.ok(nodes.length > 256)
  assert.ok(edges.length > 2_048)
  assert.doesNotThrow(() => validateWorkflowSpecV1(workflowSpec('workflow', nodes, edges)))
})

test('ready nodes are derived deterministically from durable dependencies', () => {
  const spec = workflowSpec(
    'workflow',
    [rootNode(), { ...rootNode(), nodeId: 'verify', title: 'Verify', kind: 'verification' }],
    [{ from: 'root', to: 'verify' }],
  )
  let projection = initialWorkflowProjectionV1(spec)
  projection = apply(projection, 1, { type: 'workflow.created', spec })
  projection = apply(projection, 2, { type: 'workflow.started' })
  projection = apply(projection, 3, {
    type: 'node.state_changed',
    nodeId: 'root',
    state: 'admitted',
  })
  assert.deepEqual(readyWorkflowNodeIdsV1(projection), ['root'])
  projection = apply(projection, 4, {
    type: 'node.state_changed',
    nodeId: 'root',
    state: 'scheduled',
  })
  projection = apply(projection, 5, { type: 'node.state_changed', nodeId: 'root', state: 'leased' })
  projection = apply(projection, 6, {
    type: 'node.state_changed',
    nodeId: 'root',
    state: 'running',
  })
  projection = apply(projection, 7, {
    type: 'node.state_changed',
    nodeId: 'root',
    state: 'succeeded',
  })
  assert.deepEqual(readyWorkflowNodeIdsV1(projection), ['verify'])
})

test('conditional branches become ready or skipped and join waits only for selected branches', () => {
  const nodes = [
    rootNode(),
    { ...rootNode(), nodeId: 'selected', title: 'Selected' },
    { ...rootNode(), nodeId: 'unselected', title: 'Unselected' },
    { ...rootNode(), nodeId: 'join', title: 'Join', kind: 'synthesis' as const },
  ]
  const spec = workflowSpec('workflow', nodes, [
    {
      from: 'root',
      to: 'selected',
      condition: { operator: 'status_is', value: 'succeeded' },
    },
    {
      from: 'root',
      to: 'unselected',
      condition: { operator: 'status_is', value: 'failed' },
    },
    { from: 'selected', to: 'join' },
    { from: 'unselected', to: 'join' },
  ])
  let projection = initialWorkflowProjectionV1(spec)
  projection = apply(projection, 1, { type: 'workflow.created', spec })
  projection = apply(projection, 2, { type: 'workflow.started' })
  for (const nodeId of ['root', 'selected', 'unselected', 'join'])
    projection = apply(projection, projection.sequence + 1, {
      type: 'node.state_changed',
      nodeId,
      state: 'admitted',
    })
  projection = apply(projection, projection.sequence + 1, {
    type: 'node.state_changed',
    nodeId: 'root',
    state: 'scheduled',
  })
  projection = apply(projection, projection.sequence + 1, {
    type: 'node.state_changed',
    nodeId: 'root',
    state: 'leased',
  })
  projection = apply(projection, projection.sequence + 1, {
    type: 'node.state_changed',
    nodeId: 'root',
    state: 'running',
  })
  projection = apply(projection, projection.sequence + 1, {
    type: 'node.state_changed',
    nodeId: 'root',
    state: 'succeeded',
  })
  assert.equal(workflowNodeReadinessV1(projection, 'selected'), 'ready')
  assert.equal(workflowNodeReadinessV1(projection, 'unselected'), 'skipped')
  projection = apply(projection, projection.sequence + 1, {
    type: 'node.state_changed',
    nodeId: 'unselected',
    state: 'skipped',
  })
  for (const state of ['scheduled', 'leased', 'running', 'succeeded'] as const)
    projection = apply(projection, projection.sequence + 1, {
      type: 'node.state_changed',
      nodeId: 'selected',
      state,
    })
  assert.equal(workflowNodeReadinessV1(projection, 'join'), 'ready')
})

function apply(
  projection: ReturnType<typeof initialWorkflowProjectionV1>,
  sequence: number,
  data: WorkflowEventV1['data'],
) {
  return applyWorkflowEventV1(projection, {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    workflowId: projection.workflowId,
    runId: projection.runId,
    sequence,
    occurredAt: at,
    data,
  })
}

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
