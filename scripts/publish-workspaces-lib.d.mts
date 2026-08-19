export type NpmResult = {
  status: number | null
  stdout: string
  stderr: string
}

export type PublishWorkspacesOptions = {
  version: string
  registry: string
  runNpm(args: string[], allowFailure?: boolean): NpmResult
  writeOutput?(message: string): void
}

export const PRIVATE_REGISTRY_URL: 'http://127.0.0.1:4873/'
export const WORKSPACES: readonly string[]

export function resolveNpmInvocation(options: { execPath: unknown; npmExecPath: unknown }): {
  command: string
  prefixArgs: [string]
}
export function resolvePrivateRegistry(value: unknown): string
export function publishWorkspaces(options: PublishWorkspacesOptions): Promise<void>
