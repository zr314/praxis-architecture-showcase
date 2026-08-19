import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { startLocalRuntime } from '../apps/cli/src/bridge/localRuntime.js'

const cliEntry = resolve('apps', 'cli', 'src', 'cli.tsx')
const runtimeEntry = resolve('apps', 'runtime', 'src', 'entry.ts')
const baseEnv = { ...process.env, TSX_TSCONFIG_PATH: resolve('tsconfig.check.json') }
const CLI_PROCESS_TIMEOUT_MS = 60_000

test('CLI help exposes the final auth, model, session, and doctor grammar', () => {
  const fixtures: Array<{ args: string[]; patterns: RegExp[] }> = [
    {
      args: ['--help'],
      patterns: [/\bauth\b/, /\bdoctor\b/, /\bmodel\b/, /\bsession\b/],
    },
    {
      args: ['auth', '--help'],
      patterns: [/\bstatus\b/, /\blogin\b/, /\blogout\b/],
    },
    {
      args: ['auth', 'login', '--help'],
      patterns: [/\[provider\]/, /--stdin/, /--json/],
    },
    {
      args: ['model', '--help'],
      patterns: [/\blist\b/, /\bcurrent\b/, /\bset\b/],
    },
    {
      args: ['session', '--help'],
      patterns: [
        /\blist\b/,
        /\bsearch\b/,
        /\bshow\b/,
        /\brename\b/,
        /\bfork\b/,
        /\bbranch\b/,
        /\bexport\b/,
        /\bdelete\b/,
      ],
    },
    {
      args: ['session', 'delete', '--help'],
      patterns: [/<id>/, /--yes/, /--json/],
    },
    {
      args: ['resource', '--help'],
      patterns: [/\blist\b/, /\binspect\b/, /\benable\b/, /\bdisable\b/],
    },
    {
      args: ['resource', 'enable', '--help'],
      patterns: [/<id>/, /--workspace/, /--trust-project/],
    },
  ]

  for (const fixture of fixtures) {
    const result = runCli(fixture.args)
    assert.equal(result.status, 0, fixture.args.join(' '))
    assert.equal(result.stderr, '', fixture.args.join(' '))
    for (const pattern of fixture.patterns) {
      assert.match(result.stdout, pattern, `${fixture.args.join(' ')}: ${pattern}`)
    }
  }
})

