import assert from 'node:assert/strict'
import test from 'node:test'
import { CancellationTree, type ExecutionBudget } from '@praxis/core-sdk'
import {
  DisabledSubagentRegistry,
  InMemorySubagentAdmissionLedger,
  type SubagentAdmissionEvent,
} from '../apps/runtime/src/subagent/index.js'

test('prepare reserves an active slot without charging a child run', () => {
  const ledger = ledgerWithRoot()
  const registry = new DisabledSubagentRegistry()
  const cancellation = new CancellationTree()
  const prepared = registry.prepareSpawn({
    ...baseRequest(ledger, cancellation),
    requestedBudget: budget({
      maxTurns: 9,
      maxToolCalls: 9,
      maxTokens: 900,
      maxChildRuns: 9,
      maxParallelChildren: 9,
      maxDepth: 9,
    }),
    parentUsage: { turns: 1, toolCalls: 1, inputTokens: 100, outputTokens: 50 },
  })

  assert.deepEqual(prepared.budget, {
    maxTurns: 4,
    maxToolCalls: 3,
    maxTokens: 350,
    maxChildRuns: 2,
    maxParallelChildren: 1,
    maxDepth: 1,
  })
  assert.deepEqual(prepared.admission, { depth: 1, remainingDepth: 1 })
  assert.deepEqual(ledger.scope('r-root'), {
    depth: 0,
    budget: budget(),
    reservedChildRuns: 1,
    chargedChildRuns: 0,
    activeChildren: 1,
  })
  assert.equal(cancellation.parentFor('r-child'), 'r-root')
})

test('pre-acceptance release is idempotent and unlinks cancellation', () => {
  const ledger = ledgerWithRoot()
  const registry = new DisabledSubagentRegistry()
  const cancellation = new CancellationTree()
  const prepared = registry.prepareSpawn(baseRequest(ledger, cancellation))

  registry.releaseAdmission(prepared)
  registry.releaseAdmission(prepared)

  assert.equal(ledger.reservation(prepared.reservationId)?.state, 'released')
  assert.deepEqual(ledger.scope('r-root'), {
    depth: 0,
    budget: budget(),
    reservedChildRuns: 0,
    chargedChildRuns: 0,
    activeChildren: 0,
  })
  assert.equal(cancellation.parentFor('r-child'), undefined)
})

test('stable child run IDs cannot be reused after release or registered as a root', () => {
  const ledger = ledgerWithRoot()
  const registry = new DisabledSubagentRegistry()
  const prepared = registry.prepareSpawn(baseRequest(ledger, new CancellationTree()))
  registry.releaseAdmission(prepared)

  assert.throws(
    () => registry.prepareSpawn(baseRequest(ledger, new CancellationTree())),
    (error: unknown) => hasCode(error, 'SUBAGENT_CHILD_CONFLICT'),
  )
  assert.throws(
    () => ledger.registerRootScope({ runId: 'r-child', budget: budget() }),
    (error: unknown) => hasCode(error, 'SUBAGENT_SCOPE_EXISTS'),
  )
})

test('an already-cancelled parent rejects admission without spawning or leaking capacity', () => {
  const ledger = ledgerWithRoot()
  const registry = new DisabledSubagentRegistry()
  const cancellation = new CancellationTree()
  cancellation.cancel('r-root', 'user_abort')

  assert.throws(
    () => registry.prepareSpawn(baseRequest(ledger, cancellation)),
    (error: unknown) => hasCode(error, 'SUBAGENT_PARENT_CANCELLED'),
  )
  assert.equal(ledger.scope('r-root')?.reservedChildRuns, 0)
  assert.equal(ledger.scope('r-root')?.activeChildren, 0)
  assert.equal(cancellation.parentFor('r-child'), undefined)
})

test('acceptance converts a provisional claim into a permanent cumulative charge', () => {
  const ledger = ledgerWithRoot()
  const registry = new DisabledSubagentRegistry()
  const prepared = registry.prepareSpawn(baseRequest(ledger, new CancellationTree()))

  registry.acceptExecution(prepared)
  registry.acceptExecution(prepared)

  assert.equal(ledger.reservation(prepared.reservationId)?.state, 'execution_accepted')
  assert.deepEqual(ledger.scope('r-root'), {
    depth: 0,
    budget: budget(),
    reservedChildRuns: 0,
    chargedChildRuns: 1,
    activeChildren: 1,
  })
  assert.deepEqual(ledger.scope('r-child'), {
    depth: 1,
    budget: prepared.budget,
    reservedChildRuns: 0,
    chargedChildRuns: 0,
    activeChildren: 0,
  })
  assert.throws(
    () => registry.releaseAdmission(prepared),
    (error: unknown) => hasCode(error, 'SUBAGENT_ADMISSION_NOT_RELEASABLE'),
  )
})

