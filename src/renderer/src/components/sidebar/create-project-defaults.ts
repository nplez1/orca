import {
  isProjectFolderLayout,
  type WorktreeLayoutMode
} from '../../../../shared/orca-workspace-layout'

export type GitAvailability = 'checking' | 'available' | 'unavailable' | 'unknown'

function pathSeparatorFor(pathValue: string): '/' | '\\' {
  return pathValue.includes('\\') ? '\\' : '/'
}

/** Home-relative shorthand for an Orca-derived default project root, or null for anything else.
 *  Both shapes are worth showing as `~/…` instead of an absolute path. */
function homeDefaultRootShorthand(pathValue: string): string | null {
  if (isHomeOrcaRoot(pathValue, 'projects')) {
    return '~/orca/projects'
  }
  return isHomeOrcaRoot(pathValue, 'workspaces') ? '~/orca/workspaces' : null
}

/** True only for `{home}/orca/<leaf>` on the usual OS home layouts. A configured directory that
 *  merely ends in the same segments (e.g. `/data/orca/projects`) must stay verbatim, because the
 *  `~` shorthand would otherwise lie about where it lives. */
function isHomeOrcaRoot(pathValue: string, leaf: string): boolean {
  return new RegExp(
    `^(?:\\/(?:Users|home)\\/[^/]+|[A-Za-z]:[\\\\/]Users[\\\\/][^\\\\/]+)[\\\\/]orca[\\\\/]${leaf}$`
  ).test(pathValue)
}

function trimTrailingSeparators(pathValue: string): string {
  const trimmed = pathValue.replace(/[\\/]+$/, '')
  if (trimmed === '' && pathValue.startsWith('/')) {
    return '/'
  }
  if (/^[A-Za-z]:$/.test(trimmed)) {
    return `${trimmed}${pathSeparatorFor(pathValue)}`
  }
  return trimmed
}

export function joinCreateProjectPath(parentPath: string, childName: string): string {
  const parent = trimTrailingSeparators(parentPath.trim())
  const child = childName.trim().replace(/^[\\/]+/, '')
  if (!parent || !child) {
    return parent || child
  }
  const separator = pathSeparatorFor(parent)
  if (parent === '/' || /^[A-Za-z]:[\\/]$/.test(parent)) {
    return `${parent}${child}`
  }
  return `${parent}${separator}${child}`
}

export function getDefaultCreateProjectParent(
  homeDir: string,
  layoutMode: WorktreeLayoutMode = 'repo-nested'
): string {
  const trimmedHomeDir = trimTrailingSeparators(homeDir.trim())
  if (!trimmedHomeDir) {
    return ''
  }
  // Why: under the project-folder layout a project's container lives inside the workspace dir,
  // so the default project root is <home>/orca/workspaces rather than the sibling orca/projects.
  const rootName = isProjectFolderLayout(layoutMode) ? 'workspaces' : 'projects'
  return joinCreateProjectPath(joinCreateProjectPath(trimmedHomeDir, 'orca'), rootName)
}

export function getCreateProjectDefaultParentAutoFill({
  step,
  createParent,
  activeRuntimeEnvironmentId,
  defaultParent,
  createStepAutoFilled
}: {
  step: string
  createParent: string
  activeRuntimeEnvironmentId: string | null | undefined
  defaultParent?: string
  createStepAutoFilled: boolean
}): { parent: string } | null {
  if (step !== 'create' || createStepAutoFilled || createParent) {
    return null
  }
  if (activeRuntimeEnvironmentId?.trim()) {
    return null
  }
  const parent = defaultParent ?? ''
  if (!parent) {
    return null
  }
  return { parent }
}

export function formatCreateProjectParentSummary({
  parent,
  defaultParent,
  runtimeEnvironmentId,
  isRemoteHost,
  missingLocationLabel = 'location not selected',
  missingServerLocationLabel = 'host folder not selected'
}: {
  parent: string
  defaultParent: string
  runtimeEnvironmentId?: string | null
  isRemoteHost?: boolean
  missingLocationLabel?: string
  missingServerLocationLabel?: string
}): string {
  const trimmedParent = parent.trim()
  if (!trimmedParent) {
    return runtimeEnvironmentId || isRemoteHost ? missingServerLocationLabel : missingLocationLabel
  }
  if (defaultParent && trimmedParent === defaultParent && !runtimeEnvironmentId && !isRemoteHost) {
    // Why: a configured directory that merely ends in orca/projects must stay verbatim — the
    // `~` shorthand would otherwise lie about where it lives.
    const shorthand = homeDefaultRootShorthand(trimmedParent)
    if (shorthand) {
      return shorthand
    }
  }
  return trimmedParent
}
