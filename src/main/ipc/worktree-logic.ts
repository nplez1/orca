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
  adoptExistingDirectoryName,
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

export {
  resolveWorktreeCreateDisplayName,
  resolveWorktreeCreateDisplayNameRequest,
  resolveWorktreeCreateDisplayNameMeta,
  sanitizeWorktreeDisplayName,
  shouldSetDisplayName
} from './worktree-display-name'

export function ensurePathWithinWorkspace(targetPath: string, workspaceDir: string): string {
  const resolvedWorkspaceDir = resolve(workspaceDir)
  const resolvedTargetPath = resolve(targetPath)
  const rel = relative(resolvedWorkspaceDir, resolvedTargetPath)

  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('Invalid worktree path')
  }

  return resolvedTargetPath
}

/** Keep WSL worktrees on the distro filesystem to avoid cross-filesystem I/O and Windows-shell startup. */
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

/** Resolve WSL home asynchronously so a stopped distro cannot block main. */
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

/** Async WSL home probes avoid blocking main; synchronous callers retain the matching resolver below. */
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

/**
 * For authorization: never waits more than `deadlineMs` for a WSL home. Past it the root falls back
 * as if the home were unknown, while the probe keeps running and fills the cache for later checks.
 */
export async function computeWorkspaceRootWithin(
  repoPath: string,
  settings: WorkspaceRootSettings,
  deadlineMs: number,
  // Injected by main so this shared module stays free of main-only gate imports.
  readHome: (distro: string) => Promise<string | null> = getWslHomeAsync
): Promise<string> {
  const distro = mirrorDistroForWorkspaceRoot(repoPath, settings)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs)
  })
  try {
    const home = distro ? await Promise.race([readHome(distro), deadline]) : null
    return projectContainerRoot(
      workspaceRootForMirrorHome(repoPath, settings.workspaceDir, home),
      repoPath,
      settings
    )
  } finally {
    clearTimeout(timer)
  }
}

export function computeWorkspaceRoot(repoPath: string, settings: WorkspaceRootSettings): string {
  const distro = mirrorDistroForWorkspaceRoot(repoPath, settings)
  return projectContainerRoot(
    workspaceRootForMirrorHome(repoPath, settings.workspaceDir, distro ? getWslHome(distro) : null),
    repoPath,
    settings
  )
}

/** Whether the workspace root mirrors into a WSL home, which only a wsl.exe probe can resolve. */
export function workspaceRootMirrorsIntoWsl(
  repoPath: string,
  settings: { workspaceDir: string; wslMirrorDistro?: string }
): boolean {
  return mirrorDistroForWorkspaceRoot(repoPath, settings) !== undefined
}

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
  // Desktop absolute roots must mirror into WSL; repo-relative roots already resolve inside the distro.
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
  // Desktop absolute roots cannot apply to SSH hosts; qualify sibling paths per repo.
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
          // Why the on-disk leaf when one exists: a container spelled `Orca` over a folder spelled
          // `orca` gives git two paths for one worktree, and every worktree id is that path.
          projectFolderName: adoptExistingDirectoryName(
            getEffectiveWorktreeBasePath(repo, settings),
            resolveProjectFolderName(repo)
          ),
          // Why a relative root counts as repo-scoped: it resolves against this repo's own path,
          // so it is this project's folder in effect. Treating only `worktreeBasePath` as
          // repo-scoped made `workspaceDir: '..'` nest a folder inside the container it already
          // had — and flag the repo for a relocation that would nest it again.
          projectFolderBaseIsRepoScoped:
            hasRepoWorktreeBasePath(repo) ||
            isWorkspaceDirRelativeToRepo(repo.path, settings.workspaceDir)
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

/** Prefer WSL filesystem for WSL-owned repos or Windows-drive repos executed by WSL Git, avoiding slow 9p stats. */
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
