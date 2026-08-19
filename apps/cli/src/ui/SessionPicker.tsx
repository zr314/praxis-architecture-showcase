import { basename } from 'node:path'
import { Box, Text } from 'ink'
import type { SessionInfo } from '@praxis/protocol'
import { pickerWindow } from './catalogPickerModel.js'
import { palette, shortId } from './theme.js'

export type SessionPickerState =
  | {
      status: 'loading'
      query: string
      currentSessionId: string
      notice?: string
    }
  | {
      status: 'ready'
      query: string
      currentSessionId: string
      sessions: SessionInfo[]
      selected: number
      confirmingSessionId?: string
      notice?: string
    }

export function visibleSessions(
  state: Extract<SessionPickerState, { status: 'ready' }>,
): SessionInfo[] {
  const query = state.query.trim().toLowerCase()
  return state.sessions
    .filter((session) => {
      if (!query) return true
      const source = [
        session.sessionId,
        session.name,
        session.cwd,
        session.provider,
        session.model,
        ...(session.labels ?? []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return query.split(/\s+/).every((term) => source.includes(term))
    })
    .sort(
      (left, right) =>
        Number(right.sessionId === state.currentSessionId) -
          Number(left.sessionId === state.currentSessionId) ||
        (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '') ||
        left.sessionId.localeCompare(right.sessionId),
    )
}

export function updateSessionQuery(state: SessionPickerState, query: string): SessionPickerState {
  return state.status === 'ready'
    ? {
        ...state,
        query,
        selected: 0,
        confirmingSessionId: undefined,
        notice: undefined,
      }
    : { ...state, query }
}

export function moveSessionSelection(
  state: Extract<SessionPickerState, { status: 'ready' }>,
  movement: 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end',
  pageSize?: number,
): Extract<SessionPickerState, { status: 'ready' }>
export function moveSessionSelection(
  state: SessionPickerState,
  movement: 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end',
  pageSize?: number,
): SessionPickerState
export function moveSessionSelection(
  state: SessionPickerState,
  movement: 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end',
  pageSize = 8,
): SessionPickerState {
  if (state.status !== 'ready') return state
  const count = visibleSessions(state).length
  if (count === 0) return { ...state, selected: 0 }
  const offset =
    movement === 'up'
      ? -1
      : movement === 'down'
        ? 1
        : movement === 'pageUp'
          ? -pageSize
          : movement === 'pageDown'
            ? pageSize
            : 0
  const selected =
    movement === 'home'
      ? 0
      : movement === 'end'
        ? count - 1
        : Math.min(count - 1, Math.max(0, state.selected + offset))
  return {
    ...state,
    selected,
    confirmingSessionId: undefined,
    notice: undefined,
  }
}

export function selectedSession(state: SessionPickerState): SessionInfo | undefined {
  return state.status === 'ready' ? visibleSessions(state)[state.selected] : undefined
}

export function SessionPicker({
  state,
  compact,
  spinner,
}: {
  state: SessionPickerState
  compact: boolean
  spinner: string
}) {
  return (
    <Box
      borderStyle="double"
      borderColor={palette.accentStrong}
      flexDirection="column"
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Box>
          <Text bold backgroundColor={palette.accent} color="#07111f">
            {' SESSIONS '}
          </Text>
          <Text bold color={palette.ink}>
            {'  '}RESUME HISTORY
          </Text>
        </Box>
        <Text color={palette.muted}>CURRENT {shortId(state.currentSessionId, 12)}</Text>
      </Box>
      {state.status === 'loading' ? (
        <Box marginY={1}>
          <Text color={palette.mint}>{spinner} LOADING SESSION INDEX…</Text>
        </Box>
      ) : (
        <ReadySessionPicker compact={compact} state={state} />
      )}
      {state.notice ? (
        <Box marginTop={1}>
          <Text color={palette.amber}>◆ {state.notice}</Text>
        </Box>
      ) : null}
      <Box gap={compact ? 1 : 2} marginTop={1}>
        <Hint keyName="TYPE" label="search" />
        <Hint keyName="↑↓ / PG" label="navigate" />
        <Hint keyName="HOME/END" label="edges" />
        <Hint keyName="ENTER" label="resume" />
        <Hint keyName="ESC" label="back" />
      </Box>
    </Box>
  )
}

function ReadySessionPicker({
  state,
  compact,
}: {
  state: Extract<SessionPickerState, { status: 'ready' }>
  compact: boolean
}) {
  const sessions = visibleSessions(state)
  const window = pickerWindow(sessions, state.selected, compact ? 6 : 10)
  return (
    <>
      <Box marginTop={1}>
        <Text bold color={palette.accent}>
          SEARCH ›{' '}
        </Text>
        <Text color={state.query ? palette.ink : palette.muted}>
          {state.query || 'name, workspace, label, or session id…'}
          <Text backgroundColor={palette.accent} color={palette.panel}>
            {' '}
          </Text>
        </Text>
      </Box>
      {sessions.length === 0 ? (
        <Box marginY={1}>
          <Text color={palette.amber}>No matching sessions. Backspace clears the search.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {window.items.map((session, index) => {
            const absolute = window.offset + index
            const selected = absolute === state.selected
            const current = session.sessionId === state.currentSessionId
            return (
              <Box
                backgroundColor={selected ? palette.panelStrong : undefined}
                key={session.sessionId}
                paddingX={1}
              >
                <Text bold color={selected ? palette.accent : palette.faint}>
                  {selected ? '›' : ' '}
                </Text>
                <Box marginLeft={1} width={compact ? 24 : 34}>
                  <Text bold color={selected ? palette.ink : palette.muted} wrap="truncate-end">
                    {session.name ?? shortId(session.sessionId, compact ? 18 : 28)}
                  </Text>
                </Box>
                <Box width={compact ? 20 : 28}>
                  <Text color={palette.violet} wrap="truncate-end">
                    {session.provider}/{session.model}
                  </Text>
                </Box>
                {!compact ? (
                  <Box width={22}>
                    <Text color={palette.muted} wrap="truncate-end">
                      {basename(session.cwd) || session.cwd}
                    </Text>
                  </Box>
                ) : null}
                {current ? (
                  <Text bold color={palette.mint}>
                    CURRENT
                  </Text>
                ) : null}
              </Box>
            )
          })}
          <Text color={palette.faint}>
            {state.selected + 1}/{sessions.length} · {sessions.length} matching /{' '}
            {state.sessions.length} total
          </Text>
        </Box>
      )}
    </>
  )
}

function Hint({ keyName, label }: { keyName: string; label: string }) {
  return (
    <Text>
      <Text color={palette.ink}>{keyName}</Text>
      <Text color={palette.muted}> {label}</Text>
    </Text>
  )
}
