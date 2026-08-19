import {
  type CommandArgumentPropertyV1,
  type CommandCatalogEntryV1,
  type CommandCatalogSnapshotV1,
  type CommandDescriptorV1,
  validateCommandCatalogSnapshotV1,
} from './command.js'
import {
  createPromptEnvelope,
  type PromptEnvelope,
  type PromptEnvelopeSource,
  validatePromptEnvelope,
} from './prompt.js'

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u
const MAX_INPUT_BYTES = 32 * 1024
const MAX_HEADER_BYTES = 4 * 1024
const MAX_BODY_BYTES = 28 * 1024
const MAX_ARGUMENTS = 16

export type CommandArgumentValueV1 = string | number | boolean

export type CommandInvocationV1 = Readonly<{
  schemaVersion: 1
  invocationId: string
  clientRequestId: string
  descriptorId: string
  descriptorDigest: `sha256:${string}`
  command: string
  arguments: Readonly<Record<string, CommandArgumentValueV1>>
  body?: string
}>

export type InputRouteErrorV1 = Readonly<{
  code: string
  category: 'command'
  retryable: false
}>

export type InputRouteResultV1 =
  | Readonly<{ kind: 'ui_action'; invocation: CommandInvocationV1 }>
  | Readonly<{
      kind: 'runtime_action'
      effect: 'query' | 'mutation'
      invocation: CommandInvocationV1
    }>
  | Readonly<{ kind: 'prompt_envelope'; envelope: PromptEnvelope }>
  | Readonly<{
      kind: 'bounded_job'
      invocation: CommandInvocationV1
      maxOutputBytes: number
    }>
  | Readonly<{ kind: 'error'; error: InputRouteErrorV1 }>

export type InputRouteContextV1 = Readonly<{
  clientRequestId: string
  promptId: string
  catalogs: readonly CommandCatalogSnapshotV1[]
  capabilityDigest: `sha256:${string}`
  workspaceTrusted: boolean
  session: 'none' | 'present'
  run: 'idle' | 'active'
}>

export interface PromptCommandProducerV1 {
  produce(input: {
    descriptor: CommandDescriptorV1
    invocation: CommandInvocationV1
  }): Promise<PromptEnvelope>
}

export type InputRouterOptionsV1 = Readonly<{
  promptCommandProducer?: PromptCommandProducerV1
}>

/** Deterministic first-line command router; it never executes command text or shells. */
export class InputRouterV1 {
  constructor(private readonly options: InputRouterOptionsV1 = {}) {}

  async route(source: string, context: InputRouteContextV1): Promise<InputRouteResultV1> {
    let validatedContext: InputRouteContextV1
    try {
      validatedContext = validateContext(context)
    } catch (error) {
      return routeError(errorCode(error, 'INPUT_ROUTE_CONTEXT_INVALID'))
    }
    if (
      typeof source !== 'string' ||
      source.length < 1 ||
      Buffer.byteLength(source) > MAX_INPUT_BYTES
    ) {
      return routeError('INPUT_INVALID')
    }
    if (!source.startsWith('/')) {
      try {
        return deepFreeze({
          kind: 'prompt_envelope',
          envelope: createPromptEnvelope({
            id: validatedContext.promptId,
            source: 'user_text',
            effectiveText: source,
            rawInput: source,
            rawInputPersistence: 'plaintext',
          }),
        })
      } catch {
        return routeError('INPUT_INVALID')
      }
    }

    const parsed = parseCommandInput(source)
    if ('error' in parsed) return routeError(parsed.error)
    const resolved = resolveDescriptor(parsed.command, validatedContext.catalogs)
    if ('error' in resolved) return routeError(resolved.error)
    const descriptor = resolved.entry.descriptor
    if (
      descriptor.capabilities.some(
        (capability) => !resolved.catalog.capabilityIds.includes(capability),
      )
    ) {
      return routeError('COMMAND_CAPABILITY_DENIED')
    }
    const availabilityError = checkAvailability(descriptor, validatedContext)
    if (availabilityError !== undefined) return routeError(availabilityError)
    const arguments_ = validateArguments(descriptor, parsed.arguments, parsed.body)
    if ('error' in arguments_) return routeError(arguments_.error)
    const invocation = createInvocation(
      descriptor,
      arguments_.value,
      parsed.body,
      validatedContext.clientRequestId,
    )

    switch (descriptor.kind) {
      case 'client_local':
        return deepFreeze({ kind: 'ui_action', invocation })
      case 'runtime_query':
        return deepFreeze({ kind: 'runtime_action', effect: 'query', invocation })
      case 'runtime_mutation':
        return deepFreeze({ kind: 'runtime_action', effect: 'mutation', invocation })
      case 'workflow':
        return deepFreeze({
          kind: 'bounded_job',
          invocation,
          maxOutputBytes: descriptor.output.maxBytes,
        })
      case 'prompt_template':
      case 'skill_invocation':
        return this.#producePrompt(descriptor, invocation)
    }
  }

