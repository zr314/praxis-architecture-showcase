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
import {
  AGENT_ASSEMBLY_SCHEMA_PROPERTIES,
  AGENT_HARNESS_PROFILES,
  parseAgentAssemblyRequestV1,
} from './agentAssembly.js'
import type { WorkflowAgentWorkerPortV1 } from './agentDelegateTool.js'
import { DurableWorkflowSchedulerV1 } from './durableWorkflowScheduler.js'
import type { WorkflowOrchestratorV1 } from './workflowOrchestrator.js'

type ExpansionNode = Readonly<{
  id: string
  profile: string
  objective: string
  dependencies: readonly string[]
  conditions: readonly Readonly<{
    dependency: string
    operator: 'status_is' | 'exists' | 'eq' | 'in'
    pointer?: string
    value?: unknown
  }>[]
  workspace: 'none' | 'read' | 'write'
  tools: readonly string[]
  skills: readonly string[]
  mcpServers: readonly string[]
  network: boolean
  budgetRequest: AgentBudgetRequestV1
  inputRefs: readonly WorkflowArtifactRefV1[]
  assemblyRequest?: AgentAssemblyRequestV1
}>

/** Model-proposed bounded DAG. Runtime validates, persists, schedules and joins every node. */
export class WorkflowExpandToolV1 implements RuntimeTool {
  readonly definition = {
    name: 'workflow.expand',
    description:
      'Request a durable Child Agent DAG. Dependency-free nodes run in parallel; dependencies create serial stages and can express independent cross-review. Dependencies may name nodes in this call or exact successful internal node IDs returned by an earlier expansion, allowing replacement nodes to inherit persisted predecessor artifacts. Each node may request its own role, capabilities, model, reasoning, budget, result contract, and success criteria; Runtime authority remains final. A successful replacement may explicitly supersede terminal failed node IDs returned by an earlier failed expansion.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['nodes'],
      properties: {
        supersedes: {
          type: 'array',
          maxItems: 64,
          uniqueItems: true,
          description:
            'Exact internal node IDs from a prior failed workflow.expand supersedableNodeIds list. They are removed from the required graph only after this replacement graph succeeds.',
          items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$' },
        },
        quorum: {
          type: 'integer',
          minimum: 1,
          maximum: 64,
        },
        nodes: {
          type: 'array',
          minItems: 1,
          maxItems: 64,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'profile', 'objective', 'dependencies'],
            properties: {
              id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$' },
              profile: {
                enum: AGENT_HARNESS_PROFILES,
              },
              objective: { type: 'string', minLength: 1, maxLength: 16_384 },
              dependencies: {
                type: 'array',
                maxItems: 32,
                uniqueItems: true,
                description:
                  'Local node IDs from this call, or exact successful internal node IDs returned by an earlier workflow.expand call.',
                items: { type: 'string' },
              },
              inputRefs: {
                type: 'array',
                maxItems: 64,
                description:
                  'Explicit persisted artifacts already owned by the parent Run and admitted as Child inputs.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['artifactId', 'digest', 'mediaType'],
                  properties: {
                    artifactId: { type: 'string', pattern: '^artifact-[a-f0-9]{64}$' },
                    digest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
                    mediaType: { type: 'string', minLength: 1, maxLength: 256 },
                  },
                },
              },
              conditions: {
                type: 'array',
                maxItems: 32,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['dependency', 'operator'],
                  properties: {
                    dependency: { type: 'string' },
                    operator: { enum: ['status_is', 'exists', 'eq', 'in'] },
                    pointer: { type: 'string', pattern: '^/' },
                    value: {},
                  },
                },
              },
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
    const nodes = parseNodes(request.input.nodes)
    const supersedes = stringArray(request.input.supersedes, [])
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const current = await this.orchestrator.projection(this.workflowId)
    const reusableNodeIds = new Set(
      current.nodes.filter(({ state }) => state === 'succeeded').map(({ nodeId }) => nodeId),
    )
    if (
      byId.size !== nodes.length ||
      nodes.some(
        (node) =>
          node.dependencies.some((id) => !byId.has(id) && !reusableNodeIds.has(id)) ||
          new Set(node.conditions.map(({ dependency }) => dependency)).size !==
            node.conditions.length ||
          node.conditions.some(
            (condition) =>
              !node.dependencies.includes(condition.dependency) || !byId.has(condition.dependency),
          ),
      )
    ) {
      return invalid('WORKFLOW_GRAPH_REFERENCE_INVALID')
    }
    const expansionId = randomUUID()
    const join = parseJoin(request.input.quorum, nodes.length)
    if (join === null) return invalid('WORKFLOW_JOIN_INVALID')
    try {
      const graph = await this.orchestrator.admitAgentGraph(
        this.workflowId,
        'root',
        expansionId,
        nodes.map((node) => ({
          key: node.id,
          profileId: node.profile,
          objective: node.objective,
          dependencies: node.dependencies.filter((dependency) => byId.has(dependency)),
          dependsOnNodeIds: node.dependencies.filter((dependency) => !byId.has(dependency)),
          inputRefs: node.inputRefs,
          conditions: node.conditions,
          grantRequest: {
            tools: node.tools,
            skills: node.skills,
            mcpServers: node.mcpServers,
            workspace: node.workspace,
            network: node.network,
            mayDelegate: false,
          },
          budgetRequest: node.budgetRequest,
          assemblyRequest: node.assemblyRequest,
        })),
        join,
      )
      const execution = await new DurableWorkflowSchedulerV1(
        this.orchestrator,
        this.worker,
        this.onProjection,
      ).executeAgentGraph(graph, request.signal)
      let projection = await this.orchestrator.projection(this.workflowId)
      const graphNodeIds = Object.fromEntries(graph.nodes.map(({ key, nodeId }) => [key, nodeId]))
      const graphIds = [
        ...graph.nodes.map(({ nodeId }) => nodeId),
        ...(graph.joinNodeId === undefined ? [] : [graph.joinNodeId]),
      ]
      const supersedableNodeIds = graphIds.filter((nodeId) => {
        const state = projection.nodes.find((node) => node.nodeId === nodeId)?.state
        return state === 'failed' || state === 'cancelled'
      })
      let supersededNodeIds: readonly string[] = []
      if (execution.ok && supersedes.length > 0) {
        const replacementNodeIds = graphIds.filter(
          (nodeId) =>
            projection.nodes.find((node) => node.nodeId === nodeId)?.state === 'succeeded',
        )
        projection = await this.orchestrator.supersedeFailedNodes(
          this.workflowId,
          supersedes,
          replacementNodeIds,
          expansionId,
        )
        supersededNodeIds = supersedes
        this.onProjection?.(projection)
      }
      return {
        ok: execution.ok,
        summary: execution.ok
          ? `Completed ${nodes.length} durable workflow node(s).`
          : workflowFailureSummary(execution.errorCode, execution.results),
        output: {
          graph: {
            nodeIds: graphNodeIds,
            ...(graph.joinNodeId === undefined ? {} : { joinNodeId: graph.joinNodeId }),
            supersedableNodeIds,
            supersededNodeIds,
          },
          results: execution.results,
          evidence: execution.evidence,
        },
        error: execution.ok
          ? undefined
          : {
              code: execution.errorCode ?? 'WORKFLOW_NODE_FAILED',
              category: 'execution',
              retryable: false,
            },
      }
    } catch (error) {
      const code =
        error instanceof Error && typeof Reflect.get(error, 'code') === 'string'
          ? Reflect.get(error, 'code')
          : 'WORKFLOW_EXPANSION_FAILED'
      return invalid(code)
    }
  }
}

