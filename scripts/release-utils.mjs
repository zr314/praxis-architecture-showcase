const targetDefinitions = {
  'windows-x64': {
    platform: 'win32',
    arch: 'x64',
    bunTarget: 'bun-windows-x64-baseline',
    compilerPackage: '@oven/bun-windows-x64-baseline',
    extension: '.exe',
  },
  'linux-x64': {
    platform: 'linux',
    arch: 'x64',
    bunTarget: 'bun-linux-x64-baseline',
    compilerPackage: '@oven/bun-linux-x64-baseline',
    extension: '',
  },
  'darwin-x64': {
    platform: 'darwin',
    arch: 'x64',
    bunTarget: 'bun-darwin-x64-baseline',
    compilerPackage: '@oven/bun-darwin-x64-baseline',
    extension: '',
  },
  'darwin-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    bunTarget: 'bun-darwin-arm64',
    compilerPackage: '@oven/bun-darwin-aarch64',
    extension: '',
  },
}

export const binaryTargets = Object.freeze(Object.keys(targetDefinitions))

export function artifactForTarget(target, version) {
  const definition = targetDefinitions[target]
  if (!definition) throw new Error(`Unsupported binary target: ${target}`)
  return {
    platform: definition.platform,
    arch: definition.arch,
    bunTarget: definition.bunTarget,
    compilerPackage: definition.compilerPackage,
    filename: `praxis-${version}-${target}${definition.extension}`,
  }
}

export function assertTagVersion(tag, version) {
  if (
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/u.test(
      tag,
    )
  ) {
    throw new Error(`${tag} is not a valid semantic version tag.`)
  }
  if (tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match package version ${version}.`)
  }
}
