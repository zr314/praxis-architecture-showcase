import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  canonicalJsonV1,
  runtimeError,
  type LongTermMemoryV1,
  type MemoryManageRequestV1,
  type MemoryProjectV1,
  type MemoryReceiptV1,
  type MemoryScopeV1,
  type MemoryWriteV1,
} from '@praxis/core-sdk'
import { loadNodeSqlite } from '../store/nodeSqlite.js'
import { pathWithinV1, projectLocationV1 } from './projectIdentity.js'

type Row = {
  id: string
  owner: string
  key: string
  revision: number
  document: string
  expires: string | null
}
type ProjectRow = { id: string; root: string; mode: MemoryProjectV1['mode']; user_access: number }
export type MemoryAccessV1 = Readonly<{
  projectId: string
  sessionId?: string
  runId?: string
  promptId?: string
  host?: boolean
}>

/** One local SQLite authority; indexes and exports never become a second writable authority. */
export class MemoryServiceV1 {
  private database?: DatabaseSync
  private opening?: Promise<void>
  constructor(private readonly home: string) {}

  async initialize(): Promise<void> {
    if (this.database) return
    this.opening ??= this.open()
    try {
      await this.opening
    } finally {
      this.opening = undefined
    }
  }

  private async open(): Promise<void> {
    await mkdir(join(this.home, 'memory'), { recursive: true, mode: 0o700 })
    const { DatabaseSync } = await loadNodeSqlite()
    const db = new DatabaseSync(join(this.home, 'memory', 'memory-v1.sqlite'))
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, root TEXT NOT NULL, mode TEXT NOT NULL, user_access INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS identities(identity TEXT PRIMARY KEY, project_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, owner TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL, expires TEXT, UNIQUE(owner,key));
        CREATE TABLE IF NOT EXISTS receipts(operation_id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS import_batches(operation_id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tombstones(owner TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(owner,key));
        CREATE TABLE IF NOT EXISTS exposures(session_id TEXT NOT NULL, project_id TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(session_id,project_id,memory_id));
        CREATE TABLE IF NOT EXISTS blocked_sessions(session_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS memory_meta(version INTEGER NOT NULL);
        INSERT INTO memory_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM memory_meta);`)
      const version = db.prepare('SELECT version FROM memory_meta').get() as { version: number }
      if (version.version !== 1) throw new Error('Unsupported memory schema.')
      this.database = db
    } catch (error) {
      db.close()
      throw error
    }
  }

  close(): void {
    this.database?.close()
    this.database = undefined
  }
  private db(): DatabaseSync {
    if (!this.database)
      fail('MEMORY_UNAVAILABLE', 'Local memory is unavailable; no change was saved.')
    return this.database
  }
  private transaction<T>(operation: () => T): T {
    const db = this.db()
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  async project(workspace: string): Promise<MemoryProjectV1> {
    await this.initialize()
    const location = await projectLocationV1(workspace)
    return this.transaction(() => {
      let found = this.db()
        .prepare('SELECT project_id FROM identities WHERE identity=?')
        .get(location.identity) as { project_id: string } | undefined
      if (!found && !location.git) {
        const parents = this.db()
          .prepare(
            "SELECT p.* FROM projects p JOIN identities i ON p.id=i.project_id WHERE i.identity LIKE 'directory:%'",
          )
          .all() as ProjectRow[]
        const parent = parents
          .filter((p) => pathWithinV1(p.root, location.root))
          .sort((a, b) => b.root.length - a.root.length)[0]
        if (parent) found = { project_id: parent.id }
      }
      if (!found) {
        found = { project_id: `project-${randomUUID()}` }
        this.db()
          .prepare("INSERT INTO projects(id,root,mode) VALUES(?,?,'off')")
          .run(found.project_id, location.root)
        this.db()
          .prepare('INSERT INTO identities VALUES(?,?)')
          .run(location.identity, found.project_id)
      }
      return this.status(found.project_id)
    })
  }

  status(projectId: string): MemoryProjectV1 {
    const p = this.db().prepare('SELECT * FROM projects WHERE id=?').get(projectId) as
      | ProjectRow
      | undefined
    if (!p) fail('MEMORY_SCOPE_DENIED', 'Unknown memory project.')
    return { projectId: p.id, root: p.root, mode: p.mode, userAccess: p.user_access === 1 }
  }

  configure(
    projectId: string,
    mode?: MemoryProjectV1['mode'],
    userAccess?: boolean,
  ): MemoryProjectV1 {
    if (mode !== undefined && !['off', 'read-only', 'explicit'].includes(mode))
      fail('MEMORY_INPUT_INVALID', 'Invalid memory mode.')
    return this.transaction(() => {
      const previous = this.status(projectId)
      if (
        (mode === 'off' && previous.mode !== 'off') ||
        (userAccess === false && previous.userAccess)
      ) {
        this.db()
          .prepare(
            'INSERT OR IGNORE INTO blocked_sessions SELECT DISTINCT session_id FROM exposures WHERE project_id=?',
          )
          .run(projectId)
      }
      this.db()
        .prepare('UPDATE projects SET mode=?,user_access=? WHERE id=?')
        .run(mode ?? previous.mode, Number(userAccess ?? previous.userAccess), projectId)
      return this.status(projectId)
    })
  }

  private owner(access: MemoryAccessV1, scope: MemoryScopeV1, write = false): string {
    const project = this.status(access.projectId)
    if (scope !== 'project' && scope !== 'user')
      fail('MEMORY_SCOPE_DENIED', 'Unknown memory scope.')
    if (!access.host && (project.mode === 'off' || (write && project.mode !== 'explicit')))
      fail('MEMORY_DISABLED', 'Memory access is disabled or read-only.')
    if (scope === 'user' && !access.host && (!project.userAccess || write))
      fail(
        'MEMORY_SCOPE_DENIED',
        'User memory requires a project read grant; use management commands to change it.',
      )
    return scope === 'user' ? 'user:local' : access.projectId
  }

  assertSession(sessionId: string): void {
    const expired = this.db()
      .prepare(
        'SELECT 1 FROM exposures e JOIN memories m ON e.memory_id=m.id WHERE e.session_id=? AND m.expires IS NOT NULL AND m.expires<=? LIMIT 1',
      )
      .get(sessionId, new Date().toISOString())
    if (
      expired ||
      this.db().prepare('SELECT 1 FROM blocked_sessions WHERE session_id=?').get(sessionId)
    ) {
      fail(
        'MEMORY_CONTEXT_REVOKED',
        'Memory used by this session was revoked. Start a new session; old transcripts and sent requests were not erased.',
      )
    }
  }

  inheritSession(parent: string, child: string): void {
    this.transaction(() => {
      this.db()
        .prepare(
          'INSERT OR IGNORE INTO exposures SELECT ?,project_id,memory_id,revision FROM exposures WHERE session_id=?',
        )
        .run(child, parent)
      this.db()
        .prepare(
          'INSERT OR IGNORE INTO blocked_sessions SELECT ? FROM blocked_sessions WHERE session_id=?',
        )
        .run(child, parent)
    })
  }

  private expose(access: MemoryAccessV1, record: LongTermMemoryV1): void {
    if (!access.sessionId) return
    this.assertSession(access.sessionId)
    this.db()
      .prepare('INSERT OR REPLACE INTO exposures VALUES(?,?,?,?)')
      .run(access.sessionId, access.projectId, record.id, record.revision)
  }

  get(access: MemoryAccessV1, scope: MemoryScopeV1, id: string): LongTermMemoryV1 {
    return this.transaction(() => {
      const owner = this.owner(access, scope)
      const row = this.db()
        .prepare('SELECT * FROM memories WHERE id=? AND owner=?')
        .get(id, owner) as Row | undefined
      if (!row || (row.expires !== null && Date.parse(row.expires) <= Date.now()))
        fail('MEMORY_NOT_FOUND', 'Memory is absent, expired or outside the permitted scope.')
      const record = JSON.parse(row.document) as LongTermMemoryV1
      this.expose(access, record)
      return record
    })
  }

  search(access: MemoryAccessV1, scope: MemoryScopeV1, query = '', limit = 8): LongTermMemoryV1[] {
    bounded(query, 2_048, true)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      fail('MEMORY_INPUT_INVALID', 'limit must be 1..50.')
    return this.transaction(() => {
      const owner = this.owner(access, scope)
      const rows = this.db()
        .prepare(
          'SELECT * FROM memories WHERE owner=? AND (expires IS NULL OR expires>?) ORDER BY id',
        )
        .all(owner, new Date().toISOString()) as Row[]
      const terms = [
        ...new Set(query.toLocaleLowerCase().match(/[a-z0-9_.:/-]+|[\p{Script=Han}]{1,2}/gu) ?? []),
      ]
      const ranked = rows
        .map((r) => {
          const record = JSON.parse(r.document) as LongTermMemoryV1
          const haystack =
            `${record.key} ${record.content} ${record.applicability}`.toLocaleLowerCase()
          const score = terms.reduce((sum, t) => sum + (haystack.includes(t) ? 1 : 0), 0)
          return { record, score }
        })
        .filter(
          ({ score, record }) =>
            terms.length === 0 ||
            score > 0 ||
            record.kind === 'preference' ||
            record.kind === 'feedback',
        )
        .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
        .slice(0, limit)
      for (const { record } of ranked) this.expose(access, record)
      return ranked.map(({ record }) => record)
    })
  }

  upsert(
    access: MemoryAccessV1,
    scope: MemoryScopeV1,
    input: MemoryWriteV1,
    operationId: string,
  ): MemoryReceiptV1 {
    validateWrite(input)
    return this.transaction(() => this.write(access, scope, input, operationId))
  }
  private write(
    access: MemoryAccessV1,
    scope: MemoryScopeV1,
    input: MemoryWriteV1,
    operationId: string,
  ): MemoryReceiptV1 {
    if (access.sessionId) this.assertSession(access.sessionId)
    const owner = this.owner(access, scope, true)
    const digest = hash({ owner, input, source: access, action: 'upsert' })
    const replay = this.receipt(operationId, digest)
    if (replay) return replay
    const old = this.db()
      .prepare('SELECT * FROM memories WHERE owner=? AND key=?')
      .get(owner, input.key) as Row | undefined
    if ((old?.revision ?? 0) !== input.expectedRevision)
      fail('MEMORY_CONFLICT', 'Memory changed. Read its current revision before editing.')
    if (!old) {
      const count = this.db()
        .prepare('SELECT COUNT(*) AS n FROM memories WHERE owner=?')
        .get(owner) as { n: number }
      if (count.n >= 2_000)
        fail(
          'MEMORY_CAPACITY',
          'Local scope limit is 2000 records; remove obsolete memories first.',
        )
    }
    const now = new Date().toISOString()
    const record: LongTermMemoryV1 = {
      schemaVersion: 1,
      id: old?.id ?? `memory-${randomUUID()}`,
      revision: (old?.revision ?? 0) + 1,
      scope,
      ...(scope === 'project' ? { projectId: access.projectId } : {}),
      key: input.key,
      kind: input.kind,
      content: input.content,
      applicability: input.applicability ?? '',
      source: {
        kind: 'user_explicit',
        ...(access.sessionId ? { sessionId: access.sessionId } : {}),
        ...(access.runId ? { runId: access.runId } : {}),
        ...(access.promptId ? { promptId: access.promptId } : {}),
      },
      createdAt: old ? (JSON.parse(old.document) as LongTermMemoryV1).createdAt : now,
      updatedAt: now,
      ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt).toISOString() } : {}),
    }
    this.db()
      .prepare('INSERT OR REPLACE INTO memories VALUES(?,?,?,?,?,?)')
      .run(
        record.id,
        owner,
        record.key,
        record.revision,
        JSON.stringify(record),
        record.expiresAt ?? null,
      )
    // Only explicit host/user-approved writes reach this method. No automatic relearning exists.
    this.db().prepare('DELETE FROM tombstones WHERE owner=? AND key=?').run(owner, record.key)
    const result: MemoryReceiptV1 = {
      operationId,
      id: record.id,
      revision: record.revision,
      action: 'upsert',
    }
    this.saveReceipt(result, digest)
    return result
  }

  forget(
    access: MemoryAccessV1,
    scope: MemoryScopeV1,
    id: string,
    expectedRevision: number,
    operationId: string,
  ): MemoryReceiptV1 {
    return this.transaction(() => {
      const owner = this.owner(access, scope, true)
      const digest = hash({ owner, id, expectedRevision, action: 'forget' })
      const replay = this.receipt(operationId, digest)
      if (replay) return replay
      if (access.sessionId) this.assertSession(access.sessionId)
      const old = this.db()
        .prepare('SELECT * FROM memories WHERE owner=? AND id=?')
        .get(owner, id) as Row | undefined
      if (!old) fail('MEMORY_NOT_FOUND', 'Memory is absent or outside the permitted scope.')
      if (old.revision !== expectedRevision)
        fail('MEMORY_CONFLICT', 'Memory changed. Read its current revision before deleting.')
      this.db()
        .prepare(
          'INSERT OR IGNORE INTO blocked_sessions SELECT session_id FROM exposures WHERE memory_id=?',
        )
        .run(id)
      this.db().prepare('INSERT OR IGNORE INTO tombstones VALUES(?,?)').run(owner, old.key)
      this.db().prepare('DELETE FROM memories WHERE id=?').run(id)
      const result: MemoryReceiptV1 = { operationId, id, revision: old.revision, action: 'forget' }
      this.saveReceipt(result, digest)
      return result
    })
  }

  private receipt(operationId: string, digest: string): MemoryReceiptV1 | undefined {
    bounded(operationId, 128)
    const prior = this.db()
      .prepare('SELECT digest,result FROM receipts WHERE operation_id=?')
      .get(operationId) as { digest: string; result: string } | undefined
    if (prior && prior.digest !== digest)
      fail('MEMORY_OPERATION_CONFLICT', 'Operation ID was already used for a different request.')
    return prior ? (JSON.parse(prior.result) as MemoryReceiptV1) : undefined
  }
  private saveReceipt(receipt: MemoryReceiptV1, digest: string): void {
    this.db()
      .prepare('INSERT INTO receipts VALUES(?,?,?)')
      .run(receipt.operationId, digest, JSON.stringify(receipt))
  }

  async manage(request: MemoryManageRequestV1): Promise<unknown> {
    const project = await this.project(request.workspace)
    const access = { projectId: project.projectId, host: true }
    const scope = request.scope ?? 'project'
    switch (request.action) {
      case 'status':
        return project
      case 'configure':
        return this.configure(project.projectId, request.mode, request.userAccess)
      case 'list':
        return this.search(access, scope, request.query, request.limit ?? 50)
      case 'export':
        return this.transaction(() => {
          const owner = this.owner(access, scope)
          bounded(request.afterId ?? '', 128, true)
          const rows = this.db()
            .prepare('SELECT * FROM memories WHERE owner=? AND id>? ORDER BY id LIMIT 51')
            .all(owner, request.afterId ?? '') as Row[]
          const page = rows.slice(0, 50)
          return {
            schemaVersion: 1,
            scope,
            memories: page.map((r) => JSON.parse(r.document) as LongTermMemoryV1),
            limit: 50,
            ...(rows.length > 50 ? { nextCursor: page.at(-1)!.id } : {}),
          }
        })
      case 'get':
        return this.get(access, scope, required(request.id))
      case 'upsert':
        if (!request.memory) fail('MEMORY_INPUT_INVALID', 'memory is required.')
        return this.upsert(access, scope, request.memory, required(request.operationId))
      case 'forget':
        return this.forget(
          access,
          scope,
          required(request.id),
          request.expectedRevision ?? -1,
          required(request.operationId),
        )
      case 'import': {
        if (!request.memories || request.memories.length > 50)
          fail('MEMORY_INPUT_INVALID', 'Import must contain at most 50 records.')
        for (const item of request.memories) {
          validateWrite(item)
          if (item.expectedRevision !== 0) fail('MEMORY_INPUT_INVALID', 'Import is create-only.')
        }
        const operation = required(request.operationId)
        bounded(operation, 120)
        return this.transaction(() => {
          const digest = hash({
            owner: this.owner(access, scope, true),
            memories: request.memories,
          })
          const prior = this.db()
            .prepare('SELECT digest,result FROM import_batches WHERE operation_id=?')
            .get(operation) as { digest: string; result: string } | undefined
          if (prior) {
            if (prior.digest !== digest)
              fail(
                'MEMORY_OPERATION_CONFLICT',
                'Import operation ID was used for a different batch.',
              )
            return JSON.parse(prior.result) as MemoryReceiptV1[]
          }
          const result = request.memories!.map((item, i) =>
            this.write(access, scope, item, `${operation}:${i}`),
          )
          this.db()
            .prepare('INSERT INTO import_batches VALUES(?,?,?)')
            .run(operation, digest, JSON.stringify(result))
          return result
        })
      }
      case 'rebind': {
        const target = this.status(required(request.id))
        const location = await projectLocationV1(request.workspace)
        return this.transaction(() => {
          // Never orphan records belonging to an already-used destination project.
          const used = this.db()
            .prepare('SELECT 1 FROM memories WHERE owner=? LIMIT 1')
            .get(project.projectId)
          if (target.projectId !== project.projectId && (used || project.mode !== 'off'))
            fail('MEMORY_CONFLICT', 'Destination project already has memory or is enabled.')
          // A moved project's old path must not grant its memories to a new
          // unrelated directory later created at that location.
          this.db().prepare('DELETE FROM identities WHERE project_id=?').run(target.projectId)
          this.db()
            .prepare('INSERT OR REPLACE INTO identities VALUES(?,?)')
            .run(location.identity, target.projectId)
          this.db()
            .prepare('UPDATE projects SET root=? WHERE id=?')
            .run(location.root, target.projectId)
          return this.status(target.projectId)
        })
      }
    }
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJsonV1(value)).digest('hex')
}
function required(value: string | undefined): string {
  if (!value) fail('MEMORY_INPUT_INVALID', 'Required field is missing.')
  return value
}
function bounded(value: unknown, maximum: number, empty = false): asserts value is string {
  if (
    typeof value !== 'string' ||
    (!empty && !value.trim()) ||
    Buffer.byteLength(value, 'utf8') > maximum ||
    value.includes('\0')
  )
    fail('MEMORY_INPUT_INVALID', 'Invalid or oversized memory field.')
}
function validateWrite(input: MemoryWriteV1): void {
  bounded(input.key, 128)
  bounded(input.content, 4096)
  bounded(input.applicability ?? '', 512, true)
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(input.key) ||
    !['preference', 'feedback', 'decision', 'reference', 'experience'].includes(input.kind) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  )
    fail('MEMORY_INPUT_INVALID', 'Invalid memory key, kind or revision.')
  if (
    input.expiresAt !== undefined &&
    (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now())
  )
    fail('MEMORY_INPUT_INVALID', 'expiresAt must be a future timestamp.')
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{20,})|\b(?:api[_-]?key|authorization|password|cookie|access[_-]?token)\s*[:=]\s*\S+/iu.test(
      `${input.content}\n${input.applicability ?? ''}`,
    )
  )
    fail('MEMORY_SECRET_REJECTED', 'Potential secret detected; use the credential store instead.')
}
function fail(code: string, message: string): never {
  throw runtimeError(code, code === 'MEMORY_SCOPE_DENIED' ? 'permission' : 'persistence', message)
}
