// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import AgentDashboardSidebarHost from './AgentDashboardSidebarHost'

vi.mock('@/components/dashboard/AgentDashboardDrawer', () => ({
  AgentDashboardDrawer: () => null
}))

const initialState = useAppStore.getInitialState()

beforeEach(() => {
  useAppStore.setState({ agentDashboardDrawerOpen: false }, false)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('AgentDashboardSidebarHost', () => {
  it('closes the dashboard when the workspace board opens', async () => {
    useAppStore.setState({ agentDashboardDrawerOpen: true })
    render(
      <AgentDashboardSidebarHost
        sidebarOpen
        workspaceBoardOpen
        closeWorkspaceBoard={vi.fn()}
        statusBarVisible
      />
    )

    await waitFor(() => expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(false))
  })

  it('closes the workspace board when the dashboard opens', async () => {
    const closeWorkspaceBoard = vi.fn()
    const view = render(
      <AgentDashboardSidebarHost
        sidebarOpen
        workspaceBoardOpen={false}
        closeWorkspaceBoard={closeWorkspaceBoard}
        statusBarVisible
      />
    )

    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))
    view.rerender(
      <AgentDashboardSidebarHost
        sidebarOpen
        workspaceBoardOpen={false}
        closeWorkspaceBoard={closeWorkspaceBoard}
        statusBarVisible
      />
    )

    await waitFor(() => expect(closeWorkspaceBoard).toHaveBeenCalledOnce())
  })

  it('clears an open dashboard when the sidebar closes', async () => {
    useAppStore.setState({ agentDashboardDrawerOpen: true })
    render(
      <AgentDashboardSidebarHost
        sidebarOpen={false}
        workspaceBoardOpen={false}
        closeWorkspaceBoard={vi.fn()}
        statusBarVisible
      />
    )

    await waitFor(() => expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(false))
  })

  it('clears an open drawer when the mode moves the board to the pop-out', async () => {
    useAppStore.setState({
      agentDashboardDrawerOpen: true,
      settings: { ...getDefaultSettings('/tmp'), experimentalAgentDashboardMode: 'in-window' }
    })
    render(
      <AgentDashboardSidebarHost
        sidebarOpen
        workspaceBoardOpen={false}
        closeWorkspaceBoard={vi.fn()}
        statusBarVisible
      />
    )
    expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(true)

    act(() => {
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, experimentalAgentDashboardMode: 'popout' }
      }))
    })

    await waitFor(() => expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(false))
  })

  // Why: handing the board back opens the drawer from the main process a tick
  // before the mode reaches this store. Treating the stale pop-out mode as a
  // reason to close would drop the board the user just asked for.
  it('keeps a drawer the handoff opened before the mode update lands', async () => {
    useAppStore.setState({
      agentDashboardDrawerOpen: false,
      settings: { ...getDefaultSettings('/tmp'), experimentalAgentDashboardMode: 'popout' }
    })
    render(
      <AgentDashboardSidebarHost
        sidebarOpen
        workspaceBoardOpen={false}
        closeWorkspaceBoard={vi.fn()}
        statusBarVisible
      />
    )

    act(() => useAppStore.setState({ agentDashboardDrawerOpen: true }))
    act(() => {
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, experimentalAgentDashboardMode: 'in-window' }
      }))
    })

    expect(useAppStore.getState().agentDashboardDrawerOpen).toBe(true)
  })
})
