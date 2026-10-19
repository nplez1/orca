import { isExplicitAgentStatusFresh } from './agent-status'
import { parseAgentStatusPaneIdentity } from '../../../shared/agent-status-worktree-attribution'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentType
} from '../../../shared/agent-status-types'

/**
 * Agent types a title must not claim permission for: exactly one fresh `working` row of that type
 * is filed under a tab this renderer does not have, which is what a pane re-keyed on restore
 * leaves behind. The live pane then has no row of its own, so its title is the only evidence left
 * — and the leftover `!` marker it was launched with contradicts the row that does report work.
 *
 * Deliberately narrow, because yielding a permission title can hide a real question:
 * - only the type that has such a row yields, so another agent's dialog in the same worktree still
 *   needs input;
 * - two candidates of one type are ambiguous (either pane could own the title), so neither yields;
 * - callers must drop entries with orchestration context — a dispatch worker reports before its tab
 *   exists by design, and that absence says nothing about a re-keyed pane.
 */
export function unplacedWorkingAgentTypes(args: {
  entries: Iterable<AgentStatusEntry>
  hasTab: (tabId: string) => boolean
  now: number
}): ReadonlySet<AgentType> {
  const counts = new Map<AgentType, number>()
  for (const entry of args.entries) {
    if (entry.state !== 'working' || !entry.agentType) {
      continue
    }
    if (!isExplicitAgentStatusFresh(entry, args.now, AGENT_STATUS_STALE_AFTER_MS)) {
      continue
    }
    const identity = parseAgentStatusPaneIdentity(entry.paneKey)
    if (!identity || args.hasTab(identity.tabId)) {
      continue
    }
    counts.set(entry.agentType, (counts.get(entry.agentType) ?? 0) + 1)
  }
  const yielding = new Set<AgentType>()
  for (const [agentType, count] of counts) {
    if (count === 1) {
      yielding.add(agentType)
    }
  }
  return yielding
}
