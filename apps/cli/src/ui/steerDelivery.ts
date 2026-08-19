import type { RuntimeBridge } from '@praxis/protocol'

export async function deliverSteer(
  bridge: Pick<RuntimeBridge, 'steer'>,
  input: { sessionId: string; runId: string; text: string },
): Promise<'steered' | 'run-ended'> {
  try {
    await bridge.steer(input)
    return 'steered'
  } catch (error) {
    if (runtimeFailureCode(error) === 'RUN_NOT_ACTIVE') return 'run-ended'
    throw error
  }
}

export function runtimeFailureCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  if ('code' in error && typeof error.code === 'string') return error.code
  if (!('rpc' in error) || !error.rpc || typeof error.rpc !== 'object') return undefined
  return 'code' in error.rpc && typeof error.rpc.code === 'string' ? error.rpc.code : undefined
}
