import { randomUUID } from 'node:crypto'
import type {
  AgentAssemblyRequestV1,
  AgentBudgetRequestV1,
  AgentProfileV1,
  CapabilityRequestV1,
  DelegateProposalV1,
  GraphPatchProposalV1,
  GraphProposalV1,
  WorkflowAuthorityPortV1,
  WorkflowBudgetV1,
  WorkflowHumanTaskV1,
  WorkflowJoinPolicyV1,
  WorkflowMessageTypeV1,
  WorkflowModePolicyV1,
  WorkflowNodeKindV1,
  WorkflowNodeSpecV1,
  WorkflowProjectionV1,
  WorkflowSpecV1,
  WorkflowTaskClaimV1,
  WorkflowTaskV1,
  WorkflowTimerV1,
} from '@praxis/core-sdk'
import { promptDigest, workflowNodeReadinessV1 } from '@praxis/core-sdk'
import { canonicalDeadlineAfter } from '../longDurationTimer.js'
import {
  ACTIVE_BUILTIN_AGENT_PROFILE_VERSION,
  BUILTIN_AGENT_PROFILE_V3_LIMITS,
  LONG_LIVED_EXECUTION_POLICY_V1,
} from '../longLivedExecutionPolicy.js'

const DEFAULT_WORKFLOW_BUDGET: WorkflowBudgetV1 = Object.freeze({
  maxWallClockMs: LONG_LIVED_EXECUTION_POLICY_V1.maxWallClockMs,
  maxTokens: LONG_LIVED_EXECUTION_POLICY_V1.maxWorkflowTokens,
  maxToolCalls: LONG_LIVED_EXECUTION_POLICY_V1.maxWorkflowToolCalls,
  maxAgentTasks: LONG_LIVED_EXECUTION_POLICY_V1.maxChildRuns,
  maxParallelTasks: LONG_LIVED_EXECUTION_POLICY_V1.maxParallelChildren,
})

export type StartAutoWorkflowInputV1 = Readonly<{
  sessionId: string
  parentRunId: string
  objective: string
  modePolicy: WorkflowModePolicyV1
  cwd: string
  rootGrant: CapabilityRequestV1
  budget?: WorkflowBudgetV1
  createdAt?: string
  parentWorkflowId?: string
  parentNodeId?: string
  executionTarget?: Readonly<{ providerId: string; model: string }>
  rootAssemblyRequest?: AgentAssemblyRequestV1
  rootHarnessProfile?: import('@praxis/core-sdk').AgentHarnessProfileV1
}>

export type AdmittedDelegateV1 = Readonly<{
  projection: WorkflowProjectionV1
  task: WorkflowTaskV1
  profile: AgentProfileV1
  grant: CapabilityRequestV1
}>

export type AgentGraphNodeProposalV1 = Readonly<{
  key: string
  profileId: string
  objective: string
  dependencies: readonly string[]
  dependsOnNodeIds?: readonly string[]
  inputRefs?: readonly import('@praxis/core-sdk').WorkflowArtifactRefV1[]
  maxIterations?: number
  conditions?: readonly Readonly<{
    dependency: string
    operator: 'status_is' | 'exists' | 'eq' | 'in'
    pointer?: string
    value?: unknown
  }>[]
  grantRequest: CapabilityRequestV1
  budgetRequest?: AgentBudgetRequestV1
  assemblyRequest?: AgentAssemblyRequestV1
}>

export type AdmittedAgentGraphV1 = Readonly<{
  projection: WorkflowProjectionV1
  joinNodeId?: string
  nodes: readonly Readonly<{
    key: string
    nodeId: string
    task: WorkflowTaskV1
    profile: AgentProfileV1
    grant: CapabilityRequestV1
  }>[]
}>

export type AdmittedWaitNodeV1 = Readonly<{
  projection: WorkflowProjectionV1
  nodeId: string
  attemptId: string
}>

export type AdmittedToolActivityV1 = Readonly<{
  projection: WorkflowProjectionV1
  task: WorkflowTaskV1
}>

/** Deterministic control plane. It never interprets free-form model text. */
export class WorkflowOrchestratorV1 {
  constructor(private readonly authority: WorkflowAuthorityPortV1) {}

  projection(workflowId: string) {
    return this.authority.get(workflowId)
  }

  listMessages(
    options: Readonly<{
      workflowId: string
      recipientNodeId?: string
      afterSequence?: number
      types?: readonly WorkflowMessageTypeV1[]
      includeAcknowledged?: boolean
      limit?: number
    }>,
  ) {
    return this.authority.listMessages(options)
  }

  acknowledgeMessages(workflowId: string, recipientNodeId: string, throughSequence: number) {
    return this.authority.acknowledgeMessages(workflowId, recipientNodeId, throughSequence)
  }

  acknowledgeMessage(workflowId: string, messageId: string, recipientNodeId: string) {
    return this.authority.acknowledgeMessage(workflowId, messageId, recipientNodeId)
  }

  async start(input: StartAutoWorkflowInputV1): Promise<WorkflowProjectionV1> {
    const at = input.createdAt ?? new Date().toISOString()
    const workflowId = `workflow-${randomUUID()}`
    const runId = `workflow-run-${randomUUID()}`
    const nodeId = 'root'
    const attemptId = `attempt-${randomUUID()}`
    const spec: WorkflowSpecV1 = {
      schemaVersion: 1,
      workflowId,
      runId,
      sessionId: input.sessionId,
      ...(input.parentWorkflowId === undefined
        ? {}
        : { parentWorkflowId: input.parentWorkflowId, parentNodeId: input.parentNodeId }),
      ...(input.executionTarget === undefined ? {} : { executionTarget: input.executionTarget }),
      workspace: input.cwd,
      objective: input.objective,
      modePolicy: input.modePolicy,
      topology: 'single_agent',
      revision: 1,
      nodes: [rootNode(nodeId, input.rootGrant)],
      edges: [],
      completion: 'all_required',
      budget: input.budget ?? DEFAULT_WORKFLOW_BUDGET,
      maxGraphMutations: LONG_LIVED_EXECUTION_POLICY_V1.maxGraphMutations,
      createdAt: at,
    }
    const task = agentTask({
      workflowId,
      runId,
      nodeId,
      attemptId,
      objective: input.objective,
      cwd: input.cwd,
      profileId: 'coordinator',
      profileVersion: 2,
      node: spec.nodes[0]!,
      assemblyRequest: input.rootAssemblyRequest,
      harnessProfile: input.rootHarnessProfile,
      at,
    })
    return this.authority.create(spec, `start-${workflowId}`, {
      events: [
        { type: 'node.state_changed', nodeId, state: 'admitted' },
        { type: 'node.state_changed', nodeId, state: 'scheduled' },
        { type: 'attempt.created', attempt: { attemptId, nodeId, ordinal: 1, state: 'scheduled' } },
      ],
      tasks: [task],
      outbox: [
        {
          messageId: `outbox-${task.taskId}`,
          workflowId,
          topic: 'workflow.task.ready',
          key: task.taskId,
          payload: { taskId: task.taskId },
          availableAt: at,
        },
      ],
    })
  }

  async claimRoot(workflowId: string, workerId: string): Promise<WorkflowTaskClaimV1> {
    const claim = await this.authority.claim(workerId, {
      workflowId,
      nodeId: 'root',
      kinds: ['agent'],
    })
    if (claim === undefined) throw workflowFailure('WORKFLOW_ROOT_TASK_UNAVAILABLE')
    return claim
  }

  async claimNode(
    workflowId: string,
    nodeId: string,
    workerId: string,
  ): Promise<WorkflowTaskClaimV1> {
    const claim = await this.authority.claim(workerId, {
      workflowId,
      nodeId,
      kinds: ['agent', 'subworkflow'],
    })
    if (claim === undefined || claim.task.nodeId !== nodeId)
      throw workflowFailure('WORKFLOW_NODE_TASK_UNAVAILABLE')
    return claim
  }

  async claimActivity(
    workflowId: string,
    nodeId: string,
    workerId: string,
  ): Promise<WorkflowTaskClaimV1> {
    const claim = await this.authority.claim(workerId, {
      workflowId,
      nodeId,
      kinds: ['tool', 'compensation'],
    })
    if (claim === undefined || claim.task.nodeId !== nodeId)
      throw workflowFailure('WORKFLOW_ACTIVITY_TASK_UNAVAILABLE')
    return claim
  }

  async markRunning(
    claim: WorkflowTaskClaimV1,
    at = new Date().toISOString(),
  ): Promise<WorkflowProjectionV1> {
    while (true) {
      const projection = await this.authority.get(claim.task.workflowId)
      const node = projection.nodes.find(({ nodeId }) => nodeId === claim.task.nodeId)
      const attempt = projection.attempts.find(
        ({ attemptId }) => attemptId === claim.task.attemptId,
      )
      if (node?.state === 'running' && attempt?.state === 'running') return projection
      try {
        return await this.authority.transact({
          transactionId: `running-${claim.task.taskId}-${claim.lease.token}`,
          workflowId: projection.workflowId,
          expectedSequence: projection.sequence,
          occurredAt: at,
          events: [
            { type: 'node.state_changed', nodeId: claim.task.nodeId, state: 'running' },
            {
              type: 'attempt.state_changed',
              attemptId: claim.task.attemptId,
              state: 'running',
              leaseToken: claim.lease.token,
              workerId: claim.lease.workerId,
              at,
            },
          ],
        })
      } catch (error) {
        if (workflowErrorCode(error) !== 'WORKFLOW_SEQUENCE_CONFLICT') throw error
      }
    }
  }