  async #producePrompt(
    descriptor: CommandDescriptorV1,
    invocation: CommandInvocationV1,
  ): Promise<InputRouteResultV1> {
    if (this.options.promptCommandProducer === undefined) {
      return routeError('COMMAND_PROMPT_PRODUCER_UNAVAILABLE')
    }
    try {
      const envelope = validatePromptEnvelope(
        await this.options.promptCommandProducer.produce({ descriptor, invocation }),
      )
      const expectedSource: PromptEnvelopeSource =
        descriptor.kind === 'prompt_template' ? 'prompt_template' : 'skill'
      if (
        envelope.source !== expectedSource ||
        envelope.commandInvocationId !== invocation.invocationId
      ) {
        return routeError('COMMAND_PROMPT_ENVELOPE_INVALID')
      }
      return deepFreeze({ kind: 'prompt_envelope', envelope })
    } catch (error) {
      return routeError(errorCode(error, 'COMMAND_PROMPT_PRODUCER_FAILED'))
    }
  }
}

export function validateCommandInvocationV1(input: unknown): CommandInvocationV1 {
  if (
    !isRecord(input) ||
    !exactKeysWithOptional(
      input,
      new Set([
        'schemaVersion',
        'invocationId',
        'clientRequestId',
        'descriptorId',
        'descriptorDigest',
        'command',
        'arguments',
      ]),
      new Set(['body']),
    ) ||
    input.schemaVersion !== 1 ||
    typeof input.invocationId !== 'string' ||
    !SAFE_REQUEST_ID.test(input.invocationId) ||
    typeof input.clientRequestId !== 'string' ||
    !SAFE_REQUEST_ID.test(input.clientRequestId) ||
    typeof input.descriptorId !== 'string' ||
    !/^[a-z][a-z0-9.-]*:[a-z0-9][a-z0-9._/-]{0,127}$/u.test(input.descriptorId) ||
    typeof input.descriptorDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.descriptorDigest) ||
    typeof input.command !== 'string' ||
    !isRoutableCommand(input.command) ||
    !isRecord(input.arguments) ||
    Object.keys(input.arguments).length > MAX_ARGUMENTS ||
    Object.entries(input.arguments).some(
      ([name, value]) => !/^[a-z][a-zA-Z0-9_]{0,63}$/u.test(name) || !isCommandArgumentValue(value),
    ) ||
    (input.body !== undefined &&
      (typeof input.body !== 'string' || Buffer.byteLength(input.body) > MAX_BODY_BYTES))
  ) {
    routeFail('COMMAND_INVOCATION_INVALID')
  }
  return deepFreeze({
    schemaVersion: 1,
    invocationId: input.invocationId,
    clientRequestId: input.clientRequestId,
    descriptorId: input.descriptorId,
    descriptorDigest: input.descriptorDigest as `sha256:${string}`,
    command: input.command,
    arguments: Object.freeze({ ...input.arguments }) as Readonly<
      Record<string, CommandArgumentValueV1>
    >,
    ...(input.body === undefined ? {} : { body: input.body as string }),
  })
}

