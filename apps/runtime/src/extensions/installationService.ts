import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  isPluginGrantArray,
  isPluginManifestV1,
  isPluginRelativePath,
  PLUGIN_API_VERSION,
  type PluginGrant,
  type PluginLifecycleState,
  type PluginManifestV1,
  type PluginToolCommandMappingV1,
} from '@praxis/plugin-protocol'
import { runtimeError } from '@praxis/core-sdk'
import { verifyPluginProvenance, type TrustedPluginKey } from './pluginProvenance.js'
import type { ResourceDiscoverySource } from './resourceRegistry.js'

type InstalledExtension = {
  id: string
  version: string
  digest: string
  origin: string
  installedAt: string
  storePath: string
  manifest: PluginManifestV1
  provenance: 'verified' | 'unsigned'
}

type WorkspaceExtension = {
  pluginId: string
  version: string
  digest: string
  instanceId: string
  enabled: boolean
  grants: PluginGrant[]
  health: 'stopped' | 'healthy' | 'degraded' | 'quarantined'
  isolation: PluginManifestV1['isolation']
  trustedOnly?: boolean
}

type InstallationRegistry = {
  version: 1
  installations: InstalledExtension[]
}

type WorkspaceRegistry = {
  version: 1
  workspace: string
  extensions: WorkspaceExtension[]
}

export type ExtensionStatus = {
  id: string
  version: string
  digest: string
  origin: string
  instanceId?: string
  grants: PluginGrant[]
  health: WorkspaceExtension['health']
  lifecycle: PluginLifecycleState
  isolation: PluginManifestV1['isolation']
  enabled: boolean
  provenance: 'verified' | 'unsigned'
}

export type PersistedExtensionHealth = WorkspaceExtension['health']

export type McpServerSelection = {
  pluginId: string
  serverId: string
  version: string
  digest: string
  instanceId: string
  entryPath: string
  grants: PluginGrant[]
}

export type ProcessPluginSelection = {
  pluginId: string
  version: string
  digest: string
  instanceId: string
  pluginRoot: string
  entryPath: string
  grants: PluginGrant[]
  trustedOnly: boolean
  credentials: string[]
  capabilities: Array<{ id: string; kind: 'tool' | 'provider' }>
}

export type ExternalToolCommandSelection = Readonly<{
  pluginId: string
  source: 'plugin' | 'mcp'
  version: string
  digest: string
  mapping: PluginToolCommandMappingV1
}>

const IGNORED = new Set(['.git', 'node_modules', '.DS_Store'])
const INSTALLATION_KEYS = new Set([
  'id',
  'version',
  'digest',
  'origin',
  'installedAt',
  'storePath',
  'manifest',
  'provenance',
])
const WORKSPACE_EXTENSION_KEYS = new Set([
  'pluginId',
  'version',
  'digest',
  'instanceId',
  'enabled',
  'grants',
  'health',
  'isolation',
  'trustedOnly',
])

/** Content-addressed extension installation and fixed-version workspace enablement. */
export class ExtensionInstallationService {
  readonly #root: string
  readonly #store: string
  readonly #registryPath: string
  readonly #workspaceDirectory: string
  readonly #lockPath: string

  readonly #trustedKeys: readonly TrustedPluginKey[]
  readonly #requireSigned: boolean

  constructor(
    root = process.env.PRAXIS_HOME ?? join(homedir(), '.praxis'),
    options: { trustedKeys?: readonly TrustedPluginKey[]; requireSigned?: boolean } = {},
  ) {
    this.#root = join(root, 'extensions')
    this.#store = join(this.#root, 'store')
    this.#registryPath = join(this.#root, 'registry.json')
    this.#workspaceDirectory = join(this.#root, 'workspaces')
    this.#lockPath = join(this.#root, 'registry.lock')
    this.#trustedKeys = options.trustedKeys ?? []
    this.#requireSigned = options.requireSigned ?? false
  }

