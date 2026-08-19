import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { runtimeError, type PromptPersistence } from '@praxis/core-sdk'

const MAX_RESOURCE_BYTES = 64 * 1024
const MAX_DISCOVERY_DEPTH = 8
const MAX_RESOURCES = 256
const MAX_FRONTMATTER_LINES = 128
const MAX_METADATA_ENTRIES = 64
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const AUTHORITY_FIELD =
  /^(?:allowed-tools?|commands?|credentials?|environment|filesystem|hooks?|mcp|model|network|permissions?|process|provider|reasoning|scripts?|shell|tools?)$/i

export type ResourceKind = 'skill' | 'template' | 'theme'
export type ResourceSourceType = 'project' | 'plugin' | 'bundled'
export type ResourceMetadataValue = string | number | boolean | null
export type SkillMetadata = {
  license?: string
  compatibility?: string
  values: Record<string, ResourceMetadataValue>
  disableModelInvocation: boolean
}
export type ResourceProvenance = {
  origin: string
  digest: `sha256:${string}`
  trusted: boolean
  sourceType: ResourceSourceType
}
export type DiscoveredResource = {
  id: string
  localId: string
  name: string
  description: string
  kind: ResourceKind
  path: string
  relativeRoot: string
  provenance: ResourceProvenance
  metadata: SkillMetadata
  enabled: boolean
  collision: boolean
}

export type ResourceCollision = {
  id: string
  origins: string[]
  paths: string[]
}

export type RejectedResource = {
  path: string
  code: string
}

export type ResourceDeclaration = {
  id: string
  kind: ResourceKind
  path: string
}

export type ResourceDiscoverySource = {
  path: string
  origin: string
  sourceType: ResourceSourceType
  trusted: boolean
  namespace?: string
  declarations?: readonly ResourceDeclaration[]
}

export type ResourceSelection = {
  id: string
  origin: string
  digest: `sha256:${string}`
}

export interface ResourceSelectionStore {
  load(workspace: string): Promise<ResourceSelection[]>
  save(workspace: string, selections: readonly ResourceSelection[]): Promise<void>
}

export type SnapshotSkill = {
  id: string
  localId: string
  name: string
  description: string
  origin: string
  digest: `sha256:${string}`
  disableModelInvocation: boolean
  content: string
}

export type SnapshotTemplate = {
  id: string
  localId: string
  name: string
  description: string
  origin: string
  digest: `sha256:${string}`
  content: string
  parameters: readonly Readonly<{ name: string; required: boolean; maxBytes: number }>[]
  acceptsBody: boolean
  persistence: PromptPersistence
}

export type TurnResourceSnapshot = Readonly<{
  id: string
  workspace: string
  skills: readonly Readonly<SnapshotSkill>[]
  /** Parent Runtime prompt resources; child capability transport deliberately ignores this field. */
  templates?: readonly Readonly<SnapshotTemplate>[]
}>

type StoredResource = DiscoveredResource & { content: string }
type WorkspaceCatalog = {
  resources: Map<string, StoredResource[]>
  selections: ResourceSelection[]
  rejected: RejectedResource[]
}

class MemoryResourceSelectionStore implements ResourceSelectionStore {
  readonly #workspaces = new Map<string, ResourceSelection[]>()

  async load(workspace: string): Promise<ResourceSelection[]> {
    return structuredClone(this.#workspaces.get(workspace) ?? [])
  }

  async save(workspace: string, selections: readonly ResourceSelection[]): Promise<void> {
    this.#workspaces.set(workspace, structuredClone([...selections]))
  }
}

/** Persists only immutable resource identities; resource contents remain in their source stores. */
export class FileResourceSelectionStore implements ResourceSelectionStore {
  readonly #directory: string

  constructor(root: string) {
    this.#directory = join(root, 'resources', 'workspaces')
  }

