import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserSettingsStore } from '../apps/runtime/src/settings/index.js'

test('user settings atomically remember the last selected provider and model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-settings-'))
  try {
    const store = new UserSettingsStore(root)
    assert.equal(await store.defaultModel(), undefined)

    await store.setDefaultModel('kimi', 'kimi-k2.5')
    await store.setDefaultModel('kimi', 'kimi-k3')

    const preference = await new UserSettingsStore(root).defaultModel()
    assert.equal(preference?.provider, 'kimi')
    assert.equal(preference?.model, 'kimi-k3')
    assert.equal(Number.isFinite(Date.parse(preference?.updatedAt ?? '')), true)

    const serialized = await readFile(join(root, 'settings.json'), 'utf8')
    assert.doesNotMatch(serialized, /api.?key/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('invalid user settings fall back safely and are repaired on the next selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-settings-invalid-'))
  try {
    await writeFile(join(root, 'settings.json'), '{not-json', 'utf8')
    const store = new UserSettingsStore(root)
    assert.equal(await store.defaultModel(), undefined)
    await store.setDefaultModel('mock', 'mock-v1')
    assert.equal((await store.defaultModel())?.model, 'mock-v1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
