import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { GlobTool } from './globTool.js'
import type { RuntimeTool, ToolRequest, ToolResult } from './types.js'

const MAX_MATCHES = 100

export class GrepTool implements RuntimeTool {
  readonly definition = {
    name: 'grep',
    description: 'Search UTF-8 workspace files using literal or regular-expression matching.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        pathPattern: {
          type: 'string',
          description: 'Preferred workspace path glob; use / separators on every platform.',
        },
        pattern: {
          type: 'string',
          description: 'Deprecated compatibility alias for pathPattern.',
        },
        regex: { type: 'boolean' },
        ignoreCase: { type: 'boolean' },
        before: { type: 'integer', minimum: 0, maximum: 20 },
        after: { type: 'integer', minimum: 0, maximum: 20 },
        maxMatches: { type: 'integer', minimum: 1, maximum: MAX_MATCHES },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      required: ['matches', 'limit', 'truncated'],
      properties: {
        matches: {
          type: 'array',
          maxItems: MAX_MATCHES,
          items: {
            type: 'object',
            required: ['path', 'line', 'text'],
            properties: {
              path: { type: 'string' },
              line: { type: 'integer', minimum: 1 },
              text: { type: 'string' },
              before: { type: 'array', items: { type: 'string' } },
              after: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
        limit: { type: 'integer', minimum: 1, maximum: MAX_MATCHES },
        truncated: { type: 'boolean' },
      },
      additionalProperties: false,
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
    const query = requireQuery(request.input)
    const pattern = resolvePathPattern(request.input)
    if (!pattern.ok) return pattern.result
    let matcher: (line: string) => boolean
    try {
      if (request.input.regex === true) {
        const expression = new RegExp(query, request.input.ignoreCase === true ? 'i' : '')
        matcher = (line) => expression.test(line)
      } else {
        const needle = request.input.ignoreCase === true ? query.toLocaleLowerCase() : query
        matcher = (line) =>
          (request.input.ignoreCase === true ? line.toLocaleLowerCase() : line).includes(needle)
      }
    } catch {
      return {
        ok: false,
        summary: 'grep.query is not a valid regular expression.',
        error: { code: 'TOOL_REGEX_INVALID', category: 'validation', retryable: true },
      }
    }
    const before = integerOr(request.input.before, 0)
    const after = integerOr(request.input.after, 0)
    const limit = integerInRange(request.input.maxMatches, MAX_MATCHES, 1, MAX_MATCHES)
    const glob = new GlobTool()
    const files = await glob.execute({
      ...request,
      input: {
        pattern: pattern.value,
      },
    })
    const matches: Array<{
      path: string
      line: number
      text: string
      before?: string[]
      after?: string[]
    }> = []
    let truncated = false
    for (const path of (files.output as string[] | undefined) ?? []) {
      if (request.signal.aborted || truncated) break
      try {
        const bytes = await readFile(resolve(request.cwd, path))
        if (bytes.subarray(0, 8_192).includes(0)) continue
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        const lines = content.split(/\r?\n/)
        for (const [index, text] of lines.entries()) {
          if (matcher(text)) {
            if (matches.length >= limit) {
              truncated = true
              break
            }
            matches.push({
              path,
              line: index + 1,
              text,
              ...(before === 0 ? {} : { before: lines.slice(Math.max(0, index - before), index) }),
              ...(after === 0 ? {} : { after: lines.slice(index + 1, index + 1 + after) }),
            })
          }
        }
      } catch {
        // Binary or unreadable files are intentionally skipped.
      }
    }
    return {
      ok: true,
      summary: truncated
        ? `Found ${matches.length} matches (capped at ${limit}).`
        : `Found ${matches.length} matches.`,
      output: { matches, limit, truncated },
    }
  }
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
}

function integerInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = integerOr(value, fallback)
  return Math.max(minimum, Math.min(maximum, candidate))
}

function requireQuery(input: Record<string, unknown>): string {
  if (typeof input.query !== 'string' || !input.query)
    throw new Error('grep.query must be a string.')
  return input.query
}

function resolvePathPattern(
  input: Record<string, unknown>,
): { ok: true; value: string } | { ok: false; result: ToolResult } {
  const preferred = typeof input.pathPattern === 'string' ? input.pathPattern : undefined
  const legacy = typeof input.pattern === 'string' ? input.pattern : undefined
  if (preferred !== undefined && legacy !== undefined && preferred !== legacy) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: 'grep.pathPattern conflicts with deprecated grep.pattern.',
        error: { code: 'TOOL_INPUT_INVALID', category: 'validation', retryable: true },
      },
    }
  }
  return { ok: true, value: preferred ?? legacy ?? '**/*' }
}
