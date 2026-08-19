import { createHash } from 'node:crypto'
import {
  type CommandArgumentPropertyV1,
  type CommandArgumentSchemaV1,
  type CommandDescriptorV1,
  type CommandInvocationV1,
  type CommandInvokeOutputV1,
  createCommandDescriptorV1,
  type PreparedToolInvocation,
  type RuntimeError,
  type RuntimeErrorCategory,
  runtimeError,
  type ToolResult,
} from '@praxis/core-sdk'
import type { PluginToolCommandMappingV1 } from '@praxis/plugin-protocol'
import type { ArtifactStore } from '../artifacts/artifactStore.js'
import type { ExternalToolCommandSelection } from '../extensions/installationService.js'
import { mcpRuntimeToolName } from '../extensions/mcpStdioClient.js'
import { processRuntimeToolName } from '../extensions/processActivationService.js'
import { scheduleLongDurationTimer } from '../longDurationTimer.js'
import type { PolicyEngine } from '../policy/index.js'
import type { ToolRuntime } from '../tools/toolRuntime.js'

export const EXTERNAL_COMMAND_CAPABILITY_V1 = 'extension.command.invoke'

export type PreparedExternalToolCommandV1 = Readonly<{
  descriptor: CommandDescriptorV1
  invocation: CommandInvocationV1
  runtime: ToolRuntime
  tool: PreparedToolInvocation
}>

type PublishedExternalCommand = Readonly<{
  descriptor: CommandDescriptorV1
  toolName: string
  toolDigest: `sha256:${string}`
}>

/** Publishes only manifest-declared mappings whose live Tool schema is command-safe. */
export class ExternalToolCommandAdapterV1 {
  readonly #runtime: ToolRuntime
  readonly #published = new Map<string, PublishedExternalCommand>()

  constructor(selections: readonly ExternalToolCommandSelection[], runtime: ToolRuntime) {
    this.#runtime = runtime
    const definitions = new Map(
      runtime.definitions().map((definition) => [definition.name, definition]),
    )
    for (const selection of selections) {
      const toolName = targetToolName(selection)
      const definition = definitions.get(toolName)
      if (definition === undefined) continue
      const schema = commandSchema(definition.parameters, selection.mapping)
      if (schema === undefined) continue
      try {
        const toolDigest = digest(definition)
        const sourceDigest = digest({
          installationDigest: selection.digest,
          mapping: selection.mapping,
          toolDigest,
        })
        const descriptor = createCommandDescriptorV1({
          id: `${selection.source}:${selection.pluginId}/${selection.mapping.id}`,
          command: `${selection.source}:${selection.pluginId}/${selection.mapping.id}`,
          aliases: [],
          title: selection.mapping.title,
          description: selection.mapping.description,
          usage: commandUsage(selection, schema),
          kind: 'workflow',
          schema,
          source: {
            kind: selection.source,
            origin: `${selection.source}:${selection.pluginId}@${selection.digest}`,
            namespace: selection.pluginId,
            digest: sourceDigest,
          },
          effect: 'job',
          capabilities: [EXTERNAL_COMMAND_CAPABILITY_V1],
          availability: { session: 'required', run: 'idle', requiresWorkspaceTrust: true },
          output: { kind: 'bounded_job', maxBytes: 256 },
          sensitiveArguments: selection.mapping.sensitiveArguments.map((name) => `/${name}`),
          persistence: selection.mapping.persistence,
        })
        this.#published.set(descriptor.id, Object.freeze({ descriptor, toolName, toolDigest }))
      } catch {
        // A live schema that cannot satisfy the strict command contract remains Tool-only.
      }
    }
  }

  descriptors(): readonly CommandDescriptorV1[] {
    return Object.freeze(
      [...this.#published.values()]
        .map(({ descriptor }) => descriptor)
        .sort((left, right) => left.command.localeCompare(right.command)),
    )
  }

  prepare(
    descriptor: CommandDescriptorV1,
    invocation: CommandInvocationV1,
    cwd: string,
  ): PreparedExternalToolCommandV1 {
    const published = this.#published.get(descriptor.id)
    if (
      published === undefined ||
      published.descriptor.descriptorDigest !== descriptor.descriptorDigest
    ) {
      throw externalCommandError('COMMAND_EXTERNAL_RESOURCE_DRIFT')
    }
    const definition = this.#runtime
      .definitions()
      .find((candidate) => candidate.name === published.toolName)
    if (definition === undefined || digest(definition) !== published.toolDigest) {
      throw externalCommandError('COMMAND_EXTERNAL_RESOURCE_DRIFT')
    }
    const invalid = this.#runtime.validateInput(published.toolName, { ...invocation.arguments })
    if (invalid !== undefined) {
      throw externalCommandError('COMMAND_EXTERNAL_ARGUMENTS_INVALID')
    }
    return Object.freeze({
      descriptor: published.descriptor,
      invocation,
      runtime: this.#runtime,
      tool: this.#runtime.prepare(published.toolName, { ...invocation.arguments }, cwd),
    })
  }
}

/** Executes mapped commands through Policy, ToolRuntime, deadline/cancel, and ArtifactStore. */
export class ExternalToolCommandExecutorV1 {
  constructor(
    private readonly policy: Pick<PolicyEngine, 'allows' | 'record'>,
    private readonly artifacts: Pick<ArtifactStore, 'put'>,
  ) {}

