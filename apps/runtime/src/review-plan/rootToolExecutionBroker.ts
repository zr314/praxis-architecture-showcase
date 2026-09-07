import {
  canonicalDigestV1,
  isMemoryToolNameV1,
  type PreparedToolInvocation,
  type ReviewPlanExecutionRequestV1,
  runtimeError,
  type SessionProjectionV3,
  type ToolResult,
} from '@praxis/core-sdk'
import type { ArtifactStore } from '../artifacts/artifactStore.js'
import type { ToolExecutionBrokerV1 } from '../tools/toolRuntime.js'
import type { WorkflowEffectBrokerV1 } from '../workflow/workflowEffectBroker.js'
import type { PlanControlServicePortV1, ReviewPlanJournalPortV1 } from './planControlPorts.js'
import { durableSensitiveMessage } from '../prompt/promptPersistence.js'

export type RootToolExecutionBrokerOptionsV1 = Readonly<{
  journal: Pick<ReviewPlanJournalPortV1, 'loadProjection'>
  control: PlanControlServicePortV1
  artifacts: Pick<ArtifactStore, 'put'>
  workflowId: string
  effects?: Pick<WorkflowEffectBrokerV1, 'executeBound'> &
    Partial<Pick<WorkflowEffectBrokerV1, 'execute'>>
  sensitiveValues?: readonly string[]
}>

/**
 * Binds every Root work Tool to the currently focused ReviewPlan Item attempt.
 * Plan control tools bypass the work ledger; Direct ReAct remains behaviorally unchanged.
 */
export class RootToolExecutionBrokerV1 implements ToolExecutionBrokerV1 {
  constructor(private readonly options: RootToolExecutionBrokerOptionsV1) {}

  async execute(
    prepared: PreparedToolInvocation,
    signal: AbortSignal,
    invoke: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    // Local memory has its own explicit approval, scope checks and durable CAS
    // receipts. It is neither workspace work nor a Plan acceptance certificate.
    if (prepared.name.startsWith('plan.') || isMemoryToolNameV1(prepared.name)) return invoke()
    const invocation = prepared.executionContext?.invocation
    if (invocation === undefined) throw planError('PLAN_TOOL_INVOCATION_REQUIRED')
    const session = await this.options.journal.loadProjection(invocation.sessionId)
    if (
      session.snapshot.runs.find((run) => run.runId === invocation.runId)?.planPolicy !== 'required'
    ) {
      return this.options.effects?.execute?.(prepared, signal, invoke) ?? invoke()
    }
    const plan = session.reviewPlan
    if (plan === undefined || isTerminal(plan.state)) {
      assertPrePlanPolicy(session, invocation.runId, prepared)
      return invoke()
    }
    if (plan.finalPreparedReview !== undefined) throw planError('PLAN_REVIEW_ALREADY_PREPARED')
    const item = plan.items.find(
      (candidate) =>
        candidate.currentAttempt?.itemAttemptId === plan.focusedRootAttemptId &&
        candidate.currentAttempt?.state === 'open',
    )
    if (item?.currentAttempt === undefined) throw planError('PLAN_ITEM_ATTEMPT_REQUIRED')
    if (item.preparedReview !== undefined) throw planError('PLAN_REVIEW_ALREADY_PREPARED')

    const requestId = `rtr_${canonicalDigestV1({
      invocationId: invocation.invocationId,
      purpose: 'root_tool',
    }).slice('sha256:'.length)}`
    const inputDigest = canonicalDigestV1({ toolName: prepared.name, input: prepared.input })
    const requested = {
      sessionId: invocation.sessionId,
      planId: plan.planId,
      expectedPlanRevision: plan.revision,
      itemId: item.id,
      itemAttemptId: item.currentAttempt.itemAttemptId,
      requestId,
      invocation,
      toolName: prepared.name,
      inputDigest,
    }
    await this.options.control.recordRootToolRequest({
      ...requested,
      origin: runtimeOrigin(`${requestId}:request`, requested),
    })

    const binding: ReviewPlanExecutionRequestV1 = {
      sessionId: invocation.sessionId,
      planId: plan.planId,
      planRevision: plan.revision,
      itemId: item.id,
      itemAttemptId: item.currentAttempt.itemAttemptId,
      requestId,
      workflowId: this.options.workflowId,
      inputDigest,
    }
    const startedAt = new Date().toISOString()
    const result =
      this.options.effects !== undefined &&
      ['write', 'process', 'network'].includes(prepared.descriptor.sideEffect)
        ? await this.options.effects.executeBound(prepared, signal, invoke, binding)
        : await invoke()
    const artifact = await this.options.artifacts.put(
      {
        schemaVersion: 1,
        kind: 'review_plan_root_tool_result',
        requestId,
        invocationId: invocation.invocationId,
        toolName: prepared.name,
        sideEffect: prepared.descriptor.sideEffect,
        ...(['write', 'process', 'network'].includes(prepared.descriptor.sideEffect)
          ? { effectKind: effectKindFor(prepared) }
          : {}),
        inputDigest,
        inputEvidence: durableSensitiveMessage(
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                id: invocation.providerToolCallId,
                name: prepared.name,
                input: prepared.input,
              },
            ],
          },
          this.options.sensitiveValues ?? [],
        ),
        invocation,
        planRevision: plan.revision,
        itemId: item.id,
        itemAttemptId: item.currentAttempt.itemAttemptId,
        startedAt,
        finishedAt: new Date().toISOString(),
        result,
      },
      'application/vnd.praxis.review-plan-tool-result+json',
    )
    const recorded = {
      sessionId: invocation.sessionId,
      planId: plan.planId,
      expectedPlanRevision: plan.revision,
      itemId: item.id,
      itemAttemptId: item.currentAttempt.itemAttemptId,
      requestId,
      resultRef: artifact.artifactId,
    }
    await this.options.control.recordRootToolResult({
      ...recorded,
      origin: runtimeOrigin(`${requestId}:result`, recorded),
    })
    return result
  }
}

