import type { AppState } from '../types'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { resolveDirectSshTargetScope } from '../../lib/direct-ssh-target-scope'

/**
 * The per-tab session maps a removed SSH target leaves behind.
 *
 * Why its own module: extracted from `ssh-target-cleanup.ts` to keep that file under the
 * max-lines budget.
 */

export function collectSshTargetTerminalTabIds(state: AppState, targetId: string): Set<string> {
  const targetWorktreeIds = resolveDirectSshTargetScope({
    targetId,
    catalogRevision: 0,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  }).gitWorktreeIds
  const tabIds = new Set<string>()
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    for (const worktree of worktrees) {
      if (!targetWorktreeIds.has(worktree.id)) {
        continue
      }
      for (const tab of state.tabsByWorktree[worktree.id] ?? []) {
        tabIds.add(tab.id)
      }
    }
  }
  return tabIds
}

export function isSshTargetSessionId(sessionId: string, targetId: string): boolean {
  return parseAppSshPtyId(sessionId)?.connectionId === targetId
}

// Why: a per-tab session map entry belongs to the removed target if the tab is
// one of the target's, or the session id is an SSH pty id scoped to it. Shared
// by the deferred-session and pending-reconnect cleanups so both drop the same
// dead entries (an uncleared entry would keep a dead tab alive in the orphan
// sweep, which now reads these maps as liveness — #9911).
function isRemovedSshTargetTabSession(
  tabId: string,
  sessionId: string,
  targetId: string,
  targetTabIds: Set<string>
): boolean {
  return targetTabIds.has(tabId) || isSshTargetSessionId(sessionId, targetId)
}

export function omitRemovedSshTargetTabSessions(
  sessions: Record<string, string>,
  targetId: string,
  targetTabIds: Set<string>
): { next: Record<string, string>; removed: boolean } {
  const next: Record<string, string> = {}
  let removed = false
  for (const [tabId, sessionId] of Object.entries(sessions)) {
    if (isRemovedSshTargetTabSession(tabId, sessionId, targetId, targetTabIds)) {
      removed = true
      continue
    }
    next[tabId] = sessionId
  }
  return { next, removed }
}

export function omitRemovedSshTargetRecovery<T extends { authority: { targetId: string } }>(
  entries: Record<string, T>,
  targetId: string,
  targetTabIds: ReadonlySet<string>
): { next: Record<string, T>; removed: boolean } {
  const next = Object.fromEntries(
    Object.entries(entries).filter(
      ([tabId, entry]) => !targetTabIds.has(tabId) && entry.authority.targetId !== targetId
    )
  )
  return { next, removed: Object.keys(next).length !== Object.keys(entries).length }
}
