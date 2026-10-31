import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { DisableableUsageProviderId } from '../../../../shared/usage-provider-enablement'
import { withUsageProviderDisabled } from '../../../../shared/usage-provider-enablement'

/** Writes the persisted enabled/disabled set for the provider switches in AI Provider Accounts. */
export function useUsageProviderEnablement({
  disabledUsageProviders,
  updateSettings,
  recordFeatureInteraction
}: {
  disabledUsageProviders: readonly DisableableUsageProviderId[]
  updateSettings: (updates: Partial<GlobalSettings>) => void
  recordFeatureInteraction: (featureId: FeatureInteractionId) => void
}): (providerId: DisableableUsageProviderId, enabled: boolean) => void {
  // Why: persisted disabled set is the source of truth; toggling rewrites the whole
  // array so the canonical provider order and unknown-id filtering stay centralized.
  return (providerId, enabled) => {
    recordFeatureInteraction('usage-tracking')
    updateSettings({
      disabledUsageProviders: withUsageProviderDisabled(
        disabledUsageProviders,
        providerId,
        !enabled
      )
    })
  }
}
