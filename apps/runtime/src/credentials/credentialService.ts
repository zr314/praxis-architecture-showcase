import type { ChatProvider, ProviderAuthState } from '../providers/types.js'
import { MINIMAX_PROVIDER_CONFIGURATIONS } from '../providers/minimaxConfig.js'
import type {
  CredentialProtectionStatus,
  CredentialStore,
  StoredCredential,
} from './credentialStore.js'

export type LoginResult = {
  loginId: string
  action?: { action: 'device_code' | 'open_url'; url?: string; deviceCode?: string }
  state: ProviderAuthState
}

export type ProviderResolver = (
  providerId: string,
) => ChatProvider | undefined | Promise<ChatProvider | undefined>

export type CredentialRefreshResult = {
  value: string
  expiresAt?: string
}

export type CredentialRefresher = (
  credential: Readonly<StoredCredential>,
) => Promise<CredentialRefreshResult>

export type CredentialServiceOptions = {
  store?: CredentialStore
  environment?: NodeJS.ProcessEnv
  environmentNames?: Record<string, Record<string, string>>
}

export type CredentialStatusDetails = {
  state: ProviderAuthState
  source?: 'stored' | 'environment' | 'provider'
  environmentVariable?: string
  protection?: CredentialProtectionStatus
}

export class CredentialService {
  private readonly loggedOutProviders = new Set<string>()
  private readonly hydratedProviders = new Set<string>()
  private readonly credentialSources = new Map<string, 'stored' | 'environment'>()
  private readonly refreshers = new Map<string, CredentialRefresher>()
  private readonly store?: CredentialStore
  private readonly environment: NodeJS.ProcessEnv
  private readonly environmentNames: Record<string, Record<string, string>>

  constructor(
    private readonly resolveProvider: ProviderResolver,
    options: CredentialServiceOptions = {},
  ) {
    this.store = options.store
    this.environment = options.environment ?? process.env
    this.environmentNames = options.environmentNames ?? DEFAULT_ENVIRONMENT_NAMES
  }

  async status(providerId: string): Promise<ProviderAuthState> {
    const provider = await this.requireProvider(providerId)
    if (this.loggedOutProviders.has(providerId)) return { status: 'unauthenticated' }
    await this.hydrateProvider(provider)
    const state = provider.authState()
    const source = this.credentialSources.get(providerId)
    if (state.status !== 'authenticated' || source === undefined) return state
    return {
      ...state,
      accountLabel:
        source === 'stored'
          ? 'Stored credential'
          : (this.environmentNames[providerId]?.apiKey ?? 'Environment'),
    }
  }

  async details(providerId: string): Promise<CredentialStatusDetails> {
    const state = await this.status(providerId)
    const source =
      state.status === 'authenticated'
        ? (this.credentialSources.get(providerId) ?? 'provider')
        : undefined
    const environmentVariable = this.environmentNames[providerId]?.apiKey
    const protection = await this.store?.protectionStatus?.()
    return {
      state,
      ...(source ? { source } : {}),
      ...(environmentVariable ? { environmentVariable } : {}),
      ...(protection ? { protection } : {}),
    }
  }

  async login(providerId: string, apiKey?: string): Promise<LoginResult> {
    const provider = await this.requireProvider(providerId)
    this.loggedOutProviders.delete(providerId)
    if (apiKey !== undefined) {
      await this.save(providerId, 'apiKey', apiKey)
    } else {
      await this.hydrateProvider(provider)
    }
    const state = await this.status(providerId)
    const variable = this.environmentNames[provider.id]?.apiKey
    const action =
      state.status !== 'authenticated' && variable
        ? {
            action: 'device_code' as const,
            deviceCode: `Enter an API key in the TUI or set ${variable} in the Runtime environment.`,
          }
        : undefined
    return { loginId: `login-${Date.now().toString(36)}`, ...(action ? { action } : {}), state }
  }

  async logout(providerId: string): Promise<ProviderAuthState> {
    const provider = await this.requireProvider(providerId)
    this.loggedOutProviders.add(providerId)
    await this.store?.delete(providerId)
    for (const name of Object.keys(this.environmentNames[providerId] ?? {})) {
      await provider.configureCredential?.(name, undefined)
    }
    this.hydratedProviders.delete(providerId)
    this.credentialSources.delete(providerId)
    return { status: 'unauthenticated' }
  }

