import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parseWorkflow, type Workflow } from './support/workflow-contract.js'

const require = createRequire(import.meta.url)
const { load: loadYaml } = require('js-yaml') as { load(source: string): unknown }

type ExtendedWorkflow = Workflow & {
  on?: {
    release?: { types?: string[] }
    repository_dispatch?: { types?: string[] }
    workflow_dispatch?: {
      inputs?: Record<string, { required?: boolean; type?: string }>
    }
  }
}

type ComposeConfig = {
  services?: Record<
    string,
    {
      image?: string
      ports?: string[]
      restart?: string
      healthcheck?: unknown
      volumes?: string[]
    }
  >
  volumes?: Record<string, unknown>
}

type VerdaccioConfig = {
  auth?: { htpasswd?: { file?: string; max_users?: number } }
  uplinks?: Record<string, { url?: string }>
  packages?: Record<
    string,
    { access?: string; publish?: string; unpublish?: string; proxy?: string }
  >
}

test('private publication runs only on the dedicated Windows registry runner', async () => {
  const source = await readFile(
    new URL('../.github/workflows/private-registry-publish.yml', import.meta.url),
    'utf8',
  )
  const workflow = parseWorkflow(source) as ExtendedWorkflow
  const publish = workflow.jobs?.publish
  const serialized = JSON.stringify(workflow)

  assert.deepEqual(workflow.on?.release?.types, ['published'])
  assert.deepEqual(workflow.on?.repository_dispatch?.types, ['praxis_private_registry_publish'])
  assert.deepEqual(workflow.on?.workflow_dispatch?.inputs?.tag, {
    description: 'Release tag to publish, for example v0.1.0',
    required: true,
    type: 'string',
  })
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.deepEqual(publish?.['runs-on'], [
    'self-hosted',
    'Windows',
    'X64',
    'praxis-private-registry',
  ])
  assert.match(serialized, /github\.event\.release\.tag_name/u)
  assert.match(serialized, /github\.event\.client_payload\.tag/u)
  assert.match(serialized, /inputs\.tag/u)
  assert.match(serialized, /npm ci/u)
  assert.match(serialized, /npm run verify:supply-chain/u)
  assert.match(serialized, /npm run package:npm/u)
  assert.match(serialized, /npm run release:check/u)
  assert.match(serialized, /vars\.PRAXIS_NPM_REGISTRY_URL/u)
  assert.match(serialized, /secrets\.PRAXIS_NPM_TOKEN/u)
  assert.match(serialized, /NPM_CONFIG_USERCONFIG/u)
  assert.match(serialized, /npm run release:publish/u)
  assert.equal(
    publish?.steps?.some((step) => step.if === 'always()' && step.run?.includes('Remove-Item')),
    true,
  )
  assert.doesNotMatch(source, /registry\.npmjs\.org/iu)
  assert.doesNotMatch(serialized, /contents["']?:["']?write/iu)
})

test('Verdaccio is persistent, loopback-only, authenticated, and never proxies Praxis', async () => {
  const [composeSource, configSource] = await Promise.all([
    readFile(new URL('../infra/verdaccio/docker-compose.yml', import.meta.url), 'utf8'),
    readFile(new URL('../infra/verdaccio/config/config.yaml', import.meta.url), 'utf8'),
  ])
  const compose = loadYaml(composeSource) as ComposeConfig
  const config = loadYaml(configSource) as VerdaccioConfig
  const service = compose.services?.verdaccio
  const praxis = config.packages?.['@praxis/*']
  const dependencies = config.packages?.['**']

  assert.ok(service)
  assert.match(service.image ?? '', /^verdaccio\/verdaccio:6\.[^@]+@sha256:[a-f0-9]{64}$/u)
  assert.deepEqual(service.ports, ['127.0.0.1:4873:4873'])
  assert.equal(service.restart, 'unless-stopped')
  assert.ok(service.healthcheck)
  assert.equal(
    service.volumes?.some((entry) => entry.endsWith(':/verdaccio/storage')),
    true,
  )
  assert.ok(Object.keys(compose.volumes ?? {}).length > 0)

  assert.equal(config.auth?.htpasswd?.file, '/verdaccio/storage/htpasswd')
  assert.equal(config.auth?.htpasswd?.max_users, 1)
  assert.deepEqual(praxis, {
    access: '$authenticated',
    publish: '$authenticated',
    unpublish: '$authenticated',
  })
  assert.equal(dependencies?.proxy, 'npmjs')
  assert.equal(config.uplinks?.npmjs?.url, 'https://registry.npmjs.org/')
})

test('release metadata gate enforces the private registry boundary', async () => {
  const source = await readFile(new URL('../scripts/release-check.mjs', import.meta.url), 'utf8')

  assert.match(source, /const privateRegistry = 'http:\/\/127\.0\.0\.1:4873\/'/u)
  assert.match(source, /publishConfig\?\.access !== 'restricted'/u)
  assert.match(source, /publishConfig\?\.registry !== privateRegistry/u)
  assert.doesNotMatch(source, /publishConfig\?\.access !== 'public'/u)
  assert.match(source, /private Apache-2\.0 release metadata/u)
})