test('terminal releases the slot and child scope but never refunds cumulative charge', () => {
  const ledger = ledgerWithRoot()
  const registry = new DisabledSubagentRegistry()
  const cancellation = new CancellationTree()
  const prepared = registry.prepareSpawn(baseRequest(ledger, cancellation))
  registry.acceptExecution(prepared)

  registry.settleTerminal(prepared, {
    disposition: 'reported',
    usage: { turns: 2, toolCalls: 1, inputTokens: 3, outputTokens: 5, subagents: 0 },
  })
  registry.settleTerminal(prepared, {
    disposition: 'reported',
    usage: { turns: 99, toolCalls: 99, subagents: 99 },
  })

  assert.equal(ledger.reservation(prepared.reservationId)?.state, 'terminal')
  assert.equal(ledger.scope('r-child'), undefined)
  assert.equal(cancellation.parentFor('r-child'), undefined)
  assert.deepEqual(ledger.scope('r-root'), {
    depth: 0,
    budget: budget(),
    reservedChildRuns: 0,
    chargedChildRuns: 1,
    activeChildren: 0,
  })
  assert.deepEqual(ledger.terminalUsage('r-root'), {
    turns: 2,
    toolCalls: 1,
    inputTokens: 3,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    subagents: 1,
  })
})

test('cumulative and parallel exhaustion are independent', () => {
  const cumulative = ledgerWithRoot(
    budget({ maxChildRuns: 1, maxParallelChildren: 1, maxDepth: 1 }),
  )
  const registry = new DisabledSubagentRegistry()
  const first = registry.prepareSpawn(baseRequest(cumulative, new CancellationTree()))
  registry.acceptExecution(first)
  registry.settleTerminal(first, {
    disposition: 'reported',
    usage: { turns: 1, toolCalls: 0, subagents: 0 },
  })
  assert.throws(
    () =>
      registry.prepareSpawn({
        ...baseRequest(cumulative, new CancellationTree()),
        childRunId: 'r-child-2',
      }),
    (error: unknown) => hasCode(error, 'SUBAGENT_CHILD_RUN_BUDGET_EXHAUSTED'),
  )

  const parallel = ledgerWithRoot(budget({ maxChildRuns: 3, maxParallelChildren: 1, maxDepth: 1 }))
  registry.prepareSpawn(baseRequest(parallel, new CancellationTree()))
  assert.throws(
    () =>
      registry.prepareSpawn({
        ...baseRequest(parallel, new CancellationTree()),
        childRunId: 'r-child-2',
      }),
    (error: unknown) => hasCode(error, 'SUBAGENT_PARALLEL_BUDGET_EXHAUSTED'),
  )
})

test('microtask-concurrent prepares cannot overbook an ancestor slot', async () => {
  const ledger = ledgerWithRoot(budget({ maxChildRuns: 3, maxParallelChildren: 1, maxDepth: 1 }))
  const registry = new DisabledSubagentRegistry()
  const attempts = await Promise.allSettled([
    Promise.resolve().then(() =>
      registry.prepareSpawn(baseRequest(ledger, new CancellationTree())),
    ),
    Promise.resolve().then(() =>
      registry.prepareSpawn({
        ...baseRequest(ledger, new CancellationTree()),
        childRunId: 'r-child-2',
      }),
    ),
  ])

  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1)
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1)
  assert.equal(ledger.scope('r-root')?.activeChildren, 1)
})

test('depth and descendant authority are derived from ancestry', () => {
  const ledger = ledgerWithRoot(budget({ maxChildRuns: 4, maxParallelChildren: 2, maxDepth: 2 }))
  const registry = new DisabledSubagentRegistry()
  const cancellation = new CancellationTree()
  const child = registry.prepareSpawn(baseRequest(ledger, cancellation))
  registry.acceptExecution(child)
  const grandchild = registry.prepareSpawn({
    parentRunId: 'r-child',
    childRunId: 'r-grandchild',
    requestedBudget: budget({
      maxTurns: 2,
      maxToolCalls: 2,
      maxChildRuns: 1,
      maxParallelChildren: 1,
      maxDepth: 9,
    }),
    parentUsage: { turns: 0, toolCalls: 0 },
    cancellation,
    ledger,
  })

  assert.deepEqual(child.admission, { depth: 1, remainingDepth: 1 })
  assert.deepEqual(grandchild.admission, { depth: 2, remainingDepth: 0 })
  assert.equal(grandchild.budget.maxDepth, 0)
  assert.equal(ledger.scope('r-root')?.activeChildren, 2)
  assert.equal(ledger.scope('r-root')?.reservedChildRuns, 1)
  assert.equal(ledger.scope('r-root')?.chargedChildRuns, 1)
})

test('an ancestor parallel ceiling rejects a grandchild even when its parent has a slot', () => {
  const ledger = ledgerWithRoot(budget({ maxChildRuns: 5, maxParallelChildren: 2, maxDepth: 2 }))
  const registry = new DisabledSubagentRegistry()
  const cancellation = new CancellationTree()
  const child = registry.prepareSpawn(baseRequest(ledger, cancellation))
  registry.acceptExecution(child)
  registry.prepareSpawn({
    ...baseRequest(ledger, cancellation),
    childRunId: 'r-sibling',
  })

  assert.equal(ledger.scope('r-child')?.activeChildren, 0)
  assert.throws(
    () =>
      registry.prepareSpawn({
        parentRunId: 'r-child',
        childRunId: 'r-grandchild',
        requestedBudget: budget({ maxDepth: 0 }),
        parentUsage: { turns: 0, toolCalls: 0 },
        cancellation,
        ledger,
      }),
    (error: unknown) => hasCode(error, 'SUBAGENT_PARALLEL_BUDGET_EXHAUSTED'),
  )
})

