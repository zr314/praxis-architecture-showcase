import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  assertSessionCommitAgainstHeadV3,
  createSessionCommitV3,
  reduceSessionEntriesV3,
  runtimeError,
  sessionCompactionSummaryDigestV3,
  sessionCommitReceiptV3,
  validateSessionCommitV3,
  validateSessionEntryV3,
  type ProviderMessage,
  type ReadSessionEntriesInputV3,
  type SessionCatalogProjectionV3,
  type SessionCommitReceiptV3,
  type SessionCommitV3,
  type SessionEntryPageV3,
  type SessionEntryV3,
  type SessionJournalArchiveStoreV3,
  type SessionMemory,
  type SessionProjectionV3,
  type SessionRecord,
} from '@praxis/core-sdk'

const FORMAT_VERSION = 3 as const
const LOCK_TIMEOUT_MS = 5_000
const STALE_LOCK_MS = 30_000
const MAX_READ_PAGE = 512

type JsonlCommitRecordV3 = Readonly<{
  formatVersion: 3
  commit: SessionCommitV3
  recordChecksum: `sha256:${string}`
}>

type ParsedJournal = Readonly<{
  records: readonly JsonlCommitRecordV3[]
  validBytes: number
  physicalBytes: number
}>

type ProjectionCacheV3 = Readonly<{
  formatVersion: 3
  lastCommitId: string
  projection: SessionProjectionV3
  checksum: `sha256:${string}`
}>

type CatalogCacheV3 = Readonly<{
  formatVersion: 3
  sessions: readonly SessionCatalogProjectionV3[]
  recoverableSessionIds: readonly string[]
  checksum: `sha256:${string}`
}>

type CatalogDeltaRecordV3 = Readonly<{
  formatVersion: 3
  catalog: SessionCatalogProjectionV3
  recoverable: boolean
  recordChecksum: `sha256:${string}`
}>

type CatalogStateV3 = Readonly<{
  formatVersion: 3
  strategy: 'incremental-v1'
  baseCatalogChecksum: `sha256:${string}`
  checksum: `sha256:${string}`
}>

type PendingProjectionV3 = Readonly<{
  formatVersion: 3
  sessionId: string
  checksum: `sha256:${string}`
}>

export type SessionJournalScrubReportV3 = Readonly<{
  store: 'jsonl'
  sessions: number
  repairedPending: number
}>

export type JsonlSessionJournalFaultPointV3 =
  | 'before_append'
  | 'after_append_fsync'
  | 'before_projection_write'
  | 'before_catalog_write'

export type JsonlSessionJournalOptionsV3 = Readonly<{
  faultInjector?: (point: JsonlSessionJournalFaultPointV3) => void | Promise<void>
  deepScrubOnInitialize?: boolean
}>

export type JsonlV2MigrationReport = Readonly<{
  formatVersion: 3
  sourceVersion: 2
  sourceCatalogDigest: `sha256:${string}`
  backupDirectory: string
  sessionCount: number
  messageCount: number
  artifactCount: number
  warnings: readonly string[]
}>

/** Durable JSONL implementation of the mandatory V3 atomic commit store. */
export class JsonlSessionJournalV3 implements SessionJournalArchiveStoreV3 {
  readonly #journalRoot: string
  readonly #commitDirectory: string
  readonly #projectionDirectory: string
  readonly #artifactDirectory: string
  readonly #lockDirectory: string
  readonly #catalogPath: string
  readonly #catalogDeltaPath: string
  readonly #catalogStatePath: string
  readonly #pendingDirectory: string
  readonly #authorityPath: string
  readonly #migrationReportPath: string
  readonly #backupRoot: string
  #initialized = false

  constructor(
    private readonly root = process.env.PRAXIS_HOME ?? join(homedir(), '.praxis'),
    private readonly options: JsonlSessionJournalOptionsV3 = {},
  ) {
    this.#journalRoot = join(root, 'session-journal-v3')
    this.#commitDirectory = join(this.#journalRoot, 'commits')
    this.#projectionDirectory = join(this.#journalRoot, 'projections')
    this.#artifactDirectory = join(this.#journalRoot, 'artifacts')
    this.#lockDirectory = join(root, 'locks')
    this.#catalogPath = join(this.#journalRoot, 'catalog.json')
    this.#catalogDeltaPath = join(this.#journalRoot, 'catalog-delta.jsonl')
    this.#catalogStatePath = join(this.#journalRoot, 'catalog-state.json')
    this.#pendingDirectory = join(this.#journalRoot, 'pending')
    this.#authorityPath = join(this.#journalRoot, 'authority.json')
    this.#migrationReportPath = join(this.#journalRoot, 'migration-report.json')
    this.#backupRoot = join(root, 'migration-backups')
  }

