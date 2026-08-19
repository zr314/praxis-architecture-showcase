import {
  clampChildBudget,
  runtimeError,
  type BudgetUsage,
  type CancellationReason,
  type ExecutionBudget,
} from '@praxis/core-sdk'

export type SubagentParentUsage = Readonly<
  Pick<
    BudgetUsage,
    | 'turns'
    | 'toolCalls'
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheReadTokens'
    | 'cacheWriteTokens'
    | 'costUsd'
  >
>

export type SubagentAdmission = Readonly<{
  /** Absolute ancestry depth. The top-level parent Run is depth zero. */
  depth: number
  /** Descendant levels delegated to this child after attenuation. */
  remainingDepth: number
}>

export type PreparedSubagent = Readonly<{
  parentRunId: string
  childRunId: string
  budget: Readonly<ExecutionBudget>
  admission: SubagentAdmission
  cancellation: SubagentCancellationPort
  ledger: SubagentAdmissionLedger
  reservationId: string
}>

export type RootSubagentScope = Readonly<{
  runId: string
  budget: ExecutionBudget
  usage?: SubagentParentUsage
  chargedChildRuns?: number
}>

export type SubagentReservationState =
  | 'slot_reserved'
  | 'execution_accepted'
  | 'terminal'
  | 'released'

export type SubagentUsageDisposition = 'reported' | 'conservative_unknown'

export type SubagentReservation = Readonly<{
  reservationId: string
  parentRunId: string
  childRunId: string
  childBudget: Readonly<ExecutionBudget>
  admission: SubagentAdmission
  ancestorRunIds: readonly string[]
  state: SubagentReservationState
  terminalUsage?: Readonly<BudgetUsage>
  usageDisposition?: SubagentUsageDisposition
}>

export type SubagentAdmissionEvent =
  | Readonly<{
      type: 'child_admission_slot_reserved'
      reservationId: string
      parentRunId: string
      childRunId: string
      depth: number
    }>
  | Readonly<{
      type: 'child_execution_accepted_and_charged'
      reservationId: string
      parentRunId: string
      childRunId: string
      depth: number
    }>
  | Readonly<{
      type: 'child_admission_released'
      reservationId: string
      parentRunId: string
      childRunId: string
    }>
  | Readonly<{
      type: 'child_terminal_settled'
      reservationId: string
      parentRunId: string
      childRunId: string
      usageDisposition: SubagentUsageDisposition
    }>

export type SubagentAdmissionEventSink = (event: SubagentAdmissionEvent) => void

export type SubagentTerminalSettlement =
  | Readonly<{ disposition: 'reported'; usage: BudgetUsage }>
  | Readonly<{ disposition: 'conservative_unknown' }>

export type ReserveSubagentAdmission = Readonly<{
  parentRunId: string
  childRunId: string
  requestedBudget: ExecutionBudget
  parentUsage: SubagentParentUsage
}>

export type SubagentAdmissionLedger = {
  reserveAdmission(input: ReserveSubagentAdmission): SubagentReservation
  acceptExecution(reservationId: string): SubagentReservation
  releaseAdmission(reservationId: string): void
  settleTerminal(reservationId: string, settlement: SubagentTerminalSettlement): void
}

export type SubagentCancellationPort = {
  link(parentRunId: string, childRunId: string): void
  unlink(parentRunId: string, childRunId: string): boolean
  reasonFor(runId: string): CancellationReason | undefined
  cancel(runId: string, reason: CancellationReason): Array<[string, CancellationReason]>
}

export type PrepareSubagentSpawn = Readonly<{
  parentRunId: string
  childRunId: string
  requestedBudget: ExecutionBudget
  parentUsage: SubagentParentUsage
  cancellation: SubagentCancellationPort
  ledger: SubagentAdmissionLedger
}>

export interface SubagentHost {
  prepareSpawn(request: PrepareSubagentSpawn): PreparedSubagent
  acceptExecution(prepared: PreparedSubagent): void
  releaseAdmission(prepared: PreparedSubagent): void
  settleTerminal(prepared: PreparedSubagent, settlement: SubagentTerminalSettlement): void
  propagateCancellation(
    prepared: PreparedSubagent,
    reason: CancellationReason,
  ): Array<[string, CancellationReason]>
  spawn(prepared: PreparedSubagent, failureReason: CancellationReason): Promise<never>
}

