import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { InputRouterV1, type CommandCatalogSnapshotV1 } from '@praxis/core-sdk'
import type { RuntimeBridge, SessionInfo } from '@praxis/protocol'
import { createClientCommandRegistryV1 } from './clientCommandRegistry.js'

export type SlashCommandContext = {
  bridge: RuntimeBridge
  session: SessionInfo
  cwd: string
  runtimeCatalog?: CommandCatalogSnapshotV1
  runActive?: boolean
  latestAssistantText?: string
  copyText?: (text: string) => Promise<void>
}

export type SlashCommandResult = {
  handled: boolean
  prompt?: string
  commandInvocationId?: string
  session?: SessionInfo
  history?: 'reset' | 'restore' | 'preserve'
  message?: string
  action?:
    | {
        type: 'open_catalog'
        view: 'providers' | 'models'
        intent?: 'select' | 'login' | 'logout'
        query?: string
        provider?: string
      }
    | {
        type: 'open_session_picker'
        query?: string
      }
}

export async function executeSlashCommand(
  source: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  if (!source.startsWith('/')) return { handled: false }
  const runtimeCatalog = context.runtimeCatalog ?? (await context.bridge.listCommands(context.cwd))
  const clientCatalog = createClientCommandRegistryV1().snapshot({
    workspaceId: runtimeCatalog.workspaceId,
    workspaceTrusted: runtimeCatalog.workspaceTrusted,
    capabilityIds: runtimeCatalog.capabilityIds,
  })
  const clientRequestId = `command:${randomUUID()}`
  const invokeRuntime = (invocation: import('@praxis/core-sdk').CommandInvocationV1) =>
    context.bridge.invokeCommand({
      schemaVersion: 1,
      workspace: context.cwd,
      catalogSnapshotDigest: runtimeCatalog.snapshotDigest,
      capabilityDigest: runtimeCatalog.capabilityDigest,
      invocation,
      sessionId: context.session.sessionId,
    })
  const routed = await new InputRouterV1({
    promptCommandProducer: {
      produce: async ({ invocation }) => {
        const result = await invokeRuntime(invocation)
        if (result.output.kind !== 'prompt_envelope') {
          throw new Error('COMMAND_PROMPT_OUTPUT_INVALID')
        }
        return result.output.envelope
      },
    },
  }).route(source, {
    clientRequestId,
    promptId: `prompt:${randomUUID()}`,
    catalogs: [clientCatalog, runtimeCatalog],
    capabilityDigest: runtimeCatalog.capabilityDigest,
    workspaceTrusted: runtimeCatalog.workspaceTrusted,
    session: 'present',
    run: context.runActive ? 'active' : 'idle',
  })
  if (routed.kind === 'error') {
    return { handled: true, message: commandErrorMessage(routed.error.code, runtimeCatalog) }
  }
  if (routed.kind === 'prompt_envelope') {
    return {
      handled: false,
      prompt: routed.envelope.effectiveText,
      ...(routed.envelope.commandInvocationId === undefined
        ? {}
        : { commandInvocationId: routed.envelope.commandInvocationId }),
    }
  }
  if (routed.kind === 'ui_action') {
    if (routed.invocation.descriptorId !== 'builtin:client/copy') {
      return { handled: true, message: 'COMMAND_CLIENT_HANDLER_NOT_FOUND' }
    }
    if (!context.latestAssistantText) {
      return { handled: true, message: 'No assistant response to copy.' }
    }
    if (!context.copyText) throw new Error('Clipboard integration is unavailable.')
    await context.copyText(context.latestAssistantText)
    return { handled: true, message: 'Copied the latest assistant response.' }
  }

  const result = await invokeRuntime(routed.invocation)
  if (result.output.kind === 'runtime_result') {
    return { handled: true, message: JSON.stringify(result.output.value, undefined, 2) }
  }
  if (result.output.kind === 'bounded_job') {
    return {
      handled: true,
      message: `Job ${result.output.jobId}: ${result.output.state}.`,
    }
  }
  if (result.output.kind === 'none') return { handled: true }
  if (result.output.kind === 'prompt_envelope') {
    return {
      handled: false,
      prompt: result.output.envelope.effectiveText,
      commandInvocationId: result.output.envelope.commandInvocationId,
    }
  }
  return applyUiAction(result.output.action, result.output.payload ?? {}, context)
}

async function applyUiAction(
  action: string,
  payload: Readonly<Record<string, unknown>>,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  switch (action) {
    case 'show_message':
      return { handled: true, message: payloadString(payload, 'message') }
    case 'open_catalog':
      return {
        handled: true,
        action: {
          type: 'open_catalog',
          view: payload.view === 'models' ? 'models' : 'providers',
          ...(payload.intent === 'login' || payload.intent === 'logout'
            ? { intent: payload.intent }
            : {}),
          ...(typeof payload.query === 'string' ? { query: payload.query } : {}),
          ...(typeof payload.provider === 'string' ? { provider: payload.provider } : {}),
        },
      }
    case 'open_session_picker':
      return {
        handled: true,
        action: {
          type: 'open_session_picker',
          ...(typeof payload.query === 'string' ? { query: payload.query } : {}),
        },
      }
    case 'session_changed':
      return {
        handled: true,
        session: payloadSession(payload.session),
        history:
          payload.history === 'reset' ||
          payload.history === 'restore' ||
          payload.history === 'preserve'
            ? payload.history
            : 'preserve',
        ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
      }
    case 'export_session': {
      const sessionId = payloadString(payload, 'sessionId')
      const destination = payloadString(payload, 'path')
      const exported = await context.bridge.exportSession(sessionId)
      await writeFile(destination, `${JSON.stringify(exported, undefined, 2)}\n`, 'utf8')
      return { handled: true, message: `Exported session to ${destination}.` }
    }
    default:
      return { handled: true, message: `COMMAND_UI_ACTION_UNKNOWN: ${action}` }
  }
}

function commandErrorMessage(code: string, catalog: CommandCatalogSnapshotV1): string {
  if (code !== 'COMMAND_UNKNOWN') return code
  const commands = catalog.entries.map(({ descriptor }) => `/${descriptor.command}`).join(', ')
  return `Unknown command. Available Runtime commands: ${commands}.`
}

function payloadString(payload: Readonly<Record<string, unknown>>, name: string): string {
  const value = payload[name]
  if (typeof value !== 'string') throw new Error(`COMMAND_UI_PAYLOAD_INVALID: ${name}`)
  return value
}

function payloadSession(input: unknown): SessionInfo {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof Reflect.get(input, 'sessionId') !== 'string' ||
    !['idle', 'running', 'closed'].includes(String(Reflect.get(input, 'state'))) ||
    typeof Reflect.get(input, 'cwd') !== 'string' ||
    typeof Reflect.get(input, 'provider') !== 'string' ||
    typeof Reflect.get(input, 'model') !== 'string'
  ) {
    throw new Error('COMMAND_UI_PAYLOAD_INVALID: session')
  }
  return structuredClone(input) as SessionInfo
}
