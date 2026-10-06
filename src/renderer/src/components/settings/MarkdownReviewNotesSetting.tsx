import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type MarkdownReviewNotesSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function MarkdownReviewNotesSetting({
  settings,
  updateSettings
}: MarkdownReviewNotesSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.GeneralEditorSettingsSection.4edc104f0f',
        'Markdown Review Notes'
      )}
      description={translate(
        'auto.components.settings.GeneralEditorSettingsSection.5f02e6fb21',
        'Show local markdown review note controls in markdown files.'
      )}
      keywords={['markdown', 'review', 'notes', 'annotations', 'agents']}
    >
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.GeneralEditorSettingsSection.4edc104f0f',
          'Markdown Review Notes'
        )}
        description={translate(
          'auto.components.settings.GeneralEditorSettingsSection.f80603d293',
          'Show markdown note controls in every markdown view and include markdown notes in agent handoff actions.'
        )}
        checked={settings.markdownReviewToolsEnabled}
        onChange={() =>
          updateSettings({ markdownReviewToolsEnabled: !settings.markdownReviewToolsEnabled })
        }
      />
    </SearchableSetting>
  )
}
