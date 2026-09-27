import type { WorkspacePathSearchInstrumentationEvent } from './workspace-path-search-instrumentation'
import { WorkspacePathCatalogBuilder } from './workspace-path-catalog-builder'
import { finishWorkspacePathCatalogBuilderInWorker } from './workspace-path-catalog-builder-worker'
import {
  getWorkspacePathCatalogFoldedPath,
  getWorkspacePathCatalogOriginalPath,
  type WorkspacePathCatalogGeneration
} from './workspace-path-catalog'
import type { WorkspacePathSortCancellation } from './workspace-path-stable-sort'

export async function compactWorkspacePathCatalogGenerationInWorker(
  generation: WorkspacePathCatalogGeneration,
  args: {
    generationId: string
    maxBytes: number
    cancellation?: WorkspacePathSortCancellation
    onInstrumentation?: (event: WorkspacePathSearchInstrumentationEvent) => void
  }
): Promise<WorkspacePathCatalogGeneration | null> {
  const { catalog, overlay } = generation
  if (catalog.storageKind === 'disk-spilled') {
    return null
  }
  if (!overlay) {
    return generation
  }
  const builder = new WorkspacePathCatalogBuilder({
    generationId: args.generationId,
    maxBytes: args.maxBytes,
    storage: catalog.storageKind,
    foldLocale: catalog.metadata.foldLocale,
    scopeRuleVersion: catalog.metadata.scopeRuleVersion,
    freshness: overlay.metadata.freshness,
    coverageExcludePathSegments: catalog.metadata.coverageExcludePathSegments,
    onInstrumentation: args.onInstrumentation
  })
  let deltaIndex = 0
  let lastYieldAt = performance.now()
  let visited = 0
  const delta = overlay.delta
  for (let rank = 0; rank <= catalog.pathCount; rank += 1) {
    while (delta[deltaIndex]?.baseRank === rank) {
      const entry = delta[deltaIndex]
      if (entry && !builder.addPreFoldedPath(entry.relativePath, entry.foldedPath, entry.flags)) {
        return null
      }
      deltaIndex += 1
      await yieldIfDue()
    }
    if (rank === catalog.pathCount) {
      break
    }
    const pathId = catalog.naturalOrder[rank]
    if (pathId === undefined || overlay.baseTombstones[pathId] === 1) {
      await yieldIfDue()
      continue
    }
    const flags = overlay.baseFlagReplacementKnown[pathId]
      ? (overlay.baseFlagReplacements[pathId] ?? 0)
      : (catalog.flags[pathId] ?? 0) | (overlay.baseFlagAdditions[pathId] ?? 0)
    if (
      !builder.addPreFoldedPath(
        getWorkspacePathCatalogOriginalPath(catalog, pathId),
        getWorkspacePathCatalogFoldedPath(catalog, pathId),
        flags
      )
    ) {
      return null
    }
    await yieldIfDue()
  }
  if (overlay.metadata.includedComplete) {
    builder.markScopeComplete('included')
  }
  if (overlay.metadata.allComplete) {
    builder.markScopeComplete('all')
  }
  const compacted = await finishWorkspacePathCatalogBuilderInWorker(builder, {
    retainPathLookup: false,
    cancellation: args.cancellation
  })
  if (!compacted || args.cancellation?.isCancelled()) {
    return null
  }
  return compacted ? { catalog: compacted } : null

  async function yieldIfDue(): Promise<void> {
    visited += 1
    if (visited % 64 === 0 && performance.now() - lastYieldAt >= 8) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      lastYieldAt = performance.now()
    }
    if (args.cancellation?.isCancelled()) {
      throw new Error('Workspace path catalog compaction was cancelled')
    }
  }
}
