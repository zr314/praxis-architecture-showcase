import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Writable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertProtocolMessage } from '@praxis/protocol'
import { ArtifactStore } from '../apps/runtime/src/artifacts/artifactStore.js'
import {
  terminateProcessTree,
  waitForProcessExit,
} from '../apps/runtime/src/process/processTree.js'
import {
  type ChildBootstrapLaunch,
  type ChildBootstrapProfileInputV3,
  createChildBootstrapLaunch,
} from '../apps/runtime/src/subagent/childBootstrapProfile.js'
import type { ChildSkillCandidate } from '../apps/runtime/src/subagent/childCapabilityBundle.js'
import {
  childShellCommandPolicyV1,
  cleanupChildRuntimeComposition,
  createChildRuntimeComposition,
} from '../apps/runtime/src/subagent/childComposition.js'
import { inheritedArtifactAccessV1 } from '../apps/runtime/src/workflow/localWorkflowAgentWorker.js'
import { mockChildCapabilityBundle } from './support/child-capability.js'

const runtimeEntry = fileURLToPath(new URL('../apps/runtime/src/entry.ts', import.meta.url))

test('child shell policy denies recursive Praxis sessions without blocking ordinary commands', () => {
  for (const command of [
    'praxis --planner supervisor --print "inspect"',
    'npx praxis --version',
    '& C:\\tools\\praxis.cmd --help',
    'node D:\\praxis\\apps\\cli\\dist\\cli.js --version',
  ]) {
    assert.equal(childShellCommandPolicyV1(command)?.error?.code, 'CHILD_RECURSIVE_PRAXIS_DENIED')
  }
  assert.equal(childShellCommandPolicyV1('python --version'), undefined)
  assert.equal(childShellCommandPolicyV1("Write-Output 'praxis documentation'"), undefined)
})

