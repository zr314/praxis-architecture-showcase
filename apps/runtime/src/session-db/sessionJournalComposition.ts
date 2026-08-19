import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ReducingSessionJournalV3,
  runtimeError,
  type SessionJournalArchiveStoreV3,
  type SessionJournalCommitStoreV3,
  type SessionJournalV3,
} from '@praxis/core-sdk'
import { JsonlSessionJournalV3 } from './jsonlSessionJournalV3.js'

export type SessionStoreKindV3 = 'jsonl' | 'sqlite'

export type SessionStorageConfigurationV3 = Readonly<{
  session?: Readonly<{ store?: SessionStoreKindV3 }>
}>

export interface InitializableSessionJournalStoreV3 extends SessionJournalCommitStoreV3 {
  initialize(): Promise<void>
  close?(): void | Promise<void>
}

export type SessionJournalBackendFactoryV3 = Readonly<{
  kind: SessionStoreKindV3
  create(root: string): InitializableSessionJournalStoreV3
}>

export type SessionJournalCompositionV3 = Readonly<{
  storeKind: SessionStoreKindV3
  journal: SessionJournalV3
  archiveStore?: SessionJournalArchiveStoreV3
  canRecoverInterruptedRuns: boolean
  close(): Promise<void>
}>

export type CreateSessionJournalCompositionOptionsV3 = Readonly<{
  root?: string
  configuration?: SessionStorageConfigurationV3
  factories?: readonly SessionJournalBackendFactoryV3[]
}>

type AuthorityMarkerV1 = Readonly<{
  version: 1
  domain: 'session'
  store: SessionStoreKindV3
  generationId: string
  createdAt: string
  checksum: `sha256:${string}`
}>

const LOCK_TIMEOUT_MS = 5_000
const STALE_LOCK_MS = 30_000

/**
 * Selects one SessionJournal authority and injects the resulting domain port.
 * Backend-specific paths never cross this composition boundary.
 */
export async function createSessionJournalCompositionV3(
  options: CreateSessionJournalCompositionOptionsV3 = {},
): Promise<SessionJournalCompositionV3> {
  const root = options.root ?? process.env.PRAXIS_HOME ?? join(homedir(), '.praxis')
  const requested = validateConfiguration(options.configuration)
  const factories = factoryRegistry(options.factories)
  const factory = factories.get(requested)
  if (factory === undefined) throw authorityError('SESSION_STORE_UNAVAILABLE')
  if (await exists(migrationLockPath(root))) {
    throw authorityError('SESSION_STORE_MIGRATION_BUSY')
  }

  const store = factory.create(root)
  if (
    !isRecord(store) ||
    typeof store.initialize !== 'function' ||
    typeof store.appendCommit !== 'function' ||
    typeof store.readEntries !== 'function'
  ) {
    throw authorityError('SESSION_STORE_FACTORY_INVALID')
  }

  let initialized = false
  const marker = await withAuthorityLock(root, async () => {
    const authorities = await detectBackendAuthorities(root)
    if (authorities.size > 1) throw authorityError('SESSION_STORE_AUTHORITY_AMBIGUOUS')
    let existing: AuthorityMarkerV1 | undefined
    try {
      existing = validateAuthorityMarker(
        JSON.parse(await readFile(authorityPath(root), 'utf8')) as unknown,
      )
    } catch (error) {
      if (isNotFound(error)) existing = undefined
      else if (error instanceof SyntaxError) throw authorityError('SESSION_STORE_AUTHORITY_INVALID')
      else throw error
    }

    const detected = [...authorities][0]
    if (
      (existing !== undefined && existing.store !== requested) ||
      (detected !== undefined && detected !== requested) ||
      (existing !== undefined && detected !== undefined && existing.store !== detected)
    ) {
      throw authorityError('SESSION_STORE_SWITCH_REQUIRES_IMPORT')
    }

    const selected = existing ?? createAuthorityMarker(requested)
    if (existing === undefined || detected === undefined) {
      try {
        await store.initialize()
        initialized = true
      } catch (error) {
        try {
          await store.close?.()
        } catch {
          // Initialization owns the failure; best-effort cleanup must not replace it.
        }
        throw error
      }
    }
    if (existing === undefined) await atomicWriteAuthority(authorityPath(root), selected)
    return selected
  })

  if (marker.store !== requested) throw authorityError('SESSION_STORE_SWITCH_REQUIRES_IMPORT')
  if (!initialized) await store.initialize()
  let runtimeLease: Readonly<{ path: string; hasLivePeer: boolean }>
  try {
    runtimeLease = await withAuthorityLock(root, () => createRuntimeLease(root))
  } catch (error) {
    await store.close?.()
    throw error
  }
  if (await exists(migrationLockPath(root))) {
    await unlink(runtimeLease.path).catch(() => {})
    await store.close?.()
    throw authorityError('SESSION_STORE_MIGRATION_BUSY')
  }
  let closed = false
  return Object.freeze({
    storeKind: requested,
    journal: new ReducingSessionJournalV3(store),
    ...(isArchiveStore(store) ? { archiveStore: store } : {}),
    canRecoverInterruptedRuns: !runtimeLease.hasLivePeer,
    async close() {
      if (closed) return
      closed = true
      try {
        await store.close?.()
      } finally {
        await unlink(runtimeLease.path).catch(() => {})
      }
    },
  })
}

