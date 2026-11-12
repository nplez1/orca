import { GENERAL_SETTING_ANCHORS } from './general-setting-anchors'
import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { clearHostSettingOverrideForIds } from '../../../../../shared/host-setting-overrides'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { HostFolderSettingRow } from './HostFolderSettingRow'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import { useTranslate } from '@/i18n/use-translate'

type WorkspaceDirectorySettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  /** The machine chosen at the top of Settings; this computer is the client default. */
  scope: SettingsHostScope
}

export function WorkspaceDirectorySetting({
  settings,
  updateSettings,
  scope
}: WorkspaceDirectorySettingProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <HostFolderSettingRow
      scope={scope}
      settings={settings}
      updateSettings={updateSettings}
      settingKey="defaultWorktreeLocation"
      allowRelativePath
      // A remote machine never inherits this computer's path: it names a folder on another disk.
      fallbackValue={scope.hostId === LOCAL_EXECUTION_HOST_ID ? settings.workspaceDir : ''}
      // Why: this computer *is* the client default, so its value is the shared workspaceDir, and
      // any older per-host override for it would otherwise shadow what the row just showed.
      writeLocal={(next) => ({
        workspaceDir: next,
        hostSettingOverrides: clearHostSettingOverrideForIds(
          settings,
          [LOCAL_EXECUTION_HOST_ID],
          'defaultWorktreeLocation'
        )
      })}
      anchorId={GENERAL_SETTING_ANCHORS.folder}
      title={t(
        'auto.components.settings.GeneralWorkspaceSettingsSection.9d0ef6a2a6',
        'Workspace directory'
      )}
      description={t(
        'auto.components.settings.GeneralWorkspaceSettingsSection.a246f5ce6f',
        'Root directory where workspace folders are created.'
      )}
      keywords={['workspace', 'folder', 'path', 'worktree', 'host', 'override']}
      localCaption={t(
        'auto.components.settings.WorkspaceDirectorySetting.6f7a8b9cad',
        'Use a relative path (e.g. .orca/worktrees) for a per-project location, or an absolute path for one shared folder.'
      )}
      remoteCaption={t(
        'auto.components.settings.WorkspaceDirectorySetting.remoteCaption',
        'The workspace folder on {{value0}}, as that machine spells it. It is never this computer’s path.',
        { value0: scope.label }
      )}
    />
  )
}
