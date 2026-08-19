import { createHash } from 'node:crypto'
import { runtimeError } from './contracts.js'
import {
  type SessionCommitV3,
  type SessionJournalCommitStoreV3,
  validateSessionCommitV3,
} from './session-journal-port.js'
import { reduceSessionEntriesV3 } from './session-journal.js'

export interface SessionJournalArchiveStoreV3 extends SessionJournalCommitStoreV3 {
  listSessionIds(): Promise<readonly string[]>
  readCommits(sessionId: string): Promise<readonly SessionCommitV3[]>
}

export type PortableSessionJournalV3 = Readonly<{
  formatVersion: 3
  exportedAt: string
  sessions: readonly Readonly<{
    sessionId: string
    commits: readonly SessionCommitV3[]
  }>[]
  checksum: `sha256:${string}`
}>

export type SessionJournalImportReportV3 = Readonly<{
  formatVersion: 3
  sourceChecksum: `sha256:${string}`
  sessionCount: number
  commitCount: number
  entryCount: number
  acceptedCommits: number
  duplicateCommits: number
  verified: true
}>

export async function exportSessionJournalV3(
  source: SessionJournalArchiveStoreV3,
  exportedAt = new Date().toISOString(),
): Promise<PortableSessionJournalV3> {
  if (!canonicalInstant(exportedAt)) throw transferError('SESSION_EXPORT_INVALID')
  const sessionIds = [...(await source.listSessionIds())].sort()
  if (new Set(sessionIds).size !== sessionIds.length || !sessionIds.every(safeId)) {
    throw transferError('SESSION_BACKEND_CONTRACT_INVALID')
  }
  const sessions = []
  for (const sessionId of sessionIds) {
    const commits = (await source.readCommits(sessionId)).map(validateSessionCommitV3)
    validateCommitStream(sessionId, commits)
    sessions.push({ sessionId, commits })
  }
  const payload = { formatVersion: 3 as const, exportedAt, sessions }
  return deepFreeze({ ...payload, checksum: checksum(payload) })
}

export function validatePortableSessionJournalV3(input: unknown): PortableSessionJournalV3 {
  if (
    !isRecord(input) ||
    !onlyKeys(input, ['formatVersion', 'exportedAt', 'sessions', 'checksum']) ||
    input.formatVersion !== 3 ||
    !canonicalInstant(input.exportedAt) ||
    !Array.isArray(input.sessions) ||
    typeof input.checksum !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(input.checksum)
  ) {
    throw transferError('SESSION_EXPORT_INVALID')
  }
  const sessions: Array<{ sessionId: string; commits: SessionCommitV3[] }> = []
  const sessionIds = new Set<string>()
  for (const candidate of input.sessions) {
    if (
      !isRecord(candidate) ||
      !onlyKeys(candidate, ['sessionId', 'commits']) ||
      !safeId(candidate.sessionId) ||
      sessionIds.has(candidate.sessionId) ||
      !Array.isArray(candidate.commits)
    ) {
      throw transferError('SESSION_EXPORT_INVALID')
    }
    sessionIds.add(candidate.sessionId)
    const commits = candidate.commits.map(validateSessionCommitV3)
    validateCommitStream(candidate.sessionId, commits)
    sessions.push({ sessionId: candidate.sessionId, commits })
  }
  if (
    sessions.some(
      (session, index) => index > 0 && sessions[index - 1]!.sessionId > session.sessionId,
    )
  ) {
    throw transferError('SESSION_EXPORT_INVALID')
  }
  const payload = { formatVersion: 3 as const, exportedAt: input.exportedAt, sessions }
  if (input.checksum !== checksum(payload)) throw transferError('SESSION_EXPORT_CHECKSUM_INVALID')
  return deepFreeze({ ...payload, checksum: input.checksum as `sha256:${string}` })
}

export async function importSessionJournalV3(
  target: SessionJournalArchiveStoreV3,
  input: unknown,
): Promise<SessionJournalImportReportV3> {
  const archive = validatePortableSessionJournalV3(input)
  await validateImportTarget(target, archive)
  let acceptedCommits = 0
  let duplicateCommits = 0
  let commitCount = 0
  let entryCount = 0
  for (const session of archive.sessions) {
    for (const commit of session.commits) {
      const receipt = await target.appendCommit(commit)
      if (receipt.duplicate) duplicateCommits += 1
      else acceptedCommits += 1
      commitCount += 1
      entryCount += commit.entries.length
    }
  }

  const verified = await exportSessionJournalV3(target, archive.exportedAt)
  if (verified.checksum !== archive.checksum || !sameArchiveIdentity(verified, archive)) {
    throw transferError('SESSION_IMPORT_VERIFICATION_FAILED')
  }
  return deepFreeze({
    formatVersion: 3 as const,
    sourceChecksum: archive.checksum,
    sessionCount: archive.sessions.length,
    commitCount,
    entryCount,
    acceptedCommits,
    duplicateCommits,
    verified: true as const,
  })
}

async function validateImportTarget(
  target: SessionJournalArchiveStoreV3,
  archive: PortableSessionJournalV3,
): Promise<void> {
  const sources = new Map(archive.sessions.map((session) => [session.sessionId, session.commits]))
  const targetSessionIds = [...(await target.listSessionIds())].sort()
  if (
    new Set(targetSessionIds).size !== targetSessionIds.length ||
    !targetSessionIds.every((sessionId) => sources.has(sessionId))
  ) {
    throw transferError('SESSION_IMPORT_TARGET_DIVERGED')
  }
  for (const sessionId of targetSessionIds) {
    const persisted = await target.readCommits(sessionId)
    const source = sources.get(sessionId)!
    if (
      persisted.length > source.length ||
      persisted.some((commit, index) => canonicalJson(commit) !== canonicalJson(source[index]))
    ) {
      throw transferError('SESSION_IMPORT_TARGET_DIVERGED')
    }
  }
}

function validateCommitStream(sessionId: string, commits: readonly SessionCommitV3[]): void {
  if (commits.length === 0) throw transferError('SESSION_EXPORT_INVALID')
  const entries = []
  let revision = 0
  let sequence = 0
  for (const commit of commits) {
    if (
      commit.sessionId !== sessionId ||
      commit.expectedRevision !== revision ||
      commit.entries[0]!.sequence !== sequence + 1
    ) {
      throw transferError('SESSION_EXPORT_INVALID')
    }
    revision += 1
    sequence = commit.entries.at(-1)!.sequence
    entries.push(...commit.entries)
  }
  try {
    reduceSessionEntriesV3(entries)
  } catch {
    throw transferError('SESSION_EXPORT_INVALID')
  }
}

function sameArchiveIdentity(
  left: PortableSessionJournalV3,
  right: PortableSessionJournalV3,
): boolean {
  return canonicalJson(left.sessions) === canonicalJson(right.sessions)
}

function checksum(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  throw transferError('SESSION_EXPORT_INVALID')
}

function canonicalInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(value)
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function transferError(code: string) {
  return runtimeError(code, 'persistence', 'SessionJournal transfer failed.')
}
