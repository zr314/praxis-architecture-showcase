import type { RuntimeTool, ToolRequest, ToolResult, WorkflowProjectionV1 } from '@praxis/core-sdk'
import type { WorkflowOrchestratorV1 } from './workflowOrchestrator.js'

const POLL_MS = 250

/** Compact model surface for both durable wait-node kinds. */
export class WorkflowWaitToolV1 implements RuntimeTool {
  readonly definition = {
    name: 'workflow.wait',
    description:
      'Wait durably for a human decision or a timer. Runtime persists the wait as a Node and resumes it through the Workflow control plane.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'purpose'],
      properties: {
        kind: { enum: ['human', 'timer'] },
        purpose: { type: 'string', minLength: 1, maxLength: 8_192 },
        context: { type: 'object' },
        expiresAt: { type: 'string' },
        delayMs: { type: 'integer', minimum: 1, maximum: 2_592_000_000 },
        fireAt: { type: 'string' },
      },
    },
    outputSchema: { type: 'object' },
    execution: {
      sideEffect: 'process' as const,
      target: { kind: 'none' as const },
      parallelSafe: false,
      conflictScope: 'global' as const,
      maxInlineBytes: 64 * 1024,
    },
  }

  constructor(
    private readonly orchestrator: WorkflowOrchestratorV1,
    private readonly workflowId: string,
    private readonly onProjection?: (projection: WorkflowProjectionV1) => void,
  ) {}

  execute(request: ToolRequest): Promise<ToolResult> {
    if (request.input.kind === 'human') {
      return new WorkflowHumanTaskToolV1(
        this.orchestrator,
        this.workflowId,
        this.onProjection,
      ).execute({
        ...request,
        name: 'workflow.human_task',
        input: { ...request.input, question: request.input.purpose },
      })
    }
    if (request.input.kind === 'timer') {
      return new WorkflowTimerToolV1(this.orchestrator, this.workflowId, this.onProjection).execute(
        request,
      )
    }
    return Promise.resolve(failed('WORKFLOW_WAIT_KIND_INVALID'))
  }
}

/** Durable human decision point. The Runtime remains responsive to control RPC while this Tool waits. */
export class WorkflowHumanTaskToolV1 implements RuntimeTool {
  readonly definition = {
    name: 'workflow.human_task',
    description:
      'Pause the durable Workflow for an explicit human decision. Use only when authority, missing information, or approval genuinely requires a person. The task survives Runtime restart and is resolved through Workflow control APIs.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: { type: 'string', minLength: 1, maxLength: 8_192 },
        context: { type: 'object' },
        expiresAt: { type: 'string' },
      },
    },
    outputSchema: { type: 'object' },
    execution: {
      sideEffect: 'process' as const,
      target: { kind: 'none' as const },
      parallelSafe: false,
      conflictScope: 'global' as const,
      maxInlineBytes: 64 * 1024,
    },
  }

  constructor(
    private readonly orchestrator: WorkflowOrchestratorV1,
    private readonly workflowId: string,
    private readonly onProjection?: (projection: WorkflowProjectionV1) => void,
  ) {}

  async execute(request: ToolRequest): Promise<ToolResult> {
    const question = String(request.input.question)
    const expiresAt = validFutureTimestamp(request.input.expiresAt)
    try {
      const admitted = await this.orchestrator.admitHumanTask(
        this.workflowId,
        {
          question,
          ...(isRecord(request.input.context) ? { context: request.input.context } : {}),
        },
        expiresAt,
      )
      this.onProjection?.(admitted.projection)
      while (!request.signal.aborted) {
        const task = (await this.orchestrator.listHumanTasks(this.workflowId)).find(
          ({ humanTaskId }) => humanTaskId === admitted.humanTask.humanTaskId,
        )
        if (task === undefined) return failed('WORKFLOW_HUMAN_TASK_NOT_FOUND')
        if (task.state !== 'waiting') {
          const projection = await this.orchestrator.get(this.workflowId)
          this.onProjection?.(projection)
          return {
            ok: task.state === 'allowed',
            summary: `HumanTask ${task.state}.`,
            output: {
              workflowId: this.workflowId,
              nodeId: admitted.nodeId,
              humanTaskId: task.humanTaskId,
              decision: task.state,
              resolution: task.resolution,
            },
            error:
              task.state === 'allowed'
                ? undefined
                : {
                    code: `WORKFLOW_HUMAN_TASK_${task.state.toUpperCase()}`,
                    category: 'permission',
                    retryable: false,
                  },
          }
        }
        if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.now()) {
          await this.orchestrator.resolveHumanTask(task.humanTaskId, 'expired', {
            reason: 'deadline',
          })
          continue
        }
        await tick(request.signal)
      }
      await this.orchestrator
        .resolveHumanTask(admitted.humanTask.humanTaskId, 'cancelled', {
          reason: 'parent_cancelled',
        })
        .catch(() => undefined)
      return failed('WORKFLOW_HUMAN_TASK_CANCELLED')
    } catch (error) {
      return failed(errorCode(error, 'WORKFLOW_HUMAN_TASK_FAILED'))
    }
  }
}

