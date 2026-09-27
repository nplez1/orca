import { useEffect, useRef } from 'react'
import { isDotfileRelativePath } from './file-explorer-entries'
import type { DirCache, TreeNode } from './file-explorer-types'
import {
  createFileExplorerRowProjectionFromParts,
  type FileExplorerRowProjection
} from './file-explorer-row-projection'
import { isPathIgnored } from './status-display'
import {
  createNameFilteredFileExplorerProjection,
  type FileExplorerNameFilterProjectionSource
} from './file-explorer-name-filter-projection'

export type VisibleFileExplorerRowProjectionOptions = {
  ignoredSet: Set<string>
  nameFilter?: FileExplorerNameFilterProjectionSource | null
  nameFilterCollapsedPaths?: ReadonlySet<string> | null
  showDotfiles: boolean
  showGitIgnoredFiles: boolean
}

export type VisibleFileExplorerRowProjectionInput = {
  dirCache: Record<string, DirCache>
  expanded: Set<string>
  worktreePath: string | null
  displayRootPath?: string | null
}

/** Collects worktree-relative paths beneath the displayed root, respecting expanded folders and dotfile visibility. */
export function getFileExplorerIgnoredQueryRelativePaths(
  input: VisibleFileExplorerRowProjectionInput,
  showDotfiles: boolean
): string[] {
  const { dirCache, expanded, worktreePath, displayRootPath = worktreePath } = input
  if (!worktreePath) {
    return []
  }

  const relativePaths: string[] = []
  const visitChildren = (parentPath: string): void => {
    const cached = dirCache[parentPath]
    if (!cached?.children) {
      return
    }
    for (const row of cached.children) {
      if (!showDotfiles && isDotfileRelativePath(row.relativePath)) {
        continue
      }
      relativePaths.push(row.relativePath)
      if (row.isDirectory && expanded.has(row.path)) {
        visitChildren(row.path)
      }
    }
  }
  if (displayRootPath) {
    visitChildren(displayRootPath)
  }
  return relativePaths
}

/** Projects the displayed subtree without rebasing row paths, including when filename filtering synthesizes nodes. */
export function createVisibleFileExplorerRowProjection(
  input: VisibleFileExplorerRowProjectionInput,
  options: VisibleFileExplorerRowProjectionOptions
): FileExplorerRowProjection {
  const { dirCache, expanded, worktreePath, displayRootPath = worktreePath } = input
  const visibleFlatRows: TreeNode[] = []
  const rowsByPath = new Map<string, TreeNode>()
  if (!worktreePath) {
    return createFileExplorerRowProjectionFromParts(visibleFlatRows, rowsByPath)
  }
  if (options.nameFilter) {
    return createNameFilteredFileExplorerProjection({
      collapsedPaths: options.nameFilterCollapsedPaths ?? undefined,
      ignoredSet: options.ignoredSet,
      nameFilter: options.nameFilter,
      showDotfiles: options.showDotfiles,
      showGitIgnoredFiles: options.showGitIgnoredFiles,
      worktreePath,
      displayRootPath: displayRootPath ?? worktreePath
    })
  }

  const shouldHideRow = (row: TreeNode): boolean => {
    if (!options.showDotfiles && isDotfileRelativePath(row.relativePath)) {
      return true
    }
    return !options.showGitIgnoredFiles && isPathIgnored(options.ignoredSet, row.relativePath)
  }

  const visitChildren = (parentPath: string): void => {
    const cached = dirCache[parentPath]
    if (!cached?.children) {
      return
    }
    for (const row of cached.children) {
      if (shouldHideRow(row)) {
        continue
      }
      visibleFlatRows.push(row)
      rowsByPath.set(row.path, row)
      if (row.isDirectory && expanded.has(row.path)) {
        visitChildren(row.path)
      }
    }
  }
  if (displayRootPath) {
    visitChildren(displayRootPath)
  }

  return createFileExplorerRowProjectionFromParts(visibleFlatRows, rowsByPath)
}

function relativePathListsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

/**
 * Holds the array identity while its contents are unchanged.
 *
 * Why: a tree refresh commits dirCache once per read wave, and every commit
 * rebuilds this list. Each new identity would re-issue the uncancellable git
 * check-ignore over the whole visible tree — the remote round trips the wave cap
 * exists to bound.
 */
export function useContentStableRelativePaths(relativePaths: string[], enabled: boolean): string[] {
  // Why: filters need fresh identities per keystroke and must not evict the tree signature.
  const prevRef = useRef<string[] | null>(null)
  const prev = prevRef.current
  // Why publish `stable`, not `relativePaths`: the ref must hold what this hook actually
  // returned. Publishing the input instead leaves the ref one commit behind, so a wave of
  // content-equal arrays flips identity on every render — the churn this hook exists to stop.
  const stable =
    enabled && prev && relativePathListsEqual(prev, relativePaths) ? prev : relativePaths
  // Why write-in-effect: render must stay pure (react-doctor); the first commit of a new
  // list loses stability, never staleness.
  useEffect(() => {
    prevRef.current = stable
  }, [stable])
  return stable
}
