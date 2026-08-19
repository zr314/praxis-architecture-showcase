import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SessionStepProjectionV3, SubagentResultV1 } from '@praxis/core-sdk'
import {
  ControlledWorkspaceMergeV1,
  type WorkspaceMergeArtifactV1,
} from '../apps/runtime/src/planner/controlledWorkspaceMerge.js'
import type { SupervisorVerifierV1 } from '../apps/runtime/src/planner/verifier.js'
import {
  GitCliCommandPortV1,
  WorkspaceIsolationManagerV1,
} from '../apps/runtime/src/planner/workspaceIsolationManager.js'

const COPY_POLICY = { ignored: 'exclude', secrets: 'exclude' } as const

test('controlled merge validates an isolated commit, fast-forwards main, verifies, and cleans up', async () => {
  const fixture = await repository()
  try {
    await installHooks(fixture.repoRoot)
    const prepared = await prepareWorker(fixture, 'merge-success')
    const coordinator = mergeCoordinator(fixture.manager)
    const outcome = await coordinator.execute({
      step: writeStep(),
      isolation: prepared.isolation,
      artifact: prepared.artifact,
    })

    assert.equal(outcome.status, 'succeeded')
    assert.equal(outcome.code, 'WORKSPACE_MERGED_AND_VERIFIED')
    assert.equal(
      (await git(fixture.repoRoot, ['rev-parse', 'HEAD'])).stdout.trim(),
      prepared.commit,
    )
    assert.equal(
      (await readFile(join(fixture.repoRoot, 'src', 'tracked.txt'), 'utf8')).replaceAll(
        '\r\n',
        '\n',
      ),
      'worker\n',
    )
    assert.equal(await lstat(prepared.isolation.targetPath).catch(() => undefined), undefined)
    assert.equal(await lstat(join(fixture.repoRoot, 'hook-ran')).catch(() => undefined), undefined)
    assert.equal(
      await lstat(join(fixture.repoRoot, 'merge-hook-ran')).catch(() => undefined),
      undefined,
    )
    assert.equal(outcome.recovery, undefined)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('a stale main base blocks before merge and retains the worktree', async () => {
  const fixture = await repository()
  try {
    const prepared = await prepareWorker(fixture, 'merge-stale')
    await writeFile(join(fixture.repoRoot, 'main.txt'), 'main change\n', 'utf8')
    await git(fixture.repoRoot, ['add', 'main.txt'])
    await git(fixture.repoRoot, ['commit', '-m', 'advance main'])
    const mainHead = (await git(fixture.repoRoot, ['rev-parse', 'HEAD'])).stdout.trim()

    const outcome = await mergeCoordinator(fixture.manager).execute({
      step: writeStep(),
      isolation: prepared.isolation,
      artifact: prepared.artifact,
    })
    assert.equal(outcome.status, 'blocked')
    assert.equal(outcome.code, 'WORKSPACE_BASE_STALE')
    assert.equal((await git(fixture.repoRoot, ['rev-parse', 'HEAD'])).stdout.trim(), mainHead)
    assert.equal((await lstat(prepared.isolation.targetPath)).isDirectory(), true)
    assert.equal(outcome.recovery?.worktreePath, prepared.isolation.targetPath)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('scope violations and mismatched patch evidence never mutate main', async () => {
  const fixture = await repository()
  try {
    const prepared = await prepareWorker(fixture, 'merge-preflight')
    const coordinator = mergeCoordinator(fixture.manager)
    const scopeOutcome = await coordinator.execute({
      step: { ...writeStep(), access: { mode: 'workspace_write', paths: ['docs'] } },
      isolation: prepared.isolation,
      artifact: prepared.artifact,
    })
    assert.equal(scopeOutcome.code, 'WORKSPACE_MERGE_SCOPE_VIOLATION')
    assert.equal(
      (await git(fixture.repoRoot, ['rev-parse', 'HEAD'])).stdout.trim(),
      fixture.baseCommit,
    )

    const content = `${prepared.artifact.patch.content}\n`
    const mismatch: WorkspaceMergeArtifactV1 = {
      ...prepared.artifact,
      patch: {
        ...prepared.artifact.patch,
        content,
        bytes: Buffer.byteLength(content),
        digest: sha256(content),
      },
    }
    const patchOutcome = await coordinator.execute({
      step: writeStep(),
      isolation: prepared.isolation,
      artifact: mismatch,
    })
    assert.equal(patchOutcome.code, 'WORKSPACE_PATCH_MISMATCH')
    assert.equal(
      (await git(fixture.repoRoot, ['rev-parse', 'HEAD'])).stdout.trim(),
      fixture.baseCommit,
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('dirty main workspace blocks without overwriting user files', async () => {
  const fixture = await repository()
  try {
    const prepared = await prepareWorker(fixture, 'merge-dirty-main')
    await writeFile(join(fixture.repoRoot, 'user.txt'), 'user\n', 'utf8')
    const outcome = await mergeCoordinator(fixture.manager).execute({
      step: writeStep(),
      isolation: prepared.isolation,
      artifact: prepared.artifact,
    })
    assert.equal(outcome.code, 'WORKSPACE_MAIN_DIRTY')
    assert.equal(await readFile(join(fixture.repoRoot, 'user.txt'), 'utf8'), 'user\n')
    assert.equal(
      (await git(fixture.repoRoot, ['rev-parse', 'HEAD'])).stdout.trim(),
      fixture.baseCommit,
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('post-merge verifier failure retains the worktree and actionable recovery context', async () => {
  const fixture = await repository()
  try {
    const prepared = await prepareWorker(fixture, 'merge-verify-fail')
    const outcome = await mergeCoordinator(fixture.manager, failed('mechanical')).execute({
      step: writeStep(),
      isolation: prepared.isolation,
      artifact: prepared.artifact,
    })
    assert.equal(outcome.status, 'blocked')
    assert.equal(outcome.code, 'WORKSPACE_POST_MERGE_VERIFICATION_FAILED')
    assert.equal(
      (await git(fixture.repoRoot, ['rev-parse', 'HEAD'])).stdout.trim(),
      prepared.commit,
    )
    assert.equal((await lstat(prepared.isolation.targetPath)).isDirectory(), true)
    assert.equal(outcome.recovery?.baseCommit, fixture.baseCommit)
    assert.equal(outcome.recovery?.commit, prepared.commit)
    assert.match(outcome.recovery?.instructions.join(' ') ?? '', /will not reset/u)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('semantic criteria fail closed after merge when no semantic verifier is composed', async () => {
  const fixture = await repository()
  try {
    const prepared = await prepareWorker(fixture, 'merge-semantic-missing')
    const step = {
      ...writeStep(),
      criteria: [
        {
          criterionId: 'criterion-semantic',
          kind: 'semantic' as const,
          description: 'The change satisfies the requested intent.',
        },
      ],
    }
    const outcome = await mergeCoordinator(fixture.manager).execute({
      step,
      isolation: prepared.isolation,
      artifact: prepared.artifact,
    })
    assert.equal(outcome.status, 'blocked')
    assert.equal(outcome.code, 'WORKSPACE_POST_MERGE_VERIFICATION_FAILED')
    assert.equal(outcome.verifications[2]?.code, 'WORKSPACE_POST_MERGE_SEMANTIC_VERIFIER_REQUIRED')
    assert.equal((await lstat(prepared.isolation.targetPath)).isDirectory(), true)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

type RepositoryFixture = Readonly<{
  root: string
  repoRoot: string
  ownedRoot: string
  baseCommit: string
  manager: WorkspaceIsolationManagerV1
}>

async function repository(): Promise<RepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-controlled-merge-'))
  const repoRoot = join(root, 'repo')
  const ownedRoot = join(root, 'managed')
  await git(root, ['init', repoRoot])
  await git(repoRoot, ['config', 'user.name', 'Praxis Test'])
  await git(repoRoot, ['config', 'user.email', 'praxis@example.invalid'])
  await git(repoRoot, ['config', 'core.autocrlf', 'false'])
  await git(repoRoot, ['config', 'commit.gpgsign', 'false'])
  await git(repoRoot, ['config', 'init.defaultBranch', 'main'])
  await git(repoRoot, ['config', '--add', 'safe.directory', repoRoot])
  await writeFile(join(repoRoot, '.gitignore'), '*.log\n', 'utf8')
  await mkdir(join(repoRoot, 'src'))
  await writeFile(join(repoRoot, 'src', 'tracked.txt'), 'base\n', 'utf8')
  await git(repoRoot, ['add', '.gitignore', 'src/tracked.txt'])
  await git(repoRoot, ['commit', '-m', 'base'])
  const baseCommit = (await git(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim()
  return {
    root,
    repoRoot,
    ownedRoot,
    baseCommit,
    manager: new WorkspaceIsolationManagerV1({ ownedRoot, managerId: 'merge-manager' }),
  }
}

async function installHooks(repoRoot: string): Promise<void> {
  const hooksRoot = join(repoRoot, '.git', 'hooks')
  const postCheckout = join(hooksRoot, 'post-checkout')
  const postMerge = join(hooksRoot, 'post-merge')
  await writeFile(postCheckout, '#!/bin/sh\nprintf invoked > hook-ran\n', 'utf8')
  await writeFile(postMerge, '#!/bin/sh\nprintf invoked > merge-hook-ran\n', 'utf8')
  await chmod(postCheckout, 0o755)
  await chmod(postMerge, 0o755)
}

async function prepareWorker(fixture: RepositoryFixture, slug: string) {
  const isolation = await fixture.manager.create({
    repoRoot: fixture.repoRoot,
    slug,
    targetPath: join(fixture.ownedRoot, slug),
    baseCommit: fixture.baseCommit,
    copyPolicy: COPY_POLICY,
  })
  await writeFile(join(isolation.targetPath, 'src', 'tracked.txt'), 'worker\n', 'utf8')
  await git(isolation.targetPath, ['add', 'src/tracked.txt'])
  await git(isolation.targetPath, ['commit', '-m', 'worker change'])
  const commit = (await git(isolation.targetPath, ['rev-parse', 'HEAD'])).stdout.trim()
  const patch = (
    await git(isolation.targetPath, [
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-renames',
      fixture.baseCommit,
      commit,
      '--',
    ])
  ).stdout
  const result: SubagentResultV1 = {
    schemaVersion: 1,
    childRunId: `child-${slug}`,
    status: 'succeeded',
    summary: 'Committed isolated workspace change.',
    evidenceRefs: [],
    changedFiles: [{ path: 'src/tracked.txt', change: 'modified', digest: sha256('worker\n') }],
    checks: [],
    usage: { turns: 1, toolCalls: 2, subagents: 0 },
    retryable: false,
  }
  const artifact: WorkspaceMergeArtifactV1 = {
    schemaVersion: 1,
    baseCommit: fixture.baseCommit,
    commit,
    patch: {
      format: 'git-diff-binary-v1',
      bytes: Buffer.byteLength(patch),
      digest: sha256(patch),
      content: patch,
    },
    result,
  }
  return { isolation, commit, artifact }
}

function writeStep(): SessionStepProjectionV3 {
  return {
    stepId: 'step-write',
    title: 'Write isolated workspace',
    order: 0,
    state: 'verifying',
    dependencies: [],
    access: { mode: 'workspace_write', paths: ['src'] },
    capabilities: ['builtin.read', 'builtin.write'],
    conflictKeys: ['workspace'],
    criteria: [{ criterionId: 'criterion-write', kind: 'file', description: 'File changed.' }],
    budget: {
      maxTurns: 2,
      maxToolCalls: 4,
      maxTokens: 1_000,
      maxChildRuns: 0,
      maxParallelChildren: 0,
      maxDepth: 0,
    },
    maxAttempts: 1,
    attemptIds: [],
    attempts: [],
  }
}

function mergeCoordinator(
  manager: WorkspaceIsolationManagerV1,
  mechanicalVerifier: SupervisorVerifierV1 = passed('mechanical'),
): ControlledWorkspaceMergeV1 {
  return new ControlledWorkspaceMergeV1({
    isolationManager: manager,
    mechanicalVerifier,
    ruleVerifier: passed('rule'),
  })
}

function passed(kind: 'mechanical' | 'rule'): SupervisorVerifierV1 {
  return {
    verify: async () => ({
      verifier: kind,
      status: 'passed',
      evidenceRefs: [],
      code: `${kind.toUpperCase()}_PASSED`,
      retryable: false,
    }),
  }
}

function failed(kind: 'mechanical' | 'rule'): SupervisorVerifierV1 {
  return {
    verify: async () => ({
      verifier: kind,
      status: 'failed',
      evidenceRefs: [],
      code: `${kind.toUpperCase()}_FAILED`,
      retryable: false,
    }),
  }
}

async function git(cwd: string, args: readonly string[]) {
  const result = await new GitCliCommandPortV1().run({ cwd, args })
  assert.equal(result.exitCode, 0, `git ${args[0]} failed`)
  return result
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
