import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionEvent, SessionInfo } from '@praxis/protocol'
import { Box, renderToString } from 'ink'
import React from 'react'
import { CatalogPicker } from '../apps/cli/src/ui/CatalogPicker.js'
import { Composer } from '../apps/cli/src/ui/Composer.js'
import type { CatalogPickerState } from '../apps/cli/src/ui/catalogPickerModel.js'
import { ContextRail } from '../apps/cli/src/ui/ContextRail.js'
import { EventList } from '../apps/cli/src/ui/EventList.js'
import { Header } from '../apps/cli/src/ui/Header.js'
import { TUI_RENDER_OPTIONS } from '../apps/cli/src/ui/renderOptions.js'
import { SessionPicker } from '../apps/cli/src/ui/SessionPicker.js'
import { terminalLayout } from '../apps/cli/src/ui/tuiModel.js'

const session: SessionInfo = {
  sessionId: 's-current-session',
  state: 'idle',
  plannerMode: 'auto',
  cwd: 'D:\\praxis',
  provider: 'kimi',
  model: 'kimi-k2.6',
  messageCount: 4,
}

test('headless Ink fixtures stay bounded at 80x24, 120x30, and 160x40', () => {
  for (const [columns, rows] of [
    [80, 24],
    [120, 30],
    [160, 40],
  ] as const) {
    const layout = terminalLayout(columns, rows)
    const fixtures = [
      React.createElement(Header, {
        session,
        isRunning: true,
        activeRunId: 'r-active',
        compact: layout.compact,
        authStatus: 'authenticated',
        contextPressure: 0.82,
        pendingPermission: false,
      }),
      React.createElement(Composer, {
        input: '第一行 edit 😀\nsecond line with a logical cursor in the middle',
        cursorIndex: 13,
        isRunning: true,
        activeRunId: 'r-active',
        keybindings: {
          submit: 'enter',
          newline: 'shift-enter',
          externalEditor: 'ctrl-e',
        },
        spinner: '⠋',
        compact: layout.compact,
        commandSelection: 0,
        editorColumns: layout.composerColumns,
        editorRows: layout.editorRows,
      }),
      React.createElement(Composer, {
        input: '',
        cursorIndex: 0,
        isRunning: true,
        pendingPermission: permissionEvent(),
        keybindings: {
          submit: 'enter',
          newline: 'shift-enter',
          externalEditor: 'ctrl-e',
        },
        spinner: '⠋',
        compact: layout.compact,
        commandSelection: 0,
        editorColumns: layout.composerColumns,
        editorRows: layout.editorRows,
      }),
      React.createElement(EventList, {
        events: [
          {
            type: 'prompt_failed',
            runId: 'r-failed',
            code: 'PROVIDER_MODEL_UNAVAILABLE',
            error: 'Choose another model.',
          },
        ],
        compact: layout.compact,
      }),
      React.createElement(CatalogPicker, {
        state: modelPicker(),
        spinner: '⠋',
        compact: layout.compact,
      }),
      React.createElement(CatalogPicker, {
        state: credentialPicker(),
        spinner: '⠋',
        compact: layout.compact,
      }),
      React.createElement(SessionPicker, {
        state: sessionPicker(),
        spinner: '⠋',
        compact: layout.compact,
      }),
    ]

    for (const fixture of fixtures) {
      const output = renderToString(
        React.createElement(Box, { flexDirection: 'column', width: columns }, fixture),
        { columns },
      )
      assert.ok(output.length > 0)
      assert.ok(
        output.split('\n').every((line) => [...stripAnsi(line)].length <= columns),
        `${columns} columns:\n${output}`,
      )
    }
  }
})

test('the application transcript renders every retained event', () => {
  const output = render(
    React.createElement(EventList, {
      events: Array.from({ length: 30 }, (_, index) => ({
        type: 'text_delta' as const,
        runId: `run-${index}`,
        text: `message-${index}`,
      })),
    }),
  )

  assert.match(output, /message-0/)
  assert.match(output, /message-29/)
})

test('the TUI routes complete Ink frames through the Praxis differential renderer', () => {
  assert.deepEqual(TUI_RENDER_OPTIONS, {
    debug: true,
    exitOnCtrlC: false,
    incrementalRendering: false,
    patchConsole: false,
  })
})

test('the context rail shows the live Run state instead of stale Session idle state', () => {
  const output = render(
    React.createElement(ContextRail, { session, events: [], width: 27, isRunning: true }),
  )
  assert.match(output, /RUNNING/u)
  assert.match(output, /PLANNER\s+AUTO/u)
  assert.doesNotMatch(output, /IDLE/u)
})

