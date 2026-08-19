import assert from 'node:assert/strict'
import test from 'node:test'
import { appendEvent } from '../apps/cli/src/ui/eventState.js'

test('adjacent streamed text is coalesced into one terminal row', () => {
  const started = appendEvent([], {
    type: 'prompt_started',
    sessionId: 's-1',
    runId: 'r-1',
    prompt: 'hello',
  })
  const first = appendEvent(started, { type: 'text_delta', runId: 'r-1', text: '我可以' })
  const merged = appendEvent(first, { type: 'text_delta', runId: 'r-1', text: '帮助你。' })

  assert.equal(merged.length, 2)
  assert.deepEqual(merged.at(-1), { type: 'text_delta', runId: 'r-1', text: '我可以帮助你。' })
})

test('separate CLI notices are not concatenated into one message', () => {
  const invalid = appendEvent([], {
    type: 'text_delta',
    runId: 'cli-1',
    text: 'COMMAND_ARGUMENTS_INVALID',
  })
  const configured = appendEvent(invalid, {
    type: 'text_delta',
    runId: 'cli-2',
    text: 'Planner: supervisor. The next run will use this mode.',
  })

  assert.equal(configured.length, 2)
})

test('adjacent tool output is coalesced into one live terminal row', () => {
  const first = appendEvent([], {
    type: 'tool_update',
    runId: 'run',
    toolCallId: 'tool',
    message: 'hello',
    delta: 'hello',
    stream: 'stdout',
    bytes: 5,
  })
  const merged = appendEvent(first, {
    type: 'tool_update',
    runId: 'run',
    toolCallId: 'tool',
    message: ' world',
    delta: ' world',
    stream: 'stdout',
    bytes: 6,
  })

  assert.deepEqual(merged, [
    {
      type: 'tool_update',
      runId: 'run',
      toolCallId: 'tool',
      message: 'hello world',
      delta: 'hello world',
      stream: 'stdout',
      bytes: 11,
    },
  ])
})

test('child progress is replaced in place without evicting durable plan events', () => {
  const journal = supervisorEvent('journal', 1)
  let events = appendEvent([], journal)
  for (let sequence = 2; sequence < 2_000; sequence += 1) {
    events = appendEvent(events, supervisorEvent('child_progress', sequence))
  }

  assert.equal(events.length, 2)
  assert.equal(events[0], journal)
  assert.equal(events[1]?.type, 'supervisor_update')
  if (events[1]?.type === 'supervisor_update') {
    assert.equal(events[1].update.parentSequence, 1_999)
  }
})

function supervisorEvent(source: 'journal' | 'child_progress', parentSequence: number) {
  return {
    type: 'supervisor_update' as const,
    update: {
      schemaVersion: 1 as const,
      parentSequence,
      sessionId: 'session',
      correlation: {
        parentRunId: 'parent',
        planId: 'plan',
        stepId: 'step',
        childRunId: 'child',
      },
      source:
        source === 'journal'
          ? {
              kind: 'journal' as const,
              journalSequence: 1,
              revision: 1,
              entryId: 'entry',
              update: {
                kind: 'plan' as const,
                event: 'plan.created' as const,
                state: 'running' as const,
                objective: 'work',
              },
            }
          : {
              kind: 'child_progress' as const,
              progress: { kind: 'thinking' as const, text: `${parentSequence}`, truncated: false },
            },
    },
  }
}
