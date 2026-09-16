import { scheduleAfterWorktreeActivationInputQuiet } from './activation-deferred-work'

type WorktreeActivationRefreshState = {
  activeWorktreeId: string | null
  refreshGitHubForWorktreeIfStale: (worktreeId: string) => void
}

let cancelPendingRefresh: (() => void) | null = null
let pendingRefreshGeneration = 0

/**
 * Keeps provider refresh work out of the click that reveals an active workspace.
 * A newer selection replaces the pending request, so a rapid switch never refreshes a stale tab.
 */
export function refreshGitHubAfterWorktreeActivation(
  get: () => WorktreeActivationRefreshState,
  worktreeId: string
): void {
  const generation = ++pendingRefreshGeneration
  cancelPendingRefresh?.()
  cancelPendingRefresh = null

  const refreshIfStillActive = (): void => {
    if (generation !== pendingRefreshGeneration) {
      return
    }
    cancelPendingRefresh = null
    if (get().activeWorktreeId === worktreeId) {
      get().refreshGitHubForWorktreeIfStale(worktreeId)
    }
  }

  cancelPendingRefresh = scheduleAfterWorktreeActivationInputQuiet(refreshIfStillActive)
}
