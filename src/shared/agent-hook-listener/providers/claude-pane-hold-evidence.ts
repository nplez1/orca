import { foldAgentLeadStatus, type AgentLeadStatusResolution } from '../../agent-lead-status-fold'
import { agentChildWorkLivenessFromEvidence } from '../../agent-status-child-work-liveness'
import {
  claudeLiveOwedTaskNotificationKinds,
  claudeTasksAwaitAgents
} from '../../claude-owed-task-notifications'
import { claudeRosterHasWorkingSubagent } from '../../claude-subagent-roster'
import type { ClaudeLeadTurnState, HookListenerState } from '../listener-state'
import { mainAgentIdleSince } from '../main-agent-turn-state'

/** Everything that can hold a pane whose main agent's own turn is over. */
type ClaudePaneHoldEvidence = {
  /** A sub-agent the roster tracks as working, or a shell waiting on worker agents. */
  runningAgent: boolean
  /** A running shell or a scheduled session cron. */
  runningNonAgent: boolean
  /** An ended sub-agent / shell whose notification Claude has not delivered yet. */
  owedAgent: boolean
  owedShell: boolean
}

/** Share hold evidence across fold/row flags/announcements; mainAgent may not yet be recorded for this event. */
export function claudePaneHoldEvidence(
  state: HookListenerState,
  paneKey: string,
  mainAgent: Pick<ClaudeLeadTurnState, 'state'> | undefined = state.claudeLeadStateByPaneKey.get(
    paneKey
  )
): ClaudePaneHoldEvidence {
  const launched = state.claudeLaunchedBackgroundTasksByPaneKey.get(paneKey)
  const owed = claudeLiveOwedTaskNotificationKinds(
    launched,
    mainAgent?.state === 'done',
    mainAgentIdleSince(state.claudeLeadStateByPaneKey.get(paneKey))
  )
  return {
    runningAgent:
      claudeRosterHasWorkingSubagent(state.claudeSubagentRosterByPaneKey.get(paneKey)) ||
      claudeTasksAwaitAgents(launched),
    runningNonAgent:
      state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) ||
      state.claudeActiveSessionCronPaneKeys.has(paneKey),
    owedAgent: owed.agent,
    owedShell: owed.shell
  }
}

/** Restate unlisted live work so restarts/relays cannot settle a main agent still awaiting wakeup. */
export function claudeRowHasUnlistedLiveWork(state: HookListenerState, paneKey: string): boolean {
  const held = claudePaneHoldEvidence(state, paneKey)
  return held.runningNonAgent || held.owedAgent || held.owedShell
}

/** Only running work earns a held-turn completion announcement; owed notifications will wake the lead shortly. */
export function claudePaneHasRunningChildWork(state: HookListenerState, paneKey: string): boolean {
  const held = claudePaneHoldEvidence(state, paneKey)
  return held.runningAgent || held.runningNonAgent
}

export type ClaudePaneStatusResolution = AgentLeadStatusResolution & {
  claudeTaskWakeupPending?: 'notification' | 'finishing-turn'
  /** The fork reads a background shell as agent work, so the hold earns no `workingMode`; turn completion still needs upstream's monitoring verdict. */
  claudeMonitoringEquivalentHold?: true
}

export function resolveClaudePaneStatus(
  state: HookListenerState,
  paneKey: string,
  lead: Pick<ClaudeLeadTurnState, 'state' | 'taskWakeupTurn' | 'waitingAgentId' | 'stateBeforeWait'>
): ClaudePaneStatusResolution {
  // Tasks still owe main-agent notifications after ending; those wakeup turns keep the pane live.
  const held = claudePaneHoldEvidence(state, paneKey, lead)
  const own = lead.waitingAgentId !== undefined ? lead.stateBeforeWait : lead
  // LOCAL(nplez1): only a plain running shell is reclassified as agent work, and upstream would have
  // called that hold monitoring (see LOCAL-PATCHES.md § local(agents)).
  const shellHeldAsAgentWork =
    state.claudeRunningNonAgentTaskPaneKeys.has(paneKey) && !held.runningAgent && !held.owedAgent
  return {
    ...foldAgentLeadStatus({
      leadState: lead.state,
      childWorkLiveness: agentChildWorkLivenessFromEvidence({
        // Child waits displace the lead record; the roster carries none.
        hasWaitingChildWork: false,
        // LOCAL(nplez1): a background shell the agent started is agent work, so it reads plain
        // `working`; only a Claude session-cron callback earns the monitoring badge (see
        // LOCAL-PATCHES.md § local(agents)). Upstream's *owed* notification evidence stays where
        // upstream put it — `owedShell` on the non-agent side — because an owed shell is a pending
        // wake-up rather than the running shell the policy is about.
        hasLiveAgentWork:
          held.runningAgent ||
          held.owedAgent ||
          state.claudeRunningNonAgentTaskPaneKeys.has(paneKey),
        hasLiveNonAgentWork: state.claudeActiveSessionCronPaneKeys.has(paneKey) || held.owedShell
      })
    }),
    ...(shellHeldAsAgentWork ? { claudeMonitoringEquivalentHold: true as const } : {}),
    ...(held.owedAgent || held.owedShell
      ? { claudeTaskWakeupPending: 'notification' as const }
      : own?.state !== 'done' && own?.taskWakeupTurn
        ? { claudeTaskWakeupPending: 'finishing-turn' as const }
        : {})
  }
}
