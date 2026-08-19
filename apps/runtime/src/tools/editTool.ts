import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { targetTypeFailure } from './filesystemFailure.js'
import { prepareTextEdit } from './textEdit.js'
import type { RuntimeTool, ToolRequest, ToolResult } from './types.js'

export class EditTool implements RuntimeTool {
  readonly definition = {
    name: 'edit',
    description:
      'Replace one unambiguous text occurrence in a UTF-8 file; multiline CRLF and LF match equivalently.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        expectedDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      required: ['path', 'replacements', 'beforeDigest', 'afterDigest', 'matchMode', 'lineEnding'],
      properties: {
        path: { type: 'string' },
        replacements: { const: 1 },
        beforeDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        afterDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        matchMode: { enum: ['exact', 'line-ending-normalized'] },
        lineEnding: { enum: ['crlf', 'lf', 'none'] },
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
    const oldText = requireString(request.input, 'oldText')
    const newText = requireString(request.input, 'newText')
    if (!oldText) return { ok: false, summary: 'edit.oldText cannot be empty.' }
    if (request.signal.aborted) return { ok: false, summary: 'Edit cancelled.' }

    const metadata = await stat(path)
    if (!metadata.isFile()) return targetTypeFailure()
    const source = await readFile(path, 'utf8')
    const beforeDigest = digest(source)
    if (
      typeof request.input.expectedDigest === 'string' &&
      request.input.expectedDigest !== beforeDigest
    ) {
      return {
        ok: false,
        summary: 'File changed after it was read; edit input is stale.',
        error: { code: 'TOOL_STALE_INPUT', category: 'validation', retryable: true },
      }
    }
    const prepared = prepareTextEdit(source, oldText, newText)
    if (!prepared.ok) {
      return {
        ok: false,
        summary:
          prepared.reason === 'not_found'
            ? 'oldText was not found.'
            : 'oldText occurs more than once; edit is ambiguous.',
      }
    }
    if (request.signal.aborted) return { ok: false, summary: 'Edit cancelled.' }

    await writeFile(path, prepared.content, 'utf8')
    const byteChange = `${Buffer.byteLength(source)} -> ${Buffer.byteLength(prepared.content)} bytes`
    return {
      ok: true,
      summary:
        prepared.matchMode === 'line-ending-normalized'
          ? `Replaced 1 occurrence using CRLF/LF-equivalent matching; replacement line ending: ${lineEndingLabel(prepared.lineEnding)}; untouched regions preserved (${byteChange}).`
          : `Replaced 1 exact occurrence (${byteChange}).`,
      output: {
        path,
        replacements: 1,
        beforeDigest,
        afterDigest: digest(prepared.content),
        matchMode: prepared.matchMode,
        lineEnding: prepared.lineEnding,
      },
    }
  }
}

function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function lineEndingLabel(value: 'crlf' | 'lf' | 'none'): string {
  if (value === 'crlf') return 'CRLF'
  if (value === 'lf') return 'LF'
  return 'none'
}

function requireString(input: Record<string, unknown>, key: string): string {
  if (typeof input[key] !== 'string') throw new Error(`edit.${key} must be a string.`)
  return input[key]
}
