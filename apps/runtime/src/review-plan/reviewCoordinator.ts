import { createHash } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import {
  canonicalDigestV1,
  canonicalJsonV1,
  isRuntimeError,
  MAX_REVIEW_EVIDENCE_DESCRIPTOR_BYTES_V1,
  MAX_REVIEW_EVIDENCE_ITEMS_V1,
  MAX_REVIEW_PREPARED_FILE_BYTES_V1,
  MAX_REVIEW_PREPARED_TOTAL_BYTES_V1,
  MAX_REVIEW_NEUTRAL_PAYLOAD_BYTES_V1,
  type ProviderUsage,
  type PreparedFileRuleInputV1,
  type PreparedReviewRefV1,
  type ReviewCriterionProjectionV1,
  type ReviewDecisionRefV1,
  type ReviewPlanProjectionV1,
  runtimeError,
} from '@praxis/core-sdk'
import type { ArtifactStore } from '../artifacts/artifactStore.js'
import type {
  PlanControlServicePortV1,
  PlanReviewCandidateRequestV1,
  PlanReviewToolResultV1,
  ReviewCoordinatorPortV1,
  ReviewPlanJournalPortV1,
} from './planControlPorts.js'
import type { ReviewBudgetServicePortV1 } from './reviewBudgetService.js'
import type { ReviewCallStoreV1 } from './reviewCallStore.js'
import type { RegisteredReviewChecksV1 } from './registeredChecks.js'
import { mechanicalProofBoundaryV1, reviewScopeContextV1 } from './reviewSemantics.js'
import {
  type SemanticReviewDecisionV1,
  type SemanticReviewerPortV1,
  validateSemanticReviewDecisionV1,
  MAX_EVIDENCE_READS,
  reviewOutputBudgetV1,
  type ReviewFailureDiagnosticV1,
} from './semanticReviewer.js'

const EVIDENCE_CONTENT_BUDGET_BYTES = 64 * 1024
const TASK_COVERAGE_CRITERION_PREFIX = 'runtime.task_contract_coverage'

type DeterministicFindingV1 = Omit<SemanticReviewDecisionV1['findings'][number], 'status'> & {
  status: 'passed' | 'failed' | 'unverifiable' | 'deferred'
}

function unresolvedFindings(
  findings: readonly DeterministicFindingV1[],
): SemanticReviewDecisionV1['findings'] {
  return findings.map((finding) => ({
    ...finding,
    status: finding.status === 'deferred' ? 'unverifiable' : finding.status,
  }))
}

type EvidenceOwnershipV1 = Readonly<{
  source:
    | 'root_tool_result'
    | 'accepted_item'
    | 'attempt_evidence_index'
    | 'prepared_file'
    | 'candidate_summary'
    | 'original_task_contract'
  itemId?: string
  itemAttemptId?: string
}>

export type ReviewCoordinatorOptionsV1 = Readonly<{
  journal: Pick<ReviewPlanJournalPortV1, 'loadProjection'>
  control: PlanControlServicePortV1
  artifacts: Pick<ArtifactStore, 'put' | 'read'>
  reviewer: SemanticReviewerPortV1
  reviewCalls?: Pick<
    ReviewCallStoreV1,
    | 'reserve'
    | 'markProviderStarted'
    | 'completeProvider'
    | 'markDecisionCommitted'
    | 'recordFailure'
  >
  reviewBudget?: ReviewBudgetServicePortV1
  /** Reports only measured usage. Replayed reservations are not new provider calls. */
  onProviderUsage?: (callId: string, usage: ProviderUsage) => void
  registeredChecks?: RegisteredReviewChecksV1
}>

export class ReviewCoordinatorV1 implements ReviewCoordinatorPortV1 {
  constructor(private readonly options: ReviewCoordinatorOptionsV1) {}