/**
 * Admission is implemented while product execution remains disabled. The same facade is used by
 * the process host so reservation, cancellation linking, acceptance, and cleanup stay ordered.
 */
export class DisabledSubagentRegistry implements SubagentHost {
  prepareSpawn(request: PrepareSubagentSpawn): PreparedSubagent {
    const reservation = request.ledger.reserveAdmission({
      parentRunId: request.parentRunId,
      childRunId: request.childRunId,
      requestedBudget: request.requestedBudget,
      parentUsage: request.parentUsage,
    })
    const prepared = Object.freeze({
      parentRunId: request.parentRunId,
      childRunId: request.childRunId,
      budget: reservation.childBudget,
      admission: reservation.admission,
      cancellation: request.cancellation,
      ledger: request.ledger,
      reservationId: reservation.reservationId,
    })
    try {
      request.cancellation.link(request.parentRunId, request.childRunId)
      if (request.cancellation.reasonFor(request.childRunId) !== undefined) {
        request.ledger.releaseAdmission(reservation.reservationId)
        request.cancellation.unlink(request.parentRunId, request.childRunId)
        throw admissionError(
          'SUBAGENT_PARENT_CANCELLED',
          'The parent run was cancelled before child admission completed.',
          { parentRunId: request.parentRunId, childRunId: request.childRunId },
        )
      }
    } catch (error) {
      request.ledger.releaseAdmission(reservation.reservationId)
      request.cancellation.unlink(request.parentRunId, request.childRunId)
      throw error
    }
    return prepared
  }

  acceptExecution(prepared: PreparedSubagent): void {
    prepared.ledger.acceptExecution(prepared.reservationId)
  }

  releaseAdmission(prepared: PreparedSubagent): void {
    prepared.ledger.releaseAdmission(prepared.reservationId)
    prepared.cancellation.unlink(prepared.parentRunId, prepared.childRunId)
  }

  settleTerminal(prepared: PreparedSubagent, settlement: SubagentTerminalSettlement): void {
    prepared.ledger.settleTerminal(prepared.reservationId, settlement)
    prepared.cancellation.unlink(prepared.parentRunId, prepared.childRunId)
  }

  propagateCancellation(
    prepared: PreparedSubagent,
    reason: CancellationReason,
  ): Array<[string, CancellationReason]> {
    return prepared.cancellation.cancel(prepared.parentRunId, reason)
  }

  async spawn(prepared: PreparedSubagent, failureReason: CancellationReason): Promise<never> {
    this.releaseAdmission(prepared)
    prepared.cancellation.cancel(prepared.childRunId, failureReason)
    throw runtimeError(
      'SUBAGENT_DISABLED',
      'subagent',
      'Subagent execution is not enabled in this Runtime build.',
    )
  }
}

type ScopeState = {
  depth: number
  budget: Readonly<ExecutionBudget>
  observedUsage: SubagentParentUsage
  reservedChildRuns: number
  chargedChildRuns: number
  activeChildren: number
  terminalUsage: BudgetUsage
}

type MutableReservation = {
  reservationId: string
  parentRunId: string
  childRunId: string
  childBudget: Readonly<ExecutionBudget>
  admission: SubagentAdmission
  ancestorRunIds: readonly string[]
  state: SubagentReservationState
  terminalUsage?: Readonly<BudgetUsage>
  usageDisposition?: SubagentUsageDisposition
}

/**
 * Synchronous in-memory admission ledger. Pending admissions provisionally occupy cumulative and
 * active capacity for every ancestor; authenticated acceptance converts only the cumulative claim
 * into a permanent charge. Terminal settlement releases active slots but never child-run charge.
 */
export class InMemorySubagentAdmissionLedger implements SubagentAdmissionLedger {
  readonly #scopes = new Map<string, ScopeState>()
  readonly #reservations = new Map<string, MutableReservation>()
  readonly #events?: SubagentAdmissionEventSink
  #nextReservation = 1

  constructor(options: { events?: SubagentAdmissionEventSink } = {}) {
    this.#events = options.events
  }