export async function inspectSessionStorageAuthorityV3(
  root = process.env.PRAXIS_HOME ?? join(homedir(), '.praxis'),
): Promise<SessionStoreKindV3 | undefined> {
  try {
    return validateAuthorityMarker(
      JSON.parse(await readFile(authorityPath(root), 'utf8')) as unknown,
    ).store
  } catch (error) {
    if (isNotFound(error)) return undefined
    if (error instanceof SyntaxError) throw authorityError('SESSION_STORE_AUTHORITY_INVALID')
    throw error
  }
}

export async function replaceSessionStorageAuthorityV3(
  root: string,
  store: SessionStoreKindV3,
): Promise<void> {
  if (store !== 'jsonl' && store !== 'sqlite') {
    throw authorityError('SESSION_STORE_CONFIG_INVALID')
  }
  await atomicWriteAuthority(authorityPath(root), createAuthorityMarker(store))
}

function isArchiveStore(
  store: InitializableSessionJournalStoreV3,
): store is InitializableSessionJournalStoreV3 & SessionJournalArchiveStoreV3 {
  return (
    typeof Reflect.get(store, 'listSessionIds') === 'function' &&
    typeof Reflect.get(store, 'readCommits') === 'function'
  )
}

export function defaultSessionJournalFactoriesV3(): readonly SessionJournalBackendFactoryV3[] {
  return Object.freeze([
    Object.freeze({
      kind: 'jsonl' as const,
      create: (root: string) => new JsonlSessionJournalV3(root),
    }),
  ])
}

function validateConfiguration(
  configuration: SessionStorageConfigurationV3 | undefined,
): SessionStoreKindV3 {
  if (configuration === undefined) return 'jsonl'
  if (!isRecord(configuration) || !onlyKeys(configuration, ['session'])) {
    throw authorityError('SESSION_STORE_CONFIG_INVALID')
  }
  if (configuration.session === undefined) return 'jsonl'
  if (
    !isRecord(configuration.session) ||
    !onlyKeys(configuration.session, ['store']) ||
    (configuration.session.store !== undefined &&
      configuration.session.store !== 'jsonl' &&
      configuration.session.store !== 'sqlite')
  ) {
    throw authorityError('SESSION_STORE_CONFIG_INVALID')
  }
  return configuration.session.store ?? 'jsonl'
}

function factoryRegistry(
  additions: readonly SessionJournalBackendFactoryV3[] | undefined,
): Map<SessionStoreKindV3, SessionJournalBackendFactoryV3> {
  const registry = new Map<SessionStoreKindV3, SessionJournalBackendFactoryV3>()
  for (const factory of [...defaultSessionJournalFactoriesV3(), ...(additions ?? [])]) {
    if (
      !isRecord(factory) ||
      (factory.kind !== 'jsonl' && factory.kind !== 'sqlite') ||
      typeof factory.create !== 'function' ||
      registry.has(factory.kind)
    ) {
      throw authorityError('SESSION_STORE_FACTORY_INVALID')
    }
    registry.set(factory.kind, factory)
  }
  return registry
}

