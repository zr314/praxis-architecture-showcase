import { basename } from 'node:path'
import { Box, Text } from 'ink'
import type { AuthStatus, SessionInfo } from '@praxis/protocol'
import { palette, shortId } from './theme.js'

type Props = {
  session: SessionInfo
  isRunning: boolean
  activeRunId?: string
  compact: boolean
  authStatus?: AuthStatus
  contextPressure?: number
  pendingPermission: boolean
}

export function Header({
  session,
  isRunning,
  activeRunId,
  compact,
  authStatus,
  contextPressure,
  pendingPermission,
}: Props) {
  const status = pendingPermission ? '◆ AUTH WAIT' : isRunning ? '● ACTIVE' : '○ STANDBY'
  return (
    <Box
      borderStyle="single"
      borderColor={isRunning ? palette.accentStrong : palette.line}
      flexDirection="column"
      flexShrink={0}
    >
      <Box backgroundColor={palette.panelStrong} justifyContent="space-between" paddingX={1}>
        <Box>
          <Text bold backgroundColor={palette.accent} color="#07111f">
            {' PRAXIS '}
          </Text>
          <Text bold color={palette.ink}>
            {' // '}
            {compact ? 'CONSOLE' : 'FIELD CONSOLE'}
          </Text>
        </Box>
        <Text
          bold
          color={pendingPermission ? palette.amber : isRunning ? palette.mint : palette.muted}
        >
          {status}
        </Text>
      </Box>

      <Box paddingX={1} justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color={palette.muted}>WORKSPACE </Text>
          <Text color={palette.ink}>{basename(session.cwd) || session.cwd}</Text>
        </Text>
        <Box gap={compact ? 1 : 2}>
          <Text wrap="truncate-end">
            <Text color={palette.muted}>MODEL </Text>
            <Text color={palette.violet}>
              {session.provider}/{session.model}
            </Text>
          </Text>
          {compact ? (
            <Text color={authStatus === 'authenticated' ? palette.mint : palette.amber}>
              {authStatus === 'authenticated' ? '●' : '○'}
              {contextPressure === undefined ? '' : ` ${Math.round(contextPressure * 100)}%`}
            </Text>
          ) : null}
          {!compact ? (
            <>
              <Text>
                <Text color={palette.muted}>AUTH </Text>
                <Text color={authStatus === 'authenticated' ? palette.mint : palette.amber}>
                  {authStatus === 'authenticated' ? 'CONNECTED' : 'KEY NEEDED'}
                </Text>
              </Text>
              <Text>
                <Text color={palette.muted}>CTX </Text>
                <Text color={(contextPressure ?? 0) >= 0.8 ? palette.amber : palette.muted}>
                  {contextPressure === undefined ? '—' : `${Math.round(contextPressure * 100)}%`}
                </Text>
              </Text>
            </>
          ) : null}
          {!compact ? (
            <Text>
              <Text color={palette.muted}>RUN </Text>
              <Text color={activeRunId ? palette.accent : palette.faint}>
                {shortId(activeRunId)}
              </Text>
            </Text>
          ) : null}
        </Box>
      </Box>
    </Box>
  )
}
