import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import type { ChecksPanelReview } from '../checks-panel-review'
import type { WorkspaceReviewSelection } from '../use-workspace-review-selection'
import { isChecksPaneReviewProvider, pickShownReview } from '../workspace-review-selection'
import { gitHubPRInfoFromHostedReview } from '../hosted-review-to-pr-info'
import { isGitLabChecksPanelReview } from './gitlab-review-client'

export type ChecksPanelShownReview = {
  /** The review the pane renders: the pick when there is one it can render, else the workspace's. */
  activeReview: ChecksPanelReview | null
  /** The PR shape the pane's checks, comments and comment actions key on. */
  pr: PRInfo | null
  /** True when `activeReview` is a review the switcher picked rather than the workspace's own. */
  showsPickedReview: boolean
  activeGitLabReview: ChecksPanelReview | null
  isGitLabReviewContext: boolean
}

/** Which review the Checks pane shows, and the PR shape its reads key on.
 *
 *  Split out of the pane's context state so the decision that everything downstream depends on —
 *  which branch a fetch may pass, whether worktree-acting actions apply, which review a refresh
 *  re-reads — is one testable function rather than a chain of ternaries in a hook. */
export function resolveChecksPanelShownReview({
  branchPR,
  linkedGitLabMR,
  selection,
  workspaceReview
}: {
  /** The PR this workspace's own branch resolves to. */
  branchPR: PRInfo | null
  linkedGitLabMR: number | null
  selection: WorkspaceReviewSelection
  /** The review the workspace resolves to with no pick: its slots plus the branch caches. */
  workspaceReview: ChecksPanelReview | null
}): ChecksPanelShownReview {
  // Why only GitHub and GitLab: those are the providers this pane can render checks and comments
  // for, so a pick from another provider leaves the workspace's own review on screen rather than
  // blanking a pane that has nothing to show for it.
  const pickedReview = pickShownReview(selection, isChecksPaneReviewProvider)
  const activeReview: ChecksPanelReview | null = pickedReview ?? workspaceReview
  const activeGitLabReview = isGitLabChecksPanelReview(activeReview) ? activeReview : null
  return {
    activeReview,
    // Why derived from the review rather than left to the branch cache: a picked review is not this
    // branch's PR, so `prCache` has nothing for it. The mapping is a faithful rename of the same
    // fields, which keeps checks, comments and the head-sha freshness gate keyed on the shown PR.
    pr: pickedReview ? gitHubPRInfoFromHostedReview(pickedReview) : branchPR,
    showsPickedReview: pickedReview !== null,
    activeGitLabReview,
    // Why gated on the pick: a picked GitHub review must not read as a GitLab context just because
    // this workspace also holds a GitLab MR.
    isGitLabReviewContext: Boolean(activeGitLabReview || (!pickedReview && linkedGitLabMR !== null))
  }
}
