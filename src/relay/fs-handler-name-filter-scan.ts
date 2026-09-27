// Why from the utils barrel: that is the seam relay tests substitute, so this path stays hermetic.
import { listFilesWithRg } from './fs-handler-utils'
import type { WorkspacePathSearchFenceIdentity } from '../shared/workspace-path-search-contract'

export async function searchNameFilterPathsWithRg(
  rootPath: string,
  identity: WorkspacePathSearchFenceIdentity,
  signal?: AbortSignal
): Promise<{ paths: string[]; totalCount: number; complete: boolean }> {
  const excludePathPrefixes = identity.scope.excludePathSegments.map((segments) => {
    if (
      segments.length === 0 ||
      segments.some(
        (segment) => !segment || segment === '.' || segment === '..' || /[\\/]/.test(segment)
      )
    ) {
      throw new Error('Workspace path search exclusions must contain normalized path segments')
    }
    return segments.join('/')
  })
  let result: { paths: string[]; totalCount: number; complete: boolean } | null = null
  await listFilesWithRg(rootPath, excludePathPrefixes, {
    signal,
    maxResults: identity.pageBudget.maxPaths,
    searchQuery: identity.query,
    searchMode: 'name-filter',
    includeIgnoredFiles: identity.scope.includeIgnoredFiles,
    includeDotfiles: identity.scope.includeDotfiles,
    onSearchResult: (searchResult, complete) => {
      result = { ...searchResult, complete }
    }
  })
  if (result === null) {
    throw new Error('Workspace path search completed without a count')
  }
  return result
}
