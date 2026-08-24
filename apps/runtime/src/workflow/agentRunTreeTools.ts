import { randomUUID } from 'node:crypto'
import type {
  DelegateProposalV1,
  RuntimeTool,
  ToolRequest,
  ToolResult,
  WorkflowProjectionV1,
} from '@praxis/core-sdk'
import { ACTIVE_BUILTIN_AGENT_PROFILE_VERSION } from '../longLivedExecutionPolicy.js'
import {
  AGENT_ASSEMBLY_SCHEMA_PROPERTIES,
  AGENT_HARNESS_PROFILES,
  parseAgentAssemblyRequestV1,
} from './agentAssembly.js'
import type { WorkflowOrchestratorV1 } from './workflowOrchestrator.js'

const POLL_MS = 250
const TERMINAL = new Set([
  'unknown',
  'skipped',
  'succeeded',
  'failed',
  'cancelled',
  'manual_intervention',
])

export type AgentRunTreeControlPortV1 = Readonly<{
  cancel(workflowId: string, childIds: readonly string[], reason: string): Promise<number>
  steer(workflowId: string, childId: string, instruction: string): Promise<boolean>
}>

/**
 * Starts one durable Child without forcing the parent to wait. The Workflow
 * Authority is an internal execution container here; childId is the stable
 * model-facing Run Tree handle and no graph authoring is exposed to the model.
 */
export class AgentSpawnToolV1 implements RuntimeTool {
  readonly definition = {
    name: 'agent.spawn',
    description:
      'Start one independent durable Child Agent and return immediately with a childId. Use it only for a genuinely independent investigation, implementation, or review; continue useful parent work, then use agent.wait or agent.result.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['objective'],
      properties: {
        objective: { type: 'string', minLength: 1, maxLength: 16_384 },
        profile: { type: 'string', enum: AGENT_HARNESS_PROFILES, default: 'worker' },
        reasons: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
          items: {
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
        tools: { type: 'array', maxItems: 256, items: { type: 'string' } },
        skills: { type: 'array', maxItems: 128, items: { type: 'string' } },
        mcpServers: { type: 'array', maxItems: 128, items: { type: 'string' } },
        workspace: { enum: ['none', 'read', 'write'], default: 'read' },
        network: { type: 'boolean', default: false },
        ...AGENT_ASSEMBLY_SCHEMA_PROPERTIES,
      },
    },
    outputSchema: { type: 'object' },
    execution: {
      sideEffect: 'process' as const,
      target: { kind: 'none' as const },
      parallelSafe: true,
      conflictScope: 'global' as const,
      maxInlineBytes: 32 * 1024,
    },
  }

  constructor(
    private readonly orchestrator: WorkflowOrchestratorV1,
    private readonly workflowId: string,
    private readonly parentNodeId = 'root',
    private readonly onProjection?: (projection: WorkflowProjectionV1) => void,
  ) {}

  async execute(request: ToolRequest): Promise<ToolResult> {
    try {
      const proposal = spawnProposal(request.input)
      const admitted = await this.orchestrator.admitDelegate(
        this.workflowId,
        this.parentNodeId,
        proposal,
        new Date().toISOString(),
        'agent_task',
        'background',
        false,
      )
      this.onProjection?.(admitted.projection)
      return {
        ok: true,
        summary: 'Durable Child started; the parent remains active.',
        output: {
          childId: admitted.task.nodeId,
          state: 'scheduled',
          objective: proposal.objective,
          profile: proposal.profileRef.id,
        },
      }
    } catch (error) {
      return failed(errorCode(error, 'AGENT_SPAWN_FAILED'), 'Child spawn failed')
    }
  }
}

