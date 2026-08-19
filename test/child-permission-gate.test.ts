import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'
import type { SessionEvent } from '@praxis/protocol'
import {
  assertChildExecutionMvp,
  ChildPermissionGate,
  type ChildPermissionRequestV1,
} from '../apps/runtime/src/subagent/childPermissionGate.js'
import type { ContextPacketV1 } from '../apps/runtime/src/subagent/contextPacket.js'
import { mockChildCapabilityBundle } from './support/child-capability.js'

const methods = ['initialize', 'permission.decide', 'shutdown'] as const

test('child permission gate correlates an in-grant request with parent and child run IDs', async () => {
  const workspace = resolve(process.cwd())
  const bundle = mockChildCapabilityBundle({ methods, toolNames: ['read'] })
  let captured: ChildPermissionRequestV1 | undefined
  const gate = new ChildPermissionGate(
    {
      parentRunId: 'parent-1',
      childRunId: 'child-1',
      workspace,
      capabilityBundle: bundle,
    },
    {
      decide(request) {
        captured = request
        return { type: 'allow_once' }
      },
    },
  )

  const decision = await gate.decide(permissionEvent({ target: join(workspace, 'package.json') }))

  assert.deepEqual(decision, { type: 'allow_once' })
  assert.equal(captured?.parentRunId, 'parent-1')
  assert.equal(captured?.childRunId, 'child-1')
  assert.equal(captured?.workspace, workspace)
  assert.equal(captured?.runId, 'child-agent-run-1')
  assert.equal(captured?.rule, `read-outside:${join(workspace, 'package.json')}`)
  assert.equal(captured?.grant.bundleId, bundle.bundleId)
  assert.equal(captured?.grant.bundleDigest, bundle.digest)
  assert.equal(Object.isFrozen(captured), true)
  assert.equal(Object.isFrozen(captured?.input), true)
})

test('child permission gate denies outside, ungranted, duplicate, and unbrokered requests', async () => {
  const workspace = resolve(process.cwd())
  const bundle = mockChildCapabilityBundle({ methods, toolNames: ['read'] })
  let decisions = 0
  const gate = new ChildPermissionGate(
    {
      parentRunId: 'parent-1',
      childRunId: 'child-1',
      workspace,
      capabilityBundle: bundle,
    },
    {
      decide() {
        decisions += 1
        return { type: 'allow_always' }
      },
    },
  )

  assert.deepEqual(
    await gate.decide(
      permissionEvent({ requestId: 'outside', target: resolve(workspace, '..', 'outside.txt') }),
    ),
    { type: 'deny', reason: 'Child permission denied (outside_signed_grant).' },
  )
  assert.deepEqual(
    await gate.decide(
      permissionEvent({ requestId: 'write', tool: 'write', target: join(workspace, 'file.txt') }),
    ),
    { type: 'deny', reason: 'Child permission denied (outside_signed_grant).' },
  )
  assert.equal(decisions, 0)

  const accepted = permissionEvent({ requestId: 'once', target: join(workspace, 'package.json') })
  assert.deepEqual(await gate.decide(accepted), { type: 'allow_always' })
  assert.deepEqual(await gate.decide(accepted), {
    type: 'deny',
    reason: 'Child permission denied (duplicate_request).',
  })
  assert.equal(decisions, 1)

  const unbrokered = new ChildPermissionGate({
    parentRunId: 'parent-1',
    childRunId: 'child-1',
    workspace,
    capabilityBundle: bundle,
  })
  assert.deepEqual(
    await unbrokered.decide(
      permissionEvent({ requestId: 'unbrokered', target: join(workspace, 'package.json') }),
    ),
    { type: 'deny', reason: 'Child permission denied (parent_decision_unavailable).' },
  )
})

