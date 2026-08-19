import { createHash, createPublicKey, verify } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { runtimeError } from '@praxis/core-sdk'
import type { PluginManifestV1 } from '@praxis/plugin-protocol'

export type TrustedPluginKey = {
  keyId: string
  publicKeyPem: string
}

export async function verifyPluginProvenance(
  root: string,
  manifest: PluginManifestV1,
  trustedKeys: readonly TrustedPluginKey[],
  required: boolean,
): Promise<'verified' | 'unsigned'> {
  if (!manifest.provenance) {
    if (required) throw provenanceError('PLUGIN_SIGNATURE_REQUIRED')
    return 'unsigned'
  }
  const trusted = trustedKeys.find((key) => key.keyId === manifest.provenance?.keyId)
  if (!trusted) throw provenanceError('PLUGIN_SIGNING_KEY_UNTRUSTED')
  const valid = verify(
    null,
    Buffer.from(await provenancePayload(root, manifest), 'utf8'),
    createPublicKey(trusted.publicKeyPem),
    Buffer.from(manifest.provenance.signature, 'base64'),
  )
  if (!valid) throw provenanceError('PLUGIN_SIGNATURE_INVALID')
  return 'verified'
}

export async function provenancePayload(root: string, manifest: PluginManifestV1): Promise<string> {
  const hash = createHash('sha256')
  for (const path of await walk(root)) {
    const name = relative(root, path).split(sep).join('/')
    if (name === 'praxis-plugin.json') continue
    hash.update(name)
    hash.update('\0')
    hash.update(await readFile(path))
    hash.update('\0')
  }
  const { provenance: _provenance, ...unsignedManifest } = manifest
  return `${JSON.stringify(unsignedManifest)}\nsha256:${hash.digest('hex')}`
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw provenanceError('PLUGIN_SYMLINK_REJECTED')
      if (metadata.isDirectory()) await visit(path)
      else if (metadata.isFile()) files.push(path)
    }
  }
  await visit(root)
  return files
}

function provenanceError(code: string) {
  return runtimeError(code, 'plugin', `Plugin provenance failed (${code}).`)
}
