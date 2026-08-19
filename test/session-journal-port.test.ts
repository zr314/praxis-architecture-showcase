import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertSessionCommitAgainstHeadV3,
  createSessionCommitV3,
  ReducingSessionJournalV3,
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
  type SessionJournalCommitStoreV3,
} from '@praxis/core-sdk'

const STEP_DEFINITION = {
  dependencies: [] as string[],
  access: { mode: 'read_only' as const, paths: ['.'] },
  capabilities: [],
  conflictKeys: [],
  criteria: [{ criterionId: 'criterion-1', kind: 'rule' as const, description: 'Fixture passes.' }],
  budget: {
    maxTurns: 1,
    maxToolCalls: 1,
    maxChildRuns: 0,
    maxParallelChildren: 0,
    maxDepth: 0,
  },
  maxAttempts: 1,
}

test('SessionCommitV3 is strict, checksummed, contiguous, and immutable', () => {
  const commit = creationCommit()
  assert.equal(commit.schemaVersion, 3)
  assert.match(commit.checksum, /^sha256:[a-f0-9]{64}$/)
  assert.equal(Object.isFrozen(commit), true)
  assert.equal(Object.isFrozen(commit.entries[0]), true)
  assert.deepEqual(validateSessionCommitV3(structuredClone(commit)), commit)

  assert.throws(
    () => validateSessionCommitV3({ ...commit, checksum: `sha256:${'0'.repeat(64)}` }),
    hasCode('SESSION_COMMIT_CHECKSUM_INVALID'),
  )
  assert.throws(
    () =>
      createSessionCommitV3({
        ...withoutChecksum(commit),
        entries: [journalEntry(2, 1, 'session.closed', {})],
      }),
    hasCode('SESSION_COMMIT_INVALID'),
  )
  assert.throws(
    () =>
      createSessionCommitV3({
        sessionId: 'session-root',
        commitId: 'commit-gap',
        expectedRevision: 1,
        idempotencyKey: 'idem-gap',
        entries: [
          journalEntry(2, 2, 'message.committed', messageData('message-2', 'two')),
          journalEntry(4, 2, 'message.committed', messageData('message-4', 'four')),
        ],
      }),
    hasCode('SESSION_COMMIT_INVALID'),
  )
})

test('the journal accepts a whole commit, reads exclusive cursors, and rebuilds stable queries', async () => {
  const store = new MemoryCommitStore()
  const journal = new ReducingSessionJournalV3(store)
  await journal.appendCommit(creationCommit())
  await journal.appendCommit(
    createSessionCommitV3({
      sessionId: 'session-root',
      commitId: 'commit-work',
      expectedRevision: 1,
      idempotencyKey: 'idem-work',
      entries: [
        journalEntry(2, 2, 'plan.created', {
          planId: 'plan-1',
          planRevision: 1,
          objective: 'Atomic journal fixture',
          state: 'running',
        }),
        journalEntry(3, 2, 'step.created', {
          planId: 'plan-1',
          planRevision: 1,
          stepId: 'step-1',
          title: 'Execute',
          order: 0,
          state: 'running',
          ...STEP_DEFINITION,
        }),
        journalEntry(4, 2, 'attempt.created', {
          planId: 'plan-1',
          planRevision: 1,
          stepId: 'step-1',
          attemptId: 'attempt-1',
          ordinal: 1,
          state: 'running',
        }),
        journalEntry(5, 2, 'run.started', { clientRequestId: 'request-1' }, { runId: 'run-1' }),
      ],
    }),
  )

  const firstPage = await journal.readEntries({
    sessionId: 'session-root',
    afterSequence: 1,
    limit: 2,
  })
  assert.deepEqual(
    firstPage.entries.map((entry) => entry.sequence),
    [2, 3],
  )
  assert.equal(firstPage.nextAfterSequence, 3)
  assert.equal(firstPage.hasMore, true)
  assert.deepEqual(firstPage.head, { revision: 2, sequence: 5 })

  const secondPage = await journal.readEntries({
    sessionId: 'session-root',
    afterSequence: firstPage.nextAfterSequence,
    limit: 2,
    throughSequence: firstPage.head.sequence,
  })
  assert.deepEqual(
    secondPage.entries.map((entry) => entry.sequence),
    [4, 5],
  )
  assert.equal(secondPage.hasMore, false)

  assert.equal((await journal.loadSnapshot('session-root')).revision, 2)
  assert.deepEqual(
    await journal.querySession({ sessionId: 'session-root', kind: 'run', runId: 'run-1' }),
    {
      kind: 'run',
      value: { runId: 'run-1', clientRequestId: 'request-1', state: 'running', usage: {} },
    },
  )
  const plan = await journal.querySession({
    sessionId: 'session-root',
    kind: 'plan',
    planId: 'plan-1',
  })
  assert.equal(plan.kind, 'plan')
  if (plan.kind === 'plan') assert.equal(plan.value.planId, 'plan-1')

  const step = await journal.querySession({
    sessionId: 'session-root',
    kind: 'step',
    planId: 'plan-1',
    stepId: 'step-1',
  })
  assert.equal(step.kind, 'step')
  if (step.kind === 'step') assert.equal(step.value.stepId, 'step-1')

  const attempt = await journal.querySession({
    sessionId: 'session-root',
    kind: 'attempt',
    planId: 'plan-1',
    stepId: 'step-1',
    attemptId: 'attempt-1',
  })
  assert.equal(attempt.kind, 'attempt')
  if (attempt.kind === 'attempt') assert.equal(attempt.value.attemptId, 'attempt-1')
  await assert.rejects(
    journal.querySession({ sessionId: 'session-root', kind: 'run', runId: 'run-missing' }),
    hasCode('SESSION_QUERY_NOT_FOUND'),
  )
})

