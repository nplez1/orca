import { defineFixture } from '../../component-fixtures/component-fixture'
import type { DisableableUsageProviderId } from '../../../../shared/usage-provider-enablement'
import { useAppStore } from '../../store'
import { AccountsPane } from './AccountsPane'
import { LOCAL_SETTINGS_HOST_SCOPE } from './settings-host-scope'

// Why: every provider's header, switch and off state in one frame — the thing that
// goes wrong when a new provider is added to the pane.
function FixtureAccountsPane({
  disabled
}: {
  disabled: DisableableUsageProviderId[]
}): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  if (!settings) {
    return null
  }
  return (
    <div className="bg-background p-6 text-foreground">
      <AccountsPane
        settings={{ ...settings, disabledUsageProviders: disabled }}
        updateSettings={() => undefined}
        hostScope={LOCAL_SETTINGS_HOST_SCOPE}
      />
    </div>
  )
}

export const everyProviderEnabled = defineFixture({
  width: 820,
  render: () => <FixtureAccountsPane disabled={[]} />
})

export const threeProvidersSwitchedOff = defineFixture({
  width: 820,
  render: () => <FixtureAccountsPane disabled={['claude', 'cursor', 'zcode']} />
})
