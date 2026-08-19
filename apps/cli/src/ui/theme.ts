export const palette = {
  ink: '#dbeafe',
  muted: '#64748b',
  faint: '#334155',
  line: '#243247',
  panel: '#101827',
  panelStrong: '#162235',
  accent: '#67e8f9',
  accentStrong: '#22d3ee',
  mint: '#5eead4',
  amber: '#fbbf24',
  danger: '#fb7185',
  violet: '#c4b5fd',
} as const

export function shortId(value: string | undefined, length = 8): string {
  if (!value) return '—'
  return value.length <= length ? value : value.slice(0, length)
}

export function compactNumber(value: number | undefined): string {
  if (value === undefined) return '—'
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`
}

export function compactCost(value: number | undefined): string {
  if (value === undefined) return '—'
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}
