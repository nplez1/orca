import { resolve, relative, isAbsolute, sep, win32 } from 'node:path'
import type { GlobalSettings, OrcaWorkspaceLayout } from '../../shared/global-settings-types'
import {
  isProjectFolderLayout,
  layoutModeNestsWorkspaces,
  resolveWorktreeLayoutMode,
  type WorktreeLayoutMode
} from '../../shared/orca-workspace-layout'
import type { Repo } from '../../shared/repo-types'
import { isWindowsAbsolutePathLike, resolveRuntimePath } from '../../shared/cross-platform-path'
import { isWslUncPath, resolveWslRepoWorktreeBasePath } from '../../shared/wsl-paths'
import { getWslHome, getWslHomeAsync, parseWslPath } from '../wsl'
import {
  getRuntimePathOps,
  projectContainerRoot,
  resolveProjectFolderName
} from './project-folder-placement'

export { resolveProjectFolderName } from './project-folder-placement'
export { sanitizeWorktreeName } from './project-folder-placement'

type WorktreePathSettings = Pick<GlobalSettings, 'nestWorkspaces' | 'workspaceDir'> & {
  /** Required, not optional: a placement path that forgot the mode would silently fall back
   *  to legacy nesting, so the type makes every call site state it. */
  worktreeLayoutMode: WorktreeLayoutMode
  /** Container leaf for the 'project-folder' mode. Resolved from the repo's display name by
   *  `getWorktreePathSettings`; a caller that omits it falls back to the checkout's folder. */
  projectFolderName?: string
  /** Whether that container's base came from this repo's own `worktreeBasePath`. */
  projectFolderBaseIsRepoScoped?: boolean
  /** Distro to mirror the workspace root into when the repo itself sits on a
   *  Windows drive but this project's git runs in WSL. Omitted = today's
   *  placement, so any caller that cannot resolve the runtime is unaffected. */
  wslMirrorDistro?: string
}
/** Settings a root can be resolved from. The layout fields stay optional here because a bare
 *  root resolution (no repo in hand) legitimately reads as legacy. */
type WorkspaceRootSettings = {
  workspaceDir: string
  wslMirrorDistro?: string
  worktreeLayoutMode?: WorktreeLayoutMode
  projectFolderName?: string
  projectFolderBaseIsRepoScoped?: boolean
}
type WorktreeLayoutSettings = Pick<GlobalSettings, 'nestWorkspaces' | 'workspaceDir'> & {
  worktreeLayoutMode?: WorktreeLayoutMode
  projectFolderName?: string
  projectFolderBaseIsRepoScoped?: boolean
  wslMirrorDistro?: string
}
type WorktreeBasePathRepo = Pick<Repo, 'path' | 'worktreeBasePath'> & {
  displayName?: string | null
}

export {
  computeBranchName,
  getConfiguredBranchPrefix,
  computeValidatedBranchName
} from './worktree-branch-name'
export { mergeWorktree } from './worktree-metadata-merge'
export { areWorktreePathsEqual } from './worktree-path-comparison'

export {
  resolveWorktreeCreateDisplayName,
  resolveWorktreeCreateDisplayNameRequest,
  resolveWorktreeCreateDisplayNameMeta,
  sanitizeWorktreeDisplayName,
  shouldSetDisplayName
} from './worktree-display-name'

/**
 * Ensure a target path is within the workspace directory (prevent path traversal).
 */
export function ensurePathWithinWorkspace(targetPath: string, workspaceDir: string): string {
  const resolvedWorkspaceDir = resolve(workspaceDir)
  const resolvedTargetPath = resolve(targetPath)
  const rel = relative(resolvedWorkspaceDir, resolvedTargetPath)

  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('Invalid worktree path')
  }

  return resolvedTargetPath
}

/**
 * Compute the filesystem path where the worktree directory will be created.
 *
 * Why WSL special case: when the repo lives on a WSL filesystem, worktrees
 * must also live on the WSL filesystem. Creating them on the Windows side
 * (/mnt/c/...) would be extremely slow due to cross-filesystem I/O and
 * the terminal would open a Windows shell instead of WSL. We mirror the
 * Windows workspace layout inside ~/orca/workspaces on the WSL filesystem
 * (e.g. \\wsl.localhost\Ubuntu\home\user\orca\workspaces\repo\feature).
 */
