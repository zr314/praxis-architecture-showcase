import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const cliEntry = resolve('apps', 'cli', 'src', 'cli.tsx')
const baseEnv = { ...process.env, TSX_TSCONFIG_PATH: resolve('tsconfig.check.json') }
const fixtureSecret = 'sk-fixture-never-print-this'
const CLI_PROCESS_BUDGET_MS = 45_000

test('auth login --stdin stores an encrypted credential and never emits the key', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-cli-auth-'))
  const env = { ...baseEnv, PRAXIS_HOME: home, MOONSHOT_API_KEY: '' }
  try {
    const login = runCli(['auth', 'login', 'kimi', '--stdin', '--json'], env, `${fixtureSecret}\n`)
    assert.equal(login.status, 0)
    assert.equal(login.stderr, '')
    assert.doesNotMatch(login.stdout, new RegExp(fixtureSecret))
    const status = JSON.parse(login.stdout) as Record<string, unknown>
    assert.equal(status.status, 'authenticated')
    assert.equal(status.credentialSource, 'stored')
    assert.deepEqual(status.protection, {
      encrypted: true,
      backend: 'aes-256-gcm-key-file',
      osDelegated: false,
    })

    const credentialFile = await readFile(join(home, 'credentials.json'), 'utf8')
    assert.doesNotMatch(credentialFile, new RegExp(fixtureSecret))
    assert.match(credentialFile, /"protection": "aes-256-gcm-key-file"/)

    const restarted = runCli(['auth', 'status', 'kimi', '--json'], env)
    assert.equal(restarted.status, 0)
    assert.equal(
      (JSON.parse(restarted.stdout) as Record<string, unknown>).credentialSource,
      'stored',
    )

    const logout = runCli(['auth', 'logout', 'kimi', '--json'], env)
    assert.equal(logout.status, 0)
    assert.doesNotMatch(logout.stdout + logout.stderr, new RegExp(fixtureSecret))
    const after = runCli(['auth', 'status', 'kimi', '--json'], env)
    assert.equal((JSON.parse(after.stdout) as Record<string, unknown>).status, 'unauthenticated')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('auth login fails closed outside a TTY and API keys are not accepted in argv', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-cli-auth-closed-'))
  const env = { ...baseEnv, PRAXIS_HOME: home, MOONSHOT_API_KEY: '' }
  try {
    const missing = runCli(['auth', 'login', 'kimi'], env)
    assert.equal(missing.status, 3)
    assert.match(missing.stderr, /--stdin|MOONSHOT_API_KEY/)

    const argv = runCli(['auth', 'login', 'kimi', '--api-key', fixtureSecret], env)
    assert.equal(argv.status, 2)
    assert.doesNotMatch(argv.stdout + argv.stderr, new RegExp(fixtureSecret))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

function runCli(args: string[], env: NodeJS.ProcessEnv, input?: string): SpawnSyncReturns<string> {
  const result = spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    cwd: process.cwd(),
    env,
    input,
    encoding: 'utf8',
    timeout: CLI_PROCESS_BUDGET_MS,
    windowsHide: true,
  })
  if (result.error || result.status === null) {
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code ?? 'none'
    assert.fail(
      `CLI auth command did not produce an exit status within ${CLI_PROCESS_BUDGET_MS}ms: error=${errorCode}, signal=${result.signal ?? 'none'}`,
    )
  }
  return result
}
