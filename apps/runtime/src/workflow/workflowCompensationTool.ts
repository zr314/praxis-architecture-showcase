import type { RuntimeTool, ToolRequest, ToolResult, WorkflowProjectionV1 } from '@praxis/core-sdk'
import type { WorkflowOrchestratorV1 } from './workflowOrchestrator.js'

/** Links two already-durable external receipts; it never claims an effect was undone without evidence. */
export class WorkflowCompensationToolV1 implements RuntimeTool {
  readonly definition = {
    name: 'workflow.compensate',
    description:
      'Mark an external effect as compensated only after a compensating MCP/process/API Tool succeeded and produced its own durable receipt.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sourceReceiptArtifactId', 'compensationReceiptArtifactId'],
      properties: {
        sourceReceiptArtifactId: { type: 'string', minLength: 1, maxLength: 128 },
        compensationReceiptArtifactId: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
    outputSchema: { type: 'object' },
    execution: {
      sideEffect: 'none' as const,
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
    try {
      const receipt = await this.orchestrator.markEffectCompensated(
        this.workflowId,
        String(request.input.sourceReceiptArtifactId),
        String(request.input.compensationReceiptArtifactId),
      )
      const projection = await this.orchestrator.get(this.workflowId)
      this.onProjection?.(projection)
      return {
        ok: true,
        summary: `Effect receipt ${receipt.receiptId} is compensated.`,
        output: {
          receiptId: receipt.receiptId,
          state: receipt.state,
          compensationReceipt: receipt.compensationReceiptRef,
        },
      }
    } catch (error) {
      const code =
        error instanceof Error && typeof Reflect.get(error, 'code') === 'string'
          ? Reflect.get(error, 'code')
          : 'WORKFLOW_COMPENSATION_FAILED'
      return {
        ok: false,
        summary: `Workflow compensation rejected (${code}).`,
        error: { code, category: 'validation', retryable: false },
      }
    }
  }
}
