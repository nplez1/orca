import type { WorkspacePathSearchPathSet } from './workspace-path-search-contract'
import { WorkspacePathCatalogBuilder } from './workspace-path-catalog-builder'
import type { WorkspacePathCatalogDeltaEntry } from './workspace-path-catalog-overlay-contract'
import type { WorkspacePathSortCancellation } from './workspace-path-stable-sort'
import {
  getWorkspacePathCatalogFoldedPath,
  getWorkspacePathCatalogOriginalPath,
  resolveWorkspacePathFoldLocale,
  WORKSPACE_PATH_CATALOG_FLAGS,
  type WorkspacePathCatalog,
  type WorkspacePathCatalogGeneration,
  type WorkspacePathCatalogMetadata
} from './workspace-path-catalog'

export const WORKSPACE_PATH_CATALOG_COMPACTION_DELTA_RATIO = 0.1
export const WORKSPACE_PATH_CATALOG_COMPACTION_MIN_DELTA_PATHS = 1_024
export const WORKSPACE_PATH_CATALOG_COMPACTION_DELTA_BYTES = 32 * 1024 * 1024

export function isWorkspacePathCatalogCompactionDue(
  generation: WorkspacePathCatalogGeneration
): boolean {
  const overlay = generation.overlay
  if (!overlay) {
    return false
  }
  return (
    overlay.delta.length >=
      Math.max(
        WORKSPACE_PATH_CATALOG_COMPACTION_MIN_DELTA_PATHS,
        Math.ceil(generation.catalog.pathCount * WORKSPACE_PATH_CATALOG_COMPACTION_DELTA_RATIO)
      ) || overlay.deltaBytes >= WORKSPACE_PATH_CATALOG_COMPACTION_DELTA_BYTES
  )
}

export function compactWorkspacePathCatalogGeneration(
  generation: WorkspacePathCatalogGeneration,
  options: { generationId: string; maxBytes: number }
): WorkspacePathCatalogGeneration | null {
  if (!generation.overlay) {
    return generation
  }
  const { catalog, overlay } = generation
  if (catalog.storageKind === 'disk-spilled') {
    return null
  }
  const builder = new WorkspacePathCatalogBuilder({
    generationId: options.generationId,
    maxBytes: options.maxBytes,
    storage: catalog.storageKind,
    foldLocale: catalog.metadata.foldLocale,
    scopeRuleVersion: catalog.metadata.scopeRuleVersion,
    freshness: overlay.metadata.freshness,
    coverageExcludePathSegments: catalog.metadata.coverageExcludePathSegments
  })
  let admitted = true
  forEachWorkspacePathCatalogEntry(generation, (path, foldedPath, flags) => {
    if (admitted && !builder.addPreFoldedPath(path, foldedPath, flags)) {
      admitted = false
    }
  })
  if (!admitted) {
    return null
  }
  if (overlay.metadata.includedComplete) {
    builder.markScopeComplete('included')
  }
  if (overlay.metadata.allComplete) {
    builder.markScopeComplete('all')
  }
  const compacted = builder.finish()
  return compacted ? { catalog: compacted } : null
}

/** Iterates the immutable base/delta union once in shared natural order. */
export function forEachWorkspacePathCatalogEntry(
  generation: WorkspacePathCatalogGeneration,
  visit: (path: string, foldedPath: string, flags: number) => void
): void {
  const catalog = generation.catalog
  const overlay = generation.overlay
  let deltaIndex = 0
  for (let rank = 0; rank <= catalog.pathCount; rank += 1) {
    while (overlay?.delta[deltaIndex]?.baseRank === rank) {
      const entry = overlay.delta[deltaIndex]
      if (entry) {
        visit(entry.relativePath, entry.foldedPath, entry.flags)
      }
      deltaIndex += 1
    }
    if (rank === catalog.pathCount) {
      break
    }
    const pathId = catalog.naturalOrder[rank]
    if (pathId === undefined || overlay?.baseTombstones[pathId] === 1) {
      continue
    }
    const flags = overlay?.baseFlagReplacementKnown[pathId]
      ? (overlay.baseFlagReplacements[pathId] ?? 0)
      : (catalog.flags[pathId] ?? 0) | (overlay?.baseFlagAdditions[pathId] ?? 0)
    visit(
      getWorkspacePathCatalogOriginalPath(catalog, pathId),
      getWorkspacePathCatalogFoldedPath(catalog, pathId),
      flags
    )
  }
}

