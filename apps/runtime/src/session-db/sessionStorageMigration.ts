import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  exportSessionJournalV3,
  importSessionJournalV3,
  runtimeError,
  type SessionJournalArchiveStoreV3,
} from '@praxis/core-sdk'
import { JsonlSessionJournalV3 } from './jsonlSessionJournalV3.js'
import {
  createSessionJournalCompositionV3,
  inspectSessionStorageAuthorityV3,
  replaceSessionStorageAuthorityV3,
  type SessionStoreKindV3,
} from './sessionJournalComposition.js'
import { SqliteSessionJournalV3, sqliteSessionJournalFactoryV3 } from './sqliteSessionJournalV3.js'

export type SessionStorageMigrationReportV3 = Readonly<{
  formatVersion: 3
  source: SessionStoreKindV3
  target: SessionStoreKindV3
  changed: boolean
  sessionCount: number
  commitCount: number
  entryCount: number
  checksum: `sha256:${string}`
  backupDirectory?: string
}>

/** Offline verified in-place migration. The old authority remains in migration-backups. */
export async function migrateSessionStorageV3(
  target: SessionStoreKindV3,
  options: Readonly<{ root?: string }> = {},
): Promise<SessionStorageMigrationReportV3> {
  const root = options.root ?? process.env.PRAXIS_HOME ?? join(homedir(), '.praxis')
  if (target !== 'jsonl' && target !== 'sqlite')
    throw migrationError('SESSION_STORE_CONFIG_INVALID')
  let source = await inspectSessionStorageAuthorityV3(root)
  if (source === undefined && (await exists(join(root, 'sessions.json')))) {
    const migrated = await createSessionJournalCompositionV3({
      root,
      configuration: { session: { store: 'jsonl' } },
      factories: [sqliteSessionJournalFactoryV3()],
    })
    await migrated.close()
    source = 'jsonl'
  }
  if (source === undefined) {
    const created = await createSessionJournalCompositionV3({
      root,
      configuration: { session: { store: target } },
      factories: [sqliteSessionJournalFactoryV3()],
    })
    const archive = requireArchive(created.archiveStore)
    const exported = await exportSessionJournalV3(archive)
    await created.close()
    return report(source ?? target, target, false, exported)
  }

  return withMigrationLock(root, async () => {
    await assertNoActiveRuntimeLeases(root)
    const sourceStore = store(source, root)
    await sourceStore.initialize()
    try {
      const exported = await exportSessionJournalV3(sourceStore)
      if (source === target) return report(source, target, false, exported)

      const stagingRoot = join(root, 'storage-migrations', `stage-${randomUUID()}`)
      await mkdir(stagingRoot, { recursive: true })
      const targetStore = store(target, stagingRoot)
      await targetStore.initialize()
      try {
        await importSessionJournalV3(targetStore, exported)
        const verified = await exportSessionJournalV3(targetStore, exported.exportedAt)
        if (verified.checksum !== exported.checksum) {
          throw migrationError('SESSION_STORE_MIGRATION_VERIFY_FAILED')
        }
      } finally {
        await closeStore(targetStore)
      }
      await closeStore(sourceStore)

      const backupDirectory = join(
        root,
        'migration-backups',
        `storage-${safeTimestamp()}-${source}-to-${target}`,
      )
      await mkdir(backupDirectory, { recursive: true })
      await moveIfPresent(
        join(root, 'session-authority.json'),
        join(backupDirectory, 'session-authority.json'),
      )
      await moveBackend(root, backupDirectory, source)
      try {
        await moveBackend(stagingRoot, root, target)
        await replaceSessionStorageAuthorityV3(root, target)
      } catch (error) {
        await moveBackend(root, stagingRoot, target).catch(() => undefined)
        await moveBackend(backupDirectory, root, source).catch(() => undefined)
        await moveIfPresent(
          join(backupDirectory, 'session-authority.json'),
          join(root, 'session-authority.json'),
        ).catch(() => undefined)
        throw error
      } finally {
        await rm(stagingRoot, { recursive: true, force: true })
      }
      return report(source, target, true, exported, backupDirectory)
    } finally {
      await closeStore(sourceStore)
    }
  })
}

