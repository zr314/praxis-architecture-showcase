import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SessionStepProjectionV3, SubagentResultV1 } from '@praxis/core-sdk'
import { DirectoryWorkspaceIsolationManagerV1 } from '../apps/runtime/src/planner/directoryWorkspaceIsolation.js'
import { GitCliCommandPortV1 } from '../apps/runtime/src/planner/workspaceIsolationManager.js'
import type { SupervisorVerifierV1 } from '../apps/runtime/src/planner/verifier.js'
import { mergeableWorkspaceResult } from '../apps/runtime/src/workflow/localWorkflowAgentWorker.js'

test('a deadline preserves completed workspace mutations for parent verification', () => {
  const partial: SubagentResultV1 = {
    ...result([{ path: 'result.txt', change: 'created', digest: sha256('SNAPSHOT_OK\n') }]),
    status: 'cancelled',
    evidenceRefs: [
      {
        kind: 'result',
        ref: 'tool-result:write:write-1',
        digest: sha256('evidence'),
        mediaType: 'application/vnd.praxis.tool-result+json',
        summary: 'Completed write.',
      },
    ],
    retryable: true,
    error: {
      code: 'CHILD_DEADLINE_EXCEEDED',
      category: 'cancellation',
      message: 'Deadline exceeded after completed write.',
      retryable: true,
    },
  }

  const recovered = mergeableWorkspaceResult(partial)
  assert.equal(recovered?.status, 'succeeded')
  assert.equal(recovered?.retryable, false)
  assert.equal(recovered?.error, undefined)
  assert.deepEqual(recovered?.changedFiles, partial.changedFiles)
})

test('non-Git workspace changes are isolated, verified, and copied back without git init', async () => {
  const fixture = await workspace()
  const manager = isolationManager(fixture.ownedRoot)
  try {
    const isolation = await manager.create({
      workspaceRoot: fixture.workspaceRoot,
      slug: 'attempt-success',
      step: writeStep(),
    })
    assert.equal(await missing(join(fixture.workspaceRoot, '.git')), true)
    assert.equal(await missing(join(isolation.targetPath, '.env')), true)
    assert.equal(await missing(join(isolation.targetPath, 'node_modules')), true)

    await writeFile(join(isolation.targetPath, 'src', 'input.txt'), 'after', 'utf8')
    const merged = await manager.merge({
      isolation,
      step: writeStep(),
      result: result([{ path: 'src/input.txt', change: 'modified', digest: sha256('after') }]),
    })

    assert.equal(merged.status, 'succeeded')
    assert.equal(merged.code, 'WORKSPACE_SNAPSHOT_MERGED_AND_VERIFIED')
    assert.equal(await readFile(join(fixture.workspaceRoot, 'src', 'input.txt'), 'utf8'), 'after')
    assert.equal(await missing(join(fixture.workspaceRoot, '.git')), true)
    assert.equal(await missing(isolation.targetPath), true)
  } finally {
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
})

test('non-Git copy-back blocks a stale main workspace and retains the candidate snapshot', async () => {
  const fixture = await workspace()
  const manager = isolationManager(fixture.ownedRoot)
  try {
    const isolation = await manager.create({
      workspaceRoot: fixture.workspaceRoot,
      slug: 'attempt-stale',
      step: writeStep(),
    })
    await writeFile(join(isolation.targetPath, 'src', 'input.txt'), 'candidate', 'utf8')
    await writeFile(join(fixture.workspaceRoot, 'src', 'input.txt'), 'user change', 'utf8')

    const merged = await manager.merge({
      isolation,
      step: writeStep(),
      result: result([{ path: 'src/input.txt', change: 'modified', digest: sha256('candidate') }]),
    })

    assert.equal(merged.status, 'blocked')
    assert.equal(merged.code, 'WORKSPACE_BASELINE_CHANGED')
    assert.equal(
      await readFile(join(fixture.workspaceRoot, 'src', 'input.txt'), 'utf8'),
      'user change',
    )
    assert.equal(
      await readFile(join(isolation.targetPath, 'src', 'input.txt'), 'utf8'),
      'candidate',
    )
    assert.equal(merged.recovery?.snapshotPath, isolation.targetPath)
  } finally {
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })
  }
})

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-directory-isolation-'))
  const workspaceRoot = join(root, 'workspace')
  const ownedRoot = join(root, 'owned')
  await mkdir(join(workspaceRoot, 'src'), { recursive: true })
  await mkdir(join(workspaceRoot, 'node_modules', 'package'), { recursive: true })
  await writeFile(join(workspaceRoot, 'src', 'input.txt'), 'before', 'utf8')
  await writeFile(join(workspaceRoot, '.env'), 'SECRET=value', 'utf8')
  await writeFile(join(workspaceRoot, 'node_modules', 'package', 'index.js'), 'module', 'utf8')
  return { root, workspaceRoot, ownedRoot }
}

function isolationManager(ownedRoot: string) {
  return new DirectoryWorkspaceIsolationManagerV1({
    ownedRoot,
    git: new GitCliCommandPortV1(),
    mechanicalVerifier: passed('mechanical'),
    ruleVerifier: passed('rule'),
  })
}

function writeStep(): SessionStepProjectionV3 {
  return {
    stepId: 'step-write',
    title: 'Write a file',
    order: 0,
    state: 'running',
    dependencies: [],
    access: { mode: 'workspace_write', paths: ['.'] },
    capabilities: ['builtin.read', 'builtin.write'],
    conflictKeys: ['workspace'],
    criteria: [],
    budget: {
      maxTurns: 10,
      maxToolCalls: 20,
      maxTokens: 10_000,
      maxChildRuns: 0,
      maxParallelChildren: 0,
      maxDepth: 0,
    },
    maxAttempts: 1,
    attemptIds: [],
    attempts: [],
  }
}

function result(changedFiles: SubagentResultV1['changedFiles']): SubagentResultV1 {
  return {
    schemaVersion: 1,
    childRunId: 'attempt-test',
    status: 'succeeded',
    summary: 'Updated the requested file.',
    evidenceRefs: [],
    changedFiles,
    checks: [],
    usage: { turns: 1, toolCalls: 1, subagents: 0 },
    retryable: false,
  }
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

async function missing(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) === undefined
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
