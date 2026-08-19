const MAX_LINES = 3
const MAX_CODE_POINTS = 240
const UNSAFE_CONTROL = new RegExp(
  `[${String.fromCodePoint(0)}-${String.fromCodePoint(8)}${String.fromCodePoint(11)}-${String.fromCodePoint(31)}${String.fromCodePoint(127)}-${String.fromCodePoint(159)}]`,
  'gu',
)

export type PermissionPreview =
  | { kind: 'edit'; before: string; after: string }
  | {
      kind: 'write'
      mode: 'CREATE ONLY' | 'CREATE OR REPLACE'
      content: string
    }

export function boundedPreviewText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(UNSAFE_CONTROL, '�')
  const lines = normalized.split('\n')
  let truncated = lines.length > MAX_LINES
  let visible = lines.slice(0, MAX_LINES).join('\n')
  const codePoints = [...visible]
  if (codePoints.length > MAX_CODE_POINTS) {
    visible = codePoints.slice(0, MAX_CODE_POINTS).join('')
    truncated = true
  }
  if (!visible && !truncated) return '(empty)'
  return `${visible}${truncated ? '…' : ''}`
}

export function materializePreviewTabs(text: string): string {
  return text.replace(/\t/g, '  ')
}

export function permissionPreview(request: {
  tool: string
  input: unknown
}): PermissionPreview | undefined {
  if (!isRecord(request.input)) return undefined
  if (request.tool === 'edit') {
    const { oldText, newText } = request.input
    if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined
    return {
      kind: 'edit',
      before: boundedPreviewText(oldText),
      after: boundedPreviewText(newText),
    }
  }
  if (request.tool === 'write') {
    const { content } = request.input
    if (typeof content !== 'string') return undefined
    return {
      kind: 'write',
      mode: request.input.createOnly === true ? 'CREATE ONLY' : 'CREATE OR REPLACE',
      content: boundedPreviewText(content),
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
