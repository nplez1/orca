import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { CheckStatus } from '../../../../../shared/github/pull-request-types'
import type { HostedReviewState } from '../../../../../shared/hosted-review'
import {
  FOCUSED_CHECKS_REFRESH_INTERVAL_MS,
  reviewRefreshIntervalMs
} from '../../../../../shared/review-refresh-policy'
import { summarizeProviderChecks } from '../../../../../shared/provider-check-summary'

/** Ceiling for the focused loop while a run's rows repeat read after read. */
const STUCK_RUN_BACKOFF_MAX_MS = 30_000

export function detailedChecksStatus(checks: readonly PRCheckDetail[]): CheckStatus | undefined {
  if (checks.length === 0) {
    return undefined
  }
  if (
    checks.some(
      (check) =>
        check.status !== 'completed' ||
        check.conclusion === 'pending' ||
        check.conclusion === 'action_required' ||
        check.conclusion === null
    )
  ) {
    return 'pending'
  }
  if (
    checks.some((check) => ['failure', 'cancelled', 'timed_out'].includes(check.conclusion ?? ''))
  ) {
    return 'failure'
  }
  return checks.some((check) => check.conclusion === 'success') ? 'success' : 'neutral'
}

/**
 * Whether the review's rollup reports something the panel's rows cannot be showing.
 *
 * Only one direction counts: a rollup that says pending or failure while the rows say otherwise is
 * news the panel has to go read. Rows can hold more than the rollup does (checks it dropped or has
 * not seen yet), and a refetch cannot improve on those.
 */
export function rollupReportsUnseenRun(
  displayed: CheckStatus | null,
  rollup: CheckStatus | null
): boolean {
  return (
    displayed !== null && (rollup === 'pending' || rollup === 'failure') && displayed !== rollup
  )
}

export class ChecksDetailPollingPolicy {
  private status: CheckStatus | undefined
  private liveRun: boolean | undefined
  private hasDetails = false
  private failing = false
  private unchangedReads = 0
  private signature = ''

  /** Whether the last read failed — a force may not shorten that backoff. */
  get failed(): boolean {
    return this.failing
  }

  reset(): void {
    this.status = undefined
    this.liveRun = undefined
    this.hasDetails = false
    this.failing = false
    this.unchangedReads = 0
    this.signature = ''
  }

  accept(checks: readonly PRCheckDetail[]): string {
    this.status = detailedChecksStatus(checks)
    // Why: "unfinished" for the focused loop is the shared classifier's pending count, not the
    // status above — an approval-pending suite is `pending` there and must not keep a 10s loop.
    this.liveRun = checks.length > 0 ? summarizeProviderChecks(checks).pending > 0 : undefined
    this.hasDetails = true
    this.failing = false
    const signature = JSON.stringify(
      checks.map((check) => `${check.name}:${check.status}:${check.conclusion}`)
    )
    this.unchangedReads = signature === this.signature ? this.unchangedReads + 1 : 0
    this.signature = signature
    return signature
  }

  fail(): void {
    this.failing = true
  }

  delayMs(
    state: HostedReviewState | undefined,
    aggregateStatus: CheckStatus | undefined,
    backoffMs: number
  ): number | null {
    if (this.failing) {
      return Math.max(state === 'closed' ? 900_000 : 60_000, backoffMs)
    }
    const liveRun = this.liveRun ?? aggregateStatus === 'pending'
    if (liveRun && state !== 'merged' && state !== 'closed') {
      // Why: a row carries only status and conclusion, so a job that outlives ~30s reads identically
      // however healthy it is (as does an offline runner). Easing off on unchanged rows keeps a long
      // run from polling uncached every 10s, and the first row that moves restores the 10s loop.
      return Math.min(
        FOCUSED_CHECKS_REFRESH_INTERVAL_MS * 2 ** Math.min(this.unchangedReads, 2),
        STUCK_RUN_BACKOFF_MAX_MS
      )
    }
    const status = this.hasDetails && this.status !== undefined ? this.status : aggregateStatus
    const interval = reviewRefreshIntervalMs({
      state,
      checksStatus: status,
      hasReview: true,
      selected: true
    })
    if (interval === null) {
      return null
    }
    return state === 'closed' ? interval : Math.max(interval, backoffMs)
  }
}
