/**
 * How late a deadline timer may fire before the lateness means the loop was blocked (#155).
 *
 * Why a copy of `STALLED_DEADLINE_OVERRUN_MS` in the git command runner's `stalled-deadline-kill`
 * and not one shared constant: several suites mock this package, and a new export they do not
 * provide fails the whole suite.
 */
export const BLOCKED_DEADLINE_OVERRUN_MS = 100

/** Bounded window a blocked deadline gives the exit it was waiting for before killing. */
export const BLOCKED_DEADLINE_DRAIN_MS = 250

/** Result fields for a deadline kill: the lateness only when a block delayed it. */
export function deadlineOverrunField(overrunMs: number | null): { deadlineOverrunMs?: number } {
  return overrunMs !== null && overrunMs >= BLOCKED_DEADLINE_OVERRUN_MS
    ? { deadlineOverrunMs: Math.round(overrunMs) }
    : {}
}

/**
 * Kill a child at its deadline unless the exit it was waiting for has already arrived.
 *
 * Why a turn first when the deadline fired late (#155): timers run before I/O callbacks in the same
 * loop turn, so after a block the overdue deadline fires before Node handles the exit of a child
 * that already finished — killing there reports a millisecond-long command as a timeout, and one
 * block becomes a burst of them. A 0 ms timer fires in the next iteration's timers phase, i.e.
 * after this iteration has polled I/O, so the exit the block hid has been delivered by then.
 *
 * Why that turn is skipped otherwise: `overrunMs` says only how late this timer fired, not how long
 * the loop was blocked before it, so a long block that ends just after the deadline still reads as
 * on time. That residual — any block ending within the block threshold of the deadline — is taken
 * deliberately: it is where this path already sat, and a turn for it would move every caller's own
 * deadlines by a millisecond.
 *
 * Why a drain window instead of a kill once the child has exited: a grandchild can hold a pipe
 * open, so an exited child is still bounded, just not killed on the spot.
 */
export function scheduleDeadlineKill(params: {
  deadlineMs: number
  isSettled: () => boolean
  hasExited: () => boolean
  kill: (overrunMs: number) => void
  /** Injected so a test can make the deadline late without stalling the thread. */
  now?: () => number
}): { cancel: () => void } {
  const { deadlineMs, isSettled, hasExited, kill, now = () => performance.now() } = params
  const deadlineAt = now()
  let decide: ReturnType<typeof setTimeout> | undefined
  let drain: ReturnType<typeof setTimeout> | undefined
  const killAfterDrain = (overrunMs: number): void => {
    drain = setTimeout(() => {
      // Why one more turn: a second block can land inside the drain, and its timers phase would
      // again run before the poll that delivers the child's `close`.
      decide = setTimeout(() => {
        if (!isSettled()) {
          kill(overrunMs)
        }
      }, 0)
      decide.unref?.()
    }, BLOCKED_DEADLINE_DRAIN_MS)
    drain.unref?.()
  }
  const timer = setTimeout(() => {
    const overrunMs = now() - deadlineAt - deadlineMs
    if (overrunMs < BLOCKED_DEADLINE_OVERRUN_MS && !hasExited()) {
      kill(overrunMs)
      return
    }
    decide = setTimeout(() => {
      if (isSettled()) {
        return
      }
      killAfterDrain(overrunMs)
    }, 0)
    decide.unref?.()
  }, deadlineMs)
  timer.unref?.()
  return {
    cancel: () => {
      clearTimeout(timer)
      clearTimeout(decide)
      clearTimeout(drain)
    }
  }
}
