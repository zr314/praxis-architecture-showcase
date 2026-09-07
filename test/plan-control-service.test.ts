import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { PlanCreateInputV1, PlanToolInvocationContextV1 } from '@praxis/core-sdk'
import { PlanControlServiceV1 } from '../apps/runtime/src/review-plan/planControlService.js'
import { JournalPlanControlTokenServiceV1 } from '../apps/runtime/src/review-plan/planControlTokenService.js'
import { SessionRepositoryV3 } from '../apps/runtime/src/session-db/sessionRepositoryV3.js'

const DIGEST = `sha256:${'a'.repeat(64)}` as const
const DEFINITION: PlanCreateInputV1 = {
  objective: 'Implement a reviewed change.',
  acceptanceCriteria: [
    {
      id: 'tests',
      description: 'The registered test suite passes.',
      kind: 'mechanical',
      required: true,
      check: {
        checker: 'registered_check',
        checkerId: 'workspace-tests',
        checkerVersion: '1',
        checkerDigest: DIGEST,
        expectedExitCodes: [0],
      },
    },
  ],
  items: [
    {
      id: 'implement',
      title: 'Implement and test',
      criterionIds: ['tests'],
      reviewCheckpoint: true,
    },
  ],
}

test('PlanControl creates, replays, and progresses a non-DAG ReviewPlan', async () => {
  await withControl(async ({ control, repository }) => {
    const createInvocation = invocation('create')
    const created = await control.create({
      sessionId: 'session-plan',
      invocation: createInvocation,
      input: DEFINITION,
    })
    assert.match(created.planId, /^rp_[a-f0-9]{64}$/u)
    assert.equal(created.planRevision, 1)
    assert.equal(created.projection.items[0]?.state, 'pending')
    assert.equal(created.projection.taskContract?.text, 'Implement the change.')
    assert.equal(created.projection.taskContract?.runId, 'run-plan')

    const replayed = await control.create({
      sessionId: 'session-plan',
      invocation: createInvocation,
      input: structuredClone(DEFINITION),
    })
    assert.deepEqual(replayed, created)

    const started = await control.progress({
      sessionId: 'session-plan',
      expectedPlanRevision: 1,
      invocation: invocation('start'),
      action: { kind: 'start', itemId: 'implement' },
    })
    assert.equal(started.projection.items[0]?.state, 'running')
    assert.match(
      started.projection.items[0]?.currentAttempt?.itemAttemptId ?? '',
      /^rpa_[a-f0-9]{64}$/u,
    )
    assert.equal((await repository.journal().loadProjection('session-plan')).planGraph, undefined)
  })
})

test('PlanControl checks invocation replay before a stale Plan revision', async () => {
  await withControl(async ({ control }) => {
    await control.create({
      sessionId: 'session-plan',
      invocation: invocation('create'),
      input: DEFINITION,
    })
    const request = {
      sessionId: 'session-plan',
      expectedPlanRevision: 1,
      invocation: invocation('start'),
      action: { kind: 'start' as const, itemId: 'implement' },
    }
    const first = await control.progress(request)
    const replay = await control.progress({ ...request, expectedPlanRevision: 0 })
    assert.deepEqual(replay, first)
  })
})

test('PlanControl rejects one Tool invocation reused with changed semantic input', async () => {
  await withControl(async ({ control }) => {
    const createInvocation = invocation('create')
    await control.create({
      sessionId: 'session-plan',
      invocation: createInvocation,
      input: DEFINITION,
    })
    await assert.rejects(
      control.create({
        sessionId: 'session-plan',
        invocation: createInvocation,
        input: { ...DEFINITION, objective: 'A different objective.' },
      }),
      hasCode('PLAN_MUTATION_IDEMPOTENCY_CONFLICT'),
    )
  })
})

test('PlanControl records no-progress without silently increasing Plan revision', async () => {
  await withControl(async ({ control }) => {
    await control.create({
      sessionId: 'session-plan',
      invocation: invocation('create'),
      input: DEFINITION,
    })
    const receipt = await control.update({
      sessionId: 'session-plan',
      expectedPlanRevision: 1,
      invocation: invocation('update'),
      input: DEFINITION,
    })
    assert.equal(receipt.planRevision, 1)
    assert.equal(receipt.projection.noProgressCount, 1)
  })
})

