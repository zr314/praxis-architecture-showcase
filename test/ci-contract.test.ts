import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  assertDefaultSuccessJob,
  assertNoGitHubContextReference,
  assertNoSecretsOrProviderEnvironment,
  parseWorkflow,
} from './support/workflow-contract.js'

function validateCiWorkflow(source: string): void {
  const workflow = parseWorkflow(source)
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  const jobs = workflow.jobs ?? {}
  assert.deepEqual(Object.keys(jobs), ['quality'])
  const qualityJob = jobs.quality
  assertDefaultSuccessJob(qualityJob, 'quality')
  assert.equal(qualityJob.permissions, undefined)
  assert.equal(qualityJob['runs-on'], 'ubuntu-latest')
  assert.equal(qualityJob.needs, undefined)
  assert.equal(
    qualityJob.steps?.find((step) => step.uses?.startsWith('actions/setup-node@'))?.with?.[
      'node-version'
    ],
    24,
  )
  const steps = qualityJob.steps ?? []
  const installIndex = steps.findIndex((step) => step.run === 'npm ci')
  const checkIndex = steps.findIndex((step) => step.run === 'npm run check')
  const testIndex = steps.findIndex((step) => step.run === 'npm test')
  const buildIndex = steps.findIndex((step) => step.run === 'npm run build')

  for (const step of steps) {
    assert.equal(step.if, undefined)
    assert.equal(step['continue-on-error'], undefined)
  }
  assert.ok(installIndex >= 0)
  assert.equal(checkIndex, installIndex + 1)
  assert.equal(testIndex, checkIndex + 1)
  assert.equal(buildIndex, testIndex + 1)
  assert.equal(steps.length, buildIndex + 1)
  assertNoSecretsOrProviderEnvironment(workflow)
  assert.deepEqual(workflow.concurrency, {
    group: `ci-\${{ github.event.pull_request.number || github.ref }}`,
    'cancel-in-progress': true,
  })
  const { concurrency: _concurrency, ...workflowWithoutConcurrency } = workflow
  assertNoGitHubContextReference(workflowWithoutConcurrency, 'CI workflow')
}

function replaceRequired(source: string, before: string, after: string): string {
  assert.ok(source.includes(before), `mutation source not found: ${before}`)
  return source.replace(before, after)
}

test('CI workflow has one concise quality gate', async () => {
  const source = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  validateCiWorkflow(source)
})

test('CI workflow contract rejects gating and security mutations', async () => {
  const raw = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const source = raw.replaceAll('\r\n', '\n')
  const mutations = [
    [
      'build continue-on-error',
      replaceRequired(
        source,
        '      - run: npm run build\n',
        '      - run: npm run build\n        continue-on-error: true\n',
      ),
    ],
    ['quality always', replaceRequired(source, '  quality:\n', '  quality:\n    if: always()\n')],
    [
      'write-all permission',
      replaceRequired(source, '  quality:\n', '  quality:\n    permissions: write-all\n'),
    ],
    [
      'Provider secret environment',
      replaceRequired(
        source,
        '  quality:\n',
        `  quality:\n    env:\n      NEW_PROVIDER_API_KEY: \${{ secrets.NEW_PROVIDER_API_KEY }}\n`,
      ),
    ],
    [
      'bracket GitHub token',
      replaceRequired(
        source,
        '  quality:\n',
        `  quality:\n    env:\n      CI_TOKEN: \${{ github['token'] }}\n`,
      ),
    ],
    [
      'implicit GitHub if expression',
      replaceRequired(
        source,
        '      - run: npm ci\n',
        "      - run: npm ci\n        if: github.ref == 'refs/heads/main'\n",
      ),
    ],
    [
      'job inherits secrets',
      replaceRequired(source, 'jobs:\n', 'jobs:\n  inherited-secrets:\n    secrets: inherit\n'),
    ],
    [
      'reusable workflow declares secrets',
      replaceRequired(
        source,
        'on:\n',
        'on:\n  workflow_call:\n    secrets:\n      auth:\n        required: true\n',
      ),
    ],
    ['test step removed', replaceRequired(source, '      - run: npm test\n', '')],
  ] as const

  for (const [name, mutated] of mutations) {
    assert.throws(() => validateCiWorkflow(mutated), name)
  }
})

test('CI workflow scanner accepts uppercase GitHub shell environment names', async () => {
  const raw = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const source = raw.replaceAll('\r\n', '\n')
  const withShellEnvironment = replaceRequired(
    source,
    'permissions:\n',
    'env:\n  GITHUB_REF_NAME: fixture\n  COMMAND: echo "$GITHUB_REF_NAME"\n\npermissions:\n',
  )

  assert.doesNotThrow(() => validateCiWorkflow(withShellEnvironment))
})

test('CI does not duplicate release packaging or supply-chain jobs', async () => {
  const source = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const workflow = parseWorkflow(source)
  const runs = (workflow.jobs?.quality?.steps ?? []).map((step) => step.run)

  assert.equal(runs.includes('npm run package:npm'), false)
  assert.equal(runs.includes('npm run verify:supply-chain'), false)
  assert.equal(
    runs.some((run) => run?.includes('packaged monorepo smoke') === true),
    false,
  )
})

test('test discovery and YAML parsing are direct shell-independent contracts', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> }

  assert.equal(manifest.scripts?.test, 'node scripts/run-tests.mjs')
  assert.equal(
    manifest.scripts?.['test:compat'],
    'node scripts/run-tests.mjs --suite compatibility',
  )
  assert.doesNotMatch(manifest.scripts?.test ?? '', /[*?]/u)
  assert.equal(manifest.devDependencies?.['js-yaml'], '4.3.0')
})

test('release workflow builds native targets and excludes private publication', async () => {
  const source = await readFile(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  )
  const workflow = parseWorkflow(source)
  const jobs = workflow.jobs ?? {}
  const targets = (jobs.binaries?.strategy?.matrix?.include as Array<Record<string, unknown>>) ?? []

  assert.deepEqual(workflow.on?.push?.tags, ['v*'])
  assert.equal(workflow.concurrency?.['cancel-in-progress'], false)
  assert.deepEqual(
    targets.map((entry) => entry.target),
    ['windows-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64'],
  )
  assert.deepEqual(
    targets.map((entry) => entry.runner),
    ['windows-latest', 'ubuntu-latest', 'macos-15-intel', 'macos-15'],
  )
  assert.deepEqual(jobs['assemble-release']?.permissions, {
    contents: 'write',
    'id-token': 'write',
    attestations: 'write',
  })
  assert.equal(jobs['npm-publish'], undefined)
  assert.equal(jobs['finalize-release']?.needs, 'assemble-release')
  assert.equal(JSON.stringify(workflow).includes('NPM_TOKEN'), false)
})
