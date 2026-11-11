import type { ExecutionHostId } from '../../../../shared/execution-host'

/** What a clone onto a host came to, in terms every surface that asked can report. */
export type ProjectCloneOutcome =
  | { kind: 'provisioned'; setupId: string }
  | {
      kind: 'folder-taken'
      folderName: string
      /** The taken folder as a host path, for adopting it instead. */
      path: string
      suggestion: string
      /** A non-empty folder may already be this project, so adopting it is a real answer. */
      canUseExistingFolder: boolean
    }
  | { kind: 'failed'; message: string }

/**
 * The project clones this app has running, so a second host pick joins the clone instead of
 * starting another one.
 *
 * A `repo.clone` has no abort and a ten-minute ceiling, so a duplicate is expensive on both
 * machines: the second one would collide on the destination folder, or land a second checkout of
 * the same repository. The promise is kept, not just a lock, so a composer that joined after a
 * remount still learns how the clone it joined turned out.
 */
const inFlight = new Map<string, Promise<ProjectCloneOutcome>>()

export function getProjectCloneKey(projectId: string, hostId: ExecutionHostId): string {
  return `${projectId}|${hostId}`
}

export function isProjectCloneInFlight(key: string): boolean {
  return inFlight.has(key)
}

/** Runs the clone, or returns the one already running for this key. */
export function trackProjectClone(
  key: string,
  run: () => Promise<ProjectCloneOutcome>
): Promise<ProjectCloneOutcome> {
  const existing = inFlight.get(key)
  if (existing) {
    return existing
  }
  const promise = run()
  inFlight.set(key, promise)
  const release = (): void => {
    if (inFlight.get(key) === promise) {
      inFlight.delete(key)
    }
  }
  // Two-arg then, not finally: a derived rejected promise here would go unhandled.
  void promise.then(release, release)
  return promise
}

export function resetProjectCloneInFlightForTests(): void {
  inFlight.clear()
}
