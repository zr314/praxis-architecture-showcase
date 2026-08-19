import { randomUUID } from 'node:crypto'
import {
  type PreparedToolInvocation,
  promptDigest,
  type ToolResult,
  type WorkflowModePolicyV1,
  type WorkflowProjectionV1,
} from '@praxis/core-sdk'
import type { ArtifactStore } from '../artifacts/artifactStore.js'
import type { ToolExecutionBrokerV1 } from '../tools/toolRuntime.js'
import type { WorkflowOrchestratorV1 } from './workflowOrchestrator.js'

/**
 * Journals every mutable Tool call as a durable Activity. The
 * underlying Tool still executes through ToolRuntime, so schema, permission,
 * path and conflict checks remain on the single normal Tool path.
 */
export class WorkflowEffectBrokerV1 implements ToolExecutionBrokerV1 {
  constructor(
    private readonly orchestrator: WorkflowOrchestratorV1,
    private readonly artifacts: Pick<ArtifactStore, 'put' | 'read'>,
    private readonly workflowId: string,
    private readonly onProjection?: (projection: WorkflowProjectionV1) => void,
    private readonly onReceipt?: () => void,
    private readonly modePolicy: WorkflowModePolicyV1 = 'auto',
  ) {}

  async execute(
    prepared: PreparedToolInvocation,
    _signal: AbortSignal,
    invoke: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    if (
      this.modePolicy === 'workflow' &&
      !prepared.name.startsWith('workflow.') &&
      !prepared.name.startsWith('agent.') &&
      ['write', 'process', 'network'].includes(prepared.descriptor.sideEffect)
    ) {
      const projection = await this.orchestrator.projection(this.workflowId)
      if (projection.spec.topology === 'single_agent') {
        return {
          ok: false,
          summary: 'Workflow policy requires an admitted topology before non-read-only work.',
          error: {
            code: 'WORKFLOW_TOPOLOGY_REQUIRED',
            category: 'permission',
            retryable: true,
          },
        }
      }
    }
    if (!durableEffect(prepared)) return invoke()
    const inputDigest = promptDigest(JSON.stringify({ tool: prepared.name, input: prepared.input }))
    const explicitKey = explicitIdempotencyKey(prepared.input)
    const workspaceWrite = prepared.descriptor.sideEffect === 'write'
    const idempotencyKey = workspaceWrite
      ? (explicitKey ?? `workspace-${inputDigest.slice('sha256:'.length)}`)
      : explicitKey
    const effect = workspaceWrite
      ? ({ class: 'workspace_write', idempotencyKey, requiresApproval: false } as const)
      : idempotencyKey === undefined
        ? ({ class: 'external_non_idempotent', requiresApproval: true } as const)
        : ({ class: 'external_idempotent', idempotencyKey, requiresApproval: true } as const)
    let claim: Awaited<ReturnType<WorkflowOrchestratorV1['claimActivity']>> | undefined
    let effectReserved = false
    try {
      const admitted = await this.orchestrator.admitToolActivity(
        this.workflowId,
        prepared.name,
        prepared.input,
        effect,
      )
      this.onProjection?.(admitted.projection)
      claim = await this.orchestrator.claimActivity(
        this.workflowId,
        admitted.task.nodeId,
        `effect-broker-${randomUUID()}`,
      )
      const running = await this.orchestrator.markRunning(claim)
      this.onProjection?.(running)
      if (idempotencyKey !== undefined) {
        const admission = await this.orchestrator.reserveEffect(claim, inputDigest)
        if (admission.decision === 'conflict' || admission.decision === 'in_progress') {
          await this.orchestrator.complete(claim, {
            ok: false,
            errorCode:
              admission.decision === 'conflict'
                ? 'WORKFLOW_EFFECT_IDEMPOTENCY_CONFLICT'
                : 'WORKFLOW_EFFECT_IN_PROGRESS',
          })
          return {
            ok: false,
            summary:
              admission.decision === 'conflict'
                ? 'The idempotency key is already bound to different input.'
                : 'The same external effect is already in progress.',
            error: {
              code:
                admission.decision === 'conflict'
                  ? 'WORKFLOW_EFFECT_IDEMPOTENCY_CONFLICT'
                  : 'WORKFLOW_EFFECT_IN_PROGRESS',
              category: 'execution',
              retryable: admission.decision === 'in_progress',
            },
          }
        }
        if (admission.decision === 'replay' && admission.reservation.receiptRef !== undefined) {
          const stored = (await this.artifacts.read(
            admission.reservation.receiptRef.artifactId,
          )) as { result?: ToolResult }
          const result = stored.result
          if (result === undefined) throw new Error('Committed effect receipt has no result.')
          const completed = await this.orchestrator.complete(claim, {
            ok: true,
            resultRef: admission.reservation.receiptRef,
            receiptRef: admission.reservation.receiptRef,
            effectReplayed: true,
          })
          this.onProjection?.(completed)
          return result
        }
        effectReserved = admission.decision === 'execute'
      }
      const heartbeat = setInterval(() => {
        void this.orchestrator.heartbeat(claim!, false).catch(() => undefined)
      }, 30_000)
      heartbeat.unref?.()
      let result: ToolResult
      try {
        result = await invoke()
      } finally {
        clearInterval(heartbeat)
      }
      if (!result.ok) {
        if (workspaceWrite) {
          const projection = await this.orchestrator.complete(claim, {
            ok: false,
            errorCode: result.error?.code ?? 'TOOL_EXECUTION_FAILED',
            effectReserved,
            effectKnownFailure: true,
          })
          this.onProjection?.(projection)
          return result
        }
        const projection = await this.orchestrator.markUnknown(
          claim,
          result.error?.code ?? 'WORKFLOW_EFFECT_OUTCOME_UNKNOWN',
          effectReserved,
        )
        this.onProjection?.(projection)
        return {
          ...result,
          summary: `${result.summary} The invocation returned a failure, but any partial process or external side effects are unverified; inspect current state before retrying.`,
          error: {
            code: 'WORKFLOW_EFFECT_OUTCOME_UNKNOWN',
            category: 'execution',
            retryable: false,
          },
        }
      }
      const receipt = await this.artifacts.put({
        schemaVersion: 1,
        kind: 'workflow_effect_receipt',
        workflowId: this.workflowId,
        nodeId: claim.task.nodeId,
        attemptId: claim.task.attemptId,
        toolName: prepared.name,
        inputDigest,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        result,
      })
      const receiptRef = {
        artifactId: receipt.artifactId,
        digest: receipt.digest as `sha256:${string}`,
        mediaType: receipt.mimeType,
      }
      const completed = await this.orchestrator.complete(claim, {
        ok: true,
        resultRef: receiptRef,
        receiptRef,
        effectReserved,
      })
      this.onProjection?.(completed)
      this.onReceipt?.()
      return {
        ...result,
        artifacts: [...(result.artifacts ?? []), receipt],
      }
    } catch (error) {
      if (claim !== undefined) {
        await this.orchestrator
          .markUnknown(claim, 'WORKFLOW_EFFECT_RECEIPT_PERSIST_FAILED', effectReserved)
          .then((projection) => this.onProjection?.(projection))
          .catch(() => undefined)
      }
      return {
        ok: false,
        summary: 'Mutable Tool execution could not be committed with a durable receipt.',
        error: {
          code: errorCode(error),
          category: 'execution',
          retryable: false,
        },
      }
    }
  }
}

function durableEffect(prepared: PreparedToolInvocation): boolean {
  return (
    !prepared.name.startsWith('agent.') &&
    !prepared.name.startsWith('workflow.') &&
    ['write', 'process', 'network'].includes(prepared.descriptor.sideEffect)
  )
}

function explicitIdempotencyKey(input: Readonly<Record<string, unknown>>): string | undefined {
  const value = input.idempotencyKey
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u.test(value)
    ? value
    : undefined
}

function errorCode(error: unknown): string {
  return error instanceof Error && typeof Reflect.get(error, 'code') === 'string'
    ? Reflect.get(error, 'code')
    : 'WORKFLOW_EFFECT_RECEIPT_PERSIST_FAILED'
}