test('render fixtures expose active, permission, error, model, credential, and session cues', () => {
  const layout = terminalLayout(120, 30)
  const outputs = [
    render(
      React.createElement(Header, {
        session,
        isRunning: true,
        activeRunId: 'r-active',
        compact: false,
        authStatus: 'authenticated',
        contextPressure: 0.9,
        pendingPermission: false,
      }),
    ),
    render(
      React.createElement(Composer, {
        input: '',
        cursorIndex: 0,
        isRunning: true,
        pendingPermission: permissionEvent(),
        keybindings: {
          submit: 'enter',
          newline: 'shift-enter',
          externalEditor: 'ctrl-e',
        },
        spinner: '⠋',
        compact: false,
        commandSelection: 0,
        editorColumns: layout.composerColumns,
        editorRows: layout.editorRows,
      }),
    ),
    render(
      React.createElement(CatalogPicker, { state: modelPicker(), spinner: '⠋', compact: false }),
    ),
    render(
      React.createElement(CatalogPicker, {
        state: credentialPicker(),
        spinner: '⠋',
        compact: false,
      }),
    ),
    render(
      React.createElement(SessionPicker, {
        state: sessionPicker(),
        spinner: '⠋',
        compact: false,
      }),
    ),
  ].join('\n')

  for (const cue of [
    'ACTIVE',
    'CONNECTED',
    'AUTHORIZATION REQUIRED',
    'available /',
    'CONNECT PROVIDER',
    'RESUME HISTORY',
  ]) {
    assert.match(outputs, new RegExp(cue))
  }
  assert.doesNotMatch(outputs, /fixture-secret/)
})

