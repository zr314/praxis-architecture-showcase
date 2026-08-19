import { OpenAICompatibleProvider } from './openAiCompatibleProvider.js'
import type { ProviderCapabilities, ProviderRequest } from './types.js'

const KIMI_BASE_URL = 'https://api.moonshot.cn/v1'
const capabilities: ProviderCapabilities = {
  streaming: { text: true, reasoning: true, usage: true },
  tools: { mode: 'native', parallelCalls: true },
  modalities: { text: true, vision: false, audio: false },
  output: { jsonSchema: false, citations: false },
  limits: { maxContextTokens: 256_000, maxOutputTokens: 32_768 },
}

/** Kimi is an OpenAI-compatible configuration, not a separate protocol family. */
export class KimiProvider extends OpenAICompatibleProvider {
  constructor(
    apiKey = process.env.MOONSHOT_API_KEY,
    baseURL = process.env.PRAXIS_KIMI_BASE_URL ?? KIMI_BASE_URL,
  ) {
    super({
      id: 'kimi',
      apiKey,
      baseURL,
      defaultModel: 'kimi-k2.6',
      accountLabel: 'MOONSHOT_API_KEY',
      capabilities,
      timeoutMs: configuredTimeout(process.env.PRAXIS_KIMI_TIMEOUT_MS),
      noProgressTimeoutMs: configuredTimeout(process.env.PRAXIS_KIMI_NO_PROGRESS_TIMEOUT_MS),
    })
  }

  protected override requestBodyDefaults(request: ProviderRequest): Record<string, unknown> {
    return {
      ...super.requestBodyDefaults(request),
      ...kimiReasoningBody(request),
    }
  }
}

function configuredTimeout(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1_000 ? parsed : undefined
}

export function kimiReasoningBody(request: Pick<ProviderRequest, 'model' | 'reasoning'>) {
  return request.reasoning?.mode === 'compact' && ['kimi-k2.5', 'kimi-k2.6'].includes(request.model)
    ? { thinking: { type: 'disabled' as const } }
    : {}
}
