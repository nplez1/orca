/**
 * The pieces that decide where a project folder is and what it is called: safe name leaves, the
 * path flavour the surrounding repo runs on, and the container root itself.
 *
 * Split out of worktree-logic so placement can grow without that module's other half — public
 * API, ids, removal diagnostics — competing for the same size budget.
 */
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import {
  replaceKnownEmojiWithShortcodes,
  setEmojiShortcodeDatasetLoader
} from '../../shared/emoji-shortcode-catalog'
import {
  isProjectFolderLayout,
  resolveWorktreeLayoutMode,
  type WorktreeLayoutMode
} from '../../shared/orca-workspace-layout'
import type { Repo } from '../../shared/repo-types'
import { requireEmojiShortcodeDataset } from './deferred-emoji-shortcode-dataset'
import { areWorktreePathsEqual } from './worktree-path-comparison'

setEmojiShortcodeDatasetLoader(requireEmojiShortcodeDataset)

export type RuntimePathOps = Pick<
  typeof posix,
  'basename' | 'dirname' | 'isAbsolute' | 'join' | 'normalize'
>

export function getRuntimePathOps(repoPath: string, workspaceDir: string): RuntimePathOps {
  return isWindowsAbsolutePathLike(repoPath) || isWindowsAbsolutePathLike(workspaceDir)
    ? win32
    : posix
}

/**
 * Sanitize a worktree name for use in branch names and directory paths.
 * Strips unsafe characters and collapses runs of special chars to a single hyphen.
 */
export function sanitizeWorktreeName(input: string): string {
  // Why: keep Unicode letters/numbers (CJK, accented Latin, etc.) so users can
  // name workspaces in their own language. Git ref-format permits non-ASCII
  // bytes, and modern filesystems handle UTF-8 paths. Only strip characters
  // git or the filesystem actually rejects.
  const sanitized = replaceKnownEmojiWithShortcodes(input)
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    // Why: git check-ref-format rejects any ref containing `..`, so a prompt
    // like "../../foo" that survives slugification as `..-..-foo` would
    // produce a branch name git refuses to create. Collapse runs of dots
    // to a single dot before the leading/trailing trim so internal `..`
    // sequences can't reach git.
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')

  if (!sanitized && containsEmoji(input)) {
    return 'workspace'
  }

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('Invalid worktree name')
  }

  return sanitized
}

function containsEmoji(input: string): boolean {
  return /[\p{Emoji_Presentation}\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(
    input
  )
}

/**
 * The root everything downstream works from — placement, the watcher target, allowed roots,
 * root preparation, trash. In project-folder mode that is the per-project container rather
 * than the configured root, which is what makes the primary checkout and every worktree
 * siblings inside one folder.
 */
export function projectContainerRoot(
  baseRoot: string,
  repoPath: string,
  settings: {
    worktreeLayoutMode?: WorktreeLayoutMode
    projectFolderName?: string
    /** True when `baseRoot` came from this repo's own `worktreeBasePath`. */
    projectFolderBaseIsRepoScoped?: boolean
  }
): string {
  if (!isProjectFolderLayout(resolveWorktreeLayoutMode(settings))) {
    return baseRoot
  }
  const pathOps = getRuntimePathOps(repoPath, baseRoot)
  const containerName =
    settings.projectFolderName ?? pathOps.basename(repoPath).replace(/\.git$/, '')
  const container = pathOps.join(baseRoot, containerName)
  // Why a base named after the project is that project's folder — but only a repo-scoped one: the
  // global root can legitimately carry a project's name (a `~/orca` workspace root with a project
  // named `orca`), and adopting it would hand that project the shared root, putting its worktrees
  // beside every other project's folders.
  // Name comparison reuses the path comparator so it folds case where the filesystem does.
  if (
    settings.projectFolderBaseIsRepoScoped &&
    areWorktreePathsEqual(containerName, pathOps.basename(baseRoot))
  ) {
    return baseRoot
  }
  // Why the container can be the checkout itself, or the base be the checkout: that is no container
  // at all, and worktrees would land inside the working tree, which git allows without complaint.
  if (areWorktreePathsEqual(container, repoPath) || areWorktreePathsEqual(baseRoot, repoPath)) {
    return baseRoot
  }
  return container
}

/**
 * Container leaf for a project folder: the repo's display name, sanitized, falling back to the
 * checkout's own folder name when the display name has nothing filesystem-safe left.
 *
 * Why the display name and not `basename(repoPath)`: once the primary checkout lives at
 * `<root>/<project>/<defaultBranch>`, the leaf is the branch, so deriving the container from
 * the path would collapse every project into one folder named `main`.
 */
export function resolveProjectFolderName(
  repo: Pick<Repo, 'path'> & { displayName?: string | null }
): string {
  const fromDisplayName = sanitizeProjectFolderName(repo.displayName)
  if (fromDisplayName) {
    return fromDisplayName
  }
  const pathOps = getRuntimePathOps(repo.path, repo.path)
  const checkoutName = pathOps.basename(repo.path).replace(/\.git$/, '')
  return sanitizeProjectFolderName(checkoutName) ?? 'project'
}

function sanitizeProjectFolderName(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) {
    return null
  }
  try {
    return sanitizeWorktreeName(trimmed)
  } catch {
    // Why: an unusable display name must not fail placement — the caller falls back.
    return null
  }
}
