import { createHash } from 'node:crypto'
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PolicyAuditRecord, PolicyGrant, PolicyStore } from '../policy/policyEngine.js'
import {
  runtimeError,
  isProviderNativeContext,
  isSkillInvocationEntry,
  type ProviderMessage,
  type RuntimeError,
  type SessionMemory,
  type SessionRecord,
  type SessionRepository,
} from '@praxis/core-sdk'
import {
  SESSION_STORE_VERSION,
  toSessionIndex,
  type SessionExport,
  type SessionIndexEntry,
  type SessionManagementRepository,
  type SessionRetentionPolicy,
} from './sessionV2.js'

type SessionCatalogV1 = {
  version: 1
  sessions: SessionRecord[]
}

type SessionCatalogV2 = {
  version: 2
  updatedAt: string
  sessions: SessionRecord[]
  checksum: string
}

type HistoryEntryV1 = {
  version: 1
  committedAt: string
  message: ProviderMessage
}

type HistoryEntryV2 = {
  version: 2
  sequence: number
  committedAt: string
  message: ProviderMessage
  clientRequestId?: string
  runId?: string
  checksum: string
}

type SessionMetadataV2 = {
  version: 2
  session: SessionRecord
  checksum: string
}

type HistoryState = {
  validBytes: number
  physicalBytes: number
  modifiedAtMs: number
  messageCount: number
  clientRequests: Map<string, string>
}

type ParsedHistory = {
  entries: Array<HistoryEntryV1 | HistoryEntryV2>
  validBytes: number
}

const LOCK_TIMEOUT_MS = 5_000
const STALE_LOCK_MS = 30_000

