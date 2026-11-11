import { joinHostPath, trimHostPathSeparators } from './host-path-join'
import { getHostSettingOverrideForIds } from './host-setting-overrides'
import type { ExecutionHostId } from './execution-host'
import type { GlobalSettings } from './global-settings-types'

type HostSettingsSlice = Pick<GlobalSettings, 'hostSettingOverrides'>

/** Where a host keeps checkouts when nothing is stored: `<home>/orca/projects`. */
export function getDefaultRepoRootConvention(hostHome: string): string {
  const home = trimHostPathSeparators(hostHome.trim())
  return home ? joinHostPath(joinHostPath(home, 'orca'), 'projects') : ''
}

/** The host's stored checkout root, else the convention for its home. A suggestion, never a forced location. */
export function getEffectiveHostRepoRoot(args: {
  settings: HostSettingsSlice | null | undefined
  hostIds: readonly ExecutionHostId[]
  hostHome: string
}): string {
  return (
    getHostSettingOverrideForIds(args.settings, args.hostIds, 'defaultRepoRoot') ??
    getDefaultRepoRootConvention(args.hostHome)
  )
}