  heartbeat(claim: WorkflowTaskClaimV1, progress = false, at = new Date().toISOString()) {
    return this.authority.heartbeat(claim.task.taskId, claim.lease.token, progress, at)
  }

  async complete(
    claim: WorkflowTaskClaimV1,
    outcome: Readonly<{
      ok: boolean
      errorCode?: string
      resultRef?: import('@praxis/core-sdk').WorkflowArtifactRefV1
      receiptRef?: import('@praxis/core-sdk').WorkflowArtifactRefV1
      effectReserved?: boolean
      effectReplayed?: boolean
      effectKnownFailure?: boolean
      usage?: Readonly<import('@praxis/core-sdk').BudgetUsage>
    }>,
    at = new Date().toISOString(),
  ): Promise<WorkflowProjectionV1> {
    while (true) {
      try {
        return await this.completeOnce(claim, outcome, at)
      } catch (error) {
        if (workflowErrorCode(error) !== 'WORKFLOW_SEQUENCE_CONFLICT') throw error
      }
    }
  }

  private async completeOnce(
    claim: WorkflowTaskClaimV1,
    outcome: Readonly<{
      ok: boolean
      errorCode?: string
      resultRef?: import('@praxis/core-sdk').WorkflowArtifactRefV1
      receiptRef?: import('@praxis/core-sdk').WorkflowArtifactRefV1
      effectReserved?: boolean
      effectReplayed?: boolean
      effectKnownFailure?: boolean
      usage?: Readonly<import('@praxis/core-sdk').BudgetUsage>
    }>,
    at = new Date().toISOString(),
  ): Promise<WorkflowProjectionV1> {
    const projection = await this.authority.get(claim.task.workflowId)
    if (['cancelled', 'completed', 'failed', 'terminated'].includes(projection.state))
      return projection
    const claimedNode = projection.nodes.find(({ nodeId }) => nodeId === claim.task.nodeId)
    if (
      claimedNode !== undefined &&
      ['succeeded', 'failed', 'cancelled', 'manual_intervention'].includes(claimedNode.state)
    )
      return projection
    const externalEffect = ['external_idempotent', 'external_non_idempotent'].includes(
      claim.task.effect.class,
    )
    const receiptMissing = outcome.ok && externalEffect && outcome.receiptRef === undefined
    // A node result and a Workflow result are separate durable facts. In
    // particular, a recovered root may finish while an already-persisted DAG
    // is still running. Record the root result now and let reconcileWorkflow()
    // apply the Workflow completion policy only after every required node has
    // actually settled.
    const nodeSucceeded = outcome.ok && !receiptMissing
    const errorCode = nodeSucceeded
      ? undefined
      : (outcome.errorCode ?? (receiptMissing ? 'WORKFLOW_EFFECT_RECEIPT_REQUIRED' : undefined))
    const terminal = nodeSucceeded ? 'succeeded' : 'failed'
    const next = await this.authority.transact({
      transactionId: `terminal-${claim.task.taskId}-${claim.lease.token}`,
      workflowId: projection.workflowId,
      expectedSequence: projection.sequence,
      occurredAt: at,
      events: [
        ...(outcome.usage === undefined
          ? []
          : [
              {
                type: 'budget.charged' as const,
                turns: outcome.usage.turns,
                toolCalls: outcome.usage.toolCalls,
                inputTokens: outcome.usage.inputTokens ?? 0,
                outputTokens: outcome.usage.outputTokens ?? 0,
                agentTasks: claim.task.nodeId === 'root' ? 0 : 1,
              },
            ]),
        ...(externalEffect && outcome.receiptRef !== undefined && outcome.effectReplayed !== true
          ? [
              {
                type: 'effect.receipt_recorded' as const,
                receiptId: `receipt-${claim.task.attemptId}`,
                nodeId: claim.task.nodeId,
                attemptId: claim.task.attemptId,
              },
            ]
          : []),
        {
          type: 'attempt.state_changed',
          attemptId: claim.task.attemptId,
          state: terminal,
          at,
          errorCode,
          resultRef: outcome.resultRef,
          receiptRef: outcome.receiptRef,
        },
        {
          type: 'node.state_changed',
          nodeId: claim.task.nodeId,
          state: terminal,
          errorCode,
          resultRef: outcome.resultRef,
        },
        ...(claim.task.nodeId === 'root' && !nodeSucceeded
          ? [
              {
                type: 'workflow.terminal' as const,
                state: 'failed' as const,
                code: errorCode,
              },
            ]
          : []),
      ],
      ...(externalEffect && outcome.receiptRef !== undefined && outcome.effectReplayed !== true
        ? {
            effectReceipts: [
              {
                receiptId: `receipt-${claim.task.attemptId}`,
                workflowId: projection.workflowId,
                nodeId: claim.task.nodeId,
                attemptId: claim.task.attemptId,
                effectClass: claim.task.effect.class as
                  | 'external_idempotent'
                  | 'external_non_idempotent',
                ...(claim.task.effect.idempotencyKey === undefined
                  ? {}
                  : { idempotencyKey: claim.task.effect.idempotencyKey }),
                state: 'committed' as const,
                artifactRef: outcome.receiptRef,
                createdAt: at,
              },
            ],
          }
        : {}),
      acknowledgeTask: {
        taskId: claim.task.taskId,
        leaseToken: claim.lease.token,
        state: nodeSucceeded ? 'completed' : 'failed',
      },
      ...(outcome.effectReserved === true && claim.task.effect.idempotencyKey !== undefined
        ? {
            effectReservationTerminal: {
              idempotencyKey: claim.task.effect.idempotencyKey,
              attemptId: claim.task.attemptId,
              state: nodeSucceeded
                ? ('committed' as const)
                : outcome.effectKnownFailure === true
                  ? ('released' as const)
                  : ('unknown' as const),
              ...(outcome.receiptRef === undefined ? {} : { receiptRef: outcome.receiptRef }),
            },
          }
        : {}),
      ...(claim.task.nodeId === 'root'
        ? {}
        : {
            messages: [
              {
                schemaVersion: 1 as const,
                messageId: `result-${claim.task.attemptId}`,
                workflowId: projection.workflowId,
                sender: {
                  kind: 'node' as const,
                  id: claim.task.nodeId,
                  attemptId: claim.task.attemptId,
                },
                recipient: { kind: 'node' as const, id: 'root' },
                type: nodeSucceeded ? ('result' as const) : ('error' as const),
                payload: {
                  nodeId: claim.task.nodeId,
                  attemptId: claim.task.attemptId,
                  state: terminal,
                  ...(errorCode === undefined ? {} : { errorCode }),
                  ...(outcome.resultRef === undefined ? {} : { resultRef: outcome.resultRef }),
                },
                ...(outcome.resultRef === undefined ? {} : { artifactRefs: [outcome.resultRef] }),
                causationId: claim.task.taskId,
                correlationId: projection.runId,
                createdAt: at,
              },
            ],
          }),
    })
    return nodeSucceeded ? this.reconcileWorkflow(next.workflowId, at) : next
  }

  /**
   * Rebuild the executable frontier from the durable projection alone.
   *
   * This is deliberately safe to call after every node completion and from a
   * freshly started worker process: scheduling, join resolution and terminal
   * settlement are idempotent authority transactions rather than in-memory
   * scheduler state.
   */
  async reconcileWorkflow(
    workflowId: string,
    at = new Date().toISOString(),
  ): Promise<WorkflowProjectionV1> {
    while (true) {
      let current = await this.authority.get(workflowId)
      if (['cancelled', 'completed', 'failed', 'terminated'].includes(current.state)) return current

      const ordinaryNodeIds = current.spec.nodes
        .filter(({ nodeId, join }) => nodeId !== 'root' && join === undefined)
        .map(({ nodeId }) => nodeId)
      let scheduled: WorkflowProjectionV1
      try {
        scheduled = await this.scheduleReadyNodes(workflowId, ordinaryNodeIds, at)
      } catch (error) {
        if (workflowErrorCode(error) === 'WORKFLOW_SEQUENCE_CONFLICT') continue
        throw error
      }
      if (scheduled.sequence !== current.sequence) continue
      current = scheduled

      let joinChanged = false
      for (const spec of current.spec.nodes.filter(({ join }) => join !== undefined)) {
        let resolved: WorkflowProjectionV1
        try {
          resolved = await this.resolveJoinNode(workflowId, spec.nodeId, at)
        } catch (error) {
          if (workflowErrorCode(error) === 'WORKFLOW_SEQUENCE_CONFLICT') {
            joinChanged = true
            break
          }
          throw error
        }
        if (resolved.sequence !== current.sequence) {
          current = resolved
          joinChanged = true
        }
      }
      if (joinChanged) continue

      const settlement = workflowSettlement(current)
      if (settlement === undefined) return current
      try {
        return await this.authority.transact({
          transactionId: `settle-${workflowId}-${current.sequence}`,
          workflowId,
          expectedSequence: current.sequence,
          occurredAt: at,
          events: [
            {
              type: 'workflow.terminal',
              state: settlement.state,
              ...(settlement.code === undefined ? {} : { code: settlement.code }),
            },
          ],
        })
      } catch (error) {
        if (workflowErrorCode(error) === 'WORKFLOW_SEQUENCE_CONFLICT') continue
        throw error
      }
    }
  }

