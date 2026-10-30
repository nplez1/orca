import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSegmentedControl } from './SettingsFormControls'

export type LinkDefaultDestination = 'in-app' | 'system'

type BrowserLinkRoutingSettingProps = {
  settings: GlobalSettings
  linkRoutingDescription: string
  isMac: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** Where a link opens when nothing else decides: Orca's per-worktree browser, or the OS browser. */
export function BrowserLinkRoutingSetting({
  settings,
  linkRoutingDescription,
  isMac,
  updateSettings
}: BrowserLinkRoutingSettingProps): React.JSX.Element {
  const title = translate('auto.components.settings.BrowserPane.d3eb69c0aa', 'Link Routing')
  return (
    <SearchableSetting
      title={title}
      description={linkRoutingDescription}
      keywords={[
        'browser',
        'preview',
        'links',
        'localhost',
        'webview',
        'markdown',
        isMac ? 'cmd' : 'ctrl',
        'file',
        'editor',
        'default',
        'destination',
        'system',
        'in-app'
      ]}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{linkRoutingDescription}</p>
      </div>
      <SettingsSegmentedControl<LinkDefaultDestination>
        value={settings.openLinksInApp ? 'in-app' : 'system'}
        onChange={(value) =>
          updateSettings({
            openLinksInApp: value === 'in-app',
            // An explicit choice answers the first-use prompt, so it must not ask later.
            openLinksInAppPreferencePrompted: true
          })
        }
        ariaLabel={translate(
          'auto.components.settings.BrowserLinkRoutingSetting.destinationAriaLabel',
          'Default link destination'
        )}
        size="sm"
        options={[
          {
            value: 'in-app',
            label: translate(
              'auto.components.settings.BrowserLinkRoutingSetting.inAppOption',
              'In-App Browser'
            )
          },
          {
            value: 'system',
            label: translate(
              'auto.components.settings.BrowserLinkRoutingSetting.systemOption',
              'System Browser'
            )
          }
        ]}
      />
    </SearchableSetting>
  )
}