  async execute(
    prepared: PreparedExternalToolCommandV1,
    input: { workspace: string; signal?: AbortSignal },
  ): Promise<CommandInvokeOutputV1> {
    const permission = prepared.tool.permission
    const policyRequest = {
      workspace: input.workspace,
      tool: prepared.tool.name,
      rule: permission?.rule ?? `external-command:${prepared.descriptor.source.kind}`,
      ...(permission?.target === undefined ? {} : { target: permission.target }),
    }
    const auditData = {
      invocationId: prepared.invocation.invocationId,
      descriptorId: prepared.descriptor.id,
      descriptorDigest: prepared.descriptor.descriptorDigest,
      sourceDigest: prepared.descriptor.source.digest,
    }
    if (permission !== undefined && !this.policy.allows(policyRequest)) {
      await this.policy.record({
        ...policyRequest,
        decision: 'ask',
        data: auditData,
      })
      throw externalCommandError('COMMAND_EXTERNAL_PERMISSION_REQUIRED')
    }
    await this.policy.record({
      ...policyRequest,
      decision: permission === undefined ? 'allow_once' : 'allow',
      data: auditData,
    })

    let result: ToolResult
    try {
      result = await executeBounded(prepared, input.signal)
    } catch (error) {
      const code = errorCode(error)
      const artifact = await this.artifacts.put(
        externalResultEnvelope(prepared, {
          ok: false,
          summary: code,
          error: {
            code,
            category: 'execution',
            retryable: code === 'COMMAND_EXTERNAL_TIMEOUT',
          },
        }),
        'application/vnd.praxis.external-command-result+json',
      )
      throw externalCommandError(code, { artifactId: artifact.artifactId })
    }
    const artifact = await this.artifacts.put(
      externalResultEnvelope(prepared, result),
      'application/vnd.praxis.external-command-result+json',
    )
    return Object.freeze({
      kind: 'bounded_job',
      jobId: artifact.artifactId,
      state: 'completed',
    })
  }
}

function commandSchema(
  input: Record<string, unknown>,
  mapping: PluginToolCommandMappingV1,
): CommandArgumentSchemaV1 | undefined {
  if (
    !isRecord(input) ||
    input.type !== 'object' ||
    input.additionalProperties !== false ||
    !isRecord(input.properties) ||
    Object.keys(input.properties).length > 16 ||
    !Array.isArray(input.required) ||
    !input.required.every((name) => typeof name === 'string') ||
    hasDuplicates(input.required)
  ) {
    return undefined
  }
  const rootKeys = new Set([
    '$schema',
    'type',
    'properties',
    'required',
    'additionalProperties',
    'title',
    'description',
  ])
  if (Object.keys(input).some((key) => !rootKeys.has(key))) return undefined
  const properties: Record<string, CommandArgumentPropertyV1> = {}
  for (const [name, value] of Object.entries(input.properties)) {
    const property = commandProperty(name, value)
    if (property === undefined) return undefined
    properties[name] = property
  }
  const names = Object.keys(properties)
  if (
    input.required.some((name) => properties[String(name)] === undefined) ||
    !sameMembers(
      mapping.positional,
      names.filter((name) => name !== 'body'),
    ) ||
    mapping.sensitiveArguments.some((name) => properties[name] === undefined) ||
    (properties.body !== undefined && properties.body.type !== 'string')
  ) {
    return undefined
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: [...input.required] as string[],
    positional: [...mapping.positional],
  }
}

function commandProperty(name: string, value: unknown): CommandArgumentPropertyV1 | undefined {
  if (!/^[a-z][a-zA-Z0-9_]{0,63}$/u.test(name) || !isRecord(value)) return undefined
  const allowed = new Set([
    'type',
    'description',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'enum',
  ])
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined
  if (!['string', 'integer', 'boolean'].includes(String(value.type))) return undefined
  const property: Record<string, unknown> = { type: value.type }
  for (const key of ['description', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum']) {
    if (value[key] !== undefined) property[key] = structuredClone(value[key])
  }
  if (value.type === 'string' && value.maxLength === undefined) {
    property.maxLength = name === 'body' ? 16_384 : 4_096
  }
  return property as CommandArgumentPropertyV1
}

function commandUsage(
  selection: ExternalToolCommandSelection,
  schema: CommandArgumentSchemaV1,
): string {
  const arguments_ = schema.positional.map((name) => `<${name}>`).join(' ')
  return `/${selection.source}:${selection.pluginId}/${selection.mapping.id}${arguments_ ? ` ${arguments_}` : ''}`
}

function targetToolName(selection: ExternalToolCommandSelection): string {
  return selection.source === 'mcp'
    ? mcpRuntimeToolName(selection.pluginId, selection.mapping.capability, selection.mapping.tool!)
    : processRuntimeToolName(selection.pluginId, selection.mapping.capability)
}

function externalResultEnvelope(prepared: PreparedExternalToolCommandV1, result: ToolResult) {
  return {
    schemaVersion: 1,
    invocationId: prepared.invocation.invocationId,
    descriptorId: prepared.descriptor.id,
    descriptorDigest: prepared.descriptor.descriptorDigest,
    source: prepared.descriptor.source,
    tool: {
      name: prepared.tool.name,
      execution: prepared.tool.descriptor,
    },
    result,
  }
}

async function executeBounded(
  prepared: PreparedExternalToolCommandV1,
  parentSignal?: AbortSignal,
): Promise<ToolResult> {
  const controller = new AbortController()
  const timeoutMs = prepared.tool.descriptor.timeoutMs
  return new Promise<ToolResult>((resolve, reject) => {
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      timer?.cancel()
      parentSignal?.removeEventListener('abort', cancel)
      action()
    }
    const cancel = () => {
      controller.abort(parentSignal?.reason)
      finish(() => reject(externalCommandError('COMMAND_EXTERNAL_CANCELLED')))
    }
    const timer =
      timeoutMs === undefined
        ? undefined
        : scheduleLongDurationTimer(() => {
            controller.abort('deadline')
            finish(() => reject(externalCommandError('COMMAND_EXTERNAL_TIMEOUT')))
          }, timeoutMs)
    if (parentSignal?.aborted) {
      cancel()
      return
    }
    parentSignal?.addEventListener('abort', cancel, { once: true })
    void prepared.runtime.executePrepared(prepared.tool, controller.signal).then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    )
  })
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value))
}