  markEffectCompensated(
    workflowId: string,
    sourceReceiptArtifactId: string,
    compensationReceiptArtifactId: string,
  ) {
    return this.authority.markEffectCompensated(
      workflowId,
      sourceReceiptArtifactId,
      compensationReceiptArtifactId,
    )
  }

  async markUnknown(
    claim: WorkflowTaskClaimV1,
    errorCode: string,
    effectReserved = false,
    at = new Date().toISOString(),
  ): Promise<WorkflowProjectionV1> {
    while (true) {
      const projection = await this.authority.get(claim.task.workflowId)
      const node = projection.nodes.find(({ nodeId }) => nodeId === claim.task.nodeId)
      if (node?.state === 'unknown') return projection
      try {
        return await this.authority.transact({
          transactionId: `unknown-${claim.task.taskId}-${claim.lease.token}`,
          workflowId: projection.workflowId,
          expectedSequence: projection.sequence,
          occurredAt: at,
          events: [
            {
              type: 'attempt.state_changed',
              attemptId: claim.task.attemptId,
              state: 'unknown',
              at,
              errorCode,
            },
            {
              type: 'node.state_changed',
              nodeId: claim.task.nodeId,
              state: 'unknown',
              errorCode,
            },
          ],
          acknowledgeTask: {
            taskId: claim.task.taskId,
            leaseToken: claim.lease.token,
            state: 'unknown',
          },
          ...(!effectReserved || claim.task.effect.idempotencyKey === undefined
            ? {}
            : {
                effectReservationTerminal: {
                  idempotencyKey: claim.task.effect.idempotencyKey,
                  attemptId: claim.task.attemptId,
                  state: 'unknown' as const,
                },
              }),
        })
      } catch (error) {
        if (workflowErrorCode(error) !== 'WORKFLOW_SEQUENCE_CONFLICT') throw error
      }
    }
  }

  async cancelClaim(
    claim: WorkflowTaskClaimV1,
    errorCode: string,
    at = new Date().toISOString(),
  ): Promise<WorkflowProjectionV1> {
    while (true) {
      const projection = await this.authority.get(claim.task.workflowId)
      const node = projection.nodes.find(({ nodeId }) => nodeId === claim.task.nodeId)
      const attempt = projection.attempts.find(
        ({ attemptId }) => attemptId === claim.task.attemptId,
      )
      if (
        node === undefined ||
        attempt === undefined ||
        ['succeeded', 'failed', 'cancelled', 'manual_intervention'].includes(node.state)
      )
        return projection
      try {
        const cancelled = await this.authority.transact({
          transactionId: `cancel-claim-${claim.task.taskId}-${claim.lease.token}`,
          workflowId: projection.workflowId,
          expectedSequence: projection.sequence,
          occurredAt: at,
          events: [
            {
              type: 'attempt.state_changed',
              attemptId: claim.task.attemptId,
              state: 'cancelled',
              at,
              errorCode,
            },
            {
              type: 'node.state_changed',
              nodeId: claim.task.nodeId,
              state: 'cancelled',
              errorCode,
            },
          ],
          acknowledgeTask: {
            taskId: claim.task.taskId,
            leaseToken: claim.lease.token,
            state: 'cancelled',
          },
        })
        return this.reconcileWorkflow(cancelled.workflowId, at)
      } catch (error) {
        if (workflowErrorCode(error) !== 'WORKFLOW_SEQUENCE_CONFLICT') throw error
      }
    }
  }

  reserveEffect(
    claim: WorkflowTaskClaimV1,
    inputDigest: `sha256:${string}`,
    at = new Date().toISOString(),
  ) {
    const key = claim.task.effect.idempotencyKey
    if (key === undefined) throw workflowFailure('WORKFLOW_EFFECT_IDEMPOTENCY_KEY_MISSING')
    return this.authority.reserveEffect(
      claim.task.workflowId,
      key,
      inputDigest,
      claim.task.attemptId,
      claim.lease.expiresAt,
      at,
    )
  }

  async admitDelegate(
    workflowId: string,
    parentNodeId: string,
    proposal: DelegateProposalV1,
    at = new Date().toISOString(),
    kind: Extract<WorkflowNodeKindV1, 'agent_task' | 'synthesis' | 'subworkflow'> = 'agent_task',
  ): Promise<AdmittedDelegateV1> {
    const current = await this.authority.get(workflowId)
    if (current.spec.modePolicy === 'solo') throw workflowFailure('MODE_OVERRIDE_INCOMPATIBLE')
    assertWorkflowAdmissionBudget(current, 1, at)
    const parent = current.spec.nodes.find(({ nodeId }) => nodeId === parentNodeId)
    if (parent === undefined || !parent.grantRequest.mayDelegate)
      throw workflowFailure('WORKFLOW_DELEGATION_DENIED')
    const parentProfile =
      parent.profileRef === undefined
        ? undefined
        : await this.authority.getProfile(parent.profileRef.id, parent.profileRef.version)
    const profile = await this.authority.getProfile(
      proposal.profileRef.id,
      proposal.profileRef.version,
    )
    if (
      parentProfile === undefined ||
      !parentProfile.delegationPolicy.mayDelegate ||
      (!parentProfile.delegationPolicy.allowedProfiles.includes('*') &&
        !parentProfile.delegationPolicy.allowedProfiles.includes(profile.profileId))
    )
      throw workflowFailure('WORKFLOW_PROFILE_DENIED')
    const grant = attenuateGrant(parent.grantRequest, proposal.grantRequest, profile)
    const nodeId = `delegate-${proposal.proposalId}`
    if (current.spec.nodes.some((node) => node.nodeId === nodeId))
      throw workflowFailure('WORKFLOW_PROPOSAL_DUPLICATE')
    const node = delegateNode(nodeId, proposal, profile, grant, kind)
    const spec: WorkflowSpecV1 = {
      ...current.spec,
      revision: current.revision + 1,
      topology: 'delegated_agents',
      nodes: [...current.spec.nodes, node],
    }
    const attemptId = `attempt-${randomUUID()}`
    const cwd = current.spec.workspace
    const task = agentTask({
      workflowId,
      runId: current.runId,
      nodeId,
      attemptId,
      objective: proposal.objective,
      cwd,
      profileId: profile.profileId,
      profileVersion: profile.version,
      node,
      budgetRequest: clampAgentBudget(proposal.budgetRequest, profile.defaultBudget, current),
      assemblyRequest: proposal.assemblyRequest,
      capabilityRequest: proposal.grantRequest,
      at,
    })
    const projection = await this.authority.transact({
      transactionId: `delegate-${proposal.proposalId}`,
      workflowId,
      expectedSequence: current.sequence,
      occurredAt: at,
      events: [
        { type: 'graph.patched', spec },
        { type: 'workflow.topology_changed', topology: 'delegated_agents' },
        { type: 'node.state_changed', nodeId, state: 'admitted' },
        { type: 'node.state_changed', nodeId, state: 'scheduled' },
        { type: 'attempt.created', attempt: { attemptId, nodeId, ordinal: 1, state: 'scheduled' } },
      ],
      enqueueTasks: [task],
      outbox: [
        {
          messageId: `outbox-${task.taskId}`,
          workflowId,
          topic: 'workflow.task.ready',
          key: task.taskId,
          payload: { taskId: task.taskId },
          availableAt: at,
        },
      ],
    })
    return { projection, task, profile, grant }
  }

  async applyGraphProposal(
    workflowId: string,
    proposal: GraphProposalV1 | GraphPatchProposalV1,
  ): Promise<WorkflowProjectionV1> {
    const current = await this.authority.get(workflowId)
    if (current.spec.modePolicy === 'solo') throw workflowFailure('MODE_OVERRIDE_INCOMPATIBLE')
    if (proposal.expectedRevision !== current.revision)
      throw workflowFailure('WORKFLOW_REVISION_CONFLICT')
    const addNodes = 'nodes' in proposal ? proposal.nodes : proposal.addNodes
    const addEdges = 'edges' in proposal ? proposal.edges : proposal.addEdges
    const cancelled = new Set('cancelNodeIds' in proposal ? proposal.cancelNodeIds : [])
    assertWorkflowAdmissionBudget(
      current,
      addNodes.filter((node) => ['agent_task', 'subworkflow', 'synthesis'].includes(node.kind))
        .length,
    )
    const spec: WorkflowSpecV1 = {
      ...current.spec,
      revision: current.revision + 1,
      topology: 'workflow_graph',
      nodes: [...current.spec.nodes.filter(({ nodeId }) => !cancelled.has(nodeId)), ...addNodes],
      edges: [
        ...current.spec.edges.filter(({ from, to }) => !cancelled.has(from) && !cancelled.has(to)),
        ...addEdges,
      ],
    }
    return this.authority.transact({
      transactionId: `graph-${proposal.proposalId}`,
      workflowId,
      expectedSequence: current.sequence,
      occurredAt: new Date().toISOString(),
      events: [
        { type: 'graph.patched', spec },
        { type: 'workflow.topology_changed', topology: 'workflow_graph' },
      ],
    })
  }

