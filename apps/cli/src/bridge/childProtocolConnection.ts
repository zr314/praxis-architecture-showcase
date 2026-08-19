import { RuntimeProtocolConnection } from '@praxis/runtime/process'

/** CLI-owned launch wrapper for the shared formal Runtime protocol connection. */
export class ChildProtocolConnection extends RuntimeProtocolConnection {
  constructor(command: string, args: string[], env?: NodeJS.ProcessEnv) {
    super(command, args, { env, stderr: 'inherit' })
  }
}
