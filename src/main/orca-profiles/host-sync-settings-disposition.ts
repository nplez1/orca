import type { GlobalSettings } from '../../shared/global-settings-types'

/** What host-settings replication does with one `GlobalSettings` property. */
export type SettingsFieldHostSyncDisposition =
  /** The main's value wins and the host applies it. */
  | 'replicated'
  /** Never leaves or arrives: it describes *this* machine. */
  | 'hostLocal'
  /** Fills a host that has nothing, and never overwrites a deliberate local value. */
  | 'replicatedOnlyIfEmpty'

/**
 * The `onHostSync` audit of every persisted setting: what one machine replicates to another.
 *
 * The three questions that decide a key, in order:
 *
 * 1. **Does the value name something only this machine has?** A path, a shell binary, an installed
 *    editor, a WSL distro, a GPU, an emulator device, an SSH target, a proxy for this network, the
 *    pairing address of this machine — those are `hostLocal`, because the same value on another host
 *    is either meaningless or actively wrong. This is the fork's own `hostLocal` example list, applied
 *    key by key, and it is why `terminalDefaultShell` is host-local while `terminalFontSize` is not:
 *    one names a binary, the other a preference.
 * 2. **Does the value record that this install already did something once?** `…Defaulted…`,
 *    `…Migrated…`, `…Seed`, `…Dismissed`, "…shown" and the history maps are
 *    `replicatedOnlyIfEmpty`-or-`hostLocal` bookkeeping. Copying a `…Migrated` flag to a fresh host
 *    would suppress that host's own migration, so those are `hostLocal` rather than
 *    `replicatedOnlyIfEmpty`; a history map is `replicatedOnlyIfEmpty`, because it should fill a host
 *    that has none and never overwrite one the user built.
 * 3. **Otherwise it is a deliberate preference or connection** — appearance, editor, terminal
 *    appearance, notifications, agent defaults, task sources, feature flags, skip-confirmation
 *    choices — and it is `replicated`, so a new machine is configured the way the user already
 *    configured the old one.
 *
 * The arguable calls, named so a reviewer can disagree with a specific one rather than the scheme:
 *
 * - `terminalGpuAcceleration`, `keepComputerAwakeWhileAgentsRun`, `computerAwakeMode` and
 *   `experimentalEphemeralVms` are `hostLocal`: each is a hardware or power decision, and the same
 *   answer on a machine without the hardware is a bug the user sees as a crash or a flat battery.
 * - `httpProxyUrl`, `httpProxyBypassRules` and `electronHttp1CompatibilityMode` are `hostLocal`: a
 *   laptop's corporate proxy and its HTTP/1 workaround do not describe a machine on another network.
 * - `codexManagedAccounts` and `claudeManagedAccounts` are `replicated` while the four
 *   `active…ManagedAccountId(sByRuntime)` keys are `hostLocal`: the list of accounts is the user's, but
 *   which one is *active* resolves against what is installed here.
 * - `opencodeSessionCookie` is `replicated` and is a secret living in a settings file rather than in
 *   the credential stores. It is in scope for the same reason the API keys are, and it is the one
 *   entry here that the credentials policy does not yet cover — see the note at the end.
 * - `telemetry` is `replicated`: consent is a decision the user made, not a property of the machine.
 * - `defaultRepoSelection` is `hostLocal` because a repository registration is host-local, so a
 *   default selection naming one cannot travel; `defaultLinearTeamSelection`, `defaultJiraBoard` and
 *   `defaultTaskSource` are `replicated` because they name an integration rather than a local path.
 * - `agentCmdOverrides`, `agentStateRulesPath`, `codexSessionSourceHome` and `devPluginPaths` are
 *   `hostLocal`: each is a filesystem path or an executable that exists on the main and may not exist
 *   on the host, which is the same reason `terminalDefaultShell` is host-local.
 *
 * Not covered by this audit: whether a `replicated` value is *safe* to send. That is the credentials
 * policy in `src/main/host-sync/`, which refuses a sealed value on a host that cannot seal it; a
 * settings value has no equivalent protection today, which is why the inventory is a contract rather
 * than an implementation.
 */
