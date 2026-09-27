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
  createProjectionAbortError,
  createSyntheticTreePathRoot,
  insertNameFilteredPath,
  insertNameFilteredPathInChunks,
  type NameFilteredPathInsertionState,
  type SyntheticTreeEntry
} from './file-explorer-name-filter-tree-nodes'
import { getAcceptedNameFilterPath } from './file-explorer-name-filter-path-acceptance'
import {
  getDisplayRootChildren,
  isInsideDisplayRoot
} from './file-explorer-name-filter-projection-walk'
import {
  appendNameFilteredEntries,
  getSingleSyntheticChild,
  sortNameFilteredEntriesInChunks
} from './file-explorer-name-filter-tree-sort'

export type { FileExplorerNameFilterProjectionSource }

export { isFileExplorerNameFilterQueryTooLarge, getFileExplorerNameFilterTokens }

export {
  FILE_EXPLORER_NAME_FILTER_MAX_RESULTS,
  FILE_EXPLORER_NAME_FILTER_QUERY_MAX_BYTES,
  getNameFilterCollapsedPathsAfterExpand,
  getFileExplorerNameFilterEmptyMessageKind,
  getFileExplorerNameFilterIgnoredQueryRelativePaths,
  getNextNameFilterCollapsedPaths
} from './file-explorer-name-filter-policy'
export {
  MAX_NAME_FILTER_PROJECTION_ESTIMATED_BYTES,
  getFileExplorerNameFilterProjectionCacheKey,
  getFileExplorerNameFilterProjectionEstimatedBytes
} from './file-explorer-name-filter-projection-cache'
export { shouldBuildNameFilterProjectionInChunks } from './file-explorer-name-filter-tree-nodes'
export { getFileExplorerNameFilterExpandedPaths } from './file-explorer-name-filter-projection-walk'

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
      showGitIgnoredFiles
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

export async function createNameFilteredFileExplorerProjectionInChunks(args: {
  collapsedPaths?: ReadonlySet<string>
  ignoredSet: Set<string>
  nameFilter: FileExplorerNameFilterProjectionSource
  showDotfiles: boolean
  showGitIgnoredFiles: boolean
  worktreePath: string
  displayRootPath?: string
  signal: AbortSignal
  onChunkDuration?: (milliseconds: number) => void
}): Promise<FileExplorerRowProjection> {
  const cacheKey = getFileExplorerNameFilterProjectionCacheKey(args)
  const cachedProjection = getCachedFilteredProjection(cacheKey)
  if (cachedProjection) {
    cacheFilteredProjection(cacheKey, cachedProjection)
    return cachedProjection
  }
  const queryTokens = getFileExplorerNameFilterTokens(args.nameFilter.query)
  if (queryTokens.length === 0 || args.nameFilter.relativePaths === null) {
    return createNameFilteredFileExplorerProjection(args)
  }

  const rootChildren = new Map<string, SyntheticTreeEntry>()
  const insertionState: NameFilteredPathInsertionState = { relativePath: '', entries: [] }
  const pathRoot = createSyntheticTreePathRoot(args.worktreePath)
  const displayRootPath = args.displayRootPath ?? args.worktreePath
  const hostAppliedScope = args.nameFilter.workspacePathSearch !== undefined
  let constructionBytes = 0
  let unitCount = 0
  let chunkStartedAt = performance.now()
  const yieldIfNeeded = (): Promise<void> | null => {
    unitCount += 1
    const elapsed = performance.now() - chunkStartedAt
    if (unitCount < 2_048 && elapsed < 4) {
      return null
    }
    if (args.signal.aborted) {
      throw createProjectionAbortError()
    }
    args.onChunkDuration?.(elapsed)
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        unitCount = 0
        chunkStartedAt = performance.now()
        resolve()
      }, 0)
    )
  }

  for (const rawRelativePath of args.nameFilter.relativePaths) {
    if (args.signal.aborted) {
      throw createProjectionAbortError()
    }
    const acceptedPath = getAcceptedNameFilterPath({
      rawRelativePath,
      nameFilter: args.nameFilter,
      nameFilterTokens: queryTokens,
      hostAppliedScope,
      ignoredSet: args.ignoredSet,
      showDotfiles: args.showDotfiles,
      showGitIgnoredFiles: args.showGitIgnoredFiles
    })
    if (acceptedPath) {
      if (!isInsideDisplayRoot(args.worktreePath, acceptedPath.relativePath, displayRootPath)) {
        continue
      }
      const pendingInsertion = insertNameFilteredPathInChunks({
        rootChildren,
        acceptedPath,
        state: insertionState,
        pathRoot,
        operationOwner: args.nameFilter.operationOwner,
        yieldIfNeeded,
        signal: args.signal,
        onNodeCreated: (estimatedBytes) => {
          constructionBytes += estimatedBytes
          if (constructionBytes > MAX_NAME_FILTER_PROJECTION_ESTIMATED_BYTES) {
            throw new Error('The filtered file tree exceeds its projection byte budget.')
          }
        }
      })
      if (pendingInsertion) {
        await pendingInsertion
      }
    }
    const pause = yieldIfNeeded()
    if (pause) {
      await pause
    }
  }

  const displayChildren = getDisplayRootChildren(rootChildren, args.worktreePath, displayRootPath)
  if (!displayChildren) {
    return createFileExplorerRowProjectionFromParts([], new Map())
  }
  const visibleFlatRows: TreeNode[] = []
  const rowsByPath = new Map<string, TreeNode>()
  type SortedTreeFrame = { entries: SyntheticTreeEntry[]; index: number }
  const stack: SortedTreeFrame[] = [
    {
      entries: await sortNameFilteredEntriesInChunks(displayChildren, yieldIfNeeded),
      index: 0
    }
  ]
  while (stack.length > 0) {
    if (args.signal.aborted) {
      throw createProjectionAbortError()
    }
    const frame = stack.at(-1)
    if (!frame) {
      throw new Error('Synthetic tree traversal lost its active frame.')
    }
    const entry = frame.entries.at(frame.index)
    if (!entry) {
      stack.pop()
      continue
    }
    frame.index += 1
    visibleFlatRows.push(entry.node)
    rowsByPath.set(entry.node.path, entry.node)
    if (entry.children.size > 0 && !args.collapsedPaths?.has(entry.node.path)) {
      const singleChild = getSingleSyntheticChild(entry.children)
      stack.push({
        entries: singleChild
          ? [singleChild]
          : await sortNameFilteredEntriesInChunks(entry.children, yieldIfNeeded),
        index: 0
      })
    }
    const pause = yieldIfNeeded()
    if (pause) {
      await pause
    }
  }

  if (unitCount > 0) {
    args.onChunkDuration?.(performance.now() - chunkStartedAt)
  }
  if (args.signal.aborted) {
    throw createProjectionAbortError()
  }
  const projection = createFileExplorerRowProjectionFromParts(visibleFlatRows, rowsByPath)
  projectionEstimatedBytesByObject.set(projection, constructionBytes)
  cacheFilteredProjection(cacheKey, projection)
  return projection
}
