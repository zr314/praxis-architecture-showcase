import type { ChatProvider } from '@praxis/core-sdk'
import { AnthropicProvider } from '../providers/anthropicProvider.js'
import { DeepSeekProvider } from '../providers/deepSeekProvider.js'
import { KimiProvider } from '../providers/kimiProvider.js'
import { MockProvider } from '../providers/mockProvider.js'
import { createMiniMaxProviders } from '../providers/minimaxProvider.js'
import {
  createLocalOpenAICompatibleProvider,
  OpenAICompatibleProvider,
} from '../providers/openAiCompatibleProvider.js'
import { OpenAIResponsesProvider } from '../providers/openAIResponsesProvider.js'
import { createQwenTokenPlanProviders } from '../providers/qwenTokenPlanProvider.js'

export function createBuiltinProviders(): ChatProvider[] {
  return [
    new MockProvider(),
    new KimiProvider(),
    new DeepSeekProvider(),
    new AnthropicProvider(),
    new OpenAIResponsesProvider(),
    ...createQwenTokenPlanProviders(),
    ...createMiniMaxProviders(),
    createLocalOpenAICompatibleProvider(),
    new OpenAICompatibleProvider({
      id: 'openai-chat',
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      defaultModel: process.env.OPENAI_CHAT_MODEL ?? 'gpt-4.1',
      accountLabel: 'OPENAI_API_KEY',
    }),
  ]
}