  async review(
    input: PlanReviewCandidateRequestV1,
    signal: AbortSignal,
  ): Promise<PlanReviewToolResultV1> {
    if (signal.aborted) throw reviewError('REVIEW_CANCELLED')
    const session = await this.options.journal.loadProjection(input.sessionId)
    const plan = requirePlan(session.reviewPlan, input.expectedPlanRevision)
    const scopedItemId = input.scope.kind === 'item' ? input.scope.itemId : undefined
    const item =
      scopedItemId === undefined ? undefined : plan.items.find(({ id }) => id === scopedItemId)
    if (input.scope.kind === 'item' && item?.currentAttempt?.state !== 'open')
      throw reviewError('PLAN_ATTEMPT_NOT_FOCUSED')
    const criterionIds =
      input.scope.kind === 'item'
        ? [...item!.criterionIds].sort()
        : plan.criteria
            .filter(({ status }) => status === 'active')
            .map(({ id }) => id)
            .sort()
    const criteria = criterionIds.map(
      (id) => plan.criteria.find((candidate) => candidate.id === id)!,
    )
    const ownership = evidenceOwnership(plan, input.scope)
    const submittedEvidenceRefs = [...new Set(input.evidenceRefs)].sort()
    if (submittedEvidenceRefs.some((ref) => !ownership.has(ref))) {
      throw reviewError('REVIEW_EVIDENCE_NOT_ATTEMPT_OWNED')
    }
    const candidateEvidenceRefs =
      submittedEvidenceRefs.length === 0 ? [...ownership.keys()] : submittedEvidenceRefs
    const summaryArtifact = await this.options.artifacts.put(
      {
        schemaVersion: 1,
        kind: 'review_candidate_summary',
        summary: input.summary,
      },
      'application/vnd.praxis.review-summary+json',
    )
    ownership.set(summaryArtifact.artifactId, {
      source: 'candidate_summary',
      ...(item === undefined ? {} : { itemId: item.id }),
      ...(item?.currentAttempt === undefined
        ? {}
        : { itemAttemptId: item.currentAttempt.itemAttemptId }),
    })
    const taskContractArtifact =
      plan.taskContract !== undefined
        ? await this.options.artifacts.put(
            {
              schemaVersion: 1,
              kind: 'review_original_task_contract',
              taskContract: plan.taskContract,
            },
            'application/vnd.praxis.review-task-contract+json',
          )
        : undefined
    if (taskContractArtifact !== undefined) {
      ownership.set(taskContractArtifact.artifactId, { source: 'original_task_contract' })
    }
    const preparedFileInputs = await prepareFileInputs(
      criteria,
      session.snapshot.cwd,
      this.options.artifacts,
    )
    for (const preparedFile of preparedFileInputs) {
      if (preparedFile.artifactRef === undefined) continue
      ownership.set(preparedFile.artifactRef, {
        source: 'prepared_file',
        ...(item === undefined ? {} : { itemId: item.id }),
        ...(item?.currentAttempt === undefined
          ? {}
          : { itemAttemptId: item.currentAttempt.itemAttemptId }),
      })
    }
    const fixedEvidenceRefs = [
      ...preparedFileInputs.flatMap(({ artifactRef }) =>
        artifactRef === undefined ? [] : [artifactRef],
      ),
      summaryArtifact.artifactId,
      ...(taskContractArtifact === undefined ? [] : [taskContractArtifact.artifactId]),
    ]
    const uniqueFixedEvidenceRefs = [...new Set(fixedEvidenceRefs)]
    if (uniqueFixedEvidenceRefs.length >= MAX_REVIEW_EVIDENCE_ITEMS_V1)
      throw reviewError('REVIEW_EVIDENCE_FIXED_INPUTS_EXCEEDED')
    const candidateRefsWithoutFixed = [
      ...new Set(candidateEvidenceRefs.filter((ref) => !uniqueFixedEvidenceRefs.includes(ref))),
    ]
    const directCapacity = MAX_REVIEW_EVIDENCE_ITEMS_V1 - uniqueFixedEvidenceRefs.length
    let selectedEvidenceRefs = candidateRefsWithoutFixed
    if (candidateRefsWithoutFixed.length > directCapacity) {
      const retained = retainReviewEvidenceBoundariesV1(
        candidateRefsWithoutFixed,
        directCapacity - 1,
      )
      const indexArtifact = await this.options.artifacts.put(
        {
          schemaVersion: 1,
          kind: 'review_attempt_evidence_index',
          sourceEvidenceCount: candidateRefsWithoutFixed.length,
          sourceEvidenceDigest: canonicalDigestV1(candidateRefsWithoutFixed),
          retainedEvidenceRefs: retained,
          omittedEvidenceCount: candidateRefsWithoutFixed.length - retained.length,
          selectionPolicy: 'first-and-latest-v1',
          evidenceRefs: candidateRefsWithoutFixed,
        },
        'application/vnd.praxis.review-evidence-index+json',
      )
      ownership.set(indexArtifact.artifactId, { source: 'attempt_evidence_index' })
      selectedEvidenceRefs = [...retained, indexArtifact.artifactId]
    }
    const evidenceRefs = [...new Set([...selectedEvidenceRefs, ...uniqueFixedEvidenceRefs])].sort()
    const preparedReviewId = `rpp_${canonicalDigestV1({
      invocationId: input.invocation.invocationId,
      planId: plan.planId,
      planRevision: plan.revision,
      scope: input.scope,
    }).slice('sha256:'.length)}`
    const prepared: PreparedReviewRefV1 = {
      preparedReviewId,
      scope: input.scope,
      planRevision: plan.revision,
      ...(item?.currentAttempt === undefined
        ? {}
        : { itemAttemptId: item.currentAttempt.itemAttemptId }),
      criterionIds,
      evidenceRefs,
      reviewInputDigest: canonicalDigestV1({
        planId: plan.planId,
        planRevision: plan.revision,
        scope: input.scope,
        summaryDigest: summaryArtifact.digest,
        criterionIds,
        evidenceRefs,
      }),
      resultSummaryArtifactRef: summaryArtifact.artifactId,
      resultSummaryDigest: summaryArtifact.digest as `sha256:${string}`,
      resultSummaryBytes: summaryArtifact.bytes,
      preparedFileInputs,
      triggerReasons: [input.scope.kind === 'final' ? 'final' : 'checkpoint'],
    }
    const preparePayload = {
      operation: 'prepare_review',
      expectedPlanRevision: plan.revision,
      preparedReview: prepared,
    }
    await this.options.control.prepareReview({
      sessionId: input.sessionId,
      expectedPlanRevision: plan.revision,
      origin: {
        kind: 'tool',
        invocationId: input.invocation.invocationId,
        payloadDigest: canonicalDigestV1(preparePayload),
      },
      preparedReview: prepared,
    })

    const deterministic = await deterministicChecks(
      criteria,
      evidenceRefs,
      preparedFileInputs,
      this.options.artifacts,
      signal,
      this.options.registeredChecks,
    )
    const coverageCriterion = input.scope.kind === 'final' ? taskCoverageCriterion(plan) : undefined
    const reviewerCriteria = [
      ...criteria.map(publicCriterion),
      ...(coverageCriterion === undefined ? [] : [coverageCriterion]),
    ]
    const reviewerCriterionIds = reviewerCriteria.map(({ id }) => id)
    const reviewerDeterministic = [
      ...deterministic,
      ...(coverageCriterion === undefined
        ? []
        : [
            {
              criterionId: coverageCriterion.id,
              status:
                plan.taskContract === undefined ? ('unverifiable' as const) : ('deferred' as const),
              reason:
                plan.taskContract === undefined
                  ? 'The immutable original task contract is unavailable for coverage review.'
                  : 'Task-to-Plan coverage is deferred to the isolated semantic Reviewer.',
              evidenceRefs: [],
            },
          ]),
    ]
    const deterministicDigest = canonicalDigestV1(reviewerDeterministic)
    let decision: SemanticReviewDecisionV1
    let reviewRequestId: string
    let committedProviderAttempt: number | undefined
    if (input.scope.kind === 'final' && plan.taskContract === undefined) {
      reviewRequestId = `rrd_${preparedReviewId.slice('rpp_'.length)}`
      decision = {
        verdict: 'blocked',
        summary:
          'Final review cannot continue because this legacy Plan has no immutable original task contract. Start a new Plan so task coverage can be verified.',
        findings: unresolvedFindings(reviewerDeterministic),
      }
    } else if (
      reviewerDeterministic.some(({ status }) => status === 'failed' || status === 'unverifiable')
    ) {
      reviewRequestId = `rrd_${preparedReviewId.slice('rpp_'.length)}`
      decision = {
        verdict: 'needs_fix',
        summary: 'One or more deterministic checks failed or could not be verified.',
        findings: unresolvedFindings(reviewerDeterministic),
      }
    } else if (
      input.scope.kind === 'item' &&
      criteria.every((criterion) => !criterionRequiresSemanticReviewV1(criterion))
    ) {
      reviewRequestId = `rrd_${preparedReviewId.slice('rpp_'.length)}`
      decision = {
        verdict: 'accepted',
        summary:
          'All scoped mechanical predicates passed. This Item acceptance proves only those predicates; original-task correctness remains subject to Final Review.',
        findings: unresolvedFindings(reviewerDeterministic),
      }
    } else {
      const requestOriginId = `${preparedReviewId}:semantic`
      const semanticRequest = {
        sessionId: input.sessionId,
        planId: plan.planId,
        expectedPlanRevision: plan.revision,
        preparedReviewId,
        deterministicDigest,
        deterministicAttemptCount: 1,
        providerAttemptCount: plan.policy.maxReviewAttempts,
      }
      const requested = await this.options.control.requestSemanticReview({
        ...semanticRequest,
        origin: runtimeOrigin(requestOriginId, semanticRequest),
      })
      reviewRequestId = `rpr_${canonicalDigestV1({
        preparedReviewId,
        deterministicDigest,
        requestId: requestOriginId,
      }).slice('sha256:'.length)}`
      // Accepted evidence remains historical context, never a current mechanical receipt.
      // Freeze references already held by the current revision; do not reread live files
      // or carry failed/abandoned attempts into a new acceptance decision.
      const contextOwnership = evidenceOwnership(plan, { kind: 'final' })
      const contextEvidenceRefs =
        input.scope.kind === 'item'
          ? retainReviewEvidenceBoundariesV1(
              [...contextOwnership.keys()].filter((ref) => !ownership.has(ref)),
              Math.min(64, MAX_REVIEW_EVIDENCE_ITEMS_V1 - evidenceRefs.length),
            )
          : []
      const manifestOwnership = new Map([...contextOwnership, ...ownership])
      const { manifest: evidenceManifest, readEvidence } = await buildEvidenceManifest(
        [...evidenceRefs, ...contextEvidenceRefs],
        manifestOwnership,
        this.options.artifacts,
      )
      const reviewerEvidenceRefs = evidenceManifest.entries
        .filter(({ available }) => available)
        .map(({ ref }) => ref)
      const neutralPayload = {
        schemaVersion: 1,
        reviewContract: { version: 2, requireProofAudit: true },
        scopeContext: reviewScopeContextV1(plan, scopedItemId),
        reviewRequestId,
        plan: {
          planId: plan.planId,
          revision: plan.revision,
          objective: plan.objective,
          scope: input.scope,
        },
        ...(plan.taskContract === undefined ? {} : { originalTaskContract: plan.taskContract }),
        summary: input.summary,
        currentEvidenceRefs: evidenceRefs,
        contextEvidenceRefs,
        criteria: reviewerCriteria,
        evidenceRefs: reviewerEvidenceRefs,
        unavailableEvidenceRefs: evidenceManifest.entries
          .filter(({ available }) => !available)
          .map(({ ref }) => ref),
        evidenceManifest,
        deterministicResults: reviewerDeterministic,
        mechanicalProofBoundaries: criteria.flatMap((criterion) => {
          const boundary = mechanicalProofBoundaryV1(criterion)
          return boundary === undefined ? [] : [boundary]
        }),
      }
      const needsEvidenceReads = evidenceManifest.entries.some(
        (entry) => entry.available && entry.truncated,
      )
      const maxStreams = needsEvidenceReads ? MAX_EVIDENCE_READS + 1 : 1
      const budgetReservation = {
        inputTokens: needsEvidenceReads
          ? Math.ceil(MAX_REVIEW_NEUTRAL_PAYLOAD_BYTES_V1 / 4) * maxStreams
          : Math.ceil(Buffer.byteLength(canonicalJsonV1(neutralPayload), 'utf8') / 4),
        outputTokens:
          (this.options.reviewer.outputTokenLimit?.(reviewerCriterionIds.length) ??
            reviewOutputBudgetV1(reviewerCriterionIds.length)) * maxStreams,
      }
      let semanticDecision: SemanticReviewDecisionV1 | undefined
      let lastFailureCode: string | undefined
      let lastFailure: ReviewFailureDiagnosticV1 | undefined
      for (let attemptNumber = 1; attemptNumber <= plan.policy.maxReviewAttempts; attemptNumber++) {
        await this.options.reviewBudget?.reserve({
          sessionId: input.sessionId,
          reviewRequestId,
          attemptNumber,
          reservation: budgetReservation,
        })
        let providerStarted = false
        let freshProviderAttempt = false
        try {
          const attemptPayload =
            lastFailure === undefined
              ? neutralPayload
              : {
                  ...neutralPayload,
                  priorResponseFailure: {
                    code: lastFailure.code,
                    validationPath: lastFailure.validationPath ?? '$',
                    instruction:
                      'Correct this response-format issue. Keep proof concise, cover every criterion exactly once, and use only listed evidence refs. This is not a task failure.',
                  },
                }
          const callReservation = await this.options.reviewCalls?.reserve(
            reviewRequestId,
            attemptNumber,
            canonicalDigestV1(attemptPayload),
          )
          if (callReservation?.attempt.failure !== undefined) {
            lastFailure = callReservation.attempt.failure
            lastFailureCode = lastFailure.code
            const savedUsage = callReservation.attempt.usage
            const hasMeasuredUsage =
              lastFailure.usageComplete &&
              savedUsage !== undefined &&
              Object.keys(savedUsage).length > 0
            await this.options.reviewBudget?.settle({
              sessionId: input.sessionId,
              reviewRequestId,
              attemptNumber,
              disposition: hasMeasuredUsage ? 'actual' : 'remote_outcome_unknown',
              usage: hasMeasuredUsage ? savedUsage : budgetReservation,
            })
            continue
          }
          if (callReservation?.attempt.decision !== undefined) {
            semanticDecision = validateSemanticReviewDecisionV1(
              callReservation.attempt.decision,
              reviewerCriterionIds,
              reviewerEvidenceRefs,
            )
            await this.options.reviewBudget?.settle({
              sessionId: input.sessionId,
              reviewRequestId,
              attemptNumber,
              disposition: 'actual',
              usage: callReservation.attempt.usage ?? {},
            })
            committedProviderAttempt = attemptNumber
            break
          }
          if (callReservation?.attempt.state === 'provider_started') {
            providerStarted = true
            throw reviewError('REVIEW_PROVIDER_OUTCOME_UNKNOWN')
          }
          await this.options.reviewCalls?.markProviderStarted(reviewRequestId, attemptNumber)
          providerStarted = true
          freshProviderAttempt = true
          const response = await this.options.reviewer.review({
            reviewRequestId,
            neutralPayload: attemptPayload,
            criterionIds: reviewerCriterionIds,
            evidenceRefs: reviewerEvidenceRefs,
            ...(needsEvidenceReads ? { readEvidence } : {}),
            signal,
          })
          this.options.onProviderUsage?.(`${reviewRequestId}:${attemptNumber}`, response.usage)
          await this.options.reviewCalls?.completeProvider(reviewRequestId, attemptNumber, response)
          await this.options.reviewBudget?.settle({
            sessionId: input.sessionId,
            reviewRequestId,
            attemptNumber,
            disposition: 'actual',
            usage: response.usage,
          })
          semanticDecision = response.decision
          if (this.options.reviewCalls !== undefined) committedProviderAttempt = attemptNumber
          break
        } catch (error) {
          lastFailureCode = isRuntimeError(error) ? error.code : 'REVIEW_PROVIDER_FAILED'
          const measuredUsage =
            typeof error === 'object' && error !== null
              ? (error as { reviewUsage?: ProviderUsage }).reviewUsage
              : undefined
          const usageComplete =
            typeof error === 'object' &&
            error !== null &&
            (error as { reviewUsageComplete?: boolean }).reviewUsageComplete === true
          const diagnostic =
            typeof error === 'object' && error !== null
              ? (error as { reviewFailure?: ReviewFailureDiagnosticV1 }).reviewFailure
              : undefined
          lastFailure = diagnostic
          if (diagnostic !== undefined && freshProviderAttempt) {
            await this.options.reviewCalls?.recordFailure(
              reviewRequestId,
              attemptNumber,
              diagnostic,
              measuredUsage ?? {},
            )
          }
          if (measuredUsage !== undefined)
            this.options.onProviderUsage?.(`${reviewRequestId}:${attemptNumber}`, measuredUsage)
          await this.options.reviewBudget?.settle({
            sessionId: input.sessionId,
            reviewRequestId,
            attemptNumber,
            disposition:
              measuredUsage !== undefined && usageComplete
                ? 'actual'
                : providerStarted
                  ? 'remote_outcome_unknown'
                  : 'released_before_provider',
            usage:
              measuredUsage !== undefined && usageComplete
                ? measuredUsage
                : providerStarted
                  ? budgetReservation
                  : {},
          })
          if (signal.aborted) throw error
        }
      }
      decision =
        semanticDecision ??
        exhaustedReviewDecision(
          reviewerCriteria,
          `Semantic Review exhausted ${plan.policy.maxReviewAttempts} allowed attempts. Last failure: ${lastFailureCode ?? 'unknown'}.`,
        )
      void requested
    }
    const decisionArtifact = await this.options.artifacts.put(
      { schemaVersion: 1, reviewRequestId, decision, deterministicDigest },
      'application/vnd.praxis.review-decision+json',
    )
    const decisionRef: ReviewDecisionRefV1 = {
      reviewRequestId,
      decisionArtifactRef: decisionArtifact.artifactId,
      decisionDigest: decisionArtifact.digest as `sha256:${string}`,
      verdict: decision.verdict,
    }
    const recordPayload = {
      sessionId: input.sessionId,
      planId: plan.planId,
      expectedPlanRevision: plan.revision,
      preparedReviewId,
      decision: decisionRef,
    }
    const receipt = await this.options.control.applyReviewDecision({
      ...recordPayload,
      origin: runtimeOrigin(`${reviewRequestId}:decision`, recordPayload),
    })
    if (committedProviderAttempt !== undefined) {
      await this.options.reviewCalls?.markDecisionCommitted(
        reviewRequestId,
        committedProviderAttempt,
      )
    }
    return {
      status: statusFor(decision.verdict),
      summary: decision.summary,
      planId: receipt.planId,
      planRevision: receipt.planRevision,
      reviewRequestId,
      findings: decision.findings,
      projection: receipt.projection,
    }
  }
}

