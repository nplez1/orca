import {
  getWorkspacePathCatalogOriginalPath,
  type WorkspacePathCatalog
} from './workspace-path-catalog'

export type WorkspacePathCatalogDecodedBlockReader = {
  getOriginalAtRank(rank: number, pathId: number): string
}

/** Bounded window over packed originals: decode at most 256 paths or 256 KiB per refill. */
export function createWorkspacePathCatalogDecodedBlockReader(args: {
  catalog: WorkspacePathCatalog
  prefixes: readonly string[]
}): WorkspacePathCatalogDecodedBlockReader {
  const { catalog, prefixes } = args
  let decodedBlockStart = -1
  let decodedBlockEnd = -1
  let decodedOriginalPaths: string[] = []

  const loadDecodedBlock = (rank: number): void => {
    if (rank >= decodedBlockStart && rank < decodedBlockEnd) {
      return
    }
    decodedBlockStart = rank
    decodedBlockEnd = rank
    decodedOriginalPaths = []
    let decodedCodeUnits = 0
    while (decodedBlockEnd < catalog.pathCount && decodedBlockEnd - decodedBlockStart < 256) {
      const pathId = catalog.naturalOrder[decodedBlockEnd]
      if (pathId === undefined) {
        break
      }
      const originalPath = getWorkspacePathCatalogOriginalPath(catalog, pathId)
      if (decodedBlockEnd > decodedBlockStart && decodedCodeUnits + originalPath.length > 262_144) {
        break
      }
      decodedOriginalPaths.push(originalPath)
      decodedCodeUnits += originalPath.length
      decodedBlockEnd += 1
    }
  }

  return {
    getOriginalAtRank(rank: number, pathId: number): string {
      if (prefixes.length === 0) {
        return ''
      }
      if (catalog.storageKind === 'prefix-compressed') {
        return getWorkspacePathCatalogOriginalPath(catalog, pathId)
      }
      loadDecodedBlock(rank)
      return (
        decodedOriginalPaths[rank - decodedBlockStart] ??
        getWorkspacePathCatalogOriginalPath(catalog, pathId)
      )
    }
  }
}
