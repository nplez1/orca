import { describe, expect, it, vi } from 'vitest'
import type { TopLevelView } from '../../../shared/ui-chrome-types'
import { toggleAgentDashboardFromShortcut } from './ipc-events/agent-dashboard-command'

function makeState(overrides: { activeView?: TopLevelView; experimentEnabled?: boolean } = {}) {
  return {
    activeView: overrides.activeView ?? 'terminal',
    settings: {
      experimentalAgentDashboardPopout: overrides.experimentEnabled ?? true
    },
    openAgentDashboardPage: vi.fn(),
    closeAgentDashboardPage: vi.fn()
  }
}

describe('toggleAgentDashboardFromShortcut', () => {
  it('stays inert while the Agent Dashboard experiment is off', () => {
    const state = makeState({ experimentEnabled: false })

    toggleAgentDashboardFromShortcut(state)

    expect(state.openAgentDashboardPage).not.toHaveBeenCalled()
    expect(state.closeAgentDashboardPage).not.toHaveBeenCalled()
  })

  it('opens the dashboard view from another view', () => {
    const state = makeState({ activeView: 'terminal' })

    toggleAgentDashboardFromShortcut(state)

    expect(state.openAgentDashboardPage).toHaveBeenCalledOnce()
    expect(state.closeAgentDashboardPage).not.toHaveBeenCalled()
  })

  it('stays inert in the Settings view', () => {
    const state = makeState({ activeView: 'settings' })

    toggleAgentDashboardFromShortcut(state)

    expect(state.openAgentDashboardPage).not.toHaveBeenCalled()
    expect(state.closeAgentDashboardPage).not.toHaveBeenCalled()
  })

  it('closes the dashboard view when it is already active', () => {
    const state = makeState({ activeView: 'dashboard' })

    toggleAgentDashboardFromShortcut(state)

    expect(state.closeAgentDashboardPage).toHaveBeenCalledOnce()
    expect(state.openAgentDashboardPage).not.toHaveBeenCalled()
  })
})
