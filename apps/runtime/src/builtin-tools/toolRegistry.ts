import { runtimeError, type RuntimeTool, type ToolDescriptor } from '@praxis/core-sdk'

export type ToolFactory = () => RuntimeTool | Promise<RuntimeTool>

export type RegisteredTool = {
  descriptor: ToolDescriptor
  factory: ToolFactory
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()

  register(descriptor: ToolDescriptor, factory: ToolFactory): void {
    if (this.tools.has(descriptor.id)) {
      throw runtimeError(
        'CAPABILITY_CONFLICT',
        'plugin',
        'Tool capability ID is already registered.',
        {
          capabilityId: descriptor.id,
        },
      )
    }
    this.tools.set(descriptor.id, { descriptor, factory })
  }

  get(id: string): RegisteredTool | undefined {
    return this.tools.get(id)
  }

  ids(): string[] {
    return [...this.tools.keys()]
  }

  clear(): void {
    this.tools.clear()
  }

  unregister(id: string): void {
    this.tools.delete(id)
  }

  async create(id: string): Promise<RuntimeTool | undefined> {
    const registration = this.tools.get(id)
    if (!registration) return undefined
    const tool = await registration.factory()
    if (tool.definition.name !== registration.descriptor.id) {
      throw runtimeError(
        'CAPABILITY_FACTORY_MISMATCH',
        'plugin',
        'Tool factory returned a capability with a different ID.',
        {
          descriptorId: registration.descriptor.id,
          returnedCapabilityId: tool.definition.name,
        },
      )
    }
    return tool
  }
}
