import { Box, Text } from 'ink'
import type { SessionEvent } from '@praxis/protocol'
import type { EditorKeybindings } from './terminalEditor.js'
import { commandSuggestionWindow, type CommandDefinition } from './commandCatalog.js'
import { materializePreviewTabs, permissionPreview } from './permissionPreview.js'
import { palette } from './theme.js'
import { editorViewport } from './tuiModel.js'

type PermissionRequest = Extract<SessionEvent, { type: 'permission_request' }>

type Props = {
  input: string
  cursorIndex: number
  isRunning: boolean
  activeRunId?: string
  pendingPermission?: PermissionRequest
  keybindings: EditorKeybindings
  spinner: string
  compact: boolean
  commandSelection: number
  editorColumns: number
  editorRows: number
  commandCatalog?: readonly CommandDefinition[]
}

export function Composer({
  input,
  cursorIndex,
  isRunning,
  activeRunId,
  pendingPermission,
  keybindings,
  spinner,
  compact,
  commandSelection,
  editorColumns,
  editorRows,
  commandCatalog = [],
}: Props) {
  if (pendingPermission) {
    return <PermissionPanel request={pendingPermission} />
  }

  const suggestions = commandSuggestionWindow(
    input,
    commandSelection,
    commandCatalog,
    compact ? 4 : 6,
  )
  const mode = activeRunId ? 'STEER' : 'PROMPT'
  const inputStatus = activeRunId
    ? `${spinner} RUNNING · INPUT ACTIVE`
    : isRunning
      ? `${spinner} WORKING · INPUT ACTIVE`
      : '● INPUT ACTIVE'

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box
        borderStyle="single"
        borderColor={isRunning ? palette.accentStrong : palette.line}
        flexDirection="column"
        paddingX={1}
      >
        <Box justifyContent="space-between">
          <Text bold color={activeRunId ? palette.amber : palette.accent}>
            {mode}
          </Text>
          <Text color={palette.mint}>{inputStatus}</Text>
        </Box>
        <EditorValue
          columns={editorColumns}
          cursorIndex={cursorIndex}
          input={input}
          maxRows={editorRows}
          placeholder={
            activeRunId
              ? 'Send a correction while the run is active…'
              : 'Describe the outcome you want…'
          }
        />
        {suggestions.total > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {suggestions.items.map((suggestion, index) => {
              const selected = suggestions.offset + index === suggestions.selected
              return (
                <Box key={suggestion.command}>
                  <Text color={selected ? palette.accent : palette.muted}>
                    {selected ? '→' : ' '} {suggestion.usage.padEnd(24)}
                  </Text>
                  {!compact ? (
                    <Text dimColor wrap="truncate-end">
                      {suggestion.description}
                    </Text>
                  ) : null}
                </Box>
              )
            })}
            {suggestions.total > suggestions.items.length ? (
              <Text color={palette.faint}>
                {suggestions.selected + 1}/{suggestions.total} · ↑↓ scroll · ENTER complete
              </Text>
            ) : null}
          </Box>
        ) : null}
      </Box>

      <ShortcutBar activeRunId={activeRunId} compact={compact} keybindings={keybindings} />
    </Box>
  )
}

function PermissionPanel({ request }: { request: PermissionRequest }) {
  const preview = permissionPreview(request)
  const riskColor =
    request.risk === 'high' ? palette.danger : request.risk === 'low' ? palette.mint : palette.amber

  return (
    <Box
      borderStyle="double"
      borderColor={riskColor}
      flexDirection="column"
      flexShrink={0}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={riskColor}>
          AUTHORIZATION REQUIRED
        </Text>
        <Text bold color={riskColor}>
          {(request.risk ?? 'medium').toUpperCase()} RISK
        </Text>
      </Box>
      <Text>
        <Text color={palette.muted}>TOOL </Text>
        <Text bold color={palette.ink}>
          {request.tool}
        </Text>
      </Text>
      {request.target ? (
        <Text wrap="truncate-middle">
          <Text color={palette.muted}>TARGET </Text>
          <Text color={palette.ink}>{request.target}</Text>
        </Text>
      ) : null}
      {preview?.kind === 'edit' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text wrap="truncate-end">
            <Text bold color={palette.danger}>
              BEFORE{' '}
            </Text>
            <Text color={palette.ink}>{materializePreviewTabs(preview.before)}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text bold color={palette.mint}>
              AFTER{'  '}
            </Text>
            <Text color={palette.ink}>{materializePreviewTabs(preview.after)}</Text>
          </Text>
        </Box>
      ) : null}
      {preview?.kind === 'write' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text bold color={palette.danger}>
              WHOLE FILE{' '}
            </Text>
            <Text color={palette.amber}>{preview.mode}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text bold color={palette.mint}>
              CONTENT{' '}
            </Text>
            <Text color={palette.ink}>{materializePreviewTabs(preview.content)}</Text>
          </Text>
        </Box>
      ) : null}
      <Box gap={2} marginTop={1}>
        <Choice hotkey="A" label="allow once" color={palette.mint} />
        <Choice hotkey="W" label="always allow" color={palette.amber} />
        <Choice hotkey="D" label="deny" color={palette.danger} />
      </Box>
    </Box>
  )
}

