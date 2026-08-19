import { Box, Text } from 'ink'
import { memo, useMemo } from 'react'
import { palette } from './theme.js'

type MarkdownBlock =
  | { type: 'code'; language?: string; source: string }
  | { type: 'prose'; source: string }

export const MarkdownText = memo(function MarkdownText({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(source), [source])
  return (
    <Box flexDirection="column">
      {blocks.map((block, index) =>
        block.type === 'code' ? (
          <CodeBlock key={`${index}-code`} language={block.language} source={block.source} />
        ) : (
          <Prose key={`${index}-prose`} source={block.source} />
        ),
      )}
    </Box>
  )
})

export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const matcher = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g
  let cursor = 0
  for (const match of source.matchAll(matcher)) {
    const index = match.index ?? 0
    if (index > cursor) blocks.push({ type: 'prose', source: source.slice(cursor, index) })
    const language = match[1]?.trim()
    blocks.push({
      type: 'code',
      ...(language ? { language } : {}),
      source: (match[2] ?? '').replace(/\n$/, ''),
    })
    cursor = index + match[0].length
  }
  if (cursor < source.length) blocks.push({ type: 'prose', source: source.slice(cursor) })
  if (blocks.length === 0) blocks.push({ type: 'prose', source })
  return blocks
}

function CodeBlock({ source, language }: { source: string; language?: string }) {
  const lines = source.split('\n')
  return (
    <Box borderStyle="single" borderColor={palette.line} flexDirection="column" marginY={1}>
      <Box backgroundColor={palette.panelStrong} paddingX={1}>
        <Text bold color={palette.violet}>
          CODE
        </Text>
        {language ? <Text color={palette.muted}> · {language.toUpperCase()}</Text> : null}
      </Box>
      <Box flexDirection="column" paddingX={1}>
        {lines.map((line, index) => (
          <Text
            key={`${index}-${line}`}
            color={
              line.startsWith('+')
                ? palette.mint
                : line.startsWith('-')
                  ? palette.danger
                  : palette.ink
            }
          >
            <Text color={palette.faint}>{String(index + 1).padStart(3)} │ </Text>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

function Prose({ source }: { source: string }) {
  return (
    <>
      {source.split('\n').map((line, index) => (
        <ProseLine key={`${index}-${line}`} line={line} />
      ))}
    </>
  )
}

function ProseLine({ line }: { line: string }) {
  const heading = line.match(/^(#{1,6})\s+(.+)$/)
  if (heading) {
    return (
      <Text bold color={palette.accent}>
        {'◆ '}
        <InlineText source={heading[2] ?? ''} />
      </Text>
    )
  }
  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    return <Text color={palette.faint}>────────────────────────────────────────</Text>
  }
  const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/)
  if (bullet) {
    return (
      <Text color={palette.ink}>
        {bullet[1]}
        <Text color={palette.accent}>• </Text>
        <InlineText source={bullet[2] ?? ''} />
      </Text>
    )
  }
  const quote = line.match(/^>\s?(.*)$/)
  if (quote) {
    return (
      <Text italic color={palette.muted}>
        <Text color={palette.violet}>│ </Text>
        <InlineText source={quote[1] ?? ''} />
      </Text>
    )
  }
  return (
    <Text color={palette.ink} wrap="wrap">
      <InlineText source={line} />
    </Text>
  )
}

function InlineText({ source }: { source: string }) {
  const fragments = source.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).filter(Boolean)
  return (
    <>
      {fragments.map((fragment, index) => {
        if (fragment.startsWith('`') && fragment.endsWith('`')) {
          return (
            <Text key={index} backgroundColor={palette.panelStrong} color={palette.amber}>
              {' '}
              {fragment.slice(1, -1)}{' '}
            </Text>
          )
        }
        if (fragment.startsWith('**') && fragment.endsWith('**')) {
          return (
            <Text bold key={index} color={palette.ink}>
              {fragment.slice(2, -2)}
            </Text>
          )
        }
        return fragment
      })}
    </>
  )
}
