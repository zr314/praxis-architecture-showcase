import { randomUUID } from 'node:crypto'
import {
  runtimeError,
  type SessionCommitAcceptedEventV3,
  type SessionEntryV3,
  type SessionJournalV3,
  type SessionPlanGraphProjectionV3,
} from '@praxis/core-sdk'
import type {
  SessionEvent,
  SupervisorChildProgressV1,
  SupervisorCorrelationV1,
  SupervisorJournalUpdateV1,
  SupervisorUpdateV1,
} from '@praxis/protocol'

const DEFAULT_REPLAY_EVENTS = 2_048
const MAX_REPLAY_EVENTS = 8_192
const DEFAULT_PROGRESS_BYTES = 4_096
const MAX_PROGRESS_BYTES = 4_096
const MAX_TOOL_NAME_BYTES = 1_024
const MAX_SNAPSHOTS = 128
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/

type SupervisorProtocolEvent = Extract<SessionEvent, { type: 'supervisor_update' }>
type ChildProgressEvent = Extract<
  SessionEvent,
  { type: 'thinking_delta' | 'tool_start' | 'tool_update' | 'tool_end' }
>

export type SupervisorEventProjectionOptionsV1 = Readonly<{
  epochId: string
  maxReplayEvents?: number
  maxProgressBytes?: number
  createId?: (kind: 'snapshot') => string
  emit?: (event: SupervisorProtocolEvent) => void
}>

export type SupervisorProjectionSnapshotV1 = Readonly<{
  schemaVersion: 1
  epochId: string
  snapshotId: string
  sessionId: string
  parentRunId: string
  journalSequence: number
  parentSequence: number
  plan: SessionPlanGraphProjectionV3
}>

export type SupervisorProjectionSubscriptionV1 = Readonly<{
  epochId: string
  sessionId: string
  parentRunId: string
  afterParentSequence: number
  snapshotId?: string
}>

export type ChildProgressProjectionInputV1 = Readonly<{
  parentRunId: string
  childRunId: string
  stepId: string
  event: ChildProgressEvent
}>

type Feed = {
  parentSequence: number
  replay: SupervisorUpdateV1[]
  listeners: Set<(event: SupervisorUpdateV1) => void>
  activated: boolean
}

type AttemptBinding = Readonly<{
  sessionId: string
  parentRunId: string
  planId: string
  stepId: string
  attemptId: string
  childRunId: string
}>

type SnapshotCursor = Readonly<{
  feedKey: string
  parentSequence: number
  journalSequence: number
}>

/**
 * Projects durable Supervisor journal entries and bounded child progress into one
 * parent-owned sequence. A new Runtime epoch must establish a snapshot cursor first.
 */
export class SupervisorEventProjectionV1 {
  readonly #epochId: string
  readonly #maxReplayEvents: number
  readonly #maxProgressBytes: number
  readonly #createId: (kind: 'snapshot') => string
  readonly #emit?: (event: SupervisorProtocolEvent) => void
  readonly #feeds = new Map<string, Feed>()
  readonly #attempts = new Map<string, AttemptBinding>()
  readonly #children = new Map<string, AttemptBinding>()
  readonly #snapshots = new Map<string, SnapshotCursor>()
  readonly #unsubscribeJournal: () => void

  constructor(
    private readonly journal: SessionJournalV3,
    options: SupervisorEventProjectionOptionsV1,
  ) {
    validateOptions(options)
    this.#epochId = options.epochId
    this.#maxReplayEvents = options.maxReplayEvents ?? DEFAULT_REPLAY_EVENTS
    this.#maxProgressBytes = options.maxProgressBytes ?? DEFAULT_PROGRESS_BYTES
    this.#createId = options.createId ?? (() => `snapshot-${randomUUID()}`)
    this.#emit = options.emit
    this.#unsubscribeJournal = journal.subscribe((event) => this.#accepted(event))
  }

  get epochId(): string {
    return this.#epochId
  }

