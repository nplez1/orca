import {
  layoutNestsPrimaryCheckout,
  type WorktreeLayoutMode
} from '../../../../shared/orca-workspace-layout'

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

export function getCloneDestinationAutoFill({
  step,
  cloneDestination,
  activeRuntimeEnvironmentId,
  workspaceDir,
  layoutMode,
  cloneStepAutoFilled
}: {
  step: string
  cloneDestination: string
  activeRuntimeEnvironmentId: string | null | undefined
  workspaceDir: string | null | undefined
  layoutMode?: WorktreeLayoutMode
  cloneStepAutoFilled: boolean
}): { destination: string } | null {
  if (step !== 'clone' || cloneStepAutoFilled || cloneDestination) {
    return null
  }
  if (activeRuntimeEnvironmentId?.trim() || !workspaceDir) {
    return null
  }
  return { destination: getDefaultCloneParent(workspaceDir, layoutMode) }
}
