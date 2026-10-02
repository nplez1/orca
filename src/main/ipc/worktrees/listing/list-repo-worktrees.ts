import { isFolderRepo } from '../../../../shared/repo-kind'
import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { Store } from '../../../persistence/loading-store/store'
import { getSshGitProvider } from '../../../providers/ssh-git-dispatch'
import { getLocalWorktreeScanGeneration } from '../../../local-worktree-scan-generation'
import { getRegisteredWorktreeRootsRevision } from '../../registered-worktree-roots-cache'
import {
  projectPendingWorktreeRemovals,
  snapshotPendingWorktreeRemovals,
  type PendingWorktreeRemovals
} from '../../../worktree-background-removal'
import {
  applyFreshDetectedWorktreeScanSideEffects,
  listDetectedGitWorktrees,
  type DetectedWorktreeMetadataPrune,
  type DetectedWorktreeSideEffectToken
} from './detected-worktree-scan-cache'
import { listVisibleFolderWorkspaces } from './folder-workspace-catalog'
import {
  buildDetectedGitWorktrees,
  listDisconnectedSshWorktrees,
  stampAndMergeVisibleDetectedWorktree,
  type SshWorktreeMetaIndex
} from './ssh-worktree-fallback'
import {
  loggedUnavailableSshGitProviders,
  loggedWorktreeListFailures,
  warnOnce
} from './worktree-listing-diagnostics'

// Why always marked: the desktop renderer ships with this main process, so it reads the marker.
function markLocalWorktreesUnderRemoval<T extends Worktree>(
  worktrees: T[],
  pendingAtScan: PendingWorktreeRemovals
): T[] {
  return projectPendingWorktreeRemovals(worktrees, (worktree) => worktree.id, true, pendingAtScan)
}

/**
 * One repo's worktree listing: folder workspaces, an SSH host's list (falling back to its
 * disconnected index), or a local scan — followed by the fresh-scan side effects and the
 * visible-only stamping both listing handlers need. Shared so `worktrees:listAll` and
 * `worktrees:list` cannot drift on a repo whose host went away mid-list.
 */
export async function listRepoWorktrees(options: {
  store: Store
  repo: Repo
  /** The repo host's metadata, resolved after the scan so callers keep their own caching. */
  resolveMetadata: () => Record<string, WorktreeMeta>
  /** Fallback index for an unreachable SSH host, resolved only where it is needed. */
  resolveSshMetaIndex: () => SshWorktreeMetaIndex
}): Promise<Worktree[]> {
  const { store, repo, resolveMetadata, resolveSshMetaIndex } = options
  const connectionId = getSshTargetIdForExecutionHost(getRepoExecutionHostId(repo))
  try {
    let gitWorktrees
    let freshScan = true
    let sideEffectToken: DetectedWorktreeSideEffectToken | undefined
    let metadataPrune: DetectedWorktreeMetadataPrune | undefined
    let hygieneDue: boolean | undefined
    const pendingAtScan = snapshotPendingWorktreeRemovals()
    if (isFolderRepo(repo)) {
      return listVisibleFolderWorkspaces(store, repo)
    } else if (connectionId) {
      const provider = getSshGitProvider(connectionId)
      if (!provider) {
        warnOnce(
          loggedUnavailableSshGitProviders,
          `${connectionId}:${repo.id}`,
          `[worktrees] SSH git provider unavailable; skipping worktree list for repo "${repo.displayName}" (${repo.id}) at ${repo.path} on connection ${connectionId}`
        )
        return listDisconnectedSshWorktrees(store, repo, resolveSshMetaIndex())
      }
      loggedUnavailableSshGitProviders.delete(`${connectionId}:${repo.id}`)
      try {
        sideEffectToken = {
          generation: getLocalWorktreeScanGeneration(repo.id),
          authorizedRootsRevision: getRegisteredWorktreeRootsRevision(repo.id)
        }
        gitWorktrees = await provider.listWorktrees(repo.path)
      } catch (err) {
        warnOnce(
          loggedWorktreeListFailures,
          `${repo.id}:${repo.path}`,
          `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
          err
        )
        return listDisconnectedSshWorktrees(store, repo, resolveSshMetaIndex())
      }
    } else {
      const scan = await listDetectedGitWorktrees(store, repo)
      gitWorktrees = scan.gitWorktrees
      freshScan = scan.fresh
      sideEffectToken = scan.sideEffectToken
      metadataPrune = scan.metadataPrune
      hygieneDue = scan.hygieneDue
    }
    if (freshScan) {
      await applyFreshDetectedWorktreeScanSideEffects(store, repo, gitWorktrees, metadataPrune, {
        sideEffectToken,
        ...(hygieneDue === undefined ? {} : { hygieneDue })
      })
    }
    loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
    const metadata = resolveMetadata()
    const worktrees = buildDetectedGitWorktrees(store, repo, gitWorktrees, metadata)
      .filter((worktree) => worktree.visible)
      .map((worktree) => stampAndMergeVisibleDetectedWorktree(store, repo, worktree, metadata))
    return connectionId ? worktrees : markLocalWorktreesUnderRemoval(worktrees, pendingAtScan)
  } catch (err) {
    warnOnce(
      loggedWorktreeListFailures,
      `${repo.id}:${repo.path}`,
      `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
      err
    )
    // Why: do NOT seed empty success — it flags the repo registered, blocking access to legit linked worktrees until the cache is invalidated.
    return []
  }
}
