import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, readFile, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { type ChatProvider, type RuntimeTool, runtimeError } from '@praxis/core-sdk'
import { ArtifactStore } from '../artifacts/artifactStore.js'
import { createBuiltinTools } from '../builtin-tools/builtinTools.js'
import {
  ExtensionInstallationService,
  ResourceCatalog,
  type TurnResourceSnapshot,
} from '../extensions/index.js'
import type { RuntimeKernelOptions } from '../framework/runtimeKernel.js'
import { MockProvider } from '../providers/mockProvider.js'
import { OPENAI_RESPONSES_CAPABILITIES } from '../providers/openAIResponsesProvider.js'
import { JsonlRepository } from '../session-db/index.js'
import { ArtifactReadTool } from '../tools/artifactReadTool.js'
import { JsonlTraceSink, TraceService } from '../trace/index.js'
import type { ChildBootstrapMethod, ChildBootstrapProfileV3 } from './childBootstrapProfile.js'
import { digestToolDefinition } from './childCapabilityBundle.js'
import { ChildResultSubmissionToolV1 } from './childResultSubmissionTool.js'
import { ChildBrokeredProvider } from './credentialBrokerIpc.js'
import { ChildMcpBrokerIpcClient, ChildMcpBrokerTool } from './mcpBrokerIpc.js'

const OWNERSHIP_MARKER = '.praxis-child-root.json'
const CHILD_SESSION_METHODS = new Set<ChildBootstrapMethod>([
  'initialize',
  'events.subscribe',
  'session.create',
  'session.prompt',
  'permission.decide',
  'session.abort',
  'shutdown',
])

type ChildRootMarker = {
  version: 1
  childRunId: string
  nonceDigest: string
}

type ChildCompositionFailureCode =
  | 'CHILD_COMPOSITION_PROVIDER_UNAVAILABLE'
  | 'CHILD_COMPOSITION_SETTINGS_IMMUTABLE'
  | 'CHILD_COMPOSITION_WORKSPACE_INVALID'
  | 'CHILD_COMPOSITION_CAPABILITY_UNREALIZABLE'
  | 'CHILD_COMPOSITION_RESOURCE_DRIFT'
  | 'CHILD_COMPOSITION_ROOT_UNSAFE'
  | 'CHILD_COMPOSITION_ROOT_NOT_OWNED'

const CHILD_COMPOSITION_FAILURE_CODES = new Set<string>([
  'CHILD_COMPOSITION_PROVIDER_UNAVAILABLE',
  'CHILD_COMPOSITION_SETTINGS_IMMUTABLE',
  'CHILD_COMPOSITION_WORKSPACE_INVALID',
  'CHILD_COMPOSITION_CAPABILITY_UNREALIZABLE',
  'CHILD_COMPOSITION_RESOURCE_DRIFT',
  'CHILD_COMPOSITION_ROOT_UNSAFE',
  'CHILD_COMPOSITION_ROOT_NOT_OWNED',
] satisfies ChildCompositionFailureCode[])

