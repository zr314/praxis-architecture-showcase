import { Box, Text } from 'ink'
import type { SessionEvent, SessionInfo } from '@praxis/protocol'
import { summarizeActivity } from './tuiModel.js'
import { compactCost, compactNumber, palette, shortId } from './theme.js'

type Props = {
  session: SessionInfo
  events: readonly SessionEvent[]
  width: number
  isRunning: boolean
}

export function ContextRail({ session, events, width, isRunning }: Props) {
  const activity = summarizeActivity(events, session.usage)
  const usage = activity.usage

  return (
    <Box
      borderStyle="single"
      borderColor={palette.line}
      flexDirection="column"
      paddingX={1}
      width={width}
    >
      <SectionTitle index="01">SESSION</SectionTitle>
      <Datum label="ID" value={shortId(session.sessionId, 12)} color={palette.accent} />
      <Datum label="NAME" value={session.name ?? 'untitled'} />
      <Datum
        label="STATE"
        value={(isRunning ? 'running' : session.state).toUpperCase()}
        color={palette.mint}
      />
      <Datum label="PLANNER" value={(session.plannerMode ?? 'auto').toUpperCase()} />

      <SectionTitle index="02">ENGINE</SectionTitle>
      <Datum label="PROVIDER" value={session.provider} />
      <Datum label="MODEL" value={session.model} color={palette.violet} />
      <Datum label="CONTEXT" value={compactNumber(session.contextLimitTokens)} />

      <SectionTitle index="03">TELEMETRY</SectionTitle>
      <Datum label="INPUT" value={compactNumber(usage?.inputTokens)} />
      <Datum label="OUTPUT" value={compactNumber(usage?.outputTokens)} />
      <Datum label="CACHE" value={compactNumber(usage?.cacheReadTokens)} />
      <Datum label="COST" value={compactCost(usage?.costUsd)} color={palette.amber} />

      <SectionTitle index="04">ACTIVITY</SectionTitle>
      <Datum label="PROMPTS" value={String(activity.prompts)} />
      <Datum
        label="TOOLS"
        value={
          activity.failedTools > 0
            ? `${activity.tools} / ${activity.failedTools} failed`
            : String(activity.tools)
        }
        color={activity.failedTools > 0 ? palette.danger : palette.mint}
      />
      <Datum label="ARTIFACTS" value={String(activity.artifacts)} />
      <Datum
        label="WARNINGS"
        value={String(activity.warnings)}
        color={activity.warnings > 0 ? palette.amber : palette.muted}
      />
    </Box>
  )
}

function SectionTitle({ index, children }: { index: string; children: string }) {
  return (
    <Box marginTop={1}>
      <Text bold color={palette.accent}>
        {index}
      </Text>
      <Text color={palette.faint}> ── </Text>
      <Text bold color={palette.ink}>
        {children}
      </Text>
    </Box>
  )
}

function Datum({
  label,
  value,
  color = palette.ink,
}: {
  label: string
  value: string
  color?: string
}) {
  return (
    <Box justifyContent="space-between">
      <Text color={palette.muted}>{label}</Text>
      <Text bold color={color} wrap="truncate-start">
        {value}
      </Text>
    </Box>
  )
}
