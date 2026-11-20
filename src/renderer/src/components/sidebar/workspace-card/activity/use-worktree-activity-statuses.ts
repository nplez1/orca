import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { hasAwakeStructuredChat } from '@/store/slices/agent-status/structured-sessions/structured-chat-slept-at'
import {
  resolveWorktreeStatus,
  type WorktreeStatus
} from '@/lib/workspace/activity/worktree-status'
import { EMPTY_BROWSER_TABS, EMPTY_TABS } from './worktree-card-empty-inputs'
import {
  selectTerminalLayoutRootsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from './worktree-card-status-inputs'
import { selectWorktreeAgentActivitySummary } from './worktree-agent-activity-summary'
import { selectWorktreeActivityPtyIds } from './use-worktree-activity-status'

type StatusMemo = { inputs: readonly unknown[]; status: WorktreeStatus }

// Every caller (sidebar cards, Bots rows, pickers) resolves the same ids on each store write; each
// id re-resolves only when one of its own inputs changes.
const statusMemoByWorktreeId = new Map<string, StatusMemo>()
const STATUS_MEMO_LIMIT = 2000
// One store write runs every mounted selector against one state; each id is checked once per write.
let generation: { state: AppState; statusById: Map<string, WorktreeStatus> } | null = null

function selectWorktreeActivityStatus(statusInputs: AppState, worktreeId: string): WorktreeStatus {
  if (generation?.state !== statusInputs) {
    generation = { state: statusInputs, statusById: new Map() }
  }
  let status = generation.statusById.get(worktreeId)
  if (status === undefined) {
    status = resolveMemoizedStatus(statusInputs, worktreeId)
    generation.statusById.set(worktreeId, status)
  }
  return status
}

function resolveMemoizedStatus(statusInputs: AppState, worktreeId: string): WorktreeStatus {
  const summary = selectWorktreeAgentActivitySummary(statusInputs, worktreeId)
  const inputs = [
    statusInputs.tabsByWorktree[worktreeId] ?? EMPTY_TABS,
    statusInputs.browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS,
    hasAwakeStructuredChat(
      statusInputs.unifiedTabsByWorktree[worktreeId],
      statusInputs.structuredChatSleptAtByPaneKey
    ),
    selectWorktreeActivityPtyIds(statusInputs, worktreeId),
    selectRuntimePaneTitlesForWorktree(statusInputs, worktreeId),
    selectTerminalLayoutRootsForWorktree(statusInputs, worktreeId),
    // Why the optional read: several suites mock @/store with a hand-built partial state.
    statusInputs.setupRunningWorktreeIds?.[worktreeId] === true,
    summary
  ] as const
  const memo = statusMemoByWorktreeId.get(worktreeId)
  if (memo && inputs.every((input, index) => input === memo.inputs[index])) {
    return memo.status
  }
  const [
    tabs,
    browserTabs,
    hasStructuredChat,
    ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    terminalLayoutRootsByTabId,
    setupRunning
  ] = inputs
  const status = resolveWorktreeStatus({
    tabs,
    browserTabs,
    hasStructuredChat,
    ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    agentStatusPaneIdsByTabId: summary.agentStatusPaneIdsByTabId,
    stalePaneIdsByTabId: summary.stalePaneIdsByTabId,
    terminalLayoutRootsByTabId,
    hasPermission: summary.hasPermission,
    hasLiveWorking: summary.hasLiveWorking,
    hasLiveMonitoring: summary.hasLiveMonitoring,
    hasFailed: summary.hasFailed,
    hasInterrupted: summary.hasInterrupted,
    hasUnconfirmed: summary.hasUnconfirmed,
    hasLiveDone: summary.hasLiveDone,
    setupRunning
  })
  if (!memo && statusMemoByWorktreeId.size >= STATUS_MEMO_LIMIT) {
    statusMemoByWorktreeId.clear()
  }
  statusMemoByWorktreeId.set(worktreeId, { inputs, status })
  return status
}

export function selectWorktreeActivityStatuses(
  statusInputs: AppState,
  worktreeIds: readonly string[]
): Map<string, WorktreeStatus> {
  const statuses = new Map<string, WorktreeStatus>()
  for (const worktreeId of worktreeIds) {
    statuses.set(worktreeId, selectWorktreeActivityStatus(statusInputs, worktreeId))
  }
  return statuses
}

// Keep equal status maps stable so unrelated terminal updates do not rerender the picker.
export function useWorktreeActivityStatuses(
  worktreeIds: readonly string[]
): Map<string, WorktreeStatus> {
  const selectStatuses = useCallback(
    (state: AppState) => selectWorktreeActivityStatuses(state, worktreeIds),
    [worktreeIds]
  )
  return useAppStore(useShallow(selectStatuses))
}
