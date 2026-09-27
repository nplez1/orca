import { getRelativePathInsideRoot, joinPath } from '@/lib/path'
import type { FileExplorerRowProjection } from './file-explorer-row-projection'
import type { SyntheticTreeEntry } from './file-explorer-name-filter-tree-nodes'
import {
  getFileExplorerNameFilterTokens,
  isFileExplorerNameFilterQueryTooLarge
} from './file-explorer-name-filter-policy'
import { splitPathSegments } from './path-tree'

/** Keeps only the paths the pane can show inside the displayed root. */
export function isInsideDisplayRoot(
  worktreePath: string,
  relativePath: string,
  displayRootPath: string
): boolean {
  return getRelativePathInsideRoot(joinPath(worktreePath, relativePath), displayRootPath) !== null
}

/** Descends to the displayed root's children; null when no accepted path reaches it. */
export function getDisplayRootChildren(
  rootChildren: Map<string, SyntheticTreeEntry>,
  worktreePath: string,
  displayRootPath: string
): Map<string, SyntheticTreeEntry> | null {
  let displayChildren = rootChildren
  const scope = getRelativePathInsideRoot(displayRootPath, worktreePath)
  for (const segment of scope ? splitPathSegments(scope) : []) {
    const entry = displayChildren.get(segment)
    if (!entry) {
      return null
    }
    displayChildren = entry.children
  }
  return displayChildren
}

export function getFileExplorerNameFilterExpandedPaths(
  rowProjection: FileExplorerRowProjection,
  nameFilterQuery: string
): Set<string> {
  if (
    isFileExplorerNameFilterQueryTooLarge(nameFilterQuery) ||
    getFileExplorerNameFilterTokens(nameFilterQuery).length === 0
  ) {
    return new Set()
  }

  const expandedPaths = new Set<string>()
  const count = rowProjection.getVisibleCount()
  for (let index = 0; index < count - 1; index += 1) {
    const row = rowProjection.getRowAtIndex(index)
    const nextRow = rowProjection.getRowAtIndex(index + 1)
    if (row?.isDirectory && nextRow && nextRow.depth > row.depth) {
      expandedPaths.add(row.path)
    }
  }
  return expandedPaths
}
