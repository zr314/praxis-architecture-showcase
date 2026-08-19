import {
  runtimeError,
  type ChatProvider,
  type PromptVariant,
  type ProviderToolDefinition,
} from '@praxis/core-sdk'
import type {
  PlanGeneratorModelInputV1,
  PlanGeneratorModelOutputV1,
  PlanGeneratorModelPortV1,
} from './planGenerator.js'
import { composeLeanTrustedInstructions, DEFAULT_PROMPT_VARIANT } from '../prompt/promptRegistry.js'
import { parseProviderJsonV1 } from './providerStructuredOutput.js'

const SUBMIT_PLAN_TOOL = 'submit_supervisor_plan'

/** Adapts the selected product Provider to the isolated structured planning port. */
export class ProviderPlanGeneratorModelPortV1 implements PlanGeneratorModelPortV1 {
  readonly identity: Readonly<{ kind: 'model'; id: string }>

  constructor(
    private readonly provider: ChatProvider,
    private readonly model: string,
    private readonly promptVariant: PromptVariant = DEFAULT_PROMPT_VARIANT,
  ) {
    this.identity = Object.freeze({
      kind: 'model',
      id: `${provider.id}/${model}`,
    })
  }

  async generate(input: PlanGeneratorModelInputV1): Promise<PlanGeneratorModelOutputV1> {
    const nativeSchema = this.provider.capabilities?.output.jsonSchema === true
    const prompt = planningPrompt(input, this.promptVariant)
    let text = ''
    let activeTool = -1
    const toolArguments = new Map<number, string>()
    let submitted: unknown
    let inputTokens = estimateTokens(prompt)
    let outputTokens = 0
    let costUsd = 0
    let providerOutputStarted = false
    let stopReason: string | undefined

    try {
      for await (const chunk of this.provider.stream({
        model: this.model,
        messages: [{ role: 'user', content: prompt, intent: 'context', trust: 'low' }],
        tools: nativeSchema ? [] : [planSubmissionTool(input)],
        ...(nativeSchema ? {} : { toolChoice: { name: SUBMIT_PLAN_TOOL } }),
        instructions: plannerInstructions(nativeSchema, this.promptVariant),
        signal: input.signal,
        maxOutputTokens: input.maxOutputTokens,
        reasoning: { mode: 'compact' },
        ...(nativeSchema ? { responseFormat: input.responseFormat } : {}),
      })) {
        if (chunk.type === 'text_delta') {
          providerOutputStarted = true
          text += chunk.text
        }
        if (chunk.type === 'tool_call_start') {
          providerOutputStarted = true
          activeTool = chunk.index
          if (chunk.name === SUBMIT_PLAN_TOOL) toolArguments.set(chunk.index, '')
        }
        if (chunk.type === 'tool_call_delta' && toolArguments.has(chunk.index)) {
          providerOutputStarted = true
          toolArguments.set(chunk.index, `${toolArguments.get(chunk.index)}${chunk.argumentsDelta}`)
        }
        if (chunk.type === 'tool_call_end' && toolArguments.has(chunk.index)) {
          providerOutputStarted = true
          submitted = chunk.input ?? parseProviderJsonV1(toolArguments.get(chunk.index) ?? '')
        }
        if (chunk.type === 'reasoning_delta') providerOutputStarted = true
        if (chunk.type === 'completed') {
          stopReason = chunk.stopReason
          inputTokens = chunk.usage?.inputTokens ?? inputTokens
          outputTokens = chunk.usage?.outputTokens ?? estimateTokens(text)
          costUsd = chunk.usage?.costUsd ?? 0
        }
      }
    } catch (error) {
      if (!providerOutputStarted) throw error
      throw Object.assign(
        new Error('Planner Provider failed after emitting output.', { cause: error }),
        {
          planProviderOutputStarted: true,
        },
      )
    }

    if (submitted === undefined && activeTool >= 0) {
      submitted = parseProviderJsonV1(toolArguments.get(activeTool) ?? '')
    }
    const output = submitted ?? parseProviderJsonV1(text)
    if (output === undefined) {
      const code =
        truncatedStopReason(stopReason) || outputTokens >= input.maxOutputTokens
          ? 'PLAN_GENERATOR_OUTPUT_TRUNCATED'
          : 'PLAN_GENERATOR_OUTPUT_MISSING'
      throw planOutputError(code, { inputTokens, outputTokens, costUsd, stopReason })
    }
    return Object.freeze({
      output,
      usage: Object.freeze({ inputTokens, outputTokens, costUsd }),
    })
  }
}

