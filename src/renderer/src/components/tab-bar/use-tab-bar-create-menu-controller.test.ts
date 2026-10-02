// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { useTabBarCreateMenuController } from './use-tab-bar-create-menu-controller'

// Why these tests live here: the floating workspace's agent quick launch used to launch from its
// own window button and carried this trio of guarantees. It now rides the tab strip's create
// control, so the guarantees belong to the controller that owns that launch — for both hosts.

const mocks = vi.hoisted(() => ({
  launchAgentInNewTab: vi.fn(),
  shouldQueueTerminalFocusAfterMenuClose: vi.fn(),
  focusTerminalTabSurface: vi.fn()
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab,
  shouldQueueTerminalFocusAfterMenuClose: mocks.shouldQueueTerminalFocusAfterMenuClose
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, vars?: Record<string, string>) =>
    vars ? fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => vars[name] ?? '') : fallback
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => ({ activeTabId: null }) })
}))
vi.mock('../../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => ({ activeTabId: null }) })
}))

const NEW_AGENT_TAB_ID = 'floating-agent-tab'

function launchController(): {
  launchAgentFromNewTabEntry: (agent: TuiAgent) => void
  runPendingNewTabMenuFocusAfterClose: () => void
} {
  const { result } = renderHook(() =>
    useTabBarCreateMenuController({
      // The synthetic floating worktree: no repo behind it, and the group resolves to it.
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      resolvedGroupId: FLOATING_TERMINAL_WORKTREE_ID,
      terminalOnly: true,
      mobileEmulatorEnabled: false,
      managedBrowserCreationEnabled: false,
      mobileEmulatorCreationEnabled: false,
      workspaceHasSimulatorTab: false,
      showWindowsShellMenu: false,
      projectRuntimeShellMenuMode: null,
      defaultWindowsShell: '',
      defaultWindowsPowerShellImplementation: 'auto',
      windowsTerminalCapabilities: {
        wslAvailable: false,
        wslDistros: [],
        pwshAvailable: false,
        gitBashAvailable: false,
        hostPlatform: null,
        isLoading: false
      },
      agentLaunchOptions: [{ agent: 'claude', aliases: [], label: 'Claude' }],
      onNewTerminalTab: () => {},
      onNewBrowserTab: () => {}
    })
  )
  return result.current
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
  mocks.launchAgentInNewTab.mockReturnValue({
    surface: { kind: 'local-terminal', tabId: NEW_AGENT_TAB_ID },
    startupPlan: { launchCommand: 'claude', launchConfig: {} },
    pasteDraftAfterLaunch: false
  })
  // Why: the queued focus hands off in an animation frame; run it in the test's own turn.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('the create control agent launch', () => {
  it('launches through the shared agent launcher instead of driving tab startup itself', () => {
    launchController().launchAgentFromNewTabEntry('claude')

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledExactlyOnceWith({
      agent: 'claude',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      groupId: FLOATING_TERMINAL_WORKTREE_ID,
      launchSource: 'tab_bar_quick_launch'
    })
  })

  it('focuses the launched terminal tab once the menu has closed', () => {
    const controller = launchController()

    controller.launchAgentFromNewTabEntry('claude')
    // Why: nothing is focused while the menu is up; the handoff happens on close.
    expect(mocks.focusTerminalTabSurface).not.toHaveBeenCalled()

    controller.runPendingNewTabMenuFocusAfterClose()

    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith(NEW_AGENT_TAB_ID)
  })

  it('reports a launch the shared launcher could not plan', () => {
    mocks.launchAgentInNewTab.mockReturnValue(null)

    launchController().launchAgentFromNewTabEntry('claude')

    expect(toast.error).toHaveBeenCalledWith('Could not build launch command for Claude.')
    expect(mocks.focusTerminalTabSurface).not.toHaveBeenCalled()
  })
})
