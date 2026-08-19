import { rm } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pathSeparator = process.platform === 'win32' ? '\\' : '/'
const targets = {
  'core-sdk': ['packages/core-sdk/dist'],
  protocol: ['packages/protocol/dist'],
  'plugin-protocol': ['packages/plugin-protocol/dist'],
  'plugin-sdk': ['packages/plugin-sdk/dist'],
  client: ['packages/client/dist'],
  runtime: ['apps/runtime/dist'],
  cli: ['apps/cli/dist'],
  all: [
    'packages/core-sdk/dist',
    'packages/protocol/dist',
    'packages/plugin-protocol/dist',
    'packages/plugin-sdk/dist',
    'packages/client/dist',
    'apps/runtime/dist',
    'apps/cli/dist',
    'dist',
  ],
}
const requested = process.argv[2] ?? 'all'
const paths = targets[requested]

if (!paths) throw new Error(`Unknown distribution cleanup target: ${requested}`)

for (const relativePath of paths) {
  const target = resolve(root, relativePath)
  const relation = relative(root, target)
  if (
    relation === '..' ||
    relation.startsWith(`..${pathSeparator}`) ||
    resolve(root, relation) !== target
  ) {
    throw new Error(`Refusing to remove a path outside the workspace: ${target}`)
  }
  await rm(target, { recursive: true, force: true })
}
