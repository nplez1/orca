import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { buildByIdIndex, buildWorktreeByIdIndex } from '../slices/worktree-by-id-index'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { selectWorktreesByRepo } from '../workspace-record-selectors'

export type PersistedTerminalHints = {
  tabsByWorktree: Record<string, TerminalTab[]> | null
  ptyIdsByTabId: Record<string, string[]> | null
}

export function buildPersistedTerminalHints({
  ids,
  pendingReconnectTabByWorktree,
  pendingReconnectPtyIdByTabId,
  terminalLayoutsByTabId,
  tabsByWorktree,
  ptyIdsByTabId
}: {
  ids: readonly string[]
  pendingReconnectTabByWorktree: Record<string, string[]>
  pendingReconnectPtyIdByTabId: Record<string, string>
  terminalLayoutsByTabId: TerminalSlice['terminalLayoutsByTabId']
  tabsByWorktree: Record<string, TerminalTab[]>
  ptyIdsByTabId: Record<string, string[]>
}): PersistedTerminalHints {
  let nextTabsByWorktree: Record<string, TerminalTab[]> | null = null
  let nextPtyIdsByTabId: Record<string, string[]> | null = null
  for (const worktreeId of ids) {
    const tabs = tabsByWorktree[worktreeId] ?? []
    const targetTabIds = pendingReconnectTabByWorktree[worktreeId] ?? []
    const tabById = targetTabIds.length > 1 ? buildByIdIndex(tabs) : null
    const tabsToReconnect: TerminalTab[] =
      targetTabIds.length > 0
        ? targetTabIds
            .map((id) => (tabById ? tabById.get(id) : tabs.find((t) => t.id === id)))
            .filter((t): t is TerminalTab => t != null)
        : tabs.slice(0, 1)
    if (tabsToReconnect.length === 0) {
      continue
    }
    for (const tab of tabsToReconnect) {
      const tabId = tab.id
      const leafPtyMap = terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
      const tabLevelPtyId = pendingReconnectPtyIdByTabId[tabId]
      const allPtyIds =
        Object.keys(leafPtyMap).length > 0
          ? (Object.values(leafPtyMap).filter(Boolean) as string[])
          : tabLevelPtyId
            ? [tabLevelPtyId]
            : []
      if (allPtyIds.length > 0) {
        nextPtyIdsByTabId ??= { ...ptyIdsByTabId }
        nextPtyIdsByTabId[tabId] = allPtyIds
      }
      if (tabLevelPtyId) {
        nextTabsByWorktree ??= { ...tabsByWorktree }
        const nextTabs = nextTabsByWorktree[worktreeId]
        if (!nextTabs) {
          continue
        }
        nextTabsByWorktree[worktreeId] = nextTabs.map((candidate) =>
          candidate.id === tabId ? { ...candidate, ptyId: tabLevelPtyId } : candidate
        )
      }
    }
  }
  return { tabsByWorktree: nextTabsByWorktree, ptyIdsByTabId: nextPtyIdsByTabId }
}

export function createWorkspaceTerminalReconnectActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'publishPersistedTerminalHints' | 'reconnectPersistedTerminals'> {
  return {
    publishPersistedTerminalHints: () => {
      const state = get()
      const hints = buildPersistedTerminalHints({
        ids: state.pendingReconnectWorktreeIds,
        pendingReconnectTabByWorktree: state.pendingReconnectTabByWorktree,
        pendingReconnectPtyIdByTabId: state.pendingReconnectPtyIdByTabId,
        terminalLayoutsByTabId: state.terminalLayoutsByTabId,
        tabsByWorktree: state.tabsByWorktree,
        ptyIdsByTabId: state.ptyIdsByTabId
      })
      if (!hints.tabsByWorktree && !hints.ptyIdsByTabId) {
        return
      }
      set({
        ...(hints.tabsByWorktree ? { tabsByWorktree: hints.tabsByWorktree } : {}),
        ...(hints.ptyIdsByTabId ? { ptyIdsByTabId: hints.ptyIdsByTabId } : {})
      })
    },
    reconnectPersistedTerminals: async (signal) => {
      if (signal?.aborted) {
        return
      }
      const {
        pendingReconnectWorktreeIds,
        pendingReconnectTabByWorktree,
        pendingReconnectPtyIdByTabId,
        terminalLayoutsByTabId,
        tabsByWorktree,
        ptyIdsByTabId
      } = get()
      const ids = pendingReconnectWorktreeIds ?? []
      if (ids.length === 0) {
        set({
          workspaceSessionReady: true,
          pendingReconnectWorktreeIds: [],
          pendingReconnectTabByWorktree: {},
          pendingReconnectPtyIdByTabId: {}
        })
        return
      }
      // Why: defer daemon attachment for real dimensions; eager 80×24 flushes garble output.
      const { tabsByWorktree: reconnectedTabsByWorktree, ptyIdsByTabId: reconnectedPtyIdsByTabId } =
        buildPersistedTerminalHints({
          ids,
          pendingReconnectTabByWorktree,
          pendingReconnectPtyIdByTabId,
          terminalLayoutsByTabId,
          tabsByWorktree,
          ptyIdsByTabId
        })
      // Why indexed: the loop neither sets state nor awaits, so one index over the
      // whole store snapshot serves every iteration.
      const worktreeById = buildWorktreeByIdIndex(selectWorktreesByRepo(get()))
      const repoById = buildByIdIndex(get().repos)
      // Why: keep deferred SSH session IDs for post-cleanup reconnect.
      const deferredSshSessionIdsByTabId: Record<string, string> = {}
      for (const worktreeId of ids) {
        const worktree = worktreeById.get(worktreeId)
        // Cold-start SSH listings are absent; derive repo ID from the composite worktree ID to retain deferred sessions.
        const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
        const repo = repoId ? (repoById.get(repoId) ?? null) : null
        const connectionId = repo?.connectionId
        if (!connectionId) {
          continue
        }
        // Only a hydrated target catalog proves removal; re-deferring absent targets creates permanent orphan-sweep liveness (#9911).
        if (get().sshTargetsHydrated && !get().sshTargetLabels.has(connectionId)) {
          continue
        }
        const sshConnected = get().sshConnectionStates.get(connectionId)?.status === 'connected'
        if (sshConnected) {
          continue
        }
        const tabs = tabsByWorktree[worktreeId] ?? []
        for (const tab of tabs) {
          const sessionId = pendingReconnectPtyIdByTabId[tab.id]
          if (sessionId) {
            deferredSshSessionIdsByTabId[tab.id] = sessionId
          }
        }
      }
      if (signal?.aborted) {
        return
      }
      set({
        // Only each row's ptyId changes, a field the frame merge leaves to the window.
        ...(reconnectedTabsByWorktree ? { tabsByWorktree: reconnectedTabsByWorktree } : {}),
        ...(reconnectedPtyIdsByTabId ? { ptyIdsByTabId: reconnectedPtyIdsByTabId } : {}),
        workspaceSessionReady: true,
        pendingReconnectWorktreeIds: [],
        pendingReconnectTabByWorktree: {},
        pendingReconnectPtyIdByTabId: {},
        deferredSshSessionIdsByTabId
      })
    }
  }
}
