import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CancellationTree,
  type ExecutionBudget,
  type RuntimeTool,
  type ToolDefinition,
} from '@praxis/core-sdk'
import { McpStdioClient } from '../apps/runtime/src/extensions/mcpStdioClient.js'
import { InMemorySubagentAdmissionLedger } from '../apps/runtime/src/subagent/admission.js'
import {
  digestToolDefinition,
  type ChildCapabilityBundleV1,
  type ChildSkillCandidate,
  type McpToolGrant,
} from '../apps/runtime/src/subagent/childCapabilityBundle.js'
import type { ChildBootstrapMethod } from '../apps/runtime/src/subagent/childBootstrapProfile.js'
import {
  ChildRuntimeHost,
  type ChildRuntimeRun,
} from '../apps/runtime/src/subagent/childRuntimeHost.js'
import type { ContextPacketV1 } from '../apps/runtime/src/subagent/contextPacket.js'
import {
  bindChildMcpBrokerCapability,
  ChildMcpToolBroker,
} from '../apps/runtime/src/subagent/mcpBrokerIpc.js'
import { mockChildCapabilityBundle } from './support/child-capability.js'

const runtimeEntry = fileURLToPath(new URL('../apps/runtime/src/entry.ts', import.meta.url))
const mcpServer = fileURLToPath(new URL('./fixtures/mcp-modern-server.mjs', import.meta.url))
const methods = [
  'initialize',
  'events.subscribe',
  'session.create',
  'session.prompt',
  'permission.decide',
  'session.abort',
  'shutdown',
] as const satisfies readonly ChildBootstrapMethod[]

