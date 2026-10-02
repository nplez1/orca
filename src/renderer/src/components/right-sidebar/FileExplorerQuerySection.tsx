import React from 'react'
import { cn } from '@/lib/utils'
import type { RuntimeFileListState } from '@/components/quick-open-file-list'
import type { RightSidebarExplorerView } from '../../../../shared/ui-chrome-types'
import type { FileExplorerNameFilterProjectionSource } from './file-explorer-name-filter-projection'
import { FileExplorerNameFilter } from './FileExplorerNameFilter'
import { FileExplorerNameFilterTruncationNotice } from './FileExplorerNameFilterTruncationNotice'
import { FileExplorerQueryStrip } from './FileExplorerQueryStrip'
import { SearchFilters } from './SearchFilters'
import { SearchQueryRow } from './SearchQueryRow'
import type { FileSearchPanelModel } from './useFileSearchPanel'

type FileExplorerQuerySectionProps = {
  view: RightSidebarExplorerView
  onSelectView: (view: RightSidebarExplorerView) => void
  hasNameFilter: boolean
  nameFilterQuery: string
  nameFilterScopeLabel: string | undefined
  nameFilterLoading: boolean
  onNameFilterQueryChange: (query: string) => void
  onClearNameFilter: () => void
  nameFilterFiles: RuntimeFileListState
  nameFilterSource: FileExplorerNameFilterProjectionSource | null
  projectionPending: boolean
  projectionError: 'budget' | 'failed' | null
  searchPanel: FileSearchPanelModel
}

/**
 * The explorer's query band: the Names/Contents switch, both query rows kept mounted so the
 * switch never remounts or shifts them, the name-filter truncation notice, and the Contents
 * filters. Split from FileExplorer.tsx once that file crossed the max-lines cap.
 */
export function FileExplorerQuerySection({
  view,
  onSelectView,
  hasNameFilter,
  nameFilterQuery,
  nameFilterScopeLabel,
  nameFilterLoading,
  onNameFilterQueryChange,
  onClearNameFilter,
  nameFilterFiles,
  nameFilterSource,
  projectionPending,
  projectionError,
  searchPanel
}: FileExplorerQuerySectionProps): React.JSX.Element {
  return (
    <>
      <FileExplorerQueryStrip view={view} onSelectView={onSelectView}>
        {/* Why: keep both query rows mounted and cross-fade so the Names/Contents
           switch does not remount or shift when changing modes. */}
        <div className="relative min-h-7">
          <div
            className={cn(
              view !== 'files' && 'pointer-events-none invisible absolute inset-x-0 top-0'
            )}
          >
            <FileExplorerNameFilter
              query={nameFilterQuery}
              scopeLabel={nameFilterScopeLabel}
              loading={nameFilterLoading}
              onQueryChange={onNameFilterQueryChange}
              onClear={onClearNameFilter}
            />
          </div>
          <div
            className={cn(
              view !== 'search' && 'pointer-events-none invisible absolute inset-x-0 top-0'
            )}
          >
            <SearchQueryRow {...searchPanel.queryRowProps} />
          </div>
        </div>
        {view === 'files' ? (
          <div className="min-h-4">
            {hasNameFilter ? (
              <FileExplorerNameFilterTruncationNotice
                shownCount={nameFilterFiles.files.length}
                totalCount={nameFilterFiles.totalCount ?? null}
                truncated={!!nameFilterFiles.truncated}
                workspacePathSearch={nameFilterFiles.workspacePathSearch}
                isUpdating={
                  !!nameFilterFiles.previousResults ||
                  (nameFilterFiles.searching && nameFilterFiles.files.length > 0) ||
                  projectionPending ||
                  nameFilterSource?.workspacePathSearch?.state.freshness === 'dirty' ||
                  nameFilterSource?.workspacePathSearch?.state.freshness === 'reconciling'
                }
                isIndexing={
                  nameFilterSource?.workspacePathSearch?.degradationReason === 'missing' ||
                  nameFilterSource?.workspacePathSearch?.degradationReason === 'building'
                }
                isSearching={
                  nameFilterFiles.searching &&
                  nameFilterFiles.loading &&
                  !nameFilterFiles.previousResults
                }
                hasError={!!nameFilterFiles.loadError || !!projectionError}
                hasProjectionError={projectionError === 'budget'}
              />
            ) : null}
          </div>
        ) : null}
      </FileExplorerQueryStrip>
      <div
        className={cn(
          'border-b border-border px-2 pb-1.5',
          view !== 'search' && 'pointer-events-none invisible h-0 overflow-hidden border-b-0 p-0'
        )}
      >
        <SearchFilters {...searchPanel.filtersProps} />
      </div>
    </>
  )
}
