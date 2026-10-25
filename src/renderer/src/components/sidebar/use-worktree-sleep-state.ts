import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
import { getWorktreeIdsWithLiveAgent, isInactiveWorkspace } from '@/lib/worktree-activity-state'
import { getWorktreeIdsWithStructuredChat } from './visible-worktree-activity-inputs'
import { isTerminalWorkspaceEmptiedOnPurpose } from '../../../../shared/closed-terminal-tab-tombstones'
import type { ClosedTerminalTabTombstonesByTabId } from '../../../../shared/closed-terminal-tab-tombstones'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Tab } from '../../../../shared/tab-types'
import {
  hasUnknownStructuredChat,
  type StructuredChatSleptAtByPaneKey
} from '@/store/slices/structured-chat-slept-at'

type TabLike = { id: string }

// Why optional: suites mount cards with partial store mocks, and the shared
// predicate already reads a missing slice as empty.
type SleepStateInput = {
  agentStatusByPaneKey?: Record<string, AgentStatusEntry> | null
  agentStatusEpoch?: number
  tabsByWorktree?: Record<string, readonly TabLike[]> | null
  ptyIdsByTabId?: Record<string, string[]> | null
  browserTabsByWorktree?: Record<string, readonly TabLike[]> | null
  unifiedTabsByWorktree?: Record<string, Tab[]> | null
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

// Why cached across cards: zustand re-runs every mounted card's selector on every
// store write, and the live-agent set is a whole-store scan. Keyed on the same
// slices plus the status epoch, so it rebuilds exactly when the filter's own
// snapshot would.
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

/**
 * Whether a workspace is asleep: no live terminal, no browser tab, no live
 * agent holding it awake through a PTY gap, and no structured chat.
 *
 * Why not `status === 'inactive'`: a slept workspace keeps its retained done
 * rows, so its status still reads 'done' — keying the sleeping glyph on status
 * misses exactly the completed-but-slept cards it must distinguish (#19624).
 *
 * Why `isInactiveWorkspace`: the hide-sleeping filter decides with that same
 * predicate, so the moon and the filter cannot disagree about which workspaces
 * are asleep.
 */
export function selectIsSleepingWorktree(state: SleepStateInput, worktreeId: string): boolean {
  // Why first: a workspace the user emptied on purpose has no surfaces by design, so the absence
  // of a live terminal is the empty-tabs state, not sleep (#96).
  if (isEmptiedOnPurpose(state, worktreeId, getAgentStatusEpochNow(state.agentStatusEpoch ?? 0))) {
    return false
  }
  if (
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
 * that an emptied workspace is awake; the tombstone record is what tells an empty row with a closed
 * tab (the user emptied it) from an empty row this build never initialized.
 */
function isEmptiedOnPurpose(state: SleepStateInput, worktreeId: string, now: number): boolean {
  const tabsByWorktree = state.tabsByWorktree
  if (tabsByWorktree === null || tabsByWorktree === undefined) {
    return false
  }
  return isTerminalWorkspaceEmptiedOnPurpose(
    {
      tabsByWorktree,
      ...(state.closedTerminalTabTombstonesByTabId
        ? { closedTerminalTabTombstonesByTabId: state.closedTerminalTabTombstonesByTabId }
        : {})
    },
    worktreeId,
    now
  )
}

export function useIsSleepingWorktree(worktreeId: string): boolean {
  return useAppStore((state) => selectIsSleepingWorktree(state, worktreeId))
}

/**
 * Workspace ids the user emptied on purpose. They are awake with nothing to show, so neither the
 * sleeping glyph nor the "Hide sleeping" sweep may treat them as asleep (#96). `enabled: false`
 * skips the scan entirely — with sleeping rows shown there is no sweep to exempt them from.
 */
export function useWorktreeIdsEmptiedOnPurpose(enabled = true): ReadonlySet<string> | undefined {
  const tabsByWorktree = useAppStore((state) => (enabled ? state.tabsByWorktree : null))
  const tombstoneByTabId = useAppStore((state) =>
    enabled ? state.closedTerminalTabTombstonesByTabId : undefined
  )
  return useMemo(() => {
    if (!enabled) {
      return undefined
    }
    const emptied = new Set<string>()
    const candidates = new Set(
      Object.values(tombstoneByTabId ?? {}).map((record) => record.worktreeId)
    )
    // Why wall time: a record older than the TTL stopped meaning "someone emptied this".
    // oxlint-disable-next-line react/purity -- an expired record is the one input a memo cannot derive from the store.
    const now = Date.now()
    for (const worktreeId of candidates) {
      if (
        isEmptiedOnPurpose(
          { tabsByWorktree, closedTerminalTabTombstonesByTabId: tombstoneByTabId },
          worktreeId,
          now
        )
      ) {
        emptied.add(worktreeId)
      }
    }
    return emptied
  }, [enabled, tabsByWorktree, tombstoneByTabId])
}

export function resetWorktreeSleepStateCacheForTests(): void {
  liveAgentGeneration = null
}
