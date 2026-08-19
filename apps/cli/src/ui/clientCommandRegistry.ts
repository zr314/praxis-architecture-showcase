import {
  CommandRegistryV1,
  commandSourceDigestV1,
  createCommandDescriptorV1,
} from '@praxis/core-sdk'

const CLIENT_SOURCE_DIGEST = commandSourceDigestV1('praxis/client-local-commands@1')

export function createClientCommandRegistryV1(): CommandRegistryV1 {
  const registry = new CommandRegistryV1({ owner: 'client' })
  registry.register(
    createCommandDescriptorV1({
      id: 'builtin:client/copy',
      command: 'copy',
      aliases: [],
      title: 'Copy response',
      description: 'Copy the latest assistant response through the local clipboard adapter.',
      usage: '/copy',
      kind: 'client_local',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
        required: [],
        positional: [],
      },
      source: {
        kind: 'builtin',
        origin: 'praxis:client',
        digest: CLIENT_SOURCE_DIGEST,
      },
      effect: 'none',
      capabilities: [],
      availability: {
        session: 'required',
        run: 'any',
        requiresWorkspaceTrust: false,
      },
      output: { kind: 'ui_action', maxBytes: 4_096 },
      sensitiveArguments: [],
      persistence: 'none',
    }),
  )
  return registry
}
