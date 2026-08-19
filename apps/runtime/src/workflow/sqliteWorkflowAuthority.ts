import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  type AgentProfileV1,
  applyWorkflowEventV1,
  initialWorkflowProjectionV1,
  promptDigest,
  validateWorkflowSpecV1,
  type WorkflowAuthorityPortV1,
  type WorkflowEffectAdmissionV1,
  type WorkflowEffectReceiptV1,
  type WorkflowEffectReservationV1,
  type WorkflowEventDataV1,
  type WorkflowEventV1,
  type WorkflowHumanTaskV1,
  type WorkflowOutboxMessageV1,
  type WorkflowProjectionV1,
  type WorkflowRecoveryDecisionV1,
  type WorkflowSignalV1,
  type WorkflowSpecV1,
  type WorkflowTaskClaimV1,
  type WorkflowTaskKindV1,
  type WorkflowTaskLeaseV1,
  type WorkflowTaskV1,
  type WorkflowTimerV1,
  type WorkflowTransactionV1,
} from '@praxis/core-sdk'
import { loadNodeSqlite } from '../store/nodeSqlite.js'

const SCHEMA_VERSION = 1
const DEFAULT_LEASE_MS = 60_000
const MAX_LIST = 500

type ProjectionRow = { projection_json: string }
type EventRow = { event_json: string }
type TaskRow = { task_json: string; lease_expires_at: string | null }
type TimerRow = {
  timer_id: string
  workflow_id: string
  node_id: string
  fire_at: string
  payload_json: string
}
type HumanTaskRow = { task_json: string }
type EffectReceiptRow = { receipt_json: string }
type EffectReservationRow = { reservation_json: string }

/**
 * Single-node workflow authority. Every state change, task enqueue/ack, timer and
 * outbox write is committed under one SQLite BEGIN IMMEDIATE transaction.
 */
export class SqliteWorkflowAuthorityV1 implements WorkflowAuthorityPortV1 {
  readonly #path: string
  #database?: DatabaseSync
  #writer = Promise.resolve()

  constructor(root = process.env.PRAXIS_HOME ?? join(homedir(), '.praxis')) {
    this.#path = join(root, 'workflow-platform-v1.sqlite')
  }

