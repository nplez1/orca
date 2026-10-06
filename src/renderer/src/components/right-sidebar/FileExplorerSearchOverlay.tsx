import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { RightSidebarExplorerView } from '../../../../shared/ui-chrome-types'
import { SearchResultsPane } from './SearchResultsPane'
import type { useFileSearchPanel } from './useFileSearchPanel'

/**
 * The search half of the explorer's shared body slot.
 *
 * Why layered rather than mounted on demand: the contents view keeps its virtualized tree alive
 * underneath, so switching views never remounts a heavy pane.
 */
export function FileExplorerSearchOverlay({
  explorerView,
  searchPanel
}: {
  explorerView: RightSidebarExplorerView
  searchPanel: ReturnType<typeof useFileSearchPanel>
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'absolute inset-0 flex min-h-0 flex-col',
        explorerView !== 'search' && 'pointer-events-none invisible'
      )}
    >
      {searchPanel.activeWorktreeId ? (
        <SearchResultsPane {...searchPanel.resultsProps} />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.Search.98c8435e36',
            'Select a workspace to search'
          )}
        </div>
      )}
    </div>
  )
}
