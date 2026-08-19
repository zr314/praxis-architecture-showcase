import type { ProviderMessage } from '@praxis/core-sdk'

export interface TokenizerAdapter {
  readonly id: string
  countText(value: string): number
  countMessage(message: ProviderMessage): number
}

abstract class BaseTokenizer implements TokenizerAdapter {
  abstract readonly id: string
  abstract countText(value: string): number

  countMessage(message: ProviderMessage): number {
    return this.countText(
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
  }
}

export class ConservativeTokenizer extends BaseTokenizer {
  readonly id = 'conservative-utf8'

  countText(value: string): number {
    return value.length === 0 ? 0 : Math.ceil(Buffer.byteLength(value, 'utf8') / 2)
  }
}

export class OpenAiCompatibleTokenizer extends BaseTokenizer {
  readonly id = 'openai-compatible-heuristic'

  countText(value: string): number {
    if (value.length === 0) return 0
    const bytes = Buffer.byteLength(value, 'utf8')
    const nonAscii = [...value].filter((character) => character.codePointAt(0)! > 127).length
    return Math.ceil((bytes + nonAscii * 2) / 4)
  }
}

export class DeterministicTestTokenizer extends BaseTokenizer {
  readonly id = 'deterministic-test'

  countText(value: string): number {
    return value.length === 0 ? 0 : Math.ceil(value.length / 4)
  }
}

const conservative = new ConservativeTokenizer()
const openAiCompatible = new OpenAiCompatibleTokenizer()
const deterministic = new DeterministicTestTokenizer()

export function tokenizerForProvider(providerId: string): TokenizerAdapter {
  if (providerId === 'mock' || providerId === 'replay') return deterministic
  if (
    providerId === 'kimi' ||
    providerId === 'deepseek' ||
    providerId === 'openai' ||
    providerId === 'openai-chat' ||
    providerId === 'openai-compatible' ||
    providerId === 'qwen-token-plan' ||
    providerId === 'qwen-token-plan-cn'
  ) {
    return openAiCompatible
  }
  return conservative
}
