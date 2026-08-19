import { readdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type { RuntimeTool, ToolRequest, ToolResult } from './types.js'

const MAX_RESULTS = 500

export class LsTool implements RuntimeTool {
  readonly definition = {
    name: 'ls',
    description: 'List one workspace directory with entry types.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'array',
      maxItems: MAX_RESULTS,
      items: {
        type: 'object',
        required: ['path', 'type'],
        properties: {
          path: { type: 'string' },
          type: { enum: ['file', 'directory', 'symlink', 'other'] },
        },
        additionalProperties: false,
      },
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
    const directory =
      request.resolvedTarget ??
      resolve(request.cwd, typeof request.input.path === 'string' ? request.input.path : '.')
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => !['.git', 'node_modules', '.praxis'].includes(entry.name))
      .slice(0, MAX_RESULTS)
      .map((entry) => ({
        path: relative(request.cwd, resolve(directory, entry.name)).split(sep).join('/'),
        type: entry.isFile()
          ? ('file' as const)
          : entry.isDirectory()
            ? ('directory' as const)
            : entry.isSymbolicLink()
              ? ('symlink' as const)
              : ('other' as const),
      }))
    return { ok: true, summary: `Listed ${entries.length} entries.`, output: entries }
  }
}
