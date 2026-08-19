import { useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeBridge, SessionEvent, WorkflowUpdateV1 } from '@praxis/protocol'
import { type WorkflowPlanView, workflowPlanGraph } from './tuiModel.js'

/** Keeps durable PlanGraph state separate from the bounded transcript event buffer. */
export function useWorkflowGraph(
  bridge: RuntimeBridge,
  sessionId: string,
  runtimeEpoch: number,
  events: readonly SessionEvent[],
): WorkflowPlanView | undefined {
  const [snapshot, setSnapshot] = useState<WorkflowPlanView>()
  const requestedPlanId = useRef<string | undefined>(undefined)
  const livePlanId = latestPlanId(events)

  useEffect(() => {
    void runtimeEpoch
    let cancelled = false
    setSnapshot(undefined)
    requestedPlanId.current = undefined
    void bridge
      .listWorkflows(sessionId)
      .then((workflows) => {
        if (cancelled) return
        const parsed = workflows[0] === undefined ? undefined : workflowPlan(workflows[0])
        if (parsed !== undefined) {
          requestedPlanId.current = parsed.planId
          setSnapshot(parsed)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [bridge, runtimeEpoch, sessionId])

  useEffect(() => {
    if (livePlanId === undefined || requestedPlanId.current === livePlanId) return
    requestedPlanId.current = livePlanId
    let cancelled = false
    void bridge
      .getWorkflow(livePlanId)
      .then((value) => {
        if (cancelled) return
        const parsed = workflowPlan(value)
        if (parsed?.planId === livePlanId) setSnapshot(parsed)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [bridge, livePlanId])

  return useMemo(() => workflowPlanGraph(events, snapshot), [events, snapshot])
}

function latestPlanId(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'workflow_update') return event.update.workflowId
    if (event?.type === 'supervisor_update') return event.update.correlation.planId
  }
  return undefined
}

function workflowPlan(update: WorkflowUpdateV1): WorkflowPlanView {
  return {
    planId: update.workflowId,
    state: update.state,
    objective: update.objective,
    steps: update.nodes.map((node, order) => ({
      stepId: node.nodeId,
      title: node.title,
      kind: node.kind,
      order,
      state: node.state,
      ...(node.errorCode === undefined ? {} : { errorCode: node.errorCode }),
    })),
  }
}
