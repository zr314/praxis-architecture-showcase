import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  canonicalDigestV1,
  canonicalJsonV1,
  createSessionCommitV3,
  runtimeError,
  validateSessionEntryV3,
  type PlanControlAuthorizationChallengeV1,
  type PlanControlAuthorizationTargetV1,
  type PlanControlReasonCodeV1,
  type PlanControlTargetSelectorV1,
  type SessionProjectionV3,
  type VerifiedPlanControlFactV1,
} from '@praxis/core-sdk'
import type {
  AuthenticatedHostActorV1,
  AuthorizePlanControlInputV1,
  BindPlanControlTurnInputV1,
  DiscardPlanControlTurnInputV1,
  PlanControlTokenServicePortV1,
  PreparePlanControlAuthorizationInputV1,
  ReviewPlanJournalPortV1,
  VerifyPlanControlTokenInputV1,
} from './planControlPorts.js'

const MAX_CAS_RETRIES = 4
const DEFAULT_CHALLENGE_TTL_SECONDS = 120
const DEFAULT_AUTHORIZATION_TTL_SECONDS = 600

export class JournalPlanControlTokenServiceV1 implements PlanControlTokenServicePortV1 {
  readonly #activeKeyId: string
  readonly #keys: ReadonlyMap<string, Buffer>
  readonly #now: () => Date
  readonly #controlLookup: (controlEventId: string) => Promise<SessionProjectionV3>

  constructor(
    private readonly journal: ReviewPlanJournalPortV1,
    options: Readonly<{
      activeKeyId: string
      keys: Readonly<Record<string, string | Uint8Array>>
      now?: () => Date
      controlLookup: (controlEventId: string) => Promise<SessionProjectionV3>
    }>,
  ) {
    if (!safeId(options.activeKeyId) || Object.keys(options.keys).length === 0) {
      throw controlFailure('PLAN_CONTROL_KEYRING_INVALID')
    }
    const keys = new Map<string, Buffer>()
    for (const [keyId, value] of Object.entries(options.keys)) {
      if (!safeId(keyId)) throw controlFailure('PLAN_CONTROL_KEYRING_INVALID')
      const key = typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.from(value)
      if (key.byteLength < 32) throw controlFailure('PLAN_CONTROL_KEYRING_INVALID')
      keys.set(keyId, key)
    }
    if (!keys.has(options.activeKeyId)) throw controlFailure('PLAN_CONTROL_KEYRING_INVALID')
    this.#activeKeyId = options.activeKeyId
    this.#keys = keys
    this.#now = options.now ?? (() => new Date())
    this.#controlLookup = options.controlLookup
  }

  async prepareChallenge(
    input: PreparePlanControlAuthorizationInputV1,
    actor: AuthenticatedHostActorV1,
  ): Promise<PlanControlAuthorizationChallengeV1> {
    validateActor(actor)
    validateAuthorizationRequest(input, actor)
    const projection = await this.journal.loadProjection(input.sessionId)
    const target = resolveTarget(projection, input.target)
    assertActionTarget(input.action, target.kind)
    assertReason(input.action, input.reasonCode)
    const now = this.#now()
    const challengeTtl = boundedTtl(input.challengeTtlSeconds, DEFAULT_CHALLENGE_TTL_SECONDS, 600)
    const authorizationTtl = boundedTtl(
      input.authorizationTtlSeconds,
      DEFAULT_AUTHORIZATION_TTL_SECONDS,
      3_600,
    )
    const unsigned = {
      challengeKeyId: this.#activeKeyId,
      authorizationRequestId: input.authorizationRequestId,
      sessionId: input.sessionId,
      action: input.action,
      reasonCode: input.reasonCode,
      target,
      targetDigest: canonicalDigestV1(target),
      actorBindingDigest: actor.actorBindingDigest,
      issuedAt: now.toISOString(),
      nonce: randomBytes(16).toString('hex'),
      challengeExpiresAt: new Date(now.getTime() + challengeTtl * 1_000).toISOString(),
      authorizationExpiresAt: new Date(now.getTime() + authorizationTtl * 1_000).toISOString(),
    }
    return deepFreeze({
      challengeId: `pcc_${this.#signature(this.#activeKeyId, unsigned)}`,
      ...unsigned,
    })
  }