/** Durable timer point represented by a timer Node and idempotent timer row. */
export class WorkflowTimerToolV1 implements RuntimeTool {
  readonly definition = {
    name: 'workflow.timer',
    description:
      'Pause the durable Workflow until a time or bounded delay. Runtime stores the Timer and marks its Node succeeded exactly once when due.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['purpose'],
      properties: {
        purpose: { type: 'string', minLength: 1, maxLength: 4_096 },
        delayMs: { type: 'integer', minimum: 1, maximum: 2_592_000_000 },
        fireAt: { type: 'string' },
      },
    },
    outputSchema: { type: 'object' },
    execution: {
      sideEffect: 'process' as const,
      target: { kind: 'none' as const },
      parallelSafe: false,
      conflictScope: 'global' as const,
      maxInlineBytes: 64 * 1024,
    },
  }

  constructor(
    private readonly orchestrator: WorkflowOrchestratorV1,
    private readonly workflowId: string,
    private readonly onProjection?: (projection: WorkflowProjectionV1) => void,
  ) {}

  async execute(request: ToolRequest): Promise<ToolResult> {
    const fireAt = requestedFireAt(request.input)
    if (fireAt === undefined) return failed('WORKFLOW_TIMER_ARGUMENTS_INVALID')
    try {
      const admitted = await this.orchestrator.admitTimer(this.workflowId, fireAt, {
        purpose: String(request.input.purpose),
      })
      this.onProjection?.(admitted.projection)
      while (!request.signal.aborted) {
        await this.orchestrator.fireDueTimers()
        const projection = await this.orchestrator.get(this.workflowId)
        const node = projection.nodes.find(({ nodeId }) => nodeId === admitted.nodeId)
        if (node?.state === 'succeeded') {
          this.onProjection?.(projection)
          return {
            ok: true,
            summary: `Workflow timer fired at ${fireAt}.`,
            output: {
              workflowId: this.workflowId,
              nodeId: admitted.nodeId,
              timerId: admitted.timer.timerId,
              fireAt,
            },
          }
        }
        if (node !== undefined && ['failed', 'cancelled'].includes(node.state))
          return failed(node.errorCode ?? 'WORKFLOW_TIMER_FAILED')
        await tick(request.signal)
      }
      return failed('WORKFLOW_TIMER_CANCELLED')
    } catch (error) {
      return failed(errorCode(error, 'WORKFLOW_TIMER_FAILED'))
    }
  }
}

function requestedFireAt(input: Record<string, unknown>): string | undefined {
  if (typeof input.fireAt === 'string' && Number.isFinite(Date.parse(input.fireAt)))
    return new Date(input.fireAt).toISOString()
  if (Number.isSafeInteger(input.delayMs) && Number(input.delayMs) > 0)
    return new Date(Date.now() + Number(input.delayMs)).toISOString()
  return undefined
}

function validFutureTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    summary: `Workflow wait stopped (${code}).`,
    error: { code, category: 'execution', retryable: false },
  }
}