test('PlanControl allows a material replan after a terminal Item Attempt', async () => {
  await withControl(async ({ control }) => {
    await control.create({
      sessionId: 'session-plan',
      invocation: invocation('create'),
      input: DEFINITION,
    })
    const started = await control.progress({
      sessionId: 'session-plan',
      expectedPlanRevision: 1,
      invocation: invocation('start'),
      action: { kind: 'start', itemId: 'implement' },
    })
    const itemAttemptId = started.projection.items[0]?.currentAttempt?.itemAttemptId
    assert.ok(itemAttemptId)

    await assert.rejects(
      control.update({
        sessionId: 'session-plan',
        expectedPlanRevision: 1,
        invocation: invocation('update-open'),
        input: { ...DEFINITION, objective: 'Replan while work is running.' },
      }),
      hasCode('PLAN_UPDATE_INFLIGHT_CONFLICT'),
    )

    await control.progress({
      sessionId: 'session-plan',
      expectedPlanRevision: 1,
      invocation: invocation('block'),
      action: {
        kind: 'block',
        itemId: 'implement',
        itemAttemptId,
        reason: 'The current approach cannot proceed.',
      },
    })
    const updated = await control.update({
      sessionId: 'session-plan',
      expectedPlanRevision: 1,
      invocation: invocation('update-terminal'),
      input: { ...DEFINITION, objective: 'Use a repaired plan.' },
    })
    assert.equal(updated.planRevision, 2)
    assert.equal(updated.projection.objective, 'Use a repaired plan.')
    assert.equal(updated.projection.items[0]?.state, 'pending')
  })
})

test('PlanControl block closes the current Item Attempt when its id is omitted', async () => {
  await withControl(async ({ control }) => {
    await control.create({
      sessionId: 'session-plan',
      invocation: invocation('create'),
      input: DEFINITION,
    })
    await control.progress({
      sessionId: 'session-plan',
      expectedPlanRevision: 1,
      invocation: invocation('start'),
      action: { kind: 'start', itemId: 'implement' },
    })

    const blocked = await control.progress({
      sessionId: 'session-plan',
      expectedPlanRevision: 1,
      invocation: invocation('block-without-attempt-id'),
      action: {
        kind: 'block',
        itemId: 'implement',
        reason: 'The current approach cannot proceed.',
      },
    })

    assert.equal(blocked.projection.items[0]?.state, 'blocked')
    assert.equal(blocked.projection.items[0]?.currentAttempt, undefined)
    const updated = await control.update({
      sessionId: 'session-plan',
      expectedPlanRevision: 1,
      invocation: invocation('update-after-implicit-close'),
      input: { ...DEFINITION, objective: 'Use a repaired plan after the block.' },
    })
    assert.equal(updated.planRevision, 2)
  })
})

