import type { AppState } from '../store/types'
import { timeRendererStartupStep } from './startup-diagnostics'

type StartupLocalCatalogActions = Pick<
  AppState,
  'fetchProjectGroupsForAllHosts' | 'fetchFolderWorkspacesForAllHosts'
>

export function startLocalCatalogHydration(actions: StartupLocalCatalogActions): Promise<void> {
  return (async () => {
    await timeRendererStartupStep('fetch-project-groups-local', () =>
      actions.fetchProjectGroupsForAllHosts({ remoteHosts: 'skip' })
    )
    await timeRendererStartupStep('fetch-folder-workspaces-local', () =>
      actions.fetchFolderWorkspacesForAllHosts({ remoteHosts: 'skip' })
    )
  })()
}

export function startDeferredLocalWorktreeRefresh(
  actions: Pick<AppState, 'fetchAllWorktrees'>
): void {
  void timeRendererStartupStep('local-worktree-refresh', () =>
    actions.fetchAllWorktrees({ visibilityOwnerHostId: 'local' })
  ).catch((err) => {
    console.warn('Deferred local worktree refresh failed:', err)
  })
}
