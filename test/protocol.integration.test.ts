import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { InputRouterV1, promptDigest, type SessionMemory, type TraceRecord } from '@praxis/core-sdk'
import { startLocalRuntime as startLocalRuntimeProcess } from '../apps/cli/src/bridge/localRuntime.js'
import { NdjsonRuntimeBridge } from '../apps/cli/src/bridge/ndjsonBridge.js'
import { permissionPreview } from '../apps/cli/src/ui/permissionPreview.js'
import { executeSlashCommand } from '../apps/cli/src/ui/slashCommands.js'
import { mcpRuntimeToolName } from '../apps/runtime/src/extensions/mcpStdioClient.js'
import { processRuntimeToolName } from '../apps/runtime/src/extensions/processActivationService.js'

const runtimeEntry = fileURLToPath(new URL('../apps/runtime/src/entry.ts', import.meta.url))
const crashingRuntimeEntry = fileURLToPath(
  new URL('./fixtures/crashing-runtime.ts', import.meta.url),
)
const malformedRuntimeEntry = fileURLToPath(
  new URL('./fixtures/malformed-runtime.ts', import.meta.url),
)
const sequenceGapRuntimeEntry = fileURLToPath(
  new URL('./fixtures/sequence-gap-runtime.ts', import.meta.url),
)
const schemaInvalidRuntimeEntry = fileURLToPath(
  new URL('./fixtures/schema-invalid-runtime.ts', import.meta.url),
)
const finalizationRuntimeEntry = fileURLToPath(
  new URL('./fixtures/finalization-runtime.ts', import.meta.url),
)
const exampleToolPlugin = fileURLToPath(new URL('../examples/plugins/tool', import.meta.url))
const exampleMcpPlugin = fileURLToPath(new URL('../examples/plugins/mcp-server', import.meta.url))
const processRuntimePluginFixture = fileURLToPath(
  new URL('./fixtures/process-runtime-plugin.mjs', import.meta.url),
)
const isolatedRuntimeHomes: string[] = []

after(async () => {
  await Promise.all(
    isolatedRuntimeHomes.map((storage) => rm(storage, { recursive: true, force: true })),
  )
})

async function startLocalRuntime(
  entry: string,
  environment?: NodeJS.ProcessEnv,
): Promise<NdjsonRuntimeBridge> {
  if (environment?.PRAXIS_HOME) return startLocalRuntimeProcess(entry, environment)
  const storage = await mkdtemp(join(tmpdir(), 'praxis-protocol-isolated-home-'))
  isolatedRuntimeHomes.push(storage)
  return startLocalRuntimeProcess(entry, {
    ...(environment ?? process.env),
    PRAXIS_HOME: storage,
  })
}

