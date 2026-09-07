import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const tsxLoader = import.meta.resolve('tsx')

test('source subprocesses resolve workspace imports without built or current dist exports', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'praxis-source-resolution-'))
  try {
    for (const name of await readdir(root)) {
      if (name.startsWith('tsconfig') && name.endsWith('.json')) {
        await copyFile(join(root, name), join(fixture, name))
      }
    }
    await writeFile(join(fixture, 'package.json'), '{"type":"module"}')
    const source = join(fixture, 'packages/core-sdk/src/index.ts')
    await mkdir(dirname(source), { recursive: true })
    await writeFile(source, 'export const sourceOnlyMarker: string = "current-source"\n')
    const environment = { ...process.env }
    delete environment.TSX_TSCONFIG_PATH
    delete environment.NODE_OPTIONS
    const launch = () =>
      execute(
        process.execPath,
        [
          '--import',
          tsxLoader,
          '--input-type=module',
          '--eval',
          'import { sourceOnlyMarker } from "@praxis/core-sdk"; process.stdout.write(sourceOnlyMarker)',
        ],
        { cwd: fixture, env: environment, timeout: 15_000 },
      )

    // A clean checkout has no build output at all.
    assert.equal((await launch()).stdout, 'current-source')

    // An older installed workspace package must not take precedence over source.
    const stalePackage = join(fixture, 'node_modules/@praxis/core-sdk')
    await mkdir(stalePackage, { recursive: true })
    await writeFile(
      join(stalePackage, 'package.json'),
      '{"name":"@praxis/core-sdk","type":"module","exports":"./stale.js"}',
    )
    await writeFile(join(stalePackage, 'stale.js'), 'export const oldMarker = "stale-dist"\n')
    assert.equal((await launch()).stdout, 'current-source')
  } finally {
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
