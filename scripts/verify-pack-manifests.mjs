import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatExit,
  SemanticTerminal,
  shellQuote,
  waitForChildCondition,
  waitForChildExit,
} from './support/semantic-terminal.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseVersion = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version
const PTY_COLUMNS = 120
const PTY_ROWS = 30
const expectedFiles = {
  '@praxis/core-sdk': ['dist/index.js', 'dist/index.d.ts'],
  '@praxis/protocol': ['dist/index.js', 'dist/index.d.ts'],
  '@praxis/plugin-protocol': [
    'dist/index.js',
    'dist/index.d.ts',
    'schemas/manifest-v1.schema.json',
  ],
  '@praxis/plugin-sdk': ['dist/index.js', 'dist/index.d.ts'],
  '@praxis/client': ['dist/index.js', 'dist/index.d.ts'],
  '@praxis/runtime': [
    'dist/entry.js',
    'dist/entry.d.ts',
    'dist/process.js',
    'dist/process.d.ts',
    'dist/run.js',
    'dist/run.d.ts',
  ],
  '@praxis/cli': ['dist/cli.js'],
}

async function main() {
  const tarballs = []
  try {
    for (const [workspace, required] of Object.entries(expectedFiles)) {
      const stdout = packWorkspace(workspace, true)
      const [manifest] = JSON.parse(stdout)
      const packaged = new Set(manifest.files.map((file) => file.path))
      for (const file of required) {
        assert.equal(packaged.has(file), true, `${workspace} pack manifest is missing ${file}`)
      }
      tarballs.push(resolve(root, manifest.filename))
    }

    await verifyInstalledCli(tarballs)
    process.stdout.write('Pack manifests and installed CLI distribution are valid.\n')
  } finally {
    await Promise.all(tarballs.map((tarball) => rm(tarball, { force: true })))
  }
}

