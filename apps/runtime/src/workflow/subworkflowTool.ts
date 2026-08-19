import { randomUUID } from 'node:crypto'
import type {
  AgentHarnessProfileV1,
  DelegateProposalV1,
  RuntimeTool,
  ToolRequest,
  ToolResult,
  WorkflowProjectionV1,
} from '@praxis/core-sdk'
import {
  ACTIVE_BUILTIN_AGENT_PROFILE_VERSION,
  LONG_LIVED_EXECUTION_POLICY_V1,
} from '../longLivedExecutionPolicy.js'
import {
  AGENT_ASSEMBLY_SCHEMA_PROPERTIES,
  AGENT_HARNESS_PROFILES,
  parseAgentAssemblyRequestV1,
} from './agentAssembly.js'
import { executeWorkflowAgentClaimV1, type WorkflowAgentWorkerPortV1 } from './agentDelegateTool.js'
import type { WorkflowOrchestratorV1 } from './workflowOrchestrator.js'

/** Creates a separately identified, non-recursive child Workflow and joins it. */
export class SubworkflowToolV1 implements RuntimeTool {
  readonly definition = {
    name: 'workflow.subworkflow',
    description:
      'Create and execute a separately journaled child Workflow for a bounded outcome. The child is solo and cannot create descendants; its result is joined back into the parent node.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['objective'],
      properties: {
        objective: { type: 'string', minLength: 1, maxLength: 16_384 },
        profile: { enum: AGENT_HARNESS_PROFILES, default: 'default' },
        workspace: { enum: ['none', 'read', 'write'], default: 'read' },
        tools: { type: 'array', maxItems: 256, items: { type: 'string' } },
        skills: { type: 'array', maxItems: 128, items: { type: 'string' } },
        mcpServers: { type: 'array', maxItems: 128, items: { type: 'string' } },
        network: { type: 'boolean' },
        maxWallClockMs: { type: 'integer', minimum: 1_000 },
        maxTokens: {
          type: 'integer',
          minimum: 1,
          description: 'Optional hard ceiling. Omit for the unbudgeted v4 Child default.',
        },
        maxToolCalls: { type: 'integer', minimum: 1 },
        maxTurns: { type: 'integer', minimum: 1 },
        ...AGENT_ASSEMBLY_SCHEMA_PROPERTIES,
      },
    },
    outputSchema: { type: 'object' },
    execution: {
      sideEffect: 'process' as const,
      target: { kind: 'workspace' as const },
      parallelSafe: false,
      conflictScope: 'workspace' as const,
      maxInlineBytes: 64 * 1024,
    },
  }

  constructor(
    private readonly orchestrator: WorkflowOrchestratorV1,
    private readonly worker: WorkflowAgentWorkerPortV1,
    private readonly workflowId: string,
    private readonly onProjection?: (projection: WorkflowProjectionV1) => void,
  ) {}

  async execute(request: ToolRequest): Promise<ToolResult> {
    const objective = String(request.input.objective)
    const workspace =
      request.input.workspace === 'write' || request.input.workspace === 'none'
        ? request.input.workspace
        : 'read'
    const profile = harnessProfile(request.input.profile)
    const assemblyRequest = parseAgentAssemblyRequestV1(request.input)
    try {
      const parent = await this.orchestrator.admitDelegate(
        this.workflowId,
        'root',
        proposal(request.input, objective, workspace, profile),
        new Date().toISOString(),
        'subworkflow',
      )
      this.onProjection?.(parent.projection)
      const parentClaim = await this.orchestrator.claimNode(
        this.workflowId,
        parent.task.nodeId,
        `subworkflow-parent-${randomUUID()}`,
      )
      const parentRunning = await this.orchestrator.markRunning(parentClaim)
      this.onProjection?.(parentRunning)
      const child = await this.orchestrator.start({
        sessionId: parent.projection.sessionId,
        parentRunId: parent.projection.runId,
        objective,
        modePolicy: 'solo',
        cwd: parent.projection.spec.workspace,
        rootGrant: { ...parent.grant, mayDelegate: false },
        // Preserve the parent's explicit budget (or v4's unbudgeted defaults).
        // Non-recursion is enforced by the capability grant below, not by a
        // hidden one-AgentTask execution quota.
        budget: parent.projection.spec.budget,
        parentWorkflowId: this.workflowId,
        parentNodeId: parent.task.nodeId,
        ...(parent.projection.spec.executionTarget === undefined
          ? {}
          : { executionTarget: parent.projection.spec.executionTarget }),
        rootAssemblyRequest: assemblyRequest,
        rootHarnessProfile: profile,
      })
      this.onProjection?.(child)
      const childClaim = await this.orchestrator.claimRoot(
        child.workflowId,
        `subworkflow-child-${randomUUID()}`,
      )
      const childRunning = await this.orchestrator.markRunning(childClaim)
      this.onProjection?.(childRunning)
      const outcome = await executeWorkflowAgentClaimV1(
        this.orchestrator,
        this.worker,
        childClaim,
        request.signal,
      )
      const resultRef = outcome.artifacts?.[0]
      const childCompleted = await this.orchestrator.complete(childClaim, {
        ok: outcome.ok,
        errorCode: outcome.errorCode,
        resultRef,
        usage: outcome.usage,
      })
      this.onProjection?.(childCompleted)
      const parentCompleted = await this.orchestrator.complete(parentClaim, {
        ok: outcome.ok,
        errorCode: outcome.errorCode,
        resultRef,
      })
      this.onProjection?.(parentCompleted)
      return {
        ok: outcome.ok,
        summary: outcome.ok ? 'Subworkflow completed.' : 'Subworkflow failed.',
        output: {
          parentWorkflowId: this.workflowId,
          childWorkflowId: child.workflowId,
          parentNodeId: parent.task.nodeId,
          result: outcome.output,
          evidence: outcome.artifacts,
        },
        error: outcome.ok
          ? undefined
          : {
              code: outcome.errorCode ?? 'SUBWORKFLOW_FAILED',
              category: 'execution',
              retryable: outcome.retryable ?? false,
            },
      }
    } catch (error) {
      const code =
        error instanceof Error && typeof Reflect.get(error, 'code') === 'string'
          ? Reflect.get(error, 'code')
          : 'SUBWORKFLOW_FAILED'
      return {
        ok: false,
        summary: `Subworkflow failed (${code}).`,
        error: { code, category: 'execution', retryable: false },
      }
    }
  }
}

