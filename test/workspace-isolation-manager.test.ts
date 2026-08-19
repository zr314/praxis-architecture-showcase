import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  GitCliCommandPortV1,
  WorkspaceIsolationManagerV1,
  type WorkspaceIsolationV1,
} from '../apps/runtime/src/planner/workspaceIsolationManager.js'

const COPY_POLICY = { ignored: 'exclude', secrets: 'exclude' } as const

test('WorkspaceIsolationManager creates a detached worktree at an exact owned target and removes it cleanly', async () => {
  const fixture = await repository()
  try {
    const managerInstance = manager(fixture.ownedRoot)
    const isolation = await create(managerInstance, fixture, 'step-clean')
    assert.equal(
      (await readFile(join(isolation.targetPath, 'tracked.txt'), 'utf8')).replaceAll('\r\n', '\n'),
      'base\n',
    )
    assert.deepEqual(isolation.copyPolicy, COPY_POLICY)

    const cleanup = await managerInstance.cleanup({ isolation })
    assert.equal(cleanup.status, 'removed')
    assert.equal(cleanup.code, 'WORKTREE_REMOVED')
    assert.equal(cleanup.recoveryPath, undefined)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('creation rejects unsafe slugs, non-owned targets, symbolic refs, and implicit copy policy', async () => {
  const fixture = await repository()
  const managerInstance = manager(fixture.ownedRoot)
  try {
    await assert.rejects(
      create(managerInstance, fixture, '../escape'),
      hasCode('WORKTREE_SLUG_INVALID'),
    )
    await assert.rejects(
      managerInstance.create({
        repoRoot: fixture.repoRoot,
        slug: 'outside',
        targetPath: join(fixture.root, 'outside'),
        baseCommit: fixture.baseCommit,
        copyPolicy: COPY_POLICY,
      }),
      hasCode('WORKTREE_TARGET_INVALID'),
    )
    await assert.rejects(
      managerInstance.create({
        repoRoot: fixture.repoRoot,
        slug: 'symbolic',
        targetPath: join(fixture.ownedRoot, 'symbolic'),
        baseCommit: 'HEAD',
        copyPolicy: COPY_POLICY,
      }),
      hasCode('WORKTREE_BASE_COMMIT_INVALID'),
    )
    await assert.rejects(
      managerInstance.create({
        repoRoot: fixture.repoRoot,
        slug: 'copy-secrets',
        targetPath: join(fixture.ownedRoot, 'copy-secrets'),
        baseCommit: fixture.baseCommit,
        copyPolicy: { ignored: 'exclude', secrets: 'copy' } as never,
      }),
      hasCode('WORKTREE_COPY_POLICY_INVALID'),
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('cleanup retains tracked, untracked, and ignored writes with a recovery path', async () => {
  const fixture = await repository()
  const managerInstance = manager(fixture.ownedRoot)
  try {
    const isolation = await create(managerInstance, fixture, 'step-dirty')
    await writeFile(join(isolation.targetPath, 'tracked.txt'), 'changed\n', 'utf8')
    await writeFile(join(isolation.targetPath, 'untracked.txt'), 'new\n', 'utf8')
    await writeFile(join(isolation.targetPath, 'ignored.log'), 'ignored\n', 'utf8')

    const cleanup = await managerInstance.cleanup({ isolation })
    assert.equal(cleanup.status, 'retained')
    assert.equal(cleanup.code, 'WORKTREE_RECOVERY_REQUIRED')
    assert.equal(cleanup.recoveryPath, isolation.targetPath)
    assert.equal(cleanup.evidence.trackedChanges, 1)
    assert.equal(cleanup.evidence.untrackedFiles, 1)
    assert.equal(cleanup.evidence.ignoredFiles, 1)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('cleanup retains a new commit even when its worktree is otherwise clean', async () => {
  const fixture = await repository()
  const managerInstance = manager(fixture.ownedRoot)
  try {
    const isolation = await create(managerInstance, fixture, 'step-commit')
    await writeFile(join(isolation.targetPath, 'tracked.txt'), 'committed\n', 'utf8')
    await git(isolation.targetPath, ['add', 'tracked.txt'])
    await git(isolation.targetPath, ['commit', '-m', 'worker commit'])

    const cleanup = await managerInstance.cleanup({ isolation })
    assert.equal(cleanup.status, 'retained')
    assert.equal(cleanup.code, 'WORKTREE_RECOVERY_REQUIRED')
    assert.equal(cleanup.evidence.newCommits, true)
    assert.notEqual(cleanup.evidence.headCommit, fixture.baseCommit)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('another manager and a tampered ownership handle cannot clean an owned worktree', async () => {
  const fixture = await repository()
  const owner = manager(fixture.ownedRoot, 'owner-a')
  try {
    const isolation = await create(owner, fixture, 'step-owned')
    const foreign = manager(fixture.ownedRoot, 'owner-b')
    await assert.rejects(
      foreign.cleanup({ isolation: { ...isolation, managerId: 'owner-b' } }),
      hasCode('WORKTREE_NOT_MANAGER_CREATED'),
    )
    await assert.rejects(
      owner.cleanup({ isolation: { ...isolation, baseCommit: '0'.repeat(40) } }),
      hasCode('WORKTREE_OWNERSHIP_MISMATCH'),
    )

    const cleanup = await owner.cleanup({ isolation })
    assert.equal(cleanup.status, 'removed')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

type RepositoryFixture = Readonly<{
  root: string
  repoRoot: string
  ownedRoot: string
  baseCommit: string
}>

async function repository(): Promise<RepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-worktree-manager-'))
  const repoRoot = join(root, 'repo')
  const ownedRoot = join(root, 'managed')
  await git(root, ['init', repoRoot])
  await git(repoRoot, ['config', 'user.name', 'Praxis Test'])
  await git(repoRoot, ['config', 'user.email', 'praxis@example.invalid'])
  await writeFile(join(repoRoot, '.gitignore'), '*.log\n', 'utf8')
  await writeFile(join(repoRoot, 'tracked.txt'), 'base\n', 'utf8')
  await git(repoRoot, ['add', '.gitignore', 'tracked.txt'])
  await git(repoRoot, ['commit', '-m', 'base'])
  const baseCommit = (await git(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim()
  return { root, repoRoot, ownedRoot, baseCommit }
}

function manager(ownedRoot: string, managerId = 'manager-test'): WorkspaceIsolationManagerV1 {
  return new WorkspaceIsolationManagerV1({ ownedRoot, managerId })
}

function create(
  managerInstance: WorkspaceIsolationManagerV1,
  fixture: RepositoryFixture,
  slug: string,
): Promise<WorkspaceIsolationV1> {
  return managerInstance.create({
    repoRoot: fixture.repoRoot,
    slug,
    targetPath: join(fixture.ownedRoot, slug),
    baseCommit: fixture.baseCommit,
    copyPolicy: COPY_POLICY,
  })
}

async function git(cwd: string, args: readonly string[]) {
  const result = await new GitCliCommandPortV1().run({ cwd, args })
  assert.equal(result.exitCode, 0, `git ${args[0]} failed`)
  return result
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}
