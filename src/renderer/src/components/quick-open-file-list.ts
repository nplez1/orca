/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: quick-open file lists are fetched over local or SSH runtime IPC, so loading/error/results track the request lifecycle. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  isQuickOpenQueryTooLarge,
  isQuickOpenRemoteQueryTooLarge
} from '@/components/quick-open-search'
import type { PathSearchMode } from '../../../shared/quick-open-path-search'
import type { RuntimeFileListState } from './runtime-file-list-state'
import { createRuntimePathSearchScheduler } from './runtime-path-search-scheduler'
import { startRuntimeUnscopedFileListing } from './runtime-file-listing-fallback'
import { resolveRuntimeFileListDerivedState } from './runtime-file-list-derived-state'
import { useRuntimePathSearchSchedulerLifecycle } from './use-runtime-path-search-scheduler-lifecycle'
import { NO_LISTING, scheduleRuntimeFilePathSearch } from './runtime-path-search-request'
import { getRuntimeFileListTarget } from './runtime-file-list-scan-target'

export {
  getNestedWorktreeExcludePaths,
  getNestedWorktreeExcludeRequest,
  getRuntimeFileListTarget,
  isNestedWorktreePath
} from './runtime-file-list-scan-target'
export type {
  NestedWorktreeExcludeRequest,
  RuntimeFileListTarget
} from './runtime-file-list-scan-target'
import { useAppStore } from '@/store'
import { useWorktreesForRepo } from '@/store/selectors'
import type { FileExplorerOperationOwner } from '@/components/right-sidebar/file-explorer-types'
import {
  getFileExplorerOperationOwnerFromState,
  getFileExplorerOwnerUnresolvedMessage,
  getFileExplorerOperationRoute
} from '@/components/right-sidebar/file-explorer-operation-owner'

export type { RuntimeFileListState }