/** Durable Future wait over Child handles; no explicit Join node is authored. */
export class AgentWaitToolV1 implements RuntimeTool {
  readonly definition = {
    name: 'agent.wait',
    description:
      'Wait for selected Child handles using all, any, or quorum semantics. Returns terminal states and durable result references, never Child reasoning or transcripts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['childIds'],
      properties: {
        childIds: {
          type: 'array',
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
          items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$' },
        },
        mode: { enum: ['all', 'any', 'quorum'], default: 'all' },
        minimum: { type: 'integer', minimum: 1, maximum: 64 },
      },
    },
    outputSchema: { type: 'object' },
    execution: {
      sideEffect: 'process' as const,
      target: { kind: 'none' as const },
      parallelSafe: false,
      conflictScope: 'global' as const,
      maxInlineBytes: 128 * 1024,
    },
  }

  constructor(
    private readonly orchestrator: WorkflowOrchestratorV1,
    private readonly workflowId: string,
    private readonly recipientNodeId = 'root',
    private readonly onProjection?: (projection: WorkflowProjectionV1) => void,
  ) {}

  async execute(request: ToolRequest): Promise<ToolResult> {
    const childIds = strings(request.input.childIds)
    const mode =
      request.input.mode === 'any' || request.input.mode === 'quorum' ? request.input.mode : 'all'
    const minimum = mode === 'quorum' ? integer(request.input.minimum, 1) : undefined
    if (
      childIds.length === 0 ||
      (mode === 'quorum' && (minimum === undefined || minimum > childIds.length))
    ) {
      return failed('AGENT_WAIT_ARGUMENTS_INVALID', 'Child wait rejected')
    }
    try {
      while (!request.signal.aborted) {
        const projection = await this.orchestrator.reconcileWorkflow(this.workflowId)
        this.onProjection?.(projection)
        const selected = childIds.map((id) => projection.nodes.find(({ nodeId }) => nodeId === id))
        if (selected.some((node) => node === undefined)) {
          return failed('AGENT_CHILD_NOT_FOUND', 'Child wait rejected')
        }
        const nodes = selected as NonNullable<(typeof selected)[number]>[]
        const succeeded = nodes.filter(({ state }) => state === 'succeeded').length
        const terminal = nodes.filter(({ state }) => TERMINAL.has(state)).length
        const required = mode === 'all' ? childIds.length : mode === 'any' ? 1 : minimum!
        if (succeeded >= required) {
          await acknowledgeResults(
            this.orchestrator,
            this.workflowId,
            this.recipientNodeId,
            childIds,
          )
          return childResult(this.workflowId, mode, required, nodes, true)
        }
        if (terminal === nodes.length || succeeded + (nodes.length - terminal) < required) {
          await acknowledgeResults(
            this.orchestrator,
            this.workflowId,
            this.recipientNodeId,
            childIds,
          )
          return childResult(this.workflowId, mode, required, nodes, false)
        }
        await tick(request.signal)
      }
      return failed('AGENT_WAIT_CANCELLED', 'Child wait cancelled')
    } catch (error) {
      return failed(errorCode(error, 'AGENT_WAIT_FAILED'), 'Child wait failed')
    }
  }
}

/** Non-blocking status/result lookup for one or more Child handles. */
export class AgentResultToolV1 implements RuntimeTool {
  readonly definition = {
    name: 'agent.result',
    description:
      'Inspect current Child status and durable result references without waiting. Optionally acknowledge terminal results after consuming them.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['childIds'],
      properties: {
        childIds: {
          type: 'array',
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
          items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$' },
        },
        acknowledge: { type: 'boolean', default: true },
      },
    },
    outputSchema: { type: 'object' },
    execution: {
      sideEffect: 'read' as const,
      target: { kind: 'none' as const },
      parallelSafe: true,
      conflictScope: 'global' as const,
      maxInlineBytes: 128 * 1024,
    },
  }

  constructor(
    private readonly orchestrator: WorkflowOrchestratorV1,
    private readonly workflowId: string,
    private readonly recipientNodeId = 'root',
  ) {}

  async execute(request: ToolRequest): Promise<ToolResult> {
    const childIds = strings(request.input.childIds)
    try {
      const projection = await this.orchestrator.projection(this.workflowId)
      const nodes = childIds.map((id) => projection.nodes.find(({ nodeId }) => nodeId === id))
      if (nodes.some((node) => node === undefined)) {
        return failed('AGENT_CHILD_NOT_FOUND', 'Child result lookup rejected')
      }
      if (request.input.acknowledge !== false) {
        await acknowledgeResults(this.orchestrator, this.workflowId, this.recipientNodeId, childIds)
      }
      return {
        ok: true,
        summary: 'Child status returned.',
        output: {
          children: (nodes as NonNullable<(typeof nodes)[number]>[]).map(projectChild),
        },
      }
    } catch (error) {
      return failed(errorCode(error, 'AGENT_RESULT_FAILED'), 'Child result lookup failed')
    }
  }
}

