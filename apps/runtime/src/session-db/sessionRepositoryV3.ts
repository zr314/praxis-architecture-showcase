import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createSessionCommitV3,
  runtimeError,
  sessionCompactionSummaryDigestV3,
  validateSessionEntryV3,
  type ProviderMessage,
  type ProviderUsage,
  type SessionCompactionSummaryV3,
  type SessionJournalArchiveStoreV3,
  type SessionJournalV3,
  type SessionMemory,
  type SessionProjectionV3,
  type SessionRecord,
  type SessionRepository,
  type SummaryCheckpoint,
} from '@praxis/core-sdk'
import {
  createSessionJournalCompositionV3,
  type SessionJournalCompositionV3,
  type SessionStoreKindV3,
} from './sessionJournalComposition.js'
import { sqliteSessionJournalFactoryV3 } from './sqliteSessionJournalV3.js'
import {
  toSessionIndex,
  type SessionExport,
  type SessionIndexEntry,
  type SessionManagementRepository,
  type SessionRetentionPolicy,
} from './sessionV2.js'

type EntryDraft = Readonly<{
  type: string
  data: Record<string, unknown>
  runId?: string
  correlation?: Record<string, string>
  timestamp?: string
}>

export type SessionStorageStatusV3 = Readonly<{
  authority: 'v3'
  store: SessionStoreKindV3
  root: string
  liveSwitch: false
}>

export type SessionStorageScrubReportV3 = Readonly<{
  store: SessionStoreKindV3
  sessions: number
  repairedPending?: number
  integrity?: string
}>

const MAX_CAS_RETRIES = 8
const MAX_FORK_MESSAGES_PER_COMMIT = 128

/** Product SessionRepository facade backed by exactly one V3 SessionJournal authority. */
export class SessionRepositoryV3 implements SessionRepository, SessionManagementRepository {
  readonly #root: string
  readonly #requestedStore: SessionStoreKindV3
  #composition?: SessionJournalCompositionV3

  constructor(
    options: Readonly<{
      root?: string
      store?: SessionStoreKindV3
    }> = {},
  ) {
    this.#root = options.root ?? process.env.PRAXIS_HOME ?? join(homedir(), '.praxis')
    this.#requestedStore = options.store ?? sessionStoreFromEnvironment(process.env)
  }

