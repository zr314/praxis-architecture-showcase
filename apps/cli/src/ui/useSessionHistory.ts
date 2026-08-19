import { useEffect, useState } from 'react'
import type { RuntimeBridge, SessionEvent } from '@praxis/protocol'
import { sessionMessagesToEvents } from './sessionTranscript.js'

const HISTORY_PAGE_MESSAGES = 200

/** Owns bounded durable transcript loading and Runtime-epoch resynchronization. */
export function useSessionHistory(
  bridge: RuntimeBridge,
  sessionId: string,
  runtimeEpoch: number,
): SessionEvent[] {
  const [events, setEvents] = useState<SessionEvent[]>([])

  useEffect(() => {
    void runtimeEpoch
    let cancelled = false
    setEvents([])
    void bridge
      .transcriptSession(sessionId, undefined, HISTORY_PAGE_MESSAGES)
      .then((page) => {
        if (cancelled) return
        const history = sessionMessagesToEvents(sessionId, page.messages)
        setEvents(
          page.hasMore
            ? [
                {
                  type: 'runtime_warning',
                  code: 'SESSION_HISTORY_BOUNDED',
                  message: `Showing the latest ${page.messages.length} of ${page.totalMessages} persisted messages.`,
                },
                ...history,
              ]
            : history,
        )
      })
      .catch((error) => {
        if (cancelled) return
        setEvents([
          {
            type: 'runtime_warning',
            code: 'SESSION_HISTORY_LOAD_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        ])
      })

    return () => {
      cancelled = true
    }
  }, [bridge, runtimeEpoch, sessionId])

  return events
}
