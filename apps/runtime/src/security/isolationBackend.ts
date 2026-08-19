import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { runtimeError } from '@praxis/core-sdk'
import type { PluginGrant } from '@praxis/plugin-protocol'

const WORKSPACE_PLACEHOLDER = '$' + '{workspace}'

export type IsolationSupport = {
  level: 'supported' | 'degraded' | 'unavailable'
  backend: string
  enforced: Array<'filesystem' | 'network' | 'environment' | 'process' | 'resources'>
  message: string
}

export type IsolatedLaunchRequest = {
  command: string
  args?: string[]
  pluginRoot: string
  workspace: string
  grants: PluginGrant[]
  environment?: Record<string, string>
  allowTrustedOnly?: boolean
}

export type IsolatedLaunch = {
  command: string
  args: string[]
  cwd: string
  environment: Record<string, string>
  support: IsolationSupport
}

export interface IsolationBackend {
  status(): Promise<IsolationSupport>
  prepare(request: IsolatedLaunchRequest): Promise<IsolatedLaunch>
}

export class TrustedOnlyIsolationBackend implements IsolationBackend {
  constructor(private readonly platform: string = process.platform) {}

  async status(): Promise<IsolationSupport> {
    return {
      level: 'degraded',
      backend: `${this.platform}-trusted-process`,
      enforced: [],
      message:
        'No OS sandbox is active. External code requires explicit trusted-only approval and retains user-process authority.',
    }
  }

  async prepare(request: IsolatedLaunchRequest): Promise<IsolatedLaunch> {
    if (!request.allowTrustedOnly) {
      throw isolationError('ISOLATION_TRUST_REQUIRED')
    }
    return {
      command: request.command,
      args: [...(request.args ?? [])],
      cwd: resolve(request.pluginRoot),
      environment: declaredEnvironment(request),
      support: await this.status(),
    }
  }
}

export class LinuxBubblewrapIsolationBackend implements IsolationBackend {
  constructor(
    private readonly findExecutable: (name: string) => Promise<string | undefined> = findOnPath,
    private readonly platform: string = process.platform,
  ) {}

  async status(): Promise<IsolationSupport> {
    if (this.platform !== 'linux') {
      return {
        level: 'unavailable',
        backend: 'linux-bubblewrap',
        enforced: [],
        message: 'The bubblewrap backend is available on Linux only.',
      }
    }
    const [bubblewrap, prlimit] = await Promise.all([
      this.findExecutable('bwrap'),
      this.findExecutable('prlimit'),
    ])
    if (!bubblewrap || !prlimit) {
      return {
        level: 'unavailable',
        backend: 'linux-bubblewrap',
        enforced: [],
        message: 'bubblewrap and prlimit are required for enforced plugin isolation.',
      }
    }
    return {
      level: 'supported',
      backend: 'linux-bubblewrap',
      enforced: ['filesystem', 'network', 'environment', 'process', 'resources'],
      message:
        'Linux namespaces, explicit bind mounts, environment filtering, and rlimits are active.',
    }
  }

  async prepare(request: IsolatedLaunchRequest): Promise<IsolatedLaunch> {
    const support = await this.status()
    if (support.level !== 'supported') throw isolationError('ISOLATION_UNAVAILABLE')
    const bubblewrap = await this.findExecutable('bwrap')
    const prlimit = await this.findExecutable('prlimit')
    if (!bubblewrap || !prlimit) throw isolationError('ISOLATION_UNAVAILABLE')
    const resources = request.grants.find((grant) => grant.type === 'resource')
    const filesystem = request.grants.filter(
      (grant): grant is Extract<PluginGrant, { type: 'filesystem' }> => grant.type === 'filesystem',
    )
    const networkGranted = request.grants.some((grant) => grant.type === 'network')
    const limits = [
      `--cpu=${Math.max(1, Math.ceil((resources?.cpuMs ?? 30_000) / 1_000))}`,
      `--as=${Math.max(16, resources?.memoryMb ?? 512) * 1024 * 1024}`,
      `--nproc=${Math.max(1, resources?.processCount ?? 8)}`,
    ]
    const sandbox = [
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      ...(networkGranted ? ['--share-net'] : []),
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--ro-bind',
      resolve(request.pluginRoot),
      '/plugin',
      '--chdir',
      '/plugin',
    ]
    for (const grant of filesystem) {
      for (const path of grant.paths) {
        const canonical = resolve(path.replaceAll(WORKSPACE_PLACEHOLDER, request.workspace))
        sandbox.push(grant.access === 'write' ? '--bind' : '--ro-bind', canonical, canonical)
      }
    }
    sandbox.push('--', request.command, ...(request.args ?? []))
    return {
      command: prlimit,
      args: [...limits, '--', bubblewrap, ...sandbox],
      cwd: resolve(request.pluginRoot),
      environment: declaredEnvironment(request),
      support,
    }
  }
}

export function platformIsolationBackend(): IsolationBackend {
  return process.platform === 'linux'
    ? new LinuxBubblewrapIsolationBackend()
    : new TrustedOnlyIsolationBackend()
}

function declaredEnvironment(request: IsolatedLaunchRequest): Record<string, string> {
  const names = new Set(
    request.grants
      .filter(
        (grant): grant is Extract<PluginGrant, { type: 'environment' }> =>
          grant.type === 'environment',
      )
      .flatMap((grant) => grant.names),
  )
  return Object.fromEntries(
    Object.entries(request.environment ?? {}).filter(([name]) => names.has(name)),
  )
}

async function findOnPath(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = resolve(directory, name)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue searching.
    }
  }
  return undefined
}

function isolationError(code: string) {
  return runtimeError(code, 'permission', `Plugin isolation failed (${code}).`)
}