export class AgentCancelToolV1 implements RuntimeTool {
  readonly definition = {
    name: 'agent.cancel',
    description:
      'Cancel selected Child handles that no longer have value. Runtime preserves completed evidence and audit history.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['childIds'],
      properties: {
        childIds: {
          type: 'array',
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
          items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$' },
        },
        reason: { type: 'string', minLength: 1, maxLength: 1_024 },
      },
    },
    outputSchema: { type: 'object' },
    execution: {
      sideEffect: 'process' as const,
      target: { kind: 'none' as const },
      parallelSafe: false,
      conflictScope: 'global' as const,
      maxInlineBytes: 16 * 1024,
    },
  }

  constructor(
    private readonly orchestrator: WorkflowOrchestratorV1,
    private readonly control: AgentRunTreeControlPortV1,
    private readonly workflowId: string,
    private readonly onProjection?: (projection: WorkflowProjectionV1) => void,
  ) {}

  async execute(request: ToolRequest): Promise<ToolResult> {
    const childIds = strings(request.input.childIds)
    try {
      const projection = await this.orchestrator.projection(this.workflowId)
      if (childIds.some((id) => !projection.nodes.some(({ nodeId }) => nodeId === id))) {
        return failed('AGENT_CHILD_NOT_FOUND', 'Child cancellation rejected')
      }
      const active = await this.control.cancel(
        this.workflowId,
        childIds,
        boundedText(request.input.reason, 'parent_route_changed'),
      )
      const next = await this.orchestrator.cancelNodes(
        this.workflowId,
        childIds,
        'AGENT_CHILD_CANCELLED',
      )
      this.onProjection?.(next)
      return {
        ok: true,
        summary: 'Child cancellation requested.',
        output: { childIds, activeCancellationRequests: active },
      }
    } catch (error) {
      return failed(errorCode(error, 'AGENT_CANCEL_FAILED'), 'Child cancellation failed')
    }
  }
}

export class AgentSteerToolV1 implements RuntimeTool {
  readonly definition = {
    name: 'agent.steer',
    description:
      'Persist a bounded instruction for one Child. An active Child receives it at the next safe boundary; a not-yet-started Child receives it when launched.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['childId', 'instruction'],
      properties: {
        childId: {
          type: 'string',
          pattern: '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$',
        },
        instruction: { type: 'string', minLength: 1, maxLength: 8_192 },
      },
    },
    outputSchema: { type: 'object' },
    execution: {
      sideEffect: 'process' as const,
      target: { kind: 'none' as const },
      parallelSafe: false,
      conflictScope: 'global' as const,
      maxInlineBytes: 16 * 1024,
    },
  }

  constructor(
    private readonly orchestrator: WorkflowOrchestratorV1,
    private readonly control: AgentRunTreeControlPortV1,
    private readonly workflowId: string,
    private readonly senderNodeId = 'root',
  ) {}

  async execute(request: ToolRequest): Promise<ToolResult> {
    const childId = String(request.input.childId)
    const instruction = String(request.input.instruction)
    try {
      const projection = await this.orchestrator.projection(this.workflowId)
      if (!projection.nodes.some(({ nodeId }) => nodeId === childId)) {
        return failed('AGENT_CHILD_NOT_FOUND', 'Child steer rejected')
      }
      const message = await this.orchestrator.postMessage({
        schemaVersion: 1,
        messageId: `agent-steer-${randomUUID()}`,
        workflowId: this.workflowId,
        sender: { kind: 'node', id: this.senderNodeId },
        recipient: { kind: 'node', id: childId },
        type: 'instruction',
        payload: { text: instruction, intent: 'steer' },
        correlationId: projection.runId,
        createdAt: new Date().toISOString(),
      })
      const delivered = await this.control.steer(this.workflowId, childId, instruction)
      if (delivered) {
        await this.orchestrator.acknowledgeMessage(this.workflowId, message.messageId, childId)
      }
      return {
        ok: true,
        summary: delivered
          ? 'Child steer delivered to the active Run.'
          : 'Child steer persisted for delivery when the Run starts.',
        output: { childId, delivered, messageId: message.messageId },
      }
    } catch (error) {
      return failed(errorCode(error, 'AGENT_STEER_FAILED'), 'Child steer failed')
    }
  }
}

