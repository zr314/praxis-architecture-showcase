import { randomUUID } from 'node:crypto'
import type {
  WorkflowAuthorityPortV1,
  WorkflowProjectionV1,
  WorkflowTaskClaimV1,
} from '@praxis/core-sdk'
import { executeWorkflowAgentClaimV1, type WorkflowAgentWorkerPortV1 } from './agentDelegateTool.js'
import { WorkflowOrchestratorV1 } from './workflowOrchestrator.js'

export type DurableWorkflowWorkerServiceOptionsV1 = Readonly<{
  authority: WorkflowAuthorityPortV1
  workerId?: string
  concurrency?: number
  pollMs?: number
  worker(
    projection: WorkflowProjectionV1,
    claim: WorkflowTaskClaimV1,
  ): Promise<WorkflowAgentWorkerPortV1>
  onProjection?(projection: WorkflowProjectionV1): void
  onResult?(
    claim: WorkflowTaskClaimV1,
    result: import('./agentDelegateTool.js').WorkflowAgentWorkerResultV1,
    projection: WorkflowProjectionV1,
  ): Promise<void> | void
  onError?(
    claim: WorkflowTaskClaimV1,
    error: unknown,
    stage: 'mark_running' | 'execute' | 'complete' | 'result',
  ): Promise<void> | void
  canRun?(projection: WorkflowProjectionV1): boolean
}>

/**
 * Restart-safe agent-task pump. Authority leases remain the sole ownership
 * mechanism, so the same service can run in the Runtime process or in a remote
 * worker connected to a shared authority implementation.
 */
export class DurableWorkflowWorkerServiceV1 {
  readonly #orchestrator: WorkflowOrchestratorV1
  readonly #workerId: string
  readonly #active = new Map<
    string,
    Readonly<{
      claim: WorkflowTaskClaimV1
      worker: WorkflowAgentWorkerPortV1
      controller: AbortController
    }>
  >()
  readonly #circuits = new Map<string, Readonly<{ failures: number; openUntil: number }>>()
  #timer?: NodeJS.Timeout
  #pumping = false

  constructor(private readonly options: DurableWorkflowWorkerServiceOptionsV1) {
    this.#orchestrator = new WorkflowOrchestratorV1(options.authority)
    this.#workerId = options.workerId ?? `durable-worker-${randomUUID()}`
  }

