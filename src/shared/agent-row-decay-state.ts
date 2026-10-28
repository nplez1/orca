import {
  agentStatusEvidenceObservedAt,
  type AgentStatusEntry,
  type AgentStatusState
} from './agent-status-types'
import { formatEphemeralVmRemaining } from './ephemeral-vm-lifetime'

/** Row states: the hook-reported statuses plus the two Orca derives when an entry goes stale. */
export type AgentRowState = AgentStatusState | 'idle' | 'unverifiable'

type DecayInput = Pick<AgentStatusEntry, 'state' | 'restoredUnconfirmed'>

/** Silence proves no completion: live-PTY rows become unverifiable, absent-PTY rows idle. Restored seeds predate this process and have no silence duration to report (ssh-execution-boundary.md). */
export function resolveDecayedAgentRowState(
  entry: DecayInput,
  hasLivePty: boolean
): 'idle' | 'unverifiable' {
  return hasLivePty && entry.state !== 'done' && entry.restoredUnconfirmed !== true
    ? 'unverifiable'
    : 'idle'
}

/** Coarse `34m` / `2h` / `3d` duration, floored so it never overstates the gap. */
export function formatCompactDuration(deltaMs: number): string {
  return formatEphemeralVmRemaining(deltaMs)
}

/** Report last-observed age rather than claiming current activity; the user may know a long-running task Orca cannot verify. */
export function agentNoUpdateLabel(
  entry: Pick<AgentStatusEntry, 'updatedAt' | 'evidenceObservedAt'>,
  now: number
): string {
  return `No update in ${formatCompactDuration(now - agentStatusEvidenceObservedAt(entry))}`
}
