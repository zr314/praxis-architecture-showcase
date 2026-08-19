import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeLaunch, type RuntimeLaunchFacts } from '../processMode.js'
import { NdjsonRuntimeBridge } from './ndjsonBridge.js'

export function startLocalRuntime(
  runtimeEntry?: string,
  env?: NodeJS.ProcessEnv,
): Promise<NdjsonRuntimeBridge> {
  const launch = resolveLocalRuntimeLaunch(import.meta.url, runtimeEntry)

  return NdjsonRuntimeBridge.start(launch.command, launch.args, { env })
}

export function resolveLocalRuntimeLaunch(
  moduleUrl: string,
  runtimeEntry?: string,
  facts?: RuntimeLaunchFacts,
): { command: string; args: string[] } {
  if (runtimeEntry) {
    return {
      command: facts?.execPath ?? process.execPath,
      args: runtimeEntry.endsWith('.ts') ? ['--import', 'tsx', runtimeEntry] : [runtimeEntry],
    }
  }

  const modulePath = fileURLToPath(moduleUrl)
  if (modulePath.endsWith('.ts')) {
    return {
      command: facts?.execPath ?? process.execPath,
      args: ['--import', 'tsx', resolve(dirname(modulePath), '../../../runtime/src/entry.ts')],
    }
  }

  return runtimeLaunch(moduleUrl, facts)
}