test('child permission gate bounds request input and fail-closes invalid parent decisions', async () => {
  const workspace = resolve(process.cwd())
  const bundle = mockChildCapabilityBundle({ methods, toolNames: ['read'] })
  const gate = new ChildPermissionGate(
    {
      parentRunId: 'parent-1',
      childRunId: 'child-1',
      workspace,
      capabilityBundle: bundle,
    },
    {
      decide() {
        return { type: 'allow_once', extra: true } as never
      },
    },
  )

  assert.deepEqual(
    await gate.decide(
      permissionEvent({ requestId: 'oversized', input: { value: 'x'.repeat(20 * 1024) } }),
    ),
    { type: 'deny', reason: 'Child permission denied (outside_signed_grant).' },
  )
  assert.deepEqual(
    await gate.decide(
      permissionEvent({ requestId: 'invalid-decision', target: join(workspace, 'package.json') }),
    ),
    { type: 'deny', reason: 'Child permission denied (parent_decision_invalid).' },
  )
})

test('writable child authority brokers an in-workspace write through the parent decision gate', async () => {
  const workspace = resolve(process.cwd())
  const bundle = mockChildCapabilityBundle({
    methods,
    workspaceAccess: 'workspace_write',
    toolNames: ['write'],
  })
  let decisions = 0
  const gate = new ChildPermissionGate(
    {
      parentRunId: 'parent-write',
      childRunId: 'child-write',
      workspace,
      capabilityBundle: bundle,
    },
    {
      decide() {
        decisions += 1
        return { type: 'allow_once' }
      },
    },
  )

  assert.deepEqual(
    await gate.decide(
      permissionEvent({
        requestId: 'write-inside',
        tool: 'write',
        target: join(workspace, 'generated.txt'),
      }),
    ),
    { type: 'allow_once' },
  )
  assert.equal(decisions, 1)
  assert.doesNotThrow(() =>
    assertChildExecutionMvp(
      {
        budget: {
          maxTurns: 2,
          maxToolCalls: 1,
          maxChildRuns: 0,
          maxParallelChildren: 0,
          maxDepth: 0,
        },
      } as ContextPacketV1,
      bundle,
    ),
  )
})

test('child execution MVP independently permits Skills and parent-broker MCP', () => {
  const bundle = mockChildCapabilityBundle({ methods, toolNames: ['read'] })
  const packet = {
    budget: {
      maxTurns: 2,
      maxToolCalls: 1,
      maxChildRuns: 0,
      maxParallelChildren: 0,
      maxDepth: 0,
    },
  } as ContextPacketV1

  assert.doesNotThrow(() => assertChildExecutionMvp(packet, bundle))
  assert.throws(
    () =>
      assertChildExecutionMvp(
        {
          ...packet,
          budget: { ...packet.budget, maxChildRuns: 1, maxParallelChildren: 1, maxDepth: 1 },
        },
        bundle,
      ),
    (error: unknown) => hasCode(error, 'CHILD_MVP_DESCENDANTS_DENIED'),
  )
  assert.doesNotThrow(() => assertChildExecutionMvp(packet, { ...bundle, skills: [{} as never] }))
  assert.doesNotThrow(() =>
    assertChildExecutionMvp(packet, {
      ...bundle,
      mcp: { mode: 'parent_broker', toolGrants: [] },
    }),
  )
  assert.throws(
    () =>
      assertChildExecutionMvp(packet, {
        ...bundle,
        mcp: { mode: 'child_launch', serverManifests: [] },
      }),
    (error: unknown) => hasCode(error, 'CHILD_MVP_MCP_DISABLED'),
  )
  assert.throws(
    () =>
      assertChildExecutionMvp(packet, {
        ...bundle,
        tools: [
          {
            ...bundle.tools[0]!,
            definition: {
              ...bundle.tools[0]!.definition,
              execution: {
                ...bundle.tools[0]!.definition.execution!,
                sideEffect: 'write',
              },
            },
          },
        ],
      }),
    (error: unknown) => hasCode(error, 'CHILD_MVP_TOOL_DENIED'),
  )
})

function permissionEvent(
  overrides: Partial<Extract<SessionEvent, { type: 'permission_request' }>> = {},
): Extract<SessionEvent, { type: 'permission_request' }> {
  return {
    type: 'permission_request',
    runId: 'child-agent-run-1',
    requestId: 'permission-1',
    toolCallId: 'tool-call-1',
    tool: 'read',
    input: { path: 'package.json' },
    risk: 'medium',
    target: join(process.cwd(), 'package.json'),
    rule: `read-outside:${join(process.cwd(), 'package.json')}`,
    ...overrides,
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}
