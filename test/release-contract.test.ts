import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { artifactForTarget, assertTagVersion } from '../scripts/release-utils.mjs'
import {
  assertCanonicalReleaseTokenJob,
  assertDefaultSuccessJob,
  assertNoGitHubContextReference,
  assertNoSecretsOrProviderEnvironment,
  parseWorkflow,
  type Workflow,
} from './support/workflow-contract.js'

const ATTEST_BUILD_PROVENANCE =
  'actions/attest-build-provenance@78e6cbd37d0ac1a40113c04f2037dacf1ea3f12e'
const PUBLIC_REPOSITORY_ATTESTATION_CONDITION = 'github.event.repository.private == false'
const CANONICAL_GITHUB_TOKEN_EXPRESSION = `\${{ github.token }}`

type PackageManifest = {
  name: string
  version: string
  license?: string
  engines?: { node?: string }
  publishConfig?: { access?: string; registry?: string }
  repository?: { type?: string; url?: string }
  homepage?: string
  bugs?: { url?: string }
  scripts?: Record<string, string>
  devDependencies?: Record<string, string>
}

function validateReleaseWorkflow(source: string): void {
  const workflow: Workflow = parseWorkflow(source)
  const jobs = workflow.jobs ?? {}
  const verifySteps = jobs.verify?.steps ?? []
  const installIndex = verifySteps.findIndex((step) => step.run === 'npm ci')
  const supplyChainIndex = verifySteps.findIndex(
    (step) => step.run === 'npm run verify:supply-chain',
  )
  const packageIndex = verifySteps.findIndex((step) => step.run === 'npm run package:npm')
  const releaseCheckIndex = verifySteps.findIndex(
    (step) => step.run === 'npm run release:check -- --tag "$GITHUB_REF_NAME"',
  )
  const assembleRelease = jobs['assemble-release']
  const attestationStep = assembleRelease?.steps?.find(
    (step) => step.uses === ATTEST_BUILD_PROVENANCE,
  )
  const privateDispatchStep = jobs['finalize-release']?.steps?.find(
    (step) => step.name === 'Publish GitHub Release',
  )

  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(jobs.verify?.permissions, undefined)
  for (const jobId of ['verify', 'binaries', 'assemble-release', 'finalize-release']) {
    assertDefaultSuccessJob(jobs[jobId], jobId)
  }
  assert.equal(jobs['npm-publish'], undefined)
  assert.ok(installIndex >= 0)
  assert.equal(supplyChainIndex, installIndex + 1)
  assert.equal(packageIndex, supplyChainIndex + 1)
  assert.equal(releaseCheckIndex, packageIndex + 1)
  assert.equal(verifySteps[packageIndex]?.if, undefined)
  assert.equal(verifySteps[packageIndex]?.['continue-on-error'], undefined)
  assert.equal(
    verifySteps.some((step) => step.run === 'npm run check'),
    false,
  )
  assert.equal(
    verifySteps.some((step) => step.run === 'npm test'),
    false,
  )
  assert.equal(
    verifySteps.some((step) => step.run === 'npm run eval'),
    false,
  )
  assert.equal(jobs.binaries?.needs, 'verify')
  assert.deepEqual(jobs['assemble-release']?.needs, ['verify', 'binaries'])
  assert.equal(jobs['finalize-release']?.needs, 'assemble-release')
  assert.ok(privateDispatchStep)
  assert.deepEqual(privateDispatchStep?.env, { GH_TOKEN: CANONICAL_GITHUB_TOKEN_EXPRESSION })
  assert.match(privateDispatchStep?.run ?? '', /repos\/\$GITHUB_REPOSITORY\/dispatches/u)
  assert.match(privateDispatchStep?.run ?? '', /praxis_private_registry_publish/u)
  assert.match(privateDispatchStep?.run ?? '', /client_payload\[tag\]=\$GITHUB_REF_NAME/u)
  assert.equal(JSON.stringify(workflow).includes('npm-tarballs'), false)
  assert.equal(JSON.stringify(workflow).includes('artifacts/*.tgz'), false)
  assert.deepEqual(attestationStep, {
    name: 'Attest public release artifacts',
    if: PUBLIC_REPOSITORY_ATTESTATION_CONDITION,
    uses: ATTEST_BUILD_PROVENANCE,
    with: {
      'subject-path': 'artifacts/praxis-*',
    },
  })
  assertNoSecretsOrProviderEnvironment(workflow)
  assert.deepEqual(workflow.concurrency, {
    group: `release-\${{ github.ref }}`,
    'cancel-in-progress': false,
  })
  const { jobs: _jobs, concurrency: _concurrency, ...workflowOutsideJobs } = workflow
  assertNoGitHubContextReference(workflowOutsideJobs, 'release workflow')
  for (const [jobId, job] of Object.entries(jobs)) {
    if (jobId === 'assemble-release' || jobId === 'finalize-release') {
      const steps = job.steps?.map((step) => {
        if (step !== attestationStep) return step
        const { if: _condition, ...stepWithoutRepositoryCondition } = step
        return stepWithoutRepositoryCondition
      })
      assertCanonicalReleaseTokenJob({ ...job, steps }, jobId)
    } else {
      assertNoGitHubContextReference(job, `release job ${jobId}`)
    }
  }
}