function spawnProposal(input: Record<string, unknown>): DelegateProposalV1 {
  const reasons = Array.isArray(input.reasons)
    ? (input.reasons.map(String) as DelegateProposalV1['reasons'])
    : (['PARALLEL_EVIDENCE'] as const)
  return {
    schemaVersion: 1,
    proposalId: randomUUID(),
    profileRef: {
      id: AGENT_HARNESS_PROFILES.includes(String(input.profile) as never)
        ? String(input.profile)
        : 'worker',
      version: ACTIVE_BUILTIN_AGENT_PROFILE_VERSION,
    },
    objective: String(input.objective),
    inputRefs: [],
    grantRequest: {
      tools: strings(input.tools, ['*']),
      skills: strings(input.skills, ['*']),
      mcpServers: strings(input.mcpServers, ['*']),
      workspace:
        input.workspace === 'none' || input.workspace === 'write' ? input.workspace : 'read',
      network: input.network === true,
      mayDelegate: false,
    },
    assemblyRequest: parseAgentAssemblyRequestV1(input),
    // Autonomous Run Tree children inherit the parent/organization execution
    // policy. A model cannot reliably translate task difficulty into cumulative
    // Provider input+output tokens; exposing those numeric knobs caused normal
    // children to self-terminate before their first useful turn. Explicit
    // business Workflow tools retain per-node budget controls.
    budgetRequest: {},
    reasons,
  }
}

async function acknowledgeResults(
  orchestrator: WorkflowOrchestratorV1,
  workflowId: string,
  recipientNodeId: string,
  childIds: readonly string[],
): Promise<void> {
  const selected = new Set(childIds)
  const messages = await orchestrator.listMessages({
    workflowId,
    recipientNodeId,
    types: ['result', 'error'],
    limit: 500,
  })
  await Promise.all(
    messages.flatMap(({ messageId, payload }) => {
      const nodeId = Reflect.get(payload, 'nodeId')
      return typeof nodeId === 'string' && selected.has(nodeId)
        ? [orchestrator.acknowledgeMessage(workflowId, messageId, recipientNodeId)]
        : []
    }),
  )
}

function childResult(
  workflowId: string,
  mode: 'all' | 'any' | 'quorum',
  required: number,
  nodes: readonly WorkflowProjectionV1['nodes'][number][],
  ok: boolean,
): ToolResult {
  return {
    ok,
    summary: ok
      ? `Child wait satisfied (${mode}, ${required} required).`
      : `Child wait cannot be satisfied (${mode}, ${required} required).`,
    output: {
      workflowId,
      mode,
      required,
      children: nodes.map(projectChild),
    },
    ...(ok
      ? {}
      : {
          error: {
            code: 'AGENT_WAIT_UNREACHABLE',
            category: 'execution' as const,
            retryable: false,
          },
        }),
  }
}

function projectChild(node: WorkflowProjectionV1['nodes'][number]) {
  return {
    childId: node.nodeId,
    state: node.state,
    ...(node.resultRef === undefined ? {} : { resultRef: node.resultRef }),
    ...(node.errorCode === undefined ? {} : { errorCode: node.errorCode }),
  }
}

function strings(value: unknown, fallback: readonly string[] = []): string[] {
  return Array.isArray(value) ? value.map(String) : [...fallback]
}

function integer(value: unknown, minimum: number): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= minimum ? Number(value) : undefined
}

function boundedText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.slice(0, 1_024) : fallback
}

function tick(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, POLL_MS)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof Error && typeof Reflect.get(error, 'code') === 'string'
    ? Reflect.get(error, 'code')
    : fallback
}

function failed(code: string, summary: string): ToolResult {
  return {
    ok: false,
    summary: `${summary} (${code}).`,
    error: { code, category: 'execution', retryable: false },
  }
}
