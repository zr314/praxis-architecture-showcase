import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InputRouterV1, type CommandInvocationV1 } from '@praxis/core-sdk'
import {
  JsonlCommandAuditStoreV1,
  MemoryCommandAuditStoreV1,
} from '../apps/runtime/src/commands/commandAuditStore.js'
import {
  createRuntimeCommandRegistryV1,
  RUNTIME_COMMAND_CAPABILITIES_V1,
} from '../apps/runtime/src/commands/builtinCommandRegistry.js'
import { RuntimeCommandServiceV1 } from '../apps/runtime/src/commands/commandService.js'

const BINDING = Object.freeze({
  workspaceId: 'workspace:test',
  workspaceTrusted: true,
  capabilityIds: RUNTIME_COMMAND_CAPABILITIES_V1,
})

test('command invocation rejects stale catalog and descriptor digests before audit or execution', async () => {
  const audit = new MemoryCommandAuditStoreV1()
  const service = new RuntimeCommandServiceV1(createRuntimeCommandRegistryV1(), audit)
  await service.initialize()
  const snapshot = service.list(BINDING)
  const invocation = await route(snapshot, '/compact', 'request-stale')
  let executions = 0
  await assert.rejects(
    async () =>
      service.invoke(
        {
          schemaVersion: 1,
          workspace: process.cwd(),
          catalogSnapshotDigest: `sha256:${'f'.repeat(64)}`,
          capabilityDigest: snapshot.capabilityDigest,
          invocation,
          sessionId: 'session-1',
        },
        BINDING,
        { session: 'present', run: 'idle' },
        async () => {
          executions += 1
          return showMessage('unexpected')
        },
      ),
    hasCode('COMMAND_CATALOG_STALE'),
  )
  await assert.rejects(
    async () =>
      service.invoke(
        request(snapshot, {
          ...invocation,
          descriptorDigest: `sha256:${'e'.repeat(64)}`,
        }),
        BINDING,
        { session: 'present', run: 'idle' },
        async () => {
          executions += 1
          return showMessage('unexpected')
        },
      ),
    hasCode('COMMAND_DESCRIPTOR_STALE'),
  )
  assert.equal(executions, 0)
  assert.equal(audit.records.length, 0)
})

test('Runtime command is durably audited before execution and redacts sensitive arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-command-audit-'))
  try {
    const path = join(root, 'commands.jsonl')
    const audit = new JsonlCommandAuditStoreV1(path)
    const service = new RuntimeCommandServiceV1(createRuntimeCommandRegistryV1(), audit)
    await service.initialize()
    const snapshot = service.list(BINDING)
    const invocation = await route(snapshot, '/export "D:/private/session.json"', 'request-export')
    const result = await service.invoke(
      request(snapshot, invocation),
      BINDING,
      { session: 'present', run: 'idle' },
      async () => {
        const source = await readFile(path, 'utf8')
        assert.doesNotMatch(source, /private\/session/u)
        assert.match(source, /\[REDACTED\]/u)
        return { kind: 'ui_action', action: 'export_session', payload: { ready: true } }
      },
    )
    assert.equal(result.audited, true)
    assert.equal(result.effect, 'read')
    const [line] = (await readFile(path, 'utf8')).trim().split('\n')
    const record = JSON.parse(line!) as Record<string, unknown>
    assert.equal(record.event, 'command.invoked')
    assert.equal(record.persistence, 'redacted')
    assert.deepEqual(record.arguments, { path: '[REDACTED]' })
    assert.equal(record.argumentDigest, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('digest policy stores no raw arguments and active-run availability fails closed', async () => {
  const audit = new MemoryCommandAuditStoreV1()
  const service = new RuntimeCommandServiceV1(createRuntimeCommandRegistryV1(), audit)
  await service.initialize()
  const snapshot = service.list(BINDING)
  const modelInvocation = await route(snapshot, '/model mock/mock-v1', 'request-model')
  await service.invoke(
    request(snapshot, modelInvocation),
    BINDING,
    { session: 'present', run: 'idle' },
    async () => {
      assert.equal(audit.records.length, 1)
      return showMessage('ok')
    },
  )
  assert.equal(audit.records[0]?.persistence, 'digest')
  assert.equal(audit.records[0]?.arguments, undefined)
  assert.match(audit.records[0]?.argumentDigest ?? '', /^sha256:/u)

  const compactInvocation = await route(snapshot, '/compact', 'request-active')
  await assert.rejects(
    async () =>
      service.invoke(
        request(snapshot, compactInvocation),
        BINDING,
        { session: 'present', run: 'active' },
        async () => showMessage('unexpected'),
      ),
    hasCode('COMMAND_UNAVAILABLE_ACTIVE_RUN'),
  )
  assert.equal(audit.records.length, 1)
})

test('clientRequestId is idempotent in-process and never replays an unknown durable outcome', async () => {
  const audit = new MemoryCommandAuditStoreV1()
  const service = new RuntimeCommandServiceV1(createRuntimeCommandRegistryV1(), audit)
  await service.initialize()
  const snapshot = service.list(BINDING)
  const invocation = await route(snapshot, '/compact', 'request-once')
  let executions = 0
  const execute = async () => {
    executions += 1
    return showMessage('done')
  }
  const first = await service.invoke(
    request(snapshot, invocation),
    BINDING,
    { session: 'present', run: 'idle' },
    execute,
  )
  const duplicate = await service.invoke(
    request(snapshot, invocation),
    BINDING,
    { session: 'present', run: 'idle' },
    execute,
  )
  assert.deepEqual(duplicate, first)
  assert.equal(executions, 1)
  assert.equal(audit.records.length, 1)

  const recovered = new RuntimeCommandServiceV1(createRuntimeCommandRegistryV1(), audit)
  await recovered.initialize()
  await assert.rejects(
    async () =>
      recovered.invoke(
        request(snapshot, invocation),
        BINDING,
        { session: 'present', run: 'idle' },
        execute,
      ),
    hasCode('COMMAND_OUTCOME_UNKNOWN'),
  )
  assert.equal(executions, 1)

  const changed = await route(snapshot, '/model mock/mock-v1', 'request-once')
  await assert.rejects(
    async () =>
      service.invoke(
        request(snapshot, changed),
        BINDING,
        { session: 'present', run: 'idle' },
        execute,
      ),
    hasCode('COMMAND_CLIENT_REQUEST_COLLISION'),
  )
})

async function route(
  snapshot: ReturnType<RuntimeCommandServiceV1['list']>,
  source: string,
  clientRequestId: string,
): Promise<CommandInvocationV1> {
  const routed = await new InputRouterV1().route(source, {
    clientRequestId,
    promptId: `prompt:${clientRequestId}`,
    catalogs: [snapshot],
    capabilityDigest: snapshot.capabilityDigest,
    workspaceTrusted: snapshot.workspaceTrusted,
    session: 'present',
    run: 'idle',
  })
  assert.equal(routed.kind, 'runtime_action')
  if (routed.kind !== 'runtime_action') throw new Error('route failed')
  return routed.invocation
}

function request(
  snapshot: ReturnType<RuntimeCommandServiceV1['list']>,
  invocation: CommandInvocationV1,
) {
  return {
    schemaVersion: 1 as const,
    workspace: process.cwd(),
    catalogSnapshotDigest: snapshot.snapshotDigest,
    capabilityDigest: snapshot.capabilityDigest,
    invocation,
    sessionId: 'session-1',
  }
}

function showMessage(message: string) {
  return { kind: 'ui_action' as const, action: 'show_message', payload: { message } }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code
}
