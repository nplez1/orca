import { create, type StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Worktree } from '../../../../shared/worktree/types'
import { createRepoSlice } from '../repos/create-repo-slice'
import { createSparsePresetsSlice } from './worktrees/create/sparse-presets'
import { createWorktreeSlice } from './worktrees/create-worktree-slice'
import { createTerminalSlice } from '../terminals/create-terminal-slice'
import { createTabsSlice } from './tabs/create-tabs-slice'
import { createUISlice } from './ui/create-ui-slice'
import { createSettingsSlice } from './settings/create-settings-slice'
import { createKeybindingsSlice } from './keybindings/keybindings'
import { createGitHubSlice } from '../github/github'
import { createHostedReviewSlice } from './hosted-review/hosted-review'
import { createLinearSlice } from './linear/linear'
import { createPreflightSlice } from './preflight/preflight'
import { createJiraSlice } from './jira/jira'
import { createEditorSlice } from './editor/create-editor-slice'
import { createStatsSlice } from './process-stats/stats'
import { createMemorySlice } from './process-stats/memory'
import { createWorkspaceSpaceSlice } from './workspace-cleanup/workspace-space'
import {
  createClaudeUsageSlice,
  createCodexUsageSlice,
  createMuseUsageSlice,
  createOpenCodeUsageSlice
} from './usage/usage-provider-slices'
import { createBrowserSlice } from './browser/create-browser-slice'
import { createRateLimitSlice } from './usage/rate-limits'
import { createSshSlice } from './ssh/create-ssh-slice'
import { createRuntimeEnvironmentSshSlice } from './ssh/runtime-environment-ssh'
import { createWslHostsSlice } from './wsl/wsl-hosts'
import { createAgentStatusSlice } from './agent-status/agent-status'
import { createPaneForegroundAgentSlice } from './agent-status/pane-foreground-agent'
import { createDiffCommentsSlice } from './diff-comments/create-diff-comments-slice'
import { createDetectedAgentsSlice } from './agent-inventory/create-detected-agents-slice'
import { createRuntimeDetectedAgentsSlice } from './agent-inventory/runtime-detected-agents'
import { createWorktreeNavHistorySlice } from './ui/workspace-navigation-history'
import { createDictationSlice } from './dictation/dictation'
import { createWorkspaceCleanupSlice } from './workspace-cleanup/create-workspace-cleanup-slice'
import { createWorkspaceCleanupBrowseSlice } from './workspace-cleanup/workspace-cleanup-browse'
import { createRuntimeStatusSlice } from './runtime-status/create-runtime-status-slice'
import { createPullRequestGenerationSlice } from './hosted-review/generation/pull-request-generation'
import { createCommitMessageGenerationSlice } from './hosted-review/generation/commit-message-generation'
import { createPinnedTabCloseConfirmSlice } from './tabs/pinned-tab-close-confirm'
import { createRecentlyClosedTerminalTabsSlice } from '../terminals/recently-closed-terminal-tabs'
import { createRecentlyClosedTabsSlice } from './tabs/recently-closed-tabs'
import { createOrcaProfilesSlice } from './orca-profiles/create-orca-profiles-slice'
import { createNewIssueDraftSlice } from './task-creation/new-issue-draft'
import { createFeedbackDraftSlice } from './feedback/feedback-draft'
import { createTaskCreationDraftsSlice } from './task-creation/task-creation-drafts'
import { createRemoteServerUpdatesSlice } from './runtime-host-updates/remote-server-updates'
import { createTerminalQuickCommandHostsSlice } from '../terminals/terminal-quick-command-hosts'
import { createStructuredSessionLaunchDirectorySlice } from './agent-status/structured-session-launch-directories'
import { createWorktreeSetupRunnerSlice } from './worktree-setup-runner'
import { createStructuredChatSleptAtSlice } from './agent-status/structured-chat-slept-at'
import { createWorkspaceAttentionSlice } from './workspace-attention/workspace-attention-slice'
import { createForkUiSlice } from './fork-ui'
import '@/i18n/i18n'
import { withEditorBufferRecords } from './editor/buffers/editor-buffer-record-lifecycle'
import { withAgentConversationRetention } from './agent-status/agent-conversation-retention'
import { makeWorktree } from './worktrees/worktree.test-fixture'
import { TEST_REPO } from '../repos/repo.test-fixture'
export { makeWorktree } from './worktrees/worktree.test-fixture'
export { TEST_REPO } from '../repos/repo.test-fixture'
export { makeTab, makeLayout } from '../terminals/terminal-tab.test-fixture'
export { makeOpenFile } from './editor/types/open-file.test-fixture'
export { makeUnifiedTab, makeTabGroup } from './tabs/tab-group.test-fixture'