/**
 * Keeps early setup facts and the newest verification facts without allowing the
 * model to cherry-pick. The full ordered ledger is still retained in the index Artifact.
 */
export function retainReviewEvidenceBoundariesV1(
  evidenceRefs: readonly string[],
  capacity: number,
): readonly string[] {
  if (capacity <= 0) return []
  if (evidenceRefs.length <= capacity) return [...evidenceRefs]
  const firstCount = Math.min(16, Math.max(1, Math.floor(capacity / 4)))
  const lastCount = capacity - firstCount
  if (lastCount <= 0) return evidenceRefs.slice(0, capacity)
  return [...evidenceRefs.slice(0, firstCount), ...evidenceRefs.slice(-lastCount)]
}

export function criterionRequiresSemanticReviewV1(criterion: ReviewCriterionProjectionV1): boolean {
  if (criterion.kind === 'semantic' || criterion.reviewRequired === true) return true
  return !['file_rule', 'content_digest'].includes(criterion.check.checker)
}

function exhaustedReviewDecision(
  criteria: readonly Readonly<{ id: string }>[],
  summary: string,
): SemanticReviewDecisionV1 {
  return {
    verdict: 'blocked',
    summary,
    findings: criteria.map((criterion) => ({
      criterionId: criterion.id,
      status: 'unverifiable',
      reason: 'No valid isolated Reviewer decision was available within the attempt limit.',
      evidenceRefs: [],
    })),
  }
}

