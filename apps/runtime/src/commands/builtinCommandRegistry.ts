import {
  type CommandArgumentPropertyV1,
  type CommandKindV1,
  type CommandOutputKindV1,
  type CommandDescriptorV1,
  CommandRegistryV1,
  commandSourceDigestV1,
  createCommandDescriptorV1,
  type PromptPersistence,
} from '@praxis/core-sdk'

const RUNTIME_SOURCE_DIGEST = commandSourceDigestV1('praxis/runtime-builtin-commands@1')

type BuiltinDefinition = Readonly<{
  command: string
  title: string
  description: string
  usage: string
  kind: Extract<CommandKindV1, 'runtime_query' | 'runtime_mutation'>
  capability: string
  session: 'none' | 'optional' | 'required'
  run?: 'any' | 'idle' | 'active'
  output?: CommandOutputKindV1
  argument?: Readonly<{
    name: string
    property: CommandArgumentPropertyV1
    required?: boolean
    sensitive?: boolean
  }>
  persistence?: PromptPersistence
}>

const DEFINITIONS: readonly BuiltinDefinition[] = Object.freeze([
  mutation(
    'new',
    'New session',
    'Create a clean Runtime session.',
    '/new [name]',
    'session.write',
    {
      name: 'name',
      property: { type: 'string', minLength: 1, maxLength: 256 },
    },
  ),
  mutation(
    'resume',
    'Resume session',
    'Reopen one exact Runtime session.',
    '/resume <id>',
    'session.write',
    { name: 'id', property: { type: 'string', minLength: 1, maxLength: 128 }, required: true },
  ),
  query(
    'session',
    'Session history',
    'Browse Runtime session history.',
    '/session [query]',
    'session.read',
    {
      name: 'query',
      property: { type: 'string', minLength: 1, maxLength: 256 },
    },
  ),
  query(
    'provider',
    'Provider catalog',
    'Inspect available Providers.',
    '/provider [id]',
    'provider.read',
    {
      name: 'id',
      property: { type: 'string', minLength: 1, maxLength: 128 },
    },
    'optional',
  ),
  mutation(
    'login',
    'Provider login',
    'Start the credential login flow.',
    '/login [provider]',
    'credential.write',
    {
      name: 'provider',
      property: { type: 'string', minLength: 1, maxLength: 128 },
    },
  ),
  mutation(
    'logout',
    'Provider logout',
    'Remove one stored Provider credential.',
    '/logout [provider]',
    'credential.write',
    {
      name: 'provider',
      property: { type: 'string', minLength: 1, maxLength: 128 },
    },
  ),
  mutation(
    'model',
    'Select model',
    'Select one exact Provider model.',
    '/model [provider/model]',
    'session.write',
    {
      name: 'model',
      property: { type: 'string', minLength: 1, maxLength: 256 },
    },
  ),
  mutation(
    'compact',
    'Compact context',
    'Create a durable context checkpoint.',
    '/compact [focus]',
    'session.write',
    {
      name: 'focus',
      property: { type: 'string', minLength: 1, maxLength: 1_024 },
    },
    'redacted',
    'required',
    'idle',
  ),
  query(
    'context',
    'Context report',
    'Inspect the current context projection.',
    '/context',
    'session.read',
  ),
  query('plan', 'Active workflow', 'Inspect the latest durable Workflow.', '/plan', 'session.read'),
  query(
    'human-tasks',
    'Human tasks',
    'List durable HumanTask decisions for the latest or specified Workflow.',
    '/human-tasks [workflow-id]',
    'workflow.read',
    {
      name: 'workflowId',
      property: { type: 'string', minLength: 1, maxLength: 128 },
    },
  ),
  mutation(
    'human-allow',
    'Allow human task',
    'Approve one exact waiting HumanTask.',
    '/human-allow <human-task-id>',
    'workflow.control',
    {
      name: 'humanTaskId',
      property: { type: 'string', minLength: 1, maxLength: 128 },
      required: true,
    },
  ),
  mutation(
    'human-deny',
    'Deny human task',
    'Deny one exact waiting HumanTask.',
    '/human-deny <human-task-id>',
    'workflow.control',
    {
      name: 'humanTaskId',
      property: { type: 'string', minLength: 1, maxLength: 128 },
      required: true,
    },
  ),
  mutation(
    'human-cancel',
    'Cancel human task',
    'Cancel one exact waiting HumanTask.',
    '/human-cancel <human-task-id>',
    'workflow.control',
    {
      name: 'humanTaskId',
      property: { type: 'string', minLength: 1, maxLength: 128 },
      required: true,
    },
  ),
  mutation(
    'planner',
    'Planner mode',
    'Inspect or select the Planner for this session.',
    '/planner [auto|solo|workflow]',
    'session.write',
    {
      name: 'mode',
      property: { type: 'string', enum: ['auto', 'solo', 'workflow', 'direct', 'supervisor'] },
    },
    'digest',
    'required',
    'idle',
  ),
  query(
    'storage',
    'Session storage',
    'Inspect the process-wide V3 Session storage authority.',
    '/storage',
    'session.read',
    undefined,
    'none',
  ),
  query('artifacts', 'Artifacts', 'List bounded Runtime artifacts.', '/artifacts', 'artifact.read'),
  query(
    'export',
    'Export session',
    'Export the current session for a client-selected destination.',
    '/export <path>',
    'session.read',
    {
      name: 'path',
      property: { type: 'string', minLength: 1, maxLength: 4_096 },
      required: true,
      sensitive: true,
    },
    'required',
    'redacted',
  ),
  query(
    'doctor',
    'Runtime diagnostics',
    'Inspect bounded workspace and Runtime diagnostics.',
    '/doctor',
    'runtime.diagnostics',
    undefined,
    'none',
  ),
])

