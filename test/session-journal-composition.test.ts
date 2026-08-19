import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createSessionCommitV3,
  sessionCommitReceiptV3,
  validateSessionEntryV3,
  type ReadSessionEntriesInputV3,
  type SessionCommitV3,
  type SessionEntryPageV3,
} from '@praxis/core-sdk'
import {
  createSessionJournalCompositionV3,
  type InitializableSessionJournalStoreV3,
  type SessionJournalBackendFactoryV3,
} from '../apps/runtime/src/session-db/sessionJournalComposition.js'
import { JsonlRepository } from '../apps/runtime/src/session-db/jsonlRepository.js'

test('session.store defaults to injected JSONL and returns only the domain journal port', async () => {
  const root = await temporaryRoot('default')
  try {
    const composition = await createSessionJournalCompositionV3({ root })
    assert.equal(composition.storeKind, 'jsonl')
    assert.deepEqual(Object.keys(composition).sort(), [
      'archiveStore',
      'canRecoverInterruptedRuns',
      'close',
      'journal',
      'storeKind',
    ])
    assert.equal(composition.canRecoverInterruptedRuns, true)
    assert.equal('root' in composition.journal, false)
    assert.equal('path' in composition.journal, false)
    assert.equal('transaction' in composition.journal, false)

    await composition.journal.appendCommit(creationCommit())
    assert.equal((await composition.journal.loadSnapshot('session-root')).name, 'Composition')
    const marker = JSON.parse(await readFile(join(root, 'session-authority.json'), 'utf8')) as {
      store: string
      checksum: string
    }
    assert.equal(marker.store, 'jsonl')
    assert.match(marker.checksum, /^sha256:[a-f0-9]{64}$/)
    await assert.rejects(
      new JsonlRepository(root).initialize(),
      hasCode('SESSION_STORE_LEGACY_AUTHORITY_DISABLED'),
    )
    await composition.close()
  } finally {
    await cleanup(root)
  }
})

test('an unavailable configured backend fails before claiming authority', async () => {
  const root = await temporaryRoot('unavailable')
  try {
    await assert.rejects(
      createSessionJournalCompositionV3({
        root,
        configuration: { session: { store: 'sqlite' } },
      }),
      hasCode('SESSION_STORE_UNAVAILABLE'),
    )
    await assert.rejects(stat(join(root, 'session-authority.json')), hasCode('ENOENT'))
  } finally {
    await cleanup(root)
  }
})

test('a backend initialization failure never publishes a Session authority marker', async () => {
  const root = await temporaryRoot('initialize-failure')
  try {
    const factory: SessionJournalBackendFactoryV3 = {
      kind: 'sqlite',
      create: () => new FailingStore(),
    }
    await assert.rejects(
      createSessionJournalCompositionV3({
        root,
        configuration: { session: { store: 'sqlite' } },
        factories: [factory],
      }),
      /fixture initialization failed/,
    )
    await assert.rejects(stat(join(root, 'session-authority.json')), hasCode('ENOENT'))
  } finally {
    await cleanup(root)
  }
})

test('backend registry injection selects SQLite without branching in journal consumers', async () => {
  const root = await temporaryRoot('injected')
  try {
    const store = new FakeSqliteStore(root)
    const factory: SessionJournalBackendFactoryV3 = {
      kind: 'sqlite',
      create(candidateRoot) {
        assert.equal(candidateRoot, root)
        return store
      },
    }
    const composition = await createSessionJournalCompositionV3({
      root,
      configuration: { session: { store: 'sqlite' } },
      factories: [factory],
    })

    assert.equal(composition.storeKind, 'sqlite')
    assert.equal(store.initialized, true)
    await composition.journal.appendCommit(creationCommit())
    assert.equal((await composition.journal.loadSnapshot('session-root')).sessionId, 'session-root')
    await composition.close()
  } finally {
    await cleanup(root)
  }
})

test('same-home backend changes require export/import and dual authorities fail closed', async () => {
  const root = await temporaryRoot('authority')
  try {
    await createSessionJournalCompositionV3({ root })
    const sqliteFactory: SessionJournalBackendFactoryV3 = {
      kind: 'sqlite',
      create: () => new FakeSqliteStore(root),
    }
    await assert.rejects(
      createSessionJournalCompositionV3({
        root,
        configuration: { session: { store: 'sqlite' } },
        factories: [sqliteFactory],
      }),
      hasCode('SESSION_STORE_SWITCH_REQUIRES_IMPORT'),
    )

    await writeFile(join(root, 'session-journal-v3.sqlite'), 'sqlite authority fixture', 'utf8')
    await assert.rejects(
      createSessionJournalCompositionV3({ root }),
      hasCode('SESSION_STORE_AUTHORITY_AMBIGUOUS'),
    )
  } finally {
    await cleanup(root)
  }
})

