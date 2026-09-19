import type { Worktree } from '../../../shared/worktree/types'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'

export type NestedWorktreeExcludeRequest = {
  paths: string[]
  key: string
}

export type RuntimeFileListTarget = {
  canList: boolean
  excludeRequest: NestedWorktreeExcludeRequest
  worktreePath: string | null
}

export function isNestedWorktreePath(parentPath: string, childPath: string): boolean {
  const windowsPath = isWindowsAbsolutePathLike(parentPath)
  const parent = parentPath.replace(/[\\/]+$/, '').replace(/\\/g, '/')
  const child = childPath.replace(/\\/g, '/')
  // Why: Windows paths are case-insensitive and can arrive with mixed slash
  // styles from git/Electron. Normalize before deciding whether to exclude a
  // nested linked worktree from file scans.
  const comparableParent = windowsPath ? parent.toLowerCase() : parent
  const comparableChild = windowsPath ? child.toLowerCase() : child
  return comparableChild.startsWith(`${comparableParent}/`)
}

export function getNestedWorktreeExcludePaths(
  worktreeId: string,
  worktreePath: string,
  repoWorktrees: readonly Worktree[]
): string[] {
  return repoWorktrees
    .filter(
      (worktree) => worktree.id !== worktreeId && isNestedWorktreePath(worktreePath, worktree.path)
    )
    .map((worktree) => worktree.path)
    .sort()
}

export function getNestedWorktreeExcludeRequest(
  worktreeId: string | null,
  worktreePath: string | null,
  repoWorktrees: readonly Worktree[]
): NestedWorktreeExcludeRequest {
  if (!worktreeId || !worktreePath || repoWorktrees.length === 0) {
    return { paths: [], key: '[]' }
  }
  const paths = getNestedWorktreeExcludePaths(worktreeId, worktreePath, repoWorktrees)
  // Why: worktree paths can contain newlines. Use JSON as a stable dependency
  // key while passing the original array to IPC so paths stay lossless.
  return { paths, key: JSON.stringify(paths) }
}

export function getRuntimeFileListTarget(
  worktreeId: string | null,
  worktreePath: string | null | undefined,
  repoWorktrees: readonly Worktree[]
): RuntimeFileListTarget {
  const resolvedWorktreePath = worktreePath ?? null
  if (!worktreeId || !resolvedWorktreePath) {
    return { canList: false, excludeRequest: { paths: [], key: '[]' }, worktreePath: null }
  }
  return {
    canList: true,
    excludeRequest: getNestedWorktreeExcludeRequest(
      worktreeId,
      resolvedWorktreePath,
      repoWorktrees
    ),
    worktreePath: resolvedWorktreePath
  }
}
