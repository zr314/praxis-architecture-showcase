import { spawn } from 'node:child_process'
import type { RuntimeTool, ToolRequest, ToolResult } from '@praxis/core-sdk'
import { repositoryChangedFiles, repositoryFileState } from './repositoryEvidence.js'

/** Only the named offline container receives model commands; no host shell is invoked. */
export class RepositoryTool implements RuntimeTool {
  readonly definition = {
    name: 'repo_shell',
    description:
      'Execute Bash in the isolated Linux repository at /workspace. Python, pytest, git, rg and patch are installed. Read/search/edit files and run tests here. No network or host filesystem access. Each command has a 180 second process watchdog; no limit on total task turns. Output is capped at 48000 characters; narrow large reads.',
    parameters: {
      type: 'object',
      required: ['command'],
      additionalProperties: false,
      properties: { command: { type: 'string' } },
    },
    execution: {
      sideEffect: 'process' as const,
      target: { kind: 'workspace' as const },
      parallelSafe: false,
      conflictScope: 'workspace' as const,
      maxInlineBytes: 52000,
      timeoutMs: 200000,
    },
  }
  constructor(
    private readonly container: string,
    private readonly workspace: string,
  ) {
    if (!/^praxis-repo-[a-f0-9-]+$/u.test(container)) throw new Error('Invalid container identity')
  }
  async execute(request: ToolRequest): Promise<ToolResult> {
    if (typeof request.input.command !== 'string') return { ok: false, summary: 'command required' }
    const before = await repositoryFileState(this.workspace).catch(() => undefined)
    const result = await new Promise<ToolResult>((done) => {
      const child = spawn(
        'docker',
        [
          'exec',
          '-w',
          '/workspace',
          this.container,
          'timeout',
          '--kill-after=5',
          '180',
          'bash',
          '-o',
          'pipefail',
          '-lc',
          request.input.command as string,
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: request.signal },
      )
      let output = '',
        truncated = false
      const collect = (chunk: Buffer) => {
        const text = chunk.toString()
        if (output.length + text.length > 48000) truncated = true
        output = (output + text).slice(0, 48000)
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      child.on('error', () => done({ ok: false, summary: 'Container command could not execute' }))
      child.on('close', (code) =>
        done({
          ok: code === 0,
          summary: `Exit ${code}${truncated ? '; output truncated' : ''}`,
          output: {
            exitCode: code,
            truncated,
            command: String(request.input.command).slice(0, 600),
            stdout: output,
          },
        }),
      )
    })
    const after = await repositoryFileState(this.workspace).catch(() => undefined)
    return {
      ...result,
      output: {
        ...(result.output as Record<string, unknown>),
        ...(before && after
          ? {
              repositoryChanges: {
                source: 'host-file-digests-v1',
                modifiedFiles: repositoryChangedFiles(before, after),
              },
            }
          : { fileAuditUnavailable: true }),
      },
    }
  }
}
