import { randomUUID } from 'node:crypto'
import type {
  AgentAssemblyRequestV1,
  AgentBudgetRequestV1,
  RuntimeTool,
  ToolRequest,
  ToolResult,
  WorkflowArtifactRefV1,
  WorkflowProjectionV1,
} from '@praxis/core-sdk'
import { LONG_LIVED_EXECUTION_POLICY_V1 } from '../longLivedExecutionPolicy.js'
import {
  AGENT_ASSEMBLY_SCHEMA_PROPERTIES,
  AGENT_HARNESS_PROFILES,
  parseAgentAssemblyRequestV1,
} from './agentAssembly.js'
import type { WorkflowAgentWorkerPortV1, WorkflowAgentWorkerResultV1 } from './agentDelegateTool.js'
import { DurableWorkflowSchedulerV1 } from './durableWorkflowScheduler.js'
import type { WorkflowOrchestratorV1 } from './workflowOrchestrator.js'

type LoopOperator = 'exists' | 'eq' | 'in'

/**
 * Bounded iteration is represented as acyclic graph expansion. Every iteration
 * gets a new Node, Attempt and graph revision; the journal never contains a
 * cyclic edge and the model cannot silently exceed maxIterations.
 */
export class WorkflowLoopToolV1 implements RuntimeTool {
  readonly definition = {
    name: 'workflow.loop',
    description:
      'Run a bounded iterative agent workflow. Each iteration is a new durable graph node and receives the previous result as evidence. Runtime evaluates the deterministic until condition and never exceeds maxIterations.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['profile', 'objective', 'maxIterations', 'until'],
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
        maxIterations: {
          type: 'integer',
          minimum: 1,
          maximum: LONG_LIVED_EXECUTION_POLICY_V1.maxLoopIterations,
        },
        until: {
          type: 'object',
          additionalProperties: false,
          required: ['operator', 'pointer'],
          properties: {
            operator: { enum: ['exists', 'eq', 'in'] },
            pointer: { type: 'string', pattern: '^/' },
            value: {},
          },
        },
      },
    },
    outputSchema: { type: 'object' },
    execution: {
      sideEffect: 'process' as const,
      target: { kind: 'workspace' as const },
      parallelSafe: false,
      conflictScope: 'workspace' as const,
      maxInlineBytes: 256 * 1024,
    },
  }

  constructor(
    private readonly orchestrator: WorkflowOrchestratorV1,
    private readonly worker: WorkflowAgentWorkerPortV1,
    private readonly workflowId: string,
    private readonly onProjection?: (projection: WorkflowProjectionV1) => void,
  ) {}

  async execute(request: ToolRequest): Promise<ToolResult> {
    const parsed = parseInput(request.input)
    if (parsed === undefined) return invalid('WORKFLOW_LOOP_ARGUMENTS_INVALID')

    const loopId = randomUUID()
    let previousNodeId: string | undefined
    let previousRef: WorkflowArtifactRefV1 | undefined
    let previousResult: WorkflowAgentWorkerResultV1 | undefined
    const iterations: Array<Readonly<Record<string, unknown>>> = []

    try {
      for (let iteration = 1; iteration <= parsed.maxIterations; iteration += 1) {
        const graph = await this.orchestrator.admitAgentGraph(
          this.workflowId,
          'root',
          `${loopId}-${iteration}`,
          [
            {
              key: `iteration-${iteration}`,
              profileId: parsed.profile,
              objective: iterationObjective(parsed.objective, iteration, previousResult),
              dependencies: [],
              ...(previousNodeId === undefined ? {} : { dependsOnNodeIds: [previousNodeId] }),
              ...(previousRef === undefined ? {} : { inputRefs: [previousRef] }),
              maxIterations: parsed.maxIterations,
              grantRequest: {
                tools: parsed.tools,
                skills: parsed.skills,
                mcpServers: parsed.mcpServers,
                workspace: parsed.workspace,
                network: parsed.network,
                mayDelegate: false,
              },
              budgetRequest: parsed.budgetRequest,
              assemblyRequest: parsed.assemblyRequest,
            },
          ],
        )
        const admitted = graph.nodes[0]!
        const execution = await new DurableWorkflowSchedulerV1(
          this.orchestrator,
          this.worker,
          this.onProjection,
        ).executeAgentGraph(graph, request.signal)
        const result = execution.results[admitted.key]
        const evidence = execution.evidence[admitted.key]
        iterations.push({
          iteration,
          nodeId: admitted.nodeId,
          ok: execution.ok,
          result: result?.output,
          evidence,
        })
        if (!execution.ok || result === undefined) {
          return {
            ok: false,
            summary: `Workflow loop stopped at iteration ${iteration} (${execution.errorCode}).`,
            output: { loopId, iterations },
            error: {
              code: execution.errorCode ?? 'WORKFLOW_LOOP_ITERATION_FAILED',
              category: 'execution',
              retryable: result?.retryable ?? false,
            },
          }
        }
        if (matches(result.output, parsed.until)) {
          return {
            ok: true,
            summary: `Workflow loop satisfied its exit condition after ${iteration} iteration(s).`,
            output: { loopId, completedIterations: iteration, result: result.output, iterations },
          }
        }
        previousNodeId = admitted.nodeId
        previousRef = evidence
        previousResult = result
      }
      return {
        ok: false,
        summary: `Workflow loop reached maxIterations (${parsed.maxIterations}).`,
        output: { loopId, completedIterations: parsed.maxIterations, iterations },
        error: {
          code: 'WORKFLOW_LOOP_LIMIT_REACHED',
          category: 'execution',
          retryable: false,
        },
      }
    } catch (error) {
      const code =
        error instanceof Error && typeof Reflect.get(error, 'code') === 'string'
          ? Reflect.get(error, 'code')
          : 'WORKFLOW_LOOP_FAILED'
      return invalid(code)
    }
  }
}

