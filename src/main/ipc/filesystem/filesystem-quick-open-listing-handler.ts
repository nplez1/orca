import { ipcMain } from 'electron'
import { WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES } from '../../../shared/__fixtures__/workspace-path-memory-measurement'
import { QuickOpenPathRanker } from '../../../shared/quick-open-path-search'
import { resolveAuthorizedPath } from '../filesystem-auth'
import { listQuickOpenFiles } from '../filesystem-list-files'
import { getSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import {
  isFileNameFilterQueryTooLarge,
  pathMatchesFileNameFilterTokens,
  splitFileNameFilterTokens
} from '../../../shared/file-name-filter-tokens'
import { workspacePathCatalogFoldCacheKey } from '../../../shared/workspace-path-catalog'
import { WORKSPACE_PATH_INDEX_LISTING_POLICY_VERSION } from '../../workspace-path-index/workspace-path-index-runtime'
import type { WorkspacePathIndexService } from '../../workspace-path-index/workspace-path-index-service'
import { isWorkspacePathIndexEnabled } from '../../workspace-path-index/workspace-path-index-feature-switch'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

const QUICK_OPEN_SSH_LEGACY_RESULT_LIMIT = 33

/** Registers the bounded browse path and Quick Open view warming. */
export function registerFilesystemQuickOpenListingHandler(
  context: FilesystemHandlerContext,
  pathIndexService: WorkspacePathIndexService
): void {
  const { store, listFilesCancellations } = context
  ipcMain.handle(
    'fs:listFiles',
    async (
      event,
      args: {
        rootPath: string
        connectionId?: string
        excludePaths?: string[]
        requestToken?: string
        maxResults?: number
        searchQuery?: string
        /** Local only: keep paths containing every whitespace-separated word, like the Explorer filter. */
        nameFilter?: string
      }
    ): Promise<string[]> => {
      const controller = listFilesCancellations.begin(event, args.requestToken)
      try {
        if (args.connectionId) {
          const provider = getSshFilesystemProvider(args.connectionId)
          if (!provider) {
            return []
          }
          if (
            args.searchQuery !== undefined &&
            provider.supportsQuickOpenSearch &&
            !(await provider.supportsQuickOpenSearch({ signal: controller?.signal }))
          ) {
            const legacyFiles = await provider.listFiles(args.rootPath, {
              excludePaths: args.excludePaths,
              maxResults: QUICK_OPEN_SSH_LEGACY_RESULT_LIMIT,
              signal: controller?.signal
            })
            const ranker = new QuickOpenPathRanker(
              args.searchQuery,
              args.maxResults ?? QUICK_OPEN_SSH_LEGACY_RESULT_LIMIT
            )
            for (const file of legacyFiles) {
              ranker.consider(file)
            }
            return ranker.result().paths
          }
          return await provider.listFiles(args.rootPath, {
            excludePaths: args.excludePaths,
            ...(args.maxResults === undefined ? {} : { maxResults: args.maxResults }),
            ...(args.searchQuery === undefined ? {} : { searchQuery: args.searchQuery }),
            signal: controller?.signal
          })
        }
        if (args.nameFilter !== undefined && isFileNameFilterQueryTooLarge(args.nameFilter)) {
          return []
        }
        const nameFilterTokens = args.nameFilter ? splitFileNameFilterTokens(args.nameFilter) : []
        if (isWorkspacePathIndexEnabled()) {
          void resolveAuthorizedPath(args.rootPath, store)
            .then((root) =>
              pathIndexService.ensure({
                owner: {
                  executionHost: { provider: 'local', incarnationId: String(process.pid) },
                  authorizedCanonicalRoot: root
                },
                listingPolicyVersion: WORKSPACE_PATH_INDEX_LISTING_POLICY_VERSION,
                foldVersion: workspacePathCatalogFoldCacheKey(),
                buildReservationBytes: WORKSPACE_PATH_INDEX_ROOT_MEMORY_BUDGET_BYTES,
                firstScope: 'included',
                activeWorkspace: true,
                correlationId: `list-${event.sender.id}`
              })
            )
            .catch(() => undefined)
        }
        return await listQuickOpenFiles(
          args.rootPath,
          store,
          args.excludePaths,
          controller?.signal,
          args.maxResults,
          undefined,
          nameFilterTokens.length > 0
            ? (relativePath) => pathMatchesFileNameFilterTokens(relativePath, nameFilterTokens)
            : undefined
        )
      } finally {
        listFilesCancellations.finish(event, args.requestToken, controller)
      }
    }
  )

  ipcMain.handle('fs:cancelListFiles', (event, args: { requestToken: string }): void => {
    listFilesCancellations.cancel(event, args.requestToken)
    if (isWorkspacePathIndexEnabled()) {
      pathIndexService.cancelLocalConsumer(String(event.sender.id))
    }
  })
}