function runtimeOrigin(requestId: string, payload: unknown) {
  return {
    kind: 'runtime' as const,
    requestId,
    inputDigest: canonicalDigestV1(payload),
  }
}

function effectKindFor(prepared: PreparedToolInvocation) {
  if (prepared.descriptor.sideEffect === 'write') return 'workspace_write' as const
  const idempotencyKey = prepared.input.idempotencyKey
  return typeof idempotencyKey === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u.test(idempotencyKey)
    ? ('external_idempotent' as const)
    : ('external_non_idempotent' as const)
}

function assertPrePlanPolicy(
  projection: SessionProjectionV3,
  runId: string,
  prepared: PreparedToolInvocation,
): void {
  const policy = projection.snapshot.runs.find((run) => run.runId === runId)?.planPolicy
  if (policy !== 'required') return
  const planningRead =
    prepared.descriptor.sideEffect === 'read' &&
    !prepared.name.startsWith('agent.') &&
    !prepared.name.startsWith('workflow.')
  if (!planningRead) throw planError('PLAN_REQUIRED_BEFORE_EXECUTION')
}

function isTerminal(state: string): boolean {
  return ['completed', 'abandoned', 'cancelled'].includes(state)
}

function planError(code: string) {
  const message =
    code === 'PLAN_ITEM_ATTEMPT_REQUIRED'
      ? 'No focused open Item attempt exists. Use plan.progress start on a pending/needs_fix Item, or focus an existing open attempt using its current itemAttemptId. Accepted Items cannot be restarted. After a final Review rejects otherwise accepted Items, use plan.update to add a repair Item while preserving the original criteria, then start that Item. Changing only the objective does not create an attempt. If trusted external input or recovery is required, explain the block and end the turn instead of retrying work tools.'
      : 'ReviewPlan execution guard rejected the Tool invocation.'
  return runtimeError(code, 'planner', message)
}