function proposal(
  input: Record<string, unknown>,
  objective: string,
  workspace: 'none' | 'read' | 'write',
  profile: AgentHarnessProfileV1,
): DelegateProposalV1 {
  return {
    schemaVersion: 1,
    proposalId: randomUUID(),
    profileRef: { id: profile, version: ACTIVE_BUILTIN_AGENT_PROFILE_VERSION },
    objective,
    inputRefs: [],
    grantRequest: {
      tools: stringArray(input.tools, ['*']),
      skills: stringArray(input.skills, ['*']),
      mcpServers: stringArray(input.mcpServers, ['*']),
      workspace,
      network: input.network === true,
      mayDelegate: false,
    },
    budgetRequest: {
      maxWallClockMs:
        integer(input.maxWallClockMs) ?? LONG_LIVED_EXECUTION_POLICY_V1.maxWallClockMs,
      maxTokens: integer(input.maxTokens),
      maxToolCalls: integer(input.maxToolCalls) ?? LONG_LIVED_EXECUTION_POLICY_V1.maxToolCalls,
      maxTurns: integer(input.maxTurns) ?? LONG_LIVED_EXECUTION_POLICY_V1.maxTurns,
    },
    assemblyRequest: parseAgentAssemblyRequestV1(input),
    reasons: ['LONG_DURATION'],
  }
}

function harnessProfile(value: unknown): AgentHarnessProfileV1 {
  return value === 'worker' || value === 'explorer' ? value : 'default'
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) ? value.map(String) : fallback
}

function integer(value: unknown, minimum = 1): number | undefined {
  return Number.isSafeInteger(value) ? Math.max(minimum, Number(value)) : undefined
}
