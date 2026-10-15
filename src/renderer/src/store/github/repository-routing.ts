import type { AppState } from '../types'
import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate,
  GitHubPRRefreshReason
} from '../../../../shared/github/pull-request-refresh-types'
import type { Repo } from '../../../../shared/repo-types'
import { runtimeTargetForOwnerEnvironment } from '../../runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getGitHubRepoLookupIndex } from '../slices/github-repo-lookup-index'
import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'

/** The repo row at this path/id on this server. A path or an id can name another machine's
 *  row — two checkouts can sit at the same path — and the bare first-wins lookups would then hand
 *  the server a repo id it does not own, so every read routed through it fails there. */
function findRepoOnRuntimeHost(
  repos: readonly Repo[] | undefined,
  repoPath: string,
  environmentId: string,
  repoId: string | null | undefined
): Repo | undefined {
  const index = getGitHubRepoLookupIndex(repos)
  const hostId = toRuntimeExecutionHostId(environmentId)
  const byId = repoId ? index.findByIdOnHost(repoId, hostId) : undefined
  return byId ?? index.findByPathOnHost(repoPath, hostId)
}

/** The server-side repo for a request already routed to `target`; `null` when it runs here. */
export function getRuntimeRepoTarget(
  state: Pick<AppState, 'repos'>,
  repoPath: string,
  target: RuntimeClientTarget,
  repoId?: string | null
): { target: { kind: 'environment'; environmentId: string }; repo: Repo } | null {
  if (target.kind !== 'environment') {
    return null
  }
  const repo = findRepoOnRuntimeHost(state.repos, repoPath, target.environmentId, repoId)
  return repo ? { target, repo } : null
}

export function getPRRefreshOwnerRuntimeEnvironmentId(
  candidate: Pick<GitHubPRRefreshCandidate, 'cacheKey' | 'executionHostId'>
): string | null {
  const parsed = parseExecutionHostId(candidate.executionHostId)
  if (parsed?.kind === 'runtime') {
    return parsed.environmentId
  }
  const cacheScope = candidate.cacheKey.split('::', 1)[0]
  const cacheScopeHost = parseExecutionHostId(cacheScope)
  return cacheScopeHost?.kind === 'runtime' ? cacheScopeHost.environmentId : null
}

export function getPRRefreshRuntimeRepoTarget(
  state: AppState,
  candidate: GitHubPRRefreshCandidate
): { target: { kind: 'environment'; environmentId: string }; repo: Repo } | null {
  const ownerRuntimeEnvironmentId = getPRRefreshOwnerRuntimeEnvironmentId(candidate)
  if (!ownerRuntimeEnvironmentId) {
    return null
  }
  // Why: PR refreshes must follow the repo owner host, not the Active Server dropdown (a runtime-owned worktree can show while Local is focused).
  return getRuntimeRepoTarget(
    state,
    candidate.repoPath,
    runtimeTargetForOwnerEnvironment(ownerRuntimeEnvironmentId),
    candidate.repoId
  )
}

export function shouldEnqueueLocalPRRefresh(candidate: GitHubPRRefreshCandidate): boolean {
  // Why: the local coordinator owns local git + SSH-bridge refreshes; runtime-owned and disconnected-SSH repos must not hit the IPC crash path.
  if (getPRRefreshOwnerRuntimeEnvironmentId(candidate) !== null) {
    return false
  }
  return !candidate.connectionId || candidate.connectionState === 'connected'
}

export function enqueueLocalGitHubPRRefresh(
  args: {
    candidate: GitHubPRRefreshCandidate
    reason: GitHubPRRefreshReason
    priority: number
  },
  onNotQueued?: () => void | Promise<unknown>
): void {
  const enqueue = window.api.gh.enqueuePRRefresh
  if (!enqueue) {
    return
  }
  // Why: renderer refresh triggers are best-effort — main may reject stale paths, and this must not become an unhandled-rejection crash.
  void enqueue(args)
    .then((queued) =>
      queued === false || queued?.kind === 'fallback' ? onNotQueued?.() : undefined
    )
    .catch((err) => {
      console.warn('Failed to enqueue PR refresh:', err)
    })
}
export function getRefreshAliasExecutionHostId(alias: GitHubPRRefreshAlias): string {
  const explicitHostId = normalizeExecutionHostId(alias.executionHostId)
  if (explicitHostId) {
    return explicitHostId
  }
  const scope = alias.cacheKey.split('::', 1)[0]
  return normalizeExecutionHostId(scope) ?? LOCAL_EXECUTION_HOST_ID
}

export function findRepoForGitHubOwner(
  state: Partial<Pick<AppState, 'repos'>>,
  repoId: string | undefined,
  repoPath: string
): Repo | undefined {
  return state.repos
    ? getGitHubRepoLookupIndex(state.repos).findByIdOrPath(repoId, repoPath)
    : undefined
}

export function getGitHubFocusedRepoOwnerHostId(
  settings: AppState['settings'],
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined
): string {
  if (repo?.executionHostId || repo?.connectionId) {
    return getRepoExecutionHostId(repo)
  }
  return getSettingsFocusedExecutionHostId(settings)
}
