import {
  type CommandDescriptorV1,
  type CommandInvocationV1,
  createCommandDescriptorV1,
  createPromptEnvelope,
  type PromptEnvelope,
  promptDigest,
  runtimeError,
  type SkillInvocationEntry,
  validateCommandInvocationAgainstDescriptorV1,
} from '@praxis/core-sdk'
import { SkillInvocationService } from '../extensions/skillInvocationService.js'
import type {
  SnapshotSkill,
  SnapshotTemplate,
  TurnResourceSnapshot,
} from '../extensions/resourceRegistry.js'

export const PROMPT_COMMAND_CAPABILITIES_V1 = Object.freeze(['prompt.invoke', 'skill.invoke'])

export type ProducedPromptCommandV1 = Readonly<{
  envelope: PromptEnvelope
  skillInvocation?: SkillInvocationEntry
  sensitiveValues: readonly string[]
}>

/** Builds prompt-producing descriptors and envelopes only from one immutable resource snapshot. */
export class PromptCommandAdapterV1 {
  readonly #templates: readonly Readonly<SnapshotTemplate>[]
  readonly #skills: readonly Readonly<SnapshotSkill>[]
  readonly #skillService: SkillInvocationService

  constructor(readonly snapshot: TurnResourceSnapshot) {
    this.#templates = uniqueCommandResources(snapshot.templates ?? [])
    this.#skills = uniqueCommandResources(snapshot.skills)
    this.#skillService = new SkillInvocationService(snapshot)
  }

  descriptors(): CommandDescriptorV1[] {
    return [...this.#templates.map(templateDescriptor), ...this.#skills.map(skillDescriptor)].sort(
      (left, right) => left.command.localeCompare(right.command),
    )
  }

  async produce(input: {
    descriptor: CommandDescriptorV1
    invocation: CommandInvocationV1
    promptId: string
  }): Promise<ProducedPromptCommandV1> {
    const invocation = validateCommandInvocationAgainstDescriptorV1(
      input.invocation,
      input.descriptor,
    )
    if (input.descriptor.kind === 'prompt_template') {
      const template = this.#templates.find(
        (candidate) => `prompt:${candidate.localId}` === input.descriptor.command,
      )
      if (template === undefined) throw commandResourceDrift()
      assertResourceBinding(template, input.descriptor)
      return produceTemplate(template, invocation, input.promptId)
    }
    if (input.descriptor.kind === 'skill_invocation') {
      const skill = this.#skills.find(
        (candidate) => `skill:${candidate.localId}` === input.descriptor.command,
      )
      if (skill === undefined) throw commandResourceDrift()
      assertResourceBinding(skill, input.descriptor)
      const argumentsText = stringArgument(invocation.arguments.arguments)
      const record = await this.#skillService.invoke({
        name: skill.id,
        arguments: argumentsText,
        source: 'user',
      })
      if (record.origin !== skill.origin || record.digest !== skill.digest) {
        throw commandResourceDrift()
      }
      const body = stringArgument(invocation.arguments.body).trim()
      return {
        envelope: createSkillPromptEnvelopeV1({
          promptId: input.promptId,
          commandInvocationId: invocation.invocationId,
          invocation: record,
          effectiveText: body || `[Invoke Skill ${record.capabilityId}.]`,
        }),
        skillInvocation: record,
        sensitiveValues: argumentsText.length === 0 ? [] : [argumentsText],
      }
    }
    throw runtimeError(
      'COMMAND_PROMPT_DESCRIPTOR_INVALID',
      'protocol',
      'Command is not a prompt-producing resource.',
    )
  }
}

export function createSkillPromptEnvelopeV1(input: {
  promptId: string
  commandInvocationId: string
  invocation: SkillInvocationEntry
  effectiveText: string
  rawInput?: string
}): PromptEnvelope {
  const argumentsText = input.invocation.arguments
  return createPromptEnvelope({
    id: input.promptId,
    source: 'skill',
    effectiveText: input.effectiveText,
    ...(input.rawInput === undefined ? {} : { rawInput: input.rawInput }),
    rawInputPersistence: 'none',
    userInputPersistence: 'plaintext',
    commandInvocationId: input.commandInvocationId,
    additionalParts: [
      ...(argumentsText.length === 0
        ? []
        : [
            {
              kind: 'command_arguments' as const,
              trust: 'user' as const,
              persistence: 'digest' as const,
              origin: 'user:skill-arguments',
              digest: promptDigest(argumentsText),
              text: argumentsText,
              ref: input.invocation.capabilityId,
            },
          ]),
      {
        kind: 'skill_invocation' as const,
        trust: 'low' as const,
        persistence: 'plaintext' as const,
        origin: input.invocation.origin,
        digest: input.invocation.digest,
        text: input.invocation.content,
        ref: input.invocation.capabilityId,
      },
    ],
  })
}

