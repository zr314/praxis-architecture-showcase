import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export const PRIVATE_REGISTRY_URL = 'http://127.0.0.1:4873/'

export const WORKSPACES = [
  '@praxis/core-sdk',
  '@praxis/protocol',
  '@praxis/plugin-protocol',
  '@praxis/client',
  '@praxis/plugin-sdk',
  '@praxis/runtime',
  '@praxis/cli',
]

export function resolveNpmInvocation({ execPath, npmExecPath }) {
  if (typeof execPath !== 'string' || !isAbsolute(execPath)) {
    throw new Error('An absolute Node executable path is required.')
  }
  if (typeof npmExecPath !== 'string' || !isAbsolute(npmExecPath)) {
    throw new Error('An absolute npm CLI path is required.')
  }
  return {
    command: execPath,
    prefixArgs: [npmExecPath],
  }
}

export function resolvePrivateRegistry(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Praxis private registry URL is required.')
  }
  let registry
  try {
    registry = new URL(value)
  } catch {
    throw new Error('Praxis private registry URL is invalid.')
  }
  if (registry.username || registry.password || registry.search || registry.hash) {
    throw new Error('Praxis private registry URL must not contain credentials or metadata.')
  }
  if (registry.href !== PRIVATE_REGISTRY_URL) {
    throw new Error(`Praxis private registry must be ${PRIVATE_REGISTRY_URL}`)
  }
  return registry.href
}

export async function publishWorkspaces({
  version,
  registry,
  runNpm,
  writeOutput = (message) => process.stdout.write(message),
}) {
  const privateRegistry = resolvePrivateRegistry(registry)
  const distTag = version.includes('-') ? 'next' : 'latest'
  const staging = await mkdtemp(join(tmpdir(), 'praxis-publish-'))

  try {
    for (const workspace of WORKSPACES) {
      const packed = runNpm([
        'pack',
        '--json',
        '--workspace',
        workspace,
        '--pack-destination',
        staging,
      ])
      assertNpmSuccess(packed, `pack ${workspace}`)
      const [manifest] = JSON.parse(packed.stdout)
      if (typeof manifest?.filename !== 'string' || typeof manifest?.integrity !== 'string') {
        throw new Error(`npm pack returned invalid metadata for ${workspace}.`)
      }

      const published = runNpm(
        [
          'view',
          `${workspace}@${version}`,
          'dist.integrity',
          '--json',
          '--registry',
          privateRegistry,
        ],
        true,
      )
      if (published.status === 0) {
        const integrity = JSON.parse(published.stdout)
        if (integrity !== manifest.integrity) {
          throw new Error(`${workspace}@${version} exists with different package integrity.`)
        }
        writeOutput(`Skipping identical ${workspace}@${version}.\n`)
        continue
      }
      if (!/\bE404\b/u.test(published.stderr)) {
        throw new Error(`Unable to inspect ${workspace}@${version}: ${published.stderr.trim()}`)
      }

      const result = runNpm([
        'publish',
        resolve(staging, manifest.filename),
        '--access',
        'restricted',
        '--tag',
        distTag,
        '--registry',
        privateRegistry,
      ])
      assertNpmSuccess(result, `publish ${workspace}@${version}`)
      writeOutput(`Published ${workspace}@${version} with dist-tag ${distTag}.\n`)
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

function assertNpmSuccess(result, operation) {
  if (result.status !== 0) {
    throw new Error(`npm ${operation} failed: ${result.stderr.trim()}`)
  }
}
