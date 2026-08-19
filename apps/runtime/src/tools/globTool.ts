import { readdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type { RuntimeTool, ToolRequest, ToolResult } from './types.js'

const MAX_RESULTS = 200

export class GlobTool implements RuntimeTool {
  readonly definition = {
    name: 'glob',
    description: 'List workspace files matching a glob pattern.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'array',
      items: { type: 'string' },
      maxItems: MAX_RESULTS,
    },
    execution: {
      sideEffect: 'read',
      target: { kind: 'workspace' },
      parallelSafe: true,
      conflictScope: 'workspace',
      maxInlineBytes: 65_536,
    },
  } as const

  async execute(request: ToolRequest): Promise<ToolResult> {
    const pattern = requirePattern(request.input)
    const matcher = globToRegExp(pattern)
    const files: string[] = []
    await walk(request.cwd, request.cwd, files, matcher, request.signal)
    return { ok: true, summary: `Matched ${files.length} files.`, output: files }
  }
}

async function walk(
  root: string,
  directory: string,
  files: string[],
  matcher: RegExp,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || files.length >= MAX_RESULTS) return
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (signal.aborted || files.length >= MAX_RESULTS) return
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.praxis') continue
    const fullPath = resolve(directory, entry.name)
    if (entry.isDirectory()) await walk(root, fullPath, files, matcher, signal)
    else if (entry.isFile()) {
      const relativePath = relative(root, fullPath).split(sep).join('/')
      if (matcher.test(relativePath)) files.push(relativePath)
    }
  }
}

function globToRegExp(pattern: string): RegExp {
  if (pattern === '**/*') return /^.*$/
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '§/')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/§\//g, '(?:.*/)?')
    .replace(/§§/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function requirePattern(input: Record<string, unknown>): string {
  if (typeof input.pattern !== 'string' || !input.pattern)
    throw new Error('glob.pattern must be a string.')
  return input.pattern
}
