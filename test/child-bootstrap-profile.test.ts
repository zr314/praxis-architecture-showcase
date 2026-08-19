import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Writable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertProtocolMessage } from '@praxis/protocol'
import {
  authenticateChildBootstrapPayload,
  CHILD_BOOTSTRAP_KEY_ENV,
  CHILD_BOOTSTRAP_MODE_ENV,
  ChildBootstrapReplayGuard,
  createChildBootstrapLaunch,
  readChildBootstrapProfileFromProcess,
  type ChildBootstrapLaunch,
  type ChildBootstrapProfileInputV3,
} from '../apps/runtime/src/subagent/childBootstrapProfile.js'
import {
  terminateProcessTree,
  waitForProcessExit,
} from '../apps/runtime/src/process/processTree.js'
import { mockChildCapabilityBundle } from './support/child-capability.js'
import { spawn } from 'node:child_process'

const probeEntry = fileURLToPath(new URL('./fixtures/child-bootstrap-probe.ts', import.meta.url))
const runtimeEntry = fileURLToPath(new URL('../apps/runtime/src/entry.ts', import.meta.url))
const NOW = Date.parse('2026-08-03T00:00:00.000Z')

test('launch-bound profile is authenticated, immutable, scrubbed, and replay protected', async () => {
  const root = resolve(tmpdir(), 'praxis-bootstrap-unit')
  const launch = deterministicLaunch(profileInput(root), 5_000)
  const pid = 4242
  const payload = launch.payloadForPid(pid)
  const guard = new ChildBootstrapReplayGuard()
  const authenticated = authenticateChildBootstrapPayload(payload, {
    key: launch.environment[CHILD_BOOTSTRAP_KEY_ENV],
    processId: pid,
    now: () => NOW + 100,
    replayGuard: guard,
  })

  assert.equal(authenticated.parentRunId, 'parent-run')
  assert.equal(authenticated.childRunId, 'child-run')
  assert.equal(authenticated.reasoningEffort, 'medium')
  assert.equal(Object.isFrozen(authenticated), true)
  assert.equal(Object.isFrozen(authenticated.workspace), true)
  assert.equal(Object.isFrozen(authenticated.methodAllowlist), true)
  assert.equal(
    JSON.stringify(authenticated).includes(launch.environment[CHILD_BOOTSTRAP_KEY_ENV]),
    false,
  )
  assert.throws(
    () =>
      authenticateChildBootstrapPayload(payload, {
        key: launch.environment[CHILD_BOOTSTRAP_KEY_ENV],
        processId: pid,
        now: () => NOW + 100,
        replayGuard: guard,
      }),
    (error: unknown) => hasCode(error, 'CHILD_BOOTSTRAP_REPLAYED'),
  )
})

test('tamper, cross-process replay, expiry, and oversize fail with content-free stable errors', () => {
  const root = resolve(tmpdir(), 'praxis-bootstrap-failures')
  const launch = deterministicLaunch(profileInput(root), 1_000)
  const pid = 5151
  const payload = launch.payloadForPid(pid)
  const parsed = JSON.parse(payload) as { profile: { workspace: { root: string } } }
  parsed.profile.workspace.root = resolve(root, 'tampered-workspace')
  const sensitiveValues = [
    parsed.profile.workspace.root,
    launch.profile.launch.nonce,
    launch.environment[CHILD_BOOTSTRAP_KEY_ENV],
  ]

  assertBootstrapFailure(
    () =>
      authenticateChildBootstrapPayload(JSON.stringify(parsed), {
        key: launch.environment[CHILD_BOOTSTRAP_KEY_ENV],
        processId: pid,
        now: () => NOW + 100,
        replayGuard: new ChildBootstrapReplayGuard(),
      }),
    'CHILD_BOOTSTRAP_UNAUTHORIZED',
    sensitiveValues,
  )
  assertBootstrapFailure(
    () =>
      authenticateChildBootstrapPayload(payload, {
        key: launch.environment[CHILD_BOOTSTRAP_KEY_ENV],
        processId: pid + 1,
        now: () => NOW + 100,
        replayGuard: new ChildBootstrapReplayGuard(),
      }),
    'CHILD_BOOTSTRAP_UNAUTHORIZED',
    sensitiveValues,
  )
  assertBootstrapFailure(
    () =>
      authenticateChildBootstrapPayload(payload, {
        key: launch.environment[CHILD_BOOTSTRAP_KEY_ENV],
        processId: pid,
        now: () => NOW + 1_001,
        replayGuard: new ChildBootstrapReplayGuard(),
      }),
    'CHILD_BOOTSTRAP_EXPIRED',
    sensitiveValues,
  )
  assertBootstrapFailure(
    () =>
      authenticateChildBootstrapPayload(Buffer.alloc(64 * 1024 + 1), {
        key: launch.environment[CHILD_BOOTSTRAP_KEY_ENV],
        processId: pid,
      }),
    'CHILD_BOOTSTRAP_OVERSIZED',
    sensitiveValues,
  )
})

