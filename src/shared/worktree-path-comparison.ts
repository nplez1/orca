/**
 * Web-safe worktree path comparison, ported from upstream's `src/main/git/worktree-path-comparison.ts`.
 *
 * That module cannot be imported from the web project — it pulls `./runner` (and through it the
 * desktop command runner) for `translateWorktreePath`. Porting only the comparison half replaces the
 * fork's old `src/main/ipc/worktree-path-comparison.ts`, which folded WSL Linux tails
 * case-insensitively and so merged distinct checkouts. The parity test beside this file fails if
 * upstream changes the rules, which is the signal to re-port.
 */
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from './cross-platform-path'
import { foldWslUncPathCaseInsensitiveParts } from './wsl-paths'

/** Path syntax determines case folding: preserve POSIX and WSL ext4 tails even on Windows to avoid merging checkouts. */
export function canonicalWorktreePath(pathValue: string, platform = process.platform): string {
  if (looksLikePosixAbsolutePath(pathValue)) {
    return canonicalPosixPath(pathValue, platform)
  }
  const wslKey = wslUncComparisonKey(pathValue)
  if (wslKey) {
    return wslKey
  }
  return platform === 'win32' || looksLikeWindowsPath(pathValue)
    ? win32.normalize(win32.resolve(pathValue)).toLowerCase()
    : canonicalPosixPath(pathValue, platform)
}

// macOS Git reports /tmp checkouts as /private/tmp.
function canonicalPosixPath(pathValue: string, platform: NodeJS.Platform): string {
  const normalized = posix.normalize(posix.resolve(pathValue))
  if (platform !== 'darwin') {
    return normalized
  }
  if (normalized === '/private/tmp') {
    return '/tmp'
  }
  return normalized.startsWith('/private/tmp/') ? normalized.slice('/private'.length) : normalized
}

/** Normalize WSL UNC paths on every host, folding only the Windows-insensitive parts. */
function wslUncComparisonKey(pathValue: string): string | null {
  const folded = foldWslUncPathCaseInsensitiveParts(pathValue)
  if (!folded) {
    return null
  }
  return (foldWslUncPathCaseInsensitiveParts(win32.normalize(pathValue)) ?? folded).replace(
    /\/+$/,
    ''
  )
}

export function areWorktreePathsEqual(
  leftPath: string,
  rightPath: string,
  platform = process.platform
): boolean {
  const leftIsPosix = looksLikePosixAbsolutePath(leftPath)
  if (leftIsPosix || looksLikePosixAbsolutePath(rightPath)) {
    // win32.resolve would attach a drive to POSIX paths and manufacture cross-filesystem equality.
    return (
      leftIsPosix &&
      looksLikePosixAbsolutePath(rightPath) &&
      canonicalWorktreePath(leftPath, platform) === canonicalWorktreePath(rightPath, platform)
    )
  }
  if (
    platform === 'win32' ||
    isWindowsAbsolutePathLike(leftPath) ||
    isWindowsAbsolutePathLike(rightPath)
  ) {
    return canonicalWorktreePath(leftPath, 'win32') === canonicalWorktreePath(rightPath, 'win32')
  }
  return canonicalWorktreePath(leftPath, platform) === canonicalWorktreePath(rightPath, platform)
}

export function dedupeWorktreesByPath<T extends { path: string }>(
  worktrees: readonly T[],
  platform = process.platform
): T[] {
  // Key absolute paths once; only host-dependent relative paths require pairwise comparison.
  const unique: T[] = []
  const posixKeys = new Set<string>()
  const windowsKeys = new Set<string>()
  const windowsPaths: string[] = []
  const relativePaths: string[] = []
  const matchesAny = (paths: string[], pathValue: string): boolean =>
    paths.some((existing) => areWorktreePathsEqual(existing, pathValue, platform))

  for (const worktree of worktrees) {
    const pathValue = worktree.path
    if (looksLikePosixAbsolutePath(pathValue)) {
      const key = canonicalWorktreePath(pathValue, platform)
      if (!posixKeys.has(key)) {
        posixKeys.add(key)
        unique.push(worktree)
      }
      continue
    }
    if (platform === 'win32' || isWindowsAbsolutePathLike(pathValue)) {
      const key = canonicalWorktreePath(pathValue, 'win32')
      if (!windowsKeys.has(key) && !matchesAny(relativePaths, pathValue)) {
        windowsKeys.add(key)
        windowsPaths.push(pathValue)
        unique.push(worktree)
      }
      continue
    }
    if (!matchesAny(relativePaths, pathValue) && !matchesAny(windowsPaths, pathValue)) {
      relativePaths.push(pathValue)
      unique.push(worktree)
    }
  }
  return unique
}

function looksLikeWindowsPath(pathValue: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\')
}

// One leading slash only: `//server/share` and WSL UNC aliases are Windows roots, not POSIX paths.
export function looksLikePosixAbsolutePath(pathValue: string): boolean {
  return pathValue.startsWith('/') && !pathValue.startsWith('//')
}