  async initialize(): Promise<void> {
    await this.run('initialize', async () => {
      if (!(await exists(this.#journalRoot)) && (await exists(join(this.root, 'sessions.json')))) {
        await this.migrateV2Atomically()
      }
      await Promise.all([
        mkdir(this.#commitDirectory, { recursive: true }),
        mkdir(this.#projectionDirectory, { recursive: true }),
        mkdir(this.#artifactDirectory, { recursive: true }),
        mkdir(this.#pendingDirectory, { recursive: true }),
        mkdir(this.#lockDirectory, { recursive: true }),
      ])
      await this.withLock('journal-v3-catalog', async () => {
        if (!(await exists(this.#authorityPath))) {
          await atomicWriteJson(this.#authorityPath, authorityRecord())
        } else {
          validateAuthority(JSON.parse(await readFile(this.#authorityPath, 'utf8')))
        }
        if (
          this.options.deepScrubOnInitialize === true ||
          process.env.PRAXIS_SESSION_SCRUB === 'deep'
        ) {
          await this.rebuildCatalogUnlocked()
        } else if (!(await exists(this.#catalogStatePath))) {
          // Stores created before incremental-v1 have no state marker. Upgrade them once
          // before validating the newer catalog shape.
          await this.rebuildCatalogUnlocked()
        } else {
          await this.readCatalogUnlocked()
          await this.recoverPendingUnlocked()
        }
      })
      this.#initialized = true
    })
  }

  async appendCommit(input: SessionCommitV3): Promise<SessionCommitReceiptV3> {
    this.requireInitialized()
    const commit = validateSessionCommitV3(input)
    return this.run('append_commit', () =>
      this.withLock(`journal-v3-session-${commit.sessionId}`, async () => {
        const parsed = await this.readJournal(commit.sessionId)
        await this.repairTail(commit.sessionId, parsed)
        const duplicate = findDuplicate(parsed.records, commit)
        if (duplicate !== undefined) {
          await this.refreshProjection(commit.sessionId, parsed.records)
          return sessionCommitReceiptV3(duplicate, true)
        }

        const priorEntries = flattenEntries(parsed.records)
        assertSessionCommitAgainstHeadV3(commit, head(priorEntries))
        reduceSessionEntriesV3([...priorEntries, ...commit.entries])
        await this.markPending(commit.sessionId)
        await this.inject('before_append')
        await this.appendRecord(commit.sessionId, createRecord(commit))
        await this.inject('after_append_fsync')

        const records = [...parsed.records, createRecord(commit)]
        await this.refreshProjection(commit.sessionId, records)
        await this.clearPending(commit.sessionId)
        return sessionCommitReceiptV3(commit)
      }),
    )
  }

  async readEntries(input: ReadSessionEntriesInputV3): Promise<SessionEntryPageV3> {
    this.requireInitialized()
    return this.run('read_entries', async () => {
      validateReadInput(input)
      const parsed = await this.readJournal(input.sessionId)
      if (parsed.records.length === 0) throw journalError('SESSION_NOT_FOUND')
      const entries = flattenEntries(parsed.records)
      const currentHead = head(entries)!
      const through = input.throughSequence ?? currentHead.sequence
      if (through > currentHead.sequence) throw journalError('SESSION_READ_INVALID')
      const after = input.afterSequence ?? 0
      const limit = input.limit ?? MAX_READ_PAGE
      const selected = entries
        .filter((entry) => entry.sequence > after && entry.sequence <= through)
        .slice(0, limit)
      const nextAfterSequence = selected.at(-1)?.sequence ?? after
      return {
        sessionId: input.sessionId,
        entries: selected,
        nextAfterSequence,
        hasMore: nextAfterSequence < through,
        head: currentHead,
      }
    })
  }

  async listCatalog(): Promise<readonly SessionCatalogProjectionV3[]> {
    this.requireInitialized()
    return this.run('list_catalog', () =>
      this.withLock('journal-v3-catalog', async () =>
        sortCatalog((await this.readCatalogUnlocked()).sessions),
      ),
    )
  }

  async listSessionIds(): Promise<readonly string[]> {
    this.requireInitialized()
    return this.run('list_session_ids', async () =>
      (await this.listCatalog()).map(({ sessionId }) => sessionId).sort(),
    )
  }

  async listRecoverableSessionIds(): Promise<readonly string[]> {
    this.requireInitialized()
    return this.run('list_recoverable_session_ids', () =>
      this.withLock('journal-v3-catalog', async () =>
        [...(await this.readCatalogUnlocked()).recoverableSessionIds].sort(),
      ),
    )
  }

  async loadCachedProjection(sessionId: string): Promise<SessionProjectionV3> {
    this.requireInitialized()
    return this.run('load_cached_projection', async () => {
      try {
        const cache = validateProjectionCache(
          JSON.parse(await readFile(this.projectionPath(sessionId), 'utf8')),
          sessionId,
        )
        return cache.projection
      } catch (error) {
        if (isNotFound(error)) throw journalError('SESSION_NOT_FOUND')
        throw error
      }
    })
  }

  async deepScrub(): Promise<SessionJournalScrubReportV3> {
    this.requireInitialized()
    return this.run('deep_scrub', () =>
      this.withLock('journal-v3-catalog', async () => {
        const repairedPending = await this.pendingCount()
        const sessions = await this.rebuildCatalogUnlocked()
        return { store: 'jsonl' as const, sessions: sessions.length, repairedPending }
      }),
    )
  }

  async readCommits(sessionId: string): Promise<readonly SessionCommitV3[]> {
    this.requireInitialized()
    return this.run('read_commits', async () => {
      const parsed = await this.readJournal(sessionId)
      if (parsed.records.length === 0) throw journalError('SESSION_NOT_FOUND')
      return parsed.records.map((record) => validateSessionCommitV3(structuredClone(record.commit)))
    })
  }

  async migrationReport(): Promise<JsonlV2MigrationReport | undefined> {
    this.requireInitialized()
    try {
      return validateMigrationReport(JSON.parse(await readFile(this.#migrationReportPath, 'utf8')))
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  private async refreshProjection(
    sessionId: string,
    records: readonly JsonlCommitRecordV3[],
  ): Promise<void> {
    const projection = reduceSessionEntriesV3(flattenEntries(records))
    await this.inject('before_projection_write')
    await atomicWriteJson(
      this.projectionPath(sessionId),
      projectionCache(projection, records.at(-1)!.commit.commitId),
    )
    await this.withLock('journal-v3-catalog', async () => {
      await this.inject('before_catalog_write')
      await this.appendCatalogDeltaUnlocked(projection)
    })
  }

  private async rebuildCatalogUnlocked(): Promise<readonly SessionCatalogProjectionV3[]> {
    const projections = await this.scanProjections(true)
    const sessions = [...projections.values()].map((projection) => projection.catalog)
    const cache = catalogCache(sessions, recoverableSessionIds(projections.values()))
    await atomicWriteJson(this.#catalogPath, cache)
    await atomicWrite(this.#catalogDeltaPath, '')
    await atomicWriteJson(this.#catalogStatePath, catalogState(cache.checksum))
    await this.clearAllPendingUnlocked()
    return sortCatalog(sessions)
  }

  private async readCatalogUnlocked(): Promise<CatalogCacheV3> {
    const base = validateCatalogCache(JSON.parse(await readFile(this.#catalogPath, 'utf8')))
    validateCatalogState(JSON.parse(await readFile(this.#catalogStatePath, 'utf8')), base.checksum)
    const sessions = new Map(base.sessions.map((session) => [session.sessionId, session]))
    const recoverable = new Set(base.recoverableSessionIds)
    const parsed = await this.readCatalogDeltaUnlocked()
    for (const record of parsed.records) {
      sessions.set(record.catalog.sessionId, record.catalog)
      if (record.recoverable) recoverable.add(record.catalog.sessionId)
      else recoverable.delete(record.catalog.sessionId)
    }
    if (parsed.physicalBytes > parsed.validBytes) {
      await truncate(this.#catalogDeltaPath, parsed.validBytes)
    }
    return catalogCache([...sessions.values()], [...recoverable])
  }

  private async appendCatalogDeltaUnlocked(projection: SessionProjectionV3): Promise<void> {
    const record = catalogDeltaRecord(projection)
    const handle = await open(this.#catalogDeltaPath, 'a')
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private async readCatalogDeltaUnlocked(): Promise<{
    records: CatalogDeltaRecordV3[]
    validBytes: number
    physicalBytes: number
  }> {
    // A validated incremental store always owns this file, even when it is empty.
    // Its disappearance must fail closed instead of silently hiding committed updates.
    const source = await readFile(this.#catalogDeltaPath)
    const records: CatalogDeltaRecordV3[] = []
    let lineStart = 0
    let validBytes = 0
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] !== 0x0a) continue
      let lineEnd = index
      if (lineEnd > lineStart && source[lineEnd - 1] === 0x0d) lineEnd -= 1
      const line = source.subarray(lineStart, lineEnd).toString('utf8')
      lineStart = index + 1
      validBytes = lineStart
      if (line) records.push(validateCatalogDeltaRecord(JSON.parse(line)))
    }
    return { records, validBytes, physicalBytes: source.length }
  }

  private async recoverPendingUnlocked(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.#pendingDirectory)
    } catch (error) {
      if (isNotFound(error)) return
      throw error
    }
    for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
      const path = join(this.#pendingDirectory, name)
      const pending = validatePendingProjection(JSON.parse(await readFile(path, 'utf8')))
      if (`${encodeSessionFile(pending.sessionId)}.json` !== name) {
        throw new SyntaxError('Pending projection file name mismatch.')
      }
      const parsed = await this.readJournal(pending.sessionId)
      await this.repairTail(pending.sessionId, parsed)
      if (parsed.records.length > 0) {
        const projection = reduceSessionEntriesV3(flattenEntries(parsed.records))
        await atomicWriteJson(
          this.projectionPath(pending.sessionId),
          projectionCache(projection, parsed.records.at(-1)!.commit.commitId),
        )
        await this.appendCatalogDeltaUnlocked(projection)
      }
      await unlink(path)
      await syncDirectory(this.#pendingDirectory)
    }
  }

  private async markPending(sessionId: string): Promise<void> {
    await atomicWriteJson(this.pendingPath(sessionId), pendingProjection(sessionId))
  }

  private async clearPending(sessionId: string): Promise<void> {
    await unlink(this.pendingPath(sessionId)).catch((error) => {
      if (!isNotFound(error)) throw error
    })
    await syncDirectory(this.#pendingDirectory)
  }

  private async clearAllPendingUnlocked(): Promise<void> {
    for (const name of await readdir(this.#pendingDirectory)) {
      if (name.endsWith('.json')) await unlink(join(this.#pendingDirectory, name))
    }
    await syncDirectory(this.#pendingDirectory)
  }

  private async pendingCount(): Promise<number> {
    return (await readdir(this.#pendingDirectory)).filter((name) => name.endsWith('.json')).length
  }

  private async scanProjections(rewrite = false): Promise<Map<string, SessionProjectionV3>> {
    const projections = new Map<string, SessionProjectionV3>()
    for (const sessionId of await this.discoverSessionIds()) {
      const parsed = await this.readJournal(sessionId)
      if (parsed.records.length === 0) continue
      const projection = reduceSessionEntriesV3(flattenEntries(parsed.records))
      projections.set(sessionId, projection)
      if (rewrite) {
        await atomicWriteJson(
          this.projectionPath(sessionId),
          projectionCache(projection, parsed.records.at(-1)!.commit.commitId),
        )
      }
    }
    return projections
  }

  private async discoverSessionIds(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(this.#commitDirectory)
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    return names
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => decodeSessionFile(name.slice(0, -'.jsonl'.length)))
      .sort()
  }

  private async readJournal(sessionId: string): Promise<ParsedJournal> {
    const path = this.commitPath(sessionId)
    try {
      const source = await readFile(path)
      return parseJournal(source, sessionId)
    } catch (error) {
      if (isNotFound(error)) return { records: [], validBytes: 0, physicalBytes: 0 }
      throw error
    }
  }

  private async appendRecord(sessionId: string, record: JsonlCommitRecordV3): Promise<void> {
    const path = this.commitPath(sessionId)
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(path, 'a')
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private async repairTail(sessionId: string, parsed: ParsedJournal): Promise<void> {
    if (parsed.physicalBytes <= parsed.validBytes) return
    await truncate(this.commitPath(sessionId), parsed.validBytes)
  }

  private async migrateV2Atomically(): Promise<void> {
    const backupDirectory = join(
      this.#backupRoot,
      `v2-${safeTimestamp()}-${randomUUID().slice(0, 8)}`,
    )
    const source = await readV2Source(this.root)
    const stage = `${this.#journalRoot}.migrate-${process.pid}-${randomUUID()}`
    try {
      await buildMigratedJournal(stage, source, backupDirectory)
      await backupV2(this.root, backupDirectory)
      try {
        await rename(stage, this.#journalRoot)
      } catch (error) {
        if (!(await exists(this.#journalRoot))) throw error
        await rm(stage, { recursive: true, force: true })
      }
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => {})
      if (isRuntimeError(error)) {
        throw new SyntaxError('V2 data cannot be represented by SessionJournal V3.')
      }
      throw error
    }
  }

  private async withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    await mkdir(this.#lockDirectory, { recursive: true })
    const path = join(this.#lockDirectory, `${encodeSessionFile(name)}.lock`)
    const startedAt = Date.now()
    while (true) {
      try {
        const handle = await open(path, 'wx')
        try {
          await handle.writeFile(
            JSON.stringify({
              formatVersion: 3,
              pid: process.pid,
              acquiredAt: new Date().toISOString(),
            }),
          )
          await handle.sync()
          return await action()
        } finally {
          await handle.close()
          await unlink(path).catch(() => {})
        }
      } catch (error) {
        if (!isAlreadyExists(error)) throw error
        if (await isStaleLock(path)) {
          await unlink(path).catch(() => {})
          continue
        }
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw runtimeError(
            'SESSION_WRITE_CONFLICT',
            'persistence',
            'Another process owns the SessionJournal writer lock.',
            undefined,
            true,
          )
        }
        await delay(25)
      }
    }
  }

  private async inject(point: JsonlSessionJournalFaultPointV3): Promise<void> {
    await this.options.faultInjector?.(point)
  }

  private commitPath(sessionId: string): string {
    return join(this.#commitDirectory, `${encodeSessionFile(sessionId)}.jsonl`)
  }

  private projectionPath(sessionId: string): string {
    return join(this.#projectionDirectory, `${encodeSessionFile(sessionId)}.json`)
  }

  private pendingPath(sessionId: string): string {
    return join(this.#pendingDirectory, `${encodeSessionFile(sessionId)}.json`)
  }

  private requireInitialized(): void {
    if (!this.#initialized) throw journalError('SESSION_JOURNAL_NOT_INITIALIZED')
  }

  private async run<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      if (isRuntimeError(error)) throw error
      const invalid = error instanceof SyntaxError
      throw runtimeError(
        invalid ? 'PERSISTENCE_INVALID_DATA' : 'PERSISTENCE_IO_ERROR',
        'persistence',
        invalid ? 'SessionJournal data is invalid.' : 'SessionJournal operation failed.',
        {
          operation,
          ...(error instanceof Error && error.message ? { detail: error.message } : {}),
        },
        !invalid,
      )
    }
  }
}

function createRecord(commit: SessionCommitV3): JsonlCommitRecordV3 {
  const payload = { formatVersion: FORMAT_VERSION, commit }
  return { ...payload, recordChecksum: digest(payload) }
}

function parseJournal(source: Buffer, sessionId: string): ParsedJournal {
  const records: JsonlCommitRecordV3[] = []
  let lineStart = 0
  let validBytes = 0
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== 0x0a) continue
    let lineEnd = index
    if (lineEnd > lineStart && source[lineEnd - 1] === 0x0d) lineEnd -= 1
    const line = source.subarray(lineStart, lineEnd).toString('utf8')
    lineStart = index + 1
    validBytes = lineStart
    if (!line) continue
    const parsed = validateRecord(JSON.parse(line), sessionId)
    if (records.length > 0) {
      try {
        const priorEntries = flattenEntries(records)
        assertSessionCommitAgainstHeadV3(parsed.commit, head(priorEntries))
      } catch {
        throw new SyntaxError('SessionJournal commit order mismatch.')
      }
    }
    records.push(parsed)
  }
  if (records.length > 0) {
    try {
      reduceSessionEntriesV3(flattenEntries(records))
    } catch {
      throw new SyntaxError('SessionJournal reducer rejected persisted entries.')
    }
  }
  return { records, validBytes, physicalBytes: source.length }
}

function validateRecord(input: unknown, sessionId: string): JsonlCommitRecordV3 {
  if (
    !isRecord(input) ||
    !onlyKeys(input, ['formatVersion', 'commit', 'recordChecksum']) ||
    input.formatVersion !== FORMAT_VERSION ||
    typeof input.recordChecksum !== 'string'
  ) {
    throw new SyntaxError('Invalid SessionJournal commit record.')
  }
  let commit: SessionCommitV3
  try {
    commit = validateSessionCommitV3(input.commit)
  } catch {
    throw new SyntaxError('Invalid SessionJournal commit.')
  }
  if (commit.sessionId !== sessionId) throw new SyntaxError('SessionJournal session mismatch.')
  const payload = { formatVersion: FORMAT_VERSION, commit }
  if (input.recordChecksum !== digest(payload)) {
    throw new SyntaxError('SessionJournal record checksum mismatch.')
  }
  return { ...payload, recordChecksum: input.recordChecksum as `sha256:${string}` }
}

function findDuplicate(
  records: readonly JsonlCommitRecordV3[],
  candidate: SessionCommitV3,
): SessionCommitV3 | undefined {
  for (const record of records) {
    const existing = record.commit
    if (
      existing.commitId !== candidate.commitId &&
      existing.idempotencyKey !== candidate.idempotencyKey
    ) {
      continue
    }
    if (
      existing.commitId !== candidate.commitId ||
      existing.idempotencyKey !== candidate.idempotencyKey ||
      existing.checksum !== candidate.checksum
    ) {
      throw journalError('SESSION_COMMIT_IDEMPOTENCY_CONFLICT')
    }
    return existing
  }
  return undefined
}

function flattenEntries(records: readonly JsonlCommitRecordV3[]): SessionEntryV3[] {
  return records.flatMap((record) => [...record.commit.entries])
}

function head(entries: readonly SessionEntryV3[]) {
  const last = entries.at(-1)
  return last === undefined ? undefined : { revision: last.revision, sequence: last.sequence }
}

function projectionCache(projection: SessionProjectionV3, lastCommitId: string): ProjectionCacheV3 {
  const payload = { formatVersion: FORMAT_VERSION, lastCommitId, projection }
  return { ...payload, checksum: digest(payload) }
}

function catalogCache(
  input: readonly SessionCatalogProjectionV3[],
  recoverableSessionIds: readonly string[] = [],
): CatalogCacheV3 {
  const sessions = sortCatalog(input)
  const payload = {
    formatVersion: FORMAT_VERSION,
    sessions,
    recoverableSessionIds: [...new Set(recoverableSessionIds)].sort(),
  }
  return { ...payload, checksum: digest(payload) }
}

function validateCatalogCache(input: unknown): CatalogCacheV3 {
  if (
    !isRecord(input) ||
    !onlyKeys(input, ['formatVersion', 'sessions', 'recoverableSessionIds', 'checksum']) ||
    input.formatVersion !== FORMAT_VERSION ||
    !Array.isArray(input.sessions) ||
    !input.sessions.every(isCatalogProjection) ||
    !Array.isArray(input.recoverableSessionIds) ||
    !input.recoverableSessionIds.every(safeId) ||
    typeof input.checksum !== 'string'
  ) {
    throw new SyntaxError('Invalid SessionJournal catalog cache.')
  }
  const payload = {
    formatVersion: FORMAT_VERSION,
    sessions: input.sessions,
    recoverableSessionIds: input.recoverableSessionIds,
  }
  if (input.checksum !== digest(payload)) throw new SyntaxError('Catalog checksum mismatch.')
  return structuredClone(input) as CatalogCacheV3
}

function validateProjectionCache(input: unknown, sessionId: string): ProjectionCacheV3 {
  if (
    !isRecord(input) ||
    !onlyKeys(input, ['formatVersion', 'lastCommitId', 'projection', 'checksum']) ||
    input.formatVersion !== FORMAT_VERSION ||
    typeof input.lastCommitId !== 'string' ||
    !isRecord(input.projection) ||
    typeof input.checksum !== 'string'
  ) {
    throw new SyntaxError('Invalid SessionJournal projection cache.')
  }
  const payload = {
    formatVersion: FORMAT_VERSION,
    lastCommitId: input.lastCommitId,
    projection: input.projection,
  }
  if (input.checksum !== digest(payload)) throw new SyntaxError('Projection checksum mismatch.')
  const projection = input.projection as unknown as SessionProjectionV3
  if (projection.snapshot?.sessionId !== sessionId || projection.catalog?.sessionId !== sessionId) {
    throw new SyntaxError('Projection session mismatch.')
  }
  return structuredClone(input) as ProjectionCacheV3
}

function catalogDeltaRecord(projection: SessionProjectionV3): CatalogDeltaRecordV3 {
  const payload = {
    formatVersion: FORMAT_VERSION,
    catalog: projection.catalog,
    recoverable: projectionHasRecoverableRun(projection),
  }
  return { ...payload, recordChecksum: digest(payload) }
}

function validateCatalogDeltaRecord(input: unknown): CatalogDeltaRecordV3 {
  if (
    !isRecord(input) ||
    !onlyKeys(input, ['formatVersion', 'catalog', 'recoverable', 'recordChecksum']) ||
    input.formatVersion !== FORMAT_VERSION ||
    !isCatalogProjection(input.catalog) ||
    typeof input.recoverable !== 'boolean' ||
    typeof input.recordChecksum !== 'string'
  ) {
    throw new SyntaxError('Invalid SessionJournal catalog delta.')
  }
  const payload = {
    formatVersion: FORMAT_VERSION,
    catalog: input.catalog,
    recoverable: input.recoverable,
  }
  if (input.recordChecksum !== digest(payload)) {
    throw new SyntaxError('Catalog delta checksum mismatch.')
  }
  return structuredClone(input) as CatalogDeltaRecordV3
}

function catalogState(baseCatalogChecksum: `sha256:${string}`): CatalogStateV3 {
  const payload = {
    formatVersion: FORMAT_VERSION,
    strategy: 'incremental-v1' as const,
    baseCatalogChecksum,
  }
  return { ...payload, checksum: digest(payload) }
}

function validateCatalogState(input: unknown, baseCatalogChecksum: `sha256:${string}`): void {
  if (
    !isRecord(input) ||
    !onlyKeys(input, ['formatVersion', 'strategy', 'baseCatalogChecksum', 'checksum']) ||
    input.formatVersion !== FORMAT_VERSION ||
    input.strategy !== 'incremental-v1' ||
    input.baseCatalogChecksum !== baseCatalogChecksum ||
    typeof input.checksum !== 'string' ||
    input.checksum !==
      digest({
        formatVersion: FORMAT_VERSION,
        strategy: 'incremental-v1',
        baseCatalogChecksum,
      })
  ) {
    throw new SyntaxError('Invalid SessionJournal catalog state.')
  }
}

function pendingProjection(sessionId: string): PendingProjectionV3 {
  const payload = { formatVersion: FORMAT_VERSION, sessionId }
  return { ...payload, checksum: digest(payload) }
}

function validatePendingProjection(input: unknown): PendingProjectionV3 {
  if (
    !isRecord(input) ||
    !onlyKeys(input, ['formatVersion', 'sessionId', 'checksum']) ||
    input.formatVersion !== FORMAT_VERSION ||
    !safeId(input.sessionId) ||
    typeof input.checksum !== 'string' ||
    input.checksum !== digest({ formatVersion: FORMAT_VERSION, sessionId: input.sessionId })
  ) {
    throw new SyntaxError('Invalid pending projection marker.')
  }
  return structuredClone(input) as PendingProjectionV3
}

function recoverableSessionIds(projections: Iterable<SessionProjectionV3>): readonly string[] {
  return [...projections]
    .filter(projectionHasRecoverableRun)
    .map(({ snapshot }) => snapshot.sessionId)
    .sort()
}

function projectionHasRecoverableRun(projection: SessionProjectionV3): boolean {
  return (
    projection.snapshot.lifecycle === 'open' &&
    projection.snapshot.runs.some(({ state }) => state === 'running')
  )
}

function isCatalogProjection(input: unknown): input is SessionCatalogProjectionV3 {
  return (
    isRecord(input) &&
    onlyKeys(input, [
      'sessionId',
      'name',
      'workspace',
      'provider',
      'model',
      'lifecycle',
      'activeLeafId',
      'parentSessionId',
      'messageCount',
      'updatedAt',
      'revision',
    ]) &&
    safeId(input.sessionId) &&
    typeof input.name === 'string' &&
    typeof input.workspace === 'string' &&
    typeof input.provider === 'string' &&
    typeof input.model === 'string' &&
    ['open', 'closed', 'deleted'].includes(String(input.lifecycle)) &&
    safeId(input.activeLeafId) &&
    (input.parentSessionId === undefined || safeId(input.parentSessionId)) &&
    nonNegativeInteger(input.messageCount) &&
    canonicalInstant(input.updatedAt) &&
    nonNegativeInteger(input.revision) &&
    input.revision >= 1
  )
}

function sortCatalog(
  sessions: readonly SessionCatalogProjectionV3[],
): SessionCatalogProjectionV3[] {
  return [...sessions].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.sessionId.localeCompare(right.sessionId),
  )
}

function authorityRecord() {
  const payload = { formatVersion: FORMAT_VERSION, backend: 'jsonl' as const }
  return { ...payload, checksum: digest(payload) }
}

function validateAuthority(input: unknown): void {
  if (
    !isRecord(input) ||
    !onlyKeys(input, ['formatVersion', 'backend', 'checksum']) ||
    input.formatVersion !== FORMAT_VERSION ||
    input.backend !== 'jsonl' ||
    input.checksum !== digest({ formatVersion: FORMAT_VERSION, backend: 'jsonl' })
  ) {
    throw new SyntaxError('Invalid SessionJournal authority marker.')
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (!hasCode(error, 'EPERM') && !hasCode(error, 'EINVAL') && !hasCode(error, 'EISDIR'))
      throw error
  }
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

function encodeSessionFile(value: string): string {
  if (!safeId(value)) throw journalError('SESSION_ID_INVALID')
  return Buffer.from(value, 'utf8').toString('base64url')
}

function decodeSessionFile(value: string): string {
  const decoded = Buffer.from(value, 'base64url').toString('utf8')
  if (encodeSessionFile(decoded) !== value)
    throw new SyntaxError('Invalid SessionJournal file name.')
  return decoded
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > STALE_LOCK_MS
  } catch {
    return false
  }
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
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

function journalError(code: string) {
  return runtimeError(code, 'persistence', 'SessionJournal operation failed.')
}

function isRuntimeError(error: unknown): error is { code: string; category: string } {
  return isRecord(error) && typeof error.code === 'string' && typeof error.category === 'string'
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function isNotFound(error: unknown): boolean {
  return hasCode(error, 'ENOENT')
}

function isAlreadyExists(error: unknown): boolean {
  return hasCode(error, 'EEXIST')
}

type V2Source = Readonly<{
  catalogDigest: `sha256:${string}`
  sessions: readonly Readonly<{
    record: SessionRecord
    history: readonly Readonly<{
      committedAt: string
      message: ProviderMessage
      clientRequestId?: string
      runId?: string
    }>[]
    memory: SessionMemory
  }>[]
}>

async function backupV2(root: string, backupDirectory: string): Promise<void> {
  await mkdir(dirname(backupDirectory), { recursive: true })
  await mkdir(backupDirectory, { recursive: false })
  for (const name of ['sessions.json', 'sessions', 'history', 'memory']) {
    const source = join(root, name)
    if (!(await exists(source))) continue
    const target = join(backupDirectory, name)
    if ((await stat(source)).isDirectory())
      await cp(source, target, { recursive: true, errorOnExist: true })
    else await copyFile(source, target)
  }
}

async function readV2Source(root: string): Promise<V2Source> {
  const rawCatalog = await readFile(join(root, 'sessions.json'), 'utf8')
  const catalog = JSON.parse(rawCatalog) as unknown
  if (
    !isRecord(catalog) ||
    catalog.version !== 2 ||
    !Array.isArray(catalog.sessions) ||
    typeof catalog.updatedAt !== 'string' ||
    typeof catalog.checksum !== 'string'
  ) {
    throw new SyntaxError('Unsupported V2 Session catalog.')
  }
  const catalogPayload = { version: 2, updatedAt: catalog.updatedAt, sessions: catalog.sessions }
  if (catalog.checksum !== digest(catalogPayload))
    throw new SyntaxError('V2 catalog checksum mismatch.')

  const sessions = []
  const sessionIds = new Set<string>()
  for (const candidate of catalog.sessions) {
    const record = validateV2Record(candidate)
    if (sessionIds.has(record.sessionId)) throw new SyntaxError('Duplicate V2 Session ID.')
    sessionIds.add(record.sessionId)
    await validateV2MetadataIfPresent(root, record)
    const history = await readV2History(root, record.sessionId)
    if ((record.messageCount ?? 0) !== history.length) {
      throw new SyntaxError('V2 message count does not match valid history.')
    }
    sessions.push({
      record,
      history,
      memory: await readV2Memory(root, record.sessionId),
    })
  }
  for (const session of sessions) {
    if (
      session.record.parentSessionId !== undefined &&
      !sessionIds.has(session.record.parentSessionId)
    ) {
      throw new SyntaxError('V2 parent Session does not exist.')
    }
    if (session.record.activeLeafId !== undefined && !sessionIds.has(session.record.activeLeafId)) {
      throw new SyntaxError('V2 active leaf does not exist.')
    }
  }
  return { catalogDigest: digest(JSON.parse(rawCatalog)), sessions }
}

function validateV2Record(input: unknown): SessionRecord {
  if (
    !isRecord(input) ||
    !safeV2SessionId(input.sessionId) ||
    !['idle', 'running', 'closed'].includes(String(input.state)) ||
    typeof input.cwd !== 'string' ||
    typeof input.provider !== 'string' ||
    typeof input.model !== 'string' ||
    !canonicalInstant(input.createdAt) ||
    !canonicalInstant(input.updatedAt)
  ) {
    throw new SyntaxError('Invalid V2 Session record.')
  }
  const record = structuredClone(input) as SessionRecord
  if (
    (record.parentSessionId !== undefined && !safeV2SessionId(record.parentSessionId)) ||
    (record.activeLeafId !== undefined && !safeV2SessionId(record.activeLeafId))
  ) {
    throw new SyntaxError('Invalid V2 branch identifier.')
  }
  return record
}

function safeV2SessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
}

async function validateV2MetadataIfPresent(root: string, record: SessionRecord): Promise<void> {
  const path = join(root, 'sessions', `${record.sessionId}.json`)
  try {
    const metadata = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (
      !isRecord(metadata) ||
      metadata.version !== 2 ||
      !isRecord(metadata.session) ||
      metadata.session.sessionId !== record.sessionId ||
      typeof metadata.checksum !== 'string'
    ) {
      throw new SyntaxError('Invalid V2 Session metadata.')
    }
    const payload = { version: 2, session: metadata.session }
    if (metadata.checksum !== digest(payload))
      throw new SyntaxError('V2 metadata checksum mismatch.')
    if (JSON.stringify(metadata.session) !== JSON.stringify(record)) {
      throw new SyntaxError('V2 catalog and metadata disagree.')
    }
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
}

async function readV2History(
  root: string,
  sessionId: string,
): Promise<V2Source['sessions'][number]['history']> {
  let source: Buffer
  try {
    source = await readFile(join(root, 'history', `${sessionId}.jsonl`))
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
  const history = []
  let lineStart = 0
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== 0x0a) continue
    let lineEnd = index
    if (lineEnd > lineStart && source[lineEnd - 1] === 0x0d) lineEnd -= 1
    const line = source.subarray(lineStart, lineEnd).toString('utf8')
    lineStart = index + 1
    if (!line) continue
    const entry = JSON.parse(line) as unknown
    if (
      !isRecord(entry) ||
      (entry.version !== 1 && entry.version !== 2) ||
      !canonicalInstant(entry.committedAt) ||
      !isRecord(entry.message)
    ) {
      throw new SyntaxError('Invalid V2 history entry.')
    }
    if (entry.version === 2) {
      const { checksum, ...payload } = entry
      if (
        entry.sequence !== history.length + 1 ||
        typeof checksum !== 'string' ||
        checksum !== digest(payload)
      ) {
        throw new SyntaxError('Invalid V2 history checksum or sequence.')
      }
    }
    try {
      validateSessionEntryV3({
        schemaVersion: 3,
        entryId: `v2-validate-entry-${history.length + 1}`,
        sessionId,
        sequence: 1,
        revision: 1,
        timestamp: entry.committedAt,
        type: 'message.committed',
        data: { messageId: `v2-validate-message-${history.length + 1}`, message: entry.message },
      })
    } catch {
      throw new SyntaxError('V2 history message cannot be represented by SessionEntryV3.')
    }
    history.push({
      committedAt: entry.committedAt,
      message: structuredClone(entry.message) as ProviderMessage,
      ...(typeof entry.clientRequestId === 'string'
        ? { clientRequestId: entry.clientRequestId }
        : {}),
      ...(typeof entry.runId === 'string' ? { runId: entry.runId } : {}),
    })
  }
  return history
}

async function readV2Memory(root: string, sessionId: string): Promise<SessionMemory> {
  try {
    const input = JSON.parse(
      await readFile(join(root, 'memory', `${sessionId}.json`), 'utf8'),
    ) as unknown
    if (!isRecord(input)) throw new SyntaxError('Invalid V2 memory.')
    if (input.version !== 2) return validateV2Memory(input, sessionId)
    const payload = { version: 2, memory: input.memory }
    if (input.checksum !== digest(payload) || !isRecord(input.memory)) {
      throw new SyntaxError('Invalid V2 memory checksum.')
    }
    return validateV2Memory(input.memory, sessionId)
  } catch (error) {
    if (isNotFound(error)) return { sessionId }
    throw error
  }
}

function validateV2Memory(input: unknown, sessionId: string): SessionMemory {
  if (!isRecord(input) || input.sessionId !== sessionId) {
    throw new SyntaxError('Invalid V2 memory owner.')
  }
  if (input.checkpoint !== undefined) {
    const checkpoint = input.checkpoint
    if (
      !isRecord(checkpoint) ||
      typeof checkpoint.id !== 'string' ||
      !nonNegativeInteger(checkpoint.messageStart) ||
      !nonNegativeInteger(checkpoint.messageEnd) ||
      checkpoint.messageEnd < checkpoint.messageStart ||
      typeof checkpoint.content !== 'string' ||
      typeof checkpoint.digest !== 'string' ||
      typeof checkpoint.estimatedTokens !== 'number' ||
      !Number.isFinite(checkpoint.estimatedTokens) ||
      checkpoint.estimatedTokens < 0 ||
      !canonicalInstant(checkpoint.createdAt)
    ) {
      throw new SyntaxError('Invalid V2 memory checkpoint.')
    }
  }
  if (input.plan !== undefined) {
    const plan = input.plan
    if (
      !isRecord(plan) ||
      typeof plan.objective !== 'string' ||
      !nonNegativeInteger(plan.revision) ||
      !canonicalInstant(plan.updatedAt) ||
      !Array.isArray(plan.steps) ||
      !plan.steps.every(
        (step) =>
          isRecord(step) &&
          typeof step.id === 'string' &&
          typeof step.title === 'string' &&
          ['pending', 'in_progress', 'completed', 'blocked'].includes(String(step.state)),
      )
    ) {
      throw new SyntaxError('Invalid V2 memory plan.')
    }
  }
  return structuredClone(input) as SessionMemory
}

async function buildMigratedJournal(
  stage: string,
  source: V2Source,
  backupDirectory: string,
): Promise<void> {
  const commitDirectory = join(stage, 'commits')
  const projectionDirectory = join(stage, 'projections')
  const artifactDirectory = join(stage, 'artifacts')
  await Promise.all([
    mkdir(commitDirectory, { recursive: true }),
    mkdir(projectionDirectory, { recursive: true }),
    mkdir(artifactDirectory, { recursive: true }),
  ])
  const projections: SessionProjectionV3[] = []
  const warnings: string[] = []
  let messageCount = 0
  let artifactCount = 0
  for (const legacy of source.sessions) {
    const migrated = await migrateV2Session(legacy, artifactDirectory, warnings)
    messageCount += legacy.history.length
    artifactCount += migrated.artifactCount
    const record = createRecord(migrated.commit)
    await atomicWriteText(
      join(commitDirectory, `${encodeSessionFile(legacy.record.sessionId)}.jsonl`),
      `${JSON.stringify(record)}\n`,
    )
    const projection = reduceSessionEntriesV3(migrated.commit.entries)
    projections.push(projection)
    await atomicWriteJson(
      join(projectionDirectory, `${encodeSessionFile(legacy.record.sessionId)}.json`),
      projectionCache(projection, migrated.commit.commitId),
    )
  }
  await atomicWriteJson(
    join(stage, 'catalog.json'),
    catalogCache(projections.map((item) => item.catalog)),
  )
  await atomicWriteJson(join(stage, 'authority.json'), authorityRecord())
  const report: JsonlV2MigrationReport = {
    formatVersion: 3,
    sourceVersion: 2,
    sourceCatalogDigest: source.catalogDigest,
    backupDirectory,
    sessionCount: source.sessions.length,
    messageCount,
    artifactCount,
    warnings,
  }
  await atomicWriteJson(join(stage, 'migration-report.json'), migrationReportRecord(report))
}

async function migrateV2Session(
  legacy: V2Source['sessions'][number],
  artifactDirectory: string,
  warnings: string[],
): Promise<{ commit: SessionCommitV3; artifactCount: number }> {
  const entries: SessionEntryV3[] = []
  let timestamp = legacy.record.createdAt
  const push = (type: string, data: Record<string, unknown>, runId?: string) => {
    const sequence = entries.length + 1
    entries.push(
      validateSessionEntryV3({
        schemaVersion: 3,
        entryId: `v2-entry-${sequence}`,
        sessionId: legacy.record.sessionId,
        sequence,
        revision: 1,
        timestamp,
        type,
        ...(runId === undefined ? {} : { runId }),
        data,
      }),
    )
  }
  push('session.created', {
    cwd: legacy.record.cwd,
    provider: legacy.record.provider,
    model: legacy.record.model,
    name: legacy.record.name ?? legacy.record.sessionId,
    labels: [...(legacy.record.labels ?? [])],
    plannerMode: legacy.record.plannerMode ?? 'auto',
    ...(legacy.record.contextLimitTokens === undefined
      ? {}
      : { contextLimitTokens: legacy.record.contextLimitTokens }),
    ...(legacy.record.parentSessionId === undefined
      ? {}
      : {
          fork: {
            parentSessionId: legacy.record.parentSessionId,
            sourceEntryId: 'v2-migration-source',
          },
        }),
  })
  const mappedRunIndexes = legacy.history
    .map((history, index) =>
      history.clientRequestId !== undefined || history.runId !== undefined ? index : -1,
    )
    .filter((index) => index >= 0)
  const lastMappedRunIndex = mappedRunIndexes.at(-1)
  for (const [index, history] of legacy.history.entries()) {
    timestamp = laterTimestamp(timestamp, history.committedAt)
    push('message.committed', {
      messageId: `v2-message-${index + 1}`,
      message: history.message,
    })
    if ((history.clientRequestId === undefined) !== (history.runId === undefined)) {
      throw new SyntaxError('Incomplete V2 client request mapping.')
    }
    if (history.clientRequestId !== undefined && history.runId !== undefined) {
      if (!safeId(history.clientRequestId) || !safeId(history.runId)) {
        throw new SyntaxError('Invalid V2 client request mapping.')
      }
      push('run.started', { clientRequestId: history.clientRequestId }, history.runId)
      const isLast = index === lastMappedRunIndex
      const terminal = isLast ? legacy.record.lastTerminalState : 'completed'
      push(
        'run.terminal',
        {
          status: terminal ?? 'interrupted',
          usage: isLast ? { ...(legacy.record.usage ?? {}) } : {},
          ...(terminal === undefined ? { errorCode: 'V2_RECOVERED_INTERRUPTED' } : {}),
        },
        history.runId,
      )
      if (isLast && terminal === undefined) {
        warnings.push(`${legacy.record.sessionId}: unfinished V2 request recovered as interrupted.`)
      }
    }
  }

  const usage = legacy.record.usage
  if (usage !== undefined && Object.keys(usage).length > 0) {
    timestamp = laterTimestamp(timestamp, legacy.record.updatedAt)
    push('usage.recorded', {
      source: 'provider',
      usage: { turns: 0, toolCalls: 0, subagents: 0, ...usage },
    })
  }

  let artifactCount = 0
  if (legacy.memory.checkpoint !== undefined) {
    const legacyCheckpoint = legacy.memory.checkpoint
    const artifactContent = `${JSON.stringify(legacy.memory.checkpoint, undefined, 2)}\n`
    const bytes = Buffer.from(artifactContent, 'utf8')
    const artifactDigest = digestBytes(bytes)
    const checkpointDigest = digestBytes(Buffer.from(legacyCheckpoint.content, 'utf8'))
    const artifactId = `v2-checkpoint-${shortDigest(artifactDigest)}`
    await atomicWriteText(join(artifactDirectory, `${artifactId}.json`), artifactContent)
    artifactCount += 1
    timestamp = laterTimestamp(timestamp, legacyCheckpoint.createdAt)
    push('artifact.referenced', {
      owner: 'compaction',
      artifact: {
        artifactId,
        digest: artifactDigest,
        mimeType: 'application/vnd.praxis.v2-checkpoint+json',
        bytes: bytes.length,
      },
    })
    const summary = {
      schemaVersion: 1 as const,
      trust: 'low' as const,
      ...(legacyCheckpoint.summary?.objective === undefined
        ? {}
        : { objective: legacyCheckpoint.summary.objective }),
      ...(legacyCheckpoint.summary?.relevantRefs === undefined
        ? {}
        : { relevantRefs: [...legacyCheckpoint.summary.relevantRefs] }),
      decisions: [
        ...(legacyCheckpoint.summary?.decisions ??
          (legacyCheckpoint.content.trim()
            ? [legacyCheckpoint.content.trim().slice(0, 8_192)]
            : [])),
      ],
      constraints: [...(legacyCheckpoint.summary?.constraints ?? [])],
      readFiles: [...(legacyCheckpoint.summary?.readFiles ?? [])],
      modifiedFiles: [...(legacyCheckpoint.summary?.modifiedFiles ?? [])],
      unresolved: [...(legacyCheckpoint.summary?.unresolved ?? [])],
      activePlan: [...(legacyCheckpoint.summary?.activePlan ?? [])],
    }
    const provenance = legacyCheckpoint.provenance ?? {
      schemaVersion: 1 as const,
      generator: { kind: 'deterministic' as const, id: 'praxis-v2-import' },
    }
    const coveredEndSequence = entries.length
    push('compaction.created', {
      checkpointId: stableLegacyId('checkpoint', legacyCheckpoint.id),
      coveredStartSequence: 1,
      coveredEndSequence,
      retainedStartSequence: coveredEndSequence + 1,
      summary,
      provenance,
      summaryDigest: sessionCompactionSummaryDigestV3(summary),
      summaryTokens: legacyCheckpoint.estimatedTokens,
      reason: 'manual',
      checkpoint: {
        messageStart: legacyCheckpoint.messageStart,
        messageEnd: legacyCheckpoint.messageEnd,
        content: legacyCheckpoint.content,
        digest: checkpointDigest,
        ...(legacyCheckpoint.estimatedGainTokens === undefined
          ? {}
          : { estimatedGainTokens: legacyCheckpoint.estimatedGainTokens }),
        ...(legacyCheckpoint.scope === undefined ? {} : { scope: legacyCheckpoint.scope }),
        ...(legacyCheckpoint.skillInvocations === undefined
          ? {}
          : { skillInvocations: legacyCheckpoint.skillInvocations }),
      },
    })
  }

  if (legacy.memory.plan !== undefined) {
    push('session.plan_updated', { plan: legacy.memory.plan })
  }
  if (
    legacy.record.activeLeafId !== undefined &&
    legacy.record.activeLeafId !== legacy.record.sessionId
  ) {
    push('session.metadata_updated', { activeLeafId: legacy.record.activeLeafId })
  }
  if (legacy.record.state === 'closed') {
    timestamp = laterTimestamp(timestamp, legacy.record.updatedAt)
    push('session.closed', { reason: 'migrated_from_v2' })
  } else if (legacy.record.state === 'running' && mappedRunIndexes.length === 0) {
    warnings.push(`${legacy.record.sessionId}: V2 running state has no stable request mapping.`)
  }
  if (legacy.record.lastTerminalState !== undefined && mappedRunIndexes.length === 0) {
    warnings.push(
      `${legacy.record.sessionId}: V2 lastTerminalState retained only in the source backup because no stable runId exists.`,
    )
  }
  const commit = createSessionCommitV3({
    sessionId: legacy.record.sessionId,
    commitId: 'v2-migration-commit',
    expectedRevision: 0,
    idempotencyKey: `v2-migration-${shortDigest(digest(legacy.record))}`,
    entries,
  })
  return { commit, artifactCount }
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'wx')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function migrationReportRecord(report: JsonlV2MigrationReport) {
  return { ...report, checksum: digest(report) }
}

function validateMigrationReport(input: unknown): JsonlV2MigrationReport {
  if (
    !isRecord(input) ||
    !onlyKeys(input, [
      'formatVersion',
      'sourceVersion',
      'sourceCatalogDigest',
      'backupDirectory',
      'sessionCount',
      'messageCount',
      'artifactCount',
      'warnings',
      'checksum',
    ]) ||
    input.formatVersion !== FORMAT_VERSION ||
    input.sourceVersion !== 2 ||
    typeof input.sourceCatalogDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(input.sourceCatalogDigest) ||
    typeof input.backupDirectory !== 'string' ||
    !nonNegativeInteger(input.sessionCount) ||
    !nonNegativeInteger(input.messageCount) ||
    !nonNegativeInteger(input.artifactCount) ||
    !Array.isArray(input.warnings) ||
    !input.warnings.every((warning) => typeof warning === 'string') ||
    typeof input.checksum !== 'string'
  ) {
    throw new SyntaxError('Invalid V2 migration report.')
  }
  const { checksum, ...report } = input
  if (checksum !== digest(report)) throw new SyntaxError('Migration report checksum mismatch.')
  return structuredClone(report) as JsonlV2MigrationReport
}

function laterTimestamp(previous: string, candidate: string): string {
  if (!canonicalInstant(candidate)) throw new SyntaxError('Invalid V2 timestamp.')
  return candidate < previous ? previous : candidate
}

function canonicalInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

function stableLegacyId(prefix: string, value: string): string {
  if (safeId(value)) return value
  return `${prefix}-${shortDigest(digest(value))}`
}

function digestBytes(value: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function shortDigest(value: string): string {
  return value.slice('sha256:'.length, 'sha256:'.length + 16)
}