test('model commands expose one clean JSON document and stable auth exit codes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-cli-model-'))
  const env = { ...baseEnv, PRAXIS_HOME: home }
  try {
    const selected = jsonCommand(['model', 'set', 'mock', 'mock-v1', '--json'], env)
    assert.equal(selected.status, 0)
    const selectedModel = selected.json.defaultModel as Record<string, unknown>
    assert.deepEqual(selectedModel.provider, 'mock')
    assert.deepEqual(selectedModel.model, 'mock-v1')

    const current = jsonCommand(['model', 'current', '--json'], env)
    assert.equal(current.status, 0)
    assert.deepEqual((current.json.defaultModel as Record<string, unknown>).model, 'mock-v1')

    const models = jsonCommand<unknown[]>(['model', 'list', '--provider', 'mock', '--json'], env)
    assert.equal(models.status, 0)
    assert.equal(Array.isArray(models.json), true)
    assert.equal(models.json.length, 1)
    assert.equal((models.json[0] as { provider: string }).provider, 'mock')

    const unauthenticated = runCli(['model', 'set', 'kimi', 'kimi-k3', '--json'], env)
    assert.equal(unauthenticated.status, 3)
    assert.equal(unauthenticated.stdout, '')
    assert.match(unauthenticated.stderr, /AUTH_REQUIRED/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('resource commands require explicit project trust and persist exact Skill selection', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-cli-resource-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-cli-resource-workspace-'))
  const env = { ...baseEnv, PRAXIS_HOME: home }
  try {
    const skillDirectory = join(workspace, '.praxis', 'skills', 'review')
    await mkdir(skillDirectory, { recursive: true })
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      '---\nname: review\ndescription: Review from the CLI.\n---\nReview exact evidence.\n',
      'utf8',
    )

    const listed = jsonCommand<Array<Record<string, unknown>>>(
      ['resource', 'list', '--workspace', workspace],
      env,
    )
    assert.equal(listed.json[0]?.id, 'project/review')
    assert.equal(listed.json[0]?.enabled, false)

    const refused = runCli(['resource', 'enable', 'project/review', '--workspace', workspace], env)
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /RESOURCE_TRUST_REQUIRED/)

    const enabled = jsonCommand(
      ['resource', 'enable', 'project/review', '--workspace', workspace, '--trust-project'],
      env,
    )
    assert.equal(enabled.json.enabled, true)
    const inspected = jsonCommand(
      ['resource', 'inspect', 'project/review', '--workspace', workspace, '--content'],
      env,
    )
    assert.match(String(inspected.json.content), /Review exact evidence/)

    assert.equal(
      jsonCommand(['resource', 'disable', 'project/review', '--workspace', workspace], env).json.ok,
      true,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('session commands inspect without reopening and manage an exact session lifecycle', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-cli-session-'))
  const outputRoot = await mkdtemp(join(tmpdir(), 'praxis-cli-session-export-'))
  const env = { ...baseEnv, PRAXIS_HOME: home }
  let sourceId = ''
  try {
    const bridge = await startLocalRuntime(runtimeEntry, env)
    const source = await bridge.createSession({
      cwd: process.cwd(),
      provider: 'mock',
      name: 'Source',
    })
    sourceId = source.sessionId
    await bridge.closeSession(source.sessionId)
    await bridge.dispose()

    const shown = jsonCommand(['session', 'show', sourceId, '--json'], env)
    assert.equal(shown.json.state, 'closed')
    assert.equal(typeof shown.json.createdAt, 'string')

    const inspectionBridge = await startLocalRuntime(runtimeEntry, env)
    assert.equal((await inspectionBridge.inspectSession(sourceId)).state, 'closed')
    await inspectionBridge.dispose()

    const renamed = jsonCommand(['session', 'rename', sourceId, 'Renamed', '--json'], env)
    assert.equal(renamed.json.name, 'Renamed')

    const searched = jsonCommand<Array<Record<string, unknown>>>(
      ['session', 'search', 'Renamed', '--json'],
      env,
    )
    assert.equal(searched.json[0]?.sessionId, sourceId)

    const forked = jsonCommand(['session', 'fork', sourceId, '--name', 'Child', '--json'], env)
    const childId = String(forked.json.sessionId)
    assert.equal(forked.json.parentSessionId, sourceId)

    const activeLeaf = jsonCommand(['session', 'branch', sourceId, '--json'], env)
    assert.equal(activeLeaf.json.sessionId, childId)

    const output = join(outputRoot, 'session.json')
    const exported = jsonCommand(['session', 'export', childId, '--output', output, '--json'], env)
    assert.equal(exported.json.path, await realpath(output))
    assert.equal(
      (JSON.parse(await readFile(output, 'utf8')) as { session: { sessionId: string } }).session
        .sessionId,
      childId,
    )
    const refused = runCli(['session', 'export', childId, '--output', output, '--json'], env)
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /Refusing to overwrite/)

    const deleted = jsonCommand(['session', 'delete', childId, '--yes', '--json'], env)
    assert.equal(deleted.json.deleted, true)
    assert.match(String(deleted.json.trashPath), /trash/)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(outputRoot, { recursive: true, force: true })
  }
})

test('session delete requires explicit confirmation outside a TTY', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-cli-session-confirm-'))
  const env = { ...baseEnv, PRAXIS_HOME: home }
  try {
    const bridge = await startLocalRuntime(runtimeEntry, env)
    const session = await bridge.createSession({ cwd: process.cwd(), provider: 'mock' })
    await bridge.dispose()

    const result = runCli(['session', 'delete', session.sessionId], env)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /requires --yes/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

function jsonCommand<T = Record<string, unknown>>(
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; json: T } {
  const result = runCli(args, env)
  assert.equal(result.stderr, '', args.join(' '))
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1, args.join(' '))
  return { status: result.status, json: JSON.parse(result.stdout) as T }
}

function runCli(args: string[], env: NodeJS.ProcessEnv = baseEnv): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: CLI_PROCESS_TIMEOUT_MS,
    windowsHide: true,
  })
}
