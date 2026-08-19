import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { dirname, resolve } from 'node:path'
import type { PluginGrant } from '@praxis/plugin-protocol'
import type {
  AuthInfo,
  DoctorResult,
  ModelInfo,
  RuntimeBridge,
  SessionExportResult,
  SessionInfo,
  UserSettingsInfo,
} from '@praxis/protocol'
import { promptForSecret, readSecretLine, SecureInputError } from './securePrompt.js'

export type ManagementAction =
  | { kind: 'auth.status'; provider: string; json: boolean }
  | { kind: 'auth.login'; provider: string; stdin: boolean; json: boolean }
  | { kind: 'auth.logout'; provider: string; json: boolean }
  | { kind: 'doctor'; workspace?: string; deep: boolean; json: boolean }
  | { kind: 'model.list'; provider?: string; json: boolean }
  | { kind: 'model.current'; json: boolean }
  | { kind: 'model.set'; provider: string; model: string; json: boolean }
  | { kind: 'session.list'; workspace?: string; json: boolean }
  | { kind: 'session.search'; query: string; json: boolean }
  | { kind: 'session.show'; sessionId: string; json: boolean }
  | { kind: 'session.rename'; sessionId: string; name: string; json: boolean }
  | {
      kind: 'session.fork'
      sessionId: string
      name?: string
      throughMessage?: number
      json: boolean
    }
  | { kind: 'session.branch'; sessionId: string; json: boolean }
  | {
      kind: 'session.export'
      sessionId: string
      output: string
      force: boolean
      json: boolean
    }
  | { kind: 'session.delete'; sessionId: string; yes: boolean; json: boolean }
  | { kind: 'trace.export'; traceId: string; output: string }
  | PluginAction
  | ResourceAction

export type PluginAction =
  | { kind: 'plugin.install'; source: string }
  | { kind: 'plugin.list'; workspace?: string }
  | { kind: 'plugin.inspect'; id: string; version?: string }
  | {
      kind: 'plugin.enable'
      id: string
      version: string
      workspace: string
      grants: PluginGrant[]
    }
  | { kind: 'plugin.disable'; id: string; workspace: string }
  | { kind: 'plugin.permissions'; id: string; workspace: string }
  | { kind: 'plugin.doctor' }
  | { kind: 'plugin.update'; source: string; workspace: string; grants: PluginGrant[] }
  | { kind: 'plugin.rollback'; id: string; workspace: string }
  | { kind: 'plugin.uninstall'; id: string; version: string }

export type ResourceAction =
  | { kind: 'resource.list'; workspace: string }
  | { kind: 'resource.inspect'; id: string; workspace: string; includeContent: boolean }
  | { kind: 'resource.enable'; id: string; workspace: string; projectTrusted: boolean }
  | { kind: 'resource.disable'; id: string; workspace: string }

export type ActionResult = {
  data: unknown
  human: string
  json: boolean
  exitCode?: 1
}

