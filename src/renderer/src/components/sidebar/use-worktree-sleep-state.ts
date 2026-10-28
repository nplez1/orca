import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
import { getWorktreeIdsWithLiveAgent, isInactiveWorkspace } from '@/lib/worktree-activity-state'
import {
  isActiveEmptyWorkspace,
  isWorkspaceEmptiedOnPurpose
} from '@/lib/workspace-emptied-on-purpose'
import { getWorktreeIdsWithStructuredChat } from './visible-worktree-activity-inputs'
import { CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS } from '../../../../shared/closed-terminal-tab-tombstones'
import type { ClosedTerminalTabTombstonesByTabId } from '../../../../shared/closed-terminal-tab-tombstones'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Tab } from '../../../../shared/tab-types'
import {
  hasUnknownStructuredChat,
  type StructuredChatSleptAtByPaneKey
} from '@/store/slices/structured-chat-slept-at'

type TabLike = { id: string }

// Partial store mocks may omit slices; shared predicates treat absence as empty.
type SleepStateInput = {
  activeWorktreeId?: string | null
  agentStatusByPaneKey?: Record<string, AgentStatusEntry> | null
  agentStatusEpoch?: number
  tabsByWorktree?: Record<string, readonly TabLike[]> | null
  ptyIdsByTabId?: Record<string, string[]> | null
  browserTabsByWorktree?: Record<string, readonly TabLike[]> | null
  unifiedTabsByWorktree?: Record<string, Tab[]> | null
  openFiles?: readonly { worktreeId: string }[] | null
  structuredChatSleptAtByPaneKey?: StructuredChatSleptAtByPaneKey
  closedTerminalTabTombstonesByTabId?: ClosedTerminalTabTombstonesByTabId
}

type LiveAgentGeneration = {
  agentStatusByPaneKey: SleepStateInput['agentStatusByPaneKey']
  tabsByWorktree: SleepStateInput['tabsByWorktree']
  agentStatusNow: number
  worktreeIds: ReadonlySet<string>
}

let liveAgentGeneration: LiveAgentGeneration | null = null

// Cache the whole-store live-agent scan across cards by relevant snapshots and freshness epoch.
function selectWorktreeIdsWithLiveAgent(state: SleepStateInput): ReadonlySet<string> {
  const agentStatusNow = getAgentStatusEpochNow(state.agentStatusEpoch ?? 0)
  if (
    liveAgentGeneration &&
    liveAgentGeneration.agentStatusByPaneKey === state.agentStatusByPaneKey &&
    liveAgentGeneration.tabsByWorktree === state.tabsByWorktree &&
    liveAgentGeneration.agentStatusNow === agentStatusNow
  ) {
    return liveAgentGeneration.worktreeIds
  }
  const worktreeIds = getWorktreeIdsWithLiveAgent(
    state.agentStatusByPaneKey,
    state.tabsByWorktree,
    agentStatusNow
  )
  liveAgentGeneration = {
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    tabsByWorktree: state.tabsByWorktree,
    agentStatusNow,
    worktreeIds
  }
  return worktreeIds
}

/** Use the hide-sleeping predicate; retained done status alone cannot establish whether a workspace is asleep. */
export function selectIsSleepingWorktree(state: SleepStateInput, worktreeId: string): boolean {
  // Why first: a workspace the user emptied on purpose, or the one on screen with nothing left to
  // render, has no surfaces by design — that absence is the empty-tabs state, not sleep (#96).
  if (
    isEmptiedOnPurpose(state, worktreeId) ||
    isActiveEmptyWorkspace(state, worktreeId) ||
    hasUnknownStructuredChat(
      state.unifiedTabsByWorktree?.[worktreeId],
      state.structuredChatSleptAtByPaneKey
    )
  ) {
    return false
  }
  return isInactiveWorkspace(
    worktreeId,
    state.tabsByWorktree,
    state.ptyIdsByTabId,
    state.browserTabsByWorktree,
    selectWorktreeIdsWithLiveAgent(state),
    getWorktreeIdsWithStructuredChat(
      state.unifiedTabsByWorktree,
      state.structuredChatSleptAtByPaneKey
    )
  )
}

/**
 * Why its own predicate: the glyph, the "Hide sleeping" sweep and the auto-unhide all have to agree
 * that an emptied workspace is awake; the close record is what tells an empty workspace the user
 * emptied from one this build never initialized.
 */
function isEmptiedOnPurpose(state: SleepStateInput, worktreeId: string): boolean {
  if (!selectWorktreeIdsWithClosedTab(state).has(worktreeId)) {
    return false
  }
  return isWorkspaceEmptiedOnPurpose(state, worktreeId, agentStatusNow(state))
}

