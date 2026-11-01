import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { PRInfo } from '../../../../shared/github/pull-request-types'

/** The PR shape the Checks pane reads out of a review it was not handed by the PR cache.
 *
 *  The pane's own review comes from `prCache`, but a review picked in the switcher comes from the
 *  hosted-review cache, which carries the same fields under different names. The two types are the
 *  same data on purpose — `hostedReviewInfoFromGitHubPRInfo` maps the other way — so this is a
 *  faithful rename rather than a guess: nothing here is defaulted, and a field the review does not
 *  have stays absent instead of being invented.
 *
 *  GitHub only: every other provider's review has no checks/comment body in this pane, and a
 *  fabricated GitHub PR for one would let the pane act on a provider it cannot read. */
export function gitHubPRInfoFromHostedReview(
  review: HostedReviewInfo | null | undefined
): PRInfo | null {
  if (!review || review.provider !== 'github') {
    return null
  }
  return {
    number: review.number,
    title: review.title,
    state: review.state,
    url: review.url,
    checksStatus: review.status,
    updatedAt: review.updatedAt,
    mergeable: review.mergeable,
    ...(review.reviewDecision !== undefined ? { reviewDecision: review.reviewDecision } : {}),
    ...(review.viewerCanMergeAsAdmin !== undefined
      ? { viewerCanMergeAsAdmin: review.viewerCanMergeAsAdmin }
      : {}),
    ...(review.autoMergeEnabled !== undefined ? { autoMergeEnabled: review.autoMergeEnabled } : {}),
    ...(review.autoMergeAllowed !== undefined ? { autoMergeAllowed: review.autoMergeAllowed } : {}),
    ...(review.mergeQueueRequired !== undefined
      ? { mergeQueueRequired: review.mergeQueueRequired }
      : {}),
    ...(review.mergeStateStatus !== undefined ? { mergeStateStatus: review.mergeStateStatus } : {}),
    ...(review.headSha ? { headSha: review.headSha } : {}),
    ...(review.githubRepository ? { prRepo: review.githubRepository } : {}),
    ...(review.confirmedContainedHeadOid
      ? { confirmedContainedHeadOid: review.confirmedContainedHeadOid }
      : {}),
    ...(review.baseRefName ? { baseRefName: review.baseRefName } : {}),
    ...(review.conflictSummary ? { conflictSummary: review.conflictSummary } : {})
  }
}