  registerRefresher(providerId: string, name: string, refresher: CredentialRefresher): void {
    this.refreshers.set(credentialKey(providerId, name), refresher)
  }

  async save(providerId: string, name: string, value: string, expiresAt?: string): Promise<void> {
    const provider = await this.requireProvider(providerId)
    if (!this.store) throw new Error('Credential storage is not configured.')
    if (!value.trim() || /[\r\n]/.test(value)) {
      throw new Error('Credential value must be non-empty and contain no line breaks.')
    }
    await this.store.set({
      provider: providerId,
      name,
      value,
      updatedAt: new Date().toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
    })
    await provider.configureCredential?.(name, value)
    this.loggedOutProviders.delete(providerId)
    this.hydratedProviders.add(providerId)
    this.credentialSources.set(providerId, 'stored')
  }

  /** Resolves credential precedence as CLI flag, provider-scoped store, then environment. */
  async resolve(
    providerId: string,
    name: string,
    cliValue?: string,
  ): Promise<{ value?: string; source?: 'cli' | 'store' | 'environment' }> {
    if (cliValue) return { value: cliValue, source: 'cli' }
    const stored = await this.store?.get(providerId, name)
    if (stored) {
      const refreshed = await this.refreshIfNeeded(stored)
      return { value: refreshed.value, source: 'store' }
    }
    const environmentName = this.environmentNames[providerId]?.[name]
    const value = environmentName ? this.environment[environmentName] : undefined
    return value ? { value, source: 'environment' } : {}
  }

  async list(providerId?: string) {
    return (await this.store?.list(providerId)) ?? []
  }

  private async hydrateProvider(provider: ChatProvider): Promise<void> {
    if (this.hydratedProviders.has(provider.id)) return
    for (const name of Object.keys(this.environmentNames[provider.id] ?? {})) {
      const resolved = await this.resolve(provider.id, name)
      if (resolved.value !== undefined) {
        await provider.configureCredential?.(name, resolved.value)
        this.credentialSources.set(
          provider.id,
          resolved.source === 'store' ? 'stored' : 'environment',
        )
      }
    }
    this.hydratedProviders.add(provider.id)
  }

  private async refreshIfNeeded(credential: StoredCredential): Promise<StoredCredential> {
    if (
      credential.expiresAt === undefined ||
      Date.parse(credential.expiresAt) > Date.now() + 60_000
    ) {
      return credential
    }
    const refresher = this.refreshers.get(credentialKey(credential.provider, credential.name))
    if (!refresher || !this.store) return credential
    const refreshed = await refresher(credential)
    const next: StoredCredential = {
      ...credential,
      value: refreshed.value,
      updatedAt: new Date().toISOString(),
      ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
    }
    await this.store.set(next)
    return next
  }

  private async requireProvider(providerId: string): Promise<ChatProvider> {
    const provider = await this.resolveProvider(providerId)
    if (!provider) throw new Error(`Unknown provider: ${providerId}.`)
    return provider
  }
}

const DEFAULT_ENVIRONMENT_NAMES: Record<string, Record<string, string>> = {
  kimi: { apiKey: 'MOONSHOT_API_KEY' },
  deepseek: { apiKey: 'DEEPSEEK_API_KEY' },
  openai: { apiKey: 'OPENAI_API_KEY' },
  'openai-chat': { apiKey: 'OPENAI_API_KEY' },
  'openai-compatible': { apiKey: 'PRAXIS_OPENAI_COMPATIBLE_API_KEY' },
  anthropic: { apiKey: 'ANTHROPIC_API_KEY' },
  'qwen-token-plan': { apiKey: 'QWEN_TOKEN_PLAN_API_KEY' },
  'qwen-token-plan-cn': { apiKey: 'QWEN_TOKEN_PLAN_CN_API_KEY' },
  ...Object.fromEntries(
    MINIMAX_PROVIDER_CONFIGURATIONS.map(({ id, apiKeyEnvironmentVariable }) => [
      id,
      { apiKey: apiKeyEnvironmentVariable },
    ]),
  ),
}

function credentialKey(providerId: string, name: string): string {
  return `${providerId}\u0000${name}`
}
