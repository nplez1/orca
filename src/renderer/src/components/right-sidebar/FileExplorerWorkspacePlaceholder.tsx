import { translate } from '@/i18n/i18n'
import type { RightSidebarExplorerView } from '../../../../shared/ui-chrome-types'

/** Why its own component: the explorer mounts with no workspace far more often than it renders a tree. */
export function FileExplorerWorkspacePlaceholder({
  explorerView
}: {
  explorerView: RightSidebarExplorerView
}): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground px-4 text-center">
      {explorerView === 'search'
        ? translate(
            'auto.components.right.sidebar.Search.98c8435e36',
            'Select a workspace to search'
          )
        : translate(
            'auto.components.right.sidebar.FileExplorer.79b1537dd3',
            'Select a workspace to browse files'
          )}
    </div>
  )
}
