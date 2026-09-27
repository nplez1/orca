import type { FilePathSearchResult } from './file-path-search-result'
import {
  WORKSPACE_PATH_SEARCH_ROW_FLAGS,
  type WorkspacePathSearchResponse
} from './workspace-path-search-contract'

export function toFilePathSearchResult(
  response: WorkspacePathSearchResponse
): FilePathSearchResult {
  const exactCount =
    response.state.coverage === 'complete' &&
    response.state.freshness === 'no-known-gap' &&
    response.state.countProvenance === 'exact-snapshot' &&
    response.count.provenance === 'exact-snapshot'
      ? response.count.value
      : null
  const classificationsKnown = response.rowClassificationFlags.every(
    (flags) => (flags & WORKSPACE_PATH_SEARCH_ROW_FLAGS.ignoreClassificationKnown) !== 0
  )
  return {
    files: response.rows.map((row) => row.relativePath),
    totalCount: exactCount,
    truncated: exactCount === null || response.retainedCount < exactCount,
    ...(classificationsKnown
      ? {
          ignoredFiles: response.rows
            .filter(
              (_row, index) =>
                (response.rowClassificationFlags[index] ?? 0) &
                WORKSPACE_PATH_SEARCH_ROW_FLAGS.ignored
            )
            .map((row) => row.relativePath)
        }
      : {}),
    workspacePathSearch: response
  }
}