export function createChildRuntimeComposition(
  profile: ChildBootstrapProfileV3,
): RuntimeKernelOptions {
  const provider = realizeChildProvider(profile)
  let mcpClient: ChildMcpBrokerIpcClient | undefined
  const workspace = canonicalWorkspace(profile.workspace.root)
  const ephemeralRoot = canonicalEphemeralRoot(profile.ephemeral.root)
  assertSeparatedRoots(workspace, ephemeralRoot)
  prepareOwnedRoot(profile)
  try {
    const repository = new JsonlRepository(profile.ephemeral.sessionRoot)
    const artifactStore = new ArtifactStore(
      profile.ephemeral.artifactRoot,
      profile.artifactAccess === undefined ? [] : [profile.artifactAccess],
    )
    const mcp = realizeChildMcp(profile)
    mcpClient = mcp.client
    const tools = [
      ...realizeBuiltinTools(profile, artifactStore),
      ...mcp.tools,
      ...(profile.resultSubmission === undefined
        ? []
        : [
            new ChildResultSubmissionToolV1(
              profile.resultSubmission.schema,
              profile.resultSubmission.criterionIds,
            ),
          ]),
    ]
    if (profile.capabilityBundle.mcp.mode === 'child_launch') {
      throw childCompositionFailure(
        'CHILD_COMPOSITION_CAPABILITY_UNREALIZABLE',
        'The selected child MCP strategy is not available in this composition.',
      )
    }
    const traceId = profile.trace.traceId.startsWith('trace-')
      ? profile.trace.traceId.slice('trace-'.length)
      : profile.trace.traceId
    return {
      sessionRepository: repository,
      policyStore: repository,
      artifactStore,
      credentialOptions: { environment: {}, environmentNames: {} },
      traceService: new TraceService({
        sink: new JsonlTraceSink(profile.ephemeral.traceRoot),
        createId: () => traceId,
        correlation: {
          parentRunId: profile.parentRunId,
          childRunId: profile.childRunId,
          ...(profile.trace.parentTraceId === undefined
            ? {}
            : { parentTraceId: profile.trace.parentTraceId }),
        },
      }),
      settings: {
        defaultModel: async () => ({
          provider: profile.provider.providerId,
          model: profile.provider.model,
          updatedAt: profile.launch.issuedAt,
        }),
        setDefaultModel: async () => {
          throw childCompositionFailure(
            'CHILD_COMPOSITION_SETTINGS_IMMUTABLE',
            'Child Runtime settings are immutable.',
          )
        },
      },
      installationService: new ExtensionInstallationService(profile.ephemeral.root),
      resourceCatalog: new ChildBundleResourceCatalog(profile, workspace),
      providers: [provider],
      replaceProviders: true,
      tools,
      exposeArtifactTool: false,
      extensionEnvironment: {},
      authority: {
        methodAllowlist: profile.capabilityBundle.methodAllowlist.filter((method) =>
          CHILD_SESSION_METHODS.has(method),
        ),
        workspace,
        provider: profile.provider,
        ...(profile.pinnedContext === undefined
          ? {}
          : {
              pinnedContextMessages: [{ role: 'user' as const, content: profile.pinnedContext }],
            }),
        ...(profile.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: profile.reasoningEffort }),
        capabilitySnapshot: {
          snapshotId: profile.capabilityBundle.bundleId,
          bundleDigest: profile.capabilityBundle.digest,
        },
        ...(profile.resultSubmission === undefined
          ? {}
          : { terminalTool: { name: profile.resultSubmission.toolName } }),
      },
      onShutdown: async (outcome) => {
        try {
          if ('close' in provider && typeof provider.close === 'function') provider.close()
          mcp.client?.close()
        } finally {
          // A graceful child-process shutdown does not mean the delegated
          // prompt succeeded. For retain_on_failure, the authenticated parent
          // owns the final outcome and performs cleanup only after it has
          // observed the terminal prompt event. Deleting here would erase the
          // failed session and trace before the parent can retain them.
          if (profile.ephemeral.retention === 'delete') {
            await cleanupChildRuntimeComposition(profile, outcome)
          }
        }
      },
    }
  } catch (error) {
    mcpClient?.close()
    if (profile.ephemeral.retention === 'delete') removeOwnedRootSync(profile)
    throw error
  }
}

function realizeChildMcp(profile: ChildBootstrapProfileV3): Readonly<{
  tools: RuntimeTool[]
  client?: ChildMcpBrokerIpcClient
}> {
  const mcp = profile.capabilityBundle.mcp
  if (mcp.mode === 'disabled' || mcp.mode === 'child_launch') return { tools: [] }
  const client = new ChildMcpBrokerIpcClient()
  return {
    client,
    tools: mcp.toolGrants.map((grant) => new ChildMcpBrokerTool(grant, client)),
  }
}

function realizeChildProvider(profile: ChildBootstrapProfileV3): ChatProvider {
  const credential = profile.capabilityBundle.provider.credential
  if (
    profile.provider.providerId === 'mock' &&
    profile.provider.model === 'mock-v1' &&
    credential.kind === 'none' &&
    credential.mode === 'mock'
  ) {
    return new MockProvider()
  }
  if (credential.kind === 'broker_handle') {
    return new ChildBrokeredProvider({
      target: profile.provider,
      expiresAt: credential.expiresAt,
      capabilities: OPENAI_RESPONSES_CAPABILITIES,
    })
  }
  throw childCompositionFailure(
    'CHILD_COMPOSITION_PROVIDER_UNAVAILABLE',
    'The child Provider target is unavailable in the isolated composition.',
  )
}

