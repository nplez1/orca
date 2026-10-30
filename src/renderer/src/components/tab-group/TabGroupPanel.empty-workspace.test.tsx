// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

const mocks = vi.hoisted(() => {
  const state = {
    activeWorktreeId: 'wt-a',
    rightSidebarOpen: false,
    sidebarOpen: true,
    groupsByWorktree: {},
    repos: [],
    keybindings: {}
  }
  const useAppStore = (selector: (current: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore, state, newTerminalTab: vi.fn() }
})

vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../../store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../tab-bar/TabBar', () => ({ default: () => null }))
vi.mock('../tab-bar/TabBarQuickCommandsButton', () => ({
  TabBarQuickCommandsButton: () => null
}))
vi.mock('@/lib/pane-manager/client-hosted-browser-row-state', () => ({
  useClientHostedBrowserRows: () => []
}))
vi.mock('@/components/tab-bar/use-tab-bar-default-agent', () => ({
  useTabBarDefaultAgent: () => ({ agent: null, isAgentLaunchPending: false })
}))
vi.mock('../../../../../resources/logo.svg', () => ({ default: 'logo.svg' }))
vi.mock('./useTabGroupWorkspaceModel', () => ({
  useTabGroupWorkspaceModel: () => ({
    activeTab: null,
    agentSessionItems: [],
    browserItems: [],
    commands: {
      focusGroup: () => undefined,
      closeGroup: () => undefined,
      newTerminalTab: mocks.newTerminalTab
    },
    editorItems: [],
    showsEmptyWorkspaceState: true,
    tabBarOrder: [],
    terminalTabs: [],
    groupTabs: [],
    expandedPaneByTabId: {}
  })
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import TabGroupPanel from './TabGroupPanel'

function panel(tabStrip: 'attached' | 'external' = 'attached'): React.JSX.Element {
  return (
    <TooltipProvider>
      <TabGroupPanel
        groupId="group-a"
        worktreeId="wt-a"
        isVisible
        isFocused
        hasSplitGroups={false}
        tabStrip={tabStrip}
        touchesLeftEdge={false}
        touchesRightEdge={false}
        reserveClosedExplorerToggleSpace={false}
        reserveCollapsedSidebarHeaderSpace={false}
      />
    </TooltipProvider>
  )
}

beforeEach(() => {
  Object.assign(window, {
    api: {
      gh: {
        checkOrcaStarred: vi.fn().mockResolvedValue(true),
        starOrca: vi.fn().mockResolvedValue(true)
      },
      starNag: { complete: vi.fn().mockResolvedValue(undefined) },
      shell: { openUrl: vi.fn().mockResolvedValue(undefined) }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TabGroupPanel empty workspace surface', () => {
  it('shows the empty-tabs surface in place of the pane body', () => {
    render(panel())

    expect(screen.getByText('This workspace has no open tabs.')).toBeInTheDocument()
  })

  it('opens the first tab from the surface', async () => {
    render(panel())

    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }))

    expect(mocks.newTerminalTab).toHaveBeenCalledTimes(1)
  })

  // Why: the floating panel owns its own titlebar strip and its own empty state, and it is never a
  // workspace, so the workspace surface must not mount inside it.
  it('does not render for an externally stripped panel', () => {
    render(panel('external'))

    expect(screen.queryByText('This workspace has no open tabs.')).toBeNull()
  })
})