export function computeWorktreePath(
  sanitizedName: string,
  repoPath: string,
  settings: WorktreeLayoutSettings,
  workspaceRoot?: string
): string {
  return computeWorktreePathFromWorkspaceRoot(
    sanitizedName,
    repoPath,
    workspaceRoot ?? computeWorkspaceRoot(repoPath, settings),
    resolveWorktreeLayoutMode(settings)
  )
}

/** Layout half shared by both computeWorktreePath variants, so the sync and async paths cannot
 *  disagree on placement once the root is resolved. */
function computeWorktreePathFromWorkspaceRoot(
  sanitizedName: string,
  repoPath: string,
  workspaceRoot: string,
  layoutMode: WorktreeLayoutMode
): string {
  const pathOps = getRuntimePathOps(repoPath, workspaceRoot)
  // Why: only repo-nested adds a segment below the root. project-folder already folded its
  // per-project container into the root, so its worktrees join directly — the flat expression.
  if (layoutMode === 'repo-nested') {
    const repoName = pathOps.basename(repoPath).replace(/\.git$/, '')
    return pathOps.join(workspaceRoot, repoName, sanitizedName)
  }
  return pathOps.join(workspaceRoot, sanitizedName)
}

/** Async twin of computeWorktreePath. Same result; resolves the WSL home without blocking the main
 *  thread, so callers never freeze the app on a stopped distro. */
export async function computeWorktreePathAsync(
  sanitizedName: string,
  repoPath: string,
  settings: WorktreeLayoutSettings
): Promise<string> {
  return computeWorktreePathFromWorkspaceRoot(
    sanitizedName,
    repoPath,
    await computeWorkspaceRootAsync(repoPath, settings),
    resolveWorktreeLayoutMode(settings)
  )
}

/** Async twin of computeWorkspaceRoot. Same result; the WSL home probe spawns `wsl.exe`, so
 *  background preparation uses this variant rather than blocking the Electron main thread for up
 *  to the probe timeout. The sync twin below still serves callers that cannot await (allowed-roots
 *  resolution, CLI create, watch targets, worktree trash). */
export async function computeWorkspaceRootAsync(
  repoPath: string,
  settings: WorkspaceRootSettings
): Promise<string> {
  const distro = mirrorDistroForWorkspaceRoot(repoPath, settings)
  return projectContainerRoot(
    workspaceRootForMirrorHome(
      repoPath,
      settings.workspaceDir,
      distro ? await getWslHomeAsync(distro) : null
    ),
    repoPath,
    settings
  )
}

export function computeWorkspaceRoot(repoPath: string, settings: WorkspaceRootSettings): string {
  const distro = mirrorDistroForWorkspaceRoot(repoPath, settings)
  return projectContainerRoot(
    workspaceRootForMirrorHome(repoPath, settings.workspaceDir, distro ? getWslHome(distro) : null),
    repoPath,
    settings
  )
}

/** Distro to mirror the workspace root into, or undefined when the configured root is used as-is.
 *  Shared by both resolvers so the sync and async paths can never disagree on placement. */
function mirrorDistroForWorkspaceRoot(
  repoPath: string,
  settings: { workspaceDir: string; wslMirrorDistro?: string }
): string | undefined {
  const distro = resolveMirrorDistro(repoPath, settings)
  return distro && shouldMirrorWorkspaceDirInsideWsl(repoPath, settings.workspaceDir)
    ? distro
    : undefined
}

function workspaceRootForMirrorHome(
  repoPath: string,
  workspaceDir: string,
  wslHome: string | null
): string {
  // Why: WSL UNC paths are still Windows paths from Node's perspective.
  // Mirror absolute local desktop workspace roots inside the distro so
  // terminals stay on the WSL filesystem; repo-relative roots can resolve
  // directly against the WSL repo path.
  return wslHome
    ? win32.join(wslHome, 'orca', 'workspaces')
    : resolveWorkspaceDirForRepo(repoPath, workspaceDir)
}

export function computeRemoteWorktreePath(
  sanitizedName: string,
  repoPath: string,
  settings: WorktreeLayoutSettings,
  options: { useConfiguredAbsolutePath?: boolean } = {}
): string {
  if (
    options.useConfiguredAbsolutePath ||
    isWorkspaceDirRelativeToRepo(repoPath, settings.workspaceDir)
  ) {
    return computeWorktreePath(sanitizedName, repoPath, settings)
  }
  // Why: absolute global workspaceDir values belong to the desktop machine.
  // SSH falls back to repo-qualified sibling paths so origin/main is not shared.
  const pathOps = getRuntimePathOps(repoPath, repoPath)
  const repoName = pathOps.basename(repoPath).replace(/\.git$/, '')
  return pathOps.join(repoPath, '..', `${repoName}-${sanitizedName}`)
}

