/**
 * One writer at a time over `host-mesh.json`.
 *
 * Why this exists: every mutating path reads the store, awaits the network, and writes back. Before the mesh ran
 * a pass on its own, those windows were short and rare; now a pass runs every minute and can last several seconds
 * per member, so an Eject, an inbound `offerBack` or an incoming `remove` landing mid-pass would be overwritten by
 * the pass's own later write — a member reappearing without its tombstone, or an adopted group dropped.
 *
 * Why a promise chain and not a flag: queued work must still run in the order it arrived, and a task that throws
 * must not poison the chain. Callers get their own result and their own rejection back.
 *
 * Why the lock covers the network waits too: a narrower lock around only the write would let two paths read the
 * same state and each apply a mutation derived from it, which is the lost update this exists to prevent. The cost
 * is that an inbound call may wait behind a running pass and time out at the caller, which retries; the cost of
 * the alternative is silently losing a removal.
 */
export type HostMeshWriteLock = <T>(task: () => Promise<T>) => Promise<T>

export function createHostMeshWriteLock(): HostMeshWriteLock {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    // Why the chain is reset to a settled value: one failed task must not reject every task queued behind it.
    tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}