  async snapshot(input: {
    sessionId: string
    parentRunId: string
    planId: string
  }): Promise<SupervisorProjectionSnapshotV1> {
    validateIdentity(input.sessionId, input.parentRunId, input.planId)
    const feedKey = key(input.sessionId, input.parentRunId)
    const feed = this.#feed(feedKey)
    const parentSequence = feed.parentSequence
    const projection = await this.journal.loadProjection(input.sessionId)
    const plan = projection.planGraph
    if (plan?.planId !== input.planId) fail('SUPERVISOR_EVENT_PLAN_NOT_FOUND')
    this.#registerProjection(input.sessionId, input.parentRunId, plan)
    const snapshotId = this.#createId('snapshot')
    if (!safeId(snapshotId) || this.#snapshots.has(snapshotId)) {
      fail('SUPERVISOR_EVENT_SNAPSHOT_ID_INVALID')
    }
    this.#snapshots.set(
      snapshotId,
      Object.freeze({
        feedKey,
        parentSequence,
        journalSequence: projection.snapshot.sequence,
      }),
    )
    while (this.#snapshots.size > MAX_SNAPSHOTS) {
      this.#snapshots.delete(this.#snapshots.keys().next().value as string)
    }
    return deepFreeze({
      schemaVersion: 1 as const,
      epochId: this.#epochId,
      snapshotId,
      sessionId: input.sessionId,
      parentRunId: input.parentRunId,
      journalSequence: projection.snapshot.sequence,
      parentSequence,
      plan,
    })
  }

  subscribe(
    input: SupervisorProjectionSubscriptionV1,
    listener: (event: SupervisorUpdateV1) => void,
  ): () => void {
    validateSubscription(input, listener)
    if (input.epochId !== this.#epochId) fail('SUPERVISOR_EVENT_SNAPSHOT_REQUIRED')
    const feedKey = key(input.sessionId, input.parentRunId)
    const feed = this.#feed(feedKey)
    let snapshotJournalSequence: number | undefined
    if (input.snapshotId !== undefined) {
      const snapshot = this.#snapshots.get(input.snapshotId)
      if (
        snapshot === undefined ||
        snapshot.feedKey !== feedKey ||
        snapshot.parentSequence !== input.afterParentSequence
      ) {
        fail('SUPERVISOR_EVENT_SNAPSHOT_REQUIRED')
      }
      snapshotJournalSequence = snapshot.journalSequence
      this.#snapshots.delete(input.snapshotId)
      feed.activated = true
    } else if (!feed.activated) {
      fail('SUPERVISOR_EVENT_SNAPSHOT_REQUIRED')
    }
    if (input.afterParentSequence > feed.parentSequence) {
      fail('SUPERVISOR_EVENT_CURSOR_INVALID')
    }
    const oldest = feed.replay[0]?.parentSequence ?? feed.parentSequence + 1
    if (input.afterParentSequence < feed.parentSequence && input.afterParentSequence < oldest - 1) {
      fail('SUPERVISOR_EVENT_REPLAY_EXPIRED')
    }
    for (const event of feed.replay) {
      if (event.parentSequence <= input.afterParentSequence) continue
      if (
        snapshotJournalSequence !== undefined &&
        event.source.kind === 'journal' &&
        event.source.journalSequence <= snapshotJournalSequence
      ) {
        continue
      }
      safelyNotify(listener, event)
    }
    feed.listeners.add(listener)
    return () => feed.listeners.delete(listener)
  }

  projectChildProgress(input: ChildProgressProjectionInputV1): SupervisorUpdateV1 {
    if (!safeId(input.parentRunId) || !safeId(input.childRunId) || !safeId(input.stepId)) {
      fail('SUPERVISOR_CHILD_PROGRESS_INVALID')
    }
    const binding = this.#children.get(childKey(input.parentRunId, input.childRunId))
    if (binding === undefined) fail('SUPERVISOR_CHILD_CORRELATION_NOT_FOUND')
    if (binding.stepId !== input.stepId) fail('SUPERVISOR_CHILD_CORRELATION_MISMATCH')
    const progress = childProgress(input.event, this.#maxProgressBytes)
    const correlation = correlationFor(binding)
    return this.#publish(binding.sessionId, binding.parentRunId, correlation, {
      kind: 'child_progress',
      progress,
    })
  }

  close(): void {
    this.#unsubscribeJournal()
    this.#feeds.clear()
    this.#attempts.clear()
    this.#children.clear()
    this.#snapshots.clear()
  }

  #accepted(event: SessionCommitAcceptedEventV3): void {
    for (const entry of event.entries) {
      try {
        this.#projectJournalEntry(entry)
      } catch {
        // Persistence is authoritative and already succeeded. A malformed observer event is dropped.
      }
    }
  }

  #projectJournalEntry(entry: SessionEntryV3): SupervisorUpdateV1 | undefined {
    const update = journalUpdate(entry)
    if (update === undefined) return undefined
    const parentRunId = entry.correlation?.parentRunId ?? entry.runId
    if (parentRunId === undefined) fail('SUPERVISOR_EVENT_CORRELATION_INCOMPLETE')
    if (entry.runId !== undefined && entry.runId !== parentRunId) {
      fail('SUPERVISOR_EVENT_CORRELATION_MISMATCH')
    }
    const planId = dataId(entry, 'planId')
    const stepId = optionalDataId(entry, 'stepId') ?? entry.correlation?.stepId
    const attemptId = optionalDataId(entry, 'attemptId') ?? entry.correlation?.attemptId
    let childRunId = optionalDataId(entry, 'childRunId') ?? entry.correlation?.childRunId
    if (attemptId !== undefined) {
      childRunId ??= this.#attempts.get(
        attemptKey(entry.sessionId, planId, stepId, attemptId),
      )?.childRunId
    }
    const verificationId = optionalDataId(entry, 'verificationId')
    const correlation = deepFreeze({
      parentRunId,
      planId,
      ...(stepId === undefined ? {} : { stepId }),
      ...(attemptId === undefined ? {} : { attemptId }),
      ...(childRunId === undefined ? {} : { childRunId }),
      ...(verificationId === undefined ? {} : { verificationId }),
    })
    assertEntryCorrelation(entry, correlation)
    if (attemptId !== undefined && stepId !== undefined && childRunId !== undefined) {
      this.#registerBinding({
        sessionId: entry.sessionId,
        parentRunId,
        planId,
        stepId,
        attemptId,
        childRunId,
      })
    }
    return this.#publish(entry.sessionId, parentRunId, correlation, {
      kind: 'journal',
      journalSequence: entry.sequence,
      revision: entry.revision,
      entryId: entry.entryId,
      update,
    })
  }

  #publish(
    sessionId: string,
    parentRunId: string,
    correlation: SupervisorCorrelationV1,
    source: SupervisorUpdateV1['source'],
  ): SupervisorUpdateV1 {
    const feed = this.#feed(key(sessionId, parentRunId))
    const event = deepFreeze({
      schemaVersion: 1 as const,
      parentSequence: ++feed.parentSequence,
      sessionId,
      correlation,
      source,
    })
    feed.replay.push(event)
    if (feed.replay.length > this.#maxReplayEvents) {
      feed.replay.splice(0, feed.replay.length - this.#maxReplayEvents)
    }
    for (const listener of feed.listeners) safelyNotify(listener, event)
    try {
      this.#emit?.({ type: 'supervisor_update', update: event })
    } catch {
      // A protocol observer cannot change the durable Journal or projection sequence.
    }
    return event
  }

  #registerProjection(
    sessionId: string,
    parentRunId: string,
    plan: SessionPlanGraphProjectionV3,
  ): void {
    for (const step of plan.steps) {
      for (const attempt of step.attempts) {
        if (attempt.childRunId === undefined) continue
        this.#registerBinding({
          sessionId,
          parentRunId,
          planId: plan.planId,
          stepId: step.stepId,
          attemptId: attempt.attemptId,
          childRunId: attempt.childRunId,
        })
      }
    }
  }

  #registerBinding(binding: AttemptBinding): void {
    const frozen = deepFreeze(binding)
    const attemptIndex = attemptKey(
      binding.sessionId,
      binding.planId,
      binding.stepId,
      binding.attemptId,
    )
    const childIndex = childKey(binding.parentRunId, binding.childRunId)
    const existingAttempt = this.#attempts.get(attemptIndex)
    const existingChild = this.#children.get(childIndex)
    if (
      (existingAttempt !== undefined && !sameBinding(existingAttempt, binding)) ||
      (existingChild !== undefined && !sameBinding(existingChild, binding))
    ) {
      fail('SUPERVISOR_EVENT_CORRELATION_CONFLICT')
    }
    this.#attempts.set(attemptIndex, frozen)
    this.#children.set(childIndex, frozen)
  }

  #feed(feedKey: string): Feed {
    let feed = this.#feeds.get(feedKey)
    if (feed === undefined) {
      feed = { parentSequence: 0, replay: [], listeners: new Set(), activated: false }
      this.#feeds.set(feedKey, feed)
    }
    return feed
  }
}