test('unknown terminal usage is conservatively settled at delegated limits', () => {
  const ledger = ledgerWithRoot()
  const registry = new DisabledSubagentRegistry()
  const prepared = registry.prepareSpawn(baseRequest(ledger, new CancellationTree()))
  registry.acceptExecution(prepared)

  registry.settleTerminal(prepared, { disposition: 'conservative_unknown' })

  assert.deepEqual(ledger.reservation(prepared.reservationId), {
    reservationId: prepared.reservationId,
    parentRunId: 'r-root',
    childRunId: 'r-child',
    childBudget: prepared.budget,
    admission: prepared.admission,
    ancestorRunIds: ['r-root'],
    state: 'terminal',
    terminalUsage: {
      turns: prepared.budget.maxTurns,
      toolCalls: prepared.budget.maxToolCalls,
      inputTokens: prepared.budget.maxTokens,
      subagents: prepared.budget.maxChildRuns,
    },
    usageDisposition: 'conservative_unknown',
  })
})

test('invalid reported usage falls back to conservative cleanup without leaking a slot', () => {
  const ledger = ledgerWithRoot()
  const registry = new DisabledSubagentRegistry()
  const prepared = registry.prepareSpawn(baseRequest(ledger, new CancellationTree()))
  registry.acceptExecution(prepared)

  registry.settleTerminal(prepared, {
    disposition: 'reported',
    usage: { turns: -1, toolCalls: 0, subagents: 0 },
  })

  assert.equal(ledger.reservation(prepared.reservationId)?.usageDisposition, 'conservative_unknown')
  assert.equal(ledger.scope('r-root')?.activeChildren, 0)
  assert.equal(ledger.scope('r-root')?.chargedChildRuns, 1)
})

test('admission event names stay distinct from journal commits and observers are best effort', () => {
  const events: SubagentAdmissionEvent[] = []
  const ledger = new InMemorySubagentAdmissionLedger({
    events(event) {
      events.push(event)
      throw new Error('observer failed')
    },
  })
  ledger.registerRootScope({ runId: 'r-root', budget: budget() })
  const registry = new DisabledSubagentRegistry()
  const prepared = registry.prepareSpawn(baseRequest(ledger, new CancellationTree()))
  registry.acceptExecution(prepared)
  registry.settleTerminal(prepared, {
    disposition: 'reported',
    usage: { turns: 1, toolCalls: 0, subagents: 0 },
  })

  assert.deepEqual(
    events.map((event) => event.type),
    [
      'child_admission_slot_reserved',
      'child_execution_accepted_and_charged',
      'child_terminal_settled',
    ],
  )
  assert.equal(
    events.some((event) => event.type.includes('commit')),
    false,
  )
  assert.equal(ledger.scope('r-root')?.chargedChildRuns, 1)
  assert.equal(ledger.scope('r-root')?.activeChildren, 0)
})

test('disabled execution releases admission without a cumulative charge', async () => {
  const ledger = ledgerWithRoot()
  const registry = new DisabledSubagentRegistry()
  const prepared = registry.prepareSpawn(baseRequest(ledger, new CancellationTree()))

  await assert.rejects(registry.spawn(prepared, 'plugin_failure'), (error: unknown) =>
    hasCode(error, 'SUBAGENT_DISABLED'),
  )
  assert.equal(ledger.reservation(prepared.reservationId)?.state, 'released')
  assert.equal(ledger.scope('r-root')?.chargedChildRuns, 0)
  assert.equal(ledger.scope('r-root')?.activeChildren, 0)
})

function ledgerWithRoot(rootBudget = budget()): InMemorySubagentAdmissionLedger {
  const ledger = new InMemorySubagentAdmissionLedger()
  ledger.registerRootScope({ runId: 'r-root', budget: rootBudget })
  return ledger
}

function baseRequest(ledger: InMemorySubagentAdmissionLedger, cancellation: CancellationTree) {
  return {
    parentRunId: 'r-root',
    childRunId: 'r-child',
    requestedBudget: budget({
      maxTurns: 4,
      maxToolCalls: 3,
      maxTokens: 400,
      maxChildRuns: 2,
      maxParallelChildren: 1,
      maxDepth: 1,
    }),
    parentUsage: { turns: 0, toolCalls: 0 },
    cancellation,
    ledger,
  }
}

function budget(overrides: Partial<ExecutionBudget> = {}): ExecutionBudget {
  return {
    maxTurns: 5,
    maxToolCalls: 4,
    maxTokens: 500,
    maxChildRuns: 3,
    maxParallelChildren: 2,
    maxDepth: 2,
    ...overrides,
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
