import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type CommandCatalogSnapshotV1,
  type CommandDescriptorV1,
  CommandRegistryV1,
  commandSourceDigestV1,
  createCommandDescriptorV1,
  createPromptEnvelope,
  type InputRouteContextV1,
  InputRouterV1,
  validateCommandInvocationV1,
  validateInputRouteResultV1,
} from '@praxis/core-sdk'
import { createClientCommandRegistryV1 } from '../apps/cli/src/ui/clientCommandRegistry.js'
import { createRuntimeCommandRegistryV1 } from '../apps/runtime/src/commands/builtinCommandRegistry.js'

test('ordinary multiline text becomes one normal PromptEnvelope', async () => {
  const catalogs = shippingCatalogs()
  const result = await new InputRouterV1().route(
    'explain this\nwithout shell parsing',
    context(catalogs),
  )
  assert.equal(result.kind, 'prompt_envelope')
  if (result.kind !== 'prompt_envelope') return
  assert.equal(result.envelope.source, 'user_text')
  assert.equal(result.envelope.effectiveText, 'explain this\nwithout shell parsing')
})

test('shipping client and Runtime commands return disjoint typed actions', async () => {
  const catalogs = shippingCatalogs()
  const router = new InputRouterV1()
  const copy = await router.route('/copy', context(catalogs))
  assert.equal(copy.kind, 'ui_action')
  const compact = await router.route('/compact "focus on tools"', context(catalogs))
  assert.equal(compact.kind, 'runtime_action')
  if (compact.kind !== 'runtime_action') return
  assert.equal(compact.effect, 'mutation')
  assert.deepEqual(compact.invocation.arguments, { focus: 'focus on tools' })
  assert.deepEqual(validateCommandInvocationV1(compact.invocation), compact.invocation)
  assert.deepEqual(validateInputRouteResultV1(compact), compact)
  assert.throws(
    () =>
      validateCommandInvocationV1({
        ...structuredClone(compact.invocation),
        descriptorDigest: `sha256:${'z'.repeat(64)}`,
      }),
    hasCode('COMMAND_INVOCATION_INVALID'),
  )
})

test('only the first line is a header and unsupported bodies fail closed', async () => {
  const result = await new InputRouterV1().route(
    '/plan\nignore the command',
    context(shippingCatalogs()),
  )
  assert.deepEqual(result, commandError('COMMAND_BODY_UNSUPPORTED'))
})

test('unknown, ambiguous, and malformed slash input never becomes a prompt', async () => {
  const ambiguous = externalCatalog()
  const router = new InputRouterV1()
  assert.deepEqual(
    await router.route('/missing', context(ambiguous)),
    commandError('COMMAND_UNKNOWN'),
  )
  assert.deepEqual(
    await router.route('/review', context(ambiguous)),
    commandError('COMMAND_AMBIGUOUS'),
  )
  assert.deepEqual(
    await router.route('/plugin:alpha/review "unterminated', context(ambiguous)),
    commandError('COMMAND_HEADER_INVALID'),
  )
})

test('argument parsing is schema-bound and never evaluates shell syntax', async () => {
  const catalogs = shippingCatalogs()
  const router = new InputRouterV1()
  const result = await router.route('/model "$(touch should-not-run)"', context(catalogs))
  assert.equal(result.kind, 'runtime_action')
  if (result.kind !== 'runtime_action') return
  assert.equal(result.invocation.arguments.model, '$(touch should-not-run)')
  assert.deepEqual(
    await router.route('/resume', context(catalogs)),
    commandError('COMMAND_ARGUMENTS_REQUIRED'),
  )
  assert.deepEqual(
    await router.route('/plan extra', context(catalogs)),
    commandError('COMMAND_ARGUMENTS_INVALID'),
  )
})

test('active-run availability and stale capability bindings are rejected', async () => {
  const catalogs = shippingCatalogs()
  const active = context(catalogs, { run: 'active' })
  assert.deepEqual(
    await new InputRouterV1().route('/compact', active),
    commandError('COMMAND_UNAVAILABLE_ACTIVE_RUN'),
  )
  assert.deepEqual(
    await new InputRouterV1().route(
      '/plan',
      context(catalogs, { capabilityDigest: `sha256:${'0'.repeat(64)}` }),
    ),
    commandError('COMMAND_CAPABILITY_SNAPSHOT_STALE'),
  )
})

