import type { ProviderMessage, SessionMemory, SessionRecord } from '@praxis/core-sdk'

export const SESSION_STORE_VERSION = 2 as const

export type SessionIndexEntry = {
  recordVersion: 2
  sessionId: string
  name: string
  workspace: string
  provider: string
  model: string
  plannerMode?: NonNullable<SessionRecord['plannerMode']>
  createdAt: string
  updatedAt: string
  state: SessionRecord['state']
  activeLeafId: string
  parentSessionId?: string
  labels: string[]
  messageCount: number
  usage: NonNullable<SessionRecord['usage']>
  lastTerminalState?: NonNullable<SessionRecord['lastTerminalState']>
}

export type SessionExport = {
  exportVersion: 1
  exportedAt: string
  session: SessionRecord
  messages: ProviderMessage[]
  memory: SessionMemory
}

export type SessionRetentionPolicy = {
  maxSessions?: number
  maxAgeDays?: number
}

export interface SessionManagementRepository {
  rename(sessionId: string, name: string): Promise<SessionRecord>
  search(query: string): Promise<SessionIndexEntry[]>
  exportSession(sessionId: string): Promise<SessionExport>
  deleteToTrash(sessionId: string): Promise<{ trashPath: string }>
  applyRetention(policy: SessionRetentionPolicy): Promise<string[]>
  forkSession(
    sourceSessionId: string,
    target: SessionRecord,
    throughMessage?: number,
  ): Promise<void>
  setActiveLeaf(sessionId: string, activeLeafId: string): Promise<void>
}

export function toSessionIndex(record: SessionRecord): SessionIndexEntry {
  return {
    recordVersion: 2,
    sessionId: record.sessionId,
    name: record.name ?? record.sessionId,
    workspace: record.cwd,
    provider: record.provider,
    model: record.model,
    ...(record.plannerMode === undefined ? {} : { plannerMode: record.plannerMode }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    state: record.state,
    activeLeafId: record.activeLeafId ?? record.sessionId,
    ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
    labels: [...(record.labels ?? [])],
    messageCount: record.messageCount ?? 0,
    usage: { ...(record.usage ?? {}) },
    ...(record.lastTerminalState ? { lastTerminalState: record.lastTerminalState } : {}),
  }
}