function replaceRequired(source: string, before: string, after: string): string {
  assert.ok(source.includes(before), `mutation source not found: ${before}`)
  return source.replace(before, after)
}

const root = await readManifest('../package.json')
const repositoryManifestPaths = [
  '../package.json',
  '../apps/cli/package.json',
  '../apps/runtime/package.json',
  '../packages/core-sdk/package.json',
  '../packages/protocol/package.json',
  '../packages/plugin-protocol/package.json',
  '../packages/client/package.json',
  '../packages/plugin-sdk/package.json',
] as const

test('public packages use synchronized release and license metadata', async () => {
  assert.equal(root.version, '0.2.0')
  assert.equal(root.version.includes('-'), false)
  for (const path of repositoryManifestPaths.slice(1)) {
    const manifest = await readManifest(path)
    assert.equal(manifest.version, root.version, `${manifest.name} version`)
    assert.equal(manifest.license, 'Apache-2.0', `${manifest.name} license`)
    assert.equal(manifest.engines?.node, '>=22.13.0', `${manifest.name} Node engine`)
    assert.deepEqual(
      manifest.publishConfig,
      {
        access: 'restricted',
        registry: 'http://127.0.0.1:4873/',
      },
      `${manifest.name} private publish boundary`,
    )
  }
  const constants = await readFile(
    new URL('../packages/protocol/src/constants.ts', import.meta.url),
    'utf8',
  )
  assert.match(constants, new RegExp(`PRAXIS_PRODUCT_VERSION = '${root.version}'`, 'u'))
})

test('public packages identify the canonical GitHub repository', async () => {
  for (const path of repositoryManifestPaths) {
    const manifest = await readManifest(path)
    assert.deepEqual(manifest.repository, {
      type: 'git',
      url: 'git+https://github.com/uestc-Praxis/praxis.git',
    })
    assert.equal(manifest.homepage, 'https://github.com/uestc-Praxis/praxis#readme')
    assert.deepEqual(manifest.bugs, {
      url: 'https://github.com/uestc-Praxis/praxis/issues',
    })
  }
})

test('repository includes the canonical Apache License 2.0 text', async () => {
  const license = await readFile(new URL('../LICENSE', import.meta.url), 'utf8')
  assert.match(license, /Apache License/)
  assert.match(license, /Version 2\.0, January 2004/)
})

test('root exposes pinned static quality commands', async () => {
  assert.equal(
    root.scripts?.eval,
    'tsx --tsconfig tsconfig.check.json apps/runtime/src/evaluation/cli.ts',
  )
  assert.equal(root.scripts?.['format:check'], 'biome format .')
  assert.equal(root.scripts?.lint, 'biome lint .')
  assert.equal(root.scripts?.typecheck, 'tsc --project tsconfig.check.json --noEmit')
  assert.equal(root.scripts?.check, 'npm run format:check && npm run lint && npm run typecheck')
  assert.equal(root.devDependencies?.['@biomejs/biome'], '2.5.4')

  const biome = JSON.parse(await readFile(new URL('../biome.json', import.meta.url), 'utf8')) as {
    formatter?: { indentStyle?: string; lineEnding?: string }
  }
  assert.equal(biome.formatter?.indentStyle, 'space')
  assert.equal(biome.formatter?.lineEnding, 'auto')
})

test('root exposes deterministic packaging and release commands', () => {
  assert.equal(root.scripts?.['package:npm'], 'npm run build && npm run verify:pack')
  assert.equal(root.scripts?.['package:binary'], 'node scripts/package-binary.mjs')
  assert.equal(root.scripts?.['release:check'], 'node scripts/release-check.mjs')
  assert.equal(root.scripts?.['verify:checksums'], 'node scripts/verify-checksums.mjs')
})

test('release publication DAG is gated by deterministic packaging', async () => {
  const source = await readFile(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  )
  validateReleaseWorkflow(source)
})

