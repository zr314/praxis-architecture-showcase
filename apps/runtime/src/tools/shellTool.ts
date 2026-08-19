import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { scheduleLongDurationTimer } from '../longDurationTimer.js'
import { terminateProcessTree } from '../process/processTree.js'
import { targetTypeFailure } from './filesystemFailure.js'
import type { RuntimeTool, ToolRequest, ToolResult } from './types.js'

const MAX_OUTPUT_BYTES = 100_000
const MAX_STDIN_BYTES = 256_000
const LOCAL_SHELL = process.platform === 'win32' ? 'Windows PowerShell' : 'the POSIX shell'

export type ShellToolOptions = Readonly<{
  commandPolicy?: (command: string) => ToolResult | undefined
}>

export class ShellTool implements RuntimeTool {
  constructor(private readonly options: ShellToolOptions = {}) {}

  readonly definition = {
    name: 'shell',
    description: `Run one ${LOCAL_SHELL} command in the workspace with bounded inline output. Commands have no implicit timeout; pass timeoutMs only when a hard deadline is required. Pass multiline process input directly with stdin.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        stdin: {
          type: 'string',
          maxLength: MAX_STDIN_BYTES,
          description: 'Exact UTF-8 text written to the child process standard input before EOF.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          description: 'Optional explicit hard deadline. Omit for no command timeout.',
        },
        workingDirectory: {
          type: 'string',
          minLength: 1,
          description: 'Directory for this command, resolved relative to the Session workspace.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      required: ['stdout', 'stderr', 'exitCode', 'signal', 'timedOut', 'truncated'],
      properties: {
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        exitCode: { type: ['integer', 'null'] },
        signal: { type: ['string', 'null'] },
        timedOut: { type: 'boolean' },
        truncated: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    execution: {
      sideEffect: 'process',
      target: { kind: 'input_path', field: 'workingDirectory' },
      parallelSafe: false,
      conflictScope: 'global',
      maxInlineBytes: 65_536,
    },
  } as const

  async execute(request: ToolRequest): Promise<ToolResult> {
    const command = requireCommand(request.input)
    const denied = this.options.commandPolicy?.(command)
    if (denied !== undefined) return denied
    const stdin = parseStdin(request.input.stdin)
    const timeoutMs = parseTimeout(request.input.timeoutMs)
    if (request.signal.aborted) return { ok: false, summary: 'Command cancelled.' }
    const workingDirectory = request.resolvedTarget ?? request.cwd
    const workingDirectoryStats = await stat(workingDirectory)
    if (!workingDirectoryStats.isDirectory()) return targetTypeFailure()

    const { executable, args } = shellInvocation(command)
    const child = spawn(executable, args, {
      cwd: workingDirectory,
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let timedOut = false
    let cancelled = false
    let termination: Promise<void> | undefined
    const capture = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const capturedBytes = target === 'stdout' ? stdoutBytes : stderrBytes
      const remainingBytes = Math.max(0, MAX_OUTPUT_BYTES - capturedBytes)
      const accepted = chunk.subarray(0, remainingBytes)
      const decoder = target === 'stdout' ? stdoutDecoder : stderrDecoder
      const delta = decoder.write(accepted)
      if (target === 'stdout') {
        stdout += delta
        stdoutBytes += accepted.byteLength
        stdoutTruncated ||= accepted.byteLength < chunk.byteLength
      } else {
        stderr += delta
        stderrBytes += accepted.byteLength
        stderrTruncated ||= accepted.byteLength < chunk.byteLength
      }
      const boundedDelta = utf8Prefix(delta, 4_096)
      if (boundedDelta.length > 0) {
        request.onUpdate?.({
          message: `Received ${target} output.`,
          stream: target,
          delta: boundedDelta,
          bytes: Buffer.byteLength(boundedDelta, 'utf8'),
        })
      }
    }
    const finishCapture = (target: 'stdout' | 'stderr') => {
      const truncated = target === 'stdout' ? stdoutTruncated : stderrTruncated
      const decoder = target === 'stdout' ? stdoutDecoder : stderrDecoder
      const delta = decoder.end()
      if (truncated || delta.length === 0) return
      if (target === 'stdout') stdout += delta
      else stderr += delta
      const boundedDelta = utf8Prefix(delta, 4_096)
      request.onUpdate?.({
        message: `Received ${target} output.`,
        stream: target,
        delta: boundedDelta,
        bytes: Buffer.byteLength(boundedDelta, 'utf8'),
      })
    }
    child.stdout?.on('data', (chunk) => capture('stdout', chunk))
    child.stderr?.on('data', (chunk) => capture('stderr', chunk))
    if (child.stdin) {
      // A short-lived process may close stdin before the buffered write
      // completes. Its exit status remains the authoritative outcome.
      child.stdin.on('error', () => {})
      child.stdin.end(stdin)
    }

    const stop = (reason: 'timeout' | 'abort') => {
      if (reason === 'timeout') timedOut = true
      else cancelled = true
      termination ??= terminateProcessTree(child.pid)
    }
    const timeout =
      timeoutMs === undefined
        ? undefined
        : scheduleLongDurationTimer(() => stop('timeout'), timeoutMs)
    const abort = () => stop('abort')
    request.signal.addEventListener('abort', abort, { once: true })
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => resolveExit({ code, signal }))
      },
    ).finally(() => {
      timeout?.cancel()
      request.signal.removeEventListener('abort', abort)
    })
    await termination
    finishCapture('stdout')
    finishCapture('stderr')

    const output = {
      stdout,
      stderr,
      exitCode: exit.code,
      signal: exit.signal,
      timedOut,
      truncated: stdoutTruncated || stderrTruncated,
    }
    if (cancelled) return { ok: false, summary: 'Command cancelled.', output }
    if (timedOut) return { ok: false, summary: `Command timed out after ${timeoutMs}ms.`, output }
    if (exit.code !== 0)
      return { ok: false, summary: `Command exited with code ${exit.code ?? 'unknown'}.`, output }
    return { ok: true, summary: 'Command completed.', output }
  }
}

function shellInvocation(command: string): { executable: string; args: string[] } {
  if (process.platform === 'win32') {
    const utf8Command = [
      '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$OutputEncoding = [Console]::OutputEncoding',
      `& { ${command}\n}`,
    ].join('; ')
    return {
      executable: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        utf8Command,
      ],
    }
  }
  return { executable: '/bin/sh', args: ['-lc', command] }
}

function requireCommand(input: Record<string, unknown>): string {
  if (typeof input.command !== 'string' || !input.command.trim())
    throw new Error('shell.command must be a non-empty string.')
  return input.command
}

function parseStdin(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('shell.stdin must be a string.')
  if (Buffer.byteLength(value, 'utf8') > MAX_STDIN_BYTES) {
    throw new Error(`shell.stdin must be at most ${MAX_STDIN_BYTES} UTF-8 bytes.`)
  }
  return value
}

function parseTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error('shell.timeoutMs must be a positive safe integer.')
  }
  return value as number
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) return value
  return new StringDecoder('utf8').write(bytes.subarray(0, maxBytes))
}
