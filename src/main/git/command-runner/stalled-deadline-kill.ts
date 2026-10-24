import type { ActiveSpan } from '../../observability/tracer'

/**
 * Why: a `setTimeout` cannot fire early, so however late it fires is a measured
 * main-thread stall. Below this the lateness is ordinary timer jitter.
 */
export const STALLED_DEADLINE_OVERRUN_MS = 100

/**
 * Why bounded: a stall hides the child's exit *and* whatever output was queued
 * behind it, and that drain has to reach the resumed loop before the deadline
 * may reclaim the child. A child that drains within the window settles and is
 * left alone; one still unsettled when it ends — including one the stall itself
 * parked on a full pipe — is killed and reported as timed out.
 */
export const HIDDEN_EXIT_DRAIN_GRACE_MS = 250

export function isStalledDeadlineOverrun(overrunMs: number): boolean {
  return overrunMs >= STALLED_DEADLINE_OVERRUN_MS
}

/** Trace metadata for a deadline killed over a stalled loop; empty when it fired on time. */
export function deadlineOverrunMetadata(overrunMs: number): { deadlineOverrunMs?: number } {
  return isStalledDeadlineOverrun(overrunMs) ? { deadlineOverrunMs: Math.round(overrunMs) } : {}
}

export function deadlineOverrunOf(error: unknown): number | null {
  if (!isRecord(error)) {
    return null
  }
  const value = error.deadlineOverrunMs
  return typeof value === 'number' ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Why on the span: the trace is where a stall-induced timeout has to be distinguishable from a hung git. */
export function recordDeadlineOverrunOnSpan(span: ActiveSpan | undefined, error: unknown): void {
  const overrunMs = deadlineOverrunOf(error)
  if (overrunMs !== null) {
    span?.setAttribute('git.deadline_overrun_ms', overrunMs)
  }
}

/**
 * Kill a child at its deadline unless the timer itself fired late.
 *
 * Why (#155): timers run before I/O callbacks in the same loop turn, so after a
 * stall the overdue deadline timer fires before Node handles the exit of a child
 * that already finished. Killing there reports a millisecond-long `git remote`
 * as a 30s timeout, and one stall becomes a burst of them. A late deadline is
 * therefore proof the deadline was not honored in real time, so the child gets a
 * bounded drain window first; one still running after it has genuinely overrun.
 */
export function terminateAtStalledDeadline(params: {
  overrunMs: number
  isSettled: () => boolean
  terminate: () => void
}): void {
  const { overrunMs, isSettled, terminate } = params
  if (!isStalledDeadlineOverrun(overrunMs)) {
    terminate()
    return
  }
  const drain = setTimeout(() => {
    if (!isSettled()) {
      terminate()
    }
  }, HIDDEN_EXIT_DRAIN_GRACE_MS)
  drain.unref?.()
}
