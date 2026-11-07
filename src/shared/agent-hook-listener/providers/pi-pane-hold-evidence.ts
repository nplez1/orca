import {
  continueMainAgentStatus,
  foldAgentLeadStatus,
  type AgentLeadStatusResolution
} from '../../agent-lead-status-fold'
import { agentChildWorkLivenessFromEvidence } from '../../agent-status-child-work-liveness'
import type { AgentStatusState, ParsedAgentStatusPayload } from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import { readPiScheduledWork, type PiScheduledJob } from '../pi-scheduled-work'

/** Everything that can hold a Pi pane whose lead turn is over. */
type PiPaneHoldEvidence = {
  /** A live child the descendant roster still tracks; #283 supplies this input to the fold. */
  runningAgent: boolean
  /** A loop, wakeup or cold job this session's inventory still reports armed. */
  scheduledWork: boolean
}

/** Only scheduled work earns the monitoring badge: it accrues no working time, and the monitor wakes the
 *  row again. Agent work outranks it, so a live child still reads plain `working`. */
export function resolvePiPaneStatus(
  leadState: AgentStatusState,
  held: PiPaneHoldEvidence
): AgentLeadStatusResolution {
  return foldAgentLeadStatus({
    leadState,
    childWorkLiveness: agentChildWorkLivenessFromEvidence({
      hasWaitingChildWork: false,
      hasLiveAgentWork: held.runningAgent,
      hasLiveNonAgentWork: held.scheduledWork
    })
  })
}

/** Keep the inventory the pane was last told about.
 *
 *  Why cached rather than read from the event: a republish can be triggered by something that carries no
 *  inventory at all — a descendant draining, a resumed session's placeholder, a child's own hook post —
 *  and reading absence there would drop a hold nothing has cleared. Every post from the current extension
 *  carries the field, so absence on a pi post is an older build: clear, and read as today. */
export function recordPiScheduledWork(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): void {
  const jobs = readPiScheduledWork(hookPayload)
  if (jobs === null || jobs.length === 0) {
    state.piScheduledWorkByPaneKey.delete(paneKey)
    return
  }
  state.piScheduledWorkByPaneKey.set(paneKey, jobs)
}

/** Hold a finished Pi turn open while its session still has scheduled work armed.
 *
 *  Runs on the payload the descendant gate produced, never before it: the gate records the lead's own
 *  verdict, and a fold applied first would teach it that a finished turn was working.
 *
 *  The held row publishes `mainAgent.state === 'done'` — the lead's verdict the fold consumed. A
 *  restatement needs it to recover that verdict instead of re-reading `working` and pinning the badge,
 *  and `programStatusHookYieldEndsAt` needs it to keep hook precedence past the 2-minute silence window. */
export function applyPiScheduledWorkHold(
  state: HookListenerState,
  paneKey: string,
  payload: ParsedAgentStatusPayload | null,
  now = Date.now()
): ParsedAgentStatusPayload | null {
  if (!payload) {
    return payload
  }
  // Why: a boundary row states the session is gone; scheduled work belonging to it cannot outlive it.
  if (payload.sessionBoundary === true) {
    return payload
  }
  const previousMainAgent = state.lastStatusByPaneKey.get(paneKey)?.payload.mainAgent
  const jobs: readonly PiScheduledJob[] = state.piScheduledWorkByPaneKey.get(paneKey) ?? []
  const resolution = resolvePiPaneStatus(payload.state, {
    runningAgent: false,
    scheduledWork: jobs.length > 0
  })
  if (resolution.stateName === payload.state) {
    return payload
  }
  return {
    ...payload,
    state: resolution.stateName,
    workingMode: resolution.workingMode,
    // Why the previous row: a re-hold of the same finished turn keeps its clock, so the turn-news
    // listener cannot read a fresh stamp as a turn that has just ended.
    mainAgent: continueMainAgentStatus(
      previousMainAgent,
      {
        state: 'done',
        stateStartedAt: payload.turnCompletedAt ?? previousMainAgent?.stateStartedAt
      },
      now
    )
  }
}
