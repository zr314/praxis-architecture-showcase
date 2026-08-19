import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { targetTypeFailure } from './filesystemFailure.js'
import type { RuntimeTool, ToolRequest, ToolResult } from './types.js'

const MAX_BYTES = 5_000_000
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 2_000

export class ReadTool implements RuntimeTool {
  readonly definition = {
    name: 'read',
    description: 'Read a paginated UTF-8 text file inside the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      required: [
        'path',
        'content',
        'offset',
        'limit',
        'totalLines',
        'returnedLines',
        'rangeStart',
        'rangeEnd',
        'nextOffset',
        'truncated',
        'encoding',
        'digest',
      ],
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
        totalLines: { type: 'integer', minimum: 0 },
        returnedLines: { type: 'integer', minimum: 0 },
        rangeStart: { type: 'integer', minimum: 0 },
        rangeEnd: { type: 'integer', minimum: 0 },
        nextOffset: { type: ['integer', 'null'], minimum: 0 },
        truncated: { type: 'boolean' },
        encoding: { const: 'utf-8' },
        digest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
      },
      additionalProperties: false,
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
    const path = request.resolvedTarget ?? resolve(request.cwd, requirePath(request.input))
    const metadata = await stat(path)
    if (!metadata.isFile()) return targetTypeFailure()
    if (metadata.size > MAX_BYTES) {
      return { ok: false, summary: `File exceeds the ${MAX_BYTES}-byte read limit.` }
    }
    const bytes = await readFile(path)
    if (looksBinary(bytes)) {
      return {
        ok: false,
        summary: 'Target appears to be binary and cannot be read as UTF-8 text.',
        error: { code: 'TOOL_BINARY_FILE', category: 'validation', retryable: false },
      }
    }
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return {
        ok: false,
        summary: 'Target is not valid UTF-8 text.',
        error: { code: 'TOOL_ENCODING_UNSUPPORTED', category: 'validation', retryable: false },
      }
    }
    const offset = optionalInteger(request.input.offset, 0)
    const limit = optionalInteger(request.input.limit, DEFAULT_LIMIT)
    const lines = logicalLines(content)
    const selected = lines.slice(offset, offset + limit)
    const returnedLines = selected.length
    const rangeStart = offset
    const rangeEnd = offset + returnedLines
    const truncated = rangeEnd < lines.length
    const nextOffset = truncated ? rangeEnd : null
    return {
      ok: true,
      summary: `Read ${returnedLines} lines [${rangeStart}, ${rangeEnd}) of ${lines.length}.`,
      output: {
        path,
        content: selected.join('\n'),
        offset,
        limit,
        totalLines: lines.length,
        returnedLines,
        rangeStart,
        rangeEnd,
        nextOffset,
        truncated,
        encoding: 'utf-8',
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      },
    }
  }
}

function logicalLines(content: string): string[] {
  if (content.length === 0) return []
  const lines = content.split(/\r?\n/)
  // A terminal newline terminates the final logical line; the split sentinel is
  // not an additional empty line. Interior blank lines remain addressable.
  if (content.endsWith('\n')) lines.pop()
  return lines
}

function requirePath(input: Record<string, unknown>): string {
  if (typeof input.path !== 'string' || !input.path) throw new Error('read.path must be a string.')
  return input.path
}

function optionalInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
}

function looksBinary(content: Uint8Array): boolean {
  return content.subarray(0, 8_192).includes(0)
}
