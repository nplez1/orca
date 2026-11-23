import { resolve } from 'node:path'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { GitRuntimeOptions } from '../../git/command-runner/git-runtime-options'
import { appBoundRepoGitEnv } from '../../github/app/github-app-bound-repo-git'
import {
  getLocalProjectWorktreeGitOptions,
  type LocalProjectWorktreeGitOptions
} from '../../workspaces/execution-host/project-runtime-git-options'
import { splitWorktreeId } from '../../../shared/worktree/id'
import type { Repo } from '../../../shared/repository/repo-types'

function comparableLocalPath(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function getCandidateLocalWorktreePaths(
  worktreePath: string,
  resolvedWorktreePath: string
): Set<string> {
  return new Set([worktreePath, resolvedWorktreePath].map(comparableLocalPath))
}

function collectRepoIdsWithRegisteredWorktreeMeta(
  store: RuntimeStore,
  candidatePaths: Set<string>
): Set<string> {
  const worktreeMeta =
    typeof store.getAllWorktreeMeta === 'function' ? store.getAllWorktreeMeta() : {}
  const repoIds = new Set<string>()
  for (const worktreeId of Object.keys(worktreeMeta)) {
    const parsed = splitWorktreeId(worktreeId)
    if (parsed && candidatePaths.has(comparableLocalPath(parsed.worktreePath))) {
      repoIds.add(parsed.repoId)
    }
  }
  return repoIds
}

export function getLocalRepoForRegisteredWorktree(
  store: RuntimeStore,
  worktreePath: string,
  resolvedWorktreePath: string
): Repo | undefined {
  if (typeof store.getRepos !== 'function') {
    return undefined
  }

  const candidatePaths = getCandidateLocalWorktreePaths(worktreePath, resolvedWorktreePath)
  // Lazily scan meta once, not once per repo, on frequent IPC paths.
  let repoIdsWithMeta: Set<string> | undefined
  return store
    .getRepos()
    .find(
      (repo) =>
        !repo.connectionId &&
        (candidatePaths.has(comparableLocalPath(repo.path)) ||
          (repoIdsWithMeta ??= collectRepoIdsWithRegisteredWorktreeMeta(store, candidatePaths)).has(
            repo.id
          ))
    )
}

/** Reuse a resolved repo without scanning worktree metadata again. */
export function getLocalGitOptionsForRepo(
  store: RuntimeStore,
  repo: Repo | undefined
): LocalProjectWorktreeGitOptions {
  if (!repo || typeof store.getProjects !== 'function' || typeof store.getSettings !== 'function') {
    return {}
  }
  // Match project Git/terminal runtime even for Windows-spelled paths.
  return getLocalProjectWorktreeGitOptions(store, repo)
}

export function getLocalGitOptionsForRegisteredWorktree(
  store: RuntimeStore,
  worktreePath: string,
  resolvedWorktreePath: string
): LocalProjectWorktreeGitOptions {
  if (typeof store.getProjects !== 'function' || typeof store.getSettings !== 'function') {
    return {}
  }

  return getLocalGitOptionsForRepo(
    store,
    getLocalRepoForRegisteredWorktree(store, worktreePath, resolvedWorktreePath)
  )
}

export async function getLocalRemoteSyncGitOptions(
  store: RuntimeStore,
  worktreePath: string,
  resolvedWorktreePath: string
): Promise<GitRuntimeOptions> {
  const options = getLocalGitOptionsForRegisteredWorktree(store, worktreePath, resolvedWorktreePath)
  const repo = getLocalRepoForRegisteredWorktree(store, worktreePath, resolvedWorktreePath)
  // fork-comment-ok: a distro's git cannot run Orca's helper, so the binding is refused rather than pushed as its login.
  const env = repo
    ? await appBoundRepoGitEnv({
        ...repo,
        ...(options.wslDistro ? { wslDistro: options.wslDistro } : {})
      })
    : undefined
  return env ? { ...options, env } : options
}
