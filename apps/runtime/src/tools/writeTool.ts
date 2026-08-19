import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { targetTypeFailure } from './filesystemFailure.js'
import type { RuntimeTool, ToolRequest, ToolResult } from './types.js'

const MAX_BYTES = 1_000_000

export class WriteTool implements RuntimeTool {
  readonly definition = {
    name: 'write',
    description: 'Replace a UTF-8 text file with supplied content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        expectedDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        createOnly: { type: 'boolean' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      required: ['path', 'beforeBytes', 'afterBytes', 'created', 'beforeDigest', 'afterDigest'],
      properties: {
        path: { type: 'string' },
        beforeBytes: { type: 'integer', minimum: 0 },
        afterBytes: { type: 'integer', minimum: 0 },
        created: { type: 'boolean' },
        beforeDigest: {
          anyOf: [{ type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, { type: 'null' }],
        },
        afterDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
      },
      additionalProperties: false,
    },
    execution: {
      sideEffect: 'write',
      target: { kind: 'input_path', field: 'path' },
      parallelSafe: false,
      conflictScope: 'target',
      maxInlineBytes: 16_384,
    },
  } as const

  async execute(request: ToolRequest): Promise<ToolResult> {
    const path =
      request.resolvedTarget ?? resolve(request.cwd, requireString(request.input, 'path'))
    const content = requireString(request.input, 'content')
    const afterBytes = Buffer.byteLength(content, 'utf8')
    if (afterBytes > MAX_BYTES)
      return { ok: false, summary: `Content exceeds the ${MAX_BYTES}-byte write limit.` }
    if (request.signal.aborted) return { ok: false, summary: 'Write cancelled.' }
    if (typeof request.input.expectedDigest === 'string' && request.input.createOnly === true) {
      return {
        ok: false,
        summary: 'write.expectedDigest cannot be combined with write.createOnly.',
        error: { code: 'TOOL_INPUT_INVALID', category: 'validation', retryable: true },
      }
    }

    let before: Buffer | undefined
    try {
      const metadata = await stat(path)
      if (!metadata.isFile()) return targetTypeFailure()
      before = await readFile(path)
    } catch (error) {
      if (!isMissing(error)) throw error
    }

    if (request.input.createOnly === true && before !== undefined) {
      return {
        ok: false,
        summary: 'Target already exists; create-only write was not applied.',
        error: { code: 'TOOL_ALREADY_EXISTS', category: 'validation', retryable: true },
      }
    }

    const beforeDigest = before === undefined ? null : digest(before)
    if (
      typeof request.input.expectedDigest === 'string' &&
      request.input.expectedDigest !== beforeDigest
    ) {
      return {
        ok: false,
        summary: 'File changed after it was read; write input is stale.',
        error: { code: 'TOOL_STALE_INPUT', category: 'validation', retryable: true },
      }
    }

    if (request.signal.aborted) return { ok: false, summary: 'Write cancelled.' }
    await mkdir(dirname(path), { recursive: true })
    if (request.signal.aborted) return { ok: false, summary: 'Write cancelled.' }

    if (request.input.createOnly === true) {
      try {
        await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        if (!isAlreadyExists(error)) throw error
        return {
          ok: false,
          summary: 'Target already exists; create-only write was not applied.',
          error: { code: 'TOOL_ALREADY_EXISTS', category: 'validation', retryable: true },
        }
      }
    } else {
      await writeFile(path, content, 'utf8')
    }

    const created = before === undefined
    const beforeBytes = before?.byteLength ?? 0
    const afterDigest = digest(content)
    return {
      ok: true,
      summary: `Wrote ${afterBytes} bytes (${beforeBytes} bytes replaced).`,
      output: { path, beforeBytes, afterBytes, created, beforeDigest, afterDigest },
    }
  }
}

function digest(content: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  )
}

function requireString(input: Record<string, unknown>, key: string): string {
  if (typeof input[key] !== 'string') throw new Error(`write.${key} must be a string.`)
  return input[key]
}
