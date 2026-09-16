import type { Repo } from '../../../shared/repo-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  collectActiveWorktreeHydrationRepoIdsFromSession,
  collectWorktreeHydrationRepoIdsFromSession
} from '../lib/workspace-session-hydration-keys'

export function selectStartupHydrationRepos(
  repos: readonly Repo[],
  session: WorkspaceSessionState,
  runtimeHostIdByWorkspaceSessionKey: Record<string, ExecutionHostId>,
  cachedWorktreeRepoIds: ReadonlySet<string>
): Repo[] {
  // A warm cache already supplies the rows needed to route persisted tabs.
  // Never put a potentially wedged Git mount back on the first-paint path.
  if (cachedWorktreeRepoIds.size > 0) {
    return []
  }
  const hydrationRepoIds = collectWorktreeHydrationRepoIdsFromSession(
    session,
    runtimeHostIdByWorkspaceSessionKey
  )
  const activeHydrationRepoIdSet = new Set(
    collectActiveWorktreeHydrationRepoIdsFromSession(session, runtimeHostIdByWorkspaceSessionKey)
  )
  const hydrationRepoIdSet = new Set(
    hydrationRepoIds.filter(
      (repoId) => !cachedWorktreeRepoIds.has(repoId) || activeHydrationRepoIdSet.has(repoId)
    )
  )
  return repos.filter(
    (repo) =>
      hydrationRepoIdSet.has(repo.id) &&
      // Why: disconnected SSH repos hydrate from local metadata; only runtime-owned repos use placeholders.
      parseExecutionHostId(getRepoExecutionHostId(repo))?.kind !== 'runtime'
  )
}
