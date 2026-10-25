import { ipcMain } from 'electron'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { isRepoOnCatalogHost, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { DetectedWorktreeListResult } from '../../../../shared/worktree/types'
import { EMPTY_RETIRED_NAME_REGISTRY } from '../../../../shared/worktree/retired-name-registry'
import { getRetiredNameRegistryForRepo } from '../../../worktree-name-retirement'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { readAllWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import { getLocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { readPersistedWorktreeScanCache } from './persisted-worktree-scan-cache'
import { buildDetectedGitWorktrees } from './ssh-worktree-fallback'

export function registerWorktreeCatalogHandlers(context: WorktreeIpcContext): void {
  const { store } = context

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
        !isRepoOnCatalogHost(repo) ||
        isFolderRepo(repo) ||
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
}
