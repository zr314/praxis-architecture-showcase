import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { NdjsonRuntimeBridge } from '../apps/cli/src/bridge/ndjsonBridge.js'

test('Host unbudgeted solo execution exceeds the old evaluation ceiling; explicit limits still apply', {
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-unbudgeted-'))
  let bridge: NdjsonRuntimeBridge | undefined
  try {
    await writeFile(join(root, 'input.txt'), 'probe')
    bridge = await NdjsonRuntimeBridge.start(
      process.execPath,
      [
        fileURLToPath(import.meta.resolve('tsx/cli')),
        '--tsconfig',
        resolve('tsconfig.check.json'),
        resolve('test/fixtures/unbudgeted-runtime.ts'),
      ],
      { env: { ...process.env, PRAXIS_HOME: join(root, 'home') } },
    )
    for (const bounded of [false, true]) {
      const session = await bridge.createSession({
        cwd: root,
        provider: 'mock',
        model: 'mock-v1',
        plannerMode: 'solo',
        contextLimitTokens: 32768,
      })
      const events = []
      for await (const event of bridge.prompt({
        sessionId: session.sessionId,
        text: 'Read input.txt until done.',
        ...(bounded ? { budget: { maxTurns: 4, maxToolCalls: 8 } } : {}),
      }))
        events.push(event)
      assert.equal(
        events.filter((e) => e.type === 'tool_end').length,
        bounded ? 4 : 20,
        JSON.stringify(events),
      )
      const terminal = events.at(-1)!
      assert.equal(
        events.some((e) => e.type === 'workflow_update'),
        bounded,
      )
      assert.equal(terminal.type, bounded ? 'prompt_failed' : 'prompt_completed')
      if (terminal.type === 'prompt_failed')
        assert.equal(terminal.code, 'AGENT_TURN_LIMIT_EXCEEDED')
    }
    const session = await bridge.createSession({
      cwd: root,
      provider: 'mock',
      model: 'mock-v1',
      plannerMode: 'solo',
    })
    const events = []
    for await (const event of bridge.prompt({ sessionId: session.sessionId, text: 'Plan probe' }))
      events.push(event)
    assert.equal(events.at(-1)?.type, 'prompt_completed', JSON.stringify(events))
    assert.equal(
      events.filter((e) => e.type === 'tool_end' && e.ok).length,
      2,
      JSON.stringify(events),
    )
    const plan = await bridge.sessionPlan(session.sessionId)
    assert.match(JSON.stringify(plan), /"status":"done"/)
    const strictEvents = []
    for await (const event of bridge.prompt({
      sessionId: session.sessionId,
      text: 'Strict probe',
      planPolicy: 'required',
    }))
      strictEvents.push(event)
    const strictTerminal = strictEvents.at(-1)
    assert.equal(strictTerminal?.type, 'prompt_failed', JSON.stringify(strictEvents))
    if (strictTerminal?.type === 'prompt_failed')
      assert.equal(strictTerminal.code, 'UNBUDGETED_STRICT_PLAN_UNSUPPORTED')
    assert.equal(strictEvents.filter((e) => e.type === 'tool_planning').length, 0)
  } finally {
    await bridge?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