  registerRootScope(scope: RootSubagentScope): void {
    if (this.#scopes.has(scope.runId) || this.#hasReservationForChild(scope.runId)) {
      throw admissionError('SUBAGENT_SCOPE_EXISTS', 'A subagent admission scope already exists.', {
        runId: scope.runId,
      })
    }
    const budget = freezeBudget(validateBudget(scope.budget))
    const usage = normalizeParentUsage(scope.usage ?? emptyParentUsage())
    const chargedChildRuns = scope.chargedChildRuns ?? 0
    if (!isNonNegativeInteger(chargedChildRuns) || chargedChildRuns > budget.maxChildRuns) {
      throw admissionError(
        'INVALID_SUBAGENT_ADMISSION_STATE',
        'Initial child-run charge exceeds the root admission budget.',
        { runId: scope.runId },
      )
    }
    this.#scopes.set(scope.runId, {
      depth: 0,
      budget,
      observedUsage: usage,
      reservedChildRuns: 0,
      chargedChildRuns,
      activeChildren: 0,
      terminalUsage: emptyBudgetUsage(),
    })
  }

  reserveAdmission(input: ReserveSubagentAdmission): SubagentReservation {
    if (this.#scopes.has(input.childRunId) || this.#hasReservationForChild(input.childRunId)) {
      throw admissionError(
        'SUBAGENT_CHILD_CONFLICT',
        'The child run already has a live admission or scope.',
        { childRunId: input.childRunId },
      )
    }
    const parent = this.#requireScope(input.parentRunId)
    parent.observedUsage = mergeObservedUsage(parent.observedUsage, input.parentUsage)
    const requested = validateBudget(input.requestedBudget)
    const ancestorRunIds = this.#ancestorChain(input.parentRunId)
    for (const runId of ancestorRunIds) {
      const scope = this.#requireScope(runId)
      if (scope.chargedChildRuns + scope.reservedChildRuns >= scope.budget.maxChildRuns) {
        throw admissionError(
          'SUBAGENT_CHILD_RUN_BUDGET_EXHAUSTED',
          'The parent or an ancestor has no remaining cumulative child-run capacity.',
          { parentRunId: input.parentRunId, exhaustedRunId: runId },
        )
      }
      if (scope.activeChildren >= scope.budget.maxParallelChildren) {
        throw admissionError(
          'SUBAGENT_PARALLEL_BUDGET_EXHAUSTED',
          'The parent or an ancestor has no remaining active child slot.',
          { parentRunId: input.parentRunId, exhaustedRunId: runId },
        )
      }
    }
    if (parent.budget.maxDepth <= 0) {
      throw admissionError(
        'SUBAGENT_DEPTH_EXHAUSTED',
        'The parent execution budget cannot create another subagent depth.',
        { parentRunId: input.parentRunId },
      )
    }

    const remaining = this.#remainingAfterChild(ancestorRunIds)
    const childBudget = clampChildBudget(requested, remaining)
    childBudget.maxParallelChildren = Math.min(
      childBudget.maxParallelChildren,
      childBudget.maxChildRuns,
    )
    if (
      childBudget.maxTurns <= 0 ||
      (childBudget.maxTokens !== undefined && childBudget.maxTokens <= 0)
    ) {
      throw admissionError(
        'SUBAGENT_EXECUTION_BUDGET_EXHAUSTED',
        'The parent or an ancestor has no remaining execution capacity.',
        { parentRunId: input.parentRunId },
      )
    }
    const frozenBudget = freezeBudget(childBudget)
    const admission = Object.freeze({
      depth: parent.depth + 1,
      remainingDepth: frozenBudget.maxDepth,
    })
    for (const runId of ancestorRunIds) {
      const scope = this.#requireScope(runId)
      scope.reservedChildRuns += 1
      scope.activeChildren += 1
    }
    const reservation: MutableReservation = {
      reservationId: `subagent-admission-${this.#nextReservation++}`,
      parentRunId: input.parentRunId,
      childRunId: input.childRunId,
      childBudget: frozenBudget,
      admission,
      ancestorRunIds: Object.freeze([...ancestorRunIds]),
      state: 'slot_reserved',
    }
    this.#reservations.set(reservation.reservationId, reservation)
    this.#emit({
      type: 'child_admission_slot_reserved',
      reservationId: reservation.reservationId,
      parentRunId: reservation.parentRunId,
      childRunId: reservation.childRunId,
      depth: admission.depth,
    })
    return snapshotReservation(reservation)
  }

  acceptExecution(reservationId: string): SubagentReservation {
    const reservation = this.#requireReservation(reservationId)
    if (reservation.state === 'execution_accepted') return snapshotReservation(reservation)
    if (reservation.state !== 'slot_reserved') {
      throw admissionError(
        'SUBAGENT_ADMISSION_NOT_PENDING',
        'Only a reserved child admission can accept execution.',
        { reservationId },
      )
    }
    if (this.#scopes.has(reservation.childRunId)) {
      throw admissionError(
        'SUBAGENT_CHILD_CONFLICT',
        'The child run ID was registered as another admission scope.',
        { childRunId: reservation.childRunId },
      )
    }
    for (const runId of reservation.ancestorRunIds) {
      const scope = this.#requireScope(runId)
      scope.reservedChildRuns -= 1
      scope.chargedChildRuns += 1
    }
    this.#scopes.set(reservation.childRunId, {
      depth: reservation.admission.depth,
      budget: reservation.childBudget,
      observedUsage: emptyParentUsage(),
      reservedChildRuns: 0,
      chargedChildRuns: 0,
      activeChildren: 0,
      terminalUsage: emptyBudgetUsage(),
    })
    reservation.state = 'execution_accepted'
    this.#emit({
      type: 'child_execution_accepted_and_charged',
      reservationId,
      parentRunId: reservation.parentRunId,
      childRunId: reservation.childRunId,
      depth: reservation.admission.depth,
    })
    return snapshotReservation(reservation)
  }

  releaseAdmission(reservationId: string): void {
    const reservation = this.#requireReservation(reservationId)
    if (reservation.state === 'released' || reservation.state === 'terminal') return
    if (reservation.state !== 'slot_reserved') {
      throw admissionError(
        'SUBAGENT_ADMISSION_NOT_RELEASABLE',
        'An accepted child-run charge cannot be released.',
        { reservationId },
      )
    }
    for (const runId of reservation.ancestorRunIds) {
      const scope = this.#requireScope(runId)
      scope.reservedChildRuns -= 1
      scope.activeChildren -= 1
    }
    reservation.state = 'released'
    this.#emit({
      type: 'child_admission_released',
      reservationId,
      parentRunId: reservation.parentRunId,
      childRunId: reservation.childRunId,
    })
  }

  settleTerminal(reservationId: string, settlement: SubagentTerminalSettlement): void {
    const reservation = this.#requireReservation(reservationId)
    if (reservation.state === 'terminal') return
    if (reservation.state !== 'execution_accepted') {
      throw admissionError(
        'SUBAGENT_EXECUTION_NOT_ACCEPTED',
        'Only an accepted child execution can settle terminal usage.',
        { reservationId },
      )
    }
    const childScope = this.#requireScope(reservation.childRunId)
    if (childScope.activeChildren > 0 || childScope.reservedChildRuns > 0) {
      throw admissionError(
        'SUBAGENT_DESCENDANTS_ACTIVE',
        'A child cannot settle terminal state while descendant admissions remain active.',
        { reservationId, childRunId: reservation.childRunId },
      )
    }
    let usageDisposition = settlement.disposition
    let usage: BudgetUsage
    if (settlement.disposition === 'reported') {
      try {
        usage = normalizeBudgetUsage(settlement.usage)
      } catch {
        usageDisposition = 'conservative_unknown'
        usage = conservativeUsage(reservation.childBudget)
      }
    } else {
      usage = conservativeUsage(reservation.childBudget)
    }
    reservation.state = 'terminal'
    reservation.terminalUsage = Object.freeze({ ...usage })
    reservation.usageDisposition = usageDisposition
    for (const runId of reservation.ancestorRunIds) {
      const scope = this.#requireScope(runId)
      scope.activeChildren -= 1
      addTerminalUsage(scope.terminalUsage, usage)
    }
    this.#scopes.delete(reservation.childRunId)
    this.#emit({
      type: 'child_terminal_settled',
      reservationId,
      parentRunId: reservation.parentRunId,
      childRunId: reservation.childRunId,
      usageDisposition,
    })
  }

  reservation(reservationId: string): SubagentReservation | undefined {
    const reservation = this.#reservations.get(reservationId)
    return reservation === undefined ? undefined : snapshotReservation(reservation)
  }

  scope(runId: string):
    | Readonly<{
        depth: number
        budget: Readonly<ExecutionBudget>
        reservedChildRuns: number
        chargedChildRuns: number
        activeChildren: number
      }>
    | undefined {
    const scope = this.#scopes.get(runId)
    if (scope === undefined) return undefined
    return Object.freeze({
      depth: scope.depth,
      budget: scope.budget,
      reservedChildRuns: scope.reservedChildRuns,
      chargedChildRuns: scope.chargedChildRuns,
      activeChildren: scope.activeChildren,
    })
  }

  terminalUsage(runId: string): BudgetUsage {
    const scope = this.#requireScope(runId)
    return { ...scope.terminalUsage, subagents: scope.chargedChildRuns }
  }

  #remainingAfterChild(ancestorRunIds: readonly string[]): ExecutionBudget {
    let remaining: ExecutionBudget | undefined
    for (const runId of ancestorRunIds) {
      const scope = this.#requireScope(runId)
      const usedTokens =
        (scope.observedUsage.inputTokens ?? 0) +
        (scope.observedUsage.outputTokens ?? 0) +
        (scope.terminalUsage.inputTokens ?? 0) +
        (scope.terminalUsage.outputTokens ?? 0)
      const candidate: ExecutionBudget = {
        maxTurns: Math.max(
          0,
          scope.budget.maxTurns - scope.observedUsage.turns - scope.terminalUsage.turns,
        ),
        maxToolCalls: Math.max(
          0,
          scope.budget.maxToolCalls - scope.observedUsage.toolCalls - scope.terminalUsage.toolCalls,
        ),
        ...(scope.budget.maxTokens === undefined
          ? {}
          : { maxTokens: Math.max(0, scope.budget.maxTokens - usedTokens) }),
        maxChildRuns: Math.max(
          0,
          scope.budget.maxChildRuns - scope.chargedChildRuns - scope.reservedChildRuns - 1,
        ),
        maxParallelChildren: Math.max(
          0,
          scope.budget.maxParallelChildren - scope.activeChildren - 1,
        ),
        maxDepth: Math.max(0, scope.budget.maxDepth - 1),
        ...(scope.budget.deadlineAt === undefined ? {} : { deadlineAt: scope.budget.deadlineAt }),
      }
      remaining = remaining === undefined ? candidate : clampChildBudget(remaining, candidate)
    }
    return remaining!
  }

  #ancestorChain(parentRunId: string): string[] {
    const chain: string[] = []
    let current: string | undefined = parentRunId
    while (current !== undefined) {
      this.#requireScope(current)
      chain.push(current)
      const parentReservation = [...this.#reservations.values()].find(
        (candidate) => candidate.childRunId === current && candidate.state === 'execution_accepted',
      )
      current = parentReservation?.parentRunId
    }
    return chain
  }

  #hasReservationForChild(childRunId: string): boolean {
    return [...this.#reservations.values()].some(
      (reservation) => reservation.childRunId === childRunId,
    )
  }

  #requireScope(runId: string): ScopeState {
    const scope = this.#scopes.get(runId)
    if (scope !== undefined) return scope
    throw admissionError('SUBAGENT_SCOPE_NOT_FOUND', 'The admission scope is not registered.', {
      runId,
    })
  }

  #requireReservation(reservationId: string): MutableReservation {
    const reservation = this.#reservations.get(reservationId)
    if (reservation !== undefined) return reservation
    throw admissionError(
      'SUBAGENT_ADMISSION_NOT_FOUND',
      'The child admission reservation is not registered.',
      { reservationId },
    )
  }

  #emit(event: SubagentAdmissionEvent): void {
    try {
      this.#events?.(Object.freeze(event))
    } catch {
      // Admission state is authoritative. A diagnostic observer cannot split its transition.
    }
  }
}

