import type {
  WorkspacePathSearchCorrelationId,
  WorkspacePathSearchInstrumentationEvent
} from './workspace-path-search-instrumentation'
import type { WorkspacePathCatalogMetadata } from './workspace-path-catalog'

export type WorkspacePathCatalogDeltaEntry = {
  relativePath: string
  foldedPath: string
  flags: number
  /** Base natural-order insertion slot; base replacements update a bitset instead. */
  baseRank: number
}

export type WorkspacePathCatalogOverlay = {
  generationId: string
  metadata: WorkspacePathCatalogMetadata
  baseFlagAdditions: Uint8Array
  baseFlagReplacements: Uint8Array
  baseFlagReplacementKnown: Uint8Array
  baseTombstones: Uint8Array
  delta: readonly WorkspacePathCatalogDeltaEntry[]
  retainedBytes: number
  deltaBytes: number
}

export type WorkspacePathCatalogOverlayBuilderOptions = {
  generationId: string
  maxBytes: number
  findBasePathId?: (path: string) => number | undefined
  onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
  correlationId?: WorkspacePathSearchCorrelationId
  previousOverlay?: WorkspacePathCatalogOverlay
}