test('commit idempotency is mandatory and conflicting reuse cannot mutate the journal', async () => {
  const store = new MemoryCommitStore()
  const journal = new ReducingSessionJournalV3(store)
  const commit = creationCommit()

  assert.equal((await journal.appendCommit(commit)).duplicate, false)
  assert.equal((await journal.appendCommit(commit)).duplicate, true)

  const conflictingKey = createSessionCommitV3({
    sessionId: 'session-root',
    commitId: 'commit-different',
    expectedRevision: 1,
    idempotencyKey: commit.idempotencyKey,
    entries: [journalEntry(2, 2, 'session.metadata_updated', { name: 'Different' })],
  })
  await assert.rejects(
    journal.appendCommit(conflictingKey),
    hasCode('SESSION_COMMIT_IDEMPOTENCY_CONFLICT'),
  )

  const conflictingCommitId = createSessionCommitV3({
    sessionId: 'session-root',
    commitId: commit.commitId,
    expectedRevision: 1,
    idempotencyKey: 'idem-different',
    entries: [journalEntry(2, 2, 'session.metadata_updated', { name: 'Different' })],
  })
  await assert.rejects(
    journal.appendCommit(conflictingCommitId),
    hasCode('SESSION_COMMIT_IDEMPOTENCY_CONFLICT'),
  )
  assert.equal((await journal.loadSnapshot('session-root')).sequence, 1)
})

test('a reducer failure rejects every entry in the logical commit', async () => {
  const journal = new ReducingSessionJournalV3(new MemoryCommitStore())
  await journal.appendCommit(creationCommit())
  const invalidAsAWhole = createSessionCommitV3({
    sessionId: 'session-root',
    commitId: 'commit-invalid-whole',
    expectedRevision: 1,
    idempotencyKey: 'idem-invalid-whole',
    entries: [
      journalEntry(2, 2, 'message.committed', messageData('message-reused', 'first')),
      journalEntry(3, 2, 'message.committed', messageData('message-reused', 'second')),
    ],
  })

  await assert.rejects(journal.appendCommit(invalidAsAWhole), hasCode('SESSION_REDUCER_ID_REUSED'))
  assert.equal((await journal.loadSnapshot('session-root')).sequence, 1)
  assert.deepEqual((await journal.loadSnapshot('session-root')).messages, [])
})

test('accepted events publish only after durable acceptance and never for rejects or duplicate retries', async () => {
  let persisted = false
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const commit = creationCommit()
  const store: SessionJournalCommitStoreV3 = {
    async appendCommit(candidate) {
      await gate
      persisted = true
      return sessionCommitReceiptV3(candidate)
    },
    async readEntries() {
      throw new Error('not used')
    },
  }
  const journal = new ReducingSessionJournalV3(store)
  const observations: string[] = []
  journal.subscribe((event) => {
    assert.equal(persisted, true)
    observations.push(event.receipt.commitId)
  })
  journal.subscribe(() => {
    throw new Error('observer failure cannot roll back persistence')
  })

  const pending = journal.appendCommit(commit)
  await Promise.resolve()
  assert.deepEqual(observations, [])
  release?.()
  assert.equal((await pending).duplicate, false)
  assert.deepEqual(observations, ['commit-create'])

  const memory = new MemoryCommitStore()
  const observed = new ReducingSessionJournalV3(memory)
  let acceptedEvents = 0
  observed.subscribe(() => {
    acceptedEvents += 1
  })
  await observed.appendCommit(commit)
  await observed.appendCommit(commit)
  await assert.rejects(
    observed.appendCommit(
      createSessionCommitV3({
        sessionId: 'session-root',
        commitId: 'commit-stale',
        expectedRevision: 0,
        idempotencyKey: 'idem-stale',
        entries: [
          journalEntry(1, 1, 'session.created', {
            cwd: 'D:/other',
            provider: 'fixture',
            model: 'fixture-model',
            name: 'Stale',
            labels: [],
          }),
        ],
      }),
    ),
    hasCode('SESSION_COMMIT_REVISION_CONFLICT'),
  )
  assert.equal(acceptedEvents, 1)
})

