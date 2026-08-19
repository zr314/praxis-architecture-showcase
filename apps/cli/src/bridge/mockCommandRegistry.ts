import {
  type CommandArgumentPropertyV1,
  CommandRegistryV1,
  commandSourceDigestV1,
  createCommandDescriptorV1,
} from '@praxis/core-sdk'

const SOURCE_DIGEST = commandSourceDigestV1('praxis/mock-runtime-commands@1')

const COMMANDS = [
  ['new', 'New session', 'start a clean session', 'name'],
  ['resume', 'Resume session', 'resume a session', 'id'],
  ['session', 'Session history', 'browse session history', 'query'],
  ['provider', 'Provider catalog', 'choose an LLM provider', 'id'],
  ['login', 'Provider login', 'add Provider credentials', 'provider'],
  ['logout', 'Provider logout', 'remove Provider credentials', 'provider'],
  ['model', 'Select model', 'choose an exact model', 'model'],
  ['compact', 'Compact context', 'compact session context', undefined],
  ['context', 'Context report', 'inspect context use', undefined],
  ['plan', 'Active plan', 'inspect the active plan', undefined],
  ['artifacts', 'Artifacts', 'list generated artifacts', undefined],
  ['export', 'Export session', 'export this session', 'path'],
  ['doctor', 'Runtime diagnostics', 'run workspace diagnostics', undefined],
] as const

export const MOCK_COMMAND_CAPABILITIES_V1 = Object.freeze(['command.mock'])

export function createMockRuntimeCommandRegistryV1(): CommandRegistryV1 {
  const registry = new CommandRegistryV1({ owner: 'runtime' })
  for (const [command, title, description, argument] of COMMANDS) {
    const required = command === 'resume' || command === 'export'
    const property: CommandArgumentPropertyV1 = {
      type: 'string',
      minLength: 1,
      maxLength: command === 'export' ? 4_096 : 256,
    }
    registry.register(
      createCommandDescriptorV1({
        id: `builtin:runtime/${command}`,
        command,
        aliases: [],
        title,
        description,
        usage: `/${command}${argument === undefined ? '' : required ? ` <${argument}>` : ` [${argument}]`}`,
        kind: ['new', 'resume', 'login', 'logout', 'model', 'compact'].includes(command)
          ? 'runtime_mutation'
          : 'runtime_query',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: argument === undefined ? {} : { [argument]: property },
          required: required && argument !== undefined ? [argument] : [],
          positional: argument === undefined ? [] : [argument],
        },
        source: { kind: 'builtin', origin: 'praxis:mock-runtime', digest: SOURCE_DIGEST },
        effect: ['new', 'resume', 'login', 'logout', 'model', 'compact'].includes(command)
          ? 'mutation'
          : 'read',
        capabilities: MOCK_COMMAND_CAPABILITIES_V1,
        availability: {
          session: command === 'doctor' ? 'none' : 'required',
          run: command === 'compact' ? 'idle' : 'any',
          requiresWorkspaceTrust: false,
        },
        output: { kind: 'ui_action', maxBytes: 64 * 1024 },
        sensitiveArguments: command === 'export' ? ['/path'] : [],
        persistence: command === 'export' ? 'redacted' : 'digest',
      }),
    )
  }
  return registry
}