  async initialize(): Promise<void> {
    if (this.#database !== undefined) return
    await mkdir(dirname(this.#path), { recursive: true })
    let Database: typeof import('node:sqlite').DatabaseSync
    try {
      ;({ DatabaseSync: Database } = await loadNodeSqlite())
    } catch {
      throw authorityError('WORKFLOW_STORE_UNAVAILABLE')
    }
    const database = new Database(this.#path)
    try {
      database.exec('PRAGMA busy_timeout=5000')
      database.exec('PRAGMA journal_mode=WAL')
      database.exec('PRAGMA synchronous=FULL')
      database.exec('PRAGMA foreign_keys=ON')
      migrate(database)
      this.#database = database
    } catch (error) {
      database.close()
      throw mapError(error)
    }
  }

  create(
    specValue: WorkflowSpecV1,
    transactionId: string,
    bootstrap: Readonly<{
      events?: readonly WorkflowEventDataV1[]
      tasks?: readonly WorkflowTaskV1[]
      outbox?: readonly WorkflowOutboxMessageV1[]
      timers?: readonly WorkflowTimerV1[]
      humanTasks?: readonly WorkflowHumanTaskV1[]
      effectReceipts?: readonly WorkflowEffectReceiptV1[]
    }> = {},
  ): Promise<WorkflowProjectionV1> {
    const spec = validateWorkflowSpecV1(specValue)
    return this.exclusive(() => {
      const database = this.database()
      database.exec('BEGIN IMMEDIATE')
      try {
        const duplicate = transactionProjection(database, transactionId)
        if (duplicate !== undefined) {
          database.exec('COMMIT')
          return duplicate
        }
        if (
          database.prepare('SELECT 1 FROM workflows WHERE workflow_id = ?').get(spec.workflowId)
        ) {
          throw authorityError('WORKFLOW_ALREADY_EXISTS')
        }
        let projection = initialWorkflowProjectionV1(spec)
        const events = envelopeEvents(
          spec,
          projection.sequence,
          transactionId,
          [
            { type: 'workflow.created', spec },
            { type: 'workflow.started' },
            ...(bootstrap.events ?? []),
          ],
          spec.createdAt,
        )
        for (const event of events) projection = applyWorkflowEventV1(projection, event)
        database
          .prepare(
            `INSERT INTO workflows (workflow_id, run_id, session_id, revision, sequence, state, projection_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            spec.workflowId,
            spec.runId,
            spec.sessionId,
            projection.revision,
            projection.sequence,
            projection.state,
            JSON.stringify(projection),
            spec.createdAt,
            projection.updatedAt,
          )
        insertEvents(database, events)
        for (const task of bootstrap.tasks ?? []) insertTask(database, task)
        for (const message of bootstrap.outbox ?? []) insertOutbox(database, message)
        for (const timer of bootstrap.timers ?? []) insertTimer(database, timer)
        for (const humanTask of bootstrap.humanTasks ?? []) insertHumanTask(database, humanTask)
        for (const receipt of bootstrap.effectReceipts ?? []) insertEffectReceipt(database, receipt)
        recordTransaction(database, transactionId, projection)
        database.exec('COMMIT')
        return projection
      } catch (error) {
        rollback(database)
        throw mapError(error)
      }
    })
  }

  transact(input: WorkflowTransactionV1): Promise<WorkflowProjectionV1> {
    return this.exclusive(() => this.transactExclusive(input))
  }

  async get(workflowId: string): Promise<WorkflowProjectionV1> {
    const row = this.database()
      .prepare('SELECT projection_json FROM workflows WHERE workflow_id = ?')
      .get(workflowId) as ProjectionRow | undefined
    if (row === undefined) throw authorityError('WORKFLOW_NOT_FOUND')
    return parseProjection(row.projection_json)
  }

  async events(workflowId: string, afterSequence = 0): Promise<readonly WorkflowEventV1[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw authorityError('WORKFLOW_READ_INVALID')
    const rows = this.database()
      .prepare(
        'SELECT event_json FROM workflow_events WHERE workflow_id = ? AND sequence > ? ORDER BY sequence',
      )
      .all(workflowId, afterSequence) as EventRow[]
    if (
      rows.length === 0 &&
      !this.database().prepare('SELECT 1 FROM workflows WHERE workflow_id = ?').get(workflowId)
    )
      throw authorityError('WORKFLOW_NOT_FOUND')
    return rows.map(({ event_json }) =>
      parseJson<WorkflowEventV1>(event_json, 'WORKFLOW_EVENT_CORRUPT'),
    )
  }

  async list(
    options: Readonly<{ sessionId?: string; states?: readonly string[]; limit?: number }> = {},
  ): Promise<readonly WorkflowProjectionV1[]> {
    const limit = Math.min(MAX_LIST, Math.max(1, options.limit ?? 100))
    const rows = this.database()
      .prepare(
        `SELECT projection_json FROM workflows
       WHERE (? IS NULL OR session_id = ?)
         AND (? IS NULL OR state IN (SELECT value FROM json_each(?)))
       ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(
        options.sessionId ?? null,
        options.sessionId ?? null,
        options.states === undefined ? null : JSON.stringify(options.states),
        options.states === undefined ? null : JSON.stringify(options.states),
        limit,
      ) as ProjectionRow[]
    const states = options.states === undefined ? undefined : new Set(options.states)
    return rows
      .map(({ projection_json }) => parseProjection(projection_json))
      .filter(({ state }) => states?.has(state) ?? true)
  }

  async listTasks(
    options: Readonly<{
      workflowId?: string
      states?: readonly WorkflowTaskV1['state'][]
      kinds?: readonly WorkflowTaskKindV1[]
      limit?: number
    }> = {},
  ): Promise<readonly WorkflowTaskV1[]> {
    const limit = Math.min(MAX_LIST, Math.max(1, options.limit ?? 100))
    const rows = this.database()
      .prepare(
        `SELECT t.task_json, t.lease_expires_at FROM workflow_tasks t
         LEFT JOIN workflow_scheduler_fairness f ON f.workflow_id = t.workflow_id
         WHERE (? IS NULL OR t.workflow_id = ?)
           AND (? IS NULL OR t.state IN (SELECT value FROM json_each(?)))
           AND (? IS NULL OR t.kind IN (SELECT value FROM json_each(?)))
         ORDER BY COALESCE(f.last_claimed_at, ''), t.priority DESC, t.ready_at, t.task_id LIMIT ?`,
      )
      .all(
        options.workflowId ?? null,
        options.workflowId ?? null,
        options.states === undefined ? null : JSON.stringify(options.states),
        options.states === undefined ? null : JSON.stringify(options.states),
        options.kinds === undefined ? null : JSON.stringify(options.kinds),
        options.kinds === undefined ? null : JSON.stringify(options.kinds),
        limit,
      ) as TaskRow[]
    const states = options.states === undefined ? undefined : new Set(options.states)
    const kinds = options.kinds === undefined ? undefined : new Set(options.kinds)
    return rows
      .map(({ task_json }) => parseTask(task_json))
      .filter((task) => (states?.has(task.state) ?? true) && (kinds?.has(task.kind) ?? true))
  }

  bindTaskCapabilityBundle(
    taskId: string,
    leaseToken: string,
    ref: import('@praxis/core-sdk').VersionedWorkflowRefV1,
    at = new Date().toISOString(),
  ): Promise<WorkflowTaskV1> {
    if (
      !safeId(taskId) ||
      !safeId(leaseToken) ||
      !safeId(ref.id) ||
      ref.version !== 1 ||
      ref.digest === undefined ||
      !/^sha256:[a-f0-9]{64}$/u.test(ref.digest) ||
      !timestamp(at)
    )
      return Promise.reject(authorityError('WORKFLOW_EXECUTION_SNAPSHOT_INVALID'))
    const snapshotDigest = ref.digest
    return this.exclusive(() => {
      const database = this.database()
      database.exec('BEGIN IMMEDIATE')
      try {
        const row = database
          .prepare('SELECT task_json, lease_expires_at FROM workflow_tasks WHERE task_id = ?')
          .get(taskId) as TaskRow | undefined
        if (row === undefined) throw authorityError('WORKFLOW_TASK_NOT_FOUND')
        const task = parseTask(row.task_json)
        if (task.state !== 'leased' || task.lease?.token !== leaseToken)
          throw authorityError('WORKFLOW_LEASE_LOST')
        if (
          task.capabilityBundleRef !== undefined &&
          JSON.stringify(task.capabilityBundleRef) !== JSON.stringify(ref)
        )
          throw authorityError('WORKFLOW_EXECUTION_SNAPSHOT_CONFLICT')
        const updated = Object.freeze({
          ...task,
          capabilityBundleRef: Object.freeze({ ...ref }),
          updatedAt: at,
        })
        database
          .prepare('UPDATE workflow_tasks SET task_json = ?, updated_at = ? WHERE task_id = ?')
          .run(JSON.stringify(updated), at, taskId)
        this.appendInternalEvents(
          database,
          task.workflowId,
          `execution-snapshot-${task.taskId}-${task.attemptId}`,
          at,
          [
            {
              type: 'execution.snapshot_bound',
              nodeId: task.nodeId,
              attemptId: task.attemptId,
              snapshotRef: {
                artifactId: ref.id,
                digest: snapshotDigest,
                mediaType: 'application/vnd.praxis.workflow-execution-snapshot+json',
              },
            },
          ],
        )
        database.exec('COMMIT')
        return updated
      } catch (error) {
        rollback(database)
        throw mapError(error)
      }
    })
  }

  claim(
    workerId: string,
    options: Readonly<{
      workflowId?: string
      nodeId?: string
      kinds?: readonly WorkflowTaskKindV1[]
      leaseMs?: number
      now?: string
    }> = {},
  ): Promise<WorkflowTaskClaimV1 | undefined> {
    if (!safeId(workerId)) return Promise.reject(authorityError('WORKFLOW_WORKER_INVALID'))
    const now = options.now ?? new Date().toISOString()
    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    if (!timestamp(now) || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000)
      return Promise.reject(authorityError('WORKFLOW_LEASE_INVALID'))
    return this.exclusive(() => {
      const database = this.database()
      database.exec('BEGIN IMMEDIATE')
      try {
        const candidates = database
          .prepare(
            `SELECT t.task_json, t.lease_expires_at FROM workflow_tasks t
           JOIN workflows w ON w.workflow_id = t.workflow_id
           LEFT JOIN workflow_scheduler_fairness f ON f.workflow_id = t.workflow_id
           WHERE t.state = 'ready' AND t.ready_at <= ? AND w.state = 'running'
           ORDER BY priority DESC, COALESCE(f.last_claimed_at, ''), ready_at ASC, task_id ASC LIMIT 100`,
          )
          .all(now) as TaskRow[]
        const kinds = options.kinds === undefined ? undefined : new Set(options.kinds)
        const active = database
          .prepare(
            `SELECT task_json, lease_expires_at FROM workflow_tasks
           WHERE state = 'leased' AND lease_expires_at > ?`,
          )
          .all(now) as TaskRow[]
        const occupied = new Set(active.flatMap((row) => parseTask(row.task_json).conflictKeys))
        const task = candidates
          .map((row) => parseTask(row.task_json))
          .find((candidate) => {
            if (
              (options.workflowId !== undefined && candidate.workflowId !== options.workflowId) ||
              (options.nodeId !== undefined && candidate.nodeId !== options.nodeId) ||
              !(kinds?.has(candidate.kind) ?? true) ||
              !candidate.conflictKeys.every((key) => !occupied.has(key))
            )
              return false
            const projection = loadProjection(database, candidate.workflowId)
            return (
              projection.nodes.find(({ nodeId }) => nodeId === candidate.nodeId)?.state ===
              'scheduled'
            )
          })
        if (task === undefined) {
          database.exec('COMMIT')
          return undefined
        }
        const lease: WorkflowTaskLeaseV1 = Object.freeze({
          token: `lease-${randomUUID()}`,
          workerId,
          acquiredAt: now,
          expiresAt: new Date(Date.parse(now) + leaseMs).toISOString(),
          lastHeartbeatAt: now,
          lastProgressAt: now,
        })
        const leased: WorkflowTaskV1 = Object.freeze({
          ...task,
          state: 'leased',
          lease,
          updatedAt: now,
        })
        database
          .prepare(
            `UPDATE workflow_tasks SET state = 'leased', task_json = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
           WHERE task_id = ? AND state = 'ready'`,
          )
          .run(JSON.stringify(leased), lease.token, lease.expiresAt, now, task.taskId)
        database
          .prepare(
            `INSERT INTO workflow_scheduler_fairness (workflow_id, last_claimed_at)
             VALUES (?, ?) ON CONFLICT(workflow_id) DO UPDATE SET last_claimed_at = excluded.last_claimed_at`,
          )
          .run(task.workflowId, now)
        this.appendInternalEvents(
          database,
          task.workflowId,
          `claim-${task.taskId}-${lease.token}`,
          now,
          [
            { type: 'node.state_changed', nodeId: task.nodeId, state: 'leased' },
            {
              type: 'attempt.state_changed',
              attemptId: task.attemptId,
              state: 'leased',
              leaseToken: lease.token,
              workerId,
              at: now,
            },
          ],
        )
        database.exec('COMMIT')
        return Object.freeze({ task: leased, lease })
      } catch (error) {
        rollback(database)
        throw mapError(error)
      }
    })
  }

  heartbeat(
    taskId: string,
    leaseToken: string,
    progress: boolean,
    now = new Date().toISOString(),
  ): Promise<WorkflowTaskLeaseV1> {
    return this.exclusive(() => {
      const database = this.database()
      database.exec('BEGIN IMMEDIATE')
      try {
        const row = database
          .prepare('SELECT task_json, lease_expires_at FROM workflow_tasks WHERE task_id = ?')
          .get(taskId) as TaskRow | undefined
        if (row === undefined) throw authorityError('WORKFLOW_TASK_NOT_FOUND')
        const task = parseTask(row.task_json)
        if (
          task.state !== 'leased' ||
          task.lease?.token !== leaseToken ||
          Date.parse(task.lease.expiresAt) <= Date.parse(now)
        )
          throw authorityError('WORKFLOW_LEASE_LOST')
        const lease: WorkflowTaskLeaseV1 = Object.freeze({
          ...task.lease,
          lastHeartbeatAt: now,
          lastProgressAt: progress ? now : task.lease.lastProgressAt,
          expiresAt: new Date(
            Date.parse(now) + Math.max(1_000, task.timeout.heartbeatMs * 3),
          ).toISOString(),
        })
        const updated = { ...task, lease, updatedAt: now }
        database
          .prepare(
            'UPDATE workflow_tasks SET task_json = ?, lease_expires_at = ?, updated_at = ? WHERE task_id = ?',
          )
          .run(JSON.stringify(updated), lease.expiresAt, now, taskId)
        database.exec('COMMIT')
        return lease
      } catch (error) {
        rollback(database)
        throw mapError(error)
      }
    })
  }

  recoverExpired(now = new Date().toISOString()): Promise<readonly WorkflowRecoveryDecisionV1[]> {
    return this.exclusive(() => {
      const database = this.database()
      database.exec('BEGIN IMMEDIATE')
      try {
        const rows = database
          .prepare(
            `SELECT task_json, lease_expires_at FROM workflow_tasks
           WHERE state = 'leased' AND lease_expires_at <= ? ORDER BY lease_expires_at`,
          )
          .all(now) as TaskRow[]
        const decisions: WorkflowRecoveryDecisionV1[] = []
        for (const row of rows) {
          const task = parseTask(row.task_json)
          const safe = ['pure', 'read', 'external_idempotent'].includes(task.effect.class)
          const projection = loadProjection(database, task.workflowId)
          const oldAttempt = projection.attempts.find(
            ({ attemptId }) => attemptId === task.attemptId,
          )
          if (oldAttempt === undefined) throw authorityError('WORKFLOW_ATTEMPT_NOT_FOUND')
          if (['cancelled', 'completed', 'failed', 'terminated'].includes(projection.state)) {
            const cancelled: WorkflowTaskV1 = Object.freeze({
              ...task,
              state: 'cancelled',
              lease: undefined,
              updatedAt: now,
            })
            database
              .prepare(
                `UPDATE workflow_tasks SET state = 'cancelled', lease_token = NULL, lease_expires_at = NULL, updated_at = ?, task_json = ? WHERE task_id = ?`,
              )
              .run(now, JSON.stringify(cancelled), task.taskId)
            const node = projection.nodes.find(({ nodeId }) => nodeId === task.nodeId)
            this.appendInternalEvents(
              database,
              task.workflowId,
              `recover-terminal-${task.taskId}-${projection.sequence}`,
              now,
              [
                ...(['succeeded', 'failed', 'cancelled', 'unknown'].includes(oldAttempt.state)
                  ? []
                  : [
                      {
                        type: 'attempt.state_changed' as const,
                        attemptId: task.attemptId,
                        state: 'cancelled' as const,
                        at: now,
                        errorCode: 'WORKFLOW_PARENT_TERMINAL',
                      },
                    ]),
                ...(node === undefined ||
                ['succeeded', 'failed', 'cancelled', 'skipped', 'unknown'].includes(node.state)
                  ? []
                  : [
                      {
                        type: 'node.state_changed' as const,
                        nodeId: task.nodeId,
                        state: 'cancelled' as const,
                        errorCode: 'WORKFLOW_PARENT_TERMINAL',
                      },
                    ]),
              ],
            )
            continue
          }
          const mayRetry = safe && oldAttempt.ordinal < task.retry.maxAttempts
          const decision: WorkflowRecoveryDecisionV1 = Object.freeze({
            taskId: task.taskId,
            attemptId: task.attemptId,
            priorState: oldAttempt.state,
            decision: mayRetry ? 'retry' : safe ? 'manual_intervention' : 'unknown',
            code: mayRetry
              ? 'LEASE_EXPIRED_RETRYABLE'
              : safe
                ? 'LEASE_EXPIRED_ATTEMPTS_EXHAUSTED'
                : 'LEASE_EXPIRED_EFFECT_UNKNOWN',
          })
          decisions.push(decision)
          const terminalTaskState = mayRetry ? 'failed' : safe ? 'failed' : 'unknown'
          database
            .prepare(
              `UPDATE workflow_tasks SET state = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?, task_json = ? WHERE task_id = ?`,
            )
            .run(
              terminalTaskState,
              now,
              JSON.stringify({
                ...task,
                state: terminalTaskState,
                lease: undefined,
                updatedAt: now,
              }),
              task.taskId,
            )
          const baseEvents: WorkflowEventDataV1[] = [
            {
              type: 'attempt.state_changed',
              attemptId: task.attemptId,
              state: 'unknown',
              at: now,
              errorCode: decision.code,
            },
            {
              type: 'node.state_changed',
              nodeId: task.nodeId,
              state: 'unknown',
              errorCode: decision.code,
            },
          ]
          if (mayRetry) {
            const attemptId = `attempt-${randomUUID()}`
            const retryTaskId = `task-${randomUUID()}`
            const retryAt = new Date(
              Date.parse(now) + backoffMs(task, oldAttempt.ordinal),
            ).toISOString()
            const retryTask: WorkflowTaskV1 = Object.freeze({
              ...task,
              taskId: retryTaskId,
              attemptId,
              state: 'ready',
              lease: undefined,
              capabilityBundleRef: undefined,
              readyAt: retryAt,
              createdAt: now,
              updatedAt: now,
            })
            baseEvents.push(
              {
                type: 'attempt.state_changed',
                attemptId: task.attemptId,
                state: 'failed',
                at: now,
                errorCode: decision.code,
              },
              {
                type: 'node.state_changed',
                nodeId: task.nodeId,
                state: 'failed',
                errorCode: decision.code,
              },
              {
                type: 'node.state_changed',
                nodeId: task.nodeId,
                state: 'retry_wait',
                errorCode: decision.code,
              },
              {
                type: 'attempt.created',
                attempt: {
                  attemptId,
                  nodeId: task.nodeId,
                  ordinal: oldAttempt.ordinal + 1,
                  state: 'scheduled',
                },
              },
              { type: 'node.state_changed', nodeId: task.nodeId, state: 'scheduled' },
            )
            insertTask(database, retryTask)
            if (
              task.effect.class === 'external_idempotent' &&
              task.effect.idempotencyKey !== undefined
            ) {
              releaseEffectReservation(
                database,
                task.workflowId,
                task.effect.idempotencyKey,
                task.attemptId,
                now,
              )
            }
          } else if (safe) {
            baseEvents.push(
              {
                type: 'attempt.state_changed',
                attemptId: task.attemptId,
                state: 'manual_intervention',
                at: now,
                errorCode: decision.code,
              },
              {
                type: 'node.state_changed',
                nodeId: task.nodeId,
                state: 'manual_intervention',
                errorCode: decision.code,
              },
            )
          }
          this.appendInternalEvents(
            database,
            task.workflowId,
            `recover-${task.taskId}-${randomUUID()}`,
            now,
            baseEvents,
          )
        }
        database.exec('COMMIT')
        return decisions
      } catch (error) {
        rollback(database)
        throw mapError(error)
      }
    })
  }

  signal(input: WorkflowSignalV1): Promise<boolean> {
    if (
      !safeId(input.signalId) ||
      !safeId(input.workflowId) ||
      !safeId(input.name) ||
      !timestamp(input.receivedAt)
    )
      return Promise.reject(authorityError('WORKFLOW_SIGNAL_INVALID'))
    return this.exclusive(() => {
      const database = this.database()
      database.exec('BEGIN IMMEDIATE')
      try {
        const projection = loadProjection(database, input.workflowId)
        const result = database
          .prepare(
            `INSERT OR IGNORE INTO workflow_signals (workflow_id, signal_id, name, payload_json, received_at)
         VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            input.workflowId,
            input.signalId,
            input.name,
            JSON.stringify(input.payload),
            input.receivedAt,
          )
        if (result.changes === 0) {
          database.exec('COMMIT')
          return false
        }
        this.appendInternalEvents(
          database,
          input.workflowId,
          `signal-${input.signalId}`,
          input.receivedAt,
          [
            { type: 'signal.received', signalId: input.signalId, name: input.name },
            ...(projection.state === 'waiting' ? [{ type: 'workflow.resumed' as const }] : []),
          ],
        )
        database.exec('COMMIT')
        return true
      } catch (error) {
        rollback(database)
        throw mapError(error)
      }
    })
  }

  fireDueTimers(now = new Date().toISOString()): Promise<readonly WorkflowTimerV1[]> {
    if (!timestamp(now)) return Promise.reject(authorityError('WORKFLOW_TIMER_INVALID'))
    return this.exclusive(() => {
      const database = this.database()
      database.exec('BEGIN IMMEDIATE')
      try {
        const rows = database
          .prepare(
            `SELECT timer_id, workflow_id, node_id, fire_at, payload_json
             FROM workflow_timers WHERE fired_at IS NULL AND fire_at <= ? ORDER BY fire_at, timer_id`,
          )
          .all(now) as TimerRow[]
        const fired: WorkflowTimerV1[] = []
        for (const row of rows) {
          const changed = database
            .prepare(
              'UPDATE workflow_timers SET fired_at = ? WHERE timer_id = ? AND fired_at IS NULL',
            )
            .run(now, row.timer_id)
          if (changed.changes !== 1) continue
          const timer: WorkflowTimerV1 = Object.freeze({
            timerId: row.timer_id,
            workflowId: row.workflow_id,
            nodeId: row.node_id,
            fireAt: row.fire_at,
            payload: parseJson<Readonly<Record<string, unknown>>>(
              row.payload_json,
              'WORKFLOW_TIMER_CORRUPT',
            ),
          })
          fired.push(timer)
          const projection = loadProjection(database, timer.workflowId)
          const node = projection.nodes.find(({ nodeId }) => nodeId === timer.nodeId)
          const spec = projection.spec.nodes.find(({ nodeId }) => nodeId === timer.nodeId)
          const attemptId = node?.attemptIds.at(-1)
          this.appendInternalEvents(database, timer.workflowId, `timer-${timer.timerId}`, now, [
            { type: 'timer.fired', timerId: timer.timerId, nodeId: timer.nodeId },
            ...(node?.state === 'waiting' && spec?.kind === 'timer' && attemptId !== undefined
              ? [
                  {
                    type: 'attempt.state_changed' as const,
                    attemptId,
                    state: 'succeeded' as const,
                    at: now,
                  },
                  {
                    type: 'node.state_changed' as const,
                    nodeId: timer.nodeId,
                    state: 'succeeded' as const,
                  },
                ]
              : []),
            ...(projection.state === 'waiting' ? [{ type: 'workflow.resumed' as const }] : []),
          ])
        }
        database.exec('COMMIT')
        return fired
      } catch (error) {
        rollback(database)
        throw mapError(error)
      }
    })
  }

  async listHumanTasks(
    workflowId: string,
    states?: readonly WorkflowHumanTaskV1['state'][],
  ): Promise<readonly WorkflowHumanTaskV1[]> {
    if (!safeId(workflowId)) throw authorityError('WORKFLOW_HUMAN_TASK_INVALID')
    const rows = this.database()
      .prepare(
        'SELECT task_json FROM workflow_human_tasks WHERE workflow_id = ? ORDER BY human_task_id',
      )
      .all(workflowId) as HumanTaskRow[]
    const allowed = states === undefined ? undefined : new Set(states)
    return rows
      .map(({ task_json }) =>
        parseJson<WorkflowHumanTaskV1>(task_json, 'WORKFLOW_HUMAN_TASK_CORRUPT'),
      )
      .filter(({ state }) => allowed?.has(state) ?? true)
  }

  async expireDueHumanTasks(
    now = new Date().toISOString(),
  ): Promise<readonly WorkflowHumanTaskV1[]> {
    if (!timestamp(now)) throw authorityError('WORKFLOW_HUMAN_TASK_INVALID')
    const rows = this.database()
      .prepare(
        `SELECT task_json FROM workflow_human_tasks
         WHERE state = 'waiting' AND expires_at IS NOT NULL AND expires_at <= ?
         ORDER BY expires_at, human_task_id`,
      )
      .all(now) as HumanTaskRow[]
    const expired: WorkflowHumanTaskV1[] = []
    for (const { task_json } of rows) {
      const task = parseJson<WorkflowHumanTaskV1>(task_json, 'WORKFLOW_HUMAN_TASK_CORRUPT')
      expired.push(
        await this.resolveHumanTask(task.humanTaskId, 'expired', { reason: 'deadline' }, now),
      )
    }
    return expired
  }

  async getEffectReceipt(
    workflowId: string,
    idempotencyKey: string,
  ): Promise<WorkflowEffectReceiptV1 | undefined> {
    if (!safeId(workflowId) || !safeId(idempotencyKey))
      throw authorityError('WORKFLOW_EFFECT_RECEIPT_INVALID')
    const row = this.database()
      .prepare(
        'SELECT receipt_json FROM workflow_effect_receipts WHERE workflow_id = ? AND idempotency_key = ?',
      )
      .get(workflowId, idempotencyKey) as EffectReceiptRow | undefined
    return row === undefined
      ? undefined
      : parseJson<WorkflowEffectReceiptV1>(row.receipt_json, 'WORKFLOW_EFFECT_RECEIPT_CORRUPT')
  }

  async listEffectReceipts(workflowId: string): Promise<readonly WorkflowEffectReceiptV1[]> {
    if (!safeId(workflowId)) throw authorityError('WORKFLOW_EFFECT_RECEIPT_INVALID')
    return (
      this.database()
        .prepare(
          'SELECT receipt_json FROM workflow_effect_receipts WHERE workflow_id = ? ORDER BY created_at, receipt_id',
        )
        .all(workflowId) as EffectReceiptRow[]
    ).map(({ receipt_json }) =>
      parseJson<WorkflowEffectReceiptV1>(receipt_json, 'WORKFLOW_EFFECT_RECEIPT_CORRUPT'),
    )
  }

  reserveEffect(
    workflowId: string,
    idempotencyKey: string,
    inputDigest: `sha256:${string}`,
    attemptId: string,
    leaseExpiresAt: string,
    at = new Date().toISOString(),
  ): Promise<WorkflowEffectAdmissionV1> {
    if (
      !safeId(workflowId) ||
      !safeId(idempotencyKey) ||
      !safeId(attemptId) ||
      !/^sha256:[a-f0-9]{64}$/u.test(inputDigest) ||
      !timestamp(leaseExpiresAt) ||
      !timestamp(at)
    )
      return Promise.reject(authorityError('WORKFLOW_EFFECT_RESERVATION_INVALID'))
    return this.exclusive(() => {
      const database = this.database()
      database.exec('BEGIN IMMEDIATE')
      try {
        const row = database
          .prepare(
            'SELECT reservation_json FROM workflow_effect_reservations WHERE workflow_id = ? AND idempotency_key = ?',
          )
          .get(workflowId, idempotencyKey) as EffectReservationRow | undefined
        if (row !== undefined) {
          const prior = parseJson<WorkflowEffectReservationV1>(
            row.reservation_json,
            'WORKFLOW_EFFECT_RESERVATION_CORRUPT',
          )
          const decision =
            prior.inputDigest !== inputDigest
              ? 'conflict'
              : prior.state === 'committed'
                ? 'replay'
                : prior.state === 'released'
                  ? 'execute'
                  : 'in_progress'
          if (decision === 'execute') {
            const renewed: WorkflowEffectReservationV1 = Object.freeze({
              ...prior,
              attemptId,
              state: 'reserved',
              leaseExpiresAt,
              receiptRef: undefined,
              updatedAt: at,
            })
            database
              .prepare(
                `UPDATE workflow_effect_reservations
                 SET attempt_id = ?, state = 'reserved', lease_expires_at = ?, reservation_json = ?, updated_at = ?
                 WHERE workflow_id = ? AND idempotency_key = ?`,
              )
              .run(
                attemptId,
                leaseExpiresAt,
                JSON.stringify(renewed),
                at,
                workflowId,
                idempotencyKey,
              )
            const task = taskForAttempt(database, workflowId, attemptId)
            this.appendInternalEvents(database, workflowId, `effect-reserved-${attemptId}`, at, [
              {
                type: 'effect.reserved',
                nodeId: task.nodeId,
                attemptId,
                idempotencyKey,
                inputDigest,
              },
            ])
            database.exec('COMMIT')
            return Object.freeze({ decision, reservation: renewed })
          }
          if (decision === 'replay') {
            const task = taskForAttempt(database, workflowId, attemptId)
            this.appendInternalEvents(database, workflowId, `effect-replayed-${attemptId}`, at, [
              {
                type: 'effect.replayed',
                nodeId: task.nodeId,
                attemptId,
                idempotencyKey,
              },
            ])
          }
          database.exec('COMMIT')
          return Object.freeze({ decision, reservation: prior })
        }
        const reservation: WorkflowEffectReservationV1 = Object.freeze({
          workflowId,
          idempotencyKey,
          inputDigest,
          attemptId,
          state: 'reserved',
          leaseExpiresAt,
          updatedAt: at,
        })
        database
          .prepare(
            `INSERT INTO workflow_effect_reservations
             (workflow_id, idempotency_key, input_digest, attempt_id, state, lease_expires_at, reservation_json, updated_at)
             VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?)`,
          )
          .run(
            workflowId,
            idempotencyKey,
            inputDigest,
            attemptId,
            leaseExpiresAt,
            JSON.stringify(reservation),
            at,
          )
        const task = taskForAttempt(database, workflowId, attemptId)
        this.appendInternalEvents(database, workflowId, `effect-reserved-${attemptId}`, at, [
          {
            type: 'effect.reserved',
            nodeId: task.nodeId,
            attemptId,
            idempotencyKey,
            inputDigest,
          },
        ])
        database.exec('COMMIT')
        return Object.freeze({ decision: 'execute' as const, reservation })
      } catch (error) {
        rollback(database)
        throw mapError(error)
      }
    })
  }

  markEffectCompensated(
    workflowId: string,
    sourceReceiptArtifactId: string,
    compensationReceiptArtifactId: string,
    at = new Date().toISOString(),
  ): Promise<WorkflowEffectReceiptV1> {
    if (
      !safeId(workflowId) ||
      !safeId(sourceReceiptArtifactId) ||
      !safeId(compensationReceiptArtifactId) ||
      sourceReceiptArtifactId === compensationReceiptArtifactId ||
      !timestamp(at)
    )
      return Promise.reject(authorityError('WORKFLOW_COMPENSATION_INVALID'))
    return this.exclusive(() => {
      const database = this.database()
      database.exec('BEGIN IMMEDIATE')
      try {
        const rows = database
          .prepare(
            `SELECT receipt_json FROM workflow_effect_receipts
             WHERE workflow_id = ? AND json_extract(receipt_json, '$.artifactRef.artifactId') IN (?, ?)`,
          )
          .all(
            workflowId,
            sourceReceiptArtifactId,
            compensationReceiptArtifactId,
          ) as EffectReceiptRow[]
        const receipts = rows.map(({ receipt_json }) =>
          parseJson<WorkflowEffectReceiptV1>(receipt_json, 'WORKFLOW_EFFECT_RECEIPT_CORRUPT'),
        )
        const source = receipts.find(
          ({ artifactRef }) => artifactRef.artifactId === sourceReceiptArtifactId,
        )
        const compensation = receipts.find(
          ({ artifactRef }) => artifactRef.artifactId === compensationReceiptArtifactId,
        )
        if (
          source === undefined ||
          compensation === undefined ||
          compensation.state !== 'committed'
        )
          throw authorityError('WORKFLOW_COMPENSATION_RECEIPT_NOT_FOUND')
        if (source.state === 'compensated') {
          if (source.compensationReceiptRef?.artifactId !== compensationReceiptArtifactId)
            throw authorityError('WORKFLOW_COMPENSATION_CONFLICT')
          database.exec('COMMIT')
          return source
        }
        const updated: WorkflowEffectReceiptV1 = Object.freeze({
          ...source,
          state: 'compensated',
          compensatedAt: at,
          compensationReceiptRef: compensation.artifactRef,
        })
        database
          .prepare(
            `UPDATE workflow_effect_receipts
             SET state = 'compensated', receipt_json = ?, compensated_at = ?
             WHERE receipt_id = ? AND state = 'committed'`,
          )
          .run(JSON.stringify(updated), at, source.receiptId)
        this.appendInternalEvents(
          database,
          workflowId,
          `compensate-${source.receiptId}-${compensation.receiptId}`,
          at,
          [
            {
              type: 'effect.compensated',
              receiptId: source.receiptId,
              compensationReceiptId: compensation.receiptId,
              nodeId: source.nodeId,
            },
          ],
        )
        database.exec('COMMIT')
        return updated
      } catch (error) {
        rollback(database)
        throw mapError(error)
      }
    })
  }

  resolveHumanTask(
    humanTaskId: string,
    state: Exclude<WorkflowHumanTaskV1['state'], 'waiting'>,
    resolution: Readonly<Record<string, unknown>> = {},
    at = new Date().toISOString(),
  ): Promise<WorkflowHumanTaskV1> {
    if (
      !safeId(humanTaskId) ||
      !timestamp(at) ||
      !['allowed', 'denied', 'expired', 'cancelled'].includes(state)
    )
      return Promise.reject(authorityError('WORKFLOW_HUMAN_TASK_INVALID'))
    return this.exclusive(() => {
      const database = this.database()
      database.exec('BEGIN IMMEDIATE')
      try {
        const row = database
          .prepare('SELECT task_json FROM workflow_human_tasks WHERE human_task_id = ?')
          .get(humanTaskId) as HumanTaskRow | undefined
        if (row === undefined) throw authorityError('WORKFLOW_HUMAN_TASK_NOT_FOUND')
        const task = parseJson<WorkflowHumanTaskV1>(row.task_json, 'WORKFLOW_HUMAN_TASK_CORRUPT')
        if (task.state !== 'waiting') {
          database.exec('COMMIT')
          return task
        }
        const resolved: WorkflowHumanTaskV1 = Object.freeze({
          ...task,
          state,
          resolution,
        })
        database
          .prepare(
            'UPDATE workflow_human_tasks SET state = ?, task_json = ? WHERE human_task_id = ? AND state = ?',
          )
          .run(state, JSON.stringify(resolved), humanTaskId, 'waiting')
        const projection = loadProjection(database, task.workflowId)
        const node = projection.nodes.find(({ nodeId }) => nodeId === task.nodeId)
        const spec = projection.spec.nodes.find(({ nodeId }) => nodeId === task.nodeId)
        const attemptId = node?.attemptIds.at(-1)
        const terminal: 'succeeded' | 'cancelled' | 'failed' =
          state === 'allowed' ? 'succeeded' : state === 'cancelled' ? 'cancelled' : 'failed'
        this.appendInternalEvents(database, task.workflowId, `human-${humanTaskId}-${state}`, at, [
          { type: 'human_task.resolved', humanTaskId, nodeId: task.nodeId, state },
          ...(node?.state === 'waiting' && spec?.kind === 'human_task' && attemptId !== undefined
            ? [
                {
                  type: 'attempt.state_changed' as const,
                  attemptId,
                  state: terminal,
                  at,
                  ...(state === 'allowed'
                    ? {}
                    : { errorCode: `WORKFLOW_HUMAN_TASK_${state.toUpperCase()}` }),
                },
                {
                  type: 'node.state_changed' as const,
                  nodeId: task.nodeId,
                  state: terminal,
                  ...(state === 'allowed'
                    ? {}
                    : { errorCode: `WORKFLOW_HUMAN_TASK_${state.toUpperCase()}` }),
                },
              ]
            : []),
          ...(projection.state === 'waiting' ? [{ type: 'workflow.resumed' as const }] : []),
        ])
        database.exec('COMMIT')
        return resolved
      } catch (error) {
        rollback(database)
        throw mapError(error)
      }
    })
  }

  retryNode(
    workflowId: string,
    nodeId: string,
    at = new Date().toISOString(),
  ): Promise<WorkflowProjectionV1> {
    if (!safeId(workflowId) || !safeId(nodeId) || !timestamp(at))
      return Promise.reject(authorityError('WORKFLOW_RETRY_INVALID'))
    return this.exclusive(() => {
      const database = this.database()
      database.exec('BEGIN IMMEDIATE')
      try {
        const projection = loadProjection(database, workflowId)
        const node = projection.nodes.find((candidate) => candidate.nodeId === nodeId)
        const attempt = projection.attempts.find(
          (candidate) => candidate.attemptId === node?.attemptIds.at(-1),
        )
        if (node?.state !== 'failed' || attempt?.state !== 'failed')
          throw authorityError('WORKFLOW_RETRY_INVALID_STATE')
        const row = database
          .prepare(
            `SELECT task_json, lease_expires_at FROM workflow_tasks
             WHERE workflow_id = ? AND node_id = ? ORDER BY created_at DESC LIMIT 1`,
          )
          .get(workflowId, nodeId) as TaskRow | undefined
        if (row === undefined) throw authorityError('WORKFLOW_TASK_NOT_FOUND')
        const prior = parseTask(row.task_json)
        if (attempt.ordinal >= prior.retry.maxAttempts)
          throw authorityError('WORKFLOW_RETRY_EXHAUSTED')
        const attemptId = `attempt-${randomUUID()}`
        const task: WorkflowTaskV1 = Object.freeze({
          ...prior,
          taskId: `task-${randomUUID()}`,
          attemptId,
          state: 'ready',
          lease: undefined,
          capabilityBundleRef: undefined,
          readyAt: at,
          createdAt: at,
          updatedAt: at,
        })
        this.appendInternalEvents(database, workflowId, `retry-${task.taskId}`, at, [
          { type: 'node.state_changed', nodeId, state: 'retry_wait' },
          {
            type: 'attempt.created',
            attempt: {
              attemptId,
              nodeId,
              ordinal: attempt.ordinal + 1,
              state: 'scheduled',
            },
          },
          { type: 'node.state_changed', nodeId, state: 'scheduled' },
        ])
        insertTask(database, task)
        database.exec('COMMIT')
        return loadProjection(database, workflowId)
      } catch (error) {
        rollback(database)
        throw mapError(error)
      }
    })
  }

  async resolveUnknown(
    workflowId: string,
    nodeId: string,
    resolution: 'succeeded' | 'failed' | 'manual_intervention',
    code?: string,
    at = new Date().toISOString(),
  ): Promise<WorkflowProjectionV1> {
    if (
      !safeId(workflowId) ||
      !safeId(nodeId) ||
      !timestamp(at) ||
      !['succeeded', 'failed', 'manual_intervention'].includes(resolution)
    )
      throw authorityError('WORKFLOW_RESOLUTION_INVALID')
    const projection = await this.get(workflowId)
    const node = projection.nodes.find((candidate) => candidate.nodeId === nodeId)
    const attempt = projection.attempts.find(
      (candidate) => candidate.attemptId === node?.attemptIds.at(-1),
    )
    if (node?.state !== 'unknown' || attempt?.state !== 'unknown')
      throw authorityError('WORKFLOW_RESOLUTION_INVALID_STATE')
    const task = (await this.listTasks({ workflowId, states: ['unknown'], limit: MAX_LIST })).find(
      (candidate) => candidate.attemptId === attempt.attemptId,
    )
    if (
      resolution === 'succeeded' &&
      task?.effect.idempotencyKey !== undefined &&
      attempt.receiptRef === undefined
    )
      throw authorityError('WORKFLOW_EFFECT_RECEIPT_REQUIRED')
    return this.transact({
      transactionId: `resolve-${workflowId}-${nodeId}-${projection.sequence}`,
      workflowId,
      expectedSequence: projection.sequence,
      occurredAt: at,
      events: [
        {
          type: 'attempt.state_changed',
          attemptId: attempt.attemptId,
          state: resolution,
          at,
          errorCode: code,
        },
        { type: 'node.state_changed', nodeId, state: resolution, errorCode: code },
      ],
      ...(resolution === 'failed' && task?.effect.idempotencyKey !== undefined
        ? {
            effectReservationTerminal: {
              idempotencyKey: task.effect.idempotencyKey,
              attemptId: task.attemptId,
              state: 'released' as const,
            },
          }
        : {}),
    })
  }

  registerProfile(profile: AgentProfileV1): Promise<void> {
    if (
      !safeId(profile.profileId) ||
      !Number.isSafeInteger(profile.version) ||
      profile.version < 1 ||
      !/^sha256:[a-f0-9]{64}$/u.test(profile.digest) ||
      profileDigest(profile) !== profile.digest
    )
      return Promise.reject(authorityError('AGENT_PROFILE_INVALID'))
    return this.exclusive(() => {
      const database = this.database()
      const existing = database
        .prepare('SELECT profile_json FROM agent_profiles WHERE profile_id = ? AND version = ?')
        .get(profile.profileId, profile.version) as { profile_json: string } | undefined
      if (existing !== undefined) {
        const prior = parseJson<AgentProfileV1>(existing.profile_json, 'AGENT_PROFILE_CORRUPT')
        if (prior.digest !== profile.digest || JSON.stringify(prior) !== JSON.stringify(profile))
          throw authorityError('AGENT_PROFILE_VERSION_CONFLICT')
        return
      }
      database
        .prepare(
          'INSERT INTO agent_profiles (profile_id, version, profile_json, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(profile.profileId, profile.version, JSON.stringify(profile), new Date().toISOString())
    })
  }

  async getProfile(profileId: string, version?: number): Promise<AgentProfileV1> {
    const row =
      version === undefined
        ? this.database()
            .prepare(
              'SELECT profile_json FROM agent_profiles WHERE profile_id = ? ORDER BY version DESC LIMIT 1',
            )
            .get(profileId)
        : this.database()
            .prepare('SELECT profile_json FROM agent_profiles WHERE profile_id = ? AND version = ?')
            .get(profileId, version)
    if (row === undefined) throw authorityError('AGENT_PROFILE_NOT_FOUND')
    const profile = parseJson<AgentProfileV1>(
      (row as { profile_json: string }).profile_json,
      'AGENT_PROFILE_CORRUPT',
    )
    if (!/^sha256:[a-f0-9]{64}$/u.test(profile.digest) || profileDigest(profile) !== profile.digest)
      throw authorityError('AGENT_PROFILE_CORRUPT')
    return profile
  }

  async listProfiles(): Promise<readonly AgentProfileV1[]> {
    const rows = this.database()
      .prepare(
        `SELECT profile_json FROM agent_profiles p
       WHERE version = (SELECT MAX(version) FROM agent_profiles WHERE profile_id = p.profile_id)
       ORDER BY profile_id`,
      )
      .all() as Array<{ profile_json: string }>
    return rows.map(({ profile_json }) => {
      const profile = parseJson<AgentProfileV1>(profile_json, 'AGENT_PROFILE_CORRUPT')
      if (
        !/^sha256:[a-f0-9]{64}$/u.test(profile.digest) ||
        profileDigest(profile) !== profile.digest
      )
        throw authorityError('AGENT_PROFILE_CORRUPT')
      return profile
    })
  }

  close(): void {
    this.#database?.close()
    this.#database = undefined
  }

  private transactExclusive(input: WorkflowTransactionV1): WorkflowProjectionV1 {
    if (
      !safeId(input.transactionId) ||
      !safeId(input.workflowId) ||
      !Number.isSafeInteger(input.expectedSequence) ||
      input.expectedSequence < 0 ||
      !timestamp(input.occurredAt)
    )
      throw authorityError('WORKFLOW_TRANSACTION_INVALID')
    const database = this.database()
    database.exec('BEGIN IMMEDIATE')
    try {
      const duplicate = transactionProjection(database, input.transactionId)
      if (duplicate !== undefined) {
        database.exec('COMMIT')
        return duplicate
      }
      let projection = loadProjection(database, input.workflowId)
      if (projection.sequence !== input.expectedSequence)
        throw authorityError('WORKFLOW_SEQUENCE_CONFLICT')
      const events = envelopeEvents(
        projection.spec,
        projection.sequence,
        input.transactionId,
        input.events,
        input.occurredAt,
      )
      for (const event of events) projection = applyWorkflowEventV1(projection, event)
      insertEvents(database, events)
      for (const task of input.enqueueTasks ?? []) insertTask(database, task)
      for (const message of input.outbox ?? []) insertOutbox(database, message)
      for (const timer of input.timers ?? []) insertTimer(database, timer)
      for (const humanTask of input.humanTasks ?? []) insertHumanTask(database, humanTask)
      for (const receipt of input.effectReceipts ?? []) insertEffectReceipt(database, receipt)
      if (input.effectReservationTerminal !== undefined) {
        const terminal = input.effectReservationTerminal
        const row = database
          .prepare(
            'SELECT reservation_json FROM workflow_effect_reservations WHERE workflow_id = ? AND idempotency_key = ?',
          )
          .get(input.workflowId, terminal.idempotencyKey) as EffectReservationRow | undefined
        if (row === undefined) throw authorityError('WORKFLOW_EFFECT_RESERVATION_NOT_FOUND')
        const reservation = parseJson<WorkflowEffectReservationV1>(
          row.reservation_json,
          'WORKFLOW_EFFECT_RESERVATION_CORRUPT',
        )
        if (reservation.attemptId !== terminal.attemptId)
          throw authorityError('WORKFLOW_EFFECT_RESERVATION_OWNER_MISMATCH')
        const updated: WorkflowEffectReservationV1 = Object.freeze({
          ...reservation,
          state: terminal.state,
          ...(terminal.receiptRef === undefined ? {} : { receiptRef: terminal.receiptRef }),
          updatedAt: input.occurredAt,
        })
        database
          .prepare(
            `UPDATE workflow_effect_reservations SET state = ?, reservation_json = ?, updated_at = ?
             WHERE workflow_id = ? AND idempotency_key = ?`,
          )
          .run(
            terminal.state,
            JSON.stringify(updated),
            input.occurredAt,
            input.workflowId,
            terminal.idempotencyKey,
          )
      }
      if (input.acknowledgeTask !== undefined)
        acknowledgeTask(database, input.acknowledgeTask, input.occurredAt)
      for (const taskId of input.cancelReadyTasks ?? []) {
        cancelReadyTask(database, input.workflowId, taskId, input.occurredAt)
      }
      saveProjection(database, projection)
      recordTransaction(database, input.transactionId, projection)
      database.exec('COMMIT')
      return projection
    } catch (error) {
      rollback(database)
      throw mapError(error)
    }
  }

  private appendInternalEvents(
    database: DatabaseSync,
    workflowId: string,
    transactionId: string,
    at: string,
    data: readonly WorkflowEventDataV1[],
  ): WorkflowProjectionV1 {
    let projection = loadProjection(database, workflowId)
    const events = envelopeEvents(projection.spec, projection.sequence, transactionId, data, at)
    for (const event of events) projection = applyWorkflowEventV1(projection, event)
    insertEvents(database, events)
    saveProjection(database, projection)
    recordTransaction(database, transactionId, projection)
    return projection
  }

  private database(): DatabaseSync {
    if (this.#database === undefined) throw authorityError('WORKFLOW_STORE_NOT_INITIALIZED')
    return this.#database
  }

  private exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.#writer.then(operation)
    this.#writer = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_schema (version INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO workflow_schema(version) VALUES (${SCHEMA_VERSION});
    CREATE TABLE IF NOT EXISTS workflows (
      workflow_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT NOT NULL,
      revision INTEGER NOT NULL, sequence INTEGER NOT NULL, state TEXT NOT NULL,
      projection_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflows_session_updated ON workflows(session_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS workflow_events (
      workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, event_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL, PRIMARY KEY(workflow_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS workflow_transactions (
      transaction_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL,
      projection_json TEXT NOT NULL, committed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_tasks (
      task_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id) ON DELETE CASCADE,
      node_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, state TEXT NOT NULL,
      priority INTEGER NOT NULL, ready_at TEXT NOT NULL, deadline_at TEXT NOT NULL,
      lease_token TEXT, lease_expires_at TEXT, task_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workflow_tasks_ready ON workflow_tasks(state, ready_at, priority DESC);
    CREATE TABLE IF NOT EXISTS workflow_scheduler_fairness (
      workflow_id TEXT PRIMARY KEY REFERENCES workflows(workflow_id) ON DELETE CASCADE,
      last_claimed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_outbox (
      message_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, topic TEXT NOT NULL,
      message_key TEXT NOT NULL, payload_json TEXT NOT NULL, available_at TEXT NOT NULL,
      published_at TEXT, UNIQUE(topic, message_key)
    );
    CREATE TABLE IF NOT EXISTS workflow_timers (
      timer_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, node_id TEXT NOT NULL,
      fire_at TEXT NOT NULL, payload_json TEXT NOT NULL, fired_at TEXT
    );
    CREATE INDEX IF NOT EXISTS workflow_timers_ready ON workflow_timers(fired_at, fire_at);
    CREATE TABLE IF NOT EXISTS workflow_signals (
      workflow_id TEXT NOT NULL, signal_id TEXT NOT NULL, name TEXT NOT NULL,
      payload_json TEXT NOT NULL, received_at TEXT NOT NULL,
      PRIMARY KEY(workflow_id, signal_id)
    );
    CREATE TABLE IF NOT EXISTS workflow_human_tasks (
      human_task_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, node_id TEXT NOT NULL,
      state TEXT NOT NULL, task_json TEXT NOT NULL, expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS workflow_effect_receipts (
      receipt_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, node_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL, effect_class TEXT NOT NULL, idempotency_key TEXT,
      state TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL,
      compensated_at TEXT, UNIQUE(workflow_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS workflow_effect_receipts_workflow
      ON workflow_effect_receipts(workflow_id, created_at);
    CREATE TABLE IF NOT EXISTS workflow_effect_reservations (
      workflow_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_digest TEXT NOT NULL,
      attempt_id TEXT NOT NULL, state TEXT NOT NULL, lease_expires_at TEXT NOT NULL,
      reservation_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(workflow_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS agent_profiles (
      profile_id TEXT NOT NULL, version INTEGER NOT NULL, profile_json TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(profile_id, version)
    );
  `)
  const versions = database.prepare('SELECT version FROM workflow_schema').all() as Array<{
    version: number
  }>
  if (versions.length !== 1 || Number(versions[0]?.version) !== SCHEMA_VERSION)
    throw authorityError('WORKFLOW_SCHEMA_UNSUPPORTED')
}

function envelopeEvents(
  spec: WorkflowSpecV1,
  after: number,
  transactionId: string,
  data: readonly WorkflowEventDataV1[],
  occurredAt: string,
): WorkflowEventV1[] {
  return data.map((entry, index) =>
    Object.freeze({
      schemaVersion: 1 as const,
      eventId: `${transactionId}:${after + index + 1}`,
      workflowId: spec.workflowId,
      runId: spec.runId,
      sequence: after + index + 1,
      occurredAt,
      causationId: transactionId,
      data: entry,
    }),
  )
}

function insertEvents(database: DatabaseSync, events: readonly WorkflowEventV1[]): void {
  const statement = database.prepare(
    'INSERT INTO workflow_events (workflow_id, sequence, event_id, event_json, occurred_at) VALUES (?, ?, ?, ?, ?)',
  )
  for (const event of events)
    statement.run(
      event.workflowId,
      event.sequence,
      event.eventId,
      JSON.stringify(event),
      event.occurredAt,
    )
}

function insertTask(database: DatabaseSync, task: WorkflowTaskV1): void {
  if (
    !safeId(task.taskId) ||
    !safeId(task.workflowId) ||
    !safeId(task.nodeId) ||
    !safeId(task.attemptId) ||
    task.schemaVersion !== 1 ||
    task.state !== 'ready'
  )
    throw authorityError('WORKFLOW_TASK_INVALID')
  database
    .prepare(
      `INSERT INTO workflow_tasks (task_id, workflow_id, node_id, attempt_id, kind, state, priority, ready_at, deadline_at, lease_token, lease_expires_at, task_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    )
    .run(
      task.taskId,
      task.workflowId,
      task.nodeId,
      task.attemptId,
      task.kind,
      task.state,
      task.priority,
      task.readyAt,
      task.deadlineAt,
      JSON.stringify(task),
      task.createdAt,
      task.updatedAt,
    )
}

function acknowledgeTask(
  database: DatabaseSync,
  ack: NonNullable<WorkflowTransactionV1['acknowledgeTask']>,
  at: string,
): void {
  const row = database
    .prepare('SELECT task_json, lease_expires_at FROM workflow_tasks WHERE task_id = ?')
    .get(ack.taskId) as TaskRow | undefined
  if (row === undefined) throw authorityError('WORKFLOW_TASK_NOT_FOUND')
  const task = parseTask(row.task_json)
  if (task.state !== 'leased' || task.lease?.token !== ack.leaseToken)
    throw authorityError('WORKFLOW_LEASE_LOST')
  const updated: WorkflowTaskV1 = Object.freeze({
    ...task,
    state: ack.state,
    lease: undefined,
    updatedAt: at,
  })
  database
    .prepare(
      'UPDATE workflow_tasks SET state = ?, lease_token = NULL, lease_expires_at = NULL, task_json = ?, updated_at = ? WHERE task_id = ?',
    )
    .run(ack.state, JSON.stringify(updated), at, ack.taskId)
}

function cancelReadyTask(
  database: DatabaseSync,
  workflowId: string,
  taskId: string,
  at: string,
): void {
  if (!safeId(taskId)) throw authorityError('WORKFLOW_TASK_INVALID')
  const row = database
    .prepare('SELECT task_json, lease_expires_at FROM workflow_tasks WHERE task_id = ?')
    .get(taskId) as TaskRow | undefined
  if (row === undefined) throw authorityError('WORKFLOW_TASK_NOT_FOUND')
  const task = parseTask(row.task_json)
  if (task.workflowId !== workflowId || task.state !== 'ready') {
    throw authorityError('WORKFLOW_TASK_CANCEL_INVALID_STATE')
  }
  const updated: WorkflowTaskV1 = Object.freeze({
    ...task,
    state: 'cancelled',
    lease: undefined,
    updatedAt: at,
  })
  database
    .prepare(
      'UPDATE workflow_tasks SET state = ?, lease_token = NULL, lease_expires_at = NULL, task_json = ?, updated_at = ? WHERE task_id = ?',
    )
    .run('cancelled', JSON.stringify(updated), at, taskId)
}

function insertOutbox(database: DatabaseSync, message: WorkflowOutboxMessageV1): void {
  database
    .prepare(
      'INSERT INTO workflow_outbox (message_id, workflow_id, topic, message_key, payload_json, available_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      message.messageId,
      message.workflowId,
      message.topic,
      message.key,
      JSON.stringify(message.payload),
      message.availableAt,
    )
}

function insertTimer(database: DatabaseSync, timer: WorkflowTimerV1): void {
  database
    .prepare(
      'INSERT INTO workflow_timers (timer_id, workflow_id, node_id, fire_at, payload_json) VALUES (?, ?, ?, ?, ?)',
    )
    .run(timer.timerId, timer.workflowId, timer.nodeId, timer.fireAt, JSON.stringify(timer.payload))
}

function insertHumanTask(database: DatabaseSync, task: WorkflowHumanTaskV1): void {
  database
    .prepare(
      'INSERT INTO workflow_human_tasks (human_task_id, workflow_id, node_id, state, task_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      task.humanTaskId,
      task.workflowId,
      task.nodeId,
      task.state,
      JSON.stringify(task),
      task.expiresAt ?? null,
    )
}

function insertEffectReceipt(database: DatabaseSync, receipt: WorkflowEffectReceiptV1): void {
  if (
    !safeId(receipt.receiptId) ||
    !safeId(receipt.workflowId) ||
    !safeId(receipt.nodeId) ||
    !safeId(receipt.attemptId) ||
    !['external_idempotent', 'external_non_idempotent'].includes(receipt.effectClass) ||
    (receipt.idempotencyKey !== undefined && !safeId(receipt.idempotencyKey)) ||
    !timestamp(receipt.createdAt)
  )
    throw authorityError('WORKFLOW_EFFECT_RECEIPT_INVALID')
  if (receipt.idempotencyKey !== undefined) {
    const existing = database
      .prepare(
        'SELECT receipt_json FROM workflow_effect_receipts WHERE workflow_id = ? AND idempotency_key = ?',
      )
      .get(receipt.workflowId, receipt.idempotencyKey) as EffectReceiptRow | undefined
    if (existing !== undefined) {
      const prior = parseJson<WorkflowEffectReceiptV1>(
        existing.receipt_json,
        'WORKFLOW_EFFECT_RECEIPT_CORRUPT',
      )
      if (
        prior.effectClass !== receipt.effectClass ||
        prior.artifactRef.digest !== receipt.artifactRef.digest
      )
        throw authorityError('WORKFLOW_EFFECT_IDEMPOTENCY_CONFLICT')
      return
    }
  }
  database
    .prepare(
      `INSERT INTO workflow_effect_receipts
       (receipt_id, workflow_id, node_id, attempt_id, effect_class, idempotency_key, state, receipt_json, created_at, compensated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      receipt.receiptId,
      receipt.workflowId,
      receipt.nodeId,
      receipt.attemptId,
      receipt.effectClass,
      receipt.idempotencyKey ?? null,
      receipt.state,
      JSON.stringify(receipt),
      receipt.createdAt,
      receipt.compensatedAt ?? null,
    )
}

function taskForAttempt(
  database: DatabaseSync,
  workflowId: string,
  attemptId: string,
): WorkflowTaskV1 {
  const row = database
    .prepare(
      'SELECT task_json, lease_expires_at FROM workflow_tasks WHERE workflow_id = ? AND attempt_id = ?',
    )
    .get(workflowId, attemptId) as TaskRow | undefined
  if (row === undefined) throw authorityError('WORKFLOW_TASK_NOT_FOUND')
  return parseTask(row.task_json)
}

function releaseEffectReservation(
  database: DatabaseSync,
  workflowId: string,
  idempotencyKey: string,
  attemptId: string,
  at: string,
): void {
  const row = database
    .prepare(
      'SELECT reservation_json FROM workflow_effect_reservations WHERE workflow_id = ? AND idempotency_key = ?',
    )
    .get(workflowId, idempotencyKey) as EffectReservationRow | undefined
  if (row === undefined) return
  const reservation = parseJson<WorkflowEffectReservationV1>(
    row.reservation_json,
    'WORKFLOW_EFFECT_RESERVATION_CORRUPT',
  )
  if (reservation.attemptId !== attemptId || reservation.state !== 'reserved') return
  const updated: WorkflowEffectReservationV1 = Object.freeze({
    ...reservation,
    state: 'released',
    updatedAt: at,
  })
  database
    .prepare(
      `UPDATE workflow_effect_reservations SET state = 'released', reservation_json = ?, updated_at = ?
       WHERE workflow_id = ? AND idempotency_key = ?`,
    )
    .run(JSON.stringify(updated), at, workflowId, idempotencyKey)
}

function saveProjection(database: DatabaseSync, projection: WorkflowProjectionV1): void {
  database
    .prepare(
      `UPDATE workflows SET revision = ?, sequence = ?, state = ?, projection_json = ?, updated_at = ? WHERE workflow_id = ?`,
    )
    .run(
      projection.revision,
      projection.sequence,
      projection.state,
      JSON.stringify(projection),
      projection.updatedAt,
      projection.workflowId,
    )
}

function loadProjection(database: DatabaseSync, workflowId: string): WorkflowProjectionV1 {
  const row = database
    .prepare('SELECT projection_json FROM workflows WHERE workflow_id = ?')
    .get(workflowId) as ProjectionRow | undefined
  if (row === undefined) throw authorityError('WORKFLOW_NOT_FOUND')
  return parseProjection(row.projection_json)
}

function transactionProjection(
  database: DatabaseSync,
  transactionId: string,
): WorkflowProjectionV1 | undefined {
  const row = database
    .prepare('SELECT projection_json FROM workflow_transactions WHERE transaction_id = ?')
    .get(transactionId) as ProjectionRow | undefined
  return row === undefined ? undefined : parseProjection(row.projection_json)
}

function recordTransaction(
  database: DatabaseSync,
  transactionId: string,
  projection: WorkflowProjectionV1,
): void {
  database
    .prepare(
      'INSERT INTO workflow_transactions (transaction_id, workflow_id, projection_json, committed_at) VALUES (?, ?, ?, ?)',
    )
    .run(transactionId, projection.workflowId, JSON.stringify(projection), projection.updatedAt)
}

function parseProjection(value: string): WorkflowProjectionV1 {
  const parsed = parseJson<WorkflowProjectionV1>(value, 'WORKFLOW_PROJECTION_CORRUPT')
  if (
    parsed.schemaVersion !== 1 ||
    !safeId(parsed.workflowId) ||
    !Array.isArray(parsed.nodes) ||
    !Array.isArray(parsed.attempts)
  )
    throw authorityError('WORKFLOW_PROJECTION_CORRUPT')
  return Object.freeze(parsed)
}

function parseTask(value: string): WorkflowTaskV1 {
  const parsed = parseJson<WorkflowTaskV1>(value, 'WORKFLOW_TASK_CORRUPT')
  if (parsed.schemaVersion !== 1 || !safeId(parsed.taskId) || !safeId(parsed.workflowId))
    throw authorityError('WORKFLOW_TASK_CORRUPT')
  return Object.freeze(parsed)
}

function parseJson<T>(value: string, code: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw authorityError(code)
  }
}

function backoffMs(task: WorkflowTaskV1, ordinal: number): number {
  return Math.min(
    task.retry.maxBackoffMs,
    task.retry.initialBackoffMs * 2 ** Math.max(0, ordinal - 1),
  )
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    /* original error wins */
  }
}
function profileDigest(profile: AgentProfileV1): `sha256:${string}` {
  const { digest: _digest, ...semantic } = profile
  return promptDigest(JSON.stringify(semantic))
}
function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(value)
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}
function authorityError(code: string): Error {
  return Object.assign(new Error(`Workflow authority failed (${code}).`), {
    code,
    category: 'persistence',
    retryable: ['WORKFLOW_SEQUENCE_CONFLICT', 'WORKFLOW_LEASE_LOST'].includes(code),
  })
}
function mapError(error: unknown): Error {
  if (error instanceof Error && 'code' in error) {
    const code = String(error.code)
    if (code.startsWith('WORKFLOW_') || code.startsWith('MODE_')) return error
  }
  const code =
    error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message)
      ? 'WORKFLOW_STORE_BUSY'
      : 'WORKFLOW_PERSISTENCE_FAILED'
  return authorityError(code)
}
