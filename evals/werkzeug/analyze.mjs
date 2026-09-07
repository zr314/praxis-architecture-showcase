import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const directory = resolve(process.argv[2])
const read = async (file) => JSON.parse(await readFile(join(directory, file), 'utf8'))
const prepared = await read('prepared.json')
const learning = await read('learning/episode.json')
const rows = []
const totalTokens = (usage) =>
  typeof usage?.inputTokens === 'number' && typeof usage?.outputTokens === 'number'
    ? usage.inputTokens + usage.outputTokens
    : null
for (const name of (await readdir(directory))
  .filter((n) => /^\d+-(none|compact|structured)\.json$/.test(n))
  .sort()) {
  const result = await read(name)
  const evidence = {}
  try {
    const events = JSON.parse(await readFile(join(result.directory, 'events.json'), 'utf8'))
    evidence.commands = events
      .filter((e) => e.type === 'tool_planning' && e.name === 'repo_shell')
      .map((e) => e.input.command)
    const episode = JSON.parse(await readFile(join(result.directory, 'episode.json'), 'utf8'))
    evidence.finalText = episode.messages
      .filter((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())
      .at(-1)?.content
    evidence.changedFiles = JSON.parse(
      await readFile(join(result.directory, 'changed-files.json'), 'utf8'),
    )
  } catch {
    evidence.unavailable = true
  }
  const executionTokens = totalTokens(result.usage),
    extractionTokens = totalTokens(result.extraction?.usage)
  rows.push({
    ...result,
    executionTokens,
    extractionTokens,
    firstUseTokens:
      executionTokens !== null && extractionTokens !== null
        ? executionTokens + extractionTokens
        : null,
    evidence,
  })
}
const median = (values) => {
  if (values.some((v) => typeof v !== 'number') || !values.length) return null
  values = [...values].sort((a, b) => a - b)
  const m = Math.floor(values.length / 2)
  return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2
}
const groups = ['none', 'compact', 'structured'].map((arm) => {
  const group = rows.filter((r) => r.arm === arm)
  return {
    arm,
    configurations: group.length,
    passed: group.filter((r) => r.passed).length,
    tokens: group.map((r) => r.executionTokens),
    firstUseTokens: group.map((r) => r.firstUseTokens),
    medianExecutionTokens: median(group.map((r) => r.executionTokens)),
    medianFirstUseTokens: median(group.map((r) => r.firstUseTokens)),
    tools: group.map((r) => r.toolCalls ?? null),
    medianTools: median(group.map((r) => r.toolCalls ?? null)),
    cacheReadTokens: group.map((r) => r.usage?.cacheReadTokens ?? null),
    requests: group.map((r) => r.exposure?.requests ?? null),
    injectedTokens: group.map((r) => r.exposure?.firstRequestTokens ?? null),
    extractionUsage: prepared.extraction[arm]?.usage ?? null,
  }
})
const analysis = {
  completedRows: rows.length,
  expectedRows: 9,
  learningUsage: learning.usage,
  learningElapsedMs: learning.elapsedMs,
  learningToolCalls: learning.toolCalls,
  note: 'Input + output tokens are raw provider counts, not monetary cost. Cache reads shown separately. First-use tokens charge extraction once per counterfactual target, never divided by random repetitions. Frozen learning is common historical cost. Small same-target case study, not independent tasks or significance evidence.',
  groups,
  rows,
}
await writeFile(join(directory, 'analysis.json'), JSON.stringify(analysis, null, 2) + '\n')
console.log(
  JSON.stringify({ completedRows: rows.length, learningUsage: learning.usage, groups }, null, 2),
)
