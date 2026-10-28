import { resolveAgentTypeFromTerminalTitle } from '@/components/sidebar/worktree-title-derived-agent-rows'
import { classifyTitleActivity } from '@/lib/pane-agent-evidence'
import { tabHasLivePty } from '../../../shared/tab-has-live-pty'
import { resolveRuntimePaneTitleLeafIdFromRoot } from '../../../shared/runtime-pane-title-leaf-id'
import { containsAgentSpinnerGlyph } from '../../../shared/agent-title-core'
import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { isSyntheticAgentPermissionTitle } from '../../../shared/synthetic-agent-title'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentType } from '../../../shared/agent-status-types'
import type { LiveAgentWorktreeStatus } from './worktree-activity-state'

export type WorktreeStatus =
  | 'active'
  | 'working'
  | 'monitoring'
  | 'permission'
  | 'failed'
  | 'interrupted'
  | 'unconfirmed'
  | 'done'
  | 'inactive'
  | 'setup'

type WorktreeStatusHeuristicOptions = {
  liveAgentStatus?: LiveAgentWorktreeStatus
  /** An awake chat tab has no PTY until its first message, but the user sees an open session. */
  hasStructuredChat?: boolean
  agentStatusPaneIdsByTabId?: Record<string, ReadonlySet<string>>
  /** Stale rows suppress Orca's generated permission labels; native title fallback stays live. */
  stalePaneIdsByTabId?: Record<string, ReadonlySet<string>>
  /** Panes whose row records a finish: their cached title must not outlive it. */
  terminalPaneIdsByTabId?: Record<string, ReadonlySet<string>>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  terminalLayoutRootsByTabId?: Record<string, TerminalPaneLayoutNode | null | undefined>
  /**
   * Agent types whose permission *title* may not be believed: a re-keyed pane's own fresh working
   * row survives under a tab this renderer lost, so the leftover `!` it was launched with is not
   * a question. See `unplacedWorkingAgentTypes`.
   */
  permissionYieldingAgentTypes?: ReadonlySet<AgentType>
}

const STATUS_LABELS: Record<WorktreeStatus, string> = {
  active: 'Active',
  working: 'Working',
  monitoring: 'Monitoring background tasks',
  permission: 'Needs permission',
  failed: 'Failed',
  interrupted: 'Interrupted',
  unconfirmed: 'Couldn’t confirm',
  done: 'Done',
  inactive: 'Inactive',
  setup: 'Setting up…'
}

export function getWorktreeStatus(
  tabs: readonly Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>[],
  browserTabs: readonly { id: string }[],
  ptyIdsByTabId: Record<string, string[]>,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>> = {},
  options: WorktreeStatusHeuristicOptions = {}
): WorktreeStatus {
  // Why: tab.ptyId is a wake-hint that survives sleep, not a liveness signal; gate on ptyIdsByTabId, which sleep/kill clear when the PTY dies.
  const liveTabs = tabs.filter((tab) => tabHasLivePty(ptyIdsByTabId, tab.id))

  // Why: tab.title tracks only the most-recently-focused pane (onActivePaneChange in use-terminal-pane-lifecycle.ts); consult per-pane titles so the spinner reflects aggregate tab state.
  const hasStatus = (status: 'permission' | 'working'): boolean =>
    liveTabs.some((tab) => tabHasStatus(tab, runtimePaneTitlesByTabId, status, options))

  if (options.liveAgentStatus === 'permission' || hasStatus('permission')) {
    return 'permission'
  }
  if (options.liveAgentStatus === 'working' || hasStatus('working')) {
    return 'working'
  }
  if (options.liveAgentStatus === 'monitoring') {
    return 'monitoring'
  }
  if (liveTabs.length > 0 || browserTabs.length > 0 || options.hasStructuredChat) {
    // Why: browser-only and chat-only worktrees (no PTY) are still active from the user's point of view.
    return 'active'
  }
  return 'inactive'
}