async function deterministicChecks(
  criteria: readonly ReviewCriterionProjectionV1[],
  evidenceRefs: readonly string[],
  preparedFileInputs: readonly PreparedFileRuleInputV1[],
  artifacts: Pick<ArtifactStore, 'read'>,
  signal: AbortSignal,
  registeredChecks?: RegisteredReviewChecksV1,
): Promise<readonly DeterministicFindingV1[]> {
  const evidence = await Promise.all(
    evidenceRefs.map(async (ref) => ({
      ref,
      value: await artifacts.read(ref).catch(() => undefined),
    })),
  )
  return Promise.all(
    criteria.map(async (criterion) => {
      if (criterion.kind === 'semantic') {
        return {
          criterionId: criterion.id,
          status: 'deferred' as const,
          reason: 'Deferred to isolated semantic review.',
          evidenceRefs: [],
        }
      }
      const check = criterion.check
      if (check.checker === 'registered_check' && registeredChecks !== undefined) {
        const result = await registeredChecks.evaluate(
          check,
          evidence.filter(({ value }) => value !== undefined),
          signal,
        )
        return { criterionId: criterion.id, ...result }
      }
      if (check.checker === 'file_rule') {
        const prepared = preparedFileInputs.find(({ criterionId }) => criterion.id === criterionId)
        if (check.rule.kind === 'exists') {
          return finding(
            criterion.id,
            prepared?.exists === true,
            'Prepared workspace path',
            prepared?.artifactRef === undefined ? [] : [prepared.artifactRef],
          )
        }
        if (check.rule.kind === 'sha256') {
          return finding(
            criterion.id,
            prepared?.exists === true && prepared.contentDigest === check.rule.expectedDigest,
            'Prepared file digest',
            prepared?.artifactRef === undefined ? [] : [prepared.artifactRef],
          )
        }
      }
      if (check.checker === 'content_digest') {
        const match = evidence.find(
          ({ value }) => value !== undefined && canonicalDigestV1(value) === check.expectedDigest,
        )
        return finding(
          criterion.id,
          match !== undefined,
          'Content digest',
          match === undefined ? [] : [match.ref],
        )
      }
      if (check.checker === 'artifact_or_child_result') {
        const match = evidence.find(({ value }) => {
          if (!isRootToolResult(value) || !toolSucceeded(value)) return false
          if (check.source === 'child_result') {
            return typeof value.toolName === 'string' && value.toolName.startsWith('agent.')
          }
          return true
        })
        return finding(
          criterion.id,
          match !== undefined,
          'Artifact or Child result',
          match === undefined ? [] : [match.ref],
        )
      }
      if (check.checker === 'tool_receipt') {
        const match = evidence.find(
          ({ value }) =>
            isRootToolResult(value) &&
            toolSucceeded(value) &&
            (check.toolName === undefined || value.toolName === check.toolName),
        )
        return finding(
          criterion.id,
          match !== undefined,
          'Runtime-recorded Tool result',
          match === undefined ? [] : [match.ref],
        )
      }
      if (check.checker === 'effect_receipt') {
        let match: (typeof evidence)[number] | undefined
        for (const candidate of evidence) {
          if (
            !isRootToolResult(candidate.value) ||
            !toolSucceeded(candidate.value) ||
            (check.effectKind !== undefined && candidate.value.effectKind !== check.effectKind) ||
            !(await hasLinkedEffectReceipt(candidate.value, artifacts))
          )
            continue
          match = candidate
          break
        }
        return finding(
          criterion.id,
          match !== undefined,
          'Durably committed effect receipt',
          match === undefined ? [] : [match.ref],
        )
      }
      return {
        criterionId: criterion.id,
        status: 'unverifiable' as const,
        reason: `Checker ${check.checker} is not available in this Runtime composition.`,
        evidenceRefs: [],
      }
    }),
  )
}