test('authenticated child composition serves formal RPC with bounded authority and no main-store pollution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-child-composition-'))
  const mainHome = join(root, 'main-home')
  const alternateWorkspace = join(root, 'alternate-workspace')
  await mkdir(alternateWorkspace)
  const launch = liveLaunch(profileInput(root))
  const runtime = await startChildRuntime(launch, { PRAXIS_HOME: mainHome })

  try {
    const initialized = await runtime.request('initialize', {
      protocolVersion: 1,
      client: { name: 'child-composition-test', version: '1' },
      capabilities: { interactivePermissions: false, outputFormats: ['json'] },
    })
    assert.equal(initialized.error, undefined)
    const capabilities = ((initialized.result as { capabilities?: unknown }).capabilities ??
      {}) as {
      providers?: string[]
      tools?: Array<{ name?: string }>
      steer?: boolean
      traceExport?: boolean
    }
    assert.deepEqual(capabilities.providers, ['mock'])
    assert.deepEqual(capabilities.tools?.map((tool) => tool.name).sort(), [
      'artifact_read',
      'find',
      'glob',
      'grep',
      'ls',
      'read',
    ])
    assert.equal(capabilities.steer, false)
    assert.equal(capabilities.traceExport, false)

    assert.equal(
      (
        await runtime.request('events.subscribe', {
          sessionId: null,
          fromSequence: null,
        })
      ).error,
      undefined,
    )
    assert.equal(
      (await runtime.request('session.list', {})).error?.code,
      'CHILD_METHOD_NOT_ALLOWED',
    )
    for (const [method, params] of [
      ['auth.login', { provider: 'mock', mode: 'browser' }],
      ['settings.model.set', { provider: 'mock', model: 'other' }],
      ['plugin.install', { source: 'untrusted' }],
      ['session.fork', { sessionId: 'child-session' }],
    ] as const) {
      assert.equal(
        (await runtime.request(method, params)).error?.code,
        'CHILD_METHOD_NOT_ALLOWED',
        method,
      )
    }
    assert.equal(
      (
        await runtime.request('session.prompt', {
          sessionId: 'session-not-admitted',
          text: 'must target a child-owned session',
          clientRequestId: 'unknown-child-session',
        })
      ).error?.code,
      'SESSION_NOT_FOUND',
    )
    assert.equal(
      (
        await runtime.request('session.create', {
          cwd: alternateWorkspace,
          provider: 'mock',
          model: 'mock-v1',
        })
      ).error?.code,
      'CHILD_WORKSPACE_NOT_ALLOWED',
    )
    assert.equal(
      (
        await runtime.request('session.create', {
          cwd: process.cwd(),
          provider: 'openai',
          model: 'gpt-untrusted',
        })
      ).error?.code,
      'CHILD_PROVIDER_NOT_ALLOWED',
    )

    const created = await runtime.request('session.create', {
      cwd: process.cwd(),
      provider: 'mock',
      model: 'mock-v1',
    })
    assert.equal(created.error, undefined)
    assert.equal(typeof (created.result as { sessionId?: unknown }).sessionId, 'string')

    assert.equal((await runtime.request('shutdown', {})).error, undefined)
    assert.equal(await runtime.exit, 0)
    assert.equal(runtime.stderr(), '')
    assert.equal(existsSync(mainHome), false)
    assert.equal(existsSync(launch.profile.ephemeral.root), false)
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('child composition retains failed roots only when requested and later reclaims its own root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-child-retention-'))
  const launch = liveLaunch(profileInput(root, { retention: 'retain_on_failure' }))
  try {
    createChildRuntimeComposition(launch.profile)
    await cleanupChildRuntimeComposition(launch.profile, { failed: true })
    assert.equal(existsSync(launch.profile.ephemeral.root), true)
    await cleanupChildRuntimeComposition(launch.profile, { failed: false })
    assert.equal(existsSync(launch.profile.ephemeral.root), false)
    await cleanupChildRuntimeComposition(launch.profile, { failed: false })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('child composition realizes only granted tools and bundle-backed inline skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-child-capabilities-'))
  const content =
    '---\nname: review\ndescription: Review selected files\n---\nReview without mutation.'
  const skill: ChildSkillCandidate = {
    id: 'skill:review',
    localId: 'review',
    name: 'review',
    description: 'Review selected files',
    origin: `project:${process.cwd()}`,
    digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    disableModelInvocation: false,
    content,
  }
  const launch = liveLaunch(profileInput(root, { toolNames: ['read'], skills: [skill] }))
  try {
    const composition = createChildRuntimeComposition(launch.profile)
    const traceContext = composition.traceService?.createContext({
      runtimeId: 'child-runtime',
      sessionId: 'child-session',
      runId: 'child-agent-run',
    })
    assert.deepEqual(traceContext, {
      traceId: launch.profile.trace.traceId,
      runtimeId: 'child-runtime',
      sessionId: 'child-session',
      runId: 'child-agent-run',
      parentRunId: launch.profile.parentRunId,
      childRunId: launch.profile.childRunId,
      parentTraceId: launch.profile.trace.parentTraceId,
    })
    assert.equal('planId' in (traceContext ?? {}), false)
    assert.equal('stepId' in (traceContext ?? {}), false)
    assert.deepEqual(
      composition.tools?.map((tool) => tool.definition.name),
      ['read'],
    )
    const snapshot = composition.resourceCatalog?.snapshot(process.cwd())
    assert.deepEqual(snapshot?.skills, [
      {
        id: 'skill:review',
        localId: 'review',
        name: 'review',
        description: 'Review selected files',
        origin: `project:${process.cwd()}`,
        digest: skill.digest,
        disableModelInvocation: false,
        content,
      },
    ])
    assert.equal(Object.isFrozen(snapshot?.skills), true)
    assert.throws(
      () => composition.resourceCatalog?.snapshot(join(root, 'other-workspace')),
      (error: unknown) => hasCode(error, 'CHILD_COMPOSITION_WORKSPACE_INVALID'),
    )
    await cleanupChildRuntimeComposition(launch.profile, { failed: false })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('retain-on-failure defers graceful child shutdown cleanup to the authenticated parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-child-parent-retention-'))
  const launch = liveLaunch(profileInput(root, { retention: 'retain_on_failure' }))
  const runtime = await startChildRuntime(launch, {})
  try {
    assert.equal(
      (
        await runtime.request('initialize', {
          protocolVersion: 1,
          client: { name: 'child-retention-owner-test', version: '1' },
          capabilities: { interactivePermissions: false, outputFormats: ['json'] },
        })
      ).error,
      undefined,
    )
    assert.equal((await runtime.request('shutdown', {})).error, undefined)
    assert.equal(await runtime.exit, 0)
    assert.equal(existsSync(launch.profile.ephemeral.root), true)

    await cleanupChildRuntimeComposition(launch.profile, { failed: false })
    assert.equal(existsSync(launch.profile.ephemeral.root), false)
  } finally {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('child artifact tool reads only the admitted parent artifact closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-child-artifact-access-'))
  const parentArtifacts = new ArtifactStore(join(root, 'parent-artifacts'))
  try {
    const output = await parentArtifacts.put(
      { text: 'complete predecessor report' },
      'application/vnd.praxis.subagent-output+json',
    )
    const wrapper = await parentArtifacts.put(
      { evidenceRefs: [{ ref: `artifact://${output.artifactId}` }] },
      'application/vnd.praxis.workflow-agent-result+json',
    )
    const unrelated = await parentArtifacts.put({ secret: 'not delegated' })
    const artifactAccess = await inheritedArtifactAccessV1(
      [
        {
          artifactId: wrapper.artifactId,
          digest: wrapper.digest as `sha256:${string}`,
          mediaType: wrapper.mimeType,
        },
      ],
      parentArtifacts,
    )
    assert.deepEqual(artifactAccess?.artifactIds, [output.artifactId, wrapper.artifactId].sort())

    const launch = liveLaunch(profileInput(root, { toolNames: ['artifact_read'], artifactAccess }))
    const composition = createChildRuntimeComposition(launch.profile)
    const artifactTool = composition.tools?.find(
      ({ definition }) => definition.name === 'artifact_read',
    )
    assert.ok(artifactTool)
    for (const artifactId of [wrapper.artifactId, output.artifactId]) {
      const result = await artifactTool.execute({
        name: 'artifact_read',
        cwd: process.cwd(),
        signal: new AbortController().signal,
        input: { artifactId },
      })
      assert.equal(result.ok, true)
    }
    await assert.rejects(
      artifactTool.execute({
        name: 'artifact_read',
        cwd: process.cwd(),
        signal: new AbortController().signal,
        input: { artifactId: unrelated.artifactId },
      }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT',
    )
    await cleanupChildRuntimeComposition(launch.profile, { failed: false })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('child composition refuses overlapping roots, unavailable providers, and foreign ownership markers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-child-boundaries-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  try {
    const overlapping = liveLaunch(
      profileInput(root, { workspace, ephemeralRoot: join(workspace, 'ephemeral') }),
    )
    assert.throws(
      () => createChildRuntimeComposition(overlapping.profile),
      (error: unknown) => hasCode(error, 'CHILD_COMPOSITION_ROOT_UNSAFE'),
    )
    assert.equal(existsSync(overlapping.profile.ephemeral.root), false)

    const unavailable = liveLaunch(
      profileInput(root, {
        ephemeralRoot: join(root, 'provider-ephemeral'),
        provider: { providerId: 'replay', model: 'replay-v1' },
      }),
    )
    assert.throws(
      () => createChildRuntimeComposition(unavailable.profile),
      (error: unknown) => hasCode(error, 'CHILD_COMPOSITION_PROVIDER_UNAVAILABLE'),
    )
    assert.equal(existsSync(unavailable.profile.ephemeral.root), false)

    const foreign = liveLaunch(
      profileInput(root, { ephemeralRoot: join(root, 'foreign-ephemeral') }),
    )
    createChildRuntimeComposition(foreign.profile)
    const markerPath = join(foreign.profile.ephemeral.root, '.praxis-child-root.json')
    await writeFile(
      markerPath,
      JSON.stringify({ version: 1, childRunId: 'foreign', nonceDigest: '' }),
    )
    await assert.rejects(
      cleanupChildRuntimeComposition(foreign.profile, { failed: false }),
      (error: unknown) => hasCode(error, 'CHILD_COMPOSITION_ROOT_NOT_OWNED'),
    )
    assert.equal(existsSync(foreign.profile.ephemeral.root), true)
    assert.equal((await readFile(markerPath, 'utf8')).includes('foreign'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

type RpcResponse = {
  id?: string
  result?: unknown
  error?: { code?: string; message?: string }
}

async function startChildRuntime(
  launch: ChildBootstrapLaunch,
  additionalEnvironment: NodeJS.ProcessEnv,
): Promise<{
  request(method: string, params: unknown): Promise<RpcResponse>
  exit: Promise<number | null>
  stderr(): string
  close(): Promise<void>
}> {
  const child = spawn(process.execPath, ['--import', 'tsx', runtimeEntry], {
    cwd: process.cwd(),
    env: { ...process.env, ...additionalEnvironment, ...launch.environment },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const pending = new Map<
    string,
    { resolve(value: RpcResponse): void; reject(reason: Error): void }
  >()
  const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity })
  let stderr = ''
  let nextId = 1
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk: string) => {
    if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length)
  })
  lines.on('line', (line) => {
    try {
      const message: unknown = JSON.parse(line)
      assertProtocolMessage(message)
      if (!isRecord(message) || typeof message.id !== 'string') return
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      waiter.resolve(message as RpcResponse)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      for (const waiter of pending.values()) waiter.reject(failure)
      pending.clear()
    }
  })
  const exit = childExit(child)
  child.once('exit', () => {
    const failure = new Error(`Child Runtime exited with stderr=${stderr || '<empty>'}`)
    for (const waiter of pending.values()) waiter.reject(failure)
    pending.clear()
  })
  await childSpawn(child)
  ;(child.stdio[3] as Writable).end(launch.payloadForPid(child.pid!))

  return {
    request(method, params) {
      const id = `composition-${nextId++}`
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return new Promise((resolveRequest, rejectRequest) =>
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest }),
      )
    },
    exit,
    stderr: () => stderr,
    async close() {
      child.stdin?.end()
      lines.close()
      await terminateProcessTree(child.pid)
      await waitForProcessExit(child, 2_000)
    },
  }
}

