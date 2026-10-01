import type {
  GitHubPRMergeMethod,
  PRInfo,
  PRState
} from '../../../../src/shared/github/pull-request-types'

// Which actions the PR actions section may offer for a given PR state. Merged PRs
// expose only unlink (+ open-on-host elsewhere); closed PRs add reopen; open/draft
// keep the full set. Mirrors desktop, which hides merge/auto-merge once a PR is no
// longer open. Pure + unit-tested.
export type PrActionAvailability = {
  canMerge: boolean
  canAutoMerge: boolean
  canClose: boolean
  canReopen: boolean
  canUnlink: boolean
}

export function resolvePrActionAvailability(state: PRState): PrActionAvailability {
  const isOpen = state === 'open' || state === 'draft'
  return {
    canMerge: isOpen,
    canAutoMerge: isOpen,
    canClose: isOpen,
    canReopen: state === 'closed',
    canUnlink: true
  }
}

type MergeMethodSettings = {
  defaultMethod?: GitHubPRMergeMethod
  allowedMethods?: Record<GitHubPRMergeMethod, boolean>
}

const MOBILE_PR_MERGE_METHOD_FALLBACK_ORDER: GitHubPRMergeMethod[] = ['merge', 'squash', 'rebase']

/** GitHub merge states where the merge box is open for the viewer asking about it. */
const MOBILE_OPEN_MERGE_BOX_STATES = new Set(['clean', 'unstable', 'has_hooks'])

export function resolveMobilePrMergeMethod(
  settings: MergeMethodSettings | null | undefined
): GitHubPRMergeMethod {
  const preferredMethod = settings?.defaultMethod ?? 'squash'
  const allowed = settings?.allowedMethods

  if (!allowed || allowed[preferredMethod]) {
    return preferredMethod
  }

  return MOBILE_PR_MERGE_METHOD_FALLBACK_ORDER.find((method) => allowed[method]) ?? preferredMethod
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
