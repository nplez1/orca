import {
  pinWorkspacePathCatalogCheckpoint,
  unpinWorkspacePathCatalogCheckpoint
} from './workspace-path-catalog-checkpoint-store'

/**
 * Restored checkpoints this worker is still serving from.
 *
 * Why keyed by the restored generation and not just the root: host-budget eviction drops the oldest
 * checkpoint directory first, and a restored one is the oldest — so the pin has to end exactly when
 * that generation stops being readable here, not when a write happens to succeed. Otherwise a root
 * that never writes again (the default policy refuses resident re-encodes) pins its directory for
 * the life of the worker, and enough of them refuse every new checkpoint.
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

/** Releases the pin when a different generation becomes the one this worker serves. */
export function releaseSupersededRestoredWorkspacePathCheckpoint(
  rootKey: string,
  publishedGenerationId: string
): void {
  const pinned = restored.get(rootKey)
  if (pinned && pinned.generationId !== publishedGenerationId) {
    releaseRestoredWorkspacePathCheckpoint(rootKey)
  }
}

/** Releases the pin when that generation leaves the worker; a different generation changes nothing. */
export function releaseRestoredWorkspacePathCheckpoint(
  rootKey: string,
  generationId?: string
): void {
  const pinned = restored.get(rootKey)
  if (!pinned || (generationId !== undefined && generationId !== pinned.generationId)) {
    return
  }
  restored.delete(rootKey)
  unpinWorkspacePathCatalogCheckpoint(pinned.directory)
}

/** Test-only: a pin must not outlive the suite that created it. */
export function resetRestoredWorkspacePathCheckpointPinsForTests(): void {
  for (const pinned of restored.values()) {
    unpinWorkspacePathCatalogCheckpoint(pinned.directory)
  }
  restored.clear()
}
