import type { PathSearchMode } from '../../../shared/quick-open-path-search'
import {
  getFileExplorerListUnavailableMessage,
  getFileExplorerOwnerUnresolvedMessage
} from './right-sidebar/file-explorer-operation-owner'
import { NO_LISTING, type RuntimeFileListing } from './runtime-path-search-request'
import { MAX_WORKSPACE_PATH_SEARCH_PAGE_BYTES } from './runtime-path-search-request-matching'

/** Derives request keys, listing resolution, and search/loading flags for the file list hook. */
export function resolveRuntimeFileListDerivedState(args: {
  listing: RuntimeFileListing
  queryMode: PathSearchMode
  usesRuntimePathSearch: boolean
  remoteQuery: string
  remoteQueryTooLarge: boolean
  requestDisplayScopeKey: string
  queryLimit: number
  requestOutcome: { requestKey: string; correlationId: string; pending: boolean }
  visibleLoadingRequestKey: string
  browseListingPending: boolean
  enabled: boolean
  targetCanList: boolean
  operationRouteAvailable: boolean
  loadError: string | null
}): {
  requestScopeKey: string
  requestKey: string
  currentListing: RuntimeFileListing
  previousResults: boolean
  searchCanStart: boolean
  searching: boolean
  pathSearchEnabled: boolean
  querySchedulerScope: string | null
  loading: boolean
  visibleLoadError: string | null
} {
  const {
    listing,
    queryMode,
    usesRuntimePathSearch,
    remoteQuery,
    remoteQueryTooLarge,
    requestDisplayScopeKey,
    queryLimit,
    requestOutcome,
    visibleLoadingRequestKey,
    browseListingPending,
    enabled,
    targetCanList,
    operationRouteAvailable,
    loadError
  } = args
  const requestScopeKey = JSON.stringify({
    displayScopeKey: requestDisplayScopeKey,
    pageBudget: { maxPaths: queryLimit, maxSerializedBytes: MAX_WORKSPACE_PATH_SEARCH_PAGE_BYTES }
  })
  const requestKey = `${requestScopeKey}\n${usesRuntimePathSearch ? remoteQuery : 'browse'}`
  const currentListing =
    listing.requestKey === requestKey
      ? listing
      : queryMode === 'name-filter' &&
          usesRuntimePathSearch &&
          remoteQuery &&
          !remoteQueryTooLarge &&
          listing.query.length > 0 &&
          listing.displayScopeKey === requestDisplayScopeKey
        ? listing
        : NO_LISTING
  const previousResults =
    queryMode === 'name-filter' &&
    !remoteQueryTooLarge &&
    currentListing !== NO_LISTING &&
    (currentListing.requestKey !== requestKey ||
      (requestOutcome.pending &&
        requestOutcome.requestKey === requestKey &&
        currentListing.correlationId !== requestOutcome.correlationId))
  const searchCanStart =
    enabled &&
    targetCanList &&
    operationRouteAvailable &&
    usesRuntimePathSearch &&
    remoteQuery.length > 0 &&
    !remoteQueryTooLarge
  const searching =
    searchCanStart &&
    (requestOutcome.requestKey === requestKey
      ? requestOutcome.pending
      : currentListing.requestKey !== requestKey)
  const pathSearchEnabled =
    enabled &&
    targetCanList &&
    operationRouteAvailable &&
    usesRuntimePathSearch &&
    remoteQuery.length > 0 &&
    !remoteQueryTooLarge
  const querySchedulerScope = pathSearchEnabled ? requestScopeKey : null
  // Why: the browse listing starts in an effect, so the render before it must already read as
  // loading — an empty `files` array otherwise reads as a settled "no files match".
  const loading =
    visibleLoadingRequestKey === requestKey ||
    (browseListingPending && listing.requestKey !== requestKey)
  // Why: a workspace with no listable path is unavailable, not an empty result set. The
  // query-scoped path skips the listing effect, so the reason must be derived here.
  const targetUnavailable = enabled && (!targetCanList || !operationRouteAvailable)
  const visibleLoadError = remoteQueryTooLarge
    ? 'The filename filter query is too large.'
    : searching
      ? null
      : (loadError ??
        (targetUnavailable
          ? operationRouteAvailable
            ? getFileExplorerListUnavailableMessage()
            : getFileExplorerOwnerUnresolvedMessage()
          : null))
  return {
    requestScopeKey,
    requestKey,
    currentListing,
    previousResults,
    searchCanStart,
    searching,
    pathSearchEnabled,
    querySchedulerScope,
    loading,
    visibleLoadError
  }
}
