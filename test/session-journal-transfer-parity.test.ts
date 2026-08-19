import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createSessionCommitV3,
  exportSessionJournalV3,
  importSessionJournalV3,
  ReducingSessionJournalV3,
  validatePortableSessionJournalV3,
  validateSessionEntryV3,
  type SessionCommitV3,
  type SessionCommitReceiptV3,
  type SessionEntryV3,
  type SessionJournalArchiveStoreV3,
} from '@praxis/core-sdk'
import { JsonlSessionJournalV3 } from '../apps/runtime/src/session-db/jsonlSessionJournalV3.js'
import { SqliteSessionJournalV3 } from '../apps/runtime/src/session-db/sqliteSessionJournalV3.js'

const EXPORTED_AT = '2026-01-06T12:00:00.000Z'
const STEP_DEFINITION = {
  dependencies: [] as string[],
  access: { mode: 'read_only' as const, paths: ['.'] },
  capabilities: [],
  conflictKeys: [],
  criteria: [{ criterionId: 'criterion-1', kind: 'rule' as const, description: 'Fixture passes.' }],
  budget: {
    maxTurns: 1,
    maxToolCalls: 1,
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
  },
  maxAttempts: 1,
}

test('portable JSONL to SQLite import preserves every identity and verifies idempotently', async () => {
  const jsonlRoot = await temporaryRoot('jsonl-source')
  const sqliteRoot = await temporaryRoot('sqlite-target')
  let target: SqliteSessionJournalV3 | undefined
  try {
    const source = new JsonlSessionJournalV3(jsonlRoot)
    target = new SqliteSessionJournalV3(sqliteRoot)
    await Promise.all([source.initialize(), target.initialize()])
    await seedTwoSessions(source)

    const archive = await exportSessionJournalV3(source, EXPORTED_AT)
    assert.equal(archive.sessions.length, 2)
    assert.deepEqual(
      archive.sessions.flatMap((session) => session.commits.map((commit) => commit.commitId)),
      ['commit-alpha-create', 'commit-alpha-update', 'commit-beta-create'],
    )
    assert.match(archive.checksum, /^sha256:[a-f0-9]{64}$/)
    assert.equal(Object.isFrozen(archive.sessions[0]?.commits[0]?.entries[0]), true)

    assert.deepEqual(await importSessionJournalV3(target, archive), {
      formatVersion: 3,
      sourceChecksum: archive.checksum,
      sessionCount: 2,
      commitCount: 3,
      entryCount: 3,
      acceptedCommits: 3,
      duplicateCommits: 0,
      verified: true,
    })
    const duplicate = await importSessionJournalV3(target, archive)
    assert.equal(duplicate.acceptedCommits, 0)
    assert.equal(duplicate.duplicateCommits, 3)
    assert.equal((await exportSessionJournalV3(target, EXPORTED_AT)).checksum, archive.checksum)
    assert.equal((await exportSessionJournalV3(source, EXPORTED_AT)).checksum, archive.checksum)
  } finally {
    target?.close()
    await Promise.all([cleanup(jsonlRoot), cleanup(sqliteRoot)])
  }
})

test('portable SQLite to JSONL fallback uses export/import and never dual-writes the source', async () => {
  const sqliteRoot = await temporaryRoot('sqlite-source')
  const jsonlRoot = await temporaryRoot('jsonl-target')
  let source: SqliteSessionJournalV3 | undefined
  try {
    source = new SqliteSessionJournalV3(sqliteRoot)
    const target = new JsonlSessionJournalV3(jsonlRoot)
    await Promise.all([source.initialize(), target.initialize()])
    await seedTwoSessions(source)
    const before = await exportSessionJournalV3(source, EXPORTED_AT)
    const report = await importSessionJournalV3(target, before)
    assert.equal(report.verified, true)
    assert.deepEqual(await exportSessionJournalV3(target, EXPORTED_AT), before)
    assert.deepEqual(await exportSessionJournalV3(source, EXPORTED_AT), before)
  } finally {
    source?.close()
    await Promise.all([cleanup(sqliteRoot), cleanup(jsonlRoot)])
  }
})