  /**
   * Remove terminal failed branches from the current required graph only after
   * a replacement graph has durably succeeded. Event history remains intact;
   * this is the explicit recovery counterpart to append-only workflow.expand.
   */
  async supersedeFailedNodes(
    workflowId: string,
    nodeIds: readonly string[],
    replacementNodeIds: readonly string[],
    transactionKey: string,
    at = new Date().toISOString(),
  ): Promise<WorkflowProjectionV1> {
    const current = await this.authority.get(workflowId)
    const superseded = new Set(nodeIds)
    const replacements = new Set(replacementNodeIds)
    if (
      superseded.size === 0 ||
      superseded.size !== nodeIds.length ||
      replacements.size === 0 ||
      replacements.size !== replacementNodeIds.length ||
      superseded.has('root') ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(transactionKey)
    )
      throw workflowFailure('WORKFLOW_SUPERSESSION_INVALID')

    const specs = new Map(current.spec.nodes.map((node) => [node.nodeId, node]))
    const nodes = new Map(current.nodes.map((node) => [node.nodeId, node]))
    if (
      nodeIds.some((nodeId) => {
        const spec = specs.get(nodeId)
        const node = nodes.get(nodeId)
        return (
          spec === undefined ||
          node === undefined ||
          !['failed', 'cancelled'].includes(node.state) ||
          ['tool_activity', 'compensation'].includes(spec.kind)
        )
      }) ||
      replacementNodeIds.some((nodeId) => nodes.get(nodeId)?.state !== 'succeeded') ||
      current.spec.edges.some(({ from, to }) => superseded.has(from) && !superseded.has(to))
    )
      throw workflowFailure('WORKFLOW_SUPERSESSION_INVALID')

    const spec: WorkflowSpecV1 = {
      ...current.spec,
      revision: current.revision + 1,
      nodes: current.spec.nodes.filter(({ nodeId }) => !superseded.has(nodeId)),
      edges: current.spec.edges.filter(
        ({ from, to }) => !superseded.has(from) && !superseded.has(to),
      ),
    }
    return this.authority.transact({
      transactionId: `supersede-${transactionKey}`,
      workflowId,
      expectedSequence: current.sequence,
      occurredAt: at,
      events: [{ type: 'graph.patched', spec }],
    })
  }

  async admitHumanTask(
    workflowId: string,
    request: Readonly<Record<string, unknown>>,
    expiresAt?: string,
    at = new Date().toISOString(),
  ): Promise<AdmittedWaitNodeV1 & Readonly<{ humanTask: WorkflowHumanTaskV1 }>> {
    const humanTaskId = `human-${randomUUID()}`
    const nodeId = `human-task-${randomUUID()}`
    const humanTask: WorkflowHumanTaskV1 = {
      humanTaskId,
      workflowId,
      nodeId,
      state: 'waiting',
      request,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }
    const admitted = await this.admitWaitNode(
      workflowId,
      nodeId,
      'human_task',
      String(request.question ?? request.prompt ?? 'Human decision required'),
      at,
      { humanTasks: [humanTask] },
    )
    return { ...admitted, humanTask }
  }

