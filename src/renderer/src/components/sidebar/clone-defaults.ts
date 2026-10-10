import {
  isProjectFolderLayout,
  type WorktreeLayoutMode
} from '../../../../shared/orca-workspace-layout'

export function getDefaultCloneParent(
  workspaceDir: string,
  layoutMode: WorktreeLayoutMode = 'repo-nested'
): string {
  if (!workspaceDir) {
    return ''
  }

  // Why: under the project-folder layout the destination *is* the workspace dir — the clone path
  // appends <project>/<branch> itself — so the parent-of-"workspaces" heuristic no longer applies
  // and would land the checkout outside the worktree root.
  if (isProjectFolderLayout(layoutMode)) {
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

  // Why: default Orca worktrees live under "workspaces"; clones should sit beside that tree.
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
  sshTargetId,
  workspaceDir,
  layoutMode,
  cloneStepAutoFilled
}: {
  step: string
  cloneDestination: string
  activeRuntimeEnvironmentId: string | null | undefined
  sshTargetId?: string | null | undefined
  workspaceDir: string | null | undefined
  layoutMode?: WorktreeLayoutMode
  cloneStepAutoFilled: boolean
}): { destination: string } | null {
  if (step !== 'clone' || cloneStepAutoFilled || cloneDestination) {
    return null
  }
  if (activeRuntimeEnvironmentId?.trim() || sshTargetId?.trim() || !workspaceDir) {
    return null
  }
  return { destination: getDefaultCloneParent(workspaceDir, layoutMode) }
}