test('portable validation rejects tamper before the target accepts any commit', async () => {
  const sourceRoot = await temporaryRoot('tamper-source')
  const targetRoot = await temporaryRoot('tamper-target')
  let target: SqliteSessionJournalV3 | undefined
  try {
    const source = new JsonlSessionJournalV3(sourceRoot)
    target = new SqliteSessionJournalV3(targetRoot)
    await Promise.all([source.initialize(), target.initialize()])
    await source.appendCommit(sessionCreation('alpha'))
    const archive = await exportSessionJournalV3(source, EXPORTED_AT)
    const tampered = structuredClone(archive)
    ;(tampered.sessions[0]!.commits[0]!.entries[0] as { entryId: string }).entryId = 'tampered'

    assert.throws(
      () => validatePortableSessionJournalV3(tampered),
      hasCode('SESSION_COMMIT_CHECKSUM_INVALID'),
    )
    await assert.rejects(
      importSessionJournalV3(target, tampered),
      hasCode('SESSION_COMMIT_CHECKSUM_INVALID'),
    )
    assert.deepEqual(await target.listSessionIds(), [])
  } finally {
    target?.close()
    await Promise.all([cleanup(sourceRoot), cleanup(targetRoot)])
  }
})

test('portable import rejects a divergent target before accepting source commits', async () => {
  const sourceRoot = await temporaryRoot('divergence-source')
  const targetRoot = await temporaryRoot('divergence-target')
  try {
    const source = new JsonlSessionJournalV3(sourceRoot)
    const target = new JsonlSessionJournalV3(targetRoot)
    await Promise.all([source.initialize(), target.initialize()])
    await seedTwoSessions(source)
    const divergent = sessionCreation('session-divergent')
    await target.appendCommit(divergent)

    await assert.rejects(
      importSessionJournalV3(target, await exportSessionJournalV3(source, EXPORTED_AT)),
      hasCode('SESSION_IMPORT_TARGET_DIVERGED'),
    )
    assert.deepEqual(await target.listSessionIds(), ['session-divergent'])
    assert.equal((await target.readCommits('session-divergent')).length, 1)
  } finally {
    await Promise.all([cleanup(sourceRoot), cleanup(targetRoot)])
  }
})

for (const backend of ['jsonl', 'sqlite'] as const) {
  test(`${backend} passes the shared V3 lifecycle, cursor, idempotency, CAS, restart, and PlanGraph fixture`, async () => {
    const root = await temporaryRoot(`conformance-${backend}`)
    let first: HarnessStore | undefined
    let peer: HarnessStore | undefined
    let restarted: HarnessStore | undefined
    try {
      first = createStore(backend, root)
      peer = createStore(backend, root)
      await Promise.all([first.initialize(), peer.initialize()])
      const base = plannerCommit()
      assert.equal((await first.appendCommit(base)).duplicate, false)
      assert.equal((await peer.appendCommit(base)).duplicate, true)

      const left = plannerTerminalCommit('left', 'passed')
      const right = plannerTerminalCommit('right', 'failed')
      const contention = await Promise.allSettled([
        first.appendCommit(left),
        peer.appendCommit(right),
      ])
      assert.equal(contention.filter((result) => result.status === 'fulfilled').length, 1)
      const rejected = contention.find((result) => result.status === 'rejected')
      assert.equal(rejected?.status, 'rejected')
      if (rejected?.status === 'rejected') {
        assert.equal(rejected.reason.code, 'SESSION_COMMIT_REVISION_CONFLICT')
      }

      const page = await first.readEntries({
        sessionId: 'session-root',
        afterSequence: 1,
        limit: 3,
      })
      assert.deepEqual(
        page.entries.map((entry) => entry.sequence),
        [2, 3, 4],
      )
      assert.equal(page.hasMore, true)
      first.close?.()
      first = undefined
      peer.close?.()
      peer = undefined

      restarted = createStore(backend, root)
      await restarted.initialize()
      const journal = new ReducingSessionJournalV3(restarted)
      const plan = await journal.querySession({
        sessionId: 'session-root',
        kind: 'plan',
        planId: 'plan-1',
      })
      assert.equal(plan.kind, 'plan')
      if (plan.kind === 'plan') {
        assert.equal(plan.value.steps[0]?.attempts[0]?.verifications.length, 1)
      }
      assert.equal((await journal.loadSnapshot('session-root')).revision, 2)
    } finally {
      first?.close?.()
      peer?.close?.()
      restarted?.close?.()
      await cleanup(root)
    }
  })
}

