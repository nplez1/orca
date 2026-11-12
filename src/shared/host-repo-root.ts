import { isCaseInsensitiveRuntimeRoot } from './cross-platform-path'
import { joinHostPath, trimHostPathSeparators } from './host-path-join'
import { layoutNestsPrimaryCheckout, type WorktreeLayoutMode } from './orca-workspace-layout'
/** Where a host keeps checkouts when nothing is stored. Under a nested layout that is the worktree
 *  root itself, which is why the two settings coincide there and diverge under `flat`. */
export function getDefaultRepoRootConvention(
  hostHome: string,
  layoutMode: WorktreeLayoutMode = 'repo-nested'
): string {
  const home = trimHostPathSeparators(hostHome.trim())
  if (!home) {
    return ''
  }
  return joinHostPath(
    joinHostPath(home, 'orca'),
    layoutNestsPrimaryCheckout(layoutMode) ? 'workspaces' : 'projects'
  )
}

/** Under `flat` a checkout lands in the worktree root the user named — except for Orca's own
 *  `<x>/orca/workspaces` tree, whose checkouts belong in its sibling `orca/projects`. */
function flatCheckoutParent(worktreeRoot: string): string {
  // Windows roots fold case, so a hand-typed `…\Orca\Workspaces` is still Orca's own tree. A
  // backslash is the only Windows evidence a `~`-rooted value carries, since its platform is unknown.
  const foldCase = isCaseInsensitiveRuntimeRoot(worktreeRoot) || worktreeRoot.includes('\\')
  const isSegment = (segment: string, expected: string): boolean =>
    foldCase ? segment.toLowerCase() === expected : segment === expected
  const trimmed = trimHostPathSeparators(worktreeRoot)
  const separatorIndex = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (separatorIndex <= 0 || !isSegment(trimmed.slice(separatorIndex + 1), 'workspaces')) {
    return worktreeRoot
  }
  const parent = trimmed.slice(0, separatorIndex)
  const parentSeparatorIndex = Math.max(parent.lastIndexOf('/'), parent.lastIndexOf('\\'))
  if (!isSegment(parent.slice(parentSeparatorIndex + 1), 'orca')) {
    return worktreeRoot
  }
  return joinHostPath(parent, 'projects')
}

/** The one rule for where a host keeps checkouts: its stored repo root, else its stored worktree
 *  root placed by the layout, else the convention for that host's home. */
export function resolveCheckoutParent({
  storedRepoRoot,
  storedWorktreeRoot,
  layoutMode = 'repo-nested',
  hostHome
}: {
  storedRepoRoot?: string | null
  storedWorktreeRoot?: string | null
  layoutMode?: WorktreeLayoutMode
  hostHome?: string | null
}): string {
  const repoRoot = storedRepoRoot?.trim()
  if (repoRoot) {
    return repoRoot
  }
  const worktreeRoot = storedWorktreeRoot?.trim()
  if (worktreeRoot) {
    return layoutNestsPrimaryCheckout(layoutMode) ? worktreeRoot : flatCheckoutParent(worktreeRoot)
  }
  return getDefaultRepoRootConvention(hostHome ?? '', layoutMode)
}
