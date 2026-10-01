import type { TopLevelView } from '../../../../shared/ui-chrome-types'

/** Only the state the toggle reads and writes, so callers pass the store state
 *  directly without a wider AppState dependency. */
export type AgentDashboardShortcutState = {
  activeView: TopLevelView
  settings: { experimentalAgentDashboardPopout?: boolean } | null | undefined
  openAgentDashboardPage: () => void
  closeAgentDashboardPage: () => void
}

export function toggleAgentDashboardFromShortcut(state: AgentDashboardShortcutState): void {
  // Why: match Tasks and the workspace board — a shortcut never swaps the surface out from under the Settings view.
  if (
    state.settings?.experimentalAgentDashboardPopout !== true ||
    state.activeView === 'settings'
  ) {
    return
  }
  // Why: the dashboard is a top-level view, so the shortcut toggles it and closing
  // returns to whatever view it was opened from.
  if (state.activeView === 'dashboard') {
    state.closeAgentDashboardPage()
    return
  }
  state.openAgentDashboardPage()
}