  async load(workspace: string): Promise<ResourceSelection[]> {
    try {
      const value = JSON.parse(await readFile(this.#path(workspace), 'utf8')) as unknown
      if (!isSelectionFile(value)) throw new SyntaxError('Invalid resource selection file.')
      return structuredClone(value.selections)
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
  }

  async save(workspace: string, selections: readonly ResourceSelection[]): Promise<void> {
    if (!selections.every(isResourceSelection)) {
      throw new TypeError('Invalid resource selection.')
    }
    await mkdir(this.#directory, { recursive: true })
    const path = this.#path(workspace)
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, workspace, selections }, undefined, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    )
    await rename(temporary, path)
  }

  #path(workspace: string): string {
    const digest = createHash('sha256').update(workspace).digest('hex')
    return join(this.#directory, `${digest}.json`)
  }
}

/** Runtime-owned bounded catalog. Discovery never imports or executes resource content. */
export class ResourceCatalog {
  readonly #workspaces = new Map<string, WorkspaceCatalog>()

  constructor(
    private readonly selections: ResourceSelectionStore = new MemoryResourceSelectionStore(),
  ) {}

  async refresh(
    workspace: string,
    sources: readonly ResourceDiscoverySource[],
  ): Promise<{
    resources: DiscoveredResource[]
    collisions: ResourceCollision[]
    rejected: RejectedResource[]
  }> {
    const canonicalWorkspace = await realpath(workspace)
    const catalog: WorkspaceCatalog = {
      resources: new Map(),
      selections: await this.selections.load(canonicalWorkspace),
      rejected: [],
    }
    for (const source of sources.slice(0, MAX_RESOURCES)) {
      if (resourceCount(catalog.resources) >= MAX_RESOURCES) break
      await this.#discoverSource(catalog, source)
    }
    applySelections(catalog)
    this.#workspaces.set(canonicalWorkspace, catalog)
    return {
      resources: this.list(canonicalWorkspace),
      collisions: collisions(catalog.resources),
      rejected: structuredClone(catalog.rejected),
    }
  }

  list(workspace: string, kind?: ResourceKind): DiscoveredResource[] {
    const catalog = this.#requireWorkspace(workspace)
    return [...catalog.resources.values()]
      .flat()
      .filter((resource) => kind === undefined || resource.kind === kind)
      .map(publicResource)
      .sort((left, right) =>
        left.id === right.id
          ? left.provenance.origin.localeCompare(right.provenance.origin)
          : left.id.localeCompare(right.id),
      )
  }

  inspect(
    workspace: string,
    id: string,
    options: { includeContent?: boolean } = {},
  ): DiscoveredResource & { content?: string } {
    const resource = this.#requireUnique(workspace, id)
    return {
      ...publicResource(resource),
      ...(options.includeContent ? { content: resource.content } : {}),
    }
  }

  async enable(
    workspace: string,
    id: string,
    options: { projectTrusted?: boolean } = {},
  ): Promise<DiscoveredResource> {
    const canonicalWorkspace = await realpath(workspace)
    const catalog = this.#requireWorkspace(canonicalWorkspace)
    const resource = this.#requireUnique(canonicalWorkspace, id)
    if (resource.provenance.sourceType === 'project' && options.projectTrusted !== true) {
      throw resourceError(
        'RESOURCE_TRUST_REQUIRED',
        'Project resource activation requires explicit project trust.',
      )
    }
    if (resource.provenance.sourceType !== 'project' && !resource.provenance.trusted) {
      throw resourceError(
        'RESOURCE_TRUST_REQUIRED',
        'Resource activation requires a trusted installation source.',
      )
    }
    const selection: ResourceSelection = {
      id,
      origin: resource.provenance.origin,
      digest: resource.provenance.digest,
    }
    catalog.selections = [
      ...catalog.selections.filter((candidate) => candidate.id !== id),
      selection,
    ]
    resource.enabled = true
    await this.selections.save(canonicalWorkspace, catalog.selections)
    return publicResource(resource)
  }

  async disable(workspace: string, id: string): Promise<void> {
    const canonicalWorkspace = await realpath(workspace)
    const catalog = this.#requireWorkspace(canonicalWorkspace)
    const matches = catalog.resources.get(id)
    const selected = catalog.selections.some((selection) => selection.id === id)
    if ((!matches || matches.length === 0) && !selected) {
      throw resourceError('RESOURCE_NOT_FOUND', 'Resource was not found.')
    }
    for (const resource of matches ?? []) resource.enabled = false
    catalog.selections = catalog.selections.filter((selection) => selection.id !== id)
    await this.selections.save(canonicalWorkspace, catalog.selections)
  }

  snapshot(workspace: string): TurnResourceSnapshot {
    const canonical = resolve(workspace)
    const skills = this.list(canonical, 'skill')
      .filter((resource) => resource.enabled)
      .map((resource) => {
        const stored = this.#requireUnique(canonical, resource.id)
        return Object.freeze({
          id: stored.id,
          localId: stored.localId,
          name: stored.name,
          description: stored.description,
          origin: stored.provenance.origin,
          digest: stored.provenance.digest,
          disableModelInvocation: stored.metadata.disableModelInvocation,
          content: stored.content,
        })
      })
    const templates = this.list(canonical, 'template')
      .filter((resource) => resource.enabled)
      .map((resource) => {
        const stored = this.#requireUnique(canonical, resource.id)
        const template = parseTemplateFrontmatter(stored.content)
        return Object.freeze({
          id: stored.id,
          localId: stored.localId,
          name: stored.name,
          description: stored.description,
          origin: stored.provenance.origin,
          digest: stored.provenance.digest,
          content: template.content,
          parameters: Object.freeze(
            template.parameters.map((parameter) => Object.freeze(parameter)),
          ),
          acceptsBody: template.acceptsBody,
          persistence: template.persistence,
        })
      })
    const identity = JSON.stringify({
      skills: skills.map(({ id, origin, digest }) => ({ id, origin, digest })),
      templates: templates.map(({ id, origin, digest }) => ({ id, origin, digest })),
    })
    return Object.freeze({
      id: `resources-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`,
      workspace: canonical,
      skills: Object.freeze(skills),
      templates: Object.freeze(templates),
    })
  }

  async #discoverSource(catalog: WorkspaceCatalog, source: ResourceDiscoverySource): Promise<void> {
    let root: string
    try {
      root = await realpath(source.path)
      if (!(await lstat(root)).isDirectory()) return
    } catch (error) {
      if (isNotFound(error)) return
      throw error
    }
    if (source.declarations) {
      for (const declaration of source.declarations) {
        if (resourceCount(catalog.resources) >= MAX_RESOURCES) return
        const candidate = resolve(root, declaration.path)
        if (!isInside(root, candidate)) {
          catalog.rejected.push({ path: candidate, code: 'RESOURCE_PATH_INVALID' })
          continue
        }
        await this.#readCandidate(catalog, root, candidate, source, declaration)
      }
      return
    }
    await this.#walk(catalog, root, root, source, 0)
  }

  async #walk(
    catalog: WorkspaceCatalog,
    root: string,
    directory: string,
    source: ResourceDiscoverySource,
    depth: number,
  ): Promise<void> {
    if (depth > MAX_DISCOVERY_DEPTH || resourceCount(catalog.resources) >= MAX_RESOURCES) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) continue
      if (metadata.isDirectory()) {
        await this.#walk(catalog, root, path, source, depth + 1)
        continue
      }
      const kind = resourceKind(entry.name)
      if (!kind) continue
      await this.#readCandidate(catalog, root, path, source, { kind, path: '', id: '' })
    }
  }

  async #readCandidate(
    catalog: WorkspaceCatalog,
    root: string,
    path: string,
    source: ResourceDiscoverySource,
    declaration: ResourceDeclaration,
  ): Promise<void> {
    try {
      if (resourceKind(basename(path)) !== declaration.kind) {
        catalog.rejected.push({ path, code: 'RESOURCE_KIND_MISMATCH' })
        return
      }
      const metadata = await lstat(path)
      if (
        metadata.isSymbolicLink() ||
        !metadata.isFile() ||
        metadata.size < 1 ||
        metadata.size > MAX_RESOURCE_BYTES
      ) {
        catalog.rejected.push({ path, code: 'RESOURCE_FILE_INVALID' })
        return
      }
      const canonical = await realpath(path)
      if (!isInside(root, canonical)) {
        catalog.rejected.push({ path, code: 'RESOURCE_PATH_INVALID' })
        return
      }
      const content = await readFile(canonical, 'utf8')
      const kind = declaration.kind
      const header =
        kind === 'skill'
          ? parseSkillFrontmatter(content)
          : kind === 'template'
            ? parseTemplateFrontmatter(content)
            : parseDescriptiveHeader(content)
      const localId = declaration.id || normalizedName(header.name)
      const id = source.namespace
        ? kind === 'skill'
          ? `${source.namespace}/${localId}`
          : `${source.namespace}/${kind}/${localId}`
        : `${kind}:${localId}`
      const resource: StoredResource = {
        id,
        localId,
        name: header.name,
        description: header.description,
        kind,
        path: canonical,
        relativeRoot: slash(relative(root, dirname(canonical))) || '.',
        provenance: {
          origin: source.origin,
          digest: digest(content),
          trusted: source.trusted,
          sourceType: source.sourceType,
        },
        metadata: header.metadata,
        enabled: false,
        collision: false,
        content,
      }
      const matches = catalog.resources.get(id) ?? []
      matches.push(resource)
      if (matches.length > 1) {
        for (const candidate of matches) candidate.collision = true
      }
      catalog.resources.set(id, matches)
    } catch (error) {
      if (isRuntimeResourceError(error)) {
        catalog.rejected.push({ path, code: error.code })
        return
      }
      if (isNotFound(error)) {
        catalog.rejected.push({ path, code: 'RESOURCE_NOT_FOUND' })
        return
      }
      throw error
    }
  }

  #requireWorkspace(workspace: string): WorkspaceCatalog {
    const catalog = this.#workspaces.get(resolve(workspace))
    if (!catalog) {
      throw resourceError('RESOURCE_CATALOG_NOT_LOADED', 'Resource catalog is not loaded.')
    }
    return catalog
  }

  #requireUnique(workspace: string, id: string): StoredResource {
    const matches = this.#requireWorkspace(workspace).resources.get(id)
    if (!matches || matches.length === 0) {
      throw resourceError('RESOURCE_NOT_FOUND', 'Resource was not found.')
    }
    if (matches.length > 1) {
      throw resourceError('RESOURCE_ID_COLLISION', 'Resource identity is ambiguous.')
    }
    return matches[0]!
  }
}

