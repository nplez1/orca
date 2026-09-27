import type { WorkspacePathCatalog } from './workspace-path-catalog'
import { getWorkspacePathCatalogOriginalPath } from './workspace-path-catalog'
import { compareFileNames } from './file-name-sort'

/** Finds the stable natural-order insertion position for a relative path. */
export function findWorkspacePathCatalogInsertionRank(
  catalog: WorkspacePathCatalog,
  path: string
): number {
  let low = 0
  let high = catalog.pathCount
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const pathId = catalog.naturalOrder[middle]
    const candidate =
      pathId === undefined ? '' : getWorkspacePathCatalogOriginalPath(catalog, pathId)
    if (compareFileNames(candidate, path) < 0) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}