  async initialize(): Promise<void> {
    if (this.#composition !== undefined) return
    const composition = await createSessionJournalCompositionV3({
      root: this.#root,
      configuration: { session: { store: this.#requestedStore } },
      factories: [sqliteSessionJournalFactoryV3()],
    })
    if (composition.archiveStore === undefined) {
      await composition.close()
      throw persistenceError('SESSION_STORE_ARCHIVE_UNAVAILABLE')
    }
    this.#composition = composition
    if (composition.canRecoverInterruptedRuns) await this.recoverInterruptedRuns()
  }

  async close(): Promise<void> {
    const composition = this.#composition
    this.#composition = undefined
    await composition?.close()
  }

  async deepScrub(): Promise<SessionStorageScrubReportV3> {
    const archive = this.archive() as SessionJournalArchiveStoreV3 & {
      deepScrub?: () => Promise<SessionStorageScrubReportV3>
    }
    if (typeof archive.deepScrub !== 'function') {
      throw persistenceError('SESSION_STORE_SCRUB_UNAVAILABLE')
    }
    return archive.deepScrub()
  }

  storageStatus(): SessionStorageStatusV3 {
    return Object.freeze({
      authority: 'v3',
      store: this.#composition?.storeKind ?? this.#requestedStore,
      root: this.#root,
      liveSwitch: false,
    })
  }

  journal(): SessionJournalV3 {
    return this.requireComposition().journal
  }

  async list(): Promise<SessionRecord[]> {
    const records: SessionRecord[] = []
    for (const sessionId of await this.archive().listSessionIds()) {
      const projection = await this.loadProjection(sessionId)
      if (projection !== undefined && projection.snapshot.lifecycle !== 'deleted') {
        records.push(toRecord(projection))
      }
    }
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    const projection = await this.loadProjection(sessionId)
    return projection === undefined || projection.snapshot.lifecycle === 'deleted'
      ? undefined
      : toRecord(projection)
  }

  async create(session: SessionRecord): Promise<void> {
    if ((await this.loadProjection(session.sessionId)) !== undefined) {
      throw runtimeError('SESSION_ALREADY_EXISTS', 'protocol', 'Session already exists.')
    }
    await this.append(session.sessionId, 'create', () => ({
      expectedMissing: true,
      drafts: [
        {
          type: 'session.created',
          timestamp: session.createdAt,
          data: {
            cwd: session.cwd,
            provider: session.provider,
            model: session.model,
            name: session.name ?? session.sessionId,
            labels: [...(session.labels ?? [])],
            plannerMode: session.plannerMode ?? 'auto',
            ...(session.contextLimitTokens === undefined
              ? {}
              : { contextLimitTokens: session.contextLimitTokens }),
            ...(session.parentSessionId === undefined
              ? {}
              : {
                  fork: {
                    parentSessionId: session.parentSessionId,
                    sourceEntryId: `source-${session.parentSessionId}`,
                  },
                }),
          },
        },
      ],
    }))
  }

  async update(session: SessionRecord): Promise<void> {
    await this.append(session.sessionId, 'update', (projection) => {
      const current = requireOpenOrClosed(projection)
      const drafts: EntryDraft[] = []
      const metadata: Record<string, unknown> = {}
      if (current.snapshot.name !== (session.name ?? session.sessionId)) {
        metadata.name = session.name ?? session.sessionId
      }
      if (!sameStrings(current.snapshot.labels, session.labels ?? [])) {
        metadata.labels = [...(session.labels ?? [])]
      }
      if (current.snapshot.provider !== session.provider) metadata.provider = session.provider
      if (current.snapshot.model !== session.model) metadata.model = session.model
      if (current.snapshot.activeLeafId !== (session.activeLeafId ?? session.sessionId)) {
        metadata.activeLeafId = session.activeLeafId ?? session.sessionId
      }
      if ((current.snapshot.plannerMode ?? 'auto') !== (session.plannerMode ?? 'auto')) {
        metadata.plannerMode = session.plannerMode ?? 'auto'
      }
      if (
        session.contextLimitTokens !== undefined &&
        current.snapshot.contextLimitTokens !== session.contextLimitTokens
      ) {
        metadata.contextLimitTokens = session.contextLimitTokens
      }
      if (Object.keys(metadata).length > 0) {
        drafts.push({ type: 'session.metadata_updated', data: metadata })
      }
      if (session.state === 'closed' && current.snapshot.lifecycle === 'open') {
        drafts.push({ type: 'session.closed', data: {} })
      } else if (session.state !== 'closed' && current.snapshot.lifecycle === 'closed') {
        drafts.push({ type: 'session.reopened', data: {} })
      }
      return { drafts }
    })
  }

  async appendMessage(sessionId: string, message: ProviderMessage): Promise<void> {
    await this.append(sessionId, 'message', (projection) => ({
      drafts: [messageDraft(requireOpen(projection), message)],
    }))
  }

  async appendRequestMessage(
    sessionId: string,
    clientRequestId: string,
    runId: string,
    message: ProviderMessage,
  ): Promise<{ duplicateRunId?: string }> {
    return this.append<{ duplicateRunId?: string }>(
      sessionId,
      `request-${clientRequestId}`,
      (projection) => {
        const current = requireOpen(projection)
        const duplicate = current.snapshot.runs.find(
          (candidate) => candidate.clientRequestId === clientRequestId,
        )
        if (duplicate !== undefined) {
          return { drafts: [], result: { duplicateRunId: duplicate.runId } }
        }
        if (current.snapshot.runs.some((candidate) => candidate.state === 'running')) {
          throw runtimeError('SESSION_BUSY', 'protocol', 'Session already has an active run.')
        }
        return {
          drafts: [
            { type: 'run.started', runId, data: { clientRequestId } },
            messageDraft(current, message),
          ],
          result: {},
        }
      },
    )
  }

  async loadMessages(sessionId: string): Promise<ProviderMessage[]> {
    const projection = requireExisting(await this.loadProjection(sessionId))
    return projection.snapshot.messages.map(({ message }) => structuredClone(message))
  }

  async loadClientRequests(sessionId: string): Promise<Record<string, string>> {
    const projection = requireExisting(await this.loadProjection(sessionId))
    return Object.fromEntries(
      projection.snapshot.runs.map((run) => [run.clientRequestId, run.runId]),
    )
  }

  async loadMemory(sessionId: string): Promise<SessionMemory> {
    const projection = requireExisting(await this.loadProjection(sessionId))
    const checkpoint = restoreCheckpoint(projection)
    return {
      sessionId,
      ...(checkpoint === undefined ? {} : { checkpoint }),
      ...(projection.compactPlan === undefined
        ? {}
        : { plan: structuredClone(projection.compactPlan) }),
    }
  }

  async saveMemory(memory: SessionMemory): Promise<void> {
    await this.append(memory.sessionId, 'memory', (projection) => {
      const current = requireExisting(projection)
      const drafts: EntryDraft[] = []
      if (!sameJson(current.compactPlan, memory.plan)) {
        drafts.push({
          type: 'session.plan_updated',
          data: { plan: memory.plan === undefined ? null : structuredClone(memory.plan) },
        })
      }
      if (
        memory.checkpoint !== undefined &&
        current.checkpoint?.checkpointId !== memory.checkpoint.id
      ) {
        drafts.push(compactionDraft(current, memory.checkpoint))
      }
      return { drafts }
    })
  }

  async updateTerminal(
    sessionId: string,
    terminal: NonNullable<SessionRecord['lastTerminalState']>,
    usage: ProviderUsage,
    _messageCount: number,
    errorCode?: string,
  ): Promise<SessionRecord> {
    await this.append(sessionId, 'terminal', (projection) => {
      const current = requireExisting(projection)
      const active = current.snapshot.runs.find((run) => run.state === 'running')
      if (active === undefined) throw persistenceError('RUN_NOT_ACTIVE')
      return {
        drafts: [
          {
            type: 'run.terminal',
            runId: active.runId,
            data: {
              status: terminal,
              usage: usageDelta(usage, completedRunUsage(current)),
              ...(errorCode === undefined ? {} : { errorCode }),
            },
          },
        ],
      }
    })
    return requireRecord(await this.get(sessionId))
  }

  async rename(sessionId: string, name: string): Promise<SessionRecord> {
    const current = requireRecord(await this.get(sessionId))
    await this.update({ ...current, name, updatedAt: new Date().toISOString() })
    return requireRecord(await this.get(sessionId))
  }

  async search(query: string): Promise<SessionIndexEntry[]> {
    const normalized = query.trim().toLocaleLowerCase()
    return (await this.list())
      .filter((record) =>
        [record.sessionId, record.name ?? '', record.cwd, ...(record.labels ?? [])]
          .join('\n')
          .toLocaleLowerCase()
          .includes(normalized),
      )
      .map(toSessionIndex)
  }

  async exportSession(sessionId: string): Promise<SessionExport> {
    return {
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      session: requireRecord(await this.get(sessionId)),
      messages: await this.loadMessages(sessionId),
      memory: await this.loadMemory(sessionId),
    }
  }

  async deleteToTrash(sessionId: string): Promise<{ trashPath: string }> {
    const projection = requireExisting(await this.loadProjection(sessionId))
    if (projection.snapshot.runs.some((run) => run.state === 'running')) {
      throw runtimeError('SESSION_BUSY', 'protocol', 'Cannot delete a session with an active run.')
    }
    const trashPath = join(
      this.#root,
      'trash',
      'session-journal-v3',
      `${sessionId}.${safeTimestamp()}.${randomUUID()}.json`,
    )
    await atomicCreate(
      trashPath,
      `${JSON.stringify(
        {
          formatVersion: 3,
          sessionId,
          deletedAt: new Date().toISOString(),
          commits: await this.archive().readCommits(sessionId),
        },
        undefined,
        2,
      )}\n`,
    )
    await this.append(sessionId, 'delete', () => ({
      drafts: [{ type: 'session.deleted', data: { mode: 'tombstone' } }],
    }))
    return { trashPath }
  }

  async applyRetention(policy: SessionRetentionPolicy): Promise<string[]> {
    const records = (await this.list()).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )
    const selected = new Set<string>()
    if (policy.maxAgeDays !== undefined) {
      const threshold = Date.now() - policy.maxAgeDays * 86_400_000
      for (const record of records) {
        if (Date.parse(record.updatedAt) < threshold) selected.add(record.sessionId)
      }
    }
    if (policy.maxSessions !== undefined) {
      for (const record of records.slice(policy.maxSessions)) selected.add(record.sessionId)
    }
    for (const sessionId of selected) await this.deleteToTrash(sessionId)
    return [...selected]
  }

  async forkSession(
    sourceSessionId: string,
    target: SessionRecord,
    throughMessage?: number,
  ): Promise<void> {
    const source = requireOpenOrClosed(await this.loadProjection(sourceSessionId))
    const sourceEntries = (await this.archive().readCommits(sourceSessionId)).flatMap(
      (commit) => commit.entries,
    )
    const messages = source.snapshot.messages.slice(
      0,
      Math.min(throughMessage ?? source.snapshot.messages.length, source.snapshot.messages.length),
    )
    await this.create({ ...target, parentSessionId: sourceSessionId, messageCount: 0 })
    for (let offset = 0; offset < messages.length; offset += MAX_FORK_MESSAGES_PER_COMMIT) {
      const batch = messages.slice(offset, offset + MAX_FORK_MESSAGES_PER_COMMIT)
      await this.append(target.sessionId, `fork-messages-${offset}`, (projection) => ({
        drafts: batch.map(({ message }) => messageDraft(requireExisting(projection), message)),
      }))
    }
    await this.append(sourceSessionId, `fork-${target.sessionId}`, () => ({
      drafts: [
        {
          type: 'session.forked',
          data: {
            childSessionId: target.sessionId,
            sourceEntryId: sourceEntries.at(-1)?.entryId ?? sourceEntries[0]!.entryId,
          },
        },
      ],
    }))
  }

  async setActiveLeaf(sessionId: string, activeLeafId: string): Promise<void> {
    await this.append(sessionId, 'active-leaf', () => ({
      drafts: [{ type: 'session.metadata_updated', data: { activeLeafId } }],
    }))
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const archive = this.archive() as SessionJournalArchiveStoreV3 & {
      listRecoverableSessionIds?: () => Promise<readonly string[]>
      loadCachedProjection?: (sessionId: string) => Promise<SessionProjectionV3>
    }
    const sessionIds =
      typeof archive.listRecoverableSessionIds === 'function'
        ? await archive.listRecoverableSessionIds()
        : await archive.listSessionIds()
    for (const sessionId of sessionIds) {
      const projection =
        typeof archive.loadCachedProjection === 'function'
          ? await archive.loadCachedProjection(sessionId)
          : await this.loadProjection(sessionId)
      if (
        projection === undefined ||
        projection.snapshot.lifecycle !== 'open' ||
        !projection.snapshot.runs.some((run) => run.state === 'running')
      ) {
        continue
      }
      await this.append(sessionId, 'startup-recovery', (current) => {
        const value = requireExisting(current)
        const run = value.snapshot.runs.find((candidate) => candidate.state === 'running')
        if (run === undefined) return { drafts: [] }
        const drafts: EntryDraft[] = []
        const plan = value.planGraph
        if (plan !== undefined && ['draft', 'running', 'blocked'].includes(plan.state)) {
          for (const step of plan.steps) {
            const attempt = [...step.attempts]
              .reverse()
              .find((candidate) =>
                ['reserved', 'running', 'execution_succeeded', 'verifying'].includes(
                  candidate.state,
                ),
              )
            if (attempt !== undefined) {
              drafts.push({
                type: 'attempt.state_changed',
                runId: run.runId,
                data: {
                  planId: plan.planId,
                  planRevision: plan.revision,
                  stepId: step.stepId,
                  attemptId: attempt.attemptId,
                  state: 'interrupted',
                  errorCode: 'RUNTIME_RESTARTED',
                },
              })
              if (['running', 'verifying'].includes(step.state)) {
                drafts.push({
                  type: 'step.state_changed',
                  runId: run.runId,
                  data: {
                    planId: plan.planId,
                    planRevision: plan.revision,
                    stepId: step.stepId,
                    state: 'interrupted',
                    errorCode: 'RUNTIME_RESTARTED',
                  },
                })
              }
            }
          }
          drafts.push({
            type: 'plan.state_changed',
            runId: run.runId,
            data: {
              planId: plan.planId,
              planRevision: plan.revision,
              state: plan.state === 'draft' ? 'cancelled' : 'interrupted',
            },
          })
        }
        drafts.push({
          type: 'run.terminal',
          runId: run.runId,
          data: { status: 'interrupted', usage: {}, errorCode: 'RUNTIME_RESTARTED' },
        })
        return { drafts }
      })
    }
  }

  private async append<T = void>(
    sessionId: string,
    operation: string,
    build: (
      projection: SessionProjectionV3 | undefined,
    ) => Readonly<{ drafts: readonly EntryDraft[]; result?: T; expectedMissing?: boolean }>,
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      const projection = await this.loadProjection(sessionId)
      const calculated = build(projection)
      if (calculated.drafts.length === 0) return calculated.result as T
      if (calculated.expectedMissing && projection !== undefined) {
        throw runtimeError('SESSION_ALREADY_EXISTS', 'protocol', 'Session already exists.')
      }
      const expectedRevision = projection?.snapshot.revision ?? 0
      const firstSequence = (projection?.snapshot.sequence ?? 0) + 1
      const revision = expectedRevision + 1
      const baseline = projection?.catalog.updatedAt
      const fallbackTimestamp = monotonicTimestamp(baseline, new Date().toISOString())
      const token = `${operation}-${randomUUID()}`
      const entries = calculated.drafts.map((draft, index) =>
        validateSessionEntryV3({
          schemaVersion: 3,
          entryId: `entry-${randomUUID()}`,
          sessionId,
          sequence: firstSequence + index,
          revision,
          timestamp: monotonicTimestamp(baseline, draft.timestamp ?? fallbackTimestamp),
          type: draft.type,
          ...(draft.runId === undefined ? {} : { runId: draft.runId }),
          ...(draft.correlation === undefined ? {} : { correlation: draft.correlation }),
          data: draft.data,
        }),
      )
      try {
        await this.journal().appendCommit(
          createSessionCommitV3({
            sessionId,
            commitId: `commit-${token}`,
            expectedRevision,
            idempotencyKey: `idem-${token}`,
            entries,
          }),
        )
        return calculated.result as T
      } catch (error) {
        if (!hasCode(error, 'SESSION_COMMIT_REVISION_CONFLICT') || attempt + 1 >= MAX_CAS_RETRIES) {
          throw error
        }
      }
    }
    throw persistenceError('SESSION_COMMIT_REVISION_CONFLICT')
  }

  private async loadProjection(sessionId: string): Promise<SessionProjectionV3 | undefined> {
    try {
      return await this.journal().loadProjection(sessionId)
    } catch (error) {
      if (hasCode(error, 'SESSION_NOT_FOUND')) return undefined
      throw error
    }
  }

  private archive(): SessionJournalArchiveStoreV3 {
    const archive = this.requireComposition().archiveStore
    if (archive === undefined) throw persistenceError('SESSION_STORE_ARCHIVE_UNAVAILABLE')
    return archive
  }

  private requireComposition(): SessionJournalCompositionV3 {
    if (this.#composition === undefined) throw persistenceError('SESSION_STORE_NOT_INITIALIZED')
    return this.#composition
  }
}

export function sessionStoreFromEnvironment(environment: NodeJS.ProcessEnv): SessionStoreKindV3 {
  const value = environment.PRAXIS_SESSION_STORE?.trim().toLowerCase()
  if (value === undefined || value === '') return 'jsonl'
  if (value === 'jsonl' || value === 'sqlite') return value
  throw runtimeError(
    'SESSION_STORE_CONFIG_INVALID',
    'configuration',
    'PRAXIS_SESSION_STORE must be jsonl or sqlite.',
  )
}

function messageDraft(projection: SessionProjectionV3, message: ProviderMessage): EntryDraft {
  return {
    type: 'message.committed',
    data: {
      messageId: `message-${projection.snapshot.messages.length + 1}-${randomUUID()}`,
      message: structuredClone(message),
    },
  }
}

function compactionDraft(
  projection: SessionProjectionV3,
  checkpoint: SummaryCheckpoint,
): EntryDraft {
  const summary = {
    schemaVersion: 1 as const,
    trust: 'low' as const,
    ...(checkpoint.summary?.objective === undefined
      ? {}
      : { objective: checkpoint.summary.objective }),
    ...(checkpoint.summary?.relevantRefs === undefined
      ? {}
      : { relevantRefs: [...checkpoint.summary.relevantRefs] }),
    decisions: [
      ...(checkpoint.summary?.decisions ?? (checkpoint.content ? [checkpoint.content] : [])),
    ],
    constraints: [...(checkpoint.summary?.constraints ?? [])],
    readFiles: [...(checkpoint.summary?.readFiles ?? [])],
    modifiedFiles: [...(checkpoint.summary?.modifiedFiles ?? [])],
    unresolved: [...(checkpoint.summary?.unresolved ?? [])],
    activePlan: [...(checkpoint.summary?.activePlan ?? [])],
  }
  const coveredStartSequence = projection.checkpoint?.coveredRange.startSequence ?? 1
  const coveredEndSequence = projection.snapshot.sequence
  return {
    type: 'compaction.created',
    timestamp: checkpoint.createdAt,
    data: {
      checkpointId: checkpoint.id,
      coveredStartSequence,
      coveredEndSequence,
      ...(projection.checkpoint === undefined
        ? {}
        : { previousCheckpointId: projection.checkpoint.checkpointId }),
      retainedStartSequence: coveredEndSequence + 1,
      summary,
      provenance:
        checkpoint.provenance ??
        ({
          schemaVersion: 1,
          generator: { kind: 'deterministic', id: 'praxis-runtime-v3' },
        } as const),
      summaryDigest: sessionCompactionSummaryDigestV3(summary),
      summaryTokens: checkpoint.estimatedTokens,
      reason: checkpoint.reason ?? 'manual',
      checkpoint: {
        messageStart: checkpoint.messageStart,
        messageEnd: checkpoint.messageEnd,
        content: checkpoint.content,
        digest: checkpoint.digest as `sha256:${string}`,
        ...(checkpoint.estimatedGainTokens === undefined
          ? {}
          : { estimatedGainTokens: checkpoint.estimatedGainTokens }),
        ...(checkpoint.scope === undefined ? {} : { scope: checkpoint.scope }),
        ...(checkpoint.skillInvocations === undefined
          ? {}
          : { skillInvocations: checkpoint.skillInvocations }),
        ...(checkpoint.nativeContext === undefined
          ? {}
          : { nativeContext: checkpoint.nativeContext }),
      },
    },
  }
}

function restoreCheckpoint(projection: SessionProjectionV3): SummaryCheckpoint | undefined {
  const event = projection.checkpoint
  if (event === undefined) return undefined
  if (event.checkpoint !== undefined) {
    return {
      id: event.checkpointId,
      trust: 'low',
      messageStart: event.checkpoint.messageStart,
      messageEnd: event.checkpoint.messageEnd,
      content: event.checkpoint.content,
      digest: event.checkpoint.digest,
      estimatedTokens: event.summaryTokens,
      ...(event.checkpoint.estimatedGainTokens === undefined
        ? {}
        : { estimatedGainTokens: event.checkpoint.estimatedGainTokens }),
      createdAt: event.createdAt,
      reason: event.reason,
      summary: mutableSummary(event.summary),
      provenance: structuredClone(event.provenance),
      ...(event.checkpoint.scope === undefined ? {} : { scope: event.checkpoint.scope }),
      ...(event.checkpoint.skillInvocations === undefined
        ? {}
        : {
            skillInvocations: event.checkpoint.skillInvocations.map((invocation) => ({
              ...structuredClone(invocation),
            })),
          }),
      ...(event.checkpoint.nativeContext === undefined
        ? {}
        : { nativeContext: structuredClone(event.checkpoint.nativeContext) }),
    }
  }
  const content = renderSummary(event.summary)
  return {
    id: event.checkpointId,
    trust: 'low',
    messageStart: 0,
    messageEnd: projection.snapshot.messages.length,
    content,
    digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    estimatedTokens: event.summaryTokens,
    createdAt: event.createdAt,
    reason: event.reason,
    summary: mutableSummary(event.summary),
    provenance: structuredClone(event.provenance),
  }
}

function toRecord(projection: SessionProjectionV3): SessionRecord {
  const snapshot = projection.snapshot
  const usage = completedRunUsage(projection)
  const terminal = [...snapshot.runs].reverse().find((run) => run.state !== 'running')
  const lastTerminalState =
    terminal === undefined
      ? undefined
      : terminal.state === 'completed' || terminal.state === 'aborted'
        ? terminal.state
        : 'failed'
  return {
    recordVersion: 2,
    sessionId: snapshot.sessionId,
    state:
      snapshot.lifecycle === 'closed'
        ? 'closed'
        : snapshot.runs.some((run) => run.state === 'running')
          ? 'running'
          : 'idle',
    plannerMode: snapshot.plannerMode ?? 'auto',
    cwd: snapshot.cwd,
    provider: snapshot.provider,
    model: snapshot.model,
    ...(snapshot.contextLimitTokens === undefined
      ? {}
      : { contextLimitTokens: snapshot.contextLimitTokens }),
    createdAt: snapshot.createdAt ?? projection.catalog.updatedAt,
    updatedAt: snapshot.updatedAt ?? projection.catalog.updatedAt,
    name: snapshot.name,
    ...(snapshot.parentSessionId === undefined
      ? {}
      : { parentSessionId: snapshot.parentSessionId }),
    activeLeafId: snapshot.activeLeafId,
    labels: [...snapshot.labels],
    messageCount: snapshot.messages.length,
    usage,
    ...(lastTerminalState === undefined ? {} : { lastTerminalState }),
  }
}

function completedRunUsage(projection: SessionProjectionV3): ProviderUsage {
  const total: ProviderUsage = {}
  for (const run of projection.snapshot.runs) {
    if (run.state === 'running') continue
    for (const key of usageKeys()) {
      const value = run.usage[key]
      if (value !== undefined) total[key] = (total[key] ?? 0) + value
    }
  }
  return total
}

function usageDelta(total: ProviderUsage, previous: ProviderUsage): ProviderUsage {
  const delta: ProviderUsage = {}
  for (const key of usageKeys()) {
    const value = total[key]
    if (value !== undefined) delta[key] = Math.max(0, value - (previous[key] ?? 0))
  }
  return delta
}

function usageKeys(): readonly (keyof ProviderUsage)[] {
  return ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd']
}

function renderSummary(summary: SessionCompactionSummaryV3): string {
  return [
    summary.objective ? `Objective: ${summary.objective}` : '',
    ...(summary.relevantRefs ?? []).map((value) => `Relevant reference: ${value}`),
    ...summary.decisions.map((value) => `Decision: ${value}`),
    ...summary.constraints.map((value) => `Constraint: ${value}`),
    ...summary.readFiles.map((value) => `Read: ${value}`),
    ...summary.modifiedFiles.map((value) => `Modified: ${value}`),
    ...summary.unresolved.map((value) => `Unresolved: ${value}`),
    ...summary.activePlan.map((value) => `Plan: ${value}`),
  ]
    .filter(Boolean)
    .join('\n')
}

function mutableSummary(summary: SessionCompactionSummaryV3) {
  return {
    ...(summary.objective === undefined ? {} : { objective: summary.objective }),
    ...(summary.relevantRefs === undefined ? {} : { relevantRefs: [...summary.relevantRefs] }),
    decisions: [...summary.decisions],
    constraints: [...summary.constraints],
    readFiles: [...summary.readFiles],
    modifiedFiles: [...summary.modifiedFiles],
    unresolved: [...summary.unresolved],
    activePlan: [...summary.activePlan],
  }
}

function requireExisting(projection: SessionProjectionV3 | undefined): SessionProjectionV3 {
  if (projection === undefined || projection.snapshot.lifecycle === 'deleted') {
    throw runtimeError('SESSION_NOT_FOUND', 'protocol', 'Session not found.')
  }
  return projection
}

function requireOpen(projection: SessionProjectionV3 | undefined): SessionProjectionV3 {
  const value = requireExisting(projection)
  if (value.snapshot.lifecycle !== 'open') {
    throw runtimeError('SESSION_NOT_FOUND', 'protocol', 'Session is closed.')
  }
  return value
}

function requireOpenOrClosed(projection: SessionProjectionV3 | undefined): SessionProjectionV3 {
  return requireExisting(projection)
}

function requireRecord(record: SessionRecord | undefined): SessionRecord {
  if (record === undefined)
    throw runtimeError('SESSION_NOT_FOUND', 'protocol', 'Session not found.')
  return record
}

function monotonicTimestamp(previous: string | undefined, candidate: string): string {
  if (!canonicalInstant(candidate)) throw persistenceError('SESSION_ENTRY_INVALID')
  return previous !== undefined && candidate < previous ? previous : candidate
}

function canonicalInstant(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}

function safeTimestamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/gu, '-')
}

async function atomicCreate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'wx')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function persistenceError(code: string) {
  return runtimeError(code, 'persistence', 'Session V3 persistence operation failed.')
}