function validateBudget(budget: ExecutionBudget): ExecutionBudget {
  if (
    !isNonNegativeInteger(budget.maxTurns) ||
    !isNonNegativeInteger(budget.maxToolCalls) ||
    !isNonNegativeInteger(budget.maxChildRuns) ||
    !isNonNegativeInteger(budget.maxParallelChildren) ||
    budget.maxParallelChildren > budget.maxChildRuns ||
    !isNonNegativeInteger(budget.maxDepth) ||
    (budget.maxTokens !== undefined && !isNonNegativeInteger(budget.maxTokens)) ||
    (budget.deadlineAt !== undefined && Number.isNaN(Date.parse(budget.deadlineAt)))
  ) {
    throw admissionError(
      'INVALID_EXECUTION_BUDGET',
      'Execution budget limits must be valid, bounded, and internally consistent.',
    )
  }
  return { ...budget }
}

function normalizeParentUsage(usage: SubagentParentUsage): SubagentParentUsage {
  const normalized = normalizeNumericUsage(usage)
  return Object.freeze({
    turns: normalized.turns,
    toolCalls: normalized.toolCalls,
    ...(normalized.inputTokens === undefined ? {} : { inputTokens: normalized.inputTokens }),
    ...(normalized.outputTokens === undefined ? {} : { outputTokens: normalized.outputTokens }),
    ...(normalized.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: normalized.cacheReadTokens }),
    ...(normalized.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: normalized.cacheWriteTokens }),
    ...(normalized.costUsd === undefined ? {} : { costUsd: normalized.costUsd }),
  })
}