function agentStatusNow(state: SleepStateInput): number {
  return getAgentStatusEpochNow(state.agentStatusEpoch ?? 0)
}

type ClosedTabGeneration = {
  closedTerminalTabTombstonesByTabId: SleepStateInput['closedTerminalTabTombstonesByTabId']
  agentStatusNow: number
  worktreeIds: ReadonlySet<string>
}

let closedTabGeneration: ClosedTabGeneration | null = null

/** Why cached like the live-agent set: every mounted card re-runs its selector on every store
 *  write, and this scan walks up to one host's cap of close records. Keyed on the map's identity
 *  plus the status epoch, so it rebuilds exactly when a record or its TTL verdict can change. */
function selectWorktreeIdsWithClosedTab(state: SleepStateInput): ReadonlySet<string> {
  const now = agentStatusNow(state)
  if (
    closedTabGeneration &&
    closedTabGeneration.closedTerminalTabTombstonesByTabId ===
      state.closedTerminalTabTombstonesByTabId &&
    closedTabGeneration.agentStatusNow === now
  ) {
    return closedTabGeneration.worktreeIds
  }
  const worktreeIds = new Set<string>()
  for (const record of Object.values(state.closedTerminalTabTombstonesByTabId ?? {})) {
    if (now - record.closedAt <= CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS) {
      worktreeIds.add(record.worktreeId)
    }
  }
  closedTabGeneration = {
    closedTerminalTabTombstonesByTabId: state.closedTerminalTabTombstonesByTabId,
    agentStatusNow: now,
    worktreeIds
  }
  return worktreeIds
}

export function useIsSleepingWorktree(worktreeId: string): boolean {
  return useAppStore((state) => selectIsSleepingWorktree(state, worktreeId))
}

/**
 * Workspace ids that are awake with nothing to show, so neither the sleeping glyph nor the "Hide
 * sleeping" sweep may treat them as asleep (#96): the workspaces the user emptied, plus the one on
 * screen when it has nothing left to render. `enabled: false` skips the scan entirely — with
 * sleeping rows shown there is no sweep to exempt them from.
 */
export function useWorktreeIdsWithEmptySurface(enabled = true): ReadonlySet<string> | undefined {
  const activeWorktreeId = useAppStore((state) => (enabled ? state.activeWorktreeId : null))
  const tabsByWorktree = useAppStore((state) => (enabled ? state.tabsByWorktree : null))
  const unifiedTabsByWorktree = useAppStore((state) =>
    enabled ? state.unifiedTabsByWorktree : null
  )
  const browserTabsByWorktree = useAppStore((state) =>
    enabled ? state.browserTabsByWorktree : null
  )
  const openFiles = useAppStore((state) => (enabled ? state.openFiles : null))
  const tombstoneByTabId = useAppStore((state) =>
    enabled ? state.closedTerminalTabTombstonesByTabId : undefined
  )
  const agentStatusEpoch = useAppStore((state) => (enabled ? state.agentStatusEpoch : undefined))
  return useMemo(() => {
    if (!enabled) {
      return undefined
    }
    const content = {
      activeWorktreeId,
      tabsByWorktree,
      unifiedTabsByWorktree,
      browserTabsByWorktree,
      openFiles,
      ...(tombstoneByTabId ? { closedTerminalTabTombstonesByTabId: tombstoneByTabId } : {})
    }
    const now = getAgentStatusEpochNow(agentStatusEpoch ?? 0)
    const emptied = new Set<string>()
    for (const record of Object.values(tombstoneByTabId ?? {})) {
      // Why skip: the predicate scans every record, so a workspace with many closes would
      // otherwise be re-checked once per record of its own.
      if (
        emptied.has(record.worktreeId) ||
        now - record.closedAt > CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS
      ) {
        continue
      }
      if (isWorkspaceEmptiedOnPurpose(content, record.worktreeId, now)) {
        emptied.add(record.worktreeId)
      }
    }
    if (activeWorktreeId && isActiveEmptyWorkspace(content, activeWorktreeId)) {
      emptied.add(activeWorktreeId)
    }
    return emptied
  }, [
    activeWorktreeId,
    agentStatusEpoch,
    browserTabsByWorktree,
    enabled,
    openFiles,
    tabsByWorktree,
    tombstoneByTabId,
    unifiedTabsByWorktree
  ])
}

export function resetWorktreeSleepStateCacheForTests(): void {
  liveAgentGeneration = null
  closedTabGeneration = null
}