function realizeBuiltinTools(
  profile: ChildBootstrapProfileV3,
  artifactStore: ArtifactStore,
): RuntimeTool[] {
  const available = new Map(
    [
      ...createBuiltinTools({ commandPolicy: childShellCommandPolicyV1 }),
      new ArtifactReadTool(artifactStore),
    ].map((tool) => [tool.definition.name, tool]),
  )
  return profile.capabilityBundle.tools.map((grant) => {
    const tool = available.get(grant.name)
    if (tool === undefined) {
      throw childCompositionFailure(
        'CHILD_COMPOSITION_CAPABILITY_UNREALIZABLE',
        'A granted builtin Tool cannot be reconstructed in the child composition.',
      )
    }
    if (digestToolDefinition(tool.definition) !== grant.definitionDigest) {
      throw childCompositionFailure(
        'CHILD_COMPOSITION_RESOURCE_DRIFT',
        'A granted builtin Tool definition no longer matches the child implementation.',
      )
    }
    return tool
  })
}

export function childShellCommandPolicyV1(command: string) {
  const praxisExecutable =
    /(?:^|[;&|\r\n]\s*)(?:&\s*)?(?:(?:npx|bunx)(?:\.cmd)?\s+)?(?:["']?[^"'\s;&|]*[\\/])?praxis(?:\.cmd|\.exe)?(?=$|\s)/iu.test(
      command,
    )
  const praxisCliEntry =
    /(?:^|[;&|\r\n]\s*)(?:&\s*)?(?:node|bun|tsx)(?:\.exe)?\s+[^;&|]*[\\/]apps[\\/]cli[\\/](?:dist[\\/])?cli\.(?:js|mjs|cjs|ts|tsx)(?:\s|$)/iu.test(
      command,
    )
  if (!praxisExecutable && !praxisCliEntry) return undefined
  return {
    ok: false as const,
    summary: 'Recursive Praxis CLI invocation is not allowed inside a child Runtime.',
    error: {
      code: 'CHILD_RECURSIVE_PRAXIS_DENIED',
      category: 'permission' as const,
      retryable: false,
    },
  }
}

class ChildBundleResourceCatalog extends ResourceCatalog {
  readonly #workspace: string
  readonly #snapshot: TurnResourceSnapshot

  constructor(profile: ChildBootstrapProfileV3, workspace: string) {
    super()
    this.#workspace = workspace
    this.#snapshot = Object.freeze({
      id: `child-resources-${profile.capabilityBundle.digest.slice(0, 16)}`,
      workspace,
      skills: Object.freeze(
        profile.capabilityBundle.skills.map((grant) =>
          Object.freeze({
            id: grant.id,
            localId: grant.localId,
            name: grant.name,
            description: grant.description,
            origin: grant.origin,
            digest: grant.digest,
            disableModelInvocation: grant.disableModelInvocation,
            content: grant.resource.content,
          }),
        ),
      ),
    })
  }

  override snapshot(workspace: string): TurnResourceSnapshot {
    if (resolve(workspace) !== this.#workspace) {
      throw childCompositionFailure(
        'CHILD_COMPOSITION_WORKSPACE_INVALID',
        'The child resource snapshot is bound to a different workspace.',
      )
    }
    return this.#snapshot
  }
}

export async function cleanupChildRuntimeComposition(
  profile: ChildBootstrapProfileV3,
  outcome: { failed: boolean },
): Promise<void> {
  if (outcome.failed && profile.ephemeral.retention === 'retain_on_failure') return
  const rootState = await ownedRootState(profile.ephemeral.root)
  if (rootState === 'absent') return
  if (rootState === 'unsafe') throw rootNotOwnedFailure()
  const marker = await readOwnedMarker(profile)
  if (!markerMatches(profile, marker)) throw rootNotOwnedFailure()
  await rm(profile.ephemeral.root, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 })
}

