/**
 * One lifecycle operation in flight per ephemeral runtime.
 *
 * Why this exists: extending a lease and reclaiming a lapsed host both read a runtime record, decide
 * from it, and then await work that can take a minute. Without a lock they interleave, and the sweep
 * decides from a record it read before the user extended the lease — so a host that was just paid for
 * gets its records released underneath them.
 *
 * Why destroy is not covered here: teardown already has its own single-flight and its own stop control
 * (`ephemeral-vm-runtime-cleanup-control.ts`), and the reclaim sweep no longer destroys anything, so
 * the two never meet. If a future change makes the sweep tear a host down, it has to take this lock.
 *
 * A caller that finds the runtime busy queues behind the holder and then runs, because the holder may
 * have changed the record the decision was going to be made from. Every caller re-reads inside the
 * lock for the same reason.
 *
 * Why there is also a non-waiting form: the sweep walks every runtime on a timer, so a sweep that
 * queues behind one holder stops reclaiming every other runtime for as long as that holder runs.
 */
const inFlightByRuntimeId = new Map<string, Promise<unknown>>()

function release(runtimeId: string, promise: Promise<unknown>): void {
  if (inFlightByRuntimeId.get(runtimeId) === promise) {
    inFlightByRuntimeId.delete(runtimeId)
  }
}

export function withEphemeralVmRuntimeLock<T>(
  runtimeId: string,
  run: () => Promise<T>
): Promise<T> {
  const holder = inFlightByRuntimeId.get(runtimeId)
  if (holder) {
    return holder.then(
      () => withEphemeralVmRuntimeLock(runtimeId, run),
      () => withEphemeralVmRuntimeLock(runtimeId, run)
    )
  }
  const promise = run()
  inFlightByRuntimeId.set(runtimeId, promise)
  // Why both handlers: a rejected holder must still release the lock, and `then` here keeps the
  // bookkeeping promise fulfilled so it can never surface as an unhandled rejection.
  promise.then(
    () => release(runtimeId, promise),
    () => release(runtimeId, promise)
  )
  return promise
}

/**
 * Acquire the lock only if it is free, reporting that it was busy instead of queueing behind the
 * holder.
 *
 * Why the sweep needs this: a holder may be an extend hook waiting on a network that never answers,
 * and a sweep that waits for it leaves `sweeping` set with no runtime reclaimed until the app restarts.
 * The skip costs one sweep interval, and the next pass sees the record the holder left behind.
 */
export function tryWithEphemeralVmRuntimeLock<T>(
  runtimeId: string,
  run: () => Promise<T>
): { ran: false } | { ran: true; promise: Promise<T> } {
  // Check and set in one synchronous step, so two callers cannot both read the lock as free.
  if (inFlightByRuntimeId.has(runtimeId)) {
    return { ran: false }
  }
  const promise = run()
  inFlightByRuntimeId.set(runtimeId, promise)
  promise.then(
    () => release(runtimeId, promise),
    () => release(runtimeId, promise)
  )
  return { ran: true, promise }
}

/** Test seam: a leaked lock between cases would make the next case queue behind a dead promise. */
export function resetEphemeralVmRuntimeLocks(): void {
  inFlightByRuntimeId.clear()
}