function evidenceOwnership(
  plan: ReviewPlanProjectionV1,
  scope: PlanReviewCandidateRequestV1['scope'],
): Map<string, EvidenceOwnershipV1> {
  const ownership = new Map<string, EvidenceOwnershipV1>()
  if (scope.kind === 'item') {
    const item = plan.items.find(({ id }) => id === scope.itemId)
    if (item?.currentAttempt === undefined) return ownership
    for (const ref of item.currentAttempt.evidenceRefs ?? []) {
      ownership.set(ref, {
        source: 'root_tool_result',
        itemId: item.id,
        itemAttemptId: item.currentAttempt.itemAttemptId,
      })
    }
    return ownership
  }
  for (const item of plan.items) {
    if (item.state !== 'accepted' || item.acceptedAttemptId === undefined) continue
    for (const ref of item.acceptedEvidenceRefs ?? []) {
      ownership.set(ref, {
        source: 'accepted_item',
        itemId: item.id,
        itemAttemptId: item.acceptedAttemptId,
      })
    }
  }
  return ownership
}

async function buildEvidenceManifest(
  evidenceRefs: readonly string[],
  ownership: ReadonlyMap<string, EvidenceOwnershipV1>,
  artifacts: Pick<ArtifactStore, 'read'>,
) {
  const prepared = await Promise.all(
    evidenceRefs.map(async (ref) => {
      const owner = ownership.get(ref)
      if (owner === undefined) throw reviewError('REVIEW_EVIDENCE_NOT_ATTEMPT_OWNED')
      try {
        const value = await artifacts.read(ref)
        const content = canonicalJsonV1(value)
        return {
          ref,
          owner: 'runtime' as const,
          ...owner,
          available: true as const,
          contentDigest: canonicalDigestV1(value),
          contentBytes: Buffer.byteLength(content, 'utf8'),
          contentEncoding: 'canonical_json' as const,
          context: evidenceContextV1(value),
          content,
        }
      } catch {
        return {
          ref,
          owner: 'runtime' as const,
          ...owner,
          available: false as const,
          errorCode: 'REVIEW_EVIDENCE_ARTIFACT_UNAVAILABLE',
        }
      }
    }),
  )
  const budgets = allocateReviewEvidenceBudgetsV1(
    prepared.map((entry) => (entry.available ? entry.contentBytes : 0)),
  )
  const entries = prepared.map((entry, index) => {
    if (!entry.available) return entry
    const { content, ...descriptor } = entry
    const preview = truncateUtf8(content, budgets[index]!)
    return { ...descriptor, contentPreview: preview.text, truncated: preview.truncated }
  })
  const frozen = new Map(
    prepared.filter((entry) => entry.available).map((entry) => [entry.ref, entry]),
  )
  return {
    manifest: { schemaVersion: 1, entries, manifestDigest: canonicalDigestV1(entries) },
    readEvidence: (
      ref: string,
      offset: number,
      length: number,
    ): Readonly<Record<string, unknown>> => {
      const entry = frozen.get(ref)
      if (
        entry === undefined ||
        !entry.available ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > 16_384
      )
        throw reviewError('REVIEW_EVIDENCE_READ_INVALID')
      return {
        ref,
        contentDigest: entry.contentDigest,
        offset,
        totalCharacters: entry.content.length,
        content: entry.content.slice(offset, offset + length),
        truncated: offset + length < entry.content.length,
      }
    },
  }
}

