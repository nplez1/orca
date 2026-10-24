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

/**
 * Kill a child at its deadline unless the exit it was waiting for has already arrived.
 *
 * Why the extra turn (#155): timers run before I/O callbacks in the same loop turn, so after a
 * block the overdue deadline fires before Node handles the exit of a child that already finished —
 * killing there reports a millisecond-long command as a timeout, and one block becomes a burst of
 * them. `setImmediate` lands after that poll phase, so a child that ended during the block settles
 * with its real result; one still running was genuinely at its deadline.
 *
 * Why also a drain window after a late deadline: the block that delayed this timer also delays the
 * close of the child's pipes, which arrives over more than one poll phase. A deadline that fired on
 * time leaves no such backlog, so only the late case waits.
 */
export function scheduleDeadlineKill(params: {
  deadlineMs: number
  isSettled: () => boolean
  kill: (overrunMs: number) => void
}): { cancel: () => void } {
  const { deadlineMs, isSettled, kill } = params
  const deadlineAt = performance.now()
  let drain: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    setImmediate(() => {
      if (isSettled()) {
        return
      }
      const overrunMs = performance.now() - deadlineAt - deadlineMs
      if (overrunMs < BLOCKED_DEADLINE_OVERRUN_MS) {
        kill(overrunMs)
        return
      }
      drain = setTimeout(() => {
        if (!isSettled()) {
          kill(overrunMs)
        }
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
