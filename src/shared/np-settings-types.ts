import type { SessionSummaryAiSettings } from './session-summary-ai-types'
import type { DisableableUsageProviderId } from './usage-provider-enablement'
import type { AgentDashboardCardClickAction } from './ui-chrome/ui-chrome-types'
import type { JiraBoardSelection } from './jira/jira-types'
import type { OrcaWorkspaceLayoutSettings } from './worktree/paths/orca-workspace-layout'

/** Global settings this fork adds on top of upstream's `GlobalSettings`.
 *  Declared here and intersected so the upstream-owned `global-settings-types.ts`
 *  does not carry the fork's line budget. */
export type NpSettings = {
  /** Whether GitHub PR review threads are drawn inline on their commented lines in the code.
   *  Hiding them keeps a small gutter marker per thread rather than removing the thread entirely. */
  prCommentsInlineEnabled: boolean
  /** Opt-in stall logging for UI-hang diagnosis; off by default. Records renderer/main event-loop stalls and Electron unresponsive windows to logs/ui-hangs.ndjson. */
  uiHangDiagnosticsEnabled?: boolean
  /** Why: `git push --delete` has no server-side refusal to fall back on, so the delete dialog's
   *  remote-branch checkbox starts unchecked and only this setting can change that. */
  deleteRemoteBranchOnWorkspaceDelete: boolean
  /** Usage providers the user switched off: Orca neither polls them nor reads their
   *  local CLI/IDE credentials. Absent/empty means every provider is enabled. */
  disabledUsageProviders?: DisableableUsageProviderId[]
  /** What clicking an Agent Dashboard card does. Defaults to opening the agent's workspace. */
  experimentalAgentDashboardCardClickAction?: AgentDashboardCardClickAction
  /** Which agent and model fold a session summary on view. Separate from source-control AI so summary cost is tunable on its own. */
  sessionSummaryAi?: SessionSummaryAiSettings
  /** The Jira boards the Tasks switcher offers, in the user's order. `null` (or empty) means
   *  sticky-all: every board the account can see. The last board picked on this device is stored
   *  separately, so the set stays a curated list rather than a selection. */
  defaultJiraBoards?: JiraBoardSelection[] | null
  /** Legacy single board, still written as the first of `defaultJiraBoards` so older builds and
   *  replicated hosts keep showing a board. Also the issue-list fallback when the set is empty. */
  defaultJiraBoard: JiraBoardSelection | null
} & OrcaWorkspaceLayoutSettings
