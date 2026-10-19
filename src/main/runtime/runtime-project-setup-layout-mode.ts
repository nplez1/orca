import type { RuntimeStore } from './runtime-store-contract'
import type { Repo } from '../../shared/repo-types'
import {
  layoutModeNestsWorkspaces,
  resolveWorktreeLayoutMode,
  type WorktreeLayoutMode
} from '../../shared/orca-workspace-layout'
import { invalidateAuthorizedRootsCache } from '../ipc/registered-worktree-roots-cache'
import { scheduleCurrentWorktreeBaseDirectoryWatcherSync } from '../ipc/worktree-base-directory-watcher'
import { prepareLocalWorktreeRootForRepo } from '../worktree-root-preparation'

export type ProjectSetupLayoutModeDeps = {
  getStore: () => RuntimeStore | null
  listRepos: () => Repo[]
}

/**
 * Write the host-level layout mode a project setup call can carry. Returns whether it changed.
 *
 * Why here: the CLI has no settings command, so `orca project setup-create|setup-update` is the
 * only placement surface it exposes. The value is global — it applies to every project on this
 * host, not to the setup record being written.
 */
export function applyProjectSetupWorktreeLayoutMode(
  deps: ProjectSetupLayoutModeDeps,
  mode: WorktreeLayoutMode | undefined
): boolean {
  if (!mode) {
    return false
  }
  const store = deps.getStore()
  if (!store?.updateSettings || !store.getSettings) {
    throw new Error('runtime_unavailable')
  }
  if (resolveWorktreeLayoutMode(store.getSettings()) === mode) {
    return false
  }
  // Why the boolean too: an older reader of these settings only understands it, so leaving it
  // stale would make the same host place worktrees two different ways.
  store.updateSettings(
    { worktreeLayoutMode: mode, nestWorkspaces: layoutModeNestsWorkspaces(mode) },
    { notifyListeners: true }
  )
  // Why: placement is derived from the mode, so every root and watch target derived from the
  // previous one is now stale. Mirrors what the Settings pane does for the same change.
  for (const repo of deps.listRepos()) {
    void prepareLocalWorktreeRootForRepo(store, repo)
  }
  scheduleCurrentWorktreeBaseDirectoryWatcherSync()
  invalidateAuthorizedRootsCache()
  return true
}
