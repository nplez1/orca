import type { BrowserWindow } from 'electron'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { notifyWorktreesChanged } from '../worktree-remote'
import { runWorktreeChangeInvalidators } from './worktree-change-invalidators'

type WorktreeCatalogRemoteClientNotifier = Pick<
  OrcaRuntimeService,
  'notifyWorktreeCatalogChangedForRemoteClients' | 'notifyGitStatusChangedForRemoteClients'
>

let remoteClientNotifier: WorktreeCatalogRemoteClientNotifier | null = null

export function setWorktreeCatalogRemoteClientNotifier(
  notifier: WorktreeCatalogRemoteClientNotifier | null
): void {
  remoteClientNotifier = notifier
}

/**
 * Paired clients hold no optimistic copy of a host-side catalog change, so every producer of one
 * pushes this single event. The runtime applies the owner rule, which is what keeps a nested SSH
 * row's change local: `worktreesChanged` cannot carry its owner (#16557).
 */
export function notifyWorktreeCatalogChangedForPairedClients(repoId: string): void {
  try {
    remoteClientNotifier?.notifyWorktreeCatalogChangedForRemoteClients(repoId)
  } catch (error) {
    // Why: a broadcast failure must never fail the mutation the user actually asked for.
    console.error('[worktrees] failed to notify remote clients of worktree catalog change', error)
  }
}

/**
 * A catalog change this window made itself: the renderer already applied it, paired clients did
 * not. Shares this module's notifier with the watcher, the other producer of these changes.
 */
export function notifyWorktreeCatalogChanged(mainWindow: BrowserWindow, repoId: string): void {
  notifyWorktreesChanged(mainWindow, repoId)
  notifyWorktreeCatalogChangedForPairedClients(repoId)
}

export function notifyWatchedWorktreeCatalogChanged(
  mainWindow: BrowserWindow,
  repoId: string
): void {
  notifyWorktreeCatalogChanged(mainWindow, repoId)
}

/** Listed heads moved without structure: stale owners must rescan, but the local renderer patches its rows. */
export function notifyWatchedWorktreeHeadsMoved(repoId: string): void {
  runWorktreeChangeInvalidators(repoId)
  notifyWorktreeCatalogChangedForPairedClients(repoId)
}

export function notifyGitStatusChangedForRemoteClients(
  repoId: string,
  worktreePaths: readonly string[] | null
): void {
  try {
    remoteClientNotifier?.notifyGitStatusChangedForRemoteClients(repoId, worktreePaths)
  } catch (error) {
    console.error('[worktrees] failed to notify remote clients of git status change', error)
  }
}
