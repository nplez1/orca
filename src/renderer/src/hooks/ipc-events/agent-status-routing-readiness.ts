type AgentStatusRoutingReadinessState = {
  workspaceSessionReady: boolean
  tabsByWorktree?: Record<string, unknown>
}

/**
 * Agent status can route as soon as persisted tabs exist. PTY restoration and
 * the broader workspace-ready gates may still be settling at that point.
 */
export function isAgentStatusRoutingReady(state: AgentStatusRoutingReadinessState): boolean {
  // Why ?? {}: the readiness flag exists because hydration may still be in flight, so an
  // unhydrated map means 'not ready yet' — never a crash for whoever asks.
  return state.workspaceSessionReady || Object.keys(state.tabsByWorktree ?? {}).length > 0
}