  async admitToolActivity(
    workflowId: string,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    effect: import('@praxis/core-sdk').EffectContractV1,
    at = new Date().toISOString(),
  ): Promise<AdmittedToolActivityV1> {
    const current = await this.authority.get(workflowId)
    assertWorkflowAdmissionBudget(current, 0, at)
    const nodeId = `activity-${randomUUID()}`
    const attemptId = `attempt-${randomUUID()}`
    const root = current.spec.nodes.find(({ nodeId: candidate }) => candidate === 'root')
    if (root === undefined) throw workflowFailure('WORKFLOW_ROOT_NOT_FOUND')
    const node: WorkflowNodeSpecV1 = {
      nodeId,
      kind: 'tool_activity',
      title: toolName,
      inputRefs: [],
      grantRequest: { ...root.grantRequest, mayDelegate: false },
      effect,
      retry: {
        maxAttempts: effect.class === 'external_idempotent' ? 3 : 1,
        initialBackoffMs: 1_000,
        maxBackoffMs: 60_000,
        retryableCodes: ['PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'TOOL_EXECUTION_FAILED'],
      },
      timeout: boundedTimeout(
        Math.min(current.spec.budget.maxWallClockMs, LONG_LIVED_EXECUTION_POLICY_V1.maxWallClockMs),
        LONG_LIVED_EXECUTION_POLICY_V1.childNoProgressMs,
        30_000,
      ),
      criteria: [
        {
          criterionId: `receipt-${nodeId}`,
          kind: 'receipt',
          description: 'A durable external effect receipt is required.',
        },
      ],
    }
    const spec: WorkflowSpecV1 = {
      ...current.spec,
      revision: current.revision + 1,
      topology: 'workflow_graph',
      nodes: [...current.spec.nodes, node],
    }
    const baseTask = agentTask({
      workflowId,
      runId: current.runId,
      nodeId,
      attemptId,
      objective: toolName,
      cwd: current.spec.workspace,
      profileId: 'coordinator',
      profileVersion: 2,
      node,
      at,
    })
    const task: WorkflowTaskV1 = Object.freeze({
      ...baseTask,
      kind: 'tool',
      payload: { toolName, inputDigest: promptDigest(JSON.stringify(input)) },
    })
    const projection = await this.authority.transact({
      transactionId: `activity-${attemptId}`,
      workflowId,
      expectedSequence: current.sequence,
      occurredAt: at,
      events: [
        { type: 'graph.patched', spec },
        { type: 'workflow.topology_changed', topology: 'workflow_graph' },
        { type: 'node.state_changed', nodeId, state: 'admitted' },
        { type: 'node.state_changed', nodeId, state: 'scheduled' },
        { type: 'attempt.created', attempt: { attemptId, nodeId, ordinal: 1, state: 'scheduled' } },
      ],
      enqueueTasks: [task],
      outbox: [
        {
          messageId: `outbox-${task.taskId}`,
          workflowId,
          topic: 'workflow.task.ready',
          key: task.taskId,
          payload: { taskId: task.taskId },
          availableAt: at,
        },
      ],
    })
    return { projection, task }
  }

  async admitTimer(
    workflowId: string,
    fireAt: string,
    payload: Readonly<Record<string, unknown>>,
    at = new Date().toISOString(),
  ): Promise<AdmittedWaitNodeV1 & Readonly<{ timer: WorkflowTimerV1 }>> {
    const nodeId = `timer-${randomUUID()}`
    const timer: WorkflowTimerV1 = {
      timerId: `timer-${randomUUID()}`,
      workflowId,
      nodeId,
      fireAt,
      payload,
    }
    const admitted = await this.admitWaitNode(
      workflowId,
      nodeId,
      'timer',
      String(payload.purpose ?? 'Wait until timer'),
      at,
      { timers: [timer] },
    )
    return { ...admitted, timer }
  }

  get(workflowId: string): Promise<WorkflowProjectionV1> {
    return this.authority.get(workflowId)
  }

  listHumanTasks(workflowId: string, waitingOnly = false) {
    return this.authority.listHumanTasks(workflowId, waitingOnly ? ['waiting'] : undefined)
  }

  resolveHumanTask(
    humanTaskId: string,
    state: Exclude<WorkflowHumanTaskV1['state'], 'waiting'>,
    resolution: Readonly<Record<string, unknown>> = {},
  ) {
    return this.authority.resolveHumanTask(humanTaskId, state, resolution)
  }

  fireDueTimers(at = new Date().toISOString()) {
    return this.authority.fireDueTimers(at)
  }

  private async admitWaitNode(
    workflowId: string,
    nodeId: string,
    kind: Extract<WorkflowNodeKindV1, 'human_task' | 'timer'>,
    title: string,
    at: string,
    resources: Readonly<{
      humanTasks?: readonly WorkflowHumanTaskV1[]
      timers?: readonly WorkflowTimerV1[]
    }>,
  ): Promise<AdmittedWaitNodeV1> {
    const current = await this.authority.get(workflowId)
    if (current.spec.modePolicy === 'solo') throw workflowFailure('MODE_OVERRIDE_INCOMPATIBLE')
    if (current.spec.nodes.length >= current.spec.budget.maxAgentTasks)
      throw workflowFailure('WORKFLOW_AGENT_BUDGET_EXHAUSTED')
    const attemptId = `attempt-${randomUUID()}`
    const node: WorkflowNodeSpecV1 = {
      nodeId,
      kind,
      title,
      inputRefs: [],
      grantRequest: {
        tools: [],
        skills: [],
        mcpServers: [],
        workspace: 'none',
        network: false,
        mayDelegate: false,
      },
      effect: { class: 'pure', requiresApproval: false },
      retry: {
        maxAttempts: 1,
        initialBackoffMs: 1_000,
        maxBackoffMs: 1_000,
        retryableCodes: [],
      },
      timeout: boundedTimeout(
        current.spec.budget.maxWallClockMs,
        current.spec.budget.maxWallClockMs,
        30_000,
      ),
      criteria: [],
    }
    const spec: WorkflowSpecV1 = {
      ...current.spec,
      revision: current.revision + 1,
      topology: 'workflow_graph',
      nodes: [...current.spec.nodes, node],
    }
    const projection = await this.authority.transact({
      transactionId: `wait-node-${nodeId}`,
      workflowId,
      expectedSequence: current.sequence,
      occurredAt: at,
      events: [
        { type: 'graph.patched', spec },
        { type: 'workflow.topology_changed', topology: 'workflow_graph' },
        { type: 'node.state_changed', nodeId, state: 'admitted' },
        {
          type: 'attempt.created',
          attempt: { attemptId, nodeId, ordinal: 1, state: 'waiting' },
        },
        { type: 'node.state_changed', nodeId, state: 'waiting' },
        ...(current.state === 'running' ? [{ type: 'workflow.waiting' as const }] : []),
      ],
      ...resources,
    })
    return { projection, nodeId, attemptId }
  }

  async admitAgentGraph(
    workflowId: string,
    parentNodeId: string,
    proposalId: string,
    proposals: readonly AgentGraphNodeProposalV1[],
    join?: Exclude<WorkflowJoinPolicyV1, Readonly<{ kind: 'all' }>>,
    at = new Date().toISOString(),
    coordinationMode: 'foreground' | 'background' = 'foreground',
  ): Promise<AdmittedAgentGraphV1> {
    const current = await this.authority.get(workflowId)
    if (current.spec.modePolicy === 'solo') throw workflowFailure('MODE_OVERRIDE_INCOMPATIBLE')
    if (
      proposals.length < 1 ||
      current.spec.nodes.length + proposals.length > current.spec.budget.maxAgentTasks
    )
      throw workflowFailure('WORKFLOW_AGENT_BUDGET_EXHAUSTED')
    const keys = new Set(proposals.map(({ key }) => key))
    if (
      keys.size !== proposals.length ||
      proposals.some(
        ({ dependencies, dependsOnNodeIds = [] }) =>
          dependencies.some((dependency) => !keys.has(dependency)) ||
          dependsOnNodeIds.some(
            (nodeId) => !current.spec.nodes.some((candidate) => candidate.nodeId === nodeId),
          ),
      )
    )
      throw workflowFailure('WORKFLOW_GRAPH_REFERENCE_INVALID')
    if (
      proposals.some(({ dependencies, conditions = [] }) => {
        const conditionKeys = new Set(conditions.map(({ dependency }) => dependency))
        return (
          conditionKeys.size !== conditions.length ||
          conditions.some(({ dependency }) => !dependencies.includes(dependency))
        )
      })
    )
      throw workflowFailure('WORKFLOW_GRAPH_CONDITION_INVALID')
    const parent = current.spec.nodes.find(({ nodeId }) => nodeId === parentNodeId)
    if (parent === undefined || !parent.grantRequest.mayDelegate)
      throw workflowFailure('WORKFLOW_DELEGATION_DENIED')
    const parentProfile =
      parent.profileRef === undefined
        ? undefined
        : await this.authority.getProfile(parent.profileRef.id, parent.profileRef.version)
    if (parentProfile === undefined || !parentProfile.delegationPolicy.mayDelegate)
      throw workflowFailure('WORKFLOW_PROFILE_DENIED')

    const admitted = [] as Array<AdmittedAgentGraphV1['nodes'][number]>
    for (const proposal of proposals) {
      const profile = await this.authority.getProfile(
        proposal.profileId,
        ACTIVE_BUILTIN_AGENT_PROFILE_VERSION,
      )
      if (
        !parentProfile.delegationPolicy.allowedProfiles.includes('*') &&
        !parentProfile.delegationPolicy.allowedProfiles.includes(profile.profileId)
      )
        throw workflowFailure('WORKFLOW_PROFILE_DENIED')
      const grant = attenuateGrant(parent.grantRequest, proposal.grantRequest, profile)
      const delegateProposal: DelegateProposalV1 = {
        schemaVersion: 1,
        proposalId: `${proposalId}-${proposal.key}`,
        profileRef: { id: profile.profileId, version: profile.version },
        objective: proposal.objective,
        inputRefs: proposal.inputRefs ?? [],
        grantRequest: proposal.grantRequest,
        budgetRequest: proposal.budgetRequest ?? {
          maxWallClockMs: LONG_LIVED_EXECUTION_POLICY_V1.maxWallClockMs,
          maxToolCalls: LONG_LIVED_EXECUTION_POLICY_V1.maxToolCalls,
          maxTurns: LONG_LIVED_EXECUTION_POLICY_V1.maxTurns,
        },
        assemblyRequest: proposal.assemblyRequest,
        reasons: ['MULTI_DOMAIN'],
      }
      const nodeId = `graph-${proposalId.slice(0, 16)}-${proposal.key}`
      if (current.spec.nodes.some((node) => node.nodeId === nodeId))
        throw workflowFailure('WORKFLOW_PROPOSAL_DUPLICATE')
      const node: WorkflowNodeSpecV1 = {
        ...delegateNode(nodeId, delegateProposal, profile, grant),
        ...(proposal.maxIterations === undefined ? {} : { maxIterations: proposal.maxIterations }),
      }
      const attemptId = `attempt-${randomUUID()}`
      const task = agentTask({
        workflowId,
        runId: current.runId,
        nodeId,
        attemptId,
        objective: proposal.objective,
        cwd: current.spec.workspace,
        profileId: profile.profileId,
        profileVersion: profile.version,
        node,
        budgetRequest: clampAgentBudget(
          delegateProposal.budgetRequest,
          profile.defaultBudget,
          current,
        ),
        assemblyRequest: proposal.assemblyRequest,
        capabilityRequest: proposal.grantRequest,
        at,
      })
      admitted.push({
        key: proposal.key,
        nodeId,
        profile,
        grant,
        task:
          coordinationMode === 'foreground'
            ? task
            : Object.freeze({
                ...task,
                payload: { ...task.payload, coordinationMode: 'background' },
              }),
      })
    }
    const byKey = new Map(admitted.map((entry) => [entry.key, entry]))
    const nodes = admitted.map((entry) => {
      const proposal = proposals.find(({ key }) => key === entry.key)!
      const node = delegateNode(
        entry.nodeId,
        {
          schemaVersion: 1,
          proposalId: `${proposalId}-${proposal.key}`,
          profileRef: { id: entry.profile.profileId, version: entry.profile.version },
          objective: proposal.objective,
          inputRefs: proposal.inputRefs ?? [],
          grantRequest: proposal.grantRequest,
          budgetRequest: proposal.budgetRequest ?? {
            maxWallClockMs: LONG_LIVED_EXECUTION_POLICY_V1.maxWallClockMs,
            maxToolCalls: LONG_LIVED_EXECUTION_POLICY_V1.maxToolCalls,
            maxTurns: LONG_LIVED_EXECUTION_POLICY_V1.maxTurns,
          },
          assemblyRequest: proposal.assemblyRequest,
          reasons: ['MULTI_DOMAIN'],
        },
        entry.profile,
        entry.grant,
      )
      return {
        ...node,
        ...(proposal.maxIterations === undefined ? {} : { maxIterations: proposal.maxIterations }),
      }
    })
    const edges = proposals.flatMap((proposal) => [
      ...proposal.dependencies.map((dependency) => {
        const condition = proposal.conditions?.find(
          (candidate) => candidate.dependency === dependency,
        )
        return {
          from: byKey.get(dependency)!.nodeId,
          to: byKey.get(proposal.key)!.nodeId,
          ...(condition === undefined
            ? {}
            : {
                condition: {
                  operator: condition.operator,
                  ...(condition.pointer === undefined ? {} : { pointer: condition.pointer }),
                  value: condition.value,
                },
              }),
        }
      }),
      ...(proposal.dependsOnNodeIds ?? []).map((from) => ({
        from,
        to: byKey.get(proposal.key)!.nodeId,
      })),
    ])
    const joinNodeId = join === undefined ? undefined : `join-${proposalId.slice(0, 24)}`
    const joinNode: WorkflowNodeSpecV1 | undefined =
      join === undefined || joinNodeId === undefined
        ? undefined
        : {
            nodeId: joinNodeId,
            kind: 'decision',
            title: join.kind === 'any' ? 'Any successful branch' : `Quorum ${join.minimum}`,
            inputRefs: [],
            grantRequest: {
              tools: [],
              skills: [],
              mcpServers: [],
              workspace: 'none',
              network: false,
              mayDelegate: false,
            },
            effect: { class: 'pure', requiresApproval: false },
            retry: {
              maxAttempts: 1,
              initialBackoffMs: 1_000,
              maxBackoffMs: 1_000,
              retryableCodes: [],
            },
            timeout: {
              totalMs: LONG_LIVED_EXECUTION_POLICY_V1.maxWallClockMs,
              noProgressMs:
                LONG_LIVED_EXECUTION_POLICY_V1.childNoProgressMs ??
                LONG_LIVED_EXECUTION_POLICY_V1.maxWallClockMs,
              heartbeatMs: 30_000,
            },
            criteria: [],
            join,
          }
    const spec: WorkflowSpecV1 = {
      ...current.spec,
      revision: current.revision + 1,
      topology: 'workflow_graph',
      nodes: [...current.spec.nodes, ...nodes, ...(joinNode === undefined ? [] : [joinNode])],
      edges: [
        ...current.spec.edges,
        ...edges,
        ...(joinNodeId === undefined
          ? []
          : admitted.map(({ nodeId }) => ({ from: nodeId, to: joinNodeId }))),
      ],
    }
    const roots = new Set(
      proposals
        .filter(
          ({ dependencies, dependsOnNodeIds = [] }) =>
            dependencies.length === 0 && dependsOnNodeIds.length === 0,
        )
        .map(({ key }) => key),
    )
    const projection = await this.authority.transact({
      transactionId: `agent-graph-${proposalId}`,
      workflowId,
      expectedSequence: current.sequence,
      occurredAt: at,
      events: [
        { type: 'graph.patched', spec },
        { type: 'workflow.topology_changed', topology: 'workflow_graph' },
        ...(joinNodeId === undefined
          ? []
          : [
              {
                type: 'node.state_changed' as const,
                nodeId: joinNodeId,
                state: 'admitted' as const,
              },
            ]),
        ...admitted.flatMap((entry) => [
          { type: 'node.state_changed' as const, nodeId: entry.nodeId, state: 'admitted' as const },
          ...(roots.has(entry.key)
            ? [
                {
                  type: 'node.state_changed' as const,
                  nodeId: entry.nodeId,
                  state: 'scheduled' as const,
                },
              ]
            : []),
          {
            type: 'attempt.created' as const,
            attempt: {
              attemptId: entry.task.attemptId,
              nodeId: entry.nodeId,
              ordinal: 1,
              state: 'scheduled' as const,
            },
          },
        ]),
      ],
      enqueueTasks: admitted.map(({ task }) => task),
      outbox: admitted.map(({ task }) => ({
        messageId: `outbox-${task.taskId}`,
        workflowId,
        topic: 'workflow.task.ready',
        key: task.taskId,
        payload: { taskId: task.taskId },
        availableAt: at,
      })),
    })
    return { projection, nodes: admitted, ...(joinNodeId === undefined ? {} : { joinNodeId }) }
  }

  async resolveJoinNode(
    workflowId: string,
    nodeId: string,
    at = new Date().toISOString(),
  ): Promise<WorkflowProjectionV1> {
    const current = await this.authority.get(workflowId)
    const node = current.nodes.find((candidate) => candidate.nodeId === nodeId)
    const spec = current.spec.nodes.find((candidate) => candidate.nodeId === nodeId)
    if (node === undefined || spec?.join === undefined)
      throw workflowFailure('WORKFLOW_JOIN_INVALID')
    if (['succeeded', 'failed', 'skipped'].includes(node.state)) return current
    const readiness = workflowNodeReadinessV1(current, nodeId)
    if (readiness === 'waiting') return current
    const terminal =
      readiness === 'ready' ? 'succeeded' : readiness === 'skipped' ? 'skipped' : 'failed'
    return this.authority.transact({
      transactionId: `resolve-join-${nodeId}-${current.sequence}`,
      workflowId,
      expectedSequence: current.sequence,
      occurredAt: at,
      events: [
        ...(terminal === 'succeeded'
          ? [
              { type: 'node.state_changed' as const, nodeId, state: 'scheduled' as const },
              { type: 'node.state_changed' as const, nodeId, state: 'succeeded' as const },
            ]
          : [
              {
                type: 'node.state_changed' as const,
                nodeId,
                state: terminal as 'failed' | 'skipped',
                errorCode:
                  terminal === 'failed' ? 'WORKFLOW_QUORUM_UNREACHABLE' : 'WORKFLOW_JOIN_EMPTY',
              },
            ]),
      ],
    })
  }

  async scheduleReadyNodes(
    workflowId: string,
    nodeIds: readonly string[],
    at = new Date().toISOString(),
  ): Promise<WorkflowProjectionV1> {
    const current = await this.authority.get(workflowId)
    if (['cancelled', 'completed', 'failed', 'terminated'].includes(current.state)) return current
    const target = new Set(nodeIds)
    const ready = current.nodes.filter(
      (node) =>
        target.has(node.nodeId) &&
        node.state === 'admitted' &&
        workflowNodeReadinessV1(current, node.nodeId) === 'ready',
    )
    const skipped = current.nodes.filter(
      (node) =>
        target.has(node.nodeId) &&
        node.state === 'admitted' &&
        workflowNodeReadinessV1(current, node.nodeId) === 'skipped',
    )
    const blocked = current.nodes.filter(
      (node) =>
        target.has(node.nodeId) &&
        node.state === 'admitted' &&
        workflowNodeReadinessV1(current, node.nodeId) === 'blocked',
    )
    if (ready.length === 0 && skipped.length === 0 && blocked.length === 0) return current
    const prunedNodeIds = new Set([...skipped, ...blocked].map(({ nodeId }) => nodeId))
    const prunedTaskIds =
      prunedNodeIds.size === 0
        ? []
        : (
            await this.authority.listTasks({
              workflowId,
              states: ['ready'],
              limit: Number.MAX_SAFE_INTEGER,
            })
          )
            .filter(({ nodeId }) => prunedNodeIds.has(nodeId))
            .map(({ taskId }) => taskId)
    return this.authority.transact({
      transactionId: `schedule-ready-${workflowId}-${current.sequence}`,
      workflowId,
      expectedSequence: current.sequence,
      occurredAt: at,
      events: [
        ...ready.map((node) => ({
          type: 'node.state_changed' as const,
          nodeId: node.nodeId,
          state: 'scheduled' as const,
        })),
        ...skipped.flatMap((node) => {
          const attemptId = node.attemptIds.at(-1)
          return [
            ...(attemptId === undefined
              ? []
              : [
                  {
                    type: 'attempt.state_changed' as const,
                    attemptId,
                    state: 'cancelled' as const,
                    at,
                    errorCode: 'WORKFLOW_BRANCH_NOT_SELECTED',
                  },
                ]),
            {
              type: 'node.state_changed' as const,
              nodeId: node.nodeId,
              state: 'skipped' as const,
              errorCode: 'WORKFLOW_BRANCH_NOT_SELECTED',
            },
          ]
        }),
        ...blocked.flatMap((node) => {
          const attemptId = node.attemptIds.at(-1)
          return [
            ...(attemptId === undefined
              ? []
              : [
                  {
                    type: 'attempt.state_changed' as const,
                    attemptId,
                    state: 'cancelled' as const,
                    at,
                    errorCode: 'WORKFLOW_DEPENDENCY_UNSATISFIED',
                  },
                ]),
            {
              type: 'node.state_changed' as const,
              nodeId: node.nodeId,
              state: 'failed' as const,
              errorCode: 'WORKFLOW_DEPENDENCY_UNSATISFIED',
            },
          ]
        }),
      ],
      ...(prunedTaskIds.length === 0 ? {} : { cancelReadyTasks: prunedTaskIds }),
    })
  }

  async cancelNodes(
    workflowId: string,
    nodeIds: readonly string[],
    code: string,
    at = new Date().toISOString(),
  ): Promise<WorkflowProjectionV1> {
    const current = await this.authority.get(workflowId)
    const target = new Set(nodeIds)
    const cancellable = new Set(['proposed', 'admitted', 'scheduled', 'retry_wait'])
    const nodes = current.nodes.filter(
      (node) => target.has(node.nodeId) && cancellable.has(node.state),
    )
    if (nodes.length === 0) return current
    return this.authority.transact({
      transactionId: `cancel-nodes-${workflowId}-${current.sequence}`,
      workflowId,
      expectedSequence: current.sequence,
      occurredAt: at,
      events: nodes.map((node) => ({
        type: 'node.state_changed' as const,
        nodeId: node.nodeId,
        state: 'cancelled' as const,
        errorCode: code,
      })),
    })
  }

  async pause(workflowId: string, at = new Date().toISOString()): Promise<WorkflowProjectionV1> {
    const current = await this.authority.get(workflowId)
    if (!['running', 'waiting'].includes(current.state))
      throw workflowFailure('WORKFLOW_PAUSE_INVALID_STATE')
    return this.authority.transact({
      transactionId: `pause-${workflowId}-${current.sequence}`,
      workflowId,
      expectedSequence: current.sequence,
      occurredAt: at,
      events: [{ type: 'workflow.paused' }],
    })
  }

  async resume(workflowId: string, at = new Date().toISOString()): Promise<WorkflowProjectionV1> {
    const current = await this.authority.get(workflowId)
    if (!['paused', 'waiting'].includes(current.state))
      throw workflowFailure('WORKFLOW_RESUME_INVALID_STATE')
    return this.authority.transact({
      transactionId: `resume-${workflowId}-${current.sequence}`,
      workflowId,
      expectedSequence: current.sequence,
      occurredAt: at,
      events: [{ type: 'workflow.resumed' }],
    })
  }

  async cancel(
    workflowId: string,
    code = 'WORKFLOW_CANCELLED_BY_USER',
    at = new Date().toISOString(),
  ): Promise<WorkflowProjectionV1> {
    const current = await this.authority.get(workflowId)
    if (['cancelled', 'completed', 'failed', 'terminated'].includes(current.state)) return current
    const cancellable = new Set([
      'proposed',
      'admitted',
      'scheduled',
      'leased',
      'running',
      'waiting',
      'retry_wait',
    ])
    return this.authority.transact({
      transactionId: `cancel-${workflowId}-${current.sequence}`,
      workflowId,
      expectedSequence: current.sequence,
      occurredAt: at,
      events: [
        { type: 'workflow.cancelling', code },
        ...current.nodes
          .filter((node) => cancellable.has(node.state))
          .map(
            (node) =>
              ({
                type: 'node.state_changed',
                nodeId: node.nodeId,
                state: 'cancelled',
                errorCode: code,
              }) as const,
          ),
        { type: 'workflow.terminal', state: 'cancelled', code },
      ],
    })
  }

  async terminate(
    workflowId: string,
    code = 'WORKFLOW_TERMINATED_BY_USER',
    at = new Date().toISOString(),
  ): Promise<WorkflowProjectionV1> {
    const current = await this.authority.get(workflowId)
    if (['cancelled', 'completed', 'failed', 'terminated'].includes(current.state)) return current
    return this.authority.transact({
      transactionId: `terminate-${workflowId}-${current.sequence}`,
      workflowId,
      expectedSequence: current.sequence,
      occurredAt: at,
      events: [{ type: 'workflow.terminal', state: 'terminated', code }],
    })
  }
}

export async function registerBuiltinAgentProfilesV1(
  authority: WorkflowAuthorityPortV1,
): Promise<void> {
  for (const [profileId, description, mayDelegate] of [
    ['coordinator', 'Owns the user outcome and may delegate bounded work.', true],
    ['researcher', 'Collects evidence without modifying the workspace.', false],
    ['coder', 'Implements bounded workspace changes and checks them.', false],
    ['reviewer', 'Reviews evidence and changes independently.', false],
    ['verifier', 'Runs deterministic and semantic acceptance checks.', false],
    ['default', 'General-purpose isolated Child Agent harness.', false],
    [
      'worker',
      'Execution-oriented Child Agent harness for bounded implementation and repair.',
      false,
    ],
    [
      'explorer',
      'Read-oriented Child Agent harness for evidence collection and investigation.',
      false,
    ],
  ] as const) {
    await authority
      .registerProfile(builtinAgentProfile(profileId, description, mayDelegate, 1))
      .catch((error: unknown) => {
        // v1 predates immutable digests. Never replace an existing row;
        // historical drift fails closed; new product tasks pin the active profile.
        if (
          !(error instanceof Error) ||
          Reflect.get(error, 'code') !== 'AGENT_PROFILE_VERSION_CONFLICT'
        )
          throw error
      })
    await authority.registerProfile(builtinAgentProfile(profileId, description, mayDelegate, 2))
    // v3 remains registered verbatim so persisted workflows can recover after
    // v4 changes the default budget semantics to unlimited.
    await authority.registerProfile(builtinAgentProfile(profileId, description, mayDelegate, 3))
    await authority.registerProfile(
      builtinAgentProfile(
        profileId,
        description,
        mayDelegate,
        ACTIVE_BUILTIN_AGENT_PROFILE_VERSION,
      ),
    )
  }
}

function builtinAgentProfile(
  profileId:
    | 'coordinator'
    | 'researcher'
    | 'coder'
    | 'reviewer'
    | 'verifier'
    | 'default'
    | 'worker'
    | 'explorer',
  description: string,
  mayDelegate: boolean,
  version: 1 | 2 | 3 | 4 = ACTIVE_BUILTIN_AGENT_PROFILE_VERSION,
): AgentProfileV1 {
  const defaultBudget =
    version >= 4
      ? {}
      : {
          maxWallClockMs:
            version === 3 ? BUILTIN_AGENT_PROFILE_V3_LIMITS.maxWallClockMs : 3_600_000,
          ...(version === 3 ? {} : { maxTokens: 1_000_000 }),
          maxToolCalls: version === 3 ? BUILTIN_AGENT_PROFILE_V3_LIMITS.maxToolCalls : 10_000,
          maxTurns: version === 3 ? BUILTIN_AGENT_PROFILE_V3_LIMITS.maxTurns : 512,
        }
  const semantic = {
    schemaVersion: 1,
    profileId,
    version,
    description,
    instructionsRef: {
      id: `builtin:${profileId}`,
      version,
      digest: promptDigest(`builtin profile instructions:${profileId}:v${version}`),
    },
    modelPolicy: { allowedProviders: ['*'] },
    toolAllowlist: ['*'],
    skillAllowlist: ['*'],
    mcpAllowlist: ['*'],
    // v4 has no implicit Child wall-clock, turn, Tool-call, or token budget.
    // v1-v3 are immutable because their digests can be pinned by durable runs.
    defaultBudget,
    delegationPolicy: {
      mayDelegate,
      maxDepth: mayDelegate
        ? version >= 4
          ? LONG_LIVED_EXECUTION_POLICY_V1.maxDepth
          : version === 3
            ? BUILTIN_AGENT_PROFILE_V3_LIMITS.maxDepth
            : 8
        : 0,
      allowedProfiles: ['*'],
    },
  } as const
  return Object.freeze({ ...semantic, digest: promptDigest(JSON.stringify(semantic)) })
}

function rootNode(nodeId: string, grant: CapabilityRequestV1): WorkflowNodeSpecV1 {
  const coordinator = builtinAgentProfile(
    'coordinator',
    'Owns the user outcome and may delegate bounded work.',
    true,
  )
  return {
    nodeId,
    kind: 'agent_task',
    title: 'Root AgentTask',
    profileRef: {
      id: 'coordinator',
      version: ACTIVE_BUILTIN_AGENT_PROFILE_VERSION,
      digest: coordinator.digest,
    },
    inputRefs: [],
    grantRequest: grant,
    // The AgentTask is replayable because every mutable Tool invocation is
    // separately journaled as a durable Activity by WorkflowEffectBrokerV1.
    effect: { class: 'pure', requiresApproval: false },
    retry: {
      maxAttempts: 3,
      initialBackoffMs: 1_000,
      maxBackoffMs: 60_000,
      retryableCodes: ['PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE'],
    },
    timeout: {
      totalMs: LONG_LIVED_EXECUTION_POLICY_V1.maxWallClockMs,
      noProgressMs:
        LONG_LIVED_EXECUTION_POLICY_V1.childNoProgressMs ??
        LONG_LIVED_EXECUTION_POLICY_V1.maxWallClockMs,
      heartbeatMs: 30_000,
    },
    criteria: [],
  }
}

function delegateNode(
  nodeId: string,
  proposal: DelegateProposalV1,
  profile: AgentProfileV1,
  grant: CapabilityRequestV1,
  kind: Extract<WorkflowNodeKindV1, 'agent_task' | 'synthesis' | 'subworkflow'> = 'agent_task',
): WorkflowNodeSpecV1 {
  return {
    nodeId,
    kind,
    title: proposal.objective,
    profileRef: { id: profile.profileId, version: profile.version, digest: profile.digest },
    inputRefs: proposal.inputRefs,
    outputSchemaRef: proposal.resultSchemaRef,
    grantRequest: grant,
    effect: {
      class: grant.workspace === 'write' ? 'workspace_write' : 'read',
      requiresApproval: false,
    },
    retry: {
      maxAttempts: 3,
      initialBackoffMs: 1_000,
      maxBackoffMs: 60_000,
      retryableCodes: ['PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE'],
    },
    timeout: boundedTimeout(
      proposal.budgetRequest.maxWallClockMs ?? LONG_LIVED_EXECUTION_POLICY_V1.maxWallClockMs,
      LONG_LIVED_EXECUTION_POLICY_V1.childNoProgressMs,
      30_000,
    ),
    criteria: [],
  }
}

function boundedTimeout(
  requestedTotalMs: number,
  requestedNoProgressMs: number | undefined,
  requestedHeartbeatMs: number,
): WorkflowNodeSpecV1['timeout'] {
  const totalMs = Math.max(3, Math.floor(requestedTotalMs))
  const heartbeatMs = Math.max(
    1,
    Math.min(Math.floor(totalMs / 3), Math.floor(requestedHeartbeatMs)),
  )
  const noProgressMs = Math.max(
    heartbeatMs + 1,
    Math.min(totalMs, Math.floor(requestedNoProgressMs ?? totalMs)),
  )
  return { totalMs, noProgressMs, heartbeatMs }
}

function reachesSatisfiedJoin(projection: WorkflowProjectionV1, nodeId: string): boolean {
  const nodes = new Map(projection.nodes.map((node) => [node.nodeId, node]))
  const specs = new Map(projection.spec.nodes.map((node) => [node.nodeId, node]))
  const outgoing = new Map<string, string[]>()
  for (const edge of projection.spec.edges) {
    const targets = outgoing.get(edge.from) ?? []
    targets.push(edge.to)
    outgoing.set(edge.from, targets)
  }
  const pending = [...(outgoing.get(nodeId) ?? [])]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const candidate = pending.shift()!
    if (visited.has(candidate)) continue
    visited.add(candidate)
    if (specs.get(candidate)?.join !== undefined && nodes.get(candidate)?.state === 'succeeded')
      return true
    pending.push(...(outgoing.get(candidate) ?? []))
  }
  return false
}

