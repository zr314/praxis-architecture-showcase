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

export { RuntimeKernel, type RuntimeKernelOptions } from './framework/runtimeKernel.js'
export type {
  RuntimeMiddleware,
  RuntimeMiddlewareHealth,
  RuntimeMiddlewareHealthSnapshot,
  RuntimeMiddlewareHook,
  RuntimeMiddlewareHookHealth,
  RuntimeMiddlewarePolicy,
  RuntimeMiddlewarePolicyOptions,
  RuntimeMiddlewareRegistry,
  RuntimeModelMiddlewareContext,
  RuntimeToolCallUpdate,
  RuntimeToolMiddlewareContext,
} from './framework/runtimeMiddleware.js'
export { type MemoryAccessV1, MemoryServiceV1 } from './long-term-memory/memoryService.js'
export { generateRecap } from './recap/providerRecapGenerator.js'
export type {
  RecapKind,
  RecapNote,
  RecapSnapshot,
  RecapSource,
  RecapStrategy,
} from './recap/recap.js'
export {
  makeRecapSnapshot,
  recapSource,
  validateRecapSnapshot,
  validateRecapSource,
} from './recap/recap.js'
export type { RecapContext } from './recap/recapContext.js'
export type { RegisteredReviewCheckV1 } from './review-plan/registeredChecks.js'

export function runRuntime(options: RuntimeKernelOptions = {}): void {
  try {
    const childProfile = readChildBootstrapProfileFromProcess()
    createRuntimeKernel(
      childProfile
        ? createChildRuntimeComposition(childProfile, {
            middlewareRegistry: options.childMiddleware?.registry,
          })
        : options,
    ).start()
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
