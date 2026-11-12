import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { normalizeNativeChatAppearanceSettings } from '../../../../../shared/native-chat/native-chat-appearance-settings'
import { normalizeTerminalQuickCommands } from '../../../../../shared/terminal/quick-commands/terminal-quick-commands'
import { assertTerminalQuickCommandsStorable } from '../../../../../shared/terminal/quick-commands/terminal-quick-command-prompt-limit'
import { normalizeTerminalCustomThemes } from '../../../../../shared/terminal-themes/terminal-custom-themes'
import { normalizeTaskProviderSettings } from '../../../../../shared/work-items/task-providers'
import { normalizeOpenInApplications } from '../../../../../shared/open-in-applications'
import { normalizeDisabledUsageProviders } from '../../../../../shared/usage-provider-enablement'
import {
  normalizeMobilePairingCustomAddress,
  normalizeMobilePairingCustomAddresses
} from '../../../../../shared/remote-runtime/pairing/mobile-pairing-custom-address'
import { normalizeDisabledTuiAgents } from '../../../../../shared/agent-launch/catalog/tui-agent-selection'
import { sanitizeAgentLaunchProfileUpdates } from '../../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import { normalizeUiLanguage } from '../../../../../shared/ui-language'
import { normalizeDesktopTerminalScrollbackRows } from '../../../../../shared/terminal/replay/terminal-scrollback-policy'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/non-secure-context-uuid'

type LegacyTerminalScrollbackSettingsUpdate = Partial<GlobalSettings> & {
  terminalScrollbackBytes?: unknown
}

export function normalizeSettingsUpdates(
  updates: Partial<GlobalSettings>,
  currentSettings: GlobalSettings | null
): Partial<GlobalSettings> {
  const { terminalScrollbackBytes: _legacyScrollbackBytes, ...sanitizedUpdates } =
    updates as LegacyTerminalScrollbackSettingsUpdate
  void _legacyScrollbackBytes
  if ('terminalQuickCommands' in updates) {
    sanitizedUpdates.terminalQuickCommands = normalizeTerminalQuickCommands(
      updates.terminalQuickCommands
    )
    // The web client stores its own list without main's check, so refuse here too, before any write.
    assertTerminalQuickCommandsStorable(sanitizedUpdates.terminalQuickCommands)
  }
  if ('terminalCustomThemes' in updates) {
    sanitizedUpdates.terminalCustomThemes = normalizeTerminalCustomThemes(
      updates.terminalCustomThemes
    )
  }
  if ('visibleTaskProviders' in updates || 'defaultTaskSource' in updates) {
    const taskProviderSettings = normalizeTaskProviderSettings({
      visibleTaskProviders:
        'visibleTaskProviders' in updates
          ? updates.visibleTaskProviders
          : currentSettings?.visibleTaskProviders,
      defaultTaskSource:
        'defaultTaskSource' in updates
          ? updates.defaultTaskSource
          : currentSettings?.defaultTaskSource
    })
    sanitizedUpdates.defaultTaskSource = taskProviderSettings.defaultTaskSource
    sanitizedUpdates.visibleTaskProviders = taskProviderSettings.visibleTaskProviders
  }
  if ('openInApplications' in updates) {
    sanitizedUpdates.openInApplications = normalizeOpenInApplications(updates.openInApplications, {
      createId: createBrowserUuid
    })
  }
  if ('nativeChatAppearance' in updates) {
    sanitizedUpdates.nativeChatAppearance = normalizeNativeChatAppearanceSettings(
      updates.nativeChatAppearance
    )
  }
  if ('disabledTuiAgents' in updates) {
    sanitizedUpdates.disabledTuiAgents = normalizeDisabledTuiAgents(updates.disabledTuiAgents)
  }
  if ('disabledUsageProviders' in updates) {
    sanitizedUpdates.disabledUsageProviders = normalizeDisabledUsageProviders(
      updates.disabledUsageProviders
    )
  }
  sanitizeAgentLaunchProfileUpdates(sanitizedUpdates, updates)
  if ('uiLanguage' in updates) {
    sanitizedUpdates.uiLanguage = normalizeUiLanguage(updates.uiLanguage)
  }
  if ('terminalScrollbackRows' in updates) {
    sanitizedUpdates.terminalScrollbackRows = normalizeDesktopTerminalScrollbackRows(
      updates.terminalScrollbackRows
    )
  }
  if ('mobilePairingCustomAddress' in updates) {
    sanitizedUpdates.mobilePairingCustomAddress = normalizeMobilePairingCustomAddress(
      updates.mobilePairingCustomAddress
    )
  }
  if ('mobilePairingCustomAddresses' in updates) {
    sanitizedUpdates.mobilePairingCustomAddresses = normalizeMobilePairingCustomAddresses(
      updates.mobilePairingCustomAddresses
    )
  }
  return sanitizedUpdates
}