export async function executeManagementAction(
  bridge: RuntimeBridge,
  action: ManagementAction,
): Promise<ActionResult> {
  switch (action.kind) {
    case 'auth.status': {
      const status = await bridge.authStatus(action.provider)
      return {
        data: status,
        human: formatAuthStatus(status),
        json: action.json,
      }
    }
    case 'auth.login': {
      const before = await bridge.authStatus(action.provider)
      if (before.status === 'authenticated' && !action.stdin) {
        return {
          data: before,
          human: `${formatAuthStatus(before)}\nAlready connected; no credential was changed.`,
          json: action.json,
        }
      }
      let secret: string
      if (action.stdin) {
        secret = await readSecretLine()
      } else if (process.stdin.isTTY && process.stdout.isTTY) {
        secret = await promptForSecret({ prompt: `${action.provider} API key: ` })
      } else {
        throw new SecureInputError(
          `No credential is available for ${action.provider}; use auth login ${action.provider} --stdin or set ${before.credentialVariable ?? 'the provider environment variable'}.`,
          'AUTH_REQUIRED',
        )
      }
      await bridge.login(action.provider, secret)
      const status = await bridge.authStatus(action.provider)
      return {
        data: status,
        human: `${formatAuthStatus(status)}\nCredential saved.`,
        json: action.json,
      }
    }
    case 'auth.logout': {
      const before = await bridge.authStatus(action.provider)
      await bridge.logout(action.provider)
      const data = {
        ok: true,
        provider: action.provider,
        environmentVariable: before.credentialVariable,
      }
      const environmentNote = before.credentialVariable
        ? ` ${before.credentialVariable} remains in the parent shell and may authenticate a later Praxis process until it is unset.`
        : ''
      return {
        data,
        human: `Logged out ${action.provider}; its stored credential was removed.${environmentNote}`,
        json: action.json,
      }
    }
    case 'doctor': {
      const doctor = await bridge.doctor(action.workspace, action.deep)
      return {
        data: doctor,
        human: formatDoctor(doctor),
        json: action.json,
        ...(doctor.ok ? {} : { exitCode: 1 }),
      }
    }
    case 'model.list': {
      const models = await bridge.listModels(action.provider)
      return { data: models, human: formatModels(models), json: action.json }
    }
    case 'model.current': {
      const settings = await bridge.getSettings()
      return { data: settings, human: formatCurrentModel(settings), json: action.json }
    }
    case 'model.set': {
      const settings = await bridge.setDefaultModel(action.provider, action.model)
      return { data: settings, human: formatCurrentModel(settings), json: action.json }
    }
    case 'session.list': {
      const sessions = sortSessions(await bridge.listSessions())
      const filtered = action.workspace
        ? await filterSessionsByWorkspace(sessions, action.workspace)
        : sessions
      return { data: filtered, human: formatSessions(filtered), json: action.json }
    }
    case 'session.search': {
      const sessions = sortSessions(await bridge.searchSessions(action.query))
      return { data: sessions, human: formatSessions(sessions), json: action.json }
    }
    case 'session.show': {
      const session = await bridge.inspectSession(action.sessionId)
      return { data: session, human: formatSession(session), json: action.json }
    }
    case 'session.rename': {
      const session = await bridge.renameSession(action.sessionId, action.name)
      return { data: session, human: formatSession(session), json: action.json }
    }
    case 'session.fork': {
      const session = await bridge.forkSession(action.sessionId, action.name, action.throughMessage)
      return { data: session, human: formatSession(session), json: action.json }
    }
    case 'session.branch': {
      const session = await bridge.branchSession(action.sessionId)
      return { data: session, human: formatSession(session), json: action.json }
    }
    case 'session.export': {
      const exported = await bridge.exportSession(action.sessionId)
      const path = await writeSessionExport(exported, action.output, action.force)
      const data = {
        sessionId: action.sessionId,
        path,
        exportVersion: exported.exportVersion,
        messageCount: exported.messages.length,
      }
      return {
        data,
        human: `Exported ${action.sessionId} to ${path} (${exported.messages.length} messages).`,
        json: action.json,
      }
    }
    case 'session.delete': {
      if (!action.yes && !(await confirmDelete(action.sessionId))) {
        const data = { deleted: false, sessionId: action.sessionId }
        return { data, human: 'Deletion cancelled.', json: action.json }
      }
      const deleted = await bridge.deleteSession(action.sessionId)
      const data = { deleted: true, sessionId: action.sessionId, trashPath: deleted.trashPath }
      return {
        data,
        human: `Deleted ${action.sessionId}; recoverable at ${deleted.trashPath}.`,
        json: action.json,
      }
    }
    case 'trace.export':
      return {
        data: await bridge.exportTrace(action.traceId, action.output),
        human: '',
        json: true,
      }
    case 'plugin.install':
      return jsonResult(await bridge.installPlugin(action.source))
    case 'plugin.list':
      return jsonResult(await bridge.listPlugins(action.workspace))
    case 'plugin.inspect':
      return jsonResult(await bridge.inspectPlugin(action.id, action.version))
    case 'plugin.enable':
      return jsonResult(
        await bridge.enablePlugin(action.workspace, action.id, action.version, action.grants),
      )
    case 'plugin.disable':
      await bridge.disablePlugin(action.workspace, action.id)
      return jsonResult({ ok: true })
    case 'plugin.permissions':
      return jsonResult(await bridge.pluginPermissions(action.workspace, action.id))
    case 'plugin.doctor':
      return jsonResult(await bridge.pluginDoctor())
    case 'plugin.update':
      return jsonResult(await bridge.updatePlugin(action.workspace, action.source, action.grants))
    case 'plugin.rollback':
      return jsonResult(await bridge.rollbackPlugin(action.workspace, action.id))
    case 'plugin.uninstall':
      await bridge.uninstallPlugin(action.id, action.version)
      return jsonResult({ ok: true })
    case 'resource.list':
      return jsonResult(await bridge.listResources(action.workspace))
    case 'resource.inspect':
      return jsonResult(
        await bridge.inspectResource(action.workspace, action.id, action.includeContent),
      )
    case 'resource.enable':
      return jsonResult(
        await bridge.enableResource(action.workspace, action.id, action.projectTrusted),
      )
    case 'resource.disable':
      await bridge.disableResource(action.workspace, action.id)
      return jsonResult({ ok: true })
  }
}

