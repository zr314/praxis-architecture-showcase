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
  assert.deepEqual(Object.keys(jobs), ['package'])
  const packageJob = jobs.package
  assertDefaultSuccessJob(packageJob, 'package')
  assert.equal(packageJob.permissions, undefined)
  assert.equal(packageJob['runs-on'], 'ubuntu-latest')
  assert.equal(packageJob.needs, undefined)
  assert.equal(
    packageJob.steps?.find((step) => step.uses?.startsWith('actions/setup-node@'))?.with?.[
      'node-version'
    ],
    24,
  )
  const steps = packageJob.steps ?? []
  const installIndex = steps.findIndex((step) => step.run === 'npm ci')
  const supplyChainIndex = steps.findIndex((step) => step.run === 'npm run verify:supply-chain')
  const packageIndex = steps.findIndex((step) => step.run === 'npm run package:npm')
  const importIndex = steps.findIndex(
    (step) =>
      step.run?.includes("await import('@praxis/core-sdk')") === true &&
      step.run.includes("await import('@praxis/runtime')"),
  )
  const smokeIndex = steps.findIndex(
    (step) => step.run?.includes('packaged monorepo smoke') === true,
  )

  for (const step of steps) {
    assert.equal(step.if, undefined)
    assert.equal(step['continue-on-error'], undefined)
  }
  assert.ok(installIndex >= 0)
  assert.equal(supplyChainIndex, installIndex + 1)
  assert.equal(packageIndex, supplyChainIndex + 1)
  assert.equal(importIndex, packageIndex + 1)
  assert.equal(smokeIndex, importIndex + 1)
  assert.equal(
    steps.some((step) => step.run === 'npm test'),
    false,
  )
  assert.equal(
    steps.some((step) => step.run === 'npm run test:compat'),
    false,
  )
  assert.equal(
    steps.some((step) => step.run === 'npm run check'),
    false,
  )
  assert.equal(
    steps.some((step) => step.run === 'npm run eval'),
    false,
  )
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

test('CI workflow satisfies the packaging contract', async () => {
  const source = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  validateCiWorkflow(source)
})

test('CI workflow contract rejects gating and security mutations', async () => {
  const raw = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const source = raw.replaceAll('\r\n', '\n')
  const mutations = [
    [
      'package continue-on-error',
      replaceRequired(
        source,
        '      - run: npm run package:npm\n',
        '      - run: npm run package:npm\n        continue-on-error: true\n',
      ),
    ],
    ['package always', replaceRequired(source, '  package:\n', '  package:\n    if: always()\n')],
    [
      'write-all permission',
      replaceRequired(source, '  package:\n', '  package:\n    permissions: write-all\n'),
    ],
    [
      'Provider secret environment',
      replaceRequired(
        source,
        '  package:\n',
        `  package:\n    env:\n      NEW_PROVIDER_API_KEY: \${{ secrets.NEW_PROVIDER_API_KEY }}\n`,
      ),
    ],
    [
      'bracket GitHub token',
      replaceRequired(
        source,
        '  package:\n',
        `  package:\n    env:\n      CI_TOKEN: \${{ github['token'] }}\n`,
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
    ['package step removed', replaceRequired(source, '      - run: npm run package:npm\n', '')],
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

test('CI smoke imports the current Praxis workspace packages', async () => {
  const source = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const workflow = parseWorkflow(source)
  const runs = (workflow.jobs?.package?.steps ?? []).map((step) => step.run)

  assert.equal(runs.includes("await import('@taichu/core-sdk')"), false)
  assert.equal(
    runs.some(
      (run) =>
        run?.includes("await import('@praxis/core-sdk')") === true &&
        run.includes("await import('@praxis/protocol')"),
    ),
    true,
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