function truncatedStopReason(value: string | undefined): boolean {
  return ['length', 'max_tokens', 'max_output_tokens'].includes(value ?? '')
}

function planOutputError(
  code: 'PLAN_GENERATOR_OUTPUT_TRUNCATED' | 'PLAN_GENERATOR_OUTPUT_MISSING',
  data: Readonly<Record<string, unknown>>,
) {
  return Object.assign(new Error(code), runtimeError(code, 'provider', code, data), { code })
}

function planningPrompt(input: PlanGeneratorModelInputV1, promptVariant: PromptVariant): string {
  return [
    'Route the current user objective, then create an executable Praxis Supervisor DAG only when it is needed.',
    'Set execution="parent_only" with steps=[] for explanation, advice, discussion, or follow-up questions that the parent can answer from the conversation without new tool evidence or external action.',
    'Set execution="dag" only when files, tools, processes, external systems, edits, or independent verification are materially required.',
    'Praxis Supervisor mode is already active for this request. Never create a step that invokes Praxis recursively, starts another Praxis CLI session, or tests whether Planner mode can be entered.',
    'For a meta-request to test Planner itself, use the smallest non-destructive representative DAG. Never invent a modification step unless the user explicitly requested a modification.',
    promptVariant === 'iron-law-lean-v1'
      ? 'The proposal must exactly match the supplied schema and capability context.'
      : 'The proposal is untrusted and will be rejected unless it exactly matches the supplied schema and capability context.',
    'Use read_only for inspection that needs no process, isolated_process for commands/tests whose changes must never be merged, and workspace_write only for steps that must modify code.',
    'Both isolated_process and workspace_write execute in isolated Git worktrees. Only workspace_write changes may pass verification and merge.',
    'Preserve the exact user objective. Never invent a product, deliverable, or modification that the user did not request.',
    'Inspection, review, and analysis are read_only. Testing or invoking a CLI is isolated_process unless the user explicitly asks that the step modify files.',
    'The current product child grant is workspace-root scoped. For every DAG step emit access.paths=["."]; put a narrower target in the title or instructions, not in the authority declaration.',
    'Every capabilities entry must exactly match a tool, Skill, or MCP capability name present in the planning context.',
    'Use dependencies for causal ordering and conflictKeys=["workspace"] for write steps that may overlap.',
    'Every step must include a schema success criterion. You may add file, digest, rule, or semantic criteria only when they can be evidenced.',
    'Do not emit command or check criteria: this product path does not expose a parent-side named-check registry.',
    'Prefer focused steps. Do not add a final step that repeats work already completed by another step.',
    `Objective: ${input.objective}`,
    `Planning context: ${JSON.stringify(input.context ?? {})}`,
  ].join('\n')
}

function plannerInstructions(nativeSchema: boolean, promptVariant: PromptVariant): string {
  const contract = nativeSchema
    ? 'Return only the strict JSON plan proposal. Do not use Markdown or explanatory prose.'
    : `Call ${SUBMIT_PLAN_TOOL} exactly once with the complete plan. Do not emit explanatory prose.`
  return promptVariant === 'iron-law-lean-v1'
    ? composeLeanTrustedInstructions([contract])
    : contract
}

function planSubmissionTool(input: PlanGeneratorModelInputV1): ProviderToolDefinition {
  return {
    name: SUBMIT_PLAN_TOOL,
    description: 'Submit the complete bounded Supervisor plan proposal.',
    parameters: input.responseFormat.schema,
  }
}

function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 3)
}
