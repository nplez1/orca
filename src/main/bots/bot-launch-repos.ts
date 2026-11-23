// The projects a bot launch may be sitting in, as its git env needs them: a project's worktrees live outside
// its own folder, and the distro its git runs inside is not on the project record at all.
import type { Repo } from '../../shared/repository/repo-types'
import { splitWorktreeId } from '../../shared/worktree/id'
import { getWorktreeCreatePrefetchGitOptions } from '../workspaces/execution-host/project-runtime-git-options'
import type { ProjectRuntimeResolutionStore } from '../workspaces/execution-host/local-project-runtime-resolution'
import type { LaunchRepo } from './bot-gh-app-identity'

export type LaunchRepoStore = ProjectRuntimeResolutionStore & {
  getAllWorktreeMeta?: () => Record<string, unknown>
}

export function botLaunchRepos(repos: readonly Repo[], store: LaunchRepoStore): LaunchRepo[] {
  const worktrees = registeredWorktreePathsByRepo(store)
  return repos.map((repo) => {
    const { wslDistro } = getWorktreeCreatePrefetchGitOptions(store, repo)
    const worktreePaths = worktrees.get(repo.id)
    return {
      ...repo,
      ...(worktreePaths ? { worktreePaths } : {}),
      ...(wslDistro ? { wslDistro } : {})
    }
  })
}

/** Every registered worktree folder per project, from the ids the worktree store already keeps. */
function registeredWorktreePathsByRepo(store: LaunchRepoStore): Map<string, string[]> {
  const byRepo = new Map<string, string[]>()
  for (const worktreeId of Object.keys(store.getAllWorktreeMeta?.() ?? {})) {
    const parsed = splitWorktreeId(worktreeId)
    if (!parsed) {
      continue
    }
    const paths = byRepo.get(parsed.repoId) ?? []
    paths.push(parsed.worktreePath)
    byRepo.set(parsed.repoId, paths)
  }
  return byRepo
}