function parseInput(input: Record<string, unknown>):
  | Readonly<{
      profile: string
      objective: string
      workspace: 'none' | 'read' | 'write'
      maxIterations: number
      tools: readonly string[]
      skills: readonly string[]
      mcpServers: readonly string[]
      network: boolean
      budgetRequest: AgentBudgetRequestV1
      assemblyRequest?: AgentAssemblyRequestV1
      until: Readonly<{ operator: LoopOperator; pointer: string; value?: unknown }>
    }>
  | undefined {
  const until = input.until as Record<string, unknown> | undefined
  const maxIterations = Number(input.maxIterations)
  const operator = String(until?.operator) as LoopOperator
  if (
    !Number.isSafeInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > LONG_LIVED_EXECUTION_POLICY_V1.maxLoopIterations ||
    !['exists', 'eq', 'in'].includes(operator) ||
    typeof until?.pointer !== 'string' ||
    !until.pointer.startsWith('/')
  )
    return undefined
  return {
    profile: String(input.profile),
    objective: String(input.objective),
    workspace: input.workspace === 'write' || input.workspace === 'none' ? input.workspace : 'read',
    maxIterations,
    tools: stringArray(input.tools, ['*']),
    skills: stringArray(input.skills, ['*']),
    mcpServers: stringArray(input.mcpServers, ['*']),
    network: input.network === true,
    budgetRequest: {
      maxWallClockMs: integer(input.maxWallClockMs),
      maxTokens: integer(input.maxTokens),
      maxToolCalls: integer(input.maxToolCalls),
      maxTurns: integer(input.maxTurns),
    },
    assemblyRequest: parseAgentAssemblyRequestV1(input),
    until: {
      operator,
      pointer: until.pointer,
      ...(Object.hasOwn(until, 'value') ? { value: until.value } : {}),
    },
  }
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) ? value.map(String) : fallback
}

function integer(value: unknown, minimum = 1): number | undefined {
  return Number.isSafeInteger(value) ? Math.max(minimum, Number(value)) : undefined
}

function iterationObjective(
  objective: string,
  iteration: number,
  previous: WorkflowAgentWorkerResultV1 | undefined,
): string {
  if (previous === undefined) return `${objective}\n\nThis is bounded iteration ${iteration}.`
  const prior = JSON.stringify({ summary: previous.summary, output: previous.output })
  return `${objective}\n\nThis is bounded iteration ${iteration}. Previous iteration result:\n${prior.slice(0, 12_000)}`
}

function matches(
  output: Readonly<Record<string, unknown>> | undefined,
  condition: Readonly<{ operator: LoopOperator; pointer: string; value?: unknown }>,
): boolean {
  const value = jsonPointer(output, condition.pointer)
  if (condition.operator === 'exists') return value !== undefined
  if (condition.operator === 'eq') return deepEqual(value, condition.value)
  return Array.isArray(condition.value) && condition.value.some((item) => deepEqual(value, item))
}

function jsonPointer(value: unknown, pointer: string): unknown {
  let current = value
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key))
      return undefined
    current = Reflect.get(current, key)
  }
  return current
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function invalid(code: string): ToolResult {
  return {
    ok: false,
    summary: `Workflow loop rejected (${code}).`,
    error: { code, category: 'validation', retryable: false },
  }
}
