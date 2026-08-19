import { randomUUID } from 'node:crypto'
import type {
  BudgetUsage,
  DelegateProposalV1,
  RuntimeTool,
  ToolRequest,
  ToolResult,
  WorkflowArtifactRefV1,
  WorkflowProjectionV1,
  WorkflowTaskClaimV1,
} from '@praxis/core-sdk'
import { ACTIVE_BUILTIN_AGENT_PROFILE_VERSION } from '../longLivedExecutionPolicy.js'
import {
  AGENT_ASSEMBLY_SCHEMA_PROPERTIES,
  AGENT_HARNESS_PROFILES,
  parseAgentAssemblyRequestV1,
} from './agentAssembly.js'
import type { WorkflowOrchestratorV1 } from './workflowOrchestrator.js'

const MIN_DELEGATED_TOKEN_BUDGET = 1

export type WorkflowAgentWorkerResultV1 = Readonly<{
  ok: boolean
  summary: string
  output?: Readonly<Record<string, unknown>>
  artifacts?: readonly WorkflowArtifactRefV1[]
  errorCode?: string
  retryable?: boolean
  usage?: Readonly<BudgetUsage>
}>

export interface WorkflowAgentWorkerPortV1 {
  execute(claim: WorkflowTaskClaimV1, signal: AbortSignal): Promise<WorkflowAgentWorkerResultV1>
  cancel?(claim: WorkflowTaskClaimV1, reason: string): Promise<void>
}

/** Model-facing delegation proposal. Admission and execution remain Runtime-owned. */
export class AgentDelegateToolV1 implements RuntimeTool {
  readonly definition = {
    name: 'agent.delegate',
    description:
      'Request one independently running Child Agent. Propose its role, capabilities, model class, reasoning, budget, result contract, and success criteria; the Runtime audits and attenuates every request to inherited authority.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['profile', 'objective', 'reasons'],
      properties: {
        profile: {
          type: 'string',
          enum: AGENT_HARNESS_PROFILES,
        },
        objective: { type: 'string', minLength: 1, maxLength: 16_384 },
        reasons: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'string',
            enum: [
              'MULTI_DOMAIN',
              'PARALLEL_EVIDENCE',
              'EXTERNAL_WAIT',
              'HIGH_RISK_WRITE',
              'LONG_DURATION',
              'INDEPENDENT_VERIFICATION',
              'USER_REQUIRED_WORKFLOW',
            ],
          },
        },
        tools: {
          type: 'array',
          maxItems: 256,
          items: { type: 'string' },
          description:
            'Requested inherited Tool names. Omit to request all Tools compatible with the workspace grant; explicitly include shell for command execution.',
        },
        skills: { type: 'array', maxItems: 128, items: { type: 'string' } },
        mcpServers: { type: 'array', maxItems: 128, items: { type: 'string' } },
        workspace: {
          enum: ['none', 'read', 'write'],
          description:
            'Child workspace authority. Omit defaults to read; request write for edits, builds, installs, or mutable shell work.',
        },
        network: {
          type: 'boolean',
          description: 'Request inherited network authority when external access is required.',
        },
        ...AGENT_ASSEMBLY_SCHEMA_PROPERTIES,
        maxWallClockMs: { type: 'integer', minimum: 1_000 },
        maxTokens: {
          type: 'integer',
          minimum: MIN_DELEGATED_TOKEN_BUDGET,
          description: 'Optional hard ceiling. Omit for the unbudgeted v4 Child default.',
        },
        maxToolCalls: { type: 'integer', minimum: 1 },
        maxTurns: { type: 'integer', minimum: 1 },
      },
    },
    outputSchema: { type: 'object' },
    execution: {
      sideEffect: 'process' as const,
      target: { kind: 'workspace' as const },
      parallelSafe: true,
      conflictScope: 'target' as const,
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
    const proposal = proposalFromInput(request.input)
    let claim: WorkflowTaskClaimV1 | undefined
    try {
      const admitted = await this.orchestrator.admitDelegate(
        this.workflowId,
        this.parentNodeId,
        proposal,
      )
      this.onProjection?.(admitted.projection)
      claim = await this.orchestrator.claimNode(
        this.workflowId,
        admitted.task.nodeId,
        `local-agent-${randomUUID()}`,
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
        summary: result.summary,
        output: {
          workflowId: this.workflowId,
          nodeId: claim.task.nodeId,
          profile: proposal.profileRef.id,
          result: result.output,
          evidence: result.artifacts,
        },
        error: result.ok
          ? undefined
          : {
              code: result.errorCode ?? 'WORKFLOW_AGENT_FAILED',
              category: 'execution',
              retryable: result.retryable ?? false,
            },
      }
    } catch (error) {
      if (claim !== undefined && request.signal.aborted)
        await this.worker.cancel?.(claim, 'parent_cancelled').catch(() => undefined)
      const code = errorCode(error)
      return {
        ok: false,
        summary: `Delegated agent failed (${code}).`,
        error: { code, category: 'execution', retryable: retryable(error) },
      }
    }
  }
}

export async function executeWorkflowAgentClaimV1(
  orchestrator: WorkflowOrchestratorV1,
  worker: WorkflowAgentWorkerPortV1,
  claim: WorkflowTaskClaimV1,
  signal: AbortSignal,
): Promise<WorkflowAgentWorkerResultV1> {
  const heartbeat = setInterval(() => {
    void orchestrator.heartbeat(claim).catch(() => undefined)
  }, 30_000)
  heartbeat.unref?.()
  try {
    return await worker.execute(claim, signal)
  } catch (error) {
    if (signal.aborted) await worker.cancel?.(claim, 'parent_cancelled').catch(() => undefined)
    const code = signal.aborted ? 'WORKFLOW_AGENT_CANCELLED' : errorCode(error)
    return {
      ok: false,
      summary: `Workflow agent failed (${code}).`,
      errorCode: code,
      retryable: !signal.aborted && retryable(error),
    }
  } finally {
    clearInterval(heartbeat)
  }
}

function proposalFromInput(input: Record<string, unknown>): DelegateProposalV1 {
  const profile = String(input.profile)
  return {
    schemaVersion: 1,
    proposalId: randomUUID(),
    profileRef: { id: profile, version: ACTIVE_BUILTIN_AGENT_PROFILE_VERSION },
    objective: String(input.objective),
    inputRefs: [],
    grantRequest: {
      tools: stringArray(input.tools, ['*']),
      skills: stringArray(input.skills, ['*']),
      mcpServers: stringArray(input.mcpServers, ['*']),
      workspace:
        input.workspace === 'none' || input.workspace === 'write' ? input.workspace : 'read',
      network: input.network === true,
      // Child agents never receive descendant-creation authority.
      mayDelegate: false,
    },
    assemblyRequest: parseAgentAssemblyRequestV1(input),
    budgetRequest: {
      maxWallClockMs: integer(input.maxWallClockMs),
      maxTokens: integer(input.maxTokens, MIN_DELEGATED_TOKEN_BUDGET),
      maxToolCalls: integer(input.maxToolCalls),
      maxTurns: integer(input.maxTurns),
    },
    reasons: input.reasons as DelegateProposalV1['reasons'],
  }
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) ? value.map(String) : fallback
}
function integer(value: unknown, minimum = 1): number | undefined {
  return Number.isSafeInteger(value) ? Math.max(minimum, Number(value)) : undefined
}
function errorCode(error: unknown): string {
  return error instanceof Error && typeof Reflect.get(error, 'code') === 'string'
    ? Reflect.get(error, 'code')
    : 'WORKFLOW_AGENT_FAILED'
}
function retryable(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'retryable') === true
}