/** Identity and observation context must remain visible even when a large body is clipped. */
function evidenceContextV1(value: unknown): Readonly<Record<string, string | number | boolean>> {
  if (!isRecord(value)) return {}
  const context: Record<string, string | number | boolean> = {}
  for (const key of [
    'kind',
    'path',
    'toolName',
    'requestId',
    'itemAttemptId',
    'planRevision',
    'startedAt',
    'finishedAt',
    'contentDigest',
    'frozenTruncated',
  ]) {
    const field = value[key]
    if (
      (typeof field === 'string' && field.length <= 4_096) ||
      typeof field === 'boolean' ||
      (typeof field === 'number' && Number.isFinite(field))
    )
      context[key] = field
  }
  return context
}

/** Share the existing total budget without wasting short receipts' unused quota. */
export function allocateReviewEvidenceBudgetsV1(
  contentBytes: readonly number[],
  totalBytes = EVIDENCE_CONTENT_BUDGET_BYTES,
  // The small descriptor cap is for prepared-file metadata/binary previews,
  // not semantic Tool evidence. The shared content budget bounds these bytes.
  perItemBytes = totalBytes,
): number[] {
  const budgets = contentBytes.map(() => 0)
  const ordered = contentBytes
    .map((bytes, index) => ({ bytes, index }))
    .sort((a, b) => a.bytes - b.bytes || a.index - b.index)
  let remaining = totalBytes
  for (let i = 0; i < ordered.length; i++) {
    const entry = ordered[i]!
    const budget = Math.min(entry.bytes, perItemBytes, Math.floor(remaining / (ordered.length - i)))
    budgets[entry.index] = budget
    remaining -= budget
  }
  return budgets
}

