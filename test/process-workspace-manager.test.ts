import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProcessWorkspaceManagerV1 } from '../apps/runtime/src/planner/processWorkspaceManager.js'
import { GitCliCommandPortV1 } from '../apps/runtime/src/planner/workspaceIsolationManager.js'

test('process workspace snapshots an unborn dirty repository and discards every command change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-process-workspace-'))
  const sourceRoot = join(root, 'source')
  const ownedRoot = join(root, 'owned')
  const targetPath = join(ownedRoot, 'step-test')
  await mkdir(sourceRoot)
  const git = new GitCliCommandPortV1()
  await git.run({ cwd: sourceRoot, args: ['init'] })
  await writeFile(join(sourceRoot, '.gitignore'), 'ignored.log\n', 'utf8')
  await writeFile(join(sourceRoot, 'exercise.py'), 'print("current dirty content")\n', 'utf8')
  await writeFile(join(sourceRoot, 'ignored.log'), 'ignored\n', 'utf8')
  await writeFile(join(sourceRoot, '.env'), 'API_KEY=must-not-copy\n', 'utf8')

  const manager = new ProcessWorkspaceManagerV1({
    ownedRoot,
    managerId: 'manager-test',
    git,
  })
  try {
    const snapshot = await manager.create({
      sourceRoot,
      slug: 'step-test',
      targetPath,
    })
    assert.equal(
      await readFile(join(targetPath, 'exercise.py'), 'utf8'),
      'print("current dirty content")\n',
    )
    assert.equal(await lstat(join(targetPath, 'ignored.log')).catch(() => undefined), undefined)
    assert.equal(await lstat(join(targetPath, '.env')).catch(() => undefined), undefined)

    await writeFile(join(targetPath, 'generated.txt'), 'temporary command output\n', 'utf8')
    await manager.discard(snapshot)
    assert.equal(await lstat(targetPath).catch(() => undefined), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('process workspace rejects a forged ownership handle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-process-workspace-owner-'))
  const sourceRoot = join(root, 'source')
  const ownedRoot = join(root, 'owned')
  await mkdir(sourceRoot)
  const git = new GitCliCommandPortV1()
  await git.run({ cwd: sourceRoot, args: ['init'] })
  await writeFile(join(sourceRoot, 'file.txt'), 'content\n', 'utf8')
  const manager = new ProcessWorkspaceManagerV1({
    ownedRoot,
    managerId: 'manager-owner',
    git,
  })
  try {
    const snapshot = await manager.create({
      sourceRoot,
      slug: 'step-owner',
      targetPath: join(ownedRoot, 'step-owner'),
    })
    await assert.rejects(
      manager.discard({ ...snapshot, digest: `sha256:${'0'.repeat(64)}` }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'PROCESS_WORKSPACE_OWNERSHIP_MISMATCH',
    )
    await manager.discard(snapshot)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
