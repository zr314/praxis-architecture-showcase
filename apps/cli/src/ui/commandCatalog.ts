import type { CommandCatalogSnapshotV1 } from '@praxis/protocol'

export type CommandDefinition = Readonly<{
  command: string
  usage: string
  description: string
  descriptorId: string
  descriptorDigest: string
}>

export function commandCatalogFromSnapshots(
  snapshots: readonly CommandCatalogSnapshotV1[],
): readonly CommandDefinition[] {
  const definitions: CommandDefinition[] = []
  const seen = new Set<string>()
  for (const snapshot of snapshots) {
    for (const entry of snapshot.entries) {
      const descriptor = entry.descriptor
      const names = [descriptor.command, ...entry.availableAliases]
      for (const name of names) {
        const command = `/${name}`
        if (seen.has(command)) continue
        seen.add(command)
        definitions.push(
          Object.freeze({
            command,
            usage:
              name === descriptor.command
                ? descriptor.usage
                : descriptor.usage.replace(`/${descriptor.command}`, command),
            description: descriptor.description,
            descriptorId: descriptor.id,
            descriptorDigest: descriptor.descriptorDigest,
          }),
        )
      }
    }
  }
  return Object.freeze(definitions.sort((left, right) => left.command.localeCompare(right.command)))
}

export function commandNames(catalog: readonly CommandDefinition[]): readonly string[] {
  return Object.freeze(catalog.map(({ command }) => command))
}

export function commandSuggestions(
  source: string,
  catalog: readonly CommandDefinition[],
  limit = catalog.length,
): readonly CommandDefinition[] {
  const token = source.trimStart()
  if (!token.startsWith('/') || /[\s]/u.test(token)) return []
  const query = token.toLowerCase()
  return catalog.filter(({ command }) => command.startsWith(query)).slice(0, limit)
}

export function normalizeCommandSelection(
  source: string,
  selected: number,
  catalog: readonly CommandDefinition[],
): number {
  const count = commandSuggestions(source, catalog).length
  if (count === 0) return 0
  return ((selected % count) + count) % count
}

export function moveCommandSelection(
  source: string,
  selected: number,
  offset: number,
  catalog: readonly CommandDefinition[],
): number {
  return normalizeCommandSelection(source, selected + offset, catalog)
}

export function selectedCommandSuggestion(
  source: string,
  selected: number,
  catalog: readonly CommandDefinition[],
): CommandDefinition | undefined {
  const suggestions = commandSuggestions(source, catalog)
  return suggestions[normalizeCommandSelection(source, selected, catalog)]
}

export function commandSuggestionWindow(
  source: string,
  selected: number,
  catalog: readonly CommandDefinition[],
  limit = 6,
): {
  items: readonly CommandDefinition[]
  offset: number
  selected: number
  total: number
} {
  const suggestions = commandSuggestions(source, catalog)
  const normalized = normalizeCommandSelection(source, selected, catalog)
  if (suggestions.length <= limit) {
    return { items: suggestions, offset: 0, selected: normalized, total: suggestions.length }
  }
  const half = Math.floor(limit / 2)
  const offset = Math.min(Math.max(0, normalized - half), suggestions.length - limit)
  return {
    items: suggestions.slice(offset, offset + limit),
    offset,
    selected: normalized,
    total: suggestions.length,
  }
}
