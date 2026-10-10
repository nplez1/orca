import { mkdir } from 'node:fs/promises'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  isProjectFolderLayout,
  resolveWorktreeLayoutMode
} from '../../../shared/orca-workspace-layout'
import { deriveCloneRepoNameFromUrl } from '../../git/repo-clone-path'
import { getRemoteDefaultBranchName } from '../../git/remote-default-branch'
import { sanitizeWorktreeName } from '../worktree-logic'

export type CloneTargetPlacement = {
  /** Path for the checkout, relative to the clone destination. Absent means the legacy
   *  spelling, where the checkout is the destination plus the URL-derived repo name. */
  relativeClonePath?: string
  /** Name the project should be registered under, when the layout nests a container. */
  projectName?: string
}

/**
 * Where a clone's primary checkout goes under the layout in effect.
 *
 * The project-folder layout nests it at `<destination>/<project>/<branch>`, which changes what
 * the destination field means: it is now where project folders live rather than the checkout's
 * own parent. The branch has to be known before the clone starts in order to name that folder.
 */
export async function resolveCloneTargetPlacement(args: {
  url: string
  destination: string
  settings: Pick<GlobalSettings, 'nestWorkspaces' | 'worktreeLayoutMode'>
}): Promise<CloneTargetPlacement> {
  if (!isProjectFolderLayout(resolveWorktreeLayoutMode(args.settings))) {
    return {}
  }
  const projectName = deriveCloneRepoNameFromUrl(args.url)
  const branchLeaf = await resolveCloneBranchLeaf(args.url, args.destination)
  return {
    relativeClonePath: `${sanitizeWorktreeName(projectName)}/${branchLeaf}`,
    projectName
  }
}

/**
 * Branch the clone is about to check out, as a single folder segment. The remote's own HEAD is
 * the pre-clone spelling of `origin/HEAD`; when the remote cannot be asked (offline, private
 * without credentials) this falls back to `main`, the layout's documented last resort.
 */
async function resolveCloneBranchLeaf(url: string, destination: string): Promise<string> {
  // Why: the probe runs with the destination as cwd, and a fresh install may not have it yet.
  // Creating it here is idempotent with the mkdir the clone path already performs.
  await mkdir(destination, { recursive: true }).catch(() => {})
  const branchName = await getRemoteDefaultBranchName(url, { cwd: destination })
  try {
    // Why sanitized: a branch such as `feature/x` cannot be one folder segment.
    return sanitizeWorktreeName(branchName ?? 'main')
  } catch {
    return 'main'
  }
}
