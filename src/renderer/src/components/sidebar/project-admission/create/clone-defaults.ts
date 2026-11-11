import {
  layoutNestsPrimaryCheckout,
  type WorktreeLayoutMode
} from '../../../../../../shared/orca-workspace-layout'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import { getHostSettingOverrideForIds } from '../../../../../../shared/host-setting-overrides'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { getDefaultCreateProjectParent } from './create-project-defaults'

export function getDefaultCloneParent(
  workspaceDir: string,
  layoutMode: WorktreeLayoutMode = 'repo-nested'
): string {
  if (!workspaceDir) {
    return ''
  }

  // fork-comment-ok: the destination IS the workspace dir under a nested layout, not its parent.
  if (layoutNestsPrimaryCheckout(layoutMode)) {
    return workspaceDir
  }

  const trimmed = workspaceDir.replace(/[\\/]+$/, '')
  if (!trimmed) {
    return workspaceDir
  }

  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const lastSegment = separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 1)

  if (lastSegment !== 'workspaces') {
    return workspaceDir
  }

  // Place clones beside Orca’s default workspaces tree.
  const parent = separatorIndex === -1 ? '' : trimmed.slice(0, separatorIndex)
  if (parent === '' && trimmed.startsWith('/')) {
    return '/'
  }
  if (/^[A-Za-z]:$/.test(parent)) {
    return `${parent}${trimmed[separatorIndex]}`
  }
  return parent
}

export type CloneParentSettings = {
  workspaceDir?: string | null
  hostSettingOverrides?: GlobalSettings['hostSettingOverrides']
}

/** Where a clone lands for a host: its checkout root, else its worktree root under the layout rule. */
export function getCloneParentForHost({
  settings,
  hostIds,
  layoutMode = 'repo-nested',
  hostHome
}: {
  settings: CloneParentSettings | null | undefined
  hostIds: readonly ExecutionHostId[]
  layoutMode?: WorktreeLayoutMode
  /** The machine's home directory, when the caller could probe it. */
  hostHome?: string | null
}): string {
  const parsedIds = hostIds
    .map((hostId) => parseExecutionHostId(hostId))
    .filter((parsed) => parsed !== null)
  const isLocal = parsedIds.some((parsed) => parsed.kind === 'local')
  // Cloning onto an SSH-only machine is refused, so it never gets a destination. A merged pair keeps
  // its server id, which is where the folder is stored.
  if (!isLocal && !parsedIds.some((parsed) => parsed.kind === 'runtime')) {
    return ''
  }
  // An explicit checkout root already names the folder checkouts go in.
  const repoRoot = getHostSettingOverrideForIds(settings, hostIds, 'defaultRepoRoot')
  if (repoRoot) {
    return repoRoot
  }
  const worktreeRoot = getHostSettingOverrideForIds(settings, hostIds, 'defaultWorktreeLocation')
  if (worktreeRoot) {
    return getDefaultCloneParent(worktreeRoot, layoutMode)
  }
  if (isLocal) {
    return getDefaultCloneParent(settings?.workspaceDir ?? '', layoutMode)
  }
  // Never this computer's workspaceDir: it names a folder on another machine's disk.
  return hostHome
    ? getDefaultCloneParent(getDefaultCreateProjectParent(hostHome, layoutMode), layoutMode)
    : ''
}

export function getCloneDestinationAutoFill({
  step,
  cloneDestination,
  cloneStepAutoFilled,
  parent
}: {
  step: string
  cloneDestination: string
  cloneStepAutoFilled: boolean
  /** The host's resolved clone parent, from `getCloneParentForHost`. */
  parent: string
}): { destination: string } | null {
  if (step !== 'clone' || cloneStepAutoFilled || cloneDestination || !parent) {
    return null
  }
  return { destination: parent }
}
