import React, { useEffect, useMemo, useState } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import {
  resolveWorktreeLayoutMode,
  type WorktreeLayoutMode
} from '../../../../../shared/orca-workspace-layout'
import { browseRuntimeServerDirectory } from '@/runtime/files/reads/runtime-server-directory-browser'
import { getCloneParentForHost } from '../../sidebar/project-admission/create/clone-defaults'
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
  const [hostHome, setHostHome] = useState<string | null>(null)
  useEffect(() => {
    setHostHome(null)
    if (isLocal || !scope.available || environmentId === null) {
      return
    }
    let cancelled = false
    void browseRuntimeServerDirectory(environmentId, '~')
      .then((listing) => {
        if (!cancelled) {
          setHostHome(listing.resolvedPath)
        }
      })
      .catch(() => {
        // An unreachable host keeps whatever root was last stored and no convention.
        if (!cancelled) {
          setHostHome(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [environmentId, isLocal, scope.available])
  // The same rule the clone and create-project flows apply to this machine, so the field cannot
  // promise another folder.
  const fallbackValue = useMemo(
    () =>
      getCloneParentForHost({
        settings,
        hostIds: isLocal ? [LOCAL_EXECUTION_HOST_ID] : scope.equivalentHostIds,
        layoutMode,
        hostHome
      }),
    [hostHome, isLocal, layoutMode, scope.equivalentHostIds, settings]
  )
  return (
    <HostFolderSettingRow
      scope={scope}
      settings={settings}
      updateSettings={updateSettings}
      settingKey="defaultRepoRoot"
      // A suggestion source, never a forced location: clearing the field falls back to the convention.
      fallbackValue={fallbackValue}
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
