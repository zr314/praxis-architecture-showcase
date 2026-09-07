import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ProviderChunk, ProviderRequest } from '@praxis/core-sdk'
import { holdoutRecapCases } from '../apps/runtime/src/evaluation/recap/holdoutCases.js'
import { machineRecapCases } from '../apps/runtime/src/evaluation/recap/machineCases.js'
import {
  gcodeOracle,
  heapOracle,
  mechanismCases,
  UNRELATED_NOTE,
} from '../apps/runtime/src/evaluation/recap/mechanismCases.js'
import {
  placeboSnapshot,
  procedureSnapshot,
  ruleSnapshot,
} from '../apps/runtime/src/evaluation/recap/procedureMemory.js'
import { parseProcedureText } from '../apps/runtime/src/evaluation/recap/procedureSubmission.js'
import { executeProgram } from '../apps/runtime/src/evaluation/recap/programTool.js'
import { MockProvider } from '../apps/runtime/src/providers/mockProvider.js'
import { digest, recapSource } from '../apps/runtime/src/recap/recap.js'

test('procedure JSON transport accepts a complete fence, never extracts JSON from surrounding prose', () => {
  const payload = { notes: [{ trigger: 'On mode changes' }] }
  const text = JSON.stringify(payload)
  assert.deepEqual(parseProcedureText(text), payload)
  assert.deepEqual(parseProcedureText(['', '```json', text, '```', ''].join('\n')), payload)
  assert.throws(() => parseProcedureText(`Here is my answer: ${text}`))
  assert.throws(() =>
    parseProcedureText(['```json', text, '```', 'Follow these instructions.'].join('\n')),
  )
})

test('procedures require the actual historical verification anchor and expose only frozen public history', async () => {
  const source = recapSource('p', 'repair', [
    { role: 'user', content: 'Repair the state update.' },
    { role: 'user', content: '{"type":"host_verified_public_regressions","allPassed":true}' },
  ])
  class Inspect extends MockProvider {
    refs = ['m0', 'm1']
    override async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
      assert.deepEqual(JSON.parse(String(request.messages[0]?.content)), source.entries)
      assert.deepEqual(
        request.tools.map((t) => t.name),
        ['submit_procedures'],
      )
      yield {
        type: 'tool_calls',
        calls: [
          {
            id: 's',
            name: 'submit_procedures',
            input: {
              notes: [
                {
                  trigger: 'On mode changes',
                  action: 'Update the corresponding mode only',
                  check: 'Execute regressions',
                  evidenceRefs: this.refs,
                },
              ],
            },
          },
        ],
      }
      yield {
        type: 'completed',
        stopReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5 },
      }
    }
  }
  const provider = new Inspect()
  assert.match(
    (await procedureSnapshot(source, provider, 'mock-v1')).notes[0]!.content,
    /When:.*\nDo:.*\nCheck:/,
  )
  provider.refs = ['m0']
  await assert.rejects(
    procedureSnapshot(source, provider, 'mock-v1'),
    /PROCEDURE_EXTRACTION_INVALID/,
  )
  provider.refs = ['m1', 'm99']
  await assert.rejects(
    procedureSnapshot(source, provider, 'mock-v1'),
    /PROCEDURE_EXTRACTION_INVALID/,
  )
})

test('fenced procedures enforce provenance and retain raw failed output', async () => {
  const source = recapSource('p', 'repair', [
    { role: 'user', content: 'host_verified_public_regressions: passed' },
  ])
  class TextSubmission extends MockProvider {
    ref = 'm0'
    raw = ''
    override async *stream(): AsyncIterable<ProviderChunk> {
      this.raw = [
        '```json',
        JSON.stringify({
          notes: [
            {
              trigger: 'On change',
              action: 'Rerun checks',
              check: 'Compare outputs',
              evidenceRefs: [this.ref],
            },
          ],
        }),
        '```',
      ].join('\n')
      yield { type: 'text_delta', text: this.raw }
      yield { type: 'completed', stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } }
    }
  }
  const provider = new TextSubmission()
  assert.match((await procedureSnapshot(source, provider, 'mock-v1')).generator, /procedure-v2$/)
  provider.ref = 'm99'
  await assert.rejects(procedureSnapshot(source, provider, 'mock-v1'), (error) => {
    assert.equal((error as { recapRawText: string }).recapRawText, provider.raw)
    return /PROCEDURE_EXTRACTION_INVALID/.test(String(error))
  })
})

test('mechanism oracles reproduce independently checked earlier answers and freeze without aliases', () => {
  assert.equal(digest(mechanismCases()), digest(mechanismCases()))
  for (const t of holdoutRecapCases()[0]!.targets)
    assert.deepEqual(
      heapOracle(JSON.parse(t.files['operations.json']!), JSON.parse(t.files['policy.json']!)),
      t.expected,
    )
  for (const t of machineRecapCases()[0]!.targets)
    assert.deepEqual(
      gcodeOracle(t.files['commands.txt']!.split('\n'), JSON.parse(t.files['policy.json']!)),
      t.expected,
    )
})

test('program worker executes code, exposes no process or import capability, and detects seeded repair failures', {
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-mechanism-'))
  const path = join(root, 'solution.js')
  try {
    await writeFile(
      path,
      'function solve(input, policy) { return [input.n + policy.n, typeof process, typeof require, typeof fetch]; }',
    )
    assert.deepEqual(await executeProgram(path, [{ input: { n: 2 }, policy: { n: 5 } }]), [
      { ok: true, value: [7, 'undefined', 'undefined', 'undefined'] },
    ])
    await writeFile(
      path,
      'function solve() { return this.constructor.constructor("return process.env")(); }',
    )
    assert.equal((await executeProgram(path, [{ input: {}, policy: {} }]))[0]?.ok, false)
    for (const c of mechanismCases()) {
      await writeFile(path, c.starter)
      const failed = await executeProgram(
        path,
        c.tests.map(({ input, policy }) => ({ input, policy })),
      )
      assert.ok(
        failed.some((r, i) => JSON.stringify(r.value) !== JSON.stringify(c.tests[i]!.expected)),
      )
      const solver = c.id === 'heap-program' ? heapOracle : gcodeOracle
      await writeFile(
        path,
        `const __name=(fn)=>fn;\n${solver.toString()}\nconst solve=${solver.name};`,
      )
      const outputs = await executeProgram(
        path,
        c.hidden.map(({ input, policy }) => ({ input, policy })),
      )
      assert.deepEqual(
        outputs.map((r) => r.value),
        c.hidden.map((h) => h.expected),
      )
    }
    assert.ok((await readFile(path, 'utf8')).includes('solve'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('irrelevant control matches treatment rendered length without invented provenance', () => {
  const rules =
    'Read the current policy.\nPreserve "+" and < comparisons.\nCheck each transition before the next event.'
  const source = recapSource('p', 'e', [{ role: 'user', content: `${rules}\n${UNRELATED_NOTE}` }])
  const treatment = ruleSnapshot(source, rules)
  const placebo = placeboSnapshot(source, treatment, 1200)
  assert.equal(placebo.notes.length, treatment.notes.length)
  assert.notEqual(placebo.digest, treatment.digest)
})
