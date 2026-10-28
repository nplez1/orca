import { ipcMain } from 'electron'
import { listQuickOpenFiles } from './filesystem-list-files'
import {
  isFileNameFilterQueryTooLarge,
  pathMatchesFileNameFilterTokens,
  splitFileNameFilterTokens
} from '../../../shared/file-name-filter-tokens'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { registerFilesystemContentSearchHandler } from './filesystem-content-search-handler'
import { registerFilesystemPathSearchHandler } from './filesystem-path-search-handler'
import { createFilesystemIndexRequestFences } from './filesystem-index-request-fences'
import { registerWorkspacePathIndexIpc } from './workspace-path-index-ipc'
import { isWorkspacePathIndexEnabled } from '../../workspace-path-index/workspace-path-index-feature-switch'
import { resolveAuthorizedPath } from './filesystem-auth'
import { prewarmQuickOpenPathInventory } from '../quick-open-path-inventory'

export function registerFilesystemSearchHandlers(context: FilesystemHandlerContext): void {
  const pathIndexService = registerWorkspacePathIndexIpc(context)
  const indexRequestFences = createFilesystemIndexRequestFences()
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
        // This process serves no SSH targets; preserve the disconnected empty-list contract.
        if (args.connectionId) {
          return []
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
      // Why: only a request still in flight under this token owns a worker query. A settled or
      // unknown token owns none, so a late cancel must not reach another consumer's query.
      const outstanding = indexRequestFences.liveRequest(event.sender.id, args.requestToken)
      if (outstanding) {
        // A renderer-named consumer owns its own worker query; a request that named none is the
        // sender-keyed one this handler submits as `local:<pid>:<senderId>`.
        pathIndexService.cancelLocalConsumer(outstanding.consumerId ?? String(event.sender.id))
      }
    }
  })

  registerFilesystemPathSearchHandler(context, pathIndexService, indexRequestFences)
}