export function validateInputRouteResultV1(input: unknown): InputRouteResultV1 {
  if (!isRecord(input) || typeof input.kind !== 'string') {
    routeFail('INPUT_ROUTE_RESULT_INVALID')
  }
  switch (input.kind) {
    case 'ui_action':
      if (!exactKeys(input, new Set(['kind', 'invocation']))) {
        routeFail('INPUT_ROUTE_RESULT_INVALID')
      }
      return deepFreeze({
        kind: 'ui_action',
        invocation: validateCommandInvocationV1(input.invocation),
      })
    case 'runtime_action':
      if (
        !exactKeys(input, new Set(['kind', 'effect', 'invocation'])) ||
        !['query', 'mutation'].includes(String(input.effect))
      ) {
        routeFail('INPUT_ROUTE_RESULT_INVALID')
      }
      return deepFreeze({
        kind: 'runtime_action',
        effect: input.effect as 'query' | 'mutation',
        invocation: validateCommandInvocationV1(input.invocation),
      })
    case 'prompt_envelope':
      if (!exactKeys(input, new Set(['kind', 'envelope']))) {
        routeFail('INPUT_ROUTE_RESULT_INVALID')
      }
      return deepFreeze({
        kind: 'prompt_envelope',
        envelope: validatePromptEnvelope(input.envelope),
      })
    case 'bounded_job':
      if (
        !exactKeys(input, new Set(['kind', 'invocation', 'maxOutputBytes'])) ||
        !Number.isSafeInteger(input.maxOutputBytes) ||
        (input.maxOutputBytes as number) < 1 ||
        (input.maxOutputBytes as number) > 1024 * 1024
      ) {
        routeFail('INPUT_ROUTE_RESULT_INVALID')
      }
      return deepFreeze({
        kind: 'bounded_job',
        invocation: validateCommandInvocationV1(input.invocation),
        maxOutputBytes: input.maxOutputBytes as number,
      })
    case 'error':
      if (
        !exactKeys(input, new Set(['kind', 'error'])) ||
        !isRecord(input.error) ||
        !exactKeys(input.error, new Set(['code', 'category', 'retryable'])) ||
        typeof input.error.code !== 'string' ||
        !/^[A-Z][A-Z0-9_]{2,95}$/u.test(input.error.code) ||
        input.error.category !== 'command' ||
        input.error.retryable !== false
      ) {
        routeFail('INPUT_ROUTE_RESULT_INVALID')
      }
      return deepFreeze({
        kind: 'error',
        error: { code: input.error.code, category: 'command', retryable: false },
      })
    default:
      routeFail('INPUT_ROUTE_RESULT_INVALID')
  }
}

function validateContext(input: InputRouteContextV1): InputRouteContextV1 {
  if (
    typeof input !== 'object' ||
    input === null ||
    !SAFE_REQUEST_ID.test(input.clientRequestId) ||
    !SAFE_REQUEST_ID.test(input.promptId) ||
    !Array.isArray(input.catalogs) ||
    input.catalogs.length > 2 ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.capabilityDigest) ||
    typeof input.workspaceTrusted !== 'boolean' ||
    !['none', 'present'].includes(input.session) ||
    !['idle', 'active'].includes(input.run)
  ) {
    routeFail('INPUT_ROUTE_CONTEXT_INVALID')
  }
  const catalogs = input.catalogs.map(validateCommandCatalogSnapshotV1)
  if (
    catalogs.some(
      (catalog) =>
        catalog.capabilityDigest !== input.capabilityDigest ||
        catalog.workspaceTrusted !== input.workspaceTrusted ||
        catalog.workspaceId !== catalogs[0]?.workspaceId,
    ) ||
    new Set(catalogs.map((catalog) => catalog.owner)).size !== catalogs.length
  ) {
    routeFail('COMMAND_CAPABILITY_SNAPSHOT_STALE')
  }
  return deepFreeze({ ...input, catalogs: Object.freeze(catalogs) })
}