  async authorize(
    input: AuthorizePlanControlInputV1,
    actor: AuthenticatedHostActorV1,
  ): Promise<Readonly<{ controlEventId: string; expiresAt: string; replayed: boolean }>> {
    validateActor(actor)
    digest(input.confirmationTokenDigest)
    if (
      input.authorizationRequestId !== input.challenge.authorizationRequestId ||
      input.sessionId !== input.challenge.sessionId
    ) {
      throw controlFailure('PLAN_CONTROL_AUTHORIZATION_CONFLICT')
    }
    const controlEventId = stableId('control', {
      actorId: actor.actorId,
      sessionId: input.sessionId,
      authorizationRequestId: input.authorizationRequestId,
    })
    const challengeEnvelopeDigest = canonicalDigestV1(input.challenge)
    const existingProjection = await this.journal.loadProjection(input.sessionId)
    const existing = existingProjection.reviewControls?.find(
      (control) => control.controlEventId === controlEventId,
    )
    if (existing !== undefined) {
      if (
        existing.authorizationRequestId !== input.authorizationRequestId ||
        existing.challengeEnvelopeDigest !== challengeEnvelopeDigest ||
        existing.fact.tokenDigest !== input.confirmationTokenDigest ||
        existing.fact.actorId !== actor.actorId ||
        existing.fact.actorBindingDigest !== actor.actorBindingDigest
      ) {
        throw controlFailure('PLAN_CONTROL_AUTHORIZATION_CONFLICT')
      }
      return deepFreeze({ controlEventId, expiresAt: existing.fact.expiresAt, replayed: true })
    }

    this.#verifyChallenge(input.challenge)
    const now = this.#now().toISOString()
    if (
      input.challenge.challengeExpiresAt <= now ||
      input.challenge.authorizationExpiresAt <= now
    ) {
      throw controlFailure('PLAN_CONTROL_CHALLENGE_EXPIRED')
    }
    if (input.challenge.actorBindingDigest !== actor.actorBindingDigest) {
      throw controlFailure('PLAN_CONTROL_CHALLENGE_INVALID')
    }
    const liveProjection = await this.journal.loadProjection(input.sessionId)
    const liveTarget = resolveTarget(liveProjection, selectorFromTarget(input.challenge.target))
    if (
      canonicalDigestV1(liveTarget) !== input.challenge.targetDigest ||
      canonicalDigestV1(liveTarget) !== canonicalDigestV1(input.challenge.target)
    ) {
      throw controlFailure('PLAN_CONTROL_CHALLENGE_STALE')
    }
    assertActionTarget(input.challenge.action, liveTarget.kind)
    assertReason(input.challenge.action, input.challenge.reasonCode)
    const fact: VerifiedPlanControlFactV1 = deepFreeze({
      controlEventId,
      actorId: actor.actorId,
      actorBindingDigest: actor.actorBindingDigest,
      sessionId: input.sessionId,
      action: input.challenge.action,
      reasonCode: input.challenge.reasonCode,
      target: liveTarget,
      targetDigest: input.challenge.targetDigest,
      challengeId: input.challenge.challengeId,
      challengeDigest: challengeEnvelopeDigest,
      tokenDigest: input.confirmationTokenDigest,
      issuedAt: now,
      expiresAt: input.challenge.authorizationExpiresAt,
    })
    await this.#appendControlEvent(input.sessionId, controlEventId, 'control.authorized', {
      authorizationRequestId: input.authorizationRequestId,
      challengeEnvelopeDigest,
      fact,
    })
    return deepFreeze({ controlEventId, expiresAt: fact.expiresAt, replayed: false })
  }

  async verify(
    input: VerifyPlanControlTokenInputV1,
    actor: AuthenticatedHostActorV1,
  ): Promise<VerifiedPlanControlFactV1> {
    validateActor(actor)
    if (
      !safeId(input.controlEventId) ||
      !/^pct_[A-Za-z0-9_-]{20,512}$/u.test(input.confirmationToken)
    ) {
      throw controlFailure('PLAN_CONTROL_TOKEN_INVALID')
    }
    const projection = await this.#controlLookup(input.controlEventId)
    const control = projection.reviewControls?.find(
      (candidate) => candidate.controlEventId === input.controlEventId,
    )
    if (
      control === undefined ||
      !['authorized', 'turn_bound'].includes(control.state) ||
      control.fact.actorId !== actor.actorId ||
      control.fact.actorBindingDigest !== actor.actorBindingDigest ||
      control.fact.expiresAt <= this.#now().toISOString()
    ) {
      throw controlFailure('PLAN_CONTROL_TOKEN_INVALID')
    }
    const actual = createHash('sha256').update(input.confirmationToken, 'utf8').digest('hex')
    const expected = control.fact.tokenDigest.slice('sha256:'.length)
    if (!constantEqual(actual, expected)) throw controlFailure('PLAN_CONTROL_TOKEN_INVALID')
    return deepFreeze(structuredClone(control.fact))
  }

  async bindToProviderTurn(input: BindPlanControlTurnInputV1): Promise<VerifiedPlanControlFactV1> {
    const projection = await this.journal.loadProjection(input.verifiedFact.sessionId)
    const control = projection.reviewControls?.find(
      (candidate) => candidate.controlEventId === input.verifiedFact.controlEventId,
    )
    if (
      control === undefined ||
      canonicalDigestV1(control.fact) !== canonicalDigestV1(input.verifiedFact)
    ) {
      throw controlFailure('PLAN_CONTROL_AUTHORIZATION_INVALID')
    }
    if (control.state === 'turn_bound') {
      if (control.runId !== input.runId || control.providerTurnId !== input.providerTurnId) {
        throw controlFailure('PLAN_CONTROL_TURN_CONFLICT')
      }
    } else if (control.state === 'authorized') {
      await this.#appendControlEvent(
        input.verifiedFact.sessionId,
        input.verifiedFact.controlEventId,
        'control.turn_bound',
        {
          controlEventId: input.verifiedFact.controlEventId,
          runId: input.runId,
          providerTurnId: input.providerTurnId,
        },
      )
    } else {
      throw controlFailure('PLAN_CONTROL_AUTHORIZATION_INVALID')
    }
    return deepFreeze({
      ...input.verifiedFact,
      runId: input.runId,
      providerTurnId: input.providerTurnId,
    })
  }

  async discardProviderTurnGrant(input: DiscardPlanControlTurnInputV1): Promise<void> {
    const projection = await this.#controlLookup(input.controlEventId)
    const control = projection.reviewControls?.find(
      (candidate) => candidate.controlEventId === input.controlEventId,
    )
    if (control?.state === 'discarded') {
      if (control.runId !== input.runId || control.providerTurnId !== input.providerTurnId) {
        throw controlFailure('PLAN_CONTROL_TURN_CONFLICT')
      }
      return
    }
    if (
      control?.state !== 'turn_bound' ||
      control.runId !== input.runId ||
      control.providerTurnId !== input.providerTurnId
    ) {
      throw controlFailure('PLAN_CONTROL_TURN_CONFLICT')
    }
    await this.#appendControlEvent(
      control.fact.sessionId,
      control.controlEventId,
      'control.discarded',
      {
        controlEventId: control.controlEventId,
        disposition: discardDisposition(input.reason),
      },
    )
  }

  #verifyChallenge(challenge: PlanControlAuthorizationChallengeV1): void {
    const key = this.#keys.get(challenge.challengeKeyId)
    if (key === undefined || !challenge.challengeId.startsWith('pcc_')) {
      throw controlFailure('PLAN_CONTROL_CHALLENGE_INVALID')
    }
    const { challengeId: _challengeId, ...unsigned } = challenge
    const expected = this.#signature(challenge.challengeKeyId, unsigned)
    if (!constantEqual(challenge.challengeId.slice('pcc_'.length), expected)) {
      throw controlFailure('PLAN_CONTROL_CHALLENGE_INVALID')
    }
  }

  #signature(keyId: string, value: unknown): string {
    const key = this.#keys.get(keyId)
    if (key === undefined) throw controlFailure('PLAN_CONTROL_CHALLENGE_INVALID')
    return createHmac('sha256', key).update(canonicalJsonV1(value), 'utf8').digest('hex')
  }

  async #appendControlEvent(
    sessionId: string,
    controlEventId: string,
    type: 'control.authorized' | 'control.turn_bound' | 'control.discarded',
    data: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      const projection = await this.journal.loadProjection(sessionId)
      const timestamp = monotonicTimestamp(projection.snapshot.updatedAt, this.#now().toISOString())
      const entry = validateSessionEntryV3({
        schemaVersion: 3,
        entryId: stableId('control_event', { sessionId, controlEventId, type }),
        sessionId,
        sequence: projection.snapshot.sequence + 1,
        revision: projection.snapshot.revision + 1,
        timestamp,
        type,
        data,
      })
      try {
        await this.journal.appendCommit(
          createSessionCommitV3({
            sessionId,
            commitId: stableId('control_commit', { sessionId, controlEventId, type }),
            expectedRevision: projection.snapshot.revision,
            idempotencyKey: stableId('control_idem', { sessionId, controlEventId, type }),
            entries: [entry],
          }),
        )
        return
      } catch (error) {
        if (!hasCode(error, 'SESSION_COMMIT_REVISION_CONFLICT') || attempt + 1 >= MAX_CAS_RETRIES) {
          throw error
        }
      }
    }
  }
}

