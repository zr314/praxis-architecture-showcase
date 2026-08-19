export type MiniMaxProviderId = 'minimax' | 'minimax-cn'

export type MiniMaxProviderConfiguration = Readonly<{
  id: MiniMaxProviderId
  apiKeyEnvironmentVariable: 'MINIMAX_API_KEY' | 'MINIMAX_CN_API_KEY'
  baseURL: string
  defaultModel: 'MiniMax-M2.7'
  catalogOrigin: string
}>

/** Single source of truth for every regional MiniMax registration surface. */
export const MINIMAX_PROVIDER_CONFIGURATIONS: readonly MiniMaxProviderConfiguration[] =
  Object.freeze([
    Object.freeze({
      id: 'minimax',
      apiKeyEnvironmentVariable: 'MINIMAX_API_KEY',
      baseURL: 'https://api.minimax.io/anthropic',
      defaultModel: 'MiniMax-M2.7',
      catalogOrigin: 'models.dev via Pi MiniMax generated catalog',
    }),
    Object.freeze({
      id: 'minimax-cn',
      apiKeyEnvironmentVariable: 'MINIMAX_CN_API_KEY',
      baseURL: 'https://api.minimaxi.com/anthropic',
      defaultModel: 'MiniMax-M2.7',
      catalogOrigin: 'models.dev via Pi MiniMax China generated catalog',
    }),
  ])
