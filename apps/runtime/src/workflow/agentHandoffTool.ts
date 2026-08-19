import { randomUUID } from 'node:crypto'
import type {
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

/** A named specialist takes ownership of one conversational outcome. */
export class AgentHandoffToolV1 implements RuntimeTool {
  readonly definition = {
    name: 'agent.handoff',
    description:
      'Hand off the requested outcome to one named agent profile. The specialist result becomes reviewable evidence for the parent response; Runtime persists the handoff as a synthesis node.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['profile', 'objective'],
      properties: {
        profile: {
          enum: AGENT_HARNESS_PROFILES,
        },
        objective: { type: 'string', minLength: 1, maxLength: 16_384 },
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
    private readonly parentNodeId = 'root',
    private readonly onProjection?: (projection: WorkflowProjectionV1) => void,
  ) {}

  async execute(request: ToolRequest): Promise<ToolResult> {
    const proposal = handoffProposal(request.input)
    try {
      const admitted = await this.orchestrator.admitDelegate(
        this.workflowId,
        this.parentNodeId,
        proposal,
        new Date().toISOString(),
        'synthesis',
      )
      this.onProjection?.(admitted.projection)
      const claim = await this.orchestrator.claimNode(
        this.workflowId,
        admitted.task.nodeId,
        `handoff-worker-${randomUUID()}`,
      )
      const running = await this.orchestrator.markRunning(claim)
      this.onProjection?.(running)
      const result = await executeWorkflowAgentClaimV1(
        this.orchestrator,
        this.worker,
        claim,
        request.signal,
      )
      const completed = await this.orchestrator.complete(claim, {
        ok: result.ok,
        errorCode: result.errorCode,
        resultRef: result.artifacts?.[0],
        usage: result.usage,
      })
      this.onProjection?.(completed)
      return {
        ok: result.ok,
        summary: result.ok
          ? `Handoff to ${proposal.profileRef.id} completed.`
          : `Handoff to ${proposal.profileRef.id} failed.`,
        output: {
          workflowId: this.workflowId,
          nodeId: claim.task.nodeId,
          profile: proposal.profileRef.id,
          authoritativeResult: result.output,
          evidence: result.artifacts,
        },
        error: result.ok
          ? undefined
          : {
              code: result.errorCode ?? 'WORKFLOW_HANDOFF_FAILED',
              category: 'execution',
              retryable: result.retryable ?? false,
            },
      }
    } catch (error) {
      const code =
        error instanceof Error && typeof Reflect.get(error, 'code') === 'string'
          ? Reflect.get(error, 'code')
          : 'WORKFLOW_HANDOFF_FAILED'
      return {
        ok: false,
        summary: `Handoff failed (${code}).`,
        error: { code, category: 'execution', retryable: false },
      }
    }
  }
}

function handoffProposal(input: Record<string, unknown>): DelegateProposalV1 {
  const workspace =
    input.workspace === 'write' || input.workspace === 'none' ? input.workspace : 'read'
  return {
    schemaVersion: 1,
    proposalId: randomUUID(),
    profileRef: {
      id: String(input.profile),
      version: ACTIVE_BUILTIN_AGENT_PROFILE_VERSION,
    },
    objective: String(input.objective),
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
    reasons: ['MULTI_DOMAIN'],
  }
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) ? value.map(String) : fallback
}

function integer(value: unknown, minimum = 1): number | undefined {
  return Number.isSafeInteger(value) ? Math.max(minimum, Number(value)) : undefined
}
