import { normalizeNativeChatAppearanceSettings } from '../../../shared/native-chat/native-chat-appearance-settings'
import { getDefaultVoiceSettings } from '../../../shared/constants'
import { normalizePRBotAuthorOverrides } from '../../../shared/pr-bot-author-overrides'
import { normalizeTerminalQuickCommands } from '../../../shared/terminal-quick-commands'
import { normalizeOpenInApplications } from '../../../shared/open-in-applications'
import { normalizeTerminalShortcutPolicy } from '../../../shared/keybindings'
import { normalizeAppIconId } from '../../../shared/app-icon'
import { normalizeTerminalCustomThemes } from '../../../shared/terminal-custom-themes'
import { normalizeTerminalDefaultShell } from '../../../shared/terminal-default-shell'
import { projectSourceControlAiToLegacyCommitMessageAi } from '../../../shared/source-control-ai'
import { normalizeNativeChatShellEnvironmentVariables } from '../../../shared/native-chat/native-chat-shell-environment'
import { publishedLegacyChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import {
  savedChatUiWithTerminalDefaultView,
  stripRetiredGlobalSettings
} from '../applying-settings/terminal-settings-migrations'
import { resolveWorktreeLayoutMode } from '../../../shared/orca-workspace-layout'
import { readLegacySidekickFlag } from '../applying-settings/onboarding-normalization'
import { normalizeMachineName } from '../../../shared/machine-name'
import { normalizeDisabledUsageProviders } from '../../../shared/usage-provider-enablement'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { PreparedLoadedTerminalSettings } from './prepare-loaded-terminal-settings'
import type { PreparedLoadedProfileSettings } from './prepare-loaded-profile-settings'

export function normalizeLoadedGlobalSettings(
  parsed: PersistedState,
  terminal: PreparedLoadedTerminalSettings,
  profile: PreparedLoadedProfileSettings
): PersistedState['settings'] {
  const {
    defaults,
    migratedExternalVisibility,
    migratedTerminalScrollback,
    migratedTerminalTuiScrollSensitivity,
    migratedSourceControlAi,
    migratedOptionAsAlt,
    migratedFloatingTerminalEnabled,
    migratedOsc52Clipboard,
    migratedFloatingTerminalCwd,
    migratedFloatingTerminalTrustedCwds
  } = terminal
  const {
    migratedPortugueseUiLanguage,
    migratedExperimentalActivity,
    migratedAutoRenameBranchFromWork,
    migratedTerminalCursorStyle,
    migratedTerminalLineHeight,
    terminalRightClickToPasteDefaultedForPlatform,
    taskProviderSettings,
    primarySelectionDefaultedForLinux,
    primarySelectionDefaultedForTerminalDefaults,
    migratePrimarySelectionPlatformDefault,
    stampPrimarySelectionTerminalDefaults,
    migratedDisabledTuiAgents,
    migratedAgentYoloDefaults,
    migratedAgentPermission,
    migratedWindowsRuntimeDefault,
    migratedLocalAccountRuntime,
    loadedCompactWorktreeCards,
    mobilePairingCustomAddress,
    mobilePairingCustomAddresses,
    normalizedNotifications,
    normalizedSourceControlGroupOrder
  } = profile

  return {
    ...defaults.settings,
    // Why: the layout mode postdates every settings file written before it, so a profile that
    // carries only the legacy boolean has to say what that boolean meant. Deriving it here makes
    // the persisted object its own marker — an explicit `nestWorkspaces: false` was a deliberate
    // flat choice, and letting the new default replace it would silently switch those users into
    // the layout they turned off. A first run has no `parsed.settings` at all, so it takes the
    // default.
    worktreeLayoutMode:
      parsed.settings?.worktreeLayoutMode ??
      (parsed.settings
        ? resolveWorktreeLayoutMode({ nestWorkspaces: parsed.settings.nestWorkspaces })
        : defaults.settings.worktreeLayoutMode),
    // Why (#7977): v1.4.130 onboarding persisted this as a plain boolean, making the
    // old default indistinguishable from a real opt-in. Preserve stored `true`; only
    // the default changed.
    ...stripRetiredGlobalSettings(parsed.settings),
    // Preserve terminal-first new tabs when retiring the old default-view switch.
    ...(savedChatUiWithTerminalDefaultView(parsed.settings)
      ? { experimentalNativeChat: false }
      : {}),
    nativeChatAppearance: normalizeNativeChatAppearanceSettings(
      parsed.settings?.nativeChatAppearance
    ),
    worktreeVisibilityDefaults: migratedExternalVisibility.defaults,
    prBotAuthorOverrides: normalizePRBotAuthorOverrides(parsed.settings?.prBotAuthorOverrides),
    // Carry the retired sidekick flag into pet settings.
    experimentalPet: parsed.settings?.experimentalPet ?? readLegacySidekickFlag(parsed) ?? false,
    // Migrate old platform defaults once; retain later opt-outs.
    primarySelectionMiddleClickPaste: migratePrimarySelectionPlatformDefault
      ? true
      : (parsed.settings?.primarySelectionMiddleClickPaste ??
        defaults.settings.primarySelectionMiddleClickPaste),
    primarySelectionMiddleClickPasteDefaultedForLinux:
      primarySelectionDefaultedForLinux ||
      (process.platform === 'linux' && migratePrimarySelectionPlatformDefault),
    primarySelectionMiddleClickPasteDefaultedForTerminalDefaults:
      primarySelectionDefaultedForTerminalDefaults || stampPrimarySelectionTerminalDefaults,
    ...migratedAutoRenameBranchFromWork,
    ...migratedTerminalCursorStyle,
    terminalLineHeight: migratedTerminalLineHeight,
    // False was always explicit; the old true default may be reset once.
    terminalRightClickToPaste: terminalRightClickToPasteDefaultedForPlatform
      ? (parsed.settings?.terminalRightClickToPaste ?? defaults.settings.terminalRightClickToPaste)
      : parsed.settings?.terminalRightClickToPaste === false
        ? false
        : defaults.settings.terminalRightClickToPaste,
    terminalRightClickToPasteDefaultedForPlatform: true,
    ...migratedTerminalTuiScrollSensitivity.settings,
    experimentalActivity: migratedExperimentalActivity,
    experimentalActivityDefaultedOffForAllUsers: true,
    agentsSidebarMigratedFromExperimental:
      parsed.settings?.agentsSidebarMigratedFromExperimental === true ||
      migratedExperimentalActivity,
    compactWorktreeCards: loadedCompactWorktreeCards,
    experimentalCompactWorktreeCards: undefined,
    terminalMacOptionAsAlt: migratedOptionAsAlt,
    terminalMacOptionAsAltMigrated: true,
    localWindowsRuntimeDefault: migratedWindowsRuntimeDefault,
    localAccountRuntime: migratedLocalAccountRuntime,
    localAccountRuntimeDefaultedToAutoForAllUsers: true,
    ...migratedOsc52Clipboard,
    floatingTerminalEnabled: migratedFloatingTerminalEnabled,
    floatingTerminalDefaultedForAllUsers: true,
    floatingTerminalCwd: migratedFloatingTerminalCwd,
    floatingTerminalTrustedCwds: migratedFloatingTerminalTrustedCwds,
    floatingTerminalCwdMigratedToAppWorkspace: true,
    terminalScrollbackRows: migratedTerminalScrollback.rows,
    terminalDefaultShell: normalizeTerminalDefaultShell(parsed.settings?.terminalDefaultShell),
    terminalQuickCommands: normalizeTerminalQuickCommands(parsed.settings?.terminalQuickCommands),
    terminalCustomThemes: normalizeTerminalCustomThemes(parsed.settings?.terminalCustomThemes),
    appIcon: normalizeAppIconId(parsed.settings?.appIcon),
    mobilePairingCustomAddress,
    mobilePairingCustomAddresses,
    machineName: normalizeMachineName(parsed.settings?.machineName),
    minimizeToTrayOnClose: parsed.settings?.minimizeToTrayOnClose === true,
    // Default-on values round-trip off-platform; macOS consumers gate the actual effect.
    showMenuBarIcon: parsed.settings?.showMenuBarIcon !== false,
    ...migratedPortugueseUiLanguage,
    nativeChatInheritShellEnvironment: parsed.settings?.nativeChatInheritShellEnvironment !== false,
    nativeChatShellEnvironmentVariables: normalizeNativeChatShellEnvironmentVariables(
      parsed.settings?.nativeChatShellEnvironmentVariables
    ),
    // Old clients identify hosts with per-chat permissions through this valid value.
    nativeChatPermissionMode: publishedLegacyChatPermissionMode({
      ...parsed.settings,
      ...migratedAgentYoloDefaults,
      ...migratedAgentPermission
    }),
    defaultTaskSource: taskProviderSettings.defaultTaskSource,
    visibleTaskProviders: taskProviderSettings.visibleTaskProviders,
    visibleTaskProvidersDefaultedForJira: true,
    terminalShortcutPolicy: normalizeTerminalShortcutPolicy(
      parsed.settings?.terminalShortcutPolicy
    ),
    disabledTuiAgents: migratedDisabledTuiAgents,
    disabledUsageProviders: normalizeDisabledUsageProviders(
      parsed.settings?.disabledUsageProviders
    ),
    ...migratedAgentYoloDefaults,
    ...migratedAgentPermission,
    claudeAgentTeamsDefaultDisabledMigrated: true,
    sshRemoteCliControlExistingHostsMigrated: true,
    openInApplications: normalizeOpenInApplications(parsed.settings?.openInApplications, {
      seedDefaults: true
    }),
    notifications: normalizedNotifications,
    sourceControlAi: migratedSourceControlAi,
    sourceControlGroupOrder: normalizedSourceControlGroupOrder,
    // Refresh the legacy projection for rollback builds that still read commitMessageAi.
    commitMessageAi: projectSourceControlAiToLegacyCommitMessageAi(
      migratedSourceControlAi,
      parsed.settings?.commitMessageAi ?? defaults.settings.commitMessageAi
    ),
    voice: {
      ...getDefaultVoiceSettings(),
      ...parsed.settings?.voice
    }
  }
}