test('one expectedRevision CAS serializes terminal, claim, verification, and replan contenders', async (context) => {
  const contenders: Array<
    readonly [string, 'reserved' | 'verifying', (variant: 'left' | 'right') => SessionEntryV3]
  > = [
    [
      'terminal',
      'reserved',
      (variant) =>
        journalEntry(
          6,
          2,
          'run.terminal',
          { status: variant === 'left' ? 'completed' : 'failed', usage: {} },
          { runId: 'run-1', entryId: `entry-terminal-${variant}` },
        ),
    ],
    [
      'claim',
      'reserved',
      (variant) =>
        journalEntry(
          6,
          2,
          'attempt.state_changed',
          {
            planId: 'plan-1',
            planRevision: 1,
            stepId: 'step-1',
            attemptId: 'attempt-1',
            state: variant === 'left' ? 'running' : 'cancelled',
          },
          { entryId: `entry-claim-${variant}` },
        ),
    ],
    [
      'verification',
      'verifying',
      (variant) =>
        journalEntry(
          6,
          2,
          'verification.recorded',
          {
            planId: 'plan-1',
            planRevision: 1,
            stepId: 'step-1',
            attemptId: 'attempt-1',
            verificationId: `verification-${variant}`,
            verifier: 'mechanical',
            status: variant === 'left' ? 'passed' : 'failed',
            evidenceRefs: [`evidence://${variant}`],
          },
          { entryId: `entry-verification-${variant}` },
        ),
    ],
    [
      'replan',
      'reserved',
      (variant) =>
        journalEntry(
          6,
          2,
          'plan.state_changed',
          {
            planId: 'plan-1',
            planRevision: 1,
            state: variant === 'left' ? 'blocked' : 'cancelled',
          },
          { entryId: `entry-replan-${variant}` },
        ),
    ],
  ]

  for (const [name, phase, makeEntry] of contenders) {
    await context.test(name, async () => {
      const journal = new ReducingSessionJournalV3(new MemoryCommitStore())
      await journal.appendCommit(baseExecutionCommit(phase))
      const left = createSessionCommitV3({
        sessionId: 'session-root',
        commitId: `commit-${name}-left`,
        expectedRevision: 1,
        idempotencyKey: `idem-${name}-left`,
        entries: [makeEntry('left')],
      })
      const right = createSessionCommitV3({
        sessionId: 'session-root',
        commitId: `commit-${name}-right`,
        expectedRevision: 1,
        idempotencyKey: `idem-${name}-right`,
        entries: [makeEntry('right')],
      })
      const results = await Promise.allSettled([
        journal.appendCommit(left),
        journal.appendCommit(right),
      ])

      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
      const rejected = results.find((result) => result.status === 'rejected')
      assert.equal(rejected?.status, 'rejected')
      if (rejected?.status === 'rejected') {
        assert.equal(rejected.reason.code, 'SESSION_COMMIT_REVISION_CONFLICT')
      }
      assert.equal((await journal.loadSnapshot('session-root')).revision, 2)
    })
  }
})

class MemoryCommitStore implements SessionJournalCommitStoreV3 {
  readonly #sessions = new Map<
    string,
    {
      entries: SessionEntryV3[]
      commits: Map<string, SessionCommitV3>
      idempotency: Map<string, SessionCommitV3>
    }
  >()
  #writer = Promise.resolve()

  appendCommit(input: SessionCommitV3): Promise<SessionCommitReceiptV3> {
    const commit = validateSessionCommitV3(input)
    const operation = this.#writer.then(() => this.appendExclusive(commit))
    this.#writer = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  async readEntries(input: ReadSessionEntriesInputV3): Promise<SessionEntryPageV3> {
    const state = this.#sessions.get(input.sessionId)
    if (state === undefined) throw failure('SESSION_NOT_FOUND')
    const currentHead = head(state.entries)
    const through = input.throughSequence ?? currentHead.sequence
    if (through > currentHead.sequence) throw failure('SESSION_READ_INVALID')
    const after = input.afterSequence ?? 0
    const limit = input.limit ?? 512
    const entries = state.entries
      .filter((entry) => entry.sequence > after && entry.sequence <= through)
      .slice(0, limit)
      .map((entry) => structuredClone(entry))
    const nextAfterSequence = entries.at(-1)?.sequence ?? after
    return {
      sessionId: input.sessionId,
      entries,
      nextAfterSequence,
      hasMore: nextAfterSequence < through,
      head: currentHead,
    }
  }

