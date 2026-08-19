import { randomUUID } from 'node:crypto'
import type {
  WorkflowArtifactRefV1,
  WorkflowProjectionV1,
  WorkflowTaskClaimV1,
} from '@praxis/core-sdk'
import { LONG_LIVED_EXECUTION_POLICY_V1 } from '../longLivedExecutionPolicy.js'
import {
  executeWorkflowAgentClaimV1,
  type WorkflowAgentWorkerPortV1,
  type WorkflowAgentWorkerResultV1,
} from './agentDelegateTool.js'
import type { AdmittedAgentGraphV1, WorkflowOrchestratorV1 } from './workflowOrchestrator.js'

export type DurableGraphExecutionResultV1 = Readonly<{
  ok: boolean
  results: Readonly<Record<string, WorkflowAgentWorkerResultV1>>
  evidence: Readonly<Record<string, WorkflowArtifactRefV1>>
  errorCode?: string
}>

/**
 * Durable graph control loop. Readiness lives in the Workflow journal and every
 * claim is revalidated by the SQLite authority; this object owns no authority
 * state and can therefore be recreated after a Runtime restart.
 */
export class DurableWorkflowSchedulerV1 {
  constructor(
    private readonly orchestrator: WorkflowOrchestratorV1,
    private readonly worker: WorkflowAgentWorkerPortV1,
    private readonly onProjection?: (projection: WorkflowProjectionV1) => void,
  ) {}

