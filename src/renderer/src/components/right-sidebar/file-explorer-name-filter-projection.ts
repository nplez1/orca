import { normalizeRelativePath } from '@/lib/path'
import { pathMatchesFileNameFilterTokens } from '../../../../shared/file-name-filter-tokens'
import type { TreeNode } from './file-explorer-types'
import {
  createFileExplorerRowProjectionFromParts,
  type FileExplorerRowProjection
} from './file-explorer-row-projection'
import {
  getFileExplorerNameFilterTokens,
  isFileExplorerNameFilterQueryTooLarge,
  type FileExplorerNameFilterProjectionSource
} from './file-explorer-name-filter-policy'
import {
  MAX_NAME_FILTER_PROJECTION_ESTIMATED_BYTES,
  cacheFilteredProjection,
  getCachedFilteredProjection,
  getFileExplorerNameFilterProjectionCacheKey,
  projectionEstimatedBytesByObject
} from './file-explorer-name-filter-projection-cache'
import {
  createSyntheticTreePathRoot,
  insertNameFilteredPath,
  type NameFilteredPathInsertionState,
  type SyntheticTreeEntry
} from './file-explorer-name-filter-tree-nodes'
import { isDotfileRelativePath } from './file-explorer-entries'
import { getAcceptedNameFilterPath } from './file-explorer-name-filter-path-acceptance'
import {
  getDisplayRootChildren,
  isInsideDisplayRoot
} from './file-explorer-name-filter-projection-walk'
import { appendNameFilteredEntries } from './file-explorer-name-filter-tree-sort'

export type { FileExplorerNameFilterProjectionSource }

export { isFileExplorerNameFilterQueryTooLarge, getFileExplorerNameFilterTokens }

export {
  FILE_EXPLORER_NAME_FILTER_MAX_RESULTS,
  FILE_EXPLORER_NAME_FILTER_QUERY_MAX_BYTES,
  getNameFilterCollapsedPathsAfterExpand,
  getFileExplorerNameFilterEmptyMessageKind,
  getNextNameFilterCollapsedPaths
} from './file-explorer-name-filter-policy'
export {
  MAX_NAME_FILTER_PROJECTION_ESTIMATED_BYTES,
  getFileExplorerNameFilterProjectionCacheKey,
  getFileExplorerNameFilterProjectionEstimatedBytes
} from './file-explorer-name-filter-projection-cache'
export { shouldBuildNameFilterProjectionInChunks } from './file-explorer-name-filter-tree-nodes'
export { getFileExplorerNameFilterExpandedPaths } from './file-explorer-name-filter-projection-walk'
export { createNameFilteredFileExplorerProjectionInChunks } from './file-explorer-name-filter-projection-chunked'

/** Lives here rather than in the policy module: folding separators needs the caller's root. */
export function getFileExplorerNameFilterIgnoredQueryRelativePaths(
  source: FileExplorerNameFilterProjectionSource,
  showDotfiles: boolean,
  worktreePath?: string | null
): string[] {
  if (isFileExplorerNameFilterQueryTooLarge(source.query)) {
    return []
  }
  if (source.relativePaths === null) {
    return []
  }
  const tokens = getFileExplorerNameFilterTokens(source.query)
  return source.relativePaths
    .map((relativePath) => normalizeRelativePath(relativePath, worktreePath))
    .filter(
      (relativePath) =>
        Boolean(relativePath) &&
        (showDotfiles || !isDotfileRelativePath(relativePath, worktreePath)) &&
        pathMatchesFileNameFilterTokens(relativePath, tokens)
    )
}

/** Builds a filtered subtree for the display root while retaining worktree-relative paths on synthetic nodes. */
export function createNameFilteredFileExplorerProjection({
  collapsedPaths,
  ignoredSet,
  nameFilter,
  showDotfiles,
  showGitIgnoredFiles,
  worktreePath,
  displayRootPath = worktreePath
}: {
  collapsedPaths?: ReadonlySet<string>
  ignoredSet: Set<string>
  nameFilter: FileExplorerNameFilterProjectionSource
  showDotfiles: boolean
  showGitIgnoredFiles: boolean
  worktreePath: string
  displayRootPath?: string
}): FileExplorerRowProjection {
  const cacheKey = getFileExplorerNameFilterProjectionCacheKey({
    collapsedPaths,
    ignoredSet,
    nameFilter,
    showDotfiles,
    showGitIgnoredFiles,
    worktreePath
  })
  const cachedProjection = getCachedFilteredProjection(cacheKey)
  if (cachedProjection) {
    cacheFilteredProjection(cacheKey, cachedProjection)
    return cachedProjection
  }
  const visibleFlatRows: TreeNode[] = []
  const rowsByPath = new Map<string, TreeNode>()
  if (isFileExplorerNameFilterQueryTooLarge(nameFilter.query)) {
    const projection = createFileExplorerRowProjectionFromParts(visibleFlatRows, rowsByPath)
    cacheFilteredProjection(cacheKey, projection)
    return projection
  }
  const nameFilterTokens = getFileExplorerNameFilterTokens(nameFilter.query)
  if (nameFilterTokens.length === 0 || nameFilter.relativePaths === null) {
    // Why: empty queries use the normal explorer projection, and loading filters must not
    // fall back to a partial cached path list.
    const projection = createFileExplorerRowProjectionFromParts(visibleFlatRows, rowsByPath)
    cacheFilteredProjection(cacheKey, projection)
    return projection
  }

  const rootChildren = new Map<string, SyntheticTreeEntry>()
  const insertionState: NameFilteredPathInsertionState = { relativePath: '', entries: [] }
  const pathRoot = createSyntheticTreePathRoot(worktreePath)
  const hostAppliedScope = nameFilter.workspacePathSearch !== undefined
  let constructionBytes = 0
  for (const rawRelativePath of nameFilter.relativePaths) {
    const acceptedPath = getAcceptedNameFilterPath({
      rawRelativePath,
      nameFilter,
      nameFilterTokens,
      hostAppliedScope,
      ignoredSet,
      showDotfiles,
      showGitIgnoredFiles,
      rootPath: worktreePath
    })
    if (acceptedPath) {
      if (!isInsideDisplayRoot(worktreePath, acceptedPath.relativePath, displayRootPath)) {
        continue
      }
      insertNameFilteredPath(
        rootChildren,
        acceptedPath,
        insertionState,
        pathRoot,
        nameFilter.operationOwner,
        (estimatedBytes) => {
          constructionBytes += estimatedBytes
          if (constructionBytes > MAX_NAME_FILTER_PROJECTION_ESTIMATED_BYTES) {
            throw new Error('The filtered file tree exceeds its projection byte budget.')
          }
        }
      )
    }
  }

  const displayChildren = getDisplayRootChildren(rootChildren, worktreePath, displayRootPath)
  if (!displayChildren) {
    return createFileExplorerRowProjectionFromParts(visibleFlatRows, rowsByPath)
  }
  appendNameFilteredEntries(displayChildren, visibleFlatRows, rowsByPath, collapsedPaths)
  const projection = createFileExplorerRowProjectionFromParts(visibleFlatRows, rowsByPath)
  projectionEstimatedBytesByObject.set(projection, constructionBytes)
  cacheFilteredProjection(cacheKey, projection)
  return projection
}