test('shipping commands.list/invoke enforce digest binding and durable audit ordering', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-command-protocol-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-command-protocol-workspace-'))
  const bridge = await startLocalRuntime(runtimeEntry, { ...process.env, PRAXIS_HOME: storage })
  try {
    const session = await bridge.createSession({ cwd: workspace, provider: 'mock' })
    const catalog = await bridge.listCommands(workspace)
    assert.equal(catalog.owner, 'runtime')
    assert.ok(catalog.entries.some(({ descriptor }) => descriptor.command === 'compact'))
    const route = async (source: string, clientRequestId: string) => {
      const routed = await new InputRouterV1().route(source, {
        clientRequestId,
        promptId: `prompt:${clientRequestId}`,
        catalogs: [catalog],
        capabilityDigest: catalog.capabilityDigest,
        workspaceTrusted: catalog.workspaceTrusted,
        session: 'present',
        run: 'idle',
      })
      assert.equal(routed.kind, 'runtime_action')
      if (routed.kind !== 'runtime_action') throw new Error('command route failed')
      return routed.invocation
    }
    const compact = await route('/compact', 'command-protocol-1')
    await assert.rejects(
      bridge.invokeCommand({
        schemaVersion: 1,
        workspace,
        catalogSnapshotDigest: `sha256:${'f'.repeat(64)}`,
        capabilityDigest: catalog.capabilityDigest,
        invocation: compact,
        sessionId: session.sessionId,
      }),
      /COMMAND_CATALOG_STALE/u,
    )
    await assert.rejects(
      bridge.invokeCommand({
        schemaVersion: 1,
        workspace,
        catalogSnapshotDigest: catalog.snapshotDigest,
        capabilityDigest: catalog.capabilityDigest,
        invocation: compact,
        sessionId: session.sessionId,
      }),
      /COMPACTION_NO_RANGE/u,
    )

    const contextBefore = await bridge.invokeCommand({
      schemaVersion: 1,
      workspace,
      catalogSnapshotDigest: catalog.snapshotDigest,
      capabilityDigest: catalog.capabilityDigest,
      invocation: await route('/context', 'command-context-before'),
      sessionId: session.sessionId,
    })
    assert.equal(contextBefore.effect, 'read')
    assert.equal(contextBefore.output.kind, 'ui_action')
    if (contextBefore.output.kind !== 'ui_action') throw new Error('context output missing')
    assert.match(String(contextBefore.output.payload?.message), /Original history: retained/u)
    assert.equal(
      (contextBefore.output.payload?.report as { checkpoint?: unknown } | undefined)?.checkpoint,
      null,
    )

    const humanTasks = await bridge.invokeCommand({
      schemaVersion: 1,
      workspace,
      catalogSnapshotDigest: catalog.snapshotDigest,
      capabilityDigest: catalog.capabilityDigest,
      invocation: await route('/human-tasks', 'command-human-tasks'),
      sessionId: session.sessionId,
    })
    assert.equal(humanTasks.effect, 'read')
    if (humanTasks.output.kind !== 'ui_action') throw new Error('HumanTask output missing')
    assert.match(String(humanTasks.output.payload?.message), /No Workflow/u)

    const plannerBefore = await bridge.invokeCommand({
      schemaVersion: 1,
      workspace,
      catalogSnapshotDigest: catalog.snapshotDigest,
      capabilityDigest: catalog.capabilityDigest,
      invocation: await route('/planner', 'command-planner-before'),
      sessionId: session.sessionId,
    })
    if (plannerBefore.output.kind !== 'ui_action') throw new Error('planner output missing')
    assert.match(String(plannerBefore.output.payload?.message), /Planner: auto/u)
    const plannerSelected = await bridge.invokeCommand({
      schemaVersion: 1,
      workspace,
      catalogSnapshotDigest: catalog.snapshotDigest,
      capabilityDigest: catalog.capabilityDigest,
      invocation: await route('/planner supervisor', 'command-planner-supervisor'),
      sessionId: session.sessionId,
    })
    assert.equal(plannerSelected.effect, 'mutation')
    if (plannerSelected.output.kind !== 'ui_action') {
      throw new Error('planner selection output missing')
    }
    assert.match(
      String(plannerSelected.output.payload?.message),
      /next run.*workflow|workflow.*next run/iu,
    )
    assert.equal((await bridge.resumeSession(session.sessionId)).plannerMode, 'workflow')
    await bridge.invokeCommand({
      schemaVersion: 1,
      workspace,
      catalogSnapshotDigest: catalog.snapshotDigest,
      capabilityDigest: catalog.capabilityDigest,
      invocation: await route('/planner direct', 'command-planner-direct'),
      sessionId: session.sessionId,
    })

    const storageStatus = await bridge.invokeCommand({
      schemaVersion: 1,
      workspace,
      catalogSnapshotDigest: catalog.snapshotDigest,
      capabilityDigest: catalog.capabilityDigest,
      invocation: await route('/storage', 'command-storage'),
      sessionId: session.sessionId,
    })
    assert.equal(storageStatus.effect, 'read')
    if (storageStatus.output.kind !== 'ui_action') throw new Error('storage output missing')
    assert.match(String(storageStatus.output.payload?.message), /V3 JSONL/u)
    assert.deepEqual(storageStatus.output.payload?.storage, {
      authority: 'v3',
      store: 'jsonl',
      root: storage,
      liveSwitch: false,
    })

    const busySession = await bridge.createSession({ cwd: workspace, provider: 'mock' })
    const busyIterator = bridge
      .prompt({
        sessionId: busySession.sessionId,
        text: 'keep this run active for the manual compaction busy gate',
        clientRequestId: 'command-compaction-busy-run',
      })
      [Symbol.asyncIterator]()
    const started = await busyIterator.next()
    assert.equal(started.value?.type, 'prompt_started')
    await assert.rejects(
      bridge.invokeCommand({
        schemaVersion: 1,
        workspace,
        catalogSnapshotDigest: catalog.snapshotDigest,
        capabilityDigest: catalog.capabilityDigest,
        invocation: await route('/compact', 'command-compact-busy'),
        sessionId: busySession.sessionId,
      }),
      /COMMAND_UNAVAILABLE_ACTIVE_RUN/u,
    )
    await assert.rejects(bridge.compactSession(busySession.sessionId), /COMPACTION_BUSY/u)
    if (started.value?.runId) await bridge.abort(started.value.runId)
    while (!(await busyIterator.next()).done) {
      // Drain the aborted fixture run.
    }

    for (let index = 0; index < 3; index += 1) {
      for await (const _event of bridge.prompt({
        sessionId: session.sessionId,
        text: `command compaction turn ${index}`,
        clientRequestId: `command-compaction-turn-${index}`,
      })) {
        // Drain each complete turn so manual compaction has a stable historical range.
      }
    }
    const focusMarker = 'private-focus-marker'
    const focused = await bridge.invokeCommand({
      schemaVersion: 1,
      workspace,
      catalogSnapshotDigest: catalog.snapshotDigest,
      capabilityDigest: catalog.capabilityDigest,
      invocation: await route(`/compact ${focusMarker}`, 'command-compact-focused'),
      sessionId: session.sessionId,
    })
    assert.equal(focused.effect, 'mutation')
    assert.equal(focused.audited, true)
    assert.equal(focused.output.kind, 'ui_action')
    if (focused.output.kind !== 'ui_action') throw new Error('compact output missing')
    const message = String(focused.output.payload?.message)
    assert.match(message, /Checkpoint:/u)
    assert.match(message, /Range: \[/u)
    assert.match(message, /Tokens: summary/u)
    assert.match(message, /Generator:/u)
    assert.match(message, /Fallback from:/u)
    assert.match(message, /Original history: retained/u)

    const contextAfter = await bridge.invokeCommand({
      schemaVersion: 1,
      workspace,
      catalogSnapshotDigest: catalog.snapshotDigest,
      capabilityDigest: catalog.capabilityDigest,
      invocation: await route('/context', 'command-context-after'),
      sessionId: session.sessionId,
    })
    assert.equal(contextAfter.output.kind, 'ui_action')
    if (contextAfter.output.kind !== 'ui_action') throw new Error('context output missing')
    const report = contextAfter.output.payload?.report as
      | {
          history?: { messageCount?: number; originalHistoryDeleted?: boolean }
          checkpoint?: {
            id?: string
            range?: { messageStart?: number; messageEnd?: number }
            tokens?: { estimatedSummaryTokens?: number; estimatedGainTokens?: number }
            generator?: { kind?: string; id?: string }
            fallbackFrom?: unknown
          }
        }
      | undefined
    assert.equal(report?.history?.messageCount, 6)
    assert.equal(report?.history?.originalHistoryDeleted, false)
    assert.match(report?.checkpoint?.id ?? '', /^cp-/u)
    assert.equal(typeof report?.checkpoint?.range?.messageEnd, 'number')
    assert.equal(typeof report?.checkpoint?.tokens?.estimatedSummaryTokens, 'number')
    assert.equal(report?.checkpoint?.generator?.kind, 'deterministic')
    assert.equal(report?.checkpoint?.fallbackFrom, null)

    const audit = await readFile(join(storage, 'audit', 'commands.jsonl'), 'utf8')
    assert.match(audit, /"event":"command.invoked"/u)
    assert.match(audit, /"persistence":"redacted"/u)
    assert.doesNotMatch(audit, new RegExp(focusMarker, 'u'))
    assert.doesNotMatch(
      JSON.stringify(await bridge.exportSession(session.sessionId)),
      /private-focus/u,
    )
  } finally {
    await bridge.dispose()
    await rm(storage, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('shipping prompt and Skill commands pin resources through one audited prompt handoff', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-prompt-command-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-prompt-command-workspace-'))
  const skillDirectory = join(workspace, '.praxis', 'skills', 'review')
  const promptDirectory = join(workspace, '.praxis', 'prompts')
  const templatePath = join(promptDirectory, 'review.prompt.md')
  const bridge = await startLocalRuntime(runtimeEntry, { ...process.env, PRAXIS_HOME: storage })
  try {
    await mkdir(skillDirectory, { recursive: true })
    await mkdir(promptDirectory, { recursive: true })
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      '---\nname: review\ndescription: Review exact evidence.\n---\nUse the pinned Skill review checklist.\n',
      'utf8',
    )
    await writeFile(
      templatePath,
      [
        '---',
        'name: review',
        'description: Review a target through a data-only prompt.',
        'arguments: target, focus?',
        'persistence: plaintext',
        '---',
        'Review {{target}} and prioritize {{focus}}.',
        '{{body}}',
      ].join('\n'),
      'utf8',
    )
    const resources = await bridge.listResources(workspace)
    assert.ok(resources.some(({ id }) => id === 'project/review'))
    assert.ok(resources.some(({ id }) => id === 'project/template/review'))
    await bridge.enableResource(workspace, 'project/review', true)
    await bridge.enableResource(workspace, 'project/template/review', true)

    const session = await bridge.createSession({ cwd: workspace, provider: 'mock' })
    const catalog = await bridge.listCommands(workspace)
    assert.ok(catalog.entries.some(({ descriptor }) => descriptor.command === 'prompt:review'))
    assert.ok(catalog.entries.some(({ descriptor }) => descriptor.command === 'skill:review'))
    const template = await executeSlashCommand(
      '/prompt:review src cancellation\nInspect exact tests.',
      { bridge, session, cwd: workspace, runtimeCatalog: catalog },
    )
    assert.equal(template.handled, false, JSON.stringify(template))
    assert.equal(template.prompt, 'Inspect exact tests.')
    assert.match(template.commandInvocationId ?? '', /^command:/u)

    await assert.rejects(async () => {
      for await (const _event of bridge.prompt({
        sessionId: session.sessionId,
        text: 'tampered client text',
        commandInvocationId: template.commandInvocationId,
        clientRequestId: 'template-tampered-handoff',
      })) {
      }
    }, /COMMAND_PROMPT_HANDOFF_MISMATCH/u)
    for await (const _event of bridge.prompt({
      sessionId: session.sessionId,
      text: template.prompt!,
      commandInvocationId: template.commandInvocationId,
      clientRequestId: 'template-valid-handoff',
    })) {
    }
    await assert.rejects(async () => {
      for await (const _event of bridge.followUp({
        sessionId: session.sessionId,
        text: template.prompt!,
        commandInvocationId: template.commandInvocationId,
        clientRequestId: 'template-replayed-handoff',
      })) {
      }
    }, /COMMAND_PROMPT_HANDOFF_EXPIRED/u)

    const skillArgument = 'private-slash-skill-argument'
    const skill = await executeSlashCommand(`/skill:review ${skillArgument}\nReview the diff.`, {
      bridge,
      session,
      cwd: workspace,
      runtimeCatalog: catalog,
    })
    assert.equal(skill.handled, false)
    for await (const _event of bridge.followUp({
      sessionId: session.sessionId,
      text: skill.prompt!,
      commandInvocationId: skill.commandInvocationId,
      clientRequestId: 'skill-slash-handoff',
    })) {
    }
    const noBodySkillArgument = 'private-no-body-skill-argument'
    const noBodySkill = await executeSlashCommand(`/skill:review ${noBodySkillArgument}`, {
      bridge,
      session,
      cwd: workspace,
      runtimeCatalog: catalog,
    })
    assert.equal(noBodySkill.handled, false)
    assert.equal(noBodySkill.prompt, '[Invoke Skill project/review.]')
    for await (const _event of bridge.followUp({
      sessionId: session.sessionId,
      text: noBodySkill.prompt!,
      commandInvocationId: noBodySkill.commandInvocationId,
      clientRequestId: 'skill-no-body-handoff',
    })) {
    }
    for await (const _event of bridge.followUp({
      sessionId: session.sessionId,
      text: '$review private-legacy-skill-argument\nReview legacy syntax.',
      clientRequestId: 'skill-legacy-syntax',
    })) {
    }

    const pinnedTemplate = await executeSlashCommand(
      '/prompt:review pinned stability\nUse the pinned version.',
      { bridge, session, cwd: workspace, runtimeCatalog: catalog },
    )
    assert.equal(pinnedTemplate.handled, false, JSON.stringify(pinnedTemplate))
    await writeFile(
      templatePath,
      '---\nname: review\ndescription: Drifted prompt.\narguments: target\n---\nChanged {{target}}.\n',
      'utf8',
    )
    for await (const _event of bridge.followUp({
      sessionId: session.sessionId,
      text: pinnedTemplate.prompt!,
      commandInvocationId: pinnedTemplate.commandInvocationId,
      clientRequestId: 'template-pinned-after-drift',
    })) {
    }

    const exported = await bridge.exportSession(session.sessionId)
    const source = JSON.stringify(exported)
    assert.match(source, /prompt_resource/u)
    assert.match(source, /prompt_command_provenance/u)
    assert.match(source, /command:command:/u)
    assert.match(source, /Review src and prioritize cancellation/u)
    assert.match(source, /Review pinned and prioritize stability/u)
    assert.doesNotMatch(source, /Changed pinned/u)
    assert.match(source, /#sha256:/u)
    assert.doesNotMatch(source, /private-slash-skill-argument/u)
    assert.doesNotMatch(source, /private-no-body-skill-argument/u)
    assert.doesNotMatch(source, /private-legacy-skill-argument/u)
    const invocations = exported.messages.filter(
      (message) => typeof message === 'object' && message !== null && 'skillInvocation' in message,
    ) as Array<{ skillInvocation?: { capabilityId?: string; origin?: string; digest?: string } }>
    assert.equal(invocations.length, 3)
    assert.ok(
      invocations.every(
        ({ skillInvocation }) => skillInvocation?.capabilityId === 'project/review',
      ),
    )
    assert.equal(new Set(invocations.map(({ skillInvocation }) => skillInvocation?.digest)).size, 1)

    const stale = await executeSlashCommand('/prompt:review src', {
      bridge,
      session,
      cwd: workspace,
      runtimeCatalog: catalog,
    })
    assert.equal(stale.handled, true)
    assert.equal(stale.message, 'COMMAND_CATALOG_STALE')
    assert.equal(
      (await bridge.listCommands(workspace)).entries.some(
        ({ descriptor }) => descriptor.command === 'prompt:review',
      ),
      false,
    )
    const audit = await readFile(join(storage, 'audit', 'commands.jsonl'), 'utf8')
    assert.match(audit, /"event":"command\.invoked"/u)
    assert.doesNotMatch(audit, /private-slash-skill-argument/u)
  } finally {
    await bridge.dispose()
    await rm(storage, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('shipping Runtime activates, snapshots, persists, compacts, resumes, branches, and disables Skills', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-skill-runtime-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-skill-runtime-workspace-'))
  const skillDirectory = join(workspace, '.praxis', 'skills', 'review')
  const skillContent =
    '---\nname: review\ndescription: Review exact Runtime evidence.\n---\nUse exact persisted guidance.\n'
  const env = { ...process.env, PRAXIS_HOME: storage }
  let sessionId = ''
  try {
    await mkdir(skillDirectory, { recursive: true })
    await writeFile(join(skillDirectory, 'SKILL.md'), skillContent, 'utf8')
    const runtime = await startLocalRuntime(runtimeEntry, env)
    try {
      const resources = await runtime.listResources(workspace)
      assert.equal(resources[0]?.id, 'project/review')
      assert.equal(resources[0]?.enabled, false)
      await assert.rejects(
        runtime.enableResource(workspace, 'project/review'),
        /RESOURCE_TRUST_REQUIRED/,
      )
      assert.equal((await runtime.enableResource(workspace, 'project/review', true)).enabled, true)

      const session = await runtime.createSession({ cwd: workspace, provider: 'mock' })
      sessionId = session.sessionId
      for await (const _event of runtime.prompt({
        sessionId,
        text: '$review focus-on-cancellation\nReview this request.',
        clientRequestId: 'skill-explicit-1',
      })) {
      }
      for (let index = 0; index < 4; index += 1) {
        for await (const _event of runtime.prompt({
          sessionId,
          text: `follow-up-${index}`,
          clientRequestId: `skill-follow-up-${index}`,
        })) {
        }
      }

      const exported = await runtime.exportSession(sessionId)
      const invocation = exported.messages.find(
        (message) =>
          typeof message === 'object' && message !== null && 'skillInvocation' in message,
      ) as { skillInvocation?: { content?: string; arguments?: string } } | undefined
      assert.equal(invocation?.skillInvocation?.content, skillContent)
      assert.equal(
        invocation?.skillInvocation?.arguments,
        `[digest-only:${promptDigest('focus-on-cancellation')}]`,
      )
      assert.equal(JSON.stringify(exported).includes('focus-on-cancellation'), false)

      assert.equal((await runtime.compactSession(sessionId)).compacted, true)
      const compacted = await runtime.exportSession(sessionId)
      assert.equal(
        (
          compacted.memory as {
            checkpoint?: { skillInvocations?: Array<{ content?: string }> }
          }
        ).checkpoint?.skillInvocations?.[0]?.content,
        skillContent,
      )

      const branch = await runtime.forkSession(sessionId, 'Skill branch')
      const branchExport = await runtime.exportSession(branch.sessionId)
      assert.equal(
        (
          branchExport.messages.find(
            (message) =>
              typeof message === 'object' && message !== null && 'skillInvocation' in message,
          ) as { skillInvocation?: { content?: string } } | undefined
        )?.skillInvocation?.content,
        skillContent,
      )

      await runtime.disableResource(workspace, 'project/review')
      await assert.rejects(async () => {
        for await (const _event of runtime.prompt({
          sessionId,
          text: '$review\nThis must stay disabled.',
          clientRequestId: 'skill-disabled',
        })) {
        }
      }, /SKILL_NOT_FOUND/)

      const duplicateDirectory = join(workspace, '.claude', 'skills', 'review')
      await mkdir(duplicateDirectory, { recursive: true })
      await writeFile(
        join(duplicateDirectory, 'SKILL.md'),
        '---\nname: review\ndescription: Conflicting project Skill.\n---\nConflict.\n',
        'utf8',
      )
      assert.equal(
        (await runtime.listResources(workspace)).filter(
          (resource) => resource.id === 'project/review' && resource.collision,
        ).length,
        2,
      )
      await assert.rejects(
        runtime.enableResource(workspace, 'project/review', true),
        /RESOURCE_ID_COLLISION/,
      )
    } finally {
      await runtime.dispose()
    }

    const restarted = await startLocalRuntime(runtimeEntry, env)
    try {
      await restarted.resumeSession(sessionId)
      const resumed = await restarted.exportSession(sessionId)
      assert.equal(
        (
          resumed.memory as {
            checkpoint?: { skillInvocations?: Array<{ content?: string }> }
          }
        ).checkpoint?.skillInvocations?.[0]?.content,
        skillContent,
      )
    } finally {
      await restarted.dispose()
    }
  } finally {
    await rm(storage, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('daily-driver session APIs complete, resume, inspect, fork, export, and trash a session', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-p2-session-'))
  const env = { ...process.env, PRAXIS_HOME: storage }
  let parentId = ''
  try {
    const first = await startLocalRuntime(runtimeEntry, env)
    try {
      const parent = await first.createSession({
        cwd: process.cwd(),
        provider: 'mock',
        name: 'Daily driver',
        contextLimitTokens: 4096,
      })
      parentId = parent.sessionId
      for await (const _event of first.prompt({
        sessionId: parent.sessionId,
        text: 'persist this session',
        clientRequestId: 'p2-session-run',
        budget: { maxTurns: 2, maxToolCalls: 0, maxTokens: 2048 },
        timeoutMs: 10_000,
      })) {
      }

      assert.equal(
        (await first.renameSession(parent.sessionId, 'Renamed session')).name,
        'Renamed session',
      )
      assert.equal((await first.searchSessions('renamed'))[0]?.sessionId, parent.sessionId)
      assert.equal((await first.exportSession(parent.sessionId)).messages.length, 2)
      const latestTranscript = await first.transcriptSession(parent.sessionId, undefined, 1)
      assert.equal(latestTranscript.sessionId, parent.sessionId)
      assert.equal(latestTranscript.start, 1)
      assert.equal(latestTranscript.end, 2)
      assert.equal(latestTranscript.totalMessages, 2)
      assert.equal(latestTranscript.hasMore, true)
      assert.equal(latestTranscript.messages.length, 1)
      assert.equal(
        (latestTranscript.messages[0] as { role?: unknown } | undefined)?.role,
        'assistant',
      )
      assert.equal((await first.listModels('mock'))[0]?.id, 'mock-v1')
      const kimiModels = await first.listModels('kimi')
      assert.equal(kimiModels.length, 10)
      assert.equal(kimiModels.find(({ id }) => id === 'kimi-k3')?.name, 'Kimi K3')
      assert.deepEqual(kimiModels.find(({ id }) => id === 'kimi-k3')?.modalities, ['text'])
      const qwenModels = await first.listModels('qwen-token-plan-cn')
      assert.equal(qwenModels.length, 5)
      assert.deepEqual(qwenModels.find(({ id }) => id === 'qwen3.7-plus')?.modalities, ['text'])
      assert.equal((await first.listModels('minimax')).length, 3)
      const diagnosis = await first.doctor(process.cwd())
      assert.equal(diagnosis.storeVersion, 3)
      assert.match(
        diagnosis.checks.find(({ id }) => id === 'session_store')?.message ?? '',
        /SessionJournal V3 JSONL authority is ready/,
      )
      const deepDiagnosis = await first.doctor(process.cwd(), true)
      assert.match(
        deepDiagnosis.checks.find(({ id }) => id === 'session_store_deep')?.message ?? '',
        /JSONL deep scrub verified/u,
      )
      assert.deepEqual(await first.listArtifacts(), [])
      assert.equal(typeof (await first.sessionPlan(parent.sessionId)), 'object')

      const child = await first.forkSession(parent.sessionId, 'Alternative', 1)
      assert.equal(child.parentSessionId, parent.sessionId)
      assert.equal((await first.branchSession(parent.sessionId)).sessionId, child.sessionId)
      assert.match((await first.deleteSession(child.sessionId)).trashPath, /trash/)
      const configured = await first.configureSession(
        parent.sessionId,
        'openai-compatible',
        'local-model',
      )
      assert.equal(configured.sessionId, parent.sessionId)
      assert.equal(configured.model, 'local-model')
      const inspected = await first.inspectSession(parent.sessionId)
      assert.equal(inspected.sessionId, parent.sessionId)
      assert.equal(typeof inspected.createdAt, 'string')
      assert.equal(typeof inspected.updatedAt, 'string')
    } finally {
      await first.dispose()
    }

    const restarted = await startLocalRuntime(runtimeEntry, env)
    try {
      const resumed = await restarted.resumeSession(parentId)
      assert.equal(resumed.name, 'Renamed session')
      assert.equal(resumed.lastTerminalState, 'completed')
      assert.equal(resumed.messageCount, 2)
      assert.equal(resumed.provider, 'openai-compatible')
      assert.equal(resumed.model, 'local-model')
    } finally {
      await restarted.dispose()
    }
  } finally {
    await rm(storage, { recursive: true, force: true })
  }
})

test('new sessions restore the last authenticated provider and model after restart', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-model-preference-'))
  const env = { ...process.env, PRAXIS_HOME: storage }
  try {
    const first = await startLocalRuntime(runtimeEntry, env)
    try {
      await first.login('kimi', 'test-kimi-api-key')
      const session = await first.createSession({ cwd: process.cwd() })
      const selected = await first.configureSession(session.sessionId, 'kimi', 'kimi-k3')
      assert.equal(selected.provider, 'kimi')
      assert.equal(selected.model, 'kimi-k3')
      assert.deepEqual((await first.getSettings()).defaultModel?.provider, 'kimi')
      assert.equal((await first.getSettings()).defaultModel?.model, 'kimi-k3')
    } finally {
      await first.dispose()
    }

    const restarted = await startLocalRuntime(runtimeEntry, env)
    try {
      const restored = await restarted.createSession({ cwd: process.cwd() })
      assert.equal(restored.provider, 'kimi')
      assert.equal(restored.model, 'kimi-k3')
      assert.doesNotMatch(
        await readFile(join(storage, 'settings.json'), 'utf8'),
        /test-kimi-api-key/,
      )
    } finally {
      await restarted.dispose()
    }
  } finally {
    await rm(storage, { recursive: true, force: true })
  }
})

test('Runtime protocol owns the complete workspace plugin lifecycle', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-p3-plugin-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-p3-workspace-'))
  const bridge = await startLocalRuntime(runtimeEntry, {
    ...process.env,
    PRAXIS_HOME: storage,
  })
  try {
    const installed = await bridge.installPlugin(exampleToolPlugin)
    assert.equal(installed.enabled, false)
    assert.equal(installed.provenance, 'unsigned')
    assert.equal(
      (await bridge.inspectPlugin(installed.id, installed.version)).digest,
      installed.digest,
    )
    const enabled = await bridge.enablePlugin(workspace, installed.id, installed.version, [])
    assert.equal(enabled.enabled, true)
    assert.deepEqual(await bridge.pluginPermissions(workspace, installed.id), {
      requested: [],
      approved: [],
    })
    assert.equal((await bridge.pluginDoctor())[0]?.ok, true)
    const session = await bridge.createSession({ cwd: workspace, provider: 'mock' })
    const catalog = await bridge.listCommands(workspace)
    const mapped = catalog.entries.find(
      ({ descriptor }) => descriptor.command === 'plugin:example.echo-tool/echo',
    )
    assert.equal(mapped?.descriptor.kind, 'workflow')
    assert.equal(mapped?.descriptor.aliases.length, 0)
    const routed = await new InputRouterV1().route('/plugin:example.echo-tool/echo hello', {
      clientRequestId: 'plugin-command-mapping',
      promptId: 'prompt:plugin-command-mapping',
      catalogs: [catalog],
      capabilityDigest: catalog.capabilityDigest,
      workspaceTrusted: catalog.workspaceTrusted,
      session: 'present',
      run: 'idle',
    })
    assert.equal(routed.kind, 'bounded_job')
    if (routed.kind !== 'bounded_job') throw new Error('mapped command did not route')
    const result = await bridge.invokeCommand({
      schemaVersion: 1,
      workspace,
      catalogSnapshotDigest: catalog.snapshotDigest,
      capabilityDigest: catalog.capabilityDigest,
      invocation: routed.invocation,
      sessionId: session.sessionId,
    })
    assert.equal(result.output.kind, 'bounded_job')
    if (result.output.kind !== 'bounded_job') throw new Error('mapped command result missing')
    const artifact = JSON.parse(
      await readFile(join(storage, 'artifacts', `${result.output.jobId}.json`), 'utf8'),
    ) as { value: { result: { ok: boolean; output: unknown } } }
    assert.equal(artifact.value.result.ok, true)
    assert.deepEqual(artifact.value.result.output, { value: 'hello' })
    const policyAudit = await readFile(join(storage, 'policy-audit.jsonl'), 'utf8')
    assert.match(policyAudit, /external-command:plugin/u)
    assert.doesNotMatch(policyAudit, /hello/u)
    await bridge.disablePlugin(workspace, installed.id)
    assert.equal(
      (await bridge.listCommands(workspace)).entries.some(
        ({ descriptor }) => descriptor.command === 'plugin:example.echo-tool/echo',
      ),
      false,
    )
    await bridge.uninstallPlugin(installed.id, installed.version)
    assert.deepEqual(await bridge.listPlugins(workspace), [])
  } finally {
    await bridge.dispose()
    await rm(storage, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('shipping Runtime activates and atomically disables an enabled MCP Tool', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-mcp-runtime-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-mcp-runtime-workspace-'))
  const bridge = await startLocalRuntime(runtimeEntry, {
    ...process.env,
    PRAXIS_HOME: storage,
  })
  try {
    const installed = await bridge.installPlugin(exampleMcpPlugin)
    const enabled = await bridge.enablePlugin(workspace, installed.id, installed.version, [])
    assert.equal(enabled.health, 'healthy')

    const session = await bridge.createSession({ cwd: workspace, provider: 'mock' })
    const toolName = mcpRuntimeToolName(installed.id, 'example.mcp', 'echo')
    assert.equal(
      (await bridge.listCommands(workspace)).entries.some(({ descriptor }) =>
        descriptor.command.startsWith(`mcp:${installed.id}/`),
      ),
      false,
    )
    const firstEvents = []
    for await (const event of bridge.prompt({
      sessionId: session.sessionId,
      text: `tool:${toolName} {"value":"hello"}`,
      clientRequestId: 'mcp-runtime-first-call',
    })) {
      firstEvents.push(event)
      if (event.type === 'permission_request') {
        assert.equal(event.risk, 'high')
        assert.equal(event.target, await realpath(workspace))
        await bridge.decidePermission(event.requestId, { type: 'allow_once' })
      }
    }
    assert.ok(firstEvents.some((event) => event.type === 'permission_request'))
    assert.ok(firstEvents.some((event) => event.type === 'tool_start' && event.name === toolName))
    assert.ok(
      firstEvents.some(
        (event) =>
          event.type === 'tool_end' &&
          event.ok &&
          JSON.stringify(event.output) === JSON.stringify({ value: 'hello' }),
      ),
    )

    await bridge.disablePlugin(workspace, installed.id)
    assert.equal(
      (await bridge.listPlugins(workspace)).find((plugin) => plugin.id === installed.id)?.health,
      'stopped',
    )
    const disabledEvents = []
    for await (const event of bridge.prompt({
      sessionId: session.sessionId,
      text: `tool:${toolName} {"value":"late"}`,
      clientRequestId: 'mcp-runtime-disabled-call',
    })) {
      disabledEvents.push(event)
    }
    assert.ok(
      disabledEvents.some(
        (event) => event.type === 'tool_end' && !event.ok && event.error?.code === 'TOOL_NOT_FOUND',
      ),
    )
  } finally {
    await bridge.dispose()
    await rm(storage, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

test('shipping Runtime resolves process Tools and Providers through one run snapshot', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-process-runtime-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-process-runtime-workspace-'))
  const source = await mkdtemp(join(tmpdir(), 'praxis-process-runtime-source-'))
  const bridge = await startLocalRuntime(runtimeEntry, {
    ...process.env,
    PRAXIS_HOME: storage,
  })
  try {
    await writeFile(
      join(source, 'praxis-plugin.json'),
      `${JSON.stringify({
        manifestVersion: 1,
        id: 'example.process-runtime',
        name: 'Process Runtime Fixture',
        version: '1.0.0',
        apiVersion: 1,
        entry: 'server.mjs',
        isolation: 'process',
        capabilities: [
          { id: 'echo', kind: 'tool' },
          { id: 'chat', kind: 'provider' },
        ],
        grants: [],
      })}\n`,
      'utf8',
    )
    await writeFile(
      join(source, 'server.mjs'),
      await readFile(processRuntimePluginFixture, 'utf8'),
      'utf8',
    )
    const installed = await bridge.installPlugin(source)
    const enabled = await bridge.enablePlugin(workspace, installed.id, installed.version, [])
    assert.equal(enabled.health, 'healthy')

    const toolSession = await bridge.createSession({ cwd: workspace, provider: 'mock' })
    const toolName = processRuntimeToolName(installed.id, 'echo')
    const toolEvents = []
    for await (const event of bridge.prompt({
      sessionId: toolSession.sessionId,
      text: `tool:${toolName} {"value":"hello"}`,
      clientRequestId: 'process-runtime-tool',
    })) {
      toolEvents.push(event)
      if (event.type === 'permission_request') {
        assert.equal(event.risk, 'high')
        await bridge.decidePermission(event.requestId, { type: 'allow_once' })
      }
    }
    assert.ok(toolEvents.some((event) => event.type === 'permission_request'))
    assert.ok(
      toolEvents.some(
        (event) =>
          event.type === 'tool_end' &&
          event.ok &&
          JSON.stringify(event.output) === JSON.stringify({ value: 'hello' }),
      ),
    )

    const providerSession = await bridge.createSession({
      cwd: workspace,
      provider: 'example.process-runtime/chat',
      model: 'fixture-v1',
    })
    const providerEvents = []
    for await (const event of bridge.prompt({
      sessionId: providerSession.sessionId,
      text: 'stream through the process provider',
      clientRequestId: 'process-runtime-provider',
    })) {
      providerEvents.push(event)
    }
    assert.equal(textFrom(providerEvents), 'process provider')
    assert.ok(providerEvents.some((event) => event.type === 'prompt_completed'))

    await bridge.disablePlugin(workspace, installed.id)
    assert.equal(
      (await bridge.listPlugins(workspace)).find((plugin) => plugin.id === installed.id)?.health,
      'stopped',
    )
    const disabledEvents = []
    for await (const event of bridge.prompt({
      sessionId: toolSession.sessionId,
      text: `tool:${toolName} {"value":"late"}`,
      clientRequestId: 'process-runtime-disabled',
    })) {
      disabledEvents.push(event)
    }
    assert.ok(
      disabledEvents.some(
        (event) => event.type === 'tool_end' && !event.ok && event.error?.code === 'TOOL_NOT_FOUND',
      ),
    )
  } finally {
    await bridge.dispose()
    await rm(storage, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
  }
})

test('shipping Runtime preserves the selected MCP digest across update, rollback, restart, and resume', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-mcp-lifecycle-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-mcp-lifecycle-workspace-'))
  const firstSource = await mkdtemp(join(tmpdir(), 'praxis-mcp-lifecycle-v1-'))
  const secondSource = await mkdtemp(join(tmpdir(), 'praxis-mcp-lifecycle-v2-'))
  const env = { ...process.env, PRAXIS_HOME: storage }
  let sessionId = ''
  try {
    await mcpPluginFixture(firstSource, '1.0.0', 'one')
    await mcpPluginFixture(secondSource, '2.0.0', 'two')
    const first = await startLocalRuntime(runtimeEntry, env)
    try {
      const installed = await first.installPlugin(firstSource)
      assert.equal(
        (await first.enablePlugin(workspace, installed.id, installed.version, [])).health,
        'healthy',
      )
      const session = await first.createSession({ cwd: workspace, provider: 'mock' })
      sessionId = session.sessionId
      const toolName = mcpRuntimeToolName(installed.id, 'workspace', 'versioned_echo')
      assert.deepEqual(
        await invokeMcpTool(first, sessionId, toolName, 'before-restart', 'mcp-lifecycle-v1'),
        { value: 'before-restart', version: 'one' },
      )
    } finally {
      await first.dispose()
    }

    const restarted = await startLocalRuntime(runtimeEntry, env)
    try {
      await restarted.resumeSession(sessionId)
      const toolName = mcpRuntimeToolName('example.lifecycle-mcp', 'workspace', 'versioned_echo')
      assert.deepEqual(
        await invokeMcpTool(
          restarted,
          sessionId,
          toolName,
          'after-restart',
          'mcp-lifecycle-restart',
        ),
        { value: 'after-restart', version: 'one' },
      )
      assert.equal((await restarted.updatePlugin(workspace, secondSource, [])).health, 'healthy')
      assert.deepEqual(
        await invokeMcpTool(restarted, sessionId, toolName, 'after-update', 'mcp-lifecycle-v2'),
        { value: 'after-update', version: 'two' },
      )
      assert.equal(
        (await restarted.rollbackPlugin(workspace, 'example.lifecycle-mcp')).version,
        '1.0.0',
      )
      assert.deepEqual(
        await invokeMcpTool(
          restarted,
          sessionId,
          toolName,
          'after-rollback',
          'mcp-lifecycle-rollback',
        ),
        { value: 'after-rollback', version: 'one' },
      )
    } finally {
      await restarted.dispose()
    }
  } finally {
    await rm(storage, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(firstSource, { recursive: true, force: true })
    await rm(secondSource, { recursive: true, force: true })
  }
})

test('shipping Runtime disables an MCP server during a call and keeps built-ins available', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-mcp-disable-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-mcp-disable-workspace-'))
  const source = await mkdtemp(join(tmpdir(), 'praxis-mcp-disable-source-'))
  const bridge = await startLocalRuntime(runtimeEntry, {
    ...process.env,
    PRAXIS_HOME: storage,
  })
  try {
    await mcpPluginFixture(source, '1.0.0', 'slow', { slow: true })
    await writeFile(join(workspace, 'builtin.txt'), 'built-in remains available\n', 'utf8')
    const installed = await bridge.installPlugin(source)
    await bridge.enablePlugin(workspace, installed.id, installed.version, [])
    const session = await bridge.createSession({ cwd: workspace, provider: 'mock' })
    const toolName = mcpRuntimeToolName(installed.id, 'workspace', 'versioned_echo')
    const cancelled = []
    for await (const event of bridge.prompt({
      sessionId: session.sessionId,
      text: `tool:${toolName} {"value":"cancel-me"}`,
      clientRequestId: 'mcp-disable-active',
    })) {
      cancelled.push(event)
      if (event.type === 'permission_request') {
        await bridge.decidePermission(event.requestId, { type: 'allow_once' })
      }
      if (event.type === 'tool_start') await bridge.disablePlugin(workspace, installed.id)
    }
    assert.ok(cancelled.some((event) => event.type === 'tool_end' && !event.ok))
    assert.equal(
      (await bridge.listPlugins(workspace)).find((plugin) => plugin.id === installed.id)?.health,
      'stopped',
    )

    const builtIn = []
    for await (const event of bridge.prompt({
      sessionId: session.sessionId,
      text: 'tool:read {"path":"builtin.txt"}',
      clientRequestId: 'mcp-disable-builtin',
    })) {
      builtIn.push(event)
    }
    assert.ok(builtIn.some((event) => event.type === 'tool_end' && event.ok))
    assert.match(textFrom(builtIn), /built-in remains available/)
  } finally {
    await bridge.dispose()
    await rm(storage, { recursive: true, force: true })
    await rm(workspace, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
  }
})

test('local Runtime completes initialize, subscription, session creation, and prompt', async () => {
  const bridge = await startLocalRuntime(runtimeEntry)
  try {
    const session = await bridge.createSession({ cwd: process.cwd() })
    const events = []
    for await (const event of bridge.prompt({
      sessionId: session.sessionId,
      text: 'describe the runtime boundary',
      clientRequestId: 'integration-prompt-1',
    })) {
      events.push(event)
    }

    assert.equal(events[0]?.type, 'prompt_started')
    assert.ok(events.some((event) => event.type === 'text_delta'))
    assert.equal(events.at(-1)?.type, 'prompt_completed')
  } finally {
    await bridge.dispose()
  }
})

test('Runtime persists one correlated private trace without changing protocol SessionEvent', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-trace-integration-'))
  const bridge = await startLocalRuntime(runtimeEntry, { ...process.env, PRAXIS_HOME: storage })
  const events = []
  let sessionId = ''
  try {
    const session = await bridge.createSession({ cwd: process.cwd(), provider: 'mock' })
    sessionId = session.sessionId
    for await (const event of bridge.prompt({
      sessionId,
      text: 'private protocol prompt content',
      clientRequestId: 'trace-integration-1',
    })) {
      events.push(event)
    }
  } finally {
    await bridge.dispose()
  }

  try {
    const records = await loadTraceRecords(storage)
    assert.ok(records.length > 0)
    const runId = events.find((event) => event.type === 'prompt_started')?.runId
    const traceId = records[0]?.context.traceId
    const runtimeId = records[0]?.context.runtimeId
    assert.ok(runId)
    assert.ok(traceId)
    assert.ok(runtimeId)
    assert.ok(
      records.every(
        (record) =>
          record.context.traceId === traceId &&
          record.context.runtimeId === runtimeId &&
          record.context.sessionId === sessionId &&
          record.context.runId === runId,
      ),
    )
    assert.equal(
      records.filter((record) =>
        ['run.completed', 'run.failed', 'run.aborted'].includes(record.kind),
      ).length,
      1,
    )
    assert.equal(JSON.stringify(records).includes('private protocol prompt content'), false)
    const protocol = JSON.stringify(events)
    for (const traceField of ['traceId', 'runtimeId', 'turnId', 'pluginCallId']) {
      assert.equal(protocol.includes(`"${traceField}"`), false)
    }
  } finally {
    await rm(storage, { recursive: true, force: true })
  }
})

test('Runtime exports a persisted trace through the protocol bridge', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-trace-export-home-'))
  const destination = await mkdtemp(join(tmpdir(), 'praxis-trace-export-output-'))
  const bridge = await startLocalRuntime(runtimeEntry, { ...process.env, PRAXIS_HOME: storage })
  try {
    const session = await bridge.createSession({ cwd: process.cwd(), provider: 'mock' })
    for await (const _event of bridge.prompt({
      sessionId: session.sessionId,
      text: 'create a trace for protocol export',
      clientRequestId: 'trace-export-integration-1',
    })) {
      // Drain the run so every trace record is available for export.
    }
    const traceId = (await loadTraceRecords(storage))[0]?.context.traceId
    assert.ok(traceId)

    const exported = await bridge.exportTrace(traceId, destination)

    assert.equal(exported.traceId, traceId)
    assert.equal(exported.path, await realpath(join(destination, `${traceId}.json`)))
    assert.ok(exported.recordCount > 0)
    assert.deepEqual(exported.privacy.excluded, [
      'prompts',
      'credentials',
      'environment',
      'rawToolInput',
      'rawToolOutput',
    ])
    const document = JSON.parse(await readFile(exported.path, 'utf8')) as {
      traceId: string
      recordCount: number
    }
    assert.equal(document.traceId, traceId)
    assert.equal(document.recordCount, exported.recordCount)
  } finally {
    await bridge.dispose()
    await rm(storage, { recursive: true, force: true })
    await rm(destination, { recursive: true, force: true })
  }
})

test('Runtime rejects trace export params outside the published schema', async () => {
  const bridge = await startLocalRuntime(runtimeEntry)
  const request = (
    bridge as unknown as {
      request(method: string, params: unknown): Promise<unknown>
    }
  ).request.bind(bridge)
  try {
    for (const params of [
      { traceId: 'trace-1', destination: process.cwd(), extra: true },
      { traceId: '', destination: process.cwd() },
      { traceId: '../escape', destination: process.cwd() },
      { traceId: 'trace-1', destination: '' },
    ]) {
      await assert.rejects(
        request('trace.export', params),
        (error: unknown) =>
          error instanceof Error &&
          error.message.startsWith('INVALID_REQUEST:') &&
          !error.message.includes('INTERNAL_ERROR'),
      )
    }
  } finally {
    await bridge.dispose()
  }
})

test('abort produces one prompt_aborted terminal event', async () => {
  const bridge = await startLocalRuntime(runtimeEntry)
  try {
    const session = await bridge.createSession({ cwd: process.cwd() })
    const events = []
    let aborted = false
    for await (const event of bridge.prompt({
      sessionId: session.sessionId,
      text: 'a request that will be cancelled',
      clientRequestId: 'integration-abort-1',
    })) {
      events.push(event)
      if (event.type === 'prompt_started' && !aborted) {
        aborted = true
        await bridge.abort(event.runId)
      }
    }

    assert.equal(events.at(-1)?.type, 'prompt_aborted')
    assert.equal(events.filter((event) => isTerminal(event)).length, 1)
  } finally {
    await bridge.dispose()
  }
})

test('follow_up starts a distinct run with follow_up intent', async () => {
  const bridge = await startLocalRuntime(runtimeEntry)
  try {
    const session = await bridge.createSession({ cwd: process.cwd() })
    for await (const _event of bridge.prompt({
      sessionId: session.sessionId,
      text: 'first turn',
    })) {
      // Drain the initial run before following up.
    }

    const events = []
    for await (const event of bridge.followUp({
      sessionId: session.sessionId,
      text: 'second turn',
    })) {
      events.push(event)
    }

    assert.equal(events[0]?.type, 'prompt_started')
    assert.equal(events[0]?.promptKind, 'follow_up')
    assert.equal(events.at(-1)?.type, 'prompt_completed')
  } finally {
    await bridge.dispose()
  }
})

test('steer is queued and applied to the active run', async () => {
  const bridge = await startLocalRuntime(runtimeEntry)
  try {
    const session = await bridge.createSession({ cwd: process.cwd() })
    const events = []
    let steered = false
    for await (const event of bridge.prompt({
      sessionId: session.sessionId,
      text: 'long request',
    })) {
      events.push(event)
      if (event.type === 'prompt_started' && !steered) {
        steered = true
        await bridge.steer({
          sessionId: session.sessionId,
          runId: event.runId,
          text: 'only summarize',
        })
      }
    }

    assert.ok(events.some((event) => event.type === 'steer_queued'))
    assert.ok(events.some((event) => event.type === 'steer_applied'))
  } finally {
    await bridge.dispose()
  }
})

test('committed conversation survives a Runtime restart and can follow up', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-session-'))
  const env = { ...process.env, PRAXIS_HOME: storage }
  try {
    const first = await startLocalRuntime(runtimeEntry, env)
    const session = await first.createSession({ cwd: process.cwd(), provider: 'mock' })
    for await (const _event of first.prompt({
      sessionId: session.sessionId,
      text: 'persist this turn',
    })) {
      // Drain the first committed exchange.
    }
    await first.dispose()

    const second = await startLocalRuntime(runtimeEntry, env)
    try {
      assert.ok((await second.listSessions()).some((item) => item.sessionId === session.sessionId))
      await second.resumeSession(session.sessionId)
      let text = ''
      for await (const event of second.followUp({
        sessionId: session.sessionId,
        text: 'continue after restart',
      })) {
        if (event.type === 'text_delta') text += event.text
      }
      assert.match(text, /Conversation turns: 3/)
    } finally {
      await second.dispose()
    }
  } finally {
    await rm(storage, { recursive: true, force: true })
  }
})

test('a cached closed session resumes in the same Runtime and accepts a new prompt', async () => {
  const bridge = await startLocalRuntime(runtimeEntry)
  try {
    const session = await bridge.createSession({ cwd: process.cwd(), provider: 'mock' })
    await bridge.closeSession(session.sessionId)
    const resumed = await bridge.resumeSession(session.sessionId)
    assert.equal(resumed.state, 'idle')

    const events = []
    for await (const event of bridge.prompt({
      sessionId: session.sessionId,
      text: 'prompt after cached resume',
      clientRequestId: 'cached-resume-prompt-1',
    })) {
      events.push(event)
    }
    assert.equal(events.at(-1)?.type, 'prompt_completed')
  } finally {
    await bridge.dispose()
  }
})

test('global auth events are available without a runId and auth state remains consistent', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-auth-events-'))
  const bridge = await startLocalRuntime(runtimeEntry, {
    ...process.env,
    PRAXIS_HOME: storage,
    MOONSHOT_API_KEY: '',
  })
  try {
    const events = bridge.events()[Symbol.asyncIterator]()
    await bridge.login()
    const loginAction = (await events.next()).value
    assert.equal(loginAction?.type, 'auth_login_action')
    if (loginAction?.type === 'auth_login_action') {
      assert.match(loginAction.loginId, /^login-/)
      assert.equal(loginAction.action, 'device_code')
      assert.equal(
        loginAction.deviceCode,
        'Enter an API key in the TUI or set MOONSHOT_API_KEY in the Runtime environment.',
      )
    }
    assert.deepEqual((await events.next()).value, {
      type: 'auth_status_changed',
      provider: 'kimi',
      status: 'unauthenticated',
    })

    await bridge.logout()
    assert.deepEqual((await events.next()).value, {
      type: 'auth_status_changed',
      provider: 'kimi',
      status: 'unauthenticated',
    })
    const status = await bridge.authStatus()
    assert.equal(status.status, 'unauthenticated')
  } finally {
    await bridge.dispose()
    await rm(storage, { recursive: true, force: true })
  }
})

test('API-key login authenticates immediately and survives a Runtime restart', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-auth-persist-'))
  const environment = {
    ...process.env,
    PRAXIS_HOME: storage,
    MOONSHOT_API_KEY: '',
  }
  const first = await startLocalRuntime(runtimeEntry, environment)
  try {
    const events = first.events()[Symbol.asyncIterator]()
    await first.login('kimi', 'runtime-secret-key')
    assert.deepEqual((await events.next()).value, {
      type: 'auth_status_changed',
      provider: 'kimi',
      status: 'authenticated',
      accountLabel: 'Stored credential',
    })
    assert.deepEqual(await first.authStatus('kimi'), {
      provider: 'kimi',
      status: 'authenticated',
      accountLabel: 'Stored credential',
      credentialSource: 'stored',
      credentialVariable: 'MOONSHOT_API_KEY',
      protection: {
        encrypted: true,
        backend: 'aes-256-gcm-key-file',
        osDelegated: false,
      },
    })
    assert.equal(
      (await readFile(join(storage, 'credentials.json'), 'utf8')).includes('runtime-secret-key'),
      false,
    )
  } finally {
    await first.dispose()
  }

  const restarted = await startLocalRuntime(runtimeEntry, environment)
  try {
    assert.deepEqual(await restarted.authStatus('kimi'), {
      provider: 'kimi',
      status: 'authenticated',
      accountLabel: 'Stored credential',
      credentialSource: 'stored',
      credentialVariable: 'MOONSHOT_API_KEY',
      protection: {
        encrypted: true,
        backend: 'aes-256-gcm-key-file',
        osDelegated: false,
      },
    })
  } finally {
    await restarted.dispose()
    await rm(storage, { recursive: true, force: true })
  }
})

test('RuntimeKernel rejects unknown Providers before invoking credential behavior', async () => {
  const bridge = await startLocalRuntime(runtimeEntry)
  try {
    await assert.rejects(
      () => bridge.authStatus('unknown'),
      /INVALID_PARAMS: Unknown provider: unknown\./,
    )
    await assert.rejects(
      () => bridge.login('unknown'),
      /INVALID_PARAMS: Unknown provider: unknown\./,
    )
    await assert.rejects(
      () => bridge.logout('unknown'),
      /INVALID_PARAMS: Unknown provider: unknown\./,
    )
  } finally {
    await bridge.dispose()
  }
})

test('RuntimeKernel rejects an unknown model without creating a session', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-unknown-model-'))
  const bridge = await startLocalRuntime(runtimeEntry, {
    ...process.env,
    PRAXIS_HOME: storage,
  })
  try {
    await assert.rejects(
      () =>
        bridge.createSession({
          cwd: process.cwd(),
          provider: 'mock',
          model: 'unknown-model',
        }),
      /INVALID_PARAMS: Unknown model: mock\/unknown-model\./,
    )
    assert.deepEqual(await bridge.listSessions(), [])
  } finally {
    await bridge.dispose()
    await rm(storage, { recursive: true, force: true })
  }
})

test('Kimi logout makes implicit sessions select Mock Provider', async () => {
  const bridge = await startLocalRuntime(runtimeEntry, {
    ...process.env,
    MOONSHOT_API_KEY: 'test-key',
  })
  try {
    await bridge.logout('kimi')

    const session = await bridge.createSession({ cwd: process.cwd() })

    assert.equal(session.provider, 'mock')
  } finally {
    await bridge.dispose()
  }
})

test('agent loop executes an in-workspace tool and returns its result to the provider', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-agent-workspace-'))
  try {
    await writeFile(join(workspace, 'note.txt'), 'agent loop proof\n', 'utf8')
    const bridge = await startLocalRuntime(runtimeEntry)
    try {
      const session = await bridge.createSession({ cwd: workspace, provider: 'mock' })
      const events = []
      for await (const event of bridge.prompt({
        sessionId: session.sessionId,
        text: 'tool:read {"path":"note.txt"}',
        clientRequestId: 'tool-loop-1',
      })) {
        events.push(event)
      }

      assert.ok(events.some((event) => event.type === 'tool_planning'))
      assert.ok(events.some((event) => event.type === 'tool_start'))
      assert.ok(events.some((event) => event.type === 'tool_end' && event.ok))
      assert.match(textFrom(events), /agent loop proof/)
      assert.equal(events.at(-1)?.type, 'prompt_completed')
    } finally {
      await bridge.dispose()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('terminal delivery means session state and final memory are already durable', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-finalization-order-'))
  const bridge = await startLocalRuntime(runtimeEntry, {
    ...process.env,
    PRAXIS_HOME: storage,
  })
  try {
    const session = await bridge.createSession({ cwd: process.cwd(), provider: 'mock' })
    const events = []
    for await (const event of bridge.prompt({
      sessionId: session.sessionId,
      text: 'finalize before terminal delivery',
      clientRequestId: 'finalization-order-1',
    })) {
      events.push(event)
    }
    assert.equal(events.at(-1)?.type, 'prompt_completed')

    const [inspected, exported] = await Promise.all([
      bridge.inspectSession(session.sessionId),
      bridge.exportSession(session.sessionId),
    ])
    assert.equal(inspected.state, 'idle')
    assert.equal(inspected.lastTerminalState, 'completed')
    const memory = exported.memory as SessionMemory
    assert.equal(memory.plan, undefined)
    const [workflow] = await bridge.listWorkflows(session.sessionId)
    assert.equal(workflow?.state, 'completed')
    assert.equal(workflow?.objective, 'finalize before terminal delivery')
  } finally {
    await bridge.dispose()
    await rm(storage, { recursive: true, force: true })
  }
})

test('shipping Runtime serializes an immediate follow-up behind final persistence', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-finalization-gate-'))
  const gate = join(storage, 'finalization-gate')
  const bridge = await startLocalRuntime(finalizationRuntimeEntry, {
    ...process.env,
    PRAXIS_HOME: storage,
    PRAXIS_FINALIZATION_GATE: gate,
  })
  try {
    const session = await bridge.createSession({ cwd: process.cwd(), provider: 'mock' })
    const first = collectRun(
      bridge
        .prompt({
          sessionId: session.sessionId,
          text: 'first serialized run',
          clientRequestId: 'serialized-first',
        })
        [Symbol.asyncIterator](),
    )
    await waitForPath(`${gate}.started`)

    const followIterator = bridge
      .followUp({
        sessionId: session.sessionId,
        text: 'second serialized run',
        clientRequestId: 'serialized-second',
      })
      [Symbol.asyncIterator]()
    let followSettled = false
    const firstFollowEvent = followIterator.next().finally(() => {
      followSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 75))
    assert.equal(followSettled, false)

    await writeFile(`${gate}.release`, 'release', 'utf8')
    assert.equal((await first).at(-1)?.type, 'prompt_completed')
    const firstFollow = await firstFollowEvent
    assert.equal(firstFollow.done, false)
    const followEvents = firstFollow.done ? [] : [firstFollow.value]
    followEvents.push(...(await collectRun(followIterator)))
    assert.equal(followEvents.at(-1)?.type, 'prompt_completed')

    const exported = await bridge.exportSession(session.sessionId)
    const memory = exported.memory as SessionMemory
    assert.equal(memory.plan, undefined)
    const workflows = await bridge.listWorkflows(session.sessionId)
    assert.ok(
      workflows.some(
        (workflow) =>
          workflow.objective === 'second serialized run' && workflow.state === 'completed',
      ),
      JSON.stringify(workflows),
    )
  } finally {
    await bridge.dispose()
    await rm(storage, { recursive: true, force: true })
  }
})

test('shipping Runtime reloads durable memory after terminal metadata failure', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'praxis-finalization-failure-'))
  const bridge = await startLocalRuntime(finalizationRuntimeEntry, {
    ...process.env,
    PRAXIS_HOME: storage,
    PRAXIS_FINALIZATION_FAIL_ONCE: '1',
  })
  try {
    const session = await bridge.createSession({ cwd: process.cwd(), provider: 'mock' })
    const failed = []
    for await (const event of bridge.prompt({
      sessionId: session.sessionId,
      text: 'persist memory before terminal failure',
      clientRequestId: 'terminal-failure-first',
    })) {
      failed.push(event)
    }
    const failedTerminal = failed.at(-1)
    assert.equal(failedTerminal?.type, 'prompt_failed')
    assert.equal(
      failedTerminal?.type === 'prompt_failed' ? failedTerminal.code : undefined,
      'PERSISTENCE_OPERATION_FAILED',
    )

    const resumed = await bridge.resumeSession(session.sessionId)
    assert.equal(resumed.state, 'idle')
    const recovered = (await bridge.exportSession(session.sessionId)).memory as SessionMemory
    assert.equal(recovered.plan, undefined)
    const [failedWorkflow] = await bridge.listWorkflows(session.sessionId)
    assert.equal(failedWorkflow?.state, 'failed')
    assert.equal(failedWorkflow?.terminalCode, 'PERSISTENCE_OPERATION_FAILED')

    const continued = []
    for await (const event of bridge.followUp({
      sessionId: session.sessionId,
      text: 'continue after reloading durable state',
      clientRequestId: 'terminal-failure-second',
    })) {
      continued.push(event)
    }
    assert.equal(continued.at(-1)?.type, 'prompt_completed')
    assert.equal((await bridge.inspectSession(session.sessionId)).lastTerminalState, 'completed')
  } finally {
    await bridge.dispose()
    await rm(storage, { recursive: true, force: true })
  }
})

test('outside-workspace tool reads wait for permission and honor allow or deny', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-permission-workspace-'))
  const outside = await mkdtemp(join(tmpdir(), 'praxis-permission-outside-'))
  try {
    const externalFile = join(outside, 'secret.txt')
    await writeFile(externalFile, 'permitted external content\n', 'utf8')
    const path = relative(workspace, externalFile)
    const bridge = await startLocalRuntime(runtimeEntry)
    try {
      const session = await bridge.createSession({ cwd: workspace, provider: 'mock' })
      const allowed = []
      for await (const event of bridge.prompt({
        sessionId: session.sessionId,
        text: `tool:read ${JSON.stringify({ path })}`,
        clientRequestId: 'permission-allow-1',
      })) {
        allowed.push(event)
        if (event.type === 'permission_request') {
          await bridge.decidePermission(event.requestId, { type: 'allow_once' })
        }
      }
      assert.ok(allowed.some((event) => event.type === 'permission_request'))
      assert.ok(allowed.some((event) => event.type === 'tool_end' && event.ok))
      assert.match(textFrom(allowed), /permitted external content/)

      const denied = []
      for await (const event of bridge.followUp({
        sessionId: session.sessionId,
        text: `tool:read ${JSON.stringify({ path })}`,
        clientRequestId: 'permission-deny-1',
      })) {
        denied.push(event)
        if (event.type === 'permission_request') {
          await bridge.decidePermission(event.requestId, { type: 'deny', reason: 'test denial' })
        }
      }
      assert.ok(
        denied.some(
          (event) => event.type === 'tool_end' && !event.ok && event.summary === 'test denial',
        ),
      )
      assert.match(textFrom(denied), /test denial/)
    } finally {
      await bridge.dispose()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('Runtime authorizes and executes a junction or symlink alias by its canonical target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-target-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  try {
    await Promise.all([mkdir(workspace), mkdir(outside)])
    await writeFile(join(outside, 'secret.txt'), 'canonical runtime content\n', 'utf8')
    await symlink(
      outside,
      join(workspace, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const canonicalTarget = await realpath(join(outside, 'secret.txt'))
    const bridge = await startLocalRuntime(runtimeEntry)
    try {
      const session = await bridge.createSession({ cwd: workspace, provider: 'mock' })
      const events = []
      for await (const event of bridge.prompt({
        sessionId: session.sessionId,
        text: 'tool:read {"path":"alias/secret.txt"}',
        clientRequestId: 'canonical-target-1',
      })) {
        events.push(event)
        if (event.type === 'permission_request') {
          assert.equal(event.target, canonicalTarget)
          await bridge.decidePermission(event.requestId, { type: 'allow_once' })
        }
      }

      assert.equal(events.filter((event) => event.type === 'permission_request').length, 1)
      assert.ok(events.some((event) => event.type === 'tool_end' && event.ok))
      assert.match(textFrom(events), /canonical runtime content/)
    } finally {
      await bridge.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('abort releases a permission wait and emits one aborted terminal event', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-abort-permission-workspace-'))
  try {
    const bridge = await startLocalRuntime(runtimeEntry)
    try {
      const session = await bridge.createSession({ cwd: workspace, provider: 'mock' })
      const events = []
      for await (const event of bridge.prompt({
        sessionId: session.sessionId,
        text: 'tool:read {"path":"../outside.txt"}',
        clientRequestId: 'permission-abort-1',
      })) {
        events.push(event)
        if (event.type === 'permission_request') await bridge.abort(event.runId)
      }
      assert.equal(events.at(-1)?.type, 'prompt_aborted')
      assert.equal(events.filter((event) => isTerminal(event)).length, 1)
    } finally {
      await bridge.dispose()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('Runtime persists correlated permission and aborted Tool lifecycles', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-trace-policy-workspace-'))
  const storage = await mkdtemp(join(tmpdir(), 'praxis-trace-policy-home-'))
  const bridge = await startLocalRuntime(runtimeEntry, { ...process.env, PRAXIS_HOME: storage })
  let deniedRunId: string | undefined
  let allowedRunId: string | undefined
  let abortedRunId: string | undefined
  try {
    const deniedSession = await bridge.createSession({ cwd: workspace, provider: 'mock' })
    for await (const event of bridge.prompt({
      sessionId: deniedSession.sessionId,
      text: 'tool:read {"path":"../denied.txt"}',
      clientRequestId: 'trace-policy-deny-1',
    })) {
      if (event.type === 'prompt_started') deniedRunId = event.runId
      if (event.type === 'permission_request') {
        await bridge.decidePermission(event.requestId, { type: 'deny', reason: 'trace denial' })
      }
    }

    const allowedSession = await bridge.createSession({ cwd: workspace, provider: 'mock' })
    for await (const event of bridge.prompt({
      sessionId: allowedSession.sessionId,
      text: 'tool:write {"path":"trace.txt","content":"allowed"}',
      clientRequestId: 'trace-policy-allow-always-1',
    })) {
      if (event.type === 'prompt_started') allowedRunId = event.runId
      if (event.type === 'permission_request') {
        await bridge.decidePermission(event.requestId, { type: 'allow_always' })
      }
    }

    const abortedSession = await bridge.createSession({ cwd: workspace, provider: 'mock' })
    for await (const event of bridge.prompt({
      sessionId: abortedSession.sessionId,
      text: 'tool:read {"path":"../aborted.txt"}',
      clientRequestId: 'trace-policy-abort-1',
    })) {
      if (event.type === 'prompt_started') abortedRunId = event.runId
      if (event.type === 'permission_request') await bridge.abort(event.runId)
    }
  } finally {
    await bridge.dispose()
  }

  try {
    assert.ok(deniedRunId)
    assert.ok(allowedRunId)
    assert.ok(abortedRunId)
    const records = await loadTraceRecords(storage)
    const denied = records.filter((record) => record.context.runId === deniedRunId)
    const allowed = records.filter((record) => record.context.runId === allowedRunId)
    const aborted = records.filter((record) => record.context.runId === abortedRunId)
    assertCorrelatedTraceRun(denied, deniedRunId)
    assertCorrelatedTraceRun(allowed, allowedRunId)
    assertCorrelatedTraceRun(aborted, abortedRunId)

    assert.equal(
      denied.filter(
        (record) =>
          record.kind === 'permission.decided' && record.attributes?.permissionDecision === 'deny',
      ).length,
      1,
    )

    assert.equal(
      allowed.filter(
        (record) =>
          record.kind === 'permission.decided' &&
          record.attributes?.permissionDecision === 'allow_always',
      ).length,
      1,
    )
    assert.equal(
      allowed.filter(
        (record) =>
          record.kind === 'tool.completed' && record.attributes?.toolOutcome === 'completed',
      ).length,
      1,
    )
    assert.equal(
      allowed.filter((record) =>
        ['run.completed', 'run.failed', 'run.aborted'].includes(record.kind),
      ).length,
      1,
    )
    assert.equal(
      denied.filter(
        (record) =>
          record.kind === 'tool.failed' && record.attributes?.toolOutcome === 'policy_blocked',
      ).length,
      1,
    )
    assert.equal(
      denied.filter((record) =>
        ['run.completed', 'run.failed', 'run.aborted'].includes(record.kind),
      ).length,
      1,
    )

    assert.equal(
      aborted.filter(
        (record) =>
          record.kind === 'tool.failed' &&
          record.attributes?.toolOutcome === 'policy_blocked' &&
          record.attributes.errorCode === 'TOOL_CANCELLED',
      ).length,
      1,
    )
    assert.equal(aborted.filter((record) => record.kind === 'run.aborted').length, 1)
    assert.equal(
      aborted.filter((record) =>
        ['run.completed', 'run.failed', 'run.aborted'].includes(record.kind),
      ).length,
      1,
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(storage, { recursive: true, force: true })
  }
})

test('write tools require high-risk permission and allow_always creates a scoped Runtime rule', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-write-permission-'))
  try {
    const bridge = await startLocalRuntime(runtimeEntry)
    try {
      const session = await bridge.createSession({ cwd: workspace, provider: 'mock' })
      const first = []
      for await (const event of bridge.prompt({
        sessionId: session.sessionId,
        text: 'tool:write {"path":"note.txt","content":"first"}',
        clientRequestId: 'write-allow-always-1',
      })) {
        first.push(event)
        if (event.type === 'permission_request') {
          assert.equal(event.risk, 'high')
          await bridge.decidePermission(event.requestId, { type: 'allow_always' })
        }
      }
      assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'first')
      assert.equal(first.filter((event) => event.type === 'permission_request').length, 1)

      const second = []
      for await (const event of bridge.followUp({
        sessionId: session.sessionId,
        text: 'tool:write {"path":"note.txt","content":"second"}',
        clientRequestId: 'write-allow-always-2',
      })) {
        second.push(event)
      }
      assert.equal(second.filter((event) => event.type === 'permission_request').length, 0)
      assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'second')
    } finally {
      await bridge.dispose()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('production permission events feed bounded write and edit previews before mutation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-permission-preview-'))
  const canonicalWorkspace = await realpath(workspace)
  const target = join(canonicalWorkspace, 'note.txt')
  const original = 'first\nsecond\nthird\nfourth'
  try {
    const bridge = await startLocalRuntime(runtimeEntry)
    try {
      const session = await bridge.createSession({ cwd: workspace, provider: 'mock' })
      const writeEvents = []
      for await (const event of bridge.prompt({
        sessionId: session.sessionId,
        text: `tool:write ${JSON.stringify({ path: 'note.txt', content: original, createOnly: true })}`,
        clientRequestId: 'write-preview-production-1',
      })) {
        writeEvents.push(event)
        if (event.type !== 'permission_request') continue
        assert.deepEqual(permissionPreview(event), {
          kind: 'write',
          mode: 'CREATE ONLY',
          content: 'first\nsecond\nthird…',
        })
        await assert.rejects(readFile(target, 'utf8'), { code: 'ENOENT' })
        await bridge.decidePermission(event.requestId, { type: 'allow_once' })
      }
      const writeEnd = writeEvents.find((event) => event.type === 'tool_end')
      assert.equal(writeEnd?.ok, true, JSON.stringify(writeEvents))
      assert.equal((writeEnd?.output as { path?: string } | undefined)?.path, target)
      assert.equal(await readFile(target, 'utf8'), original)

      const editEvents = []
      for await (const event of bridge.followUp({
        sessionId: session.sessionId,
        text: `tool:edit ${JSON.stringify({
          path: 'note.txt',
          oldText: 'first',
          newText: 'changed',
        })}`,
        clientRequestId: 'edit-preview-production-1',
      })) {
        editEvents.push(event)
        if (event.type !== 'permission_request') continue
        assert.deepEqual(permissionPreview(event), {
          kind: 'edit',
          before: 'first',
          after: 'changed',
        })
        assert.equal(await readFile(target, 'utf8'), original)
        await bridge.decidePermission(event.requestId, { type: 'allow_once' })
      }
      assert.ok(
        editEvents.some((event) => event.type === 'tool_end' && event.ok),
        JSON.stringify(editEvents),
      )
      assert.equal(await readFile(target, 'utf8'), original.replace('first', 'changed'))
    } finally {
      await bridge.dispose()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('committed tool-call messages survive a Runtime restart', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-tool-restart-workspace-'))
  const storage = await mkdtemp(join(tmpdir(), 'praxis-tool-restart-store-'))
  const env = { ...process.env, PRAXIS_HOME: storage }
  try {
    await writeFile(join(workspace, 'note.txt'), 'restored tool result\n', 'utf8')
    const first = await startLocalRuntime(runtimeEntry, env)
    const session = await first.createSession({ cwd: workspace, provider: 'mock' })
    for await (const _event of first.prompt({
      sessionId: session.sessionId,
      text: 'tool:read {"path":"note.txt"}',
      clientRequestId: 'tool-persistence-1',
    })) {
      // Drain the tool round before restarting the Runtime.
    }
    await first.dispose()

    const second = await startLocalRuntime(runtimeEntry, env)
    try {
      await second.resumeSession(session.sessionId)
      let text = ''
      for await (const event of second.followUp({
        sessionId: session.sessionId,
        text: 'continue with the restored context',
        clientRequestId: 'tool-persistence-2',
      })) {
        if (event.type === 'text_delta') text += event.text
      }
      assert.match(text, /Conversation turns: 5/)
    } finally {
      await second.dispose()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(storage, { recursive: true, force: true })
  }
})

test('abort stops an active shell tool and produces one aborted terminal event', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'praxis-shell-abort-'))
  try {
    await mkdir(join(workspace, 'nested'))
    const canonicalWorkingDirectory = await realpath(join(workspace, 'nested'))
    const bridge = await startLocalRuntime(runtimeEntry)
    try {
      const session = await bridge.createSession({ cwd: workspace, provider: 'mock' })
      const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 5' : 'sleep 5 & wait'
      const events = []
      for await (const event of bridge.prompt({
        sessionId: session.sessionId,
        text: `tool:shell ${JSON.stringify({ command, workingDirectory: 'nested' })}`,
        clientRequestId: 'shell-abort-1',
      })) {
        events.push(event)
        if (event.type === 'permission_request') {
          assert.equal(event.target, canonicalWorkingDirectory)
          await bridge.decidePermission(event.requestId, { type: 'allow_once' })
        }
        if (event.type === 'tool_start') await bridge.abort(event.runId)
      }
      assert.equal(events.at(-1)?.type, 'prompt_aborted')
      assert.equal(events.filter((event) => isTerminal(event)).length, 1)
    } finally {
      await bridge.dispose()
    }
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('Runtime termination fails an active prompt instead of ending successfully', async () => {
  const bridge = await NdjsonRuntimeBridge.start(process.execPath, [
    '--import',
    'tsx',
    crashingRuntimeEntry,
  ])
  try {
    const session = await bridge.createSession({ cwd: process.cwd() })
    const iterator = bridge
      .prompt({ sessionId: session.sessionId, text: 'crash now' })
      [Symbol.asyncIterator]()
    await assert.rejects(iterator.next(), /Runtime (stdout closed|exited unexpectedly|restarted)/)
  } finally {
    await bridge.dispose()
  }
})

test('malformed Runtime stdout fails the protocol handshake', async () => {
  await assert.rejects(
    NdjsonRuntimeBridge.start(process.execPath, ['--import', 'tsx', malformedRuntimeEntry]),
    /malformed JSON/,
  )
})

test('schema-invalid Runtime stdout fails the protocol handshake', async () => {
  await assert.rejects(
    NdjsonRuntimeBridge.start(process.execPath, ['--import', 'tsx', schemaInvalidRuntimeEntry]),
    /schema-invalid protocol message.*initialize.*required property 'capabilities'/,
  )
})

test('event sequence gaps fail an active prompt', async () => {
  const bridge = await NdjsonRuntimeBridge.start(process.execPath, [
    '--import',
    'tsx',
    sequenceGapRuntimeEntry,
  ])
  try {
    const session = await bridge.createSession({ cwd: process.cwd() })
    const iterator = bridge
      .prompt({ sessionId: session.sessionId, text: 'sequence check' })
      [Symbol.asyncIterator]()
    await assert.rejects(iterator.next(), /event sequence gap/)
  } finally {
    await bridge.dispose()
  }
})

function isTerminal(event: { type: string }): boolean {
  return ['prompt_completed', 'prompt_failed', 'prompt_aborted'].includes(event.type)
}

function textFrom(events: Array<{ type: string; text?: string }>): string {
  return events
    .filter((event): event is { type: 'text_delta'; text: string } => event.type === 'text_delta')
    .map((event) => event.text)
    .join('')
}

async function collectRun(
  iterator: AsyncIterator<import('@praxis/protocol').SessionEvent>,
): Promise<import('@praxis/protocol').SessionEvent[]> {
  const events = []
  for (;;) {
    const next = await iterator.next()
    if (next.done) return events
    events.push(next.value)
  }
}

async function invokeMcpTool(
  bridge: NdjsonRuntimeBridge,
  sessionId: string,
  toolName: string,
  value: string,
  clientRequestId: string,
): Promise<unknown> {
  let output: unknown
  for await (const event of bridge.prompt({
    sessionId,
    text: `tool:${toolName} ${JSON.stringify({ value })}`,
    clientRequestId,
  })) {
    if (event.type === 'permission_request') {
      await bridge.decidePermission(event.requestId, { type: 'allow_once' })
    }
    if (event.type === 'tool_end' && event.ok) output = event.output
  }
  return output
}

async function mcpPluginFixture(
  root: string,
  version: string,
  responseVersion: string,
  options: { slow?: boolean } = {},
): Promise<void> {
  await writeFile(
    join(root, 'praxis-plugin.json'),
    `${JSON.stringify({
      manifestVersion: 1,
      id: 'example.lifecycle-mcp',
      name: 'Lifecycle MCP',
      version,
      apiVersion: 1,
      entry: 'server.mjs',
      isolation: 'mcp-stdio',
      capabilities: [{ id: 'workspace', kind: 'mcp' }],
      grants: [],
    })}\n`,
    'utf8',
  )
  const server = [
    "import { createInterface } from 'node:readline'",
    "const VERSION = '2026-07-28'",
    `const RESPONSE_VERSION = ${JSON.stringify(responseVersion)}`,
    `const SLOW = ${JSON.stringify(options.slow === true)}`,
    'const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })',
    "lines.on('line', (line) => {",
    '  const request = JSON.parse(line)',
    "  if (request.method === 'server/discover') respond(request.id, {",
    "    resultType: 'complete', supportedVersions: [VERSION], capabilities: { tools: {} },",
    "    ttlMs: 0, cacheScope: 'private',",
    "    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'lifecycle', version: '1' } },",
    '  })',
    "  else if (request.method === 'notifications/cancelled') return",
    "  else if (request.method === 'tools/list') respond(request.id, {",
    "    resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: [{",
    "      name: 'versioned_echo', inputSchema: { type: 'object' },",
    "      outputSchema: { type: 'object', properties: { value: { type: 'string' }, version: { type: 'string' } }, required: ['value', 'version'], additionalProperties: false },",
    '    }],',
    '  })',
    "  else if (request.method === 'tools/call' && !SLOW) respond(request.id, {",
    "    resultType: 'complete', content: [{ type: 'text', text: RESPONSE_VERSION }],",
    '    structuredContent: { value: request.params.arguments.value, version: RESPONSE_VERSION },',
    '    isError: false,',
    '  })',
    '})',
    "function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n') }",
  ].join('\n')
  await writeFile(join(root, 'server.mjs'), `${server}\n`, 'utf8')
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw new Error(`Timed out waiting for ${path}`)
}

async function loadTraceRecords(root: string): Promise<TraceRecord[]> {
  const traceRoot = join(root, 'traces')
  const records: TraceRecord[] = []
  let dates: string[]
  try {
    dates = await readdir(traceRoot)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  for (const date of dates) {
    for (const file of await readdir(join(traceRoot, date))) {
      if (!file.endsWith('.jsonl')) continue
      const source = await readFile(join(traceRoot, date, file), 'utf8')
      for (const line of source.split(/\r?\n/)) {
        if (line) records.push(JSON.parse(line) as TraceRecord)
      }
    }
  }
  return records
}

function assertCorrelatedTraceRun(records: TraceRecord[], runId: string): void {
  assert.ok(records.length > 0)
  assert.equal(new Set(records.map((record) => record.context.traceId)).size, 1)
  assert.equal(new Set(records.map((record) => record.context.runtimeId)).size, 1)
  assert.equal(new Set(records.map((record) => record.context.sessionId)).size, 1)
  assert.ok(records.every((record) => record.context.sessionId && record.context.runId === runId))
}
