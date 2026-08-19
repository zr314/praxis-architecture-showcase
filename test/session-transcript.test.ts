import assert from 'node:assert/strict'
import test from 'node:test'
import {
  latestAssistantText,
  sessionMessagesToEvents,
} from '../apps/cli/src/ui/sessionTranscript.js'

test('durable provider messages become a readable transcript without reasoning disclosure', () => {
  const events = sessionMessagesToEvents('session', [
    { role: 'user', content: 'first question', intent: 'prompt' },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'hidden reasoning' },
        { type: 'text', text: 'first answer' },
        { type: 'tool_call', id: 'call-1', name: 'read', input: { path: 'README.md' } },
      ],
    },
    { role: 'tool', toolCallId: 'call-1', name: 'read', content: 'Read 20 lines.' },
    { role: 'user', content: 'follow-up', intent: 'follow_up' },
    { role: 'assistant', content: 'second answer' },
  ])

  assert.deepEqual(
    events.filter((event) => event.type === 'prompt_started').map((event) => event.prompt),
    ['first question', 'follow-up'],
  )
  assert.equal(latestAssistantText(events), 'second answer')
  assert.doesNotMatch(JSON.stringify(events), /hidden reasoning/)
  assert.deepEqual(
    events.filter((event) => event.type === 'tool_end').map((event) => event.summary),
    ['Read 20 lines.'],
  )
})

test('latest assistant text joins visible blocks for the latest answered run', () => {
  assert.equal(
    latestAssistantText([
      { type: 'text_delta', runId: 'old', text: 'old answer' },
      { type: 'text_delta', runId: 'cli', text: 'local notice' },
      { type: 'text_delta', runId: 'latest', text: 'part one' },
      {
        type: 'tool_end',
        runId: 'latest',
        toolCallId: 'tool',
        ok: true,
        summary: 'done',
      },
      { type: 'text_delta', runId: 'latest', text: ' and part two' },
    ]),
    'part one and part two',
  )
  assert.equal(latestAssistantText([]), undefined)
})
