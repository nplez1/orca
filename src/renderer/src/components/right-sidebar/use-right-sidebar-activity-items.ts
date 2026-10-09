import { useMemo } from 'react'
import { CircleDot, Plug, Files, GitBranch, ListChecks, StickyNote, Workflow } from 'lucide-react'
import { useAppStore } from '@/store'
import { useRepoById } from '@/store/selectors'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getVisibleRightSidebarActivityItems } from './right-sidebar-activity-visibility'
import { resolveIssuePaneLinkedIssue } from './workspace-linked-issue'
import { providerIconComponent } from './issue-provider-presentation'
import { getPluginPanelActivityItems } from './plugin-panel-activity-items'
import {
  collectInstalledPluginTabKeys,
  usePluginPanels,
  usePluginPanelsStore,
  type PluginPanelsFetchStatus
} from '@/store/plugin-panels'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { AgentSessionHistoryIcon } from './agent-session-history-icon'
import { hasSessionSummaryBridge } from './session-summary-subject'
import type { ActivityBarItem } from './activity-bar-buttons'

export type RightSidebarActivityItems = {
  visibleItems: ActivityBarItem[]
  activeFolderWorkspaceKey: string | null
  pluginSystemEnabled: boolean
  pluginFetchStatus: PluginPanelsFetchStatus
  installedPluginTabKeys: Set<string>
}

export function useRightSidebarActivityItems({
  rightSidebarOpen
}: {
  rightSidebarOpen: boolean
}): RightSidebarActivityItems {
  const explorerShortcut = useShortcutLabel('sidebar.explorer.toggle')
  const sourceControlShortcut = useShortcutLabel('sidebar.sourceControl.toggle')
  const checksShortcut = useShortcutLabel('sidebar.checks.toggle')
  const portsShortcut = useShortcutLabel('sidebar.ports.toggle')
  const activeWorktreeId = useAppStore((s) => (rightSidebarOpen ? s.activeWorktreeId : null))
  // Why: source control and checks are meaningless for non-git folders.
  // Hide those tabs so the activity bar only shows relevant actions.
  const activeWorktree = useAppStore((s) =>
    activeWorktreeId
      ? (s.getKnownWorktreeById(activeWorktreeId, s.activeWorkspaceExecutionHostId ?? undefined) ??
        null)
      : null
  )
  // Why: an issue link is data, not workspace shape — the Issue tab appears and
  // disappears as links are added, removed, or the active workspace changes.
  // Why the provider and not the resolved link: the link is a fresh object every
  // render, so keying the item list on it would rebuild the tab bar each time.
  const linkedIssueProvider = resolveIssuePaneLinkedIssue(activeWorktree)?.provider ?? null
  const hasLinkedIssue = linkedIssueProvider !== null
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const activeWorkspaceScope = parseWorkspaceKey(activeWorktreeId ?? '')
  const isFolderWorkspace = activeWorkspaceScope?.type === 'folder'
  const isFolder = isFolderWorkspace || (activeRepo ? isFolderRepo(activeRepo) : false)
  const isSshRepo = Boolean(activeRepo?.connectionId)
  const pluginSystemEnabled = useAppStore((s) => s.settings?.pluginSystemEnabled === true)
  const pluginPanels = usePluginPanels()
  const visiblePluginPanels = useMemo(
    () => (pluginSystemEnabled ? pluginPanels : []),
    [pluginPanels, pluginSystemEnabled]
  )
  const installedPlugins = usePluginPanelsStore((s) => s.plugins)
  const pluginFetchStatus = usePluginPanelsStore((s) => s.fetchStatus)
  const pluginPanelErrors = usePluginPanelsStore((s) => s.panelErrors)
  const installedPluginTabKeys = useMemo(
    () => collectInstalledPluginTabKeys(installedPlugins),
    [installedPlugins]
  )

  const activityItems = useMemo<ActivityBarItem[]>(
    () => [
      {
        id: 'explorer',
        icon: Files,
        title: translate('auto.components.right.sidebar.index.8bc2bbc3a0', 'Explorer'),
        shortcut: explorerShortcut === 'Unassigned' ? '' : explorerShortcut
      },
      {
        id: 'vault',
        icon: AgentSessionHistoryIcon,
        title: translate('auto.components.right.sidebar.index.aiVaultSessionHistory', 'Agents'),
        shortcut: ''
      },
      // Why conditional: a paired web client composes no session-summary bridge, so
      // offering the tab there would leave the pane permanently on its loading state.
      ...(hasSessionSummaryBridge()
        ? [
            {
              // Why: the pane summarizes an agent session in this workspace, so it sits
              // beside Agents rather than with the source-control group.
              id: 'summary' as const,
              icon: StickyNote,
              title: translate('activity.sessionSummary.label', 'Session summary'),
              shortcut: ''
            }
          ]
        : []),
      {
        id: 'workspaces',
        icon: Workflow,
        title: translate(
          'auto.components.right.sidebar.index.folderWorkspaces',
          'Attached worktrees'
        ),
        shortcut: '',
        folderOnly: true
      },
      {
        id: 'pr-checks',
        icon: ListChecks,
        title: translate('auto.components.right.sidebar.index.parentPrChecks', 'PR Checks'),
        shortcut: '',
        folderOnly: true
      },
      {
        id: 'source-control',
        icon: GitBranch,
        title: translate('auto.components.right.sidebar.index.0314901467', 'Source Control'),
        shortcut: sourceControlShortcut === 'Unassigned' ? '' : sourceControlShortcut,
        gitOnly: true
      },
      {
        id: 'checks',
        icon: ListChecks,
        title: translate('auto.components.right.sidebar.index.83a10e3c44', 'Checks'),
        shortcut: checksShortcut === 'Unassigned' ? '' : checksShortcut,
        gitOnly: true
      },
      {
        id: 'issue',
        icon: linkedIssueProvider ? providerIconComponent(linkedIssueProvider) : CircleDot,
        title: translate('auto.components.right.sidebar.index.issue', 'Issue'),
        shortcut: '',
        linkedIssueOnly: true
      },
      {
        id: 'ports',
        icon: Plug,
        title: translate('auto.components.right.sidebar.index.441733b630', 'Ports'),
        shortcut: portsShortcut === 'Unassigned' ? '' : portsShortcut,
        sshOnly: true
      },
      // Why: plugin panels append after the built-in tabs so core navigation
      // keeps stable positions regardless of which plugins are installed.
      ...getPluginPanelActivityItems(visiblePluginPanels, pluginPanelErrors)
    ],
    [
      checksShortcut,
      explorerShortcut,
      linkedIssueProvider,
      pluginPanelErrors,
      visiblePluginPanels,
      portsShortcut,
      sourceControlShortcut
    ]
  )

  const visibleItems = useMemo(
    () =>
      getVisibleRightSidebarActivityItems(activityItems, {
        isFolder,
        isFolderWorkspace,
        isSshRepo,
        hasLinkedIssue
      }),
    [activityItems, isFolder, isFolderWorkspace, isSshRepo, hasLinkedIssue]
  )

  const activeFolderWorkspaceKey = isFolderWorkspace ? (activeWorktreeId ?? null) : null

  return {
    visibleItems,
    activeFolderWorkspaceKey,
    pluginSystemEnabled,
    pluginFetchStatus,
    installedPluginTabKeys
  }
}
