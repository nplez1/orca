import type { HostedReviewInfo } from '../../../shared/hosted-review'
import type { CheckStatus } from '../../../shared/github/pull-request-types'
import { translate } from '@/i18n/i18n'

/**
 * Whether a review can merge, which is a different question from whether its checks passed:
 * checks are one requirement a provider may impose, alongside approvals, resolved threads,
 * branch-protection rules, and a merge queue.
 */
export type HostedReviewMergeReadiness =
  | 'mergeable'
  | 'waiting'
  | 'blocked'
  | 'undetermined'
  | 'not-applicable'

/**
 * What the card's corner dot shows. `checking` exists so that "the provider has not decided yet"
 * cannot masquerade as "nothing is blocking": during GitHub's recompute after a push even an
 * approval-blocked PR is genuinely unknown, and a dotless green glyph would read as mergeable.
 */
export type HostedReviewMergeMarker = 'none' | 'checking' | 'waiting' | 'blocked'

export type HostedReviewMergeReadinessInput = {
  state?: HostedReviewInfo['state']
  mergeable?: HostedReviewInfo['mergeable']
  mergeStateStatus?: string | null
  reviewDecision?: HostedReviewInfo['reviewDecision']
  mergeQueueRequired?: boolean | null
  /** Provider roll-up of CI, e.g. `HostedReviewInfo['status']`. */
  status?: CheckStatus
}

export type HostedReviewMergeReadinessPresentation = {
  readiness: HostedReviewMergeReadiness
  marker: HostedReviewMergeMarker
  /**
   * Localized reason, or empty when there is nothing to add. Empty is the signal that the checks
   * badge beside this one already carries the story (a failing or pending roll-up), or that the
   * provider reported no merge state at all.
   */
  reason: string
}

/**
 * GitHub's MergeStateStatus values that mean "the merge box is open". UNSTABLE still merges — it
 * marks *non-required* checks failing — and HAS_HOOKS is pre-merge hooks, not a gate.
 */
const READY_GITHUB_MERGE_STATES = new Set(['clean', 'unstable', 'has_hooks'])

/** GitLab detailed_merge_status values that name a policy gate rather than a named human action. */
const BLOCKED_GITLAB_MERGE_STATES = new Set([
  'policies_denied',
  'external_status_checks',
  'security_policy_violations',
  'locked_paths',
  'locked_lfs_files',
  'jira_association_missing',
  'title_regex',
  'not_open'
])

/** GitLab reports a draft through merge status when the MR state itself is already mapped to draft. */
const DRAFT_MERGE_STATES = new Set(['draft', 'draft_status'])

/** Sentinel for "readiness is settled, but CI is the only thing that settled it". */
const CHECKS_ONLY = ''

function presentation(
  readiness: HostedReviewMergeReadiness,
  marker: HostedReviewMergeMarker,
  reason: string
): HostedReviewMergeReadinessPresentation {
  return { readiness, marker, reason }
}

function ready(): HostedReviewMergeReadinessPresentation {
  return presentation(
    'mergeable',
    'none',
    translate('auto.components.hosted.review.merge.readiness.ready', 'Ready to merge')
  )
}

/** Mergeable, but the reason is CI's to report — the checks badge already says it. */
function readyWithChecksTheOnlyStory(): HostedReviewMergeReadinessPresentation {
  return presentation('mergeable', 'none', CHECKS_ONLY)
}

function waiting(reason: string): HostedReviewMergeReadinessPresentation {
  return presentation('waiting', 'waiting', reason)
}

function blocked(reason: string): HostedReviewMergeReadinessPresentation {
  return presentation('blocked', 'blocked', reason)
}

/** A blocker CI already displays: readiness is reported, but nothing new is claimed. */
function heldByChecks(readiness: 'waiting' | 'blocked'): HostedReviewMergeReadinessPresentation {
  return presentation(readiness, 'none', CHECKS_ONLY)
}

function checking(): HostedReviewMergeReadinessPresentation {
  return presentation(
    'undetermined',
    'checking',
    translate('auto.components.hosted.review.merge.readiness.checking', 'Checking')
  )
}

/** No merge state was reported at all; there is nothing to say, so nothing is claimed. */
function unreported(): HostedReviewMergeReadinessPresentation {
  return presentation('undetermined', 'none', CHECKS_ONLY)
}

/**
 * The verdict a surface may repeat, or null when there is nothing worth saying.
 *
 * Why one rule: three surfaces show this (the card's tooltip, its hover-details badge, and the
 * tasks-row pill) and they must agree. A checks-only blocker is null because the checks badge
 * beside it already says the same thing, and an unreported merge state is null because "we do not
 * know" is not a verdict — restating it on every loading row is noise. A *computing* state is
 * different: it has a reason, so it speaks.
 */
