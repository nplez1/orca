/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: quick-open file lists are fetched over local or SSH runtime IPC, so loading/error/results track the request lifecycle. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  isQuickOpenQueryTooLarge,
  isQuickOpenRemoteQueryTooLarge
} from '@/components/quick-open-search'
import type { PathSearchMode } from '../../../shared/quick-open-path-search'
import type { FilePathSearchResult } from '../../../shared/file-path-search-result'
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
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../../../shared/quick-open-listing-limits'
import {
  cancelRuntimeFileList,
  listRuntimeFiles,
  searchRuntimeFilePaths
} from '@/runtime/runtime-file-client'
import { createRuntimeRpcAbortError } from '@/runtime/abortable-runtime-environment-call'
import { useAppStore } from '@/store'
import { useWorktreesForRepo } from '@/store/selectors'
import type { FileExplorerOperationOwner } from '@/components/right-sidebar/file-explorer-types'
import {
  getFileExplorerOperationOwnerFromState,
  getFileExplorerOwnerUnresolvedMessage,
  getFileExplorerOperationRoute
} from '@/components/right-sidebar/file-explorer-operation-owner'

export type RuntimeFileListState = {
  files: string[]
  loading: boolean
  loadError: string | null
  truncated?: boolean
  /** Exact match count a query-scoped host search scanned; null for an unscoped listing. */
  totalCount?: number | null
  /**
   * Subset of `files` the host already knows are gitignored, when it answered from its path
   * inventory. Undefined means the caller must resolve ignored status itself.
   */
  ignoredFiles?: string[]
  operationOwner?: FileExplorerOperationOwner
}

/** Files settled for one request key; local listings key without the query, so they answer every query. */
type RuntimeFileListing = {
  requestKey: string
  files: string[]
  totalCount: number | null
  ignoredFiles?: string[]
  truncated: boolean
}

const NO_LISTING: RuntimeFileListing = {
  requestKey: '',
  files: [],
  totalCount: null,
  truncated: false
}

export function cleanRuntimeFileListError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, '')
}

function debounceRuntimeFilePathSearch(
  delayMs: number,
  signal: AbortSignal,
  search: () => Promise<FilePathSearchResult>
): Promise<FilePathSearchResult> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      window.clearTimeout(timer)
      reject(createRuntimeRpcAbortError())
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      void search().then(resolve, reject)
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
    }
  })
}

