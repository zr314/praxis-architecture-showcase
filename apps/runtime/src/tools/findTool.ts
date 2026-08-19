import type { RuntimeTool, ToolRequest, ToolResult } from './types.js'
import { globPattern, walkFiles } from './fileWalker.js'

const MAX_RESULTS = 500

export class FindTool implements RuntimeTool {
  readonly definition = {
    name: 'find',
    description: 'Find workspace files recursively with consistent ignore rules.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', minLength: 1 },
        path: { type: 'string' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'array',
      maxItems: MAX_RESULTS,
      items: { type: 'string' },
    },
    execution: {
      sideEffect: 'read',
      target: { kind: 'input_path', field: 'path' },
      parallelSafe: true,
      conflictScope: 'target',
      maxInlineBytes: 65_536,
    },
  } as const

  async execute(request: ToolRequest): Promise<ToolResult> {
    const matcher = globPattern(String(request.input.pattern))
    const files = (
      await walkFiles({
        root: request.cwd,
        start:
          request.resolvedTarget ??
          (typeof request.input.path === 'string' ? request.input.path : undefined),
        maximum: MAX_RESULTS,
        signal: request.signal,
      })
    ).filter((path) => matcher.test(path))
    return { ok: true, summary: `Found ${files.length} files.`, output: files }
  }
}