function hasDuplicates(values: readonly unknown[]): boolean {
  return new Set(values).size !== values.length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type ExternalCommandFailureCode = keyof typeof EXTERNAL_COMMAND_FAILURES

const EXTERNAL_COMMAND_FAILURES = Object.freeze({
  COMMAND_EXTERNAL_RESOURCE_DRIFT: Object.freeze({
    category: 'plugin',
    message: 'Mapped external command resource changed.',
    retryable: true,
  }),
  COMMAND_EXTERNAL_ARGUMENTS_INVALID: Object.freeze({
    category: 'protocol',
    message: 'Mapped external command arguments are invalid.',
    retryable: false,
  }),
  COMMAND_EXTERNAL_PERMISSION_REQUIRED: Object.freeze({
    category: 'permission',
    message: 'Mapped external command requires an existing permission grant.',
    retryable: true,
  }),
  COMMAND_EXTERNAL_CANCELLED: Object.freeze({
    category: 'cancelled',
    message: 'Mapped external command was cancelled.',
    retryable: false,
  }),
  COMMAND_EXTERNAL_TIMEOUT: Object.freeze({
    category: 'plugin',
    message: 'Mapped external command exceeded its deadline.',
    retryable: true,
  }),
  COMMAND_EXTERNAL_EXECUTION_FAILED: Object.freeze({
    category: 'plugin',
    message: 'Mapped external command execution failed.',
    retryable: false,
  }),
}) satisfies Readonly<
  Record<string, Readonly<{ category: RuntimeErrorCategory; message: string; retryable: boolean }>>
>

function errorCode(error: unknown): ExternalCommandFailureCode {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined
  return code === 'COMMAND_EXTERNAL_CANCELLED' || code === 'COMMAND_EXTERNAL_TIMEOUT'
    ? code
    : 'COMMAND_EXTERNAL_EXECUTION_FAILED'
}

function externalCommandError(
  code: ExternalCommandFailureCode,
  data?: Record<string, unknown>,
): RuntimeError {
  const failure = EXTERNAL_COMMAND_FAILURES[code]
  return runtimeError(code, failure.category, failure.message, data, failure.retryable)
}
