/**
 * Second half of the `onHostSync` audit table; merged in `host-sync-settings-disposition.ts`, which
 * holds the rule and the `satisfies` check over every `GlobalSettings` key. Split only because the
 * whole table crossed the repo's `max-lines` cap, and this file is fork-owned so the cap is a free
 * guard here (LOCAL-PATCHES.md § `local(lint)`).
 */
export const HOST_SYNC_DISPOSITION_ROWS_B = {
  floatingTerminalEnabled: 'replicated',
  browserClientHostedRemoteEnabled: 'replicated',
  browserProfileScope: 'replicated',
  browserSshWorkspaceRoutingEnabled: 'replicated',
  floatingTerminalTriggerLocation: 'replicated',
  keybindings: 'replicated',
  diffDefaultView: 'replicated',
  diffWordWrap: 'replicated',
  diffShowWhitespace: 'replicated',
  diffCollapseUnchangedRegions: 'replicated',
  combinedDiffFileTreeVisibleByDefault: 'replicated',
  prBotAuthorOverrides: 'replicated',
  notifications: 'replicated',
  promptCacheTimerEnabled: 'replicated',
  promptCacheTtlMs: 'replicated',
  // Why host-local: each account entry carries a managed home path, a WSL distro and a WSL home path
  // (see `managed-account-types.ts`), so the same list on a host that has neither names directories that
  // do not exist there. The *active* selections were already host-local for the same reason.
  codexManagedAccounts: 'hostLocal',
  claudeManagedAccounts: 'hostLocal',
  // Why telemetry is host-local: it carries an install id, so replicating it merges every machine into
  // one telemetry identity. Only the opt-in itself is a user decision, and that is not separable here.
  telemetry: 'hostLocal',
  // Why voice is host-local: it carries a models directory, a microphone device id, and a flag for
  // whether an OpenAI key is configured — the last of which would claim a key this host does not have.
  voice: 'hostLocal',
  // Why these two are host-local despite holding secrets: they are secrets in a plaintext settings file
  // with no ledger and no revocation, so replicating them would put a credential on a host that
  // `revokeReplicatedCredential` cannot reach. They belong in a credential port first.
  opencodeSessionCookie: 'hostLocal',
  agentDefaultEnv: 'hostLocal',
  // Why consent to run plugin code is per machine: it is a statement about what the user trusts *this*
  // install to execute.
  pluginConsents: 'hostLocal',
  // Why the terminal troubleshooting kill switches stay local: they are escape hatches for a fault on a
  // particular machine, and a host that inherits one is silently in a different mode from the main.
  terminalHiddenWorktreeRetentionBudget: 'hostLocal',
  browserGuestWorktreeRetentionBudget: 'hostLocal',
  terminalMainSideEffectAuthority: 'hostLocal',
  terminalHiddenDeliveryGate: 'hostLocal',
  terminalModelQueryAuthority: 'hostLocal',
  // Why replicated, like `defaultTuiAgent`: a new-workspace launch preference, not a machine fact.
  newWorkspaceSetupOnly: 'replicated',
  defaultTuiAgent: 'replicated',
  disabledTuiAgents: 'replicated',
  pluginSystemEnabled: 'replicated',
  disabledPlugins: 'replicated',
  skipDeleteWorktreeConfirm: 'replicated',
  deleteRemoteBranchOnWorkspaceDelete: 'replicated',
  alwaysForceDeleteWorktrees: 'replicated',
  skipCloseTerminalWithRunningProcessConfirm: 'replicated',
  skipDeleteAutomationConfirm: 'replicated',
  skipDeleteArtifactConfirm: 'replicated',
  skipCodexRateLimitResetConfirm: 'replicated',
  opencodeWorkspaceId: 'replicated',
  minimaxGroupId: 'replicated',
  minimaxUsageModels: 'replicated',
  minimaxEndpoint: 'replicated',
  zcodePlanSite: 'replicated',
  geminiCliOAuthEnabled: 'replicated',
  disabledUsageProviders: 'replicated',
  agentDefaultArgs: 'replicated',
  agentPermissionDefault: 'replicated',
  agentPermissionOverrides: 'replicated',
  agentStatusHooksEnabled: 'replicated',
  agentStateRulesLiveUpdates: 'replicated',
  agentWorkspaceTrustEnabled: 'replicated',
  codexTerminalServerIsolation: 'replicated',
  tabAutoGenerateTitle: 'replicated',
  confirmClosePinnedTab: 'replicated',
  editorPreviewTabsEnabled: 'replicated',
  terminalMacOptionAsAlt: 'replicated',
  terminalJISYenToBackslash: 'replicated',
  experimentalMobile: 'replicated',
  mobileAutoRestoreFitMs: 'replicated',
  experimentalPet: 'replicated',
  experimentalSidekick: 'replicated',
  experimentalActivity: 'replicated',
  experimentalAgentDashboardPopout: 'replicated',
  // Why replicated: a feature flag the user turned on, like the other experimental keys.
  experimentalConnectors: 'replicated',
  experimentalBrowserExtensions: 'replicated',
  experimentalAgentDashboardShowIdle: 'replicated',
  experimentalAgentDashboardCardClickAction: 'replicated',
  experimentalTerminalAttention: 'replicated',
  experimentalAgentHibernation: 'replicated',
  agentHibernationIdleMs: 'replicated',
  experimentalNewWorktreeCardStyle: 'replicated',
  compactWorktreeCards: 'replicated',
  experimentalCompactWorktreeCards: 'replicated',
  githubProjects: 'replicated',
  commitMessageAi: 'replicated',
  sourceControlAi: 'replicated',
  sessionSummaryAi: 'replicated',
  gitlabProjects: 'replicated',
  aiVaultSearch: 'replicated',
  defaultTaskViewPreset: 'replicated',
  defaultTaskSource: 'replicated',
  visibleTaskProviders: 'replicated',
  defaultLinearTeamSelection: 'replicated',
  defaultJiraBoard: 'replicated',
  // Why replicated, like `defaultJiraBoard`: a naming preference for suggested workspace/branch names.
  jiraIssueKeyCasing: 'replicated',
  // Why replicated: deliberate preferences, not bookkeeping or a machine fact.
  alwaysForceDeletePreservedBranches: 'replicated',
  claudeAccountSwitchRunningSessions: 'replicated',
  nativeChatProviders: 'replicated',
  // Why hostLocal: a `…Migrated…` marker — copying it would suppress the host's own migration.
  sshRemoteCliControlExistingHostsMigrated: 'hostLocal',
  // Why hostLocal: a `…MigrationApplied` marker — copying it would suppress the host's own run.
  uiLanguagePortugueseMigrationApplied: 'hostLocal',
  claudeCopiedSystemDefaultNoticeDismissed: 'hostLocal',
  // Why replicated: preferences and per-host selections a user made, not machine capabilities.
  // `browserDefaultProfileIdByHostId` names a profile per host, so the main is the authority.
  browserDefaultProfileIdByHostId: 'replicated',
  codexShareHistoryAcrossAccounts: 'replicated',
  nativeChatLinkPreviews: 'replicated',
  pluginAppTheme: 'replicated',
  pluginAppThemeDark: 'replicated',
  pluginAppThemeLight: 'replicated',
  pluginDismissedFileTypes: 'replicated',
  pluginFileTypeSuggestions: 'replicated',
  pluginIconTheme: 'replicated',
  pluginUpdatePolicy: 'replicated',
  terminalPluginPalettes: 'replicated',
  themeBeforePlugin: 'replicated',
  // Why replicated, like `autoRenameBranchFromWorkDefaultedOn`: a one-shot default marker that must
  // follow the user's preference rather than re-fire a default on a host that has not seen it.
  pluginSystemDefaultedOn: 'replicated',
  // Why hostLocal, like `httpProxyUrl`: which mirror of nodejs.org this network can reach.
  nodeDistMirrorUrl: 'hostLocal',
  // 2026-11-01 sync: upstream added these. Appearance and feature flags are deliberate preferences,
  // so they replicate like the keys above them.
  agentDefaultSurface: 'replicated',
  codeFontSmoothing: 'replicated',
  editorFontSize: 'replicated',
  editorFontWeight: 'replicated',
  editorLigatures: 'replicated',
  editorLineHeight: 'replicated',
  editorThemeDark: 'replicated',
  editorThemeLight: 'replicated',
  experimentalPluginIsolatedFrames: 'replicated',
  orchestrationWorkerAutoReleaseEnabled: 'replicated',
  reduceVisualEffects: 'replicated',
  terminalColorOverridesLight: 'replicated',
  terminalColorOverridesSplit: 'replicated',
  // Why replicated, like `windowBackgroundBlur`: the same window preference, not a hardware probe.
  windowMaterial: 'replicated',
  // Why replicatedOnlyIfEmpty: a remembered-choice map, so it fills a host that has none and never
  // overwrites choices the user made there.
  agentLaunchChoices: 'replicatedOnlyIfEmpty',
  // Why hostLocal, like `pluginConsents`: it is a statement about what the user trusts *this*
  // install's frames to reach, and the settings type itself calls it main-only.
  pluginExternalHostGrants: 'hostLocal',
  // Why hostLocal: the offer is about *this* machine's WSL, and copying it would suppress a host's own.
  wslHostOfferDismissed: 'hostLocal',
  // Why hostLocal: which GCP project and location this install's Antigravity chat signs in against.
  antigravityChatAuth: 'hostLocal',
  // Why hostLocal: the devices are the ones this machine can reach, not a preference.
  mobileEmulatorRecentDevices: 'hostLocal',
  mobileEmulatorOpeningMode: 'replicated',
  // Why hostLocal: a "already told this host" ledger; copying it suppresses the notice there.
  desktopBrowserBridgeNoticedTargetIds: 'hostLocal',
  nativeChatScrollToLatestOnSend: 'replicated',
  nativeChatTurnDiffSummary: 'replicated',
  nativeChatCiResultLines: 'replicated',
  nativeChatIdleStopMinutes: 'replicated',
  pluginReplacementsOff: 'replicated',
  terminalScrollOnUserInput: 'replicated',
  editorFormatOnSave: 'replicated',
  editorInsertFinalNewline: 'replicated',
  browserPasswordsOfferToSave: 'replicated',
  browserPasswordsFillRequiresReauth: 'replicated',
  // Why hostLocal: a one-shot migration marker; a host that already migrated must not be re-run.
  nestedWorkerMaxDepthDefaultedToFour: 'hostLocal',
  agentWorkspaceTrustExistingReposMigrated: 'hostLocal',
  // Why hostLocal: the rollout cohort this install was seeded into, not a user choice.
  searchKeybindingSeed: 'hostLocal',
  nonMacSearchKeybindingSeed: 'hostLocal',
  updateDelayDays: 'replicated',
  markdownDefaultViewMode: 'replicated',
  // Why hostLocal: a notice marker for a Windows font-weight default, which only Windows has.
  terminalFontWeightWindowsRegular: 'hostLocal',
  claudeCodeThemeSync: 'replicated',
  claudeCodeThemeSyncOffer: 'replicated',
  nativeChatAutoContinueAfterUsageLimit: 'replicated',
  nativeChatOpenedPullRequests: 'replicated',
  experimentalOrchestrationPanel: 'replicated'
} as const
