import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { MemoryReceiptV1 } from '@praxis/core-sdk'
import { NdjsonRuntimeBridge } from '../apps/cli/src/bridge/ndjsonBridge.js'

const tsx = fileURLToPath(import.meta.resolve('tsx/cli'))
const entry = resolve('test/fixtures/memory-runtime.ts')
async function start(home: string, storage: string) {
  return NdjsonRuntimeBridge.start(
    process.execPath,
    [tsx, '--tsconfig', resolve('tsconfig.check.json'), entry],
    { env: { ...process.env, PRAXIS_HOME: home, PRAXIS_SESSION_STORE: storage } },
  )
}
async function prompt(bridge: NdjsonRuntimeBridge, sessionId: string) {
  let text = ''
  let completed = false
  for await (const event of bridge.prompt({ sessionId, text: '请处理一个普通任务。' })) {
    if (event.type === 'text_delta') text += event.text
    if (event.type === 'prompt_failed') throw new Error(`${event.code}: ${event.error}`)
    if (event.type === 'prompt_completed') completed = true
  }
  assert.ok(completed)
  return JSON.parse(text) as { memory: unknown[]; tools: string[] }
}

for (const storage of ['jsonl', 'sqlite'] as const) {
  test(`local memory ${storage}: actual Runtime requests recall across process/session boundaries and revoke forks`, {
    timeout: 60000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), `praxis-memory-runtime-${storage}-`))
    const home = join(root, 'home')
    const a = join(root, 'a')
    const b = join(root, 'b')
    await mkdir(a)
    await mkdir(b)
    let bridge: NdjsonRuntimeBridge | undefined
    try {
      bridge = await NdjsonRuntimeBridge.start(
        process.execPath,
        [tsx, '--tsconfig', resolve('tsconfig.check.json'), entry],
        { env: { ...process.env, PRAXIS_HOME: home, PRAXIS_SESSION_STORE: storage } },
      )
      await bridge.manageMemory({ workspace: a, action: 'configure', mode: 'explicit' })
      const saved = (await bridge.manageMemory({
        workspace: a,
        action: 'upsert',
        operationId: 'seed',
        memory: {
          key: 'project.audience',
          kind: 'preference',
          content: 'MEMORY_CANARY_LOCAL_ONLY',
          expectedRevision: 0,
        },
      })) as MemoryReceiptV1
      await bridge.dispose()
      bridge = await start(home, storage)
      const session = await bridge.createSession({
        cwd: a,
        provider: 'mock',
        model: 'mock-v1',
        plannerMode: 'solo',
      })
      const result = await prompt(bridge, session.sessionId)
      assert.match(JSON.stringify(result.memory), /MEMORY_CANARY_LOCAL_ONLY/)
      assert.ok(result.tools.includes('memory.search'))
      assert.ok(result.tools.includes('memory.upsert'))
      const other = await bridge.createSession({
        cwd: b,
        provider: 'mock',
        model: 'mock-v1',
        plannerMode: 'solo',
      })
      const isolated = await prompt(bridge, other.sessionId)
      assert.deepEqual(isolated.memory, [])
      assert.ok(!isolated.tools.includes('memory.search'))
      const fork = await bridge.forkSession(session.sessionId)
      await bridge.manageMemory({
        workspace: a,
        action: 'forget',
        id: saved.id,
        expectedRevision: 1,
        operationId: 'forget',
      })
      await assert.rejects(
        prompt(bridge, session.sessionId),
        /MEMORY_CONTEXT_REVOKED|Start a new session/,
      )
      await assert.rejects(
        prompt(bridge, fork.sessionId),
        /MEMORY_CONTEXT_REVOKED|Start a new session/,
      )
      const fresh = await bridge.createSession({
        cwd: a,
        provider: 'mock',
        model: 'mock-v1',
        plannerMode: 'auto',
      })
      assert.deepEqual((await prompt(bridge, fresh.sessionId)).memory, [])
      // Exercise the default auto path, Root/effect brokers and real UI permission.
      let approvals = 0
      let outcome = ''
      for await (const event of bridge.prompt({
        sessionId: fresh.sessionId,
        text: 'MEMORY_TOOL_SAVE: 请记住这一偏好。',
      })) {
        if (event.type === 'permission_request') {
          approvals++
          await bridge.decidePermission(event.requestId, { type: 'allow_once' })
        }
        if (event.type === 'text_delta') outcome += event.text
        if (event.type === 'prompt_failed') throw new Error(`${event.code}: ${event.error}`)
      }
      assert.equal(approvals, 1)
      assert.match(outcome, /Explicit project memory saved/)
      assert.match(
        JSON.stringify(await bridge.manageMemory({ workspace: a, action: 'list' })),
        /TOOL_APPROVED_MEMORY/,
      )
    } finally {
      await bridge?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('source CLI configures, saves, lists and forgets local memory without calling a Provider', {
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-memory-cli-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const run = promisify(execFile)
  const command = async (...args: string[]) => {
    const result = await run(
      process.execPath,
      [
        tsx,
        '--tsconfig',
        resolve('tsconfig.check.json'),
        resolve('apps/cli/src/cli.tsx'),
        'memory',
        ...args,
        '--workspace',
        workspace,
        '--json',
      ],
      {
        env: {
          ...process.env,
          PRAXIS_HOME: join(root, 'home'),
          PRAXIS_SESSION_STORE: 'jsonl',
          TSX_TSCONFIG_PATH: resolve('tsconfig.check.json'),
        },
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 256 * 1024,
      },
    )
    return JSON.parse(result.stdout)
  }
  try {
    assert.equal((await command('status')).mode, 'off')
    assert.equal((await command('mode', 'explicit')).mode, 'explicit')
    const saved = (await command('put', 'cli.preference', 'CLI_MEMORY_CANARY')) as MemoryReceiptV1
    assert.equal((await command('list'))[0].content, 'CLI_MEMORY_CANARY')
    assert.equal((await command('forget', saved.id, '--revision', '1')).action, 'forget')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