test('deterministic randomized commit sequences produce identical JSONL and SQLite projections and errors', async () => {
  const jsonlRoot = await temporaryRoot('random-jsonl')
  const sqliteRoot = await temporaryRoot('random-sqlite')
  let sqlite: SqliteSessionJournalV3 | undefined
  try {
    const jsonl = new JsonlSessionJournalV3(jsonlRoot)
    const sqliteStore = new SqliteSessionJournalV3(sqliteRoot)
    sqlite = sqliteStore
    await Promise.all([jsonl.initialize(), sqliteStore.initialize()])
    const commits = randomizedCommits(0x5a17, 48)
    for (const [index, commit] of commits.entries()) {
      const receipts: SessionCommitReceiptV3[] = await Promise.all([
        jsonl.appendCommit(commit),
        sqliteStore.appendCommit(commit),
      ])
      assert.equal(receipts[0]!.duplicate, receipts[1]!.duplicate)
      if (index % 11 === 0) {
        const duplicates: SessionCommitReceiptV3[] = await Promise.all([
          jsonl.appendCommit(commit),
          sqliteStore.appendCommit(commit),
        ])
        assert.equal(duplicates[0]!.duplicate, true)
        assert.equal(duplicates[1]!.duplicate, true)
      }
    }

    const jsonlJournal = new ReducingSessionJournalV3(jsonl)
    const sqliteJournal = new ReducingSessionJournalV3(sqliteStore)
    assert.deepEqual(
      await jsonlJournal.loadSnapshot('session-random'),
      await sqliteJournal.loadSnapshot('session-random'),
    )
    assert.deepEqual(
      await jsonlJournal.querySession({
        sessionId: 'session-random',
        kind: 'plan',
        planId: 'plan-1',
      }),
      await sqliteJournal.querySession({
        sessionId: 'session-random',
        kind: 'plan',
        planId: 'plan-1',
      }),
    )
    assert.equal(
      (await exportSessionJournalV3(jsonl, EXPORTED_AT)).checksum,
      (await exportSessionJournalV3(sqliteStore, EXPORTED_AT)).checksum,
    )

    const stale = commits.at(-1)!
    const errors = await Promise.all([
      captureCode(() =>
        jsonl.appendCommit({ ...stale, commitId: 'stale-copy' } as SessionCommitV3),
      ),
      captureCode(() =>
        sqliteStore.appendCommit({ ...stale, commitId: 'stale-copy' } as SessionCommitV3),
      ),
    ])
    assert.deepEqual(errors, ['SESSION_COMMIT_CHECKSUM_INVALID', 'SESSION_COMMIT_CHECKSUM_INVALID'])
  } finally {
    sqlite?.close()
    await Promise.all([cleanup(jsonlRoot), cleanup(sqliteRoot)])
  }
})

type HarnessStore = SessionJournalArchiveStoreV3 & {
  initialize(): Promise<void>
  close?(): void
}

function createStore(backend: 'jsonl' | 'sqlite', root: string): HarnessStore {
  return backend === 'jsonl' ? new JsonlSessionJournalV3(root) : new SqliteSessionJournalV3(root)
}

async function seedTwoSessions(store: SessionJournalArchiveStoreV3): Promise<void> {
  await store.appendCommit(sessionCreation('alpha'))
  await store.appendCommit(
    createSessionCommitV3({
      sessionId: 'alpha',
      commitId: 'commit-alpha-update',
      expectedRevision: 1,
      idempotencyKey: 'idem-alpha-update',
      entries: [
        entry('alpha', 2, 2, 'message.committed', {
          messageId: 'message-alpha',
          message: { role: 'user', content: 'portable' },
        }),
      ],
    }),
  )
  await store.appendCommit(sessionCreation('beta'))
}

function sessionCreation(sessionId: string): SessionCommitV3 {
  return createSessionCommitV3({
    sessionId,
    commitId: `commit-${sessionId}-create`,
    expectedRevision: 0,
    idempotencyKey: `idem-${sessionId}-create`,
    entries: [
      entry(sessionId, 1, 1, 'session.created', {
        cwd: 'D:/workspace',
        provider: 'fixture',
        model: 'fixture-model',
        name: sessionId,
        labels: [],
      }),
    ],
  })
}