/** Versioned, checksummed, recoverable JSONL session repository. */
export class JsonlRepository
  implements SessionRepository, SessionManagementRepository, PolicyStore
{
  private readonly catalogPath: string
  private readonly sessionDirectory: string
  private readonly historyDirectory: string
  private readonly memoryDirectory: string
  private readonly trashDirectory: string
  private readonly lockDirectory: string
  private readonly policyPath: string
  private readonly policyAuditPath: string
  private readonly sessionAuthorityPath: string
  private readonly historyStates = new Map<string, HistoryState>()

  constructor(root = process.env.PRAXIS_HOME ?? join(homedir(), '.praxis')) {
    this.catalogPath = join(root, 'sessions.json')
    this.sessionDirectory = join(root, 'sessions')
    this.historyDirectory = join(root, 'history')
    this.memoryDirectory = join(root, 'memory')
    this.trashDirectory = join(root, 'trash', 'sessions')
    this.lockDirectory = join(root, 'locks')
    this.policyPath = join(root, 'policy-grants.json')
    this.policyAuditPath = join(root, 'policy-audit.jsonl')
    this.sessionAuthorityPath = join(root, 'session-authority.json')
  }

  async initialize(): Promise<void> {
    await this.run('initialize', async () => {
      try {
        await stat(this.sessionAuthorityPath)
        throw runtimeError(
          'SESSION_STORE_LEGACY_AUTHORITY_DISABLED',
          'persistence',
          'Legacy SessionRepository cannot open a V3 SessionJournal authority.',
        )
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
      await Promise.all([
        mkdir(this.sessionDirectory, { recursive: true }),
        mkdir(this.historyDirectory, { recursive: true }),
        mkdir(this.memoryDirectory, { recursive: true }),
        mkdir(this.trashDirectory, { recursive: true }),
        mkdir(this.lockDirectory, { recursive: true }),
      ])
      if (await this.hasCurrentCatalog()) return
      await this.withLock('catalog', async () => {
        let catalog: SessionCatalogV2 | undefined
        try {
          const source = await readFile(this.catalogPath, 'utf8')
          const parsed = JSON.parse(source) as SessionCatalogV1 | SessionCatalogV2
          if (parsed.version === SESSION_STORE_VERSION) {
            validateCatalog(parsed)
            if (await this.catalogIsCurrent(parsed)) return
            catalog = parsed
          } else if (parsed.version === 1 && Array.isArray(parsed.sessions)) {
            const backup = `${this.catalogPath}.v1.${safeTimestamp()}.bak`
            await copyFile(this.catalogPath, backup)
            catalog = createCatalog(parsed.sessions.map((record) => normalizeRecord(record)))
          } else {
            throw new SyntaxError('Unsupported session catalog format.')
          }
        } catch (error) {
          if (!isNotFound(error) && !(error instanceof SyntaxError)) throw error
        }
        await this.rebuildCatalogUnlocked(catalog)
      })
    })
  }

  async list(): Promise<SessionRecord[]> {
    return this.run('list', async () =>
      (await this.readCatalog()).sessions.map((session) => cloneRecord(session)),
    )
  }

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    return this.run('get', async () => {
      const found = (await this.readCatalog()).sessions.find(
        (session) => session.sessionId === sessionId,
      )
      return found ? cloneRecord(found) : undefined
    })
  }

  async create(session: SessionRecord): Promise<void> {
    await this.run('create', async () =>
      this.mutateCatalog((catalog) => {
        if (catalog.sessions.some((record) => record.sessionId === session.sessionId)) {
          throw runtimeError('SESSION_ALREADY_EXISTS', 'protocol', 'Session already exists.')
        }
        catalog.sessions.push(normalizeRecord(session))
      }),
    )
  }

  async update(session: SessionRecord): Promise<void> {
    await this.run('update', async () =>
      this.mutateCatalog((catalog) => {
        const index = catalog.sessions.findIndex((item) => item.sessionId === session.sessionId)
        if (index < 0) throw sessionNotFound()
        catalog.sessions[index] = normalizeRecord(session)
      }),
    )
  }

  async appendMessage(sessionId: string, message: ProviderMessage): Promise<void> {
    await this.run('append_message', async () => {
      await this.withLock(`history-${sessionId}`, async () => {
        const state = await this.syncHistoryState(sessionId)
        await this.repairTruncatedHistory(sessionId, state)
        await this.appendHistoryEntry(
          sessionId,
          state,
          createHistoryEntry(state.messageCount + 1, message),
        )
        await this.setMessageCount(sessionId, state.messageCount)
      })
    })
  }

  async appendRequestMessage(
    sessionId: string,
    clientRequestId: string,
    runId: string,
    message: ProviderMessage,
  ): Promise<{ duplicateRunId?: string }> {
    return this.run('append_request_message', async () => {
      return this.withLock(`history-${sessionId}`, async () => {
        const state = await this.syncHistoryState(sessionId)
        await this.repairTruncatedHistory(sessionId, state)
        const duplicateRunId = state.clientRequests.get(clientRequestId)
        if (duplicateRunId !== undefined) {
          await this.setMessageCount(sessionId, state.messageCount)
          return { duplicateRunId }
        }
        await this.appendHistoryEntry(
          sessionId,
          state,
          createHistoryEntry(state.messageCount + 1, message, {
            clientRequestId,
            runId,
          }),
        )
        await this.setMessageCount(sessionId, state.messageCount)
        return {}
      })
    })
  }

  async loadClientRequests(sessionId: string): Promise<Record<string, string>> {
    return this.run('load_client_requests', async () => {
      const requests: Record<string, string> = {}
      for (const entry of await this.loadHistoryEntries(sessionId)) {
        if (entry.version === 2 && entry.clientRequestId && entry.runId) {
          requests[entry.clientRequestId] = entry.runId
        }
      }
      return requests
    })
  }

  async updateTerminal(
    sessionId: string,
    terminal: NonNullable<SessionRecord['lastTerminalState']>,
    usage: NonNullable<SessionRecord['usage']>,
    messageCount: number,
  ): Promise<SessionRecord> {
    let updated!: SessionRecord
    await this.run('update_terminal', async () =>
      this.mutateCatalog((catalog) => {
        const record = requireCatalogSession(catalog, sessionId)
        if (record.state !== 'closed') record.state = 'idle'
        record.lastTerminalState = terminal
        record.usage = { ...usage }
        record.messageCount = messageCount
        record.updatedAt = new Date().toISOString()
        updated = cloneRecord(record)
      }),
    )
    return updated
  }

  async loadMessages(sessionId: string): Promise<ProviderMessage[]> {
    return this.run('load_messages', async () =>
      (await this.loadHistoryEntries(sessionId)).map((entry) => cloneMessage(entry.message)),
    )
  }

  async loadMemory(sessionId: string): Promise<SessionMemory> {
    return this.run('load_memory', async () => {
      try {
        const parsed = JSON.parse(await readFile(this.memoryPath(sessionId), 'utf8')) as unknown
        const memory = unwrapMemory(parsed, sessionId)
        if (!isSessionMemory(memory, sessionId)) throw new SyntaxError('Invalid session memory.')
        return cloneMemory(memory)
      } catch (error) {
        if (isNotFound(error)) return { sessionId }
        throw error
      }
    })
  }

  async saveMemory(memory: SessionMemory): Promise<void> {
    await this.run('save_memory', async () => {
      if (!isSessionMemory(memory, memory.sessionId))
        throw new SyntaxError('Invalid session memory.')
      const payload = { version: 2 as const, memory: cloneMemory(memory) }
      await this.atomicWrite(
        this.memoryPath(memory.sessionId),
        `${JSON.stringify({ ...payload, checksum: digest(payload) }, undefined, 2)}\n`,
      )
    })
  }

  async rename(sessionId: string, name: string): Promise<SessionRecord> {
    const normalized = name.trim()
    if (!normalized || normalized.length > 128) {
      throw runtimeError('SESSION_NAME_INVALID', 'protocol', 'Session name is invalid.')
    }
    let updated!: SessionRecord
    await this.run('rename', async () =>
      this.mutateCatalog((catalog) => {
        const record = requireCatalogSession(catalog, sessionId)
        record.name = normalized
        record.updatedAt = new Date().toISOString()
        updated = cloneRecord(record)
      }),
    )
    return updated
  }

  async search(query: string): Promise<SessionIndexEntry[]> {
    return this.run('search', async () => {
      const needle = query.trim().toLowerCase()
      return (await this.readCatalog()).sessions
        .filter((record) => {
          if (!needle) return true
          return [
            record.sessionId,
            record.name ?? '',
            record.cwd,
            record.provider,
            record.model,
            ...(record.labels ?? []),
          ].some((value) => value.toLowerCase().includes(needle))
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(toSessionIndex)
    })
  }

  async exportSession(sessionId: string): Promise<SessionExport> {
    const session = await this.get(sessionId)
    if (!session) throw sessionNotFound()
    return {
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      session,
      messages: await this.loadMessages(sessionId),
      memory: await this.loadMemory(sessionId),
    }
  }

  async deleteToTrash(sessionId: string): Promise<{ trashPath: string }> {
    return this.run('delete_to_trash', async () => {
      const record = await this.get(sessionId)
      if (!record) throw sessionNotFound()
      const target = join(this.trashDirectory, `${safeTimestamp()}-${sessionId}`)
      await mkdir(target, { recursive: false })
      await this.moveIfPresent(this.historyPath(sessionId), join(target, 'history.jsonl'))
      await this.moveIfPresent(this.memoryPath(sessionId), join(target, 'memory.json'))
      await this.moveIfPresent(this.sessionPath(sessionId), join(target, 'metadata.json'))
      await writeFile(join(target, 'session.json'), `${JSON.stringify(record, undefined, 2)}\n`)
      this.historyStates.delete(sessionId)
      await this.mutateCatalog((catalog) => {
        catalog.sessions = catalog.sessions.filter((session) => session.sessionId !== sessionId)
        for (const session of catalog.sessions) {
          if (session.activeLeafId === sessionId) session.activeLeafId = session.sessionId
        }
      })
      return { trashPath: target }
    })
  }

  async applyRetention(policy: SessionRetentionPolicy): Promise<string[]> {
    const maxSessions =
      policy.maxSessions === undefined ? undefined : Math.max(0, Math.floor(policy.maxSessions))
    const cutoff =
      policy.maxAgeDays === undefined
        ? undefined
        : Date.now() - Math.max(0, policy.maxAgeDays) * 86_400_000
    const records = (await this.list()).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )
    const expired = records.filter(
      (record, index) =>
        (maxSessions !== undefined && index >= maxSessions) ||
        (cutoff !== undefined && Date.parse(record.updatedAt) < cutoff),
    )
    for (const record of expired) await this.deleteToTrash(record.sessionId)
    return expired.map((record) => record.sessionId)
  }

  async forkSession(
    sourceSessionId: string,
    target: SessionRecord,
    throughMessage?: number,
  ): Promise<void> {
    await this.run('fork', async () => {
      const source = await this.get(sourceSessionId)
      if (!source) throw sessionNotFound()
      const messages = await this.loadMessages(sourceSessionId)
      const selected = messages.slice(0, throughMessage ?? messages.length)
      const record = normalizeRecord({
        ...target,
        parentSessionId: sourceSessionId,
        activeLeafId: target.sessionId,
        messageCount: selected.length,
      })
      await this.create(record)
      if (selected.length > 0) {
        await this.withLock(`history-${target.sessionId}`, async () =>
          this.writeHistory(
            target.sessionId,
            selected.map((message, index) => createHistoryEntry(index + 1, message)),
          ),
        )
      }
      const sourceMemory = await this.loadMemory(sourceSessionId)
      await this.saveMemory({
        sessionId: target.sessionId,
        ...(sourceMemory.plan === undefined ? {} : { plan: sourceMemory.plan }),
      })
      await this.setActiveLeaf(sourceSessionId, target.sessionId)
    })
  }

  async setActiveLeaf(sessionId: string, activeLeafId: string): Promise<void> {
    await this.run('set_active_leaf', async () =>
      this.mutateCatalog((catalog) => {
        requireCatalogSession(catalog, activeLeafId)
        const session = requireCatalogSession(catalog, sessionId)
        session.activeLeafId = activeLeafId
        session.updatedAt = new Date().toISOString()
      }),
    )
  }

  async loadGrants(): Promise<PolicyGrant[]> {
    return this.run('load_policy_grants', async () => {
      try {
        const grants = JSON.parse(await readFile(this.policyPath, 'utf8')) as unknown
        if (!Array.isArray(grants) || !grants.every(isPolicyGrant)) {
          throw new SyntaxError('Invalid policy grants.')
        }
        return grants.map((grant) => ({ ...grant }))
      } catch (error) {
        if (isNotFound(error)) return []
        throw error
      }
    })
  }

  async saveGrants(grants: PolicyGrant[]): Promise<void> {
    await this.run('save_policy_grants', async () => {
      if (!grants.every(isPolicyGrant)) throw new SyntaxError('Invalid policy grants.')
      await this.atomicWrite(this.policyPath, `${JSON.stringify(grants, undefined, 2)}\n`)
    })
  }

  async appendAudit(record: PolicyAuditRecord): Promise<void> {
    await this.run('append_policy_audit', async () => {
      await writeFile(this.policyAuditPath, `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
        flag: 'a',
      })
    })
  }

  private async setMessageCount(sessionId: string, messageCount: number): Promise<void> {
    await this.mutateCatalog((catalog) => {
      const session = requireCatalogSession(catalog, sessionId)
      session.messageCount = Math.max(session.messageCount ?? 0, messageCount)
      session.updatedAt = new Date().toISOString()
    })
  }

  private async readCatalog(): Promise<SessionCatalogV2> {
    try {
      return await this.readCatalogUnlocked()
    } catch (error) {
      if (!isNotFound(error) && !(error instanceof SyntaxError)) throw error
      return this.withLock('catalog', () => this.rebuildCatalogUnlocked())
    }
  }

  private async readCatalogUnlocked(): Promise<SessionCatalogV2> {
    const parsed = JSON.parse(await readFile(this.catalogPath, 'utf8')) as
      | SessionCatalogV1
      | SessionCatalogV2
    if (parsed.version === 1 && Array.isArray(parsed.sessions)) {
      return createCatalog(parsed.sessions.map(normalizeRecord))
    }
    validateCatalog(parsed)
    return {
      ...parsed,
      sessions: parsed.sessions.map(cloneRecord),
    }
  }

  private async mutateCatalog(change: (catalog: SessionCatalogV2) => void): Promise<void> {
    await this.withLock('catalog', async () => {
      let catalog: SessionCatalogV2
      try {
        catalog = await this.readCatalogUnlocked()
      } catch (error) {
        if (!isNotFound(error) && !(error instanceof SyntaxError)) throw error
        catalog = await this.rebuildCatalogUnlocked()
      }
      const before = new Map(
        catalog.sessions.map((session) => [session.sessionId, JSON.stringify(session)]),
      )
      change(catalog)
      catalog.updatedAt = new Date().toISOString()
      for (const session of catalog.sessions) {
        if (before.get(session.sessionId) !== JSON.stringify(session)) {
          await this.writeSessionMetadata(session)
        }
      }
      await this.writeCatalogUnlocked(createCatalog(catalog.sessions, catalog.updatedAt))
    })
  }

  private async writeCatalogUnlocked(catalog: SessionCatalogV2): Promise<void> {
    await this.atomicWrite(this.catalogPath, `${JSON.stringify(catalog, undefined, 2)}\n`)
  }

  private async hasCurrentCatalog(): Promise<boolean> {
    try {
      const parsed = JSON.parse(await readFile(this.catalogPath, 'utf8')) as unknown
      validateCatalog(parsed)
      return this.catalogIsCurrent(parsed)
    } catch (error) {
      if (isNotFound(error) || error instanceof SyntaxError) return false
      throw error
    }
  }

  private async catalogIsCurrent(catalog: SessionCatalogV2): Promise<boolean> {
    const { records, invalidSessionIds } = await this.readSessionMetadataRecords()
    if (records.size !== catalog.sessions.length) return false
    for (const catalogRecord of catalog.sessions) {
      if (invalidSessionIds.has(catalogRecord.sessionId)) return false
      const metadataRecord = records.get(catalogRecord.sessionId)
      if (
        !metadataRecord ||
        JSON.stringify(normalizeRecord(metadataRecord)) !==
          JSON.stringify(normalizeRecord(catalogRecord))
      ) {
        return false
      }
      try {
        if (
          (await this.syncHistoryState(catalogRecord.sessionId)).messageCount !==
          (catalogRecord.messageCount ?? 0)
        ) {
          return false
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
    }
    return true
  }

  private async rebuildCatalogUnlocked(seed?: SessionCatalogV2): Promise<SessionCatalogV2> {
    const { records, invalidSessionIds } = await this.readSessionMetadataRecords()
    for (const record of seed?.sessions ?? []) {
      if (records.has(record.sessionId) || invalidSessionIds.has(record.sessionId)) continue
      const normalized = normalizeRecord(record)
      await this.writeSessionMetadata(normalized)
      records.set(normalized.sessionId, normalized)
    }

    const recovered: SessionRecord[] = []
    for (const record of records.values()) {
      const normalized = normalizeRecord(record)
      try {
        normalized.messageCount = (await this.syncHistoryState(normalized.sessionId)).messageCount
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
      await this.writeSessionMetadata(normalized)
      recovered.push(normalized)
    }
    recovered.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    const catalog = createCatalog(recovered)
    await this.writeCatalogUnlocked(catalog)
    return catalog
  }

  private async readSessionMetadataRecords(): Promise<{
    records: Map<string, SessionRecord>
    invalidSessionIds: Set<string>
  }> {
    const records = new Map<string, SessionRecord>()
    const invalidSessionIds = new Set<string>()
    let names: string[]
    try {
      names = (await readdir(this.sessionDirectory)).filter((name) => name.endsWith('.json'))
    } catch (error) {
      if (isNotFound(error)) return { records, invalidSessionIds }
      throw error
    }
    for (const name of names) {
      const sessionId = name.slice(0, -'.json'.length)
      if (!isSafeSessionId(sessionId)) {
        invalidSessionIds.add(sessionId)
        continue
      }
      try {
        const parsed = JSON.parse(
          await readFile(join(this.sessionDirectory, name), 'utf8'),
        ) as unknown
        validateSessionMetadata(parsed, sessionId)
        records.set(sessionId, normalizeRecord(parsed.session))
      } catch (error) {
        if (isNotFound(error)) continue
        if (!(error instanceof SyntaxError)) throw error
        invalidSessionIds.add(sessionId)
      }
    }
    return { records, invalidSessionIds }
  }

  private async writeSessionMetadata(session: SessionRecord): Promise<void> {
    const payload = {
      version: SESSION_STORE_VERSION,
      session: normalizeRecord(session),
    } as const
    await this.atomicWrite(
      this.sessionPath(session.sessionId),
      `${JSON.stringify({ ...payload, checksum: digest(payload) }, undefined, 2)}\n`,
    )
  }

  private async loadHistoryEntries(
    sessionId: string,
  ): Promise<Array<HistoryEntryV1 | HistoryEntryV2>> {
    try {
      return parseHistoryBuffer(await readFile(this.historyPath(sessionId))).entries
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
  }

  private async syncHistoryState(sessionId: string): Promise<HistoryState> {
    const path = this.historyPath(sessionId)
    let fileStat: Awaited<ReturnType<typeof stat>>
    try {
      fileStat = await stat(path)
    } catch (error) {
      if (!isNotFound(error)) throw error
      const empty = emptyHistoryState()
      this.historyStates.set(sessionId, empty)
      return empty
    }

    const cached = this.historyStates.get(sessionId)
    if (
      cached &&
      cached.validBytes === fileStat.size &&
      cached.physicalBytes === fileStat.size &&
      cached.modifiedAtMs === fileStat.mtimeMs
    ) {
      return cached
    }

    const canContinue = cached !== undefined && fileStat.size > cached.validBytes
    const offset = canContinue ? cached.validBytes : 0
    const state = canContinue ? cloneHistoryState(cached) : emptyHistoryState()
    const length = fileStat.size - offset
    const source = Buffer.alloc(length)
    if (length > 0) {
      const handle = await open(path, 'r')
      try {
        await handle.read(source, 0, length, offset)
      } finally {
        await handle.close()
      }
    }
    const parsed = parseHistoryBuffer(source, state.messageCount)
    for (const entry of parsed.entries) {
      state.messageCount += 1
      if (entry.version === 2 && entry.clientRequestId && entry.runId) {
        state.clientRequests.set(entry.clientRequestId, entry.runId)
      }
    }
    state.validBytes = offset + parsed.validBytes
    state.physicalBytes = fileStat.size
    state.modifiedAtMs = fileStat.mtimeMs
    this.historyStates.set(sessionId, state)
    return state
  }

  private async repairTruncatedHistory(sessionId: string, state: HistoryState): Promise<void> {
    if (state.physicalBytes <= state.validBytes) return
    await truncate(this.historyPath(sessionId), state.validBytes)
    const repaired = await stat(this.historyPath(sessionId))
    state.physicalBytes = state.validBytes
    state.modifiedAtMs = repaired.mtimeMs
  }

  private async appendHistoryEntry(
    sessionId: string,
    state: HistoryState,
    entry: HistoryEntryV2,
  ): Promise<void> {
    const path = this.historyPath(sessionId)
    const line = `${JSON.stringify(entry)}\n`
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(path, 'a')
    try {
      await handle.writeFile(line, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    state.validBytes += Buffer.byteLength(line)
    state.physicalBytes = state.validBytes
    state.messageCount += 1
    if (entry.clientRequestId && entry.runId) {
      state.clientRequests.set(entry.clientRequestId, entry.runId)
    }
    state.modifiedAtMs = (await stat(path)).mtimeMs
    this.historyStates.set(sessionId, state)
  }

  private async writeHistory(
    sessionId: string,
    entries: Array<HistoryEntryV1 | HistoryEntryV2>,
  ): Promise<void> {
    const source = entries.map((entry) => JSON.stringify(entry)).join('\n')
    await this.atomicWrite(this.historyPath(sessionId), source ? `${source}\n` : '')
    this.historyStates.delete(sessionId)
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, path)
  }

  private async withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    await mkdir(this.lockDirectory, { recursive: true })
    const path = join(this.lockDirectory, `${safeFileName(name)}.lock`)
    const startedAt = Date.now()
    while (true) {
      try {
        const handle = await open(path, 'wx')
        try {
          await handle.writeFile(
            JSON.stringify({ version: 1, pid: process.pid, acquiredAt: new Date().toISOString() }),
          )
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
            'Another process owns the session writer lock.',
            { lock: safeFileName(name) },
            true,
          )
        }
        await delay(25)
      }
    }
  }

  private historyPath(sessionId: string): string {
    return join(this.historyDirectory, `${safeSessionId(sessionId)}.jsonl`)
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionDirectory, `${safeSessionId(sessionId)}.json`)
  }

  private memoryPath(sessionId: string): string {
    return join(this.memoryDirectory, `${safeSessionId(sessionId)}.json`)
  }

  private async moveIfPresent(source: string, target: string): Promise<void> {
    try {
      await rename(source, target)
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }

  private async run<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      if (isRuntimeError(error)) throw error
      const invalidData = error instanceof SyntaxError
      throw runtimeError(
        invalidData ? 'PERSISTENCE_INVALID_DATA' : 'PERSISTENCE_IO_ERROR',
        'persistence',
        invalidData ? 'Session storage data is invalid.' : 'Session storage operation failed.',
        { operation },
        !invalidData,
      )
    }
  }
}

function createCatalog(
  sessions: SessionRecord[],
  updatedAt = new Date().toISOString(),
): SessionCatalogV2 {
  const payload = {
    version: SESSION_STORE_VERSION,
    updatedAt,
    sessions: sessions.map(normalizeRecord),
  } as const
  return { ...payload, checksum: digest(payload) }
}

function validateCatalog(value: unknown): asserts value is SessionCatalogV2 {
  if (!value || typeof value !== 'object') throw new SyntaxError('Invalid session catalog.')
  const catalog = value as SessionCatalogV2
  if (
    catalog.version !== SESSION_STORE_VERSION ||
    !Array.isArray(catalog.sessions) ||
    !catalog.sessions.every(isSessionRecord) ||
    typeof catalog.updatedAt !== 'string' ||
    typeof catalog.checksum !== 'string'
  ) {
    throw new SyntaxError('Unsupported session catalog format.')
  }
  const { checksum, ...payload } = catalog
  if (checksum !== digest(payload)) throw new SyntaxError('Session catalog checksum mismatch.')
}

function validateSessionMetadata(
  value: unknown,
  expectedSessionId: string,
): asserts value is SessionMetadataV2 {
  if (!value || typeof value !== 'object') throw new SyntaxError('Invalid session metadata.')
  const metadata = value as SessionMetadataV2
  if (
    metadata.version !== SESSION_STORE_VERSION ||
    !isSessionRecord(metadata.session) ||
    metadata.session.sessionId !== expectedSessionId ||
    typeof metadata.checksum !== 'string'
  ) {
    throw new SyntaxError('Invalid session metadata.')
  }
  const { checksum, ...payload } = metadata
  if (checksum !== digest(payload)) throw new SyntaxError('Session metadata checksum mismatch.')
}

function parseHistoryBuffer(source: Buffer, sequenceOffset = 0): ParsedHistory {
  const entries: Array<HistoryEntryV1 | HistoryEntryV2> = []
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
    const parsed = JSON.parse(line) as unknown
    if (!isHistoryEntry(parsed)) throw new SyntaxError('Invalid session history entry.')
    if (parsed.version === 2) {
      const { checksum, ...payload } = parsed
      if (checksum !== digest(payload)) throw new SyntaxError('Session history checksum mismatch.')
      if (parsed.sequence !== sequenceOffset + entries.length + 1) {
        throw new SyntaxError('Session history sequence mismatch.')
      }
    }
    entries.push(parsed)
  }
  return { entries, validBytes }
}

function emptyHistoryState(): HistoryState {
  return {
    validBytes: 0,
    physicalBytes: 0,
    modifiedAtMs: 0,
    messageCount: 0,
    clientRequests: new Map(),
  }
}

function cloneHistoryState(state: HistoryState): HistoryState {
  return {
    ...state,
    clientRequests: new Map(state.clientRequests),
  }
}

function normalizeRecord(record: SessionRecord): SessionRecord {
  return {
    ...record,
    recordVersion: 2,
    name: record.name ?? record.sessionId,
    activeLeafId: record.activeLeafId ?? record.sessionId,
    labels: [...(record.labels ?? [])],
    messageCount: record.messageCount ?? 0,
    usage: { ...(record.usage ?? {}) },
  }
}

function cloneRecord(record: SessionRecord): SessionRecord {
  return {
    ...record,
    labels: [...(record.labels ?? [])],
    usage: { ...(record.usage ?? {}) },
  }
}

function createHistoryEntry(
  sequence: number,
  message: ProviderMessage,
  request?: { clientRequestId: string; runId: string },
): HistoryEntryV2 {
  const payload = {
    version: 2 as const,
    sequence,
    committedAt: new Date().toISOString(),
    message: cloneMessage(message),
    ...(request ?? {}),
  }
  return { ...payload, checksum: digest(payload) }
}

function unwrapMemory(value: unknown, sessionId: string): SessionMemory {
  if (!value || typeof value !== 'object') throw new SyntaxError('Invalid session memory.')
  const wrapper = value as { version?: unknown; memory?: unknown; checksum?: unknown }
  if (wrapper.version !== 2) return value as SessionMemory
  const payload = { version: 2 as const, memory: wrapper.memory }
  if (wrapper.checksum !== digest(payload))
    throw new SyntaxError('Session memory checksum mismatch.')
  if (!wrapper.memory || typeof wrapper.memory !== 'object') {
    throw new SyntaxError('Invalid session memory.')
  }
  const memory = wrapper.memory as SessionMemory
  if (memory.sessionId !== sessionId) throw new SyntaxError('Session memory mismatch.')
  return memory
}

function isHistoryEntry(value: unknown): value is HistoryEntryV1 | HistoryEntryV2 {
  if (!value || typeof value !== 'object') return false
  const entry = value as HistoryEntryV1 | HistoryEntryV2
  if ((entry.version !== 1 && entry.version !== 2) || !isProviderMessage(entry.message))
    return false
  if (entry.version === 1) return typeof entry.committedAt === 'string'
  return (
    Number.isInteger(entry.sequence) &&
    typeof entry.committedAt === 'string' &&
    typeof entry.checksum === 'string' &&
    (entry.clientRequestId === undefined || typeof entry.clientRequestId === 'string') &&
    (entry.runId === undefined || typeof entry.runId === 'string')
  )
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as SessionRecord
  return (
    typeof record.sessionId === 'string' &&
    ['idle', 'running', 'closed'].includes(record.state) &&
    typeof record.cwd === 'string' &&
    typeof record.provider === 'string' &&
    typeof record.model === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
  )
}

function requireCatalogSession(catalog: SessionCatalogV2, sessionId: string): SessionRecord {
  const record = catalog.sessions.find((session) => session.sessionId === sessionId)
  if (!record) throw sessionNotFound()
  return record
}

function sessionNotFound() {
  return runtimeError('SESSION_NOT_FOUND', 'protocol', 'Session not found.')
}

function safeSessionId(sessionId: string): string {
  if (!isSafeSessionId(sessionId)) {
    throw runtimeError('SESSION_ID_INVALID', 'protocol', 'Session ID is invalid.')
  }
  return sessionId
}

function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160)
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > STALE_LOCK_MS
  } catch {
    return false
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isSessionMemory(value: unknown, sessionId: string): value is SessionMemory {
  if (!value || typeof value !== 'object') return false
  const memory = value as SessionMemory
  if (memory.sessionId !== sessionId) return false
  if (memory.checkpoint !== undefined) {
    const checkpoint = memory.checkpoint
    if (
      !checkpoint ||
      typeof checkpoint !== 'object' ||
      typeof checkpoint.id !== 'string' ||
      !Number.isInteger(checkpoint.messageStart) ||
      !Number.isInteger(checkpoint.messageEnd) ||
      typeof checkpoint.content !== 'string' ||
      typeof checkpoint.digest !== 'string' ||
      !Number.isFinite(checkpoint.estimatedTokens) ||
      typeof checkpoint.createdAt !== 'string' ||
      (checkpoint.reason !== undefined &&
        !['manual', 'threshold', 'overflow'].includes(checkpoint.reason)) ||
      (checkpoint.trust !== undefined && checkpoint.trust !== 'low') ||
      (checkpoint.scope !== undefined &&
        (!checkpoint.scope ||
          !['parent', 'child'].includes(checkpoint.scope.kind) ||
          typeof checkpoint.scope.sessionId !== 'string' ||
          checkpoint.scope.sessionId !== sessionId)) ||
      (checkpoint.estimatedGainTokens !== undefined &&
        (!Number.isSafeInteger(checkpoint.estimatedGainTokens) ||
          checkpoint.estimatedGainTokens < 0)) ||
      (checkpoint.summary !== undefined && !isCompactionSummary(checkpoint.summary)) ||
      (checkpoint.provenance !== undefined && !isCompactionProvenance(checkpoint.provenance)) ||
      (checkpoint.skillInvocations !== undefined &&
        (!Array.isArray(checkpoint.skillInvocations) ||
          checkpoint.skillInvocations.length > 8 ||
          !checkpoint.skillInvocations.every(isSkillInvocationEntry))) ||
      (checkpoint.nativeContext !== undefined && !isProviderNativeContext(checkpoint.nativeContext))
    ) {
      return false
    }
  }
  if (memory.plan !== undefined) {
    const plan = memory.plan
    if (
      !plan ||
      typeof plan !== 'object' ||
      typeof plan.objective !== 'string' ||
      !Number.isInteger(plan.revision) ||
      typeof plan.updatedAt !== 'string' ||
      !Array.isArray(plan.steps) ||
      !plan.steps.every(
        (step) =>
          step &&
          typeof step === 'object' &&
          typeof step.id === 'string' &&
          typeof step.title === 'string' &&
          ['pending', 'in_progress', 'completed', 'blocked'].includes(step.state),
      )
    ) {
      return false
    }
  }
  return true
}

function isCompactionProvenance(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const provenance = value as Record<string, unknown>
  return (
    Object.keys(provenance).every((key) =>
      ['schemaVersion', 'generator', 'fallbackFrom'].includes(key),
    ) &&
    provenance.schemaVersion === 1 &&
    isCompactionGeneratorIdentity(provenance.generator) &&
    (provenance.fallbackFrom === undefined ||
      isCompactionGeneratorIdentity(provenance.fallbackFrom))
  )
}

function isCompactionGeneratorIdentity(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const identity = value as Record<string, unknown>
  if (
    !['deterministic', 'model'].includes(String(identity.kind)) ||
    typeof identity.id !== 'string' ||
    !safeCompactionIdentityPart(identity.id)
  ) {
    return false
  }
  return identity.kind === 'deterministic'
    ? Object.keys(identity).every((key) => ['kind', 'id'].includes(key))
    : Object.keys(identity).every((key) => ['kind', 'id', 'provider', 'model'].includes(key)) &&
        typeof identity.provider === 'string' &&
        safeCompactionIdentityPart(identity.provider) &&
        typeof identity.model === 'string' &&
        safeCompactionIdentityPart(identity.model)
}

function safeCompactionIdentityPart(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value)
}

function isCompactionSummary(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const summary = value as Record<string, unknown>
  return (
    (summary.objective === undefined || typeof summary.objective === 'string') &&
    (summary.relevantRefs === undefined ||
      (Array.isArray(summary.relevantRefs) &&
        summary.relevantRefs.every((item) => typeof item === 'string'))) &&
    ['decisions', 'constraints', 'readFiles', 'modifiedFiles', 'unresolved', 'activePlan'].every(
      (key) =>
        Array.isArray(summary[key]) &&
        (summary[key] as unknown[]).every((item) => typeof item === 'string'),
    )
  )
}

function cloneMemory(memory: SessionMemory): SessionMemory {
  return JSON.parse(JSON.stringify(memory)) as SessionMemory
}

function cloneMessage(message: ProviderMessage): ProviderMessage {
  return JSON.parse(JSON.stringify(message)) as ProviderMessage
}

function isPolicyGrant(value: unknown): value is PolicyGrant {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as PolicyGrant).workspace === 'string' &&
    typeof (value as PolicyGrant).tool === 'string' &&
    typeof (value as PolicyGrant).rule === 'string' &&
    typeof (value as PolicyGrant).grantedAt === 'string' &&
    ((value as PolicyGrant).target === undefined ||
      typeof (value as PolicyGrant).target === 'string')
  )
}

function isProviderMessage(value: unknown): value is ProviderMessage {
  if (
    typeof value !== 'object' ||
    value === null ||
    !isProviderContent((value as ProviderMessage).content)
  ) {
    return false
  }
  const message = value as ProviderMessage
  if (
    'skillInvocation' in message &&
    message.skillInvocation !== undefined &&
    !isSkillInvocationEntry(message.skillInvocation)
  ) {
    return false
  }
  if (message.role === 'user') return true
  if (message.role === 'tool') {
    return typeof message.toolCallId === 'string' && typeof message.name === 'string'
  }
  return (
    message.role === 'assistant' &&
    (message.toolCalls === undefined ||
      (Array.isArray(message.toolCalls) &&
        message.toolCalls.every(
          (call) => typeof call.id === 'string' && typeof call.name === 'string',
        )))
  )
}

function isProviderContent(value: unknown): boolean {
  if (typeof value === 'string') return true
  if (!Array.isArray(value)) return false
  return value.every((block) => {
    if (typeof block !== 'object' || block === null || typeof block.type !== 'string') return false
    if (block.type === 'text' || block.type === 'reasoning') return typeof block.text === 'string'
    if (block.type === 'image_ref') return typeof block.artifactId === 'string'
    return (
      block.type === 'tool_call' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string' &&
      'input' in block
    )
  })
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function isRuntimeError(value: unknown): value is RuntimeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RuntimeError).code === 'string' &&
    typeof (value as RuntimeError).category === 'string' &&
    typeof (value as RuntimeError).message === 'string' &&
    typeof (value as RuntimeError).retryable === 'boolean'
  )
}