function workflowSettlement(
  projection: WorkflowProjectionV1,
): Readonly<{ state: 'completed' | 'failed'; code?: string }> | undefined {
  const root = projection.nodes.find(({ nodeId }) => nodeId === 'root')
  if (root === undefined) return { state: 'failed', code: 'WORKFLOW_ROOT_MISSING' }
  if (['failed', 'cancelled', 'unknown', 'manual_intervention'].includes(root.state)) {
    return { state: 'failed', code: root.errorCode ?? 'WORKFLOW_ROOT_FAILED' }
  }
  if (root.state !== 'succeeded' || projection.spec.completion !== 'all_required') return undefined

  const descendants = projection.nodes.filter(({ nodeId }) => nodeId !== 'root')
  const terminal = new Set([
    'unknown',
    'skipped',
    'succeeded',
    'failed',
    'cancelled',
    'manual_intervention',
  ])
  if (descendants.some(({ state }) => !terminal.has(state))) return undefined

  const specs = new Map(projection.spec.nodes.map((node) => [node.nodeId, node]))
  const failed = descendants.find((node) => {
    if (node.state === 'succeeded' || node.state === 'skipped') return false
    if (specs.get(node.nodeId)?.kind === 'tool_activity') {
      return ['unknown', 'manual_intervention'].includes(node.state)
    }
    // A successful any/quorum decision is the durable authority that its
    // minority failures and cancelled stragglers are non-required.
    return (
      ['unknown', 'manual_intervention'].includes(node.state) ||
      !reachesSatisfiedJoin(projection, node.nodeId)
    )
  })
  return failed === undefined
    ? { state: 'completed' }
    : { state: 'failed', code: failed.errorCode ?? 'WORKFLOW_DESCENDANT_FAILED' }
}

