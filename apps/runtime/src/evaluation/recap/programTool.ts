import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJsonV1, type RuntimeTool, type ToolRequest } from '@praxis/core-sdk'

export type ProgramCase = { input: unknown; policy: unknown }
export type ProgramOutput = { ok: boolean; value?: unknown; error?: string }
export type PublicProgramTest = ProgramCase & { id: string; expected: unknown }

/** Computation subprocess, no secrets, no writable paths or subprocess grants. VM is defense in depth. */
export async function executeProgram(
  path: string,
  cases: readonly ProgramCase[],
  signal?: AbortSignal,
): Promise<ProgramOutput[]> {
  const worker = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts') ? './programWorker.ts' : './programWorker.js',
      import.meta.url,
    ),
  )
  return new Promise((success, failure) => {
    const child = execFile(
      process.execPath,
      [
        '--permission',
        `--allow-fs-read=${worker}`,
        `--allow-fs-read=${resolve(path)}`,
        worker,
        resolve(path),
      ],
      {
        env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
        windowsHide: true,
        maxBuffer: 256000,
        signal,
      },
      (error, stdout) => {
        if (error) {
          failure(new Error(`PROGRAM_PROCESS_FAILED${'code' in error ? ` (${error.code})` : ''}`))
          return
        }
        try {
          success(JSON.parse(stdout) as ProgramOutput[])
        } catch {
          failure(new Error('PROGRAM_OUTPUT_INVALID'))
        }
      },
    )
    child.stdin?.on('error', () => {
      /* Completion callback owns the error. */
    })
    child.stdin?.end(JSON.stringify(cases))
  })
}

export class ProgramTool implements RuntimeTool {
  constructor(private readonly workspace: string) {}
  readonly definition = {
    name: 'evaluate',
    description:
      'Execute solution.js with current input/policy and public tests, returning outputs and regression feedback. No hidden target answers. Pure synchronous JavaScript; each test has a 10-second computation watchdog, not a Run limit.',
    parameters: {
      type: 'object',
      properties: { path: { const: 'solution.js', type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    execution: {
      sideEffect: 'read',
      target: { kind: 'input_path', field: 'path' },
      parallelSafe: false,
      conflictScope: 'workspace',
      maxInlineBytes: 65536,
    },
  } as const
  async execute(request: ToolRequest) {
    if (request.input.path !== 'solution.js' || resolve(request.cwd) !== resolve(this.workspace))
      return { ok: false, summary: 'Only this workspace solution.js can be evaluated.' }
    try {
      const load = async (name: string) =>
        JSON.parse(await readFile(resolve(this.workspace, name), 'utf8'))
      const tests = (await load('tests.json')) as PublicProgramTest[]
      const outputs = await executeProgram(
        resolve(this.workspace, 'solution.js'),
        [
          { input: await load('input.json'), policy: await load('policy.json') },
          ...tests.map(({ input, policy }) => ({ input, policy })),
        ],
        request.signal,
      )
      const checks = tests.map((t, i) => ({
        id: t.id,
        passed:
          outputs[i + 1]?.ok === true &&
          canonicalJsonV1(outputs[i + 1]!.value) === canonicalJsonV1(t.expected),
        actual: outputs[i + 1],
        expected: t.expected,
      }))
      return {
        ok: true,
        summary: 'Executed program; public regression results only.',
        output: {
          current: outputs[0],
          checks,
          allPublicTestsPassed: checks.every((c) => c.passed),
        },
      }
    } catch (error) {
      return {
        ok: false,
        summary: error instanceof Error ? error.message : 'Program evaluation failed.',
      }
    }
  }
}
