import type { AppState } from '@/store/types'
import type { VisibleOrchestrationState } from '@/runtime/agent-orchestration/visible-agent-orchestration'
import { unplacedWorkingAgentTypes } from '@/lib/unplaced-working-agent-types'
import { parseAgentStatusPaneIdentity } from '../../../../../../shared/agent-status/identity/agent-status-worktree-attribution'
import type {
  AgentStatusEntry,
  AgentType
} from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'

export type WorktreeAgentActivitySummary = {
  revision?: number
  hasPermission: boolean
  hasLiveWorking: boolean
  hasLiveMonitoring: boolean
  /** A fresh failed main agent, also while its subagents run; kept apart from clean done. */
  hasFailed: boolean
  /** Fresh interrupted completion, kept separate from clean done outcomes. */
  hasInterrupted: boolean
  /** A fresh end Orca cannot prove, likewise never a clean done. */
  hasUnconfirmed: boolean
  hasLiveDone: boolean
  agentStatusPaneIdsByTabId: Record<string, ReadonlySet<string>>
  /** Stale rows suppress generated permission labels while preserving native title fallback. */
  stalePaneIdsByTabId: Record<string, ReadonlySet<string>>
  /** Panes whose row records a finish, however old: a cached title must not outlive it. */
  terminalPaneIdsByTabId?: Record<string, ReadonlySet<string>>
  /** Agent types whose permission title yields to a re-keyed pane's own working row. */
  permissionYieldingAgentTypes?: ReadonlySet<AgentType>
}

type AgentActivityTabsByWorktree = Record<string, readonly { id: string }[]>

export type AgentActivityInput = Pick<
  AppState,
  'agentStatusEpoch' | 'agentStatusByPaneKey' | 'migrationUnsupportedByPtyId'
> &
  VisibleOrchestrationState & {
    tabsByWorktree: AgentActivityTabsByWorktree
    runtimeAgentOrchestrationByPaneKey?: AppState['runtimeAgentOrchestrationByPaneKey']
  }

const EMPTY_PANE_IDS_BY_TAB_ID: Record<string, ReadonlySet<string>> = {}
const EMPTY_PERMISSION_YIELDING_AGENT_TYPES: ReadonlySet<AgentType> = new Set()

type ForkActivityFields = Required<
  Pick<WorktreeAgentActivitySummary, 'terminalPaneIdsByTabId' | 'permissionYieldingAgentTypes'>
>

const EMPTY_FORK_ACTIVITY_FIELDS: ForkActivityFields = {
  terminalPaneIdsByTabId: EMPTY_PANE_IDS_BY_TAB_ID,
  permissionYieldingAgentTypes: EMPTY_PERMISSION_YIELDING_AGENT_TYPES
}

/** Rebuilt only when this worktree's rows, tab map, epoch or upstream summary identity changes. */
type CachedActivitySummary = {
  rows: readonly DashboardAgentRow[]
  tabsByWorktree: AgentActivityTabsByWorktree
  agentStatusEpoch: number
  summary: WorktreeAgentActivitySummary
  result: WorktreeAgentActivitySummary
}

const activitySummaries = new Map<string, CachedActivitySummary>()

export function selectWorktreeAgentActivitySummary(
  state: AgentActivityInput,
  worktreeId: string
): WorktreeAgentActivitySummary {
  const projection = state.agentStatusByPaneKey.projection
  const rows = projection.list(worktreeId)
  const summary = projection.summary(worktreeId)
  const tabsByWorktree = state.tabsByWorktree
  const cached = activitySummaries.get(worktreeId)
  if (
    cached &&
    cached.rows === rows &&
    cached.tabsByWorktree === tabsByWorktree &&
    cached.agentStatusEpoch === state.agentStatusEpoch &&
    cached.summary === summary
  ) {
    return cached.result
  }
  const result: WorktreeAgentActivitySummary = {
    ...summary,
    ...forkActivityFields(rows, tabsByWorktree)
  }
  activitySummaries.set(worktreeId, {
    rows,
    tabsByWorktree,
    agentStatusEpoch: state.agentStatusEpoch,
    summary,
    result
  })
  return result
}

/**
 * The two fields upstream's projection summary does not compute, read off the pane-keyed rows it
 * does publish plus the tab map that decides which tabs this renderer still knows.
 */
function forkActivityFields(
  rows: readonly DashboardAgentRow[],
  tabsByWorktree: AgentActivityTabsByWorktree
): ForkActivityFields {
  const now = Date.now()
  const ownWorkingEntries: AgentStatusEntry[] = []
  let terminalPaneIdsByTabId = EMPTY_PANE_IDS_BY_TAB_ID
  for (const row of rows) {
    // Synthetic subagent keys are not pane keys, and their entries always carry orchestration.
    if (row.rowSource === 'subagent' || row.entry.restoredUnconfirmed) {
      continue
    }
    const identity = parseAgentStatusPaneIdentity(row.entry.paneKey)
    if (!identity) {
      continue
    }
    if (row.entry.state === 'done') {
      // Why: the finish outlives the row's freshness. A mirrored pane's cached title — a paired
      // host's last report — has no age of its own, so without this the host's last working frame
      // kept the card spinning long after the host reported the agent done.
      terminalPaneIdsByTabId = withPaneId(terminalPaneIdsByTabId, identity.tabId, identity.paneId)
      continue
    }
    // Why: an orchestration worker reports before its tab exists by design, so its missing tab says
    // nothing about a re-keyed pane and must not cost a worker pane its question.
    if (row.entry.state === 'working' && !row.entry.orchestration) {
      ownWorkingEntries.push(row.entry)
    }
  }
  const permissionYieldingAgentTypes = ownWorkingEntries.length
    ? unplacedWorkingAgentTypes({
        entries: ownWorkingEntries,
        hasTab: knownTabPredicate(tabsByWorktree),
        now
      })
    : EMPTY_PERMISSION_YIELDING_AGENT_TYPES
  if (
    terminalPaneIdsByTabId === EMPTY_PANE_IDS_BY_TAB_ID &&
    permissionYieldingAgentTypes.size === 0
  ) {
    return EMPTY_FORK_ACTIVITY_FIELDS
  }
  return { terminalPaneIdsByTabId, permissionYieldingAgentTypes }
}

function knownTabPredicate(
  tabsByWorktree: AgentActivityTabsByWorktree
): (tabId: string) => boolean {
  const known = new Set<string>()
  for (const tabs of Object.values(tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      known.add(tab.id)
    }
  }
  return (tabId) => known.has(tabId)
}

function withPaneId(
  byTabId: Record<string, ReadonlySet<string>>,
  tabId: string,
  paneId: string
): Record<string, ReadonlySet<string>> {
  // Why: the shared empty record is the frozen default for every summary; copy on first write.
  const next = byTabId === EMPTY_PANE_IDS_BY_TAB_ID ? {} : byTabId
  const paneIds = new Set(next[tabId])
  paneIds.add(paneId)
  next[tabId] = paneIds
  return next
}