function store(kind: SessionStoreKindV3, root: string) {
  return kind === 'jsonl' ? new JsonlSessionJournalV3(root) : new SqliteSessionJournalV3(root)
}

async function closeStore(value: JsonlSessionJournalV3 | SqliteSessionJournalV3): Promise<void> {
  const close = Reflect.get(value, 'close')
  if (typeof close === 'function') await close.call(value)
}

function report(
  source: SessionStoreKindV3,
  target: SessionStoreKindV3,
  changed: boolean,
  archive: Awaited<ReturnType<typeof exportSessionJournalV3>>,
  backupDirectory?: string,
): SessionStorageMigrationReportV3 {
  return Object.freeze({
    formatVersion: 3,
    source,
    target,
    changed,
    sessionCount: archive.sessions.length,
    commitCount: archive.sessions.reduce((total, session) => total + session.commits.length, 0),
    entryCount: archive.sessions.reduce(
      (total, session) =>
        total + session.commits.reduce((count, commit) => count + commit.entries.length, 0),
      0,
    ),
    checksum: archive.checksum,
    ...(backupDirectory === undefined ? {} : { backupDirectory }),
  })
}

async function moveBackend(
  sourceRoot: string,
  targetRoot: string,
  kind: SessionStoreKindV3,
): Promise<void> {
  await mkdir(targetRoot, { recursive: true })
  if (kind === 'jsonl') {
    await moveIfPresent(
      join(sourceRoot, 'session-journal-v3'),
      join(targetRoot, 'session-journal-v3'),
    )
    return
  }
  for (const suffix of ['', '-wal', '-shm']) {
    await moveIfPresent(
      join(sourceRoot, `session-journal-v3.sqlite${suffix}`),
      join(targetRoot, `session-journal-v3.sqlite${suffix}`),
    )
  }
}

async function moveIfPresent(source: string, target: string): Promise<void> {
  if (!(await exists(source))) return
  await mkdir(dirname(target), { recursive: true })
  await rename(source, target)
}

async function withMigrationLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const path = join(root, 'locks', 'session-storage-migration.lock')
  await mkdir(dirname(path), { recursive: true })
  let handle
  try {
    handle = await open(path, 'wx')
  } catch (error) {
    if (hasCode(error, 'EEXIST')) throw migrationError('SESSION_STORE_MIGRATION_BUSY')
    throw error
  }
  try {
    await handle.writeFile(
      JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date().toISOString() }),
    )
    await handle.sync()
    return await action()
  } finally {
    await handle.close()
    await unlink(path).catch(() => undefined)
  }
}

async function assertNoActiveRuntimeLeases(root: string): Promise<void> {
  const directory = join(root, 'locks')
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return
    throw error
  }
  for (const name of names) {
    const match = /^session-runtime-(\d+)-[a-f0-9-]+\.lock$/u.exec(name)
    if (match === null) continue
    const path = join(directory, name)
    const leasePid = await readLeasePid(path, Number(match[1]))
    if (processIsAlive(leasePid)) {
      throw migrationError('SESSION_STORE_MIGRATION_RUNTIME_ACTIVE')
    }
    await unlink(path).catch((error: unknown) => {
      if (!hasCode(error, 'ENOENT')) throw error
    })
  }
}

async function readLeasePid(path: string, fallback: number): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    const pid =
      typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'pid') : undefined
    return Number.isSafeInteger(pid) && pid > 0 ? pid : fallback
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return -1
    return fallback
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return hasCode(error, 'EPERM')
  }
}

function requireArchive(
  archive: SessionJournalArchiveStoreV3 | undefined,
): SessionJournalArchiveStoreV3 {
  if (archive === undefined) throw migrationError('SESSION_STORE_ARCHIVE_UNAVAILABLE')
  return archive
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  }
}

function safeTimestamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/gu, '-')
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}

function migrationError(code: string) {
  return runtimeError(code, 'persistence', 'Offline Session storage migration failed.')
}