async function detectBackendAuthorities(root: string): Promise<Set<SessionStoreKindV3>> {
  const detected = new Set<SessionStoreKindV3>()
  if (await exists(join(root, 'session-journal-v3', 'authority.json'))) detected.add('jsonl')
  if (await exists(join(root, 'session-journal-v3.sqlite'))) detected.add('sqlite')
  return detected
}

function createAuthorityMarker(store: SessionStoreKindV3): AuthorityMarkerV1 {
  const payload = {
    version: 1 as const,
    domain: 'session' as const,
    store,
    generationId: randomUUID(),
    createdAt: new Date().toISOString(),
  }
  return Object.freeze({ ...payload, checksum: digest(payload) })
}

function validateAuthorityMarker(input: unknown): AuthorityMarkerV1 {
  if (
    !isRecord(input) ||
    !onlyKeys(input, ['version', 'domain', 'store', 'generationId', 'createdAt', 'checksum']) ||
    input.version !== 1 ||
    input.domain !== 'session' ||
    (input.store !== 'jsonl' && input.store !== 'sqlite') ||
    typeof input.generationId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(input.generationId) ||
    !canonicalInstant(input.createdAt) ||
    typeof input.checksum !== 'string'
  ) {
    throw authorityError('SESSION_STORE_AUTHORITY_INVALID')
  }
  const payload = {
    version: 1 as const,
    domain: 'session' as const,
    store: input.store as SessionStoreKindV3,
    generationId: input.generationId,
    createdAt: input.createdAt,
  }
  if (input.checksum !== digest(payload)) {
    throw authorityError('SESSION_STORE_AUTHORITY_INVALID')
  }
  return Object.freeze({ ...payload, checksum: input.checksum as `sha256:${string}` })
}

async function atomicWriteAuthority(path: string, marker: AuthorityMarkerV1): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(marker, undefined, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

async function withAuthorityLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const lockDirectory = join(root, 'locks')
  const path = join(lockDirectory, 'session-authority.lock')
  await mkdir(lockDirectory, { recursive: true })
  const startedAt = Date.now()
  while (true) {
    try {
      const handle = await open(path, 'wx')
      try {
        await handle.writeFile(
          JSON.stringify({ version: 1, pid: process.pid, acquiredAt: new Date().toISOString() }),
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
          'SESSION_STORE_AUTHORITY_BUSY',
          'persistence',
          'Another process owns the Session authority lock.',
          undefined,
          true,
        )
      }
      await delay(25)
    }
  }
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > STALE_LOCK_MS
  } catch {
    return false
  }
}

function authorityPath(root: string): string {
  return join(root, 'session-authority.json')
}

function migrationLockPath(root: string): string {
  return join(root, 'locks', 'session-storage-migration.lock')
}

async function createRuntimeLease(
  root: string,
): Promise<Readonly<{ path: string; hasLivePeer: boolean }>> {
  const directory = join(root, 'locks')
  await mkdir(directory, { recursive: true })
  let hasLivePeer = false
  for (const name of await readdir(directory)) {
    const match = /^session-runtime-(\d+)-[a-f0-9-]+\.lock$/u.exec(name)
    if (match === null) continue
    const existing = join(directory, name)
    const pid = await readRuntimeLeasePid(existing, Number(match[1]))
    if (processIsAlive(pid)) {
      hasLivePeer = true
      continue
    }
    await unlink(existing).catch((error: unknown) => {
      if (!isNotFound(error)) throw error
    })
  }
  const path = join(root, 'locks', `session-runtime-${process.pid}-${randomUUID()}.lock`)
  const handle = await open(path, 'wx')
  try {
    await handle.writeFile(
      JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date().toISOString() }),
    )
    await handle.sync()
  } finally {
    await handle.close()
  }
  return Object.freeze({ path, hasLivePeer })
}

async function readRuntimeLeasePid(path: string, fallback: number): Promise<number> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    const pid = isRecord(value) ? value.pid : undefined
    return Number.isSafeInteger(pid) && Number(pid) > 0 ? Number(pid) : fallback
  } catch (error) {
    if (isNotFound(error)) return -1
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

function canonicalInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function authorityError(code: string) {
  return runtimeError(code, 'persistence', 'Session store authority selection failed.')
}
