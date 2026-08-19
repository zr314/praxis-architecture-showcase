import type { ChatProvider, ProviderCapabilities } from './types.js'
import { AnthropicProvider } from './anthropicProvider.js'
import { MINIMAX_PROVIDER_CONFIGURATIONS } from './minimaxConfig.js'

const capabilities: ProviderCapabilities = {
  streaming: { text: true, reasoning: true, usage: true },
  tools: { mode: 'native', parallelCalls: true },
  modalities: { text: true, vision: false, audio: false },
  output: { jsonSchema: false, citations: false },
  limits: { maxContextTokens: 1_000_000, maxOutputTokens: 131_072 },
}

/** Regional MiniMax endpoints use the Anthropic Messages protocol. */
export function createMiniMaxProviders(
  environment: NodeJS.ProcessEnv = process.env,
): ChatProvider[] {
  return MINIMAX_PROVIDER_CONFIGURATIONS.map(
    ({ id, apiKeyEnvironmentVariable, baseURL, defaultModel }) =>
      new AnthropicProvider({
        id,
        apiKey: environment[apiKeyEnvironmentVariable],
        baseURL,
        defaultModel,
        accountLabel: apiKeyEnvironmentVariable,
        capabilities,
      }),
  )
}
