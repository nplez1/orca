import type {
  GitHubPRMergeMethod,
  PRInfo,
  PRState
} from '../../../../src/shared/github/pull-request-types'
import {
  resolveGitHubPRMergeState,
  type GitHubPRMergeStateKind
} from '../../../../src/shared/github/pull-request-merge-state'
import {
  resolveGitHubPRStackMergeDecision,
  type GitHubPRStackMergeBlocker
} from '../../../../src/shared/github/pull-request-stack-merge'

// Match desktop: drafts offer Ready for review and Close, never Merge; merged PRs only unlink.
export type PrActionAvailability = {
  canMerge: boolean
  canMarkReady: boolean
  canClose: boolean
  canReopen: boolean
  canUnlink: boolean
}

export function resolvePrActionAvailability(state: PRState): PrActionAvailability {
  return {
    canMerge: state === 'open',
    canMarkReady: state === 'draft',
    canClose: state === 'open' || state === 'draft',
    canReopen: state === 'closed',
    canUnlink: true
  }
}

// English copy for desktop's merge-state kinds; the shared rule decides which one applies.
const PR_MERGE_STATE_COPY: Record<GitHubPRMergeStateKind, { label: string; hint: string }> = {
  merged: { label: 'Merged', hint: 'This pull request is already merged' },
  closed: { label: 'Closed', hint: 'This pull request is closed' },
  draft: { label: 'Draft', hint: 'This pull request is still a draft' },
  review_required: {
    label: 'Approval required',
    hint: 'GitHub requires review approval before this pull request can merge'
  },
  changes_requested: {
    label: 'Changes requested',
    hint: 'GitHub reports requested changes on this pull request'
  },
  conflicts: { label: 'Conflicts', hint: 'GitHub reports merge conflicts' },
  merge_queue: {
    label: 'Merge when ready',
    hint: 'This base branch uses GitHub merge queue'
  },
  merge_queue_auto_merge_on: {
    label: 'Auto-merge on',
    hint: 'This base branch uses GitHub merge queue'
  },
  merge_status_unavailable: {
    label: 'Merge',
    hint: 'Merge status is unavailable for this PR'
  },
  behind: { label: 'Behind', hint: 'Update the branch before merging' },
  blocked: {
    label: 'Blocked',
    hint: 'GitHub reports this pull request is blocked'
  },
  mergeable_checks_failed: {
    label: 'Checks failed',
    hint: 'GitHub says this PR can merge, but some checks failed'
  },
  mergeable_checks_pending: {
    label: 'Checks pending',
    hint: 'GitHub says this PR can merge, but checks are still running'
  },
  mergeable_checks_passed: {
    label: 'Able to merge',
    hint: 'GitHub says this PR can merge and checks passed'
  },
  mergeable: { label: 'Able to merge', hint: 'GitHub says this PR can merge' },
  checks_passed: {
    label: 'Checks passed',
    hint: 'Checks passed. Merge eligibility will be checked again before merging.'
  },
  checking: {
    label: 'Checking',
    hint: 'GitHub is still computing this pull request merge status'
  }
}

const STACK_BLOCKER_COPY: Record<GitHubPRStackMergeBlocker['reason'], string> = {
  draft: 'is still a draft.',
  closed: 'is closed.',
  conflicts: 'has merge conflicts.',
  changes_requested: 'has requested changes.',
  review_required: 'still needs review approval.',
  behind: 'must be updated.',
  blocked: 'is blocked.'
}

// Desktop's merge-method labels; the desktop renderer translates the same three.
const MERGE_METHOD_LABELS: Record<GitHubPRMergeMethod, string> = {
  merge: 'Create merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge'
}

/** GitHub merge states where the merge box is open for the viewer asking about it. */
const MOBILE_OPEN_MERGE_BOX_STATES = new Set(['clean', 'unstable', 'has_hooks'])

export type PrMergePresentation = {
  enabled: boolean
  label: string
  hint: string | null
  confirmMessage: string
  showAutoMerge: boolean
}

// Desktop's merge gating, stack override included; GitHub merges a stacked PR with everything below it.
export function presentPrMerge(
  pr: PRInfo,
  defaultMethod: GitHubPRMergeMethod
): PrMergePresentation {
  const decision = resolveGitHubPRMergeState(pr)
  const blockedCopy = PR_MERGE_STATE_COPY[decision.kind]
  if (!pr.stack) {
    return {
      enabled: decision.directMergeAvailable,
      label: decision.directMergeAvailable ? MERGE_METHOD_LABELS[defaultMethod] : blockedCopy.label,
      hint: decision.directMergeAvailable ? null : blockedCopy.hint,
      confirmMessage: `This will merge #${pr.number} into its base branch.`,
      showAutoMerge: decision.autoMergeAction !== null
    }
  }
  const {
    scope,
    blocker,
    usesMergeQueue,
    directMergeAvailable: enabled
  } = resolveGitHubPRStackMergeDecision({
    stack: pr.stack,
    reviewMergeQueueRequired: pr.mergeQueueRequired,
    stackMergeQueueRequired: undefined,
    directMergeAvailable: decision.directMergeAvailable
  })
  const stackLabel = `${usesMergeQueue ? 'Queue' : 'Merge'} through #${pr.number} · ${scope.count} ${scope.count === 1 ? 'PR' : 'PRs'}`
  const stackScope = usesMergeQueue
    ? 'GitHub will add this pull request and every pull request below it to the merge queue.'
    : 'GitHub will merge this pull request and every pull request below it in the stack.'
  return {
    enabled,
    label: stackLabel,
    hint: blocker
      ? `#${blocker.prNumber} ${STACK_BLOCKER_COPY[blocker.reason]}`
      : enabled
        ? null
        : stackScope,
    confirmMessage: stackScope,
    showAutoMerge: false
  }
}

/**
 * Whether this merge is reachable only by waiving branch protection.
 *
 * Mirrors the shared `isGitHubPRAdminBypassAvailable` rule (github/pull-request-admin-bypass.ts),
 * which desktop and the host use; Metro/Expo cannot reliably transform runtime imports from the root
 * `src/shared` tree, so the rule is restated here the way the auto-merge availability module is.
 * `reviewDecision` alone is not consulted: it reports that a review is required, not whether the
 * requirement gates the person asking, so `viewerCanMergeAsAdmin` is what turns an unmet review gate
 * into an offerable merge. The rest keeps the bypass no wider than the user agreed to: no
 * conflicting, draft, or merge-queue pull request, an unknown queue fails closed, and GitHub's own
 * merge verdict must already be open so a bypass can never waive failing required checks.
 */
export function resolveMobileAdminMergeBypassRequired(
  pr: Pick<
    PRInfo,
    | 'state'
    | 'mergeable'
    | 'mergeStateStatus'
    | 'reviewDecision'
    | 'viewerCanMergeAsAdmin'
    | 'mergeQueueRequired'
  >
): boolean {
  const mergeStateStatus = (pr.mergeStateStatus ?? '').toLowerCase()
  return (
    pr.viewerCanMergeAsAdmin === true &&
    pr.state === 'open' &&
    pr.mergeQueueRequired === false &&
    pr.mergeable !== 'CONFLICTING' &&
    mergeStateStatus !== 'dirty' &&
    MOBILE_OPEN_MERGE_BOX_STATES.has(mergeStateStatus) &&
    (pr.reviewDecision === 'REVIEW_REQUIRED' || pr.reviewDecision === 'CHANGES_REQUESTED')
  )
}
