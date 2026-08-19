import type { ChatProvider, ProviderCapabilities } from './types.js'
import { OpenAICompatibleProvider } from './openAiCompatibleProvider.js'

const capabilities: ProviderCapabilities = {
  streaming: { text: true, reasoning: true, usage: true },
  tools: { mode: 'native', parallelCalls: true },
  modalities: { text: true, vision: false, audio: false },
  output: { jsonSchema: false, citations: false },
  limits: { maxContextTokens: 1_000_000, maxOutputTokens: 131_072 },
}

/** Regional Qwen Token Plan endpoints use the OpenAI Chat Completions protocol. */
export function createQwenTokenPlanProviders(
  environment: NodeJS.ProcessEnv = process.env,
): ChatProvider[] {
  return [
    new OpenAICompatibleProvider({
      id: 'qwen-token-plan',
      apiKey: environment.QWEN_TOKEN_PLAN_API_KEY,
      baseURL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      defaultModel: 'qwen3.7-max',
      accountLabel: 'QWEN_TOKEN_PLAN_API_KEY',
      capabilities,
      defaultBody: { enable_thinking: false },
    }),
    new OpenAICompatibleProvider({
      id: 'qwen-token-plan-cn',
      apiKey: environment.QWEN_TOKEN_PLAN_CN_API_KEY,
      baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      defaultModel: 'qwen3.7-max',
      accountLabel: 'QWEN_TOKEN_PLAN_CN_API_KEY',
      capabilities,
      defaultBody: { enable_thinking: false },
    }),
  ]
}
