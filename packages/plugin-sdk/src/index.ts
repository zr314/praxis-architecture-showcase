import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isPluginManifestV1, type PluginManifestV1 } from '@praxis/plugin-protocol'

export * from '@praxis/plugin-protocol'

export type PluginCapabilityHandler = (
  input: unknown,
  context: { signal: AbortSignal },
) => Promise<unknown>

export type DefinedCapability = {
  id: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  invoke: PluginCapabilityHandler
}

export function defineCapability(capability: DefinedCapability): DefinedCapability {
  if (!capability.id.trim()) throw new TypeError('Capability id must not be blank.')
  return Object.freeze({ ...capability })
}

export function assertPluginContract(
  manifest: unknown,
  capabilities: readonly DefinedCapability[],
): asserts manifest is PluginManifestV1 {
  if (!isPluginManifestV1(manifest)) throw new TypeError('Invalid Praxis plugin manifest.')
  const declared = new Set(manifest.capabilities.map((capability) => capability.id))
  for (const capability of capabilities) {
    if (!declared.has(capability.id)) {
      throw new TypeError(`Capability "${capability.id}" is not declared by the manifest.`)
    }
  }
  if (new Set(capabilities.map((capability) => capability.id)).size !== capabilities.length) {
    throw new TypeError('Capability ids must be unique.')
  }
}

export type ScaffoldPluginOptions = {
  id: string
  name?: string
  version?: string
  kind?: 'tool' | 'provider'
}

/** Creates a minimal inspectable source tree; it never installs or enables it. */
export async function scaffoldPlugin(
  destination: string,
  options: ScaffoldPluginOptions,
): Promise<void> {
  const kind = options.kind ?? 'tool'
  const manifest: PluginManifestV1 = {
    manifestVersion: 1,
    id: options.id,
    name: options.name ?? options.id,
    version: options.version ?? '0.1.0',
    apiVersion: 1,
    entry: 'index.mjs',
    isolation: 'process',
    capabilities: [{ id: `example.${kind}`, kind }],
    grants: [],
  }
  if (!isPluginManifestV1(manifest)) throw new TypeError('Invalid scaffold options.')
  await mkdir(destination, { recursive: false })
  await writeFile(
    join(destination, 'praxis-plugin.json'),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(destination, 'index.mjs'),
    processPluginSource(manifest, manifest.capabilities[0]?.id ?? 'example.tool'),
    { encoding: 'utf8', flag: 'wx' },
  )
}

function processPluginSource(manifest: PluginManifestV1, capabilityId: string): string {
  const kind = manifest.capabilities[0]?.kind ?? 'tool'
  const descriptor =
    kind === 'provider'
      ? {
          id: capabilityId,
          kind,
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          provider: {
            defaultModel: 'example-v1',
            capabilities: {
              streaming: { text: true, reasoning: false, usage: true },
              tools: { mode: 'native', parallelCalls: false },
              modalities: { text: true, vision: false, audio: false },
              output: { jsonSchema: false, citations: false },
              limits: { maxContextTokens: 8_192, maxOutputTokens: 1_024 },
            },
          },
        }
      : {
          id: capabilityId,
          kind: 'tool',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          execution: {
            sideEffect: 'process',
            target: { kind: 'workspace' },
            parallelSafe: false,
            conflictScope: 'workspace',
            maxInlineBytes: 65_536,
          },
        }
  return `import { createInterface } from 'node:readline'

const manifest = ${JSON.stringify({
    id: manifest.id,
    version: manifest.version,
    apiVersion: 1,
    isolation: 'process',
    capabilities: manifest.capabilities.map((capability) => capability.kind),
  })}
const descriptor = ${JSON.stringify(descriptor)}
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    respond(request.id, { manifest, capabilities: [descriptor] })
  } else if (request.method === 'capability.invoke') {
    respond(request.id, {
      invocationId: request.params.invocationId,
      output: descriptor.kind === 'provider'
        ? { chunks: [
            { type: 'message_start' },
            { type: 'text_start', contentIndex: 0 },
            { type: 'text_delta', contentIndex: 0, text: 'Example Provider response.' },
            { type: 'text_end', contentIndex: 0 },
            { type: 'completed', stopReason: 'end_turn', usage: { outputTokens: 4 } }
          ] }
        : request.params.input
    })
  } else if (request.method === 'capability.cancel') {
    respond(request.id, { invocationId: request.params.invocationId, accepted: true })
  } else if (request.method === 'health.ping') {
    respond(request.id, { nonce: request.params.nonce })
  } else if (request.method === 'shutdown') {
    respond(request.id, { accepted: true })
  }
})
function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}
`
}
