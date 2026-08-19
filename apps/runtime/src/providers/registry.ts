import { runtimeError } from '@praxis/core-sdk'
import { createBuiltinProviders } from '../llm-provider/builtinProviders.js'
import type { ChatProvider } from './types.js'

export class ProviderRegistry {
  private readonly providers = new Map<string, ChatProvider>()

  constructor(providers: Iterable<ChatProvider> = createBuiltinProviders()) {
    for (const provider of providers) this.register(provider)
  }

  register(provider: ChatProvider): void {
    if (this.providers.has(provider.id)) {
      throw runtimeError(
        'CAPABILITY_CONFLICT',
        'plugin',
        'Provider capability ID is already registered.',
        {
          capabilityId: provider.id,
        },
      )
    }
    this.providers.set(provider.id, provider)
  }

  get(id: string): ChatProvider | undefined {
    return this.providers.get(id)
  }

  ids(): string[] {
    return [...this.providers.keys()]
  }

  defaultProviderId(): string {
    return this.get('kimi')?.authState().status === 'authenticated' ? 'kimi' : 'mock'
  }
}
