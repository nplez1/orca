import type { GitCommandRunner } from '../git/remotes/git-effective-upstream'
import { resolveEffectiveGitUpstreamForBranchName } from '../git/remotes/git-effective-upstream'

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
  /**
   * The branch tracks a remote branch of a different name, so there is no evidence this workspace
   * ever owned it.
   */
  | 'skipped-foreign-branch'
  /** The target is the remote's default (HEAD) branch, which is never a workspace's to delete. */
  | 'skipped-default-branch'
  /** The remote moved since the last fetch, so deleting would discard commits nobody has seen. */
  | 'skipped-changed-on-remote'
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

/** Git's wording when the leased ref is not the commit we last saw. */
const REMOTE_REF_STALE_RE = /stale info/i

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

/**
 * The remote's own HEAD branch, as far as this clone knows it.
 *
 * Read from `refs/remotes/<remote>/HEAD` rather than asked of the server: this runs after the
 * checkout is already gone, where a network round trip can only delay a delete. A clone that never
 * recorded it yields null, which is the same evidence we had before.
 */
async function remoteDefaultBranch(
  runGit: GitCommandRunner,
  remoteName: string
): Promise<string | null> {
  try {
    const { stdout } = await runGit([
      'symbolic-ref',
      '--quiet',
      '--short',
      `refs/remotes/${remoteName}/HEAD`
    ])
    const ref = stdout.trim()
    const prefix = `${remoteName}/`
    return ref.startsWith(prefix) ? ref.slice(prefix.length) : null
  } catch {
    return null
  }
}

/** The commit this clone last saw at the remote branch, which is the lease the delete is made under. */
async function lastSeenRemoteSha(
  runGit: GitCommandRunner,
  remoteName: string,
  branchName: string
): Promise<string | null> {
  try {
    const { stdout } = await runGit([
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/${remoteName}/${branchName}`
    ])
    const sha = stdout.trim()
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null
  } catch {
    return null
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
  // Why a name check and not just the upstream: `git push --delete` is unconditional on the server,
  // and an upstream routinely names a branch nobody here authored — a branch cut with
  // `git checkout -b feat origin/develop` tracks `develop`, and a review worktree can track a
  // contributor's fork. Deleting on that evidence would remove someone else's branch.
  if (branchName !== args.branchName) {
    return { status: 'skipped-foreign-branch', ...target }
  }
  if ((await remoteDefaultBranch(args.runGit, remoteName)) === branchName) {
    return { status: 'skipped-default-branch', ...target }
  }
  // Why the lease: `branch -d` refused anything unmerged locally, but the remote has no equivalent
  // refusal — without a lease this deletes commits pushed since the last fetch, which nobody here
  // has ever seen.
  //
  // Why an empty expectation when nothing was last seen: that is also the state a merged PR with
  // GitHub's auto-delete leaves behind, once `fetch --prune` has dropped the tracking ref — the
  // branch is gone, not unverifiable. `--force-with-lease=<ref>:` succeeds only if the ref does not
  // exist, so the gone case reports `already-absent` and a branch that reappeared while we looked
  // reports `stale info`. Refusing outright instead reported "tracks no remote branch" for both.
  const lastSeen = await lastSeenRemoteSha(args.runGit, remoteName, branchName)
  try {
    await args.runGit([
      'push',
      `--force-with-lease=refs/heads/${branchName}:${lastSeen ?? ''}`,
      remoteName,
      `:refs/heads/${branchName}`
    ])
    return { status: 'deleted', ...target }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (REMOTE_REF_ABSENT_RE.test(message)) {
      return { status: 'already-absent', ...target }
    }
    if (REMOTE_REF_STALE_RE.test(message)) {
      return { status: 'skipped-changed-on-remote', ...target }
    }
    return { status: 'failed', ...target, message }
  }
}
