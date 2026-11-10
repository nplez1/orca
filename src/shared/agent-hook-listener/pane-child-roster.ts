import {
  AGENT_DESCENDANT_QUIET_REAP_MS,
  agentDescendantRosterToSnapshots
} from '../agent-descendant-roster'
import {
  continueMainAgentStatus,
  foldAgentLeadStatus
} from '../agent-status/lifecycle/agent-lead-status-fold'
import type { AgentMainAgentStatus } from '../agent-status/lifecycle/main-agent-status'
import { agentChildWorkLiveness } from '../agent-status/child-work/agent-status-child-work-liveness'
import type { AgentSubagentSnapshot } from '../agent-status/contracts/agent-status-subagent-snapshot'
import type {
  AgentStatusState,
  ParsedAgentStatusPayload
} from '../agent-status/contracts/agent-status-types'
import type { HookListenerState } from './listener-state'

/** A child both rosters name: the tracked entry owns its state and tool line, and the reporting lane
 *  fills any label it alone carries — a row named by its description beats one named by its type. */
function withReportedLabels(
  tracked: AgentSubagentSnapshot,
  reported: AgentSubagentSnapshot
): AgentSubagentSnapshot {
  return {
    ...tracked,
    agentType: tracked.agentType ?? reported.agentType,
    description: tracked.description ?? reported.description,
    model: tracked.model ?? reported.model,
    startedAt: tracked.startedAt || reported.startedAt
  }
}

/** The pane's child roster: the live set this lane builds from descendant events, unioned with the
 *  roster the pane's own lane reports on its payload.
 *
 *  One set decides both the row's child list and its state. Two rosters is what let a session read
 *  `done` while the fleet list rendered its child spinning (#283): the display read the payload's own
 *  list while only this lane's list gated the state, so whichever list the other surface did not read
 *  could disagree freely. Roster entries own a shared id — they carry the tool line and the `waiting`
 *  state a child's own stream reported, which the reporting lane cannot know. */
export function paneChildSnapshots(
  state: HookListenerState,
  paneKey: string,
  reported: readonly AgentSubagentSnapshot[] | undefined
): AgentSubagentSnapshot[] {
  const tracked =
    agentDescendantRosterToSnapshots(state.descendantRosterByPaneKey.get(paneKey)) ?? []
  if (!reported || reported.length === 0) {
    return tracked
  }
  const reportedById = new Map(reported.map((child) => [child.id, child]))
  const trackedIds = new Set(tracked.map((child) => child.id))
  const merged = tracked.map((child) => {
    const alsoReported = reportedById.get(child.id)
    return alsoReported ? withReportedLabels(child, alsoReported) : child
  })
  merged.push(...reported.filter((child) => !trackedIds.has(child.id)))
  // Why one order: a reader must not see a child move because the other roster happened to speak.
  return merged.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
}

/** Record what the pane's own lane last said about its children. An empty or absent list is the
 *  lane saying it has none, so it clears rather than carries. */
export function rememberReportedChildren(
  state: HookListenerState,
  paneKey: string,
  reported: readonly AgentSubagentSnapshot[] | undefined,
  now: number
): void {
  if (!reported || reported.length === 0) {
    state.reportedSubagentsByPaneKey.delete(paneKey)
    return
  }
  state.reportedSubagentsByPaneKey.set(paneKey, { children: [...reported], at: now })
}

/** Those children, while the claim is still inside the roster's quiet window. A child event carries
 *  no roster of its own, so without this it would republish the row with them missing — the mid-run
 *  disappearance this roster exists to prevent. */
export function carriedReportedChildren(
  state: HookListenerState,
  paneKey: string,
  now: number
): AgentSubagentSnapshot[] | undefined {
  const reported = state.reportedSubagentsByPaneKey.get(paneKey)
  if (!reported) {
    return undefined
  }
  if (now - reported.at > AGENT_DESCENDANT_QUIET_REAP_MS) {
    state.reportedSubagentsByPaneKey.delete(paneKey)
    return undefined
  }
  return reported.children
}

/** The outcome a previous `done` verdict already stated, when it stated one. */
function previousDoneOutcome(previous: AgentMainAgentStatus | undefined): {
  outcome?: AgentMainAgentStatus['outcome']
} {
  return previous?.state === 'done' && previous.outcome !== undefined
    ? { outcome: previous.outcome }
    : {}
}

/** Publish one row from one child roster: the state and the child list a reader renders come out of
 *  the same list, through the same fold every other lane uses.
 *
 *  `workingMode`, `sessionBoundary` and `interrupted` are the fold's to write. A row the fold no
 *  longer holds as a monitor must not keep the badge, and a boundary or an interrupt describes a row
 *  that is still settling — a client without the boundary capability drops a flagged tab's whole
 *  status, so neither flag may ride on a row the fold turned live.
 *
 *  A row the fold held open publishes the lead's own verdict as `mainAgent`. Readers that key on it —
 *  `programStatusHookYieldEndsAt` above all — otherwise read the held state as a working lead, hand
 *  the pane to its terminal status once the hooks go quiet, and the pane reads `done` beside a child
 *  that is still running while its row disappears (#197). */
export function resolvePaneHold(
  payload: ParsedAgentStatusPayload,
  leadState: AgentStatusState,
  children: readonly AgentSubagentSnapshot[],
  /** A wait this lane recorded for a provider that owns its own roster, which lists no child row. */
  waitingWithoutChildRow = false,
  /** The held row's own history: the lead verdict last published for it, and the clock to date it by. */
  held: { previousMainAgent?: AgentMainAgentStatus; now?: number } = {}
): ParsedAgentStatusPayload {
  const resolution = foldAgentLeadStatus({
    leadState,
    childWorkLiveness: agentChildWorkLiveness([
      ...children.map((child) => ({ kind: 'agent' as const, state: child.state })),
      ...(waitingWithoutChildRow ? [{ kind: 'agent' as const, state: 'waiting' as const }] : [])
    ])
  })
  return {
    ...payload,
    state: resolution.stateName,
    workingMode: resolution.workingMode,
    sessionBoundary: resolution.stateName === 'done' ? payload.sessionBoundary : undefined,
    interrupted: resolution.stateName === 'done' ? payload.interrupted : undefined,
    subagents: children.length > 0 ? [...children] : undefined,
    // Why only a finished lead: a hold over a lead that is still working asserts nothing a reader
    // needs, and every consumer of `mainAgent` asks the same question — was this turn over?
    ...(leadState === 'done' && resolution.stateName !== 'done'
      ? {
          // Why the payload's own verdict first: a provider that owns its roster (grok) states the
          // outcome and the turn's own end here, and replacing it would drop both.
          mainAgent:
            payload.mainAgent?.state === 'done'
              ? payload.mainAgent
              : continueMainAgentStatus(
                  held.previousMainAgent,
                  {
                    state: 'done',
                    // Why the previous verdict's outcome rides too: this call site builds a fresh
                    // payload with no `mainAgent`, so a re-hold of a verdict a roster-owning lane
                    // already stated (grok's failed turn, asked about again) would otherwise drop
                    // the outcome the first hold carried.
                    ...previousDoneOutcome(held.previousMainAgent),
                    // Why the turn's own completion time and nothing else: a re-hold of the same
                    // finished turn keeps its clock through the previous `done` row, and a row
                    // whose lead was not done cannot date this one.
                    ...(payload.turnCompletedAt !== undefined
                      ? { stateStartedAt: payload.turnCompletedAt }
                      : {})
                  },
                  held.now ?? Date.now()
                )
        }
      : {})
  }
}
