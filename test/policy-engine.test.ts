import assert from 'node:assert/strict'
import test from 'node:test'
import { PolicyEngine, type PolicyStore } from '../apps/runtime/src/policy/policyEngine.js'

test('durable policy grants are scoped to workspace, tool, and rule', async () => {
  const store = new MemoryPolicyStore()
  const engine = new PolicyEngine(store)
  await engine.initialize()
  await engine.grant({
    workspace: 'D:/one',
    tool: 'write',
    rule: 'write:D:/one/file.ts',
    target: 'D:/one/file.ts',
  })

  assert.equal(
    engine.allows({ workspace: 'D:/one', tool: 'write', rule: 'write:D:/one/file.ts' }),
    true,
  )
  assert.equal(
    engine.allows({ workspace: 'D:/two', tool: 'write', rule: 'write:D:/one/file.ts' }),
    false,
  )
  assert.equal(engine.allows({ workspace: 'D:/one', tool: 'shell', rule: 'shell:D:/one' }), false)
  assert.deepEqual(store.audits.at(-1), {
    workspace: 'D:/one',
    tool: 'write',
    rule: 'write:D:/one/file.ts',
    decision: 'allow_always',
    target: 'D:/one/file.ts',
  })
})

test('policy audit records redact sensitive metadata before persistence', async () => {
  const store = new MemoryPolicyStore()
  const engine = new PolicyEngine(store)
  await engine.initialize()
  await engine.record({
    workspace: 'D:/one',
    tool: 'shell',
    rule: 'shell:D:/one',
    decision: 'deny',
    data: { apiKey: 'never-store', command: 'also-hidden', reason: 'not allowed' },
  })

  assert.deepEqual(store.audits, [
    {
      workspace: 'D:/one',
      tool: 'shell',
      rule: 'shell:D:/one',
      decision: 'deny',
      data: { reason: 'not allowed' },
    },
  ])
})

class MemoryPolicyStore implements PolicyStore {
  grants = []
  audits: Array<Record<string, unknown>> = []

  async loadGrants() {
    return [...this.grants]
  }
  async saveGrants(grants: typeof this.grants) {
    this.grants = [...grants]
  }
  async appendAudit(record: Record<string, unknown>) {
    this.audits.push(record)
  }
}
