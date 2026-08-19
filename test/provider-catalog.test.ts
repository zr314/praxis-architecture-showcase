import assert from 'node:assert/strict'
import test from 'node:test'
import { createBuiltinProviders } from '../apps/runtime/src/llm-provider/builtinProviders.js'
import { MODEL_CATALOG_SOURCES, ModelCatalog } from '../apps/runtime/src/providers/modelCatalog.js'

test('reviewed catalog sources have unique models, valid defaults, adapters, and limits', () => {
  const catalog = new ModelCatalog()
  const providers = new Set(createBuiltinProviders().map(({ id }) => id))
  const keys = new Set<string>()

  for (const source of catalog.sources()) {
    assert.ok(MODEL_CATALOG_SOURCES.some(({ provider }) => provider === source.provider))
    assert.ok(providers.has(source.provider), `${source.provider} has no registered Provider`)
    assert.ok(source.modelIds.includes(source.defaultModel))
    assert.match(source.retrievedAt, /^\d{4}-\d{2}-\d{2}$/)
    for (const model of catalog.list(source.provider)) {
      const key = `${model.provider}/${model.id}`
      assert.equal(keys.has(key), false, key)
      keys.add(key)
      assert.equal(model.family, source.apiFamily)
      assert.ok((model.capabilities.limits.maxContextTokens ?? 0) > 0)
      assert.ok((model.capabilities.limits.maxOutputTokens ?? 0) > 0)
      assert.ok(Array.isArray(model.aliases))
      assert.ok(['active', 'deprecated'].includes(model.lifecycle))
      assert.equal(model.source, source.origin)
      assert.equal(model.retrievedAt, source.retrievedAt)
    }
  }
})

test('the process catalog is immutable and rejects duplicate entries', () => {
  const catalog = new ModelCatalog()
  const first = catalog.list()[0]!
  first.aliases.push('mutated')
  first.capabilities.limits.maxContextTokens = 1

  assert.equal(catalog.resolve(first.provider, first.id)?.aliases.includes('mutated'), false)
  assert.notEqual(
    catalog.resolve(first.provider, first.id)?.capabilities.limits.maxContextTokens,
    1,
  )
  assert.equal('register' in catalog, false)
  assert.throws(() => new ModelCatalog([...catalog.list(), catalog.list()[0]!]), /Duplicate model/)
})

test('Kimi exposes the complete reviewed snapshot rather than one default model', () => {
  const models = new ModelCatalog().list('kimi')
  assert.equal(models.length, 10)
  assert.ok(models.some(({ id }) => id === 'kimi-k2.6'))
  assert.ok(models.some(({ id }) => id === 'kimi-k3'))
})

test('DeepSeek exposes only active V4 API model names', () => {
  const models = new ModelCatalog().list('deepseek')
  assert.deepEqual(
    models.map(({ id }) => id),
    ['deepseek-v4-flash', 'deepseek-v4-pro'],
  )
  assert.equal(
    models.some(({ id }) => ['deepseek-chat', 'deepseek-reasoner'].includes(id)),
    false,
  )
})
