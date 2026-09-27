import type { MutableRefObject } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { PathSearchMode } from '../../../shared/quick-open-path-search'
import type { FilePathSearchResult } from '../../../shared/file-path-search-result'
import {
  WORKSPACE_PATH_SEARCH_ROW_FLAGS,
  type WorkspacePathSearchResponse
} from '../../../shared/workspace-path-search-contract'
import type { WorkspacePathSearchCorrelationId } from '../../../shared/workspace-path-search-instrumentation'
import { cancelRuntimeFileList, searchRuntimeFilePaths } from '@/runtime/runtime-file-client'
import type { FileExplorerOperationOwner } from '@/components/right-sidebar/file-explorer-types'
import { recordRendererPathSearchDuration } from './right-sidebar/file-explorer-name-filter-timing'
import {
  queueLatestRuntimePathSearch,
  type RuntimePathSearchScheduler
} from './runtime-path-search-scheduler'
import {
  MAX_WORKSPACE_PATH_SEARCH_PAGE_BYTES,
  buildNameFilterScope,
  isExactCompleteSearchCount,
  responseMatchesRuntimePathSearchRequest
} from './runtime-path-search-request-matching'

/** Files settled for one request key; local listings key without the query, so they answer every query. */
export type RuntimeFileListing = {
  requestKey: string
  scopeKey: string
  displayScopeKey: string
  query: string
  correlationId?: WorkspacePathSearchCorrelationId
  files: string[]
  totalCount: number | null
  ignoredFiles?: string[]
  workspacePathSearch?: WorkspacePathSearchResponse
  truncated: boolean
  operationOwner?: FileExplorerOperationOwner
}

export const NO_LISTING: RuntimeFileListing = {
  requestKey: '',
  scopeKey: '',
  displayScopeKey: '',
  query: '',
  files: [],
  totalCount: null,
  truncated: false
}

export function cleanRuntimeFileListError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, '')
}

