import { ipcMain } from 'electron'
import { resolveSshQuickOpenDiscoveryOptions } from '../../providers/ssh-quick-open-discovery-options'
import { getSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import { listQuickOpenFiles } from '../filesystem-list-files'
import {
  isFileNameFilterQueryTooLarge,
  pathMatchesFileNameFilterTokens,
  splitFileNameFilterTokens
} from '../../../shared/file-name-filter-tokens'
import { QuickOpenPathRanker } from '../../../shared/quick-open-path-search'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { registerFilesystemContentSearchHandler } from './filesystem-content-search-handler'
import { registerFilesystemPathSearchHandler } from './filesystem-path-search-handler'
import { registerWorkspacePathIndexIpc } from './workspace-path-index-ipc'
import { isWorkspacePathIndexEnabled } from '../../workspace-path-index/workspace-path-index-feature-switch'
import { resolveAuthorizedPath } from '../filesystem-auth'
import { prewarmQuickOpenPathInventory } from '../quick-open-path-inventory'

// 32 visible matches plus one truncation sentinel stays below the legacy frame ceiling.
const QUICK_OPEN_SSH_LEGACY_RESULT_LIMIT = 33

export function registerFilesystemSearchHandlers(context: FilesystemHandlerContext): void {
  const pathIndexService = registerWorkspacePathIndexIpc(context)
  registerFilesystemContentSearchHandler(context)
  const { store } = context
  const { listFilesCancellations } = context
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
        candidatePaths?: string[]
        searchQuery?: string
        includeIgnored?: boolean
        allowLegacyIncludeIgnored?: boolean
        followSymlinks?: boolean
        /** Local only: keep paths containing every whitespace-separated word, like the Explorer filter. */
        nameFilter?: string
      }
    ): Promise<string[]> => {
      const controller = listFilesCancellations.begin(event, args.requestToken)
      try {
        if (args.connectionId) {
          const provider = getSshFilesystemProvider(args.connectionId)
          // Why: no provider (cold start / disconnected) → return [] so quick-open shows "No matching files" instead of an error.
          if (!provider) {
            return []
          }
          const discovery = await resolveSshQuickOpenDiscoveryOptions(
            provider,
            args,
            controller?.signal
          )
          if (
            args.candidatePaths !== undefined &&
            !(await provider.supportsQuickOpenSearch?.({
              signal: controller?.signal,
              minimumVersion: 3
            }))
          ) {
            throw new Error('Update the remote host to validate Quick Open recent files.')
          }
          // Why: forward excludePaths or nested linked worktrees get double-scanned over SSH, causing timeout-induced partial results.
          if (
            args.searchQuery !== undefined &&
            provider.supportsQuickOpenSearch &&
            !(await provider.supportsQuickOpenSearch({
              signal: controller?.signal,
              minimumVersion: 1
            }))
          ) {
            const legacyFiles = await provider.listFiles(args.rootPath, {
              excludePaths: args.excludePaths,
              ...discovery,
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
            candidatePaths: args.candidatePaths,
            excludePaths: args.excludePaths,
            ...discovery,
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
          // Why: warm the worker-owned catalog while the explorer lists, so the first name
          // filter is served from it instead of paying a cold build on the keystroke.
          void resolveAuthorizedPath(args.rootPath, store)
            .then((root) =>
              prewarmQuickOpenPathInventory(args.rootPath, store, {
                authorizedRootPath: root,
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
            : undefined,
          args
        )
      } finally {
        listFilesCancellations.finish(event, args.requestToken, controller)
      }
    }
  )

  ipcMain.handle('fs:cancelListFiles', (event, args: { requestToken: string }): void => {
    listFilesCancellations.cancel(event, args.requestToken)
    if (isWorkspacePathIndexEnabled()) {
      // Why: `fs:searchFilePaths` falls back to the sender id as the index consumer, so a
      // superseded filter's worker query is only stoppable by that id.
      pathIndexService.cancelLocalConsumer(String(event.sender.id))
    }
  })

  registerFilesystemPathSearchHandler(context, pathIndexService)
}