export function getWorktreePathSettings(
  repo: WorktreeBasePathRepo,
  settings: WorktreeLayoutSettings,
  wslMirrorDistro?: string
): WorktreePathSettings {
  const worktreeLayoutMode = resolveWorktreeLayoutMode(settings)
  return {
    nestWorkspaces: settings.nestWorkspaces,
    workspaceDir: getEffectiveWorktreeBasePath(repo, settings),
    worktreeLayoutMode,
    ...(isProjectFolderLayout(worktreeLayoutMode)
      ? {
          projectFolderName: resolveProjectFolderName(repo),
          projectFolderBaseIsRepoScoped: hasRepoWorktreeBasePath(repo)
        }
      : {}),
    // Why pass it through rather than resolve here: placement has to agree
    // across create, allowed-roots and watch-targets, so the distro is
    // resolved once by the caller that owns the store and threaded down.
    ...(wslMirrorDistro ? { wslMirrorDistro } : {})
  }
}

export function getWorktreeCreationLayout(
  repo: WorktreeBasePathRepo,
  settings: WorktreeLayoutSettings
): OrcaWorkspaceLayout {
  const worktreeLayoutMode = resolveWorktreeLayoutMode(settings)
  return {
    path: getEffectiveWorktreeBasePath(repo, settings),
    nestWorkspaces: layoutModeNestsWorkspaces(worktreeLayoutMode),
    worktreeLayoutMode
  }
}

export function hasRepoWorktreeBasePath(repo: Pick<Repo, 'worktreeBasePath'>): boolean {
  return getRepoWorktreeBasePath(repo) !== undefined
}

function resolveWorkspaceDirForRepo(repoPath: string, workspaceDir: string): string {
  const pathOps = getRuntimePathOps(repoPath, workspaceDir)
  return pathOps.isAbsolute(workspaceDir)
    ? pathOps.normalize(workspaceDir)
    : resolveRuntimePath(repoPath, workspaceDir)
}

function isWorkspaceDirRelativeToRepo(repoPath: string, workspaceDir: string): boolean {
  return !getRuntimePathOps(repoPath, workspaceDir).isAbsolute(workspaceDir)
}

function getEffectiveWorktreeBasePath(
  repo: WorktreeBasePathRepo,
  settings: Pick<GlobalSettings, 'workspaceDir'>
): string {
  const basePath = getRepoWorktreeBasePath(repo)
  if (basePath === undefined) {
    return settings.workspaceDir
  }
  return resolveWslRepoWorktreeBasePath(repo.path, basePath)
}

function getRepoWorktreeBasePath(repo: Pick<Repo, 'worktreeBasePath'>): string | undefined {
  const trimmed = repo.worktreeBasePath?.trim()
  return trimmed || undefined
}

/**
 * Which distro's filesystem this repo's worktrees belong on, if any.
 *
 * A repo already inside WSL names its own distro. A repo on a Windows drive
 * names none — but if this project's git runs in WSL, its worktrees still
 * belong on the Linux side: `git status` stats every working-tree file, and
 * doing that across the 9p mount is ~20x slower than the same clean tree on
 * ext4 (`git worktree add` ~26x), with only the gitdir left on the Windows drive.
 */
function resolveMirrorDistro(
  repoPath: string,
  settings: { wslMirrorDistro?: string }
): string | undefined {
  const wsl = parseWslPath(repoPath)
  if (wsl) {
    return wsl.distro
  }
  return isWindowsAbsolutePathLike(repoPath) ? settings.wslMirrorDistro : undefined
}

function shouldMirrorWorkspaceDirInsideWsl(repoPath: string, workspaceDir: string): boolean {
  if (isWorkspaceDirRelativeToRepo(repoPath, workspaceDir)) {
    return false
  }
  return !isWslUncPath(workspaceDir)
}

export { parseWorktreeId } from '../../shared/worktree/id'
export {
  formatWorktreeRemovalError,
  isOrphanCompatiblePreflightError,
  isOrphanedWorktreeError,
  isWindowsLongPathWorktreeRemovalError
} from './worktree-removal-errors'