  private appendExclusive(commit: SessionCommitV3): SessionCommitReceiptV3 {
    const state = this.#sessions.get(commit.sessionId)
    const duplicate = state?.idempotency.get(commit.idempotencyKey)
    if (duplicate !== undefined) return duplicateReceipt(duplicate, commit)
    const sameCommitId = state?.commits.get(commit.commitId)
    if (sameCommitId !== undefined) return duplicateReceipt(sameCommitId, commit)

    assertSessionCommitAgainstHeadV3(commit, state === undefined ? undefined : head(state.entries))
    const priorEntries = state?.entries ?? []
    const candidate = [...priorEntries, ...commit.entries]
    reduceSessionEntriesV3(candidate)

    const next = state ?? {
      entries: [],
      commits: new Map<string, SessionCommitV3>(),
      idempotency: new Map<string, SessionCommitV3>(),
    }
    next.entries = candidate.map((entry) => structuredClone(entry))
    next.commits.set(commit.commitId, commit)
    next.idempotency.set(commit.idempotencyKey, commit)
    this.#sessions.set(commit.sessionId, next)
    return sessionCommitReceiptV3(commit)
  }
}

function duplicateReceipt(existing: SessionCommitV3, candidate: SessionCommitV3) {
  if (existing.commitId !== candidate.commitId || existing.checksum !== candidate.checksum) {
    throw failure('SESSION_COMMIT_IDEMPOTENCY_CONFLICT')
  }
  return sessionCommitReceiptV3(existing, true)
}

function creationCommit(): SessionCommitV3 {
  return createSessionCommitV3({
    sessionId: 'session-root',
    commitId: 'commit-create',
    expectedRevision: 0,
    idempotencyKey: 'idem-create',
    entries: [
      journalEntry(1, 1, 'session.created', {
        cwd: 'D:/workspace',
        provider: 'fixture',
        model: 'fixture-model',
        name: 'Atomic journal',
        labels: [],
      }),
    ],
  })
}

function baseExecutionCommit(phase: 'reserved' | 'verifying' = 'reserved'): SessionCommitV3 {
  return createSessionCommitV3({
    sessionId: 'session-root',
    commitId: 'commit-base-execution',
    expectedRevision: 0,
    idempotencyKey: 'idem-base-execution',
    entries: [
      journalEntry(1, 1, 'session.created', {
        cwd: 'D:/workspace',
        provider: 'fixture',
        model: 'fixture-model',
        name: 'CAS fixture',
        labels: [],
      }),
      journalEntry(2, 1, 'plan.created', {
        planId: 'plan-1',
        planRevision: 1,
        objective: 'CAS fixture',
        state: 'running',
      }),
      journalEntry(3, 1, 'step.created', {
        planId: 'plan-1',
        planRevision: 1,
        stepId: 'step-1',
        title: 'Execute',
        order: 0,
        state: phase === 'verifying' ? 'verifying' : 'running',
        ...STEP_DEFINITION,
      }),
      journalEntry(4, 1, 'attempt.created', {
        planId: 'plan-1',
        planRevision: 1,
        stepId: 'step-1',
        attemptId: 'attempt-1',
        ordinal: 1,
        state: phase,
      }),
      journalEntry(5, 1, 'run.started', { clientRequestId: 'request-1' }, { runId: 'run-1' }),
    ],
  })
}

function journalEntry(
  sequence: number,
  revision: number,
  type: string,
  data: Record<string, unknown>,
  options: { runId?: string; entryId?: string } = {},
): SessionEntryV3 {
  return validateSessionEntryV3({
    schemaVersion: 3,
    entryId: options.entryId ?? `entry-${sequence}`,
    sessionId: 'session-root',
    sequence,
    revision,
    timestamp: new Date(Date.UTC(2026, 0, 2, 0, 0, sequence)).toISOString(),
    type,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    data,
  })
}

function messageData(messageId: string, content: string): Record<string, unknown> {
  return { messageId, message: { role: 'user', content } }
}

function head(entries: readonly SessionEntryV3[]) {
  const last = entries.at(-1)
  return { revision: last?.revision ?? 0, sequence: last?.sequence ?? 0 }
}

function withoutChecksum(commit: SessionCommitV3) {
  return {
    sessionId: commit.sessionId,
    commitId: commit.commitId,
    expectedRevision: commit.expectedRevision,
    idempotencyKey: commit.idempotencyKey,
    entries: commit.entries,
  }
}

function failure(code: string) {
  return runtimeError(code, 'persistence', 'Memory SessionJournal fixture rejected the operation.')
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
