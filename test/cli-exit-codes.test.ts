import assert from 'node:assert/strict'
import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { access, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import test from 'node:test'
import { startLocalRuntime } from '../apps/cli/src/bridge/localRuntime.js'
import { MockRuntimeBridge } from '../apps/cli/src/bridge/mockBridge.js'
import { cliExitCode } from '../apps/cli/src/runCli.js'
import { SqliteWorkflowAuthorityV1 } from '../apps/runtime/src/workflow/sqliteWorkflowAuthority.js'

const packageVersion = JSON.parse(
  await readFile(resolve('apps', 'cli', 'package.json'), 'utf8'),
).version
const cliEntry = resolve('apps', 'cli', 'src', 'cli.tsx')
const runtimeEntry = resolve('apps', 'runtime', 'src', 'entry.ts')
const env = { ...process.env, TSX_TSCONFIG_PATH: resolve('tsconfig.check.json') }
const CLI_RUNTIME_STARTUP_BUDGET_MS = 45_000
const STDERR_DIAGNOSTIC_LIMIT = 1_200

test('public CLI reports the package version', () => {
  const result = runCli('--version')
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), packageVersion)
  assert.equal(result.stderr, '')
})

test('public help does not expose the internal Runtime child mode', () => {
  const result = runCli('--help')
  assert.equal(result.status, 0)
  assert.match(result.stdout, /Usage: praxis/)
  assert.doesNotMatch(result.stdout, /runtime-child/)
  assert.equal(result.stderr, '')
})

test('invalid public arguments use exit code 2', () => {
  const result = runCli('--definitely-invalid')
  assert.equal(result.status, 2)
  assert.match(result.stderr, /unknown option/)
  assert.doesNotMatch(result.stderr, /praxis: error:/)
})

test('Runtime error categories map to stable public exit codes', () => {
  assert.equal(cliExitCode({ rpc: { code: 'INVALID_PARAMS' } }), 2)
  assert.equal(cliExitCode({ rpc: { code: 'AUTH_REQUIRED' } }), 3)
  assert.equal(cliExitCode({ rpc: { code: 'TOOL_PERMISSION_DENIED' } }), 4)
  assert.equal(cliExitCode({ rpc: { code: 'PROVIDER_TIMEOUT' } }), 5)
  assert.equal(cliExitCode({ code: 'CLI_CANCELLED' }), 130)
  assert.equal(cliExitCode({ rpc: { code: 'SESSION_NOT_FOUND' } }), 1)
})

test('CLI launch diagnostics redact argument values, paths, and secrets', () => {
  const command = safeCliCommand([
    '--session',
    'private-session',
    'trace',
    'export',
    'private-trace',
    '--output',
    'C:\\Users\\private\\trace.json',
    '--api-key=private-key',
  ])
  const stderr = safeStderrTail(
    'at file:///home/private/cli.ts\nat C:\\Users\\private\\cli.ts\napi_key=sk-1234567890',
  )

  assert.equal(
    command,
    'node --import tsx <cli-entry> --session <arg> trace export <arg> --output <arg> --api-key=<value>',
  )
  assert.doesNotMatch(`${command}\n${stderr}`, /private|Users|home|sk-/i)
  assert.match(stderr, /<path>/)
  assert.match(stderr, /\[REDACTED\]/)
})

test('mock print mode exits successfully', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-cli-print-home-'))
  try {
    const result = runCli(['--provider', 'mock', '--print', 'exit code smoke'], {
      ...env,
      PRAXIS_HOME: storage,
    })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /deterministic Mock Provider/)
    assert.equal(result.stderr, '')
  } finally {
    await rm(storage, { recursive: true, force: true })
  }
})

test('legacy supervisor alias executes one completed unified Workflow', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-cli-supervisor-home-'))
  try {
    const result = runCli(
      ['--planner', 'supervisor', '--provider', 'mock', '--print', 'supervisor smoke'],
      { ...env, PRAXIS_HOME: storage },
    )
    assert.equal(result.status, 0)
    assert.doesNotMatch(result.stdout, /state:\s*failed/iu)

    const authority = new SqliteWorkflowAuthorityV1(storage)
    await authority.initialize()
    const [workflow] = await authority.list({ limit: 2 })
    authority.close()
    assert.equal(workflow?.state, 'completed')
    assert.equal(workflow?.spec.modePolicy, 'workflow')
    assert.equal(workflow?.spec.nodes.length, 1)
    assert.equal(workflow?.spec.nodes[0]?.kind, 'agent_task')
  } finally {
    await rm(storage, { recursive: true, force: true })
  }
})

