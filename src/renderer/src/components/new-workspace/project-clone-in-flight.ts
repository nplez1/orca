import type { ExecutionHostId } from '../../../../shared/execution-host'

/** What a clone onto a host came to, in terms every surface that asked can report. */
export type ProjectCloneOutcome =
  | { kind: 'provisioned'; setupId: string }
  /** The user moved to another host while this one was still resolving; nothing was cloned. */
  | { kind: 'abandoned' }
  | {
      kind: 'folder-taken'
      folderName: string
      /** The taken folder as a host path, for adopting it instead. */
      path: string
      suggestion: string
      /** A non-empty folder may already be this project, so adopting it is a real answer. */
      canUseExistingFolder: boolean
    }
  | {
      kind: 'failed'
      message: string
      /** The store toasted this one already, so an outcome nobody showed must not toast it again. */
      alreadyToasted?: true
    }

/** True when a live surface showed the outcome, so nothing else needs to report it. */
export type ProjectCloneWatcher = (outcome: ProjectCloneOutcome) => boolean

type ProjectCloneEntry = {
  promise: Promise<ProjectCloneOutcome>
  watchers: ProjectCloneWatcher[]
  /** How to report an outcome no watcher could show, e.g. because every composer closed. */
  reportUnseen: (outcome: ProjectCloneOutcome) => void
}

/**
 * The project clones this app has running, so a second host pick joins the clone instead of
 * starting another one.
 *
 * A `repo.clone` has no abort and a ten-minute ceiling, so a duplicate is expensive on both
 * machines: the second one would collide on the destination folder, or land a second checkout of
 * the same repository. The promise is kept, not just a lock, so a composer that joined after a
 * remount still learns how the clone it joined turned out.
 *
 * Delivery lives here because "did anything show this outcome?" is a question about every surface
 * that asked at once: a composer that closed still has a watcher, and it answers no.
 */
const inFlight = new Map<string, ProjectCloneEntry>()

export function getProjectCloneKey(projectId: string, hostId: ExecutionHostId): string {
  return `${projectId}|${hostId}`
}

export function isProjectCloneInFlight(key: string): boolean {
  return inFlight.has(key)
}

/** Runs the clone, or joins the one already running for this key. */
export function trackProjectClone(
  key: string,
  run: () => Promise<ProjectCloneOutcome>,
  {
    watch,
    reportUnseen
  }: {
    watch: ProjectCloneWatcher
    reportUnseen: (outcome: ProjectCloneOutcome) => void
  }
): Promise<ProjectCloneOutcome> {
  const existing = inFlight.get(key)
  if (existing) {
    existing.watchers.push(watch)
    return existing.promise
  }
  const promise = run()
  const entry: ProjectCloneEntry = { promise, watchers: [watch], reportUnseen }
  inFlight.set(key, entry)
  const release = (): void => {
    if (inFlight.get(key) === entry) {
      inFlight.delete(key)
    }
  }
  const settle = (outcome: ProjectCloneOutcome): void => {
    // Why before the watchers: a composer whose joined clone was abandoned starts its own inside its
    // watcher, and must get a fresh entry rather than join the one that just settled.
    release()
    let shown = false
    for (const watcher of entry.watchers) {
      try {
        // Why not stop at the first true: a surface that could show it must still get the chance.
        if (watcher(outcome)) {
          shown = true
        }
      } catch (error) {
        console.error('Project clone watcher failed:', error)
      }
    }
    if (!shown) {
      entry.reportUnseen(outcome)
    }
  }
  // Two-arg then, not finally: a derived rejected promise here would go unhandled.
  void promise.then(settle, release)
  return promise
}

export function resetProjectCloneInFlightForTests(): void {
  inFlight.clear()
}
