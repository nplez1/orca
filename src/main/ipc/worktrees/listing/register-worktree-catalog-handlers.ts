import { ipcMain } from 'electron'
import { withoutWslMovedRepos } from '../../../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { isFolderRepo } from '../../../../shared/repo-kind'
import {
  getRepoExecutionHostId,
  getRepoDialableSshTargetId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { DetectedWorktreeListResult } from '../../../../shared/worktree/types'
import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../../shared/worktree/retired-name-registry'
import { getRetiredNameRegistryForRepo } from '../../../worktree-name-retirement'
import {
  buildDetectedGitWorktrees,
  createSshWorktreeMetaIndex,
  listDisconnectedSshWorktrees,
  stampAndMergeVisibleDetectedWorktree
} from './ssh-worktree-fallback'
import { listVisibleFolderWorkspaces } from './folder-workspace-catalog'
import {
  applyFreshDetectedWorktreeScanSideEffects,
  listDetectedGitWorktrees
} from './detected-worktree-scan-cache'
import { loggedWorktreeListFailures, warnOnce } from './worktree-listing-diagnostics'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import {
  readAllWorktreeMetaForHost,
  readAllWorktreeMetaForRepo
} from '../../../persistence/host-qualified-worktree-meta'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import {
  snapshotPendingWorktreeRemovals,
  withUnregisteredRemovalCheckouts
} from '../../../worktree-removal-listing'
import {
  markLocalWorktreesUnderRemoval,
  mapWithConcurrency,
  WORKTREE_LIST_ALL_CONCURRENCY
} from './worktree-catalog-list-all'
import { getLocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { readPersistedWorktreeScanCache } from './persisted-worktree-scan-cache'
import { withoutInFlightWorktreeCreates } from '../../../worktree-create-in-flight'

export function registerWorktreeCatalogHandlers(context: WorktreeIpcContext): void {
  const { store } = context

  ipcMain.handle('worktrees:listAll', async () => {
    // A repo the WSL host owns is listed by the host; this build must not scan its old path.
    const repos = withoutWslMovedRepos(store.getRepos())
    const legacyMetadata =
      typeof store.getAllWorktreeMetaForHost === 'function' ? undefined : store.getAllWorktreeMeta()
    const metadataByHost = new Map<ExecutionHostId, Record<string, WorktreeMeta>>()
    const metadataForRepo = (repo: (typeof repos)[number]): Record<string, WorktreeMeta> => {
      const hostId = getRepoExecutionHostId(repo)
      const cached = metadataByHost.get(hostId)
      if (cached) {
        return cached
      }
      const metadata =
        typeof store.getAllWorktreeMetaForHost === 'function'
          ? store.getAllWorktreeMetaForHost(hostId)
          : readAllWorktreeMetaForHost({ getAllWorktreeMeta: () => legacyMetadata ?? {} }, hostId)
      metadataByHost.set(hostId, metadata)
      return metadata
    }
    const sshMetaIndexByHost = new Map<
      ExecutionHostId,
      ReturnType<typeof createSshWorktreeMetaIndex>
    >()
    const sshMetaIndexForRepo = (repo: (typeof repos)[number]) => {
      const hostId = getRepoExecutionHostId(repo)
      const cached = sshMetaIndexByHost.get(hostId)
      if (cached) {
        return cached
      }
      const index = createSshWorktreeMetaIndex(Object.entries(metadataForRepo(repo)))
      sshMetaIndexByHost.set(hostId, index)
      return index
    }

    // Why: each local repo listing can spawn `git worktree list`; cap fan-out so large fleets don't start unbounded subprocesses.
    const results = await mapWithConcurrency(repos, WORKTREE_LIST_ALL_CONCURRENCY, async (repo) => {
      const connectionId = getRepoDialableSshTargetId(repo)
      try {
        const pendingAtScan = snapshotPendingWorktreeRemovals()
        if (isFolderRepo(repo)) {
          return listVisibleFolderWorkspaces(store, repo)
        }
        // An `ssh:` repo is not served here, so it lists from metadata, never from this machine.
        if (connectionId) {
          return listDisconnectedSshWorktrees(store, repo, sshMetaIndexForRepo(repo))
        }
        const scan = await listDetectedGitWorktrees(store, repo)
        if (scan.fresh) {
          await applyFreshDetectedWorktreeScanSideEffects(
            store,
            repo,
            scan.gitWorktrees,
            scan.metadataPrune,
            {
              sideEffectToken: scan.sideEffectToken,
              ...(scan.hygieneDue === undefined ? {} : { hygieneDue: scan.hygieneDue })
            }
          )
        }
        loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
        const metadata = metadataForRepo(repo)
        const rows = await withUnregisteredRemovalCheckouts(
          repo.id,
          withoutInFlightWorktreeCreates(repo.id, scan.gitWorktrees)
        )
        const worktrees = buildDetectedGitWorktrees(store, repo, rows, metadata)
          .filter((worktree) => worktree.visible)
          .map((worktree) => stampAndMergeVisibleDetectedWorktree(store, repo, worktree, metadata))
        return markLocalWorktreesUnderRemoval(worktrees, pendingAtScan)
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
    })

    return results.flat()
  })

  ipcMain.handle('worktrees:listCached', async (): Promise<DetectedWorktreeListResult[]> => {
    const cached = await readPersistedWorktreeScanCache(store.getProfileStorageDirectory())
    const localMetadata =
      typeof store.getAllWorktreeMetaForHost === 'function'
        ? store.getAllWorktreeMetaForHost(LOCAL_EXECUTION_HOST_ID)
        : readAllWorktreeMetaForHost(store, LOCAL_EXECUTION_HOST_ID)
    const results: DetectedWorktreeListResult[] = []
    for (const entry of cached) {
      const repo = store.getRepo(entry.repoId)
      if (
        !repo ||
        repo.connectionId ||
        isFolderRepo(repo) ||
        getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID ||
        repo.path !== entry.repoPath
      ) {
        continue
      }
      let currentWslDistro: string | null
      try {
        currentWslDistro = getLocalProjectWorktreeGitOptions(store, repo).wslDistro ?? null
      } catch (error) {
        console.debug(`[worktrees] skipping cached listing for ${repo.id}:`, error)
        continue
      }
      if (currentWslDistro !== entry.wslDistro) {
        continue
      }
      results.push({
        repoId: repo.id,
        authoritative: false,
        source: 'cache',
        worktrees: buildDetectedGitWorktrees(store, repo, entry.worktrees, localMetadata)
      })
    }
    return results
  })

  ipcMain.handle('worktrees:listRetiredNames', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo) {
      return EMPTY_RETIRED_NAME_REGISTRY
    }
    return getRetiredNameRegistryForRepo(store, repo, store.getRepos(), store.getSettings())
  })

  ipcMain.handle('worktrees:list', async (_event, args: { repoId: string } | undefined) => {
    // Renderer startup can race repo selection; malformed requests must fail closed, not crash the handler.
    const repoId = typeof args?.repoId === 'string' ? args.repoId : ''
    if (!repoId) {
      return []
    }
    const repo = store.getRepo(repoId)
    if (!repo) {
      return []
    }
    const connectionId = getRepoDialableSshTargetId(repo)
    const allMeta = connectionId ? readAllWorktreeMetaForRepo(store, repo) : undefined
    const sshWorktreeMetaIndex = connectionId
      ? createSshWorktreeMetaIndex(Object.entries(allMeta ?? {}))
      : new Map()

    try {
      const pendingAtScan = snapshotPendingWorktreeRemovals()
      if (isFolderRepo(repo)) {
        return listVisibleFolderWorkspaces(store, repo)
      }
      // An `ssh:` repo is not served here, so it lists from metadata, never from this machine.
      if (connectionId) {
        return listDisconnectedSshWorktrees(store, repo, sshWorktreeMetaIndex)
      }
      const scan = await listDetectedGitWorktrees(store, repo)
      if (scan.fresh) {
        await applyFreshDetectedWorktreeScanSideEffects(
          store,
          repo,
          scan.gitWorktrees,
          scan.metadataPrune,
          {
            sideEffectToken: scan.sideEffectToken,
            ...(scan.hygieneDue === undefined ? {} : { hygieneDue: scan.hygieneDue })
          }
        )
      }
      loggedWorktreeListFailures.delete(`${repo.id}:${repo.path}`)
      const metadata = allMeta ?? readAllWorktreeMetaForRepo(store, repo)
      const rows = await withUnregisteredRemovalCheckouts(
        repo.id,
        withoutInFlightWorktreeCreates(repo.id, scan.gitWorktrees)
      )
      const worktrees = buildDetectedGitWorktrees(store, repo, rows, metadata)
        .filter((worktree) => worktree.visible)
        .map((worktree) => stampAndMergeVisibleDetectedWorktree(store, repo, worktree, metadata))
      return markLocalWorktreesUnderRemoval(worktrees, pendingAtScan)
    } catch (err) {
      warnOnce(
        loggedWorktreeListFailures,
        `${repo.id}:${repo.path}`,
        `[worktrees] failed to list worktrees for repo "${repo.displayName}" (${repo.id}) at ${repo.path}`,
        err
      )
      // Why: see worktrees:listAll catch — seeding an empty-success result would poison the auth cache and block linked worktrees.
      return []
    }
  })
}