function parseCommandInput(
  input: string,
): { command: string; arguments: readonly string[]; body?: string } | { error: string } {
  const newline = input.search(/\r?\n/u)
  const header = newline < 0 ? input : input.slice(0, newline)
  const body = newline < 0 ? undefined : input.slice(newline + (input[newline] === '\r' ? 2 : 1))
  if (
    header.length < 2 ||
    Buffer.byteLength(header) > MAX_HEADER_BYTES ||
    (body !== undefined && Buffer.byteLength(body) > MAX_BODY_BYTES)
  ) {
    return { error: 'COMMAND_INPUT_INVALID' }
  }
  const tokens = tokenizeHeader(header)
  if ('error' in tokens || tokens.value.length < 1 || tokens.value.length > MAX_ARGUMENTS + 1) {
    return { error: 'COMMAND_HEADER_INVALID' }
  }
  const commandToken = tokens.value[0]!
  if (!commandToken.startsWith('/') || commandToken.length < 2) {
    return { error: 'COMMAND_HEADER_INVALID' }
  }
  return {
    command: commandToken.slice(1).toLowerCase(),
    arguments: Object.freeze(tokens.value.slice(1)),
    ...(body === undefined || body.length === 0 ? {} : { body }),
  }
}

function tokenizeHeader(input: string): { value: readonly string[] } | { error: string } {
  const tokens: string[] = []
  let token = ''
  let quote: 'single' | 'double' | undefined
  let active = false
  for (const character of input) {
    if (quote === undefined && (character === ' ' || character === '\t')) {
      if (active) {
        tokens.push(token)
        token = ''
        active = false
      }
      continue
    }
    if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single'
      active = true
      continue
    }
    if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double'
      active = true
      continue
    }
    token += character
    active = true
    if (Buffer.byteLength(token) > MAX_HEADER_BYTES) return { error: 'COMMAND_HEADER_INVALID' }
  }
  if (quote !== undefined) return { error: 'COMMAND_HEADER_INVALID' }
  if (active) tokens.push(token)
  return { value: Object.freeze(tokens) }
}

function resolveDescriptor(
  command: string,
  catalogs: readonly CommandCatalogSnapshotV1[],
): { catalog: CommandCatalogSnapshotV1; entry: CommandCatalogEntryV1 } | { error: string } {
  const entries = catalogs.flatMap((catalog) =>
    catalog.entries.map((entry) => ({ catalog, entry })),
  )
  const exact = entries.filter(({ entry }) => entry.descriptor.command === command)
  if (exact.length > 1) return { error: 'COMMAND_CATALOG_CONFLICT' }
  if (exact[0] !== undefined) return exact[0]
  const aliasOwners = entries.filter(({ entry }) => entry.descriptor.aliases.includes(command))
  if (aliasOwners.length > 1) return { error: 'COMMAND_AMBIGUOUS' }
  const available = aliasOwners.filter(({ entry }) => entry.availableAliases.includes(command))
  if (available.length === 1) return available[0]!
  return { error: 'COMMAND_UNKNOWN' }
}

function checkAvailability(
  descriptor: CommandDescriptorV1,
  context: InputRouteContextV1,
): string | undefined {
  if (descriptor.availability.requiresWorkspaceTrust && !context.workspaceTrusted) {
    return 'COMMAND_WORKSPACE_UNTRUSTED'
  }
  if (descriptor.availability.session === 'required' && context.session !== 'present') {
    return 'COMMAND_SESSION_REQUIRED'
  }
  if (descriptor.availability.run === 'idle' && context.run === 'active') {
    return 'COMMAND_UNAVAILABLE_ACTIVE_RUN'
  }
  if (descriptor.availability.run === 'active' && context.run !== 'active') {
    return 'COMMAND_ACTIVE_RUN_REQUIRED'
  }
  return undefined
}

