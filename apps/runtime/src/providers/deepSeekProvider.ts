import { contentText, providerToolCalls, reasoningText } from '@praxis/core-sdk'
import { OpenAICompatibleProvider } from './openAiCompatibleProvider.js'
import type { ProviderCapabilities, ProviderRequest } from './types.js'

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

const capabilities: ProviderCapabilities = {
  streaming: { text: true, reasoning: true, usage: true },
  tools: { mode: 'native', parallelCalls: true },
  modalities: { text: true, vision: false, audio: false },
  // DeepSeek V4 exposes json_object and strict Tool schemas, but not the
  // OpenAI response_format=json_schema contract used by Praxis.
  output: { jsonSchema: false, citations: false },
  limits: { maxContextTokens: 1_000_000, maxOutputTokens: 384 * 1_024 },
}

/** DeepSeek V4 over its OpenAI Chat Completions-compatible endpoint. */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(
    apiKey = process.env.DEEPSEEK_API_KEY,
    baseURL = process.env.PRAXIS_DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE_URL,
  ) {
    super({
      id: 'deepseek',
      apiKey,
      baseURL,
      defaultModel: 'deepseek-v4-flash',
      accountLabel: 'DEEPSEEK_API_KEY',
      capabilities,
      timeoutMs: configuredTimeout(process.env.PRAXIS_DEEPSEEK_TIMEOUT_MS),
      noProgressTimeoutMs: configuredTimeout(process.env.PRAXIS_DEEPSEEK_NO_PROGRESS_TIMEOUT_MS),
    })
  }

  protected override requestBodyDefaults(request: ProviderRequest): Record<string, unknown> {
    return deepSeekReasoningBody(request)
  }

  protected override messageBodyExtras(
    message: ProviderRequest['messages'][number],
    request: ProviderRequest,
  ): Record<string, unknown> {
    const reasoning = deepSeekReasoningBody(request)
    if (
      message.role !== 'assistant' ||
      providerToolCalls(message).length === 0 ||
      (reasoning.thinking as { type?: string }).type !== 'enabled'
    ) {
      return {}
    }
    // DeepSeek thinking-mode Tool calls require both non-null assistant content
    // and the exact reasoning_content to be replayed on every following turn.
    return {
      content: contentText(message.content),
      reasoning_content: reasoningText(message.content),
    }
  }
}

export function deepSeekReasoningBody(
  request: Pick<ProviderRequest, 'reasoning' | 'toolChoice'>,
): Record<string, unknown> {
  const disabled =
    request.reasoning?.mode === 'compact' ||
    request.reasoning?.effort === 'none' ||
    request.toolChoice !== undefined
  return disabled
    ? { thinking: { type: 'disabled' as const } }
    : { thinking: { type: 'enabled' as const }, reasoning_effort: 'high' as const }
}

function configuredTimeout(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1_000 ? parsed : undefined
}
