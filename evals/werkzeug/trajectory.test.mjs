import test from 'node:test'
import assert from 'node:assert/strict'
import { trajectory } from './trajectory.mjs'

const call = (index, files, exitCode = 0) => [
  { type: 'message_committed', role: 'assistant' },
  {
    type: 'tool_planning',
    toolCallId: String(index),
    name: 'repo_shell',
    input: { command: 'pytest' },
  },
  {
    type: 'tool_end',
    toolCallId: String(index),
    output: {
      exitCode,
      repositoryChanges: { source: 'host-file-digests-v1', modifiedFiles: files },
    },
  },
]
test('reverted/restored source is not misreported as first correct repair', () => {
  const r = trajectory([
    ...call(1, ['src/a.py']),
    ...call(2, ['tests/a.py']),
    ...call(3, ['src/a.py'], 1),
    ...call(4, ['src/a.py']),
    ...call(5, []),
  ])
  assert.equal(r.finalSourceStableFromTool, 4)
  assert.equal(r.toolsAfterFinalSourceMutation, 1)
  assert.equal(r.earliestPassingCheckpoint, null)
  assert.equal(r.completeFileAudit, true)
  assert.deepEqual(
    r.sourceMutations.map((c) => c.index),
    [1, 3, 4],
  )
})
test('missing receipts and partial usage do not become complete evidence', () => {
  const r = trajectory([...call(1, []), { type: 'tool_planning', toolCallId: '2' }], [])
  assert.equal(r.completeFileAudit, false)
  assert.equal(r.usageAlignmentByOrdinal, false)
})
test('dispatch token split includes the model call producing the patch, not later returns', () => {
  const r = trajectory(
    [...call(1, ['src/a.py']), ...call(2, [])],
    [
      { usage: { inputTokens: 10, outputTokens: 2 } },
      { usage: { inputTokens: 20, outputTokens: 3 } },
    ],
  )
  assert.equal(r.sourceMutations[0].mainLoopTokensThroughDispatch, 12)
  assert.equal(r.sourceMutations[0].mainLoopTokensAfterDispatch, 23)
})