function journalUpdate(entry: SessionEntryV3): SupervisorJournalUpdateV1 | undefined {
  switch (entry.type) {
    case 'plan.created':
    case 'plan.state_changed':
      return deepFreeze({
        kind: 'plan',
        event: entry.type,
        state: entry.data.state,
        ...('objective' in entry.data && typeof entry.data.objective === 'string'
          ? { objective: entry.data.objective }
          : {}),
        ...('errorCode' in entry.data && typeof entry.data.errorCode === 'string'
          ? { errorCode: entry.data.errorCode }
          : {}),
      })
    case 'plan.revised':
      return deepFreeze({
        kind: 'plan',
        event: entry.type,
        state: entry.data.state,
        ...('objective' in entry.data && typeof entry.data.objective === 'string'
          ? { objective: entry.data.objective }
          : {}),
        ...('errorCode' in entry.data && typeof entry.data.errorCode === 'string'
          ? { errorCode: entry.data.errorCode }
          : {}),
      })
    case 'plan.decision_recorded':
      return deepFreeze({
        kind: 'planner_decision',
        event: entry.type,
        action: entry.data.action,
        outcome: entry.data.outcome,
      })
    case 'step.created':
    case 'step.state_changed':
      return deepFreeze({
        kind: 'step',
        event: entry.type,
        state: entry.data.state,
        ...('title' in entry.data && typeof entry.data.title === 'string'
          ? { title: entry.data.title }
          : {}),
        ...('order' in entry.data && typeof entry.data.order === 'number'
          ? { order: entry.data.order }
          : {}),
        ...('errorCode' in entry.data && typeof entry.data.errorCode === 'string'
          ? { errorCode: entry.data.errorCode }
          : {}),
      })
    case 'attempt.created':
    case 'attempt.state_changed':
      return deepFreeze({
        kind: 'attempt',
        event: entry.type,
        state: entry.data.state,
        ...('errorCode' in entry.data && typeof entry.data.errorCode === 'string'
          ? { errorCode: entry.data.errorCode }
          : {}),
      })
    case 'attempt.execution_completed':
      return deepFreeze({
        kind: 'execution_completed',
        event: entry.type,
        status: entry.data.status,
      })
    case 'subagent.execution_bound':
      return deepFreeze({ kind: 'subagent', event: entry.type, status: 'bound' })
    case 'subagent.result_recorded':
      return deepFreeze({ kind: 'subagent', event: entry.type, status: entry.data.status })
    case 'verification.recorded':
      return deepFreeze({
        kind: 'verification_completed',
        event: entry.type,
        verifier: entry.data.verifier,
        status: entry.data.status,
      })
    default:
      return undefined
  }
}