function taskCoverageCriterion(plan: ReviewPlanProjectionV1) {
  const suffix = (plan.taskContract?.digest ?? plan.objectiveDigest).slice('sha256:'.length, 13)
  const id = `${TASK_COVERAGE_CRITERION_PREFIX}.${suffix}`
  const description =
    'Compare originalTaskContract.text with the Plan objective, every active acceptance criterion, the candidate summary, and the evidence manifest. Pass only if every explicit user requirement is represented and proven; report omitted, weakened, or contradicted requirements.'
  return {
    id,
    description,
    kind: 'semantic' as const,
    required: true,
    reviewRequired: true,
    definitionDigest: canonicalDigestV1({ id, description }),
  }
}

async function prepareFileInputs(
  criteria: readonly ReviewCriterionProjectionV1[],
  cwd: string,
  artifacts: Pick<ArtifactStore, 'put'>,
): Promise<readonly PreparedFileRuleInputV1[]> {
  const workspaceRoot = await realpath(cwd).catch(() => resolve(cwd))
  const workspaceBaselineDigest = canonicalDigestV1({ workspaceRoot })
  const fileCount = Math.max(
    1,
    criteria.filter(
      (criterion) => criterion.kind === 'mechanical' && criterion.check.checker === 'file_rule',
    ).length,
  )
  const captureBytes = Math.min(
    MAX_REVIEW_PREPARED_FILE_BYTES_V1,
    Math.floor(MAX_REVIEW_PREPARED_TOTAL_BYTES_V1 / fileCount),
  )
  return Promise.all(
    criteria.flatMap((criterion) =>
      criterion.kind === 'mechanical' && criterion.check.checker === 'file_rule'
        ? [
            prepareFileInput(
              criterion,
              workspaceRoot,
              workspaceBaselineDigest,
              artifacts,
              captureBytes,
            ),
          ]
        : [],
    ),
  )
}

async function prepareFileInput(
  criterion: Extract<ReviewCriterionProjectionV1, { kind: 'mechanical' }>,
  workspaceRoot: string,
  workspaceBaselineDigest: `sha256:${string}`,
  artifacts: Pick<ArtifactStore, 'put'>,
  captureBytes: number,
): Promise<PreparedFileRuleInputV1> {
  if (criterion.check.checker !== 'file_rule') throw reviewError('REVIEW_FILE_RULE_INVALID')
  const target = resolve(workspaceRoot, criterion.check.path)
  if (!insideWorkspace(workspaceRoot, target)) throw reviewError('REVIEW_FILE_OUTSIDE_WORKSPACE')
  let fileStat: Awaited<ReturnType<typeof stat>>
  try {
    fileStat = await stat(target)
  } catch (error) {
    if (isNotFound(error)) {
      return {
        criterionId: criterion.id,
        path: criterion.check.path,
        exists: false,
        workspaceBaselineDigest,
      }
    }
    throw error
  }
  const canonicalTarget = await realpath(target)
  if (!insideWorkspace(workspaceRoot, canonicalTarget))
    throw reviewError('REVIEW_FILE_OUTSIDE_WORKSPACE')
  const content = fileStat.isFile()
    ? await digestFile(canonicalTarget, captureBytes)
    : {
        digest: canonicalDigestV1({ kind: 'directory' }),
        bytes: 0,
        previewBase64: '',
        previewTruncated: false,
        frozenText: '',
        frozenBase64: '',
        frozenTruncated: false,
      }
  const finalStat = await stat(canonicalTarget)
  if (!sameFileIdentity(fileStat, finalStat)) {
    throw reviewError('REVIEW_FILE_CHANGED_DURING_PREPARE')
  }
  const identity = {
    device: String(finalStat.dev),
    inode: String(finalStat.ino),
    size: finalStat.size,
    modifiedMs: finalStat.mtimeMs,
    kind: finalStat.isFile() ? 'file' : finalStat.isDirectory() ? 'directory' : 'other',
  }
  const artifact = await artifacts.put(
    {
      schemaVersion: 1,
      kind: 'review_prepared_file',
      path: criterion.check.path,
      fileKind: identity.kind,
      contentDigest: content.digest,
      contentBytes: content.bytes,
      previewEncoding: 'base64',
      contentPreview: content.previewBase64,
      previewTruncated: content.previewTruncated,
      frozenText: content.frozenText,
      frozenBase64: content.frozenBase64,
      frozenTruncated: content.frozenTruncated,
    },
    'application/vnd.praxis.review-prepared-file+json',
  )
  return {
    criterionId: criterion.id,
    path: criterion.check.path,
    exists: true,
    artifactRef: artifact.artifactId,
    contentDigest: content.digest,
    contentBytes: content.bytes,
    fileIdentityDigest: canonicalDigestV1(identity),
    workspaceBaselineDigest,
  }
}

