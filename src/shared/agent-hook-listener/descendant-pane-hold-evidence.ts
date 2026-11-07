import type { AgentSubagentSnapshot } from '../agent-status-subagent-snapshot'
import {
  agentChildWorkLiveness,
  agentChildWorkLivenessFromEvidence,
  type AgentChildWorkLiveness
} from '../agent-status-child-work-liveness'

/** Everything that can hold a pane open whose lead agent's own turn is over.
 *
 *  The generic lane's analogue of `providers/claude-pane-hold-evidence.ts`, and the seam a second
 *  evidence class joins: scheduled work becomes `hasLiveNonAgentWork` here — `working` plus
 *  `workingMode: 'monitoring'` through `foldAgentLeadStatus` — instead of a bespoke hold beside this
 *  one. A provider contributes evidence, never its own fold. */
export type PaneHoldEvidence = {
  /** A child the pane's roster lists as still running. */
  runningAgent: boolean
  /** A running child blocked on a human answer, which outranks the lead's own verdict. */
  waitingAgent: boolean
}

/** Classify a published child roster once, so the row's state and its child rows read one list. */
export function paneHoldEvidence(
  children: readonly Pick<AgentSubagentSnapshot, 'state'>[] | undefined
): PaneHoldEvidence {
  const liveness = agentChildWorkLiveness(
    children?.map((child) => ({ kind: 'agent' as const, state: child.state }))
  )
  return { runningAgent: liveness !== null, waitingAgent: liveness === 'waiting' }
}

/** The fold's child-work input. Every child this lane lists is agent work, so it never earns
 *  `monitoring` — that badge stays reserved for the Claude session-cron evidence. */
export function paneChildWorkLiveness(evidence: PaneHoldEvidence): AgentChildWorkLiveness {
  return agentChildWorkLivenessFromEvidence({
    hasWaitingChildWork: evidence.waitingAgent,
    hasLiveAgentWork: evidence.runningAgent,
    hasLiveNonAgentWork: false
  })
}