function childProgress(event: ChildProgressEvent, maximumBytes: number): SupervisorChildProgressV1 {
  switch (event.type) {
    case 'thinking_delta': {
      if (typeof event.text !== 'string') fail('SUPERVISOR_CHILD_PROGRESS_INVALID')
      const bounded = boundedUtf8(event.text, maximumBytes)
      return deepFreeze({ kind: 'thinking', text: bounded.value, truncated: bounded.truncated })
    }
    case 'tool_start': {
      if (!safeId(event.toolCallId) || typeof event.name !== 'string') {
        fail('SUPERVISOR_CHILD_PROGRESS_INVALID')
      }
      const name = boundedUtf8(event.name, MAX_TOOL_NAME_BYTES)
      if (name.value.length === 0) fail('SUPERVISOR_CHILD_PROGRESS_INVALID')
      return deepFreeze({
        kind: 'tool',
        phase: 'start',
        toolCallId: event.toolCallId,
        name: name.value,
      })
    }
    case 'tool_update': {
      if (
        !safeId(event.toolCallId) ||
        typeof event.message !== 'string' ||
        (event.delta !== undefined && typeof event.delta !== 'string') ||
        (event.stream !== undefined && event.stream !== 'stdout' && event.stream !== 'stderr') ||
        (event.bytes !== undefined && (!Number.isSafeInteger(event.bytes) || event.bytes < 0))
      ) {
        fail('SUPERVISOR_CHILD_PROGRESS_INVALID')
      }
      const bounded = boundedUtf8(event.message || event.delta || '', maximumBytes)
      return deepFreeze({
        kind: 'tool',
        phase: 'update',
        toolCallId: event.toolCallId,
        message: bounded.value,
        truncated: bounded.truncated,
        ...(event.stream === undefined ? {} : { stream: event.stream }),
        ...(event.bytes === undefined ? {} : { bytes: event.bytes }),
      })
    }
    case 'tool_end':
      if (!safeId(event.toolCallId) || typeof event.ok !== 'boolean') {
        fail('SUPERVISOR_CHILD_PROGRESS_INVALID')
      }
      return deepFreeze({
        kind: 'tool',
        phase: 'end',
        toolCallId: event.toolCallId,
        ok: event.ok,
      })
  }
}

