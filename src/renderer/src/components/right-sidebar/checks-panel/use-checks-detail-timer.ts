import { useEffect, useRef, type RefObject } from 'react'
import { REVIEW_REFRESH_COOLDOWN_MS } from '../../../../../shared/review-refresh-policy'
import { derivePRCheckStatus } from '../../../../../shared/pr-check-status'
import { installWindowVisibilityTimeoutPoller } from '@/lib/window-visibility-timeout-poller'
import {
  rollupReportsUnseenRun,
  type ChecksDetailPollingPolicy
} from './checks-detail-polling-policy'
import type { ChecksPanelPollingInput, ChecksPanelPollingState } from './use-checks-panel-polling'

export function useChecksDetailTimer({
  model,
  modelRef,
  policyRef,
  requestIdentity,
  fetchChecks,
  fetchGitLabDetails
}: {
  model: ChecksPanelPollingInput
  modelRef: RefObject<ChecksPanelPollingInput>
  policyRef: RefObject<ChecksDetailPollingPolicy>
  requestIdentity: string
  fetchChecks: ChecksPanelPollingState['fetchChecks']
  fetchGitLabDetails: ChecksPanelPollingState['fetchGitLabDetails']
}): void {
  const {
    activeGitLabReview,
    checks,
    pr,
    prNumber,
    isPanelVisible,
    setChecks,
    setComments,
    pollIntervalRef,
    prevChecksRef,
    repo
  } = model
  const refreshRef = useRef<(() => void) | null>(null)
  const forceNextFetchRef = useRef(false)
  const isGitLabReview = activeGitLabReview !== null
  const lastIdentityRef = useRef<string | null>(null)
  const lastReviewRef = useRef<{ key: string; headSha: string | null } | null>(null)
  const lastAttemptAtRef = useRef(-Infinity)
  const nextAttemptAtRef = useRef(-Infinity)
  const hasAttemptedRef = useRef(false)
  const inFlightRef = useRef<{ identity: string; token: symbol } | null>(null)
  const reviewKey = [
    repo?.id ?? repo?.path ?? '',
    isGitLabReview ? 'gitlab' : 'github',
    isGitLabReview ? activeGitLabReview.number : prNumber
  ].join(':')
  const reviewHeadSha = activeGitLabReview?.headSha ?? pr?.headSha ?? null
  // The first read after the panel opens (or its review changes) is the user looking; later polls are background (E9).
  const wakeNextReadRef = useRef(true)
  useEffect(() => {
    if (lastIdentityRef.current !== requestIdentity) {
      const previousReview = lastReviewRef.current
      lastReviewRef.current = { key: reviewKey, headSha: reviewHeadSha }
      lastIdentityRef.current = requestIdentity
      lastAttemptAtRef.current = -Infinity
      nextAttemptAtRef.current = -Infinity
      hasAttemptedRef.current = false
      // Why: the provider read is cached per review, not per head, so a push's first read can come
      // back with the run that preceded it. Force it and a new head never inherits the old rows.
      forceNextFetchRef.current =
        previousReview?.key === reviewKey && previousReview.headSha !== reviewHeadSha
      wakeNextReadRef.current = true
      policyRef.current.reset()
      pollIntervalRef.current = 60_000
      prevChecksRef.current = ''
      setChecks([])
      setComments([])
    }
    if (!isPanelVisible || (!isGitLabReview && !prNumber)) {
      wakeNextReadRef.current = true
      return
    }
    // The one rule the scheduler and the attempt guard both read. Returning it from one place is what
    // keeps a skipped attempt from being re-armed at 0ms forever.
    const nextAttemptDelayMs = (): number | null => {
      if (inFlightRef.current?.identity === requestIdentity) {
        // Why: an attempt is already running; answering the cadence here re-arms the poller against
        // a request it cannot start (Infinity clamps to 0ms). The finally block reschedules.
        return null
      }
      const current = modelRef.current
      const policyDelay = policyRef.current.delayMs(
        current.activeGitLabReview?.state ?? current.pr?.state,
        current.activeGitLabReview?.status ?? current.pr?.checksStatus,
        current.pollIntervalRef.current
      )
      // Why: a failing panel is not forced past its backoff, or a broken endpoint gets retried every
      // cooldown; `reset()` on a pending flip clears the flag so the next attempt is a real one.
      const forcePending = forceNextFetchRef.current && !policyRef.current.failed
      // Why: nothing has been read for this identity yet, so the first attempt is due regardless of
      // what the rollup claims — a settled rollup can still hide an unfinished run in the rows.
      if (policyDelay === null && hasAttemptedRef.current && !forcePending) {
        return null
      }
      // Why: Infinity means the last read settled the review. If the policy asks for more reads again,
      // count from the last attempt (a target anchored in the past never slides); recomputing from
      // `now` would push the attempt out on every call, and Infinity itself is clamped to 0ms.
      const scheduled =
        nextAttemptAtRef.current === Infinity
          ? policyDelay === null
            ? Infinity
            : lastAttemptAtRef.current + policyDelay
          : nextAttemptAtRef.current
      const dueAt = forcePending
        ? Math.min(scheduled, lastAttemptAtRef.current + REVIEW_REFRESH_COOLDOWN_MS)
        : scheduled
      return Math.max(0, dueAt - Date.now())
    }
    const cleanup = installWindowVisibilityTimeoutPoller({
      run: async () => {
        if (inFlightRef.current?.identity === requestIdentity) {
          return
        }
        const waitMs = nextAttemptDelayMs()
        if (waitMs === null || waitMs > 0) {
          return
        }
        const token = Symbol()
        const shown = wakeNextReadRef.current
        wakeNextReadRef.current = false
        const force = forceNextFetchRef.current
        inFlightRef.current = { identity: requestIdentity, token }
        hasAttemptedRef.current = true
        lastAttemptAtRef.current = Date.now()
        nextAttemptAtRef.current = Infinity
        forceNextFetchRef.current = false
        // Why: a scheduled poll must not flash the panel's loading state — it is a refresh of rows
        // that are already on screen, not a load.
        const background = prevChecksRef.current !== ''
        try {
          // Why two flags on the GitLab path: `background` is the host's WSL refusal (upstream E9 —
          // a wake is a foreground read), while `suppressLoading` is the fork's "rows already shown".
          await (isGitLabReview
            ? fetchGitLabDetails({ background: !shown, suppressLoading: background })
            : fetchChecks({ force, background, ...(shown ? { wakeWslDistro: true } : {}) }))
        } finally {
          if (inFlightRef.current?.token === token) {
            inFlightRef.current = null
            if (lastIdentityRef.current === requestIdentity) {
              const delay = policyRef.current.delayMs(
                modelRef.current.activeGitLabReview?.state ?? modelRef.current.pr?.state,
                modelRef.current.activeGitLabReview?.status ?? modelRef.current.pr?.checksStatus,
                modelRef.current.pollIntervalRef.current
              )
              nextAttemptAtRef.current = delay === null ? Infinity : Date.now() + delay
              refreshRef.current?.()
            }
          }
        }
      },
      getDelayMs: nextAttemptDelayMs
    })
    refreshRef.current = cleanup.refresh
    return () => {
      refreshRef.current = null
      cleanup()
    }
  }, [
    requestIdentity,
    reviewKey,
    reviewHeadSha,
    modelRef,
    policyRef,
    fetchChecks,
    fetchGitLabDetails,
    isPanelVisible,
    isGitLabReview,
    prNumber,
    pollIntervalRef,
    prevChecksRef,
    setChecks,
    setComments
  ])

  const aggregatePending = (activeGitLabReview?.status ?? pr?.checksStatus) === 'pending'
  const reviewState = activeGitLabReview?.state ?? pr?.state
  const previousPendingRef = useRef(aggregatePending)
  useEffect(() => {
    if (previousPendingRef.current !== aggregatePending) {
      previousPendingRef.current = aggregatePending
      forceNextFetchRef.current = true
      if (aggregatePending) {
        policyRef.current.reset()
      }
      refreshRef.current?.()
    }
  }, [aggregatePending, reviewState, policyRef])

  // Why: the icon reads the PR's rollup and this panel reads its own rows, so the loop has to react
  // when the rollup reports a run the panel cannot see. The other direction resolves itself: the
  // fetch writes its verdict into the PR and hosted-review caches, which is what the icon and the
  // sidebar card read. GitLab has no such write-back, so it is left to the status flip above.
  const displayedStatus = checks.length > 0 ? derivePRCheckStatus(checks) : null
  const unseenRollupRun = rollupReportsUnseenRun(
    displayedStatus,
    isGitLabReview ? null : (pr?.checksStatus ?? null)
  )
  useEffect(() => {
    if (!unseenRollupRun) {
      return
    }
    forceNextFetchRef.current = true
    refreshRef.current?.()
  }, [unseenRollupRun])
}
