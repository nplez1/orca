import { normalizeRelativePath } from '@/lib/path'
import {
  FILE_NAME_FILTER_QUERY_MAX_BYTES,
  isFileNameFilterQueryTooLarge,
  pathMatchesFileNameFilterTokens,
  splitFileNameFilterTokens
} from '../../../../shared/file-name-filter-tokens'
import type { WorkspacePathSearchResponse } from '../../../../shared/workspace-path-search-contract'
import type { WorkspacePathSearchCorrelationId } from '../../../../shared/workspace-path-search-instrumentation'
import type { FileExplorerOperationOwner } from './file-explorer-types'
import { isDotfileRelativePath } from './file-explorer-entries'

export type FileExplorerNameFilterProjectionSource = {
  query: string
  relativePaths: readonly string[] | null
  operationOwner?: FileExplorerOperationOwner
  /** Exact matches the host scanned; null when the listing was not query-scoped. */
  totalCount?: number | null
  /** True when the page is not the whole result set. */
  truncated?: boolean
  /**
   * Subset of `relativePaths` the host already classified as gitignored. When present the pane
   * must not re-ask git: a per-keystroke check-ignore over the matched page is otherwise paid
   * for a purely cosmetic dim.
   */
  ignoredRelativePaths?: readonly string[]
  workspacePathSearch?: WorkspacePathSearchResponse
  correlationId?: WorkspacePathSearchCorrelationId
  scopeIdentity?: string
  previousResults?: boolean
  searching?: boolean
  loadError?: string | null
}

/**
 * Which message an empty filtered pane may show. A truncated listing never scanned the whole
 * workspace, so "no files match" is a claim we cannot make — only "not fully searched" is true.
 * When the snapshot's coverage is complete the honest reason is the freshness gap, not a scan gap.
 */
export function getFileExplorerNameFilterEmptyMessageKind({
  hasNameFilter,
  hasLoadError,
  truncated,
  previousResults = false,
  searching = false,
  workspacePathSearch
}: {
  hasNameFilter: boolean
  hasLoadError: boolean
  truncated: boolean
  previousResults?: boolean
  searching?: boolean
  workspacePathSearch?: WorkspacePathSearchResponse
}): 'no-match' | 'partial-scan' | 'stale' | null {
  if (!hasNameFilter || hasLoadError || previousResults || searching) {
    return null
  }
  if (workspacePathSearch) {
    const { state, count } = workspacePathSearch
    if (
      state.coverage === 'complete' &&
      state.freshness === 'no-known-gap' &&
      state.countProvenance === 'exact-snapshot' &&
      count.provenance === 'exact-snapshot'
    ) {
      return 'no-match'
    }
    // Why: coverage is complete for the snapshot, so the only gap is freshness — "only part was
    // searched" would name the wrong reason.
    if (state.coverage === 'complete' && state.freshness !== 'no-known-gap') {
      return 'stale'
    }
    return 'partial-scan'
  }
  return truncated ? 'partial-scan' : 'no-match'
}

export const FILE_EXPLORER_NAME_FILTER_QUERY_MAX_BYTES = FILE_NAME_FILTER_QUERY_MAX_BYTES

/**
 * Bounded page the name filter keeps. Filters are usually narrow; when one is broad the host
 * still counts every match, and the pane reports the count instead of implying completeness.
 */
export const FILE_EXPLORER_NAME_FILTER_MAX_RESULTS = 5_000

export function getNextNameFilterCollapsedPaths(
  collapsedPaths: ReadonlySet<string>,
  dirPath: string,
  isExpanded: boolean
): Set<string> {
  const next = new Set(collapsedPaths)
  if (isExpanded) {
    next.add(dirPath)
  } else {
    next.delete(dirPath)
  }
  return next
}

export function getNameFilterCollapsedPathsAfterExpand(
  collapsedPaths: ReadonlySet<string>,
  dirPath: string
): Set<string> {
  if (!collapsedPaths.has(dirPath)) {
    return new Set(collapsedPaths)
  }
  const next = new Set(collapsedPaths)
  next.delete(dirPath)
  return next
}

export function isFileExplorerNameFilterQueryTooLarge(
  query: string | undefined,
  maxBytes = FILE_EXPLORER_NAME_FILTER_QUERY_MAX_BYTES
): boolean {
  const value = query ?? ''
  return isFileNameFilterQueryTooLarge(value, maxBytes)
}

export function getFileExplorerNameFilterTokens(query: string | undefined): string[] {
  if (isFileExplorerNameFilterQueryTooLarge(query)) {
    return []
  }
  return splitFileNameFilterTokens(query ?? '')
}

export function getFileExplorerNameFilterIgnoredQueryRelativePaths(
  source: FileExplorerNameFilterProjectionSource,
  showDotfiles: boolean
): string[] {
  if (isFileExplorerNameFilterQueryTooLarge(source.query)) {
    return []
  }
  if (source.relativePaths === null) {
    return []
  }
  const tokens = getFileExplorerNameFilterTokens(source.query)
  return source.relativePaths
    .map((relativePath) => normalizeRelativePath(relativePath))
    .filter(
      (relativePath) =>
        Boolean(relativePath) &&
        (showDotfiles || !isDotfileRelativePath(relativePath)) &&
        pathMatchesFileNameFilterTokens(relativePath, tokens)
    )
}