function workflowErrorCode(error: unknown): string | undefined {
  return error instanceof Error && typeof Reflect.get(error, 'code') === 'string'
    ? Reflect.get(error, 'code')
    : undefined
}

function agentTask(
  input: Readonly<{
    workflowId: string
    runId: string
    nodeId: string
    attemptId: string
    objective: string
    cwd: string
    profileId: string
    profileVersion: number
    node: WorkflowNodeSpecV1
    budgetRequest?: import('@praxis/core-sdk').AgentBudgetRequestV1
    assemblyRequest?: AgentAssemblyRequestV1
    capabilityRequest?: CapabilityRequestV1
    harnessProfile?: import('@praxis/core-sdk').AgentHarnessProfileV1
    at: string
  }>,
): WorkflowTaskV1 {
  return Object.freeze({
    schemaVersion: 1,
    taskId: `task-${randomUUID()}`,
    workflowId: input.workflowId,
    runId: input.runId,
    nodeId: input.nodeId,
    attemptId: input.attemptId,
    kind: input.node.kind === 'subworkflow' ? 'subworkflow' : 'agent',
    profileRef: input.node.profileRef ?? { id: input.profileId, version: input.profileVersion },
    payload: {
      objective: input.objective,
      cwd: input.cwd,
      grant: input.node.grantRequest,
      profileId: input.profileId,
      ...(input.harnessProfile === undefined ? {} : { harnessProfile: input.harnessProfile }),
      inputRefs: input.node.inputRefs,
      ...(input.budgetRequest === undefined ? {} : { budget: input.budgetRequest }),
      ...(input.assemblyRequest === undefined ? {} : { assemblyRequest: input.assemblyRequest }),
      ...(input.capabilityRequest === undefined
        ? {}
        : { capabilityRequest: input.capabilityRequest }),
    },
    state: 'ready',
    priority: input.nodeId === 'root' ? 100 : 50,
    readyAt: input.at,
    deadlineAt: canonicalDeadlineAfter(input.at, input.node.timeout.totalMs),
    conflictKeys:
      input.nodeId !== 'root' && input.node.grantRequest.workspace === 'write'
        ? [`workspace:${input.cwd}`]
        : [],
    effect: input.node.effect,
    retry: input.node.retry,
    timeout: input.node.timeout,
    createdAt: input.at,
    updatedAt: input.at,
  })
}

