import type { MutableRefObject } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../../../shared/quick-open-listing-limits'
import { cancelRuntimeFileList, listRuntimeFiles } from '@/runtime/runtime-file-client'
import type { FileExplorerOperationOwner } from '@/components/right-sidebar/file-explorer-types'
import {
  NO_LISTING,
  cleanRuntimeFileListError,
  type RuntimeFileListing
} from './runtime-path-search-request'

/** Starts the unscoped browse listing and returns its cleanup; the caller owns the guards. */
export function startRuntimeUnscopedFileListing(args: {
  requestKey: string
  requestScopeKey: string
  requestDisplayScopeKey: string
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId: string | null
  connectionId: string | undefined
  excludePaths: string[] | undefined
  operationOwnerRef: MutableRefObject<FileExplorerOperationOwner>
  setListing: (value: RuntimeFileListing) => void
  setListedOperationOwner: (value: FileExplorerOperationOwner) => void
  setLoadError: (value: string | null) => void
  setVisibleLoadingRequestKey: (value: string) => void
}): () => void {
  const requestKey = args.requestKey
  let cancelled = false
  args.setLoadError(null)
  const requestToken = createBrowserUuid()
  const requestAbortController = new AbortController()
  const requestOperationOwner = args.operationOwnerRef.current
  const requestContext = {
    settings: { activeRuntimeEnvironmentId: args.runtimeEnvironmentId },
    worktreeId: args.worktreeId,
    worktreePath: args.worktreePath,
    connectionId: args.connectionId
  }
  // Why no feedback delay here, unlike a query-scoped replacement: an unscoped browse has no
  // previous page to keep, so a blank files array would read as "no files match" meanwhile.
  args.setVisibleLoadingRequestKey(requestKey)
  const request = listRuntimeFiles(requestContext, {
    rootPath: args.worktreePath,
    excludePaths: args.excludePaths,
    requestToken,
    maxResults: QUICK_OPEN_LISTING_MAX_RESULTS,
    signal: requestAbortController.signal
  }).then((files) => ({
    files,
    totalCount: null,
    truncated: files.length >= QUICK_OPEN_LISTING_MAX_RESULTS,
    ignoredFiles: undefined
  }))

  void request
    .then((result) => {
      if (!cancelled) {
        args.setListing({
          requestKey,
          scopeKey: args.requestScopeKey,
          displayScopeKey: args.requestDisplayScopeKey,
          query: '',
          files: result.files,
          totalCount: result.totalCount,
          truncated: result.truncated,
          ignoredFiles: result.ignoredFiles,
          operationOwner: requestOperationOwner
        })
        args.setListedOperationOwner(requestOperationOwner)
      }
    })
    .catch((error: unknown) => {
      if (!cancelled) {
        args.setListing(NO_LISTING)
        args.setLoadError(cleanRuntimeFileListError(error))
      }
    })
    .finally(() => {
      if (!cancelled) {
        args.setVisibleLoadingRequestKey('')
      }
    })

  return () => {
    cancelled = true
    requestAbortController.abort()
    cancelRuntimeFileList(requestContext, requestToken)
  }
}