test('trace export requires both a trace ID and output path', () => {
  for (const args of [
    ['trace', 'export'],
    ['trace', 'export', 'trace-1'],
  ]) {
    const result = runCli(args)
    assert.equal(result.status, 2)
    assert.match(result.stderr, /required/)
    assert.equal(result.stdout, '')
  }
})

test('bare trace rejects before starting a Runtime or creating a session catalog', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-cli-bare-trace-home-'))
  try {
    const result = runCli(['trace'], { ...env, PRAXIS_HOME: storage })
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /missing required command.*export/)
    await assert.rejects(access(join(storage, 'sessions.json')), { code: 'ENOENT' })
  } finally {
    await rm(storage, { recursive: true, force: true })
  }
})

test('trace export reports an unknown trace with a stable safe error', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-cli-trace-missing-home-'))
  const destination = await mkdtemp(join(tmpdir(), 'praxis-cli-trace-missing-output-'))
  try {
    const result = runCli(['trace', 'export', 'trace-missing', '--output', destination], {
      ...env,
      PRAXIS_HOME: storage,
    })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'praxis: TRACE_NOT_FOUND: Trace not found.\n')
    assert.doesNotMatch(result.stderr, /trace-missing|praxis-cli-trace-missing/)
  } finally {
    await rm(storage, { recursive: true, force: true })
    await rm(destination, { recursive: true, force: true })
  }
})

test('trace export ignores a root session option and leaves the session closed', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-cli-trace-home-'))
  const destination = await mkdtemp(join(tmpdir(), 'praxis-cli-trace-output-'))
  const runtimeEnv = { ...env, PRAXIS_HOME: storage }
  try {
    const bridge = await startLocalRuntime(runtimeEntry, runtimeEnv)
    const session = await bridge.createSession({ cwd: process.cwd(), provider: 'mock' })
    for await (const _event of bridge.prompt({
      sessionId: session.sessionId,
      text: 'create trace for CLI export',
      clientRequestId: 'trace-export-cli-1',
    })) {
      // Drain the run before starting a separate CLI Runtime.
    }
    await bridge.closeSession(session.sessionId)
    await bridge.dispose()
    const traceId = await firstTraceId(storage)
    assert.equal(await sessionState(storage, session.sessionId), 'closed')

    const result = runCli(
      ['--session', session.sessionId, 'trace', 'export', traceId, '--output', destination],
      runtimeEnv,
    )

    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    assert.equal(result.stdout.trim().split(/\r?\n/).length, 1)
    const exported = JSON.parse(result.stdout) as {
      traceId: string
      path: string
      recordCount: number
    }
    assert.equal(exported.traceId, traceId)
    assert.equal(exported.path, await realpath(join(destination, `${traceId}.json`)))
    assert.ok(exported.recordCount > 0)
    assert.equal(await sessionState(storage, session.sessionId), 'closed')
  } finally {
    await rm(storage, { recursive: true, force: true })
    await rm(destination, { recursive: true, force: true })
  }
})

test('mock trace exports are deterministic and match the public result contract', async () => {
  const bridge = new MockRuntimeBridge()
  const destination = join('relative', 'trace-export')
  const first = await bridge.exportTrace('trace-mock', destination)
  const second = await bridge.exportTrace('trace-mock', destination)

  assert.deepEqual(second, first)
  assert.equal(isAbsolute(first.path), true)
  assert.deepEqual(first, {
    traceId: 'trace-mock',
    path: resolve(destination, 'trace-mock.json'),
    recordCount: 0,
    privacy: {
      included: [
        'eventKinds',
        'timestamps',
        'correlationIds',
        'declaredAttributes',
        'aggregateMetrics',
      ],
      excluded: ['prompts', 'credentials', 'environment', 'rawToolInput', 'rawToolOutput'],
    },
  })
})

