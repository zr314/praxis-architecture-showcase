import {
  runtimeError,
  type ChatProvider,
  type ProviderDescriptor,
  type ProviderFactory,
} from '@praxis/core-sdk'

export type RegisteredProvider = {
  descriptor: ProviderDescriptor
  factory: ProviderFactory
}

export class ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>()

  register(descriptor: ProviderDescriptor, factory: ProviderFactory): void {
    if (this.providers.has(descriptor.id)) {
      throw runtimeError(
        'CAPABILITY_CONFLICT',
        'plugin',
        'Provider capability ID is already registered.',
        {
          capabilityId: descriptor.id,
        },
      )
    }
    this.providers.set(descriptor.id, { descriptor, factory })
  }

  get(id: string): RegisteredProvider | undefined {
    return this.providers.get(id)
  }

  ids(): string[] {
    return [...this.providers.keys()]
  }

  clear(): void {
    this.providers.clear()
  }

  unregister(id: string): void {
    this.providers.delete(id)
  }

  async create(id: string): Promise<ChatProvider | undefined> {
    const registration = this.providers.get(id)
    if (!registration) return undefined
    const provider = await registration.factory()
    if (provider.id !== registration.descriptor.id) {
      throw runtimeError(
        'CAPABILITY_FACTORY_MISMATCH',
        'plugin',
        'Provider factory returned a capability with a different ID.',
        {
          descriptorId: registration.descriptor.id,
          returnedCapabilityId: provider.id,
        },
      )
    }
    return provider
  }
}