export const GLOBAL_SETTINGS_HOST_SYNC_DISPOSITION = {
  // ---- hostLocal: names something only this machine has ------------------------------
  workspaceDir: 'hostLocal',
  hostSettingOverrides: 'hostLocal',
  terminalGpuAcceleration: 'hostLocal',
  terminalWindowsShell: 'hostLocal',
  terminalDefaultShell: 'hostLocal',
  terminalDefaultShellArgs: 'hostLocal',
  terminalWindowsWslDistro: 'hostLocal',
  terminalWindowsPowerShellImplementation: 'hostLocal',
  localAccountRuntime: 'hostLocal',
  localAccountWslDistro: 'hostLocal',
  localAgentRuntime: 'hostLocal',
  localAgentWslDistro: 'hostLocal',
  localWindowsRuntimeDefault: 'hostLocal',
  httpProxyUrl: 'hostLocal',
  httpProxyBypassRules: 'hostLocal',
  electronHttp1CompatibilityMode: 'hostLocal',
  nativeChatInheritShellEnvironment: 'hostLocal',
  nativeChatShellEnvironmentVariables: 'hostLocal',
  openInApplications: 'hostLocal',
  browserSshWorkspaceRoutingDisabledTargetIds: 'hostLocal',
  browserSshWorkspaceRoutingProbeSkippedTargetIds: 'hostLocal',
  floatingTerminalCwd: 'hostLocal',
  floatingTerminalTrustedCwds: 'hostLocal',
  activeCodexManagedAccountId: 'hostLocal',
  activeClaudeManagedAccountId: 'hostLocal',
  activeCodexManagedAccountIdsByRuntime: 'hostLocal',
  activeClaudeManagedAccountIdsByRuntime: 'hostLocal',
  terminalHiddenViewParking: 'hostLocal',
  terminalSshViewParking: 'hostLocal',
  devPluginPaths: 'hostLocal',
  agentCmdOverrides: 'hostLocal',
  codexSessionSourceHome: 'hostLocal',
  agentStateRulesPath: 'hostLocal',
  keepComputerAwakeWhileAgentsRun: 'hostLocal',
  computerAwakeMode: 'hostLocal',
  mobileEmulatorEnabled: 'hostLocal',
  mobileEmulatorDefaultDeviceUdid: 'hostLocal',
  androidSdkPath: 'hostLocal',
  mobilePairingConnectionMode: 'hostLocal',
  mobilePairingCustomAddress: 'hostLocal',
  mobilePairingCustomAddresses: 'hostLocal',
  machineName: 'hostLocal',
  experimentalEphemeralVms: 'hostLocal',
  activeRuntimeEnvironmentId: 'hostLocal',
  defaultRepoSelection: 'hostLocal',

  // ---- one-shot flags that MUST follow the value they guard -------------------------------
  // Why replicated rather than host-local: each flag says "this install already applied the new
  // default". A host that inherits the *value* but not the flag runs its own migration and overwrites
  // the replicated value with the default. Flags whose value is host-local (the shell and runtime ones
  // above) stay host-local for the opposite reason.
  autoRenameBranchFromWorkDefaultedOn: 'replicated',
  primarySelectionMiddleClickPasteDefaultedForLinux: 'replicated',
  primarySelectionMiddleClickPasteDefaultedForTerminalDefaults: 'replicated',
  terminalTuiScrollSensitivityDefaultedToOne: 'replicated',
  terminalCursorStyleDefaultedToBlock: 'replicated',
  terminalRightClickToPasteDefaultedForPlatform: 'replicated',
  terminalAllowOsc52ClipboardDefaultedOnForAllUsers: 'replicated',
  floatingTerminalDefaultedForAllUsers: 'replicated',
  claudeAgentTeamsDefaultDisabledMigrated: 'replicated',
  agentYoloDefaultsMigrated: 'replicated',
  terminalMacOptionAsAltMigrated: 'replicated',
  agentsSidebarMigratedFromExperimental: 'replicated',
  experimentalActivityDefaultedOffForAllUsers: 'replicated',
  tabSwitchKeybindingSeed: 'replicated',
  visibleTaskProvidersDefaultedForJira: 'replicated',

  // ---- hostLocal: one-shot bookkeeping for a value that is itself host-local ---------------
  // Why not replicatedOnlyIfEmpty: "this install already ran the migration" is a fact about this
  // install. A host that inherits the flag skips its own migration and keeps stale state.
  localAccountRuntimeDefaultedToAutoForAllUsers: 'hostLocal',
  floatingTerminalCwdMigratedToAppWorkspace: 'hostLocal',

  // ---- replicatedOnlyIfEmpty: accumulated state that fills a host with nothing -------
  workspaceDirHistory: 'hostLocal',
  localBaseRefSuggestionDismissed: 'replicatedOnlyIfEmpty',
  openLinksInAppPreferencePrompted: 'replicatedOnlyIfEmpty',
  // Why these two replicate despite their names: they are boolean preferences a user set, not
  // accumulated history, so the only-if-empty rule would leave a host with nothing applied.
  terminalScopeHistoryByWorktree: 'replicated',
  codexSharedServerWarning: 'replicated',
  dismissedSkillFreshnessNudges: 'replicatedOnlyIfEmpty',
  agentsSidebarIntroShown: 'replicatedOnlyIfEmpty',

  // ---- replicated: a deliberate preference or connection -----------------------------
  nativeChatAppearance: 'replicated',
  nativeChatAutoName: 'replicated',
  worktreeVisibilityDefaults: 'replicated',
  nestWorkspaces: 'replicated',
  refreshLocalBaseRefOnWorktreeCreate: 'replicated',
  autoRenameBranchFromWork: 'replicated',
  branchPrefix: 'replicated',
  branchPrefixCustom: 'replicated',
  theme: 'replicated',
  leftSidebarAppearanceMode: 'replicated',
  leftSidebarTintColor: 'replicated',
  leftSidebarTintOpacity: 'replicated',
  uiLanguage: 'replicated',
  appIcon: 'replicated',
  appFontFamily: 'replicated',
  editorAutoSave: 'replicated',
  editorAutoSaveDelayMs: 'replicated',
  editorMinimapEnabled: 'replicated',
  editorFontFamily: 'replicated',
  editorWordWrap: 'replicated',
  richMarkdownSpellcheckEnabled: 'replicated',
  markdownReviewToolsEnabled: 'replicated',
  prCommentsInlineEnabled: 'replicated',
  primarySelectionMiddleClickPaste: 'replicated',
  terminalFontSize: 'replicated',
  terminalFontFamily: 'replicated',
  terminalFontWeight: 'replicated',
  terminalFontWeightBold: 'replicated',
  terminalLineHeight: 'replicated',
  terminalScrollSensitivity: 'replicated',
  terminalFastScrollSensitivity: 'replicated',
  terminalTuiScrollSensitivity: 'replicated',
  terminalLigatures: 'replicated',
  terminalInlineImages: 'replicated',
  terminalCursorStyle: 'replicated',
  terminalCursorBlink: 'replicated',
  terminalThemeDark: 'replicated',
  terminalCustomThemes: 'replicated',
  terminalDividerColorDark: 'replicated',
  terminalUseSeparateLightTheme: 'replicated',
  terminalThemeLight: 'replicated',
  terminalDividerColorLight: 'replicated',
  terminalInactivePaneOpacity: 'replicated',
  terminalActivePaneOpacity: 'replicated',
  terminalPaneOpacityTransitionMs: 'replicated',
  terminalDividerThicknessPx: 'replicated',
  terminalBackgroundOpacity: 'replicated',
  terminalMinimumContrastRatio: 'replicated',
  terminalColorOverrides: 'replicated',
  terminalPaddingX: 'replicated',
  terminalPaddingY: 'replicated',
  terminalMouseHideWhileTyping: 'replicated',
  terminalWordSeparator: 'replicated',
  terminalCursorOpacity: 'replicated',
  terminalQuickCommands: 'replicated',
  windowBackgroundBlur: 'replicated',
  minimizeToTrayOnClose: 'replicated',
  showMenuBarIcon: 'replicated',
  terminalRightClickToPaste: 'replicated',
  terminalFocusFollowsMouse: 'replicated',
  terminalClipboardOnSelect: 'replicated',
  terminalCopyTrimsGutter: 'replicated',
  terminalAllowOsc52Clipboard: 'replicated',
  claudeAgentTeamsMode: 'replicated',
  setupScriptLaunchMode: 'replicated',
  terminalScrollbackRows: 'replicated',
  uiHangDiagnosticsEnabled: 'replicated',
  openLinksInApp: 'replicated',
  localhostWorktreeLabelsEnabled: 'replicated',
  openLinksInAppModifierInverts: 'replicated',
  terminalLinkActionPopoverEnabled: 'replicated',
  terminalLinkClickBehavior: 'replicated',
  terminalUrlMiddleClickBehavior: 'replicated',
  experimentalNativeChat: 'replicated',
  nativeChatResumeWorkOnRestart: 'replicated',
  nativeChatQueueFollowUps: 'replicated',
  nativeChatInlineVisuals: 'replicated',
  nativeChatSessionOptions: 'replicated',
  rightSidebarOpenByDefault: 'replicated',
  followSymlinkedDirectories: 'replicated',
  showGitIgnoredFiles: 'replicated',
  sourceControlViewMode: 'replicated',
  sourceControlGroupOrder: 'replicated',
  sourceControlCompareAgainstUpstream: 'replicated',
  showTitlebarAppName: 'replicated',
  showTasksButton: 'replicated',
  showAutomationsButton: 'replicated',
  artifactsEnabled: 'replicated',
  artifactSharingEnabled: 'replicated',
  agentSkillSharingEnabled: 'replicated',
  nestedWorkerMaxDepth: 'replicated',
  showArtifactsButton: 'replicated',
  showSkillsButton: 'replicated',
  showMobileButton: 'replicated',
  showPinnedWorktreesInGroups: 'replicated',
  ctrlTabOrderMode: 'replicated',
  terminalShortcutPolicy: 'replicated',
  floatingTerminalEnabled: 'replicated',
  browserClientHostedRemoteEnabled: 'replicated',
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
  codexManagedAccounts: 'replicated',
  claudeManagedAccounts: 'replicated',
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
  defaultJiraBoard: 'replicated'
} as const satisfies Record<keyof GlobalSettings, SettingsFieldHostSyncDisposition>

/** Keys a host applies from the main, either always or only when it holds nothing. */
export const SETTINGS_FIELDS_REPLICATED_TO_HOSTS = settingsFieldsWith('replicated')

export const SETTINGS_FIELDS_REPLICATED_ONLY_IF_EMPTY = settingsFieldsWith('replicatedOnlyIfEmpty')

export const SETTINGS_FIELDS_HOST_LOCAL = settingsFieldsWith('hostLocal')

/**
 * Why the explicit return type: the table has no `replicated`-free day, but indexing a literal object
 * narrows the union to the values actually present, and a filter for a value that is not there stops
 * compiling the moment the last one is reclassified.
 */
function settingsFieldsWith(
  disposition: SettingsFieldHostSyncDisposition
): (keyof GlobalSettings)[] {
  return Object.keys(GLOBAL_SETTINGS_HOST_SYNC_DISPOSITION)
    .filter(
      (field): field is keyof GlobalSettings => field in GLOBAL_SETTINGS_HOST_SYNC_DISPOSITION
    )
    .filter((field) => GLOBAL_SETTINGS_HOST_SYNC_DISPOSITION[field] === disposition)
}