function resolveTarget(
  projection: SessionProjectionV3,
  selector: PlanControlTargetSelectorV1,
): PlanControlAuthorizationTargetV1 {
  const binding = planBinding(projection.reviewPlan)
  if (selector.kind === 'plan') {
    const plan = projection.reviewPlan
    if (plan === undefined || plan.planId !== selector.planId)
      throw controlFailure('PLAN_NOT_FOUND')
    return {
      kind: 'plan',
      planId: plan.planId,
      expectedPlanRevision: plan.revision,
      planStateDigest: canonicalDigestV1(plan),
    }
  }
  if (selector.kind === 'run') {
    const run = projection.snapshot.runs.find((candidate) => candidate.runId === selector.runId)
    if (run === undefined) throw controlFailure('RUN_NOT_FOUND')
    return {
      kind: 'run',
      runId: run.runId,
      runStateDigest: canonicalDigestV1(run),
      planBinding: binding,
    }
  }
  return {
    kind: 'session',
    sessionStateDigest: canonicalDigestV1({
      sessionId: projection.snapshot.sessionId,
      revision: projection.snapshot.revision,
      lifecycle: projection.snapshot.lifecycle,
      activeRunId: projection.snapshot.runs.find((run) => run.state === 'running')?.runId,
    }),
    planBinding: binding,
  }
}

