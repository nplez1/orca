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