function plannerCommit(): SessionCommitV3 {
  return createSessionCommitV3({
    sessionId: 'session-root',
    commitId: 'commit-planner-base',
    expectedRevision: 0,
    idempotencyKey: 'idem-planner-base',
    entries: [
      entry('session-root', 1, 1, 'session.created', {
        cwd: 'D:/workspace',
        provider: 'fixture',
        model: 'fixture-model',
        name: 'Planner fixture',
        labels: [],
      }),
      entry('session-root', 2, 1, 'plan.created', {
        planId: 'plan-1',
        planRevision: 1,
        objective: 'Shared planner fixture',
        state: 'running',
      }),
      entry('session-root', 3, 1, 'step.created', {
        planId: 'plan-1',
        planRevision: 1,
        stepId: 'step-1',
        title: 'Execute',
        order: 0,
        state: 'verifying',
        ...STEP_DEFINITION,
      }),
      entry('session-root', 4, 1, 'attempt.created', {
        planId: 'plan-1',
        planRevision: 1,
        stepId: 'step-1',
        attemptId: 'attempt-1',
        ordinal: 1,
        state: 'verifying',
      }),
    ],
  })
}

function plannerTerminalCommit(suffix: string, status: 'passed' | 'failed'): SessionCommitV3 {
  return createSessionCommitV3({
    sessionId: 'session-root',
    commitId: `commit-planner-${suffix}`,
    expectedRevision: 1,
    idempotencyKey: `idem-planner-${suffix}`,
    entries: [
      entry(
        'session-root',
        5,
        2,
        'verification.recorded',
        {
          planId: 'plan-1',
          planRevision: 1,
          stepId: 'step-1',
          attemptId: 'attempt-1',
          verificationId: `verification-${suffix}`,
          verifier: 'mechanical',
          status,
          evidenceRefs: [`evidence://${suffix}`],
        },
        { entryId: `entry-verification-${suffix}` },
      ),
    ],
  })
}

function randomizedCommits(seed: number, count: number): SessionCommitV3[] {
  let state = seed >>> 0
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state
  }
  let sequence = 3
  const commits: SessionCommitV3[] = [
    createSessionCommitV3({
      sessionId: 'session-random',
      commitId: 'commit-random-1',
      expectedRevision: 0,
      idempotencyKey: 'idem-random-1',
      entries: [
        entry('session-random', 1, 1, 'session.created', {
          cwd: 'D:/random',
          provider: 'fixture',
          model: 'fixture-model',
          name: 'Random 0',
          labels: [],
        }),
        entry('session-random', 2, 1, 'plan.created', {
          planId: 'plan-1',
          planRevision: 1,
          objective: 'Random parity',
          state: 'running',
        }),
        entry('session-random', 3, 1, 'step.created', {
          planId: 'plan-1',
          planRevision: 1,
          stepId: 'step-1',
          title: 'Random step',
          order: 0,
          state: 'pending',
          ...STEP_DEFINITION,
        }),
      ],
    }),
  ]
  for (let revision = 2; revision <= count; revision += 1) {
    sequence += 1
    const choice = next() % 4
    const data =
      choice === 0
        ? { type: 'session.metadata_updated', data: { name: `Random ${next() % 10_000}` } }
        : choice === 1
          ? {
              type: 'message.committed',
              data: {
                messageId: `message-${revision}`,
                message: { role: 'user', content: `value-${next()}` },
              },
            }
          : choice === 2
            ? {
                type: 'usage.recorded',
                data: {
                  source: 'tool',
                  usage: { turns: 0, toolCalls: next() % 3, subagents: 0 },
                },
              }
            : {
                type: 'session.metadata_updated',
                data: {
                  labels: [`random-${revision}-${next() % 4}`],
                },
              }
    commits.push(
      createSessionCommitV3({
        sessionId: 'session-random',
        commitId: `commit-random-${revision}`,
        expectedRevision: revision - 1,
        idempotencyKey: `idem-random-${revision}`,
        entries: [entry('session-random', sequence, revision, data.type, data.data)],
      }),
    )
  }
  return commits
}

function entry(
  sessionId: string,
  sequence: number,
  revision: number,
  type: string,
  data: Record<string, unknown>,
  options: { entryId?: string } = {},
): SessionEntryV3 {
  return validateSessionEntryV3({
    schemaVersion: 3,
    entryId: options.entryId ?? `entry-${sequence}`,
    sessionId,
    sequence,
    revision,
    timestamp: new Date(Date.UTC(2026, 0, 6, 0, 0, sequence)).toISOString(),
    type,
    data,
  })
}

async function captureCode(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action()
    return undefined
  } catch (error) {
    return typeof error === 'object' && error !== null
      ? String((error as { code?: unknown }).code)
      : undefined
  }
}

async function temporaryRoot(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `praxis-journal-transfer-${name}-`))
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