function formatAuthStatus(status: AuthInfo): string {
  const source =
    status.credentialSource === 'stored'
      ? 'Stored credential'
      : status.credentialSource === 'environment'
        ? (status.credentialVariable ?? 'Environment variable')
        : status.credentialSource === 'provider'
          ? 'Provider-managed'
          : 'none'
  const protection = status.protection
    ? `${status.protection.backend}, ${status.protection.encrypted ? 'encrypted' : 'not encrypted'}`
    : 'not reported'
  return [
    `${status.provider}: ${status.status}`,
    `Source: ${source}`,
    ...(status.accountLabel ? [`Account: ${status.accountLabel}`] : []),
    `Credential protection: ${protection}`,
  ].join('\n')
}

export function renderActionResult(result: ActionResult): void {
  const output = result.json ? JSON.stringify(result.data) : result.human
  if (output) process.stdout.write(`${output}\n`)
  if (result.exitCode) process.exitCode = result.exitCode
}

function jsonResult(data: unknown): ActionResult {
  return { data, human: '', json: true }
}

function formatDoctor(doctor: DoctorResult): string {
  const lines = [`Praxis Runtime ${doctor.runtimeId}: ${doctor.ok ? 'ready' : 'errors detected'}`]
  for (const check of doctor.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.id}: ${check.message}`)
  }
  for (const provider of doctor.providers) {
    lines.push(
      `[PROVIDER] ${provider.id}: ${provider.status}, health=${provider.health}${
        provider.accountLabel ? `, source=${provider.accountLabel}` : ''
      }`,
    )
  }
  return lines.join('\n')
}

function formatModels(models: ModelInfo[]): string {
  if (models.length === 0) return 'No models found.'
  return models
    .map(
      (model) =>
        `${model.provider}/${model.id}\t${model.name}\t${model.contextTokens ?? '?'} context\t${model.modalities.join(',')}`,
    )
    .join('\n')
}

function formatCurrentModel(settings: UserSettingsInfo): string {
  const current = settings.defaultModel
  return current
    ? `Default model: ${current.provider}/${current.model}`
    : 'No default model selected.'
}

function formatSessions(sessions: SessionInfo[]): string {
  if (sessions.length === 0) return 'No sessions found.'
  return sessions
    .map(
      (session) =>
        `${session.sessionId}\t${session.state}\t${session.provider}/${session.model}\t${
          session.name ?? ''
        }\t${session.cwd}`,
    )
    .join('\n')
}

function formatSession(session: SessionInfo): string {
  return [
    `Session: ${session.sessionId}`,
    `State: ${session.state}`,
    `Name: ${session.name ?? session.sessionId}`,
    `Workspace: ${session.cwd}`,
    `Model: ${session.provider}/${session.model}`,
    `Messages: ${session.messageCount ?? 0}`,
    `Updated: ${session.updatedAt ?? 'unknown'}`,
  ].join('\n')
}

function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort(
    (left, right) =>
      (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '') ||
      left.sessionId.localeCompare(right.sessionId),
  )
}

async function filterSessionsByWorkspace(
  sessions: SessionInfo[],
  workspace: string,
): Promise<SessionInfo[]> {
  const canonicalWorkspace = await realpath(workspace)
  return sessions.filter((session) =>
    process.platform === 'win32'
      ? session.cwd.toLowerCase() === canonicalWorkspace.toLowerCase()
      : session.cwd === canonicalWorkspace,
  )
}

async function writeSessionExport(
  exported: SessionExportResult,
  output: string,
  force: boolean,
): Promise<string> {
  const path = resolve(output)
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, `${JSON.stringify(exported, undefined, 2)}\n`, {
      encoding: 'utf8',
      flag: force ? 'w' : 'wx',
    })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`Refusing to overwrite ${path}; pass --force to replace it.`)
    }
    throw error
  }
  return realpath(path)
}

async function confirmDelete(sessionId: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('session delete requires --yes when stdin is not interactive.')
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`Type ${sessionId} to confirm deletion: `)
    return answer.trim() === sessionId
  } finally {
    prompt.close()
  }
}