function tabHasStatus(
  tab: Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>,
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>,
  status: 'permission' | 'working',
  options: WorktreeStatusHeuristicOptions
): boolean {
  const suppressionPaneIds = titleSuppressionPaneIds(tab, status, options)
  const permissionPaneIds = status === 'permission' ? recordedPaneIds(tab.id, options) : undefined
  const paneTitles = runtimePaneTitlesByTabId[tab.id]
  if (paneTitles && Object.keys(paneTitles).length > 0) {
    const tabLayoutRoot =
      options.terminalLayoutRootsByTabId?.[tab.id] ?? options.terminalLayoutsByTabId?.[tab.id]?.root
    const paneTitleEntries = Object.entries(paneTitles)
    for (const [runtimePaneId, title] of paneTitleEntries) {
      const agentStatusPaneIds =
        status === 'permission' && isSyntheticAgentPermissionTitle(title)
          ? permissionPaneIds
          : suppressionPaneIds
      const leafId = resolveRuntimePaneTitleLeafIdFromRoot(tabLayoutRoot, runtimePaneId)
      // Why: runtime titles can precede layout hydration (SSH/replay); with one title and one agent row, prefer that row over a stale spinner.
      const hasSingleUnmappedAgentStatusPane =
        leafId === null && agentStatusPaneIds?.size === 1 && paneTitleEntries.length === 1
      if (
        agentStatusPaneIds?.has(runtimePaneId) ||
        (leafId !== null && agentStatusPaneIds?.has(leafId)) ||
        hasSingleUnmappedAgentStatusPane
      ) {
        continue
      }
      if (
        classifyTitleActivity(title) === status &&
        titleStatusIsAgentAttributable(title, tab.launchAgent) &&
        !titlePermissionYields(title, status, options)
      ) {
        return true
      }
    }
    return false
  }
  // Why: a tab title can't identify its pane; once an agent row owns one, prefer the row over a completed pane's stale "working" title.
  const agentStatusPaneIds =
    status === 'permission' && isSyntheticAgentPermissionTitle(tab.title)
      ? permissionPaneIds
      : suppressionPaneIds
  if (agentStatusPaneIds && agentStatusPaneIds.size > 0) {
    return false
  }
  return (
    classifyTitleActivity(tab.title) === status &&
    titleStatusIsAgentAttributable(tab.title, tab.launchAgent) &&
    !titlePermissionYields(tab.title, status, options)
  )
}

/**
 * Whether this title's permission claim must be ignored: the agent that owns it has a fresh
 * `working` row filed under a tab this renderer lost, which is what a pane re-keyed on restore
 * leaves behind. The row reports the work, so the leftover `!` marker is not a question — and
 * only that agent type yields, so another agent's dialog in the worktree still needs input.
 */
function titlePermissionYields(
  title: string,
  status: 'permission' | 'working',
  options: WorktreeStatusHeuristicOptions
): boolean {
  const yielding = options.permissionYieldingAgentTypes
  if (status !== 'permission' || !yielding || yielding.size === 0) {
    return false
  }
  const agentType = resolveAgentTypeFromTerminalTitle(title)
  return agentType !== null && yielding.has(agentType)
}

/**
 * Pane ids whose title must not drive `status` for this tab. A mirrored tab's title is the host's
 * last report, cached with no age of its own — unlike a row, which decays — so a row that records
 * a finish quiets it at any age. A local tab's title is live renderer state, where a live working
 * title still outranks a stale row, and stale rows suppress synthetic permission labels only.
 * Returns an existing set unchanged when nothing has to be added, so the common path allocates
 * nothing.
 */
function titleSuppressionPaneIds(
  tab: Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>,
  status: 'permission' | 'working',
  options: WorktreeStatusHeuristicOptions
): ReadonlySet<string> | undefined {
  if (status === 'working' && isWebTerminalSurfaceTabId(tab.id)) {
    return unionPaneIds(
      options.agentStatusPaneIdsByTabId?.[tab.id],
      options.terminalPaneIdsByTabId?.[tab.id]
    )
  }
  return options.agentStatusPaneIdsByTabId?.[tab.id]
}

/** Every pane with a recorded row, fresh or stale. */
function recordedPaneIds(
  tabId: string,
  options: WorktreeStatusHeuristicOptions
): ReadonlySet<string> | undefined {
  return unionPaneIds(
    options.agentStatusPaneIdsByTabId?.[tabId],
    options.stalePaneIdsByTabId?.[tabId]
  )
}

/** Returns `first` itself when there is nothing to add, so the common path allocates nothing. */
function unionPaneIds(
  first: ReadonlySet<string> | undefined,
  second: ReadonlySet<string> | undefined
): ReadonlySet<string> | undefined {
  if (!second || second.size === 0) {
    return first
  }
  if (!first || first.size === 0) {
    return second
  }
  return new Set([...first, ...second])
}