test('edit permission renders a safe bounded before and after preview', () => {
  const output = render(
    React.createElement(Composer, {
      input: '',
      cursorIndex: 0,
      isRunning: true,
      pendingPermission: {
        ...permissionEvent(),
        tool: 'edit',
        input: {
          oldText: 'before\u001b[31m\r\nmiddle',
          newText: 'after\nmiddle',
        },
      },
      keybindings: {
        submit: 'enter',
        newline: 'shift-enter',
        externalEditor: 'ctrl-e',
      },
      spinner: 'working',
      compact: false,
      commandSelection: 0,
      editorColumns: 100,
      editorRows: 4,
    }),
  )

  assert.match(output, /BEFORE.*before�\[31m/)
  assert.match(output, /AFTER.*after/)
  assert.equal(output.includes(`${String.fromCodePoint(27)}[31m`), false)
})

test('write permission renders a whole-file content preview', () => {
  const output = render(
    React.createElement(Composer, {
      input: '',
      cursorIndex: 0,
      isRunning: true,
      pendingPermission: {
        ...permissionEvent(),
        input: {
          content: 'first\r\nsecond',
          createOnly: true,
        },
      },
      keybindings: {
        submit: 'enter',
        newline: 'shift-enter',
        externalEditor: 'ctrl-e',
      },
      spinner: 'working',
      compact: false,
      commandSelection: 0,
      editorColumns: 100,
      editorRows: 4,
    }),
  )

  assert.match(output, /WHOLE FILE/u)
  assert.match(output, /CREATE ONLY/u)
  assert.match(output, /CONTENT.*first/u)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: verify terminal escapes are sanitized
  assert.doesNotMatch(output, /\u001b\[31m/u)
})

test('tool lifecycle renders one concise row with its target path', () => {
  const output = render(
    React.createElement(EventList, {
      events: [
        {
          type: 'tool_planning',
          runId: 'run',
          toolCallId: 'ls-one',
          name: 'ls',
          input: { path: 'D:\\praxis\\apps\\cli\\src\\ui' },
        },
        {
          type: 'tool_start',
          runId: 'run',
          toolCallId: 'ls-one',
          name: 'ls',
          input: { path: 'D:\\praxis\\apps\\cli\\src\\ui' },
        },
        {
          type: 'tool_end',
          runId: 'run',
          toolCallId: 'ls-one',
          ok: true,
          summary: 'Listed 15 entries.',
        },
      ],
    }),
  )

  assert.match(output, /✓ ls.*D:\\praxis\\apps\\cli\\src\\ui.*Listed 15 entries/)
  assert.doesNotMatch(output, /planning|started/)
})

test('failed tool rendering preserves the structured error classification', () => {
  const output = render(
    React.createElement(EventList, {
      events: [
        {
          type: 'tool_planning',
          runId: 'run',
          toolCallId: 'read-missing',
          name: 'read',
          input: { path: 'missing.txt' },
        },
        {
          type: 'tool_end',
          runId: 'run',
          toolCallId: 'read-missing',
          ok: false,
          summary: 'Target was not found.',
          error: { code: 'TOOL_TARGET_NOT_FOUND', category: 'not_found', retryable: false },
        },
      ],
    }),
  )

  assert.match(output, /\[TOOL_TARGET_NOT_FOUND\].*Target was not found/u)
})

test('agent guard termination is presented as recoverable instead of a stuck run', () => {
  const output = render(
    React.createElement(EventList, {
      events: [
        {
          type: 'prompt_failed',
          runId: 'run',
          code: 'AGENT_CONSECUTIVE_TOOL_FAILURES',
          error: 'The run stopped after the same Tool failure repeated without correction.',
        },
      ],
    }),
  )

  assert.match(output, /Run stopped \[AGENT_CONSECUTIVE_TOOL_FAILURES\]/)
  assert.match(output, /Enter a new prompt to continue/)
})

test('Workflow panel renders real node state and legacy child deadline codes', () => {
  const output = render(
    React.createElement(EventList, {
      maxRows: 12,
      columns: 100,
      events: [
        supervisorEvent(1, 'plan-1', {
          kind: 'plan',
          event: 'plan.created',
          state: 'running',
          objective: 'Inspect the workspace',
        }),
        supervisorEvent(
          2,
          'plan-1',
          {
            kind: 'step',
            event: 'step.created',
            state: 'running',
            title: 'Inspect relevant workspace context',
            order: 0,
          },
          'step-1',
        ),
        supervisorEvent(
          3,
          'plan-1',
          {
            kind: 'step',
            event: 'step.state_changed',
            state: 'failed',
            errorCode: 'CHILD_DEADLINE_EXCEEDED',
          },
          'step-1',
        ),
      ],
    }),
  )

  assert.match(output, /WORKFLOW.*plan-1.*RUNNING/su)
  assert.match(output, /Inspect relevant workspace context.*FAILED/su)
  assert.match(output, /CHILD_DEADLINE_EXCEEDED/u)
})

function render(element: React.ReactNode): string {
  return stripAnsi(renderToString(element, { columns: 120 }))
}

function permissionEvent(): Extract<SessionEvent, { type: 'permission_request' }> {
  return {
    type: 'permission_request',
    runId: 'r-active',
    requestId: 'permission-1',
    toolCallId: 'tool-1',
    tool: 'write',
    input: {},
    risk: 'high',
    target: 'D:\\praxis\\README.md',
  }
}

function supervisorEvent(
  parentSequence: number,
  planId: string,
  update: Extract<
    Extract<SessionEvent, { type: 'supervisor_update' }>['update']['source'],
    { kind: 'journal' }
  >['update'],
  stepId?: string,
): Extract<SessionEvent, { type: 'supervisor_update' }> {
  return {
    type: 'supervisor_update',
    update: {
      schemaVersion: 1,
      parentSequence,
      sessionId: 'session',
      correlation: { parentRunId: 'run', planId, ...(stepId ? { stepId } : {}) },
      source: {
        kind: 'journal',
        journalSequence: parentSequence,
        revision: parentSequence,
        entryId: `entry-${parentSequence}`,
        update,
      },
    },
  }
}

function modelPicker(): CatalogPickerState {
  return {
    status: 'ready',
    view: 'models',
    intent: 'select',
    query: '',
    providerFilter: 'kimi',
    availability: 'available',
    currentProvider: 'kimi',
    currentModel: 'kimi-k2.6',
    providers: [
      {
        id: 'kimi',
        status: 'authenticated',
        health: 'healthy',
        modelCount: 10,
      },
    ],
    models: [
      {
        catalogVersion: 1,
        provider: 'kimi',
        id: 'kimi-k2.6',
        name: 'Kimi K2.6',
        family: 'openai-chat',
        contextTokens: 262_144,
        outputTokens: 262_144,
        reasoningLevels: ['none', 'low', 'medium', 'high'],
        modalities: ['text', 'vision'],
        aliases: [],
        lifecycle: 'active',
      },
    ],
    selected: 0,
  }
}

function credentialPicker(): CatalogPickerState {
  return {
    ...modelPicker(),
    view: 'credentials',
    intent: 'login',
    credential: 'fixture-secret',
  }
}

function sessionPicker() {
  return {
    status: 'ready' as const,
    query: '',
    currentSessionId: session.sessionId,
    sessions: [
      session,
      {
        ...session,
        sessionId: 's-older',
        name: 'Older task',
        updatedAt: new Date(0).toISOString(),
      },
    ],
    selected: 0,
  }
}

function stripAnsi(value: string): string {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 27 && value[index + 1] === '[') {
      index += 2
      while (index < value.length) {
        const code = value.charCodeAt(index)
        if (code >= 0x40 && code <= 0x7e) break
        index += 1
      }
      continue
    }
    output += value[index]
  }
  return output
}
