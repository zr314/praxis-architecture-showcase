import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import {
  assertSessionCommitAgainstHeadV3,
  reduceSessionEntriesV3,
  runtimeError,
  sessionCommitReceiptV3,
  validateSessionCommitV3,
  validateSessionEntryV3,
  type ReadSessionEntriesInputV3,
  type SessionCommitReceiptV3,
  type SessionCommitV3,
  type SessionEntryPageV3,
  type SessionEntryV3,
  type SessionJournalArchiveStoreV3,
  type SessionProjectionV3,
} from '@praxis/core-sdk'
import type { SessionJournalBackendFactoryV3 } from './sessionJournalComposition.js'
import { loadNodeSqlite } from '../store/nodeSqlite.js'

const SCHEMA_VERSION = 1
const BUSY_TIMEOUT_MS = 5_000
const MAX_READ_PAGE = 512

export type SqliteSessionJournalFaultPointV3 =
  | 'after_commit_row'
  | 'after_entries'
  | 'after_projection'
  | 'before_transaction_commit'

export type SqliteSessionJournalOptionsV3 = Readonly<{
  faultInjector?: (point: SqliteSessionJournalFaultPointV3) => void
}>

export type SqliteSessionJournalProfileV3 = Readonly<{
  schemaVersion: number
  journalMode: string
  synchronous: number
  busyTimeoutMs: number
  foreignKeys: boolean
}>

type SessionHeadRow = Readonly<{ revision: number; sequence: number }>
type CommitRow = Readonly<{
  commit_id: string
  idempotency_key: string
  checksum: string
  commit_json: string
}>
type EntryRow = Readonly<{ entry_json: string }>

/** Optional SQLite implementation; the core SessionJournal contract remains driver-free. */
export class SqliteSessionJournalV3 implements SessionJournalArchiveStoreV3 {
  readonly #path: string
  #database?: DatabaseSync
  #writer = Promise.resolve()

  constructor(
    root = process.env.PRAXIS_HOME ?? join(homedir(), '.praxis'),
    private readonly options: SqliteSessionJournalOptionsV3 = {},
  ) {
    this.#path = join(root, 'session-journal-v3.sqlite')
  }

