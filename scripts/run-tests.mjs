import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const COMPATIBILITY_TEST_FILES = [
  'authenticated-child-provider.test.ts',
  'child-runtime-host.test.ts',
  'cli-exit-codes.test.ts',
  'controlled-workspace-merge.test.ts',
  'directory-workspace-isolation.test.ts',
  'mcp-stdio-client.test.ts',
  'runtime-process.test.ts',
  'tools.test.ts',
  'workspace-isolation-manager.test.ts',
  'workspace-write-guard.test.ts',
]

const testRoot = fileURLToPath(new URL('../test', import.meta.url))
const suite = selectedSuite(process.argv.slice(2))
const testFiles =
  suite === 'compatibility'
    ? COMPATIBILITY_TEST_FILES.map((name) => `${testRoot}/${name}`)
    : await collectTestFiles(testRoot)
const testConcurrency = positiveInteger(
  process.env.PRAXIS_TEST_CONCURRENCY ?? (suite === 'compatibility' ? '2' : '4'),
)

if (testFiles.length === 0) {
  console.error(`No test files found under ${testRoot}`)
  process.exitCode = 1
} else {
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'))
  const result = spawnSync(
    process.execPath,
    [
      tsxCli,
      '--tsconfig',
      'tsconfig.check.json',
      '--test',
      `--test-concurrency=${testConcurrency}`,
      ...testFiles,
    ],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit' },
  )

  if (result.error) {
    throw result.error
  }
  process.exitCode = result.status ?? 1
}

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) {
        return collectTestFiles(path)
      }
      return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : []
    }),
  )
  return files.flat().sort()
}

function positiveInteger(value) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError('PRAXIS_TEST_CONCURRENCY must be a positive integer.')
  }
  return Number(value)
}

function selectedSuite(arguments_) {
  if (arguments_.length === 0) return 'full'
  if (arguments_.length === 2 && arguments_[0] === '--suite' && arguments_[1] === 'compatibility') {
    return 'compatibility'
  }
  throw new TypeError('Usage: node scripts/run-tests.mjs [--suite compatibility]')
}
