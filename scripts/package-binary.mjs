import { spawnSync } from 'node:child_process'
import { access, mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactForTarget } from './release-utils.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = optionValue('--target')
if (!target) throw new Error('Pass one standalone target with --target.')

const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const artifact = artifactForTarget(target, manifest.version)
if (artifact.platform !== process.platform || artifact.arch !== process.arch) {
  throw new Error(
    `Target ${target} requires a native ${artifact.platform}/${artifact.arch} runner; current runner is ${process.platform}/${process.arch}.`,
  )
}
const entry = resolve(root, 'apps/cli/dist/cli.js')
await access(entry).catch(() => {
  throw new Error('Build apps/cli/dist/cli.js before packaging a standalone executable.')
})

const artifacts = resolve(root, 'artifacts')
const output = resolve(artifacts, artifact.filename)
await mkdir(artifacts, { recursive: true })
const require = createRequire(import.meta.url)
const bunPackage = require.resolve(`${artifact.compilerPackage}/package.json`)
const bunExecutable =
  process.env.BUN_EXECUTABLE ??
  resolve(dirname(bunPackage), 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun')
const result = spawnSync(
  bunExecutable,
  ['build', entry, '--compile', '--minify', '--outfile', output],
  { cwd: root, stdio: 'inherit', windowsHide: true },
)
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Bun exited with status ${result.status}.`)
process.stdout.write(`${output}\n`)

function optionValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