export function isChildCompositionFailure(
  error: unknown,
): error is Error & { code: ChildCompositionFailureCode } {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    CHILD_COMPOSITION_FAILURE_CODES.has(error.code)
  )
}

function prepareOwnedRoot(profile: ChildBootstrapProfileV3): void {
  const marker = expectedMarker(profile)
  let created = false
  try {
    mkdirSync(profile.ephemeral.root, { recursive: false, mode: 0o700 })
    created = true
    writeFileSync(join(profile.ephemeral.root, OWNERSHIP_MARKER), JSON.stringify(marker), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch {
    if (created) {
      rmSync(profile.ephemeral.root, { recursive: true, force: true })
    }
    throw rootNotOwnedFailure()
  }
}

function canonicalWorkspace(workspace: string): string {
  try {
    return realpathSync.native(workspace)
  } catch {
    throw childCompositionFailure(
      'CHILD_COMPOSITION_WORKSPACE_INVALID',
      'The child workspace grant is unavailable.',
    )
  }
}

function canonicalEphemeralRoot(root: string): string {
  const declared = resolve(root)
  try {
    const actual = resolve(realpathSync.native(dirname(declared)), basename(declared))
    if (!samePath(declared, actual)) throw new Error('redirected parent')
    return actual
  } catch {
    throw childCompositionFailure(
      'CHILD_COMPOSITION_ROOT_UNSAFE',
      'The child temporary root parent is unavailable or redirected.',
    )
  }
}

function assertSeparatedRoots(workspace: string, ephemeralRoot: string): void {
  const root = resolve(ephemeralRoot)
  if (contains(workspace, root) || contains(root, workspace)) {
    throw childCompositionFailure(
      'CHILD_COMPOSITION_ROOT_UNSAFE',
      'The child temporary root overlaps its workspace grant.',
    )
  }
}

function contains(parent: string, candidate: string): boolean {
  const relation = relative(resolve(parent), resolve(candidate))
  return (
    relation === '' ||
    (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  )
}

function expectedMarker(profile: ChildBootstrapProfileV3): ChildRootMarker {
  return {
    version: 1,
    childRunId: profile.childRunId,
    nonceDigest: createHash('sha256').update(profile.launch.nonce).digest('hex'),
  }
}

async function readOwnedMarker(profile: ChildBootstrapProfileV3): Promise<unknown> {
  try {
    const path = join(profile.ephemeral.root, OWNERSHIP_MARKER)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return undefined
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

function readOwnedMarkerSync(profile: ChildBootstrapProfileV3): unknown {
  try {
    const path = join(profile.ephemeral.root, OWNERSHIP_MARKER)
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) return undefined
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function markerMatches(profile: ChildBootstrapProfileV3, value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const marker = value as Partial<ChildRootMarker>
  const expected = expectedMarker(profile)
  return (
    marker.version === expected.version &&
    marker.childRunId === expected.childRunId &&
    marker.nonceDigest === expected.nonceDigest &&
    Object.keys(marker).length === 3
  )
}

function removeOwnedRootSync(profile: ChildBootstrapProfileV3): void {
  if (!ownedRootDirectorySync(profile.ephemeral.root)) return
  if (!markerMatches(profile, readOwnedMarkerSync(profile))) return
  rmSync(profile.ephemeral.root, { recursive: true, force: false })
}

async function ownedRootState(root: string): Promise<'owned-shape' | 'absent' | 'unsafe'> {
  try {
    const info = await lstat(root)
    return info.isDirectory() && !info.isSymbolicLink() ? 'owned-shape' : 'unsafe'
  } catch (error) {
    return isNotFound(error) ? 'absent' : 'unsafe'
  }
}

function ownedRootDirectorySync(root: string): boolean {
  try {
    const info = lstatSync(root)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function rootNotOwnedFailure(): Error & { code: string } {
  return childCompositionFailure(
    'CHILD_COMPOSITION_ROOT_NOT_OWNED',
    'The child temporary root cannot be safely reclaimed.',
  )
}

function childCompositionFailure(
  code: ChildCompositionFailureCode,
  message: string,
): Error & { code: ChildCompositionFailureCode } {
  return Object.assign(new Error(message), runtimeError(code, 'subagent', message), { code })
}