function normalizeBudgetUsage(usage: BudgetUsage): BudgetUsage {
  const normalized = normalizeNumericUsage(usage)
  if (!isNonNegativeInteger(usage.subagents)) {
    throw admissionError('INVALID_SUBAGENT_USAGE', 'Terminal subagent usage is invalid.')
  }
  return { ...normalized, subagents: usage.subagents }
}

function normalizeNumericUsage(usage: SubagentParentUsage): SubagentParentUsage {
  if (
    !isNonNegativeInteger(usage.turns) ||
    !isNonNegativeInteger(usage.toolCalls) ||
    !optionalNonNegativeInteger(usage.inputTokens) ||
    !optionalNonNegativeInteger(usage.outputTokens) ||
    !optionalNonNegativeInteger(usage.cacheReadTokens) ||
    !optionalNonNegativeInteger(usage.cacheWriteTokens) ||
    (usage.costUsd !== undefined && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0))
  ) {
    throw admissionError('INVALID_SUBAGENT_USAGE', 'Subagent execution usage is invalid.')
  }
  return { ...usage }
}

function mergeObservedUsage(
  previous: SubagentParentUsage,
  current: SubagentParentUsage,
): SubagentParentUsage {
  const next = normalizeParentUsage(current)
  for (const key of [
    'turns',
    'toolCalls',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'costUsd',
  ] as const) {
    if ((next[key] ?? 0) < (previous[key] ?? 0)) {
      throw admissionError(
        'SUBAGENT_USAGE_REGRESSION',
        'Observed parent usage cannot move backwards.',
      )
    }
  }
  return next
}

