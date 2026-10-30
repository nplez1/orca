import type { TabBarCreateMenuController as SharedTabBarCreateMenuController } from './tab-bar-create-menu-contract'
import { useAgentLaunchPickerInventory } from '../agent/use-agent-launch-picker-inventory'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import { useEffect, useMemo, useState } from 'react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { launchDefaultAgentInNewTab } from './launch-default-agent-in-new-tab'
import { useNewTabMenuFocusHandoff } from './new-tab-menu-focus-handoff'
import type { WindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'
import { useAppStore } from '../../store'
import { useTabAgentMenuLaunch } from './QuickLaunchButton'
import { requestNativeChatComposerFocus } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { useNewTabAgentMenuRows } from './use-new-tab-agent-menu-rows'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import type { TabAgentLaunchOption } from './tab-agent-launch-options'
import { buildAgentPickerLaunchOptions } from './tab-agent-launch-options'
import { buildTabCreateMenuOptions, type TabCreateMenuOption } from './tab-create-menu-options'
import { resolveWindowsShellLaunchTarget } from './windows-shell-launch'
import { buildWindowsShellMenuEntries } from './tab-bar-windows-shell-options'
import type {
  getProjectRuntimeShellMenuMode,
  resolveWindowsPowerShellImplementationSetting
} from './use-tab-bar-runtime-model'

/**
 * Upstream's shared contract, plus the fork's split-button launch and its synchronous focus
 * preference — both live only in this controller's callers.
 */
export type TabBarCreateMenuController = SharedTabBarCreateMenuController & {
  /** The split new-tab button's action: the agent the user's Chat UI setting picks a surface for. */
  launchDefaultAgentFromSplitButton: (agent: TuiAgent) => void
  queueFocusAfterNewTabMenuClose: (focus: () => void, synchronous?: true) => void
}
export function useTabBarCreateMenuController({
  worktreeId,
  resolvedGroupId,
  terminalOnly,
  showAgentLaunchItems = true,
  mobileEmulatorEnabled,
  managedBrowserCreationEnabled,
  mobileEmulatorCreationEnabled,
  workspaceHasSimulatorTab,
  showWindowsShellMenu,
  projectRuntimeShellMenuMode,
  defaultWindowsShell,
  defaultWindowsPowerShellImplementation,
  agentDetectionTarget,
  windowsTerminalCapabilities,
  onNewTerminalTab,
  onNewTerminalWithShell,
  onNewBrowserTab,
  onNewSimulatorTab,
  onNewFileTab,
  onOpenFileTab
}: {
  worktreeId: string
  resolvedGroupId: string
  terminalOnly: boolean
  showAgentLaunchItems?: boolean
  mobileEmulatorEnabled: boolean
  managedBrowserCreationEnabled: boolean
  mobileEmulatorCreationEnabled: boolean
  workspaceHasSimulatorTab: boolean
  showWindowsShellMenu: boolean
  projectRuntimeShellMenuMode: ReturnType<typeof getProjectRuntimeShellMenuMode>
  defaultWindowsShell: string
  defaultWindowsPowerShellImplementation: ReturnType<
    typeof resolveWindowsPowerShellImplementationSetting
  >
  agentDetectionTarget: AgentDetectionTarget | undefined
  windowsTerminalCapabilities: WindowsTerminalCapabilities
  onNewTerminalTab: () => void
  onNewTerminalWithShell?: (shell: string) => void
  onNewBrowserTab: () => void
  onNewSimulatorTab?: () => void
  onNewFileTab?: () => void
  onOpenFileTab?: () => void
}): TabBarCreateMenuController {
  // Why: <webview> clicks are out-of-process, so Radix's document-pointerdown outside-click check misses them; use window blur.
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false)
  const [createMenuQuery, setCreateMenuQuery] = useState('')
  const agentMenu = useNewTabAgentMenuRows(
    worktreeId,
    newTabMenuOpen && showAgentLaunchItems,
    agentDetectionTarget,
    { wakeOnOpen: true }
  )
  const [selectedPickerAgent, selectPickerAgent] = useState<AgentPickerEntry['agent']>()
  const agentPickerEntries = useAgentLaunchPickerInventory(
    worktreeId,
    agentMenu,
    newTabMenuOpen && showAgentLaunchItems,
    selectedPickerAgent
  )
  const commandOverrides = useAppStore((state) => state.settings?.agentCmdOverrides)
  const agentLaunchOptions = buildAgentPickerLaunchOptions(agentPickerEntries, commandOverrides)
  const {
    queueNewActiveTerminalFocusAfterNewTabMenuClose,
    queueTerminalTabFocusAfterNewTabMenuClose,
    queueFocusAfterNewTabMenuClose,
    runPendingNewTabMenuFocusAfterClose,
    clearPendingNewTabMenuFocusOnUnmount
  } = useNewTabMenuFocusHandoff()
  const windowsShellEntries = useMemo(() => {
    return buildWindowsShellMenuEntries({
      showWindowsShellMenu,
      hasShellLauncher: Boolean(onNewTerminalWithShell),
      projectRuntimeShellMenuMode,
      defaultWindowsShell,
      gitBashAvailable: windowsTerminalCapabilities.gitBashAvailable,
      wslAvailable: windowsTerminalCapabilities.wslAvailable
    })
  }, [
    defaultWindowsShell,
    onNewTerminalWithShell,
    projectRuntimeShellMenuMode,
    showWindowsShellMenu,
    windowsTerminalCapabilities.gitBashAvailable,
    windowsTerminalCapabilities.wslAvailable
  ])
  const createMenuOptions = useMemo(
    () =>
      buildTabCreateMenuOptions({
        terminalOnly,
        windowsShellEntries,
        hasNewBrowser: !terminalOnly && managedBrowserCreationEnabled,
        hasNewMarkdown: !terminalOnly && Boolean(onNewFileTab),
        hasOpenMarkdown: !terminalOnly && Boolean(onOpenFileTab),
        hasSimulator:
          !terminalOnly &&
          mobileEmulatorEnabled &&
          mobileEmulatorCreationEnabled &&
          Boolean(onNewSimulatorTab),
        simulatorIsGoTo: workspaceHasSimulatorTab
      }),
    [
      mobileEmulatorEnabled,
      managedBrowserCreationEnabled,
      mobileEmulatorCreationEnabled,
      onNewFileTab,
      onNewSimulatorTab,
      onOpenFileTab,
      terminalOnly,
      windowsShellEntries,
      workspaceHasSimulatorTab
    ]
  )
  const handleSelectCreateMenuOption = (option: TabCreateMenuOption): void => {
    switch (option.kind) {
      case 'new-terminal':
        queueNewActiveTerminalFocusAfterNewTabMenuClose()
        onNewTerminalTab()
        break
      case 'new-terminal-shell':
        if (!onNewTerminalWithShell || !option.shell) {
          break
        }
        queueNewActiveTerminalFocusAfterNewTabMenuClose()
        onNewTerminalWithShell(
          resolveWindowsShellLaunchTarget(
            option.shell,
            defaultWindowsPowerShellImplementation,
            windowsTerminalCapabilities.pwshAvailable
          )
        )
        break
      case 'new-browser':
        onNewBrowserTab()
        break
      case 'new-markdown':
        onNewFileTab?.()
        break
      case 'open-markdown':
        onOpenFileTab?.()
        break
      case 'new-simulator':
      case 'go-to-simulator':
        onNewSimulatorTab?.()
        break
      case 'new-plugin-file': // usePluginNewFileMenuOptions handles these first.
    }
  }
  const launchAgentRow = useTabAgentMenuLaunch({
    worktreeId,
    groupId: resolvedGroupId,
    launchSource: 'tab_bar_quick_launch',
    onFocusTerminal: queueTerminalTabFocusAfterNewTabMenuClose,
    onFocusHostTerminal: queueNewActiveTerminalFocusAfterNewTabMenuClose,
    onFocusChat: (tabId) =>
      queueFocusAfterNewTabMenuClose(() => requestNativeChatComposerFocus(tabId), true)
  })
  const launchAgentFromNewTabEntry = (option: TabAgentLaunchOption): void => {
    if (option.row) {
      if (option.setup) {
        launchAgentRow(option.row, option.setup, option.pickerEntry)
      } else {
        launchAgentRow(option.row)
      }
    }
  }
  const launchDefaultAgentFromSplitButton = (agent: TuiAgent): void => {
    launchDefaultAgentInNewTab(agent, {
      worktreeId,
      groupId: resolvedGroupId,
      onLocalTerminal: queueTerminalTabFocusAfterNewTabMenuClose,
      onHostTerminal: queueNewActiveTerminalFocusAfterNewTabMenuClose
    })
  }
  useEffect(() => {
    if (!newTabMenuOpen) {
      return
    }
    const dismiss = (): void => setNewTabMenuOpen(false)
    window.addEventListener('blur', dismiss)
    return () => window.removeEventListener('blur', dismiss)
  }, [newTabMenuOpen])
  useEffect(() => {
    if (!newTabMenuOpen) {
      setCreateMenuQuery('')
    }
  }, [newTabMenuOpen])
  return {
    agentMenu,
    agentLaunchOptions,
    agentPickerEntries,
    selectPickerAgent,
    launchAgentRow,
    newTabMenuOpen,
    setNewTabMenuOpen,
    setCreateMenuQuery,
    createMenuOptions,
    windowsShellEntries,
    handleSelectCreateMenuOption,
    launchAgentFromNewTabEntry,
    launchDefaultAgentFromSplitButton,
    runPendingNewTabMenuFocusAfterClose,
    clearPendingNewTabMenuFocusOnUnmount,
    queueNewActiveTerminalFocusAfterNewTabMenuClose,
    queueTerminalTabFocusAfterNewTabMenuClose,
    queueFocusAfterNewTabMenuClose,
    showStaticCreateMenuItems: createMenuQuery.trim().length === 0
  }
}
