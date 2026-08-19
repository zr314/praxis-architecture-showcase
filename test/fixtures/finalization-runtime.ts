import { existsSync, writeFileSync } from 'node:fs'
import type { ProviderUsage, SessionRecord } from '@praxis/core-sdk'
import { RuntimeKernel } from '../../apps/runtime/src/framework/runtimeKernel.js'
import { JsonlRepository } from '../../apps/runtime/src/session-db/index.js'

class FinalizationRepository extends JsonlRepository {
  private gated = false
  private failed = false

  override async updateTerminal(
    sessionId: string,
    terminal: NonNullable<SessionRecord['lastTerminalState']>,
    usage: ProviderUsage,
    messageCount: number,
  ): Promise<SessionRecord> {
    const gate = process.env.PRAXIS_FINALIZATION_GATE
    if (gate && !this.gated) {
      this.gated = true
      writeFileSync(`${gate}.started`, 'started')
      while (!existsSync(`${gate}.release`)) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    if (process.env.PRAXIS_FINALIZATION_FAIL_ONCE === '1' && !this.failed) {
      this.failed = true
      throw new Error('private terminal persistence failure')
    }
    return super.updateTerminal(sessionId, terminal, usage, messageCount)
  }
}

new RuntimeKernel({ sessionRepository: new FinalizationRepository() }).start()