// Why: require agent attribution so a bare never-cleared spinner title can't spin the dot "0 agents" forever with no matching sidebar row.
function titleStatusIsAgentAttributable(title: string, launchAgent?: TuiAgent | null): boolean {
  if (resolveAgentTypeFromTerminalTitle(title) !== null) {
    return true
  }
  // Spinner proves activity, not provider (Claude titles lack it, #9040); use launch identity like sidebar rows (#9647).
  return containsAgentSpinnerGlyph(title) && Boolean(launchAgent)
}

export function getWorktreeStatusLabel(status: WorktreeStatus): string {
  return STATUS_LABELS[status]
}

/**
 * Apply the WorktreeCard priority overlay on top of the title-heuristic base. Explicit agent rows may
 * promote the dot; sleep cleanup owns removing stale retained rows.
 *
 * Map args are narrowed to this worktree. `hasPermission`/`hasLiveWorking`/
 * `hasLiveDone` are fresh hook entries ({blocked,waiting} / {working} / {done});
 * `hasRetainedDone`/`hasRetainedFailed` are retained-agent snapshots scoped to this worktreeId.
 */
export function resolveWorktreeStatus(args: {
  tabs: readonly Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>[]
  browserTabs: readonly { id: string }[]
  hasStructuredChat?: boolean
  ptyIdsByTabId: Record<string, string[]>
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  agentStatusPaneIdsByTabId?: Record<string, ReadonlySet<string>>
  stalePaneIdsByTabId?: Record<string, ReadonlySet<string>>
  terminalPaneIdsByTabId?: Record<string, ReadonlySet<string>>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  terminalLayoutRootsByTabId?: Record<string, TerminalPaneLayoutNode | null | undefined>
  permissionYieldingAgentTypes?: ReadonlySet<AgentType>
  hasPermission: boolean
  hasLiveWorking: boolean
  hasLiveMonitoring?: boolean
  hasFailed?: boolean
  hasInterrupted?: boolean
  hasUnconfirmed?: boolean
  hasLiveDone: boolean
  hasRetainedDone: boolean
  hasRetainedFailed?: boolean
  /** The repo setup script is still running in this worktree. Host-observed, so
   *  it covers a worktree whose only live PTY is the setup runner. */
  setupRunning?: boolean
}): WorktreeStatus {
  const heuristic = getWorktreeStatus(
    args.tabs,
    args.browserTabs,
    args.ptyIdsByTabId,
    args.runtimePaneTitlesByTabId ?? {},
    {
      hasStructuredChat: args.hasStructuredChat,
      agentStatusPaneIdsByTabId: args.agentStatusPaneIdsByTabId,
      stalePaneIdsByTabId: args.stalePaneIdsByTabId,
      terminalPaneIdsByTabId: args.terminalPaneIdsByTabId,
      terminalLayoutsByTabId: args.terminalLayoutsByTabId,
      terminalLayoutRootsByTabId: args.terminalLayoutRootsByTabId,
      permissionYieldingAgentTypes: args.permissionYieldingAgentTypes
    }
  )
  if (args.hasPermission) {
    return 'permission'
  }
  // Why: heuristic 'permission' outranks heuristic 'working' — the user-actionable signal wins when panes in one tab disagree.
  if (heuristic === 'permission') {
    return 'permission'
  }
  // Why: a failure is news, so it outranks live work (a failed main agent's subagents may still
  // run); only a pending question comes first.
  if (args.hasFailed) {
    return 'failed'
  }
  // Why: restored cards get the hook snapshot before panes mount; trust the explicit working row so they stay yellow on restart.
  if (args.hasLiveWorking || heuristic === 'working') {
    return 'working'
  }
  if (args.hasLiveMonitoring || heuristic === 'monitoring') {
    return 'monitoring'
  }
  // Why: setup outranks the outcome states below — a worktree being set up has no
  // agent verdict yet, and its runner would otherwise read as plain 'active'.
  if (args.setupRunning) {
    return 'setup'
  }
  // Why: a departed agent's failure has no expiry, so it must not pin the card over live work.
  if (args.hasRetainedFailed) {
    return 'failed'
  }
  // Why: an end Orca cannot prove is not a finish, and unlike a user's Stop it is news.
  if (args.hasUnconfirmed) {
    return 'unconfirmed'
  }
  // A user's Stop follows every state that is news, but must not collapse into success.
  if (args.hasInterrupted) {
    return 'interrupted'
  }
  if (args.hasLiveDone || args.hasRetainedDone) {
    return 'done'
  }
  return heuristic
}
