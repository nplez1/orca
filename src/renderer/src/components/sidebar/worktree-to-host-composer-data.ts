import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { isHostLocalProjectId } from '../../../../shared/project-host-setup-projection'
import type { GitPushTarget, Worktree } from '../../../../shared/worktree/types'
import { branchName } from '@/lib/source-control/branches/branch-name'
import { resolveWorktreeBranchLabel } from '@/lib/worktree-default-display-name'
import type { ComposerModalData } from '@/components/NewWorkspaceComposerModal'

/** Where a branch is expected to live on a host that has not created a local copy of it. */
const DEFAULT_BASE_REMOTE = 'origin'

/** Why the copy cannot happen, in the terms the menu shows the user. */
export type AddWorktreeToAnotherHostRefusal =
  | 'folder-project'
  | 'project-without-shared-remote'
  | 'publish-remote-not-recreatable'

export type AddWorktreeToAnotherHostAvailability =
  | { kind: 'available' }
  | { kind: 'refused'; reason: AddWorktreeToAnotherHostRefusal }
  /** Nothing to offer at all: a detached HEAD has no branch identity to recreate. */
  | { kind: 'hidden' }

/**
 * The remote the copy's branch is expected to be fetched from on the target host.
 *
 * Every host's own checkout has `origin`; any other remote exists only where Orca (or the
 * user) created it, so the target needs its URL to recreate it.
 */
function copyBaseRemote(target: GitPushTarget | undefined): string {
  return target?.remoteName.trim() || DEFAULT_BASE_REMOTE
}

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
  const baseBranch = worktree.pushTarget?.branchName ?? branch
  const baseRemote = copyBaseRemote(worktree.pushTarget)
  // Why: a target host has to recreate a remote Orca added here, and the URL is the only thing
  // that names it there; `remoteCreated` describes this host's ownership, not the copy's.
  const pushTargetUrl = worktree.pushTarget?.remoteUrl?.trim()
  return {
    ...(projectId ? { initialWorkspaceTarget: { projectId } } : {}),
    // Why: a row that never got a durable project id still names its repo; the composer
    // resolves the project from that instead of an invented identity key.
    initialRepoId: worktree.repoId,
    lockedWorkspaceBranch: branch,
    // Why: the clone of a primary checkout *is* that workspace on the target host, and the clone of
    // any other workspace is not, even when it lands on the same branch.
    lockedWorkspaceIsPrimary: worktree.isMainWorktree === true,
    ...(branch ? { initialBaseBranch: `${baseRemote}/${baseBranch}` } : {}),
    ...(pushTargetUrl
      ? {
          lockedWorkspacePushTarget: {
            remoteName: baseRemote,
            branchName: baseBranch,
            remoteUrl: pushTargetUrl
          }
        }
      : {}),
    lockedWorkspaceSourceHostId: getWorktreeExecutionHostId(worktree, repo ?? undefined),
    ...(worktree.runtimeOwnerEnvironmentId
      ? { lockedWorkspaceSourceRuntimeOwnerEnvironmentId: worktree.runtimeOwnerEnvironmentId }
      : {}),
    telemetrySource: 'sidebar'
  }
}

/**
 * Whether the row offers "Add to another host…", and why not when it doesn't.
 *
 * The item is offered for every workspace on a branch of a git project: the deciding fact is
 * the branch being copied, not whether this row is the repo's primary checkout. What the copy
 * needs on the target is a way to find that branch, so a project with no shared remote, or a
 * branch published to a remote nothing can recreate, is refused with its reason.
 */
export function getAddWorktreeToAnotherHostAvailability({
  worktree,
  repo,
  projectId
}: {
  worktree: Pick<Worktree, 'branch' | 'pushTarget'>
  repo: Pick<Repo, 'kind'> | null | undefined
  projectId: string | null
}): AddWorktreeToAnotherHostAvailability {
  if (repo && !isGitRepoKind(repo)) {
    return { kind: 'refused', reason: 'folder-project' }
  }
  // Why: persisted and discovered rows can reach the sidebar without a branch, so this is a
  // string-shaped value, not a guaranteed one.
  if (typeof worktree.branch !== 'string' || branchName(worktree.branch).trim().length === 0) {
    return { kind: 'hidden' }
  }
  // Why: repo:<id> is a host-local key, so no other host can match the project it names.
  if (projectId !== null && isHostLocalProjectId(projectId)) {
    return { kind: 'refused', reason: 'project-without-shared-remote' }
  }
  // Why: a branch only another host's remote holds cannot be fetched where that remote is absent.
  if (
    worktree.pushTarget &&
    copyBaseRemote(worktree.pushTarget) !== DEFAULT_BASE_REMOTE &&
    !worktree.pushTarget.remoteUrl?.trim()
  ) {
    return { kind: 'refused', reason: 'publish-remote-not-recreatable' }
  }
  return { kind: 'available' }
}
