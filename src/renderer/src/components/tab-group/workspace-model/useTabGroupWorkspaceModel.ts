import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getAgentStatusEpochNow } from '@/lib/agent-status/evidence/agent-status-epoch-clock'
import {
  hasFreshClosedTabRecord,
  hasNoRenderableWorkspaceContent
} from '@/lib/workspace-emptied-on-purpose'
import type { BrowserWorkspace } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import type { Tab, TabGroup } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { useAppStore } from '../../../store/index'
import { useTabGroupItemProjections } from './useTabGroupItemProjections'
import { useTabGroupTabCloseCommands } from './useTabGroupTabCloseCommands'
import { useTabGroupCloseScopeCommands } from './useTabGroupCloseScopeCommands'
import { useTabGroupActivationCommands } from './useTabGroupActivationCommands'
import { useTabGroupCreationCommands } from './useTabGroupCreationCommands'

const EMPTY_GROUPS: readonly TabGroup[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_BROWSER_TABS: readonly BrowserWorkspace[] = []
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

  // Why: an emptied workspace stays selected on its empty-tabs surface (#96), which must not flash
  // while a first tab is still arriving (fresh worktree, host list mirroring, pending chat launch).
  // Either a terminal close record proves the user emptied it (it survives restart; the row check
  // matches the seeder), or it was emptied while on screen: a last chat, browser or editor close
  // writes no record. That mark resets on leaving, so a retained pane cannot carry it into a later
  // visit (sleep, or re-seeding on return).
  const hasNoContent = useAppStore((state) => hasNoRenderableWorkspaceContent(state, worktreeId))
  const emptiedByRecordedClose = useAppStore(
    (state) =>
      Object.hasOwn(state.tabsByWorktree, worktreeId) &&
      hasFreshClosedTabRecord(
        state.closedTerminalTabTombstonesByTabId,
        worktreeId,
        getAgentStatusEpochNow(state.agentStatusEpoch ?? 0)
      )
  )
  const isOnScreen = useAppStore((state) => state.activeWorktreeId === worktreeId)
  const [hasShownContentOnScreen, setHasShownContentOnScreen] = useState(
    isOnScreen && !hasNoContent
  )
  const shownContentThisVisit = isOnScreen && (hasShownContentOnScreen || !hasNoContent)
  if (shownContentThisVisit !== hasShownContentOnScreen) {
    setHasShownContentOnScreen(shownContentThisVisit)
  }
  const showsEmptyWorkspaceState = hasNoContent && (emptiedByRecordedClose || shownContentThisVisit)

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
