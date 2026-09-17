import type { GitCommandRunner } from '../git-effective-upstream'
import { resolveEffectiveGitUpstreamForBranchName } from '../git-effective-upstream'

/**
 * `git push --delete` is unconditional on the server — there is no remote equivalent of
 * `branch -d`'s merged-commit refusal. So the outcome is reported rather than inferred:
 * callers must not treat "we asked" as "it is gone".
 */
export type RemoteBranchCleanupStatus =
  | 'deleted'
  /** The server had no such ref; the goal state already held. */
  | 'already-absent'
  /** No upstream resolved, so there was no remote branch to target. */
  | 'no-upstream'
  /** The local branch is still present, so its remote was deliberately left alone. */
  | 'skipped-preserved'
  | 'failed'

export type RemoteBranchCleanup = {
  status: RemoteBranchCleanupStatus
  remoteName?: string
  branchName?: string
  /** Git's own text, for `failed` only. */
  message?: string
}

export type RemoteBranchTarget = { remoteName: string; branchName: string }

export type RemoteBranchTargetResolution =
  | { kind: 'resolved'; target: RemoteBranchTarget }
  | { kind: 'no-upstream' }

/** Git's wording when `push --delete` targets a ref the server does not have. */
const REMOTE_REF_ABSENT_RE = /remote ref does not exist/i

function isValidRemoteBranchName(branchName: string): boolean {
  return (
    branchName.length > 0 &&
    !branchName.includes('\0') &&
    !branchName.startsWith('-') &&
    !branchName.includes('..')
  )
}

/**
 * Resolves the remote branch that pairs with `branchName` on the host that owns the repo.
 *
 * Must run while the branch's config still exists: `git branch -d` and Orca's own
 * `git config --remove-section branch.<name>` both erase the upstream this reads, and both
 * run as part of the same worktree removal.
 */
export async function resolveRemoteBranchTarget(
  runGit: GitCommandRunner,
  branchName: string
): Promise<RemoteBranchTargetResolution> {
  if (!isValidRemoteBranchName(branchName)) {
    return { kind: 'no-upstream' }
  }
  const upstream = await resolveEffectiveGitUpstreamForBranchName(runGit, branchName)
  if (!upstream?.remoteName) {
    return { kind: 'no-upstream' }
  }
  return {
    kind: 'resolved',
    target: { remoteName: upstream.remoteName, branchName: upstream.branchName }
  }
}

async function localBranchExists(runGit: GitCommandRunner, branchName: string): Promise<boolean> {
  try {
    await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`])
    return true
  } catch {
    return false
  }
}

/**
 * Deletes the resolved remote branch, but only once the local branch is provably gone.
 *
 * The check is an observation rather than a flag because the local branch outlives removal for
 * several unrelated reasons — kept for unmerged commits, still checked out in another worktree,
 * or pinned by `preserveBranchOnDelete` — and every one of them means the local ref may be the
 * only remaining copy of commits. Reading the ref covers all of them, including paths added
 * later, without asking each caller to classify why it kept the branch.
 *
 * Never throws: the checkout is already gone by the time this runs, so a network, auth, or SSH
 * failure must degrade to a reported outcome rather than a delete that reports failure while the
 * workspace is in fact half-removed.
 */
export async function deleteRemoteBranchAfterLocalBranchRemoval(args: {
  runGit: GitCommandRunner
  branchName: string
  target: RemoteBranchTargetResolution
}): Promise<RemoteBranchCleanup> {
  if (await localBranchExists(args.runGit, args.branchName)) {
    return { status: 'skipped-preserved' }
  }
  if (args.target.kind === 'no-upstream') {
    return { status: 'no-upstream' }
  }
  const { remoteName, branchName } = args.target.target
  const target = { remoteName, branchName }
  try {
    await args.runGit(['push', '--delete', remoteName, branchName])
    return { status: 'deleted', ...target }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (REMOTE_REF_ABSENT_RE.test(message)) {
      return { status: 'already-absent', ...target }
    }
    return { status: 'failed', ...target, message }
  }
}