test('dedicated fd 3 delivers the profile and child scrubs launch authority from its environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-bootstrap-channel-'))
  try {
    const launch = liveLaunch(root)
    const result = await runLaunchBoundChild(probeEntry, launch)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.deepEqual(JSON.parse(result.stdout), {
      parentRunId: 'parent-run',
      childRunId: 'child-run',
      workspace: { root: resolve(process.cwd()), access: 'read_only' },
      frozen: true,
      launchEnvironmentScrubbed: true,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('shipping Runtime uses the authenticated isolated composition without touching main stores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-bootstrap-runtime-'))
  const mainHome = join(root, 'main-home')
  try {
    const launch = liveLaunch(root)
    const result = await runLaunchBoundChild(runtimeEntry, launch, {
      PRAXIS_HOME: mainHome,
    })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(existsSync(mainHome), false)
    assert.equal(existsSync(launch.profile.ephemeral.root), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bootstrap is absent without the launch marker and partial launch state fails closed', () => {
  assert.equal(readChildBootstrapProfileFromProcess({ environment: {} }), undefined)
  assertBootstrapFailure(
    () =>
      readChildBootstrapProfileFromProcess({
        environment: { [CHILD_BOOTSTRAP_MODE_ENV]: 'v1' },
        readPayload: () => Buffer.from('{}'),
      }),
    'CHILD_BOOTSTRAP_UNAUTHORIZED',
    [],
  )
})

test('ordinary Runtime RPC cannot self-assert child launch authority', () => {
  const launch = deterministicLaunch(profileInput(resolve(tmpdir(), 'praxis-bootstrap-rpc')), 5_000)
  const initialize = {
    jsonrpc: '2.0',
    id: 'self-assert-bootstrap',
    method: 'initialize',
    params: {
      protocolVersion: 1,
      supportedProtocolVersions: [1],
      client: { name: 'unauthorized-child', version: '1' },
      capabilities: { interactivePermissions: false, outputFormats: ['json'] },
      childBootstrapProfile: launch.profile,
      parentRunId: launch.profile.parentRunId,
      childCapabilityBundleDigest: launch.profile.capabilityBundleDigest,
    },
  }

  assert.throws(() => assertProtocolMessage(initialize), /additional propert/)
})

test('bootstrap v3 rejects legacy budget fields, admission mismatch, and bundle drift', () => {
  const input = profileInput(resolve(tmpdir(), 'praxis-bootstrap-v3'))
  assertBootstrapFailure(
    () =>
      createChildBootstrapLaunch({
        ...input,
        budget: {
          maxTurns: 1,
          maxToolCalls: 0,
          maxSubagents: 0,
          maxDepth: 0,
        } as never,
      }),
    'CHILD_BOOTSTRAP_INVALID',
    [],
  )
  assertBootstrapFailure(
    () =>
      createChildBootstrapLaunch({
        ...input,
        admission: { depth: 1, remainingDepth: input.budget.maxDepth + 1 },
      }),
    'CHILD_BOOTSTRAP_INVALID',
    [],
  )
  const driftedBundle = structuredClone(input.capabilityBundle) as unknown as {
    tools: Array<{ definition: { description: string } }>
  }
  driftedBundle.tools[0]!.definition.description = 'drifted after compilation'
  assertBootstrapFailure(
    () =>
      createChildBootstrapLaunch({
        ...input,
        capabilityBundle: driftedBundle as never,
      }),
    'CHILD_BOOTSTRAP_INVALID',
    [],
  )
  const brokerProvider = { providerId: 'openai', model: 'gpt-test' }
  const lateCredentialBundle = mockChildCapabilityBundle({
    methods: input.methodAllowlist,
    provider: brokerProvider,
    credential: {
      kind: 'broker_handle',
      handleId: 'broker-handle-late',
      expiresAt: new Date(Date.parse(input.deadlineAt) + 1_000).toISOString(),
    },
  })
  assertBootstrapFailure(
    () =>
      createChildBootstrapLaunch({
        ...input,
        provider: brokerProvider,
        capabilityBundleDigest: lateCredentialBundle.digest,
        capabilityBundle: lateCredentialBundle,
      }),
    'CHILD_BOOTSTRAP_INVALID',
    [],
  )

  const expiringCredentialBundle = mockChildCapabilityBundle({
    methods: input.methodAllowlist,
    provider: brokerProvider,
    credential: {
      kind: 'broker_handle',
      handleId: 'broker-handle-expiring',
      expiresAt: new Date(NOW + 500).toISOString(),
    },
  })
  const expiringLaunch = deterministicLaunch(
    {
      ...input,
      provider: brokerProvider,
      capabilityBundleDigest: expiringCredentialBundle.digest,
      capabilityBundle: expiringCredentialBundle,
    },
    5_000,
  )
  assertBootstrapFailure(
    () =>
      authenticateChildBootstrapPayload(expiringLaunch.payloadForPid(7171), {
        key: expiringLaunch.environment[CHILD_BOOTSTRAP_KEY_ENV],
        processId: 7171,
        now: () => NOW + 1_000,
        replayGuard: new ChildBootstrapReplayGuard(),
      }),
    'CHILD_BOOTSTRAP_EXPIRED',
    [],
  )
})

function profileInput(root: string, now = NOW): ChildBootstrapProfileInputV3 {
  const deadlineAt = new Date(now + 60_000).toISOString()
  const ephemeralRoot = resolve(root, 'ephemeral')
  const methodAllowlist = [
    'initialize',
    'events.subscribe',
    'session.create',
    'session.prompt',
    'shutdown',
  ] as const
  const capabilityBundle = mockChildCapabilityBundle({ methods: methodAllowlist })
  return {
    schemaVersion: 3,
    parentRunId: 'parent-run',
    childRunId: 'child-run',
    workspace: { root: resolve(process.cwd()), access: 'read_only' },
    methodAllowlist,
    ephemeral: {
      root: ephemeralRoot,
      sessionRoot: resolve(ephemeralRoot, 'sessions'),
      traceRoot: resolve(ephemeralRoot, 'traces'),
      artifactRoot: resolve(ephemeralRoot, 'artifacts'),
      retention: 'delete',
    },
    provider: { providerId: 'mock', model: 'mock-v1' },
    reasoningEffort: 'medium',
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
    trace: { traceId: 'trace-child', parentTraceId: 'trace-parent' },
  }
}

function liveLaunch(root: string): ChildBootstrapLaunch {
  const now = Date.now()
  return createChildBootstrapLaunch(profileInput(root, now), {
    now: () => now,
    launchTtlMs: 60_000,
  })
}

function deterministicLaunch(
  input: ChildBootstrapProfileInputV3,
  launchTtlMs: number,
): ChildBootstrapLaunch {
  let fill = 1
  return createChildBootstrapLaunch(input, {
    now: () => NOW,
    launchTtlMs,
    randomBytes: (size) => Buffer.alloc(size, fill++),
  })
}

async function runLaunchBoundChild(
  entry: string,
  launch: ChildBootstrapLaunch,
  additionalEnvironment: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: process.cwd(),
    env: { ...process.env, ...additionalEnvironment, ...launch.environment },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout!.setEncoding('utf8')
  child.stderr!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr!.on('data', (chunk: string) => {
    stderr += chunk
  })
  child.once('spawn', () => {
    const channel = child.stdio[3] as Writable
    channel.end(launch.payloadForPid(child.pid!))
  })

  try {
    const code = await Promise.race([
      new Promise<number | null>((resolveExit, rejectExit) => {
        child.once('exit', (exitCode) => resolveExit(exitCode))
        child.once('error', rejectExit)
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for launch-bound child.')), 10_000),
      ),
    ])
    return { code, stdout, stderr }
  } finally {
    await terminateProcessTree(child.pid)
    await waitForProcessExit(child, 1_000)
  }
}

function assertBootstrapFailure(
  action: () => unknown,
  code: string,
  sensitiveValues: string[],
): void {
  assert.throws(action, (error: unknown) => {
    if (!hasCode(error, code) || !(error instanceof Error)) return false
    for (const value of sensitiveValues) assert.equal(error.message.includes(value), false)
    return true
  })
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
