// The GitHub repository a bot's worker is on, for the own-PR guard: the one a local branch tracks,
// or the origin a paired server reports for it. Fork-owned: the 2026-11-24 sync deleted the upstream
// files this was ported from (github/client/fetch/tracked-repository.ts, and readRemoteGitHubRepo in
// bot-work-remote-workspace.ts), so the port lives where a later sync cannot take it away.
import { acquire, release } from '../github/execution/github-operation-slots'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { ghExecFileAsync } from '../git/command-runner/hosted-cli/gh-exec-file'
import { resolveGitHubRepoExecution } from '../github/repositories/github-api-repository'
import { getGitHubApiRepositoryForRemote } from '../github/repositories/github-api-repository-remote-probe'
import { githubRepoIdentityKey } from '../../shared/github/repositories/repository-identity-key'
import type { GitHubRepositoryIdentity } from '../../shared/github/repositories/repository-identity'
import { githubHostExecOptions } from '../github/repositories/github-repository-host'
import type { Worktree } from '../../shared/worktree/types'
import { resolvePinnedFederatedServer } from '../runtime/orchestration/legacy-remote-home/pinned-federated-server'
import type { BotWorkRemoteRuntime } from './bot-work-remote-workspace'
import type { BotWorkWorker } from './bot-work-types'

/** A repository by its id, which survives a rename or transfer, and its name, for when the id can't
 *  be read. The same shape as bot-work-pr-branch.ts's BotGitHubRepo, restated here so this module
 *  never imports the module that imports it. */
type GitHubRepoRef = { id: number | null; fullName: string }

// A repository's id never changes, and survives a rename or transfer that its old name redirects.
const repositoryIds = new Map<string, number>()

/** The remote a branch pushes to and pulls from; null when it tracks none or one this process can't read. */
async function trackedRemote(
  repoPath: string,
  branch: string,
  connectionId: string | null | undefined
): Promise<string | null> {
  if (connectionId) {
    return null
  }
  const { stdout } = await gitExecFileAsync(['config', '--get', `branch.${branch}.remote`], {
    cwd: repoPath
  }).catch(() => ({ stdout: '' }))
  const remote = stdout.trim()
  return remote && remote !== '.' ? remote : null
}

/** The GitHub repository a branch tracks, else the checkout's origin: its name, and its id when
 *  GitHub answers. Null when neither remote names a GitHub repository. */
export async function getGitHubTrackedRepository(
  repoPath: string,
  branch: string,
  connectionId?: string | null
): Promise<GitHubRepoRef | null> {
  const remote = await trackedRemote(repoPath, branch, connectionId)
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    remote ? () => getGitHubApiRepositoryForRemote(repoPath, remote, connectionId) : undefined,
    connectionId
  )
  if (!ownerRepo) {
    return null
  }
  const fullName = `${ownerRepo.owner}/${ownerRepo.repo}`
  return { id: await getGitHubRepositoryId(ownerRepo, ghOptions), fullName }
}

/** A GitHub repository's id, as this machine's gh reads it; null when GitHub doesn't answer. */
export async function getGitHubRepositoryId(
  ownerRepo: GitHubRepositoryIdentity,
  ghOptions: Parameters<typeof ghExecFileAsync>[1] = githubHostExecOptions(ownerRepo)
): Promise<number | null> {
  const key = githubRepoIdentityKey(ownerRepo)
  const known = repositoryIds.get(key)
  if (known !== undefined) {
    return known
  }
  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(
      ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}`, '--jq', '.id'],
      { ...ghOptions, timeout: 10_000 }
    )
    const id = Number(stdout.trim())
    if (!Number.isSafeInteger(id) || id <= 0) {
      return null
    }
    repositoryIds.set(key, id)
    return id
  } catch {
    return null
  } finally {
    release()
  }
}

// Within the turn note's wait, so a slow server only drops the read.
const REMOTE_READ_TIMEOUT_MS = 10_000

type RemoteCall = <T>(method: string, params: unknown) => Promise<T>

/** A call to the worker's pinned server, or null when its Dispatch or workspace can't be read. */
async function pinnedServerCall(
  runtime: BotWorkRemoteRuntime,
  worker: BotWorkWorker
): Promise<{ call: RemoteCall; worktreeId: string } | null> {
  const federated = worker.worktreeId
    ? runtime.getOrchestrationDb().getFederatedDispatch(worker.dispatchId)
    : undefined
  if (!federated || !worker.worktreeId) {
    return null
  }
  const server = await resolvePinnedFederatedServer(runtime, federated)
  const call: RemoteCall = async <T>(method: string, params: unknown): Promise<T> =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each call names a paired Orca method whose reply is that shape, as federationShow's reader trusts it.
    (await runtime.callOrchestrationWorkerServer(
      server.environmentId,
      method,
      params,
      REMOTE_READ_TIMEOUT_MS,
      undefined,
      { expectedEnvironmentPairingRevision: server.pairingRevision }
    )) as T
  return { call, worktreeId: worker.worktreeId }
}

/** The worker's repository's origin on its server, with the id this machine's GitHub gives that
 *  name (the server reads no id): a fork is matched by its id, which is all a pull request names of
 *  it. Null when the server names none. */
export async function readRemoteGitHubRepo(
  runtime: BotWorkRemoteRuntime,
  worker: BotWorkWorker
): Promise<GitHubRepoRef | null> {
  const pinned = await pinnedServerCall(runtime, worker)
  if (!pinned) {
    return null
  }
  const { worktree } = await pinned.call<{ worktree: Pick<Worktree, 'repoId'> }>('worktree.show', {
    worktree: `id:${pinned.worktreeId}`
  })
  const slug = await pinned.call<GitHubRepositoryIdentity | null>('github.repoSlug', {
    repo: `id:${worktree.repoId}`
  })
  if (!slug) {
    return null
  }
  return { id: await getGitHubRepositoryId(slug), fullName: `${slug.owner}/${slug.repo}` }
}