function workflowFailureSummary(
  errorCode: string | undefined,
  results: Readonly<Record<string, { ok: boolean; errorCode?: string }>>,
): string {
  const failures = Object.entries(results)
    .filter(([, result]) => !result.ok)
    .map(([node, result]) => `${node}:${result.errorCode ?? 'UNKNOWN'}`)
  const detail = failures.length === 0 ? '' : ` Node failures: ${failures.join(', ')}.`
  return `Durable workflow graph stopped (${errorCode ?? 'WORKFLOW_NODE_FAILED'}).${detail}`
}

function parseJoin(
  value: unknown,
  nodeCount: number,
): { kind: 'any' } | { kind: 'quorum'; minimum: number } | undefined | null {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > nodeCount) return null
  if (Number(value) === 1) return { kind: 'any' }
  return { kind: 'quorum', minimum: Number(value) }
}

function parseNodes(value: unknown): ExpansionNode[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const node = item as Record<string, unknown>
    return {
      id: String(node.id),
      profile: String(node.profile),
      objective: String(node.objective),
      dependencies: Array.isArray(node.dependencies) ? node.dependencies.map(String) : [],
      conditions: parseConditions(node.conditions),
      workspace: node.workspace === 'write' || node.workspace === 'none' ? node.workspace : 'read',
      tools: stringArray(node.tools, ['*']),
      skills: stringArray(node.skills, ['*']),
      mcpServers: stringArray(node.mcpServers, ['*']),
      network: node.network === true,
      budgetRequest: {
        maxWallClockMs: integer(node.maxWallClockMs),
        maxTokens: integer(node.maxTokens),
        maxToolCalls: integer(node.maxToolCalls),
        maxTurns: integer(node.maxTurns),
      },
      inputRefs: parseInputRefs(node.inputRefs),
      assemblyRequest: parseAgentAssemblyRequestV1(node),
    }
  })
}

function parseInputRefs(value: unknown): readonly WorkflowArtifactRefV1[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return []
    const ref = candidate as Record<string, unknown>
    return typeof ref.artifactId === 'string' &&
      /^artifact-[a-f0-9]{64}$/u.test(ref.artifactId) &&
      typeof ref.digest === 'string' &&
      /^sha256:[a-f0-9]{64}$/u.test(ref.digest) &&
      typeof ref.mediaType === 'string' &&
      ref.mediaType.length > 0
      ? [
          {
            artifactId: ref.artifactId,
            digest: ref.digest as `sha256:${string}`,
            mediaType: ref.mediaType,
          },
        ]
      : []
  })
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) ? value.map(String) : fallback
}

function integer(value: unknown, minimum = 1): number | undefined {
  return Number.isSafeInteger(value) ? Math.max(minimum, Number(value)) : undefined
}

function parseConditions(value: unknown): ExpansionNode['conditions'] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const condition = item as Record<string, unknown>
    const operator = String(condition.operator)
    return {
      dependency: String(condition.dependency),
      operator: ['status_is', 'exists', 'eq', 'in'].includes(operator)
        ? (operator as 'status_is' | 'exists' | 'eq' | 'in')
        : 'eq',
      ...(typeof condition.pointer === 'string' ? { pointer: condition.pointer } : {}),
      ...(Object.hasOwn(condition, 'value') ? { value: condition.value } : {}),
    }
  })
}

function invalid(code: string): ToolResult {
  return {
    ok: false,
    summary: `Workflow expansion rejected (${code}).`,
    error: { code, category: 'validation', retryable: false },
  }
}
