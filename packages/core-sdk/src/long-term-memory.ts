/** Local cross-session memory. SessionMemory and execution evidence remain separate. */
export function isMemoryToolNameV1(name: string): boolean {
  return ['memory.search', 'memory.get', 'memory.upsert', 'memory.forget'].includes(name)
}

export type MemoryModeV1 = 'off' | 'read-only' | 'explicit'
export type MemoryScopeV1 = 'project' | 'user'
export type MemoryKindV1 = 'preference' | 'feedback' | 'decision' | 'reference' | 'experience'

export type MemoryProjectV1 = Readonly<{
  projectId: string
  root: string
  mode: MemoryModeV1
  userAccess: boolean
}>

export type LongTermMemoryV1 = Readonly<{
  schemaVersion: 1
  id: string
  revision: number
  scope: MemoryScopeV1
  projectId?: string
  key: string
  kind: MemoryKindV1
  content: string
  applicability: string
  source: Readonly<{
    kind: 'user_explicit'
    sessionId?: string
    runId?: string
    promptId?: string
  }>
  createdAt: string
  updatedAt: string
  expiresAt?: string
}>

export type MemoryWriteV1 = Readonly<{
  key: string
  kind: MemoryKindV1
  content: string
  applicability?: string
  expiresAt?: string
  /** 0 means create only; edits require the current revision. */
  expectedRevision: number
}>

export type MemoryReceiptV1 = Readonly<{
  operationId: string
  id: string
  revision: number
  action: 'upsert' | 'forget'
}>

export type MemoryManageRequestV1 = Readonly<{
  workspace: string
  action:
    | 'status'
    | 'configure'
    | 'list'
    | 'get'
    | 'upsert'
    | 'forget'
    | 'export'
    | 'import'
    | 'rebind'
  scope?: MemoryScopeV1
  mode?: MemoryModeV1
  userAccess?: boolean
  id?: string
  query?: string
  limit?: number
  afterId?: string
  operationId?: string
  expectedRevision?: number
  memory?: MemoryWriteV1
  /** Import is create-only and explicitly targets this workspace/scope. */
  memories?: readonly MemoryWriteV1[]
}>

export type MemoryContextManifestV1 = Readonly<{
  snapshotId: string
  projectId: string
  digest: `sha256:${string}`
  records: readonly Readonly<{ id: string; revision: number }>[]
  tokens: number
}>
