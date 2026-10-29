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

/** Checks this host can write the mode at all, and drops it from a setup payload.
 *
 *  Applying it is a separate step, `applyAndReportWorktreeLayoutMode`, run only once the setup
 *  write succeeded: the mode is host-wide, so a rejected project or setup must not have flipped
 *  every project's placement on this host first. */
export function takeWorktreeLayoutMode<T extends { worktreeLayoutMode?: WorktreeLayoutMode }>(
  deps: ProjectSetupLayoutModeDeps,
  payload: T
): Omit<T, 'worktreeLayoutMode'> {
  if (payload.worktreeLayoutMode) {
    const store = deps.getStore()
    if (!store?.updateSettings || !store.getSettings) {
      throw new Error('runtime_unavailable')
    }
  }
  const { worktreeLayoutMode: _mode, ...rest } = payload
  void _mode
  return rest
}

/** Applies the host-level mode a setup write carried, and adds the mode now in effect to the
 *  result, so the caller can prove the write landed instead of taking an exit code for one.
 *
 *  Only a call that carried a mode carries one back: an unrelated setup edit is not a placement
 *  read. A host that cannot report the mode — a build from before the field — answers without it. */
export function applyAndReportWorktreeLayoutMode<T extends object>(
  deps: ProjectSetupLayoutModeDeps,
  requested: WorktreeLayoutMode | undefined,
  result: T
): T & { worktreeLayoutMode?: WorktreeLayoutMode } {
  if (!requested) {
    return result
  }
  try {
    applyProjectSetupWorktreeLayoutMode(deps, requested)
  } catch (error) {
    // Why named: by now the setup write has landed, so "runtime_unavailable" alone would read as
    // if nothing had happened.
    throw new Error(
      `The project setup was written, but the host-wide layout mode was not: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const settings = deps.getStore()?.getSettings?.()
  return settings ? { ...result, worktreeLayoutMode: resolveWorktreeLayoutMode(settings) } : result
}