/** @deprecated Use ResourceCatalog. */
export { ResourceCatalog as ResourceRegistry }

function parseSkillFrontmatter(content: string): {
  name: string
  description: string
  metadata: SkillMetadata
} {
  const parsed = parseFrontmatter(content)
  if (
    typeof parsed.name !== 'string' ||
    !SKILL_NAME_PATTERN.test(parsed.name) ||
    typeof parsed.description !== 'string' ||
    parsed.description.length === 0 ||
    Buffer.byteLength(parsed.description, 'utf8') > 1_024
  ) {
    throw resourceError('SKILL_FRONTMATTER_INVALID', 'Skill name or description is invalid.')
  }
  const disabled = parsed['disable-model-invocation']
  if (disabled !== undefined && typeof disabled !== 'boolean') {
    throw resourceError('SKILL_FRONTMATTER_INVALID', 'disable-model-invocation must be a boolean.')
  }
  if (
    (parsed.license !== undefined && typeof parsed.license !== 'string') ||
    (parsed.compatibility !== undefined && typeof parsed.compatibility !== 'string') ||
    (parsed.metadata !== undefined && !isMetadataRecord(parsed.metadata))
  ) {
    throw resourceError('SKILL_FRONTMATTER_INVALID', 'Skill descriptive metadata is invalid.')
  }
  const values = isMetadataRecord(parsed.metadata) ? parsed.metadata : {}
  for (const [key, value] of Object.entries(parsed)) {
    if (
      [
        'name',
        'description',
        'license',
        'compatibility',
        'metadata',
        'disable-model-invocation',
      ].includes(key)
    ) {
      continue
    }
    if (AUTHORITY_FIELD.test(key) || !isMetadataValue(value)) {
      throw resourceError(
        'SKILL_FRONTMATTER_UNSUPPORTED',
        'Skill frontmatter contains an unsupported authority-bearing field.',
      )
    }
    values[key] = value
  }
  if (Object.keys(values).length > MAX_METADATA_ENTRIES) {
    throw resourceError('SKILL_FRONTMATTER_INVALID', 'Skill metadata is too large.')
  }
  return {
    name: parsed.name,
    description: parsed.description,
    metadata: {
      ...(typeof parsed.license === 'string' ? { license: parsed.license.slice(0, 256) } : {}),
      ...(typeof parsed.compatibility === 'string'
        ? { compatibility: parsed.compatibility.slice(0, 512) }
        : {}),
      values: { ...values },
      disableModelInvocation: disabled === true,
    },
  }
}

