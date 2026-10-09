import { callAbortableRuntimeEnvironment } from '../../runtime/abortable-runtime-environment-call'
import { unwrapRuntimeRpcResult } from '../../runtime/runtime-rpc-result'
import type { PreloadApi } from '../../../../preload/api-types'
import type { SearchResult } from '../../../../shared/code-search-types'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { createWebFileMutationMethods } from '../web-file-mutation-methods'
import { captureWebFileMutationSession } from './web-file-mutation-session'
import { callRuntimeResult } from './web-runtime-calls'
import { isMissingPathError, resolveRuntimeFilePath } from './web-runtime-worktree-catalog'
import { requireActiveEnvironment } from './web-runtime-session'
import { noopUnsubscribe } from './web-storage'
import { searchWebWorkspaceNameFilter } from './web-workspace-path-search'

const workspacePathSearchControllers = new Map<string, AbortController>()

export function createFileApi(): NonNullable<Partial<PreloadApi>['fs']> {
  const searches = new Map<string, AbortController>()
  return {
    prepareDroppedPaths: async () => {
      throw new Error('Preparing dropped file paths is not supported in the web client')
    },
    readFileChunk: async ({ filePath, offset, length }) => {
      const file = await resolveRuntimeFilePath(filePath)
      return callRuntimeResult('files.readChunk', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath,
        offset,
        length
      })
    },
    readDir: async ({ dirPath }) => {
      const file = await resolveRuntimeFilePath(dirPath)
      return callRuntimeResult<DirEntry[]>('files.readDir', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath
      })
    },
    readFile: async ({ filePath }) => {
      const file = await resolveRuntimeFilePath(filePath)
      return callRuntimeResult('files.readPreview', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath
      })
    },
    readLocalLogTail: async () => {
      throw new Error('Local log tailing is unavailable in paired web clients.')
    },
    startLocalLogTail: async () => {
      throw new Error('Local log tailing is unavailable in paired web clients.')
    },
    stopLocalLogTail: async () => {},
    onLocalLogTailChanged: () => noopUnsubscribe,
    downloadFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    downloadFolder: async () => {
      throw new Error('Remote folder download is unavailable in paired web clients.')
    },
    saveDownloadedFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    startDownloadedFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    appendDownloadedFileChunk: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    finishDownloadedFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    cancelDownloadedFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    listMarkdownDocuments: async ({ rootPath }) => {
      const file = await resolveRuntimeFilePath(rootPath)
      return callRuntimeResult('files.listMarkdownDocuments', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id)
      })
    },
    ...createWebFileMutationMethods({
      captureSession: captureWebFileMutationSession
    }),
    stat: async ({ filePath }) => {
      const file = await resolveRuntimeFilePath(filePath)
      return callRuntimeResult('files.stat', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath
      })
    },
    pathExists: async ({ filePath }) => {
      try {
        const file = await resolveRuntimeFilePath(filePath)
        await callRuntimeResult('files.stat', {
          worktree: toRuntimeWorktreeSelector(file.worktree.id),
          relativePath: file.relativePath
        })
        return true
      } catch (error) {
        if (isMissingPathError(error)) {
          return false
        }
        throw error
      }
    },
    listFiles: async ({ rootPath, excludePaths }) => {
      const file = await resolveRuntimeFilePath(rootPath)
      const result = await callRuntimeResult<{ files: { relativePath: string }[] }>(
        'files.listAll',
        {
          worktree: toRuntimeWorktreeSelector(file.worktree.id),
          excludePaths
        }
      )
      return result.files.map((entry) => entry.relativePath)
    },
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
    cancelListFiles: async ({ requestToken }) => {
      workspacePathSearchControllers.get(requestToken)?.abort()
      workspacePathSearchControllers.delete(requestToken)
    },
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
      // Why: a paired web client only has remote files, so path search always goes to the host.
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
    },
    cancelSearch: async ({ requestToken }) => {
      searches.get(requestToken)?.abort()
    },
    search: async (args) => {
      const controller = new AbortController()
      if (args.requestToken) {
        searches.get(args.requestToken)?.abort()
        searches.set(args.requestToken, controller)
      }
      try {
        const file = await resolveRuntimeFilePath(args.rootPath)
        const response = await callAbortableRuntimeEnvironment(
          requireActiveEnvironment().id,
          'files.search',
          {
            worktree: toRuntimeWorktreeSelector(file.worktree.id),
            query: args.query,
            caseSensitive: args.caseSensitive,
            wholeWord: args.wholeWord,
            useRegex: args.useRegex,
            includePattern: args.includePattern,
            excludePattern: args.excludePattern,
            maxResults: args.maxResults
          },
          15_000,
          controller.signal
        )
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: files.search publishes the same SearchResult contract as the native bridge.
        return unwrapRuntimeRpcResult(response as RuntimeRpcResponse<SearchResult>)
      } finally {
        if (args.requestToken && searches.get(args.requestToken) === controller) {
          searches.delete(args.requestToken)
        }
      }
    },
    importExternalPaths: async () => ({ results: [] }),
    stageExternalPathsForRuntimeUpload: async () => ({ sources: [] }),
    // Why: the web client has no local filesystem to stream from, so staging
    // never yields a source for this to upload.
    uploadExternalFileToRuntime: async () => {
      throw new Error('Uploading local files is not supported in the web client')
    },
    resolveDroppedPathsForAgent: async () => ({ resolvedPaths: [], skipped: [], failed: [] }),
    uploadPathsToAgentSessionAttachments: async () => ({ uploaded: [], skipped: [], failed: [] }),
    watchWorktree: () => Promise.resolve(),
    unwatchWorktree: () => Promise.resolve(),
    onFsChanged: () => noopUnsubscribe
  }
}
