/**
 * The Agent Dashboard is a content-area view in this fork (`AgentDashboardPage.tsx`, rendered by
 * `AppWorkspaceShell` while `activeView === 'dashboard'`); the drawer and the pop-out window are not
 * shipped, so there is only ever one mode to resolve to.
 *
 * Why the module exists at all: upstream's sidebar entry, settings menu, experimental-setting row and
 * the `agent-dashboard-command` hook all import it, and keeping one resolver here is cheaper than a
 * hunk in each of those files. See local/sync/convergence-ledger.md § Dashboard delivery.
 */
export type AgentDashboardMode = 'in-window'

/** A web client cannot open a second window, and neither can this build at all. */
export function canOpenAgentDashboardPopout(): boolean {
  return false
}

export function resolveAgentDashboardMode(_settings?: unknown): AgentDashboardMode {
  return 'in-window'
}