function parseDescriptiveHeader(content: string): {
  name: string
  description: string
  metadata: SkillMetadata
} {
  const parsed = parseFrontmatter(content)
  const name =
    typeof parsed.name === 'string' && parsed.name.length > 0
      ? parsed.name.slice(0, 128)
      : 'resource'
  const description =
    typeof parsed.description === 'string' && parsed.description.length > 0
      ? parsed.description.slice(0, 1_024)
      : 'Data resource'
  return {
    name,
    description,
    metadata: { values: {}, disableModelInvocation: false },
  }
}

function parseTemplateFrontmatter(content: string): {
  name: string
  description: string
  metadata: SkillMetadata
  content: string
  parameters: Array<{ name: string; required: boolean; maxBytes: number }>
  acceptsBody: boolean
  persistence: PromptPersistence
} {
  const parsed = parseFrontmatter(content, 'TEMPLATE_FRONTMATTER_INVALID')
  if (
    !Object.keys(parsed).every((key) =>
      ['name', 'description', 'arguments', 'persistence'].includes(key),
    ) ||
    typeof parsed.name !== 'string' ||
    parsed.name.length < 1 ||
    Buffer.byteLength(parsed.name, 'utf8') > 128 ||
    typeof parsed.description !== 'string' ||
    parsed.description.length < 1 ||
    Buffer.byteLength(parsed.description, 'utf8') > 1_024 ||
    (parsed.arguments !== undefined && typeof parsed.arguments !== 'string') ||
    (parsed.persistence !== undefined &&
      !['plaintext', 'redacted', 'digest', 'none'].includes(String(parsed.persistence)))
  ) {
    throw resourceError('TEMPLATE_FRONTMATTER_INVALID', 'Prompt template metadata is invalid.')
  }
  const parameters = parseTemplateParameters((parsed.arguments as string | undefined) ?? '')
  const templateBody = resourceBody(content)
  if (templateBody.length < 1 || Buffer.byteLength(templateBody, 'utf8') > 32_768) {
    throw resourceError('TEMPLATE_CONTENT_INVALID', 'Prompt template content is invalid.')
  }
  const acceptsBody = /\{\{\s*body\s*\}\}/u.test(templateBody)
  const allowed = new Set([...parameters.map(({ name }) => name), ...(acceptsBody ? ['body'] : [])])
  const placeholderPattern = /\{\{\s*([^\r\n{}]{1,128}?)\s*\}\}/gu
  for (const match of templateBody.matchAll(placeholderPattern)) {
    const placeholder = match[1]!.trim()
    if (!/^[a-z][a-zA-Z0-9_]{0,63}$/u.test(placeholder) || !allowed.has(placeholder)) {
      throw resourceError(
        'TEMPLATE_PLACEHOLDER_INVALID',
        'Prompt template contains an undeclared placeholder.',
      )
    }
  }
  const textWithoutPlaceholders = templateBody.replace(placeholderPattern, '')
  if (textWithoutPlaceholders.includes('{{') || textWithoutPlaceholders.includes('}}')) {
    throw resourceError(
      'TEMPLATE_PLACEHOLDER_INVALID',
      'Prompt template contains an invalid placeholder.',
    )
  }
  const persistence = (parsed.persistence ?? 'plaintext') as PromptPersistence
  return {
    name: parsed.name,
    description: parsed.description,
    metadata: {
      values: {
        arguments: (parsed.arguments as string | undefined) ?? '',
        persistence,
      },
      disableModelInvocation: false,
    },
    content: templateBody,
    parameters,
    acceptsBody,
    persistence,
  }
}

