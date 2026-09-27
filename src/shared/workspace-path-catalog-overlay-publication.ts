import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from './workspace-path-search-instrumentation'
import type { WorkspacePathCatalogMetadata } from './workspace-path-catalog'
import type {
  WorkspacePathCatalogDeltaEntry,
  WorkspacePathCatalogOverlay
} from './workspace-path-catalog-overlay-contract'

export function publishWorkspacePathCatalogOverlay(args: {
  generationId: string
  metadata: WorkspacePathCatalogMetadata
  baseFlagAdditions: Uint8Array
  baseFlagReplacements: Uint8Array
  baseFlagReplacementKnown: Uint8Array
  baseTombstones: Uint8Array
  delta: Map<string, WorkspacePathCatalogDeltaEntry>
  sortedDelta: WorkspacePathCatalogDeltaEntry[]
  correlationId: WorkspacePathSearchCorrelationId
  onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
}): WorkspacePathCatalogOverlay {
  const startedAt = performance.now()
  let deltaBytes = args.sortedDelta.length * 72
  for (const entry of args.sortedDelta) {
    deltaBytes += entry.relativePath.length * 2 + 48
    deltaBytes += entry.foldedPath.length * 2 + 48
  }
  const retainedBytes =
    args.baseFlagAdditions.byteLength +
    args.baseFlagReplacements.byteLength +
    args.baseFlagReplacementKnown.byteLength +
    args.baseTombstones.byteLength +
    deltaBytes +
    128
  args.delta.clear()
  const overlay: WorkspacePathCatalogOverlay = {
    generationId: args.generationId,
    metadata: { ...args.metadata },
    baseFlagAdditions: args.baseFlagAdditions,
    baseFlagReplacements: args.baseFlagReplacements,
    baseFlagReplacementKnown: args.baseFlagReplacementKnown,
    baseTombstones: args.baseTombstones,
    delta: args.sortedDelta,
    retainedBytes,
    deltaBytes
  }
  args.onInstrumentation?.({
    kind: 'stage-timing',
    record: {
      correlationId: args.correlationId,
      stage: 'index-publication',
      duration: { milliseconds: performance.now() - startedAt, clock: 'execution-host-monotonic' }
    }
  })
  return overlay
}
