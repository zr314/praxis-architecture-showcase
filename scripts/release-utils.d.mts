export type BinaryTarget = 'windows-x64' | 'linux-x64' | 'darwin-x64' | 'darwin-arm64'

export type BinaryArtifact = {
  platform: 'win32' | 'linux' | 'darwin'
  arch: 'x64' | 'arm64'
  bunTarget: string
  compilerPackage: string
  filename: string
}

export const binaryTargets: readonly BinaryTarget[]
export function artifactForTarget(target: string, version: string): BinaryArtifact
export function assertTagVersion(tag: string, version: string): void
