import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
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
}

/** Files-view name-filter query state and the projection source derived from it. */
export function useFileExplorerNameFilter({
  isFilesViewActive,
  activeWorktreeId
}: {
  isFilesViewActive: boolean
  activeWorktreeId: string | null
}): UseFileExplorerNameFilterResult {
  const [nameFilterQuery, setNameFilterQuery] = useState('')
  const [nameFilterCollapsedPaths, setNameFilterCollapsedPaths] = useState<Set<string>>(
    () => new Set()
  )
  const hasNameFilterQuery = nameFilterQuery.trim().length > 0
  const nameFilterQueryTooLarge = useMemo(
    () => isFileExplorerNameFilterQueryTooLarge(nameFilterQuery),
    [nameFilterQuery]
  )
  const hasNameFilter = isFilesViewActive && hasNameFilterQuery
  useEffect(() => {
    if (!hasNameFilter) {
      setNameFilterCollapsedPaths((current) => (current.size > 0 ? new Set() : current))
    }
  }, [hasNameFilter])
  const showGitIgnoredFiles = useAppStore((state) => state.settings?.showGitIgnoredFiles ?? true)
  const nameFilterFiles = useRuntimeFileListForWorktree({
    enabled: hasNameFilter && !nameFilterQueryTooLarge,
    worktreeId: activeWorktreeId,
    query: nameFilterQuery,
    // Why: substring-AND is this pane's filter semantics, and it renders a tree, not a ranked list.
    queryMode: 'name-filter',
    queryLimit: FILE_EXPLORER_NAME_FILTER_MAX_RESULTS,
    // Why: a local listing that hit its cap cannot answer the filter client-side, so it re-lists on the host with the filter applied.
    hostFilterWhenCapped: true,
    // Why: the scan scope must match what the tree shows; an ignored-inclusive scan is a
    // superset the size of the whole ignored tree.
    includeIgnoredFiles: showGitIgnoredFiles
  })
  const nameFilterSource = useMemo(
    () =>
      hasNameFilter
        ? {
            query: nameFilterQuery,
            operationOwner: nameFilterFiles.operationOwner,
            totalCount: nameFilterFiles.totalCount ?? null,
            truncated: !!nameFilterFiles.truncated,
            ignoredRelativePaths: nameFilterFiles.ignoredFiles,
            relativePaths: nameFilterQueryTooLarge
              ? []
              : nameFilterFiles.loading
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
    handleClearNameFilter
  }
}