  async install(source: string): Promise<ExtensionStatus> {
    const origin = await realpath(source)
    if (!(await lstat(origin)).isDirectory()) throw extensionError('PLUGIN_SOURCE_INVALID')
    const manifest = await readManifest(origin)
    validateCompatibility(manifest)
    await validateEntry(origin, manifest)
    const provenance = await verifyPluginProvenance(
      origin,
      manifest,
      this.#trustedKeys,
      this.#requireSigned,
    )
    const digest = await digestDirectory(origin)
    const storePath = join(this.#store, digest.slice('sha256:'.length))

    await this.withLock(async () => {
      const registry = await this.readRegistry()
      const collision = registry.installations.find(
        (installed) => installed.id === manifest.id && installed.version === manifest.version,
      )
      if (collision && collision.digest !== digest) {
        throw extensionError('PLUGIN_VERSION_COLLISION')
      }
      if (!collision) {
        await copyDirectoryImmutable(origin, storePath)
        registry.installations.push({
          id: manifest.id,
          version: manifest.version,
          digest,
          origin,
          installedAt: new Date().toISOString(),
          storePath,
          manifest,
          provenance,
        })
        await this.writeRegistry(registry)
      }
    })
    return {
      id: manifest.id,
      version: manifest.version,
      digest,
      origin,
      grants: [],
      health: 'stopped',
      lifecycle: 'installed',
      isolation: manifest.isolation,
      enabled: false,
      provenance,
    }
  }

  async list(workspace?: string): Promise<ExtensionStatus[]> {
    const registry = await this.readRegistry()
    const enabled = workspace ? await this.readWorkspace(workspace) : undefined
    return registry.installations.map((installed) => {
      const instance = enabled?.extensions.find(
        (candidate) => candidate.pluginId === installed.id && candidate.digest === installed.digest,
      )
      return toStatus(installed, instance)
    })
  }

  async inspect(id: string, version?: string): Promise<InstalledExtension> {
    const matches = (await this.readRegistry()).installations
      .filter(
        (installed) =>
          installed.id === id && (version === undefined || installed.version === version),
      )
      .sort((left, right) => right.installedAt.localeCompare(left.installedAt))
    const installed = matches[0]
    if (!installed) throw extensionError('PLUGIN_NOT_INSTALLED')
    return cloneInstallation(installed)
  }

  async resourceSources(workspace: string): Promise<ResourceDiscoverySource[]> {
    const registry = await this.readWorkspace(workspace)
    const installations = (await this.readRegistry()).installations
    const sources: ResourceDiscoverySource[] = []
    for (const selected of registry.extensions) {
      if (!selected.enabled || selected.isolation !== 'data-only') continue
      const installed = installations.find(
        (candidate) =>
          candidate.id === selected.pluginId &&
          candidate.version === selected.version &&
          candidate.digest === selected.digest,
      )
      if (!installed) throw extensionError('PLUGIN_NOT_INSTALLED')
      const declarations = installed.manifest.capabilities
        .filter(
          (
            capability,
          ): capability is Extract<PluginManifestV1['capabilities'][number], { path: string }> =>
            'path' in capability,
        )
        .map((capability) => ({ ...capability }))
      if (declarations.length === 0) continue
      sources.push({
        path: installed.storePath,
        namespace: installed.id,
        origin: `plugin:${installed.id}@${installed.digest}`,
        sourceType: 'plugin',
        trusted: true,
        declarations,
      })
    }
    return sources
  }

  async mcpServerSelections(workspace: string): Promise<McpServerSelection[]> {
    const registry = await this.readWorkspace(workspace)
    const installations = (await this.readRegistry()).installations
    const selections: McpServerSelection[] = []
    for (const selected of registry.extensions) {
      if (
        !selected.enabled ||
        selected.isolation !== 'mcp-stdio' ||
        selected.health === 'quarantined'
      ) {
        continue
      }
      const installed = installations.find(
        (candidate) =>
          candidate.id === selected.pluginId &&
          candidate.version === selected.version &&
          candidate.digest === selected.digest,
      )
      if (!installed?.manifest.entry) throw extensionError('PLUGIN_NOT_INSTALLED')
      if ((await digestDirectory(installed.storePath)) !== installed.digest) {
        throw extensionError('PLUGIN_CONTENT_CHANGED')
      }
      const storePath = await realpath(installed.storePath)
      const entryPath = await realpath(resolve(storePath, installed.manifest.entry))
      if (!isInside(storePath, entryPath) || !(await lstat(entryPath)).isFile()) {
        throw extensionError('PLUGIN_ENTRY_INVALID')
      }
      for (const capability of installed.manifest.capabilities) {
        if (capability.kind !== 'mcp') continue
        selections.push({
          pluginId: installed.id,
          serverId: capability.id,
          version: installed.version,
          digest: installed.digest,
          instanceId: `${selected.instanceId}:${capability.id}`,
          entryPath,
          grants: structuredClone(selected.grants),
        })
      }
    }
    return selections
  }

  async processPluginSelections(workspace: string): Promise<ProcessPluginSelection[]> {
    const registry = await this.readWorkspace(workspace)
    const installations = (await this.readRegistry()).installations
    const selections: ProcessPluginSelection[] = []
    for (const selected of registry.extensions) {
      if (
        !selected.enabled ||
        selected.isolation !== 'process' ||
        selected.health === 'quarantined'
      ) {
        continue
      }
      const installed = installations.find(
        (candidate) =>
          candidate.id === selected.pluginId &&
          candidate.version === selected.version &&
          candidate.digest === selected.digest,
      )
      if (!installed?.manifest.entry) throw extensionError('PLUGIN_NOT_INSTALLED')
      if ((await digestDirectory(installed.storePath)) !== installed.digest) {
        throw extensionError('PLUGIN_CONTENT_CHANGED')
      }
      const pluginRoot = await realpath(installed.storePath)
      const entryPath = await realpath(resolve(pluginRoot, installed.manifest.entry))
      if (!isInside(pluginRoot, entryPath) || !(await lstat(entryPath)).isFile()) {
        throw extensionError('PLUGIN_ENTRY_INVALID')
      }
      selections.push({
        pluginId: installed.id,
        version: installed.version,
        digest: installed.digest,
        instanceId: selected.instanceId,
        pluginRoot,
        entryPath,
        grants: structuredClone(selected.grants),
        trustedOnly: selected.trustedOnly === true,
        credentials: [...(installed.manifest.credentials ?? [])],
        capabilities: installed.manifest.capabilities
          .filter(
            (
              capability,
            ): capability is Extract<
              PluginManifestV1['capabilities'][number],
              { kind: 'tool' | 'provider' }
            > => capability.kind === 'tool' || capability.kind === 'provider',
          )
          .map(({ id, kind }) => ({ id, kind })),
      })
    }
    return selections
  }

  async commandMappings(workspace: string): Promise<ExternalToolCommandSelection[]> {
    const registry = await this.readWorkspace(workspace)
    const installations = (await this.readRegistry()).installations
    const selections: ExternalToolCommandSelection[] = []
    for (const selected of registry.extensions) {
      if (
        !selected.enabled ||
        selected.health !== 'healthy' ||
        selected.isolation === 'data-only'
      ) {
        continue
      }
      const installed = installations.find(
        (candidate) =>
          candidate.id === selected.pluginId &&
          candidate.version === selected.version &&
          candidate.digest === selected.digest,
      )
      if (!installed) throw extensionError('PLUGIN_NOT_INSTALLED')
      if ((await digestDirectory(installed.storePath)) !== installed.digest) {
        throw extensionError('PLUGIN_CONTENT_CHANGED')
      }
      const source = selected.isolation === 'mcp-stdio' ? 'mcp' : 'plugin'
      for (const mapping of installed.manifest.commands ?? []) {
        selections.push(
          Object.freeze({
            pluginId: installed.id,
            source,
            version: installed.version,
            digest: installed.digest,
            mapping: structuredClone(mapping),
          }),
        )
      }
    }
    return selections
  }

  async enable(
    workspace: string,
    id: string,
    version: string,
    grants: PluginGrant[],
    options: { trustedOnly?: boolean } = {},
  ): Promise<ExtensionStatus> {
    const installed = await this.inspect(id, version)
    assertGrantSubset(installed.manifest.grants, grants)
    const registry = await this.readWorkspace(workspace)
    registry.extensions = registry.extensions.filter((extension) => extension.pluginId !== id)
    const instance: WorkspaceExtension = {
      pluginId: id,
      version,
      digest: installed.digest,
      instanceId: `plugin-${randomUUID()}`,
      enabled: true,
      grants: structuredClone(grants),
      health: 'stopped',
      isolation: installed.manifest.isolation,
      trustedOnly: options.trustedOnly ?? installed.manifest.isolation === 'process',
    }
    registry.extensions.push(instance)
    await this.writeWorkspace(registry)
    return toStatus(installed, instance)
  }

  async disable(workspace: string, id: string): Promise<void> {
    const registry = await this.readWorkspace(workspace)
    const extension = registry.extensions.find((candidate) => candidate.pluginId === id)
    if (extension) {
      extension.enabled = false
      extension.health = 'stopped'
    }
    await this.writeWorkspace(registry)
  }

  async setHealth(
    workspace: string,
    id: string,
    health: PersistedExtensionHealth,
  ): Promise<ExtensionStatus> {
    const registry = await this.readWorkspace(workspace)
    const extension = registry.extensions.find((candidate) => candidate.pluginId === id)
    if (!extension) throw extensionError('PLUGIN_NOT_ENABLED')
    extension.health = health
    await this.writeWorkspace(registry)
    const installed = await this.inspect(id, extension.version)
    return toStatus(installed, extension)
  }

  async permissions(
    workspace: string,
    id: string,
  ): Promise<{
    requested: PluginGrant[]
    approved: PluginGrant[]
  }> {
    const registry = await this.readWorkspace(workspace)
    const instance = registry.extensions.find((candidate) => candidate.pluginId === id)
    const installed = await this.inspect(id, instance?.version)
    return {
      requested: structuredClone(installed.manifest.grants),
      approved: structuredClone(instance?.grants ?? []),
    }
  }

  async update(
    workspace: string,
    source: string,
    grants: PluginGrant[],
    options: { trustedOnly?: boolean } = {},
  ): Promise<ExtensionStatus> {
    const installed = await this.install(source)
    return this.enable(workspace, installed.id, installed.version, grants, options)
  }

  async rollback(workspace: string, id: string): Promise<ExtensionStatus> {
    const registry = await this.readWorkspace(workspace)
    const current = registry.extensions.find((extension) => extension.pluginId === id)
    if (!current) throw extensionError('PLUGIN_NOT_ENABLED')
    const versions = (await this.readRegistry()).installations
      .filter((installed) => installed.id === id && installed.digest !== current.digest)
      .sort((left, right) => right.installedAt.localeCompare(left.installedAt))
    const previous = versions[0]
    if (!previous) throw extensionError('PLUGIN_ROLLBACK_UNAVAILABLE')
    return this.enable(workspace, id, previous.version, current.grants, {
      trustedOnly: current.trustedOnly === true,
    })
  }

  async uninstall(id: string, version: string): Promise<void> {
    await this.withLock(async () => {
      const registry = await this.readRegistry()
      const installed = registry.installations.find(
        (candidate) => candidate.id === id && candidate.version === version,
      )
      if (!installed) throw extensionError('PLUGIN_NOT_INSTALLED')
      for (const name of await safeReadDirectory(this.#workspaceDirectory)) {
        const workspace = await this.readWorkspaceFile(join(this.#workspaceDirectory, name))
        if (
          workspace.extensions.some(
            (extension) =>
              extension.pluginId === id && extension.version === version && extension.enabled,
          )
        ) {
          throw extensionError('PLUGIN_STILL_ENABLED')
        }
      }
      registry.installations = registry.installations.filter((candidate) => candidate !== installed)
      await this.writeRegistry(registry)
      await rm(installed.storePath, { recursive: true, force: true })
    })
  }

  async doctor(): Promise<Array<{ id: string; version: string; ok: boolean; issue?: string }>> {
    const results = []
    for (const installed of (await this.readRegistry()).installations) {
      const actual = await digestDirectory(installed.storePath).catch(() => undefined)
      results.push({
        id: installed.id,
        version: installed.version,
        ok: actual === installed.digest,
        ...(actual === installed.digest ? {} : { issue: 'content_digest_mismatch' }),
      })
    }
    return results
  }

  private async readRegistry(): Promise<InstallationRegistry> {
    try {
      const registry = JSON.parse(await readFile(this.#registryPath, 'utf8')) as unknown
      if (!isInstallationRegistry(registry)) {
        throw new SyntaxError('Invalid extension registry.')
      }
      return { version: 1, installations: registry.installations.map(cloneInstallation) }
    } catch (error) {
      if (isNotFound(error)) return { version: 1, installations: [] }
      throw error
    }
  }

  private async writeRegistry(registry: InstallationRegistry): Promise<void> {
    await atomicWrite(this.#registryPath, `${JSON.stringify(registry, undefined, 2)}\n`)
  }

  private async readWorkspace(workspace: string): Promise<WorkspaceRegistry> {
    const canonical = await realpath(workspace)
    const path = this.workspacePath(canonical)
    try {
      return await this.readWorkspaceFile(path)
    } catch (error) {
      if (isNotFound(error)) return { version: 1, workspace: canonical, extensions: [] }
      throw error
    }
  }

  private async readWorkspaceFile(path: string): Promise<WorkspaceRegistry> {
    const registry = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isWorkspaceRegistry(registry)) {
      throw new SyntaxError('Invalid workspace extension registry.')
    }
    return {
      version: 1,
      workspace: registry.workspace,
      extensions: registry.extensions.map((extension) => ({
        ...structuredClone(extension),
        trustedOnly: extension.trustedOnly === true,
      })),
    }
  }

  private async writeWorkspace(registry: WorkspaceRegistry): Promise<void> {
    await atomicWrite(
      this.workspacePath(registry.workspace),
      `${JSON.stringify(registry, undefined, 2)}\n`,
    )
  }

  private workspacePath(workspace: string): string {
    const digest = createHash('sha256').update(workspace).digest('hex')
    return join(this.#workspaceDirectory, `${digest}.json`)
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.#root, { recursive: true })
    const startedAt = Date.now()
    while (true) {
      try {
        const handle = await open(this.#lockPath, 'wx')
        try {
          return await action()
        } finally {
          await handle.close()
          await unlink(this.#lockPath).catch(() => {})
        }
      } catch (error) {
        if (!isAlreadyExists(error)) throw error
        if (Date.now() - startedAt > 5_000) throw extensionError('PLUGIN_REGISTRY_BUSY')
        await delay(25)
      }
    }
  }
}

async function readManifest(root: string): Promise<PluginManifestV1> {
  const value = JSON.parse(await readFile(join(root, 'praxis-plugin.json'), 'utf8')) as unknown
  if (
    typeof value === 'object' &&
    value !== null &&
    'entry' in value &&
    !isPluginRelativePath(value.entry)
  ) {
    throw extensionError('PLUGIN_ENTRY_INVALID')
  }
  if (!isPluginManifestV1(value)) throw extensionError('PLUGIN_MANIFEST_INVALID')
  return structuredClone(value)
}

function validateCompatibility(manifest: PluginManifestV1): void {
  if (manifest.apiVersion !== PLUGIN_API_VERSION) throw extensionError('PLUGIN_API_UNSUPPORTED')
  if (manifest.isolation !== 'data-only' && !manifest.entry) {
    throw extensionError('PLUGIN_ENTRY_REQUIRED')
  }
}

async function validateEntry(root: string, manifest: PluginManifestV1): Promise<void> {
  if (manifest.entry) {
    if (
      manifest.entry.includes('\0') ||
      manifest.entry.startsWith('/') ||
      /^[A-Za-z]:/.test(manifest.entry)
    ) {
      throw extensionError('PLUGIN_ENTRY_INVALID')
    }
    const target = resolve(root, manifest.entry)
    if (!isInside(root, target) || !(await lstat(target)).isFile()) {
      throw extensionError('PLUGIN_ENTRY_INVALID')
    }
  }
  for (const capability of manifest.capabilities) {
    if (!('path' in capability)) continue
    const target = resolve(root, capability.path)
    if (!isInside(root, target) || !(await lstat(target)).isFile()) {
      throw extensionError('PLUGIN_RESOURCE_INVALID')
    }
  }
}

async function digestDirectory(root: string): Promise<string> {
  const hash = createHash('sha256')
  for (const path of await walkFiles(root)) {
    const relativePath = relative(root, path).split(sep).join('/')
    hash.update(relativePath)
    hash.update('\0')
    hash.update(await readFile(path))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (IGNORED.has(entry.name)) continue
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw extensionError('PLUGIN_SYMLINK_REJECTED')
      if (metadata.isDirectory()) await visit(path)
      else if (metadata.isFile()) files.push(path)
    }
  }
  await visit(root)
  return files
}

async function copyDirectoryImmutable(source: string, target: string): Promise<void> {
  try {
    await mkdir(target, { recursive: false })
  } catch (error) {
    if (isAlreadyExists(error)) return
    await mkdir(dirname(target), { recursive: true })
    await mkdir(target, { recursive: false })
  }
  for (const path of await walkFiles(source)) {
    const destination = join(target, relative(source, path))
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(path, destination)
  }
}

function assertGrantSubset(requested: PluginGrant[], approved: PluginGrant[]): void {
  const allowed = new Set(requested.map((grant) => JSON.stringify(grant)))
  if (!approved.every((grant) => allowed.has(JSON.stringify(grant)))) {
    throw extensionError('PLUGIN_GRANT_NOT_REQUESTED')
  }
}

function toStatus(
  installed: InstalledExtension,
  instance: WorkspaceExtension | undefined,
): ExtensionStatus {
  return {
    id: installed.id,
    version: installed.version,
    digest: installed.digest,
    origin: installed.origin,
    ...(instance ? { instanceId: instance.instanceId } : {}),
    grants: structuredClone(instance?.grants ?? []),
    health: instance?.health ?? 'stopped',
    lifecycle:
      instance === undefined
        ? 'installed'
        : instance.enabled
          ? lifecycleFromHealth(instance.health)
          : 'stopped',
    isolation: installed.manifest.isolation,
    enabled: instance?.enabled ?? false,
    provenance: installed.provenance ?? 'unsigned',
  }
}

function lifecycleFromHealth(health: WorkspaceExtension['health']): PluginLifecycleState {
  return health === 'stopped' ? 'workspace-enabled' : health
}

function cloneInstallation(installed: InstalledExtension): InstalledExtension {
  return { ...installed, manifest: structuredClone(installed.manifest) }
}

function isInstallationRegistry(value: unknown): value is InstallationRegistry {
  return (
    isRecord(value) &&
    hasExactKeys(value, new Set(['version', 'installations'])) &&
    value.version === 1 &&
    Array.isArray(value.installations) &&
    value.installations.every(isInstalledExtension)
  )
}

function isInstalledExtension(value: unknown): value is InstalledExtension {
  return (
    isRecord(value) &&
    hasExactKeys(value, INSTALLATION_KEYS) &&
    typeof value.id === 'string' &&
    typeof value.version === 'string' &&
    isDigest(value.digest) &&
    isNonEmptyString(value.origin) &&
    isNonEmptyString(value.installedAt) &&
    isNonEmptyString(value.storePath) &&
    isPluginManifestV1(value.manifest) &&
    value.manifest.id === value.id &&
    value.manifest.version === value.version &&
    (value.provenance === 'verified' || value.provenance === 'unsigned')
  )
}

function isWorkspaceRegistry(value: unknown): value is WorkspaceRegistry {
  return (
    isRecord(value) &&
    hasExactKeys(value, new Set(['version', 'workspace', 'extensions'])) &&
    value.version === 1 &&
    isNonEmptyString(value.workspace) &&
    Array.isArray(value.extensions) &&
    value.extensions.every(isWorkspaceExtension)
  )
}

function isWorkspaceExtension(value: unknown): value is WorkspaceExtension {
  return (
    isRecord(value) &&
    hasExactKeys(value, WORKSPACE_EXTENSION_KEYS) &&
    isNonEmptyString(value.pluginId) &&
    isNonEmptyString(value.version) &&
    isDigest(value.digest) &&
    isNonEmptyString(value.instanceId) &&
    typeof value.enabled === 'boolean' &&
    isPluginGrantArray(value.grants) &&
    ['stopped', 'healthy', 'degraded', 'quarantined'].includes(String(value.health)) &&
    ['process', 'mcp-stdio', 'data-only'].includes(String(value.isolation)) &&
    (value.trustedOnly === undefined || typeof value.trustedOnly === 'boolean')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

function extensionError(code: string) {
  return runtimeError(code, 'plugin', 'Extension operation failed.')
}

async function atomicWrite(path: string, source: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temporary, source, 'utf8')
  await rename(temporary, path)
}

async function safeReadDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

function isInside(root: string, target: string): boolean {
  const relation = relative(root, target)
  return (
    relation === '' ||
    (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
  )
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