function parseTemplateParameters(source: string): Array<{
  name: string
  required: boolean
  maxBytes: number
}> {
  if (source.trim().length === 0) return []
  const tokens = source.split(',').map((value) => value.trim())
  if (tokens.length > 8 || tokens.some((value) => value.length === 0)) {
    throw resourceError('TEMPLATE_ARGUMENTS_INVALID', 'Prompt template arguments are invalid.')
  }
  const parameters = tokens.map((token) => {
    const match = /^([a-z][a-zA-Z0-9_]{0,63})(\?)?$/u.exec(token)
    if (!match) {
      throw resourceError('TEMPLATE_ARGUMENTS_INVALID', 'Prompt template arguments are invalid.')
    }
    return { name: match[1]!, required: match[2] !== '?', maxBytes: 4_096 }
  })
  if (
    new Set(parameters.map(({ name }) => name)).size !== parameters.length ||
    parameters.some(
      (parameter, index) =>
        parameter.required && parameters.slice(0, index).some((candidate) => !candidate.required),
    )
  ) {
    throw resourceError('TEMPLATE_ARGUMENTS_INVALID', 'Prompt template arguments are invalid.')
  }
  return parameters
}

function resourceBody(content: string): string {
  const lines = content.replaceAll('\r\n', '\n').split('\n')
  const end = lines.indexOf('---', 1)
  return lines
    .slice(end + 1)
    .join('\n')
    .trim()
}

