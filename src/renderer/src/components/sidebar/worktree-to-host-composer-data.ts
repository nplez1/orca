import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { Worktree } from '../../../../shared/worktree/types'
import { branchName } from '@/lib/git-utils'
import { resolveWorktreeBranchLabel } from '@/lib/worktree-default-display-name'
import type { ComposerModalData } from '@/components/NewWorkspaceComposerModal'

/** Where a branch is expected to live on a host that has not created a local copy of it. */
const DEFAULT_BASE_REMOTE = 'origin'

/**
 * Composer data for "add this workspace to another host".
 *
 * The workspace already fixed the project and the branch, so both are handed to the
 * composer as implied facts and the run-target picker is left as the only decision —
 * the same create path (hooks, setup scripts, toasts) runs either way.
 */
export function buildWorktreeToHostComposerData({
  worktree,
  repo,
  projectId
}: {
  worktree: Worktree
  repo: Repo | null | undefined
  projectId: string | null
}): ComposerModalData {
  const branch = resolveWorktreeBranchLabel(worktree)
  // Why: a target host usually knows this branch only as a remote-tracking ref, so the
  // start point is the remote copy; that is also what stops the create from treating the
  // remote branch as a conflict and renaming the copy.
  const baseBranch = worktree.pushTarget?.branchName ?? branch
  // Why: a remote Orca created while preparing the workspace exists only on its own host, so the
  // copy starts from the default remote instead of a ref the target never fetches.
  const baseRemote =
    (worktree.pushTarget && !worktree.pushTarget.remoteCreated
      ? worktree.pushTarget.remoteName.trim()
      : '') || DEFAULT_BASE_REMOTE
  return {
    ...(projectId ? { initialWorkspaceTarget: { projectId } } : {}),
    // Why: a row that never got a durable project id still names its repo; the composer
    // resolves the project from that instead of an invented identity key.
    initialRepoId: worktree.repoId,
    lockedWorkspaceBranch: branch,
    ...(branch ? { initialBaseBranch: `${baseRemote}/${baseBranch}` } : {}),
    lockedWorkspaceSourceHostId: getWorktreeExecutionHostId(worktree, repo ?? undefined),
    ...(worktree.runtimeOwnerEnvironmentId
      ? { lockedWorkspaceSourceRuntimeOwnerEnvironmentId: worktree.runtimeOwnerEnvironmentId }
      : {}),
    telemetrySource: 'sidebar'
  }
}

/**
 * A workspace can only be copied while it is on a branch of a git project — a detached HEAD
 * has nothing to recreate, and a folder project has no Available Hosts section to land in.
 */
export function canAddWorktreeToAnotherHost({
  worktree,
  repo
}: {
  worktree: Pick<Worktree, 'branch' | 'isMainWorktree' | 'pushTarget'>
  repo: Pick<Repo, 'kind'> | null | undefined
}): boolean {
  if (repo && !isGitRepoKind(repo)) {
    return false
  }
  // Why: the target host's own checkout already holds the default branch, so a copy of it can
  // only ever collide.
  if (worktree.isMainWorktree === true) {
    return false
  }
  // Why: a fork-PR workspace starts from a head ref that only exists on the remote Orca added on
  // this host; another host would resolve the name against upstream, or not at all.
  if (worktree.pushTarget?.remoteCreated === true || worktree.pushTarget?.remoteUrl) {
    return false
  }
  // Why: persisted and discovered rows can reach the sidebar without a branch, so this is a
  // string-shaped value, not a guaranteed one.
  return typeof worktree.branch === 'string' && branchName(worktree.branch).trim().length > 0
}
