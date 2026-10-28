import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { restoreAgentTabFocusAfterPanelBackgroundClick } from '@/lib/agent-tab-focus-policy'
import type { ActiveRightSidebarTab } from '@/store/slices/editor'
import { isPluginPanelTabKey } from '../../../../shared/plugins/plugin-manifest'

const FileExplorer = lazy(() => import('./FileExplorer'))
const SourceControl = lazy(() => import('./SourceControl'))
const ChecksPanel = lazy(() => import('./ChecksPanel'))
const PortsPanel = lazy(() => import('./PortsPanel'))
const AiVaultSidebarPanel = lazy(() => import('./AiVaultSidebarPanel'))
const IssuePane = lazy(() => import('./IssuePane'))
const SessionSummaryPane = lazy(() => import('./SessionSummaryPane'))
const FolderWorkspaceWorktreesPanel = lazy(() => import('./FolderWorkspaceWorktreesPanel'))
const FolderWorkspacePrChecksPanel = lazy(() => import('./FolderWorkspacePrChecksPanel'))
const PluginPanel = lazy(() => import('./PluginPanel'))

type RightSidebarPanelContentProps = {
  effectiveTab: ActiveRightSidebarTab
  rightSidebarOpen: boolean
}

export function RightSidebarPanelContent({
  effectiveTab,
  rightSidebarOpen
}: RightSidebarPanelContentProps): React.JSX.Element {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      // Why: a panel is read-only chrome; a pointer click on its background drops focus
      // to the page, so the agent tab takes it back.
      onClick={restoreAgentTabFocusAfterPanelBackgroundClick}
    >
      <Suspense fallback={null}>
        {effectiveTab === 'explorer' && <FileExplorer />}
        {effectiveTab === 'source-control' && <SourceControl />}
        {effectiveTab === 'checks' && <ChecksPanel />}
        {/* SSH forwarding needs raw ports.detect data absent from the workspace-scoped status popover. */}
        {effectiveTab === 'ports' && (
          <PortsPanel isVisible={rightSidebarOpen && effectiveTab === 'ports'} />
        )}
        {effectiveTab === 'vault' && <AiVaultSidebarPanel />}
        {/* Why: the tab only offers itself when the active workspace has a
            linked issue, but the persisted route can still name it across a
            workspace switch — the pane itself renders the no-link state. */}
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