test('authority selection does not rewrite Policy, Credential, Settings, Trace, or artifact stores', async () => {
  const root = await temporaryRoot('unrelated-stores')
  try {
    const paths = [
      join(root, 'policy-grants.json'),
      join(root, 'credentials.enc.json'),
      join(root, 'settings.json'),
      join(root, 'trace-fixture.jsonl'),
      join(root, 'artifact-fixture.bin'),
    ]
    for (const [index, path] of paths.entries()) {
      await writeFile(path, `unrelated-${index}`, 'utf8')
    }
    const before = await Promise.all(paths.map(digestFile))
    await createSessionJournalCompositionV3({ root })
    const after = await Promise.all(paths.map(digestFile))
    assert.deepEqual(after, before)
  } finally {
    await cleanup(root)
  }
})

test('configuration, authority checksum, and duplicate factories fail closed', async () => {
  const invalidConfigRoot = await temporaryRoot('invalid-config')
  const invalidMarkerRoot = await temporaryRoot('invalid-marker')
  try {
    await assert.rejects(
      createSessionJournalCompositionV3({
        root: invalidConfigRoot,
        configuration: { session: { store: 'other' } } as never,
      }),
      hasCode('SESSION_STORE_CONFIG_INVALID'),
    )
    await createSessionJournalCompositionV3({ root: invalidMarkerRoot })
    const markerPath = join(invalidMarkerRoot, 'session-authority.json')
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>
    marker.checksum = `sha256:${'0'.repeat(64)}`
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`, 'utf8')
    await assert.rejects(
      createSessionJournalCompositionV3({ root: invalidMarkerRoot }),
      hasCode('SESSION_STORE_AUTHORITY_INVALID'),
    )

    await assert.rejects(
      createSessionJournalCompositionV3({
        root: invalidConfigRoot,
        factories: [
          {
            kind: 'jsonl',
            create: () => new FakeSqliteStore(invalidConfigRoot),
          },
        ],
      }),
      hasCode('SESSION_STORE_FACTORY_INVALID'),
    )
  } finally {
    await Promise.all([cleanup(invalidConfigRoot), cleanup(invalidMarkerRoot)])
  }
})

test('concurrent composition claims converge on one authority marker', async () => {
  const root = await temporaryRoot('concurrent')
  try {
    const [left, right] = await Promise.all([
      createSessionJournalCompositionV3({ root }),
      createSessionJournalCompositionV3({ root }),
    ])
    assert.equal(left.storeKind, 'jsonl')
    assert.equal(right.storeKind, 'jsonl')
    const marker = JSON.parse(await readFile(join(root, 'session-authority.json'), 'utf8')) as {
      generationId: string
    }
    assert.match(marker.generationId, /^[0-9a-f-]{36}$/)
    await Promise.all([left.close(), right.close()])
  } finally {
    await cleanup(root)
  }
})

class FakeSqliteStore implements InitializableSessionJournalStoreV3 {
  initialized = false
  #commit: SessionCommitV3 | undefined

  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    this.initialized = true
    await writeFile(join(this.root, 'session-journal-v3.sqlite'), 'fixture', 'utf8')
  }

  async appendCommit(commit: SessionCommitV3) {
    this.#commit = commit
    return sessionCommitReceiptV3(commit)
  }

  async readEntries(input: ReadSessionEntriesInputV3): Promise<SessionEntryPageV3> {
    if (this.#commit === undefined) throw new Error('missing fixture commit')
    const after = input.afterSequence ?? 0
    const entries = this.#commit.entries.filter((entry) => entry.sequence > after)
    const head = this.#commit.entries.at(-1)!
    return {
      sessionId: input.sessionId,
      entries,
      nextAfterSequence: entries.at(-1)?.sequence ?? after,
      hasMore: false,
      head: { revision: head.revision, sequence: head.sequence },
    }
  }
}

class FailingStore implements InitializableSessionJournalStoreV3 {
  async initialize(): Promise<void> {
    throw new Error('fixture initialization failed')
  }

  async appendCommit(commit: SessionCommitV3) {
    return sessionCommitReceiptV3(commit)
  }

  async readEntries(): Promise<SessionEntryPageV3> {
    throw new Error('fixture store is unavailable')
  }
}

function creationCommit(): SessionCommitV3 {
  return createSessionCommitV3({
    sessionId: 'session-root',
    commitId: 'commit-create',
    expectedRevision: 0,
    idempotencyKey: 'idem-create',
    entries: [
      validateSessionEntryV3({
        schemaVersion: 3,
        entryId: 'entry-1',
        sessionId: 'session-root',
        sequence: 1,
        revision: 1,
        timestamp: '2026-01-04T00:00:01.000Z',
        type: 'session.created',
        data: {
          cwd: 'D:/workspace',
          provider: 'fixture',
          model: 'fixture-model',
          name: 'Composition',
          labels: [],
        },
      }),
    ],
  })
}

async function temporaryRoot(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `praxis-journal-composition-${name}-`))
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function digestFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
