import { useTranslate } from '@/i18n/use-translate'
import type { RightSidebarExplorerView } from '../../../../shared/ui-chrome-types'

/** Why its own component: the explorer mounts with no workspace far more often than it renders a tree. */
export function FileExplorerWorkspacePlaceholder({
  explorerView
}: {
  explorerView: RightSidebarExplorerView
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground px-4 text-center">
      {explorerView === 'search'
        ? t('auto.components.right.sidebar.Search.98c8435e36', 'Select a workspace to search')
        : t(
            'auto.components.right.sidebar.FileExplorer.79b1537dd3',
            'Select a workspace to browse files'
          )}
    </div>
  )
}
