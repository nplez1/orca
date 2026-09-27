import React from 'react'
import type { WorkspacePathSearchResponse } from '../../../../shared/workspace-path-search-contract'
import { translate } from '@/i18n/i18n'

/** Why: bounded or provisional pages must not read as complete workspace answers. */
export function FileExplorerNameFilterTruncationNotice({
  shownCount,
  totalCount,
  truncated = false,
  workspacePathSearch,
  isUpdating = false,
  isIndexing = false,
  isSearching = false,
  hasError = false,
  hasProjectionError = false
}: {
  shownCount: number
  totalCount: number | null
  truncated?: boolean
  workspacePathSearch?: WorkspacePathSearchResponse
  isUpdating?: boolean
  isIndexing?: boolean
  isSearching?: boolean
  hasError?: boolean
  hasProjectionError?: boolean
}): React.JSX.Element | null {
  const state = workspacePathSearch?.state
  const isExactComplete =
    state?.coverage === 'complete' &&
    state.freshness === 'no-known-gap' &&
    state.countProvenance === 'exact-snapshot' &&
    workspacePathSearch?.count.provenance === 'exact-snapshot'
  const hasPartialCoverage = Boolean(
    state &&
    (state.coverage !== 'complete' ||
      state.freshness !== 'no-known-gap' ||
      state.countProvenance !== 'exact-snapshot')
  )
  const isStructuredIndexing =
    workspacePathSearch?.degradationReason === 'missing' ||
    workspacePathSearch?.degradationReason === 'building'

  if (hasError || state?.freshness === 'failed' || state?.freshness === 'disconnected') {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        {hasProjectionError
          ? translate(
              'auto.components.right.sidebar.FileExplorerNameFilter.projectionBudget',
              'The filtered file list is too large to display — add more of the name to narrow it down'
            )
          : translate(
              'auto.components.right.sidebar.FileExplorerNameFilter.updateFailed',
              'File search is unavailable — showing previous results when available'
            )}
      </p>
    )
  }
  if (isUpdating || state?.freshness === 'dirty' || state?.freshness === 'reconciling') {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        {translate(
          'auto.components.right.sidebar.FileExplorerNameFilter.updating',
          'Updating file list'
        )}
      </p>
    )
  }
  if ((isIndexing || isStructuredIndexing) && !isExactComplete) {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        {translate(
          'auto.components.right.sidebar.FileExplorerNameFilter.indexing',
          'Indexing files…'
        )}
      </p>
    )
  }
  if (isSearching) {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        {translate(
          'auto.components.right.sidebar.FileExplorerNameFilter.searching',
          'Searching files…'
        )}
      </p>
    )
  }
  if (totalCount === null && (truncated || !workspacePathSearch)) {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        {translate(
          'auto.components.right.sidebar.FileExplorer.filterScannedPartialWorkspace',
          'Only part of this workspace was searched — add more of the name to narrow it down'
        )}
      </p>
    )
  }
  if (hasPartialCoverage || (workspacePathSearch && !isExactComplete)) {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        {translate(
          'auto.components.right.sidebar.FileExplorer.filterScannedPartialWorkspace',
          'Only part of this workspace was searched — add more of the name to narrow it down'
        )}
      </p>
    )
  }
  if (totalCount === null || (isExactComplete && totalCount <= shownCount)) {
    // Why: the live-scan fallback already produced a complete, exact page. The index still
    // warming up is not a reason to label the finished scan as still indexing.
    if (isExactComplete && (isIndexing || isStructuredIndexing)) {
      return (
        <p className="text-xs text-muted-foreground" role="status">
          {translate(
            'auto.components.right.sidebar.FileExplorerNameFilter.liveScanComplete',
            'Complete results from a full scan — the file index is still building'
          )}
        </p>
      )
    }
    return null
  }

  return (
    <p className="text-xs text-muted-foreground" role="status">
      {translate(
        'auto.components.right.sidebar.FileExplorer.filterShowingFirstMatches',
        'Showing the first {{value0}} of {{value1}} matches — add more of the name to narrow it down',
        { value0: shownCount.toLocaleString(), value1: totalCount.toLocaleString() }
      )}
    </p>
  )
}