export function scheduleRuntimeFilePathSearch(args: {
  searchScheduler: RuntimePathSearchScheduler
  requestKey: string
  requestScopeKey: string
  requestDisplayScopeKey: string
  worktreeId: string
  worktreePath: string
  remoteQuery: string
  queryInputAt: number | undefined
  queryMode: PathSearchMode
  queryLimit: number
  connectionId: string | undefined
  runtimeEnvironmentId: string | null
  usesRuntimeEnvironmentRpc: boolean
  includeIgnoredFiles: boolean | undefined
  includeDotfiles: boolean
  excludePaths: string[] | undefined
  consumerIdRef: MutableRefObject<string | null>
  consumerSequenceRef: MutableRefObject<number>
  operationOwnerRef: MutableRefObject<FileExplorerOperationOwner>
  loadingTimerRef: MutableRefObject<number | null>
  setRequestOutcome: (value: {
    requestKey: string
    correlationId: string
    pending: boolean
  }) => void
  setLoadError: (value: string | null) => void
  setVisibleLoadingRequestKey: (value: string) => void
  setListing: (value: RuntimeFileListing) => void
  setListedOperationOwner: (value: FileExplorerOperationOwner) => void
}): void {
  const {
    searchScheduler,
    requestKey,
    requestScopeKey,
    requestDisplayScopeKey,
    worktreeId,
    worktreePath,
    remoteQuery,
    queryInputAt,
    queryMode,
    queryLimit,
    connectionId,
    runtimeEnvironmentId,
    usesRuntimeEnvironmentRpc,
    includeIgnoredFiles,
    includeDotfiles,
    excludePaths,
    loadingTimerRef
  } = args
  const requestToken = createBrowserUuid()
  const consumerId = args.consumerIdRef.current ?? createBrowserUuid()
  args.consumerIdRef.current = consumerId
  args.consumerSequenceRef.current += 1
  const consumer = { consumerId, sequence: args.consumerSequenceRef.current }
  const requestContext = {
    settings: { activeRuntimeEnvironmentId: runtimeEnvironmentId },
    worktreeId,
    worktreePath,
    connectionId
  }
  const requestAbortController = new AbortController()
  const requestOperationOwner = args.operationOwnerRef.current
  const queryScope = buildNameFilterScope({
    rootPath: worktreePath,
    excludePaths,
    includeDotfiles,
    includeIgnoredFiles: includeIgnoredFiles ?? true
  })
  const inputAt = queryInputAt ?? performance.now()
  const request = {
    requestKey,
    scopeKey: requestScopeKey,
    correlationId: requestToken,
    inputAt,
    controller: requestAbortController,
    run: async (signal: AbortSignal) => {
      if (queryMode === 'name-filter' && !usesRuntimeEnvironmentRpc) {
        return window.api.fs.searchFilePaths({
          rootPath: worktreePath,
          ...(connectionId ? { connectionId } : {}),
          query: remoteQuery,
          limit: queryLimit,
          mode: 'name-filter',
          excludePaths,
          includeIgnoredFiles,
          includeDotfiles,
          requestToken,
          correlationId: requestToken,
          ...(connectionId
            ? {}
            : { consumerId: consumer.consumerId, consumerSequence: consumer.sequence })
        })
      }
      return searchRuntimeFilePaths(requestContext, {
        query: remoteQuery,
        limit: queryLimit,
        mode: queryMode,
        excludePaths,
        ...(queryMode === 'name-filter'
          ? { includeIgnoredFiles, includeDotfiles, correlationId: requestToken }
          : {}),
        ...(usesRuntimeEnvironmentRpc ? {} : { requestToken }),
        signal
      })
    },
    cancel: () => cancelRuntimeFileList(requestContext, requestToken),
    onQueued: () => {
      args.setRequestOutcome({ requestKey, correlationId: requestToken, pending: true })
      args.setLoadError(null)
      args.setVisibleLoadingRequestKey('')
      if (loadingTimerRef.current !== null) {
        window.clearTimeout(loadingTimerRef.current)
      }
      loadingTimerRef.current = window.setTimeout(() => {
        if (searchScheduler.latestRequestId === requestToken) {
          args.setVisibleLoadingRequestKey(requestKey)
        }
        loadingTimerRef.current = null
      }, 100)
    },
    onDispatch: () => {
      if (queryMode === 'name-filter' && queryInputAt !== undefined) {
        recordRendererPathSearchDuration(
          requestToken,
          'input-to-dispatch',
          Math.max(0, performance.now() - inputAt)
        )
      }
    },
    onResult: (result: FilePathSearchResult) => {
      const structured = result.workspacePathSearch
      if (
        structured &&
        queryMode === 'name-filter' &&
        !responseMatchesRuntimePathSearchRequest(structured, {
          query: remoteQuery,
          correlationId: requestToken,
          consumer,
          rootPath: worktreePath,
          operationOwner: requestOperationOwner,
          scope: queryScope,
          maxPaths: queryLimit,
          maxSerializedBytes: MAX_WORKSPACE_PATH_SEARCH_PAGE_BYTES
        })
      ) {
        args.setLoadError('The file search response did not match the current workspace request.')
        return
      }
      if (structured && queryMode === 'name-filter') {
        const structuredFiles = structured.rows.map((row) => row.relativePath)
        const exactCount = isExactCompleteSearchCount(structured) ? structured.count.value : null
        const expectedTruncated = exactCount === null || structured.retainedCount < exactCount
        if (
          structuredFiles.length !== result.files.length ||
          structuredFiles.some((path, index) => path !== result.files[index]) ||
          result.totalCount !== exactCount ||
          result.truncated !== expectedTruncated ||
          (exactCount !== null && exactCount < structured.retainedCount)
        ) {
          args.setLoadError('The file search response was internally inconsistent.')
          return
        }
      }
      const classifiedIgnored = structured
        ? structured.rows.flatMap((row, index) => {
            const flags = structured.rowClassificationFlags[index] ?? 0
            return (flags & WORKSPACE_PATH_SEARCH_ROW_FLAGS.ignoreClassificationKnown) !== 0 &&
              (flags & WORKSPACE_PATH_SEARCH_ROW_FLAGS.ignored) !== 0
              ? [row.relativePath]
              : []
          })
        : result.ignoredFiles
      args.setListing({
        requestKey,
        scopeKey: requestScopeKey,
        displayScopeKey: requestDisplayScopeKey,
        query: remoteQuery,
        correlationId: requestToken,
        files: structured ? structured.rows.map((row) => row.relativePath) : result.files,
        totalCount: result.totalCount,
        truncated: result.truncated,
        ignoredFiles: classifiedIgnored,
        workspacePathSearch: structured,
        operationOwner: requestOperationOwner
      })
      args.setListedOperationOwner(requestOperationOwner)
    },
    onError: (error: unknown) => {
      args.setLoadError(cleanRuntimeFileListError(error))
    },
    onFinish: () => {
      if (searchScheduler.latestRequestId === requestToken) {
        args.setRequestOutcome({ requestKey, correlationId: requestToken, pending: false })
        if (loadingTimerRef.current !== null) {
          window.clearTimeout(loadingTimerRef.current)
          loadingTimerRef.current = null
        }
        args.setVisibleLoadingRequestKey('')
      }
    }
  }
  queueLatestRuntimePathSearch(searchScheduler, request)
}
