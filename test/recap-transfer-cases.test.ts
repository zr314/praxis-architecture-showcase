import assert from 'node:assert/strict'
import test from 'node:test'
import { transferRecapCases } from '../apps/runtime/src/evaluation/recap/transferCases.js'

// Independent reference computations check hand-authored answers before spending model quota.
test('journal fixture answers enforce atomicity, corruption, abort, checkpoint and durability', () => {
  const taskCase = transferRecapCases().find((c) => c.id === 'journal-recovery')!
  for (const target of taskCase.targets) {
    const checkpoint = JSON.parse(target.files['checkpoint.json']!)
    const policy = JSON.parse(target.files['recovery-policy.json']!)
    const entries = JSON.parse(target.files['journal.json']!) as {
      lsn: number
      tx: string
      op: string
      key?: string
      value?: number
      checksumValid: boolean
    }[]
    const state = new Map<string, number>(
      checkpoint.records.map((r: { key: string; value: number }) => [r.key, r.value]),
    )
    const transactions = new Map<string, typeof entries>()
    for (const entry of entries.sort((a, b) => a.lsn - b.lsn)) {
      if (entry.lsn <= checkpoint.lsn) continue
      const tx = transactions.get(entry.tx) ?? []
      tx.push(entry)
      transactions.set(entry.tx, tx)
      if (
        entry.op !== 'commit' ||
        entry.lsn > (policy.durableCommitLsn ?? Infinity) ||
        tx.some((e) => !e.checksumValid || e.op === 'abort')
      )
        continue
      for (const operation of tx) {
        if (operation.op === 'put') state.set(operation.key!, operation.value!)
        if (operation.op === 'delete') state.delete(operation.key!)
      }
    }
    assert.deepEqual(
      {
        records: [...state]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => ({ key, value })),
      },
      target.expected,
    )
  }
})

test('shape fixture answers independently satisfy alignment, grouping and canonical batching', () => {
  for (const target of transferRecapCases().find((c) => c.id === 'shape-batching')!.targets) {
    const policy = JSON.parse(target.files['batch-policy.json']!)
    const requests = JSON.parse(target.files['requests.json']!) as {
      request_id: string
      prompt_len: number
      gen_len: number
    }[]
    const sorted = requests
      .map((r) => ({
        id: r.request_id,
        S: Math.ceil(r.prompt_len / policy.sequenceAlignment) * policy.sequenceAlignment,
        G: Math.ceil(r.gen_len / policy.generationAlignment) * policy.generationAlignment,
      }))
      .sort((a, b) => a.S - b.S || a.G - b.G || a.id.localeCompare(b.id))
    let batch = 0
    let members = 0
    let previous = ''
    const assignments = sorted
      .map((r) => {
        const group = `${r.S}:${r.G}`
        if (group !== previous || members === policy.maxBatchSize) {
          batch++
          members = 0
        }
        previous = group
        members++
        return {
          request_id: r.id,
          batch_id: `b${String(batch).padStart(3, '0')}`,
          shape: {
            seq_align: r.S,
            gen_align: r.G,
            heads_align: policy.heads,
            hidden_align: policy.hidden,
          },
        }
      })
      .sort((a, b) => a.request_id.localeCompare(b.request_id))
    assert.deepEqual({ assignments }, target.expected)
  }
})

test('date fixture answers cover UTC crossings, inclusive month/week boundaries, future and severity traps', () => {
  for (const target of transferRecapCases().find((c) => c.id === 'log-date-windows')!.targets) {
    const policy = JSON.parse(target.files['date-policy.json']!)
    const day = Date.parse(`${policy.today}T00:00:00Z`)
    const ranges = {
      today: day,
      last_7_days: day - 6 * 86400000,
      last_30_days: day - 29 * 86400000,
      month_to_date: Date.parse(`${policy.today.slice(0, 7)}-01T00:00:00Z`),
      total: -Infinity,
    }
    const actual = Object.fromEntries(
      Object.keys(ranges).map((p) => [p, { ERROR: 0, WARNING: 0, INFO: 0 }]),
    )
    for (const [name, content] of Object.entries(target.files)) {
      if (!name.startsWith('logs/')) continue
      for (const event of JSON.parse(content) as { level: string; timestamp: string }[]) {
        if (!['ERROR', 'WARNING', 'INFO'].includes(event.level)) continue
        const date =
          policy.dateSource === 'filename'
            ? name.slice(5, 15)
            : new Date(event.timestamp).toISOString().slice(0, 10)
        const time = Date.parse(`${date}T00:00:00Z`)
        for (const [period, start] of Object.entries(ranges))
          if (period === 'total' || (time >= start && time <= day))
            actual[period]![event.level as 'ERROR' | 'WARNING' | 'INFO']++
      }
    }
    assert.deepEqual(actual, target.expected)
  }
})
