import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  REVIEW_REFRESH_COOLDOWN_MS,
  subscribePRAutoRefreshCadence,
  type PRAutoRefreshCadence
} from '../../../../../../shared/source-control/hosted-review/review-refresh-policy'
import { derivePRCheckStatus } from '../../../../../../shared/source-control/checks/pr-check-status'
import { installWindowVisibilityTimeoutPoller } from '@/lib/window-activity/window-visibility-timeout-poller'
import { getPRRefreshOwnerRuntimeEnvironmentId } from '@/store/github/repositories/repository-routing'
import { hostPRAutoRefreshCadence } from '@/store/github/refresh/remote-host-pr-auto-refresh-cadence'
import {
  rollupReportsUnseenRun,
  type ChecksDetailPollingPolicy
} from '../../../../../../shared/github/checks/checks-detail-polling-policy'
import type { ChecksPanelPollingInput, ChecksPanelPollingState } from './use-checks-panel-polling'
import { runWithFinally } from '@/lib/run-with-finally'

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
    prCacheKey,
    isPanelVisible,
    setChecks,
    setChecksLoading,
    setComments,
    setCommentsLoading,
    pollIntervalRef,
    prevChecksRef,
    repo
  } = model
  const isGitLabReview = activeGitLabReview !== null
  // A new identity always schedules this timer's wake read, which settles what it resets. GitHub
  // comments have their own read (review data), so only a GitLab read owns comments here.
  const [readIdentity, setReadIdentity] = useState(requestIdentity)
  if (readIdentity !== requestIdentity) {
    setReadIdentity(requestIdentity)
    setChecks(null)
    setChecksLoading(false)
    if (isGitLabReview) {
      setComments(undefined)
      setCommentsLoading(false)
    }
  }
  const refreshRef = useRef<(() => void) | null>(null)
  const forceNextFetchRef = useRef(false)
  const lastIdentityRef = useRef<string | null>(null)
  const lastReviewRef = useRef<{ key: string; headSha: string | null } | null>(null)
  const lastAttemptAtRef = useRef(-Infinity)
  const nextAttemptAtRef = useRef(-Infinity)
  const inFlightRef = useRef<{ identity: string; token: symbol; background: boolean } | null>(null)
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
      // Why: the provider read is cached per review, not per head, so a push's first read can come
      // back with the run that preceded it. Force it and a new head never inherits the old rows.
      forceNextFetchRef.current =
        previousReview?.key === reviewKey && previousReview.headSha !== reviewHeadSha
      wakeNextReadRef.current = true
      policyRef.current.reset()
      pollIntervalRef.current = 60_000
      prevChecksRef.current = ''
    }
    if (!isPanelVisible || (!isGitLabReview && !prNumber)) {
      wakeNextReadRef.current = true
      return
    }
    const ownerCadence = (): PRAutoRefreshCadence => {
      const current = modelRef.current
      // The host that reads these checks owns the cadence: a paired host's setting, else this app's.
      return hostPRAutoRefreshCadence(
        getPRRefreshOwnerRuntimeEnvironmentId({
          cacheKey: current.prCacheKey ?? '',
          executionHostId: current.repo?.executionHostId ?? null
        })
      )
    }
    // The one rule the scheduler and the attempt guard both read. Returning it from one place is what
    // keeps a skipped attempt from being re-armed at 0ms forever.
    const policyDelay = (cadence: PRAutoRefreshCadence = ownerCadence()): number | null => {
      const current = modelRef.current
      return policyRef.current.delayMs(
        current.activeGitLabReview?.state ?? current.pr?.state,
        current.activeGitLabReview?.status ?? current.pr?.checksStatus,
        current.pollIntervalRef.current,
        cadence
      )
    }
    // Under a stretched or stopped cadence the window coming back still reads checks older than
    // Default's delay, never sooner: the cadence slows the timer, not the user's return.
    const returnReadDue = (now: number): boolean => {
      // Why: GitHub shows a finish at once, so a return while checks run pulls the poll forward.
      if (!isGitLabReview && policyRef.current.checksRunning()) {
        return true
      }
      const defaultDelay = ownerCadence() === 'default' ? null : policyDelay('default')
      return defaultDelay !== null && now - lastAttemptAtRef.current >= defaultDelay
    }
    const stoppedByCadence = (): boolean =>
      ownerCadence() === 'off' && policyDelay('default') !== null
    // Why: a failing panel is not forced past its backoff, or a broken endpoint gets retried every
    // cooldown; `reset()` on a pending flip clears the flag so the next attempt is a real one.
    const forceWanted = (): boolean => forceNextFetchRef.current && !policyRef.current.failed
    const cleanup = installWindowVisibilityTimeoutPoller({
      run: async ({ trigger }) => {
        if (inFlightRef.current?.identity === requestIdentity) {
          return
        }
        const now = Date.now()
        const nextAttemptAt = nextAttemptAtRef.current
        const forcePending = forceWanted()
        if (
          (!(
            wakeNextReadRef.current ||
            forcePending ||
            (trigger === 'visibility' && returnReadDue(now))
          ) &&
            (Number.isFinite(nextAttemptAt)
              ? now < nextAttemptAt
              : nextAttemptAt === Infinity &&
                !forcePending &&
                (stoppedByCadence() ||
                  now - lastAttemptAtRef.current < REVIEW_REFRESH_COOLDOWN_MS))) ||
          now - lastAttemptAtRef.current < REVIEW_REFRESH_COOLDOWN_MS
        ) {
          return
        }
        const token = Symbol()
        const shown = wakeNextReadRef.current
        const force =
          forcePending ||
          trigger === 'visibility' ||
          (shown && Number.isFinite(lastAttemptAtRef.current))
        wakeNextReadRef.current = false
        lastAttemptAtRef.current = now
        nextAttemptAtRef.current = Infinity
        forceNextFetchRef.current = false
        // Only the timer's own tick is a background read the host may pace; the window coming
        // back, the panel opening and a changed aggregate state must read fresh.
        const background = trigger === 'timer' && !shown && !force
        inFlightRef.current = { identity: requestIdentity, token, background }
        await runWithFinally(
          () =>
            isGitLabReview
              ? // Why two flags on the GitLab path: `background` is the host's WSL refusal (upstream E9 —
                // a wake is a foreground read), while `suppressLoading` is the fork's "rows already shown":
                // it is only ever set true, and the callee's own default covers the rest.
                fetchGitLabDetails({
                  background: !shown,
                  ...(prevChecksRef.current !== '' ? { suppressLoading: true } : {})
                })
              : fetchChecks({
                  force,
                  ...(shown ? { wakeWslDistro: true } : {}),
                  ...(background ? { background: true } : {})
                }),
          () => {
            if (inFlightRef.current?.token === token) {
              inFlightRef.current = null
              if (lastIdentityRef.current === requestIdentity) {
                if (!background && modelRef.current.isPanelVisible) {
                  wakeNextReadRef.current = false
                }
                const delay = policyDelay()
                nextAttemptAtRef.current = delay === null ? Infinity : Date.now() + delay
                refreshRef.current?.()
              }
            }
          }
        )
      },
      getDelayMs: () => {
        const delay = policyDelay()
        if (inFlightRef.current?.identity === requestIdentity) {
          return delay
        }
        if (wakeNextReadRef.current || forceWanted()) {
          return Math.max(0, lastAttemptAtRef.current + REVIEW_REFRESH_COOLDOWN_MS - Date.now())
        }
        if (delay === null) {
          return null
        }
        return Number.isFinite(nextAttemptAtRef.current)
          ? Math.max(0, nextAttemptAtRef.current - Date.now())
          : delay
      },
      // Returning to the window is a promised foreground read in every mode: when only the owning
      // host's cadence (not settled checks) stopped the timer, focus still reads once.
      refreshOnFocusWhileStopped: stoppedByCadence,
      replayVisibilityWhileInFlight: () => {
        const current = inFlightRef.current
        const qualified =
          current?.identity === requestIdentity && current.background && returnReadDue(Date.now())
        if (qualified) {
          forceNextFetchRef.current = true
        }
        return qualified
      }
    })
    refreshRef.current = cleanup.refresh
    // A cadence change (this app's or the owning host's) re-plans a mounted panel at once: a timer
    // stopped under "off" starts again, and one armed for Default is disarmed.
    const unsubscribeCadence = subscribePRAutoRefreshCadence(() => {
      if (inFlightRef.current?.identity === requestIdentity) {
        return
      }
      const delay = policyDelay()
      if (Number.isFinite(lastAttemptAtRef.current)) {
        nextAttemptAtRef.current = delay === null ? Infinity : lastAttemptAtRef.current + delay
      }
      cleanup.replan()
    })
    return () => {
      refreshRef.current = null
      unsubscribeCadence()
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
    prCacheKey,
    pollIntervalRef,
    prevChecksRef
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
      if (nextAttemptAtRef.current === Infinity) {
        nextAttemptAtRef.current = lastAttemptAtRef.current + REVIEW_REFRESH_COOLDOWN_MS
      }
      refreshRef.current?.()
    }
  }, [aggregatePending, reviewState, policyRef])

  // Why: the icon reads the PR's rollup and this panel reads its own rows, so the loop has to react
  // when the rollup reports a run the panel cannot see. The other direction resolves itself: the
  // fetch writes its verdict into the PR and hosted-review caches, which is what the icon and the
  // sidebar card read. GitLab has no such write-back, so it is left to the status flip above.
  const displayedStatus = checks?.length ? derivePRCheckStatus(checks) : null
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
