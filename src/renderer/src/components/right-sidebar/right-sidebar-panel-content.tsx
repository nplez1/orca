import { useAppStore } from '@/store/index'
import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { restoreAgentTabFocusAfterPanelBackgroundClick } from '@/lib/agent-tab-focus-policy'
import type { ActiveRightSidebarTab } from '../../../../shared/ui-chrome-types'
import '../../../../shared/plugins/manifest/plugin-manifest'
import { isPluginPanelTabKey } from '../../../../shared/plugins/frames/plugin-tab-key'

const FileExplorer = lazy(() => import('./file-explorer/panel/FileExplorer'))
const FolderWorkspaceSourceControl = lazy(
  () => import('./folder-workspaces/FolderWorkspaceSourceControlPanel')
)
const SourceControl = lazy(() => import('./source-control/panel/SourceControl'))
const ChecksPanel = lazy(() => import('./checks-panel/ChecksPanel'))
const PortsPanel = lazy(() => import('./ports/PortsPanel'))
const AiVaultSidebarPanel = lazy(() => import('./ai-vault/panel/AiVaultSidebarPanel'))
const IssuePane = lazy(() => import('./IssuePane'))
const SessionSummaryPane = lazy(() => import('./SessionSummaryPane'))
const FolderWorkspaceWorktreesPanel = lazy(
  () => import('./folder-workspaces/FolderWorkspaceWorktreesPanel')
)
const FolderWorkspacePrChecksPanel = lazy(
  () => import('./hosted-review/folder-checks/FolderWorkspacePrChecksPanel')
)
const PluginPanel = lazy(() => import('./plugin-panels/PluginPanel'))

type RightSidebarPanelContentProps = {
  effectiveTab: ActiveRightSidebarTab
  rightSidebarOpen: boolean
  focusVaultSearch: boolean
  onVaultSearchFocusHandled: () => void
}

export function RightSidebarPanelContent({
  effectiveTab,
  rightSidebarOpen,
  focusVaultSearch,
  onVaultSearchFocusHandled
}: RightSidebarPanelContentProps): React.JSX.Element {
  const isFolderWorkspace = useAppStore(
    (state) => state.activeWorkspaceKey?.startsWith('folder:') ?? false
  )
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      // Why: a panel is read-only chrome; a pointer click on its background drops focus
      // to the page, so the agent tab takes it back.
      onClick={restoreAgentTabFocusAfterPanelBackgroundClick}
      // `orca plugin shot` captures exactly this rect.
      data-plugin-panel-surface={isPluginPanelTabKey(effectiveTab) ? effectiveTab : undefined}
    >
      <Suspense fallback={null}>
        {effectiveTab === 'explorer' && <FileExplorer />}
        {effectiveTab === 'source-control' &&
          (isFolderWorkspace ? (
            rightSidebarOpen && <FolderWorkspaceSourceControl />
          ) : (
            <SourceControl />
          ))}
        {effectiveTab === 'checks' && <ChecksPanel />}
        {/* SSH forwarding needs raw ports.detect data absent from the workspace-scoped status popover. */}
        {effectiveTab === 'ports' && (
          <PortsPanel isVisible={rightSidebarOpen && effectiveTab === 'ports'} />
        )}
        {effectiveTab === 'vault' && (
          <AiVaultSidebarPanel
            focusSearch={focusVaultSearch}
            onFocusSearchHandled={onVaultSearchFocusHandled}
          />
        )}
        {effectiveTab === 'issue' && <IssuePane />}
        {/* Why isVisible: the panel stays mounted while the sidebar is collapsed, and
            the summary fold must not run for a pane nobody is reading. */}
        {effectiveTab === 'summary' && (
          <SessionSummaryPane isVisible={rightSidebarOpen && effectiveTab === 'summary'} />
        )}
        {effectiveTab === 'workspaces' && <FolderWorkspaceWorktreesPanel />}
        {effectiveTab === 'pr-checks' && (
          <FolderWorkspacePrChecksPanel
            isVisible={rightSidebarOpen && effectiveTab === 'pr-checks'}
          />
        )}
        {/* Remount on plugin changes so an old iframe cannot post through the next plugin's rebound bridge. */}
        {isPluginPanelTabKey(effectiveTab) && (
          <PluginPanel key={effectiveTab} tabKey={effectiveTab} />
        )}
      </Suspense>
    </div>
  )
}
