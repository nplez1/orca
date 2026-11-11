import React, { useEffect, useState } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { getDefaultRepoRootConvention } from '../../../../../shared/host-repo-root'
import { getEffectiveHostSetting } from '../../../../../shared/host-setting-overrides'
import {
  resolveWorktreeLayoutMode,
  type WorktreeLayoutMode
} from '../../../../../shared/orca-workspace-layout'
import { getDefaultCloneParent } from '../../sidebar/project-admission/create/clone-defaults'
import { browseRuntimeServerDirectory } from '@/runtime/files/reads/runtime-server-directory-browser'
import { HostFolderSettingRow } from './HostFolderSettingRow'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import { useTranslate } from '@/i18n/use-translate'

type RepoRootSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  /** The machine chosen at the top of Settings. */
  scope: SettingsHostScope
}

/** Where a machine keeps checkouts, so adding a project there never needs a typed path. */
export function RepoRootSetting({
  settings,
  updateSettings,
  scope
}: RepoRootSettingProps): React.JSX.Element {
  const t = useTranslate()
  const isLocal = scope.hostId === LOCAL_EXECUTION_HOST_ID
  const environmentId = scope.target?.kind === 'environment' ? scope.target.environmentId : null
  const layoutMode: WorktreeLayoutMode = resolveWorktreeLayoutMode(settings)
  const [convention, setConvention] = useState('')
  useEffect(() => {
    setConvention('')
    if (!scope.available) {
      return
    }
    let cancelled = false
    const load = isLocal
      ? // The same rule the clone flow applies here, so the field cannot promise another folder.
        Promise.resolve(
          getDefaultCloneParent(
            getEffectiveHostSetting(
              settings,
              LOCAL_EXECUTION_HOST_ID,
              'defaultWorktreeLocation',
              settings.workspaceDir
            ),
            layoutMode
          )
        )
      : environmentId
        ? browseRuntimeServerDirectory(environmentId, '~').then((listing) =>
            getDefaultRepoRootConvention(listing.resolvedPath, layoutMode)
          )
        : Promise.resolve('')
    void load
      .then((value) => {
        if (!cancelled) {
          setConvention(value)
        }
      })
      .catch(() => {
        // An unreachable host keeps whatever root was last stored and no convention.
        if (!cancelled) {
          setConvention('')
        }
      })
    return () => {
      cancelled = true
    }
  }, [environmentId, isLocal, layoutMode, scope.available, settings])
  return (
    <HostFolderSettingRow
      scope={scope}
      settings={settings}
      updateSettings={updateSettings}
      settingKey="defaultRepoRoot"
      // A suggestion source, never a forced location: clearing the field falls back to the convention.
      fallbackValue={convention}
      title={t('auto.components.settings.RepoRootSetting.title', 'Repository root folder')}
      description={t(
        'auto.components.settings.RepoRootSetting.description',
        'Where checkouts are cloned on this host.'
      )}
      keywords={['repository', 'repo', 'root', 'checkout', 'clone', 'destination', 'host']}
      localCaption={t(
        'auto.components.settings.RepoRootSetting.localCaption',
        'New clones start here. Clearing this reverts to the Orca default for your workspace layout.'
      )}
      remoteCaption={t(
        'auto.components.settings.RepoRootSetting.remoteCaption',
        'Where {{value0}} keeps its checkouts, as that machine spells it.',
        { value0: scope.label }
      )}
    />
  )
}
