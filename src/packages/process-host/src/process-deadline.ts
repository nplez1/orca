/**
 * How late a deadline timer may fire before the lateness means the loop was blocked (#155).
 *
 * Why shared: a blocked main thread makes a deadline fire late, and the same block delays the
 * child's exit and the close of its pipes. The git command runner's `stalled-deadline-kill`
 * imports both constants instead of keeping its own copies.
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
 * Why the extra turn (#155): timers run before I/O callbacks in the same loop turn, so after a
 * block the overdue deadline fires before Node handles the exit of a child that already finished —
 * killing there reports a millisecond-long command as a timeout, and one block becomes a burst of
 * them. `setImmediate` lands after that poll phase, so a child that ended during the block has
 * already exited. That is why `hasExited` is the question asked rather than `isSettled`: a child's
 * `close` — what settles the promise — waits for every stdio pipe, and those callbacks run in the
 * close phase, one turn *after* the immediate.
 *
 * Why a drain window instead of a kill once it has exited: a grandchild can hold a pipe open, so an
 * exited child is still bounded, just not killed on the spot. A deadline that fired on time and
 * whose child has not exited kills immediately.
 */
export function scheduleDeadlineKill(params: {
  deadlineMs: number
  isSettled: () => boolean
  hasExited: () => boolean
  kill: (overrunMs: number) => void
}): { cancel: () => void } {
  const { deadlineMs, isSettled, hasExited, kill } = params
  const deadlineAt = performance.now()
  let drain: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    setImmediate(() => {
      if (isSettled()) {
        return
      }
      const overrunMs = performance.now() - deadlineAt - deadlineMs
      if (overrunMs < BLOCKED_DEADLINE_OVERRUN_MS && !hasExited()) {
        kill(overrunMs)
        return
      }
      drain = setTimeout(() => {
        // Why the same turn again: a second block can land inside the drain, and the timers phase
        // still runs before the poll that would deliver the child's `close`.
        setImmediate(() => {
          if (!isSettled()) {
            kill(overrunMs)
          }
        })
      }, BLOCKED_DEADLINE_DRAIN_MS)
      drain.unref?.()
    })
  }, deadlineMs)
  timer.unref?.()
  return {
    cancel: () => {
      clearTimeout(timer)
      clearTimeout(drain)
    }
  }
}
