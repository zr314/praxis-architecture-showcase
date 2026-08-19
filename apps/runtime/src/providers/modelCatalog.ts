import type { ProviderCapabilities } from '@praxis/core-sdk'
import { MINIMAX_PROVIDER_CONFIGURATIONS } from './minimaxConfig.js'

export const MODEL_CATALOG_VERSION = 1 as const

export type ModelPricing = {
  inputPerMillionUsd?: number
  outputPerMillionUsd?: number
  cacheReadPerMillionUsd?: number
  cacheWritePerMillionUsd?: number
}

export type ModelCompatibility = {
  disableParallelToolCalls?: boolean
  omitStreamUsage?: boolean
  reasoningField?: string
}

export type ModelLifecycle = 'active' | 'deprecated'

export type CatalogSourceRecord = {
  provider: string
  retrievedAt: string
  origin: string
  apiFamily: ModelDescriptor['family']
  defaultModel: string
}

export type ModelDescriptor = {
  catalogVersion: typeof MODEL_CATALOG_VERSION
  provider: string
  id: string
  name: string
  family: 'anthropic-messages' | 'openai-responses' | 'openai-chat' | 'mock'
  capabilities: ProviderCapabilities
  reasoningLevels: Array<'none' | 'low' | 'medium' | 'high'>
  pricing: ModelPricing
  aliases: string[]
  lifecycle: ModelLifecycle
  source: string
  retrievedAt: string
  compatibility?: ModelCompatibility
}

const textToolCapabilities = (
  maxContextTokens: number,
  maxOutputTokens: number,
  options: {
    reasoning?: boolean
    vision?: boolean
    jsonSchema?: boolean
    citations?: boolean
  } = {},
): ProviderCapabilities => ({
  streaming: { text: true, reasoning: options.reasoning ?? false, usage: true },
  tools: { mode: 'native', parallelCalls: true },
  modalities: { text: true, vision: options.vision ?? false, audio: false },
  output: {
    jsonSchema: options.jsonSchema ?? false,
    citations: options.citations ?? false,
  },
  limits: { maxContextTokens, maxOutputTokens },
})

type ModelSpec = readonly [
  id: string,
  name: string,
  contextTokens: number,
  outputTokens: number,
  reasoning: boolean,
  vision: boolean,
]

function catalogModels(
  provider: string,
  family: ModelDescriptor['family'],
  specs: readonly ModelSpec[],
  output: { jsonSchema?: boolean; citations?: boolean } = {},
): ModelDescriptor[] {
  const source = sourceFor(provider)
  return specs.map(([id, name, contextTokens, outputTokens, reasoning, vision]) => ({
    catalogVersion: MODEL_CATALOG_VERSION,
    provider,
    id,
    name,
    family,
    capabilities: textToolCapabilities(contextTokens, outputTokens, {
      reasoning,
      vision,
      jsonSchema: output.jsonSchema,
      citations: output.citations,
    }),
    reasoningLevels: reasoning ? ['none', 'low', 'medium', 'high'] : ['none'],
    pricing: {},
    aliases: [],
    lifecycle: 'active',
    source: source.origin,
    retrievedAt: source.retrievedAt,
  }))
}

