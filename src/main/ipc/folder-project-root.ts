// A folder workspace is a root Orca owns, but not a checkout that owns ignore rules of its own.

import { resolve } from 'node:path'
import { getRepoKind } from '../../shared/repo-kind'
import type { RepoKind } from '../../shared/repo-types'

/**
 * Only the fields this decision reads, so a caller — and a test — need not own a whole store. Every
 * member is optional so a narrow double answers "not a folder project" instead of throwing.
 */
export type FolderProjectStore = {
  getRepos?: () => readonly { path: string; kind?: RepoKind }[]
  getFolderWorkspaces?: () => readonly { folderPath: string }[]
  getProjectGroups?: () => readonly { parentPath: string | null }[]
}

function comparablePath(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function comparableSet(worktreePath: string, resolvedWorktreePath: string): Set<string> {
  return new Set([worktreePath, resolvedWorktreePath].map(comparablePath))
}

/**
 * Whether this root is one of the app's non-git workspaces — a folder workspace, a project group's
 * folder, or a repo row of kind `folder` — rather than a checkout with ignore rules of its own.
 *
 * Why callers ask: a folder project placed inside a git checkout (`<repo>/notes`) has no repository,
 * so the enclosing checkout's `.gitignore` is applied to it by accident and hides its files. Both
 * spellings are checked because the root a request names and the one that was authorized can differ
 * on a symlinked root.
 */
export function isFolderProjectRoot(
  store: FolderProjectStore,
  worktreePath: string,
  resolvedWorktreePath: string = worktreePath
): boolean {
  const candidates = comparableSet(worktreePath, resolvedWorktreePath)
  const repo = store.getRepos?.().find((row) => candidates.has(comparablePath(row.path)))
  if (repo) {
    return getRepoKind(repo) === 'folder'
  }
  if (
    (store.getFolderWorkspaces?.() ?? []).some((workspace) =>
      candidates.has(comparablePath(workspace.folderPath))
    )
  ) {
    return true
  }
  return (store.getProjectGroups?.() ?? []).some(
    (group) =>
      typeof group.parentPath === 'string' && candidates.has(comparablePath(group.parentPath))
  )
}