function packWorkspace(workspace, createTarball) {
  const args = ['pack', '--json', `--workspace=${workspace}`]
  if (!createTarball) args.splice(2, 0, '--dry-run')
  if (process.platform !== 'win32') {
    return execFileSync('npm', args, { cwd: root, encoding: 'utf8' })
  }
  return execFileSync(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
}

async function verifyInstalledCli(tarballs) {
  const sandbox = await mkdtemp(join(tmpdir(), 'praxis-pack-'))
  try {
    await writeFile(join(sandbox, 'package.json'), '{"private":true}\n', 'utf8')
    runNpm(
      ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', ...tarballs],
      sandbox,
    )
    const cliEntry = join(sandbox, 'node_modules', '@praxis', 'cli', 'dist', 'cli.js')
    const home = join(sandbox, 'home')
    await mkdir(home)
    const environment = {
      ...process.env,
      PRAXIS_HOME: home,
      MOONSHOT_API_KEY: '',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    }
    assert.equal(runNode([cliEntry, '--version'], sandbox, environment).trim(), releaseVersion)
    assert.match(runNode([cliEntry, '--help'], sandbox, environment), /Usage: praxis/u)

    const auth = JSON.parse(
      runNode([cliEntry, 'auth', 'status', 'kimi', '--json'], sandbox, environment),
    )
    assert.equal(auth.provider, 'kimi')
    assert.equal(auth.status, 'unauthenticated')
    assert.equal(auth.protection?.encrypted, true)

    const models = JSON.parse(
      runNode([cliEntry, 'model', 'list', '--provider', 'kimi', '--json'], sandbox, environment),
    )
    assert.equal(models.length, 10)
    assert.equal(
      models.every((model) => model.provider === 'kimi'),
      true,
    )

    const current = JSON.parse(
      runNode([cliEntry, 'model', 'current', '--json'], sandbox, environment),
    )
    assert.equal(current.defaultModel, null)
    assert.deepEqual(
      JSON.parse(runNode([cliEntry, 'session', 'list', '--json'], sandbox, environment)),
      [],
    )
    const doctor = JSON.parse(runNode([cliEntry, 'doctor', '--json'], sandbox, environment))
    assert.equal(typeof doctor.runtimeId, 'string')
    assert.equal(Array.isArray(doctor.providers), true)

    const smoke = runNode(
      [cliEntry, '--provider', 'mock', '--model', 'mock-v1', '-p', 'pack install smoke'],
      sandbox,
      environment,
    )
    assert.match(smoke, /deterministic Mock Provider/u)
    await verifyInteractiveCli(cliEntry, sandbox, environment)
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
}

function runNpm(args, cwd) {
  if (process.platform !== 'win32') {
    execFileSync('npm', args, { cwd, stdio: 'pipe' })
    return
  }
  execFileSync(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', `npm.cmd ${args.map(quote).join(' ')}`],
    {
      cwd,
      stdio: 'pipe',
    },
  )
}

function runNode(args, cwd, env) {
  return execFileSync(process.execPath, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  })
}

async function verifyInteractiveCli(cliEntry, cwd, env) {
  if (process.platform !== 'linux') {
    process.stdout.write('Packed interactive PTY smoke is registered for the Linux package job.\n')
    return
  }
  const command = [
    `stty cols ${PTY_COLUMNS} rows ${PTY_ROWS}`,
    '&&',
    shellQuote(process.execPath),
    shellQuote(cliEntry),
    '--provider',
    'mock',
  ].join(' ')
  const capture = new SemanticTerminal(PTY_COLUMNS, PTY_ROWS)
  const child = spawn('script', ['-qfec', command, '/dev/null'], {
    cwd,
    env: { ...env, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    capture.write(chunk)
  })
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    capture.write(chunk)
  })
  try {
    await waitForChildCondition(
      child,
      async () => (await capture.viewportText()).includes('INPUT ACTIVE'),
      30_000,
      'packed TUI input readiness',
      capture,
    )
    const screen = await capture.viewportText()
    assert.match(screen, /PRAXIS\s+\/\/\s+(?:FIELD\s+)?CONSOLE/u)
    assert.match(screen, /INPUT ACTIVE/u)
    assert.doesNotMatch(capture.rawOutput(), /Raw mode is not supported/u)

    child.stdin.write(
      'tool:write {"path":"packaged-preview.txt","content":"packaged preview proof"}',
    )
    await waitForChildCondition(
      child,
      async () => (await capture.viewportText()).includes('packaged preview proof'),
      5_000,
      'packaged write prompt echo',
      capture,
    )
    child.stdin.write('\r')
    await waitForChildCondition(
      child,
      async () => {
        const permissionScreen = await capture.viewportText()
        return (
          permissionScreen.includes('AUTHORIZATION REQUIRED') &&
          permissionScreen.includes('WHOLE FILE') &&
          permissionScreen.includes('packaged preview proof')
        )
      },
      10_000,
      'packaged write permission preview',
      capture,
    )
    await assert.rejects(access(join(cwd, 'packaged-preview.txt')))
    child.stdin.write('d')
    await waitForChildCondition(
      child,
      async () => {
        const deniedScreen = await capture.viewportText()
        return (
          deniedScreen.includes('INPUT ACTIVE') &&
          deniedScreen.includes('ENTER send') &&
          !deniedScreen.includes('ENTER steer') &&
          !deniedScreen.includes('AUTHORIZATION REQUIRED')
        )
      },
      10_000,
      'packed TUI idle return after denying write',
      capture,
    )
    await assert.rejects(access(join(cwd, 'packaged-preview.txt')))

    child.stdin.write('\u0003')
    const exit = await waitForChildExit(child, 10_000, capture)
    assert.ok(
      exit.code === 0 || exit.code === 130,
      `packed TUI exited ${formatExit(exit)}. ${capture.diagnostics()}`,
    )
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await waitForChildExit(child, 2_000, capture).catch(() => undefined)
    }
    capture.dispose()
  }
}

function quote(value) {
  return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value
}

await main()
