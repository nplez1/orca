import {
  getRuntimePathBasename,
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  resolveRuntimePath
} from '../../shared/cross-platform-path'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  isProjectFolderLayout,
  resolveWorktreeLayoutMode
} from '../../shared/orca-workspace-layout'
import {
  isRuntimePathAbsoluteForRepo,
  resolveConfiguredWorktreeBasePaths
} from '../../shared/worktree/configured-worktree-base-path'
import { buildKnownOrcaWorkspaceLayouts } from '../../shared/worktree/ownership'
import { resolveProjectFolderName } from '../ipc/worktree-logic'
import type { SessionSearchScopeCatalog } from './session-search-scope-catalog'

type ScopeRepo = SessionSearchScopeCatalog['repos'][number]

export class ScopePathSet {
  private readonly seen = new Set<string>()
  private readonly entries: string[] = []

  add(value: string | null | undefined): void {
    const trimmed = value?.trim()
    if (!trimmed || !isRuntimePathAbsolute(trimmed)) {
      return
    }
    const key = normalizeRuntimePathForComparison(trimmed)
    if (this.seen.has(key)) {
      return
    }
    this.seen.add(key)
    this.entries.push(trimmed)
  }

  // Prefix matching makes contained paths redundant SQL ranges.
  folded(): string[] {
    return this.entries.filter(
      (candidate) =>
        !this.entries.some((other) => other !== candidate && isPathInsideOrEqual(other, candidate))
    )
  }
}

/** Flat global roots belong to all projects; only repo-specific directories can narrow scope. */
export function managedWorktreeDirectories(
  repo: ScopeRepo,
  settings: SessionSearchScopeCatalog['settings']
): string[] {
  if (isFolderRepo(repo)) {
    return []
  }
  const configured = new Set(
    resolveConfiguredWorktreeBasePaths(repo).map(normalizeRuntimePathForComparison)
  )
  // Why a relative root is repo-scoped too: it resolves against this repo's own path, so it is
  // this project's folder in effect — the same rule placement applies.
  const baseIsRepoScoped = (layoutPath: string): boolean =>
    configured.has(normalizeRuntimePathForComparison(layoutPath)) ||
    !isRuntimePathAbsoluteForRepo(repo.path, settings.workspaceDir)
  const repoName = getRuntimePathBasename(repo.path).replace(/\.git$/, '')
  const directories: string[] = []
  for (const layout of buildKnownOrcaWorkspaceLayouts(settings, repo)) {
    const layoutMode = resolveWorktreeLayoutMode(layout)
    // Why: a project folder nests the project one level below every base — including an
    // explicitly configured one — so the directory this repo owns is the container, not the
    // base. Claiming the base would widen the search to every project sharing it.
    if (isProjectFolderLayout(layoutMode)) {
      const containerName = resolveProjectFolderName(repo)
      // Why the same adoption rule placement uses: a repo-scoped base named after the project IS
      // the container, so looking in a folder below it would search the wrong directory.
      const adoptsBase =
        baseIsRepoScoped(layout.path) &&
        normalizeRuntimePathForComparison(getRuntimePathBasename(layout.path)) ===
          normalizeRuntimePathForComparison(containerName)
      directories.push(adoptsBase ? layout.path : resolveRuntimePath(layout.path, containerName))
    } else if (configured.has(normalizeRuntimePathForComparison(layout.path))) {
      directories.push(layout.path)
    } else if (layout.nestWorkspaces && repoName) {
      directories.push(resolveRuntimePath(layout.path, repoName))
    }
  }
  return directories
}
