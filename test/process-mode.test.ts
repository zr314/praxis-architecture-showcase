import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveLocalRuntimeLaunch } from '../apps/cli/src/bridge/localRuntime.js'
import { isRuntimeChild, runtimeLaunch } from '../apps/cli/src/processMode.js'

test('runtime child mode requires the exact hidden argument', () => {
  assert.equal(isRuntimeChild(['node', 'praxis', '--runtime-child']), true)
  assert.equal(isRuntimeChild(['node', 'praxis', '--runtime-child=false']), false)
  assert.equal(isRuntimeChild(['node', 'praxis']), false)
})

test('Node distributions self-spawn the installed CLI entry', () => {
  const entry = resolve('test-fixtures', 'cli.js')
  assert.deepEqual(
    runtimeLaunch(pathToFileURL(entry).href, {
      execPath: '/usr/bin/node',
      bun: false,
    }),
    {
      command: '/usr/bin/node',
      args: [entry, '--runtime-child'],
    },
  )
})

test('Bun standalone distributions self-spawn the current executable', () => {
  assert.deepEqual(
    runtimeLaunch('file:///ignored/cli.js', {
      execPath: '/usr/local/bin/praxis',
      bun: true,
    }),
    {
      command: '/usr/local/bin/praxis',
      args: ['--runtime-child'],
    },
  )
})

test('built CLI uses the unified entry for its local Runtime child', () => {
  const entry = resolve('apps', 'cli', 'dist', 'cli.js')
  assert.deepEqual(
    resolveLocalRuntimeLaunch(pathToFileURL(entry).href, undefined, {
      execPath: process.execPath,
      bun: false,
    }),
    {
      command: process.execPath,
      args: [entry, '--runtime-child'],
    },
  )
})

test('explicit TypeScript Runtime fixtures retain the tsx launch path', () => {
  const fixture = resolve('test', 'fixtures', 'crashing-runtime.ts')
  assert.deepEqual(
    resolveLocalRuntimeLaunch('file:///ignored/cli.js', fixture, {
      execPath: process.execPath,
      bun: false,
    }),
    {
      command: process.execPath,
      args: ['--import', 'tsx', fixture],
    },
  )
})

test('Runtime runner is import-safe', async () => {
  const runtime = await import('../apps/runtime/src/run.js')
  assert.equal(typeof runtime.runRuntime, 'function')
  assert.equal(process.exitCode, undefined)
})

test('hidden child mode starts the Runtime protocol instead of the public CLI', async () => {
  const cliEntry = fileURLToPath(new URL('../apps/cli/src/cli.tsx', import.meta.url))
  const storage = await mkdtemp(resolve(tmpdir(), 'praxis-process-mode-home-'))
  const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, '--runtime-child'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRAXIS_HOME: storage,
      TSX_TSCONFIG_PATH: resolve('tsconfig.check.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const responses = new Map<string, (message: Record<string, unknown>) => void>()
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-2_048)
  })
  lines.on('line', (line) => {
    const message = JSON.parse(line) as Record<string, unknown>
    if (typeof message.id === 'string') responses.get(message.id)?.(message)
  })

  const request = (
    id: string,
    method: string,
    params: unknown,
  ): Promise<Record<string, unknown>> => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolveResponse, rejectResponse) => {
      const cleanup = () => {
        clearTimeout(timer)
        responses.delete(id)
        child.off('error', onError)
        child.off('exit', onExit)
      }
      const onError = (error: Error) => {
        cleanup()
        rejectResponse(error)
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup()
        rejectResponse(
          new Error(
            `Runtime child exited before ${method} (code=${String(code)}, signal=${String(signal)}). stderr=${stderr || '<empty>'}`,
          ),
        )
      }
      const timer = setTimeout(() => {
        cleanup()
        rejectResponse(
          new Error(
            `Timed out waiting for ${method}; child running=${String(child.exitCode === null)}. stderr=${stderr || '<empty>'}`,
          ),
        )
      }, 60_000)
      child.once('error', onError)
      child.once('exit', onExit)
      responses.set(id, (message) => {
        cleanup()
        resolveResponse(message)
      })
    })
  }

  try {
    const initialized = await request('1', 'initialize', {
      protocolVersion: 1,
      client: { name: 'child-mode-test', version: '1' },
      capabilities: { interactivePermissions: true, outputFormats: ['text'] },
    })
    assert.equal('result' in initialized, true)
    await request('2', 'shutdown', {})
  } finally {
    child.kill()
    lines.close()
    await rm(storage, { recursive: true, force: true })
  }
})
