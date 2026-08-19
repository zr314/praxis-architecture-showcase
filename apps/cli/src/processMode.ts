import { fileURLToPath } from 'node:url'

export const RUNTIME_CHILD_ARGUMENT = '--runtime-child'

export type RuntimeLaunchFacts = {
  execPath: string
  bun: boolean
}

export function isRuntimeChild(argv: readonly string[]): boolean {
  return argv.slice(2).includes(RUNTIME_CHILD_ARGUMENT)
}

export function runtimeLaunch(
  moduleUrl: string,
  facts: RuntimeLaunchFacts = {
    execPath: process.execPath,
    bun: typeof (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun === 'string',
  },
): { command: string; args: string[] } {
  return facts.bun
    ? { command: facts.execPath, args: [RUNTIME_CHILD_ARGUMENT] }
    : {
        command: facts.execPath,
        args: [fileURLToPath(moduleUrl), RUNTIME_CHILD_ARGUMENT],
      }
}
