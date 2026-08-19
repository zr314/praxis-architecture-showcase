import type { SessionRepository } from '@praxis/core-sdk'
import { RuntimeKernel, type RuntimeKernelOptions } from './framework/runtimeKernel.js'
import {
  isChildBootstrapFailure,
  readChildBootstrapProfileFromProcess,
} from './subagent/childBootstrapProfile.js'
import {
  createChildRuntimeComposition,
  isChildCompositionFailure,
} from './subagent/childComposition.js'

export function runRuntime(): void {
  try {
    const childProfile = readChildBootstrapProfileFromProcess()
    createRuntimeKernel(childProfile ? createChildRuntimeComposition(childProfile) : {}).start()
  } catch (error) {
    if (!isChildBootstrapFailure(error) && !isChildCompositionFailure(error)) throw error
    process.stderr.write(`praxis-runtime: ${error.code}\n`)
    process.exitCode = 1
  }
}

export function createRuntimeKernel(
  options: RuntimeKernelOptions | SessionRepository = {},
): RuntimeKernel {
  return new RuntimeKernel(isSessionRepository(options) ? { sessionRepository: options } : options)
}

function isSessionRepository(
  value: RuntimeKernelOptions | SessionRepository,
): value is SessionRepository {
  return (
    typeof (value as Partial<SessionRepository>).initialize === 'function' &&
    typeof (value as Partial<SessionRepository>).create === 'function'
  )
}