export function useRuntimeFileListForWorktree({
  enabled,
  worktreeId,
  query,
  queryMode = 'quick-open',
  queryLimit = 32,
  includeIgnoredFiles
}: {
  enabled: boolean
  worktreeId: string | null
  query?: string
  /** Matcher the host uses for a query-scoped search; ignored for an unscoped listing. */
  queryMode?: PathSearchMode
  /** Bounded page size for a query-scoped search. */
  queryLimit?: number
  /** Scope for a query-scoped search; the Explore pane passes its show-ignored setting. */
  includeIgnoredFiles?: boolean
}): RuntimeFileListState {
  const worktree = useAppStore((state) =>
    // Why: folder workspaces live behind getKnownWorktreeById, not worktreesByRepo.
    worktreeId ? (state.getKnownWorktreeById(worktreeId) ?? null) : null
  )
  const worktreePath = worktree?.path ?? null
  const repoWorktrees = useWorktreesForRepo(worktree?.repoId ?? null)
  const [listing, setListing] = useState(NO_LISTING)
  const [loadingRequest, setLoadingRequest] = useState({ requestKey: '', loading: false })
  const [loadError, setLoadError] = useState<string | null>(null)
  const [listedOperationOwner, setListedOperationOwner] = useState<FileExplorerOperationOwner>({
    kind: 'unresolved'
  })

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
  const requestKey = useMemo(
    () =>
      `${worktreePath ?? ''}\n${operationOwnerKey}\n${excludeRequest.key}\n${activeTargetStatus ?? ''}${usesRuntimePathSearch ? `\n${remoteQuery}` : ''}`,
    [
      activeTargetStatus,
      excludeRequest.key,
      operationOwnerKey,
      remoteQuery,
      usesRuntimePathSearch,
      worktreePath
    ]
  )
  // Why: the render between a request change and the effect that starts the next request must
  // not show the previous listing, so a listing is only visible for the request that produced it.
  const currentListing = listing.requestKey === requestKey ? listing : NO_LISTING
  const startsRequest =
    enabled &&
    target.canList &&
    operationRouteAvailable &&
    !(usesRuntimePathSearch && (remoteQuery.length === 0 || remoteQueryTooLarge))
  // Why: in that same gap the effect has not flipped loading yet, so fall back to whether this
  // render is going to start a request — otherwise the empty listing reads as "no results".
  const loading = loadingRequest.requestKey === requestKey ? loadingRequest.loading : startsRequest

  useEffect(() => {
    if (!enabled) {
      setLoadingRequest({ requestKey, loading: false })
      setListedOperationOwner({ kind: 'unresolved' })
      return
    }

    if (!target.canList || !worktreeId || !worktreePath || !operationRouteAvailable) {
      setListing(NO_LISTING)
      setListedOperationOwner({ kind: 'unresolved' })
      setLoadError(!operationRouteAvailable ? getFileExplorerOwnerUnresolvedMessage() : null)
      setLoadingRequest({ requestKey, loading: false })
      return
    }

    let cancelled = false
    setLoadError(null)

    if (usesRuntimePathSearch && (remoteQuery.length === 0 || remoteQueryTooLarge)) {
      setListing(NO_LISTING)
      setLoadingRequest({ requestKey, loading: false })
      setListedOperationOwner(operationOwnerRef.current)
      return
    }

    setLoadingRequest({ requestKey, loading: true })

    const excludePaths = excludeRequest.paths.length > 0 ? excludeRequest.paths : undefined
    const requestToken = createBrowserUuid()
    const requestAbortController = new AbortController()
    const requestOperationOwner = operationOwnerRef.current
    const requestContext = {
      settings: { activeRuntimeEnvironmentId: runtimeEnvironmentId },
      worktreeId,
      worktreePath,
      connectionId
    }

    const request = usesRuntimePathSearch
      ? debounceRuntimeFilePathSearch(120, requestAbortController.signal, () =>
          searchRuntimeFilePaths(requestContext, {
            query: remoteQuery,
            limit: queryLimit,
            mode: queryMode,
            excludePaths,
            includeIgnoredFiles,
            ...(usesRuntimeEnvironmentRpc ? {} : { requestToken }),
            signal: requestAbortController.signal
          })
        )
      : listRuntimeFiles(requestContext, {
          rootPath: worktreePath,
          excludePaths,
          requestToken,
          maxResults: QUICK_OPEN_LISTING_MAX_RESULTS,
          signal: requestAbortController.signal
        }).then((files) => ({
          // #12547: naming the cap is what makes a full page readable as "there is more". Reporting
          // false unconditionally is what made the truncation silent — the host bounds the scan to
          // the cap it is given, so a full page means there are more paths behind it.
          files,
          totalCount: null,
          truncated: files.length >= QUICK_OPEN_LISTING_MAX_RESULTS,
          ignoredFiles: undefined
        }))

    void request
      .then((result) => {
        if (!cancelled) {
          setListing({ requestKey, ...result })
          setListedOperationOwner(requestOperationOwner)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setListing(NO_LISTING)
          setLoadError(cleanRuntimeFileListError(error))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingRequest({ requestKey, loading: false })
        }
      })

    return () => {
      cancelled = true
      requestAbortController.abort()
      // Why #7721: switching workspaces (or closing the palette) must abort
      // the previous full-tree scan host- and relay-side. Over SSH, abandoned
      // scans otherwise stack up and starve fs.readDir/fs.stat past their
      // 30s timeout ("Could not load files for this workspace").
      cancelRuntimeFileList(requestContext, requestToken)
    }
  }, [
    enabled,
    excludeRequest,
    connectionId,
    includeIgnoredFiles,
    operationOwnerKey,
    operationRouteAvailable,
    queryLimit,
    queryMode,
    requestKey,
    runtimeEnvironmentId,
    target.canList,
    usesRuntimeEnvironmentRpc,
    worktreeId,
    worktreePath,
    remoteQuery,
    remoteQueryTooLarge,
    usesRuntimePathSearch
  ])

  return {
    files: currentListing.files,
    loading: loading || connectionPending,
    loadError,
    truncated: currentListing.truncated,
    totalCount: currentListing.totalCount,
    ignoredFiles: currentListing.ignoredFiles,
    operationOwner: listedOperationOwner
  }
}