function sameFileIdentity(
  before: Awaited<ReturnType<typeof stat>>,
  after: Awaited<ReturnType<typeof stat>>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  )
}

async function digestFile(path: string, captureBytes: number) {
  const hash = createHash('sha256')
  const preview: Buffer[] = []
  let previewBytes = 0
  let bytes = 0
  const frozen: Buffer[] = []
  let frozenBytes = 0
  for await (const rawChunk of createReadStream(path)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    hash.update(chunk)
    bytes += chunk.length
    if (frozenBytes < captureBytes) {
      const piece = chunk.subarray(0, captureBytes - frozenBytes)
      frozen.push(piece)
      frozenBytes += piece.length
    }
    if (previewBytes < MAX_REVIEW_EVIDENCE_DESCRIPTOR_BYTES_V1) {
      const piece = chunk.subarray(
        0,
        Math.min(chunk.length, MAX_REVIEW_EVIDENCE_DESCRIPTOR_BYTES_V1 - previewBytes),
      )
      preview.push(piece)
      previewBytes += piece.length
    }
  }
  const frozenContent = Buffer.concat(frozen)
  const text = isUtf8(frozenContent)
  return {
    digest: `sha256:${hash.digest('hex')}` as `sha256:${string}`,
    bytes,
    previewBase64: Buffer.concat(preview).toString('base64'),
    previewTruncated: bytes > previewBytes,
    frozenText: text ? frozenContent.toString('utf8') : '',
    frozenBase64: text ? '' : frozenContent.toString('base64'),
    frozenTruncated: bytes > frozenBytes,
  }
}

function isRootToolResult(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.kind === 'review_plan_root_tool_result'
}

function toolSucceeded(value: Record<string, unknown>): boolean {
  return isRecord(value.result) && value.result.ok === true
}

async function hasLinkedEffectReceipt(
  value: Record<string, unknown>,
  artifacts: Pick<ArtifactStore, 'read'>,
): Promise<boolean> {
  if (!isRecord(value.result) || !Array.isArray(value.result.artifacts)) return false
  for (const candidate of value.result.artifacts) {
    if (!isRecord(candidate) || typeof candidate.artifactId !== 'string') continue
    const receipt = await artifacts.read(candidate.artifactId).catch(() => undefined)
    if (isRecord(receipt) && receipt.kind === 'workflow_effect_receipt') return true
  }
  return false
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return { text: value, truncated: false }
  return { text: bytes.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

function insideWorkspace(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith('..') && !/^[/\\]/u.test(path))
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finding(
  criterionId: string,
  passed: boolean,
  label: string,
  evidenceRefs: readonly string[],
) {
  return {
    criterionId,
    status: passed ? ('passed' as const) : ('unverifiable' as const),
    reason: passed ? `${label} evidence matched.` : `${label} evidence was not found.`,
    evidenceRefs,
  }
}

function publicCriterion(criterion: ReviewCriterionProjectionV1) {
  return {
    id: criterion.id,
    description: criterion.description,
    kind: criterion.kind,
    required: criterion.required,
    reviewRequired: criterion.reviewRequired ?? false,
    definitionDigest: criterion.definitionDigest,
  }
}

function runtimeOrigin(requestId: string, payload: unknown) {
  return { kind: 'runtime' as const, requestId, inputDigest: canonicalDigestV1(payload) }
}

function requirePlan(plan: ReviewPlanProjectionV1 | undefined, revision: number) {
  if (plan === undefined) throw reviewError('PLAN_NOT_FOUND')
  if (plan.revision !== revision) throw reviewError('PLAN_REVISION_CONFLICT')
  return plan
}

function statusFor(verdict: SemanticReviewDecisionV1['verdict']): PlanReviewToolResultV1['status'] {
  return verdict === 'replan' ? 'needs_fix' : verdict
}

function reviewError(code: string) {
  return runtimeError(code, 'planner', 'Review coordination failed.')
}