  async initialize(): Promise<void> {
    if (this.#database !== undefined) return
    await mkdir(dirname(this.#path), { recursive: true })
    let Database: typeof import('node:sqlite').DatabaseSync
    try {
      ;({ DatabaseSync: Database } = await loadNodeSqlite())
    } catch {
      throw journalError('SESSION_STORE_UNAVAILABLE')
    }
    const database = new Database(this.#path)
    try {
      database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`)
      database.exec('PRAGMA journal_mode=WAL')
      database.exec('PRAGMA synchronous=FULL')
      database.exec('PRAGMA foreign_keys=ON')
      migrate(database)
      validateProfile(database)
      this.#database = database
    } catch (error) {
      database.close()
      throw mapSqliteError(error, 'initialize')
    }
  }

  appendCommit(input: SessionCommitV3): Promise<SessionCommitReceiptV3> {
    const commit = validateSessionCommitV3(input)
    const operation = this.#writer.then(() =>
      this.run('append_commit', () => this.appendExclusive(commit)),
    )
    this.#writer = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  async readEntries(input: ReadSessionEntriesInputV3): Promise<SessionEntryPageV3> {
    return this.run('read_entries', async () => {
      validateReadInput(input)
      const database = this.database()
      const head = database
        .prepare('SELECT revision, sequence FROM sessions WHERE session_id = ?')
        .get(input.sessionId) as SessionHeadRow | undefined
      if (head === undefined) throw journalError('SESSION_NOT_FOUND')
      const through = input.throughSequence ?? head.sequence
      if (through > head.sequence) throw journalError('SESSION_READ_INVALID')
      const after = input.afterSequence ?? 0
      const limit = input.limit ?? MAX_READ_PAGE
      const rows = database
        .prepare(
          `SELECT entry_json
             FROM entries
            WHERE session_id = ? AND sequence > ? AND sequence <= ?
            ORDER BY sequence ASC
            LIMIT ?`,
        )
        .all(input.sessionId, after, through, limit) as EntryRow[]
      const entries = rows.map((row) => parseEntry(row.entry_json))
      const nextAfterSequence = entries.at(-1)?.sequence ?? after
      return {
        sessionId: input.sessionId,
        entries,
        nextAfterSequence,
        hasMore: nextAfterSequence < through,
        head: { revision: Number(head.revision), sequence: Number(head.sequence) },
      }
    })
  }

  async listSessionIds(): Promise<readonly string[]> {
    return this.run('list_session_ids', async () => {
      const rows = this.database()
        .prepare('SELECT session_id FROM sessions ORDER BY session_id')
        .all() as Array<{
        session_id: string
      }>
      return rows.map((row) => row.session_id)
    })
  }

  async listRecoverableSessionIds(): Promise<readonly string[]> {
    return this.run('list_recoverable_session_ids', async () => {
      const rows = this.database()
        .prepare('SELECT session_id, projection_json FROM sessions ORDER BY session_id')
        .all() as Array<{ session_id: string; projection_json: string }>
      return rows
        .filter(({ session_id, projection_json }) =>
          projectionHasRecoverableRun(parseProjection(projection_json, session_id)),
        )
        .map(({ session_id }) => session_id)
    })
  }

  async loadCachedProjection(sessionId: string): Promise<SessionProjectionV3> {
    return this.run('load_cached_projection', async () => {
      const row = this.database()
        .prepare('SELECT projection_json FROM sessions WHERE session_id = ?')
        .get(sessionId) as { projection_json: string } | undefined
      if (row === undefined) throw journalError('SESSION_NOT_FOUND')
      return parseProjection(row.projection_json, sessionId)
    })
  }

  async deepScrub(): Promise<{
    store: 'sqlite'
    sessions: number
    integrity: string
  }> {
    return this.run('deep_scrub', async () => {
      const database = this.database()
      const integrityRows = database.prepare('PRAGMA integrity_check').all() as Array<{
        integrity_check: string
      }>
      const integrity = integrityRows.map((row) => row.integrity_check).join('; ')
      if (integrity !== 'ok') throw new SyntaxError(`SQLite integrity check failed: ${integrity}`)
      const sessionIds = await this.listSessionIds()
      for (const sessionId of sessionIds) {
        const entries = loadAllEntries(database, sessionId)
        const rebuilt = reduceSessionEntriesV3(entries)
        const cached = await this.loadCachedProjection(sessionId)
        if (JSON.stringify(rebuilt) !== JSON.stringify(cached)) {
          throw new SyntaxError(`SQLite projection mismatch for ${sessionId}.`)
        }
      }
      return { store: 'sqlite' as const, sessions: sessionIds.length, integrity }
    })
  }

  async readCommits(sessionId: string): Promise<readonly SessionCommitV3[]> {
    return this.run('read_commits', async () => {
      const rows = this.database()
        .prepare('SELECT commit_json FROM commits WHERE session_id = ? ORDER BY revision')
        .all(sessionId) as Array<{ commit_json: string }>
      if (rows.length === 0) throw journalError('SESSION_NOT_FOUND')
      return rows.map((row) => {
        try {
          return validateSessionCommitV3(JSON.parse(row.commit_json))
        } catch {
          throw new SyntaxError('Persisted SQLite commit is invalid.')
        }
      })
    })
  }

  profile(): SqliteSessionJournalProfileV3 {
    return validateProfile(this.database())
  }

  close(): void {
    this.#database?.close()
    this.#database = undefined
  }

  private async appendExclusive(commit: SessionCommitV3): Promise<SessionCommitReceiptV3> {
    const database = this.database()
    database.exec('BEGIN IMMEDIATE')
    try {
      const duplicate = findDuplicate(database, commit)
      if (duplicate !== undefined) {
        database.exec('COMMIT')
        return sessionCommitReceiptV3(duplicate, true)
      }

      const current = database
        .prepare('SELECT revision, sequence FROM sessions WHERE session_id = ?')
        .get(commit.sessionId) as SessionHeadRow | undefined
      assertSessionCommitAgainstHeadV3(
        commit,
        current === undefined
          ? undefined
          : { revision: Number(current.revision), sequence: Number(current.sequence) },
      )
      const prior = loadAllEntries(database, commit.sessionId)
      const projection = reduceSessionEntriesV3([...prior, ...commit.entries])

      database
        .prepare(
          `INSERT INTO commits (
             session_id, revision, commit_id, idempotency_key, checksum,
             first_sequence, last_sequence, commit_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          commit.sessionId,
          commit.expectedRevision + 1,
          commit.commitId,
          commit.idempotencyKey,
          commit.checksum,
          commit.entries[0]!.sequence,
          commit.entries.at(-1)!.sequence,
          JSON.stringify(commit),
        )
      this.inject('after_commit_row')

      const insertEntry = database.prepare(
        `INSERT INTO entries (
           session_id, sequence, revision, entry_id, entry_type, entry_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      for (const entry of commit.entries) {
        insertEntry.run(
          entry.sessionId,
          entry.sequence,
          entry.revision,
          entry.entryId,
          entry.type,
          JSON.stringify(entry),
        )
      }
      this.inject('after_entries')

      database
        .prepare(
          `INSERT INTO sessions (session_id, revision, sequence, projection_json, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             revision = excluded.revision,
             sequence = excluded.sequence,
             projection_json = excluded.projection_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          commit.sessionId,
          projection.snapshot.revision,
          projection.snapshot.sequence,
          JSON.stringify(projection),
          projection.catalog.updatedAt,
        )
      this.inject('after_projection')
      this.inject('before_transaction_commit')
      database.exec('COMMIT')
      return sessionCommitReceiptV3(commit)
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // Preserve the original domain/SQLite failure.
      }
      throw error
    }
  }

  private database(): DatabaseSync {
    if (this.#database === undefined) throw journalError('SESSION_JOURNAL_NOT_INITIALIZED')
    return this.#database
  }

  private inject(point: SqliteSessionJournalFaultPointV3): void {
    this.options.faultInjector?.(point)
  }

  private async run<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      throw mapSqliteError(error, operation)
    }
  }
}

export function sqliteSessionJournalFactoryV3(): SessionJournalBackendFactoryV3 {
  return Object.freeze({
    kind: 'sqlite' as const,
    create: (root: string) => new SqliteSessionJournalV3(root),
  })
}

function parseProjection(source: string, sessionId: string): SessionProjectionV3 {
  let projection: SessionProjectionV3
  try {
    projection = JSON.parse(source) as SessionProjectionV3
  } catch {
    throw new SyntaxError('Persisted SQLite projection is invalid.')
  }
  if (
    projection?.snapshot?.sessionId !== sessionId ||
    projection?.catalog?.sessionId !== sessionId
  ) {
    throw new SyntaxError('Persisted SQLite projection session mismatch.')
  }
  return structuredClone(projection)
}

function projectionHasRecoverableRun(projection: SessionProjectionV3): boolean {
  return (
    projection.snapshot.lifecycle === 'open' &&
    projection.snapshot.runs.some(({ state }) => state === 'running')
  )
}

function migrate(database: DatabaseSync): void {
  const current = pragmaNumber(database, 'user_version')
  if (current > SCHEMA_VERSION) throw journalError('SESSION_STORE_VERSION_UNSUPPORTED')
  if (current === SCHEMA_VERSION) {
    validateSchemaMetadata(database)
    return
  }
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision > 0),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        projection_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE commits (
        session_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        commit_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        checksum TEXT NOT NULL,
        first_sequence INTEGER NOT NULL CHECK (first_sequence > 0),
        last_sequence INTEGER NOT NULL CHECK (last_sequence >= first_sequence),
        commit_json TEXT NOT NULL,
        PRIMARY KEY (session_id, revision),
        UNIQUE (session_id, commit_id),
        UNIQUE (session_id, idempotency_key)
      ) STRICT;

      CREATE TABLE entries (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        revision INTEGER NOT NULL CHECK (revision > 0),
        entry_id TEXT NOT NULL,
        entry_type TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence),
        UNIQUE (session_id, entry_id),
        FOREIGN KEY (session_id, revision) REFERENCES commits(session_id, revision)
      ) STRICT;
    `)
    database
      .prepare('INSERT INTO metadata (key, value) VALUES (?, ?), (?, ?)')
      .run('backend', 'sqlite', 'schema_version', String(SCHEMA_VERSION))
    database.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve migration failure.
    }
    throw error
  }
}

function validateSchemaMetadata(database: DatabaseSync): void {
  const rows = database.prepare('SELECT key, value FROM metadata').all() as Array<{
    key: string
    value: string
  }>
  const metadata = new Map(rows.map((row) => [row.key, row.value]))
  if (
    metadata.get('backend') !== 'sqlite' ||
    metadata.get('schema_version') !== String(SCHEMA_VERSION)
  ) {
    throw new SyntaxError('SQLite SessionJournal metadata is invalid.')
  }
}

function validateProfile(database: DatabaseSync): SqliteSessionJournalProfileV3 {
  const profile = {
    schemaVersion: pragmaNumber(database, 'user_version'),
    journalMode: pragmaString(database, 'journal_mode').toLowerCase(),
    synchronous: pragmaNumber(database, 'synchronous'),
    busyTimeoutMs: pragmaNumber(database, 'busy_timeout'),
    foreignKeys: pragmaNumber(database, 'foreign_keys') === 1,
  }
  if (
    profile.schemaVersion !== SCHEMA_VERSION ||
    profile.journalMode !== 'wal' ||
    profile.synchronous !== 2 ||
    profile.busyTimeoutMs !== BUSY_TIMEOUT_MS ||
    !profile.foreignKeys
  ) {
    throw journalError('SESSION_SQLITE_PROFILE_INVALID')
  }
  return Object.freeze(profile)
}

function findDuplicate(
  database: DatabaseSync,
  candidate: SessionCommitV3,
): SessionCommitV3 | undefined {
  const row = database
    .prepare(
      `SELECT commit_id, idempotency_key, checksum, commit_json
         FROM commits
        WHERE session_id = ? AND (commit_id = ? OR idempotency_key = ?)
        LIMIT 1`,
    )
    .get(candidate.sessionId, candidate.commitId, candidate.idempotencyKey) as CommitRow | undefined
  if (row === undefined) return undefined
  if (
    row.commit_id !== candidate.commitId ||
    row.idempotency_key !== candidate.idempotencyKey ||
    row.checksum !== candidate.checksum
  ) {
    throw journalError('SESSION_COMMIT_IDEMPOTENCY_CONFLICT')
  }
  try {
    return validateSessionCommitV3(JSON.parse(row.commit_json))
  } catch {
    throw new SyntaxError('Persisted SQLite commit is invalid.')
  }
}

function loadAllEntries(database: DatabaseSync, sessionId: string): SessionEntryV3[] {
  const rows = database
    .prepare('SELECT entry_json FROM entries WHERE session_id = ? ORDER BY sequence ASC')
    .all(sessionId) as EntryRow[]
  return rows.map((row) => parseEntry(row.entry_json))
}

function parseEntry(input: string): SessionEntryV3 {
  try {
    return validateSessionEntryV3(JSON.parse(input))
  } catch {
    throw new SyntaxError('Persisted SQLite entry is invalid.')
  }
}

function pragmaNumber(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, SQLInputValue> | undefined
  const value = row === undefined ? undefined : Object.values(row)[0]
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new SyntaxError(`SQLite PRAGMA ${name} is invalid.`)
  }
  return Number(value)
}

function pragmaString(database: DatabaseSync, name: string): string {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, SQLInputValue> | undefined
  const value = row === undefined ? undefined : Object.values(row)[0]
  if (typeof value !== 'string') throw new SyntaxError(`SQLite PRAGMA ${name} is invalid.`)
  return value
}

function validateReadInput(input: ReadSessionEntriesInputV3): void {
  if (
    !isRecord(input) ||
    !onlyKeys(input, ['sessionId', 'afterSequence', 'limit', 'throughSequence']) ||
    !safeId(input.sessionId) ||
    (input.afterSequence !== undefined && !nonNegativeInteger(input.afterSequence)) ||
    (input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_READ_PAGE)) ||
    (input.throughSequence !== undefined && !nonNegativeInteger(input.throughSequence))
  ) {
    throw journalError('SESSION_READ_INVALID')
  }
}

function mapSqliteError(error: unknown, operation: string) {
  if (isRuntimeError(error)) return error
  if (error instanceof SyntaxError) {
    return runtimeError(
      'PERSISTENCE_INVALID_DATA',
      'persistence',
      'SQLite SessionJournal data is invalid.',
      {
        operation,
      },
    )
  }
  if (isBusy(error)) {
    return runtimeError(
      'SESSION_WRITE_CONFLICT',
      'persistence',
      'SQLite SessionJournal writer is busy.',
      { operation },
      true,
    )
  }
  return runtimeError(
    'PERSISTENCE_IO_ERROR',
    'persistence',
    'SQLite SessionJournal operation failed.',
    { operation },
    true,
  )
}

function isBusy(error: unknown): boolean {
  if (!isRecord(error)) return false
  return (
    String(error.code ?? '').includes('BUSY') ||
    error.errcode === 5 ||
    String(error.message ?? '')
      .toLowerCase()
      .includes('database is locked')
  )
}

function isRuntimeError(error: unknown): error is { code: string; category: string } {
  return isRecord(error) && typeof error.code === 'string' && typeof error.category === 'string'
}

function journalError(code: string) {
  return runtimeError(code, 'persistence', 'SQLite SessionJournal operation failed.')
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(value)
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