export function hostedReviewMergeVerdictLabel(
  presentation: HostedReviewMergeReadinessPresentation
): string | null {
  return presentation.reason === CHECKS_ONLY ? null : presentation.reason
}

/**
 * The marker is raised only when the provider demonstrably is not letting this merge, so a
 * missing reason must never resolve to `mergeable` — that is the whole point of the change.
 */
export function getHostedReviewMergeReadiness(
  review: HostedReviewMergeReadinessInput
): HostedReviewMergeReadinessPresentation {
  if (review.state === undefined) {
    // A linked-review row renders before (or without) its details; there is no review state to
    // judge, so claim nothing. The glyph is muted in this state, so silence cannot read as green.
    return unreported()
  }

  const mergeStateStatus = (review.mergeStateStatus ?? '').trim().toLowerCase()

  if (review.state !== 'open' || DRAFT_MERGE_STATES.has(mergeStateStatus)) {
    return presentation('not-applicable', 'none', CHECKS_ONLY)
  }

  // Conflicts first: the one blocker every provider reports, and the most actionable.
  if (review.mergeable === 'CONFLICTING' || mergeStateStatus === 'dirty') {
    return blocked(
      translate('auto.components.hosted.review.merge.readiness.conflicts', 'Conflicts')
    )
  }

  // Review verdicts, from the field that names the human action rather than the generic gate.
  if (review.reviewDecision === 'CHANGES_REQUESTED' || mergeStateStatus === 'requested_changes') {
    return blocked(
      translate(
        'auto.components.hosted.review.merge.readiness.changesRequested',
        'Changes requested'
      )
    )
  }
  if (review.reviewDecision === 'REVIEW_REQUIRED' || mergeStateStatus === 'not_approved') {
    return waiting(
      translate(
        'auto.components.hosted.review.merge.readiness.approvalRequired',
        'Approval required'
      )
    )
  }

  if (mergeStateStatus === 'discussions_not_resolved') {
    return waiting(
      translate(
        'auto.components.hosted.review.merge.readiness.unresolvedThreads',
        'Unresolved threads'
      )
    )
  }

  if (mergeStateStatus === 'behind' || mergeStateStatus === 'need_rebase') {
    return waiting(translate('auto.components.hosted.review.merge.readiness.behind', 'Behind base'))
  }

  // A queue withholds the direct merge, so it outranks a CLEAN merge box.
  if (review.mergeQueueRequired === true) {
    return waiting(
      translate('auto.components.hosted.review.merge.readiness.mergeQueue', 'Merge queue')
    )
  }

  if (
    mergeStateStatus === 'blocked' ||
    mergeStateStatus === 'blocked_status' ||
    BLOCKED_GITLAB_MERGE_STATES.has(mergeStateStatus)
  ) {
    return blocked(translate('auto.components.hosted.review.merge.readiness.blocked', 'Blocked'))
  }

  // Provider-specific "your checks must pass" gates: the checks badge already says so.
  if (mergeStateStatus === 'ci_must_pass') {
    return heldByChecks('blocked')
  }
  if (mergeStateStatus === 'ci_still_running') {
    return heldByChecks('waiting')
  }

  if (READY_GITHUB_MERGE_STATES.has(mergeStateStatus)) {
    // Why CI does not downgrade readiness here: an open merge box already means every *required*
    // check passed, so a failing optional check does not withhold the merge — that is precisely
    // what UNSTABLE means. Reporting it as blocked would be a wrong answer in the one module
    // other surfaces trust.
    const checksAreTheOnlyStory = review.status === 'failure' || review.status === 'pending'
    return checksAreTheOnlyStory ? readyWithChecksTheOnlyStory() : ready()
  }

  if (mergeStateStatus === '' && review.mergeable === 'MERGEABLE') {
    // Why this path *does* weigh checks: a bare `mergeable` — all Bitbucket, Azure DevOps and
    // Gitea report — means only "no conflicts". It says nothing about required checks or
    // approvals, so it is not enough on its own when CI is red.
    if (review.status === 'failure') {
      return heldByChecks('blocked')
    }
    if (review.status === 'pending') {
      return heldByChecks('waiting')
    }
    return ready()
  }

  if (mergeStateStatus === '') {
    return unreported()
  }

  // Why a marker rather than silence: GitHub reports mergeStateStatus=UNKNOWN while it recomputes
  // the merge box after a push. During that window every blocker is genuinely unknown, so a
  // dotless green glyph would assert a mergeability the provider has not granted — the exact
  // conflation this change removes. The muted dot says "not decided yet", and cannot be mistaken
  // for a blocker, so it is not a false alarm.
  return checking()
}