  start(): void {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => void this.pump(), Math.max(250, this.options.pollMs ?? 1_000))
    this.#timer.unref?.()
    void this.pump()
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    for (const entry of this.#active.values()) {
      entry.controller.abort('runtime_shutdown')
      await entry.worker.cancel?.(entry.claim, 'runtime_shutdown').catch(() => undefined)
    }
    await Promise.allSettled([...this.#active.keys()].map((taskId) => this.waitFor(taskId)))
  }

  async cancelWorkflow(workflowId: string, reason = 'parent_cancelled'): Promise<void> {
    const matching = [...this.#active.values()].filter(
      ({ claim }) => claim.task.workflowId === workflowId,
    )
    for (const entry of matching) {
      entry.controller.abort(reason)
      await entry.worker.cancel?.(entry.claim, reason).catch(() => undefined)
    }
  }

  async pump(): Promise<void> {
    if (this.#pumping) return
    this.#pumping = true
    try {
      await this.options.authority.recoverExpired()
      const limit = Math.max(1, this.options.concurrency ?? 4)
      const slots = limit - this.#active.size
      if (slots <= 0) return
      let tasks = await this.options.authority.listTasks({
        states: ['ready'],
        kinds: ['agent', 'subworkflow'],
        limit: Math.max(slots * 8, 32),
      })
      // workflow.expand's foreground controller is intentionally disposable.
      // After a process restart, rebuild its frontier from persisted nodes and
      // edges before attempting to claim tasks. This releases downstream DAG
      // stages and resolves decision joins without recreating the proposal.
      const reconciled = new Set<string>()
      for (const task of tasks) {
        if (reconciled.has(task.workflowId)) continue
        reconciled.add(task.workflowId)
        const projection = await this.options.authority.get(task.workflowId)
        if (this.options.canRun?.(projection) === false) continue
        await this.#orchestrator.reconcileWorkflow(task.workflowId).catch((error: unknown) => {
          if (workerErrorCode(error) !== 'WORKFLOW_SEQUENCE_CONFLICT') throw error
        })
      }
      tasks = await this.options.authority.listTasks({
        states: ['ready'],
        kinds: ['agent', 'subworkflow'],
        limit: Math.max(slots * 8, 32),
      })
      let started = 0
      for (const task of tasks) {
        if (started >= slots) break
        const circuitKey = `${task.profileRef?.id ?? 'unknown'}@${task.profileRef?.version ?? 0}`
        if ((this.#circuits.get(circuitKey)?.openUntil ?? 0) > Date.now()) continue
        const projection = await this.options.authority.get(task.workflowId)
        if (this.options.canRun?.(projection) === false) continue
        // A recovered coordinator must not race the Child DAG it was waiting
        // on when the process died. Let durable descendants and joins settle,
        // then rerun root once with their persisted result artifacts.
        if (task.nodeId === 'root' && hasUnsettledDescendants(projection)) continue
        const claim = await this.#orchestrator
          .claimNode(task.workflowId, task.nodeId, this.#workerId)
          .catch(() => undefined)
        if (claim === undefined) continue
        let worker: WorkflowAgentWorkerPortV1
        try {
          worker = await this.options.worker(projection, claim)
        } catch {
          this.recordFailure(circuitKey)
          await this.#orchestrator
            .complete(claim, { ok: false, errorCode: 'WORKFLOW_WORKER_UNAVAILABLE' })
            .then((next) => this.options.onProjection?.(next))
            .catch(() => undefined)
          continue
        }
        const controller = new AbortController()
        this.#active.set(task.taskId, { claim, worker, controller })
        started += 1
        void this.execute(task.taskId, claim, worker, controller, circuitKey)
      }
    } finally {
      this.#pumping = false
    }
  }

  private async execute(
    taskId: string,
    claim: WorkflowTaskClaimV1,
    worker: WorkflowAgentWorkerPortV1,
    controller: AbortController,
    circuitKey: string,
  ): Promise<void> {
    let stage: 'mark_running' | 'execute' | 'complete' | 'result' = 'mark_running'
    try {
      const running = await this.#orchestrator.markRunning(claim)
      this.options.onProjection?.(running)
      stage = 'execute'
      const outcome = await executeWorkflowAgentClaimV1(
        this.#orchestrator,
        worker,
        claim,
        controller.signal,
      )
      stage = 'complete'
      const completed = await this.#orchestrator.complete(claim, {
        ok: outcome.ok,
        errorCode: outcome.errorCode,
        resultRef: outcome.artifacts?.[0],
        usage: outcome.usage,
      })
      this.options.onProjection?.(completed)
      stage = 'result'
      await this.options.onResult?.(claim, outcome, completed)
      if (outcome.ok) {
        this.#circuits.delete(circuitKey)
      } else if (outcome.retryable) {
        this.recordFailure(circuitKey)
        const retried = await this.options.authority
          .retryNode(claim.task.workflowId, claim.task.nodeId)
          .catch(() => undefined)
        if (retried !== undefined) this.options.onProjection?.(retried)
      }
    } catch (error) {
      await this.options.onError?.(claim, error, stage)
      await this.#orchestrator
        .markUnknown(claim, workerErrorCode(error))
        .then((projection) => this.options.onProjection?.(projection))
        .catch(() => undefined)
    } finally {
      this.#active.delete(taskId)
    }
  }

  private async waitFor(taskId: string): Promise<void> {
    const deadline = Date.now() + 5_000
    while (this.#active.has(taskId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  private recordFailure(key: string): void {
    const prior = this.#circuits.get(key)
    const failures = (prior?.failures ?? 0) + 1
    this.#circuits.set(
      key,
      Object.freeze({ failures, openUntil: failures >= 3 ? Date.now() + 60_000 : 0 }),
    )
  }
}

function workerErrorCode(error: unknown): string {
  return error instanceof Error && typeof Reflect.get(error, 'code') === 'string'
    ? Reflect.get(error, 'code')
    : 'WORKFLOW_WORKER_EXECUTION_INTERRUPTED'
}

function hasUnsettledDescendants(projection: WorkflowProjectionV1): boolean {
  const terminal = new Set([
    'unknown',
    'skipped',
    'succeeded',
    'failed',
    'cancelled',
    'manual_intervention',
  ])
  return projection.nodes.some(({ nodeId, state }) => nodeId !== 'root' && !terminal.has(state))
}