function planBinding(plan: SessionProjectionV3['reviewPlan']) {
  return plan === undefined
    ? null
    : { planId: plan.planId, planRevision: plan.revision, stateDigest: canonicalDigestV1(plan) }
}

function selectorFromTarget(target: PlanControlAuthorizationTargetV1): PlanControlTargetSelectorV1 {
  if (target.kind === 'plan') return { kind: 'plan', planId: target.planId }
  if (target.kind === 'run') return { kind: 'run', runId: target.runId }
  return { kind: 'session' }
}

function validateActor(actor: AuthenticatedHostActorV1): void {
  if (!safeId(actor.actorId)) throw controlFailure('PLAN_CONTROL_ACTOR_INVALID')
  digest(actor.actorBindingDigest)
}

function validateAuthorizationRequest(
  input: PreparePlanControlAuthorizationInputV1,
  actor: AuthenticatedHostActorV1,
): void {
  if (!safeId(input.authorizationRequestId) || !safeId(input.sessionId)) {
    throw controlFailure('PLAN_CONTROL_REQUEST_INVALID')
  }
  void actor
}

function assertActionTarget(
  action: PlanControlAuthorizationChallengeV1['action'],
  kind: PlanControlAuthorizationTargetV1['kind'],
): void {
  const valid =
    (['abandon', 'scope_change', 'resolve_block'].includes(action) && kind === 'plan') ||
    (action === 'cancel' && kind === 'run') ||
    (action === 'session_close' && kind === 'session')
  if (!valid) throw controlFailure('PLAN_CONTROL_TARGET_INVALID')
}

function assertReason(
  action: PlanControlAuthorizationChallengeV1['action'],
  reason: PlanControlReasonCodeV1,
): void {
  const allowed: Record<
    PlanControlAuthorizationChallengeV1['action'],
    readonly PlanControlReasonCodeV1[]
  > = {
    abandon: ['user_requested_abandon'],
    scope_change: ['user_changed_scope', 'host_policy_override'],
    resolve_block: ['user_resolved_block', 'host_policy_override'],
    cancel: ['user_cancelled', 'host_policy_override'],
    session_close: ['user_closed_session'],
  }
  if (!allowed[action].includes(reason)) throw controlFailure('PLAN_CONTROL_REASON_INVALID')
}

function discardDisposition(reason: DiscardPlanControlTurnInputV1['reason']) {
  return {
    not_used: 'unused' as const,
    abort: 'aborted' as const,
    timeout: 'timeout' as const,
    provider_failure: 'provider_error' as const,
    run_terminated: 'run_terminated' as const,
  }[reason]
}

function boundedTtl(value: number | undefined, fallback: number, maximum: number): number {
  const ttl = value ?? fallback
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > maximum) {
    throw controlFailure('PLAN_CONTROL_TTL_INVALID')
  }
  return ttl
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u.test(value)
}

function digest(value: unknown): asserts value is `sha256:${string}` {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw controlFailure('PLAN_CONTROL_REQUEST_INVALID')
  }
}

function stableId(prefix: string, input: unknown): string {
  return `${prefix}_${canonicalDigestV1(input).slice('sha256:'.length)}`
}

function constantEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}

function monotonicTimestamp(previous: string | undefined, candidate: string): string {
  if (previous === undefined || candidate >= previous) return candidate
  return new Date(Date.parse(previous) + 1).toISOString()
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) deepFreeze(nested)
  return value
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

function controlFailure(code: string): ReturnType<typeof runtimeError> {
  return runtimeError(code, 'permission', 'Plan control authorization was rejected.')
}
