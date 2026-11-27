import { useMemo } from 'react'
import { CircleDot, StickyNote } from 'lucide-react'
import { useAppStore } from '@/store'
import { useRepoById } from '@/store/repos/use-repository-catalog'
import { isFolderRepo } from '../../../../../shared/repository/repo-kind'
import { parseWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { getVisibleRightSidebarActivityItems } from './right-sidebar-activity-visibility'
import {
  builtInTabNames,
  getPluginPanelActivityItems,
  withDistinctPluginPanelNames
} from '../plugin-panels/plugin-panel-activity-items'
import { getDefaultRightSidebarActivityItems } from './right-sidebar-default-activity-items'
import {
  getPortsPanelOwnerKey,
  portsPanelHostForOwnerKey,
  portsPanelReachesRemoteHost
} from '../ports/ports-panel-host'
import {
  collectInstalledPluginTabKeys,
  usePluginPanels,
  usePluginPanelsStore,
  type PluginPanelsFetchStatus
} from '@/store/plugins/catalog/plugin-contribution-catalog'
import { useShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import { selectWorktreeCreationSurfaceShown } from '@/lib/workspace/creation/worktree-creation-surface'
import { getActiveChecksStatus } from '../checks-panel/status/active-checks-status'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { ActivityBarItem } from './activity-bar-buttons'
import { activityItemStatus } from './activity-bar-item-names'
import { useBotForWorkspace, useBotGroupForWorkspace } from '../../bots/bot-workspace'
import { useFocusedChatWorkers } from '@/lib/focused-chat-workers'
import { useBotNeedsYouCount, useBotNow } from '../../bots/use-bot-now'
import { usePublishedBotsNeedsYou } from '../../bots/bot-needs-you-published'
import { useBotGroupMembers } from '../../bots/use-bot-group-members'
import { resolveIssuePaneLinkedIssue } from '../workspace-linked-issue'
import { providerIconComponent } from '../issue-provider-presentation'
import { hasSessionSummaryBridge } from '../session-summary-subject'

export type RightSidebarActivityItems = {
  visibleItems: ActivityBarItem[]
  activeFolderWorkspaceKey: string | null
  pluginSystemEnabled: boolean
  pluginFetchStatus: PluginPanelsFetchStatus
  installedPluginTabKeys: Set<string>
  isBotPage: boolean
}

export function useRightSidebarActivityItems({
  rightSidebarOpen
}: {
  rightSidebarOpen: boolean
}): RightSidebarActivityItems {
  const t = useTranslate()
  const languageRevision = useUiLanguageRevision()
  const explorerShortcut = useShortcutLabel('sidebar.explorer.toggle')
  const sourceControlShortcut = useShortcutLabel('sidebar.sourceControl.toggle')
  const checksShortcut = useShortcutLabel('sidebar.checks.toggle')
  const portsShortcut = useShortcutLabel('sidebar.ports.toggle')
  const activeWorktreeId = useAppStore((s) => (rightSidebarOpen ? s.activeWorktreeId : null))
  // Hide Git-only tabs for folder workspaces.
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
  const bot = useBotForWorkspace(isFolderWorkspace ? activeWorktreeId : null)
  const isBot = bot !== null
  const group = useBotGroupForWorkspace(isFolderWorkspace ? activeWorktreeId : null)
  const isGroupHome = group !== null
  const groupMembers = useBotGroupMembers(group)
  const now = useBotNow(bot)
  const { needs } = now
  // A bot's first tab is Home: its badge counts Orca's asks and items in Needs you. A group's counts
  // its members' as their own tabs do, published by its open panel.
  const botNeedsYou = useBotNeedsYouCount(bot, now)
  const groupNeedsYou = usePublishedBotsNeedsYou(groupMembers)
  const needsYou = isGroupHome ? groupNeedsYou : botNeedsYou
  const showsHomeTab = isBot || isGroupHome
  // The same read as Activity's count, so connector reads aren't repeated for the tab.
  const connectorsNeedingOwner = needs.filter((need) => need.kind === 'connector').length
  const hasChatWorkers = useFocusedChatWorkers(rightSidebarOpen && !isBot).workers.length > 0
  // Why the owner: a managed server's workspace names its server, not an SSH connection.
  const hasRemoteHost = useAppStore((s) =>
    portsPanelReachesRemoteHost(
      portsPanelHostForOwnerKey(getPortsPanelOwnerKey(s, activeWorktreeId))
    )
  )
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
  // Why here: the checks tab announces this status, so a plugin tab's name is judged against it.
  const creatingWorktree = useAppStore(selectWorktreeCreationSurfaceShown)
  const checksStatus = useAppStore((s) =>
    s.rightSidebarOpen && !creatingWorktree ? getActiveChecksStatus(s) : null
  )

  // A bot's page labels every tab (labeledTab): Home, Connectors, Chats, Files.
  const activityItems = useMemo<ActivityBarItem[]>(() => {
    const builtInItems = getDefaultRightSidebarActivityItems({
      t,
      explorerShortcut,
      sourceControlShortcut,
      checksShortcut,
      portsShortcut,
      isBot,
      showsHomeTab,
      needsYou,
      connectorsNeedingOwner
    }).flatMap((item) => {
      // Why spliced in: the fork's own tabs sit inside upstream's default list, not after it.
      if (item.id === 'vault' && hasSessionSummaryBridge()) {
        return [
          item,
          {
            // Why conditional: a window with no summary bridge (a component fixture, not the web
            // client, which composes one) would leave the pane permanently on its loading state.
            // Why: the pane summarizes an agent session in this workspace, so it sits
            // beside Agents rather than with the source-control group.
            id: 'summary' as const,
            icon: StickyNote,
            title: t('activity.sessionSummary.label', 'Session summary'),
            shortcut: ''
          }
        ]
      }
      if (item.id === 'checks') {
        return [
          item,
          {
            id: 'issue' as const,
            icon: linkedIssueProvider ? providerIconComponent(linkedIssueProvider) : CircleDot,
            title: t('auto.components.right.sidebar.index.issue', 'Issue'),
            shortcut: '',
            linkedIssueOnly: true
          }
        ]
      }
      return [item]
    })
    return [
      ...builtInItems,
      // Append plugin tabs to preserve built-in navigation positions. Checked against every built-in
      // label, not only the visible ones, so a plugin tab's name never depends on what is shown.
      ...getPluginPanelActivityItems(
        visiblePluginPanels,
        pluginPanelErrors,
        builtInTabNames(builtInItems, t)
      ).map((item) => ({
        ...item,
        labeledTab: isBot
      }))
    ]
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() reads the UI language implicitly.
  }, [
    checksShortcut,
    explorerShortcut,
    linkedIssueProvider,
    pluginPanelErrors,
    visiblePluginPanels,
    portsShortcut,
    sourceControlShortcut,
    isBot,
    showsHomeTab,
    needsYou,
    connectorsNeedingOwner,
    languageRevision,
    t
  ])

  // Why after visibility: only tabs on screen together need names a screen reader can tell apart.
  const visibleItems = useMemo(
    () =>
      withDistinctPluginPanelNames(
        getVisibleRightSidebarActivityItems(activityItems, {
          isFolder,
          isFolderWorkspace,
          hasRemoteHost,
          isBot,
          isGroupHome,
          hasChatWorkers,
          hasLinkedIssue
        }),
        (item) => activityItemStatus(item, checksStatus)
      ),
    [
      activityItems,
      isFolder,
      isFolderWorkspace,
      hasRemoteHost,
      isBot,
      isGroupHome,
      hasChatWorkers,
      hasLinkedIssue,
      checksStatus
    ]
  )

  const activeFolderWorkspaceKey = isFolderWorkspace ? (activeWorktreeId ?? null) : null

  return {
    visibleItems,
    activeFolderWorkspaceKey,
    pluginSystemEnabled,
    pluginFetchStatus,
    installedPluginTabKeys,
    isBotPage: isBot
  }
}
