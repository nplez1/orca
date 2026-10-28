import type { TuiAgent } from '../../../../shared/tui-agent'
import { normalizeDisabledTuiAgents } from '../../../../shared/tui-agent-selection'
import {
  getRuntimeAgentInventoryEnvironmentId,
  getRuntimeAgentInventoryWorktreeId,
  getRuntimeAgentInventoryKey
} from './runtime-agent-inventory-key'

/** The cached per-host inventories an enable re-reads, plus the local workspaces that name them. */
export type AgentInventoryRefreshState = {
  worktreesByRepo: Readonly<Record<string, readonly { id: string }[]>>
  folderWorkspaces: readonly { id: string }[]
  refreshDetectedAgents: (worktreeId?: string | null) => Promise<TuiAgent[]>
  remoteDetectedAgentIds: Readonly<Record<string, TuiAgent[] | null>>
  refreshRemoteDetectedAgents: (connectionId: string) => Promise<TuiAgent[]>
  runtimeDetectedAgentIds: Readonly<Record<string, TuiAgent[] | null>>
  refreshRuntimeDetectedAgents: (
    environmentId: string,
    worktreeId?: string | null
  ) => Promise<TuiAgent[]>
}

/** The settings an enable is read from, unknown so a malformed persisted list stays testable. */
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

/** Every local workspace id, which is how a local runtime context (a WSL distro) is named. */
function localWorkspaceIds(state: AgentInventoryRefreshState): string[] {
  return [
    ...Object.values(state.worktreesByRepo).flatMap((worktrees) => worktrees.map((w) => w.id)),
    ...state.folderWorkspaces.map((folder) => folder.id)
  ]
}

/**
 * Why: an agent is normally enabled because it is already installed, and every host's list is a
 * one-time read. Re-read each inventory someone has already looked at so the new-tab menu and the
 * default pills offer the agent without a restart. Each re-read hits its own host, and one that
 * rejects keeps the list it already had.
 *
 * `runtimeEnvironmentId` narrows the work to one paired host, for the settings page of a host whose
 * enable arrives over RPC instead of as a local settings write.
 */
export function refreshDetectedAgentInventories(
  state: AgentInventoryRefreshState,
  options: { runtimeEnvironmentId?: string } = {}
): void {
  const { runtimeEnvironmentId } = options
  try {
    if (!runtimeEnvironmentId) {
      // Why per workspace rather than once: a Windows project's own runtime (native or a WSL
      // distro) names its own context, and only the focused one is reachable without an id.
      // They collapse to one probe each, so the host these surfaces share is read once.
      for (const worktreeId of localWorkspaceIds(state)) {
        void state.refreshDetectedAgents(worktreeId).catch(() => [])
      }
      // Why last: the focused context is the one the shared `detectedAgentIds` field mirrors.
      void state.refreshDetectedAgents().catch(() => [])
      for (const [connectionId, cached] of Object.entries(state.remoteDetectedAgentIds)) {
        // Why skip null: a list nobody has read yet is already being probed by its surface.
        if (cached !== null) {
          void state.refreshRemoteDetectedAgents(connectionId).catch(() => [])
        }
      }
    }
    // A paired host's default list and each of its workspaces are separate caches.
    const inventories = new Set<string>(
      runtimeEnvironmentId ? [getRuntimeAgentInventoryKey(runtimeEnvironmentId)] : []
    )
    for (const [key, cached] of Object.entries(state.runtimeDetectedAgentIds)) {
      const sameHost =
        !runtimeEnvironmentId || getRuntimeAgentInventoryEnvironmentId(key) === runtimeEnvironmentId
      if (cached !== null && sameHost) {
        inventories.add(key)
      }
    }
    for (const key of inventories) {
      void state
        .refreshRuntimeDetectedAgents(
          getRuntimeAgentInventoryEnvironmentId(key),
          getRuntimeAgentInventoryWorktreeId(key)
        )
        .catch(() => [])
    }
  } catch (error) {
    // Why: the enabling write already landed; failing to schedule a probe is not a failed save.
    console.error('Failed to re-detect agents after an enable:', error)
  }
}