// Reviewed static snapshot aligned with Pi's generated models.dev catalogs.
export const MODEL_CATALOG_SOURCES: readonly CatalogSourceRecord[] = [
  {
    provider: 'mock',
    retrievedAt: '2026-07-29',
    origin: 'Praxis deterministic fixture',
    apiFamily: 'mock',
    defaultModel: 'mock-v1',
  },
  {
    provider: 'kimi',
    retrievedAt: '2026-07-27',
    origin: 'models.dev via Pi moonshotai-cn generated catalog',
    apiFamily: 'openai-chat',
    defaultModel: 'kimi-k2.6',
  },
  {
    provider: 'deepseek',
    retrievedAt: '2026-08-08',
    origin: 'DeepSeek V4 official API documentation reviewed snapshot',
    apiFamily: 'openai-chat',
    defaultModel: 'deepseek-v4-flash',
  },
  {
    provider: 'openai',
    retrievedAt: '2026-07-27',
    origin: 'models.dev via Pi OpenAI generated catalog',
    apiFamily: 'openai-responses',
    defaultModel: 'gpt-5.2',
  },
  {
    provider: 'openai-chat',
    retrievedAt: '2026-07-27',
    origin: 'Praxis reviewed OpenAI Chat compatibility subset',
    apiFamily: 'openai-chat',
    defaultModel: 'gpt-4.1',
  },
  {
    provider: 'anthropic',
    retrievedAt: '2026-07-27',
    origin: 'models.dev via Pi Anthropic generated catalog',
    apiFamily: 'anthropic-messages',
    defaultModel: 'claude-sonnet-4-6',
  },
  {
    provider: 'qwen-token-plan',
    retrievedAt: '2026-07-27',
    origin: 'Pi generated Qwen Token Plan catalog',
    apiFamily: 'openai-chat',
    defaultModel: 'qwen3.7-max',
  },
  {
    provider: 'qwen-token-plan-cn',
    retrievedAt: '2026-07-27',
    origin: 'Pi generated Qwen Token Plan China catalog',
    apiFamily: 'openai-chat',
    defaultModel: 'qwen3.7-max',
  },
  ...MINIMAX_PROVIDER_CONFIGURATIONS.map(({ id, catalogOrigin, defaultModel }) => ({
    provider: id,
    retrievedAt: '2026-07-27',
    origin: catalogOrigin,
    apiFamily: 'anthropic-messages' as const,
    defaultModel,
  })),
  {
    provider: 'openai-compatible',
    retrievedAt: '2026-07-29',
    origin: 'Praxis local endpoint configuration',
    apiFamily: 'openai-chat',
    defaultModel: 'local-model',
  },
] as const

const KIMI_MODELS: readonly ModelSpec[] = [
  ['kimi-k2-0711-preview', 'Kimi K2 0711', 131_072, 16_384, false, false],
  ['kimi-k2-0905-preview', 'Kimi K2 0905', 262_144, 262_144, false, false],
  ['kimi-k2-thinking', 'Kimi K2 Thinking', 262_144, 262_144, true, false],
  ['kimi-k2-thinking-turbo', 'Kimi K2 Thinking Turbo', 262_144, 262_144, true, false],
  ['kimi-k2-turbo-preview', 'Kimi K2 Turbo', 262_144, 262_144, false, false],
  ['kimi-k2.5', 'Kimi K2.5', 262_144, 262_144, true, true],
  ['kimi-k2.6', 'Kimi K2.6', 262_144, 262_144, true, true],
  ['kimi-k2.7-code', 'Kimi K2.7 Code', 262_144, 262_144, true, true],
  ['kimi-k2.7-code-highspeed', 'Kimi K2.7 Code HighSpeed', 262_144, 262_144, true, true],
  ['kimi-k3', 'Kimi K3', 1_048_576, 131_072, true, true],
]

const DEEPSEEK_MODELS: readonly ModelSpec[] = [
  ['deepseek-v4-flash', 'DeepSeek V4 Flash', 1_000_000, 384 * 1_024, true, false],
  ['deepseek-v4-pro', 'DeepSeek V4 Pro', 1_000_000, 384 * 1_024, true, false],
]

