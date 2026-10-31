import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { hostedReviewInfoFromGitHubPRInfo } from '../../../../shared/hosted-review-github'
import { isGitHubPRSuppressed } from '../../../../shared/worktree/github-pr-suppression'
import { isStaleMergedGitHubReviewForHead } from '../../store/slices/hosted-review-cache-state'

export type ChecksPanelReview = HostedReviewInfo

export type ChecksPanelReviewSelectionInput = {
  hostedReview: HostedReviewInfo | null | undefined
  pr: PRInfo | null | undefined
  linkedPR: number | null
  suppressedGitHubPR: number | null
  linkedGitLabMR: number | null
  linkedBitbucketPR: number | null
  linkedAzureDevOpsPR: number | null
  linkedGiteaPR: number | null
  /**
   * A hosted GitHub review used only while the PR cache has no answer for the branch. Every
   * GitHub surface reads the PR cache, so a hosted copy may only stand in for a missing one.
   */
  githubFallback?: HostedReviewInfo | null
}

export function gitHubPRToChecksPanelReview(pr: PRInfo): ChecksPanelReview {
  // Reuse the GitHub mapper so merge-state metadata cannot drift and regress action labels.
  return hostedReviewInfoFromGitHubPRInfo(pr)
}

function gitHubReviewNumberPassesGates(
  number: number,
  input: Pick<ChecksPanelReviewSelectionInput, 'linkedPR' | 'suppressedGitHubPR'>
): boolean {
  if (input.linkedPR !== null && number !== input.linkedPR) {
    return false
  }
  return !isGitHubPRSuppressed(
    { linkedPR: input.linkedPR, suppressedGitHubPR: input.suppressedGitHubPR },
    number
  )
}

export function selectChecksPanelReview({
  hostedReview,
  pr,
  linkedPR,
  suppressedGitHubPR,
  linkedGitLabMR,
  linkedBitbucketPR,
  linkedAzureDevOpsPR,
  linkedGiteaPR,
  githubFallback = null
}: ChecksPanelReviewSelectionInput): ChecksPanelReview | null {
  const gitLabHostedReview = hostedReview?.provider === 'gitlab' ? hostedReview : null
  if (gitLabHostedReview) {
    return gitLabHostedReview
  }
  const hasNonGitHubLinkedReview =
    linkedGitLabMR !== null ||
    linkedBitbucketPR !== null ||
    linkedAzureDevOpsPR !== null ||
    linkedGiteaPR !== null
  if (hasNonGitHubLinkedReview) {
    return null
  }
  if (pr) {
    if (!gitHubReviewNumberPassesGates(pr.number, { linkedPR, suppressedGitHubPR })) {
      return null
    }
    return gitHubPRToChecksPanelReview(pr)
  }
  if (githubFallback?.provider === 'github') {
    if (!gitHubReviewNumberPassesGates(githubFallback.number, { linkedPR, suppressedGitHubPR })) {
      return null
    }
    return githubFallback
  }
  return null
}

export type WorkspaceReviewStateInput = Omit<
  ChecksPanelReviewSelectionInput,
  'pr' | 'hostedReview' | 'githubFallback'
> & {
  /** The branch's GitHub PR cache entry; absent until the PR cache has answered for the branch. */
  prEntry: { data: PRInfo | null } | undefined
  /** The provider-neutral hosted-review cache entry for the branch. */
  hostedEntry: { data: HostedReviewInfo | null } | undefined
  /** The workspace's checked-out HEAD, for merged-review ownership. */
  currentHeadOid: string | null | undefined
}

/**
 * The single review state a workspace shows. The Checks pane and the sidebar card both resolve
 * through this function, so the card's PR glyph cannot describe a different state than the pane —
 * only the presentation differs. A merged GitHub review is dropped by the same head-ownership
 * gate on both surfaces, and the PR cache outranks a hosted-review copy because that is what the
 * pane renders.
 */
export function selectWorkspaceReviewState(
  input: WorkspaceReviewStateInput
): ChecksPanelReview | null {
  // Why: a merged review only describes this workspace while its head is still checked out, and
  // a branch cache may outlive merged work — both caches need the same gate to stay in step.
  const pr = isStaleMergedGitHubReviewForHead(input.prEntry, input.currentHeadOid)
    ? null
    : (input.prEntry?.data ?? null)
  const hostedReview = isStaleMergedGitHubReviewForHead(input.hostedEntry, input.currentHeadOid)
    ? null
    : (input.hostedEntry?.data ?? null)
  return selectChecksPanelReview({
    hostedReview,
    pr,
    // Why: only a missing PR-cache answer lets the hosted copy stand in. Once the PR cache has
    // answered — even with "no PR" — it is the same answer the pane shows.
    githubFallback: input.prEntry === undefined ? hostedReview : null,
    linkedPR: input.linkedPR,
    suppressedGitHubPR: input.suppressedGitHubPR,
    linkedGitLabMR: input.linkedGitLabMR,
    linkedBitbucketPR: input.linkedBitbucketPR,
    linkedAzureDevOpsPR: input.linkedAzureDevOpsPR,
    linkedGiteaPR: input.linkedGiteaPR
  })
}