export function classifyWorkspacePathCatalogOverlay(args: {
  catalog: WorkspacePathCatalog
  flagAdditions: Uint8Array
  flagReplacements: Uint8Array
  replacementKnown: Uint8Array
  delta: Iterable<WorkspacePathCatalogDeltaEntry>
}): void {
  for (let pathId = 0; pathId < args.catalog.pathCount; pathId += 1) {
    const flags = args.replacementKnown[pathId]
      ? (args.flagReplacements[pathId] ?? 0)
      : (args.catalog.flags[pathId] ?? 0) | (args.flagAdditions[pathId] ?? 0)
    const classification = workspacePathCatalogClassificationFlags(flags)
    if (args.replacementKnown[pathId]) {
      args.flagReplacements[pathId] = flags | classification
    } else {
      args.flagAdditions[pathId] = (args.flagAdditions[pathId] ?? 0) | classification
    }
  }
  for (const entry of args.delta) {
    entry.flags |= workspacePathCatalogClassificationFlags(entry.flags)
  }
}

export async function classifyWorkspacePathCatalogOverlayInWorker(args: {
  catalog: WorkspacePathCatalog
  flagAdditions: Uint8Array
  flagReplacements: Uint8Array
  replacementKnown: Uint8Array
  delta: Iterable<WorkspacePathCatalogDeltaEntry>
  cancellation?: WorkspacePathSortCancellation
}): Promise<void> {
  let lastYieldAt = performance.now()
  let iterations = 0
  for (let pathId = 0; pathId < args.catalog.pathCount; pathId += 1) {
    const flags = args.replacementKnown[pathId]
      ? (args.flagReplacements[pathId] ?? 0)
      : (args.catalog.flags[pathId] ?? 0) | (args.flagAdditions[pathId] ?? 0)
    const classification = workspacePathCatalogClassificationFlags(flags)
    if (args.replacementKnown[pathId]) {
      args.flagReplacements[pathId] = flags | classification
    } else {
      args.flagAdditions[pathId] = (args.flagAdditions[pathId] ?? 0) | classification
    }
    await yieldIfDue()
  }
  for (const entry of args.delta) {
    entry.flags |= workspacePathCatalogClassificationFlags(entry.flags)
    await yieldIfDue()
  }

  async function yieldIfDue(): Promise<void> {
    iterations += 1
    if (args.cancellation?.isCancelled()) {
      throw new Error('Workspace path catalog build was cancelled')
    }
    if (iterations % 64 !== 0 || performance.now() - lastYieldAt < 8) {
      return
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    lastYieldAt = performance.now()
    if (args.cancellation?.isCancelled()) {
      throw new Error('Workspace path catalog build was cancelled')
    }
  }
}

export function workspacePathCatalogClassificationFlags(flags: number): number {
  return (flags & WORKSPACE_PATH_CATALOG_FLAGS.included) !== 0
    ? WORKSPACE_PATH_CATALOG_FLAGS.ignoreClassificationKnown
    : WORKSPACE_PATH_CATALOG_FLAGS.ignoreClassificationKnown | WORKSPACE_PATH_CATALOG_FLAGS.ignored
}

export function workspacePathCatalogOverlayScopeComplete(
  metadata: WorkspacePathCatalogMetadata,
  pathSet: WorkspacePathSearchPathSet
): boolean {
  return pathSet === 'included' ? metadata.includedComplete : metadata.allComplete
}

export function workspacePathCatalogOverlayFoldLocaleIsCurrent(
  catalog: WorkspacePathCatalog
): boolean {
  return catalog.metadata.foldLocale === resolveWorkspacePathFoldLocale()
}
