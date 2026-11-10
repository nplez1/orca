import { useCallback, useLayoutEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/index'
import type { DirCache } from './file-explorer-types'
import {
  createFileExplorerRowProjectionFromParts,
  type FileExplorerRowProjection
} from './file-explorer-row-projection'
import { buildIgnoredSet } from '../../../../lib/git-path-decoration'
import {
  getFileExplorerNameFilterExpandedPaths,
  getFileExplorerNameFilterIgnoredQueryRelativePaths,
  type FileExplorerNameFilterProjectionSource
} from './file-explorer-name-filter-projection'
import {
  createVisibleFileExplorerRowProjection,
  getFileExplorerIgnoredQueryRelativePaths,
  useContentStableRelativePaths
} from '../../file-explorer-visible-row-projection-build'
import { useFileExplorerIgnoredPaths } from './use-file-explorer-ignored-paths'
import { useFileExplorerChunkedProjection } from '../../use-file-explorer-chunked-projection'
import { recordRendererPathSearchCommit } from '../../file-explorer-name-filter-timing'

export {
  createVisibleFileExplorerRowProjection,
  getFileExplorerIgnoredQueryRelativePaths
} from '../../file-explorer-visible-row-projection-build'

const EMPTY_RELATIVE_PATHS: string[] = []
const EMPTY_FILTERED_PROJECTION = createFileExplorerRowProjectionFromParts([], new Map())

/** Combines scoped rows with host-aware ignore checks while retaining worktree-relative Git query paths. */
export function useFileExplorerVisibleRowProjection(
  activeWorktreeId: string | null,
  worktreePath: string | null,
  dirCache: Record<string, DirCache>,
  expanded: Set<string>,
  activeRepoSupportsGit: boolean,
  showDotfiles: boolean,
  nameFilter: FileExplorerNameFilterProjectionSource | null,
  nameFilterCollapsedPaths: ReadonlySet<string> | null = null,
  displayRootPath: string | null = worktreePath
): {
  rowProjection: FileExplorerRowProjection
  projectionPending: boolean
  projectionError: 'budget' | 'failed' | null
  ignoredByRelativePath: Set<string>
  showGitIgnoredFiles: boolean
  nameFilterExpandedPaths: Set<string>
  toggleGitIgnoredFiles: () => void
} {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const showGitIgnoredFiles = settings?.showGitIgnoredFiles ?? true
  // Why: when the host already classified the filtered page, re-asking git would launch an
  // uncancellable check-ignore over up to 5000 paths on every keystroke for a cosmetic dim.
  const hostIgnoredPaths = nameFilter?.ignoredRelativePaths
  const hostProvidesIgnoredPaths = nameFilter != null && hostIgnoredPaths !== undefined
  const rebuiltRelativePaths = useMemo(
    () =>
      !activeRepoSupportsGit || hostProvidesIgnoredPaths
        ? EMPTY_RELATIVE_PATHS
        : nameFilter
          ? getFileExplorerNameFilterIgnoredQueryRelativePaths(
              nameFilter,
              showDotfiles,
              worktreePath
            )
          : getFileExplorerIgnoredQueryRelativePaths(
              { dirCache, expanded, worktreePath, displayRootPath },
              showDotfiles
            ),
    [
      activeRepoSupportsGit,
      dirCache,
      expanded,
      hostProvidesIgnoredPaths,
      nameFilter,
      showDotfiles,
      worktreePath,
      displayRootPath
    ]
  )
  // Why: filtered pages change per query; only browse-cache paths need wave stability.
  const relativePaths = useContentStableRelativePaths(rebuiltRelativePaths, !nameFilter)
  const canLoadIgnoredPaths =
    activeRepoSupportsGit &&
    Boolean(activeWorktreeId) &&
    Boolean(worktreePath) &&
    relativePaths.length > 0
  const shouldDebounceIgnoredQuery = nameFilter !== null
  const effectiveIgnoredPaths = useFileExplorerIgnoredPaths({
    activeWorktreeId,
    canLoadIgnoredPaths,
    relativePaths,
    shouldDebounceIgnoredQuery,
    worktreePath
  })
  const ignoredSet = useMemo(
    () =>
      buildIgnoredSet(
        hostProvidesIgnoredPaths && hostIgnoredPaths ? hostIgnoredPaths : effectiveIgnoredPaths,
        worktreePath
      ),
    [effectiveIgnoredPaths, hostIgnoredPaths, hostProvidesIgnoredPaths, worktreePath]
  )
  const projectionArgs = useMemo(
    () =>
      nameFilter && worktreePath
        ? {
            collapsedPaths: nameFilterCollapsedPaths ?? undefined,
            ignoredSet,
            nameFilter,
            showDotfiles,
            showGitIgnoredFiles,
            worktreePath,
            displayRootPath: displayRootPath ?? worktreePath
          }
        : null,
    [
      ignoredSet,
      nameFilter,
      nameFilterCollapsedPaths,
      showDotfiles,
      showGitIgnoredFiles,
      worktreePath,
      displayRootPath
    ]
  )
  const projectionContextKey = JSON.stringify({
    owner: nameFilter?.operationOwner,
    scope: nameFilter?.scopeIdentity,
    root: worktreePath,
    showDotfiles,
    showGitIgnoredFiles
  })
  const {
    filteredProjection,
    projectionPending,
    projectionError: currentProjectionError
  } = useFileExplorerChunkedProjection({ nameFilter, projectionArgs, projectionContextKey })
  const ordinaryProjection = useMemo(
    () =>
      nameFilter
        ? EMPTY_FILTERED_PROJECTION
        : createVisibleFileExplorerRowProjection(
            { dirCache, expanded, worktreePath, displayRootPath },
            {
              ignoredSet,
              showDotfiles,
              showGitIgnoredFiles
            }
          ),
    [
      dirCache,
      expanded,
      ignoredSet,
      nameFilter,
      showDotfiles,
      showGitIgnoredFiles,
      worktreePath,
      displayRootPath
    ]
  )
  // Why state adjusted during render, not a ref: React Compiler rejects render-phase ref reads,
  // and holding the last non-null projection is exactly a render-phase update.
  const [lastFilteredProjection, setLastFilteredProjection] = useState<{
    contextKey: string
    projection: FileExplorerRowProjection
  } | null>(null)
  if (!nameFilter && lastFilteredProjection !== null) {
    setLastFilteredProjection(null)
  } else if (
    nameFilter &&
    filteredProjection &&
    (lastFilteredProjection?.contextKey !== projectionContextKey ||
      lastFilteredProjection.projection !== filteredProjection)
  ) {
    setLastFilteredProjection({ contextKey: projectionContextKey, projection: filteredProjection })
  }
  const previousFilteredProjection =
    lastFilteredProjection?.contextKey === projectionContextKey
      ? lastFilteredProjection.projection
      : null
  const rowProjection = nameFilter
    ? (filteredProjection ?? previousFilteredProjection ?? EMPTY_FILTERED_PROJECTION)
    : ordinaryProjection
  useLayoutEffect(() => {
    if (
      nameFilter?.correlationId &&
      !nameFilter.previousResults &&
      !nameFilter.searching &&
      !projectionPending
    ) {
      recordRendererPathSearchCommit(nameFilter.correlationId)
    }
  }, [
    filteredProjection,
    projectionContextKey,
    nameFilter?.correlationId,
    nameFilter?.previousResults,
    nameFilter?.searching,
    projectionPending
  ])
  const nameFilterExpandedPaths = useMemo(
    () => getFileExplorerNameFilterExpandedPaths(rowProjection, nameFilter?.query ?? ''),
    [nameFilter?.query, rowProjection]
  )
  const ignoredByRelativePath = useMemo(
    () => (showGitIgnoredFiles ? ignoredSet : new Set<string>()),
    [ignoredSet, showGitIgnoredFiles]
  )
  const toggleGitIgnoredFiles = useCallback(() => {
    void updateSettings({ showGitIgnoredFiles: !showGitIgnoredFiles })
  }, [showGitIgnoredFiles, updateSettings])

  return {
    rowProjection,
    projectionPending,
    projectionError: currentProjectionError,
    ignoredByRelativePath,
    showGitIgnoredFiles,
    nameFilterExpandedPaths,
    toggleGitIgnoredFiles
  }
}