test('trusted Plan control challenge survives service restart and grants exactly one Provider turn', async () => {
  await withControl(async ({ control, repository }) => {
    const created = await control.create({
      sessionId: 'session-plan',
      invocation: invocation('create'),
      input: DEFINITION,
    })
    const key = Buffer.alloc(32, 7)
    let now = new Date('2026-09-02T00:00:00.000Z')
    const options = {
      activeKeyId: 'host-key-1',
      keys: { 'host-key-1': key },
      now: () => now,
      controlLookup: (controlEventId: string) =>
        repository.loadProjectionForControl(controlEventId),
    }
    const actor = { actorId: 'user-1', actorBindingDigest: DIGEST }
    const firstService = new JournalPlanControlTokenServiceV1(repository.journal(), options)
    const challenge = await firstService.prepareChallenge(
      {
        authorizationRequestId: 'authorization-1',
        sessionId: 'session-plan',
        action: 'abandon',
        reasonCode: 'user_requested_abandon',
        target: { kind: 'plan', planId: created.planId },
      },
      actor,
    )
    const token = `pct_${'x'.repeat(43)}`
    const confirmationTokenDigest =
      `sha256:${createHash('sha256').update(token).digest('hex')}` as const
    const authorized = await firstService.authorize(
      {
        authorizationRequestId: 'authorization-1',
        sessionId: 'session-plan',
        challenge,
        confirmationTokenDigest,
      },
      actor,
    )
    assert.equal(authorized.replayed, false)

    const restarted = new JournalPlanControlTokenServiceV1(repository.journal(), options)
    const replayed = await restarted.authorize(
      {
        authorizationRequestId: 'authorization-1',
        sessionId: 'session-plan',
        challenge,
        confirmationTokenDigest,
      },
      actor,
    )
    assert.equal(replayed.replayed, true)
    const verified = await restarted.verify(
      { controlEventId: authorized.controlEventId, confirmationToken: token },
      actor,
    )
    const bound = await restarted.bindToProviderTurn({
      verifiedFact: verified,
      runId: 'run-plan',
      providerTurnId: 'message-control',
    })
    assert.equal(bound.providerTurnId, 'message-control')
    await restarted.discardProviderTurnGrant({
      controlEventId: authorized.controlEventId,
      runId: 'run-plan',
      providerTurnId: 'message-control',
      reason: 'not_used',
    })
    const projection = await repository.journal().loadProjection('session-plan')
    assert.equal(projection.reviewControls?.[0]?.state, 'discarded')

    now = new Date('2026-09-02T00:20:00.000Z')
    await assert.rejects(
      restarted.verify(
        { controlEventId: authorized.controlEventId, confirmationToken: token },
        actor,
      ),
      hasCode('PLAN_CONTROL_TOKEN_INVALID'),
    )
  })
})

test('trusted Plan control rejects a forged challenge before writing authorization', async () => {
  await withControl(async ({ control, repository }) => {
    const created = await control.create({
      sessionId: 'session-plan',
      invocation: invocation('create'),
      input: DEFINITION,
    })
    const service = new JournalPlanControlTokenServiceV1(repository.journal(), {
      activeKeyId: 'host-key-1',
      keys: { 'host-key-1': Buffer.alloc(32, 8) },
      now: () => new Date('2026-09-02T00:00:00.000Z'),
      controlLookup: (controlEventId) => repository.loadProjectionForControl(controlEventId),
    })
    const actor = { actorId: 'user-1', actorBindingDigest: DIGEST }
    const challenge = await service.prepareChallenge(
      {
        authorizationRequestId: 'authorization-forged',
        sessionId: 'session-plan',
        action: 'abandon',
        reasonCode: 'user_requested_abandon',
        target: { kind: 'plan', planId: created.planId },
      },
      actor,
    )
    await assert.rejects(
      service.authorize(
        {
          authorizationRequestId: 'authorization-forged',
          sessionId: 'session-plan',
          challenge: { ...challenge, nonce: 'tampered' },
          confirmationTokenDigest: DIGEST,
        },
        actor,
      ),
      hasCode('PLAN_CONTROL_CHALLENGE_INVALID'),
    )
    assert.equal(
      (await repository.journal().loadProjection('session-plan')).reviewControls,
      undefined,
    )
  })
})

async function withControl(
  run: (input: { control: PlanControlServiceV1; repository: SessionRepositoryV3 }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-plan-control-'))
  const repository = new SessionRepositoryV3({ root, store: 'jsonl' })
  try {
    await repository.initialize()
    await repository.create({
      sessionId: 'session-plan',
      state: 'idle',
      cwd: process.cwd(),
      provider: 'fixture',
      model: 'fixture-model',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    })
    await repository.appendRequestMessage(
      'session-plan',
      'request-plan',
      'run-plan',
      { role: 'user', content: 'Implement the change.' },
      'optional',
    )
    await run({
      control: new PlanControlServiceV1(repository.journal(), {
        now: () => '2026-09-01T00:00:01.000Z',
      }),
      repository,
    })
  } finally {
    await repository.close()
    await rm(root, { recursive: true, force: true })
  }
}

function invocation(suffix: string): PlanToolInvocationContextV1 {
  return {
    invocationId: `pti_${suffix}`,
    sessionId: 'session-plan',
    runId: 'run-plan',
    providerTurnId: `message-${suffix}`,
    providerToolCallId: `call-${suffix}`,
  }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