const ANTHROPIC_MODELS: readonly ModelSpec[] = [
  ['claude-fable-5', 'Claude Fable 5', 1_000_000, 128_000, true, true],
  ['claude-haiku-4-5', 'Claude Haiku 4.5 (latest)', 200_000, 64_000, true, true],
  ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200_000, 64_000, true, true],
  ['claude-opus-4-1', 'Claude Opus 4.1 (latest)', 200_000, 32_000, true, true],
  ['claude-opus-4-1-20250805', 'Claude Opus 4.1', 200_000, 32_000, true, true],
  ['claude-opus-4-5', 'Claude Opus 4.5 (latest)', 200_000, 64_000, true, true],
  ['claude-opus-4-5-20251101', 'Claude Opus 4.5', 200_000, 64_000, true, true],
  ['claude-opus-4-6', 'Claude Opus 4.6', 1_000_000, 128_000, true, true],
  ['claude-opus-4-7', 'Claude Opus 4.7', 1_000_000, 128_000, true, true],
  ['claude-opus-4-8', 'Claude Opus 4.8', 1_000_000, 128_000, true, true],
  ['claude-opus-5', 'Claude Opus 5', 1_000_000, 128_000, true, true],
  ['claude-sonnet-4-5', 'Claude Sonnet 4.5 (latest)', 1_000_000, 64_000, true, true],
  ['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 1_000_000, 64_000, true, true],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6', 1_000_000, 128_000, true, true],
  ['claude-sonnet-5', 'Claude Sonnet 5', 1_000_000, 128_000, true, true],
]

const OPENAI_MODELS: readonly ModelSpec[] = [
  ['gpt-4', 'GPT-4', 8_192, 8_192, false, false],
  ['gpt-4-turbo', 'GPT-4 Turbo', 128_000, 4_096, false, true],
  ['gpt-4.1', 'GPT-4.1', 1_047_576, 32_768, false, true],
  ['gpt-4.1-mini', 'GPT-4.1 mini', 1_047_576, 32_768, false, true],
  ['gpt-4.1-nano', 'GPT-4.1 nano', 1_047_576, 32_768, false, true],
  ['gpt-4o', 'GPT-4o', 128_000, 16_384, false, true],
  ['gpt-4o-2024-05-13', 'GPT-4o (2024-05-13)', 128_000, 4_096, false, true],
  ['gpt-4o-2024-08-06', 'GPT-4o (2024-08-06)', 128_000, 16_384, false, true],
  ['gpt-4o-2024-11-20', 'GPT-4o (2024-11-20)', 128_000, 16_384, false, true],
  ['gpt-4o-mini', 'GPT-4o mini', 128_000, 16_384, false, true],
  ['gpt-5', 'GPT-5', 400_000, 128_000, true, true],
  ['gpt-5-chat-latest', 'GPT-5 Chat Latest', 128_000, 16_384, false, true],
  ['gpt-5-mini', 'GPT-5 Mini', 400_000, 128_000, true, true],
  ['gpt-5-nano', 'GPT-5 Nano', 400_000, 128_000, true, true],
  ['gpt-5-pro', 'GPT-5 Pro', 400_000, 128_000, true, true],
  ['gpt-5.1', 'GPT-5.1', 400_000, 128_000, true, true],
  ['gpt-5.2', 'GPT-5.2', 400_000, 128_000, true, true],
  ['gpt-5.2-chat-latest', 'GPT-5.2 Chat', 128_000, 16_384, true, true],
  ['gpt-5.2-pro', 'GPT-5.2 Pro', 400_000, 128_000, true, true],
  ['gpt-5.3-chat-latest', 'GPT-5.3 Chat (latest)', 128_000, 16_384, false, true],
  ['gpt-5.3-codex', 'GPT-5.3 Codex', 400_000, 128_000, true, true],
  ['gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark', 128_000, 32_000, true, true],
  ['gpt-5.4', 'GPT-5.4', 272_000, 128_000, true, true],
  ['gpt-5.4-mini', 'GPT-5.4 mini', 400_000, 128_000, true, true],
  ['gpt-5.4-nano', 'GPT-5.4 nano', 400_000, 128_000, true, true],
  ['gpt-5.4-pro', 'GPT-5.4 Pro', 1_050_000, 128_000, true, true],
  ['gpt-5.5', 'GPT-5.5', 272_000, 128_000, true, true],
  ['gpt-5.5-pro', 'GPT-5.5 Pro', 1_050_000, 128_000, true, true],
  ['gpt-5.6-luna', 'GPT-5.6 Luna', 272_000, 128_000, true, true],
  ['gpt-5.6-sol', 'GPT-5.6 Sol', 272_000, 128_000, true, true],
  ['gpt-5.6-terra', 'GPT-5.6 Terra', 272_000, 128_000, true, true],
  ['gpt-realtime-2.1', 'GPT-Realtime-2.1', 128_000, 32_000, true, true],
  ['o1', 'o1', 200_000, 100_000, true, true],
  ['o1-pro', 'o1-pro', 200_000, 100_000, true, true],
  ['o3', 'o3', 200_000, 100_000, true, true],
  ['o3-mini', 'o3-mini', 200_000, 100_000, true, false],
  ['o3-pro', 'o3-pro', 200_000, 100_000, true, true],
  ['o4-mini', 'o4-mini', 200_000, 100_000, true, true],
]

