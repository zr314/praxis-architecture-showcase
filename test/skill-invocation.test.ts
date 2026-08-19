import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ProviderMessage, SessionRecord, SkillInvocationEntry } from '@praxis/core-sdk'
import { ResourceCatalog } from '../apps/runtime/src/extensions/resourceRegistry.js'
import {
  SkillInvocationService,
  SkillTool,
  renderSkillInvocation,
} from '../apps/runtime/src/extensions/skillInvocationService.js'
import { ToolRuntime } from '../apps/runtime/src/tools/toolRuntime.js'
import { CompactionService } from '../apps/runtime/src/memory/compactionService.js'
import { selectContextWindow } from '../apps/runtime/src/memory/contextWindow.js'
import { JsonlRepository } from '../apps/runtime/src/session-db/jsonlRepository.js'

test('Skill invocation returns a typed replayable record through the normal Tool runtime', async () => {
  const workspace = await skillWorkspace(false)
  try {
    const snapshot = await selectedSnapshot(workspace)
    const service = new SkillInvocationService(snapshot)
    const tools = new ToolRuntime([new SkillTool(service)])
    const result = await tools.execute(
      'skill',
      { name: 'review', arguments: 'focus on cancellation' },
      workspace,
      new AbortController().signal,
    )

    assert.equal(result.ok, true)
    assert.deepEqual(result.output, {
      type: 'skill_invocation',
      version: 1,
      capabilityId: 'project/review',
      origin: `project:${workspace}`,
      digest: snapshot.skills[0]?.digest,
      arguments: 'focus on cancellation',
      content:
        '---\nname: review\ndescription: Review safely.\ndisable-model-invocation: false\n---\nReview exact content.\n',
    })
    assert.equal(tools.requiresPermission('skill', { name: 'review' }, workspace), false)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('disable-model-invocation still permits explicit user invocation', async () => {
  const workspace = await skillWorkspace(true)
  try {
    const service = new SkillInvocationService(await selectedSnapshot(workspace))
    await assert.rejects(
      service.invoke({ name: 'review', arguments: '', source: 'model' }),
      hasCode('SKILL_MODEL_INVOCATION_DISABLED'),
    )
    assert.equal(
      (await service.invoke({ name: 'review', arguments: 'manual', source: 'user' })).arguments,
      'manual',
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('Skill arguments are bounded untrusted text', async () => {
  const workspace = await skillWorkspace(false)
  try {
    const service = new SkillInvocationService(await selectedSnapshot(workspace))
    await assert.rejects(
      service.invoke({ name: 'review', arguments: 'x'.repeat(4_097), source: 'user' }),
      hasCode('SKILL_ARGUMENTS_TOO_LARGE'),
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('iron-law-lean-v1 keeps Skill schemas stable and uses a neutral model envelope', async () => {
  const workspace = await skillWorkspace(false)
  try {
    const service = new SkillInvocationService(await selectedSnapshot(workspace))
    const baseline = new SkillTool(service, 'baseline-v1').definition
    const lean = new SkillTool(service, 'iron-law-lean-v1').definition
    const invocation = await service.invoke({ name: 'review', arguments: '', source: 'user' })
    const visible = `${lean.description}\n${renderSkillInvocation(invocation, 'iron-law-lean-v1')}`

    assert.deepEqual(lean.parameters, baseline.parameters)
    assert.deepEqual(lean.outputSchema, baseline.outputSchema)
    assert.deepEqual(lean.execution, baseline.execution)
    assert.match(visible, /<praxis-context kind="skill_invocation">/u)
    assert.doesNotMatch(visible, /system-reminder|low-trust|untrusted guidance|high-trust/iu)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('per-run ToolRuntime forks do not mutate the shared capability registry', async () => {
  const workspace = await skillWorkspace(false)
  try {
    const base = new ToolRuntime([])
    const turn = base.fork([
      new SkillTool(new SkillInvocationService(await selectedSnapshot(workspace))),
    ])

    assert.equal(
      base.definitions().some((definition) => definition.name === 'skill'),
      false,
    )
    assert.equal(
      turn.definitions().some((definition) => definition.name === 'skill'),
      true,
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('typed Skill invocations survive persistence, branching, export, and compaction replay', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-skill-session-'))
  try {
    const repository = new JsonlRepository(home)
    await repository.initialize()
    const session = sessionRecord('skill-source')
    await repository.create(session)
    const invocation: SkillInvocationEntry = {
      type: 'skill_invocation',
      version: 1,
      capabilityId: 'project/review',
      origin: 'project:workspace',
      digest: `sha256:${'a'.repeat(64)}`,
      arguments: 'focus on cancellation',
      content: 'Exact immutable Skill content.',
    }
    const message: ProviderMessage = {
      role: 'user',
      content: 'Low-trust Skill guidance: Exact immutable Skill content.',
      intent: 'context',
      trust: 'low',
      skillInvocation: invocation,
    }
    await repository.appendMessage(session.sessionId, message)

    assert.deepEqual((await repository.loadMessages(session.sessionId))[0], message)
    await repository.forkSession(session.sessionId, sessionRecord('skill-branch'))
    assert.deepEqual((await repository.exportSession('skill-branch')).messages[0], message)

    const messages: ProviderMessage[] = [
      message,
      ...Array.from({ length: 7 }, (_, index) => ({
        role: 'user' as const,
        content: `message-${index} ${'compressible context '.repeat(24)}`,
      })),
    ]
    const checkpoint = await new CompactionService({ retainRecentMessages: 2 }).compact({
      sessionId: session.sessionId,
      messages,
    })
    assert.deepEqual(checkpoint?.skillInvocations, [invocation])
    const selected = selectContextWindow({
      messages,
      checkpoint,
      maxTokens: 4_096,
    })
    assert.match(
      selected.contextMessages.map((candidate) => String(candidate.content)).join('\n'),
      /Exact immutable Skill content/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

async function skillWorkspace(disabled: boolean): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-skill-invocation-'))
  const directory = join(workspace, '.praxis', 'skills', 'review')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'SKILL.md'),
    [
      '---',
      'name: review',
      'description: Review safely.',
      `disable-model-invocation: ${String(disabled)}`,
      '---',
      'Review exact content.',
      '',
    ].join('\n'),
    'utf8',
  )
  return workspace
}

async function selectedSnapshot(workspace: string) {
  const catalog = new ResourceCatalog()
  await catalog.refresh(workspace, [
    {
      path: join(workspace, '.praxis', 'skills'),
      namespace: 'project',
      origin: `project:${workspace}`,
      sourceType: 'project',
      trusted: false,
    },
  ])
  await catalog.enable(workspace, 'project/review', { projectTrusted: true })
  return catalog.snapshot(workspace)
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

function sessionRecord(sessionId: string): SessionRecord {
  return {
    recordVersion: 2,
    sessionId,
    state: 'idle',
    cwd: process.cwd(),
    provider: 'mock',
    model: 'mock',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
  }
}
