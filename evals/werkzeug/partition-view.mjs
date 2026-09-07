// Consolidated continuation view. Pending rows are never treated as old failed answers.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const directory = resolve(process.argv[2])
const input = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'))
const files = await readdir(directory)
const pending = new Set(input.pending ?? [])
const sum = (usage) =>
  typeof usage?.inputTokens === 'number' && typeof usage?.outputTokens === 'number'
    ? usage.inputTokens + usage.outputTokens
    : null
const rows = input.results.map((row) => {
  if (pending.has(row.key))
    return {
      key: row.key,
      state: files.includes(`${row.key}.started.json`) ? 'running_or_grading' : 'queued',
    }
  const before = sum(row.primaryUsage?.before),
    extraction = sum(row.extraction?.usage)
  return {
    key: row.key,
    state: 'settled',
    status: row.status,
    resumed: row.resumed === true,
    firstPassingTool: row.firstPassingTool ?? null,
    tools: row.toolCalls,
    toolsAfterFirstPass: row.toolsAfterFirstPass ?? null,
    beforePassMainTokens: before,
    beforePassWithExtraction: before !== null && extraction !== null ? before + extraction : null,
    afterPassMainTokens: sum(row.primaryUsage?.after),
    episodeTokens: sum(row.usage),
    cacheReadTokens: row.usage?.cacheReadTokens ?? null,
    grade: row.finalGrade ?? null,
    evidenceComplete: row.completeCheckpointEvidence ?? false,
  }
})
const settled = rows.filter((row) => row.state === 'settled')
const report = {
  generatedAt: new Date().toISOString(),
  original: input.original,
  continuation: directory,
  settled: settled.length,
  expected: rows.length,
  passedFinal: settled.filter((row) => row.grade?.passed).length,
  pending: [...pending],
  note: 'Unequal groups while pending; do not compare group averages as final results. Resumed trials are marked. A first passing source does not guarantee a correct final submission. Token counts are not money; phase counts exclude auxiliary calls. Historical zero-turn rate-limit attempts remain separate.',
  rows,
}
await writeFile(join(directory, 'analysis.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
