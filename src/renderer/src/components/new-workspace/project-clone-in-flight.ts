import type { ExecutionHostId } from '../../../../shared/execution-host'

/**
 * The project clones this app has running, so a second host pick joins the clone instead of
 * starting another one.
 *
 * A `repo.clone` has no abort and a ten-minute ceiling, so a duplicate is expensive on both
 * machines: the second one would collide on the destination folder, or land a second checkout of
 * the same repository. Keyed by project and host because that pair is what the clone creates.
 */
const inFlight = new Set<string>()

export function getProjectCloneKey(projectId: string, hostId: ExecutionHostId): string {
  return `${projectId}|${hostId}`
}

export function isProjectCloneInFlight(key: string): boolean {
  return inFlight.has(key)
}

/** Registers a clone for the lifetime of its promise; a second caller's work never starts. */
export function trackProjectClone(key: string, run: () => Promise<void>): void {
  if (inFlight.has(key)) {
    return
  }
  inFlight.add(key)
  const release = (): void => {
    inFlight.delete(key)
  }
  // Two-arg then, not finally: a derived rejected promise here would go unhandled.
  void run().then(release, release)
}

export function resetProjectCloneInFlightForTests(): void {
  inFlight.clear()
}