export const RUNTIME_COMMAND_CAPABILITIES_V1: readonly string[] = Object.freeze(
  [
    ...new Set([
      ...DEFINITIONS.map(({ capability }) => capability),
      'prompt.invoke',
      'skill.invoke',
      'extension.command.invoke',
    ]),
  ].sort(),
)

export function createRuntimeCommandRegistryV1(
  contributions: readonly CommandDescriptorV1[] = [],
): CommandRegistryV1 {
  const registry = new CommandRegistryV1({ owner: 'runtime' })
  for (const definition of DEFINITIONS) {
    const argument = definition.argument
    registry.register(
      createCommandDescriptorV1({
        id: `builtin:runtime/${definition.command}`,
        command: definition.command,
        aliases: [],
        title: definition.title,
        description: definition.description,
        usage: definition.usage,
        kind: definition.kind,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: argument === undefined ? {} : { [argument.name]: argument.property },
          required: argument?.required ? [argument.name] : [],
          positional: argument === undefined ? [] : [argument.name],
        },
        source: {
          kind: 'builtin',
          origin: 'praxis:runtime',
          digest: RUNTIME_SOURCE_DIGEST,
        },
        effect: definition.kind === 'runtime_query' ? 'read' : 'mutation',
        capabilities: [definition.capability],
        availability: {
          session: definition.session,
          run: definition.run ?? 'any',
          requiresWorkspaceTrust: definition.command === 'doctor',
        },
        output: {
          kind: definition.output ?? 'ui_action',
          maxBytes: 64 * 1024,
        },
        sensitiveArguments: argument?.sensitive ? [`/${argument.name}`] : [],
        persistence: definition.persistence ?? 'digest',
      }),
    )
  }
  for (const descriptor of contributions) registry.register(descriptor)
  return registry
}

function query(
  command: string,
  title: string,
  description: string,
  usage: string,
  capability: string,
  argument?: BuiltinDefinition['argument'],
  session: BuiltinDefinition['session'] = 'required',
  persistence: PromptPersistence = 'digest',
): BuiltinDefinition {
  return {
    command,
    title,
    description,
    usage,
    kind: 'runtime_query',
    capability,
    session,
    argument,
    persistence,
  }
}

function mutation(
  command: string,
  title: string,
  description: string,
  usage: string,
  capability: string,
  argument?: BuiltinDefinition['argument'],
  persistence: PromptPersistence = 'digest',
  session: BuiltinDefinition['session'] = 'required',
  run: BuiltinDefinition['run'] = 'any',
): BuiltinDefinition {
  return {
    command,
    title,
    description,
    usage,
    kind: 'runtime_mutation',
    capability,
    session,
    run,
    argument,
    persistence,
  }
}
