import type { WorkspacePathSearchOwnerIdentity } from '../../shared/workspace-path-search-contract'
import type { WorkspacePathIndexEntry } from './workspace-path-index-lease'

export type WorkspacePathIndexCheckpointRestore = {
  generationId: string
  publishedScope: 'included' | 'all' | 'both'
  retainedBytes: number
  loadMilliseconds: number
}

export type WorkspacePathCheckpointRestoreLoader = (args: {
  owner: WorkspacePathSearchOwnerIdentity
  entryKey: string
}) => Promise<WorkspacePathIndexCheckpointRestore | null>

/**
 * Loads a checkpoint and refuses it unless the host budget can account for its retained bytes, so an
 * unaccounted catalog can never be served while its reconciliation runs.
 */
export async function loadAdoptableWorkspacePathCheckpoint(args: {
  restore?: WorkspacePathCheckpointRestoreLoader
  admit: (entryKey: string, retainedBytes: number) => boolean
  owner: WorkspacePathSearchOwnerIdentity
  entryKey: string
}): Promise<WorkspacePathIndexCheckpointRestore | null> {
  const restore = args.restore
  if (!restore) {
    return null
  }
  const restored = await restore({
    owner: args.owner,
    entryKey: args.entryKey
  }).catch(() => null)
  if (!restored) {
    return null
  }
  return args.admit(args.entryKey, restored.retainedBytes) ? restored : null
}

/**
 * Adopts a restored checkpoint as provisional last-known coverage: the entry can answer during the
 * reconciliation build, and every reply is labeled provisional until that build publishes. Any
 * failure leaves the entry exactly as a cold root, because a checkpoint must never make a root
 * unusable or block its own reconciliation.
 */
export async function adoptWorkspacePathCheckpoint(
  entry: WorkspacePathIndexEntry,
  restore: WorkspacePathCheckpointRestoreLoader
): Promise<void> {
  try {
    const restored = await restore({ owner: entry.owner, entryKey: entry.key })
    if (!restored || entry.disposed) {
      return
    }
    entry.generationId = restored.generationId
    entry.publishedScope = restored.publishedScope
    entry.retainedBytes = restored.retainedBytes
    entry.servingLastKnown = true
    entry.needsRebuild = true
    entry.freshness = 'provisional'
  } catch {
    // A checkpoint can never make an active root unusable.
  }
}
