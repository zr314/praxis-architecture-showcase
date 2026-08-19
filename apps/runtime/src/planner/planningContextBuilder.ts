import { contentText, type ProviderMessage, type ToolDefinition } from '@praxis/core-sdk'

const MAX_RECENT_MESSAGES = 12
const MAX_MESSAGE_BYTES = 2_048

export type PlanningSkillV1 = Readonly<{
  id: string
  name: string
  description: string
  digest: `sha256:${string}`
}>

export type PlanningContextInputV1 = Readonly<{
  workspace: string
  objective: string
  messages: readonly ProviderMessage[]
  tools: readonly ToolDefinition[]
  skills: readonly PlanningSkillV1[]
  mcpToolNames: readonly string[]
  budget: Readonly<{
    maxTurns: number
    maxToolCalls: number
    maxTokens?: number
    maxChildRuns: number
    maxParallelChildren: number
    maxDepth: number
    deadlineAt?: string
  }>
  existingPlan?: unknown
  verifiedEvidence?: readonly Readonly<{ ref: string; summary?: string }>[]
  runtime?: Readonly<{
    mode: 'supervisor'
    plannerAlreadyActive: boolean
    descendantsAllowed: false
    recursivePraxisAllowed: false
  }>
}>

/** Builds a bounded planning-only view instead of forwarding the whole parent transcript. */
export function buildPlanningContextV1(
  input: PlanningContextInputV1,
): Readonly<Record<string, unknown>> {
  const recentMessages = input.messages
    .filter(
      (message) =>
        !(message.role === 'user' && message.intent === 'context' && message.trust === 'low'),
    )
    .slice(-MAX_RECENT_MESSAGES)
    .map((message) => ({
      role: message.role,
      content: bounded(contentText(message.content), MAX_MESSAGE_BYTES),
    }))
  return deepFreeze({
    schemaVersion: 1,
    workspace: input.workspace,
    objective: input.objective,
    objectivePolicy: {
      currentObjectiveIsAuthoritative: true,
      recentMessagesAreForCoreferenceOnly: true,
      repeatCompletedPriorWorkOnlyWhenExplicitlyRequested: true,
    },
    recentMessages,
    capabilities: {
      tools: input.tools.map((tool) => ({
        name: tool.name,
        description: bounded(tool.description, 512),
        sideEffect: tool.execution?.sideEffect ?? 'unknown',
      })),
      skills: input.skills.map((skill) => ({
        ...skill,
        description: bounded(skill.description, 512),
      })),
      mcpToolNames: [...input.mcpToolNames],
    },
    accessPolicy: {
      pathRoot: '.',
      pathFormat: 'portable_workspace_relative',
      absolutePathsForbidden: true,
      writeOnlyWhenExplicitlyRequested: true,
      productStepPaths: ['.'],
    },
    ...(input.runtime === undefined ? {} : { runtime: { ...input.runtime } }),
    budget: { ...input.budget },
    ...(input.existingPlan === undefined ? {} : { existingPlan: input.existingPlan }),
    ...(input.verifiedEvidence === undefined
      ? {}
      : {
          verifiedEvidence: input.verifiedEvidence.slice(-64).map((item) => ({
            ref: item.ref,
            ...(item.summary === undefined ? {} : { summary: bounded(item.summary, 512) }),
          })),
        }),
  })
}

function bounded(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value
  let end = Math.min(value.length, maximumBytes)
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maximumBytes - 3) end -= 1
  return `${value.slice(0, end)}…`
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  }
  return value
}
