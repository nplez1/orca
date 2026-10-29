import type { RuntimeStore } from './runtime-store-contract'
import type { Repo } from '../../shared/repo-types'
import {
  findProjectHostSetup,
  type ProjectHostSetupTarget
} from '../../shared/project-host-setup-target'
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

/** Applies the host-level mode a setup payload carries, and drops it from the payload.
 *
 *  The mode is host-wide, so `target` — the record the caller is writing — must exist before it
 *  is applied: writing it for a missing project or setup flips every project's placement on this
 *  host and the command then fails, leaving the flip behind. */
export function takeWorktreeLayoutMode<T extends { worktreeLayoutMode?: WorktreeLayoutMode }>(
  deps: ProjectSetupLayoutModeDeps,
  payload: T,
  target: { projectId?: string; setup?: ProjectHostSetupTarget } = {}
): Omit<T, 'worktreeLayoutMode'> {
  if (payload.worktreeLayoutMode) {
    assertLayoutModeTargetExists(deps, target)
  }
  applyProjectSetupWorktreeLayoutMode(deps, payload.worktreeLayoutMode)
  const { worktreeLayoutMode: _mode, ...rest } = payload
  void _mode
  return rest
}

function assertLayoutModeTargetExists(
  deps: ProjectSetupLayoutModeDeps,
  target: { projectId?: string; setup?: ProjectHostSetupTarget }
): void {
  const store = deps.getStore()
  const { projectId, setup } = target
  if (projectId !== undefined && store?.getProjects) {
    if (!store.getProjects().some((entry) => entry.id === projectId)) {
      throw new Error(`Project not found: ${projectId}`)
    }
  }
  if (setup && store?.getProjectHostSetups) {
    if (!findProjectHostSetup(store.getProjectHostSetups(), setup)) {
      throw new Error(`Project host setup not found: ${setup.setupId}`)
    }
  }
}

/** Adds the mode this host has in effect to a setup result, so the caller can prove the write
 *  landed instead of taking a success exit code for one.
 *
 *  Only a call that carried a mode carries one back: an unrelated setup edit is not a
 *  placement read. */
export function withEffectiveLayoutMode<T extends object>(
  deps: ProjectSetupLayoutModeDeps,
  requested: WorktreeLayoutMode | undefined,
  result: T
): T & { worktreeLayoutMode?: WorktreeLayoutMode } {
  if (!requested) {
    return result
  }
  const settings = deps.getStore()?.getSettings?.()
  if (!settings) {
    return result
  }
  return { ...result, worktreeLayoutMode: resolveWorktreeLayoutMode(settings) }
}
