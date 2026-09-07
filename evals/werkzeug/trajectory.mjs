import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Never infer a successful repair from a model claim or a shell exit code. */
export function trajectory(events, usageRows = []) {
  const plans = new Map()
  const calls = []
  let turn = 0
  for (const event of events) {
    if (event.type === 'message_committed' && event.role === 'assistant') turn++
    if (event.type === 'tool_planning') {
      const call = {
        index: calls.length + 1,
        turn,
        id: event.toolCallId,
        name: event.name,
        command: event.input?.command ?? '',
        ended: false,
      }
      calls.push(call)
      plans.set(call.id, call)
    }
    if (event.type === 'tool_end') {
      const call = plans.get(event.toolCallId)
      if (!call) throw new Error('Unmatched tool receipt')
      const output = event.output ?? {}
      const receipt = output.repositoryChanges
      Object.assign(call, {
        ended: true,
        exitCode: output.exitCode,
        audited:
          receipt?.source === 'host-file-digests-v1' &&
          Array.isArray(receipt.modifiedFiles) &&
          !output.fileAuditUnavailable,
        modifiedFiles: receipt?.modifiedFiles ?? [],
        outputTail: (output.stdout ?? '').slice(-1200),
      })
    }
  }
  const aligned = turn === usageRows.length
  const sum = (rows) =>
    rows.reduce((n, r) => n + (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0), 0)
  const mutations = calls.filter((c) => c.modifiedFiles?.some((p) => p.startsWith('src/')))
  for (const call of mutations) {
    call.mainLoopTokensThroughDispatch = aligned ? sum(usageRows.slice(0, call.turn)) : null
    call.mainLoopTokensAfterDispatch = aligned ? sum(usageRows.slice(call.turn)) : null
  }
  return {
    terminal:
      events.findLast((e) =>
        ['prompt_completed', 'prompt_failed', 'prompt_aborted', 'prompt_blocked'].includes(e.type),
      ) ?? null,
    assistantTurns: turn,
    usageAlignmentByOrdinal: aligned,
    totalTools: calls.length,
    completeFileAudit: calls.length > 0 && calls.every((c) => c.ended && c.audited),
    sourceMutations: mutations,
    finalSourceStableFromTool: mutations.at(-1)?.index ?? null,
    toolsAfterFinalSourceMutation: mutations.length ? calls.length - mutations.at(-1).index : null,
    earliestPassingCheckpoint: null,
    note: 'Final-source stability is not the first correct patch. Earlier versions were not snapshotted. Token splits use successful main-loop returns aligned by assistant-message ordinal; they exclude auxiliary calls and failed streams. A mutation command may include tests after writing, so no precise completion time is inferred.',
    calls,
  }
}

export async function analyzeTrajectories(directory) {
  const rows = []
  for (const name of (await readdir(directory))
    .filter((n) => /^\d+-(none|compact|structured)\.json$/.test(n))
    .sort()) {
    const result = JSON.parse(await readFile(join(directory, name), 'utf8'))
    const readLines = async (file) =>
      (await readFile(join(result.directory, file), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse)
    const trace = trajectory(
      await readLines('events.jsonl'),
      await readLines('context-manifests.jsonl.usage.jsonl'),
    )
    rows.push({
      key: result.key,
      runtimeStatus: result.status,
      patchPassed: result.grading?.passed ?? null,
      usage: result.usage,
      ...trace,
    })
  }
  await writeFile(
    join(directory, 'trajectory-analysis.json'),
    JSON.stringify({ rows }, null, 2) + '\n',
  )
  return rows
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const rows = await analyzeTrajectories(resolve(process.argv[2]))
  console.log(
    JSON.stringify(
      rows.map(({ calls, sourceMutations, ...row }) => ({
        ...row,
        sourceMutations: sourceMutations.map(({ command, outputTail, ...mutation }) => mutation),
      })),
      null,
      2,
    ),
  )
}
