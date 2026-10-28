import type { TuiAgent } from '../../../../shared/tui-agent'
import { normalizeDisabledTuiAgents } from '../../../../shared/tui-agent-selection'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo,
  type WorkspaceRecordState
} from '../workspace-record-selectors'
import {
  getRuntimeAgentInventoryEnvironmentId,
  getRuntimeAgentInventoryWorktreeId,
  getRuntimeAgentInventoryKey
} from './runtime-agent-inventory-key'

/** The cached per-host inventories an enable re-reads, plus the local workspaces that name them. */
export type AgentInventoryRefreshState = WorkspaceRecordState & {
  refreshDetectedAgents: (worktreeId?: string | null, isolated?: boolean) => Promise<TuiAgent[]>
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

/** Every local workspace, named the way a runtime context resolves it. */
function localWorkspaceIds(state: WorkspaceRecordState): string[] {
  const worktrees = Object.values(selectWorktreesByRepo(state)).flatMap((perRepo) => perRepo)
  return [
    ...worktrees.map((worktree) => worktree.id),
    // Why the key: a folder workspace answers to `folder:<id>`, and a bare id resolves as none.
    ...selectFolderWorkspaces(state).map((folder) => folderWorkspaceKey(folder.id))
  ]
}

/** Schedules one host's re-read; a probe that cannot even start must not fail the write. */
function scheduleReRead(run: () => Promise<TuiAgent[]>): void {
  try {
    void run().catch(() => [])
  } catch (error) {
    console.error('Failed to re-detect agents after an enable:', error)
  }
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
  if (!runtimeEnvironmentId) {
    // Why per workspace rather than once: a Windows project's own runtime (native or a WSL
    // distro) names its own context, and only the focused one is reachable without an id.
    // Isolated, because a background context must not blank the shared field; and they
    // collapse to one probe each, so the host these surfaces share is read once.
    for (const worktreeId of localWorkspaceIds(state)) {
      scheduleReRead(() => state.refreshDetectedAgents(worktreeId, true))
    }
    // Why last: the focused context is the one the shared `detectedAgentIds` field mirrors.
    scheduleReRead(() => state.refreshDetectedAgents())
    for (const [connectionId, cached] of Object.entries(state.remoteDetectedAgentIds)) {
      // Why skip null: a list nobody has read yet is already being probed by its surface.
      if (cached !== null) {
        scheduleReRead(() => state.refreshRemoteDetectedAgents(connectionId))
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
    scheduleReRead(() =>
      state.refreshRuntimeDetectedAgents(
        getRuntimeAgentInventoryEnvironmentId(key),
        getRuntimeAgentInventoryWorktreeId(key)
      )
    )
  }
}
