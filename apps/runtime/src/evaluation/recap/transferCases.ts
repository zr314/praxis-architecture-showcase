import type { RecapCase } from './cases.js'

const json = (value: unknown) => JSON.stringify(value, null, 2)

/** New controlled task families; these are not copies of Terminal-Bench inputs or scores. */
export function transferRecapCases(): readonly RecapCase[] {
  const journalRules =
    'Recover from checkpoint.json and journal.json. Ignore records at or below checkpoint.lsn. Process records by lsn ascending. Each transaction has one begin and at most one commit or abort. Buffer put/delete until commit, then apply the whole transaction in commit order. Any checksumValid=false record invalidates that entire transaction; other transactions continue. Aborted and uncommitted transactions have no effect. Deletes remove a key. Sort final records by key ascending. Return answer.json as {"records":[{"key":string,"value":number},...]}. Read recovery-policy.json for the current durability rule; an explicit durability cutoff overrides historical behavior.'
  const record = (
    lsn: number,
    tx: string,
    op: string,
    key?: string,
    value?: number,
    checksumValid = true,
  ) => ({
    lsn,
    tx,
    op,
    ...(key ? { key } : {}),
    ...(value === undefined ? {} : { value }),
    checksumValid,
  })
  const journal = [
    record(39, 'old', 'put', 'a', 900),
    record(41, 't1', 'begin'),
    record(42, 't1', 'put', 'a', 11),
    record(43, 't2', 'begin'),
    record(44, 't2', 'put', 'b', 99),
    record(45, 't2', 'abort'),
    record(46, 't1', 'commit'),
    record(47, 't3', 'begin'),
    record(48, 't3', 'delete', 'd'),
    record(49, 't3', 'put', 'c', 30),
    record(50, 't3', 'commit'),
    record(51, 't4', 'begin'),
    record(52, 't4', 'put', 'a', 999),
    record(53, 't5', 'begin'),
    record(54, 't5', 'put', 'b', 60, false),
    record(55, 't5', 'commit'),
    record(56, 't6', 'begin'),
    record(57, 't6', 'put', 'b', 25),
    record(58, 't6', 'commit'),
  ]
  const recoveryFiles = {
    'recovery-rules.txt': journalRules,
    'checkpoint.json': json({
      lsn: 40,
      records: [
        { key: 'a', value: 10 },
        { key: 'b', value: 20 },
        { key: 'd', value: 4 },
      ],
    }),
    'journal.json': json(journal),
  }
  const batchRules =
    'Read batch-policy.json for alignment, capacity, and model dimensions. For each request compute S=ceil(prompt_len/sequenceAlignment)*sequenceAlignment and G=ceil(gen_len/generationAlignment)*generationAlignment. Group requests by exactly (S,G); never mix different groups. Sort groups by S ascending then G ascending. Within a group sort request_id lexicographically and split consecutively into batches of at most maxBatchSize. Number batches globally b001,b002,... in that order. Output answer.json as {"assignments":[{"request_id":string,"batch_id":string,"shape":{"seq_align":number,"gen_align":number,"heads_align":number,"hidden_align":number}},...]}, sorting assignments lexicographically by request_id. Use the current policy even if earlier alignment or capacity differs.'
  const requests = [
    ['r08', 129, 31],
    ['r01', 64, 16],
    ['r06', 65, 17],
    ['r03', 63, 15],
    ['r04', 64, 1],
    ['r02', 65, 16],
    ['r05', 128, 16],
    ['r07', 127, 15],
  ].map(([request_id, prompt_len, gen_len]) => ({ request_id, prompt_len, gen_len }))
  const batchPolicy = {
    sequenceAlignment: 64,
    generationAlignment: 16,
    maxBatchSize: 2,
    heads: 32,
    hidden: 4096,
  }
  const assignment = (id: string, batch: string, S: number, G: number) => ({
    request_id: id,
    batch_id: batch,
    shape: { seq_align: S, gen_align: G, heads_align: 32, hidden_align: 4096 },
  })
  const logRules =
    'Read date-policy.json. Count only events whose level field is exactly ERROR, WARNING, or INFO; never infer severity from message text and do not alias WARN. Do not deduplicate records. Use policy.dateSource: filename means the YYYY-MM-DD prefix of the filename; timestamp means convert the event timestamp to a calendar date in policy.timeZone. For today, last_7_days, last_30_days, and month_to_date include both boundary dates and exclude future dates. last_7_days starts today minus 6 days; last_30_days starts today minus 29 days. total includes all valid severity events regardless of date, including future events. Output answer.json as {"today":{"ERROR":n,"WARNING":n,"INFO":n},"last_7_days":{...},"last_30_days":{...},"month_to_date":{...},"total":{...}}. Check the current date-source policy before reusing a past rule.'
  const event = (level: string, timestamp: string) =>
    json({ level, timestamp, message: 'INFO WARNING ERROR in message text are not extra events.' })
  const logs = {
    'logs/2026-01-30_old.json': `[${event('ERROR', '2026-01-31T00:30:00+08:00')},${event('INFO', '2026-01-31T01:00:00Z')}]`,
    'logs/2026-01-31_edge.json': `[${event('WARNING', '2026-02-01T00:30:00+08:00')},${event('ERROR', '2026-01-30T23:00:00Z')}]`,
    'logs/2026-02-23_week.json': `[${event('ERROR', '2026-02-23T00:30:00+08:00')},${event('WARNING', '2026-02-23T12:00:00Z')},${event('INFO', '2026-02-24T01:00:00Z')}]`,
    'logs/2026-02-28_prev.json': `[${event('ERROR', '2026-03-01T00:30:00+08:00')},${event('INFO', '2026-03-01T00:30:00Z')}]`,
    'logs/2026-03-01_today.json': `[${event('WARNING', '2026-02-28T23:30:00Z')},${event('ERROR', '2026-03-01T23:30:00Z')},${event('WARN', '2026-03-01T12:00:00Z')},${event('INFO', '2026-03-02T00:30:00+08:00')}]`,
    'logs/2026-03-02_future.json': `[${event('ERROR', '2026-03-02T00:00:00Z')}]`,
  }
  const counts = (ERROR: number, WARNING: number, INFO: number) => ({ ERROR, WARNING, INFO })
  return [
    {
      id: 'journal-recovery',
      learning: {
        prompt:
          'Study recovery-rules.txt, recovery-policy.json and incidents.txt. Summarize the project recovery contract and past mistakes for future work; no future journal is available.',
        files: {
          'recovery-rules.txt': journalRules,
          'recovery-policy.json': json({ version: 1, durability: 'all valid commits' }),
          'incidents.txt':
            'A prior replay applied a put before its transaction committed and leaked an uncommitted value. Another replay applied the valid operations of a transaction containing a corrupt record. Both violated atomic recovery.',
        },
      },
      targets: [
        {
          id: 'reuse',
          prompt:
            'Recover the project state from the supplied checkpoint and journal under the current policy; write answer.json.',
          files: {
            ...recoveryFiles,
            'recovery-policy.json': json({ version: 1, durability: 'all valid commits' }),
          },
          expected: {
            records: [
              { key: 'a', value: 11 },
              { key: 'b', value: 25 },
              { key: 'c', value: 30 },
            ],
          },
        },
        {
          id: 'updated',
          prompt:
            'The durability policy has changed. Recover state using the current policy, checkpoint and journal; write answer.json.',
          files: {
            ...recoveryFiles,
            'recovery-policy.json': json({
              version: 2,
              durability:
                'Only transactions whose commit lsn is <= durableCommitLsn can be applied. Commits beyond this point are not durable, even when all checksums are valid.',
              durableCommitLsn: 46,
            }),
          },
          expected: {
            records: [
              { key: 'a', value: 11 },
              { key: 'b', value: 20 },
              { key: 'd', value: 4 },
            ],
          },
        },
      ],
    },
    {
      id: 'shape-batching',
      learning: {
        prompt:
          'Study batching-rules.txt, batch-policy.json and incidents.txt. Explain the project batching contract and the historical mistakes without inventing future requests.',
        files: {
          'batching-rules.txt': batchRules,
          'batch-policy.json': json(batchPolicy),
          'incidents.txt':
            'Previously the packer rounded prompt_len+gen_len as one dimension, mixing prefill and decode. Another version grouped only by S and silently mixed different G bounds. Both were invalid for this project.',
        },
      },
      targets: [
        {
          id: 'reuse',
          prompt:
            'Pack requests.json using this project’s current grouping and capacity policy. Write answer.json.',
          files: {
            'batching-rules.txt': batchRules,
            'batch-policy.json': json(batchPolicy),
            'requests.json': json(requests),
          },
          expected: {
            assignments: [
              assignment('r01', 'b001', 64, 16),
              assignment('r02', 'b003', 128, 16),
              assignment('r03', 'b001', 64, 16),
              assignment('r04', 'b002', 64, 16),
              assignment('r05', 'b003', 128, 16),
              assignment('r06', 'b005', 128, 32),
              assignment('r07', 'b004', 128, 16),
              assignment('r08', 'b006', 192, 32),
            ],
          },
        },
        {
          id: 'updated',
          prompt:
            'The accelerator policy changed its alignment and capacity. Pack requests.json under the current files and write answer.json.',
          files: {
            'batching-rules.txt': batchRules,
            'batch-policy.json': json({
              ...batchPolicy,
              sequenceAlignment: 128,
              generationAlignment: 32,
              maxBatchSize: 3,
            }),
            'requests.json': json(requests),
          },
          expected: {
            assignments: [
              assignment('r01', 'b001', 128, 32),
              assignment('r02', 'b001', 128, 32),
              assignment('r03', 'b001', 128, 32),
              assignment('r04', 'b002', 128, 32),
              assignment('r05', 'b002', 128, 32),
              assignment('r06', 'b002', 128, 32),
              assignment('r07', 'b003', 128, 32),
              assignment('r08', 'b004', 256, 32),
            ],
          },
        },
      ],
    },
    {
      id: 'log-date-windows',
      learning: {
        prompt:
          'Study log-rules.txt, date-policy.json and incidents.txt. Explain the project date/severity rules and known pitfalls. No future log data is available.',
        files: {
          'log-rules.txt': logRules,
          'date-policy.json': json({
            version: 1,
            today: '2026-03-01',
            dateSource: 'filename',
            timeZone: 'UTC',
          }),
          'incidents.txt':
            'A prior summary counted an ERROR word in message text as an extra event, treated WARN as WARNING, included future events in last_7_days, and started the seven-day interval today minus seven rather than minus six. Total is intentionally not bounded by today.',
        },
      },
      targets: [
        {
          id: 'reuse',
          prompt:
            'Compute all project severity windows for the supplied logs using current date-policy.json and write answer.json.',
          files: {
            'log-rules.txt': logRules,
            'date-policy.json': json({
              version: 1,
              today: '2026-03-01',
              dateSource: 'filename',
              timeZone: 'UTC',
            }),
            ...logs,
          },
          expected: {
            today: counts(1, 1, 1),
            last_7_days: counts(3, 2, 3),
            last_30_days: counts(4, 3, 3),
            month_to_date: counts(1, 1, 1),
            total: counts(6, 3, 4),
          },
        },
        {
          id: 'updated',
          prompt:
            'The project now dates events by timestamp instead of filename. Compute all windows from the current files and write answer.json.',
          files: {
            'log-rules.txt': logRules,
            'date-policy.json': json({
              version: 2,
              today: '2026-03-01',
              dateSource: 'timestamp',
              timeZone: 'UTC',
            }),
            ...logs,
          },
          expected: {
            today: counts(1, 0, 2),
            last_7_days: counts(2, 2, 3),
            last_30_days: counts(3, 3, 4),
            month_to_date: counts(1, 0, 2),
            total: counts(6, 3, 4),
          },
        },
      ],
    },
  ]
}
