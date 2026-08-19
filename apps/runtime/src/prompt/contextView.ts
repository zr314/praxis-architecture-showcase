import type {
  PromptContextView,
  ProviderMessage,
  SessionMemory,
  SessionProjectionV3,
} from '@praxis/core-sdk'

export function compatibilityContextView(input: {
  sessionId: string
  messages: readonly ProviderMessage[]
  memory: SessionMemory
}): PromptContextView {
  const checkpoint = input.memory.checkpoint
  const checkpointRefs = checkpoint?.summary?.relevantRefs ?? []
  const plan = input.memory.plan
  return deepFreeze({
    schemaVersion: 1,
    authority: 'compatibility_v2',
    sessionId: input.sessionId,
    revision: Math.max(input.messages.length, plan?.revision ?? 0),
    ...(checkpoint === undefined
      ? {}
      : {
          checkpoint: {
            checkpointId: checkpoint.id,
            trust: 'low',
            range: {
              unit: 'message_index',
              start: checkpoint.messageStart,
              end: checkpoint.messageEnd,
            },
            digest: checkpoint.digest as `sha256:${string}`,
            ...(checkpoint.provenance?.generator === undefined
              ? {}
              : { generator: { ...checkpoint.provenance.generator } }),
          },
        }),
    recentEntryRange: {
      unit: 'message_index',
      start: checkpoint?.messageEnd ?? 0,
      end: input.messages.length,
    },
    ...(plan === undefined
      ? {}
      : {
          plan: {
            planId: `compat-plan-${input.sessionId}`,
            revision: plan.revision,
            state: compactPlanState(plan.steps.map((step) => step.state)),
            objective: plan.objective,
            steps: plan.steps.map((step) => ({
              stepId: step.id,
              title: step.title,
              state: step.state,
              prerequisiteResultRefs: [],
            })),
          },
        }),
    prerequisiteResultRefs: [...checkpointRefs],
    artifactRefs: artifactIds(checkpointRefs),
    omission: {
      entries: checkpoint?.messageEnd ?? 0,
      messages: checkpoint?.messageEnd ?? 0,
      reasons: checkpoint === undefined ? [] : ['checkpoint'],
    },
  } satisfies PromptContextView)
}

export function journalContextView(projection: SessionProjectionV3): PromptContextView {
  const checkpoint = projection.checkpoint
  const checkpointRefs = checkpoint?.summary.relevantRefs ?? []
  const plan = projection.planGraph
  return deepFreeze({
    schemaVersion: 1,
    authority: 'session_journal_v3',
    sessionId: projection.snapshot.sessionId,
    revision: projection.contextView.revision,
    ...(checkpoint === undefined
      ? {}
      : {
          checkpoint: {
            checkpointId: checkpoint.checkpointId,
            trust: 'low',
            range: {
              unit: 'entry_sequence',
              start: checkpoint.coveredRange.startSequence,
              end: checkpoint.coveredRange.endSequence,
            },
            digest: checkpoint.summaryDigest,
            generator: { ...checkpoint.provenance.generator },
          },
        }),
    recentEntryRange: {
      unit: 'entry_sequence',
      start: projection.contextView.recentEntryRange.startSequence,
      end: projection.contextView.recentEntryRange.endSequence,
    },
    ...(plan === undefined
      ? {}
      : {
          plan: {
            planId: plan.planId,
            revision: plan.revision,
            state: plan.state,
            objective: plan.objective,
            steps: plan.steps.map((step) => ({
              stepId: step.stepId,
              title: step.title,
              state: step.state,
              prerequisiteResultRefs: step.attempts.flatMap((attempt) =>
                attempt.resultRef === undefined ? [] : [attempt.resultRef],
              ),
            })),
          },
        }),
    prerequisiteResultRefs: unique([...projection.contextView.resultRefs, ...checkpointRefs]),
    artifactRefs: unique([...projection.contextView.artifactIds, ...artifactIds(checkpointRefs)]),
    omission: {
      entries: projection.contextView.omittedEntries,
      messages: 0,
      reasons: checkpoint === undefined ? [] : ['checkpoint'],
    },
  } satisfies PromptContextView)
}

function artifactIds(refs: readonly string[]): string[] {
  return refs.flatMap((ref) => {
    const match = /^artifact:\/\/(artifact-[a-f0-9]{64})$/u.exec(ref)
    return match === null ? [] : [match[1]!]
  })
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function compactPlanState(states: readonly string[]): string {
  if (states.some((state) => state === 'failed')) return 'failed'
  if (states.length > 0 && states.every((state) => state === 'completed')) return 'succeeded'
  return 'running'
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}
