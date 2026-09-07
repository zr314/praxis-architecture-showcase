import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ProviderMessage, RuntimeTool } from '@praxis/core-sdk'
import { digest } from '../../recap/recap.js'
import { repositoryFileState } from './repositoryEvidence.js'

type Receipt = {
  sequence: number
  at: string
  generation: number
  before: string
  after: string
  command: string
  check?: string
  exitCode: number | null
  stable: boolean
}

/** Public observations only. No hidden grader, patch selection, or inferred acceptance. */
export class PublicVerificationLedger {
  private receipts: Receipt[] = []
  private generation = 0
  private current: string | undefined
  private constructor(
    private readonly workspace: string,
    private readonly path: string,
  ) {}

  static async open(workspace: string, path: string) {
    const inside = relative(resolve(workspace), resolve(path))
    if (!inside || (!(inside === '..' || inside.startsWith(`..${sep}`)) && !isAbsolute(inside)))
      throw new Error('Public verification receipts must be outside the model workspace')
    const ledger = new PublicVerificationLedger(workspace, path)
    await mkdir(dirname(path), { recursive: true })
    const text = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return ''
      throw e
    })
    ledger.receipts = text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const last = ledger.receipts.at(-1)
    ledger.generation = last?.generation ?? 0
    ledger.current = last?.after
    await ledger.observe()
    return ledger
  }

  private async observe() {
    const state = digest(await repositoryFileState(this.workspace, true))
    if (this.current !== undefined && this.current !== state) this.generation++
    this.current = state
    return state
  }

  wrap(inner: RuntimeTool): RuntimeTool {
    const parameters = inner.definition.parameters as { properties?: Record<string, unknown> }
    return {
      definition: {
        ...inner.definition,
        execution: {
          sideEffect: 'process',
          target: { kind: 'workspace' },
          conflictScope: 'workspace',
          maxInlineBytes: 52000,
          ...inner.definition.execution,
          parallelSafe: false,
        },
        description:
          inner.definition.description +
          ' Bash enables pipefail. For a verification-only command, supply check with a short description of what it checks. Public receipts record command exit status against observed repository versions; they do not certify correctness. Keep edits and verification in separate calls.',
        parameters: {
          ...inner.definition.parameters,
          properties: {
            ...parameters.properties,
            check: {
              type: 'string',
              minLength: 1,
              maxLength: 200,
              description:
                'Optional label for a verification-only command, without edits or restores.',
            },
          },
        },
      },
      execute: async (request) => {
        const before = await this.observe()
        let result
        try {
          result = await inner.execute(request)
        } finally {
          const after = await this.observe()
          const output = result?.output as { exitCode?: unknown } | undefined
          const receipt: Receipt = {
            sequence: this.receipts.length + 1,
            at: new Date().toISOString(),
            generation: this.generation,
            before,
            after,
            command: String(request.input.command ?? ''),
            ...(typeof request.input.check === 'string'
              ? { check: request.input.check.slice(0, 200) }
              : {}),
            exitCode: typeof output?.exitCode === 'number' ? output.exitCode : null,
            stable: before === after,
          }
          await appendFile(this.path, JSON.stringify(receipt) + '\n')
          this.receipts.push(receipt)
        }
        return {
          ...result,
          output: {
            ...(result.output as Record<string, unknown>),
            publicVerification: this.view(),
          },
        }
      },
    }
  }

  private view() {
    const checks = this.receipts.filter((r) => r.check !== undefined)
    return {
      repositoryDigest: this.current,
      generation: this.generation,
      scope:
        'src, tests, pyproject.toml, setup.cfg, setup.py, tox.ini, pytest.ini, conftest.py, reproduce_upload.py. Endpoint observations only; temporary files, environment and untracked mid-command changes are not attested.',
      checks: checks.slice(-5).map((r) => ({
        sequence: r.sequence,
        check: r.check,
        command: r.command.slice(0, 1000),
        commandTruncated: r.command.length > 1000,
        exitCode: r.exitCode,
        repositoryDigest: r.after,
        current: r.stable && r.generation === this.generation && r.after === this.current,
      })),
      omittedChecks: Math.max(0, checks.length - 5),
      interpretation:
        'Exit 0 is command success, not proof of test coverage or task acceptance. Changed or restored repository state invalidates prior checks. Historical recap, backups and Plan done flags cannot certify the current files. Run relevant public checks on the final version; finish when the task requirements are satisfied. Recheck stale evidence before claiming it still applies.',
    }
  }

  async message(): Promise<ProviderMessage> {
    await this.observe()
    return {
      role: 'user',
      intent: 'context',
      trust: 'low',
      content:
        '<praxis-public-verification>\n' +
        JSON.stringify(this.view()) +
        '\n</praxis-public-verification>',
    }
  }
}
