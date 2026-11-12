import { isAbsolute, join } from 'node:path'
import { getDefaultWorkspaceDir } from '../../../shared/constants'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getEffectiveHostSetting } from '../../../shared/host-setting-overrides'
import {
  layoutNestsPrimaryCheckout,
  resolveWorktreeLayoutMode
} from '../../../shared/orca-workspace-layout'
import { expandLeadingHomePath } from '../../filesystem/home-path-expansion'

/** A stored folder expanded against this machine's home, or '' when it cannot name one here.
 *  A relative value is no parent at all: `repos:create` refuses it, so it falls through instead. */
function absoluteStoredParent(value: string, home: string): string {
  const expanded = expandLeadingHomePath(value.trim(), home)
  return expanded && isAbsolute(expanded) ? expanded : ''
}

/**
 * Folder the new project's primary checkout goes in on this computer.
 *
 * Ignore seeded workspaceDir: treating it as user intent nests projects inside the worktree root.
 */
export function resolveDefaultCreateProjectParent(
  settings: Pick<
    GlobalSettings,
    'hostSettingOverrides' | 'workspaceDir' | 'nestWorkspaces' | 'worktreeLayoutMode'
  >,
  home: string
): string {
  // An explicit checkout root wins: under a nested layout it is the project's container.
  const storedRoot = absoluteStoredParent(
    getEffectiveHostSetting(settings, LOCAL_EXECUTION_HOST_ID, 'defaultRepoRoot', ''),
    home
  )
  if (storedRoot) {
    return storedRoot
  }
  const configured = absoluteStoredParent(
    getEffectiveHostSetting(
      settings,
      LOCAL_EXECUTION_HOST_ID,
      'defaultWorktreeLocation',
      settings.workspaceDir ?? ''
    ),
    home
  )
  // fork-comment-ok: under a nested layout the container's parent *is* the workspace dir, so the
  // "beside the worktree tree" fallback below would place the project outside its own container.
  if (layoutNestsPrimaryCheckout(resolveWorktreeLayoutMode(settings))) {
    return configured || getDefaultWorkspaceDir(home)
  }
  const isUntouchedDefault =
    normalizeRuntimePathForComparison(configured) ===
    normalizeRuntimePathForComparison(getDefaultWorkspaceDir(home))
  if (configured && !isUntouchedDefault) {
    return configured
  }
  return join(home, 'orca', 'projects')
}