function produceTemplate(
  template: Readonly<SnapshotTemplate>,
  invocation: CommandInvocationV1,
  promptId: string,
): ProducedPromptCommandV1 {
  const values = Object.fromEntries(
    Object.entries(invocation.arguments).map(([name, value]) => [name, String(value)]),
  )
  let expansion = template.content
  for (const parameter of template.parameters) {
    expansion = replacePlaceholder(expansion, parameter.name, values[parameter.name] ?? '')
  }
  if (template.acceptsBody) expansion = replacePlaceholder(expansion, 'body', values.body ?? '')
  if (expansion.length < 1 || Buffer.byteLength(expansion, 'utf8') > 32_768) {
    throw runtimeError(
      'TEMPLATE_EXPANSION_INVALID',
      'protocol',
      'Prompt template expansion is outside the bounded contract.',
    )
  }
  const argumentText = canonicalArguments(values)
  const fallbackText = `Apply prompt template ${template.id}.`
  const requestedText =
    values.body ||
    template.parameters
      .map(({ name }) => values[name])
      .filter((value): value is string => Boolean(value))
      .join('\n') ||
    fallbackText
  const userText = requestedText.trim() || fallbackText
  const qualifiedOrigin = `${template.origin}#${template.digest}`
  const origin =
    Buffer.byteLength(qualifiedOrigin) <= 512
      ? qualifiedOrigin
      : `${template.id}#${template.digest}`
  return {
    envelope: createPromptEnvelope({
      id: promptId,
      source: 'prompt_template',
      effectiveText: userText,
      rawInputPersistence: 'none',
      userInputPersistence: template.persistence,
      commandInvocationId: invocation.invocationId,
      additionalParts: [
        ...(argumentText === '{}'
          ? []
          : [
              {
                kind: 'command_arguments' as const,
                trust: 'user' as const,
                persistence: template.persistence,
                origin: 'user:template-arguments',
                digest: promptDigest(argumentText),
                text: argumentText,
                ref: template.id,
              },
            ]),
        {
          kind: 'template_expansion' as const,
          trust: 'low' as const,
          persistence: template.persistence,
          origin,
          digest: promptDigest(expansion),
          text: expansion,
          ref: template.id,
        },
      ],
    }),
    sensitiveValues:
      template.persistence === 'plaintext' ? [] : Object.values(values).filter(Boolean),
  }
}

function templateDescriptor(template: Readonly<SnapshotTemplate>): CommandDescriptorV1 {
  const properties = Object.fromEntries(
    template.parameters.map(({ name, maxBytes }) => [
      name,
      { type: 'string' as const, minLength: 1, maxLength: maxBytes },
    ]),
  )
  if (template.acceptsBody) {
    properties.body = { type: 'string', minLength: 1, maxLength: 16_384 }
  }
  const sensitiveArguments =
    template.persistence === 'plaintext' ? [] : Object.keys(properties).map((name) => `/${name}`)
  return createCommandDescriptorV1({
    id: `prompt:resource/${template.localId}`,
    command: `prompt:${template.localId}`,
    aliases: [],
    title: template.name,
    description: template.description,
    usage: templateUsage(template),
    kind: 'prompt_template',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties,
      required: template.parameters.filter(({ required }) => required).map(({ name }) => name),
      positional: template.parameters.map(({ name }) => name),
    },
    source: {
      kind: 'prompt',
      origin: template.origin,
      namespace: template.localId,
      digest: template.digest,
    },
    effect: 'prompt',
    capabilities: ['prompt.invoke'],
    availability: { session: 'required', run: 'idle', requiresWorkspaceTrust: true },
    output: { kind: 'prompt_envelope', maxBytes: 256 * 1_024 },
    sensitiveArguments,
    persistence: template.persistence,
  })
}

function skillDescriptor(skill: Readonly<SnapshotSkill>): CommandDescriptorV1 {
  return createCommandDescriptorV1({
    id: `skill:resource/${skill.localId}`,
    command: `skill:${skill.localId}`,
    aliases: [],
    title: skill.name,
    description: skill.description,
    usage: `/skill:${skill.localId} [arguments]`,
    kind: 'skill_invocation',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        arguments: { type: 'string', minLength: 1, maxLength: 4_096 },
        body: { type: 'string', minLength: 1, maxLength: 16_384 },
      },
      required: [],
      positional: ['arguments'],
    },
    source: {
      kind: 'skill',
      origin: skill.origin,
      namespace: skill.localId,
      digest: skill.digest,
    },
    effect: 'prompt',
    capabilities: ['skill.invoke'],
    availability: { session: 'required', run: 'idle', requiresWorkspaceTrust: true },
    output: { kind: 'prompt_envelope', maxBytes: 256 * 1_024 },
    sensitiveArguments: ['/arguments'],
    persistence: 'digest',
  })
}

function uniqueCommandResources<T extends { localId: string; origin: string }>(
  resources: readonly T[],
): T[] {
  const counts = new Map<string, number>()
  for (const resource of resources)
    counts.set(resource.localId, (counts.get(resource.localId) ?? 0) + 1)
  return resources.filter(
    ({ localId, origin }) =>
      counts.get(localId) === 1 &&
      /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(localId) &&
      Buffer.byteLength(origin) <= 512 &&
      !/[\r\n]/u.test(origin),
  )
}

function assertResourceBinding(
  resource: Readonly<{ origin: string; digest: string }>,
  descriptor: CommandDescriptorV1,
): void {
  if (
    descriptor.source.origin !== resource.origin ||
    descriptor.source.digest !== resource.digest
  ) {
    throw commandResourceDrift()
  }
}

function replacePlaceholder(source: string, name: string, value: string): string {
  return source.replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'gu'), () => value)
}

function templateUsage(template: Readonly<SnapshotTemplate>): string {
  const parameters = template.parameters
    .map(({ name, required }) => (required ? `<${name}>` : `[${name}]`))
    .join(' ')
  return `/prompt:${template.localId}${parameters.length === 0 ? '' : ` ${parameters}`}`
}

function canonicalArguments(values: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))),
  )
}

function stringArgument(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function commandResourceDrift() {
  return runtimeError(
    'COMMAND_RESOURCE_DRIFT',
    'plugin',
    'Prompt resource no longer matches the command descriptor snapshot.',
  )
}