export function useRuntimeFileListForWorktree({
  enabled,
  worktreeId,
  query,
  queryMode = 'quick-open',
  queryLimit = 32,
  includeIgnoredFiles,
  includeDotfiles = true,
  queryInputAt
}: {
  enabled: boolean
  worktreeId: string | null
  query?: string
  /** Matcher the host uses for a query-scoped search; ignored for an unscoped listing. */
  queryMode?: PathSearchMode
  /** Bounded page size for a query-scoped search. */
  queryLimit?: number
  /**
   * Retained for the Explorer caller. A local typed query is always answered by the index-backed
   * host path search, so the capped-listing host re-list this once gated is superseded.
   */
  hostFilterWhenCapped?: boolean
  /** Scope for a query-scoped search; the Explore pane passes its visibility settings. */
  includeIgnoredFiles?: boolean
  includeDotfiles?: boolean
  /** Renderer-monotonic timestamp captured by the controlled input change handler. */
  queryInputAt?: number
}): RuntimeFileListState {
  const worktree = useAppStore((state) =>
    // Why: folder workspaces live behind getKnownWorktreeById, not worktreesByRepo.
    worktreeId ? (state.getKnownWorktreeById(worktreeId) ?? null) : null
  )
  const worktreePath = worktree?.path ?? null
  const repoWorktrees = useWorktreesForRepo(worktree?.repoId ?? null)
  const [listing, setListing] = useState(NO_LISTING)
  const [visibleLoadingRequestKey, setVisibleLoadingRequestKey] = useState('')
  const [requestOutcome, setRequestOutcome] = useState({
    requestKey: '',
    correlationId: '',
    pending: false
  })
  const [loadError, setLoadError] = useState<string | null>(null)
  const [listedOperationOwner, setListedOperationOwner] = useState<FileExplorerOperationOwner>({
    kind: 'unresolved'
  })
  const [searchScheduler] = useState(createRuntimePathSearchScheduler)
  const consumerIdRef = useRef<string | null>(null)
  const consumerSequenceRef = useRef(0)
  const loadingTimerRef = useRef<number | null>(null)

  const target = useMemo(
    () => getRuntimeFileListTarget(worktreeId, worktreePath, repoWorktrees),
    [repoWorktrees, worktreeId, worktreePath]
  )
  const { excludeRequest } = target

  const operationOwnerState = useAppStore(
    useShallow((state) => ({
      settings: state.settings,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo,
      detectedWorktreesByRepo: state.detectedWorktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
    }))
  )
  const operationOwner = useMemo(
    () => getFileExplorerOperationOwnerFromState(operationOwnerState, worktreeId),
    [operationOwnerState, worktreeId]
  )
  const operationOwnerKey = JSON.stringify(operationOwner)
  const operationOwnerRef = useRef(operationOwner)
  operationOwnerRef.current = operationOwner
  const operationRoute = getFileExplorerOperationRoute(operationOwner)
  const operationRouteAvailable = operationRoute !== null
  const connectionId = operationRoute?.connectionId
  const runtimeEnvironmentId = operationRoute?.settings.activeRuntimeEnvironmentId ?? null
  const activeTargetStatus = useAppStore((state) =>
    connectionId ? state.sshConnectionStates.get(connectionId)?.status : undefined
  )
  const connectionPending =
    activeTargetStatus === 'connecting' ||
    activeTargetStatus === 'deploying-relay' ||
    activeTargetStatus === 'reconnecting'
  const usesRuntimeEnvironmentRpc = runtimeEnvironmentId !== null
  const hasRemoteHost = usesRuntimeEnvironmentRpc || connectionId !== undefined
  const trimmedQuery = query?.trim() ?? ''
  // Why: a remote host cannot browse unscoped, but a local workspace can — keeping the unscoped
  // listing until the user types is what lets Quick Open show files the moment it opens.
  const usesRuntimePathSearch = query !== undefined && (hasRemoteHost || trimmedQuery.length > 0)
  const remoteQuery = usesRuntimePathSearch ? trimmedQuery : ''
  const remoteQueryTooLarge =
    usesRuntimePathSearch &&
    // Why: a local search never crosses the host's compact remote frame, so it gets the byte limit.
    (hasRemoteHost
      ? isQuickOpenRemoteQueryTooLarge(remoteQuery)
      : isQuickOpenQueryTooLarge(remoteQuery))
  // Why: mirrors the unscoped listing effect's guard so its first render already reads as loading.
  const browseListingPending =
    !usesRuntimePathSearch &&
    enabled &&
    target.canList &&
    operationRouteAvailable &&
    Boolean(worktreeId) &&
    Boolean(worktreePath)
  const requestDisplayScopeKey = useMemo(
    () =>
      JSON.stringify({
        worktreePath,
        operationOwnerKey,
        excludeKey: excludeRequest.key,
        targetStatus: activeTargetStatus ?? '',
        queryMode,
        includeIgnoredFiles: includeIgnoredFiles ?? true,
        includeDotfiles
      }),
    [
      activeTargetStatus,
      excludeRequest.key,
      includeDotfiles,
      includeIgnoredFiles,
      operationOwnerKey,
      queryMode,
      worktreePath
    ]
  )
  const {
    requestScopeKey,
    requestKey,
    currentListing,
    previousResults,
    searching,
    pathSearchEnabled,
    querySchedulerScope,
    loading,
    visibleLoadError
  } = resolveRuntimeFileListDerivedState({
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
    targetCanList: target.canList,
    operationRouteAvailable,
    loadError
  })
  useRuntimePathSearchSchedulerLifecycle({
    searchScheduler,
    querySchedulerScope,
    loadingTimerRef,
    setVisibleLoadingRequestKey
  })
  useEffect(() => {
    if (!pathSearchEnabled || !worktreeId || !worktreePath) {
      return
    }
    scheduleRuntimeFilePathSearch({
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
      excludePaths: excludeRequest.paths.length > 0 ? excludeRequest.paths : undefined,
      consumerIdRef,
      consumerSequenceRef,
      operationOwnerRef,
      loadingTimerRef,
      setRequestOutcome,
      setLoadError,
      setVisibleLoadingRequestKey,
      setListing,
      setListedOperationOwner
    })
  }, [
    connectionId,
    excludeRequest,
    includeDotfiles,
    includeIgnoredFiles,
    operationOwnerKey,
    pathSearchEnabled,
    queryInputAt,
    queryLimit,
    queryMode,
    remoteQuery,
    requestDisplayScopeKey,
    requestKey,
    requestScopeKey,
    runtimeEnvironmentId,
    searchScheduler,
    usesRuntimeEnvironmentRpc,
    worktreeId,
    worktreePath
  ])

  useEffect(() => {
    if (usesRuntimePathSearch) {
      return
    }
    if (!enabled) {
      setListedOperationOwner({ kind: 'unresolved' })
      setVisibleLoadingRequestKey('')
      return
    }
    if (!target.canList || !worktreeId || !worktreePath || !operationRouteAvailable) {
      setListing(NO_LISTING)
      setListedOperationOwner({ kind: 'unresolved' })
      setLoadError(!operationRouteAvailable ? getFileExplorerOwnerUnresolvedMessage() : null)
      setVisibleLoadingRequestKey('')
      return
    }

    return startRuntimeUnscopedFileListing({
      requestKey,
      requestScopeKey,
      requestDisplayScopeKey,
      worktreeId,
      worktreePath,
      runtimeEnvironmentId,
      connectionId,
      excludePaths: excludeRequest.paths.length > 0 ? excludeRequest.paths : undefined,
      operationOwnerRef,
      setListing,
      setListedOperationOwner,
      setLoadError,
      setVisibleLoadingRequestKey
    })
  }, [
    connectionId,
    enabled,
    excludeRequest,
    operationOwnerKey,
    operationRouteAvailable,
    requestDisplayScopeKey,
    requestKey,
    requestScopeKey,
    runtimeEnvironmentId,
    target.canList,
    usesRuntimePathSearch,
    worktreeId,
    worktreePath
  ])

  return {
    files: currentListing.files,
    loading: (loading && !previousResults) || connectionPending,
    searching,
    previousResults,
    resultQuery: currentListing.query,
    correlationId: currentListing.correlationId,
    workspacePathSearch: currentListing.workspacePathSearch,
    scopeIdentity: currentListing.displayScopeKey,
    loadError: visibleLoadError,
    truncated: previousResults ? false : currentListing.truncated,
    totalCount: previousResults ? null : currentListing.totalCount,
    ignoredFiles: currentListing.ignoredFiles,
    operationOwner: currentListing.operationOwner ?? listedOperationOwner
  }
}