test('release workflow carries only approved assets, accepted notes, and prerelease status', async () => {
  const source = await readFile(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(source, /npm pack --workspace|artifacts\/\*\.tgz|npm-tarballs/u)
  assert.match(source, /delete-asset/u)
  assert.match(source, /\*\.tgz/u)
  assert.match(source, /extract-release-notes\.mjs/u)
  assert.match(source, /npm run verify:checksums/u)
  assert.match(source, /--notes-file artifacts\/RELEASE_NOTES\.md/u)
  assert.match(source, /prerelease_flag="--prerelease"/u)
})

test('release workflow contract rejects publication gate and secret mutations', async () => {
  const raw = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const source = raw.replaceAll('\r\n', '\n')
  const mutations = [
    [
      'verify continue-on-error',
      replaceRequired(source, '  verify:\n', '  verify:\n    continue-on-error: true\n'),
    ],
    [
      'binaries always',
      replaceRequired(source, '  binaries:\n', '  binaries:\n    if: always()\n'),
    ],
    [
      'assemble always',
      replaceRequired(source, '  assemble-release:\n', '  assemble-release:\n    if: always()\n'),
    ],
    [
      'finalize explicit success override',
      replaceRequired(
        source,
        '  finalize-release:\n',
        `  finalize-release:\n    if: \${{ always() }}\n`,
      ),
    ],
    [
      'release verify Provider secret',
      replaceRequired(
        source,
        '  verify:\n',
        `  verify:\n    env:\n      NEW_PROVIDER_API_KEY: \${{ secrets.NEW_PROVIDER_API_KEY }}\n`,
      ),
    ],
    [
      'release verify bracket secret',
      replaceRequired(
        source,
        '  verify:\n',
        `  verify:\n    env:\n      MODEL_AUTH: \${{ secrets['MODEL_AUTH'] }}\n`,
      ),
    ],
    [
      'release binaries spaced bracket secret',
      replaceRequired(
        source,
        '  binaries:\n',
        `  binaries:\n    env:\n      CONFIG: \${{ secrets [ "X" ] }}\n`,
      ),
    ],
    [
      'release verify GitHub token',
      replaceRequired(
        source,
        '  verify:\n',
        `  verify:\n    env:\n      GH_TOKEN: \${{ github.token }}\n`,
      ),
    ],
    [
      'release verify bracket GitHub token',
      replaceRequired(
        source,
        '  verify:\n',
        `  verify:\n    env:\n      CI_TOKEN: \${{ github['token'] }}\n`,
      ),
    ],
    [
      'release verify compound GitHub token',
      replaceRequired(
        source,
        '  verify:\n',
        `  verify:\n    env:\n      CI_TOKEN: \${{ github.token || '' }}\n`,
      ),
    ],
    [
      'release token concatenation',
      replaceRequired(
        source,
        `          GH_TOKEN: \${{ github.token }}\n`,
        `          GH_TOKEN: release-\${{ github.token }}\n`,
      ),
    ],
    [
      'release token under noncanonical key',
      replaceRequired(
        source,
        `          GH_TOKEN: \${{ github.token }}\n`,
        `          RELEASE_TOKEN: \${{ github.token }}\n`,
      ),
    ],
    [
      'release whole secrets context',
      replaceRequired(
        source,
        '  verify:\n',
        `  verify:\n    env:\n      SECRET_CONTEXT: \${{ toJSON(secrets) }}\n`,
      ),
    ],
    [
      'release whole GitHub context',
      replaceRequired(
        source,
        '  binaries:\n',
        `  binaries:\n    env:\n      CONTEXT_JSON: \${{ toJSON(github) }}\n`,
      ),
    ],
    [
      'release dynamic GitHub key',
      replaceRequired(
        source,
        '  verify:\n',
        `  verify:\n    env:\n      CONTEXT_ITEM: \${{ github[format('{0}', 'token')] }}\n`,
      ),
    ],
    [
      'release bare secrets context',
      replaceRequired(
        source,
        '  verify:\n',
        `  verify:\n    env:\n      SECRET_CONTEXT: \${{ secrets }}\n`,
      ),
    ],
    [
      'release bare GitHub context',
      replaceRequired(
        source,
        '  verify:\n',
        `  verify:\n    env:\n      GITHUB_CONTEXT: \${{ github }}\n`,
      ),
    ],
    [
      'release concurrency compound GitHub context',
      replaceRequired(
        source,
        `  group: release-\${{ github.ref }}\n`,
        `  group: release-\${{ format('{0}', github.ref) }}\n`,
      ),
    ],
    [
      'release concurrency wrong GitHub property',
      replaceRequired(
        source,
        `  group: release-\${{ github.ref }}\n`,
        `  group: release-\${{ github.sha }}\n`,
      ),
    ],
    [
      'release concurrency noncanonical context case',
      replaceRequired(
        source,
        `  group: release-\${{ github.ref }}\n`,
        `  group: release-\${{ GitHub.ref }}\n`,
      ),
    ],
    [
      'release token noncanonical context case',
      replaceRequired(
        source,
        `          GH_TOKEN: \${{ github.token }}\n`,
        `          GH_TOKEN: \${{ GitHub.token }}\n`,
      ),
    ],
    [
      'nested secrets key',
      replaceRequired(source, 'jobs:\n', 'metadata:\n  nested:\n    secrets: fixture\n\njobs:\n'),
    ],
  ] as const

  for (const [name, mutated] of mutations) {
    assert.throws(() => validateReleaseWorkflow(mutated), name)
  }
})

test('release scanner accepts human-readable GitHub labels and ordinary metadata', async () => {
  const raw = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const source = raw.replaceAll('\r\n', '\n')
  const withOrdinaryMetadata = replaceRequired(
    source,
    'jobs:\n',
    'metadata:\n  nested:\n    github: GitHub release metadata\n    context: secrets inventory\n\njobs:\n',
  )

  assert.match(source, /name: Publish GitHub Release/u)
  assert.doesNotThrow(() => validateReleaseWorkflow(withOrdinaryMetadata))
})

test('standalone targets map to exact Bun targets and artifact names', () => {
  assert.deepEqual(artifactForTarget('windows-x64', root.version), {
    platform: 'win32',
    arch: 'x64',
    bunTarget: 'bun-windows-x64-baseline',
    compilerPackage: '@oven/bun-windows-x64-baseline',
    filename: `praxis-${root.version}-windows-x64.exe`,
  })
  assert.deepEqual(artifactForTarget('linux-x64', root.version), {
    platform: 'linux',
    arch: 'x64',
    bunTarget: 'bun-linux-x64-baseline',
    compilerPackage: '@oven/bun-linux-x64-baseline',
    filename: `praxis-${root.version}-linux-x64`,
  })
  assert.deepEqual(artifactForTarget('darwin-x64', root.version), {
    platform: 'darwin',
    arch: 'x64',
    bunTarget: 'bun-darwin-x64-baseline',
    compilerPackage: '@oven/bun-darwin-x64-baseline',
    filename: `praxis-${root.version}-darwin-x64`,
  })
  assert.deepEqual(artifactForTarget('darwin-arm64', root.version), {
    platform: 'darwin',
    arch: 'arm64',
    bunTarget: 'bun-darwin-arm64',
    compilerPackage: '@oven/bun-darwin-aarch64',
    filename: `praxis-${root.version}-darwin-arm64`,
  })
  assert.throws(() => artifactForTarget('freebsd-x64', root.version), /Unsupported binary target/)
})

test('release tags must exactly match the synchronized package version', () => {
  assert.doesNotThrow(() => assertTagVersion(`v${root.version}`, root.version))
  assert.doesNotThrow(() => assertTagVersion('v1.2.3', '1.2.3'))
  assert.throws(() => assertTagVersion(root.version, root.version), /valid semantic version tag/)
  assert.throws(() => assertTagVersion('v0.1.0-01', '0.1.0-01'), /valid semantic version tag/)
  assert.throws(() => assertTagVersion('v0.1.1', root.version), /does not match/)
})

test('release changelog covers the current user contract and migration boundaries', async () => {
  const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  assert.match(changelog, new RegExp(`## \\[${root.version.replaceAll('.', '\\.')}\\]`, 'u'))
  for (const topic of [
    'praxis',
    'TUI',
    'credentials',
    'Provider/model',
    'Known limitations',
    'Migration',
    'trusted-only',
  ]) {
    assert.match(changelog, new RegExp(topic, 'iu'))
  }
  const releaseNotes = await readFile(
    new URL('../scripts/extract-release-notes.mjs', import.meta.url),
    'utf8',
  )
  assert.match(releaseNotes, /CHANGELOG\.md/u)
  assert.match(releaseNotes, /RELEASE_NOTES\.md/u)
  const checksums = await readFile(
    new URL('../scripts/generate-checksums.mjs', import.meta.url),
    'utf8',
  )
  assert.match(checksums, /entry\.name\.includes\(version\)/u)
})

test('repository operations policy covers ownership, updates, contribution, and security', async () => {
  const codeowners = await readFile(new URL('../.github/CODEOWNERS', import.meta.url), 'utf8')
  const dependabot = await readFile(new URL('../.github/dependabot.yml', import.meta.url), 'utf8')
  const contributing = await readFile(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8')
  const security = await readFile(new URL('../SECURITY.md', import.meta.url), 'utf8')

  assert.match(codeowners, /^\* @zr314/mu)
  assert.match(dependabot, /package-ecosystem: "npm"/u)
  assert.match(dependabot, /package-ecosystem: "github-actions"/u)
  assert.match(contributing, /npm run package:npm/u)
  assert.match(contributing, new RegExp(`v${root.version.replaceAll('.', '\\.')}`, 'u'))
  assert.match(security, /private vulnerability reporting/iu)
  assert.match(security, /credentials|API keys/iu)
})

async function readManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as PackageManifest
}
