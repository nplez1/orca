import type { GlobalSettings } from '../../shared/global-settings-types'
import { SETTINGS_CHANGED_WHITELIST } from '../../shared/telemetry-events'
import { track } from '../telemetry/client'

export function trackAgentDashboardToggle(
  update: Partial<GlobalSettings>,
  before: GlobalSettings,
  after: GlobalSettings
): void {
  if (
    'experimentalAgentDashboardPopout' in update &&
    before.experimentalAgentDashboardPopout !== after.experimentalAgentDashboardPopout
  ) {
    track('agent_dashboard_enabled', {
      enabled: after.experimentalAgentDashboardPopout === true
    })
  }
}

// Emit only allowlisted keys without raw values; new value kinds require matching schema support.
export function trackSettingsChanged(
  update: Partial<GlobalSettings>,
  before: GlobalSettings,
  after: GlobalSettings
): void {
  for (const updatedKey of Object.keys(update)) {
    const key = SETTINGS_CHANGED_WHITELIST.find((candidate) => candidate === updatedKey)
    if (key === undefined || before[key] === after[key]) {
      continue
    }
    if (typeof after[key] !== 'boolean') {
      // Unsupported value kinds must not be guessed.
      continue
    }
    track('settings_changed', { setting_key: key, value_kind: 'bool' })
  }
}
