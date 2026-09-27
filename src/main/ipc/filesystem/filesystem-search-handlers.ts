import { ipcMain } from 'electron'
import { getSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import { listQuickOpenFiles } from '../filesystem-list-files'
import {
  isFileNameFilterQueryTooLarge,
  pathMatchesFileNameFilterTokens,
  splitFileNameFilterTokens
} from '../../../shared/file-name-filter-tokens'
import { QuickOpenPathRanker, type PathSearchMode } from '../../../shared/quick-open-path-search'
import { resolveQuickOpenResultLimit } from '../../../shared/quick-open-listing-limits'
import type { FilePathSearchResult } from '../../../shared/file-path-search-result'
import { searchQuickOpenFilePaths } from '../filesystem-search-file-paths'
import {
  prewarmQuickOpenPathInventory,
  queryQuickOpenPathInventory
} from '../quick-open-path-inventory'
import { handleFilesystemTextSearch } from './filesystem-text-search-handler'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

// 32 visible matches plus one truncation sentinel stays below the legacy frame ceiling.
const QUICK_OPEN_SSH_LEGACY_RESULT_LIMIT = 33

export function registerFilesystemSearchHandlers(context: FilesystemHandlerContext): void {
  const { store } = context

  ipcMain.handle('fs:search', (event, args) => handleFilesystemTextSearch(event, args, context))

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
        searchQuery?: string
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
          // Why: forward excludePaths or nested linked worktrees get double-scanned over SSH, causing timeout-induced partial results.
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
        // Why: the pane's first unscoped listing is the earliest signal that this workspace's
        // Files view is open, so warm the filter index before the user types a name filter.
        prewarmQuickOpenPathInventory(args.rootPath, store)
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
  })

  // Why: a local query-scoped path search, so a filtered pane is not limited to the first
  // page of an unscoped listing. Remote hosts get their totals through `files.searchPaths`.
  ipcMain.handle(
    'fs:searchFilePaths',
    async (
      event,
      args: {
        rootPath: string
        excludePaths?: string[]
        requestToken?: string
        query: string
        limit?: number
        mode?: PathSearchMode
        includeIgnoredFiles?: boolean
      }
    ): Promise<FilePathSearchResult> => {
      const controller = listFilesCancellations.begin(event, args.requestToken)
      const limit = resolveQuickOpenResultLimit(args.limit)
      try {
        // Why: a name filter only needs the path list, so answer from the warm inventory when
        // the workspace has one — a per-keystroke walk is the entire cost this avoids.
        const inventoryMatch =
          args.mode === 'name-filter'
            ? await queryQuickOpenPathInventory(args.rootPath, store, {
                query: args.query,
                limit,
                excludePaths: args.excludePaths,
                includeIgnoredFiles: args.includeIgnoredFiles ?? true
              })
            : null
        if (inventoryMatch) {
          return {
            files: inventoryMatch.paths,
            totalCount: inventoryMatch.totalCount,
            truncated: inventoryMatch.truncated,
            ignoredFiles: inventoryMatch.ignoredPaths
          }
        }
        const result = await searchQuickOpenFilePaths(args.rootPath, store, {
          query: args.query,
          limit,
          mode: args.mode,
          excludePaths: args.excludePaths,
          includeIgnoredFiles: args.includeIgnoredFiles,
          signal: controller?.signal
        })
        return {
          files: result.paths,
          totalCount: result.totalCount,
          truncated: result.truncated
        }
      } finally {
        listFilesCancellations.finish(event, args.requestToken, controller)
      }
    }
  )
}
