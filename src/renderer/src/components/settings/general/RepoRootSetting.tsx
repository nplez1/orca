import React, { useEffect, useState } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../../shared/execution-host'
import { getDefaultRepoRootConvention } from '../../../../../shared/host-repo-root'
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
  const sshTargetId =
    parseExecutionHostId(scope.hostId)?.kind === 'ssh' && !environmentId ? scope.hostId : null
  const [convention, setConvention] = useState('')
  useEffect(() => {
    setConvention('')
    if (!scope.available) {
      return
    }
    let cancelled = false
    const load = isLocal
      ? window.api.repos.getDefaultRepoRoot()
      : environmentId
        ? browseRuntimeServerDirectory(environmentId, '~').then((listing) =>
            getDefaultRepoRootConvention(listing.resolvedPath)
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
  }, [environmentId, isLocal, scope.available, sshTargetId])
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
        'Defaults to ~/orca/projects. Projects and clones are created here.'
      )}
      remoteCaption={t(
        'auto.components.settings.RepoRootSetting.remoteCaption',
        'Where {{value0}} keeps its checkouts, as that machine spells it.',
        { value0: scope.label }
      )}
    />
  )
}
