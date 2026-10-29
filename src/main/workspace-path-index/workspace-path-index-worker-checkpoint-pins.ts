import {
  pinWorkspacePathCatalogCheckpoint,
  unpinWorkspacePathCatalogCheckpoint
} from './workspace-path-catalog-checkpoint-store'

/**
 * Restored checkpoints this worker may still be reading from.
 *
 * Why this exists: host-budget eviction drops the oldest checkpoint directory first, and a restored
 * one is the oldest — so the pin has to end exactly when nothing in this worker reads out of that
 * directory any more. Not when a write happens to succeed: the default policy refuses resident
 * re-encodes, so many roots never write again, and their stale pins would refuse every new
 * checkpoint once enough of them held the host budget.
 */
const restored = new Map<string, { directory: string; generationId: string }>()

export function pinRestoredWorkspacePathCheckpoint(args: {
  rootKey: string
  checkpointDirectory: string
  generationId: string
}): void {
  releaseRestoredWorkspacePathCheckpoint(args.rootKey)
  restored.set(args.rootKey, {
    directory: args.checkpointDirectory,
    generationId: args.generationId
  })
  pinWorkspacePathCatalogCheckpoint(args.checkpointDirectory)
}

/** Releases the pin unconditionally: the root is gone, or a different restore replaced it. */
export function releaseRestoredWorkspacePathCheckpoint(rootKey: string): void {
  const pinned = restored.get(rootKey)
  if (!pinned) {
    return
  }
  restored.delete(rootKey)
  unpinWorkspacePathCatalogCheckpoint(pinned.directory)
}

/**
 * Releases the pin once no retained generation still reads out of its directory.
 *
 * Why the directories in use and not just this root's generation: a spilled delta on a restored
 * catalog writes its replacement spill into that same directory, so a published generation can keep
 * the directory live after the restored one stops being the one served.
 */
export function releaseRestoredWorkspacePathCheckpointIfUnused(
  rootKey: string,
  spillDirectoriesInUse: Iterable<string>
): void {
  const pinned = restored.get(rootKey)
  if (!pinned) {
    return
  }
  for (const directory of spillDirectoriesInUse) {
    if (directory === pinned.directory) {
      return
    }
  }
  releaseRestoredWorkspacePathCheckpoint(rootKey)
}

/** Test-only: a pin must not outlive the suite that created it. */
export function resetRestoredWorkspacePathCheckpointPinsForTests(): void {
  for (const pinned of restored.values()) {
    unpinWorkspacePathCatalogCheckpoint(pinned.directory)
  }
  restored.clear()
}
