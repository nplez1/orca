import { useShallow } from 'zustand/react/shallow'
import { getAgentStatusEpochNow } from '@/lib/agent-status-epoch-clock'
import { isWorkspaceEmptiedOnPurpose } from '@/lib/workspace-emptied-on-purpose'
import type { BrowserTab as BrowserTabState } from '../../../../shared/browser-workspace-types'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '../../store'
import { useTabGroupItemProjections } from './useTabGroupItemProjections'
import { useTabGroupTabCloseCommands } from './useTabGroupTabCloseCommands'
import { useTabGroupCloseScopeCommands } from './useTabGroupCloseScopeCommands'
import { useTabGroupActivationCommands } from './useTabGroupActivationCommands'
import { useTabGroupCreationCommands } from './useTabGroupCreationCommands'

const EMPTY_GROUPS: readonly TabGroup[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_BROWSER_TABS: readonly BrowserTabState[] = []
const EMPTY_TERMINAL_TABS: readonly TerminalTab[] = []
const EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID: NonNullable<
  ReturnType<typeof useAppStore.getState>['terminalLayoutsByTabId']
> = {}

export function useTabGroupWorkspaceModel({
  groupId,
  worktreeId
}: {
  groupId: string
  worktreeId: string
}) {
  const worktreeState = useAppStore(
    useShallow((state) => ({
      // Why: reuse stable EMPTY_* fallbacks; fresh `?? []` arrays break Zustand v5 snapshot identity and cause an infinite render loop.
      groups: state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS,
      unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS,
      terminalTabs: state.tabsByWorktree[worktreeId] ?? EMPTY_TERMINAL_TABS,
      openFiles: state.openFiles,
      browserTabs: state.browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS,
      expandedPaneByTabId: state.expandedPaneByTabId,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId ?? EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID,
      generatedTabTitlesEnabled: state.settings?.tabAutoGenerateTitle === true,
      mobileEmulatorEnabled: state.settings?.mobileEmulatorEnabled !== false
    }))
  )

  const focusGroup = useAppStore((state) => state.focusGroup)
  const makePreviewFilePermanent = useAppStore((state) => state.makePreviewFilePermanent)
  const pinFile = useAppStore((state) => state.pinFile)
  const setTabCustomTitle = useAppStore((state) => state.setTabCustomTitle)
  const setTabColor = useAppStore((state) => state.setTabColor)

  const {
    group,
    groupTabs,
    activeTab,
    terminalTabs,
    editorItems,
    browserItems,
    agentSessionItems,
    tabBarOrder
  } = useTabGroupItemProjections({ groupId, worktreeId, worktreeState })

  const { closeItem, closeMany } = useTabGroupTabCloseCommands({ worktreeId })

  const closedTabTombstones = useAppStore((state) => state.closedTerminalTabTombstonesByTabId)
  const agentStatusEpoch = useAppStore((state) => state.agentStatusEpoch)

  // Why: closing a workspace's last tab keeps it selected and lands on the empty-tabs surface
  // instead of the landing page, so the pane has to know it has nothing left to show (#96). The
  // close record is what separates that from an empty workspace whose first tab is still arriving
  // — a fresh worktree, a host-owned list still mirroring, a chat launch waiting on its host —
  // which must not flash the surface.
  const showsEmptyWorkspaceState =
    worktreeState.unifiedTabs.length === 0 &&
    worktreeState.terminalTabs.length === 0 &&
    worktreeState.browserTabs.length === 0 &&
    !worktreeState.openFiles.some((file) => file.worktreeId === worktreeId) &&
    isWorkspaceEmptiedOnPurpose(
      {
        tabsByWorktree: { [worktreeId]: worktreeState.terminalTabs },
        unifiedTabsByWorktree: { [worktreeId]: worktreeState.unifiedTabs },
        browserTabsByWorktree: { [worktreeId]: worktreeState.browserTabs },
        openFiles: worktreeState.openFiles,
        ...(closedTabTombstones ? { closedTerminalTabTombstonesByTabId: closedTabTombstones } : {})
      },
      worktreeId,
      getAgentStatusEpochNow(agentStatusEpoch ?? 0)
    )

  const { closeGroup, closeAllEditorTabsInGroup, closeOthers, closeToRight, closeToLeft } =
    useTabGroupCloseScopeCommands({
      groupId,
      worktreeId,
      closeItem,
      closeMany
    })

  const {
    activateTerminal,
    toggleTerminalPaneExpand,
    activateEditor,
    activateBrowser,
    activateAgentSession
  } = useTabGroupActivationCommands({ groupId, worktreeId, groupTabs, worktreeState })

  const creationCommands = useTabGroupCreationCommands({ groupId, worktreeId, worktreeState })

  return {
    group,
    activeTab,
    showsEmptyWorkspaceState,
    browserItems,
    editorItems,
    agentSessionItems,
    terminalTabs,
    tabBarOrder,
    groupTabs,
    expandedPaneByTabId: worktreeState.expandedPaneByTabId,
    commands: {
      focusGroup: () => {
        focusGroup(worktreeId, groupId)
      },
      activateAgentSession,
      activateBrowser,
      activateEditor,
      activateTerminal,
      closeAllEditorTabsInGroup,
      closeGroup,
      closeItem,
      closeOthers,
      closeToRight,
      closeToLeft,
      ...creationCommands,
      makePreviewFilePermanent,
      pinFile,
      setTabColor,
      setTabCustomTitle,
      toggleTerminalPaneExpand
    }
  }
}
