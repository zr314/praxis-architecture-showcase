import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { PluginManifestV1 } from '@praxis/plugin-protocol'
import { EncryptedFileCredentialStore } from '../apps/runtime/src/credentials/encryptedCredentialStore.js'
import {
  provenancePayload,
  verifyPluginProvenance,
} from '../apps/runtime/src/extensions/pluginProvenance.js'
import {
  LinuxBubblewrapIsolationBackend,
  TrustedOnlyIsolationBackend,
} from '../apps/runtime/src/security/isolationBackend.js'
import {
  canonicalGrantPath,
  validateArchiveEntryPaths,
} from '../apps/runtime/src/security/pathSafety.js'

test('encrypted credential store migrates plaintext v1 and rejects ciphertext tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-credential-v2-'))
  const path = join(root, 'credentials.json')
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        credentials: [
          {
            provider: 'fixture',
            name: 'api_key',
            value: 'secret',
            updatedAt: new Date(0).toISOString(),
          },
        ],
      }),
      { encoding: 'utf8', mode: 0o600 },
    )
    const store = new EncryptedFileCredentialStore(root)
    assert.equal((await store.get('fixture', 'api_key'))?.value, 'secret')
    const encrypted = await readFile(path, 'utf8')
    assert.equal(encrypted.includes('secret'), false)
    const parsed = JSON.parse(encrypted)
    parsed.credentials[0].ciphertext = 'AAAA'
    await writeFile(path, JSON.stringify(parsed), { encoding: 'utf8', mode: 0o600 })
    await assert.rejects(store.get('fixture', 'api_key'), hasCode('CREDENTIAL_DECRYPT_FAILED'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('isolation backends never overclaim enforcement', async () => {
  const trusted = new TrustedOnlyIsolationBackend('fixture')
  assert.equal((await trusted.status()).level, 'degraded')
  await assert.rejects(
    trusted.prepare({
      command: process.execPath,
      pluginRoot: process.cwd(),
      workspace: process.cwd(),
      grants: [],
    }),
    hasCode('ISOLATION_TRUST_REQUIRED'),
  )
  const linux = new LinuxBubblewrapIsolationBackend(async () => undefined)
  assert.equal((await linux.status()).level, 'unavailable')
  const enforced = new LinuxBubblewrapIsolationBackend(async (name) => `/usr/bin/${name}`, 'linux')
  const launch = await enforced.prepare({
    command: '/usr/bin/node',
    args: ['/plugin/index.mjs'],
    pluginRoot: process.cwd(),
    workspace: process.cwd(),
    grants: [{ type: 'resource', cpuMs: 1_000, memoryMb: 64, processCount: 2 }],
  })
  assert.equal(launch.support.level, 'supported')
  assert.ok(launch.args.includes('--unshare-all'))
  assert.ok(launch.args.includes('--cpu=1'))
  assert.equal(launch.args.includes('--share-net'), false)
})

test('path and archive validation rejects escapes before execution', () => {
  const workspace = join(process.cwd(), 'fixture-workspace')
  assert.equal(canonicalGrantPath(workspace, 'inside.txt'), join(workspace, 'inside.txt'))
  assert.throws(
    () => canonicalGrantPath(workspace, join('..', 'escape.txt')),
    hasCode('GRANT_PATH_ESCAPE'),
  )
  assert.throws(
    () => validateArchiveEntryPaths(['safe/file.txt', '../escape']),
    hasCode('ARCHIVE_TRAVERSAL_REJECTED'),
  )
})

test('Ed25519 plugin provenance verifies content and detects executable substitution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-signed-plugin-'))
  try {
    await writeFile(join(root, 'index.mjs'), 'export const value = 1\n', 'utf8')
    const manifest: PluginManifestV1 = {
      manifestVersion: 1,
      id: 'example.signed',
      name: 'Signed',
      version: '1.0.0',
      apiVersion: 1,
      entry: 'index.mjs',
      isolation: 'process',
      capabilities: [{ id: 'signed.tool', kind: 'tool' }],
      grants: [],
    }
    const keys = generateKeyPairSync('ed25519')
    const signature = sign(
      null,
      Buffer.from(await provenancePayload(root, manifest)),
      keys.privateKey,
    )
    manifest.provenance = {
      algorithm: 'ed25519',
      keyId: 'test-key',
      signature: signature.toString('base64'),
    }
    assert.equal(
      await verifyPluginProvenance(
        root,
        manifest,
        [
          {
            keyId: 'test-key',
            publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          },
        ],
        true,
      ),
      'verified',
    )
    await writeFile(join(root, 'index.mjs'), 'export const value = 2\n', 'utf8')
    await assert.rejects(
      verifyPluginProvenance(
        root,
        manifest,
        [
          {
            keyId: 'test-key',
            publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          },
        ],
        true,
      ),
      hasCode('PLUGIN_SIGNATURE_INVALID'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