function ShortcutBar({
  activeRunId,
  compact,
  keybindings,
}: {
  activeRunId?: string
  compact: boolean
  keybindings: EditorKeybindings
}) {
  if (activeRunId) {
    return (
      <Box gap={2} paddingX={1}>
        <Hint keyName="ENTER" label="steer" />
        <Hint keyName="←→" label="edit" />
        <Hint keyName="CTRL+C" label="cancel" />
      </Box>
    )
  }

  return (
    <Box gap={compact ? 1 : 2} paddingX={1}>
      <Hint keyName={keybindings.submit === 'enter' ? 'ENTER' : 'CTRL+ENTER'} label="send" />
      <Hint
        keyName={keybindings.newline === 'shift-enter' ? 'SHIFT+ENTER' : 'CTRL+ENTER'}
        label="newline"
      />
      <Hint keyName="CTRL+L" label="models" />
      {!compact ? <Hint keyName="CTRL+P" label="cycle" /> : null}
      {!compact ? <Hint keyName="←→" label="edit" /> : null}
      <Hint keyName="TAB" label="complete" />
      {!compact ? <Hint keyName="CTRL+E" label="editor" /> : null}
      <Hint keyName="CTRL+C" label="exit" />
    </Box>
  )
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function EditorValue({
  input,
  cursorIndex,
  placeholder,
  columns,
  maxRows,
}: {
  input: string
  cursorIndex: number
  placeholder: string
  columns: number
  maxRows: number
}) {
  if (!input) {
    return (
      <Box>
        <Text bold color={palette.accent}>
          {'› '}
        </Text>
        <Text>
          <Text backgroundColor={palette.accent} color={palette.panel}>
            {' '}
          </Text>
          <Text dimColor> {placeholder}</Text>
        </Text>
      </Box>
    )
  }

  const viewport = editorViewport(input, cursorIndex, columns, maxRows)
  const before = viewport.value.slice(0, viewport.cursorIndex)
  const tail = viewport.value.slice(viewport.cursorIndex)
  const next = [...graphemeSegmenter.segment(tail)][0]?.segment ?? ''
  const cursorGlyph = next && next !== '\n' ? next : ' '
  const after = next === '\n' ? tail : tail.slice(next.length)

  return (
    <Box flexDirection="column">
      {viewport.hiddenAbove > 0 ? (
        <Text color={palette.faint}>↑ {viewport.hiddenAbove} editor row(s) above</Text>
      ) : null}
      <Box>
        <Text bold color={palette.accent}>
          {'› '}
        </Text>
        <Text color={palette.ink}>
          {before}
          <Text backgroundColor={palette.accent} color={palette.panel}>
            {cursorGlyph}
          </Text>
          {after}
        </Text>
      </Box>
      {viewport.hiddenBelow > 0 ? (
        <Text color={palette.faint}>↓ {viewport.hiddenBelow} editor row(s) below</Text>
      ) : null}
    </Box>
  )
}

function Choice({ hotkey, label, color }: { hotkey: string; label: string; color: string }) {
  return (
    <Text>
      <Text bold backgroundColor={color} color="#07111f">
        {' '}
        {hotkey}{' '}
      </Text>
      <Text color={palette.ink}> {label}</Text>
    </Text>
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
