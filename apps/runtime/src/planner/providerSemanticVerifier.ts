import type { ChatProvider, PromptVariant, ProviderToolDefinition } from '@praxis/core-sdk'
import { composeLeanTrustedInstructions, DEFAULT_PROMPT_VARIANT } from '../prompt/promptRegistry.js'
import type {
  SemanticVerifierModelInputV1,
  SemanticVerifierModelOutputV1,
  SemanticVerifierModelPortV1,
} from './verifier.js'
import { parseProviderJsonV1 } from './providerStructuredOutput.js'

const SUBMIT_VERIFICATION_TOOL = 'submit_semantic_verification'

/** Runs the fresh-context semantic judge through the selected product Provider. */
export class ProviderSemanticVerifierModelPortV1 implements SemanticVerifierModelPortV1 {
  readonly identity: Readonly<{ kind: 'model'; id: string }>

  constructor(
    private readonly provider: ChatProvider,
    private readonly model: string,
    private readonly promptVariant: PromptVariant = DEFAULT_PROMPT_VARIANT,
  ) {
    this.identity = Object.freeze({ kind: 'model', id: `${provider.id}/${model}` })
  }

  async verify(input: SemanticVerifierModelInputV1): Promise<SemanticVerifierModelOutputV1> {
    const nativeSchema = this.provider.capabilities?.output.jsonSchema === true
    const prompt = semanticPrompt(input)
    let text = ''
    const argumentsByIndex = new Map<number, string>()
    let submitted: unknown
    let inputTokens = estimateTokens(prompt)
    let outputTokens = 0
    let costUsd = 0

    for await (const chunk of this.provider.stream({
      model: this.model,
      messages: [{ role: 'user', content: prompt, intent: 'context', trust: 'low' }],
      tools: nativeSchema ? [] : [verificationTool(input)],
      ...(nativeSchema ? {} : { toolChoice: { name: SUBMIT_VERIFICATION_TOOL } }),
      instructions: verifierInstructions(nativeSchema, this.promptVariant),
      signal: input.signal,
      maxOutputTokens: input.maxOutputTokens,
      ...(nativeSchema ? { responseFormat: input.responseFormat } : {}),
    })) {
      if (chunk.type === 'text_delta') text += chunk.text
      if (chunk.type === 'tool_call_start' && chunk.name === SUBMIT_VERIFICATION_TOOL) {
        argumentsByIndex.set(chunk.index, '')
      }
      if (chunk.type === 'tool_call_delta' && argumentsByIndex.has(chunk.index)) {
        argumentsByIndex.set(
          chunk.index,
          `${argumentsByIndex.get(chunk.index)}${chunk.argumentsDelta}`,
        )
      }
      if (chunk.type === 'tool_call_end' && argumentsByIndex.has(chunk.index)) {
        submitted = chunk.input ?? parseProviderJsonV1(argumentsByIndex.get(chunk.index) ?? '')
      }
      if (chunk.type === 'completed') {
        inputTokens = chunk.usage?.inputTokens ?? inputTokens
        outputTokens = chunk.usage?.outputTokens ?? estimateTokens(text)
        costUsd = chunk.usage?.costUsd ?? 0
      }
    }

    if (submitted === undefined) {
      const toolArguments = [...argumentsByIndex.values()].at(-1)
      submitted = toolArguments === undefined ? undefined : parseProviderJsonV1(toolArguments)
    }
    return Object.freeze({
      output: submitted ?? parseProviderJsonV1(text),
      usage: Object.freeze({ inputTokens, outputTokens, costUsd }),
    })
  }
}

function verifierInstructions(nativeSchema: boolean, promptVariant: PromptVariant): string {
  const contract = nativeSchema
    ? 'Return only the strict JSON verification. Do not use Markdown.'
    : `Call ${SUBMIT_VERIFICATION_TOOL} exactly once. Do not emit prose.`
  return promptVariant === 'iron-law-lean-v1'
    ? composeLeanTrustedInstructions([contract])
    : contract
}

function semanticPrompt(input: SemanticVerifierModelInputV1): string {
  return [
    'Act as a fresh-context semantic verifier for one admitted Supervisor step.',
    'Judge every semantic criterion independently using only the supplied result and evidence references.',
    'Never invent an evidence reference. Every returned evidenceRefs entry must exactly match an available reference.',
    `Criteria: ${JSON.stringify(input.criteria)}`,
    `Worker result: ${JSON.stringify(input.result)}`,
  ].join('\n')
}

function verificationTool(input: SemanticVerifierModelInputV1): ProviderToolDefinition {
  return {
    name: SUBMIT_VERIFICATION_TOOL,
    description: 'Submit evidence-bound semantic verification decisions.',
    parameters: input.responseFormat.schema,
  }
}

function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, 'utf8') / 3)
}
