import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { DisableableUsageProviderId } from '../../../../shared/usage-provider-enablement'
import { withUsageProviderDisabled } from '../../../../shared/usage-provider-enablement'
import { translate } from '@/i18n/i18n'
import { UsageProviderSectionGate } from './ProviderUsageEnableSwitch'

// Why: the master-switch chrome (disabled set, toggle, labels, gate) is shared by
// every provider section; owning it here keeps AccountsPane under its max-lines cap.
export function useUsageProviderGating({
  disabledUsageProviders,
  updateSettings,
  recordFeatureInteraction
}: {
  disabledUsageProviders: DisableableUsageProviderId[]
  updateSettings: (updates: Partial<GlobalSettings>) => void
  recordFeatureInteraction: (featureId: FeatureInteractionId) => void
}): {
  gateUsageProvider: (
    providerId: DisableableUsageProviderId,
    content: React.JSX.Element
  ) => React.JSX.Element
} {
  // Why: persisted disabled set is the source of truth; toggling rewrites the whole
  // array so the canonical provider order and unknown-id filtering stay centralized.
  const setUsageProviderEnabled = (
    providerId: DisableableUsageProviderId,
    enabled: boolean
  ): void => {
    recordFeatureInteraction('usage-tracking')
    updateSettings({
      disabledUsageProviders: withUsageProviderDisabled(
        disabledUsageProviders,
        providerId,
        !enabled
      )
    })
  }
  // Why: labels are read in render, not at module scope, so a language change
  // without a reload still retranslates the master switch.
  const usageProviderLabels: Record<DisableableUsageProviderId, string> = {
    claude: translate('auto.components.settings.AccountsPane.26ef4b55be', 'Claude'),
    codex: translate('auto.components.settings.AccountsPane.ef91cfa06b', 'Codex'),
    gemini: translate('auto.components.settings.AccountsPane.0c64dc2a64', 'Gemini'),
    'opencode-go': translate('auto.components.settings.AccountsPane.4ac10b4d08', 'OpenCode Go'),
    minimax: translate('auto.components.settings.AccountsPane.5d63bbfbec', 'MiniMax'),
    deepseek: translate(
      'auto.components.settings.accounts.pane.deepseek.section.28c8b91c5d',
      'DeepSeek'
    ),
    fireworks: translate(
      'auto.components.settings.accounts.pane.fireworks.section.51bcc16ae3',
      'Fireworks.ai'
    ),
    copilot: translate(
      'auto.components.settings.accounts.pane.copilot.section.dc3eaf8d70',
      'GitHub Copilot'
    ),
    grok: translate('auto.components.settings.GrokAccountsSection.a1b2c3d4e5', 'Grok (xAI)'),
    cursor: translate('auto.components.settings.CursorAccountsSection.title', 'Cursor')
  }
  // Why: the switch sits above the provider's own header and, while off, its controls
  // are not mounted at all — so no pane-triggered credential read can run.
  const gateUsageProvider = (
    providerId: DisableableUsageProviderId,
    content: React.JSX.Element
  ): React.JSX.Element => (
    <UsageProviderSectionGate
      key={providerId}
      providerId={providerId}
      providerLabel={usageProviderLabels[providerId]}
      disabled={disabledUsageProviders.includes(providerId)}
      onEnabledChange={(enabled) => setUsageProviderEnabled(providerId, enabled)}
    >
      {content}
    </UsageProviderSectionGate>
  )
  return { gateUsageProvider }
}
