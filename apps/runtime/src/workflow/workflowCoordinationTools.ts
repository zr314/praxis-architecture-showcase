import type {
  RuntimeTool,
  ToolRequest,
  ToolResult,
  WorkflowMessageTypeV1,
  WorkflowProjectionV1,
} from '@praxis/core-sdk'
import type { WorkflowOrchestratorV1 } from './workflowOrchestrator.js'

const POLL_MS = 250
const TERMINAL_NODE_STATES = new Set([
  'unknown',
  'skipped',
  'succeeded',
  'failed',
  'cancelled',
  'manual_intervention',
])

/** Reads the durable Root mailbox without exposing Child transcripts or reasoning. */
export class WorkflowInboxToolV1 implements RuntimeTool {
  readonly definition = {
    name: 'workflow.inbox',
    description:
      'Inspect typed, durable Child coordination messages and current node status. Returns bounded result/error/milestone metadata and Artifact references, never raw Child reasoning or transcripts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        afterSequence: { type: 'integer', minimum: 0 },
        types: {
          type: 'array',
          uniqueItems: true,
          maxItems: 8,
          items: {
            enum: [
              'instruction',
              'progress',
              'milestone',
              'question',
              'answer',
              'result',
              'error',
              'control',
            ],
          },
        },
        acknowledge: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
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
  ) {}

  async execute(request: ToolRequest): Promise<ToolResult> {
    try {
      const afterSequence = integer(request.input.afterSequence, 0) ?? 0
      const types = messageTypes(request.input.types)
      const messages = await this.orchestrator.listMessages({
        workflowId: this.workflowId,
        recipientNodeId: 'root',
        afterSequence,
        ...(types === undefined ? {} : { types }),
        limit: integer(request.input.limit, 1) ?? 100,
      })
      const projection = await this.orchestrator.projection(this.workflowId)
      const throughSequence = messages.at(-1)?.sequence ?? afterSequence
      if (request.input.acknowledge === true && throughSequence > afterSequence) {
        await Promise.all(
          messages.map(({ messageId }) =>
            this.orchestrator.acknowledgeMessage(this.workflowId, messageId, 'root'),
          ),
        )
      }
      return {
        ok: true,
        summary:
          messages.length === 0
            ? 'Workflow inbox has no matching unread messages.'
            : `Workflow inbox returned ${messages.length} typed message(s).`,
        output: {
          workflowId: this.workflowId,
          fromSequence: afterSequence + 1,
          throughSequence,
          messages,
          nodes: projection.nodes
            .filter(({ nodeId }) => nodeId !== 'root')
            .map(({ nodeId, state, resultRef, errorCode }) => ({
              nodeId,
              state,
              ...(resultRef === undefined ? {} : { resultRef }),
              ...(errorCode === undefined ? {} : { errorCode }),
            })),
        },
      }
    } catch (error) {
      return failed(errorCode(error, 'WORKFLOW_INBOX_FAILED'))
    }
  }
}

/** Root-chosen synchronous join for a graph previously spawned with rootAction=continue. */
export class WorkflowJoinToolV1 implements RuntimeTool {
  readonly definition = {
    name: 'workflow.join',
    description:
      'Wait for selected background Workflow nodes after Root finishes independent work. Root explicitly chooses all, any, or quorum; Runtime remains responsive and returns only terminal status plus durable evidence references.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['nodeIds'],
      properties: {
        nodeIds: {
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
    private readonly onProjection?: (projection: WorkflowProjectionV1) => void,
  ) {}

  async execute(request: ToolRequest): Promise<ToolResult> {
    const nodeIds = stringArray(request.input.nodeIds)
    const mode =
      request.input.mode === 'any' || request.input.mode === 'quorum' ? request.input.mode : 'all'
    const minimum = mode === 'quorum' ? integer(request.input.minimum, 1) : undefined
    if (
      nodeIds.length === 0 ||
      (mode === 'quorum' && (minimum === undefined || minimum > nodeIds.length))
    )
      return failed('WORKFLOW_JOIN_ARGUMENTS_INVALID')
    try {
      while (!request.signal.aborted) {
        const projection = await this.orchestrator.reconcileWorkflow(this.workflowId)
        this.onProjection?.(projection)
        const selected = nodeIds.map((nodeId) =>
          projection.nodes.find((node) => node.nodeId === nodeId),
        )
        if (selected.some((node) => node === undefined))
          return failed('WORKFLOW_JOIN_NODE_NOT_FOUND')
        const nodes = selected as NonNullable<(typeof selected)[number]>[]
        const succeeded = nodes.filter(({ state }) => state === 'succeeded').length
        const terminal = nodes.filter(({ state }) => TERMINAL_NODE_STATES.has(state)).length
        const required = mode === 'all' ? nodeIds.length : mode === 'any' ? 1 : minimum!
        if (succeeded >= required) {
          await this.acknowledgeNodeResults(nodeIds)
          return joined(this.workflowId, mode, required, nodes, true)
        }
        if (terminal === nodes.length || succeeded + (nodes.length - terminal) < required) {
          await this.acknowledgeNodeResults(nodeIds)
          return joined(this.workflowId, mode, required, nodes, false)
        }
        await tick(request.signal)
      }
      return failed('WORKFLOW_JOIN_CANCELLED')
    } catch (error) {
      return failed(errorCode(error, 'WORKFLOW_JOIN_FAILED'))
    }
  }

  private async acknowledgeNodeResults(nodeIds: readonly string[]): Promise<void> {
    const selected = new Set(nodeIds)
    const messages = await this.orchestrator.listMessages({
      workflowId: this.workflowId,
      recipientNodeId: 'root',
      types: ['result', 'error'],
      limit: 500,
    })
    await Promise.all(
      messages.flatMap(({ messageId, payload }) => {
        const nodeId = Reflect.get(payload, 'nodeId')
        return typeof nodeId === 'string' && selected.has(nodeId)
          ? [this.orchestrator.acknowledgeMessage(this.workflowId, messageId, 'root')]
          : []
      }),
    )
  }
}

function joined(
  workflowId: string,
  mode: 'all' | 'any' | 'quorum',
  required: number,
  nodes: readonly WorkflowProjectionV1['nodes'][number][],
  ok: boolean,
): ToolResult {
  return {
    ok,
    summary: ok
      ? `Workflow join satisfied (${mode}, ${required} required).`
      : `Workflow join cannot be satisfied (${mode}, ${required} required).`,
    output: {
      workflowId,
      mode,
      required,
      nodes: nodes.map(({ nodeId, state, resultRef, errorCode }) => ({
        nodeId,
        state,
        ...(resultRef === undefined ? {} : { resultRef }),
        ...(errorCode === undefined ? {} : { errorCode }),
      })),
      evidence: Object.fromEntries(
        nodes.flatMap(({ nodeId, resultRef }) =>
          resultRef === undefined ? [] : [[nodeId, resultRef]],
        ),
      ),
    },
    ...(ok
      ? {}
      : {
          error: {
            code: 'WORKFLOW_JOIN_UNREACHABLE',
            category: 'execution' as const,
            retryable: false,
          },
        }),
  }
}

function messageTypes(value: unknown): readonly WorkflowMessageTypeV1[] | undefined {
  return Array.isArray(value) ? (value.map(String) as WorkflowMessageTypeV1[]) : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function integer(value: unknown, minimum: number): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= minimum ? Number(value) : undefined
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

function failed(code: string): ToolResult {
  return {
    ok: false,
    summary: `Workflow coordination stopped (${code}).`,
    error: { code, category: 'execution', retryable: false },
  }
}
