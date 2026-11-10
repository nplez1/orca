import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { Label } from '../../../ui/label'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsSegmentedControl } from '../../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'

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
  const t = useTranslate()
  const title = t('auto.components.settings.BrowserPane.7a366a05e1', 'Link routing')
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
      className="flex items-center justify-between gap-4 py-3"
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
        ariaLabel={t(
          'auto.components.settings.BrowserLinkRoutingSetting.destinationAriaLabel',
          'Default link destination'
        )}
        size="sm"
        options={[
          {
            value: 'in-app',
            label: t(
              'auto.components.settings.BrowserLinkRoutingSetting.inAppOption',
              'In-App Browser'
            )
          },
          {
            value: 'system',
            label: t(
              'auto.components.settings.BrowserLinkRoutingSetting.systemOption',
              'System Browser'
            )
          }
        ]}
      />
    </SearchableSetting>
  )
}
