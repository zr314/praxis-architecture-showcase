import { spawnSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertTagVersion } from './release-utils.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const privateRegistry = 'http://127.0.0.1:4873/'
const paths = [
  'apps/cli/package.json',
  'apps/runtime/package.json',
  'packages/core-sdk/package.json',
  'packages/protocol/package.json',
  'packages/plugin-protocol/package.json',
  'packages/client/package.json',
  'packages/plugin-sdk/package.json',
]
const rootManifest = await manifest('package.json')
const tag = optionValue('--tag') ?? process.env.GITHUB_REF_NAME
if (!tag) throw new Error('Provide the release tag with --tag or GITHUB_REF_NAME.')
assertTagVersion(tag, rootManifest.version)
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'))
if (
  lock.version !== rootManifest.version ||
  lock.packages?.['']?.version !== rootManifest.version
) {
  throw new Error('Root package-lock version is not synchronized.')
}

for (const path of paths) {
  const value = await manifest(path)
  if (value.version !== rootManifest.version) {
    throw new Error(`${value.name} version ${value.version} is not synchronized.`)
  }
  if (
    value.license !== 'Apache-2.0' ||
    value.publishConfig?.access !== 'restricted' ||
    value.publishConfig?.registry !== privateRegistry
  ) {
    throw new Error(`${value.name} is missing private Apache-2.0 release metadata.`)
  }
  if (value.repository?.url !== 'git+https://github.com/uestc-Praxis/praxis.git') {
    throw new Error(`${value.name} has an unexpected repository URL.`)
  }
  for (const [name, range] of Object.entries(value.dependencies ?? {})) {
    if (name.startsWith('@praxis/') && range !== `^${rootManifest.version}`) {
      throw new Error(`${value.name} dependency ${name} is not synchronized.`)
    }
  }
  const lockEntry = lock.packages?.[path.replace('/package.json', '')]
  if (lockEntry?.version !== rootManifest.version) {
    throw new Error(`${value.name} package-lock version is not synchronized.`)
  }
  for (const [name, range] of Object.entries(lockEntry?.dependencies ?? {})) {
    if (name.startsWith('@praxis/') && range !== `^${rootManifest.version}`) {
      throw new Error(`${value.name} package-lock dependency ${name} is not synchronized.`)
    }
  }
}

const changelog = await readFile(resolve(root, 'CHANGELOG.md'), 'utf8')
if (!changelog.includes(`## [${rootManifest.version}]`)) {
  throw new Error(`CHANGELOG.md has no ${rootManifest.version} release entry.`)
}
for (const topic of ['credential', 'model', 'TUI', 'Known limitations', 'Migration']) {
  if (!changelog.toLowerCase().includes(topic.toLowerCase())) {
    throw new Error(`CHANGELOG.md does not cover ${topic}.`)
  }
}
const protocolConstants = await readFile(
  resolve(root, 'packages/protocol/src/constants.ts'),
  'utf8',
)
if (!protocolConstants.includes(`PRAXIS_PRODUCT_VERSION = '${rootManifest.version}'`)) {
  throw new Error('Protocol product version is not synchronized.')
}

await access(resolve(root, 'LICENSE'))
await access(resolve(root, 'apps/cli/dist/cli.js'))
await access(resolve(root, 'apps/runtime/dist/entry.js'))
await access(resolve(root, 'apps/runtime/dist/run.js'))
verifyTaggedGitHubRun(tag)
process.stdout.write(`Release ${tag} metadata and build outputs are valid.\n`)

async function manifest(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'))
}

function optionValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function verifyTaggedGitHubRun(tag) {
  if (process.env.GITHUB_REF_TYPE !== 'tag' && !process.env.GITHUB_REF?.startsWith('refs/tags/')) {
    return
  }
  if (process.env.GITHUB_REF_NAME !== tag) {
    throw new Error(`GitHub release ref ${process.env.GITHUB_REF_NAME ?? 'unknown'} is not ${tag}.`)
  }
  const head = git(['rev-parse', 'HEAD'])
  const tagged = git(['rev-parse', `${tag}^{commit}`])
  if (head !== tagged) throw new Error(`Release tag ${tag} does not resolve to HEAD.`)
  if (git(['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('Release checkout is not clean.')
  }
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}
