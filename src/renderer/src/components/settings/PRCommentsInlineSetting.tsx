import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { isPRCommentsInlineEnabled } from '@/lib/pr-comment-inline-setting'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type PRCommentsInlineSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function PRCommentsInlineSetting({
  settings,
  updateSettings
}: PRCommentsInlineSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.GeneralEditorSettingsSection.9c020a16db',
        'PR Comments Inline'
      )}
      description={translate(
        'auto.components.settings.GeneralEditorSettingsSection.7fea4145c9',
        'Show GitHub review threads on the lines they were left on in the code.'
      )}
      keywords={['pull request', 'review', 'comments', 'inline', 'github', 'resolve', 'reply']}
    >
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.GeneralEditorSettingsSection.9c020a16db',
          'PR Comments Inline'
        )}
        description={translate(
          'auto.components.settings.GeneralEditorSettingsSection.34155c6ed5',
          'Draw each review thread below its commented line, with reply and resolve controls. When off, the thread stays reachable from a small marker in the gutter.'
        )}
        checked={isPRCommentsInlineEnabled(settings)}
        onChange={() =>
          updateSettings({ prCommentsInlineEnabled: !isPRCommentsInlineEnabled(settings) })
        }
      />
    </SearchableSetting>
  )
}
