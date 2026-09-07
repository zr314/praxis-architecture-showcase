import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const directory = resolve(process.argv[2])
const names = await readdir(directory)
const read = async (path) => JSON.parse(await readFile(join(directory, path), 'utf8'))
const prepared = await read('prepared.json')
const tokens = (usage) =>
  typeof usage?.inputTokens === 'number' && typeof usage?.outputTokens === 'number'
    ? usage.inputTokens + usage.outputTokens
    : null
const rows = []
for (const key of prepared.design.order) {
  if (!names.includes(`${key}.json`)) {
    rows.push({
      key,
      state: names.includes(`${key}.started.json`) ? 'started_unsettled' : 'pending',
    })
    continue
  }
  const row = await read(`${key}.json`)
  let failureCode = null
  try {
    const events = (await readFile(join(row.directory, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    failureCode = events.findLast((event) => event.type === 'prompt_failed')?.code ?? null
  } catch {
    /* Preserve unavailable evidence without inventing a failure cause. */
  }
  const extractionTokens = tokens(row.extraction?.usage),
    before = tokens(row.primaryUsage?.before)
  rows.push({
    key,
    state: 'settled',
    status: row.status,
    failureCode,
    executionStarted: (row.toolCalls ?? 0) > 0 || (row.usage?.turns ?? 0) > 0,
    patchPassed: row.finalGrade?.passed ?? null,
    evidenceComplete: row.completeCheckpointEvidence ?? false,
    evidenceErrors: row.evidenceErrors,
    scoringError: row.scoringError,
    exposure: row.exposure,
    firstPassingTool: row.firstPassingTool ?? null,
    toolsAfterFirstPass: row.toolsAfterFirstPass ?? null,
    beforeFirstPassMainLoopTokens: before,
    afterFirstPassMainLoopTokens: tokens(row.primaryUsage?.after),
    beforeFirstPassWithExtraction:
      before !== null && extractionTokens !== null ? before + extractionTokens : null,
    episodeTokens: tokens(row.usage),
    cacheReadTokens: row.usage?.cacheReadTokens ?? null,
    extractionTokens,
    toolCalls: row.toolCalls ?? null,
    elapsedMs: row.elapsedMs ?? null,
  })
}
const report = {
  generatedAt: new Date().toISOString(),
  settledRows: rows.filter((r) => r.state === 'settled').length,
  expectedRows: prepared.design.order.length,
  note: 'Main-loop phase splits exclude auxiliary calls; episode totals are separate. Cache and extraction are separate, not money. The older cohort also runs on this host, so wall time is descriptive. A single related case does not support broad or statistically significant claims.',
  rows,
}
await writeFile(join(directory, 'analysis.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
