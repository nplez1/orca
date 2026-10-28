import type { TuiAgent } from '../../../../shared/tui-agent'
import { normalizeDisabledTuiAgents } from '../../../../shared/tui-agent-selection'
import {
  getRuntimeAgentInventoryEnvironmentId,
  getRuntimeAgentInventoryWorktreeId
} from './runtime-agent-inventory-key'

/** The cached per-host inventories an enable should re-probe. */
export type AgentInventoryRefreshState = {
  refreshDetectedAgents: (worktreeId?: string | null) => Promise<TuiAgent[]>
  remoteDetectedAgentIds: Readonly<Record<string, TuiAgent[] | null>>
  refreshRemoteDetectedAgents: (connectionId: string) => Promise<TuiAgent[]>
  runtimeDetectedAgentIds: Readonly<Record<string, TuiAgent[] | null>>
  refreshRuntimeDetectedAgents: (
    environmentId: string,
    worktreeId?: string | null
  ) => Promise<TuiAgent[]>
}

/** The two settings fields an enable is read from; unknown so a malformed persisted list is testable. */
type AgentEnablementSettings = { disabledTuiAgents?: unknown } | null | undefined

/** True when a settings write re-enabled at least one agent. */
export function enablesNewTuiAgents(
  before: AgentEnablementSettings,
  after: AgentEnablementSettings
): boolean {
  const wasDisabled = new Set(normalizeDisabledTuiAgents(before?.disabledTuiAgents))
  const nowDisabled = new Set(normalizeDisabledTuiAgents(after?.disabledTuiAgents))
  for (const agent of wasDisabled) {
    if (!nowDisabled.has(agent)) {
      return true
    }
  }
  return false
}

/**
 * Why: an agent is normally enabled because it is already installed, and every host's
 * list is a one-time read. Re-probe each host someone has already looked at so the
 * new-tab menu and the default pills offer the agent without a restart. Each refresh
 * hits its own host, and one that rejects keeps the cached list it already had.
 */
export function refreshDetectedAgentInventories(state: AgentInventoryRefreshState): void {
  void state.refreshDetectedAgents().catch(() => [])
  for (const [connectionId, cached] of Object.entries(state.remoteDetectedAgentIds)) {
    // Why skip null: a list nobody has read yet is already being probed by its surface.
    if (cached !== null) {
      void state.refreshRemoteDetectedAgents(connectionId).catch(() => [])
    }
  }
  for (const [key, cached] of Object.entries(state.runtimeDetectedAgentIds)) {
    if (cached !== null) {
      void state
        .refreshRuntimeDetectedAgents(
          getRuntimeAgentInventoryEnvironmentId(key),
          getRuntimeAgentInventoryWorktreeId(key)
        )
        .catch(() => [])
    }
  }
}
