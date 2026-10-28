import { createDashboardChatProgramHolds } from './dashboard-chat-program-acquisition'
import { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { useStructuredChatTabNames } from '@/runtime/structured-chat-name-observation'
import type { DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import { buildDashboardSnapshot } from './build-dashboard-snapshot'
import { useChatProgramFactsVersion } from '@/lib/host-chat-program-acquisition'
import { createWorktreeAgentRowsCache } from './worktree-agent-rows-cache'
import { selectAgentLaunchRouteView } from '@/lib/agent-launch-route-input'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

/**
 * Builds the dashboard snapshot directly from the live renderer store for the
 * Agent Dashboard view.
 */
export function useLiveDashboardSnapshot(): DashboardSnapshot {
  const rowsCacheRef = useRef<ReturnType<typeof createWorktreeAgentRowsCache>>(undefined!)
  rowsCacheRef.current ??= createWorktreeAgentRowsCache()
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const unifiedTabsByWorktree = useAppStore((s) => s.unifiedTabsByWorktree)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const retainedAgentsByPaneKey = useAppStore((s) => s.retainedAgentsByPaneKey)
  const migrationUnsupportedByPtyId = useAppStore((s) => s.migrationUnsupportedByPtyId)
  const runtimeAgentOrchestrationByPaneKey = useAppStore(
    (s) => s.runtimeAgentOrchestrationByPaneKey
  )
  const terminalLayoutsByTabId = useAppStore((s) => s.terminalLayoutsByTabId)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const runtimePaneTitlesByTabId = useAppStore((s) => s.runtimePaneTitlesByTabId)
  const acknowledgedAgentsByPaneKey = useAppStore((s) => s.acknowledgedAgentsByPaneKey)
  const hostedReviewCache = useAppStore((s) => s.hostedReviewCache)
  const prCache = useAppStore((s) => s.prCache)
  // Why: controls idle visibility and gates generated conversation names.
  const settings = useAppStore((s) => s.settings)
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  // Why: each card carries the host-input profile its preview terminal keys
  // against, so the dashboard must watch every slice that resolves an execution
  // host. Agent activity alone cannot heal these: a board whose agents are idle
  // never rebuilds, so an SSH handshake or host swap would leave the preview
  // encoding bytes for the host the pty used to run on. All are low-frequency
  // (each writer bails out when nothing changed) next to agentStatusByPaneKey,
  // which already rebuilds this memo on every status ping.
  const detectedWorktreesByRepo = useAppStore((s) => selectDetectedWorktreesByRepo(s))
  // Folder workspace host resolution uses these slices instead of git-worktree rows.
  const folderWorkspaces = useAppStore((s) => selectFolderWorkspaces(s))
  const projectGroups = useAppStore((s) => s.projectGroups)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const sshStateByEnvironment = useAppStore((s) => s.sshStateByEnvironment)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const restoredRuntimeHostIdByWorkspaceSessionKey = useAppStore(
    (s) => s.restoredRuntimeHostIdByWorkspaceSessionKey
  )
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeEnvironmentCatalogHydrated = useAppStore((s) => s.runtimeEnvironmentCatalogHydrated)
  const removedRuntimeEnvironmentIds = useAppStore((s) => s.removedRuntimeEnvironmentIds)
  const paneForegroundAgentByPaneKey = useAppStore((s) => s.paneForegroundAgentByPaneKey)
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const remoteDetectedAgentIds = useAppStore((s) => s.remoteDetectedAgentIds)
  const runtimeDetectedAgentIds = useAppStore((s) => s.runtimeDetectedAgentIds)
  // Freshness can change buckets without map writes; the epoch invalidates stale-decay memos.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  const chatNames = useStructuredChatTabNames()
  // Why: launch options read only this view, so any route input change rebuilds them.
  const launchRouteStore = useAppStore(selectAgentLaunchRouteView)
  const holdsRef = useRef<ReturnType<typeof createDashboardChatProgramHolds> | null>(null)
  useEffect(() => {
    const holds = createDashboardChatProgramHolds()
    holdsRef.current = holds
    return () => {
      holdsRef.current = null
      holds.release()
    }
  }, [])
  const chatProgramFactsVersion = useChatProgramFactsVersion()

  const snapshot = useMemo(
    // Why: Date.now() is read inside the memo (not a dep) so stale-decay
    // recalculates whenever agentStatusEpoch ticks, matching useDashboardData.
    () =>
      buildDashboardSnapshot(
        {
          chatNames,
          repos,
          worktreesByRepo,
          tabsByWorktree,
          unifiedTabsByWorktree,
          agentStatusByPaneKey,
          retainedAgentsByPaneKey,
          migrationUnsupportedByPtyId,
          runtimeAgentOrchestrationByPaneKey,
          terminalLayoutsByTabId,
          ptyIdsByTabId,
          runtimePaneTitlesByTabId,
          acknowledgedAgentsByPaneKey,
          hostedReviewCache,
          prCache,
          settings,
          workspaceStatuses,
          detectedWorktreesByRepo,
          folderWorkspaces,
          projectGroups,
          sshTargetLabels,
          sshConnectionStates,
          sshStateByEnvironment,
          runtimeStatusByEnvironmentId,
          restoredRuntimeHostIdByWorkspaceSessionKey,
          runtimeEnvironments,
          runtimeEnvironmentCatalogHydrated,
          removedRuntimeEnvironmentIds,
          paneForegroundAgentByPaneKey,
          detectedAgentIds,
          remoteDetectedAgentIds,
          runtimeDetectedAgentIds,
          // Read launch identity non-reactively because Shift+Enter routing does not depend on it; match the bridge gate.
          agentLaunchConfigByPaneKey: useAppStore.getState().agentLaunchConfigByPaneKey
        },
        Date.now(),
        // Reuse unchanged worktree rows while assembling cards fresh from current review/host/status slices.
        { rowsCache: rowsCacheRef.current, rowsGeneration: agentStatusEpoch, launchRouteStore }
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      repos,
      worktreesByRepo,
      tabsByWorktree,
      unifiedTabsByWorktree,
      agentStatusByPaneKey,
      retainedAgentsByPaneKey,
      migrationUnsupportedByPtyId,
      runtimeAgentOrchestrationByPaneKey,
      terminalLayoutsByTabId,
      ptyIdsByTabId,
      runtimePaneTitlesByTabId,
      acknowledgedAgentsByPaneKey,
      hostedReviewCache,
      prCache,
      settings,
      workspaceStatuses,
      detectedWorktreesByRepo,
      folderWorkspaces,
      projectGroups,
      sshTargetLabels,
      sshConnectionStates,
      sshStateByEnvironment,
      runtimeStatusByEnvironmentId,
      restoredRuntimeHostIdByWorkspaceSessionKey,
      runtimeEnvironments,
      runtimeEnvironmentCatalogHydrated,
      removedRuntimeEnvironmentIds,
      paneForegroundAgentByPaneKey,
      detectedAgentIds,
      remoteDetectedAgentIds,
      runtimeDetectedAgentIds,
      chatNames,
      chatProgramFactsVersion,
      launchRouteStore,
      agentStatusEpoch
    ]
  )
  // Why: the snapshot memo already re-derives on every input the holds depend on, so it stands in
  // for the popout bridge's store watcher, which the fork deleted.
  useEffect(() => {
    holdsRef.current?.reconcile(useAppStore.getState())
  }, [snapshot])
  return snapshot
}
