import { revealTerminalPane } from '@/lib/reveal-terminal-pane'
import type { DashboardRevealAgentArgs } from '../../../../shared/dashboard-snapshot'

/**
 * Click-to-focus from the Agent Dashboard (workspace jump or terminal preview).
 *
 * Why the workspace dispatcher rather than a bare `setActiveWorktree`: only the shared
 * sequence switches the view back to terminal, resumes sleeping agent sessions, and seeds a
 * terminal surface. A parked SSH workspace has no resident tab until those run, so the bare
 * call revealed a workspace with nothing in it (#16731).
 */
export function revealDashboardAgent(args: DashboardRevealAgentArgs): boolean {
  return revealTerminalPane({
    worktreeId: args.worktreeId,
    tabId: args.tabId,
    leafId: args.leafId,
    executionHostId: args.executionHostId ?? null
  })
}