function runCli(args: string[], processEnv?: NodeJS.ProcessEnv): SpawnSyncReturns<string>
function runCli(...args: string[]): SpawnSyncReturns<string>
function runCli(
  first: string[] | string,
  second?: NodeJS.ProcessEnv | string,
  ...rest: string[]
): SpawnSyncReturns<string> {
  const args = Array.isArray(first)
    ? first
    : [first, ...(typeof second === 'string' ? [second] : []), ...rest]
  const processEnv = Array.isArray(first) ? (second as NodeJS.ProcessEnv | undefined) : env
  const result = spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    cwd: process.cwd(),
    env: processEnv ?? env,
    encoding: 'utf8',
    timeout: CLI_RUNTIME_STARTUP_BUDGET_MS,
    windowsHide: true,
  })
  if (result.error || result.status === null) {
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code ?? 'none'
    assert.fail(
      `CLI command did not produce an exit status: command=${safeCliCommand(args)}, timeout=${CLI_RUNTIME_STARTUP_BUDGET_MS}ms, error=${safeDiagnosticIdentifier(errorCode)}, signal=${safeDiagnosticIdentifier(result.signal ?? 'none')}, stderrTail=${JSON.stringify(safeStderrTail(result.stderr))}`,
    )
  }
  return result
}

function safeCliCommand(args: readonly string[]): string {
  const visibleCommands = new Set(['trace', 'export', 'mock'])
  const safeArgs = args.map((arg) => {
    if (arg.startsWith('-')) {
      const valueSeparator = arg.indexOf('=')
      return valueSeparator < 0 ? arg : `${arg.slice(0, valueSeparator)}=<value>`
    }
    return visibleCommands.has(arg) ? arg : '<arg>'
  })
  return ['node', '--import', 'tsx', '<cli-entry>', ...safeArgs].join(' ')
}

function safeStderrTail(source: string): string {
  const sanitized = stripDiagnosticControls(source)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED_KEY]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/giu, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|token|secret)\s*[:=]\s*\S+/giu, '$1=[REDACTED]')
    .replace(/\bfile:\/\/\/[^\r\n]*/giu, 'file://<path>')
    .replace(/\b[A-Za-z]:[\\/][^\r\n]*/gu, '<path>')
    .replace(/\\\\[^\r\n]*/gu, '<path>')
    .replace(/(^|[\s("'=])\/[^\r\n]*/gmu, '$1<path>')
    .trim()
  if (!sanitized) return '<empty>'
  return sanitized.length <= STDERR_DIAGNOSTIC_LIMIT
    ? sanitized
    : `…${sanitized.slice(-STDERR_DIAGNOSTIC_LIMIT)}`
}

function stripDiagnosticControls(source: string): string {
  let output = ''
  for (const character of source) {
    const code = character.charCodeAt(0)
    if (code === 10) {
      output += '\n'
    } else if (code < 32 || (code >= 0x7f && code <= 0x9f)) {
      output += ' '
    } else {
      output += character
    }
  }
  return output
}

function safeDiagnosticIdentifier(value: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : '<unknown>'
}

async function firstTraceId(storage: string): Promise<string> {
  for (const date of await readdir(join(storage, 'traces'))) {
    for (const file of await readdir(join(storage, 'traces', date))) {
      if (!file.endsWith('.jsonl')) continue
      const [line] = (await readFile(join(storage, 'traces', date, file), 'utf8')).split(/\r?\n/)
      if (line) return (JSON.parse(line) as { context: { traceId: string } }).context.traceId
    }
  }
  throw new Error('Expected a trace record.')
}

async function sessionState(storage: string, sessionId: string): Promise<string | undefined> {
  try {
    const catalog = JSON.parse(
      await readFile(join(storage, 'session-journal-v3', 'catalog.json'), 'utf8'),
    ) as {
      sessions: Array<{ sessionId: string; lifecycle: string }>
    }
    const sessions = new Map(catalog.sessions.map((session) => [session.sessionId, session]))
    const delta = await readFile(join(storage, 'session-journal-v3', 'catalog-delta.jsonl'), 'utf8')
    for (const line of delta.split(/\r?\n/u).filter(Boolean)) {
      const record = JSON.parse(line) as {
        catalog: { sessionId: string; lifecycle: string }
      }
      sessions.set(record.catalog.sessionId, record.catalog)
    }
    return sessions.get(sessionId)?.lifecycle
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const catalog = JSON.parse(await readFile(join(storage, 'sessions.json'), 'utf8')) as {
      sessions: Array<{ sessionId: string; state: string }>
    }
    return catalog.sessions.find((session) => session.sessionId === sessionId)?.state
  }
}
