import type { RuntimeTool, ToolRequest, ToolResult } from '@praxis/core-sdk'

export const CHILD_RESULT_SUBMISSION_TOOL_NAME = 'praxis_submit_child_result'

/**
 * Runtime-owned commit point for a Child result. Tool-call arguments give every
 * Provider a grammar-constrained JSON transport even when native json_schema is
 * unavailable. The parent still validates the signed ContextPacket contract.
 */
export class ChildResultSubmissionToolV1 implements RuntimeTool {
  readonly definition
  readonly #criterionIds: ReadonlySet<string>

  constructor(schema: Readonly<Record<string, unknown>>, criterionIds: readonly string[]) {
    this.#criterionIds = new Set(criterionIds)
    this.definition = {
      name: CHILD_RESULT_SUBMISSION_TOOL_NAME,
      description:
        'Commit the final Child result. Call exactly once after all work is complete. The arguments must be the complete result envelope from the signed ContextPacket outputSchema; do not print that envelope as prose.',
      parameters: structuredClone(schema),
      outputSchema: structuredClone(schema),
      execution: {
        sideEffect: 'none' as const,
        target: { kind: 'none' as const },
        parallelSafe: false,
        conflictScope: 'global' as const,
        maxInlineBytes: 1024 * 1024,
      },
    }
  }

  async execute(request: ToolRequest): Promise<ToolResult> {
    const criteria = request.input.criteria
    const submittedIds = Array.isArray(criteria)
      ? criteria.flatMap((candidate) =>
          isRecord(candidate) && typeof candidate.id === 'string' ? [candidate.id] : [],
        )
      : []
    if (
      submittedIds.length !== this.#criterionIds.size ||
      new Set(submittedIds).size !== this.#criterionIds.size ||
      submittedIds.some((id) => !this.#criterionIds.has(id))
    ) {
      return {
        ok: false,
        summary:
          'The result must contain exactly one criteria entry for every signed success-criterion ID.',
        error: { code: 'CHILD_RESULT_CRITERIA_INVALID', category: 'validation', retryable: true },
      }
    }
    return {
      ok: true,
      summary: 'The complete Child result was validated and committed.',
      output: structuredClone(request.input),
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
