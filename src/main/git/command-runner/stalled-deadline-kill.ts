import type { ActiveSpan } from '../../observability/tracer'
import { BLOCKED_DEADLINE_DRAIN_MS, BLOCKED_DEADLINE_OVERRUN_MS } from '@orca/process-host'

/**
 * Why: a `setTimeout` cannot fire ahead of the loop clock it was scheduled on, so lateness is what
 * the timer measured; a negative value is that clock's millisecond rounding, not an honored
 * deadline. Below this the lateness is ordinary timer jitter rather than a block.
 */
export const STALLED_DEADLINE_OVERRUN_MS = BLOCKED_DEADLINE_OVERRUN_MS

/**
 * Why bounded: a stall hides the child's exit *and* whatever output was queued
 * behind it, and that drain has to reach the resumed loop before the deadline
 * may reclaim the child. A child that drains within the window settles and is
 * left alone; one still unsettled when it ends — including one the stall itself
 * parked on a full pipe — is killed and reported as timed out.
 */
export const HIDDEN_EXIT_DRAIN_GRACE_MS = BLOCKED_DEADLINE_DRAIN_MS

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

/** Why on the span: the trace is where a timeout whose deadline fired late has to be distinguishable from a hung git. */
export function recordDeadlineOverrunOnSpan(span: ActiveSpan | undefined, error: unknown): void {
  const overrunMs = deadlineOverrunOf(error)
  if (overrunMs !== null) {
    span?.setAttribute('git.deadline_overrun_ms', overrunMs)
  }
}

/**
 * Kill a child at its deadline unless the exit it was waiting for has already arrived.
 *
 * Why (#155): timers run before I/O callbacks in the same loop turn, so after a
 * stall the overdue deadline timer fires before Node handles the exit of a child
 * that already finished. Killing there reports a millisecond-long `git remote`
 * as a 30s timeout, and one stall becomes a burst of them. The decision is
 * therefore taken one turn later, after the poll phase; `hasExited` answers it
 * rather than `isSettled`, because `close` — what settles the capture — waits on
 * the stdio pipes and arrives a phase after the immediate. An exited child still
 * gets the bounded drain window, since a grandchild can hold a pipe open.
 */
export function terminateAtStalledDeadline(params: {
  overrunMs: number
  isSettled: () => boolean
  hasExited: () => boolean
  terminate: () => void
}): void {
  const { overrunMs, isSettled, hasExited, terminate } = params
  setImmediate(() => {
    if (isSettled()) {
      return
    }
    if (!isStalledDeadlineOverrun(overrunMs) && !hasExited()) {
      terminate()
      return
    }
    const drain = setTimeout(() => {
      // Why the same turn again: a second stall can land inside the drain, and the timers phase
      // still runs before the poll that would deliver the child's `close`.
      setImmediate(() => {
        if (!isSettled()) {
          terminate()
        }
      })
    }, HIDDEN_EXIT_DRAIN_GRACE_MS)
    drain.unref?.()
  }).unref?.()
}
