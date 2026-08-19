import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CommandRegistryV1, InputRouterV1, type CommandInvocationV1 } from '@praxis/core-sdk'
import { PromptCommandAdapterV1 } from '../apps/runtime/src/commands/promptCommandAdapter.js'
import { ResourceCatalog } from '../apps/runtime/src/extensions/resourceRegistry.js'

test('prompt templates and slash Skills produce trust-separated envelopes from one pinned snapshot', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-prompt-command-'))
  const skillPath = join(workspace, 'skills', 'review', 'SKILL.md')
  const templatePath = join(workspace, 'prompts', 'review.prompt.md')
  try {
    await mkdir(join(workspace, 'skills', 'review'), { recursive: true })
    await mkdir(join(workspace, 'prompts'), { recursive: true })
    await writeFile(
      skillPath,
      '---\nname: review\ndescription: Review with pinned Skill guidance.\n---\nUse the exact review checklist.\n',
      'utf8',
    )
    await writeFile(
      templatePath,
      [
        '---',
        'name: review',
        'description: Review one target with optional focus.',
        'arguments: target, focus?',
        'persistence: plaintext',
        '---',
        'Review {{target}}.',
        'Prioritize {{focus}}.',
        '{{body}}',
      ].join('\n'),
      'utf8',
    )
    const catalog = new ResourceCatalog()
    const source = {
      path: workspace,
      namespace: 'project',
      origin: `project:${workspace}`,
      sourceType: 'project' as const,
      trusted: false,
    }
    await catalog.refresh(workspace, [source])
    await catalog.enable(workspace, 'project/review', { projectTrusted: true })
    await catalog.enable(workspace, 'project/template/review', { projectTrusted: true })
    const snapshot = catalog.snapshot(workspace)
    const adapter = new PromptCommandAdapterV1(snapshot)
    const registry = new CommandRegistryV1({ owner: 'runtime' })
    for (const descriptor of adapter.descriptors()) registry.register(descriptor)
    const commands = registry.snapshot({
      workspaceId: 'workspace-test',
      workspaceTrusted: true,
      capabilityIds: ['prompt.invoke', 'skill.invoke'],
    })
    assert.deepEqual(
      commands.entries.map(({ descriptor }) => descriptor.command),
      ['prompt:review', 'skill:review'],
    )
    let templateInvocation: CommandInvocationV1 | undefined
    let producerError: unknown
    const router = new InputRouterV1({
      promptCommandProducer: {
        produce: async ({ descriptor, invocation }) => {
          if (descriptor.command === 'prompt:review') templateInvocation = invocation
          try {
            return (
              await adapter.produce({
                descriptor,
                invocation,
                promptId: `prompt-${invocation.clientRequestId}`,
              })
            ).envelope
          } catch (error) {
            producerError = error
            throw error
          }
        },
      },
    })
    const template = await router.route(
      '/prompt:review src cancellation\nCheck tests.',
      routeContext(commands, 'template-request'),
    )
    if (producerError !== undefined) throw producerError
    assert.equal(template.kind, 'prompt_envelope', JSON.stringify(template))
    if (template.kind !== 'prompt_envelope') throw new Error('template route failed')
    assert.equal(template.envelope.source, 'prompt_template')
    assert.equal(template.envelope.effectiveText, 'Check tests.')
    assert.equal(template.envelope.parts[0]?.trust, 'user')
    assert.equal(template.envelope.parts.at(-1)?.trust, 'low')
    assert.match(template.envelope.parts.at(-1)?.text ?? '', /Review src/u)
    assert.match(template.envelope.parts.at(-1)?.text ?? '', /Prioritize cancellation/u)
    assert.match(template.envelope.parts.at(-1)?.origin ?? '', /#sha256:/u)
    assert.equal(template.envelope.commandInvocationId, 'command:template-request')

    const skill = await router.route(
      '/skill:review private-argument\nReview the exact diff.',
      routeContext(commands, 'skill-request'),
    )
    assert.equal(skill.kind, 'prompt_envelope', JSON.stringify(skill))
    if (skill.kind !== 'prompt_envelope') throw new Error('skill route failed')
    assert.equal(skill.envelope.source, 'skill')
    assert.equal(skill.envelope.effectiveText, 'Review the exact diff.')
    assert.deepEqual(
      skill.envelope.parts.map(({ kind, trust, persistence }) => ({
        kind,
        trust,
        persistence,
      })),
      [
        { kind: 'user_input', trust: 'user', persistence: 'plaintext' },
        { kind: 'command_arguments', trust: 'user', persistence: 'digest' },
        { kind: 'skill_invocation', trust: 'low', persistence: 'plaintext' },
      ],
    )
    assert.match(skill.envelope.parts.at(-1)?.text ?? '', /exact review checklist/u)

    const skillWithoutBody = await router.route(
      '/skill:review private-objective',
      routeContext(commands, 'skill-without-body'),
    )
    assert.equal(skillWithoutBody.kind, 'prompt_envelope', JSON.stringify(skillWithoutBody))
    if (skillWithoutBody.kind !== 'prompt_envelope') throw new Error('skill route failed')
    assert.equal(skillWithoutBody.envelope.effectiveText, '[Invoke Skill project/review.]')
    assert.doesNotMatch(skillWithoutBody.envelope.parts[0]?.text ?? '', /private-objective/u)

    const oldTemplate = commands.entries.find(
      ({ descriptor }) => descriptor.command === 'prompt:review',
    )!.descriptor
    assert.ok(templateInvocation)
    await writeFile(
      templatePath,
      '---\nname: review\ndescription: Changed implementation.\narguments: target\n---\nChanged {{target}}.\n',
      'utf8',
    )
    await catalog.refresh(workspace, [source])
    const changed = new PromptCommandAdapterV1(catalog.snapshot(workspace))
    await assert.rejects(
      changed.produce({
        descriptor: oldTemplate,
        invocation: templateInvocation,
        promptId: 'prompt-drift',
      }),
      hasCode('COMMAND_RESOURCE_DRIFT'),
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('template discovery rejects unbounded or malformed parameter contracts', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-prompt-command-invalid-'))
  try {
    await writeFile(
      join(workspace, 'invalid-arguments.prompt.md'),
      '---\nname: invalid\ndescription: Invalid template.\narguments: a,b,c,d,e,f,g,h,i\n---\n{{unknown}}\n',
      'utf8',
    )
    await writeFile(
      join(workspace, 'invalid-placeholder.prompt.md'),
      '---\nname: invalid-placeholder\ndescription: Invalid placeholder.\narguments: target\n---\n{{target-name}}\n',
      'utf8',
    )
    const result = await new ResourceCatalog().refresh(workspace, [
      {
        path: workspace,
        namespace: 'project',
        origin: `project:${workspace}`,
        sourceType: 'project',
        trusted: false,
      },
    ])
    assert.equal(result.resources.length, 0)
    assert.deepEqual(
      new Set(result.rejected.map(({ code }) => code)),
      new Set(['TEMPLATE_ARGUMENTS_INVALID', 'TEMPLATE_PLACEHOLDER_INVALID']),
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

function routeContext(catalog: ReturnType<CommandRegistryV1['snapshot']>, clientRequestId: string) {
  return {
    clientRequestId,
    promptId: `prompt:${clientRequestId}`,
    catalogs: [catalog],
    capabilityDigest: catalog.capabilityDigest,
    workspaceTrusted: true,
    session: 'present' as const,
    run: 'idle' as const,
  }
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}