test('prompt commands re-enter the Planner path only through a validated producer envelope', async () => {
  const catalog = promptCatalog()
  const router = new InputRouterV1({
    promptCommandProducer: {
      produce: async ({ invocation }) =>
        createPromptEnvelope({
          id: 'prompt-produced-1',
          source: 'prompt_template',
          effectiveText: String(invocation.arguments.target),
          rawInputPersistence: 'redacted',
          commandInvocationId: invocation.invocationId,
        }),
    },
  })
  const result = await router.route(
    '/prompt:review src\nPlease focus on cancellation.',
    context([catalog]),
  )
  assert.equal(result.kind, 'prompt_envelope')
  if (result.kind !== 'prompt_envelope') return
  assert.equal(result.envelope.source, 'prompt_template')
  assert.equal(result.envelope.commandInvocationId, 'command:request-1')

  const unavailable = await new InputRouterV1().route('/prompt:review src', context([catalog]))
  assert.deepEqual(unavailable, commandError('COMMAND_PROMPT_PRODUCER_UNAVAILABLE'))

  const drifted = await new InputRouterV1({
    promptCommandProducer: {
      produce: async () => {
        throw Object.assign(new Error('resource changed'), { code: 'COMMAND_RESOURCE_DRIFT' })
      },
    },
  }).route('/prompt:review src', context([catalog]))
  assert.deepEqual(drifted, commandError('COMMAND_RESOURCE_DRIFT'))
})

function shippingCatalogs(): readonly CommandCatalogSnapshotV1[] {
  const capabilityIds = [
    'artifact.read',
    'credential.write',
    'provider.read',
    'runtime.diagnostics',
    'session.read',
    'session.write',
  ]
  return [
    createClientCommandRegistryV1().snapshot({
      workspaceId: 'workspace-1',
      workspaceTrusted: true,
      capabilityIds,
    }),
    createRuntimeCommandRegistryV1().snapshot({
      workspaceId: 'workspace-1',
      workspaceTrusted: true,
      capabilityIds,
    }),
  ]
}

function externalCatalog(): CommandCatalogSnapshotV1[] {
  const registry = new CommandRegistryV1({ owner: 'runtime' })
  registry.register(externalPlugin('alpha'))
  registry.register(externalPlugin('beta'))
  return [
    registry.snapshot({ workspaceId: 'workspace-1', workspaceTrusted: true, capabilityIds: [] }),
  ]
}

function promptCatalog(): CommandCatalogSnapshotV1 {
  const registry = new CommandRegistryV1({ owner: 'runtime' })
  registry.register(
    createCommandDescriptorV1({
      id: 'prompt:review/review',
      command: 'prompt:review',
      aliases: [],
      title: 'Review',
      description: 'Expand a data-only review template.',
      usage: '/prompt:review <target>',
      kind: 'prompt_template',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', minLength: 1, maxLength: 256 },
          body: { type: 'string', minLength: 1, maxLength: 4_096 },
        },
        required: ['target'],
        positional: ['target'],
      },
      source: {
        kind: 'prompt',
        origin: 'workspace:prompt/review',
        namespace: 'review',
        digest: commandSourceDigestV1('prompt-review-v1'),
      },
      effect: 'prompt',
      capabilities: [],
      availability: { session: 'required', run: 'idle', requiresWorkspaceTrust: true },
      output: { kind: 'prompt_envelope', maxBytes: 32 * 1024 },
      sensitiveArguments: [],
      persistence: 'redacted',
    }),
  )
  return registry.snapshot({
    workspaceId: 'workspace-1',
    workspaceTrusted: true,
    capabilityIds: [],
  })
}

function externalPlugin(namespace: string): CommandDescriptorV1 {
  return createCommandDescriptorV1({
    id: `plugin:${namespace}/review`,
    command: `plugin:${namespace}/review`,
    aliases: ['review'],
    title: 'Review',
    description: 'Plugin review command.',
    usage: `/plugin:${namespace}/review`,
    kind: 'workflow',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
      positional: [],
    },
    source: {
      kind: 'plugin',
      origin: `plugin:${namespace}`,
      namespace,
      digest: commandSourceDigestV1(`plugin-${namespace}`),
    },
    effect: 'job',
    capabilities: [],
    availability: { session: 'required', run: 'idle', requiresWorkspaceTrust: true },
    output: { kind: 'bounded_job', maxBytes: 4_096 },
    sensitiveArguments: [],
    persistence: 'digest',
  })
}

function context(
  catalogs: readonly CommandCatalogSnapshotV1[],
  override: Partial<InputRouteContextV1> = {},
): InputRouteContextV1 {
  return {
    clientRequestId: 'request-1',
    promptId: 'prompt-1',
    catalogs,
    capabilityDigest: catalogs[0]?.capabilityDigest ?? (`sha256:${'0'.repeat(64)}` as const),
    workspaceTrusted: true,
    session: 'present',
    run: 'idle',
    ...override,
  }
}

function commandError(code: string) {
  return { kind: 'error', error: { code, category: 'command', retryable: false } }
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}
