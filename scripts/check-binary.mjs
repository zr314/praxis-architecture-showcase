import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [artifactPath, expectedPlatform, expectedArch] = process.argv.slice(2)
if (!artifactPath || !expectedPlatform || !expectedArch) {
  throw new Error('Usage: check-binary.mjs <artifact> <platform> <architecture>')
}
if (process.platform !== expectedPlatform || process.arch !== expectedArch) {
  throw new Error(
    `Native smoke requires ${expectedPlatform}/${expectedArch}; runner is ${process.platform}/${process.arch}.`,
  )
}

const executable = resolve(root, artifactPath)
const version = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version
const executableBytes = await readFile(executable)
assertNoEmbeddedReleaseInput(executableBytes)
if (process.platform !== 'win32' && ((await stat(executable)).mode & 0o111) === 0) {
  throw new Error('Standalone artifact is not executable.')
}
const smokeHome = await mkdtemp(join(tmpdir(), 'praxis-binary-smoke-'))
try {
  const versionResult = run(['--version'])
  if (versionResult.stdout.trim() !== version) {
    throw new Error(`Binary reported ${versionResult.stdout.trim()} instead of ${version}.`)
  }
  const helpResult = run(['--help'])
  if (!helpResult.stdout.includes('Usage: praxis') || helpResult.stdout.includes('runtime-child')) {
    throw new Error('Binary help output is invalid or exposes the internal child mode.')
  }
  const auth = JSON.parse(run(['auth', 'status', 'kimi', '--json']).stdout)
  if (auth.status !== 'unauthenticated' || auth.protection?.encrypted !== true) {
    throw new Error('Binary credential status contract is invalid.')
  }
  const models = JSON.parse(run(['model', 'list', '--provider', 'kimi', '--json']).stdout)
  if (models.length !== 10 || !models.every((model) => model.provider === 'kimi')) {
    throw new Error('Binary Kimi model catalog contract is invalid.')
  }
  if (JSON.parse(run(['session', 'list', '--json']).stdout).length !== 0) {
    throw new Error('Binary isolated session catalog is not empty.')
  }
  const doctor = JSON.parse(run(['doctor', '--json']).stdout)
  if (!Array.isArray(doctor.providers)) throw new Error('Binary doctor output is invalid.')
  const smokeResult = run([
    '--provider',
    'mock',
    '--model',
    'mock-v1',
    '--print',
    'standalone release smoke',
  ])
  if (!smokeResult.stdout.includes('deterministic Mock Provider')) {
    throw new Error('Binary mock-provider smoke did not produce the expected response.')
  }
} finally {
  await rm(smokeHome, { recursive: true, force: true })
}
process.stdout.write(`Validated ${executable} on ${process.platform}/${process.arch}.\n`)

function run(args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH'),
  )
  env.PATH = ''
  env.PRAXIS_HOME = smokeHome
  env.MOONSHOT_API_KEY = ''
  env.OPENAI_API_KEY = ''
  env.ANTHROPIC_API_KEY = ''
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Binary ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`)
  }
  return result
}

function assertNoEmbeddedReleaseInput(bytes) {
  const markers = [root, root.replaceAll('\\', '/')]
  for (const name of [
    'MOONSHOT_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'PRAXIS_OPENAI_COMPATIBLE_API_KEY',
    'PRAXIS_LIVE_KIMI_API_KEY',
  ]) {
    const value = process.env[name]
    if (value && value.length >= 8) markers.push(value)
  }
  for (const marker of markers) {
    if (
      bytes.includes(Buffer.from(marker, 'utf8')) ||
      bytes.includes(Buffer.from(marker, 'utf16le'))
    ) {
      throw new Error('Standalone artifact embeds a development path or credential input.')
    }
  }
}