const QWEN_TOKEN_PLAN_MODELS: readonly ModelSpec[] = [
  ['qwen3.6-flash', 'Qwen3.6 Flash', 1_000_000, 65_536, true, true],
  ['qwen3.6-plus', 'Qwen3.6 Plus', 1_000_000, 65_536, true, true],
  ['qwen3.7-max', 'Qwen3.7 Max', 1_000_000, 131_072, true, false],
  ['qwen3.7-plus', 'Qwen3.7 Plus', 1_000_000, 65_536, true, true],
  ['qwen3.8-max-preview', 'Qwen3.8 Max Preview', 1_000_000, 131_072, true, true],
]

const MINIMAX_MODELS: readonly ModelSpec[] = [
  ['MiniMax-M2.7', 'MiniMax-M2.7', 204_800, 131_072, true, false],
  ['MiniMax-M2.7-highspeed', 'MiniMax-M2.7 Highspeed', 204_800, 131_072, true, false],
  ['MiniMax-M3', 'MiniMax-M3', 1_000_000, 128_000, true, true],
]

const BUILTIN_MODELS: ModelDescriptor[] = [
  {
    catalogVersion: MODEL_CATALOG_VERSION,
    provider: 'mock',
    id: 'mock-v1',
    name: 'Mock v1',
    family: 'mock',
    capabilities: textToolCapabilities(128_000, 16_384),
    reasoningLevels: ['none'],
    pricing: {},
    aliases: [],
    lifecycle: 'active',
    source: sourceFor('mock').origin,
    retrievedAt: sourceFor('mock').retrievedAt,
  },
  ...catalogModels('kimi', 'openai-chat', KIMI_MODELS),
  ...catalogModels('deepseek', 'openai-chat', DEEPSEEK_MODELS),
  ...catalogModels('openai', 'openai-responses', OPENAI_MODELS, {
    jsonSchema: true,
    citations: true,
  }),
  ...catalogModels('anthropic', 'anthropic-messages', ANTHROPIC_MODELS, {
    citations: true,
  }),
  ...catalogModels('qwen-token-plan', 'openai-chat', QWEN_TOKEN_PLAN_MODELS),
  ...catalogModels('qwen-token-plan-cn', 'openai-chat', QWEN_TOKEN_PLAN_MODELS),
  ...MINIMAX_PROVIDER_CONFIGURATIONS.flatMap(({ id }) =>
    catalogModels(id, 'anthropic-messages', MINIMAX_MODELS),
  ),
  {
    catalogVersion: MODEL_CATALOG_VERSION,
    provider: 'openai-compatible',
    id: 'local-model',
    name: 'Local model',
    family: 'openai-chat',
    capabilities: textToolCapabilities(128_000, 16_384),
    reasoningLevels: ['none', 'low', 'medium', 'high'],
    pricing: {},
    aliases: [],
    lifecycle: 'active',
    source: sourceFor('openai-compatible').origin,
    retrievedAt: sourceFor('openai-compatible').retrievedAt,
    compatibility: { omitStreamUsage: false },
  },
  ...catalogModels(
    'openai-chat',
    'openai-chat',
    OPENAI_MODELS.filter(([id]) =>
      ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini'].includes(id),
    ),
    { jsonSchema: true },
  ),
]