function conservativeUsage(budget: Readonly<ExecutionBudget>): BudgetUsage {
  return {
    turns: budget.maxTurns,
    toolCalls: budget.maxToolCalls,
    ...(budget.maxTokens === undefined ? {} : { inputTokens: budget.maxTokens }),
    subagents: budget.maxChildRuns,
  }
}

function addTerminalUsage(aggregate: BudgetUsage, usage: BudgetUsage): void {
  aggregate.turns += usage.turns
  aggregate.toolCalls += usage.toolCalls
  aggregate.inputTokens = (aggregate.inputTokens ?? 0) + (usage.inputTokens ?? 0)
  aggregate.outputTokens = (aggregate.outputTokens ?? 0) + (usage.outputTokens ?? 0)
  aggregate.cacheReadTokens = (aggregate.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0)
  aggregate.cacheWriteTokens = (aggregate.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  aggregate.costUsd = (aggregate.costUsd ?? 0) + (usage.costUsd ?? 0)
}

function snapshotReservation(reservation: MutableReservation): SubagentReservation {
  return Object.freeze({
    reservationId: reservation.reservationId,
    parentRunId: reservation.parentRunId,
    childRunId: reservation.childRunId,
    childBudget: reservation.childBudget,
    admission: reservation.admission,
    ancestorRunIds: reservation.ancestorRunIds,
    state: reservation.state,
    ...(reservation.terminalUsage === undefined
      ? {}
      : { terminalUsage: reservation.terminalUsage }),
    ...(reservation.usageDisposition === undefined
      ? {}
      : { usageDisposition: reservation.usageDisposition }),
  })
}

function freezeBudget(budget: ExecutionBudget): Readonly<ExecutionBudget> {
  return Object.freeze({ ...budget })
}

function emptyParentUsage(): SubagentParentUsage {
  return Object.freeze({ turns: 0, toolCalls: 0 })
}

function emptyBudgetUsage(): BudgetUsage {
  return { turns: 0, toolCalls: 0, subagents: 0 }
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value)
}

function admissionError(code: string, message: string, data?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), runtimeError(code, 'subagent', message, data))
}
