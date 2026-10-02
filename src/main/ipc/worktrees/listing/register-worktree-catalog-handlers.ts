import { ipcMain } from 'electron'
import { isFolderRepo } from '../../../../shared/repo-kind'
import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { DetectedWorktreeListResult } from '../../../../shared/worktree/types'
import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../../shared/worktree/retired-name-registry'
import { getRetiredNameRegistryForRepo } from '../../../worktree-name-retirement'
import { buildDetectedGitWorktrees, createSshWorktreeMetaIndex } from './ssh-worktree-fallback'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import {
  readAllWorktreeMetaForHost,
  readAllWorktreeMetaForRepo
} from '../../../persistence/host-qualified-worktree-meta'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { getLocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { readPersistedWorktreeScanCache } from './persisted-worktree-scan-cache'
import { listRepoWorktrees } from './list-repo-worktrees'

const WORKTREE_LIST_ALL_CONCURRENCY = 8

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  const workerCount = Math.min(limit, items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await fn(items[index])
      }
    })
  )
  return results
}

export function registerWorktreeCatalogHandlers(context: WorktreeIpcContext): void {
  const { store } = context

  ipcMain.handle('worktrees:listAll', async () => {
    const repos = store.getRepos()
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
    const results = await mapWithConcurrency(repos, WORKTREE_LIST_ALL_CONCURRENCY, (repo) =>
      listRepoWorktrees({
        store,
        repo,
        resolveMetadata: () => metadataForRepo(repo),
        resolveSshMetaIndex: () => sshMetaIndexForRepo(repo)
      })
    )

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
    const connectionId = getSshTargetIdForExecutionHost(getRepoExecutionHostId(repo))
    const allMeta = connectionId ? readAllWorktreeMetaForRepo(store, repo) : undefined
    const sshWorktreeMetaIndex = connectionId
      ? createSshWorktreeMetaIndex(Object.entries(allMeta ?? {}))
      : new Map()

    return listRepoWorktrees({
      store,
      repo,
      resolveMetadata: () => allMeta ?? readAllWorktreeMetaForRepo(store, repo),
      resolveSshMetaIndex: () => sshWorktreeMetaIndex
    })
  })
}