function correlationFor(binding: AttemptBinding): SupervisorCorrelationV1 {
  return deepFreeze({
    parentRunId: binding.parentRunId,
    planId: binding.planId,
    stepId: binding.stepId,
    attemptId: binding.attemptId,
    childRunId: binding.childRunId,
  })
}

function assertEntryCorrelation(entry: SessionEntryV3, projected: SupervisorCorrelationV1): void {
  for (const field of ['parentRunId', 'planId', 'stepId', 'attemptId', 'childRunId'] as const) {
    const actual = entry.correlation?.[field]
    if (actual !== undefined && actual !== projected[field]) {
      fail('SUPERVISOR_EVENT_CORRELATION_MISMATCH')
    }
  }
}

function dataId(entry: SessionEntryV3, field: string): string {
  const value = (entry.data as Record<string, unknown>)[field]
  if (!safeId(value)) fail('SUPERVISOR_EVENT_CORRELATION_INCOMPLETE')
  return value
}

function optionalDataId(entry: SessionEntryV3, field: string): string | undefined {
  const value = (entry.data as Record<string, unknown>)[field]
  if (value === undefined) return undefined
  if (!safeId(value)) fail('SUPERVISOR_EVENT_CORRELATION_INCOMPLETE')
  return value
}

function boundedUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return { value, truncated: false }
  let result = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maximumBytes) break
    result += character
    bytes += characterBytes
  }
  return { value: result, truncated: true }
}

function validateOptions(options: SupervisorEventProjectionOptionsV1): void {
  if (
    typeof options !== 'object' ||
    options === null ||
    !safeId(options.epochId) ||
    !boundedInteger(options.maxReplayEvents ?? DEFAULT_REPLAY_EVENTS, 1, MAX_REPLAY_EVENTS) ||
    !boundedInteger(options.maxProgressBytes ?? DEFAULT_PROGRESS_BYTES, 64, MAX_PROGRESS_BYTES) ||
    (options.createId !== undefined && typeof options.createId !== 'function') ||
    (options.emit !== undefined && typeof options.emit !== 'function')
  ) {
    fail('SUPERVISOR_EVENT_POLICY_INVALID')
  }
}

function validateIdentity(sessionId: string, parentRunId: string, planId: string): void {
  if (!safeId(sessionId) || !safeId(parentRunId) || !safeId(planId)) {
    fail('SUPERVISOR_EVENT_INPUT_INVALID')
  }
}

function validateSubscription(
  input: SupervisorProjectionSubscriptionV1,
  listener: (event: SupervisorUpdateV1) => void,
): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    !safeId(input.epochId) ||
    !safeId(input.sessionId) ||
    !safeId(input.parentRunId) ||
    !Number.isSafeInteger(input.afterParentSequence) ||
    input.afterParentSequence < 0 ||
    (input.snapshotId !== undefined && !safeId(input.snapshotId)) ||
    typeof listener !== 'function'
  ) {
    fail('SUPERVISOR_EVENT_INPUT_INVALID')
  }
}

function sameBinding(left: AttemptBinding, right: AttemptBinding): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.parentRunId === right.parentRunId &&
    left.planId === right.planId &&
    left.stepId === right.stepId &&
    left.attemptId === right.attemptId &&
    left.childRunId === right.childRunId
  )
}

function safelyNotify(
  listener: (event: SupervisorUpdateV1) => void,
  event: SupervisorUpdateV1,
): void {
  try {
    listener(event)
  } catch {
    // Observers cannot change projection ordering or durable state.
  }
}

function key(sessionId: string, parentRunId: string): string {
  return `${sessionId}\u0000${parentRunId}`
}

function attemptKey(
  sessionId: string,
  planId: string,
  stepId: string | undefined,
  attemptId: string,
): string {
  if (stepId === undefined) fail('SUPERVISOR_EVENT_CORRELATION_INCOMPLETE')
  return `${sessionId}\u0000${planId}\u0000${stepId}\u0000${attemptId}`
}

function childKey(parentRunId: string, childRunId: string): string {
  return `${parentRunId}\u0000${childRunId}`
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function boundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function fail(code: string): never {
  throw Object.assign(new Error(code), runtimeError(code, 'planner', code), { code })
}
