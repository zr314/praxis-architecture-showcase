import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SessionStepProjectionV3, SubagentResultV1 } from '@praxis/core-sdk'
import type { SupervisorVerifierV1 } from '../apps/runtime/src/planner/verifier.js'
import {
  type WorkspaceWriteGuardOptionsV1,
  WorkspaceWriteGuardV1,
} from '../apps/runtime/src/planner/workspaceWriteGuard.js'

test('WorkspaceWriteGuard records exact before/after digests and verifies a declared mutation', async () => {
  const root = await workspace()
  let mechanicalCalls = 0
  let ruleCalls = 0
  const guard = new WorkspaceWriteGuardV1({
    mechanicalVerifier: passed('mechanical', () => (mechanicalCalls += 1)),
    ruleVerifier: passed('rule', () => (ruleCalls += 1)),
  })
  try {
    const baseline = await guard.capture({ workspaceRoot: root, step: writeStep() })
    const outcome = await guard.execute({
      workspaceRoot: root,
      step: writeStep(),
      baseline,
      run: async () => {
        await writeFile(join(root, 'src', 'input.txt'), 'after', 'utf8')
        return result([{ path: 'src/input.txt', change: 'modified', digest: sha256('after') }])
      },
    })

    assert.equal(outcome.status, 'succeeded')
    assert.equal(outcome.code, 'WORKSPACE_WRITE_VERIFIED')
    assert.notEqual(outcome.evidence.beforeDigest, outcome.evidence.afterDigest)
    assert.deepEqual(outcome.evidence.changedFiles, [
      {
        path: 'src/input.txt',
        change: 'modified',
        beforeDigest: sha256('before'),
        afterDigest: sha256('after'),
      },
    ])
    assert.equal(mechanicalCalls, 1)
    assert.equal(ruleCalls, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workspace-level lock serializes writers across guard instances', async () => {
  const root = await workspace()
  const options = verifierOptions()
  const first = new WorkspaceWriteGuardV1(options)
  const second = new WorkspaceWriteGuardV1(options)
  const baseline = await first.capture({ workspaceRoot: root, step: writeStep() })
  let active = 0
  let maxActive = 0
  const run = async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 25))
    active -= 1
    return result([])
  }
  try {
    const outcomes = await Promise.all([
      first.execute({ workspaceRoot: root, step: writeStep(), baseline, run }),
      second.execute({ workspaceRoot: root, step: writeStep(), baseline, run }),
    ])
    assert.equal(maxActive, 1)
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ['succeeded', 'succeeded'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a user change after admission invalidates the baseline before worker execution', async () => {
  const root = await workspace()
  const guard = new WorkspaceWriteGuardV1(verifierOptions())
  let executions = 0
  try {
    const baseline = await guard.capture({ workspaceRoot: root, step: writeStep() })
    await writeFile(join(root, 'src', 'input.txt'), 'user change', 'utf8')
    const outcome = await guard.execute({
      workspaceRoot: root,
      step: writeStep(),
      baseline,
      run: async () => {
        executions += 1
        return result([])
      },
    })
    assert.equal(outcome.status, 'blocked')
    assert.equal(outcome.code, 'WORKSPACE_BASELINE_CHANGED')
    assert.equal(executions, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an undeclared concurrent in-grant change fails closed and preserves evidence', async () => {
  const root = await workspace()
  const guard = new WorkspaceWriteGuardV1(verifierOptions())
  try {
    const baseline = await guard.capture({ workspaceRoot: root, step: writeStep() })
    const outcome = await guard.execute({
      workspaceRoot: root,
      step: writeStep(),
      baseline,
      run: async () => {
        await writeFile(join(root, 'src', 'input.txt'), 'worker', 'utf8')
        await writeFile(join(root, 'src', 'user.txt'), 'user', 'utf8')
        return result([{ path: 'src/input.txt', change: 'modified', digest: sha256('worker') }])
      },
    })
    assert.equal(outcome.status, 'blocked')
    assert.equal(outcome.code, 'WORKSPACE_CONCURRENT_MODIFICATION')
    assert.deepEqual(
      outcome.evidence.changedFiles.map((change) => change.path),
      ['src/input.txt', 'src/user.txt'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('write success never bypasses mechanical and rule verification', async () => {
  const root = await workspace()
  const guard = new WorkspaceWriteGuardV1({
    mechanicalVerifier: failed('mechanical'),
    ruleVerifier: passed('rule'),
  })
  try {
    const baseline = await guard.capture({ workspaceRoot: root, step: writeStep() })
    const outcome = await guard.execute({
      workspaceRoot: root,
      step: writeStep(),
      baseline,
      run: async () => {
        await writeFile(join(root, 'src', 'input.txt'), 'after', 'utf8')
        return result([{ path: 'src/input.txt', change: 'modified', digest: sha256('after') }])
      },
    })
    assert.equal(outcome.status, 'blocked')
    assert.equal(outcome.code, 'WORKSPACE_VERIFICATION_FAILED')
    assert.deepEqual(
      outcome.verifications.map((verification) => verification.status),
      ['failed', 'passed'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('write authority requires workspace access and the global workspace conflict key', async () => {
  const root = await workspace()
  const guard = new WorkspaceWriteGuardV1(verifierOptions())
  try {
    await assert.rejects(
      guard.capture({
        workspaceRoot: root,
        step: { ...writeStep(), access: { mode: 'read_only', paths: ['src'] } },
      }),
      hasCode('WORKSPACE_WRITE_AUTHORITY_INVALID'),
    )
    await assert.rejects(
      guard.capture({
        workspaceRoot: root,
        step: { ...writeStep(), conflictKeys: ['src/input.txt'] },
      }),
      hasCode('WORKSPACE_WRITE_AUTHORITY_INVALID'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workspace-guard-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'input.txt'), 'before', 'utf8')
  return root
}

function writeStep(): SessionStepProjectionV3 {
  return {
    stepId: 'step-write',
    title: 'Write workspace',
    order: 0,
    state: 'running',
    dependencies: [],
    access: { mode: 'workspace_write', paths: ['src'] },
    capabilities: ['builtin.read', 'builtin.write'],
    conflictKeys: ['workspace'],
    criteria: [{ criterionId: 'criterion-write', kind: 'file', description: 'File changed.' }],
    budget: {
      maxTurns: 2,
      maxToolCalls: 2,
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

function result(changedFiles: SubagentResultV1['changedFiles']): SubagentResultV1 {
  return {
    schemaVersion: 1,
    childRunId: 'child-write',
    status: 'succeeded',
    summary: 'Workspace write completed.',
    evidenceRefs: [],
    changedFiles,
    checks: [],
    usage: { turns: 1, toolCalls: 1, subagents: 0 },
    retryable: false,
  }
}

function verifierOptions(): WorkspaceWriteGuardOptionsV1 {
  return { mechanicalVerifier: passed('mechanical'), ruleVerifier: passed('rule') }
}

function passed(
  kind: 'mechanical' | 'rule',
  called: () => void = () => undefined,
): SupervisorVerifierV1 {
  return {
    verify: async () => {
      called()
      return {
        verifier: kind,
        status: 'passed',
        evidenceRefs: [],
        code: `${kind.toUpperCase()}_PASSED`,
        retryable: false,
      }
    },
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

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}
