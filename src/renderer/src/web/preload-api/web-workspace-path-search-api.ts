import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import type { WorkspacePathSearchApi } from '../../../../preload/api/workspace-path-search-api-types'
import { callRuntimeResult } from './web-runtime-calls'
import { resolveRuntimeFilePath } from './web-runtime-worktree-catalog'
import { searchWebWorkspaceNameFilter } from './web-workspace-path-search'

// A web client's searches are host round-trips with no host-side cancellation, so the fork aborts them.
const workspacePathSearchControllers = new Map<string, AbortController>()

export function cancelWebWorkspacePathSearch(requestToken: string): void {
  workspacePathSearchControllers.get(requestToken)?.abort()
  workspacePathSearchControllers.delete(requestToken)
}

/** A paired web client only has remote files, so path search always goes to the host. */
export const webWorkspacePathSearchApi: WorkspacePathSearchApi = {
  acquireQuickOpenPathInventoryLease: async () => ({ leaseId: null }),
  releaseQuickOpenPathInventoryLease: async () => {},
  exportWorkspacePathSearchInstrumentation: async () => [],
  getWorkspacePathSearchDiagnosticsSummary: async () => ({
    queriesServed: 0,
    strategies: {
      'ordered-scan': 0,
      'trigram-postings': 0,
      'matching-id-bitset': 0,
      'disk-block-scan': 0,
      'live-scan': 0,
      'legacy-search': 0
    },
    cacheMissReasons: {},
    fallbackReasons: {},
    admissionRefusals: 0,
    freshnessDowngrades: 0
  }),
  searchFilePaths: async ({
    rootPath,
    query,
    limit,
    excludePaths,
    mode,
    includeIgnoredFiles,
    includeDotfiles,
    correlationId,
    requestToken
  }) => {
    const file = await resolveRuntimeFilePath(rootPath)
    if (mode === 'name-filter') {
      const controller = new AbortController()
      if (requestToken) {
        workspacePathSearchControllers.set(requestToken, controller)
      }
      try {
        return await searchWebWorkspaceNameFilter({
          worktree: { id: file.worktree.id, path: file.worktree.path },
          query,
          limit: limit ?? 32,
          excludePaths,
          includeIgnoredFiles,
          includeDotfiles,
          correlationId,
          signal: controller.signal
        })
      } finally {
        if (requestToken && workspacePathSearchControllers.get(requestToken) === controller) {
          workspacePathSearchControllers.delete(requestToken)
        }
      }
    }
    const result = await callRuntimeResult<{
      files: { relativePath: string }[]
      totalCount: number
      truncated: boolean
    }>('files.searchPaths', {
      worktree: toRuntimeWorktreeSelector(file.worktree.id),
      query,
      limit,
      excludePaths,
      mode
    })
    return {
      files: result.files.map((entry) => entry.relativePath),
      totalCount: result.totalCount ?? null,
      truncated: result.truncated
    }
  }
}