test('shipping child explicitly invokes one signed low-trust Skill with result evidence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-child-skill-'))
  const skill = skillCandidate('skill:review', 'Review only the selected workspace files.')
  const bundle = mockChildCapabilityBundle({ methods, skills: [skill], toolNames: [] })
  const profile = childProfile(home, bundle)
  const { host } = childHost('skill-parent')

  try {
    const result = await host.run(
      childExecution(
        profile,
        'skill-parent',
        'skill-child',
        'tool:skill {"name":"skill:review","arguments":"package.json"}',
      ),
    )

    assert.equal(result.status, 'succeeded')
    assert.match(result.summary, /skill:review/iu)
    assert.equal(result.evidenceRefs.length, 1)
    assert.equal(result.evidenceRefs[0]?.ref, 'skill-result:skill:review:mock-tool-1')
    assert.match(result.evidenceRefs[0]?.digest ?? '', /^sha256:[a-f0-9]{64}$/u)
    assert.equal(result.evidenceRefs[0]?.mediaType, 'application/vnd.praxis.skill-invocation+json')
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('shipping child calls a real read-only MCP Tool through the parent broker', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-child-mcp-'))
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [mcpServer],
    pluginId: 'fixture',
    serverId: 'readonly',
    requestTimeoutMs: 2_000,
  })
  try {
    const parentTool = client.runtimeTools()[0]!
    const grant = readOnlyMcpGrant(parentTool, 16 * 1024)
    const bundle = mockChildCapabilityBundle({
      methods,
      toolNames: [],
      mcpToolGrants: [grant],
    })
    const profile = childProfile(home, bundle)
    const capability = bindChildMcpBrokerCapability(
      grant,
      parentTool,
      brokerAuthority(profile, 'mcp-parent', 'mcp-child'),
    )
    const broker = new ChildMcpToolBroker((id) =>
      id === grant.brokerCapabilityId ? capability : undefined,
    )
    const { host } = childHost('mcp-parent', broker)
    const result = await host.run(
      childExecution(
        profile,
        'mcp-parent',
        'mcp-child',
        `tool:${grant.name} {"value":"brokered-child"}`,
      ),
    )

    assert.equal(result.status, 'succeeded')
    assert.match(result.summary, /brokered-child/iu)
    assert.equal(result.evidenceRefs.length, 1)
    assert.equal(result.evidenceRefs[0]?.ref, `mcp-result:${grant.brokerCapabilityId}:mock-tool-1`)
    assert.equal(result.evidenceRefs[0]?.mediaType, 'application/vnd.praxis.mcp-tool-result+json')
  } finally {
    await client.shutdown()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('parent MCP broker fails closed for unauthorized, unhealthy, and schema-drifted tools', async () => {
  const tool = fixtureTool()
  const grant = readOnlyMcpGrant(tool, 4_096)

  await assert.rejects(
    new ChildMcpToolBroker(() => undefined).invoke(brokerInvocation(grant)),
    hasCode('CHILD_MCP_UNAUTHORIZED'),
  )

  const unhealthy = bindChildMcpBrokerCapability(grant, tool, brokerInvocation(grant), 'unhealthy')
  await assert.rejects(
    new ChildMcpToolBroker(() => unhealthy).invoke(brokerInvocation(grant)),
    hasCode('CHILD_MCP_SERVER_UNHEALTHY'),
  )

  const mutable = fixtureTool()
  const capability = bindChildMcpBrokerCapability(grant, mutable, brokerInvocation(grant))
  mutable.definition.description = 'schema drift after grant'
  await assert.rejects(
    new ChildMcpToolBroker(() => capability).invoke(brokerInvocation(grant)),
    hasCode('CHILD_MCP_SCHEMA_DRIFT'),
  )

  await assert.rejects(
    new ChildMcpToolBroker(() => capability).invoke({
      ...brokerInvocation(grant),
      childRunId: 'different-child',
    }),
    hasCode('CHILD_MCP_UNAUTHORIZED'),
  )
})

test('parent MCP broker enforces cancellation and output bounds', async () => {
  const oversizedTool = fixtureTool(async () => ({
    ok: true,
    summary: 'oversized',
    output: { value: 'x'.repeat(4_096) },
  }))
  const boundedGrant = readOnlyMcpGrant(oversizedTool, 256)
  const oversized = bindChildMcpBrokerCapability(
    boundedGrant,
    oversizedTool,
    brokerInvocation(boundedGrant),
  )
  await assert.rejects(
    new ChildMcpToolBroker(() => oversized).invoke(brokerInvocation(boundedGrant)),
    hasCode('CHILD_MCP_OUTPUT_OVERSIZED'),
  )

  let observedAbort = false
  const hangingTool = fixtureTool(
    (request) =>
      new Promise((_, reject) => {
        request.signal.addEventListener(
          'abort',
          () => {
            observedAbort = true
            reject(new Error('cancelled'))
          },
          { once: true },
        )
      }),
  )
  const grant = readOnlyMcpGrant(hangingTool, 4_096)
  const capability = bindChildMcpBrokerCapability(grant, hangingTool, brokerInvocation(grant))
  const controller = new AbortController()
  const active = new ChildMcpToolBroker(() => capability).invoke({
    ...brokerInvocation(grant),
    signal: controller.signal,
  })
  controller.abort()
  await assert.rejects(active, hasCode('CHILD_MCP_CANCELLED'))
  assert.equal(observedAbort, true)
})

test('parent cancellation crosses the MCP IPC channel and aborts the live server call', async () => {
  const home = await mkdtemp(join(tmpdir(), 'praxis-child-mcp-cancel-'))
  let startedResolve!: () => void
  const started = new Promise<void>((resolveStarted) => {
    startedResolve = resolveStarted
  })
  let observedAbort = false
  const tool = fixtureTool(
    (request) =>
      new Promise((_, reject) => {
        startedResolve()
        request.signal.addEventListener(
          'abort',
          () => {
            observedAbort = true
            reject(new Error('cancelled'))
          },
          { once: true },
        )
      }),
  )
  const grant = readOnlyMcpGrant(tool, 4_096)
  const bundle = mockChildCapabilityBundle({ methods, toolNames: [], mcpToolGrants: [grant] })
  const profile = childProfile(home, bundle)
  const capability = bindChildMcpBrokerCapability(
    grant,
    tool,
    brokerAuthority(profile, 'cancel-parent', 'cancel-child'),
  )
  const broker = new ChildMcpToolBroker(() => capability)
  const { host } = childHost('cancel-parent', broker)

  try {
    const active = host.run(
      childExecution(
        profile,
        'cancel-parent',
        'cancel-child',
        `tool:${grant.name} {"value":"wait"}`,
      ),
    )
    await started
    assert.deepEqual(host.cancel('cancel-parent', 'user_abort'), [
      ['cancel-parent', 'user_abort'],
      ['cancel-child', 'parent_cancelled'],
    ])
    const result = await active
    assert.equal(result.status, 'cancelled')
    assert.equal(result.error?.code, 'CHILD_PARENT_CANCELLED')
    assert.equal(observedAbort, true)
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

function skillCandidate(id: string, content: string): ChildSkillCandidate {
  return {
    id,
    localId: id.slice(id.indexOf(':') + 1),
    name: id.slice(id.indexOf(':') + 1),
    description: 'Signed child fixture Skill.',
    origin: 'test://child-skill-fixture',
    digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    disableModelInvocation: false,
    content,
    status: 'enabled',
  }
}

function readOnlyMcpGrant(tool: RuntimeTool, maxInlineBytes: number): McpToolGrant {
  const definition: ToolDefinition = {
    ...structuredClone(tool.definition),
    execution: {
      sideEffect: 'read',
      target: { kind: 'workspace' },
      parallelSafe: true,
      conflictScope: 'workspace',
      maxInlineBytes,
      timeoutMs: 5_000,
    },
  }
  return {
    name: definition.name,
    definition,
    definitionDigest: digestToolDefinition(definition),
    brokerCapabilityId: 'mcp-broker-fixture-read',
  }
}

function fixtureTool(
  execute: RuntimeTool['execute'] = async (request) => ({
    ok: true,
    summary: 'fixture completed',
    output: { value: String(request.input.value ?? '') },
  }),
): RuntimeTool & { definition: ToolDefinition } {
  return {
    definition: {
      name: 'mcp__fixture__read',
      description: 'Fixture MCP read tool.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      execution: {
        sideEffect: 'process',
        target: { kind: 'workspace' },
        parallelSafe: false,
        conflictScope: 'workspace',
        maxInlineBytes: 64 * 1024,
      },
    },
    execute,
  }
}

function childProfile(
  home: string,
  capabilityBundle: ChildCapabilityBundleV1,
): ChildRuntimeRun['bootstrapProfile'] {
  const root = join(home, 'ephemeral')
  return {
    schemaVersion: 3,
    workspace: capabilityBundle.workspace,
    methodAllowlist: methods,
    ephemeral: {
      root,
      sessionRoot: join(root, 'sessions'),
      traceRoot: join(root, 'traces'),
      artifactRoot: join(root, 'artifacts'),
      retention: 'delete',
    },
    provider: capabilityBundle.provider.target,
    capabilityBundleDigest: capabilityBundle.digest,
    capabilityBundle,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    trace: { traceId: 'trace-child-skills-mcp', parentTraceId: 'trace-parent-skills-mcp' },
  }
}

function childExecution(
  profile: ChildRuntimeRun['bootstrapProfile'],
  parentRunId: string,
  childRunId: string,
  instructions: string,
): ChildRuntimeRun {
  return {
    packet: contextPacket(profile, parentRunId, childRunId, instructions),
    parentUsage: { turns: 0, toolCalls: 0 },
    launch: {
      command: process.execPath,
      args: ['--import', 'tsx', runtimeEntry],
      cwd: process.cwd(),
    },
    bootstrapProfile: profile,
  }
}

function contextPacket(
  profile: ChildRuntimeRun['bootstrapProfile'],
  parentRunId: string,
  childRunId: string,
  instructions: string,
): ContextPacketV1 {
  return {
    schemaVersion: 1,
    packetId: `packet-${childRunId}`,
    parentRunId,
    childRunId,
    objective: 'Exercise one explicitly granted child capability.',
    step: { stepId: `step-${childRunId}`, title: 'Invoke capability', instructions },
    constraints: ['Use only the signed child capability bundle.'],
    relevantRefs: [],
    successCriteria: [{ id: 'invoked', description: 'The granted capability is invoked.' }],
    workspace: profile.workspace,
    grant: {
      bundleId: profile.capabilityBundle.bundleId,
      bundleDigest: profile.capabilityBundle.digest,
      provider: profile.provider,
      tools: profile.capabilityBundle.tools.map((tool) => tool.name),
      skills: profile.capabilityBundle.skills.map((skill) => skill.id),
      methods: [...profile.capabilityBundle.methodAllowlist],
      mcpMode: profile.capabilityBundle.mcp.mode,
    },
    budget: {
      maxTurns: 2,
      maxToolCalls: 2,
      maxTokens: 1_000,
      maxChildRuns: 0,
      maxParallelChildren: 0,
      maxDepth: 0,
      deadlineAt: profile.deadlineAt,
    },
    prohibitions: ['Do not write files.', 'Do not spawn descendants.'],
    outputSchema: {
      format: 'json',
      schema: { type: 'object' },
      maxInlineBytes: 4_096,
      overflow: 'artifact_ref',
    },
  }
}

function childHost(parentRunId: string, mcpBroker?: ChildMcpToolBroker) {
  const ledger = new InMemorySubagentAdmissionLedger()
  ledger.registerRootScope({ runId: parentRunId, budget: rootBudget() })
  return {
    ledger,
    host: new ChildRuntimeHost({
      ledger,
      cancellation: new CancellationTree(),
      handshakeTimeoutMs: 10_000,
      shutdownGraceMs: 500,
      ...(mcpBroker === undefined ? {} : { mcpBroker }),
    }),
  }
}

function rootBudget(): ExecutionBudget {
  return {
    maxTurns: 4,
    maxToolCalls: 4,
    maxChildRuns: 1,
    maxParallelChildren: 1,
    maxDepth: 1,
  }
}

function brokerInvocation(grant: McpToolGrant) {
  return {
    parentRunId: 'broker-parent',
    childRunId: 'broker-child',
    workspace: resolve(process.cwd()),
    bundleId: 'bundle-broker-test',
    bundleDigest: 'a'.repeat(64),
    grant,
    input: { value: 'hello' },
    signal: new AbortController().signal,
  }
}

function brokerAuthority(
  profile: ChildRuntimeRun['bootstrapProfile'],
  parentRunId: string,
  childRunId: string,
) {
  return {
    parentRunId,
    childRunId,
    workspace: profile.workspace.root,
    bundleId: profile.capabilityBundle.bundleId,
    bundleDigest: profile.capabilityBundle.digest,
  }
}

function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