export class ModelCatalog {
  readonly version = MODEL_CATALOG_VERSION
  readonly #models = new Map<string, ModelDescriptor>()

  constructor(models: Iterable<ModelDescriptor> = BUILTIN_MODELS) {
    for (const model of models) this.#register(model)
    this.#validateSources()
  }

  #register(model: ModelDescriptor): void {
    if (model.catalogVersion !== MODEL_CATALOG_VERSION) {
      throw new Error(`Unsupported model catalog version: ${model.catalogVersion}.`)
    }
    if (this.#models.has(key(model.provider, model.id))) {
      throw new Error(`Duplicate model catalog entry: ${model.provider}/${model.id}.`)
    }
    if (!MODEL_CATALOG_SOURCES.some(({ provider }) => provider === model.provider)) {
      throw new Error(`Model catalog source is missing for provider: ${model.provider}.`)
    }
    const context = model.capabilities.limits.maxContextTokens
    const output = model.capabilities.limits.maxOutputTokens
    if (
      context === undefined ||
      output === undefined ||
      !Number.isFinite(context) ||
      !Number.isFinite(output) ||
      context <= 0 ||
      output <= 0
    ) {
      throw new Error(`Model limits must be positive: ${model.provider}/${model.id}.`)
    }
    this.#models.set(key(model.provider, model.id), cloneDescriptor(model))
  }

  resolve(provider: string, model: string): ModelDescriptor | undefined {
    const found = this.#models.get(key(provider, model))
    return found ? cloneDescriptor(found) : undefined
  }

  list(provider?: string): ModelDescriptor[] {
    return [...this.#models.values()]
      .filter((model) => provider === undefined || model.provider === provider)
      .map(cloneDescriptor)
  }

  withCompatibility(
    provider: string,
    model: string,
    compatibility: ModelCompatibility,
  ): ModelDescriptor | undefined {
    const found = this.resolve(provider, model)
    return found
      ? { ...found, compatibility: { ...found.compatibility, ...compatibility } }
      : undefined
  }

  sources(): Array<CatalogSourceRecord & { modelIds: string[] }> {
    return MODEL_CATALOG_SOURCES.map((source) => ({
      ...source,
      modelIds: this.list(source.provider).map(({ id }) => id),
    }))
  }

  #validateSources(): void {
    for (const source of MODEL_CATALOG_SOURCES) {
      const models = this.list(source.provider)
      if (models.length === 0) {
        throw new Error(`Model catalog source has no models: ${source.provider}.`)
      }
      if (!models.some(({ id }) => id === source.defaultModel)) {
        throw new Error(
          `Default model is missing from catalog: ${source.provider}/${source.defaultModel}.`,
        )
      }
      if (models.some(({ family }) => family !== source.apiFamily)) {
        throw new Error(`Model API family mismatch for provider: ${source.provider}.`)
      }
    }
  }
}

function key(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

function cloneDescriptor(model: ModelDescriptor): ModelDescriptor {
  return {
    ...model,
    capabilities: {
      streaming: { ...model.capabilities.streaming },
      tools: { ...model.capabilities.tools },
      modalities: { ...model.capabilities.modalities },
      output: { ...model.capabilities.output },
      limits: { ...model.capabilities.limits },
    },
    reasoningLevels: [...model.reasoningLevels],
    pricing: { ...model.pricing },
    aliases: [...model.aliases],
    ...(model.compatibility ? { compatibility: { ...model.compatibility } } : {}),
  }
}

function sourceFor(provider: string): CatalogSourceRecord {
  const source = MODEL_CATALOG_SOURCES.find((candidate) => candidate.provider === provider)
  if (!source) throw new Error(`Model catalog source is missing for provider: ${provider}.`)
  return source
}
