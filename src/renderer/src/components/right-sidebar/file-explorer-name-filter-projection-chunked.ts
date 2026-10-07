import {
  createFileExplorerRowProjectionFromParts,
  type FileExplorerRowProjection
} from './file-explorer-row-projection'
import type { TreeNode } from './file-explorer-types'
import {
  getFileExplorerNameFilterTokens,
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
  getSingleSyntheticChild,
  sortNameFilteredEntriesInChunks
} from './file-explorer-name-filter-tree-sort'

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
    const projection = createFileExplorerRowProjectionFromParts([], new Map())
    cacheFilteredProjection(cacheKey, projection)
    return projection
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
      showGitIgnoredFiles: args.showGitIgnoredFiles,
      rootPath: args.worktreePath
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
