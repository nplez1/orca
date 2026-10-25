import { posix } from 'node:path'
import { WORKTREE_ID_SEPARATOR } from '../../shared/worktree/id'
import { computeWorktreePath, type getWorktreePathSettings } from './worktree-logic'

/** The resolved placement settings, so a caller cannot drop the container name by passing raw
 *  global settings — `ReturnType` keeps this in step with `getWorktreePathSettings`. */
type WorktreePathSettings = ReturnType<typeof getWorktreePathSettings>

export type WorktreeFolderRenamePlan = {
  oldPath: string
  newPath: string
  /** `${repoId}::${newPath}` — what a worktree refresh reports post-move. */
  newWorktreeId: string
}

/** Rename only safe same-parent local paths; skip Windows cwd locks and remote hosts, preserving the Git-reported ID. */
export function planWorktreeFolderRename(args: {
  repoId: string
  repoPath: string
  oldWorktreePath: string
  worktreeIdSuffix?: string
  newLeaf: string
  settings: WorktreePathSettings
  platform: NodeJS.Platform
  isRemote: boolean
}): WorktreeFolderRenamePlan | null {
  if (args.isRemote || args.platform === 'win32') {
    return null
  }
  const newPath = computeWorktreePath(args.newLeaf, args.repoPath, args.settings)
  if (!newPath || newPath === args.oldWorktreePath) {
    return null
  }
  // Changed path settings must not relocate the worktree; non-Windows paths use POSIX separators.
  if (posix.dirname(newPath) !== posix.dirname(args.oldWorktreePath)) {
    return null
  }
  return {
    oldPath: args.oldWorktreePath,
    newPath,
    // Folder instances can share a path; preserve their synthetic identity suffix.
    newWorktreeId: `${args.repoId}${WORKTREE_ID_SEPARATOR}${newPath}${args.worktreeIdSuffix ?? ''}`
  }
}