function validateArguments(
  descriptor: CommandDescriptorV1,
  tokens: readonly string[],
  body?: string,
): { value: Readonly<Record<string, CommandArgumentValueV1>> } | { error: string } {
  const schema = descriptor.schema
  if (tokens.length > schema.positional.length) return { error: 'COMMAND_ARGUMENTS_INVALID' }
  const value: Record<string, CommandArgumentValueV1> = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const name = schema.positional[index]
    const property = name === undefined ? undefined : schema.properties[name]
    if (name === undefined || property === undefined) return { error: 'COMMAND_ARGUMENTS_INVALID' }
    const parsed = parseArgument(tokens[index]!, property)
    if (parsed === undefined) return { error: 'COMMAND_ARGUMENTS_INVALID' }
    value[name] = parsed
  }
  if (body !== undefined) {
    const property = schema.properties.body
    if (property === undefined || schema.positional.includes('body') || value.body !== undefined) {
      return { error: 'COMMAND_BODY_UNSUPPORTED' }
    }
    const parsed = parseArgument(body, property)
    if (parsed === undefined) return { error: 'COMMAND_ARGUMENTS_INVALID' }
    value.body = parsed
  }
  if (schema.required.some((name) => value[name] === undefined)) {
    return { error: 'COMMAND_ARGUMENTS_REQUIRED' }
  }
  return { value: deepFreeze(value) }
}

function parseArgument(
  input: string,
  property: CommandArgumentPropertyV1,
): CommandArgumentValueV1 | undefined {
  switch (property.type) {
    case 'string': {
      const bytes = Buffer.byteLength(input)
      if (
        (property.minLength !== undefined && bytes < property.minLength) ||
        (property.maxLength !== undefined && bytes > property.maxLength) ||
        (property.enum !== undefined && !property.enum.includes(input))
      ) {
        return undefined
      }
      return input
    }
    case 'integer': {
      if (!/^-?(?:0|[1-9][0-9]*)$/u.test(input)) return undefined
      const value = Number(input)
      if (
        !Number.isSafeInteger(value) ||
        (property.minimum !== undefined && value < property.minimum) ||
        (property.maximum !== undefined && value > property.maximum)
      ) {
        return undefined
      }
      return value
    }
    case 'boolean':
      return input === 'true' ? true : input === 'false' ? false : undefined
  }
}

function createInvocation(
  descriptor: CommandDescriptorV1,
  arguments_: Readonly<Record<string, CommandArgumentValueV1>>,
  body: string | undefined,
  clientRequestId: string,
): CommandInvocationV1 {
  return validateCommandInvocationV1({
    schemaVersion: 1,
    invocationId: `command:${clientRequestId}`,
    clientRequestId,
    descriptorId: descriptor.id,
    descriptorDigest: descriptor.descriptorDigest,
    command: descriptor.command,
    arguments: arguments_,
    ...(body === undefined ? {} : { body }),
  })
}

function routeError(code: string): InputRouteResultV1 {
  return validateInputRouteResultV1({
    kind: 'error',
    error: { code, category: 'command', retryable: false },
  })
}

function isCommandArgumentValue(value: unknown): value is CommandArgumentValueV1 {
  return (
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && Buffer.byteLength(value) <= MAX_BODY_BYTES)
  )
}

function isRoutableCommand(input: string): boolean {
  return (
    /^[a-z][a-z0-9-]{0,47}$/u.test(input) ||
    /^(?:prompt|skill):[a-z0-9][a-z0-9._-]{0,63}$/u.test(input) ||
    /^(?:plugin|mcp):[a-z0-9][a-z0-9._-]{0,63}\/[a-z][a-z0-9-]{0,47}$/u.test(input)
  )
}

function exactKeys(input: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(input)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function exactKeysWithOptional(
  input: Record<string, unknown>,
  required: ReadonlySet<string>,
  optional: ReadonlySet<string>,
): boolean {
  return (
    [...required].every((key) => Object.hasOwn(input, key)) &&
    Object.keys(input).every((key) => required.has(key) || optional.has(key))
  )
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function routeFail(code: string): never {
  throw Object.assign(new Error(code), { code })
}

function errorCode(error: unknown, fallback: string): string {
  const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,95}$/u.test(code) ? code : fallback
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}
