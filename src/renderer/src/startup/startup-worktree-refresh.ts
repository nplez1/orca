import type { Repo } from '../../../shared/repo-types'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { WORKTREE_REFRESH_CONCURRENCY } from '../store/slices/worktrees'
import type { AppState } from '../store/types'
import { timeRendererStartupStep } from './startup-diagnostics'

export async function hydrateStartupWorktrees(
  actions: Pick<AppState, 'fetchWorktrees'>,
  repos: readonly Repo[]
): Promise<void> {
  if (repos.length === 0) {
    return
  }
  await timeRendererStartupStep('git-environment-barrier-await', () =>
    window.api.app.awaitGitEnvironmentStartupBarrier()
  )
  await timeRendererStartupStep('fetch-hydration-worktrees', () =>
    mapWithConcurrency(repos, WORKTREE_REFRESH_CONCURRENCY, (repo) =>
      actions.fetchWorktrees(repo.id, { executionHostId: getRepoExecutionHostId(repo) })
    )
  )
}