function parseFrontmatter(
  content: string,
  errorCode = 'SKILL_FRONTMATTER_INVALID',
): Record<string, unknown> {
  const lines = content.replaceAll('\r\n', '\n').split('\n')
  if (lines[0] !== '---') {
    throw resourceError(errorCode, 'Resource frontmatter is required.')
  }
  const end = lines.indexOf('---', 1)
  if (end < 1 || end > MAX_FRONTMATTER_LINES) {
    throw resourceError(errorCode, 'Resource frontmatter is not bounded.')
  }
  const result: Record<string, unknown> = {}
  let metadata: Record<string, ResourceMetadataValue> | undefined
  for (const line of lines.slice(1, end)) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const indented = /^ {2}([A-Za-z0-9._-]+):(?: (.*))?$/.exec(line)
    if (indented) {
      if (!metadata) {
        throw resourceError(errorCode, 'Nested frontmatter is only allowed in metadata.')
      }
      metadata[indented[1]!] = scalar(indented[2] ?? '', errorCode)
      continue
    }
    metadata = undefined
    const field = /^([A-Za-z0-9._-]+):(?: (.*))?$/.exec(line)
    if (!field) {
      throw resourceError(errorCode, 'Unsupported frontmatter syntax.')
    }
    const key = field[1]!
    if (Object.hasOwn(result, key)) {
      throw resourceError(errorCode, 'Duplicate frontmatter field.')
    }
    if (key === 'metadata' && (field[2] ?? '') === '') {
      metadata = {}
      result.metadata = metadata
      continue
    }
    result[key] = scalar(field[2] ?? '', errorCode)
  }
  return result
}

function scalar(value: string, errorCode: string): ResourceMetadataValue {
  const trimmed = value.trim()
  if (trimmed.length > 1_024) {
    throw resourceError(errorCode, 'Frontmatter value is too large.')
  }
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  const quoted = /^(["'])(.*)\1$/u.exec(trimmed)
  return quoted ? quoted[2]! : trimmed
}

function isMetadataRecord(value: unknown): value is Record<string, ResourceMetadataValue> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isMetadataValue)
  )
}

function isMetadataValue(value: unknown): value is ResourceMetadataValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

function resourceKind(name: string): ResourceKind | undefined {
  if (name === 'SKILL.md') return 'skill'
  if (name.endsWith('.prompt.md') || name.endsWith('.template.md')) return 'template'
  if (name.endsWith('.theme.json')) return 'theme'
  return undefined
}

function normalizedName(name: string): string {
  const value = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return value || 'unnamed'
}

function publicResource(resource: StoredResource): DiscoveredResource {
  const { content: _content, ...visible } = resource
  return structuredClone(visible)
}

function applySelections(catalog: WorkspaceCatalog): void {
  for (const selection of catalog.selections) {
    const matches = catalog.resources.get(selection.id)
    if (matches?.length !== 1) continue
    const resource = matches[0]!
    resource.enabled =
      resource.provenance.origin === selection.origin &&
      resource.provenance.digest === selection.digest
  }
}

function collisions(resources: Map<string, StoredResource[]>): ResourceCollision[] {
  return [...resources]
    .filter(([, matches]) => matches.length > 1)
    .map(([id, matches]) => ({
      id,
      origins: matches.map((resource) => resource.provenance.origin),
      paths: matches.map((resource) => resource.path),
    }))
}

function resourceCount(resources: Map<string, StoredResource[]>): number {
  let count = 0
  for (const candidates of resources.values()) count += candidates.length
  return count
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function slash(value: string): string {
  return value.split(sep).join('/')
}

function isInside(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate))
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..')
}

function isSelectionFile(
  value: unknown,
): value is { version: 1; workspace: string; selections: ResourceSelection[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).every((key) =>
      ['version', 'workspace', 'selections'].includes(key),
    ) &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { workspace?: unknown }).workspace === 'string' &&
    Array.isArray((value as { selections?: unknown }).selections) &&
    (value as { selections: unknown[] }).selections.every(isResourceSelection)
  )
}

function isResourceSelection(value: unknown): value is ResourceSelection {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).every((key) =>
      ['id', 'origin', 'digest'].includes(key),
    ) &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { origin?: unknown }).origin === 'string' &&
    typeof (value as { digest?: unknown }).digest === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test((value as { digest: string }).digest)
  )
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function isRuntimeResourceError(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { category?: unknown }).category === 'plugin'
  )
}

function resourceError(code: string, message: string) {
  return runtimeError(code, 'plugin', message)
}