const withTestStorePolicies = (creator: StateCreator<AppState, [], []>, check: boolean) =>
  withEditorBufferRecords(withAgentConversationRetention(creator), check)

export function createTestStore() {
  // Why the record middleware: views of one file share a record only through it, as in the app.
  return create<AppState>()(
    withTestStorePolicies(
      (...a) => ({
        ...createRepoSlice(...a),
        ...createSparsePresetsSlice(...a),
        ...createWorktreeSlice(...a),
        ...createTerminalSlice(...a),
        ...createTabsSlice(...a),
        ...createUISlice(...a),
        ...createSettingsSlice(...a),
        ...createKeybindingsSlice(...a),
        ...createGitHubSlice(...a),
        ...createHostedReviewSlice(...a),
        ...createLinearSlice(...a),
        ...createPreflightSlice(...a),
        ...createJiraSlice(...a),
        ...createEditorSlice(...a),
        ...createStatsSlice(...a),
        ...createMemorySlice(...a),
        ...createWorkspaceSpaceSlice(...a),
        ...createClaudeUsageSlice(...a),
        ...createCodexUsageSlice(...a),
        ...createOpenCodeUsageSlice(...a),
        ...createMuseUsageSlice(...a),
        ...createBrowserSlice(...a),
        ...createRateLimitSlice(...a),
        ...createSshSlice(...a),
        ...createRuntimeEnvironmentSshSlice(...a),
        ...createWslHostsSlice(...a),
        ...createAgentStatusSlice(...a),
        ...createPaneForegroundAgentSlice(...a),
        ...createDiffCommentsSlice(...a),
        ...createDetectedAgentsSlice(...a),
        ...createRuntimeDetectedAgentsSlice(...a),
        ...createWorktreeNavHistorySlice(...a),
        ...createDictationSlice(...a),
        ...createWorkspaceCleanupSlice(...a),
        ...createWorkspaceCleanupBrowseSlice(...a),
        ...createRuntimeStatusSlice(...a),
        ...createPullRequestGenerationSlice(...a),
        ...createCommitMessageGenerationSlice(...a),
        ...createPinnedTabCloseConfirmSlice(...a),
        ...createRecentlyClosedTerminalTabsSlice(...a),
        ...createRecentlyClosedTabsSlice(...a),
        ...createOrcaProfilesSlice(...a),
        ...createNewIssueDraftSlice(...a),
        ...createFeedbackDraftSlice(...a),
        ...createTaskCreationDraftsSlice(...a),
        ...createRemoteServerUpdatesSlice(...a),
        ...createTerminalQuickCommandHostsSlice(...a),
        ...createStructuredSessionLaunchDirectorySlice(...a),
        ...createWorktreeSetupRunnerSlice(...a),
        ...createStructuredChatSleptAtSlice(...a),
        ...createWorkspaceAttentionSlice(...a),
        ...createForkUiSlice(...a)
      }),
      true
    )
  )
}

export function seedStore(
  store: ReturnType<typeof createTestStore>,
  state: Partial<AppState>
): void {
  // Centralize fixture to keep cascade suites within max-lines limits without suppressing growth checks.
  store.setState({
    repos: [{ ...TEST_REPO, executionHostId: 'local' }],
    ...state
  })
}

export function makeRuntimeOwnedWorktree(
  overrides: Partial<Worktree> & { id: string; repoId: string },
  runtimeEnvironmentId = 'runtime-1'
): Worktree {
  return makeWorktree({
    ...overrides,
    hostId: overrides.hostId ?? 'local',
    runtimeOwnerEnvironmentId: runtimeEnvironmentId
  })
}

/** A repo stamped as owned by `environmentId`, the way ingest stamps fetched rows. */
export function runtimeOwnedRepoState(
  environmentId: string,
  id: string,
  path: string,
  extra: Partial<AppState> = {}
): Partial<AppState> {
  return {
    repos: [
      {
        id,
        path,
        displayName: 'repo',
        badgeColor: '',
        addedAt: 0,
        executionHostId: `runtime:${environmentId}`
      }
    ],
    ...extra
  }
}
