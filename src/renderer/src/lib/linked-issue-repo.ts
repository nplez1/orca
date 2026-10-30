import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getGitHubRepoLookupIndex } from '@/store/slices/github-repo-lookup-index'

/** The worktree fields the rule reads. Everything that renders or refreshes a workspace's
 *  linked issue resolves its repo through here, so the pane, the sidebar card and the
 *  refresh sweeps cannot disagree about which repo owns the number. */
type LinkedIssueWorktree = Pick<Worktree, 'repoId' | 'linkedWorkItem'>

/**
 * Repo that owns a workspace's linked issue number.
 *
 * A workspace is not always in its issue's repo: a task listed on one host creates the
 * workspace in the target project's repo on another host, and a folder workspace borrows a
 * synthetic repo id. The issue exists only in the repo the work item came from, so reading
 * the workspace repo asks the other host for a repo it does not have — the pane then renders
 * "Couldn't load this GitHub issue" over a link that was intact, and a project whose checkout
 * is a different fork answers with an unrelated issue of the same number.
 *
 * The item's repo is used only when the item *is* this link. `linkedIssue` and
 * `linkedWorkItem` are separate slots and `linkedIssue` wins, so a workspace created from a PR
 * (or a Linear task, or a different issue) can have a GitHub issue linked to it afterwards;
 * that item's repo is not this number's repo, and a number chosen through the link editor
 * comes from the workspace repo, which is where the fallback reads it.
 */
export function linkedIssueRepoId(
  worktree: LinkedIssueWorktree,
  issueNumber: number,
  /** The repo an attachment named, for a link that is not the worktree's active issue. */
  attachmentRepoId?: string | null
): string {
  if (attachmentRepoId) {
    return attachmentRepoId
  }
  const item = worktree.linkedWorkItem
  if (item?.provider !== 'github' || item.type !== 'issue' || item.number !== issueNumber) {
    return worktree.repoId
  }
  return item.repoId ?? worktree.repoId
}

/**
 * The row for that id, or null.
 *
 * Resolves through the store's memoised lookup index rather than scanning the array: the
 * refresh sweeps call this once per worktree, and a per-call scan re-reads every row, which is
 * the O(N*M) identity-read budget those paths are pinned to.
 */
export function findLinkedIssueRepo(
  /** Optional like `RepoRuntimeOwnerState.repos`: surfaces render against projected store
   *  states that may not carry the slice, and an absent list names no repo. */
  repos: readonly Repo[] | undefined,
  worktree: LinkedIssueWorktree,
  issueNumber: number,
  attachmentRepoId?: string | null
): Repo | null {
  return (
    getGitHubRepoLookupIndex(repos).findById(
      linkedIssueRepoId(worktree, issueNumber, attachmentRepoId)
    ) ?? null
  )
}

/**
 * True when the item names a repo this device does not have. Callers must show that instead
 * of resolving the number elsewhere: the same number in another project is a different issue,
 * and presenting it as this link's issue would be worse than saying the repo is missing.
 */
export function linkedIssueRepoIsOffDevice(
  repos: readonly Repo[] | undefined,
  worktree: LinkedIssueWorktree,
  issueNumber: number,
  attachmentRepoId?: string | null
): boolean {
  const repoId = linkedIssueRepoId(worktree, issueNumber, attachmentRepoId)
  // An absent slice is not evidence about where the issue lives; the workspace-repo case
  // keeps its existing "no row, nothing to show" behaviour.
  return repoId !== worktree.repoId && !getGitHubRepoLookupIndex(repos).findById(repoId)
}
