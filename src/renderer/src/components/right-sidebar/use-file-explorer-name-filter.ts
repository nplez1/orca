import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import { getFileExplorerOperationOwnerFromState } from './file-explorer-operation-owner'
import {
  useRuntimeFileListForWorktree,
  type RuntimeFileListState
} from '@/components/quick-open-file-list'
import {
  FILE_EXPLORER_NAME_FILTER_MAX_RESULTS,
  isFileExplorerNameFilterQueryTooLarge,
  type FileExplorerNameFilterProjectionSource
} from './file-explorer-name-filter-projection'

type UseFileExplorerNameFilterResult = {
  nameFilterQuery: string
  setNameFilterQuery: Dispatch<SetStateAction<string>>
  nameFilterCollapsedPaths: Set<string>
  setNameFilterCollapsedPaths: Dispatch<SetStateAction<Set<string>>>
  hasNameFilter: boolean
  nameFilterFiles: RuntimeFileListState
  nameFilterSource: FileExplorerNameFilterProjectionSource | null
  handleClearNameFilter: () => void
  reduceNameFilterPageLimit: () => void
}

/** Files-view name-filter query state and the projection source derived from it. */
export function useFileExplorerNameFilter({
  isFilesViewActive,
  activeWorktreeId
}: {
  isFilesViewActive: boolean
  activeWorktreeId: string | null
}): UseFileExplorerNameFilterResult {
  const [nameFilterQuery, setNameFilterQueryState] = useState('')
  const nameFilterQueryRef = useRef(nameFilterQuery)
  nameFilterQueryRef.current = nameFilterQuery
  const [queryInputAt, setQueryInputAt] = useState(0)
  const setNameFilterQuery = useCallback<Dispatch<SetStateAction<string>>>((nextValue) => {
    const nextQuery =
      typeof nextValue === 'function' ? nextValue(nameFilterQueryRef.current) : nextValue
    if (nextQuery === nameFilterQueryRef.current) {
      return
    }
    nameFilterQueryRef.current = nextQuery
    setQueryInputAt(performance.now())
    setNameFilterQueryState(nextQuery)
  }, [])
  const [nameFilterCollapsedPaths, setNameFilterCollapsedPaths] = useState<Set<string>>(
    () => new Set()
  )
  const [nameFilterPageLimit, setNameFilterPageLimit] = useState(
    FILE_EXPLORER_NAME_FILTER_MAX_RESULTS
  )
  const hasNameFilterQuery = nameFilterQuery.trim().length > 0
  const nameFilterQueryTooLarge = useMemo(
    () => isFileExplorerNameFilterQueryTooLarge(nameFilterQuery),
    [nameFilterQuery]
  )
  const hasNameFilter = isFilesViewActive && hasNameFilterQuery
  const worktreePath = useAppStore((state) =>
    activeWorktreeId ? (state.getKnownWorktreeById(activeWorktreeId)?.path ?? null) : null
  )
  const operationOwner = useAppStore(
    useShallow((state) => getFileExplorerOperationOwnerFromState(state, activeWorktreeId))
  )
  const operationOwnerKey = JSON.stringify(operationOwner)
  useEffect(() => {
    if (!hasNameFilter) {
      setNameFilterCollapsedPaths((current) => (current.size > 0 ? new Set() : current))
    }
  }, [hasNameFilter])
  const showGitIgnoredFiles = useAppStore((state) => state.settings?.showGitIgnoredFiles ?? true)
  const showDotfiles = useAppStore((state) =>
    activeWorktreeId ? (state.showDotfilesByWorktree[activeWorktreeId] ?? true) : true
  )
  useEffect(() => {
    setNameFilterPageLimit(FILE_EXPLORER_NAME_FILTER_MAX_RESULTS)
  }, [activeWorktreeId, nameFilterQuery, operationOwnerKey, showDotfiles, showGitIgnoredFiles])
  const reduceNameFilterPageLimit = useCallback(() => {
    setQueryInputAt(performance.now())
    setNameFilterPageLimit((current) => Math.max(1, Math.floor(current / 2)))
  }, [])
  useEffect(() => {
    if (
      !isFilesViewActive ||
      !worktreePath ||
      operationOwner.kind !== 'local' ||
      !window.api?.fs?.acquireQuickOpenPathInventoryLease
    ) {
      return
    }
    let released = false
    let leaseId: string | null = null
    // Phase 4 can attach renderer dispatch, projection, and paint timings to this ID.
    const correlationId = createBrowserUuid()
    void window.api.fs
      .acquireQuickOpenPathInventoryLease({
        rootPath: worktreePath,
        includeIgnoredFiles: showGitIgnoredFiles,
        correlationId
      })
      .then((lease) => {
        if (lease.leaseId === null) {
          return
        }
        if (released) {
          void window.api.fs
            .releaseQuickOpenPathInventoryLease({ leaseId: lease.leaseId })
            .catch(() => {})
        } else {
          leaseId = lease.leaseId
        }
      })
      .catch(() => {})
    return () => {
      released = true
      if (leaseId !== null) {
        void window.api.fs.releaseQuickOpenPathInventoryLease({ leaseId }).catch(() => {})
      }
    }
  }, [
    activeWorktreeId,
    isFilesViewActive,
    operationOwner.kind,
    operationOwnerKey,
    showGitIgnoredFiles,
    worktreePath
  ])
  const nameFilterFiles = useRuntimeFileListForWorktree({
    enabled: hasNameFilter && !nameFilterQueryTooLarge,
    worktreeId: activeWorktreeId,
    query: nameFilterQuery,
    // Why: substring-AND is this pane's filter semantics, and it renders a tree, not a ranked list.
    queryMode: 'name-filter',
    queryLimit: nameFilterPageLimit,
    // Why: a local listing that hit its cap cannot answer the filter client-side, so it re-lists on the host with the filter applied.
    hostFilterWhenCapped: true,
    // Why: host filtering and page retention must use the same visibility scope as the tree; an
    // ignored-inclusive scan is a superset the size of the whole ignored tree.
    includeIgnoredFiles: showGitIgnoredFiles,
    includeDotfiles: showDotfiles,
    queryInputAt
  })
  const nameFilterSource = useMemo(
    () =>
      hasNameFilter
        ? {
            query: nameFilterFiles.resultQuery ?? nameFilterQuery,
            operationOwner: nameFilterFiles.operationOwner,
            totalCount: nameFilterFiles.totalCount ?? null,
            truncated: !!nameFilterFiles.truncated,
            ignoredRelativePaths: nameFilterFiles.ignoredFiles,
            workspacePathSearch: nameFilterFiles.workspacePathSearch,
            correlationId: nameFilterFiles.correlationId,
            scopeIdentity: nameFilterFiles.scopeIdentity,
            previousResults: !!nameFilterFiles.previousResults,
            searching: !!nameFilterFiles.searching,
            loadError: nameFilterFiles.loadError,
            relativePaths: nameFilterQueryTooLarge
              ? []
              : (nameFilterFiles.searching || nameFilterFiles.loading) &&
                  nameFilterFiles.files.length === 0
                ? null
                : nameFilterFiles.files
          }
        : null,
    [
      hasNameFilter,
      nameFilterFiles.files,
      nameFilterFiles.ignoredFiles,
      nameFilterFiles.loading,
      nameFilterFiles.operationOwner,
      nameFilterFiles.totalCount,
      nameFilterFiles.truncated,
      nameFilterFiles.workspacePathSearch,
      nameFilterFiles.correlationId,
      nameFilterFiles.scopeIdentity,
      nameFilterFiles.previousResults,
      nameFilterFiles.searching,
      nameFilterFiles.loadError,
      nameFilterFiles.resultQuery,
      nameFilterQuery,
      nameFilterQueryTooLarge
    ]
  )
  const handleClearNameFilter = useCallback(() => {
    setNameFilterQuery('')
  }, [setNameFilterQuery])

  return {
    nameFilterQuery,
    setNameFilterQuery,
    nameFilterCollapsedPaths,
    setNameFilterCollapsedPaths,
    hasNameFilter,
    nameFilterFiles,
    nameFilterSource,
    handleClearNameFilter,
    reduceNameFilterPageLimit
  }
}