function attenuateGrant(
  parent: CapabilityRequestV1,
  requested: CapabilityRequestV1,
  profile: AgentProfileV1,
): CapabilityRequestV1 {
  const allowed = (
    values: readonly string[],
    parentValues: readonly string[],
    profileValues: readonly string[],
  ) => {
    const candidates = values.includes('*')
      ? parentValues.includes('*')
        ? profileValues.includes('*')
          ? ['*']
          : profileValues
        : parentValues
      : values
    return [...new Set(candidates)].filter(
      (value) =>
        (value === '*' || parentValues.includes('*') || parentValues.includes(value)) &&
        (value === '*' || profileValues.includes('*') || profileValues.includes(value)),
    )
  }
  const workspaceOrder = ['none', 'read', 'write'] as const
  const workspace =
    workspaceOrder[
      Math.min(
        workspaceOrder.indexOf(parent.workspace),
        workspaceOrder.indexOf(requested.workspace),
      )
    ]!
  return Object.freeze({
    tools: allowed(requested.tools, parent.tools, profile.toolAllowlist),
    skills: allowed(requested.skills, parent.skills, profile.skillAllowlist),
    mcpServers: allowed(requested.mcpServers, parent.mcpServers, profile.mcpAllowlist),
    workspace,
    network: parent.network && requested.network,
    mayDelegate:
      parent.mayDelegate && requested.mayDelegate && profile.delegationPolicy.mayDelegate,
  })
}

function clampAgentBudget(
  requested: import('@praxis/core-sdk').AgentBudgetRequestV1,
  profile: import('@praxis/core-sdk').AgentBudgetRequestV1,
  projection: WorkflowProjectionV1,
): import('@praxis/core-sdk').AgentBudgetRequestV1 {
  const remainingWallClock = Math.max(
    1,
    projection.spec.budget.maxWallClockMs -
      Math.max(0, Date.now() - Date.parse(projection.spec.createdAt)),
  )
  const minimum = (left: number | undefined, right: number | undefined, fallback: number) =>
    Math.max(1, Math.min(left ?? fallback, right ?? fallback, fallback))
  const requestedTokenLimits = [requested.maxTokens, profile.maxTokens].filter(
    (value): value is number => value !== undefined,
  )
  const remainingTokens = Math.max(
    1,
    projection.spec.budget.maxTokens - projection.usage.inputTokens - projection.usage.outputTokens,
  )
  return Object.freeze({
    maxWallClockMs: minimum(requested.maxWallClockMs, profile.maxWallClockMs, remainingWallClock),
    ...(requestedTokenLimits.length === 0
      ? {}
      : { maxTokens: Math.min(remainingTokens, ...requestedTokenLimits) }),
    maxToolCalls: minimum(
      requested.maxToolCalls,
      profile.maxToolCalls,
      Math.max(1, projection.spec.budget.maxToolCalls - projection.usage.toolCalls),
    ),
    maxTurns: minimum(
      requested.maxTurns,
      profile.maxTurns,
      LONG_LIVED_EXECUTION_POLICY_V1.maxTurns,
    ),
  })
}

function assertWorkflowAdmissionBudget(
  projection: WorkflowProjectionV1,
  additionalAgentTasks: number,
  at = new Date().toISOString(),
): void {
  const budget = projection.spec.budget
  const elapsed = Date.parse(at) - Date.parse(projection.spec.createdAt)
  const agentNodes = projection.spec.nodes.filter((node) =>
    ['agent_task', 'subworkflow', 'synthesis'].includes(node.kind),
  ).length
  if (elapsed >= budget.maxWallClockMs) throw workflowFailure('WORKFLOW_DEADLINE_EXCEEDED')
  if (projection.usage.toolCalls >= budget.maxToolCalls)
    throw workflowFailure('WORKFLOW_TOOL_BUDGET_EXHAUSTED')
  if (projection.usage.inputTokens + projection.usage.outputTokens >= budget.maxTokens)
    throw workflowFailure('WORKFLOW_TOKEN_BUDGET_EXHAUSTED')
  if (agentNodes + additionalAgentTasks > budget.maxAgentTasks)
    throw workflowFailure('WORKFLOW_AGENT_BUDGET_EXHAUSTED')
}

function workflowFailure(code: string): Error {
  return Object.assign(new Error(`Workflow orchestration rejected the operation (${code}).`), {
    code,
    category: 'planner',
    retryable: false,
  })
}