  async executeAgentGraph(
    graph: AdmittedAgentGraphV1,
    signal: AbortSignal,
  ): Promise<DurableGraphExecutionResultV1> {
    const byNodeId = new Map(graph.nodes.map((node) => [node.nodeId, node]))
    const targetIds = graph.nodes.map(({ nodeId }) => nodeId)
    const results = new Map<string, WorkflowAgentWorkerResultV1>()
    this.onProjection?.(graph.projection)

    while (!signal.aborted) {
      let projection = await this.orchestrator.scheduleReadyNodes(
        graph.projection.workflowId,
        targetIds,
      )
      if (graph.joinNodeId !== undefined) {
        projection = await this.orchestrator.resolveJoinNode(
          graph.projection.workflowId,
          graph.joinNodeId,
        )
      }
      this.onProjection?.(projection)
      const targets = projection.nodes.filter(({ nodeId }) => byNodeId.has(nodeId))
      const join =
        graph.joinNodeId === undefined
          ? undefined
          : projection.nodes.find(({ nodeId }) => nodeId === graph.joinNodeId)
      if (join?.state === 'succeeded') {
        projection = await this.orchestrator.cancelNodes(
          projection.workflowId,
          targets.map(({ nodeId }) => nodeId),
          'WORKFLOW_JOIN_SATISFIED',
        )
        this.onProjection?.(projection)
        return {
          ok: true,
          results: resultRecord(results, byNodeId),
          evidence: evidenceRecord(targets, byNodeId),
        }
      }
      if (join?.state === 'failed' || join?.state === 'skipped') {
        projection = await this.orchestrator.cancelNodes(
          projection.workflowId,
          targets.map(({ nodeId }) => nodeId),
          'WORKFLOW_QUORUM_UNREACHABLE',
        )
        this.onProjection?.(projection)
        return {
          ok: false,
          results: resultRecord(results, byNodeId),
          evidence: evidenceRecord(targets, byNodeId),
          errorCode: join.errorCode ?? 'WORKFLOW_QUORUM_UNREACHABLE',
        }
      }
      if (targets.every(({ state }) => state === 'succeeded' || state === 'skipped'))
        return {
          ok: true,
          results: resultRecord(results, byNodeId),
          evidence: evidenceRecord(targets, byNodeId),
        }

      const failed = targets.find(({ state }) =>
        ['failed', 'unknown', 'manual_intervention', 'cancelled'].includes(state),
      )
      if (failed !== undefined && graph.joinNodeId === undefined) {
        projection = await this.orchestrator.cancelNodes(
          projection.workflowId,
          targets.map(({ nodeId }) => nodeId),
          'DAG_PARTIAL_FAILURE_COLLECTED',
        )
        this.onProjection?.(projection)
        return {
          ok: false,
          results: resultRecord(results, byNodeId),
          evidence: evidenceRecord(targets, byNodeId),
          errorCode: failed.errorCode ?? 'WORKFLOW_NODE_FAILED',
        }
      }

      const scheduled = targets.filter(({ state }) => state === 'scheduled')
      const claims: WorkflowTaskClaimV1[] = []
      for (const node of scheduled) {
        const claim = await this.orchestrator
          .claimNode(projection.workflowId, node.nodeId, `workflow-worker-${randomUUID()}`)
          .catch((error: unknown) => {
            if (errorCode(error) === 'WORKFLOW_NODE_TASK_UNAVAILABLE') return undefined
            throw error
          })
        if (claim !== undefined) claims.push(claim)
        if (
          claims.length >=
          Math.min(
            projection.spec.budget.maxParallelTasks,
            LONG_LIVED_EXECUTION_POLICY_V1.localWorkerParallelChildren,
          )
        )
          break
      }
      if (claims.length === 0) {
        return {
          ok: false,
          results: resultRecord(results, byNodeId),
          evidence: evidenceRecord(targets, byNodeId),
          errorCode: 'WORKFLOW_GRAPH_NO_READY_TASK',
        }
      }

      for (const claim of claims) {
        const running = await this.orchestrator.markRunning(claim)
        this.onProjection?.(running)
      }
      const active = new Map(
        claims.map((claim) => {
          const controller = new AbortController()
          const executionSignal = AbortSignal.any([signal, controller.signal])
          const promise = executeWorkflowAgentClaimV1(
            this.orchestrator,
            this.worker,
            claim,
            executionSignal,
          ).then((outcome) => ({ claim, outcome }))
          return [claim.task.taskId, { claim, controller, promise }] as const
        }),
      )
      const stopActive = async (code: string) => {
        const remaining = [...active.values()]
        for (const entry of remaining) entry.controller.abort(code)
        await Promise.allSettled(remaining.map(({ claim }) => this.worker.cancel?.(claim, code)))
        await Promise.allSettled(remaining.map(({ promise }) => promise))
        for (const { claim } of remaining) {
          results.set(claim.task.nodeId, {
            ok: false,
            summary: `Workflow agent cancelled (${code}).`,
            errorCode: code,
          })
          const cancelled = await this.orchestrator.cancelClaim(claim, code)
          this.onProjection?.(cancelled)
        }
        active.clear()
      }
      // Workers execute concurrently. Settle each completion as soon as it
      // arrives, while serializing authority commits to preserve revision CAS.
      while (active.size > 0) {
        const { claim, outcome } = await Promise.race(
          [...active.values()].map(({ promise }) => promise),
        )
        active.delete(claim.task.taskId)
        results.set(claim.task.nodeId, outcome)
        projection = await this.orchestrator.complete(claim, {
          ok: outcome.ok,
          errorCode: outcome.errorCode,
          resultRef: outcome.artifacts?.[0],
          usage: outcome.usage,
        })
        this.onProjection?.(projection)

        if (graph.joinNodeId !== undefined) {
          projection = await this.orchestrator.resolveJoinNode(
            projection.workflowId,
            graph.joinNodeId,
          )
          this.onProjection?.(projection)
          const currentJoin = projection.nodes.find(({ nodeId }) => nodeId === graph.joinNodeId)
          if (currentJoin?.state === 'succeeded') {
            await stopActive('WORKFLOW_JOIN_SATISFIED')
            projection = await this.orchestrator.cancelNodes(
              projection.workflowId,
              targetIds,
              'WORKFLOW_JOIN_SATISFIED',
            )
            this.onProjection?.(projection)
            const currentTargets = projection.nodes.filter(({ nodeId }) => byNodeId.has(nodeId))
            return {
              ok: true,
              results: resultRecord(results, byNodeId),
              evidence: evidenceRecord(currentTargets, byNodeId),
            }
          }
          if (currentJoin?.state === 'failed' || currentJoin?.state === 'skipped') {
            await stopActive('WORKFLOW_QUORUM_UNREACHABLE')
            projection = await this.orchestrator.cancelNodes(
              projection.workflowId,
              targetIds,
              'WORKFLOW_QUORUM_UNREACHABLE',
            )
            this.onProjection?.(projection)
            const currentTargets = projection.nodes.filter(({ nodeId }) => byNodeId.has(nodeId))
            return {
              ok: false,
              results: resultRecord(results, byNodeId),
              evidence: evidenceRecord(currentTargets, byNodeId),
              errorCode: currentJoin.errorCode ?? 'WORKFLOW_QUORUM_UNREACHABLE',
            }
          }
        } else if (!outcome.ok) {
          await stopActive('DAG_PARTIAL_FAILURE_COLLECTED')
          projection = await this.orchestrator.cancelNodes(
            projection.workflowId,
            targetIds,
            'DAG_PARTIAL_FAILURE_COLLECTED',
          )
          this.onProjection?.(projection)
          const currentTargets = projection.nodes.filter(({ nodeId }) => byNodeId.has(nodeId))
          return {
            ok: false,
            results: resultRecord(results, byNodeId),
            evidence: evidenceRecord(currentTargets, byNodeId),
            errorCode: outcome.errorCode ?? 'WORKFLOW_NODE_FAILED',
          }
        }
      }
    }
    return {
      ok: false,
      results: resultRecord(results, byNodeId),
      evidence: {},
      errorCode: 'WORKFLOW_GRAPH_CANCELLED',
    }
  }
}

function evidenceRecord(
  nodes: readonly WorkflowProjectionV1['nodes'][number][],
  admitted: ReadonlyMap<string, AdmittedAgentGraphV1['nodes'][number]>,
): Readonly<Record<string, WorkflowArtifactRefV1>> {
  return Object.freeze(
    Object.fromEntries(
      nodes.flatMap((node) => {
        if (node.resultRef === undefined) return []
        return [[admitted.get(node.nodeId)?.key ?? node.nodeId, node.resultRef] as const]
      }),
    ),
  )
}

function resultRecord(
  results: ReadonlyMap<string, WorkflowAgentWorkerResultV1>,
  nodes: ReadonlyMap<string, AdmittedAgentGraphV1['nodes'][number]>,
): Readonly<Record<string, WorkflowAgentWorkerResultV1>> {
  return Object.freeze(
    Object.fromEntries(
      [...results].map(([nodeId, result]) => [nodes.get(nodeId)?.key ?? nodeId, result]),
    ),
  )
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && typeof Reflect.get(error, 'code') === 'string'
    ? Reflect.get(error, 'code')
    : undefined
}
