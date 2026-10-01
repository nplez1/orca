import type { PRMergeableState, PRReviewDecision, PRState } from './pull-request-types'

/** The pull-request facts an admin-bypass decision reads. */
export type GitHubPRAdminBypassInput = {
  state: PRState | 'open' | 'closed' | 'merged' | 'draft'
  mergeable?: PRMergeableState
  mergeStateStatus?: string | null
  reviewDecision?: PRReviewDecision | null
  viewerCanMergeAsAdmin?: boolean
  mergeQueueRequired?: boolean | null
}

/**
 * GitHub's MergeStateStatus values where the merge box is open *for this viewer*. UNSTABLE still
 * merges — it marks non-required checks failing — and HAS_HOOKS is pre-receive hooks, a push-time
 * concern rather than a gate.
 */
const OPEN_MERGE_BOX_STATES = new Set(['clean', 'unstable', 'has_hooks'])

/**
 * Whether branch protection is the only thing standing between this viewer and a merge — the single
 * question a caller must answer before it may merge with admin privileges.
 *
 * `reviewDecision` reports that a review is required, not whether the requirement gates the person
 * asking. A repository ruleset's bypass list, or an administrator waiving classic branch protection,
 * makes those two different answers, and `viewerCanMergeAsAdmin` is GitHub's answer for this viewer,
 * so it is the only thing consulted about privilege. Every other condition exists to keep the bypass
 * from reaching further than the user agreed to:
 *
 * - A closed or draft pull request has nothing to merge, and a conflicting one is blocked by
 *   something a bypass cannot fix.
 * - The base branch must be *known* not to require a merge queue, because the one flag that carries
 *   a bypass to GitHub also skips the queue: `mergeQueueRequired` is `null` when the merge-metadata
 *   probe was rate-limited or has not run, and unknown is not permission.
 * - GitHub's own merge verdict must already be open. A `BLOCKED` state can mean required checks are
 *   failing, and a bypass that waived those under a confirmation that only mentioned an unmet review
 *   would be reaching past what the user agreed to. Where the review gate is what blocks a viewer
 *   who cannot waive it, GitHub reports BLOCKED — which is why an unknown privilege must never read
 *   as permission, and why a blocked merge box stays blocked here.
 */
export function isGitHubPRAdminBypassAvailable(item: GitHubPRAdminBypassInput): boolean {
  const mergeStateStatus = (item.mergeStateStatus ?? '').toLowerCase()
  return (
    item.viewerCanMergeAsAdmin === true &&
    item.state === 'open' &&
    item.mergeQueueRequired === false &&
    item.mergeable !== 'CONFLICTING' &&
    mergeStateStatus !== 'dirty' &&
    OPEN_MERGE_BOX_STATES.has(mergeStateStatus) &&
    (item.reviewDecision === 'REVIEW_REQUIRED' || item.reviewDecision === 'CHANGES_REQUESTED')
  )
}