function profileInput(
  root: string,
  options: {
    workspace?: string
    ephemeralRoot?: string
    retention?: 'delete' | 'retain_on_failure'
    provider?: { providerId: 'mock' | 'replay'; model: string }
    toolNames?: readonly string[]
    skills?: readonly ChildSkillCandidate[]
    artifactAccess?: ChildBootstrapProfileInputV3['artifactAccess']
  } = {},
): ChildBootstrapProfileInputV3 {
  const deadlineAt = new Date(Date.now() + 60_000).toISOString()
  const ephemeralRoot = resolve(options.ephemeralRoot ?? join(root, 'ephemeral'))
  const workspace = resolve(options.workspace ?? process.cwd())
  const methodAllowlist = [
    'initialize',
    'events.subscribe',
    'session.create',
    'session.prompt',
    'shutdown',
  ] as const
  const provider = options.provider ?? { providerId: 'mock', model: 'mock-v1' }
  const capabilityBundle = mockChildCapabilityBundle({
    workspace,
    methods: methodAllowlist,
    provider,
    toolNames: options.toolNames,
    skills: options.skills,
  })
  return {
    schemaVersion: 3,
    parentRunId: 'parent-composition',
    childRunId: 'child-composition',
    workspace: { root: workspace, access: 'read_only' },
    methodAllowlist,
    ephemeral: {
      root: ephemeralRoot,
      sessionRoot: join(ephemeralRoot, 'sessions'),
      traceRoot: join(ephemeralRoot, 'traces'),
      artifactRoot: join(ephemeralRoot, 'artifacts'),
      retention: options.retention ?? 'delete',
    },
    provider,
    ...(options.artifactAccess === undefined ? {} : { artifactAccess: options.artifactAccess }),
    capabilityBundleDigest: capabilityBundle.digest,
    capabilityBundle,
    budget: {
      maxTurns: 2,
      maxToolCalls: 1,
      maxTokens: 1_000,
      maxChildRuns: 0,
      maxParallelChildren: 0,
      maxDepth: 0,
      deadlineAt,
    },
    admission: { depth: 1, remainingDepth: 0 },
    deadlineAt,
    trace: { traceId: 'trace-child-composition', parentTraceId: 'trace-parent' },
  }
}

function liveLaunch(input: ChildBootstrapProfileInputV3): ChildBootstrapLaunch {
  return createChildBootstrapLaunch(input, { launchTtlMs: 60_000 })
}

function childSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn)
    child.once('error', rejectSpawn)
  })
}

function childExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolveExit, rejectExit) => {
    child.once('exit', resolveExit)
    child.once('error', rejectExit)
  })
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
