import { isAbsolute } from 'node:path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getEffectiveHostSetting } from '../../../shared/host-setting-overrides'
import { resolveCheckoutParent } from '../../../shared/host-repo-root'
import { resolveWorktreeLayoutMode } from '../../../shared/orca-workspace-layout'
import { expandLeadingHomePath } from '../../filesystem/home-path-expansion'

/** A stored folder expanded against this machine's home, or '' when it cannot name one here.
 *  A relative value is no parent at all: `repos:create` refuses it, so it falls through instead. */
function absoluteStoredParent(value: string, home: string): string {
  const expanded = expandLeadingHomePath(value.trim(), home)
  return expanded && isAbsolute(expanded) ? expanded : ''
}

/**
 * Folder the new project's primary checkout goes in on this computer: the rule the clone flow and
 * the Settings row also use, so a project and a clone never land in two different folders.
 */
export function resolveDefaultCreateProjectParent(
  settings: Pick<
    GlobalSettings,
    'hostSettingOverrides' | 'workspaceDir' | 'nestWorkspaces' | 'worktreeLayoutMode'
  >,
  home: string
): string {
  return resolveCheckoutParent({
    storedRepoRoot: absoluteStoredParent(
      getEffectiveHostSetting(settings, LOCAL_EXECUTION_HOST_ID, 'defaultRepoRoot', ''),
      home
    ),
    storedWorktreeRoot: absoluteStoredParent(
      getEffectiveHostSetting(
        settings,
        LOCAL_EXECUTION_HOST_ID,
        'defaultWorktreeLocation',
        settings.workspaceDir ?? ''
      ),
      home
    ),
    layoutMode: resolveWorktreeLayoutMode(settings),
    hostHome: home
  })
}
