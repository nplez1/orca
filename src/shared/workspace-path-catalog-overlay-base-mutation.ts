import { compareFileNames } from './file-name-sort'
import {
  getWorkspacePathCatalogOriginalPath,
  type WorkspacePathCatalog
} from './workspace-path-catalog'
import { findWorkspacePathCatalogInsertionRank } from './workspace-path-catalog-ordering'

/** Replace or OR-merge one base path's flags in the overlay delta arrays, clearing its tombstone. */
export function applyWorkspacePathCatalogOverlayBaseFlags(args: {
  pathId: number
  effectiveFlags: number
  replace: boolean
  flagAdditions: Uint8Array
  flagReplacements: Uint8Array
  flagReplacementKnown: Uint8Array
  tombstones: Uint8Array
}): void {
  const { pathId, effectiveFlags, replace } = args
  if (replace) {
    args.flagReplacements[pathId] = effectiveFlags
    args.flagReplacementKnown[pathId] = 1
    args.flagAdditions[pathId] = 0
  } else if (args.flagReplacementKnown[pathId]) {
    args.flagReplacements[pathId] = (args.flagReplacements[pathId] ?? 0) | effectiveFlags
  } else {
    args.flagAdditions[pathId] = (args.flagAdditions[pathId] ?? 0) | effectiveFlags
  }
  args.tombstones[pathId] = 0
}

/** Effective base flags after overlay additions/replacements are folded in. */
export function readWorkspacePathCatalogOverlayBaseFlags(args: {
  pathId: number
  baseFlags: Uint8Array
  flagAdditions: Uint8Array
  flagReplacements: Uint8Array
  flagReplacementKnown: Uint8Array
}): number {
  return args.flagReplacementKnown[args.pathId]
    ? (args.flagReplacements[args.pathId] ?? 0)
    : (args.baseFlags[args.pathId] ?? 0) | (args.flagAdditions[args.pathId] ?? 0)
}

export function lookupWorkspacePathCatalogOverlayBasePathId(args: {
  base: WorkspacePathCatalog
  path: string
  findBasePathId?: (path: string) => number | undefined
}): number | undefined {
  const knownId = args.findBasePathId?.(args.path)
  if (knownId !== undefined) {
    return knownId
  }
  const rank = findWorkspacePathCatalogInsertionRank(args.base, args.path)
  if (rank >= args.base.pathCount) {
    return undefined
  }
  const pathId = args.base.naturalOrder[rank]
  if (pathId === undefined) {
    return undefined
  }
  return compareFileNames(getWorkspacePathCatalogOriginalPath(args.base, pathId), args.path) === 0
    ? pathId
    : undefined
}

/** Tombstone every base path equal to or nested under `prefix`. */
export function tombstoneWorkspacePathCatalogOverlayBasePrefix(args: {
  base: WorkspacePathCatalog
  prefix: string
  tombstones: Uint8Array
}): void {
  const boundaryPrefix = `${args.prefix}/`
  const startRank = findWorkspacePathCatalogInsertionRank(args.base, args.prefix)
  for (let rank = startRank; rank < args.base.pathCount; rank += 1) {
    const pathId = args.base.naturalOrder[rank]
    if (pathId === undefined) {
      break
    }
    const candidate = getWorkspacePathCatalogOriginalPath(args.base, pathId)
    if (candidate !== args.prefix && !candidate.startsWith(boundaryPrefix)) {
      break
    }
    args.tombstones[pathId] = 1
  }
}
